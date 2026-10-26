import type { AuthenticatedPortfolioSnapshot, TradingSnapshot } from './api.js';
import { canonicalPositionAsset, positionGroupKey, positionGroupLabel } from './position-grouping.js';
import { positionFundingFee } from './position-funding-fees.js';
import { parseNumber, symbolParts } from './route-shared.js';

export interface PositionTableRow {
  id: string;
  positionId: string;
  symbol: string;
  venue: string;
  asset: string;
  quote: string;
  side: 'Long' | 'Short';
  quantity: number;
  value: number;
  entryPrice: number;
  markPrice: number;
  leverage: string | null;
  unrealizedPnl: number;
  realizedPnl: number | null;
  fundingFee: number | null;
  crossExAdlRank?: string | null;
  exchangeAdlRank?: string | null;
  /**
   * The venue returned no mark price for this leg.
   *
   * A perpetual never trades at 0, so a missing price means "unknown", not "free". Before this flag
   * the row fell back to `markPrice = 0` and the cell printed a confident `0`, which reads as a real
   * price — and it happens constantly for the venues whose public REST is unreachable from this
   * machine (Binance / OKX / Bybit / Kraken, see the spread-display fix).
   */
  markPriceUnavailable?: boolean;
  /**
   * Neither a venue-reported notional nor a mark price is available, so the position's value is
   * unknown. Kept separate from `markPriceUnavailable`: CrossEx usually still sends `value` even
   * when `markPrice` is missing, and hiding a known notional would be a regression.
   */
  valueUnavailable?: boolean;
  /**
   * The row's unrealised PnL was derived locally from a missing mark price, so it is unknown too.
   *
   * Only the local execution-store fallback derives PnL (`(mark - entry) * qty`); a venue-reported
   * `unrealizedPnl` stays trustworthy even when the mark price is missing.
   */
  pnlUnavailable?: boolean;
}

export type StrategyPositionRow = PositionTableRow;

/**
 * A price the venue reported, or `null` when it is missing, empty or a non-positive filler.
 *
 * Perpetuals never trade at 0, so a `"0"` in a price field always means "no price". This is the one
 * place that turns a venue string into that judgement, so every page builds its rows the same way.
 */
