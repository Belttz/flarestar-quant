import { describe, expect, it } from 'vitest';
import type { MarketCatalogAsset } from './api.js';
import { rankStrategyAssetOptions, strategyAssetOptions, strategyVenueSymbol } from './strategy-asset-options.js';

const catalog: MarketCatalogAsset[] = [
  {
    asset: 'BTC',
    streamed: true,
    venues: [
      { venue: 'BINANCE', symbol: 'BINANCE_FUTURE_BTC_USDT', quote: 'USDT', business: 'FUTURE' },
      { venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT', quote: 'USDT', business: 'FUTURE' },
    ],
  },
  {
    asset: 'ETH',
    streamed: true,
    venues: [
      { venue: 'BINANCE', symbol: 'BINANCE_FUTURE_ETH_USDT', quote: 'USDT', business: 'FUTURE' },
    ],
  },
  {
    asset: 'SOL',
    streamed: false,
    venues: [
      { venue: 'BINANCE', symbol: 'BINANCE_FUTURE_SOL_USDT', quote: 'USDT', business: 'FUTURE' },
      { venue: 'OKX', symbol: 'OKX_FUTURE_SOL_USDT', quote: 'USDT', business: 'FUTURE' },
    ],
  },
];

describe('strategy asset search', () => {
  it('offers every catalog contract executable on both selected venues', () => {
    expect(strategyAssetOptions(catalog, [], 'binance', 'okx').map((option) => option.asset))
      .toEqual(['BTC', 'SOL']);
  });

  it('falls back to streamed assets while the full catalog loads', () => {
    expect(strategyAssetOptions(null, ['ETH', 'BTC', 'BTC'], 'binance', 'okx').map((option) => option.asset))
      .toEqual(['BTC', 'ETH']);
  });

  it('uses catalog-native symbols for aliased assets while displaying the canonical identity', () => {
    const aliasedCatalog: MarketCatalogAsset[] = [{
      asset: 'SKHYNIX',
      streamed: false,
      venues: [
        { venue: 'GATE', symbol: 'GATE_FUTURE_SKHYNIX_USDT', quote: 'USDT', business: 'FUTURE' },
        { venue: 'HYPERLIQUID', symbol: 'HYPERLIQUID_FUTURE_SKHX_USDC', quote: 'USDC', business: 'FUTURE' },
      ],
    }];

    expect(strategyAssetOptions(aliasedCatalog, [], 'gate', 'hyperliquid')).toEqual([{
      asset: 'SKHYNIX', leftQuote: 'USDT', rightQuote: 'USDC', streamed: false,
    }]);
    expect(strategyVenueSymbol(aliasedCatalog, 'hyperliquid', 'SKHYNIX'))
      .toBe('HYPERLIQUID_FUTURE_SKHX_USDC');
  });

  it('ranks exact matches before prefix and substring matches', () => {
    const options = strategyAssetOptions([
      ...catalog,
      {
        asset: 'WBTC',
        streamed: false,
        venues: [
          { venue: 'BINANCE', symbol: 'BINANCE_FUTURE_WBTC_USDT', quote: 'USDT', business: 'FUTURE' },
          { venue: 'OKX', symbol: 'OKX_FUTURE_WBTC_USDT', quote: 'USDT', business: 'FUTURE' },
        ],
      },
      {
        asset: 'BTC2',
        streamed: false,
        venues: [
          { venue: 'BINANCE', symbol: 'BINANCE_FUTURE_BTC2_USDT', quote: 'USDT', business: 'FUTURE' },
          { venue: 'OKX', symbol: 'OKX_FUTURE_BTC2_USDT', quote: 'USDT', business: 'FUTURE' },
        ],
      },
    ], [], 'binance', 'okx');

    expect(rankStrategyAssetOptions(options, 'BTC', 'SOL').map((option) => option.asset))
      .toEqual(['BTC', 'BTC2', 'WBTC']);
  });
});
