import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import { annualizeWindow, loadFundingPersistence } from './funding-arb-persistence.js';

const databases: Database.Database[] = [];

function testDatabase(): Database.Database {
  const database = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
  databases.push(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const NOW = Date.parse('2026-10-27T00:00:00.000Z');
const HOUR = 3_600_000;

function insert(database: Database.Database, symbol: string, hoursAgo: number, rate: number): void {
  database.prepare('INSERT OR REPLACE INTO funding_rate_history (symbol, funding_time, rate, fetched_at) VALUES (?, ?, ?, ?)')
    .run(symbol, NOW - hoursAgo * HOUR, String(rate), new Date(NOW).toISOString());
}

describe('funding persistence window', () => {
  it('sums the trailing 24h and 7d native rates per symbol', () => {
    const database = testDatabase();
    for (let day = 0; day < 7; day += 1) {
      insert(database, 'BYBIT_FUTURE_ETH_USDT', day * 24 + 8, 0.01);
      insert(database, 'OKX_FUTURE_ETH_USDT', day * 24 + 8, 0.0001);
    }
    const index = loadFundingPersistence(database, NOW);
    const short = index.get('BYBIT_FUTURE_ETH_USDT');
    const long = index.get('OKX_FUTURE_ETH_USDT');
    expect(short).toBeDefined();
    expect(long).toBeDefined();
    expect(short!.count7d).toBe(7);
    expect(short!.sum7d).toBeCloseTo(0.07, 6);
    expect(long!.sum7d).toBeCloseTo(0.0007, 6);
    expect(short!.sum24h).toBeCloseTo(0.01, 6);
    expect(long!.sum24h).toBeCloseTo(0.0001, 6);
    expect(annualizeWindow(short!.sum24h - long!.sum24h, 1)).toBeCloseTo((0.01 - 0.0001) * 365 * 100, 2);
  });

  it('returns no row for a symbol with no history in the window', () => {
    const database = testDatabase();
    expect(loadFundingPersistence(database, NOW).size).toBe(0);
  });
});
