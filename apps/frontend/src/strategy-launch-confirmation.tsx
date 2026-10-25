import type { ReactNode } from 'react';
import { useLanguage } from './i18n.js';
import { ModalPortal } from './modal-portal.js';
import { useDialogFocus } from './route-shared.js';

export interface StrategyConfirmationRow {
  label: string;
  value: ReactNode;
  tone?: 'positive' | 'negative';
}

export function StrategyLaunchConfirmation({
  market,
  rows,
  busy,
  onCancel,
  onConfirm,
}: {
  market: string;
  rows: StrategyConfirmationRow[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLanguage();
  const dialogRef = useDialogFocus(true, busy ? undefined : onCancel);

  // R1: the dialog mounts on document.body (ModalPortal) so no ancestor stacking context or
  // scroll container can shift it out from under a mobile tap, and the backdrop only closes on
  // a near-stationary pointer tap — never on the synthesized `mousedown` that preceded the
  // click and used to unmount the dialog before the confirm button received it.
  return (
    <ModalPortal locked={busy} onDismiss={onCancel}>
      <section ref={dialogRef} tabIndex={-1} className="confirm-order-modal strategy-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-strategy-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">{t('Live automation')}</p>
            <h2 id="confirm-strategy-title">{t('Confirm strategy launch')}</h2>
            <span className="confirm-market">{market}</span>
          </div>
          <button className="disclaimer-close" aria-label={t('Close')} onClick={onCancel} disabled={busy}>×</button>
        </header>
        <p className="strategy-confirm-warning">{t('Review the strategy details before starting live automated execution.')}</p>
        <dl className="confirm-order-summary">
          {rows.map((row, index) => <div key={`${row.label}:${index}`}><dt>{row.label}</dt><dd className={row.tone}>{row.value}</dd></div>)}
        </dl>
        <div className="confirm-order-actions">
          <button className="confirm-back" data-dialog-autofocus onClick={onCancel} disabled={busy}>{t('Go back')}</button>
          <button className="confirm-submit buy" disabled={busy} onClick={onConfirm}>
            <strong>{busy ? t('Launching…') : t('Run strategy')}</strong>
            <span>{t('This will start live automated execution.')}</span>
          </button>
        </div>
      </section>
    </ModalPortal>
  );
}
