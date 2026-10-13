import { describe, expect, it } from 'vitest';
import { computeStrategyPnl, type StrategyFillInput } from './strategy-pnl.js';

function fill(partial: Partial<StrategyFillInput> & Pick<StrategyFillInput, 'side' | 'quantity' | 'price'>): StrategyFillInput {
  return {
    symbol: 'GATE_FUTURE_CXMT_USDT', venue: 'GATE', fee: '0', createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('computeStrategyPnl', () => {
  // ① One venue, one round trip. Hand arithmetic:
  //    realized = (110 − 100) × 1 = 10; fees = 0.05 + 0.055 = 0.105;
  //    net = 10 − 0.105 = 9.895; locked bps = 9.895 / (1 × 100) × 10000 = 989.5.
  it('marks a closed perpetual round trip with fees and locked-profit bps', () => {
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.05', createdAt: '2026-01-01T00:00:00.000Z' }),
        fill({ side: 'SELL', quantity: '1', price: '110', fee: '0.055', createdAt: '2026-01-01T00:01:00.000Z' }),
      ],
      marks: new Map([['GATE_FUTURE_CXMT_USDT', '110']]),
      fundingFeeUsdt: '0',
    });

    expect(pnl).toMatchObject({
      realizedPnl: '10',
      unrealizedPnl: '0',
      feesPaid: '0.105',
      fundingFeeUsdt: '0',
      netPnl: '9.895',
      closedEntryNotionalUsdt: '100',
      entryNotionalUsdt: '100',
      lockedProfitBps: '989.5',
    });
  });

  // ② The spot leg carries no `realized_pnl` in the database (always stored as '0'), so the rebuild
  //    must produce it from the fills alone. Short 0.1 @ 50000 then buy back @ 49000:
  //    realized = (49000 − 50000) × 0.1 × −1 = 100; fees = 2; locked bps = 98 / 5000 × 10000 = 196.
  it('rebuilds the realized result for a spot leg that reports no realized_pnl', () => {
    const pnl = computeStrategyPnl({
      fills: [
        fill({ symbol: 'BINANCE_SPOT_BTC_USDT', venue: 'BINANCE', side: 'SELL', quantity: '0.1', price: '50000', fee: '1', createdAt: '2026-01-01T00:00:00.000Z' }),
        fill({ symbol: 'BINANCE_SPOT_BTC_USDT', venue: 'BINANCE', side: 'BUY', quantity: '0.1', price: '49000', fee: '1', createdAt: '2026-01-01T00:02:00.000Z' }),
      ],
      marks: new Map([['BINANCE_SPOT_BTC_USDT', '49000']]),
      fundingFeeUsdt: '0',
    });

    expect(pnl).toMatchObject({
      realizedPnl: '100',
      unrealizedPnl: '0',
      feesPaid: '2',
      netPnl: '98',
      closedEntryNotionalUsdt: '5000',
      lockedProfitBps: '196',
    });
  });

  // ③ Flip through zero: long 1 @ 100 filled by a sell of 2 @ 120. The first unit closes at +20,
  //    the remainder opens a fresh short at 120. Fees split 50/50 across the two halves.
  //    marked at 100 the short is +20; net = 20 + 20 − 0.3 = 39.7; locked bps = 19.8/100×10000 = 1980.
  it('allocates fees and average price correctly across a direction flip', () => {
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.1', createdAt: '2026-01-01T00:00:00.000Z' }),
        fill({ side: 'SELL', quantity: '2', price: '120', fee: '0.2', createdAt: '2026-01-01T00:01:00.000Z' }),
      ],
      marks: new Map([['GATE_FUTURE_CXMT_USDT', '100']]),
      fundingFeeUsdt: '0',
    });

    expect(pnl).toMatchObject({
      realizedPnl: '20',
      unrealizedPnl: '20',
      feesPaid: '0.3',
      netPnl: '39.7',
      closedEntryNotionalUsdt: '100',
      entryNotionalUsdt: '220',
      lockedProfitBps: '1980',
    });
  });

  // ④ A missing mark makes the open figure unavailable — null, explicitly NOT 0.
  it('returns null (not zero) for unrealized and net PnL when a mark is missing', () => {
    const pnl = computeStrategyPnl({
      fills: [fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.1' })],
      marks: new Map(),
      fundingFeeUsdt: '0',
    });

    expect(pnl.realizedPnl).toBe('0');
    expect(pnl.unrealizedPnl).toBeNull();
    expect(pnl.unrealizedPnl).not.toBe('0');
    expect(pnl.netPnl).toBeNull();
  });

  // ⑤ Nothing has been closed yet: no cost basis to express a locked result against.
  it('reports a null locked-profit bps and a zero closed notional before any close', () => {
    const pnl = computeStrategyPnl({
      fills: [fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.1' })],
      marks: new Map([['GATE_FUTURE_CXMT_USDT', '105']]),
      fundingFeeUsdt: '0',
    });

    expect(pnl.realizedPnl).toBe('0');
    expect(pnl.closedEntryNotionalUsdt).toBe('0');
    expect(pnl.lockedProfitBps).toBeNull();
    expect(pnl.unrealizedPnl).toBe('5');
    expect(pnl.netPnl).toBe('4.9');
  });

  // ⑥ Funding: null counts as 0 inside the arithmetic (hence netPnl still exists), a positive value
  //    is a charge, a negative value is a credit. Funding also flows into the locked bps.
  it('applies null, charged and collected funding to net and locked PnL', () => {
    const roundTrip = () => [
      fill({ side: 'BUY', quantity: '1', price: '100', createdAt: '2026-01-01T00:00:00.000Z' }),
      fill({ side: 'SELL', quantity: '1', price: '110', createdAt: '2026-01-01T00:01:00.000Z' }),
    ];
    const marks = new Map([['GATE_FUTURE_CXMT_USDT', '110']]);

    const unavailable = computeStrategyPnl({ fills: roundTrip(), marks, fundingFeeUsdt: null });
    expect(unavailable.fundingFeeUsdt).toBeNull();
    expect(unavailable.netPnl).toBe('10');
    expect(unavailable.lockedProfitBps).toBe('1000');

    const charged = computeStrategyPnl({ fills: roundTrip(), marks, fundingFeeUsdt: '1' });
    expect(charged.netPnl).toBe('9');
    expect(charged.lockedProfitBps).toBe('900');

    const collected = computeStrategyPnl({ fills: roundTrip(), marks, fundingFeeUsdt: '-2' });
    expect(collected.netPnl).toBe('12');
    expect(collected.lockedProfitBps).toBe('1200');
  });

  // Fees are stored unsigned-positive = cost, and are summed as-is (no abs, no sign flip). A
  // negative fee (a rebate) therefore correctly reduces the cost instead of being normalised away.
  it('sums fees as positive costs and lets a rebate pass through', () => {
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.1', createdAt: '2026-01-01T00:00:00.000Z' }),
        fill({ side: 'SELL', quantity: '1', price: '100', fee: '-0.05', createdAt: '2026-01-01T00:01:00.000Z' }),
      ],
      marks: new Map([['GATE_FUTURE_CXMT_USDT', '100']]),
      fundingFeeUsdt: '0',
    });

    expect(pnl.feesPaid).toBe('0.05');
    expect(pnl.realizedPnl).toBe('0');
    expect(pnl.netPnl).toBe('-0.05');
  });

  // The replay is timestamp-ordered: handing the same fills in reverse must not change the result.
  it('replays out-of-order fills in chronological order', () => {
    const orderedFills = [
      fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.05', createdAt: '2026-01-01T00:00:00.000Z' }),
      fill({ side: 'BUY', quantity: '1', price: '120', fee: '0.06', createdAt: '2026-01-01T00:01:00.000Z' }),
      fill({ side: 'SELL', quantity: '2', price: '130', fee: '0.13', createdAt: '2026-01-01T00:02:00.000Z' }),
    ];
    const marks = new Map([['GATE_FUTURE_CXMT_USDT', '130']]);

    const inOrder = computeStrategyPnl({ fills: orderedFills, marks, fundingFeeUsdt: '0' });
    const reversed = computeStrategyPnl({ fills: [...orderedFills].reverse(), marks, fundingFeeUsdt: '0' });

    // avg entry = (100 + 120)/2 = 110; realized = (130 − 110) × 2 = 40.
    expect(inOrder.realizedPnl).toBe('40');
    expect(reversed.realizedPnl).toBe('40');
    expect(reversed.netPnl).toBe(inOrder.netPnl);
    expect(reversed.closedEntryNotionalUsdt).toBe(inOrder.closedEntryNotionalUsdt);
  });
});
