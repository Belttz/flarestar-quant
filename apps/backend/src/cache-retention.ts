import type Database from 'better-sqlite3';

/**
 * Retention policy for the *disposable* half of the local database: quote caches, ranking /
 * opportunity inputs and the sampling tables that only ever back "how things look right now".
 *
 * ## Why 24 hours
 * The operator's explicit requirement is that transient data must not pile up: "像是资金费率排行
 * 啊，还有什么即时的价差排行之类的，只保留 24 小时即时的就行，然后那些其他的缓存的就可以把
 * 它清掉了，到时候再获取即时的新的或者历史的". So every table listed in
 * `CACHE_RETENTION_TABLES` keeps **at most the newest 24 hours** (spread samples get a small
 * documented grace, see `SPREAD_SAMPLE_GRACE_MS`; `portfolio_snapshots` additionally keeps its
 * single newest row so a long-idle terminal still paints on the first frame) and is re-fetched from
 * the venue on demand.
 *
 * ## What is *not* in this list — and why
 * `CACHE_RETENTION_EXEMPT_TABLES` below is the other half of the user's rule: K-line candles and
 * funding-rate history are the *source data* behind the historical spread / funding views, so they
 * must survive far longer than 24h and are never deleted by this module. Business rows (strategies,
 * orders, fills, positions, balances, preferences, credentials) are never deleted here either.
 */

/** One day in milliseconds — the retention window the operator asked for. */
export const DAY_MS = 24 * 60 * 60_000;

/**
 * The user-facing cache window: quote caches, ranking inputs and spread samples older than this
 * are disposable. Do not "optimise" this down to hours or up to days without the operator.
 */
export const CACHE_RETENTION_MS = DAY_MS;

/**
 * Extra grace applied to `spread_samples` on top of the 24h window.
 *
 * The spread-quality board only promotes a pair to its `samples` source when the retained sample
 * series *spans a full 24h* (`SPREAD_QUALITY_WINDOW_MS`, spread-quality.ts). A strict 24h cutoff
 * can only ever leave a span strictly shorter than 24h — the oldest surviving row is at or after
 * `now − 24h` — which would silently switch that source off. Two hours of grace keeps the retained
 * span above the window while still honouring "keep roughly the last day, not a growing archive".
 */
export const SPREAD_SAMPLE_GRACE_MS = 2 * 60 * 60_000;

/** Effective retention for `spread_samples`: the 24h cache window plus the span grace. */
export const SPREAD_SAMPLE_RETENTION_MS = CACHE_RETENTION_MS + SPREAD_SAMPLE_GRACE_MS;

/** How many rows one DELETE statement may remove, so a maintenance pass never holds the write lock. */
export const CACHE_PRUNE_BATCH_SIZE = 500;

/**
 * Safety valve: the number of batches one table may consume in a single pass. Together with
 * `CACHE_PRUNE_BATCH_SIZE` it bounds a pass to 50 000 rows per table per run, which keeps the
 * event loop responsive; the next daily pass continues from where this one stopped (the prune is
 * idempotent — it always re-selects "rows older than the cutoff").
 */
export const CACHE_PRUNE_MAX_BATCHES_PER_TABLE = 100;

/** Storage format of the timestamp a retention rule compares against. */
export type CacheRetentionTimestamp = 'epoch-ms' | 'iso';

/** One disposable table plus the rule that decides which of its rows have expired. */
export interface CacheRetentionRule {
  /** Table name; it must exist in `migrations/` (missing tables are skipped, never fatal). */
  readonly table: string;
  /** Column holding the row's own timestamp. */
  readonly column: string;
  /** How that column stores time: integer epoch milliseconds or ISO-8601 text. */
  readonly timestamp: CacheRetentionTimestamp;
  /** How long a row stays useful, measured from `now`. */
  readonly retentionMs: number;
  /**
   * When true the newest row of the table is never deleted, even if it is older than the window.
   *
   * Used by `portfolio_snapshots`: it is the cache behind the cold-start portfolio paint, and a
   * terminal that was closed for more than a day would otherwise boot with no snapshot at all and
   * show an empty asset page until the first live refresh lands. Keeping exactly one row satisfies
   * "only the last 24h of *instant* data" (nothing accumulates) while removing that cold-start gap.
   */
  readonly keepNewest?: boolean;
  /** Human-readable justification, also rendered by `docs/data-retention-and-backups.md`. */
  readonly reason: string;
}

/**
 * Tables pruned by the daily maintenance pass. Every entry is *reconstructible from upstream*, so
 * deleting an expired row costs at most one re-fetch.
 */
