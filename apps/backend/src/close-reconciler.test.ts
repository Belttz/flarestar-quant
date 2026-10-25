import { describe, expect, it } from 'vitest';
import type { CrossExInstrument, PortfolioFuturesPosition } from '@gate-crossex/shared-types';
import { CloseReconciler, closeBaseAssetOf, closeMarketTypeOf, closeVenueOf, type CloseBalanceRow } from './close-reconciler.js';

function instrument(symbol: string, overrides: Partial<CrossExInstrument> = {}): [string, CrossExInstrument] {
  return [symbol, {
    symbol,
    exchangeType: 'GATE',
    businessType: 'SPOT',
    state: 'live',
    minSize: '0.001',
    minNotional: null,
    lotSize: '0.001',
    tickSize: '0.01',
    maxNumOrders: '50',
    maxMarketSize: null,
    maxLimitSize: null,
    contractSize: null,
    liquidationFee: null,
    defaultLeverage: null,
    delistTime: '0',
    ...overrides,
  }];
}

function perp(symbol: string, positionSide: string, quantity: string): PortfolioFuturesPosition {
  return {
    positionId: `${symbol}-${positionSide}`, symbol, positionSide, initialMargin: '0',
    maintenanceMargin: '0', quantity, value: '0', unrealizedPnl: '0', unrealizedPnlRate: '0',
    entryPrice: '100', markPrice: '100', leverage: '1', maxLeverage: '10', riskLimit: '0',
    fee: '0', fundingFee: '0', fundingTime: '0', createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z', realizedPnl: '0',
  };
}

function spot(venue: string, coin: string, balance: string, available: string): CloseBalanceRow {
  return { venue, coin, balance, availableBalance: available };
}

function reconciler(overrides: {
  positions?: PortfolioFuturesPosition[];
  balances?: CloseBalanceRow[];
  instruments?: ReadonlyMap<string, CrossExInstrument>;
  referencePrice?: (symbol: string) => number | null;
} = {}) {
  return new CloseReconciler({
    reconcilePositions: async () => overrides.positions ?? [],
    readBalances: async () => overrides.balances ?? [],
    instruments: () => overrides.instruments ?? new Map(),
    ...(overrides.referencePrice ? { referencePrice: overrides.referencePrice } : {}),
    now: () => Date.parse('2026-08-20T00:00:00.000Z'),
  });
}

describe('close reconciler symbol helpers', () => {
  it('classifies spot and perp symbols and exposes venue/base parts', () => {
    expect(closeMarketTypeOf('GATE_SPOT_BTC_USDT')).toBe('SPOT');
    expect(closeMarketTypeOf('KRAKEN_FUTURE_BTC_USD')).toBe('PERP');
    expect(closeMarketTypeOf('GATE_MARGIN_BTC_USDT')).toBeNull();
    expect(closeVenueOf('GATE_SPOT_BTC_USDT')).toBe('GATE');
    expect(closeVenueOf('HYPERLIQUID_FUTURE_SKHX_USDC')).toBe('HYPERLIQUID');
    expect(closeBaseAssetOf('GATE_SPOT_BTC_USDT')).toBe('BTC');
  });
});

