import { describe, expect, it } from 'vitest';
import { deficitsOf, planDeficitSettlements } from './deficit-settlement.js';

const USDC_RULE = { coin: 'USDC', minimumAmount: '11', estimatedFee: '1', disabled: false };
const USDT_RULE = { coin: 'USDT', minimumAmount: '1', estimatedFee: '0', disabled: false };

function asset(venue: string, coin: string, balance: string, availableBalance = balance) {
  return { venue, coin, balance, availableBalance };
}

describe('planDeficitSettlements', () => {
  it('ignores balances that are negative only after margin is deducted', () => {
    // A negative *available* with a non-negative balance is margin in use, not a deficit.
    expect(deficitsOf([asset('HYPERLIQUID', 'USDC', '6', '-13.5')])).toHaveLength(0);
    expect(deficitsOf([asset('DERIBIT', 'USDC', '-12.6')])).toHaveLength(1);
  });

  it('funds a USDC deficit from spot, adding the withdrawal fee on top of the debt', () => {
    const plan = planDeficitSettlements({
      assets: [asset('DERIBIT', 'USDC', '-12.6')],
      coins: [USDC_RULE],
      accountMode: 'CROSS_EXCHANGE',
      spotBalances: [{ coin: 'USDC', available: '100' }],
    });
    expect(plan.skipped).toHaveLength(0);
    expect(plan.legs).toEqual([{
      coin: 'USDC',
      from: 'SPOT',
      to: 'CROSSEX_DERIBIT',
      // 12.6 owed + 1 fee, so the destination is credited the full 12.6.
      amount: '13.6',
      deficit: '12.6',
      fee: '1',
    }]);
  });

  it('never routes USDC through the CROSSEX margin account', () => {
    const plan = planDeficitSettlements({
      assets: [asset('DERIBIT', 'USDC', '-12.6')],
      coins: [USDC_RULE],
      accountMode: 'CROSS_EXCHANGE',
      // Nothing at spot: the only remaining cash is the USDT margin account, and Gate forbids
      // USDC transfers that touch CROSSEX.
      crossExAvailable: '95',
    });
    expect(plan.legs).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ venue: 'DERIBIT', coin: 'USDC', reason: 'no_route' });
  });

  it('honours the SPOT-only rule for Hyperliquid USDC', () => {
    const plan = planDeficitSettlements({
      assets: [
        asset('HYPERLIQUID', 'USDC', '-3'),
        // Another venue holding USDC is NOT a legal source: HL USDC only moves to/from SPOT.
        asset('BINANCE', 'USDC', '50'),
      ],
      coins: [USDC_RULE],
      accountMode: 'CROSS_EXCHANGE',
    });
    expect(plan.legs).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ venue: 'HYPERLIQUID', reason: 'no_route' });
  });

  it('skips a deficit whose transfer would fall below the coin minimum', () => {
    const plan = planDeficitSettlements({
      // 2 owed + 1 fee is under the 11 USDC minimum, so Gate would reject the transfer.
      assets: [asset('DERIBIT', 'USDC', '-2')],
      coins: [USDC_RULE],
      accountMode: 'CROSS_EXCHANGE',
      spotBalances: [{ coin: 'USDC', available: '100' }],
    });
    expect(plan.legs).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ venue: 'DERIBIT', coin: 'USDC', reason: 'below_minimum' });
  });

  it('reports a USDT venue deficit as unroutable: USDT only moves between spot and CROSSEX', () => {
    // Gate's route rule (crossExTransferRouteError) allows USDT only SPOT <-> CROSSEX, so a venue
    // that owes USDT cannot be funded by a transfer at all — the UI must say so instead of
    // offering a button that will be rejected.
    const plan = planDeficitSettlements({
      assets: [asset('OKX', 'USDT', '-5')],
      coins: [USDT_RULE],
      accountMode: 'CROSS_EXCHANGE',
      crossExAvailable: '95.96',
    });
    expect(plan.legs).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ venue: 'OKX', coin: 'USDT', reason: 'no_route' });
  });

  it('reports a deficit it cannot reach with any source balance', () => {
    const plan = planDeficitSettlements({
      assets: [asset('DERIBIT', 'USDC', '-40')],
      coins: [USDC_RULE],
      accountMode: 'CROSS_EXCHANGE',
      spotBalances: [{ coin: 'USDC', available: '5' }],
    });
    expect(plan.legs).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ venue: 'DERIBIT', reason: 'no_source' });
  });

  it('does not move a disabled coin', () => {
    const plan = planDeficitSettlements({
      assets: [asset('DERIBIT', 'USDC', '-12.6')],
      coins: [{ ...USDC_RULE, disabled: true }],
      accountMode: 'CROSS_EXCHANGE',
      spotBalances: [{ coin: 'USDC', available: '100' }],
    });
    expect(plan.legs).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ reason: 'coin_disabled' });
  });
});
