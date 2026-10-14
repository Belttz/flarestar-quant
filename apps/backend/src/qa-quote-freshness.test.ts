/**
 * Adversarial (fresh-eyes) verification of the price/time alignment fix.
 *
 * The defect: `LiveMarket.updatedAt`/`receivedAt` describe whichever frame just arrived, and a
 * sparse ticker carrying only `lp` refreshes both while leaving bid/ask at whatever the last
 * quote-carrying frame produced. `freshMarket()` judged the quote by the frame's age, so a
 * minute-old bid/ask passed as fresh market data and the engine computed spreads from prices
 * that never coexisted — the fills-far-from-triggered-bps symptom.
 *
 * The fix: the hub stamps `quoteUpdatedAt` with the exchange time of the frame (or order-book
 * update) that actually supplied the quote, and only once BOTH sides are resolved; the engine
 * gates on that stamp and additionally requires the two legs' quotes to be contemporaneous.
 *
 * Nothing here mutates tracked files; the harness is self-contained on purpose so the author's
 * own suites are never imported (importing them would re-run them).
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
import { DEFAULT_CREDENTIAL_PROFILE, MemoryCredentialVault } from './credential-vault.js';
import type { TradingCrossExGateway } from './crossex-client.js';
import { CrossExMarketHub, type MarketDefinition } from './market-hub.js';
import { StrategyEngine, type MarketSource } from './strategy-engine.js';
import { TradingRuntime } from './trading-runtime.js';
import { TradingSession } from './trading-session.js';

type ServerSocket = WebSocketDefault;

interface WireFrame { event?: unknown; channel?: unknown; payload?: unknown }

const SYMBOL = 'GATE_FUTURE_BTC_USDT';
const QUOTE_TS = 1_771_990_800_000;
const LATER_TS = 1_771_990_830_000;
const BOOK_TS = 1_771_990_900_000;

const harnesses: Array<{ hub: CrossExMarketHub; server: WebSocketServer }> = [];
const engines: Array<{ engine: StrategyEngine; database: Database.Database; directory: string }> = [];

async function createHub(): Promise<{ hub: CrossExMarketHub; server: WebSocketServer; socket: ServerSocket; received: WireFrame[] }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((done) => server.once('listening', done));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('missing server address');
  const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`);
  const received: WireFrame[] = [];
  const connection = new Promise<ServerSocket>((resolveConnection) => server.once('connection', resolveConnection));
  server.on('connection', (socket: ServerSocket) => {
    socket.on('message', (data: { toString(): string }) => received.push(JSON.parse(data.toString()) as WireFrame));
  });
  hub.start();
  const socket = await connection;
  const harness = { hub, server, socket, received };
  harnesses.push(harness);
  return harness;
}

function ticker(socket: ServerSocket, time: number, result: Record<string, unknown>): void {
  socket.send(JSON.stringify({ time, channel: 'ticker', event: 'update', result }));
}

function fullTicker(socket: ServerSocket, time: number, ts: number, bid: string, ask: string): void {
  ticker(socket, time, {
    s: SYMBOL, lp: ask, bp: bid, bs: '2', ap: ask, as: '1.5',
    o: '118000', h: '119000', l: '117500', v: '1000', q: '118000000', ts,
  });
}

/** A sparse frame: last price only. This is the shape low-liquidity instruments actually push. */
function sparseTicker(socket: ServerSocket, time: number, ts: number, lastPrice: string): void {
  ticker(socket, time, {
    s: SYMBOL, lp: lastPrice, bp: null, ap: null,
    o: null, h: null, l: null, v: null, ts,
  });
}

