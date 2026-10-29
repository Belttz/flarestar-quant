import type Database from 'better-sqlite3';
import type {
  CrossExInstrument,
  FundingArbCandidate,
  FundingArbScanResponse,
  FundingArbSettings,
  FundingArbStatusResponse,
  FundingOverviewResponse,
  LiveBalance,
  LiveMarket,
  MarketCatalogVenue,
  PortfolioFuturesPosition,
  StrategyRecord,
} from '@gate-crossex/shared-types';
import {
  autoSizingBudget,
  buildFundingArbCandidates,
  dynamicEntryBps,
  executableEntrySpreadBps,
  perSettlementFundingBps,
  roundTripCostBps,
  settlementInMs,
  sizePerpHedge,
  type FundingArbAutoBudget,
} from './funding-arb-scan.js';
import { readFundingArbSettings } from './funding-arb-repository.js';
import {
  annualizeWindow, latestSettledRate, loadFundingPersistence, type FundingPersistenceRow,
} from './funding-arb-persistence.js';
import {
  closeFundingArbDryRunTrade,
  insertFundingArbDecision,
  insertFundingArbDryRunTrade,
  listOpenFundingArbDryRunTrades,
} from './funding-arb-repository.js';

/**
 * Automatic perp ⇄ perp funding-rate arbitrage runner.
 *
 * The user-facing flow it automates is the Funding page's hedge board: short the higher-funding
 * venue, long the lower-funding one, hold through the funding settlement. A scan rebuilds that
 * board server-side, gates every pair (APR, freshness, settlement window, instruments, margin,
 * dedupe/cooldown/limits), sizes the hedge from available margin × leverage, and either records
 * the decision only (dry-run) or launches the paired position strategy with the engine's maker
 * entry logic (one leg maker, one leg taker).
 *
 * The loop is deliberately separate from the 500 ms strategy tick: it runs on a clock-aligned
 * cadence (default 10 min, anchored at :30) and does no work while the switch is off.
 */

const DEFAULT_TAKER_FEE_BPS = 4.8;
const DEFAULT_SLIPPAGE_BPS = 2;
const SETTLEMENT_TOO_CLOSE_MS = 2 * 60_000;
/** Rows included in the polled status payload; full scan stays in memory and /decisions. */
const STATUS_CANDIDATE_LIMIT = 60;
const DATA_STALE_MS = 90_000;
const SETTLEMENT_QUANTUM_MS = 30 * 60_000;
const SETTLEMENT_OFFSET_MS = 30 * 60_000;

export interface FundingArbMonitorDeps {
  database: Database.Database;
  now?: () => number;
  fundingOverview: {
    ensureFresh(force?: boolean): Promise<void>;
    buildResponse(catalog: { assets: ReadonlyMap<string, MarketCatalogVenue[]> }): FundingOverviewResponse;
  };
  catalog: () => { assets: ReadonlyMap<string, MarketCatalogVenue[]> } | null;
  market: (symbol: string) => LiveMarket | null;
  orderBook?: (symbol: string) => { bids: ReadonlyArray<readonly [string, string]>; asks: ReadonlyArray<readonly [string, string]> } | null;
  balances: () => LiveBalance[];
  instruments: () => Map<string, CrossExInstrument>;
  leverageMax: (symbol: string) => number | null;
  strategies: () => StrategyRecord[];
  startStrategy: (input: unknown, account: { profileId: string; label: string }) => Promise<StrategyRecord>;
  stopStrategy: (id: string) => Promise<unknown>;
  /** Current venue positions (used by the ADL / orphan guardian). */
  positions?: () => Promise<PortfolioFuturesPosition[]>;
  /** Count of open/in-flight orders for one strategy (guardian de-duplication). */
  openOrders?: (strategyId: string) => number;
  /** Submit a reduce-only market order for one leg (guardian closes). */
  closePosition?: (input: {
    symbol: string; side: 'BUY' | 'SELL'; quantity: string;
    positionSide: 'NONE' | 'LONG' | 'SHORT'; reduceOnly: boolean;
  }) => Promise<unknown>;
  account: () => { profileId: string; label: string } | null;
  liveTradingEnabled: () => boolean;
  connectionState?: () => string;
  warn?: (message: string, detail?: Record<string, unknown>) => void;
}

interface ScanContext {
  settings: FundingArbSettings;
  now: number;
  instruments: Map<string, CrossExInstrument>;
  strategies: StrategyRecord[];
  availableMarginUsd: number;
  /** Account equity used by auto sizing. */
  equityMarginUsd: number;
  /** Margin currently locked by positions/orders, derived as equity - available. */
  usedMarginUsd: number;
  /** Populated only while `settings.autoSizing` is on. */
  autoBudget: FundingArbAutoBudget | null;
  /** Realised funding over trailing 24h/7d, keyed by executable symbol. */
  persistence: Map<string, FundingPersistenceRow>;
  /** Realized PnL of our automatic strategies closed since 00:00 UTC. */
  dailyPnlUsd: number;
  liveTradingEnabled: boolean;
  connectionHealthy: boolean;
}

