import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  HyperliquidPerpMetadataSnapshotSchema,
  type FundingRatePoint,
  type HyperliquidPerpMetadataSnapshot,
} from '@gate-crossex/public-data';
import {
  PortfolioSnapshotSchema, ReconciliationReportSchema, UserPreferencesSchema,
  PORTFOLIO_EQUITY_RETENTION_MS,
  equityBucketStart,
  portfolioEquitySampleFromSnapshot,
  type CrossExInstrument, type CrossExRiskLimit, type PortfolioSnapshot, type PublicMarketSnapshot, type ReconciliationReport, type UserPreferences,
  type PortfolioEquityGranularity, type PortfolioEquityPoint, type PortfolioEquitySnapshotInput,
} from '@gate-crossex/shared-types';

export interface CredentialMetadata {
  id: string;
  label: string;
  provider: string;
  createdAt: string;
  lastVerifiedAt: string | null;
}

interface CredentialMetadataRow {
  id: string;
  label: string;
  provider: string;
  created_at: string;
  last_verified_at: string | null;
}

export function getCredentialMetadata(database: Database.Database, id: string): CredentialMetadata | null {
  const row = database.prepare(`
    SELECT id, label, provider, created_at, last_verified_at
    FROM credential_metadata
    WHERE id = ?
  `).get(id) as CredentialMetadataRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    createdAt: row.created_at,
    lastVerifiedAt: row.last_verified_at,
  };
}

export function listCredentialMetadata(database: Database.Database): CredentialMetadata[] {
  const rows = database.prepare(`
    SELECT id, label, provider, created_at, last_verified_at
    FROM credential_metadata
    ORDER BY created_at, label
  `).all() as CredentialMetadataRow[];
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    provider: row.provider,
    createdAt: row.created_at,
    lastVerifiedAt: row.last_verified_at,
  }));
}

/** Undefined means a pre-profile database with no selection; null means an explicit sign-out. */
export function readActiveCredentialProfile(database: Database.Database): string | null | undefined {
  const row = database.prepare(`
    SELECT active_profile_id
    FROM credential_session
    WHERE singleton = 1
  `).get() as { active_profile_id: string | null } | undefined;
  return row ? row.active_profile_id : undefined;
}

export function saveActiveCredentialProfile(database: Database.Database, profileId: string | null): void {
  database.prepare(`
    INSERT INTO credential_session (singleton, active_profile_id, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      active_profile_id = excluded.active_profile_id,
      updated_at = excluded.updated_at
  `).run(profileId, new Date().toISOString());
}

export function upsertCredentialMetadata(
  database: Database.Database,
  metadata: CredentialMetadata,
): void {
  database.prepare(`
    INSERT INTO credential_metadata (id, label, provider, created_at, last_verified_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      provider = excluded.provider,
      last_verified_at = excluded.last_verified_at
  `).run(
    metadata.id,
    metadata.label,
    metadata.provider,
    metadata.createdAt,
    metadata.lastVerifiedAt,
  );
}

export function deleteCredentialMetadata(database: Database.Database, id: string): void {
  database.prepare('DELETE FROM credential_metadata WHERE id = ?').run(id);
}

export function readUserPreferences(database: Database.Database): UserPreferences {
  const rows = database.prepare('SELECT key, value_json FROM user_preferences').all() as Array<{ key: string; value_json: string }>;
  const preferences: Record<string, unknown> = {};
  for (const row of rows) {
    // Rows from removed settings keys or hand-edited databases must not break every preference.
    const valueSchema = UserPreferencesSchema.shape[row.key as keyof typeof UserPreferencesSchema.shape];
    if (!valueSchema) continue;
    try {
      const parsed = valueSchema.safeParse(JSON.parse(row.value_json));
      if (parsed.success && parsed.data !== undefined) preferences[row.key] = parsed.data;
    } catch { /* Skip corrupt value_json; the next save overwrites it. */ }
  }
  return preferences as UserPreferences;
}

