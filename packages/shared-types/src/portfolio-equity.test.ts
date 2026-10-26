import { describe, expect, it } from 'vitest';
import {
  PORTFOLIO_EQUITY_BUCKET_MS,
  PORTFOLIO_EQUITY_RANGE_MS,
  PORTFOLIO_EQUITY_RETENTION_MS,
  PortfolioEquityPointSchema,
  PortfolioEquityRangeSchema,
  PortfolioEquitySeriesResponseSchema,
  type PortfolioEquityBalanceInput,
  type PortfolioEquityPoint,
  accountEquityOf,
  downsampleEquityPoints,
  equityBucketStart,
  equityGranularityForRange,
  equityRangeWindow,
  portfolioEquitySampleFromSnapshot,
  sumDecimalStrings,
} from './portfolio-equity.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('PortfolioEquityRangeSchema', () => {
  it('accepts exactly the four UI ranges', () => {
    expect(PortfolioEquityRangeSchema.options).toEqual(['24h', '7d', '30d', 'all']);
    for (const range of ['24h', '7d', '30d', 'all'] as const) {
      expect(PortfolioEquityRangeSchema.parse(range)).toBe(range);
    }
    expect(() => PortfolioEquityRangeSchema.parse('90d')).toThrow();
  });
});

describe('PortfolioEquityPointSchema', () => {
  it('accepts a point with and without unrealised PnL', () => {
    expect(PortfolioEquityPointSchema.parse({ time: 0, equity: '1234.5', unrealizedPnl: '-2.25' })).toEqual({
      time: 0,
      equity: '1234.5',
      unrealizedPnl: '-2.25',
    });
    expect(PortfolioEquityPointSchema.parse({ time: 1, equity: '0', unrealizedPnl: null }).unrealizedPnl).toBeNull();
  });

  it('rejects negative or fractional timestamps', () => {
    expect(() => PortfolioEquityPointSchema.parse({ time: -1, equity: '1', unrealizedPnl: null })).toThrow();
    expect(() => PortfolioEquityPointSchema.parse({ time: 1.5, equity: '1', unrealizedPnl: null })).toThrow();
  });
});

describe('PortfolioEquitySeriesResponseSchema', () => {
  it('parses a full series and the empty-state response', () => {
    const parsed = PortfolioEquitySeriesResponseSchema.parse({
      range: '7d',
      granularity: 'hour',
      points: [{ time: DAY, equity: '100', unrealizedPnl: null }],
      firstSampleAt: '2026-01-01T00:00:00.000Z',
      fetchedAt: '2026-01-08T00:00:00.000Z',
    });
    expect(parsed.points).toHaveLength(1);

    const empty = PortfolioEquitySeriesResponseSchema.parse({
      range: 'all',
      granularity: 'day',
      points: [],
      firstSampleAt: null,
      fetchedAt: '2026-01-08T00:00:00.000Z',
    });
    expect(empty.points).toEqual([]);
    expect(empty.firstSampleAt).toBeNull();
  });
});

describe('equityGranularityForRange', () => {
  it('maps 24h to raw samples, 7d/30d to hourly buckets and all to daily buckets', () => {
    expect(equityGranularityForRange('24h')).toBe('raw');
    expect(equityGranularityForRange('7d')).toBe('hour');
    expect(equityGranularityForRange('30d')).toBe('hour');
    expect(equityGranularityForRange('all')).toBe('day');
  });

  it('exposes the bucket size and retention of every granularity', () => {
    expect(PORTFOLIO_EQUITY_BUCKET_MS.hour).toBe(HOUR);
    expect(PORTFOLIO_EQUITY_BUCKET_MS.day).toBe(DAY);
    expect(PORTFOLIO_EQUITY_RETENTION_MS.raw).toBe(7 * DAY);
    expect(PORTFOLIO_EQUITY_RETENTION_MS.hour).toBe(45 * DAY);
    expect(PORTFOLIO_EQUITY_RETENTION_MS.day).toBe(730 * DAY);
  });
});

