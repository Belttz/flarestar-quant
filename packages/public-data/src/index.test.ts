import { describe, expect, it, vi } from 'vitest';
import { PublicMarketDataError, VenuePublicMarketDataClient } from './index.js';

function response(payload: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
}

describe('venue public market data client', () => {
  it('normalizes Binance book, mark, index, and funding data without credentials', async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('KEY')).toBe(false);
      return String(url).includes('bookTicker')
        ? response({ bidPrice: '63962.00', askPrice: '63962.10', time: 1_783_703_477_021 })
        : response({ markPrice: '63952.97', indexPrice: '63967.51', lastFundingRate: '0.00010000', nextFundingTime: 1_783_728_000_000, time: 1_783_703_462_000 });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => 1_783_703_500_000);

    const snapshot = await client.querySnapshot('BINANCE_FUTURE_BTC_USDT');

    expect(snapshot).toMatchObject({
      venue: 'BINANCE', bidPrice: '63962.00', askPrice: '63962.10', markPrice: '63952.97',
      indexPrice: '63967.51', fundingRate: '0.00010000', source: 'binance_futures_public_rest',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('normalizes Gate ticker and funding timing', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => String(url).includes('/contracts/')
      ? response({ funding_next_apply: 1_783_728_000 })
      : response([{ last: '63952.3', funding_rate_indicative: '0.0001', index_price: '63968.12', funding_rate: '0.0001', mark_price: '63952.3', highest_bid: '63952.2', lowest_ask: '63952.3' }]));
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => 1_783_703_500_000);

    const snapshot = await client.querySnapshot('GATE_FUTURE_BTC_USDT');

    expect(snapshot).toMatchObject({
      venue: 'GATE', lastPrice: '63952.3', predictedFundingRate: '0.0001',
      nextFundingAt: '2026-07-11T00:00:00.000Z', source: 'gate_futures_public_rest',
    });
  });

  it('normalizes OKX ticker, mark, index, and funding responses', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/market/ticker?')) return response({ code: '0', msg: '', data: [{ last: '63965', askPx: '63965.1', bidPx: '63965', ts: '1783703477068' }] });
      if (value.includes('/mark-price?')) return response({ code: '0', msg: '', data: [{ markPx: '63966', ts: '1783703477112' }] });
      if (value.includes('/index-tickers?')) return response({ code: '0', msg: '', data: [{ idxPx: '63984.9', ts: '1783703483616' }] });
      return response({ code: '0', msg: '', data: [{ fundingRate: '0.00009848', fundingTime: '1783728000000', nextFundingRate: '', nextFundingTime: '1783756800000', ts: '1783703419692' }] });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => 1_783_703_500_000);

    const snapshot = await client.querySnapshot('OKX_FUTURE_BTC_USDT');

    expect(snapshot).toMatchObject({
      venue: 'OKX', markPrice: '63966', indexPrice: '63984.9', fundingRate: '0.00009848',
      predictedFundingRate: null, nextFundingAt: '2026-07-11T00:00:00.000Z', source: 'okx_public_rest',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('maps contract sizes for contract-denominated feeds and drops inverse instruments', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => String(url).includes('api.gateio.ws')
      ? response([
        { name: 'BTC_USDT', quanto_multiplier: '0.0001' },
        { name: 'ETH_USDT', quanto_multiplier: '0.01' },
      ])
      : response({ code: '0', msg: '', data: [
        { instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctValCcy: 'BTC' },
        { instId: 'BTC-USD-SWAP', ctVal: '100', ctValCcy: 'USD' },
      ] }));
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    expect(await client.queryContractSizes('GATE')).toEqual([
      { base: 'BTC', quote: 'USDT', multiplier: '0.0001' },
      { base: 'ETH', quote: 'USDT', multiplier: '0.01' },
    ]);
    // The inverse swap's ctVal is USD-denominated and must not be mistaken for base units.
    expect(await client.queryContractSizes('OKX')).toEqual([
      { base: 'BTC', quote: 'USDT', multiplier: '0.01' },
    ]);
  });

  it('rejects unsupported venues and products rather than guessing mappings', async () => {
    const client = new VenuePublicMarketDataClient(vi.fn() as typeof fetch);
    await expect(client.querySnapshot('BYBIT_FUTURE_BTC_USDT'))
      .rejects.toEqual(new PublicMarketDataError('UNSUPPORTED_SYMBOL'));
    await expect(client.querySnapshot('BINANCE_SPOT_BTC_USDT'))
      .rejects.toEqual(new PublicMarketDataError('UNSUPPORTED_SYMBOL'));
  });

  it('normalizes Gate futures candles into ascending millisecond series', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      expect(String(url)).toBe('https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=1m&limit=2');
      return response([
        { t: 1_783_703_460, o: '63950.1', h: '63960.0', l: '63948.2', c: '63955.5', v: 1250 },
        { t: 1_783_703_400, o: '63940.0', h: '63951.0', l: '63939.5', c: '63950.1', v: 980 },
      ]);
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => 1_783_703_490_000);

    const candles = await client.queryCandles('GATE_FUTURE_BTC_USDT', '1m', 2);

    expect(candles.map((candle) => candle.startTime)).toEqual([1_783_703_400_000, 1_783_703_460_000]);
    expect(candles[0]).toMatchObject({ open: '63940.0', close: '63950.1', volume: '980', closed: true });
    expect(candles[1]).toMatchObject({ closed: false });
  });

  it('normalizes Gate spot candlestick rows into ascending millisecond series', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      expect(String(url)).toBe('https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1m&limit=2');
      // GET /spot/candlesticks returns positional rows: [unix, quoteVolume, o, h, l, c, baseVolume, closed].
      return response([
        ['1783703460', '639550000.0', '63950.1', '63960.0', '63948.2', '63955.5', '1.25', 'true'],
        ['1783703400', '639400000.0', '63940.0', '63951.0', '63939.5', '63950.1', '0.98', 'false'],
      ]);
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => 1_783_703_490_000);

    const candles = await client.queryCandles('GATE_SPOT_BTC_USDT', '1m', 2);

    expect(candles.map((candle) => candle.startTime)).toEqual([1_783_703_400_000, 1_783_703_460_000]);
    expect(candles[0]).toMatchObject({ open: '63940.0', close: '63950.1', volume: '0.98', closed: true });
    expect(candles[1]).toMatchObject({ closed: false });
  });

  it('requests the Gate page immediately before an exclusive history cursor', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      expect(String(url)).toBe('https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=1m&from=1783703279&to=1783703399');
      return response([
        { t: 1_783_703_340, o: '63940', h: '63950', l: '63930', c: '63945', v: 12 },
        { t: 1_783_703_280, o: '63920', h: '63942', l: '63910', c: '63940', v: 10 },
      ]);
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => 1_783_703_500_000);

    const candles = await client.queryCandles('GATE_FUTURE_BTC_USDT', '1m', 2, 1_783_703_400_000);

    expect(candles.map((candle) => candle.startTime)).toEqual([1_783_703_280_000, 1_783_703_340_000]);
    expect(candles.every((candle) => candle.startTime < 1_783_703_400_000)).toBe(true);
  });

  it('normalizes Binance kline arrays and OKX newest-first candles', async () => {
    const binanceFetch = vi.fn((url: string | URL | Request) => {
      expect(String(url)).toContain('endTime=1783703399999');
      return response([
        [1_783_703_300_000, '63940.0', '63951.0', '63939.5', '63950.1', '312.5', 1_783_703_359_999, '0', 0, '0', '0', '0'],
      ]);
    });
    const binance = new VenuePublicMarketDataClient(binanceFetch as typeof fetch, () => 1_783_703_500_000);
    const binanceCandles = await binance.queryCandles('BINANCE_FUTURE_BTC_USDT', '1m', 1, 1_783_703_400_000);
    expect(binanceCandles).toEqual([{
      startTime: 1_783_703_300_000, open: '63940.0', high: '63951.0', low: '63939.5',
      close: '63950.1', volume: '312.5', closed: true,
    }]);

    const okxFetch = vi.fn((url: string | URL | Request) => {
      expect(String(url)).toContain('/market/history-candles?');
      expect(String(url)).toContain('bar=4H');
      expect(String(url)).toContain('after=1783703400000');
      return response({ code: '0', msg: '', data: [
        ['1783699200000', '63930', '63970', '63910', '63955', '5230', '523', '33440000', '0'],
        ['1783684800000', '63890', '63940', '63870', '63930', '6100', '610', '38990000', '1'],
      ] });
    });
    const okx = new VenuePublicMarketDataClient(okxFetch as typeof fetch, () => 1_783_703_500_000);
    const okxCandles = await okx.queryCandles('OKX_FUTURE_BTC_USDT', '4h', 2, 1_783_703_400_000);
    expect(okxCandles.map((candle) => candle.startTime)).toEqual([1_783_684_800_000, 1_783_699_200_000]);
    expect(okxCandles[1]).toMatchObject({ close: '63955', closed: false });
  });

  it('normalizes Bybit and Kraken perpetual candles and maps their venue symbols', async () => {
    const bybitFetch = vi.fn((url: string | URL | Request) => {
      expect(String(url)).toBe('https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCPERP&interval=60&limit=2&end=1783703499999');
      return response({ retCode: 0, result: { list: [
        ['1783702800000', '63950', '63970', '63940', '63960', '12.5', '799500'],
        ['1783699200000', '63900', '63960', '63880', '63950', '10.1', '645000'],
      ] } });
    });
    const bybit = new VenuePublicMarketDataClient(bybitFetch as typeof fetch, () => 1_783_703_500_000);
    const bybitCandles = await bybit.queryCandles('BYBIT_FUTURE_BTC_USDC', '1h', 2, 1_783_703_500_000);
    expect(bybitCandles.map((candle) => candle.startTime)).toEqual([1_783_699_200_000, 1_783_702_800_000]);
    expect(bybitCandles[1]).toMatchObject({ close: '63960', volume: '12.5', closed: false });

    const krakenFetch = vi.fn((url: string | URL | Request) => {
      expect(String(url)).toBe('https://futures.kraken.com/api/charts/v1/trade/PF_XDGUSD/5m?count=1&to=1783703499');
      return response({ candles: [
        { time: 1_783_703_100_000, open: '0.23', high: '0.24', low: '0.22', close: '0.235', volume: 10824 },
      ], more_candles: false });
    });
    const kraken = new VenuePublicMarketDataClient(krakenFetch as typeof fetch, () => 1_783_703_500_000);
    expect(await kraken.queryCandles('KRAKEN_FUTURE_DOGE_USD', '5m', 1, 1_783_703_500_000)).toEqual([{
      startTime: 1_783_703_100_000, open: '0.23', high: '0.24', low: '0.22',
      close: '0.235', volume: '10824', closed: true,
    }]);
  });

  it('normalizes Hyperliquid candles and composes Deribit 4h candles from hourly bars', async () => {
    const hyperliquidFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      if (body.type === 'allPerpMetas') return response([{ universe: [{ name: 'BTC' }] }]);
      expect(body).toEqual({
        type: 'candleSnapshot',
        req: {
          coin: 'BTC', interval: '15m',
          startTime: 1_783_701_699_999, endTime: 1_783_703_499_999,
        },
      });
      return response([
        { t: 1_783_701_700_000, T: 1_783_702_599_999, s: 'BTC', i: '15m', o: '63900', h: '63930', l: '63890', c: '63920', v: '3.2', n: 10 },
        { t: 1_783_702_600_000, T: 1_783_703_499_999, s: 'BTC', i: '15m', o: '63920', h: '63940', l: '63910', c: '63935', v: '2.1', n: 8 },
      ]);
    });
    const hyperliquid = new VenuePublicMarketDataClient(hyperliquidFetch as typeof fetch, () => 1_783_703_500_000);
    const hyperliquidCandles = await hyperliquid.queryCandles('HYPERLIQUID_FUTURE_BTC_USDC', '15m', 2, 1_783_703_500_000);
    expect(hyperliquidCandles).toHaveLength(2);
    expect(hyperliquidCandles[1]).toMatchObject({ close: '63935', volume: '2.1', closed: true });

    const deribitFetch = vi.fn((url: string | URL | Request) => {
      expect(String(url)).toContain('instrument_name=BTC_USDC-PERPETUAL');
      expect(String(url)).toContain('resolution=60');
      expect(String(url)).toContain('end_timestamp=1783703499999');
      return response({ result: {
        status: 'ok',
        ticks: [1_783_684_800_000, 1_783_688_400_000, 1_783_692_000_000, 1_783_695_600_000, 1_783_699_200_000],
        open: [100, 101, 102, 103, 104],
        high: [102, 103, 104, 105, 106],
        low: [99, 100, 101, 102, 103],
        close: [101, 102, 103, 104, 105],
        volume: [1, 2, 3, 4, 5],
      } });
    });
    const deribit = new VenuePublicMarketDataClient(deribitFetch as typeof fetch, () => 1_783_703_500_000);
    expect(await deribit.queryCandles('DERIBIT_FUTURE_BTC_USDC', '4h', 2, 1_783_703_500_000)).toEqual([
      { startTime: 1_783_684_800_000, open: '100', high: '105', low: '99', close: '104', volume: '10', closed: true },
      { startTime: 1_783_699_200_000, open: '104', high: '106', low: '103', close: '105', volume: '5', closed: false },
    ]);
  });

  it('normalizes Lighter candles after resolving market ids from its public market list', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const value = String(url);
      if (value === 'https://mainnet.zklighter.elliot.ai/api/v1/orderBooks') {
        return response({ code: 200, order_books: [{ symbol: 'BTC', market_id: 1 }, { symbol: 'TSM', market_id: 140 }] });
      }
      expect(value).toBe('https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id=1&resolution=15m&start_timestamp=1783701699999&end_timestamp=1783703499999&count_back=2');
      return response({ code: 200, r: '15m', c: [
        { t: 1_783_701_700_000, o: 63900, h: 63930, l: 63890, c: 63920, v: 3.2, V: 204480, i: 1 },
        { t: 1_783_702_600_000, o: 63920, h: 63940, l: 63910, c: 63935, v: 2.1, V: 134263, i: 2 },
      ] });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => 1_783_703_500_000);

    expect(await client.queryCandles('LIGHTER_FUTURE_BTC_USDC', '15m', 2, 1_783_703_500_000)).toEqual([
      { startTime: 1_783_701_700_000, open: '63900', high: '63930', low: '63890', close: '63920', volume: '3.2', closed: true },
      { startTime: 1_783_702_600_000, open: '63920', high: '63940', low: '63910', close: '63935', volume: '2.1', closed: true },
    ]);
    // Unknown assets get at most one forced list refresh per minute before failing; with the
    // clock frozen the cached list is reused, so no second list request goes out.
    await expect(client.queryCandles('LIGHTER_FUTURE_NOPE_USDC', '15m', 2, 1_783_703_500_000))
      .rejects.toMatchObject({ code: 'UNKNOWN_LIGHTER_MARKET' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/orderBooks'))).toHaveLength(1);
  });

  it('resolves HIP-3 native names from cached allPerpMetas for candles and funding history', async () => {
    const now = 1_783_703_500_000;
    let stored: import('./index.js').HyperliquidPerpMetadataSnapshot | null = null;
    const metadataStore = {
      read: () => stored,
      write: (snapshot: import('./index.js').HyperliquidPerpMetadataSnapshot) => { stored = snapshot; },
    };
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.type === 'allPerpMetas') {
        return response([
          { universe: [{ name: 'BTC' }] },
          { universe: [{ name: 'xyz:SNDK' }, { name: 'xyz:OLD', isDelisted: true }] },
        ]);
      }
      if (body.type === 'candleSnapshot') {
        expect(body.req.coin).toBe('xyz:SNDK');
        return response([]);
      }
      expect(body).toMatchObject({ type: 'fundingHistory', coin: 'xyz:SNDK' });
      return response([{ fundingRate: '0.00001', time: 9_000 }]);
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => now, {
      hyperliquidMetadataStore: metadataStore,
    });

    await client.queryCandles('HYPERLIQUID_FUTURE_SNDK_USDC', '1h', 1);
    await expect(client.queryFundingHistory('HYPERLIQUID_FUTURE_SNDK_USDC', 1_000, 10_000))
      .resolves.toEqual([{ timestamp: 9_000, rate: '0.00001' }]);

    expect(fetchMock.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).type === 'allPerpMetas')).toHaveLength(1);
    expect(stored).toMatchObject({ nativeNames: ['BTC', 'xyz:SNDK'] });

    const restoredFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ type: 'fundingHistory', coin: 'xyz:SNDK' });
      return response([]);
    });
    const restored = new VenuePublicMarketDataClient(restoredFetch as typeof fetch, () => now, {
      hyperliquidMetadataStore: metadataStore,
    });
    await restored.queryFundingHistory('HYPERLIQUID_FUTURE_SNDK_USDC', 1_000, 10_000);
    expect(restoredFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps using stale last-good Hyperliquid metadata when its refresh fails', async () => {
    const fetchedAt = Date.parse('2026-08-01T12:00:00.000Z');
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.type === 'allPerpMetas') {
        return Promise.resolve(new Response('upstream unavailable', { status: 503 }));
      }
      expect(body).toMatchObject({ type: 'fundingHistory', coin: 'xyz:SNDK' });
      return response([]);
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => fetchedAt + 31 * 60_000, {
      hyperliquidMetadataStore: {
        read: () => ({ nativeNames: ['xyz:SNDK'], fetchedAt: new Date(fetchedAt).toISOString() }),
        write: () => { throw new Error('unexpected cache write'); },
      },
    });

    await expect(client.queryFundingHistory('HYPERLIQUID_FUTURE_SNDK_USDC', 1_000, 10_000))
      .resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('realized funding history', () => {
  const start = 1_000;
  const end = 10_000;

  it('normalizes Gate, Binance, OKX, and Bybit settlement records', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('gateio')) return response([{ r: '0.0001', t: 2 }, { r: '-0.00002', t: 9 }]);
      if (value.includes('binance')) return response([{ fundingRate: '0.0002', fundingTime: 3_000 }]);
      if (value.includes('okx')) return response({
        code: '0',
        msg: '',
        data: [{ fundingRate: '0.9', realizedRate: '-0.00003', fundingTime: '4000' }],
      });
      return response({
        retCode: 0,
        result: { list: [{ fundingRate: '0.00004', fundingRateTimestamp: '5000' }] },
      });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    await expect(client.queryFundingHistory('GATE_FUTURE_BTC_USDT', start, end)).resolves.toEqual([
      { timestamp: 2_000, rate: '0.0001' },
      { timestamp: 9_000, rate: '-0.00002' },
    ]);
    await expect(client.queryFundingHistory('BINANCE_FUTURE_BTC_USDT', start, end)).resolves.toEqual([
      { timestamp: 3_000, rate: '0.0002' },
    ]);
    await expect(client.queryFundingHistory('OKX_FUTURE_BTC_USDT', start, end)).resolves.toEqual([
      { timestamp: 4_000, rate: '-0.00003' },
    ]);
    await expect(client.queryFundingHistory('BYBIT_FUTURE_SOL_USDC', start, end)).resolves.toEqual([
      { timestamp: 5_000, rate: '0.00004' },
    ]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringContaining('contract=BTC_USDT'),
      expect.stringContaining('symbol=BTCUSDT'),
      expect.stringContaining('instId=BTC-USDT-SWAP'),
      expect.stringContaining('symbol=SOLPERP'),
    ]));
  });

  it('normalizes Kraken, Hyperliquid, and Deribit hourly realized accruals', async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.includes('kraken')) return response({
        result: {
          timestamp: [2_000],
          data: { relativeRate: [['0.1', '0.2', '-0.3', '-0.00005']] },
          more: false,
        },
        errors: [],
      });
      if (value.includes('hyperliquid')) {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'allPerpMetas') return response([{ universe: [{ name: 'BTC' }] }]);
        expect(body).toMatchObject({ type: 'fundingHistory', coin: 'BTC' });
        return response([{ fundingRate: '0.00006', time: 3_000 }]);
      }
      return response({
        result: [{ timestamp: 4_000, interest_8h: 0.5, interest_1h: -0.000007 }],
      });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    await expect(client.queryFundingHistory('KRAKEN_FUTURE_BTC_USD', start, end)).resolves.toEqual([
      { timestamp: 2_000, rate: '-0.00005' },
    ]);
    await expect(client.queryFundingHistory('HYPERLIQUID_FUTURE_BTC_USDC', start, end)).resolves.toEqual([
      { timestamp: 3_000, rate: '0.00006' },
    ]);
    await expect(client.queryFundingHistory('DERIBIT_FUTURE_SOL_USDC', start, end)).resolves.toEqual([
      { timestamp: 4_000, rate: '-0.000007' },
    ]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringContaining('PF_XBTUSD'),
      expect.stringContaining('SOL_USDC-PERPETUAL'),
    ]));
  });

  it('signs Lighter hourly settlements by paying side and walks back overflowing windows', async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const value = String(url);
      requests.push(value);
      if (value.endsWith('/orderBooks')) return response({ code: 200, order_books: [{ symbol: 'ETH', market_id: 0 }] });
      if (new URL(value).searchParams.get('end_timestamp') === '1000') {
        return response({ code: 200, resolution: '1h', fundings: Array.from({ length: 750 }, (_, index) => ({
          timestamp: 251 + index, value: '0.01', rate: '0.0012', direction: 'short',
        })) });
      }
      return response({ code: 200, resolution: '1h', fundings: [{ timestamp: 250, value: '0.02', rate: '0.0005', direction: 'long' }] });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    const points = await client.queryFundingHistory('LIGHTER_FUTURE_ETH_USDC', 100_000, 1_000_000);

    expect(points).toHaveLength(751);
    expect(points[0]).toEqual({ timestamp: 250_000, rate: '0.000005' });
    expect(points[1]).toEqual({ timestamp: 251_000, rate: '-0.000012' });
    expect(requests.slice(1)).toEqual([
      'https://mainnet.zklighter.elliot.ai/api/v1/fundings?market_id=0&resolution=1h&start_timestamp=100&end_timestamp=1000&count_back=0',
      'https://mainnet.zklighter.elliot.ai/api/v1/fundings?market_id=0&resolution=1h&start_timestamp=100&end_timestamp=250&count_back=0',
    ]);
  });

  it('retries transient Hyperliquid funding failures with bounded backoff', async () => {
    const now = 10_000;
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi.fn(() => (
      fetchMock.mock.calls.length < 3
        ? Promise.resolve(new Response('upstream unavailable', { status: 500 }))
        : response([{ fundingRate: '0.00006', time: 3_000 }])
    ));
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => now, {
      hyperliquidMetadataStore: {
        read: () => ({ nativeNames: ['BTC'], fetchedAt: new Date(now).toISOString() }),
        write: vi.fn(),
      },
      sleep,
    });

    await expect(client.queryFundingHistory('HYPERLIQUID_FUTURE_BTC_USDC', start, end)).resolves.toEqual([
      { timestamp: 3_000, rate: '0.00006' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 500, undefined);
    expect(sleep).toHaveBeenNthCalledWith(2, 1_500, undefined);
  });

  it('respects bounded Retry-After delays and does not retry permanent HTTP failures', async () => {
    const now = 10_000;
    const retryAfterSleep = vi.fn(async () => undefined);
    const retryAfterFetch = vi.fn(() => (
      retryAfterFetch.mock.calls.length === 1
        ? Promise.resolve(new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } }))
        : response([])
    ));
    const options = {
      hyperliquidMetadataStore: {
        read: () => ({ nativeNames: ['BTC'], fetchedAt: new Date(now).toISOString() }),
        write: vi.fn(),
      },
    };
    const retryAfterClient = new VenuePublicMarketDataClient(retryAfterFetch as typeof fetch, () => now, {
      ...options,
      sleep: retryAfterSleep,
    });

    await expect(retryAfterClient.queryFundingHistory('HYPERLIQUID_FUTURE_BTC_USDC', start, end))
      .resolves.toEqual([]);
    expect(retryAfterSleep).toHaveBeenCalledWith(7_000, undefined);

    const permanentSleep = vi.fn(async () => undefined);
    const permanentFetch = vi.fn(() => Promise.resolve(new Response('bad request', { status: 400 })));
    const permanentClient = new VenuePublicMarketDataClient(permanentFetch as typeof fetch, () => now, {
      ...options,
      sleep: permanentSleep,
    });
    await expect(permanentClient.queryFundingHistory('HYPERLIQUID_FUTURE_BTC_USDC', start, end))
      .rejects.toEqual(new PublicMarketDataError('UPSTREAM_HTTP_400'));
    expect(permanentFetch).toHaveBeenCalledTimes(1);
    expect(permanentSleep).not.toHaveBeenCalled();
  });

  it('aborts Hyperliquid funding retries during backoff', async () => {
    const now = 10_000;
    const controller = new AbortController();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('upstream unavailable', { status: 503 })));
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => now, {
      hyperliquidMetadataStore: {
        read: () => ({ nativeNames: ['BTC'], fetchedAt: new Date(now).toISOString() }),
        write: vi.fn(),
      },
      sleep: vi.fn(async () => { controller.abort(); }),
    });

    await expect(client.queryFundingHistory('HYPERLIQUID_FUTURE_BTC_USDC', start, end, controller.signal))
      .rejects.toEqual(new PublicMarketDataError('ABORTED'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('paces Hyperliquid funding pagination pages', async () => {
    const now = 10_000;
    const sleep = vi.fn(async () => undefined);
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      fundingRate: '0.00001',
      time: start + index + 1,
    }));
    const fetchMock = vi.fn(() => fetchMock.mock.calls.length === 1
      ? response(firstPage)
      : response([{ fundingRate: '0.00002', time: 2_000 }]));
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => now, {
      hyperliquidMetadataStore: {
        read: () => ({ nativeNames: ['BTC'], fetchedAt: new Date(now).toISOString() }),
        write: vi.fn(),
      },
      sleep,
    });

    await expect(client.queryFundingHistory('HYPERLIQUID_FUTURE_BTC_USDC', start, end))
      .resolves.toHaveLength(501);
    expect(sleep).toHaveBeenCalledWith(1_500, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('excludes the settlement exactly at the rolling-window start', async () => {
    const client = new VenuePublicMarketDataClient(vi.fn(() => response([
      { fundingRate: '0.5', fundingTime: start },
      { fundingRate: '0.1', fundingTime: start + 1 },
    ])) as unknown as typeof fetch);

    await expect(client.queryFundingHistory('BINANCE_FUTURE_BTC_USDT', start, end)).resolves.toEqual([
      { timestamp: start + 1, rate: '0.1' },
    ]);
  });
});

