import type { StrategyRecord } from './api.js';
import type { FrontendQuery, StrategyRouteKind } from './frontend-routes.js';

/**
 * One-click "copy this strategy and launch it again".
 *
 * A stored strategy is turned into the prefill query the *target form* already understands, so the
 * operator lands on a populated form and still has to press Launch themselves. The mapping is a
 * plain string pass-through with **no** validation on purpose: the forms' own guards
 * (`queryDecimal` / `queryVenueId` / `queryProduct`) decide what is usable and fall back to their
 * documented defaults, which keeps this file free of backend schema knowledge and impossible to
 * desync from `StrategyConfigSchema` field-by-field.
 *
 * An unknown `kind` must never throw — the Boros page is the fallback so the operator still gets a
 * defined destination.
 */

/** Which strategy page a stored record belongs to; anything unrecognized opens the Boros page. */
export function strategyRouteKind(kind: StrategyRecord['kind']): StrategyRouteKind {
  if (kind === 'position' || kind === 'auto' || kind === 'premium' || kind === 'carry') return kind;
  return 'boros';
}

/** Render one config value as a query string; blank and absent values are dropped, never sent empty. */
function parameter(value: string | number | boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const rendered = String(value).trim();
  return rendered === '' ? null : rendered;
}

function assign(
  query: FrontendQuery,
  key: string,
  value: string | number | boolean | null | undefined,
): void {
  const rendered = parameter(value);
  if (rendered !== null) query[key] = rendered;
}

/** `spot` only when the explicit leg symbol is a spot market; otherwise the form keeps perpetual. */
function productFromSymbol(symbol: string | undefined): 'spot' | null {
  if (!symbol) return null;
  return symbol.includes('_SPOT_') ? 'spot' : null;
}

/**
 * Remount key for a strategy page, derived from its prefill-bearing query parameters.
 *
 * The four strategy views parse `window.location.search` in `useState` **mount initializers**,
 * which run only on mount. Clicking 复制 on the history row of the page you are already standing
 * on navigates to the *same* kind and the *same* path, so React reuses the mounted component
 * instance, the initializers never re-run, and the prefill silently does nothing. Keying the view
 * element on the prefill parameters forces a remount exactly when that intent changes.
 *
 * `copyStrategyId` takes priority over `strategyId`: a copy has to reload the whole form, while
 * `strategyId` only opens the read-only detail dialog, so if both ever travel together the copy is
 * the stronger intent and must win. Any other navigation (no query, or a query carrying neither)
 * keeps the stable `'default'` key, so ordinary page switches never remount.
 */
export function strategyPrefillKey(query?: FrontendQuery | null): string {
  return query?.copyStrategyId ?? query?.strategyId ?? 'default';
}

/**
 * Remount key for a strategy view. A copy launched from the open config dialog keeps the same
 * `strategyId`/`copyStrategyId`, so the id alone is not enough to remount the form; the caller
 * bumps `copyRevision` for every copy action to make the prefill initializers run again.
 */
export function strategyRemountKey(query?: FrontendQuery | null, copyRevision = 0): string {
  return `${strategyPrefillKey(query)}:${copyRevision}`;
}

/**
 * Build the prefill query for a copy of `strategy`.
 *
 * Keys are emitted for every form family at once — the auto/position form reads `left`/`right`,
 * the carry form reads `leftVenue`/`rightVenue`, and the premium form reads `leftVenue`/`rightVenue`
 * plus `entryPremiumPct`/`hedgeMode` — which is safe because each form ignores the parameters it
 * does not know. `copyStrategyId` is what makes the target page show its "prefilled from strategy
 * X" notice, and is also the remount key (see `strategyPrefillKey`).
 */
export function strategyCopyQuery(strategy: StrategyRecord): FrontendQuery {
  const config = strategy.config;
  const query: FrontendQuery = {};

  // Shared market identity. The leg sides are shared too: the premium form derives its
  // short/long direction from them, so a copied long strategy must not come back as a short one.
  assign(query, 'asset', config.asset);
  assign(query, 'hedgeAsset', config.hedgeAsset);
  assign(query, 'leftSide', config.leftSide);
  assign(query, 'rightSide', config.rightSide);

  // Auto / position form keys.
  assign(query, 'left', config.leftVenue);
  assign(query, 'right', config.rightVenue);
  assign(query, 'entryBps', config.entryBps);
  assign(query, 'takeProfitBps', config.takeProfitBps);
  assign(query, 'stopLossBps', config.stopLossBps);
  assign(query, 'addOnStepBps', config.addOnStepBps);
  assign(query, 'maxPosition', config.maxPosition);
  assign(query, 'totalAmount', config.totalAmount);
  assign(query, 'perOrderQuantity', config.perOrderQuantity);
  assign(query, 'leftLeverage', config.leftLeverage);
  assign(query, 'rightLeverage', config.rightLeverage);
  assign(query, 'executionMethod', config.executionMethod === 'MAKER_TAKER' ? 'maker' : 'taker');
  assign(query, 'makerLeg', config.makerLeg);
  assign(query, 'reduceOnly', config.reduceOnly);
  const leftProduct = productFromSymbol(config.leftSymbol);
  if (leftProduct !== null) assign(query, 'leftProduct', leftProduct);
  const rightProduct = productFromSymbol(config.rightSymbol);
  if (rightProduct !== null) assign(query, 'rightProduct', rightProduct);

  // Premium form keys. `leftVenue`/`rightVenue` and `leftLeverage`/`rightLeverage` already carry
  // the premium legs, because a premium record stores them as `left`/`right` too; only the hedge
  // sizing mode has no key yet.
  assign(query, 'entryPremiumPct', config.entryPremiumPct);
  assign(query, 'takeProfitPremiumPct', config.takeProfitPremiumPct);
  assign(query, 'adrRatio', config.adrRatio);
  assign(query, 'hedgeMode', config.hedgeMode);

  // Carry form keys: the venue ids plus the explicit leg symbols it locks.
  assign(query, 'leftVenue', config.leftVenue);
  assign(query, 'rightVenue', config.rightVenue);
  assign(query, 'leftSymbol', config.leftSymbol);
  assign(query, 'rightSymbol', config.rightSymbol);
  assign(query, 'direction', config.fundingDirection);
  assign(query, 'aprMin', config.fundingAprMin);

  // Marks the destination page so it can show what this prefill came from.
  assign(query, 'copyStrategyId', strategy.id);

  return query;
}
