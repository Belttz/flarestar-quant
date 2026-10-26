import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PORTFOLIO_EQUITY_BUCKET_MS,
  PORTFOLIO_EQUITY_RETENTION_MS,
  equityBucketStart,
  equityGranularityForRange,
  equityRangeWindow,
} from '@gate-crossex/shared-types';
import { openDatabase } from './database.js';
import { runDatabaseMaintenance } from './database-maintenance.js';
import {
  prunePortfolioEquitySamples,
  readPortfolioEquityFirstSampleAt,
  readPortfolioEquitySeries,
  recordPortfolioEquitySample,
} from './repositories.js';

const temporaryDirectories: string[] = [];
const DAY_MS = 24 * 60 * 60_000;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function openTestDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-equity-'));
  temporaryDirectories.push(directory);
  return openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
}

/** 2026-07-01T03:24:15.678Z — hour bucket 03:00, day bucket 00:00 UTC. */
const SAMPLE_AT_MS = Date.parse('2026-07-01T03:24:15.678Z');
const SAMPLE_DAY_BUCKET = Date.parse('2026-07-01T00:00:00.000Z');
const SAMPLE_HOUR_BUCKET = Date.parse('2026-07-01T03:00:00.000Z');

/**
 * Snapshot fixture for the sampler.
 *
 * Equity is **not** `account.marginBalance` (kept at a constant 1500 on purpose, so a wrong
 * implementation is visible): it is `SUM(stablecoin balance rows) + SUM(position uPnL)` =
 * `balance + 120`. Pass the desired stablecoin cash to shift the expected equity by the same amount.
 */
function sampleInput(balance = '1480') {
  return {
    account: { marginBalance: '1500' },
    balances: [
      { venue: 'BINANCE', coin: 'USDT', balance, unrealizedPnl: '0' },
      // Coin quantity, not dollars: excluded from equity.
      { venue: 'GATE', coin: 'ADA', balance: '0.9486', unrealizedPnl: '0' },
    ],
    futuresPositions: [{ unrealizedPnl: '20' }, { unrealizedPnl: null }],
    marginPositions: [{ unrealizedPnl: '100' }],
  };
}

/** Equity the sampler must persist for a `sampleInput(balance)` snapshot (cash + 20 + 100). */
function expectedEquity(balance: string): string {
  return String(Number(balance) + 120);
}

function sampleRows(database: Database.Database): Array<{ granularity: string; bucket_start: number; equity: string; unrealized_pnl: string | null }> {
  return database.prepare(`
    SELECT granularity, bucket_start, equity, unrealized_pnl
    FROM portfolio_equity_samples
    ORDER BY granularity, bucket_start
  `).all() as Array<{ granularity: string; bucket_start: number; equity: string; unrealized_pnl: string | null }>;
}

