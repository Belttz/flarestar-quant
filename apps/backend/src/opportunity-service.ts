import {
  classifyAssetCached,
  matchesAssetClassFilter,
  matchesPreIpoFilter,
  type AssetClass,
  type AssetClassification,
  type AssetSuperClass,
  type FundingOpportunity,
  type FundingOverviewResponse,
  type MarketCatalogVenue,
  type OpportunityMarketStats,
  type OpportunityResponse,
  type PreIpoFilterMode,
  type SpreadOpportunity,
} from '@gate-crossex/shared-types';
import type { LiveMarket, MarketDefinition } from './market-hub.js';
import {
  buildMarketStatsIndex,
  buildOpenInterestIndex,
  maxAmount,
  resolveStats,
} from './opportunity-market-stats.js';

/** Subset of FundingOverviewService the board reuses for its funding-rates data source. */
export interface OpportunityFundingView {
  ensureFresh(): Promise<void>;
  buildResponse(catalog: OpportunityCatalogView): FundingOverviewResponse;
}

export interface OpportunityCatalogView {
  assets: ReadonlyMap<string, MarketCatalogVenue[]>;
}

/** Subset of CrossExMarketHub used for on-demand spot registrations while resolving hedge legs. */
export interface OpportunityMarketHubView {
  market(symbol: string): LiveMarket | null;
  ensureMarkets(definitions: MarketDefinition[]): boolean;
}

export interface OpportunityDependencies {
  fundingOverview: OpportunityFundingView;
  hub: OpportunityMarketHubView;
  /**
   * Full-market quote view behind the spread board: hub live prices win, and rows synthesized
   * from the venues' bulk REST bookTicker sweeps fill every symbol nobody subscribed to. The
   * CrossEx hub alone is browsing-dependent (WS caps subscriptions), so the board must scan
   * this merged view instead of the raw hub snapshot.
   */
  spreadMarkets: () => Promise<ReadonlyArray<LiveMarket>>;
  /**
   * Executable spot symbols across every connected venue, grouped by canonical asset and ordered
   * by CATALOG_VENUES then preferred quote. Assets absent from the map have no connected spot leg.
   */
  spotSymbolsByAsset: () => ReadonlyMap<string, readonly SpotSymbolEntry[]>;
}

/** One executable spot symbol plus the venue that lists it, grouped by canonical asset. */
export interface SpotSymbolEntry {
  venue: string;
  symbol: string;
}

/** The two spread shapes the board builds: a spot leg against a perpetual, or two perpetuals. */
export type SpreadPairType = SpreadOpportunity['pairType'];

/** Column the board can be sorted by; `default` defers to the board's own ranking. */
export type OpportunitySortKey = 'spread' | 'apr' | 'volume' | 'oi' | 'asset' | 'default';

/** Sort direction; `desc` matches every board's historical ranking. */
export type SortDirection = 'asc' | 'desc';

/** Volume / open-interest lookups shared by both boards, built once per request. */
export interface OpportunityStatsSources {
  statsIndex: ReadonlyMap<string, OpportunityMarketStats>;
  openInterestByAssetVenue: ReadonlyMap<string, string>;
}

export interface OpportunityFilters {
  funding: boolean;
  spread: boolean;
  /** Minimum absolute funding APR in percent; only applies to the funding board. */
  minApr?: number;
  /** Minimum signed spread in bps; only applies to the spread board. */
  minBps?: number;
  /** Exact canonical asset match (case handled by the endpoint). */
  asset?: string;
  /**
   * Venue whitelist for the spread board, in uppercase venue ids. An empty list (or an absent
   * one) means "every venue": both legs of a row must sit inside the whitelist, so a pair
   * spanning a deselected exchange never reaches the board.
   */
  venues?: readonly string[];
  /**
   * Pair-type whitelist for the spread board. An empty list (or an absent one) means every
   * shape; `['SPOT_PERP']` keeps rows with a spot leg and `['PERP_PERP']` keeps perpetual-only
   * rows.
   */
  pairTypes?: readonly SpreadPairType[];
  /**
   * Fine-grained asset-class whitelist (`STOCK`, `COIN`, …). Empty or absent means every class.
   * Applied while rows are built — never after the row cap — so the board cannot end up a
   * filtered slice of the top rows (architecture §1.2 D2).
   */
  assetClasses?: readonly AssetClass[];
  /** Super-class whitelist (`RWA` / `CRYPTO`); applied together with `assetClasses`. */
  assetSuperClasses?: readonly AssetSuperClass[];
  /** Three-state pre-IPO switch; defaults to `all`, which never hides a row. */
  preIpo?: PreIpoFilterMode;
  /** Sort column; `default` keeps the board's own ranking (funding: APR, spread: spread bps). */
  sort?: OpportunitySortKey;
  /** Sort direction; defaults to `desc`. */
  dir?: SortDirection;
  /** First row to return, used with `limit` for server-side paging. */
  offset?: number;
  /** Page size. */
  limit: number;
  /**
   * Funding board granularity: false (default) collapses to one row per (asset, perpetual venue)
   * using the preferred spot venue; true expands to one row per (asset, spot venue, perpetual
   * venue) combination.
   */
  expand?: boolean;
}

