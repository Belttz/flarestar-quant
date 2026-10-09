import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssetClass,
  AssetSuperClass,
  FundingHistoryEntry,
  FundingOpportunity,
  FundingOverviewResponse,
  OpportunityResponse,
  PreIpoFilterMode,
  SpreadOpportunity,
} from '@gate-crossex/shared-types';
import { ASSET_CLASS_LABEL_KEYS } from '@gate-crossex/shared-types';
import { api } from './api.js';
import type { FrontendQuery, FrontendRoute, OpportunityBoard } from './frontend-routes.js';
import { ExecutionPagination } from './execution-pagination-control.js';
import {
  buildAssetFundingVenues,
  buildCarryFundingHedges,
  buildPerpFundingHedges,
  buildVenueFundingRanking,
  fundingVenueOptions,
  hedgePairedPositionPrefill,
  sortFundingHedges,
  type AssetFundingVenueRow,
  type FundingHedgeRow,
  type FundingHedgeSortKey,
} from './funding-hedge.js';
import { FundingHedgeTable, FundingRankingTable } from './funding-hedge-tables.js';
import { useLanguage } from './i18n.js';
import { assetIcon, assetName, exchanges, fundingVenueName, VenueIcon, type PairedPositionPrefill } from './route-shared.js';

/**
 * Opportunities board, split into a funding-carry ranking (/opportunities/funding) and a
 * cross-exchange spread ranking (/opportunities/spread). Each board fetches only its own data on
 * mount, on filter changes, on the manual refresh button, and soft-refreshes at most once a
 * minute while the tab is in the foreground — never a background poll (PRD boundary). Filters
 * mirror into the URL query so a reload restores the view; the tab switch navigates.
 *
 * Both boards share one filter model (`OpportunityViewFilters`): free-text thresholds, the
 * spread-board button groups, the asset-classification chips (super class + fine class), the
 * three-state pre-IPO switch, a sortable column, and server-side paging (page × pageSize →
 * offset). The backend filters *before* the row cap and reports post-filter `totals`, so the
 * pager reflects every matching row, not just the fetched page.
 */
const SOFT_REFRESH_MS = 60_000;
/** Prefill safety margin: thresholds carry 80% of the observed value (PRD decision 3). */
const SAFETY_MARGIN = 0.8;

export interface OpportunitiesViewProps {
  board: OpportunityBoard;
  navigate: (route: FrontendRoute) => void;
  /**
   * Opens the paired-position strategy form with an explicit prefill. The position page ignores
   * the URL query and accepts only this object, so a perpetual hedge row cannot be launched by
   * navigation alone — without this callback the execute button has nothing to hand over.
   */
  onOpenPairedPosition?: (prefill: PairedPositionPrefill) => void;
}

/** Unified filter state of one opportunity board. Both boards keep an independent copy. */
export interface OpportunityViewFilters {
  /** Funding board only: minimum funding APR (%). */
  minApr: string;
  /** Spread board only: minimum spread (bps). */
  minBps: string;
  asset: string;
  /** Funding board only: hide rows whose spot leg is not connected; on by default. */
  executableOnly: boolean;
  /** Spread board only: comma-separated uppercase venue ids; blank means every exchange. */
  venues: string;
  /** Spread board only: comma-separated `spot` / `perp`; blank means both market types. */
  markets: string;
  /** Raw CSV text of the super-class whitelist (`RWA` / `CRYPTO`); blank means both. */
  superClasses: string;
  /** Raw CSV text of the fine-class whitelist; blank means every class. */
  classes: string;
  /** Three-state pre-IPO switch; `all` never hides a row. */
  preIpo: PreIpoFilterMode;
  /** Sort column; `default` keeps the board's own ranking. */
  sort: OpportunitySortKey;
  /** Sort direction; `desc` is the default and never serializes into the URL. */
  dir: SortDirection;
  /** 1-based page number (text so the input round-trips through the URL). */
  page: string;
  /** Page size text; one of `OPPORTUNITY_PAGE_SIZES`. */
  pageSize: string;
}

/** Market-type buttons on the spread board: `spot` keeps rows with a spot leg, `perp` perpetual-only rows. */
export type SpreadMarketFilter = 'spot' | 'perp';

/** Sortable columns of the opportunity boards (`default` = the board's own ranking). */
export type OpportunitySortKey = 'default' | 'spread' | 'apr' | 'volume' | 'oi' | 'asset';
/** Direction of a sorted column. */
export type SortDirection = 'asc' | 'desc';
export interface OpportunitySortState {
  key: OpportunitySortKey;
  dir: SortDirection;
}

/** Super-class chips: `RWA` (tokenised real-world assets) and `CRYPTO`. */
export const ALL_ASSET_SUPER_CLASSES: readonly AssetSuperClass[] = ['RWA', 'CRYPTO'];
/**
 * Fine-class chips. `PRE_IPO` is deliberately not listed: pre-IPO assets are governed by the
 * dedicated three-state switch instead of a chip.
 */
export const ALL_ASSET_CLASSES: readonly AssetClass[] = [
  'STOCK', 'ETF', 'INDEX', 'FOREX', 'COMMODITY', 'COIN', 'TOKEN', 'CONTRACT',
];
/** The three states of the pre-IPO switch, in display order. */
export const ALL_PRE_IPO_MODES: readonly PreIpoFilterMode[] = ['all', 'only', 'exclude'];
/** Page-size choices of the opportunity boards. */
export const OPPORTUNITY_PAGE_SIZES: readonly number[] = [25, 50, 100];
export const DEFAULT_OPPORTUNITY_PAGE_SIZE = 50;

/** Sort keys each board can actually sort by (`spread` exists only on the spread board, `apr` only on funding). */
const BOARD_SORT_KEYS: Readonly<Record<OpportunityBoard, readonly OpportunitySortKey[]>> = {
  funding: ['default', 'apr', 'volume', 'oi', 'asset'],
  'funding-top': ['default', 'apr', 'volume', 'oi', 'asset'],
  spread: ['default', 'spread', 'volume', 'oi', 'asset'],
};

/**
 * Funding-board sort choices. The hedge board ranks client-side inside the fetched page, so it
 * offers the settlement countdown as well; the keys the backend already understands stay mapped.
 */
export const FUNDING_HEDGE_SORTS: ReadonlyArray<{ key: FundingHedgeSortKey; label: string }> = [
  { key: 'apr', label: 'Net APR' },
  { key: 'net', label: 'Net funding' },
  { key: 'countdown', label: 'Countdown' },
  { key: 'oi', label: 'Open interest' },
  { key: 'asset', label: 'Asset' },
];
const DEFAULT_HEDGE_SORT: FundingHedgeSortKey = 'apr';
/** Row counts the funding-rate ranking offers; the reference board ships 50 by default. */
const FUNDING_RANKING_LIMITS: readonly number[] = [25, 50, 100];
const DEFAULT_RANKING_LIMIT = 50;

const DEFAULT_OPPORTUNITY_FILTERS: OpportunityViewFilters = {
  minApr: '', minBps: '', asset: '', executableOnly: true,
  // Spot filtering starts off: the board opens on perpetual pairs, and spot legs are opt-in.
  venues: '', markets: 'perp', superClasses: '', classes: '',
  preIpo: 'all', sort: 'default', dir: 'desc', page: '1', pageSize: String(DEFAULT_OPPORTUNITY_PAGE_SIZE),
};

