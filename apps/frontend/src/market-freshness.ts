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

export type SpreadQuoteAlignment =
  | { aligned: true; skewMs: number }
  | { aligned: false; skewMs: number | null; reason: 'missing_quote_timestamp' | 'skew_exceeded' };

/**
 * Judge whether two legs' executable quotes come from (roughly) the same moment. The only
 * admissible timestamp is `quoteUpdatedAt` — the field the engine's `freshMarketPair` gate reads —
 * so this check is same-source with execution by construction. A leg without a quote timestamp
 * never carried a quote and is never aligned.
 */
export function assessSpreadQuoteAlignment(
  left: Pick<LiveMarket, 'quoteUpdatedAt'>,
  right: Pick<LiveMarket, 'quoteUpdatedAt'>,
  maxSkewMs = SPREAD_QUOTE_MAX_SKEW_MS,
): SpreadQuoteAlignment {
  const leftMs = left.quoteUpdatedAt === undefined ? NaN : Date.parse(left.quoteUpdatedAt);
  const rightMs = right.quoteUpdatedAt === undefined ? NaN : Date.parse(right.quoteUpdatedAt);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
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
  const usableTimestamp = (timestamp: number) => Number.isFinite(timestamp)
    && now - timestamp <= STRATEGY_MARKET_FRESHNESS_MS
    && timestamp - now <= STRATEGY_FUTURE_QUOTE_TOLERANCE_MS;
  if (!usableTimestamp(leftUpdatedAt) || !usableTimestamp(rightUpdatedAt)) {
    return { pair: null, reason: 'stale' };
  }
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
