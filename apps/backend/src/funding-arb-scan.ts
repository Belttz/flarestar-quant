import { Decimal } from 'decimal.js';
import type {
  FundingArbCandidate,
  FundingOverviewResponse,
  FundingOverviewVenueEntry,
} from '@gate-crossex/shared-types';

/**
 * Pure model behind the automatic perp ⇄ perp funding runner.
 *
 * This mirrors the Funding page's hedge board (`apps/frontend/src/funding-hedge.ts`): for one
 * asset, every pair of venues whose perpetual publishes a funding rate becomes a candidate, with
 * the higher-rate venue shorted and the lower-rate venue longed. The comparable figure is the
 * 8h-equivalent differential the board ranks by, annualized with the same 1095× factor the
 * Opportunities board uses. Nothing here touches IO, so the gates and sizing are unit-testable.
 */

const CROSSEX_FUTURE_SYMBOL = /^([A-Z0-9]+)_FUTURE_([A-Z0-9]+)_(USDT|USDC|USD)$/;
/** |rate8h| × 3 × 365 × 100, exactly the Opportunities board's annualization. */
const ANNUALIZATION_FACTOR = 3 * 365 * 100;
const BPS = new Decimal(10_000);

export interface FundingArbScanLeg {
  venue: string;
  symbol: string;
  quote: string;
  rate8h: string;
  intervalHours: number | null;
  nextFundingAt: string | null;
  fetchedAt: string | null;
}

/**
 * Every perp ⇄ perp pair of one asset with a comparable 8h rate on both legs. Rows without a
 * published rate are dropped rather than filled with 0 — a missing rate is not "free carry".
 */
export function buildFundingArbCandidates(
  overview: FundingOverviewResponse,
  venueWhitelist: readonly string[] = [],
): FundingArbCandidate[] {
  const allowed = new Set(venueWhitelist.map((venue) => venue.toUpperCase()));
  const rows: FundingArbCandidate[] = [];
  for (const assetEntry of overview.assets) {
    const legs: FundingArbScanLeg[] = [];
    for (const venueEntry of assetEntry.venues) {
      const leg = scanLeg(venueEntry, allowed);
      if (leg) legs.push(leg);
    }
    for (let i = 0; i < legs.length; i += 1) {
      for (let j = i + 1; j < legs.length; j += 1) {
        const first = legs[i]!;
        const second = legs[j]!;
        const firstRate = Number(first.rate8h);
        const secondRate = Number(second.rate8h);
        if (!Number.isFinite(firstRate) || !Number.isFinite(secondRate)) continue;
        const short = firstRate >= secondRate ? first : second;
        const long = firstRate >= secondRate ? second : first;
        const net8h = Math.abs(firstRate - secondRate);
        const aprPercent = net8h * ANNUALIZATION_FACTOR;
        rows.push({
          key: `${assetEntry.asset}:${short.venue}:${long.venue}`,
          asset: assetEntry.asset,
          shortVenue: short.venue,
          shortSymbol: short.symbol,
          longVenue: long.venue,
          longSymbol: long.symbol,
          shortRate8h: short.rate8h,
          longRate8h: long.rate8h,
          shortIntervalHours: short.intervalHours,
          longIntervalHours: long.intervalHours,
          shortNextFundingAt: short.nextFundingAt,
          longNextFundingAt: long.nextFundingAt,
          fetchedAt: short.fetchedAt ?? long.fetchedAt,
          net8h: trim(net8h),
          aprPercent,
          verdict: 'REJECT',
          reasons: [],
          score: aprPercent,
          entryBps: null,
          notionalUsd: null,
          quantity: null,
          leverage: null,
          settlementInMs: null,
        });
      }
    }
  }
  rows.sort((left, right) => right.aprPercent - left.aprPercent
    || left.asset.localeCompare(right.asset)
    || left.shortVenue.localeCompare(right.shortVenue));
  return rows;
}

function scanLeg(
  venueEntry: FundingOverviewVenueEntry,
  allowed: ReadonlySet<string>,
): FundingArbScanLeg | null {
  if (allowed.size > 0 && !allowed.has(venueEntry.venue.toUpperCase())) return null;
  if (!CROSSEX_FUTURE_SYMBOL.test(venueEntry.symbol)) return null;
  if (venueEntry.fundingRate8h === null) return null;
  const rate = Number(venueEntry.fundingRate8h);
  if (!Number.isFinite(rate)) return null;
  return {
    venue: venueEntry.venue.toUpperCase(),
    symbol: venueEntry.symbol,
    quote: venueEntry.quote,
    rate8h: venueEntry.fundingRate8h,
    intervalHours: venueEntry.fundingIntervalHours,
    nextFundingAt: venueEntry.nextFundingAt,
    fetchedAt: venueEntry.fetchedAt ?? null,
  };
}

