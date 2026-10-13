import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StrategyConfig, StrategyRecord } from './api.js';
import { LanguageContext } from './i18n.js';
import { CarryStrategyView, PremiumStrategyView, StrategyView } from './strategy-route.js';
import { strategyCopyQuery } from './strategy-copy.js';

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
  onOpenStrategyConfig: vi.fn(),
  onCopyStrategy: vi.fn(),
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

/** The premium page needs its own candle/watch props; everything else it shares with the others. */
function premiumView() {
  return <PremiumStrategyView {...SHARED_PROPS} candleSeries={{}} watchKlines={vi.fn()} />;
}

/** A stopped premium strategy, shaped exactly like the record the backend hands back. */
function premiumRecord(): StrategyRecord {
  const config: StrategyConfig = {
    kind: 'premium',
    asset: 'SKHY',
    hedgeAsset: 'SKHYNIX',
    leftVenue: 'BINANCE',
    rightVenue: 'OKX',
    leftSide: 'SELL',
    rightSide: 'BUY',
    adrRatio: '9.5',
    entryPremiumPct: '1.5',
    takeProfitPremiumPct: '0.4',
    hedgeMode: 'SHARE_RATIO',
    maxPosition: '0.5',
    perOrderQuantity: '0.1',
    reduceOnly: false,
    executionMethod: 'TAKER_TAKER',
    leftLeverage: '3',
    rightLeverage: '2',
  };
  return {
    id: 'PREM-COPY03',
    kind: 'premium',
    status: 'STOPPED',
    accountProfileId: 'gate-crossex-default',
    accountLabel: 'Gate CrossEx',
    config,
    progress: 100,
    filledQuantity: '0.2',
    filledLeft: '0.1',
    filledRight: '0.1',
    openPosition: '0',
    realizedPnl: '3.5',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T01:00:00.000Z',
    stoppedAt: '2026-08-14T01:00:00.000Z',
  };
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
    expect(html).toContain('aria-checked="true">Spot</button>'); // left leg switched to spot
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

describe('auto form one-click copy prefill', () => {
  /** Exactly what `strategyCopyQuery()` emits for a stopped auto strategy. */
  const COPY_QUERY = '?asset=ETH&hedgeAsset=USDT&left=gate&right=okx&entryBps=8&takeProfitBps=40'
    + '&stopLossBps=100&addOnStepBps=20&maxPosition=2&perOrderQuantity=0.5'
    + '&leftLeverage=3&rightLeverage=2&executionMethod=maker&makerLeg=right&reduceOnly=true'
    + '&copyStrategyId=AUTO-COPY01';

  it('adopts the stop-loss, ladder step, sizes, method, and leverage of the copied strategy', () => {
    const html = renderWithQuery(COPY_QUERY, autoView());
    expect(html).toContain('<input value="8"'); // entry threshold
    expect(html).toContain('<input value="40"'); // take-profit threshold
    expect(html).toContain('<input placeholder="Optional" value="100"'); // stop-loss threshold
    expect(html).toContain('<input placeholder="Optional" value="20"'); // add-on step
    expect(html).toContain('<input placeholder="e.g. 0.05" value="0.5"'); // order quantity
    expect(html).toContain('<input placeholder="e.g. 2.00" value="2"'); // max position
    expect(html).toContain('aria-label="Exchange A leverage: 3×"');
    expect(html).toContain('aria-label="Exchange B leverage: 2×"');
    expect(html).toContain('aria-label="Choose maker leg"'); // Maker–Taker switched on
    expect(html).toContain('aria-label="Exchange A: Gate.io"');
    expect(html).toContain('aria-label="Exchange B: OKX"');
  });

  it('announces which strategy the form was prefilled from, and how to dismiss the notice', () => {
    const html = renderWithQuery(COPY_QUERY, autoView());
    expect(html).toContain('class="strategy-copy-notice"');
    expect(html).toContain('<strong>AUTO-COPY01</strong>');
    expect(html).toContain('Dismiss prefill notice');
  });

  it('shows no notice when the form was not opened from a copy', () => {
    expect(renderWithQuery('?asset=ETH&entryBps=8', autoView())).not.toContain('strategy-copy-notice');
    expect(renderWithQuery('', autoView())).not.toContain('strategy-copy-notice');
  });

  it('keeps the documented defaults when a copied parameter is malformed', () => {
    const html = renderWithQuery(
      '?takeProfitBps=abc&stopLossBps=-&addOnStepBps=1;2&perOrderQuantity=x&maxPosition=y'
      + '&leftLeverage=z&rightLeverage=w&executionMethod=MAKER&copyStrategyId=AUTO-COPY02',
      autoView(),
    );
    expect(html).toContain('<input value="0.4"'); // malformed take-profit → default
    expect(html).toContain('<input placeholder="Optional" value="100"'); // malformed stop-loss → default
    expect(html).toContain('<input placeholder="Optional" value=""'); // malformed add-on → blank
    expect(html).toContain('<input placeholder="e.g. 0.05" value=""'); // malformed quantity → blank
    expect(html).toContain('<input placeholder="e.g. 2.00" value=""'); // malformed max → blank
    expect(html).toContain('aria-label="Exchange A leverage: 1×"'); // malformed → default 1×
    expect(html).not.toContain('Choose maker leg'); // `MAKER` (uppercase) is not `maker`
    // The notice still names the strategy, even though nothing usable was prefilled.
    expect(html).toContain('<strong>AUTO-COPY02</strong>');
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

describe('carry form one-click copy prefill', () => {
  it('adopts the venues, funding gate, and open amount of the copied carry strategy', () => {
    const html = renderWithQuery(
      '?asset=ETH&leftVenue=gate&rightVenue=okx&leftSymbol=GATE_SPOT_ETH_USDT&rightSymbol=OKX_FUTURE_ETH_USDT'
      + '&direction=NEGATIVE&aprMin=12&totalAmount=0.5&copyStrategyId=CARRY-COPY01',
      carryView(),
    );

    expect(html).toContain('aria-label="Spot leg venue: Gate.io"');
    expect(html).toContain('aria-label="Perpetual leg venue: OKX"');
    expect(html).toContain('GATE_SPOT_ETH_USDT');
    expect(html).toContain('OKX_FUTURE_ETH_USDT');
    expect(html).toContain('<input value="12"'); // funding APR threshold
    expect(html).toContain('<input placeholder="e.g. 0.10" value="0.5"'); // open amount
    expect(html).toContain('<dd>NEGATIVE</dd>');
    expect(html).toContain('class="strategy-copy-notice"');
    expect(html).toContain('<strong>CARRY-COPY01</strong>');
    expect(html).toContain('Dismiss prefill notice');
  });

  it('leaves the open amount blank when the copy carries no amount', () => {
    const html = renderWithQuery('?asset=ETH&leftVenue=gate&rightVenue=okx&direction=POSITIVE', carryView());
    expect(html).toContain('<input placeholder="e.g. 0.10" value=""');
    expect(html).not.toContain('strategy-copy-notice');
  });
});

describe('premium form one-click copy prefill', () => {
  /** Exactly what `strategyCopyQuery()` emits for a stopped premium strategy. */
  const COPY_QUERY = '?asset=SKHY&hedgeAsset=SKHYNIX&leftSide=SELL&rightSide=BUY&left=BINANCE&right=OKX'
    + '&perOrderQuantity=0.1&reduceOnly=false&executionMethod=taker'
    + '&leftVenue=BINANCE&rightVenue=OKX'
    + '&entryPremiumPct=1.5&takeProfitPremiumPct=0.4&adrRatio=9.5&hedgeMode=SHARE_RATIO'
    + '&maxPosition=0.5&leftLeverage=3&rightLeverage=2&copyStrategyId=PREM-COPY01';

  it('prefills the thresholds, the share ratio, the sizes, and the hedge sizing mode', () => {
    const html = renderWithQuery(COPY_QUERY, premiumView());
    expect(html).toContain('<input placeholder="e.g. 0.10" value="0.1"'); // per-order quantity
    expect(html).toContain('<input placeholder="e.g. 0.50" value="0.5"'); // max position
    expect(html).toContain('<input value="1.5"'); // entry premium
    expect(html).toContain('<input value="0.4"'); // take-profit premium
    expect(html).toContain('aria-label="ADR leg: Binance"'); // ADR venue
    expect(html).toContain('aria-label="Hedge leg: OKX"'); // hedge venue
    expect(html).toContain('aria-label="SKHY leverage: 3×"'); // ADR leverage
    expect(html).toContain('aria-label="SKHYNIX leverage: 2×"'); // hedge leverage
    // The share ratio is a constant in the un-prefilled form, so it only shows up when a copy
    // restores it — this is the assertion that proves it became query-driven state.
    expect(html).toContain('1 SKHYNIX = 9.5 SKHY');
    // The hedge-sizing picker renders both options; only the active one carries `aria-checked`.
    expect(html).toContain('aria-checked="true" class="active"><small>Share ratio</small>');
    expect(html).toContain('aria-checked="false" class=""><small>Equal notional</small>');
    expect(html).toContain('>Short premium<'); // leftSide=SELL keeps the default direction
  });

  it('announces which premium strategy the form was prefilled from', () => {
    const html = renderWithQuery(COPY_QUERY, premiumView());
    expect(html).toContain('class="strategy-copy-notice"');
    expect(html).toContain('<strong>PREM-COPY01</strong>');
    expect(html).toContain('Dismiss prefill notice');
  });

  it('shows no notice and keeps the defaults when the page is opened without a copy query', () => {
    const html = renderWithQuery('', premiumView());
    expect(html).toContain('<input value="35"'); // entry premium default
    expect(html).toContain('<input value="24"'); // take-profit premium default
    expect(html).toContain('1 SKHYNIX = 10 SKHY'); // DEFAULT_ADR_RATIO
    expect(html).toContain('aria-label="ADR leg: Gate.io"');
    expect(html).toContain('aria-label="Hedge leg: Gate.io"');
    expect(html).not.toContain('strategy-copy-notice');
  });

  it('flips the direction for a copied long premium', () => {
    const html = renderWithQuery(COPY_QUERY.replace('leftSide=SELL', 'leftSide=BUY'), premiumView());
    expect(html).toContain('>Long premium<');
    expect(html).not.toContain('>Short premium<');
  });

  it('reads back exactly the query strategyCopyQuery emits for a stored premium record', () => {
    // Round trip through the single producer: no hand-maintained query string, so the two files can
    // never drift apart. Every field of the launch payload has to come back onto the form.
    const search = `?${new URLSearchParams(strategyCopyQuery(premiumRecord())).toString()}`;
    const html = renderWithQuery(search, premiumView());
    expect(html).toContain('aria-label="ADR leg: Binance"');
    expect(html).toContain('aria-label="Hedge leg: OKX"');
    expect(html).toContain('<input placeholder="e.g. 0.10" value="0.1"');
    expect(html).toContain('<input placeholder="e.g. 0.50" value="0.5"');
    expect(html).toContain('<input value="1.5"');
    expect(html).toContain('<input value="0.4"');
    expect(html).toContain('aria-label="SKHY leverage: 3×"');
    expect(html).toContain('aria-label="SKHYNIX leverage: 2×"');
    expect(html).toContain('1 SKHYNIX = 9.5 SKHY');
    expect(html).toContain('aria-checked="true" class="active"><small>Share ratio</small>');
    expect(html).toContain('>Short premium<');
    expect(html).toContain('<strong>PREM-COPY03</strong>');
  });

  it('falls back per field when a copied parameter is malformed', () => {
    const html = renderWithQuery(
      '?entryPremiumPct=abc&takeProfitPremiumPct=1;2&adrRatio=xyz&perOrderQuantity=x&maxPosition=y'
      + '&leftLeverage=z&rightLeverage=w&leftVenue=moonshot&rightVenue=moonshot&hedgeMode=weird'
      + '&leftSide=SELL&copyStrategyId=PREM-COPY02',
      premiumView(),
    );
    expect(html).toContain('<input value="35"'); // malformed entry → default
    expect(html).toContain('<input value="24"'); // malformed take-profit → default
    expect(html).toContain('1 SKHYNIX = 10 SKHY'); // malformed ratio → DEFAULT_ADR_RATIO
    expect(html).toContain('<input placeholder="e.g. 0.10" value=""'); // malformed quantity → blank
    expect(html).toContain('<input placeholder="e.g. 0.50" value=""'); // malformed max → blank
    expect(html).toContain('aria-label="SKHY leverage: 3×"'); // malformed leverage → default
    expect(html).toContain('aria-label="SKHYNIX leverage: 3×"');
    expect(html).toContain('aria-label="ADR leg: Gate.io"'); // unknown venue → default
    expect(html).toContain('aria-label="Hedge leg: Gate.io"');
    expect(html).toContain('<small>Equal notional</small>'); // unknown hedge mode → default
    expect(html).toContain('aria-checked="true" class="active"><small>Equal notional</small>');
    // The notice still names the strategy, even though nothing usable was prefilled.
    expect(html).toContain('<strong>PREM-COPY02</strong>');
  });
});
