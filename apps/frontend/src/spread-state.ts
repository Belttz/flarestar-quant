import type { LiveMarket, MarketBookDepth } from './api.js';
import { quoteLocalReceivedAt, SPREAD_QUOTE_MAX_SKEW_MS, STRATEGY_FUTURE_QUOTE_TOLERANCE_MS, STRATEGY_MARKET_FRESHNESS_MS, type QuoteTimestamps } from './market-freshness.js';

/**
 * Three-state quote/spread model shared by every price-difference surface.
 *
 * The price-difference bot's live spread used to be rendered from `Number(price ?? 0)`, which
 * collapsed three genuinely different situations into the same `0.00 bps`:
 *
 *   1. no quote has arrived yet (the leg is not subscribed / the venue pushes nothing),
 *   2. a quote exists but is older than the executable budget,
 *   3. both legs quote, but seconds apart, so the difference never coexisted on any venue.
 *
 * Every consumer must therefore ask for a {@link SpreadReadout} instead of doing its own
 * arithmetic: `bps` is `null` unless the pair is genuinely executable *and* contemporaneous, and
 * `status`/`reason` carry the explanation the UI renders.
 */

export type QuoteSide = 'bid' | 'ask';

/**
 * Where a leg's displayed price came from.
 *
 * - `stream`  — the market record pushed on the page's CrossEx WebSocket watch.
 * - `books-top` — the same hub record, but read through `GET /api/markets/books` instead of the
 *   page's stream. This is a **transport** difference, not a second market-data source: the
 *   endpoint resolves the identical `LiveMarket` and the identical CrossEx ticker. It matters
 *   because that HTTP read (a) is taken at request time, so it can be newer than the frame this
 *   page last rendered, (b) is not filtered by the page's watch list, so it still answers for a leg
 *   the snapshot is missing, and (c) registers/warms the market on demand server-side. The name
 *   deliberately avoids `ticker-fallback`: both paths carry the CrossEx ticker, and calling one a
 *   fallback feed once made a staleness investigation point at the wrong layer.
 * - `none`    — nothing usable; `state` is `missing`.
 */
export type LegQuoteSource = 'stream' | 'books-top' | 'none';

/** `live` = executable now, `stale` = a real quote that aged out, `missing` = never quoted. */
export type LegQuoteState = 'live' | 'stale' | 'missing';

export interface LegQuote {
  state: LegQuoteState;
  /** Price on the requested side (`bid` when selling, `ask` when buying). */
  price: number | null;
  bid: number | null;
  ask: number | null;
  /** Local arrival time of the quote that produced `price`, in epoch ms. */
  quotedAtMs: number | null;
  /** `now − quotedAtMs`; `null` when the quote carries no usable timestamp. */
  ageMs: number | null;
  source: LegQuoteSource;
}

export interface LegQuoteInput {
  /**
   * The streamed record for this leg, straight from the market snapshot. Its `source` must be
   * `gate_crossex_websocket`: seeded/placeholder rows carry invented prices and are never quotes.
   */
  market?: (Pick<LiveMarket, 'source' | 'bidPrice' | 'askPrice'> & QuoteTimestamps) | null;
  /**
   * Top-of-book read from `GET /api/markets/books`. Same hub record as `market` (see
   * `LegQuoteSource['books-top']`), consumed here when the page's stream carries no usable price
   * for the requested side — a sparse ticker, a leg missing from the page's watch snapshot, or a
   * page that has not received its first frame yet. The endpoint's `source: 'ticker'` means the
   * local book is **not seeded** (REST baseline pending or abandoned), so only a single level is
   * available; it no longer means "this venue never publishes a book".
   */
  topOfBook?: Pick<MarketBookDepth, 'bestBid' | 'bestAsk' | 'updatedAt'> | null;
}

export interface LegQuoteOptions {
  now?: number;
  /** Max age still treated as executable. Defaults to the shared 15s display budget. */
  maxAgeMs?: number;
  /** Future-timestamp tolerance, mirroring the freshness gate's clock-skew allowance. */
  futureToleranceMs?: number;
  /**
   * Local time the `/api/markets/books` response was produced. That endpoint only carries venue
   * event times, so without this the `books-top` fallback would date the quote on the venue's
   * clock and could not be compared with a streamed leg on ours.
   */
  topOfBookReceivedAt?: number | null;
}

