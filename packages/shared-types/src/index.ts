import { z } from 'zod';
// Re-exported for consumers; also imported by name because `export *` does not create local
// bindings and the opportunity schemas below reference these two directly.
import { AssetClassSchema, AssetSuperClassSchema } from './asset-classification.js';
export * from './asset-classification.js';
export * from './portfolio-equity.js';
export const EnvironmentSchema = z.enum(['testnet','live']);
export type Environment = z.infer<typeof EnvironmentSchema>;
export const VenueSchema = z.enum(['GATE','BINANCE','OKX','BYBIT']);
export type Venue = z.infer<typeof VenueSchema>;
export const ProductTypeSchema = z.enum(['spot','cross_margin','usdt_perp']);
export type ProductType = z.infer<typeof ProductTypeSchema>;
export const ConnectionStateSchema = z.enum(['connecting','healthy','degraded','reconnecting','stale','disconnected','authentication_failed','rate_limited']);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;
export interface Instrument { venue: Venue; symbol: string; productType: ProductType; base: string; quote: string; priceTick: string; quantityStep: string; minNotional?: string; contractMultiplier?: string; }
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  environment: EnvironmentSchema,
  database: z.enum(['ok','missing','error']),
  apiDocsRetrievedAt: z.string(),
  connectionState: ConnectionStateSchema,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const AuthSessionResponseSchema = z.object({
  authenticated: z.boolean(),
  username: z.string().nullable(),
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

export const AuthChangePasswordResponseSchema = z.object({ ok: z.boolean() });
export type AuthChangePasswordResponse = z.infer<typeof AuthChangePasswordResponseSchema>;

export interface RiskRule { id: string; scope: 'account'|'venue'|'asset'|'strategy'; metric: string; limit: string; enabled: boolean; }

export const TradingModeSchema = z.enum(['unset', 'readonly', 'live']);
export type TradingMode = z.infer<typeof TradingModeSchema>;

export const TradingModeResponseSchema = z.object({ mode: TradingModeSchema });
export type TradingModeResponse = z.infer<typeof TradingModeResponseSchema>;

export const SystemDiscoverySchema = z.object({
  product: z.string(),
  mode: EnvironmentSchema,
  authenticatedTradingEnabled: z.boolean(),
  tradingMode: TradingModeSchema,
  docs: z.object({ apiVersion: z.string(), retrievedAt: z.string() }),
  database: z.object({ migrationCount: z.number().int().nonnegative(), currentMigration: z.string().nullable() }),
  security: z.object({
    credentialStorage: z.enum(['os_keychain', 'env_file', 'memory_test_only', 'unavailable']),
    credentialEntryPath: z.literal('/secure/credentials'),
    browserJavaScriptHandlesSecrets: z.literal(false),
  }),
});
export type SystemDiscovery = z.infer<typeof SystemDiscoverySchema>;

export const CredentialConnectionStatusSchema = z.object({
  configured: z.boolean(),
  storage: z.enum(['os_keychain', 'env_file', 'memory_test_only', 'unavailable']),
  label: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  secureEntryPath: z.literal('/secure/credentials'),
  readOnly: z.boolean(),
  activeProfileId: z.string().nullable(),
  profiles: z.array(z.object({
    id: z.string(),
    label: z.string(),
    storage: z.enum(['os_keychain', 'env_file', 'memory_test_only', 'unavailable']),
    lastVerifiedAt: z.string().nullable(),
    active: z.boolean(),
  })),
});
export type CredentialConnectionStatus = z.infer<typeof CredentialConnectionStatusSchema>;

export const ReadOnlyAccountSummarySchema = z.object({
  availableMargin: z.string(),
  marginBalance: z.string(),
  initialMargin: z.string(),
  maintenanceMargin: z.string(),
  initialMarginRate: z.string(),
  maintenanceMarginRate: z.string(),
  positionMode: z.string(),
  accountMode: z.string(),
  exchangeType: z.string(),
  venues: z.array(z.string()),
  assetCount: z.number().int().nonnegative(),
  remoteUpdatedAt: z.string(),
  verifiedAt: z.string(),
});
export type ReadOnlyAccountSummary = z.infer<typeof ReadOnlyAccountSummarySchema>;

export const CrossExInstrumentSchema = z.object({
  symbol: z.string(),
  exchangeType: z.string(),
  businessType: z.string(),
  state: z.string(),
  minSize: z.string(),
  minNotional: z.string().nullable(),
  lotSize: z.string(),
  tickSize: z.string(),
  maxNumOrders: z.string(),
  maxMarketSize: z.string().nullable(),
  maxLimitSize: z.string().nullable(),
  contractSize: z.string().nullable(),
  liquidationFee: z.string().nullable(),
  defaultLeverage: z.string().nullable(),
  delistTime: z.string(),
});
export type CrossExInstrument = z.infer<typeof CrossExInstrumentSchema>;

export interface MarketAssetAlias {
  venue: string;
  businessType: string;
  nativeAsset: string;
  canonicalAsset: string;
}

/**
 * Version-controlled identity aliases for venue tickers that name the same underlying asset
 * differently. Keep these scoped by venue and product so similarly named instruments elsewhere
 * are never merged accidentally.
 */
export const MARKET_ASSET_ALIASES = [
  {
    venue: 'HYPERLIQUID',
    businessType: 'FUTURE',
    nativeAsset: 'SKHX',
    canonicalAsset: 'SKHYNIX',
  },
] as const satisfies readonly MarketAssetAlias[];

function marketAssetAliasKey(venue: string, businessType: string, asset: string): string {
  return `${venue.toUpperCase()}:${businessType.toUpperCase()}:${asset.toUpperCase()}`;
}

const canonicalMarketAssetByNative = new Map<string, string>();
const nativeMarketAssetByCanonical = new Map<string, string>();

for (const alias of MARKET_ASSET_ALIASES) {
  const nativeKey = marketAssetAliasKey(alias.venue, alias.businessType, alias.nativeAsset);
  const canonicalKey = marketAssetAliasKey(alias.venue, alias.businessType, alias.canonicalAsset);
  if (canonicalMarketAssetByNative.has(nativeKey)) throw new Error(`Duplicate market asset alias: ${nativeKey}`);
  if (nativeMarketAssetByCanonical.has(canonicalKey)) throw new Error(`Ambiguous market asset routing alias: ${canonicalKey}`);
  canonicalMarketAssetByNative.set(nativeKey, alias.canonicalAsset);
  nativeMarketAssetByCanonical.set(canonicalKey, alias.nativeAsset);
}

/** Resolve an exchange-native asset code to the canonical identity used by the UI and API. */
export function canonicalMarketAsset(venue: string, businessType: string, nativeAsset: string): string {
  return canonicalMarketAssetByNative.get(marketAssetAliasKey(venue, businessType, nativeAsset)) ?? nativeAsset;
}

/** Resolve a canonical asset identity back to the native code required in an executable symbol. */
export function nativeMarketAsset(venue: string, businessType: string, canonicalAsset: string): string {
  return nativeMarketAssetByCanonical.get(marketAssetAliasKey(venue, businessType, canonicalAsset)) ?? canonicalAsset;
}

export const CrossExInstrumentCatalogSchema = z.object({
  items: z.array(CrossExInstrumentSchema),
  fetchedAt: z.string(),
  source: z.literal('gate_crossex_public_rest'),
  cacheStatus: z.enum(['fresh', 'stale']),
  upstreamStatus: z.enum(['healthy', 'unavailable']),
});
export type CrossExInstrumentCatalog = z.infer<typeof CrossExInstrumentCatalogSchema>;

export const CrossExRiskLimitTierSchema = z.object({
  tier: z.string(),
  minRiskLimitValue: z.string(),
  maxRiskLimitValue: z.string(),
  quickCalAmount: z.string(),
  leverageMax: z.string(),
  maintenanceRate: z.string(),
});
export type CrossExRiskLimitTier = z.infer<typeof CrossExRiskLimitTierSchema>;

export const CrossExRiskLimitSchema = z.object({
  symbol: z.string(),
  tiers: z.array(CrossExRiskLimitTierSchema),
});
export type CrossExRiskLimit = z.infer<typeof CrossExRiskLimitSchema>;

export const CrossExRiskLimitResponseSchema = z.object({
  item: CrossExRiskLimitSchema,
  fetchedAt: z.string(),
  source: z.literal('gate_crossex_public_rest'),
  cacheStatus: z.enum(['fresh', 'stale']),
  upstreamStatus: z.enum(['healthy', 'unavailable']),
});
export type CrossExRiskLimitResponse = z.infer<typeof CrossExRiskLimitResponseSchema>;

export const CrossExTransferAccountSchema = z.enum([
  'SPOT',
  'CROSSEX',
  'CROSSEX_BINANCE',
  'CROSSEX_OKX',
  'CROSSEX_GATE',
  'CROSSEX_BYBIT',
  'CROSSEX_KRAKEN',
  'CROSSEX_HYPERLIQUID',
  'CROSSEX_DERIBIT',
  'CROSSEX_LIGHTER',
]);
export type CrossExTransferAccount = z.infer<typeof CrossExTransferAccountSchema>;

const CrossExTransferAmountSchema = z.string().trim().min(1).max(40)
  .regex(/^\d+(?:\.\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0);

export const CrossExTransferRequestSchema = z.object({
  coin: z.string().trim().regex(/^[A-Z0-9]{1,20}$/),
  amount: CrossExTransferAmountSchema,
  from: CrossExTransferAccountSchema,
  to: CrossExTransferAccountSchema,
  text: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
}).refine((value) => value.from !== value.to, {
  message: 'source and destination accounts must differ',
  path: ['to'],
});
export type CrossExTransferRequest = z.infer<typeof CrossExTransferRequestSchema>;

/**
 * Instant-convert (flash convert) — Gate's own repayment path for a venue deficit: convert
 * CROSSEX USDT into the coin a venue owes, then either transfer it there or convert straight onto
 * that venue (`exchange_type`). DERIBIT and CROSSEX are NOT quotable venues.
 */
/**
 * Venues Gate's flash convert can quote onto. Third-party SDK wrappers list only
 * BINANCE/OKX/GATE/BYBIT/HYPERLIQUID/KRAKEN/LIGHTER, but Gate announced Deribit USDC futures and
 * Deribit USDT spot on 2026-07-14, so DERIBIT is offered here and the exchange stays the
 * authority: an unsupported venue is rejected with CONVERT_TRADE_QUOTE_* rather than guessed at
 * client side.
 */
export const CrossExConvertVenueSchema = z.enum([
  'BINANCE', 'OKX', 'GATE', 'BYBIT', 'HYPERLIQUID', 'KRAKEN', 'LIGHTER', 'DERIBIT',
]);
export type CrossExConvertVenue = z.infer<typeof CrossExConvertVenueSchema>;

const CrossExCoinSchema = z.string().trim().regex(/^[A-Z0-9]{1,20}$/);

export const CrossExConvertQuoteRequestSchema = z.object({
  exchangeType: CrossExConvertVenueSchema,
  fromCoin: CrossExCoinSchema,
  toCoin: CrossExCoinSchema,
  fromAmount: z.string().trim().regex(/^\d+(?:\.\d+)?$/),
}).refine((value) => value.fromCoin !== value.toCoin, {
  message: 'coins must differ',
  path: ['toCoin'],
});
export type CrossExConvertQuoteRequest = z.infer<typeof CrossExConvertQuoteRequestSchema>;

export const CrossExConvertQuoteSchema = z.object({
  quoteId: z.string(),
  fromCoin: z.string(),
  toCoin: z.string(),
  fromAmount: z.string(),
  toAmount: z.string(),
  rate: z.string().nullable(),
  fee: z.string().nullable(),
  /** Quote validity as an ISO instant, null when Gate only returned a relative window. */
  expiresAt: z.string().nullable(),
});
export type CrossExConvertQuote = z.infer<typeof CrossExConvertQuoteSchema>;

export const CrossExConvertOrderRequestSchema = z.object({ quoteId: z.string().trim().min(1) });
export const CrossExConvertOrderSchema = z.object({
  orderId: z.string().nullable(),
  status: z.string().nullable(),
  fromCoin: z.string().nullable(),
  toCoin: z.string().nullable(),
  fromAmount: z.string().nullable(),
  toAmount: z.string().nullable(),
});
export type CrossExConvertOrder = z.infer<typeof CrossExConvertOrderSchema>;

export const CrossExInterestRateSchema = z.object({
  coin: z.string(),
  exchangeType: z.string(),
  hourlyRate: z.string(),
});
export const CrossExInterestRatesResponseSchema = z.object({
  items: z.array(CrossExInterestRateSchema),
  fetchedAt: z.string(),
});
export type CrossExInterestRatesResponse = z.infer<typeof CrossExInterestRatesResponseSchema>;

/**
 * One negative venue balance with what it costs and how it can be cleared. `settlement` is the
 * cheapest legal transfer this account can make today (null when no route exists), and
 * `autoEligible` says whether the fee is small enough to settle without asking.
 */
export const PortfolioDeficitSchema = z.object({
  venue: z.string(),
  coin: z.string(),
  /** Positive magnitude of the negative balance. */
  deficit: z.string(),
  /** Hourly borrow rate as a fraction string; null when the venue/coin is not quoted. */
  hourlyRate: z.string().nullable(),
  /** Implied monthly carrying cost in the deficit coin; null without a rate. */
  monthlyCost: z.string().nullable(),
  settlement: z.object({
    from: z.string(),
    to: z.string(),
    amount: z.string(),
    fee: z.string(),
    /** Fee / deficit in bps; null when the deficit is zero. */
    feeBps: z.number().nullable(),
    autoEligible: z.boolean(),
  }).nullable(),
  /** Why the deficit cannot be settled automatically (machine-readable). */
  reason: z.string().nullable(),
});
export type PortfolioDeficit = z.infer<typeof PortfolioDeficitSchema>;

export const PortfolioDeficitsResponseSchema = z.object({
  items: z.array(PortfolioDeficitSchema),
  fetchedAt: z.string(),
});
export type PortfolioDeficitsResponse = z.infer<typeof PortfolioDeficitsResponseSchema>;

export const SettleDeficitsResponseSchema = z.object({
  settled: z.array(z.object({
    venue: z.string(),
    coin: z.string(),
    amount: z.string(),
    transactionId: z.string(),
  })),
  /** Legal routes whose fee exceeded the 2% ceiling — the user decides on these. */
  withheld: z.array(z.object({
    venue: z.string(),
    coin: z.string(),
    amount: z.string(),
    fee: z.string(),
    feeBps: z.number(),
  })),
  skipped: z.array(z.object({
    venue: z.string(),
    coin: z.string(),
    deficit: z.string(),
    reason: z.string(),
  })),
});
export type SettleDeficitsResponse = z.infer<typeof SettleDeficitsResponseSchema>;

/**
 * A user-saved spread pair for the 美股价差溢价套利 page. The two legs may be different assets
 * (SNDK vs SNXX), so the pair is stored as its two explicit symbols plus the quantity conversion;
 * `ratio` is LEFT units per ONE right unit (right quantity = left quantity ÷ ratio).
 */
export const SavedStrategyPairSchema = z.object({
  id: z.string(),
  name: z.string(),
  leftSymbol: z.string(),
  rightSymbol: z.string(),
  ratio: z.string(),
  entryBps: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedStrategyPair = z.infer<typeof SavedStrategyPairSchema>;

export const SavedStrategyPairsResponseSchema = z.object({ pairs: z.array(SavedStrategyPairSchema) });
export type SavedStrategyPairsResponse = z.infer<typeof SavedStrategyPairsResponseSchema>;

export const SaveStrategyPairRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  leftSymbol: z.string().trim().min(1).max(80),
  rightSymbol: z.string().trim().min(1).max(80),
  ratio: z.string().trim().regex(/^\d+(?:\.\d+)?$/).refine((value) => Number(value) > 0, {
    message: 'ratio must be positive',
  }),
  entryBps: z.string().trim().regex(/^-?\d+(?:\.\d+)?$/).optional(),
}).refine((value) => value.leftSymbol !== value.rightSymbol, {
  message: 'the two legs must be different symbols',
  path: ['rightSymbol'],
});
export type SaveStrategyPairRequest = z.infer<typeof SaveStrategyPairRequestSchema>;

export const DeleteStrategyPairResponseSchema = z.object({ deleted: z.boolean() });

export function canonicalCrossExTransferAccount(
  account: CrossExTransferAccount,
  coin: string,
  accountMode: string,
): CrossExTransferAccount {
  if (coin !== 'USDT') return account;
  if (accountMode === 'CROSS_EXCHANGE' && account.startsWith('CROSSEX_')) return 'CROSSEX';
  if (accountMode === 'ISOLATED_EXCHANGE' && account === 'CROSSEX') return 'CROSSEX_GATE';
  return account;
}

export function canonicalizeCrossExTransfer(
  transfer: CrossExTransferRequest,
  accountMode: string,
): CrossExTransferRequest {
  return {
    ...transfer,
    from: canonicalCrossExTransferAccount(transfer.from, transfer.coin, accountMode),
    to: canonicalCrossExTransferAccount(transfer.to, transfer.coin, accountMode),
  };
}

export type CrossExTransferRouteError =
  | 'HYPERLIQUID_USDC_SPOT_ONLY'
  | 'LIGHTER_USDC_SPOT_ONLY'
  | 'KRAKEN_USDT_ONLY'
  | 'EXPLICIT_VENUE_ACCOUNT_REQUIRED'
  | 'USDT_SPOT_CROSSEX_REQUIRED'
  | 'INVALID_ISOLATED_TRANSFER_ROUTE';

/** Gate's API changelog documents these venue accounts as USDC-only, and only to or from Gate Spot. */
const USDC_SPOT_ONLY_ACCOUNTS = [
  ['CROSSEX_HYPERLIQUID', 'HYPERLIQUID_USDC_SPOT_ONLY'],
  ['CROSSEX_LIGHTER', 'LIGHTER_USDC_SPOT_ONLY'],
] as const satisfies ReadonlyArray<readonly [CrossExTransferAccount, CrossExTransferRouteError]>;

export function crossExTransferRouteError(
  transfer: Pick<CrossExTransferRequest, 'coin' | 'from' | 'to'>,
  accountMode: string,
): CrossExTransferRouteError | null {
  // Gate's transfer-coin endpoint is a global currency list, not a route matrix. Non-USDT
  // transfers may use explicit venue accounts; Hyperliquid, Lighter, and Kraken add narrower exceptions.
  const originalAccounts = [transfer.from, transfer.to] as const;
  const hasOriginalAccount = (account: CrossExTransferAccount) => originalAccounts.includes(account);
  const originalOtherSideOf = (account: CrossExTransferAccount) => transfer.from === account ? transfer.to : transfer.from;

  for (const [account, error] of USDC_SPOT_ONLY_ACCOUNTS) {
    if (!hasOriginalAccount(account)) continue;
    return transfer.coin !== 'USDC' || originalOtherSideOf(account) !== 'SPOT' ? error : null;
  }
  if (hasOriginalAccount('CROSSEX_KRAKEN') && transfer.coin !== 'USDT') return 'KRAKEN_USDT_ONLY';

  const from = canonicalCrossExTransferAccount(transfer.from, transfer.coin, accountMode);
  const to = canonicalCrossExTransferAccount(transfer.to, transfer.coin, accountMode);
  const accounts = [from, to] as const;
  const hasAccount = (account: CrossExTransferAccount) => accounts.includes(account);

  if (transfer.coin !== 'USDT') {
    return hasAccount('CROSSEX') ? 'EXPLICIT_VENUE_ACCOUNT_REQUIRED' : null;
  }

  if (from === to) return accountMode === 'CROSS_EXCHANGE'
    ? 'USDT_SPOT_CROSSEX_REQUIRED'
    : 'INVALID_ISOLATED_TRANSFER_ROUTE';

  if (accountMode === 'CROSS_EXCHANGE') {
    return (from === 'SPOT' && to === 'CROSSEX') || (to === 'SPOT' && from === 'CROSSEX')
      ? null
      : 'USDT_SPOT_CROSSEX_REQUIRED';
  }

  return !hasAccount('CROSSEX') && accounts.some((account) => account.startsWith('CROSSEX_'))
    ? null
    : 'INVALID_ISOLATED_TRANSFER_ROUTE';
}

export const CrossExTransferCoinSchema = z.object({
  coin: z.string(),
  minimumAmount: z.string(),
  estimatedFee: z.string(),
  precision: z.number().int().nonnegative(),
  disabled: z.boolean(),
});
export type CrossExTransferCoin = z.infer<typeof CrossExTransferCoinSchema>;

export const CrossExTransferCoinsResponseSchema = z.object({
  items: z.array(CrossExTransferCoinSchema),
  fetchedAt: z.string(),
  cacheStatus: z.enum(['fresh', 'stale']),
});
export type CrossExTransferCoinsResponse = z.infer<typeof CrossExTransferCoinsResponseSchema>;

export const CrossExTransferBalanceSchema = z.object({
  account: CrossExTransferAccountSchema,
  coin: z.string(),
  available: z.string(),
});
export type CrossExTransferBalance = z.infer<typeof CrossExTransferBalanceSchema>;

export const CrossExTransferBalancesResponseSchema = z.object({
  items: z.array(CrossExTransferBalanceSchema),
  fetchedAt: z.string(),
});
export type CrossExTransferBalancesResponse = z.infer<typeof CrossExTransferBalancesResponseSchema>;

export const CrossExTransferResponseSchema = z.object({
  transactionId: z.string(),
  text: z.string(),
});
export type CrossExTransferResponse = z.infer<typeof CrossExTransferResponseSchema>;

export const CrossExTransferRecordSchema = z.object({
  id: z.string(),
  text: z.string(),
  from: CrossExTransferAccountSchema,
  to: CrossExTransferAccountSchema,
  coin: z.string(),
  amount: z.string(),
  actualReceive: z.string().nullable(),
  status: z.enum(['FAIL', 'SUCCESS', 'PENDING']),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CrossExTransferRecord = z.infer<typeof CrossExTransferRecordSchema>;

export const CrossExAccountBookRecordSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  statementType: z.string(),
  venue: z.string(),
  coin: z.string(),
  symbol: z.string().nullable(),
  change: z.string(),
  balance: z.string(),
  createdAt: z.string(),
});
export type CrossExAccountBookRecord = z.infer<typeof CrossExAccountBookRecordSchema>;

export const CrossExPortfolioActivityResponseSchema = z.object({
  transfers: z.array(CrossExTransferRecordSchema),
  accountBook: z.array(CrossExAccountBookRecordSchema),
  fundingFees: z.array(CrossExAccountBookRecordSchema),
  fetchedAt: z.string(),
});
export type CrossExPortfolioActivityResponse = z.infer<typeof CrossExPortfolioActivityResponseSchema>;

export const PublicMarketSnapshotSchema = z.object({
  symbol: z.string(),
  venue: z.enum(['BINANCE', 'GATE', 'OKX']),
  product: z.literal('FUTURE'),
  bidPrice: z.string().nullable(),
  askPrice: z.string().nullable(),
  lastPrice: z.string().nullable(),
  markPrice: z.string(),
  indexPrice: z.string(),
  fundingRate: z.string(),
  predictedFundingRate: z.string().nullable(),
  nextFundingAt: z.string(),
  sourceTimestamp: z.string(),
  fetchedAt: z.string(),
  source: z.enum([
    'binance_futures_public_rest',
    'gate_futures_public_rest',
    'okx_public_rest',
  ]),
});
export type PublicMarketSnapshot = z.infer<typeof PublicMarketSnapshotSchema>;

export const PublicMarketSnapshotResponseSchema = z.object({
  snapshot: PublicMarketSnapshotSchema,
  cacheStatus: z.enum(['fresh', 'stale']),
  upstreamStatus: z.enum(['healthy', 'unavailable']),
});
export type PublicMarketSnapshotResponse = z.infer<typeof PublicMarketSnapshotResponseSchema>;

export const PortfolioBalanceSchema = z.object({
  venue: z.string(), coin: z.string(), balance: z.string(), unrealizedPnl: z.string(),
  equity: z.string(), futuresInitialMargin: z.string(), futuresMaintenanceMargin: z.string(),
  borrowingInitialMargin: z.string(), borrowingMaintenanceMargin: z.string(),
  availableBalance: z.string(), liability: z.string(),
});
export type PortfolioBalance = z.infer<typeof PortfolioBalanceSchema>;

export const PortfolioFuturesPositionSchema = z.object({
  positionId: z.string(), symbol: z.string(), positionSide: z.string(), initialMargin: z.string(),
  maintenanceMargin: z.string(), quantity: z.string(), value: z.string(), unrealizedPnl: z.string(),
  unrealizedPnlRate: z.string(), entryPrice: z.string(), markPrice: z.string(), leverage: z.string(),
  maxLeverage: z.string(), riskLimit: z.string(), fee: z.string(), fundingFee: z.string(),
  fundingTime: z.string(), createdAt: z.string(), updatedAt: z.string(), realizedPnl: z.string(),
  crossExAdlRank: z.string().nullable().optional(), exchangeAdlRank: z.string().nullable().optional(),
});
export type PortfolioFuturesPosition = z.infer<typeof PortfolioFuturesPositionSchema>;

export const PortfolioMarginPositionSchema = z.object({
  positionId: z.string(), symbol: z.string(), positionSide: z.string(), initialMargin: z.string(),
  maintenanceMargin: z.string(), assetQuantity: z.string(), assetCoin: z.string(), value: z.string(),
  liability: z.string(), liabilityCoin: z.string(), interest: z.string(), maxPositionQuantity: z.string(),
  entryPrice: z.string(), indexPrice: z.string(), unrealizedPnl: z.string(), unrealizedPnlRate: z.string(),
  leverage: z.string(), maxLeverage: z.string(), createdAt: z.string(), updatedAt: z.string(),
});
export type PortfolioMarginPosition = z.infer<typeof PortfolioMarginPositionSchema>;

export const PortfolioOrderSchema = z.object({
  orderId: z.string(), clientOrderId: z.string(), state: z.string(), symbol: z.string(),
  side: z.string(), type: z.string(), attribute: z.string(), venue: z.string(), product: z.string(),
  quantity: z.string(), quoteQuantity: z.string(), price: z.string(), timeInForce: z.string(),
  executedQuantity: z.string(), executedAmount: z.string(), executedAveragePrice: z.string(),
  feeCoin: z.string(), fee: z.string(), reduceOnly: z.string(), leverage: z.string(), reason: z.string(),
  positionSide: z.string(), createdAt: z.string(), updatedAt: z.string(),
});
export type PortfolioOrder = z.infer<typeof PortfolioOrderSchema>;

export const PortfolioFillSchema = z.object({
  transactionId: z.string(), orderId: z.string(), clientOrderId: z.string(), symbol: z.string(),
  venue: z.string(), product: z.string(), side: z.string(), quantity: z.string(), price: z.string(),
  fee: z.string(), feeCoin: z.string(), feeRate: z.string(), matchRole: z.string(),
  realizedPnl: z.string(), positionMode: z.string(), positionSide: z.string(), createdAt: z.string(),
});
export type PortfolioFill = z.infer<typeof PortfolioFillSchema>;

export const PortfolioSnapshotSchema = z.object({
  account: z.object({
    availableMargin: z.string(), marginBalance: z.string(), initialMargin: z.string(),
    maintenanceMargin: z.string(), initialMarginRate: z.string(), maintenanceMarginRate: z.string(),
    positionMode: z.string(), accountMode: z.string(), exchangeType: z.string(), remoteUpdatedAt: z.string(),
  }),
  balances: z.array(PortfolioBalanceSchema),
  futuresPositions: z.array(PortfolioFuturesPositionSchema),
  marginPositions: z.array(PortfolioMarginPositionSchema),
  openOrders: z.array(PortfolioOrderSchema),
  recentFills: z.array(PortfolioFillSchema),
  fetchedAt: z.string(),
  source: z.literal('gate_crossex_authenticated_rest'),
});
export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshotSchema>;

export const ReconciliationIssueSchema = z.object({
  code: z.enum([
    'baseline_created', 'unknown_order_detected', 'order_resolved_by_fill',
    'order_missing_without_fill', 'unknown_futures_position_detected',
    'futures_position_changed', 'futures_position_disappeared',
    'unknown_margin_position_detected', 'margin_position_changed',
    'margin_position_disappeared', 'new_fill_detected',
    'account_configuration_changed', 'remote_refresh_failed',
  ]),
  severity: z.enum(['info', 'warning']),
  entityType: z.enum(['account', 'order', 'futures_position', 'margin_position', 'fill', 'system']),
  entityId: z.string().nullable(),
  summary: z.string(),
  changedFields: z.array(z.string()),
});
export type ReconciliationIssue = z.infer<typeof ReconciliationIssueSchema>;

export const ReconciliationReportSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  status: z.enum(['baseline', 'clean', 'changes_detected', 'ambiguous', 'stale']),
  previousFetchedAt: z.string().nullable(),
  currentFetchedAt: z.string(),
  issues: z.array(ReconciliationIssueSchema),
});
export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;

export const PortfolioSnapshotResponseSchema = z.object({
  snapshot: PortfolioSnapshotSchema,
  dataStatus: z.enum(['fresh', 'stale']),
  remoteStatus: z.enum(['healthy', 'unavailable']),
  reconciliation: ReconciliationReportSchema,
});
export type PortfolioSnapshotResponse = z.infer<typeof PortfolioSnapshotResponseSchema>;

export const ReconciliationReportListSchema = z.object({
  reports: z.array(ReconciliationReportSchema),
});
export type ReconciliationReportList = z.infer<typeof ReconciliationReportListSchema>;

export const CandleIntervalSchema = z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d']);
export type CandleInterval = z.infer<typeof CandleIntervalSchema>;

export const CANDLE_INTERVAL_MILLISECONDS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

export const CandleSchema = z.object({
  startTime: z.number().int().nonnegative(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volume: z.string(),
  closed: z.boolean(),
});
export type Candle = z.infer<typeof CandleSchema>;

/**
 * Return only the newest gap-free candle run. A chart must never connect two
 * unrelated market periods across a missing interval.
 */
export function contiguousCandleTail(
  candles: Candle[],
  interval: CandleInterval,
  limit = Number.MAX_SAFE_INTEGER,
): Candle[] {
  const byStartTime = new Map<number, Candle>();
  for (const candle of candles) byStartTime.set(candle.startTime, candle);
  const ordered = [...byStartTime.values()].sort((left, right) => left.startTime - right.startTime);
  if (ordered.length === 0 || limit <= 0) return [];

  const intervalMilliseconds = CANDLE_INTERVAL_MILLISECONDS[interval];
  let first = ordered.length - 1;
  while (first > 0 && ordered[first]!.startTime - ordered[first - 1]!.startTime === intervalMilliseconds) {
    first -= 1;
  }
  return ordered.slice(Math.max(first, ordered.length - Math.floor(limit)));
}

export const CandleSeriesResponseSchema = z.object({
  symbol: z.string(),
  interval: CandleIntervalSchema,
  candles: z.array(CandleSchema),
  source: z.enum(['venue_public_rest_and_crossex_websocket', 'crossex_websocket_only']),
  building: z.boolean(),
  hasMore: z.boolean(),
});
export type CandleSeriesResponse = z.infer<typeof CandleSeriesResponseSchema>;

export const MarketCatalogVenueSchema = z.object({
  venue: z.string(),
  symbol: z.string(),
  quote: z.string(),
  /** Which business line this catalog row belongs to; defaulted so older payloads stay compatible. */
  business: z.enum(['FUTURE', 'SPOT']).default('FUTURE'),
});
export type MarketCatalogVenue = z.infer<typeof MarketCatalogVenueSchema>;

export const MarketCatalogAssetSchema = z.object({
  asset: z.string(),
  /** True when the market hub is currently streaming ticker/funding/OI for this asset. */
  streamed: z.boolean(),
  venues: z.array(MarketCatalogVenueSchema),
});
export type MarketCatalogAsset = z.infer<typeof MarketCatalogAssetSchema>;

export const MarketCatalogResponseSchema = z.object({
  assets: z.array(MarketCatalogAssetSchema),
  fetchedAt: z.string(),
  cacheStatus: z.enum(['fresh', 'stale']),
});
export type MarketCatalogResponse = z.infer<typeof MarketCatalogResponseSchema>;

export const FundingOverviewVenueEntrySchema = z.object({
  venue: z.string(),
  symbol: z.string(),
  quote: z.string(),
  /** Native fraction charged or paid at one venue funding interval. */
  fundingRate: z.string().nullable(),
  /** Native funding interval in hours; null when the venue row is unavailable. */
  fundingIntervalHours: z.number().positive().max(24).nullable(),
  /** 8h-equivalent fraction used for cross-venue comparisons. */
  fundingRate8h: z.string().nullable(),
  nextFundingAt: z.string().nullable(),
  /** Open interest in USD; null when the venue publishes no bulk OI (BINANCE) or the row is missing. */
  openInterestValue: z.string().nullable(),
  /** Last or mark price from the venue's bulk ticker feed. */
  lastPrice: z.string().nullable(),
  /** Fractional 24h price change, e.g. -0.012 means -1.2%. */
  change24h: z.string().nullable(),
  fetchedAt: z.string().nullable(),
});
export type FundingOverviewVenueEntry = z.infer<typeof FundingOverviewVenueEntrySchema>;

export const FundingOverviewAssetSchema = z.object({
  asset: z.string(),
  venues: z.array(FundingOverviewVenueEntrySchema),
});
export type FundingOverviewAsset = z.infer<typeof FundingOverviewAssetSchema>;

export const FundingOverviewVenueStatusSchema = z.object({
  venue: z.string(),
  status: z.enum(['ok', 'error']),
  fetchedAt: z.string().nullable(),
  rowCount: z.number().int().nonnegative(),
});
export type FundingOverviewVenueStatus = z.infer<typeof FundingOverviewVenueStatusSchema>;

export const FundingOverviewResponseSchema = z.object({
  assets: z.array(FundingOverviewAssetSchema),
  venueStatus: z.array(FundingOverviewVenueStatusSchema),
  fetchedAt: z.string(),
  cacheStatus: z.enum(['fresh', 'stale']),
});
export type FundingOverviewResponse = z.infer<typeof FundingOverviewResponseSchema>;

/**
 * Derived classification carried by every opportunity row.
 *
 * All four fields default so payloads produced before this change (and rows built without the
 * catalog context) keep parsing: the backend fills them in, the frontend only renders them.
 */
export const OpportunityRowClassificationSchema = z.object({
  assetClass: AssetClassSchema.default('TOKEN'),
  assetSuperClass: AssetSuperClassSchema.default('CRYPTO'),
  /** Stripped variant marker (`X` / `ON` / `B` / `G`); `null` for canonical assets. */
  variantSuffix: z.string().nullable().default(null),
  isPreIpo: z.boolean().default(false),
});
export type OpportunityRowClassification = z.infer<typeof OpportunityRowClassificationSchema>;

/**
 * 24h volume and open interest of one opportunity leg. Amounts are Decimal strings; `null` means
 * "not published by the venue" and renders as `—`. Spot legs never carry open interest.
 */
export const OpportunityMarketStatsSchema = z.object({
  /** 24h volume denominated in the base asset. */
  volume24h: z.string().nullable().default(null),
  /** 24h volume denominated in the quote currency (USD) — the value shown in the table. */
  quoteVolume24h: z.string().nullable().default(null),
  /** Open interest denominated in the base asset. */
  openInterest: z.string().nullable().default(null),
  /** Open interest denominated in USD — the value shown in the table; null for spot legs. */
  openInterestValue: z.string().nullable().default(null),
});
export type OpportunityMarketStats = z.infer<typeof OpportunityMarketStatsSchema>;

/**
 * Current funding rate of both legs of a spread row.
 *
 * A cross-exchange spread is only half the story: what the position actually earns or pays while
 * it is open is the funding differential between its two legs. These three fields carry that
 * reading next to the pair itself, so the board can show the carry cost without a second request.
 *
 * The `…8h` values are the venues' current rates scaled to an 8h settlement, as Decimal
 * fractions — the same unit and scaling as the funding board's `fundingRate8h` column
 * (`0.00013` renders as `0.0130%`). They are `null` — never `0` — when the leg has no funding at
 * all (a spot leg) or when the venue does not publish one: a zero rate is a real measurement
 * (free carry), a missing one is not, and confusing the two would misprice the trade.
 *
 * Every field is optional so payloads produced before this reading existed keep parsing; a
 * consumer must treat "absent" exactly like "null" (the UI renders `—` for both).
 */
export const SpreadLegFundingSchema = z.object({
  /** Current 8h-equivalent funding fraction of the sell leg; null for spot / unpublished. */
  leftFundingRate8h: z.string().nullable().optional(),
  /** Current 8h-equivalent funding fraction of the buy leg; null for spot / unpublished. */
  rightFundingRate8h: z.string().nullable().optional(),
  /**
   * (left − right) × 10⁴, in bps per 8h: the funding the pair collects (positive) or pays
   * (negative) while both legs are held. Null when either leg's rate is unknown — the
   * differential of a partially known pair is unknown, not zero.
   */
  fundingRateDiffBps: z.number().finite().nullable().optional(),
});
export type SpreadLegFunding = z.infer<typeof SpreadLegFundingSchema>;

/** One ranked funding-carry opportunity on the Opportunities board. */
export const FundingOpportunitySchema = z.object({
  asset: z.string(),
  venue: z.string(),
  /** Executable perpetual symbol the funding rate belongs to. */
  symbol: z.string(),
  /** Spot leg symbol of this row's venue combination; null when no live spot pair is connected. */
  spotSymbol: z.string().nullable(),
  /**
   * Spot leg of this row's (spot venue × perpetual venue) combination; null when the row's spot
   * venue lists no connected live spot pair. Collapsed rows carry the preferred venue, expanded
   * rows carry their own combination's venue.
   */
  spotVenue: z.string().nullable().default(null),
  /** Every connected venue that lists a live spot pair for this asset, CATALOG_VENUES order. */
  spotVenues: z.array(z.string()).default([]),
  /** POSITIVE funding → buy spot + short the perpetual; NEGATIVE → the reverse. */
  direction: z.enum(['POSITIVE', 'NEGATIVE']),
  /** |fundingRate8h| × 3 × 365 × 100, in percent; the board sorts this descending. */
  fundingApr: z.number().finite(),
  /** Signed 8h-equivalent funding fraction as a Decimal string. */
  fundingRate8h: z.string(),
  fundingIntervalHours: z.number().positive().max(24).nullable(),
  nextFundingAt: z.string().nullable(),
  lastPrice: z.string().nullable(),
  /** True when the spot hedge leg is connected (registered on the market hub). */
  executable: z.boolean(),
  ...OpportunityRowClassificationSchema.shape,
  /** Volume / open interest of this row's perpetual leg; null when the venue publishes neither. */
  perpStats: OpportunityMarketStatsSchema.nullable().default(null),
});
export type FundingOpportunity = z.infer<typeof FundingOpportunitySchema>;

/**
 * One tradable orientation of an asset's exchange pair, nested under its asset-level row.
 * The board collapses every pair of an asset into a single parent row; these children carry the
 * per-combination detail revealed when the row is expanded.
 */
export const SpreadCombinationSchema = z.object({
  pairType: z.enum(['SPOT_PERP', 'PERP_PERP']),
  /** Sell leg (aligned with the engine's spread = sellBid − buyAsk). */
  leftSymbol: z.string(),
  rightSymbol: z.string(),
  leftVenue: z.string(),
  rightVenue: z.string(),
  sellBid: z.string(),
  buyAsk: z.string(),
  spreadBps: z.number().finite(),
  updatedAt: z.string(),
  /**
   * v0.4.1 quote alignment: both legs' `quoteUpdatedAt` and whether their skew fits the backend's
   * `SPREAD_QUOTE_MAX_SKEW_MS` budget. Optional so payloads produced before v0.4.1 keep parsing;
   * absent means "unknown", which consumers must treat as not aligned.
   */
  leftQuoteUpdatedAt: z.string().optional(),
  rightQuoteUpdatedAt: z.string().optional(),
  quoteAligned: z.boolean().optional(),
  ...SpreadLegFundingSchema.shape,
  executable: z.boolean(),
});
export type SpreadCombination = z.infer<typeof SpreadCombinationSchema>;

/**
 * One ranked cross-exchange spread opportunity on the Opportunities board. Rows are asset-level:
 * the top-level leg fields mirror the asset's *best* combination so sorting and one-click execution
 * keep working unchanged, while `combinations` holds every pair for the expand/collapse detail view.
 */
export const SpreadOpportunitySchema = z.object({
  pairType: z.enum(['SPOT_PERP', 'PERP_PERP']),
  asset: z.string(),
  /** Sell leg (aligned with the engine's spread = sellBid − buyAsk). */
  leftSymbol: z.string(),
  /** Buy leg. */
  rightSymbol: z.string(),
  leftVenue: z.string(),
  rightVenue: z.string(),
  sellBid: z.string(),
  buyAsk: z.string(),
  /** (sellBid − buyAsk) / buyAsk × 10⁴, signed; the board sorts this descending. */
  spreadBps: z.number().finite(),
  updatedAt: z.string(),
  /** v0.4.1 quote alignment timestamps/judgement; optional for pre-v0.4.1 payload compatibility. */
  leftQuoteUpdatedAt: z.string().optional(),
  rightQuoteUpdatedAt: z.string().optional(),
  quoteAligned: z.boolean().optional(),
  /** Current funding rate of both legs of the best combination, for judging the carry cost. */
  ...SpreadLegFundingSchema.shape,
  executable: z.boolean(),
  ...OpportunityRowClassificationSchema.shape,
  /** Volume / open interest of the sell leg. */
  leftStats: OpportunityMarketStatsSchema.nullable().default(null),
  /** Volume / open interest of the buy leg. */
  rightStats: OpportunityMarketStatsSchema.nullable().default(null),
  /** Every (sell venue, buy venue) pair of this asset, best spread first; drives the expand view. */
  combinations: z.array(SpreadCombinationSchema).default([]),
});
export type SpreadOpportunity = z.infer<typeof SpreadOpportunitySchema>;

export const OpportunityResponseSchema = z.object({
  funding: z.array(FundingOpportunitySchema),
  spread: z.array(SpreadOpportunitySchema),
  /** Row counts of each board *after* filtering but *before* paging — used to render page numbers. */
  totals: z.object({
    funding: z.number().int().nonnegative().default(0),
    spread: z.number().int().nonnegative().default(0),
  }).default({ funding: 0, spread: 0 }),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(50),
  fetchedAt: z.string(),
  cacheStatus: z.enum(['fresh', 'stale']),
});
export type OpportunityResponse = z.infer<typeof OpportunityResponseSchema>;

/**
 * One row of the spread-quality board: the 24h statistics of one (asset, sell venue, buy venue)
 * price spread, ranked by how *capturable* the spread is rather than how wide it is right now.
 *
 * The series behind the statistics is either reconstructed from 24h of 5-minute candles
 * (`source: 'candles'`) or sampled from live executable spreads (`source: 'samples'`, once the
 * sampler has accumulated a day). Every statistic is `null` — never zero — when the series is too
 * short or degenerate to support it; rows below the minimum sample count never reach the board.
 */
export const SpreadQualityRowSchema = z.object({
  pairType: z.enum(['SPOT_PERP', 'PERP_PERP']),
  asset: z.string(),
  /** Sell leg (aligned with the engine's spread = sellBid − buyAsk). */
  leftSymbol: z.string(),
  /** Buy leg. */
  rightSymbol: z.string(),
  leftVenue: z.string(),
  rightVenue: z.string(),
  /** The executable spread right now, mirroring the spread board's reading. */
  currentSpreadBps: z.number().finite(),
  /** Mean of the 24h spread series (bps). */
  meanSpreadBps: z.number().finite().nullable(),
  /** Standard deviation of the series (bps). */
  spreadVolatilityBps: z.number().finite().nullable(),
  /** Third moment: positive means the big spreads lean favourable. */
  skewness: z.number().finite().nullable(),
  /** Fourth moment (excess): fat tails mean occasional extreme spreads. */
  excessKurtosis: z.number().finite().nullable(),
  /** |skewness| small and mean ≈ median — the distribution behaves as modelled. */
  symmetric: z.boolean(),
  /** AR(1) coefficient of the series; null when degenerate. ≥ 1 means trending, not reverting. */
  ar1Coefficient: z.number().finite().nullable(),
  /** ln(0.5) / ln(φ): hours for a dislocation to halve. Null when the series does not revert. */
  halfLifeHours: z.number().finite().nonnegative().nullable(),
  /**
   * Funding differential over the expected holding window plus round-trip fees (bps). Null when
   * the funding input is unavailable — scoring then treats the pair as maximally expensive.
   */
  holdingCostBps: z.number().finite().nullable(),
  /** Weaker leg's top-of-book notional (USDT); what a single fill can absorb. */
  bookDepthUsdt: z.number().finite().nonnegative(),
  /** Composite 0–100: weighted percentiles of the factors above across the candidate set. */
  score: z.number().finite(),
  /** Candles or samples behind the statistics. */
  sampleCount: z.number().int().nonnegative(),
  source: z.enum(['candles', 'samples']),
  updatedAt: z.string(),
  /** v0.4.1 quote alignment timestamps/judgement; optional for pre-v0.4.1 payload compatibility. */
  leftQuoteUpdatedAt: z.string().optional(),
  rightQuoteUpdatedAt: z.string().optional(),
  quoteAligned: z.boolean().optional(),
  /** Current funding rate of both legs, displayed next to the pair (see `SpreadLegFundingSchema`). */
  ...SpreadLegFundingSchema.shape,
  ...OpportunityRowClassificationSchema.shape,
});
export type SpreadQualityRow = z.infer<typeof SpreadQualityRowSchema>;

export const SpreadQualityResponseSchema = z.object({
  rows: z.array(SpreadQualityRowSchema),
  /** Candidate-set size before the top-N cut, so the UI can say what it is looking at. */
  totalCandidates: z.number().int().nonnegative(),
  windowHours: z.number().int().positive().default(24),
  fetchedAt: z.string(),
  cacheStatus: z.enum(['fresh', 'stale']),
  /**
   * v0.4.1 server-side sort/paging echo: the sort key and direction actually applied, the offset of
   * the returned window, and the row count of the *sorted* board (for page rendering). Optional so
   * a pre-v0.4.1 response payload keeps parsing and the frontend falls back to its own rendering.
   */
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  offset: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
});
export type SpreadQualityResponse = z.infer<typeof SpreadQualityResponseSchema>;

/** Which market a close-plan leg acts on; spot legs hit the balance, perp legs hit the position. */
export const CloseMarketTypeSchema = z.enum(['SPOT', 'PERP']);
export type CloseMarketType = z.infer<typeof CloseMarketTypeSchema>;

/**
 * Why a planned close leg carries no executable quantity. `dust` means the venue holds a residual
 * smaller than the market's minimum order size — the terminal never auto-liquidates it (PRD Q2);
 * the user is told and decides.
 */
export const CloseSkipReasonSchema = z.enum(['dust', 'no_market', 'no_balance', 'locked_balance']);
export type CloseSkipReason = z.infer<typeof CloseSkipReasonSchema>;

/** One user-requested close target: symbol only — the server derives the quantity from the venue. */
export const CloseTargetInputSchema = z.object({
  symbol: z.string().trim().min(1).max(80),
  /** For hedge-mode futures: which position side this target refers to. Optional = account default. */
  positionSide: z.enum(['NONE', 'LONG', 'SHORT']).optional(),
});
export type CloseTargetInput = z.infer<typeof CloseTargetInputSchema>;

export const ClosePlanRequestSchema = z.object({
  targets: z.array(CloseTargetInputSchema).min(1).max(20),
});
export type ClosePlanRequest = z.infer<typeof ClosePlanRequestSchema>;

/**
 * One leg of a server-reconciled close plan. `quantity` is the venue-truth reducible size (floored
 * to the instrument's lot size for spot); when the residual is below the smallest orderable unit
 * the leg instead carries `skipReason` (typically `dust`) and an empty/zero quantity.
 */
export const CloseLegPlanSchema = z.object({
  symbol: z.string(),
  venue: z.string(),
  marketType: CloseMarketTypeSchema,
  /** Reducing side: SELL closes a long, BUY closes a short/buyback. */
  side: z.enum(['BUY', 'SELL']),
  /** Venue-truth quantity as a decimal string; `'0'` when skipped. */
  quantity: z.string(),
  positionSide: z.string().nullable(),
  skipReason: CloseSkipReasonSchema.optional(),
});
export type CloseLegPlan = z.infer<typeof CloseLegPlanSchema>;

export const ClosePlanResponseSchema = z.object({
  legs: z.array(CloseLegPlanSchema),
  /** Backend wall-clock time of the venue reads the plan was reconciled against. */
  fetchedAt: z.string(),
});
export type ClosePlanResponse = z.infer<typeof ClosePlanResponseSchema>;

/** One residual position the verify pass found above the market's minimum order unit. */
export const ResidualLegSchema = z.object({
  symbol: z.string(),
  venue: z.string(),
  marketType: CloseMarketTypeSchema,
  /** Absolute residual quantity as a decimal string. */
  residualQuantity: z.string(),
  reason: z.string(),
  suggestion: z.string(),
});
export type ResidualLeg = z.infer<typeof ResidualLegSchema>;

export const ResidualReportSchema = z.object({
  residuals: z.array(ResidualLegSchema),
  /** True when every target leg is flat or below the minimum order unit (dust only). */
  clean: z.boolean(),
  fetchedAt: z.string(),
});
export type ResidualReport = z.infer<typeof ResidualReportSchema>;

export const FundingHistoryEntrySchema = z.object({
  symbol: z.string(),
  status: z.enum(['ok', 'pending', 'unavailable']),
  /** Realized funding fractions summed over rolling windows ending at fetchedAt. */
  rate24h: z.string().nullable(),
  rate7d: z.string().nullable(),
  rate30d: z.string().nullable(),
  settlementCount30d: z.number().int().nonnegative(),
  oldestFundingAt: z.string().nullable(),
  newestFundingAt: z.string().nullable(),
  fetchedAt: z.string(),
});
export type FundingHistoryEntry = z.infer<typeof FundingHistoryEntrySchema>;

export const FundingHistoryResponseSchema = z.object({
  entries: z.array(FundingHistoryEntrySchema),
  fetchedAt: z.string(),
});
export type FundingHistoryResponse = z.infer<typeof FundingHistoryResponseSchema>;

export const FundingHistoryPointSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  rate: z.string(),
});
export type FundingHistoryPoint = z.infer<typeof FundingHistoryPointSchema>;