export interface OpportunityServiceOptions {
  now?: () => number;
  /** GATE spot symbols a single request may newly register on the hub (architecture §7.4). */
  spotRegistrationBudget?: number;
  /**
   * How long a computed board is reused. Building both boards pairs thousands of markets and walks
   * the full funding overview, so answering every page-open (and every filter keystroke) from
   * scratch is wasteful; 30s also matches the REST book-ticker view's own TTL, so a cached board is
   * never staler than the prices underneath it would have been anyway.
   */
  cacheTtlMs?: number;
  /** Cache capacity. Paging through many filter combinations must not grow the map without bound. */
  cacheMaxEntries?: number;
  /**
   * Max |leftQuoteUpdatedAt − rightQuoteUpdatedAt| (ms) still treated as "the same moment" when a
   * spread row is built (R4). Mirrors the strategy engine's `marketPairMaxSkewMs` so the displayed
   * spread and the executable spread share one alignment yardstick. Default 2000.
   */
  spreadQuoteMaxSkewMs?: number;
}

interface CacheEntry {
  key: string;
  expiresAt: number;
  promise: Promise<OpportunityBoardRows>;
}

/** The complete row set of both boards for one filter combination, before paging. */
export interface OpportunityBoardRows {
  funding: FundingOpportunity[];
  spread: SpreadOpportunity[];
  fetchedAt: string;
  cacheStatus: OpportunityResponse['cacheStatus'];
}

const SPOT_REGISTRATION_BUDGET_PER_REQUEST = 50;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_CACHE_MAX_ENTRIES = 64;
/** Default leg-to-leg quote-skew budget (ms); mirrors the strategy engine's freshMarketPair gate. */
export const DEFAULT_SPREAD_QUOTE_MAX_SKEW_MS = 2_000;
/** Annualization of the 8h-equivalent funding fraction, in percent: |rate8h| × 3 × 365 × 100. */
const ANNUALIZATION_FACTOR = 3 * 365 * 100;
const CROSSEX_ANY_SPOT_SYMBOL = /^[A-Z0-9]+_SPOT_[A-Z0-9]+_(USDT|USDC)$/;
const CROSSEX_FUTURE_SYMBOL = /^[A-Z0-9]+_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/;
/** Rates whose Decimal text does not parse as a number are treated as missing data. */
function fundingAprFromRate8h(rate8h: string): number {
  return Math.abs(Number(rate8h)) * ANNUALIZATION_FACTOR;
}

/**
 * Settlement family a quote currency belongs to, used to decide which legs may be paired.
 *
 * Kraken is the only connected venue that settles its perpetuals in **cash USD** while everyone
 * else quotes stablecoins. Keying pairs on the literal quote therefore stranded Kraken in a
 * singleton group forever — it could never form a single opportunity against another exchange,
 * despite carrying strategies already trading its USD perpetual leg. USD and USDT are both
 * dollar settlement (USDT being the dollar token the rest of the venue set uses), so USD joins
 * the USDT family. USDC deliberately does **not**: it is a separate token with its own peg, and
 * folding it in would inject its basis into every row, so the existing "no USDT ⇄ USDC pairs"
 * guarantee stays exactly as it was.
 */
function quoteFamily(quote: string): string {
  return quote === 'USD' ? 'USDT' : quote;
}

function validQuote(price: string | undefined): boolean {
  if (price === undefined) return false;
  const parsed = Number(price);
  return Number.isFinite(parsed) && parsed > 0;
}

/**
 * Parse a Decimal amount for ordering. Zero and unparseable text are "no data": rows without the
 * measurement must never rank by it, so they sort last in both directions.
 */
function sortableAmount(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/** Compare two optional amounts with the "null sorts last, in both directions" convention. */
function compareAmounts(left: number | null, right: number | null, dir: SortDirection): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return dir === 'asc' ? left - right : right - left;
}

function compareText(left: string, right: string, dir: SortDirection): number {
  return dir === 'asc' ? left.localeCompare(right) : right.localeCompare(left);
}

