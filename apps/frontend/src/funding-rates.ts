export interface AverageFundingRate {
  rate: number | null;
  venueCount: number;
}

export type CurrentFundingMetric = 'Per interval' | 'APR';

/** Scale a native percentage to a comparable 8h percentage. */
export function fundingPercentScaledTo8h(rate: number | null, intervalHours: number | null): number | null {
  if (rate === null || !Number.isFinite(rate) || intervalHours === null || !Number.isFinite(intervalHours) || intervalHours <= 0) {
    return null;
  }
  return rate * (8 / intervalHours);
}

/** The venue cell shows an actual payment; APR is derived from the comparable 8h rate. */
export function currentFundingMetricRate(
  nativeRate: number | null,
  rate8h: number | null,
  metric: CurrentFundingMetric,
): number | null {
  if (metric === 'Per interval') return nativeRate;
  return rate8h === null ? null : rate8h * 1095;
}

/** Average/spread calculations must use the same time basis across venues. */
export function currentFundingComparisonRate(rate8h: number | null, metric: CurrentFundingMetric): number | null {
  if (rate8h === null) return null;
  return metric === 'APR' ? rate8h * 1095 : rate8h;
}

/**
 * Build an identity for a set of funding-history symbols. Sorting prevents
 * live market reordering from restarting the same page-wide history load.
 */
export function fundingHistoryRequestKey(symbols: ReadonlyArray<string>): string {
  return [...new Set(symbols)].sort().join('|');
}

/** Keep an explicitly applied sort stable while refreshed row values arrive. */
export function applyFundingAssetOrder<T extends { asset: string }>(
  rows: ReadonlyArray<T>,
  order: ReadonlyArray<string>,
): T[] {
  const rank = new Map(order.map((asset, index) => [asset, index]));
  return [...rows].sort((left, right) => {
    const leftRank = rank.get(left.asset) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.asset) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.asset.localeCompare(right.asset);
  });
}

/** Convert an already-summed realized funding fraction to the percentage shown in the table. */
export function cumulativeFundingPercent(rate: string | null): number | null {
  if (rate === null || rate.trim() === '') return null;
  const value = Number(rate) * 100;
  return Number.isFinite(value) ? value : null;
}

/**
 * Average the normalized funding rates for selected venues where the asset is
 * tradable and a funding quote is available.
 */
