import { Decimal } from 'decimal.js';
import type { StrategyPnl } from '@gate-crossex/shared-types';

/**
 * Rebuilds a strategy's profit and loss from its own fills with a moving weighted-average cost
 * basis, one position stream per traded symbol.
 *
 * ## Null means "not available", never zero
 * Every nullable field distinguishes *unknown* from *zero*. A missing mark price yields
 * `unrealizedPnl = null` (and therefore `netPnl = null`) rather than pretending the position is
 * worth nothing; a funding charge that cannot be attributed to this strategy alone yields
 * `fundingFeeUsdt = null`. The UI renders a dash for null. `fundingFeeUsdt === null` is counted as
 * `0` *inside* the `netPnl` arithmetic so the figure still exists, which slightly understates the
 * cost — callers must explain that in the UI.
 *
 * ## Fee sign
 * Every venue stores `execution_fills.fee` as a POSITIVE cost (verified against all five
 * venues' live fills, e.g. `GATE_FUTURE_CXMT_USDT BUY 1 @7.617 fee 0.00365616` = notional × 4.8
 * bps). Fees are therefore summed as-is: `feesPaid = Σ fee`. An exchange that ever reports a
 * rebate as a negative fee flows through unchanged, so no `abs()` and no sign flip is applied.
 *
 * ## Why the fills are replayed instead of reading `realized_pnl`
 * `execution_fills.realized_pnl` is only populated for perpetual legs — every spot leg is stored
 * as `'0'` — so reading it would silently drop the spot half of a hedged strategy. Replaying the
 * signed fills keeps the figure identical for perpetual and spot legs and lets the cost basis be
 * split between the closed part (`closedEntryNotionalUsdt` / `lockedProfitBps`) and the still-open
 * part (`entryNotionalUsdt` / `unrealizedPnl`).
 */

export interface StrategyFillInput {
  symbol: string;
  venue: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fee: string;
  createdAt: string;
}

export interface StrategyPnlInput {
  /** May arrive unordered; entries are stably sorted by `createdAt` before replay. */
  fills: StrategyFillInput[];
  /**
   * Latest mark price per `execution_fills.symbol`. The symbol already carries its venue prefix,
   * so it is also the position-grouping key.
   */
  marks: Map<string, string>;
  /** Funding charged (positive) or collected (negative); `null` when it cannot be attributed. */
  fundingFeeUsdt: string | null;
}

/** Position magnitude below which a leg is treated as flat (never actually zero after rounding). */
const QUANTITY_EPSILON = new Decimal('1e-12');

const ZERO = new Decimal(0);

/**
 * Serialize a Decimal as a plain decimal string. `toString()` switches to scientific notation for
 * extreme magnitudes (`1e-18`), which the API contract and the UI never want to see.
 */
function plain(value: Decimal): string {
  return value.toFixed();
}

interface PositionStream {
  /** Net signed quantity in symbol units; positive is long (BUY), negative is short (SELL). */
  signedQty: Decimal;
  /** Weighted-average entry price of the still-open quantity. */
  avgEntry: Decimal;
  /** Open fills' fees still attached to the currently-open quantity. */
  openFeeAccrued: Decimal;
}

/**
 * Splits one symbol's fills into the position-increasing and position-reducing cases and folds the
 * fee allocation in the same pass, so the closed result can be reported net of the fees that
 * actually belong to it.
 */