describe('equityRangeWindow', () => {
  const now = 1_700_000_000_000;

  it('subtracts the range length from now', () => {
    expect(equityRangeWindow('24h', now).fromMs).toBe(now - PORTFOLIO_EQUITY_RANGE_MS['24h']);
    expect(equityRangeWindow('7d', now).fromMs).toBe(now - 7 * DAY);
    expect(equityRangeWindow('30d', now).fromMs).toBe(now - 30 * DAY);
  });

  it('starts at the beginning of time for the all range', () => {
    expect(equityRangeWindow('all', now).fromMs).toBe(0);
  });

  it('clamps at zero instead of going negative', () => {
    expect(equityRangeWindow('30d', 1_000).fromMs).toBe(0);
    expect(equityRangeWindow('24h', 0).fromMs).toBe(0);
  });

  it('survives a non-finite clock', () => {
    expect(equityRangeWindow('24h', Number.NaN).fromMs).toBe(0);
  });
});

describe('equityBucketStart', () => {
  it('floors a timestamp to the granularity bucket', () => {
    expect(equityBucketStart(DAY + 5 * HOUR + 1234, 'hour')).toBe(DAY + 5 * HOUR);
    expect(equityBucketStart(DAY + 5 * HOUR + 1234, 'day')).toBe(DAY);
  });

  it('keeps raw samples untouched', () => {
    expect(equityBucketStart(DAY + 1234, 'raw')).toBe(DAY + 1234);
  });
});

