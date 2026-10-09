import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/backend/dist/app.js';
import { loadConfig } from '../apps/backend/dist/config.js';
import { MemoryCredentialVault } from '../apps/backend/dist/credential-vault.js';
import { openDatabase, prepareDatabaseForClose } from '../apps/backend/dist/database.js';
import { CrossExMarketHub } from '../apps/backend/dist/market-hub.js';
import { TradingSession } from '../apps/backend/dist/trading-session.js';

const PORT = 17_942;
const assets = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'SUI', 'PEPE', 'AAVE', 'LINK', 'ARB', 'HYPE'];
const venues = ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT', 'LIGHTER'];
const dataDir = mkdtempSync(join(tmpdir(), 'gate-crossex-e2e-'));
const config = loadConfig({
  ...process.env,
  GCT_PORT: String(PORT),
  GCT_FRONTEND_PORT: String(PORT),
  GCT_DATA_DIR: dataDir,
  GCT_CREDENTIAL_ENV_PATH: join(dataDir, 'credentials.env'),
  // Deterministic operator credentials: the workspace is behind the cloud sign-in gate, so every
  // spec authenticates through POST /api/auth/login before touching the UI.
  GCT_AUTH_USERNAME: 'e2e-operator',
  GCT_AUTH_PASSWORD: 'e2e-operator-password-1',
  GCT_GATE_PUBLIC_WS_URL: 'ws://127.0.0.1:9',
  GCT_GATE_PRIVATE_WS_URL: 'ws://127.0.0.1:9',
  GCT_GATE_REST_URL: 'http://127.0.0.1:9',
});

const quoteFor = (venue) => venue === 'KRAKEN' ? 'USD' : venue === 'HYPERLIQUID' || venue === 'DERIBIT' || venue === 'LIGHTER' ? 'USDC' : 'USDT';
const crossExLeverageMaxFor = (symbol) => symbol === 'GATE_FUTURE_BTC_USDT' ? '25'
  : symbol.startsWith('OKX_FUTURE_') ? '50'
    : symbol.startsWith('HYPERLIQUID_FUTURE_') ? '40'
      : '20';
const symbols = assets.flatMap((asset) => venues.map((venue) => ({
  symbol: `${venue}_FUTURE_${asset}_${quoteFor(venue)}`,
  exchange_type: venue,
  business_type: 'FUTURE',
  state: 'live',
  min_size: '0.001',
  min_notional: '5',
  lot_size: '0.001',
  tick_size: '0.1',
  max_num_orders: '100',
  max_market_size: '100',
  max_limit_size: '1000',
  contract_size: venue === 'GATE' ? '0.0001' : null,
  liquidation_fee: '0.0125',
  default_leverage: '5',
  delist_time: '0',
})));

const crossExGateway = {
  async querySymbols() {
    return symbols;
  },
  async queryRiskLimits(requestedSymbols) {
    return requestedSymbols.map((symbol) => ({
      symbol,
      tiers: [{
        min_risk_limit_value: '0',
        max_risk_limit_value: '3000000',
        quick_cal_amount: '0',
        leverage_max: crossExLeverageMaxFor(symbol),
        maintenance_rate: '0.0065',
        tier: '1',
      }],
    }));
  },
  async queryAccount() {
    throw new Error('E2E credentials are intentionally unavailable');
  },
  async queryPositions() {
    return [];
  },
  async queryPortfolio() {
    throw new Error('E2E credentials are intentionally unavailable');
  },
  async createOrder() {
    throw new Error('E2E trading is disabled');
  },
  async cancelOrder() {
    throw new Error('E2E trading is disabled');
  },
  async queryOrder() {
    throw new Error('E2E trading is disabled');
  },
  async queryLeverages(_credentials, requestedSymbols) {
    return Object.fromEntries(requestedSymbols.map((symbol) => [symbol, '5']));
  },
  async setLeverage(_credentials, symbol, leverage) {
    return { symbol, leverage };
  },
  async queryFeeRates() {
    return [];
  },
};

