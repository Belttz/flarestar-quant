import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type FundingArbDecision,
  type FundingArbDryRunTrade,
  type FundingArbSettings,
  type FundingArbStatusResponse,
} from './api.js';
import { useLanguage } from './i18n.js';

/**
 * Automatic perp ⇄ perp funding-rate arbitrage panel (Funding page).
 *
 * It is the operator surface for the backend runner: the monitoring / dry-run / auto-execute
 * switches, the entry and risk thresholds, the latest scan's candidates with their reject reasons,
 * and the dry-run trade log. The backend owns all decision logic; this panel only edits settings
 * and renders the audit trail, so a refresh never changes what the runner would do.
 */

const NUMBER_FIELDS: Array<{ key: keyof FundingArbSettings; label: string; unit?: string }> = [
  { key: 'minAprPercent', label: 'Min funding APR', unit: '%' },
  { key: 'maxPerTradeUsd', label: 'Max per trade', unit: 'USD' },
  { key: 'maxTotalExposureUsd', label: 'Max total exposure', unit: 'USD' },
  { key: 'maxConcurrent', label: 'Max concurrent' },
  { key: 'maxEntriesPerDay', label: 'Max entries / day' },
  { key: 'scanIntervalMinutes', label: 'Scan interval', unit: 'min' },
  { key: 'maxLeverage', label: 'Max leverage', unit: 'x' },
  { key: 'safetyFactor', label: 'Safety factor' },
  { key: 'entrySlipBufferBps', label: 'Entry slippage buffer', unit: 'bps' },
  { key: 'makerEntryProximityBps', label: 'Park / resume band', unit: 'bps' },
  { key: 'exitFundingAprFloorPercent', label: 'Funding decay exit floor', unit: '%' },
  { key: 'exitFundingDecayDwellSeconds', label: 'Decay dwell', unit: 's' },
  { key: 'minHoldingHours', label: 'Min holding', unit: 'h' },
  { key: 'maxHoldingHours', label: 'Max holding', unit: 'h' },
  { key: 'confirmScans', label: 'Entry confirmations' },
  { key: 'pairLossThreshold', label: 'Losses before pair pause' },
  { key: 'pairLossCooldownHours', label: 'Pair pause', unit: 'h' },
  { key: 'dailyLossLimitFraction', label: 'Daily loss halt', unit: 'fraction' },
  { key: 'maxCurrentTo24hRatio', label: 'Max current / 24h ratio' },
  { key: 'max24hTo7dRatio', label: 'Max 24h / 7d ratio' },
  { key: 'persistenceMinSamples24h', label: 'Min 24h samples' },
  { key: 'persistenceMinSamples7d', label: 'Min 7d samples' },
  { key: 'marginHeadroomPct', label: 'Margin headroom', unit: 'fraction' },
  { key: 'maxMarginPerVenueUsd', label: 'Max margin per venue', unit: 'USD' },
  { key: 'exitFundingDeclineReadings', label: 'Decline exit readings' },
  { key: 'makerEntryOffsetBps', label: 'Maker entry offset', unit: 'bps' },
  { key: 'makerEntryTimeoutSeconds', label: 'Maker entry timeout', unit: 's' },
  { key: 'orphanGraceSeconds', label: 'Orphan grace', unit: 's' },
  { key: 'adlExitRank', label: 'ADL exit rank' },
  { key: 'adlReduceRank', label: 'ADL reduce rank' },
  { key: 'adlReduceFraction', label: 'ADL reduce fraction', unit: 'fraction' },
  { key: 'hardStopLossBps', label: 'Hard stop-loss', unit: 'bps' },
  { key: 'cooldownMinutes', label: 'Cooldown', unit: 'min' },
];