function bookUpdate(socket: ServerSocket, time: number, ts: number, asks: Array<[string, string]>, bids: Array<[string, string]>): void {
  socket.send(JSON.stringify({ time, channel: 'order_book_update', event: 'update', result: {
    snapshot: true, ts, s: SYMBOL, a: asks, b: bids,
  } }));
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
  for (const { hub, server } of harnesses.splice(0)) {
    hub.stop();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Hub side — quote provenance
// ─────────────────────────────────────────────────────────────────────────────

describe('QA · quote provenance (price/time alignment)', () => {
  it('does not let a sparse lp-only frame dress a stale quote up as fresh', async () => {
    const { hub, socket } = await createHub();
    await waitFor(() => hub.marketCount() > 0);

    fullTicker(socket, 1, QUOTE_TS, '118499.5', '118500.5');
    await waitFor(() => hub.market(SYMBOL)?.source === 'gate_crossex_websocket');
    expect(hub.market(SYMBOL)?.quoteUpdatedAt).toBe(new Date(QUOTE_TS).toISOString());

    // Thirty seconds later a sparse frame arrives. The frame is new; the quote is not.
    sparseTicker(socket, 2, LATER_TS, '118600');
    await waitFor(() => hub.market(SYMBOL)?.lastPrice === '118600');

    const market = hub.market(SYMBOL);
    // The frame-level stamps moved — which is exactly what used to fool `freshMarket()`.
    expect(market?.updatedAt).toBe(new Date(LATER_TS).toISOString());
    expect(Date.parse(market?.receivedAt ?? '')).toBeGreaterThan(LATER_TS);
    // The quote-level stamp did not, and the quote itself is still the old one.
    expect(market?.quoteUpdatedAt).toBe(new Date(QUOTE_TS).toISOString());
    expect(market?.bidPrice).toBe('118499.5');
    expect(market?.askPrice).toBe('118500.5');
  });

  it('backs a sparse frame\'s quote from the maintained book and stamps it with the book\'s time', async () => {
    const { hub, socket } = await createHub();
    await waitFor(() => hub.marketCount() > 0);
    const releaseBook = hub.watchOrderBook(SYMBOL);
    bookUpdate(socket, 1, BOOK_TS, [['118600.5', '1.5'], ['118601.0', '2']], [['118599.5', '2.5'], ['118599.0', '3']]);
    await waitFor(() => hub.orderBook(SYMBOL) !== null);

    sparseTicker(socket, 2, LATER_TS, '118600');
    await waitFor(() => hub.market(SYMBOL)?.lastPrice === '118600');

    const market = hub.market(SYMBOL);
    expect(market?.bidPrice).toBe('118599.5');
    expect(market?.bidSize).toBe('2.5');
    expect(market?.askPrice).toBe('118600.5');
    // Provenance follows the book, not the ticker that triggered the publish.
    expect(market?.quoteUpdatedAt).toBe(new Date(BOOK_TS).toISOString());
    releaseBook();
  });

  it('stamps a mixed-provenance pair with the older of the two sources', async () => {
    const { hub, socket } = await createHub();
    await waitFor(() => hub.marketCount() > 0);
    const releaseBook = hub.watchOrderBook(SYMBOL);
    // The book is the older source...
    bookUpdate(socket, 1, QUOTE_TS, [['118600.5', '1.5']], [['118599.5', '2.5']]);
    await waitFor(() => hub.orderBook(SYMBOL) !== null);
    // ...and the ticker carries only the bid, at a newer instant.
    ticker(socket, 2, {
      s: SYMBOL, lp: '118600', bp: '118499.5', bs: '2', ap: null, as: null,
      o: null, h: null, l: null, v: null, ts: LATER_TS,
    });
    await waitFor(() => hub.market(SYMBOL)?.bidPrice === '118499.5');

    const market = hub.market(SYMBOL);
    expect(market?.bidPrice).toBe('118499.5');
    expect(market?.askPrice).toBe('118600.5');
    // The pair never coexisted at LATER_TS, so the record must claim the older stamp. Stamping it
    // with the ticker's own (newer) time is exactly the bug this suite exists to catch.
    expect(market?.quoteUpdatedAt).toBe(new Date(QUOTE_TS).toISOString());
    releaseBook();
  });

  it('stamps a full ticker with its own source time, and a placeholder with its birth', async () => {
    const { hub, socket } = await createHub();
    await waitFor(() => hub.marketCount() > 0);

    const dynamic = 'GATE_FUTURE_QAPROBE_USDT';
    const definition: MarketDefinition = { symbol: dynamic, venue: 'GATE', asset: 'QAPROBE' };
    expect(hub.ensureMarkets([definition])).toBe(true);
    // A placeholder has never carried a quote: its stamp is its own birth, which ages out.
    expect(hub.market(dynamic)?.quoteUpdatedAt).toBeDefined();
    expect(Date.parse(hub.market(dynamic)?.quoteUpdatedAt ?? '')).toBeGreaterThan(0);

    ticker(socket, 1, {
      s: dynamic, lp: '118500', bp: '118499.5', bs: '2', ap: '118500.5', as: '1.5',
      o: '118000', h: '119000', l: '117500', v: '1000', q: '118000000', ts: QUOTE_TS,
    });
    await waitFor(() => hub.market(dynamic)?.source === 'gate_crossex_websocket');
    expect(hub.market(dynamic)?.quoteUpdatedAt).toBe(new Date(QUOTE_TS).toISOString());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Engine side — the gates that consume provenance
// ─────────────────────────────────────────────────────────────────────────────

const positionConfig = {
  kind: 'position', asset: 'QALT', leftVenue: 'BINANCE', rightVenue: 'OKX',
  leftSide: 'SELL', rightSide: 'BUY', entryBps: '10', totalAmount: '0.2',
  perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
} as const;
const LEFT = 'BINANCE_FUTURE_QALT_USDT';
const RIGHT = 'OKX_FUTURE_QALT_USDT';

function symbolDefinition(symbol: string): MarketDefinition {
  const [venue, , asset] = symbol.split('_');
  return { symbol, venue: venue as MarketDefinition['venue'], asset: asset ?? symbol };
}

/** Mirrors app.ts's production wiring: a real hub behind the engine's market source. */
function hubBackedSource(hub: CrossExMarketHub): MarketSource {
  return {
    market: (symbol) => hub.market(symbol),
    ensureMarket: (symbol) => {
      if (hub.market(symbol)) return true;
      hub.ensureMarkets([symbolDefinition(symbol)]);
      return hub.market(symbol) !== null;
    },
    watchQuotes: (symbols) => hub.watchQuotes(symbols),
    watchOrderBook: (symbol) => hub.watchOrderBook(symbol),
  };
}

function makeDatabase(): { database: Database.Database; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-quote-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
  });
  return { database: openDatabase(config.databasePath, config.migrationsDir), directory };
}

function createEngine(database: Database.Database, directory: string, markets: MarketSource): { engine: StrategyEngine; runtime: TradingRuntime } {
  const session = new TradingSession();
  session.set('live');
  const vault = new MemoryCredentialVault();
  // These cases never submit an order: the pair gate rejects before any gateway call.
  const runtime = new TradingRuntime(database, session, vault, {} as unknown as TradingCrossExGateway);
  const engine = new StrategyEngine(database, session, runtime, markets, {
    tickIntervalMs: 20, orderTimeoutMs: 400, marketDataWaitTimeoutMs: 250,
  });
  engines.push({ engine, database, directory });
  return { engine, runtime };
}

describe('QA · engine gates on quote provenance', () => {
  it('refuses to launch when the frame is fresh but the quote is a minute old', async () => {
    const { hub, socket } = await createHub();
    const { database, directory } = makeDatabase();
    const { engine } = createEngine(database, directory, hubBackedSource(hub));
    hub.ensureMarkets([symbolDefinition(LEFT), symbolDefinition(RIGHT)]);

    const staleQuote = Date.now() - 60_000;
    const freshFrame = Date.now();
    // Reproduce the sparse-ticker shape end to end: a full frame at the stale instant, then a
    // lp-only frame at the fresh one. Both legs end up claiming a fresh frame and an old quote.
    for (const symbol of [LEFT, RIGHT]) {
      socket.send(JSON.stringify({ time: 1, channel: 'ticker', event: 'update', result: {
        s: symbol, lp: '100', bp: '100', bs: '2', ap: '99', as: '1.5',
        o: '99', h: '101', l: '98', v: '10', q: '1000', ts: staleQuote,
      } }));
    }
    await waitFor(() => hub.market(LEFT)?.source === 'gate_crossex_websocket'
      && hub.market(RIGHT)?.source === 'gate_crossex_websocket');
    for (const symbol of [LEFT, RIGHT]) {
      socket.send(JSON.stringify({ time: 2, channel: 'ticker', event: 'update', result: {
        s: symbol, lp: '100', bp: null, ap: null, o: null, h: null, l: null, v: null, ts: freshFrame,
      } }));
    }
    await waitFor(() => Date.parse(hub.market(LEFT)?.updatedAt ?? '') === freshFrame
      && Date.parse(hub.market(RIGHT)?.updatedAt ?? '') === freshFrame);

    // The frame-level evidence is pristine and the quote-level evidence is not.
    expect(Date.parse(hub.market(LEFT)?.quoteUpdatedAt ?? '')).toBe(staleQuote);
    expect(Date.parse(hub.market(RIGHT)?.quoteUpdatedAt ?? '')).toBe(staleQuote);

    await expect(engine.startStrategy(positionConfig)).rejects.toMatchObject({
      code: 'strategy_market_data_unavailable', statusCode: 409,
    });
  });

  it('refuses to launch when the two legs are individually fresh but not contemporaneous', async () => {
    const { hub, socket } = await createHub();
    const { database, directory } = makeDatabase();
    const { engine } = createEngine(database, directory, hubBackedSource(hub));
    hub.ensureMarkets([symbolDefinition(LEFT), symbolDefinition(RIGHT)]);

    const now = Date.now();
    const skewed = now - 6_000;
    // Each leg gets its own full frame — left now, right six seconds ago — and then a sparse
    // frame at `now`, so both records claim a fresh frame while their quotes are 6s apart.
    for (const [symbol, ts] of [[LEFT, now], [RIGHT, skewed]] as const) {
      socket.send(JSON.stringify({ time: 1, channel: 'ticker', event: 'update', result: {
        s: symbol, lp: '100', bp: '100', bs: '2', ap: '99', as: '1.5',
        o: '99', h: '101', l: '98', v: '10', q: '1000', ts,
      } }));
    }
    await waitFor(() => hub.market(LEFT)?.source === 'gate_crossex_websocket'
      && hub.market(RIGHT)?.source === 'gate_crossex_websocket');
    for (const symbol of [LEFT, RIGHT]) {
      socket.send(JSON.stringify({ time: 2, channel: 'ticker', event: 'update', result: {
        s: symbol, lp: '100', bp: null, ap: null, o: null, h: null, l: null, v: null, ts: now,
      } }));
    }
    await waitFor(() => Date.parse(hub.market(RIGHT)?.updatedAt ?? '') === now);

    // Both quotes are inside the 15s freshness window on their own...
    expect(now - Date.parse(hub.market(LEFT)?.quoteUpdatedAt ?? '')).toBeLessThan(1_000);
    expect(now - Date.parse(hub.market(RIGHT)?.quoteUpdatedAt ?? '')).toBeGreaterThan(5_000);
    // ...but six seconds apart, the spread between them never existed.
    await expect(engine.startStrategy(positionConfig)).rejects.toMatchObject({
      code: 'strategy_market_data_unavailable', statusCode: 409,
    });

    // Realign the right leg: the same prices now clear the pair gate. Everything before it is
    // already satisfied, so any other failure means the gate let this pair through.
    socket.send(JSON.stringify({ time: 3, channel: 'ticker', event: 'update', result: {
      s: RIGHT, lp: '100', bp: '100', bs: '2', ap: '99', as: '1.5',
      o: '99', h: '101', l: '98', v: '10', q: '1000', ts: now,
    } }));
    await waitFor(() => Date.parse(hub.market(RIGHT)?.quoteUpdatedAt ?? '') === now);
    const outcome = await engine.startStrategy(positionConfig).catch((error: unknown) => error);
    expect((outcome as { code?: string }).code).not.toBe('strategy_market_data_unavailable');
  });
});

/** Records every subscription so ref counts and per-leg fan-out are directly observable. */
class RecordingMarkets implements MarketSource {
  readonly watchCalls: string[][] = [];
  readonly bookCalls: string[] = [];
  releases = 0;

  market(): null { return null; }
  ensureMarket(): boolean { return true; }
  watchQuotes(symbols: string[]): () => void {
    this.watchCalls.push([...symbols]);
    return () => { this.releases += 1; };
  }
  watchOrderBook(symbol: string): () => void {
    this.bookCalls.push(symbol);
    return () => { this.releases += 1; };
  }
}

function insertRunningStrategy(database: Database.Database, id: string, config: unknown): void {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json,
    progress, filled_quantity, filled_left, filled_right, open_position, credential_profile_id,
    credential_profile_label, created_at, updated_at, stopped_at)
    VALUES (?, 'position', 'live', 'RUNNING', ?, 0, '0', '0', '0', '0', ?, NULL, ?, ?, NULL)`)
    .run(id, JSON.stringify(config), DEFAULT_CREDENTIAL_PROFILE, now, now);
}

describe('QA · leg subscriptions cover the order book', () => {
  it('holds one book subscription per leg alongside the ticker watch, and releases both', async () => {
    const { database, directory } = makeDatabase();
    const markets = new RecordingMarkets();
    const { engine } = createEngine(database, directory, markets);
    insertRunningStrategy(database, 'PAIR-QAPROBE', positionConfig);

    engine.activatePersistedStrategies();
    expect(markets.watchCalls).toEqual([[LEFT, RIGHT]]);
    expect(markets.bookCalls).toEqual([LEFT, RIGHT]);
    expect(markets.releases).toBe(0);

    await engine.stopStrategy('PAIR-QAPROBE');
    // One ticker release (the array watch) plus one book release per leg, all through the single
    // combined leg release the actor holds.
    expect(markets.releases).toBe(3);

    // Idempotent: a repeated stop must not release the same subscriptions twice.
    await engine.stopStrategy('PAIR-QAPROBE');
    expect(markets.releases).toBe(3);
  });
});
