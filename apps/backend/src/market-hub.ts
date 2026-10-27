import WebSocket from 'ws';
import { z } from 'zod';
import {
  contiguousCandleTail,
  type Candle,
  type CandleInterval,
  type OrderBookSnapshot,
  type PublicTrade,
} from '@gate-crossex/shared-types';

const MARKET_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'SUI', 'PEPE', 'AAVE', 'LINK', 'ARB'] as const;
const MARKET_VENUES = ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT', 'LIGHTER'] as const;
const CANDLE_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
const MAX_CANDLES = 500;
const MAX_TRADES = 80;
const MAX_BOOK_LEVELS = 50;
const BOOK_EMIT_INTERVAL_MS = 200;
const MAX_SYMBOLS_PER_SUBSCRIPTION = 100;
const DYNAMIC_MARKET_IDLE_MS = 30 * 60_000;
const DYNAMIC_MARKET_SWEEP_MS = 5 * 60_000;

/**
 * Backoff applied to a symbol the upstream declared invalid. The verdict is deliberately **not**
 * permanent any more: a running strategy calls `market()` on every tick, so its market never goes
 * idle, is never retired, and a single transient rejection used to blackhole the symbol for the
 * rest of the process lifetime (production: KRAKEN/LIGHTER NATGAS and HYPE never recovered).
 *
 * The first window is short (30s) so a hiccup heals inside a minute, and every repeat doubles it
 * up to 30 minutes, so a genuinely unsupported symbol costs at most one subscribe frame per half
 * hour instead of a retry storm against an upstream that is already struggling.
 */
const INVALID_SYMBOL_BACKOFF_BASE_MS = 30_000;
const INVALID_SYMBOL_BACKOFF_FACTOR = 2;
const INVALID_SYMBOL_BACKOFF_MAX_MS = 30 * 60_000;
/** Exponent guard: a long-lived hub must never grow the window past a finite number. */
const INVALID_SYMBOL_BACKOFF_MAX_STEPS = 20;

type MarketVenue = typeof MARKET_VENUES[number];

export interface LiveMarket {
  symbol: string;
  venue: MarketVenue;
  asset: string;
  lastPrice: string;
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volume24h: string;
  quoteVolume24h: string;
  fundingRate: string;
  nextFundingAt: string;
  openInterest: string;
  openInterestValue: string;
  receivedAt: string;
  updatedAt: string;
  /**
   * Exchange source timestamp of the frame (or order-book update) that last supplied this
   * record's bid/ask. `updatedAt` tracks the latest frame of any kind — a sparse ticker
   * carrying only `lp` refreshes it — so the freshness of the executable quote must be judged
   * from this field, never from `updatedAt`. Absent means the record never carried a quote
   * (a zero-priced placeholder), which no consumer may treat as tradable.
   */
  quoteUpdatedAt?: string;
  /**
   * Local (this backend's) wall-clock time, in epoch ms, at which the frame that last supplied
   * this record's bid/ask arrived. Advances under exactly the same condition as `quoteUpdatedAt`,
   * so the two always describe the same quote: one by the venue's clock, one by ours.
   *
   * Display-side freshness (age, and the leg-to-leg skew of a spread) must be computed from this
   * field, not from `quoteUpdatedAt`: venue clocks differ by seconds, which made a perfectly
   * executable pair look "not time-aligned" and hid the spread for every combination involving
   * the drifting venue. `quoteUpdatedAt` keeps its job of measuring *network* lag against
   * `quoteReceivedAt` (received − source), which is a different question and must stay on the
   * venue's clock. Absent on records that never carried a quote, and on payloads persisted before
   * this field existed — consumers then fall back to `quoteUpdatedAt`.
   */
  quoteReceivedAt?: number;
  /** rest_book_ticker marks rows synthesized from a venue's bulk REST sweep (spread board view). */
  source: 'gate_crossex_websocket' | 'demo_seed' | 'rest_book_ticker';
}

export interface MarketSnapshot {
  connectionState: 'connecting' | 'healthy' | 'reconnecting' | 'stale' | 'disconnected';
  updatedAt: string;
  markets: LiveMarket[];
}

export type MarketHubMessage =
  | { type: 'market.snapshot'; payload: MarketSnapshot }
  | { type: 'market.update'; payload: LiveMarket }
  | { type: 'orderbook.update'; payload: OrderBookSnapshot }
  | { type: 'trade.update'; payload: { symbol: string; trade: PublicTrade } }
  | { type: 'kline.snapshot'; payload: { symbol: string; interval: CandleInterval; candles: Candle[] } }
  | { type: 'kline.update'; payload: { symbol: string; interval: CandleInterval; candle: Candle } };

export interface MarketDefinition {
  symbol: string;
  venue: MarketVenue;
  asset: string;
}

/**
 * Budget for streamed symbols beyond the seed set. Every registration past it is served by
 * evicting the coldest unwatched dynamic market (see `evictColdest`), so the budget bounds the
 * upstream subscription bill rather than capping how many different markets a session may visit.
 */
const MAX_DYNAMIC_SYMBOLS = 1_000;

/**
 * The upstream CrossEx socket rejects any subscription frame beyond 100 symbols per channel per
 * connection ("Each channel is limited to 100 symbols per connection") — and it rejects the WHOLE
 * frame, so a single oversized request silently starves every symbol in it. Symbols are therefore
 * spread across a pool of connections, each carrying at most 100 symbols on every channel.
 */
const SYMBOLS_PER_SHARD = 100;
const SEED_SYMBOL_COUNT = MARKET_ASSETS.length * MARKET_VENUES.length;

interface ShardConnection {
  index: number;
  socket: WebSocket | null;
  /** Symbols routed to this shard; every channel subscription for them lives on this one connection. */
  readonly symbols: Set<string>;
  /** Per-channel subscription requests sent (or queued) to the upstream socket. */
  readonly subscriptions: Map<string, Set<string>>;
  state: MarketSnapshot['connectionState'];
  reconnectAttempt: number;
  heartbeat: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  awaitingPong: boolean;
}

type MarketListener = (message: MarketHubMessage) => void;

/**
 * One upstream "invalid symbol" verdict. `at` anchors the backoff window and `attempts` counts
 * consecutive verdicts so repeats back off exponentially instead of retrying at a fixed rate.
 */
interface InvalidSymbolRecord {
  /** Epoch ms (hub clock) of the most recent verdict. */
  at: number;
  /** Consecutive verdicts for this channel+symbol; 1 for the first one. */
  attempts: number;
}

/** Optional sink for degradation the operator can act on (capacity pressure, dropped symbols). */
export type MarketHubWarn = (reason: string, detail?: Record<string, unknown>) => void;

/**
 * Book-seeding report sink. Called once per seed attempt (success or failure), never per frame, so
 * the backend can log "did the baseline land, how long did it take" without flooding the log.
 */
export type MarketHubReport = (event: {
  symbol: string;
  /** `seeded` = baseline installed, `failed` = attempt failed, `abandoned` = retry budget spent. */
  outcome: 'seeded' | 'failed' | 'abandoned' | 'reset';
  durationMs: number;
  levels: number;
  attempts: number;
  reason?: string;
}) => void;

// Low-liquidity instruments omit or null out optional quote fields. bid/ask must stay optional
// so one sparse frame cannot invalidate the whole ticker push (Bug: best-bid stuck at '0').
const TickerPushSchema = z.object({
  channel: z.literal('ticker'), event: z.literal('update'), result: z.object({
    s: z.string(), lp: z.string(),
    bp: z.string().nullable().optional(), bs: z.string().nullable().optional(),
    ap: z.string().nullable().optional(), as: z.string().nullable().optional(),
    o: z.string().nullable(), h: z.string().nullable(), l: z.string().nullable(), v: z.string().nullable(),
    q: z.string().nullable().optional(), ts: z.number(),
  }),
});
const FundingPushSchema = z.object({
  channel: z.literal('funding_rate'), event: z.literal('update'), result: z.object({ s: z.string(), r: z.string(), T: z.number() }),
});
const OpenInterestPushSchema = z.object({
  channel: z.literal('open_interest'), event: z.literal('update'), result: z.object({ s: z.string(), oi: z.string(), oiV: z.string().optional() }),
});
const BookLevelSchema = z.tuple([z.string(), z.string()]);
const OrderBookUpdatePushSchema = z.object({
  channel: z.literal('order_book_update'), event: z.literal('update'), result: z.object({
    snapshot: z.boolean().optional(), ts: z.number(), s: z.string(),
    U: z.union([z.string(), z.number()]).optional(), u: z.union([z.string(), z.number()]).optional(),
    a: z.array(BookLevelSchema), b: z.array(BookLevelSchema),
  }),
});
const TradePushSchema = z.object({
  channel: z.literal('trade'), event: z.literal('update'), result: z.object({
    s: z.string(), i: z.string(), p: z.string(), q: z.string(), S: z.enum(['BUY', 'SELL']), ts: z.number(),
  }).passthrough(),
});
const KlinePushSchema = z.object({
  channel: z.string().regex(/^kline_(1m|5m|15m|30m|1h|4h|1d)$/), event: z.literal('update'), result: z.object({
    s: z.string(), o: z.string(), h: z.string(), l: z.string(), c: z.string(), v: z.string(),
    t: z.number(), T: z.number(), x: z.boolean(),
  }),
});
const SubscriptionFailureSchema = z.object({
  channel: z.string(),
  event: z.literal('subscribe'),
  result: z.object({ status: z.literal('failed') }),
  error: z.object({ message: z.string() }),
});

function invalidSymbolsFromMessage(message: string): string[] {
  const body = message.match(/invalidSymbols:\[([^\]]*)\]/)?.[1];
  return body ? body.split(',').map((symbol) => symbol.trim()).filter(Boolean) : [];
}

const seedPrices: Record<string, number> = {
  BTC: 118420.8, ETH: 3862.14, SOL: 189.42, XRP: 3.0831, DOGE: 0.2394,
  SUI: 3.74, PEPE: 0.0000124, AAVE: 318.2, LINK: 24.16, ARB: 0.824,
};

function symbolOf(venue: MarketVenue, asset: string): string {
  const quote = (venue === 'KRAKEN' ? 'USD' : venue === 'HYPERLIQUID' || venue === 'DERIBIT' || venue === 'LIGHTER' ? 'USDC' : 'USDT');
  return `${venue}_FUTURE_${asset}_${quote}`;
}

