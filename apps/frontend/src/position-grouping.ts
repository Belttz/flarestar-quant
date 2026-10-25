import { canonicalMarketAsset, type ResidualReport } from '@gate-crossex/shared-types';

const PREMIUM_PAIR_ASSETS = new Set(['SKHY', 'SKHYNIX']);

export function canonicalPositionAsset(asset: string, venue: string): string {
  return canonicalMarketAsset(venue, 'FUTURE', asset);
}

/** SKHY (ADR) and SKHYNIX (local listing) form one premium-strategy position group. */
export function positionGroupKey(asset: string, venue: string): string {
  const canonicalAsset = canonicalPositionAsset(asset, venue);
  return PREMIUM_PAIR_ASSETS.has(canonicalAsset) ? 'SKHY-SKHYNIX' : canonicalAsset;
}

export function positionGroupLabel(assets: readonly string[]): string {
  const uniqueAssets = new Set(assets);
  return uniqueAssets.has('SKHY') && uniqueAssets.has('SKHYNIX')
    ? 'SKHY / SKHYNIX'
    : assets[0] ?? '';
}

/**
 * The set of leg symbols a close-verify report still flags as holding a residual (R11). The
 * backend lists only residuals above the smallest orderable unit — dust is never auto-liquidated
 * and never listed — so an absent symbol means "fully closed or dust-only".
 */
export function residualSymbolsFromReport(report: Pick<ResidualReport, 'residuals'> | null | undefined): ReadonlySet<string> {
  return new Set((report?.residuals ?? []).map((leg) => leg.symbol));
}

/**
 * Whether a position group is fully settled after a close plan (R11): none of its legs appears
 * in the verify report's residual list, so the whole group folds into the closed state instead
 * of lingering as a zombie group over a dust-only remnant. A missing report settles nothing —
 * absence of evidence is not evidence of closure.
 */
export function positionGroupIsSettled(
  legSymbols: readonly string[],
  report: Pick<ResidualReport, 'residuals'> | null | undefined,
): boolean {
  if (report === null || report === undefined) return false;
  const residualSymbols = residualSymbolsFromReport(report);
  return legSymbols.every((symbol) => !residualSymbols.has(symbol));
}
