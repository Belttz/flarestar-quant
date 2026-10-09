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

/** Streamed symbols beyond the seed set are bounded so a long session cannot grow subscriptions without limit. */
const MAX_DYNAMIC_SYMBOLS = 1_000;

/**
 * The upstream CrossEx socket rejects any subscription frame beyond 100 symbols per channel per
 * connection ("Each channel is limited to 100 symbols per connection") — and it rejects the WHOLE
 * frame, so a single oversized request silently starves every symbol in it. Symbols are therefore
 * spread across a pool of connections, each carrying at most 100 symbols on every channel.
 */
const SYMBOLS_PER_SHARD = 100;
const MAX_SHARDS = Math.ceil((1_000 + 200) / SYMBOLS_PER_SHARD);

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
  };
}

interface BookState {
  bids: Map<string, string>;
  asks: Map<string, string>;
  updatedAt: string;
  dirty: boolean;
  emitTimer: ReturnType<typeof setTimeout> | null;
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
  private readonly invalidSymbols = new Map<string, Set<string>>();
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

  constructor(
    private readonly url: string,
    options: { heartbeatIntervalMs?: number; marketIdlePingAfterMs?: number; staleAfterMs?: number } = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.marketIdlePingAfterMs = options.marketIdlePingAfterMs ?? 2_000;
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
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

  hasAsset(asset: string): boolean {
    for (const market of this.markets.values()) {
      if (market.asset === asset) return true;
    }
    return false;
  }

  /**
   * Register markets discovered from the instrument catalog and subscribe their public channels.
   * Safe to call repeatedly: known symbols are skipped. Returns false when the dynamic-symbol
   * budget is exhausted, in which case nothing was added.
   */
  ensureMarkets(definitions: MarketDefinition[]): boolean {
    const missing = definitions.filter((definition) => !this.markets.has(definition.symbol));
    if (missing.length === 0) return true;
    if (this.dynamicSymbolCount + missing.length > MAX_DYNAMIC_SYMBOLS) return false;
    this.dynamicSymbolCount += missing.length;
    for (const definition of missing) {
      this.markets.set(definition.symbol, pendingMarket(definition));
      this.dynamicMarkets.set(definition.symbol, Date.now());
    }
    for (const definition of definitions) {
      if (this.dynamicMarkets.has(definition.symbol)) this.dynamicMarkets.set(definition.symbol, Date.now());
    }
    const symbols = missing.map((definition) => definition.symbol);
    for (const channel of ['ticker', 'funding_rate', 'open_interest']) {
      this.subscribeSymbols(channel, symbols);
    }
    return true;
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
    return this.watch(this.bookWatchers, 'order_book_update', symbol, () => {
      const book = this.books.get(symbol);
      if (book?.emitTimer) clearTimeout(book.emitTimer);
      this.books.delete(symbol);
    });
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

  /** Route each symbol to its shard, subscribe the channel there, and dial new shards on demand. */
  private subscribeSymbols(channel: string, symbols: string[]): void {
    const invalid = this.invalidSymbols.get(channel);
    const byShard = new Map<ShardConnection, string[]>();
    for (const symbol of symbols) {
      if (invalid?.has(symbol)) continue;
      const shard = this.shardFor(symbol);
      if (!shard) {
        this.pendingAssignments.add(symbol);
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
    if (this.shards.size >= MAX_SHARDS) return null;
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
    for (const [symbol, lastUsedAt] of this.dynamicMarkets) {
      if (lastUsedAt > cutoff || this.isActivelyWatched(symbol)) continue;
      for (const channel of ['ticker', 'funding_rate', 'open_interest']) {
        this.unsubscribeSymbols(channel, [symbol]);
        this.invalidSymbols.get(channel)?.delete(symbol);
      }
      this.releaseSymbolShard(symbol);
      this.markets.delete(symbol);
      this.dynamicMarkets.delete(symbol);
      this.dynamicSymbolCount = Math.max(0, this.dynamicSymbolCount - 1);
    }
    // Symbols that waited for a shard slot get another chance once space may have freed up.
    if (this.pendingAssignments.size > 0 && !this.stopped) {
      const pending = [...this.pendingAssignments].filter((symbol) => this.markets.has(symbol));
      this.pendingAssignments.clear();
      for (const channel of ['ticker', 'funding_rate', 'open_interest']) this.subscribeSymbols(channel, pending);
    }
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
      const invalid = this.invalidSymbols.get(channel) ?? new Set<string>();
      for (const symbol of invalidFound) {
        subscribed.delete(symbol);
        invalid.add(symbol);
      }
      this.invalidSymbols.set(channel, invalid);
      const socket = shard.socket;
      if (socket?.readyState === WebSocket.OPEN && subscribed.size > 0 && ['ticker', 'funding_rate', 'open_interest'].includes(channel)) {
        this.sendSubscribe(socket, channel, [...subscribed]);
      }
      return false;
    }
    if (frame.event !== 'update' || typeof frame.channel !== 'string') return false;
    if (frame.channel === 'ticker') {
      const ticker = TickerPushSchema.safeParse(payload);
      if (!ticker.success) return false;
      const symbol = this.resolveStreamSymbol(ticker.data.result.s);
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
      const bookTop = bookTopOf(this.books.get(symbol));
      const frameBid = usableQuote(value.bp) ? value.bp : bookTop?.bidPrice;
      const frameAsk = usableQuote(value.ap) ? value.ap : bookTop?.askPrice;
      // When the frame carries no quote and the book offers none either, keep the stored record
      // untouched instead of publishing an all-empty update.
      if (!usableQuote(value.lp) && frameBid === undefined && frameAsk === undefined) return true;
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
      });
      return true;
    }
    // The ticker's `updatedAt`, `receivedAt`, and `source` are the strategy engine's evidence that
    // bid/ask came from the exchange recently and arrived promptly. Funding and open-interest
    // pushes must never refresh them, or seed, stale, or delayed prices could pass that gate.
    if (frame.channel === 'funding_rate') {
      const funding = FundingPushSchema.safeParse(payload);
      if (!funding.success) return false;
      const current = this.markets.get(funding.data.result.s);
      if (current) this.publish({ ...current, fundingRate: funding.data.result.r, nextFundingAt: new Date(funding.data.result.T).toISOString() });
      return true;
    }
    if (frame.channel === 'open_interest') {
      const interest = OpenInterestPushSchema.safeParse(payload);
      if (!interest.success) return false;
      const current = this.markets.get(interest.data.result.s);
      if (current) this.publish({ ...current, openInterest: interest.data.result.oi, openInterestValue: interest.data.result.oiV ?? current.openInterestValue });
      return true;
    }
    if (frame.channel === 'order_book_update') {
      const bookUpdate = OrderBookUpdatePushSchema.safeParse(payload);
      if (!bookUpdate.success) return false;
      this.applyBookUpdate(bookUpdate.data.result);
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

  private applyBookUpdate(result: z.infer<typeof OrderBookUpdatePushSchema>['result']): void {
    const symbol = this.resolveStreamSymbol(result.s);
    if (!this.bookWatchers.has(`order_book_update:${symbol}`)) return;
    let book = this.books.get(symbol);
    if (!book || result.snapshot) {
      if (book?.emitTimer) clearTimeout(book.emitTimer);
      book = { bids: new Map(), asks: new Map(), updatedAt: new Date(result.ts).toISOString(), dirty: false, emitTimer: null };
      this.books.set(symbol, book);
    }
    const apply = (levels: Map<string, string>, updates: Array<[string, string]>) => {
      for (const [price, quantity] of updates) {
        if (Number(quantity) === 0) levels.delete(price);
        else levels.set(price, quantity);
      }
    };
    apply(book.bids, result.b);
    apply(book.asks, result.a);
    book.updatedAt = new Date(result.ts).toISOString();
    this.scheduleBookEmit(symbol, book);
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

export { invalidSymbolsFromMessage, CANDLE_INTERVALS };
export type { CandleInterval };
