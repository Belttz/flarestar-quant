import { describe, expect, it } from 'vitest';
import type { AuthenticatedPortfolioSnapshot, LiveBalance } from './api.js';
import {
  assessMarginCapacity,
  balanceFor,
  balanceUnitFor,
  classifyLeverageMargin,
  marginLimitedQuantity,
  maxPositionValueAtLeverage,
  notionalToQuantity,
  projectedPositionValue,
} from './route-shared.js';

function portfolio(accountMode: string, availableMargin: string): AuthenticatedPortfolioSnapshot {
  return {
    dataStatus: 'fresh',
    remoteStatus: 'healthy',
    snapshot: {
      account: {
        availableMargin, marginBalance: availableMargin, initialMargin: '0', maintenanceMargin: '0',
        initialMarginRate: '0', maintenanceMarginRate: '0', positionMode: 'SINGLE', accountMode,
        exchangeType: accountMode === 'CROSS_EXCHANGE' ? 'CROSSEX' : 'DERIBIT',
        remoteUpdatedAt: '2026-08-05T00:00:00.000Z',
      },
      balances: [{
        venue: 'DERIBIT', coin: 'USDC', balance: '1', unrealizedPnl: '0', equity: '1',
        futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0',
        borrowingMaintenanceMargin: '0', availableBalance: '0.98', liability: '0',
      }],
      futuresPositions: [], marginPositions: [], openOrders: [], recentFills: [],
      fetchedAt: '2026-08-05T00:00:00.000Z', source: 'gate_crossex_authenticated_rest',
    },
    reconciliation: {
      id: 'reconciliation', createdAt: '2026-08-05T00:00:00.000Z', status: 'clean',
      previousFetchedAt: null, currentFetchedAt: '2026-08-05T00:00:00.000Z', issues: [],
    },
  };
}

const streamedDeribitBalance: LiveBalance = {
  venue: 'DERIBIT', coin: 'USDC', balance: '1', availableBalance: '0.98', equity: '1',
  unrealizedPnl: '0', updatedAt: '2026-08-05T00:00:00.000Z',
};

describe('CrossEx margin capacity', () => {
  it('uses the account-level USDT margin in cross-exchange mode instead of a venue asset row', () => {
    const snapshot = portfolio('CROSS_EXCHANGE', '9792.85');
    const balances = { 'DERIBIT:USDC': streamedDeribitBalance };

    expect(balanceFor(balances, snapshot, 'deribit')).toBe('9792.85');
    expect(balanceUnitFor(snapshot, 'deribit')).toBe('USDT');
    expect(assessMarginCapacity('CROSS_EXCHANGE', 9792.85, [
      { venue: 'DERIBIT', required: 302.02, available: 0.98 },
      { venue: 'BYBIT', required: 302.02, available: 0 },
    ])).toEqual({ known: true, insufficient: false });
  });

  it('groups requirements by venue only in isolated mode', () => {
    const snapshot = portfolio('ISOLATED_EXCHANGE', '250');
    expect(balanceFor({ 'DERIBIT:USDC': streamedDeribitBalance }, snapshot, 'deribit')).toBe('250');
    expect(balanceFor({ 'DERIBIT:USDC': streamedDeribitBalance }, snapshot, 'bybit')).toBeNull();
    expect(assessMarginCapacity('ISOLATED_EXCHANGE', 9792.85, [
      { venue: 'DERIBIT', required: 300, available: 100 },
      { venue: 'DERIBIT', required: 50, available: 100 },
      { venue: 'BYBIT', required: 200, available: 500 },
    ])).toEqual({ known: true, insufficient: true });
  });

  it('separates a higher-leverage requirement from insufficient capital at maximum leverage', () => {
    expect(classifyLeverageMargin(
      { known: true, insufficient: true },
      { known: true, insufficient: false },
      200,
    )).toBe('higher_leverage_required');
    expect(classifyLeverageMargin(
      { known: true, insufficient: true },
      { known: true, insufficient: true },
      200,
    )).toBe('insufficient_at_max');
    expect(classifyLeverageMargin(
      { known: true, insufficient: false },
      { known: true, insufficient: false },
      200,
    )).toBe('sufficient');
    expect(classifyLeverageMargin(null, { known: true, insufficient: false }, 200)).toBe('unknown');
  });
});

