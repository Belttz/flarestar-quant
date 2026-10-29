import { describe, expect, it } from 'vitest';
import type { FundingOverviewResponse } from '@gate-crossex/shared-types';
import {
  autoSizingBudget,
  buildFundingArbCandidates,
  dynamicEntryBps,
  executableEntrySpreadBps,
  perSettlementFundingBps,
  roundTripCostBps,
  selectBestCandidateKeys,
  settlementInMs,
  sizePerpHedge,
} from './funding-arb-scan.js';

function overview(assets: FundingOverviewResponse['assets']): FundingOverviewResponse {
  return {
    assets,
    venueStatus: [],
    fetchedAt: '2026-10-27T16:00:00.000Z',
    cacheStatus: 'fresh',
  };
}

const NOW = Date.parse('2026-10-27T16:00:00.000Z');

describe('perp ⇄ perp funding candidates', () => {
  it('orients the pair toward the higher funding venue and annualizes the differential', () => {
    const rows = buildFundingArbCandidates(overview([{
      asset: 'ETH',
      venues: [
        {
          venue: 'OKX', symbol: 'OKX_FUTURE_ETH_USDT', quote: 'USDT', fundingRate: '0.0001',
          fundingIntervalHours: 8, fundingRate8h: '0.0001', nextFundingAt: '2026-10-27T16:00:00.000Z',
          openInterestValue: '1000000', lastPrice: '3000', change24h: '0', fetchedAt: '2026-10-27T15:59:00.000Z',
        },
        {
          venue: 'BYBIT', symbol: 'BYBIT_FUTURE_ETH_USDT', quote: 'USDT', fundingRate: '0.0005',
          fundingIntervalHours: 8, fundingRate8h: '0.0005', nextFundingAt: '2026-10-27T16:00:00.000Z',
          openInterestValue: '2000000', lastPrice: '3001', change24h: '0', fetchedAt: '2026-10-27T15:59:00.000Z',
        },
      ],
    }]));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.shortVenue).toBe('BYBIT');
    expect(row.longVenue).toBe('OKX');
    expect(row.net8h).toBe('0.0004');
    expect(row.aprPercent).toBeCloseTo(43.8, 6);
    expect(row.verdict).toBe('REJECT');
  });

  it('drops a venue whose funding rate is missing instead of treating it as zero', () => {
    const rows = buildFundingArbCandidates(overview([{
      asset: 'BTC',
      venues: [
        {
          venue: 'BYBIT', symbol: 'BYBIT_FUTURE_BTC_USDT', quote: 'USDT', fundingRate: null,
          fundingIntervalHours: null, fundingRate8h: null, nextFundingAt: null,
          openInterestValue: null, lastPrice: '95000', change24h: null, fetchedAt: null,
        },
        {
          venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT', quote: 'USDT', fundingRate: '0.0001',
          fundingIntervalHours: 8, fundingRate8h: '0.0001', nextFundingAt: '2026-10-27T16:00:00.000Z',
          openInterestValue: null, lastPrice: '95001', change24h: null, fetchedAt: null,
        },
      ],
    }]));
    expect(rows).toHaveLength(0);
  });

  it('honours the venue whitelist', () => {
    const rows = buildFundingArbCandidates(overview([{
      asset: 'SOL',
      venues: [
        {
          venue: 'BYBIT', symbol: 'BYBIT_FUTURE_SOL_USDT', quote: 'USDT', fundingRate: '0.0005',
          fundingIntervalHours: 8, fundingRate8h: '0.0005', nextFundingAt: null,
          openInterestValue: null, lastPrice: '200', change24h: null, fetchedAt: null,
        },
        {
          venue: 'OKX', symbol: 'OKX_FUTURE_SOL_USDT', quote: 'USDT', fundingRate: '0.0001',
          fundingIntervalHours: 8, fundingRate8h: '0.0001', nextFundingAt: null,
          openInterestValue: null, lastPrice: '201', change24h: null, fetchedAt: null,
        },
      ],
    }]), ['OKX']);
    expect(rows).toHaveLength(0);
  });
});

