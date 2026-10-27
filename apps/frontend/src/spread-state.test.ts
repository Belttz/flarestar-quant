import { describe, expect, it } from 'vitest';
import {
  buildPairHistoryReadout,
  buildSpreadReadout,
  legQuoteStateKey,
  resolveLegQuote,
  usablePrice,
  usableTimestamp,
  type LegQuote,
} from './spread-state.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

/**
 * A streamed market record. `quoteAgeMs` dates the venue's own event time; `localAgeMs` dates the
 * moment we received it. They are deliberately independent so the tests can reproduce a venue clock
 * that drifts away from ours.
 */
function streamMarket(bid: string, ask: string, quoteAgeMs = 0, localAgeMs = quoteAgeMs) {
  return {
    source: 'gate_crossex_websocket' as const,
    bidPrice: bid,
    askPrice: ask,
    quoteUpdatedAt: at(-quoteAgeMs),
    quoteReceivedAt: NOW - localAgeMs,
    receivedAt: at(-localAgeMs),
  };
}

function leg(price: number | null, quotedAtMs: number | null, state: LegQuote['state'] = 'live'): LegQuote {
  return {
    state,
    price,
    bid: price,
    ask: price,
    quotedAtMs,
    ageMs: quotedAtMs === null ? null : NOW - quotedAtMs,
    source: price === null ? 'none' : 'stream',
  };
}

describe('usablePrice / usableTimestamp', () => {
  it('never fabricates a zero from an absent quote', () => {
    expect(usablePrice(undefined)).toBeNull();
    expect(usablePrice(null)).toBeNull();
    expect(usablePrice('')).toBeNull();
    expect(usablePrice('0')).toBeNull();
    expect(usablePrice('-1')).toBeNull();
    expect(usablePrice('abc')).toBeNull();
    expect(usablePrice('12.5')).toBe(12.5);
  });

  it('rejects unparseable timestamps instead of returning NaN', () => {
    expect(usableTimestamp(undefined)).toBeNull();
    expect(usableTimestamp('')).toBeNull();
    expect(usableTimestamp('not-a-date')).toBeNull();
    expect(usableTimestamp(at(0))).toBe(NOW);
  });
});

describe('resolveLegQuote', () => {
  it('reads the requested side of a fresh streamed quote', () => {
    const sell = resolveLegQuote({ market: streamMarket('100', '100.5', 1_000) }, 'bid', { now: NOW });
    expect(sell).toMatchObject({ state: 'live', price: 100, source: 'stream' });
    const buy = resolveLegQuote({ market: streamMarket('100', '100.5', 1_000) }, 'ask', { now: NOW });
    expect(buy).toMatchObject({ state: 'live', price: 100.5, source: 'stream' });
  });

  it('reports an aged quote as stale rather than live', () => {
    const quote = resolveLegQuote({ market: streamMarket('100', '100.5', 60_000) }, 'bid', { now: NOW });
    expect(quote.state).toBe('stale');
    // The price is still shown — the caller labels it, it does not disappear.
    expect(quote.price).toBe(100);
  });

  it('treats a quote without a timestamp as not executable', () => {
    const quote = resolveLegQuote({
      market: { source: 'gate_crossex_websocket', bidPrice: '100', askPrice: '101' },
    }, 'bid', { now: NOW });
    expect(quote).toMatchObject({ state: 'stale', quotedAtMs: null, ageMs: null });
  });

  it('ignores seeded placeholder markets: an invented price is never a quote', () => {
    const quote = resolveLegQuote({
      market: { source: 'demo_seed', bidPrice: '100', askPrice: '101', quoteUpdatedAt: at(0) },
    }, 'bid', { now: NOW });
    expect(quote.state).toBe('missing');
  });

  it('reads the same market through the depth endpoint when the page stream has no side price', () => {
    const quote = resolveLegQuote({
      market: { source: 'gate_crossex_websocket', bidPrice: '0', askPrice: '0', quoteUpdatedAt: at(0) },
      topOfBook: { bestBid: '42.5', bestAsk: '42.6', updatedAt: at(-500) },
    }, 'bid', { now: NOW });
    expect(quote).toMatchObject({ state: 'live', price: 42.5, source: 'books-top' });
  });

  it('answers for a leg the page snapshot does not carry at all', () => {
    // No streamed record: the depth endpoint also registers the market server-side, which is how a
    // leg that never entered this page's watch list still gets a quote.
    const quote = resolveLegQuote({
      market: null,
      topOfBook: { bestBid: '42.5', bestAsk: '42.6', updatedAt: at(0) },
    }, 'ask', { now: NOW });
    expect(quote).toMatchObject({ state: 'live', price: 42.6, source: 'books-top' });
  });

  it('reports missing when neither source has a price for that side', () => {
    const quote = resolveLegQuote({
      market: streamMarket('0', '0', 0),
      topOfBook: { bestBid: null, bestAsk: '42.6', updatedAt: at(0) },
    }, 'bid', { now: NOW });
    expect(quote).toMatchObject({ state: 'missing', price: null, source: 'none' });
  });
});

