import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Storage for user-defined spread pairs (美股价差溢价套利).
 *
 * A pair is two explicit leg symbols that need not share an asset, plus the quantity conversion
 * between them. Keeping the symbols rather than an asset name is deliberate: SNDK and SNXX live
 * on different venues with different quote coins, so the only lossless description of the pair is
 * the pair of symbols.
 */

export interface SavedStrategyPair {
  id: string;
  name: string;
  leftSymbol: string;
  rightSymbol: string;
  /** LEFT units per ONE right unit; right quantity = left quantity / ratio. */
  ratio: string;
  entryBps: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedStrategyPairInput {
  name: string;
  leftSymbol: string;
  rightSymbol: string;
  ratio: string;
  entryBps?: string | null;
}

interface PairRow {
  id: string;
  name: string;
  left_symbol: string;
  right_symbol: string;
  ratio: string;
  entry_bps: string | null;
  created_at: string;
  updated_at: string;
}

function toPair(row: PairRow): SavedStrategyPair {
  return {
    id: row.id,
    name: row.name,
    leftSymbol: row.left_symbol,
    rightSymbol: row.right_symbol,
    ratio: row.ratio,
    entryBps: row.entry_bps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `id, name, left_symbol, right_symbol, ratio, entry_bps, created_at, updated_at`;

export function listStrategyPairs(database: Database.Database): SavedStrategyPair[] {
  const rows = database.prepare(
    `SELECT ${SELECT_COLUMNS} FROM saved_strategy_pairs ORDER BY updated_at DESC`,
  ).all() as PairRow[];
  return rows.map(toPair);
}

/**
 * Insert or update a pair by name. Saving under an existing name replaces that pair in place, so
 * tweaking a ratio and re-saving does not litter the list with duplicates.
 */
export function saveStrategyPair(database: Database.Database, input: SavedStrategyPairInput): SavedStrategyPair {
  const now = new Date().toISOString();
  const existing = database.prepare(
    `SELECT ${SELECT_COLUMNS} FROM saved_strategy_pairs WHERE name = ?`,
  ).get(input.name) as PairRow | undefined;
  if (existing) {
    database.prepare(
      `UPDATE saved_strategy_pairs
          SET left_symbol = ?, right_symbol = ?, ratio = ?, entry_bps = ?, updated_at = ?
        WHERE id = ?`,
    ).run(input.leftSymbol, input.rightSymbol, input.ratio, input.entryBps ?? null, now, existing.id);
    const updated = database.prepare(
      `SELECT ${SELECT_COLUMNS} FROM saved_strategy_pairs WHERE id = ?`,
    ).get(existing.id) as PairRow;
    return toPair(updated);
  }
  const id = randomUUID();
  database.prepare(
    `INSERT INTO saved_strategy_pairs (id, name, left_symbol, right_symbol, ratio, entry_bps, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.leftSymbol, input.rightSymbol, input.ratio, input.entryBps ?? null, now, now);
  return {
    id,
    name: input.name,
    leftSymbol: input.leftSymbol,
    rightSymbol: input.rightSymbol,
    ratio: input.ratio,
    entryBps: input.entryBps ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export function deleteStrategyPair(database: Database.Database, id: string): boolean {
  return database.prepare('DELETE FROM saved_strategy_pairs WHERE id = ?').run(id).changes > 0;
}
