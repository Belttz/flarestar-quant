import { describe, expect, it } from 'vitest';
import { positionGroupIsSettled, residualSymbolsFromReport } from './position-grouping.js';
import type { ResidualReport } from '@gate-crossex/shared-types';

function report(residuals: Array<{ symbol: string; venue: string; marketType: 'SPOT' | 'PERP'; residualQuantity: string; reason: string; suggestion: string }>): ResidualReport {
  return { residuals, clean: residuals.length === 0, fetchedAt: '2026-09-01T00:00:00.000Z' };
}

describe('position group settle verdict (R11)', () => {
  it('folds a group whose legs carry no residuals after the close plan', () => {
    const verify = report([]);
    expect(positionGroupIsSettled(['GATE_SPOT_BTC_USDT', 'KRAKEN_PERP_X_USDT'], verify)).toBe(true);
  });

  it('keeps a group open while any leg still holds an orderable residual', () => {
    const verify = report([
      { symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', marketType: 'SPOT', residualQuantity: '0.02', reason: 'partial_fill', suggestion: 'Rerun the close.' },
    ]);
    expect(positionGroupIsSettled(['GATE_SPOT_BTC_USDT', 'KRAKEN_PERP_X_USDT'], verify)).toBe(false);
    // The settled leg does not rescue the group: collapse needs every leg settled.
    expect(positionGroupIsSettled(['GATE_SPOT_BTC_USDT'], verify)).toBe(false);
  });

  it('treats dust-only legs as settled because the report never lists them', () => {
    // The backend's verifyClose only lists residuals above the smallest orderable unit, so a
    // dust remnant is absent from the report — the group collapses instead of zombifying.
    const verify = report([
      { symbol: 'KRAKEN_PERP_X_USDT', venue: 'KRAKEN', marketType: 'PERP', residualQuantity: '1', reason: 'margin_rejected', suggestion: 'Top up margin.' },
    ]);
    expect(positionGroupIsSettled(['GATE_SPOT_BTC_USDT', 'KRAKEN_PERP_X_USDT'], verify)).toBe(false);
    expect(positionGroupIsSettled(['GATE_SPOT_BTC_USDT'], verify)).toBe(true);
  });

  it('settles nothing without a verify report — absence of evidence is not closure', () => {
    expect(positionGroupIsSettled(['GATE_SPOT_BTC_USDT'], null)).toBe(false);
    expect(positionGroupIsSettled(['GATE_SPOT_BTC_USDT'], undefined)).toBe(false);
    expect(residualSymbolsFromReport(null).size).toBe(0);
  });
});
