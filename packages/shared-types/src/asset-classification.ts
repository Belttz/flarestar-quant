import { z } from 'zod';

/**
 * Asset classification for the CrossEx opportunity boards.
 *
 * The upstream CrossEx catalog exposes no asset-class field (see `CrossExInstrumentSchema` and
 * `MarketCatalogAssetSchema`), so the class of an asset is a *derived* fact owned by this module:
 * a version-controlled static membership list plus pure derivation rules. It deliberately lives
 * in `packages/shared-types` (and not in the database) so that the backend — which must filter
 * before it truncates rows — and the frontend — which renders the class badge — always agree.
 *
 * Derivation order (fixed, see `ASSET_CLASS_MEMBERS` and `classifyAsset`):
 *   1. pre-IPO membership            → `PRE_IPO` (super class `RWA`)
 *   2. explicit membership lists     → `STOCK` / `ETF` / `INDEX` / `FOREX` / `COMMODITY` / `COIN`
 *   3. variant merging (prefix/suffix) → inherit the class of the canonical base asset
 *   4. perpetual-only (no SPOT listing anywhere in the catalog, requires context) → `CONTRACT`
 *   5. fallback                      → `TOKEN` (super class `CRYPTO`)
 */

/** Top-level grouping shown by the opportunity board filter ("RWA" / "Crypto"). */
export const AssetSuperClassSchema = z.enum(['RWA', 'CRYPTO']);
export type AssetSuperClass = z.infer<typeof AssetSuperClassSchema>;

/** Fine-grained class rendered as a badge on every opportunity row. */
export const AssetClassSchema = z.enum([
  'STOCK', 'ETF', 'INDEX', 'FOREX', 'COMMODITY',
  'PRE_IPO',
  'COIN', 'TOKEN', 'CONTRACT',
]);
export type AssetClass = z.infer<typeof AssetClassSchema>;

/** Three-state pre-IPO switch of the opportunity board (`all` / `only` / `exclude`). */
export const PreIpoFilterModeSchema = z.enum(['all', 'only', 'exclude']);
export type PreIpoFilterMode = z.infer<typeof PreIpoFilterModeSchema>;

/** Result of classifying one catalog asset. */
export interface AssetClassification {
  /** The asset as passed in, normalised to upper case. */
  asset: string;
  /** Underlying asset after variant merging (`AAPLX` → `AAPL`); equals `asset` when no variant. */
  canonicalAsset: string;
  /** Stripped variant marker (`X` / `ON` / `B` / `G`); `null` when the asset is canonical. */
  variantSuffix: string | null;
  assetClass: AssetClass;
  assetSuperClass: AssetSuperClass;
  isPreIpo: boolean;
}

/** Split result of `splitAssetVariant`. */
export interface AssetVariantSplit {
  /** Canonical base asset; equals the input when no variant marker was stripped. */
  base: string;
  /** Stripped leading marker (`X`), or `null`. */
  prefix: string | null;
  /** Stripped trailing marker (`X` / `ON` / `B` / `G`), or `null`. */
  suffix: string | null;
}

/**
 * Optional catalog context. `hasSpot === false` means the asset has no SPOT listing anywhere in
 * the catalog (perpetual-only) which derives `CONTRACT`. Callers without catalog knowledge omit
 * the context and perpetual-only assets fall back to `TOKEN` instead — harmless because the badge
 * text is produced by the backend (which does have the catalog).
 */
export interface AssetClassificationContext {
  hasSpot?: boolean;
}

/**
 * Trailing variant markers. Each marker denotes the **issuer** of the tokenised instrument, not a
 * random label (confirmed against the venues' official pages on 2026-10-08, see
 * `deliverables/software-company/rwa-seed-from-venues.md`):
 *
 *   - `X`  = xStocks (Backed Assets / Payward, 1:1 reserves) — Gate spot, Bybit spot, Kraken perps
 *   - `ON` = Ondo Tokenized (Ondo Global Markets, dividend-accruing) — Gate spot
 *   - `G`  = gStocks (Gate's own tokenised securities) — Gate spot
 *   - `B`  = Bstocks (Binance tokenised US stocks, 1:1 redeemable) — Binance spot
 *
 * `M` is deliberately NOT a marker: `SPYM` is the real SPDR Portfolio S&P 500 ETF ticker (QQQM and
 * IEMG are likewise genuine fund tickers), so stripping it would merge distinct products.
 *
 * `L` and `U` are also intentionally NOT stripped: `SPXL` (3× long S&P 500 ETF) must not be merged
 * into `SPX`, and `AAPU` / `NVDL` / `TSLL` are their own instruments.
 *
 * Stripping is guarded: a marker is only removed when the remainder is a known base asset
 * (see `splitAssetVariant`), so real tickers are never merged by accident.
 */