export class FundingArbMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private guardianTimer: ReturnType<typeof setInterval> | null = null;
  private readonly orphanSince = new Map<string, number>();
  private readonly adlReduced = new Set<string>();
  private runningLoop = false;
  private lastScanAt: string | null = null;
  private nextScanAt: string | null = null;
  private scans = 0;
  private lastError: string | null = null;
  private lastResult: FundingArbScanResponse | null = null;
  private readonly autoStrategyIds = new Map<string, string>();
  private readonly dryRunOpen = new Map<string, {
    candidate: FundingArbCandidate;
    notionalUsd: number;
    enteredAt: number;
    lastAt: number;
    fundingUsd: number;
    belowSince: number | null;
  }>();
  /** Candidate keys that passed every fundamental gate on the previous scan (entry confirmation). */
  private lastPassKeys = new Set<string>();

  constructor(private readonly deps: FundingArbMonitorDeps) {}

  /** Start the clock-aligned scan loop. Idempotent; does nothing when a loop is already running. */
  startBackground(): void {
    if (this.runningLoop) return;
    this.runningLoop = true;
    this.hydrateDryRunTrades();
    this.scheduleNext();
    this.guardianTimer = setInterval(() => { void this.runGuardian(); }, 60_000);
    this.guardianTimer.unref?.();
  }

  /** Restore open dry-run positions after a restart: the snapshot is the dry-run trade table. */
  private hydrateDryRunTrades(): void {
    for (const { trade, candidate } of listOpenFundingArbDryRunTrades(this.deps.database)) {
      if (this.dryRunOpen.has(trade.id)) continue;
      this.dryRunOpen.set(trade.id, {
        candidate,
        notionalUsd: trade.notionalUsd,
        enteredAt: Date.parse(trade.enteredAt),
        lastAt: Date.parse(trade.enteredAt),
        fundingUsd: trade.fundingUsd,
        belowSince: null,
      });
    }
  }

  stopBackground(): void {
    this.runningLoop = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.guardianTimer) clearInterval(this.guardianTimer);
    this.guardianTimer = null;
    this.orphanSince.clear();
    this.nextScanAt = null;
  }

  get isRunning(): boolean {
    return this.runningLoop;
  }

  /** One manual scan, used by the panel's "scan now" action and by the loop. */
  async runOnce(options: { manual?: boolean } = {}): Promise<FundingArbScanResponse | null> {
    const settings = readFundingArbSettings(this.deps.database);
    if (!settings.enabled && !options.manual) return this.lastResult;
    const now = this.deps.now?.() ?? Date.now();
    this.scans += 1;
    this.lastScanAt = new Date(now).toISOString();
    try {
      const result = await this.scan(settings, now, options.manual === true);
      this.lastResult = result;
      this.lastError = null;
      this.updateDryRunTrades(now);
      return result;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.deps.warn?.('funding arb scan failed', { reason: this.lastError });
      return this.lastResult;
    } finally {
      this.nextScanAt = new Date(this.nextScanBoundary(now, settings.scanIntervalMinutes)).toISOString();
    }
  }

  status(): FundingArbStatusResponse {
    const settings = readFundingArbSettings(this.deps.database);
    // The scan keeps every candidate in memory for auditing, but the status payload is fetched
    // every 20s by the panel: serialising all ~7k rows made each poll multiple megabytes. Return
    // the head of the ranked list plus the true totals; the audit tab reads /decisions.
    const lastResult = this.lastResult
      ? {
          ...this.lastResult,
          candidates: this.lastResult.candidates.slice(0, STATUS_CANDIDATE_LIMIT),
          candidateCount: this.lastResult.candidates.length,
          passCount: this.lastResult.candidates.filter((candidate) => candidate.verdict === 'PASS').length,
        }
      : null;
    return {
      settings,
      running: this.runningLoop,
      liveTradingEnabled: this.deps.liveTradingEnabled(),
      lastScanAt: this.lastScanAt,
      nextScanAt: this.nextScanAt,
      scans: this.scans,
      lastError: this.lastError,
      lastResult,
    };
  }

  private scheduleNext(): void {
    if (!this.runningLoop) return;
    const settings = readFundingArbSettings(this.deps.database);
    const now = this.deps.now?.() ?? Date.now();
    const target = this.nextScanBoundary(now, settings.scanIntervalMinutes);
    this.nextScanAt = new Date(target).toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() => this.scheduleNext());
    }, Math.max(1_000, target - now));
    this.timer.unref?.();
  }

  /**
   * Next scan boundary: the interval grid anchored at :30, so a 60-minute cadence lands on
   * hh:30 — 30 minutes before the next UTC settlement, which covers the 1h/4h/8h venues.
   */
  private nextScanBoundary(now: number, intervalMinutes: number): number {
    const interval = Math.max(5, Math.min(1440, Math.trunc(intervalMinutes))) * 60_000;
    const anchor = SETTLEMENT_OFFSET_MS % interval;
    const progress = ((now - anchor) % interval + interval) % interval;
    const base = now - progress + interval + anchor;
    return base % SETTLEMENT_QUANTUM_MS === anchor ? base : base;
  }

  private async scan(settings: FundingArbSettings, now: number, forceRefresh = false): Promise<FundingArbScanResponse> {
    const catalog = this.deps.catalog();
    if (!catalog) throw new Error('market catalog unavailable');
    await this.deps.fundingOverview.ensureFresh(forceRefresh);
    const overview = this.deps.fundingOverview.buildResponse(catalog);
    const dataFresh = overview.cacheStatus === 'fresh';
    const candidates = buildFundingArbCandidates(overview, settings.venueWhitelist);

    const strategies = this.deps.strategies();
    const availableMarginUsd = this.availableMarginUsd();
    const equityMarginUsd = this.marginBalanceUsd() || availableMarginUsd;
    const usedMarginUsd = Math.max(0, equityMarginUsd - availableMarginUsd);
    const context: ScanContext = {
      settings,
      now,
      instruments: this.deps.instruments(),
      strategies,
      availableMarginUsd,
      equityMarginUsd,
      usedMarginUsd,
      autoBudget: null,
      persistence: loadFundingPersistence(this.deps.database, now),
      dailyPnlUsd: this.realizedTodayUsd(strategies, now),
      liveTradingEnabled: this.deps.liveTradingEnabled(),
      connectionHealthy: this.connectionHealthy(),
    };
    if (settings.autoSizing) {
      context.autoBudget = autoSizingBudget({
        equityUsd: equityMarginUsd,
        availableMarginUsd,
        usedMarginUsd,
        plannedPositions: settings.maxConcurrent,
        openPositions: this.openOurStrategies(context).length,
        bufferPct: settings.sizingBufferPct,
      });
    }

    const scannedAt = new Date(now).toISOString();
    const evaluated: FundingArbCandidate[] = [];
    const passRows: FundingArbCandidate[] = [];
    const fundamentalPassKeys = new Set<string>();

    for (const candidate of candidates) {
      const reasons = this.gate(candidate, context, dataFresh);
      candidate.verdict = reasons.length === 0 ? 'PASS' : 'REJECT';
      candidate.reasons = reasons;
      candidate.score = reasons.length === 0 ? candidate.aprPercent : null;
      // A candidate waiting on entry confirmation still gets priced: the confirmation state must
      // carry into the next scan, and a pair that cannot be sized will never pass anyway.
      const onlyConfirmationPending = reasons.length > 0
        && reasons.every((reason) => reason === 'CONFIRMATION_PENDING');
      if (reasons.length === 0 || onlyConfirmationPending) {
        const priced = this.priceAndSize(candidate, context);
        candidate.entryBps = priced.entryBps;
        candidate.notionalUsd = priced.notionalUsd;
        candidate.quantity = priced.quantity;
        candidate.leverage = priced.leverage;
        candidate.shortLeverage = priced.shortLeverage;
        candidate.longLeverage = priced.longLeverage;
        candidate.settlementInMs = priced.settlementInMs;
        if (priced.reasons.length > 0) {
          candidate.verdict = 'REJECT';
          candidate.reasons = priced.reasons;
          candidate.score = null;
        } else if (settings.fundingPersistenceMode !== 'off') {
          // Rank spikes below persistent pairs: min(current, trailing-24h) removes the part of the
          // current APR that the last day did not actually realise.
          const short = context.persistence.get(candidate.shortSymbol);
          const long = context.persistence.get(candidate.longSymbol);
          if (short && long) {
            const ann24 = annualizeWindow(short.sum24h - long.sum24h, 1);
            candidate.score = Math.min(candidate.aprPercent, ann24);
          }
        }
      }
      evaluated.push(candidate);
      if (candidate.verdict === 'PASS') passRows.push(candidate);
      // Confirmation counts the fundamental gates only: a candidate blocked by the slot cap this
      // scan is still a valid, confirmed opportunity when capacity frees up next scan.
      const fundamentalReasons = candidate.reasons.filter((reason) => reason !== 'CONFIRMATION_PENDING');
      if (fundamentalReasons.length === 0 && candidate.notionalUsd !== null) fundamentalPassKeys.add(candidate.key);
    }
    this.lastPassKeys = fundamentalPassKeys;

    // Launch (or simulate) the best candidates, subject to slot/exposure/daily limits.
    passRows.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
    const opened: FundingArbCandidate[] = [];
    const openedStrategyIds = new Map<string, string>();
    for (const candidate of passRows) {
      if (!this.canOpenMore(candidate, context, opened)) {
        candidate.verdict = 'REJECT';
        candidate.reasons = ['SLOT_LIMIT'];
        candidate.score = null;
        continue;
      }
      if (settings.dryRun || !settings.autoExecute || !settings.enabled) {
        if (settings.dryRun) {
          this.recordDryRunTrade(candidate, context);
          opened.push(candidate);
        }
        continue;
      }
      const strategyId = await this.launch(candidate, context, settings);
      if (strategyId) {
        candidate.reasons = [...candidate.reasons, 'AUTO_OPENED'];
        opened.push(candidate);
        openedStrategyIds.set(candidate.key, strategyId);
        this.autoStrategyIds.set(strategyId, candidate.key);
      }
    }

    // AUDIT: every evaluated candidate of this scan, in one transaction.
    const write = this.deps.database.transaction(() => {
      for (const candidate of evaluated) {
        insertFundingArbDecision(this.deps.database, { candidate, strategyId: openedStrategyIds.get(candidate.key) ?? null, scannedAt });
      }
    });
    write();

    return { settings, scannedAt, dataFresh, candidates: evaluated };
  }

  /**
   * Confirmation replayed from local settled-funding history.
   *
   * Waiting two scan intervals after a restart would waste the best part of the window. Instead the
   * confirmation gate reconstructs the previous scan points from `funding_rate_history` (settled
   * rates, same proxy the replay uses) and accepts the candidate when the differential cleared the
   * threshold at each of those points too. On a cold start with no history it simply falls back to
   * the in-memory previous-scan check.
   */
  private historyConfirmation(candidate: FundingArbCandidate, context: ScanContext): boolean {
    const steps = context.settings.confirmScans - 1;
    if (steps <= 0) return true;
    const stepMs = context.settings.scanIntervalMinutes * 60_000;
    const slackMs = 5 * 60_000;
    for (let k = 1; k <= steps; k += 1) {
      const at = context.now - k * stepMs;
      const short = latestSettledRate(this.deps.database, candidate.shortSymbol, at);
      const long = latestSettledRate(this.deps.database, candidate.longSymbol, at);
      if (!short || !long) return false;
      const shortInterval = candidate.shortIntervalHours ?? 8;
      const longInterval = candidate.longIntervalHours ?? 8;
      if (at - short.time > shortInterval * 3_600_000 + slackMs
        || at - long.time > longInterval * 3_600_000 + slackMs) return false;
      const short8h = short.rate * 8 / Math.max(1, shortInterval);
      const long8h = long.rate * 8 / Math.max(1, longInterval);
      const apr = (short8h - long8h) * 1095 * 100;
      if (apr < context.settings.minAprPercent) return false;
    }
    return true;
  }

  /** Gate every pair: any reason here is a REJECT (the UI renders the codes verbatim). */
  private gate(candidate: FundingArbCandidate, context: ScanContext, dataFresh: boolean): string[] {
    const { settings, now } = context;
    const reasons: string[] = [];
    if (settings.assetBlacklist.some((asset) => asset.toUpperCase() === candidate.asset.toUpperCase())) reasons.push('BLACKLISTED');
    if (!dataFresh) reasons.push('DATA_STALE');
    const fetchedAt = candidate.fetchedAt ? Date.parse(candidate.fetchedAt) : Number.NaN;
    if (!Number.isFinite(fetchedAt) || now - fetchedAt > DATA_STALE_MS) reasons.push('DATA_STALE');
    if (candidate.aprPercent < settings.minAprPercent) reasons.push('APR_BELOW');
    // Per-wave funding is a gross number: the hold runs to the SLOWER leg's next settlement, so a
    // 1h×8h pair collects eight hourly payments while a 1h×1h pair collects one. Fees are a single
    // round trip for the whole trade, so they are checked separately over the minimum holding
    // window instead of being charged against every settlement (that double-count made a 4000%
    // 1h pair fail a 20 bps threshold by ~2 bps).
    const windowHours = Math.max(candidate.shortIntervalHours ?? 8, candidate.longIntervalHours ?? 8, 1);
    const expectedFundingBps = perSettlementFundingBps(candidate.aprPercent) * (windowHours / 8);
    if (settings.minNetPerSettlementBps > 0 && expectedFundingBps < settings.minNetPerSettlementBps) {
      reasons.push('NET_APR_BELOW');
    }
    if (settings.minTradeNetBps > 0) {
      const minHoldWaves = Math.max(1, Math.ceil((settings.minHoldingHours || 1) / windowHours));
      const expectedTradeNetBps = expectedFundingBps * minHoldWaves
        - roundTripCostBps(DEFAULT_TAKER_FEE_BPS, DEFAULT_SLIPPAGE_BPS);
      if (expectedTradeNetBps < settings.minTradeNetBps) reasons.push('COST_NOT_COVERED');
    }
    if (settings.fundingPersistenceMode !== 'off') {
      const short = context.persistence.get(candidate.shortSymbol);
      const long = context.persistence.get(candidate.longSymbol);
      const need7d = settings.fundingPersistenceMode === '24h7d';
      const samplesOk = short !== undefined && long !== undefined
        && short.count24h >= settings.persistenceMinSamples24h
        && long.count24h >= settings.persistenceMinSamples24h
        && (!need7d || (short.count7d >= settings.persistenceMinSamples7d
          && long.count7d >= settings.persistenceMinSamples7d));
      if (!samplesOk) {
        reasons.push('FUNDING_PERSISTENCE');
      } else {
        const net24 = short!.sum24h - long!.sum24h;
        if (net24 <= 0) {
          reasons.push('FUNDING_PERSISTENCE');
        } else {
          const ann24 = annualizeWindow(net24, 1);
          if (candidate.aprPercent > ann24 * settings.maxCurrentTo24hRatio) reasons.push('FUNDING_SPIKE');
          if (need7d) {
            const net7 = short!.sum7d - long!.sum7d;
            const ann7 = annualizeWindow(net7, 7);
            if (net7 <= 0) reasons.push('FUNDING_PERSISTENCE');
            else if (ann24 > ann7 * settings.max24hTo7dRatio) reasons.push('FUNDING_SPIKE');
          }
        }
      }
    }
    if (!Number.isFinite(candidate.aprPercent) || candidate.aprPercent > 100_000) reasons.push('DATA_ANOMALY');
    const settlement = settlementInMs(candidate.shortNextFundingAt, candidate.longNextFundingAt, now);
    if (settlement === null || settlement < SETTLEMENT_TOO_CLOSE_MS) reasons.push('SETTLEMENT_TOO_CLOSE');
    const shortInstrument = context.instruments.get(candidate.shortSymbol);
    const longInstrument = context.instruments.get(candidate.longSymbol);
    if (!shortInstrument || !longInstrument) reasons.push('INSTRUMENT_MISSING');
    else {
      if (shortInstrument.state !== 'live' || longInstrument.state !== 'live') reasons.push('LEG_UNAVAILABLE');
    }
    if (!context.connectionHealthy) reasons.push('CONNECTION_UNHEALTHY');
    if (settings.autoExecute && !context.liveTradingEnabled) reasons.push('LIVE_LOCKED');
    if (this.assetHasOpenStrategy(candidate, context)) reasons.push('DUPLICATE_ASSET');
    if (this.assetInLossCooldown(candidate.asset, context)) reasons.push('PAIR_COOLDOWN');
    if (settings.confirmScans > 1 && !this.lastPassKeys.has(candidate.key)
      && !this.historyConfirmation(candidate, context)) reasons.push('CONFIRMATION_PENDING');
    if (settings.dailyLossLimitFraction > 0
      && context.dailyPnlUsd <= -context.availableMarginUsd * settings.dailyLossLimitFraction) {
      reasons.push('DAILY_LOSS_LIMIT');
    }
    if (this.inCooldown(candidate, context)) reasons.push('COOLDOWN');
    if (this.openOurStrategies(context).length >= settings.maxConcurrent && !this.assetHasOpenStrategy(candidate, context)) reasons.push('SLOT_LIMIT');
    const maxEntries = settings.autoSizing ? settings.maxConcurrent * 2 : settings.maxEntriesPerDay;
    if (this.entriesToday(context) >= maxEntries) reasons.push('DAILY_LIMIT');
    if (!settings.autoSizing && this.currentExposureUsd(context) >= settings.maxTotalExposureUsd) reasons.push('EXPOSURE_LIMIT');
    if (!this.deps.account()) reasons.push('ACCOUNT_MISSING');
    return reasons;
  }

  /**
   * Extra entry-buffer bps from top-of-book depth: if the weaker leg's top level holds less than the
   * planned notional, scale the deficit into the buffer (capped at 50 bps). This is a deliberately
   * cheap proxy for walking the book; the real execution still goes through the engine's taker-depth
   * admission guard, which rejects a clip the book cannot absorb.
   */
  private depthPenaltyBps(candidate: FundingArbCandidate, notionalUsd: number): number {
    const book = this.deps.orderBook;
    if (!book || !(notionalUsd > 0)) return 0;
    const topDepth = (symbol: string, side: 'bid' | 'ask'): number | null => {
      const snapshot = book(symbol);
      if (!snapshot) return null;
      const level = (side === 'bid' ? snapshot.bids : snapshot.asks)[0];
      if (!level) return null;
      const price = Number(level[0]);
      const size = Number(level[1]);
      return Number.isFinite(price) && Number.isFinite(size) && price > 0 && size > 0 ? price * size : null;
    };
    const shortDepth = topDepth(candidate.shortSymbol, 'bid');
    const longDepth = topDepth(candidate.longSymbol, 'ask');
    if (shortDepth === null || longDepth === null) return 0;
    const weakest = Math.max(1, Math.min(shortDepth, longDepth));
    const deficit = Math.max(0, notionalUsd / weakest - 1);
    return Math.min(50, deficit * 10);
  }

  private priceAndSize(candidate: FundingArbCandidate, context: ScanContext): {
    entryBps: string | null;
    notionalUsd: number | null;
    quantity: string | null;
    leverage: number | null;
    shortLeverage: number | null;
    longLeverage: number | null;
    settlementInMs: number | null;
    reasons: string[];
  } {
    const shortMarket = this.deps.market(candidate.shortSymbol);
    const longMarket = this.deps.market(candidate.longSymbol);
    if (!shortMarket || !longMarket) {
      return { entryBps: null, notionalUsd: null, quantity: null, leverage: null, shortLeverage: null, longLeverage: null, settlementInMs: null, reasons: ['LEG_UNAVAILABLE'] };
    }
    const spread = executableEntrySpreadBps(shortMarket.bidPrice, longMarket.askPrice);
    if (spread === null) {
      return { entryBps: null, notionalUsd: null, quantity: null, leverage: null, shortLeverage: null, longLeverage: null, settlementInMs: null, reasons: ['LEG_UNAVAILABLE'] };
    }
    const price = Number(longMarket.lastPrice) > 0 ? Number(longMarket.lastPrice) : Number(longMarket.bidPrice);
    const shortInstrument = context.instruments.get(candidate.shortSymbol);
    const longInstrument = context.instruments.get(candidate.longSymbol);
    if (!shortInstrument || !longInstrument || !Number.isFinite(price) || price <= 0) {
      return { entryBps: null, notionalUsd: null, quantity: null, leverage: null, shortLeverage: null, longLeverage: null, settlementInMs: null, reasons: ['INSTRUMENT_MISSING'] };
    }
    const leverages = this.pickLeverages(candidate, context);
    const auto = context.settings.autoSizing ? context.autoBudget : null;
    const size = sizePerpHedge({
      availableMarginUsd: auto ? auto.budgetPerSlotUsd : context.availableMarginUsd * (1 - context.settings.marginHeadroomPct),
      safetyFactor: auto ? 1 : context.settings.safetyFactor,
      maxPerTradeUsd: auto ? null : context.settings.maxPerTradeUsd,
      leftLeverage: leverages.short,
      rightLeverage: leverages.long,
      price,
      lotSize: higherLot(shortInstrument, longInstrument),
      minSize: lowerMin(shortInstrument, longInstrument),
      minNotional: maxNullable(shortInstrument.minNotional, longInstrument.minNotional),
      maxMarketSize: minNullable(shortInstrument.maxMarketSize, longInstrument.maxMarketSize),
    });
    if (!size.ok) {
      return { entryBps: null, notionalUsd: null, quantity: null, leverage: null, shortLeverage: null, longLeverage: null, settlementInMs: null, reasons: [size.reason] };
    }
    if (!auto && context.settings.maxMarginPerVenueUsd > 0) {
      const perLegMargin = Math.max(size.leftMarginUsd, size.rightMarginUsd);
      if (perLegMargin > context.settings.maxMarginPerVenueUsd) {
        return { entryBps: null, notionalUsd: null, quantity: null, leverage: null, shortLeverage: null, longLeverage: null, settlementInMs: null, reasons: ['BALANCE_INSUFFICIENT'] };
      }
    }
    // Dynamic entry trigger: the executable spread minus a buffer that combines the operator's
    // slippage allowance with a top-of-book depth penalty — a leg whose top level cannot absorb the
    // clip needs more room before resting a quote, not a flat 0 bps trigger.
    const depthPenalty = this.depthPenaltyBps(candidate, size.notionalUsd);
    const entryBps = dynamicEntryBps(spread, context.settings.entrySlipBufferBps + depthPenalty);
    return {
      entryBps,
      notionalUsd: size.notionalUsd,
      quantity: size.quantity,
      leverage: size.leverage,
      shortLeverage: leverages.short,
      longLeverage: leverages.long,
      settlementInMs: settlementInMs(candidate.shortNextFundingAt, candidate.longNextFundingAt, context.now),
      reasons: [],
    };
  }

  private pickLeverages(candidate: FundingArbCandidate, context: ScanContext): { short: number; long: number } {
    const settings = context.settings;
    const shortMax = this.deps.leverageMax(candidate.shortSymbol) ?? settings.fixedLeverage;
    const longMax = this.deps.leverageMax(candidate.longSymbol) ?? settings.fixedLeverage;
    if (settings.autoSizing) {
      // Each leg takes its own venue ceiling. The engine stores them separately, so a 20x/10x pair
      // is margin-sized correctly instead of forcing both legs to the lower common leverage.
      return { short: Math.max(1, shortMax), long: Math.max(1, longMax) };
    }
    if (settings.leverageMode === 'fixed') return { short: settings.fixedLeverage, long: settings.fixedLeverage };
    return {
      short: Math.max(1, Math.min(shortMax, settings.maxLeverage)),
      long: Math.max(1, Math.min(longMax, settings.maxLeverage)),
    };
  }

  private canOpenMore(candidate: FundingArbCandidate, context: ScanContext, opened: FundingArbCandidate[]): boolean {
    const { settings } = context;
    const alreadyOpen = this.openOurStrategies(context).length + opened.length;
    if (alreadyOpen >= settings.maxConcurrent) return false;
    const maxEntries = settings.autoSizing ? settings.maxConcurrent * 2 : settings.maxEntriesPerDay;
    if (!settings.autoSizing) {
      const exposure = this.currentExposureUsd(context) + opened.reduce((sum, row) => sum + (row.notionalUsd ?? 0), 0);
      if (exposure + (candidate.notionalUsd ?? 0) > settings.maxTotalExposureUsd) return false;
    }
    if (this.entriesToday(context) + opened.length >= maxEntries) return false;
    return true;
  }

  /**
   * ADL / orphan guardian, polled every 60s while the runner is on.
   *
   * 1) **ADL**: the venue position snapshot carries per-symbol CrossEx/exchange ADL ranks. A rank at
   *    `adlExitRank` means the position may be force-closed by the venue at any moment, leaving the
   *    other leg naked; the guardian closes both legs itself.
   * 2) **Orphan / half-leg**: if exactly one leg of an automatic strategy still has a position for
   *    more than `orphanGraceSeconds`, close the surviving leg and stop the strategy. This covers a
   *    maker leg filling while its hedge fails, or one leg being closed outside the engine.
   *
   * Both paths only act on strategies the funding runner created (`autoFundingArb`), never on a
   * manually started strategy.
   */
  private async runGuardian(): Promise<void> {
    if (!this.runningLoop || !this.deps.positions || !this.deps.closePosition) return;
    const settings = readFundingArbSettings(this.deps.database);
    if (!settings.enabled) return;
    if (!settings.orphanWatchEnabled && !settings.adlWatchEnabled) return;
    const ours = this.deps.strategies().filter((record) => record.config.autoFundingArb === true
      && (record.status === 'RUNNING' || record.status === 'PAUSED'));
    if (ours.length === 0) return;
    let positions: PortfolioFuturesPosition[];
    try {
      positions = await this.deps.positions();
    } catch {
      return;
    }
    const now = this.deps.now?.() ?? Date.now();
    const bySymbol = new Map<string, PortfolioFuturesPosition>();
    for (const position of positions) {
      const quantity = Number(position.quantity);
      if (!Number.isFinite(quantity) || Math.abs(quantity) <= 0) continue;
      bySymbol.set(position.symbol, position);
    }
    for (const record of ours) {
      const leftSymbol = record.config.leftSymbol;
      const rightSymbol = record.config.rightSymbol;
      if (!leftSymbol || !rightSymbol) continue;
      const left = bySymbol.get(leftSymbol);
      const right = bySymbol.get(rightSymbol);
      if (settings.adlWatchEnabled) {
        const ranks = [left, right].flatMap((position) => position
          ? [Number(position.crossExAdlRank ?? 0), Number(position.exchangeAdlRank ?? 0)]
          : []).filter((rank) => Number.isFinite(rank) && rank > 0);
        const highest = ranks.length > 0 ? Math.max(...ranks) : 0;
        const busy = (this.deps.openOrders?.(record.id) ?? 0) > 0;
        if (highest >= settings.adlExitRank && !busy) {
          this.deps.warn?.('funding arb guardian: ADL exit rank reached', { strategyId: record.id, rank: highest });
          await this.closeLegs(record, [left, right], 1);
          await this.deps.stopStrategy(record.id);
          continue;
        }
        if (highest >= settings.adlReduceRank && settings.adlReduceFraction > 0
          && !busy && !this.adlReduced.has(record.id)) {
          this.adlReduced.add(record.id);
          this.deps.warn?.('funding arb guardian: ADL partial reduce', {
            strategyId: record.id, rank: highest, fraction: settings.adlReduceFraction,
          });
          await this.closeLegs(record, [left, right], settings.adlReduceFraction);
        }
      }
      if (!settings.orphanWatchEnabled) continue;
      const leftOpen = left !== undefined;
      const rightOpen = right !== undefined;
      if (leftOpen === rightOpen) {
        this.orphanSince.delete(record.id);
        continue;
      }
      const since = this.orphanSince.get(record.id) ?? now;
      this.orphanSince.set(record.id, since);
      if (now - since < settings.orphanGraceSeconds * 1000) continue;
      if ((this.deps.openOrders?.(record.id) ?? 0) > 0) continue;
      this.deps.warn?.('funding arb guardian: closing half-leg exposure', {
        strategyId: record.id, openLeg: leftOpen ? 'left' : 'right',
      });
      await this.closeLegs(record, [leftOpen ? left : undefined, rightOpen ? right : undefined], 1);
      await this.deps.stopStrategy(record.id);
      this.orphanSince.delete(record.id);
    }
  }

  private async closeLegs(
    record: StrategyRecord,
    legs: Array<PortfolioFuturesPosition | undefined>,
    fraction: number,
  ): Promise<void> {
    const close = this.deps.closePosition;
    if (!close) return;
    for (const position of legs) {
      if (!position) continue;
      const quantity = Math.abs(Number(position.quantity)) * Math.max(0, Math.min(1, fraction));
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      const positionSide = position.positionSide === 'LONG' || position.positionSide === 'SHORT'
        ? position.positionSide : 'NONE';
      const side = position.positionSide === 'SHORT' ? 'BUY' : 'SELL';
      try {
        await close({ symbol: position.symbol, side, quantity: String(quantity), positionSide, reduceOnly: true });
      } catch (error) {
        this.deps.warn?.('funding arb guardian close failed', {
          symbol: position.symbol, reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Maker/taker leg assignment. The taker leg should be the deeper book (a market order has to be
   * absorbed), so `auto` picks the *shallower* top-of-book as the maker leg; explicit left/right
   * pins it. Falls back to the left (short) leg when books are unavailable.
   */
  private chooseMakerLeg(candidate: FundingArbCandidate, settings: FundingArbSettings): 'left' | 'right' {
    if (settings.makerLegMode !== 'auto') return settings.makerLegMode;
    const book = this.deps.orderBook;
    if (!book) return 'left';
    const depth = (symbol: string): number | null => {
      const snapshot = book(symbol);
      if (!snapshot) return null;
      const top = snapshot.bids[0];
      if (!top) return null;
      const price = Number(top[0]);
      const size = Number(top[1]);
      return Number.isFinite(price) && Number.isFinite(size) && price > 0 && size > 0 ? price * size : null;
    };
    const shortDepth = depth(candidate.shortSymbol);
    const longDepth = depth(candidate.longSymbol);
    if (shortDepth === null || longDepth === null) return 'left';
    return shortDepth <= longDepth ? 'left' : 'right';
  }

  private async launch(candidate: FundingArbCandidate, context: ScanContext, settings: FundingArbSettings): Promise<string | null> {
    const account = this.deps.account();
    if (!account) return null;
    if (!context.liveTradingEnabled || !context.connectionHealthy) return null;
    if (candidate.quantity === null || candidate.quantity === undefined || candidate.entryBps === null) return null;
    if (!this.deps.market(candidate.shortSymbol) || !this.deps.market(candidate.longSymbol)) return null;
    const quantity = candidate.quantity;
    const input = {
      kind: 'position',
      asset: candidate.asset,
      leftVenue: candidate.shortVenue,
      leftSymbol: candidate.shortSymbol,
      leftSide: 'SELL',
      rightVenue: candidate.longVenue,
      rightSymbol: candidate.longSymbol,
      rightSide: 'BUY',
      entryBps: candidate.entryBps,
      executionMethod: 'MAKER_TAKER',
      makerLeg: this.chooseMakerLeg(candidate, settings),
      totalAmount: quantity,
      perOrderQuantity: quantity,
      leftLeverage: String(candidate.shortLeverage ?? candidate.leverage ?? 1),
      rightLeverage: String(candidate.longLeverage ?? candidate.leverage ?? 1),
      stopLossBps: settings.hardStopLossBps > 0 ? settings.hardStopLossBps : undefined,
      exitFundingAprFloorPercent: settings.exitFundingAprFloorPercent,
      exitOnFundingFlip: settings.exitOnFundingFlip,
      maxHoldingHours: settings.maxHoldingHours,
      minHoldingHours: settings.minHoldingHours,
      exitFundingDecayDwellSeconds: settings.exitFundingDecayDwellSeconds,
      exitFundingDeclineReadings: settings.exitFundingDeclineReadings,
      makerEntryOffsetBps: settings.makerEntryOffsetBps,
      makerEntryTimeoutSeconds: settings.makerEntryTimeoutSeconds,
      makerEntryProximityBps: settings.makerEntryProximityBps,
      autoFundingArb: true,
      recurring: settings.recurring,
      recurringCooldownSeconds: settings.recurringCooldownSeconds,
      recurringFundingAprMin: settings.minAprPercent,
      reduceOnly: false,
    };
    try {
      const record = await this.deps.startStrategy(input, account);
      this.deps.warn?.('funding arb strategy launched', { strategyId: record.id, asset: candidate.asset, venues: `${candidate.shortVenue}/${candidate.longVenue}` });
      return record.id;
    } catch (error) {
      this.deps.warn?.('funding arb strategy launch failed', { asset: candidate.asset, reason: error instanceof Error ? error.message : String(error) });
      candidate.verdict = 'REJECT';
      candidate.reasons = [...candidate.reasons, 'LEG_UNAVAILABLE'];
      candidate.score = null;
      return null;
    }
  }

  private recordDryRunTrade(candidate: FundingArbCandidate, context: ScanContext): void {
    if (candidate.notionalUsd === null || candidate.quantity === null || candidate.entryBps === null) return;
    const trade = insertFundingArbDryRunTrade(this.deps.database, {
      asset: candidate.asset,
      shortVenue: candidate.shortVenue,
      longVenue: candidate.longVenue,
      quantity: candidate.quantity,
      notionalUsd: candidate.notionalUsd,
      entryBps: candidate.entryBps,
      aprPercent: candidate.aprPercent,
      enteredAt: new Date(context.now).toISOString(),
      exitAt: null,
      fundingUsd: 0,
      feesUsd: 0,
      pnlUsd: 0,
      status: 'OPEN',
      payload: candidate,
    });
    this.dryRunOpen.set(trade.id, {
      candidate,
      notionalUsd: candidate.notionalUsd,
      enteredAt: context.now,
      lastAt: context.now,
      fundingUsd: 0,
      belowSince: null,
    });
  }

  /**
   * Dry-run closes: mirror the engine's funding-decay exit using the live per-leg funding rates.
   * Funding is accrued pro-rata to the 8h-equivalent APR between checks (the real settlement only
   * pays at discrete times, so this is an estimate), and the round-trip cost is charged once when
   * the trade closes.
   */
  private updateDryRunTrades(now: number): void {
    for (const [id, open] of this.dryRunOpen) {
      const reading = this.currentPairApr(open.candidate);
      const elapsed = Math.max(0, now - open.lastAt);
      if (reading && elapsed > 0) {
        open.fundingUsd += open.notionalUsd * (reading.aprPercent / 100 / 1095) * (elapsed / (8 * 3_600_000));
      }
      open.lastAt = now;
      const settings = readFundingArbSettings(this.deps.database);
      const capHours = settings.maxHoldingHours;
      const decayed = reading !== null && reading.aprPercent < settings.exitFundingAprFloorPercent;
      const flipped = reading !== null && settings.exitOnFundingFlip && reading.net8h <= 0;
      const capped = capHours > 0 && now - open.enteredAt >= capHours * 3_600_000;
      // Same debounce as the engine: stay below the floor for the dwell window before closing, and
      // never run a soft exit before the minimum holding time.
      const below = decayed || flipped;
      if (!below) open.belowSince = null;
      else if (open.belowSince === null) open.belowSince = now;
      const minHoldMs = settings.minHoldingHours * 3_600_000;
      const dwellMs = settings.exitFundingDecayDwellSeconds * 1000;
      const softExit = below && open.belowSince !== null
        && now - open.enteredAt >= minHoldMs
        && now - open.belowSince >= dwellMs;
      if (!softExit && !capped) continue;
      const feesUsd = open.notionalUsd * roundTripCostBps(DEFAULT_TAKER_FEE_BPS, DEFAULT_SLIPPAGE_BPS) / 10_000;
      closeFundingArbDryRunTrade(this.deps.database, id, {
        closedAt: new Date(now).toISOString(),
        fundingUsd: open.fundingUsd,
        feesUsd,
        pnlUsd: open.fundingUsd - feesUsd,
      });
      this.dryRunOpen.delete(id);
    }
  }

  /** Live 8h-equivalent funding differential of one candidate pair, or null when unreadable. */
  private currentPairApr(candidate: FundingArbCandidate): { net8h: number; aprPercent: number } | null {
    const shortMarket = this.deps.market(candidate.shortSymbol);
    const longMarket = this.deps.market(candidate.longSymbol);
    if (!shortMarket || !longMarket) return null;
    const shortRate = Number(shortMarket.fundingRate);
    const longRate = Number(longMarket.fundingRate);
    if (!Number.isFinite(shortRate) || !Number.isFinite(longRate)) return null;
    const shortInterval = candidate.shortIntervalHours ?? 8;
    const longInterval = candidate.longIntervalHours ?? 8;
    const short8h = shortInterval > 0 ? shortRate * 8 / shortInterval : shortRate;
    const long8h = longInterval > 0 ? longRate * 8 / longInterval : longRate;
    const net8h = short8h - long8h;
    return { net8h, aprPercent: net8h * 1095 * 100 };
  }

  private availableMarginUsd(): number {
    const balances = this.deps.balances();
    return balances
      .filter((balance) => ['USDT', 'USDC'].includes(balance.coin.toUpperCase()))
      .reduce((sum, balance) => {
        const available = Number(balance.availableBalance);
        return Number.isFinite(available) && available > 0 ? sum + available : sum;
      }, 0);
  }

  /** Account equity in USD terms, used as the base of the auto-sizing budget. */
  private marginBalanceUsd(): number {
    const balances = this.deps.balances();
    return balances
      .filter((balance) => ['USDT', 'USDC'].includes(balance.coin.toUpperCase()))
      .reduce((sum, balance) => {
        const equity = Number(balance.equity);
        const fallback = Number(balance.balance);
        const value = Number.isFinite(equity) && equity > 0 ? equity : fallback;
        return Number.isFinite(value) && value > 0 ? sum + value : sum;
      }, 0);
  }

  private connectionHealthy(): boolean {
    const state = this.deps.connectionState?.();
    return state === undefined || state === 'healthy';
  }

  /** Our auto-created position strategies that are still live (survives a backend restart). */
  private openOurStrategies(context: ScanContext): StrategyRecord[] {
    return context.strategies.filter((record) => (record.status === 'RUNNING' || record.status === 'PAUSED')
      && record.config.kind === 'position'
      && record.config.autoFundingArb === true);
  }

  private realizedPnl(record: StrategyRecord): number {
    const raw = record.pnl?.netPnl ?? record.pnl?.realizedPnl ?? record.realizedPnl;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  }

  /** Same-asset consecutive losing closes inside the cooldown window pause that asset. */
  private assetInLossCooldown(asset: string, context: ScanContext): boolean {
    const settings = context.settings;
    if (settings.pairLossCooldownHours <= 0 || settings.pairLossThreshold <= 0) return false;
    const cutoff = context.now - settings.pairLossCooldownHours * 3_600_000;
    let losses = 0;
    for (const record of context.strategies) {
      if (record.config.autoFundingArb !== true || record.config.asset !== asset) continue;
      if (record.stoppedAt === null || Date.parse(record.stoppedAt) < cutoff) continue;
      if (this.realizedPnl(record) < 0) losses += 1;
    }
    return losses >= settings.pairLossThreshold;
  }

  /** Realized PnL of our automatic strategies closed since 00:00 UTC. */
  private realizedTodayUsd(strategies: StrategyRecord[], now: number): number {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return strategies.reduce((sum, record) => {
      if (record.config.autoFundingArb !== true || record.stoppedAt === null) return sum;
      if (Date.parse(record.stoppedAt) < start.getTime()) return sum;
      return sum + this.realizedPnl(record);
    }, 0);
  }

  private assetHasOpenStrategy(candidate: FundingArbCandidate, context: ScanContext): boolean {
    return context.strategies.some((record) => record.config.asset === candidate.asset
      && (record.status === 'RUNNING' || record.status === 'PAUSED')
      && record.config.kind === 'position'
      && record.config.autoFundingArb === true);
  }

  private inCooldown(candidate: FundingArbCandidate, context: ScanContext): boolean {
    const cooldownMs = context.settings.cooldownMinutes * 60_000;
    if (cooldownMs <= 0) return false;
    return context.strategies.some((record) => record.config.asset === candidate.asset
      && record.config.kind === 'position'
      && record.config.autoFundingArb === true
      && record.stoppedAt !== null
      && context.now - Date.parse(record.stoppedAt) < cooldownMs);
  }

  private entriesToday(context: ScanContext): number {
    const start = new Date(context.now);
    start.setUTCHours(0, 0, 0, 0);
    return context.strategies.filter((record) => record.config.kind === 'position'
      && record.config.autoFundingArb === true
      && Date.parse(record.createdAt) >= start.getTime()).length;
  }

  private currentExposureUsd(context: ScanContext): number {
    return context.strategies
      .filter((record) => (record.status === 'RUNNING' || record.status === 'PAUSED')
        && record.config.kind === 'position'
        && record.config.autoFundingArb === true)
      .reduce((sum, record) => {
        const quantity = Number(record.config.totalAmount ?? 0);
        const market = this.deps.market(record.config.rightSymbol ?? '') ?? this.deps.market(record.config.leftSymbol ?? '');
        const price = market ? Number(market.lastPrice) : 0;
        return Number.isFinite(quantity) && Number.isFinite(price) ? sum + quantity * price : sum;
      }, 0);
  }

  private newestStrategyId(): string | null {
    const ids = [...this.autoStrategyIds.keys()];
    return ids.length > 0 ? ids[ids.length - 1]! : null;
  }
}

function higherLot(left: CrossExInstrument, right: CrossExInstrument): string | null {
  const leftLot = Number(left.lotSize);
  const rightLot = Number(right.lotSize);
  const candidates = [leftLot, rightLot].filter((value) => Number.isFinite(value) && value > 0);
  if (candidates.length === 0) return null;
  return String(Math.max(...candidates));
}

function lowerMin(left: CrossExInstrument, right: CrossExInstrument): string | null {
  const values = [Number(left.minSize), Number(right.minSize)].filter((value) => Number.isFinite(value) && value > 0);
  return values.length === 0 ? null : String(Math.min(...values));
}

function maxNullable(left: string | null, right: string | null): string | null {
  const values = [left, right].flatMap((value) => {
    const parsed = value === null ? Number.NaN : Number(value);
    return Number.isFinite(parsed) ? [parsed] : [];
  });
  return values.length === 0 ? null : String(Math.max(...values));
}

function minNullable(left: string | null, right: string | null): string | null {
  const values = [left, right].flatMap((value) => {
    const parsed = value === null ? Number.NaN : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? [parsed] : [];
  });
  return values.length === 0 ? null : String(Math.min(...values));
}
