/**
 * Derived arithmetic for an auto strategy's stop-loss buffer and its optional add-on ladder.
 *
 * Two facts drive this module (design §5.10-5.12, §8.1, §8.6, §8.7):
 *   - The auto stop compares **absolute** spread levels, while entry only requires
 *     `spread >= entryBps` (no upper bound). A 65 bps entry under a 100 bps stop therefore
 *     absorbs only 100 − 65 = 35 bps of further adverse move. That difference *is* the
 *     operator's real tolerance, and it is what the UI has to surface.
 *   - With `addOnStepBps` set, one clip is admitted per `addOnStepBps` the gap advances past
 *     the entry level, so the reachable tiers are `sign(entryBps) * (|entryBps| + k * step)`
 *     while that magnitude stays strictly below the stop line. The rule is stateless — the
 *     backend derives `clipsPlaced` from `matched + inFlight` — so the preview can be recomputed
 *     from the form alone and survives a restart.
 *
 * Everything here is a pure function of the raw form strings so the arithmetic can be asserted
 * without a DOM; `strategy-route.tsx` only maps the returned fragments through `t()`.
 */

/** Upper bound on rendered tiers so a mistyped 0.0001 bps step cannot build an endless list. */
const MAX_RENDERED_TIERS = 64;

/** Float-noise tolerance: `4.5 / 1.5` must floor to 3, not 2, and 4500/1000 must stay 4. */
const CLIP_EPSILON = 1e-9;

/** Decimal count for rendered bps values (bps are quoted to two decimals at most). */
const BPS_DECIMALS = 2;

/** Scratch precision used before comparing magnitudes, well below the bps display precision. */
const TIDY_SCALE = 1e6;

const SIGNED_DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

/** The four raw form strings the ladder/buffer derivation needs, exactly as the operator typed them. */
export interface AutoThresholdDraft {
  /** Entry threshold in bps; auto accepts a signed value (negative = reverse the spread direction). */
  entryBps: string;
  /** Stop-loss threshold in bps; blank disables the stop. */
  stopLossBps: string;
  /** Add-on ladder step in bps; blank keeps today's tick-driven accumulation. */
  addOnStepBps: string;
  /** Maximum position, in base-asset units. */
  maxPosition: string;
  /** Per-order clip size, in base-asset units. */
  perOrderQuantity: string;
}

/** The stop's real tolerance: `stopLossBps - |entryBps|`, not `stopLossBps`. */
export interface AutoStopBuffer {
  entryBps: number;
  stopLossBps: number;
  bufferBps: number;
}

/** The reachable add-on tiers for a configured ladder. */
export interface AutoLadder {
  stepBps: number;
  /** Absolute spread levels of the reachable tiers, signed like `entryBps`. */
  levels: number[];
  /** How many clips the ladder admits once the binding cap is applied. */
  clipCount: number;
  /** The cap that actually limits the ladder: the stop line, the max position, or neither. */
  cap: 'stop' | 'position' | 'none';
}

/** Everything the auto form needs to render its threshold hints and to gate the launcher. */
export interface AutoThresholdView {
  entryBps: number | null;
  stopLossBps: number | null;
  addOnStepBps: number | null;
  /** Non-null only when both the entry and the stop parse as numbers. */
  stopBuffer: AutoStopBuffer | null;
  /** Both numbers are present but the stop leaves no room — the launcher must refuse. */
  stopLossTooClose: boolean;
  /** A step was typed but it is not a positive number. */
  addOnStepInvalid: boolean;
  /** A step was typed that pushes the first add-on tier to/over the stop line. */
  firstTierBeyondStop: boolean;
  /** Non-null only when the ladder is armed with a usable step. */
  ladder: AutoLadder | null;
  /** True when every threshold the operator typed parses and passes its own rule. */
  valid: boolean;
}

