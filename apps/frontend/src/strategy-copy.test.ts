import { describe, expect, it } from 'vitest';
import type { StrategyConfig, StrategyRecord } from './api.js';
import { strategyCopyQuery, strategyRouteKind } from './strategy-copy.js';

/**
 * One-click copy prefill (0.3.3 需求 4).
 *
 * `strategyCopyQuery` is a pure translation from a stored `StrategyRecord.config` into the query
 * string the launch forms already read on mount, so every boundary case (kind mapping, absent
 * fields, an unknown kind) is asserted here rather than through a rendered form.
 */

function config(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    kind: 'auto',
    asset: 'BTC',
    leftVenue: 'BINANCE',
    rightVenue: 'OKX',
    leftSide: 'SELL',
    rightSide: 'BUY',
    perOrderQuantity: '0.1',
    reduceOnly: false,
    executionMethod: 'TAKER_TAKER',
    ...overrides,
  };
}

function record(overrides: Partial<StrategyRecord> = {}): StrategyRecord {
  return {
    id: 'AUTO-COPY01',
    kind: 'auto',
    status: 'STOPPED',
    accountProfileId: 'gate-crossex-default',
    accountLabel: 'Gate CrossEx',
    config: config(),
    progress: 100,
    filledQuantity: '0.2',
    filledLeft: '0.1',
    filledRight: '0.1',
    openPosition: '0',
    realizedPnl: '3.5',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T01:00:00.000Z',
    stoppedAt: '2026-08-14T01:00:00.000Z',
    ...overrides,
  };
}

describe('strategyRouteKind', () => {
  it('keeps every kind the form router knows about', () => {
    expect(strategyRouteKind('position')).toBe('position');
    expect(strategyRouteKind('auto')).toBe('auto');
    expect(strategyRouteKind('premium')).toBe('premium');
    expect(strategyRouteKind('carry')).toBe('carry');
  });

  it('maps an unknown kind to the Boros page instead of throwing', () => {
    // A record persisted by a newer backend must still land somewhere defined.
    expect(strategyRouteKind('grid' as StrategyRecord['kind'])).toBe('boros');
    expect(strategyRouteKind('' as StrategyRecord['kind'])).toBe('boros');
  });
});

describe('strategyCopyQuery — auto / position mapping', () => {
  it('emits every launch-form key the auto form reads, including the stop-loss and ladder', () => {
    const query = strategyCopyQuery(record({
      config: config({
        kind: 'auto',
        hedgeAsset: 'USDT',
        entryBps: '8',
        takeProfitBps: '40',
        stopLossBps: 100,
        addOnStepBps: 20,
        maxPosition: '5',
        perOrderQuantity: '0.1',
        leftLeverage: '3',
        rightLeverage: '2',
        executionMethod: 'MAKER_TAKER',
        makerLeg: 'right',
        reduceOnly: true,
      }),
    }));

    expect(query).toEqual({
      asset: 'BTC',
      hedgeAsset: 'USDT',
      leftSide: 'SELL',
      rightSide: 'BUY',
      left: 'BINANCE',
      right: 'OKX',
      entryBps: '8',
      takeProfitBps: '40',
      stopLossBps: '100',
      addOnStepBps: '20',
      maxPosition: '5',
      perOrderQuantity: '0.1',
      leftLeverage: '3',
      rightLeverage: '2',
      executionMethod: 'maker',
      makerLeg: 'right',
      reduceOnly: 'true',
      leftVenue: 'BINANCE',
      rightVenue: 'OKX',
      copyStrategyId: 'AUTO-COPY01',
    });
  });

  it('renders TAKER_TAKER as `taker` and a false reduce-only as `false`', () => {
    const query = strategyCopyQuery(record());
    expect(query.executionMethod).toBe('taker');
    expect(query.reduceOnly).toBe('false');
  });

  it('maps a position record onto the same keys (the position form shares the auto shape)', () => {
    const query = strategyCopyQuery(record({
      id: 'PAIR-COPY01',
      kind: 'position',
      config: config({ kind: 'position', entryBps: '10', totalAmount: '0.1' }),
    }));

    expect(query.left).toBe('BINANCE');
    expect(query.right).toBe('OKX');
    expect(query.entryBps).toBe('10');
    expect(query.totalAmount).toBe('0.1');
    expect(query.copyStrategyId).toBe('PAIR-COPY01');
  });

  it('emits `leftProduct`/`rightProduct` only for a spot leg symbol', () => {
    const spot = strategyCopyQuery(record({
      config: config({ leftSymbol: 'BINANCE_SPOT_BTC_USDT', rightSymbol: 'OKX_FUTURE_BTC_USDT' }),
    }));
    expect(spot.leftProduct).toBe('spot');
    // A perpetual symbol needs no key: the form's default is already perpetual.
    expect('rightProduct' in spot).toBe(false);

    const perp = strategyCopyQuery(record({
      config: config({ leftSymbol: 'GATE_FUTURE_BTC_USDT' }),
    }));
    expect('leftProduct' in perp).toBe(false);
  });
});

