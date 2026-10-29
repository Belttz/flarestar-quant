import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { DEFAULT_CREDENTIAL_PROFILE, MemoryCredentialVault, type GateCredentials } from './credential-vault.js';
import { GateApiError, type CrossExOrderRequest, type GateCrossExAccount, type GateCrossExOrder, type GateCrossExPortfolio, type GateCrossExRiskLimit, type GateCrossExSymbol, type GateFeeRate, type GateOrderActionResponse, type GateSpotAccount, type TradingCrossExGateway } from './crossex-client.js';
import type { LiveMarket } from './market-hub.js';
import { StrategyEngine, type MarketSource, type StrategyEngineOptions } from './strategy-engine.js';
import { TradingRuntime } from './trading-runtime.js';
import { TradingSession } from './trading-session.js';

class ScriptedGateway implements TradingCrossExGateway {
  readonly createdOrders: Array<CrossExOrderRequest & { remoteId: string }> = [];
  readonly createAttempts: CrossExOrderRequest[] = [];
  readonly cancelledOrders: string[] = [];
  readonly leverageUpdates: Array<{ symbol: string; leverage: string }> = [];
  readonly leverageQueries: string[][] = [];
  readonly accountQueries: Array<string | null> = [];
  positions: GateCrossExPortfolio['positions'] = [];
  leverages: Record<string, string> = {};
  riskLimits: Record<string, GateCrossExRiskLimit['tiers']> = {};
  availableMargin = '1000000';
  accountAssets: GateCrossExAccount['assets'] = [];
  accountMode: 'CROSS_EXCHANGE' | 'ISOLATED_EXCHANGE' = 'CROSS_EXCHANGE';
  isolatedAvailableMargins: Record<string, string> = {};
  spotAccounts: GateSpotAccount[] = [];
  holdCancellations = false;
  /**
   * Label carried by scripted create-order failures. Existing suites depend on the insufficient
   * margin label (five strikes → pause on margin), so scenarios that need a different rejection
   * — notably TRADE_REDUCE_ONLY_POSITION_QTY_ERROR — override it explicitly.
   */
  createFailLabel = 'TRADE_INSUFFICIENT_AVAILABLE_MARGIN_ERROR';
  /** When set, `queryPositions` rejects with this Gate API label. */
  failPositionsLabel: string | null = null;
  /** Number of `queryPositions` calls, so a test can prove a rejection triggered a reconciliation. */
  positionQueries = 0;
  private readonly failCreateBudget = new Map<string, number>();
  private readonly remoteStates = new Map<string, string>();
  private sequence = 0;

  failCreate(symbol: string, times: number): void {
    this.failCreateBudget.set(symbol, (this.failCreateBudget.get(symbol) ?? 0) + times);
  }

  async queryAccount(_credentials: GateCredentials, exchangeType?: string): Promise<GateCrossExAccount> {
    this.accountQueries.push(exchangeType ?? null);
    if (this.accountMode === 'ISOLATED_EXCHANGE' && exchangeType === undefined) {
      throw new GateApiError(400, 'MISSING_REQUIRED_PARAM');
    }
    const normalizedExchange = exchangeType?.toUpperCase() ?? 'CROSSEX';
    const availableMargin = this.accountMode === 'ISOLATED_EXCHANGE'
      ? this.isolatedAvailableMargins[normalizedExchange] ?? '0'
      : this.availableMargin;
    return {
      available_margin: availableMargin, margin_balance: availableMargin, initial_margin: '0',
      maintenance_margin: '0', initial_margin_rate: '0', maintenance_margin_rate: '0',
      position_mode: 'SINGLE', account_mode: this.accountMode, exchange_type: normalizedExchange,
      update_time: String(Date.now()), assets: this.accountAssets,
    };
  }
  async queryPositions(): Promise<GateCrossExPortfolio['positions']> {
    this.positionQueries += 1;
    if (this.failPositionsLabel) throw new GateApiError(500, this.failPositionsLabel);
    return this.positions;
  }
  async querySpotAccounts(): Promise<GateSpotAccount[]> {
    return this.spotAccounts;
  }
  async queryPortfolio(): Promise<GateCrossExPortfolio> { throw new GateApiError(0, 'NOT_SCRIPTED'); }
  async querySymbols(): Promise<GateCrossExSymbol[]> { return []; }
  async queryRiskLimits(symbols: string[]): Promise<GateCrossExRiskLimit[]> {
    return symbols.map((symbol) => ({
      symbol,
      tiers: this.riskLimits[symbol] ?? [{
        tier: '1', min_risk_limit_value: '0', max_risk_limit_value: '1000000000',
        quick_cal_amount: '0', leverage_max: '200', maintenance_rate: '0.001',
      }],
    }));
  }
  async queryLeverages(_credentials: GateCredentials, symbols: string[]): Promise<Record<string, string>> {
    this.leverageQueries.push([...symbols]);
    return Object.fromEntries(symbols.flatMap((symbol) => (
      this.leverages[symbol] === undefined ? [] : [[symbol, this.leverages[symbol]]]
    )));
  }
  async setLeverage(_credentials: GateCredentials, symbol: string, leverage: string): Promise<{ symbol: string; leverage: string }> {
    this.leverageUpdates.push({ symbol, leverage });
    this.leverages[symbol] = leverage;
    return { symbol, leverage };
  }
  async queryFeeRates(): Promise<GateFeeRate[]> { return []; }
  async queryOrder(_credentials: GateCredentials, orderId: string): Promise<GateCrossExOrder> {
    const created = this.createdOrders.find((order) => order.remoteId === orderId);
    if (!created) throw new GateApiError(404, 'ORDER_NOT_FOUND');
    const state = this.remoteStates.get(orderId) ?? 'OPEN';
    return {
      order_id: orderId,
      text: created.text ?? '',
      symbol: created.symbol,
      side: created.side,
      type: created.type,
      attribute: created.time_in_force === 'POC' ? 'POST_ONLY' : 'NORMAL',
      exchange_type: created.symbol.split('_')[0] ?? 'GATE',
      business_type: 'FUTURE',
      qty: created.qty ?? '0',
      quote_qty: '0',
      price: created.price ?? '0',
      time_in_force: created.time_in_force,
      state,
      executed_qty: '0',
      executed_amount: '0',
      executed_avg_price: '0',
      fee_coin: 'USDT',
      fee: '0',
      reduce_only: String(created.reduce_only),
      leverage: '0',
      reason: '',
      last_executed_qty: '0',
      last_executed_price: '0',
      last_executed_amount: '0',
      position_side: 'NONE',
      create_time: String(Date.now()),
      update_time: String(Date.now()),
    };
  }

  async createOrder(_credentials: GateCredentials, order: CrossExOrderRequest): Promise<GateOrderActionResponse> {
    this.createAttempts.push({ ...order });
    const budget = order.symbol ? this.failCreateBudget.get(order.symbol) ?? 0 : 0;
    if (order.symbol && budget > 0) {
      this.failCreateBudget.set(order.symbol, budget - 1);
      throw new GateApiError(400, this.createFailLabel);
    }
    this.sequence += 1;
    const remoteId = `remote-${this.sequence}`;
    this.createdOrders.push({ ...order, remoteId });
    this.remoteStates.set(remoteId, 'OPEN');
    return { order_id: remoteId, text: order.text ?? '' };
  }

  async cancelOrder(_credentials: GateCredentials, orderId: string): Promise<GateOrderActionResponse> {
    this.cancelledOrders.push(orderId);
    if (!this.holdCancellations) this.remoteStates.set(orderId, 'CANCELLED');
    return { order_id: orderId, text: '' };
  }
}

function futuresPosition(
  symbol: string,
  side: 'LONG' | 'SHORT',
  quantity: string,
): GateCrossExPortfolio['positions'][number] {
  return {
    position_id: `position-${symbol}`,
    symbol,
    position_side: side,
    initial_margin: '0',
    maintenance_margin: '0',
    position_qty: quantity,
    position_value: '0',
    upnl: '0',
    upnl_rate: '0',
    entry_price: '0',
    mark_price: '0',
    leverage: '5',
    max_leverage: '20',
    risk_limit: '0',
    fee: '0',
    funding_fee: '0',
    funding_time: '0',
    create_time: '0',
    update_time: '0',
    closed_pnl: '0',
  };
}

class StubMarkets implements MarketSource {
  private readonly markets = new Map<string, LiveMarket>();
  private state: ReturnType<NonNullable<MarketSource['connectionState']>> = 'healthy';

  constructor(private readonly database: Database.Database) {}

  set(
    symbol: string,
    bid: string,
    ask: string,
    updatedAt = new Date().toISOString(),
    receivedAt = updatedAt,
    fundingRate = '0.0001',
    nextFundingAt = new Date(Date.now() + 3_600_000).toISOString(),
    quoteUpdatedAt = updatedAt,
  ): void {
    const [venue = 'GATE', , asset = 'BTC'] = symbol.split('_');
    this.markets.set(symbol, {
      symbol, venue: venue as LiveMarket['venue'], asset, lastPrice: bid, bidPrice: bid, bidSize: '10',
      askPrice: ask, askSize: '10', open24h: bid, high24h: ask, low24h: bid, volume24h: '100',
      quoteVolume24h: '100000', fundingRate, nextFundingAt,
      openInterest: '1000', openInterestValue: '1000000', receivedAt, updatedAt,
      quoteUpdatedAt, source: 'gate_crossex_websocket',
    });
    this.database.prepare(`INSERT OR IGNORE INTO crossex_instruments (
      symbol, exchange_type, business_type, state, min_size, min_notional, lot_size,
      tick_size, max_num_orders, max_market_size, max_limit_size, contract_size,
      liquidation_fee, default_leverage, delist_time, fetched_at
    ) VALUES (?, ?, 'FUTURE', 'live', '0.00000001', NULL, '0.00000001', '0.01', '100', NULL, NULL, NULL, NULL, '1', '0', ?)`)
      .run(symbol, venue, new Date().toISOString());
  }

  market(symbol: string): LiveMarket | null { return this.markets.get(symbol) ?? null; }
  /** Test hook simulating the market hub sweeping a registered symbol. */
  remove(symbol: string): void { this.markets.delete(symbol); }
  /** Test hook simulating the market hub's dynamic registration of an unknown symbol. */
  ensureHandler: ((symbol: string) => boolean) | null = null;
  ensureMarket(symbol: string): boolean { return this.ensureHandler ? this.ensureHandler(symbol) : false; }
  /** Symbols passed to each watchQuotes call, in order. */
  readonly watchQuotesCalls: string[][] = [];
  /** How many watchQuotes releases completed (idempotent, so release-once counts once). */
  quoteWatchReleases = 0;
  /** Test hook invoked on each subscription, e.g. to deliver the first live ticker frames. */
  onWatchQuotes: ((symbols: string[]) => void) | null = null;
  watchQuotes(symbols: string[]): () => void {
    const watched = [...symbols];
    this.watchQuotesCalls.push(watched);
    this.onWatchQuotes?.(watched);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.quoteWatchReleases += 1;
    };
  }
  connectionState(): ReturnType<NonNullable<MarketSource['connectionState']>> { return this.state; }
  setConnectionState(state: ReturnType<NonNullable<MarketSource['connectionState']>>): void { this.state = state; }
}

interface Harness {
  database: Database.Database;
  runtime: TradingRuntime;
  engine: StrategyEngine;
  gateway: ScriptedGateway;
  markets: StubMarkets;
  directory: string;
}

const harnesses: Harness[] = [];

async function createHarness(engineOptions: StrategyEngineOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-engine-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
  });
  const session = new TradingSession();
  session.set('live');
  const database = openDatabase(config.databasePath, config.migrationsDir);
  const vault = new MemoryCredentialVault();
  await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'engine-key', apiSecret: 'engine-secret' });
  const gateway = new ScriptedGateway();
  const runtime = new TradingRuntime(database, session, vault, gateway);
  const markets = new StubMarkets(database);
  const engine = new StrategyEngine(database, session, runtime, markets, {
    tickIntervalMs: 20, orderTimeoutMs: 400, requoteIntervalMs: 10, repairCooldownMs: 0,
    ...engineOptions,
  });
  const harness = { database, runtime, engine, gateway, markets, directory };
  harnesses.push(harness);
  return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

function ackOrder(
  runtime: TradingRuntime,
  remoteId: string,
  state: string,
  executedQty: string,
  avgPrice: string,
  reason?: string,
): void {
  runtime.ingestPrivateEvent({ channel: 'order', payload: {
    order_id: remoteId, state, executed_qty: executedQty, executed_avg_price: avgPrice,
    ...(reason ? { reason } : {}), update_time: String(Date.now()),
  } });
}

function ingestFill(runtime: TradingRuntime, remoteId: string, symbol: string, side: 'BUY' | 'SELL', qty: string, price: string, realizedPnl = '0'): void {
  runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
    transaction_id: `txn-${remoteId}-${qty}-${Math.random().toString(36).slice(2, 8)}`, order_id: remoteId,
    symbol, exchange_type: symbol.split('_')[0] ?? 'GATE', side, qty, price, fee: '0.01', rpnl: realizedPnl,
    match_role: 'TAKER', create_time: String(Date.now()),
  } });
}

