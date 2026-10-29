import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type FundingArbCandidate,
  type FundingArbDecision,
  type FundingArbDryRunTrade,
  type FundingArbSettings,
  type FundingArbStatusResponse,
} from './api.js';
import { useLanguage } from './i18n.js';
import type { ExchangeLogoId } from './exchange-logos.js';
import type { PairedPositionPrefill } from './route-shared.js';

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
  /** Shown only when `autoSizing` is on. */
  autoOnly?: boolean;
  /** Shown only when `autoSizing` is off (legacy manual mode). */
  manualOnly?: boolean;
}

interface SelectDef {
  key: keyof FundingArbSettings;
  label: string;
  options: Array<{ value: string; label: string }>;
  help?: Help;
  manualOnly?: boolean;
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
      { key: 'minNetPerSettlementBps', label: 'Min funding per wave', unit: 'bps', help: { en: 'Gross funding collected in one settlement wave, before fees.', zh: '单次结算实际收到的资金费（未扣手续费），低于该值不开。' } },
      { key: 'minTradeNetBps', label: 'Min net per trade', unit: 'bps', help: { en: 'Funding over the minimum holding window minus the 27.2 bps round trip.', zh: '按最短持有窗口估算的 funding 减去往返 27.2bps 手续费后，至少还剩多少 bps。' } },
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
      { key: 'scanIntervalMinutes', label: 'Scan interval', unit: 'min', help: { en: 'Clock-aligned scan cadence (default 10 min at :30).', zh: '扫描间隔，默认 10 分钟；缩短后对机会变化更敏感。' } },
      { key: 'confirmScans', label: 'Entry confirmations', help: { en: 'Consecutive scans a candidate must pass; restart confirmation is replayed from funding history.', zh: '候选需连续通过几次扫描；重启后会用历史结算费率回放，不需要等待。' } },
    ],
  },
  {
    title: 'Sizing & leverage',
    hint: { en: 'Auto mode: enter only the planned position count. Equity × (1 − buffer) is split across the remaining slots, and each leg uses its own venue maximum leverage.', zh: '自动模式只需填预计开仓位数：账户权益 × (1 − 缓冲) 按剩余空位均分，两腿各自使用本交易所最大杠杆。' },
    selects: [{
      key: 'leverageMode',
      label: 'Leverage mode',
      manualOnly: true,
      options: [
        { value: 'max', label: 'Max available' },
        { value: 'fixed', label: 'Fixed' },
      ],
      help: { en: 'Manual mode only; auto mode always uses each leg’s own maximum.', zh: '仅手动模式使用；自动模式固定为两腿各自最大杠杆。' },
    }],
    fields: [
      { key: 'autoSizing', label: 'Auto sizing', kind: 'toggle', help: { en: 'One input (planned positions); all caps and leverage are derived automatically.', zh: '只填预计开仓位数，其余上限和杠杆全部自动计算。' } },
      { key: 'maxConcurrent', label: 'Planned positions', help: { en: 'Expected concurrent positions; the budget is divided by the remaining empty slots.', zh: '预计同时开仓位数；预算按剩余空位均分。' } },
      { key: 'sizingBufferPct', label: 'Cash buffer', unit: '0-1', autoOnly: true, help: { en: '0.10 keeps 10% of equity unencumbered (default 90% usage).', zh: '0.10=保留 10% 权益做缓冲（默认 90% 资金占用）。' } },
      { key: 'maxPerTradeUsd', label: 'Max per trade', unit: 'USD', manualOnly: true, help: { en: 'Manual mode hard per-position notional cap.', zh: '手动模式单笔名义本金硬上限。' } },
      { key: 'maxTotalExposureUsd', label: 'Max total exposure', unit: 'USD', manualOnly: true, help: { en: 'Manual mode sum of all automatic positions.', zh: '手动模式所有自动仓位名义本金合计上限。' } },
      { key: 'maxEntriesPerDay', label: 'Max entries / day', manualOnly: true, help: { en: 'Manual mode new positions per UTC day; auto uses 2 × planned positions.', zh: '手动模式每日新开仓上限；自动模式为预计开仓位数 × 2。' } },
      { key: 'maxLeverage', label: 'Max leverage', unit: 'x', manualOnly: true, help: { en: 'Manual mode ceiling; auto uses each venue tier ceiling.', zh: '手动模式杠杆硬上限；自动模式使用各交易所品种上限。' } },
      { key: 'fixedLeverage', label: 'Fixed leverage', unit: 'x', manualOnly: true, help: { en: 'Used when manual mode is fixed.', zh: '手动固定杠杆模式使用。' } },
      { key: 'safetyFactor', label: 'Safety factor', unit: '0-1', manualOnly: true, help: { en: 'Manual mode share of margin the formula may use.', zh: '手动模式计算仓位时可用保证金比例。' } },
      { key: 'marginHeadroomPct', label: 'Margin headroom', unit: '0-1', manualOnly: true, help: { en: 'Manual mode extra margin kept aside.', zh: '手动模式额外预留保证金。' } },
      { key: 'maxMarginPerVenueUsd', label: 'Max margin per venue', unit: 'USD', manualOnly: true, help: { en: 'Manual mode optional per-leg venue cap (0 = off).', zh: '手动模式单腿交易所保证金上限（0=关闭）。' } },
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
      { key: 'recurring', label: 'Recurring strategy', kind: 'toggle', help: { en: 'After a funding exit, keep this opportunity armed and re-enter when the edge recovers; stop-loss stays terminal.', zh: '因资金费率衰减平仓后不关闭策略，费率恢复时自动重新入场；止损仍会终止策略。' } },
      { key: 'recurringCooldownSeconds', label: 'Recurring cooldown', unit: 's', help: { en: 'Quiet period after a recurring exit before re-entry is evaluated.', zh: '循环平仓后等待多久才允许再次入场。' } },
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

/**
 * Operator-facing threshold presets. The runner used to default to 2000% APR, which in practice
 * produced no live candidates; these trade a little selectivity for actual flow, while the
 * stop-loss, pair-cooldown, guard and sizing rules stay in force.
 */
const THRESHOLD_PRESETS: Array<{
  id: string;
  label: string;
  hint: string;
  patch: Partial<FundingArbSettings>;
}> = [
  {
    id: 'conservative',
    label: 'Conservative',
    hint: 'The hard APR gate stays at 2000%; persistence and two confirmations slow entries down.',
    patch: {
      minAprPercent: 2000, minNetPerSettlementBps: 20, minTradeNetBps: 20,
      fundingPersistenceMode: '24h', confirmScans: 2, scanIntervalMinutes: 30,
      maxCurrentTo24hRatio: 3, max24hTo7dRatio: 3,
    },
  },
  {
    id: 'balanced',
    label: 'Balanced',
    hint: 'Same APR gate; one confirmation and a 10-minute scan react faster.',
    patch: {
      minAprPercent: 2000, minNetPerSettlementBps: 10, minTradeNetBps: 10,
      fundingPersistenceMode: '24h', confirmScans: 1, scanIntervalMinutes: 10,
      maxCurrentTo24hRatio: 4, max24hTo7dRatio: 3,
    },
  },
  {
    id: 'opportunity',
    label: 'Fast / more opportunities',
    hint: 'Same APR gate; current snapshot, one confirmation, 5-minute scans. Stop-loss and guards still apply.',
    patch: {
      minAprPercent: 2000, minNetPerSettlementBps: 5, minTradeNetBps: 5,
      fundingPersistenceMode: 'off', confirmScans: 1, scanIntervalMinutes: 5,
      maxCurrentTo24hRatio: 5, max24hTo7dRatio: 5,
    },
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
  DUPLICATE_ASSET: '同资产已有仓位或已选最优机会',
  BLACKLISTED: '黑名单',
  CONNECTION_UNHEALTHY: '连接异常',
  LIVE_LOCKED: '非实盘模式',
  ACCOUNT_MISSING: '未配置账户',
  DATA_ANOMALY: '数据异常',
  CONFIRMATION_PENDING: '等待下一次确认',
  FUNDING_PERSISTENCE: '费率持续性不足',
  FUNDING_SPIKE: '费率尖峰',
  DAILY_LOSS_LIMIT: '触发日亏熔断',
  COST_NOT_COVERED: '净收益不足以覆盖手续费',
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

export function FundingArbPanel({ onOpenModeDialog, onOpenPairedPosition }: {
  onOpenModeDialog?: () => void;
  onOpenPairedPosition?: (prefill: PairedPositionPrefill) => void;
}) {
  const { t, language } = useLanguage();
  const [status, setStatus] = useState<FundingArbStatusResponse | null>(null);
  const [draft, setDraft] = useState<FundingArbSettings | null>(null);
  const [decisions, setDecisions] = useState<FundingArbDecision[]>([]);
  const [trades, setTrades] = useState<FundingArbDryRunTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [candidateFilter, setCandidateFilter] = useState<'all' | 'PASS' | 'REJECT'>('all');
  const [tab, setTab] = useState<'candidates' | 'trades' | 'audit'>('candidates');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<FundingArbCandidate | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(20);
  const refreshing = useRef(false);
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
    if (refreshing.current) return;
    refreshing.current = true;
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
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  const save = useCallback(async (patch: Partial<FundingArbSettings>) => {
    // Keep the draft marked dirty while the write is in flight: a concurrent 20s status poll must
    // not overwrite the operator's edits with the pre-save row. It only becomes clean once the
    // backend has acknowledged the write.
    draftDirty.current = true;
    setBusy(true);
    setSaveState('saving');
    try {
      const next = await api.saveFundingArbSettings(patch);
      draftDirty.current = false;
      setStatus(next);
      setDraft(next.settings);
      setError(null);
      setSaveState('saved');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaveState('error');
    } finally {
      setBusy(false);
    }
  }, []);



  const updateDraft = (key: keyof FundingArbSettings, value: string) => {
    if (!draft) return;
    draftDirty.current = true;
    setSaveState('idle');
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
    .slice(0, visibleLimit), [candidates, candidateFilter, visibleLimit]);
  const filteredTotal = useMemo(() => candidates
    .filter((candidate) => candidateFilter === 'all' || candidate.verdict === candidateFilter).length,
  [candidates, candidateFilter]);
  const totalCandidates = status?.lastResult?.candidateCount ?? candidates.length;
  const passCount = status?.lastResult?.passCount ?? candidates.filter((candidate) => candidate.verdict === 'PASS').length;
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
    <section className="funding-arb-panel terminal-panel" aria-label={t('Automatic funding arbitrage')}>
      <header className="fa-head">
        <div className="fa-title">
          <p className="eyebrow">{t('Perp ⇄ perp · automatic')}</p>
          <h2>{t('Funding arbitrage runner')}</h2>
        </div>
        <div className="fa-head-actions">
          <span className={`fa-state ${running ? 'on' : ''}`} role="status">
            <i />{running ? t('Running') : t('Stopped')}
          </span>
          {running ? (
            <button type="button" className="funding-arb-btn compact" disabled={busy} onClick={() => void save({ enabled: false })}>
              ■ {t('Stop monitoring')}
            </button>
          ) : (
            <button type="button" className="funding-arb-btn primary compact" disabled={busy} onClick={() => void save({ enabled: true })}>
              ▶ {t('Start monitoring')}
            </button>
          )}
          <button type="button" className="funding-arb-btn compact" disabled={busy} onClick={() => {
            setBusy(true);
            void api.scanFundingArb().then((next) => { setStatus(next); setBusy(false); })
              .catch((caught: unknown) => { setBusy(false); setError(caught instanceof Error ? caught.message : String(caught)); });
          }}>⟳ {t('Scan now')}</button>
          <button type="button" className="funding-arb-btn compact" onClick={() => setSettingsOpen(true)}>
            ⚙ {t('Settings')}
          </button>
          <button type="button" className="funding-arb-btn danger compact" disabled={busy} onClick={() => {
            if (!window.confirm(t('Emergency stop disables monitoring and auto-execute. Continue?'))) return;
            void save({ enabled: false, autoExecute: false });
          }}>⛔ {t('Emergency stop')}</button>
        </div>
      </header>

      {error && <p className="funding-arb-error" role="alert">{error}</p>}

      <div className="fa-overview">
        <div className="fa-stats">
          <div className="fa-stat">
            <span>{t('Last scan')}</span>
            <strong>{status?.lastScanAt ? new Date(status.lastScanAt).toLocaleTimeString() : t('Never scanned')}</strong>
            <small>{status?.nextScanAt ? `${t('Next scan')} ${new Date(status.nextScanAt).toLocaleTimeString()}` : '—'}</small>
          </div>
          <div className="fa-stat">
            <span>{t('Pass / candidates')}</span>
            <strong>{passCount}<em> / {totalCandidates}</em></strong>
            <small className={status?.lastResult && !status.lastResult.dataFresh ? 'warn' : ''}>
              {status?.lastResult ? (status.lastResult.dataFresh ? t('Data fresh') : t('Data stale')) : t('No scan yet')}
            </small>
          </div>
          <div className="fa-stat">
            <span>{t('Mode')}</span>
            <strong className={dryRun ? 'ok' : 'warn'}>{dryRun ? t('Dry run') : t('Live mode')}</strong>
            <small>{autoExecute ? t('Auto-execute on') : t('Auto-execute off')}</small>
          </div>
          <div className="fa-stat">
            <span>{t('Key thresholds')}</span>
            <strong>{settings?.minAprPercent ?? '—'}<em>%</em></strong>
            <small>{t('Min wave')} {settings?.minNetPerSettlementBps ?? '—'} bps · {t('Net / trade')} {settings?.minTradeNetBps ?? '—'} bps</small>
          </div>
        </div>

        <div className="fa-control" role="group" aria-label={t('Runner switches')}>
          <div className="fa-segmented">
            <button type="button" className={dryRun ? 'seg on' : 'seg off'} onClick={askDryRun} title={t('Click to toggle dry run')}>
              <span>{t('Dry run')}</span><em>{dryRun ? t('On') : t('Off')}</em>
            </button>
            <button type="button" className={autoExecute ? 'seg on' : 'seg off'} onClick={askAutoExecute} title={t('Click to toggle auto-execute')}>
              <span>{t('Auto-execute')}</span><em>{autoExecute ? t('On') : t('Off')}</em>
            </button>
            <button type="button" className={exchangeLive ? 'seg on' : 'seg off'} onClick={() => onOpenModeDialog?.()} title={t('Switch trading mode')}>
              <span>{t('Exchange')}</span><em>{exchangeLive ? t('Live') : t('Read-only')}</em>
            </button>
          </div>
          <div className="fa-badges">
            <span className={dryRun ? 'badge safe' : 'badge risk'}>{dryRun ? t('No real orders') : t('Real orders possible')}</span>
            <span className={autoExecute ? 'badge safe' : 'badge'}>{autoExecute ? t('Auto opening positions') : t('Records only')}</span>
            <span className={exchangeLive ? 'badge safe' : 'badge risk'}>{exchangeLive ? t('Orders allowed') : t('Orders blocked')}</span>
          </div>
        </div>
      </div>

      <div className="fa-workspace">
        <div className="fa-tabs" role="tablist" aria-label={t('Funding arbitrage views')}>
          <button role="tab" aria-selected={tab === 'candidates'} className={tab === 'candidates' ? 'active' : ''} onClick={() => setTab('candidates')}>
            {t('Candidates')} <span>{totalCandidates}</span>
          </button>
          <button role="tab" aria-selected={tab === 'trades'} className={tab === 'trades' ? 'active' : ''} onClick={() => setTab('trades')}>
            {t('Dry-run trades')} <span>{trades.length}</span>
          </button>
          <button role="tab" aria-selected={tab === 'audit'} className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>
            {t('Audit trail')} <span>{decisions.length}</span>
          </button>
        </div>

        {tab === 'candidates' && (
          <div className="fa-tabbody">
            <div className="fa-toolbar">
              <div className="funding-arb-filter" role="group" aria-label={t('Candidate filter')}>
                {(['all', 'PASS', 'REJECT'] as const).map((filter) => (
                  <button key={filter} className={candidateFilter === filter ? 'active' : ''} onClick={() => { setCandidateFilter(filter); setVisibleLimit(20); }}>
                    {filter === 'all' ? t('All') : filter === 'PASS' ? t('Pass') : t('Reject')}
                  </button>
                ))}
              </div>
              <small className="fa-muted">{t('Showing top')} {filteredCandidates.length} / {filteredTotal}</small>
            </div>
            <div className="funding-arb-table-wrap">
              <table className="funding-arb-table fa-candidate-table">
                <thead>
                  <tr>
                    <th>{t('Asset')}</th><th>{t('Short / long')}</th><th>{t('APR')}</th>
                    <th>{t('Entry bps')}</th><th>{t('Notional')}</th><th>{t('To settlement')}</th>
                    <th>{t('Verdict')}</th><th>{t('Reasons')}</th><th>{t('Action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCandidates.map((candidate) => {
                    const expanded = selectedCandidate?.key === candidate.key;
                    return [
                      <tr key={candidate.key}
                        className={`fa-candidate-row${expanded ? ' expanded' : ''}`}
                        onClick={() => setSelectedCandidate(expanded ? null : candidate)}>
                        <td><span className="fa-caret">{expanded ? '▾' : '▸'}</span><strong>{candidate.asset}</strong></td>
                        <td>{candidate.shortVenue} / {candidate.longVenue}</td>
                        <td>{candidate.aprPercent.toFixed(0)}%</td>
                        <td>{candidate.entryBps ?? '—'}</td>
                        <td>{candidate.notionalUsd === null ? '—' : `$${candidate.notionalUsd.toFixed(0)}`}</td>
                        <td>{formatMs(candidate.settlementInMs)}</td>
                        <td><span className={candidate.verdict === 'PASS' ? 'funding-arb-pass' : 'funding-arb-reject'}>{t(candidate.verdict === 'PASS' ? 'Pass' : 'Reject')}</span></td>
                        <td className="funding-arb-reasons">{candidate.reasons.length === 0 ? '—' : candidate.reasons.map((reason) => reasonLabel(reason, language)).join('、')}</td>
                        <td>
                          <button type="button" className="funding-arb-btn primary"
                            disabled={!onOpenPairedPosition}
                            title={candidate.verdict === 'PASS' ? t('Open the pre-filled strategy form') : t('Review the rejection reasons before executing')}
                            onClick={(event) => {
                              event.stopPropagation();
                              onOpenPairedPosition?.({
                                asset: candidate.asset,
                                shortVenue: candidate.shortVenue.toLowerCase() as ExchangeLogoId,
                                longVenue: candidate.longVenue.toLowerCase() as ExchangeLogoId,
                                recurring: true,
                                recurringFundingAprMin: 2000,
                              });
                            }}>
                            {t('Execute')}
                          </button>
                        </td>
                      </tr>,
                      expanded ? (
                        <tr key={`${candidate.key}-detail`} className="fa-candidate-detail">
                          <td colSpan={9}>
                            <div className="fa-detail-grid">
                              <div><span>{t('Candidate')}</span><strong>{candidate.key}</strong></div>
                              <div><span>{t('Short leg')}</span><strong>{candidate.shortVenue} · {candidate.shortSymbol}</strong><small>{candidate.shortIntervalHours ?? '—'}h · rate8h {candidate.shortRate8h}</small></div>
                              <div><span>{t('Long leg')}</span><strong>{candidate.longVenue} · {candidate.longSymbol}</strong><small>{candidate.longIntervalHours ?? '—'}h · rate8h {candidate.longRate8h}</small></div>
                              <div><span>{t('Net 8h')}</span><strong>{candidate.net8h}</strong><small>{t('APR')} {candidate.aprPercent.toFixed(1)}%</small></div>
                              <div><span>{t('Sizing')}</span><strong>{candidate.notionalUsd === null ? '—' : `$${candidate.notionalUsd.toFixed(2)}`}</strong><small>{t('Qty')} {candidate.quantity ?? '—'} · {t('Leverage')} {candidate.leverage ?? '—'}x</small></div>
                              <div><span>{t('Settlement')}</span><strong>{formatMs(candidate.settlementInMs)}</strong><small>{candidate.shortNextFundingAt ?? '—'} / {candidate.longNextFundingAt ?? '—'}</small></div>
                              <div className="wide"><span>{t('Reasons')}</span><strong>{candidate.reasons.length === 0 ? '—' : candidate.reasons.map((reason) => reasonLabel(reason, language)).join('、')}</strong></div>
                            </div>
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })}
                  {filteredCandidates.length === 0 && <tr><td colSpan={9} className="funding-arb-empty">{t('No scan yet — press “Scan now”.')}</td></tr>}
                </tbody>
              </table>
            </div>
            {filteredCandidates.length < filteredTotal && (
              <div className="fa-loadmore">
                <button type="button" className="funding-arb-btn" onClick={() => setVisibleLimit((value) => value + 40)}>{t('Load more')}</button>
              </div>
            )}
          </div>
        )}


        {tab === 'trades' && (
          <div className="fa-tabbody">
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
                      <td><strong>{trade.asset}</strong></td>
                      <td>{trade.shortVenue} / {trade.longVenue}</td>
                      <td>${trade.notionalUsd.toFixed(0)}</td>
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
        )}

        {tab === 'audit' && (
          <div className="fa-tabbody">
            <ul className="fa-audit">
              {decisions.slice(0, 40).map((decision) => (
                <li key={decision.id}>
                  <time dateTime={decision.scannedAt}>{new Date(decision.scannedAt).toLocaleTimeString()}</time>
                  <strong>{decision.candidateKey}</strong>
                  <span className={decision.verdict === 'PASS' ? 'funding-arb-pass' : 'funding-arb-reject'}>{t(decision.verdict === 'PASS' ? 'Pass' : 'Reject')}</span>
                  <span>{decision.reasons.map((reason) => reasonLabel(reason, language)).join('、')}</span>
                  {decision.strategyId && <code>{decision.strategyId}</code>}
                </li>
              ))}
              {decisions.length === 0 && <li className="funding-arb-empty">{t('No decisions yet.')}</li>}
            </ul>
          </div>
        )}
      </div>

      {settingsOpen && (
        <div className="fa-drawer-backdrop" onClick={() => setSettingsOpen(false)}>
          <aside className="fa-drawer" role="dialog" aria-modal="true" aria-label={t('Settings')} onClick={(event) => event.stopPropagation()}>
            <header className="fa-drawer-head">
              <div><p className="eyebrow">{t('Funding arbitrage runner')}</p><h3>{t('Settings')}</h3></div>
              <button type="button" className="fa-icon-btn" aria-label={t('Close')} onClick={() => setSettingsOpen(false)}>✕</button>
            </header>
            <div className="fa-drawer-body">
              <details className="funding-arb-guide">
                <summary>{t('How to use this panel')}</summary>
                <ol>
                  {(language === 'zh' ? [
                    '1. 点「开始监测」：执行器按设定间隔扫描；默认「干跑」只记决策与虚拟成交，不下单。',
                    '2. 「立即扫描」会强制拉取一轮最新行情；候选表只显示前 60 条，完整审计在「审计」页。',
                    '3. 实盘：交易所切 live → 关闭干跑 → 打开自动执行并确认。',
                    '4. 参数改完点底部「保存参数」；只有点保存才会落库。',
                  ] : [
                    '1. Start monitoring: the runner scans on schedule; dry run records decisions only.',
                    '2. Scan now forces a fresh venue sweep; the table shows the top 60, the Audit tab has the rest.',
                    '3. For live orders: exchange live → dry run off → auto-execute on and confirm.',
                    '4. Edit parameters, then press Save at the bottom; only Save persists them.',
                  ]).map((step) => <li key={step}>{step}</li>)}
                </ol>
              </details>

              <section className="fa-threshold-presets" aria-label={t('Threshold presets')}>
                <div>
                  <strong>{t('Threshold presets')}</strong>
                  <small>{t('Apply a preset to the draft, then press Save parameters.')}</small>
                </div>
                <div className="fa-preset-row">
                  {THRESHOLD_PRESETS.map((preset) => (
                    <button key={preset.id} type="button" className="funding-arb-btn" disabled={busy || !draft}
                      title={preset.hint}
                      onClick={() => {
                        draftDirty.current = true;
                        setSaveState('idle');
                        setDraft((current) => (current ? { ...current, ...preset.patch } : current));
                      }}>
                      {t(preset.label)}
                    </button>
                  ))}
                </div>
              </section>

              {draft && GROUPS.map((group, index) => (
                <details key={group.title} className="funding-arb-group" open={index === 0}>
                  <summary>
                    <span>{t(group.title)}</span>
                    <small>{hint(group.hint)}</small>
                  </summary>
                  <div className="funding-arb-group-body">
                    {group.selects?.filter((select) => !select.manualOnly || !draft.autoSizing).map((select) => (
                      <label key={String(select.key)} className="funding-arb-field" title={hint(select.help)}>
                        <span>{t(select.label)}</span>
                        <select value={String(draft[select.key] ?? '')} disabled={busy}
                          onChange={(event) => {
                            draftDirty.current = true;
                            setSaveState('idle');
                            setDraft({ ...draft, [select.key]: event.target.value } as FundingArbSettings);
                          }}>
                          {select.options.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
                        </select>
                        <small>{hint(select.help)}</small>
                      </label>
                    ))}
                    {group.fields.filter((field) => (field.autoOnly ? draft.autoSizing : true)
                      && (field.manualOnly ? !draft.autoSizing : true)).map((field) => field.kind === 'toggle' ? (
                      <label key={String(field.key)} className="funding-arb-field toggle" title={hint(field.help)}>
                        <span>{t(field.label)}</span>
                        <input type="checkbox" checked={Boolean(draft[field.key])} disabled={busy}
                          onChange={(event) => {
                            draftDirty.current = true;
                            setSaveState('idle');
                            setDraft({ ...draft, [field.key]: event.target.checked } as FundingArbSettings);
                          }} />
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
            </div>
            <footer className="fa-drawer-foot">
              <span className={`funding-arb-save-state ${saveState}`} role="status">
                {saveState === 'saving' ? t('Saving…') : saveState === 'saved' ? t('Saved') : saveState === 'error' ? t('Save failed') : t('Click Save to apply')}
              </span>
              <div>
                <button type="button" className="funding-arb-btn" disabled={busy} onClick={() => { draftDirty.current = false; setDraft(status?.settings ?? draft ?? null); setSaveState('idle'); }}>{t('Discard changes')}</button>
                <button type="button" className="funding-arb-btn primary" disabled={busy} onClick={() => draft && void save(draft)}>{t('Save parameters')}</button>
              </div>
            </footer>
          </aside>
        </div>
      )}

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