export function saveUserPreferences(database: Database.Database, preferences: UserPreferences): void {
  const upsert = database.prepare(`
    INSERT INTO user_preferences (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);
  const updatedAt = new Date().toISOString();
  database.transaction(() => {
    for (const [key, value] of Object.entries(preferences)) {
      if (value === undefined) continue;
      upsert.run(key, JSON.stringify(value), updatedAt);
    }
  })();
}

export function addAuditEvent(
  database: Database.Database,
  type: string,
  payload: Record<string, unknown>,
): void {
  database.prepare(`
    INSERT INTO audit_events (id, created_at, type, correlation_id, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), new Date().toISOString(), type, null, JSON.stringify(payload));
}

interface InstrumentRow {
  symbol: string;
  exchange_type: string;
  business_type: string;
  state: string;
  min_size: string;
  min_notional: string | null;
  lot_size: string;
  tick_size: string;
  max_num_orders: string;
  max_market_size: string | null;
  max_limit_size: string | null;
  contract_size: string | null;
  liquidation_fee: string | null;
  default_leverage: string | null;
  delist_time: string;
  fetched_at: string;
}

export interface CachedInstrumentCatalog {
  items: CrossExInstrument[];
  fetchedAt: string;
}

function instrumentFromRow(row: InstrumentRow): CrossExInstrument {
  return {
    symbol: row.symbol,
    exchangeType: row.exchange_type,
    businessType: row.business_type,
    state: row.state,
    minSize: row.min_size,
    minNotional: row.min_notional,
    lotSize: row.lot_size,
    tickSize: row.tick_size,
    maxNumOrders: row.max_num_orders,
    maxMarketSize: row.max_market_size,
    maxLimitSize: row.max_limit_size,
    contractSize: row.contract_size,
    liquidationFee: row.liquidation_fee,
    defaultLeverage: row.default_leverage,
    delistTime: row.delist_time,
  };
}

export function readInstrumentCatalog(database: Database.Database): CachedInstrumentCatalog | null {
  const rows = database.prepare(`
    SELECT symbol, exchange_type, business_type, state, min_size, min_notional, lot_size,
      tick_size, max_num_orders, max_market_size, max_limit_size, contract_size,
      liquidation_fee, default_leverage, delist_time, fetched_at
    FROM crossex_instruments
    ORDER BY symbol
  `).all() as InstrumentRow[];
  if (rows.length === 0 || !rows[0]) return null;
  return { items: rows.map(instrumentFromRow), fetchedAt: rows[0].fetched_at };
}

