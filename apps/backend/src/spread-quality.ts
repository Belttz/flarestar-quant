import type {
  AssetClass,
  AssetSuperClass,
  Candle,
  CandleInterval,
  FundingOverviewResponse,
  SpreadCombination,
  SpreadOpportunity,
  SpreadQualityResponse,
  SpreadQualityRow,
} from '@gate-crossex/shared-types';
import type { LiveMarket } from './market-hub.js';
import type {
  OpportunityCatalogView,
  OpportunityFundingView,
  OpportunityMarketHubView,
  SortDirection,
  SpreadPairType,
} from './opportunity-service.js';
import type { SpreadSampleCoverage, SpreadSampleRow } from './repositories.js';
import { spreadSamplePairKey } from './repositories.js';

/** Reconstruction window: 24 hours of 5-minute candles. */
export const SPREAD_QUALITY_WINDOW_HOURS = 24;
/** The same window in milliseconds, used for sample-span checks. */
export const SPREAD_QUALITY_WINDOW_MS = SPREAD_QUALITY_WINDOW_HOURS * 60 * 60_000;
/** Points inside the window: 24h × 12 points per hour. */
export const SPREAD_QUALITY_WINDOW_POINTS = 24 * 12;
/** Candle interval the series is rebuilt from. */
export const SPREAD_QUALITY_INTERVAL: CandleInterval = '5m';
/** Minutes per candle, used to turn an AR(1) half-life in points into hours. */
const SPREAD_QUALITY_INTERVAL_MINUTES = 5;
/**
 * Cadence of the spread sampler's local sample store (see `spread-sampler.ts` and
 * `migrations/0024_spread_samples.sql`): one point per 30s boundary.
 */
export const SPREAD_SAMPLE_INTERVAL_MS = 30_000;
/** Minutes per sample point — the half-life conversion for the `samples` source. */
export const SPREAD_SAMPLE_MINUTES_PER_POINT = 0.5;
/** Points in a full 24h of 30s samples. */
export const SPREAD_SAMPLE_WINDOW_POINTS = 2880;
/**
 * Minimum points a samples-sourced series must carry (2 hours at 30s). A thinner series
 * never reaches the board: twelve minutes of data cannot support a distribution reading,
 * and the pair falls back to candles instead.
 */
export const SPREAD_SAMPLE_MIN_POINTS = 240;
/**
 * Promotion threshold for the samples source: 80% coverage of the 24h window (2304 of 2880
 * points). Below it the pair keeps using candles — the sampler having run for a few hours
 * must not outrank a full day of venue candles.
 */
export const SPREAD_SAMPLE_MIN_COVERAGE_POINTS = 2304;
/**
 * One REST page of venue candles. Every connected venue caps a candlestick request at 500
 * rows, and 288 points always fit inside a single page — no pagination is ever needed.
 */
export const SPREAD_QUALITY_CANDLE_PAGE_LIMIT = 500;
/**
 * Rows whose aligned series is shorter than this never reach the board: two hours of 5m
 * candles is the minimum a mean/volatility reading can be trusted on.
 */
const MIN_SAMPLE_POINTS = 24;
/**
 * Candidate cap. Each candidate costs two REST candle calls (one per leg), so 50 candidates
 * bound one computation at 100 upstream requests; the 5-minute TTL keeps that amortised.
 */
export const MAX_SPREAD_QUALITY_CANDIDATES = 50;
/**
 * Page size the app asks the opportunity board for when feeding this service. The board
 * computes its full row set per filter set and only slices on `limit`, so one large page
 * retrieves every asset row (each carrying all of its combinations) in a single computation
 * shared with the UI's own board request.
 */
export const SPREAD_BOARD_FETCH_LIMIT = 1000;
/** In-flight candle requests during one computation; keeps the venue fan-out polite. */
const DEFAULT_CANDLE_CONCURRENCY = 10;
/** Computed boards are reused for 5 minutes — the series moves in 5m candles anyway. */
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
/** Cache capacity; pair-type queries are few, so this only guards against runaway growth. */
const DEFAULT_CACHE_MAX_ENTRIES = 16;
/** Expected holding window when the series does not revert (no half-life): 4 hours. */
const DEFAULT_HOLDING_HOURS = 4;
/**
 * Taker fee per side in bps. Matches the notional fee measured in execution_fills
 * (notional × 4.8bps per fill). Maker orders are deliberately not modelled: the board
 * ranks capturable spreads, and assuming both legs cross the book is the conservative
 * case — a maker fill would only make the real cost lower than reported.
 */
const TAKER_FEE_BPS_PER_SIDE = 4.8;
/** Round trip (sell leg + buy leg) taker cost in bps. */
const ROUND_TRIP_TAKER_FEE_BPS = TAKER_FEE_BPS_PER_SIDE * 2;
/**
 * Composite weights over the six factors. They sum to 1 so `score` stays on 0–100; the
 * ordering encodes the product intent: capturable edge (net mean) dominates, stability
 * (volatility) and reversion speed next, shape (skew/kurtosis) and depth as tie-breakers.
 */
const FACTOR_WEIGHTS = {
  netMean: 0.30,
  volatility: 0.20,
  reversionSpeed: 0.15,
  skewness: 0.15,
  excessKurtosis: 0.10,
  bookDepth: 0.10,
} as const;
/** CrossEx perpetual symbol shape; spot legs (`_SPOT_`) never match and never pay funding. */
const CROSSEX_FUTURE_SYMBOL = /^[A-Z0-9]+_FUTURE_[A-Z0-9]+_(?:USDT|USDC|USD)$/;

/**
 * Distribution statistics of one spread series, in bps.
 *
 * Every scale-dependent moment is `null` — never zero — when the series cannot support
 * it: a degenerate (constant) series has no skewness, kurtosis or autocorrelation to
 * report, and fabricating zeros there would rank noise as if it were information.
 */
