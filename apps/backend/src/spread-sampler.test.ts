import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Candle, FundingOverviewResponse, SpreadOpportunity } from '@gate-crossex/shared-types';
import type Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import type { LiveMarket } from './market-hub.js';
import {
  readSpreadSeries,
  recordSpreadSamples,
  spreadSampleCoverage,
  type SpreadSampleRow,
} from './repositories.js';
import { SpreadSampler } from './spread-sampler.js';
import {
  SPREAD_QUALITY_WINDOW_MS,
  SPREAD_SAMPLE_INTERVAL_MS,
  SPREAD_SAMPLE_MINUTES_PER_POINT,
  SpreadQualityService,
  computeSpreadStatistics,
} from './spread-quality.js';

const EPOCH = '2026-08-01T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH);
const BTC_LEFT = 'GATE_FUTURE_BTC_USDT';
const BTC_RIGHT = 'BYBIT_FUTURE_BTC_USDT';
const ETH_LEFT = 'GATE_FUTURE_ETH_USDT';
const ETH_RIGHT = 'BYBIT_FUTURE_ETH_USDT';

/** In-memory databases opened by the fixtures, closed after every test. */
const openedDatabases: Database.Database[] = [];

afterEach(() => {
  while (openedDatabases.length > 0) openedDatabases.pop()!.close();
  vi.useRealTimers();
});

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

function liveMarket(overrides: Partial<LiveMarket> & Pick<LiveMarket, 'symbol' | 'venue' | 'asset'>): LiveMarket {
  return {
    lastPrice: '100', bidPrice: '99', bidSize: '1', askPrice: '101', askSize: '1',
    open24h: '100', high24h: '110', low24h: '90', volume24h: '10', quoteVolume24h: '1000',
    fundingRate: '0', nextFundingAt: EPOCH, openInterest: '0', openInterestValue: '0',
    receivedAt: EPOCH, updatedAt: EPOCH, source: 'demo_seed',
    ...overrides,
  };
}

function boardRow(asset: string, leftSymbol: string, rightSymbol: string, spreadBps: number): SpreadOpportunity {
  const leftVenue = leftSymbol.split('_')[0]!;
  const rightVenue = rightSymbol.split('_')[0]!;
  return {
    pairType: 'PERP_PERP', asset, leftSymbol, rightSymbol, leftVenue, rightVenue,
    sellBid: '100', buyAsk: '100', spreadBps, updatedAt: EPOCH, executable: true,
    assetClass: 'TOKEN', assetSuperClass: 'CRYPTO', variantSuffix: null, isPreIpo: false,
    leftStats: null, rightStats: null,
    combinations: [{
      pairType: 'PERP_PERP', leftSymbol, rightSymbol, leftVenue, rightVenue,
      sellBid: '100', buyAsk: '100', spreadBps, updatedAt: EPOCH, executable: true,
    }],
  };
}

interface SamplerFixture {
  sampler: SpreadSampler;
  database: Database.Database;
  rows: (leftSymbol?: string, rightSymbol?: string) => SpreadSampleRow[];
  warnings: string[];
  setMarkets: (markets: LiveMarket[]) => void;
}