/** Placeholder for a dynamically registered market; every field is overwritten by the first ticker push. */
function pendingMarket(definition: MarketDefinition): LiveMarket {
  const now = new Date().toISOString();
  return {
    symbol: definition.symbol, venue: definition.venue, asset: definition.asset,
    lastPrice: '0', bidPrice: '0', bidSize: '0', askPrice: '0', askSize: '0',
    open24h: '0', high24h: '0', low24h: '0', volume24h: '0', quoteVolume24h: '0',
    fundingRate: '0', nextFundingAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
    openInterest: '0', openInterestValue: '0', receivedAt: now, updatedAt: now, source: 'demo_seed',
    // No quote was ever observed: the placeholder's own birth stamp, which ages out immediately.
    quoteUpdatedAt: now,
  };
}

function seedMarket(venue: MarketVenue, asset: string, venueIndex: number, assetIndex: number): LiveMarket {
  const mid = seedPrices[asset] ?? 1;
  const venueOffset = (venueIndex - 3) * mid * 0.000018;
  const last = mid + venueOffset;
  const spread = Math.max(last * 0.000002, 0.0000001);
  const funding = ((assetIndex % 4) - 1.2 + venueIndex * 0.17) * 0.000012;
  const oiValue = Math.max(1_000_000, 4_820_000_000 / (assetIndex + 1) / (venueIndex + 1));
  const now = new Date().toISOString();
  return {
    symbol: symbolOf(venue, asset), venue, asset, lastPrice: String(last), bidPrice: String(last - spread),
    bidSize: '0', askPrice: String(last + spread), askSize: '0', open24h: String(last * 0.98),
    high24h: String(last * 1.02), low24h: String(last * 0.96), volume24h: '0', quoteVolume24h: String(oiValue * 0.72),
    fundingRate: String(funding), nextFundingAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
    openInterest: '0', openInterestValue: String(oiValue), receivedAt: now, updatedAt: now, source: 'demo_seed',
    quoteUpdatedAt: now,
  };
}

interface BookState {
  bids: Map<string, string>;
  asks: Map<string, string>;
  updatedAt: string;
  /**
   * Local wall-clock arrival time (epoch ms) of the last book frame. A ticker frame whose bid/ask
   * is resolved from this book inherits it as its own `quoteReceivedAt`, so a quote assembled from
   * two different transports still reports the older of the two local arrival times.
   */
  receivedAt: number;
  dirty: boolean;
  emitTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Whether this book has an authoritative baseline — either an upstream `snapshot` frame or a
   * venue REST snapshot fetched by {@link seedOrderBook}.
   *
   * Until it does, diffs cannot be applied: each `order_book_update` carries only the levels that
   * moved, so accumulating them on top of an empty book invents a book made of "levels that
   * happened to change since we subscribed". Those frames are buffered instead and replayed once
   * the baseline arrives.
   */
  seeded: boolean;
  /** Local time the in-flight seed request started; only buffered frames newer than this replay. */
  seedCutoffMs: number;
  /** Bounded window of frames received while the baseline was in flight (see `BOOK_DIFF_WINDOW`). */
  pendingDiffs: BufferedBookFrame[];
  /** Consecutive seed failures; the budget is `BOOK_SEED_MAX_ATTEMPTS`. */
  seedFailures: number;
  /** Local time of the last seed attempt, for per-symbol spacing and failure backoff. */
  lastSeedAttemptAt: number;
  /** Local time the current baseline landed, for the hourly refresh. */
  seededAt: number;
  seedInFlight: boolean;
  /**
   * Set once the retry budget is spent. From then on diffs accumulate the old way, because an
   * unreachable venue must never leave the book permanently blank — a partial book beats no book.
   */
  seedAbandoned: boolean;
  /** Last `U`/`u` seen, for the per-venue sequence rules. Never bridged with the seed's own seq. */
  lastSeq: number | null;
  /**
   * Frames applied since the last full price-band sweep. This is the amortization counter: the
   * per-frame path only inspects the levels its own frame wrote, and the whole-map sweep that
   * removes legacy ghosts waits for {@link BOOK_PRICE_BAND_SWEEP_FRAMES} frames.
   */
  framesSinceBandSweep: number;
  /** Local time of the last full price-band sweep, the wall-clock backstop for the same sweep. */
  lastBandSweepAt: number;
}

/**
 * One buffered `order_book_update` frame, kept only while a seed request is in flight.
 *
 * `receivedAt` is this backend's own wall-clock arrival time and is the *only* field the replay
 * decision reads. The frame's own `ts` belongs to the venue's clock, so comparing it against a
 * local cut-off mixes two timelines: a venue whose clock runs fast would get pre-snapshot frames
 * replayed on top of a newer snapshot (silent corruption), and one whose clock runs slow would have
 * genuinely new frames dropped instead.
 */
interface BufferedBookFrame {
  /** Local arrival time, from the same clock as `BookState.seedCutoffMs`. */
  receivedAt: number;
  /** Venue event time; used only to stamp `updatedAt` when replaying. */
  ts: number;
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
}

/**
 * How many frames to keep while waiting for a baseline. Upstream pushes at tens of frames per
 * second, so this is roughly one second of rebuild work: enough to close the gap, cheap to replay.
 */
const BOOK_DIFF_WINDOW = 64;
/** Attempts before a symbol's book falls back to plain diff accumulation. */
const BOOK_SEED_MAX_ATTEMPTS = 3;
/** Minimum spacing between two seed requests for the same symbol (also the failure backoff). */
const BOOK_SEED_MIN_INTERVAL_MS = 1_000;
const BOOK_SEED_RETRY_MS = 5_000;
/** A seeded book is re-seeded from REST on this cadence, which also sweeps any ghost levels. */
const BOOK_RESET_INTERVAL_MS = 3_600_000;
/** Sweeper cadence: cheap scan over watched books, no I/O until something is due. */
const BOOK_SEED_SWEEP_MS = 5_000;
/** Levels requested from the venue when seeding. */
const BOOK_SEED_LIMIT = 50;
/**
 * Margin added to the seed cut-off.
 *
 * Both sides of the comparison are now on our own clock (the cut-off is the local arrival instant
 * of the response, the buffered frames carry their local arrival instants), so the large margin
 * that a mixed-clock design needed is no longer required; 200ms only tightens the tiny window where
 * a frame and the resolution interleave, and it keeps the conservative `+` direction — a frame we
 * cannot prove arrived after the snapshot is dropped rather than replayed, because a replay can
 * silently regress a level while a drop is repaired by the next diff that touches it.
 */
const BOOK_SEED_CUTOFF_MARGIN_MS = 200;
/**
 * Hard cap on retained price levels per side. `bookSnapshot` only truncates its *output*, so
 * without this the maps keep every level ever seen — a slow, unbounded leak on a long-running
 * process. Trimming is amortized: it only runs when a side doubles the cap.
 */
const BOOK_LEVEL_HARD_LIMIT = 100;

/**
 * Half-width of the price band a retained level must sit inside, measured against the book's own
 * touch. Anything further away is a ghost and gets deleted.
 *
 * Why this exists: a level that emptied *before* we subscribed never receives a `quantity=0` delete
 * frame — the venue has no such price in its book any more, so it never mentions it again. Such a
 * row then sits in our map forever. Live capture of the Binance feed showed `price=1000.00 size=117.9`
 * and `price=29344.00`/`price=71769.60` living in a BTC book trading near 79,700 — prices absent
 * from the venue's first 500 levels — and the reported depth grew five-fold in 40 seconds purely
 * from rows like those. The hourly REST re-seed was the only thing that ever removed them, so for
 * up to an hour the depth figure was meaningless.
 *
 * 20% is deliberately generous: the observed junk is off by tens of times the touch (1000 vs
 * 79,700), while a genuine book never publishes a level 20% away from its own mid — not even in a
 * flash move, because the band is recomputed from the *current* touch on every frame. Levels inside
 * the band are never touched, so ordinary volatility cannot trip this.
 */
const BOOK_PRICE_BAND_RATIO = 0.2;
/**
 * Full band sweep cadence, in frames. Only the sweep walks the retained maps; the per-frame path
 * looks at nothing but the levels that frame wrote, so the common case stays O(frame).
 */
const BOOK_PRICE_BAND_SWEEP_FRAMES = 20;
/** Wall-clock backstop for the same sweep, so a quiet book (few frames) is still cleaned. */
const BOOK_PRICE_BAND_SWEEP_MS = 5_000;

/** Structural type of a venue REST depth snapshot; keeps this module free of a package import. */
export interface VenueBookSnapshot {
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
  ts: number | null;
  seq: string | null;
}

/** Alternate identifiers some venues use in `trade` pushes (e.g. raw "BTCUSDT") mapped back to CrossEx symbols. */
function tradeSymbolKeys(symbol: string): string[] {
  const parts = symbol.split('_');
  const base = parts[2] ?? '';
  const quote = parts[3] ?? '';
  const compact = `${base}${quote}`;
  return [symbol.replaceAll('_', ''), compact, `${compact}SWAP`, `${compact}PERP`, `${base}${quote === 'USD' ? 'PFUSD' : ''}`].filter(Boolean);
}