describe('buildSpreadReadout', () => {
  it('produces bps only for two live, contemporaneous legs', () => {
    const readout = buildSpreadReadout({
      sell: leg(101, NOW - 200),
      buy: leg(100, NOW - 400),
    });
    expect(readout.status).toBe('live');
    expect(readout.reason).toBe('ready');
    expect(readout.bps).toBeCloseTo(100, 6);
    expect(readout.gap).toBeCloseTo(1, 9);
    expect(readout.skewMs).toBe(200);
  });

  it('never turns a missing leg into 0 bps', () => {
    const readout = buildSpreadReadout({ sell: leg(null, null, 'missing'), buy: leg(100, NOW) });
    expect(readout).toMatchObject({ status: 'waiting', reason: 'missing_sell_leg', bps: null, gap: null });
    expect(readout.messageKey).toBe('Waiting for the missing leg quote');
  });

  it('names the both-missing case', () => {
    const readout = buildSpreadReadout({ sell: leg(null, null, 'missing'), buy: leg(null, null, 'missing') });
    expect(readout.status).toBe('waiting');
    expect(readout.messageKey).toBe('Waiting for both leg prices');
  });

  it('refuses a spread built from a stale leg', () => {
    const readout = buildSpreadReadout({ sell: leg(101, NOW - 90_000, 'stale'), buy: leg(100, NOW) });
    expect(readout).toMatchObject({ status: 'stale', reason: 'stale', bps: null });
    // Both prices stay on screen so the user sees what the legs last traded at.
    expect(readout.sellPrice).toBe(101);
    expect(readout.buyPrice).toBe(100);
  });

  it('still shows the spread when the legs quote seconds apart, labelled as out of sync', () => {
    const readout = buildSpreadReadout({ sell: leg(101, NOW), buy: leg(100, NOW - 30_000) });
    // Hiding the number was the bug: a 30s gap is annotated, not blanked.
    expect(readout).toMatchObject({
      status: 'approximate', reason: 'skew_exceeded', approximate: true, bps: 100, skewMs: 30_000,
    });
    expect(readout.gap).toBeCloseTo(1);
    expect(readout.messageKey).toBe('Legs out of sync');
  });

  it('accepts a pair exactly at the skew budget', () => {
    const readout = buildSpreadReadout({ sell: leg(101, NOW), buy: leg(100, NOW - 2_000), maxSkewMs: 2_000 });
    expect(readout.status).toBe('live');
  });

  it('labels leg states for the market cells', () => {
    expect(legQuoteStateKey('live')).toBe('Live');
    expect(legQuoteStateKey('stale')).toBe('Stale quote');
    expect(legQuoteStateKey('missing')).toBe('No quote');
  });
});

/**
 * Cross-leg alignment runs on the local arrival clock. Using the venues' own event timestamps made
 * every pair involving a drifting exchange permanently "unaligned", which is what users saw as
 * "the spread for those exchanges never shows up".
 */
