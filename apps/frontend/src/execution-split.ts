/* Pure helpers that split execution data by business line and value spot holdings. No React. */
import type { ExecutionFill, ExecutionOrder, MarketSnapshot } from './api.js';
import type { PortfolioBalance, PortfolioMarginPosition } from '@gate-crossex/shared-types';
import { orderBusiness, symbolParts } from './route-shared.js';

/** Market type a unified execution row belongs to (R6/R7): contract or spot. */
export type UnifiedMarketType = 'perp' | 'spot';

/** The ledger symbol's `_SPOT_` segment is the market type; everything else is a perpetual. */
export function marketTypeOfSymbol(symbol: string): UnifiedMarketType {
  return symbol.includes('_SPOT_') ? 'spot' : 'perp';
}

/** Filter any row list carrying a symbol by unified market type; 'all' keeps everything. */
export function filterByMarketType<T extends { symbol?: string }>(
  rows: readonly T[],
  filter: UnifiedMarketType | 'all',
): T[] {
  if (filter === 'all') return [...rows];
  return rows.filter((row) => row.symbol === undefined || marketTypeOfSymbol(row.symbol) === filter);
}

/** Stable two-bucket split of orders by ledger-symbol business; input order is preserved. */
export function splitOrdersByBusiness(orders: ExecutionOrder[]): { futures: ExecutionOrder[]; spot: ExecutionOrder[] } {
  const futures: ExecutionOrder[] = [];
  const spot: ExecutionOrder[] = [];
  for (const order of orders) (orderBusiness(order.symbol) === 'SPOT' ? spot : futures).push(order);
  return { futures, spot };
}

/** Stable two-bucket split of fills by ledger-symbol business; input order is preserved. */
export function splitFillsByBusiness(fills: ExecutionFill[]): { futures: ExecutionFill[]; spot: ExecutionFill[] } {
  const futures: ExecutionFill[] = [];
  const spot: ExecutionFill[] = [];
  for (const fill of fills) (orderBusiness(fill.symbol) === 'SPOT' ? spot : futures).push(fill);
  return { futures, spot };
}

/** One spot-holdings row as rendered by the trade page's spot-holdings tab. */
export interface SpotHoldingsRow {
  /** Exchange the unified-account balance lives on ('SPOT' = the legacy isolated Gate spot account). */
  venue: string;
  coin: string;
  /**
   * Signed position size: the coin balance for a long, `−liability` for a short (负债).
   * Negative ⇒ the account owes the coin and the row closes with a buy-back.
   */
  total: number;
  /** Signed available size: the sellable balance for a long, `−liability` for a short. */
  available: number;
  /** max(0, total − available) for a long; always 0 for a short — a debt has nothing locked. */
  locked: number;
  /** Signed USDT valuation; null = no market quote (rendered as —, never a fake zero). */
  valuationUsd: number | null;
}

/** Venue priority for finding a spot quote market (the terminal's settlement venue first). */
const VALUATION_VENUES = ['GATE', 'BINANCE', 'OKX', 'BYBIT'] as const;

/**
 * USDT-converted value of a coin balance from the market snapshot's spot prices. USDT converts
 * 1:1; other coins take the first *_SPOT_{coin}_USDT market on the venue priority list, falling
 * back to *_SPOT_{coin}_USDC (USDC≈USD anchor — approximate by design). A found market without a
 * usable last price, or no market at all, values the row as null instead of a fabricated zero.
 */
export function spotValuationUsd(coin: string, total: number, marketSnapshot: MarketSnapshot | null): number | null {
  if (coin === 'USDT') return total;
  const markets = marketSnapshot?.markets ?? [];
  for (const quote of ['USDT', 'USDC'] as const) {
    const market = VALUATION_VENUES
      .map((venue) => markets.find((item) => item.venue === venue && item.symbol === `${venue}_SPOT_${coin}_${quote}`))
      .find((item) => item !== undefined);
    if (!market) continue;
    const lastPrice = Number(market.lastPrice);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return null;
    return total * lastPrice;
  }
  return null;
}

