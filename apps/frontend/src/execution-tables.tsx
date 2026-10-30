/* Execution tables for the trade page's bottom panel: business-aware order/fill grids plus the
 * spot-holdings balance table. Moved verbatim from trade-route.tsx, with the per-product column
 * header and the row-level cancellable hook added on top (perpetual default stays unchanged).
 * v0.4.1 (R6/R7): `unified` mode renders contract and spot rows in one table with a per-row
 * market-type tag, and `UnifiedPositionsTable` merges contract positions with spot holdings. */
import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import type { ExecutionFill, ExecutionOrder } from './api.js';
import { formatExecutionDateTime } from './execution-date-time.js';
import { executionPageWindow } from './execution-pagination.js';
import { ExecutionPagination } from './execution-pagination-control.js';
import { useLanguage } from './i18n.js';
import { marketSymbol, type MarketProduct } from './market-symbol.js';
import { orderDisplayPrice } from './order-display-price.js';
import { exchanges, formatAmount, formatUsd, VenueCell, symbolParts } from './route-shared.js';
import { marketTypeOfSymbol, type SpotHoldingsRow } from './execution-split.js';
import type { PositionTableRow } from './strategy-positions.js';

export function VenueFromCode({ code }: { code: string }) {
  const exchange = exchanges.find((item) => item.id === code.toLowerCase());
  return <VenueCell id={code.toLowerCase()} name={exchange?.name ?? code} short={exchange?.short ?? code.slice(0, 2)} />;
}

export function EmptyTable({ label }: { label: string }) {
  const { t } = useLanguage();
  return <div className="empty-state"><span>◎</span><strong>{t(`No ${label.toLowerCase()}`)}</strong><p>{t('The backend will add rows here as executions occur.')}</p></div>;
}

/**
 * Phone layout switch: true at or below `maxWidth`, false while rendering statically.
 *
 * The wide execution grids cannot reflow into a phone width (their columns are fixed by the
 * 1120–1280px table floors), so below the breakpoint the tables are not rendered at all and the
 * card views take their place. Rendering nothing instead of a CSS-hidden duplicate keeps the
 * desktop markup byte-for-byte unchanged and leaves no horizontally scrollable element behind.
 */
export function usePhoneLayout(maxWidth = 640): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const subscribe = useCallback((onStoreChange: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
    const media = window.matchMedia(query);
    media.addEventListener('change', onStoreChange);
    return () => media.removeEventListener('change', onStoreChange);
  }, [query]);
  const getSnapshot = () => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Contract name as a phone card reads it: the full pair plus the product, never the concatenated id. */
function cardMarketLabel(part: { asset: string; quote: string }, product: MarketProduct): string {
  return product === 'spot' ? `${part.asset}/${part.quote}` : `${part.asset}/${part.quote} PERP`;
}

export interface OrderTableProps {
  orders: ExecutionOrder[];
  page: number;
  onPageChange: (page: number) => void;
  /** Column switch: renders the cancel header/cells only when true (unchanged behaviour). */
  cancellable?: boolean;
  /** Row-level verdict; rows returning false render no button. Absent → every row cancellable. */
  cancellableFor?: (order: ExecutionOrder) => boolean;
  onCancel: (order: ExecutionOrder) => Promise<void>;
  busyOrderIds: string[];
  /** Spot tabs render the pair (BTC/USDT) and the Market header; perpetual keeps BTCUSDT PERP. */
  product?: MarketProduct;
  /**
   * R6/R7 unified mode: every row's market type comes from its own symbol, the header reads
   * Market, and each row carries a perp/spot tag. Overrides `product` per row.
   */
  unified?: boolean;
}

/** Per-row market product in unified mode; the static `product` prop otherwise. */
function rowProduct(order: ExecutionOrder, unified: boolean, product: MarketProduct): MarketProduct {
  return unified ? (marketTypeOfSymbol(order.symbol) === 'spot' ? 'spot' : 'perpetual') : product;
}

