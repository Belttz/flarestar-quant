import { describe, expect, it } from 'vitest';
import {
  FUNDING_HOURS_PER_YEAR,
  applyFundingAssetOrder,
  averageAvailableFundingRate,
  cumulativeFundingPercent,
  currentFundingComparisonRate,
  currentFundingMetricRate,
  formatFundingCountdown,
  fundingAnnualizationFactor,
  fundingFractionToPercent,
  fundingIntervalLabel,
  fundingPercentScaledTo8h,
  fundingHistoryRequestKey,
  fundingPairAnnualizedPercent,
  fundingSettlementBarHeight,
  fundingSettlementBarScale,
  fundingSettlementCountdown,
  fundingSettlementTone,
  pairFundingLegs,
  sortFundingBoardRows,
} from './funding-rates.js';

describe('interval-aware current funding', () => {
  it('keeps the venue cell native while comparisons and APR use an 8h basis', () => {
    const nativeHourlyPercent = 0.001;
    const rate8hPercent = fundingPercentScaledTo8h(nativeHourlyPercent, 1);

    expect(rate8hPercent).toBe(0.008);
    expect(currentFundingMetricRate(nativeHourlyPercent, rate8hPercent, 'Per interval')).toBe(0.001);
    expect(currentFundingComparisonRate(rate8hPercent, 'Per interval')).toBe(0.008);
    expect(currentFundingMetricRate(nativeHourlyPercent, rate8hPercent, 'APR')).toBeCloseTo(8.76);
  });

  it('refuses to normalize a streamed fallback without interval metadata', () => {
    expect(fundingPercentScaledTo8h(0.001, null)).toBeNull();
    expect(fundingPercentScaledTo8h(0.001, 0)).toBeNull();
  });
});

describe('stable funding table order', () => {
  it('keeps refreshed rows in the explicitly applied order and appends new assets deterministically', () => {
    const refreshed = [
      { asset: 'SOL', value: 30 },
      { asset: 'ETH', value: 200 },
      { asset: 'BTC', value: 100 },
      { asset: 'ADA', value: 40 },
    ];

    expect(applyFundingAssetOrder(refreshed, ['BTC', 'ETH']).map((row) => row.asset))
      .toEqual(['BTC', 'ETH', 'ADA', 'SOL']);
  });
});

describe('funding history request identity', () => {
  it('stays stable across live-update array recreation and reordering', () => {
    const first = ['OKX_FUTURE_BTC_USDT', 'BINANCE_FUTURE_BTC_USDT'];
    const liveUpdate = ['BINANCE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT'];

    expect(fundingHistoryRequestKey(first)).toBe(fundingHistoryRequestKey(liveUpdate));
  });
});

describe('cumulativeFundingPercent', () => {
  it('displays the realized sum directly without projecting the latest interval', () => {
    expect(cumulativeFundingPercent('0.00123')).toBeCloseTo(0.123);
    expect(cumulativeFundingPercent('-0.0004')).toBeCloseTo(-0.04);
  });

  it('rejects missing and malformed history totals', () => {
    expect(cumulativeFundingPercent(null)).toBeNull();
    expect(cumulativeFundingPercent('not-a-rate')).toBeNull();
  });
});

describe('averageAvailableFundingRate', () => {
  it('averages positive and negative funding across selected tradable venues', () => {
    expect(averageAvailableFundingRate(
      [0.01, -0.02, 0.04],
      [true, true, true],
      [0, 1, 2],
    )).toEqual({ rate: 0.01, venueCount: 3 });
  });

  it('excludes unlisted, unselected, and missing venue rates', () => {
    expect(averageAvailableFundingRate(
      [0.01, 0.5, null, 0.03],
      [true, false, true, true],
      [0, 1, 2],
    )).toEqual({ rate: 0.01, venueCount: 1 });
  });

  it('returns no average when no selected tradable venue has funding data', () => {
    expect(averageAvailableFundingRate(
      [null, 0.02],
      [true, false],
      [0, 1],
    )).toEqual({ rate: null, venueCount: 0 });
  });
});

