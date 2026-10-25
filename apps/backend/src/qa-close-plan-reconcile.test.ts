/**
 * Independent adversarial verification of the close-plan reconcile loop (R3) in
 * `strategy-engine.ts` — `evaluateClosePlan` / `reconcileClosePlanQuantity` /
 * `closePlanSatisfied` / `closePlanResiduals`.
 *
 * This file is additive and self-contained: it must not depend on, or perturb, the existing
 * suites. The venue is simulated truthfully for reduce-only semantics (same shape as
 * `qa-taker-exit-clamp.test.ts`): a reduce-only order larger than the exchange's real
 * reducible quantity on that leg is rejected with `TRADE_REDUCE_ONLY_POSITION_QTY_ERROR`.
 *
 * Covered paths:
 *  1. reduce-only quantity rejection → reconcile from the venue → retry this leg only at the
 *     venue's real size (R3/AC-1), no pause, plan converges COMPLETED;
 *  2. reconcile says the venue holds nothing → the target is satisfied ('Exit quote
 *     withdrawn'), dust is never auto-liquidated, and the plan completes without phantom
 *     residual warnings;
 *  3. one persistently failing leg does not block the other (R3/AC-2): warning only, no
 *     pause, and the plan still converges to COMPLETED with a pending-residual note.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { DEFAULT_CREDENTIAL_PROFILE, MemoryCredentialVault, type GateCredentials } from './credential-vault.js';
import {
  GateApiError,
  type CrossExOrderRequest,
  type GateCrossExAccount,
  type GateCrossExOrder,
  type GateCrossExPortfolio,
  type GateCrossExRiskLimit,
  type GateCrossExSymbol,
  type GateFeeRate,
  type GateOrderActionResponse,
  type GateSpotAccount,
  type TradingCrossExGateway,
} from './crossex-client.js';
import type { LiveMarket } from './market-hub.js';
import { StrategyEngine, type MarketSource, type StrategyEngineOptions } from './strategy-engine.js';
import { TradingRuntime } from './trading-runtime.js';
import { TradingSession } from './trading-session.js';

const NOOP = (): void => {};

class QaGateway implements TradingCrossExGateway {
  readonly createdOrders: Array<CrossExOrderRequest & { remoteId: string }> = [];
  readonly createAttempts: CrossExOrderRequest[] = [];
  readonly cancelledOrders: string[] = [];
  readonly leverageUpdates: Array<{ symbol: string; leverage: string }> = [];
  readonly leverageQueries: string[][] = [];
  positions: GateCrossExPortfolio['positions'] = [];
  leverages: Record<string, string> = {};
  riskLimits: Record<string, GateCrossExRiskLimit['tiers']> = {};
  availableMargin = '1000000';
  accountAssets: GateCrossExAccount['assets'] = [];
  accountMode: 'CROSS_EXCHANGE' | 'ISOLATED_EXCHANGE' = 'CROSS_EXCHANGE';
  isolatedAvailableMargins: Record<string, string> = {};
  spotAccounts: GateSpotAccount[] = [];
  createFailLabel = 'TRADE_INSUFFICIENT_AVAILABLE_MARGIN_ERROR';
  positionQueries = 0;
  private readonly failCreateBudget = new Map<string, number>();
  private readonly remoteStates = new Map<string, string>();
  private sequence = 0;

  failCreate(symbol: string, times: number): void {
    this.failCreateBudget.set(symbol, (this.failCreateBudget.get(symbol) ?? 0) + times);
  }

  async queryAccount(_credentials: GateCredentials, exchangeType?: string): Promise<GateCrossExAccount> {
    const normalizedExchange = exchangeType?.toUpperCase() ?? 'CROSSEX';
    return {
      available_margin: this.availableMargin, margin_balance: this.availableMargin,
      initial_margin: '0', maintenance_margin: '0', initial_margin_rate: '0', maintenance_margin_rate: '0',
      position_mode: 'SINGLE', account_mode: this.accountMode, exchange_type: normalizedExchange,
      update_time: String(Date.now()), assets: this.accountAssets,
    };
  }
  async queryPositions(): Promise<GateCrossExPortfolio['positions']> {
    this.positionQueries += 1;
    return this.positions;
  }
  async querySpotAccounts(): Promise<GateSpotAccount[]> { return this.spotAccounts; }
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
    return {
      order_id: orderId, text: created.text ?? '', symbol: created.symbol, side: created.side,
      type: created.type, attribute: created.time_in_force === 'POC' ? 'POST_ONLY' : 'NORMAL',
      exchange_type: created.symbol.split('_')[0] ?? 'GATE', business_type: 'FUTURE',
      qty: created.qty ?? '0', quote_qty: '0', price: created.price ?? '0',
      time_in_force: created.time_in_force, state: this.remoteStates.get(orderId) ?? 'OPEN',
      executed_qty: '0', executed_amount: '0', executed_avg_price: '0', fee_coin: 'USDT', fee: '0',
      reduce_only: String(created.reduce_only), leverage: '0', reason: '',
      last_executed_qty: '0', last_executed_price: '0', last_executed_amount: '0',
      position_side: 'NONE', create_time: String(Date.now()), update_time: String(Date.now()),
    };
  }

  async createOrder(_credentials: GateCredentials, order: CrossExOrderRequest): Promise<GateOrderActionResponse> {
    this.createAttempts.push({ ...order });
    const reduceOnly = order.reduce_only === 'true';
    if (reduceOnly && order.symbol && !/^[A-Z0-9]+_SPOT_/.test(order.symbol)) {
      const reducible = this.reducibleQuantity(order.symbol, order.side);
      if (new Decimal(order.qty ?? '0').gt(reducible)) {
        throw new GateApiError(400, 'TRADE_REDUCE_ONLY_POSITION_QTY_ERROR');
      }
    }
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
    this.remoteStates.set(orderId, 'CANCELLED');
    return { order_id: orderId, text: '' };
  }

  /** Mirrors the engine's `venueReducibleQuantity`: what the venue can reduce on `side`. */
  private reducibleQuantity(symbol: string, side: 'BUY' | 'SELL'): Decimal {
    let total = new Decimal(0);
    for (const position of this.positions) {
      if (position.symbol !== symbol) continue;
      const raw = new Decimal(position.position_qty || '0');
      const positionSide = position.position_side.toUpperCase();
      const signed = positionSide === 'SHORT' ? raw.abs().negated()
        : positionSide === 'LONG' ? raw.abs() : raw;
      if (side === 'SELL' && signed.gt(0)) total = total.plus(signed);
      else if (side === 'BUY' && signed.lt(0)) total = total.plus(signed.abs());
    }
    return total;
  }
}

