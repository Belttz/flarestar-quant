import { Fragment, useMemo, useState } from 'react';
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

/** RWA / crypto badge (same look as the funding and spread boards). */
function AssetClassBadge({ superClass }: { superClass: 'RWA' | 'CRYPTO' }) {
  const { t } = useLanguage();
  const isRwa = superClass === 'RWA';
  return <span className={`opportunity-asset-class ${isRwa ? 'rwa' : 'crypto'}`}><b>{t(isRwa ? 'RWA' : 'Crypto')}</b></span>;
}

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
export function FundingHedgeTable({ rows, history24h, nowMs, onExecute, superClassFor, executableSymbols }: {
  rows: FundingHedgeRow[];
  history24h: Readonly<Record<string, FundingHistoryEntry>>;
  nowMs: number;
  onExecute: (row: FundingHedgeRow) => void;
  superClassFor?: (asset: string) => 'RWA' | 'CRYPTO';
  /** CrossEx instrument symbols; a pair with a leg outside this set cannot be launched. */
  executableSymbols?: ReadonlySet<string> | null;
}) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const supported = (row: FundingHedgeRow): boolean => executableSymbols === undefined || executableSymbols === null
    || row.legs.every((leg) => executableSymbols.has(leg.symbol));
  // One parent row per asset, best *executable* net funding first. Binance BLUR has public funding
  // but no CrossEx instrument, so the parent must fall through to OKX/GATE instead of offering a
  // launch that the instrument preflight can never pass.
  const groups = useMemo(() => {
    const byAsset = new Map<string, FundingHedgeRow[]>();
    for (const row of rows) {
      const bucket = byAsset.get(row.asset);
      if (bucket === undefined) byAsset.set(row.asset, [row]);
      else bucket.push(row);
    }
    return [...byAsset].map(([asset, pairs]) => {
      const executable = pairs.filter((row) => supported(row));
      return { asset, best: executable[0] ?? pairs[0], pairs, hasExecutable: executable.length > 0 };
    });
  }, [rows, executableSymbols]);
  const mobileCards = <div className="opportunity-mobile-cards funding-hedge-cards">
    {groups.map((group) => {
      const best = group.best;
      const open = expanded === group.asset;
      const fundingLeg = hedgeFundingLeg(best);
      const net24h = hedgeNet24hPercent(best, history24h);
      return <article key={`${group.asset}:hedge-card`} className={`opportunity-mobile-card${group.hasExecutable ? '' : ' not-executable'}`}>
        <header className="om-card-head">
          <span className="om-asset"><i aria-hidden="true">{assetIcon(group.asset)}</i><span>
            <strong>{group.asset}</strong>
            {assetName(group.asset) !== group.asset && <small>{assetName(group.asset)}</small>}
          </span><AssetClassBadge superClass={superClassFor?.(group.asset) ?? 'CRYPTO'} /></span>
          <button type="button" className="row-action execute-action" disabled={!group.hasExecutable} onClick={() => onExecute(best)}>
            {group.hasExecutable ? t('Execute') : t('Not supported')}
          </button>
        </header>
        <div className="om-primary"><strong className="positive">{formatFundingPercent(best.net8hPercent)}</strong>
          <span>{t('Net funding')} · {t('Per 8h')}</span></div>
        <div className="om-legs">
          {best.legs.map((leg) => <div key={`${best.key}:${leg.venue}:${leg.symbol}`} className="om-leg">
            <span className="om-leg-venue"><VenueTag code={leg.venue} /></span>
            <small className="mono" title={leg.symbol}>{leg.symbol === '' ? '—' : leg.symbol}</small>
            <em className={leg.rate8hPercent !== null && leg.rate8hPercent < 0 ? 'negative' : 'positive'}>{formatFundingPercent(leg.rate8hPercent)}</em>
          </div>)}
        </div>
        <div className="om-metrics">
          <div><span>{t('Annualized')}</span><strong className="positive">{formatFundingPercent(best.aprPercent, 2)}</strong></div>
          <div><span>{t('Countdown')}</span><strong>{formatFundingCountdown(fundingCountdownMs(fundingLeg.nextFundingAt, nowMs))}</strong></div>
          <div><span>{t('Past 24h')}</span><strong className={net24h === null ? 'funding-missing' : net24h >= 0 ? 'positive' : 'negative'}>{formatFundingPercent(net24h)}</strong></div>
          <div><span>APY</span><strong className="positive">{net24h === null ? '—' : formatFundingPercent(fundingApyPercent(net24h, 365), 2)}</strong></div>
        </div>
        <div className="om-direction">
          <span className="direction-tag positive">{t('Short')} {fundingVenueName(best.short.venue)}</span>
          <small>{t('Long')} {fundingVenueName(best.long.venue)}</small>
        </div>
        <button type="button" className="om-combinations-toggle" aria-expanded={open}
          onClick={() => setExpanded(open ? null : group.asset)}>
          {t(open ? 'Collapse combinations' : 'Expand combinations')} · {group.pairs.length}
        </button>
        {open && <div className="om-combinations">
          {group.pairs.map((pair, index) => <div key={`${pair.key}:mobile`} className="om-combination">
            <span><b>{fundingVenueName(pair.short.venue)}</b> <em aria-hidden="true">→</em> <b>{fundingVenueName(pair.long.venue)}</b>
              {index === 0 && <em className="best-tag">{t('Best')}</em>}</span>
            <strong className="positive">{formatFundingPercent(pair.net8hPercent)}</strong>
            <small>{pair.net24hPercent === null ? '—' : formatFundingPercent(fundingApyPercent(pair.net24hPercent, 365), 2)} APY</small>
          </div>)}
        </div>}
      </article>;
    })}
  </div>;

  const rowCells = (row: FundingHedgeRow, compact: boolean) => {
    const fundingLeg = hedgeFundingLeg(row);
    const net24h = hedgeNet24hPercent(row, history24h);
    const blocked = (row.carry !== null && !row.carry.executable) || !supported(row);
    return <tr key={row.key} className={blocked ? 'not-executable' : ''}>
      <td><span className="hedge-pair"><b>{hedgePairLabel(row)}</b>
        <small>{row.short.kind === 'spot' || row.long.kind === 'spot' ? t('Spot ⇄ perpetual') : t('Perpetual ⇄ perpetual')}</small>
      </span></td>
      <FundingLegCell leg={row.legs[0]} />
      <FundingLegCell leg={row.legs[1]} />
      <td><strong className="positive">{formatFundingPercent(row.net8hPercent)}</strong>
        <small className="funding-period-label">{t('Per 8h')}</small></td>
      {/* Same annualization the funding-arb page and the spot-perp board use: pair 8h net × 1095. */}
      <td className="mono"><strong className="positive">{formatFundingPercent(row.aprPercent, 2)}</strong></td>
      <td className="mono">{formatFundingCountdown(fundingCountdownMs(fundingLeg.nextFundingAt, nowMs))}</td>
      <td><span className="direction-tag positive">{t('Short')} {fundingVenueName(row.short.venue)}</span>
        <small>{t('Long')} {fundingVenueName(row.long.venue)}</small></td>
      {!compact && <td>{formatFundingInterval(fundingLeg.intervalHours) ?? '—'}</td>}
      <td><strong className={net24h === null ? 'funding-missing' : net24h >= 0 ? 'positive' : 'negative'}>{formatFundingPercent(net24h)}</strong></td>
      <td className="mono">{net24h === null ? '—' : formatFundingPercent(fundingApyPercent(net24h, 365), 2)}</td>
      <td><button className="row-action execute-action" onClick={() => onExecute(row)} disabled={blocked}>
        {blocked ? t('Not supported') : t('Execute')}
      </button></td>
    </tr>;
  };
  return <div className="funding-hedge-wrap">
    {mobileCards}
    <div className="opportunity-table funding-hedge-table table-wrap"><table>
    <thead>
      <tr>
        <th>{t('Exchange pair')}</th>
        <th>{t('Leg 1')}</th>
        <th>{t('Leg 2')}</th>
        <th>{t('Net funding')}</th>
        <th>{t('Annualized')}</th>
        <th>{t('Countdown')}</th>
        <th>{t('Direction')}</th>
        <th>{t('Past 24h')}</th>
        <th>APY</th>
        <th />
      </tr>
    </thead>
    <tbody>{groups.map((group, groupIndex) => {
      const open = expanded === group.asset;
      const mobileLimited = groupIndex >= 3 && !mobileExpanded;
      return <Fragment key={group.asset}>
        <tr className={`hedge-asset-row${open ? ' open' : ''}${mobileLimited ? ' mobile-limited' : ''}`}>
          <td>
            <button type="button" className="row-action spread-toggle" aria-expanded={open}
              aria-label={t(open ? 'Collapse combinations' : 'Expand combinations')}
              onClick={() => setExpanded(open ? null : group.asset)}>
              {open ? '▾' : '▸'}<span className="hedge-toggle-label">{t(open ? 'Collapse combinations' : 'Expand combinations')} · {group.pairs.length}</span>
            </button>
            <span className="opportunity-asset"><i aria-hidden="true">{assetIcon(group.asset)}</i>
              <strong>{group.asset}</strong>{assetName(group.asset) !== group.asset && <small>{assetName(group.asset)}</small>}</span>
            <AssetClassBadge superClass={superClassFor?.(group.asset) ?? 'CRYPTO'} />
          </td>
          <FundingLegCell leg={group.best.legs[0]} />
          <FundingLegCell leg={group.best.legs[1]} />
          <td data-label={t('Net funding')}><strong className="positive">{formatFundingPercent(group.best.net8hPercent)}</strong>
            <small className="funding-period-label">{t('Per 8h')}</small></td>
          <td className="mono" data-label={t('Annualized')}><strong className="positive">{formatFundingPercent(group.best.aprPercent, 2)}</strong></td>
          <td className="mono">{formatFundingCountdown(fundingCountdownMs(hedgeFundingLeg(group.best).nextFundingAt, nowMs))}</td>
          <td><span className="direction-tag positive">{t('Short')} {fundingVenueName(group.best.short.venue)}</span>
            <small>{t('Long')} {fundingVenueName(group.best.long.venue)}</small></td>
          <td><strong className={group.best.net24hPercent === null ? 'funding-missing' : group.best.net24hPercent >= 0 ? 'positive' : 'negative'}>{formatFundingPercent(group.best.net24hPercent)}</strong></td>
          <td className="mono">{group.best.net24hPercent === null ? '—' : formatFundingPercent(fundingApyPercent(group.best.net24hPercent, 365), 2)}</td>
          <td><button className="row-action execute-action" onClick={() => onExecute(group.best)}
            disabled={!group.hasExecutable}>
            {group.hasExecutable ? t('Execute') : t('Not supported')}
          </button></td>
        </tr>
        {open && <tr className="hedge-mobile-combination-row"><td colSpan={10}>
          <div className="hedge-mobile-combinations">
            {group.pairs.map((pair, index) => <div key={`${pair.key}:mobile`} className="hedge-mobile-combination">
              <span className="hmc-path"><b>{fundingVenueName(pair.short.venue)}</b> <em aria-hidden="true">→</em> <b>{fundingVenueName(pair.long.venue)}</b>
                {index === 0 && <em className="best-tag">{t('Best')}</em>}</span>
              <strong className="positive">{formatFundingPercent(pair.net8hPercent)}</strong>
              <small>{pair.net24hPercent === null ? '—' : formatFundingPercent(fundingApyPercent(pair.net24hPercent, 365), 2)} APY</small>
            </div>)}
          </div>
        </td></tr>}
        {open && group.pairs.map((row) => <tr key={`${row.key}:detail`} className="hedge-detail-row">
          <td colSpan={10}>
            <table className="hedge-combination-table"><thead><tr>
              <th>{t('Exchange pair')}</th><th>{t('Leg 1')}</th><th>{t('Leg 2')}</th>
              <th>{t('Net funding')}</th><th>{t('Annualized')}</th><th>{t('Countdown')}</th>
              <th>{t('Direction')}</th><th>{t('Past 24h')}</th><th>APY</th><th />
            </tr></thead><tbody>{rowCells(row, false)}</tbody></table>
          </td>
        </tr>)}
      </Fragment>;
    })}</tbody>
  </table>{groups.length > 3 && <button type="button" className="opportunity-mobile-desktop-more" onClick={() => setMobileExpanded((current) => !current)}>
    {mobileExpanded ? t('Show fewer') : `${t('Show more')} · 3/${groups.length}`}
  </button>}
    </div>
  </div>;
}