export function averageAvailableFundingRate(
  rates: ReadonlyArray<number | null>,
  listed: ReadonlyArray<boolean>,
  venueIndexes: ReadonlyArray<number>,
): AverageFundingRate {
  let total = 0;
  let venueCount = 0;

  for (const index of venueIndexes) {
    const rate = rates[index];
    if (!listed[index] || rate === null || !Number.isFinite(rate)) continue;
    total += rate;
    venueCount += 1;
  }

  return {
    rate: venueCount > 0 ? total / venueCount : null,
    venueCount,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Per-contract settlement board helpers.
 *
 * The board answers one trading question — "if I enter now, what does funding pay me, how often,
 * and what has it actually charged lately?" — so everything here is per settlement. No helper
 * accepts or produces a running total.
 * ---------------------------------------------------------------------------------------------- */

/** Hours in a 365-day year; the annualization factor divides this by the venue interval. */
export const FUNDING_HOURS_PER_YEAR = 24 * 365;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Convert an API fraction (0.0001) into the percentage this page renders (0.01). */
export function fundingFractionToPercent(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const fraction = Number(value);
  return Number.isFinite(fraction) ? fraction * 100 : null;
}

/**
 * Colour intent of one funding rate from the payer's point of view, following the convention of
 * Chinese trading terminals rather than Western PnL colouring: a positive rate is charged to
 * longs, so it is a cost and reads red; a negative rate is paid to longs and reads green.
 */
export type FundingSettlementTone = 'pay' | 'earn' | 'flat';

export function fundingSettlementTone(ratePercent: number | null): FundingSettlementTone {
  if (ratePercent === null || !Number.isFinite(ratePercent) || ratePercent === 0) return 'flat';
  // A rate that rounds to 0.0000% at display precision must not be painted as a cost.
  if (Math.abs(ratePercent) < 0.00005) return 'flat';
  return ratePercent > 0 ? 'pay' : 'earn';
}

/** `8h`, `4h`, `1h` — null when the venue did not publish an interval. */
export function fundingIntervalLabel(hours: number | null): string | null {
  if (hours === null || !Number.isFinite(hours) || hours <= 0) return null;
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`;
}

/** Annualization multiplier shown next to the APR (`×1095` for an 8h venue). */
export function fundingAnnualizationFactor(hours: number | null): number | null {
  if (hours === null || !Number.isFinite(hours) || hours <= 0) return null;
  return FUNDING_HOURS_PER_YEAR / hours;
}

/** Milliseconds left until the next settlement, or null when the venue published no time. */
export function fundingSettlementCountdown(nextFundingAt: string | null, now: number): number | null {
  if (!nextFundingAt) return null;
  const timestamp = Date.parse(nextFundingAt);
  if (!Number.isFinite(timestamp)) return null;
  return timestamp - now;
}

/**
 * Compact countdown: `2d 03h` above a day, `4h 34m` above an hour, `34:46` inside the last hour.
 * Null stays null so the cell can render "—" instead of a misleading `00:00`; an elapsed target
 * clamps to `00:00` because the next settlement is then imminent, not unknown.
 */
export function formatFundingCountdown(remainingMs: number | null): string | null {
  if (remainingMs === null || !Number.isFinite(remainingMs)) return null;
  if (remainingMs <= 0) return '00:00';
  const days = Math.floor(remainingMs / DAY_MS);
  const hours = Math.floor((remainingMs % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((remainingMs % HOUR_MS) / 60_000);
  const seconds = Math.floor((remainingMs % 60_000) / 1_000);
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Largest absolute settlement rate of a strip, used as the shared bar scale so one row's spike
 * does not visually dwarf every other row. Floors at a tiny epsilon so an all-zero strip still
 * renders flat bars instead of dividing by zero.
 */
export function fundingSettlementBarScale(rates: ReadonlyArray<number | null>): number {
  let scale = 0;
  for (const rate of rates) {
    if (rate === null || !Number.isFinite(rate)) continue;
    scale = Math.max(scale, Math.abs(rate));
  }
  return scale > 0 ? scale : 1e-9;
}

/** Bar height percentage (0–100) for one settlement inside a strip scaled by `scale`. */
export function fundingSettlementBarHeight(rate: number | null, scale: number): number {
  if (rate === null || !Number.isFinite(rate)) return 0;
  const safeScale = scale > 0 ? scale : 1e-9;
  return Math.min(100, Math.max(6, (Math.abs(rate) / safeScale) * 100));
}

/** Sortable projection of one board row; the view supplies the rest of its display fields. */
export interface FundingBoardSortable {
  asset: string;
  symbol: string;
  /** Pair funding spread normalized to an 8h basis, in percent. */
  spreadPercent?: number | null;
  /** Native live rate of the row's reference leg, in percent per interval. */
  currentRatePercent?: number | null;
  /** Live rate annualized on the row's own interval, as a percentage. */
  annualizedPercent?: number | null;
  /** Newest settled rate of the reference leg, in percent. */
  latestSettledPercent?: number | null;
  nextFundingAt: string | null;
  openInterest: number;
}

export type FundingBoardSortKey = 'apr' | 'spread' | 'current' | 'latest' | 'next' | 'oi';

/**
 * Order board rows by one column. Unknown values always sink to the bottom whatever the
 * direction — a contract without an APR must not head a "highest APR" list — and ties fall back
 * to the contract identity so the order stays stable between polls.
 */
export function sortFundingBoardRows<T extends FundingBoardSortable>(
  rows: ReadonlyArray<T>,
  key: FundingBoardSortKey,
  direction: 'asc' | 'desc',
): T[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  const finite = (value: number | null | undefined): number | null =>
    value === null || value === undefined || !Number.isFinite(value) ? null : value;
  const valueOf = (row: T): number | null => {
    if (key === 'apr') return finite(row.annualizedPercent);
    if (key === 'spread') return finite(row.spreadPercent);
    if (key === 'current') return finite(row.currentRatePercent);
    if (key === 'latest') return finite(row.latestSettledPercent);
    if (key === 'oi') return row.openInterest > 0 ? row.openInterest : null;
    const timestamp = row.nextFundingAt ? Date.parse(row.nextFundingAt) : Number.NaN;
    return Number.isFinite(timestamp) ? timestamp : null;
  };
  return [...rows].sort((left, right) => {
    const leftValue = valueOf(left);
    const rightValue = valueOf(right);
    if (leftValue === null && rightValue === null) return left.symbol.localeCompare(right.symbol);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return (leftValue - rightValue) * multiplier
      || left.asset.localeCompare(right.asset)
      || left.symbol.localeCompare(right.symbol);
  });
}

/* ------------------------------------------------------------------------------------------------
 * Two-leg pairing.
 *
 * Funding arbitrage is always a pair: you hold one leg long and one leg short on the same asset,
 * and the funding you keep is the difference between what the two venues charge. A single-leg
 * rate table cannot answer "which two venues should I open between", which is why the board is
 * built from combinations.
 * ---------------------------------------------------------------------------------------------- */

/** One tradable leg of a pair, in the shape the pairing helper needs. */
export interface FundingPairLeg {
  /** `<VENUE>:<symbol>` — unique per venue contract. */
  key: string;
  venue: string;
  /** Native rate per the venue's own settlement interval, in percent. */
  ratePercent: number | null;
  /** Same rate normalized to an 8h basis, in percent. */
  rate8hPercent: number | null;
  intervalHours: number | null;
}

export interface FundingLegPair<T extends FundingPairLeg> {
  /** Leg to buy: the venue paying longs (lowest rate). */
  long: T;
  /** Leg to sell: the venue charging longs (highest rate). */
  short: T;
  /** `shortRate8h − longRate8h`, always ≥ 0: the funding kept per 8h equivalent, in percent. */
  spread8hPercent: number;
}

/**
 * Every two-venue combination of one asset, direction included.
 *
 * Legs are paired only when both sides publish a rate *and* an interval: without an interval a
 * leg cannot be normalized, and subtracting a per-8h rate from a per-1h rate would overstate the
 * spread eightfold. Normalizing both legs to 8h before subtracting keeps a 1h-vs-8h pair
 * comparable with an 8h-vs-8h one.
 *
 * The direction is decided by the rates: long the lower (or negative) side, short the higher
 * (or positive) side, so the pair collects `short − long` every settlement.
 */
export function pairFundingLegs<T extends FundingPairLeg>(legs: ReadonlyArray<T>): Array<FundingLegPair<T>> {
  const eligible = legs.filter((leg) =>
    leg.ratePercent !== null && Number.isFinite(leg.ratePercent)
    && leg.rate8hPercent !== null && Number.isFinite(leg.rate8hPercent)
    && leg.intervalHours !== null && Number.isFinite(leg.intervalHours) && leg.intervalHours > 0);
  const pairs: Array<FundingLegPair<T>> = [];
  for (let left = 0; left < eligible.length; left += 1) {
    for (let right = left + 1; right < eligible.length; right += 1) {
      const first = eligible[left];
      const second = eligible[right];
      if (!first || !second) continue;
      const firstRate = first.rate8hPercent as number;
      const secondRate = second.rate8hPercent as number;
      // Equal rates still form a pair (spread 0) — hiding it would make the venue combination
      // silently disappear from the board instead of showing a flat, unfavourable pair.
      const long = firstRate <= secondRate ? first : second;
      const short = firstRate <= secondRate ? second : first;
      pairs.push({
        long,
        short,
        spread8hPercent: Math.abs(secondRate - firstRate),
      });
    }
  }
  return pairs;
}

/**
 * Annualize a pair spread that has already been normalized to an 8h basis:
 *
 *   APR = spread8h × (24 / 8) × 365 = spread8h × 1095
 *
 * Same formula as a single contract's annualization, evaluated at the 8h comparison basis so a
 * 1h-vs-8h pair and an 8h-vs-8h pair land on the same scale. Null in, null out — never 0.
 */
export function fundingPairAnnualizedPercent(spread8hPercent: number | null): number | null {
  const factor = fundingAnnualizationFactor(8);
  if (factor === null || spread8hPercent === null || !Number.isFinite(spread8hPercent)) return null;
  return spread8hPercent * factor;
}


