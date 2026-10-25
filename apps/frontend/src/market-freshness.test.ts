import { describe, expect, it } from 'vitest';
import type { Candle, LiveMarket, MarketSnapshot } from './api.js';
import { SPREAD_QUOTE_MAX_SKEW_MS, assessMarketPairFreshness, assessSpreadQuoteAlignment, candleTailIsFresh, freshMarketPair, lastKnownLiveMarketPair } from './market-freshness.js';

function market(
  symbol: string,
  updatedAt: number,
  source: LiveMarket['source'] = 'gate_crossex_websocket',
  receivedAt = updatedAt,
): LiveMarket {
  const [venue = 'GATE', , asset = 'SKHY'] = symbol.split('_');
  return {
    symbol, venue, asset, lastPrice: '1', bidPrice: '1', bidSize: '1', askPrice: '1', askSize: '1',
    open24h: '1', high24h: '1', low24h: '1', volume24h: '1', quoteVolume24h: '1',
    fundingRate: '0', nextFundingAt: new Date(updatedAt).toISOString(), openInterest: '1',
    openInterestValue: '1', receivedAt: new Date(receivedAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(), source,
  };
}

function candle(startTime: number): Candle {
  return { startTime, open: '1', high: '1', low: '1', close: '1', volume: '1', closed: true };
}

describe('premium market freshness', () => {
  const now = Date.parse('2026-07-31T12:00:00.000Z');
  const leftSymbol = 'GATE_FUTURE_SKHY_USDT';
  const rightSymbol = 'GATE_FUTURE_SKHYNIX_USDT';

  function snapshot(leftAt = now, rightAt = now): MarketSnapshot {
    return {
      connectionState: 'healthy',
      updatedAt: new Date(now).toISOString(),
      markets: [market(leftSymbol, leftAt), market(rightSymbol, rightAt)],
    };
  }

  it('accepts only a healthy, fresh, promptly delivered live pair', () => {
    expect(freshMarketPair(snapshot(), leftSymbol, rightSymbol, now)).not.toBeNull();
    expect(freshMarketPair(snapshot(now - 16_000, now), leftSymbol, rightSymbol, now)).toBeNull();
    expect(freshMarketPair(snapshot(now - 5_000, now), leftSymbol, rightSymbol, now)).not.toBeNull();
    // Independently published tickers may have different source times without being unhealthy.
    expect(freshMarketPair(snapshot(now - 6_000, now), leftSymbol, rightSymbol, now)).not.toBeNull();
    const delayed = snapshot();
    delayed.markets[0] = market(leftSymbol, now - 4_000, 'gate_crossex_websocket', now);
    expect(freshMarketPair(delayed, leftSymbol, rightSymbol, now)).toBeNull();
    expect(freshMarketPair({ ...snapshot(), connectionState: 'stale' }, leftSymbol, rightSymbol, now)).toBeNull();
    const seeded = snapshot();
    seeded.markets[0] = market(leftSymbol, now, 'demo_seed');
    expect(freshMarketPair(seeded, leftSymbol, rightSymbol, now)).toBeNull();
  });

  it('reports the reason a live pair is not executable', () => {
    expect(assessMarketPairFreshness(null, leftSymbol, rightSymbol, now).reason).toBe('feed');
    expect(assessMarketPairFreshness({ ...snapshot(), markets: [] }, leftSymbol, rightSymbol, now).reason).toBe('missing');
    const seeded = snapshot();
    seeded.markets[0] = market(leftSymbol, now, 'demo_seed');
    expect(assessMarketPairFreshness(seeded, leftSymbol, rightSymbol, now).reason).toBe('non_live');
    expect(assessMarketPairFreshness(snapshot(now - 16_000, now), leftSymbol, rightSymbol, now).reason).toBe('stale');
    const delayed = snapshot();
    delayed.markets[0] = market(leftSymbol, now - 4_000, 'gate_crossex_websocket', now);
    expect(assessMarketPairFreshness(delayed, leftSymbol, rightSymbol, now).reason).toBe('delayed');
  });

  it('keeps last-known streamed prices displayable without making them executable', () => {
    const stale = snapshot(now - 60_000, now - 45_000);
    expect(freshMarketPair(stale, leftSymbol, rightSymbol, now)).toBeNull();
    expect(lastKnownLiveMarketPair(stale, leftSymbol, rightSymbol)).toEqual({
      left: stale.markets[0],
      right: stale.markets[1],
    });

    stale.markets[0] = market(leftSymbol, now, 'demo_seed');
    expect(lastKnownLiveMarketPair(stale, leftSymbol, rightSymbol)).toBeNull();
  });

  it('rejects an old candle tail instead of rendering cached history as live', () => {
    expect(candleTailIsFresh([candle(now - 60_000)], '1m', now)).toBe(true);
    expect(candleTailIsFresh([candle(now - 3 * 60_000)], '1m', now)).toBe(false);
    expect(candleTailIsFresh([candle(now - 9 * 60_000)], '5m', now)).toBe(true);
  });
});

describe('spread quote alignment', () => {
  const now = Date.parse('2026-07-31T12:00:00.000Z');
  const left = { quoteUpdatedAt: new Date(now - 500).toISOString() };
  const right = { quoteUpdatedAt: new Date(now + 500).toISOString() };

  it('accepts a pair whose quote timestamps fit the shared 2000ms budget', () => {
    expect(SPREAD_QUOTE_MAX_SKEW_MS).toBe(2_000);
    expect(assessSpreadQuoteAlignment(left, right)).toEqual({ aligned: true, skewMs: 1_000 });
  });

  it('rejects a pair whose quotes are further apart than the budget', () => {
    const far = { quoteUpdatedAt: new Date(now - 4_000).toISOString() };
    const verdict = assessSpreadQuoteAlignment(far, right);
    expect(verdict).toEqual({ aligned: false, skewMs: 4_500, reason: 'skew_exceeded' });
  });

  it('never treats a missing quote timestamp as aligned', () => {
    expect(assessSpreadQuoteAlignment({}, right)).toMatchObject({ aligned: false, reason: 'missing_quote_timestamp' });
    expect(assessSpreadQuoteAlignment(left, {})).toMatchObject({ aligned: false, reason: 'missing_quote_timestamp' });
    expect(assessSpreadQuoteAlignment({}, {})).toMatchObject({ aligned: false, reason: 'missing_quote_timestamp' });
  });

  it('honours a caller-provided budget override', () => {
    expect(assessSpreadQuoteAlignment(left, right, 500).aligned).toBe(false);
    expect(assessSpreadQuoteAlignment(left, right, 1_000).aligned).toBe(true);
  });
});
