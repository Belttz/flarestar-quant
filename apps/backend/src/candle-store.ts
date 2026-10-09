import type Database from 'better-sqlite3';
import { contiguousCandleTail, type Candle, type CandleInterval } from '@gate-crossex/shared-types';
import { PublicMarketDataError, type PublicMarketDataGateway } from '@gate-crossex/public-data';
import type { CrossExMarketHub } from './market-hub.js';
import { recordMarketDataFailure } from './repositories.js';

const MAX_STORED_CANDLES = 500;
const BACKFILL_LIMIT = 300;
const BACKFILL_TTL_MS = 30_000;

interface CandleRow {
  start_time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface CandleStoreLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

interface BackfillJob {
  priority: number;
  work: () => Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * Bridges three candle sources so the REST route can answer without blocking:
 * SQLite (history from previous sessions), venue public REST (backfill, TTL-deduped,
 * runs in the background once anything is servable), and the live hub series
 * (closed live candles are persisted as they arrive).
 */
export class CandleStore {
  private readonly backfillAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly hydrated = new Set<string>();
  /** Keys whose series is known to include venue REST history (this session or persisted). */
  private readonly venueHistory = new Set<string>();
  /** Keys whose persisted history contained a discontinuity and need one older bridge page. */
  private readonly bridgeNeeded = new Set<string>();
  private readonly prefetching = new Set<string>();
  private readonly backfillQueue: BackfillJob[] = [];
  private activeBackfills = 0;

  private readonly readSeries;
  private readonly upsertCandle;
  private readonly pruneSeries;
  private readonly deleteSeries;

  constructor(
    private readonly database: Database.Database,
    private readonly marketHub: CrossExMarketHub,
    private readonly publicMarketGateway: PublicMarketDataGateway,
    private readonly logger: CandleStoreLogger = { warn: () => undefined },
  ) {
    this.readSeries = database.prepare(`
      SELECT start_time, open, high, low, close, volume FROM candle_cache
      WHERE symbol = ? AND interval = ?
      ORDER BY start_time DESC LIMIT ${MAX_STORED_CANDLES}
    `);
    this.upsertCandle = database.prepare(`
      INSERT INTO candle_cache (symbol, interval, start_time, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, interval, start_time) DO UPDATE SET
        open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume
    `);
    this.pruneSeries = database.prepare(`
      DELETE FROM candle_cache WHERE symbol = ? AND interval = ? AND start_time NOT IN (
        SELECT start_time FROM candle_cache WHERE symbol = ? AND interval = ?
        ORDER BY start_time DESC LIMIT ${MAX_STORED_CANDLES}
      )
    `);
    this.deleteSeries = database.prepare(`
      DELETE FROM candle_cache WHERE symbol = ? AND interval = ?
    `);
    // Live candles flow only for watched keys; persisting each closed one keeps SQLite
    // current between the TTL-spaced REST backfills.
    marketHub.subscribe((message) => {
      if (message.type !== 'kline.update') return;
      try {
        const { symbol, interval, candle } = message.payload;
        const series = this.marketHub.candles(symbol, interval);
        const safe = contiguousCandleTail(series, interval, MAX_STORED_CANDLES);
        if (safe.length !== series.length) {
          const key = `${symbol}:${interval}`;
          this.bridgeNeeded.add(key);
          this.marketHub.replaceCandles(symbol, interval, safe);
          this.replacePersistedCandles(symbol, interval, safe);
          void this.refresh(symbol, interval);
          return;
        }
        if (candle.closed) this.persistCandles(symbol, interval, [candle]);
      } catch { /* a cache write must never break the stream */ }
    });
  }

  canBackfill(symbol: string): boolean {
    return typeof this.publicMarketGateway.queryCandles === 'function'
      // Spot history comes from each venue's spot candlestick endpoint (GATE/BINANCE/OKX/BYBIT);
      // futures venues use their own candlestick endpoints.
      && (/^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_|^(GATE|BINANCE|OKX|BYBIT)_SPOT_/.test(symbol));
  }

  backfilledRecently(symbol: string, interval: CandleInterval): boolean {
    return Date.now() - (this.backfillAt.get(`${symbol}:${interval}`) ?? 0) < BACKFILL_TTL_MS;
  }

  hasVenueHistory(symbol: string, interval: CandleInterval): boolean {
    return this.venueHistory.has(`${symbol}:${interval}`);
  }