export const ASSET_VARIANT_SUFFIXES = ['X', 'ON', 'B', 'G'] as const;

/**
 * Leading variant markers. `X` as a **prefix** denotes OKX's Unified Tokenized Stocks (underlying
 * issuance also provided by xStocks), e.g. `XAAPL` → `AAPL`, `XTSLA` → `TSLA` — the same
 * underlying as the `X`-suffixed xStocks listings on Gate/Bybit/Kraken.
 * Source: https://www.okx.com/zh-hans/help/unified-tokenized-stocks
 *
 * Stripping is guarded the same way as the suffix rule — it only applies when the remainder is a
 * known base asset — so genuine `X`-starting coins (`XRP`, `XLM`, `XMR`, `XDC`, `XCH`, `XAUT`,
 * `XPT`, …) are never merged.
 */
export const ASSET_VARIANT_PREFIXES = ['X'] as const;

/** Membership-list keys; `TOKEN` and `CONTRACT` are derived and therefore have no list. */
export type AssetClassListKey = Extract<
  AssetClass,
  'STOCK' | 'ETF' | 'INDEX' | 'FOREX' | 'COMMODITY' | 'COIN' | 'PRE_IPO'
>;

/**
 * Static, version-controlled membership lists.
 *
 * Coverage note: the catalogue carries ~2 500 assets and several hundred of them are tokenised
 * real-world instruments, so these lists are deliberately large. The lists below merge the
 * hand-reviewed catalog dump with the venue research in
 * `deliverables/software-company/rwa-seed-from-venues.md` (Gate official REST API `base_name`
 * field + Binance Square + OKX help centre + xStocks products page, fetched 2026-10-08).
 *
 * Deliberately NOT classified (kept on the `CRYPTO / TOKEN` default pending user confirmation):
 *   - yield / bond-ish Ondo products: `10Y`, `2Y`, `30Y`, `US10Y`, `USDY`, `YLD5ON`, `YLD8ON`,
 *     `XL1`, `USTC`
 *   - Hong Kong numeric board codes: `HK0625`, `HK0700`, `HK0992`, `HK1810`
 *   - structured / basket products: `MAG7SSI`, `MAG7XON`, `CSOPSAMSUNG2L`, `CSOPSKHYNIX2L`
 *   - pre-IPO candidates without an official venue confirmation: `XAI`, `BTGO`, `OURA`, `SPACE`,
 *     `STRC` (STRC is a Strategy preferred share, frequently mistaken for a pre-IPO)
 *   - crypto-name-collision suspects seen in the tokenised zones: `ARB`, `BNC`, `BOT`, `BSP`,
 *     `SECZ`, `SHAZ`, `CYPH`, `USAR` (kept on the default even though `*B` variants exist)
 *   - ambiguous 1–3 letter codes with multiple real-world meanings: `CL` (crude future vs.
 *     Colgate), `DASH` (Dash vs. DoorDash)
 *
 * Removed per venue research (2026-10-08):
 *   - `SPX` is no longer an INDEX member: on Gate spot its `base_name` is `SPX6900` (a meme coin);
 *     the S&P 500 is covered by `SP500` / `SPX500` / `US500`.
 *   - `IRON` is no longer a COMMODITY member: on Gate spot it is `Iron Fish`, a crypto asset.
 *   - `M` is no longer a variant suffix (see `ASSET_VARIANT_SUFFIXES`).
 *
 * Rule guardrails:
 *   - There is deliberately NO "`*USD` suffix ⇒ FOREX" rule: the Lighter catalog carries
 *     `SAMSUNGUSD` / `SKHYNIXUSD` / `HYUNDAIUSD`, which are USD-denominated tokenised stocks,
 *     not currency pairs. FOREX membership is list-only.
 *   - Leveraged / inverse / single-stock ETFs (`NVDL`, `TSLL`, `AAPU`, `AMZU`, `CONL`, `MSTU`, …)
 *     belong to ETF, not STOCK.
 *
 * `AGG` / `AGENCY` stay under `ETF`: the venue research confirmed `AGG` as the iShares Core US
 * Aggregate Bond ETF (Gate `AGGON | iShares Core US Aggregate Bond ETF`); `AGENCY` remains from
 * the earlier confirmed seed. `XPD` / `XPT` / `XCU` and the rest of the ISO metal-code family
 * (`XAL` / `XNI` / `XPB`) are confirmed COMMODITY members via Gate's official metal code family
 * (leverage tokens `XAU3L/3S`, `XPT3L/3S`, `XCU3L/3S`, …).
 */
