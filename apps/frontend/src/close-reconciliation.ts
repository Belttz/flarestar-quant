import type { CloseLegPlan, ClosePlanResponse, CloseTargetInput, ResidualReport } from './api.js';

/**
 * Front-end helpers for the server-reconciled close flow (R2/R3). Quantities never originate
 * here — every helper consumes the backend's venue-truth plan/verify payloads — but the
 * partitioning and presentation logic is pure and unit-testable.
 */

/**
 * Build a close-plan request body from plain symbols. `positionSideOf` lets a caller attach
 * hedge-mode position sides (DUAL accounts) without this module knowing about portfolios.
 */
export function closeTargetsFromSymbols(
  symbols: readonly string[],
  positionSideOf?: (symbol: string) => 'NONE' | 'LONG' | 'SHORT' | undefined,
): CloseTargetInput[] {
  return [...new Set(symbols)].map((symbol) => {
    const positionSide = positionSideOf?.(symbol);
    return positionSide === undefined ? { symbol } : { symbol, positionSide };
  });
}

/** Legs with an executable venue-truth quantity — the ones a close strategy should submit. */
export function executablePlanLegs(plan: ClosePlanResponse): CloseLegPlan[] {
  return plan.legs.filter((leg) => leg.skipReason === undefined && Number(leg.quantity) > 0);
}

/** Legs the server refused to size (dust / no market / no balance / locked balance). */
export function skippedPlanLegs(plan: ClosePlanResponse): CloseLegPlan[] {
  return plan.legs.filter((leg) => leg.skipReason !== undefined || !(Number(leg.quantity) > 0));
}

/** The plan leg for one symbol, or null when the plan does not cover it. */
export function planLegForSymbol(plan: ClosePlanResponse, symbol: string): CloseLegPlan | null {
  return plan.legs.find((leg) => leg.symbol === symbol) ?? null;
}

/** The plan leg for one symbol out of an already-indexed (by symbol) leg map. */
export function planLegFromMap(legs: ReadonlyMap<string, CloseLegPlan>, symbol: string): CloseLegPlan | null {
  return legs.get(symbol) ?? null;
}

/** True when the venue holds nothing orderable on this leg (dust, empty book, empty wallet). */
export function isSkippedLeg(leg: CloseLegPlan): boolean {
  return leg.skipReason !== undefined || !(Number(leg.quantity) > 0);
}

/** One human-facing residual row: what is left, why, and what to do about it. */
export interface ResidualLine {
  symbol: string;
  quantity: string;
  reason: string;
  suggestion: string;
}

/** Flatten a verify report into presentation rows; a clean report yields none. */
export function residualLines(report: ResidualReport): ResidualLine[] {
  return report.residuals.map((leg) => ({
    symbol: leg.symbol,
    quantity: leg.residualQuantity,
    reason: leg.reason,
    suggestion: leg.suggestion,
  }));
}