const publicMarketGateway = {
  async querySnapshot(symbol) {
    const venue = symbol.split('_')[0] ?? 'GATE';
    return {
      symbol,
      venue,
      product: 'FUTURE',
      bidPrice: '63999.9',
      askPrice: '64000.1',
      lastPrice: '64000',
      markPrice: '64000',
      indexPrice: '64000',
      fundingRate: '0.0001',
      predictedFundingRate: null,
      nextFundingAt: '2030-01-01T08:00:00.000Z',
      sourceTimestamp: '2030-01-01T00:00:00.000Z',
      fetchedAt: '2030-01-01T00:00:00.000Z',
      source: venue === 'OKX' ? 'okx_public_rest' : venue === 'BINANCE' ? 'binance_futures_public_rest' : 'gate_futures_public_rest',
    };
  },
  async queryCandles(_symbol, interval, limit, before) {
    const intervalMs = interval === '1m' ? 60_000 : interval === '5m' ? 300_000 : 3_600_000;
    const end = before ?? Date.parse('2030-01-01T00:00:00.000Z');
    return Array.from({ length: Math.min(limit, 120) }, (_, index) => {
      const startTime = end - ((Math.min(limit, 120) - index) * intervalMs);
      const offset = (index % 12) - 6;
      return {
        startTime,
        open: String(64_000 + offset),
        high: String(64_010 + offset),
        low: String(63_990 + offset),
        close: String(64_004 + offset),
        volume: String(200 + index),
        closed: true,
      };
    });
  },
  async queryContractSizes(venue) {
    return venue === 'GATE'
      ? [{ base: 'BTC', quote: 'USDT', multiplier: '0.0001' }]
      : [{ base: 'BTC', quote: 'USDT', multiplier: '0.01' }];
  },
  async queryVenueFundingStats(venue) {
    if (venue === 'GATE' || venue === 'BINANCE') return [{
      venue,
      base: 'BTC',
      quote: 'USDT',
      fundingRate: venue === 'GATE' ? '0.00001625' : '0.0001',
      fundingIntervalHours: venue === 'GATE' ? 1 : 8,
      fundingRate8h: venue === 'GATE' ? '0.00013' : '0.0001',
      nextFundingAt: '2030-01-01T08:00:00.000Z',
      openInterestValue: venue === 'GATE' ? '2500000' : '2200000',
      lastPrice: venue === 'GATE' ? '64000' : '64010',
      change24h: venue === 'GATE' ? '0.0125' : '-0.01',
    }];
    if (venue === 'HYPERLIQUID' || venue === 'BYBIT') return [{
      venue,
      base: 'HYPE',
      quote: venue === 'HYPERLIQUID' ? 'USDC' : 'USDT',
      fundingRate: venue === 'HYPERLIQUID' ? '0.000025' : '-0.0001',
      fundingIntervalHours: venue === 'HYPERLIQUID' ? 1 : 8,
      fundingRate8h: venue === 'HYPERLIQUID' ? '0.0002' : '-0.0001',
      nextFundingAt: '2030-01-01T08:00:00.000Z',
      openInterestValue: venue === 'HYPERLIQUID' ? '15000000' : '12000000',
      lastPrice: venue === 'HYPERLIQUID' ? '36.55' : '36.50',
      change24h: venue === 'HYPERLIQUID' ? '0.015' : '0.014',
    }];
    return [];
  },
  async queryFundingHistory() {
    const now = Date.now();
    return [
      { timestamp: now - 16 * 60 * 60 * 1_000, rate: '0.0001' },
      { timestamp: now - 8 * 60 * 60 * 1_000, rate: '0.00012' },
    ];
  },
};

const borosStrategyFetcher = async () => ({
  strategies: [{
    id: 'ETH-2-1790294400-OKX-Hyperliquid',
    longMarket: {
      marketId: 185, address: '0x6bb121533f78d8d0c8a847b0ab399e0399966563', tokenId: 2,
      name: 'ETHUSDT', assetSymbol: 'ETH', maturity: 1790294400, state: 'Normal', impliedApr: 0.0225,
      maxLeverage: 2.1, maxPerpLeverage: 100, ammId: 0, platformName: 'OKX',
    },
    shortMarket: {
      marketId: 102, address: '0xd035309b604d6e252d29ce1d61e9a1e0a0553918', tokenId: 2,
      name: 'ETHUSDC', assetSymbol: 'ETH', maturity: 1790294400, state: 'Normal', impliedApr: 0.0628,
      maxLeverage: 2.1, maxPerpLeverage: 25, ammId: 1020, platformName: 'Hyperliquid',
    },
    daysToMaturity: 50, impliedAprSpread: 0.0403, maxPerpLeverage: 10, aprTimesMaxLeverage: 0.1487,
  }, {
    id: 'ETH-2-1790294400-OKX-Kucoin',
    longMarket: {
      marketId: 185, address: '0x6bb121533f78d8d0c8a847b0ab399e0399966563', tokenId: 2,
      name: 'ETHUSDT', assetSymbol: 'ETH', maturity: 1790294400, state: 'Normal', impliedApr: 0.0225,
      maxLeverage: 2.1, maxPerpLeverage: 100, ammId: 0, platformName: 'OKX',
    },
    shortMarket: {
      marketId: 187, address: '0x1b435f61e9ce290c78659ae3e95d7ef9d0195255', tokenId: 2,
      name: 'ETHUSDC', assetSymbol: 'ETH', maturity: 1790294400, state: 'Normal', impliedApr: 0.0673,
      maxLeverage: 2.1, maxPerpLeverage: 50, ammId: 0, platformName: 'Kucoin',
    },
    daysToMaturity: 50, impliedAprSpread: 0.0448, maxPerpLeverage: 10, aprTimesMaxLeverage: 0.1649,
  }],
  totalCount: 2,
});

