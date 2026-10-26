/**
 * Per-pair execution preset for the US-stock spread page.
 *
 * Why this exists: the backend's `SavedStrategyPair` record only stores `name`, `leftSymbol`,
 * `rightSymbol`, `ratio` and `entryBps` — that contract is frozen. Size, per-leg leverage,
 * take-profit, stop-loss and reduce-only therefore have nowhere to live server-side, so they are
 * kept locally, keyed by the pair *name* (the same identity the backend overwrites by). Loading a
 * saved pair restores every field on this browser; a pair saved on another machine loads with the
 * server-side fields plus empty size fields.
 *
 * `localStorage` is user-editable and can outlive an application version, so everything read back
 * is treated as untrusted: unknown keys are dropped, numbers must look like decimals, and a corrupt
 * row must never stop the page from rendering.
 */

export interface PairExecutionPreset {
  entryBps: string;
  takeProfitBps: string;
  stopLossBps: string;
  totalAmount: string;
  perOrderQuantity: string;
  maxPosition: string;
  ratio: string;
  leftLeverage: string;
  rightLeverage: string;
  reduceOnly: boolean;
}

/** Bumped when the shape changes; an old key is simply ignored rather than migrated. */
export const PAIR_PRESET_STORAGE_KEY = 'flarestar.us-stock-pair-presets.v1';

const DECIMAL_TEXT = /^-?\d+(?:\.\d+)?$/;

/** Keep a decimal string as typed (so "20." stays editable), or fall back to empty. */
function decimalOrEmpty(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed === '' || DECIMAL_TEXT.test(trimmed) ? trimmed : '';
}

function presetFrom(value: unknown): PairExecutionPreset | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    entryBps: decimalOrEmpty(record.entryBps),
    takeProfitBps: decimalOrEmpty(record.takeProfitBps),
    stopLossBps: decimalOrEmpty(record.stopLossBps),
    totalAmount: decimalOrEmpty(record.totalAmount),
    perOrderQuantity: decimalOrEmpty(record.perOrderQuantity),
    maxPosition: decimalOrEmpty(record.maxPosition),
    ratio: decimalOrEmpty(record.ratio),
    leftLeverage: decimalOrEmpty(record.leftLeverage),
    rightLeverage: decimalOrEmpty(record.rightLeverage),
    reduceOnly: record.reduceOnly === true,
  };
}

/** Parse the stored map; anything malformed is dropped entry by entry. */
export function parseStoredPairPresets(value: string | null): Record<string, PairExecutionPreset> {
  if (value === null || value.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const presets: Record<string, PairExecutionPreset> = {};
  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (name.trim() === '') continue;
    const preset = presetFrom(entry);
    if (preset !== null) presets[name] = preset;
  }
  return presets;
}

export function serializePairPresets(presets: Record<string, PairExecutionPreset>): string {
  return JSON.stringify(presets);
}

/** Return a new map with `name` replaced — the same overwrite semantics as the backend save. */
export function withPairPreset(
  current: Record<string, PairExecutionPreset>,
  name: string,
  preset: PairExecutionPreset,
): Record<string, PairExecutionPreset> {
  return { ...current, [name]: preset };
}

/** Return a new map without `name`; deleting a pair must not leave its preset behind. */
export function withoutPairPreset(
  current: Record<string, PairExecutionPreset>,
  name: string,
): Record<string, PairExecutionPreset> {
  const next = { ...current };
  delete next[name];
  return next;
}

/** The subset of `Storage` this module needs, so tests can pass a plain stub. */
export interface PresetStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** `window.localStorage`, or `null` during SSR / when storage is blocked (private mode). */
export function availablePresetStorage(): PresetStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readPairPresets(storage: PresetStorage | null): Record<string, PairExecutionPreset> {
  if (storage === null) return {};
  try {
    return parseStoredPairPresets(storage.getItem(PAIR_PRESET_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function writePairPresets(
  storage: PresetStorage | null,
  presets: Record<string, PairExecutionPreset>,
): void {
  if (storage === null) return;
  try {
    storage.setItem(PAIR_PRESET_STORAGE_KEY, serializePairPresets(presets));
  } catch {
    // Quota exceeded or storage disabled: the preset is a convenience, never a requirement.
  }
}