export interface OrderCardsProps {
  /** Already paginated: the caller slices `executionPageWindow`, exactly like the table body. */
  orders: ExecutionOrder[];
  cancellable?: boolean;
  cancellableFor?: (order: ExecutionOrder) => boolean;
  onCancel: (order: ExecutionOrder) => Promise<void>;
  busyOrderIds: string[];
  product?: MarketProduct;
  unified?: boolean;
}

/** Phone order cards: one card per order with every table cell spelled out as a label/value pair. */
export function OrderCards({ orders, cancellable = false, cancellableFor, onCancel, busyOrderIds, product = 'perpetual', unified = false }: OrderCardsProps) {
  const { language, t } = useLanguage();
  return <div className="execution-mobile-cards">{orders.map((order) => {
    const part = symbolParts(order.symbol);
    const rowProductKind = rowProduct(order, unified, product);
    const busy = busyOrderIds.includes(order.id);
    const showCancel = cancellable && (cancellableFor?.(order) ?? true);
    const orderId = order.remoteOrderId ?? order.clientOrderId;
    return <article className="position-mobile-card execution-mobile-card" key={order.id}>
      <header className="position-mobile-head">
        <span className={`market-type-tag ${rowProductKind === 'spot' ? 'spot' : 'perp'}`}>{t(rowProductKind === 'spot' ? 'Spot' : 'Perp')}</span>
        <strong className="position-mobile-symbol">{cardMarketLabel(part, rowProductKind)}</strong>
        {order.strategyId && <small className="long-tag">{order.strategyId}</small>}
        <small className={`${order.side === 'BUY' ? 'long-tag' : 'short-tag'} position-mobile-side`}>{t(order.side === 'BUY' ? 'Buy' : 'Sell')}</small>
      </header>
      <dl className="position-mobile-grid">
        <div><dt>{t('Time')}</dt><dd>{formatExecutionDateTime(order.createdAt, language)}</dd></div>
        <div><dt>{t('Exchange')}</dt><dd><VenueFromCode code={part.venue} /></dd></div>
        <div><dt>{t('Type')}</dt><dd>{t(order.type === 'LIMIT' ? 'Limit' : 'Market')}</dd></div>
        <div><dt>{t('Price')}</dt><dd>{orderDisplayPrice(order, t('Market'))}</dd></div>
        <div><dt>{t('Amount')}</dt><dd>{order.quantity} {part.asset}</dd></div>
        <div><dt>{t('Filled')}</dt><dd>{order.executedQuantity}</dd></div>
        <div><dt>{t('Status')}</dt><dd><span className={`status-tag ${order.state.toLowerCase()}`}>{order.state}</span></dd></div>
        <div className="execution-card-wide"><dt>{t('Order ID')}</dt><dd className="order-id-cell" title={orderId}>{orderId}</dd></div>
      </dl>
      {showCancel && <footer className="position-mobile-foot execution-card-actions">
        <button className="row-action" onClick={() => void onCancel(order)} disabled={busy}>{busy ? t('Cancelling…') : t('Cancel')}</button>
      </footer>}
    </article>;
  })}</div>;
}