/** Every exchange the spread board can filter on, in the catalog's display order. */
export const ALL_SPREAD_VENUES: readonly string[] = exchanges.map((venue) => venue.id.toUpperCase());
export const ALL_SPREAD_MARKETS: readonly SpreadMarketFilter[] = ['spot', 'perp'];

/**
 * Read the venue selection out of its query text. An empty or unknown selection falls back to
 * "every exchange" so a hand-edited URL never leaves the board empty.
 */
export function parseVenueFilter(value: string): string[] {
  const selected = new Set<string>();
  for (const token of value.split(',')) {
    const venue = token.trim().toUpperCase();
    if (venue !== '' && ALL_SPREAD_VENUES.includes(venue)) selected.add(venue);
  }
  return selected.size === 0 ? [...ALL_SPREAD_VENUES] : ALL_SPREAD_VENUES.filter((venue) => selected.has(venue));
}

/** Serialize the venue selection; a full selection serializes to blank so the URL stays clean. */
export function serializeVenueFilter(venues: readonly string[]): string {
  const unique = new Set(venues.map((venue) => venue.trim().toUpperCase()).filter((venue) => venue !== ''));
  const ordered = ALL_SPREAD_VENUES.filter((venue) => unique.has(venue));
  return ordered.length === ALL_SPREAD_VENUES.length ? '' : ordered.join(',');
}

/** Read the market-type selection; an empty or unknown selection means "both". */
export function parseMarketFilter(value: string): SpreadMarketFilter[] {
  const selected = new Set<SpreadMarketFilter>();
  for (const token of value.split(',')) {
    const market = token.trim().toLowerCase();
    if (market === 'spot' || market === 'perp') selected.add(market);
  }
  return selected.size === 0 ? [...ALL_SPREAD_MARKETS] : ALL_SPREAD_MARKETS.filter((market) => selected.has(market));
}

/** Serialize the market-type selection; both selected serializes to blank. */
export function serializeMarketFilter(markets: readonly SpreadMarketFilter[]): string {
  const unique = new Set(markets);
  const ordered = ALL_SPREAD_MARKETS.filter((market) => unique.has(market));
  return ordered.length === ALL_SPREAD_MARKETS.length ? '' : ordered.join(',');
}

/**
 * Toggle one entry of a multi-select filter, keeping at least one entry selected: clicking the
 * last remaining entry is a no-op, mirroring the funding board's exchange buttons.
 */
export function toggleSpreadFilterValue<T extends string>(selected: readonly T[], value: T): T[] {
  if (selected.length === 1 && selected.includes(value)) return [...selected];
  return selected.includes(value)
    ? selected.filter((entry) => entry !== value)
    : [...selected, value];
}

/**
 * Read the super-class whitelist. Unknown tokens are dropped; an empty (or fully unknown) list
 * means "both super classes", so a hand-edited URL never empties the board.
 */
export function parseAssetSuperClassFilter(value: string): AssetSuperClass[] {
  const selected = new Set<string>();
  for (const token of value.split(',')) {
    const entry = token.trim().toUpperCase();
    if (entry === 'RWA' || entry === 'CRYPTO') selected.add(entry);
  }
  return selected.size === 0
    ? [...ALL_ASSET_SUPER_CLASSES]
    : ALL_ASSET_SUPER_CLASSES.filter((entry) => selected.has(entry));
}

/** Serialize the super-class whitelist; both selected serializes to blank. */
export function serializeAssetSuperClassFilter(selection: readonly AssetSuperClass[]): string {
  const unique = new Set(selection);
  const ordered = ALL_ASSET_SUPER_CLASSES.filter((entry) => unique.has(entry));
  return ordered.length === ALL_ASSET_SUPER_CLASSES.length ? '' : ordered.join(',');
}

/** Read the fine-class whitelist; unknown tokens are dropped, blank means every class. */
export function parseAssetClassFilter(value: string): AssetClass[] {
  const selected = new Set<string>();
  for (const token of value.split(',')) {
    const entry = token.trim().toUpperCase();
    if ((ALL_ASSET_CLASSES as readonly string[]).includes(entry)) selected.add(entry);
  }
  return selected.size === 0
    ? [...ALL_ASSET_CLASSES]
    : ALL_ASSET_CLASSES.filter((entry) => selected.has(entry));
}

/** Serialize the fine-class whitelist; the full selection serializes to blank. */
export function serializeAssetClassFilter(selection: readonly AssetClass[]): string {
  const unique = new Set(selection);
  const ordered = ALL_ASSET_CLASSES.filter((entry) => unique.has(entry));
  return ordered.length === ALL_ASSET_CLASSES.length ? '' : ordered.join(',');
}

/** Read the three-state pre-IPO switch; anything other than `only` / `exclude` means `all`. */
export function parsePreIpoFilter(value: string): PreIpoFilterMode {
  const token = value.trim().toLowerCase();
  return token === 'only' || token === 'exclude' ? token : 'all';
}

/** Serialize the pre-IPO switch; `all` serializes to blank. */
export function serializePreIpoFilter(mode: PreIpoFilterMode): string {
  return mode === 'all' ? '' : mode;
}

/** Parse a `sort`/`dir` URL pair; unknown keys fall back to the board's own (unsorted, desc) ranking. */
export function parseSortState(sortValue: string | null, dirValue: string | null): OpportunitySortState {
  const allKeys: readonly string[] = ['default', 'spread', 'apr', 'volume', 'oi', 'asset'];
  const token = sortValue?.trim() ?? '';
  const key = (allKeys.includes(token) ? token : 'default') as OpportunitySortKey;
  // A direction is meaningless without a column: the default ranking always normalizes to desc.
  if (key === 'default') return { key, dir: 'desc' };
  return { key, dir: dirValue === 'asc' ? 'asc' : 'desc' };
}

/** Serialize the sort state; the default ranking and `desc` serialize to blank keys. */
export function serializeSortState(state: OpportunitySortState): { sort: string; dir: string } {
  if (state.key === 'default') return { sort: '', dir: '' };
  return { sort: state.key, dir: state.dir === 'asc' ? state.dir : '' };
}

/**
 * Toggle sorting: clicking a new column sorts it descending (matches the boards' "best
 * opportunities first" reading), clicking the active column again flips the direction.
 */
export function toggleSortState(
  current: OpportunitySortState,
  key: Exclude<OpportunitySortKey, 'default'>,
): OpportunitySortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'desc' };
}

