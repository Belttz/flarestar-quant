import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { Candle, CandleInterval } from '@gate-crossex/shared-types';
import type { PublicMarketDataGateway } from '@gate-crossex/public-data';
import { openDatabase } from './database.js';
import { CandleStore } from './candle-store.js';
import type { CrossExMarketHub } from './market-hub.js';

function fakeHub(): CrossExMarketHub {
  const series = new Map<string, Candle[]>();
  return {
    subscribe: () => () => undefined,
    seedCandles: (symbol: string, interval: CandleInterval, candles: Candle[]) => {
      series.set(`${symbol}:${interval}`, candles);
    },
    replaceCandles: (symbol: string, interval: CandleInterval, candles: Candle[]) => {
      series.set(`${symbol}:${interval}`, candles);
    },
    candles: (symbol: string, interval: CandleInterval) => series.get(`${symbol}:${interval}`) ?? [],
  } as unknown as CrossExMarketHub;
}

function candle(startTime: number): Candle {
  const value = String(startTime);
  return { startTime, open: value, high: value, low: value, close: value, volume: '1', closed: true };
}

function gateway(queryCandles: NonNullable<PublicMarketDataGateway['queryCandles']>): PublicMarketDataGateway {
  return {
    querySnapshot: async () => { throw new Error('not used'); },
    queryCandles,
  };
}

describe('candle backfill scheduling', () => {
  it('prefetches only the timeframe the browser requested', async () => {
    const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
    const queryCandles = vi.fn(async () => []);
    const store = new CandleStore(database, fakeHub(), gateway(queryCandles));

    store.prefetch('BINANCE_FUTURE_BTC_USDT', '5m');
    await vi.waitFor(() => expect(queryCandles).toHaveBeenCalledTimes(1));

    expect(queryCandles).toHaveBeenCalledWith('BINANCE_FUTURE_BTC_USDT', '5m', 300);
    database.close();
  });

  it('allows backfill for all futures venues and only for spot venues with fetchers', () => {
    const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
    const store = new CandleStore(database, fakeHub(), gateway(async () => []));
    for (const venue of ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT', 'LIGHTER']) {
      expect(store.canBackfill(`${venue}_FUTURE_BTC_USDT`)).toBe(true);
    }
    expect(store.canBackfill('GATE_SPOT_BTC_USDT')).toBe(true);
    expect(store.canBackfill('BINANCE_SPOT_BTC_USDT')).toBe(true);
    expect(store.canBackfill('OKX_SPOT_BTC_USDT')).toBe(true);
    expect(store.canBackfill('BYBIT_SPOT_BTC_USDT')).toBe(true);
    // Venues without a spot candle fetcher degrade to websocket-only history.
    expect(store.canBackfill('DERIBIT_SPOT_BTC_USDC')).toBe(false);
    expect(store.canBackfill('KRAKEN_SPOT_BTC_USDT')).toBe(false);
    database.close();
  });

  it('allows at most two concurrent venue backfills', async () => {
    const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const queryCandles = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolvePromise) => releases.push(resolvePromise));
      active -= 1;
      return [];
    });
    const store = new CandleStore(database, fakeHub(), gateway(queryCandles));
    const requests = ['BTC', 'ETH', 'SOL', 'XRP'].map((asset) =>
      store.refresh(`BINANCE_FUTURE_${asset}_USDT`, '1m'));

    await vi.waitFor(() => expect(queryCandles).toHaveBeenCalledTimes(2));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(queryCandles).toHaveBeenCalledTimes(4));
    releases.splice(0).forEach((release) => release());
    await Promise.all(requests);

    expect(maximumActive).toBe(2);
    database.close();
  });

  it('drops a cached discontinuity and fetches the bridge before publishing history', async () => {
    const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
    const symbol = 'BINANCE_FUTURE_SKHYNIX_USDT';
    const interval: CandleInterval = '1m';
    const insert = database.prepare(`
      INSERT INTO candle_cache (symbol, interval, start_time, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const old = Array.from({ length: 200 }, (_, index) => candle(index * 60_000));
    const latest = Array.from({ length: 300 }, (_, index) => candle((10_000 + index) * 60_000));
    database.transaction(() => {
      for (const item of [...old, ...latest]) {
        insert.run(symbol, interval, item.startTime, item.open, item.high, item.low, item.close, item.volume);
      }
    })();

    const bridge = Array.from({ length: 300 }, (_, index) => candle((9_700 + index) * 60_000));
    const queryCandles = vi.fn(async (
      _symbol: string,
      _interval: CandleInterval,
      _limit: number,
      before?: number,
    ) => before === latest[0]?.startTime ? bridge : latest);
    const hub = fakeHub();
    const store = new CandleStore(database, hub, gateway(queryCandles));

    store.hydrate(symbol, interval);
    expect(hub.candles(symbol, interval).map((item) => item.startTime)).toEqual(
      latest.map((item) => item.startTime),
    );

    await expect(store.refresh(symbol, interval)).resolves.toBe(true);

    const published = hub.candles(symbol, interval);
    expect(published).toHaveLength(500);
    expect(published[0]?.startTime).toBe(9_800 * 60_000);
    expect(published.every((item, index) =>
      index === 0 || item.startTime - published[index - 1]!.startTime === 60_000)).toBe(true);
    expect(queryCandles).toHaveBeenNthCalledWith(1, symbol, interval, 300);
    expect(queryCandles).toHaveBeenNthCalledWith(2, symbol, interval, 300, latest[0]?.startTime);

    const persisted = database.prepare(`
      SELECT COUNT(*) AS count, MIN(start_time) AS oldest FROM candle_cache
      WHERE symbol = ? AND interval = ?
    `).get(symbol, interval) as { count: number; oldest: number };
    expect(persisted).toEqual({ count: 500, oldest: 9_800 * 60_000 });
    database.close();
  });

  it('preserves websocket candles received while a REST refresh is in flight', async () => {
    const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    const latest = Array.from({ length: 300 }, (_, index) => candle(index * 60_000));
    let finishQuery: ((candles: Candle[]) => void) | undefined;
    const queryCandles = vi.fn(async () => await new Promise<Candle[]>((resolveQuery) => {
      finishQuery = resolveQuery;
    }));
    const hub = fakeHub();
    const store = new CandleStore(database, hub, gateway(queryCandles));

    const refresh = store.refresh(symbol, '1m');
    await vi.waitFor(() => expect(queryCandles).toHaveBeenCalledTimes(1));
    const live = { ...candle(300 * 60_000), close: 'live', closed: false };
    hub.replaceCandles(symbol, '1m', [live]);
    finishQuery?.(latest);

    await expect(refresh).resolves.toBe(true);
    expect(hub.candles(symbol, '1m').at(-1)).toMatchObject({ startTime: live.startTime, close: 'live' });
    database.close();
  });
});