export interface SpreadSeriesStatistics {
  /** ΣS / n. */
  mean: number | null;
  /** Population standard deviation sqrt(Σ(S−mean)² / n). */
  volatility: number | null;
  /** Third central moment over σ³; positive means the wide spreads lean favourable. */
  skewness: number | null;
  /** Fourth central moment over σ⁴ minus 3; fat tails mean occasional extreme spreads. */
  excessKurtosis: number | null;
  median: number | null;
  /** |skewness| < 0.5 and |mean − median| < 0.25σ — the distribution behaves as modelled. */
  symmetric: boolean;
  /** Lag-1 Pearson correlation of the series; ≥ 1 trends instead of reverting. */
  ar1Coefficient: number | null;
  /** ln(0.5) / ln(φ) in hours; null when the series does not mean-revert. */
  halfLifeHours: number | null;
}

/**
 * Distribution statistics of a spread series (bps, any length).
 *
 * Population moments are used throughout (divide by n, not n−1): the series is the whole
 * 24h window, not a sample from a larger one. `minutesPerPoint` is the cadence of the
 * series' points — 5 for 5m candles, 0.5 for 30s samples — and converts the AR(1)
 * coefficient's point units into hours; φ outside (0, 1) means the series does not revert,
 * so the half-life is null rather than a meaningless number.
 */