function seedFilledStrategyOrder(
  database: Database.Database,
  strategyId: string,
  id: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  quantity: string,
  leg: 'left' | 'right',
): void {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO execution_orders (
    id, client_order_id, environment, symbol, venue, side, order_type, time_in_force,
    quantity, price, reduce_only, state, executed_quantity, executed_average_price,
    created_at, updated_at, strategy_id, strategy_leg
  ) VALUES (?, ?, 'live', ?, ?, ?, 'MARKET', 'IOC', ?, NULL, 0, 'FILLED', ?, '54', ?, ?, ?, ?)`)
    .run(id, `${id}-client`, symbol, symbol.split('_')[0], side, quantity, quantity, now, now, strategyId, leg);
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.engine.stop();
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

const takerTakerConfig = {
  kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
  entryBps: '10', totalAmount: '0.2', perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
} as const;

describe('strategy engine', () => {
  it('closes a position in the requested number of timed reduce-only slices', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, markets } = await createHarness({ now: () => now });
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    markets.set(symbol, '100000', '100001', new Date(now).toISOString());
    gateway.positions = [futuresPosition(symbol, 'LONG', '0.1')];

    const record = await engine.startStrategy({
      kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'BINANCE',
      leftSide: 'SELL', rightSide: 'BUY', totalAmount: '0.1', perOrderQuantity: '0.03',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
      closePlan: {
        orderCount: 3,
        intervalSeconds: 5,
        targets: [{ symbol, side: 'SELL', quantity: '0.1', positionSide: 'NONE' }],
      },
    });
    expect(record).toMatchObject({ status: 'RUNNING', kind: 'position', config: { closePlan: { orderCount: 3, intervalSeconds: 5 } } });

    // Strategy timestamps use the wall clock. Anchor the injected clock after creation so slower
    // runners cannot leave the first close slice scheduled in the future.
    now = Date.parse(record.createdAt) + 100;
    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({ symbol, side: 'SELL', qty: '0.03333333', reduce_only: 'true' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.03333333', '100000');
    await firstTick;

    now += 4_999;
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(1);

    now += 1;
    const secondTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]?.qty).toBe('0.03333333');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.03333333', '100000');
    await secondTick;

    now += 5_000;
    const finalTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]?.qty).toBe('0.03333334');
    ackOrder(runtime, 'remote-3', 'FILLED', '0.03333334', '100000');
    await finalTick;

    expect(runtime.getStrategy(record.id)).toMatchObject({ status: 'COMPLETED', progress: 100, filledQuantity: '3' });
    expect(runtime.listOrders().filter((order) => order.strategyId === record.id).every((order) => order.reduceOnly)).toBe(true);
  });

  it('submits every Close all target together in each timed slice', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, markets } = await createHarness({ now: () => now });
    const longSymbol = 'BINANCE_FUTURE_BTC_USDT';
    const shortSymbol = 'OKX_FUTURE_BTC_USDT';
    markets.set(longSymbol, '100000', '100001', new Date(now).toISOString());
    markets.set(shortSymbol, '99999', '100000', new Date(now).toISOString());
    gateway.positions = [futuresPosition(longSymbol, 'LONG', '0.1'), futuresPosition(shortSymbol, 'SHORT', '0.2')];
    const record = await engine.startStrategy({
      kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
      leftSide: 'SELL', rightSide: 'BUY', totalAmount: '0.1', perOrderQuantity: '0.1',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
      closePlan: {
        orderCount: 2,
        intervalSeconds: 3,
        targets: [
          { symbol: longSymbol, side: 'SELL', quantity: '0.1', positionSide: 'NONE' },
          { symbol: shortSymbol, side: 'BUY', quantity: '0.2', positionSide: 'NONE' },
        ],
      },
    });

    now = Date.parse(record.createdAt) + 100;
    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: longSymbol, side: 'SELL', qty: '0.05', reduce_only: 'true' }),
      expect.objectContaining({ symbol: shortSymbol, side: 'BUY', qty: '0.1', reduce_only: 'true' }),
    ]));
    ackOrder(runtime, 'remote-1', 'FILLED', '0.05', '100000');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await firstTick;

    now += 3_000;
    const secondTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.05', '100000');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await secondTick;

    expect(runtime.getStrategy(record.id)).toMatchObject({ status: 'COMPLETED', progress: 100 });
    expect(new Set(runtime.listOrders().filter((order) => order.strategyId === record.id).map((order) => order.strategyClip)))
      .toEqual(new Set(['close-0', 'close-1']));
  });

  it('routes the canonical SKHYNIX asset through Hyperliquid native SKHX', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1081', '1082');
    markets.set('HYPERLIQUID_FUTURE_SKHX_USDC', '1080', '1081');

    const record = await engine.startStrategy({
      ...takerTakerConfig,
      asset: 'SKHYNIX',
      leftVenue: 'GATE',
      rightVenue: 'HYPERLIQUID',
      entryBps: '1000',
    });

    expect(record.status).toBe('RUNNING');
    expect(gateway.leverageQueries.flat()).toContain('HYPERLIQUID_FUTURE_SKHX_USDC');
    expect(gateway.leverageQueries.flat()).not.toContain('HYPERLIQUID_FUTURE_SKHYNIX_USDC');
  });

  it('refuses to start strategies while live trading is locked', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-engine-locked-'));
    const config = loadConfig({ GCT_DATA_DIR: directory, GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations') });
    const database = openDatabase(config.databasePath, config.migrationsDir);
    const vault = new MemoryCredentialVault();
    const gateway = new ScriptedGateway();
    // A freshly constructed session is 'unset': the boot state before anyone accepts the disclaimer.
    const lockedSession = new TradingSession();
    const runtime = new TradingRuntime(database, lockedSession, vault, gateway);
    const markets = new StubMarkets(database);
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
    const engine = new StrategyEngine(database, lockedSession, runtime, markets);
    await expect(engine.startStrategy(takerTakerConfig)).rejects.toMatchObject({ code: 'live_trading_locked' });
    await engine.stop();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects auto strategies whose take profit is not below entry', async () => {
    const { engine, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
    await expect(engine.startStrategy({
      ...takerTakerConfig, kind: 'auto', maxPosition: '0.2', takeProfitBps: '10',
    })).rejects.toMatchObject({ code: 'take_profit_must_be_below_entry' });
  });

  it('rejects a strategy when a per-order clip is below a selected exchange minimum', async () => {
    const { engine, database, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.2', lot_size = '0.1' WHERE symbol = 'OKX_FUTURE_BTC_USDT'").run();

    await expect(engine.startStrategy(takerTakerConfig)).rejects.toMatchObject({
      code: 'strategy_order_below_minimum_size',
      label: 'OKX_FUTURE_BTC_USDT: 0.1 < 0.2',
    });
  });

  it('rejects a final target remainder that would create an undersized order', async () => {
    const { engine, database, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.1', lot_size = '0.1' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();

    await expect(engine.startStrategy({ ...takerTakerConfig, totalAmount: '0.15' })).rejects.toMatchObject({
      code: 'strategy_order_below_minimum_size',
    });
  });

  it('rejects a configured clip below the instrument minimum notional', async () => {
    const { engine, database, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3');
    markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();

    await expect(engine.startStrategy({
      ...takerTakerConfig, totalAmount: '0.09', perOrderQuantity: '0.09',
    })).rejects.toMatchObject({
      code: 'strategy_order_below_minimum_notional', statusCode: 400,
    });
  });

  it('suggests the executable minimum quantity when a clip is below the minimum notional', async () => {
    const { engine, database, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '0.3121', '0.3123');
    markets.set('OKX_FUTURE_BTC_USDT', '0.3120', '0.3122');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();

    await expect(engine.startStrategy({
      ...takerTakerConfig, totalAmount: '1', perOrderQuantity: '1',
    })).rejects.toMatchObject({
      code: 'strategy_order_below_minimum_notional',
      statusCode: 400,
      label: 'BINANCE_FUTURE_BTC_USDT: 0.3121 < 5, min qty ~16.03 @ price 0.3121',
    });
  });

  it('waits for the first live quote of dynamically ensured markets before launching', async () => {
    const { engine, markets } = await createHarness({ marketDataWaitTimeoutMs: 5_000 });
    // Simulate the market hub: ensureMarket registers a zero-priced placeholder first and the
    // first real ticker frame lands a moment later.
    markets.ensureHandler = (symbol) => {
      if (markets.market(symbol)) return true;
      markets.set(symbol, '0', '0');
      setTimeout(() => markets.set(symbol, '100000', '100001'), 150);
      return true;
    };

    const record = await engine.startStrategy(takerTakerConfig);
    expect(record).toMatchObject({ status: 'RUNNING', kind: 'position' });
  });

  it('rejects a launch whose ensured markets never deliver a live quote', async () => {
    const { engine, markets } = await createHarness({ marketDataWaitTimeoutMs: 250 });
    markets.ensureHandler = (symbol) => {
      if (!markets.market(symbol)) markets.set(symbol, '0', '0');
      return true;
    };

    await expect(engine.startStrategy(takerTakerConfig)).rejects.toMatchObject({
      code: 'strategy_market_data_unavailable', statusCode: 409,
      // The rejection must name both legs so the user can tell which feed is dead.
      label: 'BINANCE_FUTURE_BTC_USDT, OKX_FUTURE_BTC_USDT',
    });
  });

  it('re-ensures a symbol swept during the launch wait and still launches', async () => {
    const { engine, markets } = await createHarness({ marketDataWaitTimeoutMs: 5_000 });
    let ensureCalls = 0;
    markets.ensureHandler = (symbol) => {
      ensureCalls += 1;
      if (ensureCalls <= 2) {
        // Initial registration from startStrategy: zero-priced placeholder only.
        if (!markets.market(symbol)) markets.set(symbol, '0', '0');
        return true;
      }
      // Re-ensure from the wait loop delivers the live frame immediately.
      markets.set(symbol, '100000', '100001');
      return true;
    };
    // The market hub sweeps both placeholders before their first live frame; the wait loop must
    // re-ensure them instead of timing out.
    setTimeout(() => { markets.remove('BINANCE_FUTURE_BTC_USDT'); markets.remove('OKX_FUTURE_BTC_USDT'); }, 50);

    const record = await engine.startStrategy(takerTakerConfig);
    expect(record).toMatchObject({ status: 'RUNNING' });
    expect(ensureCalls).toBeGreaterThanOrEqual(3);
  });

  it('subscribes both strategy legs to live quotes so the launch wait can succeed', async () => {
    const { engine, markets } = await createHarness({ marketDataWaitTimeoutMs: 5_000 });
    // ensureMarket only registers a zero-priced placeholder: without a ticker subscription the
    // launch wait would never observe a live price and time out.
    markets.ensureHandler = (symbol) => {
      if (markets.market(symbol)) return true;
      markets.set(symbol, '0', '0');
      return true;
    };
    // The upstream only streams tickers for symbols the engine subscribed to: the first live
    // frame arrives only after watchQuotes.
    markets.onWatchQuotes = (symbols) => {
      setTimeout(() => {
        for (const symbol of symbols) markets.set(symbol, '100000', '100001');
      }, 100);
    };

    const record = await engine.startStrategy(takerTakerConfig);
    expect(record).toMatchObject({ status: 'RUNNING', kind: 'position' });
    expect(markets.watchQuotesCalls).toEqual([['BINANCE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT']]);
  });

  it('releases the leg quote subscription exactly once when a strategy stops', async () => {
    const { engine, markets } = await createHarness({ marketDataWaitTimeoutMs: 5_000 });
    markets.ensureHandler = (symbol) => {
      if (!markets.market(symbol)) markets.set(symbol, '0', '0');
      return true;
    };
    markets.onWatchQuotes = (symbols) => {
      setTimeout(() => {
        for (const symbol of symbols) markets.set(symbol, '100000', '100001');
      }, 50);
    };

    const record = await engine.startStrategy(takerTakerConfig);
    expect(record.status).toBe('RUNNING');
    expect(markets.quoteWatchReleases).toBe(0);

    await engine.stopStrategy(record.id);
    expect(markets.quoteWatchReleases).toBe(1);
    // A repeated stop must not release the same subscription twice.
    await engine.stopStrategy(record.id);
    expect(markets.quoteWatchReleases).toBe(1);
  });

  it('QA supplement: releases the leg quote watch when resume fails after the fresh-price wait', async () => {
    const { engine, database, markets } = await createHarness({ marketDataWaitTimeoutMs: 5_000 });
    markets.ensureHandler = (symbol) => {
      if (!markets.market(symbol)) markets.set(symbol, '0', '0');
      return true;
    };
    markets.onWatchQuotes = (symbols) => {
      // Only the resume's subscription triggers the concurrent mutation; the initial launch
      // must stay uncontended so the pause below sees exactly one running strategy.
      const isResumeWatch = markets.watchQuotesCalls.length === 2;
      setTimeout(() => {
        for (const symbol of symbols) markets.set(symbol, '100000', '100001');
        if (!isResumeWatch) return;
        // A concurrent mutation consumes the final running-strategy slot while the resume is
        // still waiting for its first live frames, so the post-wait re-check must reject.
        // Blocker rows carry a valid config because listStrategies re-parses every config_json.
        const now = new Date().toISOString();
        const blockerConfig = JSON.stringify(takerTakerConfig);
        for (let index = 0; index < 10; index += 1) {
          database.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json,
            progress, filled_quantity, filled_left, filled_right, open_position, credential_profile_id,
            credential_profile_label, created_at, updated_at, stopped_at)
            VALUES (?, 'position', 'live', 'RUNNING', ?, 0, '0', '0', '0', '0', NULL, 'Blocker', ?, ?, NULL)`)
            .run(`BLOCK-${index}`, blockerConfig, now, now);
        }
      }, 100);
    };

    const record = await engine.startStrategy({ ...takerTakerConfig, totalAmount: '0.2' });
    expect(engine.pauseRunningStrategiesForCredentialChange(DEFAULT_CREDENTIAL_PROFILE)).toBe(1);
    expect(markets.quoteWatchReleases).toBe(1);
    // Re-arm the zero-priced placeholders so the resume must pass through the fresh-price wait
    // (and therefore through its post-wait re-checks) before it can succeed.
    markets.set('BINANCE_FUTURE_BTC_USDT', '0', '0');
    markets.set('OKX_FUTURE_BTC_USDT', '0', '0');

    await expect(engine.resumeStrategy(record.id, DEFAULT_CREDENTIAL_PROFILE))
      .rejects.toMatchObject({ code: 'too_many_running_strategies', statusCode: 409 });
    // The subscription taken during the failed resume must not leak: the release is dropped
    // even though no actor was ever created.
    expect(markets.quoteWatchReleases).toBe(2);
  });

  it('rejects a paired strategy when its full target exceeds available margin', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.availableMargin = '10000';
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');

    await expect(engine.startStrategy({
      ...takerTakerConfig,
      totalAmount: '10',
      perOrderQuantity: '0.005',
      leftLeverage: '5',
      rightLeverage: '12',
    })).rejects.toMatchObject({ code: 'insufficient_strategy_margin', statusCode: 409 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('uses unified available margin without applying venue asset-row caps in cross-exchange mode', async () => {
    const { engine, gateway, markets } = await createHarness();
    gateway.availableMargin = '100000';
    gateway.accountAssets = [
      {
        coin: 'USDT', exchange_type: 'BINANCE', balance: '0', upnl: '0', equity: '0',
        futures_initial_margin: '0', futures_maintenance_margin: '0', borrowing_initial_margin: '0',
        borrowing_maintenance_margin: '0', available_balance: '0', liability: '0',
      },
      {
        coin: 'USDT', exchange_type: 'OKX', balance: '1', upnl: '0', equity: '1',
        futures_initial_margin: '0', futures_maintenance_margin: '0', borrowing_initial_margin: '0',
        borrowing_maintenance_margin: '0', available_balance: '1', liability: '0',
      },
    ];
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');

    const record = await engine.startStrategy(takerTakerConfig);

    expect(record.status).toBe('RUNNING');
  });

  it('queries and enforces each selected account top-level margin in isolated mode', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.accountMode = 'ISOLATED_EXCHANGE';
    gateway.isolatedAvailableMargins = { BINANCE: '100000', OKX: '1' };
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');

    await expect(engine.startStrategy(takerTakerConfig)).rejects.toMatchObject({
      code: 'insufficient_strategy_margin', statusCode: 409,
    });

    expect(gateway.accountQueries).toEqual([null, 'BINANCE', 'OKX']);
    expect(runtime.listStrategies()).toHaveLength(0);
  });

  it('executes a taker-taker paired position clip by clip and completes at the target', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    // Sell BINANCE at 100050 bid, buy OKX at 100000 ask: spread = 50/100000 = 5 bps < 10 bps entry.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100050', '100051');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig);
    expect(record.status).toBe('RUNNING');

    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);

    // Widen the spread beyond the 10 bps entry threshold.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [leftOrder, rightOrder] = gateway.createdOrders;
    expect(leftOrder).toMatchObject({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', time_in_force: 'IOC', qty: '0.1' });
    expect(rightOrder).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', time_in_force: 'IOC', qty: '0.1' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await firstTick;

    const midway = runtime.getStrategy(record.id);
    expect(midway.status).toBe('RUNNING');
    expect(midway.filledQuantity).toBe('0.1');
    expect(midway.progress).toBe(50);

    const secondTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await secondTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    const completed = runtime.getStrategy(record.id);
    expect(completed.filledQuantity).toBe('0.2');
    expect(completed.progress).toBe(100);
    const strategyOrders = runtime.listOrders().filter((order) => order.strategyId === record.id);
    expect(strategyOrders).toHaveLength(4);
    expect(new Set(strategyOrders.map((order) => order.strategyLeg))).toEqual(new Set(['left', 'right']));
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(4);
  });

  it('coalesces overlapping ticks into a single latest follow-up pass', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({ ...takerTakerConfig, totalAmount: '1' });

    const first = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const superseded = Array.from({ length: 12 }, () => engine.tick());
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');

    await waitFor(() => gateway.createdOrders.length === 4);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await Promise.all([first, ...superseded]);

    expect(gateway.createdOrders).toHaveLength(4);
    expect(runtime.getStrategy(record.id).filledQuantity).toBe('0.2');
  });

  it('hedges the filled leg when the opposite taker leg fails to submit', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    gateway.failCreate('OKX_FUTURE_BTC_USDT', 1);
    const record = await engine.startStrategy(takerTakerConfig);

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    await firstTick;

    // The left leg filled 0.1 SELL with no right leg. The engine must repair by buying the lagging leg.
    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const repair = gateway.createdOrders[1];
    expect(repair).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.1' });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100010');
    await repairTick;

    const strategy = runtime.getStrategy(record.id);
    expect(strategy.status).toBe('RUNNING');
    expect(strategy.filledQuantity).toBe('0.1');
    const logs = runtime.strategyLogs(record.id);
    expect(logs.some((log) => log.event === 'Hedging filled quantity')).toBe(true);
  });

  it('splits a router-rejected hedge into smaller clips and reports the upstream reason', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({ ...takerTakerConfig, totalAmount: '0.1' });
    const routerFailure = JSON.stringify({
      label: 'NOT_BEST_ACCOUNT_ROUTER',
      message: 'All trading channels are currently busy. Consider reducing the order amount.',
    });

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FAIL', '0', '0', routerFailure);

    // The first repair follows Gate's explicit advice and halves the rejected 0.1 order.
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.05',
    });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.05', '100000');
    await firstTick;

    // A successful split resets the failure budget; the remaining 0.05 can finish the hedge.
    const secondRepair = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders[3]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.05',
    });
    ackOrder(runtime, 'remote-4', 'FILLED', '0.05', '100000');
    await secondRepair;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Right leg fail', result: expect.stringContaining('NOT_BEST_ACCOUNT_ROUTER') }),
      expect.objectContaining({ event: 'Hedging filled quantity', result: expect.stringContaining('split after router rejected 0.1') }),
    ]));
  });

  it('pauses after repeated failed hedge attempts instead of trading blind', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    // The right leg rejects the clip submission and every hedge-repair attempt after it.
    gateway.failCreate('OKX_FUTURE_BTC_USDT', 10);
    const record = await engine.startStrategy(takerTakerConfig);

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    await firstTick;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await engine.tick();
      if (runtime.getStrategy(record.id).status === 'PAUSED') break;
    }

    const paused = runtime.getStrategy(record.id);
    expect(paused.status).toBe('PAUSED');
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Strategy paused')).toBe(true);
    // The failed hedge must not leave the filled left leg naked: one reduce-only flatten is sent
    // before pausing. A paused strategy then submits nothing further.
    expect(gateway.createdOrders).toHaveLength(2);
    expect(gateway.createdOrders[1]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET',
    });
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);
  });

  it('manually resumes a paused strategy only on its active account', async () => {
    const { engine, runtime, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig, {
      profileId: DEFAULT_CREDENTIAL_PROFILE,
      label: 'Primary Trading',
    });
    expect(engine.pauseRunningStrategiesForCredentialChange(DEFAULT_CREDENTIAL_PROFILE)).toBe(1);
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');

    await expect(engine.resumeStrategy(record.id, 'another-account')).rejects.toMatchObject({
      code: 'strategy_account_not_active', statusCode: 409,
    });
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');

    await expect(engine.resumeStrategy(record.id, DEFAULT_CREDENTIAL_PROFILE)).resolves.toMatchObject({
      id: record.id, status: 'RUNNING',
    });
    expect(engine.listActiveStrategyIds()).toEqual([record.id]);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy resumed', condition: 'Manual resume' }),
    ]));
    await expect(engine.resumeStrategy(record.id, DEFAULT_CREDENTIAL_PROFILE)).rejects.toMatchObject({
      code: 'strategy_not_paused', statusCode: 409,
    });
  });

  it('rests a post-only maker quote and hedges each maker fill on the taker venue', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '0.2', perOrderQuantity: '0.2',
      executionMethod: 'MAKER_TAKER', makerLeg: 'left',
    });

    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    const quote = gateway.createdOrders[0];
    // SELL maker at OKX ask 100000 * (1 + 10 bps) = 100100.
    expect(quote).toMatchObject({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'LIMIT', time_in_force: 'POC', qty: '0.2', price: '100100' });

    ackOrder(runtime, 'remote-1', 'PARTIALLY_FILLED', '0.08', '100100');
    ingestFill(runtime, 'remote-1', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '0.08', '100100');
    await waitFor(() => gateway.createdOrders.length === 2);
    const hedge = gateway.createdOrders[1];
    expect(hedge).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', time_in_force: 'IOC', qty: '0.08' });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.08', '100005');
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.08');

    ackOrder(runtime, 'remote-1', 'FILLED', '0.2', '100100');
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', qty: '0.12' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.12', '100008');
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(runtime.getStrategy(record.id).filledQuantity).toBe('0.2');
  });

  it('joins the maker best bid when it is within the configured buy-price boundary', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100', '100.01');
    markets.set('OKX_FUTURE_BTC_USDT', '100.01', '100.02');
    await engine.startStrategy({
      ...takerTakerConfig, entryBps: '-3', totalAmount: '0.1', perOrderQuantity: '0.1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });

    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);

    // Spread ceiling = 100 × 1.0003 = 100.03. The 100.01 best bid is cheaper and can be joined.
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', time_in_force: 'POC', price: '100.01',
    });
  });

  it('joins the maker best ask when it is within the configured sell-price boundary', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '99.98', '99.99');
    markets.set('OKX_FUTURE_BTC_USDT', '99.99', '100');
    await engine.startStrategy({
      ...takerTakerConfig, entryBps: '-3', totalAmount: '0.1', perOrderQuantity: '0.1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'left',
    });

    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);

    // Spread floor = 100 × 0.9997 = 99.97. The 99.99 best ask is better and can be joined.
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'LIMIT', time_in_force: 'POC', price: '99.99',
    });
  });

  it('carries an untradeable maker residual into the next clip before the target is complete', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.1', lot_size = '0.1' WHERE symbol = 'BINANCE_FUTURE_BTC_USDT'").run();
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', lot_size = '0.01' WHERE symbol = 'OKX_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '0.2', perOrderQuantity: '0.2',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });

    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', qty: '0.2' });

    // The fine-step maker fills 0.13, while the coarse taker venue can hedge only 0.1.
    ackOrder(runtime, 'remote-1', 'PARTIALLY_FILLED', '0.13', '99900');
    ingestFill(runtime, 'remote-1', 'OKX_FUTURE_BTC_USDT', 'BUY', '0.13', '99900');
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', qty: '0.1', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.1');

    // Once the partial maker quote closes, keep the 0.03 residual for the next normal clip. The
    // excess maker leg quotes only 0.07, after which the coarse taker leg can execute a full 0.1.
    ackOrder(runtime, 'remote-1', 'CANCELLED', '0.13', '99900');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    const carryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', time_in_force: 'POC', qty: '0.07', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.07', '99900');
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders[3]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.1', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await carryTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.getStrategy(record.id)).toMatchObject({
      status: 'COMPLETED', filledLeft: '0.2', filledRight: '0.2', filledQuantity: '0.2', progress: 100,
    });
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Trimming residual imbalance')).toBe(false);
  });

  it('absorbs a sub-min-notional residual in the next maker-taker clip before 100%', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3');
    markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '2', perOrderQuantity: '1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });
    seedFilledStrategyOrder(database, record.id, 'carry-left', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '1', 'left');
    seedFilledStrategyOrder(database, record.id, 'carry-right', 'OKX_FUTURE_BTC_USDT', 'BUY', '1.03', 'right');

    // Progress is below 100%, so do not top up or submit the invalid 0.03 repair. The excess
    // maker leg absorbs it by quoting 0.97 in the next configured 1.00 clip.
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', time_in_force: 'POC',
      qty: '0.97', reduce_only: 'false',
    });

    ackOrder(runtime, 'remote-1', 'FILLED', '0.97', '54.05');
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '1', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-2', 'FILLED', '1', '54.2');
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.getStrategy(record.id)).toMatchObject({
      progress: 100, filledLeft: '2', filledRight: '2', filledQuantity: '2',
    });
    expect(gateway.createdOrders.some((order) => order.qty === '0.03')).toBe(false);
  });

  it('tops up and exactly trims a sub-min-notional residual only after reaching 100%', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3');
    markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '1', perOrderQuantity: '1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });
    seedFilledStrategyOrder(database, record.id, 'terminal-left', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '1', 'left');
    seedFilledStrategyOrder(database, record.id, 'terminal-right', 'OKX_FUTURE_BTC_USDT', 'BUY', '1.03', 'right');

    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.11', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.11', '54.1');

    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.14', reduce_only: 'true',
    });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.14', '54');
    await repairTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.getStrategy(record.id)).toMatchObject({
      progress: 100, filledLeft: '1', filledRight: '1', filledQuantity: '1',
    });
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Padding terminal residual', quantity: '0.11 BTC' }),
      expect.objectContaining({ event: 'Trimming padded residual', quantity: '0.14 BTC' }),
      expect.objectContaining({ event: 'Padded residual trim settled' }),
    ]));
  });

  it('retries the enlarged reduce-only trim without padding twice after a close failure', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3');
    markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '1', perOrderQuantity: '1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });
    seedFilledStrategyOrder(database, record.id, 'retry-left', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '1', 'left');
    seedFilledStrategyOrder(database, record.id, 'retry-right', 'OKX_FUTURE_BTC_USDT', 'BUY', '1.03', 'right');

    const firstRepair = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.11', '54.1');
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-2', 'FAIL', '0', '0', 'TEMPORARY_CLOSE_REJECTION');
    await firstRepair;

    const retry = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.14', reduce_only: 'true',
    });
    expect(gateway.createdOrders.filter((order) => order.side === 'BUY')).toHaveLength(1);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.14', '54');
    await retry;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
  });

  it('completes a full position after trimming a persisted terminal-fill residual', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.1', lot_size = '0.1' WHERE symbol = 'BINANCE_FUTURE_BTC_USDT'").run();
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', lot_size = '0.01' WHERE symbol = 'OKX_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '0.1', perOrderQuantity: '0.1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });
    const now = new Date().toISOString();
    const insertFill = database.prepare(`INSERT INTO execution_orders (
      id, client_order_id, environment, symbol, venue, side, order_type, time_in_force,
      quantity, price, reduce_only, state, executed_quantity, executed_average_price,
      created_at, updated_at, strategy_id, strategy_leg
    ) VALUES (?, ?, 'live', ?, ?, ?, 'MARKET', 'IOC', ?, NULL, 0, 'FILLED', ?, '100000', ?, ?, ?, ?)`);
    insertFill.run('seed-left', 'seed-left-client', 'BINANCE_FUTURE_BTC_USDT', 'BINANCE', 'SELL',
      '0.1', '0.1', now, now, record.id, 'left');
    insertFill.run('seed-right', 'seed-right-client', 'OKX_FUTURE_BTC_USDT', 'OKX', 'BUY',
      '0.13', '0.13', now, now, record.id, 'right');

    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', qty: '0.03', reduce_only: 'true',
    });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.03', '100000');
    await repairTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.getStrategy(record.id)).toMatchObject({
      status: 'COMPLETED', filledLeft: '0.1', filledRight: '0.1', filledQuantity: '0.1', progress: 100,
    });
  });

  it('requotes the maker order when the taker leg moves beyond tolerance', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    await engine.startStrategy({
      ...takerTakerConfig, executionMethod: 'MAKER_TAKER', makerLeg: 'left', perOrderQuantity: '0.2',
    });
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]?.price).toBe('100100');

    // Move the taker (OKX) leg only ~10 bps: spread (100000 − 100100) / 100100 ≈ −9.99 bps ⇒
    // distance 10 − (−9.99) ≈ 19.99 bps ≤ 25, still inside the maker-entry proximity band, so the
    // requote path is reached instead of being parked.
    markets.set('OKX_FUTURE_BTC_USDT', '100099', '100100');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    const requoteTick = engine.tick();
    await waitFor(() => gateway.cancelledOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'CANCELLED', '0', '0');
    await requoteTick;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    // 100100 × (1 + 10 bps) = 100200.1, already on the 0.01 tick; the BINANCE best ask (100001) sits
    // below it, so the makerTop clamp does not move the price.
    expect(gateway.createdOrders[1]?.price).toBe('100200.1');
  });

  it('runs an auto spread bot through an entry and take-profit cycle with reduce-only exits', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
      entryBps: '10', takeProfitBps: '2', maxPosition: '0.1', perOrderQuantity: '0.1', reduceOnly: false,
      executionMethod: 'TAKER_TAKER',
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');

    // At max position no further entries are sent even though the spread is still wide.
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Collapse the spread: exit spread = (BINANCE ask - OKX bid) / OKX bid ≈ 1 bp ≤ 2 bps.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100009', '100010');
    markets.set('OKX_FUTURE_BTC_USDT', '100000', '100001');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'BINANCE_FUTURE_BTC_USDT')).toMatchObject({ side: 'BUY', reduce_only: 'true' });
    expect(exits.find((order) => order.symbol === 'OKX_FUTURE_BTC_USDT')).toMatchObject({ side: 'SELL', reduce_only: 'true' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100010');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0');

    const strategy = runtime.getStrategy(record.id);
    expect(strategy.status).toBe('RUNNING');
    expect(strategy.filledLeft).toBe('0');
    expect(strategy.filledRight).toBe('0');
  });

  it('cancels resting maker quotes when a strategy is stopped', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      ...takerTakerConfig, executionMethod: 'MAKER_TAKER', makerLeg: 'left', perOrderQuantity: '0.2',
    });
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);

    const stopped = await engine.stopStrategy(record.id);
    expect(stopped.status).toBe('STOPPED');
    expect(gateway.cancelledOrders).toEqual(['remote-1']);
    expect(engine.listActiveStrategyIds()).toEqual([]);
  });

  describe('reduce-only rejections reconcile against the venue position', () => {
    const left = 'BINANCE_FUTURE_BTC_USDT';
    const right = 'OKX_FUTURE_BTC_USDT';

    /** The drift correction arms a 250 ms cooldown before re-quoting; wait it out explicitly. */
    const pastCooldown = (): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, 300));

    /**
     * An auto spread bot already at its position cap: both legs are seeded filled, so once the
     * take-profit level is reached the only order the engine can rest is the reduce-only exit.
     */
    async function openCappedPosition(
      harness: Harness,
      executionMethod: 'TAKER_TAKER' | 'MAKER_TAKER' = 'MAKER_TAKER',
    ) {
      const { engine, database, markets } = harness;
      markets.set(left, '100150', '100151');
      markets.set(right, '99999', '100000');
      const record = await engine.startStrategy({
        kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
        leftSide: 'SELL', rightSide: 'BUY', entryBps: '10', takeProfitBps: '2',
        maxPosition: '0.1', perOrderQuantity: '0.1', reduceOnly: false, executionMethod,
        ...(executionMethod === 'MAKER_TAKER' ? { makerLeg: 'left' as const } : {}),
      });
      seedFilledStrategyOrder(database, record.id, 'seed-left', left, 'SELL', '0.1', 'left');
      seedFilledStrategyOrder(database, record.id, 'seed-right', right, 'BUY', '0.1', 'right');
      return record;
    }

    /** Collapse the spread to ≈1 bp, below takeProfitBps 2, so the exit intent fires. */
    function collapseToTakeProfit(markets: StubMarkets): void {
      markets.set(left, '100009', '100010');
      markets.set(right, '100000', '100001');
    }

    function eventsOf(runtime: TradingRuntime, strategyId: string): Set<string> {
      return new Set(runtime.strategyLogs(strategyId).map((log) => log.event));
    }

    it('clamps a maker exit to the venue size and re-quotes instead of burning the strike budget', async () => {
      const harness = await createHarness();
      const { engine, runtime, gateway, markets } = harness;
      const record = await openCappedPosition(harness);
      // The venue closed most of the position outside the engine: only 0.04 of 0.1 remains short.
      gateway.positions = [futuresPosition(left, 'SHORT', '0.04')];
      gateway.createFailLabel = 'TRADE_REDUCE_ONLY_POSITION_QTY_ERROR';
      gateway.failCreate(left, 1);

      collapseToTakeProfit(markets);
      // Margin preflight already read positions once; the rejection must add exactly one more read.
      const readsBeforeRejection = gateway.positionQueries;
      await engine.tick();
      await waitFor(() => gateway.createAttempts.length === 1);
      expect(gateway.createAttempts[0]).toMatchObject({
        symbol: left, side: 'BUY', type: 'LIMIT', qty: '0.1', reduce_only: 'true',
      });

      // The rejection reconciled from the venue rather than counting a strike.
      await waitFor(() => eventsOf(runtime, record.id).has('Exit size corrected'));
      const events = eventsOf(runtime, record.id);
      expect(events.has('Exit size drift')).toBe(true);
      expect(events.has('Maker quote rejected')).toBe(false);
      expect(gateway.positionQueries).toBe(readsBeforeRejection + 1);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
      expect(runtime.snapshot().positions).toEqual([
        expect.objectContaining({ symbol: left, quantity: '-0.04' }),
      ]);

      // The next tick re-reports at the venue size instead of resubmitting a doomed exit.
      await pastCooldown();
      const requoteTick = engine.tick();
      await waitFor(() => gateway.createAttempts.length === 2);
      expect(gateway.createAttempts[1]).toMatchObject({ symbol: left, side: 'BUY', qty: '0.04', reduce_only: 'true' });
      await requoteTick;
      expect(engine.listActiveStrategyIds()).toEqual([record.id]);
    });

    it('withdraws the maker exit quote when the venue holds no reducible position', async () => {
      const harness = await createHarness();
      const { engine, runtime, gateway, markets } = harness;
      const record = await openCappedPosition(harness);
      gateway.createFailLabel = 'TRADE_REDUCE_ONLY_POSITION_QTY_ERROR';
      gateway.failCreate(left, 1);

      collapseToTakeProfit(markets);
      await engine.tick();
      await waitFor(() => eventsOf(runtime, record.id).has('Exit quote withdrawn'));

      expect(eventsOf(runtime, record.id).has('Maker quote rejected')).toBe(false);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
      expect(runtime.snapshot().positions).toEqual([]);

      // No death loop: once the clamp reads zero the exit intent is dropped entirely, so repeated
      // ticks submit nothing further.
      await pastCooldown();
      await engine.tick();
      await pastCooldown();
      await engine.tick();
      expect(gateway.createAttempts).toHaveLength(1);
      expect(engine.listActiveStrategyIds()).toEqual([record.id]);
    });

    it('falls back to ordinary rejection accounting when the venue agrees with the ledger', async () => {
      const harness = await createHarness();
      const { engine, runtime, gateway, markets } = harness;
      const record = await openCappedPosition(harness);
      gateway.positions = [futuresPosition(left, 'SHORT', '0.1')];
      gateway.createFailLabel = 'TRADE_REDUCE_ONLY_POSITION_QTY_ERROR';
      gateway.failCreate(left, 1);

      collapseToTakeProfit(markets);
      await engine.tick();
      await waitFor(() => eventsOf(runtime, record.id).has('Maker quote rejected'));

      const events = eventsOf(runtime, record.id);
      expect(events.has('Exit size drift')).toBe(true);
      expect(events.has('Exit size corrected')).toBe(false);
      expect(events.has('Exit quote withdrawn')).toBe(false);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    });

    it('falls back to the ordinary path when the reconciliation read itself fails', async () => {
      const harness = await createHarness();
      const { engine, runtime, gateway, markets } = harness;
      const record = await openCappedPosition(harness);
      gateway.createFailLabel = 'TRADE_REDUCE_ONLY_POSITION_QTY_ERROR';
      gateway.failPositionsLabel = 'TRADE_SYSTEM_BUSY';
      gateway.failCreate(left, 1);

      collapseToTakeProfit(markets);
      await engine.tick();
      await waitFor(() => eventsOf(runtime, record.id).has('Position reconciliation failed'));

      expect(eventsOf(runtime, record.id).has('Maker quote rejected')).toBe(true);
      expect(eventsOf(runtime, record.id).has('Exit size corrected')).toBe(false);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    });

    it('pauses immediately when a taker exit finds the venue position already gone', async () => {
      const harness = await createHarness();
      const { engine, runtime, gateway, markets } = harness;
      const record = await openCappedPosition(harness, 'TAKER_TAKER');
      gateway.createFailLabel = 'TRADE_REDUCE_ONLY_POSITION_QTY_ERROR';
      // Only the left leg is rejected; the venue holds nothing at all on either leg.
      gateway.failCreate(left, 1);

      collapseToTakeProfit(markets);
      const readsBeforeRejection = gateway.positionQueries;
      await engine.tick();
      await waitFor(() => runtime.getStrategy(record.id).status === 'PAUSED');

      expect(gateway.positionQueries).toBe(readsBeforeRejection + 1);
      expect(gateway.createAttempts).toHaveLength(2);
      expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Strategy paused'
        && /holds no reducible position/i.test(log.result))).toBe(true);
      expect(engine.listActiveStrategyIds()).toEqual([]);
    });

    it('clamps a taker exit clip to the venue size instead of re-reporting the ghost position', async () => {
      const harness = await createHarness();
      const { engine, runtime, gateway, markets } = harness;
      const record = await openCappedPosition(harness, 'TAKER_TAKER');
      // The venue closed most of the position outside the engine: only 0.04 of the 0.1 short remains.
      // Without the clamp the tick keeps re-reporting the ledger's 0.1, is rejected again, and the
      // strategy pauses on the fifth strike — the `AUTO-B63B204D` shape (five `Leg submission
      // failed` rows inside a minute).
      gateway.positions = [futuresPosition(left, 'SHORT', '0.04')];
      gateway.createFailLabel = 'TRADE_REDUCE_ONLY_POSITION_QTY_ERROR';
      gateway.failCreate(left, 1);

      collapseToTakeProfit(markets);
      const readsBeforeRejection = gateway.positionQueries;
      await engine.tick();
      await waitFor(() => gateway.createAttempts.length === 2);
      expect(gateway.createAttempts[0]).toMatchObject({
        symbol: left, side: 'BUY', type: 'MARKET', qty: '0.1', reduce_only: 'true',
      });

      // The rejection reconciled against the venue rather than counting a strike.
      await waitFor(() => eventsOf(runtime, record.id).has('Exit size corrected'));
      const events = eventsOf(runtime, record.id);
      expect(events.has('Exit size drift')).toBe(true);
      expect(events.has('Leg submission failed')).toBe(false);
      expect(gateway.positionQueries).toBe(readsBeforeRejection + 1);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');

      // The next tick re-reports at the venue size and re-derives the hedge leg from it, so the
      // clip stays a hedge instead of exiting the full size on one leg and a clamped size on the
      // other. BTC auto legs have no ADR ratio, so both legs land on 0.04.
      await pastCooldown();
      const requoteTick = engine.tick();
      await waitFor(() => gateway.createAttempts.length === 4);
      expect(gateway.createAttempts[2]).toMatchObject({ symbol: left, side: 'BUY', qty: '0.04', reduce_only: 'true' });
      expect(gateway.createAttempts[3]).toMatchObject({ symbol: right, side: 'SELL', qty: '0.04', reduce_only: 'true' });
      await requoteTick;
      expect(eventsOf(runtime, record.id).has('Leg submission failed')).toBe(false);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
      expect(engine.listActiveStrategyIds()).toEqual([record.id]);
    });
  });

  it('keeps a stop pending until the exchange confirms every cancellation', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      ...takerTakerConfig, executionMethod: 'MAKER_TAKER', makerLeg: 'left', perOrderQuantity: '0.2',
    });
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);

    gateway.holdCancellations = true;
    await expect(engine.stopStrategy(record.id)).rejects.toThrow('strategy_stop_pending_remote');
    expect(runtime.getStrategy(record.id).status).toBe('STOP_PENDING_REMOTE');
    expect(engine.listActiveStrategyIds()).toEqual([record.id]);

    gateway.holdCancellations = false;
    await engine.tick();
    expect(runtime.getStrategy(record.id).status).toBe('STOPPED');
    expect(engine.listActiveStrategyIds()).toEqual([]);
  });

  it('runs an ADR premium bot through a ratio-hedged entry and take-profit cycle', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    // Fair ADR value = 1700 ÷ 10 = 170. SKHY bid 229.9 → executable premium ≈ 35.24% ≥ 35%.
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    expect(record.id.startsWith('PREM-')).toBe(true);

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [adrLeg, hedgeLeg] = gateway.createdOrders;
    // The hedge leg buys per-order ÷ ratio of the local listing (10 ADRs per Korean share).
    expect(adrLeg).toMatchObject({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'SELL', type: 'MARKET', qty: '0.1' });
    expect(hedgeLeg).toMatchObject({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'BUY', type: 'MARKET', qty: '0.01' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.01', '1700');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');
    expect(runtime.getStrategy(record.id).progress).toBe(100);
    const entryLogs = runtime.strategyLogs(record.id);
    expect(entryLogs.filter((log) => log.event === 'Position open Executed')).toHaveLength(1);
    expect(entryLogs.some((log) => log.event === 'Left leg filled' || log.event === 'Right leg filled')).toBe(false);

    // At max position with the premium still above take profit, nothing further fires.
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Premium collapses: SKHY ask 210 → exit premium = 210/170 − 1 ≈ 23.5% ≤ 24%.
    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'GATE_FUTURE_SKHY_USDT')).toMatchObject({ side: 'BUY', qty: '0.1', reduce_only: 'true' });
    expect(exits.find((order) => order.symbol === 'GATE_FUTURE_SKHYNIX_USDT')).toMatchObject({ side: 'SELL', qty: '0.01', reduce_only: 'true' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '210.0');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.01', '1700');
    ingestFill(runtime, 'remote-3', 'GATE_FUTURE_SKHY_USDT', 'BUY', '0.1', '210.0', '1.5');
    ingestFill(runtime, 'remote-4', 'GATE_FUTURE_SKHYNIX_USDT', 'SELL', '0.01', '1700', '0.5');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0');
    expect(runtime.getStrategy(record.id).status).toBe('COMPLETED');
    expect(runtime.getStrategy(record.id).realizedPnl).toBe('2');
    expect(runtime.listStrategies().find((strategy) => strategy.id === record.id)?.realizedPnl).toBe('2');
    expect(engine.listActiveStrategyIds()).not.toContain(record.id);
    const exitLogs = runtime.strategyLogs(record.id);
    expect(exitLogs.filter((log) => log.event === 'Take-profit Executed')).toHaveLength(1);
    expect(exitLogs.filter((log) => log.event === 'Strategy completed')).toHaveLength(1);
    expect(exitLogs.some((log) => log.event === 'Left leg filled' || log.event === 'Right leg filled')).toBe(false);
  });

  it('reduces existing premium positions in per-order clips and stops without a take-profit cycle', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.positions = [
      futuresPosition('GATE_FUTURE_SKHY_USDT', 'LONG', '0.2'),
      futuresPosition('GATE_FUTURE_SKHYNIX_USDT', 'SHORT', '0.02'),
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', maxPosition: '0.2', perOrderQuantity: '0.1',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
    });

    expect(gateway.leverageQueries).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
    for (let clip = 0; clip < 2; clip += 1) {
      const tick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === (clip + 1) * 2);
      const [left, right] = gateway.createdOrders.slice(clip * 2, clip * 2 + 2);
      expect(left).toMatchObject({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'SELL', qty: '0.1', reduce_only: 'true' });
      expect(right).toMatchObject({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'BUY', qty: '0.01', reduce_only: 'true' });
      ackOrder(runtime, `remote-${clip * 2 + 1}`, 'FILLED', '0.1', '229.9');
      ackOrder(runtime, `remote-${clip * 2 + 2}`, 'FILLED', '0.01', '1700');
      await tick;
    }

    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(runtime.getStrategy(record.id)).toMatchObject({ progress: 100, openPosition: '0' });
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Reduce-only triggered' }),
      expect.objectContaining({ event: 'Reduce-only Executed' }),
      expect.objectContaining({ event: 'Strategy completed', condition: 'Reduce-only target 0.2 SKHY' }),
    ]));
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(4);
  });

  it('rejects reduce-only premium strategies that do not fit the current positions', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.positions = [
      futuresPosition('GATE_FUTURE_SKHY_USDT', 'LONG', '0.1'),
      futuresPosition('GATE_FUTURE_SKHYNIX_USDT', 'SHORT', '0.01'),
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', maxPosition: '0.2', perOrderQuantity: '0.1',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'reduce_only_position_unavailable', statusCode: 409 });
    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('rejects stale or transport-delayed premium legs but accepts independently timed fresh quotes', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, markets } = await createHarness({ now: () => now });
    const currentTimestamp = new Date(now).toISOString();
    markets.set('GATE_FUTURE_SKHY_USDT', '144.9', '145', currentTimestamp);
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1139', '1140', currentTimestamp);
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'BUY', rightSide: 'SELL',
      entryPremiumPct: '28', takeProfitPremiumPct: '30', maxPosition: '1', perOrderQuantity: '1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '1', '145');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '1140');
    await entryTick;

    // Fresh-looking objects are still unusable while the upstream feed itself is stale.
    markets.setConnectionState('stale');
    markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8', new Date(now).toISOString());
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8', new Date(now).toISOString());
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);
    markets.setConnectionState('healthy');

    now += 5_000;
    markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8', new Date(now).toISOString());
    // A fresh-looking source timestamp is unusable when that frame took over three seconds to
    // reach us. The pair must not manufacture a take-profit signal from delayed transport.
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8',
      new Date(now - 4_000).toISOString(), new Date(now).toISOString());
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // A coherent pair that is minutes old is also unusable.
    const staleTimestamp = new Date(now - 60_000).toISOString();
    markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8', staleTimestamp);
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8', staleTimestamp);
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Each leg is individually fresh and arrived promptly, but six seconds apart in exchange
    // time the pair describes a spread that never coexisted on either venue — the very mismatch
    // that showed up as fills far from the triggered bps. Independently timed is not aligned.
    markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8', new Date(now).toISOString());
    const independentlyTimed = new Date(now - 6_000).toISOString();
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8', independentlyTimed, independentlyTimed);
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Realign the legs and the very same prices qualify immediately.
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8', new Date(now).toISOString());
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders.slice(2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'SELL', reduce_only: 'true' }),
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'BUY', reduce_only: 'true' }),
    ]));
    ackOrder(runtime, 'remote-3', 'FILLED', '1', '143.78');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '1083.8');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
  });

  it('latches take profit after a partial opening, closes all filled exposure, and never re-enters', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.3', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    for (let clip = 0; clip < 2; clip += 1) {
      const tick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === (clip + 1) * 2);
      ackOrder(runtime, `remote-${clip * 2 + 1}`, 'FILLED', '0.1', '229.9');
      ackOrder(runtime, `remote-${clip * 2 + 2}`, 'FILLED', '0.01', '1700');
      await tick;
    }
    expect(runtime.getStrategy(record.id).openPosition).toBe('0.2');
    expect(runtime.getStrategy(record.id).progress).toBeCloseTo(66.6667, 3);

    // Take profit arrives before the configured 0.3 maximum was reached.
    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 6);
    ackOrder(runtime, 'remote-5', 'FILLED', '0.1', '210');
    ackOrder(runtime, 'remote-6', 'FILLED', '0.01', '1700');

    // Even if the premium immediately moves back to the entry region, the latched exit must
    // reduce the remaining partial position instead of opening another clip.
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    await waitFor(() => gateway.createdOrders.length === 8);
    const residualCloses = gateway.createdOrders.slice(6);
    expect(residualCloses).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'BUY', qty: '0.1', reduce_only: 'true' }),
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'SELL', qty: '0.01', reduce_only: 'true' }),
    ]));
    ackOrder(runtime, 'remote-7', 'FILLED', '0.1', '230');
    ackOrder(runtime, 'remote-8', 'FILLED', '0.01', '1700');
    await exitTick;

    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(runtime.getStrategy(record.id)).toMatchObject({ openPosition: '0', progress: 100 });
    expect(engine.listActiveStrategyIds()).not.toContain(record.id);
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(8);
  });

  it('caps every take-profit follow-up at the per-order quantity instead of closing the full residual', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.4', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    for (let clip = 0; clip < 4; clip += 1) {
      const tick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === (clip + 1) * 2);
      ackOrder(runtime, `remote-${clip * 2 + 1}`, 'FILLED', '0.1', '229.9');
      ackOrder(runtime, `remote-${clip * 2 + 2}`, 'FILLED', '0.01', '1700');
      await tick;
    }
    expect(runtime.getStrategy(record.id).openPosition).toBe('0.4');

    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 10);
    ackOrder(runtime, 'remote-9', 'FILLED', '0.1', '210');
    ackOrder(runtime, 'remote-10', 'FILLED', '0.01', '1700');

    for (let residualClip = 0; residualClip < 3; residualClip += 1) {
      const expectedCount = 12 + residualClip * 2;
      await waitFor(() => gateway.createdOrders.length === expectedCount);
      const [left, right] = gateway.createdOrders.slice(expectedCount - 2, expectedCount);
      expect(left).toMatchObject({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'BUY', qty: '0.1', reduce_only: 'true' });
      expect(right).toMatchObject({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'SELL', qty: '0.01', reduce_only: 'true' });
      ackOrder(runtime, `remote-${expectedCount - 1}`, 'FILLED', '0.1', '210');
      ackOrder(runtime, `remote-${expectedCount}`, 'FILLED', '0.01', '1700');
    }
    await exitTick;

    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(runtime.getStrategy(record.id)).toMatchObject({ progress: 100, openPosition: '0' });
    expect(gateway.createdOrders).toHaveLength(16);
  });

  it('closes the surviving leg after a take-profit leg fails instead of reopening the flat leg', async () => {
    let now = Date.now();
    const { engine, runtime, database, gateway, markets } = await createHarness({ now: () => now });
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.01', '1700');
    await entryTick;

    gateway.failCreate('GATE_FUTURE_SKHYNIX_USDT', 1);
    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 3);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '210');
    await exitTick;
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');

    // The exit phase is recovered from durable reduce-only order history after a restart.
    await engine.stop();
    now += 5_000;
    const rearmedSession = new TradingSession();
    rearmedSession.set('live');
    const resumed = new StrategyEngine(database, rearmedSession, runtime, markets, {
      tickIntervalMs: 20, orderTimeoutMs: 400, repairCooldownMs: 0, now: () => now,
    });
    resumed.start();
    const cleanupTick = resumed.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders[3]).toMatchObject({
      symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'SELL', qty: '0.01', reduce_only: 'true',
    });
    ackOrder(runtime, 'remote-4', 'FILLED', '0.01', '1700');
    await cleanupTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(gateway.createdOrders.filter((order) => (
      order.symbol === 'GATE_FUTURE_SKHY_USDT' && order.side === 'SELL'
    ))).toHaveLength(1);
    await resumed.stop();
  });

  it('applies both leverage settings only after the full premium capacity passes margin preflight', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230');
    markets.set('BINANCE_FUTURE_SKHYNIX_USDT', '1699', '1700');

    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'BINANCE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '5', rightLeverage: '10',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.5', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    expect(record.config).toMatchObject({ leftLeverage: '5', rightLeverage: '10' });
    expect(gateway.leverageUpdates).toEqual([
      { symbol: 'GATE_FUTURE_SKHY_USDT', leverage: '5' },
      { symbol: 'BINANCE_FUTURE_SKHYNIX_USDT', leverage: '10' },
    ]);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy started', result: expect.stringContaining('reserved margin') }),
    ]));
  });

  it('defaults auto all-futures spreads to 1× leverage when the config omits it', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');

    const record = await engine.startStrategy({
      kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
      entryBps: '10', takeProfitBps: '2', maxPosition: '0.1', perOrderQuantity: '0.1', reduceOnly: false,
      executionMethod: 'TAKER_TAKER',
    });

    expect(record.status).toBe('RUNNING');
    expect(gateway.leverageUpdates).toEqual([
      { symbol: 'BINANCE_FUTURE_BTC_USDT', leverage: '1' },
      { symbol: 'OKX_FUTURE_BTC_USDT', leverage: '1' },
    ]);
    await engine.stopStrategy(record.id);
  });

  it('applies the configured per-leg leverage to auto all-futures spreads', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');

    const record = await engine.startStrategy({
      kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '3', rightLeverage: '5',
      entryBps: '10', takeProfitBps: '2', maxPosition: '0.1', perOrderQuantity: '0.1', reduceOnly: false,
      executionMethod: 'TAKER_TAKER',
    });

    expect(record.status).toBe('RUNNING');
    expect(gateway.leverageUpdates).toEqual([
      { symbol: 'BINANCE_FUTURE_BTC_USDT', leverage: '3' },
      { symbol: 'OKX_FUTURE_BTC_USDT', leverage: '5' },
    ]);
    await engine.stopStrategy(record.id);
  });

  it('does not reapply numerically equivalent leverage settings during premium preflight', async () => {
    const { engine, gateway, markets } = await createHarness();
    gateway.leverages = {
      GATE_FUTURE_SKHY_USDT: '12.0',
      GATE_FUTURE_SKHYNIX_USDT: '15',
    };
    markets.set('GATE_FUTURE_SKHY_USDT', '155.7', '155.8');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1180.2', '1180.3');

    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '12', rightLeverage: '15', hedgeMode: 'EQUAL_NOTIONAL',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '10', perOrderQuantity: '1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    expect(record.status).toBe('RUNNING');
    expect(gateway.leverageQueries).toEqual([
      ['GATE_FUTURE_SKHY_USDT'],
      ['GATE_FUTURE_SKHYNIX_USDT'],
    ]);
    expect(gateway.leverageUpdates).toHaveLength(0);
  });

  it('rejects new premium grid strategies without persisting or ordering', async () => {
    const { engine, runtime, gateway } = await createHarness();

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', grid: true, gridStepPct: '1', gridLevels: 5,
      perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'premium_grid_mode_removed', statusCode: 400 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('rejects a premium strategy before persistence or leverage changes when planned margin is insufficient', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.availableMargin = '30';
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230');
    markets.set('BINANCE_FUTURE_SKHYNIX_USDT', '1699', '1700');

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'BINANCE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '5', rightLeverage: '10',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.5', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'insufficient_strategy_margin', statusCode: 409 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('rejects a strategy whose projected position exceeds the tier allowed by selected leverage', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.riskLimits.GATE_FUTURE_SKHY_USDT = [
      { tier: '1', min_risk_limit_value: '0', max_risk_limit_value: '100', quick_cal_amount: '0', leverage_max: '20', maintenance_rate: '0.01' },
      { tier: '2', min_risk_limit_value: '100', max_risk_limit_value: '500', quick_cal_amount: '0', leverage_max: '10', maintenance_rate: '0.02' },
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230');
    markets.set('BINANCE_FUTURE_SKHYNIX_USDT', '1699', '1700');

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'BINANCE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '20', rightLeverage: '10',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.5', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'strategy_position_exceeds_leverage_limit', statusCode: 409 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('allows a premium strategy whose maximum capacity only reduces same-venue opposite positions', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.availableMargin = '0';
    gateway.positions = [
      futuresPosition('GATE_FUTURE_SKHY_USDT', 'SHORT', '15'),
      futuresPosition('GATE_FUTURE_SKHYNIX_USDT', 'LONG', '1.95'),
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '156.1', '156.2');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1180.4', '1180.5');

    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'BUY', rightSide: 'SELL',
      leftLeverage: '5', rightLeverage: '5', hedgeMode: 'EQUAL_NOTIONAL',
      entryPremiumPct: '35', takeProfitPremiumPct: '50', maxPosition: '15', perOrderQuantity: '1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    expect(record.status).toBe('RUNNING');
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy started', result: expect.stringContaining('reserved margin 0 of 0') }),
    ]));
  });

  it('does not offset opposite positions held on another venue', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.availableMargin = '10';
    gateway.positions = [
      futuresPosition('BINANCE_FUTURE_SKHY_USDT', 'SHORT', '15'),
      futuresPosition('BINANCE_FUTURE_SKHYNIX_USDT', 'LONG', '1.95'),
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '156.1', '156.2');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1180.4', '1180.5');

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'BUY', rightSide: 'SELL',
      leftLeverage: '5', rightLeverage: '5', hedgeMode: 'EQUAL_NOTIONAL',
      entryPremiumPct: '35', takeProfitPremiumPct: '50', maxPosition: '15', perOrderQuantity: '1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'insufficient_strategy_margin', statusCode: 409 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
  });

  it('pauses immediately and sends no further clips when both legs report insufficient margin', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '3', rightLeverage: '3',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    gateway.failCreate('GATE_FUTURE_SKHY_USDT', 10);
    gateway.failCreate('GATE_FUTURE_SKHYNIX_USDT', 10);

    await engine.tick();
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');
    const requestCount = gateway.createAttempts.length;
    await engine.tick();
    await engine.tick();

    expect(gateway.createAttempts).toHaveLength(requestCount);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy paused', result: expect.stringContaining('stopped retrying') }),
    ]));
  });

  it('updates a running ADR premium bot take profit and uses it on the next tick', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.01', '1700');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');

    // 25% is above the original 24% exit, but below the newly edited 26% exit.
    markets.set('GATE_FUTURE_SKHY_USDT', '212.4', '212.5');
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    const updated = await engine.updatePremiumTakeProfit(record.id, { takeProfitPremiumPct: '26' });
    expect(updated.config.takeProfitPremiumPct).toBe('26');
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Take-profit updated', condition: '24% → 26%' }),
    ]));

    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders.slice(2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'BUY', reduce_only: 'true' }),
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'SELL', reduce_only: 'true' }),
    ]));
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '212.5');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.01', '1700');
    await exitTick;
  });

  it('rejects invalid take-profit edits for running ADR premium bots', async () => {
    const { engine, runtime, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '200', '201');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    await expect(engine.updatePremiumTakeProfit(record.id, { takeProfitPremiumPct: '35' }))
      .rejects.toMatchObject({ code: 'take_profit_must_be_below_entry' });
    await expect(engine.updatePremiumTakeProfit(record.id, { takeProfitPremiumPct: 'not-a-number' }))
      .rejects.toMatchObject({ name: 'ZodError' });
    expect(runtime.getStrategy(record.id).config.takeProfitPremiumPct).toBe('24');
  });

  it('rejects premium bots whose take profit is on the wrong side of entry', async () => {
    const { engine, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const base = {
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', maxPosition: '0.2', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    } as const;
    await expect(engine.startStrategy({ ...base, takeProfitPremiumPct: '36' }))
      .rejects.toMatchObject({ code: 'take_profit_must_be_below_entry' });
    await expect(engine.startStrategy({ ...base, leftSide: 'BUY', rightSide: 'SELL', entryPremiumPct: '-5', takeProfitPremiumPct: '-8' }))
      .rejects.toMatchObject({ code: 'take_profit_must_be_above_entry' });
  });

  it('repairs the hedge with a ratio-scaled order when the hedge leg fails to submit', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    gateway.failCreate('GATE_FUTURE_SKHYNIX_USDT', 1);
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.2', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    await firstTick;

    // 0.1 SKHY sold with no hedge: the repair buys 0.1 ÷ 10 = 0.01 SKHYNIX.
    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'BUY', type: 'MARKET', qty: '0.01' });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.01', '1705');
    await repairTick;
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.1');
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('sizes equal-notional hedges from execution prices and unwinds them proportionally', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10', hedgeMode: 'EQUAL_NOTIONAL',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [adrLeg, hedgeLeg] = gateway.createdOrders;
    expect(adrLeg).toMatchObject({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'SELL', qty: '0.1' });
    // Equal notional at execution prices: 0.1 × 229.9 ÷ 1700 ≈ 0.0135235 SKHYNIX — not 0.01.
    expect(hedgeLeg?.symbol).toBe('GATE_FUTURE_SKHYNIX_USDT');
    expect(Number(hedgeLeg?.qty)).toBeCloseTo(0.0135235, 6);
    const hedgeQty = hedgeLeg?.qty ?? '0';
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    ackOrder(runtime, 'remote-2', 'FILLED', hedgeQty, '1700');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');
    expect(runtime.getStrategy(record.id).progress).toBe(100);

    // A hedged equal-notional clip must not trigger phantom repairs as prices move.
    markets.set('GATE_FUTURE_SKHY_USDT', '232.9', '233.0');
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Premium converges; the exit unwinds the actually-held hedge shares, not per-order ÷ ratio.
    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'GATE_FUTURE_SKHY_USDT')).toMatchObject({ side: 'BUY', qty: '0.1', reduce_only: 'true' });
    const hedgeExit = exits.find((order) => order.symbol === 'GATE_FUTURE_SKHYNIX_USDT');
    expect(hedgeExit?.side).toBe('SELL');
    expect(Number(hedgeExit?.qty)).toBeCloseTo(Number(hedgeQty), 12);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '210.0');
    ackOrder(runtime, 'remote-4', 'FILLED', hedgeExit?.qty ?? '0', '1700');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0');
    expect(runtime.getStrategy(record.id).status).toBe('COMPLETED');
  });

  it('repairs a failed equal-notional hedge with the clip-intended quantity', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    gateway.failCreate('GATE_FUTURE_SKHYNIX_USDT', 1);
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10', hedgeMode: 'EQUAL_NOTIONAL',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    await firstTick;

    // Even though prices moved after the clip, the repair restores the clip's own intended
    // hedge (0.1 × 229.9 ÷ 1700), recovered from the failed order's requested quantity.
    markets.set('GATE_FUTURE_SKHY_USDT', '239.9', '240.0');
    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const repair = gateway.createdOrders[1];
    expect(repair?.symbol).toBe('GATE_FUTURE_SKHYNIX_USDT');
    expect(repair?.side).toBe('BUY');
    expect(Number(repair?.qty)).toBeCloseTo(0.0135235, 6);
    ackOrder(runtime, 'remote-2', 'FILLED', repair?.qty ?? '0', '1705');
    await repairTick;
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.1');
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('rejects equal-notional hedging on non-premium strategies', async () => {
    const { engine, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    await expect(engine.startStrategy({ ...takerTakerConfig, hedgeMode: 'EQUAL_NOTIONAL' })).rejects.toThrow();
  });

  it('keeps RUNNING strategies detached after restart until live activation reconciles them', async () => {
    const { engine, runtime, database, markets, gateway } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig);
    await engine.stop();

    const rearmedSession = new TradingSession();
    const resumed = new StrategyEngine(database, rearmedSession, runtime, markets, { tickIntervalMs: 20, orderTimeoutMs: 400 });
    resumed.start();
    expect(resumed.listActiveStrategyIds()).toEqual([]);
    rearmedSession.set('live');
    await resumed.prepareForLiveActivation();
    resumed.activatePersistedStrategies();
    expect(resumed.listActiveStrategyIds()).toEqual([record.id]);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Strategy resumed')).toBe(true);
    const resumeTick = resumed.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await resumeTick;
    await resumed.stop();
  });

  it('reports every order that blocks live activation with its symbol, side, and reason', async () => {
    const { engine, runtime, gateway } = await createHarness();
    // Gate accepts the cancel requests but keeps reporting both orders open.
    gateway.holdCancellations = true;
    const first = await runtime.createOrder({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: '0.1', price: '100000' });
    const second = await runtime.createOrder({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', type: 'LIMIT', timeInForce: 'GTC', quantity: '0.2', price: '100100' });

    await expect(engine.prepareForLiveActivation()).rejects.toMatchObject({
      code: 'strategy_recovery_unresolved',
      statusCode: 409,
      details: {
        unresolvedOrders: expect.arrayContaining([
          expect.objectContaining({ id: first.id, remoteOrderId: 'remote-1', symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', quantity: '0.1', state: 'OPEN', reason: 'cancel_not_confirmed:OPEN' }),
          expect.objectContaining({ id: second.id, remoteOrderId: 'remote-2', symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', quantity: '0.2', reason: 'cancel_not_confirmed:OPEN' }),
        ]),
      },
    });

    // Once Gate honours the cancellations the very same activation goes through.
    gateway.holdCancellations = false;
    await expect(engine.prepareForLiveActivation()).resolves.toBeUndefined();
    expect(runtime.getOrder(first.id).state).toBe('CANCELLED');
    expect(runtime.getOrder(second.id).state).toBe('CANCELLED');
  });

  it('prevents persisted strategies from resuming after an account credential change', async () => {
    const { engine, runtime, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig, {
      profileId: 'account-primary',
      label: 'Primary Trading',
    });

    expect(record).toMatchObject({
      accountProfileId: 'account-primary',
      accountLabel: 'Primary Trading',
    });
    expect(engine.runningStrategiesForCredentialProfile('account-secondary')).toEqual([]);
    expect(engine.runningStrategiesForCredentialProfile('account-primary')).toEqual([
      expect.objectContaining({ id: record.id }),
    ]);
    expect(engine.pauseRunningStrategiesForCredentialChange('account-secondary')).toBe(0);
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');

    expect(engine.pauseRunningStrategiesForCredentialChange('account-primary')).toBe(1);
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');
    expect(engine.listActiveStrategyIds()).toEqual([]);
    engine.activatePersistedStrategies('account-primary');
    expect(engine.listActiveStrategyIds()).toEqual([]);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy paused', condition: 'Account credentials changed' }),
    ]));
  });
});

describe('recovered RUNNING strategies re-subscribe their leg markets', () => {
  it('registers and watches both leg symbols when activating a persisted strategy after restart', async () => {
    const { engine, runtime, database, markets } = await createHarness();
    const leftSymbol = 'BINANCE_FUTURE_BTC_USDT';
    const rightSymbol = 'OKX_FUTURE_BTC_USDT';
    markets.set(leftSymbol, '100150', '100151');
    markets.set(rightSymbol, '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig);
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    await engine.stop();

    // Simulate the restart: the market hub comes back with an empty in-memory table and nothing
    // watching the strategy's symbols any more.
    markets.remove(leftSymbol);
    markets.remove(rightSymbol);
    markets.watchQuotesCalls.length = 0;
    const ensured: string[] = [];
    markets.ensureHandler = (symbol) => {
      ensured.push(symbol);
      return true;
    };

    const rearmedSession = new TradingSession();
    rearmedSession.set('live');
    const recovered = new StrategyEngine(database, rearmedSession, runtime, markets, {
      tickIntervalMs: 20,
      orderTimeoutMs: 400,
    });
    recovered.activatePersistedStrategies();

    expect(recovered.listActiveStrategyIds()).toEqual([record.id]);
    // Both legs are registered with the hub...
    expect(ensured).toEqual(expect.arrayContaining([leftSymbol, rightSymbol]));
    // ...and subscribed for ticker frames as a single idempotent release.
    expect(markets.watchQuotesCalls).toEqual([[leftSymbol, rightSymbol]]);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'Strategy resumed',
        result: expect.stringContaining('leg quotes re-subscribed'),
      }),
    ]));

    await recovered.stop();
  });

  // G1: the close-plan recovery path used to register the targets with the hub but never subscribe
  // them, unlike the leg path above. A recovered close strategy then received no ticker frames, and
  // the first settlement slice threw `strategy_market_data_unavailable` because it had no price.
  it('G1 watches the close-plan targets and stays observable when recovering a persisted close strategy', async () => {
    const { engine, runtime, database, markets, gateway } = await createHarness();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    markets.set(symbol, '100000', '100001');
    gateway.positions = [futuresPosition(symbol, 'LONG', '0.1')];
    const record = await engine.startStrategy({
      kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'BINANCE',
      leftSide: 'SELL', rightSide: 'BUY', totalAmount: '0.1', perOrderQuantity: '0.03',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
      closePlan: {
        orderCount: 3,
        intervalSeconds: 5,
        targets: [{ symbol, side: 'SELL', quantity: '0.1', positionSide: 'NONE' }],
      },
    });
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    await engine.stop();

    // Restart: the hub comes back empty, so a close slice would have no price to size against.
    markets.remove(symbol);
    markets.watchQuotesCalls.length = 0;
    const ensured: string[] = [];
    markets.ensureHandler = (requested) => { ensured.push(requested); return true; };

    const rearmedSession = new TradingSession();
    rearmedSession.set('live');
    const recovered = new StrategyEngine(database, rearmedSession, runtime, markets, {
      tickIntervalMs: 20,
      orderTimeoutMs: 400,
    });
    recovered.activatePersistedStrategies();

    expect(recovered.listActiveStrategyIds()).toEqual([record.id]);
    // The target is re-registered with the hub…
    expect(ensured).toContain(symbol);
    // …and, mirroring start/resume, its ticker subscription is held for the strategy lifetime.
    expect(markets.watchQuotesCalls).toEqual([[symbol]]);
    // The recovery is observable in the log, not a silent attach.
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'Strategy resumed',
        result: expect.stringContaining('leg quotes re-subscribed'),
      }),
    ]));

    await recovered.stop();
  });

  // G2: `ensureActorMarkets` used to ignore `ensureMarket`'s return value. A symbol the hub could no
  // longer register left the recovered strategy attached but feed-less — a silent spin. It must now
  // surface that degradation instead of looking healthy while writing no rows.
  it('G2 reports an unavailable market instead of silently spinning when a symbol cannot be re-registered', async () => {
    const { engine, runtime, database, markets } = await createHarness();
    const leftSymbol = 'BINANCE_FUTURE_BTC_USDT';
    const rightSymbol = 'OKX_FUTURE_BTC_USDT';
    markets.set(leftSymbol, '100150', '100151');
    markets.set(rightSymbol, '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig);
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    await engine.stop();

    // Simulate the restart with a hub that can no longer register either symbol.
    markets.remove(leftSymbol);
    markets.remove(rightSymbol);
    markets.ensureHandler = () => false;

    const rearmedSession = new TradingSession();
    rearmedSession.set('live');
    const recovered = new StrategyEngine(database, rearmedSession, runtime, markets, {
      tickIntervalMs: 20,
      orderTimeoutMs: 400,
    });
    recovered.activatePersistedStrategies();

    const unavailable = runtime.strategyLogs(record.id).filter((log) => log.event === 'Strategy market unavailable');
    // One warning per unregisterable symbol, carrying the offending symbol in its condition.
    expect(unavailable.map((log) => log.condition)).toEqual(expect.arrayContaining([leftSymbol, rightSymbol]));
    expect(unavailable).toHaveLength(2);
    expect(unavailable.every((log) => log.level === 'warning')).toBe(true);
    // Recovery still completes — a missing feed is reported, never fatal.
    expect(recovered.listActiveStrategyIds()).toEqual([record.id]);

    await recovered.stop();
  });
});

