import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type WebSocketDefault from 'ws';
import { CrossExMarketHub } from './market-hub.js';

type ServerSocket = WebSocketDefault;

/**
 * Production shape of the defect: a KRAKEN/LIGHTER pair the local catalog knows about, which the
 * upstream rejected once, and which then never recovered (`strategy_market_data_unavailable`).
 */
const SYMBOL = 'KRAKEN_FUTURE_NATGAS_USD';

/** Mirrors the constants in market-hub.ts; the assertions below pin the documented policy. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

interface InvalidRecord {
  at: number;
  attempts: number;
}

interface HubInternals {
  invalidSymbols: Map<string, Map<string, InvalidRecord>>;
  dynamicMarkets: Map<string, number>;
  shards: Map<number, { subscriptions: Map<string, Set<string>> }>;
  subscribeSymbols(channel: string, symbols: string[]): void;
  evictIdleDynamicMarkets(): void;
}

interface Harness {
  hub: CrossExMarketHub;
  server: WebSocketServer;
  socket: ServerSocket;
  received: Array<Record<string, unknown>>;
  clock: { now: number };
  internals: HubInternals;
}

const harnesses: Harness[] = [];

async function createHarness(): Promise<Harness> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('missing server address');
  const clock = { now: 1_771_990_000_000 };
  const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`, { now: () => clock.now });
  const received: Array<Record<string, unknown>> = [];
  const socketPromise = new Promise<ServerSocket>((resolve) => server.once('connection', resolve));
  server.on('connection', (sock: ServerSocket) => {
    sock.on('message', (data: { toString(): string }) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
  });
  hub.start();
  const socket = await socketPromise;
  const internals = hub as unknown as HubInternals;
  const harness = { hub, server, socket, received, clock, internals };
  harnesses.push(harness);
  return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let any frame that the hub decided to send land, without advancing the injected clock. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/** Upstream subscribe frames (sent by the hub) that ask for `symbol` on `channel`. */
function subscribeFramesFor(received: Array<Record<string, unknown>>, symbol: string, channel = 'ticker'): Array<Record<string, unknown>> {
  return received.filter((frame) => frame.channel === channel
    && frame.event === 'subscribe'
    && Array.isArray(frame.payload)
    && (frame.payload as string[]).includes(symbol));
}

/** Register the market and wait until the upstream actually received its subscribe frame. */
async function registerAndSubscribe(harness: Harness, symbol = SYMBOL): Promise<void> {
  expect(harness.hub.ensureMarkets([{ symbol, venue: 'KRAKEN', asset: 'NATGAS' }])).toBe(true);
  await waitFor(() => subscribeFramesFor(harness.received, symbol).length > 0);
}

/**
 * One upstream "these symbols are unsupported" verdict for a channel. `expectedAttempts` pins the
 * resulting attempt count so a caller never reads a record the new verdict has not updated yet.
 */
async function sendVerdict(
  harness: Harness,
  symbols: string[],
  channel = 'ticker',
  expectedAttempts: number | null = 1,
): Promise<void> {
  harness.socket.send(JSON.stringify({
    channel,
    event: 'subscribe',
    result: { status: 'failed' },
    error: { message: `There are unsupported symbols, invalidSymbols:[${symbols.join(',')}]` },
  }));
  await waitFor(() => symbols.every((symbol) => {
    const record = harness.internals.invalidSymbols.get(channel)?.get(symbol);
    if (!record) return false;
    return expectedAttempts === null || record.attempts === expectedAttempts;
  }));
}

function sendTicker(harness: Harness, symbol: string, ts: number): void {
  harness.socket.send(JSON.stringify({ time: 1, channel: 'ticker', event: 'update', result: {
    s: symbol, lp: '3.42', bp: '3.41', bs: '10', ap: '3.43', as: '12',
    o: '3.4', h: '3.5', l: '3.3', v: '1000', q: '3420', ts,
  } }));
}

function recordOf(harness: Harness, symbol: string, channel = 'ticker'): InvalidRecord | undefined {
  return harness.internals.invalidSymbols.get(channel)?.get(symbol);
}

function subscribedOnSomeShard(harness: Harness, symbol: string, channel = 'ticker'): boolean {
  return [...harness.internals.shards.values()]
    .some((shard) => shard.subscriptions.get(channel)?.has(symbol) === true);
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.hub.stop();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
});

