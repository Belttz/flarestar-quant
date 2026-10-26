import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { openDatabase } from './database.js';
import {
  BACKUP_FILE_PATTERN,
  DEFAULT_BACKUP_RETENTION_MONTHS,
  backupFileNameForMonth,
  backupMonthKey,
  extractDatabaseBackupArchive,
  listDatabaseBackupFiles,
  readDatabaseBackupStatus,
  runMonthlyDatabaseBackup,
} from './database-backup.js';
import { runDatabaseMaintenance } from './database-maintenance.js';

const migrationsDir = resolve(process.cwd(), '../../migrations');

interface Fixture {
  directory: string;
  databasePath: string;
  database: Database.Database;
}

const fixtures: Fixture[] = [];
const scratchDirectories: string[] = [];

function createFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-backup-'));
  const databasePath = join(directory, 'gate-crossex.sqlite');
  const database = openDatabase(databasePath, migrationsDir);
  const fixture = { directory, databasePath, database };
  fixtures.push(fixture);
  return fixture;
}

/** A directory that is *not* the data directory, so the test never sees leftover state. */
function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-archives-'));
  scratchDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    try {
      fixture.database.close();
    } catch {
      // Already closed by the test body.
    }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('backup naming', () => {
  it('derives a UTC calendar month and a stable file name', () => {
    expect(backupMonthKey(Date.parse('2026-07-31T23:59:59.999Z'))).toBe('2026-07');
    expect(backupMonthKey(Date.parse('2026-08-01T00:00:00.000Z'))).toBe('2026-08');
    expect(backupMonthKey(Date.parse('2026-01-05T10:00:00.000Z'))).toBe('2026-01');
    expect(backupFileNameForMonth('2026-07')).toBe('gate-crossex-2026-07.sqlite.gz');
    expect(BACKUP_FILE_PATTERN.test('gate-crossex-2026-07.sqlite.gz')).toBe(true);
    expect(BACKUP_FILE_PATTERN.test('gate-crossex-2026-13.sqlite.gz')).toBe(false);
    expect(BACKUP_FILE_PATTERN.test('notes.txt')).toBe(false);
    expect(() => backupFileNameForMonth('2026-7')).toThrow(/Invalid backup month/);
  });
});

