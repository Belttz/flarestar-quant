import type { ResidualReport } from './api.js';
import { residualLines } from './close-reconciliation.js';
import { useLanguage } from './i18n.js';
import { useDialogFocus } from './route-shared.js';
import { ModalPortal } from './modal-portal.js';

/**
 * Post-close reconciliation dialog (R2/R11): after a close plan finishes, `POST /api/close/verify`
 * re-reads the venue; residuals above the market's minimum order unit are shown here with the
 * reason and a suggested next step, in the same visual mode as the spot-debt explainer. A clean
 * report never opens this dialog — the caller shows the plain "closed" notice instead.
 */
export function ResidualDialog({ report, onDismiss }: { report: ResidualReport; onDismiss: () => void }) {
  const { t } = useLanguage();
  const dialogRef = useDialogFocus(true, onDismiss);
  const lines = residualLines(report);
  return (
    <ModalPortal onDismiss={onDismiss}>
      <section ref={dialogRef} tabIndex={-1} className="confirm-order-modal" role="dialog" aria-modal="true" aria-labelledby="residual-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow negative">{t('Close reconciliation')}</p>
            <h2 id="residual-title">{t('Positions could not be fully closed')}</h2>
            <span className="confirm-market">{t(`${lines.length} residual ${lines.length === 1 ? 'position' : 'positions'}`)}</span>
          </div>
          <button className="disclaimer-close" aria-label={t('Close')} onClick={onDismiss}>×</button>
        </header>
        <p className="close-position-warning">
          {t('These legs still hold more than the smallest orderable unit after the close plan ended. The terminal never auto-liquidates dust — settle them manually or rerun the close.')}
        </p>
        <dl className="confirm-order-summary">
          {lines.map((line) => (
            <div key={line.symbol}>
              <dt>{line.symbol}</dt>
              <dd>
                <span className="mono">{line.quantity}</span>
                <small>{line.reason}</small>
                <small>{t('Suggestion')}: {line.suggestion}</small>
              </dd>
            </div>
          ))}
        </dl>
        <div className="confirm-order-actions">
          <button className="confirm-back" data-dialog-autofocus onClick={onDismiss}>{t('Got it')}</button>
        </div>
      </section>
    </ModalPortal>
  );
}
