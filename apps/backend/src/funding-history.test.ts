import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { PublicMarketDataError, type PublicMarketDataGateway } from '@gate-crossex/public-data';
import { openDatabase } from './database.js';
import { FundingHistoryService } from './funding-history.js';

const DAY = 24 * 60 * 60_000;
const NOW = 100 * DAY;
const NO_SPACING = {
  GATE: 0,
  BINANCE: 0,
  OKX: 0,
  BYBIT: 0,
  KRAKEN: 0,
  HYPERLIQUID: 0,
  DERIBIT: 0,
  LIGHTER: 0,
};
const databases: Database.Database[] = [];

function testDatabase(): Database.Database {
  const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
  databases.push(database);
  return database;
}

function gatewayWithHistory(queryFundingHistory: PublicMarketDataGateway['queryFundingHistory']): PublicMarketDataGateway {
  return {
    querySnapshot: vi.fn(),
    queryFundingHistory,
  } as unknown as PublicMarketDataGateway;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('funding history service', () => {
  it('builds an unbounded SQLite ranking snapshot without starting venue requests', () => {
    const database = testDatabase();
    const queryFundingHistory = vi.fn(async () => []);
    const cachedSymbol = 'BINANCE_FUTURE_ASSET0_USDT';
    database.prepare(`
      INSERT INTO funding_rate_history (symbol, funding_time, rate, fetched_at)
      VALUES (?, ?, '0.0025', ?)
    `).run(cachedSymbol, NOW - DAY, new Date(NOW).toISOString());
    database.prepare(`
      INSERT INTO funding_history_coverage (
        symbol, covered_from, covered_to, last_attempt_at, last_success_at, last_error_code
      ) VALUES (?, ?, ?, ?, ?, NULL)
    `).run(cachedSymbol, NOW - (7 * DAY), NOW, new Date(NOW).toISOString(), new Date(NOW).toISOString());
    const service = new FundingHistoryService(database, gatewayWithHistory(queryFundingHistory), {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });
    const symbols = Array.from({ length: 75 }, (_, index) => `BINANCE_FUTURE_ASSET${index}_USDT`);

    const snapshot = service.loadRankingSnapshot(symbols, 7 * DAY);

    expect(snapshot.entries).toHaveLength(75);
    expect(snapshot.entries[0]).toMatchObject({ symbol: cachedSymbol, status: 'ok', rate7d: '0.0025' });
    expect(snapshot.entries[1]).toMatchObject({ status: 'pending', rate7d: null });
    expect(queryFundingHistory).not.toHaveBeenCalled();
  });

  it('calculates a requested seven-day total directly from local coverage', () => {
    const database = testDatabase();
    const queryFundingHistory = vi.fn(async () => []);
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    database.prepare(`
      INSERT INTO funding_rate_history (symbol, funding_time, rate, fetched_at)
      VALUES (?, ?, '0.0025', ?)
    `).run(symbol, NOW - DAY, new Date(NOW).toISOString());
    database.prepare(`
      INSERT INTO funding_history_coverage (
        symbol, covered_from, covered_to, last_attempt_at, last_success_at, last_error_code
      ) VALUES (?, ?, ?, ?, ?, NULL)
    `).run(symbol, NOW - (7 * DAY), NOW, new Date(NOW).toISOString(), new Date(NOW).toISOString());
    const service = new FundingHistoryService(database, gatewayWithHistory(queryFundingHistory), {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });

    expect(service.loadCachedMany([symbol], 7 * DAY).entries[0]).toMatchObject({
      status: 'ok',
      rate7d: '0.0025',
      rate30d: null,
    });
    expect(queryFundingHistory).not.toHaveBeenCalled();
  });

  it('returns a pending cache result immediately while missing coverage warms', async () => {
    const database = testDatabase();
    let releaseHistory: ((points: Array<{ timestamp: number; rate: string }>) => void) | undefined;
    const queryFundingHistory = vi.fn(async () => await new Promise<Array<{ timestamp: number; rate: string }>>((resolve) => {
      releaseHistory = resolve;
    }));
    const symbol = 'OKX_FUTURE_ETH_USDT';
    const service = new FundingHistoryService(database, gatewayWithHistory(queryFundingHistory), {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });

    expect(service.loadCachedMany([symbol], 7 * DAY).entries[0]?.status).toBe('pending');
    await vi.waitFor(() => expect(queryFundingHistory).toHaveBeenCalledTimes(1));
    releaseHistory?.([{ timestamp: NOW - DAY, rate: '0.001' }]);
    await vi.waitFor(() => {
      expect(service.loadCachedMany([symbol], 7 * DAY).entries[0]).toMatchObject({
        status: 'ok',
        rate7d: '0.001',
      });
    });
  });

  it('persists realized records and sums exact rolling 24h, 7d, and 30d totals', async () => {
    const database = testDatabase();
    const queryFundingHistory = vi.fn(async () => [
      { timestamp: NOW - (30 * DAY), rate: '9' },
      { timestamp: NOW - (20 * DAY), rate: '0.1' },
      { timestamp: NOW - (5 * DAY), rate: '0.02' },
      { timestamp: NOW - (DAY / 2), rate: '-0.003' },
    ]);
    const service = new FundingHistoryService(database, gatewayWithHistory(queryFundingHistory), {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });

    const result = await service.loadMany(['BINANCE_FUTURE_BTC_USDT']);

    expect(result.entries[0]).toEqual({
      symbol: 'BINANCE_FUTURE_BTC_USDT',
      status: 'ok',
      rate24h: '-0.003',
      rate7d: '0.017',
      rate30d: '0.117',
      settlementCount30d: 3,
      oldestFundingAt: new Date(NOW - (20 * DAY)).toISOString(),
      newestFundingAt: new Date(NOW - (DAY / 2)).toISOString(),
      fetchedAt: new Date(NOW).toISOString(),
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM funding_rate_history').get()).toEqual({ count: 3 });
  });

  it('returns chartable raw settlements for the requested cached duration', async () => {
    const database = testDatabase();
    const service = new FundingHistoryService(database, gatewayWithHistory(vi.fn(async () => [
      { timestamp: NOW - (10 * DAY), rate: '0.01' },
      { timestamp: NOW - (DAY / 2), rate: '-0.002' },
    ])), {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });

    const result = await service.loadSeries(['GATE_FUTURE_BTC_USDT'], DAY);

    expect(result).toMatchObject({
      from: NOW - DAY,
      to: NOW,
      entries: [{
        symbol: 'GATE_FUTURE_BTC_USDT',
        status: 'ok',
        points: [{ timestamp: NOW - (DAY / 2), rate: '-0.002' }],
      }],
    });
  });

  it('waits for a stale series tail to refresh before returning chart points', async () => {
    const database = testDatabase();
    let currentTime = NOW;
    const correctedTimestamp = NOW - (DAY / 2);
    let releaseRefresh: ((points: Array<{ timestamp: number; rate: string }>) => void) | undefined;
    const queryFundingHistory = vi.fn(async () => {
      if (queryFundingHistory.mock.calls.length === 1) {
        return [{ timestamp: correctedTimestamp, rate: '0.1' }];
      }
      return await new Promise<Array<{ timestamp: number; rate: string }>>((resolve) => {
        releaseRefresh = resolve;
      });
    });
    const service = new FundingHistoryService(database, gatewayWithHistory(queryFundingHistory), {
      now: () => currentTime,
      venueSpacingMs: NO_SPACING,
    });
    await service.loadSeries(['HYPERLIQUID_FUTURE_HYPE_USDC'], 30 * DAY);
    currentTime += 16 * 60_000;

    let resolved = false;
    const pending = service.loadSeries(['HYPERLIQUID_FUTURE_HYPE_USDC'], 30 * DAY)
      .finally(() => { resolved = true; });
    await vi.waitFor(() => expect(queryFundingHistory).toHaveBeenCalledTimes(2));
    expect(resolved).toBe(false);
    releaseRefresh?.([
      { timestamp: correctedTimestamp, rate: '0.2' },
      { timestamp: currentTime - (60 * 60_000), rate: '0.03' },
    ]);

    await expect(pending).resolves.toMatchObject({
      entries: [{
        symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC',
        status: 'ok',
        points: [
          { timestamp: correctedTimestamp, rate: '0.2' },
          { timestamp: currentTime - (60 * 60_000), rate: '0.03' },
        ],
      }],
    });
  });

  it('deduplicates simultaneous symbols and reuses persisted coverage after restart', async () => {
    const database = testDatabase();
    const queryFundingHistory = vi.fn(async () => [{ timestamp: NOW - DAY, rate: '0.0001' }]);
    const gateway = gatewayWithHistory(queryFundingHistory);
    const firstService = new FundingHistoryService(database, gateway, {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });

    const first = await firstService.loadMany(['GATE_FUTURE_BTC_USDT', 'GATE_FUTURE_BTC_USDT']);
    const restartedService = new FundingHistoryService(database, gateway, {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });
    const second = await restartedService.loadMany(['GATE_FUTURE_BTC_USDT']);

    expect(first.entries).toHaveLength(1);
    expect(second.entries[0]?.rate30d).toBe('0.0001');
    expect(queryFundingHistory).toHaveBeenCalledTimes(1);
  });

  it('records successful empty coverage as an actual zero instead of repeatedly refetching', async () => {
    const database = testDatabase();
    const queryFundingHistory = vi.fn(async () => []);
    const gateway = gatewayWithHistory(queryFundingHistory);
    const firstService = new FundingHistoryService(database, gateway, {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });
    const first = await firstService.loadMany(['DERIBIT_FUTURE_NEW_USDT']);
    const restartedService = new FundingHistoryService(database, gateway, {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });
    const second = await restartedService.loadMany(['DERIBIT_FUTURE_NEW_USDT']);

    expect(first.entries[0]).toMatchObject({
      status: 'ok',
      rate24h: '0',
      rate7d: '0',
      rate30d: '0',
      settlementCount30d: 0,
    });
    expect(second.entries[0]?.status).toBe('ok');
    expect(queryFundingHistory).toHaveBeenCalledTimes(1);
  });

  it('refreshes an overlapping tail and replaces corrected settlements', async () => {
    const database = testDatabase();
    let currentTime = NOW;
    const correctedTimestamp = NOW - (DAY / 2);
    const queryFundingHistory = vi.fn(async () => (
      queryFundingHistory.mock.calls.length === 1
        ? [{ timestamp: correctedTimestamp, rate: '0.1' }]
        : [
            { timestamp: correctedTimestamp, rate: '0.2' },
            { timestamp: currentTime - (60 * 60_000), rate: '0.03' },
          ]
    ));
    const service = new FundingHistoryService(database, gatewayWithHistory(queryFundingHistory), {
      now: () => currentTime,
      venueSpacingMs: NO_SPACING,
    });

    expect((await service.loadMany(['BINANCE_FUTURE_ETH_USDT'])).entries[0]?.rate30d).toBe('0.1');
    currentTime += 16 * 60_000;
    const stale = await service.loadMany(['BINANCE_FUTURE_ETH_USDT']);
    expect(stale.entries[0]?.rate30d).toBe('0.1');
    await vi.waitFor(() => {
      expect(database.prepare(`
        SELECT rate
        FROM funding_rate_history
        WHERE symbol = 'BINANCE_FUTURE_ETH_USDT'
        ORDER BY funding_time
      `).all()).toEqual([{ rate: '0.2' }, { rate: '0.03' }]);
    });
    const refreshed = await service.loadMany(['BINANCE_FUTURE_ETH_USDT']);

    expect(refreshed.entries[0]).toMatchObject({
      rate24h: '0.23',
      rate30d: '0.23',
      settlementCount30d: 2,
    });
    expect(queryFundingHistory).toHaveBeenNthCalledWith(
      2,
      'BINANCE_FUTURE_ETH_USDT',
      NOW - DAY,
      currentTime,
      undefined,
    );
  });

  it('serves a stale cached total immediately while refreshing its tail in the background', async () => {
    const database = testDatabase();
    let currentTime = NOW;
    const correctedTimestamp = NOW - (DAY / 2);
    let releaseRefresh: ((points: Array<{ timestamp: number; rate: string }>) => void) | undefined;
    const queryFundingHistory = vi.fn(async () => {
      if (queryFundingHistory.mock.calls.length === 1) {
        return [{ timestamp: correctedTimestamp, rate: '0.1' }];
      }
      return await new Promise<Array<{ timestamp: number; rate: string }>>((resolve) => {
        releaseRefresh = resolve;
      });
    });
    const service = new FundingHistoryService(database, gatewayWithHistory(queryFundingHistory), {
      now: () => currentTime,
      venueSpacingMs: NO_SPACING,
    });
    await service.loadMany(['GATE_FUTURE_ETH_USDT']);
    currentTime += 16 * 60_000;

    const stale = await service.loadMany(['GATE_FUTURE_ETH_USDT']);

    expect(stale.entries[0]?.rate30d).toBe('0.1');
    await vi.waitFor(() => expect(queryFundingHistory).toHaveBeenCalledTimes(2));
    releaseRefresh?.([{ timestamp: correctedTimestamp, rate: '0.2' }]);
    await vi.waitFor(() => {
      expect(database.prepare(`
        SELECT rate FROM funding_rate_history
        WHERE symbol = 'GATE_FUTURE_ETH_USDT'
      `).get()).toEqual({ rate: '0.2' });
    });
  });

  it('keeps previously cached symbols fresh with the background worker', async () => {
    const database = testDatabase();
    let currentTime = NOW;
    const correctedTimestamp = NOW - (DAY / 2);
    const queryFundingHistory = vi.fn(async () => [{
      timestamp: correctedTimestamp,
      rate: queryFundingHistory.mock.calls.length === 1 ? '0.1' : '0.25',
    }]);
    const gateway = gatewayWithHistory(queryFundingHistory);
    const service = new FundingHistoryService(database, gateway, {
      now: () => currentTime,
      backgroundIntervalMs: DAY,
      venueSpacingMs: NO_SPACING,
    });
    await service.loadMany(['BINANCE_FUTURE_XRP_USDT']);
    currentTime += 16 * 60_000;
    const restartedService = new FundingHistoryService(database, gateway, {
      now: () => currentTime,
      backgroundIntervalMs: DAY,
      venueSpacingMs: NO_SPACING,
    });

    restartedService.startBackground();

    await vi.waitFor(() => expect(queryFundingHistory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(database.prepare(`
        SELECT rate FROM funding_rate_history
        WHERE symbol = 'BINANCE_FUTURE_XRP_USDT'
      `).get()).toEqual({ rate: '0.25' });
    });
    await restartedService.stopBackground();
  });

  it('aggregates duplicate timestamp records before enforcing the database key', async () => {
    const database = testDatabase();
    const timestamp = NOW - DAY;
    const service = new FundingHistoryService(database, gatewayWithHistory(vi.fn(async () => [
      { timestamp, rate: '0.1' },
      { timestamp, rate: '-0.02' },
    ])), {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });

    const result = await service.loadMany(['BINANCE_FUTURE_SOL_USDT']);

    expect(result.entries[0]).toMatchObject({ rate30d: '0.08', settlementCount30d: 1 });
  });

  it('serves no invented value on failure and avoids an immediate retry storm', async () => {
    const database = testDatabase();
    const queryFundingHistory = vi.fn(async () => {
      throw new Error('upstream unavailable');
    });
    const service = new FundingHistoryService(database, gatewayWithHistory(queryFundingHistory), {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });

    await expect(service.loadMany(['OKX_FUTURE_BTC_USDT'])).resolves.toMatchObject({
      entries: [{
        symbol: 'OKX_FUTURE_BTC_USDT',
        status: 'unavailable',
        rate30d: null,
        settlementCount30d: 0,
      }],
    });
    await service.loadMany(['OKX_FUTURE_BTC_USDT']);
    expect(queryFundingHistory).toHaveBeenCalledTimes(1);
  });

  it('keeps retryable cache misses pending through cooldown and recovers afterward', async () => {
    const database = testDatabase();
    let currentTime = NOW;
    const warn = vi.fn();
    const queryFundingHistory = vi.fn(async () => {
      if (queryFundingHistory.mock.calls.length === 1) {
        throw new PublicMarketDataError('UPSTREAM_HTTP_500');
      }
      return [{ timestamp: currentTime - DAY, rate: '0.001' }];
    });
    const symbol = 'HYPERLIQUID_FUTURE_SNDK_USDC';
    const service = new FundingHistoryService(database, gatewayWithHistory(queryFundingHistory), {
      now: () => currentTime,
      failureCacheMs: 60_000,
      venueSpacingMs: NO_SPACING,
      warn,
    });

    expect(service.loadCachedMany([symbol], 7 * DAY).entries[0]?.status).toBe('pending');
    await vi.waitFor(() => expect(queryFundingHistory).toHaveBeenCalledTimes(1));

    expect(service.loadCachedMany([symbol], 7 * DAY).entries[0]?.status).toBe('pending');
    expect(queryFundingHistory).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    currentTime += 60_001;
    expect(service.loadCachedMany([symbol], 7 * DAY).entries[0]?.status).toBe('pending');
    await vi.waitFor(() => expect(queryFundingHistory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(service.loadCachedMany([symbol], 7 * DAY).entries[0]).toMatchObject({
        status: 'ok',
        rate7d: '0.001',
      });
    });
  });

  it('uses conservative Hyperliquid spacing for short and cold history windows', async () => {
    const shortDatabase = testDatabase();
    const shortSleep = vi.fn(async () => undefined);
    const shortService = new FundingHistoryService(
      shortDatabase,
      gatewayWithHistory(vi.fn(async () => [])),
      { now: () => NOW, sleep: shortSleep },
    );
    await shortService.loadMany([
      'HYPERLIQUID_FUTURE_BTC_USDC',
      'HYPERLIQUID_FUTURE_ETH_USDC',
    ], 7 * DAY);
    expect(shortSleep).toHaveBeenCalledWith(2_000);

    const coldDatabase = testDatabase();
    const coldSleep = vi.fn(async () => undefined);
    const coldService = new FundingHistoryService(
      coldDatabase,
      gatewayWithHistory(vi.fn(async () => [])),
      { now: () => NOW, sleep: coldSleep },
    );
    await coldService.loadMany([
      'HYPERLIQUID_FUTURE_BTC_USDC',
      'HYPERLIQUID_FUTURE_ETH_USDC',
    ]);
    expect(coldSleep).toHaveBeenCalledWith(6_000);
  });

  it('prunes persisted history and coverage beyond the retention window', async () => {
    const database = testDatabase();
    const oldTimestamp = NOW - (91 * DAY);
    database.prepare(`
      INSERT INTO funding_rate_history (symbol, funding_time, rate, fetched_at)
      VALUES ('GATE_FUTURE_OLD_USDT', ?, '0.1', 'old')
    `).run(oldTimestamp);
    database.prepare(`
      INSERT INTO funding_history_coverage (
        symbol, covered_from, covered_to, last_attempt_at, last_success_at, last_error_code
      ) VALUES ('GATE_FUTURE_OLD_USDT', ?, ?, 'old', 'old', NULL)
    `).run(oldTimestamp - DAY, oldTimestamp);
    const service = new FundingHistoryService(database, gatewayWithHistory(vi.fn(async () => [])), {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });

    await service.loadMany(['GATE_FUTURE_NEW_USDT']);

    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM funding_rate_history WHERE symbol = 'GATE_FUTURE_OLD_USDT'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM funding_history_coverage WHERE symbol = 'GATE_FUTURE_OLD_USDT'
    `).get()).toEqual({ count: 0 });
  });

  it('rejects a request that exceeds its explicit symbol budget', async () => {
    const database = testDatabase();
    const queryFundingHistory = vi.fn(async () => []);
    const service = new FundingHistoryService(database, gatewayWithHistory(queryFundingHistory), {
      now: () => NOW,
      maxRequestSymbols: 2,
      venueSpacingMs: NO_SPACING,
    });

    await expect(service.loadMany([
      'BINANCE_FUTURE_BTC_USDT',
      'BINANCE_FUTURE_ETH_USDT',
      'BINANCE_FUTURE_SOL_USDT',
    ])).rejects.toThrow('2-symbol budget');
    expect(queryFundingHistory).not.toHaveBeenCalled();
  });

  it('aborts an active background history request during shutdown without recording a failure', async () => {
    const database = testDatabase();
    database.prepare(`
      INSERT INTO funding_history_coverage (
        symbol, covered_from, covered_to, last_attempt_at, last_success_at, last_error_code
      ) VALUES ('BINANCE_FUTURE_BTC_USDT', ?, ?, 'old', 'old', NULL)
    `).run(NOW - (30 * DAY), NOW - DAY);
    let observedSignal: AbortSignal | undefined;
    const queryFundingHistory = vi.fn(async (
      _symbol: string,
      _start: number,
      _end: number,
      signal?: AbortSignal,
    ) => {
      observedSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return [];
    });
    const service = new FundingHistoryService(database, gatewayWithHistory(queryFundingHistory), {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });

    service.startBackground();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await service.stopBackground();

    expect(observedSignal?.aborted).toBe(true);
    expect(database.prepare(`
      SELECT last_error_code FROM funding_history_coverage WHERE symbol = 'BINANCE_FUTURE_BTC_USDT'
    `).get()).toEqual({ last_error_code: null });
  });
});

describe('per-settlement reads for the funding board', () => {
  it('returns each cached settlement in order without starting a venue request', () => {
    const database = testDatabase();
    const queryFundingHistory = vi.fn(async () => []);
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    const insert = database.prepare(`
      INSERT INTO funding_rate_history (symbol, funding_time, rate, fetched_at)
      VALUES (?, ?, ?, ?)
    `);
    // Three 8h settlements plus one that falls outside the lookback window.
    insert.run(symbol, NOW - (8 * 60 * 60_000), '0.0003', new Date(NOW).toISOString());
    insert.run(symbol, NOW - (16 * 60 * 60_000), '-0.0002', new Date(NOW).toISOString());
    insert.run(symbol, NOW - (24 * 60 * 60_000), '0.0001', new Date(NOW).toISOString());
    insert.run(symbol, NOW - (200 * DAY), '9.9999', new Date(NOW).toISOString());
    const service = new FundingHistoryService(database, gatewayWithHistory(queryFundingHistory), {
      now: () => NOW,
      venueSpacingMs: NO_SPACING,
    });

    const result = service.readRecentSettlements([symbol, 'OKX_FUTURE_NEVER_USDT'], 8);

    expect(result.get(symbol)?.map((point) => point.rate)).toEqual(['0.0001', '-0.0002', '0.0003']);
    // A symbol that was never cached reads as an empty array, not as a zero rate.
    expect(result.get('OKX_FUTURE_NEVER_USDT')).toEqual([]);
    expect(queryFundingHistory).not.toHaveBeenCalled();
  });
});
