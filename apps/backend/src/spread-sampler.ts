import type Database from 'better-sqlite3';
import type { SpreadOpportunity } from '@gate-crossex/shared-types';
import { pruneSpreadSamples, recordSpreadSamples, type SpreadSampleRow } from './repositories.js';
import { SPREAD_SAMPLE_RETENTION_MS } from './cache-retention.js';
import {
  MAX_SPREAD_QUALITY_CANDIDATES,
  SPREAD_SAMPLE_INTERVAL_MS,
  selectSpreadQualityCandidates,
  spreadBpsFromBook,
  type SpreadQualityCandidate,
  type SpreadQualityMarketHubView,
} from './spread-quality.js';

/**
 * Samples only back the newest 24h window the quality board reads, so they follow the shared cache
 * retention (24h plus the documented span grace) instead of keeping a private multi-day archive —
 * see `cache-retention.ts` for why the 24h window needs a small grace. The daily maintenance pass
 * enforces the same number, so there is exactly one retention story for this table.
 */
const DEFAULT_RETENTION_MS = SPREAD_SAMPLE_RETENTION_MS;
/** Pruning is a bulk DELETE, so once an hour is often enough to bound the table. */
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60_000;

export interface SpreadSamplerDependencies {
  database: Database.Database;
  /** Hub view used for both candidate depth and the sampled quotes themselves. */
  hub: SpreadQualityMarketHubView;
  /**
   * Asset-level spread board rows — every (sell venue, buy venue) combination included —
   * behind the candidate set. The opportunity board caches its own computation, so this
   * stays a cheap read even at the sampler's 30s cadence.
   */
  spreadBoard: () => Promise<readonly SpreadOpportunity[]>;
  /** Failure reporter; a tick that throws is logged and forgotten, never rethrown. */
  warn?: (reason: string) => void;
}

export interface SpreadSamplerOptions {
  /** Sampling cadence; also the bucket size every `sampled_at` is aligned to. */
  intervalMs?: number;
  /** How long samples are kept before pruning. */
  retentionMs?: number;
  /** How often pruning runs; the first tick always prunes. */
  pruneIntervalMs?: number;
  /** Candidate cap, mirroring the quality board's own cap. */
  candidateLimit?: number;
  now?: () => number;
}

/**
 * Second track of the spread-quality board's dual-source reconstruction: persists the
 * executable spread of every quality-board candidate once per 30s boundary.
 *
 * Each tick reads the (cached) spread board, selects the same candidate set the quality
 * board would rank, reads both legs' top-of-book from the hub and upserts one row per pair
 * into `spread_samples`. `sampled_at` is floored to the interval boundary and is part of the
 * primary key, so a retried tick rewrites its bucket instead of duplicating a point. Once a
 * pair accumulates a full 24h of samples the quality board rebuilds it from them
 * (`source: 'samples'`); pairs below the coverage threshold keep using venue candles.
 *
 * The background loop is self-scheduling with `setTimeout` rather than `setInterval` so every
 * tick lands on a wall-clock interval boundary (a fixed-period interval cannot phase-align
 * to the clock), runs at most one tick at a time (single-flight), and never lets a failed
 * tick escape: failures are reported through `warn` and the next boundary still fires.
 */
export class SpreadSampler {
  private readonly database: Database.Database;
  private readonly hub: SpreadQualityMarketHubView;
  private readonly spreadBoard: () => Promise<readonly SpreadOpportunity[]>;
  private readonly warn: (reason: string) => void;
  private readonly intervalMs: number;
  private readonly retentionMs: number;
  private readonly pruneIntervalMs: number;
  private readonly candidateLimit: number;
  private readonly now: () => number;
  private lastPrunedAt: number | null = null;
  private backgroundEnabled = false;
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundRun: Promise<void> | null = null;

  constructor(deps: SpreadSamplerDependencies, options: SpreadSamplerOptions = {}) {
    this.database = deps.database;
    this.hub = deps.hub;
    this.spreadBoard = deps.spreadBoard;
    this.warn = deps.warn ?? (() => undefined);
    this.intervalMs = Math.max(1_000, Math.trunc(options.intervalMs ?? SPREAD_SAMPLE_INTERVAL_MS));
    this.retentionMs = Math.max(this.intervalMs, Math.trunc(options.retentionMs ?? DEFAULT_RETENTION_MS));
    this.pruneIntervalMs = Math.max(0, Math.trunc(options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS));
    this.candidateLimit = Math.max(1, Math.trunc(options.candidateLimit ?? MAX_SPREAD_QUALITY_CANDIDATES));
    this.now = options.now ?? Date.now;
  }

