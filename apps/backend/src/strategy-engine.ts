import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { PortfolioFuturesPosition } from '@gate-crossex/shared-types';
import type { LiveMarket } from './market-hub.js';
import type { TradingSession } from './trading-session.js';
import { GateApiError } from './crossex-client.js';
import { nativeMarketAsset } from './market-asset-aliases.js';
import {
  CreateStrategyInputSchema,
  UpdatePremiumTakeProfitInputSchema,
  TradingRuntime,
  TradingRuntimeError,
  isReduceOnlyQuantityRejection,
  isTerminalOrderState,
  type CreateStrategyInput,
  type ExecutionOrder,
  type StrategyCarryMetrics,
  type StrategyRecord,
  type UpdatePremiumTakeProfitInput,
  unresolvedOrderDetails,
  type UnresolvedOrderReport,
} from './trading-runtime.js';

/** Read access to the live market cache; the production implementation is CrossExMarketHub. */
export interface MarketSource {
  market(symbol: string): LiveMarket | null;
  /** Register a catalog-known symbol on demand so its ticker streams; false when unknown. */
  ensureMarket?(symbol: string): boolean;
  /**
   * Subscribe the given symbols to live ticker frames and return an idempotent release. The
   * engine holds one subscription per running strategy: without it, dynamically ensured symbols
   * never receive a WebSocket subscription and the launch wait for fresh prices cannot succeed.
   */
  watchQuotes?(symbols: string[]): () => void;
  /**
   * Subscribe one symbol to live order-book frames and return an idempotent release. A sparse
   * ticker that omits bid/ask leaves a leg with no executable quote at all, so a strategy holds
   * this subscription next to its ticker one: the maintained book is the only other source the
   * hub can back a quote from, and without it a low-liquidity leg would simply go silent.
   */
  watchOrderBook?(symbol: string): () => void;
  /**
   * Current order-book levels as `[price, size]` string pairs. A taker entry can only be judged
   * executable against the book it will walk: a top-of-book quote says nothing about how far a
   * clip of this size pushes the price, which is exactly how a 66 USDT order filled 2.4% worse
   * than its decision quote on a thin venue. Absent (or a null return) means "depth unknown" and
   * the slippage guard stands down rather than inventing a number.
   */
  orderBook?(symbol: string): { bids: ReadonlyArray<readonly [string, string]>; asks: ReadonlyArray<readonly [string, string]> } | null;
  /** Current upstream public-stream state, when the source can expose it. */
  connectionState?(): 'connecting' | 'healthy' | 'reconnecting' | 'stale' | 'disconnected';
}

export interface StrategyEngineOptions {
  /** Milliseconds between trigger evaluations. */
  tickIntervalMs?: number;
  /** How long to wait for a taker order to reach a terminal state before repairing. */
  orderTimeoutMs?: number;
  /** Minimum milliseconds between maker requotes per quote slot. */
  requoteIntervalMs?: number;
  /** Market data older than this is considered unusable for triggering. */
  marketFreshnessMs?: number;
  /** Maximum delay from the exchange source timestamp to local WebSocket receipt. */
  marketMaxTransportLagMs?: number;
  /** Small allowance for clock skew; quotes further in the future are rejected. */
  futureQuoteToleranceMs?: number;
  /**
   * Maximum age difference tolerated between the two legs' quotes. Each leg is freshness-gated
   * on its own, but two individually fresh quotes can still be minutes apart in exchange time,
   * and a spread computed across them never existed. Arbitrage is a same-instant property.
   */
  marketPairMaxSkewMs?: number;
  /** Cooldown between hedge-repair attempts. */
  repairCooldownMs?: number;
  /**
   * How long strategy launch waits for both legs' first live ticker frame before rejecting with
   * `strategy_market_data_unavailable`. A dynamically ensured symbol starts as a zero-priced
   * placeholder, so an immediate check would reject tradable strategies.
   */
  marketDataWaitTimeoutMs?: number;
  /**
   * Funding settlement interval in hours for one executable perpetual symbol, from the funding
   * overview cache. Returning null/undefined (or omitting the dependency) falls back to Gate's
   * 8h cadence for APR annualization and the accrual clock, with a strategy-log warning.
   */
  fundingIntervalHours?: (symbol: string) => number | null | undefined;
  /**
   * Ceiling on the book-walked slippage a taker ENTRY may pay against the live order book
   * (bps). Exits are never blocked — refusing to close is worse than paying the spread — and a
   * symbol without a maintained book is not judged at all. 0 disables the guard.
   */
  maxTakerSlippageBps?: number;
  now?: () => number;
}

type QuoteIntent = 'entry' | 'exit';

interface MakerQuote {
  orderId: string;
  price: Decimal;
  quantity: Decimal;
  quotedAt: number;
  cancelling: boolean;
}

interface StrategyActor {
  id: string;
  config: CreateStrategyInput;
  kind: 'position' | 'auto' | 'premium' | 'carry';
  status: string;
  busy: boolean;
  queue: Promise<void>;
  quotes: Map<QuoteIntent, MakerQuote>;
  repairAttempts: number;
  lastRepairAt: number;
  failureCount: number;
  cooldownUntil: number;
  lastQuoteAt: number;
  suspended: boolean;
  quiesceTarget: 'PAUSED' | 'STOPPED' | null;
  quiesceReason: string | null;
  /** Orders the last quiesce attempt could not prove terminal, kept for recovery diagnostics. */
  unresolvedOrders: UnresolvedOrderReport[];
  createdAt: number;
  lastCloseAt: number;
  /** auto: latched once a stop-loss exit clip was submitted; the strategy stops when flat. */
  stopLossArmed: boolean;
  /**
   * Exit quantity the venue can actually reduce, learned when a reduce-only order was rejected
   * with TRADE_REDUCE_ONLY_POSITION_QTY_ERROR (the ledger believed a position the venue no
   * longer holds). Every later tick re-reports exits at this size instead of resubmitting a
   * doomed order; retired as soon as the ledger-derived quantity drops to it, and cleared on
   * any new fill so a real event always re-derives from the ledger. Null in the normal case.
   */
  venueExitQuantity: Decimal | null;
  /**
   * Symbol {@link venueExitQuantity} was measured for. The clamp is a per-leg quantity and the two
   * legs of a pair are not in the same units (a hedge leg is sized by the ADR ratio), so a clamp
   * learned for one symbol must never be applied to an order on the other. Null with the clamp.
   */
  venueExitQuantitySymbol: string | null;
  /**
   * closePlan targets the venue confirmed hold nothing reducible (R3): the ledger believed a
   * position the venue no longer holds, or the residual is below the smallest order unit. Those
   * targets count as satisfied — the plan stops resubmitting doomed orders for them and the
   * whole plan completes as soon as every target is satisfied or fully executed. In-memory only;
   * a recovered actor re-learns the state from the next rejection.
   */
  closePlanSatisfied: Set<number>;
  /**
   * True while an entry quote is withheld because the live spread sits outside the maker entry
   * proximity band; drives the one-shot `Maker quoting parked` / `Maker quoting resumed` logs so
   * a parked strategy does not write a row on every 500ms tick.
   */
  makerEntryParked: boolean;
  /**
   * position: wall-clock deadline (ms) of the settlement-based exit, computed once the position is
   * open from the slower leg's next settlement plus the configured delay. Null until armed and
   * while no position is held.
   */
  settlementExitAt: number | null;
  /**
   * position: wall-clock ms of the first tick where both legs were held. Basis for the
   * `maxHoldingHours` safety cap, and null while flat.
   */
  positionOpenedAt: number | null;
  /** position: first tick the funding reading sat below the decay floor, for the dwell debounce. */
  fundingDecaySince: number | null;
  /** position: rolling APR readings for the smart-decline exit. */
  fundingAprReadings: number[];
  /**
   * auto MAKER_TAKER only: latched once the live exit spread reached the take-profit level. While
   * set, the maker exit quote is never withdrawn, the hedge leg is unwound (never topped up), and
   * no new entry quote is rested. Retired once both legs are flat — restarting recomputes from the
   * spread, so nothing is persisted.
   */
  makerExitArmed: boolean;
  /** Wall-clock ms when {@link makerExitArmed} latched; null while unarmed. Gates the time fallback. */
  makerExitStartedAt: number | null;
  /** True once the one-shot `Maker exit fallback` row has been written for the current latch. */
  makerExitFallbackLogged: boolean;
  /** The single resting reduce-only hedge-leg limit backing an armed exit; null when none is out. */
  makerExitHedge: {
    orderId: string;
    price: Decimal;
    placedAt: number;
    leg: 'left' | 'right';
    quantity: Decimal;
  } | null;
  /** How many times the hedge-leg exit limit has been cancelled and re-priced; diagnostics only. */
  makerExitHedgeRequotes: number;
  /**
   * Consecutive maker-exit hedge submit failures. Deliberately separate from {@link failureCount}:
   * that counter is read by the entry / two-leg insufficient-margin paths, and folding hedge
   * failures into it would change their semantics. Reset to zero on every successful submission
   * and when the latch retires.
   */
  makerExitHedgeFailures: number;
  /** Earliest wall-clock ms the hedge submit may be attempted again after a failure (backoff gate). */
  makerExitHedgeRetryAt: number;
  /**
   * position only: latched once a configured `takeProfitBps` / `stopLossBps` threshold was reached
   * and the exit clip submitted. While set no new entry clip may be placed and every later tick
   * only unwinds what is still open — the same one-way lifecycle the auto stop-loss latch and the
   * premium take-profit latch use. Never retired: a position strategy exits at most once, and a
   * restart re-derives the latch from the ledger (`positionExitStarted`).
   */
  positionExitArmed: boolean;
  /** position: which threshold armed {@link positionExitArmed}; drives event names and the status. */
  positionExitReason: 'take-profit' | 'stop-loss' | 'settlement' | 'funding-decay' | 'max-hold' | null;
  /**
   * True while an entry clip is withheld because it would push exposure past `maxPosition`; gates
   * the one-shot `Entry blocked by max position` row so a capped strategy does not write a row on
   * every tick.
   */
  positionCapBlocked: boolean;
  /** carry: in-memory accounting state; reset when the backend restarts (re-estimated from fills). */
  carry: CarryRuntimeState | null;
  /** Serialized metrics of the last write, so unchanged snapshots do not touch the database. */
  lastCarryMetricsJson: string | null;
  /** Releases the leg-symbol ticker subscription taken at launch; null once already released. */
  quoteWatchRelease: (() => void) | null;
}

/** In-memory carry accounting (§7-3 field semantics; persisted via strategy metrics). */
interface CarryRuntimeState {
  fundingCollectedUsdt: Decimal;
  basisEntryBps: Decimal | null;
  basisCurrentBps: Decimal | null;
  entryFundingApr: Decimal | null;
  entrySpotNotionalUsdt: Decimal | null;
  nextFundingAccrualAt: number | null;
  exited: boolean;
  /** Last entry-gate outcome, used to log only state transitions instead of every tick. */
  lastGatePassed: boolean | null;
}

function emptyCarryState(): CarryRuntimeState {
  return {
    fundingCollectedUsdt: ZERO, basisEntryBps: null, basisCurrentBps: null, entryFundingApr: null,
    entrySpotNotionalUsdt: null, nextFundingAccrualAt: null, exited: false, lastGatePassed: null,
  };
}

interface LegDefinition {
  leg: 'left' | 'right';
  venue: string;
  side: 'BUY' | 'SELL';
  symbol: string;
}

interface InstrumentConstraints {
  tickSize: string | null;
  lotSize: string | null;
  minSize: string | null;
  minNotional: string | null;
}

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const QUANTITY_EPSILON = new Decimal('1e-12');
/** Tolerance for rung arithmetic on decimal quantities; far below any real lot size. */
const RUNG_EPSILON = new Decimal('1e-9');
const BPS = new Decimal(10_000);
/** Keep dust-repair orders clear of a moving venue's exact minimum-notional boundary. */
const MIN_NOTIONAL_REPAIR_BUFFER = new Decimal('1.1');
/** Poll cadence while waiting for a strategy symbol's first live ticker frame. */
const MARKET_WAIT_POLL_MS = 100;
/** Fallback funding settlement cadence (8h) for symbols whose venue interval is unknown. */
const FUNDING_PERIOD_MS = 8 * 3_600_000;
/** Bounds the catch-up loop after a long suspension so one tick cannot accrue unbounded periods. */
const MAX_FUNDING_ACCRUAL_CATCHUP = 40;
/** Legacy carry fallback prefix (rows created before cross-venue carry was unlocked). */
const GATE_SPOT_SYMBOL_PREFIX = 'GATE_SPOT_';
/**
 * Proximity band (bps) around the entry trigger for **maker entry quotes only**: an entry quote is
 * rested only while the live spread is at most this far from the tier's trigger level. Without it
 * the quote's target price is re-derived from the opposite leg every tick, so a strategy cancels
 * and replaces indefinitely even while the market is nowhere near the level it wants.
 *
 * A global engine default — deliberately **not** a strategy field: it applies to every MAKER_TAKER
 * strategy, including ones already running, as soon as the backend restarts. No configuration
 * change and no migration are involved. Exit / take-profit quotes are never gated by it.
 */
const MAKER_ENTRY_PROXIMITY_BPS = 25;
/**
 * Budget for a latched maker exit before the engine relaxes the hedge-leg slippage cap. A
 * MAKER_TAKER take-profit rests a post-only reduce-only limit on the maker leg and unwinds the
 * hedge leg with a reduce-only *limit* at a bounded slippage from the mid; if the pair is still
 * not flat after this long, the exit is clearly being starved by an unfavourable book and the
 * engine widens that cap (see {@link MAKER_EXIT_HEDGE_FALLBACK_SLIPPAGE_BPS}) once.
 */
const MAKER_EXIT_FALLBACK_MS = 30_000;
/** How long the resting hedge-leg exit limit may sit before it is cancelled and re-priced. */
const MAKER_EXIT_HEDGE_TTL_MS = 1_500;
/** Slippage (bps) the hedge-leg exit limit may concede from the mid while within its budget. */
const MAKER_EXIT_HEDGE_SLIPPAGE_BPS = 3;
/** Widened hedge-leg slippage cap applied once the exit overruns {@link MAKER_EXIT_FALLBACK_MS}. */
const MAKER_EXIT_HEDGE_FALLBACK_SLIPPAGE_BPS = 10;

function isSpotSymbol(symbol: string): boolean {
  return /^[A-Z0-9]+_SPOT_/.test(symbol);
}

/**
 * Parse an optional numeric strategy field into a finite Decimal.
 *
 * Strategy fields arrive in two shapes — `stopLossBps`/`addOnStepBps` are numbers, `takeProfitBps`/
 * `maxPosition` are decimal *text* — and the text form may be absent, blank, or (in a legacy row
 * written before the schema tightened) unparseable. `new Decimal('')` throws, so every optional
 * threshold is funnelled through this one helper: null means "not configured", and a caller must
 * then treat that threshold as disabled rather than defaulting it to zero. Defaulting to zero is
 * how a missing stop-loss would silently become a stop at 0 bps.
 */