/**
 * Ranked opportunity boards behind GET /api/opportunities.
 *
 * The funding board reuses FundingOverviewService's cached sweep: every catalog row with a known
 * 8h rate becomes a ranked carry opportunity — one row per (asset, spot venue, perpetual venue)
 * combination when expanded, otherwise one collapsed row per (asset, perpetual venue) with the
 * preferred spot venue — and the row's preferred spot hedge leg is registered on the market hub
 * on demand within a per-request budget so the row can be executed by the carry strategy. The
 * spread board scans the merged full-market view (hub live prices first, bulk REST bookTicker
 * rows filling every unsubscribed symbol) for same-asset,
 * same-quote SPOT_PERP and PERP_PERP pairs and reports the best orientation per pair, with
 * left = sell leg and right = buy leg (matching the engine's spread = sellBid − buyAsk). Pairs
 * whose quotes are missing or zero (pending registrations) and cross-quote pairs (USDT vs USDC)
 * are never listed.
 *
 * Asset-class, pre-IPO, sort and paging are all resolved server side: filtering happens while the
 * rows are built (before any cap is applied) and the response reports `totals` so the UI can
 * render real page numbers instead of paging inside the window it happened to receive.
 *
 * Boards are computed at most once per 30s per distinct filter set (`cacheTtlMs`): opening the
 * page, flipping back to it, or changing pages reuses the last result instead of re-pairing every
 * market. Concurrent identical requests share one computation (single-flight), and paging
 * parameters are excluded from the cache key because they only slice an already-complete row set.
 */