export const FundingHistorySeriesEntrySchema = z.object({
  symbol: z.string(),
  status: z.enum(['ok', 'unavailable']),
  points: z.array(FundingHistoryPointSchema),
  fetchedAt: z.string(),
});
export type FundingHistorySeriesEntry = z.infer<typeof FundingHistorySeriesEntrySchema>;

export const FundingHistorySeriesResponseSchema = z.object({
  entries: z.array(FundingHistorySeriesEntrySchema),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  fetchedAt: z.string(),
});
export type FundingHistorySeriesResponse = z.infer<typeof FundingHistorySeriesResponseSchema>;

export const OrderBookLevelSchema = z.tuple([z.string(), z.string()]);
export type OrderBookLevel = z.infer<typeof OrderBookLevelSchema>;

export const OrderBookSnapshotSchema = z.object({
  symbol: z.string(),
  bids: z.array(OrderBookLevelSchema),
  asks: z.array(OrderBookLevelSchema),
  updatedAt: z.string(),
  source: z.literal('gate_crossex_websocket'),
});
export type OrderBookSnapshot = z.infer<typeof OrderBookSnapshotSchema>;

export const PublicTradeSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  price: z.string(),
  quantity: z.string(),
  side: z.enum(['BUY', 'SELL']),
  executedAt: z.string(),
});
export type PublicTrade = z.infer<typeof PublicTradeSchema>;

