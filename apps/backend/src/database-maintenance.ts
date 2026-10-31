import type Database from 'better-sqlite3';
import { addAuditEvent, prunePortfolioEquitySamples } from './repositories.js';
import {
  CACHE_RETENTION_MS,
  pruneExpiredCacheTables,
  type CacheRetentionResult,
} from './cache-retention.js';
import {
  DEFAULT_BACKUP_RETENTION_MONTHS,
  runMonthlyDatabaseBackup,
  type DatabaseBackupOutcome,
} from './database-backup.js';

const DAY_MS = 24 * 60 * 60_000;
const AUDIT_RETENTION_MS = 180 * DAY_MS;
const EXECUTION_RETENTION_365_MS = 365 * DAY_MS;
const MAX_AUDIT_EVENTS = 50_000;

/** Minimal logger contract; `fastify`'s pino instance satisfies it structurally. */
export interface DatabaseMaintenanceLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

export interface DatabaseMaintenanceOptions {
  /**
   * Directory for the monthly gzipped archives (default: `<dataDir>/backups`, resolved by
   * `config.ts`). Omit it and the backup step reports `backupOutcome: 'disabled'` — tests and
   * in-memory databases must never drop files on disk.
   */
  backupDirectory?: string;
  /** How many monthly archives to keep. Defaults to 12 (`DEFAULT_BACKUP_RETENTION_MONTHS`). */
  backupRetentionMonths?: number;
  /** Structured logger used for the prune/backup summary; defaults to a no-op. */
  logger?: DatabaseMaintenanceLogger;
}

export interface DatabaseMaintenanceResult {
  auditEventsDeleted: number;
  strategyLogsDeleted: number;
  fillsDeleted: number;
  ordersDeleted: number;
  portfolioEquitySamplesDeleted: number;
  /** Rows removed from the disposable cache tables by this pass (see cache-retention.ts). */
  cacheRowsDeleted: number;
  /** Same count, broken down per table (omitted tables had nothing to delete). */
  cacheRowsDeletedByTable: Record<string, number>;
  /** `created` | `existing` | `skipped` | `failed` | `disabled` (no backup directory configured). */
  backupOutcome: DatabaseBackupOutcome | 'disabled';
  /** Absolute path of this month's archive, when one exists. */
  backupFile: string | null;
  /** Compressed size of that archive in bytes. */
  backupBytes: number | null;
  /** Archive file names dropped by the 12-month retention sweep during this pass. */
  backupDeletedFiles: string[];
  /** Failure reason when `backupOutcome` is `failed`; null otherwise. */
  backupError: string | null;
  /** Moment this pass used as "now" (epoch ms); the maintenance status endpoint pairs it with the result. */
  ranAtMs: number;
}

/** Total rows deleted by one pass, across every retention rule. Used for "was anything pruned?". */
export function maintenanceDeletedRowCount(result: DatabaseMaintenanceResult): number {
  return result.auditEventsDeleted
    + result.strategyLogsDeleted
    + result.fillsDeleted
    + result.ordersDeleted
    + result.portfolioEquitySamplesDeleted
    + result.cacheRowsDeleted;
}

/**
 * Bound locally generated operational data while preserving active strategy state, and archive the
 * database once per calendar month.
 *
 * Three distinct retentions live here and must not be conflated:
 *
 * 1. **Disposable caches — 24 hours.** The operator's explicit requirement: quote caches, ranking
 *    inputs and spread samples are only useful "right now", so everything older than
 *    `CACHE_RETENTION_MS` (24h; spread samples get a documented 2h span grace) is deleted and
 *    refetched from the venue on demand. Batched deletes, outside the main transaction, so the
 *    write lock is released between batches. See `cache-retention.ts`.
 * 2. **Operational history — long windows.** Execution history is retained for a year; rows
 *    belonging to running, paused, or unresolved strategies are never selected for pruning. Equity
 *    samples are trimmed per granularity (raw 7d, hour 45d, day 730d). Audit events keep 180 days
 *    and at most 50 000 rows.
 * 3. **Exempt historical data.** `candle_cache`, `funding_rate_history` and
 *    `funding_history_coverage` are **never** touched by the 24h window: they are the data source
 *    the historical spread/funding views rebuild from, and the operator asked explicitly to keep
 *    them. They keep their own per-key bounds instead.
 *
 * The monthly archive runs *after* the transaction (SQLite refuses `VACUUM` inside one) and is
 * idempotent per calendar month, so the hourly interval can call this unconditionally.
 *
 * @param database open handle.
 * @param now reference instant in epoch milliseconds (defaults to `Date.now()`).
 * @param options backup directory / retention / logger; see `DatabaseMaintenanceOptions`.
 */