/** Parse a 1-based page number; blank, zero and junk fall back to page 1. */
export function parsePageValue(value: string): number {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** Parse a page size; only the offered choices are accepted, anything else falls back to 50. */
export function parsePageSizeValue(value: string): number {
  const parsed = Number(value.trim());
  return OPPORTUNITY_PAGE_SIZES.includes(parsed) ? parsed : DEFAULT_OPPORTUNITY_PAGE_SIZE;
}

/**
 * Whether one opportunity row survives the asset-classification chips and the pre-IPO switch.
 * Mirror of the backend's filter-before-cap rule: it only drops rows from a snapshot that still
 * predates the latest click, the table must never list a filtered-out combination.
 */
export function opportunityRowMatchesAssetFilters(
  row: Pick<FundingOpportunity, 'assetClass' | 'assetSuperClass' | 'isPreIpo'>,
  superClasses: readonly AssetSuperClass[],
  classes: readonly AssetClass[],
  preIpo: PreIpoFilterMode,
): boolean {
  if (superClasses.length > 0 && !superClasses.includes(row.assetSuperClass)) return false;
  if (classes.length > 0 && !classes.includes(row.assetClass)) return false;
  if (preIpo === 'only' && !row.isPreIpo) return false;
  if (preIpo === 'exclude' && row.isPreIpo) return false;
  return true;
}

/** Compact amount formatter shared by the volume / open-interest cells. */
const amountFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * Format a Decimal-string amount for the volume / open-interest columns. Missing data (`null`,
 * unparsable text, zero) renders as `—` — the venue simply does not publish the figure.
 */
export function formatOpportunityAmount(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return '—';
  return amountFormatter.format(parsed);
}

/**
 * Whether a spread row survives the button filters: both legs must sit on a selected exchange and
 * the row's pair type must match a selected market type. The backend enforces the same rule before
 * the row cap; this mirror documents the contract and guards a stale client-side snapshot.
 */
export function spreadRowMatchesFilters(
  row: SpreadOpportunity,
  venues: readonly string[],
  markets: readonly SpreadMarketFilter[],
): boolean {
  const venueAllowed = venues.length === 0
    || (venues.includes(row.leftVenue.toUpperCase()) && venues.includes(row.rightVenue.toUpperCase()));
  const marketAllowed = markets.length === 0 || markets.some((market) => (
    market === 'spot' ? row.pairType === 'SPOT_PERP' : row.pairType === 'PERP_PERP'
  ));
  return venueAllowed && marketAllowed;
}

function parseFilterNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Keep the signed direction of the spread; only the magnitude is scaled down. */
export function prefillMargin(value: number): number {
  return Math.round(Math.abs(value) * SAFETY_MARGIN) * Math.sign(value);
}

function spreadProduct(symbol: string): 'spot' | 'perp' {
  return /^[A-Z0-9]+_SPOT_/.test(symbol) ? 'spot' : 'perp';
}

/**
 * Every venue that takes part in an asset's combinations, catalog order. Drives the parent row's
 * coverage column so it can show at a glance how many exchanges the asset is arbitrageable across.
 */
export function spreadCombinationVenues(row: Pick<SpreadOpportunity, 'combinations'>): string[] {
  const seen = new Set<string>();
  for (const combination of row.combinations) {
    seen.add(combination.leftVenue);
    seen.add(combination.rightVenue);
  }
  return [...seen].sort((left, right) => left.localeCompare(right));
}

/** Bps → percent, four decimals: 561.32 bps renders as "5.6132%". */
function formatSpreadPercent(bps: number): string {
  return `${(bps / 100).toFixed(4)}%`;
}

/**
 * One-click carry prefill query (architecture v2 §T10): the full four-tuple (asset, spot venue,
 * perpetual venue) plus both leg symbols travels to the carry form, and aprMin carries the
 * ×0.8 safety margin.
 */
export function carryPrefillQuery(row: FundingOpportunity): FrontendQuery {
  return {
    asset: row.asset,
    leftVenue: (row.spotVenue ?? 'gate').toLowerCase(),
    rightVenue: row.venue.toLowerCase(),
    ...(row.spotSymbol ? { leftSymbol: row.spotSymbol } : {}),
    rightSymbol: row.symbol,
    direction: row.direction,
    aprMin: String(prefillMargin(row.fundingApr)),
    apr: String(row.fundingApr),
  };
}

/** One-click auto prefill query: left stays the sell leg, entryBps carries the ×0.8 margin. */
export function spreadPrefillQuery(row: SpreadOpportunity): FrontendQuery {
  return {
    asset: row.asset,
    left: row.leftVenue.toLowerCase(),
    right: row.rightVenue.toLowerCase(),
    leftProduct: spreadProduct(row.leftSymbol),
    rightProduct: spreadProduct(row.rightSymbol),
    entryBps: String(prefillMargin(row.spreadBps)),
    spreadBps: String(row.spreadBps),
  };
}

/** One-shot read of the board's filter values from the URL query string. */
function filtersFromQuery<T extends object>(defaults: T, keys: string[]): T {
  const query = new URLSearchParams(window.location.search);
  const next = { ...defaults } as Record<string, unknown>;
  for (const key of keys) {
    const value = query.get(key);
    if (value !== null) next[key] = value;
  }
  return next as T;
}

/** Read one board's unified filters back out of the URL (with the legacy `limit` alias). */
function opportunityFiltersFromQuery(board: OpportunityBoard): OpportunityViewFilters {
  const query = new URLSearchParams(window.location.search);
  const text = (key: string) => query.get(key) ?? '';
  const base = filtersFromQuery<OpportunityViewFilters>(
    DEFAULT_OPPORTUNITY_FILTERS,
    ['minApr', 'minBps', 'asset', 'venues', 'markets', 'superClasses', 'classes'],
  );
  const executableOnly = query.get('executableOnly');
  // `pageSize` wins; the legacy `limit` alias still restores older shared URLs.
  const pageSize = parsePageSizeValue(text('pageSize') || text('limit'));
  const sortState = parseSortState(query.get('sort'), query.get('dir'));
  const sortKey = BOARD_SORT_KEYS[board].includes(sortState.key) ? sortState.key : 'default';
  return {
    ...base,
    // The URL uses the backend's parameter names; the state fields are the filter-model names.
    superClasses: text('assetSuperClass'),
    classes: text('assetClass'),
    executableOnly: executableOnly === null ? true : executableOnly !== '0',
    preIpo: parsePreIpoFilter(text('preIpo')),
    sort: sortKey,
    dir: sortState.dir,
    page: text('page') || '1',
    pageSize: String(pageSize),
  };
}

/** Flatten one board's filters into the URL record consumed by `useFilterQuerySync`. */
function serializeOpportunityFilters(filters: OpportunityViewFilters): Record<string, string | boolean> {
  const sortState = serializeSortState({ key: filters.sort, dir: filters.dir });
  const page = parsePageValue(filters.page);
  const pageSize = parsePageSizeValue(filters.pageSize);
  return {
    minApr: filters.minApr,
    minBps: filters.minBps,
    asset: filters.asset,
    executableOnly: filters.executableOnly ? '' : '0',
    venues: filters.venues,
    markets: filters.markets,
    superClasses: serializeAssetSuperClassFilter(parseAssetSuperClassFilter(filters.superClasses)),
    classes: serializeAssetClassFilter(parseAssetClassFilter(filters.classes)),
    preIpo: serializePreIpoFilter(filters.preIpo),
    sort: sortState.sort,
    dir: sortState.dir,
    page: page === 1 ? '' : String(page),
    pageSize: pageSize === DEFAULT_OPPORTUNITY_PAGE_SIZE ? '' : String(pageSize),
  };
}

/** Mirror the current filter values into the URL so a reload restores the view. */
function useFilterQuerySync(filters: Record<string, string | boolean>, boardPath: string): void {
  const serialized = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value === '' || value === false) continue;
      if (value === true) params.set(key, '1');
      else params.set(key, String(value));
    }
    const text = params.toString();
    return text === '' ? boardPath : `${boardPath}?${text}`;
  }, [boardPath, filters]);
  useEffect(() => {
    // replaceState keeps the browser history clean: filters are view state, not pages.
    window.history.replaceState(null, '', serialized);
  }, [serialized]);
}

/** Widen a filters object so it can feed useFilterQuerySync. */
function asFilterRecord(filters: Record<string, string | boolean>): Record<string, string | boolean> {
  return filters;
}