export function computeSpreadStatistics(
  series: readonly number[],
  minutesPerPoint: number = SPREAD_QUALITY_INTERVAL_MINUTES,
): SpreadSeriesStatistics {
  const values = series.filter((value) => Number.isFinite(value));
  const n = values.length;
  if (n === 0) {
    return {
      mean: null, volatility: null, skewness: null, excessKurtosis: null, median: null,
      symmetric: false, ar1Coefficient: null, halfLifeHours: null,
    };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
  const volatility = Math.sqrt(variance);
  const median = medianOf(values);
  if (!(volatility > 0)) {
    // Degenerate series: every moment that needs a scale is null, never a fake zero.
    return {
      mean, volatility, skewness: null, excessKurtosis: null, median,
      symmetric: false, ar1Coefficient: null, halfLifeHours: null,
    };
  }
  const thirdMoment = values.reduce((sum, value) => sum + (value - mean) ** 3, 0) / n;
  const fourthMoment = values.reduce((sum, value) => sum + (value - mean) ** 4, 0) / n;
  const skewness = thirdMoment / volatility ** 3;
  const excessKurtosis = fourthMoment / volatility ** 4 - 3;
  const ar1Coefficient = lagOneCorrelation(values);
  const halfLifeHours = halfLifeFromAr1(ar1Coefficient, minutesPerPoint);
  return {
    mean,
    volatility,
    skewness,
    excessKurtosis,
    median,
    symmetric: Math.abs(skewness) < 0.5 && Math.abs(mean - median) < 0.25 * volatility,
    ar1Coefficient,
    halfLifeHours,
  };
}

/** Median of a non-empty numeric series. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * AR(1) coefficient: Pearson correlation between S(t) and S(t−1) over the n−1 overlapping
 * pairs. Null when there are fewer than two pairs or either side is constant — a correlation
 * without variation on both sides is undefined, not zero.
 */
function lagOneCorrelation(series: readonly number[]): number | null {
  if (series.length < 3) return null;
  const left = series.slice(0, -1);
  const right = series.slice(1);
  const pairs = left.length;
  const meanLeft = left.reduce((sum, value) => sum + value, 0) / pairs;
  const meanRight = right.reduce((sum, value) => sum + value, 0) / pairs;
  let covariance = 0;
  let deviationLeft = 0;
  let deviationRight = 0;
  for (let index = 0; index < pairs; index += 1) {
    const spreadLeft = left[index]! - meanLeft;
    const spreadRight = right[index]! - meanRight;
    covariance += spreadLeft * spreadRight;
    deviationLeft += spreadLeft ** 2;
    deviationRight += spreadRight ** 2;
  }
  if (!(deviationLeft > 0) || !(deviationRight > 0)) return null;
  const phi = covariance / Math.sqrt(deviationLeft * deviationRight);
  return Number.isFinite(phi) ? phi : null;
}

/**
 * Hours for a dislocation to halve, from an AR(1) coefficient: ln(0.5) / ln(φ) measured in
 * series points, converted to hours by `minutesPerPoint` (5 for candles, 0.5 for samples).
 * Null when φ ≤ 0 (no reversion) or φ ≥ 1 (trending) — neither has a halving time.
 */
export function halfLifeFromAr1(
  ar1Coefficient: number | null,
  minutesPerPoint: number = SPREAD_QUALITY_INTERVAL_MINUTES,
): number | null {
  if (ar1Coefficient === null || !Number.isFinite(ar1Coefficient)) return null;
  if (ar1Coefficient <= 0 || ar1Coefficient >= 1) return null;
  if (!Number.isFinite(minutesPerPoint) || minutesPerPoint <= 0) return null;
  const halfLives = Math.log(0.5) / Math.log(ar1Coefficient);
  const hours = (halfLives * minutesPerPoint) / 60;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
}

/**
 * Ascending ranks (1-based) with ties sharing the average of the ranks they span, so a
 * factor where many candidates tie does not invent an ordering among them.
 */
export function averageRanks(values: readonly number[]): number[] {
  const ordered = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = new Array<number>(values.length).fill(0);
  let position = 0;
  while (position < ordered.length) {
    let end = position;
    while (end + 1 < ordered.length && ordered[end + 1]!.value === ordered[position]!.value) {
      end += 1;
    }
    const average = (position + end) / 2 + 1;
    for (let index = position; index <= end; index += 1) {
      ranks[ordered[index]!.index] = average;
    }
    position = end + 1;
  }
  return ranks;
}

/**
 * Group percentiles P ∈ [0, 1]: ascending rank divided by (n − 1), ties averaged. A null
 * factor takes the worst percentile (0) — missing data never scores as if it were good,
 * and it never scores as a fabricated value either. A single-value group has no spread to
 * rank within, so its one value sits at the neutral midpoint.
 */
export function percentileRanks(values: readonly (number | null)[]): number[] {
  const usable = values.map((value) => (value !== null && Number.isFinite(value) ? value : null));
  const present = usable.filter((value): value is number => value !== null);
  if (present.length === 0) return usable.map(() => 0);
  if (present.length === 1) return usable.map((value) => (value === null ? 0 : 0.5));
  const ranks = averageRanks(present);
  let cursor = 0;
  return usable.map((value) => {
    if (value === null) return 0;
    const rank = ranks[cursor]!;
    cursor += 1;
    return (rank - 1) / (present.length - 1);
  });
}

/**
 * One candidate that survived candle reconstruction, carrying everything the composite
 * score and the response row need. Statistics stay nullable here exactly as computed —
 * the scoring layer decides how nulls rank, it never rewrites them.
 */
export interface SpreadQualityScoreInput {
  pairType: SpreadPairType;
  asset: string;
  leftSymbol: string;
  rightSymbol: string;
  leftVenue: string;
  rightVenue: string;
  currentSpreadBps: number;
  updatedAt: string;
  assetClass: AssetClass;
  assetSuperClass: AssetSuperClass;
  variantSuffix: string | null;
  isPreIpo: boolean;
  sampleCount: number;
  meanSpreadBps: number | null;
  spreadVolatilityBps: number | null;
  skewness: number | null;
  excessKurtosis: number | null;
  symmetric: boolean;
  ar1Coefficient: number | null;
  halfLifeHours: number | null;
  holdingCostBps: number | null;
  bookDepthUsdt: number;
  /** Which track rebuilt the series: 24h candles or the local 30s sample store. */
  source: SpreadQualityRow['source'];
}

/**
 * Weighted-percentile composite over the candidate group, ranked best-first.
 *
 * Six factors, each turned into a group percentile (null → worst percentile): net mean
 * spread (mean minus holding cost, where a missing cost is charged at the group's maximum),
 * volatility, reversion speed (1 / half-life; no half-life is the worst case), skewness,
 * excess kurtosis and book depth. `score = 100 × Σ weight × percentile`, so the board head
 * is the most capturable spread, not merely the widest one. Rows without a usable mean
 * never reach the board at all.
 */
export function scoreSpreadQualityInputs(inputs: readonly SpreadQualityScoreInput[]): SpreadQualityRow[] {
  const boardable = inputs.filter(
    (input) => input.meanSpreadBps !== null && Number.isFinite(input.meanSpreadBps),
  );
  // A missing funding input makes a pair maximally expensive for scoring — never free.
  const knownCosts = boardable
    .map((input) => input.holdingCostBps)
    .filter((cost): cost is number => cost !== null && Number.isFinite(cost));
  const worstHoldingCost = knownCosts.reduce((max, cost) => Math.max(max, cost), Number.NEGATIVE_INFINITY);
  const holdingCostFallback = knownCosts.length > 0 ? worstHoldingCost : 0;
  const netMean = boardable.map(
    (input) => (input.meanSpreadBps as number) - (input.holdingCostBps ?? holdingCostFallback),
  );
  const volatility = boardable.map((input) => input.spreadVolatilityBps);
  const reversionSpeed = boardable.map((input) => (
    input.halfLifeHours !== null && input.halfLifeHours > 0 ? 1 / input.halfLifeHours : null
  ));
  const skewness = boardable.map((input) => input.skewness);
  const excessKurtosis = boardable.map((input) => input.excessKurtosis);
  const bookDepth = boardable.map((input) => (Number.isFinite(input.bookDepthUsdt) ? input.bookDepthUsdt : null));
  const percentileNetMean = percentileRanks(netMean);
  const percentileVolatility = percentileRanks(volatility);
  const percentileReversion = percentileRanks(reversionSpeed);
  const percentileSkewness = percentileRanks(skewness);
  const percentileKurtosis = percentileRanks(excessKurtosis);
  const percentileBookDepth = percentileRanks(bookDepth);
  const rows: SpreadQualityRow[] = boardable.map((input, index) => ({
    pairType: input.pairType,
    asset: input.asset,
    leftSymbol: input.leftSymbol,
    rightSymbol: input.rightSymbol,
    leftVenue: input.leftVenue,
    rightVenue: input.rightVenue,
    currentSpreadBps: input.currentSpreadBps,
    meanSpreadBps: input.meanSpreadBps,
    spreadVolatilityBps: input.spreadVolatilityBps,
    skewness: input.skewness,
    excessKurtosis: input.excessKurtosis,
    symmetric: input.symmetric,
    ar1Coefficient: input.ar1Coefficient,
    halfLifeHours: input.halfLifeHours,
    holdingCostBps: input.holdingCostBps,
    bookDepthUsdt: Number.isFinite(input.bookDepthUsdt) ? input.bookDepthUsdt : 0,
    score: 100 * (
      FACTOR_WEIGHTS.netMean * percentileNetMean[index]!
      + FACTOR_WEIGHTS.volatility * percentileVolatility[index]!
      + FACTOR_WEIGHTS.reversionSpeed * percentileReversion[index]!
      + FACTOR_WEIGHTS.skewness * percentileSkewness[index]!
      + FACTOR_WEIGHTS.excessKurtosis * percentileKurtosis[index]!
      + FACTOR_WEIGHTS.bookDepth * percentileBookDepth[index]!
    ),
    sampleCount: input.sampleCount,
    source: input.source,
    updatedAt: input.updatedAt,
    assetClass: input.assetClass,
    assetSuperClass: input.assetSuperClass,
    variantSuffix: input.variantSuffix,
    isPreIpo: input.isPreIpo,
  }));
  rows.sort((left, right) => right.score - left.score
    || right.currentSpreadBps - left.currentSpreadBps
    || left.asset.localeCompare(right.asset)
    || left.leftSymbol.localeCompare(right.leftSymbol)
    || left.rightSymbol.localeCompare(right.rightSymbol));
  return rows;
}

/**
 * Rebuild the spread series of one candidate from its two legs' candles.
 *
 * S(t) = (leftClose(t) − rightClose(t)) / rightClose(t) × 10⁴ in bps, aligned on candle
 * open time — the same orientation as the engine's spread = sellBid − buyAsk. Only points
 * where both legs quoted are kept, and the series is trimmed to the newest 24h window.
 * Candles with a missing or non-positive close are treated as absent, never as zero.
 */
export function alignSpreadSeries(leftCandles: readonly Candle[], rightCandles: readonly Candle[]): number[] {
  const leftCloses = closesByStartTime(leftCandles);
  const rightCloses = closesByStartTime(rightCandles);
  const aligned: Array<{ startTime: number; spreadBps: number }> = [];
  for (const [startTime, leftClose] of leftCloses) {
    const rightClose = rightCloses.get(startTime);
    if (rightClose === undefined) continue;
    aligned.push({ startTime, spreadBps: ((leftClose - rightClose) / rightClose) * 10_000 });
  }
  aligned.sort((left, right) => left.startTime - right.startTime);
  return aligned.slice(-SPREAD_QUALITY_WINDOW_POINTS).map((point) => point.spreadBps);
}

function closesByStartTime(candles: readonly Candle[]): Map<number, number> {
  const closes = new Map<number, number>();
  for (const candle of candles) {
    const close = Number(candle.close);
    if (!Number.isFinite(close) || close <= 0) continue;
    closes.set(candle.startTime, close);
  }
  return closes;
}

/**
 * Subset of the CrossEx market hub the quality board reads: only top-of-book depth is
 * needed, mirroring `OpportunityMarketHubView` without its registration seam.
 */
export type SpreadQualityMarketHubView = Pick<OpportunityMarketHubView, 'market'>;

export interface SpreadQualityDependencies {
  fundingOverview: OpportunityFundingView;
  hub: SpreadQualityMarketHubView;
  /**
   * Asset-level spread board rows — every (sell venue, buy venue) combination included —
   * behind the candidate set. The opportunity board caches its own computation, so this
   * stays a cheap read.
   */
  spreadBoard: (catalog: OpportunityCatalogView) => Promise<readonly SpreadOpportunity[]>;
  /**
   * One page of 5m candles for a CrossEx symbol; each venue routes spot and perpetual legs
   * to its own candlestick endpoint. A rejection resolves to an empty page so one dead leg
   * skips its candidate instead of failing the whole request.
   */
  loadCandles: (symbol: string) => Promise<readonly Candle[]>;
  /**
   * Local 30s sample store — the board's second reconstruction track. Optional: without it
   * every row is rebuilt from candles exactly as before, and a pair whose samples never
   * reach the 24h coverage threshold stays on candles even when the store is wired.
   */
  samples?: SpreadQualitySampleSource;
}

export interface SpreadQualityServiceOptions {
  now?: () => number;
  /** How long a computed board is reused; the production default is 5 minutes. */
  cacheTtlMs?: number;
  /** Cache capacity. */
  cacheMaxEntries?: number;
  /** Candidate cap before the candle fan-out; the production default is 50. */
  candidateLimit?: number;
  /** In-flight candle requests per computation. */
  candleConcurrency?: number;
}

/** Query selecting one board variant; `limit` slices the ranked rows. */
export interface SpreadQualityQuery {
  pairType?: SpreadPairType;
  limit: number;
  /** Server-side sort key over the cached board (R8); default keeps the composite score. */
  sort?: SpreadQualitySortKey;
  /** Sort direction; default `desc` matches every board's historical ranking. */
  dir?: SortDirection;
  /** First row of the returned page (server-side paging over the sorted board). */
  offset?: number;
}

/** Column the quality board can be server-sorted by (R8). */
export type SpreadQualitySortKey = 'score' | 'current' | 'mean' | 'volatility' | 'halfLife' | 'depth';

/**
 * Server-side ordering of the quality board (R8): sort on the full cached row set, then slice
 * the requested page. Nulls sort last in both directions — a missing measurement never ranks —
 * and the tie-break chain mirrors `scoreSpreadQualityInputs` so the default `score`/`desc` query
 * reproduces the board's own ranking exactly.
 */
export function sortSpreadQualityRows(
  rows: readonly SpreadQualityRow[],
  sort: SpreadQualitySortKey = 'score',
  dir: SortDirection = 'desc',
): SpreadQualityRow[] {
  const direction = dir === 'asc' ? 1 : -1;
  const finiteOrNull = (value: number | null | undefined): number | null =>
    value !== null && value !== undefined && Number.isFinite(value) ? value : null;
  const compareNullable = (left: number | null, right: number | null): number => {
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return (left - right) * direction;
  };
  const key = (row: SpreadQualityRow): number | null => {
    switch (sort) {
      case 'current': return finiteOrNull(row.currentSpreadBps);
      case 'mean': return finiteOrNull(row.meanSpreadBps);
      case 'volatility': return finiteOrNull(row.spreadVolatilityBps);
      case 'halfLife': return finiteOrNull(row.halfLifeHours);
      case 'depth': return finiteOrNull(row.bookDepthUsdt);
      default: return finiteOrNull(row.score);
    }
  };
  return [...rows].sort((left, right) => compareNullable(key(left), key(right))
    // The documented board contract (see rankSpreadQualityRows) breaks score ties by the
    // current spread before falling back to symbols — the route-level QA fixture pins it,
    // so every sort key reuses the same secondary chain to stay contract-stable.
    || right.currentSpreadBps - left.currentSpreadBps
    || right.score - left.score
    || left.asset.localeCompare(right.asset)
    || left.leftSymbol.localeCompare(right.leftSymbol)
    || left.rightSymbol.localeCompare(right.rightSymbol));
}

/** The complete ranked row set for one query, before the top-N cut. */
export interface SpreadQualityBoard {
  rows: SpreadQualityRow[];
  totalCandidates: number;
  windowHours: number;
  cacheStatus: SpreadQualityResponse['cacheStatus'];
  fetchedAt: string;
}

interface SpreadQualityCacheEntry {
  key: string;
  expiresAt: number;
  promise: Promise<SpreadQualityBoard>;
}

/** One (asset, sell venue, buy venue) combination selected for reconstruction. */
export interface SpreadQualityCandidate {
  pairType: SpreadPairType;
  asset: string;
  combination: SpreadCombination;
  classification: Pick<SpreadQualityRow, 'assetClass' | 'assetSuperClass' | 'variantSuffix' | 'isPreIpo'>;
  bookDepthUsdt: number;
}

/**
 * Local 30s sample store behind the `samples` track of the board (see `spread-sampler.ts`
 * and `migrations/0024_spread_samples.sql`). Both reads are cheap: coverage is one indexed
 * aggregate per pair at the candidate cap (≤ 50), and the series read only runs for pairs
 * that already earned promotion.
 */
export interface SpreadQualitySampleSource {
  coverage(
    pairs: ReadonlyArray<{ leftSymbol: string; rightSymbol: string }>,
    fromMs: number,
  ): Map<string, SpreadSampleCoverage>;
  series(leftSymbol: string, rightSymbol: string, fromMs: number): readonly SpreadSampleRow[];
}

/**
 * Executable combinations of the board, ranked by how much money the current dislocation
 * can actually move (|spread| × absorbable depth) and capped so the candle fan-out stays
 * bounded. Non-executable combinations and other pair types never become candidates.
 *
 * Shared with `spread-sampler.ts`: the sampler persists exactly the candidate set the
 * quality board would rank, so a promoted pair's samples and its candle fallback always
 * describe the same combinations.
 */
export function selectSpreadQualityCandidates(
  rows: readonly SpreadOpportunity[],
  pairType: SpreadPairType | undefined,
  hub: SpreadQualityMarketHubView,
  limit: number,
): SpreadQualityCandidate[] {
  const cap = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
  const candidates: SpreadQualityCandidate[] = [];
  for (const row of rows) {
    for (const combination of row.combinations) {
      if (!combination.executable) continue;
      if (pairType !== undefined && combination.pairType !== pairType) continue;
      // R4: a combination the opportunity board judged quote-unaligned (legs' quote timestamps
      // outside the shared skew budget) would bake a never-existed spread into the 24h series,
      // so it never becomes a quality candidate — the sampler shares this rule via this
      // function, keeping both tracks on the same candidate set.
      if (combination.quoteAligned === false) continue;
      candidates.push({
        pairType: combination.pairType,
        asset: row.asset,
        combination,
        classification: {
          assetClass: row.assetClass,
          assetSuperClass: row.assetSuperClass,
          variantSuffix: row.variantSuffix,
          isPreIpo: row.isPreIpo,
        },
        bookDepthUsdt: spreadPairDepthUsdt(combination.leftSymbol, combination.rightSymbol, hub),
      });
    }
  }
  candidates.sort((left, right) => {
    const leftWeight = Math.abs(left.combination.spreadBps) * left.bookDepthUsdt;
    const rightWeight = Math.abs(right.combination.spreadBps) * right.bookDepthUsdt;
    return rightWeight - leftWeight
      || left.asset.localeCompare(right.asset)
      || left.combination.leftSymbol.localeCompare(right.combination.leftSymbol)
      || left.combination.rightSymbol.localeCompare(right.combination.rightSymbol);
  });
  return candidates.slice(0, cap);
}

/** Funding rate per perpetual symbol, keyed by canonical asset then CrossEx symbol. */
type FundingRateIndex = ReadonlyMap<string, ReadonlyMap<string, { rate: number; intervalHours: number }>>;

/**
 * Spread-quality board behind GET /api/opportunities/spread-quality.
 *
 * The spread board answers "what is wide right now"; this board answers "what is wide,
 * stable and quick to revert". Every executable (asset, sell venue, buy venue) combination
 * of the spread board becomes a candidate, the top 50 by |spread| × absorbable depth are
 * rebuilt into a spread series, and the series' distribution statistics — mean, volatility,
 * skewness, excess kurtosis, symmetry, AR(1) half-life — combine with the funding holding
 * cost and top-of-book depth into a weighted-percentile score. A leg that fails to load
 * simply drops its candidate: the board degrades to fewer rows, never to an error.
 *
 * Reconstruction is dual-track. The default track reads 24h of 5m venue candles per leg.
 * When a local sample store is wired and a pair has accumulated a full 24h of 30s samples
 * at ≥80% coverage, that pair is instead rebuilt from its own samples (`source: 'samples'`,
 * 2880 points at 0.5 minutes per point) — a cadence that sees intra-candle dislocations a
 * 5m close cannot. Promotion is decided per pair, so one board may mix both sources; pairs
 * below the threshold, and every pair when no store is wired, stay on candles.
 *
 * Boards are computed at most once per 5 minutes per pair type (`cacheTtlMs`); concurrent
 * identical requests share one computation (single-flight), and `limit` is excluded from
 * the cache key because it only slices an already-complete row set.
 */
export class SpreadQualityService {
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly candidateLimit: number;
  private readonly candleConcurrency: number;
  /** Cached boards keyed by pair type; `Map` insertion order doubles as the eviction order. */
  private readonly cache = new Map<string, SpreadQualityCacheEntry>();

  constructor(
    private readonly deps: SpreadQualityDependencies,
    options: SpreadQualityServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    this.cacheMaxEntries = Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES);
    this.candidateLimit = Math.max(1, options.candidateLimit ?? MAX_SPREAD_QUALITY_CANDIDATES);
    this.candleConcurrency = Math.max(1, options.candleConcurrency ?? DEFAULT_CANDLE_CONCURRENCY);
  }

  /**
   * Ranked quality rows for one query, sliced to the requested page. Sorting and paging happen
   * outside the board cache (which only knows the pair type) — exactly how the opportunity board
   * treats its own paging parameters — so switching sort keys or pages never recomputes candles.
   */
  async list(catalog: OpportunityCatalogView, query: SpreadQualityQuery): Promise<SpreadQualityResponse> {
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(query.limit)));
    const board = await this.board(catalog, query.pairType);
    const sorted = sortSpreadQualityRows(board.rows, query.sort ?? 'score', query.dir ?? 'desc');
    return {
      rows: sorted.slice(offset, offset + pageSize),
      totalCandidates: board.totalCandidates,
      windowHours: board.windowHours,
      fetchedAt: board.fetchedAt,
      cacheStatus: board.cacheStatus,
      sort: query.sort ?? 'score',
      dir: query.dir ?? 'desc',
      offset,
      total: sorted.length,
    };
  }

  /** Live cache-entry count; a test seam that also lets operators confirm reuse. */
  cacheSize(): number {
    return this.cache.size;
  }

  /** Drop every cached board — used when the operator forces a refresh. */
  invalidateCache(): void {
    this.cache.clear();
  }

  /** Cache-backed board computation: one in-flight computation per pair type per TTL. */
  private async board(
    catalog: OpportunityCatalogView,
    pairType: SpreadPairType | undefined,
  ): Promise<SpreadQualityBoard> {
    const key = pairType ?? 'ALL';
    const current = this.cache.get(key);
    if (current && current.expiresAt > this.now()) {
      // Touch guarantees: reinserting keeps the entry newest, so alternating between two
      // pair-type queries never evicts the other mid-session.
      this.cache.delete(key);
      this.cache.set(key, current);
      return await current.promise;
    }
    const computation = this.computeBoard(catalog, pairType);
    this.cache.set(key, { key, expiresAt: this.now() + this.cacheTtlMs, promise: computation });
    this.trimCache(key);
    try {
      return await computation;
    } catch (error) {
      // Never cache a failure: the next request must be able to succeed.
      this.cache.delete(key);
      throw error;
    }
  }

  /** Age out expired entries first, then the least recently touched one. */
  private trimCache(justAddedKey: string): void {
    const now = this.now();
    for (const [key, entry] of this.cache) {
      if (key !== justAddedKey && entry.expiresAt <= now) this.cache.delete(key);
    }
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
  }

  /** Full row set of one pair type, computed once per cache window. */
  private async computeBoard(
    catalog: OpportunityCatalogView,
    pairType: SpreadPairType | undefined,
  ): Promise<SpreadQualityBoard> {
    // Holding costs read the funding overview, so keep it as fresh as the funding page.
    await this.deps.fundingOverview.ensureFresh();
    const overview = this.deps.fundingOverview.buildResponse(catalog);
    const boardRows = await this.deps.spreadBoard(catalog);
    const candidates = this.selectCandidates(boardRows, pairType);
    const fundingIndex = buildFundingRateIndex(overview);
    const sampleCoverage = this.readSampleCoverage(candidates);
    const evaluated = await this.evaluateCandidates(candidates, fundingIndex, sampleCoverage);
    return {
      rows: scoreSpreadQualityInputs(evaluated),
      totalCandidates: candidates.length,
      windowHours: SPREAD_QUALITY_WINDOW_HOURS,
      fetchedAt: new Date(this.now()).toISOString(),
      cacheStatus: overview.cacheStatus,
    };
  }

  /**
   * Coverage of every candidate pair's samples inside the 24h window — one aggregate read
   * per computation, so the per-pair promotion check costs nothing extra. Null when no
   * sample store is wired; a store that throws degrades the board to candles rather than
   * failing the request.
   */
  private readSampleCoverage(
    candidates: readonly SpreadQualityCandidate[],
  ): ReadonlyMap<string, SpreadSampleCoverage> | null {
    const samples = this.deps.samples;
    if (samples === undefined || candidates.length === 0) return null;
    try {
      return samples.coverage(
        candidates.map((candidate) => ({
          leftSymbol: candidate.combination.leftSymbol,
          rightSymbol: candidate.combination.rightSymbol,
        })),
        this.now() - SPREAD_QUALITY_WINDOW_MS,
      );
    } catch {
      return null;
    }
  }

  /**
   * Executable combinations of the board, ranked by how much money the current dislocation
   * can actually move (|spread| × absorbable depth) and capped so the candle fan-out stays
   * bounded. Non-executable combinations and other pair types never become candidates.
   */
  private selectCandidates(
    rows: readonly SpreadOpportunity[],
    pairType: SpreadPairType | undefined,
  ): SpreadQualityCandidate[] {
    return selectSpreadQualityCandidates(rows, pairType, this.deps.hub, this.candidateLimit);
  }

  /**
   * Reconstruct and score every candidate, with a bounded candle fan-out. One candle page
   * is fetched per distinct leg per computation — two candidates sharing a perpetual leg
   * never fetch it twice — and a candidate whose legs fail or align too thinly is skipped
   * rather than allowed to fail the request. Promoted pairs skip the candle fan-out
   * entirely: their series comes from the local sample store.
   */
  private async evaluateCandidates(
    candidates: readonly SpreadQualityCandidate[],
    fundingIndex: FundingRateIndex,
    sampleCoverage: ReadonlyMap<string, SpreadSampleCoverage> | null,
  ): Promise<SpreadQualityScoreInput[]> {
    const candlePages = new Map<string, Promise<readonly Candle[]>>();
    const candlesFor = (symbol: string): Promise<readonly Candle[]> => {
      const existing = candlePages.get(symbol);
      if (existing) return existing;
      const pending = this.deps.loadCandles(symbol).catch(() => [] as readonly Candle[]);
      candlePages.set(symbol, pending);
      return pending;
    };
    const evaluated = await mapWithConcurrency(
      candidates,
      this.candleConcurrency,
      async (candidate) => {
        try {
          return await this.evaluateCandidate(candidate, fundingIndex, candlesFor, sampleCoverage);
        } catch {
          // One dead leg (venue outage, thin history) skips its candidate; the board survives.
          return null;
        }
      },
    );
    return evaluated.filter((entry): entry is SpreadQualityScoreInput => entry !== null);
  }

  private async evaluateCandidate(
    candidate: SpreadQualityCandidate,
    fundingIndex: FundingRateIndex,
    candlesFor: (symbol: string) => Promise<readonly Candle[]>,
    sampleCoverage: ReadonlyMap<string, SpreadSampleCoverage> | null,
  ): Promise<SpreadQualityScoreInput | null> {
    const { combination } = candidate;
    // Track one: the pair earned the samples source — rebuild from its own 30s series and
    // skip the venue candle fan-out for both legs entirely.
    const sampleRows = this.promotedSampleSeries(candidate, sampleCoverage);
    if (sampleRows !== null) {
      const scored = this.scoreSeries(
        candidate,
        sampleRows.map((row) => row.spreadBps),
        sampleRows.length,
        SPREAD_SAMPLE_MINUTES_PER_POINT,
        latestSampleDepthUsdt(sampleRows, candidate.bookDepthUsdt),
        fundingIndex,
        'samples',
      );
      if (scored !== null) return scored;
      // A sample series with no finite point has no mean to rank on; fall through to
      // candles so venue history still gets a chance to score the pair.
    }
    // Track two: 24h of 5m venue candles, trimmed to the newest window.
    const [leftCandles, rightCandles] = await Promise.all([
      candlesFor(combination.leftSymbol),
      candlesFor(combination.rightSymbol),
    ]);
    const series = alignSpreadSeries(leftCandles, rightCandles);
    if (series.length < MIN_SAMPLE_POINTS) return null;
    return this.scoreSeries(
      candidate,
      series,
      series.length,
      SPREAD_QUALITY_INTERVAL_MINUTES,
      candidate.bookDepthUsdt,
      fundingIndex,
      'candles',
    );
  }

  /**
   * The pair's sample series when it has earned the `samples` source, else null. Promotion
   * needs all of: a wired sample store, coverage of at least 80% of the 24h window (2304 of
   * 2880 points) spanning a full 24h, and — after any concurrent pruning — at least 240
   * points left inside the window. The defensive re-read keeps a prune racing the board from
   * ever publishing a series thinner than the statistics can support. A store that throws
   * degrades this pair to candles — symmetric with the coverage read — instead of dropping
   * the row while its candle history is still intact.
   */
  private promotedSampleSeries(
    candidate: SpreadQualityCandidate,
    coverage: ReadonlyMap<string, SpreadSampleCoverage> | null,
  ): readonly SpreadSampleRow[] | null {
    const samples = this.deps.samples;
    if (samples === undefined || coverage === null) return null;
    const { combination } = candidate;
    const entry = coverage.get(spreadSamplePairKey(combination.leftSymbol, combination.rightSymbol));
    if (entry === undefined) return null;
    if (entry.count < SPREAD_SAMPLE_MIN_COVERAGE_POINTS) return null;
    if (entry.newestMs - entry.oldestMs < SPREAD_QUALITY_WINDOW_MS) return null;
    let rows: readonly SpreadSampleRow[];
    try {
      rows = samples.series(
        combination.leftSymbol,
        combination.rightSymbol,
        this.now() - SPREAD_QUALITY_WINDOW_MS,
      );
    } catch {
      return null;
    }
    return rows.length >= SPREAD_SAMPLE_MIN_POINTS ? rows : null;
  }

  /**
   * Statistics, holding cost and row fields shared by both tracks. The only differences
   * between them are the series itself, its point count, its cadence (`minutesPerPoint`),
   * the depth reading and the reported `source`.
   */
  private scoreSeries(
    candidate: SpreadQualityCandidate,
    series: readonly number[],
    sampleCount: number,
    minutesPerPoint: number,
    bookDepthUsdt: number,
    fundingIndex: FundingRateIndex,
    source: SpreadQualityRow['source'],
  ): SpreadQualityScoreInput | null {
    const { combination } = candidate;
    const statistics = computeSpreadStatistics(series, minutesPerPoint);
    if (statistics.mean === null) return null;
    const holdingHours = statistics.halfLifeHours ?? DEFAULT_HOLDING_HOURS;
    return {
      pairType: candidate.pairType,
      asset: candidate.asset,
      leftSymbol: combination.leftSymbol,
      rightSymbol: combination.rightSymbol,
      leftVenue: combination.leftVenue,
      rightVenue: combination.rightVenue,
      currentSpreadBps: combination.spreadBps,
      updatedAt: combination.updatedAt,
      assetClass: candidate.classification.assetClass,
      assetSuperClass: candidate.classification.assetSuperClass,
      variantSuffix: candidate.classification.variantSuffix,
      isPreIpo: candidate.classification.isPreIpo,
      sampleCount,
      meanSpreadBps: statistics.mean,
      spreadVolatilityBps: statistics.volatility,
      skewness: statistics.skewness,
      excessKurtosis: statistics.excessKurtosis,
      symmetric: statistics.symmetric,
      ar1Coefficient: statistics.ar1Coefficient,
      halfLifeHours: statistics.halfLifeHours,
      holdingCostBps: holdingCostBpsFor(candidate, fundingIndex, holdingHours),
      bookDepthUsdt,
      source,
    };
  }
}

