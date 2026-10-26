import type { FundingOverviewResponse, SpreadLegFunding } from '@gate-crossex/shared-types';

/**
 * CrossEx perpetual symbol shape. Spot legs (`_SPOT_`) never pay funding, and neither do symbols
 * that are not perpetual contracts at all, so both resolve to "no funding rate" instead of being
 * looked up (a spot symbol can never collide with a perpetual one, but the check documents the
 * rule and keeps a future non-future product from silently reading someone else's rate).
 */
const CROSSEX_FUTURE_SYMBOL = /^[A-Z0-9]+_FUTURE_[A-Z0-9]+_(?:USDT|USDC|USD)$/;

/**
 * Current 8h-equivalent funding fraction per executable CrossEx perpetual symbol, as the venue
 * reported it (a Decimal string, e.g. `0.00013` for 0.013% per 8h).
 *
 * This is a *plain read* of the funding overview the request already built: no upstream call, no
 * clock, no allocation beyond one map. Symbols the venues published no funding for are absent —
 * which is exactly how a consumer tells "no funding" from "zero funding".
 */
export type LegFundingRateIndex = ReadonlyMap<string, string>;

/**
 * Index a funding overview by symbol. Rows whose rate is missing or unparseable are dropped so a
 * lookup never returns a value the venue did not publish; the overview's own `fundingRate8h` is
 * reused verbatim so this column and the funding board's `Per 8h` column can never disagree.
 */
export function buildLegFundingRateIndex(overview: FundingOverviewResponse): LegFundingRateIndex {
  const index = new Map<string, string>();
  for (const asset of overview.assets) {
    for (const venue of asset.venues) {
      if (venue.fundingRate8h === null) continue;
      if (!CROSSEX_FUTURE_SYMBOL.test(venue.symbol)) continue;
      if (!Number.isFinite(Number(venue.fundingRate8h))) continue;
      index.set(venue.symbol, venue.fundingRate8h);
    }
  }
  return index;
}

/**
 * Current 8h-equivalent funding fraction of one leg, or null.
 *
 * Null means "this leg has no funding rate to show" — a spot leg, a venue that publishes none, or
 * a symbol the sweep has not covered yet. It is never `0`: a zero rate is a measurement (free
 * carry) and must stay distinguishable from a missing one.
 */
export function legFundingRate8h(index: LegFundingRateIndex, symbol: string): string | null {
  if (!CROSSEX_FUTURE_SYMBOL.test(symbol)) return null;
  return index.get(symbol) ?? null;
}

/**
 * Funding the pair collects while both legs are held, in bps per 8h: `(left − right) × 10⁴`.
 *
 * Signs follow the board's orientation (left = sell leg, right = buy leg): shorting the left leg
 * collects its positive funding and holding the right leg pays its own, so a positive value is
 * net income. Null when either leg's rate is unknown — the differential of a half-known pair is
 * unknown, not zero.
 */
export function fundingRateDiffBps(
  leftFundingRate8h: string | null,
  rightFundingRate8h: string | null,
): number | null {
  if (leftFundingRate8h === null || rightFundingRate8h === null) return null;
  const left = Number(leftFundingRate8h);
  const right = Number(rightFundingRate8h);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  const diffBps = (left - right) * 10_000;
  return Number.isFinite(diffBps) ? diffBps : null;
}

/**
 * The three `SpreadLegFunding` fields of one pair, resolved in one call so every board attaches
 * the reading the same way. A leg with no rate keeps `null`; the differential then stays `null`
 * too rather than pretending the known leg is the whole story.
 */
export function spreadLegFunding(
  index: LegFundingRateIndex,
  leftSymbol: string,
  rightSymbol: string,
): Required<SpreadLegFunding> {
  const leftFundingRate8h = legFundingRate8h(index, leftSymbol);
  const rightFundingRate8h = legFundingRate8h(index, rightSymbol);
  return {
    leftFundingRate8h,
    rightFundingRate8h,
    fundingRateDiffBps: fundingRateDiffBps(leftFundingRate8h, rightFundingRate8h),
  };
}