describe('dynamic entry and sizing', () => {
  it('derives the entry trigger from the executable spread minus the slippage buffer', () => {
    expect(executableEntrySpreadBps('100.2', '100')).toBeCloseTo(20, 6);
    expect(dynamicEntryBps(20, 5)).toBe('15.0000');
    expect(dynamicEntryBps(-3, 5)).toBe('-8.0000');
  });

  it('sizes the hedge from margin, leverage and the per-trade cap', () => {
    const size = sizePerpHedge({
      availableMarginUsd: 1000,
      safetyFactor: 0.9,
      maxPerTradeUsd: 200,
      leftLeverage: 5,
      rightLeverage: 5,
      price: 100,
      lotSize: '0.1',
      minSize: '0.1',
      minNotional: '10',
      maxMarketSize: '1000',
    });
    expect(size.ok).toBe(true);
    if (!size.ok) return;
    expect(size.notionalUsd).toBeCloseTo(200, 6);
    expect(size.quantity).toBe('2');
    expect(size.leverage).toBe(5);
  });

  it('rejects a size below the minimum notional / lot', () => {
    const size = sizePerpHedge({
      availableMarginUsd: 1000,
      safetyFactor: 0.9,
      maxPerTradeUsd: 5,
      leftLeverage: 5,
      rightLeverage: 5,
      price: 100,
      lotSize: '0.1',
      minSize: '0.1',
      minNotional: '10',
      maxMarketSize: null,
    });
    expect(size.ok).toBe(false);
    if (size.ok) return;
    expect(size.reason).toBe('SIZE_TOO_SMALL');
  });

  it('rejects when no margin is available', () => {
    const size = sizePerpHedge({
      availableMarginUsd: 0,
      safetyFactor: 0.9,
      maxPerTradeUsd: 200,
      leftLeverage: 5,
      rightLeverage: 5,
      price: 100,
      lotSize: null,
      minSize: null,
      minNotional: null,
      maxMarketSize: null,
    });
    expect(size.ok).toBe(false);
  });

  it('auto-sizes 90% of equity across the remaining planned slots', () => {
    const budget = autoSizingBudget({
      equityUsd: 92.21,
      availableMarginUsd: 92.21,
      usedMarginUsd: 0,
      plannedPositions: 3,
      openPositions: 0,
      bufferPct: 0.10,
    });
    expect(budget.bufferUsd).toBeCloseTo(9.221, 6);
    expect(budget.targetUsedUsd).toBeCloseTo(82.989, 6);
    expect(budget.remainingSlots).toBe(3);
    expect(budget.budgetPerSlotUsd).toBeCloseTo(27.663, 6);
  });

  it('uses each leg’s own maximum leverage when sizing', () => {
    const size = sizePerpHedge({
      availableMarginUsd: 300,
      safetyFactor: 1,
      maxPerTradeUsd: null,
      leftLeverage: 20,
      rightLeverage: 10,
      price: 100,
      lotSize: '0.1',
      minSize: '0.1',
      minNotional: '10',
      maxMarketSize: null,
    });
    expect(size.ok).toBe(true);
    if (!size.ok) return;
    expect(size.notionalUsd).toBeCloseTo(2000, 6);
    expect(size.leftMarginUsd).toBeCloseTo(100, 6);
    expect(size.rightMarginUsd).toBeCloseTo(200, 6);
    expect(size.leverage).toBe(10);
  });

  it('reserves one slot for every still-empty planned position', () => {
    const budget = autoSizingBudget({
      equityUsd: 1000,
      availableMarginUsd: 400,
      usedMarginUsd: 600,
      plannedPositions: 3,
      openPositions: 2,
      bufferPct: 0.10,
    });
    expect(budget.remainingSlots).toBe(1);
    expect(budget.remainingBudgetUsd).toBeCloseTo(300, 6);
    expect(budget.budgetPerSlotUsd).toBeCloseTo(300, 6);
  });
});

describe('same-asset candidate selection', () => {
  it('keeps only the highest-ranked pair for an asset', () => {
    const rows = buildFundingArbCandidates(overview([{
      asset: 'ETH',
      venues: [
        {
          venue: 'OKX', symbol: 'OKX_FUTURE_ETH_USDT', quote: 'USDT', fundingRate: '0.0001',
          fundingIntervalHours: 8, fundingRate8h: '0.0001', nextFundingAt: null,
          openInterestValue: null, lastPrice: '3000', change24h: null, fetchedAt: null,
        },
        {
          venue: 'BYBIT', symbol: 'BYBIT_FUTURE_ETH_USDT', quote: 'USDT', fundingRate: '0.0005',
          fundingIntervalHours: 8, fundingRate8h: '0.0005', nextFundingAt: null,
          openInterestValue: null, lastPrice: '3001', change24h: null, fetchedAt: null,
        },
        {
          venue: 'KRAKEN', symbol: 'KRAKEN_FUTURE_ETH_USD', quote: 'USD', fundingRate: '0.0003',
          fundingIntervalHours: 8, fundingRate8h: '0.0003', nextFundingAt: null,
          openInterestValue: null, lastPrice: '3002', change24h: null, fetchedAt: null,
        },
      ],
    }]));
    expect(rows).toHaveLength(3);
    expect([...selectBestCandidateKeys(rows)]).toEqual(['ETH:BYBIT:OKX']);
  });
});

describe('settlement math', () => {
  it('uses the later of the two legs\u2019 next settlements', () => {
    const later = new Date(NOW + 5 * 3_600_000).toISOString();
    const earlier = new Date(NOW + 2 * 3_600_000).toISOString();
    expect(settlementInMs(earlier, later, NOW)).toBe(5 * 3_600_000);
    expect(settlementInMs(null, later, NOW)).toBeNull();
  });

  it('converts APR into the per-settlement bps and the round-trip cost', () => {
    expect(perSettlementFundingBps(1095)).toBeCloseTo(100, 6);
    expect(roundTripCostBps(4.8, 2)).toBeCloseTo(27.2, 6);
  });
});
