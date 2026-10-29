import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type FundingHistoryEntry,
  type FundingHistorySeriesEntry,
  type FundingOverviewAsset,
  type FundingOverviewResponse,
  type FundingOverviewVenueEntry,
  type FundingSettlementSummary,
  type LiveMarket,
  type MarketSnapshot,
} from './api.js';
import type { FundingChartSeries } from './charts.js';
import { cumulativeFundingHistory } from './cumulative-funding-history.js';
import {
  applyFundingAssetOrder,
  averageAvailableFundingRate,
  cumulativeFundingPercent,
  currentFundingComparisonRate,
  currentFundingMetricRate,
  fundingFractionToPercent,
  fundingPairAnnualizedPercent,
  fundingPercentScaledTo8h,
  fundingHistoryRequestKey,
  pairFundingLegs,
  sortFundingBoardRows,
} from './funding-rates.js';
import {
  FundingSettlementBoard,
  type FundingBoardSort,
  type FundingPairBoardRow,
  type FundingSettlementLeg,
} from './funding-settlement-board.js';
import type { ExchangeLogoId } from './exchange-logos.js';
import {
  FUNDING_VENUE_COLORS,
  SEED_ASSETS,
  VenueIcon,
  assetIcon,
  assetName,
  exchanges,
  fundingVenueName,
  type PairedPositionPrefill,
  type FundingMetric,
  type FundingSortKey,
  type SortDirection,
} from './route-shared.js';
import { useLanguage } from './i18n.js';
import { FundingArbPanel } from './funding-arb-panel.js';

const FundingHistoryChart = lazy(() => import('./charts.js').then((module) => ({ default: module.FundingHistoryChart })));

interface FundingPairRow {
  asset: string;
  name: string;
  icon: string;
  /** Native percent per venue settlement, aligned with `exchanges`. */
  rates: Array<number | null>;
  /** Comparable 8h percent, aligned with `exchanges`. */
  rates8h: Array<number | null>;
  /** Native funding interval in hours, aligned with `exchanges`. */
  intervalHours: Array<number | null>;
  /** Preferred CrossEx symbol per venue, used to request realized funding history. */
  symbols: Array<string | null>;
  /** Whether the venue lists the pair at all, aligned with `exchanges`. */
  listed: boolean[];
  /** Aggregate open interest in USD across venues reporting it. */
  oi: number;
  /** Mean open interest per venue reporting it — the filterable metric. */
  avgOi: number;
  oiVenues: number;
}

type FundingHistoryDuration = 1 | 7 | 30;
type FundingHistoryCache = Record<FundingHistoryDuration, Record<string, FundingHistoryEntry>>;
type VisibleFundingExchange = { venue: (typeof exchanges)[number]; index: number };

function isHistoricalMetric(metric: FundingMetric): metric is '24h' | '7d' | '30d' {
  return metric === '24h' || metric === '7d' || metric === '30d';
}

function historyDuration(metric: FundingMetric): FundingHistoryDuration {
  return metric === '24h' ? 1 : metric === '7d' ? 7 : 30;
}

function fundingMetricRate(
  item: FundingPairRow,
  venueIndex: number,
  metric: FundingMetric,
  historyBySymbol: Readonly<Record<string, FundingHistoryEntry>>,
): number | null {
  const currentRate = item.rates[venueIndex];
  if (metric === 'Per interval' || metric === 'APR') {
    return currentFundingMetricRate(currentRate, item.rates8h[venueIndex], metric);
  }
  const symbol = item.symbols[venueIndex];
  const history = symbol ? historyBySymbol[symbol] : undefined;
  if (!history || history.status !== 'ok') return null;
  const historicalRate = metric === '24h' ? history.rate24h : metric === '7d' ? history.rate7d : history.rate30d;
  return cumulativeFundingPercent(historicalRate);
}

function fundingArb(
  item: FundingPairRow,
  visibleExchanges: readonly VisibleFundingExchange[],
  metric: FundingMetric,
  historyBySymbol: Readonly<Record<string, FundingHistoryEntry>>,
): { spread: number | null; low?: { venue: (typeof exchanges)[number]; rate: number }; high?: { venue: (typeof exchanges)[number]; rate: number } } {
  const selectedRates = visibleExchanges.flatMap(({ venue, index }) => {
    const rate = metric === 'Per interval' || metric === 'APR'
      ? currentFundingComparisonRate(item.rates8h[index], metric)
      : fundingMetricRate(item, index, metric, historyBySymbol);
    return rate === null ? [] : [{ venue, rate }];
  });
  if (selectedRates.length < 2) return { spread: null };
  const ordered = [...selectedRates].sort((a, b) => a.rate - b.rate);
  return { spread: ordered[ordered.length - 1].rate - ordered[0].rate, low: ordered[0], high: ordered[ordered.length - 1] };
}

function averageFunding(
  item: FundingPairRow,
  visibleExchanges: readonly VisibleFundingExchange[],
  metric: FundingMetric,
  historyBySymbol: Readonly<Record<string, FundingHistoryEntry>>,
) {
  return averageAvailableFundingRate(
    item.rates.map((_rate, index) => metric === 'Per interval' || metric === 'APR'
      ? currentFundingComparisonRate(item.rates8h[index], metric)
      : fundingMetricRate(item, index, metric, historyBySymbol)),
    item.listed,
    visibleExchanges.map(({ index }) => index),
  );
}

function sortedFundingOrder(
  rows: readonly FundingPairRow[],
  sortKey: FundingSortKey,
  direction: SortDirection,
  visibleExchanges: readonly VisibleFundingExchange[],
  metric: FundingMetric,
  historyBySymbol: Readonly<Record<string, FundingHistoryEntry>>,
): string[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...rows].sort((leftRow, rightRow) => {
    if (sortKey === 'asset') return leftRow.asset.localeCompare(rightRow.asset) * multiplier;
    if (sortKey === 'oi') return (leftRow.oi - rightRow.oi) * multiplier || leftRow.asset.localeCompare(rightRow.asset);
    const exchangeIndex = exchanges.findIndex((venue) => venue.id === sortKey);
    const left = sortKey === 'arb' ? fundingArb(leftRow, visibleExchanges, metric, historyBySymbol).spread
      : sortKey === 'average' ? averageFunding(leftRow, visibleExchanges, metric, historyBySymbol).rate
        : fundingMetricRate(leftRow, exchangeIndex, metric, historyBySymbol);
    const right = sortKey === 'arb' ? fundingArb(rightRow, visibleExchanges, metric, historyBySymbol).spread
      : sortKey === 'average' ? averageFunding(rightRow, visibleExchanges, metric, historyBySymbol).rate
        : fundingMetricRate(rightRow, exchangeIndex, metric, historyBySymbol);
    if (left === null && right === null) return leftRow.asset.localeCompare(rightRow.asset);
    if (left === null) return 1;
    if (right === null) return -1;
    return (left - right) * multiplier || leftRow.asset.localeCompare(rightRow.asset);
  }).map((row) => row.asset);
}

const OI_FILTER_PRESETS = [
  { label: 'Any', millions: 0 }, { label: '$1M', millions: 1 }, { label: '$5M', millions: 5 },
  { label: '$10M', millions: 10 }, { label: '$50M', millions: 50 },
];
const FUNDING_PAGE_SIZES = [25, 50, 100];
const DEFAULT_MIN_AVG_OI_MILLIONS = '5';
const FUNDING_OVERVIEW_POLL_MS = 30_000;
/** One bar per settlement in the board's trailing strip. */
const FUNDING_BOARD_SETTLEMENT_LIMIT = 8;
/** The settlements endpoint accepts at most 120 symbols per call. */
const FUNDING_SETTLEMENT_BATCH = 120;

