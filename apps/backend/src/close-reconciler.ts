import { Decimal } from 'decimal.js';
import {
  type CloseLegPlan,
  type CloseMarketType,
  type ClosePlanRequest,
  type ClosePlanResponse,
  type CloseSkipReason,
  type CloseTargetInput,
  type CrossExInstrument,
  type PortfolioFuturesPosition,
  type ResidualLeg,
  type ResidualReport,
} from '@gate-crossex/shared-types';

const ZERO = new Decimal(0);
/** Tolerance for "quantity is zero" comparisons on decimal venue amounts. */
const QUANTITY_EPSILON = new Decimal('1e-12');

/**
 * One live venue balance row the reconciler plans spot legs against. `venue` uses the portfolio
 * snapshot's venue codes: `SPOT` for the legacy isolated Gate spot account, otherwise the
 * exchange id the CrossEx account reports.
 */
export interface CloseBalanceRow {
  venue: string;
  coin: string;
  balance: string;
  availableBalance: string;
}

/**
 * Everything {@link CloseReconciler} needs from the outside. The two reads are the same
 * venue-truth channels the rest of the terminal already trusts: positions come from
 * `TradingRuntime.reconcilePositionsFromRemote` (single-flight, refreshes the live ledger),
 * balances from a fresh authenticated portfolio snapshot (which the trade/asset pages share).
 */
export interface CloseReconcilerDependencies {
  reconcilePositions: () => Promise<readonly PortfolioFuturesPosition[]>;
  readBalances: () => Promise<readonly CloseBalanceRow[]>;
  /** Cached CrossEx instrument catalog keyed by executable symbol (lot/min constraints). */
  instruments: () => ReadonlyMap<string, CrossExInstrument>;
  /** Best current price for a symbol (min-notional checks); null when no live quote exists. */
  referencePrice?: (symbol: string) => number | null;
  now?: () => number;
}

const CROSSEX_SPOT_SYMBOL = /^([A-Z0-9]+)_SPOT_([A-Z0-9]+)_([A-Z0-9]+)$/;
const CROSSEX_FUTURE_SYMBOL = /^([A-Z0-9]+)_FUTURE_[A-Z0-9]+_[A-Z0-9]+$/;

/** Market type a close target acts on, or null when the symbol is neither spot nor perp. */
export function closeMarketTypeOf(symbol: string): CloseMarketType | null {
  if (CROSSEX_SPOT_SYMBOL.test(symbol)) return 'SPOT';
  if (CROSSEX_FUTURE_SYMBOL.test(symbol)) return 'PERP';
  return null;
}

/** Venue prefix of an executable close symbol (the segment before `_SPOT_` / `_FUTURE_`). */
export function closeVenueOf(symbol: string): string {
  const separator = symbol.indexOf('_SPOT_') !== -1 ? '_SPOT_' : '_FUTURE_';
  return symbol.slice(0, symbol.indexOf(separator));
}

/** Base asset of a spot close symbol (`GATE_SPOT_BTC_USDT` → `BTC`). */
export function closeBaseAssetOf(symbol: string): string {
  return CROSSEX_SPOT_SYMBOL.exec(symbol)?.[2] ?? '';
}

/**
 * The legacy isolated Gate spot account reports venue `SPOT` while its symbols carry the `GATE`
 * prefix (spot-close.ts convention); every other venue code already matches. Both spellings
 * therefore map to the same balance rows.
 */
function balanceVenueTokens(symbolVenue: string): ReadonlySet<string> {
  return symbolVenue === 'GATE' ? new Set(['GATE', 'SPOT']) : new Set([symbolVenue]);
}

/** Decimal places implied by a lot-size / amount text, used for exponent-free quantity text. */
function decimalPlacesOf(text: string | null): number {
  if (!text) return 0;
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.max(0, text.length - dot - 1);
}