describe('portfolio equity samples', () => {
  it('creates the sampling table via migration 0023 and reopens with a stable checksum', () => {
    const database = openTestDatabase();
    try {
      expect(sampleRows(database)).toEqual([]);
      database.close();

      // Reopening must not re-run or reject migration 0023 (checksum stability).
      const reopened = openTestDatabase();
      try {
        expect(sampleRows(reopened)).toEqual([]);
      } finally {
        reopened.close();
      }
    } finally {
      if (database.open) database.close();
    }
  });

  it('maps chart ranges to granularities and window lengths per the shared contract', () => {
    expect(equityGranularityForRange('24h')).toBe('raw');
    expect(equityGranularityForRange('7d')).toBe('hour');
    expect(equityGranularityForRange('30d')).toBe('hour');
    expect(equityGranularityForRange('all')).toBe('day');

    const now = Date.parse('2026-07-01T12:00:00.000Z');
    expect(equityRangeWindow('24h', now)).toEqual({ fromMs: now - 24 * 60 * 60_000 });
    expect(equityRangeWindow('7d', now)).toEqual({ fromMs: now - 7 * 24 * 60 * 60_000 });
    expect(equityRangeWindow('30d', now)).toEqual({ fromMs: now - 30 * 24 * 60 * 60_000 });
    expect(equityRangeWindow('all', now)).toEqual({ fromMs: 0 });

    expect(PORTFOLIO_EQUITY_BUCKET_MS).toEqual({ raw: 0, hour: 3_600_000, day: 86_400_000 });
    expect(equityBucketStart(SAMPLE_AT_MS, 'raw')).toBe(SAMPLE_AT_MS);
    expect(equityBucketStart(SAMPLE_AT_MS, 'hour')).toBe(SAMPLE_HOUR_BUCKET);
    expect(equityBucketStart(SAMPLE_AT_MS, 'day')).toBe(SAMPLE_DAY_BUCKET);
  });

  it('records one raw point plus its floored hour and day buckets', () => {
    const database = openTestDatabase();
    try {
      const result = recordPortfolioEquitySample(database, sampleInput(), SAMPLE_AT_MS);
      expect(result).toEqual({ recorded: true, sampledAtMs: SAMPLE_AT_MS });
      // 1480 of USDT cash + 120 of position PnL, not the 1500 marginBalance.
      expect(sampleRows(database)).toEqual([
        { granularity: 'day', bucket_start: SAMPLE_DAY_BUCKET, equity: expectedEquity('1480'), unrealized_pnl: '120' },
        { granularity: 'hour', bucket_start: SAMPLE_HOUR_BUCKET, equity: expectedEquity('1480'), unrealized_pnl: '120' },
        { granularity: 'raw', bucket_start: SAMPLE_AT_MS, equity: expectedEquity('1480'), unrealized_pnl: '120' },
      ]);
      expect(expectedEquity('1480')).toBe('1600');
    } finally {
      database.close();
    }
  });

  it('overwrites hour and day buckets with the newest sample while raw keeps every point', () => {
    const database = openTestDatabase();
    try {
      recordPortfolioEquitySample(database, sampleInput('1480'), SAMPLE_AT_MS);
      recordPortfolioEquitySample(database, sampleInput('1490'), SAMPLE_AT_MS + 20 * 60_000);
      const rows = sampleRows(database);
      expect(rows.filter((row) => row.granularity === 'raw')).toHaveLength(2);
      expect(rows.filter((row) => row.granularity === 'hour')).toEqual([
        { granularity: 'hour', bucket_start: SAMPLE_HOUR_BUCKET, equity: expectedEquity('1490'), unrealized_pnl: '120' },
      ]);
    } finally {
      database.close();
    }
  });

  it('debounces samples closer than one minute but allows later and back-dated ones', () => {
    const database = openTestDatabase();
    try {
      expect(recordPortfolioEquitySample(database, sampleInput('1500'), SAMPLE_AT_MS).recorded).toBe(true);
      // Manual refresh 30 seconds later is suppressed.
      expect(recordPortfolioEquitySample(database, sampleInput('1502'), SAMPLE_AT_MS + 30_000))
        .toEqual({ recorded: false, sampledAtMs: SAMPLE_AT_MS + 30_000 });
      expect(sampleRows(database).filter((row) => row.granularity === 'raw')).toHaveLength(1);
      // 61 seconds later the sample is recorded again.
      expect(recordPortfolioEquitySample(database, sampleInput('1505'), SAMPLE_AT_MS + 61_000).recorded).toBe(true);
      // A back-dated timestamp (clock moved backwards) is never suppressed.
      expect(recordPortfolioEquitySample(database, sampleInput('1504'), SAMPLE_AT_MS + 10_000).recorded).toBe(true);
    } finally {
      database.close();
    }
  });

  it('rejects samples with unusable timestamps without touching the table', () => {
    const database = openTestDatabase();
    try {
      expect(recordPortfolioEquitySample(database, sampleInput(), Number.NaN))
        .toEqual({ recorded: false, sampledAtMs: 0 });
      expect(recordPortfolioEquitySample(database, sampleInput(), 0))
        .toEqual({ recorded: false, sampledAtMs: 0 });
      expect(sampleRows(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('reads a series filtered by the window start, oldest first', () => {
    const database = openTestDatabase();
    try {
      recordPortfolioEquitySample(database, sampleInput('1480'), SAMPLE_AT_MS);
      recordPortfolioEquitySample(database, sampleInput('1490'), SAMPLE_AT_MS + 61_000);
      recordPortfolioEquitySample(database, sampleInput('1500'), SAMPLE_AT_MS + 122_000);
      const series = readPortfolioEquitySeries(database, 'raw', SAMPLE_AT_MS + 61_000);
      expect(series).toEqual([
        { time: SAMPLE_AT_MS + 61_000, equity: expectedEquity('1490'), unrealizedPnl: '120' },
        { time: SAMPLE_AT_MS + 122_000, equity: expectedEquity('1500'), unrealizedPnl: '120' },
      ]);
      // An unusable window start clamps to 0, i.e. everything ever sampled.
      expect(readPortfolioEquitySeries(database, 'raw', Number.NaN)).toEqual([
        { time: SAMPLE_AT_MS, equity: expectedEquity('1480'), unrealizedPnl: '120' },
        { time: SAMPLE_AT_MS + 61_000, equity: expectedEquity('1490'), unrealizedPnl: '120' },
        { time: SAMPLE_AT_MS + 122_000, equity: expectedEquity('1500'), unrealizedPnl: '120' },
      ]);
      // The day bucket (UTC midnight) sits before the raw timestamps, so the window must
      // start at the bucket itself for it to be included.
      expect(readPortfolioEquitySeries(database, 'day', SAMPLE_DAY_BUCKET)).toEqual([
        { time: SAMPLE_DAY_BUCKET, equity: expectedEquity('1500'), unrealizedPnl: '120' },
      ]);
    } finally {
      database.close();
    }
  });

  it('reports the oldest sample ever recorded across granularities', () => {
    const database = openTestDatabase();
    try {
      expect(readPortfolioEquityFirstSampleAt(database)).toBeNull();
      recordPortfolioEquitySample(database, sampleInput(), SAMPLE_AT_MS);
      // The floored day bucket (UTC midnight) is the earliest bucket_start across granularities.
      expect(readPortfolioEquityFirstSampleAt(database)).toBe(SAMPLE_DAY_BUCKET);
    } finally {
      database.close();
    }
  });

  it('prunes each granularity by its own retention window', () => {
    const database = openTestDatabase();
    try {
      const now = Date.parse('2026-08-01T00:00:00.000Z');
      const rawCutoff = now - PORTFOLIO_EQUITY_RETENTION_MS.raw;
      const hourCutoff = now - PORTFOLIO_EQUITY_RETENTION_MS.hour;
      const insert = database.prepare(`
        INSERT INTO portfolio_equity_samples (granularity, bucket_start, sampled_at, equity, unrealized_pnl)
        VALUES (?, ?, ?, '1500', '120')
      `);
      insert.run('raw', rawCutoff - 1, rawCutoff - 1);
      insert.run('raw', rawCutoff, rawCutoff);
      insert.run('hour', hourCutoff - 1, hourCutoff - 1);
      insert.run('hour', now - 60_000, now - 60_000);
      insert.run('day', now - 400 * DAY_MS, now - 400 * DAY_MS);
      insert.run('day', now - 800 * DAY_MS, now - 800 * DAY_MS);

      expect(prunePortfolioEquitySamples(database, now)).toBe(3);
      const remaining = sampleRows(database);
      expect(remaining.some((row) => row.granularity === 'raw' && row.bucket_start === rawCutoff)).toBe(true);
      expect(remaining.some((row) => row.granularity === 'hour' && row.bucket_start === now - 60_000)).toBe(true);
      expect(remaining.some((row) => row.granularity === 'day' && row.bucket_start === now - 400 * DAY_MS)).toBe(true);
    } finally {
      database.close();
    }
  });

  it('joins the daily maintenance pass and reports deleted sample rows', () => {
    const database = openTestDatabase();
    try {
      const now = Date.parse('2026-08-01T00:00:00.000Z');
      const expired = now - PORTFOLIO_EQUITY_RETENTION_MS.raw - 1;
      database.prepare(`
        INSERT INTO portfolio_equity_samples (granularity, bucket_start, sampled_at, equity, unrealized_pnl)
        VALUES ('raw', ?, ?, '1500', '120')
      `).run(expired, expired);
      expect(runDatabaseMaintenance(database, now)).toMatchObject({ portfolioEquitySamplesDeleted: 1 });
      expect(sampleRows(database)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