describe('CrossEx leverage-tier position capacity', () => {
  const tiers = [
    { tier: '1', minRiskLimitValue: '0', maxRiskLimitValue: '100000', quickCalAmount: '0', leverageMax: '25', maintenanceRate: '0.01' },
    { tier: '2', minRiskLimitValue: '100000', maxRiskLimitValue: '250000', quickCalAmount: '0', leverageMax: '20', maintenanceRate: '0.02' },
    { tier: '3', minRiskLimitValue: '250000', maxRiskLimitValue: '500000', quickCalAmount: '0', leverageMax: '10', maintenanceRate: '0.03' },
  ];

  it('uses the furthest tier that permits the selected leverage', () => {
    expect(maxPositionValueAtLeverage(tiers, 25)).toBe(100000);
    expect(maxPositionValueAtLeverage(tiers, 20)).toBe(250000);
    expect(maxPositionValueAtLeverage(tiers, 10)).toBe(500000);
    expect(maxPositionValueAtLeverage(tiers, 30)).toBeNull();
  });

  it('treats the 999,999,999 unlimited sentinel as no cap instead of an absurd maximum', () => {
    const sentinelTier = { tier: '9', minRiskLimitValue: '500000', maxRiskLimitValue: '999999999', quickCalAmount: '0', leverageMax: '50', maintenanceRate: '0.05' };
    expect(maxPositionValueAtLeverage([sentinelTier], 25)).toBeNull();
    // A real tier beside the sentinel still caps the position.
    expect(maxPositionValueAtLeverage([sentinelTier, ...tiers], 25)).toBe(100000);
  });

  it('checks the projected final position rather than only incremental exposure', () => {
    expect(projectedPositionValue(4, 2, 100)).toBe(600);
    expect(projectedPositionValue(-4, 2, 100)).toBe(200);
    expect(projectedPositionValue(-4, 6, 100)).toBe(200);
  });

  it('converts a tier notional cap into the size it buys at the reference price', () => {
    expect(notionalToQuantity(350000000, 70000)).toBe(5000);
    expect(notionalToQuantity(0, 70000)).toBe(0);
    // Missing or unusable inputs stay unknown so the panel can render an em dash, never a fake 0.
    expect(notionalToQuantity(null, 70000)).toBeNull();
    expect(notionalToQuantity(undefined, 70000)).toBeNull();
    expect(notionalToQuantity(Number.POSITIVE_INFINITY, 70000)).toBeNull();
    expect(notionalToQuantity(350000000, 0)).toBeNull();
  });

  it('caps the margin-limited buy size at the tier cap and refuses unknown margin', () => {
    // 1000 USDT of free margin at 5x buys 5000 USDT, i.e. 0.05 BTC at 100,000.
    expect(marginLimitedQuantity(1000, 5, 100000, null)).toBeCloseTo(0.05, 10);
    expect(marginLimitedQuantity(1000, 5, 100000, 0.01)).toBe(0.01);
    // Above the tier cap: the venue limit wins.
    expect(marginLimitedQuantity(1000000, 50, 100000, 0.01)).toBe(0.01);
    expect(marginLimitedQuantity(null, 5, 100000, 0.01)).toBeNull();
    expect(marginLimitedQuantity(0, 5, 100000, 0.01)).toBeNull();
    expect(marginLimitedQuantity(1000, 0, 100000, 0.01)).toBeNull();
    expect(marginLimitedQuantity(1000, 5, 0, 0.01)).toBeNull();
  });
});