/** Executable entry spread in bps: sell the short leg on its bid, buy the long leg at its ask. */
export function executableEntrySpreadBps(
  shortBid: string | null | undefined,
  longAsk: string | null | undefined,
): number | null {
  const bid = Number(shortBid);
  const ask = Number(longAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  return (bid - ask) / ask * 10_000;
}

/**
 * Dynamic entry trigger: sit just below the live executable spread so the maker quote can rest
 * immediately, with a slippage buffer that scales the tolerance. A flat 0 bps ignores both the
 * book and the two legs' quality; this keeps the trigger tied to what the book currently offers.
 * The buffer is the operator's `entrySlipBufferBps`; the result is clamped so a pathological book
 * cannot produce an absurd trigger.
 */
export function dynamicEntryBps(spreadBps: number, slipBufferBps: number): string {
  const buffer = Number.isFinite(slipBufferBps) ? Math.max(0, slipBufferBps) : 0;
  const value = Math.max(-500, Math.min(500, spreadBps - buffer));
  return new Decimal(value).toFixed(4);
}

/** Milliseconds until the later of the two legs settles, or null when either time is unknown. */
export function settlementInMs(
  shortNextFundingAt: string | null,
  longNextFundingAt: string | null,
  now: number,
): number | null {
  const shortAt = Date.parse(shortNextFundingAt ?? '');
  const longAt = Date.parse(longNextFundingAt ?? '');
  if (!Number.isFinite(shortAt) || !Number.isFinite(longAt)) return null;
  return Math.max(shortAt, longAt) - now;
}

export interface FundingArbHedgeSizeInput {
  availableMarginUsd: number;
  safetyFactor: number;
  maxPerTradeUsd: number;
  leftLeverage: number;
  rightLeverage: number;
  price: number;
  lotSize: string | null;
  minSize: string | null;
  minNotional: string | null;
  maxMarketSize: string | null;
}

export type FundingArbHedgeSize =
  | { ok: true; quantity: string; notionalUsd: number; leverage: number }
  | { ok: false; reason: 'SIZE_TOO_SMALL' | 'MAX_MARKET_SIZE' | 'BALANCE_INSUFFICIENT'; detail: string };

/**
 * Equal-notional two-leg sizing from available margin and leverage:
 *
 *   notional = available × safety / (1/L_left + 1/L_right)
 *
 * capped by the per-trade USD ceiling and the venue's maximum market size, then rounded down to
 * the shared lot size. The quantity is in base units and is used for both legs.
 */
export function sizePerpHedge(input: FundingArbHedgeSizeInput): FundingArbHedgeSize {
  const price = new Decimal(input.price);
  if (!price.isFinite() || price.lte(0)) {
    return { ok: false, reason: 'BALANCE_INSUFFICIENT', detail: 'no executable price' };
  }
  const available = new Decimal(Math.max(0, input.availableMarginUsd));
  const leftLeverage = new Decimal(Math.max(1, input.leftLeverage));
  const rightLeverage = new Decimal(Math.max(1, input.rightLeverage));
  const safety = new Decimal(Math.max(0.01, Math.min(1, input.safetyFactor)));
  const marginPerNotional = new Decimal(1).div(leftLeverage).plus(new Decimal(1).div(rightLeverage));
  if (marginPerNotional.lte(0)) return { ok: false, reason: 'BALANCE_INSUFFICIENT', detail: 'leverage is not positive' };
  let notional = available.mul(safety).div(marginPerNotional);
  notional = Decimal.min(notional, new Decimal(Math.max(0, input.maxPerTradeUsd)));
  if (input.maxMarketSize !== null) {
    const maxMarket = new Decimal(input.maxMarketSize);
    if (maxMarket.isFinite() && maxMarket.gt(0)) {
      notional = Decimal.min(notional, maxMarket.mul(price));
    }
  }
  if (!notional.gt(0)) return { ok: false, reason: 'BALANCE_INSUFFICIENT', detail: 'no margin available' };
  let quantity = notional.div(price);
  if (input.lotSize !== null) {
    const lot = new Decimal(input.lotSize);
    if (lot.isFinite() && lot.gt(0)) {
      quantity = quantity.div(lot).floor().mul(lot);
    }
  }
  if (input.minSize !== null) {
    const minSize = new Decimal(input.minSize);
    if (minSize.isFinite() && minSize.gt(0) && quantity.lt(minSize)) {
      return { ok: false, reason: 'SIZE_TOO_SMALL', detail: `quantity ${quantity.toString()} below minSize ${input.minSize}` };
    }
  }
  if (!quantity.gt(0)) return { ok: false, reason: 'SIZE_TOO_SMALL', detail: 'rounded quantity is zero' };
  const finalNotional = quantity.mul(price);
  if (input.minNotional !== null) {
    const minNotional = new Decimal(input.minNotional);
    if (minNotional.isFinite() && minNotional.gt(0) && finalNotional.lt(minNotional)) {
      return { ok: false, reason: 'SIZE_TOO_SMALL', detail: `notional ${finalNotional.toString()} below minNotional ${input.minNotional}` };
    }
  }
  const leverage = Decimal.min(leftLeverage, rightLeverage).toNumber();
  return { ok: true, quantity: quantity.toString(), notionalUsd: finalNotional.toNumber(), leverage };
}

/**
 * Estimated round-trip execution cost for the hedge, in bps of notional: both legs are opened and
 * closed, so four taker fills at `takerFeeBps` plus the same four at `slippageBps`.
 */
export function roundTripCostBps(takerFeeBps: number, slippageBps: number): number {
  return 4 * (takerFeeBps + slippageBps);
}

/** Funding captured by one 8h-equivalent settlement, in bps of notional (APR% ÷ 1095 × 100). */
export function perSettlementFundingBps(aprPercent: number): number {
  return aprPercent / (3 * 365) * 100;
}

export function trim(value: number): string {
  return new Decimal(value).toFixed(10).replace(/\.?0+$/, '');
}

export { ANNUALIZATION_FACTOR, BPS, CROSSEX_FUTURE_SYMBOL };
