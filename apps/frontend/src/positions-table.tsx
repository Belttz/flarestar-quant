import { Fragment, useEffect, useMemo, useState } from 'react';
import { AdlIndicators } from './adl-indicator.js';
import { usePhoneLayout } from './execution-tables.js';
import { ExecutionPagination } from './execution-pagination-control.js';
import { executionPageWindow } from './execution-pagination.js';
import { useLanguage } from './i18n.js';
import { compactPrice } from './number-format.js';
import { formatAmount, signedAmount, VenueCell, exchanges } from './route-shared.js';
import { groupPositionRows, type PositionTableGroup, type PositionTableRow } from './strategy-positions.js';

interface PositionsTableProps {
  rows: readonly PositionTableRow[];
  onClose: (rows: PositionTableRow[]) => void;
}

function VenueFromCode({ code }: { code: string }) {
  const exchange = exchanges.find((item) => item.id === code.toLowerCase());
  return <VenueCell id={code.toLowerCase()} name={exchange?.name ?? code} short={exchange?.short ?? code.slice(0, 2)} />;
}

function pnlText(value: number, quote: string): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} ${quote}`;
}

/**
 * The three "unknown, not zero" flags a row can carry (see `PositionTableRow`).
 *
 * A perpetual never trades at 0, so a missing price means unknown. Rendering the raw numbers in
 * that case prints a confident `0` / `0.00`, which reads as a real price and a real loss — the
 * venues whose public REST is unreachable from this machine (Binance / OKX / Bybit / Kraken) hit
 * this constantly. Each cell consults its own flag because the underlying facts differ: a venue can
 * report the position's notional while omitting its mark price, and a venue-reported PnL stays
 * trustworthy even then.
 */
function valueUnknown(position: PositionTableRow): boolean {
  return position.valueUnavailable === true;
}

/** No mark price for this leg: the price cell prints `—` instead of `0`. */
function markUnknown(position: PositionTableRow): boolean {
  return position.markPriceUnavailable === true;
}

/** The PnL of this row was derived locally from a price the venue never sent. */
function pnlUnknown(position: PositionTableRow): boolean {
  return position.pnlUnavailable === true;
}

function optionalAmount(value: number | null, quote: string): string {
  return value === null ? '—' : `${signedAmount(value)} ${quote}`;
}

function realizedAmount(value: number | null, quote: string): string {
  return value === null ? '—' : `${value.toFixed(2)} ${quote}`;
}

function amountTone(value: number | null): string {
  return value !== null && value > 0 ? 'positive' : value !== null && value < 0 ? 'negative' : '';
}

/** The ordered label/value grid shared by a single-leg card and one leg inside an aggregate card. */
function PositionDetails({ position }: { position: PositionTableRow }) {
  const { t } = useLanguage();
  return <dl className="position-mobile-grid">
    <div><dt>{t('Exchange')}</dt><dd><VenueFromCode code={position.venue} /></dd></div>
    <div><dt>{t('Size')}</dt><dd>{position.quantity.toFixed(4)} {position.asset}</dd></div>
    <div><dt>{t('Position notional')}</dt><dd>{valueUnknown(position) ? '—' : `${formatAmount(position.value)} ${position.quote}`}</dd></div>
    <div><dt>{t('Entry price')}</dt><dd>{position.entryPrice > 0 ? compactPrice(position.entryPrice) : '—'}</dd></div>
    <div><dt>{t('Mark price')}</dt><dd>{markUnknown(position) ? '—' : compactPrice(position.markPrice)}</dd></div>
    <div><dt>{t('Unrealized PnL')}</dt><dd className={pnlUnknown(position) ? '' : position.unrealizedPnl >= 0 ? 'positive' : 'negative'}>{pnlUnknown(position) ? '—' : pnlText(position.unrealizedPnl, position.quote)}</dd></div>
    <div><dt>{t('Realized PnL')}</dt><dd>{realizedAmount(position.realizedPnl, position.quote)}</dd></div>
    <div><dt>{t('Funding fee')}</dt><dd className={amountTone(position.fundingFee)}>{optionalAmount(position.fundingFee, position.quote)}</dd></div>
  </dl>;
}

function SinglePositionCard({ position, onClose }: { position: PositionTableRow; onClose: (rows: PositionTableRow[]) => void }) {
  const { t } = useLanguage();
  const long = position.quantity >= 0;
  return <article className="position-mobile-card positions-mobile-card">
    <header className="position-mobile-head">
      <strong className="position-mobile-symbol">{position.asset}/{position.quote} PERP</strong>
      <small className={`${long ? 'long-tag' : 'short-tag'} position-mobile-side`}>{t(long ? 'Long' : 'Short')}</small>
    </header>
    <PositionDetails position={position} />
    <footer className="position-mobile-foot positions-mobile-foot-actions">
      <button className="row-action close-position-action" onClick={() => onClose([position])}>{t('Close position')}</button>
    </footer>
  </article>;
}

function PositionLegCard({ position, onClose }: { position: PositionTableRow; onClose: (rows: PositionTableRow[]) => void }) {
  const { t } = useLanguage();
  const long = position.quantity >= 0;
  return <article className="position-mobile-leg">
    <header>
      <strong>{position.asset}/{position.quote} PERP</strong>
      <small className={long ? 'long-tag' : 'short-tag'}>{t(long ? 'Long' : 'Short')}</small>
    </header>
    <PositionDetails position={position} />
    <footer className="position-mobile-foot positions-mobile-foot-actions">
      <button className="row-action close-position-action" onClick={() => onClose([position])}>{t('Close position')}</button>
    </footer>
  </article>;
}

function AggregatePositionCard({ group, onClose }: { group: PositionTableGroup; onClose: (rows: PositionTableRow[]) => void }) {
  const { t } = useLanguage();
  const aggregateQuote = group.legs.every((position) => position.quote === group.legs[0].quote) ? group.legs[0].quote : 'USDT';
  const realizedValues = group.legs.map((position) => position.realizedPnl).filter((value): value is number => value !== null);
  const fundingValues = group.legs.map((position) => position.fundingFee).filter((value): value is number => value !== null);
  const realizedPnl = realizedValues.length > 0 ? realizedValues.reduce((sum, value) => sum + value, 0) : null;
  const fundingFee = fundingValues.length > 0 ? fundingValues.reduce((sum, value) => sum + value, 0) : null;
  // Same rule as the aggregate table row: a group total is only as good as its worst leg.
  const groupValueKnown = group.legs.every((leg) => !valueUnknown(leg));
  const groupPriceKnown = group.legs.every((leg) => !markUnknown(leg));
  const groupPnlKnown = group.legs.every((leg) => !pnlUnknown(leg));
  const side = group.fullyHedged ? 'Hedged' : group.quantity >= 0 ? 'Long' : 'Short';
  const [legsOpen, setLegsOpen] = useState(false);
  return <article className="position-mobile-card positions-mobile-card">
    <header className="position-mobile-head">
      <strong className="position-mobile-symbol">{group.mixedAssets ? group.label : `${group.label}/${aggregateQuote}`} PERP</strong>
      <small className={`${group.fullyHedged ? 'hedged-tag' : group.quantity >= 0 ? 'long-tag' : 'short-tag'} position-mobile-side`}>{t(side)}</small>
    </header>
    <dl className="position-mobile-grid">
      <div><dt>{t('Exchange')}</dt><dd>{group.venueCount} {t(group.venueCount === 1 ? 'exchange' : 'exchanges')}</dd></div>
      <div><dt>{t('Size')}</dt><dd>{group.mixedAssets ? '—' : `${group.quantity.toFixed(4)} ${group.asset}`}</dd></div>
      <div><dt>{t('Position notional')}</dt><dd>{group.mixedAssets || !groupValueKnown ? '—' : `$${formatAmount(group.grossNotional)}`}</dd></div>
      <div><dt>{t('Entry price')}</dt><dd>{group.mixedAssets || !groupPriceKnown ? '—' : compactPrice(group.weightedEntryPrice)}</dd></div>
      <div><dt>{t('Mark price')}</dt><dd>{group.mixedAssets || !groupPriceKnown ? '—' : compactPrice(group.weightedMarkPrice)}</dd></div>
      <div><dt>{t('Unrealized PnL')}</dt><dd className={groupPnlKnown && group.unrealizedPnl >= 0 ? 'positive' : groupPnlKnown ? 'negative' : ''}>{groupPnlKnown ? pnlText(group.unrealizedPnl, aggregateQuote) : '—'}</dd></div>
      <div><dt>{t('Realized PnL')}</dt><dd>{realizedAmount(realizedPnl, aggregateQuote)}</dd></div>
      <div><dt>{t('Funding fee')}</dt><dd className={amountTone(fundingFee)}>{optionalAmount(fundingFee, aggregateQuote)}</dd></div>
    </dl>
    {legsOpen && <div className="positions-mobile-legs">
      {group.legs.map((position) => <PositionLegCard key={position.id} position={position} onClose={onClose} />)}
    </div>}
    <footer className="position-mobile-foot positions-mobile-foot-actions">
      <button className="position-mobile-toggle" aria-expanded={legsOpen} onClick={() => setLegsOpen((value) => !value)}>
        {legsOpen ? t('Collapse legs') : `${t('Expand legs')} (${group.legs.length})`}
      </button>
      <button className="row-action close-position-action" onClick={() => onClose(group.legs)}>{t('Close all')}</button>
    </footer>
  </article>;
}

/**
 * Phone view of the position table: one card per leg, or one aggregate card that always shows
 * both hedged legs inline with their full assets and venues. Every close button calls the same
 * `onClose` callback as its desktop row, so the close dialog wiring is unchanged.
 */
export function PositionsMobileCards({ groups, onClose }: { groups: readonly PositionTableGroup[]; onClose: (rows: PositionTableRow[]) => void }) {
  return <div className="positions-mobile-cards">{groups.map((group) => group.legs.length === 1
    ? <SinglePositionCard key={group.key} position={group.legs[0]} onClose={onClose} />
    : <AggregatePositionCard key={group.key} group={group} onClose={onClose} />)}</div>;
}

/** The canonical position table shared by Trade, Strategies, and Portfolio. */
export function PositionsTable({ rows, onClose }: PositionsTableProps) {
  const { t } = useLanguage();
  const phone = usePhoneLayout();
  const [page, setPage] = useState(1);
  const [expandedPosition, setExpandedPosition] = useState<string | null>(null);
  const groups = useMemo(() => groupPositionRows(rows), [rows]);
  const window = executionPageWindow(groups.length, page);

  useEffect(() => {
    setPage((current) => executionPageWindow(groups.length, current).page);
  }, [groups.length]);

  // At or below 640px the 1280px-wide grid can only be swiped sideways, so it is not rendered at
  // all: phone users get cards with every column visible, desktop keeps the identical table.
  if (phone) {
    return <>
      <PositionsMobileCards groups={groups.slice(window.start, window.end)} onClose={onClose} />
      <ExecutionPagination itemCount={groups.length} page={window.page} onPageChange={setPage} />
    </>;
  }

  return <>
    <div className="positions-table table-wrap"><table>
      <thead><tr><th>{t('Contract')}</th><th>{t('Exchange')}</th><th>{t('Size')}</th><th>{t('Position notional')}</th><th>{t('Entry price')}</th><th>{t('Mark price')}</th><th>{t('ADL indicator')}</th><th>{t('Unrealized PnL')}</th><th>{t('Realized PnL')}</th><th>{t('Funding fee')}</th><th>{t('Close position')}</th></tr></thead>
      <tbody>{groups.slice(window.start, window.end).map((group) => {
        if (group.legs.length === 1) {
          const position = group.legs[0];
          const ranks = [{ key: position.id, venue: position.venue, crossExRank: position.crossExAdlRank, exchangeRank: position.exchangeAdlRank }];
          return <tr key={group.key}>
            <td><strong>{position.asset}/{position.quote}</strong><small className={position.quantity >= 0 ? 'long-tag' : 'short-tag'}>{t(position.quantity >= 0 ? 'Long' : 'Short')}</small></td>
            <td><VenueFromCode code={position.venue} /></td>
            <td>{position.quantity.toFixed(4)} {position.asset}</td>
            <td>{valueUnknown(position) ? '—' : `${formatAmount(position.value)} ${position.quote}`}</td>
            <td>{position.entryPrice > 0 ? compactPrice(position.entryPrice) : '—'}</td>
            <td>{markUnknown(position) ? '—' : compactPrice(position.markPrice)}</td>
            <td><AdlIndicators ranks={ranks} /></td>
            <td className={pnlUnknown(position) ? '' : position.unrealizedPnl >= 0 ? 'positive' : 'negative'}>{pnlUnknown(position) ? '—' : pnlText(position.unrealizedPnl, position.quote)}</td>
            <td>{realizedAmount(position.realizedPnl, position.quote)}</td>
            <td className={amountTone(position.fundingFee)}>{optionalAmount(position.fundingFee, position.quote)}</td>
            <td><button className="row-action close-position-action" onClick={() => onClose([position])}>{t('Close position')}</button></td>
          </tr>;
        }

        const expanded = expandedPosition === group.key;
        const aggregateQuote = group.legs.every((position) => position.quote === group.legs[0].quote) ? group.legs[0].quote : 'USDT';
        const realizedValues = group.legs.map((position) => position.realizedPnl).filter((value): value is number => value !== null);
        const fundingValues = group.legs.map((position) => position.fundingFee).filter((value): value is number => value !== null);
        const realizedPnl = realizedValues.length > 0 ? realizedValues.reduce((sum, value) => sum + value, 0) : null;
        const fundingFee = fundingValues.length > 0 ? fundingValues.reduce((sum, value) => sum + value, 0) : null;
        // A group total is only as good as its worst leg: one unpriced leg would otherwise fold a
        // fabricated 0 into the sum, so the aggregate cells print `—` whenever any leg is unknown.
        const groupValueKnown = group.legs.every((leg) => !valueUnknown(leg));
        const groupPriceKnown = group.legs.every((leg) => !markUnknown(leg));
        const groupPnlKnown = group.legs.every((leg) => !pnlUnknown(leg));
        return <Fragment key={group.key}>
          <tr className="aggregate-row">
            <td><button type="button" className={expanded ? 'expand-position expanded' : 'expand-position'} aria-expanded={expanded} aria-label={`${t('Positions')} · ${group.label}`} onClick={() => setExpandedPosition(expanded ? null : group.key)}>›</button><strong>{group.mixedAssets ? group.label : `${group.label}/${aggregateQuote}`} PERP</strong><small className={group.fullyHedged ? 'hedged-tag' : group.quantity >= 0 ? 'long-tag' : 'short-tag'}>{t(group.fullyHedged ? 'Hedged' : group.quantity >= 0 ? 'Long' : 'Short')}</small></td>
            <td><span className="venue-group"><strong>{group.venueCount} {t(group.venueCount === 1 ? 'exchange' : 'exchanges')}</strong></span></td>
            <td>{group.mixedAssets ? '—' : `${group.quantity.toFixed(4)} ${group.asset}`}</td>
            <td>{group.mixedAssets || !groupValueKnown ? '—' : `$${formatAmount(group.grossNotional)}`}</td>
            <td>{group.mixedAssets || !groupPriceKnown ? '—' : compactPrice(group.weightedEntryPrice)}</td>
            <td>{group.mixedAssets || !groupPriceKnown ? '—' : compactPrice(group.weightedMarkPrice)}</td>
            <td>—</td>
            <td className={groupPnlKnown && group.unrealizedPnl >= 0 ? 'positive' : groupPnlKnown ? 'negative' : ''}>{groupPnlKnown ? pnlText(group.unrealizedPnl, aggregateQuote) : '—'}</td>
            <td>{realizedAmount(realizedPnl, aggregateQuote)}</td>
            <td className={amountTone(fundingFee)}>{optionalAmount(fundingFee, aggregateQuote)}</td>
            <td><button className="row-action close-position-action" onClick={() => onClose(group.legs)}>{t('Close all')}</button></td>
          </tr>
          {expanded && group.legs.map((position) => <tr className="position-leg" key={position.id}>
            <td><span className="leg-branch">↳</span><strong>{position.asset}/{position.quote}</strong><small>{t('Venue leg')}</small></td>
            <td><VenueFromCode code={position.venue} /></td>
            <td>{position.quantity.toFixed(4)} {position.asset}</td>
            <td>{valueUnknown(position) ? '—' : `${formatAmount(position.value)} ${position.quote}`}</td>
            <td>{position.entryPrice > 0 ? compactPrice(position.entryPrice) : '—'}</td>
            <td>{markUnknown(position) ? '—' : compactPrice(position.markPrice)}</td>
            <td><AdlIndicators ranks={[{ key: position.id, venue: position.venue, crossExRank: position.crossExAdlRank, exchangeRank: position.exchangeAdlRank }]} /></td>
            <td className={pnlUnknown(position) ? '' : position.unrealizedPnl >= 0 ? 'positive' : 'negative'}>{pnlUnknown(position) ? '—' : pnlText(position.unrealizedPnl, position.quote)}</td>
            <td>{realizedAmount(position.realizedPnl, position.quote)}</td>
            <td className={amountTone(position.fundingFee)}>{optionalAmount(position.fundingFee, position.quote)}</td>
            <td><button className="row-action close-position-action" onClick={() => onClose([position])}>{t('Close position')}</button></td>
          </tr>)}
        </Fragment>;
      })}</tbody>
    </table></div>
    <ExecutionPagination itemCount={groups.length} page={window.page} onPageChange={setPage} />
  </>;
}
