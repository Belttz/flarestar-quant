import type { RefObject } from 'react';
import type { StrategyRecord } from './api.js';
import { useLanguage } from './i18n.js';
import { strategyConfigRows, strategyPnlRows, strategySummaryRows, type DetailRow } from './strategy-config-rows.js';

export interface StrategyConfigDetailDialogProps {
  strategy: StrategyRecord;
  /** Opens the execution log for the same strategy (the panel owns that state). */
  onViewLogs: () => void;
  /** Prefills the launch form with this strategy's configuration. */
  onCopy: () => void;
  onClose: () => void;
  dialogRef: RefObject<HTMLElement | null>;
}

function Rows({ rows }: { rows: DetailRow[] }) {
  return <dl className="strategy-detail-rows">
    {rows.map((row, index) => <div key={`${row.label}:${index}`}>
      <dt>{row.label}</dt>
      <dd>{row.value}</dd>
    </div>)}
  </dl>;
}

/**
 * Read-only "what is this strategy actually running" dialog, opened by clicking a strategy row or
 * by an `?strategyId=` deep link.
 *
 * It is a pure presentational view over `StrategyRecord` + `strategy.pnl`, hoisted out of
 * `RunningStrategiesPanel` so its markup can be server-rendered in tests (no jsdom here). It never
 * emits `aria-pressed`: that attribute is banned project-wide, and the dialog-level SSR check
 * rejects it inside dialogs.
 */
export function StrategyConfigDetailDialog({
  strategy,
  onViewLogs,
  onCopy,
  onClose,
  dialogRef,
}: StrategyConfigDetailDialogProps) {
  const { t } = useLanguage();

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section
      ref={dialogRef}
      tabIndex={-1}
      className="confirm-order-modal strategy-config-detail-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="strategy-config-detail-title"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header>
        <div>
          <p className="eyebrow">{t('Strategy configuration')}</p>
          <h2 id="strategy-config-detail-title">{strategy.id}</h2>
          <span className="confirm-market">{`${strategy.config.asset} · ${strategy.config.leftVenue} ⇄ ${strategy.config.rightVenue}`}</span>
        </div>
        <button className="disclaimer-close" aria-label={t('Close')} onClick={onClose}>×</button>
      </header>

      <div className="strategy-detail-body">
        <section>
          <h3>{t('Strategy')}</h3>
          <Rows rows={strategySummaryRows(strategy)} />
        </section>

        <section>
          <h3>{t('Configuration')}</h3>
          <Rows rows={strategyConfigRows(strategy.config)} />
        </section>

        <section>
          <h3>{t('Profit and loss')}</h3>
          <Rows rows={strategyPnlRows(strategy.pnl)} />
          <p className="strategy-detail-note">{t('Floating PnL needs a stored mark price, and the funding fee is only attributable when this strategy alone holds the contract; either shows as — when unavailable.')}</p>
        </section>
      </div>

      <div className="confirm-order-actions strategy-detail-actions">
        <button className="confirm-back" onClick={onClose}>{t('Close')}</button>
        <button className="strategy-detail-secondary" onClick={onViewLogs}>{t('Execution log')}</button>
        <button className="confirm-submit buy" onClick={onCopy}>
          <strong>{t('Copy as new strategy')}</strong>
          <span>{t('Prefills the launch form for review; nothing is submitted.')}</span>
        </button>
      </div>
    </section>
  </div>;
}