/** Classification badge on the asset cell: the asset's super class, RWA or Crypto. */
export function OpportunityClassBadge({ row }: {
  row: Pick<FundingOpportunity, 'assetSuperClass'>;
}) {
  const { t } = useLanguage();
  const isRwa = row.assetSuperClass === 'RWA';
  return <span className={`opportunity-asset-class ${isRwa ? 'rwa' : 'crypto'}`}>
    <b>{t(isRwa ? 'RWA' : 'Crypto')}</b>
  </span>;
}

/** Clickable table header for a sortable column; carries the `aria-sort` state. */
export function OpportunitySortHeader({ label, sortKey, state, onToggle }: {
  label: string;
  sortKey: Exclude<OpportunitySortKey, 'default'>;
  state: OpportunitySortState;
  onToggle: (key: Exclude<OpportunitySortKey, 'default'>) => void;
}) {
  const active = state.key === sortKey;
  return <th className="sortable-header" aria-sort={active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
    <button type="button" onClick={() => onToggle(sortKey)}>
      <span>{label}</span>
      <span className="sort-arrow" aria-hidden="true">{active ? (state.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </button>
  </th>;
}

/**
 * Asset-type filter group: the two super-class chips (RWA / Crypto). The former fine-class and
 * pre-IPO groups were dropped — the only label an asset carries now is RWA or Crypto.
 */
export function OpportunityClassFilters({ filters, onToggleSuperClass }: {
  filters: OpportunityViewFilters;
  onToggleSuperClass: (value: AssetSuperClass) => void;
}) {
  const { t } = useLanguage();
  const superSelection = parseAssetSuperClassFilter(filters.superClasses);
  return <div className="asset-class-filters">
    <div role="group" aria-label={t('Asset type')}>
      <span>{t('Asset type')}</span>
      {ALL_ASSET_SUPER_CLASSES.map((value) => {
        const selected = superSelection.includes(value);
        return <button key={value} type="button" className={selected ? 'asset-chip on' : 'asset-chip'}
          data-on={selected} onClick={() => onToggleSuperClass(value)}>
          {t(value === 'RWA' ? 'RWA' : 'Crypto')}
        </button>;
      })}
    </div>
  </div>;
}

export function OpportunitiesView({ board, navigate, onOpenPairedPosition }: OpportunitiesViewProps) {
  const { language, t } = useLanguage();
  const [data, setData] = useState<OpportunityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Per-asset combination expansion: when set, the funding board fetches expand=1 scoped to that
  // single asset and shows every (spot venue × perpetual venue) combination for it.
  const [expandedAsset, setExpandedAsset] = useState<string | null>(null);
  // Spread board expands straight from the payload: each asset row already carries its pairs.
  const [expandedSpread, setExpandedSpread] = useState<string | null>(null);
  const isFundingBoard = board === 'funding';
  const isFundingTopBoard = board === 'funding-top';
  const isSpreadBoard = board === 'spread';
  // Funding hedge legs: perpetual pairs come from the venue funding overview, spot pairs from the
  // carry board. Kept in view state rather than the URL because both modes page client-side.
  const [hedgeMode, setHedgeMode] = useState<'spot' | 'perp'>('spot');
  const [hedgeVenues, setHedgeVenues] = useState<string[]>(() => [...ALL_SPREAD_VENUES]);
  const [hedgeSort, setHedgeSort] = useState<FundingHedgeSortKey>(DEFAULT_HEDGE_SORT);
  const [fundingOverview, setFundingOverview] = useState<FundingOverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [rankingVenue, setRankingVenue] = useState('GATE');
  const [rankingLimit, setRankingLimit] = useState(DEFAULT_RANKING_LIMIT);
  const [history24h, setHistory24h] = useState<Record<string, FundingHistoryEntry>>({});
  const history24hRef = useRef(history24h);
  history24hRef.current = history24h;
  // Countdowns tick without re-fetching anything: the settlement times are already in the rows.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [fundingFilters, setFundingFilters] = useState<OpportunityViewFilters>(() => opportunityFiltersFromQuery('funding'));
  const [spreadFilters, setSpreadFilters] = useState<OpportunityViewFilters>(() => opportunityFiltersFromQuery('spread'));

  const boardPath = board === 'spread' ? '/opportunities/spread'
    : board === 'funding-top' ? '/opportunities/funding-top' : '/opportunities/funding';
  // The ranking board owns its own toolbar state (venue + row count), so it keeps no opportunity
  // filters in the URL at all.
  useFilterQuerySync(
    useMemo(() => (isFundingTopBoard ? {} : asFilterRecord(serializeOpportunityFilters(isFundingBoard ? fundingFilters : spreadFilters))),
      [fundingFilters, isFundingBoard, isFundingTopBoard, spreadFilters]),
    boardPath,
  );

  /** Patch the active board's filters (the inactive board's state is preserved untouched). */
  const patchFilters = useCallback((updater: (current: OpportunityViewFilters) => OpportunityViewFilters) => {
    if (isFundingBoard) setFundingFilters(updater);
    else setSpreadFilters(updater);
  }, [isFundingBoard]);

  const load = useCallback(() => {
    // The ranking board reads the venue funding overview, not the opportunity endpoint.
    if (isFundingTopBoard) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const activeFilters = isFundingBoard ? fundingFilters : spreadFilters;
    const asset = activeFilters.asset.trim().toUpperCase();
    const minApr = isFundingBoard ? parseFilterNumber(fundingFilters.minApr) : null;
    const minBps = !isFundingBoard ? parseFilterNumber(spreadFilters.minBps) : null;
    // An expanded asset overrides the free-text asset filter: the request is asset-scoped anyway.
    const effectiveAsset = isFundingBoard && expandedAsset !== null ? expandedAsset : asset;
    // Spread-board button filters: normalized so a full selection (the default) sends nothing and
    // the backend applies the whitelist before the row cap, not after it.
    const venueSelection = isFundingBoard ? [] : parseVenueFilter(spreadFilters.venues);
    const marketSelection = isFundingBoard ? [] : parseMarketFilter(spreadFilters.markets);
    const venueQuery = isFundingBoard ? '' : serializeVenueFilter(venueSelection);
    const marketQuery = isFundingBoard ? '' : serializeMarketFilter(marketSelection);
    const superSelection = parseAssetSuperClassFilter(activeFilters.superClasses);
    const classSelection = parseAssetClassFilter(activeFilters.classes);
    const page = parsePageValue(activeFilters.page);
    const pageSize = parsePageSizeValue(activeFilters.pageSize);
    const sortKey = BOARD_SORT_KEYS[board].includes(activeFilters.sort) ? activeFilters.sort : 'default';
    api.opportunities({
      funding: isFundingBoard,
      spread: !isFundingBoard,
      ...(minApr !== null ? { minApr } : {}),
      ...(minBps !== null ? { minBps } : {}),
      ...(effectiveAsset !== '' && /^[A-Z0-9]{1,20}$/.test(effectiveAsset) ? { asset: effectiveAsset } : {}),
      ...(isFundingBoard && expandedAsset !== null ? { expand: true } : {}),
      ...(venueQuery !== '' ? { venues: venueSelection } : {}),
      ...(marketQuery !== '' ? { markets: marketSelection } : {}),
      assetSuperClass: superSelection,
      assetClass: classSelection,
      preIpo: activeFilters.preIpo,
      ...(sortKey !== 'default' ? { sort: sortKey, dir: activeFilters.dir } : {}),
      offset: (page - 1) * pageSize,
      pageSize,
    }).then((response) => {
      setData(response);
      setFailed(false);
    }).catch(() => setFailed(true)).finally(() => setLoading(false));
  }, [board, expandedAsset, fundingFilters, isFundingBoard, isFundingTopBoard, spreadFilters]);

  // The funding hedge board in perpetual mode and the ranking board read the venue funding
  // overview instead; the opportunity endpoint is not fetched for them at all.
  const needsFundingOverview = isFundingTopBoard || (isFundingBoard && hedgeMode === 'perp');
  const loadOverview = useCallback(() => {
    setOverviewLoading(true);
    api.fundingOverview().then((response) => {
      setFundingOverview(response);
      setOverviewFailed(false);
    }).catch(() => setOverviewFailed(true)).finally(() => setOverviewLoading(false));
  }, []);

  useEffect(() => {
    if (!needsFundingOverview) return undefined;
    loadOverview();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadOverview();
    }, SOFT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadOverview, needsFundingOverview]);

  useEffect(() => {
    load();
    if (isFundingTopBoard) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, SOFT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, isFundingTopBoard]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const activeFilters = isFundingBoard ? fundingFilters : spreadFilters;
  const page = parsePageValue(activeFilters.page);
  const pageSize = parsePageSizeValue(activeFilters.pageSize);
  // `funding-top` has no server-paged row set of its own; its panel reports its own count.
  const totalRows = isFundingTopBoard ? 0 : isFundingBoard ? data?.totals.funding ?? 0 : data?.totals.spread ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  // When a filter shrink drops the backend below the requested offset, walk the page back into range.
  useEffect(() => {
    if (page > pageCount) patchFilters((current) => ({ ...current, page: String(pageCount) }));
  }, [page, pageCount, patchFilters]);

  const executeCarry = (row: FundingOpportunity) => {
    navigate({ workspace: 'Strategy', strategyKind: 'carry', query: carryPrefillQuery(row) });
  };

  const executeSpread = (row: SpreadOpportunity) => {
    navigate({ workspace: 'Strategy', strategyKind: 'auto', query: spreadPrefillQuery(row) });
  };

  const fundingRows = isFundingBoard
    ? (data?.funding ?? [])
        .filter((row) => !fundingFilters.executableOnly || row.executable)
        .filter((row) => opportunityRowMatchesAssetFilters(
          row,
          parseAssetSuperClassFilter(fundingFilters.superClasses),
          parseAssetClassFilter(fundingFilters.classes),
          fundingFilters.preIpo,
        ))
    : [];
  // Button selections are derived from the URL-backed filter text, so a reload restores them.
  const selectedVenues = parseVenueFilter(spreadFilters.venues);
  const selectedMarkets = parseMarketFilter(spreadFilters.markets);
  // The backend filters before the row cap, so this mirror only drops rows from a snapshot that
  // still predates the latest button click — the table must never list a filtered-out combination.
  const spreadRows = !isFundingBoard
    ? (data?.spread ?? [])
        .filter((row) => spreadRowMatchesFilters(row, selectedVenues, selectedMarkets))
        .filter((row) => opportunityRowMatchesAssetFilters(
          row,
          parseAssetSuperClassFilter(spreadFilters.superClasses),
          parseAssetClassFilter(spreadFilters.classes),
          spreadFilters.preIpo,
        ))
    : [];
  // --- Funding hedge board ---------------------------------------------------------------
  // Perpetual mode needs a second venue for every pair, so it is filtered here; the carry board
  // already arrives filtered and ranked by the backend.
  const hedgeSearch = fundingFilters.asset.trim().toUpperCase();
  const hedgeMinApr = parseFilterNumber(fundingFilters.minApr);
  const hedgeRowsAll = useMemo<FundingHedgeRow[]>(() => {
    if (!isFundingBoard) return [];
    if (hedgeMode === 'perp') {
      return buildPerpFundingHedges(fundingOverview?.assets ?? [], hedgeVenues)
        .filter((row) => hedgeSearch === '' || row.asset.includes(hedgeSearch))
        .filter((row) => hedgeMinApr === null || row.aprPercent >= hedgeMinApr);
    }
    return buildCarryFundingHedges(fundingRows);
  }, [fundingOverview, fundingRows, hedgeMinApr, hedgeMode, hedgeSearch, hedgeVenues, isFundingBoard]);
  const hedgeSortDirection: 'asc' | 'desc' = hedgeSort === 'asset' || hedgeSort === 'countdown' ? 'asc' : 'desc';
  const hedgeRows = useMemo(
    () => hedgeMode === 'perp'
      ? sortFundingHedges(hedgeRowsAll, hedgeSort, hedgeSortDirection, nowMs)
      : hedgeRowsAll,
    [hedgeMode, hedgeRowsAll, hedgeSort, hedgeSortDirection, nowMs],
  );
  // Perpetual pairs are computed from the whole overview, so they page here; the carry board is
  // already one server page and must not be sliced twice.
  const hedgePageCount = Math.max(1, Math.ceil(hedgeRows.length / pageSize));
  const hedgePageValue = Math.min(page, hedgePageCount);
  const hedgeRowsVisible = hedgeMode === 'perp'
    ? hedgeRows.slice((hedgePageValue - 1) * pageSize, hedgePageValue * pageSize)
    : hedgeRows;
  const hedgeTotal = hedgeMode === 'perp' ? hedgeRows.length : totalRows;
  const history24hKey = useMemo(() => [...new Set(hedgeRowsVisible.flatMap(
    (row) => [...row.legs].filter((leg) => leg.kind === 'perp' && leg.symbol !== '').map((leg) => leg.symbol),
  ))].sort().join('|'), [hedgeRowsVisible]);

  useEffect(() => {
    if (!isFundingBoard || history24hKey === '') return undefined;
    const missing = history24hKey.split('|').filter((symbol) => history24hRef.current[symbol] === undefined);
    if (missing.length === 0) return undefined;
    let cancelled = false;
    const batches: string[][] = [];
    for (let offset = 0; offset < missing.length; offset += 50) batches.push(missing.slice(offset, offset + 50));
    // The endpoint is SQLite-first: it answers immediately and warms the missing ranges behind.
    void Promise.all(batches.map((batch) => api.fundingHistory(batch, 1).catch(() => null))).then((results) => {
      if (cancelled) return;
      const entries = results.flatMap((result) => result?.entries ?? []);
      if (entries.length === 0) return;
      setHistory24h((current) => ({ ...current, ...Object.fromEntries(entries.map((entry) => [entry.symbol, entry])) }));
    });
    return () => { cancelled = true; };
  }, [history24hKey, isFundingBoard]);

  const executeHedge = (row: FundingHedgeRow) => {
    // Carry rows keep their own four-tuple prefill; a perpetual pair opens the paired-position
    // form short the higher-funding venue and long the other.
    if (row.carry) {
      executeCarry(row.carry);
      return;
    }
    const prefill = hedgePairedPositionPrefill(row);
    if (onOpenPairedPosition) {
      onOpenPairedPosition(prefill);
      return;
    }
    // Without the host callback (SSR tests, embedded hosts) fall back to plain navigation.
    navigate({
      workspace: 'Strategy',
      strategyKind: 'position',
      query: { asset: prefill.asset, left: prefill.shortVenue, right: prefill.longVenue },
    });
  };

  // --- Funding-rate ranking board --------------------------------------------------------
  const rankingRows = useMemo(
    () => isFundingTopBoard ? buildVenueFundingRanking(fundingOverview?.assets ?? [], rankingVenue, rankingLimit) : [],
    [fundingOverview, isFundingTopBoard, rankingLimit, rankingVenue],
  );
  const rankingVenueTotal = useMemo(
    () => isFundingTopBoard ? buildVenueFundingRanking(fundingOverview?.assets ?? [], rankingVenue, Number.MAX_SAFE_INTEGER).length : 0,
    [fundingOverview, isFundingTopBoard, rankingVenue],
  );

  const sortState: OpportunitySortState = { key: activeFilters.sort, dir: activeFilters.dir };
  const onSortToggle = (key: Exclude<OpportunitySortKey, 'default'>) => {
    patchFilters((current) => ({ ...current, ...toggleSortState({ key: current.sort, dir: current.dir }, key), page: '1' }));
  };
  const locale = language === 'zh' ? 'zh-CN' : 'en-GB';
  const toggleExpandedAsset = (asset: string) => {
    setExpandedAsset((current) => (current === asset ? null : asset));
  };
  // The ranking board reports the overview's own freshness; the other boards report the payload's.
  const freshness = isFundingTopBoard
    ? (fundingOverview ? { at: fundingOverview.fetchedAt, stale: fundingOverview.cacheStatus === 'stale' } : null)
    : (data ? { at: data.fetchedAt, stale: data.cacheStatus === 'stale' } : null);
  const refreshing = loading || overviewLoading;
  const refreshActive = () => {
    if (isFundingTopBoard || (isFundingBoard && hedgeMode === 'perp')) loadOverview();
    else load();
  };
  return <div className="alternate-view opportunity-view">
    <section className="view-heading strategy-heading">
      <div>
        <p className="eyebrow">{t('Opportunities')}</p>
        <h1>{t('Opportunity board')}</h1>
        <p>{t('Rank funding carry and cross-exchange spreads, then prefill the matching strategy form for review.')}</p>
      </div>
      <div className="opportunity-head-actions">
        {freshness && <span className={`opportunity-freshness${freshness.stale ? ' stale' : ''}`}>
          {t('Last updated at')} {new Date(freshness.at).toLocaleTimeString(locale, { hour12: false })}
          {freshness.stale ? ` · ${t('Stale snapshot')}` : ''}
        </span>}
        <button className="opportunity-refresh" onClick={refreshActive} disabled={refreshing}>
          {refreshing ? t('Refreshing…') : t('Refresh')}
        </button>
      </div>
    </section>

    <div className="opportunity-board-tabs" role="tablist" aria-label={t('Opportunity board')}>
      <button role="tab" aria-selected={isSpreadBoard} className={isSpreadBoard ? 'active' : ''}
        onClick={() => navigate({ workspace: 'Opportunities', board: 'spread' })}>
        {t('Spread opportunities')}
      </button>
      <button role="tab" aria-selected={isFundingBoard} className={isFundingBoard ? 'active' : ''}
        onClick={() => navigate({ workspace: 'Opportunities', board: 'funding' })}>
        {t('Funding-rate opportunities')}
      </button>
      <button role="tab" aria-selected={isFundingTopBoard} className={isFundingTopBoard ? 'active' : ''}
        onClick={() => navigate({ workspace: 'Opportunities', board: 'funding-top' })}>
        {t('Funding-rate ranking')}
      </button>
    </div>

    {!isFundingTopBoard && <OpportunityClassFilters
      filters={activeFilters}
      onToggleSuperClass={(value) => patchFilters((current) => ({
        ...current,
        superClasses: serializeAssetSuperClassFilter(toggleSpreadFilterValue(parseAssetSuperClassFilter(current.superClasses), value)),
        page: '1',
      }))}
    />}

    {isFundingBoard && <>
      {/* Both boards live under one tab; the switch picks the leg pairing behind the same ranking. */}
      <div className="hedge-mode-switch metric-switch" role="radiogroup" aria-label={t('Hedge mode')}>
        <span>{t('Hedge mode')}</span>
        <button type="button" role="radio" className={hedgeMode === 'spot' ? 'active' : ''} aria-checked={hedgeMode === 'spot'}
          onClick={() => setHedgeMode('spot')}>{t('Spot ⇄ perpetual')}</button>
        <button type="button" role="radio" className={hedgeMode === 'perp' ? 'active' : ''} aria-checked={hedgeMode === 'perp'}
          onClick={() => setHedgeMode('perp')}>{t('Perpetual ⇄ perpetual')}</button>
      </div>

      <section className="opportunity-filters" aria-label={t('Filter opportunities')}>
        <label className="opportunity-filter"><span>{t('Search asset')}</span>
          <input value={fundingFilters.asset} onChange={(event) => patchFilters((current) => ({ ...current, asset: event.target.value, page: '1' }))} placeholder="BTC" inputMode="search" />
        </label>
        <label className="opportunity-filter"><span>{hedgeMode === 'perp' ? t('Min net APR (%)') : t('Min funding APR (%)')}</span>
          <input value={fundingFilters.minApr} onChange={(event) => patchFilters((current) => ({ ...current, minApr: event.target.value, page: '1' }))} inputMode="decimal" placeholder="0" />
        </label>
        {hedgeMode === 'spot' && <label className="opportunity-filter opportunity-filter-check"><span>{t('Executable only')}</span>
          <input type="checkbox" checked={fundingFilters.executableOnly} aria-label={t('Executable only')}
            onChange={(event) => patchFilters((current) => ({ ...current, executableOnly: event.target.checked, page: '1' }))} />
        </label>}
        {hedgeMode === 'perp' && <label className="opportunity-filter"><span>{t('Sorted by')}</span>
          <select value={hedgeSort} onChange={(event) => setHedgeSort(event.target.value as FundingHedgeSortKey)}>
            {FUNDING_HEDGE_SORTS.map((option) => <option key={option.key} value={option.key}>{t(option.label)}</option>)}
          </select>
        </label>}
        <p className="opportunity-hint">{hedgeMode === 'perp'
          ? t('Perpetual pairs always short the higher-funding venue and long the other, so the net funding is collected.')
          : t('One-click opens the pre-filled strategy form; launch stays behind an explicit confirmation.')}</p>
      </section>

      {hedgeMode === 'perp' && <div className="exchange-filter" role="group" aria-label={t('Exchange filter')}>
        <span>{t('Exchanges')}</span>
        {fundingVenueOptions().map((venue) => {
          const selected = hedgeVenues.includes(venue.code);
          return <button key={venue.id} type="button" className={selected ? 'selected' : ''} aria-pressed={selected}
            onClick={() => setHedgeVenues((current) => toggleSpreadFilterValue(current, venue.code))}>
            <VenueIcon id={venue.id} short={venue.short} />{venue.name}<em>{selected ? '✓' : '+'}</em>
          </button>;
        })}
        <small>{hedgeVenues.length} {t('selected')} · {t('at least two exchanges required')}</small>
      </div>}

      {(hedgeMode === 'spot' ? failed : failed || overviewFailed) && <p className="opportunity-error" role="alert">{t('Unable to load opportunities')}. {t('Check the backend connection and try again.')}</p>}

      <section className="opportunity-board terminal-panel" aria-labelledby="opportunity-funding-title">
        <header className="opportunity-board-head">
          <h2 id="opportunity-funding-title">{hedgeMode === 'perp' ? t('Cross-exchange funding hedge') : t('Funding-rate opportunities')}</h2>
          <small>{hedgeMode === 'perp'
            ? t('Same asset, two perpetual venues: short the higher funding leg and long the other.')
            : t('Positive funding buys spot against the perpetual; negative funding reverses it.')}</small>
        </header>
        {hedgeMode === 'perp' ? <>
          {hedgeRows.length === 0 && !overviewFailed && <div className="empty-state"><span>◎</span>
            <strong>{overviewLoading ? t('Loading…') : t('No opportunities match the current filters.')}</strong></div>}
          {hedgeRows.length > 0 && <FundingHedgeTable rows={hedgeRowsVisible} history24h={history24h} nowMs={nowMs} onExecute={executeHedge} />}
        </> : <>
          {fundingRows.length === 0 && !failed && <div className="empty-state"><span>◎</span><strong>{t('No opportunities match the current filters.')}</strong></div>}
          {fundingRows.length > 0 && <div className="opportunity-table table-wrap"><table>
            <thead><tr>
              <OpportunitySortHeader label={t('Asset')} sortKey="asset" state={sortState} onToggle={onSortToggle} />
              <th>{t('Exchange')}</th><th>{t('Contract')}</th><th>{t('Direction')}</th>
              <OpportunitySortHeader label={t('Funding APR')} sortKey="apr" state={sortState} onToggle={onSortToggle} />
              <th>{t('Per 8h')}</th><th>{t('Next settlement')}</th><th>{t('Spot leg')}</th>
              <OpportunitySortHeader label={t('24h volume')} sortKey="volume" state={sortState} onToggle={onSortToggle} />
              <OpportunitySortHeader label={t('Open interest')} sortKey="oi" state={sortState} onToggle={onSortToggle} />
              <th />
            </tr></thead>
            <tbody>{fundingRows.map((row) => <tr key={`${row.asset}:${row.venue}:${row.spotVenue ?? ''}`} className={row.executable ? '' : 'not-executable'}>
              <td><span className="opportunity-asset"><i aria-hidden="true">{assetIcon(row.asset)}</i><strong>{row.asset}</strong><small>{assetName(row.asset)}</small></span>
                <OpportunityClassBadge row={row} />
                <button className="row-action expand-combinations" onClick={() => toggleExpandedAsset(row.asset)}
                  aria-expanded={expandedAsset === row.asset}>
                  {expandedAsset === row.asset ? t('Collapse combinations') : t('Expand combinations')}
                </button>
              </td>
              <td>{fundingVenueName(row.venue)}</td>
              <td className="mono">{row.symbol}</td>
              <td><span className={`direction-tag ${row.direction === 'POSITIVE' ? 'positive' : 'negative'}`}>{t(row.direction === 'POSITIVE' ? 'Positive' : 'Negative')}</span>
                <small>{t(row.direction === 'POSITIVE' ? 'Buy spot · short perp' : 'Sell spot · long perp')}</small>
              </td>
              <td><strong className={row.direction === 'POSITIVE' ? 'positive' : 'negative'}>{row.fundingApr.toFixed(2)}%</strong></td>
              <td>{(Number(row.fundingRate8h) * 100).toFixed(4)}%</td>
              <td>{row.nextFundingAt ? new Date(row.nextFundingAt).toLocaleTimeString(locale, { hour12: false }) : '—'}</td>
              <td>{row.spotSymbol
                ? <span className="opportunity-leg"><b className="venue-badge">{fundingVenueName(row.spotVenue ?? 'GATE')}</b><small className="mono">{row.spotSymbol}</small></span>
                : <em className="unconnected-tag">{t('Not connected')}</em>}</td>
              <td className="opportunity-stats mono" title={row.perpStats?.quoteVolume24h ?? ''}>{formatOpportunityAmount(row.perpStats?.quoteVolume24h ?? null)}</td>
              <td className="opportunity-stats mono" title={row.perpStats?.openInterestValue ?? ''}>{formatOpportunityAmount(row.perpStats?.openInterestValue ?? null)}</td>
              <td><button className="row-action execute-action" onClick={() => executeCarry(row)} disabled={!row.executable}>
                {row.executable ? t('Execute') : t('Not connected')}
              </button></td>
            </tr>)}</tbody>
          </table></div>}
        </>}
        <ExecutionPagination
          itemCount={hedgeMode === 'perp' ? hedgeTotal : totalRows}
          page={hedgeMode === 'perp' ? hedgePageValue : page}
          pageSize={pageSize}
          pageSizeOptions={OPPORTUNITY_PAGE_SIZES}
          onPageChange={(nextPage) => patchFilters((current) => ({ ...current, page: String(nextPage) }))}
          onPageSizeChange={(size) => patchFilters((current) => ({ ...current, pageSize: String(size), page: '1' }))}
        />
      </section>
    </>}

    {isFundingTopBoard && <>
      <section className="opportunity-filters" aria-label={t('Filter opportunities')}>
        <label className="opportunity-filter"><span>{t('Exchange')}</span>
          <select value={rankingVenue} onChange={(event) => setRankingVenue(event.target.value)}>
            {fundingVenueOptions().map((venue) => <option key={venue.id} value={venue.code}>{venue.name}</option>)}
          </select>
        </label>
        <label className="opportunity-filter"><span>{t('Rows')}</span>
          <select value={rankingLimit} onChange={(event) => setRankingLimit(Number(event.target.value))}>
            {FUNDING_RANKING_LIMITS.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <p className="opportunity-hint">{t('Every perpetual on the selected exchange, ranked by absolute funding rate.')}</p>
      </section>

      {overviewFailed && <p className="opportunity-error" role="alert">{t('Unable to load opportunities')}. {t('Check the backend connection and try again.')}</p>}

      <section className="opportunity-board terminal-panel" aria-labelledby="opportunity-ranking-title">
        <header className="opportunity-board-head">
          <h2 id="opportunity-ranking-title">{t('Funding-rate ranking')}</h2>
          <small>{t('Same asset, same quote: the sell leg goes first, the buy leg second.')}</small>
        </header>
        {rankingRows.length === 0 && !overviewFailed && <div className="empty-state"><span>◎</span>
          <strong>{overviewLoading ? t('Loading…') : t('No perpetual markets match')}</strong></div>}
        {rankingRows.length > 0 && <>
          <FundingRankingTable rows={rankingRows} venueCode={rankingVenue} nowMs={nowMs} locale={locale}
            assetVenues={(asset) => buildAssetFundingVenues(fundingOverview?.assets ?? [], asset)} />
          <p className="opportunity-hint">{t('Showing')} {rankingRows.length} / {rankingVenueTotal} {t('pairs')}</p>
        </>}
      </section>
    </>}

    {isSpreadBoard && <>
      <section className="opportunity-filters" aria-label={t('Filter opportunities')}>
        <label className="opportunity-filter"><span>{t('Search asset')}</span>
          <input value={spreadFilters.asset} onChange={(event) => patchFilters((current) => ({ ...current, asset: event.target.value, page: '1' }))} placeholder="BTC" inputMode="search" />
        </label>
        <label className="opportunity-filter"><span>{t('Min spread (bps)')}</span>
          <input value={spreadFilters.minBps} onChange={(event) => patchFilters((current) => ({ ...current, minBps: event.target.value, page: '1' }))} inputMode="decimal" placeholder="0" />
        </label>
        <div className="opportunity-filter-groups">
          {/* Exchange buttons mirror the funding board's group: multi-select, at least one stays on. */}
          <div className="exchange-filter" role="group" aria-label={t('Exchange filter')}>
            <span>{t('Exchanges')}</span>
            {exchanges.map((venue) => {
              const selected = selectedVenues.includes(venue.id.toUpperCase());
              return <button key={venue.id} className={selected ? 'selected' : ''} aria-pressed={selected}
                onClick={() => patchFilters((current) => ({
                  ...current,
                  venues: serializeVenueFilter(toggleSpreadFilterValue(parseVenueFilter(current.venues), venue.id.toUpperCase())),
                  page: '1',
                }))}>
                <VenueIcon id={venue.id} short={venue.short} />{venue.name}<em>{selected ? '✓' : '+'}</em>
              </button>;
            })}
            <small>{selectedVenues.length} {t('selected')} · {t('at least one required')}</small>
          </div>
          <div className="market-filter" role="group" aria-label={t('Market type')}>
            <span>{t('Market type')}</span>
            {ALL_SPREAD_MARKETS.map((market) => {
              const selected = selectedMarkets.includes(market);
              return <button key={market} className={selected ? 'selected' : ''} aria-pressed={selected}
                onClick={() => patchFilters((current) => ({
                  ...current,
                  markets: serializeMarketFilter(toggleSpreadFilterValue(parseMarketFilter(current.markets), market)),
                  page: '1',
                }))}>
                {t(market === 'spot' ? 'Spot' : 'Perpetual')}<em>{selected ? '✓' : '+'}</em>
              </button>;
            })}
            <small>{selectedMarkets.length} {t('selected')} · {t('at least one required')}</small>
          </div>
        </div>
        <p className="opportunity-hint">{t('One-click opens the pre-filled strategy form; launch stays behind an explicit confirmation.')}</p>
      </section>

      {failed && <p className="opportunity-error" role="alert">{t('Unable to load opportunities')}. {t('Check the backend connection and try again.')}</p>}

      <section className="opportunity-board terminal-panel" aria-labelledby="opportunity-spread-title">
        <header className="opportunity-board-head">
          <h2 id="opportunity-spread-title">{t('Spread opportunities')}</h2>
          <small>{t('Same asset, same quote: the sell leg goes first, the buy leg second.')}</small>
        </header>
        {spreadRows.length === 0 && !failed && <div className="empty-state"><span>◎</span><strong>{t('No opportunities match the current filters.')}</strong></div>}
        {spreadRows.length > 0 && <div className="opportunity-table opportunity-spread-table table-wrap"><table>
          <thead><tr>
            <th aria-label={t('Expand combinations')} />
            <OpportunitySortHeader label={t('Asset')} sortKey="asset" state={sortState} onToggle={onSortToggle} />
            <th>{t('Best path')}</th>
            <OpportunitySortHeader label={t('Spread')} sortKey="spread" state={sortState} onToggle={onSortToggle} />
            <th>{t('Pairs')}</th><th>{t('Venues')}</th>
            <OpportunitySortHeader label={t('24h volume')} sortKey="volume" state={sortState} onToggle={onSortToggle} />
            <th>{t('Last updated')}</th><th />
          </tr></thead>
          <tbody>{spreadRows.map((row) => {
            const open = expandedSpread === row.asset;
            const venues = spreadCombinationVenues(row);
            // The parent row mirrors the best combination; execute opens that same prefilled form.
            return <Fragment key={row.asset}>
              <tr className={open ? 'spread-asset-row open' : 'spread-asset-row'}>
                <td><button type="button" className="row-action spread-toggle"
                  aria-expanded={open} aria-label={t(open ? 'Collapse combinations' : 'Expand combinations')}
                  onClick={() => setExpandedSpread(open ? null : row.asset)}>{open ? '▾' : '▸'}</button></td>
                <td><span className="opportunity-asset"><i aria-hidden="true">{assetIcon(row.asset)}</i><strong>{row.asset}</strong><small>{assetName(row.asset)}</small></span>
                  <OpportunityClassBadge row={row} /></td>
                <td><span className="spread-path"><b>{fundingVenueName(row.leftVenue)}</b><i aria-hidden="true">→</i><b>{fundingVenueName(row.rightVenue)}</b></span></td>
                <td><strong className={row.spreadBps >= 0 ? 'positive' : 'negative'}>{formatSpreadPercent(row.spreadBps)}</strong></td>
                <td className="mono">{row.combinations.length}</td>
                <td><span className="spread-venues">{venues.map((venue) => <b key={venue} className="venue-badge">{fundingVenueName(venue)}</b>)}</span></td>
                <td className="opportunity-stats mono" title={`${row.leftStats?.quoteVolume24h ?? '—'} / ${row.rightStats?.quoteVolume24h ?? '—'}`}>
                  {formatOpportunityAmount(row.leftStats?.quoteVolume24h ?? null)} / {formatOpportunityAmount(row.rightStats?.quoteVolume24h ?? null)}
                </td>
                <td>{new Date(row.updatedAt).toLocaleTimeString(locale, { hour12: false })}</td>
                <td><button className="row-action execute-action" onClick={() => executeSpread(row)} disabled={!row.executable}>
                  {row.executable ? t('Execute') : t('Not connected')}
                </button></td>
              </tr>
              {open && <tr className="spread-detail-row"><td colSpan={9}>
                <table className="spread-combination-table">
                  <thead><tr>
                    <th>{t('Pair')}</th><th>{t('Sell leg')}</th><th>{t('Buy leg')}</th>
                    <th>{t('Pair type')}</th><th>{t('Spread')}</th><th>{t('Sell bid / Buy ask')}</th><th />
                  </tr></thead>
                  <tbody>{row.combinations.map((combination, index) => <tr key={`${combination.leftSymbol}:${combination.rightSymbol}`} className={index === 0 ? 'best' : ''}>
                    <td>{index === 0 ? <em className="best-tag">{t('Best')}</em> : index + 1}</td>
                    <td><span className="opportunity-leg"><b>{fundingVenueName(combination.leftVenue)}</b><small className="mono">{combination.leftSymbol}</small></span></td>
                    <td><span className="opportunity-leg"><b>{fundingVenueName(combination.rightVenue)}</b><small className="mono">{combination.rightSymbol}</small></span></td>
                    <td><span className="pair-type-tag">{combination.pairType === 'SPOT_PERP' ? t('Spot ⇄ perpetual') : t('Perpetual')}</span></td>
                    <td><strong className={combination.spreadBps >= 0 ? 'positive' : 'negative'}>{formatSpreadPercent(combination.spreadBps)}</strong></td>
                    <td className="mono">{combination.sellBid} / {combination.buyAsk}</td>
                    <td><button className="row-action execute-action" onClick={() => executeSpread({ ...row, ...combination })} disabled={!combination.executable}>
                      {combination.executable ? t('Execute') : t('Not connected')}
                    </button></td>
                  </tr>)}</tbody>
                </table>
              </td></tr>}
            </Fragment>;
          })}</tbody>
        </table></div>}
        <ExecutionPagination
          itemCount={totalRows}
          page={page}
          pageSize={pageSize}
          pageSizeOptions={OPPORTUNITY_PAGE_SIZES}
          onPageChange={(nextPage) => patchFilters((current) => ({ ...current, page: String(nextPage) }))}
          onPageSizeChange={(size) => patchFilters((current) => ({ ...current, pageSize: String(size), page: '1' }))}
        />
      </section>
    </>}
  </div>;
}