/**
 * Weaker leg's top-of-book notional (USDT): each leg contributes the smaller of its bid and
 * ask notional (what one fill can absorb on either side), and the pair takes the smaller
 * leg. A leg the hub does not know is depth zero, not an exception.
 *
 * Exported for `spread-sampler.ts`: a sampled point must record the same absorbable depth
 * the quality board ranks the pair by, so both tracks read one implementation.
 */
export function spreadPairDepthUsdt(
  leftSymbol: string,
  rightSymbol: string,
  hub: SpreadQualityMarketHubView,
): number {
  return Math.min(spreadLegDepthUsdt(leftSymbol, hub), spreadLegDepthUsdt(rightSymbol, hub));
}

/** One leg's top-of-book notional: the smaller of its bid and ask side, zero when unknown. */
export function spreadLegDepthUsdt(symbol: string, hub: SpreadQualityMarketHubView): number {
  const market: LiveMarket | null = hub.market(symbol);
  if (market === null) return 0;
  return Math.min(legNotional(market.bidSize, market.bidPrice), legNotional(market.askSize, market.askPrice));
}

/**
 * Executable spread in bps from two legs' top-of-book quotes, in the board's orientation
 * (sell leg's bid minus buy leg's ask). Null when either side is unusable — a sampler tick
 * then skips the pair instead of persisting a fabricated zero.
 */
