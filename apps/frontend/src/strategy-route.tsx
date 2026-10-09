import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CrossExRiskLimitTier } from '@gate-crossex/shared-types';
import {
  api,
  ApiError,
  type AuthenticatedPortfolioSnapshot,
  type Candle,
  type CandleInterval,
  type CrossExInstrument,
  type FundingHistorySeriesEntry,
  type FundingOverviewResponse,
  type LiveBalance,
  type KlineWatch,
  type MarketCatalogAsset,
  type MarketSnapshot,
  type StrategyConfig,
  type StrategyRecord,
  type TradingSnapshot,
  type TradingMode,
  type VenueFeeRate,
} from './api.js';
import type { FundingChartSeries } from './charts.js';
import { cumulativeFundingHistory, cumulativeFundingPnl, realizedFundingEdgeWindows } from './cumulative-funding-history.js';
import { VenueSelect } from './venue-select.js';
import { fundingPercentScaledTo8h } from './funding-rates.js';
import { marketSymbol } from './market-symbol.js';
import { usePairCandleHistory } from './pair-candle-history.js';
import { assessMarketPairFreshness, candleTailIsFresh, candleTimestampIsFresh, lastKnownLiveMarketPair } from './market-freshness.js';
import { buildPremiumHistory, mergeCandleHistory, premiumHistoryViewKey, type PremiumHistoryPoint } from './premium-history.js';
import { buildPriceDifferenceHistory, type PriceDifferenceHistoryPoint } from './price-difference-history.js';
import {
  ADR_ASSET,
  ADR_HEDGE_ASSET,
  DEFAULT_ADR_RATIO,
  FUNDING_VENUE_COLORS,
  PAIR_HISTORY_RANGES,
  assessMarginCapacity,
  balanceFor,
  balanceUnitFor,
  exchanges,
  formatAmount,
  incrementalExposure,
  isPositiveDecimal,
  liveMarketFor,
  maxPositionValueAtLeverage,
  minimumNotionalIssue,
  priceText,
  projectedPositionValue,
  quoteFor,
  signedPortfolioQuantity,
  streamedAssets,
  symbolParts,
  useDialogFocus,
  usesSharedCrossExMargin,
  type PairedPositionPrefill,
  type PairHistoryRange,
} from './route-shared.js';
import { strategyAssetOptions, strategyVenueSymbol } from './strategy-asset-options.js';
import { StrategyAssetSearch } from './strategy-asset-search.js';
import { localizeStrategyLogCondition, localizeStrategyLogResult, prepareStrategyLogs, type DisplayStrategyLog } from './strategy-logs.js';
import { PositionCloseDialog, type ClosePositionTarget } from './position-close-dialog.js';
import { prepareStrategyPositions, type StrategyPositionRow } from './strategy-positions.js';
import { PositionsTable } from './positions-table.js';
import { StrategyLaunchConfirmation } from './strategy-launch-confirmation.js';
import { useLanguage, type Language } from './i18n.js';
import { numericFutureFeeRate } from './fee-rates.js';

const PremiumHistoryChart = lazy(() => import('./charts.js').then((module) => ({ default: module.PremiumHistoryChart })));
const PriceDifferenceHistoryChart = lazy(() => import('./charts.js').then((module) => ({ default: module.PriceDifferenceHistoryChart })));
const FundingHistoryChart = lazy(() => import('./charts.js').then((module) => ({ default: module.FundingHistoryChart })));
const HISTORICAL_STRATEGIES_PAGE_SIZE = 10;
const POSITION_FUNDING_RANGES = [
  { days: 1, label: '24H' },
  { days: 7, label: '7D' },
  { days: 30, label: '30D' },
] as const;
type PositionFundingDuration = typeof POSITION_FUNDING_RANGES[number]['days'];
/** The summary always reports realized funding from the full 30-day fetch, independent of the chart range. */
const POSITION_FUNDING_FETCH_DAYS = 30;
const REALIZED_FUNDING_TILES = [
  { days: 1, labelKey: 'Cumulative 24-hour', digits: 4 },
  { days: 7, labelKey: 'Cumulative 7-day', digits: 3 },
  { days: 30, labelKey: 'Cumulative 30-day', digits: 3 },
] as const;

/** One-shot prefill query appended by the Opportunities board (architecture §4.2). */
const QUERY_ASSET_PATTERN = /^[A-Z0-9]{1,20}$/;
const QUERY_DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

function queryAsset(value: string | null | undefined): string | null {
  if (!value) return null;
  const asset = value.trim().toUpperCase();
  return QUERY_ASSET_PATTERN.test(asset) ? asset : null;
}

function queryVenueId(value: string | null | undefined): string | null {
  if (!value) return null;
  const venueId = value.trim().toLowerCase();
  return exchanges.some((venue) => venue.id === venueId) ? venueId : null;
}

function queryProduct(value: string | null | undefined): 'perpetual' | 'spot' | null {
  if (value === 'spot') return 'spot';
  if (value === 'perp' || value === 'perpetual') return 'perpetual';
  return null;
}

function queryDecimal(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && QUERY_DECIMAL_PATTERN.test(trimmed) ? trimmed : null;
}