export class OpportunityService {
  private readonly now: () => number;
  private readonly spotRegistrationBudget: number;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly spreadQuoteMaxSkewMs: number;
  /** Cached boards keyed by filter set; `Map` insertion order doubles as the eviction order. */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly deps: OpportunityDependencies,
    options: OpportunityServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.spotRegistrationBudget = options.spotRegistrationBudget ?? SPOT_REGISTRATION_BUDGET_PER_REQUEST;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    this.cacheMaxEntries = Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES);
    this.spreadQuoteMaxSkewMs = options.spreadQuoteMaxSkewMs ?? DEFAULT_SPREAD_QUOTE_MAX_SKEW_MS;
  }

  /** Cold funding sweeps are awaited; spread data comes from the merged full-market view. */
  async list(catalog: OpportunityCatalogView, filters: OpportunityFilters): Promise<OpportunityResponse> {
    const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
    const limit = Math.max(0, Math.trunc(filters.limit));
    if (!filters.funding && !filters.spread) {
      return {
        funding: [],
        spread: [],
        totals: { funding: 0, spread: 0 },
        offset,
        limit: Math.max(1, limit),
        fetchedAt: new Date(this.now()).toISOString(),
        cacheStatus: 'fresh',
      };
    }
    const board = await this.boards(catalog, filters);
    return {
      funding: board.funding.slice(offset, offset + limit),
      spread: board.spread.slice(offset, offset + limit),
      totals: { funding: board.funding.length, spread: board.spread.length },
      offset,
      limit: Math.max(1, limit),
      fetchedAt: board.fetchedAt,
      cacheStatus: board.cacheStatus,
    };
  }

  /** Cache-backed row computation: one in-flight computation per distinct filter set per TTL. */
  private async boards(
    catalog: OpportunityCatalogView,
    filters: OpportunityFilters,
  ): Promise<OpportunityBoardRows> {
    const key = this.cacheKey(filters);
    const current = this.cache.get(key);
    if (current && current.expiresAt > this.now()) {
      // Touch guarantees: reinserting keeps the entry newest, so paging through a board never
      // evicts it mid-session.
      this.cache.delete(key);
      this.cache.set(key, current);
      return await current.promise;
    }
    const computation = this.computeBoards(catalog, filters);
    this.cache.set(key, { key, expiresAt: this.now() + this.cacheTtlMs, promise: computation });
    this.trimCache(key);
    try {
      return await computation;
    } catch (error) {
      // Never cache a failure: the next request must be able to succeed.
      this.cache.delete(key);
      throw error;
    }
  }

  /** Live cache-entry count; a test seam that also lets operators confirm the board is reusing. */
  cacheSize(): number {
    return this.cache.size;
  }

  /** Drop every cached board — used when the operator forces a refresh. */
  invalidateCache(): void {
    this.cache.clear();
  }

  /** Age out expired entries first, then the least recently touched one. */
  private trimCache(justAddedKey: string): void {
    const now = this.now();
    for (const [key, entry] of this.cache) {
      if (key !== justAddedKey && entry.expiresAt <= now) this.cache.delete(key);
    }
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
  }

  /**
   * Stable serialization of every filter that can change which rows exist. Paging parameters are
   * intentionally ignored (`list` pages the cached full row set) and categorical lists are sorted
   * so `venues=GATE,OKX` and `venues=OKX,GATE` share one cache entry.
   */
  private cacheKey(filters: OpportunityFilters): string {
    const list = (value: readonly string[] | undefined): string => (value === undefined ? '' : [...value].sort().join(','));
    return [
      filters.funding ? '1' : '0',
      filters.spread ? '1' : '0',
      filters.minApr ?? '',
      filters.minBps ?? '',
      (filters.asset ?? '').toUpperCase(),
      filters.expand === true ? '1' : '0',
      list(filters.venues),
      list(filters.pairTypes),
      list(filters.assetClasses),
      list(filters.assetSuperClasses),
      filters.preIpo ?? 'all',
      filters.sort ?? 'default',
      filters.dir ?? 'desc',
    ].join('|');
  }

  /** Full row set of both boards for one filter combination, computed once per cache window. */
  private async computeBoards(
    catalog: OpportunityCatalogView,
    filters: OpportunityFilters,
  ): Promise<OpportunityBoardRows> {
    if (filters.funding) await this.deps.fundingOverview.ensureFresh();
    const overview = this.deps.fundingOverview.buildResponse(catalog);
    // One merged-view sweep per computation feeds both the spread pairing and the volume/OI
    // lookup, so resolving 24h volume never costs an extra upstream call.
    const markets = await this.deps.spreadMarkets();
    const stats: OpportunityStatsSources = {
      statsIndex: buildMarketStatsIndex(markets),
      openInterestByAssetVenue: buildOpenInterestIndex(overview),
    };
    const classify = this.assetClassifier(catalog);
    const fundingRows = filters.funding
      ? this.buildFundingBoard(overview, filters, stats, classify)
      : [];
    const spreadRows = filters.spread
      ? this.buildSpreadBoard(filters, markets, stats, classify)
      : [];
    return {
      funding: fundingRows,
      spread: spreadRows,
      fetchedAt: new Date(this.now()).toISOString(),
      cacheStatus: overview.cacheStatus,
    };
  }

  /**
   * Memoised classifier bound to one request's catalog. The catalog tells us whether an asset has
   * any SPOT listing, which is what derives `CONTRACT` for perpetual-only symbols; assets missing
   * from the catalog get no context and fall back to `TOKEN`.
   */
  private assetClassifier(catalog: OpportunityCatalogView): (asset: string) => AssetClassification {
    const cache = new Map<string, AssetClassification>();
    return (asset: string): AssetClassification => {
      const cached = cache.get(asset);
      if (cached !== undefined) return cached;
      const venues = catalog.assets.get(asset);
      const hasSpot = venues === undefined ? undefined : venues.some((venue) => venue.business === 'SPOT');
      const classification = classifyAssetCached(asset, hasSpot === undefined ? {} : { hasSpot });
      cache.set(asset, classification);
      return classification;
    };
  }

  /** True when a row's asset passes the class and pre-IPO filters. */
  private passesAssetFilters(
    classify: (asset: string) => AssetClassification,
    asset: string,
    filters: OpportunityFilters,
  ): boolean {
    const classification = classify(asset);
    if (!matchesAssetClassFilter(classification, filters.assetSuperClasses ?? [])) return false;
    if (!matchesPreIpoFilter(classification, filters.preIpo ?? 'all')) return false;
    const classes = filters.assetClasses ?? [];
    if (classes.length > 0 && !classes.includes(classification.assetClass)) return false;
    return true;
  }

  private buildFundingBoard(
    overview: FundingOverviewResponse,
    filters: OpportunityFilters,
    stats: OpportunityStatsSources,
    classify: (asset: string) => AssetClassification,
  ): FundingOpportunity[] {
    const spotByAsset = this.deps.spotSymbolsByAsset();
    let budgetRemaining = this.spotRegistrationBudget;
    const attempted = new Set<string>();
    // Omit-type rows before spot resolution; `spotVenueOptions` holds one candidate per venue.
    type PerpRow = Omit<FundingOpportunity, 'spotSymbol' | 'spotVenue' | 'spotVenues' | 'executable'>;
    const rows: Array<PerpRow & { spotVenueOptions: SpotSymbolEntry[][] }> = [];
    for (const assetEntry of overview.assets) {
      if (filters.asset !== undefined && assetEntry.asset !== filters.asset) continue;
      // Class filtering happens before a single row is built, so filtered-out assets never
      // consume the spot-registration budget and never land in the ranking at all.
      if (!this.passesAssetFilters(classify, assetEntry.asset, filters)) continue;
      const classification = classify(assetEntry.asset);
      for (const venueEntry of assetEntry.venues) {
        // Venue rows without a known rate (upstream error or missing row) never fabricate a board
        // entry — an APR of zero would rank fake opportunities (architecture §8.4).
        if (venueEntry.fundingRate8h === null) continue;
        const apr = fundingAprFromRate8h(venueEntry.fundingRate8h);
        if (!Number.isFinite(apr)) continue;
        if (filters.minApr !== undefined && apr < filters.minApr) continue;
        const candidates = spotByAsset.get(assetEntry.asset) ?? [];
        // One option per spot venue: the candidates arrive venue-ordered with the preferred
        // quote first, so the first symbol of each venue is that venue's leg.
        const spotVenueOptions: SpotSymbolEntry[][] = [];
        for (const candidate of candidates) {
          const option = spotVenueOptions.find((option) => option[0]!.venue === candidate.venue);
          if (option) option.push(candidate);
          else spotVenueOptions.push([candidate]);
        }
        rows.push({
          asset: assetEntry.asset,
          venue: venueEntry.venue,
          symbol: venueEntry.symbol,
          direction: Number(venueEntry.fundingRate8h) >= 0 ? 'POSITIVE' : 'NEGATIVE',
          fundingApr: apr,
          fundingRate8h: venueEntry.fundingRate8h,
          fundingIntervalHours: venueEntry.fundingIntervalHours,
          nextFundingAt: venueEntry.nextFundingAt,
          lastPrice: venueEntry.lastPrice,
          assetClass: classification.assetClass,
          assetSuperClass: classification.assetSuperClass,
          variantSuffix: classification.variantSuffix,
          isPreIpo: classification.isPreIpo,
          perpStats: resolveStats(
            venueEntry.symbol,
            assetEntry.asset,
            venueEntry.venue,
            stats.statsIndex,
            stats.openInterestByAssetVenue,
          ),
          spotVenueOptions,
        });
      }
    }
    rows.sort((left, right) => right.fundingApr - left.fundingApr
      || left.asset.localeCompare(right.asset)
      || left.venue.localeCompare(right.venue));
    // Resolve every row's spot leg while the |APR| ordering still stands, so the registration
    // budget keeps serving the highest-APR rows first (architecture §2.4). Executable rows are
    // then ranked ahead of not-executable ones and the limit truncates last, so rows a user
    // cannot act on never occupy board slots ahead of actionable ones.
    const resolved: FundingOpportunity[] = [];
    for (const row of rows) {
      const spotVenues = [...new Set(row.spotVenueOptions.map((option) => option[0]!.venue))];
      // Collapsed board: one row per (asset, perpetual venue) with the preferred spot venue —
      // Gate first, then catalog venue order, USDT quote first (candidates[0] embodies that
      // order). The whole venue-ordered candidate list rides along so that a preferred venue
      // whose leg turns out to be a different product (implausible price) is skipped in favour
      // of the next comparable venue instead of leaving the row needlessly unconnected.
      // Expanded board: one row per (asset, spot venue, perpetual venue) combination.
      const combinations = filters.expand && row.spotVenueOptions.length > 0
        ? row.spotVenueOptions
        : [row.spotVenueOptions.flat()];
      for (const combination of combinations) {
        const preferredVenue = combination[0]?.venue ?? null;
        const spotSymbol = this.resolveSpotLeg(row.asset, combination, Number(row.lastPrice), () => {
          if (budgetRemaining <= 0) return false;
          budgetRemaining -= 1;
          return true;
        }, attempted);
        // Report the venue that actually serves the leg, not the preferred one it fell back from.
        const spotVenue = spotSymbol === null
          ? preferredVenue
          : combination.find((candidate) => candidate.symbol === spotSymbol)?.venue ?? preferredVenue;
        resolved.push({
          ...row,
          spotSymbol,
          spotVenue,
          spotVenues,
          executable: spotSymbol !== null,
        });
      }
    }
    const dir = filters.dir ?? 'desc';
    const key = filters.sort ?? 'default';
    resolved.sort((left, right) => Number(right.executable) - Number(left.executable)
      || this.compareFunding(left, right, key, dir)
      || left.asset.localeCompare(right.asset)
      || left.venue.localeCompare(right.venue)
      || (left.spotVenue ?? '').localeCompare(right.spotVenue ?? ''));
    return resolved;
  }

  /**
   * Funding-board ordering. `spread` has no meaning here and `default` means APR, so both fall
   * back to the board's historical |APR| ranking. Missing measurements sort last in either
   * direction, matching the "nulls never head the board" convention of the funding page.
   */
  private compareFunding(
    left: FundingOpportunity,
    right: FundingOpportunity,
    key: OpportunitySortKey,
    dir: SortDirection,
  ): number {
    if (key === 'asset') return compareText(left.asset, right.asset, dir);
    if (key === 'volume') {
      return compareAmounts(
        sortableAmount(left.perpStats?.quoteVolume24h),
        sortableAmount(right.perpStats?.quoteVolume24h),
        dir,
      );
    }
    if (key === 'oi') {
      return compareAmounts(
        sortableAmount(left.perpStats?.openInterestValue),
        sortableAmount(right.perpStats?.openInterestValue),
        dir,
      );
    }
    return compareAmounts(left.fundingApr, right.fundingApr, dir);
  }

  /**
   * Prefer an already-registered spot candidate, then try to register the first unregistered one
   * within the request budget. Registration attempts happen once per symbol per request. The
   * recommended leg is the first candidate in the venue-ordered list; already-registered
   * candidates win regardless of venue so the board reuses warm registrations.
   */
  private resolveSpotLeg(
    asset: string,
    candidates: readonly SpotSymbolEntry[],
    perpPrice: number,
    consumeBudget: () => boolean,
    attempted: Set<string>,
  ): string | null {
    // The hedge leg must trade at a comparable price: a 1000× perpetual contract or a same-ticker
    // token from another product can never be the spot leg of this funding row, so such a
    // candidate is skipped in favour of the next venue's market (or resolved as "not connected").
    const plausible = (symbol: string): boolean => {
      const market = this.deps.hub.market(symbol);
      if (market === null) return true;
      return legsPricedComparably(perpPrice, Number(market.lastPrice));
    };
    for (const candidate of candidates) {
      if (this.deps.hub.market(candidate.symbol) !== null && plausible(candidate.symbol)) return candidate.symbol;
    }
    for (const candidate of candidates) {
      if (attempted.has(candidate.symbol)) continue;
      attempted.add(candidate.symbol);
      if (!consumeBudget()) return null;
      if (this.deps.hub.ensureMarkets([{ symbol: candidate.symbol, venue: candidate.venue as MarketDefinition['venue'], asset }])
        && plausible(candidate.symbol)) {
        return candidate.symbol;
      }
    }
    return null;
  }

  private buildSpreadBoard(
    filters: OpportunityFilters,
    markets: readonly LiveMarket[],
    stats: OpportunityStatsSources,
    classify: (asset: string) => AssetClassification,
  ): SpreadOpportunity[] {
    const rows: SpreadOpportunity[] = [];
    // Whitelists are applied while the pairs are built, not after the sort, so `limit` truncates
    // the top rows of the *filtered* board instead of a filtered slice of the top rows.
    const pairTypes = filters.pairTypes === undefined || filters.pairTypes.length === 0
      ? null
      : new Set(filters.pairTypes);
    const includeSpotPerp = pairTypes === null || pairTypes.has('SPOT_PERP');
    const includePerpPerp = pairTypes === null || pairTypes.has('PERP_PERP');
    const assetAllowed = (asset: string): boolean => this.passesAssetFilters(classify, asset, filters);
    for (const group of this.spreadGroups(markets, filters.asset, filters.venues, assetAllowed)) {
      const { spot, perp } = group;
      if (includeSpotPerp) {
        for (let i = 0; i < spot.length; i += 1) {
          for (let j = 0; j < perp.length; j += 1) {
            this.pushBestPair(rows, spot[i]!, perp[j]!, 'SPOT_PERP', filters, stats, classify);
          }
        }
      }
      if (includePerpPerp) {
        for (let i = 0; i < perp.length; i += 1) {
          for (let j = i + 1; j < perp.length; j += 1) {
            this.pushBestPair(rows, perp[i]!, perp[j]!, 'PERP_PERP', filters, stats, classify);
          }
        }
      }
    }
    const dir = filters.dir ?? 'desc';
    const key = filters.sort ?? 'default';
    const collapsed = this.collapseSpreadByAsset(rows);
    // Unaligned rows sink below every aligned row (R4): the ascending key puts unaligned
    // parents (quoteAligned === false → 1) after aligned ones (→ 0), regardless of spread.
    collapsed.sort((left, right) => Number(left.quoteAligned === false) - Number(right.quoteAligned === false)
      || this.compareSpread(left, right, key, dir)
      || left.asset.localeCompare(right.asset)
      || left.leftSymbol.localeCompare(right.leftSymbol));
    return collapsed;
  }

  /**
   * Fold every pair of an asset into one asset-level row. The board lists assets, not pairs: the
   * parent mirrors the asset's best-spread combination (so sorting and one-click execution stay
   * unchanged) and carries the remaining combinations for the expand/collapse detail view.
   */
  private collapseSpreadByAsset(rows: readonly SpreadOpportunity[]): SpreadOpportunity[] {
    const byAsset = new Map<string, SpreadOpportunity[]>();
    for (const row of rows) {
      const group = byAsset.get(row.asset);
      if (group === undefined) byAsset.set(row.asset, [row]);
      else group.push(row);
    }
    const collapsed: SpreadOpportunity[] = [];
    for (const group of byAsset.values()) {
      const best = group.reduce((winner, row) => (row.spreadBps > winner.spreadBps ? row : winner));
      collapsed.push({
        ...best,
        combinations: [...group]
          .sort((left, right) => right.spreadBps - left.spreadBps
            || left.leftSymbol.localeCompare(right.leftSymbol))
          .map((row) => ({
            pairType: row.pairType,
            leftSymbol: row.leftSymbol,
            rightSymbol: row.rightSymbol,
            leftVenue: row.leftVenue,
            rightVenue: row.rightVenue,
            sellBid: row.sellBid,
            buyAsk: row.buyAsk,
            spreadBps: row.spreadBps,
            updatedAt: row.updatedAt,
            leftQuoteUpdatedAt: row.leftQuoteUpdatedAt,
            rightQuoteUpdatedAt: row.rightQuoteUpdatedAt,
            quoteAligned: row.quoteAligned,
            executable: row.executable,
          })),
      });
    }
    return collapsed;
  }

  /** Spread-board ordering; `apr` has no meaning here and falls back to the spread in bps. */
  private compareSpread(
    left: SpreadOpportunity,
    right: SpreadOpportunity,
    key: OpportunitySortKey,
    dir: SortDirection,
  ): number {
    if (key === 'asset') return compareText(left.asset, right.asset, dir);
    if (key === 'volume') {
      return compareAmounts(
        sortableAmount(maxAmount(left.leftStats?.quoteVolume24h ?? null, left.rightStats?.quoteVolume24h ?? null)),
        sortableAmount(maxAmount(right.leftStats?.quoteVolume24h ?? null, right.rightStats?.quoteVolume24h ?? null)),
        dir,
      );
    }
    if (key === 'oi') {
      return compareAmounts(
        sortableAmount(maxAmount(left.leftStats?.openInterestValue ?? null, left.rightStats?.openInterestValue ?? null)),
        sortableAmount(maxAmount(right.leftStats?.openInterestValue ?? null, right.rightStats?.openInterestValue ?? null)),
        dir,
      );
    }
    return compareAmounts(left.spreadBps, right.spreadBps, dir);
  }

  /** Group merged-view markets by asset and settlement family so cross-quote (USDT vs USDC) pairs never form. */
  private spreadGroups(
    markets: readonly LiveMarket[],
    assetFilter: string | undefined,
    venueFilter: readonly string[] | undefined,
    assetAllowed: (asset: string) => boolean,
  ): Array<{ spot: LiveMarket[]; perp: LiveMarket[] }> {
    const venues = venueFilter === undefined || venueFilter.length === 0 ? null : new Set(venueFilter);
    const groups = new Map<string, { spot: LiveMarket[]; perp: LiveMarket[] }>();
    for (const market of markets) {
      if (assetFilter !== undefined && market.asset !== assetFilter) continue;
      // Deselected exchanges drop out before pairing, so no row can carry a filtered-out leg.
      if (venues !== null && !venues.has(market.venue.toUpperCase())) continue;
      const isSpot = CROSSEX_ANY_SPOT_SYMBOL.test(market.symbol);
      if (!isSpot && !CROSSEX_FUTURE_SYMBOL.test(market.symbol)) continue;
      // Asset-class / pre-IPO filtering happens before grouping, so a filtered-out asset never
      // forms a pair and never reaches the sort.
      if (!assetAllowed(market.asset)) continue;
      const quote = market.symbol.slice(market.symbol.lastIndexOf('_') + 1);
      // Same settlement family, not the same literal quote: a USD-settled perpetual must still be
      // able to pair with the USDT leg everyone else lists (see `quoteFamily`).
      const key = `${market.asset}:${quoteFamily(quote)}`;
      const group = groups.get(key) ?? { spot: [], perp: [] };
      (isSpot ? group.spot : group.perp).push(market);
      groups.set(key, group);
    }
    return [...groups.values()];
  }

  /**
   * Emit the better orientation of an unordered market pair. Both directions are evaluated
   * because execution costs (bid/ask crossing) make the two spreads asymmetric; the larger one
   * is the exploitable trade and defines left (sell) / right (buy).
   */
  private pushBestPair(
    rows: SpreadOpportunity[],
    marketA: LiveMarket,
    marketB: LiveMarket,
    pairType: SpreadOpportunity['pairType'],
    filters: OpportunityFilters,
    stats: OpportunityStatsSources,
    classify: (asset: string) => AssetClassification,
  ): void {
    const aSells = pairSpread(marketA, marketB);
    const bSells = pairSpread(marketB, marketA);
    const best = aSells === null
      ? bSells
      : bSells === null
        ? aSells
        : aSells.spreadBps >= bSells.spreadBps ? aSells : bSells;
    if (best === null) return;
    if (filters.minBps !== undefined && best.spreadBps < filters.minBps) return;
    rows.push({
      pairType,
      asset: marketA.asset,
      leftSymbol: best.sell.symbol,
      rightSymbol: best.buy.symbol,
      leftVenue: best.sell.venue,
      rightVenue: best.buy.venue,
      sellBid: best.sellBid,
      buyAsk: best.buyAsk,
      spreadBps: best.spreadBps,
      updatedAt: best.sell.updatedAt > best.buy.updatedAt ? best.sell.updatedAt : best.buy.updatedAt,
      // R4 quote alignment: timestamps ride along (AC-2) and the verdict marks pairs whose two
      // legs' quotes are further apart than the shared skew budget. Unaligned rows stay on the
      // board but sort below every aligned row and never feed the quality board's candidates.
      leftQuoteUpdatedAt: best.sell.quoteUpdatedAt,
      rightQuoteUpdatedAt: best.buy.quoteUpdatedAt,
      quoteAligned: spreadQuoteAlignment(
        best.sell.quoteUpdatedAt,
        best.buy.quoteUpdatedAt,
        this.spreadQuoteMaxSkewMs,
      ),
      executable: true,
      ...this.classificationFields(marketA.asset, classify),
      leftStats: resolveStats(
        best.sell.symbol,
        marketA.asset,
        best.sell.venue,
        stats.statsIndex,
        stats.openInterestByAssetVenue,
      ),
      rightStats: resolveStats(
        best.buy.symbol,
        marketA.asset,
        best.buy.venue,
        stats.statsIndex,
        stats.openInterestByAssetVenue,
      ),
      // Filled by collapseSpreadByAsset once every pair of this asset is known.
      combinations: [],
    });
  }

  /** Classification fields for one asset, shared by both boards. */
  private classificationFields(
    asset: string,
    classify: (asset: string) => AssetClassification,
  ): Pick<SpreadOpportunity, 'assetClass' | 'assetSuperClass' | 'variantSuffix' | 'isPreIpo'> {
    const classification = classify(asset);
    return {
      assetClass: classification.assetClass,
      assetSuperClass: classification.assetSuperClass,
      variantSuffix: classification.variantSuffix,
      isPreIpo: classification.isPreIpo,
    };
  }
}

