import { CANDLE_INTERVAL_MILLISECONDS } from '@gate-crossex/shared-types';
import type { Candle, CandleInterval, LiveMarket, MarketSnapshot } from './api.js';

export const STRATEGY_MARKET_FRESHNESS_MS = 15_000;
export const STRATEGY_MARKET_MAX_TRANSPORT_LAG_MS = 3_000;
export const STRATEGY_FUTURE_QUOTE_TOLERANCE_MS = 2_000;

/**
 * Max |leftQuoteUpdatedAt − rightQuoteUpdatedAt| still considered "the same moment" when a spread
 * is shown. Mirrors the backend's `GCT_SPREAD_SKEW_MS` budget (default 2000) so the displayed
 * spread and the engine's executed spread share one alignment yardstick (PRD R4 / US-7).
 */
export const SPREAD_QUOTE_MAX_SKEW_MS = 2_000;

/**
 * The timestamps a streamed quote can be dated by. Every field is optional because they arrive
 * from three different generations of payload: `quoteReceivedAt` is the newest, `receivedAt` and
 * `quoteUpdatedAt` predate it, and a record that never carried a quote has none of them.
 */
export interface QuoteTimestamps {
  quoteReceivedAt?: number | null;
  receivedAt?: string;
  quoteUpdatedAt?: string;
}

/**
 * Two clocks, two questions — and they must never be swapped.
 *
 * - **Local arrival time** (`quoteReceivedAt`, epoch ms) answers "is this quote still executable?"
 *   and "were these two legs quoted at the same moment?" Both are questions about *our* timeline:
 *   how long ago we learned the price, and how far apart we learned the two. Comparing two venues'
 *   own event timestamps instead made a pair look unaligned whenever the venues' clocks drifted
 *   apart by more than the skew budget — a permanent false rejection for every combination that
 *   involved the drifting venue, which is what "some exchanges' spreads never show up" looked like.
 * - **Venue event time** (`quoteUpdatedAt`) answers "how long did this frame take to reach us?"
 *   That is a network measurement (received − source) and legitimately uses the venue's clock.
 *
 * `quoteReceivedAt` is optional (older payloads and older rows omit it), so every reader falls back
 * to `receivedAt` and then to `quoteUpdatedAt` — the pre-existing behaviour — rather than treating
 * the quote as unknown.
 */