describe('strategyCopyQuery — premium mapping', () => {
  it('carries the premium thresholds, the share ratio, and the hedge sizing mode', () => {
    const query = strategyCopyQuery(record({
      id: 'PREM-COPY01',
      kind: 'premium',
      config: config({
        kind: 'premium',
        hedgeAsset: 'SKH',
        entryPremiumPct: '1.5',
        takeProfitPremiumPct: '0.4',
        adrRatio: '0.3',
        hedgeMode: 'SHARE_RATIO',
        maxPosition: '0.5',
        leftLeverage: '3',
        rightLeverage: '2',
      }),
    }));

    expect(query.entryPremiumPct).toBe('1.5');
    expect(query.takeProfitPremiumPct).toBe('0.4');
    expect(query.adrRatio).toBe('0.3');
    expect(query.hedgeMode).toBe('SHARE_RATIO');
    expect(query.copyStrategyId).toBe('PREM-COPY01');
    // Premium records never set the auto-only stop-loss.
    expect('stopLossBps' in query).toBe(false);
    expect('addOnStepBps' in query).toBe(false);
  });

  it('emits exactly the keys the premium form reads back (no more, no fewer)', () => {
    // A premium record stores its legs as `left`/`right` too, so `leftVenue`/`rightVenue` and
    // `leftLeverage`/`rightLeverage` already carry them — only `hedgeMode` was missing.
    const query = strategyCopyQuery(record({
      id: 'PREM-COPY01',
      kind: 'premium',
      config: config({
        kind: 'premium',
        hedgeAsset: 'SKH',
        entryPremiumPct: '1.5',
        takeProfitPremiumPct: '0.4',
        adrRatio: '0.3',
        hedgeMode: 'SHARE_RATIO',
        maxPosition: '0.5',
        leftLeverage: '3',
        rightLeverage: '2',
      }),
    }));

    expect(query).toEqual({
      asset: 'BTC',
      hedgeAsset: 'SKH',
      leftSide: 'SELL',
      rightSide: 'BUY',
      left: 'BINANCE',
      right: 'OKX',
      perOrderQuantity: '0.1',
      executionMethod: 'taker',
      reduceOnly: 'false',
      leftVenue: 'BINANCE',
      rightVenue: 'OKX',
      entryPremiumPct: '1.5',
      takeProfitPremiumPct: '0.4',
      adrRatio: '0.3',
      hedgeMode: 'SHARE_RATIO',
      maxPosition: '0.5',
      leftLeverage: '3',
      rightLeverage: '2',
      copyStrategyId: 'PREM-COPY01',
    });
  });

  it('keeps the copied direction, so a long premium does not come back as a short one', () => {
    const query = strategyCopyQuery(record({
      kind: 'premium',
      config: config({
        kind: 'premium',
        leftSide: 'BUY',
        rightSide: 'SELL',
        entryPremiumPct: '-2',
      }),
    }));
    expect(query.leftSide).toBe('BUY');
    expect(query.rightSide).toBe('SELL');
  });

  it('omits the hedge sizing mode when the record predates it', () => {
    const query = strategyCopyQuery(record({
      kind: 'premium',
      config: config({ kind: 'premium', hedgeMode: undefined }),
    }));
    expect('hedgeMode' in query).toBe(false);
  });
});

describe('strategyCopyQuery — carry mapping', () => {
  it('carries the venue ids, the explicit leg symbols, and the funding gate', () => {
    const query = strategyCopyQuery(record({
      id: 'CARRY-COPY01',
      kind: 'carry',
      config: config({
        kind: 'carry',
        asset: 'ETH',
        leftVenue: 'GATE',
        rightVenue: 'BINANCE',
        leftSymbol: 'GATE_SPOT_ETH_USDT',
        rightSymbol: 'BINANCE_FUTURE_ETH_USDT',
        fundingDirection: 'NEGATIVE',
        fundingAprMin: 12,
      }),
    }));

    expect(query.leftVenue).toBe('GATE');
    expect(query.rightVenue).toBe('BINANCE');
    expect(query.leftSymbol).toBe('GATE_SPOT_ETH_USDT');
    expect(query.rightSymbol).toBe('BINANCE_FUTURE_ETH_USDT');
    expect(query.direction).toBe('NEGATIVE');
    expect(query.aprMin).toBe('12');
    expect(query.leftProduct).toBe('spot');
    expect(query.copyStrategyId).toBe('CARRY-COPY01');
  });
});

describe('strategyCopyQuery — absent values', () => {
  it('omits every undefined, null, and empty field instead of sending an empty parameter', () => {
    const query = strategyCopyQuery(record({
      config: config({
        takeProfitBps: undefined,
        stopLossBps: undefined,
        addOnStepBps: undefined,
        maxPosition: undefined,
        totalAmount: undefined,
        leftSymbol: undefined,
        rightSymbol: undefined,
        leftLeverage: undefined,
        rightLeverage: undefined,
      }),
    }));

    for (const key of ['takeProfitBps', 'stopLossBps', 'addOnStepBps', 'maxPosition', 'totalAmount', 'leftSymbol', 'rightSymbol', 'leftLeverage', 'rightLeverage', 'leftProduct', 'rightProduct']) {
      expect(key in query).toBe(false);
    }
  });

  it('never emits an empty string, so no form falls back through a blank parameter', () => {
    const query = strategyCopyQuery(record({
      id: 'EDGE01',
      config: config({ hedgeAsset: '   ', maxPosition: '' }),
    }));

    expect('hedgeAsset' in query).toBe(false);
    expect('maxPosition' in query).toBe(false);
    for (const value of Object.values(query)) expect(value).not.toBe('');
  });

  it('does not throw for a kind it does not recognise', () => {
    const unknown = record({ kind: 'grid' as StrategyRecord['kind'] });
    expect(() => strategyCopyQuery(unknown)).not.toThrow();
    // The unknown kind still produces a usable destination marker.
    expect(strategyCopyQuery(unknown).copyStrategyId).toBe('AUTO-COPY01');
  });
});
