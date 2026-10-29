import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LanguageContext } from './i18n.js';
import { PositionsTable } from './positions-table.js';
import type { PositionTableRow } from './strategy-positions.js';

function row(overrides: Partial<PositionTableRow>): PositionTableRow {
  return {
    id: 'position',
    positionId: 'position',
    symbol: 'BYBIT_FUTURE_HYPE_USDT',
    venue: 'BYBIT',
    asset: 'HYPE',
    quote: 'USDT',
    side: 'Long',
    quantity: 10,
    value: 520,
    entryPrice: 51,
    markPrice: 52,
    leverage: '5',
    unrealizedPnl: 10,
    realizedPnl: 2,
    fundingFee: -0.4,
    crossExAdlRank: '2',
    exchangeAdlRank: '1',
    ...overrides,
  };
}

describe('shared positions table', () => {
  it('renders the trading-page columns and grouped close action', () => {
    const html = renderToStaticMarkup(
      <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
        <PositionsTable rows={[
          row({ id: 'long' }),
          row({
            id: 'short', positionId: 'short', symbol: 'DERIBIT_FUTURE_HYPE_USDC', venue: 'DERIBIT',
            quote: 'USDC', side: 'Short', quantity: -10, value: 515, entryPrice: 52, markPrice: 51.5,
          }),
        ]} onClose={vi.fn()} />
      </LanguageContext.Provider>,
    );

    expect(html).toContain('Position notional');
    expect(html).toContain('ADL indicator');
    expect(html).toContain('Realized PnL');
    expect(html).toContain('Funding fee');
    expect(html).toContain('HYPE/USDT PERP');
    expect(html).toContain('Close all');
    expect(html).not.toContain('<th>Leverage</th>');
  });
});