export function OrderTable({ orders, page, onPageChange, cancellable = false, cancellableFor, onCancel, busyOrderIds, product = 'perpetual', unified = false }: OrderTableProps) {
  const { language, t } = useLanguage();
  const window = executionPageWindow(orders.length, page);
  const headerMarket = unified || product === 'spot' ? t('Market') : t('Contract');
  const phone = usePhoneLayout();
  if (phone) {
    return <><OrderCards orders={orders.slice(window.start, window.end)} cancellable={cancellable} cancellableFor={cancellableFor} onCancel={onCancel} busyOrderIds={busyOrderIds} product={product} unified={unified} /><ExecutionPagination itemCount={orders.length} page={window.page} onPageChange={onPageChange} /></>;
  }
  return <><div className="positions-table orders-table table-wrap"><table><thead><tr><th>{t('Time')}</th><th>{headerMarket}</th><th>{t('Exchange')}</th><th>{t('Side / Type')}</th><th>{t('Price')}</th><th>{t('Amount')}</th><th>{t('Filled')}</th><th>{t('Status')}</th><th>{t('Order ID')}</th>{cancellable && <th />}</tr></thead><tbody>{orders.slice(window.start, window.end).map((order) => { const part = symbolParts(order.symbol); const rowProductKind = rowProduct(order, unified, product); const busy = busyOrderIds.includes(order.id); const showCancel = cancellable && (cancellableFor?.(order) ?? true); const orderId = order.remoteOrderId ?? order.clientOrderId; return <tr key={order.id}><td>{formatExecutionDateTime(order.createdAt, language)}</td><td><span className={`market-type-tag ${rowProductKind === 'spot' ? 'spot' : 'perp'}`}>{t(rowProductKind === 'spot' ? 'Spot' : 'Perp')}</span><strong>{marketSymbol(part.asset, part.quote, rowProductKind)}</strong>{order.strategyId && <small className="long-tag">{order.strategyId}</small>}</td><td><VenueFromCode code={part.venue} /></td><td><small className={order.side === 'BUY' ? 'long-tag' : 'short-tag'}>{t(order.side === 'BUY' ? 'Buy' : 'Sell')} · {t(order.type === 'LIMIT' ? 'Limit' : 'Market')}</small></td><td>{orderDisplayPrice(order, t('Market'))}</td><td>{order.quantity} {part.asset}</td><td>{order.executedQuantity}</td><td><span className={`status-tag ${order.state.toLowerCase()}`}>{order.state}</span></td><td className="order-id-cell" title={orderId}>{orderId}</td>{showCancel && <td><button className="row-action" onClick={() => void onCancel(order)} disabled={busy}>{busy ? t('Cancelling…') : t('Cancel')}</button></td>}</tr>; })}</tbody></table></div><ExecutionPagination itemCount={orders.length} page={window.page} onPageChange={onPageChange} /></>;
}

export interface FillTableProps {
  fills: ExecutionFill[];
  page: number;
  onPageChange: (page: number) => void;
  /** Spot fills have no realized-PnL concept; the column stays for alignment and renders —. */
  product?: MarketProduct;
  /** R6/R7 unified mode: per-row market type from the fill's own symbol. */
  unified?: boolean;
}

export interface FillCardsProps {
  /** Already paginated by the caller. */
  fills: ExecutionFill[];
  product?: MarketProduct;
  unified?: boolean;
}

/** Phone fill cards: one card per fill, same fields as the desktop grid. */
export function FillCards({ fills, product = 'perpetual', unified = false }: FillCardsProps) {
  const { language, t } = useLanguage();
  return <div className="execution-mobile-cards">{fills.map((fill) => {
    const part = symbolParts(fill.symbol);
    const rowProductKind: MarketProduct = unified ? (marketTypeOfSymbol(fill.symbol) === 'spot' ? 'spot' : 'perpetual') : product;
    const long = fill.side === 'BUY';
    return <article className="position-mobile-card execution-mobile-card" key={fill.id}>
      <header className="position-mobile-head">
        <span className={`market-type-tag ${rowProductKind === 'spot' ? 'spot' : 'perp'}`}>{t(rowProductKind === 'spot' ? 'Spot' : 'Perp')}</span>
        <strong className="position-mobile-symbol">{cardMarketLabel(part, rowProductKind)}</strong>
        <small className={`${long ? 'long-tag' : 'short-tag'} position-mobile-side`}>{t(long ? 'Buy' : 'Sell')}</small>
      </header>
      <dl className="position-mobile-grid">
        <div><dt>{t('Time')}</dt><dd>{formatExecutionDateTime(fill.created_at, language)}</dd></div>
        <div><dt>{t('Exchange')}</dt><dd><VenueFromCode code={part.venue} /></dd></div>
        <div><dt>{t('Execution price')}</dt><dd>{fill.price}</dd></div>
        <div><dt>{t('Size')}</dt><dd>{fill.quantity} {part.asset}</dd></div>
        <div><dt>{t('Fee')}</dt><dd>{Number(fill.fee).toFixed(4)}</dd></div>
        <div><dt>{t('Realized PnL')}</dt><dd>{rowProductKind === 'spot' ? '—' : Number(fill.realized_pnl).toFixed(2)}</dd></div>
        <div className="execution-card-wide"><dt>{t('Trade ID')}</dt><dd className="order-id-cell" title={fill.id}>{fill.id.slice(0, 12)}</dd></div>
      </dl>
    </article>;
  })}</div>;
}