/**
 * Quote-alignment verdict for one pair (R4): both legs must carry `quoteUpdatedAt` — the same
 * field the strategy engine's `freshMarketPair` gate reads — and their skew must fit the
 * configured budget. A leg without a quote timestamp never carried a quote, so the pair is
 * never aligned. Shared with `spread-quality.ts` candidate selection so the two boards never
 * drift apart on what counts as "the same moment".
 */
export function spreadQuoteAlignment(
  leftQuoteUpdatedAt: string | undefined,
  rightQuoteUpdatedAt: string | undefined,
  maxSkewMs: number,
): boolean {
  const left = leftQuoteUpdatedAt === undefined ? NaN : Date.parse(leftQuoteUpdatedAt);
  const right = rightQuoteUpdatedAt === undefined ? NaN : Date.parse(rightQuoteUpdatedAt);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= maxSkewMs;
}

function pairSpread(sell: LiveMarket, buy: LiveMarket): {
  sell: LiveMarket;
  buy: LiveMarket;
  sellBid: string;
  buyAsk: string;
  spreadBps: number;
} | null {
  // Pending registrations publish '0' quotes; a non-finite or non-positive side is missing data,
  // not a tradable spread, so the pair is skipped instead of being listed with a fake price.
  if (!validQuote(sell.bidPrice) || !validQuote(buy.askPrice)) return null;
  const sellBid = Number(sell.bidPrice);
  const buyAsk = Number(buy.askPrice);
  // Implausible pairing guard: the same asset cannot trade at wildly different prices on two
  // venues. Multiplier collisions (BINANCE 1000PEPE vs OKX PEPE) and same-ticker-different-product
  // collisions (a tokenised equity named CAT vs the CAT meme coin) put the books orders of
  // magnitude apart, and comparing them produced spreads like 3 969 518 180 757 bps. Genuine
  // dislocations stay inside a few percent, so anything past the guard band is a data defect.
  if (!legsPricedComparably(sellBid, buyAsk)) return null;
  return {
    sell,
    buy,
    sellBid: sell.bidPrice,
    buyAsk: buy.askPrice,
    spreadBps: ((sellBid - buyAsk) / buyAsk) * 10_000,
  };
}

/**
 * Cross-venue plausibility band for two legs of the same asset, as a price ratio. Contract
 * multiplier traps (1000× variants) and cross-product ticker collisions land far outside it,
 * while real cross-venue dislocations — even violent ones — stay well inside. 1.35 allows a 35%
 * disagreement: generous enough that no genuine spread opportunity is ever hidden, tight enough
 * that no mixed-product pair is ever listed.
 */
export const MAX_LEG_PRICE_DISAGREEMENT = 1.35;

/**
 * True when two leg prices are close enough to be the same product. Missing or non-positive
 * prices are not this guard's business — the callers already skip unquoted legs — so they pass
 * through unchanged rather than silently dropping rows.
 */
export function legsPricedComparably(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return true;
  const ratio = left > right ? left / right : right / left;
  return ratio <= MAX_LEG_PRICE_DISAGREEMENT;
}
