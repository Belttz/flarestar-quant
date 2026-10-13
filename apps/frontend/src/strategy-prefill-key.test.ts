import { describe, expect, it } from 'vitest';
import { strategyPrefillKey } from './strategy-copy.js';

/**
 * Remount key for the strategy views (0.3.3 需求 4).
 *
 * The forms parse `window.location.search` inside `useState` mount initializers, which never re-run
 * when React reuses a mounted component instance — so navigating to the same strategy kind with a
 * different prefill would silently keep the old form. `App.tsx` keys each strategy view on this
 * value, which forces the remount that makes the prefill actually happen.
 */

describe('strategyPrefillKey', () => {
  it('keeps the stable default key when there is no prefill at all', () => {
    expect(strategyPrefillKey()).toBe('default');
    expect(strategyPrefillKey(null)).toBe('default');
    expect(strategyPrefillKey({})).toBe('default');
    // A query that carries only unrelated parameters must not remount either.
    expect(strategyPrefillKey({ asset: 'BTC', entryBps: '8' })).toBe('default');
  });

  it('keys on the copied strategy id so a copy always remounts', () => {
    expect(strategyPrefillKey({ copyStrategyId: 'AUTO-COPY01' })).toBe('AUTO-COPY01');
    expect(strategyPrefillKey({ copyStrategyId: 'AUTO-COPY01', asset: 'BTC' })).toBe('AUTO-COPY01');
  });

  it('keys on the deep-linked strategy id so a detail link remounts too', () => {
    expect(strategyPrefillKey({ strategyId: 'PAIR-01' })).toBe('PAIR-01');
  });

  it('prefers copyStrategyId over strategyId when both are present', () => {
    // Priority is deliberate: a copy has to reload the whole form, while `strategyId` only opens the
    // read-only detail dialog. If both ever travel together the copy is the stronger intent, and it
    // must also be the one that changes the key — keying on `strategyId` alone would make a second
    // copy of the same strategy a no-op.
    const both = { copyStrategyId: 'AUTO-COPY02', strategyId: 'PAIR-02' };
    expect(strategyPrefillKey(both)).toBe('AUTO-COPY02');
    expect(strategyPrefillKey({ strategyId: 'PAIR-02', copyStrategyId: 'AUTO-COPY02' })).toBe('AUTO-COPY02');
  });

  it('gives a different key for a different copy target', () => {
    expect(strategyPrefillKey({ copyStrategyId: 'A' })).not.toBe(strategyPrefillKey({ copyStrategyId: 'B' }));
  });
});
