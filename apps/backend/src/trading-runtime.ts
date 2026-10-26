import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { LiveBalance, PortfolioFill, PortfolioFuturesPosition, StrategyPnl, UnresolvedOrder } from '@gate-crossex/shared-types';
import { DEFAULT_CREDENTIAL_PROFILE, type CredentialVault } from './credential-vault.js';
import {
  CrossExOrderRequestSchema,
  GateApiError,
  type GateCrossExAccount,
  type GateCrossExPosition,
  type GateCrossExRiskLimit,
  type GateSpotAccount,
  type PortfolioOperationsCrossExGateway,
  type ReadOnlyCrossExGateway,
  type TradingCrossExGateway,
} from './crossex-client.js';
import type { PrivateCrossExEvent } from './private-stream.js';
import { readInstrumentCatalog } from './repositories.js';
import { computeStrategyPnl, type StrategyFillInput } from './strategy-pnl.js';
import type { TradingSession } from './trading-session.js';
import { STRATEGY_LOG_CATEGORY_FETCH_EVENTS, type StrategyLogCategory } from '@gate-crossex/shared-types';

/** A persisted execution-log row in its API shape (database column names mapped to wire names). */
interface StrategyLogRow {
  id: string;
  level: string;
  event: string;
  condition: string;
  quantity: string;
  result: string;
  createdAt: string;
}

/** One keyset page of strategy logs plus the cursor needed to continue into older rows. */
export interface StrategyLogPage {
  logs: StrategyLogRow[];
  hasMore: boolean;
  nextCursor: { createdAt: string; id: string } | null;
  /** Rows stored for this category (an upper bound: the fetch set is a grouping superset). */
  categoryTotal: number;
}

const decimalText = z.string().regex(/^\d+(?:\.\d+)?$/).refine((value) => new Decimal(value).gt(0));
/** Premium levels may be negative (an ADR trading at a discount), so sign is allowed. */
const signedDecimalText = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const venue = z.enum(['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT', 'LIGHTER']);

