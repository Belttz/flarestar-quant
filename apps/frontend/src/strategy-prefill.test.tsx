import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LanguageContext } from './i18n.js';
import { CarryStrategyView, StrategyView } from './strategy-route.js';

function languageContext() {
  return { language: 'en' as const, theme: 'dark' as const, t: (key: string) => key, setLanguage: vi.fn() };
}

const SHARED_PROPS = {
  marketSnapshot: null,
  catalog: null,
  strategies: [],
  balances: {},
  authenticatedPortfolio: null,
  tradingSnapshot: null,
  tradingMode: 'live' as const,
  onOpenModeDialog: vi.fn(),
  onStrategiesChanged: vi.fn(async () => undefined),
  onPositionsRefresh: vi.fn(async () => undefined),
  watchQuotes: vi.fn(),
};

/**
 * Mount-time URL query prefill (architecture §4.2): the form is rendered with a stubbed
 * window.location.search, exactly what a browser lands on after the Opportunities board's
 * one-click jump. renderToStaticMarkup runs the useState initializers (where the query is
 * parsed) but not effects, so no backend calls are needed.
 */
function renderWithQuery(search: string, element: React.ReactElement): string {
  vi.stubGlobal('window', { location: { search } });
  try {
    return renderToStaticMarkup(<LanguageContext.Provider value={languageContext()}>{element}</LanguageContext.Provider>);
  } finally {
    vi.unstubAllGlobals();
  }
}

function carryView() {
  return <CarryStrategyView {...SHARED_PROPS} />;
}

function autoView() {
  return <StrategyView {...SHARED_PROPS} mode="auto" fees={[]} />;
}

describe('carry form query prefill', () => {
  it('prefills asset, direction, and the APR threshold from the one-click query', () => {
    const html = renderWithQuery('?asset=ETH&direction=NEGATIVE&aprMin=12&apr=15', carryView());
    expect(html).toContain('<input value="12"'); // funding APR threshold
    expect(html).toContain('<dd>NEGATIVE</dd>'); // direction review
    expect(html).toContain('ETH carry'); // launch intent
    expect(html).toContain('GATE_FUTURE_ETH_USDT'); // perpetual leg symbol follows the asset
  });

  it('keeps the defaults when no query is present', () => {
    const html = renderWithQuery('', carryView());
    expect(html).toContain('<input value="15"');
    expect(html).toContain('<dd>POSITIVE</dd>');
    expect(html).toContain('BTC carry');
  });

  it('falls back per-field for invalid query values', () => {
    const html = renderWithQuery('?asset=eth&aprMin=not-a-number&direction=SIDEWAYS', carryView());
    expect(html).toContain('<input value="15"'); // non-decimal aprMin → default
    expect(html).toContain('<dd>POSITIVE</dd>'); // unknown direction → default
    expect(html).toContain('ETH carry'); // asset is normalized to uppercase and accepted
  });
});

describe('auto form query prefill', () => {
  it('prefills venues, leg products, asset, and the entry threshold from the one-click query', () => {
    const html = renderWithQuery('?asset=ETH&left=gate&right=binance&leftProduct=spot&rightProduct=perp&entryBps=8&spreadBps=10', autoView());
    expect(html).toContain('aria-label="Exchange A: Gate.io"'); // sell leg venue
    expect(html).toContain('aria-label="Exchange B: Binance"'); // buy leg venue
    expect(html).toContain('<input value="8"'); // entry threshold bps
    expect(html).toContain('aria-pressed="true">Spot</button>'); // left leg switched to spot
  });

  it('keeps the Binance/OKX perpetual defaults when no query is present', () => {
    const html = renderWithQuery('', autoView());
    expect(html).toContain('aria-label="Exchange A: Binance"');
    expect(html).toContain('aria-label="Exchange B: OKX"');
    expect(html).toContain('<input value="0"'); // entry threshold default
  });

  it('rejects unknown venues and non-decimal thresholds instead of half-prefilling', () => {
    const html = renderWithQuery('?asset=ETH&left=moonshot&entryBps=8;10', autoView());
    expect(html).toContain('aria-label="Exchange A: Binance"'); // unknown venue → default
    expect(html).toContain('<input value="0"'); // malformed entryBps → default
    expect(html).toContain('<b>ETH</b>'); // asset still normalized and accepted
  });
});

describe('carry form v2 four-tuple prefill', () => {
  it('locks both leg venues and adopts the prefilled leg symbols from the Opportunities four-tuple query', () => {
    const html = renderWithQuery(
      '?asset=BTC&leftVenue=binance&rightVenue=okx&leftSymbol=BINANCE_SPOT_BTC_USDT&rightSymbol=OKX_FUTURE_BTC_USDT&direction=POSITIVE&aprMin=12',
      carryView(),
    );
    // Both venue selects are locked to the prefilled venues, not the Gate defaults.
    expect(html).toContain('aria-label="Spot leg venue: Binance"');
    expect(html).toContain('aria-label="Perpetual leg venue: OKX"');
    // The prefilled leg symbols are adopted verbatim (venue prefix matches the selected venue).
    expect(html).toContain('BINANCE_SPOT_BTC_USDT');
    expect(html).toContain('OKX_FUTURE_BTC_USDT');
    expect(html).toContain('<input value="12"');
  });

  it('ignores prefilled symbols whose venue prefix does not match the selected venue', () => {
    const html = renderWithQuery(
      '?asset=BTC&leftVenue=binance&rightVenue=okx&leftSymbol=OKX_SPOT_BTC_USDT&rightSymbol=GATE_FUTURE_BTC_USDT',
      carryView(),
    );
    // The venues still lock, but the mismatched symbols are not adopted: the left leg falls back
    // to the documented pre-catalog GATE_SPOT convention and the perp leg derives OKX_FUTURE.
    expect(html).toContain('aria-label="Spot leg venue: Binance"');
    expect(html).toContain('aria-label="Perpetual leg venue: OKX"');
    expect(html).not.toContain('OKX_SPOT_BTC_USDT');
    expect(html).not.toContain('GATE_FUTURE_BTC_USDT');
    expect(html).toContain('GATE_SPOT_BTC_USDT');
    expect(html).toContain('OKX_FUTURE_BTC_USDT');
  });
});
