import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPortfolioSnapshot, ExecutionFill, ExecutionOrder, LiveMarket, MarketSnapshot, TradingSnapshot } from './api.js';
import type { ExecutionPosition } from '@gate-crossex/shared-types';
import { LanguageContext } from './i18n.js';
import { ExecutionTables, normalizeBottomTab } from './trade-route.js';

function order(overrides: Partial<ExecutionOrder> & { id: string; symbol: string }): ExecutionOrder {
  return {
    remoteOrderId: `remote-${overrides.id}`, clientOrderId: `client-${overrides.id}`, venue: 'GATE',
    side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: '0.5', price: '62000', reduceOnly: false,
    state: 'OPEN', executedQuantity: '0', executedAveragePrice: null, strategyId: null, strategyLeg: null,
    createdAt: '2026-09-01T12:34:56.000Z', updatedAt: '2026-09-01T12:34:56.000Z',
    ...overrides,
  };
}

function fill(overrides: Partial<ExecutionFill> & { id: string; symbol: string }): ExecutionFill {
  return {
    order_id: `order-${overrides.id}`, venue: 'GATE', side: 'BUY', quantity: '0.1', price: '62000',
    fee: '0.01', realized_pnl: '4.2', created_at: '2026-09-01T12:34:56.000Z',
    ...overrides,
  };
}

function position(overrides: Partial<ExecutionPosition> = {}): ExecutionPosition {
  return {
    position_id: 'position-1', symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', quantity: '0.01',
    entry_price: '60000', mark_price: '62000', realized_pnl: '0', updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function spotMarket(symbol: string, lastPrice: string): LiveMarket {
  return {
    symbol, venue: symbol.split('_')[0], asset: symbol.split('_')[2], lastPrice, bidPrice: lastPrice,
    bidSize: '1', askPrice: lastPrice, askSize: '1', open24h: lastPrice, high24h: lastPrice, low24h: lastPrice,
    volume24h: '1', quoteVolume24h: lastPrice, fundingRate: '0', nextFundingAt: '', openInterest: '0',
    openInterestValue: '0', receivedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    source: 'gate_crossex_websocket',
  };
}

function portfolio(balances: AuthenticatedPortfolioSnapshot['snapshot']['balances']): AuthenticatedPortfolioSnapshot {
  return {
    snapshot: {
      account: {
        availableMargin: '0', marginBalance: '0', initialMargin: '0', maintenanceMargin: '0',
        initialMarginRate: '0', maintenanceMarginRate: '0', positionMode: 'SINGLE',
        accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: '2026-09-01T00:00:00.000Z',
      },
      balances,
      futuresPositions: [], marginPositions: [], openOrders: [], recentFills: [],
      fetchedAt: '2026-09-01T00:00:00.000Z', source: 'gate_crossex_authenticated_rest',
    },
    dataStatus: 'fresh',
    remoteStatus: 'healthy',
    reconciliation: {
      id: 'report-1', createdAt: '2026-09-01T00:00:00.000Z', status: 'clean',
      previousFetchedAt: null, currentFetchedAt: '2026-09-01T00:00:00.000Z', issues: [],
    },
  };
}

function snapshot(overrides: Partial<TradingSnapshot> = {}): TradingSnapshot {
  return { mode: 'live', orders: [], positions: [], fills: [], balances: [], ...overrides };
}

function render(ui: React.ReactNode): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
      {ui}
    </LanguageContext.Provider>,
  );
}

function renderTabs({ bottomTab = 'futures-positions', trading, portfolioSnapshot = portfolio([]), market = null, spotVenues = null }: {
  bottomTab?: string;
  trading?: TradingSnapshot;
  portfolioSnapshot?: AuthenticatedPortfolioSnapshot | null;
  market?: MarketSnapshot | null;
  spotVenues?: ReadonlySet<string> | null;
}): string {
  return render(<ExecutionTables
    snapshot={trading ?? snapshot()}
    portfolio={portfolioSnapshot}
    instruments={null}
    marketSnapshot={market}
    spotVenues={spotVenues}
    bottomTab={bottomTab}
    setBottomTab={vi.fn()}
    onTradingChanged={vi.fn().mockResolvedValue(undefined)}
    onPositionsRefresh={vi.fn().mockResolvedValue(undefined)}
    notify={vi.fn()}
    tradingMode="live"
    onOpenModeDialog={vi.fn()}
  />);
}