/** Convenience wrapper: set a market with an explicit funding rate (defaults keep the old shape). */
function setMarketWithFunding(
  markets: StubMarkets,
  symbol: string,
  bid: string,
  ask: string,
  fundingRate = '0.0001',
  nextFundingAt?: string,
): void {
  const now = new Date().toISOString();
  markets.set(symbol, bid, ask, now, now, fundingRate, nextFundingAt);
}

describe('auto signed thresholds and funding carry strategies', () => {
  const spotFutureAutoConfig = {
    kind: 'auto', asset: 'BTC', leftVenue: 'GATE', rightVenue: 'GATE',
    leftSide: 'BUY', rightSide: 'SELL',
    leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'GATE_FUTURE_BTC_USDT',
    entryBps: '10', takeProfitBps: '2', maxPosition: '0.1', perOrderQuantity: '0.1',
    reduceOnly: false, executionMethod: 'TAKER_TAKER',
  } as const;

  const carryConfig = {
    kind: 'carry', asset: 'BTC', leftVenue: 'GATE', rightVenue: 'GATE',
    leftSide: 'BUY', rightSide: 'SELL',
    leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'GATE_FUTURE_BTC_USDT',
    fundingDirection: 'POSITIVE', fundingAprMin: 15, basisTakeProfitBps: 5,
    totalAmount: '0.1', perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
  } as const;

  it('opens a same-venue auto position across a Gate spot and future leg with quote-sized spot buys', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    // Entry spread: perp bid 100195 − spot ask 100005 ≈ 19 bps ≥ 10 bps entry.
    markets.set('GATE_SPOT_BTC_USDT', '99995', '100005');
    markets.set('GATE_FUTURE_BTC_USDT', '100195', '100205');
    const record = await engine.startStrategy(spotFutureAutoConfig);
    expect(record.status).toBe('RUNNING');
    // Only the perpetual leg touches the leverage layer; the spot leg is full-cash.
    expect(gateway.leverageUpdates).toEqual([{ symbol: 'GATE_FUTURE_BTC_USDT', leverage: '1' }]);

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [spotOrder, perpOrder] = gateway.createdOrders;
    // The spot market buy is sized in quote currency at the spot mid (100000 × 0.1).
    expect(spotOrder).toMatchObject({
      symbol: 'GATE_SPOT_BTC_USDT', side: 'BUY', type: 'MARKET', time_in_force: 'IOC',
      quote_qty: '10000', reduce_only: 'false',
    });
    expect(perpOrder).toMatchObject({
      symbol: 'GATE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', time_in_force: 'IOC',
      qty: '0.1', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100005');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100195');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');

    // Spread regression: exit spread = (perp ask − spot bid)/spot bid ≈ 1.0 bps ≤ 2 bps.
    markets.set('GATE_FUTURE_BTC_USDT', '100000', '100005');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'GATE_SPOT_BTC_USDT')).toMatchObject({ side: 'SELL', reduce_only: 'true' });
    expect(exits.find((order) => order.symbol === 'GATE_FUTURE_BTC_USDT')).toMatchObject({ side: 'BUY', reduce_only: 'true' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100005');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100005');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0');
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('enters an auto position on a negative entry threshold and closes it when the spread regresses', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    // Spread = OKX bid 100099 − BINANCE ask 100151 ≈ −5.19 bps ≤ −5 → enter at a bounded cost.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '100099', '100100');
    const record = await engine.startStrategy({
      kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
      leftSide: 'BUY', rightSide: 'SELL', entryBps: '-5', takeProfitBps: '2',
      maxPosition: '0.1', perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[0]).toMatchObject({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', qty: '0.1' });
    expect(gateway.createdOrders[1]).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', qty: '0.1' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100151');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100099');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');

    // Spread regresses to ≈ 0.1 bps ≤ 2 → reduce-only exit of the bounded-cost position.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100100', '100101');
    markets.set('OKX_FUTURE_BTC_USDT', '100100', '100101');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'BINANCE_FUTURE_BTC_USDT')).toMatchObject({ side: 'SELL', reduce_only: 'true' });
    expect(exits.find((order) => order.symbol === 'OKX_FUTURE_BTC_USDT')).toMatchObject({ side: 'BUY', reduce_only: 'true' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100100');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100100');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0');
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  // Entry at 20 bps must sit strictly between entryBps (10) and stopLossBps (30), or the fixture
  // would either never open or stop out on the very next tick. Widening to 40 bps is genuinely
  // adverse for a positive entry (the trade profits on convergence), so the stop must fire there
  // while convergence toward 0 must never trigger it.
  it('closes both legs and stops the auto strategy when the stop-loss threshold is hit', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    // entrySpread = (100200 − 100000)/100000 = 20 bps → ≥ entryBps 10, < stopLossBps 30.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100200', '100201');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
      entryBps: '10', takeProfitBps: '2', stopLossBps: 30, maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100200');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');

    // Adverse move: spread = (100400 − 100000)/100000 = 40 bps ≥ 30 bps stop-loss.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100400', '100401');
    const stopTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'BINANCE_FUTURE_BTC_USDT')).toMatchObject({ side: 'BUY', type: 'MARKET', reduce_only: 'true' });
    expect(exits.find((order) => order.symbol === 'OKX_FUTURE_BTC_USDT')).toMatchObject({ side: 'SELL', type: 'MARKET', reduce_only: 'true' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100401');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await stopTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'STOPPED');
    expect(engine.listActiveStrategyIds()).not.toContain(record.id);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Stop-loss triggered')).toBe(true);
    // C2: the stop-loss unwind must not masquerade as a take-profit exit.
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Stop-loss exit triggered')).toBe(true);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Stop-loss Executed')).toBe(true);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Take-profit triggered')).toBe(false);
    // A stopped strategy must not trade again.
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(4);
  });

  it('never turns a convergent move into a stop-loss exit', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    // Same coherent setup: enter at 20 bps (entryBps 10 < 20 < stopLossBps 30).
    markets.set('BINANCE_FUTURE_BTC_USDT', '100200', '100201');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
      entryBps: '10', takeProfitBps: '2', stopLossBps: 30, maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100200');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');

    // Convergence: 20 bps → 5 bps is profit for this direction, still above takeProfitBps 2.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100050', '100051');
    await engine.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    expect(runtime.getStrategy(record.id).openPosition).toBe('0.1');
    expect(gateway.createdOrders).toHaveLength(2);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Stop-loss triggered')).toBe(false);
  });

  it('rejects same-venue auto strategies that pair two futures markets', async () => {
    const { engine } = await createHarness();
    await expect(engine.startStrategy({
      kind: 'auto', asset: 'BTC', leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryBps: '10', takeProfitBps: '2', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('tops up a partially filled leg instead of leaving a hedged imbalance', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig);

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.06', '100000');
    await entryTick;

    // Imbalance 0.04: the lagging right leg is topped up with a 0.04 market buy.
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.04', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.04', '100000');
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.1');
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('holds a carry strategy flat while the funding APR is below the configured minimum', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    // 0.0001 × 3 × 365 × 100 = 10.95% APR < 15% minimum.
    markets.set('GATE_SPOT_BTC_USDT', '99995', '100005');
    markets.set('GATE_FUTURE_BTC_USDT', '100195', '100205');
    const record = await engine.startStrategy(carryConfig);

    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Waiting for funding threshold')).toBe(true);
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('blocks a positive carry entry when spot USDT cannot cover the full notional plus margin', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'GATE_FUTURE_BTC_USDT', '100195', '100205', '0.001');
    gateway.spotAccounts = [{ currency: 'USDT', available: '100', locked: '0' }];
    const record = await engine.startStrategy(carryConfig);

    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Carry entry gate blocked')).toBe(true);
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('opens a positive carry with a quote-sized spot buy and a perp short after the gate passes', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'GATE_FUTURE_BTC_USDT', '100195', '100205', '0.001');
    gateway.spotAccounts = [{ currency: 'USDT', available: '1000000', locked: '0' }];
    const record = await engine.startStrategy(carryConfig);
    expect(record.id.startsWith('CARRY-')).toBe(true);
    // Carry must never touch the account leverage preset.
    expect(gateway.leverageUpdates).toHaveLength(0);

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [spotOrder, perpOrder] = gateway.createdOrders;
    expect(spotOrder).toMatchObject({ symbol: 'GATE_SPOT_BTC_USDT', side: 'BUY', type: 'MARKET', quote_qty: '10000' });
    expect(perpOrder).toMatchObject({ symbol: 'GATE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.1' });
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Carry entry gate passed')).toBe(true);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100005');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100195');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');
  });

  it('blocks a negative carry entry when the spot inventory is below the configured amount', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'GATE_FUTURE_BTC_USDT', '100195', '100205', '-0.001');
    gateway.spotAccounts = [
      { currency: 'USDT', available: '1000000', locked: '0' },
      { currency: 'BTC', available: '0.05', locked: '0' },
    ];
    const record = await engine.startStrategy({
      ...carryConfig, fundingDirection: 'NEGATIVE', leftSide: 'SELL', rightSide: 'BUY', inventoryCheck: true,
    });

    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Carry entry gate blocked')).toBe(true);
  });

  it('opens a negative carry by selling spot inventory and buying the perpetual', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'GATE_FUTURE_BTC_USDT', '100195', '100205', '-0.001');
    gateway.spotAccounts = [
      { currency: 'USDT', available: '1000000', locked: '0' },
      { currency: 'BTC', available: '0.2', locked: '0' },
    ];
    const record = await engine.startStrategy({
      ...carryConfig, fundingDirection: 'NEGATIVE', leftSide: 'SELL', rightSide: 'BUY', inventoryCheck: true,
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [spotOrder, perpOrder] = gateway.createdOrders;
    // A spot market SELL is sized in base quantity — no quote conversion.
    expect(spotOrder).toMatchObject({ symbol: 'GATE_SPOT_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.1' });
    expect(spotOrder.quote_qty).toBeUndefined();
    expect(perpOrder).toMatchObject({ symbol: 'GATE_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.1' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '99995');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100195');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');
  });

  it('accrues funding at each settlement while the carry position is open', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, markets } = await createHarness({ now: () => now });
    const timestamp = new Date(now).toISOString();
    const nextSettlement = new Date(now + 8 * 3_600_000).toISOString();
    markets.set('GATE_SPOT_BTC_USDT', '99995', '100005', timestamp, timestamp);
    markets.set('GATE_FUTURE_BTC_USDT', '100195', '100205', timestamp, timestamp, '0.001', nextSettlement);
    gateway.spotAccounts = [{ currency: 'USDT', available: '1000000', locked: '0' }];
    const record = await engine.startStrategy(carryConfig);

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100005');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100195');
    await entryTick;

    // The latch tick records the entry reference metrics and arms the accrual clock.
    await engine.tick();
    let metrics = runtime.getStrategy(record.id).carryMetrics;
    expect(metrics).not.toBeNull();
    expect(Number(metrics?.entryFundingApr)).toBeCloseTo(109.5, 6);
    expect(Number(metrics?.basisEntryBps)).toBeCloseTo(20, 6);
    expect(Number(metrics?.fundingCollectedUsdt)).toBeCloseTo(0, 9);

    // Cross the settlement: one period of |rate| × perp notional is collected (0.001 × 0.1 × 100200).
    now += 8 * 3_600_000 + 1_000;
    const refreshed = new Date(now).toISOString();
    markets.set('GATE_SPOT_BTC_USDT', '99995', '100005', refreshed, refreshed);
    markets.set('GATE_FUTURE_BTC_USDT', '100195', '100205', refreshed, refreshed, '0.001', nextSettlement);
    await engine.tick();

    metrics = runtime.getStrategy(record.id).carryMetrics;
    expect(Number(metrics?.fundingCollectedUsdt)).toBeCloseTo(10.02, 6);
    expect(metrics?.nextFundingAccrualAt).not.toBeNull();
    expect(Date.parse(metrics?.nextFundingAccrualAt ?? '')).toBeGreaterThan(now);
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    expect(gateway.createdOrders).toHaveLength(2);
  });

  it('closes both carry legs on basis take-profit and reports net PnL as funding + basis − fees', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'GATE_FUTURE_BTC_USDT', '100195', '100205', '0.001');
    gateway.spotAccounts = [{ currency: 'USDT', available: '1000000', locked: '0' }];
    const record = await engine.startStrategy(carryConfig);

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100005');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100195');
    ingestFill(runtime, 'remote-1', 'GATE_SPOT_BTC_USDT', 'BUY', '0.1', '100005');
    ingestFill(runtime, 'remote-2', 'GATE_FUTURE_BTC_USDT', 'SELL', '0.1', '100195');
    await entryTick;
    await engine.tick(); // latch the entry reference metrics

    // Basis collapses from 20 bps to 0: perp bid 100005 = spot ask 100005 ≤ 5 bps take-profit.
    setMarketWithFunding(markets, 'GATE_FUTURE_BTC_USDT', '100005', '100015', '0.001');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'GATE_SPOT_BTC_USDT')).toMatchObject({ side: 'SELL', reduce_only: 'true' });
    expect(exits.find((order) => order.symbol === 'GATE_FUTURE_BTC_USDT')).toMatchObject({ side: 'BUY', reduce_only: 'true' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100005');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100005');
    ingestFill(runtime, 'remote-3', 'GATE_SPOT_BTC_USDT', 'SELL', '0.1', '100005');
    ingestFill(runtime, 'remote-4', 'GATE_FUTURE_BTC_USDT', 'BUY', '0.1', '100005');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    const metrics = runtime.getStrategy(record.id).carryMetrics;
    expect(Number(metrics?.basisEntryBps)).toBeCloseTo(20, 6);
    expect(Number(metrics?.basisCurrentBps)).toBeCloseTo(0, 6);
    expect(Number(metrics?.basisPnlUsdt)).toBeCloseTo(20, 6);
    expect(Number(metrics?.feesPaidUsdt)).toBeCloseTo(0.04, 6);
    expect(Number(metrics?.netPnlUsdt)).toBeCloseTo(19.96, 6);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Basis take-profit triggered' }),
      expect.objectContaining({ event: 'Strategy completed' }),
    ]));
    expect(engine.listActiveStrategyIds()).not.toContain(record.id);
  });

  it('rejects invalid carry configurations at the schema boundary', async () => {
    const { engine, runtime } = await createHarness();
    // carry must not carry an entry threshold.
    await expect(engine.startStrategy({ ...carryConfig, entryBps: '10' })).rejects.toMatchObject({ name: 'ZodError' });
    // Selling spot inventory without holding it requires the inventory check.
    await expect(engine.startStrategy({
      ...carryConfig, fundingDirection: 'NEGATIVE', leftSide: 'SELL', rightSide: 'BUY',
    })).rejects.toMatchObject({ name: 'ZodError' });
    // The left symbol must belong to the left venue (multi-venue spot legs, b-plan).
    await expect(engine.startStrategy({ ...carryConfig, leftSymbol: 'BINANCE_SPOT_BTC_USDT' }))
      .rejects.toMatchObject({ name: 'ZodError' });
    expect(runtime.listStrategies()).toHaveLength(0);
  });

  it('repairs a carry entry whose perpetual leg failed to submit', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'GATE_FUTURE_BTC_USDT', '100195', '100205', '0.001');
    gateway.spotAccounts = [{ currency: 'USDT', available: '1000000', locked: '0' }];
    gateway.failCreate('GATE_FUTURE_BTC_USDT', 1);
    const record = await engine.startStrategy(carryConfig);

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({ symbol: 'GATE_SPOT_BTC_USDT', side: 'BUY', quote_qty: '10000' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100005');
    await entryTick;

    // The hedge repair tops up the lagging perpetual leg with a full 0.1 short.
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({
      symbol: 'GATE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.1', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100195');
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.1');
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Hedging filled quantity')).toBe(true);
  });

  // ─── QA acceptance supplements (increment-3 independent verification) ───

  it('QA supplement: opens a positive carry with a BINANCE spot leg, sizing the buy in quote currency', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'GATE_FUTURE_BTC_USDT', '100195', '100205', '0.001');
    gateway.spotAccounts = [{ currency: 'USDT', available: '1000000', locked: '0' }];
    const record = await engine.startStrategy({
      ...carryConfig, leftVenue: 'BINANCE', leftSymbol: 'BINANCE_SPOT_BTC_USDT',
    });
    expect(record.id.startsWith('CARRY-')).toBe(true);

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [spotOrder, perpOrder] = gateway.createdOrders;
    // The BINANCE spot market buy is sized in quote currency at the spot mid (100000 × 0.1).
    expect(spotOrder).toMatchObject({ symbol: 'BINANCE_SPOT_BTC_USDT', side: 'BUY', type: 'MARKET', quote_qty: '10000' });
    expect(perpOrder).toMatchObject({ symbol: 'GATE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.1' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100005');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100195');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');
  });

  it('QA supplement: a negative carry with a BINANCE spot leg must not clear its inventory check against the Gate spot account', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'GATE_FUTURE_BTC_USDT', '100195', '100205', '-0.001');
    // TradingRuntime.querySpotAccounts() calls the Gate-only /spot/accounts endpoint, so these
    // balances describe the GATE spot account. The user's BINANCE-side inventory is invisible to
    // this call: a per-venue inventory gate can never pass (nor fail) on this data. The carry
    // gate must therefore block the entry instead of treating Gate inventory as BINANCE inventory.
    gateway.spotAccounts = [
      { currency: 'USDT', available: '1000000', locked: '0' },
      { currency: 'BTC', available: '0.2', locked: '0' },
    ];
    const record = await engine.startStrategy({
      ...carryConfig, leftVenue: 'BINANCE', leftSymbol: 'BINANCE_SPOT_BTC_USDT',
      fundingDirection: 'NEGATIVE', leftSide: 'SELL', rightSide: 'BUY', inventoryCheck: true,
    });

    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Carry entry gate blocked')).toBe(true);
  });

  it('QA supplement round 2: a positive carry with a BINANCE spot leg is blocked when the reported venue USDT balance cannot cover the spot notional', async () => {
    const { engine, runtime, gateway, database, markets } = await createHarness();
    markets.set('BINANCE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'GATE_FUTURE_BTC_USDT', '100195', '100205', '0.001');
    gateway.spotAccounts = [{ currency: 'USDT', available: '1000000', locked: '0' }];
    // Reconciled BINANCE balance far below the spot notional (0.1 × ~100005).
    database.prepare(`INSERT INTO live_balances (venue, coin, balance, available_balance, equity, unrealized_pnl, updated_at)
      VALUES ('BINANCE', 'USDT', '1000', '1000', '1000', '0', ?)`).run(new Date().toISOString());
    const record = await engine.startStrategy({
      ...carryConfig, leftVenue: 'BINANCE', leftSymbol: 'BINANCE_SPOT_BTC_USDT',
    });

    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Carry entry gate blocked')).toBe(true);
  });

  // ─── c-plan: cross-venue carry (architecture v2) ───

  it('opens a cross-venue positive carry (BINANCE spot × OKX perpetual) gated on each venue balance', async () => {
    const { engine, runtime, gateway, database, markets } = await createHarness();
    markets.set('BINANCE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'OKX_FUTURE_BTC_USDT', '100195', '100205', '0.001');
    // Neither leg sits on Gate: both sides of the gate route through the reconciled live
    // balances instead of the Gate-only /spot/accounts endpoint (left empty on purpose).
    const insert = database.prepare(`INSERT INTO live_balances (venue, coin, balance, available_balance, equity, unrealized_pnl, updated_at)
      VALUES (?, ?, '1000000', '1000000', '1000000', '0', ?)`);
    const now = new Date().toISOString();
    insert.run('BINANCE', 'USDT', now);
    insert.run('OKX', 'USDT', now);
    const record = await engine.startStrategy({
      ...carryConfig,
      leftVenue: 'BINANCE', leftSymbol: 'BINANCE_SPOT_BTC_USDT',
      rightVenue: 'OKX', rightSymbol: 'OKX_FUTURE_BTC_USDT',
    });
    expect(record.id.startsWith('CARRY-')).toBe(true);
    expect(gateway.leverageUpdates).toHaveLength(0);

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [spotOrder, perpOrder] = gateway.createdOrders;
    expect(spotOrder).toMatchObject({ symbol: 'BINANCE_SPOT_BTC_USDT', side: 'BUY', type: 'MARKET', quote_qty: '10000' });
    expect(perpOrder).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.1' });
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Carry entry gate passed')).toBe(true);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100005');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100195');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');
  });

  it('blocks a cross-venue positive carry when the perpetual venue margin balance is insufficient', async () => {
    const { engine, runtime, gateway, database, markets } = await createHarness();
    markets.set('BINANCE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'OKX_FUTURE_BTC_USDT', '100195', '100205', '0.001');
    const insert = database.prepare(`INSERT INTO live_balances (venue, coin, balance, available_balance, equity, unrealized_pnl, updated_at)
      VALUES (?, ?, ?, ?, ?, '0', ?)`);
    const now = new Date().toISOString();
    // The spot notional (0.1 × ~100005) is covered, but the OKX margin (0.1 × ~100200) is not.
    insert.run('BINANCE', 'USDT', '1000000', '1000000', '1000000', now);
    insert.run('OKX', 'USDT', '1000', '1000', '1000', now);
    const record = await engine.startStrategy({
      ...carryConfig,
      leftVenue: 'BINANCE', leftSymbol: 'BINANCE_SPOT_BTC_USDT',
      rightVenue: 'OKX', rightSymbol: 'OKX_FUTURE_BTC_USDT',
    });

    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Carry entry gate blocked')).toBe(true);
  });

  it('annualizes funding with the venue settlement interval and accrues on a 4h clock', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({
      now: () => now,
      fundingIntervalHours: () => 4,
    });
    const timestamp = new Date(now).toISOString();
    const nextSettlement = new Date(now + 4 * 3_600_000).toISOString();
    markets.set('BINANCE_SPOT_BTC_USDT', '99995', '100005', timestamp, timestamp);
    setMarketWithFunding(markets, 'OKX_FUTURE_BTC_USDT', '100195', '100205', '0.0001', nextSettlement);
    markets.set('OKX_FUTURE_BTC_USDT', '100195', '100205', timestamp, timestamp, '0.0001', nextSettlement);
    const insert = database.prepare(`INSERT INTO live_balances (venue, coin, balance, available_balance, equity, unrealized_pnl, updated_at)
      VALUES (?, ?, '1000000', '1000000', '1000000', '0', ?)`);
    insert.run('BINANCE', 'USDT', timestamp);
    insert.run('OKX', 'USDT', timestamp);
    const record = await engine.startStrategy({
      ...carryConfig,
      leftVenue: 'BINANCE', leftSymbol: 'BINANCE_SPOT_BTC_USDT',
      rightVenue: 'OKX', rightSymbol: 'OKX_FUTURE_BTC_USDT',
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100005');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100195');
    await entryTick;
    // Latch tick: 0.0001 × (24/4) × 365 × 100 = 21.9% APR on the 4h venue cadence.
    await engine.tick();
    let metrics = runtime.getStrategy(record.id).carryMetrics;
    expect(Number(metrics?.entryFundingApr)).toBeCloseTo(21.9, 6);

    // Cross the 4h settlement: one period of |rate| × perp notional (0.0001 × 0.1 × 100200).
    now += 4 * 3_600_000 + 1_000;
    const refreshed = new Date(now).toISOString();
    markets.set('BINANCE_SPOT_BTC_USDT', '99995', '100005', refreshed, refreshed);
    markets.set('OKX_FUTURE_BTC_USDT', '100195', '100205', refreshed, refreshed, '0.0001', nextSettlement);
    await engine.tick();

    metrics = runtime.getStrategy(record.id).carryMetrics;
    expect(Number(metrics?.fundingCollectedUsdt)).toBeCloseTo(1.002, 6);
    expect(Date.parse(metrics?.nextFundingAccrualAt ?? '')).toBeGreaterThan(now);
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('warns once and falls back to the 8h cadence when the venue funding interval is unknown', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'OKX_FUTURE_BTC_USDT', '100195', '100205', '0.0001');
    const record = await engine.startStrategy({
      ...carryConfig,
      leftVenue: 'BINANCE', leftSymbol: 'BINANCE_SPOT_BTC_USDT',
      rightVenue: 'OKX', rightSymbol: 'OKX_FUTURE_BTC_USDT',
    });

    // 0.0001 on the 8h fallback = 10.95% APR < 15% minimum, so the entry stays flat.
    await engine.tick();
    await engine.tick();
    const warningCount = runtime.strategyLogs(record.id)
      .filter((log) => log.event === 'Funding interval unknown').length;
    expect(warningCount).toBe(1);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Waiting for funding threshold')).toBe(true);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('QA supplement v2: a cross-venue negative carry (BINANCE spot + OKX perp) verifies inventory on the spot venue and opens both legs', async () => {
    const { engine, runtime, gateway, database, markets } = await createHarness();
    markets.set('BINANCE_SPOT_BTC_USDT', '99995', '100005');
    setMarketWithFunding(markets, 'OKX_FUTURE_BTC_USDT', '100195', '100205', '-0.001');
    // Reconciled BINANCE inventory covers the configured amount (0.1 BTC).
    database.prepare(`INSERT INTO live_balances (venue, coin, balance, available_balance, equity, unrealized_pnl, updated_at)
      VALUES ('BINANCE', 'BTC', '0.2', '0.2', '0.2', '0', ?)`).run(new Date().toISOString());
    const record = await engine.startStrategy({
      ...carryConfig, leftVenue: 'BINANCE', leftSymbol: 'BINANCE_SPOT_BTC_USDT',
      rightVenue: 'OKX', rightSymbol: 'OKX_FUTURE_BTC_USDT',
      fundingDirection: 'NEGATIVE', leftSide: 'SELL', rightSide: 'BUY', inventoryCheck: true,
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [spotOrder, perpOrder] = gateway.createdOrders;
    // Spot market SELL is sized in base quantity on BINANCE; the perp BUY routes to OKX.
    expect(spotOrder).toMatchObject({ symbol: 'BINANCE_SPOT_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.1' });
    expect(perpOrder).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.1' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '99995');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100195');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');
  });

  describe('auto stop-loss gate and laddered add-ons', () => {
    // Shared ladder fixture: entry 50 bps, add one clip every 20 bps of further widening, with the
    // absolute stop at 100 bps. Tiers reachable below the stop line are 50 / 70 / 90 bps.
    const ladderConfig = {
      kind: 'auto' as const, asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
      leftSide: 'SELL' as const, rightSide: 'BUY' as const,
      entryBps: '50', takeProfitBps: '2', stopLossBps: 100,
      maxPosition: '0.3', perOrderQuantity: '0.1', reduceOnly: false,
      executionMethod: 'TAKER_TAKER' as const, addOnStepBps: 20,
    };

    /** entrySpread = (sellBid − buyAsk)/buyAsk; buyAsk is pinned at 100000 so 1 bps = 10 units. */
    function setSpread(markets: StubMarkets, bps: number): void {
      markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
      const bid = new Decimal(100000).mul(new Decimal(1).plus(new Decimal(bps).div(10_000))).toString();
      const ask = new Decimal(bid).plus(1).toString();
      markets.set('BINANCE_FUTURE_BTC_USDT', bid, ask);
    }

    /** Runs one tick and acknowledges the two taker legs it submitted, leaving one filled clip. */
    async function fillClip(
      engine: StrategyEngine,
      runtime: TradingRuntime,
      gateway: ScriptedGateway,
      expectedOrders: number,
    ): Promise<void> {
      const tick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === expectedOrders + 2);
      ackOrder(runtime, `remote-${expectedOrders + 1}`, 'FILLED', '0.1', '100000');
      ackOrder(runtime, `remote-${expectedOrders + 2}`, 'FILLED', '0.1', '100000');
      await tick;
    }

    function clipCount(gateway: ScriptedGateway): number {
      return gateway.createdOrders.filter((order) => order.type === 'MARKET' && order.reduce_only === 'false').length / 2;
    }

    it('adds exactly one clip per tier and never two clips in the same tick', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      setSpread(markets, 50);
      await engine.startStrategy(ladderConfig);

      // Tier 0 (50 bps): one clip.
      await fillClip(engine, runtime, gateway, 0);
      expect(clipCount(gateway)).toBe(1);

      // Same tier, same price: repeating the tick must not add anything.
      await engine.tick();
      expect(clipCount(gateway)).toBe(1);

      // Tier 1 boundary (70 bps): exactly one more clip.
      setSpread(markets, 70);
      await fillClip(engine, runtime, gateway, 2);
      expect(clipCount(gateway)).toBe(2);
      await engine.tick();
      expect(clipCount(gateway)).toBe(2);

      // Tier 2 boundary (90 bps): one more clip, reaching maxPosition.
      setSpread(markets, 90);
      await fillClip(engine, runtime, gateway, 4);
      expect(clipCount(gateway)).toBe(3);
      await engine.tick();
      expect(clipCount(gateway)).toBe(3);
    });

    it('refuses an add-on until the spread advances a full step', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      setSpread(markets, 50);
      await engine.startStrategy(ladderConfig);
      await fillClip(engine, runtime, gateway, 0);
      expect(clipCount(gateway)).toBe(1);

      // 69 bps is still tier 0 → floor((69−50)/20) = 0 → no second clip.
      setSpread(markets, 69);
      await engine.tick();
      expect(clipCount(gateway)).toBe(1);

      // 70 bps reaches tier 1.
      setSpread(markets, 70);
      await engine.tick();
      await waitFor(() => gateway.createdOrders.length === 4);
      expect(clipCount(gateway)).toBe(2);
    });

    it('stops the ladder at the stop line and lets the stop win the same tick', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      setSpread(markets, 50);
      const record = await engine.startStrategy(ladderConfig);
      await fillClip(engine, runtime, gateway, 0);
      expect(clipCount(gateway)).toBe(1);

      // Jump straight past the stop line: the stop arms and unwinds before the entry branch runs,
      // so no further add-on can be placed (§8.2 tick ordering).
      setSpread(markets, 100);
      const stopTick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === 4);
      expect(clipCount(gateway)).toBe(1);
      expect(gateway.createdOrders.slice(2)).toHaveLength(2);
      expect(gateway.createdOrders.slice(2).every((order) => order.reduce_only === 'true')).toBe(true);
      ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100000');
      ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
      await stopTick;
      await waitFor(() => runtime.getStrategy(record.id).status === 'STOPPED');
      expect(clipCount(gateway)).toBe(1);
    });

    it('keeps tick-driven accumulation when addOnStepBps is absent', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      setSpread(markets, 50);
      const { addOnStepBps: _omitted, ...withoutLadder } = ladderConfig;
      await engine.startStrategy(withoutLadder);

      // Unchanged behaviour: one clip per evaluation whenever the entry holds and capacity remains.
      await fillClip(engine, runtime, gateway, 0);
      await fillClip(engine, runtime, gateway, 2);
      await fillClip(engine, runtime, gateway, 4);
      expect(clipCount(gateway)).toBe(3);
      await engine.tick();
      expect(clipCount(gateway)).toBe(3);
      expect(runtime.getStrategy(engine.listActiveStrategyIds()[0] ?? '').status).toBe('RUNNING');
    });

    it('reports the tier in the add-on condition without inventing a new event', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      setSpread(markets, 50);
      const record = await engine.startStrategy(ladderConfig);
      await fillClip(engine, runtime, gateway, 0);
      setSpread(markets, 70);
      await fillClip(engine, runtime, gateway, 2);

      const events = new Set(runtime.strategyLogs(record.id).map((log) => log.event));
      expect(events.has('Entry triggered')).toBe(true);
      expect(events.has('Position open Executed')).toBe(true);
      // Tier details ride in the condition; no new event names are registered for add-ons.
      expect(runtime.strategyLogs(record.id).some((log) => /Add-on tier 2 ·/.test(log.condition))).toBe(true);
    });

    it('refuses to enter while the spread already breaches the stop-loss line', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      // 50 bps ≥ stopLossBps 30 with entryBps 10: the adverse side is breached before any position.
      setSpread(markets, 50);
      const record = await engine.startStrategy({
        kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
        entryBps: '10', takeProfitBps: '2', stopLossBps: 30, maxPosition: '0.1', perOrderQuantity: '0.1',
        reduceOnly: false, executionMethod: 'TAKER_TAKER',
      });

      await engine.tick();
      expect(gateway.createdOrders).toHaveLength(0);
      expect(runtime.getStrategy(record.id).openPosition).toBe('0');
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');

      // Below the stop line the same strategy opens normally.
      setSpread(markets, 20);
      const entryTick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === 2);
      ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100000');
      ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
      await entryTick;
      await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');
    });

    it('refuses auto configs whose stop-loss leaves no room above the entry level', async () => {
      const { engine, markets } = await createHarness();
      setSpread(markets, 20);
      const base = {
        kind: 'auto' as const, asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
        leftSide: 'SELL' as const, rightSide: 'BUY' as const, takeProfitBps: '2',
        maxPosition: '0.1', perOrderQuantity: '0.1', reduceOnly: false,
        executionMethod: 'TAKER_TAKER' as const,
      };
      // stopLossBps 10 <= |entryBps| 10 ⇒ zero headroom.
      await expect(engine.startStrategy({ ...base, entryBps: '10', stopLossBps: 10 }))
        .rejects.toMatchObject({ code: 'stop_loss_not_above_entry' });
      // Mirror branch: stopLossBps 6 <= |−6|.
      await expect(engine.startStrategy({ ...base, entryBps: '-6', stopLossBps: 6 }))
        .rejects.toMatchObject({ code: 'stop_loss_not_above_entry' });
      // Valid configs still start (30 > |10|).
      await expect(engine.startStrategy({ ...base, entryBps: '10', stopLossBps: 30 }))
        .resolves.toMatchObject({ status: 'RUNNING' });
    });

    it('rejects a ladder whose first tier sits at or beyond the stop-loss line', async () => {
      const { engine, markets } = await createHarness();
      setSpread(markets, 50);
      // |50| + 60 = 110 >= stopLossBps 100 ⇒ the first add-on tier is unreachable.
      await expect(engine.startStrategy({
        ...ladderConfig, addOnStepBps: 60,
      })).rejects.toMatchObject({ code: 'add_on_step_beyond_stop_loss' });
      // The same ladder step is accepted for MAKER_TAKER: no execution-method rejection.
      await expect(engine.startStrategy({
        ...ladderConfig, executionMethod: 'MAKER_TAKER', makerLeg: 'left',
      })).resolves.toMatchObject({ status: 'RUNNING' });
    });

    it('honours the negative entry branch for the gate and the stop', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      // Negative entry: left is BUY (BINANCE ask 100000), right is SELL (OKX bid).
      // spread = (OKX bid − BINANCE ask)/BINANCE ask; 1 bps = 10 price units at 100000.
      // adverse = spread ≤ −30 bps (the opening cost widens past the stop).
      markets.set('BINANCE_FUTURE_BTC_USDT', '99999', '100000');
      markets.set('OKX_FUTURE_BTC_USDT', '99700', '99701');
      const record = await engine.startStrategy({
        kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'BUY', rightSide: 'SELL',
        entryBps: '-6', takeProfitBps: '2', stopLossBps: 30, maxPosition: '0.1', perOrderQuantity: '0.1',
        reduceOnly: false, executionMethod: 'TAKER_TAKER',
      });

      // −30 bps is already at the stop line → entry refused.
      await engine.tick();
      expect(gateway.createdOrders).toHaveLength(0);

      // Enter at −10 bps (bounded cost, below the stop line).
      markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
      const entryTick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === 2);
      ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100000');
      ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '99900');
      await entryTick;
      await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');

      // Widen past the stop: −40 bps ≤ −30 bps.
      markets.set('OKX_FUTURE_BTC_USDT', '99600', '99601');
      await engine.tick();
      await waitFor(() => gateway.createdOrders.length === 4);
      expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Stop-loss triggered')).toBe(true);
    });
  });

  describe('auto maker entry gate and sequential maker ladder', () => {
    const makerLadderConfig = {
      kind: 'auto' as const, asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
      leftSide: 'SELL' as const, rightSide: 'BUY' as const,
      entryBps: '50', takeProfitBps: '2', stopLossBps: 100,
      maxPosition: '0.5', perOrderQuantity: '0.1', reduceOnly: false,
      executionMethod: 'MAKER_TAKER' as const, makerLeg: 'left' as const, addOnStepBps: 20,
    };

    /** The maker leg (BINANCE SELL) is priced from the OKX ask; keep it below every tier boundary. */
    function setMakerBooks(markets: StubMarkets, takerAsk = '100000'): void {
      markets.set('OKX_FUTURE_BTC_USDT', '99999', takerAsk);
      markets.set('BINANCE_FUTURE_BTC_USDT', '100300', '100301');
    }

    function entryQuotes(gateway: ScriptedGateway) {
      return gateway.createdOrders.filter((order) => order.symbol === 'BINANCE_FUTURE_BTC_USDT'
        && order.side === 'SELL' && order.type === 'LIMIT' && order.time_in_force === 'POC');
    }

    function hedgeOrders(gateway: ScriptedGateway) {
      return gateway.createdOrders.filter((order) => order.symbol === 'OKX_FUTURE_BTC_USDT' && order.type === 'MARKET');
    }

    /**
     * Fills the resting maker quote and its taker hedge, completing exactly one clip, then re-evaluates.
     *
     * The explicit `tick()` is required, not cosmetic: `afterExecutionChange` only hedges, persists
     * and checks completion — quoting happens exclusively inside `evaluate()` →
     * `evaluateMakerQuotes()`. In production `StrategyEngine.start()` (app.ts:1331) installs a
     * 500ms timer that drives those ticks; this harness never calls `start()`, so a new quote is
     * only ever produced by an explicit tick. The settle delay clears the shared
     * `requoteIntervalMs / 2` quote throttle so the replacement is not skipped.
     *
     * Each await counts *new* orders (previous clips leave filled hedges behind), so the helper can
     * never satisfy itself with a stale one. Whether a fresh entry quote follows is left to the
     * caller: the tier-capped case must assert that one does *not* appear.
     */
    async function fillMakerClip(
      engine: StrategyEngine,
      runtime: TradingRuntime,
      gateway: ScriptedGateway,
      price: string,
      expectedPosition: string,
    ): Promise<void> {
      const quote = entryQuotes(gateway).at(-1);
      expect(quote).toBeDefined();
      const hedgesBefore = hedgeOrders(gateway).length;
      ackOrder(runtime, quote!.remoteId, 'FILLED', '0.1', price);
      ingestFill(runtime, quote!.remoteId, 'BINANCE_FUTURE_BTC_USDT', 'SELL', '0.1', price);
      await waitFor(() => hedgeOrders(gateway).length > hedgesBefore);
      const hedge = hedgeOrders(gateway).at(-1)!;
      ackOrder(runtime, hedge.remoteId, 'FILLED', '0.1', '100000');
      // Wait for this clip's own exposure: cumulative, so prior clips cannot satisfy it.
      await waitFor(() => runtime.getStrategy(engine.listActiveStrategyIds()[0] ?? '').openPosition === expectedPosition);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      await engine.tick();
    }

    it('walks the maker entry quote one tier per filled clip and keeps a single resting quote', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      setMakerBooks(markets);
      await engine.startStrategy(makerLadderConfig);
      await engine.tick();
      await waitFor(() => entryQuotes(gateway).length === 1);
      // Tier 0 rests at 100000 × (1 + 50 bps) = 100500.
      expect(entryQuotes(gateway)[0]).toMatchObject({ side: 'SELL', type: 'LIMIT', time_in_force: 'POC', price: '100500' });

      // A maker entry quote only fills once the maker leg's own book has reached it: by the time
      // clip 0 trades at 100500, BINANCE has walked up to 100500, i.e. the live entry spread is
      // 50 bps = tier 0's level. That keeps the fixture self-consistent — in production the ladder
      // tier and the live spread advance together, so tier 1 (70 bps) is only 20 bps away and the
      // 25 bps proximity band stays open.
      markets.set('BINANCE_FUTURE_BTC_USDT', '100500', '100501');
      await fillMakerClip(engine, runtime, gateway, '100500', '0.1');
      await waitFor(() => entryQuotes(gateway).length === 2);
      expect(entryQuotes(gateway)[1]?.price).toBe('100700');
      // Only ever one entry quote: the previous quote is terminal before the next is priced.
      expect(entryQuotes(gateway)).toHaveLength(2);

      // Clip 1 filled at 100700 ⇒ BINANCE now quotes 100700, spread 70 bps = tier 1's level.
      markets.set('BINANCE_FUTURE_BTC_USDT', '100700', '100701');
      await fillMakerClip(engine, runtime, gateway, '100700', '0.2');
      await waitFor(() => entryQuotes(gateway).length === 3);
      expect(entryQuotes(gateway)[2]?.price).toBe('100900');
      expect(entryQuotes(gateway)).toHaveLength(3);
      expect(runtime.getStrategy(engine.listActiveStrategyIds()[0] ?? '').openPosition).toBe('0.2');
    });
    it('counts one maker clip once, whether the hedge is filled or still outstanding', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      setMakerBooks(markets);
      await engine.startStrategy(makerLadderConfig);
      await engine.tick();
      await waitFor(() => entryQuotes(gateway).length === 1);
      const quote = entryQuotes(gateway)[0]!;

      // Maker leg filled, hedge still open: matched is 0 (min(|left|,|right|)) and the accounting
      // must count the pending hedge via inFlight — i.e. exactly one clip, not two.
      ackOrder(runtime, quote.remoteId, 'FILLED', '0.1', '100500');
      ingestFill(runtime, quote.remoteId, 'BINANCE_FUTURE_BTC_USDT', 'SELL', '0.1', '100500');
      await waitFor(() => gateway.createdOrders.some((order) => order.symbol === 'OKX_FUTURE_BTC_USDT' && order.type === 'MARKET'));
      // The maker clip traded at 100500 ⇒ BINANCE is now at 100500, spread 50 bps: tier 1 (70 bps)
      // sits 20 bps away, inside the band. Without this the book would stay at spread 30 bps (40 bps
      // from tier 1) and the quote would park instead of advancing.
      markets.set('BINANCE_FUTURE_BTC_USDT', '100500', '100501');
      // Same tick requirement as `fillMakerClip`: quoting lives in `evaluate()`, not in the fill path.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      await engine.tick();
      await waitFor(() => entryQuotes(gateway).length === 2);
      expect(entryQuotes(gateway)[1]?.price).toBe('100700');

      const hedge = gateway.createdOrders.filter((order) => order.symbol === 'OKX_FUTURE_BTC_USDT' && order.type === 'MARKET').at(-1)!;
      ackOrder(runtime, hedge.remoteId, 'FILLED', '0.1', '100000');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      await engine.tick();
      // Once both legs are flat the count is unchanged, so the tier does not skip to 90 bps.
      expect(entryQuotes(gateway).at(-1)?.price).toBe('100700');
      expect(entryQuotes(gateway)).toHaveLength(2);
    });

    it('parks the next tier when a clip fills against a still book, then resumes once the spread arrives', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      setMakerBooks(markets);
      const record = await engine.startStrategy(makerLadderConfig);
      const parked = (): number => runtime.strategyLogs(record.id)
        .filter((log) => log.event === 'Maker quoting parked').length;
      const resumed = (): number => runtime.strategyLogs(record.id)
        .filter((log) => log.event === 'Maker quoting resumed').length;
      await engine.tick();
      await waitFor(() => entryQuotes(gateway).length === 1);
      // Tier 0 rests at 100500 with the live spread at 30 bps ⇒ distance 20 bps, inside the band.
      expect(entryQuotes(gateway)[0]?.price).toBe('100500');

      // Clip 0 fills at 100500 but the book does NOT move: the spread is still 30 bps while tier 1
      // needs 70 bps ⇒ distance 40 bps, outside the band. No tier-1 quote may appear, and the park
      // transition is logged exactly once.
      await fillMakerClip(engine, runtime, gateway, '100500', '0.1');
      expect(entryQuotes(gateway)).toHaveLength(1);
      expect(parked()).toBe(1);
      expect(resumed()).toBe(0);

      // Now the spread walks up to tier 1's level: BINANCE quotes 100700 ⇒ spread 70 bps ⇒ distance
      // 0 bps, back inside the band, so quoting resumes. 100000 × (1 + 70 bps) = 100700, but the
      // BINANCE best ask (100701) sits above that boundary, so the makerTop clamp rests the SELL one
      // tick higher at 100701. A single resume row is logged.
      markets.set('BINANCE_FUTURE_BTC_USDT', '100700', '100701');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      await engine.tick();
      await waitFor(() => entryQuotes(gateway).length === 2);
      expect(entryQuotes(gateway)[1]?.price).toBe('100701');
      expect(parked()).toBe(1);
      expect(resumed()).toBe(1);
    });

    it('stops referencing maker entry quotes past the stop line and blocks entry while breached', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      setMakerBooks(markets);
      const record = await engine.startStrategy(makerLadderConfig);
      await engine.tick();
      await waitFor(() => entryQuotes(gateway).length === 1);
      // Each clip only trades after BINANCE has walked up to its resting price, so the live spread
      // advances with the ladder (50 ⇒ 70 ⇒ 90 bps) and the next tier stays inside the 25 bps band.
      markets.set('BINANCE_FUTURE_BTC_USDT', '100500', '100501');
      await fillMakerClip(engine, runtime, gateway, '100500', '0.1');
      markets.set('BINANCE_FUTURE_BTC_USDT', '100700', '100701');
      await fillMakerClip(engine, runtime, gateway, '100700', '0.2');
      markets.set('BINANCE_FUTURE_BTC_USDT', '100900', '100901');
      await fillMakerClip(engine, runtime, gateway, '100900', '0.3');
      await waitFor(() => entryQuotes(gateway).length === 3);

      // The next tier would sit at 110 bps ≥ stopLossBps 100, so no further entry quote may be
      // rested even though maxPosition (0.5) still leaves capacity for two more clips.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      await engine.tick();
      await engine.tick();
      expect(entryQuotes(gateway)).toHaveLength(3);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
      expect(runtime.getStrategy(record.id).openPosition).toBe('0.3');

      // Breaching the stop line (spread 110 bps) keeps entry quoting off: the next tier already sits
      // past the line, so no fresh quote may be rested here either.
      markets.set('BINANCE_FUTURE_BTC_USDT', '101100', '101101');
      await engine.tick();
      expect(entryQuotes(gateway)).toHaveLength(3);
    });

    it('leaves the maker requote cadence untouched when no ladder is configured', async () => {
      const { engine, gateway, markets } = await createHarness();
      setMakerBooks(markets);
      const { addOnStepBps: _omitted, ...withoutLadder } = makerLadderConfig;
      await engine.startStrategy(withoutLadder);
      await engine.tick();
      await waitFor(() => entryQuotes(gateway).length === 1);
      expect(entryQuotes(gateway)[0]?.price).toBe('100500');

      // A static book must not produce any cancel/replace: the tier maths adds no requote rate.
      await engine.tick();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      await engine.tick();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      await engine.tick();
      expect(gateway.cancelledOrders).toHaveLength(0);
      expect(entryQuotes(gateway)).toHaveLength(1);
      expect(entryQuotes(gateway)[0]?.price).toBe('100500');
    });

    it('blocks the maker entry quote while the live spread already breaches the stop line', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      // The shared `setMakerBooks` book prices BINANCE at 100300, giving a 30 bps entry spread that
      // already equals this case's stopLossBps — nothing would ever be quoted, so the initial spread
      // is compressed to 10 bps here (still valid per B1: stopLossBps 30 > |entryBps| 10).
      markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
      markets.set('BINANCE_FUTURE_BTC_USDT', '100100', '100101');
      const record = await engine.startStrategy({
        // No ladder here: this case isolates the B2 gate itself (entryBps 10 + step 20 would sit
        // exactly on stopLossBps 30 and be rejected by `add_on_step_beyond_stop_loss`).
        ...makerLadderConfig, entryBps: '10', stopLossBps: 30, addOnStepBps: undefined,
      });
      await engine.tick();
      await waitFor(() => entryQuotes(gateway).length === 1);
      const firstQuote = entryQuotes(gateway)[0]!;

      // 400 bps ≥ stopLossBps 30: the resting entry quote must go and no new one may be placed.
      markets.set('BINANCE_FUTURE_BTC_USDT', '100400', '100401');
      await engine.tick();
      await waitFor(() => gateway.cancelledOrders.includes(firstQuote.remoteId));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      await engine.tick();
      expect(entryQuotes(gateway)).toHaveLength(1);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    });
  });

  describe('maker entry proximity band', () => {
    // A plain auto MAKER_TAKER strategy with a positive entry threshold. The proximity band only
    // gates the entry intent; the take-profit exit is intentionally out of scope (§gate-crossex).
    const proximityConfig = {
      kind: 'auto' as const, asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
      leftSide: 'SELL' as const, rightSide: 'BUY' as const,
      entryBps: '10', takeProfitBps: '2', maxPosition: '0.5', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'MAKER_TAKER' as const, makerLeg: 'left' as const,
    };

    // The actor is private; reach it through a structural view purely for these read-only assertions.
    type ProximityActor = { id: string; makerEntryParked: boolean; quotes: Map<string, unknown> };
    function actorOf(engine: StrategyEngine, id: string): ProximityActor {
      return (engine as unknown as { actors: Map<string, ProximityActor> }).actors.get(id)!;
    }

    // The live entry spread is (BINANCE bid − OKX ask) / OKX ask. Only those two prices matter for
    // the proximity gate; the other legs are padded just to keep every book positive.
    function setEntrySpread(markets: StubMarkets, binanceBid: number, okxAsk: number): void {
      markets.set('BINANCE_FUTURE_BTC_USDT', String(binanceBid), String(binanceBid + 1));
      markets.set('OKX_FUTURE_BTC_USDT', String(okxAsk - 1), String(okxAsk));
    }

    function parkCount(runtime: TradingRuntime, id: string): number {
      return runtime.strategyLogs(id).filter((log) => log.event === 'Maker quoting parked').length;
    }
    function resumeCount(runtime: TradingRuntime, id: string): number {
      return runtime.strategyLogs(id).filter((log) => log.event === 'Maker quoting resumed').length;
    }

    const left = 'BINANCE_FUTURE_BTC_USDT';
    const right = 'OKX_FUTURE_BTC_USDT';
    function seedOpenPosition(database: Database.Database, id: string): void {
      seedFilledStrategyOrder(database, id, 'seed-left', left, 'SELL', '0.1', 'left');
      seedFilledStrategyOrder(database, id, 'seed-right', right, 'BUY', '0.1', 'right');
    }

    it('1. parks the maker entry quote when the live spread is far outside the proximity band', async () => {
      const { engine, runtime, markets } = await createHarness();
      // entryBps 10, spread (99800−100000)/100000 = −20 bps ⇒ distance 10−(−20) = 30 bps > 25.
      setEntrySpread(markets, 99800, 100000);
      const record = await engine.startStrategy(proximityConfig);
      await engine.tick();

      const actor = actorOf(engine, record.id);
      expect(actor.makerEntryParked).toBe(true);
      expect(actor.quotes.has('entry')).toBe(false);
      expect(parkCount(runtime, record.id)).toBe(1);
      expect(resumeCount(runtime, record.id)).toBe(0);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    });

    it('2. rests the maker entry quote and logs a single resume when the spread moves inside the band', async () => {
      const { engine, runtime, markets } = await createHarness();
      // First park it: spread −20 bps ⇒ distance 30 bps.
      setEntrySpread(markets, 99800, 100000);
      const record = await engine.startStrategy(proximityConfig);
      await engine.tick();
      expect(actorOf(engine, record.id).makerEntryParked).toBe(true);
      expect(parkCount(runtime, record.id)).toBe(1);

      // Now bring the spread inside the band: spread 0 bps ⇒ distance 10 bps ≤ 25.
      setEntrySpread(markets, 100000, 100000);
      await engine.tick();

      const actor = actorOf(engine, record.id);
      expect(actor.makerEntryParked).toBe(false);
      expect(actor.quotes.has('entry')).toBe(true);
      expect(resumeCount(runtime, record.id)).toBe(1);
      // Exactly one park event — the resume does not re-trigger a park.
      expect(parkCount(runtime, record.id)).toBe(1);
    });

    it('3. rests the entry quote at the inclusive 25 bps edge without parking', async () => {
      const { engine, runtime, markets } = await createHarness();
      // spread −15 bps ⇒ distance 10−(−15) = 25 bps, the inclusive boundary of the band.
      setEntrySpread(markets, 99850, 100000);
      const record = await engine.startStrategy(proximityConfig);
      await engine.tick();

      const actor = actorOf(engine, record.id);
      expect(actor.makerEntryParked).toBe(false);
      expect(actor.quotes.has('entry')).toBe(true);
      expect(parkCount(runtime, record.id)).toBe(0);
      expect(resumeCount(runtime, record.id)).toBe(0);
    });

    it('4. keeps an already-parked strategy parked across repeated evaluations with no duplicate park log', async () => {
      const { engine, runtime, markets } = await createHarness();
      setEntrySpread(markets, 99800, 100000);
      const record = await engine.startStrategy(proximityConfig);
      await engine.tick();
      expect(actorOf(engine, record.id).makerEntryParked).toBe(true);
      expect(parkCount(runtime, record.id)).toBe(1);

      // Repeated ticks with the spread still far away must not re-log the transition (only the
      // makerEntryParked transition is logged, not every 500ms pass).
      await engine.tick();
      expect(actorOf(engine, record.id).makerEntryParked).toBe(true);
      expect(actorOf(engine, record.id).quotes.has('entry')).toBe(false);
      expect(parkCount(runtime, record.id)).toBe(1);

      await engine.tick();
      expect(actorOf(engine, record.id).makerEntryParked).toBe(true);
      expect(actorOf(engine, record.id).quotes.has('entry')).toBe(false);
      expect(parkCount(runtime, record.id)).toBe(1);
    });

    it('5. applies the mirrored proximity branch for a negative entryBps (park then resume)', async () => {
      const { engine, runtime, markets } = await createHarness();
      // Negative entryBps −10 mirrors the distance to spread − level. Park when spread > 15 bps.
      // spread 20 bps ⇒ distance 20−(−10) = 30 bps > 25 ⇒ park.
      setEntrySpread(markets, 100200, 100000);
      const record = await engine.startStrategy({ ...proximityConfig, entryBps: '-10' });
      await engine.tick();
      expect(actorOf(engine, record.id).makerEntryParked).toBe(true);
      expect(actorOf(engine, record.id).quotes.has('entry')).toBe(false);
      expect(parkCount(runtime, record.id)).toBe(1);

      // spread 10 bps ⇒ distance 10−(−10) = 20 bps ≤ 25 ⇒ resume.
      setEntrySpread(markets, 100100, 100000);
      await engine.tick();
      const actor = actorOf(engine, record.id);
      expect(actor.makerEntryParked).toBe(false);
      expect(actor.quotes.has('entry')).toBe(true);
      expect(resumeCount(runtime, record.id)).toBe(1);
    });

    it('6. abstains from the proximity gate for a premium strategy (no park/resume logs)', async () => {
      const { engine, runtime, markets, gateway } = await createHarness();
      // Premium strategies route to evaluatePremiumClip, never evaluateMakerQuotes, so the band is
      // out of reach; even with quoting proceeding normally there must be no park/resume rows.
      markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
      markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
      const record = await engine.startStrategy({
        kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
        leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
        entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1',
        perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
      });
      await engine.tick();

      expect(parkCount(runtime, record.id)).toBe(0);
      expect(resumeCount(runtime, record.id)).toBe(0);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
      // Quoting proceeded per the normal premium path (entry taker legs were placed).
      expect(gateway.createdOrders.length).toBeGreaterThanOrEqual(1);
    });

    it('7. produces no park/resume logs for a carry strategy (entryBps undefined)', async () => {
      const { engine, runtime, markets } = await createHarness();
      // Carry strategies carry no entryBps and route to evaluateCarryTriggers, so the proximity
      // gate is never consulted — there must be no park/resume rows regardless of the book.
      markets.set('GATE_SPOT_BTC_USDT', '99995', '100005');
      markets.set('GATE_FUTURE_BTC_USDT', '100195', '100205');
      const record = await engine.startStrategy({
        kind: 'carry', asset: 'BTC', leftVenue: 'GATE', rightVenue: 'GATE',
        leftSide: 'BUY', rightSide: 'SELL',
        leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'GATE_FUTURE_BTC_USDT',
        fundingDirection: 'POSITIVE', fundingAprMin: 15, basisTakeProfitBps: 5,
        totalAmount: '0.1', perOrderQuantity: '0.1', reduceOnly: false,
        executionMethod: 'TAKER_TAKER',
      });
      await engine.tick();

      expect(parkCount(runtime, record.id)).toBe(0);
      expect(resumeCount(runtime, record.id)).toBe(0);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    });

    it('8. keeps the take-profit exit quote resting regardless of how far the spread is from the entry trigger', async () => {
      const { engine, runtime, database, markets } = await createHarness();
      // Entry spread is far (−20 bps ⇒ distance 30 bps ⇒ entry parked), but the exit spread is
      // collapsed (≈0.1 bps ≤ takeProfitBps 2) so the take-profit quote must still rest.
      markets.set('BINANCE_FUTURE_BTC_USDT', '99800', '100000');
      markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
      const record = await engine.startStrategy(proximityConfig);
      seedOpenPosition(database, record.id);
      await engine.tick();

      const actor = actorOf(engine, record.id);
      // Entry side: gated by the band, so no entry quote — but the band did fire (park logged).
      expect(actor.quotes.has('entry')).toBe(false);
      expect(parkCount(runtime, record.id)).toBeGreaterThanOrEqual(1);
      // Exit side: untouched by the proximity band, so the take-profit quote rests anyway.
      expect(actor.quotes.has('exit')).toBe(true);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    });

    // The pre-fix `requotes the maker order when the taker leg moves beyond tolerance` scenario,
    // preserved on its own: a MAKER_TAKER *position* quote whose taker leg jumps far outside the
    // band in one step must be parked — withdrawn once and never re-rested — while the strategy
    // keeps running.
    it('9. parks a MAKER_TAKER position quote when the taker leg jumps beyond the band and never re-quotes it', async () => {
      const { engine, runtime, gateway, markets } = await createHarness();
      markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
      markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
      const record = await engine.startStrategy({
        ...takerTakerConfig, executionMethod: 'MAKER_TAKER', makerLeg: 'left', perOrderQuantity: '0.2',
      });
      await engine.tick();
      await waitFor(() => gateway.createdOrders.length === 1);
      const firstQuote = gateway.createdOrders[0]!;
      // Initial spread is 0 bps ⇒ distance 10 bps ≤ 25, so the entry quote rests at
      // 100000 × (1 + 10 bps) = 100100.
      expect(firstQuote.price).toBe('100100');

      // The taker (OKX) leg jumps to 100499/100500 in one step: spread −49.75 bps ⇒ distance
      // 10 − (−49.75) = 59.75 bps, far outside the 25 bps band, with no maker clip in between.
      markets.set('OKX_FUTURE_BTC_USDT', '100499', '100500');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      const parkTick = engine.tick();
      await waitFor(() => gateway.cancelledOrders.includes(firstQuote.remoteId));
      ackOrder(runtime, firstQuote.remoteId, 'CANCELLED', '0', '0');
      await parkTick;

      // Still far away on the following evaluation: the resting quote was withdrawn and nothing is
      // re-rested, but the strategy itself keeps running. Exactly one park transition is logged.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      await engine.tick();
      expect(gateway.createdOrders).toHaveLength(1);
      expect(parkCount(runtime, record.id)).toBe(1);
      expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    });
  });
});

