import { Fragment } from 'react';
import type { SpreadQualityRow } from '@gate-crossex/shared-types';
import { useLanguage } from './i18n.js';
import { LegFundingRates } from './leg-funding-rates.js';
import { assetIcon, assetName, formatOpportunityAmount, fundingVenueName } from './route-shared.js';

/**
 * One asset's slot on the spread-quality board. The server ranks *combinations* — one
 * (asset, sell venue, buy venue) triple per row — by composite score, so the first row of an asset
 * in the payload is its best combination and mirrors into the parent row, exactly like the spread
 * board's best-path row. `combinations` drives the expand/collapse detail view.
 */
export interface SpreadQualityGroup {
  asset: string;
  /** Highest-scoring combination of the asset (rows arrive score-sorted, best first). */
  best: SpreadQualityRow;
  /** Every (sell venue, buy venue) combination of the asset, best first. */
  combinations: SpreadQualityRow[];
}

/**
 * Group pair-level rows by asset, preserving the server's score-descending order inside each
 * group. The board ranks combinations while the table reads per asset, so this only buckets the
 * rows an expand reveals — it never re-sorts, and a combination can never jump ahead of a
 * better-scoring one from the same asset.
 */
export function groupSpreadQualityRows(rows: readonly SpreadQualityRow[]): SpreadQualityGroup[] {
  const byAsset = new Map<string, SpreadQualityRow[]>();
  for (const row of rows) {
    const bucket = byAsset.get(row.asset);
    if (bucket === undefined) byAsset.set(row.asset, [row]);
    else bucket.push(row);
  }
  // Map iteration follows insertion order, so the first appearance of an asset — its best
  // combination — fixes the group's rank on the board.
  return [...byAsset].map(([asset, combinations]) => ({ asset, best: combinations[0], combinations }));
}

/**
 * Bps columns render with two decimals. A missing statistic is an em dash — never a fake zero:
 * the series was too short or degenerate to support it, which is information, not a value.
 */