  /** Load persisted history into the hub once per key so restarts paint instantly. */
  hydrate(symbol: string, interval: CandleInterval): void {
    const key = `${symbol}:${interval}`;
    if (this.hydrated.has(key)) return;
    this.hydrated.add(key);
    const rows = this.readSeries.all(symbol, interval) as CandleRow[];
    if (rows.length === 0) return;
    const candles: Candle[] = rows.reverse().map((row) => ({
      startTime: row.start_time, open: row.open, high: row.high, low: row.low,
      close: row.close, volume: row.volume, closed: true,
    }));
    const safe = contiguousCandleTail(candles, interval, MAX_STORED_CANDLES);
    if (safe.length !== candles.length) {
      this.bridgeNeeded.add(key);
      this.replacePersistedCandles(symbol, interval, safe);
    }
    this.marketHub.replaceCandles(symbol, interval, safe);
    // Persisted rows for backfillable venues originate from earlier REST backfills.
    if (this.canBackfill(symbol)) this.venueHistory.add(key);
  }

  /**
   * Fetch venue REST history for one key. Deduped while in flight; the TTL is recorded only on
   * success so a failure retries on the next request. Resolves false instead of rejecting —
   * an orphaned rejection here would take down the process.
   */
  refresh(symbol: string, interval: CandleInterval): Promise<boolean> {
    const key = `${symbol}:${interval}`;
    if (!this.canBackfill(symbol)) return Promise.resolve(false);
    const running = this.inFlight.get(key);
    if (running) return running;
    const attempt = (async () => {
      try {
        const existing = this.marketHub.candles(symbol, interval);
        let safe = contiguousCandleTail(existing, interval, MAX_STORED_CANDLES);
        if (safe.length !== existing.length) {
          this.bridgeNeeded.add(key);
          this.marketHub.replaceCandles(symbol, interval, safe);
          this.replacePersistedCandles(symbol, interval, safe);
        }

        const latest = await this.scheduleBackfill(
          async () => await this.publicMarketGateway.queryCandles?.(symbol, interval, BACKFILL_LIMIT) ?? [],
          false,
        );
        // A websocket candle can arrive while REST is in flight. Re-read the hub here so the
        // authoritative replacement below never rolls live data back to the pre-request state.
        const current = this.marketHub.candles(symbol, interval);
        const currentSafe = contiguousCandleTail(current, interval, MAX_STORED_CANDLES);
        if (currentSafe.length !== current.length) this.bridgeNeeded.add(key);
        safe = currentSafe;
        let candidate = this.mergeCandles(latest, safe);
        const contiguous = contiguousCandleTail(candidate, interval);
        const candidateHadGap = contiguous.length !== candidate.length;
        safe = contiguous.slice(-MAX_STORED_CANDLES);
        const needsBridge = (this.bridgeNeeded.has(key) || candidateHadGap)
          && safe.length < MAX_STORED_CANDLES;
        let bridgeCompleted = !needsBridge;

        const oldest = safe[0];
        if (needsBridge && oldest) {
          try {
            const older = await this.scheduleBackfill(
              async () => await this.publicMarketGateway.queryCandles?.(
                symbol,
                interval,
                BACKFILL_LIMIT,
                oldest.startTime,
              ) ?? [],
              false,
            );
            candidate = this.mergeCandles(older.filter((candle) => candle.startTime < oldest.startTime), candidate);
            const bridged = contiguousCandleTail(candidate, interval);
            bridgeCompleted = older.length === 0 || bridged.length > safe.length;
            safe = bridged.slice(-MAX_STORED_CANDLES);
          } catch (error) {
            const reason = error instanceof PublicMarketDataError ? error.code : 'PUBLIC_DATA_ERROR';
            this.logger.warn({ reason, symbol, interval }, 'candle continuity backfill failed');
          }
        }

        // The optional bridge request is another await boundary; merge any candles received
        // during it before publishing the final snapshot.
        candidate = this.mergeCandles(candidate, this.marketHub.candles(symbol, interval));
        const finalContiguous = contiguousCandleTail(candidate, interval);
        const finalHadGap = finalContiguous.length !== candidate.length;
        safe = finalContiguous.slice(-MAX_STORED_CANDLES);
        if (finalHadGap && safe.length < MAX_STORED_CANDLES) bridgeCompleted = false;
        if (safe.length >= MAX_STORED_CANDLES) bridgeCompleted = true;
        this.marketHub.replaceCandles(symbol, interval, safe);
        this.replacePersistedCandles(symbol, interval, safe);
        if (bridgeCompleted) this.bridgeNeeded.delete(key);
        else this.bridgeNeeded.add(key);
        this.backfillAt.set(key, Date.now());
        this.venueHistory.add(key);
        return true;
      } catch (error) {
        const errorCode = error instanceof PublicMarketDataError ? error.code : 'PUBLIC_DATA_ERROR';
        try {
          recordMarketDataFailure(this.database, 'venue_candle_backfill', new Date().toISOString(), errorCode);
        } catch { /* failure bookkeeping must not replace the original signal */ }
        this.logger.warn({ reason: errorCode, symbol, interval }, 'candle backfill failed');
        return false;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, attempt);
    return attempt;
  }

  /**
   * Fetch one page strictly before a chart cursor. Older pages stay in the requesting browser
   * session rather than the bounded live hub/cache, whose job is fast startup around "now".
   * Null distinguishes a transient venue failure from a genuine end-of-history empty page.
   */
  async loadBefore(symbol: string, interval: CandleInterval, before: number, limit: number): Promise<Candle[] | null> {
    if (!this.canBackfill(symbol)) return [];
    try {
      const candles = await this.scheduleBackfill(
        async () => await this.publicMarketGateway.queryCandles?.(symbol, interval, limit, before) ?? [],
        true,
      );
      return contiguousCandleTail(
        candles.filter((candle) => candle.startTime < before),
        interval,
        limit,
      );
    } catch (error) {
      const errorCode = error instanceof PublicMarketDataError ? error.code : 'PUBLIC_DATA_ERROR';
      try {
        recordMarketDataFailure(this.database, 'venue_candle_history', new Date().toISOString(), errorCode);
      } catch { /* failure bookkeeping must not replace the original signal */ }
      this.logger.warn({ reason: errorCode, symbol, interval, before }, 'older candle page failed');
      return null;
    }
  }

  /**
   * Warm only the requested timeframe. Other intervals are fetched when selected, avoiding six
   * speculative venue requests for every watched market.
   */
  prefetch(symbol: string, first: CandleInterval): void {
    const key = `${symbol}:${first}`;
    if (!this.canBackfill(symbol) || this.prefetching.has(key)) return;
    this.prefetching.add(key);
    void (async () => {
      this.hydrate(symbol, first);
      if (!this.backfilledRecently(symbol, first)) await this.refresh(symbol, first);
    })().finally(() => this.prefetching.delete(key));
  }

  private scheduleBackfill<T>(work: () => Promise<T>, urgent: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: BackfillJob = {
        priority: urgent ? 0 : 1,
        work,
        resolve: (value) => resolve(value as T),
        reject,
      };
      this.backfillQueue.push(job);
      this.backfillQueue.sort((left, right) => left.priority - right.priority);
      this.drainBackfills();
    });
  }