/**
 * Regression cover for the AUTO-AF80979A livelock: a MAKER_TAKER auto take-profit whose maker exit
 * leg fills but can never finish, because `evaluateMakerQuotes` rested the exit quote on *any*
 * matched quantity (the take-profit price never participated) and `ensureHedged` only ever *topped
 * up* the lagging leg — re-buying the maker leg the exit had just reduced, pinning the pair back to
 * its full size. The fix latches the exit on a price trigger, unwinds the hedge leg with a
 * reduce-only limit at a bounded slippage, and never reopens a leg while the latch is set.
 */
describe('MAKER_TAKER take-profit exit latch', () => {
  const left = 'BINANCE_FUTURE_BTC_USDT';
  const right = 'OKX_FUTURE_BTC_USDT';
  const exitConfig = {
    kind: 'auto' as const, asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
    leftSide: 'SELL' as const, rightSide: 'BUY' as const,
    entryBps: '10', takeProfitBps: '2', maxPosition: '0.1', perOrderQuantity: '0.1',
    reduceOnly: false, executionMethod: 'MAKER_TAKER' as const, makerLeg: 'left' as const,
  };

  type ExitActor = {
    id: string;
    makerExitArmed: boolean;
    makerExitStartedAt: number | null;
    makerExitFallbackLogged: boolean;
    makerExitHedgeRequotes: number;
    makerExitHedgeFailures: number;
    makerExitHedgeRetryAt: number;
    makerExitHedge: { orderId: string; leg: 'left' | 'right'; quantity: Decimal } | null;
    quotes: Map<string, unknown>;
  };
  function actorOf(engine: StrategyEngine, id: string): ExitActor {
    return (engine as unknown as { actors: Map<string, ExitActor> }).actors.get(id)!;
  }

  /** Set both legs' books with a stamp aligned to the injected clock so quotes stay fresh. */
  function setBook(
    markets: StubMarkets, at: number, leftBid: string, leftAsk: string, rightBid: string, rightAsk: string,
  ): void {
    const stamp = new Date(at).toISOString();
    markets.set(left, leftBid, leftAsk, stamp);
    markets.set(right, rightBid, rightAsk, stamp);
  }

  /** Take-profit-level book: exit spread (left.ask − right.bid) ≈ 1 bp ≤ takeProfitBps 2. */
  function armBook(markets: StubMarkets, at: number): void {
    setBook(markets, at, '100000', '100010', '100000', '100001');
  }

  function seedOpen(database: Database.Database, id: string): void {
    seedFilledStrategyOrder(database, id, 'seed-left', left, 'SELL', '0.1', 'left');
    seedFilledStrategyOrder(database, id, 'seed-right', right, 'BUY', '0.1', 'right');
  }

  const exitQuotes = (gateway: ScriptedGateway) =>
    gateway.createdOrders.filter((order) => order.symbol === left && order.type === 'LIMIT');
  const hedgeOrders = (gateway: ScriptedGateway) =>
    gateway.createdOrders.filter((order) => order.symbol === right && order.type === 'LIMIT');
  /** Every hedge-submit attempt including rejected ones (`createdOrders` only holds successes). */
  const hedgeAttempts = (gateway: ScriptedGateway) =>
    gateway.createAttempts.filter((order) => order.symbol === right);
  const fallbackCount = (runtime: TradingRuntime, id: string) =>
    runtime.strategyLogs(id).filter((log) => log.event === 'Maker exit fallback').length;

  it('R1 latches on the price trigger and rests a reduce-only maker exit quote', async () => {
    const now = Date.now();
    const { engine, gateway, database, markets } = await createHarness({ now: () => now });
    armBook(markets, now);
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);

    await engine.tick();

    const actor = actorOf(engine, record.id);
    expect(actor.makerExitArmed).toBe(true);
    expect(actor.makerExitStartedAt).toBe(now);
    expect(actor.makerExitFallbackLogged).toBe(false);
    expect(exitQuotes(gateway)[0]).toMatchObject({
      symbol: left, side: 'BUY', type: 'LIMIT', time_in_force: 'POC', reduce_only: 'true', qty: '0.1',
    });
  });

  it('R2 does not latch outside take-profit, and never withdraws a resting exit quote once latched', async () => {
    const now = Date.now();
    const { engine, gateway, database, markets } = await createHarness({ now: () => now });
    // Exit spread (left.ask 100300 − right.bid 100000) = 30 bps > takeProfitBps 2 ⇒ no latch.
    setBook(markets, now, '100200', '100300', '100000', '100001');
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    await engine.tick();

    expect(actorOf(engine, record.id).makerExitArmed).toBe(false);
    expect(actorOf(engine, record.id).quotes.has('exit')).toBe(false);
    expect(gateway.createdOrders).toHaveLength(0);

    // Collapse onto take-profit ⇒ latch + a resting exit quote.
    armBook(markets, now);
    await engine.tick();
    expect(actorOf(engine, record.id).makerExitArmed).toBe(true);
    const quote = exitQuotes(gateway).find((order) => order.time_in_force === 'POC')!;
    expect(quote).toBeDefined();

    // Widen the *exit* spread through the maker leg's ask only: the exit quote's own price is
    // derived from the maker/taker bids, so it neither drifts nor is withdrawn. The latch persists.
    setBook(markets, now, '100000', '100300', '100000', '100001');
    await engine.tick();
    expect(actorOf(engine, record.id).makerExitArmed).toBe(true);
    expect(actorOf(engine, record.id).quotes.has('exit')).toBe(true);
    expect(gateway.cancelledOrders).not.toContain(quote.remoteId);
  });

  it('R3 reduces the hedge leg by |hedge|−|maker| with a reduce-only limit, never a market order', async () => {
    const now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    armBook(markets, now);
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    await engine.tick();
    const quote = exitQuotes(gateway)[0]!;

    // The maker exit leg fills 0.06 of 0.1: maker left −0.04, hedge right +0.1 ⇒ unwind 0.06.
    ackOrder(runtime, quote.remoteId, 'FILLED', '0.06', '100010');
    ingestFill(runtime, quote.remoteId, left, 'BUY', '0.06', '100010');
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.04');
    await waitFor(() => hedgeOrders(gateway).length === 1);

    await engine.tick();

    expect(hedgeOrders(gateway)).toHaveLength(1);
    expect(hedgeOrders(gateway)[0]).toMatchObject({
      symbol: right, side: 'SELL', type: 'LIMIT', time_in_force: 'GTC', reduce_only: 'true', qty: '0.06',
    });
    // Bounded slippage below the mid (100000.5 × (1 − 3 bps)) — a limit, never a market order.
    expect(hedgeOrders(gateway)[0]!.price).toBe('99970.49');
    expect(gateway.createdOrders.some((order) => order.type === 'MARKET')).toBe(false);
  });

  it('R4 cancels and re-prices the hedge exit limit once its TTL elapses without a fill', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    armBook(markets, now);
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    await engine.tick();
    const quote = exitQuotes(gateway)[0]!;
    ackOrder(runtime, quote.remoteId, 'FILLED', '0.06', '100010');
    ingestFill(runtime, quote.remoteId, left, 'BUY', '0.06', '100010');
    await waitFor(() => hedgeOrders(gateway).length === 1);
    const firstHedge = hedgeOrders(gateway)[0]!;
    expect(firstHedge.price).toBe('99970.49');

    // The 1500 ms TTL elapses without a fill and the hedge mid moves ⇒ cancel + re-price.
    now += 1_600;
    setBook(markets, now, '100000', '100010', '100100', '100101');
    await engine.tick();

    expect(gateway.cancelledOrders).toContain(firstHedge.remoteId);
    expect(hedgeOrders(gateway)).toHaveLength(2);
    const rehedge = hedgeOrders(gateway)[1]!;
    expect(rehedge.price).not.toBe(firstHedge.price);
    expect(rehedge.qty).toBe('0.06');
    expect(actorOf(engine, record.id).makerExitHedgeRequotes).toBe(1);
    expect(actorOf(engine, record.id).makerExitHedge?.orderId).not.toBe(firstHedge.remoteId);
  });

  it('R5 widens the hedge slippage cap once and logs a single fallback after the 30 s budget', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    armBook(markets, now);
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    await engine.tick();
    const quote = exitQuotes(gateway)[0]!;
    ackOrder(runtime, quote.remoteId, 'FILLED', '0.06', '100010');
    ingestFill(runtime, quote.remoteId, left, 'BUY', '0.06', '100010');
    await waitFor(() => hedgeOrders(gateway).length === 1);
    const firstHedge = hedgeOrders(gateway)[0]!;
    expect(firstHedge.price).toBe('99970.49');
    expect(fallbackCount(runtime, record.id)).toBe(0);

    // 30 s elapse with the exit still open: the fallback widens the cap to 10 bps and logs exactly
    // one row. The TTL has also elapsed, so the resting hedge limit is re-priced at the wider cap.
    now += 30_000;
    armBook(markets, now);
    await engine.tick();

    expect(fallbackCount(runtime, record.id)).toBe(1);
    expect(actorOf(engine, record.id).makerExitFallbackLogged).toBe(true);
    expect(gateway.cancelledOrders).toContain(firstHedge.remoteId);
    // 100000.5 × (1 − 10 bps) rounded down to the tick.
    expect(hedgeOrders(gateway).at(-1)!.price).toBe('99900.49');

    // A further tick keeps the single fallback row.
    now += 10;
    armBook(markets, now);
    await engine.tick();
    expect(fallbackCount(runtime, record.id)).toBe(1);
  });

  it('R6 never re-buys the maker leg after the exit has reduced it (the livelock regression pin)', async () => {
    const now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    armBook(markets, now);
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    await engine.tick();
    const quote = exitQuotes(gateway)[0]!;
    ackOrder(runtime, quote.remoteId, 'FILLED', '0.06', '100010');
    ingestFill(runtime, quote.remoteId, left, 'BUY', '0.06', '100010');
    await waitFor(() => hedgeOrders(gateway).length === 1);

    // Several ticks while the exit unwinds: no market order may touch the maker leg. The pre-fix
    // `ensureHedged` re-bought it (GATE +1000 → +2000) and pinned the pair back to full size.
    await engine.tick();
    await engine.tick();
    expect(gateway.createdOrders.filter((order) => order.symbol === left && order.type === 'MARKET')).toHaveLength(0);
    for (const order of gateway.createdOrders.filter((order) => order.symbol === left)) {
      expect(order.reduce_only).toBe('true');
    }
  });

  it('R7 retires the latch once both legs are flat and allows a fresh entry', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    armBook(markets, now);
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    await engine.tick();
    const quote = exitQuotes(gateway)[0]!;

    // Maker exit leg fills fully (left → 0); the hedge leg is then unwound (right → 0).
    ackOrder(runtime, quote.remoteId, 'FILLED', '0.1', '100010');
    ingestFill(runtime, quote.remoteId, left, 'BUY', '0.1', '100010');
    await waitFor(() => hedgeOrders(gateway).length === 1);
    const hedge = hedgeOrders(gateway)[0]!;
    ackOrder(runtime, hedge.remoteId, 'FILLED', '0.1', '99970.49');
    ingestFill(runtime, hedge.remoteId, right, 'SELL', '0.1', '99970.49');
    await waitFor(() => runtime.getStrategy(record.id).filledRight === '0');

    // One tick retires the latch (both legs flat)…
    await engine.tick();
    expect(actorOf(engine, record.id).makerExitArmed).toBe(false);
    expect(actorOf(engine, record.id).makerExitStartedAt).toBeNull();

    // …and, the spread back at the entry level (past the quote throttle), the next tick may rest a
    // fresh entry quote.
    now += 100;
    setBook(markets, now, '100100', '100101', '99999', '100000');
    await engine.tick();
    const entryQuote = gateway.createdOrders.find((order) =>
      order.symbol === left && order.type === 'LIMIT' && order.side === 'SELL');
    expect(entryQuote).toBeDefined();
    expect(entryQuote).toMatchObject({ time_in_force: 'POC', reduce_only: 'false', qty: '0.1' });
  });

  it('R8 abstains without a live book, and never withdraws a resting exit quote while latched', async () => {
    const now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    armBook(markets, now);
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);

    // No live book and unlatched: nothing rests and not a single log row is written.
    markets.remove(right);
    const logsBefore = runtime.strategyLogs(record.id).length;
    await engine.tick();
    expect(actorOf(engine, record.id).makerExitArmed).toBe(false);
    expect(gateway.createdOrders).toHaveLength(0);
    expect(gateway.cancelledOrders).toHaveLength(0);
    expect(runtime.strategyLogs(record.id).length).toBe(logsBefore);

    // Latch it, then pull the book again: the resting exit quote is kept and nothing is submitted.
    armBook(markets, now);
    await engine.tick();
    expect(actorOf(engine, record.id).makerExitArmed).toBe(true);
    const quote = exitQuotes(gateway)[0]!;
    expect(quote).toBeDefined();

    markets.remove(right);
    await engine.tick();
    expect(actorOf(engine, record.id).makerExitArmed).toBe(true);
    expect(actorOf(engine, record.id).quotes.has('exit')).toBe(true);
    expect(gateway.cancelledOrders).not.toContain(quote.remoteId);
    expect(gateway.createdOrders.some((order) => order.type === 'MARKET')).toBe(false);
  });

  it('R9 sizes the maker exit quote from the maker leg remaining, not the matched quantity', async () => {
    const now = Date.now();
    const { engine, gateway, database, markets } = await createHarness({ now: () => now });
    armBook(markets, now);
    // Maker (left) is the larger leg: matched = min(0.3, 0.1) = 0.1, |maker| = 0.3, perOrder = 0.5.
    // The pre-latch `ensureHedged` still runs on this arming tick (the latch is set later in the
    // pass); the assertion targets the exit quote, whose size proves the formula change.
    const record = await engine.startStrategy({ ...exitConfig, perOrderQuantity: '0.5' });
    seedFilledStrategyOrder(database, record.id, 'seed-left', left, 'SELL', '0.3', 'left');
    seedFilledStrategyOrder(database, record.id, 'seed-right', right, 'BUY', '0.1', 'right');

    await engine.tick();

    expect(actorOf(engine, record.id).makerExitArmed).toBe(true);
    const quote = exitQuotes(gateway).find((order) => order.side === 'BUY' && order.time_in_force === 'POC')!;
    expect(quote).toBeDefined();
    // min(perOrder 0.5, |maker| 0.3) = 0.3 — the old `min(perOrder, matched)` would have rested 0.1.
    expect(quote.qty).toBe('0.3');
  });

  it('R10 keeps unwinding the hedge leg and time-fallback while latched with no exit spread', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    armBook(markets, now);
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    await engine.tick();
    const first = exitQuotes(gateway)[0]!;
    expect(first).toBeDefined();

    // The maker exit leg fills 0.06 ⇒ maker −0.04, hedge +0.1 (imbalanced): the hedge leg is unwound
    // and, past the requote throttle, the latch rests a replacement exit quote for the remaining 0.04.
    ackOrder(runtime, first.remoteId, 'FILLED', '0.06', '100010');
    ingestFill(runtime, first.remoteId, left, 'BUY', '0.06', '100010');
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.04');
    await waitFor(() => hedgeOrders(gateway).length === 1);
    const firstHedge = hedgeOrders(gateway)[0]!;
    now += 100;
    armBook(markets, now);
    await engine.tick();
    expect(actorOf(engine, record.id).quotes.has('exit')).toBe(true);
    const resting = exitQuotes(gateway).filter((order) => order.time_in_force === 'POC').at(-1)!;

    // The maker leg's own feed dies ⇒ exitSpreadBps() is null, but the hedge leg (right) stays live.
    // The armed exit must NOT go quiet: the hedge leg is still unwound and the time fallback fires.
    markets.remove(left);
    now += 30_000;
    markets.set(right, '100000', '100001', new Date(now).toISOString());
    await engine.tick();

    // Time fallback fires exactly once…
    expect(fallbackCount(runtime, record.id)).toBe(1);
    // …the hedge leg is still trimmed by a reduce-only LIMIT at the widened cap (never a market)…
    const rehedge = hedgeOrders(gateway).at(-1)!;
    expect(rehedge).not.toBe(firstHedge);
    expect(rehedge).toMatchObject({ symbol: right, side: 'SELL', type: 'LIMIT', reduce_only: 'true' });
    expect(rehedge.price).toBe('99900.49');
    expect(gateway.createdOrders.some((order) => order.type === 'MARKET')).toBe(false);
    // …and the resting maker exit quote was neither withdrawn nor cancelled.
    expect(gateway.cancelledOrders).not.toContain(resting.remoteId);
    expect(actorOf(engine, record.id).quotes.has('exit')).toBe(true);
  });

  // A4b: a persistently rejected hedge submit used to retry twice per tick (the reconcile path and
  // the armed quote branch each call `ensureMakerExitFlat`, and a failed submit leaves the hedge
  // slot null so the TTL guard could not collapse them), with no strike budget and no pause.
  it('R11 caps the hedge submit at one attempt per tick and backs off exponentially while it keeps failing', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now, requoteIntervalMs: 100_000 });
    gateway.failCreate(right, 100);
    armBook(markets, now);
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    await engine.tick();
    const quote = exitQuotes(gateway)[0]!;
    ackOrder(runtime, quote.remoteId, 'FILLED', '0.06', '100010');
    ingestFill(runtime, quote.remoteId, left, 'BUY', '0.06', '100010');
    await waitFor(() => hedgeAttempts(gateway).length >= 1);

    // Strike 1 (the fill-triggered reconcile path): the dedicated budget starts and the first
    // backoff rung is 4 s — the existing `2_000 * 2 ** failures` convention computes the exponent
    // from the already-incremented strike, exactly like `executeTakerClip`.
    const actor = actorOf(engine, record.id);
    expect(actor.makerExitHedgeFailures).toBe(1);
    expect(actor.makerExitHedgeRetryAt).toBe(now + 4_000);

    // Same-tick dedup: the armed quote branch's second `ensureMakerExitFlat` call in this
    // evaluation reads the same injected clock, is still inside the backoff window, and must not
    // re-submit.
    const afterFirstStrike = hedgeAttempts(gateway).length;
    await engine.tick();
    expect(hedgeAttempts(gateway).length).toBe(afterFirstStrike);

    // Still inside the 4 s window one ms before it elapses: no attempt…
    now += 3_999;
    armBook(markets, now);
    await engine.tick();
    expect(hedgeAttempts(gateway).length).toBe(afterFirstStrike);
    // …then exactly one more attempt on the second rung (8 s).
    now += 1;
    armBook(markets, now);
    await engine.tick();
    expect(hedgeAttempts(gateway).length).toBe(afterFirstStrike + 1);
    expect(actorOf(engine, record.id).makerExitHedgeFailures).toBe(2);
    expect(actorOf(engine, record.id).makerExitHedgeRetryAt).toBe(now + 8_000);
    // Two strikes trip nothing meant for the two-leg paths.
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('R12 pauses after five consecutive hedge submit failures with a hedge-specific reason', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now, requoteIntervalMs: 100_000 });
    gateway.failCreate(right, 100);
    armBook(markets, now);
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    await engine.tick();
    const quote = exitQuotes(gateway)[0]!;
    ackOrder(runtime, quote.remoteId, 'FILLED', '0.06', '100010');
    ingestFill(runtime, quote.remoteId, left, 'BUY', '0.06', '100010');
    await waitFor(() => hedgeAttempts(gateway).length >= 1);
    expect(hedgeAttempts(gateway).length).toBe(1);

    // Strikes 2..5 walk the rungs 4 s → 8 s → 16 s → 32 s; the fifth trips the breaker.
    for (const step of [4_000, 8_000, 16_000, 32_000]) {
      now += step;
      armBook(markets, now);
      await engine.tick();
    }

    // The actor is gone from the map once quiesced: read the persisted state and the pause log.
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');
    const pausedLog = runtime.strategyLogs(record.id).find((log) => log.event === 'Strategy paused');
    expect(pausedLog?.result).toBe('Maker exit hedge order was rejected 5 consecutive times; the position cannot unwind automatically — review the hedge leg manually');
    expect(hedgeAttempts(gateway).length).toBe(5);
  });

  it('R13 resets the hedge strike budget after a successful submission', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now, requoteIntervalMs: 100_000 });
    gateway.failCreate(right, 2); // exactly two rejections, then the venue recovers
    armBook(markets, now);
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    await engine.tick();
    const quote = exitQuotes(gateway)[0]!;
    ackOrder(runtime, quote.remoteId, 'FILLED', '0.06', '100010');
    ingestFill(runtime, quote.remoteId, left, 'BUY', '0.06', '100010');
    await waitFor(() => hedgeAttempts(gateway).length >= 1); // strike 1 @ now
    now += 4_000;
    armBook(markets, now);
    await engine.tick(); // strike 2 @ now, next window 8 s
    expect(actorOf(engine, record.id).makerExitHedgeFailures).toBe(2);

    // The rejection budget is exhausted: the next attempt succeeds and clears the strike budget.
    now += 8_000;
    armBook(markets, now);
    await engine.tick();
    expect(hedgeOrders(gateway)).toHaveLength(1);
    expect(actorOf(engine, record.id).makerExitHedgeFailures).toBe(0);
    const rested = hedgeOrders(gateway)[0]!;

    // The venue degrades again: the next failure is strike 1, not strike 3 — the retry window is
    // the first 4 s rung, not the accumulated 16 s one.
    gateway.failCreate(right, 100);
    now += 1_600; // past the resting hedge's TTL ⇒ cancel + re-price into the rejection
    armBook(markets, now);
    await engine.tick();
    expect(gateway.cancelledOrders).toContain(rested.remoteId);
    expect(actorOf(engine, record.id).makerExitHedgeFailures).toBe(1);
    expect(actorOf(engine, record.id).makerExitHedgeRetryAt).toBe(now + 4_000);
    // Two strikes + one success + one re-strike.
    expect(hedgeAttempts(gateway).length).toBe(4);
  });
});

