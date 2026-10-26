import { describe, expect, it } from 'vitest';
import type {
  Candle,
  FundingOverviewResponse,
  MarketCatalogVenue,
  SpreadOpportunity,
  SpreadQualityRow,
} from '@gate-crossex/shared-types';
import type { LiveMarket } from './market-hub.js';
import type { SpreadSampleCoverage, SpreadSampleRow } from './repositories.js';
import { spreadSamplePairKey } from './repositories.js';
import {
  MAX_SPREAD_QUALITY_CANDIDATES,
  SPREAD_QUALITY_WINDOW_MS,
  SPREAD_SAMPLE_INTERVAL_MS,
  SPREAD_SAMPLE_MINUTES_PER_POINT,
  SpreadQualityService,
  alignSpreadSeries,
  averageRanks,
  computeSpreadStatistics,
  halfLifeFromAr1,
  percentileRanks,
  scoreSpreadQualityInputs,
  selectSpreadQualityCandidates,
  sortSpreadQualityRows,
  type SpreadQualityScoreInput,
} from './spread-quality.js';

const EPOCH = '2026-08-01T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH);
const STEP_MS = 5 * 60_000;
const CATALOG = { assets: new Map<string, MarketCatalogVenue[]>() };

/** Deterministic PRNG (mulberry32) so every synthetic sequence is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Standard-normal pairs (Box–Muller); the caller consumes them one value at a time. */
function gaussianSequence(random: () => number, count: number): number[] {
  const values: number[] = [];
  while (values.length < count) {
    const u1 = Math.max(random(), 1e-12);
    const u2 = random();
    const radius = Math.sqrt(-2 * Math.log(u1));
    const angle = 2 * Math.PI * u2;
    values.push(radius * Math.cos(angle));
    if (values.length < count) values.push(radius * Math.sin(angle));
  }
  return values;
}

/** Stationary AR(1): x(t) = φ·x(t−1) + sqrt(1−φ²)·ε(t), ε standard normal. */
function ar1Sequence(random: () => number, count: number, phi: number): number[] {
  const innovations = gaussianSequence(random, count);
  const innovationScale = Math.sqrt(1 - phi * phi);
  const values: number[] = [innovations[0]!];
  for (let index = 1; index < count; index += 1) {
    values.push(phi * values[index - 1]! + innovationScale * innovations[index]!);
  }
  return values;
}

function candleSeries(closes: readonly number[], startTime = EPOCH_MS): Candle[] {
  return closes.map((close, index) => ({
    startTime: startTime + index * STEP_MS,
    open: String(close), high: String(close), low: String(close),
    close: String(close), volume: '1', closed: true,
  }));
}

/** Leg candles reproducing `spreadBps` exactly: a flat right leg and a left leg offset by the spread. */
function legsForSpreadSeries(spreadBps: readonly number[]): { left: Candle[]; right: Candle[] } {
  return {
    left: candleSeries(spreadBps.map((bps) => 100 * (1 + bps / 10_000))),
    right: candleSeries(spreadBps.map(() => 100)),
  };
}

/** A symbol-aware candle stub: each candidate's legs get their own series. */
function candlesBySymbol(
  entries: ReadonlyArray<{ leftSymbol: string; rightSymbol: string; series: readonly number[] }>,
): (symbol: string) => Candle[] {
  const bySymbol = new Map<string, Candle[]>();
  for (const entry of entries) {
    const legs = legsForSpreadSeries(entry.series);
    bySymbol.set(entry.leftSymbol, legs.left);
    bySymbol.set(entry.rightSymbol, legs.right);
  }
  return (symbol) => bySymbol.get(symbol) ?? [];
}

function liveMarket(overrides: Partial<LiveMarket> & Pick<LiveMarket, 'symbol' | 'venue' | 'asset'>): LiveMarket {
  return {
    lastPrice: '100', bidPrice: '99', bidSize: '1', askPrice: '101', askSize: '1',
    open24h: '100', high24h: '110', low24h: '90', volume24h: '10', quoteVolume24h: '1000',
    fundingRate: '0', nextFundingAt: EPOCH, openInterest: '0', openInterestValue: '0',
    receivedAt: EPOCH, updatedAt: EPOCH, source: 'demo_seed',
    ...overrides,
  };
}

interface CombinationFixture {
  pairType?: 'SPOT_PERP' | 'PERP_PERP';
  leftSymbol: string;
  rightSymbol: string;
  leftVenue: string;
  rightVenue: string;
  spreadBps: number;
  executable?: boolean;
  /** R4 quote alignment tri-state; absent means "unknown" (treated as aligned). */
  quoteAligned?: boolean;
}

function spreadBoardRow(asset: string, combinations: CombinationFixture[]): SpreadOpportunity {
  const best = combinations[0]!;
  return {
    pairType: best.pairType ?? 'PERP_PERP',
    asset,
    leftSymbol: best.leftSymbol,
    rightSymbol: best.rightSymbol,
    leftVenue: best.leftVenue,
    rightVenue: best.rightVenue,
    sellBid: '100', buyAsk: '100',
    spreadBps: best.spreadBps,
    updatedAt: EPOCH,
    executable: best.executable ?? true,
    assetClass: 'TOKEN', assetSuperClass: 'CRYPTO', variantSuffix: null, isPreIpo: false,
    leftStats: null, rightStats: null,
    combinations: combinations.map((combination) => ({
      pairType: combination.pairType ?? 'PERP_PERP',
      leftSymbol: combination.leftSymbol,
      rightSymbol: combination.rightSymbol,
      leftVenue: combination.leftVenue,
      rightVenue: combination.rightVenue,
      sellBid: '100', buyAsk: '100',
      spreadBps: combination.spreadBps,
      updatedAt: EPOCH,
      executable: combination.executable ?? true,
      ...(combination.quoteAligned !== undefined ? { quoteAligned: combination.quoteAligned } : {}),
    })),
  };
}

interface FundingFixture {
  asset: string;
  symbol: string;
  fundingRate: string | null;
  fundingIntervalHours: number | null;
}

