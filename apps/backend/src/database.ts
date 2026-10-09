import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DatabaseStatus {
  state: 'ok' | 'error';
  migrationCount: number;
  currentMigration: string | null;
}

interface AppliedMigration {
  id: string;
  checksum: string;
}

const CURRENT_SCHEMA_TABLES = [
  'audit_events',
  'auth_user',
  'candle_cache',
  'crossex_instruments',
  'credential_session',
  'execution_fills',
  'execution_orders',
  'execution_strategies',
  'execution_strategy_logs',
  'funding_history_coverage',
  'funding_rate_history',
  'hyperliquid_perp_metadata',
  'schema_migrations',
] as const;

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function applyMigrationDirectives(database: Database.Database, sql: string): void {
  for (const line of sql.split(/\r?\n/)) {
    const directive = /^-- @ensure-column ([a-z][a-z0-9_]*) ([a-z][a-z0-9_]*) ([A-Z][A-Z0-9_ ()']*)$/.exec(line.trim());
    if (!directive) continue;
    const [, tableName, columnName, definition] = directive;
    if (!tableName || !columnName || !definition) throw new Error(`Invalid migration directive: ${line}`);
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { name: string } | undefined;
    if (!table) throw new Error(`Migration directive references missing table ${tableName}`);
    const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === columnName)) {
      database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }
}

export function assertDatabaseIntegrity(database: Database.Database): void {
  const result = database.pragma('quick_check(1)', { simple: true });
  if (result !== 'ok') throw new Error(`SQLite integrity check failed: ${String(result)}`);
}

function assertCurrentSchema(database: Database.Database): void {
  const rows = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (${CURRENT_SCHEMA_TABLES.map(() => '?').join(', ')})
  `).all(...CURRENT_SCHEMA_TABLES) as Array<{ name: string }>;
  const present = new Set(rows.map((row) => row.name));
  const missing = CURRENT_SCHEMA_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) throw new Error(`Database schema is missing required tables: ${missing.join(', ')}`);
  const auditColumns = database.prepare('PRAGMA table_info(audit_events)').all() as Array<{ name: string }>;
  if (!auditColumns.some((column) => column.name === 'correlation_id')) {
    throw new Error('Database schema is missing audit_events.correlation_id');
  }
  const strategyColumns = database.prepare('PRAGMA table_info(execution_strategies)').all() as Array<{ name: string }>;
  for (const required of ['credential_profile_id', 'credential_profile_label']) {
    if (!strategyColumns.some((column) => column.name === required)) {
      throw new Error(`Database schema is missing execution_strategies.${required}`);
    }
  }
}

export function openDatabase(databasePath: string, migrationsDir: string): Database.Database {
  const onDisk = databasePath !== ':memory:';
  const dataDirectory = dirname(databasePath);
  if (onDisk) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
  }
  const database = new Database(databasePath);
  if (onDisk) chmodSync(databasePath, 0o600);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('wal_autocheckpoint = 1000');
  // WAL/SHM permissions derive from the owner-only database and restrictive process umask in the
  // production server. Re-assert the main file mode for databases created by older releases.
  if (onDisk) chmodSync(databasePath, 0o600);

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const migrationFiles = readdirSync(migrationsDir)
      .filter((filename) => /^\d+.*\.sql$/.test(filename))
      .sort((left, right) => left.localeCompare(right));

    for (const id of migrationFiles) {
      const sql = readFileSync(join(migrationsDir, id), 'utf8');
      const checksum = migrationChecksum(sql);
      const applied = database
        .prepare('SELECT id, checksum FROM schema_migrations WHERE id = ?')
        .get(id) as AppliedMigration | undefined;

      if (applied) {
        if (applied.checksum !== checksum) {
          throw new Error(`Applied migration ${id} does not match its recorded checksum`);
        }
        continue;
      }

      database.transaction(() => {
        applyMigrationDirectives(database, sql);
        database.exec(sql);
        database
          .prepare('INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)')
          .run(id, checksum, new Date().toISOString());
      })();
    }

    assertDatabaseIntegrity(database);
    if (migrationFiles.includes('0019_strategy_accounts.sql')) assertCurrentSchema(database);
    database.pragma('optimize');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function prepareDatabaseForClose(database: Database.Database): void {
  database.pragma('optimize');
  try {
    database.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // In-memory/test databases do not have a WAL file to checkpoint.
  }
}

export function readDatabaseStatus(database: Database.Database): DatabaseStatus {
  try {
    const result = database
      .prepare('SELECT COUNT(*) AS count, MAX(id) AS currentMigration FROM schema_migrations')
      .get() as { count: number; currentMigration: string | null };
    return { state: 'ok', migrationCount: result.count, currentMigration: result.currentMigration };
  } catch {
    return { state: 'error', migrationCount: 0, currentMigration: null };
  }
}
