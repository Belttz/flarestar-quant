import { describe, expect, it } from 'vitest';
import { orderBusiness, symbolParts } from './route-shared.js';

describe('orderBusiness', () => {
  it('classifies every connected venue spot symbol as SPOT', () => {
    const venues = ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT', 'LIGHTER'];
    for (const venue of venues) {
      expect(orderBusiness(`${venue}_SPOT_BTC_USDT`)).toBe('SPOT');
      expect(orderBusiness(`${venue}_SPOT_ETH_USDC`)).toBe('SPOT');
    }
  });

  it('classifies every connected venue future symbol as FUTURE', () => {
    const venues = ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT', 'LIGHTER'];
    for (const venue of venues) {
      expect(orderBusiness(`${venue}_FUTURE_BTC_USDT`)).toBe('FUTURE');
      expect(orderBusiness(`${venue}_FUTURE_HYPE_USDC`)).toBe('FUTURE');
    }
  });

  it('keeps the KRAKEN USD future on the futures side', () => {
    expect(orderBusiness('KRAKEN_FUTURE_BTC_USD')).toBe('FUTURE');
  });

  it('degrades unparseable symbols to FUTURE instead of guessing', () => {
    expect(orderBusiness('')).toBe('FUTURE');
    expect(orderBusiness('GATE_SPOT')).toBe('FUTURE');
    expect(orderBusiness('garbage')).toBe('FUTURE');
    // A spot segment that is not the business segment must not flip the verdict.
    expect(orderBusiness('GATE_FUTURE_SPOT_USDT')).toBe('FUTURE');
  });

  it('matches the backend isSpotSymbol rule verbatim', () => {
    // trading-runtime.ts:30 uses /^[A-Z0-9]+_SPOT_/; assert the exact boundary behaviour.
    const isSpotSymbol = (symbol: string): boolean => /^[A-Z0-9]+_SPOT_/.test(symbol);
    for (const symbol of [
      'GATE_SPOT_BTC_USDT', 'GATE_FUTURE_BTC_USDT', 'BINANCE_SPOT_BTC_USDC', '', 'garbage',
      'gate_spot_btc_usdt', 'GATE_SPOTX_BTC_USDT', 'GATEX_SPOT_BTC_USDT',
    ]) {
      expect(orderBusiness(symbol)).toBe(isSpotSymbol(symbol) ? 'SPOT' : 'FUTURE');
    }
  });
});

describe('symbolParts', () => {
  it('keeps the original venue/asset/quote output and adds the business segment', () => {
    expect(symbolParts('GATE_SPOT_BTC_USDT')).toEqual({ venue: 'GATE', business: 'SPOT', asset: 'BTC', quote: 'USDT' });
    expect(symbolParts('OKX_FUTURE_HYPE_USDT')).toEqual({ venue: 'OKX', business: 'FUTURE', asset: 'HYPE', quote: 'USDT' });
  });

  it('preserves the legacy fallbacks for malformed symbols', () => {
    // venue → first segment, asset → the whole symbol, quote → 'USDT' (unchanged historical behaviour).
    expect(symbolParts('garbage')).toEqual({ venue: 'garbage', business: 'FUTURE', asset: 'garbage', quote: 'USDT' });
    expect(symbolParts('GATE_SPOT')).toEqual({ venue: 'GATE', business: 'FUTURE', asset: 'GATE_SPOT', quote: 'USDT' });
  });
});