  private drainBackfills(): void {
    while (this.activeBackfills < 2 && this.backfillQueue.length > 0) {
      const job = this.backfillQueue.shift();
      if (!job) return;
      this.activeBackfills += 1;
      void job.work().then(job.resolve, job.reject).finally(() => {
        this.activeBackfills -= 1;
        this.drainBackfills();
      });
    }
  }

  private persistCandles(symbol: string, interval: CandleInterval, candles: Candle[], prune = false): void {
    const closed = candles.filter((candle) => candle.closed);
    if (closed.length === 0) return;
    this.database.transaction(() => {
      for (const candle of closed) {
        this.upsertCandle.run(symbol, interval, candle.startTime, candle.open, candle.high, candle.low, candle.close, candle.volume);
      }
      if (prune) this.pruneSeries.run(symbol, interval, symbol, interval);
    })();
  }

  private replacePersistedCandles(symbol: string, interval: CandleInterval, candles: Candle[]): void {
    const closed = candles.filter((candle) => candle.closed);
    this.database.transaction(() => {
      this.deleteSeries.run(symbol, interval);
      for (const candle of closed) {
        this.upsertCandle.run(symbol, interval, candle.startTime, candle.open, candle.high, candle.low, candle.close, candle.volume);
      }
    })();
  }

  /** Merge older/REST candles first so the newer live-hub values win timestamp collisions. */
  private mergeCandles(first: Candle[], second: Candle[]): Candle[] {
    const merged = new Map<number, Candle>();
    for (const candle of first) merged.set(candle.startTime, candle);
    for (const candle of second) merged.set(candle.startTime, candle);
    return [...merged.values()].sort((left, right) => left.startTime - right.startTime);
  }
}
