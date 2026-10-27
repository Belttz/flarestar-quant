/**
 * Guard tests for the `kind: 'position'` take-profit / stop-loss / max-position lifecycle.
 *
 * Before this work the three fields were accepted, persisted and shown in the strategy record but
 * the engine never executed them: every spread judgement in `strategy-engine.ts` was gated on
 * `input.kind === 'auto'`, and a `position` strategy walked a single "open the target and finish"
 * path. These tests pin the four things that must now be true:
 *
 *   1. a take-profit / stop-loss threshold closes both legs and ends the lifecycle;
 *   2. an absent field disables *only* its own threshold (never both, never a default of 0 bps);
 *   3. `maxPosition` refuses an over-sized clip instead of silently resizing it; and
 *   4. the trigger is one-shot — two consecutive qualifying frames produce one exit.
 *
 * The suite is self-contained on purpose (its own gateway / market stub / harness), following
 * `qa-taker-exit-clamp.test.ts` and `qa-maker-exit.test.ts`, so it cannot perturb the existing
 * suites and no existing assertion had to move.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
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

class ScriptedGateway implements TradingCrossExGateway {
  readonly createdOrders: Array<CrossExOrderRequest & { remoteId: string }> = [];
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
  private readonly remoteStates = new Map<string, string>();
  private sequence = 0;

  async queryAccount(_credentials: GateCredentials, exchangeType?: string): Promise<GateCrossExAccount> {
    const normalizedExchange = exchangeType?.toUpperCase() ?? 'CROSSEX';
    return {
      available_margin: this.availableMargin, margin_balance: this.availableMargin, initial_margin: '0',
      maintenance_margin: '0', initial_margin_rate: '0', maintenance_margin_rate: '0', position_mode: 'SINGLE',
      account_mode: this.accountMode, exchange_type: normalizedExchange,
      update_time: String(Date.now()), assets: this.accountAssets,
    };
  }
  async queryPositions(): Promise<GateCrossExPortfolio['positions']> { return this.positions; }
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

  set(symbol: string, bid: string, ask: string, ageMs = 0): void {
    const updatedAt = new Date(Date.now() - ageMs).toISOString();
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
  gateway: ScriptedGateway;
  markets: StubMarkets;
  directory: string;
}

const harnesses: Harness[] = [];

async function createHarness(engineOptions: StrategyEngineOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'qa-position-exit-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
  });
  const session = new TradingSession();
  session.set('live');
  const database = openDatabase(config.databasePath, config.migrationsDir);
  const vault = new MemoryCredentialVault();
  await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'qa-key', apiSecret: 'qa-secret' });
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

function ackOrder(runtime: TradingRuntime, remoteId: string, executedQty: string, avgPrice: string): void {
  runtime.ingestPrivateEvent({ channel: 'order', payload: {
    order_id: remoteId, state: 'FILLED', executed_qty: executedQty, executed_avg_price: avgPrice,
    update_time: String(Date.now()),
  } });
}

/**
 * Persist an already-filled strategy order so the ledger believes a position is open. Driving a
 * real entry adds timing noise to every test and is already covered by the main engine suite; what
 * these tests must isolate is what the *exit* thresholds do once a position exists.
 */
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

const eventsOf = (runtime: TradingRuntime, strategyId: string): Set<string> =>
  new Set(runtime.strategyLogs(strategyId).map((log) => log.event));

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────

const LEFT = 'BINANCE_FUTURE_BTC_USDT';
const RIGHT = 'OKX_FUTURE_BTC_USDT';

/**
 * A paired position strategy. `leftSide: SELL` / `rightSide: BUY` is the project's long-standing
 * convention: sell the rich left leg, buy the cheap right leg, and profit as the spread narrows.
 */
const positionConfig = {
  kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
  leftSide: 'SELL', rightSide: 'BUY',
  entryBps: '10', totalAmount: '0.1', perOrderQuantity: '0.1',
  reduceOnly: false, executionMethod: 'TAKER_TAKER',
} as const;

/**
 * Live-book fixture. `entrySpread` = (left bid − right ask) / right ask = 20 bps and
 * `exitSpread` = (left ask − right bid) / right bid ≈ 20.2 bps, i.e. the position sits between a
 * 10 bps entry trigger and either threshold below, so a test only has to move one threshold.
 */