describe('recurring position lifecycle', () => {
  it('keeps funding-exit monitoring on and re-arms the same actor after a flat cycle', async () => {
    const { engine, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100', '101', undefined, undefined, '0.0001');
    markets.set('OKX_FUTURE_BTC_USDT', '100', '101', undefined, undefined, '-0.0001');
    const record = await engine.startStrategy({
      ...takerTakerConfig,
      recurring: true,
      recurringCooldownSeconds: 60,
      exitOnFundingFlip: true,
      fundingAprMin: 15,
    } as never);
    const actor = (engine as unknown as { actors: Map<string, Record<string, unknown>> }).actors.get(record.id)!;
    expect(actor).toBeTruthy();
    expect((engine as unknown as { positionMonitoringEnabled: (config: unknown) => boolean })
      .positionMonitoringEnabled(actor.config)).toBe(true);

    const before = String((actor.config as Record<string, unknown>).recurringStartedAt);
    (actor as Record<string, unknown>).positionExitArmed = true;
    (actor as Record<string, unknown>).positionExitReason = 'funding-decay';
    (engine as unknown as { rearmRecurringPosition: (value: unknown) => void })
      .rearmRecurringPosition(actor);

    expect(actor.status).toBe('RUNNING');
    expect(actor.positionExitArmed).toBe(false);
    expect(actor.positionExitReason).toBeNull();
    expect(String((actor.config as Record<string, unknown>).recurringStartedAt)).not.toBe(before);
    expect(Number(actor.cooldownUntil)).toBeGreaterThan(Date.now());
  });

  it('computes the recurring gate from both live funding legs and abstains without quotes', async () => {
    const { engine, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100', '101', undefined, undefined, '0.02');
    markets.set('OKX_FUTURE_BTC_USDT', '100', '101', undefined, undefined, '-0.02');
    const record = await engine.startStrategy({
      ...takerTakerConfig, recurring: true, recurringFundingAprMin: 5000,
    } as never);
    const actor = (engine as unknown as { actors: Map<string, Record<string, unknown>> }).actors.get(record.id)!;
    const gate = (engine as unknown as { recurringEntryFundingOk: (value: unknown) => boolean })
      .recurringEntryFundingOk.bind(engine);

    // 4%/8h differential ≈ 4380% APR, below the dedicated 5000% recurring gate.
    expect(gate(actor)).toBe(false);
    markets.set('BINANCE_FUTURE_BTC_USDT', '100', '101', undefined, undefined, '0.03');
    markets.set('OKX_FUTURE_BTC_USDT', '100', '101', undefined, undefined, '-0.03');
    // 6%/8h differential ≈ 6570% APR clears it.
    expect(gate(actor)).toBe(true);
    // A flipped differential with the same magnitude must stay blocked: re-entry is directional.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100', '101', undefined, undefined, '-0.03');
    markets.set('OKX_FUTURE_BTC_USDT', '100', '101', undefined, undefined, '0.03');
    expect(gate(actor)).toBe(false);
    markets.remove('OKX_FUTURE_BTC_USDT');
    expect(gate(actor)).toBe(false);
  });
});