export const SymbolFeeRateSchema = z.object({
  symbol: z.string(),
  makerFee: z.string(),
  takerFee: z.string(),
});
export type SymbolFeeRate = z.infer<typeof SymbolFeeRateSchema>;

export const VenueFeeRateSchema = z.object({
  venue: z.string(),
  spotMakerFee: z.string(),
  spotTakerFee: z.string(),
  futureMakerFee: z.string(),
  futureTakerFee: z.string(),
  specialFees: z.array(SymbolFeeRateSchema).optional(),
});
export type VenueFeeRate = z.infer<typeof VenueFeeRateSchema>;

export const VenueFeeRatesResponseSchema = z.object({
  fees: z.array(VenueFeeRateSchema),
  fetchedAt: z.string(),
  cacheStatus: z.enum(['fresh', 'stale']),
});
export type VenueFeeRatesResponse = z.infer<typeof VenueFeeRatesResponseSchema>;

export const LiveBalanceSchema = z.object({
  venue: z.string(),
  coin: z.string(),
  balance: z.string(),
  availableBalance: z.string(),
  equity: z.string(),
  unrealizedPnl: z.string(),
  updatedAt: z.string(),
});
export type LiveBalance = z.infer<typeof LiveBalanceSchema>;

export const LiveMarketSchema = z.object({
  symbol: z.string(),
  venue: z.string(),
  asset: z.string(),
  lastPrice: z.string(),
  bidPrice: z.string(),
  bidSize: z.string(),
  askPrice: z.string(),
  askSize: z.string(),
  open24h: z.string(),
  high24h: z.string(),
  low24h: z.string(),
  volume24h: z.string(),
  quoteVolume24h: z.string(),
  fundingRate: z.string(),
  nextFundingAt: z.string(),
  openInterest: z.string(),
  openInterestValue: z.string(),
  /** Backend wall-clock time when the latest ticker frame was received. */
  receivedAt: z.string(),
  /** Exchange source timestamp carried by the latest ticker frame. */
  updatedAt: z.string(),
  /**
   * Exchange source timestamp of the frame (or order-book update) that last supplied this
   * record's bid/ask. `updatedAt` tracks the latest frame of any kind — a sparse ticker
   * carrying only `lp` refreshes it — so the freshness of the executable quote must be judged
   * from this field, never from `updatedAt`. Absent means the record never carried a quote
   * (a zero-priced placeholder), which no consumer may treat as tradable.
   */
  quoteUpdatedAt: z.string().optional(),
  /**
   * Local (backend) wall-clock arrival time, in epoch ms, of the frame that last supplied this
   * record's bid/ask. It advances under exactly the same condition as `quoteUpdatedAt`, so both
   * describe the same quote — one on the venue's clock, one on ours.
   *
   * Display freshness (quote age, and the leg-to-leg skew of a spread) must be judged from this
   * field: venue clocks disagree by seconds, and comparing two venues' event timestamps declared
   * an executable pair "not time-aligned", which hid the spread for every combination involving
   * the drifting venue. `quoteUpdatedAt` remains the field for measuring *network lag* (received
   * minus source), which is a different question.
   *
   * Optional on purpose: records persisted or produced before this field existed omit it, and a
   * consumer must then fall back to `quoteUpdatedAt` instead of treating the quote as unknown.
   */
  quoteReceivedAt: z.number().nullable().optional(),
  /** rest_book_ticker rows come from the bulk REST sweep and are ~1 TTL cycle stale. */
  source: z.enum(['gate_crossex_websocket', 'demo_seed', 'rest_book_ticker']),
});
export type LiveMarket = z.infer<typeof LiveMarketSchema>;

