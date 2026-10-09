import { describe, expect, it } from 'vitest';
import type { CrossExInstrument } from '@gate-crossex/shared-types';
import type { LiveMarket } from './api.js';
import type { SpotHoldingsRow } from './execution-split.js';
import { buildSpotClosePlan, spotCloseAvailable, spotCloseBlocker, spotCloseSymbol, spotCloseVenue } from './spot-close.js';

/** A spot-holdings row on the legacy isolated Gate account, the shape the trade page emits. */
function row(overrides: Partial<SpotHoldingsRow> = {}): SpotHoldingsRow {
  return { venue: 'SPOT', coin: 'ADA', total: 55.12345678, available: 55.12345678, locked: 0, valuationUsd: 22, ...overrides };
}

/** A Gate spot instrument whose lot size mirrors the live venue: ADA/ONE lot `1`, BTC lot `0.000001`. */
function spotInstrument(symbol: string, overrides: Partial<CrossExInstrument> = {}): CrossExInstrument {
  return {
    symbol, exchangeType: 'GATE', businessType: 'SPOT', state: 'live',
    minSize: '1', minNotional: '1', lotSize: '1', tickSize: '0.0001', maxNumOrders: '100',
    maxMarketSize: null, maxLimitSize: null, contractSize: null, liquidationFee: null,
    defaultLeverage: null, delistTime: '0', ...overrides,
  };
}

/** A live GATE_SPOT_ADA_USDT book with a 0.4 bid so proceeds are computable. */
function market(symbol: string, overrides: Partial<LiveMarket> = {}): LiveMarket {
  return {
    symbol, venue: 'GATE', asset: 'ADA', lastPrice: '0.4', bidPrice: '0.4', bidSize: '1000',
    askPrice: '0.401', askSize: '1000', open24h: '0.4', high24h: '0.42', low24h: '0.39',
    volume24h: '1000', quoteVolume24h: '400', fundingRate: '0', nextFundingAt: '', openInterest: '0',
    openInterestValue: '0', receivedAt: '', updatedAt: '', source: 'rest_book_ticker', ...overrides,
  };
}

describe('spot symbol helpers', () => {
  it('maps the legacy isolated SPOT account onto the Gate venue namespace', () => {
    expect(spotCloseVenue('SPOT')).toBe('GATE');
    expect(spotCloseVenue('binance')).toBe('BINANCE');
    expect(spotCloseSymbol('SPOT', 'ADA')).toBe('GATE_SPOT_ADA_USDT');
  });
});

describe('buildSpotClosePlan', () => {
  it('floors a full-balance close down to the venue lot size instead of submitting the raw balance', () => {
    // Regression: lot 1 with a 55.12345678 balance used to submit 55.12345678 → TRADE_ORDER_LOT_SIZE_ERROR.
    const plan = buildSpotClosePlan(row(), spotInstrument('GATE_SPOT_ADA_USDT'), market('GATE_SPOT_ADA_USDT'), 100);
    expect(plan.quantity).toBe('55');
    expect(plan.issues).toEqual([]);
    expect(plan.estimatedProceeds).toBeCloseTo(22, 6);
  });

  it('floors a partial close down to the venue lot size', () => {
    const plan = buildSpotClosePlan(row(), spotInstrument('GATE_SPOT_ADA_USDT'), market('GATE_SPOT_ADA_USDT'), 50);
    expect(plan.quantity).toBe('27');
    expect(plan.issues).toEqual([]);
  });

  it('rejects a dust balance that cannot fill a single lot', () => {
    const dust = row({ available: 0.4, total: 0.4 });
    const plan = buildSpotClosePlan(dust, spotInstrument('GATE_SPOT_ADA_USDT'), market('GATE_SPOT_ADA_USDT'), 100);
    expect(plan.quantity).toBe('0');
    expect(plan.issues).toContain('Close amount is below the minimum order size.');
    expect(spotCloseAvailable(dust, spotInstrument('GATE_SPOT_ADA_USDT'))).toBe(false);
  });

  it('never plans a close for a quote currency', () => {
    const usdt = row({ coin: 'USDT' });
    expect(spotCloseAvailable(usdt, spotInstrument('GATE_SPOT_USDT_USDT'))).toBe(false);
    const plan = buildSpotClosePlan(usdt, spotInstrument('GATE_SPOT_USDT_USDT'), market('GATE_SPOT_USDT_USDT'), 100);
    expect(plan.issues).toContain('Quote balances cannot be closed as a spot position.');
  });

  it('falls back to the raw scaled quantity when no lot size is published, without throwing', () => {
    const noLot = spotInstrument('GATE_SPOT_ADA_USDT', { lotSize: '' });
    const full = buildSpotClosePlan(row(), noLot, market('GATE_SPOT_ADA_USDT'), 100);
    expect(full.quantity).toBe('55.12345678');
    const half = buildSpotClosePlan(row(), spotInstrument('GATE_SPOT_ADA_USDT', { lotSize: '' }), market('GATE_SPOT_ADA_USDT'), 50);
    expect(half.quantity).toBe('27.56172839');
  });

  it('reports every prerequisite that is missing rather than fabricating a plan', () => {
    const plan = buildSpotClosePlan(row(), null, null, 100);
    expect(plan.quantity).toBe('0');
    expect(plan.referencePrice).toBeNull();
    expect(plan.estimatedProceeds).toBeNull();
    expect(plan.issues).toContain('No tradable spot market for this balance.');
    expect(plan.issues).toContain('No live price for this market.');
  });
});