export function formatSpreadQualityBps(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

/** Regression half-life in hours with one decimal; `null` (the series does not revert) is a dash. */
export function formatHalfLifeHours(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

/** Composite 0–100 opportunity score, one decimal. */
export function formatOpportunityScore(value: number): string {
  return value.toFixed(1);
}

/**
 * Symmetry badge of one combination: a check when the 24h distribution behaves as modelled, a
 * warning with a tooltip when it is skewed (big spreads lean one way).
 */
export function SpreadQualitySymmetryBadge({ symmetric }: { symmetric: boolean }) {
  const { t } = useLanguage();
  return symmetric
    ? <span className="quality-symmetry ok" title={t('Symmetric distribution')}>✓</span>
    : <span className="quality-symmetry skew" title={t('Skewed distribution')}>⚠</span>;
}

/**
 * Where the 24h series behind the statistics came from: reconstructed from 5-minute candles, or
 * sampled from live executable spreads once a day of samples has accumulated.
 */
export function SpreadQualitySourceBadge({ source }: { source: SpreadQualityRow['source'] }) {
  const { t } = useLanguage();
  return <span className="opportunity-source-badge">
    {source === 'candles' ? t('Candle rebuild') : t('Live sampling')}
  </span>;
}

/** Sell-leg / buy-leg cell of the expanded detail table, mirroring the spread board's leg cell. */
function QualityLegCell({ venue, symbol, leg }: { venue: string; symbol: string; leg: 'Sell leg' | 'Buy leg' }) {
  const { t } = useLanguage();
  return <span className="opportunity-leg">
    <b className="venue-badge" title={t(leg)}>{fundingVenueName(venue)}</b>
    <small className="mono">{symbol}</small>
  </span>;
}

/**
 * Server-side sort keys of the spread-quality board (R8). Every key maps onto a column of the
 * table; the composite score stays the default ranking, and the direction toggles by clicking
 * the active chip again.
 */
export type SpreadQualitySortKey = 'score' | 'current' | 'mean' | 'volatility' | 'halfLife' | 'depth';
export type SpreadQualitySortDir = 'asc' | 'desc';

/** Chip labels reuse the table's own column translations so the two can never drift apart. */
export const SPREAD_QUALITY_SORT_OPTIONS: ReadonlyArray<{ key: SpreadQualitySortKey; label: string }> = [
  { key: 'score', label: 'Opportunity score' },
  { key: 'current', label: 'Current spread' },
  { key: 'mean', label: 'Mean spread' },
  { key: 'volatility', label: 'Spread volatility' },
  { key: 'halfLife', label: 'Half-life' },
  { key: 'depth', label: 'Book depth' },
];

/**
 * The board's sort chips: one per server sort key. Clicking a chip selects its key (descending,
 * matching the board's default ranking direction); clicking the active chip flips the direction.
 * Sorting is executed server side — the chips only change query parameters, never the rows.
 */
export function SpreadQualitySortChips({ sort, dir, onSortChange }: {
  sort: SpreadQualitySortKey;
  dir: SpreadQualitySortDir;
  onSortChange: (sort: SpreadQualitySortKey, dir: SpreadQualitySortDir) => void;
}) {
  const { t } = useLanguage();
  return <div className="panel-filter-chips quality-sort-chips" role="group" aria-label={t('Sort by')}>
    {SPREAD_QUALITY_SORT_OPTIONS.map((option) => {
      const active = option.key === sort;
      const nextDir: SpreadQualitySortDir = active ? (dir === 'desc' ? 'asc' : 'desc') : 'desc';
      return <button key={option.key} type="button" data-sort-chip={option.key}
        className={active ? 'active' : ''}
        aria-label={`${t(option.label)} · ${t(nextDir === 'asc' ? 'ascending' : 'descending')}`}
        onClick={() => onSortChange(option.key, nextDir)}>
        {t(option.label)}{active ? (dir === 'desc' ? ' ↓' : ' ↑') : ''}
      </button>;
    })}
  </div>;
}

/**
 * Stale-quote badge (R4): the two legs' quotes were too far apart in time for the spread to be
 * executable as displayed. The row still shows (the server sinks it to the bottom) but the
 * number carries a visible warning instead of silently reading as a live opportunity.
 */
export function SpreadQualityStaleBadge() {
  const { t } = useLanguage();
  return <span className="quality-stale-badge" title={t('Leg quotes are not time-aligned')}>{t('Quotes misaligned')}</span>;
}

/**
 * Spread-quality board table: one parent row per asset (its best combination) that expands into
 * the asset's full combination list. Every column is a 24h distribution statistic except the
 * current spread, the book depth and the composite score; the nullable statistics render as an
 * em dash. Rows arrive pre-ranked by score from the server — v1 ships no column-header sorting,
 * so the headers are plain `th` cells.
 *
 * Expansion is controlled: the parent owns which asset is open (`expandedAsset`) and receives
 * toggles through `onToggleExpand`, the same pattern the spread board uses.
 */
export function SpreadQualityTable({ rows, expandedAsset, onToggleExpand }: {
  rows: readonly SpreadQualityRow[];
  expandedAsset: string | null;
  onToggleExpand: (asset: string) => void;
}) {
  const { t } = useLanguage();
  const groups = groupSpreadQualityRows(rows);
  return <div className="opportunity-table opportunity-spread-quality-table table-wrap"><table>
    <thead><tr>
      <th aria-label={t('Expand combinations')} />
      <th>#</th>
      <th>{t('Asset')}</th>
      {/* Both legs' current funding rate, next to the pair it applies to. */}
      <th>{t('Funding rate')}</th>
      <th>{t('Current spread')}</th>
      <th>{t('Mean spread')}</th>
      <th>{t('Spread volatility')}</th>
      <th>{t('Skewness')}</th>
      <th>{t('Kurtosis')}</th>
      <th>{t('Symmetric')}</th>
      <th>{t('Half-life')}</th>
      <th>{t('Holding cost')}</th>
      <th>{t('Book depth')}</th>
      <th>{t('Opportunity score')}</th>
    </tr></thead>
    <tbody>{groups.map((group, index) => {
      const open = expandedAsset === group.asset;
      const best = group.best;
      return <Fragment key={group.asset}>
        <tr className={open ? 'spread-quality-asset-row open' : 'spread-quality-asset-row'}>
          <td><button type="button" className="row-action spread-toggle"
            aria-expanded={open} aria-label={t(open ? 'Collapse combinations' : 'Expand combinations')}
            onClick={() => onToggleExpand(group.asset)}>{open ? '▾' : '▸'}</button></td>
          <td className="mono">{index + 1}</td>
          <td>
            <span className="opportunity-asset">
              <i aria-hidden="true">{assetIcon(group.asset)}</i>
              <strong>{group.asset}</strong>
              <small>{assetName(group.asset)}</small>
            </span>
            <span className="quality-legs">
              <QualityLegCell venue={best.leftVenue} symbol={best.leftSymbol} leg="Sell leg" />
              <QualityLegCell venue={best.rightVenue} symbol={best.rightSymbol} leg="Buy leg" />
            </span>
          </td>
          <td className="opportunity-funding-cell"><LegFundingRates
            leftFundingRate8h={best.leftFundingRate8h}
            rightFundingRate8h={best.rightFundingRate8h}
            fundingRateDiffBps={best.fundingRateDiffBps}
          /></td>
          {/* Current spread, mean, volatility and holding cost are bps; half-life is hours. */}
          <td><strong className={best.currentSpreadBps >= 0 ? 'positive' : 'negative'}>{formatSpreadQualityBps(best.currentSpreadBps)}</strong>{best.quoteAligned === false && <SpreadQualityStaleBadge />}</td>
          <td className="mono">{formatSpreadQualityBps(best.meanSpreadBps)}</td>
          <td className="mono">{formatSpreadQualityBps(best.spreadVolatilityBps)}</td>
          <td className="mono">{formatSpreadQualityBps(best.skewness)}</td>
          <td className="mono">{formatSpreadQualityBps(best.excessKurtosis)}</td>
          <td><SpreadQualitySymmetryBadge symmetric={best.symmetric} /></td>
          <td className="mono">{formatHalfLifeHours(best.halfLifeHours)}</td>
          <td className="mono">{formatSpreadQualityBps(best.holdingCostBps)}</td>
          <td className="mono" title={`${best.bookDepthUsdt} USDT`}>{formatOpportunityAmount(String(best.bookDepthUsdt))}</td>
          <td className="mono"><strong className="positive quality-score">{formatOpportunityScore(best.score)}</strong></td>
        </tr>
        {open && <tr className="spread-quality-detail-row"><td colSpan={14}>
          <table className="spread-quality-combination-table">
            <thead><tr>
              <th>{t('Pair')}</th>
              <th>{t('Sell leg')}</th>
              <th>{t('Buy leg')}</th>
              <th>{t('Funding rate')}</th>
              <th>{t('Current spread')}</th>
              <th>{t('Opportunity score')}</th>
              <th>{t('Symmetric')}</th>
              <th>{t('Half-life')}</th>
            </tr></thead>
            <tbody>{group.combinations.map((combination, combinationIndex) => <tr
              key={`${combination.leftSymbol}:${combination.rightSymbol}`}
              className={combinationIndex === 0 ? 'best' : ''}>
              <td>{combinationIndex === 0 ? <em className="best-tag">{t('Best')}</em> : combinationIndex + 1}</td>
              <td><QualityLegCell venue={combination.leftVenue} symbol={combination.leftSymbol} leg="Sell leg" /></td>
              <td><QualityLegCell venue={combination.rightVenue} symbol={combination.rightSymbol} leg="Buy leg" /></td>
              <td className="opportunity-funding-cell"><LegFundingRates
                leftFundingRate8h={combination.leftFundingRate8h}
                rightFundingRate8h={combination.rightFundingRate8h}
                fundingRateDiffBps={combination.fundingRateDiffBps}
              /></td>
              <td><strong className={combination.currentSpreadBps >= 0 ? 'positive' : 'negative'}>{formatSpreadQualityBps(combination.currentSpreadBps)}</strong>{combination.quoteAligned === false && <SpreadQualityStaleBadge />}</td>
              <td className="mono">{formatOpportunityScore(combination.score)}</td>
              <td><SpreadQualitySymmetryBadge symmetric={combination.symmetric} /></td>
              <td className="mono">{formatHalfLifeHours(combination.halfLifeHours)}</td>
            </tr>)}</tbody>
          </table>
        </td></tr>}
      </Fragment>;
    })}</tbody>
  </table></div>;
}