describe('monthly database archive', () => {
  it('writes one gzipped VACUUM INTO snapshot per month and is idempotent within it', () => {
    const fixture = createFixture();
    fixture.database.prepare(`
      INSERT INTO execution_orders (
        id, client_order_id, environment, symbol, venue, side, order_type,
        time_in_force, quantity, reduce_only, state, executed_quantity, created_at, updated_at
      ) VALUES ('order-1', 'client-1', 'live', 'GATE_FUTURE_BTC_USDT', 'GATE', 'BUY', 'MARKET',
        'IOC', '1', 0, 'FILLED', '1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    `).run();
    const archives = scratchDirectory();
    const now = Date.parse('2026-07-29T12:00:00.000Z');

    const first = runMonthlyDatabaseBackup(fixture.database, { directory: archives, now });
    expect(first.outcome).toBe('created');
    expect(first.month).toBe('2026-07');
    expect(first.fileName).toBe('gate-crossex-2026-07.sqlite.gz');
    expect(first.filePath).toBe(join(archives, 'gate-crossex-2026-07.sqlite.gz'));
    expect(first.error).toBeNull();
    expect(first.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(first.filePath as string)).toBe(true);

    // Second run in the same month: no new file, same reported size.
    const second = runMonthlyDatabaseBackup(fixture.database, { directory: archives, now: now + 60_000 });
    expect(second.outcome).toBe('existing');
    expect(second.sizeBytes).toBe(first.sizeBytes);
    expect(readdirSync(archives).filter((name) => name.endsWith('.sqlite.gz'))).toHaveLength(1);
    // No temp artifacts are left behind.
    expect(readdirSync(archives).filter((name) => name.includes('.tmp-') || name.endsWith('.vacuum'))).toHaveLength(0);
  });

  it('produces an archive that decompresses into a readable SQLite database', () => {
    const fixture = createFixture();
    fixture.database.prepare(`
      INSERT INTO user_preferences (key, value_json, updated_at)
      VALUES ('theme', '"dark"', '2026-07-01T00:00:00.000Z')
    `).run();
    const archives = scratchDirectory();
    const extractDirectory = scratchDirectory();

    const result = runMonthlyDatabaseBackup(fixture.database, { directory: archives, now: Date.parse('2026-07-02T00:00:00.000Z') });
    expect(result.outcome).toBe('created');

    // The payload really is gzip with the SQLite header inside (not a copied WAL file).
    const raw = gunzipSync(readFileSync(result.filePath as string));
    expect(raw.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000');

    const extracted = extractDatabaseBackupArchive(result.filePath as string, join(extractDirectory, 'restored.sqlite'));
    expect(extracted).not.toBeNull();
    const restored = new Database(extracted as string, { readonly: true });
    try {
      expect(restored.pragma('quick_check(1)', { simple: true })).toBe('ok');
      const rows = restored.prepare('SELECT key, value_json FROM user_preferences').all();
      expect(rows).toEqual([{ key: 'theme', value_json: '"dark"' }]);
      // The full schema travels with the snapshot.
      const tables = restored.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toContain('execution_orders');
    } finally {
      restored.close();
    }
  });

  it('keeps the newest 12 monthly archives and deletes only its own older files', () => {
    const fixture = createFixture();
    const archives = scratchDirectory();
    // 14 months of pre-existing archives plus two files this tool must never touch.
    for (const month of [
      '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07',
    ]) {
      writeFileSync(join(archives, backupFileNameForMonth(month)), Buffer.from('stub'));
    }
    writeFileSync(join(archives, 'operator-notes.txt'), Buffer.from('keep me'));
    writeFileSync(join(archives, 'gate-crossex-2024-01.sqlite'), Buffer.from('keep me too'));

    const result = runMonthlyDatabaseBackup(fixture.database, {
      directory: archives,
      now: Date.parse('2026-07-15T00:00:00.000Z'),
      retentionMonths: DEFAULT_BACKUP_RETENTION_MONTHS,
    });

    expect(result.outcome).toBe('existing');
    // 2025-06 and 2025-07 fall outside the newest 12 months.
    expect(result.deletedFiles.sort()).toEqual(['gate-crossex-2025-06.sqlite.gz', 'gate-crossex-2025-07.sqlite.gz']);
    const remaining = listDatabaseBackupFiles(archives);
    expect(remaining).toHaveLength(12);
    expect(remaining[0]?.month).toBe('2026-07');
    expect(remaining[remaining.length - 1]?.month).toBe('2025-08');
    // Unrelated files are untouched: the pattern match is strict.
    expect(existsSync(join(archives, 'operator-notes.txt'))).toBe(true);
    expect(existsSync(join(archives, 'gate-crossex-2024-01.sqlite'))).toBe(true);

    const status = readDatabaseBackupStatus(archives, DEFAULT_BACKUP_RETENTION_MONTHS);
    expect(status.count).toBe(12);
    expect(status.latest?.fileName).toBe('gate-crossex-2026-07.sqlite.gz');
    expect(status.retentionMonths).toBe(12);
  });

  it('honours a custom retention count', () => {
    const fixture = createFixture();
    const archives = scratchDirectory();
    for (const month of ['2026-04', '2026-05', '2026-06', '2026-07']) {
      writeFileSync(join(archives, backupFileNameForMonth(month)), Buffer.from('stub'));
    }
    const result = runMonthlyDatabaseBackup(fixture.database, {
      directory: archives,
      now: Date.parse('2026-07-15T00:00:00.000Z'),
      retentionMonths: 2,
    });
    expect(result.outcome).toBe('existing');
    expect(result.deletedFiles.sort()).toEqual(['gate-crossex-2026-04.sqlite.gz', 'gate-crossex-2026-05.sqlite.gz']);
    expect(listDatabaseBackupFiles(archives).map((file) => file.month)).toEqual(['2026-07', '2026-06']);
  });

  it('reports failure without throwing and without leaving partial files', () => {
    const fixture = createFixture();
    // A file where the archive directory should be: mkdirSync fails and the pass must survive.
    const blocker = join(scratchDirectory(), 'blocked');
    writeFileSync(blocker, Buffer.from('not a directory'));

    const result = runMonthlyDatabaseBackup(fixture.database, {
      directory: blocker,
      now: Date.parse('2026-07-15T00:00:00.000Z'),
    });
    expect(result.outcome).toBe('failed');
    expect(result.error).not.toBeNull();
    expect(result.filePath).toBeNull();
  });

  it('skips in-memory databases so tests never write archives', () => {
    const database = new Database(':memory:');
    try {
      const result = runMonthlyDatabaseBackup(database, {
        directory: scratchDirectory(),
        now: Date.parse('2026-07-15T00:00:00.000Z'),
      });
      expect(result.outcome).toBe('skipped');
      expect(result.error).toBeNull();
    } finally {
      database.close();
    }
  });
});

describe('monthly archive inside the maintenance pass', () => {
  it('reports created/existing and surfaces a status-ready result', () => {
    const fixture = createFixture();
    const archives = scratchDirectory();
    const now = Date.parse('2026-09-03T08:00:00.000Z');

    const first = runDatabaseMaintenance(fixture.database, now, { backupDirectory: archives });
    expect(first.backupOutcome).toBe('created');
    expect(first.backupFile).toBe(join(archives, 'gate-crossex-2026-09.sqlite.gz'));
    expect(first.backupBytes).toBeGreaterThan(0);
    expect(first.backupError).toBeNull();
    // The archive is auditable: one event, one row.
    const audit = fixture.database
      .prepare("SELECT type FROM audit_events WHERE type LIKE 'database_backup%'")
      .all() as Array<{ type: string }>;
    expect(audit).toEqual([{ type: 'database_backup_created' }]);

    const second = runDatabaseMaintenance(fixture.database, now + 60_000, { backupDirectory: archives });
    expect(second.backupOutcome).toBe('existing');
    const status = readDatabaseBackupStatus(archives, DEFAULT_BACKUP_RETENTION_MONTHS);
    expect(status.latest?.month).toBe('2026-09');
    expect(status.latest?.sizeBytes).toBe(first.backupBytes);
  });

  it('reports the archive step as disabled when no directory is configured', () => {
    const fixture = createFixture();
    const result = runDatabaseMaintenance(fixture.database, Date.parse('2026-09-03T08:00:00.000Z'));
    expect(result.backupOutcome).toBe('disabled');
    expect(result.backupFile).toBeNull();
  });
});
