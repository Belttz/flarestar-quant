import type Database from 'better-sqlite3';
import { prunePortfolioEquitySamples } from './repositories.js';

const DAY_MS = 24 * 60 * 60_000;
const AUDIT_RETENTION_MS = 180 * DAY_MS;
const EXECUTION_RETENTION_MS = 365 * DAY_MS;
const MAX_AUDIT_EVENTS = 50_000;

export interface DatabaseMaintenanceResult {
  auditEventsDeleted: number;
  strategyLogsDeleted: number;
  fillsDeleted: number;
  ordersDeleted: number;
  portfolioEquitySamplesDeleted: number;
}

/**
 * Bound locally generated operational data while preserving active strategy state. Execution
 * history is retained for a year; rows belonging to running, paused, or unresolved strategies
 * are never selected for pruning. Equity samples are trimmed per granularity (raw 7d,
 * hour 45d, day 730d).
 */
export function runDatabaseMaintenance(
  database: Database.Database,
  now = Date.now(),
): DatabaseMaintenanceResult {
  const auditCutoff = new Date(now - AUDIT_RETENTION_MS).toISOString();
  const executionCutoff = new Date(now - EXECUTION_RETENTION_MS).toISOString();
  return database.transaction(() => {
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
    const portfolioEquitySamplesDeleted = prunePortfolioEquitySamples(database, now);
    return {
      auditEventsDeleted: expiredAudit + excessAudit,
      strategyLogsDeleted,
      fillsDeleted,
      ordersDeleted,
      portfolioEquitySamplesDeleted,
    };
  })();
}