function futuresPosition(
  symbol: string,
  side: 'LONG' | 'SHORT',
  quantity: string,
): GateCrossExPortfolio['positions'][number] {
  return {
    position_id: `position-${symbol}`, symbol, position_side: side, initial_margin: '0',
    maintenance_margin: '0', position_qty: quantity, position_value: '0', upnl: '0', upnl_rate: '0',
    entry_price: '0', mark_price: '0', leverage: '5', max_leverage: '20', risk_limit: '0',
    fee: '0', funding_fee: '0', funding_time: '0', create_time: '0', update_time: '0', closed_pnl: '0',
  };
}

class StubMarkets implements MarketSource {
  private readonly markets = new Map<string, LiveMarket>();
  private state: ReturnType<NonNullable<MarketSource['connectionState']>> = 'healthy';
  constructor(private readonly database: Database.Database) {}

  set(symbol: string, bid: string, ask: string): void {
    const updatedAt = new Date().toISOString();
    const [venue = 'GATE', , asset = 'BTC'] = symbol.split('_');
    this.markets.set(symbol, {
      symbol, venue: venue as LiveMarket['venue'], asset, lastPrice: bid, bidPrice: bid, bidSize: '10',
      askPrice: ask, askSize: '10', open24h: bid, high24h: ask, low24h: bid, volume24h: '100',
      quoteVolume24h: '100000', fundingRate: '0.0001',
      nextFundingAt: new Date(Date.now() + 3_600_000).toISOString(), openInterest: '1000',
      openInterestValue: '1000000', receivedAt: updatedAt, updatedAt, quoteUpdatedAt: updatedAt,
      source: 'gate_crossex_websocket',
    });
    this.database.prepare(`INSERT OR IGNORE INTO crossex_instruments (
      symbol, exchange_type, business_type, state, min_size, min_notional, lot_size,
      tick_size, max_num_orders, max_market_size, max_limit_size, contract_size,
      liquidation_fee, default_leverage, delist_time, fetched_at
    ) VALUES (?, ?, 'FUTURE', 'live', '0.00000001', NULL, '0.00000001', '0.01', '100', NULL, NULL, NULL, NULL, '1', '0', ?)`)
      .run(symbol, venue, new Date().toISOString());
  }