function tabLabels(html: string): string[] {
  const start = html.indexOf('panel-tabs');
  const segment = html.slice(start, html.indexOf('</div></div>', start));
  return [...segment.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1] ?? '');
}

describe('normalizeBottomTab', () => {
  it('maps legacy display strings onto their futures-side tab', () => {
    expect(normalizeBottomTab('Positions (2)')).toBe('futures-positions');
    expect(normalizeBottomTab('Positions (0)')).toBe('futures-positions');
    expect(normalizeBottomTab('Open orders (3)')).toBe('futures-open-orders');
    expect(normalizeBottomTab('Order history')).toBe('futures-order-history');
    expect(normalizeBottomTab('Trade history')).toBe('futures-trade-history');
  });

  it('keeps stable keys and lands unknown values on the futures positions tab', () => {
    expect(normalizeBottomTab('spot-trade-history')).toBe('spot-trade-history');
    expect(normalizeBottomTab('garbage')).toBe('futures-positions');
  });
});

describe('ExecutionTables 8-tab panel', () => {
  it('renders all eight tabs in business order with badges only on quantity tabs', () => {
    const trading = snapshot({
      positions: [position(), position({ position_id: 'position-2' })],
      orders: [order({ id: 'o1', symbol: 'GATE_FUTURE_BTC_USDT' })],
    });
    const holdings = portfolio([
      { venue: 'SPOT', coin: 'USDT', balance: '50', unrealizedPnl: '0', equity: '50', futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', availableBalance: '50', liability: '0' },
    ]);
    const html = renderTabs({ trading, portfolioSnapshot: holdings });
    expect(tabLabels(html)).toEqual([
      'Futures positions (2)', 'Spot holdings (1)', 'Futures open orders (1)', 'Spot open orders (0)',
      'Futures order history', 'Spot order history', 'Futures trade history', 'Spot trade history',
    ]);
  });

  it('splits open orders by business and keeps pagination per tab', () => {
    const trading = snapshot({
      orders: [
        order({ id: 'spot-1', symbol: 'GATE_SPOT_BTC_USDT' }),
        order({ id: 'future-1', symbol: 'GATE_FUTURE_BTC_USDT' }),
      ],
    });
    const futuresHtml = renderTabs({ bottomTab: 'futures-open-orders', trading });
    expect(futuresHtml).toContain('remote-future-1');
    expect(futuresHtml).not.toContain('remote-spot-1');
    expect(futuresHtml).toContain('>Contract</th>');

    const spotHtml = renderTabs({ bottomTab: 'spot-open-orders', trading });
    expect(spotHtml).toContain('remote-spot-1');
    expect(spotHtml).not.toContain('remote-future-1');
    expect(spotHtml).toContain('BTC/USDT');
    expect(spotHtml).toContain('>Market</th>');
  });

  it('shows the cancel button on resting history rows only', () => {
    const trading = snapshot({
      orders: [
        order({ id: 'open', symbol: 'GATE_FUTURE_BTC_USDT', state: 'OPEN' }),
        order({ id: 'filled', symbol: 'GATE_FUTURE_BTC_USDT', state: 'FILLED' }),
      ],
    });
    const html = renderTabs({ bottomTab: 'futures-order-history', trading });
    expect(html).toContain('remote-open');
    expect(html).toContain('remote-filled');
    expect(html.match(/>Cancel</g)).toHaveLength(1);
  });

  it('splits fills by business and renders — for spot realized PnL', () => {
    const trading = snapshot({
      fills: [
        fill({ id: 'spot-fill', symbol: 'GATE_SPOT_BTC_USDT', realized_pnl: '0' }),
        fill({ id: 'future-fill', symbol: 'GATE_FUTURE_BTC_USDT', realized_pnl: '4.2' }),
      ],
    });
    const spotHtml = renderTabs({ bottomTab: 'spot-trade-history', trading });
    expect(spotHtml).toContain('spot-fill');
    expect(spotHtml).toContain('<td>—</td>');

    const futuresHtml = renderTabs({ bottomTab: 'futures-trade-history', trading });
    expect(futuresHtml).toContain('4.20');
    expect(futuresHtml).not.toContain('<td>—</td>');
  });

  it('builds the spot-holdings tab from the portfolio SPOT rows with market valuation', () => {
    const market: MarketSnapshot = {
      connectionState: 'healthy', updatedAt: '2026-09-01T00:00:00.000Z',
      markets: [spotMarket('GATE_SPOT_BTC_USDT', '62000')],
    };
    const holdings = portfolio([
      { venue: 'SPOT', coin: 'USDT', balance: '250.125', unrealizedPnl: '0', equity: '250.125', futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', availableBalance: '240', liability: '0' },
      { venue: 'SPOT', coin: 'BTC', balance: '0.5', unrealizedPnl: '0', equity: '0', futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', availableBalance: '0.3', liability: '0' },
      { venue: 'CROSSEX', coin: 'USDT', balance: '999', unrealizedPnl: '0', equity: '999', futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', availableBalance: '999', liability: '0' },
    ]);
    const html = renderTabs({ bottomTab: 'spot-holdings', portfolioSnapshot: holdings, market });
    expect(html).toContain('Valuation (USDT)');
    expect(html).toContain('$31,000');
    expect(html).toContain('$250.13');
    expect(html).not.toContain('$999');
  });

  it('treats unified-account balances on catalog spot venues as spot holdings, with the venue column', () => {
    const holdings = portfolio([
      { venue: 'GATE', coin: 'ONE', balance: '2030.03', unrealizedPnl: '0', equity: '0', futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', availableBalance: '2030.03', liability: '0' },
      { venue: 'CROSSEX', coin: 'USDT', balance: '999', unrealizedPnl: '0', equity: '999', futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', availableBalance: '999', liability: '0' },
    ]);
    const html = renderTabs({
      bottomTab: 'spot-holdings',
      portfolioSnapshot: holdings,
      spotVenues: new Set(['GATE', 'BINANCE', 'OKX', 'BYBIT', 'DERIBIT']),
    });
    expect(html).toContain('ONE');
    expect(html).toContain('2,030.03');
    expect(html).not.toContain('$999');
    expect(html).toContain('>Market</th>');
  });

  it('renders the business-specific empty states', () => {
    expect(renderTabs({ bottomTab: 'spot-holdings' })).toContain('No spot holdings');
    expect(renderTabs({ bottomTab: 'spot-open-orders' })).toContain('No spot open orders');
    expect(renderTabs({ bottomTab: 'spot-order-history' })).toContain('No spot order history');
    expect(renderTabs({ bottomTab: 'spot-trade-history' })).toContain('No spot trade history');
    expect(renderTabs({ bottomTab: 'futures-positions' })).toContain('No positions');
    expect(renderTabs({ bottomTab: 'futures-order-history' })).toContain('No order history');
  });

  it('normalizes legacy bottom-tab values onto the futures tabs without blanking the panel', () => {
    expect(renderTabs({ bottomTab: 'Positions (2)' })).toContain('<button class="active">Futures positions (0)</button>');
    expect(renderTabs({ bottomTab: 'Open orders (0)' })).toContain('<button class="active">Futures open orders (0)</button>');
    expect(renderTabs({ bottomTab: 'Order history' })).toContain('<button class="active">Futures order history</button>');
    expect(renderTabs({ bottomTab: 'Trade history' })).toContain('<button class="active">Futures trade history</button>');
    expect(renderTabs({ bottomTab: 'spot-trade-history' })).toContain('<button class="active">Spot trade history</button>');
  });
});