const WIDE = { leftBid: '100200', leftAsk: '100201', rightBid: '99999', rightAsk: '100000' } as const;
/** Adverse for the convention above: entrySpread = (100400 − 100000) / 100000 = 40 bps. */
const ADVERSE = { leftBid: '100400', leftAsk: '100401', rightBid: '99999', rightAsk: '100000' } as const;
/** Converged: exitSpread = (100001 − 99999) / 99999 ≈ 2 bps, far below any take-profit above it. */
const CONVERGED = { leftBid: '100000', leftAsk: '100001', rightBid: '99999', rightAsk: '100000' } as const;

/** Start a position strategy with an already-open pair on the book in `book`. */
async function openPosition(
  harness: Harness,
  book: { leftBid: string; leftAsk: string; rightBid: string; rightAsk: string },
  config: Record<string, unknown>,
  quantity = '0.1',
): Promise<string> {
  const { engine, database, markets } = harness;
  markets.set(LEFT, book.leftBid, book.leftAsk);
  markets.set(RIGHT, book.rightBid, book.rightAsk);
  const record = await engine.startStrategy({ ...positionConfig, ...config });
  seedFilledStrategyOrder(database, record.id, 'seed-left', LEFT, 'SELL', quantity, 'left');
  seedFilledStrategyOrder(database, record.id, 'seed-right', RIGHT, 'BUY', quantity, 'right');
  return record.id;
}

const sidesOf = (gateway: ScriptedGateway, from: number): Array<{ symbol: string; side: string; reduce_only: string; qty: string }> =>
  gateway.createdOrders.slice(from).map((order) => ({
    symbol: order.symbol, side: order.side, reduce_only: String(order.reduce_only), qty: order.qty ?? '',
  }));

// ─── 1. Take-profit ──────────────────────────────────────────────────────────────────────────

describe('position take-profit', () => {
  it('closes both legs and completes at the threshold', async () => {
    const harness = await createHarness();
    const { engine, runtime, gateway } = harness;
    // exitSpread ≈ 20.2 bps ≤ 25 bps → take-profit fires.
    const id = await openPosition(harness, WIDE, { takeProfitBps: '25' });

    const tick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(sidesOf(gateway, 0)).toEqual([
      { symbol: LEFT, side: 'BUY', reduce_only: 'true', qty: '0.1' },
      { symbol: RIGHT, side: 'SELL', reduce_only: 'true', qty: '0.1' },
    ]);
    ackOrder(runtime, 'remote-1', '0.1', '100201');
    ackOrder(runtime, 'remote-2', '0.1', '99999');
    await tick;

    await waitFor(() => runtime.getStrategy(id).status === 'COMPLETED');
    const events = eventsOf(runtime, id);
    // The trigger row carries the bps reading; the fill row carries the result.
    expect(events.has('Take-profit triggered')).toBe(true);
    expect(events.has('Take-profit Executed')).toBe(true);
    expect(runtime.strategyLogs(id).find((log) => log.event === 'Take-profit triggered')?.condition)
      .toMatch(/Exit spread 20\.\d+ bps ≤ 25 bps take-profit/);
    expect(events.has('Stop-loss triggered')).toBe(false);
    // One-shot lifecycle: the strategy is gone and cannot re-enter.
    expect(engine.listActiveStrategyIds()).not.toContain(id);
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);
  });

  it('does not trigger while the exit spread is above the threshold', async () => {
    const harness = await createHarness();
    const { engine, gateway } = harness;
    // exitSpread ≈ 20.2 bps > 5 bps, and entrySpread 20 bps < 30 bps stop → nothing fires.
    const id = await openPosition(harness, WIDE, { takeProfitBps: '5', stopLossBps: 30 });

    await engine.tick();
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);
    expect(eventsOf(harness.runtime, id).has('Take-profit triggered')).toBe(false);
    expect(eventsOf(harness.runtime, id).has('Stop-loss triggered')).toBe(false);
    expect(harness.runtime.getStrategy(id).status).toBe('RUNNING');
  });
});

// ─── 2. Stop-loss ───────────────────────────────────────────────────────────────────────────

