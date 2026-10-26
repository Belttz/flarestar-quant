import type Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Monthly archival of the local SQLite database.
 *
 * The operator's requirement: "把交易记录、历史记录什么的，就是账户所产生的这些信息，每一个月打
 * 一次包备份起来，不要都堆在一起" — everything the account produced is packed up once per
 * calendar month into a single gzipped snapshot instead of living forever in one growing file.
 *
 * Design decisions (documented in `docs/data-retention-and-backups.md`):
 * - **`VACUUM INTO`, not a file copy.** The live database runs in WAL mode and is being written
 *   while the backup runs; copying `-wal`/`-shm` by hand produces torn snapshots. `VACUUM INTO`
 *   writes a transactionally consistent, already-compacted copy (and it leaves temp file names
 *   that can be verified before the atomic rename).
 * - **One file per calendar month** (`gate-crossex-YYYY-MM.sqlite.gz`, UTC month boundaries),
 *   produced by the first maintenance pass of that month. Re-running in the same month is a no-op,
 *   so the daily safety pass can call this unconditionally.
 * - **Keep the newest 12 months**, delete older *own* backups only (the file-name pattern is
 *   matched exactly, so nothing else in the directory is ever removed).
 * - **Never fatal**: every failure is captured into the result and reported by the caller; the
 *   maintenance pass and the trading process keep running, and the next pass retries.
 */

/** How many monthly archives are kept by default. */
export const DEFAULT_BACKUP_RETENTION_MONTHS = 12;

/** File-name contract: `gate-crossex-YYYY-MM.sqlite.gz`. Only these files are ever deleted. */
export const BACKUP_FILE_PATTERN = /^gate-crossex-(\d{4})-(0[1-9]|1[0-2])\.sqlite\.gz$/;

/** Base name of the archived database; mirrors `BackendConfig.databasePath`. */
const BACKUP_FILE_STEM = 'gate-crossex';

/** What happened during one backup attempt. */
export type DatabaseBackupOutcome =
  /** A new archive for this month was written. */
  | 'created'
  /** The archive for this month already existed; nothing was written. */
  | 'existing'
  /** Nothing to archive (in-memory or unnamed database). */
  | 'skipped'
  /** The attempt failed; `error` explains why and nothing was left behind. */
  | 'failed';

export interface DatabaseBackupOptions {
  /** Directory the archives live in. Created (mode 0700) on first use. */
  directory: string;
  /** How many monthly archives to keep; defaults to `DEFAULT_BACKUP_RETENTION_MONTHS`. */
  retentionMonths?: number;
  /** Reference point in epoch milliseconds; defaults to `Date.now()`. */
  now?: number;
}

export interface DatabaseBackupResult {
  outcome: DatabaseBackupOutcome;
  /** `YYYY-MM` of the archive this run addressed, or null when nothing was addressed. */
  month: string | null;
  /** File name (`gate-crossex-YYYY-MM.sqlite.gz`) when a file exists for `month`. */
  fileName: string | null;
  /** Absolute path of that file. */
  filePath: string | null;
  /** Compressed size in bytes of that file. */
  sizeBytes: number | null;
  /** File names removed by the 12-month retention sweep during this run. */
  deletedFiles: string[];
  /** Human-readable failure reason; null on success. */
  error: string | null;
}

/** One archive present on disk. */
export interface DatabaseBackupFileInfo {
  month: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  /** File modification time in epoch milliseconds. */
  modifiedAtMs: number;
}

/** Snapshot of what is currently on disk — surfaced by the maintenance status endpoint. */
export interface DatabaseBackupStatus {
  directory: string;
  retentionMonths: number;
  count: number;
  /** Newest archive (highest month), or null when the directory is empty/missing. */
  latest: DatabaseBackupFileInfo | null;
  /** All archives, newest month first. */
  files: DatabaseBackupFileInfo[];
}

/**
 * `YYYY-MM` of `nowMs` in UTC.
 *
 * UTC is deliberate: the archive boundary must not move with the host timezone or with DST, so a
 * machine that travels between zones can never re-create (or skip) a month.
 */
export function backupMonthKey(nowMs: number): string {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const date = new Date(Math.max(0, Math.trunc(safeNow)));
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${year}-${month}`;
}

/** File name of one month's archive. Throws for a malformed month so a typo cannot touch the FS. */
export function backupFileNameForMonth(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Invalid backup month: ${month}`);
  return `${BACKUP_FILE_STEM}-${month}.sqlite.gz`;
}

/** Months sorted newest-first helper: a higher `YYYY-MM` sorts after a lower one lexicographically. */
function byMonthDescending(left: string, right: string): number {
  return right.localeCompare(left);
}

/** List the archives of `directory`, newest month first. A missing directory is an empty list. */
export function listDatabaseBackupFiles(directory: string): DatabaseBackupFileInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const files: DatabaseBackupFileInfo[] = [];
  for (const fileName of entries) {
    const match = BACKUP_FILE_PATTERN.exec(fileName);
    if (!match) continue;
    const month = `${match[1]}-${match[2]}`;
    const filePath = join(directory, fileName);
    try {
      const stats = statSync(filePath);
      // Only regular files are considered archives; a same-named directory is left alone.
      if (!stats.isFile()) continue;
      files.push({ month, fileName, filePath, sizeBytes: stats.size, modifiedAtMs: stats.mtimeMs });
    } catch {
      // A file that vanished between readdir and stat is simply not reported.
      continue;
    }
  }
  return files.sort((left, right) => byMonthDescending(left.month, right.month));
}