describe('CrossEx invalid-symbol backoff', () => {
  it('honours a verdict immediately and stays muted for the whole backoff window', async () => {
    const harness = await createHarness();
    await registerAndSubscribe(harness);
    await sendVerdict(harness, [SYMBOL]);

    // The verdict itself still takes effect at once: the symbol leaves the shard's subscription
    // set, so no further upstream request is made for it.
    expect(subscribedOnSomeShard(harness, SYMBOL)).toBe(false);
    expect(recordOf(harness, SYMBOL)?.attempts).toBe(1);

    const before = subscribeFramesFor(harness.received, SYMBOL).length;
    const markedAt = harness.clock.now;

    // Repeated re-subscribe pressure inside the window: the periodic sweep and a direct
    // subscribeSymbols call must both stay silent instead of hammering the upstream.
    harness.clock.now = markedAt + 1_000;
    harness.internals.evictIdleDynamicMarkets();
    harness.internals.subscribeSymbols('ticker', [SYMBOL]);
    harness.clock.now = markedAt + BACKOFF_BASE_MS - 1;
    harness.internals.evictIdleDynamicMarkets();
    harness.internals.subscribeSymbols('ticker', [SYMBOL]);
    await settle();

    expect(subscribeFramesFor(harness.received, SYMBOL).length).toBe(before);
    expect(subscribedOnSomeShard(harness, SYMBOL)).toBe(false);
  });

  it('re-subscribes a symbol a live strategy keeps warm once its backoff elapsed', async () => {
    const harness = await createHarness();
    await registerAndSubscribe(harness);
    // A running strategy holds a quote watch for its legs, so the market is never idle and is
    // never retired — before this fix that made the verdict permanent.
    const release = harness.hub.watchQuotes([SYMBOL]);
    await sendVerdict(harness, [SYMBOL]);
    const before = subscribeFramesFor(harness.received, SYMBOL).length;

    harness.clock.now = harness.clock.now + BACKOFF_BASE_MS - 1;
    harness.internals.evictIdleDynamicMarkets();
    await settle();
    expect(subscribeFramesFor(harness.received, SYMBOL).length).toBe(before);

    // Window over: the recovery sweep re-asks the upstream. The record survives until data
    // actually arrives, so a symbol that is rejected again does not restart from zero.
    harness.clock.now += 1;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => subscribeFramesFor(harness.received, SYMBOL).length === before + 1);
    expect(subscribedOnSomeShard(harness, SYMBOL)).toBe(true);
    expect(recordOf(harness, SYMBOL)?.attempts).toBe(1);

    release();
  });

  it('clears the record once the channel delivers data again', async () => {
    const harness = await createHarness();
    await registerAndSubscribe(harness);
    await sendVerdict(harness, [SYMBOL]);

    harness.clock.now += BACKOFF_BASE_MS;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => subscribeFramesFor(harness.received, SYMBOL).length === 2);

    // A successful re-subscription is proven by data: the verdict must not survive it.
    sendTicker(harness, SYMBOL, harness.clock.now);
    await waitFor(() => recordOf(harness, SYMBOL) === undefined);
    expect(harness.hub.market(SYMBOL)?.source).toBe('gate_crossex_websocket');

    // Nothing lingers: a later verdict starts from the first, shortest window again.
    await sendVerdict(harness, [SYMBOL, 'LIGHTER_FUTURE_NATGAS_USDC']);
    expect(recordOf(harness, SYMBOL)?.attempts).toBe(1);
    expect(recordOf(harness, 'LIGHTER_FUTURE_NATGAS_USDC')?.attempts).toBe(1);
  });

  it('backs off exponentially on repeated verdicts and never past the 30-minute ceiling', async () => {
    const harness = await createHarness();
    await registerAndSubscribe(harness);

    // 30s, 60s, 120s, 240s, 480s, 960s, then the ceiling twice (attempts 7 and 8 both = 1920s
    // and 3840s before clamping).
    const expectedWindows = [30, 60, 120, 240, 480, 960, 1_800, 1_800].map((seconds) => seconds * 1_000);
    const expectedAttempts = [1, 2, 3, 4, 5, 6, 7, 8];

    for (let round = 0; round < expectedWindows.length; round += 1) {
      await sendVerdict(harness, [SYMBOL], 'ticker', expectedAttempts[round]);
      const record = recordOf(harness, SYMBOL);
      expect(record?.attempts, `round ${round} attempt count`).toBe(expectedAttempts[round]);
      const markedAt = record?.at ?? 0;
      const window = expectedWindows[round] ?? BACKOFF_MAX_MS;
      const before = subscribeFramesFor(harness.received, SYMBOL).length;

      // One millisecond early: still muted.
      harness.clock.now = markedAt + window - 1;
      harness.internals.subscribeSymbols('ticker', [SYMBOL]);
      await settle();
      expect(subscribeFramesFor(harness.received, SYMBOL).length, `round ${round} early retry`).toBe(before);

      // Exactly at the window: allowed again.
      harness.clock.now = markedAt + window;
      harness.internals.subscribeSymbols('ticker', [SYMBOL]);
      await waitFor(() => subscribeFramesFor(harness.received, SYMBOL).length === before + 1, 3_000);
    }

    // The last two rounds both used the ceiling, so the window is clamped and not still growing.
    expect(expectedWindows[6]).toBe(BACKOFF_MAX_MS);
    expect(expectedWindows[7]).toBe(BACKOFF_MAX_MS);
  });

  it('drops the verdict on retirement so a re-registered symbol is not muted again', async () => {
    const harness = await createHarness();
    await registerAndSubscribe(harness);
    await sendVerdict(harness, [SYMBOL]);
    expect(recordOf(harness, SYMBOL)).toBeDefined();

    // Budget pressure / idle sweep retires it (nothing is watching it here).
    harness.internals.dynamicMarkets.set(SYMBOL, 0);
    harness.internals.evictIdleDynamicMarkets();
    expect(harness.hub.market(SYMBOL)).toBeNull();
    expect(recordOf(harness, SYMBOL)).toBeUndefined();

    // Re-registering at the same instant must be served immediately — no stale verdict.
    const before = subscribeFramesFor(harness.received, SYMBOL).length;
    await registerAndSubscribe(harness);
    await waitFor(() => subscribeFramesFor(harness.received, SYMBOL).length === before + 1);
    expect(subscribedOnSomeShard(harness, SYMBOL)).toBe(true);
  });

  it('keeps verdicts per channel so one rejected channel does not mute another', async () => {
    const harness = await createHarness();
    await registerAndSubscribe(harness);
    await sendVerdict(harness, [SYMBOL], 'ticker');

    expect(recordOf(harness, SYMBOL, 'ticker')).toBeDefined();
    expect(recordOf(harness, SYMBOL, 'funding_rate')).toBeUndefined();

    // The funding channel is still subscribed and still delivers; it must not be dragged down.
    harness.socket.send(JSON.stringify({ time: 1, channel: 'funding_rate', event: 'update', result: {
      s: SYMBOL, r: '0.0002', T: harness.clock.now,
    } }));
    await waitFor(() => harness.hub.market(SYMBOL)?.fundingRate === '0.0002');
    expect(recordOf(harness, SYMBOL, 'ticker')).toBeDefined();
  });

  /**
   * A subscribe is all-or-nothing upstream: one unsupported symbol fails the whole batch, so the
   * valid symbols in that batch receive nothing. Only `ticker`, `funding_rate` and `open_interest`
   * used to be re-subscribed after the rejected symbols were dropped, which stranded
   * `order_book_update`, `trade` and every `kline_*` channel until the last watcher released. That
   * silently broke the candle backfill: `keepWarm` only renews a watch and never re-subscribes, so
   * the history chart stayed empty without a single error in the log.
   */
  it('re-subscribes the surviving symbols on the book and kline channels after a batch rejection', async () => {
    const harness = await createHarness();
    const good = 'GATE_FUTURE_BTC_USDT';
    const bad = 'NOT_A_REAL_SYMBOL';
    expect(harness.hub.ensureMarkets([
      { symbol: good, venue: 'GATE', asset: 'BTC' },
      { symbol: bad, venue: 'GATE', asset: 'NOT_A_REAL' },
    ])).toBe(true);

    for (const channel of ['order_book_update', 'kline_1m']) {
      harness.internals.subscribeSymbols(channel, [good, bad]);
      await waitFor(() => subscribeFramesFor(harness.received, good, channel).length > 0);

      const before = subscribeFramesFor(harness.received, good, channel).length;
      await sendVerdict(harness, [bad], channel);
      // The retry must name the surviving symbol and drop the rejected one.
      await waitFor(() => subscribeFramesFor(harness.received, good, channel).length === before + 1);
      const retry = subscribeFramesFor(harness.received, good, channel).at(-1) as { payload: string[] };
      expect(retry.payload).toContain(good);
      expect(retry.payload).not.toContain(bad);
    }
  });
});