export const ASSET_CLASS_MEMBERS: Readonly<Record<AssetClassListKey, readonly string[]>> = {
  STOCK: [
    'AAL', 'AAOI', 'AAPL', 'ABBV', 'ABNB', 'ABT', 'ACN', 'ADBE', 'ADI', 'ADP', 'ADSK', 'AEHR',
    'AGPU', 'AKAM', 'ALAB', 'ALB', 'ALL', 'AMAT', 'AMC', 'AMD', 'AMGN', 'AMKR', 'AMP', 'AMZN',
    'ANET', 'APD', 'APH', 'APLD', 'APP', 'ARM', 'ASML', 'ASTS', 'AVGO', 'AXTI', 'AZN',
    'BA', 'BABA', 'BAC', 'BB', 'BDX', 'BE', 'BEIGENE', 'BEN', 'BHP', 'BIIB', 'BILL', 'BKNG',
    'BLUEFOCUS', 'BMNR', 'BP', 'BRKB', 'BSX', 'BTDR', 'BUD', 'BWXT', 'BX', 'BYD',
    'CAKE', 'CAMBRICON', 'CARR', 'CAT', 'CATL', 'CCJ', 'CCL', 'CEG', 'CFG', 'CGNX', 'CIEN',
    'CIFR', 'CLSK', 'CMCSA', 'CMI', 'COF', 'COHR', 'COIN', 'COP', 'CORZ', 'COST', 'CPNG',
    'CRCL', 'CRDO', 'CRM', 'CRWD', 'CRWV', 'CSCO', 'CVNA', 'CVS', 'CVX',
    'DDOG', 'DELL', 'DFDV', 'DIS', 'DJT', 'DKNG',
    'ELF', 'EOPTOLINK', 'ETN',
    'FCX', 'FLEX', 'FLNC', 'FOXA', 'FSLR', 'FUTU', 'FWDI',
    'GD', 'GE', 'GEELY', 'GEV', 'GFS', 'GILD', 'GLW', 'GME', 'GNRC', 'GOOGL', 'GPRO', 'GPS',
    'GS', 'GT', 'GTLB',
    'HD', 'HEI', 'HENGRUI', 'HIMS', 'HIVE', 'HOOD', 'HPE', 'HSBC', 'HUT', 'HYUNDAI',
    'IBM', 'INTC', 'INTU', 'IONQ', 'IREN', 'ISRG',
    'JCI', 'JD', 'JNJ', 'JPM',
    'KLAC', 'KO', 'KUAISHOU',
    'LENOVO', 'LIN', 'LITE', 'LLY', 'LMT', 'LRCX', 'LUNR', 'LUXSHARE',
    'MA', 'MAR', 'MARA', 'MCD', 'MCHP', 'MDB', 'MELI', 'MET', 'META', 'MEITUAN', 'MIDEA',
    'MNST', 'MO', 'MOUTAI', 'MP', 'MPWR', 'MRK', 'MRNA', 'MRVL', 'MSFT', 'MSTR', 'MU', 'MUB',
    'MUFG',
    'NAURA', 'NBIS', 'NEE', 'NET', 'NFLX', 'NKE', 'NOC', 'NOK', 'NOKIA', 'NOW', 'NVDA', 'NVO',
    'OKLO', 'OKTA', 'ON', 'ONDS', 'OPEN', 'ORCL', 'OSCR', 'OUST', 'OXY',
    'PANW', 'PATH', 'PDD', 'PEP', 'PFE', 'PG', 'PLTR', 'POPMART', 'PYPL',
    'QCOM',
    'RDDT', 'RDW', 'REGN', 'RIO', 'RIOT', 'RIVN', 'RKLB', 'ROK', 'ROKU', 'RTX',
    'SAMSUNG', 'SBET', 'SBUX', 'SCHW', 'SDGR', 'SENSETIME', 'SHELL', 'SHENHUA', 'SHOP', 'SIMO',
    'SKHY', 'SKHYNIX', 'SMCI', 'SMIC', 'SMSN', 'SNDK', 'SNOW', 'SO', 'SOFI', 'SOFTBANK', 'SONY',
    'SPOT', 'STM', 'STX', 'SUNGROW', 'SYK',
    'TEAM', 'TEM', 'TENCENT', 'TER', 'TFC', 'TJX', 'TM', 'TMO', 'TMUS', 'TSEM', 'TSLA', 'TSM',
    'TTMI', 'TTWO', 'TWLO', 'TXN',
    'UBER', 'UMC', 'UNH',
    'V', 'VALE', 'VRT', 'VRTX', 'VST', 'VZ',
    'WBD', 'WDC', 'WEN', 'WFC', 'WMT', 'WUXIAPPTEC',
    'XIAOMI', 'XOM',
    'ZIJINMINING', 'ZM', 'ZS',
  ],
  ETF: [
    'AGG', 'AGENCY', 'AAPU', 'AMZU', 'ARKK', 'BITO', 'BOTZ', 'BSV', 'CONL', 'DBC', 'DIA', 'DRAM',
    'EEM', 'EWJ', 'EWT', 'EWY', 'EWZ', 'GLD', 'GDX', 'GGLL', 'IAU', 'IBB', 'IBIT', 'IEFA', 'IEMG', 'IGV',
    'INTW', 'IWM', 'IVV', 'JEPQ', 'KODEX200', 'KORU', 'KWEB', 'LIT', 'LQD', 'MAGS', 'METU',
    'MSFU', 'MSTU', 'MUU', 'MVLL', 'NVDL', 'QLD', 'QQQ', 'QQQM', 'SLV', 'SMH', 'SNXX', 'SOXL', 'SOXS',
    'SOXX', 'SPXL', 'SPY', 'SPYM', 'SQQQ', 'TBT', 'TLT', 'TMF', 'TQQQ', 'TSLL', 'TZA', 'URNM', 'USO',
    'UVXY', 'VTI', 'VOO', 'XBI', 'XLE', 'XLF', 'XLK', 'XLP', 'XLU', 'XLV',
  ],
  INDEX: [
    'AUS200', 'GER40', 'HK50', 'JP225', 'JPN225', 'KR200', 'NAS100',
    'SP500', 'SPX500', 'UK100', 'US100', 'US2000', 'US30', 'US500', 'XYZ100',
  ],
  FOREX: [
    // Explicit currency pairs (confirmed on Gate perps, Bybit, Lighter, Binance).
    'AUDUSD', 'EURUSD', 'GBPUSD', 'NZDUSD', 'USDBRL', 'USDCAD', 'USDCHF', 'USDJPY', 'USDKRW',
    // Single currency legs — WEAK EVIDENCE, PENDING REVIEW. Observed as bare contracts on
    // Kraken (EUR/GBP/CHF) and Hyperliquid (EUR/GBP/JPY); these short codes collide easily with
    // crypto tickers, so treat membership as provisional until the user confirms.
    'AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'JPY', 'NZD',
  ],
  COMMODITY: [
    'BRENTOIL', 'COPPER', 'GOLD', 'NATGAS', 'PAXG', 'PLATINUM', 'SILVER', 'WTI', 'WTIOIL',
    // ISO-4217 metal codes, confirmed as one family via Gate's official leverage tokens
    // (XAU3L/3S, XAG3L/3S, XPT3L/3S, XPD3L/3S, XCU3L/3S, XAL3L/3S, XNI3L/3S, XPB3L/3S).
    'XAG', 'XAU', 'XAL', 'XAUT', 'XCU', 'XNI', 'XPB', 'XPD', 'XPT',
  ],
  COIN: [
    'AAVE', 'ADA', 'ALGO', 'APT', 'ATOM', 'AVAX', 'BAT', 'BCH', 'BNB', 'BTC', 'DOGE', 'DOT',
    'ETC', 'ETH', 'FIL', 'HBAR', 'HYPE', 'ICP', 'KAS', 'LINK', 'LTC', 'NEAR', 'SAND', 'SHIB',
    'SOL', 'SUI', 'TAO', 'TRX', 'XLM', 'XMR', 'XRP', 'XTZ', 'ZEC',
  ],
  PRE_IPO: [
    'ANDURIL', 'ANTHROPIC', 'CBRS', 'KIMI', 'MINIMAX', 'NEURALINK', 'OPENAI', 'QNT', 'SHEIN',
    'SPACEHOOD', 'SPCX', 'UNITREE', 'ZHIPU',
  ],
};