  market(symbol: string): LiveMarket | null { return this.markets.get(symbol) ?? null; }
  ensureMarket(): boolean { return false; }
  watchQuotes(): () => void { return NOOP; }
  connectionState(): ReturnType<NonNullable<MarketSource['connectionState']>> { return this.state; }
}

interface Harness {
  database: Database.Database;
  runtime: TradingRuntime;
  engine: StrategyEngine;
  gateway: QaGateway;
  markets: StubMarkets;
  directory: string;
}

const harnesses: Harness[] = [];

async function createHarness(engineOptions: StrategyEngineOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'qa-close-plan-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
  });
  const session = new TradingSession();
  session.set('live');
  const database = openDatabase(config.databasePath, config.migrationsDir);
  const vault = new MemoryCredentialVault();
  await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'qa-key', apiSecret: 'qa-secret' });
  const gateway = new QaGateway();
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

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.engine.stop();
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

const eventsOf = (runtime: TradingRuntime, strategyId: string): Set<string> =>
  new Set(runtime.strategyLogs(strategyId).map((log) => log.event));

const LONG = 'BINANCE_FUTURE_BTC_USDT';
const SHORT = 'OKX_FUTURE_BTC_USDT';

async function startClosePlan(
  harness: Harness,
  targets: Array<{ symbol: string; side: 'BUY' | 'SELL'; quantity: string }>,
  orderCount = 1,
): Promise<{ id: string; createdAt: string }> {
  harness.markets.set(LONG, '100000', '100001');
  harness.markets.set(SHORT, '99999', '100000');
  const record = await harness.engine.startStrategy({
    kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
    leftSide: 'SELL', rightSide: 'BUY', totalAmount: '0.1', perOrderQuantity: '0.1',
    reduceOnly: true, executionMethod: 'TAKER_TAKER',
    closePlan: {
      orderCount,
      intervalSeconds: 5,
      targets: targets.map((target) => ({ ...target, positionSide: 'NONE' })),
    },
  });
  return { id: record.id, createdAt: record.createdAt };
}

