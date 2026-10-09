import { describe, expect, it } from 'vitest';
import { closeQuantityForPercentage } from './position-close.js';

describe('position close quantity', () => {
  // The original contract asserted that a 100% close echoed the raw balance verbatim. That is
  // exactly the bug: a balance that is not a lot multiple (spot `55.12345678` on a lot of `1`)
  // was submitted as-is and Gate answered TRADE_ORDER_LOT_SIZE_ERROR. A 100% close must now be
  // floored to the lot size too; the intent below — never sell more than is held — is preserved.
  it('floors to the instrument lot size at 100 percent and never oversells', () => {
    // An exact lot multiple is preserved numerically (only reformatted), so 100% never exceeds the position.
    expect(closeQuantityForPercentage('-33.5000', 100, '0.1')).toBe('33.5');
    // A raw balance that is not a lot multiple must be floored, never submitted verbatim.
    expect(closeQuantityForPercentage('55.12345678', 100, '1')).toBe('55');
  });

  it('scales and rounds down to the instrument lot size', () => {
    expect(closeQuantityForPercentage('33.5', 50, '0.1')).toBe('16.7');
    expect(closeQuantityForPercentage('-250', 25, '1')).toBe('62');
  });

  it('returns zero when the percentage cannot produce a valid lot', () => {
    expect(closeQuantityForPercentage('1', 0, '1')).toBe('0');
    expect(closeQuantityForPercentage('1', 50, '1')).toBe('0');
  });
});


// The same helper backs the futures close dialog and the spot one-click close, so the contract is
// asserted once here for both: a close never asks for more than is held (overselling is a funding
// incident, not a display bug) and a malformed instrument never produces a NaN/Infinity amount.
describe('position close quantity invariants', () => {
  const lots = ['0.000001', '0.001', '0.01', '0.1', '1', '10', null, '', '0', 'abc'];
  const quantities = ['0.00000049', '0.25', '1', '33.5000', '55.12345678', '999.999', '12345.6789'];

  it('never asks to close more than the position, for any lot or percentage', () => {
    for (const quantity of quantities) {
      for (const lot of lots) {
        for (const percentage of [1, 25, 33, 50, 99, 100, 100.0001]) {
          const result = closeQuantityForPercentage(quantity, percentage, lot);
          const numeric = Number(result);
          expect(Number.isFinite(numeric), `${quantity}@${percentage}% lot=${lot} yielded ${result}`).toBe(true);
          expect(numeric, `${quantity}@${percentage}% lot=${lot} oversold`).toBeLessThanOrEqual(Number(quantity));
        }
      }
    }
  });

  it('keeps a lot-multiple futures position unchanged when closing in full', () => {
    expect(closeQuantityForPercentage('0.250', 100, '0.001')).toBe('0.250');
    expect(closeQuantityForPercentage('-33.5000', 100, '0.1')).toBe('33.5');
  });

  it('returns zero instead of a malformed amount for unusable input', () => {
    expect(closeQuantityForPercentage('abc', 100, '1')).toBe('0');
    expect(closeQuantityForPercentage('', 100, '1')).toBe('0');
    expect(closeQuantityForPercentage('10', -5, '1')).toBe('0');
    expect(closeQuantityForPercentage('10', Number.NaN, '1')).toBe('0');
  });
});