describe('spotCloseAvailable', () => {
  it('is true only when the balance can fill at least one lot', () => {
    expect(spotCloseAvailable(row(), spotInstrument('GATE_SPOT_ADA_USDT'))).toBe(true);
    expect(spotCloseAvailable(row({ available: 1 }), spotInstrument('GATE_SPOT_ADA_USDT'))).toBe(true);
    expect(spotCloseAvailable(row({ available: 0.999 }), spotInstrument('GATE_SPOT_ADA_USDT'))).toBe(false);
  });

  it('is false without a matching instrument', () => {
    expect(spotCloseAvailable(row(), null)).toBe(false);
  });
});

// 现货做空 = CrossEx 记的币种负债，持仓行是负数；平仓必须反向买入，且买单在 Gate 上以计价货币
// (quote_qty) 计价 —— 此前固定发 SELL，既卖不掉空头也永远关不掉。
describe('spot short buy-back', () => {
  /** A short row as the trade page builds it: total/available both −liability. */
  function shortRow(liability: number, overrides: Partial<SpotHoldingsRow> = {}): SpotHoldingsRow {
    return { venue: 'GATE', coin: 'ADA', total: -liability, available: -liability, locked: 0, valuationUsd: null, ...overrides };
  }

  it('plans a market buy of the whole liability, floored to the lot size', () => {
    const plan = buildSpotClosePlan(shortRow(55.4), spotInstrument('GATE_SPOT_ADA_USDT'), market('GATE_SPOT_ADA_USDT'), 100);
    expect(plan.side).toBe('BUY');
    // lot 1 → 55，绝不多买（多买会把空头变成长头）。
    expect(plan.quantity).toBe('55');
    // Gate 现货市价买单以计价货币下单：55 × ask(0.401)。
    expect(plan.quoteQty).toBe('22.055');
    expect(plan.issues).toEqual([]);
    expect(plan.estimatedProceeds).toBeCloseTo(22.055, 6);
  });

  it('prices a buy-back from the ask, not the bid', () => {
    const plan = buildSpotClosePlan(shortRow(10), spotInstrument('GATE_SPOT_ADA_USDT'), market('GATE_SPOT_ADA_USDT'), 100);
    expect(plan.referencePrice).toBeCloseTo(0.401, 8);
  });

  it('lets a partial short close carry the matching quote amount', () => {
    const plan = buildSpotClosePlan(shortRow(100), spotInstrument('GATE_SPOT_ADA_USDT'), market('GATE_SPOT_ADA_USDT'), 25);
    expect(plan.side).toBe('BUY');
    expect(plan.quantity).toBe('25');
    expect(plan.quoteQty).toBe('10.025');
  });

  it('offers the buy-back whenever the debt fills at least one lot', () => {
    expect(spotCloseAvailable(shortRow(3), spotInstrument('GATE_SPOT_ADA_USDT'))).toBe(true);
    expect(spotCloseAvailable(shortRow(0.4), spotInstrument('GATE_SPOT_ADA_USDT'))).toBe(false);
  });

  it('blocks a buy-back when the market cannot be sized', () => {
    const plan = buildSpotClosePlan(shortRow(10), null, null, 100);
    expect(plan.side).toBe('BUY');
    expect(plan.quantity).toBe('0');
    expect(plan.quoteQty).toBeNull();
    expect(plan.issues).toContain('No spot market on this exchange to buy this debt back.');
    expect(plan.issues).toContain('No live price for this market.');
  });

  // 计价币负债与计价币持仓是两回事：持仓卖出去只是换汇（不给平仓按钮），负债则要买回来还掉。
  // GATE/BINANCE/OKX/BYBIT 都挂了 USDC/USDT，所以那里的 USDC 负债是能一键买回的。
  it('lets a quote-currency debt be bought back when the venue lists the pair', () => {
    const usdcDebt = shortRow(50, { coin: 'USDC' });
    // 6 位小数是 USDC/USDT 这类市场的真实 lot 精度，数量按 lot 对齐后再发单。
    const instrument = spotInstrument('GATE_SPOT_USDC_USDT', { lotSize: '0.000001' });
    expect(spotCloseBlocker(usdcDebt, instrument)).toBeNull();
    expect(spotCloseAvailable(usdcDebt, instrument)).toBe(true);
    const plan = buildSpotClosePlan(usdcDebt, instrument, market('GATE_SPOT_USDC_USDT'), 100);
    expect(plan.side).toBe('BUY');
    expect(plan.quantity).toBe('50.000000');
    expect(plan.issues).toEqual([]);
  });

  it('still refuses to close a quote-currency holding as a position', () => {
    expect(spotCloseBlocker(row({ coin: 'USDC' }), spotInstrument('GATE_SPOT_USDC_USDT')))
      .toBe('Quote balances cannot be closed as a spot position.');
  });

  // 实测：HYPERLIQUID 目录里只有 FUTURE，没有任何 SPOT/MARGIN 市场，USDC 负债在这里无法买回。
  // 这时按钮不能只是灰掉 —— 必须报出「该所没有可买回的现货市场」，由调用方给归还路径。
  it('names the missing market for a debt the exchange cannot buy back', () => {
    const debtOnPerpOnlyVenue = shortRow(12.326910255, { venue: 'HYPERLIQUID', coin: 'USDC' });
    expect(spotCloseBlocker(debtOnPerpOnlyVenue, null)).toBe('No spot market on this exchange to buy this debt back.');
    expect(spotCloseAvailable(debtOnPerpOnlyVenue, null)).toBe(false);
  });

  it('does not treat a long with an exhausted available balance as a short', () => {
    // 保证金耗尽的永续所行：balance 为正、available 为负，不能反向买入。
    const exhausted = row({ total: 0.07916106, available: -12.326910255, locked: 12.406071315 });
    expect(spotCloseAvailable(exhausted, spotInstrument('GATE_SPOT_ADA_USDT'))).toBe(false);
    const plan = buildSpotClosePlan(exhausted, spotInstrument('GATE_SPOT_ADA_USDT'), market('GATE_SPOT_ADA_USDT'), 100);
    expect(plan.side).toBe('SELL');
    expect(plan.quantity).toBe('0');
    expect(plan.quoteQty).toBeNull();
  });

  it('keeps the sell path on the bid and without a quote amount', () => {
    const plan = buildSpotClosePlan(row(), spotInstrument('GATE_SPOT_ADA_USDT'), market('GATE_SPOT_ADA_USDT'), 100);
    expect(plan.side).toBe('SELL');
    expect(plan.quoteQty).toBeNull();
    expect(plan.referencePrice).toBeCloseTo(0.4, 8);
  });
});
