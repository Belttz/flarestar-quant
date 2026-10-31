import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from './database.js';
import {
  CACHE_RETENTION_MS,
  CACHE_RETENTION_TABLES,
  DAY_MS,
  FUNDING_ARB_REJECT_RETENTION_MS,
  SPREAD_SAMPLE_RETENTION_MS,
  pruneExpiredCacheTables,
} from './cache-retention.js';
import { runDatabaseMaintenance } from './database-maintenance.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const migrationsDir = resolve(process.cwd(), '../../migrations');

const openedDatabases: Database.Database[] = [];

function open(): Database.Database {
  const database = openDatabase(':memory:', migrationsDir);
  openedDatabases.push(database);
  return database;
}

afterEach(() => {
  for (const database of openedDatabases.splice(0)) database.close();
});

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function insertSpreadSample(database: Database.Database, sampledAt: number): void {
  database.prepare(`
    INSERT INTO spread_samples (pair_type, asset, left_symbol, right_symbol, sampled_at, spread_bps, depth_usdt)
    VALUES ('SPOT_PERP', 'BTC', 'GATE_FUTURE_BTC_USDT', 'BINANCE_FUTURE_BTC_USDT', ?, 12.5, 1000)
  `).run(sampledAt);
}

function insertPublicSnapshot(database: Database.Database, symbol: string, fetchedAt: string): void {
  database.prepare(`
    INSERT INTO public_market_snapshots (
      symbol, venue, product, bid_price, ask_price, last_price, mark_price, index_price,
      funding_rate, predicted_funding_rate, next_funding_at, source_timestamp, fetched_at, source
    ) VALUES (?, 'BINANCE', 'FUTURE', '1', '2', '1.5', '1.5', '1.5',
      '0.0001', NULL, ?, ?, ?, 'public')
  `).run(symbol, fetchedAt, fetchedAt, fetchedAt);
}

function insertPortfolioSnapshot(database: Database.Database, id: string, fetchedAt: string): void {
  database.prepare(`
    INSERT INTO portfolio_snapshots (id, fetched_at, remote_updated_at, payload_json)
    VALUES (?, ?, ?, '{}')
  `).run(id, fetchedAt, fetchedAt);
}

function insertFundingArbDecision(
  database: Database.Database,
  id: string,
  scannedAt: string,
  verdict: string,
  strategyId: string | null,
): void {
  database.prepare(`
    INSERT INTO funding_arb_decisions (
      id, scanned_at, candidate_key, verdict, reasons_json, payload_json, strategy_id, created_at
    ) VALUES (?, ?, 'BINANCE_FUTURE_BTC_USDT:OKX_FUTURE_BTC_USDT', ?, '[]', '{}', ?, ?)
  `).run(id, scannedAt, verdict, strategyId, scannedAt);
}

