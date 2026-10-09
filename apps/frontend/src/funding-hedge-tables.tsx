import { useState } from 'react';
import type { FundingHistoryEntry } from './api.js';
import {
  formatFundingCountdown,
  formatFundingInterval,
  formatFundingPercent,
  fundingApyPercent,
  fundingCountdownMs,
  fundingVenueOptions,
  hedgeFundingLeg,
  hedgeNet24hPercent,
  hedgePairLabel,
  type AssetFundingVenueRow,
  type FundingHedgeLeg,
  type FundingHedgeRow,
  type VenueFundingRankingRow,
} from './funding-hedge.js';
import { useLanguage } from './i18n.js';
import { VenueIcon, assetIcon, assetName, fundingVenueName } from './route-shared.js';

/** Venue code → logo option, so a leg can render its exchange icon without a linear scan. */
const VENUE_BY_CODE = new Map(fundingVenueOptions().map((option) => [option.code, option]));

function VenueTag({ code }: { code: string }) {
  const option = VENUE_BY_CODE.get(code);
  return <span className="hedge-venue-tag">
    {option ? <VenueIcon id={option.id} short={option.short} /> : null}
    <b>{fundingVenueName(code)}</b>
  </span>;
}

function FundingLegCell({ leg }: { leg: FundingHedgeLeg }) {
  return <td>
    <span className="opportunity-leg">
      <VenueTag code={leg.venue} />
      <small className="mono">{leg.symbol === '' ? '—' : leg.symbol}</small>
      <em className={leg.rate8hPercent !== null && leg.rate8hPercent < 0 ? 'negative' : 'positive'}>
        {formatFundingPercent(leg.rate8hPercent)}
      </em>
    </span>
  </td>;
}

/**
 * Cross-exchange funding hedge board: one row per asset and exchange pair, both legs side by side,
 * the net the pair collects every 8h, its settlement countdown, and the realized 24h equivalent.
 * Every value is already computed by the pure funding-hedge model — this only renders.
 */
