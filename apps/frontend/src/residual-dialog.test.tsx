import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ResidualReport } from './api.js';
import { LanguageContext } from './i18n.js';
import { ResidualDialog } from './residual-dialog.js';

function report(overrides: Partial<ResidualReport> = {}): ResidualReport {
  return {
    clean: false,
    fetchedAt: '2026-08-01T00:00:00.000Z',
    residuals: [
      {
        symbol: 'OKX_FUTURE_X_USDT', venue: 'OKX', marketType: 'PERP',
        residualQuantity: '0.04', reason: 'Reduce-only rejected: the venue held less', suggestion: 'Close manually at the venue size',
      },
      {
        symbol: 'GATE_SPOT_Y_USDT', venue: 'GATE', marketType: 'SPOT',
        residualQuantity: '1.5', reason: 'Spot sell rejected: balance locked', suggestion: 'Unlock the balance or transfer the coin in',
      },
    ],
    ...overrides,
  };
}

function render(ui: React.ReactNode): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
      {ui}
    </LanguageContext.Provider>,
  );
}

describe('ResidualDialog', () => {
  it('lists every residual leg with its quantity, reason and suggestion', () => {
    const html = render(<ResidualDialog report={report()} onDismiss={vi.fn()} />);
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Positions could not be fully closed');
    expect(html).toContain('OKX_FUTURE_X_USDT');
    expect(html).toContain('0.04');
    expect(html).toContain('Reduce-only rejected: the venue held less');
    expect(html).toContain('GATE_SPOT_Y_USDT');
    expect(html).toContain('1.5');
    // The terminal never auto-liquidates dust (PRD Q2) — the dialog says so.
    expect(html).toContain('never auto-liquidates dust');
    expect(html).toContain('Got it');
  });

  it('renders a single residual without pluralising wrongly', () => {
    const single = render(<ResidualDialog report={report({ residuals: report().residuals.slice(0, 1) })} onDismiss={vi.fn()} />);
    expect(single).toContain('1 residual position');
  });
});
