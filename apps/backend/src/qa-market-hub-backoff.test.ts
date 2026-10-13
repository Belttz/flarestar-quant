/**
 * Adversarial QA pass over the invalid-symbol backoff in `market-hub.ts`.
 *
 * The implementation's own suite (`market-hub-invalid-backoff.test.ts`) proves the happy path:
 * mark, wait, retry, clear. This file deliberately goes where that one does not — the corner and
 * error paths a reviewer would attack:
 *
 *   1. every data channel (not just ticker) must clear the verdict it belongs to;
 *   2. channel isolation in both directions, including the on-demand channels;
 *   3. clock robustness (clock 0, backwards clock, MAX_SAFE_INTEGER, broken/NaN clock);
 *   4. the per-tick hot path (`market()`) must stay free of subscribe/retry side effects;
 *   5. coexistence with the three pre-existing retirement mechanisms;
 *   6. behaviour after the window with the sweep as the *only* trigger (no private helpers).
 *
 * Every assertion here is backed by a mutation experiment: reverting the corresponding piece of
 * `market-hub.ts` must turn these red.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type WebSocketDefault from 'ws';
import { CrossExMarketHub } from './market-hub.js';

type ServerSocket = WebSocketDefault;

/** Mirrors `market-hub.ts`; kept local so a constant drift shows up as a failing assertion. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const START_CLOCK = 1_771_990_000_000;

const SYMBOL = 'KRAKEN_FUTURE_NATGAS_USD';
const SECOND_SYMBOL = 'LIGHTER_FUTURE_HYPE_USDC';

/** ticker / funding_rate / open_interest are public (registered by `ensureMarkets`) … */
const PUBLIC_CHANNELS = ['ticker', 'funding_rate', 'open_interest'] as const;
/** … the rest are on-demand (registered by a `watch*` call). */
const ON_DEMAND_CHANNELS = ['order_book_update', 'trade', 'kline_1m'] as const;
const ALL_CHANNELS = [...PUBLIC_CHANNELS, ...ON_DEMAND_CHANNELS] as const;

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
  invalidSymbolBackoffMs(attempts: number): number;
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