export function FundingArbPanel() {
  const { t } = useLanguage();
  const [status, setStatus] = useState<FundingArbStatusResponse | null>(null);
  const [draft, setDraft] = useState<FundingArbSettings | null>(null);
  const [decisions, setDecisions] = useState<FundingArbDecision[]>([]);
  const [trades, setTrades] = useState<FundingArbDryRunTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const draftDirty = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api.fundingArbStatus();
      setStatus(next);
      if (!draftDirty.current) setDraft(next.settings);
      const [decisionResult, tradeResult] = await Promise.all([
        api.fundingArbDecisions(50),
        api.fundingArbTrades(),
      ]);
      setDecisions(decisionResult.decisions);
      setTrades(tradeResult.trades.slice(0, 20));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const save = useCallback(async (patch: Partial<FundingArbSettings>) => {
    draftDirty.current = false;
    setBusy(true);
    try {
      const next = await api.saveFundingArbSettings(patch);
      setStatus(next);
      setDraft(next.settings);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  const updateDraft = (key: keyof FundingArbSettings, value: string) => {
    if (!draft) return;
    draftDirty.current = true;
    if (typeof draft[key] === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return;
      setDraft({ ...draft, [key]: parsed });
    } else {
      setDraft({ ...draft, [key]: value } as FundingArbSettings);
    }
  };

  const candidates = useMemo(() => status?.lastResult?.candidates ?? [], [status]);
  const passCount = candidates.filter((candidate) => candidate.verdict === 'PASS').length;

  return (
    <section className="terminal-panel funding-arb-panel" aria-label={t('Automatic funding arbitrage')}>
      <header className="funding-arb-head">
        <div>
          <p className="eyebrow">{t('Perp ⇄ perp · automatic')}</p>
          <h2>{t('Funding arbitrage runner')}</h2>
          <p>
            {t('Scans the funding hedge board on a clock-aligned cadence, sizes the hedge from available margin × leverage and opens the paired position strategy.')}
          </p>
        </div>
        <div className="funding-arb-state" role="status">
          <span className={status?.running ? 'dot dot-live' : 'dot'} />
          <strong>{status?.running ? t('Monitoring') : t('Stopped')}</strong>
          <small>
            {status?.lastScanAt ? `${t('Last scan')} ${new Date(status.lastScanAt).toLocaleTimeString()}` : t('Never scanned')}
            {status?.lastResult ? ` · ${passCount}/${candidates.length} ${t('pass')}` : ''}
            {status?.lastResult && !status.lastResult.dataFresh ? ` · ${t('data stale')}` : ''}
          </small>
        </div>
      </header>

      {error && <p className="funding-arb-error" role="alert">{error}</p>}

      <div className="funding-arb-switches" role="group" aria-label={t('Runner switches')}>
        <label className="preference-switch">
          <input type="checkbox" checked={status?.settings.enabled ?? false} disabled={busy}
            onChange={(event) => void save({ enabled: event.target.checked })} />
          <span>{t('Monitoring on')}</span>
        </label>
        <label className="preference-switch">
          <input type="checkbox" checked={status?.settings.dryRun ?? true} disabled={busy}
            onChange={(event) => void save({ dryRun: event.target.checked })} />
          <span>{t('Dry run (no orders)')}</span>
        </label>
        <label className="preference-switch">
          <input type="checkbox" checked={status?.settings.orphanWatchEnabled ?? true} disabled={busy}
            onChange={(event) => void save({ orphanWatchEnabled: event.target.checked })} />
          <span>{t('Orphan leg guardian')}</span>
        </label>
        <label className="preference-switch">
          <input type="checkbox" checked={status?.settings.adlWatchEnabled ?? true} disabled={busy}
            onChange={(event) => void save({ adlWatchEnabled: event.target.checked })} />
          <span>{t('ADL guardian')}</span>
        </label>
        <label className="preference-switch">
          <input type="checkbox" checked={status?.settings.exitOnFundingFlip ?? true} disabled={busy}
            onChange={(event) => void save({ exitOnFundingFlip: event.target.checked })} />
          <span>{t('Close when funding flips')}</span>
        </label>
        <label className="preference-switch">
          <input type="checkbox" checked={status?.settings.autoExecute ?? false}
            disabled={busy || !(status?.liveTradingEnabled ?? false)}
            onChange={(event) => {
              const enabled = event.target.checked;
              if (enabled && !window.confirm(t('Auto-execute places real orders in live mode. Continue?'))) return;
              void save({ autoExecute: enabled });
            }} />
          <span>{t('Auto-execute')}</span>
        </label>
        <button className="row-action" disabled={busy} onClick={() => { setBusy(true); void api.scanFundingArb().then((next) => { setStatus(next); setBusy(false); }).catch((caught: unknown) => { setBusy(false); setError(caught instanceof Error ? caught.message : String(caught)); }); }}>
          {t('Scan now')}
        </button>
        <button className="row-action danger" disabled={busy} onClick={() => void save({ enabled: false, autoExecute: false })}>
          {t('Emergency stop')}
        </button>
      </div>

      {draft && (
        <div className="funding-arb-settings">
          <div className="funding-arb-grid">
            {NUMBER_FIELDS.map((field) => (
              <label key={String(field.key)} className="funding-arb-field">
                <span>{t(field.label)}{field.unit ? ` (${field.unit})` : ''}</span>
                <input inputMode="decimal" value={String(draft[field.key] ?? '')} disabled={busy}
                  onChange={(event) => updateDraft(field.key, event.target.value)} />
              </label>
            ))}
            <label className="funding-arb-field">
              <span>{t('Persistence mode')}</span>
              <select value={draft.fundingPersistenceMode} disabled={busy}
                onChange={(event) => { draftDirty.current = true; setDraft({ ...draft, fundingPersistenceMode: event.target.value as FundingArbSettings['fundingPersistenceMode'] }); }}>
                <option value="off">{t('Off')}</option>
                <option value="24h">{t('24h only')}</option>
                <option value="24h7d">{t('24h + 7d')}</option>
              </select>
            </label>
            <label className="funding-arb-field">
              <span>{t('Maker leg')}</span>
              <select value={draft.makerLegMode} disabled={busy}
                onChange={(event) => { draftDirty.current = true; setDraft({ ...draft, makerLegMode: event.target.value as FundingArbSettings['makerLegMode'] }); }}>
                <option value="auto">{t('Auto by depth')}</option>
                <option value="left">{t('Left')}</option>
                <option value="right">{t('Right')}</option>
              </select>
            </label>
            <label className="funding-arb-field">
              <span>{t('Leverage mode')}</span>
              <select value={draft.leverageMode} disabled={busy}
                onChange={(event) => { draftDirty.current = true; setDraft({ ...draft, leverageMode: event.target.value as FundingArbSettings['leverageMode'] }); }}>
                <option value="max">{t('Max available')}</option>
                <option value="fixed">{t('Fixed')}</option>
              </select>
            </label>
          </div>
          <button className="row-action" disabled={busy} onClick={() => void save(draft)}>{t('Save thresholds')}</button>
        </div>
      )}

      <div className="funding-arb-tables">
        <div>
          <h3>{t('Latest scan')} <small>{candidates.length} {t('candidates')}</small></h3>
          <div className="funding-arb-table-wrap">
            <table className="funding-arb-table">
              <thead>
                <tr>
                  <th>{t('Asset')}</th><th>{t('Short / long')}</th><th>{t('APR')}</th>
                  <th>{t('Entry bps')}</th><th>{t('Notional')}</th><th>{t('Verdict')}</th><th>{t('Reasons')}</th>
                </tr>
              </thead>
              <tbody>
                {candidates.slice(0, 15).map((candidate) => (
                  <tr key={candidate.key}>
                    <td>{candidate.asset}</td>
                    <td>{candidate.shortVenue} / {candidate.longVenue}</td>
                    <td>{candidate.aprPercent.toFixed(0)}%</td>
                    <td>{candidate.entryBps ?? '—'}</td>
                    <td>{candidate.notionalUsd === null ? '—' : `$${candidate.notionalUsd.toFixed(2)}`}</td>
                    <td><span className={candidate.verdict === 'PASS' ? 'funding-arb-pass' : 'funding-arb-reject'}>{candidate.verdict}</span></td>
                    <td className="funding-arb-reasons">{candidate.reasons.length === 0 ? '—' : candidate.reasons.join(', ')}</td>
                  </tr>
                ))}
                {candidates.length === 0 && <tr><td colSpan={7} className="funding-arb-empty">{t('No scan yet — press “Scan now”.')}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3>{t('Dry-run trades')} <small>{trades.length}</small></h3>
          <div className="funding-arb-table-wrap">
            <table className="funding-arb-table">
              <thead>
                <tr>
                  <th>{t('Asset')}</th><th>{t('Venues')}</th><th>{t('Notional')}</th>
                  <th>{t('Funding')}</th><th>{t('Fees')}</th><th>{t('PnL')}</th><th>{t('Status')}</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((trade) => (
                  <tr key={trade.id}>
                    <td>{trade.asset}</td>
                    <td>{trade.shortVenue} / {trade.longVenue}</td>
                    <td>${trade.notionalUsd.toFixed(2)}</td>
                    <td className="funding-arb-pos">${trade.fundingUsd.toFixed(2)}</td>
                    <td>${trade.feesUsd.toFixed(2)}</td>
                    <td className={trade.pnlUsd >= 0 ? 'funding-arb-pos' : 'funding-arb-neg'}>${trade.pnlUsd.toFixed(2)}</td>
                    <td>{trade.status}</td>
                  </tr>
                ))}
                {trades.length === 0 && <tr><td colSpan={7} className="funding-arb-empty">{t('No dry-run trades yet.')}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <details className="funding-arb-audit">
        <summary>{t('Audit trail')} <small>{decisions.length}</small></summary>
        <ul>
          {decisions.slice(0, 20).map((decision) => (
            <li key={decision.id}>
              <time dateTime={decision.scannedAt}>{new Date(decision.scannedAt).toLocaleTimeString()}</time>
              <strong>{decision.candidateKey}</strong>
              <span className={decision.verdict === 'PASS' ? 'funding-arb-pass' : 'funding-arb-reject'}>{decision.verdict}</span>
              <span>{decision.reasons.join(', ')}</span>
              {decision.strategyId && <code>{decision.strategyId}</code>}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
