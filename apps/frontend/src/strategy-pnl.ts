import type { StrategyPnl } from '@gate-crossex/shared-types';

/**
 * Presentation helpers for `strategy.pnl`.
 *
 * The backend contract (shared-types `StrategyPnlSchema`) is explicit that a `null` field means
 * "the inputs are not available", **never zero** — `unrealizedPnl` needs a stored mark price and
 * `fundingFeeUsdt` can only be attributed when this strategy exclusively owns the contract. Every
 * helper therefore returns `null` for an unavailable figure so the caller renders an em dash
 * instead of inventing a number.
 *
 * Tone follows the rest of the terminal: `.positive` (green) for a non-negative result and
 * `.negative` (red) for a negative one, exactly like the existing `strategy-funding-collected`
 * cell and the positions / portfolio tables.
 */

export type PnlTone = 'positive' | 'negative';

/** The dash every unavailable figure renders as. */
export const PNL_DASH = '—';

export interface PnlFigure {
  /** Formatted, sign-prefixed value without its unit. */
  text: string;
  /** Tailwind-free class name consumed directly by the cell (`positive` / `negative`). */
  tone: PnlTone;
}

/** Coerce a nullable numeric string to a finite number, or `null` when it is unavailable. */
function finiteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** USDT figure with two decimals and an explicit sign: `+12.34` / `-4.00`. */
export function pnlUsdtFigure(value: string | null | undefined): PnlFigure | null {
  const numeric = finiteNumber(value);
  if (numeric === null) return null;
  return {
    text: `${numeric >= 0 ? '+' : ''}${numeric.toFixed(2)}`,
    tone: numeric >= 0 ? 'positive' : 'negative',
  };
}

/** Basis-point figure with one decimal and an explicit sign: `+12.3` / `-4.0`. */
export function bpsFigure(value: string | null | undefined): PnlFigure | null {
  const numeric = finiteNumber(value);
  if (numeric === null) return null;
  return {
    text: `${numeric >= 0 ? '+' : ''}${numeric.toFixed(1)}`,
    tone: numeric >= 0 ? 'positive' : 'negative',
  };
}

/**
 * Read one field off a possibly absent `pnl`. Returns the raw string, or `null` when the whole
 * snapshot is missing or the field itself is null — the two are equivalent to the UI.
 */
export function strategyPnlField(
  pnl: StrategyPnl | null | undefined,
  field: keyof StrategyPnl,
): string | null {
  if (!pnl) return null;
  const value = pnl[field];
  return typeof value === 'string' ? value : null;
}