describe('close reconciler planClose', () => {
  it('plans a perp leg from the venue position truth, deriving the reducing side', async () => {
    const service = reconciler({ positions: [perp('BINANCE_FUTURE_BTC_USDT', 'LONG', '0.25')] });
    const plan = await service.planClose({ targets: [{ symbol: 'BINANCE_FUTURE_BTC_USDT' }] });
    expect(plan.legs[0]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', marketType: 'PERP',
      side: 'SELL', quantity: '0.25', positionSide: null,
    });
    expect(plan.legs[0]?.skipReason).toBeUndefined();
  });

  it('plans a short perp leg as a BUY buyback', async () => {
    const service = reconciler({ positions: [perp('OKX_FUTURE_BTC_USDT', 'SHORT', '1.5')] });
    const plan = await service.planClose({ targets: [{ symbol: 'OKX_FUTURE_BTC_USDT' }] });
    expect(plan.legs[0]).toMatchObject({ side: 'BUY', quantity: '1.5' });
  });

  it('reports no reducible quantity when the venue holds no position', async () => {
    const service = reconciler({ positions: [] });
    const plan = await service.planClose({ targets: [{ symbol: 'OKX_FUTURE_BTC_USDT' }] });
    expect(plan.legs[0]).toMatchObject({ side: 'SELL', quantity: '0', skipReason: 'no_balance' });
  });

  it('plans a spot long from the available balance, floored to the lot size', async () => {
    const service = reconciler({
      balances: [spot('SPOT', 'BTC', '0.123456', '0.123456')],
      instruments: new Map([instrument('GATE_SPOT_BTC_USDT')]),
    });
    const plan = await service.planClose({ targets: [{ symbol: 'GATE_SPOT_BTC_USDT' }] });
    expect(plan.legs[0]).toMatchObject({
      symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', marketType: 'SPOT',
      side: 'SELL', quantity: '0.123',
    });
  });

  it('sells only the unlocked part of a partially locked spot balance', async () => {
    const service = reconciler({
      balances: [spot('GATE', 'BTC', '0.5', '0.2')],
      instruments: new Map([instrument('GATE_SPOT_BTC_USDT')]),
    });
    const plan = await service.planClose({ targets: [{ symbol: 'GATE_SPOT_BTC_USDT' }] });
    expect(plan.legs[0]).toMatchObject({ side: 'SELL', quantity: '0.2' });
  });

  it('reports locked_balance instead of fabricating a sell when everything is locked', async () => {
    const service = reconciler({
      balances: [spot('GATE', 'BTC', '0.5', '0')],
      instruments: new Map([instrument('GATE_SPOT_BTC_USDT')]),
    });
    const plan = await service.planClose({ targets: [{ symbol: 'GATE_SPOT_BTC_USDT' }] });
    expect(plan.legs[0]).toMatchObject({ quantity: '0', skipReason: 'locked_balance' });
  });

  it('plans a spot liability as a BUY buyback of the full debt', async () => {
    const service = reconciler({
      balances: [spot('BINANCE', 'ETH', '-1.25', '0')],
      instruments: new Map([instrument('BINANCE_SPOT_ETH_USDT', { exchangeType: 'BINANCE' })]),
    });
    const plan = await service.planClose({ targets: [{ symbol: 'BINANCE_SPOT_ETH_USDT' }] });
    expect(plan.legs[0]).toMatchObject({ side: 'BUY', quantity: '1.25', venue: 'BINANCE' });
  });

  it('marks a residual below the minimum order unit as dust and orders nothing', async () => {
    const service = reconciler({
      balances: [spot('SPOT', 'BTC', '0.0005', '0.0005')],
      instruments: new Map([instrument('GATE_SPOT_BTC_USDT')]),
    });
    const plan = await service.planClose({ targets: [{ symbol: 'GATE_SPOT_BTC_USDT' }] });
    expect(plan.legs[0]).toMatchObject({ quantity: '0', skipReason: 'dust' });
  });

  it('marks a plan under minNotional as dust when a live price is available', async () => {
    const service = reconciler({
      balances: [spot('SPOT', 'BTC', '0.001', '0.001')],
      instruments: new Map([instrument('GATE_SPOT_BTC_USDT', { minNotional: '10' })]),
      referencePrice: (symbol) => (symbol === 'GATE_SPOT_BTC_USDT' ? 100 : null),
    });
    const plan = await service.planClose({ targets: [{ symbol: 'GATE_SPOT_BTC_USDT' }] });
    expect(plan.legs[0]).toMatchObject({ quantity: '0', skipReason: 'dust' });
  });

  it('reports no_market for a symbol the terminal cannot classify', async () => {
    const service = reconciler();
    const plan = await service.planClose({ targets: [{ symbol: 'NOT_A_MARKET' }] });
    expect(plan.legs[0]).toMatchObject({ quantity: '0', skipReason: 'no_market' });
  });

  it('does not read balances for a perp-only plan nor positions for a spot-only plan', async () => {
    let positionReads = 0;
    let balanceReads = 0;
    const service = new CloseReconciler({
      reconcilePositions: async () => { positionReads += 1; return []; },
      readBalances: async () => { balanceReads += 1; return []; },
      instruments: () => new Map(),
    });
    await service.planClose({ targets: [{ symbol: 'OKX_FUTURE_BTC_USDT' }] });
    expect(positionReads).toBe(1);
    expect(balanceReads).toBe(0);
    await service.planClose({ targets: [{ symbol: 'GATE_SPOT_BTC_USDT' }] });
    expect(positionReads).toBe(1);
    expect(balanceReads).toBe(1);
  });
});

describe('close reconciler verifyClose', () => {
  it('reports a clean sweep when every leg is flat', async () => {
    const service = reconciler({ positions: [] });
    const report = await service.verifyClose({ targets: [{ symbol: 'OKX_FUTURE_BTC_USDT' }] });
    expect(report).toMatchObject({ clean: true, residuals: [] });
  });

  it('treats a residual below the minimum order unit as clean dust', async () => {
    const service = reconciler({
      balances: [spot('SPOT', 'BTC', '0.0005', '0.0005')],
      instruments: new Map([instrument('GATE_SPOT_BTC_USDT')]),
    });
    const report = await service.verifyClose({ targets: [{ symbol: 'GATE_SPOT_BTC_USDT' }] });
    expect(report.clean).toBe(true);
    expect(report.residuals).toEqual([]);
  });

  it('reports an above-unit residual with reason and suggestion', async () => {
    const service = reconciler({
      positions: [perp('KRAKEN_FUTURE_BTC_USD', 'SHORT', '0.0042')],
      instruments: new Map([instrument('KRAKEN_FUTURE_BTC_USD', { businessType: 'FUTURE' })]),
    });
    const report = await service.verifyClose({ targets: [{ symbol: 'KRAKEN_FUTURE_BTC_USD' }] });
    expect(report.clean).toBe(false);
    expect(report.residuals).toHaveLength(1);
    expect(report.residuals[0]).toMatchObject({
      symbol: 'KRAKEN_FUTURE_BTC_USD', venue: 'KRAKEN', marketType: 'PERP',
      residualQuantity: '0.0042',
    });
    expect(report.residuals[0]?.suggestion).toContain('Retry');
  });

  it('counts a fully locked spot balance as a residual (locked coins are still exposure)', async () => {
    const service = reconciler({
      balances: [spot('GATE', 'BTC', '0.5', '0')],
      instruments: new Map([instrument('GATE_SPOT_BTC_USDT')]),
    });
    const report = await service.verifyClose({ targets: [{ symbol: 'GATE_SPOT_BTC_USDT' }] });
    expect(report.clean).toBe(false);
    expect(report.residuals[0]).toMatchObject({ residualQuantity: '0.5', marketType: 'SPOT' });
  });
});
