/* Execution tables for the trade page's bottom panel: business-aware order/fill grids plus the
 * spot-holdings balance table. Moved verbatim from trade-route.tsx, with the per-product column
 * header and the row-level cancellable hook added on top (perpetual default stays unchanged). */
import type { ExecutionFill, ExecutionOrder } from './api.js';
import { formatExecutionDateTime } from './execution-date-time.js';
import { executionPageWindow } from './execution-pagination.js';
import { ExecutionPagination } from './execution-pagination-control.js';
import { useLanguage } from './i18n.js';
import { marketSymbol, type MarketProduct } from './market-symbol.js';
import { orderDisplayPrice } from './order-display-price.js';
import { assetIcon, exchanges, formatAmount, formatUsd, VenueCell, symbolParts } from './route-shared.js';
import type { SpotHoldingsRow } from './execution-split.js';

export function VenueFromCode({ code }: { code: string }) {
  const exchange = exchanges.find((item) => item.id === code.toLowerCase());
  return <VenueCell id={code.toLowerCase()} name={exchange?.name ?? code} short={exchange?.short ?? code.slice(0, 2)} />;
}

export function EmptyTable({ label }: { label: string }) {
  const { t } = useLanguage();
  return <div className="empty-state"><span>◎</span><strong>{t(`No ${label.toLowerCase()}`)}</strong><p>{t('The backend will add rows here as executions occur.')}</p></div>;
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
}

export function OrderTable({ orders, page, onPageChange, cancellable = false, cancellableFor, onCancel, busyOrderIds, product = 'perpetual' }: OrderTableProps) {
  const { language, t } = useLanguage();
  const window = executionPageWindow(orders.length, page);
  return <><div className="positions-table table-wrap"><table><thead><tr><th>{t('Time')}</th><th>{t(product === 'spot' ? 'Market' : 'Contract')}</th><th>{t('Exchange')}</th><th>{t('Side / Type')}</th><th>{t('Price')}</th><th>{t('Amount')}</th><th>{t('Filled')}</th><th>{t('Status')}</th><th>{t('Order ID')}</th>{cancellable && <th />}</tr></thead><tbody>{orders.slice(window.start, window.end).map((order) => { const part = symbolParts(order.symbol); const busy = busyOrderIds.includes(order.id); const showCancel = cancellable && (cancellableFor?.(order) ?? true); return <tr key={order.id}><td>{formatExecutionDateTime(order.createdAt, language)}</td><td><strong>{marketSymbol(part.asset, part.quote, product)}</strong>{order.strategyId && <small className="long-tag">{order.strategyId}</small>}</td><td><VenueFromCode code={part.venue} /></td><td><small className={order.side === 'BUY' ? 'long-tag' : 'short-tag'}>{t(order.side === 'BUY' ? 'Buy' : 'Sell')} · {t(order.type === 'LIMIT' ? 'Limit' : 'Market')}</small></td><td>{orderDisplayPrice(order, t('Market'))}</td><td>{order.quantity} {part.asset}</td><td>{order.executedQuantity}</td><td><span className={`status-tag ${order.state.toLowerCase()}`}>{order.state}</span></td><td>{order.remoteOrderId ?? order.clientOrderId}</td>{showCancel && <td><button className="row-action" onClick={() => void onCancel(order)} disabled={busy}>{busy ? t('Cancelling…') : t('Cancel')}</button></td>}</tr>; })}</tbody></table></div><ExecutionPagination itemCount={orders.length} page={window.page} onPageChange={onPageChange} /></>;
}

export interface FillTableProps {
  fills: ExecutionFill[];
  page: number;
  onPageChange: (page: number) => void;
  /** Spot fills have no realized-PnL concept; the column stays for alignment and renders —. */
  product?: MarketProduct;
}

export function FillTable({ fills, page, onPageChange, product = 'perpetual' }: FillTableProps) {
  const { language, t } = useLanguage();
  const window = executionPageWindow(fills.length, page);
  return <><div className="positions-table table-wrap"><table><thead><tr><th>{t('Time')}</th><th>{t(product === 'spot' ? 'Market' : 'Contract')}</th><th>{t('Exchange')}</th><th>{t('Side')}</th><th>{t('Execution price')}</th><th>{t('Size')}</th><th>{t('Fee')}</th><th>{t('Realized PnL')}</th><th>{t('Trade ID')}</th></tr></thead><tbody>{fills.slice(window.start, window.end).map((fill) => { const part = symbolParts(fill.symbol); return <tr key={fill.id}><td>{formatExecutionDateTime(fill.created_at, language)}</td><td><strong>{marketSymbol(part.asset, part.quote, product)}</strong></td><td><VenueFromCode code={part.venue} /></td><td><small className={fill.side === 'BUY' ? 'long-tag' : 'short-tag'}>{t(fill.side === 'BUY' ? 'Buy' : 'Sell')}</small></td><td>{fill.price}</td><td>{fill.quantity} {part.asset}</td><td>{Number(fill.fee).toFixed(4)}</td><td>{product === 'spot' ? '—' : Number(fill.realized_pnl).toFixed(2)}</td><td>{fill.id.slice(0, 12)}</td></tr>; })}</tbody></table></div><ExecutionPagination itemCount={fills.length} page={window.page} onPageChange={onPageChange} /></>;
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

export function SpotHoldingsTable({ rows, page, onPageChange, closeState = null }: SpotHoldingsTableProps) {
  const { t } = useLanguage();
  const window = executionPageWindow(rows.length, page);
  // A debt this exchange cannot buy back still gets an action: the explainer names the routes that
  // do clear it (close the venue's contracts, or transfer the coin in) instead of a dead button.
  const closeAction = (row: SpotHoldingsRow) => {
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
  };
  return <><div className="positions-table table-wrap"><table><thead><tr><th>{t('Market')}</th><th>{t('Coin')}</th><th>{t('Side')}</th><th>{t('Total')}</th><th>{t('Available')}</th><th>{t('Locked')}</th><th>{t('Valuation (USDT)')}</th>{closeState && <th>{t('Close position')}</th>}</tr></thead><tbody>{rows.slice(window.start, window.end).map((row) => { const short = row.total < 0; return <tr key={`${row.venue}:${row.coin}`}><td><VenueFromCode code={row.venue} /></td><td><strong>{assetIcon(row.coin)} {row.coin}</strong></td><td><small className={short ? 'short-tag' : 'long-tag'}>{t(short ? 'Short' : 'Long')}</small></td><td>{formatAmount(row.total)}</td><td>{formatAmount(row.available)}</td><td>{formatAmount(row.locked)}</td><td>{row.valuationUsd === null ? '—' : formatUsd(row.valuationUsd)}</td>{closeState && <td>{closeAction(row)}</td>}</tr>; })}</tbody></table></div><ExecutionPagination itemCount={rows.length} page={window.page} onPageChange={onPageChange} /></>;
}