function useInstrumentCatalog(): CrossExInstrument[] | null {
  const [instruments, setInstruments] = useState<CrossExInstrument[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.instruments()
      .then((response) => { if (!cancelled) setInstruments(response.items); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  return instruments;
}

function minimumSizeIssue(
  instrument: CrossExInstrument | undefined,
  quantity: number,
  venueName: string,
  asset: string,
  t: (key: string) => string,
): string | null {
  if (!instrument || !(Number(instrument.minSize) > 0) || quantity >= Number(instrument.minSize)) return null;
  return `${venueName}: ${t('Minimum order size')} ${instrument.minSize} ${asset}`;
}

function strategyMaxAmount(config: StrategyConfig): string {
  if (config.closePlan) return `${config.closePlan.orderCount} orders`;
  if (config.kind === 'premium' && config.grid) {
    const derived = (Number(config.perOrderQuantity) || 0) * (config.gridLevels ?? 0);
    return derived > 0 ? String(Number(derived.toFixed(8))) : '—';
  }
  return config.totalAmount ?? config.maxPosition ?? '—';
}

function strategyMarketLabel(config: StrategyConfig): string {
  if (config.closePlan) {
    const assets = [...new Set(config.closePlan.targets.map((target) => symbolParts(target.symbol).asset))];
    return assets.join(' / ');
  }
  if (config.kind === 'premium') return `${config.asset} / ${config.hedgeAsset}`;
  if (config.kind === 'carry') return `${config.asset} · Spot ⇄ perpetual`;
  const left = marketSymbol(config.asset, quoteFor(config.leftVenue.toLowerCase()), 'perpetual');
  const right = marketSymbol(config.asset, quoteFor(config.rightVenue.toLowerCase()), 'perpetual');
  return left === right ? left : `${left} ↔ ${right}`;
}

function strategyRuntime(strategy: StrategyRecord, historical: boolean): string {
  const end = historical ? Date.parse(strategy.stoppedAt ?? strategy.updatedAt) : Date.now();
  const elapsed = Math.max(0, end - Date.parse(strategy.createdAt));
  const hours = Math.floor(elapsed / 3_600_000).toString().padStart(2, '0');
  const minutes = Math.floor((elapsed / 60_000) % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function strategyStartTime(createdAt: string, language: Language): { date: string; time: string } {
  const startedAt = new Date(createdAt);
  if (Number.isNaN(startedAt.getTime())) return { date: '—', time: '' };
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  return {
    date: startedAt.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }),
    time: startedAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
}

function strategyCloseTarget(position: StrategyPositionRow): ClosePositionTarget {
  return {
    id: `${position.symbol}:${position.positionId}`,
    positionId: position.positionId,
    symbol: position.symbol,
    quantity: String(position.quantity),
    markPrice: String(position.markPrice),
  };
}

export function RunningStrategiesPanel({ strategies, authenticatedPortfolio, tradingSnapshot, instruments, tradingMode, onOpenModeDialog, onStrategiesChanged, onPositionsRefresh }: {
  strategies: StrategyRecord[];
  authenticatedPortfolio: AuthenticatedPortfolioSnapshot | null;
  tradingSnapshot: TradingSnapshot | null;
  instruments: CrossExInstrument[] | null;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
  onStrategiesChanged: () => Promise<void>;
  onPositionsRefresh: () => Promise<void>;
}) {
  const { language, t } = useLanguage();
  const [activeStrategyTab, setActiveStrategyTab] = useState<'running' | 'positions' | 'historical'>('running');
  const [stoppingIds, setStoppingIds] = useState<string[]>([]);
  const [resumingIds, setResumingIds] = useState<string[]>([]);
  const [selectedLogStrategyId, setSelectedLogStrategyId] = useState<string | null>(null);
  const [selectedStrategyLogs, setSelectedStrategyLogs] = useState<DisplayStrategyLog[]>([]);
  const [logLoadState, setLogLoadState] = useState<{ status: 'idle' | 'loading' | 'loaded' | 'error'; message?: string }>({ status: 'idle' });
  const logRequestRef = useRef(0);
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const [editingTakeProfitId, setEditingTakeProfitId] = useState<string | null>(null);
  const [takeProfitDraft, setTakeProfitDraft] = useState('');
  const [updatingTakeProfitId, setUpdatingTakeProfitId] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [closeTargets, setCloseTargets] = useState<ClosePositionTarget[] | null>(null);
  const [closeNotice, setCloseNotice] = useState<{ kind: 'ok' | 'error'; title: string; text: string } | null>(null);
  const runningStrategies = strategies.filter((strategy) => ['RUNNING', 'PAUSED'].includes(strategy.status));
  const historicalStrategies = strategies
    .filter((strategy) => !['RUNNING', 'PAUSED', 'STOPPING'].includes(strategy.status))
    .sort((left, right) => Date.parse(right.stoppedAt ?? right.updatedAt) - Date.parse(left.stoppedAt ?? left.updatedAt));
  const showingHistory = activeStrategyTab === 'historical';
  const showingPositions = activeStrategyTab === 'positions';
  const historyPages = Math.max(1, Math.ceil(historicalStrategies.length / HISTORICAL_STRATEGIES_PAGE_SIZE));
  const historyStart = (historyPage - 1) * HISTORICAL_STRATEGIES_PAGE_SIZE;
  const visibleStrategies = showingHistory
    ? historicalStrategies.slice(historyStart, historyStart + HISTORICAL_STRATEGIES_PAGE_SIZE)
    : runningStrategies;
  const positionsView = useMemo(
    () => prepareStrategyPositions(authenticatedPortfolio, tradingSnapshot),
    [authenticatedPortfolio, tradingSnapshot],
  );
  const selectedLogStrategy = strategies.find((strategy) => strategy.id === selectedLogStrategyId) ?? null;
  const logDialogRef = useDialogFocus(Boolean(selectedLogStrategy), () => setSelectedLogStrategyId(null));

  function requestPositionClose(positions: StrategyPositionRow[]) {
    if (tradingMode !== 'live') {
      onOpenModeDialog();
      return;
    }
    setCloseTargets(positions.map(strategyCloseTarget));
  }

  useEffect(() => {
    setHistoryPage((current) => Math.min(current, historyPages));
  }, [historyPages]);

  useEffect(() => {
    if (!closeNotice) return;
    const timer = window.setTimeout(() => setCloseNotice(null), 4_500);
    return () => window.clearTimeout(timer);
  }, [closeNotice]);

  useEffect(() => {
    if (!showingPositions) return;
    let refreshInProgress = false;
    const refresh = () => {
      if (refreshInProgress) return;
      refreshInProgress = true;
      void onPositionsRefresh().catch(() => undefined).finally(() => { refreshInProgress = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [showingPositions, onPositionsRefresh]);

  // A failed stop must never be silent: the strategy would keep trading while the user
  // believes it is halted.
  async function stopStrategy(id: string) {
    if (stoppingIds.includes(id) || resumingIds.includes(id)) return;
    setStoppingIds((current) => [...current, id]);
    try {
      await api.stopStrategy(id);
      await onStrategiesChanged();
      if (id === selectedLogStrategyId) setSelectedLogStrategyId(null);
    } catch (error) {
      setStopNotice(`${t('Stop failed')} (${id}): ${error instanceof ApiError ? error.message : t('Backend unavailable')}`);
    } finally {
      setStoppingIds((current) => current.filter((item) => item !== id));
    }
  }

  async function resumeStrategy(id: string) {
    if (tradingMode !== 'live') {
      onOpenModeDialog();
      return;
    }
    if (resumingIds.includes(id) || stoppingIds.includes(id)) return;
    setResumingIds((current) => [...current, id]);
    setStopNotice(null);
    try {
      await api.resumeStrategy(id);
      await onStrategiesChanged();
    } catch (error) {
      setStopNotice(`${t('Resume failed')} (${id}): ${error instanceof ApiError ? error.message : t('Backend unavailable')}`);
    } finally {
      setResumingIds((current) => current.filter((item) => item !== id));
    }
  }

  async function openLogs(id: string) {
    const request = ++logRequestRef.current;
    const strategy = strategies.find((candidate) => candidate.id === id);
    setSelectedLogStrategyId(id);
    setSelectedStrategyLogs([]);
    setLogLoadState({ status: 'loading' });
    try {
      const logs = prepareStrategyLogs(
        (await api.strategyLogs(id)).logs,
        strategy?.config,
      );
      if (request !== logRequestRef.current) return;
      setSelectedStrategyLogs(logs);
      setLogLoadState({ status: 'loaded' });
    } catch (error) {
      if (request !== logRequestRef.current) return;
      setSelectedStrategyLogs([]);
      setLogLoadState({ status: 'error', message: error instanceof ApiError ? error.message : t('Backend unavailable') });
    }
  }

  function editTakeProfit(strategy: StrategyRecord) {
    setEditingTakeProfitId(strategy.id);
    setTakeProfitDraft(strategy.config.takeProfitPremiumPct ?? '');
    setStopNotice(null);
  }

  async function saveTakeProfit(strategy: StrategyRecord) {
    if (updatingTakeProfitId) return;
    if (!/^-?\d+(?:\.\d+)?$/.test(takeProfitDraft)) {
      setStopNotice(`${t('Take-profit update failed')} (${strategy.id}): ${t('Enter a valid take-profit premium')}`);
      return;
    }
    setUpdatingTakeProfitId(strategy.id);
    setStopNotice(null);
    try {
      await api.updatePremiumTakeProfit(strategy.id, takeProfitDraft);
      await onStrategiesChanged();
      setEditingTakeProfitId(null);
    } catch (error) {
      setStopNotice(`${t('Take-profit update failed')} (${strategy.id}): ${error instanceof ApiError ? error.message : t('Backend unavailable')}`);
    } finally {
      setUpdatingTakeProfitId(null);
    }
  }

  function kindLabel(strategy: StrategyRecord): string {
    return t(strategy.config.closePlan ? 'Hedge position strategy'
      : strategy.kind === 'auto' ? 'Price-difference bot'
      : strategy.kind === 'premium' ? 'SK hynix premium bot'
      : strategy.kind === 'carry' ? 'Spot-perpetual carry bot'
      : 'Cross-exchange hedge');
  }

  return <>
    <section className="running-strategies terminal-panel">
      <div className="strategy-panel-head"><div><p className="eyebrow">{t('Live automation')}</p><h2>{t('Strategies')}</h2></div><small>{t('Each strategy runs independently')}</small></div>
      <div className="strategy-history-tabs" role="tablist" aria-label={t('Strategies')}>
        <button role="tab" aria-selected={showingPositions} className={showingPositions ? 'active' : ''} onClick={() => { setActiveStrategyTab('positions'); setEditingTakeProfitId(null); }}>{t('Positions')} <span>({positionsView.status === 'fresh' ? positionsView.rows.length : '—'})</span></button>
        <button role="tab" aria-selected={activeStrategyTab === 'running'} className={activeStrategyTab === 'running' ? 'active' : ''} onClick={() => { setActiveStrategyTab('running'); setEditingTakeProfitId(null); }}>{t('Running')} <span>({runningStrategies.length})</span></button>
        <button role="tab" aria-selected={showingHistory} className={showingHistory ? 'active' : ''} onClick={() => { setActiveStrategyTab('historical'); setHistoryPage(1); setEditingTakeProfitId(null); }}>{t('Historical')} <span>({historicalStrategies.length})</span></button>
      </div>
      {showingPositions ? <>
        {positionsView.status === 'fresh' && positionsView.rows.length > 0 && <PositionsTable rows={positionsView.rows} onClose={requestPositionClose} />}
        {positionsView.status === 'fresh' && positionsView.rows.length === 0 && <div className="no-strategies"><span>◎</span><strong>{t('No open positions')}</strong><small>{t('The live account has no open futures positions.')}</small></div>}
        {positionsView.status === 'stale' && <div className="no-strategies stale-strategy-positions"><span>!</span><strong>{t('Position snapshot is stale')}</strong><small>{t('Waiting for a fresh account snapshot.')}</small></div>}
        {positionsView.status === 'unavailable' && <div className="no-strategies"><span>◎</span><strong>{t('Position data unavailable')}</strong><small>{t('Waiting for a fresh account snapshot.')}</small></div>}
      </> : <>
        <div className={`running-table ${showingHistory ? 'historical' : ''}`}><div className="running-head">{showingHistory && <span>{t('Start time')}</span>}<span>{t('Strategy')}</span><span>{t('Market name')}</span><span>{t('Exchanges')}</span><span>{t('Entry / Exit')}</span><span>{t('Funding collected')}</span>{showingHistory && <span>{t('Realized PnL')}</span>}<span>{t('Size limits')}</span><span>{t('Method')}</span><span>{t('Execution log')}</span><span>{t(showingHistory ? 'Duration' : 'Runtime')}</span><span>{t('Status')}</span>{!showingHistory && <span />}</div>{visibleStrategies.map((strategy) => {
      const config = strategy.config;
      const premium = config.kind === 'premium';
      const timedClose = Boolean(config.closePlan);
      const shortPremium = config.leftSide === 'SELL';
      const leftVenue = exchanges.find((item) => item.id === config.leftVenue.toLowerCase());
      const rightVenue = exchanges.find((item) => item.id === config.rightVenue.toLowerCase());
      const startedAt = strategyStartTime(strategy.createdAt, language);
      return <div className="running-row" key={strategy.id}>
        {showingHistory && <span className="strategy-start-time"><strong>{startedAt.date}</strong><small>{startedAt.time}</small></span>}
        <span><strong>{strategy.id}</strong><small>{kindLabel(strategy)}{strategy.accountLabel ? ` · ${strategy.accountLabel}` : ''}</small></span>
        <span><strong>{strategyMarketLabel(config)}</strong><small>{t(config.kind === 'carry' ? 'Spot ⇄ perpetual' : premium ? 'ADR premium' : 'Perpetual')}</small></span>
        <span>{timedClose ? [...new Set(config.closePlan?.targets.map((target) => symbolParts(target.symbol).venue) ?? [])].join(' ⇄ ') : config.leftVenue === config.rightVenue ? leftVenue?.name ?? config.leftVenue : `${leftVenue?.name ?? config.leftVenue} ⇄ ${rightVenue?.name ?? config.rightVenue}`}</span>
        <span>{timedClose
          ? <><strong>{config.closePlan?.orderCount} {t('orders')}</strong><small>{config.closePlan?.intervalSeconds}s {t('Time gap between orders').toLowerCase()}</small></>
          : premium
          ? <><strong>{shortPremium ? '≥' : '≤'} {config.entryPremiumPct}%</strong>{config.reduceOnly
            ? <small>{t('Reduce only · stop at target')}</small>
            : config.grid
            ? <small>{config.gridLevels} × {config.gridStepPct}% {t('grid')}</small>
            : editingTakeProfitId === strategy.id
              ? <small className="take-profit-editor"><span>{shortPremium ? '≤' : '≥'}</span><input aria-label={t('Take-profit premium')} inputMode="decimal" value={takeProfitDraft} onChange={(event) => setTakeProfitDraft(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') void saveTakeProfit(strategy);
                if (event.key === 'Escape') setEditingTakeProfitId(null);
              }} autoFocus /><span>%</span><button className="save-take-profit" onClick={() => void saveTakeProfit(strategy)} disabled={updatingTakeProfitId === strategy.id}>{updatingTakeProfitId === strategy.id ? t('Saving…') : t('Save')}</button><button className="cancel-take-profit" aria-label={t('Cancel edit')} onClick={() => setEditingTakeProfitId(null)} disabled={updatingTakeProfitId === strategy.id}>×</button></small>
              : <small className="take-profit-value"><span>{shortPremium ? '≤' : '≥'} {config.takeProfitPremiumPct}%</span>{strategy.status === 'RUNNING' && <button className="edit-take-profit" onClick={() => editTakeProfit(strategy)}>{t('Edit take profit')}</button>}</small>}</>
          : config.kind === 'carry'
          ? <><strong>{t('Funding APR')} ≥ {config.fundingAprMin}%</strong><small>{config.fundingDirection} · {t('basis')} {Number(config.basisTakeProfitBps) >= 0 ? '≤' : '≥'} {Math.abs(Number(config.basisTakeProfitBps))} bps</small></>
          : <><strong>{Number(config.entryBps) < 0 ? '≤' : '≥'} {config.entryBps} bps</strong><small>{config.takeProfitBps ? `≤ ${config.takeProfitBps} bps` : t('Stop at full fill')}</small></>}</span>
        <span className="strategy-funding-collected">{config.kind === 'carry' && strategy.carryMetrics
          ? <><strong className={Number(strategy.carryMetrics.fundingCollectedUsdt) >= 0 ? 'positive' : 'negative'}>{Number(strategy.carryMetrics.fundingCollectedUsdt) >= 0 ? '+' : ''}{Number(strategy.carryMetrics.fundingCollectedUsdt).toFixed(4)}</strong><small>USDT</small></>
          : '—'}</span>
        {showingHistory && <span className={`strategy-realized-pnl ${Number(strategy.realizedPnl) >= 0 ? 'positive' : 'negative'}`}><strong>{Number(strategy.realizedPnl) >= 0 ? '+' : ''}{Number(strategy.realizedPnl).toFixed(2)}</strong><small>USDT</small></span>}
        <span>{timedClose ? `${config.closePlan?.targets.length} ${t('Positions')} · ${config.closePlan?.orderCount} ${t('orders')}` : `${config.perOrderQuantity} ${config.asset} · ${t('max')} ${strategyMaxAmount(config)}`}</span>
        <span>{config.executionMethod.replaceAll('_', '–')}</span>
        <span><button className="logs-button" onClick={() => void openLogs(strategy.id)}>{t('View logs')}</button></span>
        <span>{strategyRuntime(strategy, showingHistory)}</span>
        <span className={`strategy-status ${strategy.status.toLowerCase()}`}><i />{strategy.status}<small>{strategy.progress.toFixed(0)}%</small></span>
        {!showingHistory && <span className="strategy-actions">{strategy.status === 'PAUSED' && <button className="resume-button" onClick={() => void resumeStrategy(strategy.id)} disabled={resumingIds.includes(strategy.id) || stoppingIds.includes(strategy.id)}>{resumingIds.includes(strategy.id) ? t('Resuming…') : t('Resume')}</button>}<button className="stop-button" onClick={() => void stopStrategy(strategy.id)} disabled={stoppingIds.includes(strategy.id) || resumingIds.includes(strategy.id)}>{stoppingIds.includes(strategy.id) ? t('Stopping…') : t('Stop')}</button></span>}
      </div>;
    })}</div>{showingHistory && historicalStrategies.length >= HISTORICAL_STRATEGIES_PAGE_SIZE && <div className="funding-pagination strategy-pagination"><span className="page-range">{historyStart + 1}–{Math.min(historyStart + HISTORICAL_STRATEGIES_PAGE_SIZE, historicalStrategies.length)} / {historicalStrategies.length}</span><div className="page-controls"><button onClick={() => setHistoryPage((current) => Math.max(1, current - 1))} disabled={historyPage === 1}>{t('Prev')}</button><span className="page-indicator">{t('Page')} {historyPage} / {historyPages}</span><button onClick={() => setHistoryPage((current) => Math.min(historyPages, current + 1))} disabled={historyPage === historyPages}>{t('Next')}</button></div><span className="page-size">10 {t('per page')}</span></div>}{stopNotice && <div className="launch-notice error panel-notice">{stopNotice}</div>}{visibleStrategies.length === 0 && <div className="no-strategies"><span>◎</span><strong>{t(showingHistory ? 'No historical strategies' : 'No strategies running')}</strong><small>{t(showingHistory ? 'Stopped and completed strategies will appear here.' : 'Configure a strategy above and start it when ready.')}</small></div>}
      </>}
    </section>

    {closeTargets && <PositionCloseDialog
      targets={closeTargets}
      portfolio={authenticatedPortfolio}
      instruments={instruments}
      onDismiss={() => setCloseTargets(null)}
      onCompleted={async () => { await Promise.all([onPositionsRefresh(), onStrategiesChanged()]); }}
      notify={(kind, title, text) => setCloseNotice({ kind, title, text })}
    />}
    {closeNotice && <div className={closeNotice.kind === 'error' ? 'toast toast-error' : 'toast'} role={closeNotice.kind === 'error' ? 'alert' : 'status'}><span>{closeNotice.kind === 'error' ? '!' : '✓'}</span><div><strong>{closeNotice.title}</strong><p>{closeNotice.text}</p></div></div>}
    {selectedLogStrategy && <div className="execution-log-backdrop" role="presentation" onMouseDown={() => setSelectedLogStrategyId(null)}>
      <section ref={logDialogRef} tabIndex={-1} className="execution-log-modal" role="dialog" aria-modal="true" aria-labelledby="execution-log-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><p className="eyebrow">{t('Strategy execution log')}</p><h2 id="execution-log-title">{selectedLogStrategy.id}</h2><span>{strategyMarketLabel(selectedLogStrategy.config)} · {selectedLogStrategy.config.closePlan ? [...new Set(selectedLogStrategy.config.closePlan.targets.map((target) => symbolParts(target.symbol).venue))].join(' ⇄ ') : selectedLogStrategy.config.leftVenue === selectedLogStrategy.config.rightVenue ? selectedLogStrategy.config.leftVenue : `${selectedLogStrategy.config.leftVenue} ⇄ ${selectedLogStrategy.config.rightVenue}`}</span></div><button data-dialog-autofocus aria-label={t('Close execution log')} onClick={() => setSelectedLogStrategyId(null)}>×</button></header>
        <div className="execution-log-summary"><div><span>{t('Strategy')}</span><strong>{t(selectedLogStrategy.config.closePlan ? 'Hedge position strategy' : selectedLogStrategy.kind === 'auto' ? 'Auto price difference' : selectedLogStrategy.kind === 'premium' ? 'SK hynix premium bot' : selectedLogStrategy.kind === 'carry' ? 'Spot-perpetual carry bot' : 'Cross-exchange hedge')}</strong></div><div><span>{t('Status')}</span><strong className="positive">● {selectedLogStrategy.status}</strong></div><div><span>{t('Execution method')}</span><strong>{selectedLogStrategy.config.executionMethod.replaceAll('_', '–')}</strong></div></div>
        <div className="execution-log-table">
          <div className="execution-log-head"><span>{t('Time')}</span><span>{t('Event')}</span><span>{t('Spread / trigger')}</span><span>{t('Quantity')}</span><span>{t('Execution result')}</span><span>{t('Result')}</span></div>
          {logLoadState.status === 'loading' && <div className="execution-log-state">{t('Loading execution log…')}</div>}
          {logLoadState.status === 'error' && <div className="execution-log-state error">{t('Execution log unavailable')}: {logLoadState.message}</div>}
          {logLoadState.status === 'loaded' && selectedStrategyLogs.length === 0 && <div className="execution-log-state">{t('No execution events yet.')}</div>}
          {selectedStrategyLogs.map((log) => <div className="execution-log-row" key={log.id}>
            <span>{new Date(log.createdAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US')}</span>
            <span><strong>{t(log.event)}</strong><small>{t(log.level)}</small></span>
            <span>{localizeStrategyLogCondition(log.condition, language)}</span>
            <span>{log.quantity}</span>
            <span className="execution-metric">
              {log.executionPremiumPct !== null ? <>
                <strong className={Number(log.executionPremiumPct) >= 0 ? 'positive' : 'negative'}>{Number(log.executionPremiumPct) >= 0 ? '+' : ''}{log.executionPremiumPct}%</strong>
                <small>{t('ADR premium')}</small>
              </> : log.executionSpreadBps !== null ? <>
                <strong className={Number(log.executionSpreadBps) >= 0 ? 'positive' : 'negative'}>{Number(log.executionSpreadBps) >= 0 ? '+' : ''}{log.executionSpreadBps} bps</strong>
                <small>{t('Actual spread')}</small>
              </> : '—'}
            </span>
            <span>{localizeStrategyLogResult(log.result, language)}</span>
          </div>)}
        </div>
        <footer><span><i /> {t('Persistent backend log')}</span><small>{t('Showing executions for')} {selectedLogStrategy.id} {t('only')}</small></footer>
      </section>
    </div>}
  </>;
}

interface StrategyViewProps {
  mode: 'position' | 'auto';
  prefill?: PairedPositionPrefill | null;
  marketSnapshot: MarketSnapshot | null;
  catalog: MarketCatalogAsset[] | null;
  fees: VenueFeeRate[];
  strategies: StrategyRecord[];
  balances: Record<string, LiveBalance>;
  authenticatedPortfolio: AuthenticatedPortfolioSnapshot | null;
  tradingSnapshot: TradingSnapshot | null;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
  onStrategiesChanged: () => Promise<void>;
  onPositionsRefresh: () => Promise<void>;
  watchQuotes: (symbols: string[]) => void;
}

export function StrategyView({ mode, prefill, marketSnapshot, catalog, fees, strategies, balances, authenticatedPortfolio, tradingSnapshot, tradingMode, onOpenModeDialog, onStrategiesChanged, onPositionsRefresh, watchQuotes }: StrategyViewProps) {
  const { language, theme, t } = useLanguage();
  // Prefill query from the Opportunities board is read once on mount; later renders ignore it.
  const [query] = useState(() => new URLSearchParams(window.location.search));
  const autoQuery = mode === 'auto' ? query : null;
  const [directionFlipped, setDirectionFlipped] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [asset, setAsset] = useState(() => prefill?.asset ?? queryAsset(autoQuery?.get('asset')) ?? 'BTC');
  // The standard direction sells venue A and buys venue B. Funding-page presets therefore put
  // the high-rate (short) venue on A and the low-rate (long) venue on B.
  const [leftExchangeId, setLeftExchangeId] = useState<string>(() => prefill?.shortVenue ?? queryVenueId(autoQuery?.get('left')) ?? 'binance');
  const [rightExchangeId, setRightExchangeId] = useState<string>(() => prefill?.longVenue ?? queryVenueId(autoQuery?.get('right')) ?? 'okx');
  const [executionMethod, setExecutionMethod] = useState<'Taker–Taker' | 'Maker–Taker'>('Taker–Taker');
  const [makerLeg, setMakerLeg] = useState<'left' | 'right'>('left');
  const [amount, setAmount] = useState('');
  const [positionOrderQuantity, setPositionOrderQuantity] = useState('');
  const [threshold, setThreshold] = useState(() => queryDecimal(autoQuery?.get('entryBps')) ?? '0');
  const [takeProfitThreshold, setTakeProfitThreshold] = useState('0.4');
  const [stopLossThreshold, setStopLossThreshold] = useState('100');
  // Auto legs may use the Gate spot market on either side; everything else stays perpetual.
  const [leftProduct, setLeftProduct] = useState<'perpetual' | 'spot'>(() => queryProduct(autoQuery?.get('leftProduct')) ?? 'perpetual');
  const [rightProduct, setRightProduct] = useState<'perpetual' | 'spot'>(() => queryProduct(autoQuery?.get('rightProduct')) ?? 'perpetual');
  const [maxPosition, setMaxPosition] = useState('');
  const [orderQuantity, setOrderQuantity] = useState('');
  const [leftLeverage, setLeftLeverage] = useState('1');
  const [rightLeverage, setRightLeverage] = useState('1');
  const [leftRiskPositionValue, setLeftRiskPositionValue] = useState<number | null | undefined>(undefined);
  const [rightRiskPositionValue, setRightRiskPositionValue] = useState<number | null | undefined>(undefined);
  const [launching, setLaunching] = useState(false);
  const [confirmingLaunch, setConfirmingLaunch] = useState(false);
  const [launchNotice, setLaunchNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [priceDifferenceRange, setPriceDifferenceRange] = useState<PairHistoryRange>('24H');
  const [positionFundingDuration, setPositionFundingDuration] = useState<PositionFundingDuration>(30);
  const [hoveredPriceDifference, setHoveredPriceDifference] = useState<PriceDifferenceHistoryPoint | null>(null);
  const [positionFundingHistory, setPositionFundingHistory] = useState<{
    key: string;
    status: 'idle' | 'loading' | 'loaded' | 'failed';
    entries: Record<string, FundingHistorySeriesEntry>;
    rangeFrom: number | null;
  }>({ key: '', status: 'idle', entries: {}, rangeFrom: null });
  const [fundingOverview, setFundingOverview] = useState<FundingOverviewResponse | null>(null);
  const instruments = useInstrumentCatalog();

  const leftExchange = exchanges.find((venue) => venue.id === leftExchangeId) ?? exchanges[1];
  const rightExchange = exchanges.find((venue) => venue.id === rightExchangeId) ?? exchanges[2];
  const availableStrategyAssets = useMemo(
    () => strategyAssetOptions(catalog, streamedAssets(marketSnapshot), leftExchangeId, rightExchangeId),
    [catalog, leftExchangeId, marketSnapshot, rightExchangeId],
  );
  const leftHistorySymbol = mode === 'auto' && leftProduct === 'spot'
    ? `GATE_SPOT_${asset}_USDT`
    : strategyVenueSymbol(catalog, leftExchange.id, asset);
  const rightHistorySymbol = mode === 'auto' && rightProduct === 'spot'
    ? `GATE_SPOT_${asset}_USDT`
    : strategyVenueSymbol(catalog, rightExchange.id, asset);
  const leftInstrument = instruments?.find((instrument) => instrument.symbol === leftHistorySymbol);
  const rightInstrument = instruments?.find((instrument) => instrument.symbol === rightHistorySymbol);
  const positionFundingRangeLabel = POSITION_FUNDING_RANGES.find((range) => range.days === positionFundingDuration)?.label ?? '30D';
  const positionFundingHistoryKey = `${leftHistorySymbol}:${rightHistorySymbol}`;
  const priceDifferenceHistoryInterval = PAIR_HISTORY_RANGES[priceDifferenceRange].interval;
  const priceDifferenceHistoryKey = `${leftHistorySymbol}:${rightHistorySymbol}:${priceDifferenceHistoryInterval}`;
  const priceDifferenceHistory = usePairCandleHistory(
    leftHistorySymbol,
    rightHistorySymbol,
    priceDifferenceHistoryInterval,
    mode === 'auto',
  );
  const makerExchange = makerLeg === 'left' ? leftExchange : rightExchange;
  const configuredExecutionMethod = executionMethod === 'Maker–Taker' ? `${t('Maker–Taker')} · ${makerExchange.name} ${t('maker')}` : t('Taker–Taker');
  const selectedFeeRows = [
    { exchange: leftExchange, symbol: leftHistorySymbol, feeKind: executionMethod === 'Maker–Taker' && makerLeg === 'left' ? 'maker' : 'taker' },
    { exchange: rightExchange, symbol: rightHistorySymbol, feeKind: executionMethod === 'Maker–Taker' && makerLeg === 'right' ? 'maker' : 'taker' },
  ] as const;
  // Spot legs must match the exact GATE_SPOT symbol: the venue+asset lookup would otherwise hit
  // the perpetual market first (both are venue=GATE / asset=X once the spot leg registers), which
  // collapsed the live spread into the perpetual's own bid-ask bounce (it looked intermittent).
  const gateSpotLegSymbol = `GATE_SPOT_${asset}_USDT`;
  const leftLive = mode === 'auto' && leftProduct === 'spot'
    ? marketSnapshot?.markets.find((item) => item.symbol === gateSpotLegSymbol) ?? null
    : liveMarketFor(marketSnapshot, leftExchange.id, asset);
  const rightLive = mode === 'auto' && rightProduct === 'spot'
    ? marketSnapshot?.markets.find((item) => item.symbol === gateSpotLegSymbol) ?? null
    : liveMarketFor(marketSnapshot, rightExchange.id, asset);
  const overviewAsset = fundingOverview?.assets.find((entry) => entry.asset === asset);
  const leftOverview = overviewAsset?.venues.find((entry) => entry.venue === leftExchange.id.toUpperCase());
  const rightOverview = overviewAsset?.venues.find((entry) => entry.venue === rightExchange.id.toUpperCase());
  const leftTicker = mode === 'auto' && leftProduct === 'spot'
    ? `${asset}/USDT`
    : marketSymbol(asset, quoteFor(leftExchange.id), 'perpetual');
  const rightTicker = mode === 'auto' && rightProduct === 'spot'
    ? `${asset}/USDT`
    : marketSymbol(asset, quoteFor(rightExchange.id), 'perpetual');
  const leftStreamPrice = leftLive?.source === 'gate_crossex_websocket'
    ? directionFlipped ? leftLive.askPrice : leftLive.bidPrice
    : undefined;
  const rightStreamPrice = rightLive?.source === 'gate_crossex_websocket'
    ? directionFlipped ? rightLive.bidPrice : rightLive.askPrice
    : undefined;
  const livePrice = (primary: string | undefined, fallback: string | null | undefined) => {
    const primaryNumber = Number(primary);
    if (Number.isFinite(primaryNumber) && primaryNumber > 0) return primaryNumber;
    const fallbackNumber = Number(fallback);
    return Number.isFinite(fallbackNumber) && fallbackNumber > 0 ? fallbackNumber : 0;
  };
  const liveFunding8h = (primary: string | undefined, intervalHours: number | null | undefined, fallback8h: string | null | undefined) => {
    if (primary !== undefined && primary.trim() !== '') {
      const primaryNumber = Number(primary);
      const normalized = fundingPercentScaledTo8h(Number.isFinite(primaryNumber) ? primaryNumber * 100 : null, intervalHours ?? null);
      if (normalized !== null) return normalized;
    }
    if (fallback8h !== null && fallback8h !== undefined && fallback8h.trim() !== '') {
      const fallbackNumber = Number(fallback8h);
      if (Number.isFinite(fallbackNumber)) return fallbackNumber * 100;
    }
    return null;
  };
  const leftPrice = livePrice(leftStreamPrice, leftOverview?.lastPrice);
  const rightPrice = livePrice(rightStreamPrice, rightOverview?.lastPrice);
  const sellPrice = directionFlipped ? rightPrice : leftPrice;
  const buyPrice = directionFlipped ? leftPrice : rightPrice;
  // Null while either leg lacks a price: a missing leg must read as "waiting", never as a real
  // 0.00 bps spread.
  const priceDiffBps = sellPrice > 0 && buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 10_000 : null;
  const priceDifferenceHistoryIsCurrent = priceDifferenceHistory.key === priceDifferenceHistoryKey;
  const priceDifferencePoints = useMemo(() => priceDifferenceHistoryIsCurrent
    ? buildPriceDifferenceHistory(priceDifferenceHistory.left, priceDifferenceHistory.right, directionFlipped, 0)
    : [], [directionFlipped, priceDifferenceHistory.left, priceDifferenceHistory.right, priceDifferenceHistoryIsCurrent]);
  const latestPriceDifferencePoint = priceDifferencePoints[priceDifferencePoints.length - 1] ?? null;
  const displayedPriceDifferencePoint = hoveredPriceDifference ?? latestPriceDifferencePoint;
  const displayedPriceDifference = hoveredPriceDifference?.value
    ?? priceDiffBps ?? latestPriceDifferencePoint?.value ?? null;
  const displayedLeftPrice = hoveredPriceDifference?.leftClose
    ?? (leftPrice > 0 ? leftPrice : latestPriceDifferencePoint?.leftClose ?? null);
  const displayedRightPrice = hoveredPriceDifference?.rightClose
    ?? (rightPrice > 0 ? rightPrice : latestPriceDifferencePoint?.rightClose ?? null);
  const displayedSellPrice = directionFlipped ? displayedRightPrice : displayedLeftPrice;
  const displayedBuyPrice = directionFlipped ? displayedLeftPrice : displayedRightPrice;
  const displayedPriceGap = displayedSellPrice !== null && displayedBuyPrice !== null
    ? displayedSellPrice - displayedBuyPrice
    : null;
  const priceDifferenceSeriesKey = `${priceDifferenceHistoryKey}:${directionFlipped ? 'flipped' : 'standard'}`;
  const priceDifferenceHistoryStatus = priceDifferenceHistoryIsCurrent ? priceDifferenceHistory.status : 'loading';
  const priceDifferenceHistoryPlaceholder = priceDifferenceHistoryStatus === 'loading'
    ? t('Loading price-difference history…')
    : priceDifferenceHistoryStatus === 'failed'
      ? t('Price-difference history unavailable')
      : t('No overlapping candles for this venue pair.');
  const leftFunding = liveFunding8h(
    leftLive?.source === 'gate_crossex_websocket' ? leftLive.fundingRate : undefined,
    leftOverview?.fundingIntervalHours,
    leftOverview?.fundingRate8h,
  );
  const rightFunding = liveFunding8h(
    rightLive?.source === 'gate_crossex_websocket' ? rightLive.fundingRate : undefined,
    rightOverview?.fundingIntervalHours,
    rightOverview?.fundingRate8h,
  );
  const fundingEdge = leftFunding !== null && rightFunding !== null
    ? (directionFlipped ? rightFunding - leftFunding : leftFunding - rightFunding)
    : null;
  const positionFundingHistoryIsCurrent = positionFundingHistory.key === positionFundingHistoryKey;
  const positionFundingSeries = useMemo<FundingChartSeries[]>(() => {
    if (!positionFundingHistoryIsCurrent) return [];
    const chartRangeFrom = positionFundingHistory.rangeFrom === null
      ? null
      : positionFundingHistory.rangeFrom + Math.max(0, POSITION_FUNDING_FETCH_DAYS - positionFundingDuration) * 86_400_000;
    const venueSeries = [
      { symbol: leftHistorySymbol, venue: leftExchange },
      { symbol: rightHistorySymbol, venue: rightExchange },
    ].flatMap(({ symbol, venue }) => {
      const entry = positionFundingHistory.entries[symbol];
      if (!entry || entry.status !== 'ok') return [];
      const settlements = chartRangeFrom === null ? entry.points : entry.points.filter((point) => point.timestamp > chartRangeFrom);
      const points = cumulativeFundingHistory(settlements, chartRangeFrom);
      if (points.length === 0) return [];
      return [{
        symbol,
        series: {
          id: `${symbol}:${positionFundingRangeLabel}`,
          label: venue.name,
          color: FUNDING_VENUE_COLORS[venue.id.toUpperCase()] ?? '#8aa9ff',
          points,
        },
      }];
    });
    const leftSeries = venueSeries.find((entry) => entry.symbol === leftHistorySymbol)?.series;
    const rightSeries = venueSeries.find((entry) => entry.symbol === rightHistorySymbol)?.series;
    const chartSeries = venueSeries.map((entry) => entry.series);
    if (!leftSeries || !rightSeries) return chartSeries;
    const longSeries = directionFlipped ? leftSeries : rightSeries;
    const shortSeries = directionFlipped ? rightSeries : leftSeries;
    const pnlPoints = cumulativeFundingPnl(longSeries.points, shortSeries.points);
    if (pnlPoints.length === 0) return chartSeries;
    return [...chartSeries, {
      id: `${positionFundingHistoryKey}:${positionFundingRangeLabel}:pnl:${directionFlipped ? 'buy-a-sell-b' : 'sell-a-buy-b'}`,
      label: `${t('Cumulative funding PnL')} · ${t(directionFlipped ? 'Buy' : 'Sell')} A / ${t(directionFlipped ? 'Sell' : 'Buy')} B`,
      color: theme === 'light' ? '#009b7d' : '#18d6ad',
      points: pnlPoints,
      style: 'area',
    }];
  }, [directionFlipped, leftExchange, leftHistorySymbol, positionFundingDuration, positionFundingHistory.entries, positionFundingHistory.rangeFrom, positionFundingHistoryIsCurrent, positionFundingHistoryKey, positionFundingRangeLabel, rightExchange, rightHistorySymbol, t, theme]);
  const realizedFundingWindows = useMemo(() => {
    if (!positionFundingHistoryIsCurrent || positionFundingHistory.rangeFrom === null) return null;
    const leftEntry = positionFundingHistory.entries[leftHistorySymbol];
    const rightEntry = positionFundingHistory.entries[rightHistorySymbol];
    if (leftEntry?.status !== 'ok' || rightEntry?.status !== 'ok') return null;
    const longPoints = (directionFlipped ? leftEntry : rightEntry).points;
    const shortPoints = (directionFlipped ? rightEntry : leftEntry).points;
    return realizedFundingEdgeWindows(
      longPoints,
      shortPoints,
      positionFundingHistory.rangeFrom,
      POSITION_FUNDING_FETCH_DAYS,
      REALIZED_FUNDING_TILES.map((tile) => tile.days),
    );
  }, [directionFlipped, leftHistorySymbol, positionFundingHistory.entries, positionFundingHistory.rangeFrom, positionFundingHistoryIsCurrent, rightHistorySymbol]);
  const positionFundingHistoryStatus = positionFundingHistoryIsCurrent ? positionFundingHistory.status : 'loading';
  const tradingEnabled = tradingMode === 'live';
  const configuredPerOrder = mode === 'position' ? positionOrderQuantity : orderQuantity;
  const configuredPerOrderNumber = Number(configuredPerOrder);
  // Both legs trade the same base quantity (the conversion ratio is 1 outside premium bots), so
  // each leg's minimum notional is checked against the executable-side price of that leg. Legs
  // without a live price or catalog row are skipped: the backend waits for quotes and stays the
  // authority when constraints are unknown.
  const sizeIssues = [
    minimumSizeIssue(leftInstrument, configuredPerOrderNumber, leftExchange.name, asset, t),
    minimumSizeIssue(rightInstrument, configuredPerOrderNumber, rightExchange.name, asset, t),
    minimumNotionalIssue({ instrument: leftInstrument, quantity: configuredPerOrderNumber, price: leftPrice, asset, venueName: leftExchange.name, t }),
    minimumNotionalIssue({ instrument: rightInstrument, quantity: configuredPerOrderNumber, price: rightPrice, asset, venueName: rightExchange.name, t }),
  ].filter((issue): issue is string => issue !== null);
  const instrumentsReady = leftInstrument !== undefined && rightInstrument !== undefined;
  const signedEntryThreshold = /^-?\d+(?:\.\d+)?$/.test(threshold);
  // Both modes accept signed thresholds: auto trades either spread direction, and position
  // strategies may accept a bounded negative opening cost.
  const entryThresholdValid = signedEntryThreshold;
  const leftBalance = balanceFor(balances, authenticatedPortfolio, leftExchange.id);
  const rightBalance = balanceFor(balances, authenticatedPortfolio, rightExchange.id);
  const sharedMarginMode = usesSharedCrossExMargin(authenticatedPortfolio);
  const leftBalanceUnit = balanceUnitFor(authenticatedPortfolio, leftExchange.id);
  const rightBalanceUnit = balanceUnitFor(authenticatedPortfolio, rightExchange.id);
  const leftPortfolioPosition = authenticatedPortfolio?.snapshot.futuresPositions?.find((position) => position.symbol === leftHistorySymbol);
  const rightPortfolioPosition = authenticatedPortfolio?.snapshot.futuresPositions?.find((position) => position.symbol === rightHistorySymbol);
  const configuredTarget = Number(mode === 'position' ? amount : maxPosition) || 0;
  // Leverage applies to the hedge form and to the continuous bot when both legs are perpetual
  // (all-futures spread). Spot legs are full-cash and always reserve margin at 1×.
  const autoAllPerp = mode === 'auto' && leftProduct !== 'spot' && rightProduct !== 'spot';
  const leftLeverageActive = mode === 'position' || autoAllPerp;
  const rightLeverageActive = leftLeverageActive;
  const leftLeverageNumber = leftLeverageActive ? Number(leftLeverage) || 0 : 1;
  const rightLeverageNumber = rightLeverageActive ? Number(rightLeverage) || 0 : 1;
  const plannedLeftQuantity = configuredTarget * (directionFlipped ? 1 : -1);
  const plannedRightQuantity = -plannedLeftQuantity;
  const projectedLeftPositionValue = projectedPositionValue(
    signedPortfolioQuantity(leftPortfolioPosition), plannedLeftQuantity, leftPrice,
  );
  const projectedRightPositionValue = projectedPositionValue(
    signedPortfolioQuantity(rightPortfolioPosition), plannedRightQuantity, rightPrice,
  );
  const riskLimitsReady = leftRiskPositionValue !== undefined && rightRiskPositionValue !== undefined;
  const positionRiskReviewUnavailable = !reduceOnly && configuredTarget > 0
    && (!riskLimitsReady || projectedLeftPositionValue === null || projectedRightPositionValue === null);
  // A "null" cap with tiers loaded means no usable venue cap at this leverage (empty or
  // unlimited-sentinel tiers) — the projected position then simply has no ceiling to exceed.
  const positionRiskLimitExceeded = !reduceOnly && configuredTarget > 0 && riskLimitsReady && (
    (projectedLeftPositionValue !== null && leftRiskPositionValue !== undefined && leftRiskPositionValue !== null
      && projectedLeftPositionValue > leftRiskPositionValue)
    || (projectedRightPositionValue !== null && rightRiskPositionValue !== undefined && rightRiskPositionValue !== null
      && projectedRightPositionValue > rightRiskPositionValue)
  );
  const estimatedLeftMargin = leftLeverageNumber > 0
    ? incrementalExposure(signedPortfolioQuantity(leftPortfolioPosition), plannedLeftQuantity) * leftPrice / leftLeverageNumber * 1.10
    : 0;
  const estimatedRightMargin = rightLeverageNumber > 0
    ? incrementalExposure(signedPortfolioQuantity(rightPortfolioPosition), plannedRightQuantity) * rightPrice / rightLeverageNumber * 1.10
    : 0;
  const estimatedStrategyMargin = estimatedLeftMargin + estimatedRightMargin;
  const marginEstimateAvailable = !reduceOnly && configuredTarget > 0 && leftPrice > 0 && rightPrice > 0
    && leftLeverageNumber > 0 && rightLeverageNumber > 0;
  const aggregateAvailableText = authenticatedPortfolio?.snapshot.account.availableMargin
    ?? balances['CROSSEX:USDT']?.availableBalance
    ?? balances['CROSSEX:USDC']?.availableBalance
    ?? null;
  const aggregateAvailableMargin = aggregateAvailableText === null ? null : Number(aggregateAvailableText);
  const leftAvailableMargin = leftBalance === null ? null : Number(leftBalance);
  const rightAvailableMargin = rightBalance === null ? null : Number(rightBalance);
  const aggregateMarginKnown = aggregateAvailableMargin !== null && Number.isFinite(aggregateAvailableMargin);
  const useAggregateMargin = sharedMarginMode
    || (authenticatedPortfolio?.snapshot.account.accountMode === undefined && aggregateMarginKnown);
  const marginAssessment = assessMarginCapacity(
    authenticatedPortfolio?.snapshot.account.accountMode,
    aggregateAvailableMargin,
    [
      { venue: leftExchange.id, required: estimatedLeftMargin, available: leftAvailableMargin },
      { venue: rightExchange.id, required: estimatedRightMargin, available: rightAvailableMargin },
    ],
  );
  const marginAvailabilityKnown = marginAssessment.known;
  const marginInsufficient = !reduceOnly && marginEstimateAvailable && marginAssessment.insufficient;
  const sizeInputsValid = isPositiveDecimal(configuredPerOrder)
    && isPositiveDecimal(mode === 'position' ? amount : maxPosition)
    && entryThresholdValid
    // Auto take-profit stays positive; with a negative entry it can sit above the entry level.
    && (mode === 'position' || (isPositiveDecimal(takeProfitThreshold)
      && (Number(threshold) <= 0 || Number(takeProfitThreshold) < Number(threshold))))
    // Optional stop-loss: empty disables it, otherwise it must be a positive bps number.
    && (mode !== 'auto' || stopLossThreshold.trim() === '' || isPositiveDecimal(stopLossThreshold))
    && instrumentsReady
    && sizeIssues.length === 0;
  const strategyInputsValid = sizeInputsValid && !marginInsufficient
    && (mode !== 'position' || reduceOnly || (!positionRiskReviewUnavailable && !positionRiskLimitExceeded));

  useEffect(() => {
    // Strategy cards need quote/funding/OI updates for both legs, but not the high-volume book,
    // public-trade, or kline channels used by the trading terminal.
    watchQuotes([leftHistorySymbol, rightHistorySymbol]);
  }, [leftHistorySymbol, rightHistorySymbol, watchQuotes]);

  useEffect(() => {
    if (mode !== 'position') return;
    let cancelled = false;
    const load = () => {
      void api.fundingOverview()
        .then((response) => { if (!cancelled) setFundingOverview(response); })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'position') return;
    let cancelled = false;
    setPositionFundingHistory({
      key: positionFundingHistoryKey,
      status: 'loading',
      entries: {},
      rangeFrom: null,
    });
    void api.fundingHistorySeries([leftHistorySymbol, rightHistorySymbol], POSITION_FUNDING_FETCH_DAYS)
      .then((response) => {
        if (cancelled) return;
        setPositionFundingHistory({
          key: positionFundingHistoryKey,
          status: 'loaded',
          entries: Object.fromEntries(response.entries.map((entry) => [entry.symbol, entry])),
          rangeFrom: response.from,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setPositionFundingHistory({
          key: positionFundingHistoryKey,
          status: 'failed',
          entries: {},
          rangeFrom: null,
        });
      });
    return () => { cancelled = true; };
  }, [leftHistorySymbol, mode, positionFundingHistoryKey, rightHistorySymbol]);

  useEffect(() => {
    // Never correct while the catalog is still loading: before it arrives the option list is a
    // streaming-only fallback and would yank away a prefilled (not yet watched) asset.
    if (catalog === null) return;
    if (availableStrategyAssets.length > 0 && !availableStrategyAssets.some((option) => option.asset === asset)) {
      setAsset(availableStrategyAssets[0].asset);
    }
  }, [asset, availableStrategyAssets, catalog]);

  useEffect(() => {
    setHoveredPriceDifference(null);
  }, [priceDifferenceSeriesKey]);

  async function launchStrategy() {
    if (launching) return;
    setLaunching(true);
    setLaunchNotice(null);
    const config: StrategyConfig = {
      kind: mode,
      asset,
      leftVenue: leftExchange.id.toUpperCase(),
      rightVenue: rightExchange.id.toUpperCase(),
      leftSide: directionFlipped ? 'BUY' : 'SELL',
      rightSide: directionFlipped ? 'SELL' : 'BUY',
      entryBps: threshold,
      perOrderQuantity: mode === 'position' ? positionOrderQuantity : orderQuantity,
      reduceOnly: mode === 'position' ? reduceOnly : false,
      executionMethod: executionMethod === 'Maker–Taker' ? 'MAKER_TAKER' : 'TAKER_TAKER',
      ...(executionMethod === 'Maker–Taker' ? { makerLeg } : {}),
      ...(mode === 'position'
        ? { totalAmount: amount, leftLeverage, rightLeverage }
        : {
          maxPosition,
          takeProfitBps: takeProfitThreshold,
          // Empty stop-loss disables it; the backend treats it as optional too.
          ...(stopLossThreshold.trim() !== '' ? { stopLossBps: Number(stopLossThreshold) } : {}),
          // All-futures spreads trade at the configured per-leg leverage; spot legs stay 1×.
          ...(autoAllPerp ? { leftLeverage, rightLeverage } : {}),
          // Gate spot legs must carry their explicit symbol so the engine routes spot orders.
          ...(leftProduct === 'spot' ? { leftSymbol: `GATE_SPOT_${asset}_USDT` } : {}),
          ...(rightProduct === 'spot' ? { rightSymbol: `GATE_SPOT_${asset}_USDT` } : {}),
        }),
    };
    try {
      const record = await api.startStrategy(config);
      setLaunchNotice({ kind: 'ok', text: `${t('Strategy launched')}: ${record.id}` });
      await onStrategiesChanged();
    } catch (error) {
      setLaunchNotice({ kind: 'error', text: `${t('Strategy rejected')}: ${error instanceof ApiError ? error.message : t('Backend unavailable')}` });
    } finally {
      setLaunching(false);
      setConfirmingLaunch(false);
      window.setTimeout(() => setLaunchNotice((current) => current?.kind === 'ok' ? null : current), 5000);
    }
  }

  function requestStrategyLaunch() {
    if (!tradingEnabled) {
      onOpenModeDialog();
      return;
    }
    if (launching || !strategyInputsValid) return;
    setConfirmingLaunch(true);
  }

  const leftSide = directionFlipped ? 'Buy' : 'Sell';
  const rightSide = directionFlipped ? 'Sell' : 'Buy';
  const strategySetup = (
    <article className="strategy-panel strategy-rules compact strategy-rules-sidebar terminal-panel">
      <header className="strategy-panel-head"><div><p className="eyebrow">{t('Strategy setup')}</p><h2>{t(mode === 'position' ? 'Configure cross-exchange hedge' : 'Configure continuous bot')}</h2></div></header>
      <div className="compact-fields">{mode === 'position' ? <>
        <label><span>{t('Per-order quantity')}</span><div><input placeholder="e.g. 0.10" value={positionOrderQuantity} onChange={(event) => setPositionOrderQuantity(event.target.value)} /><b>{asset}</b></div></label>
        <label><span>{t('Total amount')}</span><div><input placeholder="e.g. 1.00" value={amount} onChange={(event) => setAmount(event.target.value)} /><b>{asset}</b></div></label>
        <StrategyLeverageControl label="Exchange A leverage" symbol={leftHistorySymbol} exchangeName={leftExchange.name}
          asset={asset} quote={quoteFor(leftExchange.id)} value={leftLeverage} referencePrice={leftPrice}
          fallbackCurrent={leftPortfolioPosition?.leverage} fallbackMax={leftPortfolioPosition?.maxLeverage}
          tradingMode={tradingMode} disabled={reduceOnly} onOpenModeDialog={onOpenModeDialog} onValueChange={setLeftLeverage} onRiskLimitChange={setLeftRiskPositionValue} />
        <StrategyLeverageControl label="Exchange B leverage" symbol={rightHistorySymbol} exchangeName={rightExchange.name}
          asset={asset} quote={quoteFor(rightExchange.id)} value={rightLeverage} referencePrice={rightPrice}
          fallbackCurrent={rightPortfolioPosition?.leverage} fallbackMax={rightPortfolioPosition?.maxLeverage}
          tradingMode={tradingMode} disabled={reduceOnly} onOpenModeDialog={onOpenModeDialog} onValueChange={setRightLeverage} onRiskLimitChange={setRightRiskPositionValue} />
        <label><span>{t('Entry threshold')}</span><div><input value={threshold} onChange={(event) => setThreshold(event.target.value)} /><b>bps</b></div></label>
        <label className="reduce-only-control"><span onClick={(event) => event.preventDefault()}>{t('Position handling')}</span><div><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /><b>{t('Reduce only')}</b></div></label>
      </> : <><label><span>{t('Order quantity')}</span><div><input placeholder="e.g. 0.05" value={orderQuantity} onChange={(event) => setOrderQuantity(event.target.value)} /><b>{asset}</b></div></label><label><span>{t('Max position')}</span><div><input placeholder="e.g. 2.00" value={maxPosition} onChange={(event) => setMaxPosition(event.target.value)} /><b>{asset}</b></div></label>{autoAllPerp && <>
        <StrategyLeverageControl label="Exchange A leverage" symbol={leftHistorySymbol} exchangeName={leftExchange.name}
          asset={asset} quote={quoteFor(leftExchange.id)} value={leftLeverage} referencePrice={leftPrice}
          fallbackCurrent={leftPortfolioPosition?.leverage} fallbackMax={leftPortfolioPosition?.maxLeverage}
          tradingMode={tradingMode} onOpenModeDialog={onOpenModeDialog} onValueChange={setLeftLeverage} onRiskLimitChange={setLeftRiskPositionValue} />
        <StrategyLeverageControl label="Exchange B leverage" symbol={rightHistorySymbol} exchangeName={rightExchange.name}
          asset={asset} quote={quoteFor(rightExchange.id)} value={rightLeverage} referencePrice={rightPrice}
          fallbackCurrent={rightPortfolioPosition?.leverage} fallbackMax={rightPortfolioPosition?.maxLeverage}
          tradingMode={tradingMode} onOpenModeDialog={onOpenModeDialog} onValueChange={setRightLeverage} onRiskLimitChange={setRightRiskPositionValue} />
      </>}<label><span>{t('Entry threshold')}</span><div><input value={threshold} onChange={(event) => setThreshold(event.target.value)} /><b>bps</b></div></label><label><span>{t('Take-profit threshold')}</span><div><input value={takeProfitThreshold} onChange={(event) => setTakeProfitThreshold(event.target.value)} /><b>bps</b></div></label><label><span>{t('Stop-loss threshold')}</span><div><input placeholder={t('Optional')} value={stopLossThreshold} onChange={(event) => setStopLossThreshold(event.target.value)} /><b>bps</b></div></label></>}</div>
      {instrumentsReady && <div className={`strategy-size-check ${sizeInputsValid ? 'valid' : 'invalid'}`}><span>{sizeInputsValid ? '✓' : '!'}</span><p>{sizeInputsValid
        ? t('Per-order quantity meets both exchange minimums')
        : sizeIssues.join(' · ') || t('Enter valid strategy amounts')}</p></div>}
      {marginEstimateAvailable && marginAvailabilityKnown && <div className={`strategy-size-check strategy-margin-check ${marginInsufficient ? 'invalid' : 'valid'}`}><span>{marginInsufficient ? '!' : '✓'}</span><p>
        {t('Estimated margin')}: <strong>{formatAmount(estimatedStrategyMargin)} USDT</strong> · {t('Available margin')}: <strong>{useAggregateMargin ? `${formatAmount(aggregateAvailableMargin ?? 0)} USDT` : `${formatAmount(leftAvailableMargin ?? 0)} / ${formatAmount(rightAvailableMargin ?? 0)} USDT`}</strong>
        <small>{t('Preflight estimate includes a 10% reserve')}</small>
      </p></div>}
      {!reduceOnly && configuredTarget > 0 && riskLimitsReady && <div className={`strategy-size-check strategy-risk-limit-check ${positionRiskLimitExceeded ? 'invalid' : 'valid'}`}><span>{positionRiskLimitExceeded ? '!' : '✓'}</span><p>{positionRiskLimitExceeded
        ? t('Configured position exceeds the maximum at selected leverage')
        : t('Configured position fits the leverage-tier limits')}</p></div>}
      <div className="strategy-setup-actions">{mode === 'position' && <div className="compact-trigger"><span className={priceDiffBps !== null && priceDiffBps >= Number(threshold) ? 'ready' : ''}>{priceDiffBps !== null && priceDiffBps >= Number(threshold) ? '✓' : '○'}</span><p>{t('Enter at')} <strong>≥ {threshold || '0'} bps</strong></p></div>}<div className="compact-method"><span>{t('Execution method')}</span><div className="method-options execution-method-options" role="group" aria-label={t('Execution method')}><button type="button" className={executionMethod === 'Taker–Taker' ? 'active' : ''} aria-pressed={executionMethod === 'Taker–Taker'} onClick={() => setExecutionMethod('Taker–Taker')}>⚡ {t('Taker–Taker')}</button><button type="button" className={executionMethod === 'Maker–Taker' ? 'active' : ''} aria-pressed={executionMethod === 'Maker–Taker'} onClick={() => setExecutionMethod('Maker–Taker')}>◫ {t('Maker–Taker')}</button></div>{executionMethod === 'Maker–Taker' && <div className="maker-leg-picker execution-maker-leg-options" role="group" aria-label={t('Choose maker leg')}><button type="button" className={makerLeg === 'left' ? 'active' : ''} aria-pressed={makerLeg === 'left'} onClick={() => setMakerLeg('left')}><small>{t('Maker')} · A</small><strong>{leftExchange.name}</strong></button><button type="button" className={makerLeg === 'right' ? 'active' : ''} aria-pressed={makerLeg === 'right'} onClick={() => setMakerLeg('right')}><small>{t('Maker')} · B</small><strong>{rightExchange.name}</strong></button></div>}</div></div>
      {mode === 'position' && <div className="compact-stop"><span>◎</span><p>{`${t('Stops after')} ${amount || '0'} ${asset} ${t('executes')}`}</p></div>}
    </article>
  );

  return <div className="alternate-view strategy-view">
    <section className="view-heading strategy-heading"><div><p className="eyebrow">{t('Cross-exchange automation')}</p><h1>{t(mode === 'position' ? 'Cross-exchange hedge.' : 'Auto price-difference bot.')}</h1><p>{t(mode === 'position' ? 'Execute a fixed two-venue position with precise entry rules, then stop.' : 'Continuously capture cross-exchange spreads with controlled execution.')}</p></div><span className="demo-automation"><i /> {t('Backend automation · persistent state')}</span></section>

    <section className={`strategy-layout revised ${directionFlipped ? 'direction-flipped' : ''}`}>
      <div className="strategy-main">
        <article className="strategy-panel strategy-market-panel terminal-panel">
          <header className="strategy-panel-head"><div><p className="eyebrow">{t('Market & venues')}</p><h2>{t('Build the two execution legs')}</h2></div><StrategyAssetSearch asset={asset} options={availableStrategyAssets} loading={catalog === null} leftVenueId={leftExchange.id} rightVenueId={rightExchange.id} leftVenueName={leftExchange.name} rightVenueName={rightExchange.name} onSelect={setAsset} t={t} /></header>
          <div className="strategy-legs">
            <div className="strategy-leg sell-leg">
              <div className="leg-top">
                <VenueSelect
                  label={t('Exchange A')}
                  menuSubtitle={`${asset} ${(mode === 'auto' && leftProduct === 'spot' ? t('Spot') : t('Perpetual')).toLowerCase()}`}
                  options={exchanges.map((venue) => ({ ...venue, disabled: venue.id === rightExchangeId && (mode !== 'auto' || leftProduct === rightProduct), detail: mode === 'auto' && leftProduct === 'spot' ? `${asset}/USDT` : marketSymbol(asset, quoteFor(venue.id), 'perpetual') }))}
                  value={leftExchangeId}
                  onSelect={setLeftExchangeId}
                />
                {mode === 'auto' && leftExchangeId === 'gate' && <div className="leg-product-toggle" role="group" aria-label={t('Market type')}>
                  <button type="button" className={leftProduct === 'perpetual' ? 'active' : ''} aria-pressed={leftProduct === 'perpetual'} onClick={() => setLeftProduct('perpetual')}>{t('Perpetual')}</button>
                  <button type="button" className={leftProduct === 'spot' ? 'active' : ''} aria-pressed={leftProduct === 'spot'} onClick={() => setLeftProduct('spot')}>{t('Spot')}</button>
                </div>}
                <em>{t(leftSide)} <span>{leftTicker}</span></em>
              </div>
              <dl>
                <div><dt>{t('Best price')}</dt><dd>{priceText(leftPrice)}</dd></div>
                {mode === 'position' && <div><dt>{t('Funding / 8h')}</dt><dd>{leftFunding === null ? '—' : `${leftFunding > 0 ? '+' : ''}${leftFunding.toFixed(4)}%`}</dd></div>}
                <div><dt>{t(sharedMarginMode ? 'Shared margin' : 'Available')}</dt><dd>{leftBalance ? `${Number(leftBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${leftBalanceUnit}` : '—'}</dd></div>
              </dl>
            </div>
            <div className="leg-spread">
              <span>{t('Price difference')}</span>
              {priceDiffBps === null
                ? <strong>—</strong>
                : <strong className={priceDiffBps >= 0 ? 'positive' : 'negative'}>{priceDiffBps >= 0 ? '+' : ''}{priceDiffBps.toFixed(2)} bps</strong>}
              <button className="switch-direction" onClick={() => setDirectionFlipped((current) => !current)} aria-label={t('Switch direction')}>⇄</button>
              <small>{priceDiffBps === null ? t('Waiting for both leg prices') : t('Switch direction')}</small>
            </div>
            <div className="strategy-leg buy-leg">
              <div className="leg-top">
                <VenueSelect
                  label={t('Exchange B')}
                  menuSubtitle={`${asset} ${(mode === 'auto' && rightProduct === 'spot' ? t('Spot') : t('Perpetual')).toLowerCase()}`}
                  options={exchanges.map((venue) => ({ ...venue, disabled: venue.id === leftExchangeId && (mode !== 'auto' || leftProduct === rightProduct), detail: mode === 'auto' && rightProduct === 'spot' ? `${asset}/USDT` : marketSymbol(asset, quoteFor(venue.id), 'perpetual') }))}
                  value={rightExchangeId}
                  onSelect={setRightExchangeId}
                />
                {mode === 'auto' && rightExchangeId === 'gate' && <div className="leg-product-toggle" role="group" aria-label={t('Market type')}>
                  <button type="button" className={rightProduct === 'perpetual' ? 'active' : ''} aria-pressed={rightProduct === 'perpetual'} onClick={() => setRightProduct('perpetual')}>{t('Perpetual')}</button>
                  <button type="button" className={rightProduct === 'spot' ? 'active' : ''} aria-pressed={rightProduct === 'spot'} onClick={() => setRightProduct('spot')}>{t('Spot')}</button>
                </div>}
                <em>{t(rightSide)} <span>{rightTicker}</span></em>
              </div>
              <dl>
                <div><dt>{t('Best price')}</dt><dd>{priceText(rightPrice)}</dd></div>
                {mode === 'position' && <div><dt>{t('Funding / 8h')}</dt><dd>{rightFunding === null ? '—' : `${rightFunding > 0 ? '+' : ''}${rightFunding.toFixed(4)}%`}</dd></div>}
                <div><dt>{t(sharedMarginMode ? 'Shared margin' : 'Available')}</dt><dd>{rightBalance ? `${Number(rightBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${rightBalanceUnit}` : '—'}</dd></div>
              </dl>
            </div>
          </div>
          {mode === 'auto' && <div className="launch-warning strategy-market-warning"><span>ⓘ</span><p>{tradingEnabled
            ? t('Both legs execute live orders. Fills are hedged automatically; residual imbalances pause the strategy for review.')
            : t('Live trading is locked. Use the trading-mode switch in the top bar to enable it.')}</p></div>}
        </article>
        {mode === 'position' && <div className="funding-edge expanded position-funding-summary terminal-panel">
          <div><span>{t('Funding-rate edge')}</span><strong className={fundingEdge !== null && fundingEdge < 0 ? 'negative' : undefined}>{fundingEdge === null ? '—' : `${fundingEdge >= 0 ? '+' : ''}${fundingEdge.toFixed(4)}%`}</strong><small>{t('Per 8h')}</small></div>
          <div><span>{t('Current edge APR')}</span><strong className={fundingEdge !== null && fundingEdge < 0 ? 'negative' : undefined}>{fundingEdge === null ? '—' : `${fundingEdge >= 0 ? '+' : ''}${(fundingEdge * 1095).toFixed(2)}%`}</strong><small>{t('Annualized')}</small></div>
          {REALIZED_FUNDING_TILES.map((tile, index) => {
            const realizedWindow = realizedFundingWindows?.[index] ?? null;
            const value = realizedWindow?.value ?? null;
            return <div key={tile.days}>
              <span>{t(tile.labelKey)}</span>
              <strong className={value !== null && value < 0 ? 'negative' : undefined}>{value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(tile.digits)}%`}</strong>
              <small>{value === null
                ? (positionFundingHistoryStatus === 'loading' ? t('Loading…') : t('No data'))
                : `${realizedWindow?.settlements ?? 0} ${t('settlements')}`}</small>
            </div>;
          })}
        </div>}
        {mode === 'position' && <article className="premium-history-panel strategy-funding-history terminal-panel">
          <header className="premium-history-head">
            <div>
              <p className="eyebrow">{t('Historical funding')}</p>
              <h2>{t('Cumulative funding')} <span>{positionFundingRangeLabel}</span></h2>
              <small>{leftExchange.name} {asset} vs {rightExchange.name} {asset}</small>
            </div>
            <div className="premium-history-controls">
              <span className="premium-live-badge"><i /> {t('Actual rates paid at each settlement')}</span>
              <div role="group" aria-label={t('Duration')}>
                {POSITION_FUNDING_RANGES.map((range) => <button
                  key={range.days}
                  className={positionFundingDuration === range.days ? 'active' : ''}
                  aria-pressed={positionFundingDuration === range.days}
                  onClick={() => setPositionFundingDuration(range.days)}
                >{range.label}</button>)}
              </div>
            </div>
          </header>
          <div className="funding-detail-chart-wrap strategy-funding-chart-wrap">
            <Suspense fallback={<div className="funding-history-chart chart-module-loading" role="status">{t('Loading venue histories…')}</div>}>
              <FundingHistoryChart
                series={positionFundingSeries}
                seriesKey={`${positionFundingHistoryKey}:${positionFundingRangeLabel}:${directionFlipped ? 'buy-a-sell-b' : 'sell-a-buy-b'}`}
                theme={theme}
                locale={language === 'zh' ? 'zh-CN' : 'en-US'}
                placeholder={positionFundingHistoryStatus === 'loading' ? t('Loading venue histories…') : t('Funding history unavailable.')}
                showDataTable={false}
              />
            </Suspense>
            <div className="funding-detail-legend">
              {positionFundingSeries.map((item) => {
                const latest = item.points[item.points.length - 1]?.value ?? 0;
                return <span key={item.id}><i style={{ background: item.color }} /><strong>{item.label}</strong><em>{latest >= 0 ? '+' : ''}{latest.toFixed(4)}%</em></span>;
              })}
            </div>
          </div>
        </article>}
        {mode === 'auto' && <article className="premium-history-panel price-difference-history-panel terminal-panel">
          <header className="premium-history-head">
            <div>
              <p className="eyebrow">{t('Historical price difference')}</p>
              <h2>{leftExchange.name} {asset} <span>vs</span> {rightExchange.name} {asset}</h2>
              <small>{t('Selected venue pair')}</small>
            </div>
            <div className="premium-history-controls">
              <span className="premium-live-badge"><i /> {t('Live pair')}</span>
              <div role="group" aria-label={t('Historical price difference')}>
                {(Object.keys(PAIR_HISTORY_RANGES) as PairHistoryRange[]).map((range) =>
                  <button key={range} className={priceDifferenceRange === range ? 'active' : ''} onClick={() => setPriceDifferenceRange(range)}>{range}</button>)}
              </div>
            </div>
          </header>
          <div className="premium-history-summary">
            <div className="premium-history-value">
              <span><i /> {t(leftSide)} {leftExchange.name} / {t(rightSide)} {rightExchange.name}</span>
              <strong className={displayedPriceDifference !== null && displayedPriceDifference < 0 ? 'negative' : ''}>
                {displayedPriceDifference !== null ? `${displayedPriceDifference >= 0 ? '+' : ''}${displayedPriceDifference.toFixed(2)} bps` : '—'}
              </strong>
              <small>{displayedPriceDifferencePoint
                ? new Date(displayedPriceDifferencePoint.time).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', {
                  month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
                })
                : `${marketSymbol(asset, quoteFor(leftExchange.id), 'perpetual')} ↔ ${marketSymbol(asset, quoteFor(rightExchange.id), 'perpetual')} · ${t('Selected price difference')}`}</small>
            </div>
            <dl>
              <div><dt>{t('Exchange A price')}</dt><dd>{displayedLeftPrice !== null ? priceText(displayedLeftPrice) : '—'}</dd></div>
              <div><dt>{t('Exchange B price')}</dt><dd>{displayedRightPrice !== null ? priceText(displayedRightPrice) : '—'}</dd></div>
              <div><dt>{t('Price gap')}</dt><dd>{displayedPriceGap !== null ? `${displayedPriceGap >= 0 ? '+' : ''}${priceText(displayedPriceGap)}` : '—'}</dd></div>
              <div><dt>{t('Trade direction')}</dt><dd>A {t(leftSide)} / B {t(rightSide)}</dd></div>
            </dl>
          </div>
          <Suspense fallback={<div className="premium-history-chart chart-module-loading" role="status">{t('Loading price-difference history…')}</div>}>
            <PriceDifferenceHistoryChart
              key={priceDifferenceSeriesKey}
              points={priceDifferencePoints}
              seriesKey={priceDifferenceSeriesKey}
              visibleDurationMs={PAIR_HISTORY_RANGES[priceDifferenceRange].durationMs}
              theme={theme}
              locale={language === 'zh' ? 'zh-CN' : 'en-US'}
              placeholder={priceDifferenceHistoryPlaceholder}
              onHover={setHoveredPriceDifference}
              onLoadMore={priceDifferenceHistory.loadOlder}
            />
          </Suspense>
        </article>}
      </div>

      <aside className="strategy-sidebar">
        {strategySetup}
        <article className={`strategy-launch terminal-panel ${mode === 'auto' ? 'auto-launch' : ''}`}>
          <div className="launch-status"><span><i />{t(mode === 'position' ? 'Review & execute' : 'Review & launch')}</span><small>{t(mode === 'position' ? 'Finite' : 'Continuous')}</small></div>
          <div className="launch-intent"><div><small>{t(mode === 'position' ? 'Total execution' : 'Strategy')}</small><strong>{mode === 'position' ? `${amount || '0'} ${asset}` : `${asset} ${t('spread bot')}`}</strong></div><p><span className={leftSide.toLowerCase()}>{t(leftSide)} {leftExchange.name}</span><i>⇄</i><span className={rightSide.toLowerCase()}>{t(rightSide)} {rightExchange.name}</span></p></div>
          <dl className="launch-summary review-grid"><div><dt>{t('Entry')}</dt><dd>{Number(threshold) < 0 ? '≤' : '≥'} {threshold || '0'} bps</dd></div>{mode === 'auto' && <div><dt>{t('Take profit')}</dt><dd>≤ {takeProfitThreshold || '0'} bps</dd></div>}{mode === 'auto' && stopLossThreshold.trim() !== '' && <div><dt>{t('Stop loss')}</dt><dd>{stopLossThreshold} bps</dd></div>}{autoAllPerp && <div><dt>{t('Leverage')}</dt><dd>{leftLeverage || '1'}× / {rightLeverage || '1'}×</dd></div>}{mode === 'position' && <><div><dt>{t('Per order')}</dt><dd>{positionOrderQuantity || '0'} {asset}</dd></div><div><dt>{t('Leverage')}</dt><dd>{leftLeverage || '—'}× / {rightLeverage || '—'}×</dd></div><div><dt>{t('Max position at selected leverage')}</dt><dd>{leftRiskPositionValue !== null && leftRiskPositionValue !== undefined ? formatAmount(leftRiskPositionValue) : '—'} {quoteFor(leftExchange.id)} / {rightRiskPositionValue !== null && rightRiskPositionValue !== undefined ? formatAmount(rightRiskPositionValue) : '—'} {quoteFor(rightExchange.id)}</dd></div><div><dt>{t('Projected position')}</dt><dd>{projectedLeftPositionValue !== null ? formatAmount(projectedLeftPositionValue) : '—'} {quoteFor(leftExchange.id)} / {projectedRightPositionValue !== null ? formatAmount(projectedRightPositionValue) : '—'} {quoteFor(rightExchange.id)}</dd></div><div><dt>{t('Reduce only')}</dt><dd>{t(reduceOnly ? 'Yes' : 'No')}</dd></div></>}<div><dt>{t('Method')}{language === 'zh' ? '：' : ': '}</dt><dd>{configuredExecutionMethod.replaceAll('–', '-')}</dd></div>{mode === 'position' && selectedFeeRows.map(({ exchange, symbol, feeKind }) => {
            const rate = numericFutureFeeRate(fees, exchange.id, symbol, feeKind) ?? Number.NaN;
            return <div key={exchange.id}><dt>{exchange.name} · {t(feeKind === 'maker' ? 'Maker fee' : 'Taker fee')}</dt><dd>{Number.isFinite(rate) ? `${(rate * 100).toFixed(4)}%` : t('Exchange setting')}</dd></div>;
          })}</dl>
          {marginInsufficient && <div className="launch-warning"><span>!</span><p>{t('Configured maximum exposure exceeds the available margin.')}</p></div>}
          {positionRiskLimitExceeded && <div className="launch-warning"><span>!</span><p>{t('Configured position exceeds the maximum at selected leverage')}</p></div>}
          <button className={tradingEnabled ? 'start-strategy' : 'start-strategy locked'} onClick={requestStrategyLaunch} disabled={launching || (tradingEnabled && !strategyInputsValid)}>{launching ? t('Launching…') : tradingEnabled ? marginInsufficient ? t('Insufficient margin') : positionRiskLimitExceeded ? t('Position exceeds leverage limit') : positionRiskReviewUnavailable ? t('Loading position limits…') : !strategyInputsValid ? t('Enter valid strategy amounts') : t(mode === 'position' ? 'Execute strategy' : 'Launch strategy') : t('Live trading locked')}</button>
          {launchNotice && <div className={`launch-notice ${launchNotice.kind}`}>{launchNotice.text}</div>}
          {mode === 'position' && <p className="background-strategy-note">{t('Runs in background; manage active strategies below.')}</p>}
          {mode === 'position' && <div className="launch-warning"><span>ⓘ</span><p>{tradingEnabled
            ? t('Both legs execute live orders. Fills are hedged automatically; residual imbalances pause the strategy for review.')
            : t('Live trading is locked. Use the trading-mode switch in the top bar to enable it.')}</p></div>}
        </article>
      </aside>
    </section>

    {confirmingLaunch && <StrategyLaunchConfirmation
      market={`${asset} · ${leftExchange.name} ⇄ ${rightExchange.name}`}
      rows={[
        { label: t('Direction'), value: `${t(leftSide)} ${leftExchange.name} ⇄ ${t(rightSide)} ${rightExchange.name}` },
        { label: t('Entry'), value: `${Number(threshold) < 0 ? '≤' : '≥'} ${threshold || '0'} bps` },
        ...(mode === 'auto' ? [{ label: t('Take profit'), value: `≤ ${takeProfitThreshold || '0'} bps` }] : []),
        ...(mode === 'auto' && stopLossThreshold.trim() !== '' ? [{ label: t('Stop loss'), value: `${stopLossThreshold} bps` }] : []),
        ...(autoAllPerp ? [{ label: t('Leverage'), value: `${leftLeverage || '1'}× / ${rightLeverage || '1'}×` }] : []),
        { label: t(mode === 'position' ? 'Total execution' : 'Max position'), value: `${mode === 'position' ? amount : maxPosition} ${asset}` },
        { label: t('Per order'), value: `${mode === 'position' ? positionOrderQuantity : orderQuantity} ${asset}` },
        ...(mode === 'position' ? [
          { label: t('Leverage'), value: `${leftLeverage}× / ${rightLeverage}×` },
          { label: t('Reduce only'), value: t(reduceOnly ? 'Yes' : 'No') },
        ] : []),
        { label: t('Execution'), value: configuredExecutionMethod.replaceAll('–', '-') },
      ]}
      busy={launching}
      onCancel={() => setConfirmingLaunch(false)}
      onConfirm={() => { void launchStrategy(); }}
    />}
    <RunningStrategiesPanel strategies={strategies} authenticatedPortfolio={authenticatedPortfolio} tradingSnapshot={tradingSnapshot} instruments={instruments} tradingMode={tradingMode} onOpenModeDialog={onOpenModeDialog} onStrategiesChanged={onStrategiesChanged} onPositionsRefresh={onPositionsRefresh} />
  </div>;
}

interface CarryStrategyViewProps {
  marketSnapshot: MarketSnapshot | null;
  catalog: MarketCatalogAsset[] | null;
  strategies: StrategyRecord[];
  balances: Record<string, LiveBalance>;
  authenticatedPortfolio: AuthenticatedPortfolioSnapshot | null;
  tradingSnapshot: TradingSnapshot | null;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
  onStrategiesChanged: () => Promise<void>;
  onPositionsRefresh: () => Promise<void>;
  watchQuotes: (symbols: string[]) => void;
}

/** Annualize an 8h-equivalent funding percentage (percent per 8h × 3 × 365). */
function fundingAprPercent(rate8hPercent: number | null): number | null {
  return rate8hPercent === null ? null : rate8hPercent * 3 * 365;
}

/**
 * Spot-perpetual carry bot: buy the selected venue's spot + short the perpetual on the selected
 * venue (positive funding) or sell held inventory + long the perpetual (negative funding),
 * collect each funding settlement, and close both legs once the basis converges to the
 * take-profit level. Each leg's venue is chosen freely within its connected catalog entries.
 */
export function CarryStrategyView({ marketSnapshot, catalog, strategies, balances, authenticatedPortfolio, tradingSnapshot, tradingMode, onOpenModeDialog, onStrategiesChanged, onPositionsRefresh, watchQuotes }: CarryStrategyViewProps) {
  const { language, theme, t } = useLanguage();
  // Prefill query from the Opportunities board is read once on mount; later renders ignore it.
  const [query] = useState(() => new URLSearchParams(window.location.search));
  const [asset, setAsset] = useState(() => queryAsset(query.get('asset')) ?? 'BTC');
  const [spotVenueId, setSpotVenueId] = useState(() => queryVenueId(query.get('leftVenue')) ?? 'gate');
  // The perpetual leg may sit on any connected venue since cross-venue carry (architecture v2).
  const [perpVenueId, setPerpVenueId] = useState(() => queryVenueId(query.get('rightVenue')) ?? 'gate');
  const [fundingDirection, setFundingDirection] = useState<'POSITIVE' | 'NEGATIVE'>(() => query.get('direction') === 'NEGATIVE' ? 'NEGATIVE' : 'POSITIVE');
  const [fundingAprMin, setFundingAprMin] = useState(() => queryDecimal(query.get('aprMin')) ?? '15');
  const [totalAmount, setTotalAmount] = useState('');
  const [basisTakeProfit, setBasisTakeProfit] = useState('20');
  const [inventoryCheck, setInventoryCheck] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [confirmingLaunch, setConfirmingLaunch] = useState(false);
  const [launchNotice, setLaunchNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [fundingOverview, setFundingOverview] = useState<FundingOverviewResponse | null>(null);
  const [fundingOverviewError, setFundingOverviewError] = useState(false);
  const [carryFundingDuration, setCarryFundingDuration] = useState<PositionFundingDuration>(30);
  const [carryFundingHistory, setCarryFundingHistory] = useState<{
    key: string;
    status: 'idle' | 'loading' | 'loaded' | 'failed';
    entries: Record<string, FundingHistorySeriesEntry>;
    rangeFrom: number | null;
  }>({ key: '', status: 'idle', entries: {}, rangeFrom: null });

  const gateExchange = exchanges[0];
  const spotExchange = exchanges.find((item) => item.id === spotVenueId) ?? gateExchange;
  const perpExchange = exchanges.find((item) => item.id === perpVenueId) ?? gateExchange;
  const crossVenue = spotVenueId !== perpVenueId;
  const availableStrategyAssets = useMemo(
    () => strategyAssetOptions(catalog, streamedAssets(marketSnapshot), spotVenueId, perpVenueId),
    [catalog, marketSnapshot, perpVenueId, spotVenueId],
  );
  const catalogEntry = useMemo(() => catalog?.find((entry) => entry.asset === asset) ?? null, [asset, catalog]);
  // The spot leg may sit on any connected venue whose catalog lists a live spot pair; since
  // architecture v2 the perpetual leg likewise trades on any venue with a live future.
  const spotVenueIds = useMemo(
    () => (catalogEntry?.venues ?? []).filter((row) => row.business === 'SPOT').map((row) => row.venue.toLowerCase()),
    [catalogEntry],
  );
  const perpVenueIds = useMemo(
    () => (catalogEntry?.venues ?? []).filter((row) => row.business === 'FUTURE').map((row) => row.venue.toLowerCase()),
    [catalogEntry],
  );
  const spotVenueOptions = useMemo(() => exchanges.map((venue) => ({
    ...venue,
    disabled: catalogEntry === null ? venue.id !== 'gate' : !spotVenueIds.includes(venue.id),
  })), [catalogEntry, spotVenueIds]);
  const perpVenueOptions = useMemo(() => exchanges.map((venue) => ({
    ...venue,
    disabled: catalogEntry === null ? venue.id !== 'gate' : !perpVenueIds.includes(venue.id),
  })), [catalogEntry, perpVenueIds]);
  const spotSymbol = useMemo(() => {
    // An Opportunities-board prefill pins the exact spot symbol; the catalog refines it later.
    const fromQuery = query.get('leftSymbol');
    if (fromQuery && fromQuery.startsWith(`${spotExchange.id.toUpperCase()}_SPOT_`)) return fromQuery;
    const row = catalogEntry?.venues.find((entry) => entry.business === 'SPOT' && entry.venue === spotExchange.id.toUpperCase());
    return row?.symbol ?? `GATE_SPOT_${asset}_USDT`;
  }, [asset, catalogEntry, spotExchange]);
  const spotQuote = spotSymbol.split('_')[3] ?? 'USDT';
  const perpSymbol = useMemo(() => {
    const fromQuery = query.get('rightSymbol');
    if (fromQuery && fromQuery.startsWith(`${perpExchange.id.toUpperCase()}_FUTURE_`)) return fromQuery;
    const row = catalogEntry?.venues.find((entry) => entry.business === 'FUTURE' && entry.venue === perpExchange.id.toUpperCase());
    return row?.symbol ?? strategyVenueSymbol(catalog, perpVenueId, asset);
  }, [asset, catalog, catalogEntry, perpExchange, perpVenueId]);
  const perpQuote = perpSymbol.split('_')[3] ?? 'USDT';
  const spotMarket = marketSnapshot?.markets.find((item) => item.symbol === spotSymbol) ?? null;
  const perpMarket = marketSnapshot?.markets.find((item) => item.symbol === perpSymbol) ?? null;
  const spotPrice = Number(spotMarket?.askPrice ?? 0);
  const perpPrice = Number(perpMarket?.bidPrice ?? 0);
  const basisBps = spotPrice > 0 && perpPrice > 0 ? ((perpPrice - spotPrice) / spotPrice) * 10_000 : null;
  // Pre-submit minimum-notional check mirrors the engine's launch validation: each leg is sized
  // with its own executable-side price (ask for buys, bid for sells).
  const instruments = useInstrumentCatalog();
  const spotInstrument = instruments?.find((item) => item.symbol === spotSymbol);
  const perpInstrument = instruments?.find((item) => item.symbol === perpSymbol);
  const spotEntryPrice = fundingDirection === 'POSITIVE' ? spotPrice : Number(spotMarket?.bidPrice ?? 0);
  const perpEntryPrice = fundingDirection === 'POSITIVE' ? perpPrice : Number(perpMarket?.askPrice ?? 0);
  const notionalIssues = [
    minimumNotionalIssue({ instrument: spotInstrument, quantity: Number(totalAmount) || 0, price: spotEntryPrice, asset, venueName: spotExchange.name, t }),
    minimumNotionalIssue({ instrument: perpInstrument, quantity: Number(totalAmount) || 0, price: perpEntryPrice, asset, venueName: perpExchange.name, t }),
  ].filter((issue): issue is string => issue !== null);

  const overviewEntry = fundingOverview?.assets.find((entry) => entry.asset === asset);
  const perpOverview = overviewEntry?.venues.find((entry) => entry.venue === perpExchange.id.toUpperCase());
  // Only the Gate WebSocket reports an 8h-equivalent funding rate; other venues' streamed rates
  // follow their own settlement interval, so the board's 8h-equivalent value is preferred there.
  const liveRate8hPercent = perpMarket && perpVenueId === 'gate' && perpMarket.source === 'gate_crossex_websocket' && Number.isFinite(Number(perpMarket.fundingRate))
    ? Number(perpMarket.fundingRate) * 100
    : null;
  const funding8hPercent = liveRate8hPercent
    ?? (perpOverview?.fundingRate8h !== null && perpOverview?.fundingRate8h !== undefined ? Number(perpOverview.fundingRate8h) * 100 : null);
  const currentApr = fundingAprPercent(funding8hPercent);

  const tradingEnabled = tradingMode === 'live';
  const usdtBalance = balances['CROSSEX:USDT']?.availableBalance
    ?? authenticatedPortfolio?.snapshot.account.availableMargin
    ?? null;
  // The spot leg's margin comes from the venue that hosts it: Gate keeps its legacy chain
  // (isolated SPOT account, then the shared CrossEx USDT margin); other venues match by venue.
  const spotLegBalance = spotVenueId === 'gate'
    ? (balances[`SPOT:${spotQuote}`]?.availableBalance ?? usdtBalance)
    : (authenticatedPortfolio?.snapshot.balances.find((balance) => balance.venue === spotExchange.id.toUpperCase() && balance.coin === spotQuote)?.availableBalance ?? null);
  // The contract margin likewise lives on the perpetual leg's venue.
  const perpLegBalance = perpVenueId === 'gate'
    ? usdtBalance
    : (authenticatedPortfolio?.snapshot.balances.find((balance) => balance.venue === perpExchange.id.toUpperCase() && balance.coin === perpQuote)?.availableBalance ?? null);
  const estimatedSpotNotional = (Number(totalAmount) || 0) * spotPrice;
  const estimatedContractMargin = (Number(totalAmount) || 0) * perpPrice;
  const inputsValid = isPositiveDecimal(totalAmount)
    && Number(fundingAprMin) > 0 && Number(fundingAprMin) <= 1000
    && Number(basisTakeProfit) > 0 && Number(basisTakeProfit) < 10_000
    && notionalIssues.length === 0;

  const carryFundingHistoryIsCurrent = carryFundingHistory.key === perpSymbol;
  const carryRangeLabel = POSITION_FUNDING_RANGES.find((range) => range.days === carryFundingDuration)?.label ?? '30D';
  const carryFundingHistoryStatus = carryFundingHistoryIsCurrent ? carryFundingHistory.status : 'loading';
  const carryFundingSeries = useMemo<FundingChartSeries[]>(() => {
    if (!carryFundingHistoryIsCurrent) return [];
    const entry = carryFundingHistory.entries[perpSymbol];
    if (!entry || entry.status !== 'ok') return [];
    // The fetch always spans 30 days; the duration switch slices the tail.
    const chartRangeFrom = carryFundingHistory.rangeFrom === null
      ? null
      : carryFundingHistory.rangeFrom + Math.max(0, POSITION_FUNDING_FETCH_DAYS - carryFundingDuration) * 86_400_000;
    const settlements = chartRangeFrom === null ? entry.points : entry.points.filter((point) => point.timestamp > chartRangeFrom);
    const points = cumulativeFundingHistory(settlements, chartRangeFrom);
    if (points.length === 0) return [];
    return [{
      id: `${perpSymbol}:${carryRangeLabel}`,
      label: perpExchange.name,
      color: FUNDING_VENUE_COLORS[perpExchange.id.toUpperCase()] ?? '#8aa9ff',
      points,
    }];
  }, [carryFundingDuration, carryFundingHistory, carryFundingHistoryIsCurrent, carryRangeLabel, perpExchange, perpSymbol]);

  useEffect(() => {
    // A prefill from the Opportunities board must survive: keep the asset whenever the loaded
    // catalog lists it on either selected venue at all (spot or future). Streaming presence is
    // irrelevant — the legs may simply not be watched yet — and before the catalog we never
    // correct.
    if (catalog === null) return;
    const venueListed = catalog.some((entry) => entry.asset === asset
      && entry.venues.some((venue) => venue.venue === spotExchange.id.toUpperCase()
        || venue.venue === perpExchange.id.toUpperCase()));
    if (venueListed) return;
    if (availableStrategyAssets.length > 0) setAsset(availableStrategyAssets[0].asset);
  }, [asset, availableStrategyAssets, catalog, perpExchange, spotExchange]);

  useEffect(() => {
    // Once the catalog arrives, snap the spot leg to a venue that actually lists the asset.
    if (catalogEntry === null || spotVenueIds.includes(spotVenueId)) return;
    const target = spotVenueIds.includes('gate') ? 'gate' : spotVenueIds[0];
    if (target) setSpotVenueId(target);
  }, [catalogEntry, spotVenueId, spotVenueIds]);

  useEffect(() => {
    // Same snapping for the perpetual leg venue.
    if (catalogEntry === null || perpVenueIds.includes(perpVenueId)) return;
    const target = perpVenueIds.includes('gate') ? 'gate' : perpVenueIds[0];
    if (target) setPerpVenueId(target);
  }, [catalogEntry, perpVenueId, perpVenueIds]);

  useEffect(() => {
    watchQuotes([spotSymbol, perpSymbol]);
  }, [perpSymbol, spotSymbol, watchQuotes]);

  useEffect(() => {
    // Realized funding of the carry's perpetual leg: always fetch 30 days, slice client-side.
    let cancelled = false;
    setCarryFundingHistory({ key: perpSymbol, status: 'loading', entries: {}, rangeFrom: null });
    void api.fundingHistorySeries([perpSymbol], POSITION_FUNDING_FETCH_DAYS)
      .then((response) => {
        if (cancelled) return;
        setCarryFundingHistory({
          key: perpSymbol,
          status: 'loaded',
          entries: Object.fromEntries(response.entries.map((entry) => [entry.symbol, entry])),
          rangeFrom: response.from,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setCarryFundingHistory({ key: perpSymbol, status: 'failed', entries: {}, rangeFrom: null });
      });
    return () => { cancelled = true; };
  }, [perpSymbol]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void api.fundingOverview()
        .then((response) => { if (!cancelled) { setFundingOverview(response); setFundingOverviewError(false); } })
        .catch(() => { if (!cancelled) setFundingOverviewError(true); });
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const effectiveInventoryCheck = fundingDirection === 'NEGATIVE' ? true : inventoryCheck;
  // POSITIVE carry buys spot and shorts the perp: the spot venue must cover the spot notional
  // and the perpetual venue must cover the contract margin. NEGATIVE sells held inventory,
  // so the entry check does not apply.
  const spotCoversEntry = spotLegBalance === null || Number(spotLegBalance) >= estimatedSpotNotional;
  const perpCoversMargin = perpLegBalance === null || Number(perpLegBalance) >= estimatedContractMargin;
  const gateCoversEntry = fundingDirection === 'POSITIVE'
    ? spotCoversEntry && perpCoversMargin
    : true;

  async function launchStrategy() {
    if (launching) return;
    setLaunching(true);
    setLaunchNotice(null);
    const config: StrategyConfig = {
      kind: 'carry',
      asset,
      leftVenue: spotExchange.id.toUpperCase(),
      rightVenue: perpExchange.id.toUpperCase(),
      leftSide: fundingDirection === 'POSITIVE' ? 'BUY' : 'SELL',
      rightSide: fundingDirection === 'POSITIVE' ? 'SELL' : 'BUY',
      fundingDirection,
      fundingAprMin: Number(fundingAprMin),
      totalAmount,
      basisTakeProfitBps: Number(basisTakeProfit),
      contractLeverage: '1',
      inventoryCheck: effectiveInventoryCheck,
      leftSymbol: spotSymbol,
      rightSymbol: perpSymbol,
      perOrderQuantity: totalAmount,
      reduceOnly: false,
      executionMethod: 'TAKER_TAKER',
    };
    try {
      const record = await api.startStrategy(config);
      setLaunchNotice({ kind: 'ok', text: `${t('Strategy launched')}: ${record.id}` });
      await onStrategiesChanged();
    } catch (error) {
      setLaunchNotice({ kind: 'error', text: `${t('Strategy rejected')}: ${error instanceof ApiError ? error.message : t('Backend unavailable')}` });
    } finally {
      setLaunching(false);
      setConfirmingLaunch(false);
      window.setTimeout(() => setLaunchNotice((current) => current?.kind === 'ok' ? null : current), 5000);
    }
  }

  function requestStrategyLaunch() {
    if (!tradingEnabled) {
      onOpenModeDialog();
      return;
    }
    if (launching || !inputsValid) return;
    setConfirmingLaunch(true);
  }

  const leftSide = fundingDirection === 'POSITIVE' ? 'Buy' : 'Sell';
  const rightSide = fundingDirection === 'POSITIVE' ? 'Sell' : 'Buy';
  return <div className="alternate-view strategy-view">
    <section className="view-heading strategy-heading"><div><p className="eyebrow">{t('Funding-rate arbitrage')}</p><h1>{t('Spot-perpetual carry bot.')}</h1><p>{t('Collect funding by holding spot against its perpetual, then exit when the basis converges.')}</p></div><span className="demo-automation"><i /> {t('Backend automation · persistent state')}</span></section>

    <section className="strategy-layout revised">
      <div className="strategy-main">
        <article className="strategy-panel strategy-market-panel terminal-panel">
          <header className="strategy-panel-head"><div><p className="eyebrow">{t('Market & venues')}</p><h2>{t('One asset, spot against its perpetual')}</h2></div><StrategyAssetSearch asset={asset} options={availableStrategyAssets} loading={catalog === null} leftVenueId={spotVenueId} rightVenueId={perpVenueId} leftVenueName={spotExchange.name} rightVenueName={perpExchange.name} onSelect={setAsset} t={t} /></header>
          {fundingOverviewError && <p className="strategy-overview-warning">{t('Funding overview unavailable - showing streamed quotes only. Check the backend Gate connection.')}</p>}
          {(spotQuote !== 'USDT' || spotVenueId !== 'gate') && <p className="strategy-overview-warning">{t('Spot legs convert at the venue quote; amounts below use the perp quote (USDT).')}</p>}
          {crossVenue && <p className="strategy-overview-warning"><b className="venue-badge">{spotExchange.name} ⇄ {perpExchange.name}</b> {t('Cross-venue combination: each leg settles on its own venue, so a venue outage blocks one leg and leaves directional exposure.')}</p>}
          <div className="strategy-legs">
            <div className={`strategy-leg ${fundingDirection === 'POSITIVE' ? 'buy-leg' : 'sell-leg'}`}>
              <div className="leg-top">
                <VenueSelect label={t('Spot leg venue')} menuSubtitle={spotSymbol} options={spotVenueOptions} value={spotVenueId} onSelect={setSpotVenueId} />
                <em>{t(leftSide)} <span>{spotSymbol}</span></em>
              </div>
              <dl>
                <div><dt>{t('Best price')}</dt><dd>{spotPrice > 0 ? priceText(spotPrice) : '—'}</dd></div>
                <div><dt>{t('Available')}</dt><dd>{spotLegBalance ? `${Number(spotLegBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${spotQuote}` : '—'}</dd></div>
              </dl>
            </div>
            <div className="leg-spread">
              <span>{t('Basis')}</span>
              <strong className={basisBps !== null && basisBps >= 0 ? 'positive' : 'negative'}>{basisBps === null ? '—' : `${basisBps >= 0 ? '+' : ''}${basisBps.toFixed(2)} bps`}</strong>
              <small>{crossVenue ? t('Cross-venue basis: venue-to-venue price differences move it too') : t('Perpetual minus spot')}</small>
            </div>
            <div className={`strategy-leg ${fundingDirection === 'POSITIVE' ? 'sell-leg' : 'buy-leg'}`}>
              <div className="leg-top">
                <VenueSelect label={t('Perpetual leg venue')} menuSubtitle={perpSymbol} options={perpVenueOptions} value={perpVenueId} onSelect={setPerpVenueId} />
                <em>{t(rightSide)} <span>{perpSymbol}</span></em>
              </div>
              <dl>
                <div><dt>{t('Best price')}</dt><dd>{perpPrice > 0 ? priceText(perpPrice) : '—'}</dd></div>
                <div><dt>{t('Funding APR')}</dt><dd>{currentApr === null ? '—' : `${currentApr >= 0 ? '+' : ''}${currentApr.toFixed(2)}%`}</dd></div>
              </dl>
            </div>
          </div>
          <div className="launch-warning strategy-market-warning"><span>ⓘ</span><p>{tradingEnabled
            ? t('Each leg trades on its own selected venue. The engine never adjusts your contract leverage.')
            : t('Live trading is locked. Use the trading-mode switch in the top bar to enable it.')}</p></div>
        </article>
        <article className="premium-history-panel strategy-funding-history terminal-panel">
          <header className="premium-history-head">
            <div>
              <p className="eyebrow">{t('Historical funding')}</p>
              <h2>{t('Cumulative funding')} <span>{carryRangeLabel}</span></h2>
              <small>{perpExchange.name} {perpSymbol}</small>
            </div>
            <div className="premium-history-controls">
              <span className={`premium-live-badge${fundingDirection === 'POSITIVE' ? '' : ' negative'}`}><i /> {fundingDirection === 'POSITIVE' ? t('Buy spot · short perp') : t('Sell spot · long perp')}</span>
              <div role="group" aria-label={t('Duration')}>
                {POSITION_FUNDING_RANGES.map((range) => <button
                  key={range.days}
                  className={carryFundingDuration === range.days ? 'active' : ''}
                  aria-pressed={carryFundingDuration === range.days}
                  onClick={() => setCarryFundingDuration(range.days)}
                >{range.label}</button>)}
              </div>
            </div>
          </header>
          <div className="funding-detail-chart-wrap strategy-funding-chart-wrap">
            <Suspense fallback={<div className="funding-history-chart chart-module-loading" role="status">{t('Loading venue histories…')}</div>}>
              <FundingHistoryChart
                series={carryFundingSeries}
                seriesKey={`${perpSymbol}:${carryRangeLabel}`}
                theme={theme}
                locale={language === 'zh' ? 'zh-CN' : 'en-US'}
                placeholder={carryFundingHistoryStatus === 'loading' ? t('Loading venue histories…') : t('Funding history unavailable.')}
                showDataTable={false}
              />
            </Suspense>
            <div className="funding-detail-legend">
              {carryFundingSeries.map((item) => {
                const latest = item.points[item.points.length - 1]?.value ?? 0;
                return <span key={item.id}><i style={{ background: item.color }} /><strong>{item.label}</strong><em>{latest >= 0 ? '+' : ''}{latest.toFixed(4)}%</em></span>;
              })}
            </div>
          </div>
        </article>
      </div>

      <aside className="strategy-sidebar">
        <article className="strategy-panel strategy-rules compact strategy-rules-sidebar terminal-panel">
          <header className="strategy-panel-head"><div><p className="eyebrow">{t('Strategy setup')}</p><h2>{t('Configure carry bot')}</h2></div></header>
          <div className="compact-fields">
            <label className="reduce-only-control"><span onClick={(event) => event.preventDefault()}>{t('Funding direction')}</span><div className="method-options" role="group" aria-label={t('Funding direction')}>
              <button type="button" className={fundingDirection === 'POSITIVE' ? 'active' : ''} aria-pressed={fundingDirection === 'POSITIVE'} onClick={() => setFundingDirection('POSITIVE')}><small>+</small><strong>{t('Positive')}</strong></button>
              <button type="button" className={fundingDirection === 'NEGATIVE' ? 'active' : ''} aria-pressed={fundingDirection === 'NEGATIVE'} onClick={() => setFundingDirection('NEGATIVE')}><small>−</small><strong>{t('Negative')}</strong></button>
            </div></label>
            <label><span>{t('Funding APR threshold')}</span><div><input value={fundingAprMin} onChange={(event) => setFundingAprMin(event.target.value)} /><b>%</b></div></label>
            <label><span>{t('Open amount')}</span><div><input placeholder="e.g. 0.10" value={totalAmount} onChange={(event) => setTotalAmount(event.target.value)} /><b>{asset}</b></div></label>
            <label><span>{t('Basis take-profit')}</span><div><input value={basisTakeProfit} onChange={(event) => setBasisTakeProfit(event.target.value)} /><b>bps</b></div></label>
            <label className="inactive-for-reduce-only"><span>{t('Contract leverage')}</span><div><input value="1" readOnly /><b>×</b></div></label>
            <label className="reduce-only-control"><span onClick={(event) => event.preventDefault()}>{t('Inventory check')}</span><div><input type="checkbox" checked={effectiveInventoryCheck} disabled={fundingDirection === 'NEGATIVE'} onChange={(event) => setInventoryCheck(event.target.checked)} /><b>{t(effectiveInventoryCheck ? 'Yes' : 'No')}</b></div></label>
          </div>
          {notionalIssues.length > 0 && <div className="launch-warning"><span>!</span><p>{notionalIssues.join(' · ')}</p></div>}
          {fundingDirection === 'POSITIVE' && !gateCoversEntry && <div className="launch-warning"><span>!</span><p>{t('Known USDT balance does not cover the spot amount plus the contract margin.')}</p></div>}
          {fundingDirection === 'NEGATIVE' && <div className="launch-warning"><span>!</span><p>{t('Negative funding sells existing spot inventory — no borrowing. The balance is verified before entry.')}</p></div>}
        </article>
        <article className="strategy-launch terminal-panel">
          <div className="launch-status"><span><i />{t('Review & launch')}</span><small>{t('One cycle')}</small></div>
          <div className="launch-intent"><div><small>{t('Strategy')}</small><strong>{asset} {t('carry')}</strong></div><p><span className={leftSide.toLowerCase()}>{t(leftSide)} {t('Spot')}</span><i>⇄</i><span className={rightSide.toLowerCase()}>{t(rightSide)} {t('Perpetual')}</span></p></div>
          <dl className="launch-summary review-grid">
            <div><dt>{t('Direction')}</dt><dd>{fundingDirection}</dd></div>
            <div><dt>{t('Funding APR threshold')}</dt><dd>≥ {fundingAprMin || '0'}%</dd></div>
            <div><dt>{t('Open amount')}</dt><dd>{totalAmount || '0'} {asset}</dd></div>
            <div><dt>{t('Basis take-profit')}</dt><dd>{fundingDirection === 'POSITIVE' ? '≤' : '≥ −'}{basisTakeProfit || '0'} bps</dd></div>
            <div><dt>{t('Contract leverage')}</dt><dd>1× ({t('fixed')})</dd></div>
            <div><dt>{t('Inventory check')}</dt><dd>{t(effectiveInventoryCheck ? 'Yes' : 'No')}</dd></div>
          </dl>
          <button className={tradingEnabled ? 'start-strategy' : 'start-strategy locked'} onClick={requestStrategyLaunch} disabled={launching || (tradingEnabled && (!inputsValid || !gateCoversEntry))}>{launching ? t('Launching…') : tradingEnabled ? !inputsValid ? t('Enter valid strategy amounts') : !gateCoversEntry ? t('Insufficient margin') : t('Launch strategy') : t('Live trading locked')}</button>
          {launchNotice && <div className={`launch-notice ${launchNotice.kind}`}>{launchNotice.text}</div>}
        </article>
      </aside>
    </section>

    {confirmingLaunch && <StrategyLaunchConfirmation
      market={`${asset} · ${spotExchange.name} ${t('Spot')} ⇄ ${perpExchange.name} ${t('Perpetual')}`}
      rows={[
        { label: t('Direction'), value: `${t(leftSide)} ${t('Spot')} ⇄ ${t(rightSide)} ${t('Perpetual')}` },
        { label: t('Funding APR threshold'), value: `≥ ${fundingAprMin || '0'}%` },
        { label: t('Open amount'), value: `${totalAmount} ${asset}` },
        { label: t('Basis take-profit'), value: `${fundingDirection === 'POSITIVE' ? '≤' : '≥ −'}${basisTakeProfit || '0'} bps` },
        { label: t('Contract leverage'), value: '1×' },
        { label: t('Inventory check'), value: t(effectiveInventoryCheck ? 'Yes' : 'No') },
        { label: t('Execution'), value: t('Taker–Taker') },
      ]}
      busy={launching}
      onCancel={() => setConfirmingLaunch(false)}
      onConfirm={() => { void launchStrategy(); }}
    />}
    <RunningStrategiesPanel strategies={strategies} authenticatedPortfolio={authenticatedPortfolio} tradingSnapshot={tradingSnapshot} instruments={null} tradingMode={tradingMode} onOpenModeDialog={onOpenModeDialog} onStrategiesChanged={onStrategiesChanged} onPositionsRefresh={onPositionsRefresh} />
  </div>;
}

interface PremiumStrategyViewProps {
  marketSnapshot: MarketSnapshot | null;
  catalog: MarketCatalogAsset[] | null;
  strategies: StrategyRecord[];
  balances: Record<string, LiveBalance>;
  authenticatedPortfolio: AuthenticatedPortfolioSnapshot | null;
  tradingSnapshot: TradingSnapshot | null;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
  onStrategiesChanged: () => Promise<void>;
  onPositionsRefresh: () => Promise<void>;
  candleSeries: Record<string, Candle[]>;
  watchQuotes: (symbols: string[]) => void;
  watchKlines: (watches: KlineWatch[]) => void;
}

function loadFreshPairCandles(adrSymbol: string, hedgeSymbol: string, interval: CandleInterval) {
  return Promise.allSettled([
    api.candles(adrSymbol, interval, { limit: 300, fresh: true }),
    api.candles(hedgeSymbol, interval, { limit: 300, fresh: true }),
  ] as const);
}

interface StrategyLeverageControlProps {
  label: string;
  symbol: string;
  exchangeName: string;
  asset: string;
  quote: string;
  value: string;
  referencePrice: number;
  fallbackCurrent?: string;
  fallbackMax?: string;
  tradingMode: TradingMode | null;
  disabled?: boolean;
  onOpenModeDialog: () => void;
  onValueChange: (value: string) => void;
  onRiskLimitChange: (value: number | null | undefined) => void;
}

/**
 * Strategy pages use the same exchange-backed leverage editor as the trading ticket:
 * current/max leverage, stepper, slider, presets, and an explicit Gate apply action.
 */
function StrategyLeverageControl({
  label,
  symbol,
  exchangeName,
  asset,
  quote,
  value,
  referencePrice,
  fallbackCurrent,
  fallbackMax,
  tradingMode,
  disabled = false,
  onOpenModeDialog,
  onValueChange,
  onRiskLimitChange,
}: StrategyLeverageControlProps) {
  const { t } = useLanguage();
  const [currentLeverage, setCurrentLeverage] = useState<string | null>(null);
  const [maxLeverage, setMaxLeverage] = useState<string | null>(null);
  const [riskTiers, setRiskTiers] = useState<CrossExRiskLimitTier[] | null>(null);
  const [riskTiersLoaded, setRiskTiersLoaded] = useState(false);
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const displayedLeverage = currentLeverage ?? fallbackCurrent ?? value;
  const leverageCeiling = Math.max(
    1,
    Math.floor(Number(maxLeverage ?? fallbackMax ?? displayedLeverage) || 1),
  );
  const leverageValue = Math.min(leverageCeiling, Math.max(1, Math.round(Number(displayedLeverage) || 1)));
  const presets = [...new Set([1, 3, 5, 10, 20, leverageCeiling])]
    .filter((preset) => preset <= leverageCeiling)
    .sort((left, right) => left - right);
  const draftLeverage = Math.min(leverageCeiling, Math.max(1, Math.round(Number(draft) || 1)));
  const draftMaxPositionValue = maxPositionValueAtLeverage(riskTiers, draftLeverage);
  const draftMaxPositionQuantity = draftMaxPositionValue !== null && referencePrice > 0
    ? draftMaxPositionValue / referencePrice
    : null;

  useEffect(() => {
    let cancelled = false;
    const initial = fallbackCurrent && isPositiveDecimal(fallbackCurrent) ? fallbackCurrent : '1';
    setCurrentLeverage(fallbackCurrent && isPositiveDecimal(fallbackCurrent) ? fallbackCurrent : null);
    setMaxLeverage(fallbackMax && isPositiveDecimal(fallbackMax) ? fallbackMax : null);
    setRiskTiers(null);
    setRiskTiersLoaded(false);
    setDraft(initial);
    setOpen(false);
    setError(null);
    onValueChange(initial);
    void api.riskLimits(symbol).then((response) => {
      if (cancelled) return;
      setRiskTiers(response.item.tiers);
      setRiskTiersLoaded(true);
      const ceilings = response.item.tiers.map((tier) => Number(tier.leverageMax)).filter(Number.isFinite);
      if (ceilings.length > 0) setMaxLeverage(String(Math.max(...ceilings)));
    }).catch(() => { if (!cancelled) setRiskTiersLoaded(true); });
    void api.leverage(symbol).then((response) => {
      if (cancelled || !response.leverage || !isPositiveDecimal(response.leverage)) return;
      setCurrentLeverage(response.leverage);
      setDraft(response.leverage);
      onValueChange(response.leverage);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [fallbackCurrent, fallbackMax, onValueChange, symbol]);

  useEffect(() => {
    onRiskLimitChange(riskTiersLoaded
      ? maxPositionValueAtLeverage(riskTiers, leverageValue)
      : undefined);
  }, [leverageValue, onRiskLimitChange, riskTiers, riskTiersLoaded]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (controlRef.current && !controlRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function openEditor() {
    if (disabled) return;
    if (tradingMode !== 'live') {
      onOpenModeDialog();
      return;
    }
    setDraft(String(leverageValue));
    setError(null);
    setOpen(true);
  }

  function adjust(delta: number) {
    const next = Math.min(leverageCeiling, Math.max(1, Math.round(Number(draft) || leverageValue) + delta));
    setDraft(String(next));
  }

  async function apply() {
    const next = Math.round(Number(draft));
    if (!Number.isFinite(next) || next < 1 || next > leverageCeiling) {
      setError(`${t('Max leverage')}: ${leverageCeiling}×`);
      return;
    }
    setUpdating(true);
    setError(null);
    try {
      const response = await api.setLeverage(symbol, String(next));
      setCurrentLeverage(response.leverage);
      setDraft(response.leverage);
      onValueChange(response.leverage);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('Backend unavailable'));
    } finally {
      setUpdating(false);
    }
  }

  return <div className={`premium-leverage-setting${disabled ? ' inactive-for-reduce-only' : ''}`} aria-disabled={disabled}>
    <span>{t(label)}</span>
    <div className="leverage-control" ref={controlRef}>
      <button className={`leverage-trigger${open ? ' open' : ''}`} onClick={openEditor} aria-haspopup="dialog" aria-expanded={open} aria-label={`${t(label)}: ${leverageValue}×`} title={t('Set leverage')} disabled={disabled}>
        {leverageValue}× <span>⌄</span>
      </button>
      {open && <div className="leverage-popover" role="dialog" aria-label={t('Adjust leverage')}>
        <header><div><strong>{t('Adjust leverage')}</strong><span>{exchangeName} · {marketSymbol(asset, quote, 'perpetual')}</span></div><button onClick={() => setOpen(false)} aria-label={t('Close')}>✕</button></header>
        <dl><div><dt>{t('Current leverage')}</dt><dd>{leverageValue}×</dd></div><div><dt>{t('Max leverage')}</dt><dd>{leverageCeiling}×</dd></div><div className="leverage-position-cap"><dt>{t('Max position at selected leverage')}</dt><dd>{draftMaxPositionValue !== null ? `${formatAmount(draftMaxPositionValue)} ${quote}` : '—'}{draftMaxPositionQuantity !== null && <small>≈ {formatAmount(draftMaxPositionQuantity, 6)} {asset}</small>}</dd></div></dl>
        <div className="leverage-stepper">
          <button onClick={() => adjust(-1)} aria-label="Decrease leverage">−</button>
          <label><input type="number" min="1" max={leverageCeiling} step="1" value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={t('Leverage')} /><b>×</b></label>
          <button onClick={() => adjust(1)} aria-label="Increase leverage">+</button>
        </div>
        <input className="leverage-range" type="range" min="1" max={leverageCeiling} step="1" value={Math.min(leverageCeiling, Math.max(1, Math.round(Number(draft) || 1)))} onChange={(event) => setDraft(event.target.value)} aria-label={t('Leverage')} />
        <div className="leverage-presets">{presets.map((preset) => <button className={Number(draft) === preset ? 'active' : ''} key={preset} onClick={() => setDraft(String(preset))}>{preset}×</button>)}</div>
        {error && <p role="alert">{error}</p>}
        <button className="apply-leverage" onClick={() => void apply()} disabled={updating}>{updating ? t('Applying…') : t('Apply leverage')}</button>
      </div>}
    </div>
  </div>;
}

export function PremiumStrategyView({ marketSnapshot, catalog, strategies, balances, authenticatedPortfolio, tradingSnapshot, tradingMode, onOpenModeDialog, onStrategiesChanged, onPositionsRefresh, candleSeries, watchQuotes, watchKlines }: PremiumStrategyViewProps) {
  const { language, theme, t } = useLanguage();
  const [adrVenueId, setAdrVenueId] = useState('gate');
  const [hedgeVenueId, setHedgeVenueId] = useState('gate');
  const [directionFlipped, setDirectionFlipped] = useState(false);
  const [perOrderQuantity, setPerOrderQuantity] = useState('');
  const adrRatio = DEFAULT_ADR_RATIO;
  const [entryPremium, setEntryPremium] = useState('35');
  const [takeProfitPremium, setTakeProfitPremium] = useState('24');
  const [maxPosition, setMaxPosition] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [hedgeMode, setHedgeMode] = useState<'SHARE_RATIO' | 'EQUAL_NOTIONAL'>('EQUAL_NOTIONAL');
  const [adrLeverage, setAdrLeverage] = useState('3');
  const [hedgeLeverage, setHedgeLeverage] = useState('3');
  const [adrRiskPositionValue, setAdrRiskPositionValue] = useState<number | null | undefined>(undefined);
  const [hedgeRiskPositionValue, setHedgeRiskPositionValue] = useState<number | null | undefined>(undefined);
  const [launching, setLaunching] = useState(false);
  const [confirmingLaunch, setConfirmingLaunch] = useState(false);
  const [launchNotice, setLaunchNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [premiumRange, setPremiumRange] = useState<PairHistoryRange>('24H');
  const [premiumCandles, setPremiumCandles] = useState<{
    key: string;
    adr: Candle[];
    hedge: Candle[];
    adrHasMore: boolean;
    hedgeHasMore: boolean;
    status: 'loading' | 'live' | 'stale' | 'empty' | 'failed';
  }>({ key: '', adr: [], hedge: [], adrHasMore: true, hedgeHasMore: true, status: 'loading' });
  const [hoveredPremium, setHoveredPremium] = useState<PremiumHistoryPoint | null>(null);
  const [freshnessNow, setFreshnessNow] = useState(Date.now());
  const premiumHistoryLoadingRef = useRef<Set<string>>(new Set());
  const premiumHistoryRequestedRef = useRef<Set<string>>(new Set());
  const premiumHistoryInitialRequestsRef = useRef(new Map<string, ReturnType<typeof loadFreshPairCandles>>());
  const instruments = useInstrumentCatalog();

  // Venue pickers offer only venues that actually list each ticker; before the catalog knows
  // either ticker, every venue stays selectable and prices simply read as absent.
  const venuesFor = (asset: string) => {
    const listed = catalog?.find((item) => item.asset === asset)?.venues.map((venueEntry) => venueEntry.venue.toLowerCase());
    return listed && listed.length > 0 ? exchanges.filter((venueEntry) => listed.includes(venueEntry.id)) : exchanges;
  };
  const adrVenues = venuesFor(ADR_ASSET);
  const hedgeVenues = venuesFor(ADR_HEDGE_ASSET);
  const adrExchange = exchanges.find((item) => item.id === adrVenueId) ?? exchanges[0];
  const hedgeExchange = exchanges.find((item) => item.id === hedgeVenueId) ?? exchanges[0];
  const adrSymbol = strategyVenueSymbol(catalog, adrVenueId, ADR_ASSET);
  const hedgeSymbol = strategyVenueSymbol(catalog, hedgeVenueId, ADR_HEDGE_ASSET);
  const adrInstrument = instruments?.find((instrument) => instrument.symbol === adrSymbol);
  const hedgeInstrument = instruments?.find((instrument) => instrument.symbol === hedgeSymbol);
  const premiumHistoryInterval = PAIR_HISTORY_RANGES[premiumRange].interval;
  const premiumHistoryKey = `${adrSymbol}:${hedgeSymbol}:${premiumHistoryInterval}`;

  useEffect(() => {
    const timer = window.setInterval(() => setFreshnessNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // Stream both tickers without opening unused order-book or public-trade subscriptions.
  useEffect(() => {
    watchQuotes([adrSymbol, hedgeSymbol]);
  }, [adrSymbol, hedgeSymbol, watchQuotes]);

  useEffect(() => {
    watchKlines([
      { symbol: adrSymbol, interval: premiumHistoryInterval },
      { symbol: hedgeSymbol, interval: premiumHistoryInterval },
    ]);
    return () => watchKlines([]);
  }, [adrSymbol, hedgeSymbol, premiumHistoryInterval, watchKlines]);

  useEffect(() => {
    let cancelled = false;
    const interval = premiumHistoryInterval;
    const key = premiumHistoryKey;
    setPremiumCandles((current) => current.key === key
      ? current
      : { key, adr: [], hedge: [], adrHasMore: true, hedgeHasMore: true, status: 'loading' });

    let request = premiumHistoryInitialRequestsRef.current.get(key);
    if (!request) {
      request = loadFreshPairCandles(adrSymbol, hedgeSymbol, interval);
      premiumHistoryInitialRequestsRef.current.set(key, request);
    }
    void request.then(([adrResult, hedgeResult]) => {
      if (!cancelled) setPremiumCandles((current) => {
        if (current.key !== key) return current;
        const adrResponse = adrResult.status === 'fulfilled' ? adrResult.value : null;
        const hedgeResponse = hedgeResult.status === 'fulfilled' ? hedgeResult.value : null;
        // Any WebSocket candle received while REST was in flight remains authoritative.
        const adr = adrResponse ? mergeCandleHistory(adrResponse.candles, current.adr) : current.adr;
        const hedge = hedgeResponse ? mergeCandleHistory(hedgeResponse.candles, current.hedge) : current.hedge;
        const hasPair = adr.length > 0 && hedge.length > 0;
        return {
          key,
          adr,
          hedge,
          adrHasMore: adrResponse?.hasMore ?? current.adrHasMore,
          hedgeHasMore: hedgeResponse?.hasMore ?? current.hedgeHasMore,
          status: hasPair
            ? candleTailIsFresh(adr, interval) && candleTailIsFresh(hedge, interval) ? 'live' : 'stale'
            : adrResult.status === 'rejected' || hedgeResult.status === 'rejected' ? 'failed' : 'empty',
        };
      });
    }).finally(() => {
      if (premiumHistoryInitialRequestsRef.current.get(key) === request) {
        premiumHistoryInitialRequestsRef.current.delete(key);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [adrSymbol, hedgeSymbol, premiumHistoryInterval, premiumHistoryKey]);

  const streamedAdrCandles = candleSeries[`${adrSymbol}:${premiumHistoryInterval}`];
  const streamedHedgeCandles = candleSeries[`${hedgeSymbol}:${premiumHistoryInterval}`];
  useEffect(() => {
    if ((!streamedAdrCandles || streamedAdrCandles.length === 0)
      && (!streamedHedgeCandles || streamedHedgeCandles.length === 0)) return;
    const key = premiumHistoryKey;
    setPremiumCandles((current) => {
      if (current.key !== key) return current;
      const adr = streamedAdrCandles ? mergeCandleHistory(current.adr, streamedAdrCandles) : current.adr;
      const hedge = streamedHedgeCandles ? mergeCandleHistory(current.hedge, streamedHedgeCandles) : current.hedge;
      return {
        ...current,
        adr,
        hedge,
        status: adr.length > 0 && hedge.length > 0
          ? candleTailIsFresh(adr, premiumHistoryInterval) && candleTailIsFresh(hedge, premiumHistoryInterval) ? 'live' : 'stale'
          : current.status,
      };
    });
  }, [premiumHistoryInterval, premiumHistoryKey, streamedAdrCandles, streamedHedgeCandles]);

  const loadOlderPremiumHistory = useCallback(() => {
    const { interval } = PAIR_HISTORY_RANGES[premiumRange];
    const key = `${adrSymbol}:${hedgeSymbol}:${interval}`;
    if (premiumCandles.key !== key || premiumHistoryLoadingRef.current.has(key)) return;
    const oldestAdr = premiumCandles.adr[0];
    const oldestHedge = premiumCandles.hedge[0];
    const loadAdr = premiumCandles.adrHasMore && oldestAdr !== undefined;
    const loadHedge = premiumCandles.hedgeHasMore && oldestHedge !== undefined;
    if (!loadAdr && !loadHedge) return;
    const requestKey = `${key}:${loadAdr ? oldestAdr.startTime : 'done'}:${loadHedge ? oldestHedge.startTime : 'done'}`;
    if (premiumHistoryRequestedRef.current.has(requestKey)) return;
    premiumHistoryLoadingRef.current.add(key);
    premiumHistoryRequestedRef.current.add(requestKey);

    void Promise.allSettled([
      loadAdr ? api.candles(adrSymbol, interval, { before: oldestAdr.startTime, limit: 300 }) : null,
      loadHedge ? api.candles(hedgeSymbol, interval, { before: oldestHedge.startTime, limit: 300 }) : null,
    ]).then(([adrResult, hedgeResult]) => {
      const adrResponse = adrResult.status === 'fulfilled' ? adrResult.value : null;
      const hedgeResponse = hedgeResult.status === 'fulfilled' ? hedgeResult.value : null;
      setPremiumCandles((current) => current.key === key ? {
        ...current,
        adr: adrResponse ? mergeCandleHistory(current.adr, adrResponse.candles) : current.adr,
        hedge: hedgeResponse ? mergeCandleHistory(current.hedge, hedgeResponse.candles) : current.hedge,
        adrHasMore: adrResponse ? adrResponse.candles.length > 0 && adrResponse.hasMore : current.adrHasMore,
        hedgeHasMore: hedgeResponse ? hedgeResponse.candles.length > 0 && hedgeResponse.hasMore : current.hedgeHasMore,
      } : current);
      if (adrResult.status === 'rejected' || hedgeResult.status === 'rejected') {
        // Transient venue failures stay retryable on the next visible-range change.
        premiumHistoryRequestedRef.current.delete(requestKey);
      }
    }).finally(() => {
      premiumHistoryLoadingRef.current.delete(key);
    });
  }, [adrSymbol, hedgeSymbol, premiumCandles, premiumRange]);

  const livePairFreshness = assessMarketPairFreshness(marketSnapshot, adrSymbol, hedgeSymbol, freshnessNow);
  const livePair = livePairFreshness.pair;
  const displayPair = livePair ?? lastKnownLiveMarketPair(marketSnapshot, adrSymbol, hedgeSymbol);
  const livePairWaitMessage = t(livePairFreshness.reason === 'feed'
    ? 'Market feed is reconnecting.'
    : livePairFreshness.reason === 'missing'
      ? 'Subscribing to both selected markets…'
      : livePairFreshness.reason === 'non_live'
        ? 'Waiting for live WebSocket quotes from both markets.'
        : livePairFreshness.reason === 'stale'
          ? 'A selected quote is stale; waiting for its next update.'
          : 'A selected quote was delayed by more than 3 seconds; waiting for a timely update.');
  const adrLive = displayPair?.left ?? null;
  const hedgeLive = displayPair?.right ?? null;
  const adrPrice = Number(adrLive?.lastPrice ?? 0);
  const hedgePrice = Number(hedgeLive?.lastPrice ?? 0);
  const ratioNumber = Number(adrRatio) || 0;
  // One hedge share converts to `ratio` ADR shares, so fair ADR value = hedge price ÷ ratio.
  const fairValue = ratioNumber > 0 ? hedgePrice / ratioNumber : 0;
  const premiumNow = adrPrice > 0 && fairValue > 0 ? (adrPrice / fairValue - 1) * 100 : null;
  // Venue selection renders before the loading effect above runs. Gate the chart data against
  // the requested pair synchronously so the previous pair's series can never paint under the
  // new pair's heading, even for a single frame.
  const premiumHistoryIsCurrent = premiumCandles.key === premiumHistoryKey;
  const candidatePremiumPoints = useMemo(() => {
    return premiumHistoryIsCurrent
      ? buildPremiumHistory(premiumCandles.adr, premiumCandles.hedge, ratioNumber, 0)
      : [];
  }, [premiumCandles.adr, premiumCandles.hedge, premiumHistoryIsCurrent, ratioNumber]);
  const premiumHistoryTailIsFresh = premiumHistoryIsCurrent
    && premiumCandles.status === 'live'
    && candleTailIsFresh(premiumCandles.adr, premiumHistoryInterval, freshnessNow)
    && candleTailIsFresh(premiumCandles.hedge, premiumHistoryInterval, freshnessNow)
    && (candidatePremiumPoints.length === 0
      || candleTimestampIsFresh(
        candidatePremiumPoints[candidatePremiumPoints.length - 1]?.time ?? 0,
        premiumHistoryInterval,
        freshnessNow,
      ));
  const premiumPoints = premiumHistoryIsCurrent ? candidatePremiumPoints : [];
  const premiumHistoryHasData = premiumPoints.length > 0;
  const latestPremiumPoint = premiumPoints[premiumPoints.length - 1] ?? null;
  const usableHoveredPremium = premiumHistoryHasData ? hoveredPremium : null;
  const displayedPremiumPoint = usableHoveredPremium ?? latestPremiumPoint;
  const displayedPremium = usableHoveredPremium?.value ?? premiumNow ?? latestPremiumPoint?.value ?? null;
  const displayedAdrPrice = usableHoveredPremium?.adrClose ?? (adrPrice > 0 ? adrPrice : latestPremiumPoint?.adrClose ?? null);
  const displayedHedgePrice = usableHoveredPremium?.hedgeClose ?? (hedgePrice > 0 ? hedgePrice : latestPremiumPoint?.hedgeClose ?? null);
  const displayedFairValue = displayedHedgePrice !== null && ratioNumber > 0 ? displayedHedgePrice / ratioNumber : null;
  const displayedGap = displayedAdrPrice !== null && displayedFairValue !== null ? displayedAdrPrice - displayedFairValue : null;
  const historySeriesKey = premiumHistoryViewKey(premiumHistoryKey, premiumRange, adrRatio);
  const historyStatus: 'loading' | 'live' | 'stale' | 'empty' | 'failed' = !premiumHistoryIsCurrent
    ? 'loading'
    : premiumHistoryTailIsFresh
      ? 'live'
      : premiumHistoryHasData
        ? 'stale'
        : premiumCandles.status === 'failed' ? 'failed' : premiumCandles.status;
  const historyPlaceholder = historyStatus === 'loading'
    ? t('Loading premium history…')
    : historyStatus === 'failed'
      ? t('Premium history unavailable')
      : t('No overlapping candles for this venue pair.');
  const shortPremium = !directionFlipped;
  const adrSide = shortPremium ? 'Sell' : 'Buy';
  const hedgeSide = shortPremium ? 'Buy' : 'Sell';
  const tradingEnabled = tradingMode === 'live';
  const adrBalance = balanceFor(balances, authenticatedPortfolio, adrExchange.id);
  const hedgeBalance = balanceFor(balances, authenticatedPortfolio, hedgeExchange.id);
  const sharedMarginMode = usesSharedCrossExMargin(authenticatedPortfolio);
  const adrBalanceUnit = balanceUnitFor(authenticatedPortfolio, adrExchange.id);
  const hedgeBalanceUnit = balanceUnitFor(authenticatedPortfolio, hedgeExchange.id);
  const adrPortfolioPosition = authenticatedPortfolio?.snapshot.futuresPositions?.find((position) => position.symbol === adrSymbol);
  const hedgePortfolioPosition = authenticatedPortfolio?.snapshot.futuresPositions?.find((position) => position.symbol === hedgeSymbol);
  const configuredMaxPosition = Number(maxPosition) || 0;
  const adrLeverageNumber = Number(adrLeverage) || 0;
  const hedgeLeverageNumber = Number(hedgeLeverage) || 0;
  const leverageInvalid = !reduceOnly && (adrLeverageNumber < 1 || adrLeverageNumber > 200
    || hedgeLeverageNumber < 1 || hedgeLeverageNumber > 200);
  const plannedAdrQuantity = configuredMaxPosition * (shortPremium ? -1 : 1);
  const configuredHedgeQuantity = hedgeMode === 'EQUAL_NOTIONAL'
    ? hedgePrice > 0 ? configuredMaxPosition * adrPrice / hedgePrice : 0
    : ratioNumber > 0 ? configuredMaxPosition / ratioNumber : 0;
  const plannedHedgeQuantity = configuredHedgeQuantity * (shortPremium ? 1 : -1);
  const projectedAdrPositionValue = projectedPositionValue(
    signedPortfolioQuantity(adrPortfolioPosition), plannedAdrQuantity, adrPrice,
  );
  const projectedHedgePositionValue = projectedPositionValue(
    signedPortfolioQuantity(hedgePortfolioPosition), plannedHedgeQuantity, hedgePrice,
  );
  const premiumRiskLimitsReady = adrRiskPositionValue !== undefined && hedgeRiskPositionValue !== undefined;
  const premiumRiskReviewUnavailable = !reduceOnly && configuredMaxPosition > 0
    && (!premiumRiskLimitsReady || projectedAdrPositionValue === null || projectedHedgePositionValue === null);
  // Null caps (loaded but empty/unlimited tiers) mean no ceiling — see positionRiskLimitExceeded.
  const premiumRiskLimitExceeded = !reduceOnly && configuredMaxPosition > 0 && premiumRiskLimitsReady && (
    (projectedAdrPositionValue !== null && adrRiskPositionValue !== undefined && adrRiskPositionValue !== null
      && projectedAdrPositionValue > adrRiskPositionValue)
    || (projectedHedgePositionValue !== null && hedgeRiskPositionValue !== undefined && hedgeRiskPositionValue !== null
      && projectedHedgePositionValue > hedgeRiskPositionValue)
  );
  const estimatedAdrNotional = incrementalExposure(
    signedPortfolioQuantity(adrPortfolioPosition),
    plannedAdrQuantity,
  ) * adrPrice;
  const estimatedHedgeNotional = incrementalExposure(
    signedPortfolioQuantity(hedgePortfolioPosition),
    plannedHedgeQuantity,
  ) * hedgePrice;
  const estimatedAdrMargin = adrLeverageNumber > 0 ? estimatedAdrNotional / adrLeverageNumber * 1.10 : 0;
  const estimatedHedgeMargin = hedgeLeverageNumber > 0 ? estimatedHedgeNotional / hedgeLeverageNumber * 1.10 : 0;
  const estimatedTotalMargin = estimatedAdrMargin + estimatedHedgeMargin;
  const marginEstimateAvailable = !reduceOnly && configuredMaxPosition > 0 && adrPrice > 0 && hedgePrice > 0;
  const adrAvailableNumber = adrBalance === null ? null : Number(adrBalance);
  const hedgeAvailableNumber = hedgeBalance === null ? null : Number(hedgeBalance);
  const aggregateAvailableText = authenticatedPortfolio?.snapshot.account.availableMargin
    ?? balances['CROSSEX:USDT']?.availableBalance
    ?? null;
  const aggregateAvailableMargin = aggregateAvailableText === null ? null : Number(aggregateAvailableText);
  const marginAssessment = assessMarginCapacity(
    authenticatedPortfolio?.snapshot.account.accountMode,
    aggregateAvailableMargin,
    [
      { venue: adrVenueId, required: estimatedAdrMargin, available: adrAvailableNumber },
      { venue: hedgeVenueId, required: estimatedHedgeMargin, available: hedgeAvailableNumber },
    ],
  );
  const marginInsufficient = !reduceOnly && marginEstimateAvailable && marginAssessment.insufficient;
  const foreignOppositePositions = authenticatedPortfolio?.snapshot.futuresPositions?.filter((position) => {
    const parts = symbolParts(position.symbol);
    const isAdr = parts.asset === ADR_ASSET && parts.venue !== adrVenueId.toUpperCase()
      && signedPortfolioQuantity(position) * plannedAdrQuantity < 0;
    const isHedge = parts.asset === ADR_HEDGE_ASSET && parts.venue !== hedgeVenueId.toUpperCase()
      && signedPortfolioQuantity(position) * plannedHedgeQuantity < 0;
    return isAdr || isHedge;
  }) ?? [];
  // Share-ratio hedges are exact (per-order ÷ ratio); equal-notional hedges are sized at each
  // clip's execution prices, so the preview from current prices is an estimate.
  const hedgePerOrderText = (() => {
    const perOrderNumber = Number(perOrderQuantity) || 0;
    if (!(perOrderNumber > 0)) return null;
    if (hedgeMode === 'EQUAL_NOTIONAL') {
      if (!(adrPrice > 0) || !(hedgePrice > 0)) return null;
      return `≈ ${Number(((perOrderNumber * adrPrice) / hedgePrice).toFixed(6))} ${ADR_HEDGE_ASSET}`;
    }
    if (!(ratioNumber > 0)) return null;
    return `${Number((perOrderNumber / ratioNumber).toFixed(8))} ${ADR_HEDGE_ASSET}`;
  })();
  const perOrderNumber = Number(perOrderQuantity);
  const hedgePerOrderNumber = hedgeMode === 'EQUAL_NOTIONAL'
    ? adrPrice > 0 && hedgePrice > 0 ? perOrderNumber * adrPrice / hedgePrice : 0
    : ratioNumber > 0 ? perOrderNumber / ratioNumber : 0;
  const premiumSizeIssues = [
    minimumSizeIssue(adrInstrument, perOrderNumber, adrExchange.name, ADR_ASSET, t),
    minimumSizeIssue(hedgeInstrument, hedgePerOrderNumber, hedgeExchange.name, ADR_HEDGE_ASSET, t),
  ].filter((issue): issue is string => issue !== null);
  const premiumInstrumentsReady = adrInstrument !== undefined && hedgeInstrument !== undefined;
  const premiumInputsValid = isPositiveDecimal(perOrderQuantity)
    && isPositiveDecimal(maxPosition)
    && premiumInstrumentsReady
    && premiumSizeIssues.length === 0;
  const premiumReviewValid = premiumInputsValid
    && (reduceOnly || (!premiumRiskReviewUnavailable && !premiumRiskLimitExceeded));
  const entryComparator = shortPremium ? '≥' : '≤';
  const exitComparator = shortPremium ? '≤' : '≥';
  const entryReady = livePair !== null && premiumNow !== null
    && (shortPremium ? premiumNow >= Number(entryPremium) : premiumNow <= Number(entryPremium));
  const premiumLaunchReady = livePair !== null && !marginInsufficient && !leverageInvalid && premiumReviewValid;

  useEffect(() => setHoveredPremium(null), [historySeriesKey]);

  async function launchStrategy() {
    if (launching) return;
    setLaunching(true);
    setLaunchNotice(null);
    const config: StrategyConfig = {
      kind: 'premium',
      asset: ADR_ASSET,
      hedgeAsset: ADR_HEDGE_ASSET,
      adrRatio,
      leftVenue: adrExchange.id.toUpperCase(),
      rightVenue: hedgeExchange.id.toUpperCase(),
      leftSide: shortPremium ? 'SELL' : 'BUY',
      rightSide: shortPremium ? 'BUY' : 'SELL',
      entryPremiumPct: entryPremium,
      hedgeMode,
      perOrderQuantity,
      reduceOnly,
      executionMethod: 'TAKER_TAKER',
      maxPosition,
      ...(!reduceOnly ? {
        leftLeverage: adrLeverage,
        rightLeverage: hedgeLeverage,
        takeProfitPremiumPct: takeProfitPremium,
      } : {}),
    };
    try {
      const record = await api.startStrategy(config);
      setLaunchNotice({ kind: 'ok', text: `${t('Strategy launched')}: ${record.id}` });
      await onStrategiesChanged();
    } catch (error) {
      setLaunchNotice({ kind: 'error', text: `${t('Strategy rejected')}: ${error instanceof ApiError ? error.message : t('Backend unavailable')}` });
    } finally {
      setLaunching(false);
      setConfirmingLaunch(false);
      window.setTimeout(() => setLaunchNotice((current) => current?.kind === 'ok' ? null : current), 5000);
    }
  }

  function requestStrategyLaunch() {
    if (!tradingEnabled) {
      onOpenModeDialog();
      return;
    }
    if (launching || !premiumLaunchReady) return;
    setConfirmingLaunch(true);
  }

  return <div className="alternate-view strategy-view">
    <section className="view-heading strategy-heading"><div><p className="eyebrow">{t('ADR arbitrage')}</p><h1 className="beta-title">{t('SK hynix premium bot')} <span className="beta-tag">BETA</span></h1><p>{t('Use at your own risk.')} {t('Risk warning: The premium may expand, converge, or reverse at any time. Trading in either direction can result in substantial losses.')}</p></div><span className="demo-automation"><i /> {t('Backend automation · persistent state')}</span></section>

    <section className={`strategy-layout revised ${directionFlipped ? 'direction-flipped' : ''}`}>
      <div className="strategy-main">
        <article className="strategy-panel strategy-market-panel terminal-panel">
          <header className="strategy-panel-head"><div><p className="eyebrow">{t('Market & venues')}</p></div><div className="premium-pair-badge"><strong>{ADR_ASSET} / {ADR_HEDGE_ASSET}</strong><small>1 {ADR_HEDGE_ASSET} = {adrRatio || '—'} {ADR_ASSET}</small></div></header>
          <div className="strategy-legs">
            <div className="strategy-leg sell-leg"><div className="leg-top"><VenueSelect label={t('ADR leg')} menuSubtitle={`${ADR_ASSET} ${t('Perpetual').toLowerCase()}`} options={adrVenues.map((venueEntry) => ({ ...venueEntry, detail: marketSymbol(ADR_ASSET, quoteFor(venueEntry.id), 'perpetual') }))} value={adrVenueId} onSelect={setAdrVenueId} /><em>{t(adrSide)} {ADR_ASSET}</em></div><dl><div><dt>{t('Best price')}</dt><dd>{priceText(adrPrice)}</dd></div><div><dt>{t('Fair ADR value')}</dt><dd>{priceText(fairValue)}</dd></div><div><dt>{t(sharedMarginMode ? 'Shared margin' : 'Available')}</dt><dd>{adrBalance ? `${Number(adrBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${adrBalanceUnit}` : '—'}</dd></div></dl></div>
            <div className="leg-spread">
              <span>{t('ADR premium')}</span>
              <strong className={premiumNow !== null && premiumNow >= 0 ? 'positive' : 'negative'}>{premiumNow !== null ? `${premiumNow >= 0 ? '+' : ''}${premiumNow.toFixed(2)}%` : '—'}</strong>
              <div className={`spread-thesis ${shortPremium ? 'convergence' : 'expansion'}`}>
                <small>{t('Trade thesis')}</small>
                <b>{t(shortPremium ? 'Spread convergence' : 'Spread expansion')}</b>
                <em>{t(shortPremium ? 'Premium expected to fall' : 'Premium expected to rise')} {shortPremium ? '↓' : '↑'}</em>
              </div>
              <button className="switch-direction" onClick={() => setDirectionFlipped((current) => !current)} aria-label={t('Switch direction')}>⇄</button>
              <small>{t('Switch direction')}</small>
            </div>
            <div className="strategy-leg buy-leg"><div className="leg-top"><VenueSelect label={t('Hedge leg')} menuSubtitle={`${ADR_HEDGE_ASSET} ${t('Perpetual').toLowerCase()}`} options={hedgeVenues.map((venueEntry) => ({ ...venueEntry, detail: marketSymbol(ADR_HEDGE_ASSET, quoteFor(venueEntry.id), 'perpetual') }))} value={hedgeVenueId} onSelect={setHedgeVenueId} /><em>{t(hedgeSide)} {ADR_HEDGE_ASSET}</em></div><dl><div><dt>{t('Best price')}</dt><dd>{priceText(hedgePrice)}</dd></div><div><dt>{t('Hedge per order')}</dt><dd>{hedgePerOrderText ?? '—'}</dd></div><div><dt>{t(sharedMarginMode ? 'Shared margin' : 'Available')}</dt><dd>{hedgeBalance ? `${Number(hedgeBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${hedgeBalanceUnit}` : '—'}</dd></div></dl></div>
          </div>
          {!livePair && <div className="premium-data-hint"><span>ⓘ</span><p>{livePairWaitMessage}</p></div>}
        </article>
        <article className="premium-history-panel terminal-panel">
          <header className="premium-history-head">
            <div>
              <p className="eyebrow">{t('Historical premium')}</p>
              <h2>{adrExchange.name} {ADR_ASSET} <span>vs</span> {hedgeExchange.name} {ADR_HEDGE_ASSET} ÷ {adrRatio || '—'}</h2>
              <small>{t('Selected venue pair')}</small>
            </div>
            <div className="premium-history-controls">
              <span className={`premium-live-badge ${historyStatus === 'live' ? '' : 'loading'}`}><i /> {t(historyStatus === 'live' ? 'Live pair' : historyStatus === 'stale' ? 'Stale history' : historyStatus === 'empty' ? 'No data' : historyStatus === 'failed' ? 'Unavailable' : 'Loading')}</span>
              <div role="group" aria-label={t('Historical premium')}>
                {(Object.keys(PAIR_HISTORY_RANGES) as PairHistoryRange[]).map((range) =>
                  <button key={range} className={premiumRange === range ? 'active' : ''} onClick={() => setPremiumRange(range)}>{range}</button>)}
              </div>
            </div>
          </header>
          <div className="premium-history-summary">
            <div className="premium-history-value">
              <span><i /> {adrExchange.name} / {hedgeExchange.name} {t('ADR premium')}</span>
              <strong className={displayedPremium !== null && displayedPremium < 0 ? 'negative' : ''}>
                {displayedPremium !== null ? `${displayedPremium >= 0 ? '+' : ''}${displayedPremium.toFixed(2)}%` : '—'}
              </strong>
              <small>{displayedPremiumPoint
                ? new Date(displayedPremiumPoint.time).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', {
                  month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
                })
                : `${ADR_ASSET} vs ${ADR_HEDGE_ASSET} ÷ ${adrRatio || '—'}`}</small>
            </div>
            <dl>
              <div><dt>{t('SKHY Price')}</dt><dd>{displayedAdrPrice !== null ? priceText(displayedAdrPrice) : '—'}</dd></div>
              <div><dt>{t('SKHYNIX Price')}</dt><dd>{displayedHedgePrice !== null ? priceText(displayedHedgePrice) : '—'}</dd></div>
              <div><dt>{t('Fair SKHY price')}</dt><dd>{displayedFairValue !== null ? priceText(displayedFairValue) : '—'}</dd></div>
              <div><dt>{t('Premium gap')}</dt><dd>{displayedGap !== null ? `${displayedGap >= 0 ? '+' : ''}${priceText(displayedGap)}` : '—'}</dd></div>
            </dl>
          </div>
          <Suspense fallback={<div className="premium-history-chart chart-module-loading" role="status">{t('Loading premium history…')}</div>}>
            <PremiumHistoryChart
              key={historySeriesKey}
              points={premiumPoints}
              seriesKey={historySeriesKey}
              visibleDurationMs={PAIR_HISTORY_RANGES[premiumRange].durationMs}
              theme={theme}
              locale={language === 'zh' ? 'zh-CN' : 'en-US'}
              placeholder={historyPlaceholder}
              onHover={setHoveredPremium}
              onLoadMore={loadOlderPremiumHistory}
            />
          </Suspense>
        </article>
      </div>

      <aside className="strategy-sidebar">
        <article className="strategy-panel strategy-rules compact strategy-rules-sidebar terminal-panel">
          <header className="strategy-panel-head"><div><p className="eyebrow">{t('Strategy setup')}</p><h2>{t('Configure premium bot')}</h2></div></header>
          <div className="compact-fields">
            <label><span>{t('Per-order quantity')}</span><div><input placeholder="e.g. 0.10" value={perOrderQuantity} onChange={(event) => setPerOrderQuantity(event.target.value)} /><b>{ADR_ASSET}</b></div></label>
            <label><span>{t(reduceOnly ? 'Max close amount' : 'Max position')}</span><div><input placeholder="e.g. 0.50" value={maxPosition} onChange={(event) => setMaxPosition(event.target.value)} /><b>{ADR_ASSET}</b></div></label>
            <label><span>{t('Entry premium')}</span><div><input value={entryPremium} onChange={(event) => setEntryPremium(event.target.value)} /><b>%</b></div></label>
            <label className={reduceOnly ? 'inactive-for-reduce-only' : ''}><span>{t('Take-profit premium')}</span><div><input value={takeProfitPremium} onChange={(event) => setTakeProfitPremium(event.target.value)} disabled={reduceOnly} /><b>%</b></div></label>
            <StrategyLeverageControl label="SKHY leverage" symbol={adrSymbol} exchangeName={adrExchange.name}
              asset={ADR_ASSET} quote={quoteFor(adrVenueId)} value={adrLeverage} referencePrice={adrPrice}
              fallbackCurrent={adrPortfolioPosition?.leverage} fallbackMax={adrPortfolioPosition?.maxLeverage}
              tradingMode={tradingMode} disabled={reduceOnly} onOpenModeDialog={onOpenModeDialog} onValueChange={setAdrLeverage} onRiskLimitChange={setAdrRiskPositionValue} />
            <StrategyLeverageControl label="SKHYNIX leverage" symbol={hedgeSymbol} exchangeName={hedgeExchange.name}
              asset={ADR_HEDGE_ASSET} quote={quoteFor(hedgeVenueId)} value={hedgeLeverage} referencePrice={hedgePrice}
              fallbackCurrent={hedgePortfolioPosition?.leverage} fallbackMax={hedgePortfolioPosition?.maxLeverage}
              tradingMode={tradingMode} disabled={reduceOnly} onOpenModeDialog={onOpenModeDialog} onValueChange={setHedgeLeverage} onRiskLimitChange={setHedgeRiskPositionValue} />
          </div>
          {premiumInstrumentsReady && <div className={`strategy-size-check ${premiumInputsValid ? 'valid' : 'invalid'}`}><span>{premiumInputsValid ? '✓' : '!'}</span><p>{premiumInputsValid
            ? t('Per-order quantity meets both exchange minimums')
            : premiumSizeIssues.join(' · ') || t('Enter valid strategy amounts')}</p></div>}
          {!reduceOnly && configuredMaxPosition > 0 && premiumRiskLimitsReady && <div className={`strategy-size-check strategy-risk-limit-check ${premiumRiskLimitExceeded ? 'invalid' : 'valid'}`}><span>{premiumRiskLimitExceeded ? '!' : '✓'}</span><p>{premiumRiskLimitExceeded
            ? t('Configured position exceeds the maximum at selected leverage')
            : t('Configured position fits the leverage-tier limits')}</p></div>}
          <div className="strategy-setup-actions">
            <div className="compact-trigger"><span className={entryReady ? 'ready' : ''}>{entryReady ? '✓' : '○'}</span><p>{reduceOnly
              ? <>{t('Reduce existing positions at')} <strong>{entryComparator} {entryPremium || '0'}%</strong></>
              : <>{t('Enter at')} <strong>{entryComparator} {entryPremium || '0'}%</strong> · {t('Take profit at')} <strong>{exitComparator} {takeProfitPremium || '0'}%</strong></>}</p></div>
            <label className="reduce-only-control premium-reduce-only-control"><span onClick={(event) => event.preventDefault()}>{t('Position handling')}</span><div><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /><b>{t('Reduce only')}</b></div></label>
            <div className="compact-method premium-hedge-sizing"><span>{t('Hedge sizing')}</span>
              <div className="method-options maker-leg-picker hedge-sizing-options" role="group" aria-label={t('Hedge sizing')}>
                <button type="button" aria-pressed={hedgeMode === 'EQUAL_NOTIONAL'} className={hedgeMode === 'EQUAL_NOTIONAL' ? 'active' : ''} onClick={() => setHedgeMode('EQUAL_NOTIONAL')}><small>{t('Equal notional')}</small><strong>{t('Match value at entry')}</strong></button>
                <button type="button" aria-pressed={hedgeMode === 'SHARE_RATIO'} className={hedgeMode === 'SHARE_RATIO' ? 'active' : ''} onClick={() => setHedgeMode('SHARE_RATIO')}><small>{t('Share ratio')}</small><strong>1 {ADR_HEDGE_ASSET} = {adrRatio || '—'} {ADR_ASSET}</strong></button>
              </div>
            </div>
          </div>
          <div className="compact-stop"><span>◎</span><p>{t(reduceOnly ? 'Only reduces existing positions and stops at the target' : 'Runs one entry and take-profit cycle')}</p></div>
        </article>
        <article className="strategy-launch terminal-panel">
          <div className="launch-status"><span><i />{t('Review & launch')}</span><small>{t(reduceOnly ? 'Reduce only' : 'One cycle')}</small></div>
          <div className="launch-intent"><div><small>{t('Strategy')}</small><strong>{t(reduceOnly ? 'Reduce existing positions' : shortPremium ? 'Short premium' : 'Long premium')}</strong></div><p><span className={adrSide.toLowerCase()}>{t(adrSide)} {ADR_ASSET} · {adrExchange.name}</span><i>⇄</i><span className={hedgeSide.toLowerCase()}>{t(hedgeSide)} {ADR_HEDGE_ASSET} · {hedgeExchange.name}</span></p></div>
          <dl className="launch-summary review-grid">
            <div><dt>{t(reduceOnly ? 'Trigger' : 'Entry')}</dt><dd>{entryComparator} {entryPremium || '0'}%</dd></div>
            {!reduceOnly && <div><dt>{t('Take profit')}</dt><dd>{exitComparator} {takeProfitPremium || '0'}%</dd></div>}
            <div><dt>{t('Per order')}</dt><dd>{perOrderQuantity || '0'} {ADR_ASSET}</dd></div>
            <div><dt>{t('Hedge per order')}</dt><dd>{hedgePerOrderText ?? '—'}</dd></div>
            <div><dt>{t(reduceOnly ? 'Max close amount' : 'Max position')}</dt><dd>{maxPosition || '0'} {ADR_ASSET}</dd></div>
            {!reduceOnly && <div><dt>{t('Leverage')}</dt><dd>{adrLeverage || '—'}× / {hedgeLeverage || '—'}×</dd></div>}
            {!reduceOnly && <div><dt>{t('Max position at selected leverage')}</dt><dd>{adrRiskPositionValue !== null && adrRiskPositionValue !== undefined ? formatAmount(adrRiskPositionValue) : '—'} {quoteFor(adrVenueId)} / {hedgeRiskPositionValue !== null && hedgeRiskPositionValue !== undefined ? formatAmount(hedgeRiskPositionValue) : '—'} {quoteFor(hedgeVenueId)}</dd></div>}
            {!reduceOnly && <div><dt>{t('Projected position')}</dt><dd>{projectedAdrPositionValue !== null ? formatAmount(projectedAdrPositionValue) : '—'} {quoteFor(adrVenueId)} / {projectedHedgePositionValue !== null ? formatAmount(projectedHedgePositionValue) : '—'} {quoteFor(hedgeVenueId)}</dd></div>}
            {!reduceOnly && <div><dt>{t('Estimated margin')}</dt><dd>{marginEstimateAvailable ? `${formatAmount(estimatedTotalMargin)} USDT` : '—'}</dd></div>}
            <div><dt>{t('Hedge sizing')}</dt><dd>{t(hedgeMode === 'EQUAL_NOTIONAL' ? 'Equal notional' : 'Share ratio')}</dd></div>
          </dl>
          {!reduceOnly && foreignOppositePositions.length > 0 && <div className="launch-warning"><span>ⓘ</span><p>{t('Positions on another venue do not reduce this strategy’s margin requirement. Only positions on the selected exchange are offset.')}</p></div>}
          {premiumRiskLimitExceeded && <div className="launch-warning"><span>!</span><p>{t('Configured position exceeds the maximum at selected leverage')}</p></div>}
          <button className={tradingEnabled ? 'start-strategy' : 'start-strategy locked'} onClick={requestStrategyLaunch} disabled={launching || (tradingEnabled && !premiumLaunchReady)}>{launching ? t('Launching…') : !tradingEnabled ? t('Live trading locked') : !livePair ? t('Loading live data…') : premiumRiskLimitExceeded ? t('Position exceeds leverage limit') : premiumRiskReviewUnavailable ? t('Loading position limits…') : !premiumInputsValid ? t('Enter valid strategy amounts') : leverageInvalid ? t('Invalid leverage') : marginInsufficient ? t('Insufficient margin') : t(reduceOnly ? 'Launch reduce-only strategy' : 'Launch strategy')}</button>
          {launchNotice && <div className={`launch-notice ${launchNotice.kind}`}>{launchNotice.text}</div>}
        </article>
      </aside>
    </section>

    {confirmingLaunch && <StrategyLaunchConfirmation
      market={`${ADR_ASSET} / ${ADR_HEDGE_ASSET} · ${adrExchange.name} ⇄ ${hedgeExchange.name}`}
      rows={[
        { label: t('Direction'), value: `${t(adrSide)} ${ADR_ASSET} ⇄ ${t(hedgeSide)} ${ADR_HEDGE_ASSET}` },
        { label: t(reduceOnly ? 'Trigger' : 'Entry'), value: `${entryComparator} ${entryPremium || '0'}%` },
        ...(!reduceOnly ? [{ label: t('Take profit'), value: `${exitComparator} ${takeProfitPremium || '0'}%` }] : []),
        { label: t(reduceOnly ? 'Max close amount' : 'Max position'), value: `${maxPosition} ${ADR_ASSET}` },
        { label: t('Per order'), value: `${perOrderQuantity} ${ADR_ASSET}` },
        { label: t('Hedge per order'), value: hedgePerOrderText ?? '—' },
        ...(!reduceOnly ? [{ label: t('Leverage'), value: `${adrLeverage}× / ${hedgeLeverage}×` }] : []),
        { label: t('Hedge sizing'), value: t(hedgeMode === 'EQUAL_NOTIONAL' ? 'Equal notional' : 'Share ratio') },
        { label: t('Execution'), value: t('Taker–Taker') },
      ]}
      busy={launching}
      onCancel={() => setConfirmingLaunch(false)}
      onConfirm={() => { void launchStrategy(); }}
    />}
    <RunningStrategiesPanel strategies={strategies} authenticatedPortfolio={authenticatedPortfolio} tradingSnapshot={tradingSnapshot} instruments={instruments} tradingMode={tradingMode} onOpenModeDialog={onOpenModeDialog} onStrategiesChanged={onStrategiesChanged} onPositionsRefresh={onPositionsRefresh} />
  </div>;
}
