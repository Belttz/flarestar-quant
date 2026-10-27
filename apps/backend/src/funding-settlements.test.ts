import { describe, expect, it } from 'vitest';
import type { FundingRatePoint } from '@gate-crossex/public-data';
import {
  HOURS_PER_YEAR,
  annualizeFundingRate,
  buildFundingSettlementSummary,
  fundingPeriodsPerYear,
  selectRecentSettlements,
  summarizeRecentSettlements,
} from './funding-settlements.js';

const HOUR = 60 * 60_000;
const NOW = 100 * 24 * HOUR;

/** One settlement per interval, ending at NOW. */
function settlements(count: number, intervalHours: number, rate: (index: number) => string): FundingRatePoint[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: NOW - (count - 1 - index) * intervalHours * HOUR,
    rate: rate(index),
  }));
}

describe('funding annualization follows each contract own interval', () => {
  it('derives the settlement count of a year from the interval', () => {
    expect(HOURS_PER_YEAR).toBe(8760);
    expect(fundingPeriodsPerYear(8)).toBe(1095);
    expect(fundingPeriodsPerYear(4)).toBe(2190);
    expect(fundingPeriodsPerYear(1)).toBe(8760);
  });

  it('refuses to annualize an unknown interval instead of assuming 8h', () => {
    expect(fundingPeriodsPerYear(null)).toBeNull();
    expect(fundingPeriodsPerYear(0)).toBeNull();
    expect(fundingPeriodsPerYear(Number.NaN)).toBeNull();
    expect(annualizeFundingRate('0.0001', null)).toBeNull();
  });

  it('annualizes 8h, 4h and 1h rates on their own period', () => {
    // 1 bp per settlement: ×1095 (8h), ×2190 (4h), ×8760 (1h).
    expect(annualizeFundingRate('0.0001', 8)).toBe('0.1095');
    expect(annualizeFundingRate('0.0001', 4)).toBe('0.219');
    expect(annualizeFundingRate('0.0001', 1)).toBe('0.876');
  });

  it('keeps the sign of a negative rate so a paid-to-short contract stays negative', () => {
    expect(annualizeFundingRate('-0.00025', 8)).toBe('-0.27375');
    expect(annualizeFundingRate('-0.00025', 4)).toBe('-0.5475');
  });

  it('returns null — never zero — when the live rate is missing', () => {
    expect(annualizeFundingRate(null, 8)).toBeNull();
    expect(annualizeFundingRate('', 8)).toBeNull();
    expect(annualizeFundingRate('not-a-number', 8)).toBeNull();
  });
});

describe('recent settlements', () => {
  it('keeps the last N settlements in chronological order', () => {
    const points = settlements(10, 8, (index) => ((index + 1) / 10_000).toString());

    const recent = selectRecentSettlements(points, 6);

    expect(recent).toHaveLength(6);
    expect(recent.map((point) => point.rate)).toEqual([
      '0.0005', '0.0006', '0.0007', '0.0008', '0.0009', '0.001',
    ]);
    expect(recent[recent.length - 1]?.timestamp).toBe(NOW);
  });

  it('sorts an out-of-order input before slicing so the newest settlement always wins', () => {
    const points = [...settlements(3, 4, (index) => ((index + 1) / 10_000).toString())].reverse();

    expect(selectRecentSettlements(points, 2).map((point) => point.rate)).toEqual(['0.0002', '0.0003']);
  });

  it('returns an empty array for missing history rather than a zero-filled row', () => {
    expect(selectRecentSettlements([], 8)).toEqual([]);
    expect(selectRecentSettlements(settlements(4, 8, () => '0.0001'), 0)).toEqual([]);
  });

  it('summarizes mean, latest and count, leaving every aggregate null without history', () => {
    const points = settlements(4, 8, (index) => ['0.0001', '0.0003', '-0.0002', '0.0006'][index] ?? '0');

    const stats = summarizeRecentSettlements(points, 4);

    expect(stats.settlementCount).toBe(4);
    expect(stats.latestRate).toBe('0.0006');
    expect(stats.latestSettledAt).toBe(new Date(NOW).toISOString());
    expect(Number(stats.recentMeanRate)).toBeCloseTo(0.0002, 12);

    const empty = summarizeRecentSettlements([], 8);
    expect(empty).toEqual({
      recent: [],
      recentMeanRate: null,
      latestRate: null,
      latestSettledAt: null,
      settlementCount: 0,
    });
  });
});

describe('settlement summary row', () => {
  it('marks a contract with neither a quote nor history as unavailable and never prints 0', () => {
    const summary = buildFundingSettlementSummary({
      symbol: 'BINANCE_FUTURE_BTC_USDT',
      points: [],
      limit: 8,
      live: null,
    });

    expect(summary).toMatchObject({
      status: 'unavailable',
      intervalHours: null,
      currentRate: null,
      currentAnnualizedRate: null,
      nextFundingAt: null,
      recent: [],
      recentMeanRate: null,
      latestRate: null,
      settlementCount: 0,
    });
  });

  it('keeps the live quote meaningful even when no settlement is cached yet', () => {
    const summary = buildFundingSettlementSummary({
      symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
      points: [],
      limit: 8,
      live: {
        currentRate: '0.0000125',
        intervalHours: 1,
        nextFundingAt: new Date(NOW + HOUR).toISOString(),
        fetchedAt: new Date(NOW).toISOString(),
      },
    });

    expect(summary.status).toBe('ok');
    expect(summary.currentRate).toBe('0.0000125');
    expect(summary.currentAnnualizedRate).toBe('0.1095');
    expect(summary.recent).toEqual([]);
    expect(summary.recentMeanRate).toBeNull();
  });

  it('annualizes a 4h venue four times higher than an 8h venue charging the same rate', () => {
    const live = (intervalHours: number) => ({
      currentRate: '0.0002',
      intervalHours,
      nextFundingAt: null,
      fetchedAt: null,
    });
    const eightHour = buildFundingSettlementSummary({
      symbol: 'BINANCE_FUTURE_BTC_USDT', points: [], limit: 8, live: live(8),
    });
    const fourHour = buildFundingSettlementSummary({
      symbol: 'MEXC_FUTURE_BTC_USDT', points: [], limit: 8, live: live(4),
    });

    expect(eightHour.currentAnnualizedRate).toBe('0.219');
    expect(fourHour.currentAnnualizedRate).toBe('0.438');
    expect(Number(fourHour.currentAnnualizedRate)).toBeCloseTo(Number(eightHour.currentAnnualizedRate) * 2, 12);
  });
});
