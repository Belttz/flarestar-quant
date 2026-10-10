import type {
  FundingOverviewResponse,
  LiveMarket,
  OpportunityMarketStats,
} from '@gate-crossex/shared-types';

/**
 * 24h volume / open interest lookup for the opportunity boards.
 *
 * Upstream publishes these numbers piecemeal, so the board resolves them through a fixed
 * degradation chain (architecture §1.2 D3) and never fabricates a value — anything missing stays
 * `null`, which the UI renders as `—`:
 *
 *   1. the merged full-market view (hub WebSocket rows first, bulk REST bookTicker rows filling
 *      every unsubscribed symbol) carries `volume24h` / `quoteVolume24h` / `openInterest*`
 *   2. the cached funding-overview sweep supplies a USD open-interest value per (asset, venue)
 *      for every perpetual — this is what covers venues whose REST row has no OI (Gate) and the
 *      symbols nobody subscribed to
 *   3. nothing else: Binance's bookTicker feed omits volume, so the venue's 24h ticker endpoint is
 *      swept alongside it and merged onto those REST rows by the public-data client; open
 *      interest has no bulk source on Binance at all and stays empty
 *
 * Spot legs never carry open interest — that is a definition, not a gap, so it is forced to
 * `null` rather than left to chance.
 */

/** CrossEx symbol shapes, mirroring the opportunity board's own pairing rules. */
const CROSSEX_SPOT_SYMBOL = /^[A-Z0-9]+_SPOT_[A-Z0-9]+_(USDT|USDC|USD)$/;
const CROSSEX_FUTURE_SYMBOL = /^[A-Z0-9]+_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/;

/** Everything missing: the board renders an all-null stats object as a column of `—`. */
export const EMPTY_MARKET_STATS: Readonly<OpportunityMarketStats> = Object.freeze({
  volume24h: null,
  quoteVolume24h: null,
  openInterest: null,
  openInterestValue: null,
});

/** True when a CrossEx symbol names a spot listing (the only business line without open interest). */
export function isSpotSymbol(symbol: string): boolean {
  return CROSSEX_SPOT_SYMBOL.test(symbol);
}

/** True when a CrossEx symbol names a perpetual listing. */
export function isFutureSymbol(symbol: string): boolean {
  return CROSSEX_FUTURE_SYMBOL.test(symbol);
}

/**
 * Normalise an upstream Decimal amount. `'0'`, blank text and unparseable text all mean "no
 * data" (architecture §7.5) — a zero would otherwise look like a real measurement.
 */
export function normalizeAmount(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '0') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  // Keep the upstream text so large turnover figures do not drift through a float round-trip.
  return trimmed;
}

/** Copy a stats object with every amount normalised (zero and junk become null). */
function statsFromMarket(market: LiveMarket): OpportunityMarketStats {
  return {
    volume24h: normalizeAmount(market.volume24h),
    quoteVolume24h: normalizeAmount(market.quoteVolume24h),
    openInterest: normalizeAmount(market.openInterest),
    openInterestValue: normalizeAmount(market.openInterestValue),
  };
}

/**
 * Index the merged full-market view by CrossEx symbol so resolving one board row is a single map
 * lookup. Hub rows win over REST rows upstream (they are merged before this point), so a symbol
 * appears exactly once here.
 */
export function buildMarketStatsIndex(
  markets: readonly LiveMarket[],
): ReadonlyMap<string, OpportunityMarketStats> {
  const index = new Map<string, OpportunityMarketStats>();
  for (const market of markets) {
    const stats = statsFromMarket(market);
    const existing = index.get(market.symbol);
    // Prefer the richer of two rows for the same symbol: a live hub row that only carries prices
    // must not shadow a REST row that actually has volume.
    if (existing === undefined || rankStats(stats) > rankStats(existing)) index.set(market.symbol, stats);
  }
  return index;
}

/** Rough completeness score: how many of the four amounts a stats object actually carries. */
function rankStats(stats: OpportunityMarketStats): number {
  return Number(stats.volume24h !== null)
    + Number(stats.quoteVolume24h !== null)
    + Number(stats.openInterest !== null)
    + Number(stats.openInterestValue !== null);
}

/**
 * Index the funding-overview sweep by `ASSET:VENUE` for the open-interest fallback.
 *
 * The overview is the only bulk OI source that covers every connected perpetual venue, including
 * the ones whose REST ticker row carries no open interest. BINANCE publishes no bulk OI at all,
 * so it simply has no entry here.
 */
export function buildOpenInterestIndex(
  overview: FundingOverviewResponse | null | undefined,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const assetEntry of overview?.assets ?? []) {
    for (const venueEntry of assetEntry.venues) {
      const value = normalizeAmount(venueEntry.openInterestValue);
      if (value === null) continue;
      index.set(openInterestKey(assetEntry.asset, venueEntry.venue), value);
    }
  }
  return index;
}

/** Cache key of the open-interest fallback index. */
export function openInterestKey(asset: string, venue: string): string {
  return `${asset.toUpperCase()}:${venue.toUpperCase()}`;
}

/**
 * Resolve the stats of one board leg.
 *
 * `symbol` may be a spot or a perpetual symbol; spot legs get their open interest cleared. When
 * the merged view has no row (or its row carries no OI) the funding-overview value is used for
 * perpetuals, which is what keeps the column populated for unsubscribed symbols.
 */
export function resolveStats(
  symbol: string,
  asset: string,
  venue: string,
  index: ReadonlyMap<string, OpportunityMarketStats>,
  openInterestByAssetVenue: ReadonlyMap<string, string>,
): OpportunityMarketStats {
  const direct = index.get(symbol);
  if (isSpotSymbol(symbol)) {
    // A spot listing has no open interest by definition; volume still applies.
    return {
      volume24h: direct?.volume24h ?? null,
      quoteVolume24h: direct?.quoteVolume24h ?? null,
      openInterest: null,
      openInterestValue: null,
    };
  }
  if (!isFutureSymbol(symbol)) return { ...EMPTY_MARKET_STATS };
  const fallbackOi = openInterestByAssetVenue.get(openInterestKey(asset, venue)) ?? null;
  return {
    volume24h: direct?.volume24h ?? null,
    quoteVolume24h: direct?.quoteVolume24h ?? null,
    openInterest: direct?.openInterest ?? null,
    openInterestValue: direct?.openInterestValue ?? fallbackOi,
  };
}

/** Larger of two optional Decimal amounts, used to rank a two-legged spread row. */
export function maxAmount(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Number(left) >= Number(right) ? left : right;
}
