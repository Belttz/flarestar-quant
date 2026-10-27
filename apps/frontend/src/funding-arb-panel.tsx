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
 * Layout is deliberately split into three bands: a status/action bar (start / stop / scan now /
 * emergency stop), a collapsible parameter editor grouped by concern (entry gates, sizing, entry
 * execution, exits, guards), and the audit tables. Every field carries a short bilingual hint, so
 * the panel is usable without reading the design document.
 */

type Help = { en: string; zh: string };

interface FieldDef {
  key: keyof FundingArbSettings;
  label: string;
  unit?: string;
  help?: Help;
  kind?: 'number' | 'toggle';
}

interface SelectDef {
  key: keyof FundingArbSettings;
  label: string;
  options: Array<{ value: string; label: string }>;
  help?: Help;
}

interface GroupDef {
  title: string;
  hint: Help;
  fields: FieldDef[];
  selects?: SelectDef[];
}

const GROUPS: GroupDef[] = [
  {
    title: 'Entry gates',
    hint: { en: 'The pair must clear the APR, per-wave edge and persistence filters before anything is opened.', zh: '两腿价差必须先通过年化、单次净收益与持续性过滤才会开仓。' },
    selects: [{
      key: 'fundingPersistenceMode',
      label: 'Persistence mode',
      options: [
        { value: 'off', label: 'Off' },
        { value: '24h', label: '24h only' },
        { value: '24h7d', label: '24h + 7d' },
      ],
      help: {
        en: 'Off = trade the current snapshot; 24h = require the trailing day positive and not spiking; 24h+7d = additionally require a positive week.',
        zh: '关闭=只看当前快照；24h=要求过去一天累计为正且当前不是尖峰；24h+7d=再要求过去一周也为正。',
      },
    }],
    fields: [
      { key: 'minAprPercent', label: 'Min funding APR', unit: '%', help: { en: 'Annualized funding-differential gate.', zh: '价差年化门槛，低于该值不开仓。' } },
      { key: 'minNetPerSettlementBps', label: 'Min net per wave', unit: 'bps', help: { en: 'Expected funding in one hold wave minus the 27.2 bps round trip.', zh: '持有到较慢腿下一结算的预期资金费减去往返 27.2bps 后，至少还剩多少 bps。' } },
      { key: 'maxCurrentTo24hRatio', label: 'Max current / 24h ratio', help: { en: 'Reject when the current APR is more than this multiple of the 24h average.', zh: '当前年化超过 24h 平均的倍数上限，防一期尖峰。' } },
      { key: 'max24hTo7dRatio', label: 'Max 24h / 7d ratio', help: { en: 'Reject when the last day is more than this multiple of the last week.', zh: '24h 平均超过 7d 平均的倍数上限。' } },
      { key: 'persistenceMinSamples24h', label: 'Min 24h samples', help: { en: 'Settlements required in the 24h window.', zh: '24h 窗口内至少需要的结算样本数。' } },
      { key: 'persistenceMinSamples7d', label: 'Min 7d samples', help: { en: 'Settlements required in the 7d window.', zh: '7d 窗口内至少需要的结算样本数。' } },
    ],
  },
  {
    title: 'Scan & confirmation',
    hint: { en: 'How often the runner scans and how many consecutive scans a candidate must pass.', zh: '扫描频率，以及候选需要连续通过几次扫描。' },
    fields: [
      { key: 'scanIntervalMinutes', label: 'Scan interval', unit: 'min', help: { en: 'Clock-aligned scan cadence (default 60 min at :30).', zh: '扫描间隔，默认 60 分钟、整点 :30 触发。' } },
      { key: 'confirmScans', label: 'Entry confirmations', help: { en: 'Consecutive scans a candidate must pass; restart confirmation is replayed from funding history.', zh: '候选需连续通过几次扫描；重启后会用历史结算费率回放，不需要等待。' } },
    ],
  },
  {
    title: 'Sizing & leverage',
    hint: { en: 'Notional = available margin × (1 − headroom) × safety ÷ (1/L1 + 1/L2), capped by the limits below.', zh: '仓位公式：名义 = 可用保证金 × (1−安全垫) × 安全系数 ÷ (1/L1 + 1/L2)，并受下方上限约束。' },
    selects: [{
      key: 'leverageMode',
      label: 'Leverage mode',
      options: [
        { value: 'max', label: 'Max available' },
        { value: 'fixed', label: 'Fixed' },
      ],
      help: { en: 'Max uses each leg risk-tier ceiling; fixed uses the value below.', zh: 'max=取两腿风险档最高杠杆；fixed=使用固定杠杆。' },
    }],
    fields: [
      { key: 'maxPerTradeUsd', label: 'Max per trade', unit: 'USD', help: { en: 'Hard per-position notional cap.', zh: '单笔名义本金硬上限。' } },
      { key: 'maxTotalExposureUsd', label: 'Max total exposure', unit: 'USD', help: { en: 'Sum of all automatic positions.', zh: '所有自动仓位名义本金合计上限。' } },
      { key: 'maxConcurrent', label: 'Max concurrent', help: { en: 'Concurrent auto positions (engine overall cap is 10).', zh: '同时持有的自动仓位数（引擎总上限 10）。' } },
      { key: 'maxEntriesPerDay', label: 'Max entries / day', help: { en: 'New positions per UTC day.', zh: '每个 UTC 日最多新开仓次数。' } },
      { key: 'maxLeverage', label: 'Max leverage', unit: 'x', help: { en: 'Ceiling applied in max mode.', zh: 'max 模式下的杠杆硬上限。' } },
      { key: 'fixedLeverage', label: 'Fixed leverage', unit: 'x', help: { en: 'Used when leverage mode is fixed.', zh: 'fixed 模式下使用的杠杆。' } },
      { key: 'safetyFactor', label: 'Safety factor', unit: '0-1', help: { en: 'Share of margin the sizing formula may use.', zh: '计算仓位时可用保证金的比例。' } },
      { key: 'marginHeadroomPct', label: 'Margin headroom', unit: '0-1', help: { en: 'Extra margin kept aside for fees/slippage.', zh: '额外预留的保证金比例（手续费/滑点）。' } },
      { key: 'maxMarginPerVenueUsd', label: 'Max margin per venue', unit: 'USD', help: { en: 'Optional per-leg venue margin cap (0 = off).', zh: '单交易所单腿保证金上限（0=关闭）。' } },
    ],
  },
  {
    title: 'Entry execution',
    hint: { en: 'One leg rests a post-only limit, the other hedges at market; quotes park when the spread drifts away.', zh: '一腿挂 post-only 限价、另一腿市价对冲；价差偏离触发点会自动暂停报价。' },
    selects: [{
      key: 'makerLegMode',
      label: 'Maker leg',
      options: [
        { value: 'auto', label: 'Auto by depth' },
        { value: 'left', label: 'Left (short)' },
        { value: 'right', label: 'Right (long)' },
      ],
      help: { en: 'Auto puts the maker on the thinner top-of-book leg.', zh: 'auto=把限价腿放在顶档更浅的一腿。' },
    }],
    fields: [
      { key: 'entrySlipBufferBps', label: 'Entry slippage buffer', unit: 'bps', help: { en: 'Dynamic entryBps = executable spread − buffer − depth penalty.', zh: '动态入场触发价 = 可执行价差 − 滑点缓冲 − 深度惩罚。' } },
      { key: 'makerEntryProximityBps', label: 'Park / resume band', unit: 'bps', help: { en: 'Quote only when the spread is within this band of the trigger.', zh: '价差距触发点多少 bps 内才挂单，超出则暂停。' } },
      { key: 'makerEntryOffsetBps', label: 'Maker entry offset', unit: 'bps', help: { en: 'Signed offset from best bid/ask (positive = more aggressive).', zh: '限价相对买一/卖一的偏移，正数更激进。' } },
      { key: 'makerEntryTimeoutSeconds', label: 'Maker entry timeout', unit: 's', help: { en: 'Cancel + pause when unfilled; never converts to market.', zh: '未成交超时后撤单并暂停策略，绝不转市价。' } },
    ],
  },
  {
    title: 'Exit rules',
    hint: { en: 'Hold while the funding differential still pays; exit on decay, flip, decline or the holding-time caps.', zh: '价差还在收钱就继续持有；衰减、转负、连续递减或触及持有时间上限时平仓。' },
    fields: [
      { key: 'exitFundingAprFloorPercent', label: 'Funding decay exit floor', unit: '%', help: { en: 'Close once the pair APR falls below this level.', zh: '价差年化跌破该值时平仓。' } },
      { key: 'exitFundingDecayDwellSeconds', label: 'Decay dwell', unit: 's', help: { en: 'Must stay below the floor this long before closing.', zh: '低于衰减线需持续多少秒才平仓（防抖）。' } },
      { key: 'exitFundingDeclineReadings', label: 'Decline exit readings', help: { en: 'Close after this many strictly declining readings below the floor.', zh: '连续多少次读数递减且低于衰减线时提前平仓。' } },
      { key: 'minHoldingHours', label: 'Min holding', unit: 'h', help: { en: 'Soft exits are skipped before this holding time.', zh: '最短持有时间，期间不执行软退出（硬止损仍生效）。' } },
      { key: 'maxHoldingHours', label: 'Max holding', unit: 'h', help: { en: 'Force close after this many hours.', zh: '最长持有时间，到点强制平仓。' } },
      { key: 'exitOnFundingFlip', label: 'Close when funding flips', kind: 'toggle', help: { en: 'Close when the differential turns negative.', zh: '价差转负时立即平仓。' } },
    ],
  },
  {
    title: 'Risk & guards',
    hint: { en: 'Cooldowns, loss circuit breakers and the ADL / half-leg guardians.', zh: '冷却、亏损熔断，以及 ADL 与半腿仓守护。' },
    fields: [
      { key: 'hardStopLossBps', label: 'Hard stop-loss', unit: 'bps', help: { en: '0 disables the position stop-loss.', zh: '硬止损，0=关闭。' } },
      { key: 'cooldownMinutes', label: 'Cooldown', unit: 'min', help: { en: 'Pause after any close before re-opening the same asset.', zh: '平仓后同资产冷却时间。' } },
      { key: 'pairLossThreshold', label: 'Losses before pair pause', help: { en: 'Losing closes before the asset is paused.', zh: '同资产亏几次后暂停。' } },
      { key: 'pairLossCooldownHours', label: 'Pair pause', unit: 'h', help: { en: 'Pause window for the loss cooldown.', zh: '连亏暂停时长。' } },
      { key: 'dailyLossLimitFraction', label: 'Daily loss halt', unit: '0-1', help: { en: 'Halt new entries once today realized loss reaches this share of margin.', zh: '当日已实现亏损达到保证金比例后停止开新仓。' } },
      { key: 'orphanWatchEnabled', label: 'Orphan leg guardian', kind: 'toggle', help: { en: 'Close a surviving leg when the other leg is gone.', zh: '一条腿没有持仓时平掉另一条腿。' } },
      { key: 'orphanGraceSeconds', label: 'Orphan grace', unit: 's', help: { en: 'How long one-leg exposure may persist before the guardian acts.', zh: '单腿敞口持续多久后守护动手。' } },
      { key: 'adlWatchEnabled', label: 'ADL guardian', kind: 'toggle', help: { en: 'Read venue ADL ranks and reduce/close before auto-deleveraging.', zh: '读取交易所 ADL 档位，在自动减仓前减/平。' } },
      { key: 'adlReduceRank', label: 'ADL reduce rank', help: { en: 'Warning rank that triggers a partial reduce.', zh: '触发部分减仓的 ADL 档位。' } },
      { key: 'adlReduceFraction', label: 'ADL reduce fraction', unit: '0-1', help: { en: 'Share of each leg closed at the warning rank.', zh: '预警档位时两腿各平掉的比例。' } },
      { key: 'adlExitRank', label: 'ADL exit rank', help: { en: 'Rank that forces a full close.', zh: '强制全平的 ADL 档位。' } },
    ],
  },
];