function normalizeTradeSymbol(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A push text field carries data when present and non-empty; quotes additionally need a positive value. */
function usableText(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim() !== '';
}

function usableQuote(value: string | null | undefined): value is string {
  if (!usableText(value)) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

interface BookTopOfBook {
  bidPrice?: string;
  bidSize?: string;
  askPrice?: string;
  askSize?: string;
}

/** Best bid/ask of a maintained book; sides without a usable price are absent, not empty strings. */
function bookTopOf(book: BookState | undefined): BookTopOfBook | null {
  if (!book) return null;
  let topBid: [string, string] | null = null;
  for (const level of book.bids) {
    if (topBid === null || Number(level[0]) > Number(topBid[0])) topBid = level;
  }
  let topAsk: [string, string] | null = null;
  for (const level of book.asks) {
    if (topAsk === null || Number(level[0]) < Number(topAsk[0])) topAsk = level;
  }
  const top: BookTopOfBook = {};
  if (topBid && usableQuote(topBid[0])) {
    top.bidPrice = topBid[0];
    top.bidSize = topBid[1];
  }
  if (topAsk && usableQuote(topAsk[0])) {
    top.askPrice = topAsk[0];
    top.askSize = topAsk[1];
  }
  return Object.keys(top).length > 0 ? top : null;
}

export class CrossExMarketHub {
  private readonly shards = new Map<number, ShardConnection>();
  private readonly symbolShards = new Map<string, number>();
  private nextShardIndex = 0;
  /** Registered symbols that could not get a shard slot yet; retried on the eviction sweep. */
  private readonly pendingAssignments = new Set<string>();
  private stopped = true;
  private lastNotifiedState: MarketSnapshot['connectionState'] = 'disconnected';
  /**
   * Symbols the upstream rejected, per channel. Entries expire: they only suppress a re-subscribe
   * inside their backoff window, and are dropped as soon as the channel delivers data again.
   */
  private readonly invalidSymbols = new Map<string, Map<string, InvalidSymbolRecord>>();
  private readonly markets = new Map<string, LiveMarket>();
  private readonly listeners = new Set<MarketListener>();
  private readonly quoteWatchers = new Map<string, number>();
  private readonly bookWatchers = new Map<string, number>();
  private readonly tradeWatchers = new Map<string, number>();
  private readonly klineWatchers = new Map<string, number>();
  private readonly books = new Map<string, BookState>();
  private readonly trades = new Map<string, PublicTrade[]>();
  private readonly candleSeries = new Map<string, Candle[]>();
  private readonly tradeSymbolAliases = new Map<string, string>();
  private readonly dynamicMarkets = new Map<string, number>();
  private dynamicSymbolCount = 0;
  private dynamicMarketSweep: ReturnType<typeof setInterval> | null = null;

  private readonly heartbeatIntervalMs: number;
  private readonly marketIdlePingAfterMs: number;
  private readonly staleAfterMs: number;
  private readonly maxDynamicSymbols: number;
  /** Connection-pool ceiling derived from the budget so the two always agree. */
  private readonly maxShards: number;
  private readonly warn: MarketHubWarn | undefined;
  /** Injected clock; defaults to `Date.now` and exists so tests can advance the invalid backoff. */
  private readonly clock: () => number;
  /** Venue REST depth source for seeding books that upstream never baselines. */
  private readonly depthSource: ((symbol: string, limit: number) => Promise<VenueBookSnapshot | null>) | undefined;
  private readonly report: MarketHubReport | undefined;
  /** Sweeper that keeps watched books seeded; started with the first book watcher, unref'd. */
  private bookSeedSweep: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    options: {
      heartbeatIntervalMs?: number;
      marketIdlePingAfterMs?: number;
      staleAfterMs?: number;
      maxDynamicSymbols?: number;
      /** Degradation sink; the backend wires this to its logger so starvation is never silent. */
      warn?: MarketHubWarn;
      /** Clock returning epoch ms. Optional: production keeps `Date.now`. */
      now?: () => number;
      /**
       * Venue REST depth fetcher used to seed a book that upstream never baselines. Optional: when
       * absent (tests, injected hubs) books simply keep today's diff-only behaviour.
       */
      depth?: (symbol: string, limit: number) => Promise<VenueBookSnapshot | null>;
      /** Book-seeding report sink; one line per attempt, never per frame. */
      report?: MarketHubReport;
    } = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.marketIdlePingAfterMs = options.marketIdlePingAfterMs ?? 2_000;
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
    this.maxDynamicSymbols = options.maxDynamicSymbols ?? MAX_DYNAMIC_SYMBOLS;
    this.maxShards = Math.ceil((this.maxDynamicSymbols + SEED_SYMBOL_COUNT) / SYMBOLS_PER_SHARD);
    this.warn = options.warn;
    this.clock = options.now ?? (() => Date.now());
    this.depthSource = options.depth;
    this.report = options.report;
    MARKET_ASSETS.forEach((asset, assetIndex) => MARKET_VENUES.forEach((venue, venueIndex) => {
      const market = seedMarket(venue, asset, venueIndex, assetIndex);
      this.markets.set(market.symbol, market);
    }));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.dynamicMarketSweep = setInterval(() => this.evictIdleDynamicMarkets(), DYNAMIC_MARKET_SWEEP_MS);
    this.dynamicMarketSweep.unref?.();
    // Seed markets stream from the first connection; dynamic markets join via ensureMarkets.
    const seeds = [...this.markets.keys()];
    for (const channel of ['ticker', 'funding_rate', 'open_interest']) this.subscribeSymbols(channel, seeds);
    this.connectShards();
  }

  stop(): void {
    this.stopped = true;
    for (const shard of this.shards.values()) {
      if (shard.reconnectTimer) clearTimeout(shard.reconnectTimer);
      if (shard.heartbeat) clearInterval(shard.heartbeat);
      shard.reconnectTimer = null;
      shard.heartbeat = null;
      shard.socket?.close();
      shard.socket = null;
      shard.state = 'disconnected';
    }
    if (this.dynamicMarketSweep) clearInterval(this.dynamicMarketSweep);
    this.dynamicMarketSweep = null;
    for (const book of this.books.values()) {
      if (book.emitTimer) clearTimeout(book.emitTimer);
      book.emitTimer = null;
    }
    this.refreshConnectionState();
  }

  snapshot(): MarketSnapshot {
    const markets = [...this.markets.values()].sort((a, b) => a.asset.localeCompare(b.asset) || a.venue.localeCompare(b.venue));
    const newest = markets.reduce((latest, market) => market.updatedAt > latest ? market.updatedAt : latest, new Date(0).toISOString());
    return { connectionState: this.aggregatedState(), updatedAt: newest, markets };
  }

  connectionState(): MarketSnapshot['connectionState'] {
    return this.aggregatedState();
  }

  /** Aggregate the shard states: data is flowing as long as any shard is healthy. */
  private aggregatedState(): MarketSnapshot['connectionState'] {
    if (this.stopped || this.shards.size === 0) return this.stopped ? 'disconnected' : 'connecting';
    const states = new Set([...this.shards.values()].map((shard) => shard.state));
    if (states.has('healthy')) return 'healthy';
    if (states.has('stale')) return 'stale';
    if (states.has('reconnecting')) return 'reconnecting';
    return 'connecting';
  }

  /** Publish a snapshot when the aggregated connection state changes. */
  private refreshConnectionState(): void {
    const next = this.aggregatedState();
    if (next === this.lastNotifiedState) return;
    this.lastNotifiedState = next;
    this.notify({ type: 'market.snapshot', payload: this.snapshot() });
  }

  /** Registered market count without building the sorted snapshot. */
  marketCount(): number {
    return this.markets.size;
  }

  market(symbol: string): LiveMarket | null {
    if (this.dynamicMarkets.has(symbol)) this.dynamicMarkets.set(symbol, Date.now());
    return this.markets.get(symbol) ?? null;
  }

  /** Assets present at construction; these stream from the moment the socket connects. */
  isSeedAsset(asset: string): boolean {
    return (MARKET_ASSETS as readonly string[]).includes(asset);
  }

  /** Registered dynamic symbols against their budget; lets callers report pressure to operators. */
  registrationStats(): { used: number; capacity: number; pending: number; shards: number; maxShards: number } {
    return {
      used: this.dynamicSymbolCount,
      capacity: this.maxDynamicSymbols,
      pending: this.pendingAssignments.size,
      shards: this.shards.size,
      maxShards: this.maxShards,
    };
  }

  hasAsset(asset: string): boolean {
    for (const market of this.markets.values()) {
      if (market.asset === asset) return true;
    }
    return false;
  }

  /**
   * Register markets discovered from the instrument catalog and subscribe their public channels.
   * Safe to call repeatedly: known symbols are skipped. Returns true when every requested symbol
   * is registered afterwards.
   *
   * Registration is **never** an all-or-nothing coin flip on the dynamic-symbol budget. How it
   * behaves matters: a single-service call asking for one symbol must succeed when the budget is
   * merely full of colder markets, otherwise every freshly opened market silently shows zeros
   * forever — which is how per-venue data "disappears" mid-session. Free slots are used first,
   * then the coldest *unwatched* dynamic markets are recycled until the request fits. Only when
   * the remaining candidates are all pinned by an active watcher does something get refused, and
   * that is reported through `warn` instead of failing silently.
   */
  ensureMarkets(definitions: MarketDefinition[]): boolean {
    const missing = definitions.filter((definition) => !this.markets.has(definition.symbol));
    if (missing.length === 0) {
      for (const definition of definitions) {
        if (this.dynamicMarkets.has(definition.symbol)) this.dynamicMarkets.set(definition.symbol, Date.now());
      }
      return true;
    }
    const overflow = this.dynamicSymbolCount + missing.length - this.maxDynamicSymbols;
    // Symbols the caller asked for are not eviction candidates even when already registered:
    // churning them would cancel and re-request three upstream channels for nothing.
    const keep = new Set(definitions.map((definition) => definition.symbol));
    if (overflow > 0) this.evictColdest(overflow, keep);
    // Admit whatever still fits; a large batch degrades to a partial registration rather than
    // dropping everything on the floor.
    const capacity = Math.max(0, this.maxDynamicSymbols - this.dynamicSymbolCount);
    const admitted = missing.slice(0, capacity);
    const refused = missing.slice(admitted.length);
    if (refused.length > 0) {
      this.warn?.('market_hub_dynamic_budget_exhausted', {
        requested: missing.length, admitted: admitted.length, refused: refused.length,
        budget: this.maxDynamicSymbols, used: this.dynamicSymbolCount,
        symbols: refused.slice(0, 10).map((definition) => definition.symbol),
      });
    }
    if (admitted.length === 0) return false;
    this.dynamicSymbolCount += admitted.length;
    for (const definition of admitted) {
      this.markets.set(definition.symbol, pendingMarket(definition));
      this.dynamicMarkets.set(definition.symbol, Date.now());
    }
    for (const definition of definitions) {
      if (this.dynamicMarkets.has(definition.symbol)) this.dynamicMarkets.set(definition.symbol, Date.now());
    }
    const symbols = admitted.map((definition) => definition.symbol);
    for (const channel of ['ticker', 'funding_rate', 'open_interest']) {
      this.subscribeSymbols(channel, symbols);
    }
    return refused.length === 0;
  }

  /**
   * Evict up to `count` registered dynamic markets, coldest first. Actively watched markets and
   * any symbol in `keep` are skipped — dropping a market somebody is streaming would blank a live
   * view to make room for one nobody asked about yet.
   */
  private evictColdest(count: number, keep: ReadonlySet<string> = new Set()): number {
    let evicted = 0;
    // Never scan for more slots than exist — a caller asking for a huge batch must not turn into
    // quadratic work when every registered market is pinned by a watcher anyway.
    const rounds = Math.min(count, this.dynamicMarkets.size);
    // `Map.set` on an existing key keeps its original position, so the least-recently-used order
    // lives in the timestamps themselves: pick the coldest eligible market on every round.
    for (let round = 0; round < rounds; round += 1) {
      let coldestSymbol: string | null = null;
      let coldestAt = Number.POSITIVE_INFINITY;
      for (const [symbol, lastUsedAt] of this.dynamicMarkets) {
        if (keep.has(symbol) || this.isActivelyWatched(symbol)) continue;
        if (lastUsedAt < coldestAt) {
          coldestAt = lastUsedAt;
          coldestSymbol = symbol;
        }
      }
      if (coldestSymbol === null) break;
      this.retireDynamicMarket(coldestSymbol);
      evicted += 1;
    }
    return evicted;
  }

  /** Drop one dynamic market: unsubscribe its channels, free its shard slot, forget the symbol. */
  private retireDynamicMarket(symbol: string): void {
    for (const channel of ['ticker', 'funding_rate', 'open_interest']) {
      this.unsubscribeSymbols(channel, [symbol]);
    }
    // Drop verdicts on every channel, not just the three public ones: a stale record would mute
    // this symbol again the moment it is re-registered.
    this.clearInvalidSymbol(symbol);
    this.releaseSymbolShard(symbol);
    this.markets.delete(symbol);
    this.dynamicMarkets.delete(symbol);
    this.dynamicSymbolCount = Math.max(0, this.dynamicSymbolCount - 1);
  }

  orderBook(symbol: string): OrderBookSnapshot | null {
    const book = this.books.get(symbol);
    if (!book) return null;
    return this.bookSnapshot(symbol, book);
  }

  recentTrades(symbol: string): PublicTrade[] {
    return [...(this.trades.get(symbol) ?? [])];
  }

  candles(symbol: string, interval: CandleInterval): Candle[] {
    return [...(this.candleSeries.get(`${symbol}:${interval}`) ?? [])];
  }

  /** Merge REST backfill behind live websocket candles; live data wins on collision. */
  seedCandles(symbol: string, interval: CandleInterval, candles: Candle[]): void {
    const key = `${symbol}:${interval}`;
    const merged = new Map<number, Candle>();
    for (const candle of candles) merged.set(candle.startTime, candle);
    for (const candle of this.candleSeries.get(key) ?? []) merged.set(candle.startTime, candle);
    this.replaceCandles(symbol, interval, [...merged.values()]);
  }

  /** Replace a series with an authoritative, gap-free snapshot and repaint stream watchers. */
  replaceCandles(symbol: string, interval: CandleInterval, candles: Candle[]): void {
    const ordered = contiguousCandleTail(candles, interval, MAX_CANDLES);
    this.candleSeries.set(`${symbol}:${interval}`, ordered);
    // An empty snapshot is meaningful too: it clears a stale client series.
    this.notify({ type: 'kline.snapshot', payload: { symbol, interval, candles: ordered } });
  }

  subscribe(listener: MarketListener): () => void {
    this.listeners.add(listener);
    try {
      listener({ type: 'market.snapshot', payload: this.snapshot() });
    } catch { /* a broken listener must not take down the hub */ }
    return () => this.listeners.delete(listener);
  }

  /** Deliver to every listener; one throwing listener must not break the stream or its peers. */
  private notify(message: MarketHubMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch { /* isolated above */ }
    }
  }

  watchOrderBook(symbol: string): () => void {
    const release = this.watch(this.bookWatchers, 'order_book_update', symbol, () => {
      const book = this.books.get(symbol);
      if (book?.emitTimer) clearTimeout(book.emitTimer);
      this.books.delete(symbol);
      // The sweeper exists only to keep watched books seeded, so it dies with the last watcher.
      this.stopBookSweeperIfIdle();
    });
    // Reserve the book now so the seeding request can start before the first frame arrives: the
    // baseline is then usually in place by the time diffs begin, instead of after a window of them.
    this.reserveBook(symbol);
    this.ensureBookSeed(symbol);
    this.startBookSweeper();
    return release;
  }

  /** Create an empty, unseeded book so a seed request has somewhere to land. */
  private reserveBook(symbol: string): void {
    if (this.books.has(symbol)) return;
    const now = this.now();
    this.books.set(symbol, this.createBookState(now, now, false));
  }

  /** Keep dynamically discovered ticker markets registered while a client displays them. */
  watchQuotes(symbols: string[]): () => void {
    const watched = [...new Set(symbols)].filter((symbol) => this.markets.has(symbol));
    for (const symbol of watched) {
      this.quoteWatchers.set(symbol, (this.quoteWatchers.get(symbol) ?? 0) + 1);
      if (this.dynamicMarkets.has(symbol)) this.dynamicMarkets.set(symbol, Date.now());
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const symbol of watched) {
        const count = (this.quoteWatchers.get(symbol) ?? 1) - 1;
        if (count > 0) this.quoteWatchers.set(symbol, count);
        else this.quoteWatchers.delete(symbol);
      }
    };
  }

  watchTrades(symbol: string): () => void {
    for (const key of tradeSymbolKeys(symbol)) this.tradeSymbolAliases.set(key, symbol);
    return this.watch(this.tradeWatchers, 'trade', symbol, () => {
      this.trades.delete(symbol);
      for (const key of tradeSymbolKeys(symbol)) this.tradeSymbolAliases.delete(key);
    });
  }

  watchKlines(symbol: string, interval: CandleInterval): () => void {
    return this.watch(this.klineWatchers, `kline_${interval}`, symbol, () => undefined);
  }

  private watch(watchers: Map<string, number>, channel: string, symbol: string, onRelease: () => void): () => void {
    const key = `${channel}:${symbol}`;
    const current = watchers.get(key) ?? 0;
    watchers.set(key, current + 1);
    if (current === 0) this.subscribeSymbols(channel, [symbol]);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (watchers.get(key) ?? 1) - 1;
      if (count > 0) {
        watchers.set(key, count);
        return;
      }
      watchers.delete(key);
      this.unsubscribeSymbols(channel, [symbol]);
      onRelease();
    };
  }

  /** Hub clock. Every invalid-symbol timing decision goes through it so tests can advance time. */
  private now(): number {
    return this.clock();
  }

  /** Backoff window (ms) that `attempts` consecutive invalid verdicts must keep a symbol muted. */
  private invalidSymbolBackoffMs(attempts: number): number {
    const steps = Math.min(Math.max(attempts - 1, 0), INVALID_SYMBOL_BACKOFF_MAX_STEPS);
    const window = INVALID_SYMBOL_BACKOFF_BASE_MS * INVALID_SYMBOL_BACKOFF_FACTOR ** steps;
    return Math.min(window, INVALID_SYMBOL_BACKOFF_MAX_MS);
  }

  /** True while a recent verdict must still suppress a re-subscribe for this channel+symbol. */
  private isInvalidNow(channel: string, symbol: string, now: number = this.now()): boolean {
    const record = this.invalidSymbols.get(channel)?.get(symbol);
    if (!record) return false;
    return now - record.at < this.invalidSymbolBackoffMs(record.attempts);
  }

  /**
   * Record an upstream verdict. Repeats widen the window; what the upstream calls invalid is never
   * second-guessed here — only how long the verdict is honoured.
   */
  private markInvalid(channel: string, symbols: string[], now: number = this.now()): void {
    if (symbols.length === 0) return;
    let records = this.invalidSymbols.get(channel);
    if (!records) {
      records = new Map<string, InvalidSymbolRecord>();
      this.invalidSymbols.set(channel, records);
    }
    for (const symbol of symbols) {
      const attempts = (records.get(symbol)?.attempts ?? 0) + 1;
      records.set(symbol, { at: now, attempts });
    }
  }

  /** Forget a verdict once the channel delivers data again, so a healthy symbol is never skipped. */
  private clearInvalid(channel: string, symbol: string): void {
    const records = this.invalidSymbols.get(channel);
    if (!records) return;
    if (!records.delete(symbol)) return;
    if (records.size === 0) this.invalidSymbols.delete(channel);
  }

  /** Forget every verdict held for a symbol; used when its registration is torn down. */
  private clearInvalidSymbol(symbol: string): void {
    for (const [channel, records] of [...this.invalidSymbols]) {
      if (!records.delete(symbol)) continue;
      if (records.size === 0) this.invalidSymbols.delete(channel);
    }
  }

  /**
   * Give symbols whose backoff elapsed another upstream attempt. This is the only automatic way
   * back for a market a live strategy keeps warm: `retireDynamicMarket` — the old sole clearing
   * path — never fires for it, because the strategy's per-tick `market()` call keeps `lastUsedAt`
   * fresh and a quote watch pins it against eviction.
   */
  private retryExpiredInvalidSymbols(now: number = this.now()): void {
    if (this.stopped) return;
    for (const [channel, records] of [...this.invalidSymbols]) {
      const due: string[] = [];
      for (const symbol of [...records.keys()]) {
        if (this.isInvalidNow(channel, symbol, now)) continue;
        // Only symbols still carried by the hub are worth a frame; anything already retired is
        // re-subscribed through `ensureMarkets` if it is ever asked for again.
        if (!this.markets.has(symbol) && !this.symbolShards.has(symbol)) continue;
        due.push(symbol);
      }
      if (due.length > 0) this.subscribeSymbols(channel, due);
    }
  }

  /** Route each symbol to its shard, subscribe the channel there, and dial new shards on demand. */
  private subscribeSymbols(channel: string, symbols: string[]): void {
    const now = this.now();
    const byShard = new Map<ShardConnection, string[]>();
    for (const symbol of symbols) {
      // A verdict mutes the symbol only for its backoff window — never permanently.
      if (this.isInvalidNow(channel, symbol, now)) continue;
      const shard = this.shardFor(symbol);
      if (!shard) {
        // Every symbol that cannot get a connection slot is queued, not dropped: the periodic
        // eviction sweep retries the queue. In practice the pool ceiling is derived from the symbol
        // budget (`maxShards` below), so a slot should always be free and this branch stays a
        // defensive guard — it must NOT be documented anywhere as a known, verified live alarm.
        if (!this.pendingAssignments.has(symbol)) {
          this.pendingAssignments.add(symbol);
          this.warn?.('market_hub_shard_pool_exhausted', {
            symbol, shards: this.shards.size, maxShards: this.maxShards, queued: this.pendingAssignments.size,
          });
        }
        continue;
      }
      this.pendingAssignments.delete(symbol);
      const list = byShard.get(shard);
      if (list) list.push(symbol);
      else byShard.set(shard, [symbol]);
    }
    for (const [shard, list] of byShard) {
      const subscribed = shard.subscriptions.get(channel) ?? new Set<string>();
      const added = list.filter((symbol) => !subscribed.has(symbol));
      for (const symbol of added) subscribed.add(symbol);
      shard.subscriptions.set(channel, subscribed);
      const socket = shard.socket;
      if (added.length > 0 && socket?.readyState === WebSocket.OPEN) {
        this.sendSubscribe(socket, channel, added);
      }
    }
  }

  private unsubscribeSymbols(channel: string, symbols: string[]): void {
    const byShard = new Map<ShardConnection, string[]>();
    for (const symbol of symbols) {
      const shard = this.shardOf(symbol);
      if (!shard) continue;
      const list = byShard.get(shard);
      if (list) list.push(symbol);
      else byShard.set(shard, [symbol]);
    }
    for (const [shard, list] of byShard) {
      const subscribed = shard.subscriptions.get(channel);
      if (!subscribed) continue;
      const removed = list.filter((symbol) => subscribed.delete(symbol));
      const socket = shard.socket;
      if (removed.length > 0 && socket?.readyState === WebSocket.OPEN) {
        this.sendUnsubscribe(socket, channel, removed);
      }
    }
  }

  private shardOf(symbol: string): ShardConnection | null {
    const index = this.symbolShards.get(symbol);
    return index === undefined ? null : this.shards.get(index) ?? null;
  }

  /**
   * Assign a symbol to a connection shard. Existing assignments are stable so every channel of a
   * symbol shares one socket; a new symbol lands on the first shard with room, spawning (and
   * dialing) a fresh connection when all shards are full. Returns null when the pool is exhausted.
   */
  private shardFor(symbol: string): ShardConnection | null {
    const existing = this.shardOf(symbol);
    if (existing) return existing;
    for (const shard of [...this.shards.values()].sort((a, b) => a.index - b.index)) {
      if (shard.symbols.size < SYMBOLS_PER_SHARD) {
        shard.symbols.add(symbol);
        this.symbolShards.set(symbol, shard.index);
        return shard;
      }
    }
    if (this.shards.size >= this.maxShards) return null;
    const shard: ShardConnection = {
      index: this.nextShardIndex++,
      socket: null,
      symbols: new Set([symbol]),
      subscriptions: new Map(),
      state: 'connecting',
      reconnectAttempt: 0,
      heartbeat: null,
      reconnectTimer: null,
      awaitingPong: false,
    };
    this.shards.set(shard.index, shard);
    this.symbolShards.set(symbol, shard.index);
    this.connectShard(shard);
    return shard;
  }

  /** Drop a symbol's shard slot; idle shards (no symbols left) are closed and retired. */
  private releaseSymbolShard(symbol: string): void {
    const shard = this.shardOf(symbol);
    if (!shard) return;
    this.symbolShards.delete(symbol);
    shard.symbols.delete(symbol);
    for (const subscribed of shard.subscriptions.values()) subscribed.delete(symbol);
    if (shard.symbols.size > 0) return;
    if (shard.reconnectTimer) clearTimeout(shard.reconnectTimer);
    if (shard.heartbeat) clearInterval(shard.heartbeat);
    shard.reconnectTimer = null;
    shard.heartbeat = null;
    this.shards.delete(shard.index);
    const socket = shard.socket;
    shard.socket = null;
    socket?.close();
    this.refreshConnectionState();
  }

  private connectShards(): void {
    for (const shard of [...this.shards.values()]) {
      if (!shard.socket) this.connectShard(shard);
    }
  }

  private connectShard(shard: ShardConnection): void {
    if (this.stopped) return;
    shard.state = shard.reconnectAttempt === 0 ? 'connecting' : 'reconnecting';
    this.refreshConnectionState();
    const socket = new WebSocket(this.url);
    shard.socket = socket;
    let awaitingPong = false;
    let lastMessageAt = Date.now();
    let lastMarketMessageAt = Date.now();
    socket.on('pong', () => { awaitingPong = false; });
    socket.on('open', () => {
      shard.state = 'healthy';
      shard.reconnectAttempt = 0;
      awaitingPong = false;
      lastMessageAt = Date.now();
      lastMarketMessageAt = Date.now();
      // The per-shard subscription sets persist across reconnects, so resending them here
      // restores every channel this shard is responsible for.
      for (const [channel, subscribed] of shard.subscriptions) {
        if (subscribed.size > 0) this.sendSubscribe(socket, channel, [...subscribed]);
      }
      if (shard.heartbeat) clearInterval(shard.heartbeat);
      shard.heartbeat = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        // Market pushes can naturally be bursty. Once all market channels have been quiet for two
        // seconds, actively probe the socket; a second check without a pong or any incoming frame
        // terminates the half-dead connection so the close handler reconnects it.
        if (now - lastMarketMessageAt > this.marketIdlePingAfterMs) {
          if (awaitingPong) {
            socket.terminate();
            return;
          }
          awaitingPong = true;
          socket.ping();
        }
        const nextState = now - lastMessageAt > this.staleAfterMs ? 'stale' : 'healthy';
        if (nextState !== shard.state) {
          shard.state = nextState;
          this.refreshConnectionState();
        }
      }, Math.min(this.heartbeatIntervalMs, this.marketIdlePingAfterMs));
      shard.heartbeat.unref?.();
      this.refreshConnectionState();
    });
    socket.on('message', (data) => {
      const receivedAt = Date.now();
      awaitingPong = false;
      lastMessageAt = receivedAt;
      if (shard.state === 'stale') {
        shard.state = 'healthy';
        this.refreshConnectionState();
      }
      if (this.handleMessage(data.toString(), receivedAt, shard)) lastMarketMessageAt = receivedAt;
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (shard.heartbeat) clearInterval(shard.heartbeat);
      shard.heartbeat = null;
      for (const [symbol, book] of this.books) {
        if (book.emitTimer) clearTimeout(book.emitTimer);
        this.books.delete(symbol);
      }
      if (shard.socket === socket) shard.socket = null;
      if (this.stopped) return;
      // A shard whose symbols all drifted away is retired instead of reconnected.
      if (shard.symbols.size === 0 || !this.shards.has(shard.index)) {
        this.shards.delete(shard.index);
        this.refreshConnectionState();
        return;
      }
      shard.state = 'reconnecting';
      const exponential = Math.min(30_000, 1_000 * 2 ** Math.min(5, shard.reconnectAttempt++));
      const wait = Math.round(exponential * (0.85 + Math.random() * 0.3));
      shard.reconnectTimer = setTimeout(() => this.connectShard(shard), wait);
      shard.reconnectTimer.unref?.();
      this.refreshConnectionState();
      // Every book was just dropped above, so every watched symbol needs a fresh baseline: without
      // one, the reconnected feed's diffs would rebuild a book out of "levels that happened to
      // change after the reconnect", i.e. ghost levels by construction. Re-reserving the book and
      // asking now (rather than waiting for the first frame) means the baseline is usually there
      // before the diffs resume.
      for (const key of this.bookWatchers.keys()) {
        const watchedSymbol = key.slice('order_book_update:'.length);
        this.reserveBook(watchedSymbol);
        this.ensureBookSeed(watchedSymbol);
      }
    });
  }

  private sendSubscribe(socket: WebSocket, channel: string, payload: string[]): void {
    for (let index = 0; index < payload.length; index += MAX_SYMBOLS_PER_SUBSCRIPTION) {
      socket.send(JSON.stringify({
        time: Math.floor(Date.now() / 1_000),
        event: 'subscribe',
        channel,
        payload: payload.slice(index, index + MAX_SYMBOLS_PER_SUBSCRIPTION),
      }));
    }
  }

  private sendUnsubscribe(socket: WebSocket, channel: string, payload: string[]): void {
    for (let index = 0; index < payload.length; index += MAX_SYMBOLS_PER_SUBSCRIPTION) {
      socket.send(JSON.stringify({
        time: Math.floor(Date.now() / 1_000),
        event: 'unsubscribe',
        channel,
        payload: payload.slice(index, index + MAX_SYMBOLS_PER_SUBSCRIPTION),
      }));
    }
  }

  private evictIdleDynamicMarkets(): void {
    const cutoff = Date.now() - DYNAMIC_MARKET_IDLE_MS;
    for (const [symbol, lastUsedAt] of [...this.dynamicMarkets]) {
      if (lastUsedAt > cutoff || this.isActivelyWatched(symbol)) continue;
      this.retireDynamicMarket(symbol);
    }
    // Symbols that waited for a shard slot get another chance once space may have freed up.
    if (this.pendingAssignments.size > 0 && !this.stopped) {
      const pending = [...this.pendingAssignments].filter((symbol) => this.markets.has(symbol));
      this.pendingAssignments.clear();
      for (const channel of ['ticker', 'funding_rate', 'open_interest']) this.subscribeSymbols(channel, pending);
    }
    // And symbols muted by an upstream verdict get another attempt once their backoff elapsed.
    this.retryExpiredInvalidSymbols();
  }

  private isActivelyWatched(symbol: string): boolean {
    if ((this.quoteWatchers.get(symbol) ?? 0) > 0) return true;
    return [...this.bookWatchers.keys(), ...this.tradeWatchers.keys(), ...this.klineWatchers.keys()]
      .some((key) => key.endsWith(`:${symbol}`));
  }

  /**
   * Handle one upstream frame and report whether it was a recognized market-data update.
   * Frames arrive continuously for every subscribed symbol, so the channel/event fields are
   * inspected first and exactly one schema runs per frame instead of trying each in sequence.
   */
  private handleMessage(raw: string, receivedAt: number, shard: ShardConnection): boolean {
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { return false; }
    if (typeof payload !== 'object' || payload === null) return false;
    const frame = payload as { channel?: unknown; event?: unknown };
    if (frame.event === 'subscribe') {
      const subscriptionFailure = SubscriptionFailureSchema.safeParse(payload);
      if (!subscriptionFailure.success) return false;
      const channel = subscriptionFailure.data.channel;
      const subscribed = shard.subscriptions.get(channel);
      const invalidFound = invalidSymbolsFromMessage(subscriptionFailure.data.error.message);
      // A failure without an invalidSymbols list is a wholesale frame rejection (e.g. the
      // per-connection symbol cap). Shards never exceed the cap, so re-request the set once
      // after a short pause; the next reconnect would do the same if it persisted.
      if (invalidFound.length === 0) {
        if (subscribed && subscribed.size > 0 && !shard.reconnectTimer) {
          const socket = shard.socket;
          const retry = setTimeout(() => {
            if (socket?.readyState === WebSocket.OPEN && shard.socket === socket) {
              this.sendSubscribe(socket, channel, [...subscribed]);
            }
          }, 2_000);
          retry.unref?.();
        }
        return false;
      }
      if (!subscribed) return false;
      const now = this.now();
      for (const symbol of invalidFound) subscribed.delete(symbol);
      this.markInvalid(channel, invalidFound, now);
      const socket = shard.socket;
      // Resubscribe without the rejected symbols on every data channel, not just the three that
      // happened to be listed here. A subscribe is all-or-nothing upstream: one unsupported symbol
      // makes the whole batch fail, so the *valid* symbols in that batch receive nothing at all.
      // Dropping them silently used to strand `order_book_update`, `trade` and `kline_*` until the
      // last watcher released — which also broke the candle backfill (`keepWarm` only renews a
      // watch, it never re-subscribes), so the history chart stayed empty with no error anywhere.
      // No loop risk: each rejected symbol was just removed from `subscribed` and moved into the
      // invalid backoff, so it can trigger at most one extra subscribe.
      const resubscribable = channel === 'order_book_update' || channel === 'trade'
        || channel === 'ticker' || channel === 'funding_rate' || channel === 'open_interest'
        || channel.startsWith('kline_');
      if (socket?.readyState === WebSocket.OPEN && subscribed.size > 0 && resubscribable) {
        this.sendSubscribe(socket, channel, [...subscribed]);
      }
      return false;
    }
    if (frame.event !== 'update' || typeof frame.channel !== 'string') return false;
    if (frame.channel === 'ticker') {
      const ticker = TickerPushSchema.safeParse(payload);
      if (!ticker.success) return false;
      const symbol = this.resolveStreamSymbol(ticker.data.result.s);
      // Data arrived: whatever verdict muted this symbol is over.
      this.clearInvalid('ticker', symbol);
      const current = this.markets.get(symbol);
      if (!current) return true;
      const value = ticker.data.result;
      const currentTimestamp = current.source === 'gate_crossex_websocket'
        ? Date.parse(current.updatedAt)
        : Number.NEGATIVE_INFINITY;
      // A reconnect can flush delayed frames after a newer ticker has already arrived. Never
      // roll a symbol's executable bid/ask backward to an older source timestamp.
      if (Number.isFinite(currentTimestamp) && value.ts < currentTimestamp) return true;
      // Sparse pushes (low-liquidity instruments) resolve field by field: the push wins, then
      // the maintained order book's top level, then the previously published value — a partial
      // frame must never overwrite live data with zeros.
      const book = this.books.get(symbol);
      const bookTop = bookTopOf(book);
      const frameBid = usableQuote(value.bp) ? value.bp : bookTop?.bidPrice;
      const frameAsk = usableQuote(value.ap) ? value.ap : bookTop?.askPrice;
      // When the frame carries no quote and the book offers none either, keep the stored record
      // untouched instead of publishing an all-empty update.
      if (!usableQuote(value.lp) && frameBid === undefined && frameAsk === undefined) return true;
      // Provenance of the executable quote. `updatedAt`/`receivedAt` above describe whichever
      // frame just arrived, and a sparse ticker carrying only `lp` refreshes them while leaving
      // bid/ask at whatever the last quote-carrying frame produced — which is how a stale quote
      // used to be dressed up as fresh market data. `quoteUpdatedAt` therefore moves only when
      // this record's bid/ask actually did, and only once BOTH sides are resolved: a record whose
      // bid came from one frame and ask from an older one describes a pair that never coexisted
      // on any venue, so it must not claim contemporaneity. When the two sides come from
      // different sources the older stamp wins, which keeps that guarantee conservative.
      let quoteUpdatedAt = current.quoteUpdatedAt;
      if (frameBid !== undefined && frameAsk !== undefined) {
        const stamps: number[] = [];
        if (usableQuote(value.bp) || usableQuote(value.ap)) stamps.push(value.ts);
        if (bookTop && book) stamps.push(Date.parse(book.updatedAt));
        if (stamps.length > 0) quoteUpdatedAt = new Date(Math.min(...stamps)).toISOString();
      }
      // Local counterpart of the same decision, on this backend's clock. Everything a browser
      // shows about quote age or leg-to-leg skew reads this one; venue clocks disagree by seconds
      // and using them for alignment hid whole venue combinations from the spread panel.
      let quoteReceivedAt = current.quoteReceivedAt;
      if (frameBid !== undefined && frameAsk !== undefined) {
        const localStamps: number[] = [];
        if (usableQuote(value.bp) || usableQuote(value.ap)) localStamps.push(receivedAt);
        if (bookTop && book) localStamps.push(book.receivedAt);
        if (localStamps.length > 0) quoteReceivedAt = Math.min(...localStamps);
      }
      this.publish({
        ...current,
        lastPrice: usableQuote(value.lp) ? value.lp : current.lastPrice,
        bidPrice: frameBid ?? current.bidPrice,
        bidSize: usableText(value.bs) ? value.bs : bookTop?.bidSize ?? current.bidSize,
        askPrice: frameAsk ?? current.askPrice,
        askSize: usableText(value.as) ? value.as : bookTop?.askSize ?? current.askSize,
        open24h: usableText(value.o) ? value.o : current.open24h,
        high24h: usableText(value.h) ? value.h : current.high24h,
        low24h: usableText(value.l) ? value.l : current.low24h,
        volume24h: usableText(value.v) ? value.v : current.volume24h,
        quoteVolume24h: usableText(value.q) ? value.q : current.quoteVolume24h,
        receivedAt: new Date(receivedAt).toISOString(),
        updatedAt: new Date(value.ts).toISOString(), source: 'gate_crossex_websocket',
        quoteUpdatedAt,
        quoteReceivedAt,
      });
      return true;
    }
    // The ticker's `updatedAt`, `receivedAt`, `quoteUpdatedAt`, and `source` are the strategy
    // engine's evidence that bid/ask came from the exchange recently and arrived promptly.
    // Funding and open-interest pushes must never refresh them, or seed, stale, or delayed
    // prices could pass that gate.
    if (frame.channel === 'funding_rate') {
      const funding = FundingPushSchema.safeParse(payload);
      if (!funding.success) return false;
      this.clearInvalid('funding_rate', funding.data.result.s);
      const current = this.markets.get(funding.data.result.s);
      if (current) this.publish({ ...current, fundingRate: funding.data.result.r, nextFundingAt: new Date(funding.data.result.T).toISOString() });
      return true;
    }
    if (frame.channel === 'open_interest') {
      const interest = OpenInterestPushSchema.safeParse(payload);
      if (!interest.success) return false;
      this.clearInvalid('open_interest', interest.data.result.s);
      const current = this.markets.get(interest.data.result.s);
      if (current) this.publish({ ...current, openInterest: interest.data.result.oi, openInterestValue: interest.data.result.oiV ?? current.openInterestValue });
      return true;
    }
    if (frame.channel === 'order_book_update') {
      const bookUpdate = OrderBookUpdatePushSchema.safeParse(payload);
      if (!bookUpdate.success) return false;
      this.applyBookUpdate(bookUpdate.data.result, receivedAt);
      return true;
    }
    if (frame.channel === 'trade') {
      const trade = TradePushSchema.safeParse(payload);
      if (!trade.success) return false;
      this.applyTrade(trade.data.result);
      return true;
    }
    if (frame.channel.startsWith('kline_')) {
      const kline = KlinePushSchema.safeParse(payload);
      if (!kline.success) return false;
      const interval = kline.data.channel.slice('kline_'.length) as CandleInterval;
      this.applyKline(interval, kline.data.result);
      return true;
    }
    return false;
  }

  private applyBookUpdate(result: z.infer<typeof OrderBookUpdatePushSchema>['result'], receivedAt: number): void {
    const symbol = this.resolveStreamSymbol(result.s);
    // Clear before the watcher check: a delivered frame proves the channel is live whether or not
    // a client is still listening, and the verdict is this channel's alone.
    this.clearInvalid('order_book_update', symbol);
    if (!this.bookWatchers.has(`order_book_update:${symbol}`)) return;
    let book = this.books.get(symbol);
    if (!book) {
      book = this.createBookState(result.ts, receivedAt, result.snapshot === true);
      this.books.set(symbol, book);
      // No baseline yet and none requested: ask the venue right away instead of waiting for the
      // sweeper, so the very first frame a client sees is already a seeded book.
      if (!book.seeded) this.ensureBookSeed(symbol);
    } else if (result.snapshot) {
      if (book.emitTimer) clearTimeout(book.emitTimer);
      book.bids = new Map();
      book.asks = new Map();
      // An upstream snapshot is itself an authoritative baseline: buffered frames are replayed
      // below, and no venue REST seed is needed for this book any more.
      book.seeded = true;
      book.seedInFlight = false;
      book.seedFailures = 0;
      book.seedAbandoned = false;
      book.seededAt = receivedAt;
      book.lastSeq = null;
    }

    if (!book.seeded && !book.seedAbandoned && this.depthSource !== undefined) {
      // A diff without a baseline describes only the levels that moved. Buffer it for replay and
      // leave the book untouched: half a book is worse than none, because its depth and its top
      // level would both be wrong while looking perfectly plausible.
      // Without a depth source there is no way to obtain a baseline, so the pre-seeding behaviour
      // (accumulate) is the only option — never leave such a book blank.
      if (book.pendingDiffs.length >= BOOK_DIFF_WINDOW) book.pendingDiffs.shift();
      book.pendingDiffs.push({ receivedAt, ts: result.ts, bids: result.b, asks: result.a });
      if (!book.seedInFlight) this.ensureBookSeed(symbol);
      return;
    }

    if (this.dropIfStaleSequentialDiff(book, symbol, result)) return;
    this.applyBookFrame(book, result, receivedAt);
    this.scheduleBookEmit(symbol, book);
  }

  /** Fresh book state. `seeded` is only true when the frame that created it was a snapshot. */
  private createBookState(ts: number, receivedAt: number, seeded: boolean): BookState {
    return {
      bids: new Map(),
      asks: new Map(),
      updatedAt: new Date(ts).toISOString(),
      receivedAt,
      dirty: false,
      emitTimer: null,
      seeded,
      seedCutoffMs: 0,
      pendingDiffs: [],
      seedFailures: 0,
      lastSeedAttemptAt: Number.NEGATIVE_INFINITY,
      seededAt: seeded ? receivedAt : 0,
      seedInFlight: false,
      seedAbandoned: false,
      lastSeq: null,
      framesSinceBandSweep: 0,
      // Anchored at the book's birth: the 5s backstop then measures "since this book existed"
      // rather than "since the epoch", so a fresh book does not sweep on its very first frame.
      lastBandSweepAt: receivedAt,
    };
  }

  /**
   * Drop the levels furthest from the touch so each side stays bounded.
   *
   * Amortized on purpose: sorting on every frame would cost more than the leak it prevents, so this
   * only runs once a side has doubled the cap. A level that is dropped here can still be restored
   * by the next diff or by the hourly re-seed.
   */
  private trimBookLevels(book: BookState): void {
    const trim = (levels: Map<string, string>, side: 'bid' | 'ask') => {
      if (levels.size <= BOOK_LEVEL_HARD_LIMIT * 2) return;
      const ordered = [...levels.entries()]
        .sort((a, b) => side === 'bid' ? Number(b[0]) - Number(a[0]) : Number(a[0]) - Number(b[0]))
        .slice(0, BOOK_LEVEL_HARD_LIMIT);
      levels.clear();
      for (const [price, size] of ordered) levels.set(price, size);
    };
    trim(book.bids, 'bid');
    trim(book.asks, 'ask');
  }

  /**
   * Delete retained levels that sit outside the ±{@link BOOK_PRICE_BAND_RATIO} window around the
   * touch. Called once per applied frame, right before {@link trimBookLevels} — the band removes
   * prices that cannot belong to this market at all, then the trim keeps the nearest
   * {@link BOOK_LEVEL_HARD_LIMIT} of what legitimately remains, so the two never fight.
   *
   * Two paths, so the cost stays amortized:
   * 1. **Per frame**: only the prices *this frame wrote* are checked. A diff carries a handful of
   *    rows, so this is O(frame) and needs no traversal of the retained maps.
   * 2. **Full sweep**: every {@link BOOK_PRICE_BAND_SWEEP_FRAMES} frames or 5 seconds, whichever
   *    comes first. This is what removes ghosts written before the book had a touch (or before
   *    this filter existed) — rows no later diff will ever mention.
   */
  private enforcePriceBand(
    book: BookState,
    written: { bids: ReadonlyArray<[string, string]>; asks: ReadonlyArray<[string, string]> },
    at: number,
  ): void {
    book.framesSinceBandSweep += 1;
    const sweepDue = book.framesSinceBandSweep >= BOOK_PRICE_BAND_SWEEP_FRAMES
      || at - book.lastBandSweepAt >= BOOK_PRICE_BAND_SWEEP_MS;
    const band = this.priceBand(book);
    if (band !== null) {
      const dropBids: string[] = [];
      for (const [price] of written.bids) {
        if (book.bids.has(price) && this.outsidePriceBand(price, band)) dropBids.push(price);
      }
      const dropAsks: string[] = [];
      for (const [price] of written.asks) {
        if (book.asks.has(price) && this.outsidePriceBand(price, band)) dropAsks.push(price);
      }
      // Same "never empty the book" guard as the sweep, here in O(1): if this frame's own rows are
      // the whole book and all of them look out of band, the band is wrong, not the rows — one
      // stray row dragging the midpoint to nowhere must not blank a book that has real depth.
      // Keeping them is self-healing: the next frame on either side moves the midpoint to the real
      // touch and the next pass removes the stray row.
      const wouldEmpty = dropBids.length + dropAsks.length === book.bids.size + book.asks.size
        && book.bids.size + book.asks.size > 0;
      if (!wouldEmpty) {
        for (const price of dropBids) book.bids.delete(price);
        for (const price of dropAsks) book.asks.delete(price);
      }
    }
    if (!sweepDue) return;
    book.framesSinceBandSweep = 0;
    book.lastBandSweepAt = at;
    this.sweepPriceBand(book);
  }

  /**
   * The ±band window around the touch, or null when the book holds no usable reference price.
   *
   * One side empty (a very thin instrument, or a snapshot that only carried one side) falls back to
   * the surviving touch; **both** sides empty yields null, and every caller must then skip the
   * filter — with no reference price there is nothing to call a ghost.
   */
  private priceBand(book: BookState): { low: number; high: number } | null {
    let bestBid = Number.NEGATIVE_INFINITY;
    for (const price of book.bids.keys()) {
      const value = Number(price);
      if (Number.isFinite(value) && value > bestBid) bestBid = value;
    }
    let bestAsk = Number.POSITIVE_INFINITY;
    for (const price of book.asks.keys()) {
      const value = Number(price);
      if (Number.isFinite(value) && value > 0 && value < bestAsk) bestAsk = value;
    }
    const hasBid = Number.isFinite(bestBid) && bestBid > 0;
    const hasAsk = Number.isFinite(bestAsk) && bestAsk > 0;
    const center = hasBid && hasAsk
      ? (bestBid + bestAsk) / 2
      : hasBid ? bestBid : hasAsk ? bestAsk : Number.NaN;
    if (!Number.isFinite(center) || center <= 0) return null;
    return { low: center * (1 - BOOK_PRICE_BAND_RATIO), high: center * (1 + BOOK_PRICE_BAND_RATIO) };
  }

  /** A price this book must not keep: unparsable, non-positive, or beyond the band in either direction. */
  private outsidePriceBand(price: string, band: { low: number; high: number }): boolean {
    const value = Number(price);
    if (!Number.isFinite(value) || value <= 0) return true;
    return value < band.low || value > band.high;
  }

  /** Full sweep of both sides; the amortized half of {@link enforcePriceBand}. */
  private sweepPriceBand(book: BookState): void {
    const band = this.priceBand(book);
    if (band === null) return;
    const survivors = this.countInsidePriceBand(book, band);
    // A band that would empty the book is evidence the *touch* is corrupt (one stray ask far below
    // the market moves the midpoint to nowhere), not evidence of fifty ghosts. Emptying the book
    // would blank real depth and force a re-seed, so leave it: the hourly re-seed and the sequence
    // gap rules remain the repair path for a genuinely broken book.
    if (survivors === 0) return;
    for (const price of [...book.bids.keys()]) {
      if (this.outsidePriceBand(price, band)) book.bids.delete(price);
    }
    for (const price of [...book.asks.keys()]) {
      if (this.outsidePriceBand(price, band)) book.asks.delete(price);
    }
  }

  /** Levels the band would keep, both sides; backs the "never empty the book" guard above. */
  private countInsidePriceBand(book: BookState, band: { low: number; high: number }): number {
    let inside = 0;
    for (const price of book.bids.keys()) if (!this.outsidePriceBand(price, band)) inside += 1;
    for (const price of book.asks.keys()) if (!this.outsidePriceBand(price, band)) inside += 1;
    return inside;
  }

  /** Merge one frame's levels into the book and stamp the two clocks. */
  private applyBookFrame(book: BookState, result: z.infer<typeof OrderBookUpdatePushSchema>['result'], receivedAt: number): void {
    const apply = (levels: Map<string, string>, updates: Array<[string, string]>) => {
      for (const [price, quantity] of updates) {
        if (Number(quantity) === 0) levels.delete(price);
        else levels.set(price, quantity);
      }
    };
    apply(book.bids, result.b);
    apply(book.asks, result.a);
    // Ghost filter first, trim second: see `enforcePriceBand`.
    this.enforcePriceBand(book, { bids: result.b, asks: result.a }, receivedAt);
    this.trimBookLevels(book);
    book.updatedAt = new Date(result.ts).toISOString();
    // Local arrival time only moves with the frame that actually changed levels, so a quote built
    // from this book reports when *that book* was last updated, not when some unrelated channel
    // last spoke.
    book.receivedAt = receivedAt;
    book.lastSeq = typeof result.u === 'number' && result.u >= 0
      ? result.u
      : typeof result.U === 'number' ? result.U : book.lastSeq;
  }

  /**
   * Sequence rules, per venue — and never across sources.
   *
   * The CrossEx `U`/`u` counter is CrossEx's own numbering; a venue REST snapshot carries a
   * completely unrelated sequence (Binance `lastUpdateId`, Bybit `u`, Gate `id`) and OKX's seqId is
   * not comparable either. Bridging the two is impossible, which is why the seed joins by time.
   *
   * Two shapes exist upstream, told apart by `u === -1`:
   * - `u === -1` (Gate, Bybit): `U` is a per-symbol counter that increments by one per frame, so a
   *   jump means we missed frames and the book must be rebuilt from a fresh baseline.
   * - otherwise (Binance global sequence, OKX): `U..u` is a range on a venue-wide counter, so gaps
   *   are expected and only out-of-order frames can be detected — drop those.
   */
  private dropIfStaleSequentialDiff(book: BookState, symbol: string, result: z.infer<typeof OrderBookUpdatePushSchema>['result']): boolean {
    if (book.lastSeq === null) return false;
    if (result.u === -1) {
      if (typeof result.U !== 'number' || result.U === book.lastSeq + 1) return false;
      // A gap: rebuild from REST rather than patching a book we know is missing levels.
      this.requestReseed(symbol, book, 'sequence_gap');
      return true;
    }
    if (typeof result.u !== 'number') return false;
    return result.u <= book.lastSeq;
  }

  /** Ask for a new baseline after the sequence proved this book incomplete. */
  private requestReseed(symbol: string, book: BookState, reason: string): void {
    if (book.seedInFlight) return;
    book.seeded = false;
    book.pendingDiffs = [];
    book.lastSeq = null;
    book.seedFailures = 0;
    book.seedAbandoned = false;
    book.lastSeedAttemptAt = Number.NEGATIVE_INFINITY;
    this.report?.({ symbol, outcome: 'reset', durationMs: 0, levels: book.bids.size + book.asks.size, attempts: 0, reason });
    this.ensureBookSeed(symbol);
  }

  /**
   * Seed one symbol's book from the venue's own REST depth endpoint.
   *
   * Serialized per symbol, spaced by at least {@link BOOK_SEED_MIN_INTERVAL_MS}, retried with a
   * {@link BOOK_SEED_RETRY_MS} backoff, and abandoned after {@link BOOK_SEED_MAX_ATTEMPTS} failures
   * — after which diffs accumulate the old way rather than leaving the book blank forever.
   *
   * The join with the live feed is by *local* time only: every frame arriving while the request is
   * in flight is buffered, and once the snapshot lands the cut-off is set to that arrival instant, so
   * only frames we received afterwards replay. Venue `ts` values are never compared against it (that
   * mixes two clocks), and sequence ids are never compared across sources.
   */
  private ensureBookSeed(symbol: string): void {
    const book = this.books.get(symbol);
    if (!book || book.seeded || book.seedInFlight || book.seedAbandoned) return;
    if (this.depthSource === undefined) return;
    const now = this.now();
    const spacing = book.seedFailures === 0 ? BOOK_SEED_MIN_INTERVAL_MS : BOOK_SEED_RETRY_MS;
    if (now - book.lastSeedAttemptAt < spacing) return;

    book.seedInFlight = true;
    book.lastSeedAttemptAt = now;
    // Reset rather than stamp: the meaningful cut-off is the *arrival* time of the response, set
    // below. Stamping the request time here was the bug — it compared a local instant against the
    // venue's event clock.
    book.seedCutoffMs = 0;
    this.startBookSweeper();

    const startedAt = now;
    void this.depthSource(symbol, BOOK_SEED_LIMIT).then((snapshot) => {
      const current = this.books.get(symbol);
      // The book may have been released or replaced while the request was in flight.
      if (!current || current !== book) return;
      current.seedInFlight = false;
      if (snapshot === null || snapshot.bids.length === 0 || snapshot.asks.length === 0) {
        this.countSeedFailure(symbol, current, startedAt, 'empty_snapshot');
        return;
      }
      current.bids = new Map(snapshot.bids.map(([price, size]) => [price, size]));
      current.asks = new Map(snapshot.asks.map(([price, size]) => [price, size]));
      current.seeded = true;
      current.seedFailures = 0;
      current.seedAbandoned = false;
      current.seededAt = this.now();
      // Join the two streams on **one** clock: our own. The cut-off is when the snapshot arrived, and
      // a buffered frame replays only if *we received it* after that — its venue `ts` is never
      // consulted, because a venue clock running fast would replay pre-snapshot frames on top of a
      // newer snapshot (silent corruption) and a slow one would discard genuinely new frames.
      // Everything buffered during the request is therefore older than the snapshot's content and is
      // dropped; the next diff that touches a level restores it, so no ghost can survive.
      // Single-threaded, so this window is normally empty — it exists for the case where the
      // resolution and the incoming frame interleave. The margin keeps that window conservative.
      current.seedCutoffMs = Date.now() + BOOK_SEED_CUTOFF_MARGIN_MS;
      const replayed = current.pendingDiffs.filter((frame) => frame.receivedAt > current.seedCutoffMs);
      const droppedBeforeCutoff = current.pendingDiffs.length - replayed.length;
      current.pendingDiffs = [];
      for (const frame of replayed) {
        const apply = (levels: Map<string, string>, updates: Array<[string, string]>) => {
          for (const [price, size] of updates) {
            if (Number(size) === 0) levels.delete(price);
            else levels.set(price, size);
          }
        };
        apply(current.bids, frame.bids);
        apply(current.asks, frame.asks);
        current.updatedAt = new Date(frame.ts).toISOString();
      }
      this.trimBookLevels(current);
      this.report?.({
        symbol,
        outcome: 'seeded',
        durationMs: this.now() - startedAt,
        levels: current.bids.size + current.asks.size,
        attempts: current.seedFailures + 1,
        reason: `replayed=${replayed.length} droppedBeforeCutoff=${droppedBeforeCutoff}`,
      });
      this.scheduleBookEmit(symbol, current);
    }).catch((error: unknown) => {
      const current = this.books.get(symbol);
      if (!current || current !== book) return;
      current.seedInFlight = false;
      this.countSeedFailure(symbol, current, startedAt, error instanceof Error ? error.message : 'seed_failed');
    });
  }

  /** One failed attempt: retry with backoff, or fall back to plain accumulation when spent. */
  private countSeedFailure(symbol: string, book: BookState, startedAt: number, reason: string): void {
    book.seedFailures += 1;
    const spent = book.seedFailures >= BOOK_SEED_MAX_ATTEMPTS;
    if (spent) {
      // The venue is unreachable: keep the feature alive with the pre-seeding behaviour instead of
      // rendering an empty book forever.
      book.seedAbandoned = true;
      book.pendingDiffs = [];
    }
    this.report?.({
      symbol,
      outcome: spent ? 'abandoned' : 'failed',
      durationMs: this.now() - startedAt,
      levels: book.bids.size + book.asks.size,
      attempts: book.seedFailures,
      reason,
    });
  }

  /** Start the sweeper that retries unseeded books and refreshes seeded ones hourly. */
  private startBookSweeper(): void {
    if (this.bookSeedSweep !== null || this.depthSource === undefined) return;
    this.bookSeedSweep = setInterval(() => this.sweepBookSeeds(), BOOK_SEED_SWEEP_MS);
    this.bookSeedSweep.unref?.();
  }

  /** Stop the sweeper; called when the last book watcher goes away. */
  private stopBookSweeperIfIdle(): void {
    if (this.bookWatchers.size > 0 || this.bookSeedSweep === null) return;
    clearInterval(this.bookSeedSweep);
    this.bookSeedSweep = null;
  }

  /**
   * Periodic pass over watched books: retry a failed/unseeded one, and rebuild a seeded one from
   * REST every {@link BOOK_RESET_INTERVAL_MS}. The hourly rebuild is what keeps ghost levels — a
   * price that emptied before we subscribed gets no delete frame — from accumulating forever.
   */
  private sweepBookSeeds(): void {
    const now = this.now();
    for (const [symbol, book] of this.books) {
      if (!this.bookWatchers.has(`order_book_update:${symbol}`)) continue;
      if (!book.seeded) {
        this.ensureBookSeed(symbol);
        continue;
      }
      if (book.seedInFlight || now - book.seededAt < BOOK_RESET_INTERVAL_MS) continue;
      // Rebuild in place: `seeded` stays true so the live feed keeps patching until the new
      // baseline lands, and the replay window closes over anything that arrived meanwhile.
      book.seedInFlight = false;
      this.requestReseed(symbol, book, 'hourly_reset');
    }
  }

  private scheduleBookEmit(symbol: string, book: BookState): void {
    if (book.emitTimer) {
      book.dirty = true;
      return;
    }
    this.emitBook(symbol, book);
    book.emitTimer = setTimeout(() => {
      book.emitTimer = null;
      if (book.dirty) {
        book.dirty = false;
        this.scheduleBookEmit(symbol, book);
      }
    }, BOOK_EMIT_INTERVAL_MS);
  }

  private bookSnapshot(symbol: string, book: BookState): OrderBookSnapshot {
    const bids = [...book.bids.entries()].sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, MAX_BOOK_LEVELS);
    const asks = [...book.asks.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, MAX_BOOK_LEVELS);
    return { symbol, bids, asks, updatedAt: book.updatedAt, source: 'gate_crossex_websocket' };
  }

  private emitBook(symbol: string, book: BookState): void {
    const snapshot = this.bookSnapshot(symbol, book);
    this.notify({ type: 'orderbook.update', payload: snapshot });
  }

  private applyTrade(result: { s: string; i: string; p: string; q: string; S: 'BUY' | 'SELL'; ts: number }): void {
    const symbol = this.tradeWatchers.has(`trade:${result.s}`)
      ? result.s
      : this.tradeSymbolAliases.get(normalizeTradeSymbol(result.s));
    // Trade-symbol resolution above is watcher-dependent, so clear as soon as a symbol resolves:
    // the frame proves this channel is live, and only this channel's verdict is forgiven.
    if (symbol) this.clearInvalid('trade', symbol);
    if (!symbol || !this.tradeWatchers.has(`trade:${symbol}`)) return;
    const trade: PublicTrade = {
      id: result.i, symbol, price: result.p, quantity: result.q, side: result.S,
      executedAt: new Date(result.ts).toISOString(),
    };
    const buffer = this.trades.get(symbol) ?? [];
    if (buffer.some((existing) => existing.id === trade.id)) return;
    buffer.unshift(trade);
    if (buffer.length > MAX_TRADES) buffer.length = MAX_TRADES;
    this.trades.set(symbol, buffer);
    this.notify({ type: 'trade.update', payload: { symbol, trade } });
  }

  private applyKline(interval: CandleInterval, result: { s: string; o: string; h: string; l: string; c: string; v: string; t: number; x: boolean }): void {
    const symbol = this.resolveStreamSymbol(result.s);
    this.clearInvalid(`kline_${interval}`, symbol);
    if (!this.klineWatchers.has(`kline_${interval}:${symbol}`)) return;
    const key = `${symbol}:${interval}`;
    const series = this.candleSeries.get(key) ?? [];
    const candle: Candle = { startTime: result.t, open: result.o, high: result.h, low: result.l, close: result.c, volume: result.v, closed: result.x };
    const last = series[series.length - 1];
    if (last && last.startTime === candle.startTime) series[series.length - 1] = candle;
    else if (!last || candle.startTime > last.startTime) series.push(candle);
    else {
      const index = series.findIndex((existing) => existing.startTime === candle.startTime);
      if (index >= 0) series[index] = candle;
      else return;
    }
    if (series.length > MAX_CANDLES) series.splice(0, series.length - MAX_CANDLES);
    this.candleSeries.set(key, series);
    this.notify({ type: 'kline.update', payload: { symbol, interval, candle } });
  }

  private publish(market: LiveMarket): void {
    this.markets.set(market.symbol, market);
    this.notify({ type: 'market.update', payload: market });
  }

  /**
   * Map a pushed stream symbol onto its registered CrossEx market. Spot pushes arrive under the
   * venue-native pair name (e.g. "BTC_USDT") while futures pushes carry the CrossEx symbol, so a
   * bare pair name resolves against the registered GATE spot namespace; unknown names pass
   * through unchanged and miss the lookup as before.
   */
  private resolveStreamSymbol(raw: string): string {
    if (this.markets.has(raw)) return raw;
    const spotCandidate = `GATE_SPOT_${raw}`;
    return this.markets.has(spotCandidate) ? spotCandidate : raw;
  }
}

export { invalidSymbolsFromMessage, CANDLE_INTERVALS, MAX_DYNAMIC_SYMBOLS, SYMBOLS_PER_SHARD };
export type { CandleInterval };