export function FundingHedgeTable({ rows, history24h, nowMs, onExecute }: {
  rows: FundingHedgeRow[];
  history24h: Readonly<Record<string, FundingHistoryEntry>>;
  nowMs: number;
  onExecute: (row: FundingHedgeRow) => void;
}) {
  const { t } = useLanguage();
  return <div className="opportunity-table funding-hedge-table table-wrap"><table>
    <thead>
      <tr>
        <th rowSpan={2} className="hedge-index">#</th>
        <th rowSpan={2}>{t('Exchange pair')}</th>
        <th rowSpan={2}>{t('Asset')}</th>
        <th rowSpan={2}>{t('Leg 1')}</th>
        <th rowSpan={2}>{t('Leg 2')}</th>
        <th colSpan={4} className="hedge-group-head">{t('Next settlement')}</th>
        <th colSpan={3} className="hedge-group-head">{t('Past 24h')}</th>
        <th rowSpan={2} />
      </tr>
      <tr>
        <th>{t('Net funding')}</th>
        <th>{t('Countdown')}</th>
        <th>{t('Direction')}</th>
        <th>{t('Settlement interval')}</th>
        <th>{t('Net funding')}</th>
        <th>{t('Annualized')}</th>
        <th>APY</th>
      </tr>
    </thead>
    <tbody>{rows.map((row, index) => {
      const fundingLeg = hedgeFundingLeg(row);
      const net24h = hedgeNet24hPercent(row, history24h);
      const blocked = row.carry !== null && !row.carry.executable;
      return <tr key={row.key} className={blocked ? 'not-executable' : ''}>
        <td className="hedge-index">{index + 1}</td>
        <td><span className="hedge-pair"><b>{hedgePairLabel(row)}</b>
          <small>{row.short.kind === 'spot' || row.long.kind === 'spot' ? t('Spot ⇄ perpetual') : t('Perpetual ⇄ perpetual')}</small>
        </span></td>
        <td><span className="opportunity-asset"><i aria-hidden="true">{assetIcon(row.asset)}</i><strong>{row.asset}</strong><small>{assetName(row.asset)}</small></span></td>
        <FundingLegCell leg={row.legs[0]} />
        <FundingLegCell leg={row.legs[1]} />
        <td><strong className="positive">{formatFundingPercent(row.net8hPercent)}</strong>
          <small className="funding-period-label">{t('Per 8h')}</small></td>
        <td className="mono">{formatFundingCountdown(fundingCountdownMs(fundingLeg.nextFundingAt, nowMs))}</td>
        <td><span className="direction-tag positive">{t('Short')} {fundingVenueName(row.short.venue)}</span>
          <small>{t('Long')} {fundingVenueName(row.long.venue)}</small></td>
        <td>{formatFundingInterval(fundingLeg.intervalHours) ?? '—'}</td>
        <td><strong className={net24h === null ? 'funding-missing' : net24h >= 0 ? 'positive' : 'negative'}>{formatFundingPercent(net24h)}</strong></td>
        <td className="mono">{net24h === null ? '—' : formatFundingPercent(net24h * 365)}</td>
        <td className="mono">{net24h === null ? '—' : formatFundingPercent(fundingApyPercent(net24h, 365), 2)}</td>
        <td><button className="row-action execute-action" onClick={() => onExecute(row)} disabled={blocked}>
          {blocked ? t('Not connected') : t('Execute')}
        </button></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

/**
 * Single-venue funding extremes: the venue's perpetuals ordered by absolute funding rate, so the
 * most expensive side of each pair is visible without needing a second venue to pair against.
 * Clicking a symbol expands every venue that lists that asset — the same measurement, seen from
 * all exchanges at once, which is how you spot the outlier the selected venue is paired against.
 */
export function FundingRankingTable({ rows, venueCode, nowMs, locale, assetVenues }: {
  rows: VenueFundingRankingRow[];
  venueCode: string;
  nowMs: number;
  locale: string;
  /** Venue detail per asset, resolved by the caller from the same funding overview payload. */
  assetVenues: (asset: string) => AssetFundingVenueRow[];
}) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState<string | null>(null);
  const settlementText = (iso: string | null) => {
    if (iso === null) return '—';
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed)
      ? new Date(parsed).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      : '—';
  };
  const updatedText = (iso: string | null) => {
    if (iso === null) return '—';
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString(locale, { hour12: false }) : '—';
  };
  const moneyText = (value: number | null) => value === null ? '—' : `$${Math.round(value).toLocaleString(locale)}`;
  return <div className="opportunity-table funding-ranking-table table-wrap"><table>
    <thead><tr>
      <th className="hedge-index">#</th>
      <th>{t('Asset')}</th>
      <th>{t('Rate')}</th>
      <th>{t('Abs rate')}</th>
      <th>{t('Settlement interval')}</th>
      <th>{t('Next settlement')}</th>
      <th>{t('Time to settlement')}</th>
      <th>{t('Open interest')}</th>
      <th>{t('Updated')}</th>
    </tr></thead>
    <tbody>{rows.flatMap((row, index) => {
      const isOpen = expanded === row.asset;
      const venues = isOpen ? assetVenues(row.asset) : [];
      const summary = <tr key={`${row.symbol}:${index}`} className={`funding-ranking-row${isOpen ? ' expanded' : ''}`}>
        <td className="hedge-index">{index + 1}</td>
        <td>
          <button type="button" className="funding-ranking-asset" aria-expanded={isOpen}
            aria-label={`${t('All exchanges')}: ${row.asset}`}
            onClick={() => setExpanded(isOpen ? null : row.asset)}>
            <i aria-hidden="true">{assetIcon(row.asset)}</i>
            <span><strong>{row.asset}</strong><small className="mono">{row.symbol}</small></span>
            <em aria-hidden="true">{isOpen ? '⌃' : '⌄'}</em>
          </button>
        </td>
        <td><strong className={row.ratePercent >= 0 ? 'positive' : 'negative'}>{formatFundingPercent(row.ratePercent)}</strong>
          <small>{fundingVenueName(venueCode)}</small></td>
        <td className="mono"><strong>{row.absRatePercent.toFixed(4)}%</strong></td>
        <td>{formatFundingInterval(row.intervalHours) ?? '—'}</td>
        <td className="mono">{settlementText(row.nextFundingAt)}</td>
        <td className="mono">{formatFundingCountdown(fundingCountdownMs(row.nextFundingAt, nowMs))}</td>
        <td className="opportunity-stats mono">{moneyText(row.openInterestValue)}</td>
        <td className="mono">{updatedText(row.updatedAt)}</td>
      </tr>;
      if (!isOpen) return [summary];
      const detail = <tr key={`${row.symbol}:${index}:detail`} className="funding-ranking-detail">
        <td colSpan={9}>
          {venues.length === 0
            ? <p className="funding-ranking-detail-empty">{t('No other venue lists this asset.')}</p>
            : <table className="funding-ranking-venues">
              <thead><tr>
                <th>{t('Exchange')}</th>
                <th>{t('Trading pair')}</th>
                <th>{t('Rate')}</th>
                <th>{t('Abs rate')}</th>
                <th>{t('Settlement interval')}</th>
                <th>{t('Next settlement')}</th>
                <th>{t('Time to settlement')}</th>
                <th>{t('Open interest')}</th>
                <th>{t('Updated')}</th>
              </tr></thead>
              <tbody>{venues.map((venue) => <tr key={venue.symbol} className={venue.venue === venueCode ? 'current' : ''}>
                <td><span className="hedge-venue-tag">{VENUE_BY_CODE.has(venue.venue) ? <VenueIcon id={VENUE_BY_CODE.get(venue.venue)!.id} short={VENUE_BY_CODE.get(venue.venue)!.short} /> : null}<b>{fundingVenueName(venue.venue)}</b></span></td>
                <td className="mono">{venue.symbol}</td>
                <td><strong className={venue.ratePercent === null ? 'funding-missing' : venue.ratePercent >= 0 ? 'positive' : 'negative'}>{formatFundingPercent(venue.ratePercent)}</strong></td>
                <td className="mono">{venue.absRatePercent === null ? '—' : `${venue.absRatePercent.toFixed(4)}%`}</td>
                <td>{formatFundingInterval(venue.intervalHours) ?? '—'}</td>
                <td className="mono">{settlementText(venue.nextFundingAt)}</td>
                <td className="mono">{formatFundingCountdown(fundingCountdownMs(venue.nextFundingAt, nowMs))}</td>
                <td className="opportunity-stats mono">{moneyText(venue.openInterestValue)}</td>
                <td className="mono">{updatedText(venue.updatedAt)}</td>
              </tr>)}</tbody>
            </table>}
        </td>
      </tr>;
      return [summary, detail];
    })}</tbody>
  </table></div>;
}
