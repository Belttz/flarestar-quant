import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MarketCatalogAsset, MarketSnapshot } from './api.js';
import { MarketSelect, SELECTOR_WATCH_CAP, visibleWatchSymbols } from './market-select.js';

function catalogEntry(asset: string, symbols: string[]): MarketCatalogAsset {
  return {
    asset,
    streamed: false,
    venues: symbols.map((symbol) => ({
      venue: symbol.split('_')[0] ?? 'GATE',
      quote: symbol.split('_')[3] ?? 'USDT',
      symbol,
      business: symbol.includes('_SPOT_') ? ('SPOT' as const) : ('FUTURE' as const),
    })),
  };
}

function entryAsset(symbol: string): string {
  return symbol.split('_')[2] ?? symbol;
}

describe('visibleWatchSymbols', () => {
  it('collects deduped row symbols in display order', () => {
    const rows = [
      catalogEntry('BTC', ['GATE_SPOT_BTC_USDT', 'GATE_FUTURE_BTC_USDT', 'BINANCE_FUTURE_BTC_USDT']),
      catalogEntry('ETH', ['GATE_SPOT_ETH_USDT', 'GATE_SPOT_ETH_USDC', 'GATE_FUTURE_ETH_USDT']),
    ];
    expect(visibleWatchSymbols(rows)).toEqual([
      'GATE_SPOT_BTC_USDT', 'GATE_FUTURE_BTC_USDT', 'BINANCE_FUTURE_BTC_USDT',
      'GATE_SPOT_ETH_USDT', 'GATE_SPOT_ETH_USDC', 'GATE_FUTURE_ETH_USDT',
    ]);
  });

  it('caps the batch below the upstream per-connection symbol budget', () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      catalogEntry(`A${index}`, [`GATE_SPOT_A${index}_USDT`, `BYBIT_FUTURE_A${index}_USDT`]));
    const symbols = visibleWatchSymbols(rows);
    expect(symbols).toHaveLength(SELECTOR_WATCH_CAP);
    // The cap trims the tail of the display order, never the head.
    expect(symbols[0]).toBe('GATE_SPOT_A0_USDT');
    expect(symbols.includes('BYBIT_FUTURE_A99_USDT')).toBe(false);
  });

  it('returns every symbol when the batch fits the cap', () => {
    const rows = [catalogEntry('BTC', ['GATE_SPOT_BTC_USDT', 'GATE_FUTURE_BTC_USDT'])];
    expect(visibleWatchSymbols(rows, 10)).toHaveLength(2);
  });
});

describe('market select', () => {
  const baseProps = {
    asset: 'BTC',
    label: 'BTCUSDT',
    venue: 'GATE',
    subtitle: 'Bitcoin perpetual',
    icon: '₿',
    catalog: null,
    marketSnapshot: null,
    favorites: [],
    assetName: (asset: string) => asset,
    assetIcon: (asset: string) => asset,
    onSelect: () => undefined,
    t: (key: string) => key,
  };

  it('renders the trigger while closed', () => {
    const html = renderToStaticMarkup(<MarketSelect {...baseProps} />);
    expect(html).toContain('pair-trigger');
    expect(html).not.toContain('role="option"');
  });

  it('renders only the first batch of rows when the catalog exceeds it', () => {
    // First batch is 60 rows; scrolling grows the window, but the initial render stays light.
    const catalog = Array.from({ length: 70 }, (_, index) => catalogEntry(`A${index}`, [`GATE_SPOT_A${index}_USDT`]));
    const html = renderToStaticMarkup(<MarketSelect {...baseProps} defaultOpen catalog={catalog} />);
    expect(html).toContain('Showing 60 / 70');
    expect((html.match(/role="option"/g) ?? []).length).toBe(60);
  });

  it('shows the REST snapshot price with a delay marker for unsubscribed symbols', () => {
    const fetchedAt = '2026-10-09T12:00:00.000Z';
    const snapshot: MarketSnapshot = {
      connectionState: 'healthy',
      updatedAt: fetchedAt,
      markets: [{
        symbol: 'GATE_SPOT_SIREN_USDT', venue: 'GATE', asset: 'SIREN',
        lastPrice: '0.1193', bidPrice: '0.1192', bidSize: '0', askPrice: '0.1194', askSize: '0',
        open24h: '0', high24h: '0', low24h: '0', volume24h: '0', quoteVolume24h: '0',
        fundingRate: '0', nextFundingAt: '', openInterest: '0', openInterestValue: '0',
        receivedAt: fetchedAt, updatedAt: fetchedAt, source: 'rest_book_ticker',
      }],
    };
    const html = renderToStaticMarkup(<MarketSelect
      {...baseProps}
      defaultOpen
      catalog={[catalogEntry('SIREN', ['GATE_SPOT_SIREN_USDT'])]}
      marketSnapshot={snapshot}
    />);
    // The REST row fills the price column and carries the delay marker.
    expect(html).toContain('0.1193');
    expect(html).toContain('Delayed REST quote (~30s)');
  });

  it('shows hub websocket prices without the delay marker', () => {
    const now = new Date().toISOString();
    const snapshot: MarketSnapshot = {
      connectionState: 'healthy',
      updatedAt: now,
      markets: [{
        symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC',
        lastPrice: '63952', bidPrice: '63951.5', bidSize: '1', askPrice: '63952.5', askSize: '1',
        open24h: '63000', high24h: '64000', low24h: '62000', volume24h: '10', quoteVolume24h: '1000',
        fundingRate: '0', nextFundingAt: '', openInterest: '0', openInterestValue: '0',
        receivedAt: now, updatedAt: now, source: 'gate_crossex_websocket',
      }],
    };
    const html = renderToStaticMarkup(<MarketSelect
      {...baseProps}
      defaultOpen
      catalog={[catalogEntry('BTC', ['GATE_SPOT_BTC_USDT'])]}
      marketSnapshot={snapshot}
    />);
    // The hub row fills the price column (locale-formatted, thousands separator) with no marker.
    expect(html).toContain('63,952');
    expect(html).not.toContain('Delayed REST quote (~30s)');
  });
});
