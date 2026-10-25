import { describe, expect, it } from 'vitest';
import {
  BorosStrategiesResponseSchema,
  BorosUpstreamMarketFeesResponseSchema,
  CloseLegPlanSchema,
  ClosePlanRequestSchema,
  ClosePlanResponseSchema,
  CrossExInstrumentCatalogSchema,
  CrossExPortfolioActivityResponseSchema,
  CrossExTransferRequestSchema,
  EnvironmentSchema,
  PublicMarketSnapshotResponseSchema,
  ResidualReportSchema,
  SpreadCombinationSchema,
  SpreadQualityResponseSchema,
  SpreadQualityRowSchema,
  StrategyConfigSchema,
  SystemDiscoverySchema,
  TerminalStreamMessageSchema,
  STRATEGY_LOG_CATEGORIES,
  STRATEGY_LOG_CATEGORY_FETCH_EVENTS,
  STRATEGY_LOG_EVENT_CATEGORY,
  STRATEGY_LOG_LEG_EVENT_PREFIXES,
  VenueSchema,
  canonicalizeCrossExTransfer,
  contiguousCandleTail,
  crossExTransferRouteError,
  type Candle,
} from './index.js';
describe('shared schemas', () => { it('accepts supported environments and venues', () => { expect(EnvironmentSchema.parse('live')).toBe('live'); expect(VenueSchema.parse('GATE')).toBe('GATE'); }); });