export function spreadBpsFromBook(leftBidPrice: string, rightAskPrice: string): number | null {
  const bid = Number(leftBidPrice);
  const ask = Number(rightAskPrice);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  const spreadBps = ((bid - ask) / ask) * 10_000;
  return Number.isFinite(spreadBps) ? spreadBps : null;
}

/**
 * Depth recorded with a samples-sourced row: the newest sample's own depth, falling back to
 * the live hub reading when the sampler could not observe one (zero or missing). The newest
 * point is the one closest to "right now", which is what the depth factor ranks on.
 */
function latestSampleDepthUsdt(rows: readonly SpreadSampleRow[], fallbackUsdt: number): number {
  const latest = rows[rows.length - 1];
  if (latest === undefined) return fallbackUsdt;
  return Number.isFinite(latest.depthUsdt) && latest.depthUsdt > 0 ? latest.depthUsdt : fallbackUsdt;
}

function legNotional(size: string, price: string): number {
  const quantity = Number(size);
  const unit = Number(price);
  if (!Number.isFinite(quantity) || !Number.isFinite(unit) || quantity <= 0 || unit <= 0) return 0;
  return quantity * unit;
}

/**
 * Holding cost in bps: the funding differential over the expected holding window plus the
 * round-trip taker fees. A perpetual leg pays |rate| / interval per hour regardless of
 * direction, so two perpetual legs net to |rateA − rateB| and a spot leg contributes
 * nothing. A perpetual leg with unknown funding makes the whole cost null — scoring then
 * charges the pair the group's maximum cost rather than assuming funding away.
 */