function createSampler(options: {
  board: () => Promise<readonly SpreadOpportunity[]>;
  markets?: LiveMarket[];
  intervalMs?: number;
  retentionMs?: number;
  pruneIntervalMs?: number;
  candidateLimit?: number;
  now?: () => number;
}): SamplerFixture {
  const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
  openedDatabases.push(database);
  const markets = new Map((options.markets ?? []).map((market) => [market.symbol, market]));
  const warnings: string[] = [];
  const sampler = new SpreadSampler({
    database,
    hub: { market: (symbol) => markets.get(symbol) ?? null },
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
    rows: (leftSymbol = BTC_LEFT, rightSymbol = BTC_RIGHT) => readSpreadSeries(database, leftSymbol, rightSymbol, 0),
    warnings,
    setMarkets: (next) => {
      markets.clear();
      for (const market of next) markets.set(market.symbol, market);
    },
  };
}

/** A one-row board whose only candidate is the BTC pair. */
function btcBoard(): () => Promise<readonly SpreadOpportunity[]> {
  return async () => [boardRow('BTC', BTC_LEFT, BTC_RIGHT, 12)];
}

describe('spread sampler sampling', () => {
  it('writes the current spread, absorbable depth and both leg prices per tick', async () => {
    const { sampler, rows } = createSampler({
      board: btcBoard(),
      markets: [
        // GATE leg: min(2×101, 3×102) = 202; BYBIT leg: min(1×99, 5×100) = 99 → pair 99.
        liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC', bidPrice: '101', bidSize: '2', askPrice: '102', askSize: '3' }),
        liveMarket({ symbol: BTC_RIGHT, venue: 'BYBIT', asset: 'BTC', bidPrice: '99', bidSize: '1', askPrice: '100', askSize: '5' }),
      ],
    });
    const written = await sampler.sampleOnce(EPOCH_MS);
    expect(written).toBe(1);
    expect(rows()).toEqual([{
      pairType: 'PERP_PERP',
      asset: 'BTC',
      leftSymbol: BTC_LEFT,
      rightSymbol: BTC_RIGHT,
      sampledAt: EPOCH_MS,
      // (101 − 100) / 100 × 10⁴ in the board's sell-bid minus buy-ask orientation.
      spreadBps: 100,
      depthUsdt: 99,
      leftPrice: 101,
      rightPrice: 100,
    }]);
  });

  it('aligns every tick to its 30s bucket and upserts a retried bucket idempotently', async () => {
    const { sampler, rows, setMarkets } = createSampler({
      board: btcBoard(),
      markets: [
        liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC', bidPrice: '101', askPrice: '100' }),
        liveMarket({ symbol: BTC_RIGHT, venue: 'BYBIT', asset: 'BTC', bidPrice: '99', askPrice: '100' }),
      ],
    });
    expect(await sampler.sampleOnce(EPOCH_MS)).toBe(1);
    // A tick 10s late lands in the same bucket: one row, rewritten with the newer quotes.
    setMarkets([
      liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC', bidPrice: '103', askPrice: '100' }),
      liveMarket({ symbol: BTC_RIGHT, venue: 'BYBIT', asset: 'BTC', bidPrice: '99', askPrice: '100' }),
    ]);
    expect(await sampler.sampleOnce(EPOCH_MS + 10_000)).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ sampledAt: EPOCH_MS, spreadBps: 300 });
    // The next boundary is a genuinely new point.
    expect(await sampler.sampleOnce(EPOCH_MS + 30_000)).toBe(1);
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS, EPOCH_MS + 30_000]);
  });

  it('skips pairs the hub cannot quote both legs of', async () => {
    const { sampler, rows } = createSampler({
      board: btcBoard(),
      markets: [liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC' })],
    });
    // Only the sell leg is known: no spread, no row, no exception.
    expect(await sampler.sampleOnce(EPOCH_MS)).toBe(0);
    expect(rows()).toEqual([]);

    // An unusable buy-side quote is treated the same way — never a fabricated zero spread.
    const { sampler: broken, rows: brokenRows } = createSampler({
      board: btcBoard(),
      markets: [
        liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC' }),
        liveMarket({ symbol: BTC_RIGHT, venue: 'BYBIT', asset: 'BTC', askPrice: '0' }),
      ],
    });
    expect(await broken.sampleOnce(EPOCH_MS)).toBe(0);
    expect(brokenRows()).toEqual([]);
  });

  it('prunes samples past the retention window', async () => {
    const { sampler, rows } = createSampler({
      board: btcBoard(),
      markets: [
        liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC' }),
        liveMarket({ symbol: BTC_RIGHT, venue: 'BYBIT', asset: 'BTC' }),
      ],
      retentionMs: 60_000,
      pruneIntervalMs: 0,
    });
    expect(await sampler.sampleOnce(EPOCH_MS)).toBe(1);
    expect(await sampler.sampleOnce(EPOCH_MS + 90_000)).toBe(1);
    // The 60s-old point fell outside retention; only the fresh bucket survives.
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS + 90_000]);
  });

  it('prunes at most once per prune interval', async () => {
    const { sampler, rows } = createSampler({
      board: btcBoard(),
      markets: [
        liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC' }),
        liveMarket({ symbol: BTC_RIGHT, venue: 'BYBIT', asset: 'BTC' }),
      ],
      retentionMs: 15_000,
      pruneIntervalMs: 60 * 60_000,
    });
    await sampler.sampleOnce(EPOCH_MS);
    // 30s later the point is already past retention, but pruning is still gated.
    await sampler.sampleOnce(EPOCH_MS + 30_000);
    expect(rows()).toHaveLength(2);
    // Past the prune interval the next tick sweeps both stale points away.
    await sampler.sampleOnce(EPOCH_MS + 61 * 60_000);
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS + 61 * 60_000]);
  });
});

