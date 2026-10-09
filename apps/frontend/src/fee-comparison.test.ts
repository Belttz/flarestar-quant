import { describe, expect, it } from 'vitest';
import { feeComparisonRows, normalizeTicker, resolveCatalogTicker } from './fee-comparison.js';

describe('fee comparison', () => {
  const catalog = [{
    asset: 'BTC', streamed: true, venues: [
      { venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', quote: 'USDT', business: 'FUTURE' as const },
      { venue: 'BINANCE', symbol: 'BINANCE_FUTURE_BTC_USDT', quote: 'USDT', business: 'FUTURE' as const },
      { venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT', quote: 'USDT', business: 'FUTURE' as const },
    ],
  }];
  const fees = [
    { venue: 'GATE', spotMakerFee: '0.001', spotTakerFee: '0.001', futureMakerFee: '0.0002', futureTakerFee: '0.0005' },
    { venue: 'BINANCE', spotMakerFee: '0.001', spotTakerFee: '0.001', futureMakerFee: '0.0001', futureTakerFee: '0.0004', specialFees: [
      { symbol: 'BINANCE_FUTURE_BTC_USDT', makerFee: '0.00001', takerFee: '0.00002' },
    ] },
  ];

  it('normalizes common ticker input forms', () => {
    expect(normalizeTicker(' btc/usdt ')).toBe('BTC');
    expect(normalizeTicker('ETH_USDT')).toBe('ETH');
    expect(normalizeTicker('SOLUSDC')).toBe('SOLUSDC');
    expect(resolveCatalogTicker('BTCUSDT', catalog)).toBe('BTC');
    expect(resolveCatalogTicker('TUSD', [{ asset: 'TUSD', streamed: false, venues: [] }])).toBe('TUSD');
  });

  it('keeps listed venues with account fee data and ranks the cheapest taker first', () => {
    expect(feeComparisonRows('BTCUSDT', 10_000, catalog, fees)).toMatchObject([
      { venue: 'BINANCE', makerCost: 0.1, takerCost: 0.2, source: 'symbol' },
      { venue: 'GATE', makerCost: 2, takerCost: 5 },
    ]);
    expect(feeComparisonRows('BTC', 0, catalog, fees)).toEqual([]);
  });
});