/** Stable display order for the class filter / legend. */
export const ASSET_CLASS_ORDER: readonly AssetClass[] = [
  'STOCK', 'ETF', 'INDEX', 'FOREX', 'COMMODITY', 'PRE_IPO', 'COIN', 'TOKEN', 'CONTRACT',
];

/** Canonical i18n dictionary keys for the class badges (values live in `apps/frontend/src/i18n.tsx`). */
export const ASSET_CLASS_LABEL_KEYS: Readonly<Record<AssetClass, string>> = {
  STOCK: 'Stock',
  ETF: 'ETF',
  INDEX: 'Index',
  FOREX: 'Forex',
  COMMODITY: 'Commodity',
  PRE_IPO: 'Pre-IPO',
  COIN: 'Coin',
  TOKEN: 'Token',
  CONTRACT: 'Contract',
};

/** Super classes mapped from a fine-grained class. */
const ASSET_SUPER_CLASS_BY_CLASS: Readonly<Record<AssetClass, AssetSuperClass>> = {
  STOCK: 'RWA',
  ETF: 'RWA',
  INDEX: 'RWA',
  FOREX: 'RWA',
  COMMODITY: 'RWA',
  PRE_IPO: 'RWA',
  COIN: 'CRYPTO',
  TOKEN: 'CRYPTO',
  CONTRACT: 'CRYPTO',
};