function holdingCostBpsFor(
  candidate: SpreadQualityCandidate,
  fundingIndex: FundingRateIndex,
  holdingHours: number,
): number | null {
  const { combination } = candidate;
  const perpRatesBpsPerHour: number[] = [];
  for (const symbol of [combination.leftSymbol, combination.rightSymbol]) {
    if (!CROSSEX_FUTURE_SYMBOL.test(symbol)) continue;
    const rate = fundingRateBpsPerHour(fundingIndex, candidate.asset, symbol);
    if (rate === null) return null;
    perpRatesBpsPerHour.push(rate);
  }
  if (perpRatesBpsPerHour.length === 0) return null;
  const bpsPerHour = perpRatesBpsPerHour.length === 2
    ? Math.abs(perpRatesBpsPerHour[0]! - perpRatesBpsPerHour[1]!)
    : perpRatesBpsPerHour[0]!;
  return bpsPerHour * holdingHours + ROUND_TRIP_TAKER_FEE_BPS;
}

/** Index the funding overview by canonical asset and CrossEx symbol, dropping unknown rows. */
function buildFundingRateIndex(overview: FundingOverviewResponse): FundingRateIndex {
  const index = new Map<string, Map<string, { rate: number; intervalHours: number }>>();
  for (const asset of overview.assets) {
    const bySymbol = new Map<string, { rate: number; intervalHours: number }>();
    for (const venue of asset.venues) {
      if (venue.fundingRate === null || venue.fundingIntervalHours === null) continue;
      const rate = Number(venue.fundingRate);
      if (!Number.isFinite(rate) || venue.fundingIntervalHours <= 0) continue;
      bySymbol.set(venue.symbol, { rate, intervalHours: venue.fundingIntervalHours });
    }
    index.set(asset.asset, bySymbol);
  }
  return index;
}

/** |funding rate| converted to bps per hour, or null when the venue row is unknown. */
function fundingRateBpsPerHour(index: FundingRateIndex, asset: string, symbol: string): number | null {
  const entry = index.get(asset)?.get(symbol);
  if (entry === undefined) return null;
  return (Math.abs(entry.rate) / entry.intervalHours) * 10_000;
}

/** Map `worker` over `items` with at most `limit` promises in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}