function quantityText(value: Decimal, stepText: string | null): string {
  const places = Math.max(decimalPlacesOf(stepText), decimalPlacesOf(value.toString()));
  const fixed = value.toFixed(places, Decimal.ROUND_DOWN);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/**
 * Server-side close reconciliation (R2/R3).
 *
 * `planClose` answers "how much of each requested symbol can actually be closed right now"
 * from the venue's real balances/positions — never from the frontend's local snapshots — and
 * floors spot legs to the instrument's lot size. A residual smaller than the market's minimum
 * order unit is reported with `skipReason: 'dust'` and is never auto-liquidated (PRD Q2); the
 * caller shows it to the user instead. Quantities of `'0'` with a skip reason mean "nothing
 * orderable on this leg".
 *
 * `verifyClose` re-reads the venue after a close attempt and reports every leg still holding
 * more than the minimum order unit, with a reason and a suggested remedy, so the UI can surface
 * residuals instead of leaving silent liabilities.
 */
export class CloseReconciler {
  private readonly now: () => number;

  constructor(private readonly deps: CloseReconcilerDependencies) {
    this.now = deps.now ?? Date.now;
  }

  /** Server-reconciled close plan: one leg per target, venue-truth quantities. */
  async planClose(request: ClosePlanRequest): Promise<ClosePlanResponse> {
    const context = await this.readVenueTruth(request.targets);
    const legs = request.targets.map((target) => this.planLeg(target, context));
    return { legs, fetchedAt: new Date(this.now()).toISOString() };
  }

  /** Post-close reconciliation: residuals above the minimum order unit, with reasons. */
  async verifyClose(request: ClosePlanRequest): Promise<ResidualReport> {
    const context = await this.readVenueTruth(request.targets);
    const residuals = request.targets
      .map((target) => this.residualLeg(target, context))
      .filter((leg): leg is ResidualLeg => leg !== null);
    return {
      residuals,
      clean: residuals.length === 0,
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Venue reads needed for one request — positions only when a perp leg is requested. */
  private async readVenueTruth(targets: readonly CloseTargetInput[]): Promise<{
    positions: readonly PortfolioFuturesPosition[];
    balances: readonly CloseBalanceRow[];
  }> {
    const needsPositions = targets.some((target) => closeMarketTypeOf(target.symbol) === 'PERP');
    const needsBalances = targets.some((target) => closeMarketTypeOf(target.symbol) === 'SPOT');
    const [positions, balances] = await Promise.all([
      needsPositions ? this.deps.reconcilePositions() : Promise.resolve([]),
      needsBalances ? this.deps.readBalances() : Promise.resolve([]),
    ]);
    return { positions, balances };
  }

  /** Plan one leg against the venue truth, applying lot/min constraints. */
  private planLeg(
    target: CloseTargetInput,
    context: { positions: readonly PortfolioFuturesPosition[]; balances: readonly CloseBalanceRow[] },
  ): CloseLegPlan {
    const marketType = closeMarketTypeOf(target.symbol);
    const venue = closeVenueOf(target.symbol);
    const instrument = this.deps.instruments().get(target.symbol) ?? null;
    if (marketType === null) {
      return {
        symbol: target.symbol, venue, marketType: 'SPOT', side: 'SELL', quantity: '0',
        positionSide: target.positionSide ?? null, skipReason: 'no_market',
      };
    }
    const raw = marketType === 'PERP'
      ? this.perpReducible(context.positions, target.symbol)
      : this.spotReducible(context.balances, target.symbol, closeBaseAssetOf(target.symbol));
    const base = {
      symbol: target.symbol,
      venue,
      marketType,
      positionSide: target.positionSide ?? null,
    };
    if (raw === null || raw.value.lte(QUANTITY_EPSILON)) {
      return { ...base, side: raw?.side ?? 'SELL', quantity: '0', skipReason: raw?.skipReason ?? 'no_balance' };
    }
    // Floor to the instrument's lot size; a positive residual that floors to nothing — or sits
    // under the minimum order size/notional — is dust and is never auto-liquidated (PRD Q2).
    const lotText = instrument?.lotSize ?? null;
    const floored = roundDownToStep(raw.value, lotText);
    if (!floored.gt(QUANTITY_EPSILON)) return { ...base, side: raw.side, quantity: '0', skipReason: 'dust' };
    const minSize = parsePositive(instrument?.minSize);
    if (minSize !== null && floored.lt(minSize)) return { ...base, side: raw.side, quantity: '0', skipReason: 'dust' };
    const minNotional = parsePositive(instrument?.minNotional ?? null);
    const price = this.deps.referencePrice?.(target.symbol) ?? null;
    if (minNotional !== null && price !== null && price > 0 && floored.mul(price).lt(minNotional)) {
      return { ...base, side: raw.side, quantity: '0', skipReason: 'dust' };
    }
    return { ...base, side: raw.side, quantity: quantityText(floored, lotText) };
  }

  /**
   * Residual exposure of one leg after a close attempt, or null when the leg is flat or below
   * the minimum order unit. The residual is the venue's full exposure — for a spot leg the
   * signed net balance (locked coins included, a liability by magnitude) — so locked funds
   * are still surfaced instead of silently passing verification.
   */
  private residualLeg(
    target: CloseTargetInput,
    context: { positions: readonly PortfolioFuturesPosition[]; balances: readonly CloseBalanceRow[] },
  ): ResidualLeg | null {
    const marketType = closeMarketTypeOf(target.symbol);
    if (marketType === null) return null;
    const venue = closeVenueOf(target.symbol);
    const instrument = this.deps.instruments().get(target.symbol) ?? null;
    // "Minimum order unit" = minSize when the catalog knows the market, else the lot size,
    // else a bare epsilon: a venue without catalog constraints cannot be judged dusty.
    const threshold = parsePositive(instrument?.minSize) ?? parsePositive(instrument?.lotSize ?? null) ?? QUANTITY_EPSILON;
    let residual: Decimal;
    let reason: string;
    let suggestion: string;
    if (marketType === 'PERP') {
      residual = this.perpReducible(context.positions, target.symbol)?.value ?? ZERO;
      reason = 'The venue still holds a position larger than the minimum order unit after the close.';
      suggestion = 'Retry the close; if it persists, reduce the position manually on the exchange.';
    } else {
      // The residual is the venue's full spot exposure — the signed total balance, not just
      // the unlocked part — so a locked (or negative/liability) balance is still surfaced.
      const { total } = this.spotBalanceTotals(context.balances, target.symbol, closeBaseAssetOf(target.symbol));
      residual = total.abs();
      reason = 'The spot account still holds more than the minimum order unit after the close.';
      suggestion = 'Retry the close, then settle any remaining dust manually on the exchange.';
    }
    if (residual.lte(QUANTITY_EPSILON)) return null;
    if (residual.lte(threshold)) return null;
    return {
      symbol: target.symbol,
      venue,
      marketType,
      residualQuantity: quantityText(residual, instrument?.lotSize ?? null),
      reason,
      suggestion,
    };
  }

  /** Reducible perpetual quantity: SELL closes longs, BUY closes shorts; null when absent. */
  private perpReducible(
    positions: readonly PortfolioFuturesPosition[],
    symbol: string,
  ): { side: 'BUY' | 'SELL'; value: Decimal; skipReason: CloseSkipReason } | null {
    let long = ZERO;
    let short = ZERO;
    for (const position of positions) {
      if (position.symbol !== symbol) continue;
      const quantity = new Decimal(position.quantity || '0');
      if (!quantity.isFinite()) continue;
      const positionSide = position.positionSide.toUpperCase();
      const signed = positionSide === 'SHORT' ? quantity.abs().negated()
        : positionSide === 'LONG' ? quantity.abs()
          : quantity;
      if (signed.gt(0)) long = long.plus(signed);
      else if (signed.lt(0)) short = short.plus(signed.abs());
    }
    if (long.gt(QUANTITY_EPSILON)) return { side: 'SELL', value: long, skipReason: 'no_balance' };
    if (short.gt(QUANTITY_EPSILON)) return { side: 'BUY', value: short, skipReason: 'no_balance' };
    return { side: 'SELL', value: ZERO, skipReason: 'no_balance' };
  }

  /**
   * Reducible spot quantity (spot-close.ts semantics): a long sells its **available** balance
   * (locked coins are committed to resting orders); a short buys back the whole liability.
   * `locked_balance` reports a long whose entire balance is locked.
   */
  private spotReducible(
    balances: readonly CloseBalanceRow[],
    symbol: string,
    baseAsset: string,
  ): { side: 'BUY' | 'SELL'; value: Decimal; skipReason: CloseSkipReason } | null {
    const { total, available } = this.spotBalanceTotals(balances, symbol, baseAsset);
    if (total.gt(QUANTITY_EPSILON)) {
      if (available.gt(QUANTITY_EPSILON)) return { side: 'SELL', value: available, skipReason: 'no_balance' };
      return { side: 'SELL', value: ZERO, skipReason: 'locked_balance' };
    }
    if (total.lt(QUANTITY_EPSILON.neg())) {
      return { side: 'BUY', value: total.abs(), skipReason: 'no_balance' };
    }
    return { side: 'SELL', value: ZERO, skipReason: 'no_balance' };
  }

  /**
   * Signed net balance of the venue rows matching a spot close symbol's base asset. The total
   * is signed (a spot liability reports negative); the available amount is the unlocked part.
   */
  private spotBalanceTotals(
    balances: readonly CloseBalanceRow[],
    symbol: string,
    baseAsset: string,
  ): { total: Decimal; available: Decimal } {
    const symbolVenue = closeVenueOf(symbol);
    const venues = balanceVenueTokens(symbolVenue);
    let total = ZERO;
    let available = ZERO;
    for (const row of balances) {
      if (!venues.has(row.venue.toUpperCase()) || row.coin.toUpperCase() !== baseAsset.toUpperCase()) continue;
      // The balance itself is signed (a spot liability reports a negative total); the
      // available amount is only ever a non-negative counter of unlocked coins.
      const rowTotal = parseSigned(row.balance);
      const rowAvailable = parsePositive(row.availableBalance);
      if (rowTotal !== null) total = total.plus(rowTotal);
      if (rowAvailable !== null) available = available.plus(rowAvailable);
    }
    return { total, available };
  }
}

/** Floor a quantity to the instrument's lot step (identity when the step is unknown/invalid). */
function roundDownToStep(value: Decimal, stepText: string | null): Decimal {
  if (!stepText) return value;
  const step = new Decimal(stepText);
  if (!step.isFinite() || !step.gt(0)) return value;
  return value.div(step).floor().mul(step);
}

/** Parse a decimal string into a positive Decimal, or null when missing/invalid/non-positive. */
function parsePositive(text: string | null | undefined): Decimal | null {
  if (!text) return null;
  const value = new Decimal(text);
  return value.isFinite() && value.gt(0) ? value : null;
}

/** Parse a decimal string preserving its sign (spot liabilities report negative balances). */
function parseSigned(text: string | null | undefined): Decimal | null {
  if (!text) return null;
  const value = new Decimal(text);
  return value.isFinite() ? value : null;
}