/**
 * Membership index: asset → class. Built once at module load and frozen.
 * Invariant 1: an asset must never appear in two membership lists.
 */
const ASSET_CLASS_BY_ASSET = new Map<string, AssetClass>();

for (const assetClass of Object.keys(ASSET_CLASS_MEMBERS) as AssetClassListKey[]) {
  for (const member of ASSET_CLASS_MEMBERS[assetClass]) {
    const key = member.trim().toUpperCase();
    if (key.length === 0) continue;
    const existing = ASSET_CLASS_BY_ASSET.get(key);
    if (existing !== undefined) {
      throw new Error(`Asset "${key}" is listed in two asset classes: ${existing} and ${assetClass}`);
    }
    ASSET_CLASS_BY_ASSET.set(key, assetClass);
  }
}

/** Known base universe used to guard variant merging (membership lists ∪ pre-IPO). */
const KNOWN_ASSET_BASES: ReadonlySet<string> = new Set(ASSET_CLASS_BY_ASSET.keys());

/** Memoisation cache; keyed by asset plus the (optional) catalog context. */
const CLASSIFICATION_CACHE = new Map<string, AssetClassification>();

/** Normalise arbitrary input into the canonical upper-case asset code. */
function normalizeAsset(asset: string): string {
  return typeof asset === 'string' ? asset.trim().toUpperCase() : '';
}

/**
 * Split a variant marker off an asset code.
 *
 * The marker is only stripped when the remainder is a known base asset (membership list or
 * pre-IPO entry), which keeps genuine assets intact — `SPXL` keeps its `L`, `XRP` keeps its `X`.
 * A membership entry itself is always canonical: `GDX`/`MUB`/`VRTX` are real fund and company
 * tickers and must never be treated as variants of `GD`/`MU`/`VRT`.
 */