describe('settlement board formatting', () => {
  it('converts an API fraction to the percentage the page prints', () => {
    expect(fundingFractionToPercent('0.0001')).toBeCloseTo(0.01, 10);
    expect(fundingFractionToPercent('-0.0025')).toBeCloseTo(-0.25, 10);
    expect(fundingFractionToPercent(null)).toBeNull();
    expect(fundingFractionToPercent('')).toBeNull();
    expect(fundingFractionToPercent('nope')).toBeNull();
  });

  it('paints paid funding red and received funding green', () => {
    expect(fundingSettlementTone(0.01)).toBe('pay');
    expect(fundingSettlementTone(-0.01)).toBe('earn');
    expect(fundingSettlementTone(0)).toBe('flat');
    expect(fundingSettlementTone(null)).toBe('flat');
    // A rate that rounds to 0.0000% must not be painted as a cost.
    expect(fundingSettlementTone(0.00001)).toBe('flat');
  });

  it('labels the interval and its annualization factor per venue', () => {
    expect(fundingIntervalLabel(8)).toBe('8h');
    expect(fundingIntervalLabel(1)).toBe('1h');
    expect(fundingIntervalLabel(null)).toBeNull();
    expect(fundingAnnualizationFactor(8)).toBe(1095);
    expect(fundingAnnualizationFactor(4)).toBe(2190);
    expect(fundingAnnualizationFactor(1)).toBe(8760);
    expect(fundingAnnualizationFactor(null)).toBeNull();
  });

  it('formats the countdown at each bracket and never invents a schedule', () => {
    expect(formatFundingCountdown((2 * 24 * 60 + 3 * 60) * 60_000)).toBe('2d 03h');
    expect(formatFundingCountdown((4 * 60 + 34) * 60_000)).toBe('4h 34m');
    expect(formatFundingCountdown(34 * 60_000 + 46_000)).toBe('34:46');
    expect(formatFundingCountdown(-5_000)).toBe('00:00');
    expect(formatFundingCountdown(null)).toBeNull();
    expect(fundingSettlementCountdown(null, 0)).toBeNull();
    expect(fundingSettlementCountdown('not-a-date', 0)).toBeNull();
    expect(fundingSettlementCountdown('2026-10-27T16:00:00.000Z', Date.parse('2026-10-27T15:00:00.000Z')))
      .toBe(60 * 60_000);
  });

  it('scales the strip by its largest rate and keeps a zero strip drawable', () => {
    expect(fundingSettlementBarScale([0.001, -0.004, 0.002])).toBe(0.004);
    expect(fundingSettlementBarScale([0, 0])).toBeGreaterThan(0);
    expect(fundingSettlementBarHeight(0.004, 0.004)).toBe(100);
    expect(fundingSettlementBarHeight(0.001, 0.004)).toBe(25);
    expect(fundingSettlementBarHeight(null, 0.004)).toBe(0);
  });
});