export function computeStrategyPnl(input: StrategyPnlInput): StrategyPnl {
  const streams = new Map<string, PositionStream>();
  let realizedPnl = ZERO;
  let closedFee = ZERO;
  let closedEntryNotionalUsdt = ZERO;
  let entryNotionalUsdt = ZERO;
  let feesPaid = ZERO;

  // Stable ascending sort: equal timestamps keep their incoming order, so a clip's legs replay in
  // the order the exchange reported them. The integration layer fetches `created_at ASC, rowid
  // ASC`, so equal timestamps have a deterministic order in production.
  const ordered = [...input.fills].sort((left, right) =>
    left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0);

  for (const fill of ordered) {
    const fillQty = new Decimal(fill.quantity).abs();
    const price = new Decimal(fill.price);
    const fillFee = new Decimal(fill.fee);
    // Positive is long. `fill.quantity` magnitude carries the size; the side carries the sign.
    const signed = fill.side === 'BUY' ? fillQty : fillQty.neg();
    // A zero-quantity fill is not a trade event: both its fee and its price are ignored, so the
    // conservation between `feesPaid` and the per-position fee allocations holds exactly.
    if (fillQty.lte(QUANTITY_EPSILON)) continue;
    feesPaid = feesPaid.plus(fillFee);

    const stream = streams.get(fill.symbol) ?? { signedQty: ZERO, avgEntry: ZERO, openFeeAccrued: ZERO };
    streams.set(fill.symbol, stream);

    const openQty = stream.signedQty.abs();
    const sameDirection = stream.signedQty.isZero()
      || stream.signedQty.isNegative() === signed.isNegative();

    if (sameDirection) {
      // Position-increasing (or opening from flat): re-weight the average entry price.
      stream.avgEntry = openQty.mul(stream.avgEntry).plus(fillQty.mul(price)).div(openQty.plus(fillQty));
      entryNotionalUsdt = entryNotionalUsdt.plus(fillQty.mul(price));
      stream.openFeeAccrued = stream.openFeeAccrued.plus(fillFee);
      stream.signedQty = stream.signedQty.plus(signed);
      continue;
    }

    // Position-reducing: match as much of the fill as the open quantity can absorb.
    const closing = Decimal.min(fillQty, openQty);
    const remaining = fillQty.minus(closing);
    realizedPnl = realizedPnl.plus(price.minus(stream.avgEntry).mul(closing).mul(stream.signedQty.isNegative() ? -1 : 1));
    closedEntryNotionalUsdt = closedEntryNotionalUsdt.plus(closing.mul(stream.avgEntry));

    // Fees accrued on the open position are released in proportion to what was closed…
    const allocatedOpen = stream.openFeeAccrued.mul(closing.div(openQty));
    closedFee = closedFee.plus(allocatedOpen);
    stream.openFeeAccrued = stream.openFeeAccrued.minus(allocatedOpen);
    // …and this fill's own fee is split across the closed and (on a flip) the reopened part.
    closedFee = closedFee.plus(fillFee.mul(closing.div(fillQty)));

    if (remaining.gt(QUANTITY_EPSILON)) {
      // Flipped through zero: the excess opens a fresh position in the opposite direction.
      stream.avgEntry = price;
      entryNotionalUsdt = entryNotionalUsdt.plus(remaining.mul(price));
      stream.openFeeAccrued = stream.openFeeAccrued.plus(fillFee.mul(remaining.div(fillQty)));
    } else if (stream.signedQty.plus(signed).isZero()) {
      // Exactly flat: no cost basis may linger (its fees were fully allocated above).
      stream.avgEntry = ZERO;
    }
    stream.signedQty = stream.signedQty.plus(signed);
  }

  // Mark every still-open leg. A single missing mark makes the whole figure unavailable: summing
  // only the marked legs would understate the open PnL without any visible hint.
  let unrealizedPnl = ZERO;
  let missingMark = false;
  for (const [symbol, stream] of streams) {
    if (stream.signedQty.abs().lte(QUANTITY_EPSILON)) continue;
    const mark = input.marks.get(symbol);
    let markPrice: Decimal | null = null;
    if (mark !== undefined) {
      try {
        const parsed = new Decimal(mark);
        // decimal.js answers `new Decimal('Infinity').gt(0)` with true, so finiteness is checked
        // explicitly: an infinite "price" must be treated as missing data, not a usable mark.
        if (parsed.isFinite() && parsed.gt(0)) markPrice = parsed;
      } catch {
        // Unparseable mark text is missing data, not a crash: it flows into `missingMark` below.
      }
    }
    if (markPrice === null) {
      missingMark = true;
      continue;
    }
    unrealizedPnl = unrealizedPnl.plus(stream.signedQty.mul(markPrice.minus(stream.avgEntry)));
  }

  const funding = input.fundingFeeUsdt === null ? ZERO : new Decimal(input.fundingFeeUsdt);
  const netPnl = missingMark ? null : realizedPnl.plus(unrealizedPnl).minus(feesPaid).minus(funding);
  const lockedProfitBps = closedEntryNotionalUsdt.gt(0)
    ? realizedPnl.minus(closedFee).minus(funding).div(closedEntryNotionalUsdt).mul(10_000)
    : null;

  return {
    realizedPnl: plain(realizedPnl),
    unrealizedPnl: missingMark ? null : plain(unrealizedPnl),
    feesPaid: plain(feesPaid),
    fundingFeeUsdt: input.fundingFeeUsdt,
    netPnl: netPnl === null ? null : plain(netPnl),
    closedEntryNotionalUsdt: plain(closedEntryNotionalUsdt),
    entryNotionalUsdt: plain(entryNotionalUsdt),
    lockedProfitBps: lockedProfitBps === null ? null : plain(lockedProfitBps),
  };
}
