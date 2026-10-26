/**
 * Adversarial QA verification of the spread-quality board + 30s sampler (v1.5).
 *
 * Fresh-eyes suite: nothing in this file is shared with the delivery's own tests. It re-pins the
 * contracts the frontend depends on — above all the server-side ranking contract (the UI never
 * re-sorts) — and pushes the dual-track promotion, half-life cadence, hostile-data, cache,
 * sampler-resilience and migration-0024 boundaries from directions the existing suites do not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FundingStatVenue, PublicMarketDataGateway, VenueBookTicker } from '@gate-crossex/public-data';
import type {
  Candle,
  FundingOverviewResponse,
  MarketCatalogVenue,
  PublicMarketSnapshot,
  SpreadOpportunity,
} from '@gate-crossex/shared-types';
import { SpreadQualityResponseSchema } from '@gate-crossex/shared-types';
import { buildApp } from './app.js';
import type { GateCrossExSymbol, ReadOnlyCrossExGateway } from './crossex-client.js';
import { loadConfig } from './config.js';
import { MemoryCredentialVault } from './credential-vault.js';
import { openDatabase } from './database.js';
import type { LiveMarket } from './market-hub.js';
import {
  pruneSpreadSamples,
  readSpreadSeries,
  recordSpreadSamples,
  spreadSampleCoverage,
  spreadSamplePairKey,
  type SpreadSampleCoverage,
  type SpreadSampleRow,
} from './repositories.js';
import {
  MAX_SPREAD_QUALITY_CANDIDATES,
  SPREAD_QUALITY_INTERVAL,
  SPREAD_QUALITY_WINDOW_HOURS,
  SPREAD_QUALITY_WINDOW_MS,
  SPREAD_SAMPLE_INTERVAL_MS,
  SPREAD_SAMPLE_MINUTES_PER_POINT,
  SPREAD_SAMPLE_MIN_COVERAGE_POINTS,
  SPREAD_SAMPLE_MIN_POINTS,
  SPREAD_SAMPLE_WINDOW_POINTS,
  SpreadQualityService,
  alignSpreadSeries,
  averageRanks,
  computeSpreadStatistics,
  halfLifeFromAr1,
  percentileRanks,
  scoreSpreadQualityInputs,
  type SpreadQualityScoreInput,
} from './spread-quality.js';
import { SpreadSampler } from './spread-sampler.js';
import { TradingSession } from './trading-session.js';

const EPOCH = '2026-08-01T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH);
const STEP_MS = 5 * 60_000;
const CATALOG = { assets: new Map<string, MarketCatalogVenue[]>() };
const ROUTE_HEADERS = { host: '127.0.0.1:17840' };

// ---------------------------------------------------------------------------
// deterministic series helpers
// ---------------------------------------------------------------------------

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

/** Recursively assert a parsed payload carries no NaN / Infinity anywhere. */
function assertNoNonFinite(value: unknown, path = '$'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} is not finite: ${value}`).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNonFinite(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertNoNonFinite(item, `${path}.${key}`);
  }
}

// ---------------------------------------------------------------------------
// service-level fixture (independent of the delivery's own test fixture)
// ---------------------------------------------------------------------------

interface QualityFixture {
  service: SpreadQualityService;
  boardCalls: () => number;
  candleCalls: () => number;
  candleCallsFor: (symbol: string) => number;
  coverageCalls: () => number;
  lastCoverageFromMs: () => number | null;
  seriesCalls: () => number;
  ensureFreshCalls: () => number;
  advance: (milliseconds: number) => void;
}

interface QualityOptions {
  board: readonly SpreadOpportunity[] | (() => Promise<readonly SpreadOpportunity[]> | readonly SpreadOpportunity[]);
  candles?: (symbol: string) => readonly Candle[];
  funding?: FundingFixture[];
  markets?: LiveMarket[];
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  candidateLimit?: number;
  candleConcurrency?: number;
  samples?: {
    coverage:
      | ReadonlyMap<string, SpreadSampleCoverage>
      | ((pairs: ReadonlyArray<{ leftSymbol: string; rightSymbol: string }>, fromMs: number) => Map<string, SpreadSampleCoverage>);
    series?:
      | ReadonlyArray<{ leftSymbol: string; rightSymbol: string; rows: readonly SpreadSampleRow[] }>
      | ((leftSymbol: string, rightSymbol: string, fromMs: number) => readonly SpreadSampleRow[]);
  };
}

function createQualityService(options: QualityOptions): QualityFixture {
  let boardCalls = 0;
  let ensureFreshCalls = 0;
  let coverageCalls = 0;
  let seriesCalls = 0;
  let lastCoverageFromMs: number | null = null;
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
      return typeof options.board === 'function' ? await options.board() : options.board;
    },
    loadCandles: async (symbol) => {
      candleCallCounts.set(symbol, (candleCallCounts.get(symbol) ?? 0) + 1);
      return options.candles ? options.candles(symbol) : [];
    },
    ...(options.samples !== undefined ? {
      samples: {
        coverage: (pairs, fromMs) => {
          coverageCalls += 1;
          lastCoverageFromMs = fromMs;
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
        series: (leftSymbol, rightSymbol, fromMs) => {
          seriesCalls += 1;
          const source = options.samples!.series;
          if (source === undefined) return [];
          if (typeof source === 'function') return source(leftSymbol, rightSymbol, fromMs);
          return source.find((entry) => entry.leftSymbol === leftSymbol && entry.rightSymbol === rightSymbol)?.rows ?? [];
        },
      },
    } : {}),
  }, {
    now: () => nowMs,
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.cacheMaxEntries !== undefined ? { cacheMaxEntries: options.cacheMaxEntries } : {}),
    ...(options.candidateLimit !== undefined ? { candidateLimit: options.candidateLimit } : {}),
    ...(options.candleConcurrency !== undefined ? { candleConcurrency: options.candleConcurrency } : {}),
  });
  return {
    service,
    boardCalls: () => boardCalls,
    candleCalls: () => [...candleCallCounts.values()].reduce((sum, count) => sum + count, 0),
    candleCallsFor: (symbol) => candleCallCounts.get(symbol) ?? 0,
    coverageCalls: () => coverageCalls,
    lastCoverageFromMs: () => lastCoverageFromMs,
    seriesCalls: () => seriesCalls,
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

/** A coverage entry pinned at an exact point count and span around the fixture epoch. */
function coverageOf(count: number, spanMs: number): SpreadSampleCoverage {
  return { count, oldestMs: EPOCH_MS - spanMs, newestMs: EPOCH_MS };
}

// ---------------------------------------------------------------------------
// sampler fixture
// ---------------------------------------------------------------------------

const openedDatabases: Database.Database[] = [];

interface SamplerFixture {
  sampler: SpreadSampler;
  database: Database.Database;
  rows: (leftSymbol?: string, rightSymbol?: string) => SpreadSampleRow[];
  warnings: string[];
}

function createSampler(options: {
  board: () => Promise<readonly SpreadOpportunity[]>;
  market: (symbol: string) => LiveMarket | null;
  intervalMs?: number;
  retentionMs?: number;
  pruneIntervalMs?: number;
  candidateLimit?: number;
  now?: () => number;
}): SamplerFixture {
  const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
  openedDatabases.push(database);
  const warnings: string[] = [];
  const sampler = new SpreadSampler({
    database,
    hub: { market: options.market },
    spreadBoard: options.board,
    warn: (reason) => { warnings.push(reason); },
  }, {
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.retentionMs !== undefined ? { retentionMs: options.retentionMs } : {}),
    ...(options.pruneIntervalMs !== undefined ? { pruneIntervalMs: options.pruneIntervalMs } : {}),
    ...(options.candidateLimit !== undefined ? { candidateLimit: options.candidateLimit } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return {
    sampler,
    database,
    rows: (leftSymbol = 'GATE_FUTURE_BTC_USDT', rightSymbol = 'BYBIT_FUTURE_BTC_USDT') =>
      readSpreadSeries(database, leftSymbol, rightSymbol, 0),
    warnings,
  };
}

function btcBoardRow(): SpreadOpportunity {
  return spreadBoardRow('BTC', [{
    leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
    leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 12,
  }]);
}

// ---------------------------------------------------------------------------
// route-level fixture (minimal buildApp wiring; the delivery's own app fixture is not reused)
// ---------------------------------------------------------------------------

interface RouteFixture {
  app: FastifyInstance;
  database: Database.Database;
  publicMarketGateway: RoutePublicMarketGateway;
  directory: string;
}

class RoutePublicMarketGateway implements PublicMarketDataGateway {
  candleQueryCount = 0;
  bookTickers: VenueBookTicker[] = [];
  candles: (symbol: string) => readonly Candle[] = () => [];

  async querySnapshot(_symbol: string): Promise<PublicMarketSnapshot> {
    throw new Error('route fixture: snapshot not implemented');
  }

  async queryVenueBookTickers(venue: FundingStatVenue): Promise<VenueBookTicker[]> {
    return this.bookTickers.filter((ticker) => ticker.venue === venue);
  }

  async queryCandles(symbol: string): Promise<Candle[]> {
    this.candleQueryCount += 1;
    return [...this.candles(symbol)];
  }
}

function catalogSymbol(symbol: string, venue: string): GateCrossExSymbol {
  return {
    symbol, exchange_type: venue, business_type: 'FUTURE', state: 'live',
    min_size: '0.001', min_notional: '5', lot_size: '0.001', tick_size: '0.01',
    max_num_orders: '100', max_market_size: '120', max_limit_size: '1000', contract_size: null,
    liquidation_fee: '0.0125', default_leverage: '3', delist_time: '0',
  };
}

const routeApps: RouteFixture[] = [];
const routeDirectories: string[] = [];

async function createRouteApp(symbols: GateCrossExSymbol[]): Promise<RouteFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-spread-qa-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
  });
  const database = openDatabase(config.databasePath, config.migrationsDir);
  const publicMarketGateway = new RoutePublicMarketGateway();
  const crossExGateway: ReadOnlyCrossExGateway = {
    queryAccount: async () => { throw new Error('route fixture: account not implemented'); },
    querySymbols: async () => symbols,
    queryRiskLimits: async () => [],
    queryPositions: async () => { throw new Error('route fixture: positions not implemented'); },
    queryPortfolio: async () => { throw new Error('route fixture: portfolio not implemented'); },
  };
  const app = await buildApp({
    config,
    database,
    credentialVault: new MemoryCredentialVault(),
    crossExGateway,
    publicMarketGateway,
    tradingSession: new TradingSession(),
    authDisabled: true,
    logger: false,
  });
  const fixture: RouteFixture = { app, database, publicMarketGateway, directory };
  routeApps.push(fixture);
  routeDirectories.push(directory);
  return fixture;
}

afterEach(async () => {
  while (openedDatabases.length > 0) openedDatabases.pop()!.close();
  while (routeApps.length > 0) {
    const fixture = routeApps.pop()!;
    await fixture.app.close();
    fixture.database.close();
  }
  for (const directory of routeDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

/** Flat candles reproducing a constant `bps` spread against a flat right leg. */
function flatCandles(bps: number, count = 300, startTime = 1_783_688_880_000): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 * (1 + bps / 10_000);
    return {
      startTime: startTime + index * 300_000,
      open: String(close), high: String(close), low: String(close), close: String(close),
      volume: '1', closed: true,
    };
  });
}

// ---------------------------------------------------------------------------
// 1. ranking contract — the correctness bedrock the frontend trusts
// ---------------------------------------------------------------------------

describe('spread quality ranking contract', () => {
  it('ranks strictly by composite score, re-ordering a worse-first input', () => {
    const weak = scoreInput({
      asset: 'AAA', leftSymbol: 'GATE_FUTURE_AAA_USDT', rightSymbol: 'BYBIT_FUTURE_AAA_USDT',
      meanSpreadBps: 1, spreadVolatilityBps: 0.1, halfLifeHours: 4, skewness: -1,
      excessKurtosis: -2, holdingCostBps: 5, bookDepthUsdt: 10,
    });
    const strong = scoreInput({
      asset: 'ZZZ', leftSymbol: 'GATE_FUTURE_ZZZ_USDT', rightSymbol: 'BYBIT_FUTURE_ZZZ_USDT',
      meanSpreadBps: 50, spreadVolatilityBps: 5, halfLifeHours: 0.1, skewness: 1,
      excessKurtosis: 2, holdingCostBps: 0, bookDepthUsdt: 100_000,
    });
    const rows = scoreSpreadQualityInputs([weak, strong]);
    // The stronger candidate was second in the input: the service must re-rank, never replay order.
    expect(rows.map((row) => row.asset)).toEqual(['ZZZ', 'AAA']);
    expect(rows[0]!.score).toBeGreaterThan(rows[1]!.score);
  });

  it('breaks score ties by current spread, then asset, left symbol, right symbol', () => {
    const tied = {
      meanSpreadBps: 10, spreadVolatilityBps: 2, halfLifeHours: 0.5, skewness: 0.1,
      excessKurtosis: 0.2, holdingCostBps: 1, bookDepthUsdt: 100,
    };
    // Level 1: wider current spread first when everything else ties.
    const byCurrentSpread = scoreSpreadQualityInputs([
      scoreInput({ asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', currentSpreadBps: 20, ...tied }),
      scoreInput({ asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', currentSpreadBps: 30, ...tied }),
    ]);
    expect(byCurrentSpread.map((row) => row.currentSpreadBps)).toEqual([30, 20]);
    // Level 2: asset ascending.
    const byAsset = scoreSpreadQualityInputs([
      scoreInput({ asset: 'ETH', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', ...tied }),
      scoreInput({ asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', ...tied }),
    ]);
    expect(byAsset.map((row) => row.asset)).toEqual(['BTC', 'ETH']);
    // Level 3: left symbol ascending.
    const byLeftSymbol = scoreSpreadQualityInputs([
      scoreInput({ asset: 'BTC', leftSymbol: 'OKX_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', ...tied }),
      scoreInput({ asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', ...tied }),
    ]);
    expect(byLeftSymbol.map((row) => row.leftSymbol)).toEqual(['GATE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT']);
    // Level 4: right symbol ascending.
    const byRightSymbol = scoreSpreadQualityInputs([
      scoreInput({ asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'OKX_FUTURE_BTC_USDT', ...tied }),
      scoreInput({ asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', ...tied }),
    ]);
    expect(byRightSymbol.map((row) => row.rightSymbol)).toEqual(['BYBIT_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT']);
  });

  it('is element-wise deterministic across repeated runs, full ties included', () => {
    const tied = {
      meanSpreadBps: 10, spreadVolatilityBps: 2, halfLifeHours: 0.5, skewness: 0.1,
      excessKurtosis: 0.2, holdingCostBps: 1, bookDepthUsdt: 100,
    };
    const inputs = [
      scoreInput({ asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', ...tied }),
      // A full tie on every tie-break key: only the venue fields differ, so the stable sort must
      // preserve input order — and it must do so identically on every run.
      scoreInput({ asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', leftVenue: 'AAX', ...tied }),
      scoreInput({ asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', currentSpreadBps: 40, ...tied }),
      scoreInput({ asset: 'ETH', leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', ...tied }),
    ];
    const first = scoreSpreadQualityInputs(inputs);
    const second = scoreSpreadQualityInputs(inputs);
    expect(second).toEqual(first);
    // Full ties keep their input order (stable sort); the wider current spread leads its
    // score group, and the ETH row sorts after the BTC rows on the asset tie-break.
    expect(first.map((row) => row.leftVenue)).toEqual(['GATE', 'GATE', 'AAX', 'GATE']);
    expect(first[0]!.currentSpreadBps).toBe(40);
  });

  it('never produces a NaN score for an all-null factor group', () => {
    const nulls = {
      meanSpreadBps: 10, spreadVolatilityBps: null, halfLifeHours: null, skewness: null,
      excessKurtosis: null, holdingCostBps: null, bookDepthUsdt: 0,
    };
    const rows = scoreSpreadQualityInputs([
      scoreInput({ asset: 'A', leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT', ...nulls }),
      scoreInput({ asset: 'B', leftSymbol: 'GATE_FUTURE_B_USDT', rightSymbol: 'BYBIT_FUTURE_B_USDT', ...nulls }),
      scoreInput({ asset: 'C', leftSymbol: 'GATE_FUTURE_C_USDT', rightSymbol: 'BYBIT_FUTURE_C_USDT', meanSpreadBps: 20, spreadVolatilityBps: null, halfLifeHours: null, skewness: null, excessKurtosis: null, holdingCostBps: null, bookDepthUsdt: 0 }),
    ]);
    for (const row of rows) {
      expect(Number.isFinite(row.score)).toBe(true);
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
    }
    // A and B tie on every factor; C's larger mean outranks them. bookDepthUsdt = 0 is a
    // present (not null) factor, so all three tie at its neutral 0.5 percentile.
    expect(rows.map((row) => row.asset)).toEqual(['C', 'A', 'B']);
    expect(rows[0]!.score).toBeCloseTo(35, 10);
    expect(rows[1]!.score).toBeCloseTo(12.5, 10);
    // A lone all-null candidate scores at the neutral midpoint of its only present factor.
    const [lone] = scoreSpreadQualityInputs([
      scoreInput({ asset: 'A', leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT', ...nulls }),
    ]);
    expect(Number.isFinite(lone!.score)).toBe(true);
  });

  it('keeps every score inside [0, 100] across a hostile mixed group', () => {
    const rows = scoreSpreadQualityInputs([
      scoreInput({ asset: 'A', leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT', meanSpreadBps: -50, spreadVolatilityBps: 100, halfLifeHours: null, skewness: -3, excessKurtosis: 12, holdingCostBps: 40, bookDepthUsdt: 0 }),
      scoreInput({ asset: 'B', leftSymbol: 'GATE_FUTURE_B_USDT', rightSymbol: 'BYBIT_FUTURE_B_USDT', meanSpreadBps: 50, spreadVolatilityBps: 0, halfLifeHours: 0.01, skewness: 3, excessKurtosis: -2, holdingCostBps: null, bookDepthUsdt: 9e15 }),
      scoreInput({ asset: 'C', leftSymbol: 'GATE_FUTURE_C_USDT', rightSymbol: 'BYBIT_FUTURE_C_USDT', meanSpreadBps: 0, spreadVolatilityBps: null, halfLifeHours: 24, skewness: null, excessKurtosis: null, holdingCostBps: 0, bookDepthUsdt: 1 }),
      scoreInput({ asset: 'D', leftSymbol: 'GATE_FUTURE_D_USDT', rightSymbol: 'BYBIT_FUTURE_D_USDT', meanSpreadBps: 12, spreadVolatilityBps: 3, halfLifeHours: 2, skewness: 0, excessKurtosis: 0, holdingCostBps: 12, bookDepthUsdt: 500 }),
    ]);
    for (const row of rows) {
      expect(Number.isFinite(row.score)).toBe(true);
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
    }
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index - 1]!.score).toBeGreaterThanOrEqual(rows[index]!.score);
    }
  });

  it('re-ranks through the service: the first candidate is not the first row', async () => {
    // Candidate order is |spread| × depth with zero depth everywhere, i.e. alphabetical by
    // asset: AAA is candidate #1. Its candles are degenerate (constant spread); ZZZ's are not.
    const board = [
      spreadBoardRow('AAA', [{ leftSymbol: 'GATE_FUTURE_AAA_USDT', rightSymbol: 'BYBIT_FUTURE_AAA_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 40 }]),
      spreadBoardRow('ZZZ', [{ leftSymbol: 'GATE_FUTURE_ZZZ_USDT', rightSymbol: 'BYBIT_FUTURE_ZZZ_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 4 }]),
    ];
    const fixture = createQualityService({
      board,
      candles: candlesBySymbol([
        { leftSymbol: 'GATE_FUTURE_AAA_USDT', rightSymbol: 'BYBIT_FUTURE_AAA_USDT', series: Array.from({ length: 288 }, () => 5) },
        { leftSymbol: 'GATE_FUTURE_ZZZ_USDT', rightSymbol: 'BYBIT_FUTURE_ZZZ_USDT', series: ar1Sequence(mulberry32(71), 288, 0.7).map((value) => value + 20) },
      ]),
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.rows.map((row) => row.asset)).toEqual(['ZZZ', 'AAA']);
    expect(response.rows[0]!.score).toBeGreaterThan(response.rows[1]!.score);
    for (let index = 1; index < response.rows.length; index += 1) {
      expect(response.rows[index - 1]!.score).toBeGreaterThanOrEqual(response.rows[index]!.score);
    }
  });

  it('pins the ascending-rank helpers the composite is built from', () => {
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    expect(percentileRanks([10, 10, 20])).toEqual([0.25, 0.25, 1]);
    // Missing factors take the worst percentile; a lone value parks at the midpoint.
    expect(percentileRanks([null, 10, 20])).toEqual([0, 0, 1]);
    expect(percentileRanks([42])).toEqual([0.5]);
    expect(percentileRanks([null, null])).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------
// 2. dual-track promotion boundaries
// ---------------------------------------------------------------------------

describe('spread quality dual-track boundaries', () => {
  const btcPair = spreadBoardRow('BTC', [{
    leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
    leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 12,
  }]);
  const btcCandles = candlesBySymbol([{
    leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
    series: ar1Sequence(mulberry32(11), 288, 0.7),
  }]);
  const series240 = ar1Sequence(mulberry32(41), 240, 0.7);

  it('promotes at exactly 2304 coverage points with a full 24h span and reads no candles', async () => {
    const fixture = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), coverageOf(2304, SPREAD_QUALITY_WINDOW_MS)]]),
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series240)],
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.rows[0]).toMatchObject({ asset: 'BTC', source: 'samples', sampleCount: 240 });
    expect(fixture.candleCalls()).toBe(0);
    expect(fixture.candleCallsFor('GATE_FUTURE_BTC_USDT')).toBe(0);
    expect(fixture.candleCallsFor('BYBIT_FUTURE_BTC_USDT')).toBe(0);
    // Coverage is read once per computation, over the trailing 24h window.
    expect(fixture.coverageCalls()).toBe(1);
    expect(fixture.lastCoverageFromMs()).toBe(EPOCH_MS - SPREAD_QUALITY_WINDOW_MS);
  });

  it('keeps candles one coverage point below the threshold', async () => {
    const fixture = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), coverageOf(2303, SPREAD_QUALITY_WINDOW_MS)]]),
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series240)],
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.rows[0]).toMatchObject({ asset: 'BTC', source: 'candles', sampleCount: 288 });
    expect(fixture.candleCalls()).toBe(2);
  });

  it('promotes at a span of exactly 24h but not one millisecond short', async () => {
    const exact = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), coverageOf(2880, SPREAD_QUALITY_WINDOW_MS)]]),
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series240)],
      },
    });
    expect((await exact.service.list(CATALOG, { limit: 100 })).rows[0]).toMatchObject({ source: 'samples' });

    const short = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), coverageOf(2880, SPREAD_QUALITY_WINDOW_MS - 1)]]),
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series240)],
      },
    });
    expect((await short.service.list(CATALOG, { limit: 100 })).rows[0]).toMatchObject({ source: 'candles', sampleCount: 288 });
  });

  it('promotes at exactly 240 sample points but not at 239', async () => {
    const promoted = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), coverageOf(2880, SPREAD_QUALITY_WINDOW_MS)]]),
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series240)],
      },
    });
    expect((await promoted.service.list(CATALOG, { limit: 100 })).rows[0]).toMatchObject({ source: 'samples', sampleCount: 240 });

    const thin = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), coverageOf(2880, SPREAD_QUALITY_WINDOW_MS)]]),
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', ar1Sequence(mulberry32(43), 239, 0.7))],
      },
    });
    const response = await thin.service.list(CATALOG, { limit: 100 });
    expect(response.rows[0]).toMatchObject({ source: 'candles', sampleCount: 288 });
    expect(thin.candleCalls()).toBe(2);
  });

  it('mixes both sources on one board with candle calls only on the ungraduated legs', async () => {
    const ethPair = spreadBoardRow('ETH', [{
      leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT',
      leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 9,
    }]);
    const fixture = createQualityService({
      board: [btcPair, ethPair],
      candles: candlesBySymbol([
        { leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', series: ar1Sequence(mulberry32(61), 288, 0.6) },
      ]),
      samples: {
        coverage: new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), coverageOf(2880, SPREAD_QUALITY_WINDOW_MS)]]),
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series240)],
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    const byAsset = new Map(response.rows.map((row) => [row.asset, row]));
    expect(byAsset.get('BTC')).toMatchObject({ source: 'samples', sampleCount: 240 });
    expect(byAsset.get('ETH')).toMatchObject({ source: 'candles', sampleCount: 288 });
    expect(fixture.candleCallsFor('GATE_FUTURE_BTC_USDT')).toBe(0);
    expect(fixture.candleCallsFor('BYBIT_FUTURE_BTC_USDT')).toBe(0);
    expect(fixture.candleCallsFor('GATE_FUTURE_ETH_USDT')).toBe(1);
    expect(fixture.candleCallsFor('BYBIT_FUTURE_ETH_USDT')).toBe(1);
  });

  it('falls back to candles — without losing the row — when the promoted series has no finite point', async () => {
    const fixture = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), coverageOf(2880, SPREAD_QUALITY_WINDOW_MS)]]),
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', Array.from({ length: 240 }, () => Number.NaN))],
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.rows).toHaveLength(1);
    expect(response.rows[0]).toMatchObject({ asset: 'BTC', source: 'candles', sampleCount: 288 });
    expect(fixture.candleCalls()).toBe(2);
  });

  it('keeps a degenerate constant sample series on the samples track with null moments', async () => {
    // A constant series still has a finite mean, so it is scoreable: the documented contract is
    // null moments (never fabricated zeros), exactly as on the candles track — not a candles
    // fallback. Only a series with no finite point at all falls through.
    const fixture = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), coverageOf(2880, SPREAD_QUALITY_WINDOW_MS)]]),
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', Array.from({ length: 240 }, () => 7))],
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.rows[0]).toMatchObject({
      asset: 'BTC', source: 'samples', sampleCount: 240,
      meanSpreadBps: 7, spreadVolatilityBps: 0,
      skewness: null, excessKurtosis: null, ar1Coefficient: null, halfLifeHours: null,
      symmetric: false,
    });
    expect(fixture.candleCalls()).toBe(0);
  });

  it('degrades to candles — without losing the row — when the sample series read throws', async () => {
    const fixture = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: new Map([[spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'), coverageOf(2880, SPREAD_QUALITY_WINDOW_MS)]]),
        series: () => { throw new Error('sample store locked'); },
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    // Symmetric with the coverage read: a store that throws degrades this pair to candles
    // instead of dropping a row whose candle history is still intact.
    expect(response.rows[0]).toMatchObject({ asset: 'BTC', source: 'candles', sampleCount: 288 });
    expect(response.totalCandidates).toBe(1);
    expect(fixture.candleCalls()).toBe(2);
  });

  it('degrades to candles when the coverage read throws', async () => {
    const fixture = createQualityService({
      board: [btcPair],
      candles: btcCandles,
      samples: {
        coverage: () => { throw new Error('sample store unavailable'); },
        series: [sampleSeriesFor('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', series240)],
      },
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.rows[0]).toMatchObject({ asset: 'BTC', source: 'candles', sampleCount: 288 });
  });

  it('keeps every pair on candles when no sample store is wired', async () => {
    const fixture = createQualityService({ board: [btcPair], candles: btcCandles });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.rows[0]).toMatchObject({ source: 'candles', sampleCount: 288 });
    expect(fixture.candleCalls()).toBe(2);
    expect(fixture.coverageCalls()).toBe(0);
    expect(fixture.seriesCalls()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. half-life conversion per source cadence
// ---------------------------------------------------------------------------

describe('half-life per source cadence', () => {
  it('scales the same series half-life by exactly 10x between the 5m and 30s tracks', () => {
    const series = ar1Sequence(mulberry32(101), 4000, 0.85);
    const candles = computeSpreadStatistics(series);
    const samples = computeSpreadStatistics(series, SPREAD_SAMPLE_MINUTES_PER_POINT);
    // Same values, same φ̂ — only the minutes-per-point conversion differs.
    expect(samples.ar1Coefficient).toBe(candles.ar1Coefficient);
    expect(candles.halfLifeHours! / samples.halfLifeHours!).toBeCloseTo(10, 10);
    expect(samples.halfLifeHours!).toBeCloseTo(candles.halfLifeHours! * 0.1, 10);
    // The pure converter shows the same ratio directly.
    const phi = 0.85;
    expect(halfLifeFromAr1(phi, 5)! / halfLifeFromAr1(phi, SPREAD_SAMPLE_MINUTES_PER_POINT)!).toBeCloseTo(10, 10);
    expect(halfLifeFromAr1(0.5, 5)).toBeCloseTo((Math.log(0.5) / Math.log(0.5)) * (5 / 60), 12);
  });

  it('returns null for non-reverting, trending or invalid autoregression inputs', () => {
    for (const phi of [1, 1.0000001, 1.5, 0, -0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(halfLifeFromAr1(phi, 5), `phi=${phi}`).toBeNull();
    }
    expect(halfLifeFromAr1(null, 5)).toBeNull();
    for (const minutesPerPoint of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(halfLifeFromAr1(0.9, minutesPerPoint), `minutesPerPoint=${minutesPerPoint}`).toBeNull();
    }
    // Inside (0, 1) the half-life is a positive finite number of hours.
    expect(halfLifeFromAr1(0.9, 5)!).toBeGreaterThan(0);
    expect(Number.isFinite(halfLifeFromAr1(0.9, 5)!)).toBe(true);
  });

  it('treats a perfectly trending series as non-reverting through the statistics path', () => {
    const statistics = computeSpreadStatistics(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(statistics.ar1Coefficient).toBe(1);
    expect(statistics.halfLifeHours).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. hostile data: nulls, dirty quotes, missing funding
// ---------------------------------------------------------------------------

describe('spread quality hostile data', () => {
  const DIRTY_CLOSES = ['0', '', 'NaN', '-1', 'Infinity', 'abc', 'null'];

  it('drops candles without a usable close and keeps the shared points only', () => {
    const left = candleSeries([100, 101, 102, 103, 104]);
    const right = candleSeries([50, 50.5, 51]);
    const broken = [...left];
    broken[1] = { ...broken[1]!, close: '0' };
    broken[3] = { ...broken[3]!, close: 'NaN' };
    // Points 1 and 3 lose their left close; point 4 has no right partner.
    expect(alignSpreadSeries(broken, right)).toEqual([
      ((100 - 50) / 50) * 10_000,
      ((102 - 51) / 51) * 10_000,
    ]);
    for (const close of DIRTY_CLOSES) {
      const dirty = [...left];
      dirty[2] = { ...dirty[2]!, close };
      expect(alignSpreadSeries(dirty, right), `close=${JSON.stringify(close)}`).toHaveLength(2);
    }
  });

  it('serves a schema-clean board from dirty candles, missing funding and an empty hub', async () => {
    const clean = ar1Sequence(mulberry32(83), 288, 0.6);
    const partial = ar1Sequence(mulberry32(89), 288, 0.6);
    const board = [
      // P1: every close is dirty on both legs.
      spreadBoardRow('P1', [{ leftSymbol: 'GATE_FUTURE_P1_USDT', rightSymbol: 'BYBIT_FUTURE_P1_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 30 }]),
      // P2: the left leg's first 50 points are dirty, the rest are clean.
      spreadBoardRow('P2', [{ leftSymbol: 'GATE_FUTURE_P2_USDT', rightSymbol: 'BYBIT_FUTURE_P2_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 20 }]),
      // P3: fully clean.
      spreadBoardRow('P3', [{ leftSymbol: 'GATE_FUTURE_P3_USDT', rightSymbol: 'BYBIT_FUTURE_P3_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 10 }]),
    ];
    const dirtyPage = (count: number): Candle[] => Array.from({ length: count }, (_, index) => ({
      startTime: EPOCH_MS + index * STEP_MS,
      open: '100', high: '100', low: '100', close: DIRTY_CLOSES[index % DIRTY_CLOSES.length]!,
      volume: '1', closed: true,
    }));
    const partialLegs = legsForSpreadSeries(partial);
    const dirtyLeft = [...partialLegs.left];
    for (let index = 0; index < 50; index += 1) {
      dirtyLeft[index] = { ...dirtyLeft[index]!, close: DIRTY_CLOSES[index % DIRTY_CLOSES.length]! };
    }
    const fixture = createQualityService({
      board,
      candles: (symbol) => {
        if (symbol === 'GATE_FUTURE_P1_USDT' || symbol === 'BYBIT_FUTURE_P1_USDT') return dirtyPage(300);
        if (symbol === 'GATE_FUTURE_P2_USDT') return dirtyLeft;
        if (symbol === 'BYBIT_FUTURE_P2_USDT') return partialLegs.right;
        return legsForSpreadSeries(clean).left;
      },
      // No funding rows at all and no hub markets: every holding cost is null, every depth zero.
      funding: [],
      markets: [],
    });
    const response = await fixture.service.list(CATALOG, { limit: 100 });
    expect(response.totalCandidates).toBe(3);
    // P1 has no aligned series at all: it never reaches the board, and nothing throws.
    expect(response.rows.map((row) => row.asset).sort()).toEqual(['P2', 'P3']);
    const parsed = SpreadQualityResponseSchema.parse(response);
    assertNoNonFinite(parsed);
    for (const row of parsed.rows) {
      expect(row.holdingCostBps).toBeNull();
      expect(row.bookDepthUsdt).toBe(0);
      expect(row.meanSpreadBps).not.toBeNull();
      expect(row.source).toBe('candles');
    }
    // P2's series is the 238 clean shared points (the 50 dirty ones are absent, never zero).
    const p2 = parsed.rows.find((row) => row.asset === 'P2')!;
    expect(p2.sampleCount).toBe(238);
    const expected = computeSpreadStatistics(partial.slice(50));
    expect(p2.meanSpreadBps!).toBeCloseTo(expected.mean!, 8);
    expect(p2.spreadVolatilityBps!).toBeCloseTo(expected.volatility!, 8);
  });

  it('keeps a row whose mean is null off the board', () => {
    const rows = scoreSpreadQualityInputs([
      scoreInput({ asset: 'A', leftSymbol: 'GATE_FUTURE_A_USDT', rightSymbol: 'BYBIT_FUTURE_A_USDT', meanSpreadBps: null }),
      scoreInput({ asset: 'B', leftSymbol: 'GATE_FUTURE_B_USDT', rightSymbol: 'BYBIT_FUTURE_B_USDT', meanSpreadBps: 4 }),
    ]);
    expect(rows.map((row) => row.asset)).toEqual(['B']);
  });
});

// ---------------------------------------------------------------------------
// 5. cache semantics
// ---------------------------------------------------------------------------

describe('spread quality cache semantics', () => {
  const btcPair = spreadBoardRow('BTC', [{
    leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
    leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 12,
  }]);
  const btcCandles = candlesBySymbol([{
    leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
    series: ar1Sequence(mulberry32(11), 288, 0.7),
  }]);

  it('never caches a failed computation', async () => {
    let boardCalls = 0;
    const fixture = createQualityService({
      board: async () => {
        boardCalls += 1;
        if (boardCalls === 1) throw new Error('board exploded');
        return [btcPair];
      },
      candles: btcCandles,
    });
    await expect(fixture.service.list(CATALOG, { limit: 100 })).rejects.toThrow('board exploded');
    expect(fixture.service.cacheSize()).toBe(0);
    // The next request must be able to succeed: the failure left nothing behind.
    const recovered = await fixture.service.list(CATALOG, { limit: 100 });
    expect(recovered.rows).toHaveLength(1);
    expect(boardCalls).toBe(2);
    expect(fixture.service.cacheSize()).toBe(1);
  });

  it('shares one in-flight failing computation and caches nothing from it', async () => {
    let boardCalls = 0;
    const fixture = createQualityService({
      board: async () => {
        boardCalls += 1;
        if (boardCalls === 1) throw new Error('board exploded');
        return [btcPair];
      },
      candles: btcCandles,
    });
    const first = fixture.service.list(CATALOG, { limit: 100 });
    const second = fixture.service.list(CATALOG, { limit: 100 });
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    // Single-flight: the concurrent request joined the one failing computation.
    expect(boardCalls).toBe(1);
    expect(fixture.service.cacheSize()).toBe(0);
    const recovered = await fixture.service.list(CATALOG, { limit: 100 });
    expect(recovered.rows).toHaveLength(1);
    expect(boardCalls).toBe(2);
  });

  it('alternating pair types never evict each other', async () => {
    const fixture = createQualityService({ board: [btcPair], candles: btcCandles });
    for (let round = 0; round < 10; round += 1) {
      await fixture.service.list(CATALOG, { limit: 100 });
      await fixture.service.list(CATALOG, { pairType: 'SPOT_PERP', limit: 100 });
    }
    expect(fixture.boardCalls()).toBe(2);
    expect(fixture.service.cacheSize()).toBe(2);
  });

  it('evicts the least recently touched entry at capacity', async () => {
    const fixture = createQualityService({ board: [btcPair], candles: btcCandles, cacheMaxEntries: 2 });
    await fixture.service.list(CATALOG, { limit: 100 });                       // ALL
    await fixture.service.list(CATALOG, { pairType: 'SPOT_PERP', limit: 100 }); // SPOT_PERP
    await fixture.service.list(CATALOG, { limit: 100 });                       // ALL again (touch)
    await fixture.service.list(CATALOG, { pairType: 'PERP_PERP', limit: 100 }); // evicts SPOT_PERP
    expect(fixture.service.cacheSize()).toBe(2);
    const before = fixture.boardCalls();
    await fixture.service.list(CATALOG, { limit: 100 });                        // ALL still cached
    expect(fixture.boardCalls()).toBe(before);
    await fixture.service.list(CATALOG, { pairType: 'SPOT_PERP', limit: 100 }); // recomputes
    expect(fixture.boardCalls()).toBe(before + 1);
  });

  it('recomputes at exactly the TTL boundary and reuses one millisecond before it', async () => {
    const fixture = createQualityService({ board: [btcPair], candles: btcCandles, cacheTtlMs: 60_000 });
    await fixture.service.list(CATALOG, { limit: 100 });
    expect(fixture.boardCalls()).toBe(1);
    fixture.advance(59_999);
    await fixture.service.list(CATALOG, { limit: 100 });
    expect(fixture.boardCalls()).toBe(1);
    fixture.advance(1);
    await fixture.service.list(CATALOG, { limit: 100 });
    expect(fixture.boardCalls()).toBe(2);
  });

  it('excludes limit from the cache key and slices the same ranked rows', async () => {
    const board = [
      spreadBoardRow('BTC', [{ leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 12 }]),
      spreadBoardRow('ETH', [{ leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', leftVenue: 'GATE', rightVenue: 'BYBIT', spreadBps: 9 }]),
    ];
    const fixture = createQualityService({
      board,
      candles: candlesBySymbol([
        { leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', series: ar1Sequence(mulberry32(11), 288, 0.7) },
        { leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', series: ar1Sequence(mulberry32(13), 288, 0.6) },
      ]),
    });
    const full = await fixture.service.list(CATALOG, { limit: 100 });
    const page = await fixture.service.list(CATALOG, { limit: 1 });
    expect(fixture.boardCalls()).toBe(1);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toEqual(full.rows[0]);
    expect(page.totalCandidates).toBe(full.totalCandidates);
    // A forced invalidation (what refresh=1 triggers) recomputes.
    fixture.service.invalidateCache();
    await fixture.service.list(CATALOG, { limit: 100 });
    expect(fixture.boardCalls()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. route-level adversarial checks (real Fastify app, real database)
// ---------------------------------------------------------------------------

describe('spread quality route', () => {
  async function seededRouteApp(candles: (symbol: string) => readonly Candle[]): Promise<RouteFixture> {
    const fixture = await createRouteApp([
      catalogSymbol('GATE_FUTURE_AAVE_USDT', 'GATE'),
      catalogSymbol('BINANCE_FUTURE_AAVE_USDT', 'BINANCE'),
      catalogSymbol('OKX_FUTURE_AAVE_USDT', 'OKX'),
      catalogSymbol('BYBIT_FUTURE_AAVE_USDT', 'BYBIT'),
      catalogSymbol('KRAKEN_FUTURE_AAVE_USD', 'KRAKEN'),
    ]);
    fixture.publicMarketGateway.candles = candles;
    return fixture;
  }

  /** The documented ranking contract, applied to a parsed route response. */
  function expectedRankedOrder(rows: ReadonlyArray<{
    score: number; currentSpreadBps: number; asset: string; leftSymbol: string; rightSymbol: string;
  }>): unknown[] {
    return [...rows].sort((left, right) => right.score - left.score
      || right.currentSpreadBps - left.currentSpreadBps
      || left.asset.localeCompare(right.asset)
      || left.leftSymbol.localeCompare(right.leftSymbol)
      || left.rightSymbol.localeCompare(right.rightSymbol));
  }

  it('validates the query and pins the refresh/cache wiring', async () => {
    const fixture = await seededRouteApp(() => flatCandles(5));

    const first = await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality', headers: ROUTE_HEADERS });
    expect(first.statusCode).toBe(200);
    const body = SpreadQualityResponseSchema.parse(first.json());
    expect(body.windowHours).toBe(24);
    // The seeded hub board fills the candidate cap; every row is candle-reconstructed.
    expect(body.totalCandidates).toBe(50);
    expect(body.rows).toHaveLength(50);
    for (const row of body.rows) {
      expect(row.source).toBe('candles');
      expect(row.sampleCount).toBe(288);
      expect(row.bookDepthUsdt).toBe(0);
      // No funding stats are wired: the cost is null, never a fabricated zero.
      expect(row.holdingCostBps).toBeNull();
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
    }
    assertNoNonFinite(body);
    // The whole response order must equal the documented comparator — the frontend re-sorts nothing.
    expect(body.rows).toEqual(expectedRankedOrder(body.rows));
    for (let index = 1; index < body.rows.length; index += 1) {
      expect(body.rows[index - 1]!.score).toBeGreaterThanOrEqual(body.rows[index]!.score);
    }

    // No refresh: the 5-minute board cache is reused — no upstream candle re-reads.
    const candlesAfterFirst = fixture.publicMarketGateway.candleQueryCount;
    expect(candlesAfterFirst).toBeGreaterThan(0);
    const cached = await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality', headers: ROUTE_HEADERS });
    expect(cached.statusCode).toBe(200);
    expect(fixture.publicMarketGateway.candleQueryCount).toBe(candlesAfterFirst);

    // limit is not part of the cache key: a different page size reuses the same computation.
    const limited = await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality?limit=1', headers: ROUTE_HEADERS });
    expect(limited.statusCode).toBe(200);
    const limitedBody = SpreadQualityResponseSchema.parse(limited.json());
    expect(limitedBody.rows).toHaveLength(1);
    expect(limitedBody.rows[0]).toEqual(body.rows[0]);
    expect(fixture.publicMarketGateway.candleQueryCount).toBe(candlesAfterFirst);

    // refresh=1 drops the cache: the manual Refresh button must never silently replay a board.
    const refreshed = await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality?refresh=1', headers: ROUTE_HEADERS });
    expect(refreshed.statusCode).toBe(200);
    expect(fixture.publicMarketGateway.candleQueryCount).toBeGreaterThan(candlesAfterFirst);
    const afterRefresh = fixture.publicMarketGateway.candleQueryCount;
    const recached = await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality', headers: ROUTE_HEADERS });
    expect(recached.statusCode).toBe(200);
    expect(fixture.publicMarketGateway.candleQueryCount).toBe(afterRefresh);

    // Query validation, mirroring the opportunities route: only the literal '1' is a refresh.
    expect((await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality?refresh=0', headers: ROUTE_HEADERS })).statusCode).toBe(400);
    expect((await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality?refresh=true', headers: ROUTE_HEADERS })).statusCode).toBe(400);
    expect((await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality?pairType=SWAP', headers: ROUTE_HEADERS })).statusCode).toBe(400);
    expect((await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality?limit=0', headers: ROUTE_HEADERS })).statusCode).toBe(400);
    expect((await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality?limit=101', headers: ROUTE_HEADERS })).statusCode).toBe(400);
    const spotOnly = await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality?pairType=SPOT_PERP', headers: ROUTE_HEADERS });
    expect(spotOnly.statusCode).toBe(200);
    expect(SpreadQualityResponseSchema.parse(spotOnly.json())).toMatchObject({ rows: [], totalCandidates: 0 });
  });

  it('promotes a pair from the real sample store and re-ranks it above the first candidate', async () => {
    // One pair (KRAKEN sells, BYBIT buys — the seeded books' orientation) earns 24h of samples;
    // every other pair keeps its flat candle history.
    const left = 'KRAKEN_FUTURE_AAVE_USD';
    const right = 'BYBIT_FUTURE_AAVE_USDT';
    const values = ar1Sequence(mulberry32(97), 2883, 0.85).map((value) => value + 5);
    // The board reads the trailing 24h at request time, so the grid ends slightly in the
    // future: even after the window shaves the oldest points, the span stays a full 24h.
    const newestMs = Date.now() + 120_000;
    const fixture = await seededRouteApp(() => flatCandles(5));
    recordSpreadSamples(fixture.database, values.map((spreadBps, index) => ({
      pairType: 'PERP_PERP' as const,
      asset: 'AAVE',
      leftSymbol: left,
      rightSymbol: right,
      sampledAt: newestMs - (values.length - 1 - index) * SPREAD_SAMPLE_INTERVAL_MS,
      spreadBps,
      depthUsdt: 777,
      leftPrice: 100,
      rightPrice: 100,
    })));

    const response = await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality', headers: ROUTE_HEADERS });
    expect(response.statusCode).toBe(200);
    const body = SpreadQualityResponseSchema.parse(response.json());
    assertNoNonFinite(body);
    expect(body.rows).toHaveLength(50);
    // The promoted pair tops the board even though it is nowhere near the first candidate.
    const promoted = body.rows.find((row) => row.leftSymbol === left && row.rightSymbol === right)!;
    expect(body.rows[0]).toBe(promoted);
    expect(promoted.source).toBe('samples');
    // The window shaves at most the oldest points; a full 24h of them always remains.
    expect(promoted.sampleCount).toBeGreaterThanOrEqual(2881);
    expect(promoted.bookDepthUsdt).toBe(777);
    expect(promoted.score).toBeGreaterThan(body.rows[1]!.score);
    // Its statistics are the in-window sample series at the 30s cadence (0.5 minutes per point).
    const included = values.slice(values.length - promoted.sampleCount);
    const statistics = computeSpreadStatistics(included, SPREAD_SAMPLE_MINUTES_PER_POINT);
    expect(promoted.meanSpreadBps!).toBeCloseTo(statistics.mean!, 8);
    expect(promoted.spreadVolatilityBps!).toBeCloseTo(statistics.volatility!, 8);
    expect(promoted.halfLifeHours!).toBeCloseTo(statistics.halfLifeHours!, 8);
    // Every other row stays on candles, and the candidate-order-first row is not the top row.
    expect(body.rows.filter((row) => row.source === 'candles')).toHaveLength(49);
    const firstCandidate = [...body.rows].sort((l, r) => l.asset.localeCompare(r.asset)
      || l.leftSymbol.localeCompare(r.leftSymbol)
      || l.rightSymbol.localeCompare(r.rightSymbol))[0]!;
    expect(firstCandidate.source).toBe('candles');
    expect(firstCandidate.score).toBeLessThan(promoted.score);
    expect(firstCandidate).not.toBe(promoted);

    // A forced refresh recomputes but does not demote the promoted pair.
    const refreshed = await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality?refresh=1', headers: ROUTE_HEADERS });
    const refreshedBody = SpreadQualityResponseSchema.parse(refreshed.json());
    expect(refreshedBody.rows[0]).toMatchObject({ source: 'samples', leftSymbol: left, rightSymbol: right });
  });

  it('survives dirty venue candles without emitting non-finite fields', async () => {
    const dirtyCloses = ['0', '', 'NaN', '-1', 'Infinity', 'abc'];
    const dirtyCandles = (): Candle[] => Array.from({ length: 300 }, (_, index) => ({
      startTime: 1_783_688_880_000 + index * 300_000,
      open: '100', high: '100', low: '100', close: dirtyCloses[index % dirtyCloses.length]!,
      volume: '1', closed: true,
    }));
    const fixture = await seededRouteApp(() => dirtyCandles());

    const first = await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality', headers: ROUTE_HEADERS });
    expect(first.statusCode).toBe(200);
    const body = SpreadQualityResponseSchema.parse(first.json());
    assertNoNonFinite(body);
    // Every leg's history is unusable: no series survives, no row is published, no error either.
    expect(body.rows).toEqual([]);
    expect(body.totalCandidates).toBe(50);

    // Partial rot: one symbol's page is dirty, so only the pairs on that leg drop out.
    fixture.publicMarketGateway.candles = (symbol) => (symbol === 'GATE_FUTURE_AAVE_USDT' ? dirtyCandles() : flatCandles(5));
    const second = await fixture.app.inject({ method: 'GET', url: '/api/opportunities/spread-quality?refresh=1', headers: ROUTE_HEADERS });
    expect(second.statusCode).toBe(200);
    const partialBody = SpreadQualityResponseSchema.parse(second.json());
    assertNoNonFinite(partialBody);
    expect(partialBody.rows.length).toBeGreaterThan(0);
    expect(partialBody.rows.length).toBeLessThan(50);
    for (const row of partialBody.rows) {
      expect(row.source).toBe('candles');
      expect(row.sampleCount).toBe(288);
      expect(row.holdingCostBps).toBeNull();
      // No surviving row carries the rotted GATE leg on either side.
      expect(row.leftSymbol).not.toBe('GATE_FUTURE_AAVE_USDT');
      expect(row.rightSymbol).not.toBe('GATE_FUTURE_AAVE_USDT');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. sampler resilience
// ---------------------------------------------------------------------------

describe('spread sampler resilience', () => {
  const btcMarkets = [
    liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101', askPrice: '100' }),
    liveMarket({ symbol: 'BYBIT_FUTURE_BTC_USDT', venue: 'BYBIT', asset: 'BTC', bidPrice: '99', askPrice: '100' }),
  ];

  it('swallows a mid-tick hub failure, reports it, and recovers on the next boundary', async () => {
    vi.useFakeTimers();
    let nowMs = EPOCH_MS;
    let boardCalls = 0;
    let hubCalls = 0;
    const markets = new Map(btcMarkets.map((market) => [market.symbol, market]));
    const { sampler, rows, warnings } = createSampler({
      board: async () => {
        boardCalls += 1;
        return [btcBoardRow()];
      },
      market: (symbol) => {
        hubCalls += 1;
        // The first tick's very first hub read tears (candidate selection); the throw escapes
        // sampleOnce, is swallowed by the background loop, and the next boundary recovers.
        if (hubCalls === 1) throw new Error('hub snapshot torn');
        return markets.get(symbol) ?? null;
      },
      now: () => nowMs,
    });
    sampler.startBackground();
    nowMs = EPOCH_MS + 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('hub snapshot torn');
    expect(rows()).toHaveLength(0);

    nowMs = EPOCH_MS + 60_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(boardCalls).toBe(2);
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS + 60_000]);
    await sampler.stopBackground();
  });

  it('never prunes the bucket it just wrote, even at the minimum retention', async () => {
    const { sampler, rows } = createSampler({
      board: async () => [btcBoardRow()],
      market: (symbol) => btcMarkets.find((market) => market.symbol === symbol) ?? null,
      intervalMs: 30_000,
      retentionMs: 30_000,
      pruneIntervalMs: 0,
    });
    expect(await sampler.sampleOnce(EPOCH_MS)).toBe(1);
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS]);
    // Cutoff is exactly the previous bucket; the delete is strict `<`, so it survives.
    expect(await sampler.sampleOnce(EPOCH_MS + 30_000)).toBe(1);
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS, EPOCH_MS + 30_000]);
    // One boundary later the oldest point ages out; the just-written bucket never does.
    expect(await sampler.sampleOnce(EPOCH_MS + 60_000)).toBe(1);
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS + 30_000, EPOCH_MS + 60_000]);
  });

  it('rewrites a retried bucket idempotently, updating every column', async () => {
    const quotes = new Map(btcMarkets.map((market) => [market.symbol, market]));
    const { sampler, rows } = createSampler({
      board: async () => [btcBoardRow()],
      market: (symbol) => quotes.get(symbol) ?? null,
    });
    expect(await sampler.sampleOnce(EPOCH_MS)).toBe(1);
    const first = rows()[0]!;
    quotes.set('GATE_FUTURE_BTC_USDT', liveMarket({
      symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC',
      bidPrice: '103', bidSize: '9', askPrice: '100', askSize: '9',
    }));
    quotes.set('BYBIT_FUTURE_BTC_USDT', liveMarket({
      symbol: 'BYBIT_FUTURE_BTC_USDT', venue: 'BYBIT', asset: 'BTC',
      bidPrice: '99', bidSize: '4', askPrice: '100', askSize: '4',
    }));
    // Ten seconds late: same 30s bucket, newer quotes.
    expect(await sampler.sampleOnce(EPOCH_MS + 10_000)).toBe(1);
    const rewritten = rows();
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]).not.toEqual(first);
    expect(rewritten[0]).toMatchObject({
      sampledAt: EPOCH_MS,
      // (103 − 100) / 100 × 10⁴; depth is the weaker leg's min(bid, ask) notional.
      spreadBps: 300,
      depthUsdt: 396,
      leftPrice: 103,
      rightPrice: 100,
    });
  });

  it('finishes an in-flight tick on stop and schedules nothing afterwards', async () => {
    vi.useFakeTimers();
    let nowMs = EPOCH_MS;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolvePromise) => { releaseGate = resolvePromise; });
    let boardCalls = 0;
    const { sampler, rows } = createSampler({
      board: async () => {
        boardCalls += 1;
        await gate;
        return [btcBoardRow()];
      },
      market: (symbol) => btcMarkets.find((market) => market.symbol === symbol) ?? null,
      now: () => nowMs,
    });
    sampler.startBackground();
    nowMs = EPOCH_MS + 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    const stopped = sampler.stopBackground();
    releaseGate();
    await stopped;
    // The in-flight tick completed its write; the loop is dead from here on.
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS + 30_000]);
    nowMs = EPOCH_MS + 10 * 60_000;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(boardCalls).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  it('stays stopped after stopBackground', async () => {
    vi.useFakeTimers();
    let nowMs = EPOCH_MS;
    let boardCalls = 0;
    const { sampler, rows } = createSampler({
      board: async () => {
        boardCalls += 1;
        return [btcBoardRow()];
      },
      market: (symbol) => btcMarkets.find((market) => market.symbol === symbol) ?? null,
      now: () => nowMs,
    });
    sampler.startBackground();
    nowMs = EPOCH_MS + 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    await sampler.stopBackground();
    expect(boardCalls).toBe(1);
    nowMs = EPOCH_MS + 5 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(boardCalls).toBe(1);
    expect(rows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8. migration 0024 constraints
// ---------------------------------------------------------------------------

describe('spread samples migration constraints', () => {
  function sampleDatabase(): Database.Database {
    const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
    openedDatabases.push(database);
    return database;
  }

  function rawInsert(database: Database.Database, overrides: Partial<{
    pair_type: string; asset: string; left_symbol: string; right_symbol: string; sampled_at: number; spread_bps: number;
  }> = {}): void {
    database.prepare(`
      INSERT INTO spread_samples (pair_type, asset, left_symbol, right_symbol, sampled_at, spread_bps, depth_usdt, left_price, right_price)
      VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL)
    `).run(
      overrides.pair_type ?? 'PERP_PERP',
      overrides.asset ?? 'BTC',
      overrides.left_symbol ?? 'GATE_FUTURE_BTC_USDT',
      overrides.right_symbol ?? 'BYBIT_FUTURE_BTC_USDT',
      overrides.sampled_at ?? EPOCH_MS,
      overrides.spread_bps ?? 12,
    );
  }

  it('rejects a raw duplicate of the (left, right, bucket) primary key', () => {
    const database = sampleDatabase();
    rawInsert(database);
    expect(() => rawInsert(database)).toThrow(/UNIQUE constraint failed/i);
    // The repository path upserts instead of failing: same key, one row, newer values.
    expect(recordSpreadSamples(database, [{
      pairType: 'PERP_PERP', asset: 'BTC',
      leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
      sampledAt: EPOCH_MS, spreadBps: 44, depthUsdt: 9, leftPrice: 101, rightPrice: 100,
    }])).toBe(1);
    const rows = readSpreadSeries(database, 'GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ spreadBps: 44, depthUsdt: 9, leftPrice: 101, rightPrice: 100 });
  });

  it('rejects an illegal pair_type through the CHECK constraint', () => {
    const database = sampleDatabase();
    expect(() => rawInsert(database, { pair_type: 'SWAP' })).toThrow(/CHECK constraint failed/i);
    expect(() => rawInsert(database, { pair_type: 'spot_perp' })).toThrow(/CHECK constraint failed/i);
    // The two legal shapes are accepted.
    rawInsert(database, { pair_type: 'SPOT_PERP', sampled_at: EPOCH_MS + 1 });
    rawInsert(database, { pair_type: 'PERP_PERP', sampled_at: EPOCH_MS + 2 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM spread_samples').get()).toEqual({ count: 2 });
  });

  it('treats (symbols, bucket) as the whole key — asset and pair_type are overwritten', () => {
    const database = sampleDatabase();
    recordSpreadSamples(database, [{
      pairType: 'PERP_PERP', asset: 'BTC',
      leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
      sampledAt: EPOCH_MS, spreadBps: 1, depthUsdt: 0, leftPrice: null, rightPrice: null,
    }]);
    recordSpreadSamples(database, [{
      pairType: 'SPOT_PERP', asset: 'ETH',
      leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT',
      sampledAt: EPOCH_MS, spreadBps: 2, depthUsdt: 0, leftPrice: null, rightPrice: null,
    }]);
    const rows = readSpreadSeries(database, 'GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pairType: 'SPOT_PERP', asset: 'ETH', spreadBps: 2 });
  });

  it('installs the pair recency index', () => {
    const database = sampleDatabase();
    const indexes = database.prepare(`
      SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'spread_samples'
    `).all() as Array<{ name: string; tbl_name: string }>;
    expect(indexes.map((index) => index.name)).toContain('spread_samples_pair_recency');
  });

  it('prunes strictly older rows and keeps the boundary bucket', () => {
    const database = sampleDatabase();
    for (const offset of [-1, 0, 1]) {
      rawInsert(database, { sampled_at: EPOCH_MS + offset * SPREAD_SAMPLE_INTERVAL_MS });
    }
    expect(pruneSpreadSamples(database, EPOCH_MS)).toBe(1);
    const remaining = readSpreadSeries(database, 'GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', 0);
    expect(remaining.map((row) => row.sampledAt)).toEqual([EPOCH_MS, EPOCH_MS + SPREAD_SAMPLE_INTERVAL_MS]);
  });

  it('reads one pair oldest-first and reports coverage per requested pair', () => {
    const database = sampleDatabase();
    recordSpreadSamples(database, [
      { pairType: 'PERP_PERP', asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', sampledAt: EPOCH_MS + 60_000, spreadBps: 2, depthUsdt: 0, leftPrice: null, rightPrice: null },
      { pairType: 'PERP_PERP', asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', sampledAt: EPOCH_MS, spreadBps: 1, depthUsdt: 0, leftPrice: null, rightPrice: null },
      { pairType: 'PERP_PERP', asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', sampledAt: EPOCH_MS + 30_000, spreadBps: 3, depthUsdt: 0, leftPrice: null, rightPrice: null },
      { pairType: 'PERP_PERP', asset: 'ETH', leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT', sampledAt: EPOCH_MS + 90_000, spreadBps: 9, depthUsdt: 0, leftPrice: null, rightPrice: null },
    ]);
    const series = readSpreadSeries(database, 'GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', 0);
    expect(series.map((row) => row.sampledAt)).toEqual([EPOCH_MS, EPOCH_MS + 30_000, EPOCH_MS + 60_000]);
    // fromMs is inclusive.
    expect(readSpreadSeries(database, 'GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT', EPOCH_MS + 30_000)).toHaveLength(2);
    // An unknown pair is the empty state, never an error.
    expect(readSpreadSeries(database, 'GATE_FUTURE_XRP_USDT', 'BYBIT_FUTURE_XRP_USDT', 0)).toEqual([]);

    const coverage = spreadSampleCoverage(database, [
      { leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT' },
      { leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BYBIT_FUTURE_ETH_USDT' },
      { leftSymbol: 'GATE_FUTURE_XRP_USDT', rightSymbol: 'BYBIT_FUTURE_XRP_USDT' },
    ], 0);
    expect(coverage.get(spreadSamplePairKey('GATE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'))).toEqual({
      count: 3, oldestMs: EPOCH_MS, newestMs: EPOCH_MS + 60_000,
    });
    expect(coverage.get(spreadSamplePairKey('GATE_FUTURE_ETH_USDT', 'BYBIT_FUTURE_ETH_USDT'))).toEqual({
      count: 1, oldestMs: EPOCH_MS + 90_000, newestMs: EPOCH_MS + 90_000,
    });
    expect(coverage.has(spreadSamplePairKey('GATE_FUTURE_XRP_USDT', 'BYBIT_FUTURE_XRP_USDT'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. exported constants the frontend and docs quote
// ---------------------------------------------------------------------------

describe('spread quality exported constants', () => {
  it('match the documented dual-track thresholds', () => {
    expect(MAX_SPREAD_QUALITY_CANDIDATES).toBe(50);
    expect(SPREAD_SAMPLE_MIN_COVERAGE_POINTS).toBe(2304);
    expect(SPREAD_SAMPLE_MIN_POINTS).toBe(240);
    expect(SPREAD_SAMPLE_WINDOW_POINTS).toBe(2880);
    expect(SPREAD_SAMPLE_INTERVAL_MS).toBe(30_000);
    expect(SPREAD_SAMPLE_MINUTES_PER_POINT).toBe(0.5);
    expect(SPREAD_QUALITY_WINDOW_HOURS).toBe(24);
    expect(SPREAD_QUALITY_WINDOW_MS).toBe(86_400_000);
    expect(SPREAD_QUALITY_INTERVAL).toBe('5m');
  });
});
