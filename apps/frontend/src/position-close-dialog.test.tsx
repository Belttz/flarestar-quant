import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { closeQuantityForPercentage } from './position-close.js';
import { PositionCloseDialog, type ClosePositionTarget } from './position-close-dialog.js';

/**
 * The contract-position close dialog submits `closeQuantityForPercentage(position, pct, lotSize)`
 * as a market reduce-only quantity (position-close-dialog.tsx:63). These cases pin the semantics
 * that path depends on: an exact lot multiple is preserved, a partial close is floored, and the
 * result can never exceed the held position (over-selling a contract position is a fund incident).
 */
describe('contract close quantity (shared close helper)', () => {
  it('preserves a lot-multiple position at 100% without changing magnitude', () => {
    // lot 0.001, position 0.250 -> 0.250 (already a lot multiple, only re-normalised).
    expect(closeQuantityForPercentage('0.250', 100, '0.001')).toBe('0.250');
  });

  it('floors a signed contract position to its lot at 100%', () => {
    // Signed short -33.5000 on lot 0.1 -> 33.5 (absolute, floored, never -33.5 or 33.5000).
    expect(closeQuantityForPercentage('-33.5000', 100, '0.1')).toBe('33.5');
  });

  it('scales partial closes and never exceeds the held position', () => {
    const positions: Array<[string, string]> = [['33.5000', '0.1'], ['0.250', '0.001'], ['-12.7', '0.1'], ['100', '1']];
    for (const [quantity, lot] of positions) {
      for (const percentage of [50, 33]) {
        const out = Number(closeQuantityForPercentage(quantity, percentage, lot));
        expect(Number.isFinite(out)).toBe(true);
        expect(out).toBeLessThanOrEqual(Math.abs(Number(quantity)));
      }
    }
  });

  it('never oversells across a contract (quantity, percentage, lot) sweep', () => {
    const quantities = ['0.250', '33.5000', '-33.5000', '12.7', '1', '100', '7.0000001', '0.001'];
    const percentages = [1, 33, 50, 99, 100, 100.5];
    const lots = ['1', '0.1', '0.01', '0.001', '0.0001'];
    const violations: string[] = [];
    for (const quantity of quantities) {
      for (const percentage of percentages) {
        for (const lot of lots) {
          const out = Number(closeQuantityForPercentage(quantity, percentage, lot));
          if (!Number.isFinite(out)) { violations.push(`${quantity}/${percentage}/${lot} -> non-finite`); continue; }
          if (out > Math.abs(Number(quantity))) violations.push(`${quantity}/${percentage}/${lot} -> ${out}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('is total on illegal input: no throw and no NaN/Infinity', () => {
    const cases: Array<[string, number, string | null]> = [
      ['abc', 100, '0.1'], ['', 100, '0.1'], ['0', 100, '0.1'], ['-5', 100, '0.1'],
      ['33.5', -25, '0.1'], ['33.5', 0, '0.1'], ['33.5', 100, null], ['33.5', 100, ''],
      ['33.5', 100, '0'], ['33.5', 100, 'abc'],
    ];
    for (const [quantity, percentage, lot] of cases) {
      let out = '';
      expect(() => { out = closeQuantityForPercentage(quantity, percentage, lot); }).not.toThrow();
      expect(out).not.toMatch(/NaN|Infinity|undefined/);
      expect(Number.isFinite(Number(out))).toBe(true);
    }
  });
});

describe('PositionCloseDialog SSR', () => {
  function target(overrides: Partial<ClosePositionTarget> = {}): ClosePositionTarget {
    return { id: 'p1', positionId: 'p1', symbol: 'GATE_FUTURE_BTC_USDT', quantity: '-0.250', markPrice: '60000', ...overrides };
  }

  function render(targets: ClosePositionTarget[], instruments: Parameters<typeof PositionCloseDialog>[0]['instruments']): string {
    return renderToStaticMarkup(
      <PositionCloseDialog targets={targets} portfolio={null} instruments={instruments}
        onDismiss={() => undefined} onCompleted={() => undefined} notify={() => undefined} />,
    );
  }

  it('renders the floored close size for a contract position', () => {
    const html = render([target()], null);
    expect(html).toContain('Confirm close position');
    // lot unknown -> raw magnitude 0.25 shown, never the signed -0.250.
    expect(html).toContain('0.25');
  });

  it('does not introduce aria-pressed anywhere in the dialog', () => {
    const html = render([target(), target({ id: 'p2', positionId: 'p2', quantity: '1.5' })], null);
    expect([...html.matchAll(/aria-pressed=/g)]).toHaveLength(0);
    expect(html).toContain('aria-modal="true"');
  });
});