const REASON_TEXT: Record<string, string> = {
  DATA_STALE: '数据过期',
  NO_FUNDING: '无费率',
  APR_BELOW: '年化低于门槛',
  NET_APR_BELOW: '单期净收益不足',
  SETTLEMENT_TOO_CLOSE: '临近结算',
  INSTRUMENT_MISSING: '合约缺失',
  LEG_UNAVAILABLE: '一腿不可用',
  SIZE_TOO_SMALL: '数量低于最小下单',
  BALANCE_INSUFFICIENT: '保证金不足',
  SLOT_LIMIT: '并发已满',
  DAILY_LIMIT: '当日次数已满',
  EXPOSURE_LIMIT: '总敞口已满',
  COOLDOWN: '冷却中',
  PAIR_COOLDOWN: '同对连亏暂停',
  DUPLICATE_ASSET: '同资产已有仓位',
  BLACKLISTED: '黑名单',
  CONNECTION_UNHEALTHY: '连接异常',
  LIVE_LOCKED: '非实盘模式',
  ACCOUNT_MISSING: '未配置账户',
  DATA_ANOMALY: '数据异常',
  CONFIRMATION_PENDING: '等待下一次确认',
  FUNDING_PERSISTENCE: '费率持续性不足',
  FUNDING_SPIKE: '费率尖峰',
  DAILY_LOSS_LIMIT: '触发日亏熔断',
  AUTO_OPENED: '已自动开仓',
};

