import { describe, expect, it } from 'vitest';
import { rowClickOpensStrategy } from './strategy-route.js';

/**
 * Row-click hit test (0.3.3 需求 3).
 *
 * Clicking a strategy row opens its configuration detail — but the stop / resume / logs / copy
 * buttons and the inline take-profit editor live *inside* that row and must keep their own clicks.
 * The guard is duck-typed on `closest` so it can be unit-tested without a DOM; the browser's own
 * `Element.closest` does the traversal at runtime.
 */

function fakeTarget(closestReturns: Element | null) {
  const calls: string[] = [];
  const target = {
    closest(selector: string): Element | null {
      calls.push(selector);
      return closestReturns;
    },
  } as unknown as EventTarget;
  return { target, calls };
}

describe('rowClickOpensStrategy', () => {
  it('opens the row when the click did not land on an inner control', () => {
    const { target, calls } = fakeTarget(null);
    expect(rowClickOpensStrategy(target)).toBe(true);
    // The traversal must look for every kind of inner control the row contains.
    expect(calls).toEqual(['button, input, select, a, label']);
    for (const control of ['button', 'input', 'select', 'a', 'label']) {
      expect(calls[0]).toContain(control);
    }
  });

  it('leaves an inner control alone — stop / resume / logs / copy / take-profit editor', () => {
    const { target } = fakeTarget({ tagName: 'BUTTON' } as unknown as Element);
    expect(rowClickOpensStrategy(target)).toBe(false);
  });

  it('treats a target without `closest` (a text node, null, undefined) as a row click', () => {
    expect(rowClickOpensStrategy(null)).toBe(true);
    expect(rowClickOpensStrategy(undefined)).toBe(true);
    expect(rowClickOpensStrategy('text-node' as unknown as EventTarget)).toBe(true);
  });
});
