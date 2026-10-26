import { z } from 'zod';

/**
 * Portfolio (account) equity curve contract — shared by the backend sampler, the
 * `GET /api/crossex/portfolio-equity` endpoint and the asset-page chart.
 *
 * The existing `portfolio_snapshots` table keeps only the most recent 20 snapshots as a whole
 * document, which cannot back a 7d/30d chart. This module fixes the *shape* of the separate
 * sample series (persisted by a dedicated table) and, more importantly, fixes the equity
 * definition in one place so the backend write path and the frontend KPI never diverge.
 *
 * Scope note: equity is **computed by us** from the snapshot (`accountEquityOf`): the cash side of
 * every stablecoin balance row across the CrossEx venues plus the unrealised PnL of the open
 * futures/margin positions. It is *not* `snapshot.account.marginBalance` any more — that Gate figure
 * subtracts the locked margin of DEX legs (HYPERLIQUID, LIGHTER, …) from cash without adding the
 * margin back as an asset, so a fully hedged pair makes the account look half as large right after
 * the legs open and whole again once they close. The Gate figure survives as a secondary display
 * ("Gate basis") and as the denominator of every risk ratio, where Gate's own convention is the
 * authoritative one.
 */

/** Sampling granularity of the persisted equity series. */
export const PortfolioEquityGranularitySchema = z.enum(['raw', 'hour', 'day']);
export type PortfolioEquityGranularity = z.infer<typeof PortfolioEquityGranularitySchema>;

/** Chart ranges offered by the asset page (`24h / 7d / 30d / 全部`). */
export const PortfolioEquityRangeSchema = z.enum(['24h', '7d', '30d', 'all']);
export type PortfolioEquityRange = z.infer<typeof PortfolioEquityRangeSchema>;

/** One sampled equity point. Amounts stay Decimal strings, matching the rest of the API. */
export const PortfolioEquityPointSchema = z.object({
  /** Epoch milliseconds at which the sample was taken. */
  time: z.number().int().nonnegative(),
  /** Account equity in USD (see `accountEquityOf`: stablecoin cash + position PnL). */
  equity: z.string(),
  /** Summed unrealised PnL in USD; `null` when no position rows were available. */
  unrealizedPnl: z.string().nullable(),
});
export type PortfolioEquityPoint = z.infer<typeof PortfolioEquityPointSchema>;

/** Response of `GET /api/crossex/portfolio-equity`. */
export const PortfolioEquitySeriesResponseSchema = z.object({
  range: PortfolioEquityRangeSchema,
  granularity: PortfolioEquityGranularitySchema,
  points: z.array(PortfolioEquityPointSchema),
  /** ISO timestamp of the oldest sample ever recorded; `null` → UI shows the empty state. */
  firstSampleAt: z.string().nullable(),
  fetchedAt: z.string(),
});
export type PortfolioEquitySeriesResponse = z.infer<typeof PortfolioEquitySeriesResponseSchema>;

/**
 * Minimal structural view of `PortfolioSnapshot` needed to derive a sample.
 *
 * Declared structurally (instead of importing `PortfolioSnapshot` from `./index.js`) to keep
 * `portfolio-equity.ts` free of a circular dependency: `index.ts` re-exports this module.
 */
export interface PortfolioEquitySnapshotInput {
  account?: {
    marginBalance?: string | null;
  } | null;
  /** Per-venue balance rows; only the stablecoin cash column is summed (see `accountEquityOf`). */
  balances?: readonly PortfolioEquityBalanceInput[] | null;
  futuresPositions?: readonly { unrealizedPnl?: string | null }[] | null;
  marginPositions?: readonly { unrealizedPnl?: string | null }[] | null;
}

/**
 * Structural view of one balance row, matching `PortfolioBalance` without importing it (see the
 * circular-dependency note above). `unrealizedPnl` is accepted but intentionally unused: the
 * account-level PnL comes from the *position* rows, which keeps the row-level and position-level
 * PnL from ever being counted twice.
 */
export interface PortfolioEquityBalanceInput {
  venue: string;
  coin: string;
  balance: string;
  unrealizedPnl?: string | null;
}

/** Window length of every range in milliseconds. */
export const PORTFOLIO_EQUITY_RANGE_MS: Readonly<Record<PortfolioEquityRange, number>> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  /** `all` has no window: the reader simply starts at the first sample. */
  all: 0,
};

