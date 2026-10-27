import { Decimal } from 'decimal.js';
import type { FundingRatePoint } from '@gate-crossex/public-data';
import type { FundingSettlementPoint, FundingSettlementSummary } from '@gate-crossex/shared-types';

/** Hours in a Julian-free 365-day year; every venue publishes a fixed hourly interval. */
export const HOURS_PER_YEAR = 24 * 365;

/** Default depth of the per-contract settlement strip (also the API default). */
export const DEFAULT_RECENT_SETTLEMENT_LIMIT = 8;
/** Hard cap so one request cannot ask for a symbol's entire retained history. */
export const MAX_RECENT_SETTLEMENT_LIMIT = 24;

/**
 * Number of settlements one year holds at a venue's interval. Funding is charged once per
 * interval, so the count is `365 × 24 / intervalHours`:
 * 8h → 1095, 4h → 2190, 1h → 8760.
 *
 * Returns null — not 0 — when the interval is unknown, because an unknown interval must
 * never be annualized as if it were 8h (that would silently misprice 4h and 1h venues).
 */
export function fundingPeriodsPerYear(intervalHours: number | null): number | null {
  if (intervalHours === null || !Number.isFinite(intervalHours) || intervalHours <= 0) return null;
  return HOURS_PER_YEAR / intervalHours;
}

/**
 * Parse a decimal string without throwing. `decimal.js` raises on malformed input, and a single
 * corrupt rate must degrade to "unknown" (rendered as "—") instead of failing the whole request.
 */
function toFiniteDecimal(value: string): Decimal | null {
  const trimmed = value.trim();
  if (trimmed === '' || !Number.isFinite(Number(trimmed))) return null;
  try {
    const decimal = new Decimal(trimmed);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

/**
 * Annualize the rate charged once per the venue's own settlement interval:
 *
 *   APR = rate × (24 / intervalHours) × 365
 *       = rate × 1095   for 8h venues
 *       = rate × 2190   for 4h venues
 *       = rate × 8760   for 1h venues
 *
 * `rate` is the native fraction per interval (0.0001 = 1 bp per settlement) and the result is
 * the same fraction per year (0.1095 = +10.95%/y for a 1 bp 8h rate). Null propagates so a
 * missing rate or interval renders as "—" instead of a fabricated zero.
 */
export function annualizeFundingRate(rate: string | null, intervalHours: number | null): string | null {
  const periods = fundingPeriodsPerYear(intervalHours);
  if (periods === null || rate === null) return null;
  const native = toFiniteDecimal(rate);
  if (!native) return null;
  return native.times(periods).toString();
}

/**
 * Keep the last `limit` settlements in chronological order. `points` is expected ascending
 * (the repository reads `ORDER BY funding_time`); the sort is defensive because callers also
 * pass aggregates assembled in memory. No points means an empty array — never a zero row.
 */
export function selectRecentSettlements(
  points: readonly FundingRatePoint[],
  limit: number,
): FundingSettlementPoint[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
  if (safeLimit === 0 || points.length === 0) return [];
  const ordered = [...points].sort((left, right) => left.timestamp - right.timestamp);
  return ordered.slice(Math.max(0, ordered.length - safeLimit)).map((point) => ({
    timestamp: point.timestamp,
    rate: point.rate,
  }));
}

export interface RecentSettlementStats {
  recent: FundingSettlementPoint[];
  /** Mean of `recent`, or null when nothing is cached. */
  recentMeanRate: string | null;
  /** Newest settled rate, or null when nothing is cached. */
  latestRate: string | null;
  latestSettledAt: string | null;
  settlementCount: number;
}

/** Aggregate the trailing settlements of one symbol. Empty history yields nulls, not zeros. */
export function summarizeRecentSettlements(
  points: readonly FundingRatePoint[],
  limit: number,
): RecentSettlementStats {
  const recent = selectRecentSettlements(points, limit);
  const newest = recent[recent.length - 1];
  if (!newest) {
    return { recent, recentMeanRate: null, latestRate: null, latestSettledAt: null, settlementCount: 0 };
  }
  let total = new Decimal(0);
  let counted = 0;
  for (const point of recent) {
    const rate = toFiniteDecimal(point.rate);
    if (!rate) continue;
    total = total.plus(rate);
    counted += 1;
  }
  return {
    recent,
    recentMeanRate: counted > 0 ? total.dividedBy(counted).toString() : null,
    latestRate: newest.rate,
    latestSettledAt: new Date(newest.timestamp).toISOString(),
    settlementCount: points.length,
  };
}

/** Live (unsettled) side of one contract, resolved from the funding overview cache. */
export interface LiveFundingQuote {
  currentRate: string | null;
  intervalHours: number | null;
  nextFundingAt: string | null;
  fetchedAt: string | null;
}

export interface FundingSettlementSummaryInput {
  symbol: string;
  /** Every cached settlement for the symbol, ascending. */
  points: readonly FundingRatePoint[];
  limit: number;
  /** Null when the venue row is unknown, which also makes the live columns null. */
  live: LiveFundingQuote | null;
}

/**
 * Join the persisted settlement tail with the live quote into one row. `status` is `ok` as soon
 * as either side has data and `unavailable` only when both are missing, so a contract that is
 * priced live but has no cached history still renders its live rate with an explicit empty
 * settlement strip.
 */
export function buildFundingSettlementSummary(
  input: FundingSettlementSummaryInput,
): FundingSettlementSummary {
  const stats = summarizeRecentSettlements(input.points, input.limit);
  const intervalHours = input.live?.intervalHours ?? null;
  const currentRate = input.live?.currentRate ?? null;
  const hasAnyData = currentRate !== null || intervalHours !== null || stats.recent.length > 0;
  return {
    symbol: input.symbol,
    status: hasAnyData ? 'ok' : 'unavailable',
    intervalHours,
    currentRate,
    currentAnnualizedRate: annualizeFundingRate(currentRate, intervalHours),
    nextFundingAt: input.live?.nextFundingAt ?? null,
    recent: stats.recent,
    recentMeanRate: stats.recentMeanRate,
    latestRate: stats.latestRate,
    latestSettledAt: stats.latestSettledAt,
    settlementCount: stats.settlementCount,
    fetchedAt: input.live?.fetchedAt ?? null,
  };
}