describe('spread sampler background loop', () => {
  it('fires on the 30s clock boundary and keeps sampling every boundary', async () => {
    vi.useFakeTimers();
    let nowMs = EPOCH_MS;
    const { sampler, rows } = createSampler({
      board: btcBoard(),
      markets: [
        liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC' }),
        liveMarket({ symbol: BTC_RIGHT, venue: 'BYBIT', asset: 'BTC' }),
      ],
      now: () => nowMs,
    });
    sampler.startBackground();
    // The epoch is itself a boundary, so the first tick waits a full interval.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(rows()).toHaveLength(0);
    nowMs = EPOCH_MS + 30_000;
    await vi.advanceTimersByTimeAsync(1);
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS + 30_000]);

    nowMs = EPOCH_MS + 60_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS + 30_000, EPOCH_MS + 60_000]);

    await sampler.stopBackground();
  });

  it('surfaces a failed direct tick to its caller', async () => {
    const { sampler } = createSampler({
      board: async () => { throw new Error('board unavailable'); },
      markets: [
        liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC' }),
        liveMarket({ symbol: BTC_RIGHT, venue: 'BYBIT', asset: 'BTC' }),
      ],
    });
    await expect(sampler.sampleOnce(EPOCH_MS)).rejects.toThrow('board unavailable');
  });

  it('survives a failed tick, reports it, and keeps the loop running', async () => {
    vi.useFakeTimers();
    let nowMs = EPOCH_MS;
    let boardCalls = 0;
    const { sampler, rows, warnings } = createSampler({
      board: async () => {
        boardCalls += 1;
        // The first background tick fails; every later one succeeds.
        if (boardCalls === 1) throw new Error('board unavailable');
        return [boardRow('BTC', BTC_LEFT, BTC_RIGHT, 12)];
      },
      markets: [
        liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC' }),
        liveMarket({ symbol: BTC_RIGHT, venue: 'BYBIT', asset: 'BTC' }),
      ],
      now: () => nowMs,
    });
    sampler.startBackground();
    nowMs = EPOCH_MS + 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('board unavailable');
    expect(rows()).toHaveLength(0);

    // The loop swallowed the failure and the next boundary still samples.
    nowMs = EPOCH_MS + 60_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(boardCalls).toBe(2);
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS + 60_000]);

    await sampler.stopBackground();
  });

  it('runs one tick at a time under single-flight', async () => {
    vi.useFakeTimers();
    let nowMs = EPOCH_MS;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let boardCalls = 0;
    const { sampler, rows } = createSampler({
      board: async () => {
        boardCalls += 1;
        await gate;
        return [boardRow('BTC', BTC_LEFT, BTC_RIGHT, 12)];
      },
      markets: [
        liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC' }),
        liveMarket({ symbol: BTC_RIGHT, venue: 'BYBIT', asset: 'BTC' }),
      ],
      now: () => nowMs,
    });
    sampler.startBackground();
    nowMs = EPOCH_MS + 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(boardCalls).toBe(1);
    // The next boundary fires while the first tick is still writing: it joins that run.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(boardCalls).toBe(1);

    releaseGate();
    await sampler.stopBackground();
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS + 30_000]);
    expect(boardCalls).toBe(1);
  });

  it('lets an in-flight tick finish on stop and schedules nothing afterwards', async () => {
    vi.useFakeTimers();
    let nowMs = EPOCH_MS;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let boardCalls = 0;
    const { sampler, rows } = createSampler({
      board: async () => {
        boardCalls += 1;
        await gate;
        return [boardRow('BTC', BTC_LEFT, BTC_RIGHT, 12)];
      },
      markets: [
        liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC' }),
        liveMarket({ symbol: BTC_RIGHT, venue: 'BYBIT', asset: 'BTC' }),
      ],
      now: () => nowMs,
    });
    sampler.startBackground();
    nowMs = EPOCH_MS + 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    const stopped = sampler.stopBackground();
    releaseGate();
    await stopped;
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS + 30_000]);

    // No further ticks after the stop, however far the clock advances.
    nowMs = EPOCH_MS + 10 * 60_000;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(boardCalls).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  it('treats a second start as a no-op', async () => {
    vi.useFakeTimers();
    let nowMs = EPOCH_MS;
    let boardCalls = 0;
    const { sampler, rows } = createSampler({
      board: async () => {
        boardCalls += 1;
        return [boardRow('BTC', BTC_LEFT, BTC_RIGHT, 12)];
      },
      markets: [
        liveMarket({ symbol: BTC_LEFT, venue: 'GATE', asset: 'BTC' }),
        liveMarket({ symbol: BTC_RIGHT, venue: 'BYBIT', asset: 'BTC' }),
      ],
      now: () => nowMs,
    });
    sampler.startBackground();
    sampler.startBackground();
    nowMs = EPOCH_MS + 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    nowMs = EPOCH_MS + 60_000;
    await vi.advanceTimersByTimeAsync(30_000);
    // One loop, not two: exactly one tick per boundary.
    expect(boardCalls).toBe(2);
    expect(rows().map((row) => row.sampledAt)).toEqual([EPOCH_MS + 30_000, EPOCH_MS + 60_000]);
    await sampler.stopBackground();
  });
});