describe('position stop-loss', () => {
  it('closes both legs, labels the exit as a stop, and stops the strategy', async () => {
    const harness = await createHarness();
    const { engine, runtime, gateway } = harness;
    // entrySpread = 40 bps ≥ 30 bps stop-loss; no take-profit configured.
    const id = await openPosition(harness, ADVERSE, { stopLossBps: 30 });

    const tick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(sidesOf(gateway, 0)).toEqual([
      { symbol: LEFT, side: 'BUY', reduce_only: 'true', qty: '0.1' },
      { symbol: RIGHT, side: 'SELL', reduce_only: 'true', qty: '0.1' },
    ]);
    ackOrder(runtime, 'remote-1', '0.1', '100401');
    ackOrder(runtime, 'remote-2', '0.1', '99999');
    await tick;

    await waitFor(() => runtime.getStrategy(id).status === 'STOPPED');
    const events = eventsOf(runtime, id);
    expect(events.has('Stop-loss triggered')).toBe(true);
    expect(events.has('Stop-loss exit triggered')).toBe(true);
    expect(events.has('Stop-loss Executed')).toBe(true);
    // C2 mislabelling guard: a stop-loss unwind must never masquerade as a take-profit.
    expect(events.has('Take-profit triggered')).toBe(false);
    expect(events.has('Take-profit Executed')).toBe(false);
    expect(runtime.strategyLogs(id).find((log) => log.event === 'Stop-loss triggered')?.condition)
      .toMatch(/Spread 40\.00 bps hit the 30 bps stop-loss/);
    expect(engine.listActiveStrategyIds()).not.toContain(id);
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);
  });

  it('evaluates the stop on fresh quotes only and fires once the feed recovers', async () => {
    const harness = await createHarness();
    const { engine, gateway, markets, runtime, database } = harness;
    // Launch on a fresh book, then let it go stale: an exit must never be judged off a quote the
    // entry path would have refused (15 s per leg / 3 s transport / 2 s cross-leg skew).
    markets.set(LEFT, WIDE.leftBid, WIDE.leftAsk);
    markets.set(RIGHT, WIDE.rightBid, WIDE.rightAsk);
    const record = await engine.startStrategy({ ...positionConfig, stopLossBps: 30 });
    seedFilledStrategyOrder(database, record.id, 'seed-left', LEFT, 'SELL', '0.1', 'left');
    seedFilledStrategyOrder(database, record.id, 'seed-right', RIGHT, 'BUY', '0.1', 'right');

    // Adverse (40 bps ≥ the 30 bps stop) but 60 s old → no trigger, no order.
    markets.set(LEFT, ADVERSE.leftBid, ADVERSE.leftAsk, 60_000);
    markets.set(RIGHT, ADVERSE.rightBid, ADVERSE.rightAsk, 60_000);
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);
    expect(eventsOf(runtime, record.id).has('Stop-loss triggered')).toBe(false);

    // The feed recovers on the same adverse book: the stop is not missed, only deferred.
    markets.set(LEFT, ADVERSE.leftBid, ADVERSE.leftAsk);
    markets.set(RIGHT, ADVERSE.rightBid, ADVERSE.rightAsk);
    const tick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(eventsOf(runtime, record.id).has('Stop-loss triggered')).toBe(true);
    ackOrder(runtime, 'remote-1', '0.1', '100401');
    ackOrder(runtime, 'remote-2', '0.1', '99999');
    await tick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'STOPPED');
  });
});

// ─── 3. An absent field disables only its own threshold ─────────────────────────────────────

describe('position exit thresholds are independent', () => {
  it('does not take profit when only a stop-loss is configured', async () => {
    const harness = await createHarness();
    const { engine, gateway } = harness;
    // exitSpread is ≈ 2 bps on this book, which a defaulted 0 bps take-profit would have tripped.
    const id = await openPosition(harness, CONVERGED, { stopLossBps: 30 });
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);
    expect(eventsOf(harness.runtime, id).has('Take-profit triggered')).toBe(false);
  });

  it('does not stop out when only a take-profit is configured', async () => {
    const harness = await createHarness();
    const { engine, gateway } = harness;
    // entrySpread is 40 bps — beyond every stop line — but no stop is configured.
    const id = await openPosition(harness, ADVERSE, { takeProfitBps: '25' });
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);
    expect(eventsOf(harness.runtime, id).has('Stop-loss triggered')).toBe(false);
  });

  it('keeps the original open-only lifecycle when neither field is configured', async () => {
    const harness = await createHarness();
    const { engine, gateway, runtime } = harness;
    // Regression pin for today's behaviour: no thresholds → completes at the filled target and
    // never evaluates a spread. The book is at take-profit geometry on purpose, so an accidental
    // default would fire an exit here.
    const id = await openPosition(harness, WIDE, {});
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);
    expect(runtime.getStrategy(id).status).toBe('COMPLETED');
    const completed = runtime.strategyLogs(id).find((log) => log.event === 'Strategy completed');
    expect(completed?.condition).toBe('Target 0.1 BTC');
  });
});

// ─── 4. maxPosition ──────────────────────────────────────────────────────────────────────────