const FUTURE_SYMBOL_PATTERN = /^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/;
/** Spot exposure across the connected venues; the live-instrument order guard narrows at runtime. */
const SPOT_SYMBOL_PATTERN = /^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_SPOT_[A-Z0-9]+_(USDT|USDC)$/;
/** Prefix test used wherever only the business line matters (quote sizing, leverage tiers). */
const isSpotSymbol = (symbol: string): boolean => /^[A-Z0-9]+_SPOT_/.test(symbol);
const strategyLegSymbol = z.string().regex(
  /^(?:(?:GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_SPOT_[A-Z0-9]+_(?:USDT|USDC)|(?:GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_[A-Z0-9]+_(?:USDT|USDC|USD))$/,
);

const CreateOrderInputSchema = z.object({
  symbol: z.string().regex(
    /^(?:(?:GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_SPOT_[A-Z0-9]+_(?:USDT|USDC)|(?:GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_[A-Z0-9]+_(?:USDT|USDC|USD))$/,
  ),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['LIMIT', 'MARKET']),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'POC']).default('GTC'),
  quantity: decimalText,
  price: decimalText.optional(),
  /** Spot market buys may be sized in quote currency instead of a base quantity. */
  quoteQty: decimalText.optional(),
  reduceOnly: z.boolean().default(false),
  positionSide: z.enum(['NONE', 'LONG', 'SHORT']).default('NONE'),
}).superRefine((value, context) => {
  if (value.type === 'LIMIT' && !value.price) context.addIssue({ code: 'custom', path: ['price'], message: 'price is required for limit orders' });
});
export const CreateStrategyInputSchema = z.object({
  kind: z.enum(['position', 'auto', 'premium', 'carry']),
  asset: z.string().regex(/^[A-Z0-9]{2,20}$/),
  /** premium: ticker of the local listing that hedges the ADR leg (e.g. SKHYNIX for SKHY). */
  hedgeAsset: z.string().regex(/^[A-Z0-9]{2,20}$/).optional(),
  /** premium: ADR shares per one hedge-leg share (SK hynix: 1 Korean share ≈ 10 ADRs). */
  adrRatio: decimalText.optional(),
  /**
   * premium: how the hedge leg is sized. SHARE_RATIO holds the fixed conversion (1 ADR ↔ 1/ratio
   * hedge shares) and profits the premium in full but carries a net short worth the premium;
   * EQUAL_NOTIONAL matches dollar value at each clip's execution prices, dollar-neutral at entry.
   */
  hedgeMode: z.enum(['SHARE_RATIO', 'EQUAL_NOTIONAL']).default('SHARE_RATIO'),
  /** Desired leverage for each perpetual leg. Defaults preserve legacy strategy records. */
  leftLeverage: decimalText.refine((value) => new Decimal(value).lte(200)).default('1'),
  rightLeverage: decimalText.refine((value) => new Decimal(value).lte(200)).default('1'),
  leftVenue: venue,
  rightVenue: venue,
  leftSide: z.enum(['BUY', 'SELL']),
  rightSide: z.enum(['BUY', 'SELL']),
  /** Position strategies may accept a bounded opening cost, represented by a negative spread. */
  entryBps: signedDecimalText.optional(),
  takeProfitBps: decimalText.optional(),
  /** auto: optional adverse-move stop-loss; |spread| beyond it closes both legs and stops. */
  stopLossBps: z.number().gt(0).optional(),
  /**
   * auto: optional laddered add-on step in bps. When set, the strategy adds one clip
   * (= perOrderQuantity) each time the spread advances another `addOnStepBps` beyond
   * `entryBps`, instead of adding a clip on every evaluation while the entry holds.
   * Absent keeps the original tick-driven accumulation, so existing strategies are unaffected.
   * Valid for both TAKER_TAKER and MAKER_TAKER.
   */
  addOnStepBps: z.number().gt(0).optional(),
  /** Explicit leg symbols override the venue/asset derivation (required for Gate spot legs). */
  leftSymbol: strategyLegSymbol.optional(),
  rightSymbol: strategyLegSymbol.optional(),
  /**
   * LEFT units per ONE right unit, i.e. right quantity = left quantity ÷ ratio. Set it when the two
   * legs are different assets (a 美股价差 pair such as SNDK vs SNXX): the engine then sizes the
   * hedge by this conversion instead of assuming one unit hedges one unit. Absent keeps the legacy
   * 1:1 behaviour, and for premium strategies `adrRatio` still wins.
   */
  quantityRatio: signedDecimalText.optional(),
  /** carry: funding direction the strategy harvests; the leg sides derive from it. */
  fundingDirection: z.enum(['POSITIVE', 'NEGATIVE']).default('POSITIVE'),
  /** carry: annualized funding percentage gate that must be met before opening (15 = 15% APR). */
  fundingAprMin: z.number().gt(0).lte(1000).default(15),
  /** carry: basis convergence take-profit between the perpetual and the spot leg, in bps. */
  basisTakeProfitBps: z.number().gt(0).lt(10_000).default(20),
  /** carry: leverage preset for the perpetual leg; the engine never adjusts account leverage. */
  contractLeverage: decimalText.refine((value) => new Decimal(value).lte(200)).default('1'),
  /** carry: verify the spot account holds enough quote/inventory before opening. */
  inventoryCheck: z.boolean().default(false),
  /** premium: absolute premium levels in percent; signed because ADRs can trade at a discount. */
  entryPremiumPct: signedDecimalText.optional(),
  takeProfitPremiumPct: signedDecimalText.optional(),
  grid: z.boolean().default(false),
  gridStepPct: decimalText.optional(),
  gridLevels: z.number().int().min(1).max(30).optional(),
  totalAmount: decimalText.optional(),
  maxPosition: decimalText.optional(),
  perOrderQuantity: decimalText,
  reduceOnly: z.boolean().default(false),
  executionMethod: z.enum(['TAKER_TAKER', 'MAKER_TAKER']),
  makerLeg: z.enum(['left', 'right']).optional(),
  closePlan: z.object({
    // Mirrors the shared schema: a single slice (1) is a legitimate timed close; the split UI
    // keeps its own >=2 requirement.
    orderCount: z.number().int().min(1).max(100),
    intervalSeconds: z.number().int().min(1).max(86_400),
    targets: z.array(z.object({
      symbol: z.string().regex(/^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/),
      side: z.enum(['BUY', 'SELL']),
      quantity: decimalText,
      positionSide: z.enum(['NONE', 'LONG', 'SHORT']),
    })).min(1).max(20),
  }).optional(),
}).superRefine((value, context) => {
  if (value.closePlan) {
    if (value.kind !== 'position') context.addIssue({ code: 'custom', path: ['kind'], message: 'close plans must be position strategies' });
    if (!value.reduceOnly) context.addIssue({ code: 'custom', path: ['reduceOnly'], message: 'close plans must be reduce only' });
    if (value.executionMethod !== 'TAKER_TAKER') context.addIssue({ code: 'custom', path: ['executionMethod'], message: 'close plans execute taker orders' });
    return;
  }
  // Premium legs trade two different tickers and carry strategies hedge a spot leg against a
  // perpetual, so only plain paired positions must sit on two different venues. A same-venue auto
  // strategy is allowed only across businesses (one spot leg vs one future leg on that venue).
  if (value.kind === 'position' && value.leftVenue === value.rightVenue) {
    context.addIssue({ code: 'custom', path: ['rightVenue'], message: 'venues must differ' });
  }
  if (value.kind === 'auto' && value.leftVenue === value.rightVenue) {
    const leftIsSpot = isSpotSymbol(value.leftSymbol ?? '');
    const rightIsSpot = isSpotSymbol(value.rightSymbol ?? '');
    if (leftIsSpot === rightIsSpot) {
      context.addIssue({ code: 'custom', path: ['rightVenue'], message: 'same-venue strategies must pair a spot and a future market' });
    }
  }
  if (value.leftSide === value.rightSide) context.addIssue({ code: 'custom', path: ['rightSide'], message: 'legs must have opposing sides' });
  if (value.kind !== 'premium' && value.kind !== 'carry' && !value.entryBps) context.addIssue({ code: 'custom', path: ['entryBps'], message: 'entry threshold is required' });
  // Auto thresholds are signed: a positive entry sells the rich leg when the spread is wide, a
  // negative entry accepts a bounded opening cost to buy the rich leg (spread ≤ entryBps).
  if (value.kind === 'position' && !value.totalAmount) context.addIssue({ code: 'custom', path: ['totalAmount'], message: 'total amount is required' });
  if (value.kind === 'auto' && (!value.maxPosition || !value.takeProfitBps)) context.addIssue({ code: 'custom', path: ['maxPosition'], message: 'max position and take profit are required' });
  if (value.executionMethod === 'MAKER_TAKER' && !value.makerLeg) context.addIssue({ code: 'custom', path: ['makerLeg'], message: 'maker leg is required' });
  if (value.kind !== 'premium' && value.hedgeMode === 'EQUAL_NOTIONAL') context.addIssue({ code: 'custom', path: ['hedgeMode'], message: 'equal-notional hedging is a premium-strategy option' });
  if (value.kind === 'premium') {
    if (!value.hedgeAsset) context.addIssue({ code: 'custom', path: ['hedgeAsset'], message: 'hedge asset is required' });
    else if (value.hedgeAsset === value.asset) context.addIssue({ code: 'custom', path: ['hedgeAsset'], message: 'hedge asset must differ from the ADR asset' });
    if (!value.adrRatio) context.addIssue({ code: 'custom', path: ['adrRatio'], message: 'ADR ratio is required' });
    if (value.entryPremiumPct === undefined) context.addIssue({ code: 'custom', path: ['entryPremiumPct'], message: 'entry premium is required' });
    if (value.executionMethod !== 'TAKER_TAKER') context.addIssue({ code: 'custom', path: ['executionMethod'], message: 'premium strategies execute taker-taker' });
    if (value.grid) {
      if (!value.gridStepPct || value.gridLevels === undefined) context.addIssue({ code: 'custom', path: ['gridStepPct'], message: 'grid step and levels are required' });
    } else {
      if (!value.reduceOnly && value.takeProfitPremiumPct === undefined) context.addIssue({ code: 'custom', path: ['takeProfitPremiumPct'], message: 'take-profit premium is required' });
      if (!value.maxPosition) context.addIssue({ code: 'custom', path: ['maxPosition'], message: 'max position is required' });
    }
  }
  if (value.kind === 'carry') {
    // The carry legs are fixed: left is a spot market on the left venue, right the matching
    // perpetual on the right venue (cross-venue carry is allowed since architecture v2); each
    // symbol must belong to the venue chosen for its leg.
    if (!value.leftSymbol) {
      context.addIssue({ code: 'custom', path: ['leftSymbol'], message: 'left spot symbol is required' });
    } else if (!SPOT_SYMBOL_PATTERN.test(value.leftSymbol)) {
      context.addIssue({ code: 'custom', path: ['leftSymbol'], message: 'left symbol must be a spot market' });
    } else if (!value.leftSymbol.startsWith(`${value.leftVenue}_SPOT_`)) {
      context.addIssue({ code: 'custom', path: ['leftSymbol'], message: 'left symbol must belong to the left venue' });
    }
    if (!value.rightSymbol) {
      context.addIssue({ code: 'custom', path: ['rightSymbol'], message: 'right perpetual symbol is required' });
    } else if (!FUTURE_SYMBOL_PATTERN.test(value.rightSymbol)) {
      context.addIssue({ code: 'custom', path: ['rightSymbol'], message: 'right symbol must be a futures market' });
    } else if (!value.rightSymbol.startsWith(`${value.rightVenue}_FUTURE_`)) {
      context.addIssue({ code: 'custom', path: ['rightSymbol'], message: 'right symbol must belong to the right venue' });
    }
    if (value.leftSymbol && value.rightSymbol) {
      const leftBase = value.leftSymbol.split('_')[2];
      const rightBase = value.rightSymbol.split('_')[2];
      if (leftBase !== rightBase) {
        context.addIssue({ code: 'custom', path: ['rightSymbol'], message: 'carry legs must share one base asset' });
      }
    }
    if (!value.totalAmount) context.addIssue({ code: 'custom', path: ['totalAmount'], message: 'total amount is required' });
    if (value.entryBps !== undefined) context.addIssue({ code: 'custom', path: ['entryBps'], message: 'entry threshold does not apply to carry strategies' });
    if (value.takeProfitBps !== undefined) context.addIssue({ code: 'custom', path: ['takeProfitBps'], message: 'take profit does not apply to carry strategies' });
    // Leg sides always derive from the funding direction and are never chosen freely.
    const expectedLeftSide = value.fundingDirection === 'POSITIVE' ? 'BUY' : 'SELL';
    const expectedRightSide = value.fundingDirection === 'POSITIVE' ? 'SELL' : 'BUY';
    if (value.leftSide !== expectedLeftSide) context.addIssue({ code: 'custom', path: ['leftSide'], message: 'left side must match the funding direction' });
    if (value.rightSide !== expectedRightSide) context.addIssue({ code: 'custom', path: ['rightSide'], message: 'right side must match the funding direction' });
    // Selling spot without holding it would borrow; negative carry therefore must verify inventory.
    if (value.fundingDirection === 'NEGATIVE' && !value.inventoryCheck) {
      context.addIssue({ code: 'custom', path: ['inventoryCheck'], message: 'inventory check is required when harvesting negative funding' });
    }
  }
});
export type CreateStrategyInput = z.infer<typeof CreateStrategyInputSchema>;

export const UpdatePremiumTakeProfitInputSchema = z.object({
  /** Absolute premium level in percent; signed because ADRs can trade at a discount. */
  takeProfitPremiumPct: signedDecimalText,
});
export type UpdatePremiumTakeProfitInput = z.infer<typeof UpdatePremiumTakeProfitInputSchema>;

export type StrategyKind = 'position' | 'auto' | 'premium' | 'carry';

/**
 * Carry accounting snapshot persisted alongside the strategy row and surfaced on the record.
 * Field naming follows the shared engine convention: camelCase, amounts suffixed `Usdt`,
 * ratios suffixed `Bps`/`Apr`, timestamps ISO 8601 UTC.
 */
export interface StrategyCarryMetrics {
  fundingCollectedUsdt: string;
  basisEntryBps: string;
  basisCurrentBps: string;
  basisPnlUsdt: string;
  feesPaidUsdt: string;
  netPnlUsdt: string;
  entryFundingApr: string;
  nextFundingAccrualAt: string | null;
}

const StrategyCarryMetricsSchema = z.object({
  fundingCollectedUsdt: z.string(),
  basisEntryBps: z.string(),
  basisCurrentBps: z.string(),
  basisPnlUsdt: z.string(),
  feesPaidUsdt: z.string(),
  netPnlUsdt: z.string(),
  entryFundingApr: z.string(),
  nextFundingAccrualAt: z.string().nullable(),
});

function carryMetricsFromRow(value: string | null): StrategyCarryMetrics | null {
  if (!value) return null;
  try {
    const parsed = StrategyCarryMetricsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface ExecutionOrder {
  id: string; remoteOrderId: string | null; clientOrderId: string;
  symbol: string; venue: string; side: 'BUY' | 'SELL'; type: 'LIMIT' | 'MARKET'; timeInForce: string;
  quantity: string; price: string | null; reduceOnly: boolean; state: string; executedQuantity: string;
  executedAveragePrice: string | null; failureReason: string | null; strategyId: string | null; strategyLeg: string | null;
  strategyClip: string | null;
  createdAt: string; updatedAt: string;
}

export interface StrategyRecord {
  id: string; kind: StrategyKind; status: string; config: CreateStrategyInput;
  accountProfileId: string | null; accountLabel: string | null;
  progress: number; filledQuantity: string; filledLeft: string; filledRight: string; openPosition: string;
  /** Sum of realized PnL reported by strategy-linked trade fills. */
  realizedPnl: string;
  /** Carry accounting snapshot; null for every non-carry strategy. */
  carryMetrics: StrategyCarryMetrics | null;
  /** Rebuilt net PnL, cost and locked-profit bps; null when the inputs are not available. */
  pnl: StrategyPnl | null;
  createdAt: string; updatedAt: string; stoppedAt: string | null;
}

export interface RecordedFill {
  transactionId: string; orderId: string; strategyId: string | null; strategyLeg: string | null;
  symbol: string; venue: string; side: 'BUY' | 'SELL'; quantity: string; price: string; matchRole: string | null;
}

type RuntimeEvent = { type: 'execution.update' | 'execution.snapshot' | 'strategy.update' | 'balance.update'; payload: unknown };
type RuntimeListener = (event: RuntimeEvent) => void;

interface OrderRow {
  id: string; remote_order_id: string | null; client_order_id: string; environment: 'live'; symbol: string;
  venue: string; side: 'BUY' | 'SELL'; order_type: 'LIMIT' | 'MARKET'; time_in_force: string; quantity: string;
  price: string | null; reduce_only: number; state: string; executed_quantity: string; executed_average_price: string | null;
  failure_reason: string | null;
  strategy_id: string | null; strategy_leg: string | null; strategy_clip: string | null;
  created_at: string; updated_at: string;
}

interface StrategyRow {
  id: string; kind: StrategyKind; environment: 'live'; status: string; config_json: string;
  credential_profile_id: string | null; credential_profile_label: string | null;
  progress: number; filled_quantity: string; filled_left: string; filled_right: string; open_position: string;
  metrics_json: string | null;
  created_at: string; updated_at: string; stopped_at: string | null;
}

/** One strategy-linked fill in chronological order, as read back for the PnL rebuild. */
interface StrategyFillRow {
  strategy_id: string; symbol: string; venue: string; side: 'BUY' | 'SELL';
  quantity: string; price: string; fee: string; created_at: string;
}

/** Separator that cannot occur inside a venue or symbol, for the (venue, symbol) composite key. */
function positionPairKey(venue: string, symbol: string): string { return `${venue}\u0000${symbol}`; }

/** A price string only counts as a usable mark when it parses to a strictly positive number. */
function positiveMarkOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = new Decimal(value);
    // decimal.js answers `new Decimal('Infinity').gt(0)` with true, so finiteness is explicit:
    // an infinite "price" must never pass as a usable mark.
    return parsed.isFinite() && parsed.gt(0) ? value : null;
  } catch {
    return null;
  }
}

function orderFromRow(row: OrderRow): ExecutionOrder {
  return { id: row.id, remoteOrderId: row.remote_order_id, clientOrderId: row.client_order_id,
    symbol: row.symbol, venue: row.venue, side: row.side, type: row.order_type, timeInForce: row.time_in_force,
    quantity: row.quantity, price: row.price, reduceOnly: row.reduce_only === 1, state: row.state,
    executedQuantity: row.executed_quantity, executedAveragePrice: row.executed_average_price,
    failureReason: row.failure_reason,
    strategyId: row.strategy_id, strategyLeg: row.strategy_leg, strategyClip: row.strategy_clip,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

function strategyFromRow(row: StrategyRow): StrategyRecord {
  return { id: row.id, kind: row.kind, status: row.status,
    accountProfileId: row.credential_profile_id, accountLabel: row.credential_profile_label,
    config: CreateStrategyInputSchema.parse(JSON.parse(row.config_json)), progress: row.progress,
    filledQuantity: row.filled_quantity, filledLeft: row.filled_left, filledRight: row.filled_right,
    openPosition: row.open_position, realizedPnl: '0',
    carryMetrics: carryMetricsFromRow(row.metrics_json ?? null),
    // Filled in by the caller once the per-strategy PnL rebuild has run; null when unavailable.
    pnl: null,
    createdAt: row.created_at, updatedAt: row.updated_at, stoppedAt: row.stopped_at };
}

function venueFromSymbol(symbol: string): string { return symbol.split('_', 1)[0] ?? 'UNKNOWN'; }

const OPEN_ORDER_STATES = ['PENDING_SUBMIT', 'PENDING_CANCEL', 'NEW', 'OPEN', 'PARTIALLY_FILLED'];

export function isTerminalOrderState(state: string): boolean {
  return !OPEN_ORDER_STATES.includes(state);
}

/**
 * A submit failure is only safe to mark FAIL when Gate definitively rejected it (4xx). Network
 * errors, 5xx, and unreadable 2xx responses may all follow an accepted order, so those rows must
 * stay PENDING_SUBMIT until the order-details endpoint settles what actually happened.
 */
function isDefinitiveSubmitRejection(error: unknown): boolean {
  return error instanceof GateApiError && error.statusCode >= 400 && error.statusCode < 500;
}

/**
 * True when a rejection means "reduce-only quantity exceeds the venue position". The engine's
 * ledger drifts from the venue whenever a position is closed outside the engine, and this code
 * is the venue saying so explicitly — a state mismatch to reconcile, not a submission failure
 * to retry or count against the five-strike budget.
 */
export function isReduceOnlyQuantityRejection(error: unknown): boolean {
  return error instanceof GateApiError && error.label === 'TRADE_REDUCE_ONLY_POSITION_QTY_ERROR';
}

function isoFromEpochMillis(value: string): string {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : value;
}

/**
 * Map a raw venue position row onto the portfolio shape `reconcileLivePositions` persists.
 * ADL enrichment is deliberately omitted: this read exists to re-anchor quantities after a
 * reduce-only rejection, and the periodic portfolio reconciliation re-adds the ranks.
 */
function normalizeRemotePosition(position: GateCrossExPosition): PortfolioFuturesPosition {
  return {
    positionId: position.position_id, symbol: position.symbol, positionSide: position.position_side,
    initialMargin: position.initial_margin, maintenanceMargin: position.maintenance_margin,
    quantity: position.position_qty, value: position.position_value, unrealizedPnl: position.upnl,
    unrealizedPnlRate: position.upnl_rate, entryPrice: position.entry_price, markPrice: position.mark_price,
    leverage: position.leverage, maxLeverage: position.max_leverage, riskLimit: position.risk_limit,
    fee: position.fee, fundingFee: position.funding_fee, fundingTime: position.funding_time,
    createdAt: isoFromEpochMillis(position.create_time), updatedAt: isoFromEpochMillis(position.update_time),
    realizedPnl: position.closed_pnl,
    crossExAdlRank: null, exchangeAdlRank: null,
  };
}

function maxRiskPositionValueAtLeverage(
  limit: GateCrossExRiskLimit | undefined,
  leverage: Decimal,
): Decimal | null {
  const eligible = (limit?.tiers ?? []).flatMap((tier) => {
    try {
      const tierLeverage = new Decimal(tier.leverage_max);
      const maxPositionValue = new Decimal(tier.max_risk_limit_value);
      return tierLeverage.gte(leverage) && maxPositionValue.gt(0) ? [maxPositionValue] : [];
    } catch {
      return [];
    }
  });
  return eligible.length > 0 ? Decimal.max(...eligible) : null;
}

export interface PlaceOrderMetadata {
  strategyId: string;
  strategyLeg: 'left' | 'right' | `close-${number}`;
  /** Groups the legs of one clip (and its repairs) so per-clip hedge ratios are recoverable. */
  strategyClip?: string;
  /**
   * Internal-only escape hatch for a hedge/flatten order that reduces risk after the user has
   * locked ordinary trading. HTTP callers never construct metadata, so they cannot use it.
   */
  riskReducing?: boolean;
}

export interface TradingRuntimeOptions {
  /** Delay between attempts to settle a PENDING_SUBMIT row whose submission outcome is unknown. */
  submitResolvePollMs?: number;
  submitResolveMaxAttempts?: number;
  /** Account-wide barrier shared with credential replacement/switch/deletion. */
  runAuthenticatedWrite?: <T>(work: () => Promise<T>) => Promise<T>;
}

export interface StrategyMarginLeg {
  symbol: string;
  venue: string;
  side: 'BUY' | 'SELL';
  leverage: string;
  estimatedQuantity: string;
  estimatedPrice: string;
  positionSide?: 'NONE' | 'LONG' | 'SHORT';
}

export interface StrategyMarginPreflight {
  requiredMargin: string;
  availableMargin: string;
}

export class TradingRuntime {
  private readonly listeners = new Set<RuntimeListener>();
  private readonly fillListeners = new Set<(fill: RecordedFill) => void>();
  private readonly orderListeners = new Set<(order: ExecutionOrder) => void>();
  /** Private pushes that matched no local order row yet; replayed once the row can match them. */
  private readonly unmatchedPrivateEvents: Array<{ event: PrivateCrossExEvent; receivedAt: number }> = [];
  private readonly submitResolvePollMs: number;
  private readonly submitResolveMaxAttempts: number;
  private readonly remoteRefreshes = new Map<string, Promise<ExecutionOrder | null>>();
  private readonly cancelRequests = new Map<string, Promise<ExecutionOrder>>();
  /** In-flight on-demand position reconciliation; concurrent callers share one remote read. */
  private positionsReconcileRun: Promise<PortfolioFuturesPosition[]> | null = null;
  private readonly preparedStatements = new Map<string, Database.Statement>();
  private readonly runAuthenticatedWrite: <T>(work: () => Promise<T>) => Promise<T>;

  constructor(
    private readonly database: Database.Database,
    private readonly session: TradingSession,
    private readonly vault: CredentialVault,
    private readonly gateway: ReadOnlyCrossExGateway,
    options: TradingRuntimeOptions = {},
  ) {
    this.submitResolvePollMs = options.submitResolvePollMs ?? 2_500;
    this.submitResolveMaxAttempts = options.submitResolveMaxAttempts ?? 24;
    this.runAuthenticatedWrite = options.runAuthenticatedWrite ?? (async (work) => work());
  }

  subscribe(listener: RuntimeListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  onFill(listener: (fill: RecordedFill) => void): () => void {
    this.fillListeners.add(listener);
    return () => this.fillListeners.delete(listener);
  }

  onOrderUpdate(listener: (order: ExecutionOrder) => void): () => void {
    this.orderListeners.add(listener);
    return () => this.orderListeners.delete(listener);
  }

  private statement(sql: string): Database.Statement {
    const cached = this.preparedStatements.get(sql);
    if (cached) return cached;
    const prepared = this.database.prepare(sql);
    this.preparedStatements.set(sql, prepared);
    return prepared;
  }

  /**
   * Validate the full planned strategy exposure against a fresh account balance, then apply the
   * requested per-leg leverage. The 10% reserve covers small price moves, taker fees, and rounding
   * between this check and the actual entry. Spot legs (full cash, no leverage tiers) skip the
   * futures risk-limit gate, and `mutateLeverage: false` keeps carry strategies from touching the
   * account's leverage preset at all.
   */
  async prepareStrategyMargin(
    legs: StrategyMarginLeg[],
    options: { mutateLeverage?: boolean } = {},
  ): Promise<StrategyMarginPreflight> {
    if (!this.session.liveTradingEnabled) throw new TradingRuntimeError('live_trading_locked', 403);
    const credentials = await this.vault.get(DEFAULT_CREDENTIAL_PROFILE);
    if (!credentials) throw new TradingRuntimeError('credential_not_configured', 409);
    const tradingGateway = this.gateway as Partial<TradingCrossExGateway>;
    if (!tradingGateway.queryAccount || !tradingGateway.queryPositions
      || !tradingGateway.queryLeverages || !tradingGateway.setLeverage) {
      throw new TradingRuntimeError('strategy_margin_preflight_unavailable', 503);
    }
    const isSpotLeg = (symbol: string): boolean => isSpotSymbol(symbol);
    const leveragedLegs = legs.filter((leg) => !isSpotLeg(leg.symbol));

    const venues = [...new Set(legs.map((leg) => leg.venue.toUpperCase()))];
    let account: GateCrossExAccount | null = null;
    let isolatedAccounts: GateCrossExAccount[] = [];
    let positions;
    let riskLimits: GateCrossExRiskLimit[];
    try {
      try {
        account = await tradingGateway.queryAccount(credentials);
      } catch (error) {
        // Gate requires exchange_type after an account has been switched to isolated mode. A 400
        // from the unscoped query is therefore retried only for the venues used by this strategy.
        if (!(error instanceof GateApiError) || (error.statusCode !== 400 && error.statusCode !== 422)) throw error;
        isolatedAccounts = await Promise.all(
          venues.map((venue) => tradingGateway.queryAccount!(credentials, venue)),
        );
      }
      if (account?.account_mode === 'ISOLATED_EXCHANGE') {
        isolatedAccounts = await Promise.all(venues.map((venue) => (
          account?.exchange_type === venue
            ? Promise.resolve(account)
            : tradingGateway.queryAccount!(credentials, venue)
        )));
      }
      // Margin relief is based on a fresh exchange position snapshot. A cached portfolio could
      // incorrectly classify an exposure-increasing order as a close after the position changed.
      positions = await tradingGateway.queryPositions(credentials);
      // Spot legs have no leverage tiers; only query risk limits for the futures legs.
      riskLimits = leveragedLegs.length > 0
        ? await this.gateway.queryRiskLimits([...new Set(leveragedLegs.map((leg) => leg.symbol))])
        : [];
    } catch (error) {
      if (error instanceof GateApiError && error.statusCode === 429) {
        throw new TradingRuntimeError('strategy_preflight_rate_limited', 429);
      }
      throw new TradingRuntimeError('strategy_margin_preflight_unavailable', 503);
    }
    const reserveFactor = new Decimal('1.10');
    const riskLimitBySymbol = new Map(riskLimits.map((limit) => [limit.symbol, limit]));
    const requiredByVenue = new Map<string, Decimal>();
    let requiredMargin = new Decimal(0);
    for (const leg of legs) {
      const existingPosition = positions.find((position) => position.symbol === leg.symbol);
      const existingQuantity = (() => {
        if (!existingPosition) return new Decimal(0);
        const rawQuantity = new Decimal(existingPosition.position_qty);
        const positionSide = existingPosition.position_side.toUpperCase();
        if (positionSide === 'SHORT') return rawQuantity.abs().negated();
        if (positionSide === 'LONG') return rawQuantity.abs();
        return rawQuantity;
      })();
      const plannedQuantity = new Decimal(leg.estimatedQuantity)
        .mul(leg.side === 'BUY' ? 1 : -1);
      // Spot legs are full-cash positions without leverage tiers; skip the futures risk-limit gate.
      const maxPositionValue = isSpotLeg(leg.symbol) ? null : maxRiskPositionValueAtLeverage(
        riskLimitBySymbol.get(leg.symbol),
        new Decimal(leg.leverage),
      );
      if (!isSpotLeg(leg.symbol) && !maxPositionValue) {
        throw new TradingRuntimeError('strategy_position_limit_unavailable', 503, leg.symbol);
      }
      const projectedPositionValue = existingQuantity.plus(plannedQuantity).abs().mul(leg.estimatedPrice);
      if (maxPositionValue !== null && projectedPositionValue.gt(maxPositionValue)) {
        throw new TradingRuntimeError('strategy_position_exceeds_leverage_limit', 409, leg.symbol);
      }
      // Closing or reducing an opposite position consumes no additional margin. If the order
      // crosses through zero, reserve only for the increase beyond the position already carried.
      const incrementalExposure = Decimal.max(
        0,
        existingQuantity.plus(plannedQuantity).abs().minus(existingQuantity.abs()),
      );
      const requirement = incrementalExposure
        .mul(leg.estimatedPrice)
        .div(leg.leverage)
        .mul(reserveFactor);
      requiredMargin = requiredMargin.plus(requirement);
      const venue = leg.venue.toUpperCase();
      requiredByVenue.set(venue, (requiredByVenue.get(venue) ?? new Decimal(0)).plus(requirement));
    }
    let availableMargin = new Decimal(0);
    if (account?.account_mode === 'CROSS_EXCHANGE') {
      // In CrossEx unified mode, Gate's top-level available_margin is authoritative. assets[] is a
      // venue/currency allocation breakdown and cannot be used as a per-leg spending limit.
      availableMargin = new Decimal(account.available_margin);
      if (!availableMargin.isFinite() || availableMargin.lt(requiredMargin)) {
        throw new TradingRuntimeError('insufficient_strategy_margin', 409);
      }
    } else {
      if (isolatedAccounts.length !== venues.length
        || isolatedAccounts.some((isolated) => isolated.account_mode !== 'ISOLATED_EXCHANGE')) {
        throw new TradingRuntimeError('strategy_margin_preflight_unavailable', 503);
      }
      const byVenue = new Map(isolatedAccounts.map((isolated) => [isolated.exchange_type.toUpperCase(), isolated]));
      for (const [venue, required] of requiredByVenue) {
        const isolated = byVenue.get(venue);
        if (!isolated) throw new TradingRuntimeError('strategy_margin_preflight_unavailable', 503);
        const venueAvailable = new Decimal(isolated.available_margin);
        if (!venueAvailable.isFinite() || venueAvailable.lt(required)) {
          throw new TradingRuntimeError('insufficient_strategy_margin', 409);
        }
        availableMargin = availableMargin.plus(venueAvailable);
      }
    }

    const uniqueLegs = [...new Map(leveragedLegs.map((leg) => [leg.symbol, leg])).values()];
    if (options.mutateLeverage !== false && uniqueLegs.length > 0) {
      try {
        for (const leg of uniqueLegs) {
          // Gate accepts comma-separated symbols, but venue adapters do not consistently return
          // every requested key from that batched form. Verify each leg independently so a missing
          // batch entry cannot trigger an unnecessary (and sometimes rejected) leverage update.
          const current = await tradingGateway.queryLeverages(credentials, [leg.symbol]);
          const currentLeverage = current[leg.symbol];
          if (currentLeverage !== undefined
            && new Decimal(currentLeverage).eq(new Decimal(leg.leverage))) continue;
          await tradingGateway.setLeverage(credentials, leg.symbol, leg.leverage);
        }
      } catch (error) {
        if (error instanceof GateApiError && error.statusCode === 429) {
          throw new TradingRuntimeError('strategy_preflight_rate_limited', 429);
        }
        if (error instanceof GateApiError && error.statusCode >= 400 && error.statusCode < 500) {
          throw new TradingRuntimeError('strategy_leverage_rejected', 400, error.label);
        }
        throw new TradingRuntimeError('strategy_leverage_unavailable', 503);
      }
    }
    return { requiredMargin: requiredMargin.toString(), availableMargin: availableMargin.toString() };
  }

  /**
   * Validate a reduce-only strategy against a fresh exchange position snapshot. Every planned
   * leg must point toward zero and fit inside the currently open position; unlike a normal
   * margin preflight, this deliberately does not mutate leverage settings.
   */
  async prepareReduceOnlyStrategy(legs: StrategyMarginLeg[]): Promise<void> {
    if (!this.session.liveTradingEnabled) throw new TradingRuntimeError('live_trading_locked', 403);
    const credentials = await this.vault.get(DEFAULT_CREDENTIAL_PROFILE);
    if (!credentials) throw new TradingRuntimeError('credential_not_configured', 409);
    const tradingGateway = this.gateway as Partial<TradingCrossExGateway>;
    if (!tradingGateway.queryPositions) {
      throw new TradingRuntimeError('strategy_reduce_only_preflight_unavailable', 503);
    }

    let positions;
    try {
      positions = await tradingGateway.queryPositions(credentials);
    } catch (error) {
      if (error instanceof GateApiError && error.statusCode === 429) {
        throw new TradingRuntimeError('strategy_preflight_rate_limited', 429);
      }
      throw new TradingRuntimeError('strategy_reduce_only_preflight_unavailable', 503);
    }

    const invalid = legs.find((leg) => {
      const position = positions.find((candidate) => candidate.symbol === leg.symbol
        && (!leg.positionSide || leg.positionSide === 'NONE' || candidate.position_side.toUpperCase() === leg.positionSide));
      if (!position) return true;
      const raw = new Decimal(position.position_qty || '0').abs();
      const existing = position.position_side.toUpperCase() === 'SHORT' ? raw.negated()
        : position.position_side.toUpperCase() === 'LONG' ? raw
          : new Decimal(position.position_qty || '0');
      const planned = new Decimal(leg.estimatedQuantity).mul(leg.side === 'BUY' ? 1 : -1);
      return !existing.isFinite() || existing.isZero()
        || existing.mul(planned).gte(0)
        || planned.abs().gt(existing.abs());
    });
    if (invalid) {
      throw new TradingRuntimeError('reduce_only_position_unavailable', 409, invalid.symbol);
    }
  }

  listOrders(limit = 100): ExecutionOrder[] {
    const rows = this.statement("SELECT * FROM execution_orders WHERE environment = 'live' ORDER BY created_at DESC LIMIT ?").all(limit) as OrderRow[];
    return rows.map(orderFromRow);
  }

  listOpenOrders(strategyId?: string): ExecutionOrder[] {
    const placeholders = OPEN_ORDER_STATES.map(() => '?').join(', ');
    const rows = strategyId
      ? this.statement(`SELECT * FROM execution_orders
          WHERE environment = 'live' AND strategy_id = ? AND state IN (${placeholders})
          ORDER BY created_at`).all(strategyId, ...OPEN_ORDER_STATES) as OrderRow[]
      : this.statement(`SELECT * FROM execution_orders
          WHERE environment = 'live' AND state IN (${placeholders})
          ORDER BY created_at`).all(...OPEN_ORDER_STATES) as OrderRow[];
    return rows.map(orderFromRow);
  }

  listStrategies(): StrategyRecord[] {
    const rows = this.statement("SELECT * FROM execution_strategies WHERE environment = 'live' ORDER BY created_at DESC").all() as StrategyRow[];
    const realizedPnl = this.strategyRealizedPnl();
    // One bulk pass over every strategy-linked fill serves both the per-strategy replay and the
    // (venue, symbol) ownership test the funding attribution needs — no per-strategy query.
    const fillRows = this.strategyFillRows();
    const marks = this.pnlMarks();
    const owners = this.positionPairOwners(fillRows);
    const livePositions = this.livePositionFundingRows();
    const fillsByStrategy = new Map<string, StrategyFillRow[]>();
    for (const row of fillRows) {
      const bucket = fillsByStrategy.get(row.strategy_id);
      if (bucket) bucket.push(row);
      else fillsByStrategy.set(row.strategy_id, [row]);
    }
    return rows.map((row) => {
      const strategy = strategyFromRow(row);
      // A single strategy's PnL must never take the whole list down: any failure degrades that one
      // row to `pnl: null` while every other strategy is still served.
      let pnl: StrategyPnl | null = null;
      try {
        pnl = this.computePnlFor(strategy, fillsByStrategy.get(strategy.id) ?? [], marks, owners, livePositions);
      } catch {
        pnl = null;
      }
      return { ...strategy, realizedPnl: realizedPnl.get(strategy.id)?.toString() ?? '0', pnl };
    });
  }

  strategyLogs(strategyId: string): Array<{ id: string; level: string; event: string; condition: string; quantity: string; result: string; createdAt: string }> {
    const rows = this.statement(`SELECT id, level, event, condition_text, quantity, result_text, created_at
      FROM execution_strategy_logs WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 200`).all(strategyId) as Array<Record<string, string>>;
    return rows.map((row) => ({ id: row.id, level: row.level, event: row.event, condition: row.condition_text,
      quantity: row.quantity, result: row.result_text, createdAt: row.created_at }));
  }

  /**
   * Keyset-paginated slice of a strategy's execution log. Rows are ordered newest-first by
   * `(created_at, id)`; the id tie-break keeps equal-millisecond clip legs from being skipped or
   * duplicated across pages (the ISO timestamp is millisecond-precision and both legs of one clip
   * can land on the same instant). `category` narrows the scan to the events — plus the grouping
   * dependencies of `STRATEGY_LOG_CATEGORY_FETCH_EVENTS` — the filtered view needs; `'all'`
   * selects every event. `LIMIT` fetches one extra row to detect `hasMore` without a second query.
   */
  strategyLogPage(
    strategyId: string,
    options: { category: StrategyLogCategory; limit: number; before?: { createdAt: string; id: string } },
  ): StrategyLogPage {
    const clauses = ['strategy_id = ?'];
    const params: Array<string | number> = [strategyId];
    if (options.before) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(options.before.createdAt, options.before.createdAt, options.before.id);
    }
    if (options.category !== 'all') {
      // A category's fetch set mixes exact names with SQL LIKE prefix patterns (a `%` suffix). The
      // leg-level events use a pattern because their tail is a dynamic order state that no fixed
      // IN-list can close over. Both kinds collapse into one OR term before LIMIT, so the keyset
      // page and its ordering are unchanged.
      const events = STRATEGY_LOG_CATEGORY_FETCH_EVENTS[options.category];
      const exact = events.filter((event) => !event.endsWith('%'));
      const patterns = events.filter((event) => event.endsWith('%'));
      const eventTerms: string[] = [];
      if (exact.length > 0) eventTerms.push(`event IN (${exact.map(() => '?').join(', ')})`);
      eventTerms.push(...patterns.map(() => 'event LIKE ?'));
      clauses.push(`(${eventTerms.join(' OR ')})`);
      params.push(...exact, ...patterns);
    }
    // Cursor-independent total for the same filter, so a tab can say "22 rows exist, just not in
    // the newest page" instead of the misleading "no events in this category". The superset means
    // this counts dependency rows too (leg diagnostics, trigger rows); the client re-filters, so
    // the number is an upper bound — still enough to disambiguate "empty" from "buried".
    const totalRow = this.statement(`SELECT COUNT(*) AS total FROM execution_strategy_logs WHERE ${clauses.join(' AND ')}`).get(...params) as { total: number };
    const rows = this.statement(`SELECT id, level, event, condition_text, quantity, result_text, created_at
      FROM execution_strategy_logs
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`).all(...params, options.limit + 1) as Array<Record<string, string>>;

    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? { createdAt: last.created_at, id: last.id } : null;
    return {
      logs: pageRows.map((row) => ({ id: row.id, level: row.level, event: row.event, condition: row.condition_text,
        quantity: row.quantity, result: row.result_text, createdAt: row.created_at })),
      hasMore,
      nextCursor,
      categoryTotal: totalRow.total,
    };
  }

  listBalances(): LiveBalance[] {
    const rows = this.statement('SELECT venue, coin, balance, available_balance, equity, unrealized_pnl, updated_at FROM live_balances ORDER BY venue, coin').all() as Array<Record<string, string>>;
    return rows.map((row) => ({ venue: row.venue, coin: row.coin, balance: row.balance,
      availableBalance: row.available_balance, equity: row.equity, unrealizedPnl: row.unrealized_pnl, updatedAt: row.updated_at }));
  }

  snapshot(): { mode: 'live'; orders: ExecutionOrder[]; positions: unknown[]; fills: unknown[]; balances: LiveBalance[] } {
    const positions = this.statement('SELECT position_id, symbol, venue, quantity, entry_price, mark_price, realized_pnl, funding_fee, updated_at FROM live_positions ORDER BY symbol').all();
    const fills = this.statement(`SELECT fill.id, fill.order_id, fill.symbol, fill.venue, fill.side, fill.quantity,
      fill.price, fill.fee, fill.realized_pnl, fill.created_at FROM execution_fills AS fill
      INNER JOIN execution_orders AS execution_order ON execution_order.id = fill.order_id
      WHERE execution_order.environment = 'live' ORDER BY fill.created_at DESC LIMIT 100`).all();
    return { mode: 'live', orders: this.listOrders(), positions, fills, balances: this.listBalances() };
  }

  reconcileLivePositions(positions: PortfolioFuturesPosition[]): void {
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM live_positions').run();
      const insert = this.database.prepare(`INSERT INTO live_positions
        (position_id, symbol, venue, quantity, entry_price, mark_price, realized_pnl, funding_fee, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const position of positions) {
        const quantity = position.positionSide === 'SHORT'
          ? new Decimal(position.quantity).abs().neg().toString()
          : position.quantity;
        insert.run(position.positionId, position.symbol, venueFromSymbol(position.symbol), quantity,
          position.entryPrice, position.markPrice, position.realizedPnl, position.fundingFee, position.updatedAt);
      }
    })();
    this.emit({ type: 'execution.snapshot', payload: this.snapshot() });
  }

  /**
   * Fetch the venue's futures positions right now and refresh `live_positions` from them.
   *
   * The strategy engine calls this when a reduce-only order is rejected with
   * TRADE_REDUCE_ONLY_POSITION_QTY_ERROR: the engine's ledger believes a position the venue
   * no longer holds (or holds smaller than believed). That drift happens whenever a position
   * is closed outside the engine — manually on the exchange, by liquidation, or by the
   * opposite leg — and only a fresh remote read can re-anchor the quantity, so waiting for
   * the next periodic reconciliation would keep rejecting correctly-sized orders. The
   * refreshed rows are returned so the caller can clamp its order immediately. Concurrent
   * callers share one in-flight read.
   */
  async reconcilePositionsFromRemote(): Promise<PortfolioFuturesPosition[]> {
    if (this.positionsReconcileRun) return this.positionsReconcileRun;
    const run = this.fetchAndReconcilePositions();
    this.positionsReconcileRun = run;
    try {
      return await run;
    } finally {
      if (this.positionsReconcileRun === run) this.positionsReconcileRun = null;
    }
  }

  private async fetchAndReconcilePositions(): Promise<PortfolioFuturesPosition[]> {
    if (!this.session.liveTradingEnabled) throw new TradingRuntimeError('live_trading_locked', 403);
    const credentials = await this.vault.get(DEFAULT_CREDENTIAL_PROFILE);
    if (!credentials) throw new TradingRuntimeError('credential_not_configured', 409);
    const tradingGateway = this.gateway as Partial<TradingCrossExGateway>;
    if (!tradingGateway.queryPositions) {
      throw new TradingRuntimeError('position_reconciliation_unavailable', 503);
    }
    let positions: GateCrossExPosition[];
    try {
      positions = await tradingGateway.queryPositions(credentials);
    } catch (error) {
      if (error instanceof GateApiError && error.statusCode === 429) {
        throw new TradingRuntimeError('position_reconciliation_rate_limited', 429);
      }
      throw new TradingRuntimeError('position_reconciliation_unavailable', 503);
    }
    const normalized = positions.map(normalizeRemotePosition);
    this.reconcileLivePositions(normalized);
    return normalized;
  }

  reconcileLiveBalances(balances: Array<{ venue: string; coin: string; balance: string; availableBalance: string; equity: string; unrealizedPnl: string }>, updatedAt: string): void {
    this.database.transaction(() => {
      // A REST account snapshot is authoritative. Rows absent from it belong to a venue/coin the
      // current account no longer has (most importantly after credentials are changed), so an
      // upsert-only reconciliation would leak balances from the previous account indefinitely.
      this.database.prepare('DELETE FROM live_balances').run();
      const upsert = this.database.prepare(`INSERT INTO live_balances (venue, coin, balance, available_balance, equity, unrealized_pnl, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(venue, coin) DO UPDATE SET balance = excluded.balance,
        available_balance = excluded.available_balance, equity = excluded.equity,
        unrealized_pnl = excluded.unrealized_pnl, updated_at = excluded.updated_at`);
      for (const balance of balances) {
        upsert.run(balance.venue, balance.coin, balance.balance, balance.availableBalance, balance.equity, balance.unrealizedPnl, updatedAt);
      }
    })();
  }

  /**
   * Recover fills missed while the private stream was disconnected or could not parse a push.
   * REST portfolio history uses Gate's remote order id (and client text as a fallback), so only
   * fills belonging to orders created by this runtime are copied into the execution ledger.
   */
  reconcileExecutionFills(fills: PortfolioFill[]): number {
    const findOrder = this.database.prepare(`SELECT id, strategy_id, strategy_leg
      FROM execution_orders
      WHERE environment = 'live'
        AND (remote_order_id = ? OR (? <> '' AND client_order_id = ?))
      ORDER BY CASE WHEN remote_order_id = ? THEN 0 ELSE 1 END
      LIMIT 1`);
    const insert = this.database.prepare(`INSERT OR IGNORE INTO execution_fills
      (id, order_id, symbol, venue, side, quantity, price, fee, realized_pnl, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const recovered: RecordedFill[] = [];

    this.database.transaction(() => {
      for (const fill of fills) {
        if (fill.side !== 'BUY' && fill.side !== 'SELL') continue;
        const order = findOrder.get(fill.orderId, fill.clientOrderId, fill.clientOrderId, fill.orderId) as {
          id: string; strategy_id: string | null; strategy_leg: string | null;
        } | undefined;
        if (!order) continue;
        const result = insert.run(fill.transactionId, order.id, fill.symbol, fill.venue, fill.side,
          fill.quantity, fill.price, fill.fee, fill.realizedPnl, fill.createdAt);
        if (result.changes === 0) continue;
        recovered.push({
          transactionId: fill.transactionId,
          orderId: order.id,
          strategyId: order.strategy_id,
          strategyLeg: order.strategy_leg,
          symbol: fill.symbol,
          venue: fill.venue,
          side: fill.side,
          quantity: fill.quantity,
          price: fill.price,
          matchRole: fill.matchRole || null,
        });
      }
    })();

    for (const fill of recovered) this.notifyFillListeners(fill);
    if (recovered.length > 0) this.emit({ type: 'execution.snapshot', payload: this.snapshot() });
    return recovered.length;
  }

  /**
   * A push for one of our orders can arrive before createOrder has recorded the remote id (WS
   * racing REST) — hold it briefly instead of dropping it. Pushes for orders placed outside this
   * app also land here and simply age out.
   */
  private bufferUnmatchedPrivateEvent(event: PrivateCrossExEvent): void {
    const now = Date.now();
    const fresh = this.unmatchedPrivateEvents.filter((entry) => now - entry.receivedAt <= 10_000);
    this.unmatchedPrivateEvents.length = 0;
    this.unmatchedPrivateEvents.push(...fresh.slice(-199), { event, receivedAt: now });
  }

  private replayUnmatchedPrivateEvents(remoteOrderId: string, clientOrderId: string): void {
    if (this.unmatchedPrivateEvents.length === 0) return;
    const matched: PrivateCrossExEvent[] = [];
    const rest: Array<{ event: PrivateCrossExEvent; receivedAt: number }> = [];
    for (const entry of this.unmatchedPrivateEvents) {
      const orderId = typeof entry.event.payload.order_id === 'string' ? entry.event.payload.order_id : null;
      const text = typeof entry.event.payload.text === 'string' ? entry.event.payload.text : null;
      if (orderId === remoteOrderId || text === clientOrderId) matched.push(entry.event);
      else rest.push(entry);
    }
    this.unmatchedPrivateEvents.length = 0;
    this.unmatchedPrivateEvents.push(...rest);
    for (const event of matched) this.ingestPrivateEvent(event);
  }

  ingestPrivateEvent(event: PrivateCrossExEvent): void {
    if (event.channel === 'order') {
      const parsed = z.object({ order_id: z.string(), text: z.string().optional(), state: z.string(),
        executed_qty: z.string().optional(), executed_avg_price: z.string().optional(), reason: z.string().optional(),
        update_time: z.string().optional() }).passthrough().safeParse(event.payload);
      if (!parsed.success) return;
      const row = this.statement('SELECT * FROM execution_orders WHERE remote_order_id = ? OR client_order_id = ? LIMIT 1')
        .get(parsed.data.order_id, parsed.data.text ?? '') as OrderRow | undefined;
      if (!row) {
        this.bufferUnmatchedPrivateEvent(event);
        return;
      }
      // Reconnect replays and out-of-order delivery happen: a terminal order must never regress
      // to an open state, and executed quantity only moves forward. A cancel raced by a fill may
      // still correct one terminal state to another (e.g. CANCELLED -> FILLED).
      const incoming = parsed.data;
      const nextState = isTerminalOrderState(row.state) && !isTerminalOrderState(incoming.state) ? row.state : incoming.state;
      const quantityAdvanced = incoming.executed_qty !== undefined && Number(incoming.executed_qty) > Number(row.executed_quantity);
      const nextQuantity = quantityAdvanced && incoming.executed_qty !== undefined ? incoming.executed_qty : row.executed_quantity;
      const nextAveragePrice = (quantityAdvanced || row.executed_average_price === null)
        ? incoming.executed_avg_price ?? row.executed_average_price
        : row.executed_average_price;
      const nextFailureReason = incoming.reason?.trim() || row.failure_reason;
      const nextRemoteOrderId = row.remote_order_id ?? incoming.order_id;
      if (nextState === row.state && nextQuantity === row.executed_quantity
        && (nextAveragePrice ?? null) === row.executed_average_price && nextFailureReason === row.failure_reason
        && nextRemoteOrderId === row.remote_order_id) {
        return;
      }
      const updateTime = incoming.update_time && Number.isFinite(Number(incoming.update_time))
        ? new Date(Number(incoming.update_time)).toISOString() : new Date().toISOString();
      this.database.prepare(`UPDATE execution_orders SET state = ?, executed_quantity = ?, executed_average_price = ?,
        failure_reason = ?, remote_order_id = ?, updated_at = ? WHERE id = ?`)
        .run(nextState, nextQuantity, nextAveragePrice ?? null, nextFailureReason, nextRemoteOrderId, updateTime, row.id);
      const order = this.getOrder(row.id);
      this.emit({ type: 'execution.update', payload: order });
      this.notifyOrderListeners(order);
      return;
    }
    if (event.channel === 'usertrades') {
      const parsed = z.object({ transaction_id: z.string(), order_id: z.string(), symbol: z.string(), exchange_type: z.string(),
        side: z.enum(['BUY', 'SELL']), qty: z.string(), price: z.string(), fee: z.string(), rpnl: z.string().optional(),
        match_role: z.string().optional(), create_time: z.string() }).passthrough().safeParse(event.payload);
      if (!parsed.success) return;
      const order = this.statement('SELECT id, strategy_id, strategy_leg FROM execution_orders WHERE remote_order_id = ? LIMIT 1')
        .get(parsed.data.order_id) as { id: string; strategy_id: string | null; strategy_leg: string | null } | undefined;
      if (!order) {
        this.bufferUnmatchedPrivateEvent(event);
        return;
      }
      const createdAt = Number.isFinite(Number(parsed.data.create_time)) ? new Date(Number(parsed.data.create_time)).toISOString() : new Date().toISOString();
      const inserted = this.database.prepare(`INSERT OR IGNORE INTO execution_fills (id, order_id, symbol, venue, side, quantity, price, fee, realized_pnl, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(parsed.data.transaction_id, order.id, parsed.data.symbol,
        parsed.data.exchange_type, parsed.data.side, parsed.data.qty, parsed.data.price, parsed.data.fee, parsed.data.rpnl ?? '0', createdAt);
      this.emit({ type: 'execution.update', payload: this.getOrder(order.id) });
      if (inserted.changes > 0) {
        const fill: RecordedFill = {
          transactionId: parsed.data.transaction_id, orderId: order.id, strategyId: order.strategy_id,
          strategyLeg: order.strategy_leg, symbol: parsed.data.symbol, venue: parsed.data.exchange_type,
          side: parsed.data.side, quantity: parsed.data.qty, price: parsed.data.price, matchRole: parsed.data.match_role ?? null,
        };
        this.notifyFillListeners(fill);
        this.emit({ type: 'execution.snapshot', payload: this.snapshot() });
      }
      return;
    }
    if (event.channel === 'asset') {
      const parsed = z.object({ coin: z.string(), exchange_type: z.string(), balance: z.string().optional(),
        available_balance: z.string().optional(), equity: z.string().optional(), upnl: z.string().optional() }).passthrough().safeParse(event.payload);
      if (!parsed.success) return;
      const updatedAt = new Date().toISOString();
      // Partial pushes (e.g. an equity-only update on a mark move) must never reset the fields
      // they omit, so merge into the existing row instead of upserting whole-row defaults.
      const merged = this.database.prepare(`UPDATE live_balances SET balance = COALESCE(?, balance),
        available_balance = COALESCE(?, available_balance), equity = COALESCE(?, equity),
        unrealized_pnl = COALESCE(?, unrealized_pnl), updated_at = ? WHERE venue = ? AND coin = ?`)
        .run(parsed.data.balance ?? null, parsed.data.available_balance ?? null, parsed.data.equity ?? null,
          parsed.data.upnl ?? null, updatedAt, parsed.data.exchange_type, parsed.data.coin);
      if (merged.changes === 0) {
        this.database.prepare(`INSERT INTO live_balances (venue, coin, balance, available_balance, equity, unrealized_pnl, updated_at)
          VALUES (?, ?, COALESCE(?, '0'), COALESCE(?, '0'), COALESCE(?, '0'), COALESCE(?, '0'), ?)`)
          .run(parsed.data.exchange_type, parsed.data.coin, parsed.data.balance ?? null,
            parsed.data.available_balance ?? null, parsed.data.equity ?? null, parsed.data.upnl ?? null, updatedAt);
      }
      const row = this.database.prepare(`SELECT venue, coin, balance, available_balance, equity, unrealized_pnl, updated_at
        FROM live_balances WHERE venue = ? AND coin = ?`).get(parsed.data.exchange_type, parsed.data.coin) as Record<string, string>;
      this.emit({ type: 'balance.update', payload: {
        venue: row.venue, coin: row.coin, balance: row.balance, availableBalance: row.available_balance,
        equity: row.equity, unrealizedPnl: row.unrealized_pnl, updatedAt: row.updated_at,
      } satisfies LiveBalance });
      return;
    }
    if (event.channel === 'position') {
      const parsed = z.object({ position_id: z.string(), symbol: z.string(), position_side: z.string(), position_qty: z.string(),
        entry_price: z.string(), mark_price: z.string(), closed_pnl: z.string().optional(), funding_fee: z.string().optional(),
        update_time: z.string() }).passthrough().safeParse(event.payload);
      if (!parsed.success) return;
      const quantity = parsed.data.position_side === 'SHORT' ? new Decimal(parsed.data.position_qty).neg().toString() : parsed.data.position_qty;
      const updatedAt = Number.isFinite(Number(parsed.data.update_time)) ? new Date(Number(parsed.data.update_time)).toISOString() : new Date().toISOString();
      this.database.transaction(() => {
        if (parsed.data.position_side === 'NONE') {
          this.database.prepare('DELETE FROM live_positions WHERE symbol = ? AND position_id <> ?').run(parsed.data.symbol, parsed.data.position_id);
        }
        this.database.prepare(`INSERT INTO live_positions (position_id, symbol, venue, quantity, entry_price, mark_price, realized_pnl, funding_fee, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(position_id) DO UPDATE SET quantity = excluded.quantity,
          entry_price = excluded.entry_price, mark_price = excluded.mark_price, realized_pnl = excluded.realized_pnl,
          funding_fee = COALESCE(excluded.funding_fee, live_positions.funding_fee), updated_at = excluded.updated_at`)
          .run(parsed.data.position_id, parsed.data.symbol, venueFromSymbol(parsed.data.symbol), quantity, parsed.data.entry_price,
            parsed.data.mark_price, parsed.data.closed_pnl ?? '0', parsed.data.funding_fee ?? null, updatedAt);
      })();
      // Positions are already materialized in the local database, so send the new snapshot
      // immediately instead of making every browser wait and read it back one second later.
      this.emit({ type: 'execution.snapshot', payload: this.snapshot() });
    }
  }

  async createOrder(
    raw: unknown,
    metadata?: PlaceOrderMetadata,
    referencePrice?: string,
  ): Promise<ExecutionOrder> {
    return this.runAuthenticatedWrite(() => this.createOrderWithStableCredentials(raw, metadata, referencePrice));
  }

  private async createOrderWithStableCredentials(
    raw: unknown,
    metadata?: PlaceOrderMetadata,
    referencePrice?: string,
  ): Promise<ExecutionOrder> {
    const input = CreateOrderInputSchema.parse(raw);
    // Live-instrument guard: once the instrument catalog has been fetched, spot orders outside
    // the live catalog are rejected up front instead of surfacing as exchange rejections.
    // Missing catalog data fails open so tests and first-run deployments keep working.
    if (SPOT_SYMBOL_PATTERN.test(input.symbol)) {
      const catalog = readInstrumentCatalog(this.database);
      if (catalog && !catalog.items.some((item) => item.symbol === input.symbol && item.state === 'live')) {
        throw new TradingRuntimeError('unknown_market_symbol', 400);
      }
    }
    if (!this.session.liveTradingEnabled && !metadata?.riskReducing) {
      throw new TradingRuntimeError('live_trading_locked', 403);
    }
    const credentials = await this.vault.get(DEFAULT_CREDENTIAL_PROFILE);
    if (!credentials) throw new TradingRuntimeError('credential_not_configured', 409);
    const tradingGateway = this.gateway as Partial<TradingCrossExGateway>;
    if (!tradingGateway.createOrder) throw new TradingRuntimeError('live_gateway_unavailable', 503);
    // Spot symbols have no futures risk-limit tiers; the per-order leverage-tier preflight below
    // only applies to perpetual orders (strategy orders always carry metadata and skip it anyway).
    if (!metadata && referencePrice !== undefined && !input.reduceOnly && !isSpotSymbol(input.symbol)) {
      if (!referencePrice || !decimalText.safeParse(referencePrice).success
        || !tradingGateway.queryPositions || !tradingGateway.queryLeverages) {
        throw new TradingRuntimeError('order_position_limit_unavailable', 503);
      }
      let positions;
      let leverages: Record<string, string>;
      let limits: GateCrossExRiskLimit[];
      try {
        [positions, leverages, limits] = await Promise.all([
          tradingGateway.queryPositions(credentials),
          tradingGateway.queryLeverages(credentials, [input.symbol]),
          this.gateway.queryRiskLimits([input.symbol]),
        ]);
      } catch (error) {
        if (error instanceof GateApiError && error.statusCode === 429) {
          throw new TradingRuntimeError('order_position_preflight_rate_limited', 429);
        }
        throw new TradingRuntimeError('order_position_limit_unavailable', 503);
      }
      const leverage = leverages[input.symbol];
      const maxPositionValue = leverage
        ? maxRiskPositionValueAtLeverage(limits.find((limit) => limit.symbol === input.symbol), new Decimal(leverage))
        : null;
      if (!maxPositionValue) throw new TradingRuntimeError('order_position_limit_unavailable', 503);
      const existingPosition = positions.find((position) => position.symbol === input.symbol);
      const existingQuantity = (() => {
        if (!existingPosition) return new Decimal(0);
        const quantity = new Decimal(existingPosition.position_qty).abs();
        return existingPosition.position_side.toUpperCase() === 'SHORT' ? quantity.negated() : quantity;
      })();
      const plannedQuantity = new Decimal(input.quantity).mul(input.side === 'BUY' ? 1 : -1);
      const projectedPositionValue = existingQuantity.plus(plannedQuantity).abs().mul(referencePrice);
      if (projectedPositionValue.gt(maxPositionValue)) {
        throw new TradingRuntimeError('order_position_exceeds_leverage_limit', 409);
      }
    }
    const clientOrderId = `gct-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const gateInput = CrossExOrderRequestSchema.parse({ text: clientOrderId, symbol: input.symbol, side: input.side,
      type: input.type, time_in_force: input.timeInForce,
      // Gate spot market buys are sized in quote currency; every other order sizes in base qty.
      ...(input.quoteQty !== undefined ? { quote_qty: input.quoteQty } : { qty: input.quantity }),
      price: input.price,
      reduce_only: input.reduceOnly ? 'true' : 'false', position_side: input.positionSide });
    const now = new Date().toISOString();
    const id = randomUUID();
    // The local row must exist before Gate can know about the order: a private push can beat the
    // REST response, and an ambiguous submit failure must stay visible for recovery instead of
    // leaving a live exchange order with no local record.
    this.database.prepare(`INSERT INTO execution_orders (id, remote_order_id, client_order_id, environment, symbol, venue,
      side, order_type, time_in_force, quantity, price, reduce_only, state, executed_quantity, executed_average_price,
      strategy_id, strategy_leg, strategy_clip, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_SUBMIT', '0', NULL, ?, ?, ?, ?, ?)`).run(id, clientOrderId,
      'live', input.symbol, venueFromSymbol(input.symbol), input.side, input.type, input.timeInForce,
      input.quantity, input.price ?? null, input.reduceOnly ? 1 : 0, metadata?.strategyId ?? null,
      metadata?.strategyLeg ?? null, metadata?.strategyClip ?? null, now, now);
    let accepted;
    try {
      accepted = await tradingGateway.createOrder(credentials, gateInput);
    } catch (error) {
      if (isDefinitiveSubmitRejection(error)) {
        this.database.prepare("UPDATE execution_orders SET state = 'FAIL', failure_reason = ?, updated_at = ? WHERE id = ? AND state = 'PENDING_SUBMIT'")
          .run(error instanceof GateApiError ? error.label : 'ORDER_SUBMISSION_REJECTED', new Date().toISOString(), id);
      } else {
        this.scheduleSubmitResolution(id);
      }
      this.emit({ type: 'execution.update', payload: this.getOrder(id) });
      throw error;
    }
    // A racing push may have already advanced the row via client_order_id — never regress it.
    this.database.prepare(`UPDATE execution_orders SET remote_order_id = COALESCE(remote_order_id, ?),
      state = CASE WHEN state = 'PENDING_SUBMIT' THEN 'NEW' ELSE state END, updated_at = ? WHERE id = ?`)
      .run(accepted.order_id, new Date().toISOString(), id);
    this.replayUnmatchedPrivateEvents(accepted.order_id, clientOrderId);
    const order = this.getOrder(id);
    this.emit({ type: 'execution.update', payload: order });
    return order;
  }

  /**
   * Settle a PENDING_SUBMIT row whose gateway call failed without a definitive rejection: keep
   * asking the authenticated order-details endpoint (which accepts the client order id) until the
   * order shows up in some real state, or Gate confirms it never existed.
   */
  private scheduleSubmitResolution(id: string, attempt = 0): void {
    const delay = Math.min(30_000, this.submitResolvePollMs * 2 ** Math.min(attempt, 4));
    const timer = setTimeout(() => {
      void (async () => {
        let resolved = false;
        try {
          const current = this.getOrder(id);
          if (current.state !== 'PENDING_SUBMIT') return;
          const refreshed = await this.refreshOrderFromRemote(id);
          resolved = refreshed !== null && refreshed.state !== 'PENDING_SUBMIT';
        } catch (error) {
          if (isRemoteOrderMissing(error)) {
            this.database.prepare("UPDATE execution_orders SET state = 'FAIL', updated_at = ? WHERE id = ? AND state = 'PENDING_SUBMIT'")
              .run(new Date().toISOString(), id);
            const order = this.getOrder(id);
            this.emit({ type: 'execution.update', payload: order });
            this.notifyOrderListeners(order);
            return;
          }
          if (error instanceof TradingRuntimeError && error.code === 'order_not_found') return;
        }
        if (!resolved && attempt + 1 < this.submitResolveMaxAttempts) this.scheduleSubmitResolution(id, attempt + 1);
      })().catch(() => undefined);
    }, delay);
    timer.unref?.();
  }

  /** Send a cancel for a local order; `resend` repeats it for a row already marked PENDING_CANCEL. */
  async cancelOrder(id: string, resend = false): Promise<ExecutionOrder> {
    const inFlight = this.cancelRequests.get(id);
    if (inFlight) return inFlight;
    const cancellation = this.cancelOrderOnce(id, resend).finally(() => {
      if (this.cancelRequests.get(id) === cancellation) this.cancelRequests.delete(id);
    });
    this.cancelRequests.set(id, cancellation);
    return cancellation;
  }

  private async cancelOrderOnce(id: string, resend = false): Promise<ExecutionOrder> {
    const order = this.getOrder(id);
    if (isTerminalOrderState(order.state)) throw new TradingRuntimeError('order_not_cancellable', 409);
    if (order.state === 'PENDING_CANCEL' && !resend) return order;
    const credentials = await this.vault.get(DEFAULT_CREDENTIAL_PROFILE);
    if (!credentials) throw new TradingRuntimeError('credential_not_configured', 409);
    const tradingGateway = this.gateway as Partial<TradingCrossExGateway>;
    if (!tradingGateway.cancelOrder) throw new TradingRuntimeError('live_gateway_unavailable', 503);
    await tradingGateway.cancelOrder(credentials, order.remoteOrderId ?? order.clientOrderId);
    this.database.prepare(`UPDATE execution_orders SET state = 'PENDING_CANCEL', updated_at = ?
      WHERE id = ? AND state IN ('PENDING_SUBMIT', 'NEW', 'OPEN', 'PARTIALLY_FILLED')`)
      .run(new Date().toISOString(), id);
    const pending = this.getOrder(id);
    this.emit({ type: 'execution.update', payload: pending });
    this.notifyOrderListeners(pending);
    return pending;
  }

  /**
   * Cancel every locally tracked open order in scope and prove a terminal remote state. This is
   * used before resuming persisted strategies, when locking trading, and before credential
   * mutation. A caller must treat any returned order as unresolved remote exposure; each carries a
   * reason (see UnresolvedOrderReport) so the caller can say what blocked it.
   */
  async quiesceOpenOrders(options: { strategyId?: string; timeoutMs?: number } = {}): Promise<{
    resolved: ExecutionOrder[];
    unresolved: UnresolvedOrderReport[];
  }> {
    const timeoutMs = options.timeoutMs ?? 20_000;
    // Gate's open-order list is shared across the orders of one quiesce and fetched only when an
    // order needs it; an order asks for a fresh copy after it has sent another cancel.
    let listing: Promise<Map<string, string> | null> | null = null;
    const remoteOpenOrders = (fresh = false) => {
      if (fresh || listing === null) listing = this.remoteOpenOrders();
      return listing;
    };
    const results = await Promise.all(this.listOpenOrders(options.strategyId)
      .map((initial) => this.quiesceOrder(initial, timeoutMs, remoteOpenOrders)));
    const resolved: ExecutionOrder[] = [];
    const unresolved: UnresolvedOrderReport[] = [];
    for (const result of results) {
      if ('resolved' in result) resolved.push(result.resolved);
      else unresolved.push(result.unresolved);
    }
    return { resolved, unresolved };
  }

  /**
   * Settle one open order: look it up, cancel it if still open, confirm it terminal. Gate is the
   * only place these orders can be cancelled, so when it will not act on the identifier we hold
   * (a definitive 4xx, an unparseable body, or "no such order") its open-order list becomes the
   * fallback authority: an order absent from that list is closed locally as REMOTE_NOT_FOUND, and
   * an order the list knows under another id is adopted and cancelled by that id. Transient
   * failures never count as evidence, and a successful lookup that still reports the order open
   * wins over the list unless Gate itself said the order does not exist.
   */
  private async quiesceOrder(
    initial: ExecutionOrder,
    timeoutMs: number,
    remoteOpenOrders: (fresh?: boolean) => Promise<Map<string, string> | null>,
  ): Promise<{ resolved: ExecutionOrder } | { unresolved: UnresolvedOrderReport }> {
    const problems: string[] = [];
    const note = (problem: string) => { if (!problems.includes(problem)) problems.push(problem); };
    const unresolved = () => ({ unresolved: { order: this.getOrder(initial.id), reason: problems.join('; ') || 'cancel_not_confirmed' } });
    let remoteState: string | null = null;
    let lookupRefused = false;
    let remoteMissing = false;
    const lookup = async (id: string): Promise<ExecutionOrder | null> => {
      try {
        const refreshed = await this.refreshOrderFromRemote(id);
        if (refreshed) remoteState = refreshed.state;
        return refreshed;
      } catch (error) {
        if (isRemoteOrderMissing(error)) remoteMissing = true;
        else if (isDefinitiveGateRefusal(error)) lookupRefused = true;
        note(`lookup_failed:${describeQuiesceFailure(error)}`);
        return null;
      }
    };
    const cancel = async (id: string, resend = false): Promise<'accepted' | 'refused' | 'failed'> => {
      try {
        await this.cancelOrder(id, resend);
        return 'accepted';
      } catch (error) {
        // A push may have settled the order between the lookup and the cancel; that is not a failure.
        if (error instanceof TradingRuntimeError && error.code === 'order_not_cancellable') return 'accepted';
        if (isRemoteOrderMissing(error)) remoteMissing = true;
        note(`cancel_failed:${describeQuiesceFailure(error)}`);
        return isDefinitiveGateRefusal(error) ? 'refused' : 'failed';
      }
    };
    const awaitCancellation = async (id: string) => {
      const settled = await this.awaitTerminalOrder(id, timeoutMs);
      if (isTerminalOrderState(settled.state)) return { resolved: settled };
      note(`cancel_not_confirmed:${settled.state}`);
      return unresolved();
    };

    let current = await lookup(initial.id) ?? this.getOrder(initial.id);
    if (isTerminalOrderState(current.state)) return { resolved: current };

    let cancelOutcome: 'accepted' | 'refused' | 'failed' | 'skipped' = 'skipped';
    if (!remoteMissing) {
      if (current.state !== 'PENDING_CANCEL') {
        cancelOutcome = await cancel(current.id);
        current = this.getOrder(current.id);
        if (isTerminalOrderState(current.state)) return { resolved: current };
      }
      const confirmed = await lookup(current.id);
      if (confirmed && isTerminalOrderState(confirmed.state)) return { resolved: confirmed };
      // Gate can still describe the order and took the cancel, so a push or poll may settle it.
      if (!lookupRefused && !remoteMissing && cancelOutcome !== 'refused') return awaitCancellation(current.id);
      // Gate describes the order as open and refused the cancel for a reason other than "no such
      // order": the list cannot override a live description.
      if (remoteState !== null && !remoteMissing) return unresolved();
    }

    const listed = await remoteOpenOrders();
    if (listed === null) {
      // Without the list, "no such order" keeps its plain meaning; anything else stays unresolved.
      if (remoteMissing && remoteState === null) return { resolved: this.markOrderRemoteMissing(current.id) };
      note('open_orders_unavailable');
      return unresolved();
    }
    const listedId = listedOrderId(listed, current);
    if (listedId === null) return { resolved: this.markOrderRemoteMissing(current.id) };

    // Gate lists the order open, possibly under an id we never received (an ambiguous submit) or
    // one that differs from ours. Cancel it by the id Gate uses.
    if (listedId !== current.remoteOrderId) current = this.adoptRemoteOrderId(current.id, listedId);
    remoteState = null;
    lookupRefused = false;
    remoteMissing = false;
    const retried = await cancel(current.id, true);
    current = this.getOrder(current.id);
    if (isTerminalOrderState(current.state)) return { resolved: current };
    const confirmedAgain = await lookup(current.id);
    if (confirmedAgain && isTerminalOrderState(confirmedAgain.state)) return { resolved: confirmedAgain };
    if (retried === 'accepted' && !lookupRefused && !remoteMissing) return awaitCancellation(current.id);
    const relisted = await remoteOpenOrders(true);
    if (relisted !== null && listedOrderId(relisted, current) === null) return { resolved: this.markOrderRemoteMissing(current.id) };
    note('listed_open_on_gate');
    return unresolved();
  }

  /** Every id Gate lists as open (remote, text, client) mapped to its order_id, or null when unavailable. */
  private async remoteOpenOrders(): Promise<Map<string, string> | null> {
    const credentials = await this.vault.get(DEFAULT_CREDENTIAL_PROFILE);
    const tradingGateway = this.gateway as Partial<TradingCrossExGateway>;
    if (!credentials || !tradingGateway.queryOpenOrders) return null;
    try {
      const ids = new Map<string, string>();
      for (const order of await tradingGateway.queryOpenOrders(credentials)) {
        ids.set(order.order_id, order.order_id);
        if (order.text) ids.set(order.text, order.order_id);
        if (order.client_order_id) ids.set(order.client_order_id, order.order_id);
      }
      return ids;
    } catch {
      return null;
    }
  }

  /** Record the id Gate uses for an order we held under another, or no, remote id. */
  private adoptRemoteOrderId(id: string, remoteOrderId: string): ExecutionOrder {
    this.database.prepare('UPDATE execution_orders SET remote_order_id = ?, updated_at = ? WHERE id = ?')
      .run(remoteOrderId, new Date().toISOString(), id);
    const order = this.getOrder(id);
    this.emit({ type: 'execution.update', payload: order });
    this.notifyOrderListeners(order);
    return order;
  }

  clearAuthenticatedAccountState(): void {
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM live_balances').run();
      this.database.prepare('DELETE FROM live_positions').run();
      this.database.prepare('DELETE FROM portfolio_snapshots').run();
      this.database.prepare('DELETE FROM reconciliation_reports').run();
    })();
    this.emit({ type: 'execution.snapshot', payload: this.snapshot() });
  }

  private markOrderRemoteMissing(id: string): ExecutionOrder {
    this.database.prepare(`UPDATE execution_orders SET state = 'REMOTE_NOT_FOUND', updated_at = ?
      WHERE id = ? AND state IN ('PENDING_SUBMIT', 'PENDING_CANCEL', 'NEW', 'OPEN', 'PARTIALLY_FILLED')`)
      .run(new Date().toISOString(), id);
    const order = this.getOrder(id);
    this.emit({ type: 'execution.update', payload: order });
    this.notifyOrderListeners(order);
    return order;
  }

  /** Refresh a local order row from the authenticated remote order-details endpoint. */
  async refreshOrderFromRemote(id: string): Promise<ExecutionOrder | null> {
    const inFlight = this.remoteRefreshes.get(id);
    if (inFlight) return inFlight;
    const refresh = this.refreshOrderFromRemoteOnce(id).finally(() => {
      if (this.remoteRefreshes.get(id) === refresh) this.remoteRefreshes.delete(id);
    });
    this.remoteRefreshes.set(id, refresh);
    return refresh;
  }

  private async refreshOrderFromRemoteOnce(id: string): Promise<ExecutionOrder | null> {
    const order = this.getOrder(id);
    // A private terminal push may omit Gate's rejection payload. Fetch terminal FAIL orders once
    // more so callers can make a reason-aware recovery decision instead of retrying blindly.
    if (isTerminalOrderState(order.state) && (order.state !== 'FAIL' || order.failureReason)) return order;
    const credentials = await this.vault.get(DEFAULT_CREDENTIAL_PROFILE);
    const tradingGateway = this.gateway as Partial<TradingCrossExGateway>;
    if (!credentials || !tradingGateway.queryOrder) return null;
    const remote = await tradingGateway.queryOrder(credentials, order.remoteOrderId ?? order.clientOrderId);
    const current = this.getOrder(id);
    if (isTerminalOrderState(current.state) && !isTerminalOrderState(remote.state)) return current;
    const updatedAt = Number.isFinite(Number(remote.update_time)) ? new Date(Number(remote.update_time)).toISOString() : new Date().toISOString();
    this.database.prepare(`UPDATE execution_orders SET state = ?, executed_quantity = ?, executed_average_price = ?,
      failure_reason = COALESCE(NULLIF(?, ''), failure_reason), remote_order_id = COALESCE(remote_order_id, ?),
      updated_at = ? WHERE id = ?`)
      .run(remote.state, remote.executed_qty, remote.executed_avg_price, remote.reason, remote.order_id, updatedAt, id);
    const refreshed = this.getOrder(id);
    this.emit({ type: 'execution.update', payload: refreshed });
    this.notifyOrderListeners(refreshed);
    return refreshed;
  }

  /**
   * Resolve when the order reaches a terminal state, using private-stream pushes first and the
   * authenticated order-details endpoint as a fallback. Resolves with the latest known order at the
   * deadline; callers decide how to treat a still-open order.
   */
  async awaitTerminalOrder(id: string, timeoutMs: number, pollIntervalMs = 2_500): Promise<ExecutionOrder> {
    const initial = this.getOrder(id);
    if (isTerminalOrderState(initial.state)) {
      if (initial.state !== 'FAIL' || initial.failureReason) return initial;
      return await this.refreshOrderFromRemote(id).catch(() => null) ?? initial;
    }
    return new Promise((resolve) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      const deadline = Date.now() + timeoutMs;
      const finish = (order: ExecutionOrder) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (pollTimer) clearTimeout(pollTimer);
        if (order.state === 'FAIL' && !order.failureReason) {
          void this.refreshOrderFromRemote(id).catch(() => null).then((refreshed) => resolve(refreshed ?? order));
        } else {
          resolve(order);
        }
      };
      const unsubscribe = this.onOrderUpdate((order) => {
        if (order.id === id && isTerminalOrderState(order.state)) finish(order);
      });
      const poll = async () => {
        if (settled) return;
        try {
          const refreshed = await this.refreshOrderFromRemote(id);
          if (refreshed && isTerminalOrderState(refreshed.state)) {
            finish(refreshed);
            return;
          }
        } catch { /* Keep waiting; the next poll or push may still resolve the order. */ }
        if (Date.now() >= deadline) {
          finish(this.getOrder(id));
          return;
        }
        pollTimer = setTimeout(() => void poll(), pollIntervalMs);
      };
      pollTimer = setTimeout(() => void poll(), Math.min(pollIntervalMs, Math.max(50, timeoutMs)));
    });
  }

  getOrder(id: string): ExecutionOrder {
    const row = this.statement("SELECT * FROM execution_orders WHERE id = ? AND environment = 'live'").get(id) as OrderRow | undefined;
    if (!row) throw new TradingRuntimeError('order_not_found', 404);
    return orderFromRow(row);
  }

  getStrategy(id: string): StrategyRecord {
    const row = this.statement("SELECT * FROM execution_strategies WHERE id = ? AND environment = 'live'").get(id) as StrategyRow | undefined;
    if (!row) throw new TradingRuntimeError('strategy_not_found', 404);
    return this.withStrategyMetrics(strategyFromRow(row));
  }

  /**
   * Spot account balances for carry entry gating: quote coverage for the buy-and-hold leg and
   * base inventory for the sell-inventory leg. Returns null when the configured gateway cannot
   * serve spot accounts, so callers can degrade to "unavailable" instead of guessing coverage.
   */
  async querySpotAccounts(exchangeType?: string): Promise<GateSpotAccount[] | null> {
    const credentials = await this.vault.get(DEFAULT_CREDENTIAL_PROFILE);
    if (!credentials) throw new TradingRuntimeError('credential_not_configured', 409);
    const operations = this.gateway as Partial<PortfolioOperationsCrossExGateway>;
    if (!operations.querySpotAccounts) return null;
    try {
      return await operations.querySpotAccounts(credentials, exchangeType);
    } catch (error) {
      if (error instanceof GateApiError && error.statusCode === 429) {
        throw new TradingRuntimeError('strategy_preflight_rate_limited', 429);
      }
      throw new TradingRuntimeError('strategy_inventory_check_unavailable', 503);
    }
  }

  /** Persist the carry accounting snapshot that is surfaced on the strategy record. */
  updateStrategyMetrics(id: string, metrics: StrategyCarryMetrics): void {
    this.database.prepare('UPDATE execution_strategies SET metrics_json = ? WHERE id = ?')
      .run(JSON.stringify(metrics), id);
  }

  private withStrategyMetrics(strategy: StrategyRecord): StrategyRecord {
    const realizedPnl = this.strategyRealizedPnl(strategy.id).get(strategy.id) ?? new Decimal(0);
    let pnl: StrategyPnl | null = null;
    try {
      const ownFillRows = this.strategyFillRows(strategy.id);
      const marks = this.pnlMarks();
      // Ownership is a global property of the (venue, symbol) pair, so the bulky fill rows are
      // still needed here even though only one strategy's own fills are being priced.
      const owners = this.positionPairOwners(this.strategyFillRows());
      const livePositions = this.livePositionFundingRows();
      pnl = this.computePnlFor(strategy, ownFillRows, marks, owners, livePositions);
    } catch {
      pnl = null;
    }
    return { ...strategy, realizedPnl: realizedPnl.toString(), pnl };
  }

  /**
   * Every strategy-linked fill, chronologically, for the PnL rebuild. Passing a strategy id narrows
   * it to that strategy; omitting it returns the bulk set used by the list view (and by the
   * funding-exclusivity test, which is inherently cross-strategy).
   */
  private strategyFillRows(strategyId?: string): StrategyFillRow[] {
    const columns = `SELECT strategy_order.strategy_id, fill.symbol, fill.venue, fill.side,
        fill.quantity, fill.price, fill.fee, fill.created_at
      FROM execution_fills AS fill
      JOIN execution_orders AS strategy_order ON strategy_order.id = fill.order_id`;
    return (strategyId
      ? this.statement(`${columns} WHERE strategy_order.strategy_id = ?
          ORDER BY fill.created_at ASC, fill.rowid ASC`).all(strategyId)
      : this.statement(`${columns} WHERE strategy_order.strategy_id IS NOT NULL
          ORDER BY fill.created_at ASC, fill.rowid ASC`).all()) as StrategyFillRow[];
  }

  /**
   * Latest mark price per symbol, built ONCE and shared by every strategy in a list call. The
   * public snapshot table is the primary source (it has a row for both spot and perpetual
   * symbols); a still-missing symbol falls back to the live position's own mark.
   */
  private pnlMarks(): Map<string, string> {
    const marks = new Map<string, string>();
    const snapshots = this.statement(
      'SELECT symbol, mark_price, last_price FROM public_market_snapshots',
    ).all() as Array<{ symbol: string; mark_price: string | null; last_price: string | null }>;
    for (const row of snapshots) {
      const mark = positiveMarkOrNull(row.mark_price) ?? positiveMarkOrNull(row.last_price);
      if (mark !== null) marks.set(row.symbol, mark);
    }
    const positions = this.statement(
      'SELECT symbol, mark_price FROM live_positions',
    ).all() as Array<{ symbol: string; mark_price: string | null }>;
    for (const row of positions) {
      if (marks.has(row.symbol)) continue;
      const mark = positiveMarkOrNull(row.mark_price);
      if (mark !== null) marks.set(row.symbol, mark);
    }
    return marks;
  }

  /** Strategies touching each `(venue, symbol)` pair, derived from the bulk fill rows. */
  private positionPairOwners(fillRows: StrategyFillRow[]): Map<string, Set<string>> {
    const owners = new Map<string, Set<string>>();
    for (const row of fillRows) {
      const key = positionPairKey(row.venue, row.symbol);
      const ids = owners.get(key) ?? new Set<string>();
      ids.add(row.strategy_id);
      owners.set(key, ids);
    }
    return owners;
  }

  private livePositionFundingRows(): Array<{ symbol: string; venue: string; funding_fee: string | null }> {
    return this.statement(
      'SELECT symbol, venue, funding_fee FROM live_positions',
    ).all() as Array<{ symbol: string; venue: string; funding_fee: string | null }>;
  }

  /**
   * Funding charge attributable to one strategy.
   *
   * - A carry strategy keeps an authoritative collected figure in its metrics snapshot, so that is
   *   used directly (collected funding is a negative cost).
   * - Every other kind falls back to `live_positions.funding_fee`. A position row is a *venue
   *   account* position, not a per-strategy one, so its funding charge is only attributed when this
   *   strategy is the SOLE strategy trading that `(venue, symbol)` pair. When two strategies share
   *   a pair the charge cannot be split, and when no usable row exists at all, the field is reported
   *   as `null` ("unavailable") rather than a misleading partial sum.
   */
  private strategyFundingFee(
    strategy: Pick<StrategyRecord, 'id' | 'kind' | 'carryMetrics'>,
    ownFillRows: StrategyFillRow[],
    owners: Map<string, Set<string>>,
    livePositions: Array<{ symbol: string; venue: string; funding_fee: string | null }>,
  ): string | null {
    if (strategy.kind === 'carry' && strategy.carryMetrics) {
      return new Decimal(strategy.carryMetrics.fundingCollectedUsdt).neg().toString();
    }
    const pairs = new Set(ownFillRows.map((row) => positionPairKey(row.venue, row.symbol)));
    let total = new Decimal(0);
    let attributed = false;
    for (const position of livePositions) {
      const key = positionPairKey(position.venue, position.symbol);
      if (!pairs.has(key) || position.funding_fee === null) continue;
      const ids = owners.get(key);
      if (!ids || ids.size !== 1 || !ids.has(strategy.id)) continue;
      total = total.plus(new Decimal(position.funding_fee));
      attributed = true;
    }
    return attributed ? total.toString() : null;
  }

  /** Assemble the pure-function input for one strategy from the shared context. */
  private computePnlFor(
    strategy: Pick<StrategyRecord, 'id' | 'kind' | 'carryMetrics'>,
    ownFillRows: StrategyFillRow[],
    marks: Map<string, string>,
    owners: Map<string, Set<string>>,
    livePositions: Array<{ symbol: string; venue: string; funding_fee: string | null }>,
  ): StrategyPnl {
    const fills: StrategyFillInput[] = ownFillRows.map((row) => ({
      symbol: row.symbol, venue: row.venue, side: row.side,
      quantity: row.quantity, price: row.price, fee: row.fee, createdAt: row.created_at,
    }));
    return computeStrategyPnl({
      fills,
      marks,
      fundingFeeUsdt: this.strategyFundingFee(strategy, ownFillRows, owners, livePositions),
    });
  }

  /**
   * Read every strategy-linked fill in one query for listStrategies. Keeping the summation in
   * Decimal avoids the precision loss of SQLite's floating-point SUM while removing the previous
   * one-query-per-strategy pattern.
   */
  private strategyRealizedPnl(strategyId?: string): Map<string, Decimal> {
    const pnlRows = strategyId
      ? this.database.prepare(`SELECT strategy_order.strategy_id, fill.realized_pnl
          FROM execution_fills AS fill
          JOIN execution_orders AS strategy_order ON strategy_order.id = fill.order_id
          WHERE strategy_order.strategy_id = ?`).all(strategyId)
      : this.database.prepare(`SELECT strategy_order.strategy_id, fill.realized_pnl
      FROM execution_fills AS fill
      JOIN execution_orders AS strategy_order ON strategy_order.id = fill.order_id
      WHERE strategy_order.strategy_id IS NOT NULL`).all();
    const totals = new Map<string, Decimal>();
    for (const row of pnlRows as Array<{ strategy_id: string; realized_pnl: string }>) {
      totals.set(
        row.strategy_id,
        (totals.get(row.strategy_id) ?? new Decimal(0)).plus(new Decimal(row.realized_pnl || '0')),
      );
    }
    return totals;
  }

  emitStrategyUpdate(strategy: StrategyRecord): void {
    this.emit({ type: 'strategy.update', payload: strategy });
  }

  addStrategyLog(strategyId: string, level: string, event: string, condition: string, quantity: string, result: string): void {
    this.database.prepare(`INSERT INTO execution_strategy_logs (id, strategy_id, level, event, condition_text, quantity, result_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), strategyId, level, event, condition, quantity, result, new Date().toISOString());
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* a broken listener must not break order/fill processing */ }
    }
  }

  private notifyOrderListeners(order: ExecutionOrder): void {
    for (const listener of this.orderListeners) {
      try { listener(order); } catch { /* isolated */ }
    }
  }

  private notifyFillListeners(fill: RecordedFill): void {
    for (const listener of this.fillListeners) {
      try { listener(fill); } catch { /* isolated */ }
    }
  }
}

export class TradingRuntimeError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly label?: string,
    /** Structured context for the HTTP payload, e.g. the orders that blocked a mode change. */
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'TradingRuntimeError';
  }
}

export interface UnresolvedOrderReport {
  order: ExecutionOrder;
  /**
   * Machine-readable, `;`-separated tokens: `lookup_failed:<label>`, `cancel_failed:<label>`,
   * `cancel_not_confirmed:<remote state>`, `listed_open_on_gate`, `open_orders_unavailable`.
   */
  reason: string;
}

/** Shape an unresolved quiesce result for API responses and audit payloads. */
export function unresolvedOrderDetails(unresolved: UnresolvedOrderReport[]): UnresolvedOrder[] {
  return unresolved.map(({ order, reason }) => ({
    id: order.id, remoteOrderId: order.remoteOrderId, clientOrderId: order.clientOrderId, symbol: order.symbol,
    venue: order.venue, side: order.side, quantity: order.quantity, executedQuantity: order.executedQuantity,
    price: order.price, state: order.state, strategyId: order.strategyId, reason,
  }));
}

/** Gate's own label for an order id it does not know; the HTTP status varies by endpoint. */
const REMOTE_ORDER_MISSING_LABEL = 'TRADE_ORDER_NOT_FOUND_ERROR';

function isRemoteOrderMissing(error: unknown): boolean {
  return error instanceof GateApiError && (error.statusCode === 404 || error.label === REMOTE_ORDER_MISSING_LABEL);
}

/** The order_id Gate lists for a local order, matched by our remote id first and then by client id. */
function listedOrderId(listed: Map<string, string>, order: ExecutionOrder): string | null {
  return (order.remoteOrderId !== null ? listed.get(order.remoteOrderId) : undefined) ?? listed.get(order.clientOrderId) ?? null;
}

/**
 * Gate answered and will not act on this order id: a non-retryable 4xx, a 2xx whose body failed
 * validation, or an id the client refuses to send. Network failures, 5xx, and rate limits are
 * transient and prove nothing about the order.
 */
function isDefinitiveGateRefusal(error: unknown): boolean {
  if (!(error instanceof GateApiError)) return false;
  if (error.label === 'INVALID_ORDER_ID') return true;
  if (error.statusCode === 429) return false;
  return (error.statusCode >= 200 && error.statusCode < 300) || (error.statusCode >= 400 && error.statusCode < 500);
}

function describeQuiesceFailure(error: unknown): string {
  if (error instanceof GateApiError) return error.label;
  if (error instanceof TradingRuntimeError) return error.code;
  return error instanceof Error ? error.message.slice(0, 80) : 'unknown_error';
}