function count(database: Database.Database, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

describe('cache retention window', () => {
  it('uses the 24h window the operator asked for', () => {
    expect(CACHE_RETENTION_MS).toBe(24 * 60 * 60_000);
    expect(CACHE_RETENTION_MS).toBe(DAY_MS);
    // Spread samples carry a documented grace so the quality board can still see a full 24h span.
    // SpreadSampler imports this same constant as its own default, so pinning the value here pins
    // both the maintenance pass and the sampler's hourly sweep.
    expect(SPREAD_SAMPLE_RETENTION_MS).toBe(26 * 60 * 60_000);
    expect(SPREAD_SAMPLE_RETENTION_MS).toBeGreaterThan(CACHE_RETENTION_MS);
    expect(CACHE_RETENTION_TABLES.map((rule) => rule.table)).toEqual([
      'spread_samples',
      'public_market_snapshots',
      'portfolio_snapshots',
      'funding_arb_decisions',
    ]);
    // The rejected-candidate audit trail is not a 24h cache: it is pruned much harder, because the
    // scanner writes ~0.6M rows/day and nothing reads past the newest 200.
    expect(FUNDING_ARB_REJECT_RETENTION_MS).toBe(6 * 60 * 60_000);
    expect(FUNDING_ARB_REJECT_RETENTION_MS).toBeLessThan(CACHE_RETENTION_MS);
  });

  it('sizes the funding-arb rule so one daily pass can drain a day of rejected candidates', () => {
    const rule = CACHE_RETENTION_TABLES.find((entry) => entry.table === 'funding_arb_decisions');
    expect(rule?.column).toBe('scanned_at');
    expect(rule?.timestamp).toBe('iso');
    expect(rule?.predicate).toBe("verdict = 'REJECT' AND strategy_id IS NULL");
    // The shared 500 x 100 valve only removes 50k rows per pass; the audit table produces ~610k.
    expect((rule?.batchSize ?? 0) * (rule?.maxBatchesPerPass ?? 0)).toBeGreaterThan(500_000);
  });

  it('prunes only rejected funding-arb candidates and keeps PASS rows forever', () => {
    const database = open();
    insertFundingArbDecision(database, 'reject-old', iso(NOW - 2 * DAY_MS), 'REJECT', null);
    insertFundingArbDecision(database, 'reject-fresh', iso(NOW - 60_000), 'REJECT', null);
    insertFundingArbDecision(database, 'pass-ancient', iso(NOW - 40 * DAY_MS), 'PASS', null);
    insertFundingArbDecision(
      database,
      'reject-with-strategy',
      iso(NOW - 40 * DAY_MS),
      'REJECT',
      'strategy-1',
    );

    const result = pruneExpiredCacheTables(database, NOW);

    // Only the old, strategy-less REJECT expires; PASS and strategy-bound rows are audit history.
    expect(result.deletedByTable.funding_arb_decisions).toBe(1);
    expect(database.prepare('SELECT id FROM funding_arb_decisions ORDER BY id').all()).toEqual([
      { id: 'pass-ancient' },
      { id: 'reject-fresh' },
      { id: 'reject-with-strategy' },
    ]);
  });

  it('deletes cache rows older than the window and keeps the fresh ones', () => {
    const database = open();
    const expired = NOW - CACHE_RETENTION_MS - 60_000;
    const fresh = NOW - 60_000;
    insertSpreadSample(database, expired - DAY_MS);
    insertSpreadSample(database, fresh);
    insertPublicSnapshot(database, 'BINANCE_FUTURE_BTC_USDT', iso(expired));
    insertPublicSnapshot(database, 'OKX_FUTURE_ETH_USDT', iso(fresh));
    insertPortfolioSnapshot(database, 'snapshot-old', iso(expired));
    insertPortfolioSnapshot(database, 'snapshot-fresh', iso(fresh));

    const result = pruneExpiredCacheTables(database, NOW);

    expect(result.totalDeleted).toBe(3);
    expect(result.deletedByTable).toEqual({
      spread_samples: 1,
      public_market_snapshots: 1,
      portfolio_snapshots: 1,
    });
    // The fresh rows survive at every granularity of the rule.
    expect(count(database, 'spread_samples')).toBe(1);
    expect(count(database, 'public_market_snapshots')).toBe(1);
    expect(database.prepare('SELECT id FROM portfolio_snapshots').all()).toEqual([{ id: 'snapshot-fresh' }]);
  });

  it('keeps spread samples inside the documented grace window', () => {
    const database = open();
    // 25h old: past the 24h cache window but inside the 24h + 2h span grace.
    insertSpreadSample(database, NOW - 25 * 60 * 60_000);
    const result = pruneExpiredCacheTables(database, NOW);
    expect(result.deletedByTable.spread_samples).toBeUndefined();
    expect(count(database, 'spread_samples')).toBe(1);
  });

  it('never deletes K-line or funding-rate history, however old it is', () => {
    const database = open();
    const ancientCandle = NOW - 400 * DAY_MS;
    const ancientFunding = NOW - 400 * DAY_MS;
    database.prepare(`
      INSERT INTO candle_cache (symbol, interval, start_time, open, high, low, close, volume)
      VALUES ('GATE_FUTURE_BTC_USDT', '5m', ?, '1', '1', '1', '1', '1')
    `).run(ancientCandle);
    database.prepare(`
      INSERT INTO funding_rate_history (symbol, funding_time, rate, fetched_at)
      VALUES ('GATE_FUTURE_BTC_USDT', ?, '0.0001', ?)
    `).run(ancientFunding, iso(ancientFunding));
    database.prepare(`
      INSERT INTO funding_history_coverage (symbol, covered_from, covered_to, last_attempt_at, last_success_at)
      VALUES ('GATE_FUTURE_BTC_USDT', ?, ?, ?, ?)
    `).run(ancientFunding, ancientFunding, iso(ancientFunding), iso(ancientFunding));

    // Both pruneExpiredCacheTables and the full maintenance pass leave them untouched.
    pruneExpiredCacheTables(database, NOW);
    const maintenance = runDatabaseMaintenance(database, NOW);

    expect(count(database, 'candle_cache')).toBe(1);
    expect(count(database, 'funding_rate_history')).toBe(1);
    expect(count(database, 'funding_history_coverage')).toBe(1);
    expect(maintenance.cacheRowsDeleted).toBe(0);
    expect(maintenance.cacheRowsDeletedByTable).toEqual({});
  });

  it('always keeps the newest portfolio snapshot, even when it is itself expired', () => {
    const database = open();
    insertPortfolioSnapshot(database, 'snapshot-25h', iso(NOW - 25 * 60 * 60_000));
    insertPortfolioSnapshot(database, 'snapshot-26h', iso(NOW - 26 * 60 * 60_000));
    insertPortfolioSnapshot(database, 'snapshot-30d', iso(NOW - 30 * DAY_MS));

    const result = pruneExpiredCacheTables(database, NOW);

    // Only the newest row survives: the two older rows are gone, the cold-start fallback stays.
    expect(result.deletedByTable.portfolio_snapshots).toBe(2);
    expect(database.prepare('SELECT id FROM portfolio_snapshots').all()).toEqual([{ id: 'snapshot-25h' }]);
  });

  it('keeps a lone portfolio snapshot that is far outside the window', () => {
    const database = open();
    insertPortfolioSnapshot(database, 'only-snapshot', iso(NOW - 40 * DAY_MS));

    const result = pruneExpiredCacheTables(database, NOW);

    expect(result.deletedByTable.portfolio_snapshots).toBeUndefined();
    expect(database.prepare('SELECT id FROM portfolio_snapshots').all()).toEqual([{ id: 'only-snapshot' }]);
  });

  it('keeps the newest quote snapshot rule strict: stale public snapshots are all removed', () => {
    // Only portfolio_snapshots carries keepNewest; a stale quote must never be served as "now".
    const database = open();
    insertPublicSnapshot(database, 'BINANCE_FUTURE_BTC_USDT', iso(NOW - 2 * DAY_MS));
    insertPublicSnapshot(database, 'OKX_FUTURE_ETH_USDT', iso(NOW - 3 * DAY_MS));

    const result = pruneExpiredCacheTables(database, NOW);

    expect(result.deletedByTable.public_market_snapshots).toBe(2);
    expect(count(database, 'public_market_snapshots')).toBe(0);
  });

  it('prunes in bounded batches so a huge backlog never takes one giant write lock', () => {
    const database = open();
    // Three days old: outside both the 24h window and the spread-sample grace.
    const expired = NOW - 3 * DAY_MS;
    for (let index = 0; index < 25; index += 1) insertSpreadSample(database, expired - index * 1_000);

    const result = pruneExpiredCacheTables(database, NOW, { batchSize: 10 });

    expect(result.deletedByTable.spread_samples).toBe(25);
    // 10 + 10 + 5 + the empty batch that proves the table ran dry.
    expect(result.batches).toBeGreaterThanOrEqual(3);
    expect(count(database, 'spread_samples')).toBe(0);
  });

  it('is idempotent: a second pass deletes nothing', () => {
    const database = open();
    insertSpreadSample(database, NOW - 3 * DAY_MS);
    expect(pruneExpiredCacheTables(database, NOW).totalDeleted).toBe(1);
    expect(pruneExpiredCacheTables(database, NOW).totalDeleted).toBe(0);
  });

  it('skips tables that are absent instead of throwing', () => {
    const database = open();
    database.prepare('DROP TABLE spread_samples').run();
    const result = pruneExpiredCacheTables(database, NOW);
    expect(result.skippedTables).toContain('spread_samples');
    expect(result.totalDeleted).toBe(0);
  });
});

describe('cache retention inside the daily maintenance pass', () => {
  it('reports cache deletions alongside the existing retention counters', () => {
    const database = open();
    insertSpreadSample(database, NOW - 3 * DAY_MS);
    insertSpreadSample(database, NOW - 30_000);
    insertPortfolioSnapshot(database, 'stale-newest', iso(NOW - 2 * DAY_MS));
    insertPortfolioSnapshot(database, 'stale-oldest', iso(NOW - 3 * DAY_MS));

    const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-maintenance-'));
    try {
      const result = runDatabaseMaintenance(database, NOW, { backupDirectory: directory });

      expect(result.cacheRowsDeleted).toBe(2);
      expect(result.cacheRowsDeletedByTable).toEqual({ spread_samples: 1, portfolio_snapshots: 1 });
      // In-memory databases never archive (`database-backup.test.ts` covers the file-backed case),
      // but the archive step still runs in this same pass and reports itself.
      expect(result.backupOutcome).toBe('skipped');
      expect(result.auditEventsDeleted).toBe(0);
      expect(result.portfolioEquitySamplesDeleted).toBe(0);
      // 24h of cached data is what remains, plus the single newest snapshot as cold-start fallback.
      expect(count(database, 'spread_samples')).toBe(1);
      expect(database.prepare('SELECT id FROM portfolio_snapshots').all()).toEqual([{ id: 'stale-newest' }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
