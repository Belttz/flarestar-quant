import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type WebSocketDefault from 'ws';
import { VenuePublicMarketDataClient } from '@gate-crossex/public-data';
import { CrossExMarketHub } from './market-hub.js';

type ServerSocket = WebSocketDefault;

interface Harness {
  hub: CrossExMarketHub;
  socket: ServerSocket;
  server: WebSocketServer;
}

interface BookInternals {
  bids: Map<string, string>;
  asks: Map<string, string>;
  framesSinceBandSweep: number;
  lastBandSweepAt: number;
}

interface HubInternals {
  books: Map<string, BookInternals>;
  sweepPriceBand(book: BookInternals): void;
  enforcePriceBand(
    book: BookInternals,
    written: { bids: Array<[string, string]>; asks: Array<[string, string]> },
    at: number,
  ): void;
}

const harnesses: Harness[] = [];

/**
 * Two book-hygiene rules that keep a locally maintained order book both *unit-consistent* and
 * *bounded*:
 *
 * A. The REST snapshot that seeds a book must be merged into it in the same unit the CrossEx
 *    `order_book_update` diffs use. GATE and OKX push contract counts, so the venue REST depth is
 *    kept in contract counts too; converting one side only produced a book whose depth read 129
 *    USDT right after seeding and jumped back to ~700k on the very next frame.
 * B. A level that emptied before we subscribed never receives a delete frame, so it lingers
 *    forever. Such ghosts sit tens of times away from the touch (measured: `price=1000.00` in a
 *    BTC book near 79,700) and are removed by a ±20% price band around the book's own mid.
 */
