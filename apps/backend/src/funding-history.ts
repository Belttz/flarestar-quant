import { Decimal } from 'decimal.js';
import type Database from 'better-sqlite3';
import {
  isRetryablePublicMarketDataError,
  PublicMarketDataError,
  type FundingRatePoint,
  type PublicMarketDataGateway,
} from '@gate-crossex/public-data';
import type { FundingHistoryEntry, FundingHistoryResponse, FundingHistorySeriesResponse } from '@gate-crossex/shared-types';
import {
  listCachedFundingHistorySymbols,
  pruneFundingRateHistory,
  readFundingHistoryCoverage,
  readFundingRateHistory,
  recordFundingHistoryFailure,
  replaceFundingHistoryRange,
} from './repositories.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;
const ONE_DAY_MS = 24 * 60 * 60_000;
const DEFAULT_FRESH_MS = 15 * 60_000;
const DEFAULT_TAIL_OVERLAP_MS = ONE_DAY_MS;
const DEFAULT_RETENTION_MS = 90 * ONE_DAY_MS;
const PRUNE_INTERVAL_MS = ONE_DAY_MS;
const HYPERLIQUID_TAIL_SPACING_MS = 2_000;
const SYMBOL_VENUE = /^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_/;
const DEFAULT_MAX_REQUEST_SYMBOLS = 50;
const DEFAULT_MAX_BACKGROUND_SYMBOLS = 140;

export interface FundingHistoryServiceOptions {
  freshMs?: number;
  backgroundIntervalMs?: number;
  failureCacheMs?: number;
  tailOverlapMs?: number;
  retentionMs?: number;
  maxRequestSymbols?: number;
  maxBackgroundSymbols?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Tests can disable pacing; production spaces costly Hyperliquid history calls. */
  venueSpacingMs?: Partial<Record<string, number>>;
  warn?: (symbol: string, reason: string) => void;
}

function sumAfter(points: FundingRatePoint[], cutoff: number): string {
  let total = new Decimal(0);
  for (const point of points) {
    if (point.timestamp > cutoff) total = total.plus(point.rate);
  }
  return total.toString();
}

function aggregatePoints(
  points: readonly FundingRatePoint[],
  startExclusive: number,
  endInclusive: number,
): FundingRatePoint[] {
  const ratesByTimestamp = new Map<number, Decimal>();
  for (const point of points) {
    if (
      !Number.isSafeInteger(point.timestamp)
      || point.timestamp <= startExclusive
      || point.timestamp > endInclusive
    ) {
      continue;
    }
    const rate = new Decimal(point.rate);
    if (!rate.isFinite()) throw new Error('Funding history contained a non-finite rate');
    ratesByTimestamp.set(
      point.timestamp,
      (ratesByTimestamp.get(point.timestamp) ?? new Decimal(0)).plus(rate),
    );
  }
  return [...ratesByTimestamp.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timestamp, rate]) => ({ timestamp, rate: rate.toString() }));
}

/**
 * Persists normalized realized funding settlements locally. The first request backfills 30 days;
 * later requests replace an overlapping tail so venue corrections are reflected without repeatedly
 * downloading the full range.
 */
export class FundingHistoryService {
  private readonly inFlight = new Map<string, Promise<FundingHistoryEntry>>();
  private readonly failures = new Map<string, { until: number; retryable: boolean }>();
  private readonly venueTails = new Map<string, Promise<void>>();
  private readonly venueLastStartedAt = new Map<string, number>();
  private readonly freshMs: number;
  private readonly backgroundIntervalMs: number;
  private readonly failureCacheMs: number;
  private readonly tailOverlapMs: number;
  private readonly retentionMs: number;
  private readonly maxRequestSymbols: number;
  private readonly maxBackgroundSymbols: number;
  private readonly recentSymbols = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly venueSpacingMs: Record<string, number>;
  private readonly warn: (symbol: string, reason: string) => void;
  private lastPrunedAt: number | null = null;
  private backgroundEnabled = false;
  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  private backgroundRun: Promise<void> | null = null;
  private backgroundController: AbortController | null = null;

