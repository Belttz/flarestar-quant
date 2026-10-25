import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPortfolioSnapshot, ExecutionFill, ExecutionOrder, LiveMarket, MarketSnapshot, TradingSnapshot } from './api.js';
import type { ExecutionPosition } from '@gate-crossex/shared-types';
import { FillTable, OrderTable } from './execution-tables.js';
import { LanguageContext } from './i18n.js';
import { OPEN_ORDER_STATES } from './route-shared.js';
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

function renderTabs({ bottomTab = 'positions', trading, portfolioSnapshot = portfolio([]), market = null, spotVenues = null }: {
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
  const segment = html.slice(start, html.indexOf('</div><div', start));
  return [...segment.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1] ?? '');
}

describe('normalizeBottomTab', () => {
  it('maps every pre-0.4.1 tab value onto its merged successor', () => {
    // Per-market positions/holdings tabs → Positions.
    expect(normalizeBottomTab('futures-positions')).toBe('positions');
    expect(normalizeBottomTab('spot-holdings')).toBe('positions');
    expect(normalizeBottomTab('Positions (2)')).toBe('positions');
    expect(normalizeBottomTab('Positions (0)')).toBe('positions');
    // Per-market orders/history/trades tabs → Orders.
    expect(normalizeBottomTab('futures-open-orders')).toBe('orders');
    expect(normalizeBottomTab('spot-open-orders')).toBe('orders');
    expect(normalizeBottomTab('Open orders (3)')).toBe('orders');
    expect(normalizeBottomTab('futures-order-history')).toBe('orders');
    expect(normalizeBottomTab('spot-order-history')).toBe('orders');
    expect(normalizeBottomTab('Order history')).toBe('orders');
    expect(normalizeBottomTab('futures-trade-history')).toBe('orders');
    expect(normalizeBottomTab('spot-trade-history')).toBe('orders');
    expect(normalizeBottomTab('Trade history')).toBe('orders');
  });

  it('keeps stable keys and lands unknown values on the positions tab', () => {
    expect(normalizeBottomTab('positions')).toBe('positions');
    expect(normalizeBottomTab('orders')).toBe('orders');
    expect(normalizeBottomTab('garbage')).toBe('positions');
  });
});