function optionalDecimal(value: string | number | undefined | null): Decimal | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === '') return null;
  try {
    const parsed = new Decimal(text);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * How much of `symbol` the venue can actually reduce for an order on `side`, read from a fresh
 * position snapshot: a SELL exit reduces LONG positions, a BUY exit reduces SHORT positions.
 * Zero when the venue holds nothing reducible — including when it holds no rows for the symbol
 * at all, i.e. the position was closed outside the engine. Null only when a row cannot be
 * interpreted, so the caller can tell "venue says zero" from "venue said something unusable".
 */
function venueReducibleQuantity(
  positions: readonly PortfolioFuturesPosition[],
  symbol: string,
  side: 'BUY' | 'SELL',
): Decimal | null {
  let total = ZERO;
  for (const position of positions) {
    if (position.symbol !== symbol) continue;
    const raw = new Decimal(position.quantity || '0');
    if (!raw.isFinite()) return null;
    const positionSide = position.positionSide.toUpperCase();
    const signed = positionSide === 'SHORT' ? raw.abs().negated()
      : positionSide === 'LONG' ? raw.abs()
        : raw;
    if (side === 'SELL' && signed.gt(0)) total = total.plus(signed);
    else if (side === 'BUY' && signed.lt(0)) total = total.plus(signed.abs());
  }
  return total;
}

/** Annualize a funding rate into a percentage: |rate| × (24/interval) periods/day × 365 × 100. */
function fundingAprFromRate(rate: Decimal, intervalHours: number): Decimal {
  const settlementsPerDay = 24 / intervalHours;
  return rate.abs().mul(settlementsPerDay).mul(365).mul(100);
}

function symbolFor(venue: string, asset: string): string {
  const quote = venue === 'KRAKEN' ? 'USD' : venue === 'HYPERLIQUID' || venue === 'DERIBIT' || venue === 'LIGHTER' ? 'USDC' : 'USDT';
  const nativeAsset = nativeMarketAsset(venue, 'FUTURE', asset);
  return `${venue}_FUTURE_${nativeAsset}_${quote}`;
}

function legsOf(config: CreateStrategyInput): { left: LegDefinition; right: LegDefinition } {
  // Premium strategies hedge the ADR (left) with the local listing (right); other kinds trade the
  // same asset on both venues. Explicit symbols win (auto spot legs, carry legs); carry falls
  // back to the legacy Gate-only pair for rows persisted before cross-venue carry was unlocked.
  const rightAsset = config.kind === 'premium' ? config.hedgeAsset ?? config.asset : config.asset;
  const leftSymbol = config.leftSymbol
    ?? (config.kind === 'carry' ? `${GATE_SPOT_SYMBOL_PREFIX}${config.asset}_USDT` : symbolFor(config.leftVenue, config.asset));
  const rightSymbol = config.rightSymbol ?? symbolFor(config.rightVenue, rightAsset);
  return {
    left: { leg: 'left', venue: config.leftVenue, side: config.leftSide, symbol: leftSymbol },
    right: { leg: 'right', venue: config.rightVenue, side: config.rightSide, symbol: rightSymbol },
  };
}

/**
 * ADR shares per one hedge-leg share (SK hynix: 1 Korean share ≈ 10 ADRs). Strategy quantities
 * are always expressed in left-leg (ADR) units; the right leg converts through this ratio at
 * order submission (hedge qty = ADR qty ÷ ratio), and executed right-leg quantities multiply by
 * it so exposure, matching, and progress stay in one unit.
 */
function adrRatioOf(config: CreateStrategyInput): Decimal {
  // Premium (ADR) strategies own the ratio field; a custom cross-asset pair supplies the same
  // conversion through `quantityRatio`, so both funnel into one coefficient. Everything else is
  // 1:1 (one left unit hedges one right unit).
  if (config.kind !== 'premium' && !config.quantityRatio) return ONE;
  const ratio = new Decimal(config.kind === 'premium' ? config.adrRatio ?? '1' : config.quantityRatio ?? '1');
  return ratio.gt(0) ? ratio : ONE;
}

function oppositeSide(side: 'BUY' | 'SELL'): 'BUY' | 'SELL' {
  return side === 'BUY' ? 'SELL' : 'BUY';
}

interface StrategyOrderRow {
  leg: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  executed_quantity: string;
  strategy_clip: string | null;
  reduce_only: number;
}

interface StrategyLedgerCache {
  loadedAt: number;
  rows: StrategyOrderRow[];
  configKey?: string;
  exposure?: { left: Decimal; right: Decimal; rightShares: Decimal };
  shortfalls?: Array<{ clip: string | null; k: Decimal; lagging: 'left' | 'right'; delta: Decimal }>;
  premiumExitStarted?: boolean;
  positionExitStarted?: boolean;
  openOrderIds?: string[];
}

interface ClipGroup {
  clip: string | null;
  rows: StrategyOrderRow[];
}

function signedExecuted(row: StrategyOrderRow): Decimal {
  const executed = new Decimal(row.executed_quantity || '0');
  return row.side === 'BUY' ? executed : executed.neg();
}

/** Groups a strategy's orders by clip, preserving insertion order within and across groups. */
function clipGroups(rows: StrategyOrderRow[]): ClipGroup[] {
  const groups = new Map<string, ClipGroup>();
  for (const row of rows) {
    const key = row.strategy_clip ?? '__unclipped__';
    let group = groups.get(key);
    if (!group) {
      group = { clip: row.strategy_clip, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

/**
 * Intended right-shares per left-share of one clip, recovered from the requested quantities of
 * its original two legs (rows are insertion-ordered, and both original rows exist before any
 * repair order — a row is written even when submission fails). Falls back to the strategy's
 * fixed conversion for legacy rows without a clip id.
 */
function clipRatio(group: ClipGroup, fixedRatio: Decimal): Decimal {
  const firstLeft = group.rows.find((row) => row.leg === 'left');
  const firstRight = group.rows.find((row) => row.leg === 'right');
  const fallback = ONE.div(fixedRatio);
  if (!firstLeft || !firstRight) return fallback;
  const leftQuantity = new Decimal(firstLeft.quantity);
  const rightQuantity = new Decimal(firstRight.quantity);
  if (!leftQuantity.gt(0) || !rightQuantity.gt(0)) return fallback;
  return rightQuantity.div(leftQuantity);
}

function roundToStep(value: Decimal, step: string | null, direction: 'up' | 'down'): Decimal {
  if (!step) return value;
  const stepDecimal = new Decimal(step);
  if (!stepDecimal.gt(0)) return value;
  const units = value.div(stepDecimal);
  const rounded = direction === 'up' ? units.ceil() : units.floor();
  return rounded.mul(stepDecimal);
}

function parseFailureReason(reason: string | null): { label: string | null; message: string } | null {
  if (!reason?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(reason);
    if (parsed && typeof parsed === 'object') {
      const value = parsed as { label?: unknown; message?: unknown };
      const label = typeof value.label === 'string' ? value.label : null;
      const message = typeof value.message === 'string' ? value.message : label ?? reason;
      return { label, message };
    }
  } catch { /* Some adapters return a plain label instead of JSON. */ }
  return { label: reason, message: reason };
}

function failureSummary(reason: string | null): string | null {
  const parsed = parseFailureReason(reason);
  if (!parsed) return null;
  const detail = parsed.label && parsed.label !== parsed.message
    ? `${parsed.label}: ${parsed.message}`
    : parsed.message;
  return detail.slice(0, 240);
}

function isRouterCapacityFailure(reason: string | null): boolean {
  const parsed = parseFailureReason(reason);
  return parsed?.label === 'NOT_BEST_ACCOUNT_ROUTER'
    || parsed?.message.includes('NOT_BEST_ACCOUNT_ROUTER') === true;
}

export class StrategyEngineError extends TradingRuntimeError {}

export class StrategyEngine {
  private readonly actors = new Map<string, StrategyActor>();
  private readonly options: Required<StrategyEngineOptions>;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickRun: Promise<void> | null = null;
  private tickRequested = false;
  private readonly constraintCache = new Map<string, { value: InstrumentConstraints; cachedAt: number }>();
  private readonly ledgerCache = new Map<string, StrategyLedgerCache>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly strategyOrderRowsStatement;
  private readonly openStrategyOrderIdsStatement;
  private readonly instrumentConstraintsStatement;
  private readonly latestLegOrderStatement;
  private readonly strategyFeesStatement;
  /** Symbols whose missing funding interval already produced the 8h fallback warning. */
  private readonly intervalFallbackWarned = new Set<string>();
  private stopped = false;

  constructor(
    private readonly database: Database.Database,
    private readonly session: TradingSession,
    private readonly runtime: TradingRuntime,
    private readonly markets: MarketSource,
    options: StrategyEngineOptions = {},
  ) {
    this.options = {
      tickIntervalMs: options.tickIntervalMs ?? 500,
      orderTimeoutMs: options.orderTimeoutMs ?? 20_000,
      requoteIntervalMs: options.requoteIntervalMs ?? 2_000,
      marketFreshnessMs: options.marketFreshnessMs ?? 15_000,
      marketMaxTransportLagMs: options.marketMaxTransportLagMs ?? 3_000,
      futureQuoteToleranceMs: options.futureQuoteToleranceMs ?? 2_000,
      marketPairMaxSkewMs: options.marketPairMaxSkewMs ?? 2_000,
      repairCooldownMs: options.repairCooldownMs ?? 3_000,
      marketDataWaitTimeoutMs: options.marketDataWaitTimeoutMs ?? 10_000,
      // A missing adapter reports null so carry accounting falls back to the 8h Gate cadence.
      fundingIntervalHours: options.fundingIntervalHours ?? (() => null),
      // 50 bps of book-walked slippage is already several times the round-trip taker fee; past
      // that an entry is not an arbitrage, it is a market order into a hole.
      maxTakerSlippageBps: options.maxTakerSlippageBps ?? 50,
      now: options.now ?? Date.now,
    };
    this.strategyOrderRowsStatement = database.prepare(`SELECT strategy_leg AS leg, symbol, side, quantity, executed_quantity, strategy_clip, reduce_only
      FROM execution_orders WHERE strategy_id = ? ORDER BY created_at ASC, rowid ASC`);
    this.openStrategyOrderIdsStatement = database.prepare(`SELECT id FROM execution_orders
      WHERE strategy_id = ? AND state IN ('PENDING_SUBMIT', 'PENDING_CANCEL', 'NEW', 'OPEN', 'PARTIALLY_FILLED')`);
    this.instrumentConstraintsStatement = database.prepare(
      'SELECT tick_size, lot_size, min_size, min_notional FROM crossex_instruments WHERE symbol = ?',
    );
    this.latestLegOrderStatement = database.prepare(`SELECT state, quantity, executed_quantity, failure_reason
      FROM execution_orders
      WHERE strategy_id = ? AND strategy_leg = ? AND symbol = ? AND side = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`);
    this.strategyFeesStatement = database.prepare(`SELECT COALESCE(fill.fee, '0') AS fee
      FROM execution_fills AS fill
      JOIN execution_orders AS strategy_order ON strategy_order.id = fill.order_id
      WHERE strategy_order.strategy_id = ?`);
    this.unsubscribers.push(this.runtime.onFill((fill) => {
      if (!fill.strategyId) return;
      this.invalidateLedger(fill.strategyId);
      const actor = this.actors.get(fill.strategyId);
      // A real fill moves the ledger: drop any venue-truth exit clamp so the next exit is
      // re-derived from the ledger, and re-clamped only if the venue rejects it again.
      if (actor) {
        actor.venueExitQuantity = null;
        actor.venueExitQuantitySymbol = null;
      }
      if (actor) this.enqueue(actor, () => this.afterExecutionChange(actor));
    }));
    this.unsubscribers.push(this.runtime.onOrderUpdate((order) => {
      if (!order.strategyId) return;
      this.invalidateLedger(order.strategyId);
      const actor = this.actors.get(order.strategyId);
      if (!actor) return;
      if (isTerminalOrderState(order.state)) {
        for (const [intent, quote] of actor.quotes) {
          if (quote.orderId === order.id) actor.quotes.delete(intent);
        }
      }
      this.enqueue(actor, () => this.afterExecutionChange(actor));
    }));
  }

  start(): void {
    this.stopped = false;
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => { void this.tick(); }, this.options.tickIntervalMs);
      this.tickTimer.unref?.();
    }
    // Production always starts locked. Persisted strategies are attached only after the live-mode
    // route has reconciled/cancelled every pre-existing order and the user acknowledges the risk.
    if (this.session.liveTradingEnabled) this.activatePersistedStrategies();
  }

  async prepareForLiveActivation(): Promise<void> {
    const quiesced = await this.runtime.quiesceOpenOrders({ timeoutMs: this.options.orderTimeoutMs });
    if (quiesced.unresolved.length > 0) {
      throw new StrategyEngineError('strategy_recovery_unresolved', 409,
        quiesced.unresolved.map(({ order }) => order.id).join(','),
        { unresolvedOrders: unresolvedOrderDetails(quiesced.unresolved) });
    }
    for (const actor of this.actors.values()) actor.suspended = true;
    for (const actor of this.actors.values()) this.releaseQuoteWatch(actor);
    this.actors.clear();
    // A process may have exited while a pause/stop was waiting for remote cancellation. Once every
    // persisted order is confirmed terminal, finish that state transition before any RUNNING
    // strategy is allowed to resume.
    for (const record of this.runtime.listStrategies()) {
      if (record.status !== 'PAUSE_PENDING_REMOTE' && record.status !== 'STOP_PENDING_REMOTE') continue;
      const actor = this.attach(record, true);
      actor.quiesceTarget = record.status === 'PAUSE_PENDING_REMOTE' ? 'PAUSED' : 'STOPPED';
      actor.quiesceReason = 'Recovered pending safety transition after restart';
      await this.maintainQuiesce(actor);
      if (this.actors.has(record.id)) {
        throw new StrategyEngineError('strategy_recovery_unresolved', 409, record.id, {
          strategyId: record.id,
          unresolvedOrders: unresolvedOrderDetails(actor.unresolvedOrders),
        });
      }
    }
  }

  activatePersistedStrategies(credentialProfileId?: string | null): void {
    if (!this.session.liveTradingEnabled) return;
    for (const record of this.runtime.listStrategies()) {
      if (record.status !== 'RUNNING') continue;
      if (credentialProfileId !== undefined
        && record.accountProfileId !== credentialProfileId
        // Legacy rows without an owner are considered part of the active account until reviewed.
        && record.accountProfileId !== null) continue;
      if (this.actors.has(record.id)) continue;
      const actor = this.attach(record);
      // A restart loses the hub's in-memory market table (only seeds remain), so re-register and
      // re-watch this strategy's symbols before the next tick. Without it the recovered actor
      // never receives ticker frames for its symbols and silently stops quoting.
      this.ensureActorMarkets(actor);
      this.runtime.addStrategyLog(record.id, 'info', 'Strategy resumed', 'Live mode enabled after order reconciliation', '—', 'Monitoring live spreads · leg quotes re-subscribed');
    }
  }

  async suspendForTradingLock(): Promise<Array<{ order: ExecutionOrder; reason: string }>> {
    for (const actor of this.actors.values()) actor.suspended = true;
    await Promise.all([...this.actors.values()].map((actor) => actor.queue.catch(() => undefined)));
    const result = await this.runtime.quiesceOpenOrders({ timeoutMs: this.options.orderTimeoutMs });
    if (result.unresolved.length === 0) {
      for (const actor of this.actors.values()) actor.quotes.clear();
      for (const actor of this.actors.values()) this.releaseQuoteWatch(actor);
      this.actors.clear();
    }
    return result.unresolved;
  }

  /**
   * A saved strategy belongs to the account on which it was created. Credential replacement can
   * point at a different Gate account even when the user reuses the same connection label, so a
   * successful credential mutation must make persisted RUNNING strategies non-resumable before
   * the new profile can become active.
   */
  runningStrategiesForCredentialProfile(credentialProfileId?: string | null): StrategyRecord[] {
    return this.runtime.listStrategies().filter((record) => record.status === 'RUNNING'
      && (credentialProfileId === undefined
        || record.accountProfileId === credentialProfileId
        // Legacy strategies are treated as belonging to the account active during migration.
        || record.accountProfileId === null));
  }

  pauseRunningStrategiesForCredentialChange(credentialProfileId?: string | null): number {
    const running = this.runningStrategiesForCredentialProfile(credentialProfileId);
    if (running.length === 0) return 0;
    const updatedAt = new Date().toISOString();
    const update = this.database.prepare(`UPDATE execution_strategies
      SET status = 'PAUSED', updated_at = ?
      WHERE id = ? AND status = 'RUNNING'`);
    this.database.transaction(() => {
      for (const record of running) update.run(updatedAt, record.id);
    })();
    for (const actor of this.actors.values()) actor.suspended = true;
    for (const actor of this.actors.values()) this.releaseQuoteWatch(actor);
    this.actors.clear();
    this.ledgerCache.clear();
    for (const record of running) {
      this.runtime.addStrategyLog(record.id, 'warning', 'Strategy paused',
        'Account credentials changed', '—', 'Manual review required before trading this strategy again');
      this.runtime.emitStrategyUpdate(this.runtime.getStrategy(record.id));
    }
    return running.length;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    await this.tickRun?.catch(() => undefined);
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const actor of this.actors.values()) actor.suspended = true;
    await Promise.all([...this.actors.values()].map((actor) => actor.queue.catch(() => undefined)));
    const result = await this.runtime.quiesceOpenOrders({ timeoutMs: this.options.orderTimeoutMs });
    for (const { order, reason } of result.unresolved) {
      if (!order.strategyId) continue;
      this.runtime.addStrategyLog(order.strategyId, 'error', 'Shutdown cancellation pending',
        'Remote cancellation not confirmed', '—',         `${order.id} · ${reason}`);
    }
    for (const actor of this.actors.values()) this.releaseQuoteWatch(actor);
    this.actors.clear();
    this.ledgerCache.clear();
  }

  listActiveStrategyIds(): string[] {
    return [...this.actors.keys()];
  }

  async startStrategy(
    raw: unknown,
    account: { profileId: string; label: string } | null = null,
    options: { allowStaleQuote?: boolean } = {},
  ): Promise<StrategyRecord> {
    const input = CreateStrategyInputSchema.parse(raw);
    // Grid strategies remain readable/resumable for historical compatibility, but the product no
    // longer allows creating new premium grids.
    if (input.kind === 'premium' && input.grid) {
      throw new StrategyEngineError('premium_grid_mode_removed', 400);
    }
    // Auto thresholds are signed, so the classic "take profit below entry" sanity check only
    // applies to positive entries; negative entries enter cheap and always profit on regression.
    if (input.kind === 'auto' && input.takeProfitBps && input.entryBps
      && new Decimal(input.entryBps).gt(0)
      && new Decimal(input.takeProfitBps).gte(new Decimal(input.entryBps))) {
      throw new StrategyEngineError('take_profit_must_be_below_entry', 400);
    }
    // B1: the absolute stop must sit beyond |entry|, otherwise a position opened at the entry
    // level is already at/through its stop and could never be held — the effective buffer would be
    // zero or negative. Unified rule: stopLossBps > |entryBps| (signed entry, §2 B1).
    if (input.kind === 'auto' && input.stopLossBps && input.entryBps
      && new Decimal(input.stopLossBps).lte(new Decimal(input.entryBps).abs())) {
      throw new StrategyEngineError('stop_loss_not_above_entry', 400);
    }
    // Ladder (§8.6): the first add-on tier must still leave room below the stop line, otherwise
    // that tier can never be reached without tripping the stop first.
    if (input.kind === 'auto' && input.addOnStepBps && input.stopLossBps && input.entryBps
      && new Decimal(input.entryBps).abs().plus(new Decimal(input.addOnStepBps))
        .gte(new Decimal(input.stopLossBps))) {
      throw new StrategyEngineError('add_on_step_beyond_stop_loss', 400);
    }
    if (input.kind === 'premium' && !input.grid && !input.reduceOnly
      && input.entryPremiumPct !== undefined && input.takeProfitPremiumPct !== undefined) {
      const entry = new Decimal(input.entryPremiumPct);
      const takeProfit = new Decimal(input.takeProfitPremiumPct);
      // Short premium (SELL the ADR) profits as the premium falls; long premium as it rises.
      if (input.leftSide === 'SELL' && takeProfit.gte(entry)) throw new StrategyEngineError('take_profit_must_be_below_entry', 400);
      if (input.leftSide === 'BUY' && takeProfit.lte(entry)) throw new StrategyEngineError('take_profit_must_be_above_entry', 400);
    }
    if (!this.session.liveTradingEnabled) throw new StrategyEngineError('live_trading_locked', 403);
    const running = this.runtime.listStrategies().filter((strategy) => strategy.status === 'RUNNING');
    if (running.length >= 10) throw new StrategyEngineError('too_many_running_strategies', 409);
    let marginPreflight = { requiredMargin: '0', availableMargin: '0' };
    // The engine owns its legs' ticker subscriptions: nothing else watches strategy symbols, so
    // without subscribing here the fresh-price wait below would always time out on a dynamic
    // symbol. The subscription lives from here until the runtime actor takes ownership; any
    // failure in between (validation, margin preflight, persistence) releases it in `finally`.
    let launchQuoteWatchRelease: (() => void) | null = null;
    let staleQuoteFallback = false;
    try {
      if (input.closePlan) {
        for (const target of input.closePlan.targets) {
          if (!this.markets.market(target.symbol) && !this.markets.ensureMarket?.(target.symbol)) {
            throw new StrategyEngineError('unknown_strategy_market', 400);
          }
        }
        this.validateClosePlanOrderSizes(input);
        // No launch-time position preflight (R3): the ledger's quantities may be stale — the user
        // may have flattened a leg on the exchange itself — and blocking the close on that would
        // lock the user out of "Close all" exactly when they need it. Every slice reconciles
        // against the venue at execution time instead: an oversized reduce-only order is rejected,
        // re-sized from a fresh position read, and retried; an already-flat leg is marked satisfied.
      } else {
        const legs = legsOf(input);
        for (const leg of [legs.left, legs.right]) {
          if (!this.markets.market(leg.symbol) && !this.markets.ensureMarket?.(leg.symbol)) {
            throw new StrategyEngineError('unknown_strategy_market', 400);
          }
        }
        launchQuoteWatchRelease = this.openLegWatch([legs.left.symbol, legs.right.symbol]);
        // Dynamic symbols may still be waiting for their first ticker frame; wait for live prices
        // instead of rejecting a tradable strategy at the first size/price check below. A manual
        // launch (the operator already decided from historical data) may fall back to the latest
        // non-zero quote after the fresh-price wait expires instead of refusing to open at all.
        staleQuoteFallback = await this.awaitFreshMarketPair(legs, options.allowStaleQuote === true);
        this.validateStrategyOrderSizes(input, legs);
        marginPreflight = await this.prepareStrategy(input, legs, options.allowStaleQuote === true);
      }
      const prefix = input.closePlan ? 'CLOSE' : input.kind === 'auto' ? 'AUTO' : input.kind === 'premium' ? 'PREM' : input.kind === 'carry' ? 'CARRY' : 'PAIR';
      const id = `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json, progress,
        filled_quantity, filled_left, filled_right, open_position, credential_profile_id,
        credential_profile_label, created_at, updated_at, stopped_at)
        VALUES (?, ?, 'live', 'RUNNING', ?, 0, '0', '0', '0', '0', ?, ?, ?, ?, NULL)`)
        .run(id, input.kind, JSON.stringify(input), account?.profileId ?? null, account?.label ?? null, now, now);
      const shortPremium = input.leftSide === 'SELL';
      const hedgeModeLabel = input.hedgeMode === 'EQUAL_NOTIONAL' ? 'equal-notional hedge' : 'share-ratio hedge';
      const startCondition = input.closePlan
        ? `${input.closePlan.orderCount} reduce-only slices · ${input.closePlan.intervalSeconds}s interval`
        : input.kind === 'premium'
        ? input.grid
          ? `Grid ${input.gridLevels} × ${input.gridStepPct}% from ${input.entryPremiumPct}% premium · ${hedgeModeLabel}`
          : input.reduceOnly
            ? `Reduce existing positions at ${shortPremium ? '≥' : '≤'} ${input.entryPremiumPct}% premium · ${hedgeModeLabel}`
            : `Enter ${shortPremium ? '≥' : '≤'} ${input.entryPremiumPct}% · exit ${shortPremium ? '≤' : '≥'} ${input.takeProfitPremiumPct}% premium · ${hedgeModeLabel}`
        : input.kind === 'auto'
          ? `Enter ${input.entryBps && new Decimal(input.entryBps).lt(0) ? '≤' : '≥'} ${input.entryBps} bps · exit ${input.takeProfitBps ? `≤ ${input.takeProfitBps} bps` : 'on take profit'}${input.stopLossBps ? ` · stop-loss ${input.stopLossBps} bps` : ''}`
          : input.kind === 'carry'
            ? `${input.fundingDirection} funding carry · APR ≥ ${input.fundingAprMin}% · basis take-profit ${input.basisTakeProfitBps} bps`
            // A position strategy now carries the same exit thresholds the engine executes, so the
            // launch row states them explicitly instead of implying the fields are decorative.
            : `Enter ${input.entryBps && new Decimal(input.entryBps).lt(0) ? '≤' : '≥'} ${input.entryBps} bps`
              + `${input.takeProfitBps ? ` · take-profit ${input.takeProfitBps} bps` : ''}`
              + `${input.stopLossBps ? ` · stop-loss ${input.stopLossBps} bps` : ''}`
              + `${input.maxPosition ? ` · max ${input.maxPosition} ${input.asset}` : ''}`;
      if (staleQuoteFallback) {
        this.runtime.addStrategyLog(id, 'warning', 'Started on latest available quote', '—',
          '—', 'Fresh WebSocket quote unavailable; using the most recent non-zero market quote for entry sizing');
      }
      this.runtime.addStrategyLog(id, 'info', 'Strategy started', startCondition,
        input.closePlan ? `${input.closePlan.targets.length} position${input.closePlan.targets.length === 1 ? '' : 's'}` : `${input.perOrderQuantity} ${input.asset}`,
        input.closePlan
          ? 'Timed reduce-only close · existing positions validated before scheduling'
          : input.reduceOnly
          ? 'Reduce-only mode · existing positions validated on both legs'
          : `Leverage ${input.leftLeverage ?? '1'}× / ${input.rightLeverage ?? '1'}× · reserved margin ${marginPreflight.requiredMargin} of ${marginPreflight.availableMargin}`);
      const record = this.runtime.getStrategy(id);
      const actor = this.attach(record);
      // Keep the legs' ticker subscription alive for the whole strategy lifetime.
      actor.quoteWatchRelease = launchQuoteWatchRelease;
      launchQuoteWatchRelease = null;
      this.runtime.emitStrategyUpdate(record);
      return record;
    } finally {
      launchQuoteWatchRelease?.();
    }
  }

  async stopStrategy(id: string): Promise<StrategyRecord> {
    const record = this.runtime.getStrategy(id);
    let actor = this.actors.get(id);
    if (!actor && ['RUNNING', 'PAUSE_PENDING_REMOTE', 'STOP_PENDING_REMOTE'].includes(record.status)) {
      actor = this.attach(record, true);
    }
    if (actor) {
      actor.suspended = true;
      actor.quiesceTarget = 'STOPPED';
      actor.quiesceReason = 'Manual stop';
      await actor.queue.catch(() => undefined);
      const finished = await this.finishQuiesce(actor);
      if (!finished) throw new StrategyEngineError('strategy_stop_pending_remote', 409);
    } else if (record.status === 'PAUSED') {
      const now = new Date().toISOString();
      this.database.prepare("UPDATE execution_strategies SET status = 'STOPPED', stopped_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    }
    const stopped = this.runtime.getStrategy(id);
    this.runtime.emitStrategyUpdate(stopped);
    return stopped;
  }

  async resumeStrategy(id: string, credentialProfileId: string): Promise<StrategyRecord> {
    if (!this.session.liveTradingEnabled) throw new StrategyEngineError('live_trading_locked', 403);
    const record = this.runtime.getStrategy(id);
    if (record.status !== 'PAUSED') throw new StrategyEngineError('strategy_not_paused', 409);
    if (record.accountProfileId !== null && record.accountProfileId !== credentialProfileId) {
      throw new StrategyEngineError('strategy_account_not_active', 409);
    }
    if (this.actors.has(id)) throw new StrategyEngineError('strategy_already_active', 409);
    if (this.runtime.listStrategies().filter((strategy) => strategy.status === 'RUNNING').length >= 10) {
      throw new StrategyEngineError('too_many_running_strategies', 409);
    }

    // PAUSED normally means every order was already confirmed terminal. Re-prove that invariant
    // here so a stale or externally modified database row can never re-arm live execution while
    // an older remote order is still working.
    const quiesced = await this.runtime.quiesceOpenOrders({
      strategyId: id,
      timeoutMs: this.options.orderTimeoutMs,
    });
    if (quiesced.unresolved.length > 0) {
      throw new StrategyEngineError('strategy_resume_unresolved_orders', 409,
        quiesced.unresolved.map(({ order }) => order.id).join(','));
    }

    const config = record.config;
    // The subscription lives from here until the runtime actor takes ownership; any failure in
    // between (fresh-price wait, size checks, the post-wait re-checks, persistence) — including a
    // concurrent request consuming the final running slot while the wait runs — releases it.
    let resumeQuoteWatchRelease: (() => void) | null = null;
    try {
      if (config.closePlan) {
        for (const target of config.closePlan.targets) {
          if (!this.markets.market(target.symbol) && !this.markets.ensureMarket?.(target.symbol)) {
            throw new StrategyEngineError('unknown_strategy_market', 400);
          }
        }
        this.validateClosePlanOrderSizes(config);
        // No position preflight on resume either (R3): slices reconcile venue truth at execution.
      } else {
        const legs = legsOf(config);
        for (const leg of [legs.left, legs.right]) {
          if (!this.markets.market(leg.symbol) && !this.markets.ensureMarket?.(leg.symbol)) {
            throw new StrategyEngineError('unknown_strategy_market', 400);
          }
        }
        // The engine owns its legs' subscriptions: nothing else watches strategy symbols, so
        // without subscribing here the fresh-price wait below would always time out on a
        // dynamic symbol. The book watch is what keeps a quote on the record at all for a
        // venue whose ticker omits bid/ask.
        resumeQuoteWatchRelease = this.openLegWatch([legs.left.symbol, legs.right.symbol]);
        await this.awaitFreshMarketPair(legs);
        this.validateStrategyOrderSizes(config, legs);
        await this.prepareStrategy(config, legs);
      }

      // Re-check after the asynchronous account and order preflights. Another request may have
      // locked trading, resumed this strategy, or consumed the final running-strategy slot in the
      // meantime.
      if (!this.session.liveTradingEnabled) throw new StrategyEngineError('live_trading_locked', 403);
      const current = this.runtime.getStrategy(id);
      if (current.status !== 'PAUSED') throw new StrategyEngineError('strategy_not_paused', 409);
      if (current.accountProfileId !== null && current.accountProfileId !== credentialProfileId) {
        throw new StrategyEngineError('strategy_account_not_active', 409);
      }
      if (this.runtime.listStrategies().filter((strategy) => strategy.status === 'RUNNING').length >= 10) {
        throw new StrategyEngineError('too_many_running_strategies', 409);
      }

      const now = new Date().toISOString();
      const updated = this.database.prepare(`UPDATE execution_strategies
        SET status = 'RUNNING', stopped_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'PAUSED'`).run(now, id);
      if (updated.changes !== 1) throw new StrategyEngineError('strategy_not_paused', 409);
      this.runtime.addStrategyLog(id, 'info', 'Strategy resumed', 'Manual resume', '—', 'Preflight passed · monitoring live spreads');
      const resumed = this.runtime.getStrategy(id);
      const actor = this.attach(resumed);
      // Keep the legs' ticker subscription alive for the whole strategy lifetime.
      actor.quoteWatchRelease = resumeQuoteWatchRelease;
      resumeQuoteWatchRelease = null;
      this.runtime.emitStrategyUpdate(resumed);
      return resumed;
    } finally {
      resumeQuoteWatchRelease?.();
    }
  }

  async updatePremiumTakeProfit(id: string, raw: unknown): Promise<StrategyRecord> {
    const input = UpdatePremiumTakeProfitInputSchema.parse(raw);
    if (!this.session.liveTradingEnabled) throw new StrategyEngineError('live_trading_locked', 403);
    const record = this.runtime.getStrategy(id);
    if (record.kind !== 'premium' || record.config.grid || record.config.reduceOnly) {
      throw new StrategyEngineError('take_profit_update_not_supported', 400);
    }
    if (record.status !== 'RUNNING') {
      throw new StrategyEngineError('strategy_not_running', 409);
    }
    this.validatePremiumTakeProfit(record.config, input);

    const actor = this.actors.get(id);
    if (!actor) throw new StrategyEngineError('strategy_not_active', 409);

    // Serialize the change with trigger evaluation so no tick can observe a database config that
    // differs from the live actor config.
    const update = actor.queue.then(() => {
      const current = this.runtime.getStrategy(id);
      if (current.status !== 'RUNNING') {
        throw new StrategyEngineError('strategy_not_running', 409);
      }
      this.validatePremiumTakeProfit(current.config, input);
      const previousTakeProfit = current.config.takeProfitPremiumPct;
      const nextConfig: CreateStrategyInput = {
        ...current.config,
        takeProfitPremiumPct: input.takeProfitPremiumPct,
      };
      const now = new Date().toISOString();
      this.database.transaction(() => {
        this.database.prepare('UPDATE execution_strategies SET config_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(nextConfig), now, id);
        this.runtime.addStrategyLog(id, 'info', 'Take-profit updated',
          `${previousTakeProfit}% → ${input.takeProfitPremiumPct}%`, '—', 'Monitoring live premium');
      })();
      actor.config = nextConfig;
      this.invalidateLedger(id);
      const updated = this.runtime.getStrategy(id);
      this.runtime.emitStrategyUpdate(updated);
      return updated;
    });
    actor.queue = update.then(() => undefined, () => undefined);
    return update;
  }

  /** Evaluate every active strategy once. Exposed for deterministic tests. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.tickRun) {
      // Keep only one follow-up pass. Further interval ticks are superseded because that pending
      // pass will already observe newer market and execution state.
      this.tickRequested = true;
      return this.tickRun;
    }
    const run = this.drainTicks();
    this.tickRun = run;
    try {
      await run;
    } finally {
      if (this.tickRun === run) this.tickRun = null;
    }
  }

  private async drainTicks(): Promise<void> {
    do {
      this.tickRequested = false;
      await this.tickOnce();
    } while (this.tickRequested && !this.stopped);
  }

  private async tickOnce(): Promise<void> {
    for (const actor of [...this.actors.values()]) {
      this.enqueue(actor, () => actor.suspended ? this.maintainQuiesce(actor) : this.evaluate(actor));
    }
    await Promise.all([...this.actors.values()].map((actor) => actor.queue.catch(() => undefined)));
  }

  /**
   * Re-subscribes a recovered strategy's symbols to the market hub during restart recovery. The
   * hub's in-memory market table starts nearly empty (seeds only) after a restart, so a recovered
   * RUNNING strategy receives no ticker frames for its symbols until they are registered and
   * watched — which is why, without this, only the strategy currently on screen appeared to trade.
   * Mirrors the proven start/resume subscription path: `ensureMarket` registers a catalog-known
   * dynamic symbol and `openLegWatch` opens its ticker plus order-book subscriptions, whose
   * releases are tracked on the actor so the existing `releaseQuoteWatch` tears them down on
   * stop/pause/credential change.
   * Best-effort and throw-free: a symbol that can no longer be registered must not abort recovery.
   */
  private ensureActorMarkets(actor: StrategyActor): void {
    try {
      // Register a symbol with the hub, reporting a miss instead of idling silently: a recovered
      // strategy that never receives a ticker frame otherwise looks healthy while writing no rows.
      const register = (symbol: string): void => {
        let ok = false;
        try { ok = Boolean(this.markets.market(symbol)) || Boolean(this.markets.ensureMarket?.(symbol)); }
        catch { ok = false; }
        if (ok) return;
        this.runtime.addStrategyLog(actor.id, 'warning', 'Strategy market unavailable', symbol, '—',
          'Symbol is absent from the market catalog and could not be registered; the recovered strategy has no live feed for it');
      };
      if (actor.config.closePlan) {
        const symbols = [...new Set(actor.config.closePlan.targets.map((target) => target.symbol))];
        for (const symbol of symbols) register(symbol);
        // Mirror the start/resume paths: hold the symbols' subscriptions for the whole
        // strategy lifetime. Without them a long close interval (or a hub sweep) leaves a
        // settlement slice with no prices and it fails with `strategy_market_data_unavailable`.
        actor.quoteWatchRelease = this.openLegWatch(symbols);
        return;
      }
      const legs = legsOf(actor.config);
      for (const leg of [legs.left, legs.right]) register(leg.symbol);
      // Keep the legs' subscriptions alive for the whole recovered strategy lifetime.
      actor.quoteWatchRelease = this.openLegWatch([legs.left.symbol, legs.right.symbol]);
    } catch { /* Recovery must never fail because a symbol could not be re-registered. */ }
  }

  /** Releases a strategy's leg-symbol quote subscription exactly once; safe to call repeatedly. */
  private releaseQuoteWatch(actor: StrategyActor): void {
    const release = actor.quoteWatchRelease;
    if (!release) return;
    actor.quoteWatchRelease = null;
    try {
      release();
    } catch { /* A broken release must never break strategy teardown. */ }
  }

  /**
   * Opens every hub subscription a strategy's legs need and returns one release for all of
   * them. The ticker watch keeps the symbols registered and streaming; the order-book watch is
   * what actually keeps an executable quote on the record when a venue's sparse ticker omits
   * bid/ask — the hub can then back the quote from the maintained book instead of leaving the
   * stored one to age out. A source without either capability yields null, and every release is
   * individually guarded so one broken subscription cannot orphan the others.
   */
  private openLegWatch(symbols: string[]): (() => void) | null {
    const releases: Array<() => void> = [];
    const quotes = this.markets.watchQuotes?.(symbols);
    if (quotes) releases.push(quotes);
    for (const symbol of symbols) {
      const book = this.markets.watchOrderBook?.(symbol);
      if (book) releases.push(book);
    }
    if (releases.length === 0) return null;
    return () => {
      for (const release of releases) {
        try { release(); } catch { /* One broken release must not orphan the rest. */ }
      }
    };
  }

  private attach(record: StrategyRecord, suspended = false): StrategyActor {
    // Replacing a stale actor must not leak its leg quote subscription.
    const existing = this.actors.get(record.id);
    if (existing) this.releaseQuoteWatch(existing);
    this.invalidateLedger(record.id);
    const actor: StrategyActor = {
      id: record.id, config: record.config, kind: record.kind, status: record.status,
      busy: false, queue: Promise.resolve(), quotes: new Map(), repairAttempts: 0,
      lastRepairAt: 0, failureCount: 0, cooldownUntil: 0, lastQuoteAt: 0,
      suspended, quiesceTarget: null, quiesceReason: null, unresolvedOrders: [], createdAt: Date.parse(record.createdAt),
      lastCloseAt: Date.parse(record.updatedAt),
      stopLossArmed: false,
      venueExitQuantity: null,
      venueExitQuantitySymbol: null,
      closePlanSatisfied: new Set<number>(),
      makerEntryParked: false,
      settlementExitAt: null,
      positionOpenedAt: null,
      fundingDecaySince: null,
      fundingAprReadings: [],
      makerExitArmed: false,
      makerExitStartedAt: null,
      makerExitFallbackLogged: false,
      makerExitHedge: null,
      makerExitHedgeRequotes: 0,
      makerExitHedgeFailures: 0,
      makerExitHedgeRetryAt: 0,
      positionExitArmed: false,
      positionExitReason: null,
      positionCapBlocked: false,
      carry: record.kind === 'carry' ? emptyCarryState() : null,
      lastCarryMetricsJson: null,
      quoteWatchRelease: null,
    };
    this.actors.set(record.id, actor);
    return actor;
  }

  private validatePremiumTakeProfit(config: CreateStrategyInput, input: UpdatePremiumTakeProfitInput): void {
    const entry = new Decimal(config.entryPremiumPct ?? '0');
    const takeProfit = new Decimal(input.takeProfitPremiumPct);
    if (config.leftSide === 'SELL' && takeProfit.gte(entry)) {
      throw new StrategyEngineError('take_profit_must_be_below_entry', 400);
    }
    if (config.leftSide === 'BUY' && takeProfit.lte(entry)) {
      throw new StrategyEngineError('take_profit_must_be_above_entry', 400);
    }
  }

  /**
   * Price the strategy's entire configured capacity, not just its first clip. This prevents any
   * paired or continuously accumulating strategy from launching with enough margin for one order
   * but not for the maximum exposure the user authorized.
   */
  private async prepareStrategy(
    config: CreateStrategyInput,
    legs: { left: LegDefinition; right: LegDefinition },
    allowStaleQuote = false,
  ): Promise<{ requiredMargin: string; availableMargin: string }> {
    const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol)
      ?? (allowStaleQuote ? this.latestMarketPair(legs.left.symbol, legs.right.symbol) : null);
    if (!pair) throw new StrategyEngineError('strategy_market_data_unavailable', 409);
    const { left: leftMarket, right: rightMarket } = pair;
    const executablePrice = (market: LiveMarket, side: 'BUY' | 'SELL') =>
      new Decimal(side === 'BUY' ? market.askPrice : market.bidPrice);
    const leftPrice = executablePrice(leftMarket, legs.left.side);
    const rightPrice = executablePrice(rightMarket, legs.right.side);
    if (!leftPrice.gt(0) || !rightPrice.gt(0)) {
      throw new StrategyEngineError('strategy_market_data_unavailable', 409);
    }
    const target = this.strategyTarget(config);
    const leftNotional = target.mul(leftPrice);
    const rightQuantity = config.kind !== 'premium'
      ? target
      : this.equalNotional(config)
        ? leftNotional.div(rightPrice)
        : target.div(adrRatioOf(config));
    const plannedLegs = [
      {
        symbol: legs.left.symbol,
        venue: legs.left.venue,
        side: legs.left.side,
        leverage: config.leftLeverage ?? '1',
        estimatedQuantity: target.toString(),
        estimatedPrice: leftPrice.toString(),
      },
      {
        symbol: legs.right.symbol,
        venue: legs.right.venue,
        side: legs.right.side,
        // Carry reserves margin at the configured contract leverage preset.
        leverage: config.kind === 'carry' ? config.contractLeverage ?? '1' : config.rightLeverage ?? '1',
        estimatedQuantity: rightQuantity.toString(),
        estimatedPrice: rightPrice.toString(),
      },
    ];
    if (config.reduceOnly) {
      await this.runtime.prepareReduceOnlyStrategy(plannedLegs);
      return { requiredMargin: '0', availableMargin: '0' };
    }
    // Carry must not touch the account leverage preset: the perp leg trades at whatever the user
    // configured, and the engine only reserves margin against that preset.
    return this.runtime.prepareStrategyMargin(plannedLegs, { mutateLeverage: config.kind !== 'carry' });
  }

  private enqueue(actor: StrategyActor, work: () => Promise<void>): void {
    actor.queue = actor.queue.then(work).catch((error: unknown) => {
      this.runtime.addStrategyLog(actor.id, 'error', 'Strategy engine error', '—', '—',
        error instanceof Error ? error.message.slice(0, 200) : 'unknown error');
    });
  }

  private freshMarket(symbol: string): LiveMarket | null {
    if (this.markets.connectionState && this.markets.connectionState() !== 'healthy') return null;
    const market = this.markets.market(symbol);
    if (!market || market.source !== 'gate_crossex_websocket') return null;
    const sourceTimestamp = Date.parse(market.updatedAt);
    const receivedTimestamp = Date.parse(market.receivedAt);
    const age = this.options.now() - sourceTimestamp;
    const transportLag = receivedTimestamp - sourceTimestamp;
    if (!Number.isFinite(age)
      || !Number.isFinite(transportLag)
      || age > this.options.marketFreshnessMs
      || age < -this.options.futureQuoteToleranceMs
      || transportLag > this.options.marketMaxTransportLagMs) return null;
    // The frame-level gate above says "this symbol is streaming". The quote-level gate says the
    // bid/ask we are about to read came from that stream: a sparse ticker carrying only `lp`
    // refreshes `updatedAt` while leaving the stored quote behind, so judging the quote by the
    // frame's age is what let a stale price pass as fresh market data.
    const quoteTimestamp = market.quoteUpdatedAt === undefined ? Number.NaN : Date.parse(market.quoteUpdatedAt);
    const quoteAge = this.options.now() - quoteTimestamp;
    if (!Number.isFinite(quoteAge)
      || quoteAge > this.options.marketFreshnessMs
      || quoteAge < -this.options.futureQuoteToleranceMs) return null;
    return market;
  }

  private freshMarketPair(
    leftSymbol: string,
    rightSymbol: string,
  ): { left: LiveMarket; right: LiveMarket } | null {
    const left = this.freshMarket(leftSymbol);
    const right = this.freshMarket(rightSymbol);
    if (!left || !right) return null;
    // Two individually fresh quotes can still be minutes apart in exchange time. A spread
    // computed across them describes a pair that never coexisted on either venue, which is
    // exactly the mismatch that showed up as fills far from the triggered bps.
    const leftQuote = Date.parse(left.quoteUpdatedAt ?? '');
    const rightQuote = Date.parse(right.quoteUpdatedAt ?? '');
    if (!Number.isFinite(leftQuote) || !Number.isFinite(rightQuote)) return null;
    if (Math.abs(leftQuote - rightQuote) > this.options.marketPairMaxSkewMs) return null;
    return { left, right };
  }

  /**
   * Wait until both legs expose a fresh, non-zero executable price before validating a launch.
   * A dynamically ensured symbol registers as a zero-priced placeholder until its first ticker
   * frame arrives, so checking immediately after `ensureMarket` would reject perfectly tradable
   * strategies with `strategy_market_data_unavailable`. Poll instead and reject only once the
   * wait budget is exhausted (upstream down, unknown symbol, or a genuinely dead feed).
   */
  private async awaitFreshMarketPair(
    legs: { left: LegDefinition; right: LegDefinition },
    allowStaleFallback = false,
  ): Promise<boolean> {
    const deadline = this.options.now() + this.options.marketDataWaitTimeoutMs;
    const executablePrice = (market: LiveMarket, side: 'BUY' | 'SELL') =>
      new Decimal(side === 'BUY' ? market.askPrice : market.bidPrice);
    for (;;) {
      const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol);
      if (pair
        && executablePrice(pair.left, legs.left.side).gt(0)
        && executablePrice(pair.right, legs.right.side).gt(0)) return false;
      if (this.options.now() >= deadline) {
        if (allowStaleFallback) {
          const latest = this.latestMarketPair(legs.left.symbol, legs.right.symbol);
          if (latest
            && executablePrice(latest.left, legs.left.side).gt(0)
            && executablePrice(latest.right, legs.right.side).gt(0)) return true;
        }
        throw new StrategyEngineError('strategy_market_data_unavailable', 409,
          `${legs.left.symbol}, ${legs.right.symbol}`);
      }
      // The symbol may have been swept between the caller's ensure and this wait; re-ensuring is
      // idempotent and keeps a slow subscription from turning into a hard launch failure.
      for (const leg of [legs.left, legs.right]) {
        if (!this.markets.market(leg.symbol)) this.markets.ensureMarket?.(leg.symbol);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, MARKET_WAIT_POLL_MS));
    }
  }

  /**
   * Latest executable pair ignoring freshness/skew. Manual launches are decided from historical
   * data; after the fresh-price wait they may proceed on the most recent non-zero quote and let
   * the continuous watchers upgrade it to live prices once the strategy is running.
   */
  private latestMarketPair(
    leftSymbol: string,
    rightSymbol: string,
  ): { left: LiveMarket; right: LiveMarket } | null {
    const left = this.markets.market(leftSymbol);
    const right = this.markets.market(rightSymbol);
    if (!left || !right) return null;
    if (Number(left.bidPrice) <= 0 || Number(left.askPrice) <= 0) return null;
    if (Number(right.bidPrice) <= 0 || Number(right.askPrice) <= 0) return null;
    return { left, right };
  }

  private strategyLedger(strategyId: string): StrategyLedgerCache {
    const cached = this.ledgerCache.get(strategyId);
    // Execution events invalidate immediately. This TTL provides periodic durable reconciliation
    // for any missed or legacy update path without returning to per-tick database scans.
    if (cached && this.options.now() - cached.loadedAt < 5_000) return cached;
    const loaded: StrategyLedgerCache = {
      loadedAt: this.options.now(),
      rows: this.strategyOrderRowsStatement.all(strategyId) as StrategyOrderRow[],
    };
    this.ledgerCache.set(strategyId, loaded);
    return loaded;
  }

  private invalidateLedger(strategyId: string): void {
    this.ledgerCache.delete(strategyId);
  }

  /**
   * Exit state is derived from durable order history so a restarted backend cannot re-enter a
   * premium strategy after take profit has begun. Checking both the side and reduce-only flag
   * avoids mistaking a reduce-only entry configuration for a take-profit order.
   */
  private premiumExitStarted(actor: StrategyActor): boolean {
    if (actor.kind !== 'premium') return false;
    const ledger = this.strategyLedger(actor.id);
    const configKey = JSON.stringify(actor.config);
    if (ledger.configKey === configKey && ledger.premiumExitStarted !== undefined) {
      return ledger.premiumExitStarted;
    }
    const legs = legsOf(actor.config);
    const started = ledger.rows.some((row) => row.reduce_only === 1 && (
      (row.leg === 'left' && row.side === oppositeSide(legs.left.side))
      || (row.leg === 'right' && row.side === oppositeSide(legs.right.side))
    ));
    ledger.configKey = configKey;
    ledger.premiumExitStarted = started;
    return started;
  }

  /**
   * True when the ledger already holds a reduce-only order on the *closing* side of either leg —
   * the durable trace of a take-profit / stop-loss unwind for a monitored position strategy.
   *
   * `positionExitArmed` lives in memory only, so a backend restart between an armed trigger and the
   * exit's fill would otherwise leave a finished strategy looking like an untouched one: flat
   * exposure, `RUNNING`, and no completion possible. This mirrors `premiumExitStarted`, which
   * solves the same problem for the ADR bot. It is only consulted for strategies that actually
   * monitor a spread (`positionMonitoringEnabled`), so a reduce-only position strategy — whose whole
   * purpose is reduce-only orders on the entry sides — can never be mistaken for an exited one.
   */
  private positionExitStarted(actor: StrategyActor): boolean {
    if (actor.kind !== 'position') return false;
    const ledger = this.strategyLedger(actor.id);
    const configKey = JSON.stringify(actor.config);
    if (ledger.configKey === configKey && ledger.positionExitStarted !== undefined) {
      return ledger.positionExitStarted;
    }
    const legs = legsOf(actor.config);
    const started = ledger.rows.some((row) => row.reduce_only === 1 && (
      (row.leg === 'left' && row.side === oppositeSide(legs.left.side))
      || (row.leg === 'right' && row.side === oppositeSide(legs.right.side))
    ));
    ledger.configKey = configKey;
    ledger.positionExitStarted = started;
    return started;
  }

  private equalNotional(config: CreateStrategyInput): boolean {
    return config.kind === 'premium' && config.hedgeMode === 'EQUAL_NOTIONAL';
  }

  /**
   * Executed exposure per leg in left-leg (ADR) units, plus the raw right-leg venue shares.
   * SHARE_RATIO (and non-premium) strategies convert right-leg fills through the fixed ratio.
   * EQUAL_NOTIONAL clips have no strategy-wide conversion — each clip's hedge was sized at its
   * own execution prices — so right-leg fills convert through their clip's intended ratio.
   */
  private legExposures(strategyId: string, config: CreateStrategyInput): { left: Decimal; right: Decimal; rightShares: Decimal } {
    const ledger = this.strategyLedger(strategyId);
    const configKey = JSON.stringify(config);
    if (ledger.configKey === configKey && ledger.exposure) return ledger.exposure;
    const rows = ledger.rows;
    const fixedRatio = adrRatioOf(config);
    let left = ZERO;
    let right = ZERO;
    let rightShares = ZERO;
    if (!this.equalNotional(config)) {
      for (const row of rows) {
        const signed = signedExecuted(row);
        if (row.leg === 'left') left = left.plus(signed);
        else if (row.leg === 'right') {
          rightShares = rightShares.plus(signed);
          right = right.plus(signed.mul(fixedRatio));
        }
      }
      const exposure = { left, right, rightShares };
      ledger.configKey = configKey;
      ledger.exposure = exposure;
      return exposure;
    }
    for (const group of clipGroups(rows)) {
      const clipConversion = clipRatio(group, fixedRatio);
      for (const row of group.rows) {
        const signed = signedExecuted(row);
        if (row.leg === 'left') left = left.plus(signed);
        else if (row.leg === 'right') {
          rightShares = rightShares.plus(signed);
          right = right.plus(signed.div(clipConversion));
        }
      }
    }
    const exposure = { left, right, rightShares };
    ledger.configKey = configKey;
    ledger.exposure = exposure;
    return exposure;
  }

  /** Per-clip hedge shortfalls for equal-notional strategies, oldest clip first. */
  private clipShortfalls(strategyId: string, config: CreateStrategyInput): Array<{ clip: string | null; k: Decimal; lagging: 'left' | 'right'; delta: Decimal }> {
    const ledger = this.strategyLedger(strategyId);
    const configKey = JSON.stringify(config);
    if (ledger.configKey === configKey && ledger.shortfalls) return ledger.shortfalls;
    const fixedRatio = adrRatioOf(config);
    const shortfalls: Array<{ clip: string | null; k: Decimal; lagging: 'left' | 'right'; delta: Decimal }> = [];
    for (const group of clipGroups(ledger.rows)) {
      const k = clipRatio(group, fixedRatio);
      let left = ZERO;
      let rightConverted = ZERO;
      for (const row of group.rows) {
        const signed = signedExecuted(row);
        if (row.leg === 'left') left = left.plus(signed);
        else if (row.leg === 'right') rightConverted = rightConverted.plus(signed.div(k));
      }
      if (left.plus(rightConverted).abs().lte(QUANTITY_EPSILON)) continue;
      const lagging = left.abs().lt(rightConverted.abs()) ? 'left' : 'right';
      const laggingExposure = lagging === 'left' ? left : rightConverted;
      const otherExposure = lagging === 'left' ? rightConverted : left;
      shortfalls.push({ clip: group.clip, k, lagging, delta: otherExposure.neg().minus(laggingExposure) });
    }
    ledger.configKey = configKey;
    ledger.shortfalls = shortfalls;
    return shortfalls;
  }

  /** Aggregate unhedged quantity in ADR units — per clip for equal-notional, global otherwise. */
  private hedgeImbalance(strategyId: string, config: CreateStrategyInput, exposure: { left: Decimal; right: Decimal }): Decimal {
    if (this.equalNotional(config)) {
      return this.clipShortfalls(strategyId, config).reduce((sum, shortfall) => sum.plus(shortfall.delta.abs()), ZERO);
    }
    return exposure.left.plus(exposure.right).abs();
  }

  private matchedQuantity(exposure: { left: Decimal; right: Decimal }): Decimal {
    if (exposure.left.isZero() || exposure.right.isZero()) return ZERO;
    if (exposure.left.isNegative() === exposure.right.isNegative()) return ZERO;
    return Decimal.min(exposure.left.abs(), exposure.right.abs());
  }

  /**
   * Exit quantity after the venue-truth clamp. `venueExitQuantity` remembers what the venue
   * could actually reduce the last time it rejected a reduce-only exit for exceeding the
   * position, so every later tick re-reports at that size instead of resubmitting a doomed
   * order. The clamp retires itself once the ledger-derived quantity falls to it (the engine's
   * own fills closed the gap) and is cleared outright on any new fill. Null — the normal case —
   * returns the ledger quantity unchanged.
   *
   * The clamp is looked up by symbol: it holds one leg's real size, and the two legs of a pair
   * carry different quantities (the hedge leg is sized by the ADR ratio), so a clamp measured on
   * one leg is simply not applicable to an order on the other.
   */
  private exitQuantityFor(actor: StrategyActor, symbol: string, ledgerQuantity: Decimal): Decimal {
    const override = actor.venueExitQuantity;
    if (override === null || !override.isFinite() || override.isNegative()) return ledgerQuantity;
    if (actor.venueExitQuantitySymbol !== symbol) return ledgerQuantity;
    if (ledgerQuantity.lte(override)) {
      actor.venueExitQuantity = null;
      actor.venueExitQuantitySymbol = null;
      return ledgerQuantity;
    }
    return override;
  }

  /**
   * Reconcile positions from the venue right now, logging the outcome. Returns the refreshed
   * rows, or null when the read failed (the caller then keeps its ordinary accounting).
   */
  private async refreshVenuePositions(actor: StrategyActor): Promise<PortfolioFuturesPosition[] | null> {
    try {
      return await this.runtime.reconcilePositionsFromRemote();
    } catch (error) {
      this.runtime.addStrategyLog(actor.id, 'warning', 'Position reconciliation failed',
        '—', '—', error instanceof Error ? error.message.slice(0, 120) : 'reconciliation error');
      return null;
    }
  }

  /**
   * Reduce-only exit rejected because the venue holds less than the ledger believes
   * (TRADE_REDUCE_ONLY_POSITION_QTY_ERROR). Reconcile positions from the venue right now and
   * re-report at the venue's real size instead of burning the five-strike budget on a state
   * mismatch: the position was closed outside the engine (manually, by liquidation, or by the
   * opposite leg), and no amount of retrying changes the venue's answer. Falls back to the
   * ordinary rejection accounting when the venue confirms the ledger (or cannot be read), so a
   * genuine submission failure still surfaces through the usual path.
   *
   * Both exit paths land here — the maker exit quote (`maintainQuote`, which also rests a
   * reduce-only limit) and the taker exit clip (`executeTakerClip`, which is how a stop-loss or
   * take-profit unwinds). Leaving the taker path out is what let a stop-loss re-report a ghost
   * position five times in a minute and then pause the strategy.
   *
   * The requested quantity and the venue quantity are in the same units — `exitLegSymbol` is the
   * leg the venue enforces reduce-only on, i.e. the perpetual leg, and `requested` is that leg's
   * own order quantity — so the clamp needs no conversion. `'withdrawn'` means the venue holds
   * nothing reducible at all; the caller owns what that implies (a maker exit quote is withdrawn,
   * a taker exit clip stops the strategy).
   */
  private async reconcileExitQuantity(
    actor: StrategyActor,
    exitLegSymbol: string,
    exitLegSide: 'BUY' | 'SELL',
    requested: Decimal,
  ): Promise<'clamped' | 'withdrawn' | 'ordinary'> {
    this.runtime.addStrategyLog(actor.id, 'warning', 'Exit size drift',
      `Reduce-only exit for ${requested.toString()} ${actor.config.asset}`,
      requested.toString(), 'Venue rejected the reduce-only exit; reconciling positions');
    const positions = await this.refreshVenuePositions(actor);
    const venueQuantity = positions === null || isSpotSymbol(exitLegSymbol)
      ? null
      : venueReducibleQuantity(positions, exitLegSymbol, exitLegSide);
    if (venueQuantity === null || !venueQuantity.isFinite() || venueQuantity.gte(requested)) {
      // No new information: the venue agrees with the ledger (or the read failed), so this is
      // an ordinary rejection after all.
      return 'ordinary';
    }
    // The venue is the truth. Remember the clamp so later ticks re-report at this size, and
    // let the next tick place the corrected exit (a zero means the position is gone and the
    // exit is withdrawn until the venue holds something reducible again).
    const reducible = venueQuantity.gt(QUANTITY_EPSILON);
    actor.venueExitQuantity = venueQuantity;
    actor.venueExitQuantitySymbol = exitLegSymbol;
    actor.failureCount = 0;
    actor.cooldownUntil = this.options.now() + 250;
    this.runtime.addStrategyLog(actor.id, reducible ? 'info' : 'warning',
      reducible ? 'Exit size corrected' : 'Exit quote withdrawn',
      `Reduce-only exit for ${requested.toString()} ${actor.config.asset}`,
      requested.toString(),
      reducible
        ? `Venue holds ${venueQuantity.toString()}; re-reporting at the venue size`
        : 'Venue holds no reducible position on this leg');
    return reducible ? 'clamped' : 'withdrawn';
  }

  private openStrategyOrders(strategyId: string, excludeIds: Set<string>): ExecutionOrder[] {
    const ledger = this.strategyLedger(strategyId);
    ledger.openOrderIds ??= (this.openStrategyOrderIdsStatement.all(strategyId) as Array<{ id: string }>)
      .map((row) => row.id);
    return ledger.openOrderIds.filter((id) => !excludeIds.has(id)).map((id) => this.runtime.getOrder(id));
  }

  private constraintsFor(symbol: string): InstrumentConstraints {
    const cached = this.constraintCache.get(symbol);
    if (cached && this.options.now() - cached.cachedAt < 5 * 60_000) return cached.value;
    const row = this.instrumentConstraintsStatement.get(symbol) as {
      tick_size: string;
      lot_size: string;
      min_size: string;
      min_notional: string | null;
    } | undefined;
    const value: InstrumentConstraints = {
      tickSize: row?.tick_size ?? null,
      lotSize: row?.lot_size ?? null,
      minSize: row?.min_size ?? null,
      minNotional: row?.min_notional ?? null,
    };
    // Do not cache a miss: the catalog may be fetched immediately after a startup/API preflight.
    if (row) this.constraintCache.set(symbol, { value, cachedAt: this.options.now() });
    return value;
  }

  private orderSizeError(symbol: string, quantity: Decimal, price?: Decimal): StrategyEngineError | null {
    const constraints = this.constraintsFor(symbol);
    if (!constraints.minSize || !constraints.lotSize) {
      // Spot instruments may be absent from the local instrument catalog; the exchange remains the
      // authority for spot size limits, so a missing catalog row must not block spot strategies.
      if (isSpotSymbol(symbol)) return null;
      return new StrategyEngineError('strategy_instrument_constraints_unavailable', 409, symbol);
    }
    const minimum = new Decimal(constraints.minSize);
    if (minimum.gt(0) && quantity.lt(minimum)) {
      return new StrategyEngineError(
        'strategy_order_below_minimum_size',
        400,
        `${symbol}: ${quantity.toString()} < ${constraints.minSize}`,
      );
    }
    const lot = new Decimal(constraints.lotSize);
    if (lot.gt(0) && !quantity.mod(lot).isZero()) {
      return new StrategyEngineError(
        'strategy_order_invalid_lot_size',
        400,
        `${symbol}: ${quantity.toString()} must be a multiple of ${constraints.lotSize}`,
      );
    }
    if (price && constraints.minNotional) {
      const minimumNotional = new Decimal(constraints.minNotional);
      const notional = quantity.mul(price);
      if (minimumNotional.gt(0) && notional.lt(minimumNotional)) {
        // Give the user an executable fix, not just a rejection: the smallest quantity that
        // clears the minimum at the current price, rounded away from zero for safety.
        const minimumQuantity = minimumNotional.div(price).toSignificantDigits(4, Decimal.ROUND_UP);
        return new StrategyEngineError(
          'strategy_order_below_minimum_notional',
          400,
          `${symbol}: ${notional.toString()} < ${constraints.minNotional}, min qty ~${minimumQuantity.toString()} @ price ${price.toString()}`,
        );
      }
    }
    return null;
  }

  private executablePrice(symbol: string, side: 'BUY' | 'SELL'): Decimal | null {
    const market = this.freshMarket(symbol);
    if (!market) return null;
    const price = new Decimal(side === 'BUY' ? market.askPrice : market.bidPrice);
    return price.gt(0) ? price : null;
  }

  private marketOrderSizeError(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: Decimal,
  ): StrategyEngineError | null {
    const price = this.executablePrice(symbol, side);
    if (!price && this.constraintsFor(symbol).minNotional) {
      return new StrategyEngineError('strategy_market_data_unavailable', 409, symbol);
    }
    return this.orderSizeError(symbol, quantity, price ?? undefined);
  }

  /**
   * Validate every possible configured entry clip, including a smaller final remainder. This is
   * deliberately authoritative and runs against the locally cached exchange instrument catalog;
   * an execution strategy cannot start when either selected venue's constraints are unavailable.
   */
  private validateStrategyOrderSizes(
    config: CreateStrategyInput,
    legs: { left: LegDefinition; right: LegDefinition },
  ): void {
    const perOrder = new Decimal(config.perOrderQuantity);
    const target = this.strategyTarget(config);
    const firstClip = Decimal.min(perOrder, target);
    const remainder = target.mod(perOrder);
    const leftClips = remainder.gt(QUANTITY_EPSILON) && !remainder.eq(firstClip)
      ? [firstClip, remainder]
      : [firstClip];

    let equalNotionalRatio: Decimal | null = null;
    if (this.equalNotional(config)) {
      const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol);
      if (!pair) throw new StrategyEngineError('strategy_market_data_unavailable', 409);
      const leftPrice = new Decimal(legs.left.side === 'BUY' ? pair.left.askPrice : pair.left.bidPrice);
      const rightPrice = new Decimal(legs.right.side === 'BUY' ? pair.right.askPrice : pair.right.bidPrice);
      if (!leftPrice.gt(0) || !rightPrice.gt(0)) throw new StrategyEngineError('strategy_market_data_unavailable', 409);
      equalNotionalRatio = leftPrice.div(rightPrice);
    }

    for (const leftQuantity of leftClips) {
      const leftError = this.marketOrderSizeError(legs.left.symbol, legs.left.side, leftQuantity);
      if (leftError) throw leftError;
      const rightRaw = equalNotionalRatio
        ? leftQuantity.mul(equalNotionalRatio)
        : leftQuantity.div(adrRatioOf(config));
      const rightQuantity = roundToStep(rightRaw, this.constraintsFor(legs.right.symbol).lotSize, 'down');
      const rightError = this.marketOrderSizeError(legs.right.symbol, legs.right.side, rightQuantity);
      if (rightError) throw rightError;
    }
  }

  private closePlanSlices(config: CreateStrategyInput, targetIndex: number): Decimal[] {
    const plan = config.closePlan;
    if (!plan) return [];
    const target = plan.targets[targetIndex];
    if (!target) return [];
    const total = new Decimal(target.quantity);
    const lotText = this.constraintsFor(target.symbol).lotSize;
    const base = roundToStep(total.div(plan.orderCount), lotText, 'down');
    if (!base.gt(QUANTITY_EPSILON)) {
      throw new StrategyEngineError('strategy_order_below_minimum_size', 400, target.symbol);
    }
    return Array.from({ length: plan.orderCount }, (_, index) => index === plan.orderCount - 1
      ? total.minus(base.mul(plan.orderCount - 1))
      : base);
  }

  private validateClosePlanOrderSizes(config: CreateStrategyInput): void {
    const plan = config.closePlan;
    if (!plan) return;
    plan.targets.forEach((target, targetIndex) => {
      for (const quantity of this.closePlanSlices(config, targetIndex)) {
        const error = this.marketOrderSizeError(target.symbol, target.side, quantity);
        if (error) throw error;
      }
    });
  }

  private closePlanSubmittedClips(actor: StrategyActor): number {
    return new Set(this.strategyLedger(actor.id).rows
      .map((row) => row.strategy_clip)
      .filter((clip): clip is string => Boolean(clip?.startsWith('close-')))).size;
  }

  private closePlanExecutedQuantity(actor: StrategyActor, targetIndex: number): Decimal {
    return this.strategyLedger(actor.id).rows
      .filter((row) => row.leg === `close-${targetIndex}`)
      .reduce((sum, row) => sum.plus(row.executed_quantity || '0'), ZERO);
  }

  /**
   * Unfilled close-plan quantity per target. Targets confirmed satisfied by a venue reconcile
   * (the venue holds nothing reducible) are excluded — counting them would make a plan whose
   * venue side is already flat report phantom residuals and a spurious warning on completion.
   */
  private closePlanResiduals(actor: StrategyActor): Array<{ symbol: string; quantity: Decimal }> {
    const plan = actor.config.closePlan;
    if (!plan) return [];
    return plan.targets.map((target, targetIndex) => ({
      symbol: target.symbol,
      quantity: actor.closePlanSatisfied.has(targetIndex)
        ? ZERO
        : Decimal.max(ZERO, new Decimal(target.quantity).minus(this.closePlanExecutedQuantity(actor, targetIndex))),
    })).filter((target) => target.quantity.gt(QUANTITY_EPSILON));
  }

  private completeClosePlan(actor: StrategyActor, pendingNote: string | null = null): void {
    const now = new Date().toISOString();
    actor.status = 'COMPLETED';
    this.database.prepare(`UPDATE execution_strategies SET status = 'COMPLETED', progress = 100,
      stopped_at = ?, updated_at = ? WHERE id = ?`).run(now, now, actor.id);
    // A close plan always converges to a terminal state (R3/AC-3): legs the venue could not
    // close are reported as a pending warning, never as a lingering PAUSED/RUNNING strategy.
    this.runtime.addStrategyLog(actor.id, pendingNote === null ? 'info' : 'warning', 'Strategy completed',
      `${actor.config.closePlan?.orderCount ?? 0} timed close slices`, '100%',
      pendingNote ?? 'All reduce-only close orders filled');
    this.releaseQuoteWatch(actor);
    this.actors.delete(actor.id);
    this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
  }

  /**
   * True when every close-plan target is done: fully executed by the plan's own slices, or
   * confirmed by a venue reconcile to hold nothing reducible (satisfied, including dust). Drives
   * the early completion so a plan whose venue side is already flat never idles through its
   * remaining intervals (R3).
   */
  private closePlanFullySatisfied(actor: StrategyActor): boolean {
    const plan = actor.config.closePlan;
    if (!plan) return false;
    return plan.targets.every((target, targetIndex) => actor.closePlanSatisfied.has(targetIndex)
      || !new Decimal(target.quantity).minus(this.closePlanExecutedQuantity(actor, targetIndex)).gt(QUANTITY_EPSILON));
  }

  /**
   * Reduce-only slice of a close plan rejected with TRADE_REDUCE_ONLY_POSITION_QTY_ERROR: the
   * ledger believed a position the venue no longer holds. Reconcile the venue's real position
   * once (single-flight via `reconcilePositionsFromRemote`) and return what the venue can
   * actually reduce, so the caller can retry this leg at the venue's size — or mark it satisfied
   * when the venue holds nothing. Null when the read failed or the venue confirms the ledger
   * (no new information; the ordinary failure accounting applies). Spot legs have no
   * venue-enforced reduce-only position, so they always read as null.
   */
  private async reconcileClosePlanQuantity(
    actor: StrategyActor,
    submission: { target: { symbol: string; side: 'BUY' | 'SELL' }; requested: Decimal },
  ): Promise<Decimal | null> {
    const { target, requested } = submission;
    if (isSpotSymbol(target.symbol)) return null;
    const positions = await this.refreshVenuePositions(actor);
    if (positions === null) return null;
    const venueQuantity = venueReducibleQuantity(positions, target.symbol, target.side);
    if (venueQuantity === null || venueQuantity.gte(requested)) return null;
    return venueQuantity;
  }

  private async evaluateClosePlan(actor: StrategyActor): Promise<void> {
    const plan = actor.config.closePlan;
    if (!plan || actor.busy) return;
    if (this.openStrategyOrders(actor.id, new Set()).length > 0) return;

    const clipIndex = this.closePlanSubmittedClips(actor);
    if (clipIndex >= plan.orderCount) {
      const residuals = this.closePlanResiduals(actor);
      if (residuals.length > 0) {
        this.runtime.addStrategyLog(actor.id, 'warning', 'Timed close ended with residual positions',
          `Slices ${plan.orderCount}/${plan.orderCount}`,
          residuals.map((item) => `${item.quantity.toString()} ${item.symbol}`).join(', '),
          'Close ended with residual positions; settle them manually or rerun the close');
        this.completeClosePlan(actor, `Pending residuals: ${residuals.map((item) => `${item.quantity.toString()} ${item.symbol}`).join(', ')}`);
        return;
      }
      this.completeClosePlan(actor);
      return;
    }
    const dueAt = clipIndex === 0 ? actor.createdAt : actor.lastCloseAt + plan.intervalSeconds * 1_000;
    if (this.options.now() < dueAt) return;

    // Targets already confirmed satisfied (venue holds nothing) are skipped: resubmitting a
    // doomed reduce-only order would just burn another interval on the same rejection.
    const submissions = plan.targets.flatMap((target, targetIndex) => {
      if (actor.closePlanSatisfied.has(targetIndex)) return [];
      const executed = this.closePlanExecutedQuantity(actor, targetIndex);
      const remaining = Decimal.max(ZERO, new Decimal(target.quantity).minus(executed));
      if (!remaining.gt(QUANTITY_EPSILON)) return [];
      const planned = this.closePlanSlices(actor.config, targetIndex)[clipIndex] ?? ZERO;
      const quantity = clipIndex === plan.orderCount - 1 ? remaining : Decimal.min(planned, remaining);
      if (!quantity.gt(QUANTITY_EPSILON)) return [];
      const sizeError = this.marketOrderSizeError(target.symbol, target.side, quantity);
      if (sizeError) throw sizeError;
      return [{ target, targetIndex, quantity }];
    });
    if (submissions.length === 0) {
      this.completeClosePlan(actor);
      return;
    }

    actor.busy = true;
    const clip = `close-${clipIndex}`;
    this.runtime.addStrategyLog(actor.id, 'info', 'Timed close triggered',
      `Slice ${clipIndex + 1}/${plan.orderCount}`, `${submissions.length} position${submissions.length === 1 ? '' : 's'}`,
      `Submitting reduce-only market orders · next interval ${plan.intervalSeconds}s`);
    try {
      const results = await Promise.allSettled(submissions.map(({ target, targetIndex, quantity }) =>
        this.runtime.createOrder({
          symbol: target.symbol,
          side: target.side,
          type: 'MARKET',
          timeInForce: 'IOC',
          quantity: quantity.toString(),
          reduceOnly: true,
          positionSide: target.positionSide,
        }, { strategyId: actor.id, strategyLeg: `close-${targetIndex}`, strategyClip: clip })));
      // Per-leg terminal state aligned with `submissions` by index; null = nothing settled.
      const settled: Array<ExecutionOrder | null> = new Array<ExecutionOrder | null>(results.length).fill(null);
      const failures: string[] = [];
      for (let index = 0; index < results.length; index += 1) {
        const submission = submissions[index]!;
        const result = results[index]!;
        if (result.status === 'fulfilled') {
          settled[index] = await this.runtime.awaitTerminalOrder(result.value.id, this.options.orderTimeoutMs);
          continue;
        }
        const reasonText = result.reason instanceof Error ? result.reason.message : String(result.reason);
        // R3: a reduce-only quantity rejection means the ledger believed a position the venue no
        // longer holds. Reconcile from the venue once and retry this leg — and only this leg —
        // at the venue's real size, instead of pausing the whole plan on a stale quantity.
        if (!isReduceOnlyQuantityRejection(result.reason)) {
          failures.push(reasonText.slice(0, 160));
          continue;
        }
        const venueQuantity = await this.reconcileClosePlanQuantity(actor, {
          target: submission.target,
          requested: submission.quantity,
        });
        if (venueQuantity === null) {
          failures.push(`reduce-only quantity rejected; ${reasonText.slice(0, 120)}`);
          continue;
        }
        if (venueQuantity.gt(QUANTITY_EPSILON)) {
          this.runtime.addStrategyLog(actor.id, 'info', 'Exit size corrected',
            `Reduce-only close for ${submission.quantity.toString()} ${submission.target.symbol}`,
            submission.quantity.toString(),
            `Venue holds ${venueQuantity.toString()}; re-reporting at the venue size`);
          try {
            const retry = await this.runtime.createOrder({
              symbol: submission.target.symbol,
              side: submission.target.side,
              type: 'MARKET',
              timeInForce: 'IOC',
              quantity: venueQuantity.toString(),
              reduceOnly: true,
              positionSide: submission.target.positionSide,
            }, { strategyId: actor.id, strategyLeg: `close-${submission.targetIndex}`, strategyClip: clip });
            settled[index] = await this.runtime.awaitTerminalOrder(retry.id, this.options.orderTimeoutMs);
          } catch (error) {
            failures.push(error instanceof Error ? error.message.slice(0, 160) : 'retry submission failed');
          }
        } else {
          // The venue holds nothing reducible: the target is satisfied (dust/zero) and the plan
          // stops resubmitting for it. Dust is never auto-liquidated (PRD Q2).
          actor.closePlanSatisfied.add(submission.targetIndex);
          this.runtime.addStrategyLog(actor.id, 'warning', 'Exit quote withdrawn',
            `Reduce-only close for ${submission.quantity.toString()} ${submission.target.symbol}`,
            submission.quantity.toString(),
            'Venue holds no reducible position on this leg; target satisfied');
        }
      }
      for (const order of settled) {
        if (order && order.state !== 'FILLED') failures.push(order.failureReason ?? order.state);
      }
      if (failures.length > 0) {
        // One failed leg must not block the others (R3/AC-2): the failure is a warning and the
        // plan keeps its schedule — later slices retry whatever is left at venue-truth sizes.
        this.runtime.addStrategyLog(actor.id, 'warning', 'Timed close slice failed',
          `Slice ${clipIndex + 1}/${plan.orderCount}`,
          `${settled.filter((order) => order?.state === 'FILLED').length}/${submissions.length} orders filled`,
          failures[0] ?? 'order not filled');
      }

      const now = new Date().toISOString();
      actor.lastCloseAt = this.options.now();
      const progress = ((clipIndex + 1) / plan.orderCount) * 100;
      this.database.prepare(`UPDATE execution_strategies SET progress = ?, filled_quantity = ?, updated_at = ? WHERE id = ?`)
        .run(progress, String(clipIndex + 1), now, actor.id);
      this.runtime.addStrategyLog(actor.id, 'info', 'Timed close slice executed',
        `Slice ${clipIndex + 1}/${plan.orderCount}`, `${settled.length} order${settled.length === 1 ? '' : 's'}`,
        settled.map((order) => `${order?.side ?? '—'} ${order?.symbol ?? '—'} ${order?.executedQuantity ?? '0'}`).join(' · '));
      // Converge as soon as every target is done (early) or the plan's slices are exhausted.
      if (clipIndex + 1 >= plan.orderCount || this.closePlanFullySatisfied(actor)) {
        const residuals = this.closePlanResiduals(actor);
        if (residuals.length > 0) {
          this.runtime.addStrategyLog(actor.id, 'warning', 'Timed close ended with residual positions',
            `Slice ${clipIndex + 1}/${plan.orderCount}`,
            residuals.map((item) => `${item.quantity.toString()} ${item.symbol}`).join(', '),
            'Close ended with residual positions; settle them manually or rerun the close');
          this.completeClosePlan(actor, `Pending residuals: ${residuals.map((item) => `${item.quantity.toString()} ${item.symbol}`).join(', ')}`);
        } else {
          this.completeClosePlan(actor);
        }
      }
      else this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
    } finally {
      actor.busy = false;
    }
  }

  /** Maximum matched quantity the strategy may accumulate, in left-leg units. */
  private strategyTarget(config: CreateStrategyInput): Decimal {
    if (config.kind === 'position' || config.kind === 'carry') return new Decimal(config.totalAmount ?? '0');
    if (config.kind === 'premium' && config.grid) {
      return new Decimal(config.perOrderQuantity).mul(config.gridLevels ?? 0);
    }
    return new Decimal(config.maxPosition ?? '0');
  }

  private persist(actor: StrategyActor, exposure: { left: Decimal; right: Decimal }): StrategyRecord {
    const matched = this.matchedQuantity(exposure);
    const target = this.strategyTarget(actor.config);
    const progress = target.gt(0) ? Decimal.min(matched.div(target).mul(100), new Decimal(100)).toNumber() : 0;
    this.database.prepare(`UPDATE execution_strategies SET status = ?, progress = ?, filled_quantity = ?,
      filled_left = ?, filled_right = ?, open_position = ?, updated_at = ? WHERE id = ?`).run(
      actor.status, progress, matched.toString(), exposure.left.abs().toString(), exposure.right.abs().toString(),
      actor.kind === 'position' || actor.config.reduceOnly ? '0' : matched.toString(), new Date().toISOString(), actor.id);
    const record = this.runtime.getStrategy(actor.id);
    this.runtime.emitStrategyUpdate(record);
    return record;
  }

  private async afterExecutionChange(actor: StrategyActor): Promise<void> {
    if (!this.actors.has(actor.id)) return;
    if (actor.config.closePlan) return;
    const exposure = this.legExposures(actor.id, actor.config);
    this.persist(actor, exposure);
    await this.reconcileExposure(actor, exposure);
    if (actor.suspended) {
      await this.finishQuiesce(actor);
      return;
    }
    if (actor.status !== 'RUNNING') return;
    await this.checkCompletion(actor);
  }

  private async checkCompletion(actor: StrategyActor): Promise<void> {
    if (actor.status !== 'RUNNING') return;
    if (actor.config.closePlan) return;
    const exposure = this.legExposures(actor.id, actor.config);
    const matched = this.matchedQuantity(exposure);
    let condition: string | null = null;
    let result = '';
    let details = '';
    if (actor.kind === 'position' && this.positionMonitoringEnabled(actor.config)
      && (actor.positionExitArmed || this.positionExitStarted(actor))) {
      // A latched position exit is a one-way lifecycle: once the take-profit / stop-loss exit has
      // been submitted the strategy never opens again, it only converges to flat. A stop-loss ends
      // STOPPED (manual restart, exactly like the auto stop-loss) and a take-profit ends COMPLETED
      // (the premium take-profit lifecycle), mirroring how each of those already behaves.
      const quoteOrderIds = new Set([...actor.quotes.values()].map((quote) => quote.orderId));
      const noOpenOrders = this.openStrategyOrders(actor.id, quoteOrderIds).length === 0;
      const flat = exposure.left.abs().lte(QUANTITY_EPSILON)
        && exposure.right.abs().lte(QUANTITY_EPSILON);
      if (noOpenOrders && flat) {
        if (actor.positionExitReason === 'stop-loss') {
          if (!(await this.cancelQuotes(actor))) return;
          actor.status = 'STOPPED';
          const now = new Date().toISOString();
          this.database.prepare(`UPDATE execution_strategies SET status = 'STOPPED', open_position = '0',
            stopped_at = ?, updated_at = ? WHERE id = ?`).run(now, now, actor.id);
          this.runtime.addStrategyLog(actor.id, 'info', 'Strategy stopped', 'Stop-loss exit complete',
            `0 ${actor.config.asset} remaining`, 'Both legs closed after the stop-loss triggered; manual restart required');
          this.releaseQuoteWatch(actor);
          this.actors.delete(actor.id);
          this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
          return;
        }
        condition = 'Take-profit lifecycle';
        result = `0 ${actor.config.asset} remaining`;
        details = 'Both legs closed at the take-profit threshold; this strategy will not re-enter';
      }
    } else if (actor.kind === 'position' && !this.positionMonitoringEnabled(actor.config)) {
      // Without take-profit / stop-loss thresholds a position strategy keeps the original open-only
      // lifecycle: it completes as soon as the target quantity is filled and hedged. Configuring
      // either threshold keeps it RUNNING past that point so the exit can actually be evaluated —
      // the whole point of the feature, and the reason this branch is skipped for those strategies.
      const total = new Decimal(actor.config.totalAmount ?? '0');
      const imbalance = exposure.left.plus(exposure.right);
      if (total.gt(0) && matched.gte(total.minus(QUANTITY_EPSILON)) && imbalance.abs().lte(QUANTITY_EPSILON)) {
        condition = `Target ${total.toString()} ${actor.config.asset}`;
        result = matched.toString();
        details = 'Both legs fully executed and hedged';
      }
    } else if (actor.kind === 'premium' && actor.config.reduceOnly) {
      const target = this.strategyTarget(actor.config);
      const imbalance = exposure.left.plus(exposure.right);
      if (target.gt(0) && matched.gte(target.minus(QUANTITY_EPSILON))
        && imbalance.abs().lte(QUANTITY_EPSILON)) {
        condition = `Reduce-only target ${target.toString()} ${actor.config.asset}`;
        result = `${matched.toString()} ${actor.config.asset}`;
        details = 'Existing exposure reduced in configured per-order clips';
      }
    } else if (actor.kind === 'premium' && this.premiumExitStarted(actor)) {
      const quoteOrderIds = new Set([...actor.quotes.values()].map((quote) => quote.orderId));
      const noOpenOrders = this.openStrategyOrders(actor.id, quoteOrderIds).length === 0;
      const flat = exposure.left.abs().lte(QUANTITY_EPSILON)
        && exposure.right.abs().lte(QUANTITY_EPSILON)
        && exposure.rightShares.abs().lte(QUANTITY_EPSILON);
      if (noOpenOrders && flat) {
        condition = 'Take-profit lifecycle';
        result = `0 ${actor.config.asset} remaining`;
        details = 'All opened exposure was closed; this strategy will not re-enter';
      }
    } else if (actor.kind === 'auto' && actor.stopLossArmed) {
      const quoteOrderIds = new Set([...actor.quotes.values()].map((quote) => quote.orderId));
      const noOpenOrders = this.openStrategyOrders(actor.id, quoteOrderIds).length === 0;
      const flat = exposure.left.abs().lte(QUANTITY_EPSILON)
        && exposure.right.abs().lte(QUANTITY_EPSILON);
      if (noOpenOrders && flat) {
        if (!(await this.cancelQuotes(actor))) return;
        actor.status = 'STOPPED';
        const now = new Date().toISOString();
        this.database.prepare(`UPDATE execution_strategies SET status = 'STOPPED', open_position = '0',
          stopped_at = ?, updated_at = ? WHERE id = ?`).run(now, now, actor.id);
        this.runtime.addStrategyLog(actor.id, 'info', 'Strategy stopped', 'Stop-loss exit complete',
          `0 ${actor.config.asset} remaining`, 'Both legs closed after the stop-loss triggered; manual restart required');
        this.releaseQuoteWatch(actor);
        this.actors.delete(actor.id);
        this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
        return;
      }
    } else if (actor.kind === 'carry' && (actor.carry?.exited ?? false)) {
      const state = actor.carry!;
      const quoteOrderIds = new Set([...actor.quotes.values()].map((quote) => quote.orderId));
      const noOpenOrders = this.openStrategyOrders(actor.id, quoteOrderIds).length === 0;
      const flat = exposure.left.abs().lte(QUANTITY_EPSILON)
        && exposure.right.abs().lte(QUANTITY_EPSILON)
        && exposure.rightShares.abs().lte(QUANTITY_EPSILON);
      if (noOpenOrders && flat) {
        if (!(await this.cancelQuotes(actor))) return;
        const metrics = this.persistCarryMetrics(actor, state);
        actor.status = 'COMPLETED';
        const now = new Date().toISOString();
        this.database.prepare(`UPDATE execution_strategies SET status = 'COMPLETED', progress = 100,
          open_position = '0', stopped_at = ?, updated_at = ? WHERE id = ?`).run(now, now, actor.id);
        this.runtime.addStrategyLog(actor.id, 'info', 'Strategy completed', 'Basis take-profit cycle complete',
          `${metrics.fundingCollectedUsdt} USDT funding collected`,
          `Net PnL ${metrics.netPnlUsdt} USDT (basis ${metrics.basisPnlUsdt} + funding ${metrics.fundingCollectedUsdt} − fees ${metrics.feesPaidUsdt})`);
        this.releaseQuoteWatch(actor);
        this.actors.delete(actor.id);
        this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
        return;
      }
    }
    if (condition === null) return;
    if (!(await this.cancelQuotes(actor))) return;
    actor.status = 'COMPLETED';
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE execution_strategies SET status = 'COMPLETED', progress = 100,
      open_position = '0', stopped_at = ?, updated_at = ? WHERE id = ?`).run(now, now, actor.id);
    this.runtime.addStrategyLog(actor.id, 'info', 'Strategy completed', condition, result, details);
    this.releaseQuoteWatch(actor);
    this.actors.delete(actor.id);
    this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
  }

  private async pause(actor: StrategyActor, reason: string): Promise<void> {
    actor.suspended = true;
    actor.quiesceTarget = 'PAUSED';
    actor.quiesceReason = reason;
    await this.finishQuiesce(actor);
  }

  private async cancelQuotes(actor: StrategyActor): Promise<boolean> {
    let allTerminal = true;
    for (const [intent, quote] of [...actor.quotes]) {
      if (quote.cancelling) continue;
      quote.cancelling = true;
      try {
        const pending = await this.runtime.cancelOrder(quote.orderId);
        const settled = isTerminalOrderState(pending.state)
          ? pending
          : await this.runtime.awaitTerminalOrder(quote.orderId, this.options.orderTimeoutMs);
        if (isTerminalOrderState(settled.state)) actor.quotes.delete(intent);
        else {
          quote.cancelling = false;
          allTerminal = false;
        }
      } catch (error) {
        if (error instanceof TradingRuntimeError && error.code === 'order_not_cancellable') actor.quotes.delete(intent);
        else {
          quote.cancelling = false;
          allTerminal = false;
        }
      }
    }
    return allTerminal;
  }

  private async maintainQuiesce(actor: StrategyActor): Promise<void> {
    if (!this.actors.has(actor.id)) return;
    const exposure = this.legExposures(actor.id, actor.config);
    this.persist(actor, exposure);
    await this.reconcileExposure(actor, exposure);
    await this.finishQuiesce(actor);
  }

  private async finishQuiesce(actor: StrategyActor): Promise<boolean> {
    const target = actor.quiesceTarget;
    if (!target) return false;
    const result = await this.runtime.quiesceOpenOrders({
      strategyId: actor.id,
      timeoutMs: this.options.orderTimeoutMs,
    });
    actor.unresolvedOrders = result.unresolved;
    if (result.unresolved.length > 0) {
      actor.status = target === 'PAUSED' ? 'PAUSE_PENDING_REMOTE' : 'STOP_PENDING_REMOTE';
      const now = new Date().toISOString();
      this.database.prepare('UPDATE execution_strategies SET status = ?, updated_at = ? WHERE id = ?')
        .run(actor.status, now, actor.id);
      this.runtime.addStrategyLog(actor.id, 'error',
        target === 'PAUSED' ? 'Strategy pause pending' : 'Strategy stop pending',
        'Remote cancellation not confirmed', '—',
        `${actor.quiesceReason ?? 'Safety quiesce'} · unresolved ${result.unresolved.map(({ order, reason }) => `${order.id} (${reason})`).join(', ')}`);
      this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
      return false;
    }
    actor.quotes.clear();
    actor.status = target;
    const now = new Date().toISOString();
    if (target === 'STOPPED') {
      this.database.prepare("UPDATE execution_strategies SET status = 'STOPPED', stopped_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, actor.id);
      const exposure = this.legExposures(actor.id, actor.config);
      const residual = this.hedgeImbalance(actor.id, actor.config, exposure);
      this.runtime.addStrategyLog(actor.id, residual.gt(QUANTITY_EPSILON) ? 'warning' : 'info', 'Strategy stopped',
        actor.quiesceReason ?? 'Manual stop', '—', residual.gt(QUANTITY_EPSILON)
          ? `Stopped with unhedged residual ${residual.toString()} ${actor.config.asset}; review positions`
          : 'Stopped after all remote orders reached terminal state');
    } else {
      this.database.prepare("UPDATE execution_strategies SET status = 'PAUSED', updated_at = ? WHERE id = ?")
        .run(now, actor.id);
      this.runtime.addStrategyLog(actor.id, 'error', 'Strategy paused', '—', '—',
        actor.quiesceReason ?? 'Safety pause');
    }
    this.releaseQuoteWatch(actor);
    this.actors.delete(actor.id);
    this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
    return true;
  }

  private entrySpreadBps(config: CreateStrategyInput): { spread: Decimal; sell: LiveMarket; buy: LiveMarket } | null {
    const legs = legsOf(config);
    const sellLeg = legs.left.side === 'SELL' ? legs.left : legs.right;
    const buyLeg = legs.left.side === 'BUY' ? legs.left : legs.right;
    const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol);
    if (!pair) return null;
    const sell = sellLeg.leg === 'left' ? pair.left : pair.right;
    const buy = buyLeg.leg === 'left' ? pair.left : pair.right;
    const sellBid = new Decimal(sell.bidPrice);
    const buyAsk = new Decimal(buy.askPrice);
    if (!sellBid.gt(0) || !buyAsk.gt(0)) return null;
    return { spread: sellBid.minus(buyAsk).div(buyAsk).mul(BPS), sell, buy };
  }

  private exitSpreadBps(config: CreateStrategyInput): Decimal | null {
    const legs = legsOf(config);
    const sellLeg = legs.left.side === 'SELL' ? legs.left : legs.right;
    const buyLeg = legs.left.side === 'BUY' ? legs.left : legs.right;
    const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol);
    if (!pair) return null;
    const sell = sellLeg.leg === 'left' ? pair.left : pair.right;
    const buy = buyLeg.leg === 'left' ? pair.left : pair.right;
    const sellAsk = new Decimal(sell.askPrice);
    const buyBid = new Decimal(buy.bidPrice);
    if (!sellAsk.gt(0) || !buyBid.gt(0)) return null;
    return sellAsk.minus(buyBid).div(buyBid).mul(BPS);
  }

  /**
   * Executable ADR premium in percent — ADR price over ratio-scaled local price, minus one —
   * plus the two leg prices it was computed from, using the bid/ask each leg would actually
   * trade at for the given intent. Null while either quote is missing or stale.
   */
  private premiumQuote(config: CreateStrategyInput, intent: QuoteIntent): {
    premium: Decimal;
    adrPrice: Decimal;
    hedgePrice: Decimal;
  } | null {
    const legs = legsOf(config);
    const adrSide = intent === 'entry' ? legs.left.side : oppositeSide(legs.left.side);
    const hedgeSide = intent === 'entry' ? legs.right.side : oppositeSide(legs.right.side);
    const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol);
    if (!pair) return null;
    const { left: adr, right: hedge } = pair;
    const adrPrice = new Decimal(adrSide === 'SELL' ? adr.bidPrice : adr.askPrice);
    const hedgePrice = new Decimal(hedgeSide === 'SELL' ? hedge.bidPrice : hedge.askPrice);
    const fairValue = hedgePrice.div(adrRatioOf(config));
    if (!adrPrice.gt(0) || !fairValue.gt(0)) return null;
    return {
      premium: adrPrice.div(fairValue).minus(1).mul(100),
      adrPrice,
      hedgePrice,
    };
  }

  private async evaluate(actor: StrategyActor): Promise<void> {
    if (!this.actors.has(actor.id) || actor.status !== 'RUNNING' || actor.busy) return;
    if (actor.config.closePlan) {
      await this.evaluateClosePlan(actor);
      return;
    }
    const exposure = this.legExposures(actor.id, actor.config);
    await this.reconcileExposure(actor, exposure);
    await this.checkCompletion(actor);
    if (!this.actors.has(actor.id) || actor.status !== 'RUNNING') return;
    if (actor.busy || actor.status !== 'RUNNING') return;
    if (this.options.now() < actor.cooldownUntil) return;
    if (actor.kind === 'auto' && actor.config.stopLossBps && !actor.stopLossArmed) {
      if (await this.maybeTriggerAutoStopLoss(actor)) {
        await this.checkCompletion(actor);
        return;
      }
    }
    if (actor.kind === 'auto' && actor.stopLossArmed) {
      // A latched stop-loss exit only unwinds; no new entries, no maker quotes.
      await this.continueAutoStopLossExit(actor);
    } else if (actor.kind === 'position') {
      // A position strategy carries its own take-profit / stop-loss lifecycle. The trigger is
      // evaluated on every tick *before* the entry routing, so an adverse move can never be
      // re-entered into on the same tick it fires (the auto stop-loss takes the same position).
      if (!actor.positionExitArmed && this.positionMonitoringEnabled(actor.config)
        && this.positionExitStarted(actor)) {
        // The ledger already holds the exit's reduce-only order, so a previous process began the
        // unwind. Re-arm without re-deciding: entering again here would reopen the very position
        // that is being closed. The original reason is not persisted, so it stays unknown and the
        // resumed unwind is reported as a take-profit lifecycle.
        actor.positionExitArmed = true;
      }
      if (actor.positionExitArmed) {
        await this.continuePositionExit(actor);
        await this.checkCompletion(actor);
        return;
      }
      if (await this.maybeTriggerPositionExit(actor)) {
        await this.checkCompletion(actor);
        return;
      }
      // Funding-decay exit: hold the hedge while the pair's funding differential still clears
      // `exitFundingAprFloorPercent`, close when it decays (or flips negative), and force-close at
      // the `maxHoldingHours` cap. This is the automatic runner's primary exit.
      if (await this.maybeTriggerFundingExit(actor)) {
        await this.checkCompletion(actor);
        return;
      }
      // Settlement cap (optional): hold through N settlements at most, independent of the rate read.
      if (await this.maybeTriggerSettlementExit(actor)) {
        await this.checkCompletion(actor);
        return;
      }
      if (actor.config.executionMethod === 'MAKER_TAKER') await this.evaluateMakerQuotes(actor);
      else await this.evaluateTakerClip(actor);
    } else if (actor.config.executionMethod === 'MAKER_TAKER') {
      await this.evaluateMakerQuotes(actor);
    } else if (actor.kind === 'premium') {
      await this.evaluatePremiumClip(actor);
    } else if (actor.kind === 'carry') {
      await this.evaluateCarryTriggers(actor);
    } else {
      await this.evaluateTakerClip(actor);
    }
    await this.checkCompletion(actor);
  }

  /**
   * True when the live spread already sits at/beyond the absolute stop-loss line, i.e. in the
   * adverse region for this strategy's signed entry level: `spread >= stopLossBps` when the entry
   * is positive (the trade profits on convergence, so widening is adverse), and
   * `spread <= -stopLossBps` when the entry is negative (the opening cost widens).
   *
   * Single-purpose and stateless by design: the stop path (`maybeTriggerAutoStopLoss`) and the B2
   * entry gate (taker + maker) must share *exactly* this predicate so their notions of "breached"
   * can never drift apart.
   */
  private adverseBreached(config: CreateStrategyInput, spread: Decimal): boolean {
    const stop = new Decimal(config.stopLossBps ?? '0');
    const level = new Decimal(config.entryBps ?? '0');
    return level.gte(0) ? spread.gte(stop) : spread.lte(stop.neg());
  }

  /**
   * Index of the ladder tier the given spread belongs to: `floor(advance / step)` where `advance`
   * is how far the spread has widened beyond the entry level. Tier 0 is the initial entry tier, so
   * tier `k` permits `k + 1` clips. Returns 0 with no ladder configured (or below the entry level).
   *
   * Stateless: the tier is always re-derived from the live spread plus already-placed quantity, so
   * nothing needs restoring after a backend restart (§8.1).
   */
  private tierIndexFor(config: CreateStrategyInput, spread: Decimal): number {
    const step = new Decimal(config.addOnStepBps ?? '0');
    if (!step.gt(0)) return 0;
    const level = new Decimal(config.entryBps ?? '0');
    const advance = level.gte(0) ? spread.minus(level) : level.minus(spread);
    return advance.lte(0) ? 0 : advance.div(step).floor().toNumber();
  }

  /** Signed entry level (bps) of tier `tier`: `entryBps + tier·step`, mirrored for negative entries. */
  private tierLevelBps(config: CreateStrategyInput, tier: number): Decimal {
    const step = new Decimal(config.addOnStepBps ?? '0');
    const level = new Decimal(config.entryBps ?? '0');
    return level.gte(0) ? level.plus(step.mul(tier)) : level.minus(step.mul(tier));
  }

  /** Magnitude of tier `tier`'s level: `|entryBps| + tier·step` — compare against `stopLossBps`. */
  private absThreshold(config: CreateStrategyInput, tier: number): Decimal {
    const step = new Decimal(config.addOnStepBps ?? '0');
    const level = new Decimal(config.entryBps ?? '0');
    return level.abs().plus(step.mul(tier));
  }

  /**
   * How many bps the live spread still has to travel before tier `tier`'s entry level is reached:
   * positive means "not there yet", zero or negative that the level is already met or exceeded.
   *
   * The exact negation of the `advance` term inside {@link tierIndexFor} — that helper measures how
   * far the spread already got *past* the level, this one measures what is *left* — lifted from
   * `entryBps` to a ladder tier through {@link tierLevelBps}, and keeping the same mirrored branch
   * for a negative `entryBps` (which triggers as the spread falls, so the remaining distance is
   * `spread − level`). The two helpers answer different questions and stay separate by design; do
   * not refactor them into one.
   */
  private entryDistanceBps(config: CreateStrategyInput, spread: Decimal, tier = 0): Decimal {
    const level = this.tierLevelBps(config, tier);
    const sign = new Decimal(config.entryBps ?? '0');
    return sign.gte(0) ? level.minus(spread) : spread.minus(level);
  }

  /**
   * Whether the ladder admits another clip at the live spread. Used by the **taker** path, which
   * acts on the current tick, so it judges the *live spread* via `tierIndexFor`. The maker path is
   * passive (its quote waits for the gap) and uses {@link nextLadderTier} instead — deliberately
   * different helpers; do not merge them.
   *
   * `matched + inFlight` counts placed clips: using `matched` alone would let a still-open entry
   * order be submitted again on the next tick. No ladder configured ⇒ today's tick-driven
   * accumulation (unchanged behaviour for existing strategies).
   */
  private ladderAllowsAdd(actor: StrategyActor, exposure: { left: Decimal; right: Decimal }, spread: Decimal): boolean {
    const step = new Decimal(actor.config.addOnStepBps ?? '0');
    if (!step.gt(0)) return true;
    const perOrder = new Decimal(actor.config.perOrderQuantity);
    if (!perOrder.gt(0)) return true;
    const placed = this.placedQuantity(actor, exposure);
    const allowedClips = perOrder.mul(this.tierIndexFor(actor.config, spread) + 1);
    return placed.lt(allowedClips.minus(QUANTITY_EPSILON));
  }

  /**
   * Index of the tier the **next** clip belongs to, derived from the clip count rather than the
   * live spread: notebook price action cannot advance a maker tier, only a filled clip can. One
   * maker clip is one matched pair, so `floor((matched + inFlight) / perOrder)` counts it exactly
   * once whether the hedge has filled (`matched`) or is still outstanding (`inFlight`) (§8.5.4).
   */
  private nextLadderTier(actor: StrategyActor, exposure: { left: Decimal; right: Decimal }): number {
    const step = new Decimal(actor.config.addOnStepBps ?? '0');
    if (!step.gt(0)) return 0;
    const perOrder = new Decimal(actor.config.perOrderQuantity);
    if (!perOrder.gt(0)) return 0;
    return this.placedQuantity(actor, exposure).div(perOrder).floor().toNumber();
  }

  /** Already-committed quantity in left-leg units = filled exposure plus open order quantity. */
  private placedQuantity(actor: StrategyActor, exposure: { left: Decimal; right: Decimal }): Decimal {
    const matched = this.matchedQuantity(exposure);
    const quoteIds = new Set([...actor.quotes.values()].map((quote) => quote.orderId));
    return matched.plus(this.inFlightQuantity(actor, quoteIds));
  }

  /**
   * True when this exit clip is a stop-loss unwind, which must be labelled `Stop-loss …` instead of
   * `Take-profit …`. One helper for the trigger row and the fill row so the two can never disagree:
   * an `auto` strategy uses its latched stop, a `position` strategy uses the reason its latch
   * recorded. Everything else (take-profit, reduce-only, carry) is not a stop and stays unlabelled.
   */
  private isStopLossExit(actor: StrategyActor, intent: QuoteIntent): boolean {
    if (intent !== 'exit') return false;
    if (actor.kind === 'auto') return actor.stopLossArmed;
    return actor.kind === 'position' && actor.positionExitReason === 'stop-loss';
  }

  /**
   * Auto stop-loss: when the live spread has moved past the configured bps in the adverse
   * direction relative to the signed entry threshold, close the entire open position with one
   * reduce-only taker clip. The strategy itself stops once that exit has fully filled.
   */
  private async maybeTriggerAutoStopLoss(actor: StrategyActor): Promise<boolean> {
    const stopLoss = actor.config.stopLossBps;
    if (!stopLoss || actor.stopLossArmed) return false;
    const exposure = this.legExposures(actor.id, actor.config);
    const matched = this.matchedQuantity(exposure);
    if (!matched.gt(QUANTITY_EPSILON)) return false;
    const entry = this.entrySpreadBps(actor.config);
    if (!entry) return false;
    const adverse = this.adverseBreached(actor.config, entry.spread);
    if (!adverse) return false;
    actor.stopLossArmed = true;
    this.runtime.addStrategyLog(actor.id, 'warning', 'Stop-loss triggered',
      `Spread ${entry.spread.toFixed(2)} bps hit the ${stopLoss} bps stop-loss`,
      matched.toString(), 'Closing both legs with market orders; the strategy stops when flat');
    await this.executeTakerClip(actor, 'exit', matched,
      `Spread ${entry.spread.toFixed(2)} bps hit the ${stopLoss} bps stop-loss`);
    return true;
  }

  /** Unwind the remainder of a latched stop-loss exit in configured per-order clips. */
  private async continueAutoStopLossExit(actor: StrategyActor): Promise<void> {
    const exposure = this.legExposures(actor.id, actor.config);
    const matched = this.matchedQuantity(exposure);
    if (!matched.gt(QUANTITY_EPSILON)) return;
    await this.executeTakerClip(actor, 'exit',
      Decimal.min(new Decimal(actor.config.perOrderQuantity), matched), 'Stop-loss exit in progress');
  }

  /**
   * Whether a position strategy monitors its spread for an exit at all. True only when the strategy
   * is a plain `position` (never a close plan) **and** at least one of `takeProfitBps` /
   * `stopLossBps` carries a usable value.
   *
   * This predicate is the compatibility switch for the whole feature: a position strategy without
   * either threshold keeps the original open-only lifecycle — it completes the moment its target
   * quantity is filled (`checkCompletion`) and never evaluates a spread afterwards. A configured
   * threshold is the user asking for a monitored position, so completion is deferred and both
   * thresholds are evaluated every tick.
   */
  private positionMonitoringEnabled(config: CreateStrategyInput): boolean {
    if (config.kind !== 'position' || config.closePlan) return false;
    const takeProfit = optionalDecimal(config.takeProfitBps);
    const stopLoss = optionalDecimal(config.stopLossBps);
    return takeProfit !== null || (stopLoss !== null && stopLoss.gt(0));
  }

  /**
   * Funding-decay exit for the automatic perp⇄perp runner.
   *
   * The trade is held while the pair's live funding differential keeps paying: on every tick the
   * engine reads both legs' current funding rates, normalizes them to an 8h-equivalent and closes
   * the pair once the annualized differential drops below `exitFundingAprFloorPercent` or flips
   * negative (`exitOnFundingFlip`). `maxHoldingHours` is a separate safety cap that fires even while
   * the rate is still paying. Missing quotes or rates abstain — the exit only fires on a complete
   * reading, never on a fabricated zero.
   */
  private async maybeTriggerFundingExit(actor: StrategyActor): Promise<boolean> {
    const config = actor.config;
    if (config.kind !== 'position' || config.closePlan || actor.positionExitArmed) return false;
    const exposure = this.legExposures(actor.id, config);
    if (!this.matchedQuantity(exposure).gt(QUANTITY_EPSILON)) return false;
    const now = this.options.now();
    if (actor.positionOpenedAt === null) {
      actor.positionOpenedAt = now;
      return false;
    }
    const legs = legsOf(config);
    const maxHours = config.maxHoldingHours;
    if (maxHours !== undefined && maxHours > 0 && now - actor.positionOpenedAt >= maxHours * 3_600_000) {
      actor.positionExitArmed = true;
      actor.positionExitReason = 'max-hold';
      this.runtime.addStrategyLog(actor.id, 'info', 'Max holding exit triggered',
        `Held ${((now - actor.positionOpenedAt) / 3_600_000).toFixed(1)}h · cap ${maxHours}h`,
        config.asset, 'Closing both legs at market');
      await this.continuePositionExit(actor);
      return true;
    }
    const minHoldHours = config.minHoldingHours;
    if (minHoldHours !== undefined && minHoldHours > 0
      && now - actor.positionOpenedAt < minHoldHours * 3_600_000) return false;
    const floor = config.exitFundingAprFloorPercent;
    const flip = config.exitOnFundingFlip ?? false;
    if ((floor === undefined || floor <= 0) && !flip) return false;
    const leftMarket = this.markets.market(legs.left.symbol);
    const rightMarket = this.markets.market(legs.right.symbol);
    if (!leftMarket || !rightMarket) return false;
    const leftRate = Number(leftMarket.fundingRate);
    const rightRate = Number(rightMarket.fundingRate);
    if (!Number.isFinite(leftRate) || !Number.isFinite(rightRate)) return false;
    const leftInterval = this.options.fundingIntervalHours?.(legs.left.symbol) ?? 8;
    const rightInterval = this.options.fundingIntervalHours?.(legs.right.symbol) ?? 8;
    const left8h = leftInterval > 0 ? leftRate * 8 / leftInterval : leftRate;
    const right8h = rightInterval > 0 ? rightRate * 8 / rightInterval : rightRate;
    const short8h = legs.left.side === 'SELL' ? left8h : right8h;
    const long8h = legs.left.side === 'SELL' ? right8h : left8h;
    const net8h = short8h - long8h;
    const apr = net8h * 3 * 365 * 100;
    const decayed = floor !== undefined && floor > 0 && apr < floor;
    const flipped = flip && net8h <= 0;
    // Smart-decline: a run of strictly falling readings below the floor is an exit even before the
    // floor itself is breached again next tick (vooi's `smart_decl`). Rolling window, bounded size.
    const declineN = config.exitFundingDeclineReadings ?? 0;
    let declined = false;
    if (declineN > 0) {
      actor.fundingAprReadings.push(apr);
      if (actor.fundingAprReadings.length > declineN + 1) actor.fundingAprReadings.shift();
      declined = floor !== undefined && floor > 0 && apr < floor
        && actor.fundingAprReadings.length >= declineN + 1
        && actor.fundingAprReadings.every((value, index, all) => index === 0 || all[index - 1]! > value);
    } else {
      actor.fundingAprReadings = [];
    }
    const triggered = decayed || flipped || declined;
    if (!triggered) {
      actor.fundingDecaySince = null;
      return false;
    }
    // Dwell debounce: one bad reading is not an exit. The pair has to stay at/below the floor for
    // the configured window first, so a transient print cannot cut a position that is still paying.
    if (actor.fundingDecaySince === null) actor.fundingDecaySince = now;
    const dwellMs = Math.max(0, config.exitFundingDecayDwellSeconds ?? 0) * 1000;
    if (now - actor.fundingDecaySince < dwellMs) return false;
    actor.positionExitArmed = true;
    actor.positionExitReason = 'funding-decay';
    this.runtime.addStrategyLog(actor.id, 'info', 'Funding decay exit triggered',
      `Pair APR ${apr.toFixed(1)}%${flipped ? ' · differential flipped' : declined ? ` · declining ${declineN} readings` : ` · floor ${floor}%`}`
      + ` · held ${((now - actor.positionOpenedAt) / 3_600_000).toFixed(1)}h`,
      `${config.asset}`, 'Closing both legs at market');
    await this.continuePositionExit(actor);
    return true;
  }

  /**
   * Settlement-based exit for a position strategy (automatic perp⇄perp funding runner).
   *
   * The funding edge is captured by *holding through a settlement*, not by a price convergence:
   * once both legs are open the engine computes one deadline — the later of the two legs' next
   * settlement, advanced by the configured number of settlements, plus the configured delay — and
   * closes both legs when it passes. The deadline lives in memory, so a restart recomputes it from
   * the live funding clock; the fail-safe is that auto-execution stays paused after a restart.
   */
  private async maybeTriggerSettlementExit(actor: StrategyActor): Promise<boolean> {
    const config = actor.config;
    const settlementCount = config.exitAfterSettlements;
    if (config.kind !== 'position' || config.closePlan || !settlementCount || actor.positionExitArmed) return false;
    const exposure = this.legExposures(actor.id, config);
    if (!this.matchedQuantity(exposure).gt(QUANTITY_EPSILON)) return false;
    if (actor.settlementExitAt === null) {
      actor.settlementExitAt = this.settlementExitDeadline(config);
    }
    if (this.options.now() < actor.settlementExitAt) return false;
    actor.positionExitArmed = true;
    actor.positionExitReason = 'settlement';
    this.runtime.addStrategyLog(actor.id, 'info', 'Settlement exit triggered',
      `Held through ${settlementCount} funding settlement${settlementCount === 1 ? '' : 's'} · deadline ${new Date(actor.settlementExitAt).toISOString()}`,
      `${config.asset}`, 'Closing both legs at market');
    await this.continuePositionExit(actor);
    return true;
  }

  /**
   * Deadline (wall-clock ms) of the settlement exit: the slower leg's next settlement, advanced by
   * `exitAfterSettlements - 1` of its own intervals, plus the configured delay. Unknown interval
   * falls back to the 8h cadence the rest of the engine already uses for funding math.
   */
  private settlementExitDeadline(config: CreateStrategyInput): number {
    const count = Math.max(1, config.exitAfterSettlements ?? 1);
    const delayMs = Math.max(0, config.exitSettlementDelaySeconds ?? 0) * 1000;
    const now = this.options.now();
    const legs = legsOf(config);
    const deadlineFor = (symbol: string): number => {
      const market = this.markets.market(symbol);
      const next = market?.nextFundingAt ? Date.parse(market.nextFundingAt) : Number.NaN;
      const reported = this.options.fundingIntervalHours?.(symbol) ?? null;
      const interval = typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? reported : 8;
      const first = Number.isFinite(next) && next > now ? next : now + interval * 3_600_000;
      return first + interval * 3_600_000 * (count - 1);
    };
    return Math.max(deadlineFor(legs.left.symbol), deadlineFor(legs.right.symbol)) + delayMs;
  }

  /**
   * Position take-profit / stop-loss trigger.
   *
   * Semantics are deliberately identical to the auto spread bot:
   * - take-profit fires when the **executable exit spread** (`exitSpreadBps`: the leg that must be
   *   sold hits its bid, the leg that must be bought pays its ask) is at or below `takeProfitBps`;
   * - stop-loss fires when the **live spread** (`entrySpreadBps`) is at or beyond the signed stop
   *   line, judged by {@link adverseBreached} — the very predicate the auto entry gate and the auto
   *   stop share, so "breached" can never mean two different things in one engine.
   *
   * Both readings come from `freshMarketPair`, so they inherit the existing freshness gate (15 s
   * per leg, 3 s transport, 2 s cross-leg skew). No looser path is introduced: an exit is never
   * triggered off a quote the entry path would have refused.
   *
   * A missing field disables exactly that one threshold — never both, and never a default of 0 — so
   * a strategy that configures only a stop-loss cannot accidentally take profit at 0 bps.
   *
   * The latch (`positionExitArmed`) is set *before* the clip is submitted, so a rejected or
   * partially filled exit is retried by {@link continuePositionExit} on later ticks instead of being
   * re-decided (and re-logged) on every tick. The stop-loss is checked first: an adverse move must
   * never be masked by a same-tick take-profit reading.
   */
  private async maybeTriggerPositionExit(actor: StrategyActor): Promise<boolean> {
    if (actor.positionExitArmed) return false;
    if (!this.positionMonitoringEnabled(actor.config)) return false;
    const takeProfit = optionalDecimal(actor.config.takeProfitBps);
    const stopLoss = optionalDecimal(actor.config.stopLossBps);
    const stopActive = stopLoss !== null && stopLoss.gt(0);
    if (!stopActive && takeProfit === null) return false;
    // Thresholds are parsed before the ledger is read: an unconfigured strategy must cost nothing.
    const exposure = this.legExposures(actor.id, actor.config);
    const matched = this.matchedQuantity(exposure);
    if (!matched.gt(QUANTITY_EPSILON)) return false;

    if (stopActive) {
      const entry = this.entrySpreadBps(actor.config);
      if (entry && this.adverseBreached(actor.config, entry.spread)) {
        actor.positionExitArmed = true;
        actor.positionExitReason = 'stop-loss';
        this.runtime.addStrategyLog(actor.id, 'warning', 'Stop-loss triggered',
          `Spread ${entry.spread.toFixed(2)} bps hit the ${stopLoss.toString()} bps stop-loss`,
          matched.toString(), 'Closing both legs with market orders; the strategy stops when flat');
        // A resting entry quote must not survive the stop: it would re-open the leg being closed.
        await this.cancelQuotes(actor);
        await this.executeTakerClip(actor, 'exit', matched,
          `Spread ${entry.spread.toFixed(2)} bps hit the ${stopLoss.toString()} bps stop-loss`);
        return true;
      }
    }

    if (takeProfit !== null) {
      const exitSpread = this.exitSpreadBps(actor.config);
      if (exitSpread && exitSpread.lte(takeProfit)) {
        actor.positionExitArmed = true;
        actor.positionExitReason = 'take-profit';
        await this.cancelQuotes(actor);
        // `executeTakerClip` writes the `Take-profit triggered` / `Take-profit Executed` pair with
        // this condition, so the bps reading and the fill result are already in the log — a second
        // decision row under the same event name would only duplicate it.
        await this.executeTakerClip(actor, 'exit', matched,
          `Exit spread ${exitSpread.toFixed(2)} bps ≤ ${takeProfit.toString()} bps take-profit`);
        return true;
      }
    }
    return false;
  }

  /**
   * Unwind the remainder of a latched position exit in configured per-order clips. Idempotent: a
   * zero remaining quantity is a no-op, and an exit clip that is still open blocks a second one, so
   * two consecutive ticks that both satisfy the threshold submit exactly one exit per clip.
   */
  private async continuePositionExit(actor: StrategyActor): Promise<void> {
    if (actor.busy) return;
    // Never stack a second exit clip on an exit that is still open. The ledger only moves on fills,
    // so without this an exit order that outlives its `awaitTerminalOrder` budget would be
    // resubmitted on every following tick — the "two consecutive frames both satisfied the
    // threshold" duplication. `ensureHedged` guards its repair the same way.
    if (this.openStrategyOrders(actor.id, new Set()).length > 0) return;
    const exposure = this.legExposures(actor.id, actor.config);
    const matched = this.matchedQuantity(exposure);
    if (!matched.gt(QUANTITY_EPSILON)) return;
    const perOrder = new Decimal(actor.config.perOrderQuantity);
    const quantity = perOrder.gt(QUANTITY_EPSILON) ? Decimal.min(perOrder, matched) : matched;
    await this.executeTakerClip(actor, 'exit', quantity,
      actor.positionExitReason === 'stop-loss' ? 'Stop-loss exit in progress'
        : actor.positionExitReason === 'settlement' ? 'Settlement exit in progress'
          : actor.positionExitReason === 'funding-decay' ? 'Funding decay exit in progress'
            : actor.positionExitReason === 'max-hold' ? 'Max holding exit in progress'
              : 'Take-profit exit in progress');
  }

  /**
   * Exposure ceiling configured for a position strategy, or null when `maxPosition` is absent.
   * `maxPosition` is a left-leg quantity ceiling (the same unit as `totalAmount`), so it bounds the
   * *whole* position — filled quantity plus anything still in flight.
   */
  private positionExposureLimit(config: CreateStrategyInput): Decimal | null {
    if (config.kind !== 'position') return null;
    const limit = optionalDecimal(config.maxPosition);
    return limit !== null && limit.gt(0) ? limit : null;
  }

  /**
   * Admission check for a position entry / add-on clip: would placing `clip` push committed
   * exposure past `maxPosition`?
   *
   * Deliberately a hard refusal rather than a silent resize. Quietly shrinking the clip to the
   * remaining room would hide a misconfigured ceiling (a `maxPosition` that is not a multiple of
   * `perOrderQuantity`) behind orders that look normal in the log, and the operator would never
   * learn that the strategy never reached its `totalAmount`. Returns the human-readable reason, or
   * null when the clip is admitted.
   */
  private positionCapRejection(
    actor: StrategyActor,
    exposure: { left: Decimal; right: Decimal },
    clip: Decimal,
  ): string | null {
    const limit = this.positionExposureLimit(actor.config);
    if (limit === null) return null;
    const committed = this.placedQuantity(actor, exposure);
    const projected = committed.plus(clip);
    if (projected.lte(limit.plus(QUANTITY_EPSILON))) return null;
    const asset = actor.config.asset;
    return `${projected.toString()} ${asset} would exceed the ${limit.toString()} ${asset} max position`
      + ` (${committed.toString()} committed + ${clip.toString()} requested)`;
  }

  /**
   * Report a refused clip once per blocked episode. Logging every tick would flood the execution log
   * for a strategy that structurally cannot grow; the state transition is what matters, and the flag
   * is cleared as soon as a clip is admitted again.
   */
  private reportPositionCapBlocked(actor: StrategyActor, reason: string): void {
    if (actor.positionCapBlocked) return;
    actor.positionCapBlocked = true;
    this.runtime.addStrategyLog(actor.id, 'warning', 'Entry blocked by max position',
      reason, `${actor.config.maxPosition ?? '—'} ${actor.config.asset}`,
      'No order was submitted; exposure stays at the configured max position');
  }

  /**
   * Carry trigger evaluation: funding accrual and basis take-profit while a position is open,
   * funding-APR screening plus quote/inventory gating before entry. Entry is one full-amount
   * taker clip (left spot leg, right perpetual leg; sides derive from the funding direction).
   */
  private async evaluateCarryTriggers(actor: StrategyActor): Promise<void> {
    const config = actor.config;
    const direction = config.fundingDirection ?? 'POSITIVE';
    const state = actor.carry ?? (actor.carry = emptyCarryState());
    if (state.exited) return;
    const legs = legsOf(config);
    const rightMarket = this.freshMarket(legs.right.symbol);
    if (!rightMarket) return;

    const exposure = this.legExposures(actor.id, config);
    // One leg of the entry clip failed: never re-enter on top of a partial clip — the hedge
    // repair pass (reconcileExposure) tops up the lagging leg first.
    if (exposure.left.plus(exposure.right).abs().gt(QUANTITY_EPSILON)) return;
    const perpQuantity = exposure.right.abs();
    const matched = this.matchedQuantity(exposure);
    const fundingRate = new Decimal(rightMarket.fundingRate || '0');
    // Venue-specific settlement cadence (BINANCE 4h, Gate 8h, …) drives both the annualized APR
    // and the accrual clock; an unknown interval falls back to 8h with a one-time warning.
    const fundingIntervalHours = this.carryFundingIntervalHours(actor, legs.right.symbol);

    if (matched.gt(QUANTITY_EPSILON)) {
      // Latch the entry reference metrics on the first tick where both legs are open.
      if (state.basisEntryBps === null) {
        const leftMarket = this.freshMarket(legs.left.symbol);
        if (!leftMarket) return;
        const spotMid = new Decimal(leftMarket.bidPrice).plus(leftMarket.askPrice).div(2);
        const perpMid = new Decimal(rightMarket.bidPrice).plus(rightMarket.askPrice).div(2);
        if (!spotMid.gt(0) || !perpMid.gt(0)) return;
        state.basisEntryBps = perpMid.minus(spotMid).div(spotMid).mul(BPS);
        state.entryFundingApr = fundingAprFromRate(fundingRate, fundingIntervalHours);
        state.entrySpotNotionalUsdt = new Decimal(config.totalAmount ?? '0').mul(spotMid);
        // Accrue from the exchange's next settlement; fall back to the cached interval when unknown.
        const nextSettlement = Date.parse(rightMarket.nextFundingAt);
        state.nextFundingAccrualAt = Number.isFinite(nextSettlement) && nextSettlement > this.options.now()
          ? nextSettlement
          : this.options.now() + fundingIntervalHours * 3_600_000;
        this.runtime.addStrategyLog(actor.id, 'info', 'Carry position opened',
          `Entry basis ${state.basisEntryBps.toFixed(2)} bps · entry funding APR ${state.entryFundingApr.toFixed(2)}%`,
          `${config.totalAmount ?? '0'} ${config.asset}`,
          'Accruing funding each settlement until the basis take-profit triggers');
      }
      // Funding accrual: |rate| × perp notional per settlement while the perp leg is open.
      const perpMid = new Decimal(rightMarket.bidPrice).plus(rightMarket.askPrice).div(2);
      let accruals = 0;
      while (state.nextFundingAccrualAt !== null && perpQuantity.gt(QUANTITY_EPSILON)
        && this.options.now() >= state.nextFundingAccrualAt && accruals < MAX_FUNDING_ACCRUAL_CATCHUP) {
        state.fundingCollectedUsdt = state.fundingCollectedUsdt
          .plus(fundingRate.abs().mul(perpQuantity.mul(perpMid)));
        state.nextFundingAccrualAt += fundingIntervalHours * 3_600_000;
        accruals += 1;
      }
      const leftMarket = this.freshMarket(legs.left.symbol);
      if (leftMarket) {
        const spotAsk = new Decimal(leftMarket.askPrice);
        const perpBid = new Decimal(rightMarket.bidPrice);
        if (spotAsk.gt(0) && perpBid.gt(0)) {
          state.basisCurrentBps = perpBid.minus(spotAsk).div(spotAsk).mul(BPS);
          const takeProfit = new Decimal(config.basisTakeProfitBps ?? '20');
          // Positive carry exits when the basis converges down to the level; negative carry when
          // it converges up to −level. Either way |basis| closing in is the take-profit.
          const triggered = direction === 'POSITIVE'
            ? state.basisCurrentBps.lte(takeProfit)
            : state.basisCurrentBps.gte(takeProfit.neg());
          if (triggered) {
            state.exited = true;
            this.runtime.addStrategyLog(actor.id, 'info', 'Basis take-profit triggered',
              `Basis ${state.basisCurrentBps.toFixed(2)} bps ${direction === 'POSITIVE' ? '≤' : '≥'} ${direction === 'POSITIVE' ? '' : '−'}${takeProfit.toString()} bps`,
              matched.toString(), 'Closing both carry legs');
            await this.executeTakerClip(actor, 'exit', matched,
              `Basis ${state.basisCurrentBps.toFixed(2)} bps hit the ±${takeProfit.toString()} bps take-profit`);
            this.persistCarryMetrics(actor, state);
            return;
          }
        }
      }
      this.persistCarryMetrics(actor, state);
      return;
    }

    // Entry screening: the annualized funding rate must clear the configured APR in the
    // configured direction before any order is placed.
    const signMatches = direction === 'POSITIVE' ? fundingRate.gt(0) : fundingRate.lt(0);
    const apr = fundingAprFromRate(fundingRate, fundingIntervalHours);
    const aprMin = config.fundingAprMin ?? 15;
    if (!(signMatches && apr.gte(new Decimal(aprMin)))) {
      if (state.lastGatePassed !== false) {
        state.lastGatePassed = false;
        this.runtime.addStrategyLog(actor.id, 'info', 'Waiting for funding threshold',
          `Funding APR ${apr.toFixed(2)}% · needs ${direction === 'POSITIVE' ? '≥' : '≤ −'}${aprMin}%`,
          '—', 'No position is opened while the funding condition is unmet');
      }
      return;
    }
    const gate = await this.carryEntryGate(actor, legs);
    if (gate !== 'pass') {
      if (state.lastGatePassed !== false) {
        state.lastGatePassed = false;
        this.runtime.addStrategyLog(actor.id, 'warning', 'Carry entry gate blocked',
          direction === 'POSITIVE' ? 'USDT available below spot notional + contract margin' : 'Spot inventory below the configured amount',
          `${config.totalAmount ?? '0'} ${config.asset}`,
          gate === 'unavailable' ? 'Spot account balances unavailable; retrying' : 'Waiting for account balances to cover the entry');
      }
      return;
    }
    if (state.lastGatePassed !== true) {
      state.lastGatePassed = true;
      this.runtime.addStrategyLog(actor.id, 'info', 'Carry entry gate passed',
        `Funding APR ${apr.toFixed(2)}% ≥ ${aprMin}%`,
        `${config.totalAmount ?? '0'} ${config.asset}`,
        direction === 'POSITIVE' ? 'Buying spot and selling the perpetual' : 'Selling spot inventory and buying the perpetual');
    }
    await this.executeTakerClip(actor, 'entry', new Decimal(config.totalAmount ?? '0'),
      `Funding APR ${apr.toFixed(2)}% ≥ ${aprMin}% · ${direction}`);
    this.persistCarryMetrics(actor, state);
  }

  /**
   * Cached funding settlement interval in hours for the perpetual leg's symbol, falling back to
   * Gate's 8h cadence. The fallback is logged once per symbol per engine so a silently wrong
   * annualization stays visible without flooding the strategy log.
   */
  private carryFundingIntervalHours(actor: StrategyActor, symbol: string): number {
    const reported = this.options.fundingIntervalHours(symbol);
    if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) return reported;
    if (!this.intervalFallbackWarned.has(symbol)) {
      this.intervalFallbackWarned.add(symbol);
      this.runtime.addStrategyLog(actor.id, 'warning', 'Funding interval unknown',
        `No cached funding interval for ${symbol}; assuming 8h`,
        '—', 'Funding APR and the accrual clock use the Gate default until the venue interval is reported');
    }
    return FUNDING_PERIOD_MS / 3_600_000;
  }

  /**
   * Carry entry gate, routed per leg by its own venue (architecture v2 §T08). POSITIVE: the spot
   * notional is checked against the spot venue's quote balance and the contract margin against
   * the perpetual venue's balance — Gate legs go through the legacy /spot/accounts call, other
   * venues through their reconciled live balance (an unreported balance is not blocking: the
   * venue itself rejects an unfunded market order; when both legs sit on Gate one combined
   * USDT check covers notional + margin). NEGATIVE: base inventory must be verifiable on the
   * spot venue itself — Gate via /spot/accounts, other venues via their reconciled live
   * balance; an unknown venue balance blocks the entry ('unavailable') instead of clearing it
   * against Gate-side inventory.
   */
  private async carryEntryGate(
    actor: StrategyActor,
    legs: { left: LegDefinition; right: LegDefinition },
  ): Promise<'pass' | 'fail' | 'unavailable'> {
    const config = actor.config;
    const total = new Decimal(config.totalAmount ?? '0');
    if (!total.gt(0)) return 'fail';
    const direction = config.fundingDirection ?? 'POSITIVE';
    const spotVenue = legs.left.venue;
    const perpVenue = legs.right.venue;
    const spotQuote = legs.left.symbol.split('_')[3] ?? 'USDT';
    const gateAccounts = async (): Promise<Awaited<ReturnType<TradingRuntime['querySpotAccounts']>> | null> => {
      try {
        return await this.runtime.querySpotAccounts();
      } catch {
        return null;
      }
    };
    /** Reconciled live balance for one venue+coin, or null when the portfolio has not reported it. */
    const venueBalance = (venue: string, coin: string) => this.runtime.listBalances()
      .find((balance) => balance.venue === venue && balance.coin === coin) ?? null;
    /** Gate-side USDT coverage check via /spot/accounts; null means the source is unavailable. */
    const gateUsdtAvailable = async (): Promise<Decimal | null> => {
      const accounts = await gateAccounts();
      if (!accounts) return null;
      const usdt = accounts.find((account) => account.currency === 'USDT');
      return usdt ? new Decimal(usdt.available) : new Decimal(0);
    };

    if (direction === 'POSITIVE') {
      const spotPrice = this.executablePrice(legs.left.symbol, 'BUY');
      const perpPrice = this.executablePrice(legs.right.symbol, 'SELL');
      if (!spotPrice || !perpPrice) return 'unavailable';
      const spotNotional = total.mul(spotPrice);
      const contractMargin = total.mul(perpPrice).div(new Decimal(config.contractLeverage ?? '1'));
      // Both legs on Gate: one combined check against the same USDT book.
      if (spotVenue === 'GATE' && perpVenue === 'GATE') {
        const available = await gateUsdtAvailable();
        if (available === null) return 'unavailable';
        return available.gte(spotNotional.plus(contractMargin)) ? 'pass' : 'fail';
      }
      if (spotVenue === 'GATE') {
        const available = await gateUsdtAvailable();
        if (available === null) return 'unavailable';
        if (!available.gte(spotNotional)) return 'fail';
      } else {
        // Non-Gate spot leg: /spot/accounts only describes Gate, so the venue-side notional is
        // enforced through the reconciled live balance when available.
        const balance = venueBalance(spotVenue, spotQuote);
        if (balance && !new Decimal(balance.availableBalance).gte(spotNotional)) return 'fail';
      }
      if (perpVenue === 'GATE') {
        const available = await gateUsdtAvailable();
        if (available === null) return 'unavailable';
        return available.gte(contractMargin) ? 'pass' : 'fail';
      }
      const marginBalance = venueBalance(perpVenue, legs.right.symbol.split('_')[3] ?? 'USDT');
      if (marginBalance && !new Decimal(marginBalance.availableBalance).gte(contractMargin)) return 'fail';
      return 'pass';
    }
    if (spotVenue === 'GATE') {
      const accounts = await gateAccounts();
      if (!accounts) return 'unavailable';
      const base = accounts.find((account) => account.currency === config.asset);
      return base && new Decimal(base.available).gte(total) ? 'pass' : 'fail';
    }
    // A non-Gate inventory check can never be answered by Gate's /spot/accounts: without a
    // reconciled venue balance the entry stays blocked and retried on the next tick.
    const balance = venueBalance(spotVenue, config.asset);
    if (!balance) return 'unavailable';
    return new Decimal(balance.availableBalance).gte(total) ? 'pass' : 'fail';
  }

  /** Basis PnL in USDT: entry spot notional × (entry basis − current basis) × direction sign. */
  private carryBasisPnlUsdt(config: CreateStrategyInput, state: CarryRuntimeState): Decimal {
    if (state.basisEntryBps === null || state.basisCurrentBps === null || state.entrySpotNotionalUsdt === null) return ZERO;
    const convergence = state.basisEntryBps.minus(state.basisCurrentBps)
      .mul((config.fundingDirection ?? 'POSITIVE') === 'POSITIVE' ? ONE : ONE.neg());
    return state.entrySpotNotionalUsdt.mul(convergence).div(BPS);
  }

  /** Sum of strategy-linked fill fees, treated as USDT outflow. */
  private strategyFeesPaidUsdt(strategyId: string): Decimal {
    return (this.strategyFeesStatement.all(strategyId) as Array<{ fee: string }>)
      .reduce((sum, row) => sum.plus(new Decimal(row.fee || '0')), ZERO);
  }

  /** Serialize the carry accounting snapshot and write it only when a value changed. */
  private persistCarryMetrics(actor: StrategyActor, state: CarryRuntimeState): StrategyCarryMetrics {
    const feesPaidUsdt = this.strategyFeesPaidUsdt(actor.id);
    const basisPnlUsdt = this.carryBasisPnlUsdt(actor.config, state);
    const netPnlUsdt = state.fundingCollectedUsdt.plus(basisPnlUsdt).minus(feesPaidUsdt);
    const metrics: StrategyCarryMetrics = {
      fundingCollectedUsdt: state.fundingCollectedUsdt.toString(),
      basisEntryBps: (state.basisEntryBps ?? ZERO).toString(),
      basisCurrentBps: (state.basisCurrentBps ?? ZERO).toString(),
      basisPnlUsdt: basisPnlUsdt.toString(),
      feesPaidUsdt: feesPaidUsdt.toString(),
      netPnlUsdt: netPnlUsdt.toString(),
      entryFundingApr: (state.entryFundingApr ?? ZERO).toString(),
      nextFundingAccrualAt: state.nextFundingAccrualAt === null
        ? null
        : new Date(state.nextFundingAccrualAt).toISOString(),
    };
    const serialized = JSON.stringify(metrics);
    if (actor.lastCarryMetricsJson !== serialized) {
      actor.lastCarryMetricsJson = serialized;
      this.runtime.updateStrategyMetrics(actor.id, metrics);
    }
    return metrics;
  }

  /**
   * Premium bot single lifecycle. Quantities are in ADR units throughout. It accumulates entry
   * clips until take profit first triggers. That transition is durable and one-way: after it
   * begins, the strategy only reduces the quantity that actually opened, completes at zero, and
   * can never start a second entry cycle.
   */
  private async evaluatePremiumClip(actor: StrategyActor): Promise<void> {
    const config = actor.config;
    const exposure = this.legExposures(actor.id, config);
    if (this.premiumExitStarted(actor)) {
      await this.ensurePremiumFlat(actor, exposure);
      return;
    }
    if (exposure.left.plus(exposure.right).abs().gt(QUANTITY_EPSILON)) return;
    const matched = this.matchedQuantity(exposure);
    const perOrder = new Decimal(config.perOrderQuantity);
    const shortPremium = config.leftSide === 'SELL';
    const entryLevel = new Decimal(config.entryPremiumPct ?? '0');
    const step = config.grid ? new Decimal(config.gridStepPct ?? '0') : ZERO;
    const target = this.strategyTarget(config);
    const inFlight = this.inFlightQuantity(actor, new Set());
    const capacity = Decimal.max(ZERO, target.minus(matched).minus(inFlight));

    // Equal-notional hedges are sized from the same executable prices that trigger the clip; the
    // exit unwinds the actually-held share ratio so both legs converge to zero together.
    const equalNotional = this.equalNotional(config);
    const entryQuote = this.premiumQuote(config, 'entry');
    if (entryQuote !== null && capacity.gt(QUANTITY_EPSILON)) {
      const entryPremium = entryQuote.premium;
      // The rung currently being filled: completed rungs plus any partial one gate at its level.
      const rung = config.grid ? matched.plus(inFlight).div(perOrder).plus(RUNG_EPSILON).floor() : ZERO;
      const level = shortPremium ? entryLevel.plus(step.mul(rung)) : entryLevel.minus(step.mul(rung));
      const triggered = shortPremium ? entryPremium.gte(level) : entryPremium.lte(level);
      if (triggered) {
        // Cap grid clips at the current rung's remaining size so one wide tick cannot jump rungs.
        const rungRoom = config.grid ? perOrder.mul(rung.plus(1)).minus(matched).minus(inFlight) : perOrder;
        const quantity = Decimal.min(perOrder, rungRoom, capacity);
        if (quantity.gt(QUANTITY_EPSILON)) {
          const entryHedge = equalNotional ? quantity.mul(entryQuote.adrPrice).div(entryQuote.hedgePrice) : undefined;
          await this.executeTakerClip(actor, 'entry', quantity,
            `Premium ${entryPremium.toFixed(2)}% ${shortPremium ? '≥' : '≤'} ${level.toFixed(2)}%`
            + ` · quotes ${entryQuote.adrPrice.toString()} / ${entryQuote.hedgePrice.toString()}`,
          entryHedge);
          return;
        }
      }
    }

    // Reduce-only premium strategies use the entry threshold as a close trigger. They stop after
    // the configured amount is reduced and never run the opposite-side take-profit lifecycle.
    if (config.reduceOnly) return;
    if (!matched.gt(QUANTITY_EPSILON)) return;
    const exitQuote = this.premiumQuote(config, 'exit');
    if (exitQuote === null) return;
    const exitPremium = exitQuote.premium;
    const exitHedgeFor = (quantity: Decimal): Decimal | undefined => equalNotional && exposure.left.abs().gt(QUANTITY_EPSILON)
      ? quantity.mul(exposure.rightShares.abs()).div(exposure.left.abs())
      : undefined;
    if (config.grid) {
      const topRung = matched.div(perOrder).minus(RUNG_EPSILON).ceil().minus(1);
      const rungEntry = shortPremium ? entryLevel.plus(step.mul(topRung)) : entryLevel.minus(step.mul(topRung));
      const exitLevel = shortPremium ? rungEntry.minus(step) : rungEntry.plus(step);
      const triggered = shortPremium ? exitPremium.lte(exitLevel) : exitPremium.gte(exitLevel);
      if (triggered) {
        const quantity = Decimal.min(matched.minus(perOrder.mul(topRung)), perOrder, matched);
        if (quantity.gt(QUANTITY_EPSILON)) {
          await this.executeTakerClip(actor, 'exit', quantity,
            `Premium ${exitPremium.toFixed(2)}% ${shortPremium ? '≤' : '≥'} rung ${topRung.plus(1).toString()} exit ${exitLevel.toFixed(2)}%`
            + ` · quotes ${exitQuote.adrPrice.toString()} / ${exitQuote.hedgePrice.toString()}`,
          exitHedgeFor(quantity));
        }
      }
    } else {
      const takeProfitLevel = new Decimal(config.takeProfitPremiumPct ?? '0');
      const triggered = shortPremium ? exitPremium.lte(takeProfitLevel) : exitPremium.gte(takeProfitLevel);
      if (triggered) {
        const quantity = Decimal.min(perOrder, matched);
        if (quantity.gt(QUANTITY_EPSILON)) {
          await this.executeTakerClip(actor, 'exit', quantity,
            `Premium ${exitPremium.toFixed(2)}% ${shortPremium ? '≤' : '≥'} ${takeProfitLevel.toFixed(2)}%`
            + ` · quotes ${exitQuote.adrPrice.toString()} / ${exitQuote.hedgePrice.toString()}`,
          exitHedgeFor(quantity));
        }
      }
    }
  }

  /**
   * Open strategy-order quantity in left-leg (ADR) units (right-leg orders multiply by the
   * ratio). Equal-notional right-leg orders convert slightly above their true ADR equivalent,
   * which only makes the capacity estimate more conservative while a clip is in flight.
   */
  private inFlightQuantity(actor: StrategyActor, excludeIds: Set<string>): Decimal {
    const ratio = adrRatioOf(actor.config);
    return this.openStrategyOrders(actor.id, excludeIds).reduce((sum, order) => {
      const quantity = new Decimal(order.quantity);
      return sum.plus(order.strategyLeg === 'right' ? quantity.mul(ratio) : quantity);
    }, ZERO);
  }

  private remainingEntryCapacity(actor: StrategyActor, exposure: { left: Decimal; right: Decimal }): Decimal {
    const matched = this.matchedQuantity(exposure);
    const inFlight = this.inFlightQuantity(actor, new Set([...actor.quotes.values()].map((quote) => quote.orderId)));
    const target = this.strategyTarget(actor.config);
    return Decimal.max(ZERO, target.minus(matched).minus(inFlight));
  }

  /**
   * A sub-minimum maker-taker residual can be absorbed by the next normal clip. When the maker
   * leg is already the excess leg, reduce its next quote by that residual; the taker repair then
   * remains one full configured clip. When the taker leg is excess, leave the maker clip whole
   * and the subsequent hedge naturally shrinks by the residual instead.
   */
  private carryAdjustedMakerQuantity(
    actor: StrategyActor,
    exposure: { left: Decimal; right: Decimal },
    quantity: Decimal,
  ): Decimal {
    if (actor.kind !== 'position') return quantity;
    const imbalance = exposure.left.plus(exposure.right);
    if (imbalance.abs().lte(QUANTITY_EPSILON)) return quantity;
    const legs = legsOf(actor.config);
    const makerLeg = (actor.config.makerLeg ?? 'left') === 'left' ? legs.left : legs.right;
    const makerDirection = makerLeg.side === 'BUY' ? ONE : ONE.neg();
    if (imbalance.mul(makerDirection).lte(QUANTITY_EPSILON)) return quantity;
    return Decimal.max(ZERO, quantity.minus(imbalance.abs()));
  }

  private async evaluateTakerClip(actor: StrategyActor): Promise<void> {
    const entry = this.entrySpreadBps(actor.config);
    const exposure = this.legExposures(actor.id, actor.config);
    const imbalance = exposure.left.plus(exposure.right);
    if (imbalance.abs().gt(QUANTITY_EPSILON)) return;
    const matched = this.matchedQuantity(exposure);
    const perOrder = new Decimal(actor.config.perOrderQuantity);
    const entryLevel = new Decimal(actor.config.entryBps ?? '0');
    // Three independent admission conditions, evaluated cheap→semantic so a breached or
    // un-triggered book never runs the ladder math. They are deliberately separate helpers:
    // `adverseBreached` is shared with the stop path and must stay single-purpose.
    const breached = entry !== null && actor.kind === 'auto' && actor.config.stopLossBps !== undefined
      && this.adverseBreached(actor.config, entry.spread);
    // Signed entry: a positive threshold enters when the spread is at least that wide, a negative
    // threshold enters when the spread is at most that negative (bounded opening cost).
    const atThreshold = entry !== null
      && (entryLevel.gte(0) ? entry.spread.gte(entryLevel) : entry.spread.lte(entryLevel));
    const ladderTier = entry !== null && actor.config.addOnStepBps
      ? this.tierIndexFor(actor.config, entry.spread) : 0;
    const ladderOk = entry !== null && this.ladderAllowsAdd(actor, exposure, entry.spread);
    const entryTriggered = entry !== null && !breached && atThreshold && ladderOk;

    if (entry && entryTriggered) {
      const capacity = this.remainingEntryCapacity(actor, exposure);
      const quantity = Decimal.min(perOrder, capacity);
      if (quantity.gt(QUANTITY_EPSILON)) {
        // `maxPosition` is a hard ceiling on total exposure, checked before anything is submitted.
        // A clip that would breach it is refused outright (never quietly resized) and the reason is
        // reported once — see `positionCapRejection`.
        const capRejection = this.positionCapRejection(actor, exposure, quantity);
        if (capRejection !== null) {
          this.reportPositionCapBlocked(actor, capRejection);
          return;
        }
        actor.positionCapBlocked = false;
        // An add-on clip *is* an entry clip, so it reuses the existing events and carries its tier
        // in the condition instead of inventing a new event name (§8.8). Tier 0 is the opening
        // clip rather than an add-on, so it keeps the original wording — only the clips the ladder
        // actually adds are labelled, and their number is 1-based to match the UI's tier list
        // (`Add-on tiers: 50 / 70 / 90`), where tier 1 is the entry level itself.
        const condition = actor.config.addOnStepBps && ladderTier > 0
          ? `Add-on tier ${ladderTier + 1} · spread ${entry.spread.toFixed(2)} bps ${entryLevel.gte(0) ? '≥' : '≤'} ${this.tierLevelBps(actor.config, ladderTier).toFixed(2)} bps`
          : `Spread ${entry.spread.toFixed(2)} bps ${entryLevel.gte(0) ? '≥' : '≤'} ${actor.config.entryBps} bps`;
        await this.executeTakerClip(actor, 'entry', quantity, condition);
        return;
      }
    }
    if (actor.kind === 'auto' && actor.config.takeProfitBps && matched.gt(QUANTITY_EPSILON)) {
      const exitSpread = this.exitSpreadBps(actor.config);
      if (exitSpread && exitSpread.lte(new Decimal(actor.config.takeProfitBps))) {
        const quantity = Decimal.min(perOrder, matched);
        if (quantity.gt(QUANTITY_EPSILON)) {
          await this.executeTakerClip(actor, 'exit', quantity, `Exit spread ${exitSpread.toFixed(2)} bps ≤ ${actor.config.takeProfitBps} bps`);
        }
      }
    }
  }

  private legsForIntent(actor: StrategyActor, intent: QuoteIntent): { left: LegDefinition; right: LegDefinition } {
    const legs = legsOf(actor.config);
    if (intent === 'entry') return legs;
    return {
      left: { ...legs.left, side: oppositeSide(legs.left.side) },
      right: { ...legs.right, side: oppositeSide(legs.right.side) },
    };
  }

  /**
   * The leg the venue enforces reduce-only against — the perpetual leg. A spot leg is never
   * reduce-only (a sell is capped by the balance held, not by a position), so a pair with one
   * spot leg has exactly one candidate; a pair of two perps is anchored on the left leg, the
   * same anchor the venue-truth exit clamp uses. Null only when both legs are spot.
   */
  private perpetualLegOf(legs: { left: LegDefinition; right: LegDefinition }): LegDefinition | null {
    if (!isSpotSymbol(legs.left.symbol)) return legs.left;
    if (!isSpotSymbol(legs.right.symbol)) return legs.right;
    return null;
  }

  /**
   * Gate spot market buys must be sized in quote currency: convert the requested base quantity at
   * the current spot mid so the ledger (which tracks base quantities) and the venue order agree.
   * Returns null for non-spot orders and for spot orders without a usable mid.
   */
  private spotMarketBuyQuoteQty(symbol: string, quantity: Decimal): Decimal | null {
    if (!isSpotSymbol(symbol)) return null;
    const market = this.freshMarket(symbol);
    if (!market) return null;
    const mid = new Decimal(market.bidPrice).plus(market.askPrice).div(2);
    return mid.gt(0) ? quantity.mul(mid) : null;
  }

  /**
   * Walk one leg's live book for a clip of `quantity` and report how far the fill would slip from
   * that leg's own top-of-book price, plus the notional the visible book actually holds.
   *
   * Returns null when the market source maintains no book for the symbol (the guard stands down
   * instead of inventing a number) and for spot buys, whose quantity is denominated in the quote
   * currency rather than in book sizes. `shortfall` marks a clip the visible book cannot fill.
   */
  private bookWalk(symbol: string, side: 'BUY' | 'SELL', quantity: Decimal): { slippageBps: Decimal; depthUsdt: number; shortfall: boolean } | null {
    const book = this.markets.orderBook?.(symbol);
    if (!book) return null;
    const levels = side === 'BUY' ? book.asks : book.bids;
    if (levels.length === 0) return null;
    const top = new Decimal(levels[0][0]);
    if (!top.gt(0)) return null;
    let remaining = quantity;
    let spent = new Decimal(0);
    let filled = new Decimal(0);
    let depthUsdt = 0;
    for (const [priceText, sizeText] of levels) {
      const price = new Decimal(priceText);
      const size = new Decimal(sizeText);
      if (!price.gt(0) || !size.gt(0)) continue;
      depthUsdt += Number(price.mul(size));
      if (!remaining.gt(QUANTITY_EPSILON)) continue;
      const take = Decimal.min(size, remaining);
      spent = spent.plus(take.mul(price));
      filled = filled.plus(take);
      remaining = remaining.minus(take);
    }
    if (!filled.gt(0)) return null;
    // BUY pays above the top ask, SELL receives below the top bid: both are a loss of the same
    // sign once expressed against the top of book.
    const vwap = spent.div(filled);
    const adverse = side === 'BUY' ? vwap.minus(top) : top.minus(vwap);
    return {
      slippageBps: Decimal.max(0, adverse).div(top).mul(BPS),
      depthUsdt,
      shortfall: remaining.gt(QUANTITY_EPSILON),
    };
  }

  /**
   * Admission check for a taker entry: refuse to walk a book that cannot absorb the clip at the
   * configured slippage ceiling. Entry-only by design — a thin book is a reason to skip a trade,
   * never a reason to sit in an unhedged leg, so exits bypass this entirely.
   */
  private takerDepthRejection(legs: { left: LegDefinition; right: LegDefinition }, leftQuantity: Decimal, rightQuantity: Decimal): string | null {
    const ceiling = this.options.maxTakerSlippageBps ?? 0;
    if (ceiling <= 0) return null;
    for (const [leg, quantity] of [[legs.left, leftQuantity], [legs.right, rightQuantity]] as const) {
      if (!quantity.gt(QUANTITY_EPSILON)) continue;
      // Spot buys are sized in quote currency; their book walk would compare base sizes to a quote
      // amount, so they are not judged here.
      if (isSpotSymbol(leg.symbol) && leg.side === 'BUY') continue;
      const walk = this.bookWalk(leg.symbol, leg.side, quantity);
      if (!walk) continue;
      if (walk.shortfall) {
        return `Book depth too thin: ${leg.side} ${leg.symbol} ${quantity.toString()} needs more size than the book shows ($${walk.depthUsdt.toFixed(2)} visible)`;
      }
      if (walk.slippageBps.gt(ceiling)) {
        return `Book depth too thin: ${leg.side} ${leg.symbol} ${quantity.toString()} would slip ${walk.slippageBps.toFixed(1)} bps (limit ${ceiling} bps, $${walk.depthUsdt.toFixed(2)} visible)`;
      }
    }
    return null;
  }

  private async executeTakerClip(actor: StrategyActor, intent: QuoteIntent, quantity: Decimal, condition: string, rightQuantityOverride?: Decimal): Promise<void> {
    const legs = this.legsForIntent(actor, intent);
    const ratio = adrRatioOf(actor.config);
    const perpetualLeg = this.perpetualLegOf(legs);
    // Default hedge sizing is the strategy's fixed conversion; premium callers override it for
    // equal-notional clips (entry: priced hedge, exit: proportional unwind).
    let leftQuantity = quantity;
    let rightRaw = rightQuantityOverride ?? quantity.div(ratio);
    // Venue-truth clamp on exits. A reduce-only rejection remembered the venue's real size for
    // the perpetual leg, and that size bounds the whole clip: both legs are a hedge, so exiting
    // the clamped size on one and the ledger's size on the other would leave naked exposure.
    // Clamp the leg the venue enforces reduce-only on, then scale the counterpart by the same
    // factor — the hedge leg keeps whatever linear relation the caller configured (the ADR ratio,
    // or an equal-notional share of the same clip) at the venue's real size. No clamp is a no-op.
    if (intent === 'exit' && perpetualLeg !== null) {
      if (perpetualLeg.leg === 'left') {
        const clamped = this.exitQuantityFor(actor, perpetualLeg.symbol, quantity);
        if (!clamped.eq(quantity) && quantity.gt(0)) rightRaw = rightRaw.mul(clamped).div(quantity);
        leftQuantity = clamped;
      } else {
        const requestedRight = rightRaw;
        const clamped = this.exitQuantityFor(actor, perpetualLeg.symbol, requestedRight);
        if (!clamped.eq(requestedRight) && requestedRight.gt(0)) leftQuantity = quantity.mul(clamped).div(requestedRight);
        rightRaw = clamped;
      }
    }
    const rightQuantity = roundToStep(rightRaw, this.constraintsFor(legs.right.symbol).lotSize, 'down');
    // A clamp can retire to zero when the venue holds nothing reducible: there is then no exit to
    // place on either leg, and the rejection that set the clamp has already reported why. Exits
    // that reach zero for any other reason (a hedge leg rounding below one lot) keep the size
    // preflight below as their voice. Checked before the preflight so a zero-sized order never
    // reaches the venue.
    const clampActive = perpetualLeg !== null && actor.venueExitQuantitySymbol === perpetualLeg.symbol
      && actor.venueExitQuantity !== null;
    if (intent === 'exit' && clampActive
      && (!leftQuantity.gt(QUANTITY_EPSILON) || !rightQuantity.gt(QUANTITY_EPSILON))) return;
    const sizeError = this.marketOrderSizeError(legs.left.symbol, legs.left.side, leftQuantity)
      ?? this.marketOrderSizeError(legs.right.symbol, legs.right.side, rightQuantity);
    if (sizeError) {
      await this.pause(actor, `Order-size compliance check failed: ${sizeError.label ?? sizeError.code}`);
      return;
    }
    // Depth admission runs after the size preflight (a clip that can never be legal should not be
    // reported as an illiquid book) and before anything is submitted. Entry only: blocking an
    // exit would keep a naked leg alive, which is worse than any slippage.
    if (intent === 'entry') {
      const depthRejection = this.takerDepthRejection(legs, leftQuantity, rightQuantity);
      if (depthRejection) {
        await this.pause(actor, depthRejection);
        return;
      }
    }
    const leftQuoteQty = legs.left.side === 'BUY' ? this.spotMarketBuyQuoteQty(legs.left.symbol, leftQuantity) : null;
    const rightQuoteQty = legs.right.side === 'BUY' ? this.spotMarketBuyQuoteQty(legs.right.symbol, rightQuantity) : null;
    if ((isSpotSymbol(legs.left.symbol) && legs.left.side === 'BUY' && leftQuoteQty === null)
      || (isSpotSymbol(legs.right.symbol) && legs.right.side === 'BUY' && rightQuoteQty === null)) {
      await this.pause(actor, 'Spot market data unavailable for quote-quantity conversion; review the spot leg quotes');
      return;
    }
    const clip = `clip-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    actor.busy = true;
    try {
      const reduceOnly = intent === 'exit' || actor.config.reduceOnly;
      // An exit driven by a latched auto stop-loss must not be labelled "Take-profit" — this is the
      // C2 mislabelling: with a position open, `intent === 'exit'` covered both take-profit and
      // stop-loss unwinds. Otherwise the event names are unchanged (C2). A latched `position`
      // stop-loss is the same hazard and is judged by the same helper.
      const stopLossExit = this.isStopLossExit(actor, intent);
      const settlementExit = intent === 'exit' && actor.positionExitReason === 'settlement';
      const triggeredEvent = stopLossExit ? 'Stop-loss exit triggered'
        : actor.positionExitReason === 'funding-decay' ? 'Funding decay exit triggered'
        : actor.positionExitReason === 'max-hold' ? 'Max holding exit triggered'
        : settlementExit ? 'Settlement exit triggered'
        : intent === 'exit' ? 'Take-profit triggered'
        : actor.config.reduceOnly ? 'Reduce-only triggered' : 'Entry triggered';
      this.runtime.addStrategyLog(actor.id, 'info', triggeredEvent, condition,
        `${leftQuantity.toString()} ${actor.config.asset}`, 'Submitting both taker legs');
      const submissions = await Promise.allSettled([
        this.runtime.createOrder({ symbol: legs.left.symbol, side: legs.left.side, type: 'MARKET', timeInForce: 'IOC',
          quantity: leftQuantity.toString(), ...(leftQuoteQty !== null ? { quoteQty: leftQuoteQty.toString() } : {}), reduceOnly },
        { strategyId: actor.id, strategyLeg: 'left', strategyClip: clip }),
        this.runtime.createOrder({ symbol: legs.right.symbol, side: legs.right.side, type: 'MARKET', timeInForce: 'IOC',
          quantity: rightQuantity.toString(), ...(rightQuoteQty !== null ? { quoteQty: rightQuoteQty.toString() } : {}), reduceOnly },
        { strategyId: actor.id, strategyLeg: 'right', strategyClip: clip }),
      ]);
      const accepted = submissions.filter((entry): entry is PromiseFulfilledResult<ExecutionOrder> => entry.status === 'fulfilled');
      const rejected = submissions.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
      if (rejected.length > 0) {
        const gateErrors = rejected.map((entry) => entry.reason).filter((reason): reason is GateApiError => reason instanceof GateApiError);
        // A reduce-only rejection on an exit means the venue holds less than the ledger: the
        // position was closed outside the engine. Re-anchor the position state and re-report the
        // exit at the venue's real size instead of spending the five-strike budget on orders the
        // venue cannot accept. The maker path has always done this inline; leaving the taker path
        // out is what let `AUTO-B63B204D` submit the same doomed stop-loss clip five times in 62
        // seconds and then pause. A state mismatch is not a submission failure, so it is the
        // reconciliation — not `failureCount` — that owns the outcome.
        let venueTruthHandled = false;
        if (intent === 'exit' && rejected.some((entry) => isReduceOnlyQuantityRejection(entry.reason))) {
          if (perpetualLeg !== null) {
            // The quantities actually submitted: the venue rejected those, not the caller's request.
            const requested = perpetualLeg.leg === 'left' ? leftQuantity : rightQuantity;
            const outcome = await this.reconcileExitQuantity(actor, perpetualLeg.symbol, perpetualLeg.side, requested);
            if (outcome === 'withdrawn') {
              await this.pause(actor, 'Venue holds no reducible position on the exit leg; the position was closed outside this strategy');
            }
            venueTruthHandled = outcome !== 'ordinary';
          }
        }
        if (!venueTruthHandled) {
          actor.failureCount += 1;
          const rateLimitWait = gateErrors
            .filter((error) => error.statusCode === 429)
            .reduce((longest, error) => Math.max(longest, error.retryAfterMs ?? 30_000), 0);
          actor.cooldownUntil = this.options.now() + Math.max(
            rateLimitWait,
            Math.min(60_000, 2_000 * 2 ** Math.min(4, actor.failureCount)),
          );
          this.runtime.addStrategyLog(actor.id, 'warning', 'Leg submission failed', condition, leftQuantity.toString(),
            rejected.map((entry) => entry.reason instanceof Error ? entry.reason.message.slice(0, 120) : 'submit error').join(' · '));
          const insufficientMargin = gateErrors.some((error) => /(?:MARGIN|BALANCE)/.test(error.label));
          if (intent === 'entry' && insufficientMargin && accepted.length === 0) {
            await this.pause(actor, 'Order rejected for insufficient margin; strategy stopped retrying until manually reviewed');
          } else if (actor.failureCount >= 5) {
            await this.pause(actor, 'Five consecutive order submissions failed; check credentials, balances, and venue status');
          }
        }
      } else {
        actor.failureCount = 0;
      }
      const settled = await Promise.all(accepted.map((entry) => this.runtime.awaitTerminalOrder(entry.value.id, this.options.orderTimeoutMs)));
      const left = settled.find((order) => order.strategyLeg === 'left');
      const right = settled.find((order) => order.strategyLeg === 'right');
      if (left?.state === 'FILLED' && right?.state === 'FILLED') {
        const stopLossExit = this.isStopLossExit(actor, intent);
        const settlementExecuted = intent === 'exit' && actor.positionExitReason === 'settlement';
        const executedEvent = stopLossExit ? 'Stop-loss Executed'
          : actor.positionExitReason === 'funding-decay' ? 'Funding decay exit Executed'
          : actor.positionExitReason === 'max-hold' ? 'Max holding exit Executed'
          : settlementExecuted ? 'Settlement exit Executed'
          : intent === 'exit' ? 'Take-profit Executed'
          : actor.config.reduceOnly ? 'Reduce-only Executed' : 'Position open Executed';
        this.runtime.addStrategyLog(actor.id, 'info',
          executedEvent,
          condition, `${left.executedQuantity} ${actor.config.asset}`,
          `${left.side} ${left.symbol} ${left.executedQuantity} @ ${left.executedAveragePrice ?? '—'} · `
          + `${right.side} ${right.symbol} ${right.executedQuantity} @ ${right.executedAveragePrice ?? '—'}`);
      } else {
        // Preserve leg-level diagnostics when the clip did not complete cleanly.
        for (const order of settled) {
          const failure = failureSummary(order.failureReason);
          this.runtime.addStrategyLog(actor.id, isTerminalOrderState(order.state) && order.state === 'FILLED' ? 'info' : 'warning',
            `${order.strategyLeg === 'left' ? 'Left' : 'Right'} leg ${order.state.toLowerCase()}`,
            condition, `${order.executedQuantity}/${order.quantity} ${actor.config.asset}`,
            `${order.side} ${order.symbol} · ${failure ?? `avg ${order.executedAveragePrice ?? '—'}`}`);
        }
      }
    } finally {
      actor.busy = false;
    }
    await this.afterExecutionChange(actor);
  }

  private desiredMakerPrice(actor: StrategyActor, intent: QuoteIntent, tier = 0): { price: Decimal; makerLeg: LegDefinition; takerLeg: LegDefinition } | null {
    const makerLegKey = actor.config.makerLeg ?? 'left';
    const legs = this.legsForIntent(actor, intent);
    const makerLeg = makerLegKey === 'left' ? legs.left : legs.right;
    const takerLeg = makerLegKey === 'left' ? legs.right : legs.left;
    const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol);
    if (!pair) return null;
    const makerMarket = makerLeg.leg === 'left' ? pair.left : pair.right;
    const takerMarket = takerLeg.leg === 'left' ? pair.left : pair.right;
    // Entry rests at the *next unfilled tier's* level rather than the raw entry threshold, so the
    // maker quote walks outward one step per filled clip (sequential ladder, §8.5.2). `tier` is 0
    // without a ladder, which reproduces today's price exactly. The exit branch is unchanged.
    const threshold = intent === 'entry'
      ? this.tierLevelBps(actor.config, tier)
      : new Decimal(actor.config.takeProfitBps ?? '0');
    const factor = threshold.div(BPS);
    const tick = this.constraintsFor(makerLeg.symbol).tickSize;
    let boundary: Decimal;
    if (intent === 'entry') {
      boundary = makerLeg.side === 'SELL'
        ? roundToStep(new Decimal(takerMarket.askPrice).mul(new Decimal(1).plus(factor)), tick, 'up')
        : roundToStep(new Decimal(takerMarket.bidPrice).mul(new Decimal(1).minus(factor)), tick, 'down');
    } else {
      boundary = makerLeg.side === 'BUY'
        ? roundToStep(new Decimal(takerMarket.bidPrice).mul(new Decimal(1).plus(factor)), tick, 'down')
        : roundToStep(new Decimal(takerMarket.askPrice).div(new Decimal(1).plus(factor)), tick, 'up');
    }
    // Join the maker venue's best queue whenever that price already satisfies the configured
    // spread. Otherwise rest at the spread boundary. A BUY never exceeds its maximum acceptable
    // price; a SELL never goes below its minimum acceptable price, so the POC order cannot cross
    // the maker book merely because the economic boundary lies through the best ask/bid.
    const makerTop = new Decimal(makerLeg.side === 'BUY' ? makerMarket.bidPrice : makerMarket.askPrice);
    let price = makerLeg.side === 'BUY'
      ? Decimal.min(boundary, makerTop)
      : Decimal.max(boundary, makerTop);
    // Signed offset: positive = more aggressive (toward the taker side), negative = more passive.
    // The POC order still cannot cross the book — the venue rejects it if the offset would.
    const offsetBps = intent === 'entry' ? (actor.config.makerEntryOffsetBps ?? 0) : 0;
    if (offsetBps !== 0) {
      const delta = price.mul(offsetBps).div(BPS);
      const adjusted = makerLeg.side === 'BUY' ? price.plus(delta) : price.minus(delta);
      if (adjusted.gt(0)) price = adjusted;
    }
    if (!price.gt(0)) return null;
    return { price, makerLeg, takerLeg };
  }

  private async evaluateMakerQuotes(actor: StrategyActor): Promise<void> {
    const exposure = this.legExposures(actor.id, actor.config);
    const matched = this.matchedQuantity(exposure);
    // Entry-quote timeout: cancel only, never convert to a market order. High-APR microcaps have
    // thin books, and a market fallback would hand the whole edge to slippage.
    const timeoutSec = actor.config.makerEntryTimeoutSeconds ?? 0;
    const entryQuote = actor.quotes.get('entry');
    if (timeoutSec > 0 && entryQuote && !entryQuote.cancelling && !matched.gt(QUANTITY_EPSILON)
      && this.options.now() - entryQuote.quotedAt >= timeoutSec * 1000) {
      if (await this.cancelQuotes(actor)) {
        await this.pause(actor, 'Maker entry quote timed out; strategy paused (no market fallback)');
      }
      return;
    }
    const perOrder = new Decimal(actor.config.perOrderQuantity);
    const legs = legsOf(actor.config);
    const intents: Array<{ intent: QuoteIntent; quantity: Decimal; tier: number }> = [];
    const entryCapacity = this.remainingEntryCapacity(actor, exposure);
    // No new entry while a take-profit exit is being unwound: the latch retires only once both legs
    // are flat, so re-entering here would reopen the position the exit is closing.
    if (entryCapacity.gt(QUANTITY_EPSILON) && !actor.makerExitArmed) {
      // B2 gate on the maker path too: a MAKER_TAKER auto strategy must not rest an entry quote at
      // or beyond the stop-loss line, or it would open a position that stops out immediately.
      const liveSpread = this.entrySpreadBps(actor.config)?.spread;
      const gateOk = !(actor.kind === 'auto' && actor.config.stopLossBps !== undefined
        && liveSpread !== undefined && this.adverseBreached(actor.config, liveSpread));
      // Ladder cap: stop resting entry quotes once the next tier's level reaches the stop line.
      // Complementary to `gateOk` and never deadlocks against it — the exit intent below is pushed
      // independently, and once a position is open the armed stop routes `evaluate()` away from here
      // entirely (§8.5.5).
      const nextTier = this.nextLadderTier(actor, exposure);
      const tierOk = !actor.config.addOnStepBps || !actor.config.stopLossBps
        || this.absThreshold(actor.config, nextTier).lt(new Decimal(actor.config.stopLossBps));
      // Proximity band on the entry side only: rest an entry quote just once the market is within
      // `MAKER_ENTRY_PROXIMITY_BPS` of the tier's trigger level, instead of chasing a target price
      // that drifts with every tick while the market is still far away. Exit / take-profit quotes
      // below are untouched. Premium strategies are excluded on purpose: their entry condition is
      // `entryPremiumPct`, not a spread level in bps, so this band has no reading for them. Without
      // a live spread the gate abstains entirely (no park, no resume) — the quote could not be
      // priced from a stale book anyway, and parking would flood the log on a data outage.
      const distance = gateOk && tierOk && liveSpread !== undefined
        && actor.config.entryBps !== undefined && actor.kind !== 'premium'
        ? this.entryDistanceBps(actor.config, liveSpread, nextTier) : null;
      const withinProximity = distance === null || liveSpread === undefined
        || this.applyMakerEntryProximity(actor, liveSpread, distance, nextTier);
      if (gateOk && tierOk && withinProximity) {
        const entryQuantity = this.carryAdjustedMakerQuantity(actor, exposure, Decimal.min(perOrder, entryCapacity));
        if (entryQuantity.gt(QUANTITY_EPSILON)) {
          // Same `maxPosition` ceiling as the taker path: a resting entry quote is exposure too, so
          // it is judged before it is placed rather than after it fills.
          const capRejection = this.positionCapRejection(actor, exposure, entryQuantity);
          if (capRejection !== null) this.reportPositionCapBlocked(actor, capRejection);
          else {
            actor.positionCapBlocked = false;
            intents.push({ intent: 'entry', quantity: entryQuantity, tier: nextTier });
          }
        }
      }
    }
    if (actor.kind === 'auto' && actor.config.takeProfitBps) {
      if (exposure.left.abs().lte(QUANTITY_EPSILON) && exposure.right.abs().lte(QUANTITY_EPSILON)) {
        // Fully flat (exit complete, or the venue closed the position elsewhere): retire the latch
        // so a fresh entry cycle may begin. Mirrors the two-leg flat test in `checkCompletion`.
        if (actor.makerExitArmed) await this.retireMakerExit(actor);
      } else {
        // Price trigger: arm the exit latch when the live exit spread reaches the take-profit level.
        // A missing book can never *arm* the latch — but it must never *disarm* it, nor go quiet,
        // either. Once armed, a null `exitSpread` only suppresses new arming: the maker exit quote
        // stays resting, the hedge leg keeps unwinding, and the time fallback still runs. Silencing
        // those on a data outage would strand an imbalanced pair exactly when the fallback matters.
        const exitSpread = this.exitSpreadBps(actor.config);
        if (exitSpread !== null
          && exitSpread.lte(new Decimal(actor.config.takeProfitBps))
          && matched.gt(QUANTITY_EPSILON)) {
          actor.makerExitArmed = true;
          if (actor.makerExitStartedAt === null) actor.makerExitStartedAt = this.options.now();
        }
        if (actor.makerExitArmed) {
          // Time fallback is gated on the clock alone — never on the live spread.
          this.maybeLogMakerExitFallback(actor);
          // Keep unwinding the hedge leg even with no exit spread. `evaluate` already ran
          // `reconcileExposure` → `ensureHedged` → `ensureMakerExitFlat` this tick; this call keeps
          // the guarantee local to the latch and is idempotent within a tick (the TTL/terminal
          // guards collapse it to a no-op), and it skips itself cleanly when the hedge leg's own book
          // is missing. It is a reduce-only limit, never a market order, and never cancels the maker
          // exit quote.
          await this.ensureMakerExitFlat(actor, exposure);
          // Size the exit from the maker leg's own remaining position, never the matched quantity:
          // after a partial hedge the two differ, and the maker exit only ever reduces the maker leg.
          const makerLeg = (actor.config.makerLeg ?? 'left') === 'left' ? legs.left : legs.right;
          const makerRemaining = makerLeg.leg === 'left' ? exposure.left.abs() : exposure.right.abs();
          // The venue-truth clamp keeps a drifted ledger from resubmitting an exit the venue already
          // rejected for exceeding the position; a zero clamp drops the intent and the cleanup loop
          // below withdraws any resting exit quote.
          const exitQuantity = this.exitQuantityFor(actor, makerLeg.symbol, Decimal.min(perOrder, makerRemaining));
          if (exitQuantity.gt(QUANTITY_EPSILON)) {
            intents.push({ intent: 'exit', quantity: exitQuantity, tier: 0 });
          }
        }
      }
    }
    for (const [intent] of [...actor.quotes]) {
      if (!intents.some((candidate) => candidate.intent === intent)) {
        const quote = actor.quotes.get(intent);
        if (quote && !quote.cancelling) {
          quote.cancelling = true;
          try { await this.runtime.cancelOrder(quote.orderId); actor.quotes.delete(intent); }
          catch { quote.cancelling = false; }
        }
      }
    }
    for (const candidate of intents) {
      await this.maintainQuote(actor, candidate.intent, candidate.quantity, candidate.tier);
    }
  }

  /**
   * Applies the maker entry proximity band to one evaluation and reports whether the entry quote
   * may be rested. The band is inclusive: a distance of exactly `MAKER_ENTRY_PROXIMITY_BPS` passes.
   *
   * Only the transitions of `makerEntryParked` are logged — one row when the spread leaves the band
   * and one when it comes back — so a strategy parked for hours does not write a strategy-log row
   * on every 500ms tick (a parked strategy is quiescent by definition, not an error).
   */
  private applyMakerEntryProximity(
    actor: StrategyActor,
    spread: Decimal,
    distance: Decimal,
    tier: number,
  ): boolean {
    // Operator-tunable band (funding-arbitration settings write it per strategy); the constant is
    // only the fallback for every strategy that never set the field.
    const bandBps = actor.config.makerEntryProximityBps ?? MAKER_ENTRY_PROXIMITY_BPS;
    if (distance.gt(bandBps)) {
      if (actor.makerEntryParked) return false;
      actor.makerEntryParked = true;
      const level = this.tierLevelBps(actor.config, tier);
      this.runtime.addStrategyLog(actor.id, 'info', 'Maker quoting parked',
        `Live spread ${spread.toFixed(2)} bps · ${distance.toFixed(2)} bps away from the ${level.toFixed(2)} bps entry trigger`,
        '—',
        `No entry quote is rested while the live spread is more than ${bandBps} bps from the trigger`);
      return false;
    }
    if (actor.makerEntryParked) {
      actor.makerEntryParked = false;
      const level = this.tierLevelBps(actor.config, tier);
      this.runtime.addStrategyLog(actor.id, 'info', 'Maker quoting resumed',
        `Live spread ${spread.toFixed(2)} bps · inside the ${bandBps} bps band around the ${level.toFixed(2)} bps entry trigger`,
        '—',
        `Entry quoting resumes now that the live spread is within ${bandBps} bps of the trigger`);
    }
    return true;
  }

  private async maintainQuote(actor: StrategyActor, intent: QuoteIntent, quantity: Decimal, tier = 0): Promise<void> {
    if (actor.status !== 'RUNNING') return;
    const desired = this.desiredMakerPrice(actor, intent, tier);
    if (!desired) return;
    const existing = actor.quotes.get(intent);
    const now = this.options.now();
    if (existing) {
      if (existing.cancelling) return;
      const tick = this.constraintsFor(desired.makerLeg.symbol).tickSize;
      const tolerance = tick ? new Decimal(tick) : existing.price.mul('0.0001');
      const drifted = desired.price.minus(existing.price).abs().gte(tolerance);
      if (!drifted || now - existing.quotedAt < this.options.requoteIntervalMs) return;
      existing.cancelling = true;
      try {
        await this.runtime.cancelOrder(existing.orderId);
        actor.quotes.delete(intent);
      } catch (error) {
        if (error instanceof TradingRuntimeError && error.code === 'order_not_cancellable') actor.quotes.delete(intent);
        else existing.cancelling = false;
        return;
      }
    }
    if (now - actor.lastQuoteAt < this.options.requoteIntervalMs / 2) return;
    const lot = this.constraintsFor(desired.makerLeg.symbol).lotSize;
    const roundedQuantity = roundToStep(quantity, lot, 'down');
    const sizeError = this.orderSizeError(desired.makerLeg.symbol, roundedQuantity, desired.price);
    if (sizeError) {
      await this.pause(actor, `Order-size compliance check failed: ${sizeError.label ?? sizeError.code}`);
      return;
    }
    actor.busy = true;
    try {
      const reduceOnly = intent === 'exit' || actor.config.reduceOnly;
      const order = await this.runtime.createOrder({
        symbol: desired.makerLeg.symbol, side: desired.makerLeg.side, type: 'LIMIT', timeInForce: 'POC',
        quantity: roundedQuantity.toString(), price: desired.price.toString(), reduceOnly,
      }, { strategyId: actor.id, strategyLeg: desired.makerLeg.leg });
      actor.quotes.set(intent, { orderId: order.id, price: desired.price, quantity: roundedQuantity, quotedAt: now, cancelling: false });
      actor.lastQuoteAt = now;
      actor.failureCount = 0;
      this.runtime.addStrategyLog(actor.id, 'info', intent === 'entry' ? 'Maker quote placed' : 'Maker exit quote placed',
        `Post-only at ${desired.price.toString()}`, `${roundedQuantity.toString()} ${actor.config.asset}`,
        `${desired.makerLeg.side} ${desired.makerLeg.symbol}`);
    } catch (error) {
      if (intent === 'exit' && isReduceOnlyQuantityRejection(error)) {
        // The venue holds less than the ledger: reconcile now and re-report at the venue's
        // real size instead of spending the five-strike budget on a state mismatch. A clamp that
        // reads zero withdraws the exit quote (the intent loop drops it on the next pass) rather
        // than counting a strike, exactly as a positive clamp re-quotes at the venue size.
        const outcome = await this.reconcileExitQuantity(actor, desired.makerLeg.symbol, desired.makerLeg.side, roundedQuantity);
        if (outcome !== 'ordinary') return;
      }
      actor.failureCount += 1;
      actor.cooldownUntil = this.options.now() + Math.min(60_000, 2_000 * 2 ** Math.min(4, actor.failureCount));
      this.runtime.addStrategyLog(actor.id, 'warning', 'Maker quote rejected', `Post-only at ${desired.price.toString()}`,
        roundedQuantity.toString(), error instanceof Error ? error.message.slice(0, 120) : 'submit error');
      if (actor.failureCount >= 5) {
        await this.pause(actor, 'Five consecutive maker quotes were rejected; check credentials, balances, and venue status');
      }
    } finally {
      actor.busy = false;
    }
  }

  /**
   * During the entry phase, repair the lagging leg to restore the configured hedge. Once a
   * premium take-profit order exists, the objective changes: reduce every remaining leg toward
   * zero instead of reopening a leg that already closed.
   */
  private async reconcileExposure(actor: StrategyActor, exposure: { left: Decimal; right: Decimal; rightShares: Decimal }): Promise<void> {
    if (actor.kind === 'premium' && this.premiumExitStarted(actor)) {
      await this.ensurePremiumFlat(actor, exposure);
      return;
    }
    await this.ensureHedged(actor, exposure);
  }

  /** Maximum hedge-leg quantity represented by one entry clip, used when only that leg remains. */
  private premiumRightClipLimit(actor: StrategyActor): Decimal {
    const fallback = new Decimal(actor.config.perOrderQuantity).div(adrRatioOf(actor.config));
    return this.strategyLedger(actor.id).rows
      .filter((row) => row.leg === 'right' && row.reduce_only === 0)
      .reduce((largest, row) => Decimal.max(largest, new Decimal(row.quantity)), fallback);
  }

  /**
   * Finish a latched premium exit one configured clip at a time. Quantities come from actual
   * executed exposure, including partial clips and one-leg failures, and every order is
   * reduce-only. A follow-up must never collapse the entire residual position into one order.
   */
  private async ensurePremiumFlat(
    actor: StrategyActor,
    exposure: { left: Decimal; right: Decimal; rightShares: Decimal },
  ): Promise<void> {
    if (actor.busy || (actor.status !== 'RUNNING' && !actor.suspended) || this.options.now() < actor.cooldownUntil) return;
    const quoteOrderIds = new Set([...actor.quotes.values()].map((quote) => quote.orderId));
    if (this.openStrategyOrders(actor.id, quoteOrderIds).length > 0) return;
    const legs = legsOf(actor.config);
    const perOrder = new Decimal(actor.config.perOrderQuantity);
    const leftRemaining = exposure.left.abs();
    const rightRemaining = exposure.rightShares.abs();
    const leftQuantity = roundToStep(
      Decimal.min(leftRemaining, perOrder),
      this.constraintsFor(legs.left.symbol).lotSize,
      'down',
    );
    // When both legs remain, preserve their actual residual proportion. If only the hedge leg
    // survived a failed exit, fall back to the largest requested hedge quantity of one entry clip.
    const rightRaw = leftRemaining.gt(QUANTITY_EPSILON) && leftQuantity.gt(QUANTITY_EPSILON)
      ? Decimal.min(rightRemaining, rightRemaining.mul(leftQuantity).div(leftRemaining))
      : Decimal.min(rightRemaining, this.premiumRightClipLimit(actor));
    const rightQuantity = roundToStep(rightRaw, this.constraintsFor(legs.right.symbol).lotSize, 'down');
    const candidates = [
      ...(leftQuantity.gt(QUANTITY_EPSILON) ? [{
        leg: legs.left,
        side: exposure.left.gt(0) ? 'SELL' as const : 'BUY' as const,
        quantity: leftQuantity,
      }] : []),
      ...(rightQuantity.gt(QUANTITY_EPSILON) ? [{
        leg: legs.right,
        side: exposure.rightShares.gt(0) ? 'SELL' as const : 'BUY' as const,
        quantity: rightQuantity,
      }] : []),
    ];
    if (candidates.length === 0) {
      actor.repairAttempts = 0;
      return;
    }
    const now = this.options.now();
    if (now - actor.lastRepairAt < this.options.repairCooldownMs) return;
    if (actor.repairAttempts >= 3) {
      await this.pause(actor, `Unable to close residual premium exposure after 3 attempts; manual review required`);
      return;
    }
    const clip = `exit-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    actor.busy = true;
    actor.lastRepairAt = now;
    actor.repairAttempts += 1;
    try {
      this.runtime.addStrategyLog(actor.id, 'info', 'Closing remaining exposure', 'Take profit already triggered',
        candidates.map(({ leg, quantity }) => `${quantity.toString()} ${leg.symbol}`).join(' · '),
        'Submitting reduce-only market orders');
      const submissions = await Promise.allSettled(candidates.map(({ leg, side, quantity }) => (
        this.runtime.createOrder({
          symbol: leg.symbol,
          side,
          type: 'MARKET',
          timeInForce: 'IOC',
          quantity: quantity.toString(),
          reduceOnly: true,
        }, { strategyId: actor.id, strategyLeg: leg.leg, strategyClip: clip, riskReducing: true })
      )));
      const accepted = submissions.filter((entry): entry is PromiseFulfilledResult<ExecutionOrder> => entry.status === 'fulfilled');
      const rejected = submissions.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
      if (rejected.length > 0) {
        const gateErrors = rejected.map((entry) => entry.reason).filter((reason): reason is GateApiError => reason instanceof GateApiError);
        const rateLimitWait = gateErrors
          .filter((error) => error.statusCode === 429)
          .reduce((longest, error) => Math.max(longest, error.retryAfterMs ?? 30_000), 0);
        actor.cooldownUntil = this.options.now() + Math.max(
          rateLimitWait,
          Math.min(60_000, 2_000 * 2 ** Math.min(4, actor.repairAttempts)),
        );
        this.runtime.addStrategyLog(actor.id, 'warning', 'Residual close submission failed', 'Take profit already triggered',
          candidates.map(({ quantity }) => quantity.toString()).join(' / '),
          rejected.map((entry) => entry.reason instanceof Error ? entry.reason.message.slice(0, 120) : 'submit error').join(' · '));
      }
      const settled = await Promise.all(accepted.map((entry) => (
        this.runtime.awaitTerminalOrder(entry.value.id, this.options.orderTimeoutMs)
      )));
      if (rejected.length === 0 && settled.length === candidates.length
        && settled.every((order) => order.state === 'FILLED')) {
        // Successful clips are normal progress, not failed repair attempts. Resetting here lets
        // positions larger than three clips unwind fully while still bounding genuine retries.
        actor.repairAttempts = 0;
      }
      for (const order of settled) {
        this.runtime.addStrategyLog(actor.id, order.state === 'FILLED' ? 'info' : 'warning', 'Residual close settled',
          'Take profit already triggered', `${order.executedQuantity}/${order.quantity}`,
          `${order.side} ${order.symbol} · ${order.state}`);
      }
    } finally {
      actor.busy = false;
    }
    const refreshed = this.legExposures(actor.id, actor.config);
    if (refreshed.left.abs().lte(QUANTITY_EPSILON) && refreshed.rightShares.abs().lte(QUANTITY_EPSILON)) {
      actor.repairAttempts = 0;
    }
    this.persist(actor, refreshed);
  }

  /**
   * Keep the two legs hedged. Executable differences are repaired immediately; maker-taker dust
   * below venue constraints is carried into the next clip until the configured target is full,
   * when the excess leg is reduced without increasing the strategy's completed hedge.
   */
  private terminalPaddingQuantity(
    symbol: string,
    paddingSide: 'BUY' | 'SELL',
    trimSide: 'BUY' | 'SELL',
    residual: Decimal,
  ): Decimal | null {
    const constraints = this.constraintsFor(symbol);
    if (!constraints.minNotional || !constraints.lotSize || !constraints.minSize) return null;
    const minimumNotional = new Decimal(constraints.minNotional);
    const paddingPrice = this.executablePrice(symbol, paddingSide);
    const trimPrice = this.executablePrice(symbol, trimSide);
    if (!minimumNotional.gt(0) || !paddingPrice || !trimPrice) return null;
    const bufferedNotional = minimumNotional.mul(MIN_NOTIONAL_REPAIR_BUFFER);
    const minimumSize = new Decimal(constraints.minSize);
    const paddingForOpen = bufferedNotional.div(paddingPrice);
    const paddingForTrim = Decimal.max(ZERO, bufferedNotional.div(trimPrice).minus(residual));
    const padding = roundToStep(
      Decimal.max(minimumSize, paddingForOpen, paddingForTrim),
      constraints.lotSize,
      'up',
    );
    const trimQuantity = padding.plus(residual);
    if (this.marketOrderSizeError(symbol, paddingSide, padding)
      || this.marketOrderSizeError(symbol, trimSide, trimQuantity)) return null;
    return padding;
  }

  private async executeTerminalTopUpAndTrim(
    actor: StrategyActor,
    repairLeg: LegDefinition,
    trimSide: 'BUY' | 'SELL',
    residual: Decimal,
    clip: string,
  ): Promise<boolean> {
    const paddingSide = oppositeSide(trimSide);
    const paddingQuantity = this.terminalPaddingQuantity(
      repairLeg.symbol,
      paddingSide,
      trimSide,
      residual,
    );
    if (!paddingQuantity) {
      this.runtime.addStrategyLog(actor.id, 'warning', 'Residual top-up unavailable',
        `Terminal residual ${residual.toString()} ${actor.config.asset}`, residual.toString(),
        'Fresh prices or complete min-notional constraints unavailable');
      return false;
    }

    this.runtime.addStrategyLog(actor.id, 'info', 'Padding terminal residual',
      `Target filled; residual ${residual.toString()} ${actor.config.asset}`,
      `${paddingQuantity.toString()} ${actor.config.asset}`,
      `${paddingSide} ${repairLeg.symbol} market · 10% min-notional buffer`);
    const paddingOrder = await this.runtime.createOrder({
      symbol: repairLeg.symbol,
      side: paddingSide,
      type: 'MARKET',
      timeInForce: 'IOC',
      quantity: paddingQuantity.toString(),
      reduceOnly: false,
    }, { strategyId: actor.id, strategyLeg: repairLeg.leg, strategyClip: clip });
    const settledPadding = await this.runtime.awaitTerminalOrder(paddingOrder.id, this.options.orderTimeoutMs);
    const padded = new Decimal(settledPadding.executedQuantity || '0');
    this.runtime.addStrategyLog(actor.id, padded.gt(QUANTITY_EPSILON) ? 'info' : 'warning', 'Residual padding settled',
      `Terminal residual ${residual.toString()}`, `${settledPadding.executedQuantity}/${settledPadding.quantity}`,
      `${settledPadding.state} · ${failureSummary(settledPadding.failureReason) ?? `avg ${settledPadding.executedAveragePrice ?? '—'}`}`);
    if (!padded.gt(QUANTITY_EPSILON)) return false;

    const constraints = this.constraintsFor(repairLeg.symbol);
    const exactTrim = padded.plus(residual);
    const trimQuantity = roundToStep(exactTrim, constraints.lotSize, 'down');
    if (!trimQuantity.eq(exactTrim)) {
      this.runtime.addStrategyLog(actor.id, 'warning', 'Residual trim deferred',
        `Terminal residual ${residual.toString()}`, trimQuantity.toString(),
        `Exact trim ${exactTrim.toString()} is not aligned to ${constraints.lotSize ?? 'unknown'} lot size`);
      return false;
    }
    const trimError = this.marketOrderSizeError(repairLeg.symbol, trimSide, trimQuantity);
    if (trimError) {
      this.runtime.addStrategyLog(actor.id, 'warning', 'Residual trim deferred',
        `Terminal residual ${residual.toString()}`, trimQuantity.toString(), trimError.label ?? trimError.code);
      return false;
    }

    this.runtime.addStrategyLog(actor.id, 'info', 'Trimming padded residual',
      `Padding ${padded.toString()} + residual ${residual.toString()}`,
      `${trimQuantity.toString()} ${actor.config.asset}`,
      `${trimSide} ${repairLeg.symbol} market · reduce-only exact trim`);
    const trimOrder = await this.runtime.createOrder({
      symbol: repairLeg.symbol,
      side: trimSide,
      type: 'MARKET',
      timeInForce: 'IOC',
      quantity: trimQuantity.toString(),
      reduceOnly: true,
    }, { strategyId: actor.id, strategyLeg: repairLeg.leg, strategyClip: clip, riskReducing: true });
    const settledTrim = await this.runtime.awaitTerminalOrder(trimOrder.id, this.options.orderTimeoutMs);
    const complete = settledTrim.state === 'FILLED'
      && new Decimal(settledTrim.executedQuantity || '0').gte(trimQuantity.minus(QUANTITY_EPSILON));
    this.runtime.addStrategyLog(actor.id, complete ? 'info' : 'warning', 'Padded residual trim settled',
      `Terminal residual ${residual.toString()}`, `${settledTrim.executedQuantity}/${settledTrim.quantity}`,
      `${settledTrim.state} · ${failureSummary(settledTrim.failureReason) ?? `avg ${settledTrim.executedAveragePrice ?? '—'}`}`);
    return complete;
  }

  /**
   * Write the one-shot `Maker exit fallback` row once a latched maker exit has overrun its budget.
   * A single row per latch: the slippage widening it announces is sticky until the latch retires,
   * so restating it on every 500ms tick would only bury the signal it exists to raise.
   */
  private maybeLogMakerExitFallback(actor: StrategyActor): void {
    if (!actor.makerExitArmed || actor.makerExitFallbackLogged || actor.makerExitStartedAt === null) return;
    if (this.options.now() - actor.makerExitStartedAt < MAKER_EXIT_FALLBACK_MS) return;
    actor.makerExitFallbackLogged = true;
    this.runtime.addStrategyLog(actor.id, 'warning', 'Maker exit fallback',
      `Maker exit has not completed within ${Math.round(MAKER_EXIT_FALLBACK_MS / 1_000)} s`,
      `0 ${actor.config.asset} closed`,
      `Widening the hedge-leg exit slippage cap to ${MAKER_EXIT_HEDGE_FALLBACK_SLIPPAGE_BPS} bps`);
  }

  /** Cancel the tracked hedge-leg exit limit (if any), forget it, and best-effort drop it remotely. */
  private async cancelMakerExitHedge(actor: StrategyActor): Promise<void> {
    const hedge = actor.makerExitHedge;
    actor.makerExitHedge = null;
    if (!hedge) return;
    try { await this.runtime.cancelOrder(hedge.orderId); }
    catch { /* Already terminal or gone: nothing left to cancel. */ }
  }

  /**
   * Retire the maker-exit latch once both legs are flat: clear the bookkeeping and drop any hedge
   * order still resting, so the strategy is free to enter again.
   */
  private async retireMakerExit(actor: StrategyActor): Promise<void> {
    await this.cancelMakerExitHedge(actor);
    actor.makerExitArmed = false;
    actor.makerExitStartedAt = null;
    actor.makerExitFallbackLogged = false;
    actor.makerExitHedgeRequotes = 0;
    // A retired latch starts a fresh entry cycle: the hedge strike budget and its backoff gate
    // must not carry over into it.
    actor.makerExitHedgeFailures = 0;
    actor.makerExitHedgeRetryAt = 0;
  }

  /**
   * Unwind the hedge leg toward the maker leg's remaining exposure during a latched maker exit.
   *
   * The generic "top up the lagging leg" repair would reopen the leg the exit already reduced and
   * pin the pair back to its full size (the livelock this path exists to break), so while the exit
   * latch is set that repair is bypassed entirely (see {@link ensureHedged}). Only the hedge leg is
   * trimmed, and only by a **reduce-only limit** resting within a bounded slippage of the mid — a
   * market order is never used. A single hedge order is allowed at a time: it is left to fill for
   * {@link MAKER_EXIT_HEDGE_TTL_MS}, then cancelled and re-priced at the new mid.
   */
  private async ensureMakerExitFlat(
    actor: StrategyActor,
    exposure: { left: Decimal; right: Decimal },
  ): Promise<void> {
    const legs = legsOf(actor.config);
    const makerLegKey = actor.config.makerLeg ?? 'left';
    const makerLeg = makerLegKey === 'left' ? legs.left : legs.right;
    const hedgeLeg = makerLegKey === 'left' ? legs.right : legs.left;
    const makerQuantity = makerLeg.leg === 'left' ? exposure.left.abs() : exposure.right.abs();
    const hedgeQuantity = hedgeLeg.leg === 'left' ? exposure.left.abs() : exposure.right.abs();
    // Signed hedge exposure, for direction only. `hedgeQuantity` above is absolute and exists to
    // *size* the unwind (`target`), so it can never express which way the position must be closed:
    // reaching the submission below already implies `hedgeQuantity > 0`, which made the old
    // `hedgeQuantity.gt(0) ? 'SELL' : 'BUY'` a constant SELL and left the BUY branch unreachable.
    // A short hedge leg (negative signed exposure) is closed with a BUY.
    const signedHedge = hedgeLeg.leg === 'left' ? exposure.left : exposure.right;
    const target = hedgeQuantity.minus(makerQuantity);
    const now = this.options.now();
    // Backoff gate FIRST, before any venue interaction: a persistently rejected hedge submit must
    // neither re-storm the exchange nor cancel the still-resting hedge order while waiting. Both
    // same-tick callers (the `reconcileExposure` path and the armed quote branch) share this one
    // timestamp — they read the same injected clock, so whichever runs second inside one
    // evaluation is always a no-op, which is what caps the storm at one submit per tick.
    if (now < actor.makerExitHedgeRetryAt) return;
    // Settle the resting hedge order's state first: a terminal one frees the single-order slot; a
    // still-open one older than its TTL is cancelled so it can be re-priced below.
    const existing = actor.makerExitHedge;
    if (existing) {
      const order = this.runtime.getOrder(existing.orderId);
      if (isTerminalOrderState(order.state)) {
        actor.makerExitHedge = null;
      } else if (now - existing.placedAt < MAKER_EXIT_HEDGE_TTL_MS) {
        return;
      } else {
        try { await this.runtime.cancelOrder(existing.orderId); }
        catch { /* Already terminal or gone. */ }
        actor.makerExitHedge = null;
        actor.makerExitHedgeRequotes += 1;
      }
    }
    if (target.lte(QUANTITY_EPSILON)) return;
    if (actor.busy || (actor.status !== 'RUNNING' && !actor.suspended) || now < actor.cooldownUntil) return;
    const market = this.freshMarket(hedgeLeg.symbol);
    if (!market) return;
    const mid = new Decimal(market.bidPrice).plus(market.askPrice).div(2);
    if (!mid.gt(0)) return;
    // A starved exit concedes more of the mid to get filled, but never without a hard cap.
    const widened = actor.makerExitStartedAt !== null
      && now - actor.makerExitStartedAt >= MAKER_EXIT_FALLBACK_MS;
    const slippage = new Decimal(widened
      ? MAKER_EXIT_HEDGE_FALLBACK_SLIPPAGE_BPS
      : MAKER_EXIT_HEDGE_SLIPPAGE_BPS);
    // Long hedge ⇒ SELL to reduce; short hedge ⇒ BUY to close. Zero is unreachable here:
    // `target > 0` (checked above) means `|hedge| > |maker| >= 0`, hence a non-zero signed value.
    const side: 'BUY' | 'SELL' = signedHedge.gt(0) ? 'SELL' : 'BUY';
    const rawPrice = side === 'SELL'
      ? mid.mul(ONE.minus(slippage.div(BPS)))
      : mid.mul(ONE.plus(slippage.div(BPS)));
    const constraints = this.constraintsFor(hedgeLeg.symbol);
    const price = roundToStep(rawPrice, constraints.tickSize, side === 'SELL' ? 'down' : 'up');
    const quantity = roundToStep(target, constraints.lotSize, 'down');
    if (!price.gt(0) || !quantity.gt(QUANTITY_EPSILON)) return;
    actor.busy = true;
    try {
      const clip = `exit-hedge-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const order = await this.runtime.createOrder({
        symbol: hedgeLeg.symbol, side, type: 'LIMIT', timeInForce: 'GTC',
        quantity: quantity.toString(), price: price.toString(), reduceOnly: true,
      }, { strategyId: actor.id, strategyLeg: hedgeLeg.leg, strategyClip: clip, riskReducing: true });
      actor.makerExitHedge = { orderId: order.id, price, placedAt: now, leg: hedgeLeg.leg, quantity };
      // A real submission clears the hedge's own strike budget, so a later failure streak counts
      // from scratch instead of inheriting the previous rung.
      actor.makerExitHedgeFailures = 0;
    } catch (error) {
      // The hedge carries its own strike budget and backoff instead of borrowing the generic
      // `failureCount`/`cooldownUntil`: those are read by the entry and two-leg insufficient-margin
      // paths, and before this guard the hedge path returned without ever touching them — so a
      // persistently rejected hedge retried twice per tick, forever, with no strike budget.
      // Mirrors `executeTakerClip`: a 429's `retryAfterMs` wins, otherwise exponential from 2 s
      // capped at 60 s. The backoff gate above is what thins the failure log to at most one row
      // per cooldown window — no extra dedup machinery.
      actor.makerExitHedgeFailures += 1;
      const rateLimitWait = error instanceof GateApiError && error.statusCode === 429
        ? error.retryAfterMs ?? 30_000
        : 0;
      actor.makerExitHedgeRetryAt = this.options.now() + Math.max(
        rateLimitWait,
        Math.min(60_000, 2_000 * 2 ** Math.min(4, actor.makerExitHedgeFailures)),
      );
      this.runtime.addStrategyLog(actor.id, 'warning', 'Leg submission failed',
        `Maker exit hedge for ${target.toString()} ${actor.config.asset}`, quantity.toString(),
        error instanceof Error ? error.message.slice(0, 120) : 'submit error');
      if (actor.makerExitHedgeFailures >= 5) {
        await this.pause(actor, 'Maker exit hedge order was rejected 5 consecutive times; the position cannot unwind automatically — review the hedge leg manually');
      }
    } finally {
      actor.busy = false;
    }
  }

  private async ensureHedged(actor: StrategyActor, exposure: { left: Decimal; right: Decimal }): Promise<void> {
    if (actor.busy || (actor.status !== 'RUNNING' && !actor.suspended)) return;
    // A latched maker exit must NEVER fall through to the generic "top up the lagging leg" repair:
    // that repair reopens the very leg the exit reduced and pins the pair back to its full size —
    // exactly the livelock this path breaks. While armed, only the hedge leg may be trimmed (never
    // grown), and only by {@link ensureMakerExitFlat}.
    if (actor.makerExitArmed && actor.kind === 'auto' && actor.config.takeProfitBps
      && actor.config.executionMethod === 'MAKER_TAKER') {
      await this.ensureMakerExitFlat(actor, exposure);
      return;
    }
    // One repair target per pass: for equal-notional the oldest broken clip (each clip has its
    // own intended ratio), otherwise the global fixed-ratio imbalance. `k` is always the
    // right-shares-per-ADR-unit conversion used to size a right-leg repair order.
    const target = (() => {
      if (this.equalNotional(actor.config)) {
        const shortfalls = this.clipShortfalls(actor.id, actor.config);
        if (shortfalls.length === 0) return null;
        return { ...shortfalls[0], residual: shortfalls.reduce((sum, item) => sum.plus(item.delta.abs()), ZERO) };
      }
      const imbalance = exposure.left.plus(exposure.right);
      if (imbalance.abs().lte(QUANTITY_EPSILON)) return null;
      const lagging: 'left' | 'right' = exposure.left.abs().lt(exposure.right.abs()) ? 'left' : 'right';
      const laggingExposure = lagging === 'left' ? exposure.left : exposure.right;
      const otherExposure = lagging === 'left' ? exposure.right : exposure.left;
      return { clip: null, k: ONE.div(adrRatioOf(actor.config)), lagging, delta: otherExposure.neg().minus(laggingExposure), residual: imbalance.abs() };
    })();
    if (!target) {
      actor.repairAttempts = 0;
      return;
    }
    const quoteOrderIds = new Set([...actor.quotes.values()].map((quote) => quote.orderId));
    if (this.openStrategyOrders(actor.id, quoteOrderIds).length > 0) return;
    const now = this.options.now();
    if (now - actor.lastRepairAt < this.options.repairCooldownMs) return;
    if (actor.repairAttempts >= 3) {
      await this.pause(actor, `Unable to hedge residual exposure of ${target.residual.toString()} ${actor.config.asset} after 3 attempts; manual review required`);
      return;
    }
    const legs = legsOf(actor.config);
    const completedTarget = actor.kind === 'position' && this.matchedQuantity(exposure)
      .gte(this.strategyTarget(actor.config).minus(QUANTITY_EPSILON));
    if (completedTarget && actor.quotes.size > 0) return;
    let trimExcess = completedTarget;
    let repairLeg = trimExcess
      ? (target.lagging === 'left' ? legs.right : legs.left)
      : (target.lagging === 'left' ? legs.left : legs.right);
    let side: 'BUY' | 'SELL' = trimExcess
      ? (repairLeg.leg === 'left'
          ? (exposure.left.gt(0) ? 'SELL' : 'BUY')
          : (exposure.right.gt(0) ? 'SELL' : 'BUY'))
      : (target.delta.gt(0) ? 'BUY' : 'SELL');
    let lot = this.constraintsFor(repairLeg.symbol).lotSize;
    const venueDeltaFor = (leg: LegDefinition): Decimal => leg.leg === 'right'
      ? target.delta.abs().mul(target.k)
      : target.delta.abs();
    let desiredQuantity = roundToStep(venueDeltaFor(repairLeg), lot, 'down');
    let sizeError = desiredQuantity.gt(QUANTITY_EPSILON)
      ? this.marketOrderSizeError(repairLeg.symbol, side, desiredQuantity)
      : new StrategyEngineError('strategy_order_below_minimum_size', 400, repairLeg.symbol);

    // Before the target is full, do not manufacture extra volume for dust. A maker-taker strategy
    // carries this residual into its next quote; that next normal fill makes the opposite hedge
    // executable (for example 0.97 after a prior 0.03 overfill in a 1.00-HYPE clip).
    if (sizeError && !completedTarget && actor.kind === 'position'
      && actor.config.executionMethod === 'MAKER_TAKER') return;

    // Non-maker strategies cannot carry dust through a resting quote. Preserve the old safe
    // fallback for them: trim the excess leg directly when that exact quantity is executable.
    if (sizeError && !completedTarget) {
      if (actor.quotes.size > 0) return;
      repairLeg = target.lagging === 'left' ? legs.right : legs.left;
      side = repairLeg.leg === 'left'
        ? (exposure.left.gt(0) ? 'SELL' : 'BUY')
        : (exposure.right.gt(0) ? 'SELL' : 'BUY');
      lot = this.constraintsFor(repairLeg.symbol).lotSize;
      desiredQuantity = roundToStep(venueDeltaFor(repairLeg), lot, 'down');
      sizeError = desiredQuantity.gt(QUANTITY_EPSILON)
        ? this.marketOrderSizeError(repairLeg.symbol, side, desiredQuantity)
        : new StrategyEngineError('strategy_order_below_minimum_size', 400, repairLeg.symbol);
      if (sizeError) return;
      trimExcess = true;
    }
    if (completedTarget && sizeError?.code === 'strategy_order_below_minimum_notional'
      && actor.config.reduceOnly) {
      await this.pause(actor, 'Terminal residual is below minimum notional and cannot be padded in reduce-only mode');
      return;
    }
    const topUpRequired = completedTarget
      && sizeError?.code === 'strategy_order_below_minimum_notional';
    if (sizeError && !topUpRequired) return;
    const previous = this.latestLegOrderStatement.get(
      actor.id,
      repairLeg.leg,
      repairLeg.symbol,
      side,
    ) as { state: string; quantity: string; executed_quantity: string; failure_reason: string | null } | undefined;
    // Gate's account router explicitly recommends a smaller order for this terminal rejection.
    // Halve only after that exact zero-fill failure; a successful smaller clip becomes the latest
    // order, so the remaining residual continues normally instead of shrinking forever.
    const splitQuantity = previous?.state === 'FAIL'
      && new Decimal(previous.executed_quantity || '0').isZero()
      && isRouterCapacityFailure(previous.failure_reason)
      ? roundToStep(new Decimal(previous.quantity).div(2), lot, 'down')
      : null;
    const quantity = splitQuantity?.gt(QUANTITY_EPSILON) && splitQuantity.lt(desiredQuantity)
      ? splitQuantity
      : desiredQuantity;
    if (!quantity.gt(QUANTITY_EPSILON)) return;
    actor.busy = true;
    actor.lastRepairAt = now;
    actor.repairAttempts += 1;
    try {
      if (topUpRequired) {
        const dustClip = `dust-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        if (await this.executeTerminalTopUpAndTrim(actor, repairLeg, side, desiredQuantity, dustClip)) {
          actor.repairAttempts = 0;
        }
      } else {
        this.runtime.addStrategyLog(actor.id, 'info', trimExcess ? 'Trimming residual imbalance' : 'Hedging filled quantity',
          `Residual ${target.residual.toString()} ${actor.config.asset}`,
          quantity.toString(), `${side} ${repairLeg.symbol} market${trimExcess ? ' · reduce-only excess trim' : ''}`
          + (quantity.lt(desiredQuantity) ? ` · split after router rejected ${previous?.quantity}` : ''));
        const order = await this.runtime.createOrder({ symbol: repairLeg.symbol, side, type: 'MARKET', timeInForce: 'IOC',
          quantity: quantity.toString(), reduceOnly: trimExcess || actor.config.reduceOnly },
        { strategyId: actor.id, strategyLeg: repairLeg.leg, riskReducing: true,
          ...(target.clip ? { strategyClip: target.clip } : {}) });
        const settled = await this.runtime.awaitTerminalOrder(order.id, this.options.orderTimeoutMs);
        if (settled.state === 'FILLED') actor.repairAttempts = 0;
        const failure = failureSummary(settled.failureReason);
        this.runtime.addStrategyLog(actor.id, settled.state === 'FILLED' ? 'info' : 'warning',
          trimExcess ? 'Residual trim settled' : 'Hedge order settled',
          `Residual ${target.residual.toString()}`, `${settled.executedQuantity}/${settled.quantity}`,
          `${settled.state} · ${failure ?? `avg ${settled.executedAveragePrice ?? '—'}`}`);
      }
    } catch (error) {
      this.runtime.addStrategyLog(actor.id, 'warning', 'Hedge order failed', `Residual ${target.residual.toString()}`,
        quantity.toString(), error instanceof Error ? error.message.slice(0, 120) : 'submit error');
    } finally {
      actor.busy = false;
    }
    const refreshed = this.legExposures(actor.id, actor.config);
    if (this.hedgeImbalance(actor.id, actor.config, refreshed).lte(QUANTITY_EPSILON)) actor.repairAttempts = 0;
    this.persist(actor, refreshed);
  }
}