  constructor(
    private readonly database: Database.Database,
    private readonly gateway: PublicMarketDataGateway,
    options: FundingHistoryServiceOptions = {},
  ) {
    this.freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
    this.backgroundIntervalMs = options.backgroundIntervalMs ?? this.freshMs;
    this.failureCacheMs = options.failureCacheMs ?? 60_000;
    this.tailOverlapMs = options.tailOverlapMs ?? DEFAULT_TAIL_OVERLAP_MS;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxRequestSymbols = options.maxRequestSymbols ?? DEFAULT_MAX_REQUEST_SYMBOLS;
    this.maxBackgroundSymbols = options.maxBackgroundSymbols ?? DEFAULT_MAX_BACKGROUND_SYMBOLS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.venueSpacingMs = {
      GATE: 75,
      BINANCE: 75,
      OKX: 125,
      BYBIT: 125,
      KRAKEN: 125,
      HYPERLIQUID: 6_000,
      DERIBIT: 125,
      LIGHTER: 250,
      ...options.venueSpacingMs,
    };
    this.warn = options.warn ?? (() => undefined);
  }

  /** Keep every previously requested symbol warm without requiring the funding page to be open. */
  startBackground(): void {
    if (this.backgroundEnabled) return;
    this.backgroundEnabled = true;
    this.backgroundController = new AbortController();
    void this.refreshCachedSymbols();
    this.backgroundTimer = setInterval(() => {
      void this.refreshCachedSymbols();
    }, this.backgroundIntervalMs);
    this.backgroundTimer.unref?.();
  }

  async stopBackground(): Promise<void> {
    this.backgroundEnabled = false;
    if (this.backgroundTimer) clearInterval(this.backgroundTimer);
    this.backgroundTimer = null;
    this.backgroundController?.abort();
    await this.backgroundRun;
    this.backgroundController = null;
  }

  async loadMany(
    symbols: readonly string[],
    requiredWindowMs = THIRTY_DAYS_MS,
  ): Promise<FundingHistoryResponse> {
    this.pruneIfNeeded();
    const uniqueSymbols = [...new Set(symbols)];
    if (uniqueSymbols.length > this.maxRequestSymbols) {
      throw new Error(`Funding history request exceeds the ${this.maxRequestSymbols}-symbol budget`);
    }
    for (const symbol of uniqueSymbols) this.touchSymbol(symbol);
    const entries = await Promise.all(uniqueSymbols.map(async (symbol) => await this.load(symbol, requiredWindowMs)));
    return { entries, fetchedAt: new Date(this.now()).toISOString() };
  }

