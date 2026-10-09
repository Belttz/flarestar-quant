import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SpotHoldingsRow } from './execution-split.js';
import { LanguageContext } from './i18n.js';
import { SpotDebtDialog } from './spot-debt-dialog.js';

/**
 * The trade page's spot-holdings tab shows debts whose exchange lists no market to buy them back on
 * (HYPERLIQUID auto-borrows USDC for its perp margin and runs no spot business). These cases pin
 * the two routes the dialog must name, so a dead button never comes back.
 */
function row(overrides: Partial<SpotHoldingsRow> = {}): SpotHoldingsRow {
  return { venue: 'HYPERLIQUID', coin: 'USDC', total: -12.326910255, available: -12.326910255, locked: 0, valuationUsd: -12.33, ...overrides };
}

function render(ui: React.ReactNode): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
      {ui}
    </LanguageContext.Provider>,
  );
}

describe('SpotDebtDialog', () => {
  it('states the debt and both repayment routes', () => {
    const html = render(<SpotDebtDialog row={row()} contracts={[{ symbol: 'HYPERLIQUID_FUTURE_GIGADEV_USDC', quantity: '0.25' }]} onDismiss={vi.fn()} />);
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('USDC · HYPERLIQUID');
    expect(html).toContain('>12.33 USDC<');
    expect(html).toContain('>-12.33 USDC<');
    expect(html).toContain('-$12.33');
    expect(html).toContain('Close contracts on this exchange');
    expect(html).toContain('GIGADEV 0.25');
    expect(html).toContain('Transfer the coin in');
    expect(html).toContain('Got it');
  });

  it('lists every contract on the same exchange, and hides the list when there is none', () => {
    const withContracts = render(<SpotDebtDialog row={row()} contracts={[
      { symbol: 'HYPERLIQUID_FUTURE_GIGADEV_USDC', quantity: '0.25' },
      { symbol: 'HYPERLIQUID_FUTURE_SKHY_USDC', quantity: '-0.1' },
    ]} onDismiss={vi.fn()} />);
    expect(withContracts).toContain('GIGADEV 0.25');
    expect(withContracts).toContain('SKHY -0.1');

    const withoutContracts = render(<SpotDebtDialog row={row()} contracts={[]} onDismiss={vi.fn()} />);
    expect(withoutContracts).toContain('Bottom tabs: Contract → Positions');
    expect(withoutContracts).not.toContain('debt-repay-contracts');
  });

  it('still reports the valuation as unknown instead of faking a zero', () => {
    const html = render(<SpotDebtDialog row={row({ valuationUsd: null })} contracts={[]} onDismiss={vi.fn()} />);
    expect(html).toContain('>—<');
  });
});
