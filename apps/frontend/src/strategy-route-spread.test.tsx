import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LiveMarket, MarketSnapshot } from './api.js';
import { LanguageContext } from './i18n.js';
import { StrategyView } from './strategy-route.js';

/**
 * The price-difference bot's live spread must distinguish three situations that used to render
 * identically: no quote yet, a quote that aged out, and two quotes that are live but seconds
 * apart. These render assertions pin the visible copy for each one — the regression was a blank
 * number with no explanation, so "shows a different, honest sentence" *is* the contract.
 */

const NOW = Date.now();

function languageContext() {
  return { language: 'en' as const, theme: 'dark' as const, t: (key: string) => key, setLanguage: vi.fn() };
}

function market(overrides: Partial<LiveMarket> & Pick<LiveMarket, 'symbol' | 'venue' | 'asset'>): LiveMarket {
  return {
    lastPrice: '100',
    bidPrice: '100',
    bidSize: '10',
    askPrice: '101',
    askSize: '10',
    open24h: '100',
    high24h: '100',
    low24h: '100',
    volume24h: '10',
    quoteVolume24h: '1000',
    fundingRate: '0.0001',
    nextFundingAt: new Date(NOW + 3_600_000).toISOString(),
    openInterest: '0',
    openInterestValue: '0',
    receivedAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    quoteUpdatedAt: new Date(NOW).toISOString(),
    source: 'gate_crossex_websocket',
    ...overrides,
  };
}

function snapshot(markets: LiveMarket[]): MarketSnapshot {
  return { connectionState: 'healthy', updatedAt: new Date(NOW).toISOString(), markets };
}

function render(marketSnapshot: MarketSnapshot | null): string {
  vi.stubGlobal('window', { location: { search: '?asset=BTC&left=binance&right=okx' } });
  try {
    return renderToStaticMarkup(
      <LanguageContext.Provider value={languageContext()}>
        <StrategyView
          mode="auto"
          fees={[]}
          marketSnapshot={marketSnapshot}
          catalog={null}
          strategies={[]}
          balances={{}}
          authenticatedPortfolio={null}
          tradingSnapshot={null}
          tradingMode="live"
          onOpenModeDialog={vi.fn()}
          onStrategiesChanged={vi.fn(async () => undefined)}
          onPositionsRefresh={vi.fn(async () => undefined)}
          watchQuotes={vi.fn()}
          onOpenStrategyConfig={vi.fn()}
          onCopyStrategy={vi.fn()}
        />
      </LanguageContext.Provider>,
    );
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('price-difference bot live spread states', () => {
  it('says it is waiting when neither leg has a quote', () => {
    const html = render(null);
    expect(html).toContain('Waiting for both leg prices');
    expect(html).toContain('data-spread-status="waiting"');
    // No fabricated number: the spread cell renders an em dash, not "0.00 bps".
    expect(html).not.toContain('+0.00 bps');
  });

  it('labels an aged-out quote as stale instead of printing a spread', () => {
    const html = render(snapshot([
      market({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', asset: 'BTC', quoteUpdatedAt: new Date(NOW - 90_000).toISOString() }),
      market({ symbol: 'OKX_FUTURE_BTC_USDT', venue: 'OKX', asset: 'BTC' }),
    ]));
    expect(html).toContain('data-spread-status="stale"');
    expect(html).toContain('A leg quote is stale; waiting for its next update.');
    expect(html).toContain('Stale quote');
  });

  it('explains a pair whose legs quote seconds apart', () => {
    // 5s apart: still inside the 15s freshness budget, well outside the 2s skew budget.
    const html = render(snapshot([
      market({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', asset: 'BTC' }),
      market({ symbol: 'OKX_FUTURE_BTC_USDT', venue: 'OKX', asset: 'BTC', quoteUpdatedAt: new Date(NOW - 5_000).toISOString() }),
    ]));
    expect(html).toContain('data-spread-status="unaligned"');
    expect(html).toContain('Leg quotes are not time-aligned');
  });

  it('shows a real spread when both legs are live and contemporaneous', () => {
    const html = render(snapshot([
      market({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', asset: 'BTC', bidPrice: '101', askPrice: '101.1' }),
      market({ symbol: 'OKX_FUTURE_BTC_USDT', venue: 'OKX', asset: 'BTC', bidPrice: '100', askPrice: '100.1' }),
    ]));
    expect(html).toContain('data-spread-status="live"');
    // Sell leg at its bid (101), buy leg at its ask (100.1): (101 − 100.1) / 100.1 = 89.91 bps.
    expect(html).toContain('+89.91 bps');
    expect(html).toContain('Switch direction');
  });
});