describe('spread readout clocks', () => {
  it('pairs two legs whose venue clocks differ by 5s but which arrived 100ms apart', () => {
    // Venue A's clock is 5s ahead of ours, venue B's is 4s behind: by event time they are 9s apart.
    const sellLeg = resolveLegQuote({ market: streamMarket('100', '100.1', 5_000, 100) }, 'bid', { now: NOW });
    const buyLeg = resolveLegQuote({ market: streamMarket('99', '99.1', -4_000, 200) }, 'ask', { now: NOW });
    expect(sellLeg.quotedAtMs).toBe(NOW - 100);
    expect(buyLeg.quotedAtMs).toBe(NOW - 200);

    const readout = buildSpreadReadout({ sell: sellLeg, buy: buyLeg });
    expect(readout.status).toBe('live');
    expect(readout.skewMs).toBe(100);
    expect(readout.bps).toBeCloseTo(((100 - 99.1) / 99.1) * 10_000, 6);
  });

  it('judges quote age on the local clock, not on the venue clock', () => {
    // The venue claims the quote is 40s old; we received it 1s ago.
    const freshLocally = resolveLegQuote({ market: streamMarket('100', '101', 40_000, 1_000) }, 'bid', { now: NOW });
    expect(freshLocally).toMatchObject({ state: 'live', ageMs: 1_000 });

    // The reverse: the venue says "just now" but we have been holding this quote for 20s.
    const staleLocally = resolveLegQuote({ market: streamMarket('100', '101', 0, 20_000) }, 'bid', { now: NOW });
    expect(staleLocally).toMatchObject({ state: 'stale', ageMs: 20_000 });

    const readout = buildSpreadReadout({
      sell: staleLocally,
      buy: resolveLegQuote({ market: streamMarket('99', '99.1', 0, 0) }, 'ask', { now: NOW }),
    });
    expect(readout.status).toBe('stale');
    expect(readout.bps).toBeNull();
  });

  it('falls back to the legacy timestamps when quoteReceivedAt is absent', () => {
    // Pre-upgrade payload: no `quoteReceivedAt`, and no `receivedAt` either, so the venue timestamp
    // is all we have — exactly the behaviour before the local clock existed.
    const legacy = { source: 'gate_crossex_websocket' as const, bidPrice: '100', askPrice: '101', quoteUpdatedAt: at(-1_000) };
    const quote = resolveLegQuote({ market: legacy }, 'bid', { now: NOW });
    expect(quote).toMatchObject({ state: 'live', ageMs: 1_000, quotedAtMs: NOW - 1_000 });

    const tooOld = { ...legacy, quoteUpdatedAt: at(-20_000) };
    expect(resolveLegQuote({ market: tooOld }, 'bid', { now: NOW }).state).toBe('stale');
  });
});

describe('buildPairHistoryReadout', () => {
  it('is ready as soon as the derived series has a point', () => {
    const readout = buildPairHistoryReadout({ status: 'live', pointCount: 12, leftCount: 300, rightCount: 300 });
    expect(readout).toMatchObject({ phase: 'ready', missingLegs: [], retryable: false });
  });

  it('distinguishes a request failure from an empty series', () => {
    const failed = buildPairHistoryReadout({ status: 'failed', pointCount: 0, leftCount: 0, rightCount: 300 });
    expect(failed).toMatchObject({ phase: 'failed', retryable: true, missingLegs: ['left'] });
    expect(failed.messageKey).toBe('Price-difference history unavailable');
  });

  it('keeps the loading phase while the first paint is still settling', () => {
    const readout = buildPairHistoryReadout({ status: 'live', pointCount: 0, leftCount: 0, rightCount: 0, leftBuilding: true });
    expect(readout.phase).toBe('loading');
    expect(readout.retryable).toBe(false);
  });

  it('reports which leg has no history once the fetch settled', () => {
    const readout = buildPairHistoryReadout({ status: 'live', pointCount: 0, leftCount: 300, rightCount: 0 });
    expect(readout).toMatchObject({ phase: 'missing-leg', missingLegs: ['right'], retryable: true });
    expect(readout.messageKey).toBe('No candle history for this venue leg');
  });

  it('reports a genuine overlap gap when both series have candles', () => {
    const readout = buildPairHistoryReadout({ status: 'live', pointCount: 0, leftCount: 200, rightCount: 200 });
    expect(readout).toMatchObject({ phase: 'no-overlap', missingLegs: [], retryable: false });
    expect(readout.messageKey).toBe('No overlapping candles for this venue pair.');
  });

  it('treats an empty settled pair as retryable', () => {
    const readout = buildPairHistoryReadout({ status: 'live', pointCount: 0, leftCount: 0, rightCount: 0 });
    expect(readout).toMatchObject({ phase: 'missing-leg', retryable: true });
  });
});