async function createHarness(options: {
  depth?: (symbol: string, limit: number) => Promise<{ bids: Array<[string, string]>; asks: Array<[string, string]>; ts: number | null; seq: string | null } | null>;
} = {}): Promise<Harness> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('missing server address');

  const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`, options.depth === undefined ? {} : { depth: options.depth });
  const socketPromise = new Promise<ServerSocket>((resolve) => server.once('connection', resolve));
  server.on('connection', (sock: ServerSocket) => { sock.on('message', () => undefined); });
  hub.start();
  const socket = await socketPromise;
  const harness: Harness = { hub, socket, server };
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

/** One diff frame. `levels` is written as `bid`/`ask` rows, matching the CrossEx payload shape. */
function frame(
  symbol: string,
  ts: number,
  levels: { bids?: Array<[string, string]>; asks?: Array<[string, string]> },
  sequence: { U?: number; u?: number } = { U: 1, u: -1 },
  snapshot = false,
): string {
  return JSON.stringify({
    time: 1,
    channel: 'order_book_update',
    event: 'update',
    result: { snapshot, ts, s: symbol, a: levels.asks ?? [], b: levels.bids ?? [], ...sequence },
  });
}

function response(payload: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
}

function bookOf(hub: CrossExMarketHub, symbol: string): BookInternals {
  const internals = hub as unknown as HubInternals;
  const book = internals.books.get(symbol);
  if (!book) throw new Error(`no book reserved for ${symbol}`);
  return book;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.hub.stop();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
});

describe('book seeding keeps the feed unit', () => {
  it('stores a seeded GATE level in contract counts, exactly like the diff that follows', async () => {
    // The real client, the real parser, a fake venue: 20381 contracts on both sides of the seed,
    // which is the magnitude CrossEx itself pushes for the same level.
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const target = String(url);
      expect(target).not.toContain('/contracts');
      return response({
        id: 55_000_112,
        current: 1_771_990_800,
        bids: [{ p: '79700.0', s: 20_381 }],
        asks: [{ p: '79700.1', s: 15_000 }],
      });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as unknown as typeof fetch, () => 1_771_990_800_000);
    const { hub, socket } = await createHarness({ depth: (symbol, limit) => client.queryDepth(symbol, limit) });
    const symbol = 'GATE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);

    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) > 0);
    // Seeded side: contracts, untouched. A `quanto_multiplier` of 0.0001 applied here would have
    // stored 2.0381 and made the depth 10,000× too small until the next frame arrived.
    expect(hub.orderBook(symbol)?.bids).toEqual([['79700.0', '20381']]);

    // The diff that follows carries the same magnitude: one book, one unit, no jump.
    socket.send(frame(symbol, 1_771_990_801_000, { bids: [['79700.0', '20381']] }, { U: 2, u: -1 }));
    await waitFor(() => hub.orderBook(symbol)?.bids[0]?.[1] === '20381');
    expect(hub.orderBook(symbol)?.bids).toEqual([['79700.0', '20381']]);
    expect(hub.orderBook(symbol)?.asks).toEqual([['79700.1', '15000']]);
  });

  it('stores a seeded OKX level in contract counts too', async () => {
    let instrumentCalls = 0;
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/public/instruments')) {
        instrumentCalls += 1;
        return response({ code: '0', msg: '', data: [{ instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctValCcy: 'BTC' }] });
      }
      return response({ code: '0', msg: '', data: [{
        bids: [['79699.9', '812', '0', '3']],
        asks: [['79700.0', '640', '0', '2']],
        ts: '1771990800000',
      }] });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as unknown as typeof fetch, () => 1_771_990_800_000);
    const book = await client.queryDepth('OKX_FUTURE_BTC_USDT', 50);
    // `ctVal` (0.01) is not applied here: the consumer applies it once, when it builds notional.
    expect(book.bids).toEqual([['79699.9', '812']]);
    expect(book.asks).toEqual([['79700.0', '640']]);
    expect(instrumentCalls).toBe(0);
  });
});

describe('ghost level cleanup', () => {
  it('deletes levels tens of times away from the touch and keeps everything inside the band', async () => {
    const { hub, socket } = await createHarness();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);

    // Mid sits at 80,000.5; the ±5% levels below are ordinary book content.
    socket.send(frame(symbol, 1_771_990_800_000, {
      bids: [['80000.0', '1'], ['76000.0', '2']],
      asks: [['80001.0', '1.5'], ['84000.0', '2']],
    }, { U: 1, u: -1 }, true));
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) === 2);

    // A level that emptied before we subscribed: no delete frame is ever coming for it.
    const book = bookOf(hub, symbol);
    book.bids.set('1000.00', '117.9');

    (hub as unknown as HubInternals).sweepPriceBand(book);

    expect(book.bids.has('1000.00')).toBe(false);
    // Everything within ±5% survives, on both sides.
    expect(hub.orderBook(symbol)?.bids).toEqual([['80000.0', '1'], ['76000.0', '2']]);
    expect(hub.orderBook(symbol)?.asks).toEqual([['80001.0', '1.5'], ['84000.0', '2']]);
  });

  it('also rejects a ghost the moment a diff writes it, before any sweep runs', async () => {
    const { hub, socket } = await createHarness();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);

    socket.send(frame(symbol, 1_771_990_800_000, {
      bids: [['80000.0', '1']],
      asks: [['80001.0', '1']],
    }, { U: 1, u: -1 }, true));
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) === 1);

    // 29,344 is the price the live capture showed sitting in a ~79,700 book.
    socket.send(frame(symbol, 1_771_990_801_000, { bids: [['29344.00', '5']] }, { U: 2, u: -1 }));
    socket.send(frame(symbol, 1_771_990_802_000, { bids: [['79999.0', '5']] }, { U: 3, u: -1 }));
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) === 2);

    expect(hub.orderBook(symbol)?.bids).toEqual([['80000.0', '1'], ['79999.0', '5']]);
  });

  it('filters nothing while the book has no reference price, so nothing is wrongly deleted', async () => {
    const { hub, socket } = await createHarness();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);

    // Both sides empty: the band is undefined, so a sweep must be a no-op rather than a wipe.
    const book = bookOf(hub, symbol);
    (hub as unknown as HubInternals).sweepPriceBand(book);
    expect(book.bids.size).toBe(0);
    expect(book.asks.size).toBe(0);

    // A lone level with no counterpart keeps itself as the only reference, so it survives: there is
    // no evidence that 1000 is a ghost when the book contains nothing else to compare against.
    socket.send(frame(symbol, 1_771_990_800_000, { bids: [['1000.00', '1']] }, { U: 1, u: -1 }));
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) > 0);
    (hub as unknown as HubInternals).sweepPriceBand(book);
    expect(hub.orderBook(symbol)?.bids).toEqual([['1000.00', '1']]);
    expect(book.asks.size).toBe(0);

    // One side only: the surviving touch is the reference, so a ghost on that same side goes.
    socket.send(frame(symbol, 1_771_990_801_000, { bids: [['80000.0', '1'], ['1200.00', '2']] }, { U: 2, u: -1 }));
    await waitFor(() => book.bids.has('80000.0'));
    (hub as unknown as HubInternals).sweepPriceBand(book);
    expect(book.bids.has('1200.00')).toBe(false);
    expect(book.bids.has('80000.0')).toBe(true);
  });

  it('sweeps only once per 20 frames, and catches the ghost on that frame', async () => {
    const { hub, socket } = await createHarness();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);

    socket.send(frame(symbol, 1_771_990_800_000, {
      bids: [['80000.0', '1']],
      asks: [['80001.0', '1']],
    }, { U: 1, u: -1 }, true));
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) === 1);

    const book = bookOf(hub, symbol);
    book.bids.set('1000.00', '117.9');
    // Start the amortization window explicitly: the sweep clock is pinned to "now" so only the
    // frame counter can trigger the next full pass.
    book.framesSinceBandSweep = 0;
    book.lastBandSweepAt = Date.now();

    // 19 frames: the ghost is untouched, because a frame only inspects the prices it wrote.
    for (let index = 1; index <= 19; index += 1) {
      socket.send(frame(symbol, 1_771_990_800_000 + index, { bids: [[String(79_900 + index), '1']] }, { U: index + 1, u: -1 }));
      await waitFor(() => book.bids.size === 1 + index + 1);
      expect(book.framesSinceBandSweep).toBe(index);
    }
    expect(book.bids.has('1000.00')).toBe(true);

    // Frame 20 is the one that sweeps: the ghost disappears, the 20 real levels all stay.
    socket.send(frame(symbol, 1_771_990_820_000, { bids: [['79920.0', '1']] }, { U: 21, u: -1 }));
    await waitFor(() => !book.bids.has('1000.00'));
    expect(book.framesSinceBandSweep).toBe(0);
    expect(book.bids.size).toBe(21);
  });

  it('never empties a book whose touch itself looks corrupt', async () => {
    const { hub, socket } = await createHarness();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await waitFor(() => hub.marketCount() > 0);
    hub.watchOrderBook(symbol);

    // One stray ask far below the market drags the midpoint to ~40,000, so a literal band would
    // delete the entire legitimate book. The guard must leave it alone instead of blanking depth.
    socket.send(frame(symbol, 1_771_990_800_000, {
      bids: [['80000.0', '1'], ['79999.0', '1']],
      asks: [['1000.0', '1']],
    }, { U: 1, u: -1 }, true));
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) === 2);

    const book = bookOf(hub, symbol);
    (hub as unknown as HubInternals).sweepPriceBand(book);
    expect(book.bids.size).toBe(2);
    expect(book.asks.size).toBe(1);
  });
});
