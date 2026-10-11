import { describe, expect, it } from 'vitest';
import {
  describeAutoThresholds,
  formatBps,
  formatTierLevels,
  type AutoThresholdDraft,
} from './strategy-ladder.js';

/** The production configuration of `AUTO-1CCEAE53`: 65 bps entry under a 100 bps stop. */
function draft(overrides: Partial<AutoThresholdDraft> = {}): AutoThresholdDraft {
  return {
    entryBps: '65',
    stopLossBps: '100',
    addOnStepBps: '',
    maxPosition: '4500',
    perOrderQuantity: '1000',
    ...overrides,
  };
}

describe('effective stop buffer', () => {
  it('reports the real tolerance as stopLossBps − |entryBps|, not stopLossBps', () => {
    // The production instance: a 65 bps entry under a 100 bps stop only tolerates 35 bps.
    const view = describeAutoThresholds(draft());

    expect(view.entryBps).toBe(65);
    expect(view.stopLossBps).toBe(100);
    expect(view.stopBuffer).toEqual({ entryBps: 65, stopLossBps: 100, bufferBps: 35 });
  });

  it('recomputes live as the operator retypes the entry threshold', () => {
    expect(describeAutoThresholds(draft({ entryBps: '80' })).stopBuffer?.bufferBps).toBe(20);
    expect(describeAutoThresholds(draft({ entryBps: '0' })).stopBuffer?.bufferBps).toBe(100);
    expect(describeAutoThresholds(draft({ stopLossBps: '150' })).stopBuffer?.bufferBps).toBe(85);
  });

  it('mirrors a negative entry through the absolute entry level', () => {
    // entry −6 / stop 30: entry needs spread ≤ −6, the stop fires at ≤ −30 ⇒ 24 bps of room.
    expect(describeAutoThresholds(draft({ entryBps: '-6', stopLossBps: '30' })).stopBuffer?.bufferBps).toBe(24);
  });

  it('stays blank until both numbers parse, so an empty stop never reads as "0 bps"', () => {
    expect(describeAutoThresholds(draft({ stopLossBps: '' })).stopBuffer).toBeNull();
    expect(describeAutoThresholds(draft({ stopLossBps: '   ' })).stopBuffer).toBeNull();
    expect(describeAutoThresholds(draft({ entryBps: 'abc' })).stopBuffer).toBeNull();
    expect(describeAutoThresholds(draft({ stopLossBps: '1,5' })).stopBuffer).toBeNull();
  });

  it('survives float noise instead of rendering 34.999999999999993', () => {
    expect(describeAutoThresholds(draft({ entryBps: '65.1', stopLossBps: '100.1' })).stopBuffer?.bufferBps).toBe(35);
  });
});

describe('stop-loss gating (design B1)', () => {
  it('blocks launch when the stop sits exactly on the entry level', () => {
    const view = describeAutoThresholds(draft({ entryBps: '100', stopLossBps: '100' }));

    expect(view.stopLossTooClose).toBe(true);
    expect(view.valid).toBe(false);
  });

  it('blocks launch when the stop sits inside the entry level', () => {
    // An entry at 120 bps can never be opened without already breaching a 100 bps stop.
    const view = describeAutoThresholds(draft({ entryBps: '120', stopLossBps: '100' }));

    expect(view.stopLossTooClose).toBe(true);
    expect(view.valid).toBe(false);
  });

  it('accepts a stop that leaves any positive room', () => {
    const view = describeAutoThresholds(draft({ entryBps: '99.9', stopLossBps: '100' }));

    expect(view.stopLossTooClose).toBe(false);
    expect(view.valid).toBe(true);
  });

  it('leaves the gate open when the stop is disabled', () => {
    expect(describeAutoThresholds(draft({ stopLossBps: '' })).stopLossTooClose).toBe(false);
  });
});

