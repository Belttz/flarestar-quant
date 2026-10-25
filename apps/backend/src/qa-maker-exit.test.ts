/**
 * Adversarial (fresh-eyes) verification of the MAKER_TAKER take-profit exit latch fix in
 * `strategy-engine.ts`. This suite deliberately exercises the edges the author's own
 * `strategy-engine.test.ts` block does NOT cover:
 *
 *   A1 orphan hedge order vs STOP/quiesce  (does the RESTING hedge limit get cancelled?)
 *   A2 the two latches (`makerExitArmed` + `stopLossArmed`) colliding
 *   A4 hedge slippage pricing on a non-finite mid
 *   A4b a persistently-rejected hedge submit backs off exponentially, strikes on a dedicated
 *       counter, and pauses at 5 with an independent reason (post-fix flip of the old storm test)
 *   A4c a successful hedge submit clears the strike budget — the next failure starts at rung one
 *   A5 `Maker exit fallback` stays exactly one per latch across requotes
 *   A6 (characterisation) the new armed early-return leaves the unarmed generic repair intact
 *
 * Nothing here mutates tracked files; the harness is self-contained on purpose so the author's
 * suite is never imported (importing it would re-run it).
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

const left = 'BINANCE_FUTURE_BTC_USDT';
const right = 'OKX_FUTURE_BTC_USDT';

class ScriptedGateway implements TradingCrossExGateway {
  readonly createdOrders: Array<CrossExOrderRequest & { remoteId: string }> = [];
  readonly createAttempts: CrossExOrderRequest[] = [];
  readonly cancelledOrders: string[] = [];
  readonly leverageUpdates: Array<{ symbol: string; leverage: string }> = [];
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
   * Direction-aware rejection predicate, checked BEFORE the per-symbol budget: it lets a test model
   * a venue that refuses one *side* only (e.g. a reduce-only SELL against a SHORT position) instead
   * of blanket-refusing every submit on the symbol.
   */
  failCreateIf: ((order: CrossExOrderRequest) => boolean) | null = null;
  createFailLabel = 'TRADE_INSUFFICIENT_AVAILABLE_MARGIN_ERROR';
  failPositionsLabel: string | null = null;
  positionQueries = 0;
  private readonly failCreateBudget = new Map<string, number>();
  private readonly remoteStates = new Map<string, string>();
  private sequence = 0;

  failCreate(symbol: string, times: number): void {
    this.failCreateBudget.set(symbol, (this.failCreateBudget.get(symbol) ?? 0) + times);
  }

  async queryAccount(_credentials: GateCredentials, exchangeType?: string): Promise<GateCrossExAccount> {
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
  async querySpotAccounts(): Promise<GateSpotAccount[]> { return this.spotAccounts; }
  async queryPortfolio(): Promise<GateCrossExPortfolio> { throw new GateApiError(0, 'NOT_SCRIPTED'); }
  async querySymbols(): Promise<GateCrossExSymbol[]> { return []; }
  async queryRiskLimits(symbols: string[]): Promise<GateCrossExRiskLimit[]> {
    return symbols.map((symbol) => ({ symbol, tiers: this.riskLimits[symbol] ?? [{
      tier: '1', min_risk_limit_value: '0', max_risk_limit_value: '1000000000',
      quick_cal_amount: '0', leverage_max: '200', maintenance_rate: '0.001',
    }] }));
  }
  async queryLeverages(_credentials: GateCredentials, symbols: string[]): Promise<Record<string, string>> {
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
      order_id: orderId, text: created.text ?? '', symbol: created.symbol, side: created.side, type: created.type,
      attribute: created.time_in_force === 'POC' ? 'POST_ONLY' : 'NORMAL',
      exchange_type: created.symbol.split('_')[0] ?? 'GATE', business_type: 'FUTURE',
      qty: created.qty ?? '0', quote_qty: '0', price: created.price ?? '0',
      time_in_force: created.time_in_force, state, executed_qty: '0', executed_amount: '0',
      executed_avg_price: '0', fee_coin: 'USDT', fee: '0', reduce_only: String(created.reduce_only),
      leverage: '0', reason: '', last_executed_qty: '0', last_executed_price: '0', last_executed_amount: '0',
      position_side: 'NONE', create_time: String(Date.now()), update_time: String(Date.now()),
    };
  }

  async createOrder(_credentials: GateCredentials, order: CrossExOrderRequest): Promise<GateOrderActionResponse> {
    this.createAttempts.push({ ...order });
    if (this.failCreateIf?.(order)) throw new GateApiError(400, this.createFailLabel);
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

class StubMarkets implements MarketSource {
  private readonly markets = new Map<string, LiveMarket>();
  private state: ReturnType<NonNullable<MarketSource['connectionState']>> = 'healthy';
  constructor(private readonly database: Database.Database) {}

  set(
    symbol: string, bid: string, ask: string, updatedAt = new Date().toISOString(),
    receivedAt = updatedAt,     fundingRate = '0.0001',
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
  remove(symbol: string): void { this.markets.delete(symbol); }
  /** Drop the instrument-constraints row so `constraintsFor` returns all-null limits. */
  dropConstraints(symbol: string): void {
    this.database.prepare('DELETE FROM crossex_instruments WHERE symbol = ?').run(symbol);
  }
  ensureMarket(): boolean { return false; }
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
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-qa-maker-exit-'));
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
  // A default, fresh take-profit-level book. The harness injects a *constant* clock, so
  // `startStrategy`'s live-market wait (deadline `now() + timeout`) can never elapse: without a
  // book present before the call it spins forever. Stamp the seed from the injected clock so the
  // quote is never "from the future" (a real Date.now() would exceed futureQuoteToleranceMs when
  // the setup itself takes a couple of seconds under load). Tests override this book as needed.
  const seedNow = engineOptions.now ? engineOptions.now() : Date.now();
  const stamp = new Date(seedNow).toISOString();
  markets.set(left, '100000', '100010', stamp);
  markets.set(right, '100000', '100001', stamp);
  const engine = new StrategyEngine(database, session, runtime, markets, {
    tickIntervalMs: 20, orderTimeoutMs: 60, requoteIntervalMs: 10, repairCooldownMs: 0,
    ...engineOptions,
  });
  const harness = { database, runtime, engine, gateway, markets, directory };
  harnesses.push(harness);
  return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function ackOrder(runtime: TradingRuntime, remoteId: string, state: string, executedQty: string, avgPrice: string): void {
  runtime.ingestPrivateEvent({ channel: 'order', payload: {
    order_id: remoteId, state, executed_qty: executedQty, executed_avg_price: avgPrice, update_time: String(Date.now()),
  } });
}

function seedFilled(
  database: Database.Database, strategyId: string, id: string, symbol: string,
  side: 'BUY' | 'SELL', quantity: string, leg: 'left' | 'right',
): void {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO execution_orders (
    id, client_order_id, environment, symbol, venue, side, order_type, time_in_force,
    quantity, price, reduce_only, state, executed_quantity, executed_average_price,
    created_at, updated_at, strategy_id, strategy_leg
  ) VALUES (?, ?, 'live', ?, ?, ?, 'MARKET', 'IOC', ?, NULL, 0, 'FILLED', ?, '54', ?, ?, ?, ?)`)
    .run(id, `${id}-client`, symbol, symbol.split('_')[0], side, quantity, quantity, now, now, strategyId, leg);
}

/** Insert a strategy-linked OPEN order row directly, simulating a leftover from a prior process. */
function seedOpenOrderRow(
  database: Database.Database, strategyId: string, id: string, symbol: string,
  side: 'BUY' | 'SELL', quantity: string, leg: 'left' | 'right',
): void {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO execution_orders (
    id, client_order_id, environment, symbol, venue, side, order_type, time_in_force,
    quantity, price, reduce_only, state, executed_quantity, executed_average_price,
    created_at, updated_at, strategy_id, strategy_leg
  ) VALUES (?, ?, 'live', ?, ?, ?, 'LIMIT', 'GTC', ?, '100000', 1, 'NEW', '0', NULL, ?, ?, ?, ?)`)
    .run(id, `${id}-client`, symbol, symbol.split('_')[0], side, quantity, now, now, strategyId, leg);
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.engine.stop();
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

const exitConfig = {
  kind: 'auto' as const, asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
  leftSide: 'SELL' as const, rightSide: 'BUY' as const,
  entryBps: '10', takeProfitBps: '2', maxPosition: '0.1', perOrderQuantity: '0.1',
  reduceOnly: false, executionMethod: 'MAKER_TAKER' as const, makerLeg: 'left' as const,
};

/**
 * Same pair with the leg directions flipped: the maker leg (left) is LONG and the HEDGE leg (right)
 * is SHORT. Unwinding a short hedge leg is a BUY; this configuration is the one the shipped tests
 * never covered (they only ever seeded a long hedge leg, where `SELL` happens to be correct).
 */
const flippedExitConfig = {
  ...exitConfig,
  leftSide: 'BUY' as const,
  rightSide: 'SELL' as const,
};

type ExitActor = {
  id: string;
  status: string;
  stopLossArmed: boolean;
  makerExitArmed: boolean;
  makerExitStartedAt: number | null;
  makerExitFallbackLogged: boolean;
  makerExitHedgeRequotes: number;
  makerExitHedgeFailures: number;
  makerExitHedgeRetryAt: number;
  quiesceReason: string | null;
  makerExitHedge: { orderId: string; price: Decimal; leg: 'left' | 'right'; quantity: Decimal } | null;
  quotes: Map<string, { orderId: string }>;
};
function actorOf(engine: StrategyEngine, id: string): ExitActor {
  return (engine as unknown as { actors: Map<string, ExitActor> }).actors.get(id)!;
}

function setBook(markets: StubMarkets, at: number, lBid: string, lAsk: string, rBid: string, rAsk: string): void {
  const stamp = new Date(at).toISOString();
  markets.set(left, lBid, lAsk, stamp);
  markets.set(right, rBid, rAsk, stamp);
}
/** Take-profit-level book: exit spread (left.ask − right.bid) ≈ 1 bp ≤ takeProfitBps 2. */
function armBook(markets: StubMarkets, at: number): void { setBook(markets, at, '100000', '100010', '100000', '100001'); }
/** Flipped pair (left BUY / right SELL): exit spread (right.ask − left.bid)/left.bid ≈ 1 bp. */
function armBookFlipped(markets: StubMarkets, at: number): void { setBook(markets, at, '100000', '100001', '100009', '100010'); }

function seedOpen(database: Database.Database, id: string): void {
  seedFilled(database, id, 'seed-left', left, 'SELL', '0.1', 'left');
  seedFilled(database, id, 'seed-right', right, 'BUY', '0.1', 'right');
}

const exitQuotes = (g: ScriptedGateway) => g.createdOrders.filter((o) => o.symbol === left && o.type === 'LIMIT');
const hedgeOrders = (g: ScriptedGateway) => g.createdOrders.filter((o) => o.symbol === right && o.type === 'LIMIT');
const marketOrders = (g: ScriptedGateway) => g.createdOrders.filter((o) => o.type === 'MARKET');
const fallbackCount = (rt: TradingRuntime, id: string) =>
  rt.strategyLogs(id).filter((l) => l.event === 'Maker exit fallback').length;
const submitFailCount = (rt: TradingRuntime, id: string) =>
  rt.strategyLogs(id).filter((l) => l.event === 'Leg submission failed').length;

/** Drive a latched exit to the point where one reduce-only hedge limit is resting. */
async function armAndRestHedge(
  engine: StrategyEngine, runtime: TradingRuntime, gateway: ScriptedGateway,
  database: Database.Database, markets: StubMarkets, at: number, id: string,
): Promise<{ exitQuote: { remoteId: string }; hedge: { remoteId: string } }> {
  armBook(markets, at);
  await engine.tick();
  const exitQuote = exitQuotes(gateway)[0]!;
  ackOrder(runtime, exitQuote.remoteId, 'PARTIALLY_FILLED', '0.06', '100010');
  runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
    transaction_id: `txn-${exitQuote.remoteId}`, order_id: exitQuote.remoteId, symbol: left,
    exchange_type: 'BINANCE', side: 'BUY', qty: '0.06', price: '100010', fee: '0.01', rpnl: '0', match_role: 'TAKER', create_time: String(Date.now()),
  } });
  await waitFor(() => runtime.getStrategy(id).openPosition === '0.04');
  await waitFor(() => hedgeOrders(gateway).length === 1);
  await waitFor(() => actorOf(engine, id).makerExitHedge !== null);
  return { exitQuote, hedge: hedgeOrders(gateway)[0]! };
}