/**
 * Project one funding-overview venue row plus its cached settlements into a pair leg.
 *
 * Live and settled figures stay in separate fields: `ratePercent` is what the venue will charge at
 * the next settlement, `recentPercent` is what it already charged. `rate8hPercent` comes from the
 * venue's own 8h-normalized rate when published, and is derived from the native rate and the
 * venue's interval otherwise, so pairs with different intervals stay comparable.
 */
function legFromOverview(
  asset: string,
  entry: FundingOverviewVenueEntry,
  settlement: FundingSettlementSummary | undefined,
  status: FundingSettlementLeg['settlementStatus'],
): FundingSettlementLeg | null {
  const exchange = exchanges.find((item) => item.id === entry.venue.toLowerCase());
  if (!exchange) return null;
  const ratePercent = fundingFractionToPercent(entry.fundingRate);
  const rate8hPercent = entry.fundingRate8h !== null
    ? fundingFractionToPercent(entry.fundingRate8h)
    : fundingPercentScaledTo8h(ratePercent, entry.fundingIntervalHours);
  const recentPercent = (settlement?.recent ?? []).flatMap((point) => {
    const percent = fundingFractionToPercent(point.rate);
    return percent === null ? [] : [percent];
  });
  const openInterest = entry.openInterestValue === null ? Number.NaN : Number(entry.openInterestValue);
  const lastPrice = entry.lastPrice === null ? Number.NaN : Number(entry.lastPrice);
  return {
    key: `${entry.venue}:${entry.symbol}`,
    asset,
    venue: exchange.id,
    venueName: exchange.name,
    venueShort: exchange.short,
    symbol: entry.symbol,
    ratePercent,
    rate8hPercent,
    intervalHours: entry.fundingIntervalHours,
    nextFundingAt: entry.nextFundingAt,
    recentPercent,
    recentMeanPercent: fundingFractionToPercent(settlement?.recentMeanRate),
    latestSettledPercent: fundingFractionToPercent(settlement?.latestRate),
    latestSettledAt: settlement?.latestSettledAt ?? null,
    settlementCount: settlement?.settlementCount ?? 0,
    settlementStatus: status,
    openInterest: Number.isFinite(openInterest) ? openInterest : 0,
    lastPrice: Number.isFinite(lastPrice) ? lastPrice : null,
    change24hPercent: fundingFractionToPercent(entry.change24h),
  };
}

/**
 * Fallback leg built from the streamed CrossEx market when the venue REST overview is unavailable.
 * A streamed tick carries no settlement interval, so the leg cannot be normalized to 8h and is
 * therefore never paired: the board shows an empty state instead of a spread built on a guess.
 */
function legFromLiveMarket(market: LiveMarket): FundingSettlementLeg | null {
  const exchange = exchanges.find((item) => item.id === market.venue.toLowerCase());
  if (!exchange) return null;
  const openInterest = Number(market.openInterestValue);
  const lastPrice = Number(market.lastPrice);
  return {
    key: `${market.venue}:${market.symbol}`,
    asset: market.asset,
    venue: exchange.id,
    venueName: exchange.name,
    venueShort: exchange.short,
    symbol: market.symbol,
    ratePercent: fundingFractionToPercent(market.fundingRate),
    rate8hPercent: null,
    intervalHours: null,
    nextFundingAt: market.nextFundingAt,
    recentPercent: [],
    recentMeanPercent: null,
    latestSettledPercent: null,
    latestSettledAt: null,
    settlementCount: 0,
    settlementStatus: 'unavailable',
    openInterest: Number.isFinite(openInterest) ? openInterest : 0,
    lastPrice: Number.isFinite(lastPrice) ? lastPrice : null,
    change24hPercent: null,
  };
}

/** The earlier of two settlement times, or the one that exists; null when neither publishes one. */
function earliestSettlement(left: string | null, right: string | null): string | null {
  const leftAt = left ? Date.parse(left) : Number.NaN;
  const rightAt = right ? Date.parse(right) : Number.NaN;
  if (Number.isFinite(leftAt) && Number.isFinite(rightAt)) return leftAt <= rightAt ? left : right;
  return Number.isFinite(leftAt) ? left : Number.isFinite(rightAt) ? right : null;
}

/** Binding liquidity of a pair: the smaller published leg OI, falling back to the known side. */
function bindingOpenInterest(left: number, right: number): number {
  if (left > 0 && right > 0) return Math.min(left, right);
  return Math.max(left, right);
}

type FundingDetailDuration = 1 | 7 | 30;
type FundingDetailMode = 'settlement' | 'cumulative';

interface FundingDetailVenueRow {
  symbol: string;
  venue: string;
  name: string;
  color: string;
  mean: number;
  min: number;
  max: number;
  latest: number;
  cumulative: number;
  settlements: number;
  fetchedAt: string;
}

