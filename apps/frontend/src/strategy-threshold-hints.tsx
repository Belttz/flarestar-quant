import { useLanguage } from './i18n.js';
import { formatBps, formatTierLevels, type AutoThresholdView } from './strategy-ladder.js';

export interface AutoThresholdHintsProps {
  /** Threshold arithmetic derived from the raw auto-form strings. */
  view: AutoThresholdView;
  /** True once the operator types an add-on step; blank keeps tick-driven accumulation. */
  armed: boolean;
}

/**
 * Plain-language hints rendered under the auto strategy's threshold inputs.
 *
 * `stopLossBps` is an **absolute** spread level while entry only requires `spread >= entryBps`
 * with no upper bound, so the adverse move a freshly opened position can still absorb is
 * `stopLossBps - |entryBps|`. Without this line an operator configuring 65 / 100 believes they
 * tolerate 100 bps when they really tolerate 35 — which is exactly how the production instance
 * `AUTO-1CCEAE53` stopped out at a 141 bps spread (design §5.10-5.12).
 *
 * The optional ladder preview then lists the tiers reachable before that stop line ends the run
 * (§8.7). It is deliberately execution-method agnostic: the tier levels
 * `entryBps + k * step` and the stop cap are the same for `TAKER_TAKER` and `MAKER_TAKER`, so
 * there is no branch here (§8.5.6).
 *
 * Presentational and exported so the copy can be asserted from static markup — there is no
 * jsdom in this workspace. It never uses `aria-pressed`; the dialog-level SSR assertion bans
 * that attribute across the app.
 */
export function AutoThresholdHints({ view, armed }: AutoThresholdHintsProps) {
  const { t } = useLanguage();
  const buffer = view.stopBuffer;

  return <div className="strategy-threshold-hints">
    {buffer !== null && <p className={`strategy-stop-buffer${view.stopLossTooClose ? ' invalid' : ''}`}>
      <strong>{t('Effective stop buffer')}: {formatBps(buffer.bufferBps)} bps</strong>
      <small>{t('You enter at')} {formatBps(Math.abs(buffer.entryBps))} bps, {t('but the stop is an absolute')} {formatBps(buffer.stopLossBps)} bps {t('spread — so only')} {formatBps(buffer.bufferBps)} {t('bps of adverse move remain before it exits')}</small>
    </p>}
    {view.stopLossTooClose && <p className="strategy-stop-buffer invalid">{t('Stop-loss must exceed the entry threshold')}</p>}
    {view.addOnStepInvalid && <p className="strategy-stop-buffer invalid">{t('Add-on step must be positive')}</p>}
    {view.firstTierBeyondStop && <p className="strategy-stop-buffer invalid">{t('The first add-on tier must sit below the stop-loss')}</p>}
    {view.ladder !== null && <p className="strategy-ladder-preview">
      <span>{t('Add-on tiers')}: {formatTierLevels(view.ladder)} bps</span>
      {view.ladder.cap === 'position'
        ? <span> · {view.ladder.clipCount} {t('clips')} · {t('limited by max position')}</span>
        : view.stopLossBps !== null
          ? <span> · {view.ladder.clipCount} {t('clips before the')} {formatBps(view.stopLossBps)} {t('bps stop')}</span>
          : null}
    </p>}
    {armed && <p className="strategy-ladder-note">{t('Applies to Taker–Taker and Maker–Taker; on Maker–Taker tiers fill from a resting quote.')}</p>}
  </div>;
}
