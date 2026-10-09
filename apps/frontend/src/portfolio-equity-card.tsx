import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PORTFOLIO_EQUITY_RANGE_MS,
  type PortfolioEquityRange,
  type PortfolioEquitySeriesResponse,
} from '@gate-crossex/shared-types';
import { api } from './api.js';
import { EquityHistoryChart } from './charts.js';
import { useLanguage } from './i18n.js';
import { formatAmount } from './route-shared.js';

/** Chart ranges offered by the asset page, in display order (`all` is localized). */
const EQUITY_RANGES: readonly PortfolioEquityRange[] = ['24h', '7d', '30d', 'all'];

function equityRangeLabel(range: PortfolioEquityRange): string {
  return range === 'all' ? 'All' : range;
}

export interface EquityChartPoint {
  time: number;
  value: number;
}

interface EquityCardBodyProps {
  loading: boolean;
  error: boolean;
  points: EquityChartPoint[];
  firstSampleAt: string | null;
  range: PortfolioEquityRange;
  theme: 'dark' | 'light';
  locale: string;
  onRetry: () => void;
  onRangeChange: (range: PortfolioEquityRange) => void;
}

/**
 * Pure presentational body of the equity card, exported separately so SSR tests can render
 * every state (loading lives in effects, which `renderToStaticMarkup` never runs).
 */
export function EquityCardBody({
  loading,
  error,
  points,
  firstSampleAt,
  range,
  theme,
  locale,
  onRetry,
  onRangeChange,
}: EquityCardBodyProps) {
  const { t } = useLanguage();
  const first = points[0] ?? null;
  const last = points.length > 0 ? points[points.length - 1] ?? null : null;
  const changeValue = first !== null && last !== null ? last.value - first.value : null;
  const changePercent = changeValue !== null && first !== null && first.value !== 0
    ? (changeValue / Math.abs(first.value)) * 100
    : null;
  const sinceMs = firstSampleAt !== null ? Date.parse(firstSampleAt) : Number.NaN;
  const sinceText = Number.isFinite(sinceMs)
    ? new Date(sinceMs).toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour12: false })
    : null;
  // `all` has no window length; a huge duration keeps the whole series visible from the start.
  const visibleDurationMs = PORTFOLIO_EQUITY_RANGE_MS[range] || Number.MAX_SAFE_INTEGER;
  return <article className="equity-card terminal-panel">
    <div className="section-title">
      <div><p className="eyebrow">{t('Performance')}</p><h2>{t('Equity curve')}</h2></div>
      <div className="equity-range-tabs" role="group" aria-label={t('Equity curve range')}>
        {EQUITY_RANGES.map((item) => <button
          key={item}
          type="button"
          className={range === item ? 'active' : ''}
          aria-pressed={range === item}
          onClick={() => onRangeChange(item)}
        >{t(equityRangeLabel(item))}</button>)}
      </div>
    </div>
    {sinceText !== null && <p className="equity-since">
      {t('Sampling since')} <time dateTime={firstSampleAt ?? undefined}>{sinceText}</time>
    </p>}
    <div className="equity-chart">
      {loading ? <div className="equity-message" role="status"><span>◌</span><strong>{t('Loading equity curve…')}</strong></div>
        : error ? <div className="equity-message error"><span>!</span><strong>{t('Equity curve unavailable')}</strong><button type="button" onClick={onRetry}>{t('Try again')}</button></div>
          : points.length < 2 ? <div className="equity-message"><span>◎</span><strong>{t('No samples yet')}</strong><small>{t('Samples are recorded while the terminal runs; the curve fills in over the first days.')}</small></div>
            : <EquityHistoryChart
              points={points}
              seriesKey={`equity-${range}`}
              visibleDurationMs={visibleDurationMs}
              theme={theme}
              locale={locale}
              placeholder={t('No samples yet')}
              onHover={() => undefined}
              onLoadMore={() => undefined}
            />}
    </div>
    {!loading && !error && changeValue !== null && changePercent !== null && <p className={`equity-change ${changeValue >= 0 ? 'positive' : 'negative'}`}>
      {t('Range change')}{' '}
      <strong>{changeValue >= 0 ? '+' : '-'}${formatAmount(Math.abs(changeValue))}</strong>
      {' '}({changeValue >= 0 ? '+' : '-'}{formatAmount(Math.abs(changePercent))}%)
    </p>}
    <p className="equity-note">{t('Curve covers the CrossEx account margin balance; Gate spot balances are not included.')}</p>
  </article>;
}

export interface PortfolioEquityCardProps {
  /** Increment to force a curve reload, e.g. after the portfolio refresh button. */
  refreshSignal?: number;
  /**
   * Latest equity from the live snapshot, appended to the curve when it is newer than the last
   * persisted sample so the endpoint of the line tracks the KPI between reconciliations.
   */
  currentEquity?: EquityChartPoint | null;
}

/** Asset-page equity curve card: range tabs + area chart over the sampled equity series. */
export function PortfolioEquityCard({ refreshSignal = 0, currentEquity = null }: PortfolioEquityCardProps) {
  const { language, theme } = useLanguage();
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  const [range, setRange] = useState<PortfolioEquityRange>('24h');
  const [series, setSeries] = useState<PortfolioEquitySeriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    api.portfolioEquity(range)
      .then((response) => {
        if (cancelled) return;
        setSeries(response);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [range, reloadKey, refreshSignal]);

  const points = useMemo<EquityChartPoint[]>(() => {
    const base = (series?.points ?? []).map((point) => ({ time: point.time, value: Number(point.equity) }));
    if (currentEquity === null || !Number.isFinite(currentEquity.time) || currentEquity.time <= 0) return base;
    const last = base[base.length - 1];
    if (last && last.time >= currentEquity.time) return base;
    return [...base, { time: currentEquity.time, value: currentEquity.value }];
  }, [series, currentEquity]);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);
  return <EquityCardBody
    loading={loading}
    error={error}
    points={points}
    firstSampleAt={series?.firstSampleAt ?? null}
    range={range}
    theme={theme}
    locale={locale}
    onRetry={retry}
    onRangeChange={setRange}
  />;
}
