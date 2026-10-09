/* Pure planning helpers for the spot-holdings one-click close. No React. */
import type { CrossExInstrument } from '@gate-crossex/shared-types';
import type { LiveMarket, MarketSnapshot } from './api.js';
import type { SpotHoldingsRow } from './execution-split.js';
import { closeQuantityForPercentage } from './position-close.js';

/**
 * Quote currencies are the cash side of a pair: selling them is a cash conversion, not a position
 * close, so a *holding* in USDT/USDC is never offered as a one-click close. A *debt* in them is a
 * different thing — CrossEx auto-borrows a quote coin to margin positions on venues that settle in
 * it — and GATE/BINANCE/OKX/BYBIT all list `{coin}/USDT`, so a USDC debt stays buyable back there.
 * The market lookup decides, never the coin name alone.
 */
const QUOTE_COINS = new Set(['USDT', 'USDC']);

/**
 * The legacy isolated Gate spot account reports venue 'SPOT' while its market symbols carry the
 * GATE prefix; every other venue code already matches the symbol namespace.
 */
export function spotCloseVenue(venue: string): string {
  return venue.toUpperCase() === 'SPOT' ? 'GATE' : venue.toUpperCase();
}

/** Executable spot symbol for closing one holding: the venue's {coin}/USDT spot market. */
export function spotCloseSymbol(venue: string, coin: string, quote = 'USDT'): string {
  return `${spotCloseVenue(venue)}_SPOT_${coin}_${quote}`;
}

export function spotMarketFor(venue: string, coin: string, marketSnapshot: MarketSnapshot | null): LiveMarket | null {
  const symbol = spotCloseSymbol(venue, coin);
  return marketSnapshot?.markets.find((item) => item.symbol === symbol) ?? null;
}

/**
 * A negative holding is a short (现货做空, registered as a coin liability) and is unwound by
 * buying the coin back; a positive holding is closed by selling it.
 */
export function spotCloseSide(row: SpotHoldingsRow): 'BUY' | 'SELL' {
  return row.total < 0 ? 'BUY' : 'SELL';
}

/**
 * Size actually submitted, in COIN units. A long can only sell what is available (locked balance
 * is already committed to resting orders); a short owes the whole liability.
 */
export function spotCloseSize(row: SpotHoldingsRow): number {
  return row.total < 0 ? Math.abs(row.total) : Math.max(0, row.available);
}

export interface SpotClosePlan {
  symbol: string;
  /** BUY unwinds a short; SELL closes a long. */
  side: 'BUY' | 'SELL';
  /** Lot-floored coin quantity of the close slice; '0' when the slice is empty or unpriceable. */
  quantity: string;
  /**
   * Quote amount to spend, for buy-backs only: Gate sizes spot market buys in quote currency, so a
   * short close carries this alongside the base quantity (the backend sends quote_qty in its place).
   */
  quoteQty: string | null;
  /** Executable price: the best bid when selling, the best ask when buying back; last as fallback. */
  referencePrice: number | null;
  /** Notional of the slice: proceeds for a sell, cost for a buy-back. Null without a quote. */
  estimatedProceeds: number | null;
  /** English blocker labels; empty means the slice can be submitted as a market order. */
  issues: string[];
}

/** Trim a fixed-precision decimal into the text form the trading API accepts (no exponent, no '+'). */
function toDecimalText(value: number, decimals: number): string {
  return value.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Why a holding offers no one-click spot close, as an English i18n label; null means closable.
 * A debt that names no market is the interesting case: CrossEx borrowed the coin to margin a
 * position on an exchange that runs no spot business at all (HYPERLIQUID, KRAKEN, LIGHTER,
 * CROSSEX), so the debt is real, visible, and repayable — just not by a spot buy-back here.
 */
export function spotCloseBlocker(row: SpotHoldingsRow, instrument: CrossExInstrument | null): string | null {
  if (row.total > 0 && QUOTE_COINS.has(row.coin.toUpperCase())) return 'Quote balances cannot be closed as a spot position.';
  if (instrument) return null;
  return row.total < 0
    ? 'No spot market on this exchange to buy this debt back.'
    : 'No tradable spot market for this balance.';
}

/**
 * Plan one close slice for a spot holding: sell `percentage` of the *available* balance of the
 * coin, or buy back `percentage` of a short's liability, on the venue's USDT spot market. Locked
 * balance is deliberately excluded — it is already committed to resting orders and cannot be sold
 * twice. Nothing is ever fabricated: an unknown price yields null proceeds plus an explicit issue
 * rather than a fake zero.
 */
export function buildSpotClosePlan(
  row: SpotHoldingsRow,
  instrument: CrossExInstrument | null,
  market: LiveMarket | null,
  percentage: number,
): SpotClosePlan {
  const symbol = spotCloseSymbol(row.venue, row.coin);
  const side = spotCloseSide(row);
  const issues: string[] = [];
  const blocker = spotCloseBlocker(row, instrument);
  if (blocker) issues.push(blocker);
  // Selling hits the bid; buying back lifts the ask. Both fall back to the last trade.
  const executable = Number(side === 'BUY' ? market?.askPrice : market?.bidPrice);
  const last = Number(market?.lastPrice);
  const referencePrice = Number.isFinite(executable) && executable > 0 ? executable : Number.isFinite(last) && last > 0 ? last : null;
  if (referencePrice === null) issues.push('No live price for this market.');

  const quantity = instrument
    ? closeQuantityForPercentage(spotCloseSize(row), percentage, instrument.lotSize ?? null)
    : '0';
  const numericQuantity = Number(quantity);
  if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) {
    issues.push('Close amount is below the minimum order size.');
  } else {
    const minSize = Number(instrument?.minSize);
    if (instrument && Number.isFinite(minSize) && minSize > 0 && numericQuantity < minSize) {
      issues.push('Close amount is below the minimum order size.');
    }
    const minNotional = Number(instrument?.minNotional);
    if (referencePrice !== null && Number.isFinite(minNotional) && minNotional > 0
      && numericQuantity * referencePrice < minNotional) {
      issues.push('Close notional is below the market minimum.');
    }
  }

  const notional = referencePrice === null ? null : numericQuantity * referencePrice;
  return {
    symbol,
    side,
    quantity,
    quoteQty: side === 'BUY' && notional !== null && notional > 0 ? toDecimalText(notional, 8) : null,
    referencePrice,
    estimatedProceeds: notional,
    issues,
  };
}

/** Whether the row exposes a usable one-click close at all (drives the row action button). */
export function spotCloseAvailable(row: SpotHoldingsRow, instrument: CrossExInstrument | null): boolean {
  if (spotCloseBlocker(row, instrument)) return false;
  return Number(closeQuantityForPercentage(spotCloseSize(row), 100, instrument?.lotSize ?? null)) > 0;
}
