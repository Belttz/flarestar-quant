/**
 * Adversarial QA suite for the uncommitted "recovered RUNNING strategy re-subscribes its leg
 * markets" fix (strategy-engine.ts `activatePersistedStrategies` + `ensureActorMarkets`).
 *
 * The implementer's own test proves the happy path with a stub market source. This suite is
 * deliberately hostile: it drives the *real* CrossExMarketHub over a real WebSocket server to
 * prove the subscription actually reaches the wire, exercises the error/edge paths the fix could
 * have missed (registration before the socket is open, ref counting, account filtering, non-seed
 * symbols, the closePlan branch, and every strategy kind).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { WebSocketServer } from 'ws';
import type WebSocketDefault from 'ws';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { MemoryCredentialVault } from './credential-vault.js';
import type { ReadOnlyCrossExGateway } from './crossex-client.js';
import { CrossExMarketHub, type LiveMarket, type MarketDefinition } from './market-hub.js';
import { StrategyEngine, type MarketSource } from './strategy-engine.js';
import { TradingRuntime } from './trading-runtime.js';
import { TradingSession } from './trading-session.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures & harness
// ─────────────────────────────────────────────────────────────────────────────

type ServerSocket = WebSocketDefault;

interface WireFrame { event?: unknown; channel?: unknown; payload?: unknown }

function symbolDefinition(symbol: string): MarketDefinition {
  const [venue, , asset] = symbol.split('_');
  return { symbol, venue: venue as MarketDefinition['venue'], asset: asset ?? symbol };
}

/** Build a MarketSource backed by a *real* hub, mirroring app.ts's production wiring. */
function hubBackedSource(hub: CrossExMarketHub): MarketSource {
  return {
    market: (symbol) => hub.market(symbol),
    ensureMarket: (symbol) => {
      if (hub.market(symbol)) return true;
      hub.ensureMarkets([symbolDefinition(symbol)]);
      return hub.market(symbol) !== null;
    },
    watchQuotes: (symbols) => hub.watchQuotes(symbols),
  };
}

/** Records every ensure/watch call so ref counts and fan-out are directly observable. */
class RecordingMarkets implements MarketSource {
  private readonly markets = new Map<string, LiveMarket>();
  readonly ensureCalls: string[] = [];
  readonly watchCalls: string[][] = [];
  releases = 0;
  ensureResult = true;

  market(symbol: string): LiveMarket | null { return this.markets.get(symbol) ?? null; }
  ensureMarket(symbol: string): boolean { this.ensureCalls.push(symbol); return this.ensureResult; }
  watchQuotes(symbols: string[]): () => void {
    this.watchCalls.push([...symbols]);
    let released = false;
    return () => { if (released) return; released = true; this.releases += 1; };
  }
}

interface EngineHarness {
  database: Database.Database;
  runtime: TradingRuntime;
  engine: StrategyEngine;
  directory: string;
  session: TradingSession;
}

const engines: EngineHarness[] = [];
const hubHarnesses: Array<{ hub: CrossExMarketHub; server: WebSocketServer }> = [];

function makeDatabase(): { database: Database.Database; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-qa-recovery-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
  });
  return { database: openDatabase(config.databasePath, config.migrationsDir), directory };
}

function createEngine(
  database: Database.Database,
  directory: string,
  markets: MarketSource,
): EngineHarness {
  const session = new TradingSession();
  session.set('live');
  const vault = new MemoryCredentialVault();
  // Recovery never touches the gateway (no orders to reconcile), so a bare cast is enough.
  const runtime = new TradingRuntime(database, session, vault, {} as unknown as ReadOnlyCrossExGateway);
  const engine = new StrategyEngine(database, session, runtime, markets, { tickIntervalMs: 20, orderTimeoutMs: 400 });
  const harness = { database, runtime, engine, directory, session };
  engines.push(harness);
  return harness;
}