  /**
   * Return rolling totals from SQLite without waiting on venue APIs. Missing
   * ranges are queued in the background and reported as pending so callers can
   * cheaply poll the local cache.
   */
  loadCachedMany(
    symbols: readonly string[],
    requiredWindowMs = THIRTY_DAYS_MS,
  ): FundingHistoryResponse {
    this.pruneIfNeeded();
    const uniqueSymbols = [...new Set(symbols)];
    if (uniqueSymbols.length > this.maxRequestSymbols) {
      throw new Error(`Funding history request exceeds the ${this.maxRequestSymbols}-symbol budget`);
    }
    for (const symbol of uniqueSymbols) this.touchSymbol(symbol);
    return {
      entries: uniqueSymbols.map((symbol) => this.loadCached(symbol, requiredWindowMs)),
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Read one atomic ranking snapshot for an entire filtered market universe.
   * Unlike loadCachedMany, this never touches the background working set or
   * starts venue requests: the visible-page loader owns cache warming while a
   * global sort can cheaply compare every symbol already present in SQLite.
   */
  loadRankingSnapshot(
    symbols: readonly string[],
    requiredWindowMs = THIRTY_DAYS_MS,
  ): FundingHistoryResponse {
    this.pruneIfNeeded();
    const uniqueSymbols = [...new Set(symbols)];
    const endTime = this.now();
    return {
      entries: uniqueSymbols.map((symbol) => {
        const entry = this.readEntry(symbol, endTime, requiredWindowMs);
        if (entry.status !== 'unavailable') return entry;
        const failure = this.failures.get(symbol);
        const canWarm = typeof this.gateway.queryFundingHistory === 'function'
          && (!failure || failure.retryable);
        return canWarm || this.inFlight.has(symbol) ? { ...entry, status: 'pending' } : entry;
      }),
      fetchedAt: new Date(endTime).toISOString(),
    };
  }

  async loadSeries(
    symbols: readonly string[],
    durationMs: number,
  ): Promise<FundingHistorySeriesResponse> {
    this.pruneIfNeeded();
    const uniqueSymbols = [...new Set(symbols)];
    if (uniqueSymbols.length > this.maxRequestSymbols) {
      throw new Error(`Funding history request exceeds the ${this.maxRequestSymbols}-symbol budget`);
    }
    for (const symbol of uniqueSymbols) this.touchSymbol(symbol);
    // Unlike matrix totals, charts must not render a stale tail and then remain stale for the
    // lifetime of the page. Wait for any required tail refresh before reading the raw points.
    const entries = await Promise.all(uniqueSymbols.map(async (symbol) =>
      await this.loadFresh(symbol, durationMs)));
    const to = this.now();
    const from = to - Math.min(durationMs, THIRTY_DAYS_MS);
    return {
      entries: entries.map((entry) => ({
        symbol: entry.symbol,
        // Fresh series loads wait for missing coverage, so `pending` is exclusive to the
        // cache-first summary API and cannot escape through series data.
        status: entry.status === 'pending' ? 'unavailable' : entry.status,
        points: entry.status === 'ok'
          ? readFundingRateHistory(this.database, entry.symbol, from, to)
          : [],
        fetchedAt: entry.fetchedAt,
      })),
      from,
      to,
      fetchedAt: new Date(to).toISOString(),
    };
  }

  /**
   * Read each symbol's trailing settlements straight out of SQLite, per settlement and in
   * chronological order. Nothing here is a running total and nothing triggers an upstream
   * request: a symbol with no cached rows yields `[]` so the caller can render "no settlements
   * yet" instead of a fabricated flat history. Warming stays the job of `loadCachedMany` /
   * the background refresher.
   */
  readRecentSettlements(symbols: readonly string[], limit: number): Map<string, FundingRatePoint[]> {
    // A 1h venue settles 24× more often than an 8h one, so the lookback must scale with the
    // requested depth: `limit` days always contains at least `limit` settlements at any interval
    // up to 24h, and never reads a symbol's full retained year.
    const windowMs = Math.max(3 * ONE_DAY_MS, Math.max(1, limit) * ONE_DAY_MS);
    const endTime = this.now();
    const startTime = endTime - windowMs;
    const result = new Map<string, FundingRatePoint[]>();
    for (const symbol of [...new Set(symbols)]) {
      result.set(symbol, readFundingRateHistory(this.database, symbol, startTime, endTime));
    }
    return result;
  }

  private pruneIfNeeded(): void {
    const now = this.now();
    if (this.lastPrunedAt !== null && now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    pruneFundingRateHistory(this.database, now - this.retentionMs);
    this.lastPrunedAt = now;
  }

  private loadCached(symbol: string, requiredWindowMs: number): FundingHistoryEntry {
    const endTime = this.now();
    const coverage = readFundingHistoryCoverage(this.database, symbol);
    const coversWindow = coverage !== null && coverage.coveredFrom <= endTime - requiredWindowMs;
    const failure = this.failures.get(symbol);
    const retryAllowed = (failure?.until ?? 0) <= endTime;
    if (coversWindow) {
      if (coverage.coveredTo < endTime - this.freshMs && retryAllowed) {
        void this.refresh(symbol, requiredWindowMs).catch((error: unknown) => {
          this.warn(symbol, error instanceof Error ? error.message : 'FUNDING_BACKGROUND_ERROR');
        });
      }
      return this.readEntry(symbol, endTime, requiredWindowMs);
    }
    if (retryAllowed && typeof this.gateway.queryFundingHistory === 'function') {
      void this.refresh(symbol, requiredWindowMs).catch((error: unknown) => {
        this.warn(symbol, error instanceof Error ? error.message : 'FUNDING_BACKGROUND_ERROR');
      });
      return { ...this.readEntry(symbol, endTime, requiredWindowMs), status: 'pending' };
    }
    const entry = this.readEntry(symbol, endTime, requiredWindowMs);
    return failure?.retryable && !retryAllowed && entry.status === 'unavailable'
      ? { ...entry, status: 'pending' }
      : entry;
  }

  private load(symbol: string, requiredWindowMs: number): Promise<FundingHistoryEntry> {
    const endTime = this.now();
    const coverage = readFundingHistoryCoverage(this.database, symbol);
    const coversWindow = coverage !== null && coverage.coveredFrom <= endTime - requiredWindowMs;
    if (coversWindow) {
      if (
        coverage.coveredTo < endTime - this.freshMs
        && (this.failures.get(symbol)?.until ?? 0) <= endTime
      ) {
        // Cached totals render immediately; the next response receives the refreshed tail.
        void this.refresh(symbol, requiredWindowMs).catch((error: unknown) => {
          this.warn(symbol, error instanceof Error ? error.message : 'FUNDING_BACKGROUND_ERROR');
        });
      }
      return Promise.resolve(this.readEntry(symbol, endTime, requiredWindowMs));
    }
    return this.refresh(symbol, requiredWindowMs);
  }

  private async loadFresh(symbol: string, requiredWindowMs: number): Promise<FundingHistoryEntry> {
    const endTime = this.now();
    const coverage = readFundingHistoryCoverage(this.database, symbol);
    const coversWindow = coverage !== null && coverage.coveredFrom <= endTime - requiredWindowMs;
    const tailIsFresh = coverage !== null && coverage.coveredTo >= endTime - this.freshMs;
    if (coversWindow && tailIsFresh) return this.readEntry(symbol, endTime, requiredWindowMs);
    if ((this.failures.get(symbol)?.until ?? 0) > endTime) {
      return this.readEntry(symbol, endTime, requiredWindowMs);
    }
    await this.refresh(symbol, requiredWindowMs);
    return this.readEntry(symbol, this.now(), requiredWindowMs);
  }

  private refresh(symbol: string, requiredWindowMs: number): Promise<FundingHistoryEntry> {
    return this.refreshWithSignal(symbol, requiredWindowMs);
  }

  private refreshWithSignal(
    symbol: string,
    requiredWindowMs: number,
    signal?: AbortSignal,
  ): Promise<FundingHistoryEntry> {
    const existing = this.inFlight.get(symbol);
    if (existing) {
      return existing.then(async () => {
        const endTime = this.now();
        const coverage = readFundingHistoryCoverage(this.database, symbol);
        if (coverage && coverage.coveredFrom <= endTime - requiredWindowMs) {
          return this.readEntry(symbol, endTime, requiredWindowMs);
        }
        return await this.refreshWithSignal(symbol, requiredWindowMs, signal);
      });
    }

    const pending = this.schedule(symbol, requiredWindowMs, async () => {
      if (signal?.aborted) return this.readEntry(symbol, this.now(), requiredWindowMs);
      return await this.syncAndRead(symbol, requiredWindowMs, signal);
    })
      .finally(() => {
        if (this.inFlight.get(symbol) === pending) this.inFlight.delete(symbol);
      });
    this.inFlight.set(symbol, pending);
    return pending;
  }

  private schedule<T>(symbol: string, requiredWindowMs: number, task: () => Promise<T>): Promise<T> {
    const venue = SYMBOL_VENUE.exec(symbol)?.[1] ?? 'UNKNOWN';
    const previous = this.venueTails.get(venue) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const coverage = readFundingHistoryCoverage(this.database, symbol);
      const hasCompleteWindow = coverage !== null && coverage.coveredFrom <= this.now() - requiredWindowMs;
      const configuredSpacing = this.venueSpacingMs[venue] ?? 0;
      // A cached Hyperliquid tail returns roughly one day of hourly rows, so it consumes far
      // less weighted quota than the paginated 30-day cold backfill. A seven-day (or shorter)
      // cold window also fits the lower-cost pacing tier.
      const spacing = venue === 'HYPERLIQUID' && (hasCompleteWindow || requiredWindowMs <= SEVEN_DAYS_MS)
        ? Math.min(configuredSpacing, HYPERLIQUID_TAIL_SPACING_MS)
        : configuredSpacing;
      const waitMs = (this.venueLastStartedAt.get(venue) ?? 0) + spacing - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      this.venueLastStartedAt.set(venue, this.now());
      return await task();
    });
    const tail = run.then(() => undefined, () => undefined);
    this.venueTails.set(venue, tail);
    void tail.finally(() => {
      if (this.venueTails.get(venue) === tail) this.venueTails.delete(venue);
    });
    return run;
  }

  private refreshCachedSymbols(): Promise<void> {
    if (!this.backgroundEnabled) return Promise.resolve();
    if (this.backgroundRun) return this.backgroundRun;
    const pending = (async () => {
      this.pruneIfNeeded();
      const controller = this.backgroundController;
      const recent = [...this.recentSymbols.keys()].reverse();
      const persisted = listCachedFundingHistorySymbols(this.database, this.maxBackgroundSymbols);
      const symbols = [...new Set([...recent, ...persisted])].slice(0, this.maxBackgroundSymbols);
      const symbolsByVenue = new Map<string, string[]>();
      for (const symbol of symbols) {
        const venue = SYMBOL_VENUE.exec(symbol)?.[1] ?? 'UNKNOWN';
        const group = symbolsByVenue.get(venue) ?? [];
        group.push(symbol);
        symbolsByVenue.set(venue, group);
      }
      await Promise.all([...symbolsByVenue.values()].map(async (group) => {
        for (const symbol of group) {
          if (!this.backgroundEnabled || controller?.signal.aborted) return;
          await this.refreshWithSignal(symbol, THIRTY_DAYS_MS, controller?.signal);
        }
      }));
    })().catch((error: unknown) => {
      this.warn('BACKGROUND', error instanceof Error ? error.message : 'FUNDING_BACKGROUND_ERROR');
    }).finally(() => {
      if (this.backgroundRun === pending) this.backgroundRun = null;
    });
    this.backgroundRun = pending;
    return pending;
  }

  private async syncAndRead(
    symbol: string,
    requiredWindowMs: number,
    signal?: AbortSignal,
  ): Promise<FundingHistoryEntry> {
    const endTime = this.now();
    const startTime = endTime - requiredWindowMs;
    const coverage = readFundingHistoryCoverage(this.database, symbol);
    const coversWindow = coverage !== null && coverage.coveredFrom <= startTime;
    const tailIsFresh = coverage !== null && coverage.coveredTo >= endTime - this.freshMs;
    const retryAllowed = (this.failures.get(symbol)?.until ?? 0) <= endTime;

    if (
      retryAllowed
      && (!coversWindow || !tailIsFresh)
      && typeof this.gateway.queryFundingHistory === 'function'
    ) {
      const fetchStart = coversWindow && coverage
        ? Math.max(startTime, coverage.coveredTo - this.tailOverlapMs)
        : startTime;
      const fetchedAt = new Date(endTime).toISOString();
      try {
        const points = aggregatePoints(
          await this.gateway.queryFundingHistory(symbol, fetchStart, endTime, signal),
          fetchStart,
          endTime,
        );
        replaceFundingHistoryRange(this.database, symbol, fetchStart, endTime, points, fetchedAt);
        this.failures.delete(symbol);
      } catch (error) {
        if (signal?.aborted || (error instanceof PublicMarketDataError && error.code === 'ABORTED')) {
          return this.readEntry(symbol, endTime, requiredWindowMs);
        }
        const reason = error instanceof Error ? error.message : 'PUBLIC_DATA_ERROR';
        recordFundingHistoryFailure(this.database, symbol, fetchedAt, reason);
        this.failures.set(symbol, {
          until: endTime + this.failureCacheMs,
          retryable: isRetryablePublicMarketDataError(error),
        });
        this.warn(symbol, reason);
      }
    }

    return this.readEntry(symbol, endTime, requiredWindowMs);
  }

  private touchSymbol(symbol: string): void {
    this.recentSymbols.delete(symbol);
    this.recentSymbols.set(symbol, this.now());
    while (this.recentSymbols.size > this.maxBackgroundSymbols) {
      const oldest = this.recentSymbols.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recentSymbols.delete(oldest);
    }
  }

  private readEntry(symbol: string, endTime: number, requiredWindowMs: number): FundingHistoryEntry {
    const startTime = endTime - THIRTY_DAYS_MS;
    const coverage = readFundingHistoryCoverage(this.database, symbol);
    const hasRequiredWindow = coverage !== null && coverage.coveredFrom <= endTime - requiredWindowMs;
    if (!hasRequiredWindow) {
      return {
        symbol,
        status: 'unavailable',
        rate24h: null,
        rate7d: null,
        rate30d: null,
        settlementCount30d: 0,
        oldestFundingAt: null,
        newestFundingAt: null,
        fetchedAt: new Date(endTime).toISOString(),
      };
    }

    const points = readFundingRateHistory(this.database, symbol, startTime, endTime);
    const has24h = coverage.coveredFrom <= endTime - ONE_DAY_MS;
    const has7d = coverage.coveredFrom <= endTime - SEVEN_DAYS_MS;
    const has30d = coverage.coveredFrom <= startTime;
    const oldest = points[0];
    const newest = points[points.length - 1];
    return {
      symbol,
      status: 'ok',
      rate24h: has24h ? sumAfter(points, endTime - ONE_DAY_MS) : null,
      rate7d: has7d ? sumAfter(points, endTime - SEVEN_DAYS_MS) : null,
      rate30d: has30d ? sumAfter(points, startTime) : null,
      settlementCount30d: has30d ? points.length : 0,
      oldestFundingAt: oldest ? new Date(oldest.timestamp).toISOString() : null,
      newestFundingAt: newest ? new Date(newest.timestamp).toISOString() : null,
      fetchedAt: coverage.lastSuccessAt ?? new Date(endTime).toISOString(),
    };
  }
}