describe('sumDecimalStrings', () => {
  it('adds decimal strings without floating point drift', () => {
    expect(sumDecimalStrings(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimalStrings(['1.5', '-2.25', '0.75'])).toBe('0');
    expect(sumDecimalStrings(['1000000000000.000000001', '1'])).toBe('1000000000001.000000001');
  });

  it('skips unparseable operands and returns null when nothing is parseable', () => {
    expect(sumDecimalStrings(['1', 'n/a', '3'])).toBe('4');
    expect(sumDecimalStrings(['n/a', null, undefined])).toBeNull();
    expect(sumDecimalStrings([])).toBeNull();
  });
});

/**
 * The real 2026-10-26T12:09Z snapshot: a fully hedged TREAD pair (HYPERLIQUID short 250 /
 * KRAKEN long 250). Gate reports `marginBalance = 58.5366` for it, which is wrong — see
 * `accountEquityOf`.
 */
const liveBalances: readonly PortfolioEquityBalanceInput[] = [
  { venue: 'KRAKEN', coin: 'USDC', balance: '9.905', unrealizedPnl: '0.2822' },
  { venue: 'CROSSEX', coin: 'USDT', balance: '95.9641', unrealizedPnl: '0' },
  { venue: 'DERIBIT', coin: 'USDC', balance: '-12.6031', unrealizedPnl: '0' },
  { venue: 'LIGHTER', coin: 'USDC', balance: '0.3065', unrealizedPnl: '0' },
  // The DEX leg: Gate reports equity -34.3085 = 6.1625 - 40.4710 (locked margin never added back).
  { venue: 'HYPERLIQUID', coin: 'USDC', balance: '6.1625', unrealizedPnl: '-0.1044' },
  // Coin quantities, not dollars: they must never enter the sum.
  { venue: 'GATE', coin: 'ADA', balance: '0.9486', unrealizedPnl: '0' },
  { venue: 'GATE', coin: 'ONE', balance: '0.4914', unrealizedPnl: '0' },
  { venue: 'GATE', coin: 'SUI', balance: '0.0065', unrealizedPnl: '0' },
];

const liveFuturesPositions = [{ unrealizedPnl: '-0.1044' }];
const liveMarginPositions = [{ unrealizedPnl: '0.2822' }];

describe('accountEquityOf', () => {
  it('reproduces the live hedged-pair account as 99.9128 instead of Gate\'s 58.5366', () => {
    const equity = accountEquityOf(liveBalances, liveFuturesPositions, liveMarginPositions);
    // 9.905 + 95.9641 - 12.6031 + 0.3065 + 6.1625 = 99.735, plus 0.1778 of position PnL.
    expect(equity).toBe('99.9128');
    // The gap against Gate's marginBalance is the DEX leg's duplicated margin deduction: the
    // "account halves itself while a hedged pair is open" bug, pinned numerically.
    expect(Number(equity) - 58.5366).toBeCloseTo(41.3762, 4);
  });

  it('excludes non-stablecoin rows, whose balance is a coin quantity rather than a value', () => {
    expect(accountEquityOf(
      [
        { venue: 'GATE', coin: 'ADA', balance: '0.9486' },
        { venue: 'CROSSEX', coin: 'USDT', balance: '95.9641' },
      ],
      [],
      [],
    )).toBe('95.9641');
  });

  it('skips the isolated Gate spot account (venue SPOT)', () => {
    expect(accountEquityOf(
      [
        { venue: 'SPOT', coin: 'USDT', balance: '260.125' },
        { venue: 'CROSSEX', coin: 'USDT', balance: '95.9641' },
      ],
      [],
      [],
    )).toBe('95.9641');
  });

  it('uses the cash column even when a row equity disagrees with balance + uPnL', () => {
    // HYPERLIQUID reports equity -34.3085 for balance 6.1625; only the cash 6.1625 is asset value.
    expect(accountEquityOf(
      [{ venue: 'HYPERLIQUID', coin: 'USDC', balance: '6.1625', unrealizedPnl: '-0.1044' }],
      [],
      [],
    )).toBe('6.1625');
  });

  it('sums USDT, USDC and USD at 1:1 and ignores row-level unrealised PnL', () => {
    // 10 + 5 + 1 = 16; the row-level upnl (999) must not be counted — positions carry PnL.
    expect(accountEquityOf(
      [
        { venue: 'A', coin: 'USDT', balance: '10', unrealizedPnl: '999' },
        { venue: 'B', coin: 'USDC', balance: '5', unrealizedPnl: '999' },
        { venue: 'C', coin: 'USD', balance: '1', unrealizedPnl: '999' },
      ],
      [],
      [],
    )).toBe('16');
  });

  it('keeps position PnL when the cash side is missing and vice versa', () => {
    expect(accountEquityOf([], [{ unrealizedPnl: '20' }], [{ unrealizedPnl: '100' }])).toBe('120');
    expect(accountEquityOf([{ venue: 'A', coin: 'USDT', balance: '7' }], null, null)).toBe('7');
  });

  it('degrades to 0 when nothing is usable', () => {
    expect(accountEquityOf([], [], [])).toBe('0');
    expect(accountEquityOf(null, null, null)).toBe('0');
    expect(accountEquityOf(undefined, undefined, undefined)).toBe('0');
    expect(accountEquityOf([{ venue: 'GATE', coin: 'ADA', balance: '0.9486' }], [], [])).toBe('0');
    expect(accountEquityOf(
      [{ venue: 'A', coin: 'USDT', balance: 'n/a' as unknown as string }],
      [{ unrealizedPnl: null }],
      [],
    )).toBe('0');
  });
});

describe('portfolioEquitySampleFromSnapshot', () => {
  const snapshot = {
    account: { marginBalance: '58.5366' },
    balances: liveBalances,
    futuresPositions: liveFuturesPositions,
    marginPositions: liveMarginPositions,
  };

  it('takes equity from the balance rows plus position PnL, not from marginBalance', () => {
    const sample = portfolioEquitySampleFromSnapshot(snapshot, '2026-01-08T00:00:00.000Z');
    expect(sample.equity).toBe('99.9128');
    expect(sample.equity).not.toBe(snapshot.account.marginBalance);
    expect(sample.time).toBe(Date.parse('2026-01-08T00:00:00.000Z'));
  });

  it('sums unrealised PnL across futures and margin positions', () => {
    const sample = portfolioEquitySampleFromSnapshot(snapshot, 1_700_000_000_000);
    expect(sample.unrealizedPnl).toBe('0.1778');
  });

  it('yields a null PnL when no position carries a value', () => {
    const sample = portfolioEquitySampleFromSnapshot(
      { account: { marginBalance: '5' }, balances: [{ venue: 'A', coin: 'USDT', balance: '5' }] },
      1_700_000_000_000,
    );
    expect(sample.unrealizedPnl).toBeNull();
    expect(sample.equity).toBe('5');
  });

  it('degrades gracefully for missing accounts', () => {
    expect(portfolioEquitySampleFromSnapshot(null, 5).equity).toBe('0');
    expect(portfolioEquitySampleFromSnapshot(undefined, 5).equity).toBe('0');
    expect(portfolioEquitySampleFromSnapshot({}, new Date(0)).time).toBe(0);
  });

  it('produces a point that satisfies the wire schema', () => {
    const sample = portfolioEquitySampleFromSnapshot(snapshot, 1_700_000_000_000);
    expect(() => PortfolioEquityPointSchema.parse(sample)).not.toThrow();
  });
});

describe('downsampleEquityPoints', () => {
  const points: PortfolioEquityPoint[] = Array.from({ length: 100 }, (_unused, index) => ({
    time: index * HOUR,
    equity: String(index),
    unrealizedPnl: null,
  }));

  it('returns the input unchanged when it already fits', () => {
    expect(downsampleEquityPoints(points, 100)).toHaveLength(100);
    expect(downsampleEquityPoints(points, 500)).toHaveLength(100);
  });

  it('never exceeds the requested maximum', () => {
    expect(downsampleEquityPoints(points, 20).length).toBeLessThanOrEqual(20);
    expect(downsampleEquityPoints(points, 3).length).toBeLessThanOrEqual(3);
  });

  it('always keeps the first and the last point', () => {
    const thinned = downsampleEquityPoints(points, 12);
    expect(thinned[0]).toEqual(points[0]);
    expect(thinned[thinned.length - 1]).toEqual(points[points.length - 1]);
    expect(thinned[0].time).toBe(0);
    expect(thinned[thinned.length - 1].time).toBe(99 * HOUR);
  });

  it('preserves ascending time order', () => {
    const thinned = downsampleEquityPoints(points, 25);
    for (let index = 1; index < thinned.length; index += 1) {
      expect(thinned[index].time).toBeGreaterThan(thinned[index - 1].time);
    }
  });

  it('handles degenerate inputs', () => {
    expect(downsampleEquityPoints(points, 0)).toEqual([]);
    expect(downsampleEquityPoints([], 10)).toEqual([]);
    // A single point cannot carry both endpoints, so the newest sample wins.
    expect(downsampleEquityPoints(points, 1)).toEqual([points[points.length - 1]]);
  });

  it('keeps exactly the two endpoints for a two-point budget', () => {
    const thinned = downsampleEquityPoints(points, 2);
    expect(thinned).toHaveLength(2);
    expect(thinned[0]).toEqual(points[0]);
    expect(thinned[1]).toEqual(points[points.length - 1]);
  });

  it('never returns more points than the input holds', () => {
    const tiny = points.slice(0, 3);
    expect(downsampleEquityPoints(tiny, 10)).toEqual(tiny);
  });
});

describe('sumDecimalStrings edge forms', () => {
  it('accepts explicit signs and bare-fraction forms', () => {
    expect(sumDecimalStrings(['+2.5', '-0.5'])).toBe('2');
    expect(sumDecimalStrings(['.5', '.25'])).toBe('0.75');
    expect(sumDecimalStrings(['5.'])).toBe('5');
    expect(sumDecimalStrings(['-.5'])).toBe('-0.5');
  });

  it('sums an all-zero selection to zero instead of null', () => {
    expect(sumDecimalStrings(['0', '0.0'])).toBe('0');
    // But a selection with only unparseable text stays null (no data).
    expect(sumDecimalStrings(['0x10', '1e5', ''])).toBeNull();
  });
});
