import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LiveMarket, MarketSnapshot, SavedStrategyPair } from './api.js';
import { LanguageContext } from './i18n.js';
import { SavedPairsPanel, UsStockArbView } from './us-stock-arb-route.js';

/**
 * The US-stock spread page was rebuilt on the SK hynix premium bot's skeleton, with the one
 * difference the operator asked for: both legs are free-form tickers. These render assertions pin
 * the structure that rebuild promised — heading, two editable legs, the price-difference history
 * panel with its large reading, the parameter block and the action block — and the honesty rule
 * that a leg without a quote reads "Waiting for quote" instead of a fabricated `0`.
 *
 * Rendering goes through `renderToStaticMarkup`, like the other route tests: the mount effects
 * (saved-pair fetch, depth polling, candle history) do not run, so nothing here needs a server.
 */

const NOW = Date.now();

function languageContext(language: 'en' | 'zh' = 'en') {
  return {
    language,
    theme: 'dark' as const,
    t: language === 'zh' ? (key: string) => `zh:${key}` : (key: string) => key,
    setLanguage: vi.fn(),
  };
}

/** A streamed market record with a quote received `localAgeMs` ago (our clock, not the venue's). */
function market(
  overrides: Partial<LiveMarket> & Pick<LiveMarket, 'symbol' | 'venue' | 'asset'> & { localAgeMs?: number },
): LiveMarket {
  const { localAgeMs = 0, ...rest } = overrides;
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
    receivedAt: new Date(NOW - localAgeMs).toISOString(),
    quoteReceivedAt: NOW - localAgeMs,
    updatedAt: new Date(NOW - localAgeMs).toISOString(),
    quoteUpdatedAt: new Date(NOW - localAgeMs).toISOString(),
    source: 'gate_crossex_websocket',
    ...rest,
  };
}

function snapshot(markets: LiveMarket[]): MarketSnapshot {
  return { connectionState: 'healthy', updatedAt: new Date(NOW).toISOString(), markets };
}

function render(marketSnapshot: MarketSnapshot | null, language: 'en' | 'zh' = 'en'): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={languageContext(language)}>
      <UsStockArbView
        marketSnapshot={marketSnapshot}
        catalog={null}
        tradingMode="live"
        onOpenModeDialog={vi.fn()}
        onStrategiesChanged={vi.fn(async () => undefined)}
        watchQuotes={vi.fn()}
      />
    </LanguageContext.Provider>,
  );
}

/** Both legs of the default pair quoting, five dollars apart. */
function livePairSnapshot(): MarketSnapshot {
  return snapshot([
    market({ symbol: 'GATE_FUTURE_SNDK_USDT', venue: 'GATE', asset: 'SNDK', bidPrice: '105', askPrice: '105.2', lastPrice: '105' }),
    market({ symbol: 'BINANCE_FUTURE_SNXX_USDT', venue: 'BINANCE', asset: 'SNXX', bidPrice: '99.8', askPrice: '100', lastPrice: '100' }),
  ]);
}

/** Two stored pairs, as the `/api/strategy-pairs` response would carry them. */
function savedPairs(): SavedStrategyPair[] {
  const timestamp = new Date(NOW).toISOString();
  return [
    {
      id: 'pair-1', name: 'SNDK / SNXX', leftSymbol: 'GATE_FUTURE_SNDK_USDT',
      rightSymbol: 'BINANCE_FUTURE_SNXX_USDT', ratio: '0.952381', entryBps: '20',
      createdAt: timestamp, updatedAt: timestamp,
    },
    {
      id: 'pair-2', name: 'SKHY / SKHYNIX', leftSymbol: 'GATE_FUTURE_SKHY_USDT',
      rightSymbol: 'GATE_FUTURE_SKHYNIX_USDT', ratio: '10', entryBps: null,
      createdAt: timestamp, updatedAt: timestamp,
    },
  ];
}

