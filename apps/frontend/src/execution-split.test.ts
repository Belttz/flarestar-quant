import { describe, expect, it } from 'vitest';
import type { ExecutionFill, ExecutionOrder, LiveMarket, MarketSnapshot } from './api.js';
import type { PortfolioBalance, PortfolioMarginPosition } from '@gate-crossex/shared-types';
import { prepareSpotHoldingsRows, splitFillsByBusiness, splitOrdersByBusiness, spotValuationUsd } from './execution-split.js';

function order(overrides: Partial<ExecutionOrder> & { id: string; symbol: string }): ExecutionOrder {
  return {
    remoteOrderId: null, clientOrderId: `client-${overrides.id}`, venue: 'GATE', side: 'BUY', type: 'LIMIT',
    timeInForce: 'GTC', quantity: '1', price: '100', reduceOnly: false, state: 'OPEN', executedQuantity: '0',
    executedAveragePrice: null, strategyId: null, strategyLeg: null, createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function fill(overrides: Partial<ExecutionFill> & { id: string; symbol: string }): ExecutionFill {
  return {
    order_id: `order-${overrides.id}`, venue: 'GATE', side: 'BUY', quantity: '1', price: '100',
    fee: '0.01', realized_pnl: '0', created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function spotMarket(symbol: string, lastPrice: string): LiveMarket {
  return {
    symbol, venue: symbol.split('_')[0], asset: symbol.split('_')[2], lastPrice, bidPrice: lastPrice,
    bidSize: '1', askPrice: lastPrice, askSize: '1', open24h: lastPrice, high24h: lastPrice, low24h: lastPrice,
    volume24h: '1', quoteVolume24h: lastPrice, fundingRate: '0', nextFundingAt: '', openInterest: '0',
    openInterestValue: '0', receivedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    source: 'gate_crossex_websocket',
  };
}

function marketSnapshot(markets: LiveMarket[]): MarketSnapshot {
  return { connectionState: 'healthy', updatedAt: '2026-09-01T00:00:00.000Z', markets };
}

function balance(overrides: Partial<PortfolioBalance> & { venue: string; coin: string; balance: string }): PortfolioBalance {
  return {
    unrealizedPnl: '0', equity: '0', futuresInitialMargin: '0', futuresMaintenanceMargin: '0',
    borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', availableBalance: overrides.balance, liability: '0',
    ...overrides,
  };
}

/** A CrossEx margin (borrowed) position as the portfolio snapshot carries it. */
function marginPosition(overrides: Partial<PortfolioMarginPosition> & { symbol: string }): PortfolioMarginPosition {
  return {
    positionId: 'm1', positionSide: 'SHORT', initialMargin: '20', maintenanceMargin: '10',
    assetQuantity: '-100', assetCoin: 'ADA', value: '40', liability: '100', liabilityCoin: 'ADA',
    interest: '0', maxPositionQuantity: '1000', entryPrice: '0.4', indexPrice: '0.4',
    unrealizedPnl: '0', unrealizedPnlRate: '0', leverage: '3', maxLeverage: '5',
    createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('splitOrdersByBusiness', () => {
  it('routes spot and future orders into their own buckets without reordering', () => {
    const input = [
      order({ id: 'a', symbol: 'GATE_FUTURE_BTC_USDT' }),
      order({ id: 'b', symbol: 'GATE_SPOT_BTC_USDT' }),
      order({ id: 'c', symbol: 'BINANCE_SPOT_ETH_USDC' }),
      order({ id: 'd', symbol: 'OKX_FUTURE_HYPE_USDT' }),
    ];
    const { futures, spot } = splitOrdersByBusiness(input);
    expect(futures.map(({ id }) => id)).toEqual(['a', 'd']);
    expect(spot.map(({ id }) => id)).toEqual(['b', 'c']);
  });

  it('returns two empty arrays for empty input', () => {
    expect(splitOrdersByBusiness([])).toEqual({ futures: [], spot: [] });
  });
});

describe('splitFillsByBusiness', () => {
  it('routes spot and future fills into their own buckets without reordering', () => {
    const input = [
      fill({ id: 'f1', symbol: 'GATE_SPOT_BTC_USDT' }),
      fill({ id: 'f2', symbol: 'GATE_FUTURE_BTC_USDT' }),
      fill({ id: 'f3', symbol: 'GATE_SPOT_ETH_USDT' }),
    ];
    const { futures, spot } = splitFillsByBusiness(input);
    expect(futures.map(({ id }) => id)).toEqual(['f2']);
    expect(spot.map(({ id }) => id)).toEqual(['f1', 'f3']);
  });

  it('returns two empty arrays for empty input', () => {
    expect(splitFillsByBusiness([])).toEqual({ futures: [], spot: [] });
  });
});

describe('prepareSpotHoldingsRows', () => {
  it('values USDT 1:1 and other coins from the venue spot market', () => {
    const snapshot = marketSnapshot([spotMarket('GATE_SPOT_BTC_USDT', '62000')]);
    const rows = prepareSpotHoldingsRows([
      balance({ venue: 'SPOT', coin: 'USDT', balance: '250.125', availableBalance: '240' }),
      balance({ venue: 'SPOT', coin: 'BTC', balance: '0.5', availableBalance: '0.3' }),
    ], snapshot);
    expect(rows).toEqual([
      { venue: 'SPOT', coin: 'BTC', total: 0.5, available: 0.3, locked: 0.2, valuationUsd: 31_000 },
      { venue: 'SPOT', coin: 'USDT', total: 250.125, available: 240, locked: 10.125, valuationUsd: 250.125 },
    ]);
  });

  it('never fakes a zero: coins without a market quote value as null', () => {
    const snapshot = marketSnapshot([spotMarket('GATE_SPOT_BTC_USDT', '62000')]);
    const rows = prepareSpotHoldingsRows([
      balance({ venue: 'SPOT', coin: 'PEPE', balance: '1000000', availableBalance: '1' }),
    ], snapshot);
    expect(rows[0]?.valuationUsd).toBeNull();
  });

  it('follows the GATE→BINANCE→OKX→BYBIT venue priority for the USDT quote', () => {
    const snapshot = marketSnapshot([
      spotMarket('BYBIT_SPOT_SOL_USDT', '150'),
      spotMarket('BINANCE_SPOT_SOL_USDT', '200'),
      spotMarket('OKX_SPOT_SOL_USDT', '210'),
    ]);
    expect(spotValuationUsd('SOL', 2, snapshot)).toBe(400);
  });

  it('falls back to the USDC quote when no USDT market exists (USDC≈USD, approximate by design)', () => {
    const snapshot = marketSnapshot([spotMarket('OKX_SPOT_XMR_USDC', '180')]);
    expect(spotValuationUsd('XMR', 3, snapshot)).toBe(540);
  });

  it('treats a found market with a non-positive last price as no quote', () => {
    const snapshot = marketSnapshot([spotMarket('GATE_SPOT_BTC_USDT', '0')]);
    expect(spotValuationUsd('BTC', 1, snapshot)).toBeNull();
  });

  it('derives locked as max(0, total − available) to survive inverted upstream rows', () => {
    const rows = prepareSpotHoldingsRows([
      balance({ venue: 'SPOT', coin: 'ETH', balance: '2', availableBalance: '5' }),
    ], null);
    expect(rows[0]).toMatchObject({ venue: 'SPOT', total: 2, available: 5, locked: 0, valuationUsd: null });
  });

  it('includes unified-account balances on catalog spot venues and keeps perp-only venues out', () => {
    const rows = prepareSpotHoldingsRows([
      balance({ venue: 'GATE', coin: 'ONE', balance: '2030.03', availableBalance: '2030.03' }),
      balance({ venue: 'BINANCE', coin: 'BTC', balance: '0.1', availableBalance: '0.1' }),
      balance({ venue: 'CROSSEX', coin: 'USDT', balance: '500', availableBalance: '500' }),
      balance({ venue: 'HYPERLIQUID', coin: 'USDC', balance: '12', availableBalance: '12' }),
    ], null, new Set(['GATE', 'BINANCE', 'OKX', 'BYBIT', 'DERIBIT']));
    expect(rows.map(({ venue, coin }) => [venue, coin])).toEqual([['GATE', 'ONE'], ['BINANCE', 'BTC']]);
  });

  it('filters zero-balance and non-spot-venue rows', () => {
    const rows = prepareSpotHoldingsRows([
      balance({ venue: 'SPOT', coin: 'USDT', balance: '0', availableBalance: '0' }),
      balance({ venue: 'GATE', coin: 'BTC', balance: '1', availableBalance: '1' }),
      balance({ venue: 'CROSSEX', coin: 'USDT', balance: '500', availableBalance: '500' }),
    ], null);
    expect(rows).toEqual([]);
  });

  it('sorts by valuation descending and trails unvalued rows', () => {
    const snapshot = marketSnapshot([
      spotMarket('GATE_SPOT_BTC_USDT', '62000'),
      spotMarket('GATE_SPOT_ETH_USDT', '3100'),
    ]);
    const rows = prepareSpotHoldingsRows([
      balance({ venue: 'SPOT', coin: 'PEPE', balance: '9', availableBalance: '9' }),
      balance({ venue: 'SPOT', coin: 'BTC', balance: '0.1', availableBalance: '0.1' }),
      balance({ venue: 'SPOT', coin: 'ETH', balance: '1', availableBalance: '1' }),
      balance({ venue: 'SPOT', coin: 'USDT', balance: '50', availableBalance: '50' }),
    ], snapshot);
    expect(rows.map(({ coin }) => coin)).toEqual(['BTC', 'ETH', 'USDT', 'PEPE']);
    expect(rows.map(({ valuationUsd }) => valuationUsd)).toEqual([6200, 3100, 50, null]);
  });

  // 现货做空在 CrossEx 上体现为「币种负债」(liability = ABS(MIN(balance + upnl, 0)))，余额本身
  // 仍是非负数。此前只看 balance 字段，负债行整行被丢掉 → 交易页现货持仓看不到空头。
  it('turns a coin liability into a signed short row even when the balance reads zero', () => {
    const snapshot = marketSnapshot([spotMarket('GATE_SPOT_ADA_USDT', '0.4')]);
    const rows = prepareSpotHoldingsRows([
      balance({ venue: 'GATE', coin: 'ADA', balance: '0', availableBalance: '-40', liability: '100' }),
    ], snapshot, new Set(['GATE']));
    expect(rows).toEqual([
      { venue: 'GATE', coin: 'ADA', total: -100, available: -100, locked: 0, valuationUsd: -40 },
    ]);
  });

  it('treats a negative balance as a short and takes the larger of balance and liability', () => {
    const rows = prepareSpotHoldingsRows([
      balance({ venue: 'GATE', coin: 'ONE', balance: '-12.5', availableBalance: '-12.5' }),
      balance({ venue: 'OKX', coin: 'BTC', balance: '-0.001', availableBalance: '-0.001', liability: '0.002' }),
    ], null, new Set(['GATE', 'OKX']));
    expect(rows.map(({ venue, coin, total, available, locked }) => [venue, coin, total, available, locked]))
      .toEqual([['GATE', 'ONE', -12.5, -12.5, 0], ['OKX', 'BTC', -0.002, -0.002, 0]]);
  });

  // 实测上游行（HYPERLIQUID/USDC）：balance=0.079、available=-12.327、liability=12.327、
  // borrowingInitialMargin=2.465（= 负债/5 的借币保证金）。CrossEx 为这里的永续持仓自动借入 USDC，
  // 而该交易所目录里只有 FUTURE、没有 SPOT/MARGIN —— 负债行必须照常显示，否则用户在持仓里看不到、
  // 也就永远还不掉这笔钱。
  it('surfaces a borrowed settlement coin even on a venue with no spot business', () => {
    const rows = prepareSpotHoldingsRows([
      balance({
        venue: 'HYPERLIQUID', coin: 'USDC', balance: '0.07916106', availableBalance: '-12.326910255',
        liability: '12.326910255', borrowingInitialMargin: '2.465382051',
      }),
    ], null, new Set(['GATE']));
    expect(rows).toEqual([
      { venue: 'HYPERLIQUID', coin: 'USDC', total: -12.326910255, available: -12.326910255, locked: 0, valuationUsd: null },
    ]);
  });

  it('keeps a funded long on a perp-only venue out of the spot-holdings table', () => {
    // 反向：正余额在只做合约的交易所是保证金，不是现货持仓，仍按现货业务范围过滤。
    const rows = prepareSpotHoldingsRows([
      balance({ venue: 'LIGHTER', coin: 'USDC', balance: '0.3064513963449998', availableBalance: '0.3064513963449998' }),
    ], null, new Set(['GATE']));
    expect(rows).toEqual([]);
  });

  it('still omits rows with neither a balance nor a liability', () => {
    const rows = prepareSpotHoldingsRows([
      balance({ venue: 'GATE', coin: 'ETH', balance: '0', availableBalance: '0', liability: '0' }),
      balance({ venue: 'GATE', coin: 'XRP', balance: '0', availableBalance: '0', liability: '-' }),
    ], null, new Set(['GATE']));
    expect(rows).toEqual([]);
  });

  it('leaves an unquoted short unvalued instead of faking a zero', () => {
    const rows = prepareSpotHoldingsRows([
      balance({ venue: 'GATE', coin: 'PEPE', balance: '0', availableBalance: '0', liability: '1000000' }),
    ], null, new Set(['GATE']));
    expect(rows[0]).toMatchObject({ total: -1_000_000, valuationUsd: null });
  });

  // 借币卖出（现货杠杆空头）在账户资产里可能根本没有对应行，必须从 margin_positions 兜底显示。
  it('surfaces a spot margin short that has no balance row of its own', () => {
    const margin = marginPosition({ symbol: 'GATE_SPOT_ADA_USDT', positionSide: 'SHORT', assetCoin: 'ADA', assetQuantity: '-100', liability: '100', liabilityCoin: 'ADA' });
    const rows = prepareSpotHoldingsRows([], null, new Set(['GATE']), [margin]);
    expect(rows).toEqual([
      { venue: 'GATE', coin: 'ADA', total: -100, available: -100, locked: 0, valuationUsd: null },
    ]);
  });

  it('does not double count a margin short already carried by a liability balance', () => {
    const margin = marginPosition({ symbol: 'GATE_SPOT_ADA_USDT', positionSide: 'SHORT', assetCoin: 'ADA', assetQuantity: '-100', liability: '100', liabilityCoin: 'ADA' });
    const rows = prepareSpotHoldingsRows([
      balance({ venue: 'GATE', coin: 'ADA', balance: '0', availableBalance: '0', liability: '100' }),
    ], null, new Set(['GATE']), [margin]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.total).toBe(-100);
  });

  it('ignores perpetual margin positions and long margin legs', () => {
    const rows = prepareSpotHoldingsRows([], null, new Set(['GATE']), [
      marginPosition({ symbol: 'GATE_FUTURE_ADA_USDT', positionSide: 'SHORT', assetCoin: 'ADA', assetQuantity: '-100', liability: '100', liabilityCoin: 'ADA' }),
      marginPosition({ positionId: 'long', symbol: 'BINANCE_SPOT_ETH_USDT', positionSide: 'LONG', assetCoin: 'ETH', assetQuantity: '2', liability: '100', liabilityCoin: 'USDT' }),
    ]);
    expect(rows).toEqual([]);
  });
});