/**
 * Single-venue funding extremes: the venue's perpetuals ordered by absolute funding rate, so the
 * most expensive side of each pair is visible without needing a second venue to pair against.
 * Clicking a symbol expands every venue that lists that asset — the same measurement, seen from
 * all exchanges at once, which is how you spot the outlier the selected venue is paired against.
 */
export function FundingRankingTable({ rows, venueCode, nowMs, locale, assetVenues, superClassFor }: {
  rows: VenueFundingRankingRow[];
  venueCode: string;
  nowMs: number;
  locale: string;
  /** Venue detail per asset, resolved by the caller from the same funding overview payload. */
  assetVenues: (asset: string) => AssetFundingVenueRow[];
  superClassFor?: (asset: string) => 'RWA' | 'CRYPTO';
}) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mobileVisible, setMobileVisible] = useState(5);
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
  const mobileCards = <div className="opportunity-mobile-cards funding-ranking-cards">
    {rows.slice(0, mobileVisible).map((row, index) => <article key={`${row.symbol}:${index}:card`} className="opportunity-mobile-card">
      <header className="om-card-head">
        <span className="om-asset"><i aria-hidden="true">{assetIcon(row.asset)}</i><span>
          <strong>{row.asset}</strong>
          {assetName(row.asset) !== row.asset && <small>{assetName(row.asset)}</small>}
        </span><AssetClassBadge superClass={superClassFor?.(row.asset) ?? 'CRYPTO'} /></span>
        <strong className={row.ratePercent >= 0 ? 'positive' : 'negative'}>{formatFundingPercent(row.ratePercent)}</strong>
      </header>
      <div className="om-metrics">
        <div><span>{t('Annualized')}</span><strong>{row.intervalHours ? formatFundingPercent(row.absRatePercent * (24 / row.intervalHours) * 365, 2) : '—'}</strong></div>
        <div><span>{t('Time to settlement')}</span><strong>{formatFundingCountdown(fundingCountdownMs(row.nextFundingAt, nowMs))}</strong></div>
        <div><span>{t('Open interest')}</span><strong>{moneyText(row.openInterestValue)}</strong></div>
        <div><span>{t('Next settlement')}</span><strong>{settlementText(row.nextFundingAt)}</strong></div>
      </div>
      <footer className="om-card-foot"><span>{fundingVenueName(venueCode)} · {formatFundingInterval(row.intervalHours) ?? '—'}</span><span>{t('Updated')} {updatedText(row.updatedAt)}</span></footer>
    </article>)}
    {rows.length > mobileVisible && <button type="button" className="opportunity-mobile-more funding-ranking-more" onClick={() => setMobileVisible((current) => current + 5)}>
      {t('Show more')} · {mobileVisible}/{rows.length}
    </button>}
  </div>;
  return <div className="funding-ranking-wrap">
    {mobileCards}
    <div className="opportunity-table funding-ranking-table table-wrap"><table>
    <thead><tr>
      <th className="hedge-index">#</th>
      <th>{t('Asset')}</th>
      <th>{t('Rate')}</th>
      <th>{t('Abs rate')}</th>
      <th>{t('Annualized')}</th>
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
          <AssetClassBadge superClass={superClassFor?.(row.asset) ?? 'CRYPTO'} />
        </td>
        <td><strong className={row.ratePercent >= 0 ? 'positive' : 'negative'}>{formatFundingPercent(row.ratePercent)}</strong>
          <small>{fundingVenueName(venueCode)}</small></td>
        <td className="mono"><strong>{row.absRatePercent.toFixed(4)}%</strong></td>
        <td className="mono">{row.intervalHours ? formatFundingPercent(row.absRatePercent * (24 / row.intervalHours) * 365, 2) : '—'}</td>
        <td>{formatFundingInterval(row.intervalHours) ?? '—'}</td>
        <td className="mono">{settlementText(row.nextFundingAt)}</td>
        <td className="mono">{formatFundingCountdown(fundingCountdownMs(row.nextFundingAt, nowMs))}</td>
        <td className="opportunity-stats mono">{moneyText(row.openInterestValue)}</td>
        <td className="mono">{updatedText(row.updatedAt)}</td>
      </tr>;
      if (!isOpen) return [summary];
      const detail = <tr key={`${row.symbol}:${index}:detail`} className="funding-ranking-detail">
        <td colSpan={10}>
          {venues.length === 0
            ? <p className="funding-ranking-detail-empty">{t('No other venue lists this asset.')}</p>
            : <table className="funding-ranking-venues">
              <thead><tr>
                <th>{t('Exchange')}</th>
                <th>{t('Trading pair')}</th>
                <th>{t('Rate')}</th>
                <th>{t('Abs rate')}</th>
                <th>{t('Annualized')}</th>
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
                <td className="mono">{venue.absRatePercent === null || venue.intervalHours === null ? '—' : formatFundingPercent(venue.absRatePercent * (24 / venue.intervalHours) * 365, 2)}</td>
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
  </table></div>
  </div>;
}
