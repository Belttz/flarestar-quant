import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  FundingArbCandidateSchema,
  FundingArbDecisionSchema,
  FundingArbDryRunTradeSchema,
  type FundingArbCandidate,
  type FundingArbDecision,
  type FundingArbDryRunTrade,
  type FundingArbSettings,
} from '@gate-crossex/shared-types';
import { parseFundingArbSettings } from './funding-arb-settings.js';

/**
 * Persistence for the automatic funding runner: the single settings row, the decision audit trail
 * and the dry-run trades. Mirrors the small-repository pattern `strategy-pairs.ts` uses — one
 * module, no service state, every reader tolerant of a hand-edited database.
 */

export function readFundingArbSettings(database: Database.Database): FundingArbSettings {
  const row = database.prepare('SELECT settings_json FROM funding_arb_settings WHERE id = 1')
    .get() as { settings_json: string } | undefined;
  if (!row) return parseFundingArbSettings({});
  try {
    return parseFundingArbSettings(JSON.parse(row.settings_json));
  } catch {
    return parseFundingArbSettings({});
  }
}

export function writeFundingArbSettings(database: Database.Database, settings: FundingArbSettings): void {
  database.prepare(`
    INSERT INTO funding_arb_settings (id, settings_json, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(settings), new Date().toISOString());
}

export function insertFundingArbDecision(
  database: Database.Database,
  input: {
    candidate: FundingArbCandidate;
    strategyId: string | null;
    scannedAt: string;
  },
): FundingArbDecision {
  const decision: FundingArbDecision = {
    id: randomUUID(),
    scannedAt: input.scannedAt,
    candidateKey: input.candidate.key,
    verdict: input.candidate.verdict,
    reasons: [...input.candidate.reasons],
    strategyId: input.strategyId,
    createdAt: new Date().toISOString(),
  };
  database.prepare(`
    INSERT INTO funding_arb_decisions
      (id, scanned_at, candidate_key, verdict, reasons_json, payload_json, strategy_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decision.id,
    decision.scannedAt,
    decision.candidateKey,
    decision.verdict,
    JSON.stringify(decision.reasons),
    JSON.stringify(input.candidate),
    decision.strategyId,
    decision.createdAt,
  );
  return decision;
}

export function listFundingArbDecisions(database: Database.Database, limit = 200): FundingArbDecision[] {
  const rows = database.prepare(`
    SELECT id, scanned_at, candidate_key, verdict, reasons_json, strategy_id, created_at
    FROM funding_arb_decisions
    ORDER BY scanned_at DESC, created_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(1000, Math.trunc(limit)))) as Array<{
    id: string; scanned_at: string; candidate_key: string; verdict: string;
    reasons_json: string; strategy_id: string | null; created_at: string;
  }>;
  return rows.flatMap((row) => {
    const parsed = FundingArbDecisionSchema.safeParse({
      id: row.id,
      scannedAt: row.scanned_at,
      candidateKey: row.candidate_key,
      verdict: row.verdict,
      reasons: safeReasons(row.reasons_json),
      strategyId: row.strategy_id,
      createdAt: row.created_at,
    });
    return parsed.success ? [parsed.data] : [];
  });
}

export interface FundingArbTradeInput {
  asset: string;
  shortVenue: string;
  longVenue: string;
  quantity: string;
  notionalUsd: number;
  entryBps: string;
  aprPercent: number;
  enteredAt: string;
  exitAt: string | null;
  fundingUsd: number;
  feesUsd: number;
  pnlUsd: number;
  status: 'OPEN' | 'CLOSED';
  payload: FundingArbCandidate;
}

export function insertFundingArbDryRunTrade(
  database: Database.Database,
  input: FundingArbTradeInput,
): FundingArbDryRunTrade {
  const trade: FundingArbDryRunTrade = {
    id: randomUUID(),
    asset: input.asset,
    shortVenue: input.shortVenue,
    longVenue: input.longVenue,
    quantity: input.quantity,
    notionalUsd: input.notionalUsd,
    entryBps: input.entryBps,
    aprPercent: input.aprPercent,
    enteredAt: input.enteredAt,
    exitAt: input.exitAt,
    fundingUsd: input.fundingUsd,
    feesUsd: input.feesUsd,
    pnlUsd: input.pnlUsd,
    status: input.status,
  };
  database.prepare(`
    INSERT INTO funding_arb_dry_run_trades
      (id, asset, short_venue, long_venue, quantity, notional_usd, entry_bps, apr_percent,
       entered_at, exit_at, closed_at, funding_usd, fees_usd, pnl_usd, status, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(
    trade.id, trade.asset, trade.shortVenue, trade.longVenue, trade.quantity,
    String(trade.notionalUsd), trade.entryBps, trade.aprPercent, trade.enteredAt, trade.exitAt,
    String(trade.fundingUsd), String(trade.feesUsd), String(trade.pnlUsd), trade.status,
    JSON.stringify(input.payload),
  );
  return trade;
}

export function closeFundingArbDryRunTrade(
  database: Database.Database,
  id: string,
  patch: { closedAt: string; fundingUsd: number; feesUsd: number; pnlUsd: number },
): void {
  database.prepare(`
    UPDATE funding_arb_dry_run_trades
    SET closed_at = ?, funding_usd = ?, fees_usd = ?, pnl_usd = ?, status = 'CLOSED'
    WHERE id = ?
  `).run(patch.closedAt, String(patch.fundingUsd), String(patch.feesUsd), String(patch.pnlUsd), id);
}

export interface OpenFundingArbDryRunTrade {
  trade: FundingArbDryRunTrade;
  candidate: FundingArbCandidate;
}

/** Open dry-run rows with their candidate payload, used to rehydrate the panel after a restart. */
export function listOpenFundingArbDryRunTrades(database: Database.Database): OpenFundingArbDryRunTrade[] {
  const rows = database.prepare(`
    SELECT id, asset, short_venue, long_venue, quantity, notional_usd, entry_bps, apr_percent,
      entered_at, exit_at, funding_usd, fees_usd, pnl_usd, status, payload_json
    FROM funding_arb_dry_run_trades WHERE status = 'OPEN' ORDER BY entered_at ASC
  `).all() as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const tradeParsed = FundingArbDryRunTradeSchema.safeParse({
      id: String(row.id),
      asset: String(row.asset),
      shortVenue: String(row.short_venue),
      longVenue: String(row.long_venue),
      quantity: String(row.quantity),
      notionalUsd: Number(row.notional_usd),
      entryBps: String(row.entry_bps),
      aprPercent: Number(row.apr_percent),
      enteredAt: String(row.entered_at),
      exitAt: row.exit_at === null ? null : String(row.exit_at),
      fundingUsd: Number(row.funding_usd),
      feesUsd: Number(row.fees_usd),
      pnlUsd: Number(row.pnl_usd),
      status: 'OPEN' as const,
    });
    let candidate: unknown = null;
    try {
      candidate = JSON.parse(String(row.payload_json));
    } catch {
      return [];
    }
    const candidateParsed = FundingArbCandidateSchema.safeParse(candidate);
    if (!tradeParsed.success || !candidateParsed.success) return [];
    return [{ trade: tradeParsed.data, candidate: candidateParsed.data }];
  });
}

export function listFundingArbDryRunTrades(database: Database.Database, limit = 200): FundingArbDryRunTrade[] {
  const rows = database.prepare(`
    SELECT id, asset, short_venue, long_venue, quantity, notional_usd, entry_bps, apr_percent,
      entered_at, exit_at, funding_usd, fees_usd, pnl_usd, status
    FROM funding_arb_dry_run_trades
    ORDER BY entered_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(1000, Math.trunc(limit)))) as Array<{
    id: string; asset: string; short_venue: string; long_venue: string; quantity: string;
    notional_usd: string; entry_bps: string; apr_percent: number; entered_at: string;
    exit_at: string | null; funding_usd: string; fees_usd: string; pnl_usd: string; status: string;
  }>;
  return rows.flatMap((row) => {
    const parsed = FundingArbDryRunTradeSchema.safeParse({
      id: row.id,
      asset: row.asset,
      shortVenue: row.short_venue,
      longVenue: row.long_venue,
      quantity: row.quantity,
      notionalUsd: Number(row.notional_usd),
      entryBps: row.entry_bps,
      aprPercent: Number(row.apr_percent),
      enteredAt: row.entered_at,
      exitAt: row.exit_at,
      fundingUsd: Number(row.funding_usd),
      feesUsd: Number(row.fees_usd),
      pnlUsd: Number(row.pnl_usd),
      status: row.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
    });
    return parsed.success ? [parsed.data] : [];
  });
}

/** Open dry-run trades whose exit time has passed (closed by the next scan pass). */
export function listDueFundingArbDryRunTrades(database: Database.Database, now: number): FundingArbDryRunTrade[] {
  const rows = database.prepare(`
    SELECT id, asset, short_venue, long_venue, quantity, notional_usd, entry_bps, apr_percent,
      entered_at, exit_at, funding_usd, fees_usd, pnl_usd, status
    FROM funding_arb_dry_run_trades
    WHERE status = 'OPEN' AND exit_at IS NOT NULL
  `).all() as Array<{
    id: string; asset: string; short_venue: string; long_venue: string; quantity: string;
    notional_usd: string; entry_bps: string; apr_percent: number; entered_at: string;
    exit_at: string | null; funding_usd: string; fees_usd: string; pnl_usd: string; status: string;
  }>;
  return rows.flatMap((row) => {
    const exitAt = row.exit_at ? Date.parse(row.exit_at) : Number.NaN;
    if (!Number.isFinite(exitAt) || exitAt > now) return [];
    return listFundingArbDryRunTradesByIds(database, [row.id]);
  });
}

function listFundingArbDryRunTradesByIds(database: Database.Database, ids: string[]): FundingArbDryRunTrade[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = database.prepare(`
    SELECT id, asset, short_venue, long_venue, quantity, notional_usd, entry_bps, apr_percent,
      entered_at, exit_at, funding_usd, fees_usd, pnl_usd, status
    FROM funding_arb_dry_run_trades WHERE id IN (${placeholders})
  `).all(...ids) as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const parsed = FundingArbDryRunTradeSchema.safeParse({
      id: String(row.id),
      asset: String(row.asset),
      shortVenue: String(row.short_venue),
      longVenue: String(row.long_venue),
      quantity: String(row.quantity),
      notionalUsd: Number(row.notional_usd),
      entryBps: String(row.entry_bps),
      aprPercent: Number(row.apr_percent),
      enteredAt: String(row.entered_at),
      exitAt: row.exit_at === null ? null : String(row.exit_at),
      fundingUsd: Number(row.funding_usd),
      feesUsd: Number(row.fees_usd),
      pnlUsd: Number(row.pnl_usd),
      status: row.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
    });
    return parsed.success ? [parsed.data] : [];
  });
}

function safeReasons(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