describe('sortFundingBoardRows', () => {
  const rows = [
    { asset: 'BTC', symbol: 'BINANCE_FUTURE_BTC_USDT', spreadPercent: 0.05, currentRatePercent: 0.01, annualizedPercent: 54.75, latestSettledPercent: 0.012, nextFundingAt: '2026-10-27T16:00:00.000Z', openInterest: 100 },
    { asset: 'ETH', symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', spreadPercent: 0.4, currentRatePercent: -0.02, annualizedPercent: 438, latestSettledPercent: null, nextFundingAt: '2026-10-27T13:00:00.000Z', openInterest: 0 },
    { asset: 'SOL', symbol: 'GATE_FUTURE_SOL_USDT', spreadPercent: null, currentRatePercent: null, annualizedPercent: null, latestSettledPercent: -0.004, nextFundingAt: null, openInterest: 50 },
  ];

  it('orders by annualized rate and sinks unknown APRs to the bottom in both directions', () => {
    expect(sortFundingBoardRows(rows, 'apr', 'desc').map((row) => row.asset)).toEqual(['ETH', 'BTC', 'SOL']);
    expect(sortFundingBoardRows(rows, 'apr', 'asc').map((row) => row.asset)).toEqual(['BTC', 'ETH', 'SOL']);
  });

  it('orders by spread, by the latest settled rate and by the next settlement time', () => {
    expect(sortFundingBoardRows(rows, 'spread', 'desc').map((row) => row.asset)).toEqual(['ETH', 'BTC', 'SOL']);
    expect(sortFundingBoardRows(rows, 'latest', 'desc').map((row) => row.asset)).toEqual(['BTC', 'SOL', 'ETH']);
    expect(sortFundingBoardRows(rows, 'next', 'asc').map((row) => row.asset)).toEqual(['ETH', 'BTC', 'SOL']);
    expect(sortFundingBoardRows(rows, 'oi', 'desc').map((row) => row.asset)).toEqual(['BTC', 'SOL', 'ETH']);
  });
});

describe('pairFundingLegs', () => {
  const legs = [
    { key: 'GATE:1h', venue: 'gate', ratePercent: -0.02, rate8hPercent: -0.16, intervalHours: 1 },
    { key: 'BINANCE:8h', venue: 'binance', ratePercent: 0.01, rate8hPercent: 0.01, intervalHours: 8 },
    { key: 'OKX:4h', venue: 'okx', ratePercent: -0.005, rate8hPercent: -0.01, intervalHours: 4 },
  ];

  it('pairs every two distinct venues of one asset, longest-first direction included', () => {
    const pairs = pairFundingLegs(legs);

    expect(pairs).toHaveLength(3);
    // Long the leg paying longs (negative), short the leg charging longs (positive).
    const gateBinance = pairs.find((pair) => pair.long.venue === 'gate' && pair.short.venue === 'binance');
    expect(gateBinance?.long.key).toBe('GATE:1h');
    expect(gateBinance?.short.key).toBe('BINANCE:8h');
    expect(gateBinance?.spread8hPercent).toBeCloseTo(0.17, 10);
  });

  it('normalizes each leg to 8h before subtracting so mixed intervals stay comparable', () => {
    // -0.02%/1h is -0.16% per 8h, so the spread against a 0.01%/8h leg is 0.17, not 0.03.
    const mixed = pairFundingLegs([
      { key: 'A', venue: 'gate', ratePercent: -0.02, rate8hPercent: -0.16, intervalHours: 1 },
      { key: 'B', venue: 'binance', ratePercent: 0.01, rate8hPercent: 0.01, intervalHours: 8 },
    ]);
    const same = pairFundingLegs([
      { key: 'A', venue: 'gate', ratePercent: -0.16, rate8hPercent: -0.16, intervalHours: 8 },
      { key: 'B', venue: 'binance', ratePercent: 0.01, rate8hPercent: 0.01, intervalHours: 8 },
    ]);

    expect(mixed[0]?.spread8hPercent).toBeCloseTo(same[0]?.spread8hPercent ?? Number.NaN, 10);
  });

  it('drops legs without a published interval instead of guessing one', () => {
    const pairs = pairFundingLegs([
      { key: 'A', venue: 'gate', ratePercent: 0.01, rate8hPercent: 0.01, intervalHours: 8 },
      { key: 'B', venue: 'lighter', ratePercent: 0.02, rate8hPercent: null, intervalHours: null },
    ]);

    expect(pairs).toEqual([]);
  });

  it('annualizes a spread on the 8h basis, identically for 8h, 4h and 1h pairs', () => {
    // All three pairs keep 0.04% per 8h, whatever their own settlement cadence.
    const eightHour = pairFundingLegs([
      { key: 'A', venue: 'gate', ratePercent: -0.02, rate8hPercent: -0.02, intervalHours: 8 },
      { key: 'B', venue: 'binance', ratePercent: 0.02, rate8hPercent: 0.02, intervalHours: 8 },
    ])[0];
    const fourHour = pairFundingLegs([
      { key: 'A', venue: 'gate', ratePercent: -0.01, rate8hPercent: -0.02, intervalHours: 4 },
      { key: 'B', venue: 'binance', ratePercent: 0.01, rate8hPercent: 0.02, intervalHours: 4 },
    ])[0];
    const hourly = pairFundingLegs([
      { key: 'A', venue: 'hyperliquid', ratePercent: -0.0025, rate8hPercent: -0.02, intervalHours: 1 },
      { key: 'B', venue: 'bybit', ratePercent: 0.0025, rate8hPercent: 0.02, intervalHours: 1 },
    ])[0];

    expect(eightHour?.spread8hPercent).toBeCloseTo(0.04, 10);
    expect(fourHour?.spread8hPercent).toBeCloseTo(0.04, 10);
    expect(hourly?.spread8hPercent).toBeCloseTo(0.04, 10);
    // 0.04% × (24/8) × 365 = 43.8% a year, for every cadence.
    expect(fundingPairAnnualizedPercent(eightHour?.spread8hPercent ?? null)).toBeCloseTo(43.8, 6);
    expect(fundingPairAnnualizedPercent(fourHour?.spread8hPercent ?? null)).toBeCloseTo(43.8, 6);
    expect(fundingPairAnnualizedPercent(hourly?.spread8hPercent ?? null)).toBeCloseTo(43.8, 6);
    expect(fundingPairAnnualizedPercent(null)).toBeNull();

    // The pair APR is also exactly "each leg annualized on its own interval, then subtracted" —
    // the per-contract formula the backend exposes. Pinning the equality keeps the two views of
    // the same arithmetic from drifting apart.
    const legApr = (ratePercent: number, intervalHours: number) => ratePercent * (FUNDING_HOURS_PER_YEAR / intervalHours);
    const hourlyPairApr = legApr(0.0025, 1) - legApr(-0.0025, 1);
    const eightHourPairApr = legApr(0.02, 8) - legApr(-0.02, 8);
    expect(hourlyPairApr).toBeCloseTo(43.8, 6);
    expect(eightHourPairApr).toBeCloseTo(43.8, 6);
    expect(fundingPairAnnualizedPercent(hourly?.spread8hPercent ?? null)).toBeCloseTo(hourlyPairApr, 6);
    expect(fundingPairAnnualizedPercent(eightHour?.spread8hPercent ?? null)).toBeCloseTo(eightHourPairApr, 6);
  });
});