export function FillTable({ fills, page, onPageChange, product = 'perpetual', unified = false }: FillTableProps) {
  const { language, t } = useLanguage();
  const window = executionPageWindow(fills.length, page);
  const headerMarket = unified || product === 'spot' ? t('Market') : t('Contract');
  const phone = usePhoneLayout();
  if (phone) {
    return <><FillCards fills={fills.slice(window.start, window.end)} product={product} unified={unified} /><ExecutionPagination itemCount={fills.length} page={window.page} onPageChange={onPageChange} /></>;
  }
  return <><div className="positions-table fills-table table-wrap"><table><thead><tr><th>{t('Time')}</th><th>{headerMarket}</th><th>{t('Exchange')}</th><th>{t('Side')}</th><th>{t('Execution price')}</th><th>{t('Size')}</th><th>{t('Fee')}</th><th>{t('Realized PnL')}</th><th>{t('Trade ID')}</th></tr></thead><tbody>{fills.slice(window.start, window.end).map((fill) => { const part = symbolParts(fill.symbol); const rowProductKind: MarketProduct = unified ? (marketTypeOfSymbol(fill.symbol) === 'spot' ? 'spot' : 'perpetual') : product; return <tr key={fill.id}><td>{formatExecutionDateTime(fill.created_at, language)}</td><td><span className={`market-type-tag ${rowProductKind === 'spot' ? 'spot' : 'perp'}`}>{t(rowProductKind === 'spot' ? 'Spot' : 'Perp')}</span><strong>{marketSymbol(part.asset, part.quote, rowProductKind)}</strong></td><td><VenueFromCode code={part.venue} /></td><td><small className={fill.side === 'BUY' ? 'long-tag' : 'short-tag'}>{t(fill.side === 'BUY' ? 'Buy' : 'Sell')}</small></td><td>{fill.price}</td><td>{fill.quantity} {part.asset}</td><td>{Number(fill.fee).toFixed(4)}</td><td>{rowProductKind === 'spot' ? '—' : Number(fill.realized_pnl).toFixed(2)}</td><td>{fill.id.slice(0, 12)}</td></tr>; })}</tbody></table></div><ExecutionPagination itemCount={fills.length} page={window.page} onPageChange={onPageChange} /></>;
}

export interface SpotHoldingsTableProps {
  rows: SpotHoldingsRow[];
  page: number;
  onPageChange: (page: number) => void;
  /** One-click close wiring; omitted entirely when the caller has no close flow. */
  closeState?: {
    onRequest: (row: SpotHoldingsRow) => void;
    isClosable: (row: SpotHoldingsRow) => boolean;
    /** English i18n label naming why this row offers no close here; null/undefined = closable. */
    blockerFor?: (row: SpotHoldingsRow) => string | null;
    /** Opens the repayment explainer for a debt this exchange has no market to buy back. */
    onExplain?: (row: SpotHoldingsRow) => void;
  } | null;
}

