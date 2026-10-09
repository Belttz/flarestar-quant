import { describe, expect, it } from 'vitest';
import type { FundingOpportunity, FundingOverviewAsset } from '@gate-crossex/shared-types';
import {
  FUNDING_PERIODS_PER_YEAR,
  buildCarryFundingHedges,
  buildPerpFundingHedges,
  buildVenueFundingRanking,
  formatFundingCountdown,
  formatFundingInterval,
  formatFundingPercent,
  fundingApyPercent,
  fundingCountdownMs,
  hedgeFundingLeg,
  hedgeNet24hPercent,
  hedgePairLabel,
  orientFundingHedge,
  sortFundingHedges,
} from './funding-hedge.js';

function venueEntry(overrides: Partial<FundingOverviewAsset['venues'][number]> = {}): FundingOverviewAsset['venues'][number] {
  return {
    venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', quote: 'USDT',
    fundingRate: '0.0001', fundingIntervalHours: 8, fundingRate8h: '0.0001',
    nextFundingAt: '2026-10-10T00:00:00.000Z', openInterestValue: '1000000',
    lastPrice: '62000', change24h: '0.01', fetchedAt: '2026-10-09T12:00:00.000Z',
    ...overrides,
  };
}

function asset(venues: FundingOverviewAsset['venues'], code = 'BTC'): FundingOverviewAsset {
  return { asset: code, venues };
}

function carryRow(overrides: Partial<FundingOpportunity> = {}): FundingOpportunity {
  return {
    asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', spotSymbol: 'GATE_SPOT_BTC_USDT',
    spotVenue: 'GATE', spotVenues: ['GATE'], direction: 'POSITIVE', fundingApr: 15,
    fundingRate8h: '0.00013698', fundingIntervalHours: 8, nextFundingAt: '2026-10-10T00:00:00.000Z',
    lastPrice: '62000', executable: true, assetClass: 'TOKEN', assetSuperClass: 'CRYPTO',
    variantSuffix: null, isPreIpo: false, perpStats: null,
    ...overrides,
  };
}

describe('funding annualization', () => {
  it('compounds the per-settlement rate into an APY above the simple APR', () => {
    const apr = 0.05 * FUNDING_PERIODS_PER_YEAR;
    const apy = fundingApyPercent(0.05, FUNDING_PERIODS_PER_YEAR);
    expect(apy).toBeGreaterThan(apr);
    expect(apy).toBeCloseTo(((1.0005 ** FUNDING_PERIODS_PER_YEAR) - 1) * 100, 6);
  });

  it('degrades gracefully on non-finite input', () => {
    expect(fundingApyPercent(Number.NaN, 1095)).toBe(0);
    expect(fundingApyPercent(1, 0)).toBe(0);
  });
});

describe('orientFundingHedge', () => {
  const leg = (venue: string, rate8hPercent: number | null, kind: 'spot' | 'perp' = 'perp') => ({
    venue, symbol: `${venue}_FUTURE_BTC_USDT`, kind, ratePercent: rate8hPercent,
    rate8hPercent, intervalHours: 8, nextFundingAt: null,
  });

  it('shorts the higher-rate venue and returns an absolute net', () => {
    const oriented = orientFundingHedge(leg('GATE', 0.01), leg('BYBIT', -0.02));
    expect(oriented?.short.venue).toBe('GATE');
    expect(oriented?.long.venue).toBe('BYBIT');
    expect(oriented?.net8hPercent).toBeCloseTo(0.03, 10);
  });

  it('treats a spot leg as a zero rate so a negative perpetual still nets positive', () => {
    const oriented = orientFundingHedge(leg('GATE', -0.04), leg('BINANCE', null, 'spot'));
    expect(oriented?.short.venue).toBe('BINANCE');
    expect(oriented?.long.venue).toBe('GATE');
    expect(oriented?.net8hPercent).toBeCloseTo(0.04, 10);
  });

  it('drops a pair whose perpetual leg has no comparable rate', () => {
    expect(orientFundingHedge(leg('GATE', null), leg('OKX', 0.01))).toBeNull();
  });
});