  /** Sample the current candidate set once, at `nowMs`. Returns the rows written. */
  async sampleOnce(nowMs: number): Promise<number> {
    const sampledAt = Math.floor(nowMs / this.intervalMs) * this.intervalMs;
    const board = await this.spreadBoard();
    const candidates = selectSpreadQualityCandidates(board, undefined, this.hub, this.candidateLimit);
    const rows: SpreadSampleRow[] = [];
    for (const candidate of candidates) {
      const row = this.sampleCandidate(candidate, sampledAt);
      if (row !== null) rows.push(row);
    }
    const written = recordSpreadSamples(this.database, rows);
    this.pruneIfNeeded(nowMs);
    return written;
  }

  /** Start the boundary-aligned background loop; a second call while running is a no-op. */
  startBackground(): void {
    if (this.backgroundEnabled) return;
    this.backgroundEnabled = true;
    this.scheduleNextTick(this.now());
  }

  /**
   * Stop the background loop and await any in-flight tick. A tick already running finishes
   * its writes — stopping mid-transaction would leave a half-sampled bucket — but no
   * further tick is scheduled afterwards.
   */
  async stopBackground(): Promise<void> {
    this.backgroundEnabled = false;
    if (this.backgroundTimer !== null) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = null;
    await this.backgroundRun;
  }

  /** One candidate's sample row, or null when the hub cannot quote both legs right now. */
  private sampleCandidate(candidate: SpreadQualityCandidate, sampledAt: number): SpreadSampleRow | null {
    const { combination } = candidate;
    const left = this.hub.market(combination.leftSymbol);
    const right = this.hub.market(combination.rightSymbol);
    if (left === null || right === null) return null;
    const spreadBps = spreadBpsFromBook(left.bidPrice, right.askPrice);
    if (spreadBps === null) return null;
    return {
      pairType: candidate.pairType,
      asset: candidate.asset,
      leftSymbol: combination.leftSymbol,
      rightSymbol: combination.rightSymbol,
      sampledAt,
      spreadBps,
      // The candidate already carries the hub depth the quality board ranks by, so the
      // sampler records exactly that reading rather than re-deriving it.
      depthUsdt: candidate.bookDepthUsdt,
      leftPrice: finitePositive(left.bidPrice),
      rightPrice: finitePositive(right.askPrice),
    };
  }

  /** Prune at most once per `pruneIntervalMs`; the first call always prunes. */
  private pruneIfNeeded(nowMs: number): void {
    if (this.lastPrunedAt !== null && nowMs - this.lastPrunedAt < this.pruneIntervalMs) return;
    pruneSpreadSamples(this.database, nowMs - this.retentionMs);
    this.lastPrunedAt = nowMs;
  }

  /** Arm the timer for the next interval boundary at or after `fromMs`. */
  private scheduleNextTick(fromMs: number): void {
    if (!this.backgroundEnabled) return;
    const boundary = (Math.floor(fromMs / this.intervalMs) + 1) * this.intervalMs;
    const delay = Math.max(0, boundary - fromMs);
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;
      if (!this.backgroundEnabled) return;
      void this.runTick(this.now());
    }, delay);
    this.backgroundTimer.unref?.();
  }

  /**
   * Run one tick under single-flight: a boundary that fires while the previous tick is still
   * writing joins that run instead of starting a second one, and the owner schedules the
   * next boundary when it finishes. Failures are reported and swallowed — a dead board read
   * or a locked database must never take the loop down.
   */
  private runTick(nowMs: number): Promise<void> {
    if (this.backgroundRun !== null) return this.backgroundRun;
    const pending = (async () => {
      try {
        await this.sampleOnce(nowMs);
      } catch (error) {
        this.warn(`spread sampler tick failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (this.backgroundEnabled) this.scheduleNextTick(this.now());
      }
    })().finally(() => {
      if (this.backgroundRun === pending) this.backgroundRun = null;
    });
    this.backgroundRun = pending;
    return pending;
  }
}

/** Numeric value of a quote when it is usable, else null (never a fabricated zero). */
function finitePositive(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