export const CACHE_RETENTION_TABLES: readonly CacheRetentionRule[] = [
  {
    table: 'spread_samples',
    column: 'sampled_at',
    timestamp: 'epoch-ms',
    retentionMs: SPREAD_SAMPLE_RETENTION_MS,
    reason:
      '30s executable-spread samples; the quality board only ever reads the newest 24h window '
      + '(2h grace keeps the promotion span above 24h).',
  },
  {
    table: 'public_market_snapshots',
    column: 'fetched_at',
    timestamp: 'iso',
    retentionMs: CACHE_RETENTION_MS,
    reason:
      'Per-symbol venue quote snapshot cache (/api/crossex/instruments/:symbol/market-snapshot); '
      + 'a stale snapshot is refetched from the venue instead of being served.',
  },
  {
    table: 'portfolio_snapshots',
    column: 'fetched_at',
    timestamp: 'iso',
    retentionMs: CACHE_RETENTION_MS,
    // Decision (approved by the operator's reviewer): keep one row no matter how old it is, so a
    // terminal that idled for weeks still paints the last known account state on the first frame.
    keepNewest: true,
    reason:
      'Whole-document account snapshots behind the cold-start portfolio paint; equity history '
      + 'lives in portfolio_equity_samples, so anything older than a day is dead weight — except '
      + 'the newest row, which is kept as the cold-start fallback.',
  },
] as const;

/**
 * Tables that look cache-shaped but are deliberately **not** pruned by the 24h window. Each entry
 * records the reason so a future reader does not "fix" the omission into a trading outage.
 */
export const CACHE_RETENTION_EXEMPT_TABLES: readonly { table: string; reason: string }[] = [
  {
    table: 'candle_cache',
    reason:
      'K-line history — explicitly exempt per the operator: it is the data source the historical '
      + 'spread views rebuild from. Already bounded per (symbol, interval): newest 500 candles.',
  },
  {
    table: 'funding_rate_history',
    reason:
      'Realized funding settlements — explicitly exempt for the same reason; it backs the funding '
      + 'history/ranking views and is refetched incrementally only for missing ranges.',
  },
  {
    table: 'funding_history_coverage',
    reason:
      'Contiguous-coverage bookkeeping for funding_rate_history; deleting it would re-download the '
      + 'entire history. Trimmed only together with the history itself (funding-history.ts).',
  },
  {
    table: 'crossex_instruments',
    reason:
      'Instrument catalog (min size / lot / tick size). Load bearing for order sizing and close '
      + 'plans: wiping it would block trading until the next venue sync. Bounded by the venue '
      + 'symbol list and refreshed as one atomic replace, so it cannot accumulate.',
  },
  {
    table: 'crossex_risk_tiers',
    reason:
      'Per-symbol leverage tiers; replaced per symbol on demand and needed by market orders.',
  },
  {
    table: 'hyperliquid_perp_metadata',
    reason: 'Single-row native-name mapping; bounded by definition (singleton = 1).',
  },
  {
    table: 'market_data_sync',
    reason: 'One freshness row per upstream source; bounded by definition.',
  },
  {
    table: 'reconciliation_reports',
    reason:
      'Reconciliation history the operator asked to have backed up monthly rather than discarded; '
      + 'already bounded to the newest 100 reports on write.',
  },
  {
    table: 'portfolio_equity_samples',
    reason:
      'Equity curve history; keeps its own tiered retention (raw 7d / hour 45d / day 730d) so the '
      + '7d/30d charts survive far longer than a day.',
  },
  {
    table: 'audit_events',
    reason: 'Audit trail: 180-day window plus a 50 000-row cap, owned by the existing pass.',
  },
] as const;

/** Row counts removed by one prune pass, per table, plus the totals used for logging. */
export interface CacheRetentionResult {
  /** ISO-8601 timestamp of the newest point this pass treated as expired. */
  readonly cutoffIso: string;
  /** Deleted rows keyed by table name; tables with nothing to delete are omitted. */
  readonly deletedByTable: Readonly<Record<string, number>>;
  /** Sum of `deletedByTable`. */
  readonly totalDeleted: number;
  /** Number of DELETE statements executed (batching telemetry). */
  readonly batches: number;
  /** Tables listed in a rule but absent from this database (legacy/partial schemas). */
  readonly skippedTables: readonly string[];
}

export interface CacheRetentionOptions {
  /** Batch size override; defaults to `CACHE_PRUNE_BATCH_SIZE`. Tests use a tiny value. */
  batchSize?: number;
  /** Per-table batch cap override; defaults to `CACHE_PRUNE_MAX_BATCHES_PER_TABLE`. */
  maxBatchesPerTable?: number;
  /** Rule override; defaults to `CACHE_RETENTION_TABLES`. */
  rules?: readonly CacheRetentionRule[];
}