export const MarketSnapshotSchema = z.object({
  connectionState: z.enum(['connecting', 'healthy', 'reconnecting', 'stale', 'disconnected']),
  updatedAt: z.string(),
  markets: z.array(LiveMarketSchema),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const ExecutionOrderSchema = z.object({
  id: z.string(),
  remoteOrderId: z.string().nullable(),
  clientOrderId: z.string(),
  symbol: z.string(),
  venue: z.string(),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['LIMIT', 'MARKET']),
  timeInForce: z.string(),
  quantity: z.string(),
  price: z.string().nullable(),
  reduceOnly: z.boolean(),
  state: z.string(),
  executedQuantity: z.string(),
  executedAveragePrice: z.string().nullable(),
  failureReason: z.string().nullable().optional(),
  strategyId: z.string().nullable(),
  strategyLeg: z.string().nullable(),
  strategyClip: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExecutionOrder = z.infer<typeof ExecutionOrderSchema>;

/**
 * A locally tracked order whose remote state could not be proven terminal during quiescence.
 * Trading-mode responses carry these so the UI can show exactly what blocks live activation and
 * why, instead of a bare list of ids.
 */
export const UnresolvedOrderSchema = ExecutionOrderSchema.pick({
  id: true, remoteOrderId: true, clientOrderId: true, symbol: true, venue: true, side: true,
  quantity: true, executedQuantity: true, price: true, state: true, strategyId: true,
}).extend({ reason: z.string() });
export type UnresolvedOrder = z.infer<typeof UnresolvedOrderSchema>;

export const ExecutionPositionSchema = z.object({
  position_id: z.string(),
  symbol: z.string(),
  venue: z.string(),
  quantity: z.string(),
  entry_price: z.string(),
  mark_price: z.string(),
  realized_pnl: z.string(),
  funding_fee: z.string().nullable().optional(),
  updated_at: z.string(),
});
export type ExecutionPosition = z.infer<typeof ExecutionPositionSchema>;

export const ExecutionFillSchema = z.object({
  id: z.string(),
  order_id: z.string(),
  symbol: z.string(),
  venue: z.string(),
  side: z.string(),
  quantity: z.string(),
  price: z.string(),
  fee: z.string(),
  realized_pnl: z.string(),
  created_at: z.string(),
});
export type ExecutionFill = z.infer<typeof ExecutionFillSchema>;

export const TradingSnapshotSchema = z.object({
  mode: z.literal('live'),
  orders: z.array(ExecutionOrderSchema),
  positions: z.array(ExecutionPositionSchema),
  fills: z.array(ExecutionFillSchema),
  balances: z.array(LiveBalanceSchema),
});
export type TradingSnapshot = z.infer<typeof TradingSnapshotSchema>;

export const PrivateStreamStatusSchema = z.object({
  state: z.enum([
    'disconnected',
    'credentials_missing',
    'connecting',
    'authenticating',
    'subscribing',
    'live',
    'reconnecting',
    'authentication_failed',
  ]),
  lastEventAt: z.string().nullable(),
  lastReadyAt: z.string().nullable(),
  retryAttempt: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type PrivateStreamStatus = z.infer<typeof PrivateStreamStatusSchema>;

export const AuthenticatedPortfolioSnapshotSchema = PortfolioSnapshotResponseSchema.extend({
  live: z.object({
    source: z.enum(['cache', 'rest', 'websocket']),
    sequence: z.number().int().nonnegative(),
    lastEventAt: z.string().nullable(),
    lastReconciledAt: z.string().nullable(),
    stream: PrivateStreamStatusSchema,
  }).optional(),
});
export type AuthenticatedPortfolioSnapshot = z.infer<typeof AuthenticatedPortfolioSnapshotSchema>;

const PositiveDecimalTextSchema = z.string().regex(/^\d+(?:\.\d+)?$/);
const SignedDecimalTextSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/);

/** Public fixed-rate opportunity returned by Pendle's Boros strategy API. */
export const BorosStrategyMarketSchema = z.object({
  marketId: z.number().int().positive(),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  tokenId: z.number().int().nonnegative(),
  name: z.string().min(1),
  assetSymbol: z.string().regex(/^[A-Z0-9]+$/),
  maturity: z.number().int().positive(),
  state: z.string().min(1),
  impliedApr: z.number().finite(),
  maxLeverage: z.number().positive(),
  maxPerpLeverage: z.number().positive(),
  ammId: z.number().int().nonnegative(),
  platformName: z.string().min(1),
  /** Enriched by the local backend from Boros market configuration (decimal rate, 1 = 100%). */
  takerFeeRate: z.number().finite().nonnegative().optional(),
  /** Annualized fee charged across periodic settlements (decimal rate, 1 = 100%). */
  settleFeeRate: z.number().finite().nonnegative().optional(),
  /** Boros initial-margin factor (kIM, decimal rate, 1 = 100%). */
  initialMarginFactor: z.number().finite().nonnegative().optional(),
  /** Minimum absolute APR used by Boros for margin calculations. */
  marginRateFloor: z.number().finite().nonnegative().optional(),
  /** Minimum remaining term used by Boros for margin calculations, in seconds. */
  marginTimeFloorSeconds: z.number().int().nonnegative().optional(),
  /** Live remaining term returned by Boros, in seconds. */
  timeToMaturitySeconds: z.number().int().nonnegative().optional(),
});
export type BorosStrategyMarket = z.infer<typeof BorosStrategyMarketSchema>;

export const BorosStrategySchema = z.object({
  id: z.string().min(1),
  longMarket: BorosStrategyMarketSchema,
  shortMarket: BorosStrategyMarketSchema,
  daysToMaturity: z.number().int().positive(),
  impliedAprSpread: z.number().finite(),
  maxPerpLeverage: z.number().positive(),
  aprTimesMaxLeverage: z.number().finite(),
});
export type BorosStrategy = z.infer<typeof BorosStrategySchema>;

export const BorosUpstreamStrategiesResponseSchema = z.object({
  strategies: z.array(BorosStrategySchema),
  totalCount: z.number().int().nonnegative(),
});
export type BorosUpstreamStrategiesResponse = z.infer<typeof BorosUpstreamStrategiesResponseSchema>;

export const BorosMarketFeeConfigSchema = z.object({
  marketId: z.number().int().positive(),
  imData: z.object({
    marginFloor: z.number().finite().nonnegative(),
  }),
  config: z.object({
    takerFee: z.string().regex(/^\d+$/),
    kIM: z.string().regex(/^\d+$/),
    tThresh: z.number().int().nonnegative(),
  }),
  extConfig: z.object({
    settleFeeRate: z.string().regex(/^\d+$/),
  }),
  data: z.object({
    timeToMaturity: z.number().int().nonnegative(),
  }),
});
export type BorosMarketFeeConfig = z.infer<typeof BorosMarketFeeConfigSchema>;

export const BorosUpstreamMarketFeesResponseSchema = z.object({
  results: z.array(BorosMarketFeeConfigSchema),
}).passthrough();
export type BorosUpstreamMarketFeesResponse = z.infer<typeof BorosUpstreamMarketFeesResponseSchema>;

export const BorosStrategiesResponseSchema = BorosUpstreamStrategiesResponseSchema.extend({
  fetchedAt: z.iso.datetime(),
  cacheStatus: z.enum(['fresh', 'stale']),
  source: z.literal('boros_open_api'),
});
export type BorosStrategiesResponse = z.infer<typeof BorosStrategiesResponseSchema>;

export const StrategyConfigSchema = z.object({
  kind: z.enum(['position', 'auto', 'premium', 'carry']),
  asset: z.string(),
  hedgeAsset: z.string().optional(),
  adrRatio: PositiveDecimalTextSchema.optional(),
  /** Cross-asset pairs: LEFT units per ONE right unit (right qty = left qty ÷ ratio). */
  quantityRatio: PositiveDecimalTextSchema.optional(),
  hedgeMode: z.enum(['SHARE_RATIO', 'EQUAL_NOTIONAL']).optional(),
  leftLeverage: PositiveDecimalTextSchema.optional(),
  rightLeverage: PositiveDecimalTextSchema.optional(),
  leftVenue: z.string(),
  rightVenue: z.string(),
  leftSide: z.enum(['BUY', 'SELL']),
  rightSide: z.enum(['BUY', 'SELL']),
  /** Paired funding-arbitrage strategies may use a negative spread as their maximum opening cost. */
  entryBps: SignedDecimalTextSchema.optional(),
  takeProfitBps: PositiveDecimalTextSchema.optional(),
  /** Auto strategies: optional adverse-move stop-loss; a trigger closes both legs and stops. */
  stopLossBps: z.number().gt(0).optional(),
  /**
   * auto: optional laddered add-on step in bps. When set, the strategy adds one clip
   * (= perOrderQuantity) each time the spread advances another `addOnStepBps` beyond
   * `entryBps`, instead of adding a clip on every evaluation while the entry holds.
   * Absent keeps the original tick-driven accumulation, so existing strategies are unaffected.
   */
  addOnStepBps: z.number().gt(0).optional(),
  /** Explicit leg symbols override the venue/asset derivation (required for spot legs). */
  leftSymbol: z.string().regex(/^(?:(?:GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_SPOT_[A-Z0-9]+_(?:USDT|USDC)|(?:GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_[A-Z0-9]+_(?:USDT|USDC|USD))$/).optional(),
  rightSymbol: z.string().regex(/^(?:(?:GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_SPOT_[A-Z0-9]+_(?:USDT|USDC)|(?:GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_[A-Z0-9]+_(?:USDT|USDC|USD))$/).optional(),
  /** carry: funding direction the strategy harvests; the leg sides derive from it. */
  fundingDirection: z.enum(['POSITIVE', 'NEGATIVE']).optional(),
  /** carry: annualized funding percentage gate that must be met before opening (15 = 15% APR). */
  fundingAprMin: z.number().gt(0).lte(1000).optional(),
  /** carry: basis convergence take-profit between the perpetual and the spot leg, in bps. */
  basisTakeProfitBps: z.number().gt(0).lt(10_000).optional(),
  /** carry: leverage preset for the perpetual leg; the engine never adjusts account leverage. */
  contractLeverage: PositiveDecimalTextSchema.optional(),
  /** carry: verify the spot account holds enough quote/inventory before opening. */
  inventoryCheck: z.boolean().optional(),
  entryPremiumPct: SignedDecimalTextSchema.optional(),
  takeProfitPremiumPct: SignedDecimalTextSchema.optional(),
  grid: z.boolean().optional(),
  gridStepPct: PositiveDecimalTextSchema.optional(),
  gridLevels: z.number().int().positive().optional(),
  totalAmount: PositiveDecimalTextSchema.optional(),
  maxPosition: PositiveDecimalTextSchema.optional(),
  perOrderQuantity: PositiveDecimalTextSchema,
  reduceOnly: z.boolean(),
  executionMethod: z.enum(['TAKER_TAKER', 'MAKER_TAKER']),
  makerLeg: z.enum(['left', 'right']).optional(),
  closePlan: z.object({
    // A single slice (1) is a legitimate timed close — it submits the full quantity once.
    // The frontend's split-close UI keeps its own >=2 requirement; the API stays permissive.
    orderCount: z.number().int().min(1).max(100),
    intervalSeconds: z.number().int().min(1).max(86_400),
    targets: z.array(z.object({
      symbol: z.string(),
      side: z.enum(['BUY', 'SELL']),
      quantity: PositiveDecimalTextSchema,
      positionSide: z.enum(['NONE', 'LONG', 'SHORT']),
    })).min(1).max(20),
  }).optional(),
});
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

/** Carry strategy accounting snapshot written by the strategy engine (all amounts in USDT). */
export const StrategyCarryMetricsSchema = z.object({
  fundingCollectedUsdt: z.string(),
  basisEntryBps: z.string(),
  basisCurrentBps: z.string(),
  basisPnlUsdt: z.string(),
  feesPaidUsdt: z.string(),
  netPnlUsdt: z.string(),
  entryFundingApr: z.string(),
  nextFundingAccrualAt: z.string().nullable(),
});
export type StrategyCarryMetrics = z.infer<typeof StrategyCarryMetricsSchema>;

/**
 * Strategy profit and loss, rebuilt from the strategy's own fills so the figure is venue-agnostic
 * and identical for perpetual and spot legs. Average-cost matching over the fills in time order
 * splits them into position-increasing and position-reducing fills, which is what separates the
 * "locked" (already closed) result from the mark-to-market one:
 *
 * - `realizedPnl` — result of the position-reducing fills, before costs.
 * - `unrealizedPnl` — still-open legs marked against the latest stored mark/last price.
 * - `feesPaid` — every fill's fee as a positive cost (Gate's trade feed reports fees unsigned).
 * - `fundingFeeUsdt` — funding charged (positive) or collected (negative).
 * - `netPnl` — `realizedPnl + unrealizedPnl − feesPaid − fundingFeeUsdt`.
 * - `lockedProfitBps` — the already-closed result net of the closing fills' fees and the funding
 *   charge, expressed in basis points of `closedEntryNotionalUsdt`. This is the "how many bps did
 *   this strategy actually keep" figure: it uses the close's own cost basis, not the whole
 *   strategy's, so a strategy that is still adding size cannot inflate it.
 *
 * A `null` always means "the inputs are not available", never zero — the UI shows a dash instead
 * of inventing a number. `unrealizedPnl` is null when an open leg has no stored mark price, and
 * `fundingFeeUsdt` is null when the funding charge cannot be attributed to this strategy alone.
 */
export const StrategyPnlSchema = z.object({
  realizedPnl: z.string(),
  unrealizedPnl: z.string().nullable(),
  feesPaid: z.string(),
  fundingFeeUsdt: z.string().nullable(),
  netPnl: z.string().nullable(),
  closedEntryNotionalUsdt: z.string(),
  entryNotionalUsdt: z.string(),
  lockedProfitBps: z.string().nullable(),
});
export type StrategyPnl = z.infer<typeof StrategyPnlSchema>;

export const StrategyRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(['position', 'auto', 'premium', 'carry']),
  status: z.string(),
  accountProfileId: z.string().nullable(),
  accountLabel: z.string().nullable(),
  config: StrategyConfigSchema,
  progress: z.number(),
  filledQuantity: z.string(),
  filledLeft: z.string(),
  filledRight: z.string(),
  openPosition: z.string(),
  realizedPnl: z.string(),
  /** Net PnL, cost, and the locked-profit bps shown on the strategy rows. Null when unavailable. */
  pnl: StrategyPnlSchema.nullish(),
  carryMetrics: StrategyCarryMetricsSchema.nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stoppedAt: z.string().nullable(),
});
export type StrategyRecord = z.infer<typeof StrategyRecordSchema>;

export const StrategyLogSchema = z.object({
  id: z.string(),
  level: z.string(),
  event: z.string(),
  condition: z.string(),
  quantity: z.string(),
  result: z.string(),
  createdAt: z.string(),
});
export type StrategyLog = z.infer<typeof StrategyLogSchema>;

/** `all` is the unfiltered view; the other four are the display buckets of the execution-log tabs. */
export const STRATEGY_LOG_CATEGORIES = ['all', 'execution', 'risk', 'maker', 'system'] as const;
export type StrategyLogCategory = (typeof STRATEGY_LOG_CATEGORIES)[number];
export type StrategyLogEventCategory = Exclude<StrategyLogCategory, 'all'>;

/**
 * Leg-level diagnostics share one dynamic template — `${Left|Right} leg ${state.toLowerCase()}`
 * (strategy-engine.ts) — whose tail is any order state, including ones the table below never
 * enumerated. Both the SQL fetch set and `classifyStrategyLogEvent` derive their prefix match from
 * this single source so the backend and frontend can never drift apart.
 */
export const STRATEGY_LOG_LEG_EVENT_PREFIXES = ['Left leg ', 'Right leg '] as const;

/**
 * Maps a persisted execution event to its display category. The engine emits a small, fixed set of
 * literal event names, so an exhaustive table beats a regex. The only dynamic shape is the
 * per-leg diagnostic `Left leg <state>` / `Right leg <state>` (see the concrete entries below,
 * which cover every terminal order state Gate reports); `classifyStrategyLogEvent` additionally
 * falls back to a prefix match so a future leg state still lands in `execution`.
 */
export const STRATEGY_LOG_EVENT_CATEGORY: Record<string, StrategyLogEventCategory> = {
  // Open / close: entry, exit, reduce-only and leg-level execution diagnostics.
  'Entry triggered': 'execution',
  'Reduce-only triggered': 'execution',
  'Position open Executed': 'execution',
  'Reduce-only Executed': 'execution',
  'Leg submission failed': 'execution',
  'Closing remaining exposure': 'execution',
  'Residual close submission failed': 'execution',
  'Residual close settled': 'execution',
  'Carry position opened': 'execution',
  'Left leg filled': 'execution',
  'Right leg filled': 'execution',
  'Left leg partially_filled': 'execution',
  'Right leg partially_filled': 'execution',
  'Left leg cancelled': 'execution',
  'Right leg cancelled': 'execution',
  'Left leg rejected': 'execution',
  'Right leg rejected': 'execution',
  'Left leg expired': 'execution',
  'Right leg expired': 'execution',
  // Take-profit & risk.
  'Take-profit triggered': 'risk',
  'Take-profit Executed': 'risk',
  'Take-profit updated': 'risk',
  'Stop-loss triggered': 'risk',
  'Stop-loss exit triggered': 'risk',
  'Stop-loss Executed': 'risk',
  'Basis take-profit triggered': 'risk',
  'Timed close triggered': 'risk',
  'Timed close slice executed': 'risk',
  'Timed close slice failed': 'risk',
  // Maker & hedge.
  'Maker quote placed': 'maker',
  'Maker exit quote placed': 'maker',
  'Maker quote rejected': 'maker',
  'Maker quoting parked': 'maker',
  'Maker quoting resumed': 'maker',
  'Hedging filled quantity': 'maker',
  'Trimming residual imbalance': 'maker',
  'Hedge order settled': 'maker',
  'Residual trim settled': 'maker',
  'Hedge order failed': 'maker',
  'Padding terminal residual': 'maker',
  'Residual padding settled': 'maker',
  'Trimming padded residual': 'maker',
  'Padded residual trim settled': 'maker',
  'Residual top-up unavailable': 'maker',
  'Residual trim deferred': 'maker',
  // Reduce-only exit size reconciliation. All three are emitted from `reconcileExitQuantity`, the
  // single place a reduce-only exit is re-derived from the venue's real position. Both exit paths
  // reach it — the maker exit quote and the taker exit clip (a stop-loss unwind) — so the three
  // stay grouped here to keep every size reconciliation in one place: the exit is re-reported at
  // the venue's reducible size, or withdrawn entirely when the venue holds nothing reducible.
  'Exit size drift': 'maker',
  'Exit size corrected': 'maker',
  'Exit quote withdrawn': 'maker',
  // A maker exit that overruns its budget relaxes the hedge-leg slippage cap; it belongs with the
  // other exit-risk signals so the widened cap stays visible in the risk tab used to audit exits.
  'Maker exit fallback': 'risk',
  // System lifecycle.
  'Strategy started': 'system',
  'Strategy resumed': 'system',
  'Strategy paused': 'system',
  'Strategy stopped': 'system',
  'Strategy completed': 'system',
  'Strategy engine error': 'system',
  'Shutdown cancellation pending': 'system',
  'Strategy pause pending': 'system',
  'Strategy stop pending': 'system',
  // Recovery degradation: a persisted RUNNING strategy whose symbol could not be re-registered
  // with the market hub after restart gets no ticker frames. It is a lifecycle/system signal (not
  // a maker-stage event), so it belongs with `Strategy resumed` in the system tab used to audit
  // recovery.
  'Strategy market unavailable': 'system',
  'Waiting for funding threshold': 'system',
  'Carry entry gate blocked': 'system',
  'Carry entry gate passed': 'system',
  'Funding interval unknown': 'system',
  // A failed venue position read is a degradation signal, not a maker-stage event: the same helper
  // is called from the maker exit path *and* the taker two-leg submission path, so filing it under
  // `maker` would hide a taker strategy's reconciliation failure from the tab that shows taker work.
  'Position reconciliation failed': 'system',
  // v0.4.1 closePlan convergence (R3): the timed close exhausted its retries with an orderable
  // residual still open. A lifecycle outcome of the whole close plan, not one leg's stage.
  'Timed close ended with residual positions': 'system',
};

const strategyLogEventsIn = (category: StrategyLogEventCategory): string[] =>
  Object.keys(STRATEGY_LOG_EVENT_CATEGORY).filter((event) => STRATEGY_LOG_EVENT_CATEGORY[event] === category);

/**
 * Events the backend must select to reproduce a category correctly. Each entry is either an exact
 * event name or, when it ends in `%`, a SQL `LIKE` prefix pattern. Only the leg-level diagnostics
 * use a pattern, because their tail is a dynamic order state the enum can never close over — a
 * fixed `event IN (...)` set would silently drop states such as `fail`, `remote_not_found`, or a
 * transient `open`/`new` returned by a timed-out `awaitTerminalOrder`.
 *
 * The category's own events are the base set; the extras are *dependency* rows the client-side
 * grouping needs, and every category whose clip can contain legs must include the leg prefix:
 * - `execution` also reads `Take-profit triggered` so a grouped exit is labelled `Take-profit
 *   Executed` instead of `Position open Executed`. Its own leg patterns cover the open/close legs.
 * - `risk` also reads every leg pattern (not just the two `filled` names): a take-profit clip whose
 *   leg ended in any failure state is fetched by `execution`, groups into a `Take-profit Executed`
 *   row (risk), and would otherwise vanish from both tabs — no tab could ever show it.
 * Selecting a superset is safe: the client re-filters the grouped rows down to the category.
 */
export const STRATEGY_LOG_CATEGORY_FETCH_EVENTS: Record<StrategyLogEventCategory, string[]> = {
  execution: [...strategyLogEventsIn('execution'), 'Take-profit triggered', 'Stop-loss exit triggered',
    ...STRATEGY_LOG_LEG_EVENT_PREFIXES.map((prefix) => `${prefix}%`)],
  risk: [...strategyLogEventsIn('risk'),
    ...STRATEGY_LOG_LEG_EVENT_PREFIXES.map((prefix) => `${prefix}%`)],
  maker: strategyLogEventsIn('maker'),
  system: strategyLogEventsIn('system'),
};

/** Keyset cursor for paging older execution-log rows: `created_at` plus the row id for tie-breaks. */
export const StrategyLogsCursorSchema = z.object({ createdAt: z.string(), id: z.string() });
export type StrategyLogsCursor = z.infer<typeof StrategyLogsCursorSchema>;

export const MarketSizeUnitsSchema = z.object({
  units: z.record(z.string(), z.string()),
  fetchedAt: z.string(),
});
export type MarketSizeUnits = z.infer<typeof MarketSizeUnitsSchema>;

/**
 * Executable depth of one symbol's maintained book. `bidDepthUsdt` / `askDepthUsdt` are the
 * notional each side currently holds, so a client can size a clip against liquidity instead of
 * against a top-of-book price that says nothing about size. Zero depth with null quotes means the
 * book is not streaming yet.
 */
export const MarketBookDepthSchema = z.object({
  symbol: z.string(),
  bestBid: z.string().nullable(),
  bestAsk: z.string().nullable(),
  bidDepthUsdt: z.number().finite().nonnegative(),
  askDepthUsdt: z.number().finite().nonnegative(),
  updatedAt: z.string().nullable(),
  /**
   * `book` = summed over the maintained order book; `ticker` = one level only (bidPrice×bidSize),
   * used when the venue pushes no book for this instrument. Clients should label the difference
   * rather than present a single level as full depth.
   */
  source: z.enum(['book', 'ticker']).default('book'),
});
export type MarketBookDepth = z.infer<typeof MarketBookDepthSchema>;

export const MarketBookDepthsResponseSchema = z.object({
  books: z.array(MarketBookDepthSchema),
  fetchedAt: z.string(),
});
export type MarketBookDepthsResponse = z.infer<typeof MarketBookDepthsResponseSchema>;

export const TerminalStreamMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('market.snapshot'), payload: MarketSnapshotSchema }),
  z.object({ type: z.literal('market.status'), payload: z.object({
    connectionState: MarketSnapshotSchema.shape.connectionState,
    checkedAt: z.string(),
  }) }),
  z.object({ type: z.literal('market.update'), payload: LiveMarketSchema }),
  z.object({ type: z.literal('market.batch'), payload: z.object({ markets: z.array(LiveMarketSchema) }) }),
  z.object({ type: z.literal('execution.snapshot'), payload: TradingSnapshotSchema }),
  z.object({ type: z.literal('execution.update'), payload: ExecutionOrderSchema }),
  z.object({ type: z.literal('portfolio.snapshot'), payload: AuthenticatedPortfolioSnapshotSchema }),
  z.object({ type: z.literal('portfolio.cleared'), payload: z.null() }),
  z.object({ type: z.literal('private-stream.status'), payload: PrivateStreamStatusSchema }),
  z.object({ type: z.literal('strategy.snapshot'), payload: z.object({ strategies: z.array(StrategyRecordSchema) }) }),
  z.object({ type: z.literal('strategy.update'), payload: StrategyRecordSchema }),
  z.object({ type: z.literal('orderbook.update'), payload: OrderBookSnapshotSchema }),
  z.object({ type: z.literal('trade.snapshot'), payload: z.object({ symbol: z.string(), trades: z.array(PublicTradeSchema) }) }),
  z.object({ type: z.literal('trade.update'), payload: z.object({ symbol: z.string(), trade: PublicTradeSchema }) }),
  z.object({ type: z.literal('trade.batch'), payload: z.object({ symbol: z.string(), trades: z.array(PublicTradeSchema) }) }),
  z.object({ type: z.literal('kline.snapshot'), payload: z.object({
    symbol: z.string(), interval: CandleIntervalSchema, candles: z.array(CandleSchema),
  }) }),
  z.object({ type: z.literal('kline.update'), payload: z.object({
    symbol: z.string(), interval: CandleIntervalSchema, candle: CandleSchema,
  }) }),
  z.object({ type: z.literal('balance.update'), payload: LiveBalanceSchema }),
  z.object({ type: z.literal('mode.update'), payload: z.object({ mode: TradingModeSchema }) }),
]);
export type TerminalStreamMessage = z.infer<typeof TerminalStreamMessageSchema>;

export const StrategiesResponseSchema = z.object({ strategies: z.array(StrategyRecordSchema) });
export const StrategyLogsResponseSchema = z.object({
  logs: z.array(StrategyLogSchema),
  /** New optional keys: older clients keep working, and a full first page stays byte-compatible. */
  hasMore: z.boolean().optional(),
  nextCursor: StrategyLogsCursorSchema.nullable().optional(),
  /**
   * Total rows stored for the requested category (for `all`, every row), independent of the cursor.
   * The tab labels use it so an operator can tell "this category has 22 rows but none in the newest
   * page" apart from "this category has never fired" — the two look identical without it.
   */
  categoryTotal: z.number().int().nonnegative().optional(),
});
export const InstrumentsResponseSchema = z.object({ items: z.array(CrossExInstrumentSchema) });
export const LeverageResponseSchema = z.object({ symbol: z.string(), leverage: z.string().nullable() });
export const LeverageUpdateResponseSchema = z.object({ symbol: z.string(), leverage: z.string() });

// Strict so a renamed or unknown settings key fails loudly instead of silently writing a row
// no reader will ever look at. Every key is optional: clients send only what changed.
export const UserPreferencesSchema = z.strictObject({
  language: z.enum(['en', 'zh']),
  theme: z.enum(['dark', 'light']),
  favorites: z.array(z.string().min(1).max(120)).max(500),
  notificationsSeenAt: z.iso.datetime(),
  lastAsset: z.string().regex(/^[A-Z0-9]{1,30}$/),
  /** Show the order-confirmation dialog before submitting a ticket; on unless the user opted out. */
  confirmOrders: z.boolean(),
}).partial();
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

export const UserPreferencesResponseSchema = z.object({ preferences: UserPreferencesSchema });
export type UserPreferencesResponse = z.infer<typeof UserPreferencesResponseSchema>;