function fundingOverviewResponse(rows: FundingFixture[]): FundingOverviewResponse {
  const byAsset = new Map<string, FundingFixture[]>();
  for (const row of rows) {
    const entries = byAsset.get(row.asset) ?? [];
    entries.push(row);
    byAsset.set(row.asset, entries);
  }
  return {
    assets: [...byAsset.entries()].map(([asset, entries]) => ({
      asset,
      venues: entries.map((entry) => ({
        venue: entry.symbol.split('_')[0]!,
        symbol: entry.symbol,
        quote: 'USDT',
        fundingRate: entry.fundingRate,
        fundingIntervalHours: entry.fundingIntervalHours,
        fundingRate8h: entry.fundingRate,
        nextFundingAt: entry.fundingRate === null ? null : EPOCH,
        openInterestValue: null,
        lastPrice: '100',
        change24h: null,
        fetchedAt: entry.fundingRate === null ? null : EPOCH,
      })),
    })),
    venueStatus: [],
    fetchedAt: EPOCH,
    cacheStatus: 'fresh',
  };
}

interface QualityFixture {
  service: SpreadQualityService;
  boardCalls: () => number;
  candleCalls: () => number;
  candleCallsFor: (symbol: string) => number;
  ensureFreshCalls: () => number;
  advance: (milliseconds: number) => void;
}

interface QualityOptions {
  board: SpreadOpportunity[];
  candles?: (symbol: string) => readonly Candle[];
  funding?: FundingFixture[];
  markets?: LiveMarket[];
  cacheTtlMs?: number;
  candidateLimit?: number;
  candleConcurrency?: number;
  /** Wires the local sample store; absent means the board reads candles only, as before. */
  samples?: {
    coverage: ReadonlyMap<string, SpreadSampleCoverage>
      | ((pairs: ReadonlyArray<{ leftSymbol: string; rightSymbol: string }>, fromMs: number) => Map<string, SpreadSampleCoverage>);
    series?: ReadonlyArray<{ leftSymbol: string; rightSymbol: string; rows: readonly SpreadSampleRow[] }>;
  };
}

function createQualityService(options: QualityOptions): QualityFixture {
  let boardCalls = 0;
  let ensureFreshCalls = 0;
  let nowMs = EPOCH_MS;
  const candleCallCounts = new Map<string, number>();
  const hub = {
    market: (symbol: string): LiveMarket | null =>
      (options.markets ?? []).find((market) => market.symbol === symbol) ?? null,
  };
  const service = new SpreadQualityService({
    fundingOverview: {
      ensureFresh: async () => { ensureFreshCalls += 1; },
      buildResponse: () => fundingOverviewResponse(options.funding ?? []),
    },
    hub,
    spreadBoard: async () => {
      boardCalls += 1;
      return options.board;
    },
    loadCandles: async (symbol) => {
      candleCallCounts.set(symbol, (candleCallCounts.get(symbol) ?? 0) + 1);
      return options.candles ? options.candles(symbol) : [];
    },
    ...(options.samples !== undefined ? {
      samples: {
        coverage: (pairs, fromMs) => {
          const source = options.samples!.coverage;
          if (typeof source === 'function') return source(pairs, fromMs);
          const coverage = new Map<string, SpreadSampleCoverage>();
          for (const pair of pairs) {
            const entry = source.get(spreadSamplePairKey(pair.leftSymbol, pair.rightSymbol));
            if (entry !== undefined) {
              coverage.set(spreadSamplePairKey(pair.leftSymbol, pair.rightSymbol), entry);
            }
          }
          return coverage;
        },
        series: (leftSymbol, rightSymbol) =>
          (options.samples!.series ?? [])
            .find((entry) => entry.leftSymbol === leftSymbol && entry.rightSymbol === rightSymbol)?.rows ?? [],
      },
    } : {}),
  }, {
    now: () => nowMs,
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.candidateLimit !== undefined ? { candidateLimit: options.candidateLimit } : {}),
    ...(options.candleConcurrency !== undefined ? { candleConcurrency: options.candleConcurrency } : {}),
  });
  return {
    service,
    boardCalls: () => boardCalls,
    candleCalls: () => [...candleCallCounts.values()].reduce((sum, count) => sum + count, 0),
    candleCallsFor: (symbol) => candleCallCounts.get(symbol) ?? 0,
    ensureFreshCalls: () => ensureFreshCalls,
    advance: (milliseconds) => { nowMs += milliseconds; },
  };
}

function scoreInput(
  overrides: Partial<SpreadQualityScoreInput> & Pick<SpreadQualityScoreInput, 'asset' | 'leftSymbol' | 'rightSymbol'>,
): SpreadQualityScoreInput {
  return {
    pairType: 'PERP_PERP',
    leftVenue: 'GATE',
    rightVenue: 'BYBIT',
    currentSpreadBps: 10,
    updatedAt: EPOCH,
    assetClass: 'TOKEN',
    assetSuperClass: 'CRYPTO',
    variantSuffix: null,
    isPreIpo: false,
    sampleCount: 288,
    meanSpreadBps: 10,
    spreadVolatilityBps: 2,
    skewness: 0.2,
    excessKurtosis: 0.5,
    symmetric: true,
    ar1Coefficient: 0.8,
    halfLifeHours: 0.25,
    holdingCostBps: 1,
    bookDepthUsdt: 1000,
    leftFundingRate8h: null,
    rightFundingRate8h: null,
    fundingRateDiffBps: null,
    source: 'candles',
    ...overrides,
  };
}

/** One 30s sample row; `sampledAt` defaults to an ascending grid ending at the fixture epoch. */
function sampleRow(
  overrides: Partial<SpreadSampleRow> & Pick<SpreadSampleRow, 'leftSymbol' | 'rightSymbol' | 'spreadBps'>,
): SpreadSampleRow {
  return {
    pairType: 'PERP_PERP',
    asset: 'BTC',
    sampledAt: EPOCH_MS,
    depthUsdt: 0,
    leftPrice: 100,
    rightPrice: 100,
    ...overrides,
  };
}

/** A coverage entry that has earned promotion: a full 24h window at 100% of 2880 points. */
function promotedCoverage(): SpreadSampleCoverage {
  return {
    count: 2880,
    oldestMs: EPOCH_MS - SPREAD_QUALITY_WINDOW_MS,
    newestMs: EPOCH_MS,
  };
}

/** Sample rows for one pair, oldest first, on the 30s grid ending at the fixture epoch. */
function sampleSeriesFor(
  leftSymbol: string,
  rightSymbol: string,
  spreadBps: readonly number[],
  depthUsdt = 0,
): { leftSymbol: string; rightSymbol: string; rows: SpreadSampleRow[] } {
  return {
    leftSymbol,
    rightSymbol,
    rows: spreadBps.map((bps, index) => sampleRow({
      leftSymbol,
      rightSymbol,
      spreadBps: bps,
      sampledAt: EPOCH_MS - (spreadBps.length - 1 - index) * SPREAD_SAMPLE_INTERVAL_MS,
      depthUsdt,
    })),
  };
}

