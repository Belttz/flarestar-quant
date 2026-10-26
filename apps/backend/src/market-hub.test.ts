import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type WebSocketDefault from 'ws';
import { CrossExMarketHub, invalidSymbolsFromMessage, type MarketHubMessage } from './market-hub.js';

type ServerSocket = WebSocketDefault;

interface HubHarness {
  hub: CrossExMarketHub;
  server: WebSocketServer;
  socket: ServerSocket;
  received: Array<Record<string, unknown>>;
  messages: MarketHubMessage[];
}

const harnesses: HubHarness[] = [];

async function createHubHarness(): Promise<HubHarness> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('missing server address');
  const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`);
  const received: Array<Record<string, unknown>> = [];
  const messages: MarketHubMessage[] = [];
  hub.subscribe((message) => messages.push(message));
  // The hub may shard symbols across several upstream connections; capture frames from all of
  // them while keeping the first dial (the seed shard) as the harness's primary socket.
  const socketPromise = new Promise<ServerSocket>((resolve) => server.once('connection', resolve));
  server.on('connection', (sock: ServerSocket) => {
    sock.on('message', (data: { toString(): string }) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
  });
  hub.start();
  const socket = await socketPromise;
  const harness = { hub, server, socket, received, messages };
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

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.hub.stop();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
});

describe('CrossEx market subscription recovery', () => {
  it('extracts unsupported symbols from Gate subscription failures', () => {
    expect(invalidSymbolsFromMessage('There are unsupported symbols, invalidSymbols:[BINANCE_FUTURE_PEPE_USDT,DERIBIT_FUTURE_ARB_USDC]')).toEqual([
      'BINANCE_FUTURE_PEPE_USDT',
      'DERIBIT_FUTURE_ARB_USDC',
    ]);
    expect(invalidSymbolsFromMessage('another error')).toEqual([]);
  });
});

describe('CrossEx websocket liveness', () => {
  it('terminates and reconnects a half-dead socket that stops answering pings', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('missing server address');
    let connections = 0;
    server.on('connection', () => { connections += 1; });
    const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`, {
      heartbeatIntervalMs: 10, marketIdlePingAfterMs: 25, staleAfterMs: 10_000,
    });
    try {
      hub.start();
      await waitFor(() => connections === 1);
      // No pongs and no data: the hub must terminate the dead socket and dial again.
      await waitFor(() => connections >= 2, 5_000);
    } finally {
      hub.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('probes an otherwise healthy socket after all market channels are idle', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('missing server address');
    let connections = 0;
    server.on('connection', () => { connections += 1; });
    const socketPromise = new Promise<WebSocketDefault>((resolve) => server.once('connection', resolve));
    const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`, {
      // The pong must land before the next heartbeat tick, so keep the tick at 100ms: a 10ms
      // window flakes when the whole suite loads the CPU, while production defaults are 25s/2s.
      heartbeatIntervalMs: 100, marketIdlePingAfterMs: 100, staleAfterMs: 10_000,
    });
    try {
      hub.start();
      const socket = await socketPromise;
      let pingCount = 0;
      socket.on('ping', () => { pingCount += 1; });
      await waitFor(() => pingCount > 0);
      // Cover at least one follow-up heartbeat tick: the auto-pong must have arrived, the
      // connection must stay healthy, and no reconnect dial may have happened.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(hub.snapshot().connectionState).toBe('healthy');
      expect(connections).toBe(1);
    } finally {
      hub.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports a stale connection when the feed goes quiet and recovers when data resumes', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('missing server address');
    const socketPromise = new Promise<WebSocketDefault>((resolve) => server.once('connection', resolve));
    const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`, { heartbeatIntervalMs: 20, staleAfterMs: 50 });
    const messages: MarketHubMessage[] = [];
    hub.subscribe((message) => messages.push(message));
    try {
      hub.start();
      const socket = await socketPromise;
      // Pings are answered (socket is alive) but no pushes arrive: the hub must degrade to stale.
      await waitFor(() => hub.snapshot().connectionState === 'stale', 3_000);
      expect(messages.some((message) => message.type === 'market.snapshot' && message.payload.connectionState === 'stale')).toBe(true);

      socket.send(JSON.stringify({ time: 1, channel: 'ticker', event: 'update', result: {
        s: 'GATE_FUTURE_BTC_USDT', lp: '118500', bp: '118499.5', bs: '2', ap: '118500.5', as: '1.5',
        o: '118000', h: '119000', l: '117500', v: '1000', q: '118000000', ts: 1_771_990_800_000,
      } }));
      await waitFor(() => hub.snapshot().connectionState === 'healthy');
    } finally {
      hub.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('CrossEx ticker sparse-field fallback', () => {
  it('resolves null bid/ask from the maintained book top instead of dropping the frame', async () => {
    const { hub, socket } = await createHubHarness();
    await waitFor(() => hub.marketCount() > 0);
    const symbol = 'GATE_FUTURE_BTC_USDT';
    const releaseBook = hub.watchOrderBook(symbol);
    socket.send(JSON.stringify({ time: 1, channel: 'order_book_update', event: 'update', result: {
      snapshot: true, ts: 1_771_990_690_000, s: symbol,
      a: [['118500.5', '1.5'], ['118501.0', '2']],
      b: [['118499.5', '2.5'], ['118499.0', '3']],
    } }));
    await waitFor(() => hub.orderBook(symbol) !== null);

    // Sparse ticker: bid/ask and every 24h stat are null. The frame must still land, with the
    // quote sides backed by the book's top levels.
    socket.send(JSON.stringify({ time: 2, channel: 'ticker', event: 'update', result: {
      s: symbol, lp: '118500', bp: null, ap: null,
      o: null, h: null, l: null, v: null, ts: 1_771_990_800_000,
    } }));
    await waitFor(() => hub.market(symbol)?.source === 'gate_crossex_websocket');
    const market = hub.market(symbol);
    expect(market?.lastPrice).toBe('118500');
    expect(market?.bidPrice).toBe('118499.5');
    expect(market?.bidSize).toBe('2.5');
    expect(market?.askPrice).toBe('118500.5');
    expect(market?.askSize).toBe('1.5');

    // A later full ticker still wins over the book-backed values.
    socket.send(JSON.stringify({ time: 3, channel: 'ticker', event: 'update', result: {
      s: symbol, lp: '118502', bp: '118501.5', bs: '1', ap: '118502.5', as: '0.5',
      o: '118000', h: '119000', l: '117500', v: '1000', ts: 1_771_990_810_000,
    } }));
    await waitFor(() => hub.market(symbol)?.bidPrice === '118501.5');
    expect(hub.market(symbol)?.askPrice).toBe('118502.5');
    releaseBook();
  });

  /**
   * `quoteReceivedAt` is the local-clock twin of `quoteUpdatedAt`: same advance condition, different
   * clock. Browsers judge quote age and leg-to-leg skew by it, so it must move with the quote (and
   * stay put when a sparse frame only refreshes `lp`).
   */
  it('advances quoteReceivedAt only when the record\u2019s bid/ask actually move', async () => {
    const { hub, socket } = await createHubHarness();
    await waitFor(() => hub.marketCount() > 0);
    const symbol = 'GATE_FUTURE_BTC_USDT';
    const before = Date.now();
    socket.send(JSON.stringify({ time: 1, channel: 'ticker', event: 'update', result: {
      s: symbol, lp: '118500', bp: '118499.5', bs: '2', ap: '118500.5', as: '1.5',
      o: '118000', h: '119000', l: '117500', v: '1000', q: '118000000', ts: 1_771_990_800_000,
    } }));
    await waitFor(() => hub.market(symbol)?.bidPrice === '118499.5');
    const quoted = hub.market(symbol)?.quoteReceivedAt;
    expect(typeof quoted).toBe('number');
    expect(quoted as number).toBeGreaterThanOrEqual(before - 1_000);

    // A sparse frame carrying only `lp` refreshes `updatedAt` but supplies no quote side, so the
    // local quote stamp must not move (same rule as `quoteUpdatedAt`).
    socket.send(JSON.stringify({ time: 2, channel: 'ticker', event: 'update', result: {
      s: symbol, lp: '118600', bp: null, ap: null,
      o: null, h: null, l: null, v: null, ts: 1_771_990_810_000,
    } }));
    await waitFor(() => hub.market(symbol)?.lastPrice === '118600');
    expect(hub.market(symbol)?.quoteReceivedAt).toBe(quoted);
    // The venue clock did move (new frame), which is exactly why the two fields are separate.
    expect(hub.market(symbol)?.quoteUpdatedAt).toBe(new Date(1_771_990_800_000).toISOString());
  });

  it('keeps previously published 24h fields when a push nulls them out', async () => {    const { hub, socket } = await createHubHarness();
    await waitFor(() => hub.marketCount() > 0);
    const symbol = 'BINANCE_FUTURE_ETH_USDT';
    socket.send(JSON.stringify({ time: 1, channel: 'ticker', event: 'update', result: {
      s: symbol, lp: '3862', bp: '3861.5', bs: '2', ap: '3862.5', as: '1',
      o: '3800', h: '3900', l: '3750', v: '900', q: '3467400', ts: 1_771_990_800_000,
    } }));
    await waitFor(() => hub.market(symbol)?.source === 'gate_crossex_websocket');

    socket.send(JSON.stringify({ time: 2, channel: 'ticker', event: 'update', result: {
      s: symbol, lp: '3863', bp: '3862.5', bs: '2', ap: '3863.5', as: '1',
      o: null, h: null, l: null, v: null, ts: 1_771_990_810_000,
    } }));
    await waitFor(() => hub.market(symbol)?.lastPrice === '3863');
    const market = hub.market(symbol);
    expect(market?.open24h).toBe('3800');
    expect(market?.high24h).toBe('3900');
    expect(market?.low24h).toBe('3750');
    expect(market?.volume24h).toBe('900');
  });

  it('keeps the stored record untouched when a frame carries no usable quote at all', async () => {
    const { hub, socket } = await createHubHarness();
    await waitFor(() => hub.marketCount() > 0);
    const symbol = 'OKX_FUTURE_BTC_USDT';
    socket.send(JSON.stringify({ time: 1, channel: 'ticker', event: 'update', result: {
      s: symbol, lp: '118420', bp: '118419', bs: '1', ap: '118421', as: '1',
      o: '118000', h: '119000', l: '117500', v: '1000', ts: 1_771_990_800_000,
    } }));
    await waitFor(() => hub.market(symbol)?.source === 'gate_crossex_websocket');
    const before = hub.market(symbol);

    // No lp, no bid/ask, no book for this symbol: nothing may be published or wiped.
    socket.send(JSON.stringify({ time: 2, channel: 'ticker', event: 'update', result: {
      s: symbol, lp: '', bp: null, ap: null,
      o: null, h: null, l: null, v: null, ts: 1_771_990_820_000,
    } }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(hub.market(symbol)).toEqual(before);
  });

  it('maps native spot pair names onto registered GATE spot markets for ticker, book, and kline pushes', async () => {
    const { hub, socket } = await createHubHarness();
    await waitFor(() => hub.marketCount() > 0);
    const symbol = 'GATE_SPOT_BTC_USDT';
    expect(hub.ensureMarkets([{ symbol, venue: 'GATE', asset: 'BTC' }])).toBe(true);

    socket.send(JSON.stringify({ time: 1, channel: 'ticker', event: 'update', result: {
      s: 'BTC_USDT', lp: '118420', bp: '118419', bs: '0.5', ap: '118421', as: '0.4',
      o: '118000', h: '119000', l: '117500', v: '100', ts: 1_771_990_800_000,
    } }));
    await waitFor(() => hub.market(symbol)?.source === 'gate_crossex_websocket');
    expect(hub.market(symbol)?.lastPrice).toBe('118420');
    expect(hub.market(symbol)?.bidPrice).toBe('118419');

    hub.watchOrderBook(symbol);
    socket.send(JSON.stringify({ time: 2, channel: 'order_book_update', event: 'update', result: {
      snapshot: true, ts: 1_771_990_810_000, s: 'BTC_USDT',
      a: [['118421', '0.4']], b: [['118419', '0.5']],
    } }));
    await waitFor(() => (hub.orderBook(symbol)?.bids.length ?? 0) > 0);
    expect(hub.orderBook(symbol)?.bids).toEqual([['118419', '0.5']]);

    hub.watchKlines(symbol, '1m');
    socket.send(JSON.stringify({ channel: 'kline_1m', event: 'update', result: {
      s: 'BTC_USDT', o: '118400', h: '118430', l: '118390', c: '118420', v: '10', t: 1_771_990_740_000, T: 1_771_990_799_999, x: false,
    } }));
    await waitFor(() => hub.candles(symbol, '1m').length === 1);
    expect(hub.candles(symbol, '1m')[0]).toMatchObject({ close: '118420' });
  });
});

describe('CrossEx price provenance', () => {
  it('never lets funding or open-interest pushes mark seed or stale prices as fresh live data', async () => {
    const { hub, socket, received } = await createHubHarness();
    await waitFor(() => received.some((message) => message.channel === 'ticker'));
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    const seeded = hub.market(symbol);
    expect(seeded?.source).toBe('demo_seed');

    // Funding and OI pushes arriving before any ticker must not upgrade provenance or freshness.
    socket.send(JSON.stringify({ time: 1, channel: 'funding_rate', event: 'update', result: { s: symbol, r: '0.0003', T: 1_771_990_700_000 } }));
    socket.send(JSON.stringify({ time: 1, channel: 'open_interest', event: 'update', result: { s: symbol, oi: '1234', oiV: '145000000' } }));
    await waitFor(() => hub.market(symbol)?.fundingRate === '0.0003' && hub.market(symbol)?.openInterest === '1234');
    const preTicker = hub.market(symbol);
    expect(preTicker?.source).toBe('demo_seed');
    expect(preTicker?.updatedAt).toBe(seeded?.updatedAt);
    expect(preTicker?.bidPrice).toBe(seeded?.bidPrice);

    const tickerTs = 1_771_990_800_000;
    socket.send(JSON.stringify({ time: 2, channel: 'ticker', event: 'update', result: {
      s: symbol, lp: '118500', bp: '118499.5', bs: '2', ap: '118500.5', as: '1.5',
      o: '118000', h: '119000', l: '117500', v: '1000', q: '118000000', ts: tickerTs,
    } }));
    await waitFor(() => hub.market(symbol)?.source === 'gate_crossex_websocket');
    expect(hub.market(symbol)?.updatedAt).toBe(new Date(tickerTs).toISOString());
    expect(Date.parse(hub.market(symbol)?.receivedAt ?? '')).toBeGreaterThan(tickerTs);

    // A later funding push updates its own fields but must not refresh price freshness.
    socket.send(JSON.stringify({ time: 3, channel: 'funding_rate', event: 'update', result: { s: symbol, r: '0.0005', T: 1_771_990_900_000 } }));
    await waitFor(() => hub.market(symbol)?.fundingRate === '0.0005');
    const afterFunding = hub.market(symbol);
    expect(afterFunding?.updatedAt).toBe(new Date(tickerTs).toISOString());
    expect(afterFunding?.bidPrice).toBe('118499.5');
    expect(afterFunding?.source).toBe('gate_crossex_websocket');

    // Delayed frames can arrive around a reconnect. They must not roll an executable quote back
    // after a newer source timestamp has already been accepted.
    socket.send(JSON.stringify({ time: 4, channel: 'ticker', event: 'update', result: {
      s: symbol, lp: '108500', bp: '108499.5', bs: '2', ap: '108500.5', as: '1.5',
      o: '108000', h: '109000', l: '107500', v: '1000', q: '108000000', ts: tickerTs - 1_000,
    } }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(hub.market(symbol)?.updatedAt).toBe(new Date(tickerTs).toISOString());
    expect(hub.market(symbol)?.bidPrice).toBe('118499.5');
  });
});

describe('CrossEx dynamic market channels', () => {
  it('does not evict a dynamic market while a client is watching its quote', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1');
    const symbol = 'GATE_FUTURE_SKHY_USDT';
    expect(hub.ensureMarkets([{ symbol, venue: 'GATE', asset: 'SKHY' }])).toBe(true);
    const internals = hub as unknown as {
      dynamicMarkets: Map<string, number>;
      evictIdleDynamicMarkets(): void;
    };
    const release = hub.watchQuotes([symbol]);
    internals.dynamicMarkets.set(symbol, 0);
    internals.evictIdleDynamicMarkets();
    expect(hub.snapshot().markets.some((market) => market.symbol === symbol)).toBe(true);

    release();
    internals.dynamicMarkets.set(symbol, 0);
    internals.evictIdleDynamicMarkets();
    expect(hub.snapshot().markets.some((market) => market.symbol === symbol)).toBe(false);
  });

  it('spreads subscriptions across shard connections so no frame exceeds the 100-symbol cap', async () => {
    const { hub, received } = await createHubHarness();
    await waitFor(() => received.some((message) => message.channel === 'ticker'));
    const definitions = Array.from({ length: 130 }, (_, index) => ({
      symbol: `GATE_FUTURE_DYN${index}_USDT`,
      venue: 'GATE' as const,
      asset: `DYN${index}`,
    }));
    expect(hub.ensureMarkets(definitions)).toBe(true);
    await waitFor(() => {
      const subscribed = new Set(received
        .filter((message) => message.channel === 'ticker' && message.event === 'subscribe')
        .flatMap((message) => message.payload as string[])
        .filter((symbol) => String(symbol).includes('_DYN')));
      return subscribed.size >= 130;
    }, 5_000);

    for (const channel of ['ticker', 'funding_rate', 'open_interest']) {
      const frames = received.filter((message) =>
        message.channel === channel
        && message.event === 'subscribe'
        && Array.isArray(message.payload)
        && (message.payload as unknown[]).some((symbol) => String(symbol).includes('_DYN')));
      // 20 dynamic symbols land on the seed shard (capacity left below 100) and the remaining
      // 110 need two more connections: three shard frames per channel in total.
      expect(frames.length).toBe(3);
      expect(frames.every((message) => (message.payload as unknown[]).length <= 100)).toBe(true);
      const symbols = frames.flatMap((message) => message.payload as string[]).filter((symbol) => String(symbol).includes('_DYN'));
      expect(new Set(symbols).size).toBe(130);
    }
  });

  it('maintains an incremental order book with refcounted upstream subscriptions', async () => {
    const { hub, socket, received, messages } = await createHubHarness();
    await waitFor(() => received.some((message) => message.channel === 'ticker'));

    const releaseFirst = hub.watchOrderBook('GATE_FUTURE_BTC_USDT');
    const releaseSecond = hub.watchOrderBook('GATE_FUTURE_BTC_USDT');
    await waitFor(() => received.some((message) => message.channel === 'order_book_update' && message.event === 'subscribe'));
    expect(received.filter((message) => message.channel === 'order_book_update' && message.event === 'subscribe')).toHaveLength(1);

    socket.send(JSON.stringify({ time: 1, channel: 'order_book_update', event: 'update', result: {
      snapshot: true, ts: 1_771_990_690_844, s: 'GATE_FUTURE_BTC_USDT', U: 1, u: 2,
      a: [['118500.1', '0.5'], ['118500.9', '1.25']],
      b: [['118499.8', '0.75'], ['118498.2', '2']],
    } }));
    await waitFor(() => hub.orderBook('GATE_FUTURE_BTC_USDT') !== null);

    socket.send(JSON.stringify({ time: 2, channel: 'order_book_update', event: 'update', result: {
      snapshot: false, ts: 1_771_990_691_000, s: 'GATE_FUTURE_BTC_USDT', U: 3, u: 4,
      a: [['118500.1', '0']],
      b: [['118499.9', '3.5']],
    } }));
    await waitFor(() => (hub.orderBook('GATE_FUTURE_BTC_USDT')?.bids.length ?? 0) === 3);

    const book = hub.orderBook('GATE_FUTURE_BTC_USDT');
    expect(book?.asks).toEqual([['118500.9', '1.25']]);
    expect(book?.bids).toEqual([['118499.9', '3.5'], ['118499.8', '0.75'], ['118498.2', '2']]);
    expect(messages.some((message) => message.type === 'orderbook.update')).toBe(true);

    releaseFirst();
    expect(received.filter((message) => message.channel === 'order_book_update' && message.event === 'unsubscribe')).toHaveLength(0);
    releaseSecond();
    await waitFor(() => received.some((message) => message.channel === 'order_book_update' && message.event === 'unsubscribe'));
    expect(hub.orderBook('GATE_FUTURE_BTC_USDT')).toBeNull();
  });

  it('attributes raw exchange trade symbols back to the watched CrossEx symbol and dedupes trade ids', async () => {
    const { hub, socket, received } = await createHubHarness();
    await waitFor(() => received.some((message) => message.channel === 'ticker'));
    hub.watchTrades('BINANCE_FUTURE_BTC_USDT');
    await waitFor(() => received.some((message) => message.channel === 'trade' && message.event === 'subscribe'));

    const push = { time: 3, channel: 'trade', event: 'update', result: {
      s: 'BTCUSDT', i: '18473628192', p: '67250.12', q: '0.015', S: 'BUY', ts: 1_771_990_692_000, m: false,
    } };
    socket.send(JSON.stringify(push));
    socket.send(JSON.stringify(push));
    socket.send(JSON.stringify({ ...push, result: { ...push.result, i: '18473628193', S: 'SELL', s: 'BINANCE_FUTURE_BTC_USDT' } }));
    await waitFor(() => hub.recentTrades('BINANCE_FUTURE_BTC_USDT').length === 2);

    const trades = hub.recentTrades('BINANCE_FUTURE_BTC_USDT');
    expect(trades[0]).toMatchObject({ id: '18473628193', side: 'SELL', symbol: 'BINANCE_FUTURE_BTC_USDT' });
    expect(trades[1]).toMatchObject({ id: '18473628192', side: 'BUY', price: '67250.12' });
  });

  it('accumulates kline series, replaces the in-progress candle, and merges REST backfill behind live data', async () => {
    const { hub, socket, received } = await createHubHarness();
    await waitFor(() => received.some((message) => message.channel === 'ticker'));
    hub.watchKlines('OKX_FUTURE_ETH_USDT', '1m');
    await waitFor(() => received.some((message) => message.channel === 'kline_1m' && message.event === 'subscribe'));

    socket.send(JSON.stringify({ channel: 'kline_1m', event: 'update', result: {
      s: 'OKX_FUTURE_ETH_USDT', o: '3860', h: '3865', l: '3859', c: '3862', v: '120.5', t: 1_710_000_000_000, T: 1_710_000_059_999, x: false,
    } }));
    socket.send(JSON.stringify({ channel: 'kline_1m', event: 'update', result: {
      s: 'OKX_FUTURE_ETH_USDT', o: '3860', h: '3870', l: '3859', c: '3869', v: '180.25', t: 1_710_000_000_000, T: 1_710_000_059_999, x: true,
    } }));
    socket.send(JSON.stringify({ channel: 'kline_1m', event: 'update', result: {
      s: 'OKX_FUTURE_ETH_USDT', o: '3869', h: '3871', l: '3868', c: '3870', v: '15', t: 1_710_000_060_000, T: 1_710_000_119_999, x: false,
    } }));
    await waitFor(() => hub.candles('OKX_FUTURE_ETH_USDT', '1m').length === 2);

    hub.seedCandles('OKX_FUTURE_ETH_USDT', '1m', [
      { startTime: 1_709_999_940_000, open: '3855', high: '3861', low: '3854', close: '3860', volume: '95', closed: true },
      { startTime: 1_710_000_000_000, open: '9999', high: '9999', low: '9999', close: '9999', volume: '0', closed: true },
    ]);

    const candles = hub.candles('OKX_FUTURE_ETH_USDT', '1m');
    expect(candles.map((candle) => candle.startTime)).toEqual([1_709_999_940_000, 1_710_000_000_000, 1_710_000_060_000]);
    expect(candles[1]).toMatchObject({ close: '3869', closed: true });
    expect(candles[2]).toMatchObject({ close: '3870', closed: false });
  });

  it('never publishes disconnected candle segments as one series', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1');
    hub.seedCandles('BINANCE_FUTURE_BTC_USDT', '1m', [
      { startTime: 0, open: '1', high: '1', low: '1', close: '1', volume: '1', closed: true },
      { startTime: 60_000, open: '1', high: '1', low: '1', close: '1', volume: '1', closed: true },
      { startTime: 600_000, open: '2', high: '2', low: '2', close: '2', volume: '1', closed: true },
      { startTime: 660_000, open: '2', high: '2', low: '2', close: '2', volume: '1', closed: true },
    ]);

    expect(hub.candles('BINANCE_FUTURE_BTC_USDT', '1m').map((item) => item.startTime))
      .toEqual([600_000, 660_000]);
  });
});

describe('CrossEx dynamic market budget', () => {
  const definitions = (prefix: string, count: number): Array<{ symbol: string; venue: 'GATE'; asset: string }> =>
    Array.from({ length: count }, (_, index) => ({
      symbol: `GATE_SPOT_${prefix}${index}_USDT`,
      venue: 'GATE' as const,
      asset: `${prefix}${index}`,
    }));

  it('recycles the coldest dynamic market instead of refusing new registrations', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', { maxDynamicSymbols: 4 });
    // Saturate the budget with the first generation of browsed markets.
    expect(hub.ensureMarkets(definitions('OLD', 4))).toBe(true);
    expect(hub.registrationStats().used).toBe(4);

    // A cold un-watched market is the one recycled, so the boards' own top rows stay registered.
    const internals = hub as unknown as { dynamicMarkets: Map<string, number> };
    internals.dynamicMarkets.set('GATE_SPOT_OLD0_USDT', 0);

    // The regression: this used to return false forever once the budget was full, which left every
    // newly opened market showing zeros and read to users as "that exchange has no data".
    expect(hub.ensureMarkets([{ symbol: 'BINANCE_SPOT_NEW_USDT', venue: 'BINANCE', asset: 'NEW' }])).toBe(true);
    expect(hub.market('BINANCE_SPOT_NEW_USDT')).not.toBeNull();
    expect(hub.registrationStats().used).toBe(4);
    // The coldest registration left; the rest were kept.
    expect(hub.market('GATE_SPOT_OLD0_USDT')).toBeNull();
    expect(hub.market('GATE_SPOT_OLD1_USDT')).not.toBeNull();
  });

  it('never evicts a market somebody is streaming to make room for a new one', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', { maxDynamicSymbols: 2 });
    expect(hub.ensureMarkets(definitions('HOT', 2))).toBe(true);
    const release = hub.watchQuotes(['GATE_SPOT_HOT0_USDT', 'GATE_SPOT_HOT1_USDT']);
    const internals = hub as unknown as { dynamicMarkets: Map<string, number> };
    for (const symbol of internals.dynamicMarkets.keys()) internals.dynamicMarkets.set(symbol, 0);

    // Every slot is pinned: the request must fail cleanly (not silently drop half rows).
    expect(hub.ensureMarkets([{ symbol: 'OKX_SPOT_NEW_USDT', venue: 'OKX', asset: 'NEW' }])).toBe(false);
    expect(hub.market('GATE_SPOT_HOT0_USDT')).not.toBeNull();
    expect(hub.market('GATE_SPOT_HOT1_USDT')).not.toBeNull();

    release();
    expect(hub.ensureMarkets([{ symbol: 'OKX_SPOT_NEW_USDT', venue: 'OKX', asset: 'NEW' }])).toBe(true);
  });

  it('registers what fits when a batch is larger than the remaining budget', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', { maxDynamicSymbols: 3 });
    // Partial admission: one of three fits now instead of the whole batch being discarded.
    expect(hub.ensureMarkets(definitions('BIG', 5))).toBe(false);
    expect(hub.registrationStats().used).toBe(3);
    expect(hub.market('GATE_SPOT_BIG0_USDT')).not.toBeNull();
    expect(hub.market('GATE_SPOT_BIG4_USDT')).toBeNull();
  });

  it('reports budget starvation through the degradation sink instead of failing silently', () => {
    const warnings: Array<{ reason: string; detail?: Record<string, unknown> }> = [];
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', {
      maxDynamicSymbols: 1,
      warn: (reason, detail) => warnings.push({ reason, detail }),
    });
    expect(hub.ensureMarkets(definitions('AUDIT', 3))).toBe(false);
    expect(warnings.map((entry) => entry.reason)).toContain('market_hub_dynamic_budget_exhausted');
    const audit = warnings.find((entry) => entry.reason === 'market_hub_dynamic_budget_exhausted');
    expect(audit?.detail).toMatchObject({ requested: 3, admitted: 1, refused: 2, budget: 1 });
  });

  it('still serves every symbol when the batch is re-requested once room exists', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1', { maxDynamicSymbols: 2 });
    hub.watchQuotes([]);
    expect(hub.ensureMarkets(definitions('WARM', 2))).toBe(true);
    // Re-asking for the same set refreshes their recency without spending new slots.
    expect(hub.ensureMarkets(definitions('WARM', 2))).toBe(true);
    expect(hub.registrationStats().used).toBe(2);
  });
});