const borosMarketFeeFetcher = async (marketIds) => ({
  results: marketIds.map((marketId) => ({
    marketId,
    imData: { marginFloor: marketId === 187 ? 0.08 : 0.06 },
    config: { takerFee: '500000000000000', kIM: '476190476190476190', tThresh: 864000 },
    extConfig: { settleFeeRate: '1000000000000000' },
    data: { timeToMaturity: 4_320_000 },
  })),
});

const database = openDatabase(config.databasePath, config.migrationsDir);
const tradingSession = new TradingSession();
const marketHub = new CrossExMarketHub(config.gatePublicWebSocketUrl);
const insertPosition = database.prepare(`INSERT INTO live_positions
  (position_id, symbol, venue, quantity, entry_price, mark_price, realized_pnl, funding_fee, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const app = await buildApp({
  config,
  database,
  credentialVault: new MemoryCredentialVault(),
  crossExGateway,
  publicMarketGateway,
  marketHub,
  tradingSession,
  startMarketStream: false,
  logger: false,
  rateLimitMax: 10_000,
  borosStrategyFetcher,
  borosMarketFeeFetcher,
});

app.post('/__e2e/trading-mode', async (request) => {
  const mode = request.body?.mode === 'live' ? 'live' : 'readonly';
  tradingSession.set(mode);
  return { mode };
});

app.post('/__e2e/fresh-quotes', async () => {
  const timestamp = Date.now();
  const quotes = [
    { symbol: 'OKX_FUTURE_ETH_USDT', bid: '3861.9', ask: '3862.1' },
    { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', bid: '3862.4', ask: '3862.6' },
  ];
  for (const quote of quotes) {
    // TypeScript's `private` modifier is compile-time only. Exercising the compiled parser here
    // keeps this E2E fixture on the same publish path as a real CrossEx websocket ticker.
    // The second argument mirrors the socket-layer receipt timestamp the hub stamps as
    // `receivedAt` for ticker delivery-health checks.
    marketHub.handleMessage(JSON.stringify({
      channel: 'ticker',
      event: 'update',
      result: {
        s: quote.symbol,
        lp: quote.ask,
        bp: quote.bid,
        bs: '10',
        ap: quote.ask,
        as: '10',
        o: quote.bid,
        h: quote.ask,
        l: quote.bid,
        v: '1000',
        q: '3862000',
        ts: timestamp,
      },
    }), timestamp);
  }
  return { ok: true };
});

app.post('/__e2e/grouped-positions', async () => {
  database.prepare('DELETE FROM live_positions').run();
  insertPosition.run(
    'e2e-hype-hyperliquid', 'HYPERLIQUID_FUTURE_HYPE_USDC', 'HYPERLIQUID', '100',
    '51.80', '51.82', '0', '1.25', '2030-01-01T00:00:00.000Z',
  );
  insertPosition.run(
    'e2e-hype-bybit', 'BYBIT_FUTURE_HYPE_USDT', 'BYBIT', '-100',
    '51.84', '51.82', '0', '-0.25', '2030-01-01T00:00:00.000Z',
  );
  return { ok: true };
});

app.delete('/__e2e/grouped-positions', async () => {
  database.prepare('DELETE FROM live_positions').run();
  return { ok: true };
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  prepareDatabaseForClose(database);
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await app.listen({ host: config.host, port: config.port });