/** A finite, strictly positive number, or `null`. Never fabricates a zero. */
export function usablePrice(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** `Date.parse` that yields `null` instead of `NaN` for absent/malformed timestamps. */
export function usableTimestamp(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quoteFrom(
  bid: number | null,
  ask: number | null,
  quotedAtMs: number | null,
  source: Exclude<LegQuoteSource, 'none'>,
  side: QuoteSide,
  now: number,
  maxAgeMs: number,
  futureToleranceMs: number,
): LegQuote | null {
  const price = side === 'bid' ? bid : ask;
  if (price === null) return null;
  // A quote we cannot date cannot be proven executable: report it as stale rather than live.
  const ageMs = quotedAtMs === null ? null : now - quotedAtMs;
  const fresh = ageMs !== null && ageMs <= maxAgeMs && ageMs >= -futureToleranceMs;
  return { state: fresh ? 'live' : 'stale', price, bid, ask, quotedAtMs, ageMs, source };
}

/**
 * Resolve one leg's executable quote, preferring the record this page is already streaming and
 * falling back to the same market read through `GET /api/markets/books`. The returned `state` is
 * the only thing callers may treat as a truthy "price available" signal — `price` alone may
 * describe a quote that is no longer tradable.
 */
export function resolveLegQuote(
  input: LegQuoteInput,
  side: QuoteSide,
  options: LegQuoteOptions = {},
): LegQuote {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? STRATEGY_MARKET_FRESHNESS_MS;
  const futureToleranceMs = options.futureToleranceMs ?? STRATEGY_FUTURE_QUOTE_TOLERANCE_MS;

  const market = input.market ?? null;
  if (market && market.source === 'gate_crossex_websocket') {
    // Age and cross-leg skew are measured on the local clock. `quoteUpdatedAt` is the venue's own
    // event time: two venues whose clocks differ by seconds would look unaligned forever, which is
    // precisely the "some exchanges never show a spread" report. The helper falls back to
    // `quoteUpdatedAt` for records produced before `quoteReceivedAt` existed.
    const streamQuote = quoteFrom(
      usablePrice(market.bidPrice),
      usablePrice(market.askPrice),
      quoteLocalReceivedAt(market),
      'stream',
      side,
      now,
      maxAgeMs,
      futureToleranceMs,
    );
    if (streamQuote !== null) return streamQuote;
  }

  const topOfBook = input.topOfBook ?? null;
  if (topOfBook) {
    // The depth endpoint only reports venue event times, so the caller supplies the moment the
    // response was produced (a local upper bound for when this quote existed). Without it we keep
    // the venue timestamp — the pre-existing behaviour — rather than pretending to know.
    const fallbackQuote = quoteFrom(
      usablePrice(topOfBook.bestBid),
      usablePrice(topOfBook.bestAsk),
      options.topOfBookReceivedAt ?? usableTimestamp(topOfBook.updatedAt),
      'books-top',
      side,
      now,
      maxAgeMs,
      futureToleranceMs,
    );
    if (fallbackQuote !== null) return fallbackQuote;
  }

  return { state: 'missing', price: null, bid: null, ask: null, quotedAtMs: null, ageMs: null, source: 'none' };
}

export type SpreadStatus = 'live' | 'unaligned' | 'stale' | 'waiting';

export type SpreadReason =
  | 'ready'
  | 'missing_both_legs'
  | 'missing_sell_leg'
  | 'missing_buy_leg'
  | 'stale'
  | 'skew_exceeded';

export interface SpreadReadout {
  status: SpreadStatus;
  reason: SpreadReason;
  /** Basis points on the sell leg's price; `null` unless `status === 'live'`. */
  bps: number | null;
  /** `sell − buy` in price units; `null` unless `status === 'live'`. */
  gap: number | null;
  /** Display price per leg: the live value, or the last known one while stale. */
  sellPrice: number | null;
  buyPrice: number | null;
  /** Absolute leg-to-leg difference of the two quotes' local arrival times, when both are dated. */
  skewMs: number | null;
  /** Translations key the UI renders next to the number. */
  messageKey: string;
}

export interface SpreadInput {
  /** The leg that is sold (venue A, or venue B when the direction is flipped). */
  sell: LegQuote;
  /** The leg that is bought. */
  buy: LegQuote;
  maxSkewMs?: number;
}

/**
 * Combine the two legs into one readout. The bps figure is produced **only** when both legs are
 * live and their local arrival times sit inside the shared skew budget. Anything else returns a
 * named non-live status so the UI can say *why* instead of printing a spread that never existed.
 *
 * The skew is measured on our clock (`LegQuote.quotedAtMs` is a local arrival time), never by
 * subtracting two venues' own timestamps: an exchange clock a few seconds off would otherwise put
 * every pair it trades into the "unaligned" bucket permanently.
 */
export function buildSpreadReadout(input: SpreadInput): SpreadReadout {
  const maxSkewMs = input.maxSkewMs ?? SPREAD_QUOTE_MAX_SKEW_MS;
  const { sell, buy } = input;
  const sellPrice = sell.price;
  const buyPrice = buy.price;

  const bothTimed = sell.quotedAtMs !== null && buy.quotedAtMs !== null;
  const skewMs = bothTimed && sell.quotedAtMs !== null && buy.quotedAtMs !== null
    ? Math.abs(sell.quotedAtMs - buy.quotedAtMs)
    : null;

  if (sell.state === 'missing' && buy.state === 'missing') {
    return { status: 'waiting', reason: 'missing_both_legs', bps: null, gap: null, sellPrice, buyPrice, skewMs, messageKey: 'Waiting for both leg prices' };
  }
  if (sell.state === 'missing') {
    return { status: 'waiting', reason: 'missing_sell_leg', bps: null, gap: null, sellPrice, buyPrice, skewMs, messageKey: 'Waiting for the missing leg quote' };
  }
  if (buy.state === 'missing') {
    return { status: 'waiting', reason: 'missing_buy_leg', bps: null, gap: null, sellPrice, buyPrice, skewMs, messageKey: 'Waiting for the missing leg quote' };
  }
  if (sell.state === 'stale' || buy.state === 'stale') {
    return { status: 'stale', reason: 'stale', bps: null, gap: null, sellPrice, buyPrice, skewMs, messageKey: 'A leg quote is stale; waiting for its next update.' };
  }
  if (sellPrice === null || buyPrice === null || sellPrice <= 0 || buyPrice <= 0) {
    // Defensive: a `live` leg always carries a positive price, so this only fires on a malformed
    // record. Treat it as "waiting" rather than dividing by zero.
    return { status: 'waiting', reason: 'missing_both_legs', bps: null, gap: null, sellPrice, buyPrice, skewMs, messageKey: 'Waiting for both leg prices' };
  }
  if (skewMs === null) {
    // Both legs claim to be live but one carries no timestamp, which the state machine above
    // cannot produce; keep the conservative verdict instead of inventing alignment.
    return { status: 'unaligned', reason: 'skew_exceeded', bps: null, gap: null, sellPrice, buyPrice, skewMs: null, messageKey: 'Leg quotes are not time-aligned' };
  }
  if (skewMs > maxSkewMs) {
    return { status: 'unaligned', reason: 'skew_exceeded', bps: null, gap: null, sellPrice, buyPrice, skewMs, messageKey: 'Leg quotes are not time-aligned' };
  }
  return {
    status: 'live',
    reason: 'ready',
    bps: ((sellPrice - buyPrice) / buyPrice) * 10_000,
    gap: sellPrice - buyPrice,
    sellPrice,
    buyPrice,
    skewMs,
    messageKey: 'Switch direction',
  };
}

export type PairHistoryPhase =
  | 'loading'
  | 'ready'
  | 'no-overlap'
  | 'missing-leg'
  | 'empty'
  | 'failed';

export interface PairHistoryReadout {
  phase: PairHistoryPhase;
  /** Legs that returned no candles at all, in display order. */
  missingLegs: Array<'left' | 'right'>;
  /** True when asking again can plausibly produce data (history is fetched, not derived). */
  retryable: boolean;
  messageKey: string;
}

export interface PairHistoryInput {
  /** `'live'` from the hook means "the request finished", not "the series has points". */
  status: 'loading' | 'live' | 'failed';
  pointCount: number;
  leftCount: number;
  rightCount: number;
  /** Backend `building` flag: a venue refresh is still running for that leg. */
  leftBuilding?: boolean;
  rightBuilding?: boolean;
}

/**
 * Decide what the price-difference chart is actually showing.
 *
 * The old UI reported every empty series as "No overlapping candles for this venue pair", which
 * was wrong in the two cases that actually happen: a leg whose venue REST history cannot be
 * fetched at all (the request succeeds with zero candles), and a first paint that is still
 * waiting for the venue page. Those are now separate phases with separate messages.
 */
export function buildPairHistoryReadout(input: PairHistoryInput): PairHistoryReadout {
  const leftEmpty = input.leftCount === 0;
  const rightEmpty = input.rightCount === 0;
  const building = input.leftBuilding === true || input.rightBuilding === true;

  if (input.pointCount > 0) {
    return { phase: 'ready', missingLegs: [], retryable: false, messageKey: 'Live pair' };
  }
  if (input.status === 'failed') {
    return {
      phase: 'failed',
      missingLegs: [...(leftEmpty ? ['left'] as const : []), ...(rightEmpty ? ['right'] as const : [])],
      retryable: true,
      messageKey: 'Price-difference history unavailable',
    };
  }
  if (input.status === 'loading' || building) {
    return { phase: 'loading', missingLegs: [], retryable: false, messageKey: 'Loading price-difference history…' };
  }
  if (leftEmpty || rightEmpty) {
    const missingLegs: Array<'left' | 'right'> = [...(leftEmpty ? ['left'] as const : []), ...(rightEmpty ? ['right'] as const : [])];
    return { phase: 'missing-leg', missingLegs, retryable: true, messageKey: 'No candle history for this venue leg' };
  }
  if (input.leftCount > 0 && input.rightCount > 0) {
    // Both series arrived but share no timestamp: a genuine overlap gap, not a fetch failure.
    return { phase: 'no-overlap', missingLegs: [], retryable: false, messageKey: 'No overlapping candles for this venue pair.' };
  }
  return { phase: 'empty', missingLegs: [], retryable: true, messageKey: 'No candle history for this venue leg' };
}

/** Human label for a leg quote's state, reused by the market/venue cells. */
export function legQuoteStateKey(state: LegQuoteState): string {
  return state === 'live' ? 'Live' : state === 'stale' ? 'Stale quote' : 'No quote';
}