// A debt this exchange cannot buy back still gets an action: the explainer names the routes that
// do clear it (close the venue's contracts, or transfer the coin in) instead of a dead button.
function spotCloseButton(row: SpotHoldingsRow, closeState: SpotHoldingsTableProps['closeState'], t: (key: string) => string): ReactNode {
  const short = row.total < 0;
  const label = short ? 'Buy back' : 'Close position';
  if (!closeState) return null;
  if (closeState.isClosable(row)) {
    return <button className="row-action close-position-action" onClick={() => closeState.onRequest(row)}>{t(label)}</button>;
  }
  const blocker = closeState.blockerFor?.(row) ?? 'No tradable spot market for this balance.';
  if (short && closeState.onExplain) {
    return <button className="row-action close-position-action explain-action" onClick={() => closeState.onExplain?.(row)} title={t(blocker)}>{t('How to repay')}</button>;
  }
  return <button className="row-action close-position-action" disabled title={t(blocker)}>{t(label)}</button>;
}

export interface SpotHoldingsCardsProps {
  /** Already paginated by the caller. */
  rows: SpotHoldingsRow[];
  closeState?: SpotHoldingsTableProps['closeState'];
}

/** Phone spot-holdings cards: balances with the same close / repay wiring as the table. */
export function SpotHoldingsCards({ rows, closeState = null }: SpotHoldingsCardsProps) {
  const { t } = useLanguage();
  return <div className="execution-mobile-cards">{rows.map((row) => {
    const short = row.total < 0;
    const action = spotCloseButton(row, closeState, t);
    return <article className="position-mobile-card execution-mobile-card" key={`${row.venue}:${row.coin}`}>
      <header className="position-mobile-head">
        <span className="market-type-tag spot">{t('Spot')}</span>
        <strong className="position-mobile-symbol">{row.coin}</strong>
        <small className={`${short ? 'short-tag' : 'long-tag'} position-mobile-side`}>{t(short ? 'Short' : 'Long')}</small>
      </header>
      <dl className="position-mobile-grid">
        <div><dt>{t('Market')}</dt><dd><VenueFromCode code={row.venue} /></dd></div>
        <div><dt>{t('Total')}</dt><dd>{formatAmount(row.total)}</dd></div>
        <div><dt>{t('Available')}</dt><dd>{formatAmount(row.available)}</dd></div>
        <div><dt>{t('Locked')}</dt><dd>{formatAmount(row.locked)}</dd></div>
        <div><dt>{t('Valuation (USDT)')}</dt><dd>{row.valuationUsd === null ? '—' : formatUsd(row.valuationUsd)}</dd></div>
      </dl>
      {action && <footer className="position-mobile-foot execution-card-actions">{action}</footer>}
    </article>;
  })}</div>;
}

export function SpotHoldingsTable({ rows, page, onPageChange, closeState = null }: SpotHoldingsTableProps) {
  const { t } = useLanguage();
  const window = executionPageWindow(rows.length, page);
  const phone = usePhoneLayout();
  if (phone) {
    return <><SpotHoldingsCards rows={rows.slice(window.start, window.end)} closeState={closeState} /><ExecutionPagination itemCount={rows.length} page={window.page} onPageChange={onPageChange} /></>;
  }
  const closeAction = (row: SpotHoldingsRow) => spotCloseButton(row, closeState, t);
  return <><div className="positions-table spot-holdings-table table-wrap"><table><thead><tr><th>{t('Market')}</th><th>{t('Coin')}</th><th>{t('Side')}</th><th>{t('Total')}</th><th>{t('Available')}</th><th>{t('Locked')}</th><th>{t('Valuation (USDT)')}</th>{closeState && <th>{t('Close position')}</th>}</tr></thead><tbody>{rows.slice(window.start, window.end).map((row) => { const short = row.total < 0; return <tr key={`${row.venue}:${row.coin}`}><td><VenueFromCode code={row.venue} /></td><td><strong title={row.coin}>{row.coin}</strong></td><td><small className={short ? 'short-tag' : 'long-tag'}>{t(short ? 'Short' : 'Long')}</small></td><td>{formatAmount(row.total)}</td><td>{formatAmount(row.available)}</td><td>{formatAmount(row.locked)}</td><td>{row.valuationUsd === null ? '—' : formatUsd(row.valuationUsd)}</td>{closeState && <td>{closeAction(row)}</td>}</tr>; })}</tbody></table></div><ExecutionPagination itemCount={rows.length} page={window.page} onPageChange={onPageChange} /></>;
}