describe('spread series statistics', () => {
  it('reports ~0 skewness and ~0 excess kurtosis for a standard-normal sample', () => {
    const series = gaussianSequence(mulberry32(42), 4000);
    const statistics = computeSpreadStatistics(series);
    expect(statistics.mean).toBeCloseTo(0, 1);
    expect(Math.abs(statistics.skewness!)).toBeLessThan(0.2);
    expect(Math.abs(statistics.excessKurtosis!)).toBeLessThan(0.4);
    expect(statistics.symmetric).toBe(true);
    // Independent draws do not correlate at lag 1 (φ̂ ≈ 0.014 here): a near-zero φ means
    // "no reversion signal" — either null (φ ≤ 0) or a half-life of minutes, never hours.
    expect(Math.abs(statistics.ar1Coefficient!)).toBeLessThan(0.1);
    expect(statistics.halfLifeHours === null || statistics.halfLifeHours! < 0.05).toBe(true);
  });

  it('reports a skewness above 1 for a clearly right-skewed sample', () => {
    const random = mulberry32(7);
    const series = Array.from({ length: 2000 }, () => -Math.log(Math.max(random(), 1e-12)));
    const statistics = computeSpreadStatistics(series);
    expect(statistics.skewness!).toBeGreaterThan(1.5);
    expect(statistics.symmetric).toBe(false);
    expect(statistics.excessKurtosis!).toBeGreaterThan(1);
  });

  it('recovers the AR(1) coefficient and half-life of a known φ=0.8 process', () => {
    const series = ar1Sequence(mulberry32(11), 5000, 0.8);
    const statistics = computeSpreadStatistics(series);
    expect(Math.abs(statistics.ar1Coefficient! - 0.8)).toBeLessThan(0.05);
    // ln(0.5)/ln(0.8) ≈ 3.107 five-minute points ≈ 0.2588 hours.
    const expectedHalfLife = (Math.log(0.5) / Math.log(0.8)) * (5 / 60);
    expect(Math.abs(statistics.halfLifeHours! - expectedHalfLife)).toBeLessThan(0.03);
    expect(statistics.symmetric).toBe(true);
  });

  it('returns null moments — never fake zeros — for a constant series', () => {
    const statistics = computeSpreadStatistics([3, 3, 3, 3, 3]);
    expect(statistics.mean).toBe(3);
    expect(statistics.volatility).toBe(0);
    expect(statistics.median).toBe(3);
    expect(statistics.skewness).toBeNull();
    expect(statistics.excessKurtosis).toBeNull();
    expect(statistics.ar1Coefficient).toBeNull();
    expect(statistics.halfLifeHours).toBeNull();
    expect(statistics.symmetric).toBe(false);
  });

  it('returns all-null statistics for an empty series', () => {
    expect(computeSpreadStatistics([])).toEqual({
      mean: null, volatility: null, skewness: null, excessKurtosis: null, median: null,
      symmetric: false, ar1Coefficient: null, halfLifeHours: null,
    });
  });

  it('scales the AR(1) half-life with the series cadence (samples run 10× finer than candles)', () => {
    // A long series pins φ̂ tight to 0.9: the half-life is sharply sensitive near φ = 0.9
    // (about 69 points per unit of φ), so a short sample would need a very loose band.
    const series = ar1Sequence(mulberry32(29), 20_000, 0.9);
    const candles = computeSpreadStatistics(series);
    const samples = computeSpreadStatistics(series, SPREAD_SAMPLE_MINUTES_PER_POINT);
    expect(Math.abs(samples.ar1Coefficient! - 0.9)).toBeLessThan(0.02);
    // ln(0.5)/ln(0.9) ≈ 6.58 points: 0.548h at the 5m candle cadence, 0.0548h at 30s.
    const expectedHalfLifeHours = (Math.log(0.5) / Math.log(0.9)) * (0.5 / 60);
    expect(samples.halfLifeHours!).toBeGreaterThan(expectedHalfLifeHours * 0.92);
    expect(samples.halfLifeHours!).toBeLessThan(expectedHalfLifeHours * 1.08);
    // Same series, same φ̂ — only the minutes-per-point conversion differs.
    expect(samples.halfLifeHours!).toBeCloseTo(candles.halfLifeHours! * 0.1, 10);
    // The default cadence stays the candle one, so existing callers are unaffected.
    expect(halfLifeFromAr1(0.9)).toBeCloseTo((Math.log(0.5) / Math.log(0.9)) * (5 / 60), 10);
    expect(halfLifeFromAr1(0.9, 0.5)).toBeCloseTo(expectedHalfLifeHours, 10);
    // A nonsense cadence yields null rather than a meaningless number.
    expect(halfLifeFromAr1(0.9, 0)).toBeNull();
  });

  it('computes degenerate two-point series and refuses a one-pair autocorrelation', () => {
    const statistics = computeSpreadStatistics([1, 2]);
    expect(statistics.mean).toBe(1.5);
    expect(statistics.volatility).toBeCloseTo(0.5, 10);
    expect(statistics.skewness).toBe(0);
    expect(statistics.excessKurtosis).toBe(-2);
    expect(statistics.symmetric).toBe(true);
    expect(statistics.ar1Coefficient).toBeNull();
    expect(statistics.halfLifeHours).toBeNull();
  });
});

describe('percentile ranking', () => {
  it('ranks ascending values over (n − 1)', () => {
    expect(percentileRanks([10, 20, 30])).toEqual([0, 0.5, 1]);
  });

  it('averages tied ranks', () => {
    expect(percentileRanks([10, 10, 20])).toEqual([0.25, 0.25, 1]);
    expect(averageRanks([5, 3, 3, 1])).toEqual([4, 2.5, 2.5, 1]);
  });

  it('gives a missing factor the worst percentile', () => {
    expect(percentileRanks([null, 10, 20])).toEqual([0, 0, 1]);
    expect(percentileRanks([null, null])).toEqual([0, 0]);
  });

  it('parks a lone value at the neutral midpoint', () => {
    expect(percentileRanks([42])).toEqual([0.5]);
    expect(percentileRanks([null])).toEqual([0]);
  });
});