/**
 * Delete archives beyond the retention window. Only files matching `BACKUP_FILE_PATTERN` are ever
 * candidates, so unrelated files in the directory are safe.
 *
 * @returns the file names that were deleted (already-sorted newest month first).
 */
function pruneOldBackups(directory: string, retentionMonths: number): string[] {
  const safeRetention = Math.max(1, Math.trunc(retentionMonths));
  const files = listDatabaseBackupFiles(directory);
  const deleted: string[] = [];
  for (const file of files.slice(safeRetention)) {
    try {
      unlinkSync(file.filePath);
      deleted.push(file.fileName);
    } catch {
      // A locked/removed file is retried on the next pass; retention is best effort.
      continue;
    }
  }
  return deleted;
}

/** Best-effort removal of a partially written temp artifact. */
function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Nothing to clean up (or it is already gone).
  }
}

/**
 * Create this month's archive if it does not exist yet, then enforce the retention window.
 *
 * The whole body is defensive: a backup failure is reported through the returned `outcome`/`error`
 * and never thrown, because it runs inside the daily maintenance pass of a live trading process.
 */
export function runMonthlyDatabaseBackup(
  database: Database.Database,
  options: DatabaseBackupOptions,
): DatabaseBackupResult {
  const now = Number.isFinite(options.now) ? (options.now as number) : Date.now();
  const retentionMonths = Math.max(1, Math.trunc(options.retentionMonths ?? DEFAULT_BACKUP_RETENTION_MONTHS));
  const directory = options.directory;
  const skipped = (error: string | null): DatabaseBackupResult => ({
    outcome: error === null ? 'skipped' : 'failed',
    month: null,
    fileName: null,
    filePath: null,
    sizeBytes: null,
    deletedFiles: [],
    error,
  });

  if (typeof directory !== 'string' || directory.trim() === '') {
    return skipped('backup directory is not configured');
  }
  const databaseFile = typeof database.name === 'string' ? database.name : '';
  if (databaseFile === '' || databaseFile === ':memory:') {
    // Nothing durable to archive (in-memory or anonymous database, e.g. tests).
    return skipped(null);
  }

  const month = backupMonthKey(now);
  const fileName = backupFileNameForMonth(month);
  const filePath = join(directory, fileName);
  let vacuumPath: string | null = null;
  let gzipPath: string | null = null;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(filePath)) {
      // Idempotent: the month already has its archive. Still enforce the retention window, since
      // a long-running install may only ever hit this branch after the first day of the month.
      const sizeBytes = statSync(filePath).size;
      return {
        outcome: 'existing',
        month,
        fileName,
        filePath,
        sizeBytes,
        deletedFiles: pruneOldBackups(directory, retentionMonths),
        error: null,
      };
    }

    // 1) Consistent snapshot of the live (WAL) database. Unique temp names keep two racing passes
    //    from fighting over the same intermediate file.
    const unique = `${process.pid}-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`;
    vacuumPath = join(directory, `.${fileName}.${unique}.vacuum`);
    database.prepare('VACUUM INTO ?').run(vacuumPath);
    const raw = readFileSync(vacuumPath);

    // 2) gzip it. The database is a local single-user terminal (tens of MB), so a synchronous
    //    compress at most once per month — on the first maintenance pass of the month — is cheaper
    //    than the queueing an async pipeline would need against a synchronous maintenance pass.
    const compressed = gzipSync(raw, { level: 6 });

    // 3) Publish atomically: write a temp file, then rename over the final name.
    gzipPath = `${filePath}.tmp-${unique}`;
    writeFileSync(gzipPath, compressed, { mode: 0o600 });
    renameSync(gzipPath, filePath);
    gzipPath = null;

    return {
      outcome: 'created',
      month,
      fileName,
      filePath,
      sizeBytes: compressed.byteLength,
      deletedFiles: pruneOldBackups(directory, retentionMonths),
      error: null,
    };
  } catch (error) {
    return skipped(error instanceof Error ? error.message : String(error));
  } finally {
    if (gzipPath !== null) removeQuietly(gzipPath);
    if (vacuumPath !== null) removeQuietly(vacuumPath);
  }
}

/**
 * Report what is on disk. Used by `GET /api/maintenance/status` so the operator can see the last
 * backup time, file and size without reading the log.
 */
export function readDatabaseBackupStatus(
  directory: string,
  retentionMonths: number = DEFAULT_BACKUP_RETENTION_MONTHS,
): DatabaseBackupStatus {
  const files = typeof directory === 'string' && directory.trim() !== ''
    ? listDatabaseBackupFiles(directory)
    : [];
  return {
    directory,
    retentionMonths: Math.max(1, Math.trunc(retentionMonths)),
    count: files.length,
    latest: files[0] ?? null,
    files,
  };
}

/**
 * Decompress one archive into a temporary `.sqlite` file so it can be opened and inspected.
 *
 * This is the recovery entry point: `gunzip` the payload, then open it with any SQLite client.
 * Returns the path of the extracted file, or null when the archive cannot be decompressed.
 */
export function extractDatabaseBackupArchive(archivePath: string, targetPath: string): string | null {
  try {
    const compressed = readFileSync(archivePath);
    const raw = gunzipSync(compressed);
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    writeFileSync(targetPath, raw, { mode: 0o600 });
    return targetPath;
  } catch {
    return null;
  }
}
