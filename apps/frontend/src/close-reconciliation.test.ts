import { describe, expect, it } from 'vitest';
import type { ClosePlanResponse, ResidualReport } from './api.js';
import {
  closeTargetsFromSymbols,
  executablePlanLegs,
  isSkippedLeg,
  planLegForSymbol,
  residualLines,
  skippedPlanLegs,
} from './close-reconciliation.js';

function planWith(legs: ClosePlanResponse['legs']): ClosePlanResponse {
  return { legs, fetchedAt: '2026-08-01T00:00:00.000Z' };
}

const LEG = {
  venue: 'GATE',
  marketType: 'PERP',
  positionSide: null,
} as const;

describe('close-reconciliation', () => {
  it('builds deduplicated targets, optionally with hedge-mode position sides', () => {
    expect(closeTargetsFromSymbols(['A_FUTURE_X_USDT', 'A_FUTURE_X_USDT', 'B_SPOT_X_USDT']))
      .toEqual([{ symbol: 'A_FUTURE_X_USDT' }, { symbol: 'B_SPOT_X_USDT' }]);
    expect(closeTargetsFromSymbols(['A_FUTURE_X_USDT'], (symbol) =>
      symbol.includes('FUTURE') ? 'LONG' : undefined,
    )).toEqual([{ symbol: 'A_FUTURE_X_USDT', positionSide: 'LONG' }]);
  });

  it('partitions plan legs into executable and skipped (dust / no market / locked)', () => {
    const plan = planWith([
      { ...LEG, symbol: 'GATE_FUTURE_X_USDT', side: 'SELL', quantity: '0.1' },
      { ...LEG, symbol: 'OKX_FUTURE_X_USDT', side: 'BUY', quantity: '0', skipReason: 'dust' },
      { ...LEG, marketType: 'SPOT', symbol: 'HYPERLIQUID_SPOT_X_USDC', side: 'SELL', quantity: '0', skipReason: 'no_market' },
      { ...LEG, marketType: 'SPOT', symbol: 'GATE_SPOT_Y_USDT', side: 'SELL', quantity: '0', skipReason: 'locked_balance' },
    ]);
    expect(executablePlanLegs(plan).map((leg) => leg.symbol)).toEqual(['GATE_FUTURE_X_USDT']);
    expect(skippedPlanLegs(plan).map((leg) => leg.skipReason)).toEqual(['dust', 'no_market', 'locked_balance']);
    expect(isSkippedLeg(plan.legs[0]!)).toBe(false);
    expect(isSkippedLeg(plan.legs[1]!)).toBe(true);
  });

  it('treats a zero-quantity leg without a reason as skipped, and finds legs by symbol', () => {
    const plan = planWith([
      { ...LEG, symbol: 'GATE_FUTURE_X_USDT', side: 'SELL', quantity: '0.2' },
      { ...LEG, symbol: 'GATE_FUTURE_Z_USDT', side: 'BUY', quantity: '0' },
    ]);
    expect(isSkippedLeg(plan.legs[1]!)).toBe(true);
    expect(planLegForSymbol(plan, 'GATE_FUTURE_Z_USDT')?.symbol).toBe('GATE_FUTURE_Z_USDT');
    expect(planLegForSymbol(plan, 'MISSING')).toBeNull();
  });

  it('flattens a residual report into presentation rows and yields none when clean', () => {
    const report: ResidualReport = {
      clean: false,
      fetchedAt: '2026-08-01T00:00:00.000Z',
      residuals: [{
        symbol: 'OKX_FUTURE_X_USDT', venue: 'OKX', marketType: 'PERP',
        residualQuantity: '0.04', reason: 'Reduce-only rejected: venue held less', suggestion: 'Close manually at the venue size',
      }],
    };
    expect(residualLines(report)).toEqual([{
      symbol: 'OKX_FUTURE_X_USDT', quantity: '0.04',
      reason: 'Reduce-only rejected: venue held less', suggestion: 'Close manually at the venue size',
    }]);
    expect(residualLines({ ...report, residuals: [], clean: true })).toEqual([]);
  });
});
