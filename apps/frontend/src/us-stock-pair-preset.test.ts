import { describe, expect, it } from 'vitest';
import {
  PAIR_PRESET_STORAGE_KEY,
  availablePresetStorage,
  parseStoredPairPresets,
  readPairPresets,
  serializePairPresets,
  withPairPreset,
  withoutPairPreset,
  writePairPresets,
  type PairExecutionPreset,
  type PresetStorage,
} from './us-stock-pair-preset.js';

/**
 * The preset store carries the fields the backend's `SavedStrategyPair` record cannot hold (size,
 * per-leg leverage, take-profit, stop-loss, reduce-only). It reads `localStorage`, which is
 * user-editable and survives app versions, so the parse side is the part with teeth: one corrupt or
 * hand-edited row must degrade to "no preset", never to a crash or an injected value.
 */

function preset(overrides: Partial<PairExecutionPreset> = {}): PairExecutionPreset {
  return {
    entryBps: '20',
    takeProfitBps: '12',
    stopLossBps: '80',
    totalAmount: '100',
    perOrderQuantity: '25',
    maxPosition: '100',
    ratio: '0.951991',
    leftLeverage: '3',
    rightLeverage: '5',
    reduceOnly: false,
    ...overrides,
  };
}

function memoryStorage(initial: string | null = null): PresetStorage & { value: string | null } {
  return {
    value: initial,
    getItem(key: string) { return key === PAIR_PRESET_STORAGE_KEY ? this.value : null; },
    setItem(key: string, value: string) {
      if (key === PAIR_PRESET_STORAGE_KEY) this.value = value;
    },
  };
}

describe('pair execution preset storage', () => {
  it('round-trips a preset through the stored JSON', () => {
    const presets = withPairPreset({}, 'SNDK / SNXX', preset());
    const parsed = parseStoredPairPresets(serializePairPresets(presets));
    expect(parsed['SNDK / SNXX']).toEqual(preset());
  });

  it('treats missing, empty and non-JSON storage as "no presets"', () => {
    expect(parseStoredPairPresets(null)).toEqual({});
    expect(parseStoredPairPresets('   ')).toEqual({});
    expect(parseStoredPairPresets('not json')).toEqual({});
    expect(parseStoredPairPresets('[]')).toEqual({});
    expect(parseStoredPairPresets('null')).toEqual({});
  });

  it('drops non-decimal numbers instead of feeding them to an input', () => {
    const parsed = parseStoredPairPresets(JSON.stringify({
      'p': { ...preset(), totalAmount: '1e9', entryBps: { nested: true }, leftLeverage: '  7  ', reduceOnly: 'yes' },
    }));
    expect(parsed.p?.totalAmount).toBe('');
    expect(parsed.p?.entryBps).toBe('');
    // Whitespace is trimmed, a valid decimal survives, and only a real boolean turns the flag on.
    expect(parsed.p?.leftLeverage).toBe('7');
    expect(parsed.p?.reduceOnly).toBe(false);
  });

  it('keeps unknown extra keys out of the preset', () => {
    const parsed = parseStoredPairPresets(JSON.stringify({ p: { ...preset(), injected: 'x' } }));
    expect(Object.keys(parsed.p ?? {})).not.toContain('injected');
  });

  it('overwrites by name and removes the preset when the pair is deleted', () => {
    const first = withPairPreset({}, 'pair', preset());
    const overwritten = withPairPreset(first, 'pair', preset({ totalAmount: '250' }));
    expect(overwritten.pair?.totalAmount).toBe('250');
    expect(withoutPairPreset(overwritten, 'pair')).toEqual({});
    // Removing an unknown name is a no-op rather than an error.
    expect(withoutPairPreset({}, 'ghost')).toEqual({});
  });

  it('reads and writes through a storage stub and survives a throwing storage', () => {
    const storage = memoryStorage();
    writePairPresets(storage, withPairPreset({}, 'pair', preset()));
    expect(readPairPresets(storage).pair?.entryBps).toBe('20');

    const broken: PresetStorage = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('quota'); },
    };
    expect(readPairPresets(broken)).toEqual({});
    expect(() => writePairPresets(broken, {})).not.toThrow();
    expect(readPairPresets(null)).toEqual({});
    expect(() => writePairPresets(null, {})).not.toThrow();
  });

  it('reports no browser storage outside a browser', () => {
    // Vitest runs in a node environment here, so the SSR path is the live one.
    expect(availablePresetStorage()).toBeNull();
  });
});
