import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type WebSocketDefault from 'ws';
import { CrossExMarketHub, type VenueBookSnapshot } from './market-hub.js';

type ServerSocket = WebSocketDefault;

interface Harness {
  hub: CrossExMarketHub;
  socket: ServerSocket;
  server: WebSocketServer;
  /** Every depth request the hub made, in order. */
  depthCalls: Array<{ symbol: string; limit: number }>;
  /** Resolve/reject control for the pending depth request. */
  settleDepth: (snapshot: VenueBookSnapshot | null) => void;
  failDepth: (error: Error) => void;
  reports: Array<Record<string, unknown>>;
}

const harnesses: Harness[] = [];

/**
 * Snapshot seeding (D): a book that upstream never baselines is seeded from the venue's own REST
 * depth endpoint, and diffs that arrive while that request is in flight are replayed by *time*.
 *
 * Sequence ids are never used to join the two sources: the CrossEx `U`/`u` counter is CrossEx's own
 * numbering and a venue REST `lastUpdateId`/`id`/`u` belongs to a completely different sequence.
 */
async function createHarness(options: { depth?: Harness['settleDepth'] extends never ? never : unknown } = {}): Promise<Harness> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('missing server address');

  const depthCalls: Array<{ symbol: string; limit: number }> = [];
  const reports: Array<Record<string, unknown>> = [];
  let settleDepth: (snapshot: VenueBookSnapshot | null) => void = () => undefined;
  let failDepth: (error: Error) => void = () => undefined;
  if (options.depth !== 'disabled') {
    // Each call parks a promise the test resolves explicitly, so "in flight" is a controllable state.
    (globalThis as { __depthQueue?: Array<() => void> }).__depthQueue = [];
  }

  const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`, {
    ...(options.depth === 'disabled' ? {} : {
      depth: (symbol: string, limit: number) => {
        depthCalls.push({ symbol, limit });
        return new Promise<VenueBookSnapshot | null>((resolve, reject) => {
          settleDepth = resolve;
          failDepth = reject;
        });
      },
    }),
    report: (event) => reports.push({ ...event }),
  });

  const socketPromise = new Promise<ServerSocket>((resolve) => server.once('connection', resolve));
  server.on('connection', (sock: ServerSocket) => { sock.on('message', () => undefined); });
  hub.start();
  const socket = await socketPromise;
  const harness: Harness = { hub, socket, server, depthCalls, settleDepth: (s) => settleDepth(s), failDepth: (e) => failDepth(e), reports };
  harnesses.push(harness);
  return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function diffFrame(symbol: string, ts: number, price: string, size: string, sequence: { U: number; u: number } = { U: 1, u: -1 }) {
  return JSON.stringify({
    time: 1,
    channel: 'order_book_update',
    event: 'update',
    result: { snapshot: false, ts, s: symbol, a: [], b: [[price, size]], ...sequence },
  });
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.hub.stop();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
});

describe('order book snapshot seeding', () => {
  it('buffers diffs instead of applying them while no baseline exists', async () => {
    const { hub, socket, depthCalls } = await createHarness();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);

    hub.watchOrderBook(symbol);
    // The seeder asked the venue immediately, before any frame arrived.
    await waitFor(() => depthCalls.length === 1);
    expect(depthCalls[0]).toMatchObject({ symbol, limit: 50 });

    socket.send(diffFrame(symbol, 1_771_990_800_000, '118499.5', '2'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    // No baseline yet: the frame is held and the book stays empty rather than inventing one out of
    // "levels that happened to move".
    expect(hub.orderBook(symbol)?.bids ?? []).toEqual([]);
    expect(hub.orderBook(symbol)?.asks ?? []).toEqual([]);
    hub.stop();
  });

  it('drops every frame buffered during the request, regardless of its venue timestamp', async () => {
    const { hub, socket, settleDepth, reports } = await createHarness();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);
    const internals = hub as unknown as { books: Map<string, { pendingDiffs: unknown[] }> };
    await waitFor(() => internals.books.has(symbol));

    // Two frames arrive while the snapshot is in flight. Their venue timestamps are deliberately
    // absurd — one five seconds in the future, one five seconds in the past — because the replay
    // decision must not read them at all: the cut-off is a *local* arrival instant, and comparing it
    // against a venue clock is exactly the bug that would replay stale levels onto a fresh snapshot.
    const now = Date.now();
    socket.send(diffFrame(symbol, now + 5_000, '118000.0', '9'));
    socket.send(diffFrame(symbol, now - 5_000, '117000.0', '9'));
    await waitFor(() => internals.books.get(symbol)?.pendingDiffs.length === 2);

    settleDepth({
      bids: [['118499.5', '2.5']],
      asks: [['118500.5', '1.5']],
      ts: now,
      seq: '12345',
    });
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) > 0);

    // Only the snapshot's own levels survive: both buffered frames predate it in our timeline.
    expect(hub.orderBook(symbol)?.bids).toEqual([['118499.5', '2.5']]);
    expect(hub.orderBook(symbol)?.asks).toEqual([['118500.5', '1.5']]);
    const seeded = reports.find((event) => event.outcome === 'seeded');
    expect(String(seeded?.reason)).toContain('replayed=0');
    expect(String(seeded?.reason)).toContain('droppedBeforeCutoff=2');
    hub.stop();
  });

  it('falls back to plain diff accumulation once the seed retry budget is spent', async () => {
    const { hub, socket, failDepth, reports } = await createHarness();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);
    const internals = hub as unknown as {
      books: Map<string, { seedInFlight: boolean; lastSeedAttemptAt: number; seedAbandoned: boolean; seedFailures: number }>;
      ensureBookSeed(symbol: string): void;
    };

    // Three failed attempts. A buffered frame between them re-triggers the request, and the spacing
    // clock is rewound so the test does not sit through the real 5s backoff.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitFor(() => internals.books.get(symbol)?.seedInFlight === true, 4_000);
      failDepth(new Error('venue unreachable'));
      await new Promise((resolve) => setTimeout(resolve, 60));
      const book = internals.books.get(symbol);
      if (book) book.lastSeedAttemptAt = Number.NEGATIVE_INFINITY;
      socket.send(diffFrame(symbol, 1_771_990_800_000 + attempt * 1_000, '118499.5', '2', { U: attempt + 1, u: -1 }));
      await waitFor(() => internals.books.get(symbol)?.seedInFlight === true
        || internals.books.get(symbol)?.seedAbandoned === true, 4_000);
    }

    await waitFor(() => internals.books.get(symbol)?.seedAbandoned === true);
    expect(reports.some((event) => event.outcome === 'failed')).toBe(true);
    expect(reports.some((event) => event.outcome === 'abandoned')).toBe(true);

    // From here on the book behaves exactly as before seeding existed: diffs accumulate.
    socket.send(diffFrame(symbol, 1_771_990_900_000, '118497.5', '4', { U: 4, u: -1 }));
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) > 0);
    expect(hub.orderBook(symbol)?.bids).toContainEqual(['118497.5', '4']);
    hub.stop();
  });

  it('drops out-of-order frames on a venue-wide sequence and does not reseed on a jump', async () => {
    const { hub, socket, depthCalls } = await createHarness();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);

    // An upstream snapshot seeds the book without any REST call.
    socket.send(JSON.stringify({ time: 1, channel: 'order_book_update', event: 'update', result: {
      snapshot: true, ts: 1_771_990_800_000, s: symbol, U: 900, u: 950,
      a: [['118500.5', '1.5']], b: [['118499.5', '2.5']],
    } }));
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) > 0);
    const seedsAfterSnapshot = depthCalls.length;

    // A jump in the global sequence is normal: apply, never reseed.
    socket.send(JSON.stringify({ time: 2, channel: 'order_book_update', event: 'update', result: {
      snapshot: false, ts: 1_771_990_801_000, s: symbol, U: 2_000, u: 2_100,
      a: [], b: [['118498.0', '1']],
    } }));
    await waitFor(() => hub.orderBook(symbol)?.bids.length === 2);

    // An older range is out of order: dropped.
    socket.send(JSON.stringify({ time: 3, channel: 'order_book_update', event: 'update', result: {
      snapshot: false, ts: 1_771_990_802_000, s: symbol, U: 1_000, u: 1_050,
      a: [], b: [['1.0', '1']],
    } }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hub.orderBook(symbol)?.bids).toEqual([['118499.5', '2.5'], ['118498.0', '1']]);
    expect(depthCalls.length).toBe(seedsAfterSnapshot);
    hub.stop();
  });

  it('reseeds when a per-symbol counter proves frames were missed', async () => {
    const { hub, socket, depthCalls, settleDepth } = await createHarness();
    // `u === -1` is the shape Gate and Bybit publish; the rule keys off that field, not the venue.
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);

    socket.send(JSON.stringify({ time: 1, channel: 'order_book_update', event: 'update', result: {
      snapshot: true, ts: 1_771_990_800_000, s: symbol, U: 10, u: -1,
      a: [['118500.5', '1.5']], b: [['118499.5', '2.5']],
    } }));
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) > 0);

    // `u === -1` venues number every frame, so `U` skipping a value means a lost frame.
    socket.send(JSON.stringify({ time: 2, channel: 'order_book_update', event: 'update', result: {
      snapshot: false, ts: 1_771_990_810_000, s: symbol, U: 15, u: -1, a: [], b: [['118497.0', '1']],
    } }));
    await waitFor(() => depthCalls.length > 0, 3_000);
    expect(depthCalls.length).toBe(1);
    // The book keeps its last good state while the new baseline is in flight.
    expect(hub.orderBook(symbol)?.bids.length).toBe(1);

    settleDepth({ bids: [['118499.5', '2.5']], asks: [['118500.5', '1.5']], ts: 1_771_990_820_000, seq: '77' });
    await waitFor(() => hub.orderBook(symbol)?.bids.length === 1);
    hub.stop();
  });

  it('keeps working when no depth source is wired at all', async () => {
    const { hub, socket } = await createHarness({ depth: 'disabled' });
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);

    socket.send(diffFrame(symbol, 1_771_990_800_000, '118499.5', '2'));
    // Without a seeder the hub must behave exactly as it did before D: diffs accumulate.
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) > 0);
    expect(hub.orderBook(symbol)?.bids).toEqual([['118499.5', '2']]);
    hub.stop();
  });
});

describe('order book seeding hard conditions', () => {
  it('replays by local arrival, so a five-second venue clock offset changes nothing', async () => {
    const { hub, socket, settleDepth, reports } = await createHarness();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);

    // The venue's clock is five seconds fast: every `ts` it sends is now + 5s. Under the old
    // venue-timestamp rule such a frame always looked "newer" than the local cut-off and would have
    // been replayed on top of a fresh snapshot, silently regressing a level.
    const skewMs = 5_000;
    const internals = hub as unknown as { books: Map<string, { pendingDiffs: unknown[] }> };
    socket.send(diffFrame(symbol, Date.now() + skewMs, '118000.0', '9'));
    // Wait until the frame is actually *buffered* — settling before it arrives would make it a
    // post-snapshot frame instead, which is a different (and correct) code path.
    await waitFor(() => internals.books.get(symbol)?.pendingDiffs.length === 1);

    settleDepth({ bids: [['118499.5', '2.5']], asks: [['118500.5', '1.5']], ts: Date.now() + skewMs, seq: '1' });
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) > 0);
    // Buffered before the snapshot arrived → dropped, whatever its venue timestamp says.
    expect(hub.orderBook(symbol)?.bids).toEqual([['118499.5', '2.5']]);
    const seeded = reports.find((event) => event.outcome === 'seeded');
    expect(String(seeded?.reason)).toContain('replayed=0');

    // A frame that arrives *after* the snapshot is applied, again purely on arrival order.
    socket.send(diffFrame(symbol, Date.now() + skewMs, '118600.0', '3', { U: 2, u: -1 }));
    await waitFor(() => hub.orderBook(symbol)?.bids.length === 2);
    expect(hub.orderBook(symbol)?.bids).toEqual([['118600.0', '3'], ['118499.5', '2.5']]);
    hub.stop();
  });

  it('caps retained levels per side instead of growing without bound', async () => {
    const { hub, socket } = await createHarness({ depth: 'disabled' });
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);

    // 400 distinct bid levels across successive frames: far past the 100-level hard cap.
    for (let batch = 0; batch < 8; batch += 1) {
      const levels = Array.from({ length: 50 }, (_, index) => [`${1_000 - batch * 50 - index}`, '1']);
      socket.send(JSON.stringify({ time: 1, channel: 'order_book_update', event: 'update', result: {
        snapshot: false, ts: 1_771_990_800_000 + batch * 1_000, s: symbol, U: batch + 1, u: -1,
        a: [], b: levels,
      } }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) > 0);
    const book = hub.orderBook(symbol);
    // `bookSnapshot` already truncates its output to MAX_BOOK_LEVELS; the point here is that the
    // retained map does not hold the 400 levels that were applied.
    const retained = (hub as unknown as { books: Map<string, { bids: Map<string, string> }> }).books.get(symbol)?.bids.size ?? 0;
    expect(retained).toBeLessThanOrEqual(100);
    expect(book?.bids.length).toBeLessThanOrEqual(50);
    hub.stop();
  });

  it('re-seeds every watched book after a reconnect drops them', async () => {
    const { hub, socket, depthCalls, settleDepth } = await createHarness();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);
    await waitFor(() => depthCalls.length === 1);
    settleDepth({ bids: [['118499.5', '2.5']], asks: [['118500.5', '1.5']], ts: 1_771_990_800_000, seq: '1' });
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) > 0);

    // Killing the socket drops every book and schedules a reconnect; the hub must ask for a fresh
    // baseline rather than rebuild one out of the post-reconnect diffs.
    socket.terminate();
    await waitFor(() => depthCalls.length >= 2, 15_000);
    hub.stop();
  });
});