export function quoteLocalReceivedAt(market: QuoteTimestamps): number | null {
  if (typeof market.quoteReceivedAt === 'number' && Number.isFinite(market.quoteReceivedAt)) {
    return market.quoteReceivedAt;
  }
  const received = market.receivedAt === undefined ? NaN : Date.parse(market.receivedAt);
  if (Number.isFinite(received)) return received;
  return market.quoteUpdatedAt === undefined ? null : finiteOrNull(Date.parse(market.quoteUpdatedAt));
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export type SpreadQuoteAlignment =
  | { aligned: true; skewMs: number }
  | { aligned: false; skewMs: number | null; reason: 'missing_quote_timestamp' | 'skew_exceeded' };

/**
 * Judge whether two legs' executable quotes come from (roughly) the same moment.
 *
 * Both sides are measured on the backend's own clock (`quoteLocalReceivedAt`), not on the venues'
 * clocks: an exchange whose clock runs 3s behind its peers would otherwise make every pair it
 * participates in permanently "unaligned", hiding the spread entirely. A leg that never carried a
 * quote has no local arrival time and is never aligned.
 */
export function assessSpreadQuoteAlignment(
  left: QuoteTimestamps,
  right: QuoteTimestamps,
  maxSkewMs = SPREAD_QUOTE_MAX_SKEW_MS,
): SpreadQuoteAlignment {
  const leftMs = quoteLocalReceivedAt(left);
  const rightMs = quoteLocalReceivedAt(right);
  if (leftMs === null || rightMs === null) {
    return { aligned: false, skewMs: null, reason: 'missing_quote_timestamp' };
  }
  const skewMs = Math.abs(leftMs - rightMs);
  return skewMs <= maxSkewMs
    ? { aligned: true, skewMs }
    : { aligned: false, skewMs, reason: 'skew_exceeded' };
}

export interface FreshMarketPair {
  left: LiveMarket;
  right: LiveMarket;
}

export type MarketPairWaitReason = 'feed' | 'missing' | 'non_live' | 'stale' | 'delayed';

export type MarketPairFreshness =
  | { pair: FreshMarketPair; reason: null }
  | { pair: null; reason: MarketPairWaitReason };

/**
 * Return the last streamed prices for display, even after they stop being executable. The caller
 * must still use `assessMarketPairFreshness` for readiness and show its warning alongside these
 * values; demo placeholders are never presented as venue prices.
 */
export function lastKnownLiveMarketPair(
  snapshot: MarketSnapshot | null,
  leftSymbol: string,
  rightSymbol: string,
): FreshMarketPair | null {
  const left = snapshot?.markets.find((market) => market.symbol === leftSymbol);
  const right = snapshot?.markets.find((market) => market.symbol === rightSymbol);
  return left?.source === 'gate_crossex_websocket' && right?.source === 'gate_crossex_websocket'
    ? { left, right }
    : null;
}

/** Explain why a pair is not executable so the UI does not collapse every failure into one hint. */
export function assessMarketPairFreshness(
  snapshot: MarketSnapshot | null,
  leftSymbol: string,
  rightSymbol: string,
  now = Date.now(),
): MarketPairFreshness {
  if (!snapshot || snapshot.connectionState !== 'healthy') return { pair: null, reason: 'feed' };
  const left = snapshot.markets.find((market) => market.symbol === leftSymbol);
  const right = snapshot.markets.find((market) => market.symbol === rightSymbol);
  if (!left || !right) return { pair: null, reason: 'missing' };
  if (left.source !== 'gate_crossex_websocket' || right.source !== 'gate_crossex_websocket') {
    return { pair: null, reason: 'non_live' };
  }
  const leftUpdatedAt = Date.parse(left.updatedAt);
  const rightUpdatedAt = Date.parse(right.updatedAt);
  const leftReceivedAt = Date.parse(left.receivedAt);
  const rightReceivedAt = Date.parse(right.receivedAt);
  // Age is a question about our own timeline — "how long ago did we learn this price?" — so it is
  // measured from the local arrival stamp. Using the venue's event time made a quote from a venue
  // whose clock runs slow look old while it was seconds old in reality.
  const usableArrival = (receivedAt: number) => Number.isFinite(receivedAt)
    && now - receivedAt <= STRATEGY_MARKET_FRESHNESS_MS
    && receivedAt - now <= STRATEGY_FUTURE_QUOTE_TOLERANCE_MS;
  if (!usableArrival(leftReceivedAt) || !usableArrival(rightReceivedAt)) {
    return { pair: null, reason: 'stale' };
  }
  // Transport lag stays on the venue's clock: it is `received − source`, a network measurement that
  // has nothing to do with how stale the quote is.
  const timelyDelivery = (sourceTimestamp: number, receivedTimestamp: number) =>
    Number.isFinite(receivedTimestamp)
    && receivedTimestamp - sourceTimestamp <= STRATEGY_MARKET_MAX_TRANSPORT_LAG_MS;
  if (!timelyDelivery(leftUpdatedAt, leftReceivedAt) || !timelyDelivery(rightUpdatedAt, rightReceivedAt)) {
    return { pair: null, reason: 'delayed' };
  }
  return { pair: { left, right }, reason: null };
}

/** Mirror the backend trigger guard so stale UI prices can never look actionable. */
export function freshMarketPair(
  snapshot: MarketSnapshot | null,
  leftSymbol: string,
  rightSymbol: string,
  now = Date.now(),
): FreshMarketPair | null {
  return assessMarketPairFreshness(snapshot, leftSymbol, rightSymbol, now).pair;
}

/**
 * Venue REST may return persisted candles while a refresh is running. Treat at most the previous
 * completed interval as current, with a small transport allowance, and otherwise keep loading.
 */
export function candleTailIsFresh(
  candles: Candle[],
  interval: CandleInterval,
  now = Date.now(),
): boolean {
  const latest = candles[candles.length - 1];
  if (!latest) return false;
  return candleTimestampIsFresh(latest.startTime, interval, now);
}

export function candleTimestampIsFresh(
  startTime: number,
  interval: CandleInterval,
  now = Date.now(),
): boolean {
  const intervalMs = CANDLE_INTERVAL_MILLISECONDS[interval];
  return startTime <= now + STRATEGY_FUTURE_QUOTE_TOLERANCE_MS
    && now - startTime <= intervalMs * 2 + 5_000;
}