describe('add-on ladder tiers (design §8.1, §8.7)', () => {
  it('builds the documented 50 / 70 / 90 ladder and counts 3 clips before the stop', () => {
    const view = describeAutoThresholds(draft({
      entryBps: '50',
      stopLossBps: '100',
      addOnStepBps: '20',
      maxPosition: '3000',
      perOrderQuantity: '1000',
    }));

    expect(view.ladder).not.toBeNull();
    expect(view.ladder?.levels).toEqual([50, 70, 90]);
    expect(view.ladder?.clipCount).toBe(3);
    expect(view.ladder?.cap).toBe('stop');
    expect(formatTierLevels(view.ladder!)).toBe('50 / 70 / 90');
  });

  it('excludes the tier that lands on the stop line, because the stop wins that tick', () => {
    // §8.2: at 100 bps `maybeTriggerAutoStopLoss` arms and returns before the entry branch,
    // so the 4th tier (110 bps) is never reachable.
    const view = describeAutoThresholds(draft({
      entryBps: '50',
      stopLossBps: '110',
      addOnStepBps: '20',
      maxPosition: '9000',
      perOrderQuantity: '1000',
    }));

    expect(view.ladder?.levels).toEqual([50, 70, 90]);
    expect(view.ladder?.clipCount).toBe(3);
  });

  it('mirrors a negative entry toward more-negative levels', () => {
    const view = describeAutoThresholds(draft({
      entryBps: '-6',
      stopLossBps: '30',
      addOnStepBps: '8',
      maxPosition: '4000',
      perOrderQuantity: '1000',
    }));

    expect(view.ladder?.levels).toEqual([-6, -14, -22]);
  });

  it('caps the ladder by max position when it binds before the stop line', () => {
    // 2 clips of 1000 fit into a 2000 max position, while the stop line would allow many more.
    const view = describeAutoThresholds(draft({
      entryBps: '50',
      stopLossBps: '1000',
      addOnStepBps: '20',
      maxPosition: '2000',
      perOrderQuantity: '1000',
    }));

    expect(view.ladder?.levels).toEqual([50, 70]);
    expect(view.ladder?.clipCount).toBe(2);
    expect(view.ladder?.cap).toBe('position');
  });

  it('keeps today\'s tick-driven accumulation when the step is blank', () => {
    const view = describeAutoThresholds(draft({ addOnStepBps: '' }));

    expect(view.ladder).toBeNull();
    expect(view.addOnStepInvalid).toBe(false);
    expect(view.firstTierBeyondStop).toBe(false);
    expect(view.valid).toBe(true);
  });

  it('rejects a zero or negative step', () => {
    expect(describeAutoThresholds(draft({ addOnStepBps: '0' })).addOnStepInvalid).toBe(true);
    expect(describeAutoThresholds(draft({ addOnStepBps: '-5' })).addOnStepInvalid).toBe(true);
    expect(describeAutoThresholds(draft({ addOnStepBps: '0' })).valid).toBe(false);
  });

  it('rejects a step whose first add-on tier reaches the stop line', () => {
    // §8.6: |entryBps| + step must stay strictly below stopLossBps.
    const beyond = describeAutoThresholds(draft({
      entryBps: '50', stopLossBps: '100', addOnStepBps: '50',
    }));
    expect(beyond.firstTierBeyondStop).toBe(true);
    expect(beyond.valid).toBe(false);

    const inside = describeAutoThresholds(draft({
      entryBps: '50', stopLossBps: '100', addOnStepBps: '49',
    }));
    expect(inside.firstTierBeyondStop).toBe(false);
    expect(inside.valid).toBe(true);
  });

  it('rejects unparseable step text instead of shipping NaN to the backend', () => {
    // `Number('abc')` is `NaN`, which JSON-serialises to `null`; `1e3` / `+5` / `.5` / `1,5` all
    // fail the signed-decimal pattern too. Blank stays valid — it is how tick-driven accumulation
    // is kept — so only non-blank unusable text may gate the launcher.
    for (const text of ['abc', '1e3', '+5', '.5', '1,5']) {
      const view = describeAutoThresholds(draft({ addOnStepBps: text }));
      expect(view.addOnStepBps, text).toBeNull();
      expect(view.addOnStepInvalid, text).toBe(true);
      expect(view.valid, text).toBe(false);
    }
    expect(describeAutoThresholds(draft({ addOnStepBps: '   ' })).addOnStepInvalid).toBe(false);
  });

  it('counts the remainder clip when max position is not a whole multiple of the clip', () => {
    // The engine clips to `min(perOrder, capacity)`, so 0.25 / 0.1 submits 0.1, 0.1, 0.05.
    const view = describeAutoThresholds(draft({
      entryBps: '50', stopLossBps: '1000', addOnStepBps: '20',
      maxPosition: '0.25', perOrderQuantity: '0.1',
    }));
    expect(view.ladder?.clipCount).toBe(3);
    expect(view.ladder?.cap).toBe('position');
  });

  it('leaves an unarmed ladder untouched by an unparseable stop', () => {
    const view = describeAutoThresholds(draft({ stopLossBps: 'x', addOnStepBps: '20' }));
    expect(view.stopBuffer).toBeNull();
    expect(view.firstTierBeyondStop).toBe(false);
  });
});

describe('bps formatting', () => {
  it('renders whole numbers without decimals and trims float noise', () => {
    expect(formatBps(35)).toBe('35');
    expect(formatBps(0.4)).toBe('0.4');
    expect(formatBps(-6.25)).toBe('-6.25');
    expect(formatBps(34.999999999999993)).toBe('35');
  });
});