/** True when `table` exists. Keeps the pass safe against partially migrated databases. */
function tableExists(database: Database.Database, table: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

/**
 * Rowid of the table's newest row by `column` (then rowid), or null when the table is empty.
 * Used by `keepNewest` rules to carve that one row out of the delete set.
 */
function newestRowId(database: Database.Database, rule: CacheRetentionRule): number | null {
  const row = database
    .prepare(`SELECT rowid AS row_id FROM ${rule.table} ORDER BY ${rule.column} DESC, rowid DESC LIMIT 1`)
    .get() as { row_id: number } | undefined;
  return row?.row_id ?? null;
}

/**
 * Delete one table's expired rows in bounded batches.
 *
 * Each batch is its own implicit transaction, so the SQLite write lock is released between
 * batches and a concurrent writer (order insert, snapshot save) is never starved. The statement is
 * idempotent: it always re-selects "rows older than `cutoff`", so an interrupted pass simply
 * continues on the next run.
 *
 * For `keepNewest` rules the newest row's rowid is resolved once per pass and excluded from every
 * batch, so the "one row always survives" guarantee cannot be broken by a batch boundary.
 *
 * @returns number of rows deleted, or `null` when the table does not exist.
 */
function pruneTableInBatches(
  database: Database.Database,
  rule: CacheRetentionRule,
  cutoff: number,
  batchSize: number,
  maxBatches: number,
  onBatch: () => void,
): number | null {
  if (!tableExists(database, rule.table)) return null;
  const keepRowId = rule.keepNewest === true ? newestRowId(database, rule) : null;
  // Only these constant table/column names reach the SQL text; every value is always bound.
  const statement = keepRowId === null
    ? database.prepare(`
      DELETE FROM ${rule.table} WHERE rowid IN (
        SELECT rowid FROM ${rule.table} WHERE ${rule.column} < ? ORDER BY rowid LIMIT ?
      )
    `)
    : database.prepare(`
      DELETE FROM ${rule.table} WHERE rowid IN (
        SELECT rowid FROM ${rule.table} WHERE ${rule.column} < ? AND rowid <> ?
        ORDER BY rowid LIMIT ?
      )
    `);
  const cutoffValue: number | string = rule.timestamp === 'iso'
    ? new Date(cutoff).toISOString()
    : Math.trunc(cutoff);
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const changes = keepRowId === null
      ? statement.run(cutoffValue, batchSize).changes
      : statement.run(cutoffValue, keepRowId, batchSize).changes;
    onBatch();
    deleted += changes;
    // A short batch means the table ran dry; stop instead of issuing another no-op DELETE.
    if (changes < batchSize) break;
  }
  return deleted;
}

/**
 * Prune every disposable cache table to its retention window (24h by default, per the operator's
 * requirement). Batched, idempotent, and never throws for a missing table.
 *
 * @param database open database handle.
 * @param nowMs reference point; the default is `Date.now()`.
 * @param options batch/rule overrides (tests).
 */
export function pruneExpiredCacheTables(
  database: Database.Database,
  nowMs: number = Date.now(),
  options: CacheRetentionOptions = {},
): CacheRetentionResult {
  const safeNow = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : 0;
  const rules = options.rules ?? CACHE_RETENTION_TABLES;
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? CACHE_PRUNE_BATCH_SIZE));
  const maxBatches = Math.max(1, Math.trunc(options.maxBatchesPerTable ?? CACHE_PRUNE_MAX_BATCHES_PER_TABLE));
  const deletedByTable: Record<string, number> = {};
  const skippedTables: string[] = [];
  let totalDeleted = 0;
  let batches = 0;
  let oldestCutoff = safeNow;
  for (const rule of rules) {
    const retentionMs = Number.isFinite(rule.retentionMs) ? Math.max(0, rule.retentionMs) : CACHE_RETENTION_MS;
    const cutoff = safeNow - retentionMs;
    oldestCutoff = Math.min(oldestCutoff, cutoff);
    let deleted: number | null;
    try {
      deleted = pruneTableInBatches(database, rule, cutoff, batchSize, maxBatches, () => {
        batches += 1;
      });
    } catch {
      // A cache prune must never break the maintenance pass or the trading process.
      skippedTables.push(rule.table);
      continue;
    }
    if (deleted === null) {
      skippedTables.push(rule.table);
      continue;
    }
    if (deleted > 0) {
      deletedByTable[rule.table] = deleted;
      totalDeleted += deleted;
    }
  }
  return {
    cutoffIso: new Date(Math.max(0, oldestCutoff)).toISOString(),
    deletedByTable,
    totalDeleted,
    batches,
    skippedTables,
  };
}
