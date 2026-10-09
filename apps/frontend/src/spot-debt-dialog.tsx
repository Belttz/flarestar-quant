import type { SpotHoldingsRow } from './execution-split.js';
import { useLanguage } from './i18n.js';
import { formatAmount, formatUsd, symbolParts, useDialogFocus } from './route-shared.js';
import { spotCloseVenue } from './spot-close.js';

/** One open contract on the same exchange, as the trade page's positions table lists it. */
export interface SpotDebtContract {
  symbol: string;
  quantity: string;
}

interface SpotDebtDialogProps {
  row: SpotHoldingsRow;
  contracts: SpotDebtContract[];
  onDismiss: () => void;
}

/**
 * «How do I repay this?» explainer for a spot debt whose exchange lists no market to buy it back on.
 * CrossEx auto-borrows the settlement coin to margin positions on exchanges that run no spot
 * business at all (HYPERLIQUID settles in USDC), so the liability is real, must stay visible, and
 * has no spot order that can close it. Rather than leave a dead button, the dialog names the two
 * routes that actually clear it.
 */
export function SpotDebtDialog({ row, contracts, onDismiss }: SpotDebtDialogProps) {
  const { t } = useLanguage();
  const dialogRef = useDialogFocus(true, onDismiss);
  const venue = spotCloseVenue(row.venue);
  const debt = Math.abs(row.total);
  return <div className="modal-backdrop confirm-order-backdrop" role="presentation" onMouseDown={onDismiss}>
    <section ref={dialogRef} tabIndex={-1} className="confirm-order-modal" role="dialog" aria-modal="true" aria-labelledby="spot-debt-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div>
          <p className="eyebrow negative">{t('Debt')}</p>
          <h2 id="spot-debt-title">{t('How to repay this debt')}</h2>
          <span className="confirm-market">{row.coin} · {venue}</span>
        </div>
        <button className="disclaimer-close" aria-label={t('Close')} onClick={onDismiss}>×</button>
      </header>
      <dl className="confirm-order-summary">
        <div><dt>{t('Debt')}</dt><dd>{formatAmount(debt)} {row.coin}</dd></div>
        <div><dt>{t('Available')}</dt><dd>{formatAmount(row.available)} {row.coin}</dd></div>
        <div><dt>{t('Valuation (USDT)')}</dt><dd>{row.valuationUsd === null ? '—' : formatUsd(row.valuationUsd)}</dd></div>
      </dl>
      <p className="close-position-warning">{t('This exchange runs no spot business, so the debt cannot be bought back with a spot order. CrossEx borrowed this coin to margin positions here.')}</p>
      <ol className="debt-repay-paths">
        <li>
          <strong>{t('Close contracts on this exchange')}</strong>
          <span>{t('Bottom tabs: Contract → Positions. Closing them releases the margin, which repays the borrow.')}</span>
          {contracts.length > 0 && <span className="debt-repay-contracts mono">{contracts.map((contract) => `${symbolParts(contract.symbol).asset ?? contract.symbol} ${contract.quantity}`).join(' · ')}</span>}
        </li>
        <li>
          <strong>{t('Transfer the coin in')}</strong>
          <span>{t('Funding page → Fund operations → Transfer: move this coin into the exchange account from an account that holds it.')}</span>
        </li>
      </ol>
      <div className="confirm-order-actions">
        <button className="confirm-back" data-dialog-autofocus onClick={onDismiss}>{t('Got it')}</button>
      </div>
    </section>
  </div>;
}