describe('buildPerpFundingHedges', () => {
  it('emits one row per asset and venue pair inside the selection', () => {
    const rows = buildPerpFundingHedges([
      asset([
        venueEntry({ venue: 'GATE', fundingRate8h: '0.0001', openInterestValue: '1000000' }),
        venueEntry({ venue: 'BYBIT', symbol: 'BYBIT_FUTURE_BTC_USDT', fundingRate8h: '-0.0002', openInterestValue: '400000' }),
        venueEntry({ venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT', fundingRate8h: '0.00005' }),
      ]),
    ], ['GATE', 'BYBIT', 'OKX']);
    expect(rows).toHaveLength(3);
    const gateBybit = rows.find((row) => row.key === 'BTC:BYBIT:GATE');
    expect(gateBybit).toMatchObject({ pair: ['BYBIT', 'GATE'], asset: 'BTC' });
    expect(gateBybit?.short.venue).toBe('GATE');
    expect(gateBybit?.long.venue).toBe('BYBIT');
    expect(gateBybit?.net8hPercent).toBeCloseTo(0.03, 10);
    expect(gateBybit?.aprPercent).toBeCloseTo(0.03 * FUNDING_PERIODS_PER_YEAR, 6);
    expect(gateBybit?.openInterestValue).toBe(1_400_000);
    expect(gateBybit?.carry).toBeNull();
  });

  it('honours the venue selection and skips unrated legs', () => {
    const rows = buildPerpFundingHedges([
      asset([
        venueEntry({ venue: 'GATE' }),
        venueEntry({ venue: 'BYBIT', symbol: 'BYBIT_FUTURE_BTC_USDT', fundingRate8h: null, fundingRate: null }),
        venueEntry({ venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT' }),
      ]),
    ], ['GATE', 'OKX']);
    expect(rows.map((row) => row.key)).toEqual(['BTC:GATE:OKX']);
  });
});

describe('buildCarryFundingHedges', () => {
  it('maps a spot-perp carry row into the hedge model and keeps its prefill source', () => {
    const row = carryRow();
    const [hedge] = buildCarryFundingHedges([row]);
    expect(hedge).toMatchObject({ key: 'BTC:GATE:GATE', asset: 'BTC' });
    expect(hedge?.short.venue).toBe('GATE');
    expect(hedge?.short.kind).toBe('perp');
    expect(hedge?.long.kind).toBe('spot');
    expect(hedge?.carry).toBe(row);
    expect(hedge?.net8hPercent).toBeCloseTo(0.013698, 9);
  });

  it('flips the orientation when the perpetual funding is negative', () => {
    const [hedge] = buildCarryFundingHedges([carryRow({ direction: 'NEGATIVE', fundingRate8h: '-0.0002' })]);
    expect(hedge?.short.kind).toBe('spot');
    expect(hedge?.long.kind).toBe('perp');
    expect(hedge?.net8hPercent).toBeCloseTo(0.02, 9);
  });
});

describe('hedgeNet24hPercent', () => {
  const base = buildPerpFundingHedges([
    asset([
      venueEntry({ venue: 'GATE', fundingRate8h: '0.0001' }),
      venueEntry({ venue: 'BYBIT', symbol: 'BYBIT_FUTURE_BTC_USDT', fundingRate8h: '-0.0002' }),
    ]),
  ], ['GATE', 'BYBIT'])[0]!;

  it('subtracts the long leg cumulative funding from the short leg', () => {
    const net = hedgeNet24hPercent(base, {
      GATE_FUTURE_BTC_USDT: historyEntry('GATE_FUTURE_BTC_USDT', '0.0009'),
      BYBIT_FUTURE_BTC_USDT: historyEntry('BYBIT_FUTURE_BTC_USDT', '-0.0003'),
    });
    expect(net).toBeCloseTo(0.12, 9);
  });

  it('stays unknown until both legs have usable history', () => {
    expect(hedgeNet24hPercent(base, { GATE_FUTURE_BTC_USDT: historyEntry('GATE_FUTURE_BTC_USDT', '0.0009') })).toBeNull();
    expect(hedgeNet24hPercent(base, {
      GATE_FUTURE_BTC_USDT: { ...historyEntry('GATE_FUTURE_BTC_USDT', null), status: 'unavailable' },
      BYBIT_FUTURE_BTC_USDT: historyEntry('BYBIT_FUTURE_BTC_USDT', '-0.0003'),
    })).toBeNull();
  });
});

function historyEntry(symbol: string, rate24h: string | null) {
  return {
    symbol, status: 'ok' as const, rate24h, rate7d: null, rate30d: null,
    settlementCount30d: 3, oldestFundingAt: null, newestFundingAt: null,
    fetchedAt: '2026-10-09T12:00:00.000Z',
  };
}

describe('countdown and formatting', () => {
  const now = Date.parse('2026-10-09T12:00:00.000Z');

  it('formats hours and minutes, minutes only, and an expired settlement', () => {
    expect(formatFundingCountdown(fundingCountdownMs('2026-10-11T11:00:00.000Z', now))).toBe('47h 0m');
    expect(formatFundingCountdown(fundingCountdownMs('2026-10-09T12:46:00.000Z', now))).toBe('46m');
    expect(formatFundingCountdown(fundingCountdownMs('2026-10-09T11:00:00.000Z', now))).toBe('now');
    expect(formatFundingCountdown(fundingCountdownMs(null, now))).toBe('—');
    expect(formatFundingCountdown(fundingCountdownMs('not-a-date', now))).toBe('—');
  });

  it('formats percents and intervals', () => {
    expect(formatFundingPercent(0.1234)).toBe('+0.1234%');
    expect(formatFundingPercent(-0.12)).toBe('-0.1200%');
    expect(formatFundingPercent(null)).toBe('—');
    expect(formatFundingInterval(8)).toBe('8h');
    expect(formatFundingInterval(4)).toBe('4h');
    expect(formatFundingInterval(null)).toBeNull();
  });
});

describe('sortFundingHedges', () => {
  const rows = buildPerpFundingHedges([
    asset([
      venueEntry({ venue: 'GATE', fundingRate8h: '0.0001', openInterestValue: '10', nextFundingAt: '2026-10-10T08:00:00.000Z' }),
      venueEntry({ venue: 'BYBIT', symbol: 'BYBIT_FUTURE_BTC_USDT', fundingRate8h: '-0.0002', openInterestValue: '10' }),
    ]),
    asset([
      venueEntry({ venue: 'GATE', symbol: 'GATE_FUTURE_ETH_USDT', fundingRate8h: '0.00005', openInterestValue: '100' }),
      venueEntry({ venue: 'BYBIT', symbol: 'BYBIT_FUTURE_ETH_USDT', fundingRate8h: '0.0005', openInterestValue: '100', nextFundingAt: '2026-10-11T12:00:00.000Z' }),
    ], 'ETH'),
  ], ['GATE', 'BYBIT']);
  const now = Date.parse('2026-10-09T12:00:00.000Z');

  it('orders by the signed columns in both directions', () => {
    expect(sortFundingHedges(rows, 'net', 'desc', now).map((row) => row.asset)).toEqual(['ETH', 'BTC']);
    expect(sortFundingHedges(rows, 'net', 'asc', now).map((row) => row.asset)).toEqual(['BTC', 'ETH']);
    expect(sortFundingHedges(rows, 'asset', 'asc', now).map((row) => row.asset)).toEqual(['BTC', 'ETH']);
  });

  it('orders by open interest and by settlement countdown', () => {
    expect(sortFundingHedges(rows, 'oi', 'desc', now).map((row) => row.asset)).toEqual(['ETH', 'BTC']);
    expect(sortFundingHedges(rows, 'countdown', 'desc', now).map((row) => row.key))
      .toEqual(sortFundingHedges(rows, 'countdown', 'asc', now).map((row) => row.key).reverse());
  });

  it('exposes the settlement leg and a readable pair label', () => {
    const [row] = rows;
    expect(hedgeFundingLeg(row!).venue).toBe('GATE');
    expect(hedgePairLabel(row!)).toBe('Bybit ⇄ Gate.io');
  });
});

describe('buildVenueFundingRanking', () => {
  const overview = [
    asset([
      venueEntry({ venue: 'BINANCE', symbol: 'BINANCE_FUTURE_TIMI_USDT', fundingRate: '-0.01', fundingIntervalHours: 8, openInterestValue: '2000' }),
    ], 'TIMI'),
    asset([
      venueEntry({ venue: 'BINANCE', symbol: 'BINANCE_FUTURE_NG_USDT', fundingRate: '0.007568' }),
      venueEntry({ venue: 'OKX', symbol: 'OKX_FUTURE_NG_USDT', fundingRate: '0.02' }),
    ], 'NG'),
    asset([
      venueEntry({ venue: 'BINANCE', symbol: 'BINANCE_FUTURE_BWET_USDT', fundingRate: '0.00715' }),
    ], 'BWET'),
  ];

  it('ranks one venue by absolute rate and drops the others', () => {
    const rows = buildVenueFundingRanking(overview, 'BINANCE', 50);
    expect(rows.map((row) => row.asset)).toEqual(['TIMI', 'NG', 'BWET']);
    expect(rows[0]).toMatchObject({ ratePercent: -1, absRatePercent: 1, symbol: 'BINANCE_FUTURE_TIMI_USDT' });
    expect(rows[0]?.openInterestValue).toBe(2000);
  });

  it('applies the requested limit and reports an empty venue', () => {
    expect(buildVenueFundingRanking(overview, 'BINANCE', 2).map((row) => row.asset)).toEqual(['TIMI', 'NG']);
    expect(buildVenueFundingRanking(overview, 'KRAKEN', 50)).toEqual([]);
  });
});