/** Sampling bucket size per granularity in milliseconds. */
export const PORTFOLIO_EQUITY_BUCKET_MS: Readonly<Record<PortfolioEquityGranularity, number>> = {
  raw: 0,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

/** Retention per granularity in milliseconds (used by database maintenance). */
export const PORTFOLIO_EQUITY_RETENTION_MS: Readonly<Record<PortfolioEquityGranularity, number>> = {
  raw: 7 * 24 * 60 * 60 * 1000,
  hour: 45 * 24 * 60 * 60 * 1000,
  day: 730 * 24 * 60 * 60 * 1000,
};

/**
 * Granularity used to serve a range: recent ranges keep the fine-grained samples, longer ranges
 * read the pre-aggregated buckets so the payload stays small.
 */
export function equityGranularityForRange(range: PortfolioEquityRange): PortfolioEquityGranularity {
  switch (range) {
    case '24h':
      return 'raw';
    case '7d':
    case '30d':
      return 'hour';
    case 'all':
    default:
      return 'day';
  }
}

/** Inclusive lower bound (epoch ms) of the samples needed to render `range`. */
export function equityRangeWindow(range: PortfolioEquityRange, now: number): { fromMs: number } {
  const span = PORTFOLIO_EQUITY_RANGE_MS[range] ?? 0;
  const safeNow = Number.isFinite(now) ? Math.trunc(now) : 0;
  return { fromMs: span > 0 ? Math.max(0, safeNow - span) : 0 };
}

/** Bucket start (epoch ms, floored) that a sample belongs to for the given granularity. */
export function equityBucketStart(time: number, granularity: PortfolioEquityGranularity): number {
  const bucket = PORTFOLIO_EQUITY_BUCKET_MS[granularity] ?? 0;
  const safeTime = Number.isFinite(time) ? Math.trunc(time) : 0;
  if (bucket <= 0) return Math.max(0, safeTime);
  return Math.max(0, Math.floor(safeTime / bucket) * bucket);
}

const DECIMAL_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const DECIMAL_SCALE = 18n;
const DECIMAL_FACTOR = 10n ** DECIMAL_SCALE;

/**
 * Sum Decimal strings without floating point drift.
 *
 * Returns `null` when no operand is a parseable Decimal, which the caller maps to `null` → the UI
 * renders `—`. Unparseable operands are skipped rather than poisoning the whole sum.
 */
export function sumDecimalStrings(values: readonly (string | null | undefined)[]): string | null {
  let total = 0n;
  let parsedAny = false;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!DECIMAL_PATTERN.test(trimmed)) continue;
    total += parseDecimalToScaled(trimmed);
    parsedAny = true;
  }
  if (!parsedAny) return null;
  return formatScaledDecimal(total);
}

function parseDecimalToScaled(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative || value.startsWith('+') ? value.slice(1) : value;
  const [integerPart = '0', fractionPart = ''] = unsigned.split('.');
  const paddedFraction = (fractionPart + '0'.repeat(Number(DECIMAL_SCALE))).slice(0, Number(DECIMAL_SCALE));
  const magnitude = BigInt(`${integerPart || '0'}${paddedFraction}`);
  return negative ? -magnitude : magnitude;
}

function formatScaledDecimal(scaled: bigint): string {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const integerPart = magnitude / DECIMAL_FACTOR;
  const fractionPart = (magnitude % DECIMAL_FACTOR).toString().padStart(Number(DECIMAL_SCALE), '0');
  const trimmedFraction = fractionPart.replace(/0+$/, '');
  const sign = negative && (integerPart !== 0n || trimmedFraction.length > 0) ? '-' : '';
  return trimmedFraction.length > 0 ? `${sign}${integerPart}.${trimmedFraction}` : `${sign}${integerPart}`;
}

/**
 * Coins that are worth their face value, i.e. the ones that can be summed as USD 1:1.
 *
 * Non-stablecoin rows are deliberately excluded: a `GATE ADA 0.9486` row means *0.9486 ADA*, not
 * 0.95 USD, so adding it would inflate the total by the coin count (the live 2026-10-26 snapshot
 * would have been overstated by 1.4465 from ADA + ONE + SUI alone).
 */
const EQUITY_QUOTE_COINS: ReadonlySet<string> = new Set(['USDT', 'USDC', 'USD']);

/** Venue code of the isolated Gate spot account, which is not part of the CrossEx margin account. */
const SPOT_VENUE = 'SPOT';