describe('QA · MAKER_TAKER exit latch — adversarial', () => {
  // ---------------------------------------------------------------- A1: orphan vs STOP
  it('A1 STOP cancels the resting hedge limit AND the exit quote (no orphan order survives quiesce)', async () => {
    const now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    const { exitQuote, hedge } = await armAndRestHedge(engine, runtime, gateway, database, markets, now, record.id);

    // The hedge order row must be a live, strategy-linked OPEN row — i.e. inside the engine ledger.
    const hedgeRow = database.prepare('SELECT state, strategy_id FROM execution_orders WHERE id = ?')
      .get(actorOf(engine, record.id).makerExitHedge!.orderId) as { state: string; strategy_id: string } | undefined;
    expect(hedgeRow?.strategy_id).toBe(record.id);
    expect(['NEW', 'OPEN', 'PENDING_SUBMIT', 'PARTIALLY_FILLED']).toContain(hedgeRow?.state);

    await engine.stopStrategy(record.id);

    // Both the resting hedge limit and the maker exit quote must be cancelled remotely.
    expect(gateway.cancelledOrders).toContain(hedge.remoteId);
    expect(gateway.cancelledOrders).toContain(exitQuote.remoteId);
    // Strategy linkage survives the stop, so the local rows are terminal (not left "open").
    const after = database.prepare('SELECT state FROM execution_orders WHERE strategy_id = ?').all(record.id) as Array<{ state: string }>;
    expect(after.every((row) => ['CANCELLED', 'FAIL', 'FILLED', 'REMOTE_NOT_FOUND', 'EXPIRED'].includes(row.state))).toBe(true);
  });

  // ---------------------------------------------------------------- A2: two latches collide
  it('A2 with BOTH latches set, the stop-loss market exit runs while the maker-exit hedge limit is still resting', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    const record = await engine.startStrategy({ ...exitConfig, stopLossBps: 30 });
    seedOpen(database, record.id);
    const { hedge } = await armAndRestHedge(engine, runtime, gateway, database, markets, now, record.id);
    const actor = actorOf(engine, record.id);
    expect(actor.makerExitArmed).toBe(true);

    // Spread reverses past the 30 bps stop: entry spread (left.bid − right.ask)/right.ask ≈ 203 bps.
    setBook(markets, now + 5, '100200', '100210', '98000', '98010');
    const before = marketOrders(gateway).length;
    await engine.tick();

    // Observation: the stop-loss latch is now set and two MARKET reduce-only exits were submitted...
    expect(actorOf(engine, record.id).stopLossArmed).toBe(true);
    const market = marketOrders(gateway).slice(before);
    expect(market.some((o) => o.symbol === right && o.side === 'SELL' && o.reduce_only === 'true')).toBe(true);
    expect(market.some((o) => o.symbol === left && o.side === 'BUY' && o.reduce_only === 'true')).toBe(true);
    // ...while the maker 0.06 maker-exit hedge limit on the hedge leg is STILL resting (not cancelled).
    expect(gateway.cancelledOrders).not.toContain(hedge.remoteId);

    // A2b: while the stop is latched, `reconcileExposure` still routes to `ensureMakerExitFlat`, so
    // the passive hedge limit keeps being cancelled and RE-SUBMITTED during the emergency stop.
    now += 1_600;
    setBook(markets, now, '100200', '100210', '98000', '98010');
    await engine.tick();
    expect(actorOf(engine, record.id).makerExitHedgeRequotes).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------- A3: untracked leftover hedge
  it('A3 (latent) an untracked OPEN hedge row is not respected — the armed path rests a SECOND hedge on the same leg', async () => {
    const now = Date.now();
    const { engine, database, markets } = await createHarness({ now: () => now });
    const record = await engine.startStrategy(exitConfig);
    // Maker leg already partially closed, so the hedge target is > 0 once the latch arms.
    seedFilled(database, record.id, 'seed-left', left, 'SELL', '0.04', 'left');
    seedFilled(database, record.id, 'seed-right', right, 'BUY', '0.1', 'right');
    // A reduce-only hedge left open by a prior process that never quiesced it (in-memory bookkeeping
    // is gone, but the venue order — and its local strategy-linked row — survives).
    seedOpenOrderRow(database, record.id, 'orphan-hedge', right, 'SELL', '0.06', 'right');

    armBook(markets, now);
    await engine.tick();   // arms the latch and rests the exit quote
    await engine.tick();   // the armed pass runs ensureMakerExitFlat

    const openRight = database.prepare(
      "SELECT id FROM execution_orders WHERE strategy_id = ? AND strategy_leg = 'right' AND state IN ('PENDING_SUBMIT','PENDING_CANCEL','NEW','OPEN','PARTIALLY_FILLED')")
      .all(record.id) as Array<{ id: string }>;
    // The generic repair path bundles an `openStrategyOrders` check before submitting; the new
    // armed maker-exit path does not, so the orphan and a freshly-rested hedge coexist.
    expect(openRight.length).toBe(2);
  });

  // ---------------------------------------------------------------- A4: non-finite mid
  it('A4 a non-finite hedge mid does NOT reach the venue as a bogus price', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    armBook(markets, now);
    await engine.tick();
    const exitQuote = exitQuotes(gateway)[0]!;
    ackOrder(runtime, exitQuote.remoteId, 'PARTIALLY_FILLED', '0.06', '100010');
    runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
      transaction_id: 'txn-x', order_id: exitQuote.remoteId, symbol: left, exchange_type: 'BINANCE',
      side: 'BUY', qty: '0.06', price: '100010', fee: '0.01', rpnl: '0', match_role: 'TAKER', create_time: String(Date.now()),
    } });
    await waitFor(() => hedgeOrders(gateway).length === 1);
    await waitFor(() => actorOf(engine, record.id).makerExitHedge !== null);
    await new Promise((r) => setTimeout(r, 30)); // let the submit task clear `actor.busy`

    // Expire the hedge TTL so the next pass cancels AND re-prices it, and poison the mid with
    // "Infinity" (decimal.js: new Decimal('Infinity').gt(0) === true, so a finite guard matters).
    now += 2_000;
    markets.set(right, 'Infinity', 'Infinity', new Date(now).toISOString());
    await engine.tick();

    const bad = gateway.createAttempts.filter((o) => o.symbol === right && !/^\d+(\.\d+)?$/.test(o.price ?? ''));
    // The engine has no explicit isFinite guard (`new Decimal('Infinity').gt(0)` is *true*, so it
    // attempts the order), but the runtime's `CreateOrderInputSchema` (`price: /^\d+(\.\d+)?$/`)
    // rejects the non-finite price before it can reach the gateway.
    expect(bad.map((o) => o.price)).toEqual([]);
    expect(runtime.strategyLogs(record.id).some((l) => l.event === 'Leg submission failed')).toBe(true);
    expect(actorOf(engine, record.id).makerExitHedgeRequotes).toBe(1);
  });

  // ---------------------------------------------------------------- A4b: persistent submit rejection (post-fix flip)
  it('A4b a persistently-rejected hedge submit backs off exponentially, strikes on a dedicated counter, and pauses at 5 with an independent reason', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now, requoteIntervalMs: 100_000 });
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    // Every hedge submit fails from the first attempt (venue rejects reduce-only / below-min, etc.).
    gateway.failCreate(right, 1_000);
    armBook(markets, now);
    await engine.tick();
    const exitQuote = exitQuotes(gateway)[0]!;
    ackOrder(runtime, exitQuote.remoteId, 'PARTIALLY_FILLED', '0.06', '100010');
    runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
      transaction_id: 'txn-y', order_id: exitQuote.remoteId, symbol: left, exchange_type: 'BINANCE',
      side: 'BUY', qty: '0.06', price: '100010', fee: '0.01', rpnl: '0', match_role: 'TAKER', create_time: String(Date.now()),
    } });
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.04');
    await new Promise((r) => setTimeout(r, 80)); // let the fill-triggered reconcile settle

    const actor = () => actorOf(engine, record.id);
    const attempts = () => gateway.createAttempts.filter((o) => o.symbol === right).length;
    const logs = () => submitFailCount(runtime, record.id);
    expect(actor().status).toBe('RUNNING');
    // Exactly ONE strike must have landed so far (fill-triggered reconcile, a background tick or
    // the tick above): the backoff gate caps it at one submit per cooldown window.
    if (actor().makerExitHedgeFailures === 0) { armBook(markets, now); await engine.tick(); }
    expect(actor().makerExitHedgeFailures).toBe(1);
    expect(logs()).toBe(1);
    // First rung: 2 000 * 2^1 = 4 s — the counter increments BEFORE the exponent is taken.
    expect(actor().makerExitHedgeRetryAt).toBe(now + 4_000);

    // Inside the cooldown window (still under the 4 s rung): further ticks at the same injected
    // clock must neither re-submit, nor log, nor cancel anything.
    const frozen = { attempts: attempts(), logs: logs(), cancels: gateway.cancelledOrders.length };
    for (let i = 0; i < 4; i += 1) { now += 500; armBook(markets, now); await engine.tick(); }
    expect(attempts()).toBe(frozen.attempts);
    expect(logs()).toBe(frozen.logs);
    expect(gateway.cancelledOrders.length).toBe(frozen.cancels);
    expect(actor().makerExitHedgeFailures).toBe(1);
    expect(actor().status).toBe('RUNNING');

    // Climb the ladder: past each cooldown exactly ONE new attempt lands, rungs 8 s → 16 s → 32 s.
    for (let i = 0; i < 6; i += 1) {
      const a = actor();
      if (!a || a.status !== 'RUNNING') break;
      // Snapshot BEFORE advancing the clock: until `now` crosses the gate, a strike is impossible.
      const before = { attempts: attempts(), logs: logs(), strikes: a.makerExitHedgeFailures };
      now = a.makerExitHedgeRetryAt + 100;
      armBook(markets, now);
      await engine.tick();
      await new Promise((r) => setTimeout(r, 30)); // let the actor queue settle
      expect(attempts()).toBe(before.attempts + 1);
      expect(logs()).toBe(before.logs + 1);
      // `a` is a live reference to the actor object: a 5th strike pauses the strategy and
      // finishQuiesce deletes the actor from the engine's map, but the paused state (counter,
      // gate, reason) was written on this same object before the deletion.
      expect(a.makerExitHedgeFailures).toBe(before.strikes + 1);
      const rung = Math.min(60_000, 2_000 * 2 ** Math.min(4, a.makerExitHedgeFailures));
      expect(a.makerExitHedgeRetryAt - now).toBe(rung);
    }

    // Five consecutive rejections tripped the pause. finishQuiesce removes the in-memory actor,
    // so the end-state is verified from the persisted strategy row and the persisted pause log —
    // whose reason must NOT borrow the two-leg insufficient-margin wording.
    expect(actorOf(engine, record.id)).toBeUndefined();
    expect((database.prepare('SELECT status FROM execution_strategies WHERE id = ?').get(record.id) as { status: string }).status).toBe('PAUSED');
    const pausedLog = runtime.strategyLogs(record.id).find((l) => l.event === 'Strategy paused');
    expect(pausedLog?.result).toBe('Maker exit hedge order was rejected 5 consecutive times; the position cannot unwind automatically — review the hedge leg manually');
    // The quiesce that comes with the pause cleans up the still-resting exit quote.
    expect(gateway.cancelledOrders).toContain(exitQuote.remoteId);
  });

  // ---------------------------------------------------------------- A4c: strike budget resets on success
  it('A4c a successful hedge submit clears the dedicated strike budget — the next failure starts back at the first rung, not the accumulated one', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now, requoteIntervalMs: 100_000 });
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    gateway.failCreate(right, 2); // exactly two strikes, then submissions succeed
    armBook(markets, now);
    await engine.tick();
    const exitQuote = exitQuotes(gateway)[0]!;
    ackOrder(runtime, exitQuote.remoteId, 'PARTIALLY_FILLED', '0.06', '100010');
    runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
      transaction_id: 'txn-z', order_id: exitQuote.remoteId, symbol: left, exchange_type: 'BINANCE',
      side: 'BUY', qty: '0.06', price: '100010', fee: '0.01', rpnl: '0', match_role: 'TAKER', create_time: String(Date.now()),
    } });
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.04');
    await new Promise((r) => setTimeout(r, 80));

    const actor = () => actorOf(engine, record.id);
    if (actor().makerExitHedgeFailures === 0) { armBook(markets, now); await engine.tick(); }
    expect(actor().makerExitHedgeFailures).toBe(1);

    // Second strike after its cooldown, then the next attempt lands successfully...
    now = actor().makerExitHedgeRetryAt + 100;
    armBook(markets, now);
    await engine.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(actor().makerExitHedgeFailures).toBe(2);
    now = actor().makerExitHedgeRetryAt + 100;
    armBook(markets, now);
    await engine.tick();
    await waitFor(() => actor().makerExitHedge !== null);
    await new Promise((r) => setTimeout(r, 30));
    // ...and success zeroes the budget.
    expect(actor().makerExitHedgeFailures).toBe(0);

    // ...so a TTL requote into a fresh rejection strikes rung ONE (4 s), not the 16 s that an
    // accumulated 3-strike counter would produce. The resting hedge is still TTL-cancelled
    // normally — no cooldown is active, so the gate must not skip its settlement.
    gateway.failCreate(right, 1);
    const restingRemote = hedgeOrders(gateway).at(-1)!.remoteId;
    const requotesBefore = actor().makerExitHedgeRequotes;
    now += 1_600; // past the 1.5 s hedge TTL
    armBook(markets, now);
    await engine.tick();
    await waitFor(() => actor().makerExitHedgeRequotes === requotesBefore + 1, 2_000);
    await new Promise((r) => setTimeout(r, 30));
    expect(gateway.cancelledOrders).toContain(restingRemote);
    expect(actor().makerExitHedgeFailures).toBe(1);
    expect(actor().makerExitHedgeRetryAt).toBe(now + 4_000);
  });

  // ---------------------------------------------------------------- A5: exactly one fallback per latch across requotes
  it('A5 Maker exit fallback stays exactly one even across several hedge requotes', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    await armAndRestHedge(engine, runtime, gateway, database, markets, now, record.id);
    expect(fallbackCount(runtime, record.id)).toBe(0);

    // Three TTL requotes before the 30 s budget: still zero fallback rows, three re-prices.
    for (let i = 0; i < 3; i += 1) { now += 1_600; armBook(markets, now); await engine.tick(); }
    expect(fallbackCount(runtime, record.id)).toBe(0);
    expect(actorOf(engine, record.id).makerExitHedgeRequotes).toBe(3);

    // Past the 30 s budget: exactly one row, and it stays one over several ticks.
    now += 30_000;
    for (let i = 0; i < 3; i += 1) { armBook(markets, now); now += 10; await engine.tick(); }
    expect(fallbackCount(runtime, record.id)).toBe(1);
  });

  // ---------------------------------------------------------------- A6: unarmed generic repair intact
  it('A6 (characterisation) the new armed early-return still leaves the unarmed lagging-leg top-up intact', async () => {
    const now = Date.now();
    const { engine, gateway, database, markets } = await createHarness({ now: () => now });
    // Entry-level book: exit spread well outside take-profit, so the latch never arms.
    setBook(markets, now, '100100', '100101', '99999', '100000');
    const record = await engine.startStrategy(exitConfig);
    // A lagging hedge leg: left short 0.1, right long only 0.05.
    seedFilled(database, record.id, 'seed-left', left, 'SELL', '0.1', 'left');
    seedFilled(database, record.id, 'seed-right', right, 'BUY', '0.05', 'right');

    await engine.tick();

    expect(actorOf(engine, record.id).makerExitArmed).toBe(false);
    // Generic repair still tops up the lagging right leg with a market BUY — the armed early-return
    // did not swallow it for the unarmed path.
    expect(marketOrders(gateway).some((o) => o.symbol === right && o.side === 'BUY')).toBe(true);
  });

  // ------------------------------------------------ B1: armed + maker feed death across the 30 s budget
  it('B1 armed + maker-leg feed death past 30 s: fallback fires once, the hedge is trimmed by a reduce-only LIMIT at the widened cap, and the ORIGINAL maker exit quote survives', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);

    // Arm on the take-profit book and rest the maker exit quote.
    armBook(markets, now);
    await engine.tick();
    const exitQuote = exitQuotes(gateway)[0]!;
    // A PARTIAL fill keeps the original exit quote resting — no replacement quote is ever rested —
    // so the "still resting" assertions below cannot pass vacuously on a freshly-rested quote.
    ackOrder(runtime, exitQuote.remoteId, 'PARTIALLY_FILLED', '0.06', '100010');
    runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
      transaction_id: 'txn-b1', order_id: exitQuote.remoteId, symbol: left, exchange_type: 'BINANCE',
      side: 'BUY', qty: '0.06', price: '100010', fee: '0.01', rpnl: '0', match_role: 'TAKER', create_time: String(Date.now()),
    } });
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.04');
    await waitFor(() => hedgeOrders(gateway).length === 1);
    await waitFor(() => actorOf(engine, record.id).makerExitHedge !== null);
    // Anti-vacuous guard: exactly ONE exit quote has ever rested, and it is the original order.
    expect(gateway.createdOrders.filter((o) => o.symbol === left && o.type === 'LIMIT' && o.time_in_force === 'POC')
      .map((o) => o.remoteId)).toEqual([exitQuote.remoteId]);
    expect(gateway.cancelledOrders).not.toContain(exitQuote.remoteId);

    // The maker leg's own feed dies; the hedge leg stays live on a DIFFERENT book than R10 uses so
    // the widened-cap price below is derived independently (mid 200001 × (1 − 10 bps) → 199800.99).
    markets.remove(left);
    now += 30_000;
    markets.set(right, '200000', '200002', new Date(now).toISOString());
    await engine.tick();

    expect(fallbackCount(runtime, record.id)).toBe(1);
    const rehedge = hedgeOrders(gateway)[1]!;
    expect(rehedge).toMatchObject({ symbol: right, side: 'SELL', type: 'LIMIT', time_in_force: 'GTC', reduce_only: 'true' });
    expect(rehedge.price).toBe('199800.99');
    expect(gateway.createdOrders.some((o) => o.type === 'MARKET')).toBe(false);
    // The original maker exit quote was neither withdrawn nor replaced.
    expect(gateway.cancelledOrders).not.toContain(exitQuote.remoteId);
    expect(gateway.createdOrders.filter((o) => o.symbol === left && o.type === 'LIMIT' && o.time_in_force === 'POC')
      .map((o) => o.remoteId)).toEqual([exitQuote.remoteId]);
    expect(actorOf(engine, record.id).quotes.has('exit')).toBe(true);

    // The now-unconditional second `ensureMakerExitFlat` must not stack a second hedge: one more
    // TTL expiry yields exactly one further re-price and still exactly one fallback row.
    now += 1_600;
    markets.set(right, '200000', '200002', new Date(now).toISOString());
    await engine.tick();
    expect(fallbackCount(runtime, record.id)).toBe(1);
    expect(hedgeOrders(gateway)).toHaveLength(3);
    expect(actorOf(engine, record.id).makerExitHedge).not.toBeNull();
  });

  // ------------------------------------------------ B2: exit sizing never derives from `matched`
  it('B2 the maker exit is sized from the maker leg remaining (0.25), never from matched (0.05)', async () => {
    const now = Date.now();
    const { engine, gateway, database, markets } = await createHarness({ now: () => now });
    armBook(markets, now);
    const record = await engine.startStrategy({ ...exitConfig, perOrderQuantity: '0.4' });
    // Maker (left) 0.25 short, hedge (right) 0.05 long ⇒ matched = 0.05, makerRemaining = 0.25.
    seedFilled(database, record.id, 'seed-left', left, 'SELL', '0.25', 'left');
    seedFilled(database, record.id, 'seed-right', right, 'BUY', '0.05', 'right');

    await engine.tick();

    expect(actorOf(engine, record.id).makerExitArmed).toBe(true);
    const quote = exitQuotes(gateway).find((o) => o.side === 'BUY' && o.time_in_force === 'POC')!;
    expect(quote).toBeDefined();
    // exitQuantityFor(min(perOrder 0.4, |maker| 0.25)) = 0.25; `min(perOrder, matched)` = 0.05.
    expect(quote.qty).toBe('0.25');
  });

  // ------------------------------------------------ B3: PAUSE → RESUME leaves no latch/order leak
  it('B3 a PAUSE mid-exit drops the actor, and the RESUME preflight quiesces the surviving hedge + exit quote before re-arming with exactly one fresh quote', async () => {
    const now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now });
    const record = await engine.startStrategy(exitConfig);
    seedOpen(database, record.id);
    const { exitQuote, hedge } = await armAndRestHedge(engine, runtime, gateway, database, markets, now, record.id);

    const stateOf = (remoteId: string) =>
      (database.prepare('SELECT state FROM execution_orders WHERE strategy_id = ? AND remote_order_id = ?')
        .get(record.id, remoteId) as { state: string } | undefined)?.state;

    // PAUSE via the credential-change path. Pre-existing semantics (unchanged by this fix): it marks
    // the strategy PAUSED and drops the actor WITHOUT quiescing, so the resting hedge limit and the
    // partially-filled exit quote survive at the venue until the resume preflight runs.
    expect(engine.pauseRunningStrategiesForCredentialChange(undefined)).toBe(1);
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');
    expect(stateOf(hedge.remoteId)).toBe('NEW');
    expect(stateOf(exitQuote.remoteId)).toBe('PARTIALLY_FILLED');

    // RESUME: the in-memory latch is gone with the actor, and the resume preflight must prove every
    // persisted order terminal (cancelling the survivor) before the strategy may re-arm.
    await engine.resumeStrategy(record.id, DEFAULT_CREDENTIAL_PROFILE);
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    expect(gateway.cancelledOrders).toContain(hedge.remoteId);
    expect(gateway.cancelledOrders).toContain(exitQuote.remoteId);
    const fresh = actorOf(engine, record.id);
    expect(fresh.makerExitArmed).toBe(false);
    expect(fresh.makerExitHedge).toBeNull();

    // Re-arming starts from the live spread: exactly ONE fresh exit quote, and no hedge limit until
    // that quote fills again.
    await engine.tick();
    const rearmed = actorOf(engine, record.id);
    expect(rearmed.makerExitArmed).toBe(true);
    expect(rearmed.makerExitHedge).toBeNull();
    expect(exitQuotes(gateway).filter((o) => o.time_in_force === 'POC')).toHaveLength(2); // retired + fresh
    expect(gateway.createdOrders.filter((o) => o.symbol === right && o.type === 'LIMIT')).toHaveLength(1);
  });

  // ------------------------------------------------ C1: hedge leg SHORT (exit side derivation)
  it('C1 with the hedge leg SHORT, the exit hedge order must BUY to unwind it — a SELL would grow the short and is invalid reduce-only', async () => {
    const now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now, requoteIntervalMs: 100_000 });
    const record = await engine.startStrategy(flippedExitConfig);
    // Maker leg (left) LONG 0.1, hedge leg (right) SHORT 0.1.
    seedFilled(database, record.id, 'seed-left', left, 'BUY', '0.1', 'left');
    seedFilled(database, record.id, 'seed-right', right, 'SELL', '0.1', 'right');

    armBookFlipped(markets, now);
    await engine.tick();
    const exitQuote = exitQuotes(gateway)[0]!;
    // The maker leg's exit quote fills partially: maker remaining 0.04 < hedge 0.1 ⇒ target 0.06.
    ackOrder(runtime, exitQuote.remoteId, 'PARTIALLY_FILLED', '0.06', '100000');
    runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
      transaction_id: 'txn-c1', order_id: exitQuote.remoteId, symbol: left, exchange_type: 'BINANCE',
      side: 'SELL', qty: '0.06', price: '100000', fee: '0.01', rpnl: '0', match_role: 'TAKER', create_time: String(Date.now()),
    } });
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.04');
    await waitFor(() => hedgeOrders(gateway).length === 1, 3_000);

    // Anti-vacuous guard: a hedge order really was submitted before its side is judged.
    expect(actorOf(engine, record.id).makerExitArmed).toBe(true);
    expect(hedgeOrders(gateway)).toHaveLength(1);
    expect(actorOf(engine, record.id).makerExitHedge).not.toBeNull();
    // The hedge leg is SHORT (right exposure −0.1): unwinding it is a BUY of 0.06. A SELL with
    // `reduceOnly: true` against a short position is rejected by the venue and, if it were ever
    // accepted, would grow the very imbalance the exit exists to shrink.
    expect(hedgeOrders(gateway)[0]!.side).toBe('BUY');
    expect(hedgeOrders(gateway)[0]!.reduce_only).toBe('true');
    expect(hedgeOrders(gateway)[0]!.qty).toBe('0.06');
  });

  // ------------------------------------------------ C2: strike-budget consequence + direction pin
  it('C2 (consequence) with the hedge leg SHORT and the venue rejecting every hedge submit, the 5-strike pause fires and the imbalance stays un-unwound — and every attempt is the correct BUY', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now, requoteIntervalMs: 100_000 });
    const record = await engine.startStrategy(flippedExitConfig);
    seedFilled(database, record.id, 'seed-left', left, 'BUY', '0.1', 'left');
    seedFilled(database, record.id, 'seed-right', right, 'SELL', '0.1', 'right');
    // Blanket rejection of every hedge-leg submit (direction-independent): this case is about what
    // happens when the venue refuses to take the unwind order at all, not about which way it points.
    gateway.failCreate(right, 1_000);

    armBookFlipped(markets, now);
    await engine.tick();
    const exitQuote = exitQuotes(gateway)[0]!;
    ackOrder(runtime, exitQuote.remoteId, 'PARTIALLY_FILLED', '0.06', '100000');
    runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
      transaction_id: 'txn-c2', order_id: exitQuote.remoteId, symbol: left, exchange_type: 'BINANCE',
      side: 'SELL', qty: '0.06', price: '100000', fee: '0.01', rpnl: '0', match_role: 'TAKER', create_time: String(Date.now()),
    } });
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.04');
    await new Promise((r) => setTimeout(r, 80)); // let the fill-triggered reconcile settle

    const actor = () => actorOf(engine, record.id);
    if (actor().makerExitHedgeFailures === 0) { armBookFlipped(markets, now); await engine.tick(); }
    expect(actor().makerExitHedgeFailures).toBe(1);
    // Climb the backoff ladder until the strike budget trips (4 s → 8 s → 16 s → 32 s → 32 s).
    for (let i = 0; i < 6; i += 1) {
      const a = actor();
      if (!a || a.status !== 'RUNNING') break;
      now = a.makerExitHedgeRetryAt + 100;
      armBookFlipped(markets, now);
      await engine.tick();
      await new Promise((r) => setTimeout(r, 30));
    }

    // The strategy is paused by the very guard the #52 fix added — and the imbalance the exit was
    // supposed to unwind is still open (no hedge order ever filled).
    expect(actorOf(engine, record.id)).toBeUndefined();
    expect((database.prepare('SELECT status FROM execution_strategies WHERE id = ?').get(record.id) as { status: string }).status).toBe('PAUSED');
    expect(runtime.strategyLogs(record.id).find((l) => l.event === 'Strategy paused')?.result)
      .toBe('Maker exit hedge order was rejected 5 consecutive times; the position cannot unwind automatically — review the hedge leg manually');
    expect(runtime.getStrategy(record.id).openPosition).not.toBe('0');
    // Direction pin, on `createAttempts` (which records REJECTED submits too) rather than
    // `createdOrders` (which only records accepted ones): a filter over `createdOrders` here is
    // empty because every submit was refused, and `.every()` on an empty array is vacuously true.
    const attempts = gateway.createAttempts.filter((o) => o.symbol === right);
    expect(attempts.length).toBeGreaterThanOrEqual(5);
    // Unwinding a SHORT hedge leg is a BUY; a regression back to the absolute-valued
    // `hedgeQuantity` would make every attempt a SELL and turn this red.
    expect(attempts.every((o) => o.side === 'BUY')).toBe(true);
    expect(attempts.every((o) => o.reduce_only === 'true')).toBe(true);
  });

  // ------------------------------------------------ C3: the payoff of the direction fix
  it('C3 (payoff) with the hedge leg SHORT and a venue that refuses the WRONG side only, the BUY hedge fills, both legs go flat, and the latch retires without ever tripping the strike budget', async () => {
    const now = Date.now();
    const { engine, runtime, gateway, database, markets } = await createHarness({ now: () => now, requoteIntervalMs: 100_000 });
    const record = await engine.startStrategy(flippedExitConfig);
    seedFilled(database, record.id, 'seed-left', left, 'BUY', '0.1', 'left');
    seedFilled(database, record.id, 'seed-right', right, 'SELL', '0.1', 'right');
    // Direction-aware venue: a reduce-only SELL against a SHORT hedge leg is refused (as a real
    // exchange would), while the correct BUY is accepted. This is what separates "unwound" from
    // "stuck" — a blanket `failCreate` could not tell the two apart.
    gateway.failCreateIf = (order) => order.symbol === right && order.side === 'SELL';

    armBookFlipped(markets, now);
    await engine.tick();
    const exitQuote = exitQuotes(gateway)[0]!;
    // The whole maker leg closes: left 0.1 → 0, leaving the hedge leg short 0.1 to unwind.
    ackOrder(runtime, exitQuote.remoteId, 'FILLED', '0.1', '100000');
    runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
      transaction_id: 'txn-c3-maker', order_id: exitQuote.remoteId, symbol: left, exchange_type: 'BINANCE',
      side: 'SELL', qty: '0.1', price: '100000', fee: '0.01', rpnl: '0', match_role: 'TAKER', create_time: String(Date.now()),
    } });
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0');
    await waitFor(() => hedgeOrders(gateway).length === 1, 3_000);

    // The unwind order is a BUY of the full 0.1 — and it was ACCEPTED, not rejected.
    const hedge = hedgeOrders(gateway)[0]!;
    expect(hedge).toMatchObject({ symbol: right, side: 'BUY', type: 'LIMIT', time_in_force: 'GTC', reduce_only: 'true' });
    expect(hedge.qty).toBe('0.1');
    expect(gateway.createAttempts.filter((o) => o.symbol === right && o.side === 'SELL')).toEqual([]);

    // It fills: the hedge leg goes flat too, so the exit latch retires.
    ackOrder(runtime, hedge.remoteId, 'FILLED', '0.1', '100000');
    runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
      transaction_id: 'txn-c3-hedge', order_id: hedge.remoteId, symbol: right, exchange_type: 'OKX',
      side: 'BUY', qty: '0.1', price: '100000', fee: '0.01', rpnl: '0', match_role: 'TAKER', create_time: String(Date.now()),
    } });
    // Drive evaluations until the flat pair retires the latch (a fill alone does not re-evaluate).
    for (let i = 0; i < 30 && actorOf(engine, record.id)?.makerExitArmed !== false; i += 1) {
      armBookFlipped(markets, now);
      await engine.tick();
      await new Promise((r) => setTimeout(r, 10));
    }

    // The payoff: flat position, latch retired, strategy still RUNNING, and the strike budget the
    // #52 fix added was never touched — no `Leg submission failed`, no 5-strike pause.
    expect(runtime.getStrategy(record.id).openPosition).toBe('0');
    expect(actorOf(engine, record.id).makerExitArmed).toBe(false);
    expect(actorOf(engine, record.id).makerExitHedge).toBeNull();
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
    expect(submitFailCount(runtime, record.id)).toBe(0);
    expect(runtime.strategyLogs(record.id).some((l) => l.event === 'Strategy paused')).toBe(false);
  });
});