/** Parse a raw signed-decimal form value; blank or malformed yields `null`. */
function signedDecimal(text: string): number | null {
  const trimmed = text.trim();
  if (!SIGNED_DECIMAL_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Drop float noise so `35.000000000000004` compares and renders as `35`. */
function tidy(value: number): number {
  return Math.round(value * TIDY_SCALE) / TIDY_SCALE;
}

/** Render a bps value without trailing float noise: `35`, `0.4`, `-6.25`. */
export function formatBps(value: number): string {
  const rounded = Math.round(value * 10 ** BPS_DECIMALS) / 10 ** BPS_DECIMALS;
  return String(rounded);
}

/**
 * How many clips the engine will actually submit before `maxPosition` is filled; `null` when the
 * sizes are unknown/unusable. Rounded **up** because the engine clips to `min(perOrder, capacity)`
 * and submits a final remainder, so 0.25 / 0.1 is three clips (0.1, 0.1, 0.05), not two.
 */
function clipCapacity(maxPosition: string, perOrderQuantity: string): number | null {
  const target = signedDecimal(maxPosition);
  const perOrder = signedDecimal(perOrderQuantity);
  if (target === null || perOrder === null) return null;
  if (target <= 0 || perOrder <= 0) return null;
  return Math.max(1, Math.ceil(target / perOrder - CLIP_EPSILON));
}

/**
 * The tier magnitudes reachable below the stop line: `|entryBps| + k * step` for
 * `k = 0, 1, 2, …` while the magnitude stays strictly below `stopLossBps`. A `null` stop
 * leaves the ladder uncapped (the position cap still applies).
 */
function reachableTierMagnitudes(entryBps: number, stepBps: number, stopLossBps: number | null): number[] {
  const magnitudes: number[] = [];
  for (let tier = 0; tier < MAX_RENDERED_TIERS; tier += 1) {
    const magnitude = Math.abs(entryBps) + tier * stepBps;
    if (stopLossBps !== null && magnitude >= stopLossBps) break;
    magnitudes.push(tidy(magnitude));
  }
  return magnitudes;
}

/**
 * Turn the raw auto-form threshold strings into the numbers the UI renders and validates.
 *
 * `addOnStepBps` is deliberately opt-in: when it is blank the returned `ladder` is `null` and
 * every gate stays open, which reproduces today's tick-driven accumulation for the live fleet.
 */
export function describeAutoThresholds(draft: AutoThresholdDraft): AutoThresholdView {
  const entryBps = signedDecimal(draft.entryBps);
  const stopLossBps = signedDecimal(draft.stopLossBps);
  const addOnStepBps = signedDecimal(draft.addOnStepBps);

  const stopBuffer = entryBps === null || stopLossBps === null
    ? null
    : {
      entryBps: tidy(entryBps),
      stopLossBps: tidy(stopLossBps),
      bufferBps: tidy(stopLossBps - Math.abs(entryBps)),
    };
  // `<= 0` means the stop line sits at or inside the entry level: the strategy would stop out on
  // its very own entry, so the configuration must never reach the backend.
  const stopLossTooClose = stopBuffer !== null && stopBuffer.bufferBps <= 0;
  // Non-blank but unusable text (`abc`, `1e3`, `+5`, `.5`, `1,5`) parses to `null` and would be
  // shipped to the backend as `NaN`, so it counts as invalid exactly like a non-positive number.
  // Blank stays valid: it is the documented way to keep today's tick-driven accumulation.
  const addOnStepInvalid = draft.addOnStepBps.trim() !== ''
    && (addOnStepBps === null || addOnStepBps <= 0);
  const firstTierBeyondStop = entryBps !== null && stopLossBps !== null && addOnStepBps !== null
    && addOnStepBps > 0
    && Math.abs(entryBps) + addOnStepBps >= stopLossBps;

  let ladder: AutoLadder | null = null;
  if (entryBps !== null && addOnStepBps !== null && addOnStepBps > 0) {
    const magnitudes = reachableTierMagnitudes(entryBps, addOnStepBps, stopLossBps);
    const positionCap = clipCapacity(draft.maxPosition, draft.perOrderQuantity);
    const clipCount = positionCap === null ? magnitudes.length : Math.min(magnitudes.length, positionCap);
    const direction = entryBps >= 0 ? 1 : -1;
    ladder = {
      stepBps: tidy(addOnStepBps),
      levels: magnitudes.slice(0, clipCount).map((magnitude) => tidy(direction * magnitude)),
      clipCount,
      cap: positionCap !== null && positionCap < magnitudes.length
        ? 'position'
        : stopLossBps === null ? 'none' : 'stop',
    };
  }

  const valid = !stopLossTooClose && !addOnStepInvalid && !firstTierBeyondStop;
  return {
    entryBps,
    stopLossBps,
    addOnStepBps,
    stopBuffer,
    stopLossTooClose,
    addOnStepInvalid,
    firstTierBeyondStop,
    ladder,
    valid,
  };
}

/** `"50 / 70 / 90"` — the reachable tier levels, signed like `entryBps`. */
export function formatTierLevels(ladder: AutoLadder): string {
  return ladder.levels.map(formatBps).join(' / ');
}