describe('position max position ceiling', () => {
  it('refuses an entry clip that would breach maxPosition and reports why', async () => {
    const harness = await createHarness();
    const { engine, gateway, runtime } = harness;
    harness.markets.set(LEFT, '100200', '100201');
    harness.markets.set(RIGHT, '99999', '100000');
    const record = await engine.startStrategy({
      ...positionConfig, totalAmount: '0.3', perOrderQuantity: '0.1', maxPosition: '0.15',
    });

    // First clip: 0.1 of a 0.15 ceiling — admitted.
    const first = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', '0.1', '100201');
    ackOrder(runtime, 'remote-2', '0.1', '99999');
    await first;
    expect(runtime.getStrategy(record.id).filledQuantity).toBe('0.1');

    // Second clip would project 0.2 against a 0.15 ceiling: refused, not silently resized.
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);
    const blocked = runtime.strategyLogs(record.id).find((log) => log.event === 'Entry blocked by max position');
    expect(blocked).toBeDefined();
    expect(blocked?.level).toBe('warning');
    expect(blocked?.condition).toMatch(/0\.2 BTC would exceed the 0\.15 BTC max position/);
    expect(blocked?.quantity).toBe('0.15 BTC');
    expect(blocked?.result).toMatch(/No order was submitted/);

    // A capped strategy must not flood the log: the refusal is reported on the transition only.
    await engine.tick();
    await engine.tick();
    expect(runtime.strategyLogs(record.id).filter((log) => log.event === 'Entry blocked by max position'))
      .toHaveLength(1);
    expect(gateway.createdOrders).toHaveLength(2);
  });

  it('does not cap a strategy that fits inside the ceiling', async () => {
    const harness = await createHarness();
    const { engine, gateway, runtime } = harness;
    harness.markets.set(LEFT, '100200', '100201');
    harness.markets.set(RIGHT, '99999', '100000');
    const record = await engine.startStrategy({
      ...positionConfig, totalAmount: '0.2', perOrderQuantity: '0.1', maxPosition: '0.5',
    });
    const first = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', '0.1', '100201');
    ackOrder(runtime, 'remote-2', '0.1', '99999');
    await first;
    const second = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    ackOrder(runtime, 'remote-3', '0.1', '100201');
    ackOrder(runtime, 'remote-4', '0.1', '99999');
    await second;
    expect(runtime.getStrategy(record.id).filledQuantity).toBe('0.2');
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Entry blocked by max position'))
      .toBe(false);
  });
});

// ─── 5. Idempotency ─────────────────────────────────────────────────────────────────────────

describe('position exit idempotency', () => {
  it('submits one exit for two consecutive frames that both satisfy the threshold', async () => {
    const harness = await createHarness();
    const { engine, gateway, runtime } = harness;
    const id = await openPosition(harness, WIDE, { takeProfitBps: '25' });

    // Frame 1 fires the latch and the exit clip. The fills are deliberately NOT acked yet, so the
    // ledger still shows the position open — exactly the state a second qualifying frame sees.
    const first = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    await first;

    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);
    // One trigger row, not one per frame.
    expect(runtime.strategyLogs(id).filter((log) => log.event === 'Take-profit triggered')).toHaveLength(1);
    expect(runtime.strategyLogs(id).filter((log) => log.event === 'Take-profit Executed')).toHaveLength(0);

    // Settle the resting exit: the lifecycle completes and never trades again.
    ackOrder(runtime, 'remote-1', '0.1', '100201');
    ackOrder(runtime, 'remote-2', '0.1', '99999');
    await engine.tick();
    await waitFor(() => runtime.getStrategy(id).status === 'COMPLETED');
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);
  });

  it('unwinds a partially closed position in per-order clips', async () => {
    const harness = await createHarness();
    const { engine, gateway, runtime } = harness;
    // A 0.3 position exiting in 0.1 clips: the trigger clip is the full matched size, so a partial
    // fill must leave the remainder to the follow-up path rather than to a second trigger decision.
    const id = await openPosition(harness, WIDE, { takeProfitBps: '25' }, '0.3');

    const first = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(sidesOf(gateway, 0).every((order) => order.qty === '0.3')).toBe(true);
    // Only 0.1 of each leg filled; 0.2 of the position is still open.
    ackOrder(runtime, 'remote-1', '0.1', '100201');
    ackOrder(runtime, 'remote-2', '0.1', '99999');
    await first;
    expect(runtime.getStrategy(id).status).toBe('RUNNING');

    // The remainder is unwound in one configured clip, not in the full residual.
    await engine.tick();
    expect(sidesOf(gateway, 2).every((order) => order.qty === '0.1')).toBe(true);
    expect(runtime.strategyLogs(id).filter((log) => log.event === 'Take-profit triggered')).toHaveLength(2);
  });
});
