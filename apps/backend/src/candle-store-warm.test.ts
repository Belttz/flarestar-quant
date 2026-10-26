import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { Candle, CandleInterval } from '@gate-crossex/shared-types';
import type { PublicMarketDataGateway } from '@gate-crossex/public-data';
import { openDatabase } from './database.js';
import { CandleStore } from './candle-store.js';
import type { CrossExMarketHub } from './market-hub.js';

/**
 * A market whose venue REST history cannot be fetched at all — the price-difference chart used to
 * stay permanently blank for those legs (verified against a network where only Gate is reachable:
 * `/api/markets/BINANCE_FUTURE_BTC_USDT/candles` answered `candles: []` forever). The CrossEx
 * kline channel is the remaining source, so an empty read must keep it subscribed.
 */
function hubWithKlineWatcher() {
  const series = new Map<string, Candle[]>();
  const releases = new Map<string, () => void>();
  const hub = {
    subscribe: () => () => undefined,
    replaceCandles: (symbol: string, interval: CandleInterval, candles: Candle[]) => {
      series.set(`${symbol}:${interval}`, candles);
    },
    candles: (symbol: string, interval: CandleInterval) => series.get(`${symbol}:${interval}`) ?? [],
    watchKlines: vi.fn((symbol: string, interval: CandleInterval) => {
      const key = `${symbol}:${interval}`;
      const release = () => { releases.delete(key); };
      releases.set(key, release);
      return release;
    }),
  };
  return { hub: hub as unknown as CrossExMarketHub, watchKlines: hub.watchKlines, releases, series };
}

function gateway(): PublicMarketDataGateway {
  return {
    querySnapshot: async () => { throw new Error('not used'); },
    queryCandles: async () => { throw new Error('venue unreachable'); },
  };
}

describe('cross-exchange kline fallback', () => {
  it('subscribes the CrossEx kline channel once per key when history is unavailable', () => {
    const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
    const { hub, watchKlines, releases } = hubWithKlineWatcher();
    const store = new CandleStore(database, hub, gateway());

    store.keepWarm('BINANCE_FUTURE_BTC_USDT', '1m');
    store.keepWarm('BINANCE_FUTURE_BTC_USDT', '1m');
    store.keepWarm('OKX_FUTURE_BTC_USDT', '1m');

    // Repeated polls extend the existing subscription instead of stacking watchers in the hub.
    expect(watchKlines).toHaveBeenCalledTimes(2);
    expect(releases.size).toBe(2);
    database.close();
  });

  it('releases every warm watcher on shutdown', () => {
    const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
    const { hub, releases } = hubWithKlineWatcher();
    const store = new CandleStore(database, hub, gateway());

    store.keepWarm('BINANCE_FUTURE_BTC_USDT', '5m');
    expect(releases.size).toBe(1);
    store.releaseWarmWatches();
    expect(releases.size).toBe(0);
    // Releasing twice is a no-op rather than a duplicate release.
    store.releaseWarmWatches();
    expect(releases.size).toBe(0);
    database.close();
  });

  it('keeps serving the candle route when the hub cannot stream klines', () => {
    const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
    const hub = {
      subscribe: () => () => undefined,
      replaceCandles: () => undefined,
      candles: () => [],
      watchKlines: () => { throw new Error('stream disabled'); },
    } as unknown as CrossExMarketHub;
    const store = new CandleStore(database, hub, gateway());

    expect(() => store.keepWarm('BINANCE_FUTURE_BTC_USDT', '1m')).not.toThrow();
    database.close();
  });
});
