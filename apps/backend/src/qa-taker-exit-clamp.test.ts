/**
 * Independent adversarial verification of the venue-truth exit clamp on the *taker* exit path
 * (`executeTakerClip` / `reconcileExitQuantity` / `exitQuantityFor`) in `strategy-engine.ts`.
 *
 * This file is additive and self-contained on purpose: it must not depend on, or perturb, the
 * existing suites. It only tries to falsify the uncommitted fix.
 *
 * The venue is simulated truthfully for reduce-only semantics: any reduce-only order whose
 * quantity exceeds what the exchange actually holds on that leg is rejected with
 * `TRADE_REDUCE_ONLY_POSITION_QTY_ERROR`, exactly like the live venue. That is the shape that
 * produced `AUTO-B63B204D` (five `Leg submission failed` rows inside a minute, then a pause).
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

/**
 * A scripted gateway that enforces reduce-only *by size*: a reduce-only order larger than the
 * exchange's real reducible quantity on that leg is rejected with the venue's label. Spot legs
 * are exempt (a spot sell is capped by the balance, not by a position), matching the engine's
 * own `isSpotSymbol` reasoning. Without this, "the fix works" could only be shown by a scripted
 * failure budget that does not model the defect at all.
 */
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
    // Truthful reduce-only enforcement: the venue refuses any reduce-only order larger than the
    // position it actually holds on that (non-spot) leg.
    const reduceOnly = order.reduce_only === 'true';
    if (reduceOnly && order.symbol && !/^[A-Z0-9]+_SPOT_/.test(order.symbol)) {
      const reducible = this.reducibleQuantity(order.symbol, order.side);
      const qty = new Decimal(order.qty ?? '0');
      if (qty.gt(reducible)) throw new GateApiError(400, 'TRADE_REDUCE_ONLY_POSITION_QTY_ERROR');
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
  const directory = mkdtempSync(join(tmpdir(), 'qa-taker-clamp-'));
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

/** The drift correction arms a 250 ms cooldown before re-quoting; wait it out explicitly. */
const pastCooldown = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

const eventsOf = (runtime: TradingRuntime, strategyId: string): Set<string> =>
  new Set(runtime.strategyLogs(strategyId).map((log) => log.event));

// ─── End-to-end: the taker exit clamp ────────────────────────────────────────────────────────

/**
 * A spot(left) + perpetual(right) auto strategy. The perpetual leg is the RIGHT leg, so the
 * venue enforces reduce-only on it — the shape the existing suite never exercises for the taker
 * clamp (the existing taker test uses a perp/perp pair, where the anchor is the left leg).
 */
const spotPerpAuto = {
  kind: 'auto', asset: 'BTC', leftVenue: 'GATE', rightVenue: 'GATE',
  leftSide: 'BUY', rightSide: 'SELL',
  leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'GATE_FUTURE_BTC_USDT',
  entryBps: '10', takeProfitBps: '2', maxPosition: '0.1', perOrderQuantity: '0.1',
  reduceOnly: false, executionMethod: 'TAKER_TAKER',
} as const;

const SPOT = 'GATE_SPOT_BTC_USDT';
const PERP = 'GATE_FUTURE_BTC_USDT';

async function openSpotPerpPosition(harness: Harness): Promise<string> {
  const { engine, markets } = harness;
  // exitSpread = (perp.ask − spot.bid)/spot.bid = 1 bps ≤ 2 → the take-profit exit repeats each
  // tick; entrySpread is negative, far below the 10 bps entry threshold, so nothing re-enters.
  markets.set(SPOT, '100000', '100020');
  markets.set(PERP, '100005', '100010');
  const record = await engine.startStrategy(spotPerpAuto);
  seedFilledStrategyOrder(harness.database, record.id, 'seed-left', SPOT, 'BUY', '0.1', 'left');
  seedFilledStrategyOrder(harness.database, record.id, 'seed-right', PERP, 'SELL', '0.1', 'right');
  return record.id;
}

describe('qa: taker exit clamp (spot + perp, perpetual leg is the RIGHT leg)', () => {
  it('clamps to the venue size, re-reports a consistent hedge, and never burns the 5-strike budget', async () => {
    const harness = await createHarness();
    const { engine, runtime, gateway } = harness;
    const id = await openSpotPerpPosition(harness);
    // The venue closed most of the perpetual position outside the engine: only 0.04 short remains.
    gateway.positions = [futuresPosition(PERP, 'SHORT', '0.04')];

    // Tick 1: the ledger believes 0.1 and the venue rejects the oversized reduce-only exit.
    await engine.tick();
    await waitFor(() => eventsOf(runtime, id).has('Exit size corrected'));
    expect(gateway.createAttempts[0]).toMatchObject({ symbol: SPOT, side: 'SELL', type: 'MARKET', qty: '0.1' });
    expect(gateway.createAttempts[1]).toMatchObject({ symbol: PERP, side: 'BUY', type: 'MARKET', qty: '0.1', reduce_only: 'true' });
    expect(eventsOf(runtime, id).has('Leg submission failed')).toBe(false);
    expect(runtime.getStrategy(id).status).toBe('RUNNING');

    // Tick 2+: re-report at the venue's real size; the hedge is scaled by the same factor, so the
    // spot leg exits 0.04 too (ratio 1). Every later tick must keep succeeding — no strike, no pause.
    for (let tick = 2; tick <= 7; tick += 1) {
      await pastCooldown();
      await engine.tick();
    }
    const after = gateway.createAttempts.slice(2);
    expect(after.length).toBeGreaterThan(0);
    for (const attempt of after) {
      expect(attempt.qty).toBe('0.04');
      expect(attempt.reduce_only).toBe('true');
    }
    expect(after.some((a) => a.symbol === SPOT && a.side === 'SELL')).toBe(true);
    expect(after.some((a) => a.symbol === PERP && a.side === 'BUY')).toBe(true);
    expect(eventsOf(runtime, id).has('Leg submission failed')).toBe(false);
    expect(runtime.strategyLogs(id).some((log) => log.event === 'Strategy paused')).toBe(false);
    expect(runtime.getStrategy(id).status).toBe('RUNNING');
    expect(engine.listActiveStrategyIds()).toEqual([id]);
    // Six re-report ticks, each waiting out the reconcile cooldown and its order timeout — the
    // point of the loop is that no strike accumulates, so the wall clock is inherent, not a hang.
  }, 15_000);

  it('still pauses immediately when the venue holds nothing reducible on the RIGHT leg', async () => {
    const harness = await createHarness();
    const { engine, runtime, gateway } = harness;
    const id = await openSpotPerpPosition(harness);
    gateway.positions = []; // the position was closed outside the engine

    await engine.tick();
    await waitFor(() => runtime.getStrategy(id).status === 'PAUSED');
    const paused = runtime.strategyLogs(id).find((log) => log.event === 'Strategy paused');
    expect(paused).toBeDefined();
    expect(/holds no reducible position/i.test(paused?.result ?? '')).toBe(true);
    expect(eventsOf(runtime, id).has('Leg submission failed')).toBe(false);
    expect(engine.listActiveStrategyIds()).toEqual([]);
  });
});

// ─── Unit-level: the clamp arithmetic and its leg/unit guards ─────────────────────────────────

type AnyEngine = {
  actors: Map<string, Record<string, unknown>>;
  exitQuantityFor(actor: unknown, symbol: string, ledgerQuantity: Decimal): Decimal;
  executeTakerClip(actor: unknown, intent: 'entry' | 'exit', quantity: Decimal, condition: string, rightQuantityOverride?: Decimal): Promise<void>;
};

const SKHY = 'GATE_FUTURE_SKHY_USDT';
const SKHYNIX = 'GATE_FUTURE_SKHYNIX_USDT';

async function startPremium(harness: Harness): Promise<{ id: string; actor: Record<string, unknown> }> {
  const { engine, markets } = harness;
  markets.set(SKHY, '229.9', '230.0');
  markets.set(SKHYNIX, '1700', '1700');
  const record = await engine.startStrategy({
    kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
    leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
    entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
    reduceOnly: false, executionMethod: 'TAKER_TAKER',
  });
  const actor = (engine as unknown as AnyEngine).actors.get(record.id);
  if (!actor) throw new Error('actor missing');
  return { id: record.id, actor };
}

const setClamp = (actor: Record<string, unknown>, symbol: string, quantity: string): void => {
  actor.venueExitQuantity = new Decimal(quantity);
  actor.venueExitQuantitySymbol = symbol;
};

/**
 * A plausible venue position for the premium pair so the reduce-only-by-size venue *accepts* the
 * exits under test. The ADR leg was sold short at entry (a BUY exit reduces it), the hedge leg
 * was bought long (a SELL exit reduces it).
 */
const seedVenuePositions = (harness: Harness): void => {
  harness.gateway.positions = [
    futuresPosition(SKHY, 'SHORT', '0.2'),
    futuresPosition(SKHYNIX, 'LONG', '0.2'),
  ];
};

describe('qa: exitQuantityFor leg/unit guards', () => {
  it('returns the ledger quantity when no clamp is set', async () => {
    const harness = await createHarness();
    const { actor } = await startPremium(harness);
    const engine = harness.engine as unknown as AnyEngine;
    expect(engine.exitQuantityFor(actor, SKHY, new Decimal('0.5')).toString()).toBe('0.5');
  });

  it('clamps only the leg it was measured for, and never applies across legs', async () => {
    const harness = await createHarness();
    const { actor } = await startPremium(harness);
    const engine = harness.engine as unknown as AnyEngine;
    setClamp(actor, SKHY, '0.06');

    // The other leg's request is untouched, and the clamp survives (not consumed by the wrong leg).
    expect(engine.exitQuantityFor(actor, SKHYNIX, new Decimal('0.01')).toString()).toBe('0.01');
    expect(String(actor.venueExitQuantity)).toBe('0.06');
    expect(actor.venueExitQuantitySymbol).toBe(SKHY);

    // Its own leg is clamped...
    expect(engine.exitQuantityFor(actor, SKHY, new Decimal('0.1')).toString()).toBe('0.06');
    // ...and retires once the ledger falls to it.
    expect(engine.exitQuantityFor(actor, SKHY, new Decimal('0.06')).toString()).toBe('0.06');
    expect(actor.venueExitQuantity).toBeNull();
    expect(actor.venueExitQuantitySymbol).toBeNull();
  });
});

describe('qa: executeTakerClip scales the hedge leg by the same factor', () => {
  it('left-perp (ratio 10): clamped 0.06 on the ADR leg ⇒ hedge leg 0.006, not 0.01', async () => {
    const harness = await createHarness();
    const { actor } = await startPremium(harness);
    const { engine, gateway } = harness;
    seedVenuePositions(harness);
    setClamp(actor, SKHY, '0.06');

    await (engine as unknown as AnyEngine).executeTakerClip(actor, 'exit', new Decimal('0.1'), 'qa ratio scaling');

    expect(gateway.createAttempts).toHaveLength(2);
    expect(gateway.createAttempts[0]).toMatchObject({ symbol: SKHY, side: 'BUY', type: 'MARKET', qty: '0.06', reduce_only: 'true' });
    expect(gateway.createAttempts[1]).toMatchObject({ symbol: SKHYNIX, side: 'SELL', type: 'MARKET', qty: '0.006', reduce_only: 'true' });
  });

  it('no clamp ⇒ left-perp submits exactly the pre-change quantities (0.1 / 0.01)', async () => {
    const harness = await createHarness();
    const { actor } = await startPremium(harness);
    const { engine, gateway } = harness;
    seedVenuePositions(harness);

    await (engine as unknown as AnyEngine).executeTakerClip(actor, 'exit', new Decimal('0.1'), 'qa no clamp');

    expect(gateway.createAttempts).toHaveLength(2);
    expect(gateway.createAttempts[0]).toMatchObject({ symbol: SKHY, side: 'BUY', qty: '0.1' });
    expect(gateway.createAttempts[1]).toMatchObject({ symbol: SKHYNIX, side: 'SELL', qty: '0.01' });
  });

  it('a clamp recorded for the other leg never clamps an exit (no cross-leg contamination)', async () => {
    const harness = await createHarness();
    const { actor } = await startPremium(harness);
    const { engine, gateway } = harness;
    seedVenuePositions(harness);
    setClamp(actor, SKHYNIX, '0.006'); // measured on the hedge leg; the ADR leg is the perp anchor

    await (engine as unknown as AnyEngine).executeTakerClip(actor, 'exit', new Decimal('0.1'), 'qa cross-leg');

    expect(gateway.createAttempts[0]).toMatchObject({ symbol: SKHY, side: 'BUY', qty: '0.1' });
    expect(gateway.createAttempts[1]).toMatchObject({ symbol: SKHYNIX, side: 'SELL', qty: '0.01' });
    expect(String(actor.venueExitQuantity)).toBe('0.006'); // untouched
  });

  it('does not divide by zero or submit a zero-size order when the requested quantity is zero', async () => {
    const harness = await createHarness();
    const { actor } = await startPremium(harness);
    const { engine, gateway } = harness;
    setClamp(actor, SKHY, '0.06');

    await expect(
      (engine as unknown as AnyEngine).executeTakerClip(actor, 'exit', new Decimal('0'), 'qa zero'),
    ).resolves.toBeUndefined();
    expect(gateway.createAttempts.every((attempt) => attempt.qty !== '0')).toBe(true);
  });
});
