import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FillCards, OrderCards, OrderTable } from './execution-tables.js';
import { LanguageContext } from './i18n.js';
import type { ExecutionFill, ExecutionOrder } from './api.js';

function order(overrides: Partial<ExecutionOrder> & { id: string; symbol: string }): ExecutionOrder {
  return {
    remoteOrderId: null, clientOrderId: `client-${overrides.id}`, venue: 'GATE', side: 'BUY', type: 'LIMIT',
    timeInForce: 'GTC', quantity: '0.5', price: '62000', reduceOnly: false, state: 'OPEN', executedQuantity: '0',
    executedAveragePrice: null, strategyId: null, strategyLeg: null, createdAt: '2026-09-01T12:34:56.000Z',
    updatedAt: '2026-09-01T12:34:56.000Z',
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

const baseProps = { page: 1, onPageChange: vi.fn(), onCancel: vi.fn().mockResolvedValue(undefined), busyOrderIds: [] as string[] };

describe('OrderTable', () => {
  it('keeps the migrated perpetual default rendering byte-comparable with the legacy grid', () => {
    const html = render(<OrderTable {...baseProps} orders={[order({ id: 'a', symbol: 'GATE_FUTURE_BTC_USDT' })]} />);
    expect(html).toContain('>Contract</th>');
    expect(html).toContain('BTCUSDT');
    expect(html).not.toContain('BTC/USDT');
    expect(html).toContain('Side / Type');
    expect(html).toContain('status-tag open');
    expect(html).toContain('client-a');
  });

  it('switches to the Market header and pair display for spot product', () => {
    const html = render(<OrderTable {...baseProps} product="spot" orders={[order({ id: 'a', symbol: 'GATE_SPOT_BTC_USDT' })]} />);
    expect(html).toContain('>Market</th>');
    expect(html).toContain('BTC/USDT');
    expect(html).not.toContain('>Contract</th>');
  });

  it('renders the cancel button on every row when cancellable has no row-level verdict', () => {
    const html = render(<OrderTable {...baseProps} cancellable orders={[
      order({ id: 'a', symbol: 'GATE_FUTURE_BTC_USDT', state: 'OPEN' }),
      order({ id: 'b', symbol: 'GATE_FUTURE_BTC_USDT', state: 'PENDING_SUBMIT' }),
    ]} />);
    expect(html).toMatch(/>Cancel</g);
    expect(html.match(/>Cancel</g)).toHaveLength(2);
  });

  it('shows the cancel button only on rows passing the row-level verdict', () => {
    const html = render(<OrderTable {...baseProps} cancellable cancellableFor={(item) => item.state === 'OPEN'} orders={[
      order({ id: 'a', symbol: 'GATE_FUTURE_BTC_USDT', state: 'OPEN' }),
      order({ id: 'b', symbol: 'GATE_FUTURE_BTC_USDT', state: 'FILLED' }),
    ]} />);
    expect(html.match(/>Cancel</g)).toHaveLength(1);
    expect(html).toContain('status-tag filled');
  });

  it('locks a busy row into the cancelling state without affecting other rows', () => {
    const html = render(<OrderTable {...baseProps} cancellable busyOrderIds={['a']} orders={[
      order({ id: 'a', symbol: 'GATE_FUTURE_BTC_USDT' }),
      order({ id: 'b', symbol: 'GATE_FUTURE_BTC_USDT' }),
    ]} />);
    expect(html).toContain('Cancelling…');
    expect(html).toContain('disabled');
    expect(html.match(/>Cancel</g)).toHaveLength(1);
  });

  it('hides the cancel column entirely without the cancellable switch', () => {
    const html = render(<OrderTable {...baseProps} orders={[order({ id: 'a', symbol: 'GATE_FUTURE_BTC_USDT' })]} />);
    expect(html).not.toContain('row-action');
  });
});

describe('phone execution cards', () => {
  it('renders an order card with the full pair, venue, amount and cancel action', () => {
    const html = render(<OrderCards orders={[order({ id: 'a', symbol: 'GATE_FUTURE_CLO_USDT', quantity: '12' })]} cancellable onCancel={baseProps.onCancel} busyOrderIds={[]} />);
    expect(html).toContain('execution-mobile-cards');
    expect(html).toContain('CLO/USDT PERP');
    expect(html).toContain('Gate.io');
    expect(html).toContain('<dt>Amount</dt><dd>12 CLO</dd>');
    expect(html).toContain('>Cancel<');
    expect(html).toContain('client-a');
  });

  it('renders a spot order card without the PERP suffix and without an empty action row', () => {
    const html = render(<OrderCards orders={[order({ id: 'a', symbol: 'GATE_SPOT_BTC_USDT' })]} product="spot" onCancel={baseProps.onCancel} busyOrderIds={[]} />);
    expect(html).toContain('BTC/USDT');
    expect(html).not.toContain('BTC/USDT PERP');
    expect(html).not.toContain('row-action');
  });

  it('renders a fill card with execution price, fee and realized PnL', () => {
    const fill: ExecutionFill = {
      id: 'fill-abcdef123456', order_id: 'order-a', symbol: 'GATE_FUTURE_CLO_USDT', venue: 'GATE',
      side: 'SELL', quantity: '12', price: '41.2', fee: '0.14', realized_pnl: '12.5',
      created_at: '2026-09-01T12:34:56.000Z',
    };
    const html = render(<FillCards fills={[fill]} />);
    expect(html).toContain('CLO/USDT PERP');
    expect(html).toContain('Gate.io');
    expect(html).toContain('<dt>Execution price</dt><dd>41.2</dd>');
    expect(html).toContain('<dt>Size</dt><dd>12 CLO</dd>');
    expect(html).toContain('<dt>Fee</dt><dd>0.1400</dd>');
    expect(html).toContain('<dd>12.50</dd>');
    expect(html).toContain('fill-abcdef1');
  });
});
