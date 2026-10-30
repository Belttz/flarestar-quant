import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, connectTerminalStream, unresolvedOrdersFromError } from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local API request coordination', () => {
  it('coalesces concurrent reads of the same execution snapshot', async () => {
    let release: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal('fetch', fetchMock);

    const first = api.tradingSnapshot();
    const second = api.tradingSnapshot();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    release?.(new Response(JSON.stringify({
      mode: 'live', orders: [], positions: [], fills: [], balances: [],
    })));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { mode: 'live', orders: [], positions: [], fills: [], balances: [] },
      { mode: 'live', orders: [], positions: [], fills: [], balances: [] },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the upstream Gate label when a leverage update is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'strategy_leverage_rejected',
      label: 'INVALID_LEVERAGE',
    }), { status: 400 })));

    await expect(api.startStrategy({} as never)).rejects.toEqual(expect.objectContaining({
      status: 400,
      code: 'strategy_leverage_rejected',
      label: 'INVALID_LEVERAGE',
      message: 'strategy leverage rejected (INVALID_LEVERAGE)',
    }));
  });

  it('sends explicit intents for in-app account switching, renaming, and deletion', async () => {
    const connection = {
      configured: true,
      storage: 'env_file',
      label: 'Primary account',
      lastVerifiedAt: '2026-08-12T16:00:00.000Z',
      secureEntryPath: '/secure/credentials',
      readOnly: true,
      activeProfileId: 'gate-crossex-default',
      profiles: [{
        id: 'gate-crossex-default', label: 'Primary account', storage: 'env_file',
        lastVerifiedAt: '2026-08-12T16:00:00.000Z', active: true,
      }],
    };
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => {
      void _path;
      void _init;
      return new Response(JSON.stringify(connection));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.switchAccount('gate-crossex-default', true)).resolves.toMatchObject({ label: 'Primary account' });
    await expect(api.renameAccount('gate-crossex-default', 'Main trading')).resolves.toMatchObject({ label: 'Primary account' });
    await expect(api.deleteAccount('gate-crossex-default')).resolves.toMatchObject({ label: 'Primary account' });

    const switchCall = fetchMock.mock.calls[0];
    const renameCall = fetchMock.mock.calls[1];
    const deleteCall = fetchMock.mock.calls[2];
    expect(switchCall?.[0]).toBe('/api/onboarding/accounts/gate-crossex-default/activate');
    expect(switchCall?.[1]?.method).toBe('POST');
    expect(new Headers(switchCall?.[1]?.headers).get('x-gct-credential-intent')).toBe('switch-account');
    expect(switchCall?.[1]?.body).toBe('{"confirmPauseRunningStrategies":true}');
    expect(renameCall?.[0]).toBe('/api/onboarding/accounts/gate-crossex-default');
    expect(renameCall?.[1]?.method).toBe('PATCH');
    expect(new Headers(renameCall?.[1]?.headers).get('x-gct-credential-intent')).toBe('rename-account');
    expect(renameCall?.[1]?.body).toBe('{"label":"Main trading"}');
    expect(deleteCall?.[0]).toBe('/api/onboarding/accounts/gate-crossex-default');
    expect(deleteCall?.[1]?.method).toBe('DELETE');
    expect(new Headers(deleteCall?.[1]?.headers).get('x-gct-credential-intent')).toBe('delete-account');
  });

  it('sends explicit live-trading intent when resuming a strategy', async () => {
    const strategy = {
      id: 'PAIR-RESUME01', kind: 'position', status: 'RUNNING',
      accountProfileId: 'gate-crossex-default', accountLabel: 'Gate CrossEx',
      config: {
        kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
        leftSide: 'SELL', rightSide: 'BUY', entryBps: '10', totalAmount: '0.1',
        perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
      },
      progress: 0, filledQuantity: '0', filledLeft: '0', filledRight: '0', openPosition: '0',
      realizedPnl: '0', createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:01:00.000Z', stoppedAt: null,
    };
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => {
      void _path;
      void _init;
      return new Response(JSON.stringify(strategy));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.resumeStrategy(strategy.id)).resolves.toMatchObject({ id: strategy.id, status: 'RUNNING' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/strategies/PAIR-RESUME01/resume');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-gct-trading-intent')).toBe('resume-strategy');
  });

  it('sends explicit live-trading intent when pausing a strategy', async () => {
    const strategy = {
      id: 'PAIR-PAUSE01', kind: 'position', status: 'RUNNING',
      accountProfileId: 'gate-crossex-default', accountLabel: 'Gate CrossEx',
      config: {
        kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
        leftSide: 'SELL', rightSide: 'BUY', entryBps: '10', totalAmount: '0.1',
        perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
      },
      progress: 0, filledQuantity: '0', filledLeft: '0', filledRight: '0', openPosition: '0',
      realizedPnl: '0', createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:01:00.000Z', stoppedAt: null,
    };
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => {
      void _path;
      void _init;
      return new Response(JSON.stringify(strategy));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.pauseStrategy(strategy.id)).resolves.toMatchObject({ id: strategy.id, status: 'RUNNING' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/strategies/PAIR-PAUSE01/pause');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-gct-trading-intent')).toBe('pause-strategy');
  });

  it('exposes the orders that blocked a live activation as structured details', async () => {
    const blocking = {
      id: 'order-1', remoteOrderId: 'live-1', clientOrderId: 'gct-1', symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE',
      side: 'BUY', quantity: '0.1', executedQuantity: '0', price: '100', state: 'OPEN', strategyId: null, reason: 'cancel_not_confirmed:OPEN',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'strategy_recovery_unresolved', label: 'order-1', unresolvedOrders: [blocking],
    }), { status: 409 })));

    const failure: unknown = await api.setTradingMode('live', true).catch((error: unknown) => error);
    expect(failure).toEqual(expect.objectContaining({ status: 409, code: 'strategy_recovery_unresolved', label: 'order-1' }));
    expect(unresolvedOrdersFromError(failure)).toEqual([blocking]);
    // Malformed or absent details degrade to "nothing to show" rather than throwing.
    expect(unresolvedOrdersFromError(new ApiError(409, 'strategy_recovery_unresolved', undefined, 'order-1', { unresolvedOrders: [{ id: 'broken' }] }))).toEqual([]);
    expect(unresolvedOrdersFromError(new Error('offline'))).toEqual([]);
  });

  it('rejects a successful response that violates the shared runtime contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      mode: 'live',
      orders: 'not-an-array',
    }))));

    await expect(api.tradingSnapshot()).rejects.toEqual(new ApiError(200, 'invalid_backend_response'));
  });

  it('validates fixed-rate opportunities from the local Boros proxy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      strategies: [{
        id: 'ETH-2-1790294400-OKX-Hyperliquid',
        longMarket: {
          marketId: 185, address: '0x6bb121533f78d8d0c8a847b0ab399e0399966563', tokenId: 2,
          name: 'ETHUSDT', assetSymbol: 'ETH', maturity: 1790294400, state: 'Normal',
          impliedApr: 0.0225, maxLeverage: 2.1, maxPerpLeverage: 100, ammId: 0, platformName: 'OKX',
        },
        shortMarket: {
          marketId: 102, address: '0xd035309b604d6e252d29ce1d61e9a1e0a0553918', tokenId: 2,
          name: 'ETHUSDC', assetSymbol: 'ETH', maturity: 1790294400, state: 'Normal',
          impliedApr: 0.0628, maxLeverage: 2.1, maxPerpLeverage: 25, ammId: 1020, platformName: 'Hyperliquid',
        },
        daysToMaturity: 50, impliedAprSpread: 0.0403, maxPerpLeverage: 10, aprTimesMaxLeverage: 0.1487,
      }],
      totalCount: 1,
      fetchedAt: '2026-08-06T10:00:00.000Z',
      cacheStatus: 'fresh',
      source: 'boros_open_api',
    }))));

    await expect(api.borosStrategies()).resolves.toMatchObject({
      strategies: [{ id: 'ETH-2-1790294400-OKX-Hyperliquid' }],
      source: 'boros_open_api',
    });
  });

  it('turns an expired request deadline into an actionable timeout error', async () => {
    const timeout = AbortSignal.abort();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout);
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response('{}');
    }));

    await expect(api.tradingSnapshot()).rejects.toEqual(new ApiError(0, 'request_timeout'));
  });

  it('uses explicit intents and shared contracts for portfolio funding operations', async () => {
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/crossex/transfer-coins') return new Response(JSON.stringify({
        items: [{ coin: 'USDT', minimumAmount: '1', estimatedFee: '0', precision: 6, disabled: false }],
        fetchedAt: '2026-08-01T00:00:00.000Z', cacheStatus: 'fresh',
      }));
      if (path === '/api/crossex/transfer-balances') return new Response(JSON.stringify({
        items: [{ account: 'SPOT', coin: 'USDT', available: '25.125' }],
        fetchedAt: '2026-08-01T00:00:00.000Z',
      }));
      if (path.startsWith('/api/crossex/portfolio-activity?')) return new Response(JSON.stringify({
        transfers: [], accountBook: [], fundingFees: [], fetchedAt: '2026-08-01T00:00:00.000Z',
      }));
      if (path === '/api/crossex/transfers' && init?.method === 'POST') return new Response(JSON.stringify({
        transactionId: 'tx-1', text: 'portfolio_1',
      }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.transferCoins()).resolves.toMatchObject({ items: [{ coin: 'USDT', precision: 6 }] });
    await expect(api.transferBalances()).resolves.toMatchObject({ items: [{ account: 'SPOT', available: '25.125' }] });
    await expect(api.portfolioActivity('USDT')).resolves.toMatchObject({ transfers: [], accountBook: [], fundingFees: [] });
    await expect(api.transferFunds({
      coin: 'USDT', amount: '25', from: 'SPOT', to: 'CROSSEX', text: 'portfolio_1',
    })).resolves.toEqual({ transactionId: 'tx-1', text: 'portfolio_1' });

    const activityInit = fetchMock.mock.calls.find(([path]) => String(path).startsWith('/api/crossex/portfolio-activity?'))?.[1];
    const balancesInit = fetchMock.mock.calls.find(([path]) => path === '/api/crossex/transfer-balances')?.[1];
    const transferInit = fetchMock.mock.calls.find(([path]) => path === '/api/crossex/transfers')?.[1];
    expect(new Headers(activityInit?.headers).get('x-gct-read-intent')).toBe('portfolio-activity');
    expect(new Headers(balancesInit?.headers).get('x-gct-read-intent')).toBe('transfer-balances');
    expect(new Headers(transferInit?.headers).get('x-gct-trading-intent')).toBe('transfer-funds');
    expect(transferInit?.body).toBe('{"coin":"USDT","amount":"25","from":"SPOT","to":"CROSSEX","text":"portfolio_1"}');
  });

  it('requests one validated SQLite snapshot for global funding rankings', async () => {
    const fetchedAt = '2026-08-02T00:00:00.000Z';
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => {
      void _path;
      void _init;
      return new Response(JSON.stringify({
        entries: [{
          symbol: 'BINANCE_FUTURE_BTC_USDT', status: 'ok', rate24h: '0.001', rate7d: '0.002',
          rate30d: '0.003', settlementCount30d: 90, oldestFundingAt: fetchedAt,
          newestFundingAt: fetchedAt, fetchedAt,
        }],
        fetchedAt,
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.fundingRankings(['BINANCE_FUTURE_BTC_USDT'], 30)).resolves.toMatchObject({
      entries: [{ symbol: 'BINANCE_FUTURE_BTC_USDT', rate30d: '0.003' }],
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/markets/funding-rankings');
    expect(new Headers(init?.headers).get('x-gct-read-intent')).toBe('funding-history');
    expect(init?.body).toBe('{"symbols":["BINANCE_FUTURE_BTC_USDT"],"durationDays":30}');
  });

  it('ignores malformed websocket messages and delivers only validated stream events', () => {
    type Listener = (event: { data?: unknown }) => void;
    class FakeWebSocket {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static latest: FakeWebSocket | null = null;
      readyState = FakeWebSocket.OPEN;
      readonly sent: string[] = [];
      private readonly listeners = new Map<string, Listener[]>();
      constructor(readonly url: string) { FakeWebSocket.latest = this; }
      addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      send(data: string) { this.sent.push(data); }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        for (const listener of this.listeners.get('close') ?? []) listener({});
      }
      emit(type: string, event: { data?: unknown } = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:17840' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const messages: unknown[] = [];
    const handle = connectTerminalStream((message) => messages.push(message), () => undefined);
    const socket = FakeWebSocket.latest;
    socket?.emit('open');
    socket?.emit('message', { data: JSON.stringify({ type: 'market.update', payload: { symbol: 42 } }) });
    socket?.emit('message', { data: JSON.stringify({ type: 'mode.update', payload: { mode: 'readonly' } }) });
    handle.watchQuotes(['OKX_FUTURE_ETH_USDT', 'GATE_FUTURE_ETH_USDT']);
    handle.watchKlines([
      { symbol: 'GATE_FUTURE_SKHYNIX_USDT', interval: '5m' },
      { symbol: 'GATE_FUTURE_SKHY_USDT', interval: '5m' },
      { symbol: 'GATE_FUTURE_SKHYNIX_USDT', interval: '5m' },
    ]);
    handle.watchMarket('GATE_FUTURE_BTC_USDT', '1m');

    expect(messages).toEqual([{ type: 'mode.update', payload: { mode: 'readonly' } }]);
    expect(socket?.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'watch.quotes', symbols: [] },
      { type: 'watch.quotes', symbols: ['GATE_FUTURE_ETH_USDT', 'OKX_FUTURE_ETH_USDT'] },
      { type: 'watch.klines', watches: [
        { symbol: 'GATE_FUTURE_SKHY_USDT', interval: '5m' },
        { symbol: 'GATE_FUTURE_SKHYNIX_USDT', interval: '5m' },
      ] },
      { type: 'watch.market', symbol: 'GATE_FUTURE_BTC_USDT', interval: '1m' },
    ]);
    handle.close();
  });
});

describe('opportunities and portfolio-equity request assembly', () => {
  const opportunityPayload = {
    funding: [], spread: [], fetchedAt: '2026-08-01T00:00:00.000Z', cacheStatus: 'fresh',
  };

  it('sends pageSize when provided and falls back to the legacy limit alias otherwise', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(opportunityPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    try {
      await api.opportunities({ funding: false, spread: true, pageSize: 25 });
      await api.opportunities({ funding: false, spread: true, pageSize: 100, limit: 10 });
      await api.opportunities({ funding: false, spread: true, limit: 10 });
      await api.opportunities({ funding: false, spread: true });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(urls).toHaveLength(4);
    const [pageSizeUrl, bothUrl, legacyUrl, defaultUrl] = urls;
    expect(pageSizeUrl).toContain('pageSize=25');
    expect(pageSizeUrl).not.toContain('limit=');
    // pageSize wins when both parameters are provided.
    expect(bothUrl).toContain('pageSize=100');
    expect(bothUrl).not.toContain('limit=');
    // Without pageSize the legacy limit alias travels (default 50 when neither is given).
    expect(legacyUrl).toContain('limit=10');
    expect(legacyUrl).not.toContain('pageSize=');
    expect(defaultUrl).toContain('limit=50');
  });

  it('serializes the classification, pre-IPO, sort and paging parameters', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(opportunityPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    try {
      await api.opportunities({
        funding: true, spread: false, assetClass: ['STOCK', 'ETF'], assetSuperClass: ['RWA'],
        preIpo: 'exclude', sort: 'volume', dir: 'asc', offset: 100, pageSize: 50,
      });
      await api.opportunities({ funding: true, spread: false, preIpo: 'all', sort: 'default', dir: 'desc', offset: 0 });
    } finally {
      vi.unstubAllGlobals();
    }

    const [fullUrl, defaultUrl] = urls.map((url) => decodeURIComponent(url));
    expect(fullUrl).toContain('assetClass=STOCK,ETF');
    expect(fullUrl).toContain('assetSuperClass=RWA');
    expect(fullUrl).toContain('preIpo=exclude');
    expect(fullUrl).toContain('sort=volume');
    expect(fullUrl).toContain('dir=asc');
    expect(fullUrl).toContain('offset=100');
    // Defaults never travel: all / default / desc / offset 0 keep the query clean.
    expect(defaultUrl).not.toContain('preIpo=');
    expect(defaultUrl).not.toContain('sort=');
    expect(defaultUrl).not.toContain('dir=');
    expect(defaultUrl).not.toContain('offset=');
  });

  it('requests the equity curve behind the portfolio-equity read intent', async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => {
      void _path;
      void _init;
      return new Response(JSON.stringify({
        range: '7d', granularity: 'hour', points: [],
        firstSampleAt: null, fetchedAt: '2026-08-01T00:00:00.000Z',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.portfolioEquity('7d')).resolves.toMatchObject({ range: '7d', granularity: 'hour', points: [] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/crossex/portfolio-equity?range=7d');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('x-gct-read-intent')).toBe('portfolio-equity');
  });

  it('builds the spread-quality query from non-default selections only', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        rows: [], totalCandidates: 0, windowHours: 24,
        fetchedAt: '2026-08-01T00:00:00.000Z', cacheStatus: 'fresh',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    try {
      await api.spreadQuality({ pairType: 'SPOT_PERP', limit: 25, refresh: true });
      await api.spreadQuality({ pairType: 'PERP_PERP' });
      await api.spreadQuality();
      await api.spreadQuality({ limit: 50 });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(urls).toHaveLength(4);
    const [fullUrl, pairUrl, defaultUrl, explicitDefaultUrl] = urls;
    expect(fullUrl).toBe('/api/opportunities/spread-quality?refresh=1&pairType=SPOT_PERP&limit=25');
    expect(pairUrl).toBe('/api/opportunities/spread-quality?pairType=PERP_PERP');
    // No pair type and the default limit never travel: the board's own ranking depth applies.
    expect(defaultUrl).toBe('/api/opportunities/spread-quality?');
    expect(explicitDefaultUrl).toBe('/api/opportunities/spread-quality?');
  });
});