describe('US-stock spread page structure', () => {
  it('renders the page heading with the cross-asset eyebrow and the risk subtitle', () => {
    const html = render(null);
    expect(html).toContain('Cross-asset spread');
    expect(html).toContain('US-stock spread &amp; premium arbitrage');
    expect(html).toContain('Two different tickers on two venues');
  });

  it('renders both editable legs with a venue picker, a ticker input and the resolved market', () => {
    const html = render(null);
    expect(html).toContain('Market &amp; venues');
    expect(html).toContain('Left leg (sell)');
    expect(html).toContain('Right leg (buy)');
    // Two ticker inputs and two venue selects: the whole point of this page.
    expect(html.match(/placeholder="SNDK"/g)).toHaveLength(1);
    expect(html.match(/placeholder="SNXX"/g)).toHaveLength(1);
    expect(html.match(/<select/g)).toHaveLength(2);
    // The resolved symbols prove which market each leg actually subscribed to.
    expect(html).toContain('GATE_FUTURE_SNDK_USDT');
    expect(html).toContain('BINANCE_FUTURE_SNXX_USDT');
  });

  it('renders the price-difference history panel with the range switcher and the large reading', () => {
    const html = render(null);
    expect(html).toContain('Historical price difference');
    expect(html).toContain('premium-history-panel');
    expect(html).toContain('premium-history-value');
    expect(html).toContain('1H');
    expect(html).toContain('4H');
    expect(html).toContain('24H');
    expect(html).toContain('Left leg price');
    expect(html).toContain('Right leg price');
    expect(html).toContain('Price gap');
    expect(html).toContain('Quantity ratio');
  });

  it('renders the parameter block and the two-step action block', () => {
    const html = render(null);
    expect(html).toContain('Entry threshold (bps)');
    expect(html).toContain('Equal-notional ratio');
    expect(html).toContain('Total quantity');
    expect(html).toContain('Per-order quantity');
    expect(html).toContain('Leverage');
    expect(html).toContain('Saved pairs');
    expect(html).toContain('Save pair');
    expect(html).toContain('Review &amp; launch');
    expect(html).toContain('start-strategy');
    // Nothing is sized yet, so the action is disabled *and says why* instead of a silent grey
    // button. The enabled label is "Launch strategy"; the confirmation step is a second click.
    expect(html).toContain('Enter valid strategy amounts');
    expect(html).not.toContain('strategy-confirm-modal');
  });

  it('localises every label through t()', () => {
    const html = render(null, 'zh');
    expect(html).toContain('zh:Cross-asset spread');
    expect(html).toContain('zh:Stock ticker');
    expect(html).toContain('zh:Saved pairs');
    expect(html).toContain('zh:Waiting for quote');
    expect(html).toContain('zh:Enter valid strategy amounts');
  });
});

describe('US-stock spread leg quotes', () => {
  it('says "Waiting for quote" on both legs when no quote has arrived — never 0', () => {
    const html = render(null);
    expect(html.match(/Waiting for quote/g)).toHaveLength(2);
    expect(html).toContain('data-spread-status="waiting"');
    expect(html).toContain('Waiting for both leg prices');
    // A price cell with no quote renders an em dash, and the headline spread stays blank.
    expect(html).not.toContain('>0.00 bps<');
    expect(html).not.toContain('>0.0 bps<');
  });

  it('prints the live spread once both legs quote inside the skew budget', () => {
    const html = render(livePairSnapshot());
    expect(html).toContain('data-spread-status="live"');
    // (105 − 100) / 100 = +500 bps.
    expect(html).toContain('+500.0 bps');
    expect(html).not.toContain('Waiting for quote');
  });

  it('reports a stale leg as stale instead of showing its price as if it were tradable', () => {
    const html = render(snapshot([
      market({ symbol: 'GATE_FUTURE_SNDK_USDT', venue: 'GATE', asset: 'SNDK', localAgeMs: 120_000 }),
      market({ symbol: 'BINANCE_FUTURE_SNXX_USDT', venue: 'BINANCE', asset: 'SNXX' }),
    ]));
    expect(html).toContain('Stale quote');
    expect(html).toContain('data-spread-status="stale"');
    expect(html).toContain('A leg quote is stale; waiting for its next update.');
  });

  it('names the leg that has no quote when only one side is missing', () => {
    const html = render(snapshot([
      market({ symbol: 'GATE_FUTURE_SNDK_USDT', venue: 'GATE', asset: 'SNDK' }),
    ]));
    expect(html).toContain('Waiting for the missing leg quote');
    expect(html.match(/Waiting for quote/g)).toHaveLength(1);
  });
});

describe('US-stock spread saved pairs', () => {
  it('shows the empty-state hint and no rows when nothing is saved', () => {
    const html = render(null);
    expect(html).toContain('us-pair-saved');
    expect(html).toContain('No saved pairs yet — configure one below and save it.');
    expect(html).not.toContain('us-pair-load');
  });

  it('lists every saved pair with its two symbols and ratio, each row loadable and deletable', () => {
    const html = renderToStaticMarkup(
      <LanguageContext.Provider value={languageContext()}>
        <SavedPairsPanel
          pairs={savedPairs()}
          name=""
          onNameChange={vi.fn()}
          onSave={vi.fn()}
          onApply={vi.fn()}
          onDelete={vi.fn()}
          saving={false}
          canSave
          error={null}
          notice={null}
          namePlaceholder="SNDK/SNXX"
        />
      </LanguageContext.Provider>,
    );
    expect(html).not.toContain('No saved pairs yet');
    expect(html.match(/us-pair-load/g)).toHaveLength(2);
    expect(html).toContain('SNDK / SNXX');
    expect(html).toContain('GATE_FUTURE_SNDK_USDT / BINANCE_FUTURE_SNXX_USDT');
    expect(html).toContain('Save pair');
    expect(html).toContain('Delete');
  });
});