export function FundingDetailView({ asset, onBack, fundingOverview, onFundingOverview }: {
  asset: string;
  onBack: () => void;
  fundingOverview: FundingOverviewResponse | null;
  onFundingOverview: (overview: FundingOverviewResponse) => void;
}) {
  const { t, language, theme } = useLanguage();
  const [duration, setDuration] = useState<FundingDetailDuration>(30);
  const [mode, setMode] = useState<FundingDetailMode>('cumulative');
  const [venues, setVenues] = useState<FundingOverviewVenueEntry[]>(() =>
    fundingOverview?.assets.find((entry) => entry.asset === asset)?.venues ?? []);
  const [seriesBySymbol, setSeriesBySymbol] = useState<Record<string, FundingHistorySeriesEntry>>({});
  const [rangeFrom, setRangeFrom] = useState<number | null>(null);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(false);
  const locale = language === 'zh' ? 'zh-CN' : 'en-GB';

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const cached = fundingOverview?.assets.find((entry) => entry.asset === asset);
    if (cached) {
      setVenues(cached.venues);
      return () => { cancelled = true; };
    }
    if (fundingOverview) {
      setVenues([]);
      setFailed(true);
      return () => { cancelled = true; };
    }
    void api.fundingOverview()
      .then((response) => {
        if (cancelled) return;
        onFundingOverview(response);
        const selected = response.assets.find((entry) => entry.asset === asset);
        if (!selected) {
          setFailed(true);
          setVenues([]);
          return;
        }
        setVenues(selected.venues);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [asset, fundingOverview, onFundingOverview]);

  useEffect(() => {
    if (venues.length === 0) return;
    let cancelled = false;
    setSeriesBySymbol({});
    setRangeFrom(null);
    setPending(venues.length);
    setFailed(false);
    const symbols = [...new Set(venues.map((venue) => venue.symbol))];
    // The series endpoint caps one request at 7 symbols. Assets such as BTC list 8 venues, so the
    // detail page must batch: sending all symbols at once returned 400 and the page rendered
    // "Funding history unavailable" for every venue.
    const batches: string[][] = [];
    for (let offset = 0; offset < symbols.length; offset += 7) batches.push(symbols.slice(offset, offset + 7));
    setPending(batches.length);
    void Promise.all(batches.map(async (batch) => {
      try {
        return await api.fundingHistorySeries(batch, duration);
      } catch {
        return null;
      }
    }))
      .then((responses) => {
        if (cancelled) return;
        const entries: Record<string, FundingHistorySeriesEntry> = {};
        let from = Number.POSITIVE_INFINITY;
        for (const response of responses) {
          if (!response) continue;
          if (Number.isFinite(response.from)) from = Math.min(from, response.from);
          for (const entry of response.entries) entries[entry.symbol] = entry;
        }
        if (Object.keys(entries).length === 0) {
          setFailed(true);
          setSeriesBySymbol({});
        } else {
          setSeriesBySymbol(entries);
          setRangeFrom(Number.isFinite(from) ? from : null);
          setFailed(false);
        }
      })
      .finally(() => { if (!cancelled) setPending(0); });
    return () => { cancelled = true; };
  }, [duration, venues]);

  const chartSeries = useMemo<FundingChartSeries[]>(() => venues.flatMap((venue) => {
    const entry = seriesBySymbol[venue.symbol];
    if (!entry || entry.status !== 'ok' || entry.points.length === 0) return [];
    const points = mode === 'cumulative'
      ? cumulativeFundingHistory(entry.points, rangeFrom)
      : entry.points.flatMap((point) => {
          const rate = Number(point.rate) * 100;
          return Number.isFinite(rate) ? [{ time: point.timestamp, value: rate }] : [];
        });
    return [{
      id: venue.symbol,
      label: fundingVenueName(venue.venue),
      color: FUNDING_VENUE_COLORS[venue.venue] ?? '#8aa9ff',
      points,
    }];
  }), [mode, rangeFrom, seriesBySymbol, venues]);

  const rows = useMemo<FundingDetailVenueRow[]>(() => venues.flatMap((venue) => {
    const entry = seriesBySymbol[venue.symbol];
    if (!entry || entry.status !== 'ok') return [];
    const rates = entry.points.map((point) => Number(point.rate) * 100).filter(Number.isFinite);
    if (rates.length === 0) return [];
    const cumulative = rates.reduce((total, rate) => total + rate, 0);
    return [{
      symbol: venue.symbol,
      venue: venue.venue,
      name: fundingVenueName(venue.venue),
      color: FUNDING_VENUE_COLORS[venue.venue] ?? '#8aa9ff',
      mean: cumulative / rates.length,
      min: Math.min(...rates),
      max: Math.max(...rates),
      latest: rates[rates.length - 1] ?? 0,
      cumulative,
      settlements: rates.length,
      fetchedAt: entry.fetchedAt,
    }];
  }).sort((left, right) => right.cumulative - left.cumulative), [seriesBySymbol, venues]);

  const lastUpdatedAt = rows.reduce<number>((newest, row) => {
    const timestamp = Date.parse(row.fetchedAt);
    return Number.isFinite(timestamp) ? Math.max(newest, timestamp) : newest;
  }, Number.NEGATIVE_INFINITY);
  const lastUpdatedText = Number.isFinite(lastUpdatedAt)
    ? new Date(lastUpdatedAt).toLocaleString(locale, {
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      })
    : '—';
  const formatPercent = (value: number, digits = 4) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;

  return <div className="alternate-view funding-detail-view">
    <button className="funding-detail-back" onClick={onBack}><span>←</span>{t('Back to funding rates')}</button>
    <section className="view-heading funding-detail-heading">
      <div className="funding-detail-title">
        <span className="funding-detail-asset">{assetIcon(asset)}</span>
        <div><p className="eyebrow">{asset} · {t('Perpetual futures')}</p><h1>{t('Historical funding')}</h1><p>{t('Realized settlement history across every listed venue.')}</p></div>
      </div>
      <div className="funding-detail-updated"><span>{t('Last updated at')}</span><strong>{lastUpdatedText}</strong><small>{duration}D · {rows.length}/{venues.length || '—'} {t('Exchanges').toLowerCase()}</small></div>
    </section>

    <section className="funding-detail-card terminal-panel">
      <header className="funding-detail-card-head">
        <div><p className="eyebrow">{asset} · {duration}D</p><h2>{t(mode === 'cumulative' ? 'Cumulative funding' : 'Settlement funding')}</h2><small>{t(mode === 'cumulative' ? 'What a position would have paid / earned' : 'Actual rates paid at each settlement')}</small></div>
        <div className="funding-detail-controls">
          <div><span>{t('Duration')}</span>{([1, 7, 30] as FundingDetailDuration[]).map((value) => <button key={value} className={duration === value ? 'active' : ''} onClick={() => setDuration(value)}>{value === 1 ? '24h' : `${value}d`}</button>)}</div>
          <div><button className={mode === 'settlement' ? 'active' : ''} onClick={() => setMode('settlement')}>{t('Per settlement')}</button><button className={mode === 'cumulative' ? 'active' : ''} onClick={() => setMode('cumulative')}>{t('Cumulative')}</button></div>
        </div>
      </header>

      <div className="funding-detail-chart-wrap">
        <Suspense fallback={<div className="funding-history-chart chart-module-loading" role="status">{t('Loading venue histories…')}</div>}>
          <FundingHistoryChart
            series={chartSeries}
            seriesKey={`${asset}:${duration}:${mode}`}
            theme={theme}
            locale={locale}
            placeholder={pending > 0 ? t('Loading venue histories…') : t('Funding history unavailable.')}
            showDataTable={false}
          />
        </Suspense>
        <div className="funding-detail-legend">{chartSeries.map((item) => {
          const latest = item.points[item.points.length - 1]?.value;
          return <span key={item.id}><i style={{ background: item.color }} /><strong>{item.label}</strong><em>{latest === undefined ? '—' : formatPercent(latest)}</em></span>;
        })}</div>
      </div>

      <div className="funding-detail-table-wrap">
        <table className="funding-detail-table">
          <thead><tr><th>{t('Exchange')}</th><th>{t('Mean')}</th><th>{t('Min')}</th><th>{t('Max')}</th><th>{t('Latest')}</th><th>{t('Cumulative')}</th><th>{t('Settlements')}</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.symbol}>
            <td><i style={{ background: row.color }} /><span><strong>{row.name}</strong><small>{row.symbol}</small></span></td>
            <td className={row.mean >= 0 ? 'positive' : 'negative'}>{formatPercent(row.mean)}</td>
            <td className={row.min >= 0 ? 'positive' : 'negative'}>{formatPercent(row.min)}</td>
            <td className={row.max >= 0 ? 'positive' : 'negative'}>{formatPercent(row.max)}</td>
            <td className={row.latest >= 0 ? 'positive' : 'negative'}>{formatPercent(row.latest)}</td>
            <td className={row.cumulative >= 0 ? 'positive' : 'negative'}><strong>{formatPercent(row.cumulative)}</strong></td>
            <td>{row.settlements}</td>
          </tr>)}</tbody>
        </table>
        {rows.length === 0 && <div className={`funding-detail-empty${failed ? ' error' : ''}`}>{pending > 0 ? t('Loading venue histories…') : t('Funding history unavailable.')}</div>}
      </div>
      <footer className="funding-detail-footer"><span><i /> {t('Historical settlements stored locally · latest tail refreshed ~15m')}</span><span>{t('Select a duration or chart mode to explore realized funding.')}</span></footer>
    </section>
  </div>;
}
export function FundingRatesView({ marketSnapshot, onMarketFallback, onOpenAsset, onOpenStrategy, metric, onMetricChange, fundingOverview, onFundingOverview, fundingHistoryCache, onFundingHistoryEntries, onOpenModeDialog }: {
  marketSnapshot: MarketSnapshot | null;
  onMarketFallback: () => Promise<void>;
  onOpenAsset: (asset: string) => void;
  onOpenStrategy: (prefill: PairedPositionPrefill) => void;
  metric: FundingMetric;
  onMetricChange: (metric: FundingMetric) => void;
  fundingOverview: FundingOverviewResponse | null;
  onFundingOverview: (overview: FundingOverviewResponse) => void;
  fundingHistoryCache: FundingHistoryCache;
  onFundingHistoryEntries: (duration: FundingHistoryDuration, entries: FundingHistoryEntry[]) => void;
  onOpenModeDialog: () => void;
}) {
  const { t, language } = useLanguage();
  const [query, setQuery] = useState('');
  const [selectedExchanges, setSelectedExchanges] = useState(exchanges.map((exchange) => exchange.id));
  const [sortKey, setSortKey] = useState<FundingSortKey>('oi');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [overviewState, setOverviewState] = useState<'loading' | 'live' | 'failed'>(fundingOverview ? 'live' : 'loading');
  const [historyPending, setHistoryPending] = useState<Set<string>>(() => new Set());
  const [historyRefreshTick, setHistoryRefreshTick] = useState(0);
  const historySymbolsRef = useRef<string[]>([]);
  const marketFallbackRequestedRef = useRef(false);
  const initialOverviewRef = useRef(fundingOverview);
  const sortRequestRef = useRef(0);
  const [preparingSort, setPreparingSort] = useState<FundingSortKey | null>(null);
  const [minOiMillionsText, setMinOiMillionsText] = useState(DEFAULT_MIN_AVG_OI_MILLIONS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  /**
   * Which lens the page opens on. The settlement board is the default because the question
   * "should I enter now" is answered by the live rate and its next settlement, not by a rolling
   * total; the asset matrix stays one click away and keeps its own metric switch.
   */
  const [lens, setLens] = useState<'settlements' | 'matrix'>('settlements');
  const [boardSortKey, setBoardSortKey] = useState<FundingBoardSort>('apr');
  const [boardSortDirection, setBoardSortDirection] = useState<SortDirection>('desc');
  /** One clock for every countdown on the board, so all rows tick together once a second. */
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [settlementsBySymbol, setSettlementsBySymbol] = useState<Record<string, FundingSettlementSummary>>({});
  const [settlementsLoading, setSettlementsLoading] = useState(false);
  const settlementSymbolsRef = useRef<string[]>([]);

  useEffect(() => {
    if (lens !== 'settlements') return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [lens]);

  // Poll the all-pairs overview while this page is mounted. Returning from a detail page can reuse
  // the parent cache until its normal refresh boundary instead of immediately requesting it again.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = () => {
      api.fundingOverview()
        .then((response) => { if (!cancelled) { onFundingOverview(response); setOverviewState('live'); } })
        .catch(() => {
          if (cancelled) return;
          setOverviewState((current) => current === 'live' ? 'live' : 'failed');
          if (!marketFallbackRequestedRef.current) {
            marketFallbackRequestedRef.current = true;
            void onMarketFallback().catch(() => undefined);
          }
        })
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(load, FUNDING_OVERVIEW_POLL_MS);
        });
    };
    const cachedAt = Date.parse(initialOverviewRef.current?.fetchedAt ?? '');
    const initialDelay = Number.isFinite(cachedAt)
      ? Math.min(FUNDING_OVERVIEW_POLL_MS, Math.max(0, FUNDING_OVERVIEW_POLL_MS - (Date.now() - cachedAt)))
      : 0;
    timer = window.setTimeout(load, initialDelay);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [onFundingOverview, onMarketFallback]);

  const overview = fundingOverview;
  const historicalMetric = isHistoricalMetric(metric);
  const historyDurationDays = historyDuration(metric);
  const historyBySymbol = fundingHistoryCache[historyDurationDays];
  const historyBySymbolRef = useRef<Record<string, FundingHistoryEntry>>(historyBySymbol);
  historyBySymbolRef.current = historyBySymbol;

  const allPairs = useMemo<FundingPairRow[]>(() => {
    const overviewAssets = new Map<string, FundingOverviewAsset>();
    for (const item of overview?.assets ?? []) overviewAssets.set(item.asset, item);
    const codes = new Set<string>(overviewAssets.keys());
    const useFallback = !overview && overviewState === 'failed';
    if (useFallback) for (const market of marketSnapshot?.markets ?? []) codes.add(market.asset);
    if (useFallback && codes.size === 0) for (const asset of SEED_ASSETS) codes.add(asset);
    const hubMarkets = new Map<string, LiveMarket>();
    for (const market of marketSnapshot?.markets ?? []) hubMarkets.set(`${market.venue}:${market.asset}`, market);
    return [...codes].map((asset) => {
      const entryByVenue = new Map<string, FundingOverviewVenueEntry>();
      for (const entry of overviewAssets.get(asset)?.venues ?? []) entryByVenue.set(entry.venue, entry);
      const rates: Array<number | null> = [];
      const rates8h: Array<number | null> = [];
      const intervalHours: Array<number | null> = [];
      const symbols: Array<string | null> = [];
      const listed: boolean[] = [];
      let oi = 0;
      let oiVenues = 0;
      for (const exchange of exchanges) {
        const venueCode = exchange.id.toUpperCase();
        const entry = entryByVenue.get(venueCode);
        const hub = hubMarkets.get(`${venueCode}:${asset}`);
        const hubLive = hub && hub.source === 'gate_crossex_websocket' ? hub : null;
        // Venue REST first for page-wide consistency, live CrossEx pushes fill its gaps; seed
        // values appear only while no overview exists at all (cold start / REST outage).
        const interval = entry?.fundingIntervalHours ?? null;
        const rate = entry?.fundingRate != null ? Number(entry.fundingRate) * 100
          : hubLive ? Number(hubLive.fundingRate) * 100
            : useFallback && hub ? Number(hub.fundingRate) * 100 : null;
        const rate8h = entry?.fundingRate8h != null ? Number(entry.fundingRate8h) * 100
          : fundingPercentScaledTo8h(rate, interval);
        const venueOi = entry?.openInterestValue != null ? Number(entry.openInterestValue)
          : hubLive && Number(hubLive.openInterestValue) > 0 ? Number(hubLive.openInterestValue)
            : useFallback && hub ? Number(hub.openInterestValue) : 0;
        if (Number.isFinite(venueOi) && venueOi > 0) { oi += venueOi; oiVenues += 1; }
        rates.push(rate !== null && Number.isFinite(rate) ? rate : null);
        rates8h.push(rate8h !== null && Number.isFinite(rate8h) ? rate8h : null);
        intervalHours.push(interval);
        symbols.push(entry?.symbol ?? null);
        listed.push(Boolean(entry) || Boolean(hub));
      }
      return { asset, name: assetName(asset), icon: assetIcon(asset), rates, rates8h, intervalHours, symbols, listed, oi, avgOi: oiVenues > 0 ? oi / oiVenues : 0, oiVenues };
    });
  }, [overview, overviewState, marketSnapshot]);

  /**
   * Legs before pairing: one entry per venue contract from the REST overview, or the streamed
   * markets when that overview is unavailable (those carry no interval and never pair).
   */
  const contractSources = useMemo(() => {
    const sources: Array<{ asset: string; entry: FundingOverviewVenueEntry } | { market: LiveMarket }> = [];
    for (const assetEntry of overview?.assets ?? []) {
      for (const venueEntry of assetEntry.venues) sources.push({ asset: assetEntry.asset, entry: venueEntry });
    }
    if (sources.length === 0 && overviewState === 'failed') {
      for (const market of marketSnapshot?.markets ?? []) sources.push({ market });
    }
    return sources;
  }, [overview, overviewState, marketSnapshot]);

  /**
   * Every tradable venue pair of every asset. Funding arbitrage is a two-leg position, so the row
   * model is the combination — one row per (asset, long venue, short venue). Combinations are
   * confined to the same asset across distinct venues, and only legs that publish both a rate and
   * an interval take part, which bounds the fan-out at C(venues, 2) per asset.
   */
  const boardRows = useMemo<FundingPairBoardRow[]>(() => {
    const legsByAsset = new Map<string, FundingSettlementLeg[]>();
    for (const source of contractSources) {
      if ('market' in source) {
        const leg = legFromLiveMarket(source.market);
        if (!leg) continue;
        const legs = legsByAsset.get(leg.asset) ?? [];
        legs.push(leg);
        legsByAsset.set(leg.asset, legs);
        continue;
      }
      const settlement = settlementsBySymbol[source.entry.symbol];
      const status: FundingSettlementLeg['settlementStatus'] = settlement
        ? settlement.status
        : settlementsLoading ? 'loading' : 'unavailable';
      const leg = legFromOverview(source.asset, source.entry, settlement, status);
      if (!leg) continue;
      const legs = legsByAsset.get(leg.asset) ?? [];
      legs.push(leg);
      legsByAsset.set(leg.asset, legs);
    }
    const rows: FundingPairBoardRow[] = [];
    for (const [asset, legs] of legsByAsset) {
      for (const pair of pairFundingLegs(legs)) {
        rows.push({
          key: `${asset}:${pair.long.venue}:${pair.short.venue}`,
          asset,
          name: assetName(asset),
          icon: assetIcon(asset),
          symbol: `${pair.long.venue}:${pair.short.venue}`,
          long: pair.long,
          short: pair.short,
          spreadPercent: pair.spread8hPercent,
          annualizedPercent: fundingPairAnnualizedPercent(pair.spread8hPercent),
          currentRatePercent: pair.long.ratePercent,
          latestSettledPercent: pair.long.latestSettledPercent,
          nextFundingAt: earliestSettlement(pair.long.nextFundingAt, pair.short.nextFundingAt),
          openInterest: bindingOpenInterest(pair.long.openInterest, pair.short.openInterest),
          change24hPercent: pair.long.change24hPercent,
          lastPrice: pair.long.lastPrice,
        });
      }
    }
    return rows;
  }, [contractSources, settlementsBySymbol, settlementsLoading]);

  const parsedMinOi = Number(minOiMillionsText);  const minAvgOiUsd = Number.isFinite(parsedMinOi) && parsedMinOi > 0 ? parsedMinOi * 1_000_000 : 0;
  const visibleExchanges = useMemo(
    () => exchanges.map((venue, index) => ({ venue, index })).filter(({ venue }) => selectedExchanges.includes(venue.id)),
    [selectedExchanges],
  );

  const metricRate = useCallback((item: FundingPairRow, venueIndex: number): number | null => {
    return fundingMetricRate(item, venueIndex, metric, historyBySymbol);
  }, [historyBySymbol, metric]);

  const getArb = useCallback((item: FundingPairRow) => {
    return fundingArb(item, visibleExchanges, metric, historyBySymbol);
  }, [historyBySymbol, metric, visibleExchanges]);

  const getAverage = useCallback((item: FundingPairRow) => {
    return averageFunding(item, visibleExchanges, metric, historyBySymbol);
  }, [historyBySymbol, metric, visibleExchanges]);

  const matchedMarkets = useMemo(() => allPairs.filter((item) =>
    `${item.asset} ${item.name}`.toLowerCase().includes(query.toLowerCase()) && item.avgOi >= minAvgOiUsd
  ), [allPairs, query, minAvgOiUsd]);
  const liveOrder = useMemo(
    () => sortedFundingOrder(matchedMarkets, sortKey, sortDirection, visibleExchanges, metric, historyBySymbol),
    [matchedMarkets, sortKey, sortDirection, visibleExchanges, metric, historyBySymbol],
  );
  const [appliedOrder, setAppliedOrder] = useState<string[]>(() => liveOrder);
  const orderInitializedRef = useRef(liveOrder.length > 0);
  useEffect(() => {
    if (orderInitializedRef.current || liveOrder.length === 0) return;
    orderInitializedRef.current = true;
    setAppliedOrder(liveOrder);
  }, [liveOrder]);
  const filteredMarkets = useMemo(
    () => applyFundingAssetOrder(matchedMarkets, appliedOrder.length > 0 ? appliedOrder : liveOrder),
    [matchedMarkets, appliedOrder, liveOrder],
  );

  const totalPages = Math.max(1, Math.ceil(filteredMarkets.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const visibleMarkets = useMemo(
    () => filteredMarkets.slice(pageStart, pageStart + pageSize),
    [filteredMarkets, pageStart, pageSize],
  );
  const maxOi = Math.max(...filteredMarkets.map((item) => item.oi), 1);

  /* ---------------------------------------------------------------------------------------------
   * Settlement board (the default lens).
   * ------------------------------------------------------------------------------------------- */
  const boardFiltered = useMemo(() => boardRows.filter((row) => {
    // Both legs must be tradable in the current exchange selection: a pair you can only open on
    // one side is not an opportunity.
    if (!selectedExchanges.some((id) => id === row.long.venue)) return false;
    if (!selectedExchanges.some((id) => id === row.short.venue)) return false;
    if (row.openInterest < minAvgOiUsd) return false;
    if (query === '') return true;
    return `${row.asset} ${row.name} ${row.long.symbol} ${row.short.symbol}`.toLowerCase().includes(query.toLowerCase());
  }), [boardRows, minAvgOiUsd, query, selectedExchanges]);
  const boardSorted = useMemo(
    () => sortFundingBoardRows(boardFiltered, boardSortKey, boardSortDirection),
    [boardFiltered, boardSortDirection, boardSortKey],
  );
  const boardTotalPages = Math.max(1, Math.ceil(boardSorted.length / pageSize));
  const boardCurrentPage = Math.min(page, boardTotalPages);
  const boardPageStart = (boardCurrentPage - 1) * pageSize;
  const boardPageRows = useMemo(
    () => boardSorted.slice(boardPageStart, boardPageStart + pageSize),
    [boardSorted, boardPageStart, pageSize],
  );
  /**
   * Settled rates are display-only (sorts use the live rates), so only the visible page's legs are
   * requested: at 50 rows × 2 legs that is one batch per page instead of a page-wide sweep.
   */
  const boardSymbolKey = useMemo(() => {
    const symbols = new Set<string>();
    for (const row of boardPageRows) {
      symbols.add(row.long.symbol);
      symbols.add(row.short.symbol);
    }
    return [...symbols].sort().join('|');
  }, [boardPageRows]);
  settlementSymbolsRef.current = boardSymbolKey === '' ? [] : boardSymbolKey.split('|');

  useEffect(() => {
    if (lens !== 'settlements') return;
    if (boardSymbolKey === '') {
      setSettlementsLoading(false);
      return;
    }
    const symbols = boardSymbolKey.split('|');
    const batches: string[][] = [];
    for (let offset = 0; offset < symbols.length; offset += FUNDING_SETTLEMENT_BATCH) {
      batches.push(symbols.slice(offset, offset + FUNDING_SETTLEMENT_BATCH));
    }
    let cancelled = false;
    setSettlementsLoading(true);
    void Promise.all(batches.map(async (batch) => {
      try {
        return await api.fundingSettlements(batch, FUNDING_BOARD_SETTLEMENT_LIMIT);
      } catch {
        // A failed batch leaves those rows on their previous (or empty) settlements: the board
        // renders "no settled rates yet" rather than inventing zeros.
        return null;
      }
    })).then((responses) => {
      if (cancelled) return;
      setSettlementsBySymbol((current) => {
        const next: Record<string, FundingSettlementSummary> = { ...current };
        for (const response of responses) {
          if (!response) continue;
          for (const entry of response.entries) next[entry.symbol] = entry;
        }
        return next;
      });
    }).finally(() => {
      if (!cancelled) setSettlementsLoading(false);
    });
    return () => { cancelled = true; };
  }, [boardSymbolKey, lens]);

  /** Pagination is shared by both lenses; only the unit of a row differs. */
  const listTotal = lens === 'settlements' ? boardSorted.length : filteredMarkets.length;
  const listTotalPages = lens === 'settlements' ? boardTotalPages : totalPages;
  const listCurrentPage = lens === 'settlements' ? boardCurrentPage : currentPage;
  const listPageStart = lens === 'settlements' ? boardPageStart : pageStart;
  const listUnit = t('pairs');
  const historySymbols = useMemo(() => {
    if (metric !== '24h' && metric !== '7d' && metric !== '30d') return [];
    const symbols = new Set<string>();
    for (const item of visibleMarkets) for (const { index } of visibleExchanges) {
      const symbol = item.symbols[index];
      if (symbol) symbols.add(symbol);
    }
    return [...symbols];
  }, [metric, visibleMarkets, visibleExchanges]);
  const historyRequestKey = `${historyDurationDays}:${fundingHistoryRequestKey(historySymbols)}`;
  historySymbolsRef.current = historySymbols;
  const historicalUpdatedAt = historicalMetric
    ? historySymbols.reduce<number>((newest, symbol) => {
        const entry = historyBySymbol[symbol];
        if (entry?.status !== 'ok') return newest;
        const timestamp = Date.parse(entry.fetchedAt);
        return Number.isFinite(timestamp) ? Math.max(newest, timestamp) : newest;
      }, Number.NEGATIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;
  const currentUpdatedAt = Date.parse(overview?.fetchedAt ?? marketSnapshot?.updatedAt ?? '');
  const lastUpdatedAt = historicalMetric && Number.isFinite(historicalUpdatedAt)
    ? historicalUpdatedAt
    : currentUpdatedAt;
  const lastUpdatedIso = Number.isFinite(lastUpdatedAt) ? new Date(lastUpdatedAt).toISOString() : undefined;
  const lastUpdatedText = Number.isFinite(lastUpdatedAt)
    ? new Date(lastUpdatedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : '—';

  useEffect(() => {
    const requestedSymbols = historySymbolsRef.current.filter(
      (symbol) => {
        const entry = historyBySymbolRef.current[symbol];
        if (entry?.status === 'unavailable') return false;
        if (entry?.status !== 'ok') return true;
        return historyDurationDays === 1 ? entry.rate24h === null
          : historyDurationDays === 7 ? entry.rate7d === null
            : entry.rate30d === null;
      },
    );
    if (requestedSymbols.length === 0) {
      setHistoryPending((current) => current.size === 0 ? current : new Set());
      return;
    }
    let cancelled = false;
    let retryTimer: number | undefined;
    const load = async () => {
      setHistoryPending(new Set(requestedSymbols));
      const batches: string[][] = [];
      for (let offset = 0; offset < requestedSymbols.length; offset += 50) {
        batches.push(requestedSymbols.slice(offset, offset + 50));
      }
      // The endpoint is SQLite-first and returns immediately. Launch every batch
      // together so missing venue ranges can warm in parallel behind cached rows.
      const results = await Promise.all(batches.map(async (batch) => {
        try {
          return { batch, response: await api.fundingHistory(batch, historyDurationDays) };
        } catch {
          return { batch, response: null };
        }
      }));
      if (cancelled) return;

      const retrySymbols = new Set<string>();
      const entries: FundingHistoryEntry[] = [];
      for (const result of results) {
        if (!result.response) {
          for (const symbol of result.batch) retrySymbols.add(symbol);
          continue;
        }
        for (const entry of result.response.entries) {
          entries.push(entry);
          if (entry.status === 'pending') retrySymbols.add(entry.symbol);
        }
      }
      onFundingHistoryEntries(historyDurationDays, entries);
      setHistoryPending(retrySymbols);
      if (retrySymbols.size > 0) {
        retryTimer = window.setTimeout(() => setHistoryRefreshTick((current) => current + 1), 8_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [historyRequestKey, historyDurationDays, historyRefreshTick, onFundingHistoryEntries]);

  function cancelSortPreparation() {
    sortRequestRef.current += 1;
    setPreparingSort(null);
  }

  function toggleExchange(exchangeId: ExchangeLogoId) {
    const removing = selectedExchanges.includes(exchangeId);
    if (removing && selectedExchanges.length === 1) return;
    cancelSortPreparation();
    setSelectedExchanges((current) => removing ? current.filter((id) => id !== exchangeId) : [...current, exchangeId]);
    if (removing && sortKey === exchangeId) {
      const nextOrder = sortedFundingOrder(matchedMarkets, 'oi', 'desc', visibleExchanges, metric, historyBySymbol);
      setPage(1);
      setSortKey('oi');
      setSortDirection('desc');
      setAppliedOrder(nextOrder);
    }
  }

  function symbolsForRanking(): string[] {
    const symbols = new Set<string>();
    const prioritized = [...matchedMarkets].sort((left, right) => right.oi - left.oi);
    for (const item of prioritized) for (const { index } of visibleExchanges) {
      const symbol = item.symbols[index];
      if (symbol) symbols.add(symbol);
    }
    return [...symbols];
  }

  async function applySort(nextKey: FundingSortKey, nextDirection: SortDirection, nextMetric = metric): Promise<void> {
    const requestId = ++sortRequestRef.current;
    const nextDuration = historyDuration(nextMetric);
    let nextHistory = fundingHistoryCache[nextDuration];
    if (isHistoricalMetric(nextMetric) && nextKey !== 'asset' && nextKey !== 'oi') {
      const symbols = symbolsForRanking();
      if (symbols.length > 0) {
        setPreparingSort(nextKey);
        try {
          const response = await api.fundingRankings(symbols, nextDuration);
          if (sortRequestRef.current !== requestId) return;
          nextHistory = { ...nextHistory };
          for (const entry of response.entries) nextHistory[entry.symbol] = entry;
          onFundingHistoryEntries(nextDuration, response.entries);
        } catch {
          if (sortRequestRef.current !== requestId) return;
        }
      }
    }
    if (sortRequestRef.current !== requestId) return;
    setSortKey(nextKey);
    setSortDirection(nextDirection);
    setAppliedOrder(sortedFundingOrder(matchedMarkets, nextKey, nextDirection, visibleExchanges, nextMetric, nextHistory));
    setPreparingSort(null);
  }

  function changeSort(nextKey: FundingSortKey) {
    const nextDirection = sortKey === nextKey
      ? sortDirection === 'desc' ? 'asc' : 'desc'
      : nextKey === 'asset' ? 'asc' : 'desc';
    setPage(1);
    void applySort(nextKey, nextDirection);
  }

  function changeMetric(nextMetric: FundingMetric) {
    if (nextMetric === metric) return;
    onMetricChange(nextMetric);
    if (sortKey !== 'asset' && sortKey !== 'oi') void applySort(sortKey, sortDirection, nextMetric);
    else cancelSortPreparation();
  }

  function sortMark(key: FundingSortKey) {
    if (preparingSort === key) return <span className="sort-mark active" aria-hidden="true">…</span>;
    return <span className={sortKey === key ? 'sort-mark active' : 'sort-mark'}>{sortKey === key ? sortDirection === 'desc' ? '↓' : '↑' : '↕'}</span>;
  }

  function formatRate(rate: number) {
    const digits = metric === 'APR' ? 2 : metric === 'Per interval' ? 4 : 3;
    return `${rate > 0 ? '+' : ''}${rate.toFixed(digits)}%`;
  }

  function formatOi(value: number) {
    if (value <= 0) return '—';
    if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 10_000_000) return `$${Math.round(value / 1_000_000)}M`;
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
    return `$${Math.round(value)}`;
  }

  function formatInterval(hours: number | null) {
    if (hours === null || !Number.isFinite(hours) || hours <= 0) return null;
    return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`;
  }

  if (!overview && overviewState === 'loading') {
    return <div className="alternate-view funding-view">
      <section className="view-heading funding-heading">
        <div><p className="eyebrow">{t('Perpetual futures')}</p><h1>{t('Funding settlements.')}</h1><p>{t('Two-leg venue pairs ranked by their funding spread: each leg\'s live rate, its interval and countdown, and the settlements it already charged.')}</p></div>
      </section>
      <section className="funding-card funding-skeleton terminal-panel" role="status" aria-label={t('Loading all trading pairs…')}>
        <div className="funding-skeleton-filters"><i /><i /><i /><i /><i /></div>
        <div className="funding-skeleton-toolbar"><i /><i /><i /></div>
        <div className="funding-skeleton-table">
          <div className="funding-skeleton-head" />
          {Array.from({ length: 8 }, (_, index) => <div className="funding-skeleton-row" key={index}><i /><i /><i /><i /><i /><i /></div>)}
        </div>
        <span className="sr-only">{t('Loading all trading pairs…')}</span>
      </section>
    </div>;
  }

  return <div className="alternate-view funding-view">
    <section className="view-heading funding-heading">
      <div>
        <p className="eyebrow">{t('Perpetual futures')}</p>
        <h1>{t(lens === 'settlements' ? 'Funding settlements.' : 'Funding rate matrix.')}</h1>
        <p>{t(lens === 'settlements'
          ? 'Two-leg venue pairs ranked by their funding spread: each leg\'s live rate, its interval and countdown, and the settlements it already charged.'
          : 'Compare funding across exchanges, ranked by aggregate open interest.')}</p>
      </div>
    </section>

    <FundingArbPanel onOpenModeDialog={onOpenModeDialog} onOpenPairedPosition={onOpenStrategy} />

    <section className="funding-card terminal-panel">
      <div className="exchange-filter" role="group" aria-label="Filter exchanges">
        <span>{t('Exchanges')}</span>
        {exchanges.map((venue) => <button key={venue.id} role="checkbox" className={selectedExchanges.includes(venue.id) ? 'selected' : ''} aria-checked={selectedExchanges.includes(venue.id)} onClick={() => toggleExchange(venue.id)}><VenueIcon id={venue.id} short={venue.short} />{venue.name}<em>{selectedExchanges.includes(venue.id) ? '✓' : '+'}</em></button>)}
        <small>{selectedExchanges.length} {t('selected')} · {t('at least one required')}</small>
      </div>
      <div className="oi-filter" role="radiogroup" aria-label="Minimum average open interest">
        <span>{t('Min average OI')}</span>
        {OI_FILTER_PRESETS.map((preset) => {
          const active = minAvgOiUsd === preset.millions * 1_000_000;
          return <button key={preset.label} role="radio" className={active ? 'selected' : ''} aria-checked={active} onClick={() => { cancelSortPreparation(); setPage(1); setMinOiMillionsText(preset.millions === 0 ? '' : String(preset.millions)); }}>{preset.label === 'Any' ? t('Any') : preset.label}</button>;
        })}
        <label className="oi-custom"><span>$</span><input inputMode="decimal" value={minOiMillionsText} onChange={(event) => { cancelSortPreparation(); setPage(1); setMinOiMillionsText(event.target.value.replace(/[^0-9.]/g, '')); }} placeholder="0" aria-label={t('Min average OI')} /><span>M</span></label>
        <small>{overviewState === 'loading' && !overview ? t('Loading all trading pairs…') : `${lens === 'settlements' ? boardFiltered.length : filteredMarkets.length} / ${lens === 'settlements' ? boardRows.length : allPairs.length} ${t('pairs')}`}</small>
      </div>
      <div className="funding-toolbar">
        <label className="funding-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => { cancelSortPreparation(); setPage(1); setQuery(event.target.value); }} placeholder={t('Search asset')} aria-label={t('Search asset')} /></label>
        {lens === 'matrix' && <div className="metric-switch" role="radiogroup" aria-label="Funding rate period">
          {(['Per interval', 'APR', '24h', '7d', '30d'] as FundingMetric[]).map((item) => <button key={item} role="radio" className={metric === item ? 'active' : ''} aria-checked={metric === item} onClick={() => changeMetric(item)}>{item === '24h' || item === '7d' || item === '30d' ? t(`Cumulative ${item}`) : t(item)}</button>)}
        </div>}
        {preparingSort && <small className="funding-sort-status" role="status">{t('Preparing sort…')}</small>}
        <small className="funding-last-updated">{t('Last updated at')} <time dateTime={lastUpdatedIso}>{lastUpdatedText}</time></small>
      </div>
      <div className="funding-lens-bar" role="radiogroup" aria-label={t('Funding view')}>
        <button role="radio" aria-checked={lens === 'settlements'} className={lens === 'settlements' ? 'active' : ''} onClick={() => { setLens('settlements'); setPage(1); }}>{t('Per settlement')}</button>
        <button role="radio" aria-checked={lens === 'matrix'} className={lens === 'matrix' ? 'active' : ''} onClick={() => { setLens('matrix'); setPage(1); }}>{t('Asset matrix')}</button>
        <small>{lens === 'settlements'
          ? t('Live rate is each leg next settlement. Bars are settlements already charged.')
          : t('Rolling totals per asset across venues.')}</small>
      </div>
      {lens === 'settlements' && <FundingSettlementBoard
        rows={boardPageRows}
        now={clockNow}
        sortKey={boardSortKey}
        sortDirection={boardSortDirection}
        onSort={(nextKey) => {
          setPage(1);
          if (nextKey === boardSortKey) {
            setBoardSortDirection((current) => current === 'desc' ? 'asc' : 'desc');
            return;
          }
          setBoardSortKey(nextKey);
          setBoardSortDirection(nextKey === 'next' ? 'asc' : 'desc');
        }}
        settlementLimit={FUNDING_BOARD_SETTLEMENT_LIMIT}
      />}
      {lens === 'matrix' && <div className="funding-table-wrap" aria-busy={preparingSort !== null}>
        <table className="funding-table">
          <thead><tr>
            <th><button className="sort-header asset-sort" onClick={() => changeSort('asset')}>{t('Asset')} {sortMark('asset')}</button></th>
            <th><button className="sort-header" onClick={() => changeSort('oi')}>{t('Open interest')} {sortMark('oi')}</button></th>
            <th><button className="sort-header" onClick={() => changeSort('average')}><span><strong>{t('Average rate')}</strong><small>{metric === 'Per interval' ? t('8h equivalent') : t('Tradable venues')}</small></span>{sortMark('average')}</button></th>
            <th><button className="sort-header arb-sort" onClick={() => changeSort('arb')}><span><strong>{t('Max arb')}</strong><small>{metric === 'Per interval' ? t('8h equivalent spread') : t('Best spread')}</small></span>{sortMark('arb')}</button></th>
            {visibleExchanges.map(({ venue }) => <th key={venue.id}><button className="sort-header exchange-sort" onClick={() => changeSort(venue.id as FundingSortKey)}><span className="exchange-heading"><VenueIcon id={venue.id} short={venue.short} /><span><strong>{venue.name}</strong>{sortMark(venue.id as FundingSortKey)}</span></span></button></th>)}
          </tr></thead>
          <tbody>{visibleMarkets.map((item, index) => {
            const arb = getArb(item);
            const lowArb = arb.low;
            const highArb = arb.high;
            const average = getAverage(item);
            return <tr key={item.asset} className="funding-clickable-row" onClick={() => onOpenAsset(item.asset)}>
              <td><button className="funding-history-link" aria-label={`${item.asset} ${t('Historical funding')}`} onClick={(event) => { event.stopPropagation(); onOpenAsset(item.asset); }}><span className={`funding-asset asset-tone-${index % 5}`}>{item.icon}</span><span><strong>{item.asset}</strong><small>{item.name} {t('Perpetual').toLowerCase()}</small></span></button></td>
              <td>{item.oi > 0
                ? <><strong className="oi-value">{formatOi(item.oi)}</strong><span className="oi-bar"><i style={{ width: `${Math.max(4, (item.oi / maxOi) * 100)}%` }} /></span><small className="oi-avg">{t('avg')} {formatOi(item.avgOi)}</small></>
                : <><strong className="oi-value">—</strong><small className="oi-avg">{t('no data')}</small></>}</td>
              <td className="average-funding-cell"><strong className={average.rate === null ? 'funding-rate funding-missing' : 'funding-rate funding-average'}>{average.rate === null ? '—' : formatRate(average.rate)}</strong></td>
              <td className="arb-cell"><div className="arb-cell-layout"><span className="arb-summary"><strong>{arb.spread !== null ? formatRate(arb.spread) : '—'}</strong><small>{visibleExchanges.length <= 1 ? t('Select 2+ exchanges') : arb.spread !== null ? `${t('Long')} ${lowArb?.venue.short} · ${t('Short')} ${highArb?.venue.short}` : t('no data')}</small></span>{lowArb && highArb && <button className="arb-strategy-button" title={t('Open hedge strategy')} aria-label={`${t('Open hedge strategy')}: ${item.asset}, ${t('Long')} ${lowArb.venue.name}, ${t('Short')} ${highArb.venue.name}`} onClick={(event) => {
                event.stopPropagation();
                onOpenStrategy({ asset: item.asset, longVenue: lowArb.venue.id, shortVenue: highArb.venue.id });
              }} onKeyDown={(event) => event.stopPropagation()}><span aria-hidden="true">⇄</span><em>{t('Open')}</em></button>}</div></td>
              {visibleExchanges.map(({ venue, index: rateIndex }) => {
                const historicalMetric = metric === '24h' || metric === '7d' || metric === '30d';
                const symbol = item.symbols[rateIndex];
                const rate = metricRate(item, rateIndex);
                if (rate === null) {
                  const detail = !item.listed[rateIndex] ? t('not listed')
                    : historicalMetric && symbol && (historyPending.has(symbol) || !historyBySymbol[symbol]) ? t('Loading funding history…')
                      : historicalMetric ? t('history unavailable') : t('no data');
                  return <td key={`${item.asset}-${venue.id}`}><strong className="funding-rate funding-missing">{historicalMetric && symbol && (historyPending.has(symbol) || !historyBySymbol[symbol]) ? '…' : '—'}</strong><small>{detail}</small></td>;
                }
                const colorClass = arb.spread !== null && venue.id === arb.high?.venue.id ? 'funding-highest' : arb.spread !== null && venue.id === arb.low?.venue.id ? 'funding-lowest' : 'funding-base';
                const interval = formatInterval(item.intervalHours[rateIndex]);
                return <td key={`${item.asset}-${venue.id}`}><strong className={`funding-rate ${colorClass}`}>{formatRate(rate)}</strong><small className={metric === 'APR' ? undefined : 'funding-period-label'}>{metric === 'APR' ? t('annualized') : metric === 'Per interval' ? `${t('next payment')}${interval ? ` · ${interval}` : ''}` : `${t('cumulative')} ${metric}`}</small></td>;
              })}
            </tr>;
          })}</tbody>
        </table>
        {visibleMarkets.length === 0 && <div className="funding-empty">{
          overviewState === 'loading' && allPairs.every((item) => item.oi <= 0) ? t('Loading all trading pairs…')
            : query ? <>{t('No perpetual markets match')} “{query}”.</>
              : <>{t('No pairs clear the average OI filter.')} {t('Lower the minimum to see more pairs.')}</>
        }</div>}
      </div>}
      {listTotal >= 10 && <div className="funding-pagination">
        <span className="page-range">{listTotal === 0 ? `0 ${listUnit}` : `${listPageStart + 1}–${Math.min(listPageStart + pageSize, listTotal)} / ${listTotal} ${listUnit}`}</span>
        <div className="page-controls">
          <button onClick={() => setPage(1)} disabled={listCurrentPage <= 1} aria-label={t('First page')}>«</button>
          <button onClick={() => setPage(listCurrentPage - 1)} disabled={listCurrentPage <= 1}>{t('Prev')}</button>
          <span className="page-indicator">{t('Page')} {listCurrentPage} / {listTotalPages}</span>
          <button onClick={() => setPage(listCurrentPage + 1)} disabled={listCurrentPage >= listTotalPages}>{t('Next')}</button>
          <button onClick={() => setPage(listTotalPages)} disabled={listCurrentPage >= listTotalPages} aria-label={t('Last page')}>»</button>
        </div>
        <label className="page-size"><select value={pageSize} onChange={(event) => { setPage(1); setPageSize(Number(event.target.value)); }}>{FUNDING_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select><span>{t('per page')}</span></label>
      </div>}
      <footer className="funding-footer">
        <span>
          {overview ? t('Aggregated from venue public REST · refreshed 5m, 30s near settlement') : t(marketSnapshot?.markets.some((market) => market.source === 'gate_crossex_websocket') ? 'Live Gate CrossEx WebSocket' : 'Seed data while awaiting market updates')}
          {overviewState === 'failed' && !overview ? <> · {t('Venue REST unavailable — showing streamed markets only')}</> : null}
          {(overview?.venueStatus.filter((status) => status.status === 'error') ?? []).length > 0
            ? <> · {overview?.venueStatus.filter((status) => status.status === 'error').map((status) => exchanges.find((exchange) => exchange.id === status.venue.toLowerCase())?.name ?? status.venue).join(', ')} {t('unavailable')}</>
            : null}
        </span>
        <span>{lens === 'settlements'
          ? <>{t('Annualized on each contract own settlement interval.')} · {t('Historical settlements stored locally · latest tail refreshed ~15m')}</>
          : <>{t('Click any row to inspect realized funding history.')} · {t('Historical settlements stored locally · latest tail refreshed ~15m')} · {t('OI averaged across venues reporting it')}</>}
        </span>
      </footer>
    </section>
  </div>;
}