export function runDatabaseMaintenance(
  database: Database.Database,
  now = Date.now(),
  options: DatabaseMaintenanceOptions = {},
): DatabaseMaintenanceResult {
  const safeNow = Number.isFinite(now) ? Math.max(0, Math.trunc(now)) : Date.now();
  const logger = options.logger;

  // 1) Disposable caches (24h). Runs before the retention transaction and in its own short
  //    transactions so a large spread-sample backlog cannot hold the write lock.
  let cacheResult: CacheRetentionResult;
  try {
    cacheResult = pruneExpiredCacheTables(database, safeNow);
  } catch (error) {
    // A cache prune must never take the maintenance pass (or the process) down.
    logger?.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'cache retention prune failed; caches will be retried on the next pass',
    );
    cacheResult = {
      cutoffIso: new Date(Math.max(0, safeNow - CACHE_RETENTION_MS)).toISOString(),
      deletedByTable: {},
      totalDeleted: 0,
      batches: 0,
      skippedTables: [],
    };
  }

  // 2) Operational history retention, in one atomic pass.
  const auditCutoff = new Date(safeNow - AUDIT_RETENTION_MS).toISOString();
  const executionCutoff = new Date(safeNow - EXECUTION_RETENTION_365_MS).toISOString();
  const retention = database.transaction(() => {
    const expiredAudit = database.prepare('DELETE FROM audit_events WHERE created_at < ?').run(auditCutoff).changes;
    const excessAudit = database.prepare(`
      DELETE FROM audit_events WHERE id IN (
        SELECT id FROM audit_events ORDER BY created_at DESC LIMIT -1 OFFSET ?
      )
    `).run(MAX_AUDIT_EVENTS).changes;
    const strategyLogsDeleted = database.prepare(`
      DELETE FROM execution_strategy_logs
      WHERE created_at < ? AND strategy_id IN (
        SELECT id FROM execution_strategies WHERE status IN ('STOPPED', 'COMPLETED')
      )
    `).run(executionCutoff).changes;
    const eligibleOrderFilter = `
      updated_at < ?
          AND state IN (
            'FILLED',
            'CANCELLED',
            'REJECTED',
            'FAILED',
            'FAIL',
            'REMOTE_NOT_FOUND'
          )
      AND (
        strategy_id IS NULL OR strategy_id IN (
          SELECT id FROM execution_strategies WHERE status IN ('STOPPED', 'COMPLETED')
        )
      )
    `;
    const fillsDeleted = database.prepare(`
      DELETE FROM execution_fills WHERE order_id IN (
        SELECT id FROM execution_orders WHERE ${eligibleOrderFilter}
      )
    `).run(executionCutoff).changes;
    const ordersDeleted = database.prepare(`
      DELETE FROM execution_orders WHERE ${eligibleOrderFilter}
    `).run(executionCutoff).changes;
    // Nested transaction() calls become SQLite savepoints, so the equity prune joins the
    // same atomic maintenance pass.
    const portfolioEquitySamplesDeleted = prunePortfolioEquitySamples(database, safeNow);
    return {
      auditEventsDeleted: expiredAudit + excessAudit,
      strategyLogsDeleted,
      fillsDeleted,
      ordersDeleted,
      portfolioEquitySamplesDeleted,
    };
  })();

  // 3) Monthly archive (idempotent per calendar month). Skipped when no directory is configured,
  //    which is also how `:memory:` test databases stay free of file-system side effects.
  const backup = options.backupDirectory === undefined
    ? null
    : runMonthlyDatabaseBackup(database, {
      directory: options.backupDirectory,
      retentionMonths: options.backupRetentionMonths ?? DEFAULT_BACKUP_RETENTION_MONTHS,
      now: safeNow,
    });
  const backupOutcome: DatabaseBackupOutcome | 'disabled' = backup?.outcome ?? 'disabled';

  const result: DatabaseMaintenanceResult = {
    ...retention,
    cacheRowsDeleted: cacheResult.totalDeleted,
    cacheRowsDeletedByTable: { ...cacheResult.deletedByTable },
    backupOutcome,
    backupFile: backup?.filePath ?? null,
    backupBytes: backup?.sizeBytes ?? null,
    backupDeletedFiles: backup?.deletedFiles ?? [],
    backupError: backup?.error ?? null,
    ranAtMs: safeNow,
  };

  // 4) Observability: the caller logs the returned prune counters (one structured line per pass,
  //    see app.ts). This module reports the two events only it knows about — a written archive and
  //    the failures it swallowed — and records the archive in the audit trail.
  if (result.backupOutcome === 'created') {
    logger?.info(
      {
        month: backup?.month ?? null,
        file: result.backupFile,
        bytes: result.backupBytes,
        backupDeletedFiles: result.backupDeletedFiles,
      },
      'monthly database archive written',
    );
  }
  if (result.backupOutcome === 'failed') {
    logger?.warn({ error: result.backupError }, 'monthly database archive failed; retrying on the next pass');
  }
  if (result.backupOutcome === 'created' || result.backupOutcome === 'failed') {
    try {
      addAuditEvent(database, result.backupOutcome === 'created' ? 'database_backup_created' : 'database_backup_failed', {
        month: backup?.month ?? null,
        file: result.backupFile,
        bytes: result.backupBytes,
        deletedFiles: result.backupDeletedFiles,
        error: result.backupError,
      });
    } catch {
      // The audit row is a nicety; never let it fail the maintenance pass.
    }
  }
  return result;
}