describe('spread sampler feeding the samples track', () => {
  it('promotes a pair with a full 24h of samples and keeps the other on candles', async () => {
    const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
    openedDatabases.push(database);
    // 24h of 30s buckets with both endpoints inclusive: 2881 points, span exactly 24h.
    const btcSeries = ar1Sequence(mulberry32(41), 2881, 0.7);
    recordSpreadSamples(database, btcSeries.map((spreadBps, index) => ({
      pairType: 'PERP_PERP' as const,
      asset: 'BTC',
      leftSymbol: BTC_LEFT,
      rightSymbol: BTC_RIGHT,
      sampledAt: EPOCH_MS - SPREAD_QUALITY_WINDOW_MS + index * SPREAD_SAMPLE_INTERVAL_MS,
      spreadBps,
      depthUsdt: 777,
      leftPrice: 100,
      rightPrice: 100,
    })));
    // The ETH pair only sampled for a few minutes: far below every promotion threshold.
    const ethSeries = ar1Sequence(mulberry32(43), 10, 0.7);
    recordSpreadSamples(database, ethSeries.map((spreadBps, index) => ({
      pairType: 'PERP_PERP' as const,
      asset: 'ETH',
      leftSymbol: ETH_LEFT,
      rightSymbol: ETH_RIGHT,
      sampledAt: EPOCH_MS - (ethSeries.length - index) * SPREAD_SAMPLE_INTERVAL_MS,
      spreadBps,
      depthUsdt: 0,
      leftPrice: 100,
      rightPrice: 100,
    })));

    const candleSeries = ar1Sequence(mulberry32(47), 288, 0.7);
    const candlePages = new Map<string, Candle[]>([
      [BTC_LEFT, candleSeries.map((bps, index) => candle(bps, index))],
      [BTC_RIGHT, candleSeries.map((_, index) => candle(0, index))],
      [ETH_LEFT, candleSeries.map((bps, index) => candle(bps, index))],
      [ETH_RIGHT, candleSeries.map((_, index) => candle(0, index))],
    ]);
    const service = new SpreadQualityService({
      fundingOverview: {
        ensureFresh: async () => undefined,
        buildResponse: (): FundingOverviewResponse => ({
          assets: [], venueStatus: [], fetchedAt: EPOCH, cacheStatus: 'fresh',
        }),
      },
      hub: {
        market: (symbol) => (symbol === BTC_LEFT || symbol === BTC_RIGHT
          ? liveMarket({ symbol, venue: 'GATE', asset: 'BTC', bidPrice: '10', bidSize: '10', askPrice: '10', askSize: '10' })
          : null),
      },
      spreadBoard: async () => [
        boardRow('BTC', BTC_LEFT, BTC_RIGHT, 12),
        boardRow('ETH', ETH_LEFT, ETH_RIGHT, 9),
      ],
      loadCandles: async (symbol) => candlePages.get(symbol) ?? [],
      samples: {
        coverage: (pairs, fromMs) => spreadSampleCoverage(database, pairs, fromMs),
        series: (leftSymbol, rightSymbol, fromMs) => readSpreadSeries(database, leftSymbol, rightSymbol, fromMs),
      },
    }, { now: () => EPOCH_MS });

    const response = await service.list({ assets: new Map() }, { limit: 100 });
    const byAsset = new Map(response.rows.map((row) => [row.asset, row]));
    const btc = byAsset.get('BTC')!;
    const eth = byAsset.get('ETH')!;

    // Promoted: rebuilt from the 2881 local samples, at the samples cadence, with the
    // sampled depth (777) winning over the hub reading (100).
    expect(btc.source).toBe('samples');
    expect(btc.sampleCount).toBe(2881);
    expect(btc.bookDepthUsdt).toBe(777);
    const statistics = computeSpreadStatistics(btcSeries, SPREAD_SAMPLE_MINUTES_PER_POINT);
    expect(btc.meanSpreadBps!).toBeCloseTo(statistics.mean!, 8);
    expect(btc.halfLifeHours!).toBeCloseTo(statistics.halfLifeHours!, 8);

    // Not promoted: the thin sample history is ignored and candles rebuild the pair.
    expect(eth.source).toBe('candles');
    expect(eth.sampleCount).toBe(288);
  });
});

/** A 5m candle reproducing `spreadBps` against a flat 100 right leg. */
function candle(spreadBps: number, index: number): Candle {
  const close = 100 * (1 + spreadBps / 10_000);
  return {
    startTime: EPOCH_MS + index * 5 * 60_000,
    open: String(close), high: String(close), low: String(close), close: String(close),
    volume: '1', closed: true,
  };
}