describe('bulk venue funding stats', () => {
  it('values Gate open interest through the inline quanto multiplier', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (String(url).endsWith('/contracts')) return response([
        { name: 'BTC_USDT', quanto_multiplier: '0.0001', funding_interval: 3600, funding_next_apply: 1_784_793_600 },
      ]);
      expect(String(url)).toBe('https://api.gateio.ws/api/v4/futures/usdt/tickers');
      return response([
        { contract: 'BTC_USDT', funding_rate: '0.000015', mark_price: '50000', last: '50025', change_percentage: '1.25', total_size: '1000000', quanto_multiplier: '0.0001' },
        { contract: 'weird-row' },
      ]);
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    const stats = await client.queryVenueFundingStats('GATE');

    expect(stats).toEqual([{
      venue: 'GATE', base: 'BTC', quote: 'USDT', fundingRate: '0.000015', fundingIntervalHours: 1, fundingRate8h: '0.00012',
      nextFundingAt: '2026-07-23T08:00:00.000Z', openInterestValue: '5000000', lastPrice: '50025', change24h: '0.0125',
    }]);
  });

  it('keeps Gate funding available when contract metadata is unavailable', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (String(url).endsWith('/contracts')) return Promise.reject(new Error('contract metadata unavailable'));
      return response([
        { contract: 'BTC_USDT', funding_rate: '0.000015', mark_price: '50000', last: '50025', change_percentage: '1.25', total_size: '1000000', quanto_multiplier: '0.0001' },
      ]);
    });
    const nowMs = 1_783_703_500_000;
    const nextBoundary = new Date(Math.ceil((nowMs + 1) / (8 * 3_600_000)) * 8 * 3_600_000).toISOString();
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => nowMs);

    const stats = await client.queryVenueFundingStats('GATE');

    expect(stats).toEqual([{
      venue: 'GATE', base: 'BTC', quote: 'USDT', fundingRate: '0.000015', fundingIntervalHours: 8, fundingRate8h: '0.000015',
      nextFundingAt: nextBoundary, openInterestValue: '5000000', lastPrice: '50025', change24h: '0.0125',
    }]);
  });

  it('joins Binance funding with bulk 24h tickers and skips dated futures', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith('/ticker/24hr')) return response([
        { symbol: 'BTCUSDT', lastPrice: '50010', priceChangePercent: '-1.5' },
        { symbol: 'ETHUSDC', lastPrice: '2500', priceChangePercent: '2' },
      ]);
      if (value.endsWith('/fundingInfo')) return response([
        { symbol: 'BTCUSDT', fundingIntervalHours: 1 },
        { symbol: 'ETHUSDC', fundingIntervalHours: 4 },
      ]);
      return response([
        { symbol: 'BTCUSDT', lastFundingRate: '0.00000219', nextFundingTime: 1_784_793_600_000, time: 1 },
        { symbol: 'BTCUSDT_260327', lastFundingRate: '0', nextFundingTime: 0, time: 1 },
        { symbol: 'ETHUSDC', lastFundingRate: '0.0001', nextFundingTime: 0, time: 1 },
      ]);
    });
    const nowMs = 1_783_703_500_000;
    const next4h = new Date(Math.ceil((nowMs + 1) / (4 * 3_600_000)) * 4 * 3_600_000).toISOString();
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => nowMs);

    const stats = await client.queryVenueFundingStats('BINANCE');

    expect(stats).toEqual([
      { venue: 'BINANCE', base: 'BTC', quote: 'USDT', fundingRate: '0.00000219', fundingIntervalHours: 1, fundingRate8h: '0.00001752', nextFundingAt: '2026-07-23T08:00:00.000Z', openInterestValue: null, lastPrice: '50010', change24h: '-0.015' },
      { venue: 'BINANCE', base: 'ETH', quote: 'USDC', fundingRate: '0.0001', fundingIntervalHours: 4, fundingRate8h: '0.0002', nextFundingAt: next4h, openInterestValue: null, lastPrice: '2500', change24h: '0.02' },
    ]);
  });

  it('keeps Binance funding available when ticker and interval metadata are unavailable', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => String(url).endsWith('/premiumIndex')
      ? response([{ symbol: 'BTCUSDT', lastFundingRate: '0.00000219', nextFundingTime: 1_784_793_600_000, time: 1 }])
      : Promise.reject(new Error('optional metadata unavailable')));
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    const stats = await client.queryVenueFundingStats('BINANCE');

    expect(stats).toEqual([{
      venue: 'BINANCE', base: 'BTC', quote: 'USDT', fundingRate: '0.00000219', fundingIntervalHours: 8,
      fundingRate8h: '0.00000219', nextFundingAt: '2026-07-23T08:00:00.000Z', openInterestValue: null,
      lastPrice: null, change24h: null,
    }]);
  });

  it('joins OKX funding with bulk open interest and scales 4h cycles to 8h', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const text = String(url);
      if (text.includes('/public/funding-rate')) return response({ code: '0', msg: '', data: [
        { instId: 'LAYER-USDT-SWAP', fundingRate: '0.0001', fundingTime: '1784793600000', nextFundingTime: '1784808000000' },
        { instId: 'BTC-USDT-SWAP', fundingRate: '0.00005', fundingTime: '1784793600000', nextFundingTime: '1784822400000' },
      ] });
      if (text.includes('/market/tickers')) return response({ code: '0', msg: '', data: [
        { instId: 'LAYER-USDT-SWAP', last: '0.4', open24h: '0.5' },
        { instId: 'BTC-USDT-SWAP', last: '50000', open24h: '49000' },
      ] });
      return response({ code: '0', msg: '', data: [
        { instId: 'BTC-USDT-SWAP', oiUsd: '123456789' },
      ] });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    const stats = await client.queryVenueFundingStats('OKX');

    // LAYER settles every 4h: its per-interval rate doubles to stay 8h-comparable.
    expect(stats).toEqual([
      { venue: 'OKX', base: 'LAYER', quote: 'USDT', fundingRate: '0.0001', fundingIntervalHours: 4, fundingRate8h: '0.0002', nextFundingAt: '2026-07-23T08:00:00.000Z', openInterestValue: null, lastPrice: '0.4', change24h: '-0.19999999999999996' },
      { venue: 'OKX', base: 'BTC', quote: 'USDT', fundingRate: '0.00005', fundingIntervalHours: 8, fundingRate8h: '0.00005', nextFundingAt: '2026-07-23T08:00:00.000Z', openInterestValue: '123456789', lastPrice: '50000', change24h: '0.020408163265306145' },
    ]);
  });

  it('reads Bybit USD open interest directly and normalizes funding intervals and PERP quotes', async () => {
    const fetchMock = vi.fn(() => response({ retCode: 0, result: { list: [
      { symbol: 'BTCUSDT', fundingRate: '-0.0000323', nextFundingTime: '1784793600000', openInterestValue: '3517548021.69', fundingIntervalHour: '8', lastPrice: '50000', price24hPcnt: '-0.01' },
      { symbol: 'ETHPERP', fundingRate: '0.00001', nextFundingTime: '0', openInterestValue: '1000000', fundingIntervalHour: '1', lastPrice: '2500', price24hPcnt: '0.02' },
      { symbol: 'BTC-26DEC25', fundingRate: '0', nextFundingTime: '0', openInterestValue: '5' },
    ] } }));
    const nowMs = 1_783_703_500_000;
    const nextHour = new Date(Math.ceil((nowMs + 1) / 3_600_000) * 3_600_000).toISOString();
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => nowMs);

    const stats = await client.queryVenueFundingStats('BYBIT');

    expect(stats).toEqual([
      { venue: 'BYBIT', base: 'BTC', quote: 'USDT', fundingRate: '-0.0000323', fundingIntervalHours: 8, fundingRate8h: '-0.0000323', nextFundingAt: '2026-07-23T08:00:00.000Z', openInterestValue: '3517548021.69', lastPrice: '50000', change24h: '-0.01' },
      { venue: 'BYBIT', base: 'ETH', quote: 'USDC', fundingRate: '0.00001', fundingIntervalHours: 1, fundingRate8h: '0.00008', nextFundingAt: nextHour, openInterestValue: '1000000', lastPrice: '2500', change24h: '0.02' },
    ]);
  });

  it('renames Kraken legacy codes and converts absolute hourly funding to a relative 8h rate', async () => {
    const fetchMock = vi.fn(() => response({ tickers: [
      { symbol: 'PF_XBTUSD', pair: 'XBT:USD', tag: 'perpetual', markPrice: 50000, last: 50010, change24h: -1.2, fundingRate: 0.5, openInterest: 2000 },
      { symbol: 'PF_XDGUSD', pair: 'XDG:USD', tag: 'perpetual', markPrice: 0.25, last: 0.26, change24h: 4, fundingRate: 0.0000005, openInterest: 4_000_000 },
      { symbol: 'PI_ETHUSD', pair: 'ETH:USD', tag: 'perpetual', markPrice: 2000, fundingRate: 0.1, openInterest: 10 },
      { symbol: 'PF_SOLUSD', pair: 'SOL:USD', tag: 'perpetual', markPrice: 80, fundingRate: 0.001, openInterest: 100, suspended: true },
      { symbol: 'FI_XBTUSD_260626', pair: 'XBT:USD', tag: 'quarter', markPrice: 51000 },
    ] }));
    const nowMs = 1_783_703_500_000;
    const nextHour = new Date(Math.ceil((nowMs + 1) / 3_600_000) * 3_600_000).toISOString();
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => nowMs);

    const stats = await client.queryVenueFundingStats('KRAKEN');

    // 0.5 USD per hour on a 50000 mark = 0.00001/h relative = 0.00008 per 8h; settlement is the
    // next hourly boundary even though Kraken's ticker payload omits a timestamp.
    expect(stats).toEqual([
      { venue: 'KRAKEN', base: 'BTC', quote: 'USD', fundingRate: '0.00001', fundingIntervalHours: 1, fundingRate8h: '0.00008', nextFundingAt: nextHour, openInterestValue: '100000000', lastPrice: '50010', change24h: '-0.012' },
      { venue: 'KRAKEN', base: 'DOGE', quote: 'USD', fundingRate: '0.000002', fundingIntervalHours: 1, fundingRate8h: '0.000016', nextFundingAt: nextHour, openInterestValue: '1000000', lastPrice: '0.26', change24h: '0.04' },
    ]);
  });

  it('scales hourly Hyperliquid funding, values OI at mark, and drops delisted assets', async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.hyperliquid.xyz/info');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      if (body.type === 'allPerpMetas') return response([
        { universe: [{ name: 'BTC' }, { name: 'OLD', isDelisted: true }] },
        { universe: [{ name: 'xyz:SNDK' }] },
      ]);
      if (body.dex === 'xyz') return response([
        { universe: [{ name: 'xyz:SNDK' }] },
        [{ funding: '-0.00001', openInterest: '200', markPx: '50', prevDayPx: '40' }],
      ]);
      expect(body).toEqual({ type: 'metaAndAssetCtxs' });
      return response([
        { universe: [{ name: 'BTC' }, { name: 'OLD', isDelisted: true }] },
        [
          { funding: '0.0000125', openInterest: '100', markPx: '50000', prevDayPx: '49000' },
          { funding: '0.001', openInterest: '5', markPx: '10' },
        ],
      ]);
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => Date.parse('2026-07-23T07:20:00.000Z'));

    const stats = await client.queryVenueFundingStats('HYPERLIQUID');

    expect(stats).toEqual([
      {
        venue: 'HYPERLIQUID', base: 'BTC', quote: 'USDC', fundingRate: '0.0000125', fundingIntervalHours: 1, fundingRate8h: '0.0001',
        nextFundingAt: '2026-07-23T08:00:00.000Z', openInterestValue: '5000000',
        lastPrice: '50000', change24h: '0.020408163265306145',
      },
      {
        venue: 'HYPERLIQUID', base: 'SNDK', quote: 'USDC', fundingRate: '-0.00001', fundingIntervalHours: 1, fundingRate8h: '-0.00008',
        nextFundingAt: '2026-07-23T08:00:00.000Z', openInterestValue: '10000',
        lastPrice: '50', change24h: '0.25',
      },
    ]);
  });

  it('joins Lighter market details with its 8h-equivalent funding feed and skips inactive markets', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith('/orderBookDetails')) return response({ code: 200, order_book_details: [
        { symbol: 'XAU', market_id: 92, status: 'active', mark_price: '2400', last_trade_price: 0, open_interest: 10, daily_price_change: 1.5 },
        { symbol: 'ETH', market_id: 0, status: 'active', mark_price: '2000', last_trade_price: 2001, open_interest: 50, daily_price_change: -2.5 },
        { symbol: 'OLD', market_id: 9, status: 'inactive', mark_price: '1', last_trade_price: 1, open_interest: 1, daily_price_change: 0 },
      ], spot_order_book_details: [] });
      expect(value).toBe('https://mainnet.zklighter.elliot.ai/api/v1/funding-rates');
      return response({ code: 200, funding_rates: [
        { market_id: 0, exchange: 'binance', symbol: 'ETH', rate: 0.0001 },
        { market_id: 0, exchange: 'lighter', symbol: 'ETH', rate: -0.00012 },
      ] });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => Date.parse('2026-09-16T08:20:00.000Z'));

    expect(await client.queryVenueFundingStats('LIGHTER')).toEqual([
      {
        venue: 'LIGHTER', base: 'ETH', quote: 'USDC', fundingRate: '-0.000015', fundingIntervalHours: 1, fundingRate8h: '-0.00012',
        nextFundingAt: '2026-09-16T09:00:00.000Z', openInterestValue: '100000', lastPrice: '2001', change24h: '-0.025',
      },
      {
        venue: 'LIGHTER', base: 'XAU', quote: 'USDC', fundingRate: null, fundingIntervalHours: 1, fundingRate8h: null,
        nextFundingAt: '2026-09-16T09:00:00.000Z', openInterestValue: '24000', lastPrice: '2400', change24h: '0.015',
      },
    ]);
  });

  it('keeps only Deribit USDC perpetuals and passes funding_8h through unscaled', async () => {
    const fetchMock = vi.fn(() => response({ result: [
      { instrument_name: 'SOL_USDC-PERPETUAL', open_interest: 200000, mark_price: 80, last: 81, price_change: 2.5, funding_8h: 0.000012 },
      { instrument_name: 'BTC_USDC-26DEC25', open_interest: 10, mark_price: 50000 },
    ] }));
    const nowMs = 1_783_703_500_000;
    const next8h = new Date(Math.ceil((nowMs + 1) / (8 * 3_600_000)) * 8 * 3_600_000).toISOString();
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => nowMs);

    const stats = await client.queryVenueFundingStats('DERIBIT');

    expect(stats).toEqual([{
      venue: 'DERIBIT', base: 'SOL', quote: 'USDC', fundingRate: '0.000012', fundingIntervalHours: 8, fundingRate8h: '0.000012',
      nextFundingAt: next8h, openInterestValue: '16000000', lastPrice: '81', change24h: '0.025',
    }]);
  });

  it('QA supplement: DERIBIT spot candles are rejected without an upstream request (no spot fetcher by design)', async () => {
    const fetchMock = vi.fn();
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    await expect(client.queryCandles('DERIBIT_SPOT_BTC_USDT', '1m', 10))
      .rejects.toMatchObject({ name: 'PublicMarketDataError', code: 'UNSUPPORTED_SYMBOL' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('QA supplement: Binance spot klines use the spot v3 endpoint with endTime pagination', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request) => response([
      [1_783_703_400_000, '63960', '63970', '63950', '63965', '12.5'],
      [1_783_703_460_000, '63965', '63980', '63960', '63975', '9.1'],
    ]));
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    const candles = await client.queryCandles('BINANCE_SPOT_BTC_USDT', '1m', 2, 1_783_703_490_000);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('https://api.binance.com/api/v3/klines?symbol=BTCUSDT');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('endTime=1783703489999');
    expect(candles).toEqual([
      { startTime: 1_783_703_400_000, open: '63960', high: '63970', low: '63950', close: '63965', volume: '12.5', closed: true },
      { startTime: 1_783_703_460_000, open: '63965', high: '63980', low: '63960', close: '63975', volume: '9.1', closed: true },
    ]);
  });

  it('sweeps Binance spot and perp bookTickers, merging the 24h turnover sweep', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const target = String(url);
      const futures = target.includes('fapi.binance.com');
      // bookTicker prices carry no turnover or range, so a second sweep per business line fills in.
      if (target.includes('/ticker/24hr')) {
        return futures
          ? response([
            { symbol: 'ETHUSDT', lastPrice: '3120.6', volume: '9000', quoteVolume: '28000000', openPrice: '3050', highPrice: '3180.4', lowPrice: '3012.9' },
            // Spot and perp reuse the symbol name, so the sweep must keep their turnover apart.
            { symbol: 'BTCUSDT', lastPrice: '63963', volume: '99', quoteVolume: '6300000', openPrice: '64100', highPrice: '64980', lowPrice: '63210' },
            { symbol: 'BTCUSDT_260327', lastPrice: '64000', volume: '5', quoteVolume: '320000', openPrice: '64000', highPrice: '64100', lowPrice: '63900' },
          ])
          : response([
            { symbol: 'BTCUSDT', lastPrice: '63962.1', volume: '1500.25', quoteVolume: '96000000.5', openPrice: '63200.5', highPrice: '64500', lowPrice: '62800.25' },
            // Dated future and a non-stable quote are not CrossEx markets, here or on bookTicker.
            { symbol: 'BTCUSD', lastPrice: '64000', volume: '1', quoteVolume: '64000', openPrice: '64000', highPrice: '64100', lowPrice: '63900' },
            // A zero turnover means the venue published nothing usable for this row.
            { symbol: 'ETHUSDT', lastPrice: '3120.6', volume: '0', quoteVolume: '0', openPrice: '0', highPrice: '0', lowPrice: '0' },
          ]);
      }
      return futures
        ? response([
          { symbol: 'ETHUSDT', bidPrice: '3120.5', askPrice: '3120.6', bidQty: '1', askQty: '1', time: 1 },
          { symbol: 'BTCUSDT', bidPrice: '63962.5', askPrice: '63962.6', time: 1 },
          // Dated future (settlement suffix) and a non-stable quote are not CrossEx markets.
          { symbol: 'BTCUSDT_260327', bidPrice: '64000', askPrice: '64001', time: 1 },
          { symbol: 'BTCUSD', bidPrice: '64000', askPrice: '64001', time: 1 },
        ])
        : response([
          { symbol: 'BTCUSDT', bidPrice: '63962.00', askPrice: '63962.10', bidQty: '1', askQty: '1', time: 1 },
          { symbol: 'BTCTUSD', bidPrice: '63900', askPrice: '63901', time: 1 },
        ]);
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    const tickers = await client.queryVenueBookTickers('BINANCE');

    expect(tickers).toEqual([
      // Prices normalize through positiveNumberText, so trailing zeros drop. Turnover keeps the
      // upstream text verbatim; open interest has no bulk source on Binance and stays null.
      {
        venue: 'BINANCE', business: 'SPOT', base: 'BTC', quote: 'USDT', bidPrice: '63962', askPrice: '63962.1', lastPrice: '63962.1',
        volume24h: '1500.25', quoteVolume24h: '96000000.5', openInterestValue: null,
        open24h: '63200.5', high24h: '64500', low24h: '62800.25',
      },
      {
        venue: 'BINANCE', business: 'FUTURE', base: 'ETH', quote: 'USDT', bidPrice: '3120.5', askPrice: '3120.6', lastPrice: '3120.6',
        volume24h: '9000', quoteVolume24h: '28000000', openInterestValue: null,
        open24h: '3050', high24h: '3180.4', low24h: '3012.9',
      },
      {
        // Same symbol as the spot row above, but the perp turnover must not bleed across.
        venue: 'BINANCE', business: 'FUTURE', base: 'BTC', quote: 'USDT', bidPrice: '63962.5', askPrice: '63962.6', lastPrice: '63963',
        volume24h: '99', quoteVolume24h: '6300000', openInterestValue: null,
        open24h: '64100', high24h: '64980', low24h: '63210',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('caches the Binance 24h turnover sweep across board sweeps until it expires', async () => {
    let now = 1_783_703_500_000;
    const fetchMock = vi.fn((url: string | URL | Request) => String(url).includes('/ticker/24hr')
      ? response([{ symbol: 'BTCUSDT', lastPrice: '63962.1', volume: '1500', quoteVolume: '96000000' }])
      : response([{ symbol: 'BTCUSDT', bidPrice: '63962', askPrice: '63962.1' }]));
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => now);

    await client.queryVenueBookTickers('BINANCE');
    // Two bookTicker requests plus two turnover requests (spot and futures).
    expect(fetchMock).toHaveBeenCalledTimes(4);

    now += 299_999;
    const cached = await client.queryVenueBookTickers('BINANCE');
    // Only the price sweep repeats; turnover is served from the cache.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(cached[0]).toMatchObject({ quoteVolume24h: '96000000' });

    now += 1;
    await client.queryVenueBookTickers('BINANCE');
    // The TTL boundary re-sweeps turnover at exactly 300s.
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('does not cache a half-fetched Binance turnover sweep', async () => {
    let now = 1_783_703_500_000;
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/ticker/24hr')) {
        // Only the spot 24h ticker answers; the perp endpoint is down for this sweep.
        return target.includes('fapi.binance.com')
          ? Promise.reject(new Error('futures turnover endpoint down'))
          : response([{ symbol: 'BTCUSDT', lastPrice: '63962.1', volume: '1500', quoteVolume: '96000000' }]);
      }
      return target.includes('fapi.binance.com')
        ? response([{ symbol: 'ETHUSDT', bidPrice: '3120.5', askPrice: '3120.6' }])
        : response([{ symbol: 'BTCUSDT', bidPrice: '63962', askPrice: '63962.1' }]);
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => now);

    const first = await client.queryVenueBookTickers('BINANCE');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // The half sweep still delivers what it has: spot turnover lands, perp degrades to null.
    expect(first).toEqual([
      {
        venue: 'BINANCE', business: 'SPOT', base: 'BTC', quote: 'USDT', bidPrice: '63962', askPrice: '63962.1',
        lastPrice: '63962.1', volume24h: '1500', quoteVolume24h: '96000000', openInterestValue: null,
        open24h: null, high24h: null, low24h: null,
      },
      {
        venue: 'BINANCE', business: 'FUTURE', base: 'ETH', quote: 'USDT', bidPrice: '3120.5', askPrice: '3120.6',
        lastPrice: null, volume24h: null, quoteVolume24h: null, openInterestValue: null,
        open24h: null, high24h: null, low24h: null,
      },
    ]);

    now += 1;
    await client.queryVenueBookTickers('BINANCE');
    // A half sweep is never cached, so the very next sweep re-asks both turnover endpoints rather
    // than serving the gap for a full TTL: 4 calls now, 8 in total.
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('keeps Binance price rows when the 24h turnover sweep fails', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/ticker/24hr')) return Promise.reject(new Error('turnover endpoint down'));
      // Still distinguish spot from futures so both price rows survive the failed turnover sweep.
      return target.includes('fapi.binance.com')
        ? response([{ symbol: 'ETHUSDT', bidPrice: '3120.5', askPrice: '3120.6' }])
        : response([{ symbol: 'BTCUSDT', bidPrice: '63962', askPrice: '63962.1' }]);
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    const tickers = await client.queryVenueBookTickers('BINANCE');

    // Degradation stays local: a missing turnover source must not take the price rows with it —
    // the 24h range has the same source, so it degrades to null rather than a fabricated value.
    expect(tickers).toEqual([
      {
        venue: 'BINANCE', business: 'SPOT', base: 'BTC', quote: 'USDT', bidPrice: '63962', askPrice: '63962.1',
        lastPrice: null, volume24h: null, quoteVolume24h: null, openInterestValue: null,
        open24h: null, high24h: null, low24h: null,
      },
      {
        venue: 'BINANCE', business: 'FUTURE', base: 'ETH', quote: 'USDT', bidPrice: '3120.5', askPrice: '3120.6',
        lastPrice: null, volume24h: null, quoteVolume24h: null, openInterestValue: null,
        open24h: null, high24h: null, low24h: null,
      },
    ]);
  });

  it('sweeps OKX spot and swap tickers, dropping inverse swaps', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => String(url).includes('instType=SWAP')
      ? response({ code: '0', msg: '', data: [
        { instId: 'ETH-USDT-SWAP', bidPx: '3120.5', askPx: '3120.7', last: '3120.6', vol24h: '12000', volCcy24h: '37500000.5', open24h: '3050', high24h: '3180.4', low24h: '3012.9', ts: '1783703477068' },
        // Inverse (coin-margined) swap is not a CrossEx linear market.
        { instId: 'BTC-USD-SWAP', bidPx: '64000', askPx: '64001', last: '64000', open24h: '64000', high24h: '64100', low24h: '63900', ts: '1783703477068' },
        { instId: 'BTC-USDC-SWAP', bidPx: '0', askPx: '0', ts: '1783703477068' },
      ] })
      : response({ code: '0', msg: '', data: [
        { instId: 'BTC-USDT', bidPx: '63962', askPx: '63962.2', last: '63962.1', vol24h: '900.25', volCcy24h: '57500000', open24h: '63200.5', high24h: '64500', low24h: '62800.25', ts: '1783703477068' },
        // A zero turnover means the venue published nothing usable for this row.
        { instId: 'BTC-USDC', bidPx: '63961', askPx: '63961.2', vol24h: '0', volCcy24h: '0', open24h: '0', high24h: '0', low24h: '0', ts: '1783703477068' },
      ] }));
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    const tickers = await client.queryVenueBookTickers('OKX');

    expect(tickers).toEqual([
      {
        venue: 'OKX', business: 'SPOT', base: 'BTC', quote: 'USDT', bidPrice: '63962', askPrice: '63962.2', lastPrice: '63962.1',
        volume24h: '900.25', quoteVolume24h: '57500000', openInterestValue: null,
        open24h: '63200.5', high24h: '64500', low24h: '62800.25',
      },
      {
        venue: 'OKX', business: 'SPOT', base: 'BTC', quote: 'USDC', bidPrice: '63961', askPrice: '63961.2', lastPrice: null,
        volume24h: null, quoteVolume24h: null, openInterestValue: null,
        open24h: null, high24h: null, low24h: null,
      },
      {
        venue: 'OKX', business: 'FUTURE', base: 'ETH', quote: 'USDT', bidPrice: '3120.5', askPrice: '3120.7', lastPrice: '3120.6',
        volume24h: '12000', quoteVolume24h: '37500000.5', openInterestValue: null,
        open24h: '3050', high24h: '3180.4', low24h: '3012.9',
      },
    ]);
  });

  it('sweeps Bybit spot and linear tickers, dropping dated futures and keeping PERP quoting', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => String(url).includes('category=linear')
      ? response({ retCode: 0, retMsg: 'OK', result: { list: [
        { symbol: 'SIRENUSDT', bid1Price: '0.119', ask1Price: '0.12', lastPrice: '0.1195', volume24h: '8800000', turnover24h: '1050000.75', openInterestValue: '420000', prevPrice24h: '0.1255', highPrice24h: '0.1312', lowPrice24h: '0.1174' },
        { symbol: 'BTC-26DEC25', bid1Price: '64000', ask1Price: '64001' },
        { symbol: 'BTCUSDC', bid1Price: '0', ask1Price: '0' },
      ] } })
      : response({ retCode: 0, retMsg: 'OK', result: { list: [
        { symbol: 'SIRENUSDT', bid1Price: '0.1192', ask1Price: '0.1194', lastPrice: '0.1193', volume24h: '1200000', turnover24h: '143000', prevPrice24h: '0.1255', highPrice24h: '0.1312', lowPrice24h: '0.1174' },
      ] } }));
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    const tickers = await client.queryVenueBookTickers('BYBIT');

    expect(tickers).toEqual([
      {
        venue: 'BYBIT', business: 'SPOT', base: 'SIREN', quote: 'USDT', bidPrice: '0.1192', askPrice: '0.1194', lastPrice: '0.1193',
        volume24h: '1200000', quoteVolume24h: '143000', openInterestValue: null,
        open24h: '0.1255', high24h: '0.1312', low24h: '0.1174',
      },
      {
        venue: 'BYBIT', business: 'FUTURE', base: 'SIREN', quote: 'USDT', bidPrice: '0.119', askPrice: '0.12', lastPrice: '0.1195',
        volume24h: '8800000', quoteVolume24h: '1050000.75', openInterestValue: '420000',
        open24h: '0.1255', high24h: '0.1312', low24h: '0.1174',
      },
    ]);
  });

  it('sweeps Gate spot and USDT-settled futures tickers into CrossEx rows', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => String(url).includes('/futures/usdt/tickers')
      ? response([
        { contract: 'SIREN_USDT', highest_bid: '0.119', lowest_ask: '0.12', last: '0.1195', volume_24h_base: '5000000', volume_24h_quote: '595000', high_24h: '0.1312', low_24h: '0.1174' },
        { contract: 'BTC_USDC', highest_bid: '64000', lowest_ask: '64001', last: '64000' },
      ])
      : response([
        { currency_pair: 'SIREN_USDT', highest_bid: '0.1192', lowest_ask: '0.1194', last: '0.1193', base_volume: '750000', quote_volume: '89250.5', high_24h: '0.1312', low_24h: '0.1174' },
        { currency_pair: 'SIREN_USDC', highest_bid: '0.1191', lowest_ask: '0.1195', last: '0.1192' },
      ]));
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    const tickers = await client.queryVenueBookTickers('GATE');

    expect(tickers).toEqual([
      {
        venue: 'GATE', business: 'SPOT', base: 'SIREN', quote: 'USDT', bidPrice: '0.1192', askPrice: '0.1194', lastPrice: '0.1193',
        volume24h: '750000', quoteVolume24h: '89250.5', openInterestValue: null,
        // Gate's ticker feed carries the 24h range but no session open.
        open24h: null, high24h: '0.1312', low24h: '0.1174',
      },
      {
        venue: 'GATE', business: 'SPOT', base: 'SIREN', quote: 'USDC', bidPrice: '0.1191', askPrice: '0.1195', lastPrice: '0.1192',
        volume24h: null, quoteVolume24h: null, openInterestValue: null,
        open24h: null, high24h: null, low24h: null,
      },
      {
        venue: 'GATE', business: 'FUTURE', base: 'SIREN', quote: 'USDT', bidPrice: '0.119', askPrice: '0.12', lastPrice: '0.1195',
        volume24h: '5000000', quoteVolume24h: '595000', openInterestValue: null,
        open24h: null, high24h: '0.1312', low24h: '0.1174',
      },
    ]);
  });

  it('sweeps Kraken linear perpetuals, keeping their USD quote', async () => {
    const fetchMock = vi.fn(() => response({ tickers: [
      {
        symbol: 'PF_XBTUSD', pair: 'XBT:USD', tag: 'perpetual', bid: 63962, ask: 63962.4, last: 63962.2,
        markPrice: 63962.1, vol24h: 1200.5, volumeQuote: 76750000.25, openInterest: 9000, suspended: false,
        open24h: 63200.5, high24h: 64500.25, low24h: 62800,
      },
      // Spot symbols, futures with a settlement date and suspended contracts cannot be traded here.
      { symbol: 'PI_XBTUSD', pair: 'XBT:USD', tag: 'month', bid: 64000, ask: 64001, markPrice: 64000 },
      { symbol: 'PF_ETHUSD', pair: 'ETH:USD', tag: 'perpetual', bid: 3120.5, ask: 3120.7, markPrice: 3120.6, suspended: true },
      { symbol: 'PF_SIRENUSD', pair: 'SIREN:USD', tag: 'perpetual', markPrice: 0.1195 },
    ] }));
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    const tickers = await client.queryVenueBookTickers('KRAKEN');

    // Kraken settles in cash USD while everyone else quotes a dollar stablecoin: the row keeps its
    // real quote and the opportunity board folds it into the same settlement family.
    expect(tickers).toEqual([{
      venue: 'KRAKEN', business: 'FUTURE', base: 'BTC', quote: 'USD', bidPrice: '63962', askPrice: '63962.4', lastPrice: '63962.2',
      volume24h: '1200.5', quoteVolume24h: '76750000.25', openInterestValue: '575658900',
      open24h: '63200.5', high24h: '64500.25', low24h: '62800',
    }]);
    // XBT is Kraken's own spelling of BTC and must be renamed for cross-venue joining.
    expect(tickers[0]?.base).toBe('BTC');
  });

  it('returns no REST book rows for venues without a full-market ticker sweep', async () => {
    const fetchMock = vi.fn();
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch);

    await expect(client.queryVenueBookTickers('HYPERLIQUID')).resolves.toEqual([]);
    await expect(client.queryVenueBookTickers('DERIBIT')).resolves.toEqual([]);
    await expect(client.queryVenueBookTickers('LIGHTER')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Depth seeding (§ D): each venue's book snapshot is normalized to base-coin sizes here, so the
 * market hub can install it as a baseline without knowing any venue's shape.
 */
describe('venue depth snapshots', () => {
  const now = () => 1_783_703_500_000;

  it('parses Binance futures depth, already denominated in base coins', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      expect(String(url)).toContain('/fapi/v1/depth');
      expect(String(url)).toContain('symbol=BTCUSDT');
      expect(String(url)).toContain('limit=100');
      return response({
        lastUpdateId: 5_432_109,
        bids: [['63962.00', '1.5'], ['63961.90', '0.4']],
        asks: [['63962.10', '2.0']],
        E: 1_783_703_477_021,
        T: 1_783_703_477_100,
      });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as unknown as typeof fetch, now);

    const book = await client.queryDepth('BINANCE_FUTURE_BTC_USDT', 50);
    expect(book.bids).toEqual([['63962.00', '1.5'], ['63961.90', '0.4']]);
    expect(book.asks).toEqual([['63962.10', '2.0']]);
    expect(book.seq).toBe('5432109');
    expect(book.ts).toBe(1_783_703_477_100);
  });

  it('keeps OKX contract counts untouched so a seeded book matches the diff stream', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const target = String(url);
      // No instrument lookup: converting here is what produced a book whose seeded levels were
      // 100× smaller than the CrossEx diffs that replaced them.
      expect(target).not.toContain('/public/instruments');
      expect(target).toContain('/api/v5/market/books');
      expect(target).toContain('sz=50');
      return response({
        code: '0',
        msg: '',
        data: [{
          asks: [['63962.1', '300', '0', '2']],
          bids: [['63962.0', '500', '0', '3']],
          ts: '1783703477021',
        }],
      });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as unknown as typeof fetch, now);

    const book = await client.queryDepth('OKX_FUTURE_BTC_USDT', 50);
    // Contract counts, exactly as the venue reported them — `ctVal` is the consumer's job.
    expect(book.asks).toEqual([['63962.1', '300']]);
    expect(book.bids).toEqual([['63962.0', '500']]);
    expect(book.ts).toBe(1_783_703_477_021);
  });

  it('asks Bybit for an explicit limit and parses its linear book', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const target = String(url);
      // The default is a single level, so the limit must be explicit.
      expect(target).toContain('/v5/market/orderbook');
      expect(target).toContain('category=linear');
      expect(target).toContain('limit=50');
      return response({
        retCode: 0,
        result: { s: 'BTCUSDT', b: [['63962', '0.8']], a: [['63962.5', '1.2']], ts: 1_783_703_477_000, u: 7_654_321 },
      });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as unknown as typeof fetch, now);

    const book = await client.queryDepth('BYBIT_FUTURE_BTC_USDT', 50);
    expect(book.bids).toEqual([['63962', '0.8']]);
    expect(book.asks).toEqual([['63962.5', '1.2']]);
    expect(book.seq).toBe('7654321');
  });

  it('parses Gate {p,s} depth and keeps the contract counts the feed itself uses', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const target = String(url);
      // Live magnitudes: CrossEx reports 20381 contracts for a level Gate's REST endpoint also
      // reports as 20381. Multiplying by `quanto_multiplier` (0.0001) here is what made the seeded
      // side of the book 10,000× smaller than the diffs on the same level.
      expect(target).not.toContain('/contracts');
      expect(target).toContain('/futures/usdt/order_book');
      expect(target).toContain('with_id=true');
      return response({
        id: 987_654,
        current: 1_783_703_477,
        bids: [{ p: '63962.0', s: 20_381 }],
        asks: [{ p: '63962.1', s: 10_000 }],
      });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as unknown as typeof fetch, now);

    const book = await client.queryDepth('GATE_FUTURE_BTC_USDT', 50);
    expect(book.bids).toEqual([['63962.0', '20381']]);
    expect(book.asks).toEqual([['63962.1', '10000']]);
    expect(book.seq).toBe('987654');
    expect(book.ts).toBe(1_783_703_477_000);
  });

  it('rejects a spot symbol: seeding only applies to perpetual books', async () => {
    const client = new VenuePublicMarketDataClient((async () => response({})) as unknown as typeof fetch, now);
    await expect(client.queryDepth('GATE_SPOT_BTC_USDT', 50)).rejects.toBeInstanceOf(PublicMarketDataError);
  });
});

