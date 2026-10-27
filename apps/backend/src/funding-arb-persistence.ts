import type Database from 'better-sqlite3';

/** Realised funding over the trailing 24h/7d, per executable perpetual symbol. */
export interface FundingPersistenceRow {
  symbol: string;
  /** Sum of native rates over the trailing 24h (fraction; can be negative). */
  sum24h: number;
  count24h: number;
  sum7d: number;
  count7d: number;
}

/**
 * One SQL pass over `funding_rate_history` for the persistence gate.
 *
 * The gate compares the *realised* funding of both legs against the current snapshot: a pair whose
 * current differential is a one-period spike shows a much smaller 24h average, and a pair that has
 * been paying the other way for a week is rejected outright. This is the local-data equivalent of
 * vooi's `apr_24h >= 0 && apr_7d >= 0` + ratio caps.
 */
export function loadFundingPersistence(
  database: Database.Database,
  now: number,
): Map<string, FundingPersistenceRow> {
  const since24 = now - 24 * 3_600_000;
  const since7d = now - 7 * 24 * 3_600_000;
  const rows = database.prepare(`
    SELECT symbol,
      SUM(CASE WHEN funding_time >= ? THEN CAST(rate AS REAL) ELSE 0 END) AS sum24h,
      SUM(CASE WHEN funding_time >= ? THEN 1 ELSE 0 END) AS count24h,
      SUM(CAST(rate AS REAL)) AS sum7d,
      COUNT(*) AS count7d
    FROM funding_rate_history
    WHERE funding_time > ? AND funding_time <= ?
    GROUP BY symbol
  `).all(since24, since24, since7d, now) as Array<{
    symbol: string; sum24h: number | null; count24h: number | null;
    sum7d: number | null; count7d: number | null;
  }>;
  const index = new Map<string, FundingPersistenceRow>();
  for (const row of rows) {
    const sum24h = Number(row.sum24h ?? 0);
    const sum7d = Number(row.sum7d ?? 0);
    if (!Number.isFinite(sum24h) || !Number.isFinite(sum7d)) continue;
    index.set(row.symbol, {
      symbol: row.symbol,
      sum24h,
      count24h: Number(row.count24h ?? 0),
      sum7d,
      count7d: Number(row.count7d ?? 0),
    });
  }
  return index;
}

/** Latest settled (time, native rate) for one symbol at or before `atMs`, or null. */
export function latestSettledRate(
  database: Database.Database,
  symbol: string,
  atMs: number,
): { time: number; rate: number } | null {
  const row = database.prepare(`
    SELECT funding_time, CAST(rate AS REAL) AS rate
    FROM funding_rate_history
    WHERE symbol = ? AND funding_time <= ?
    ORDER BY funding_time DESC
    LIMIT 1
  `).get(symbol, atMs) as { funding_time: number; rate: number } | undefined;
  if (!row || !Number.isFinite(Number(row.rate))) return null;
  return { time: Number(row.funding_time), rate: Number(row.rate) };
}

/** Annualized percent of a trailing-window sum of native rates. */
export function annualizeWindow(sum: number, windowDays: number): number {
  if (!Number.isFinite(sum) || windowDays <= 0) return 0;
  return sum * (365 / windowDays) * 100;
}
