import { describe, expect, it } from 'vitest';
import type { FundingOverviewResponse, LiveMarket } from '@gate-crossex/shared-types';
import {
  buildMarketStatsIndex,
  buildOpenInterestIndex,
  isFutureSymbol,
  isSpotSymbol,
  maxAmount,
  normalizeAmount,
  openInterestKey,
  resolveStats,
} from './opportunity-market-stats.js';

const EPOCH = '2026-08-01T00:00:00.000Z';

function market(overrides: Partial<LiveMarket> & Pick<LiveMarket, 'symbol'>): LiveMarket {
  return {
    venue: 'GATE', asset: 'BTC', lastPrice: '100', bidPrice: '99', bidSize: '1', askPrice: '101', askSize: '1',
    open24h: '100', high24h: '110', low24h: '90', volume24h: '0', quoteVolume24h: '0',
    fundingRate: '0', nextFundingAt: EPOCH, openInterest: '0', openInterestValue: '0',
    receivedAt: EPOCH, updatedAt: EPOCH, source: 'demo_seed',
    ...overrides,
  };
}

function overview(entries: Array<{ asset: string; venue: string; openInterestValue: string | null }>): FundingOverviewResponse {
  const byAsset = new Map<string, Array<{ venue: string; openInterestValue: string | null }>>();
  for (const entry of entries) {
    const list = byAsset.get(entry.asset) ?? [];
    list.push(entry);
    byAsset.set(entry.asset, list);
  }
  return {
    assets: [...byAsset.entries()].map(([asset, venues]) => ({
      asset,
      venues: venues.map((entry) => ({
        venue: entry.venue, symbol: `${entry.venue}_FUTURE_${asset}_USDT`, quote: 'USDT',
        fundingRate: '0.0001', fundingIntervalHours: 8, fundingRate8h: '0.0001', nextFundingAt: EPOCH,
        openInterestValue: entry.openInterestValue, lastPrice: '100', change24h: '0.01', fetchedAt: EPOCH,
      })),
    })),
    venueStatus: [],
    fetchedAt: EPOCH,
    cacheStatus: 'fresh',
  };
}

describe('normalizeAmount', () => {
  it('treats zero, blank and unparseable text as missing data', () => {
    expect(normalizeAmount('0')).toBeNull();
    expect(normalizeAmount('0.000')).toBeNull();
    expect(normalizeAmount('')).toBeNull();
    expect(normalizeAmount('   ')).toBeNull();
    expect(normalizeAmount('n/a')).toBeNull();
    expect(normalizeAmount(null)).toBeNull();
    expect(normalizeAmount(undefined)).toBeNull();
  });

  it('keeps real amounts as their upstream text', () => {
    expect(normalizeAmount('1234.5')).toBe('1234.5');
    expect(normalizeAmount(' 89000000.125 ')).toBe('89000000.125');
  });
});

describe('symbol shape helpers', () => {
  it('recognises CrossEx spot and perpetual symbols', () => {
    expect(isSpotSymbol('GATE_SPOT_BTC_USDT')).toBe(true);
    expect(isSpotSymbol('GATE_FUTURE_BTC_USDT')).toBe(false);
    expect(isFutureSymbol('GATE_FUTURE_BTC_USDT')).toBe(true);
    expect(isFutureSymbol('GATE_SPOT_BTC_USDT')).toBe(false);
    expect(isFutureSymbol('NOT_A_SYMBOL')).toBe(false);
  });
});

describe('buildMarketStatsIndex', () => {
  it('indexes by symbol and normalises every amount', () => {
    const index = buildMarketStatsIndex([
      market({ symbol: 'GATE_FUTURE_BTC_USDT', volume24h: '12', quoteVolume24h: '120000', openInterest: '5', openInterestValue: '50000' }),
      market({ symbol: 'GATE_SPOT_BTC_USDT', volume24h: '0', quoteVolume24h: '0', openInterest: '0', openInterestValue: '0' }),
    ]);
    expect(index.get('GATE_FUTURE_BTC_USDT')).toEqual({
      volume24h: '12', quoteVolume24h: '120000', openInterest: '5', openInterestValue: '50000',
    });
    // The placeholder zeros of a REST row with no published volume become nulls.
    expect(index.get('GATE_SPOT_BTC_USDT')).toEqual({
      volume24h: null, quoteVolume24h: null, openInterest: null, openInterestValue: null,
    });
  });

  it('keeps the richer row when a symbol appears twice', () => {
    const index = buildMarketStatsIndex([
      market({ symbol: 'GATE_FUTURE_BTC_USDT', volume24h: '0', quoteVolume24h: '0' }),
      market({ symbol: 'GATE_FUTURE_BTC_USDT', volume24h: '7', quoteVolume24h: '700', source: 'rest_book_ticker' }),
    ]);
    expect(index.get('GATE_FUTURE_BTC_USDT')?.quoteVolume24h).toBe('700');
  });
});