describe('depth sizes stay in the venue feed unit', () => {
  it('never looks up the instrument list while seeding, whatever the venue', async () => {
    // The seeding path must not convert units at all, so the instruments endpoint (the only place
    // a multiplier comes from) must stay untouched no matter how many symbols are seeded.
    let instrumentCalls = 0;
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/contracts') || target.includes('/public/instruments')) {
        instrumentCalls += 1;
        return response([]);
      }
      expect(target).toContain('/order_book');
      return response({ current: 1_783_703_477, bids: [{ p: '1', s: 10_000 }], asks: [{ p: '2', s: 10_000 }] });
    });
    const client = new VenuePublicMarketDataClient(fetchMock as unknown as typeof fetch, () => 1_783_703_500_000);

    const btc = await client.queryDepth('GATE_FUTURE_BTC_USDT', 50);
    await client.queryDepth('GATE_FUTURE_ETH_USDT', 50);
    expect(instrumentCalls).toBe(0);
    // 10,000 contracts in, 10,000 contracts out: one unit, the one the diffs use.
    expect(btc.bids).toEqual([['1', '10000']]);
    expect(btc.asks).toEqual([['2', '10000']]);
  });

  it('still exposes the contract multipliers for consumers that need coins', async () => {
    const fetchMock = vi.fn(() => response([
      { name: 'BTC_USDT', quanto_multiplier: '0.0001' },
      { name: 'ETH_USDT', quanto_multiplier: '0.01' },
    ]));
    const client = new VenuePublicMarketDataClient(fetchMock as unknown as typeof fetch, () => 1_783_703_500_000);

    // `/api/markets/books` multiplies by this once, and only once, when it builds notional depth.
    await expect(client.queryContractSizes('GATE')).resolves.toEqual([
      { base: 'BTC', quote: 'USDT', multiplier: '0.0001' },
      { base: 'ETH', quote: 'USDT', multiplier: '0.01' },
    ]);
  });
});