export function splitAssetVariant(asset: string): AssetVariantSplit {
  const normalized = normalizeAsset(asset);
  if (KNOWN_ASSET_BASES.has(normalized)) return { base: normalized, prefix: null, suffix: null };
  for (const suffix of ASSET_VARIANT_SUFFIXES) {
    if (normalized.length > suffix.length && normalized.endsWith(suffix)) {
      const base = normalized.slice(0, normalized.length - suffix.length);
      if (KNOWN_ASSET_BASES.has(base)) return { base, prefix: null, suffix };
    }
  }
  for (const prefix of ASSET_VARIANT_PREFIXES) {
    if (normalized.length > prefix.length && normalized.startsWith(prefix)) {
      const base = normalized.slice(prefix.length);
      if (KNOWN_ASSET_BASES.has(base)) return { base, prefix, suffix: null };
    }
  }
  return { base: normalized, prefix: null, suffix: null };
}

/** Canonical (variant-merged) asset code of `asset`. */
export function assetBaseName(asset: string): string {
  return splitAssetVariant(asset).base;
}

/** Variant marker carried by `asset`; `null` when the asset is canonical. */
export function assetVariantSuffix(asset: string): string | null {
  const split = splitAssetVariant(asset);
  return split.suffix ?? split.prefix ?? null;
}

/** True when `asset` is a pre-IPO (unlisted-company) instrument. */
export function isPreIpoAsset(asset: string): boolean {
  return classifyAsset(asset).isPreIpo;
}

/** Super class (`RWA` / `CRYPTO`) of a fine-grained class. */
export function assetSuperClassOf(assetClass: AssetClass): AssetSuperClass {
  return ASSET_SUPER_CLASS_BY_CLASS[assetClass] ?? 'CRYPTO';
}

/** i18n dictionary key for the badge text of `assetClass`. */
export function assetClassLabelKey(assetClass: AssetClass): string {
  return ASSET_CLASS_LABEL_KEYS[assetClass] ?? 'Token';
}

/** Classify one asset. Pure: same input always yields the same output. */
export function classifyAsset(asset: string, context?: AssetClassificationContext): AssetClassification {
  const normalized = normalizeAsset(asset);
  const split = splitAssetVariant(normalized);
  const canonicalAsset = split.base;
  const variantSuffix = split.suffix ?? split.prefix ?? null;

  // 1/2. Membership lists, checked on the canonical base first and then on the raw asset.
  const memberClass =
    ASSET_CLASS_BY_ASSET.get(canonicalAsset) ?? ASSET_CLASS_BY_ASSET.get(normalized) ?? null;

  let assetClass: AssetClass;
  if (memberClass !== null) {
    assetClass = memberClass;
  } else if (context !== undefined && context.hasSpot === false && normalized.length > 0) {
    // 4. Perpetual-only assets with no SPOT listing anywhere are crypto perpetuals.
    assetClass = 'CONTRACT';
  } else {
    // 5. Fallback.
    assetClass = 'TOKEN';
  }

  return {
    asset: normalized,
    canonicalAsset,
    variantSuffix,
    assetClass,
    assetSuperClass: assetSuperClassOf(assetClass),
    isPreIpo: assetClass === 'PRE_IPO',
  };
}

/**
 * Memoised `classifyAsset`. The catalogue holds ~2 500 assets, so the cache stays small and never
 * needs invalidation (the membership lists are compile-time constants).
 */
export function classifyAssetCached(asset: string, context?: AssetClassificationContext): AssetClassification {
  const normalized = normalizeAsset(asset);
  const hasSpot = context?.hasSpot;
  const key = `${normalized}|${hasSpot === undefined ? '' : hasSpot ? '1' : '0'}`;
  const cached = CLASSIFICATION_CACHE.get(key);
  if (cached !== undefined) return cached;
  const computed = classifyAsset(normalized, context);
  CLASSIFICATION_CACHE.set(key, computed);
  return computed;
}

/** True when the classification passes the super-class filter (empty filter = everything). */
export function matchesAssetClassFilter(
  classification: AssetClassification,
  classes: readonly AssetSuperClass[],
): boolean {
  if (classes.length === 0) return true;
  return classes.includes(classification.assetSuperClass);
}

/** True when the classification passes the three-state pre-IPO switch. */
export function matchesPreIpoFilter(
  classification: AssetClassification,
  mode: PreIpoFilterMode,
): boolean {
  switch (mode) {
    case 'only':
      return classification.isPreIpo;
    case 'exclude':
      return !classification.isPreIpo;
    case 'all':
    default:
      return true;
  }
}