/**
 * Build the spot-holdings rows from the authenticated portfolio snapshot. CrossEx unifies spot and
 * futures funds per exchange, so a spot holding is any balance row on a venue that runs a SPOT
 * business (the caller derives that set from the market catalog) — plus the legacy isolated Gate
 * spot account (venue==='SPOT') when it ever carries funds. Perp-only venues (CROSSEX, KRAKEN,
 * LIGHTER, HYPERLIQUID, …) are futures margin, never spot holdings. Output is sorted by valuation
 * descending with unvalued rows trailing.
 *
 * A short (现货做空) is reported as a coin **liability**, not as a negative balance: Gate defines
 * 负债 = ABS(MIN(余额 + 未实现盈亏, 0)). Ignoring that field left every short invisible on the trade
 * page, so a liability row becomes a signed negative holding (−liability) that the close flow can
 * buy back. A balance that is itself negative is treated the same way, taking the larger magnitude.
 * Spot margin shorts that carry no balance row are taken from `marginPositions` as a fallback.
 *
 * Debts are exempt from the spot-venue scoping below: CrossEx auto-borrows a coin to margin a
 * position (e.g. USDC on a USDC-margined perp venue), and the resulting liability must stay
 * visible — and repayable — even when that exchange runs no spot business at all. Only *holdings*
 * are scoped to spot venues, because a positive balance on a perp-only venue is margin, not a
 * position the user can sell here.
 */
export function prepareSpotHoldingsRows(
  balances: PortfolioBalance[],
  marketSnapshot: MarketSnapshot | null,
  spotVenues?: ReadonlySet<string> | null,
  marginPositions?: readonly PortfolioMarginPosition[] | null,
): SpotHoldingsRow[] {
  const rows: SpotHoldingsRow[] = [];
  const shortRow = (venue: string, coin: string, size: number): SpotHoldingsRow => ({
    venue,
    coin,
    total: -size,
    available: -size,
    locked: 0,
    valuationUsd: spotValuationUsd(coin, -size, marketSnapshot),
  });
  for (const balance of balances) {
    const total = Number(balance.balance);
    const held = Number.isFinite(total) ? total : 0;
    const parsedLiability = Number(balance.liability);
    const debt = Number.isFinite(parsedLiability) && parsedLiability > 0 ? parsedLiability : 0;
    const parsedAvailable = Number(balance.availableBalance);
    // The three upstream fields disagree by design (a settled remainder can sit next to a borrow),
    // so the debt is the largest magnitude any of them reports. Never the sum — that would
    // double-count the borrow.
    const shortSize = Math.max(debt, held < 0 ? -held : 0, Number.isFinite(parsedAvailable) && parsedAvailable < 0 ? -parsedAvailable : 0);
    if (shortSize > 0) {
      rows.push(shortRow(balance.venue, balance.coin, shortSize));
      continue;
    }
    const isSpotVenue = balance.venue === 'SPOT' || (spotVenues?.has(balance.venue) ?? false);
    if (!isSpotVenue) continue;
    if (held === 0) continue;
    // Upstream reports numbers as strings; an unparseable available side must not poison locked.
    const availableRaw = Number(balance.availableBalance);
    const available = Number.isFinite(availableRaw) ? availableRaw : 0;
    rows.push({
      venue: balance.venue,
      coin: balance.coin,
      total: held,
      available,
      locked: Math.max(0, held - available),
      valuationUsd: spotValuationUsd(balance.coin, held, marketSnapshot),
    });
  }
  // A spot margin short can exist without any balance row of its own (borrow-and-sell): surface it
  // so the position is visible and closable. Longs and anything already represented by a balance
  // row are left alone, so nothing is ever counted twice.
  for (const position of marginPositions ?? []) {
    if (orderBusiness(position.symbol) !== 'SPOT') continue;
    const part = symbolParts(position.symbol);
    const coin = position.assetCoin || part.asset;
    if (!coin || position.positionSide.toUpperCase() !== 'SHORT') continue;
    const liabilityCoin = position.liabilityCoin || coin;
    if (liabilityCoin.toUpperCase() !== coin.toUpperCase()) continue;
    const liability = Number(position.liability);
    const size = Number.isFinite(liability) && liability > 0 ? liability : Math.abs(Number(position.assetQuantity) || 0);
    if (size <= 0) continue;
    if (rows.some((row) => row.venue.toUpperCase() === part.venue.toUpperCase() && row.coin.toUpperCase() === coin.toUpperCase())) continue;
    rows.push(shortRow(part.venue, coin, size));
  }
  return rows.sort((left, right) =>
    (right.valuationUsd ?? Number.NEGATIVE_INFINITY) - (left.valuationUsd ?? Number.NEGATIVE_INFINITY));
}