export function replaceInstrumentCatalog(
  database: Database.Database,
  items: CrossExInstrument[],
  fetchedAt: string,
): void {
  const insert = database.prepare(`
    INSERT INTO crossex_instruments (
      symbol, exchange_type, business_type, state, min_size, min_notional, lot_size,
      tick_size, max_num_orders, max_market_size, max_limit_size, contract_size,
      liquidation_fee, default_leverage, delist_time, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  database.transaction(() => {
    database.prepare('DELETE FROM crossex_instruments').run();
    for (const item of items) {
      insert.run(
        item.symbol, item.exchangeType, item.businessType, item.state, item.minSize,
        item.minNotional, item.lotSize, item.tickSize, item.maxNumOrders,
        item.maxMarketSize, item.maxLimitSize, item.contractSize,
        item.liquidationFee, item.defaultLeverage, item.delistTime, fetchedAt,
      );
    }
    database.prepare(`
      INSERT INTO market_data_sync (source, last_attempt_at, last_success_at, last_error_code)
      VALUES ('gate_crossex_instruments', ?, ?, NULL)
      ON CONFLICT(source) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = excluded.last_success_at,
        last_error_code = NULL
    `).run(fetchedAt, fetchedAt);
  })();
}

export function recordMarketDataFailure(
  database: Database.Database,
  source: string,
  attemptedAt: string,
  errorCode: string,
): void {
  database.prepare(`
    INSERT INTO market_data_sync (source, last_attempt_at, last_success_at, last_error_code)
    VALUES (?, ?, NULL, ?)
    ON CONFLICT(source) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      last_error_code = excluded.last_error_code
  `).run(source, attemptedAt, errorCode);
}

export function readHyperliquidPerpMetadata(
  database: Database.Database,
): HyperliquidPerpMetadataSnapshot | null {
  const row = database.prepare(`
    SELECT native_names_json, fetched_at
    FROM hyperliquid_perp_metadata
    WHERE singleton = 1
  `).get() as { native_names_json: string; fetched_at: string } | undefined;
  if (!row) return null;
  try {
    const parsed = HyperliquidPerpMetadataSnapshotSchema.safeParse({
      nativeNames: JSON.parse(row.native_names_json),
      fetchedAt: row.fetched_at,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeHyperliquidPerpMetadata(
  database: Database.Database,
  snapshot: HyperliquidPerpMetadataSnapshot,
): void {
  const validated = HyperliquidPerpMetadataSnapshotSchema.parse(snapshot);
  database.prepare(`
    INSERT INTO hyperliquid_perp_metadata (singleton, native_names_json, fetched_at)
    VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      native_names_json = excluded.native_names_json,
      fetched_at = excluded.fetched_at
  `).run(JSON.stringify(validated.nativeNames), validated.fetchedAt);
}

export interface FundingHistoryCoverage {
  symbol: string;
  coveredFrom: number;
  coveredTo: number;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
}

interface FundingHistoryCoverageRow {
  symbol: string;
  covered_from: number;
  covered_to: number;
  last_attempt_at: string;
  last_success_at: string | null;
  last_error_code: string | null;
}

export function readFundingHistoryCoverage(
  database: Database.Database,
  symbol: string,
): FundingHistoryCoverage | null {
  const row = database.prepare(`
    SELECT symbol, covered_from, covered_to, last_attempt_at, last_success_at, last_error_code
    FROM funding_history_coverage
    WHERE symbol = ?
  `).get(symbol) as FundingHistoryCoverageRow | undefined;
  return row ? {
    symbol: row.symbol,
    coveredFrom: row.covered_from,
    coveredTo: row.covered_to,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastErrorCode: row.last_error_code,
  } : null;
}

export function readFundingRateHistory(
  database: Database.Database,
  symbol: string,
  startExclusive: number,
  endInclusive: number,
): FundingRatePoint[] {
  const rows = database.prepare(`
    SELECT funding_time, rate
    FROM funding_rate_history
    WHERE symbol = ? AND funding_time > ? AND funding_time <= ?
    ORDER BY funding_time
  `).all(symbol, startExclusive, endInclusive) as Array<{ funding_time: number; rate: string }>;
  return rows.map((row) => ({ timestamp: row.funding_time, rate: row.rate }));
}

export function listCachedFundingHistorySymbols(database: Database.Database, limit = 140): string[] {
  const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
  const rows = database.prepare(`
    SELECT symbol
    FROM funding_history_coverage
    ORDER BY COALESCE(last_success_at, last_attempt_at) DESC, symbol
    LIMIT ?
  `).all(safeLimit) as Array<{ symbol: string }>;
  return rows.map((row) => row.symbol);
}

/**
 * Replace one authoritative upstream range and extend its contiguous coverage atomically.
 * `points` must already contain at most one exact-decimal aggregate per timestamp.
 */
export function replaceFundingHistoryRange(
  database: Database.Database,
  symbol: string,
  startExclusive: number,
  endInclusive: number,
  points: readonly FundingRatePoint[],
  fetchedAt: string,
): void {
  const insert = database.prepare(`
    INSERT INTO funding_rate_history (symbol, funding_time, rate, fetched_at)
    VALUES (?, ?, ?, ?)
  `);
  database.transaction(() => {
    const existing = readFundingHistoryCoverage(database, symbol);
    if (existing && (startExclusive > existing.coveredTo || endInclusive < existing.coveredFrom)) {
      throw new Error(`Funding history range for ${symbol} is not contiguous with cached coverage`);
    }
    database.prepare(`
      DELETE FROM funding_rate_history
      WHERE symbol = ? AND funding_time > ? AND funding_time <= ?
    `).run(symbol, startExclusive, endInclusive);
    for (const point of points) insert.run(symbol, point.timestamp, point.rate, fetchedAt);
    database.prepare(`
      INSERT INTO funding_history_coverage (
        symbol, covered_from, covered_to, last_attempt_at, last_success_at, last_error_code
      ) VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(symbol) DO UPDATE SET
        covered_from = MIN(funding_history_coverage.covered_from, excluded.covered_from),
        covered_to = MAX(funding_history_coverage.covered_to, excluded.covered_to),
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = excluded.last_success_at,
        last_error_code = NULL
    `).run(symbol, startExclusive, endInclusive, fetchedAt, fetchedAt);
  })();
}

export function recordFundingHistoryFailure(
  database: Database.Database,
  symbol: string,
  attemptedAt: string,
  errorCode: string,
): void {
  database.prepare(`
    UPDATE funding_history_coverage
    SET last_attempt_at = ?, last_error_code = ?
    WHERE symbol = ?
  `).run(attemptedAt, errorCode, symbol);
}

export function pruneFundingRateHistory(database: Database.Database, cutoff: number): void {
  database.transaction(() => {
    database.prepare('DELETE FROM funding_rate_history WHERE funding_time <= ?').run(cutoff);
    database.prepare('DELETE FROM funding_history_coverage WHERE covered_to <= ?').run(cutoff);
    database.prepare(`
      UPDATE funding_history_coverage
      SET covered_from = ?
      WHERE covered_from < ?
    `).run(cutoff, cutoff);
  })();
}

export function replaceRiskLimits(
  database: Database.Database,
  limits: CrossExRiskLimit[],
  fetchedAt: string,
): void {
  const insert = database.prepare(`
    INSERT INTO crossex_risk_tiers (
      symbol, tier, min_risk_limit_value, max_risk_limit_value, quick_cal_amount,
      leverage_max, maintenance_rate, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  database.transaction(() => {
    for (const limit of limits) {
      database.prepare('DELETE FROM crossex_risk_tiers WHERE symbol = ?').run(limit.symbol);
      for (const tier of limit.tiers) {
        insert.run(
          limit.symbol, tier.tier, tier.minRiskLimitValue, tier.maxRiskLimitValue,
          tier.quickCalAmount, tier.leverageMax, tier.maintenanceRate, fetchedAt,
        );
      }
    }
  })();
}

interface RiskTierRow {
  symbol: string;
  tier: string;
  min_risk_limit_value: string;
  max_risk_limit_value: string;
  quick_cal_amount: string;
  leverage_max: string;
  maintenance_rate: string;
  fetched_at: string;
}

export function readRiskLimit(database: Database.Database, symbol: string): { item: CrossExRiskLimit; fetchedAt: string } | null {
  const rows = database.prepare(`
    SELECT symbol, tier, min_risk_limit_value, max_risk_limit_value, quick_cal_amount,
      leverage_max, maintenance_rate, fetched_at
    FROM crossex_risk_tiers WHERE symbol = ? ORDER BY CAST(tier AS INTEGER)
  `).all(symbol) as RiskTierRow[];
  if (rows.length === 0 || !rows[0]) return null;
  return {
    item: {
      symbol,
      tiers: rows.map((row) => ({
        tier: row.tier,
        minRiskLimitValue: row.min_risk_limit_value,
        maxRiskLimitValue: row.max_risk_limit_value,
        quickCalAmount: row.quick_cal_amount,
        leverageMax: row.leverage_max,
        maintenanceRate: row.maintenance_rate,
      })),
    },
    fetchedAt: rows[0].fetched_at,
  };
}

interface PublicMarketSnapshotRow {
  symbol: string;
  venue: 'BINANCE' | 'GATE' | 'OKX';
  product: 'FUTURE';
  bid_price: string | null;
  ask_price: string | null;
  last_price: string | null;
  mark_price: string;
  index_price: string;
  funding_rate: string;
  predicted_funding_rate: string | null;
  next_funding_at: string;
  source_timestamp: string;
  fetched_at: string;
  source: PublicMarketSnapshot['source'];
}

export function readPublicMarketSnapshot(database: Database.Database, symbol: string): PublicMarketSnapshot | null {
  const row = database.prepare(`
    SELECT symbol, venue, product, bid_price, ask_price, last_price, mark_price, index_price,
      funding_rate, predicted_funding_rate, next_funding_at, source_timestamp, fetched_at, source
    FROM public_market_snapshots WHERE symbol = ?
  `).get(symbol) as PublicMarketSnapshotRow | undefined;
  if (!row) return null;
  return {
    symbol: row.symbol, venue: row.venue, product: row.product,
    bidPrice: row.bid_price, askPrice: row.ask_price, lastPrice: row.last_price,
    markPrice: row.mark_price, indexPrice: row.index_price, fundingRate: row.funding_rate,
    predictedFundingRate: row.predicted_funding_rate, nextFundingAt: row.next_funding_at,
    sourceTimestamp: row.source_timestamp, fetchedAt: row.fetched_at, source: row.source,
  };
}

export function upsertPublicMarketSnapshot(database: Database.Database, snapshot: PublicMarketSnapshot): void {
  database.prepare(`
    INSERT INTO public_market_snapshots (
      symbol, venue, product, bid_price, ask_price, last_price, mark_price, index_price,
      funding_rate, predicted_funding_rate, next_funding_at, source_timestamp, fetched_at, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET
      venue = excluded.venue, product = excluded.product, bid_price = excluded.bid_price,
      ask_price = excluded.ask_price, last_price = excluded.last_price,
      mark_price = excluded.mark_price, index_price = excluded.index_price,
      funding_rate = excluded.funding_rate, predicted_funding_rate = excluded.predicted_funding_rate,
      next_funding_at = excluded.next_funding_at, source_timestamp = excluded.source_timestamp,
      fetched_at = excluded.fetched_at, source = excluded.source
  `).run(
    snapshot.symbol, snapshot.venue, snapshot.product, snapshot.bidPrice, snapshot.askPrice,
    snapshot.lastPrice, snapshot.markPrice, snapshot.indexPrice, snapshot.fundingRate,
    snapshot.predictedFundingRate, snapshot.nextFundingAt, snapshot.sourceTimestamp,
    snapshot.fetchedAt, snapshot.source,
  );
}

export function savePortfolioSnapshot(database: Database.Database, snapshot: PortfolioSnapshot): void {
  const validated = PortfolioSnapshotSchema.parse(snapshot);
  database.transaction(() => {
    database.prepare(`
      INSERT INTO portfolio_snapshots (id, fetched_at, remote_updated_at, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), validated.fetchedAt, validated.account.remoteUpdatedAt, JSON.stringify(validated));
    database.prepare(`
      DELETE FROM portfolio_snapshots
      WHERE id NOT IN (SELECT id FROM portfolio_snapshots ORDER BY fetched_at DESC LIMIT 20)
    `).run();
  })();
}

export function readLatestPortfolioSnapshot(database: Database.Database): PortfolioSnapshot | null {
  const row = database.prepare(`
    SELECT payload_json FROM portfolio_snapshots ORDER BY fetched_at DESC LIMIT 1
  `).get() as { payload_json: string } | undefined;
  if (!row) return null;
  try {
    return PortfolioSnapshotSchema.parse(JSON.parse(row.payload_json) as unknown);
  } catch {
    return null;
  }
}

/** Minimum spacing between two recorded equity samples of one database (refresh-button debounce). */
const PORTFOLIO_EQUITY_MIN_INTERVAL_MS = 60_000;
/** Last recorded sample time per database; WeakMap keeps closed databases collectable. */
const lastPortfolioEquitySampleAt = new WeakMap<Database.Database, number>();

export interface PortfolioEquitySampleResult {
  /** `false` when the sample was suppressed by the debounce or carried an unusable timestamp. */
  recorded: boolean;
  sampledAtMs: number;
}

/**
 * Persist one equity sample at every granularity: the exact raw timestamp plus its floored
 * hour/day buckets (see `migrations/0023_portfolio_equity_samples.sql`). Equity comes from
 * `accountEquityOf(snapshot)` — stablecoin cash across the CrossEx venues plus open-position uPnL,
 * the same figure the asset page shows as the "Total equity" KPI — and deliberately **not** from
 * `snapshot.account.marginBalance`, which subtracts the locked margin of DEX legs without adding it
 * back (a hedged pair would halve the curve while it is open). `unrealizedPnl` sums futures and
 * margin positions. Gate spot balances are kept out: the `SPOT` rows belong to the isolated Gate
 * spot account, not to the CrossEx margin account.
 *
 * Samples are debounced to at most one per minute per database so refresh-button spam cannot
 * produce dense raw points; the ~5 minute background reconciliation cadence is unaffected.
 * A back-dated timestamp (clock moved backwards) is still recorded — the upsert simply
 * overwrites the affected buckets.
 */
export function recordPortfolioEquitySample(
  database: Database.Database,
  snapshot: PortfolioEquitySnapshotInput,
  sampledAtMs: number,
): PortfolioEquitySampleResult {
  const sampledAt = Number.isFinite(sampledAtMs) ? Math.max(0, Math.trunc(sampledAtMs)) : 0;
  if (sampledAt <= 0) return { recorded: false, sampledAtMs: sampledAt };
  const previousAt = lastPortfolioEquitySampleAt.get(database);
  if (previousAt !== undefined && sampledAt >= previousAt
    && sampledAt - previousAt < PORTFOLIO_EQUITY_MIN_INTERVAL_MS) {
    return { recorded: false, sampledAtMs: sampledAt };
  }
  const point = portfolioEquitySampleFromSnapshot(snapshot, sampledAt);
  const upsert = database.prepare(`
    INSERT INTO portfolio_equity_samples (granularity, bucket_start, sampled_at, equity, unrealized_pnl)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(granularity, bucket_start) DO UPDATE SET
      sampled_at = excluded.sampled_at,
      equity = excluded.equity,
      unrealized_pnl = excluded.unrealized_pnl
  `);
  database.transaction(() => {
    for (const granularity of ['raw', 'hour', 'day'] as const) {
      upsert.run(granularity, equityBucketStart(sampledAt, granularity), sampledAt, point.equity, point.unrealizedPnl);
    }
  })();
  lastPortfolioEquitySampleAt.set(database, sampledAt);
  return { recorded: true, sampledAtMs: sampledAt };
}

/**
 * Read the persisted equity series of one granularity from `fromMs` (inclusive), oldest first.
 * Returns an empty array when nothing has been sampled yet — the empty state, never an error.
 */
export function readPortfolioEquitySeries(
  database: Database.Database,
  granularity: PortfolioEquityGranularity,
  fromMs: number,
): PortfolioEquityPoint[] {
  const safeFrom = Number.isFinite(fromMs) ? Math.max(0, Math.trunc(fromMs)) : 0;
  const rows = database.prepare(`
    SELECT bucket_start, equity, unrealized_pnl
    FROM portfolio_equity_samples
    WHERE granularity = ? AND bucket_start >= ?
    ORDER BY bucket_start
  `).all(granularity, safeFrom) as Array<{ bucket_start: number; equity: string; unrealized_pnl: string | null }>;
  return rows.map((row) => ({ time: row.bucket_start, equity: row.equity, unrealizedPnl: row.unrealized_pnl }));
}

/** Epoch ms of the oldest sample of any granularity; `null` when nothing was ever recorded. */
export function readPortfolioEquityFirstSampleAt(database: Database.Database): number | null {
  const row = database.prepare('SELECT MIN(bucket_start) AS first_bucket FROM portfolio_equity_samples')
    .get() as { first_bucket: number | null } | undefined;
  return row?.first_bucket ?? null;
}

/**
 * Delete samples older than each granularity's retention window (raw 7d, hour 45d, day 730d,
 * per `PORTFOLIO_EQUITY_RETENTION_MS`). Returns the number of deleted rows.
 */
export function prunePortfolioEquitySamples(database: Database.Database, nowMs: number): number {
  const safeNow = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : 0;
  return database.transaction(() => {
    let deleted = 0;
    for (const granularity of ['raw', 'hour', 'day'] as const) {
      deleted += database.prepare(`
        DELETE FROM portfolio_equity_samples WHERE granularity = ? AND bucket_start < ?
      `).run(granularity, safeNow - PORTFOLIO_EQUITY_RETENTION_MS[granularity]).changes;
    }
    return deleted;
  })();
}

/** One 30-second spread sample (see `migrations/0024_spread_samples.sql`). */
export interface SpreadSampleRow {
  pairType: 'SPOT_PERP' | 'PERP_PERP';
  asset: string;
  leftSymbol: string;
  rightSymbol: string;
  /** Epoch ms aligned to the sampler's 30s boundary; part of the upsert key. */
  sampledAt: number;
  spreadBps: number;
  depthUsdt: number;
  leftPrice: number | null;
  rightPrice: number | null;
}

/** Coverage of one pair's samples inside a window, driving the samples-source switch. */
export interface SpreadSampleCoverage {
  count: number;
  oldestMs: number;
  newestMs: number;
}

/**
 * Composite key of one (left, right) pair. CrossEx symbols are uppercase alphanumerics plus
 * underscores, so `|` can never collide with a symbol boundary.
 */
export function spreadSamplePairKey(leftSymbol: string, rightSymbol: string): string {
  return `${leftSymbol}|${rightSymbol}`;
}

/**
 * Batch-upsert spread samples in one transaction. `sampled_at` is part of the primary key,
 * so a retried tick rewrites its 30s bucket instead of duplicating a point. Rows carrying an
 * unusable timestamp or non-finite numbers are dropped rather than written as zeros — the
 * same "missing data is never fabricated" rule the quality board follows. Returns the number
 * of rows written.
 */
export function recordSpreadSamples(database: Database.Database, rows: readonly SpreadSampleRow[]): number {
  const usable = rows.filter((row) =>
    Number.isFinite(row.sampledAt) && row.sampledAt > 0
    && Number.isFinite(row.spreadBps)
    && Number.isFinite(row.depthUsdt) && row.depthUsdt >= 0
    && (row.leftPrice === null || Number.isFinite(row.leftPrice))
    && (row.rightPrice === null || Number.isFinite(row.rightPrice)));
  if (usable.length === 0) return 0;
  const upsert = database.prepare(`
    INSERT INTO spread_samples (pair_type, asset, left_symbol, right_symbol, sampled_at, spread_bps, depth_usdt, left_price, right_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(left_symbol, right_symbol, sampled_at) DO UPDATE SET
      pair_type = excluded.pair_type,
      asset = excluded.asset,
      spread_bps = excluded.spread_bps,
      depth_usdt = excluded.depth_usdt,
      left_price = excluded.left_price,
      right_price = excluded.right_price
  `);
  database.transaction(() => {
    for (const row of usable) {
      upsert.run(
        row.pairType, row.asset, row.leftSymbol, row.rightSymbol,
        Math.trunc(row.sampledAt), row.spreadBps, row.depthUsdt, row.leftPrice, row.rightPrice,
      );
    }
  })();
  return usable.length;
}

/**
 * Read one pair's sample series from `fromMs` (inclusive), oldest first. Returns an empty
 * array when the pair was never sampled — the empty state, never an error.
 */
export function readSpreadSeries(
  database: Database.Database,
  leftSymbol: string,
  rightSymbol: string,
  fromMs: number,
): SpreadSampleRow[] {
  const safeFrom = Number.isFinite(fromMs) ? Math.max(0, Math.trunc(fromMs)) : 0;
  const rows = database.prepare(`
    SELECT pair_type, asset, left_symbol, right_symbol, sampled_at, spread_bps, depth_usdt, left_price, right_price
    FROM spread_samples
    WHERE left_symbol = ? AND right_symbol = ? AND sampled_at >= ?
    ORDER BY sampled_at
  `).all(leftSymbol, rightSymbol, safeFrom) as Array<{
    pair_type: string; asset: string; left_symbol: string; right_symbol: string;
    sampled_at: number; spread_bps: number; depth_usdt: number;
    left_price: number | null; right_price: number | null;
  }>;
  return rows.map((row) => ({
    pairType: row.pair_type as SpreadSampleRow['pairType'],
    asset: row.asset,
    leftSymbol: row.left_symbol,
    rightSymbol: row.right_symbol,
    sampledAt: row.sampled_at,
    spreadBps: row.spread_bps,
    depthUsdt: row.depth_usdt,
    leftPrice: row.left_price,
    rightPrice: row.right_price,
  }));
}

/**
 * Coverage (count, oldest, newest) of each requested pair's samples inside `[fromMs, ∞)`,
 * keyed by `spreadSamplePairKey`. Pairs without samples in the window are absent from the
 * map, so callers read "no samples yet" as a missing key rather than a zero row. One indexed
 * statement per pair keeps this cheap at the candidate cap (≤ 50).
 */
export function spreadSampleCoverage(
  database: Database.Database,
  pairs: ReadonlyArray<{ leftSymbol: string; rightSymbol: string }>,
  fromMs: number,
): Map<string, SpreadSampleCoverage> {
  const coverage = new Map<string, SpreadSampleCoverage>();
  if (pairs.length === 0) return coverage;
  const safeFrom = Number.isFinite(fromMs) ? Math.max(0, Math.trunc(fromMs)) : 0;
  const statement = database.prepare(`
    SELECT COUNT(*) AS count, MIN(sampled_at) AS oldest_ms, MAX(sampled_at) AS newest_ms
    FROM spread_samples
    WHERE left_symbol = ? AND right_symbol = ? AND sampled_at >= ?
  `);
  for (const pair of pairs) {
    const row = statement.get(pair.leftSymbol, pair.rightSymbol, safeFrom) as {
      count: number; oldest_ms: number | null; newest_ms: number | null;
    } | undefined;
    if (row === undefined || row.count === 0 || row.oldest_ms === null || row.newest_ms === null) continue;
    coverage.set(spreadSamplePairKey(pair.leftSymbol, pair.rightSymbol), {
      count: row.count,
      oldestMs: row.oldest_ms,
      newestMs: row.newest_ms,
    });
  }
  return coverage;
}

/** Delete samples older than `olderThanMs` (exclusive). Returns the number of deleted rows. */
export function pruneSpreadSamples(database: Database.Database, olderThanMs: number): number {
  const safeCutoff = Number.isFinite(olderThanMs) ? Math.max(0, Math.trunc(olderThanMs)) : 0;
  return database.prepare('DELETE FROM spread_samples WHERE sampled_at < ?').run(safeCutoff).changes;
}

export function saveReconciliationReport(database: Database.Database, report: ReconciliationReport): void {
  const validated = ReconciliationReportSchema.parse(report);
  database.transaction(() => {
    database.prepare(`
      INSERT INTO reconciliation_reports (id, created_at, status, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(validated.id, validated.createdAt, validated.status, JSON.stringify(validated));
    database.prepare(`
      DELETE FROM reconciliation_reports
      WHERE id NOT IN (SELECT id FROM reconciliation_reports ORDER BY created_at DESC LIMIT 100)
    `).run();
  })();
}

export function listReconciliationReports(database: Database.Database, limit = 20): ReconciliationReport[] {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = database.prepare(`
    SELECT payload_json FROM reconciliation_reports ORDER BY created_at DESC LIMIT ?
  `).all(safeLimit) as Array<{ payload_json: string }>;
  return rows.map((row) => ReconciliationReportSchema.parse(JSON.parse(row.payload_json) as unknown));
}