function insertRunningStrategy(
  database: Database.Database,
  record: { id: string; kind: string; config: unknown; accountProfileId?: string | null; createdAt?: string },
): void {
  const now = record.createdAt ?? new Date().toISOString();
  database.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json,
    progress, filled_quantity, filled_left, filled_right, open_position, credential_profile_id,
    credential_profile_label, created_at, updated_at, stopped_at)
    VALUES (?, ?, 'live', 'RUNNING', ?, 0, '0', '0', '0', '0', ?, NULL, ?, ?, NULL)`)
    .run(record.id, record.kind, JSON.stringify(record.config), record.accountProfileId ?? null, now, now);
}

function resumedLogCount(harness: EngineHarness, id: string): number {
  return harness.runtime.strategyLogs(id).filter((log) => log.event === 'Strategy resumed').length;
}

async function createHub(maxDynamicSymbols?: number): Promise<{
  hub: CrossExMarketHub;
  server: WebSocketServer;
  received: WireFrame[];
  connection: Promise<ServerSocket>;
}> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((done) => server.once('listening', done));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('missing server address');
  const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`, maxDynamicSymbols ? { maxDynamicSymbols } : {});
  const received: WireFrame[] = [];
  const connection = new Promise<ServerSocket>((resolveConnection) => server.once('connection', resolveConnection));
  server.on('connection', (socket: ServerSocket) => {
    socket.on('message', (data: { toString(): string }) => received.push(JSON.parse(data.toString()) as WireFrame));
  });
  hubHarnesses.push({ hub, server });
  return { hub, server, received, connection };
}

function subscribedSymbols(received: WireFrame[], channel: string): Set<string> {
  const symbols = new Set<string>();
  for (const frame of received) {
    if (frame.event !== 'subscribe' || frame.channel !== channel || !Array.isArray(frame.payload)) continue;
    for (const symbol of frame.payload) if (typeof symbol === 'string') symbols.add(symbol);
  }
  return symbols;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((done) => setTimeout(done, 10));
  }
}