/** One merged positions-list row (R6/R7): either a contract position or a spot holding. */
export type UnifiedPositionRow =
  | { marketType: 'perp'; perp: PositionTableRow }
  | { marketType: 'spot'; spot: SpotHoldingsRow };

/**
 * Merge contract positions and spot holdings into one list ordered by notional value,
 * descending (spot rows without a valuation trail last). The two sources never overlap —
 * a contract position always has a `_FUTURE_`/`_PERP_` symbol, a holding never does.
 */
export function mergePositionRows(
  perpRows: readonly PositionTableRow[],
  spotRows: readonly SpotHoldingsRow[],
): UnifiedPositionRow[] {
  const merged: Array<UnifiedPositionRow & { sortValue: number }> = [
    ...perpRows.map((perp): UnifiedPositionRow & { sortValue: number } => ({ marketType: 'perp', perp, sortValue: perp.value })),
    ...spotRows.map((spot): UnifiedPositionRow & { sortValue: number } => ({ marketType: 'spot', spot, sortValue: spot.valuationUsd ?? Number.NEGATIVE_INFINITY })),
  ];
  return merged.sort((left, right) => right.sortValue - left.sortValue)
    .map((row): UnifiedPositionRow => row.marketType === 'perp'
      ? { marketType: 'perp', perp: row.perp }
      : { marketType: 'spot', spot: row.spot });
}

export interface UnifiedPositionsTableProps {
  rows: UnifiedPositionRow[];
  page: number;
  onPageChange: (page: number) => void;
  /** Opens the contract close dialog for one position. */
  onClosePerp: (row: PositionTableRow) => void;
  /** Spot one-click close wiring, identical to the standalone holdings table's. */
  spotCloseState?: SpotHoldingsTableProps['closeState'];
}

/**
 * The merged positions list (R6/R7): contract positions and spot holdings share one table with
 * a market-type tag on every row and the union of both source tables' columns. Actions keep
 * their original wiring — contracts open the close dialog, holdings the spot close/repay flow.
 */
