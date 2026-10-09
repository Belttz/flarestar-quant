import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SpotHoldingsTable } from './execution-tables.js';
import { LanguageContext } from './i18n.js';
import type { SpotHoldingsRow } from './execution-split.js';

function row(overrides: Partial<SpotHoldingsRow> = {}): SpotHoldingsRow {
  return { venue: 'GATE', coin: 'BTC', total: 1, available: 1, locked: 0, valuationUsd: 62_000, ...overrides };
}

function render(ui: React.ReactNode): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
      {ui}
    </LanguageContext.Provider>,
  );
}

const baseProps = { page: 1, onPageChange: vi.fn() };

describe('SpotHoldingsTable', () => {
  it('renders the balance columns with the asset icon on the coin cell', () => {
    const html = render(<SpotHoldingsTable {...baseProps} rows={[row()]} />);
    expect(html).toContain('>Market</th>');
    expect(html).toContain('>Coin</th>');
    expect(html).toContain('>Side</th>');
    expect(html).toContain('>Total</th>');
    expect(html).toContain('>Available</th>');
    expect(html).toContain('>Locked</th>');
    expect(html).toContain('>Valuation (USDT)</th>');
    expect(html).toContain('₿ BTC');
  });

  it('labels a held balance as a long position', () => {
    const html = render(<SpotHoldingsTable {...baseProps} rows={[row()]} />);
    expect(html).toContain('long-tag">Long</small>');
  });

  // 现货做空：CrossEx 的币种负债在持仓行里是负数，必须显示为做空并给出「买回平空」入口。
  it('shows a short (liability) row with a Short tag and a buy-back action', () => {
    const html = render(<SpotHoldingsTable {...baseProps} rows={[row({ total: -100, available: -100, valuationUsd: -40 })]} closeState={{ onRequest: vi.fn(), isClosable: () => true }} />);
    expect(html).toContain('short-tag">Short</small>');
    expect(html).toContain('-100');
    expect(html).toContain('-$40');
    expect(html).toContain('Buy back');
    expect(html).not.toContain('>Close position</button>');
  });

  it('keeps the sell-side action label for a long', () => {
    const html = render(<SpotHoldingsTable {...baseProps} rows={[row()]} closeState={{ onRequest: vi.fn(), isClosable: () => true }} />);
    expect(html).toContain('Close position');
  });

  // 该交易所没有可买回的现货市场时，按钮换成「如何归还」：用户需要一条能走通的路，而不是灰按钮。
  it('offers the repayment explainer for a debt this exchange cannot buy back', () => {
    const onExplain = vi.fn();
    const html = render(<SpotHoldingsTable {...baseProps} rows={[row({ venue: 'HYPERLIQUID', coin: 'USDC', total: -12.33, available: -12.33, valuationUsd: -12.33 })]}
      closeState={{ onRequest: vi.fn(), isClosable: () => false, blockerFor: () => 'No spot market on this exchange to buy this debt back.', onExplain }} />);
    expect(html).toContain('short-tag">Short</small>');
    expect(html).toContain('How to repay');
    expect(html).toContain('No spot market on this exchange to buy this debt back.');
  });

  it('leaves no repayment route for a long that simply has no market, so the action stays disabled', () => {
    const html = render(<SpotHoldingsTable {...baseProps} rows={[row({ coin: 'PEPE', valuationUsd: null })]}
      closeState={{ onRequest: vi.fn(), isClosable: () => false, blockerFor: () => 'No tradable spot market for this balance.' }} />);
    expect(html).toContain('disabled');
    expect(html).not.toContain('How to repay');
  });

  it('renders the venue per row so the same coin can appear on two exchanges', () => {
    const html = render(<SpotHoldingsTable {...baseProps} rows={[row(), row({ venue: 'BINANCE', coin: 'BTC' })]} />);
    expect((html.match(/₿ BTC/g) ?? []).length).toBe(2);
  });

  it('prefixes valuations with $ and renders — for rows without a market quote', () => {
    const html = render(<SpotHoldingsTable {...baseProps} rows={[
      row({ coin: 'BTC', valuationUsd: 31_000 }),
      row({ coin: 'PEPE', valuationUsd: null }),
    ]} />);
    expect(html).toContain('$31,000');
    expect(html).toContain('<td>—</td>');
  });

  it('renders a zero lock as 0 rather than a dash', () => {
    const html = render(<SpotHoldingsTable {...baseProps} rows={[row({ locked: 0, valuationUsd: null })]} />);
    expect(html).toContain('<td>0</td>');
  });

  it('keeps dust precision so sub-1 holdings stay visible', () => {
    const html = render(<SpotHoldingsTable {...baseProps} rows={[row({ coin: 'BTC', total: 0.000123, available: 0.000123, valuationUsd: 0.007626 })]} />);
    expect(html).toContain('0.000123');
  });

  it('only paginates beyond the ten-row page', () => {
    // The shared pager hides below the page size (exactly 10 rows still shows it, as everywhere).
    const nineRows = Array.from({ length: 9 }, (_, index) => row({ coin: `C${index}` }));
    expect(render(<SpotHoldingsTable {...baseProps} rows={nineRows} />)).not.toContain('page-range');

    const elevenRows = Array.from({ length: 11 }, (_, index) => row({ coin: `C${index}` }));
    const paged = render(<SpotHoldingsTable {...baseProps} rows={elevenRows} />);
    expect(paged).toContain('1–10 / 11');
    expect(paged).toContain('Page 1 / 2');
  });
});