afterEach(async () => {
  for (const harness of engines.splice(0)) {
    await harness.engine.stop();
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
  for (const { hub, server } of hubHarnesses.splice(0)) {
    hub.stop();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Strategy configs — every symbol below is a NON-seed dynamic symbol on purpose,
// so a no-op "fix" cannot pass by leaning on the hub's ~80 seeded markets.
// ─────────────────────────────────────────────────────────────────────────────

const positionConfig = {
  kind: 'position', asset: 'XDP', leftVenue: 'BINANCE', rightVenue: 'OKX',
  leftSide: 'SELL', rightSide: 'BUY', entryBps: '10', totalAmount: '0.2',
  perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
  leftSymbol: 'BINANCE_FUTURE_XDP_USDT', rightSymbol: 'OKX_FUTURE_XDP_USDT',
} as const;
const LEFT = positionConfig.leftSymbol;
const RIGHT = positionConfig.rightSymbol;

const autoConfig = {
  kind: 'auto', asset: 'HYPE', leftVenue: 'BINANCE', rightVenue: 'OKX',
  leftSide: 'SELL', rightSide: 'BUY', entryBps: '10', takeProfitBps: '2', maxPosition: '0.1',
  perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
  leftSymbol: 'BINANCE_FUTURE_HYPE_USDT', rightSymbol: 'OKX_FUTURE_HYPE_USDT',
} as const;

const premiumConfig = {
  kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
  leftVenue: 'BINANCE', rightVenue: 'HYPERLIQUID', leftSide: 'SELL', rightSide: 'BUY',
  entryPremiumPct: '5', takeProfitPremiumPct: '1', maxPosition: '0.1', perOrderQuantity: '0.1',
  reduceOnly: false, executionMethod: 'TAKER_TAKER',
  leftSymbol: 'BINANCE_FUTURE_SKHY_USDT', rightSymbol: 'HYPERLIQUID_FUTURE_SKHX_USDC',
} as const;

const carryConfig = {
  kind: 'carry', asset: 'XRP', leftVenue: 'GATE', rightVenue: 'BINANCE',
  leftSide: 'BUY', rightSide: 'SELL', fundingDirection: 'POSITIVE', fundingAprMin: 15, basisTakeProfitBps: 5,
  totalAmount: '0.1', perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
  leftSymbol: 'GATE_SPOT_XRP_USDT', rightSymbol: 'BINANCE_FUTURE_XRP_USDT',
} as const;

const CLOSE_SYMBOL = 'BINANCE_FUTURE_NATGAS_USDT';
const closePlanConfig = {
  kind: 'position', asset: 'NATGAS', leftVenue: 'BINANCE', rightVenue: 'OKX',
  leftSide: 'SELL', rightSide: 'BUY', totalAmount: '0.2', perOrderQuantity: '0.1',
  reduceOnly: true, executionMethod: 'TAKER_TAKER',
  closePlan: {
    orderCount: 2, intervalSeconds: 5,
    targets: [{ symbol: CLOSE_SYMBOL, side: 'SELL', quantity: '0.1', positionSide: 'NONE' }],
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Edge #1 + #4 — the recovery registration must still reach the wire after the
// socket opens, and it must work for symbols the hub does not seed.
// ─────────────────────────────────────────────────────────────────────────────

describe('QA · recovery re-subscription reaches the wire (edge #1/#4)', () => {
  it('engine recovery subscribes a NON-seed leg pair that arrives only after the socket opens', async () => {
    const { hub, received, connection } = await createHub();
    const { database, directory } = makeDatabase();
    const harness = createEngine(database, directory, hubBackedSource(hub));
    insertRunningStrategy(database, { id: 'PAIR-XDP', kind: 'position', config: positionConfig });

    // Both symbols are deliberately absent from the hub's seed set: a no-op fix would leave them
    // unregistered and the assertion below would fail.
    expect(hub.isSeedAsset('XDP')).toBe(false);

    // Production ordering: the hub starts dialing, then recovery runs synchronously — while the
    // socket is still CONNECTING (no open handler has fired yet).
    hub.start();
    harness.engine.activatePersistedStrategies();

    // Registration is synchronous and observable before any frame is delivered...
    expect(hub.market(LEFT)).not.toBeNull();
    expect(hub.market(RIGHT)).not.toBeNull();

    await connection;
    await waitFor(() => subscribedSymbols(received, 'ticker').has(LEFT)
      && subscribedSymbols(received, 'ticker').has(RIGHT));
    // The queued subscription set is flushed by the socket `open` handler, so both recovered legs
    // end up subscribed on the wire even though registration happened before the connection was up.
    expect([...subscribedSymbols(received, 'ticker')]).toEqual(expect.arrayContaining([LEFT, RIGHT]));
    expect(subscribedSymbols(received, 'funding_rate').has(LEFT)).toBe(true);
    expect(subscribedSymbols(received, 'open_interest').has(RIGHT)).toBe(true);
  });

  it('queues a registration made before hub.start() and flushes it on connect (socket-null path)', async () => {
    const { hub, received, connection } = await createHub();
    // Register *before* the hub ever starts: shardFor creates the shard but connectShard is a
    // no-op while stopped, so the socket stayed null and the subscription had to be remembered.
    hub.ensureMarkets([symbolDefinition(LEFT), symbolDefinition(RIGHT)]);
    const release = hub.watchQuotes([LEFT, RIGHT]);
    hub.start();

    await connection;
    await waitFor(() => subscribedSymbols(received, 'ticker').has(LEFT)
      && subscribedSymbols(received, 'ticker').has(RIGHT));
    expect([...subscribedSymbols(received, 'ticker')]).toEqual(expect.arrayContaining([LEFT, RIGHT]));
    release();
  });

  it('keeps a recovered symbol pinned against dynamic-budget eviction only while the watch is held', async () => {
    const { hub, connection } = await createHub(1);
    hub.start();
    await connection;
    hub.ensureMarkets([symbolDefinition(LEFT)]);

    // Held watch ⇒ the symbol is "actively watched" and must survive a budget overflow.
    const release = hub.watchQuotes([LEFT]);
    hub.ensureMarkets([symbolDefinition('GATE_FUTURE_HYPE_USDT')]);
    expect(hub.market(LEFT)).not.toBeNull();
    // ...whereas the newcomer could not be admitted because nothing was evictable.
    expect(hub.market('GATE_FUTURE_HYPE_USDT')).toBeNull();

    // Released ⇒ the same overflow now evicts the recovered symbol.
    release();
    hub.ensureMarkets([symbolDefinition('GATE_FUTURE_HYPE_USDT')]);
    expect(hub.market(LEFT)).toBeNull();
    expect(hub.market('GATE_FUTURE_HYPE_USDT')).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge #2 — ref counting, no leakage, no duplicate activation
// ─────────────────────────────────────────────────────────────────────────────

describe('QA · recovered subscription ref counting (edge #2)', () => {
  it('releases the recovered leg subscription exactly once on stop', async () => {
    const { database, directory } = makeDatabase();
    const markets = new RecordingMarkets();
    const harness = createEngine(database, directory, markets);
    insertRunningStrategy(database, { id: 'PAIR-STOP', kind: 'position', config: positionConfig });

    harness.engine.activatePersistedStrategies();
    expect(markets.watchCalls).toEqual([[LEFT, RIGHT]]);
    expect(markets.ensureCalls).toEqual(expect.arrayContaining([LEFT, RIGHT]));
    expect(markets.releases).toBe(0);

    await harness.engine.stopStrategy('PAIR-STOP');
    expect(markets.releases).toBe(1);
    // Idempotent: a repeated stop must not release the same recovered subscription twice.
    await harness.engine.stopStrategy('PAIR-STOP');
    expect(markets.releases).toBe(1);
  });

  it('releases every recovered subscription when trading is locked (suspendForTradingLock)', async () => {
    const { database, directory } = makeDatabase();
    const markets = new RecordingMarkets();
    const harness = createEngine(database, directory, markets);
    insertRunningStrategy(database, { id: 'PAIR-LOCK-A', kind: 'position', config: positionConfig });
    insertRunningStrategy(database, {
      id: 'PAIR-LOCK-B', kind: 'position',
      config: { ...positionConfig, leftSymbol: 'BINANCE_FUTURE_HYPE_USDT', rightSymbol: 'OKX_FUTURE_HYPE_USDT' },
    });

    harness.engine.activatePersistedStrategies();
    expect(markets.watchCalls.length).toBe(2);
    expect(harness.engine.listActiveStrategyIds().sort()).toEqual(['PAIR-LOCK-A', 'PAIR-LOCK-B']);

    const unresolved = await harness.engine.suspendForTradingLock();
    expect(unresolved).toEqual([]);
    expect(markets.releases).toBe(2);
    expect(harness.engine.listActiveStrategyIds()).toEqual([]);
  });

  it('does not re-subscribe or re-log when activation runs twice (start batch + live-activation batch)', async () => {
    const { database, directory } = makeDatabase();
    const markets = new RecordingMarkets();
    const harness = createEngine(database, directory, markets);
    insertRunningStrategy(database, { id: 'PAIR-DUP', kind: 'position', config: positionConfig });

    // app.ts invokes recovery once from engine.start() and again from the live-activation route.
    harness.engine.activatePersistedStrategies();
    harness.engine.activatePersistedStrategies();

    expect(markets.watchCalls).toEqual([[LEFT, RIGHT]]);
    expect(markets.ensureCalls).toEqual([LEFT, RIGHT]);
    expect(markets.releases).toBe(0);
    expect(resumedLogCount(harness, 'PAIR-DUP')).toBe(1);
    expect(harness.engine.listActiveStrategyIds()).toEqual(['PAIR-DUP']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge #3 — account filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('QA · account filtering on recovery (edge #3)', () => {
  it('subscribes only the strategies owned by the activating credential profile', async () => {
    const { database, directory } = makeDatabase();
    const markets = new RecordingMarkets();
    const harness = createEngine(database, directory, markets);
    insertRunningStrategy(database, {
      id: 'ACCT-A', kind: 'position', accountProfileId: 'acct-A',
      config: { ...positionConfig, leftSymbol: 'BINANCE_FUTURE_AAVE_USDT', rightSymbol: 'OKX_FUTURE_AAVE_USDT' },
    });
    insertRunningStrategy(database, {
      id: 'ACCT-B', kind: 'position', accountProfileId: 'acct-B',
      config: { ...positionConfig, leftSymbol: 'BINANCE_FUTURE_LINK_USDT', rightSymbol: 'OKX_FUTURE_LINK_USDT' },
    });
    // Legacy row with no owner — documented as belonging to the active account.
    insertRunningStrategy(database, {
      id: 'ACCT-NULL', kind: 'position', accountProfileId: null,
      config: { ...positionConfig, leftSymbol: 'GATE_FUTURE_SUI_USDT', rightSymbol: 'BINANCE_FUTURE_SUI_USDT' },
    });

    harness.engine.activatePersistedStrategies('acct-A');

    expect(harness.engine.listActiveStrategyIds().sort()).toEqual(['ACCT-A', 'ACCT-NULL']);
    const watched = new Set(markets.watchCalls.flat());
    // The other account's symbols must not be registered or watched...
    expect(watched.has('BINANCE_FUTURE_LINK_USDT')).toBe(false);
    expect(watched.has('OKX_FUTURE_LINK_USDT')).toBe(false);
    expect(markets.ensureCalls).not.toContain('BINANCE_FUTURE_LINK_USDT');
    // ...while the activating account and the ownerless legacy row both are.
    expect(watched.has('BINANCE_FUTURE_AAVE_USDT')).toBe(true);
    expect(watched.has('GATE_FUTURE_SUI_USDT')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge #5 — the closePlan branch registers AND watches (gap closed by the G1 fix:
// the recovery closePlan path now holds a quote watch, mirroring start/resume)
// ─────────────────────────────────────────────────────────────────────────────

describe('QA · closePlan recovery branch (edge #5)', () => {
  it('watches the close target so a budget overflow cannot evict it, like a watched paired strategy, and reports the refusal through the warn sink', async () => {
    // Budget of 3 admits exactly the close target (1) + the paired strategy's two legs (2).
    const { hub, connection } = await createHub(3);
    const { database, directory } = makeDatabase();
    const harness = createEngine(database, directory, hubBackedSource(hub));
    insertRunningStrategy(database, { id: 'CLOSE-NATGAS', kind: 'position', config: closePlanConfig });
    insertRunningStrategy(database, {
      id: 'PAIR-HYPE', kind: 'position',
      config: { ...positionConfig, leftSymbol: 'BINANCE_FUTURE_HYPE_USDT', rightSymbol: 'OKX_FUTURE_HYPE_USDT' },
    });

    hub.start();
    await connection;
    harness.engine.activatePersistedStrategies();

    // All recovered: the close target and both paired legs are registered (for `market()` refresh +
    // min-notional math)...
    expect(hub.market(CLOSE_SYMBOL)).not.toBeNull();
    expect(hub.market('BINANCE_FUTURE_HYPE_USDT')).not.toBeNull();
    expect(hub.market('OKX_FUTURE_HYPE_USDT')).not.toBeNull();

    // ...and the close target now holds its own quote watch too, mirroring start/resume. A budget
    // overflow therefore cannot evict it (the pre-fix branch left it unwatched, so it was the first
    // casualty). Every registered symbol is pinned, so nothing is evicted and the extra symbol is
    // refused instead — exactly the settlement-feed protection the G1 fix adds.
    // The refusal must also be VISIBLE: the hub's degradation sink (wired to the logger in
    // production) has to report the exhausted budget instead of failing silently.
    const warnings: Array<{ reason: string; detail?: Record<string, unknown> }> = [];
    // `warn` is `private readonly` in TS only — it is a plain instance property read at call time,
    // so capturing it from the test (confined to this case) needs no constructor surgery.
    (hub as unknown as { warn: (reason: string, detail?: Record<string, unknown>) => void }).warn =
      (reason, detail) => warnings.push({ reason, detail });
    const refused = hub.ensureMarkets([symbolDefinition('GATE_FUTURE_HYPE_USDT')]);
    expect(refused).toBe(false);
    expect(warnings.map((w) => w.reason)).toEqual(['market_hub_dynamic_budget_exhausted']);
    expect(warnings[0]!.detail).toMatchObject({ requested: 1, admitted: 0, refused: 1, budget: 3, used: 3 });
    expect(warnings[0]!.detail?.symbols).toEqual(['GATE_FUTURE_HYPE_USDT']);
    expect(hub.market(CLOSE_SYMBOL)).not.toBeNull();
    expect(hub.market('BINANCE_FUTURE_HYPE_USDT')).not.toBeNull();
    expect(hub.market('OKX_FUTURE_HYPE_USDT')).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge #7 — every strategy kind re-subscribes on recovery
// ─────────────────────────────────────────────────────────────────────────────

describe('QA · every strategy kind re-subscribes on recovery (edge #7)', () => {
  it('registers and watches the leg symbols for position, auto, premium and carry', async () => {
    const { database, directory } = makeDatabase();
    const markets = new RecordingMarkets();
    const harness = createEngine(database, directory, markets);
    insertRunningStrategy(database, { id: 'K-POS', kind: 'position', config: positionConfig });
    insertRunningStrategy(database, { id: 'K-AUTO', kind: 'auto', config: autoConfig });
    insertRunningStrategy(database, { id: 'K-PREM', kind: 'premium', config: premiumConfig });
    insertRunningStrategy(database, { id: 'K-CARRY', kind: 'carry', config: carryConfig });

    harness.engine.activatePersistedStrategies();
    expect(harness.engine.listActiveStrategyIds().sort()).toEqual(['K-AUTO', 'K-CARRY', 'K-POS', 'K-PREM']);

    const pairs = markets.watchCalls.map((call) => call.join('|'));
    for (const config of [positionConfig, autoConfig, premiumConfig, carryConfig]) {
      const expected = [config.leftSymbol, config.rightSymbol].join('|');
      expect(pairs).toContain(expected);
    }
    const ensured = new Set(markets.ensureCalls);
    for (const config of [positionConfig, autoConfig, premiumConfig, carryConfig]) {
      expect(ensured.has(config.leftSymbol)).toBe(true);
      expect(ensured.has(config.rightSymbol)).toBe(true);
    }
  });
});