describe('spread quality composite score', () => {
  it('scores a strictly ordered group as the weighted percentile sum', () => {
    const inputs = [0, 1, 2, 3].map((rank) => scoreInput({
      asset: `A${rank}`,
      leftSymbol: `GATE_FUTURE_A${rank}_USDT`,
      rightSymbol: `BYBIT_FUTURE_A${rank}_USDT`,
      meanSpreadBps: 10 + rank,
      spreadVolatilityBps: 1 + rank,
      halfLifeHours: 1 - rank * 0.1,
      skewness: rank * 0.2,
      excessKurtosis: rank * 0.1,
      holdingCostBps: 1,
      bookDepthUsdt: 100 * (rank + 1),
    }));
    const rows = scoreSpreadQualityInputs(inputs);
    expect(rows.map((row) => row.asset)).toEqual(['A3', 'A2', 'A1', 'A0']);
    expect(rows[0]!.score).toBeCloseTo(100, 10);
    expect(rows[1]!.score).toBeCloseTo(200 / 3, 10);
    expect(rows[2]!.score).toBeCloseTo(100 / 3, 10);
    expect(rows[3]!.score).toBeCloseTo(0, 10);
  });

  it('charges a missing funding cost the group maximum and ranks null factors worst', () => {
    const rows = scoreSpreadQualityInputs([
      scoreInput({ asset: 'A', leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT', meanSpreadBps: 20, holdingCostBps: null, spreadVolatilityBps: 2, halfLifeHours: 0.5, skewness: 0.5, excessKurtosis: 1, bookDepthUsdt: 1000 }),
      scoreInput({ asset: 'B', leftSymbol: 'GATE_FUTURE_B_USDT', rightSymbol: 'BYBIT_FUTURE_B_USDT', meanSpreadBps: 10, holdingCostBps: 2, spreadVolatilityBps: 1, halfLifeHours: 1, skewness: 0, excessKurtosis: 0, bookDepthUsdt: 500 }),
      scoreInput({ asset: 'C', leftSymbol: 'GATE_FUTURE_C_USDT', rightSymbol: 'BYBIT_FUTURE_C_USDT', meanSpreadBps: 5, holdingCostBps: 1, spreadVolatilityBps: 3, halfLifeHours: null, skewness: 1, excessKurtosis: 2, bookDepthUsdt: 2000 }),
    ]);
    // μ_net: A = 20 − 2 (group max cost), B = 10 − 2, C = 5 − 1 → percentiles 1 / 0.5 / 0.
    // Volatility 2/1/3 → 0.5/0/1; reversion 2/1/none → 1/0/0; skew 0.5/0/1 → 0.5/0/1;
    // kurtosis 1/0/2 → 0.5/0/1; depth 1000/500/2000 → 0.5/0/1.
    expect(rows.map((row) => row.asset)).toEqual(['A', 'C', 'B']);
    expect(rows[0]!.score).toBeCloseTo(72.5, 10);
    expect(rows[1]!.score).toBeCloseTo(55, 10);
    expect(rows[2]!.score).toBeCloseTo(15, 10);
  });

  it('keeps rows without a usable mean off the board', () => {
    const rows = scoreSpreadQualityInputs([
      scoreInput({ asset: 'A', leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT', meanSpreadBps: null }),
      scoreInput({ asset: 'B', leftSymbol: 'GATE_FUTURE_B_USDT', rightSymbol: 'BYBIT_FUTURE_B_USDT', meanSpreadBps: 4 }),
    ]);
    expect(rows.map((row) => row.asset)).toEqual(['B']);
  });

  it('carries every row field through and marks candles as the source', () => {
    const [row] = scoreSpreadQualityInputs([
      scoreInput({ asset: 'A', leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT', sampleCount: 288 }),
    ]);
    expect(row).toMatchObject({
      pairType: 'PERP_PERP', asset: 'A',
      leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT',
      leftVenue: 'GATE', rightVenue: 'BYBIT', currentSpreadBps: 10,
      sampleCount: 288, source: 'candles', updatedAt: EPOCH,
      assetClass: 'TOKEN', assetSuperClass: 'CRYPTO', variantSuffix: null, isPreIpo: false,
    });
  });

  it('carries the legs\' current funding rates through untouched, nulls included', () => {
    const rows = scoreSpreadQualityInputs([
      scoreInput({
        asset: 'A', leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT',
        leftFundingRate8h: '0.0001', rightFundingRate8h: '-0.00005', fundingRateDiffBps: 1.5,
      }),
      scoreInput({
        asset: 'B', leftSymbol: 'GATE_SPOT_B_USDT', rightSymbol: 'BYBIT_FUTURE_B_USDT',
        // A spot leg has no funding at all, so neither the rate nor the differential is known.
        leftFundingRate8h: null, rightFundingRate8h: null, fundingRateDiffBps: null,
      }),
    ]);
    const known = rows.find((row) => row.asset === 'A');
    expect(known).toMatchObject({ leftFundingRate8h: '0.0001', rightFundingRate8h: '-0.00005', fundingRateDiffBps: 1.5 });
    const unknown = rows.find((row) => row.asset === 'B');
    expect(unknown?.leftFundingRate8h).toBeNull();
    expect(unknown?.rightFundingRate8h).toBeNull();
    expect(unknown?.fundingRateDiffBps).toBeNull();
  });

  it('scores a lone candidate at the neutral midpoint', () => {
    const [row] = scoreSpreadQualityInputs([
      scoreInput({ asset: 'A', leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT' }),
    ]);
    expect(row!.score).toBeCloseTo(50, 10);
  });
});

describe('spread series alignment', () => {
  it('aligns legs on candle open time and keeps only shared points', () => {
    const left = candleSeries([100, 101, 102, 103]);
    const right = candleSeries([50, 50.5, 51]);
    // The third left point has no right partner; spread = (left − right)/right × 10⁴.
    expect(alignSpreadSeries(left, right)).toEqual([
      ((100 - 50) / 50) * 10_000,
      ((101 - 50.5) / 50.5) * 10_000,
      ((102 - 51) / 51) * 10_000,
    ]);
  });

  it('drops candles without a usable close and trims to the 24h window', () => {
    const closes = Array.from({ length: 300 }, (_, index) => 100 + index);
    const left = candleSeries(closes);
    const right = candleSeries(closes.map(() => 100));
    const broken = [...left];
    broken[10] = { ...broken[10]!, close: '0' };
    expect(alignSpreadSeries(broken, right)).toHaveLength(288);
  });
});

describe('spread quality service', () => {
  const btcPair = spreadBoardRow('BTC', [{
    leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
    leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 12,
  }]);

  it('reconstructs the series from both legs and reports distribution statistics', async () => {
    const series = ar1Sequence(mulberry32(11), 288, 0.7);
    const fixture = createQualityService({
      board: [btcPair],
      candles: candlesBySymbol([{ leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', series }]),
      funding: [
        { asset: 'BTC', symbol: 'GATE_FUTURE_BTC_USDT', fundingRate: '0.0001', fundingIntervalHours: 8 },
        { asset: 'BTC', symbol: 'BYBIT_FUTURE_BTC_USDT', fundingRate: '0.00005', fundingIntervalHours: 8 },
      ],
      markets: [
        liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '100', bidSize: '10', askPrice: '100', askSize: '10' }),
        liveMarket({ symbol: 'BYBIT_FUTURE_BTC_USDT', venue: 'BYBIT', asset: 'BTC', bidPrice: '100', bidSize: '5', askPrice: '100', askSize: '5' }),
      ],
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.totalCandidates).toBe(1);
    expect(response.windowHours).toBe(24);
    expect(response.cacheStatus).toBe('fresh');
    const [row] = response.rows;
    expect(row).toMatchObject({
      pairType: 'PERP_PERP', asset: 'BTC',
      leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
      leftVenue: 'GATE', rightVenue: 'BYBIT',
      currentSpreadBps: 12, updatedAt: EPOCH,
      sampleCount: 288, source: 'candles', bookDepthUsdt: 500,
    });
    // Statistics match an independent computation over the same series.
    const statistics = computeSpreadStatistics(series);
    expect(row!.meanSpreadBps!).toBeCloseTo(statistics.mean!, 8);
    expect(row!.spreadVolatilityBps!).toBeCloseTo(statistics.volatility!, 8);
    expect(row!.skewness!).toBeCloseTo(statistics.skewness!, 8);
    expect(row!.excessKurtosis!).toBeCloseTo(statistics.excessKurtosis!, 8);
    expect(row!.symmetric).toBe(statistics.symmetric);
    expect(row!.ar1Coefficient!).toBeCloseTo(statistics.ar1Coefficient!, 8);
    expect(row!.halfLifeHours!).toBeCloseTo(statistics.halfLifeHours!, 8);
    // Holding cost: |0.0001/8 − 0.00005/8| × 10⁴ = 0.0625 bps/h over the half-life, + 9.6 fees.
    const expectedCost = 0.0625 * statistics.halfLifeHours! + 9.6;
    expect(row!.holdingCostBps!).toBeCloseTo(expectedCost, 8);
    // A single candidate has no group spread to rank within: every percentile is 0.5.
    expect(row!.score).toBeCloseTo(50, 10);
    // One candle page per leg, deduped.
    expect(fixture.candleCallsFor('GATE_FUTURE_BTC_USDT')).toBe(1);
    expect(fixture.candleCallsFor('BYBIT_FUTURE_BTC_USDT')).toBe(1);
  });

  it('skips non-executable combinations and honours the pair-type filter', async () => {
    const series = ar1Sequence(mulberry32(3), 288, 0.5);
    const board = [spreadBoardRow('BTC', [
      { leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 12 },
      { leftSymbol: 'OKX_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', leftVenue: 'OKX', rightVenue: 'BYBIT', spreadBps: 30, executable: false },
      { pairType: 'SPOT_PERP', leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 20 },
    ])];
    const candles = candlesBySymbol([
      { leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', series },
      { leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', series },
    ]);
    const all = await createQualityService({ board, candles }).service.list(CATALOG, { limit: 100 });
    expect(all.totalCandidates).toBe(2);
    expect(all.rows).toHaveLength(2);
    expect(all.rows.some((row) => row.leftSymbol === 'OKX_FUTURE_BTC_USDT')).toBe(false);

    const spotOnly = await createQualityService({ board, candles }).service.list(CATALOG, { pairType: 'SPOT_PERP', limit: 100 });
    expect(spotOnly.totalCandidates).toBe(1);
    expect(spotOnly.rows[0]).toMatchObject({ pairType: 'SPOT_PERP', leftSymbol: 'GATE_SPOT_BTC_USDT' });
  });

  it('skips candidates whose legs do not align to at least 24 points', async () => {
    const full = ar1Sequence(mulberry32(5), 288, 0.6);
    const thin = ar1Sequence(mulberry32(6), 10, 0.6);
    const board = [
      spreadBoardRow('BTC', [{ leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 12 }]),
      spreadBoardRow('ETH', [{ leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 9 }]),
    ];
    const fixture = createQualityService({
      board,
      candles: candlesBySymbol([
        { leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', series: full },
        { leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', series: thin },
      ]),
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.totalCandidates).toBe(2);
    expect(response.rows.map((row) => row.asset)).toEqual(['BTC']);
  });

  it('skips a candidate when one leg fetch fails instead of failing the request', async () => {
    const series = ar1Sequence(mulberry32(9), 288, 0.6);
    const legs = legsForSpreadSeries(series);
    const fixture = createQualityService({
      board: [btcPair],
      candles: (symbol) => {
        if (symbol === 'BYBIT_FUTURE_BTC_USDT') throw new Error('venue unreachable');
        return legs.left;
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.rows).toEqual([]);
    expect(response.totalCandidates).toBe(1);
  });

  it('caps the candidate set by |spread| × depth', async () => {
    const series = ar1Sequence(mulberry32(13), 288, 0.6);
    const board = [
      spreadBoardRow('A', [{ leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 5 }]),
      spreadBoardRow('B', [{ leftSymbol: 'GATE_FUTURE_B_USDT', rightSymbol: 'BYBIT_FUTURE_B_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 10 }]),
      spreadBoardRow('C', [{ leftSymbol: 'GATE_FUTURE_C_USDT', rightSymbol: 'BYBIT_FUTURE_C_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 8 }]),
    ];
    const markets = [
      liveMarket({ symbol: 'GATE_FUTURE_A_USDT', venue: 'GATE', asset: 'A', bidSize: '1', askSize: '1' }),
      liveMarket({ symbol: 'BYBIT_FUTURE_A_USDT', venue: 'BYBIT', asset: 'A', bidSize: '1', askSize: '1' }),
      liveMarket({ symbol: 'GATE_FUTURE_B_USDT', venue: 'GATE', asset: 'B', bidSize: '10', askSize: '10' }),
      liveMarket({ symbol: 'BYBIT_FUTURE_B_USDT', venue: 'BYBIT', asset: 'B', bidSize: '10', askSize: '10' }),
      liveMarket({ symbol: 'GATE_FUTURE_C_USDT', venue: 'GATE', asset: 'C', bidSize: '5', askSize: '5' }),
      liveMarket({ symbol: 'BYBIT_FUTURE_C_USDT', venue: 'BYBIT', asset: 'C', bidSize: '5', askSize: '5' }),
    ];
    const fixture = createQualityService({
      board,
      candles: candlesBySymbol([
        { leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT', series },
        { leftSymbol: 'GATE_FUTURE_B_USDT', rightSymbol: 'BYBIT_FUTURE_B_USDT', series },
        { leftSymbol: 'GATE_FUTURE_C_USDT', rightSymbol: 'BYBIT_FUTURE_C_USDT', series },
      ]),
      markets,
      candidateLimit: 2,
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    // Depth (min of bid/ask notional, 99/101 quotes): A = 99, B = 990, C = 495.
    // Weights |spread| × depth: A = 495, B = 9900, C = 3960 → the top two are B and C.
    expect(response.totalCandidates).toBe(2);
    expect(response.rows.map((row) => row.asset).sort()).toEqual(['B', 'C']);
    expect(MAX_SPREAD_QUALITY_CANDIDATES).toBe(50);
  });

  it('computes holding cost per pair shape and falls back to 4h without a half-life', async () => {
    // A flat zero spread is the degenerate series: σ = 0 exactly, so no moment, no
    // autocorrelation and no half-life — the holding window falls back to 4 hours.
    const constantSeries = Array.from({ length: 288 }, () => 0);
    const board = [
      spreadBoardRow('BTC', [{
        pairType: 'SPOT_PERP',
        leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'BINANCE_FUTURE_BTC_USDT',
        leftVenue: 'GATE', rightVenue: 'BINANCE', spreadBps: 8,
      }]),
      spreadBoardRow('ETH', [{
        leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT',
        leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 6,
      }]),
    ];
    const fixture = createQualityService({
      board,
      candles: candlesBySymbol([
        { leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'BINANCE_FUTURE_BTC_USDT', series: constantSeries },
        { leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', series: constantSeries },
      ]),
      funding: [
        // Only the BINANCE leg is known: the SPOT_PERP row costs its rate, the PERP_PERP
        // row has an unknown leg and must report a null cost rather than assume zero.
        { asset: 'BTC', symbol: 'BINANCE_FUTURE_BTC_USDT', fundingRate: '0.0002', fundingIntervalHours: 8 },
      ],
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    const spotPerp = response.rows.find((row) => row.asset === 'BTC')!;
    // |0.0002|/8h × 10⁴ = 0.25 bps/h; constant series → no half-life → 4h fallback; + 9.6 fees.
    expect(spotPerp.halfLifeHours).toBeNull();
    expect(spotPerp.spreadVolatilityBps).toBe(0);
    expect(spotPerp.skewness).toBeNull();
    expect(spotPerp.holdingCostBps!).toBeCloseTo(0.25 * 4 + 9.6, 10);
    const perpPerp = response.rows.find((row) => row.asset === 'ETH')!;
    expect(perpPerp.holdingCostBps).toBeNull();
  });

  it('takes the weaker leg top-of-book notional as depth, zero when a leg is unknown', async () => {
    const series = ar1Sequence(mulberry32(17), 288, 0.6);
    const fixture = createQualityService({
      board: [btcPair],
      candles: candlesBySymbol([{ leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', series }]),
      markets: [
        liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '100', bidSize: '10', askPrice: '100', askSize: '20' }),
        liveMarket({ symbol: 'BYBIT_FUTURE_BTC_USDT', venue: 'BYBIT', asset: 'BTC', bidPrice: '50', bidSize: '2', askPrice: '60', askSize: '3' }),
      ],
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    // GATE leg: min(1000, 2000) = 1000; BYBIT leg: min(100, 180) = 100 → pair depth 100.
    expect(response.rows[0]!.bookDepthUsdt).toBe(100);

    const unknown = createQualityService({
      board: [btcPair],
      candles: candlesBySymbol([{ leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', series }]),
    });
    expect((await unknown.service.list(CATALOG, { limit: 100 })).rows[0]!.bookDepthUsdt).toBe(0);
  });

  it('caches one computation per pair type for the TTL and recomputes on invalidation', async () => {
    const series = ar1Sequence(mulberry32(19), 288, 0.6);
    const fixture = createQualityService({
      board: [btcPair],
      candles: candlesBySymbol([{ leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', series }]),
      cacheTtlMs: 60_000,
    });
    const first = await fixture.service.list(CATALOG, { limit: 100 });
    const second = await fixture.service.list(CATALOG, { limit: 100 });
    expect(fixture.boardCalls()).toBe(1);
    expect(fixture.candleCalls()).toBe(2);
    expect(second.fetchedAt).toBe(first.fetchedAt);

    // A different pair type is its own cache entry and its own computation.
    await fixture.service.list(CATALOG, { pairType: 'SPOT_PERP', limit: 100 });
    expect(fixture.boardCalls()).toBe(2);
    expect(fixture.service.cacheSize()).toBe(2);

    // Inside the TTL the entry is reused; past it, one fresh computation runs.
    fixture.advance(30_000);
    await fixture.service.list(CATALOG, { limit: 100 });
    expect(fixture.boardCalls()).toBe(2);
    fixture.advance(31_000);
    await fixture.service.list(CATALOG, { limit: 100 });
    expect(fixture.boardCalls()).toBe(3);

    fixture.service.invalidateCache();
    await fixture.service.list(CATALOG, { limit: 100 });
    expect(fixture.boardCalls()).toBe(4);
  });

  it('slices the ranked rows by limit and keeps the funding overview fresh', async () => {
    const series = ar1Sequence(mulberry32(23), 288, 0.6);
    const board = [
      spreadBoardRow('BTC', [{ leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 12 }]),
      spreadBoardRow('ETH', [{ leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 4 }]),
    ];
    const fixture = createQualityService({
      board,
      candles: candlesBySymbol([
        { leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', series },
        { leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', series },
      ]),
    });
    const full = await fixture.service.list(CATALOG, { limit: 100 });
    expect(full.rows).toHaveLength(2);
    expect(full.rows[0]!.score).toBeGreaterThanOrEqual(full.rows[1]!.score);
    const page = await fixture.service.list(CATALOG, { limit: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.asset).toBe(full.rows[0]!.asset);
    expect(page.totalCandidates).toBe(2);
    expect(fixture.ensureFreshCalls()).toBe(1);
  });

  it('answers an empty board without touching the candle feeds', async () => {
    const fixture = createQualityService({ board: [] });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response).toMatchObject({ rows: [], totalCandidates: 0, windowHours: 24 });
    expect(fixture.candleCalls()).toBe(0);
  });
});

describe('spread quality samples track', () => {
  const btcPair = spreadBoardRow('BTC', [{
    leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
    leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 12,
  }]);
  const btcCoverage = new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), promotedCoverage()]]);
  const btcCandles = candlesBySymbol([{
    leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
    series: ar1Sequence(mulberry32(11), 288, 0.7),
  }]);

  it('rebuilds a promoted pair from its 30s samples and skips the candle fan-out', async () => {
    const series = ar1Sequence(mulberry32(41), 240, 0.7);
    const fixture = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: btcCoverage,
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series)],
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    const [row] = response.rows;
    expect(row).toMatchObject({
      asset: 'BTC', source: 'samples', sampleCount: 240,
      leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
    });
    // Statistics match an independent computation at the samples cadence (0.5 min/point).
    const statistics = computeSpreadStatistics(series, SPREAD_SAMPLE_MINUTES_PER_POINT);
    expect(row!.meanSpreadBps!).toBeCloseTo(statistics.mean!, 8);
    expect(row!.spreadVolatilityBps!).toBeCloseTo(statistics.volatility!, 8);
    expect(row!.ar1Coefficient!).toBeCloseTo(statistics.ar1Coefficient!, 8);
    expect(row!.halfLifeHours!).toBeCloseTo(statistics.halfLifeHours!, 8);
    // The promoted pair never reaches the venue candle feeds at all.
    expect(fixture.candleCalls()).toBe(0);
  });

  it('keeps a pair on candles when its sample series is one point short of the minimum', async () => {
    const series = ar1Sequence(mulberry32(43), 239, 0.7);
    const fixture = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: btcCoverage,
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series)],
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.rows[0]).toMatchObject({ asset: 'BTC', source: 'candles', sampleCount: 288 });
    expect(fixture.candleCalls()).toBe(2);
  });

  it('keeps a pair on candles when coverage is below the 80% threshold', async () => {
    const series = ar1Sequence(mulberry32(47), 240, 0.7);
    const fixture = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), {
          count: 2303, oldestMs: EPOCH_MS - SPREAD_QUALITY_WINDOW_MS, newestMs: EPOCH_MS,
        }]]),
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series)],
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.rows[0]).toMatchObject({ asset: 'BTC', source: 'candles', sampleCount: 288 });
  });

  it('keeps a pair on candles when the sample span is under 24h', async () => {
    const series = ar1Sequence(mulberry32(53), 240, 0.7);
    const fixture = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), {
          count: 2880, oldestMs: EPOCH_MS - 23 * 60 * 60_000, newestMs: EPOCH_MS,
        }]]),
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series)],
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.rows[0]).toMatchObject({ asset: 'BTC', source: 'candles', sampleCount: 288 });
  });

  it('mixes both sources on one board and reads candles only for the ungraduated pair', async () => {
    const btcSeries = ar1Sequence(mulberry32(59), 240, 0.7);
    const ethPair = spreadBoardRow('ETH', [{
      leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT',
      leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 9,
    }]);
    const fixture = createQualityService({
      board: [btcPair, ethPair],
      // Only ETH's legs are stubbed: if the samples track leaked into the candle path for
      // BTC, the missing page would surface as a skipped row instead of a samples row.
      candles: candlesBySymbol([
        { leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', series: ar1Sequence(mulberry32(61), 288, 0.6) },
      ]),
      samples: {
        coverage: btcCoverage,
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', btcSeries)],
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    const byAsset = new Map(response.rows.map((row) => [row.asset, row]));
    expect(byAsset.get('BTC')).toMatchObject({ source: 'samples', sampleCount: 240 });
    expect(byAsset.get('ETH')).toMatchObject({ source: 'candles', sampleCount: 288 });
    expect(fixture.candleCallsFor('GATE_FUTURE_BTC_USDT')).toBe(0);
    expect(fixture.candleCallsFor('GATE_FUTURE_ETH_USDT')).toBe(1);
    expect(fixture.candleCallsFor('BYBIT_FUTURE_ETH_USDT')).toBe(1);
  });

  it('takes depth from the newest sample and falls back to the hub when it is zero', async () => {
    const series = ar1Sequence(mulberry32(67), 240, 0.7);
    const markets = [
      liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '10', bidSize: '10', askPrice: '10', askSize: '10' }),
      liveMarket({ symbol: 'BYBIT_FUTURE_BTC_USDT', venue: 'BYBIT', asset: 'BTC', bidPrice: '10', bidSize: '10', askPrice: '10', askSize: '10' }),
    ];
    const sampled = await createQualityService({
      board: [btcPair],
      markets,
      samples: {
        coverage: btcCoverage,
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series, 4321)],
      },
    }).service.list(CATALOG, { limit: 100 });
    // Hub reads 100 per leg; the newest sample observed 4321, which wins.
    expect(sampled.rows[0]!.bookDepthUsdt).toBe(4321);

    const undepth = await createQualityService({
      board: [btcPair],
      markets,
      samples: {
        coverage: btcCoverage,
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series, 0)],
      },
    }).service.list(CATALOG, { limit: 100 });
    expect(undepth.rows[0]!.bookDepthUsdt).toBe(100);
  });

  it('degrades to candles when the sample store throws', async () => {
    const fixture = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: () => { throw new Error('sample store unavailable'); },
        series: [],
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.rows[0]).toMatchObject({ asset: 'BTC', source: 'candles', sampleCount: 288 });
  });

  it('keeps every pair on candles when no sample store is wired', async () => {
    // Same board and candles as the promoted tests, minus the samples dependency: the
    // candles track must behave exactly as it did before the sampler existed.
    const withoutStore = createQualityService({ board: [btcPair], candles: btcCandles });
    const response = await withoutStore.service.list(CATALOG, { limit: 100 });
    expect(response.rows[0]).toMatchObject({ asset: 'BTC', source: 'candles', sampleCount: 288 });
    expect(withoutStore.candleCalls()).toBe(2);
  });
});

describe('server-side sort and paging (R8)', () => {
  /** Rows with distinct `mean` and `current` values so each sort key has a strict order. */
  function rowsForSort(): SpreadQualityRow[] {
    return scoreSpreadQualityInputs([
      scoreInput({ asset: 'A', leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT', currentSpreadBps: 30, meanSpreadBps: 10, spreadVolatilityBps: 3, halfLifeHours: 2, bookDepthUsdt: 300 }),
      scoreInput({ asset: 'B', leftSymbol: 'GATE_FUTURE_B_USDT', rightSymbol: 'BYBIT_FUTURE_B_USDT', currentSpreadBps: 10, meanSpreadBps: 30, spreadVolatilityBps: 1, halfLifeHours: 3, bookDepthUsdt: 100 }),
      scoreInput({ asset: 'C', leftSymbol: 'GATE_FUTURE_C_USDT', rightSymbol: 'BYBIT_FUTURE_C_USDT', currentSpreadBps: 20, meanSpreadBps: 20, spreadVolatilityBps: 2, halfLifeHours: 1, bookDepthUsdt: 200 }),
    ]);
  }

  it('sorts by every key in both directions', () => {
    const rows = rowsForSort();
    expect(sortSpreadQualityRows(rows, 'mean', 'asc').map((row) => row.asset)).toEqual(['A', 'C', 'B']);
    expect(sortSpreadQualityRows(rows, 'mean', 'desc').map((row) => row.asset)).toEqual(['B', 'C', 'A']);
    expect(sortSpreadQualityRows(rows, 'current', 'asc').map((row) => row.asset)).toEqual(['B', 'C', 'A']);
    expect(sortSpreadQualityRows(rows, 'volatility', 'asc').map((row) => row.asset)).toEqual(['B', 'C', 'A']);
    expect(sortSpreadQualityRows(rows, 'halfLife', 'desc').map((row) => row.asset)).toEqual(['B', 'A', 'C']);
    expect(sortSpreadQualityRows(rows, 'depth', 'asc').map((row) => row.asset)).toEqual(['B', 'C', 'A']);
    // Default keeps the composite-score ranking, descending.
    expect(sortSpreadQualityRows(rows).every((row, index, sorted) =>
      index === 0 || sorted[index - 1]!.score >= row.score)).toBe(true);
  });

  it('sinks nulls last in both directions', () => {
    const rows = scoreSpreadQualityInputs([
      scoreInput({ asset: 'A', leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT', meanSpreadBps: 10, halfLifeHours: null }),
      scoreInput({ asset: 'B', leftSymbol: 'GATE_FUTURE_B_USDT', rightSymbol: 'BYBIT_FUTURE_B_USDT', meanSpreadBps: 30, halfLifeHours: 1 }),
      scoreInput({ asset: 'C', leftSymbol: 'GATE_FUTURE_C_USDT', rightSymbol: 'BYBIT_FUTURE_C_USDT', meanSpreadBps: null }),
    ]);
    // C (no mean) is not boardable at all; A has no half-life and sinks below B either way.
    const board = rows.filter((row) => row.asset !== 'C');
    expect(sortSpreadQualityRows(board, 'halfLife', 'asc').map((row) => row.asset)).toEqual(['B', 'A']);
    expect(sortSpreadQualityRows(board, 'halfLife', 'desc').map((row) => row.asset)).toEqual(['B', 'A']);
  });

  it('pages a server-sorted board without recomputing it', async () => {
    const flat = (bps: number): number[] => Array.from({ length: 30 }, () => bps);
    const board = [
      spreadBoardRow('BTC', [{ leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 10 }]),
      spreadBoardRow('ETH', [{ leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 20 }]),
      spreadBoardRow('SOL', [{ leftSymbol: 'GATE_FUTURE_SOL_USDT', rightSymbol: 'BYBIT_FUTURE_SOL_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 30 }]),
    ];
    const legs = [
      { leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', series: flat(10) },
      { leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', series: flat(20) },
      { leftSymbol: 'GATE_FUTURE_SOL_USDT', rightSymbol: 'BYBIT_FUTURE_SOL_USDT', series: flat(30) },
    ];
    const fixture = createQualityService({ board, candles: candlesBySymbol(legs) });
    const ascending = await fixture.service.list(CATALOG, { sort: 'mean', dir: 'asc', offset: 0, limit: 2 });
    expect(ascending).toMatchObject({ sort: 'mean', dir: 'asc', offset: 0, total: 3 });
    expect(ascending.rows.map((row) => row.asset)).toEqual(['BTC', 'ETH']);
    const page2 = await fixture.service.list(CATALOG, { sort: 'mean', dir: 'asc', offset: 2, limit: 2 });
    expect(page2.rows.map((row) => row.asset)).toEqual(['SOL']);
    // The board cache is keyed by pair type only: paging and sorting never recompute candles.
    expect(fixture.boardCalls()).toBe(1);
    expect(fixture.candleCalls()).toBe(6);
    const descending = await fixture.service.list(CATALOG, { sort: 'mean', dir: 'desc', limit: 100 });
    expect(descending.rows.map((row) => row.asset)).toEqual(['SOL', 'ETH', 'BTC']);
  });
});

describe('quote-alignment candidate gate (R4)', () => {
  it('excludes only the combinations the board judged quote-unaligned', () => {
    const board = [spreadBoardRow('BTC', [
      { leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 10 },
      { leftSymbol: 'OKX_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', leftVenue: 'OKX', rightVenue: 'BYBIT', spreadBps: 40, quoteAligned: false },
      { leftSymbol: 'BITGET_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', leftVenue: 'BITGET', rightVenue: 'BYBIT', spreadBps: 30, quoteAligned: true },
    ])];
    const candidates = selectSpreadQualityCandidates(board, undefined, { market: () => null }, 50);
    // The unaligned OKX combination is excluded; the survivors tie on weight (no hub depth) and
    // fall back to the alphabetical left-symbol tie-break.
    expect(candidates.map((candidate) => candidate.combination.leftSymbol))
      .toEqual(['BITGET_FUTURE_BTC_USDT', 'GATE_FUTURE_BTC_USDT']);
  });
});
