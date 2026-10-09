import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CrossExInstrument } from '@gate-crossex/shared-types';
import type { LiveMarket, MarketSnapshot } from './api.js';
import type { SpotHoldingsRow } from './execution-split.js';
import { LanguageContext } from './i18n.js';
import { SpotCloseDialog } from './spot-close-dialog.js';

/**
 * The spot close dialog has two directions: a long is sold, a short (CrossEx coin liability) is
 * bought back with a quote-sized market buy. These cases pin the labels and the side-specific
 * wording so the buy-back path cannot silently regress into a sell.
 */
function row(overrides: Partial<SpotHoldingsRow> = {}): SpotHoldingsRow {
  return { venue: 'GATE', coin: 'ADA', total: 55.12345678, available: 55.12345678, locked: 0, valuationUsd: 22, ...overrides };
}

function instrument(): CrossExInstrument {
  return {
    symbol: 'GATE_SPOT_ADA_USDT', exchangeType: 'GATE', businessType: 'SPOT', state: 'live',
    minSize: '1', minNotional: '1', lotSize: '1', tickSize: '0.0001', maxNumOrders: '100',
    maxMarketSize: null, maxLimitSize: null, contractSize: null, liquidationFee: null,
    defaultLeverage: null, delistTime: '0',
  };
}

function marketSnapshot(): MarketSnapshot {
  const market: LiveMarket = {
    symbol: 'GATE_SPOT_ADA_USDT', venue: 'GATE', asset: 'ADA', lastPrice: '0.4', bidPrice: '0.4',
    bidSize: '1000', askPrice: '0.401', askSize: '1000', open24h: '0.4', high24h: '0.42', low24h: '0.39',
    volume24h: '1000', quoteVolume24h: '400', fundingRate: '0', nextFundingAt: '', openInterest: '0',
    openInterestValue: '0', receivedAt: '', updatedAt: '', source: 'rest_book_ticker',
  };
  return { markets: [market], fetchedAt: '', source: 'rest_market_catalog' } as unknown as MarketSnapshot;
}

function render(holding: SpotHoldingsRow): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
      <SpotCloseDialog holding={holding} instruments={[instrument()]} marketSnapshot={marketSnapshot()}
        onDismiss={() => undefined} onCompleted={() => undefined} notify={() => undefined} />
    </LanguageContext.Provider>,
  );
}

describe('SpotCloseDialog', () => {
  it('renders the sell wording for a long holding', () => {
    const html = render(row());
    expect(html).toContain('Confirm close position');
    expect(html).toContain('>Sell amount</dt>');
    expect(html).toContain('>Estimated proceeds</dt>');
    expect(html).toContain('>Market sell</dd>');
    expect(html).toContain('Market sell · 100%');
    expect(html).toContain('Close position');
    expect(html).not.toContain('Buy amount');
  });

  it('renders the buy-back wording for a short holding', () => {
    const html = render(row({ total: -55.4, available: -55.4, valuationUsd: -22 }));
    expect(html).toContain('Close short position');
    expect(html).toContain('>Liability</dt>');
    expect(html).toContain('>Buy amount</dt>');
    expect(html).toContain('>Estimated cost</dt>');
    expect(html).toContain('>Market buy</dd>');
    expect(html).toContain('Market buy · 100%');
    expect(html).toContain('confirm-submit buy');
    expect(html).not.toContain('Sell amount');
  });

  it('shows the lot-floored size and the estimated cost of the buy-back', () => {
    const html = render(row({ total: -55.4, available: -55.4, valuationUsd: -22 }));
    // lot 1 → 55 ADA, priced off the 0.401 ask → $22.06 (formatAmount keeps 2 decimals).
    expect(html).toContain('55 ADA');
    expect(html).toContain('$22.06');
  });

  it('does not introduce aria-pressed anywhere in the dialog', () => {
    expect([...render(row()).matchAll(/aria-pressed=/g)]).toHaveLength(0);
    expect(render(row())).toContain('aria-modal="true"');
  });
});