/**
 * Total account equity in USD, computed from the snapshot instead of trusting Gate.
 *
 * `SUM(stablecoin balance rows)` + `SUM(unrealised PnL of futures + margin positions)`, both summed
 * as Decimal strings so the result never drifts.
 *
 * Why we do not use `account.marginBalance` (Gate's own figure):
 * - Gate locks the margin of DEX legs (HYPERLIQUID's `initialMargin`, 40.4710 in the 2026-10-26
 *   snapshot) by subtracting it from the cash of that row, and then never adds the locked margin
 *   back as an asset. `HYPERLIQUID USDC` reported `balance 6.1625` with `upnl -0.1044` but
 *   `equity = -34.3085`, i.e. `6.1625 - 40.4710`. The account therefore lost one leg's margin the
 *   moment a hedged pair opened and recovered it when the pair closed — the "equity drops from 97
 *   to 50 while a delta-neutral pair is open" symptom.
 * - Two degradation steps in the curve confirm it: the equity series fell by -39.88 in total, which
 *   is exactly the single-leg margin, while the real PnL over the same window was ≈ -0.09.
 *
 * `SUM(balances.balance) + SUM(positions.upnl)` yields 99.9128 for that snapshot, which is
 * continuous with the 94.75 recorded before the pair opened (the difference is fees and funding),
 * whereas Gate's `marginBalance` was 58.5366 = 99.9128 - 40.3666 (DEX double deduction) - 1.0096
 * (small unconfirmed items, most likely the unvalued residual of the same deduction).
 *
 * If Gate ever fixes its side, the two numbers converge on their own and this function stays
 * internally consistent — nothing here is tuned to Gate's current bug.
 *
 * Contract details:
 * - Only `USDT` / `USDC` / `USD` rows count; other coins are quantities, not values.
 * - `venue === 'SPOT'` rows are skipped: that is Gate's isolated spot account (see
 *   `spotBalanceRows()` in the backend, which stamps those rows with `equity: '0'`), not cash
 *   inside the CrossEx margin account.
 * - Only `balance` (cash) is read, never `equity`, so a locked-margin quirk on the row level cannot
 *   leak back in.
 * - Unparseable / missing input returns `'0'`, matching the previous degradation semantics (the UI
 *   renders `—`).
 *
 * @param balances Per-venue balance rows of the snapshot (may contain non-stablecoin and SPOT rows).
 * @param futuresPositions Futures positions; only their `unrealizedPnl` is read.
 * @param marginPositions Margin positions; only their `unrealizedPnl` is read.
 * @returns The account equity as a Decimal string, never empty, never exponential notation.
 */
export function accountEquityOf(
  balances: readonly PortfolioEquityBalanceInput[] | null | undefined,
  futuresPositions: readonly { unrealizedPnl?: string | null }[] | null | undefined,
  marginPositions: readonly { unrealizedPnl?: string | null }[] | null | undefined,
): string {
  const cash: Array<string | null> = [];
  for (const row of balances ?? []) {
    if (!row) continue;
    if (typeof row.venue === 'string' && row.venue.trim().toUpperCase() === SPOT_VENUE) continue;
    if (typeof row.coin !== 'string') continue;
    if (!EQUITY_QUOTE_COINS.has(row.coin.trim().toUpperCase())) continue;
    cash.push(typeof row.balance === 'string' ? row.balance : null);
  }
  const cashTotal = sumDecimalStrings(cash);
  const positionPnl = sumDecimalStrings([
    ...(futuresPositions ?? []).map((position) => position?.unrealizedPnl ?? null),
    ...(marginPositions ?? []).map((position) => position?.unrealizedPnl ?? null),
  ]);
  // `sumDecimalStrings` skips `null` operands, so a missing cash side still yields the PnL side and
  // two missing sides yield `null`, mapped to `'0'` below.
  const total = sumDecimalStrings([cashTotal, positionPnl]);
  return total ?? '0';
}

/**
 * Derive one equity sample from a portfolio snapshot.
 *
 * Equity comes from `accountEquityOf` — the very same function the asset-page KPI uses — so the
 * curve and the KPI can never drift apart. `unrealizedPnl` is the sum over futures and margin
 * positions and is informational only.
 */
export function portfolioEquitySampleFromSnapshot(
  snapshot: PortfolioEquitySnapshotInput | null | undefined,
  fetchedAt: string | number | Date,
): PortfolioEquityPoint {
  const equity = accountEquityOf(snapshot?.balances, snapshot?.futuresPositions, snapshot?.marginPositions);
  const unrealizedPnl = sumDecimalStrings([
    ...(snapshot?.futuresPositions ?? []).map((position) => position?.unrealizedPnl ?? null),
    ...(snapshot?.marginPositions ?? []).map((position) => position?.unrealizedPnl ?? null),
  ]);
  return {
    time: normalizeTimestamp(fetchedAt),
    equity: equity.trim().length > 0 ? equity.trim() : '0',
    unrealizedPnl,
  };
}

function normalizeTimestamp(value: string | number | Date): number {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? Math.trunc(value.getTime()) : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  }
  return 0;
}

/**
 * Thin a series down to at most `max` points while always keeping the first and the last point,
 * so the rendered curve keeps its true endpoints. Series that already fit are returned unchanged.
 * With `max === 1` only the newest point survives — a single point cannot carry both endpoints and
 * the newest sample is the one the chart cares about.
 */
export function downsampleEquityPoints(
  points: readonly PortfolioEquityPoint[],
  max: number,
): PortfolioEquityPoint[] {
  if (max <= 0) return [];
  if (points.length <= max) return [...points];
  const lastIndex = points.length - 1;
  const step = lastIndex / (max - 1);
  const picked: PortfolioEquityPoint[] = [];
  const seen = new Set<number>();
  for (let slot = 0; slot < max; slot += 1) {
    const index = slot === max - 1 ? lastIndex : Math.round(slot * step);
    if (seen.has(index)) continue;
    seen.add(index);
    picked.push(points[index]);
  }
  return picked;
}