export function knownPrice(value: string | null | undefined): number | null {
  const parsed = parseNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/**
 * Notional of one futures leg, most authoritative source first: the value the venue already marked,
 * then quantity × mark price. `known: false` means the venue sent neither, so the cell prints `—`
 * and the page totals skip the leg instead of counting it as a position worth 0.
 */
export function futuresNotional(
  quantity: number,
  markPrice: number | null,
  reportedValue: number | null,
): { value: number; known: boolean } {
  const reported = Math.abs(reportedValue ?? 0);
  if (reported > 0) return { value: reported, known: true };
  if (markPrice !== null) return { value: Math.abs(quantity * markPrice), known: true };
  return { value: 0, known: false };
}

export interface StrategyPositionsView {
  status: 'unavailable' | 'stale' | 'fresh';
  rows: StrategyPositionRow[];
}

export interface PositionTableGroup {
  key: string;
  asset: string;
  label: string;
  mixedAssets: boolean;
  legs: StrategyPositionRow[];
  quantity: number;
  grossQuantity: number;
  grossNotional: number;
  weightedEntryPrice: number;
  weightedMarkPrice: number;
  unrealizedPnl: number;
  venueCount: number;
  fullyHedged: boolean;
  leverage: string | null;
}

export type StrategyPositionGroup = PositionTableGroup;

function portfolioRows(portfolio: AuthenticatedPortfolioSnapshot): StrategyPositionRow[] {
  return portfolio.snapshot.futuresPositions
    .map((position): StrategyPositionRow | null => {
      const quantity = parseNumber(position.quantity) ?? 0;
      if (quantity === 0) return null;
      const symbol = symbolParts(position.symbol);
      const markPrice = knownPrice(position.markPrice);
      const notional = futuresNotional(quantity, markPrice, parseNumber(position.value));
      return {
        id: `${symbol.venue}:${position.positionId || position.symbol}`,
        positionId: position.positionId,
        symbol: position.symbol,
        venue: symbol.venue,
        asset: symbol.asset,
        quote: symbol.quote,
        side: position.positionSide.toUpperCase() === 'SHORT' || quantity < 0 ? 'Short' : 'Long',
        quantity,
        // The venue reported the notional: trust it even when the mark price is missing.
        value: notional.value,
        entryPrice: knownPrice(position.entryPrice) ?? 0,
        markPrice: markPrice ?? 0,
        markPriceUnavailable: markPrice === null,
        valueUnavailable: !notional.known,
        // Gate reports uPnL itself, so it stays trustworthy without a mark price.
        pnlUnavailable: false,
        leverage: position.leverage || null,
        unrealizedPnl: parseNumber(position.unrealizedPnl) ?? 0,
        realizedPnl: parseNumber(position.realizedPnl),
        fundingFee: parseNumber(position.fundingFee),
        crossExAdlRank: position.crossExAdlRank ?? null,
        exchangeAdlRank: position.exchangeAdlRank ?? null,
      };
    })
    .filter((row): row is StrategyPositionRow => row !== null);
}

export function prepareExecutionPositionRows(
  snapshot: TradingSnapshot,
  portfolio: AuthenticatedPortfolioSnapshot | null,
  options: { allowStalePortfolio?: boolean } = {},
): StrategyPositionRow[] {
  const freshPortfolioPositions = portfolio && (options.allowStalePortfolio || (portfolio.dataStatus === 'fresh' && portfolio.remoteStatus === 'healthy'))
    ? portfolio.snapshot.futuresPositions
    : [];

  return snapshot.positions
    .map((position): StrategyPositionRow | null => {
      const quantity = parseNumber(position.quantity) ?? 0;
      if (quantity === 0) return null;
      const symbol = symbolParts(position.symbol);
      // Both prices are required to derive anything here: the local execution store carries no
      // notional of its own.
      const entryPrice = knownPrice(position.entry_price);
      const markPrice = knownPrice(position.mark_price);
      const notional = futuresNotional(quantity, markPrice, null);
      const portfolioPosition = freshPortfolioPositions.find((candidate) =>
        candidate.positionId === position.position_id || candidate.symbol === position.symbol);
      const reportedPnl = portfolioPosition ? parseNumber(portfolioPosition.unrealizedPnl) : null;
      return {
        id: `${symbol.venue}:${position.position_id || position.symbol}`,
        positionId: position.position_id,
        symbol: position.symbol,
        venue: symbol.venue,
        asset: symbol.asset,
        quote: symbol.quote,
        side: quantity < 0 ? 'Short' : 'Long',
        quantity,
        value: notional.value,
        entryPrice: entryPrice ?? 0,
        markPrice: markPrice ?? 0,
        markPriceUnavailable: markPrice === null,
        valueUnavailable: !notional.known,
        // The PnL below is derived locally from these prices, so a missing price makes it unknown
        // too; a venue-reported PnL (`reportedPnl`) stays trustworthy.
        pnlUnavailable: reportedPnl === null && (markPrice === null || entryPrice === null),
        leverage: portfolioPosition?.leverage || null,
        unrealizedPnl: reportedPnl
          ?? (markPrice !== null && entryPrice !== null ? (markPrice - entryPrice) * quantity : 0),
        realizedPnl: parseNumber(position.realized_pnl),
        fundingFee: positionFundingFee(position, freshPortfolioPositions),
        crossExAdlRank: portfolioPosition?.crossExAdlRank ?? null,
        exchangeAdlRank: portfolioPosition?.exchangeAdlRank ?? null,
      };
    })
    .filter((row): row is StrategyPositionRow => row !== null);
}

function marketKey(row: StrategyPositionRow): string {
  return `${row.venue}:${row.asset}:${row.quote}`;
}

/**
 * Use the same execution-position snapshot shown by the trading page. A healthy portfolio
 * snapshot enriches those rows with leverage and reported PnL and also fills any missing legs.
 */
export function prepareStrategyPositions(
  portfolio: AuthenticatedPortfolioSnapshot | null,
  tradingSnapshot: TradingSnapshot | null = null,
): StrategyPositionsView {
  const portfolioFresh = portfolio?.dataStatus === 'fresh' && portfolio.remoteStatus === 'healthy';
  if (!tradingSnapshot && !portfolio) return { status: 'unavailable', rows: [] };
  if (!tradingSnapshot && !portfolioFresh) return { status: 'stale', rows: [] };

  const rowsByMarket = new Map<string, StrategyPositionRow>();
  if (portfolioFresh && portfolio) {
    for (const row of portfolioRows(portfolio)) rowsByMarket.set(marketKey(row), row);
  }
  if (tradingSnapshot) {
    for (const row of prepareExecutionPositionRows(tradingSnapshot, portfolio)) rowsByMarket.set(marketKey(row), row);
  }
  const rows = [...rowsByMarket.values()].sort((left, right) => right.value - left.value);

  return { status: 'fresh', rows };
}

/** Match the trading terminal's position grouping: one expandable row per asset. */
export function groupPositionRows(rows: readonly PositionTableRow[]): PositionTableGroup[] {
  const groups = new Map<string, StrategyPositionRow[]>();
  for (const row of rows) {
    const key = positionGroupKey(row.asset, row.venue);
    const legs = groups.get(key) ?? [];
    legs.push(row);
    groups.set(key, legs);
  }

  return [...groups.entries()].map(([groupKey, legs]) => {
    const assets = [...new Set(legs.map((leg) => canonicalPositionAsset(leg.asset, leg.venue)))];
    const asset = assets[0];
    const mixedAssets = assets.length > 1;
    const quantity = legs.reduce((sum, leg) => sum + leg.quantity, 0);
    const grossQuantity = legs.reduce((sum, leg) => sum + Math.abs(leg.quantity), 0);
    const grossNotional = legs.reduce((sum, leg) => sum + leg.value, 0);
    const leverages = new Set(legs.map((leg) => leg.leverage));
    return {
      key: `${groupKey}-PERP`,
      asset,
      label: positionGroupLabel(assets),
      mixedAssets,
      legs,
      quantity,
      grossQuantity,
      grossNotional,
      weightedEntryPrice: grossQuantity > 0
        ? legs.reduce((sum, leg) => sum + leg.entryPrice * Math.abs(leg.quantity), 0) / grossQuantity
        : 0,
      weightedMarkPrice: grossQuantity > 0
        ? legs.reduce((sum, leg) => sum + leg.markPrice * Math.abs(leg.quantity), 0) / grossQuantity
        : 0,
      unrealizedPnl: legs.reduce((sum, leg) => sum + leg.unrealizedPnl, 0),
      venueCount: new Set(legs.map((leg) => leg.venue)).size,
      fullyHedged: mixedAssets
        ? legs.some((leg) => leg.quantity > 0) && legs.some((leg) => leg.quantity < 0)
        : grossQuantity > 0 && Math.abs(quantity) <= Math.max(1e-12, grossQuantity * 1e-9),
      leverage: leverages.size === 1 ? [...leverages][0] : null,
    };
  });
}

export const groupStrategyPositions = groupPositionRows;