describe('ExecutionTables merged 2-tab panel (R6/R7)', () => {
  it('renders two merged tabs with combined badges', () => {
    const trading = snapshot({
      positions: [position(), position({ position_id: 'position-2' })],
      orders: [order({ id: 'o1', symbol: 'GATE_FUTURE_BTC_USDT' })],
    });
    const holdings = portfolio([
      { venue: 'SPOT', coin: 'USDT', balance: '50', unrealizedPnl: '0', equity: '50', futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', availableBalance: '50', liability: '0' },
    ]);
    const html = renderTabs({ trading, portfolioSnapshot: holdings });
    expect(tabLabels(html)).toEqual(['Positions (3)', 'Orders (1)']);
  });

  it('merges contract positions and spot holdings into one value-ordered list with per-row market tags', () => {
    const market: MarketSnapshot = {
      connectionState: 'healthy', updatedAt: '2026-09-01T00:00:00.000Z',
      markets: [spotMarket('GATE_SPOT_BTC_USDT', '62000')],
    };
    const trading = snapshot({ positions: [position()] });
    const holdings = portfolio([
      { venue: 'SPOT', coin: 'BTC', balance: '0.5', unrealizedPnl: '0', equity: '0', futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', availableBalance: '0.3', liability: '0' },
      { venue: 'CROSSEX', coin: 'USDT', balance: '999', unrealizedPnl: '0', equity: '999', futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', availableBalance: '999', liability: '0' },
    ]);
    const html = renderTabs({ trading, portfolioSnapshot: holdings, market });
    // The contract position (0.01 × 62000 = $620) trails the $31,000 spot holding.
    expect(html.indexOf('$31,000')).toBeGreaterThan(-1);
    expect(html.indexOf('$31,000')).toBeLessThan(html.indexOf('$620'));
    expect(html).toContain('market-type-tag perp');
    expect(html).toContain('market-type-tag spot');
    expect(html).toContain('BTCUSDT');
    expect(html).toContain('Entry / Available');
    expect(html).toContain('PnL / Valuation');
  });

  it('survives legacy tab values without blanking the panel', () => {
    expect(renderTabs({ bottomTab: 'Positions (2)' })).toContain('<button class="active">Positions (0)</button>');
    expect(renderTabs({ bottomTab: 'Open orders (3)' })).toContain('<button class="active">Orders (0)</button>');
    expect(renderTabs({ bottomTab: 'Order history' })).toContain('<button class="active">Orders (0)</button>');
    expect(renderTabs({ bottomTab: 'Trade history' })).toContain('<button class="active">Orders (0)</button>');
    expect(renderTabs({ bottomTab: 'spot-trade-history' })).toContain('<button class="active">Orders (0)</button>');
    expect(renderTabs({ bottomTab: 'spot-holdings' })).toContain('<button class="active">Positions (0)</button>');
  });

  it('unifies open orders with per-row market naming and tags', () => {
    const trading = snapshot({
      orders: [
        order({ id: 'spot-1', symbol: 'GATE_SPOT_BTC_USDT' }),
        order({ id: 'future-1', symbol: 'GATE_FUTURE_BTC_USDT' }),
      ],
    });
    const html = renderTabs({ bottomTab: 'orders', trading });
    expect(html).toContain('remote-spot-1');
    expect(html).toContain('remote-future-1');
    expect(html).toContain('BTC/USDT');
    expect(html).toContain('BTCUSDT');
    expect(html).toContain('>Market</th>');
    expect(html).not.toContain('>Contract</th>');
  });

  it('keeps the cancel button on resting history rows only in the unified history view', () => {
    const orders = [
      order({ id: 'open', symbol: 'GATE_FUTURE_BTC_USDT', state: 'OPEN' }),
      order({ id: 'filled', symbol: 'GATE_FUTURE_BTC_USDT', state: 'FILLED' }),
    ];
    // The history view wires OrderTable with cancellableFor={cancellableWhenResting} (identical
    // to the pre-0.4.1 history tabs) — only resting states keep their cancel reachable.
    const html = render(<OrderTable unified orders={orders} page={1} onPageChange={vi.fn()} cancellable
      cancellableFor={(item) => OPEN_ORDER_STATES.includes(item.state)}
      onCancel={vi.fn().mockResolvedValue(undefined)} busyOrderIds={[]} />);
    expect(html).toContain('remote-open');
    expect(html).toContain('remote-filled');
    expect(html.match(/>Cancel</g)).toHaveLength(1);
  });

  it('renders — for spot realized PnL in the unified trade view', () => {
    const fills = [
      fill({ id: 'spot-fill', symbol: 'GATE_SPOT_BTC_USDT', realized_pnl: '0' }),
      fill({ id: 'future-fill', symbol: 'GATE_FUTURE_BTC_USDT', realized_pnl: '4.2' }),
    ];
    const html = render(<FillTable unified fills={fills} page={1} onPageChange={vi.fn()} />);
    expect(html).toContain('BTC/USDT');
    expect(html).toContain('BTCUSDT');
    expect(html).toContain('<td>—</td>');
    expect(html).toContain('4.20');
  });

  it('keeps the spot-holdings valuation columns in the spot filter branch', () => {
    const market: MarketSnapshot = {
      connectionState: 'healthy', updatedAt: '2026-09-01T00:00:00.000Z',
      markets: [spotMarket('GATE_SPOT_BTC_USDT', '62000')],
    };
    const holdings = portfolio([
      { venue: 'SPOT', coin: 'BTC', balance: '0.5', unrealizedPnl: '0', equity: '0', futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', availableBalance: '0.3', liability: '0' },
      { venue: 'CROSSEX', coin: 'USDT', balance: '999', unrealizedPnl: '0', equity: '999', futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', availableBalance: '999', liability: '0' },
    ]);
    // The legacy key lands on Positions; the unified list shows the BTC holding's valuation
    // while the CROSSEX settlement balance stays out of the holdings rows.
    const html = renderTabs({ bottomTab: 'spot-holdings', portfolioSnapshot: holdings, market });
    expect(html).toContain('$31,000');
    expect(html).not.toContain('$999');
  });

  it('treats unified-account balances on catalog spot venues as spot holdings', () => {
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
  });

  it('renders per-view empty states on the merged tabs', () => {
    expect(renderTabs({ bottomTab: 'positions' })).toContain('No positions');
    expect(renderTabs({ bottomTab: 'orders' })).toContain('No open orders');
    // A filled order is invisible in the open view but counts on the history chip.
    expect(renderTabs({ bottomTab: 'orders', trading: snapshot({ orders: [order({ id: 'o1', symbol: 'GATE_FUTURE_BTC_USDT', state: 'FILLED' })] }) })).toContain('Order history (1)');
    expect(renderTabs({ bottomTab: 'orders', trading: snapshot({ orders: [order({ id: 'o1', symbol: 'GATE_FUTURE_BTC_USDT', state: 'FILLED' })] }) })).toContain('No open orders');
  });
});