describe('qa: close-plan reconcile loop (R3)', () => {
  it('retries a reduce-only-rejected leg at the venue size and converges COMPLETED', async () => {
    const harness = await createHarness({ now: () => Date.now() });
    const { engine, runtime, gateway } = harness;
    // The ledger's close plan believes 0.1 long; the venue actually holds only 0.06 — it was
    // partially closed outside the engine.
    gateway.positions = [futuresPosition(LONG, 'LONG', '0.06')];
    const { id } = await startClosePlan(harness, [
      { symbol: LONG, side: 'SELL', quantity: '0.1' },
    ]);

    const firstTick = engine.tick();
    // Attempt 1: oversized reduce-only rejected by the truthful venue. Attempt 2: the venue
    // reconciled size. No other order exists.
    await waitFor(() => gateway.createAttempts.length === 2);
    expect(gateway.createAttempts[0]).toMatchObject({ symbol: LONG, side: 'SELL', qty: '0.1', reduce_only: 'true' });
    expect(gateway.createAttempts[1]).toMatchObject({ symbol: LONG, side: 'SELL', qty: '0.06', reduce_only: 'true' });
    expect(gateway.positionQueries).toBeGreaterThanOrEqual(1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.06', '100000');
    await firstTick;

    await waitFor(() => runtime.getStrategy(id).status === 'COMPLETED');
    expect(eventsOf(runtime, id).has('Exit size corrected')).toBe(true);
    expect(eventsOf(runtime, id).has('Timed close slice failed')).toBe(false);
    // The unfilled 0.04 is a genuine residual and is reported as a pending note, not a pause.
    expect(runtime.getStrategy(id)).toMatchObject({ status: 'COMPLETED', progress: 100 });
    expect(eventsOf(runtime, id).has('Strategy paused')).toBe(false);
  }, 15_000);

  it('marks a target satisfied when the venue holds nothing and completes without phantom residuals', async () => {
    const harness = await createHarness({ now: () => Date.now() });
    const { engine, runtime, gateway } = harness;
    // The long leg was closed entirely outside the engine; the short leg is real and fills.
    gateway.positions = [futuresPosition(SHORT, 'SHORT', '0.05')];
    const { id } = await startClosePlan(harness, [
      { symbol: LONG, side: 'SELL', quantity: '0.1' },
      { symbol: SHORT, side: 'BUY', quantity: '0.05' },
    ]);

    const firstTick = engine.tick();
    await waitFor(() => gateway.createAttempts.length === 2);
    expect(gateway.createAttempts.find((attempt) => attempt.symbol === LONG))
      .toMatchObject({ side: 'SELL', qty: '0.1', reduce_only: 'true' });
    expect(gateway.createAttempts.find((attempt) => attempt.symbol === SHORT))
      .toMatchObject({ side: 'BUY', qty: '0.05', reduce_only: 'true' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.05', '100000');
    await firstTick;

    await waitFor(() => runtime.getStrategy(id).status === 'COMPLETED');
    expect(eventsOf(runtime, id).has('Exit quote withdrawn')).toBe(true);
    // No dust auto-liquidation: the satisfied leg is submitted exactly once (the rejected stale
    // attempt) and never gets a second order after the venue confirms it holds nothing.
    expect(gateway.createAttempts.filter((attempt) => attempt.symbol === LONG)).toHaveLength(1);
    // The satisfied target is excluded from residuals — the completion is clean (info, no note).
    expect(eventsOf(runtime, id).has('Timed close ended with residual positions')).toBe(false);
    const completed = runtime.strategyLogs(id).find((log) => log.event === 'Strategy completed');
    expect(completed?.level).toBe('info');
    expect(runtime.getStrategy(id)).toMatchObject({ status: 'COMPLETED', progress: 100 });
  }, 15_000);

  it('keeps a failing leg from blocking the other leg, and never pauses the plan', async () => {
    let now = Date.now();
    const harness = await createHarness({ now: () => now });
    const { engine, runtime, gateway } = harness;
    gateway.positions = [futuresPosition(LONG, 'LONG', '0.1'), futuresPosition(SHORT, 'SHORT', '0.2')];
    // The long leg fails persistently with a non-reduce-only venue error (insufficient margin).
    gateway.failCreate(LONG, 10);
    const { id, createdAt } = await startClosePlan(harness, [
      { symbol: LONG, side: 'SELL', quantity: '0.1' },
      { symbol: SHORT, side: 'BUY', quantity: '0.2' },
    ], 2);
    // Anchor the injected clock after creation: the first slice is due at `createdAt`.
    now = Date.parse(createdAt) + 100;

    // Slice 1: the short leg fills, the long leg fails with a warning only. The two create
    // calls race, so assertions are order-agnostic.
    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createAttempts.filter((attempt) => attempt.symbol === LONG))
      .toHaveLength(1);
    // Slice 1 of a 0.1 target split into 2 slices is 0.05.
    expect(gateway.createAttempts.find((attempt) => attempt.symbol === LONG))
      .toMatchObject({ side: 'SELL', qty: '0.05', reduce_only: 'true' });
    expect(gateway.createAttempts.find((attempt) => attempt.symbol === SHORT))
      .toMatchObject({ side: 'BUY', qty: '0.1', reduce_only: 'true' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100000');
    await firstTick;
    await waitFor(() => eventsOf(runtime, id).has('Timed close slice failed'));
    expect(runtime.getStrategy(id).status).toBe('RUNNING');
    expect(eventsOf(runtime, id).has('Strategy paused')).toBe(false);

    // Slice 2: the short leg fills its remaining half; the long leg fails again.
    now += 5_000;
    const secondTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createAttempts.filter((attempt) => attempt.symbol === SHORT))
      .toMatchObject([{ side: 'BUY', qty: '0.1' }, { side: 'BUY', qty: '0.1' }]);
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await secondTick;

    // The plan converges COMPLETED with a pending-residual note for the failed leg (R3/AC-3).
    await waitFor(() => runtime.getStrategy(id).status === 'COMPLETED');
    expect(eventsOf(runtime, id).has('Timed close ended with residual positions')).toBe(true);
    expect(eventsOf(runtime, id).has('Strategy paused')).toBe(false);
    expect(runtime.getStrategy(id)).toMatchObject({ status: 'COMPLETED', progress: 100 });
  }, 20_000);
});