describe('buildOpenInterestIndex', () => {
  it('keys by ASSET:VENUE and drops missing values', () => {
    const index = buildOpenInterestIndex(overview([
      { asset: 'BTC', venue: 'GATE', openInterestValue: '2500000' },
      { asset: 'BTC', venue: 'BINANCE', openInterestValue: null },
      { asset: 'ETH', venue: 'OKX', openInterestValue: '0' },
    ]));
    expect(index.get(openInterestKey('BTC', 'GATE'))).toBe('2500000');
    expect(index.get(openInterestKey('BTC', 'BINANCE'))).toBeUndefined();
    expect(index.get(openInterestKey('ETH', 'OKX'))).toBeUndefined();
    expect(index.size).toBe(1);
  });

  it('survives an absent overview', () => {
    expect(buildOpenInterestIndex(null).size).toBe(0);
    expect(buildOpenInterestIndex(undefined).size).toBe(0);
  });
});

describe('resolveStats', () => {
  const index = buildMarketStatsIndex([
    market({ symbol: 'GATE_FUTURE_BTC_USDT', volume24h: '12', quoteVolume24h: '120000', openInterest: '5', openInterestValue: '50000' }),
  ]);
  const oiIndex = buildOpenInterestIndex(overview([
    { asset: 'ETH', venue: 'OKX', openInterestValue: '900000' },
  ]));

  it('uses the merged view when it carries the measurement', () => {
    expect(resolveStats('GATE_FUTURE_BTC_USDT', 'BTC', 'GATE', index, oiIndex)).toEqual({
      volume24h: '12', quoteVolume24h: '120000', openInterest: '5', openInterestValue: '50000',
    });
  });

  it('falls back to the funding-overview open interest for unsubscribed perpetuals', () => {
    const stats = resolveStats('OKX_FUTURE_ETH_USDT', 'ETH', 'OKX', index, oiIndex);
    expect(stats.volume24h).toBeNull();
    expect(stats.openInterestValue).toBe('900000');
  });

  it('clears open interest for spot legs by definition', () => {
    const stats = resolveStats('GATE_SPOT_BTC_USDT', 'BTC', 'GATE', index, oiIndex);
    expect(stats.openInterest).toBeNull();
    expect(stats.openInterestValue).toBeNull();
    // Volume is still legitimate for a spot leg.
    expect(stats.volume24h).toBeNull();
  });

  it('returns everything null for an unknown symbol', () => {
    expect(resolveStats('UNKNOWN', 'BTC', 'GATE', index, oiIndex)).toEqual({
      volume24h: null, quoteVolume24h: null, openInterest: null, openInterestValue: null,
    });
  });

  it('leaves Binance rows empty rather than fabricating a measurement', () => {
    const binanceIndex = buildMarketStatsIndex([
      market({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', volume24h: '0', quoteVolume24h: '0', openInterest: '0', openInterestValue: '0' }),
    ]);
    expect(resolveStats('BINANCE_FUTURE_BTC_USDT', 'BTC', 'BINANCE', binanceIndex, oiIndex)).toEqual({
      volume24h: null, quoteVolume24h: null, openInterest: null, openInterestValue: null,
    });
  });
});

describe('maxAmount', () => {
  it('picks the larger of two amounts and tolerates nulls', () => {
    expect(maxAmount('100', '250')).toBe('250');
    expect(maxAmount('250', '100')).toBe('250');
    expect(maxAmount(null, '100')).toBe('100');
    expect(maxAmount('100', null)).toBe('100');
    expect(maxAmount(null, null)).toBeNull();
  });
});