describe('strategy config schema', () => {
  it('preserves a negative paired-position entry threshold', () => {
    const config = StrategyConfigSchema.parse({
      kind: 'position', asset: 'HYPE', leftVenue: 'HYPERLIQUID', rightVenue: 'BYBIT',
      leftSide: 'SELL', rightSide: 'BUY', entryBps: '-5', totalAmount: '100',
      perOrderQuantity: '10', reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    expect(config.entryBps).toBe('-5');
  });
});

describe('Boros strategy schema', () => {
  it('accepts the documented fixed-rate opportunity and rejects malformed contracts', () => {
    const market = {
      marketId: 185,
      address: '0x6bb121533f78d8d0c8a847b0ab399e0399966563',
      tokenId: 2,
      name: 'ETHUSDT',
      assetSymbol: 'ETH',
      maturity: 1790294400,
      state: 'Normal',
      impliedApr: 0.0225,
      maxLeverage: 2.1,
      maxPerpLeverage: 100,
      ammId: 0,
      platformName: 'OKX',
    };
    const response = BorosStrategiesResponseSchema.parse({
      strategies: [{
        id: 'ETH-2-1790294400-OKX-Hyperliquid',
        longMarket: market,
        shortMarket: { ...market, marketId: 102, name: 'ETHUSDC', platformName: 'Hyperliquid' },
        daysToMaturity: 50,
        impliedAprSpread: 0.0403,
        maxPerpLeverage: 10,
        aprTimesMaxLeverage: 0.1487,
      }],
      totalCount: 1,
      fetchedAt: '2026-08-06T10:00:00.000Z',
      cacheStatus: 'fresh',
      source: 'boros_open_api',
    });
    expect(response.strategies[0]?.longMarket.platformName).toBe('OKX');
    expect(BorosStrategiesResponseSchema.safeParse({
      ...response,
      strategies: [{ ...response.strategies[0], longMarket: { ...market, address: 'not-a-contract' } }],
    }).success).toBe(false);
  });

  it('validates the Boros market fee fields used to enrich return estimates', () => {
    const response = BorosUpstreamMarketFeesResponseSchema.parse({
      results: [{
        marketId: 185,
        imData: { marginFloor: 0.06 },
        config: { takerFee: '500000000000000', kIM: '476190476190476190', tThresh: 864000 },
        extConfig: { settleFeeRate: '1000000000000000' },
        data: { timeToMaturity: 4_204_800 },
      }],
      resumeToken: null,
    });
    expect(response.results[0]?.config.takerFee).toBe('500000000000000');
    expect(() => BorosUpstreamMarketFeesResponseSchema.parse({
      results: [{ marketId: 185, imData: { marginFloor: -1 }, config: { takerFee: '-1', kIM: 'x', tThresh: -1 }, extConfig: { settleFeeRate: '1' }, data: { timeToMaturity: -1 } }],
    })).toThrow();
  });
});

describe('CrossEx transfer request schema', () => {
  it('accepts documented accounts and rejects zero-value or same-account transfers', () => {
    expect(CrossExTransferRequestSchema.parse({
      coin: 'USDT', amount: '25.5', from: 'SPOT', to: 'CROSSEX', text: 'portfolio_1',
    })).toMatchObject({ amount: '25.5', from: 'SPOT', to: 'CROSSEX' });
    expect(CrossExTransferRequestSchema.safeParse({ coin: 'USDT', amount: '0', from: 'SPOT', to: 'CROSSEX' }).success).toBe(false);
    expect(CrossExTransferRequestSchema.safeParse({ coin: 'BTC', amount: '1', from: 'CROSSEX_GATE', to: 'CROSSEX_GATE' }).success).toBe(false);
  });

  it('enforces Gate route-specific asset and account restrictions', () => {
    expect(crossExTransferRouteError({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT' }, 'CROSS_EXCHANGE')).toBeNull();
    expect(crossExTransferRouteError({ coin: 'USDC', from: 'CROSSEX_DERIBIT', to: 'SPOT' }, 'CROSS_EXCHANGE')).toBeNull();
    expect(crossExTransferRouteError({ coin: 'USDC', from: 'CROSSEX_BINANCE', to: 'CROSSEX_GATE' }, 'CROSS_EXCHANGE')).toBeNull();
    expect(crossExTransferRouteError({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'CROSSEX_GATE' }, 'CROSS_EXCHANGE'))
      .toBe('HYPERLIQUID_USDC_SPOT_ONLY');
    expect(crossExTransferRouteError({ coin: 'USDC', from: 'CROSSEX_LIGHTER', to: 'SPOT' }, 'CROSS_EXCHANGE')).toBeNull();
    expect(crossExTransferRouteError({ coin: 'USDC', from: 'SPOT', to: 'CROSSEX_LIGHTER' }, 'ISOLATED_EXCHANGE')).toBeNull();
    expect(crossExTransferRouteError({ coin: 'USDT', from: 'CROSSEX_LIGHTER', to: 'SPOT' }, 'CROSS_EXCHANGE'))
      .toBe('LIGHTER_USDC_SPOT_ONLY');
    expect(crossExTransferRouteError({ coin: 'USDC', from: 'CROSSEX_LIGHTER', to: 'CROSSEX_GATE' }, 'CROSS_EXCHANGE'))
      .toBe('LIGHTER_USDC_SPOT_ONLY');
    expect(crossExTransferRouteError({ coin: 'USDC', from: 'CROSSEX_LIGHTER', to: 'CROSSEX_HYPERLIQUID' }, 'CROSS_EXCHANGE'))
      .toBe('HYPERLIQUID_USDC_SPOT_ONLY');
    expect(crossExTransferRouteError({ coin: 'BTC', from: 'CROSSEX_KRAKEN', to: 'SPOT' }, 'ISOLATED_EXCHANGE'))
      .toBe('KRAKEN_USDT_ONLY');
    expect(crossExTransferRouteError({ coin: 'BTC', from: 'CROSSEX', to: 'SPOT' }, 'CROSS_EXCHANGE'))
      .toBe('EXPLICIT_VENUE_ACCOUNT_REQUIRED');
    expect(crossExTransferRouteError({ coin: 'USDT', from: 'CROSSEX_BINANCE', to: 'CROSSEX_OKX' }, 'CROSS_EXCHANGE'))
      .toBe('USDT_SPOT_CROSSEX_REQUIRED');
    expect(crossExTransferRouteError({ coin: 'BTC', from: 'CROSSEX_DERIBIT', to: 'CROSSEX_GATE' }, 'CROSS_EXCHANGE')).toBeNull();
  });

  it('canonicalizes the documented USDT aliases before balance validation and submission', () => {
    expect(canonicalizeCrossExTransfer({
      coin: 'USDT', amount: '25', from: 'CROSSEX_DERIBIT', to: 'SPOT',
    }, 'CROSS_EXCHANGE')).toMatchObject({ from: 'CROSSEX', to: 'SPOT' });
    expect(canonicalizeCrossExTransfer({
      coin: 'USDT', amount: '25', from: 'SPOT', to: 'CROSSEX',
    }, 'ISOLATED_EXCHANGE')).toMatchObject({ from: 'SPOT', to: 'CROSSEX_GATE' });
    expect(crossExTransferRouteError({
      coin: 'USDT', from: 'SPOT', to: 'CROSSEX',
    }, 'ISOLATED_EXCHANGE')).toBeNull();
  });
});

describe('CrossEx portfolio activity schema', () => {
  it('keeps a dedicated list of funding-fee account entries', () => {
    const fundingFee = {
      id: 'fee-1', businessId: 'settlement-1', statementType: 'FUNDING_FEE', venue: 'BINANCE',
      coin: 'USDT', symbol: 'BINANCE_FUTURE_BTC_USDT', change: '-0.002', balance: '81',
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    const response = CrossExPortfolioActivityResponseSchema.parse({
      transfers: [], accountBook: [fundingFee], fundingFees: [fundingFee],
      fetchedAt: '2026-08-01T00:00:01.000Z',
    });
    expect(response.fundingFees).toEqual([fundingFee]);
  });
});

function candle(startTime: number, close = String(startTime)): Candle {
  return { startTime, open: close, high: close, low: close, close, volume: '1', closed: true };
}

describe('contiguous candle history', () => {
  it('keeps only the newest run when an interval is missing', () => {
    expect(contiguousCandleTail([
      candle(0),
      candle(60_000),
      candle(600_000),
      candle(660_000),
    ], '1m').map((item) => item.startTime)).toEqual([600_000, 660_000]);
  });

  it('sorts, deduplicates with the newest value, and applies the limit', () => {
    const result = contiguousCandleTail([
      candle(120_000),
      candle(0),
      candle(60_000, 'old'),
      candle(60_000, 'new'),
    ], '1m', 2);
    expect(result.map((item) => item.startTime)).toEqual([60_000, 120_000]);
    expect(result[0]?.close).toBe('new');
  });
});

describe('system discovery schema', () => {
  it('rejects a negative migration count', () => {
    expect(() => SystemDiscoverySchema.parse({
      product: 'CrossEx',
      mode: 'live',
      authenticatedTradingEnabled: false,
      tradingMode: 'unset',
      docs: { apiVersion: 'v4', retrievedAt: '2026-07-10' },
      database: { migrationCount: -1, currentMigration: null },
    })).toThrow();
  });
});

describe('CrossEx instrument catalog schema', () => {
  it('preserves decimal values as strings and accepts documented nullable limits', () => {
    const catalog = CrossExInstrumentCatalogSchema.parse({
      items: [{
        symbol: 'GATE_FUTURE_BTC_USDT', exchangeType: 'GATE', businessType: 'FUTURE', state: 'live',
        minSize: '0.0001', minNotional: null, lotSize: '0.0001', tickSize: '0.1',
        maxNumOrders: '50', maxMarketSize: null, maxLimitSize: '1200', contractSize: null,
        liquidationFee: '0.005', defaultLeverage: '5', delistTime: '0',
      }],
      fetchedAt: '2026-07-10T00:00:00.000Z',
      source: 'gate_crossex_public_rest',
      cacheStatus: 'fresh',
      upstreamStatus: 'healthy',
    });
    expect(catalog.items[0]?.minSize).toBe('0.0001');
  });
});

describe('public market snapshot schema', () => {
  it('keeps prices and rates as strings and requires an explicit source', () => {
    const response = PublicMarketSnapshotResponseSchema.parse({
      snapshot: {
        symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', product: 'FUTURE',
        bidPrice: '63952.2', askPrice: '63952.3', lastPrice: '63952.3',
        markPrice: '63952.3', indexPrice: '63968.12', fundingRate: '0.0001',
        predictedFundingRate: '0.0001', nextFundingAt: '2026-07-11T00:00:00.000Z',
        sourceTimestamp: '2026-07-10T18:00:00.000Z', fetchedAt: '2026-07-10T18:00:00.000Z',
        source: 'gate_futures_public_rest',
      },
      cacheStatus: 'fresh', upstreamStatus: 'healthy',
    });
    expect(response.snapshot.fundingRate).toBe('0.0001');
  });
});

describe('terminal stream contract', () => {
  it('accepts a mode update and rejects a malformed market update', () => {
    expect(TerminalStreamMessageSchema.parse({
      type: 'mode.update',
      payload: { mode: 'readonly' },
    })).toEqual({ type: 'mode.update', payload: { mode: 'readonly' } });
    expect(TerminalStreamMessageSchema.safeParse({
      type: 'market.status',
      payload: { connectionState: 'healthy', checkedAt: '2026-08-01T00:00:00.000Z' },
    }).success).toBe(true);
    expect(TerminalStreamMessageSchema.safeParse({
      type: 'market.update',
      payload: { symbol: 42 },
    }).success).toBe(false);
    expect(TerminalStreamMessageSchema.safeParse({
      type: 'trade.batch',
      payload: {
        symbol: 'GATE_FUTURE_BTC_USDT',
        trades: [{
          id: 'trade-1', symbol: 'GATE_FUTURE_BTC_USDT', price: '118500', quantity: '1',
          side: 'BUY', executedAt: '2026-08-01T00:00:00.000Z',
        }],
      },
    }).success).toBe(true);
  });
});

describe('close plan / residual schemas', () => {
  it('accepts a symbol-only close plan request (the venue owns the quantity)', () => {
    const request = ClosePlanRequestSchema.parse({
      targets: [{ symbol: 'GATE_SPOT_BTC_USDT' }, { symbol: 'KRAKEN_PERP_BTC_USDT', positionSide: 'SHORT' }],
    });
    expect(request.targets).toHaveLength(2);
    expect(ClosePlanRequestSchema.safeParse({ targets: [] }).success).toBe(false);
    expect(ClosePlanRequestSchema.safeParse({ targets: [{ symbol: '' }] }).success).toBe(false);
  });

  it('parses a reconciled close plan with a dust skip', () => {
    const response = ClosePlanResponseSchema.parse({
      legs: [
        {
          symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', marketType: 'SPOT', side: 'SELL',
          quantity: '0.015', positionSide: null,
        },
        {
          symbol: 'KRAKEN_PERP_BTC_USDT', venue: 'KRAKEN', marketType: 'PERP', side: 'BUY',
          quantity: '0', positionSide: 'SHORT', skipReason: 'dust',
        },
      ],
      fetchedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(response.legs[1]?.skipReason).toBe('dust');
    // A leg without a skip reason is executable and must carry a positive quantity downstream.
    expect(response.legs[0]?.skipReason).toBeUndefined();
  });

  it('rejects an unknown skip reason', () => {
    expect(CloseLegPlanSchema.safeParse({
      symbol: 'X', venue: 'GATE', marketType: 'SPOT', side: 'SELL', quantity: '1',
      positionSide: null, skipReason: 'whatever',
    }).success).toBe(false);
  });

  it('parses a residual report and keeps clean flag semantics explicit', () => {
    const report = ResidualReportSchema.parse({
      residuals: [{
        symbol: 'KRAKEN_PERP_BTC_USDT', venue: 'KRAKEN', marketType: 'PERP',
        residualQuantity: '0.0042', reason: 'venue position changed during close',
        suggestion: 'retry one-click close or reduce manually',
      }],
      clean: false,
      fetchedAt: '2026-08-20T00:01:00.000Z',
    });
    expect(report.clean).toBe(false);
    expect(ResidualReportSchema.safeParse({ residuals: [], clean: true, fetchedAt: 'x' }).success).toBe(true);
  });
});

describe('spread quote alignment fields (v0.4.1)', () => {
  const baseRow = {
    pairType: 'SPOT_PERP', asset: 'BTC', leftSymbol: 'GATE_SPOT_BTC_USDT',
    rightSymbol: 'GATE_FUTURE_BTC_USDT', leftVenue: 'GATE', rightVenue: 'GATE',
    currentSpreadBps: 3.2, meanSpreadBps: 2.8, spreadVolatilityBps: 1.1, skewness: 0.1,
    excessKurtosis: 0.2, symmetric: true, ar1Coefficient: 0.4, halfLifeHours: 1.5,
    holdingCostBps: -0.5, bookDepthUsdt: 12_000, score: 72, sampleCount: 200,
    source: 'candles', updatedAt: '2026-08-20T00:00:00.000Z',
  };

  it('keeps a pre-v0.4.1 row parseable — every new field is optional', () => {
    expect(SpreadQualityRowSchema.parse(baseRow)).toMatchObject({ asset: 'BTC' });
  });

  it('carries the leg quote timestamps and alignment verdict when present', () => {
    const row = SpreadQualityRowSchema.parse({
      ...baseRow,
      leftQuoteUpdatedAt: '2026-08-20T00:00:00.000Z',
      rightQuoteUpdatedAt: '2026-08-20T00:00:01.000Z',
      quoteAligned: true,
    });
    expect(row.quoteAligned).toBe(true);
  });

  it('extends the spread-quality response with the sort/paging echo, optionally', () => {
    const base = {
      rows: [], totalCandidates: 0, windowHours: 24,
      fetchedAt: '2026-08-20T00:00:00.000Z', cacheStatus: 'fresh',
    };
    expect(SpreadQualityResponseSchema.parse(base)).toMatchObject({ totalCandidates: 0 });
    expect(SpreadQualityResponseSchema.parse({
      ...base, sort: 'mean', dir: 'asc', offset: 20, total: 47,
    })).toMatchObject({ sort: 'mean', total: 47 });
  });

  it('carries quote alignment on opportunity combinations', () => {
    const combination = SpreadCombinationSchema.parse({
      pairType: 'SPOT_PERP', leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'GATE_FUTURE_BTC_USDT',
      leftVenue: 'GATE', rightVenue: 'GATE', sellBid: '100.1', buyAsk: '100',
      spreadBps: 10, updatedAt: '2026-08-20T00:00:00.000Z', executable: true,
      quoteAligned: false,
    });
    expect(combination.quoteAligned).toBe(false);
  });
});

describe('execution-log category fetch set', () => {
  it('uses LIKE prefix patterns only for the open-ended leg diagnostics', () => {
    const allowedPatterns = STRATEGY_LOG_LEG_EVENT_PREFIXES.map((prefix) => `${prefix}%`);
    for (const category of STRATEGY_LOG_CATEGORIES) {
      if (category === 'all') continue;
      for (const entry of STRATEGY_LOG_CATEGORY_FETCH_EVENTS[category]) {
        if (!entry.includes('%')) {
          // An exact entry must be a real event the engine can write, otherwise it is a dead term.
          expect(Object.keys(STRATEGY_LOG_EVENT_CATEGORY)).toContain(entry);
          continue;
        }
        // A pattern must be a trailing-only wildcard, and one of the shared leg prefixes.
        expect(entry.endsWith('%')).toBe(true);
        expect(entry.slice(0, -1)).not.toContain('%');
        expect(allowedPatterns).toContain(entry);
      }
    }
  });

  it('carries the leg patterns in both execution and risk', () => {
    for (const category of ['execution', 'risk'] as const) {
      for (const prefix of STRATEGY_LOG_LEG_EVENT_PREFIXES) {
        expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS[category]).toContain(`${prefix}%`);
      }
    }
  });

  it('keeps every category a superset of its own enumerated events', () => {
    for (const category of STRATEGY_LOG_CATEGORIES) {
      if (category === 'all') continue;
      const own = Object.keys(STRATEGY_LOG_EVENT_CATEGORY)
        .filter((event) => STRATEGY_LOG_EVENT_CATEGORY[event] === category);
      for (const event of own) {
        expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS[category]).toContain(event);
      }
    }
  });
});