function reasonLabel(reason: string, language: 'en' | 'zh'): string {
  if (language === 'zh') return REASON_TEXT[reason] ?? reason;
  return reason.replaceAll('_', ' ').toLowerCase();
}

function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

export function FundingArbPanel({ onOpenModeDialog }: { onOpenModeDialog?: () => void }) {
  const { t, language } = useLanguage();
  const [status, setStatus] = useState<FundingArbStatusResponse | null>(null);
  const [draft, setDraft] = useState<FundingArbSettings | null>(null);
  const [decisions, setDecisions] = useState<FundingArbDecision[]>([]);
  const [trades, setTrades] = useState<FundingArbDryRunTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [candidateFilter, setCandidateFilter] = useState<'all' | 'PASS' | 'REJECT'>('all');
  const [pendingConfirm, setPendingConfirm] = useState<null | {
    title: string;
    message: string;
    confirmLabel: string;
    tone?: 'primary' | 'danger';
    onConfirm: () => void;
    secondaryLabel?: string;
    onSecondary?: () => void;
  }>(null);
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
  const filteredCandidates = useMemo(() => candidates
    .filter((candidate) => candidateFilter === 'all' || candidate.verdict === candidateFilter)
    .slice(0, 20), [candidates, candidateFilter]);
  const passCount = candidates.filter((candidate) => candidate.verdict === 'PASS').length;
  const settings = status?.settings;
  const running = status?.running ?? false;

  const hint = (help: Help | undefined): string => (help ? (language === 'zh' ? help.zh : help.en) : '');

  const dryRun = settings?.dryRun ?? true;
  const autoExecute = settings?.autoExecute ?? false;
  const exchangeLive = status?.liveTradingEnabled ?? false;

  const askDryRun = () => {
    if (dryRun) {
      setPendingConfirm({
        title: t('Disable dry run?'),
        message: t('With dry run off, the runner can submit real orders once auto-execute is on and the exchange is live.'),
        confirmLabel: t('Disable dry run'),
        tone: 'danger',
        onConfirm: () => { setPendingConfirm(null); void save({ dryRun: false }); },
      });
    } else {
      setPendingConfirm({
        title: t('Enable dry run?'),
        message: t('Dry run only records decisions and simulated trades. No real orders are submitted.'),
        confirmLabel: t('Enable dry run'),
        onConfirm: () => { setPendingConfirm(null); void save({ dryRun: true }); },
      });
    }
  };

  const askAutoExecute = () => {
    if (autoExecute) {
      setPendingConfirm({
        title: t('Disable auto-execute?'),
        message: t('The runner will stop opening positions automatically; existing strategies are not closed.'),
        confirmLabel: t('Disable auto-execute'),
        onConfirm: () => { setPendingConfirm(null); void save({ autoExecute: false }); },
      });
      return;
    }
    if (!exchangeLive) {
      setPendingConfirm({
        title: t('Exchange is read-only'),
        message: t('Auto-execute only places orders when the exchange is live. Switch the trading mode first?'),
        confirmLabel: t('Go to trading mode'),
        onConfirm: () => { setPendingConfirm(null); onOpenModeDialog?.(); },
      });
      return;
    }
    if (dryRun) {
      setPendingConfirm({
        title: t('Enable auto-execute?'),
        message: t('Dry run is still on, so auto-execute will not place real orders. Turn dry run off as well?'),
        confirmLabel: t('Turn off dry run and enable'),
        tone: 'danger',
        onConfirm: () => { setPendingConfirm(null); void save({ autoExecute: true, dryRun: false }); },
        secondaryLabel: t('Enable anyway'),
        onSecondary: () => { setPendingConfirm(null); void save({ autoExecute: true }); },
      });
      return;
    }
    setPendingConfirm({
      title: t('Enable auto-execute?'),
      message: t('The runner will open paired positions automatically when a candidate passes every gate.'),
      confirmLabel: t('Enable auto-execute'),
      tone: 'danger',
      onConfirm: () => { setPendingConfirm(null); void save({ autoExecute: true }); },
    });
  };

  return (
    <section className="terminal-panel funding-arb-panel" aria-label={t('Automatic funding arbitrage')}>
      <header className="funding-arb-head">
        <div>
          <p className="eyebrow">{t('Perp ⇄ perp · automatic')}</p>
          <h2>{t('Funding arbitrage runner')}</h2>
          <p>{t('Scans the funding hedge board on a clock-aligned cadence, sizes the hedge from available margin × leverage and opens the paired position strategy.')}</p>
        </div>
        <div className="funding-arb-state" role="status">
          <span className={running ? 'funding-arb-dot live' : 'funding-arb-dot'} />
          <strong>{running ? t('Running') : t('Stopped')}</strong>
          <small>
            {status?.lastScanAt ? `${t('Last scan')} ${new Date(status.lastScanAt).toLocaleTimeString()}` : t('Never scanned')}
            {status?.lastResult ? ` · ${passCount}/${candidates.length} ${t('pass')}` : ''}
            {status?.lastResult && !status.lastResult.dataFresh ? ` · ${t('data stale')}` : ''}
          </small>
        </div>
      </header>

      {error && <p className="funding-arb-error" role="alert">{error}</p>}

      <div className="funding-arb-actionbar" role="group" aria-label={t('Runner controls')}>
        <div className="funding-arb-actions">
          <button className="funding-arb-btn primary" disabled={busy || running} onClick={() => void save({ enabled: true })}>
            ▶ {t('Start monitoring')}
          </button>
          <button className="funding-arb-btn" disabled={busy || !running} onClick={() => void save({ enabled: false })}>
            ■ {t('Stop monitoring')}
          </button>
          <button className="funding-arb-btn" disabled={busy} onClick={() => {
            setBusy(true);
            void api.scanFundingArb().then((next) => { setStatus(next); setBusy(false); })
              .catch((caught: unknown) => { setBusy(false); setError(caught instanceof Error ? caught.message : String(caught)); });
          }}>⟳ {t('Scan now')}</button>
          <button className="funding-arb-btn danger" disabled={busy} onClick={() => {
            if (!window.confirm(t('Emergency stop disables monitoring and auto-execute. Continue?'))) return;
            void save({ enabled: false, autoExecute: false });
          }}>⛔ {t('Emergency stop')}</button>
        </div>
        <div className="funding-arb-badges">
          <button type="button" className={`funding-arb-switch ${dryRun ? 'on' : 'off'}`} onClick={askDryRun}
            title={t('Click to toggle dry run')}>
            <span className="funding-arb-switch-dot" />
            <span className="funding-arb-switch-text">
              <strong>{dryRun ? t('Dry run on') : t('Dry run off')}</strong>
              <small>{dryRun ? t('No real orders') : t('Real orders possible')}</small>
            </span>
          </button>
          <button type="button" className={`funding-arb-switch ${autoExecute ? 'on' : 'off'}`} onClick={askAutoExecute}
            title={t('Click to toggle auto-execute')}>
            <span className="funding-arb-switch-dot" />
            <span className="funding-arb-switch-text">
              <strong>{autoExecute ? t('Auto-execute on') : t('Auto-execute off')}</strong>
              <small>{autoExecute ? t('Auto opening positions') : t('Records only')}</small>
            </span>
          </button>
          <button type="button" className={`funding-arb-switch ${exchangeLive ? 'on' : 'off'}`}
            onClick={() => onOpenModeDialog?.()} title={t('Switch trading mode')}>
            <span className="funding-arb-switch-dot" />
            <span className="funding-arb-switch-text">
              <strong>{exchangeLive ? t('Exchange live') : t('Exchange readonly')}</strong>
              <small>{exchangeLive ? t('Orders allowed') : t('Orders blocked')}</small>
            </span>
          </button>
        </div>
      </div>

      <details className="funding-arb-guide">
        <summary>{t('How to use this panel')}</summary>
        <ol>
          {(language === 'zh' ? [
            '1. 点「开始监测」：执行器按设定间隔扫描；默认「干跑」只记决策与虚拟成交，不下单。',
            '2. 看下方候选：通过=所有门槛都过了；原因列会逐条说明为什么被拒。',
            '3. 干跑成交是“本来会开的单”。准备实盘时：交易所切到 live 模式 → 取消勾选「干跑」→ 再打开「自动执行」并确认。',
            '4. 「停止监测」只停新的扫描/开仓，已有策略不动；「紧急停止」还会同时关掉自动执行。',
          ] : [
            '1. Click “Start monitoring”: the runner scans on its schedule and only records decisions while dry run is on.',
            '2. Review the candidates below: PASS means every gate cleared; the reasons column explains every rejection.',
            '3. Dry-run trades show what would have been opened. For real orders: switch live mode on the exchange → uncheck “Dry run” → enable “Auto-execute” and confirm.',
            '4. “Stop monitoring” stops new scans/entries but leaves open strategies alone; “Emergency stop” also disables auto-execute.',
          ]).map((step) => <li key={step}>{step}</li>)}
        </ol>
      </details>

      {draft && (
        <div className="funding-arb-settings">
          {GROUPS.map((group, index) => (
            <details key={group.title} className="funding-arb-group" open={index === 0}>
              <summary>
                <span>{t(group.title)}</span>
                <small>{hint(group.hint)}</small>
              </summary>
              <div className="funding-arb-group-body">
                {group.selects?.map((select) => (
                  <label key={String(select.key)} className="funding-arb-field" title={hint(select.help)}>
                    <span>{t(select.label)}</span>
                    <select value={String(draft[select.key] ?? '')} disabled={busy}
                      onChange={(event) => {
                        draftDirty.current = true;
                        setDraft({ ...draft, [select.key]: event.target.value } as FundingArbSettings);
                      }}>
                      {select.options.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
                    </select>
                    <small>{hint(select.help)}</small>
                  </label>
                ))}
                {group.fields.map((field) => field.kind === 'toggle' ? (
                  <label key={String(field.key)} className="funding-arb-field toggle" title={hint(field.help)}>
                    <span>{t(field.label)}</span>
                    <input type="checkbox" checked={Boolean(draft[field.key])} disabled={busy}
                      onChange={(event) => void save({ [field.key]: event.target.checked } as Partial<FundingArbSettings>)} />
                    <small>{hint(field.help)}</small>
                  </label>
                ) : (
                  <label key={String(field.key)} className="funding-arb-field" title={hint(field.help)}>
                    <span>{t(field.label)}{field.unit ? ` (${field.unit})` : ''}</span>
                    <input inputMode="decimal" value={String(draft[field.key] ?? '')} disabled={busy}
                      onChange={(event) => updateDraft(field.key, event.target.value)} />
                    <small>{hint(field.help)}</small>
                  </label>
                ))}
              </div>
            </details>
          ))}
          <div className="funding-arb-savebar">
            <button className="funding-arb-btn primary" disabled={busy} onClick={() => void save(draft)}>{t('Save parameters')}</button>
            <button className="funding-arb-btn" disabled={busy} onClick={() => { draftDirty.current = false; setDraft(status?.settings ?? draft); }}>{t('Discard changes')}</button>
          </div>
        </div>
      )}

      <div className="funding-arb-tables">
        <div>
          <div className="funding-arb-tablehead">
            <h3>{t('Latest scan')} <small>{candidates.length} {t('candidates')}</small></h3>
            <div className="funding-arb-filter" role="group" aria-label={t('Candidate filter')}>
              {(['all', 'PASS', 'REJECT'] as const).map((filter) => (
                <button key={filter} className={candidateFilter === filter ? 'active' : ''}
                  onClick={() => setCandidateFilter(filter)}>
                  {filter === 'all' ? t('All') : filter === 'PASS' ? t('Pass') : t('Reject')}
                </button>
              ))}
            </div>
          </div>
          <div className="funding-arb-table-wrap">
            <table className="funding-arb-table">
              <thead>
                <tr>
                  <th>{t('Asset')}</th><th>{t('Short / long')}</th><th>{t('APR')}</th>
                  <th>{t('Entry bps')}</th><th>{t('Notional')}</th><th>{t('To settlement')}</th>
                  <th>{t('Verdict')}</th><th>{t('Reasons')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredCandidates.map((candidate) => (
                  <tr key={candidate.key}>
                    <td>{candidate.asset}</td>
                    <td>{candidate.shortVenue} / {candidate.longVenue}</td>
                    <td>{candidate.aprPercent.toFixed(0)}%</td>
                    <td>{candidate.entryBps ?? '—'}</td>
                    <td>{candidate.notionalUsd === null ? '—' : `$${candidate.notionalUsd.toFixed(2)}`}</td>
                    <td>{formatMs(candidate.settlementInMs)}</td>
                    <td><span className={candidate.verdict === 'PASS' ? 'funding-arb-pass' : 'funding-arb-reject'}>{t(candidate.verdict === 'PASS' ? 'Pass' : 'Reject')}</span></td>
                    <td className="funding-arb-reasons">{candidate.reasons.length === 0 ? '—' : candidate.reasons.map((reason) => reasonLabel(reason, language)).join('、')}</td>
                  </tr>
                ))}
                {filteredCandidates.length === 0 && <tr><td colSpan={8} className="funding-arb-empty">{t('No scan yet — press “Scan now”.')}</td></tr>}
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
                    <td>{t(trade.status === 'OPEN' ? 'Open' : 'Closed')}</td>
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
              <span className={decision.verdict === 'PASS' ? 'funding-arb-pass' : 'funding-arb-reject'}>{t(decision.verdict === 'PASS' ? 'Pass' : 'Reject')}</span>
              <span>{decision.reasons.map((reason) => reasonLabel(reason, language)).join('、')}</span>
              {decision.strategyId && <code>{decision.strategyId}</code>}
            </li>
          ))}
        </ul>
      </details>

      {pendingConfirm && (
        <div className="funding-arb-modal-backdrop" role="dialog" aria-modal="true" aria-label={pendingConfirm.title}>
          <div className="funding-arb-modal">
            <h3>{pendingConfirm.title}</h3>
            <p>{pendingConfirm.message}</p>
            <div className="funding-arb-modal-actions">
              <button type="button" className="funding-arb-btn" onClick={() => setPendingConfirm(null)}>{t('Cancel')}</button>
              {pendingConfirm.secondaryLabel && pendingConfirm.onSecondary && (
                <button type="button" className="funding-arb-btn" onClick={pendingConfirm.onSecondary}>{pendingConfirm.secondaryLabel}</button>
              )}
              <button type="button" className={`funding-arb-btn ${pendingConfirm.tone === 'danger' ? 'danger' : 'primary'}`}
                onClick={pendingConfirm.onConfirm}>{pendingConfirm.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