async function createHarness(options: { maxDynamicSymbols?: number; now?: () => number } = {}): Promise<Harness> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('missing server address');
  const clock = { now: START_CLOCK };
  const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`, {
    now: options.now ?? (() => clock.now),
    ...(options.maxDynamicSymbols === undefined ? {} : { maxDynamicSymbols: options.maxDynamicSymbols }),
  });
  const received: Array<Record<string, unknown>> = [];
  const socketPromise = new Promise<ServerSocket>((resolve) => server.once('connection', resolve));
  server.on('connection', (sock: ServerSocket) => {
    sock.on('message', (data: { toString(): string }) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
  });
  hub.start();
  const socket = await socketPromise;
  const harness: Harness = { hub, server, socket, received, clock, internals: hub as unknown as HubInternals };
  harnesses.push(harness);
  return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let any frame the hub decided to send land, without advancing the injected clock. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function send(harness: Harness, frame: Record<string, unknown>): void {
  harness.socket.send(JSON.stringify(frame));
}

/** Upstream subscribe frames (sent by the hub) that ask for `symbol` on `channel`. */
function framesFor(received: Array<Record<string, unknown>>, symbol: string, channel = 'ticker'): Array<Record<string, unknown>> {
  return received.filter((frame) => frame.channel === channel
    && frame.event === 'subscribe'
    && Array.isArray(frame.payload)
    && (frame.payload as string[]).includes(symbol));
}

function recordOf(harness: Harness, symbol: string, channel = 'ticker'): InvalidRecord | undefined {
  return harness.internals.invalidSymbols.get(channel)?.get(symbol);
}

function subscribedOnSomeShard(harness: Harness, symbol: string, channel = 'ticker'): boolean {
  return [...harness.internals.shards.values()]
    .some((shard) => shard.subscriptions.get(channel)?.has(symbol) === true);
}

async function register(harness: Harness, symbol: string, channel = 'ticker'): Promise<void> {
  expect(harness.hub.ensureMarkets([{ symbol, venue: 'KRAKEN', asset: 'NATGAS' }])).toBe(true);
  await waitFor(() => framesFor(harness.received, symbol, channel).length > 0);
}

/** One upstream "these symbols are unsupported" verdict on `channel`. */
async function sendVerdict(
  harness: Harness,
  symbols: string[],
  channel = 'ticker',
  expectedAttempts: number | null = 1,
): Promise<void> {
  send(harness, {
    channel,
    event: 'subscribe',
    result: { status: 'failed' },
    error: { message: `There are unsupported symbols, invalidSymbols:[${symbols.join(',')}]` },
  });
  await waitFor(() => symbols.every((symbol) => {
    const record = recordOf(harness, symbol, channel);
    if (!record) return false;
    return expectedAttempts === null || record.attempts === expectedAttempts;
  }));
}

/** A well-formed data push per channel; ts is always a sane epoch ms so `new Date` stays valid. */
const DATA_FRAMES: Record<string, (symbol: string, ts: number) => Record<string, unknown>> = {
  ticker: (symbol, ts) => ({ time: 1, channel: 'ticker', event: 'update', result: {
    s: symbol, lp: '3.42', bp: '3.41', bs: '10', ap: '3.43', as: '12',
    o: '3.4', h: '3.5', l: '3.3', v: '1000', q: '3420', ts,
  } }),
  funding_rate: (symbol, ts) => ({ time: 1, channel: 'funding_rate', event: 'update', result: { s: symbol, r: '0.0002', T: ts } }),
  open_interest: (symbol) => ({ time: 1, channel: 'open_interest', event: 'update', result: { s: symbol, oi: '1234', oiV: '5678' } }),
  order_book_update: (symbol, ts) => ({ time: 1, channel: 'order_book_update', event: 'update', result: {
    snapshot: true, ts, s: symbol, a: [['3.43', '12']], b: [['3.41', '10']],
  } }),
  trade: (symbol, ts) => ({ time: 1, channel: 'trade', event: 'update', result: {
    s: symbol, i: `T-${ts}`, p: '3.42', q: '1', S: 'BUY', ts,
  } }),
  kline_1m: (symbol, ts) => ({ channel: 'kline_1m', event: 'update', result: {
    s: symbol, o: '3.4', h: '3.5', l: '3.3', c: '3.42', v: '10', t: ts, T: ts + 59_999, x: false,
  } }),
};

/** Evidence the frame reached the application layer — not just the transport. */
const DELIVERED: Record<string, (harness: Harness, symbol: string) => boolean> = {
  ticker: (harness, symbol) => harness.hub.market(symbol)?.lastPrice === '3.42',
  funding_rate: (harness, symbol) => harness.hub.market(symbol)?.fundingRate === '0.0002',
  open_interest: (harness, symbol) => harness.hub.market(symbol)?.openInterest === '1234',
  order_book_update: (harness, symbol) => (harness.hub.orderBook(symbol)?.bids.length ?? 0) > 0,
  trade: (harness, symbol) => harness.hub.recentTrades(symbol).length > 0,
  kline_1m: (harness, symbol) => harness.hub.candles(symbol, '1m').length > 0,
};

/** Subscribe the on-demand channels; their `watch*` call is what registers them upstream. */
const WATCHERS: Record<string, (harness: Harness, symbol: string) => () => void> = {
  order_book_update: (harness, symbol) => harness.hub.watchOrderBook(symbol),
  trade: (harness, symbol) => harness.hub.watchTrades(symbol),
  kline_1m: (harness, symbol) => harness.hub.watchKlines(symbol, '1m'),
};

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.hub.stop();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
});

describe('QA: every data channel clears the verdict it owns', () => {
  for (const channel of ALL_CHANNELS) {
    it(`drops the ${channel} verdict as soon as a ${channel} frame arrives`, async () => {
      const harness = await createHarness();
      await register(harness, SYMBOL);
      const release = WATCHERS[channel]?.(harness, SYMBOL);
      await waitFor(() => subscribedOnSomeShard(harness, SYMBOL, channel));

      await sendVerdict(harness, [SYMBOL], channel);
      expect(recordOf(harness, SYMBOL, channel), `${channel} verdict recorded`).toBeDefined();
      expect(subscribedOnSomeShard(harness, SYMBOL, channel)).toBe(false);

      send(harness, DATA_FRAMES[channel](SYMBOL, harness.clock.now));
      // The record is gone …
      await waitFor(() => recordOf(harness, SYMBOL, channel) === undefined);
      // … and the frame really was applied, so the clear is backed by real delivery.
      await waitFor(() => DELIVERED[channel](harness, SYMBOL));
      release?.();
    });
  }

  it('clears each channel independently: one frame never forgives another channel', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    const releases = [
      harness.hub.watchOrderBook(SYMBOL),
      harness.hub.watchTrades(SYMBOL),
      harness.hub.watchKlines(SYMBOL, '1m'),
    ];
    await waitFor(() => ON_DEMAND_CHANNELS.every((channel) => subscribedOnSomeShard(harness, SYMBOL, channel)));

    // Verdicts on all six channels at once.
    for (const channel of ALL_CHANNELS) await sendVerdict(harness, [SYMBOL], channel);

    // A ticker frame forgives ticker only.
    send(harness, DATA_FRAMES.ticker(SYMBOL, harness.clock.now));
    await waitFor(() => recordOf(harness, SYMBOL, 'ticker') === undefined);
    for (const channel of ALL_CHANNELS) {
      if (channel === 'ticker') continue;
      expect(recordOf(harness, SYMBOL, channel), `${channel} verdict must survive a ticker frame`).toBeDefined();
    }

    // Each remaining channel is forgiven by its own frame, one at a time.
    for (const channel of ['funding_rate', 'open_interest', 'order_book_update', 'trade', 'kline_1m']) {
      send(harness, DATA_FRAMES[channel](SYMBOL, harness.clock.now));
      await waitFor(() => recordOf(harness, SYMBOL, channel) === undefined, 3_000);
    }
    for (const release of releases) release();
  });
});

describe('QA: verdicts stay inside their channel in both directions', () => {
  it('a ticker verdict mutes ticker only — every other channel keeps subscribing and delivering', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    const releases = [
      harness.hub.watchOrderBook(SYMBOL),
      harness.hub.watchTrades(SYMBOL),
      harness.hub.watchKlines(SYMBOL, '1m'),
    ];
    await waitFor(() => ON_DEMAND_CHANNELS.every((channel) => subscribedOnSomeShard(harness, SYMBOL, channel)));

    await sendVerdict(harness, [SYMBOL], 'ticker');
    expect(subscribedOnSomeShard(harness, SYMBOL, 'ticker')).toBe(false);

    for (const channel of ['funding_rate', 'open_interest', 'order_book_update', 'trade', 'kline_1m']) {
      // Still subscribed …
      expect(subscribedOnSomeShard(harness, SYMBOL, channel), `${channel} subscription must survive`).toBe(true);
      // … still delivering …
      send(harness, DATA_FRAMES[channel](SYMBOL, harness.clock.now));
      await waitFor(() => DELIVERED[channel](harness, SYMBOL));
      // … and the ticker verdict never leaked into it.
      expect(recordOf(harness, SYMBOL, channel)).toBeUndefined();
    }
    // The muted channel is the only one that stopped.
    expect(recordOf(harness, SYMBOL, 'ticker')).toBeDefined();
    for (const release of releases) release();
  });

  it('an on-demand channel verdict does not mute the public channels either', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    const releaseKline = harness.hub.watchKlines(SYMBOL, '1m');
    await waitFor(() => subscribedOnSomeShard(harness, SYMBOL, 'kline_1m'));

    await sendVerdict(harness, [SYMBOL], 'kline_1m');
    expect(subscribedOnSomeShard(harness, SYMBOL, 'kline_1m')).toBe(false);

    // Ticker, funding and OI keep flowing: the kline verdict is not a verdict on the market.
    expect(subscribedOnSomeShard(harness, SYMBOL, 'ticker')).toBe(true);
    send(harness, DATA_FRAMES.ticker(SYMBOL, harness.clock.now));
    await waitFor(() => DELIVERED.ticker(harness, SYMBOL));
    send(harness, DATA_FRAMES.funding_rate(SYMBOL, harness.clock.now));
    await waitFor(() => DELIVERED.funding_rate(harness, SYMBOL));
    // A ticker frame must not forgive the kline verdict.
    expect(recordOf(harness, SYMBOL, 'kline_1m')).toBeDefined();
    releaseKline();
  });
});

describe('QA: the five-minute sweep alone is enough to heal a symbol', () => {
  it('retries exactly once per elapsed window and never storms the upstream', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    // A live strategy keeps the market warm, so retirement can never be the way back.
    const release = harness.hub.watchQuotes([SYMBOL]);
    await sendVerdict(harness, [SYMBOL]);
    const framesAtVerdict = framesFor(harness.received, SYMBOL).length;

    // Ten sweeps inside the window: zero frames.
    for (let sweep = 0; sweep < 10; sweep += 1) {
      harness.clock.now += 2_000;
      harness.internals.evictIdleDynamicMarkets();
    }
    await settle();
    expect(framesFor(harness.received, SYMBOL).length).toBe(framesAtVerdict);

    // Window over: exactly one frame, and the symbol is subscribed again.
    harness.clock.now += BACKOFF_BASE_MS;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => framesFor(harness.received, SYMBOL).length === framesAtVerdict + 1);
    await settle();
    expect(framesFor(harness.received, SYMBOL).length).toBe(framesAtVerdict + 1);
    expect(subscribedOnSomeShard(harness, SYMBOL)).toBe(true);
    release();
  });

  it('widens the window from 30s to 60s on the second verdict through the natural path', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    await sendVerdict(harness, [SYMBOL], 'ticker', 1);
    const first = recordOf(harness, SYMBOL)?.at ?? 0;

    // Heals at the first window …
    harness.clock.now = first + BACKOFF_BASE_MS;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => subscribedOnSomeShard(harness, SYMBOL));

    // … and is rejected again: attempts 2, window 60s.
    await sendVerdict(harness, [SYMBOL], 'ticker', 2);
    const second = recordOf(harness, SYMBOL)?.at ?? 0;
    expect(recordOf(harness, SYMBOL)?.attempts).toBe(2);
    const framesAtSecond = framesFor(harness.received, SYMBOL).length;

    harness.clock.now = second + BACKOFF_BASE_MS + 1;
    harness.internals.evictIdleDynamicMarkets();
    await settle();
    expect(framesFor(harness.received, SYMBOL).length, '30s is not enough after two verdicts').toBe(framesAtSecond);

    harness.clock.now = second + 60_000;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => framesFor(harness.received, SYMBOL).length === framesAtSecond + 1);
  });

  it('does not retry anything once the hub is stopped', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    await sendVerdict(harness, [SYMBOL]);
    const before = framesFor(harness.received, SYMBOL).length;
    harness.hub.stop();
    harness.clock.now += BACKOFF_MAX_MS * 2;
    harness.internals.evictIdleDynamicMarkets();
    await settle();
    expect(framesFor(harness.received, SYMBOL).length).toBe(before);
  });
});

describe('QA: clock robustness', () => {
  it('recovers when the hub clock starts at 0', async () => {
    const harness = await createHarness();
    harness.clock.now = 0;
    await register(harness, SYMBOL);
    await sendVerdict(harness, [SYMBOL]);
    expect(recordOf(harness, SYMBOL)?.at).toBe(0);
    const before = framesFor(harness.received, SYMBOL).length;

    harness.clock.now = BACKOFF_BASE_MS - 1;
    harness.internals.evictIdleDynamicMarkets();
    await settle();
    expect(framesFor(harness.received, SYMBOL).length).toBe(before);

    harness.clock.now = BACKOFF_BASE_MS;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => framesFor(harness.received, SYMBOL).length === before + 1);
  });

  it('survives a clock parked near Number.MAX_SAFE_INTEGER without NaN or Infinity windows', async () => {
    const harness = await createHarness();
    const base = Number.MAX_SAFE_INTEGER - 200_000;
    harness.clock.now = base;
    await register(harness, SYMBOL);
    await sendVerdict(harness, [SYMBOL]);
    const record = recordOf(harness, SYMBOL);
    expect(Number.isFinite(record?.at ?? Number.NaN)).toBe(true);
    const before = framesFor(harness.received, SYMBOL).length;

    harness.clock.now = base + BACKOFF_BASE_MS - 1;
    harness.internals.evictIdleDynamicMarkets();
    await settle();
    expect(framesFor(harness.received, SYMBOL).length).toBe(before);

    harness.clock.now = Number.MAX_SAFE_INTEGER - 1;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => framesFor(harness.received, SYMBOL).length === before + 1);
  });

  it('never locks a symbol out forever when the clock jumps backwards', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    await sendVerdict(harness, [SYMBOL]);
    const markedAt = harness.clock.now;

    // Clock rewind: the symbol is muted (the window has clearly not elapsed), but nothing breaks.
    harness.clock.now = 0;
    harness.internals.evictIdleDynamicMarkets();
    await settle();
    expect(recordOf(harness, SYMBOL)).toBeDefined();

    // Forward again past the window: it must heal. A backwards jump may delay recovery, never deny it.
    const before = framesFor(harness.received, SYMBOL).length;
    harness.clock.now = markedAt + BACKOFF_BASE_MS;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => framesFor(harness.received, SYMBOL).length === before + 1);
    expect(subscribedOnSomeShard(harness, SYMBOL)).toBe(true);
  });

  it('keeps the window finite for every extreme attempt count', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1');
    const backoff = (hub as unknown as HubInternals).invalidSymbolBackoffMs.bind(hub);
    let previous = 0;
    for (const attempts of [1, 2, 3, 5, 10, 20, 21, 22, 100, 1_000, 1_000_000, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) {
      const window = backoff(attempts);
      expect(Number.isFinite(window), `attempts=${attempts}`).toBe(true);
      expect(window, `attempts=${attempts}`).toBeGreaterThan(0);
      expect(window, `attempts=${attempts}`).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      expect(window, `attempts=${attempts} must not shrink`).toBeGreaterThanOrEqual(previous);
      previous = window;
    }
    // Degenerate counts still yield the base window rather than something negative.
    expect(backoff(0)).toBe(BACKOFF_BASE_MS);
    expect(backoff(-1)).toBe(BACKOFF_BASE_MS);
    // The documented ceiling is reached and then held.
    expect(backoff(7)).toBe(BACKOFF_MAX_MS);
    expect(backoff(21)).toBe(BACKOFF_MAX_MS);
  });

  it('fails open when the injected clock is broken (NaN): a muted symbol still gets retried', async () => {
    const harness = await createHarness({ now: () => Number.NaN });
    await register(harness, SYMBOL);
    await sendVerdict(harness, [SYMBOL]);
    // The verdict is recorded with a NaN anchor; comparisons against it are false, so the hub must
    // keep trying instead of treating "not elapsed" as "never" — permanent muting is the defect.
    const before = framesFor(harness.received, SYMBOL).length;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => framesFor(harness.received, SYMBOL).length === before + 1);
    expect(() => harness.internals.evictIdleDynamicMarkets()).not.toThrow();
  });
});

describe('QA: the per-tick hot path stays pure', () => {
  it('market() never subscribes, retries, or mutates the verdict record', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    await sendVerdict(harness, [SYMBOL]);
    const framesBefore = framesFor(harness.received, SYMBOL).length;
    const recordBefore = recordOf(harness, SYMBOL);

    for (let tick = 0; tick < 500; tick += 1) {
      expect(harness.hub.market(SYMBOL)).not.toBeNull();
      harness.hub.marketCount();
    }
    await settle();

    expect(framesFor(harness.received, SYMBOL).length).toBe(framesBefore);
    expect(recordOf(harness, SYMBOL)).toEqual(recordBefore);
    expect(subscribedOnSomeShard(harness, SYMBOL)).toBe(false);
    // Still healable: the hot path must not have consumed the retry either.
    harness.clock.now += BACKOFF_BASE_MS;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => framesFor(harness.received, SYMBOL).length === framesBefore + 1);
  });

  it('market() on a watched, muted symbol does not shorten the window', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    const release = harness.hub.watchQuotes([SYMBOL]);
    await sendVerdict(harness, [SYMBOL]);
    const markedAt = recordOf(harness, SYMBOL)?.at ?? 0;
    const before = framesFor(harness.received, SYMBOL).length;

    for (let tick = 0; tick < 200; tick += 1) harness.hub.market(SYMBOL);
    harness.clock.now = markedAt + BACKOFF_BASE_MS - 1;
    harness.internals.evictIdleDynamicMarkets();
    await settle();
    expect(framesFor(harness.received, SYMBOL).length).toBe(before);
    release();
  });
});

describe('QA: coexistence with the pre-existing retirement mechanisms', () => {
  it('budget eviction (evictColdest) drops verdicts on every channel, on-demand ones included', async () => {
    const harness = await createHarness({ maxDynamicSymbols: 2 });
    const cold = 'GATE_SPOT_COLDA_USDT';
    const warm = 'GATE_SPOT_WARMB_USDT';
    expect(harness.hub.ensureMarkets([
      { symbol: cold, venue: 'GATE', asset: 'COLDA' },
      { symbol: warm, venue: 'GATE', asset: 'WARMB' },
    ])).toBe(true);
    // Subscribe the on-demand channels for `cold`, then let them go so it can be evicted.
    const releaseBook = harness.hub.watchOrderBook(cold);
    const releaseTrades = harness.hub.watchTrades(cold);
    const releaseKlines = harness.hub.watchKlines(cold, '5m');
    await waitFor(() => subscribedOnSomeShard(harness, cold, 'order_book_update')
      && subscribedOnSomeShard(harness, cold, 'trade')
      && subscribedOnSomeShard(harness, cold, 'kline_5m'));
    releaseBook();
    releaseTrades();
    releaseKlines();

    for (const channel of ['ticker', 'funding_rate', 'open_interest', 'order_book_update', 'trade', 'kline_5m']) {
      await sendVerdict(harness, [cold], channel);
    }
    expect(harness.hub.market(cold)).not.toBeNull();

    // Overflow by one: the coldest unwatched market is recycled — and its verdicts go with it.
    harness.internals.dynamicMarkets.set(cold, 1);
    harness.internals.dynamicMarkets.set(warm, 2);
    expect(harness.hub.ensureMarkets([{ symbol: 'GATE_SPOT_FRESHC_USDT', venue: 'GATE', asset: 'FRESHC' }])).toBe(true);
    expect(harness.hub.market(cold)).toBeNull();
    for (const channel of ['ticker', 'funding_rate', 'open_interest', 'order_book_update', 'trade', 'kline_5m']) {
      expect(recordOf(harness, cold, channel), `${channel} verdict must die with the market`).toBeUndefined();
    }
    // The survivor is untouched.
    expect(harness.hub.market(warm)).not.toBeNull();
    expect(harness.hub.market('GATE_SPOT_FRESHC_USDT')).not.toBeNull();
  });

  it('the idle sweep clears on-demand channel verdicts too, not just the three public ones', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    const release = harness.hub.watchKlines(SYMBOL, '5m');
    await waitFor(() => subscribedOnSomeShard(harness, SYMBOL, 'kline_5m'));
    release();
    await sendVerdict(harness, [SYMBOL], 'kline_5m');
    await sendVerdict(harness, [SYMBOL], 'ticker');

    harness.internals.dynamicMarkets.set(SYMBOL, 0);
    harness.internals.evictIdleDynamicMarkets();
    expect(harness.hub.market(SYMBOL)).toBeNull();
    expect(recordOf(harness, SYMBOL, 'ticker')).toBeUndefined();
    expect(recordOf(harness, SYMBOL, 'kline_5m')).toBeUndefined();
  });

  it('an actively watched market is retired by neither sweep and still heals through the backoff', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    const release = harness.hub.watchTrades(SYMBOL);
    await sendVerdict(harness, [SYMBOL]);
    const before = framesFor(harness.received, SYMBOL).length;

    // Idle pressure must not retire a watched market …
    harness.internals.dynamicMarkets.set(SYMBOL, 0);
    harness.internals.evictIdleDynamicMarkets();
    expect(harness.hub.market(SYMBOL)).not.toBeNull();
    await settle();
    expect(framesFor(harness.received, SYMBOL).length).toBe(before);

    // … and it still gets its retry once the window elapsed.
    harness.clock.now += BACKOFF_BASE_MS;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => framesFor(harness.received, SYMBOL).length === before + 1);
    expect(harness.hub.market(SYMBOL)).not.toBeNull();
    release();
  });
});

describe('QA: remaining corners', () => {
  it('a verdict covering several symbols marks each of them once', async () => {
    const harness = await createHarness();
    expect(harness.hub.ensureMarkets([
      { symbol: SYMBOL, venue: 'KRAKEN', asset: 'NATGAS' },
      { symbol: SECOND_SYMBOL, venue: 'LIGHTER', asset: 'HYPE' },
    ])).toBe(true);
    await waitFor(() => framesFor(harness.received, SYMBOL).length > 0 && framesFor(harness.received, SECOND_SYMBOL).length > 0);

    await sendVerdict(harness, [SYMBOL, SECOND_SYMBOL]);
    expect(recordOf(harness, SYMBOL)?.attempts).toBe(1);
    expect(recordOf(harness, SECOND_SYMBOL)?.attempts).toBe(1);

    // Only the symbol that delivered data is forgiven.
    send(harness, DATA_FRAMES.ticker(SYMBOL, harness.clock.now));
    await waitFor(() => recordOf(harness, SYMBOL) === undefined);
    expect(recordOf(harness, SECOND_SYMBOL)?.attempts).toBe(1);
  });

  it('a verdict for a symbol the hub does not carry is recorded but never subscribed', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    const ghost = 'GHOST_FUTURE_NOPE_USDT';
    await sendVerdict(harness, [ghost]);
    expect(recordOf(harness, ghost)).toBeDefined();

    // No ghost frame is ever sent upstream …
    harness.clock.now += BACKOFF_MAX_MS;
    harness.internals.evictIdleDynamicMarkets();
    await settle();
    expect(framesFor(harness.received, ghost).length).toBe(0);

    // … and registering it afterwards is served on the next sweep, once the window elapsed.
    expect(harness.hub.ensureMarkets([{ symbol: ghost, venue: 'KRAKEN', asset: 'NOPE' }])).toBe(true);
    harness.clock.now += BACKOFF_MAX_MS;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => framesFor(harness.received, ghost).length === 1);
  });

  it('a muted symbol with no watcher and no re-registration still heals on the sweep', async () => {
    const harness = await createHarness();
    await register(harness, SYMBOL);
    await sendVerdict(harness, [SYMBOL]);
    // Simulate the exact production shape: strategy warm, verdict in force, no client watching.
    harness.internals.dynamicMarkets.set(SYMBOL, Date.now());
    const before = framesFor(harness.received, SYMBOL).length;
    harness.clock.now += BACKOFF_MAX_MS;
    harness.internals.evictIdleDynamicMarkets();
    await waitFor(() => framesFor(harness.received, SYMBOL).length === before + 1);
    expect(harness.hub.market(SYMBOL)).not.toBeNull();
  });

  it('accepts the hub without the optional clock (production construction keeps Date.now)', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('missing server address');
    const received: Array<Record<string, unknown>> = [];
    const socketPromise = new Promise<ServerSocket>((resolve) => server.once('connection', resolve));
    server.on('connection', (sock: ServerSocket) => {
      sock.on('message', (data: { toString(): string }) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
    });
    // No options at all: this is how app.ts and the server scripts build the hub.
    const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`);
    hub.start();
    const socket = await socketPromise;
    const count = (symbol: string): number => received.filter((frame) => frame.channel === 'ticker'
      && frame.event === 'subscribe'
      && Array.isArray(frame.payload)
      && (frame.payload as string[]).includes(symbol)).length;
    try {
      expect(hub.ensureMarkets([{ symbol: SYMBOL, venue: 'KRAKEN', asset: 'NATGAS' }])).toBe(true);
      await waitFor(() => count(SYMBOL) > 0);
      socket.send(JSON.stringify({
        channel: 'ticker',
        event: 'subscribe',
        result: { status: 'failed' },
        error: { message: `There are unsupported symbols, invalidSymbols:[${SYMBOL}]` },
      }));
      await waitFor(() => (hub as unknown as HubInternals).invalidSymbols.get('ticker')?.has(SYMBOL) === true);
      const before = count(SYMBOL);
      // Real wall clock: 30s cannot have passed, so the symbol must still be muted.
      (hub as unknown as HubInternals).subscribeSymbols('ticker', [SYMBOL]);
      await settle();
      expect(count(SYMBOL)).toBe(before);
    } finally {
      hub.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