export function UnifiedPositionsTable({ rows, page, onPageChange, onClosePerp, spotCloseState }: UnifiedPositionsTableProps) {
  const { t } = useLanguage();
  const window = executionPageWindow(rows.length, page);
  const visibleRows = rows.slice(window.start, window.end);
  const perpRows = rows.filter((row): row is Extract<UnifiedPositionRow, { marketType: 'perp' }> => row.marketType === 'perp');
  const spotRows = rows.filter((row): row is Extract<UnifiedPositionRow, { marketType: 'spot' }> => row.marketType === 'spot');
  const grossValue = perpRows.reduce((sum, row) => sum + row.perp.value, 0)
    + spotRows.reduce((sum, row) => sum + (row.spot.valuationUsd ?? 0), 0);
  const unrealizedPnl = perpRows.reduce((sum, row) => sum + row.perp.unrealizedPnl, 0);
  const spotCloseAction = (row: SpotHoldingsRow) => {
    if (!spotCloseState) return null;
    const short = row.total < 0;
    const label = short ? 'Buy back' : 'Close position';
    // Bind the optional explainer once: narrowing a property of an optional prop does not
    // survive into the JSX closure.
    const explain = spotCloseState.onExplain;
    if (spotCloseState.isClosable(row)) {
      return <button className="row-action close-position-action" onClick={() => spotCloseState.onRequest(row)}>{t(label)}</button>;
    }
    const blocker = spotCloseState.blockerFor?.(row) ?? 'No tradable spot market for this balance.';
    if (short && explain) {
      return <button className="row-action close-position-action explain-action" onClick={() => explain(row)} title={t(blocker)}>{t('How to repay')}</button>;
    }
    return <button className="row-action close-position-action" disabled title={t(blocker)}>{t(label)}</button>;
  };
  const mobileCard = (row: UnifiedPositionRow) => {
    if (row.marketType === 'perp') {
      const perp = row.perp;
      const short = perp.side === 'Short';
      const symbol = `${perp.asset}/${perp.quote}`;
      return <article className="position-mobile-card" key={`m-perp:${perp.id}`}>
        <header className="position-mobile-head">
          <span className="market-type-tag perp">{t('Perp')}</span>
          <strong className="position-mobile-symbol" title={symbol}>{symbol}</strong>
          {perp.leverage && <small className="long-tag">{perp.leverage}×</small>}
          <small className={short ? 'short-tag position-mobile-side' : 'long-tag position-mobile-side'}>{t(short ? 'Short' : 'Long')}</small>
        </header>
        <dl className="position-mobile-grid">
          <div><dt>{t('Exchange')}</dt><dd><VenueFromCode code={perp.venue} /></dd></div>
          <div><dt>{t('Size')}</dt><dd>{formatAmount(Math.abs(perp.quantity))} {perp.asset}</dd></div>
          <div><dt>{t('Entry')}</dt><dd>{formatAmount(perp.entryPrice)}</dd></div>
          <div><dt>{t('Mark price')}</dt><dd>{perp.markPriceUnavailable ? '—' : formatAmount(perp.markPrice)}</dd></div>
          <div><dt>{t('Realized PnL')}</dt><dd>{perp.realizedPnl === null ? '—' : formatAmount(perp.realizedPnl)}</dd></div>
          <div><dt>{t('Funding fee')}</dt><dd className={perp.fundingFee !== null && perp.fundingFee > 0 ? 'positive' : perp.fundingFee !== null && perp.fundingFee < 0 ? 'negative' : ''}>{perp.fundingFee === null ? '—' : formatAmount(perp.fundingFee)}</dd></div>
          <div><dt>{t('PnL / Valuation')}</dt><dd className={perp.pnlUnavailable ? '' : perp.unrealizedPnl >= 0 ? 'positive' : 'negative'}>{perp.pnlUnavailable ? '—' : `${perp.unrealizedPnl >= 0 ? '+' : ''}${formatAmount(perp.unrealizedPnl)}`}</dd></div>
        </dl>
        <footer className="position-mobile-foot">
          <span>{t('Value')} <strong>{formatUsd(perp.value)}</strong></span>
          <button className="row-action close-position-action" onClick={() => onClosePerp(perp)}>{t('Close position')}</button>
        </footer>
      </article>;
    }
    const spot = row.spot;
    const short = spot.total < 0;
    return <article className="position-mobile-card" key={`m-spot:${spot.venue}:${spot.coin}`}>
      <header className="position-mobile-head">
        <span className="market-type-tag spot">{t('Spot')}</span>
        <strong className="position-mobile-symbol" title={spot.coin}>{spot.coin}</strong>
        <small className={short ? 'short-tag position-mobile-side' : 'long-tag position-mobile-side'}>{t(short ? 'Short' : 'Long')}</small>
      </header>
      <dl className="position-mobile-grid">
        <div><dt>{t('Exchange')}</dt><dd><VenueFromCode code={spot.venue} /></dd></div>
        <div><dt>{t('Size')}</dt><dd>{formatAmount(spot.total)} {spot.coin}</dd></div>
        <div><dt>{t('Available')}</dt><dd>{formatAmount(spot.available)}</dd></div>
        <div><dt>{t('PnL / Valuation')}</dt><dd>{spot.valuationUsd === null ? '—' : formatUsd(spot.valuationUsd)}</dd></div>
      </dl>
      <footer className="position-mobile-foot">
        <span>{spot.locked > 0 ? `${t('Locked')} ${formatAmount(spot.locked)}` : '—'}</span>
        {spotCloseAction(spot)}
      </footer>
    </article>;
  };
  return <><div className="positions-summary">
    <div><span>{t('Position notional')}</span><strong>{formatUsd(grossValue)}</strong></div>
    <div><span>{t('Unrealized PnL')}</span><strong className={unrealizedPnl >= 0 ? 'positive' : 'negative'}>{unrealizedPnl >= 0 ? '+' : ''}{formatAmount(unrealizedPnl)}</strong></div>
    <div><span>{t('Positions')}</span><strong>{perpRows.length} {t('Perp')} · {spotRows.length} {t('Spot')}</strong></div>
  </div><div className="positions-table unified-positions-table table-wrap"><table><thead><tr>
    <th>{t('Type')}</th><th>{t('Market')}</th><th>{t('Exchange')}</th><th>{t('Side')}</th><th>{t('Size')}</th><th>{t('Entry / Available')}</th><th>{t('Value')}</th><th>{t('PnL / Valuation')}</th><th>{t('Action')}</th>
  </tr></thead><tbody>{visibleRows.map((row) => {
    if (row.marketType === 'perp') {
      const perp = row.perp;
      const short = perp.side === 'Short';
      return <tr key={`perp:${perp.id}`}>
        <td><span className="market-type-tag perp">{t('Perp')}</span></td>
        <td><strong title={marketSymbol(perp.asset, perp.quote, 'perpetual')}>{perp.asset}/{perp.quote}</strong>{perp.leverage && <small className="long-tag">{perp.leverage}×</small>}</td>
        <td><VenueFromCode code={perp.venue} /></td>
        <td><small className={short ? 'short-tag' : 'long-tag'}>{t(short ? 'Short' : 'Long')}</small></td>
        <td>{formatAmount(Math.abs(perp.quantity))} {perp.asset}</td>
        <td>{formatAmount(perp.entryPrice)}</td>
        <td>{formatUsd(perp.value)}</td>
        <td><span className={perp.unrealizedPnl >= 0 ? 'positive' : 'negative'}>{perp.unrealizedPnl >= 0 ? '+' : ''}{formatAmount(perp.unrealizedPnl)}</span></td>
        <td><button className="row-action close-position-action" onClick={() => onClosePerp(perp)}>{t('Close position')}</button></td>
      </tr>;
    }
    const spot = row.spot;
    const short = spot.total < 0;
    return <tr key={`spot:${spot.venue}:${spot.coin}`}>
      <td><span className="market-type-tag spot">{t('Spot')}</span></td>
      <td><strong title={spot.coin}>{spot.coin}</strong></td>
      <td><VenueFromCode code={spot.venue} /></td>
      <td><small className={short ? 'short-tag' : 'long-tag'}>{t(short ? 'Short' : 'Long')}</small></td>
      <td>{formatAmount(spot.total)} {spot.coin}</td>
      <td>{formatAmount(spot.available)}</td>
      <td>{spot.valuationUsd === null ? '—' : formatUsd(spot.valuationUsd)}</td>
      <td>{spot.locked > 0 ? <small>{t('Locked')} {formatAmount(spot.locked)}</small> : '—'}</td>
      <td>{spotCloseAction(spot)}</td>
    </tr>;
  })}</tbody></table></div><div className="unified-positions-cards">{visibleRows.map(mobileCard)}</div><ExecutionPagination itemCount={rows.length} page={window.page} onPageChange={onPageChange} /></>;
}
