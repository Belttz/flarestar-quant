import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { MemoryCredentialVault } from './credential-vault.js';
import { TradingSession } from './trading-session.js';
import { TradingRuntime } from './trading-runtime.js';
import { computeStrategyPnl, type StrategyFillInput } from './strategy-pnl.js';

/**
 * QA adversarial suite for the strategy PnL rebuild (`strategy-pnl.ts` + its `trading-runtime.ts`
 * wiring). Written independently of the implementation's own `strategy-pnl.test.ts`; every number
 * below is hand-derived from the spec, not copied from the implementation.
 *
 * Where the implementation deviates from the spec the assertion is written to PIN the observed
 * behaviour together with a `SPEC DEVIATION` comment, so the whole file stays runnable and the
 * deviation is reported rather than silently absorbed. Those cases are called out in the QA report.
 */

function fill(
  partial: Partial<StrategyFillInput> & Pick<StrategyFillInput, 'side' | 'quantity' | 'price'>,
): StrategyFillInput {
  return {
    symbol: 'GATE_FUTURE_CXMT_USDT', venue: 'GATE', fee: '0',
    createdAt: '2026-01-01T00:00:00.000Z', ...partial,
  };
}

const SYMBOL = 'GATE_FUTURE_CXMT_USDT';

function at(second: number): string {
  return `2026-01-01T00:${String(second).padStart(2, '0')}:00.000Z`;
}

/**
 * `lockedProfitBps = (realizedPnl − closedFee − funding) / closedEntryNotional × 10000`, solved for
 * the fee the closed part actually absorbed. `closedFee` is not part of the public contract, so it
 * can only be recovered this way — accurate to the 20-significant-digit rounding of `lockedProfitBps`
 * (hence the tolerance on the assertions that reverse it).
 */
function inferredClosedFee(pnl: { realizedPnl: string; lockedProfitBps: string | null; closedEntryNotionalUsdt: string }, funding = '0'): Decimal | null {
  if (pnl.lockedProfitBps === null) return null;
  return new Decimal(pnl.realizedPnl)
    .minus(funding)
    .minus(new Decimal(pnl.lockedProfitBps).mul(pnl.closedEntryNotionalUsdt).div(10000));
}

/** The lock figure the spec mandates, built from a hand-derived `closedFee`. */
function expectedLockedBps(realized: string, closedFee: string, closedNotional: string, funding = '0'): string {
  return new Decimal(realized).minus(closedFee).minus(funding).div(closedNotional).mul(10000).toString();
}

function assertClosedFeeConserved(pnl: { realizedPnl: string; lockedProfitBps: string | null; closedEntryNotionalUsdt: string; feesPaid: string }, funding = '0'): void {
  const inferred = inferredClosedFee(pnl, funding)!;
  const diff = inferred.minus(pnl.feesPaid).abs();
  // 1e-15 absolute: the reversal above multiplies a 20-significant-digit quotient back up.
  expect(diff.lt('1e-15')).toBe(true);
}

// ---------------------------------------------------------------- B: fee conservation

describe('QA-B fee conservation (all fees must land on the closed part once flat)', () => {
  it('B1: a multi-lot round trip splits every fee onto the closed part', () => {
    // BUY 2@100 (0.2) + BUY 3@110 (0.33) ⇒ avg 106; SELL 5@120 (0.6).
    // realized = (120 − 106) × 5 = 70; closedNotional = 5 × 106 = 530; closedFee = 0.53 + 0.6 = 1.13.
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '2', price: '100', fee: '0.2', createdAt: at(0) }),
        fill({ side: 'BUY', quantity: '3', price: '110', fee: '0.33', createdAt: at(1) }),
        fill({ side: 'SELL', quantity: '5', price: '120', fee: '0.6', createdAt: at(2) }),
      ],
      marks: new Map([[SYMBOL, '120']]),
      fundingFeeUsdt: '0',
    });

    expect(pnl.realizedPnl).toBe('70');
    expect(pnl.closedEntryNotionalUsdt).toBe('530');
    expect(pnl.entryNotionalUsdt).toBe('530');
    expect(pnl.feesPaid).toBe('1.13');
    expect(pnl.unrealizedPnl).toBe('0');
    expect(pnl.lockedProfitBps).toBe(expectedLockedBps('70', '1.13', '530'));
    // closedFee recovered exactly 1.13 = feesPaid ⇒ nothing leaked to the (empty) open side.
    expect(inferredClosedFee(pnl)!.toString()).toBe('1.13');
  });

  it('B2: a flip through zero conserves fees across both halves of the crossing fill', () => {
    // BUY 1@100 (0.1); SELL 2@120 (0.2) ⇒ closes 1 (+20) and opens 1 short @120; BUY 1@130 (0.3) closes it (−10).
    // closedFee = 0.1 (released open fee) + 0.2×½ (crossing fill, closed half) + 0.2×½ (crossing fill, reopened half) + 0.3 = 0.6
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.1', createdAt: at(0) }),
        fill({ side: 'SELL', quantity: '2', price: '120', fee: '0.2', createdAt: at(1) }),
        fill({ side: 'BUY', quantity: '1', price: '130', fee: '0.3', createdAt: at(2) }),
      ],
      marks: new Map([[SYMBOL, '130']]),
      fundingFeeUsdt: '0',
    });

    expect(pnl.realizedPnl).toBe('10');
    expect(pnl.feesPaid).toBe('0.6');
    expect(pnl.closedEntryNotionalUsdt).toBe('220');
    expect(pnl.unrealizedPnl).toBe('0');
    expect(pnl.lockedProfitBps).toBe(expectedLockedBps('10', '0.6', '220'));
    assertClosedFeeConserved(pnl);
  });

  it('B3: a partially closed position keeps the open share of the fee out of the closed figure', () => {
    // BUY 2@100 (0.4) ⇒ openFeeAccrued 0.4; SELL 1@110 (0.3) closes half the size.
    // closedFee = 0.4 × (1/2) + 0.3 × (1/1) = 0.5, while feesPaid = 0.7 and 0.2 stays with the open unit.
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '2', price: '100', fee: '0.4', createdAt: at(0) }),
        fill({ side: 'SELL', quantity: '1', price: '110', fee: '0.3', createdAt: at(1) }),
      ],
      marks: new Map([[SYMBOL, '105']]),
      fundingFeeUsdt: '0',
    });

    expect(pnl.realizedPnl).toBe('10');
    expect(pnl.closedEntryNotionalUsdt).toBe('100');
    expect(pnl.feesPaid).toBe('0.7');
    expect(pnl.lockedProfitBps).toBe('950'); // (10 − 0.5) / 100 × 10000
    expect(inferredClosedFee(pnl)!.toString()).toBe('0.5');
    // The open unit keeps its 0.2 of fee: closed 0.5 + open 0.2 === 0.7 exactly.
    expect(inferredClosedFee(pnl)!.plus('0.2').toString()).toBe(pnl.feesPaid);
    expect(pnl.unrealizedPnl).toBe('5');
    expect(pnl.netPnl).toBe('14.3');
  });
});

// ---------------------------------------------------------------- C: locked bps denominator

describe('QA-C lockedProfitBps must use the CLOSED cost basis', () => {
  it('C1: a completed cycle followed by re-sizing uses closedEntryNotional, not entryNotional', () => {
    // BUY 1@100 (0.1) → SELL 1@110 (0.11) completes one cycle; then BUY 1@200 (0.2) re-sizes.
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.1', createdAt: at(0) }),
        fill({ side: 'SELL', quantity: '1', price: '110', fee: '0.11', createdAt: at(1) }),
        fill({ side: 'BUY', quantity: '1', price: '200', fee: '0.2', createdAt: at(2) }),
      ],
      marks: new Map([[SYMBOL, '200']]),
      fundingFeeUsdt: '0',
    });

    // The two candidate denominators, both present in the payload and deliberately different.
    expect(pnl.closedEntryNotionalUsdt).toBe('100');
    expect(pnl.entryNotionalUsdt).toBe('300');

    // realized 10, closedFee = 0.1 + 0.11 = 0.21 ⇒ 9.79 / 100 × 10000.
    expect(pnl.lockedProfitBps).toBe('979');
    // What the WRONG denominator would have produced — 9.79 / 300 × 10000.
    const wrong = expectedLockedBps('10', '0.21', '300');
    expect(wrong).toBe('326.33333333333333333');
    expect(pnl.lockedProfitBps).not.toBe(wrong);
    expect(pnl.netPnl).toBe('9.59'); // 10 + 0 (mark == basis) − 0.41
  });
});

// ---------------------------------------------------------------- D: WAC vs FIFO

describe('QA-D the replay is weighted-average, not FIFO', () => {
  it('D1: two lots at 100 and 200 closed at 250 realise the AVERAGE, not the oldest lot', () => {
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1', price: '100', createdAt: at(0) }),
        fill({ side: 'BUY', quantity: '1', price: '200', createdAt: at(1) }),
        fill({ side: 'SELL', quantity: '1', price: '250', createdAt: at(2) }),
      ],
      marks: new Map([[SYMBOL, '250']]),
      fundingFeeUsdt: '0',
    });

    // WAC: avg 150 ⇒ realized (250 − 150) = 100, closed basis 150, the remaining unit still averages 150.
    expect(pnl.realizedPnl).toBe('100');
    expect(pnl.closedEntryNotionalUsdt).toBe('150');
    expect(pnl.unrealizedPnl).toBe('100');
    expect(pnl.netPnl).toBe('200');
    expect(pnl.lockedProfitBps).toBe('6666.6666666666666667');

    // FIFO would have produced realized 150 / closed basis 100 / unrealized 50 — all three differ.
    expect(pnl.realizedPnl).not.toBe('150');
    expect(pnl.closedEntryNotionalUsdt).not.toBe('100');
    expect(pnl.unrealizedPnl).not.toBe('50');
  });
});

// ---------------------------------------------------------------- E: null semantics

describe('QA-E null means unavailable, never zero', () => {
  const closed = () => [
    fill({ side: 'BUY', quantity: '1', price: '100', createdAt: at(0) }),
    fill({ side: 'SELL', quantity: '1', price: '110', createdAt: at(1) }),
  ];

  it('E1: netPnl is null if and only if unrealizedPnl is null', () => {
    const shapes: Array<{ name: string; fills: StrategyFillInput[]; marks: Map<string, string>; expectNull: boolean }> = [
      { name: 'fully closed with a mark', fills: closed(), marks: new Map([[SYMBOL, '110']]), expectNull: false },
      { name: 'open with a mark', fills: [fill({ side: 'BUY', quantity: '1', price: '100' })], marks: new Map([[SYMBOL, '105']]), expectNull: false },
      { name: 'open without a mark', fills: [fill({ side: 'BUY', quantity: '1', price: '100' })], marks: new Map(), expectNull: true },
      {
        name: 'closed here, open elsewhere without a mark',
        // A completed cycle on SYMBOL (markable) plus a still-open leg on a SECOND symbol that has
        // no mark: the closed half is priceable, the open half is not ⇒ the whole figure degrades.
        fills: [
          ...closed(),
          fill({ side: 'BUY', quantity: '1', price: '100', symbol: 'GATE_FUTURE_OPEN_USDT', createdAt: at(2) }),
        ],
        marks: new Map([[SYMBOL, '110']]),
        expectNull: true,
      },
      { name: 'open with an unusable mark (0)', fills: [fill({ side: 'BUY', quantity: '1', price: '100' })], marks: new Map([[SYMBOL, '0']]), expectNull: true },
    ];

    for (const shape of shapes) {
      const pnl = computeStrategyPnl({ fills: shape.fills, marks: shape.marks, fundingFeeUsdt: '0' });
      expect(pnl.unrealizedPnl === null, `${shape.name}: unrealizedPnl null`).toBe(shape.expectNull);
      expect(pnl.netPnl === null, `${shape.name}: netPnl null`).toBe(shape.expectNull);
      expect(pnl.netPnl === null).toBe(pnl.unrealizedPnl === null);
    }
  });

  it('E2: unusable marks degrade to null, never to a zero price', () => {
    const open = [fill({ side: 'BUY', quantity: '1', price: '100' })];
    for (const mark of ['0', '-1', '-0', 'NaN']) {
      const pnl = computeStrategyPnl({ fills: open, marks: new Map([[SYMBOL, mark]]), fundingFeeUsdt: '0' });
      expect(pnl.unrealizedPnl, `mark ${JSON.stringify(mark)}`).toBeNull();
      expect(pnl.netPnl, `mark ${JSON.stringify(mark)}`).toBeNull();
    }

    // Fixed 2026-10-13 (D1): an unparseable mark is missing data, not a crash. The pure function
    // now degrades to null exactly like an absent or non-positive mark, so the pure function and
    // its only production caller (`positiveMarkOrNull` in trading-runtime.ts) finally agree.
    for (const mark of ['', '   ', 'abc', '1,5']) {
      const pnl = computeStrategyPnl({ fills: open, marks: new Map([[SYMBOL, mark]]), fundingFeeUsdt: '0' });
      expect(pnl.unrealizedPnl, `mark ${JSON.stringify(mark)}`).toBeNull();
      expect(pnl.netPnl, `mark ${JSON.stringify(mark)}`).toBeNull();
    }
  });

  it('E3: nothing closed yet ⇒ null locked bps, zero closed notional, but every fee still paid', () => {
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.1', createdAt: at(0) }),
        fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.25', createdAt: at(1) }),
      ],
      marks: new Map([[SYMBOL, '100']]),
      fundingFeeUsdt: '0',
    });

    expect(pnl.closedEntryNotionalUsdt).toBe('0');
    expect(pnl.lockedProfitBps).toBeNull();
    expect(pnl.realizedPnl).toBe('0');
    // Opens-only still pays: 0.1 + 0.25 both counted.
    expect(pnl.feesPaid).toBe('0.35');
    expect(pnl.netPnl).toBe('-0.35');
  });

  it('E4: funding null / charged / collected shift net and locked by exactly the funding amount', () => {
    const roundTrip = closed();
    const marks = new Map([[SYMBOL, '110']]);
    // realized 10, no fees, closed basis 100.
    const unavailable = computeStrategyPnl({ fills: roundTrip, marks, fundingFeeUsdt: null });
    const charged = computeStrategyPnl({ fills: roundTrip, marks, fundingFeeUsdt: '1' });
    const collected = computeStrategyPnl({ fills: roundTrip, marks, fundingFeeUsdt: '-2' });

    expect([unavailable.netPnl, charged.netPnl, collected.netPnl]).toEqual(['10', '9', '12']);
    expect([unavailable.lockedProfitBps, charged.lockedProfitBps, collected.lockedProfitBps])
      .toEqual(['1000', '900', '1200']);

    // Exact deltas: net shifts by the funding, locked by funding / closedNotional × 10000.
    expect(new Decimal(unavailable.netPnl!).minus(charged.netPnl!).toString()).toBe('1');
    expect(new Decimal(unavailable.lockedProfitBps!).minus(charged.lockedProfitBps!).toString()).toBe('100');
    expect(new Decimal(collected.netPnl!).minus(unavailable.netPnl!).toString()).toBe('2');

    // null funding is still reported as null even though it is counted as 0 in the arithmetic.
    expect(unavailable.fundingFeeUsdt).toBeNull();
  });
});

// ---------------------------------------------------------------- F: serialisation

describe('QA-F numeric serialisation', () => {
  it('F1: sub-2dp differences survive the replay', () => {
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1', price: '100.000000000000000001', createdAt: at(0) }),
        fill({ side: 'SELL', quantity: '1', price: '100.000000000000000002', createdAt: at(1) }),
      ],
      marks: new Map([[SYMBOL, '100']]),
      fundingFeeUsdt: '0',
    });

    // A 1e-18 price move must not be rounded away to '0'.
    expect(new Decimal(pnl.realizedPnl).isZero()).toBe(false);
    expect(new Decimal(pnl.realizedPnl).eq('2e-18')).toBe(true);
  });

  it('F2: tiny magnitudes are serialised as plain decimal strings', () => {
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1e-8', price: '0.0000001234', fee: '0.0000000001', createdAt: at(0) }),
        fill({ side: 'SELL', quantity: '1e-8', price: '0.0000001235', fee: '0.0000000001', createdAt: at(1) }),
      ],
      marks: new Map([[SYMBOL, '0.0000001235']]),
      fundingFeeUsdt: '0.0000000001',
    });

    // Fixed 2026-10-13 (D3): every recomputed field goes through `plain()` (toFixed), so no
    // magnitude ever serialises in scientific notation.
    expect(pnl.realizedPnl).toBe('0.000000000000000001');
    expect(pnl.feesPaid).toBe('0.0000000002');
    expect(pnl.closedEntryNotionalUsdt).toBe('0.000000000000001234');
    expect(pnl.entryNotionalUsdt).toBe('0.000000000000001234');
    expect(pnl.netPnl).toBe('-0.000000000299999999');

    // The VALUES are unchanged — only the textual form was fixed.
    expect(new Decimal(pnl.realizedPnl).eq('1e-18')).toBe(true);
    expect(new Decimal(pnl.closedEntryNotionalUsdt).eq('1.234e-15')).toBe(true);

    // No string field of the payload may carry an exponent marker.
    for (const [field, value] of Object.entries(pnl)) {
      if (typeof value === 'string') expect(value, field).not.toMatch(/e/i);
    }

    // The values that are not recomputed (funding) still pass through verbatim.
    expect(pnl.fundingFeeUsdt).toBe('0.0000000001');
  });
});

// ---------------------------------------------------------------- G: robustness / bad data

describe('QA-G robustness and odd data', () => {
  it('G1: unparseable fill fields throw out of the pure function', () => {
    const base = { marks: new Map<string, string>(), fundingFeeUsdt: '0' };
    expect(() => computeStrategyPnl({ ...base, fills: [fill({ side: 'BUY', quantity: '1', price: '' })] })).toThrow(/Invalid argument/);
    expect(() => computeStrategyPnl({ ...base, fills: [fill({ side: 'BUY', quantity: 'not-a-number', price: '100' })] })).toThrow(/Invalid argument/);
    expect(() => computeStrategyPnl({ ...base, fills: [fill({ side: 'BUY', quantity: '1', price: '100', fee: '' })] })).toThrow(/Invalid argument/);
  });

  it('G2: a zero-quantity fill is not a trade event — its fee never enters the books', () => {
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.1', createdAt: at(0) }),
        fill({ side: 'SELL', quantity: '1', price: '110', fee: '0.11', createdAt: at(1) }),
        // A zero-size fill: not a trade event, so its fee is ignored entirely (D4).
        fill({ side: 'BUY', quantity: '0', price: '100', fee: '0.01', createdAt: at(2) }),
      ],
      marks: new Map([[SYMBOL, '110']]),
      fundingFeeUsdt: '0',
    });

    // Fixed 2026-10-13 (D4): the zero-quantity fill's fee no longer enters `feesPaid`, so the
    // conservation `closedFee + openFeeAccrued === feesPaid` holds exactly.
    expect(pnl.feesPaid).toBe('0.21');
    expect(inferredClosedFee(pnl)!.toString()).toBe('0.21');
    expect(inferredClosedFee(pnl)!.minus(pnl.feesPaid).toString()).toBe('0');
    expect(pnl.netPnl).toBe('9.79');
  });

  it('G3: fills sharing a timestamp replay in the order they arrived', () => {
    const same = at(0);
    const buyFirst = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1', price: '100', createdAt: same }),
        fill({ side: 'SELL', quantity: '1', price: '110', createdAt: same }),
      ],
      marks: new Map([[SYMBOL, '110']]), fundingFeeUsdt: '0',
    });
    const sellFirst = computeStrategyPnl({
      fills: [
        fill({ side: 'SELL', quantity: '1', price: '110', createdAt: same }),
        fill({ side: 'BUY', quantity: '1', price: '100', createdAt: same }),
      ],
      marks: new Map([[SYMBOL, '110']]), fundingFeeUsdt: '0',
    });

    // Buying first closes against a 100 basis; selling first opens a 110 short and closes against it.
    expect(buyFirst.closedEntryNotionalUsdt).toBe('100');
    expect(sellFirst.closedEntryNotionalUsdt).toBe('110');
    expect(buyFirst.realizedPnl).toBe('10');
    expect(sellFirst.realizedPnl).toBe('10');
  });

  it('G4: one symbol under two venue labels stays ONE position stream', () => {
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1', price: '100', venue: 'GATE', createdAt: at(0) }),
        fill({ side: 'SELL', quantity: '1', price: '110', venue: 'OKX', createdAt: at(1) }),
      ],
      marks: new Map([[SYMBOL, '110']]),
      fundingFeeUsdt: '0',
    });

    // Grouping by (venue, symbol) would have left two separate legs: realized 0 and unrealized 10.
    expect(pnl.realizedPnl).toBe('10');
    expect(pnl.closedEntryNotionalUsdt).toBe('100');
    expect(pnl.unrealizedPnl).toBe('0');
  });
});

// ---------------------------------------------------------------- H: facade checks

describe('QA-H facade', () => {
  it('H1: an opened-only position still pays its full fee', () => {
    const pnl = computeStrategyPnl({
      fills: [fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.7', createdAt: at(0) })],
      marks: new Map([[SYMBOL, '100']]),
      fundingFeeUsdt: '0',
    });
    expect(pnl.feesPaid).toBe('0.7');
    expect(pnl.lockedProfitBps).toBeNull();
    expect(pnl.netPnl).toBe('-0.7');
  });

  it('H2: a rebate (negative fee) passes through without abs() or a sign flip', () => {
    const pnl = computeStrategyPnl({
      fills: [
        fill({ side: 'BUY', quantity: '1', price: '100', fee: '0.1', createdAt: at(0) }),
        fill({ side: 'SELL', quantity: '1', price: '100', fee: '-0.04', createdAt: at(1) }),
      ],
      marks: new Map([[SYMBOL, '100']]),
      fundingFeeUsdt: '0',
    });
    expect(pnl.feesPaid).toBe('0.06');
    expect(pnl.netPnl).toBe('-0.06');
    // locked bps uses the same signed fee: (0 − 0.06) / 100 × 10000.
    expect(pnl.lockedProfitBps).toBe('-6');
  });
});

// ---------------------------------------------------------------- R: runtime wiring

interface RuntimeHarness {
  database: Database.Database;
  runtime: TradingRuntime;
  directory: string;
}

const harnesses: RuntimeHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

function createHarness(): RuntimeHarness {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-qa-pnl-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
  });
  const session = new TradingSession();
  session.set('live');
  const database = openDatabase(config.databasePath, config.migrationsDir);
  const runtime = new TradingRuntime(database, session, new MemoryCredentialVault(), {} as never);
  const harness = { database, runtime, directory };
  harnesses.push(harness);
  return harness;
}

interface SeedFill {
  orderId: string;
  strategyId: string;
  symbol: string;
  venue: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fee: string;
  createdAt: string;
}

// `strategyFromRow` re-parses `config_json` through `CreateStrategyInputSchema` on every read, so a
// seeded row must carry a schema-valid config or the whole strategy blows up before PnL is even
// considered (this is exactly the failure the first draft of this file hit). The canonical shapes
// live in `trading-runtime.test.ts` (`pairedStrategyInput` / `carryStrategyInput`).
const POSITION_CONFIG = {
  kind: 'position', asset: 'BTC', leftVenue: 'GATE', rightVenue: 'BINANCE',
  leftSide: 'BUY', rightSide: 'SELL', entryBps: '-5', totalAmount: '100',
  perOrderQuantity: '1', executionMethod: 'TAKER_TAKER',
} as const;
const CARRY_CONFIG = {
  kind: 'carry', asset: 'BTC', leftVenue: 'GATE', rightVenue: 'GATE',
  leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'GATE_FUTURE_BTC_USDT',
  leftSide: 'BUY', rightSide: 'SELL', totalAmount: '100',
  perOrderQuantity: '1', executionMethod: 'TAKER_TAKER',
} as const;

function seedStrategy(database: Database.Database, id: string, kind = 'position', metricsJson: string | null = null): void {
  database.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json, progress,
    filled_quantity, filled_left, filled_right, open_position, metrics_json, created_at, updated_at, stopped_at)
    VALUES (?, ?, 'live', 'STOPPED', ?, 0, '0', '0', '0', '0', ?, ?, ?, NULL)`)
    .run(id, kind, JSON.stringify(kind === 'carry' ? CARRY_CONFIG : POSITION_CONFIG), metricsJson, at(0), at(0));
}

function seedFill(database: Database.Database, seed: SeedFill): void {
  database.prepare(`INSERT INTO execution_orders (id, client_order_id, environment, symbol, venue, side,
    order_type, time_in_force, quantity, price, reduce_only, state, executed_quantity, executed_average_price,
    created_at, updated_at, strategy_id, strategy_leg)
    VALUES (?, ?, 'live', ?, ?, ?, 'MARKET', 'IOC', ?, NULL, 0, 'FILLED', ?, ?, ?, ?, ?, 'left')`)
    .run(seed.orderId, `${seed.orderId}-c`, seed.symbol, seed.venue, seed.side, seed.quantity,
      seed.quantity, seed.price, seed.createdAt, seed.createdAt, seed.strategyId);
  database.prepare(`INSERT INTO execution_fills (id, order_id, symbol, venue, side, quantity, price, fee, realized_pnl, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', ?)`)
    .run(`fill-${seed.orderId}`, seed.orderId, seed.symbol, seed.venue, seed.side, seed.quantity, seed.price, seed.fee, seed.createdAt);
}

function seedSnapshot(database: Database.Database, symbol: string, venue: string, markPrice: string | null, lastPrice: string | null): void {
  database.prepare(`INSERT INTO public_market_snapshots (symbol, venue, product, bid_price, ask_price, last_price,
    mark_price, index_price, funding_rate, predicted_funding_rate, next_funding_at, source_timestamp, fetched_at, source)
    VALUES (?, ?, 'FUTURE', NULL, NULL, ?, ?, '0', '0', NULL, '0', '0', '0', 'qa')`)
    .run(symbol, venue, lastPrice, markPrice);
}

function seedLivePosition(database: Database.Database, id: string, symbol: string, venue: string, fundingFee: string | null): void {
  database.prepare(`INSERT INTO live_positions (position_id, symbol, venue, quantity, entry_price, mark_price,
    realized_pnl, funding_fee, updated_at) VALUES (?, ?, ?, '0', '0', '0', '0', ?, '0')`)
    .run(id, symbol, venue, fundingFee);
}

describe('QA-R runtime wiring', () => {
  it('R1: a broken strategy degrades only itself — the neighbour keeps a REAL figure', () => {
    const { database, runtime } = createHarness();
    seedStrategy(database, 'QA-BAD');
    seedFill(database, { orderId: 'O-BAD', strategyId: 'QA-BAD', symbol: SYMBOL, venue: 'GATE', side: 'BUY', quantity: '1', price: 'not-a-number', fee: '0', createdAt: at(0) });
    seedStrategy(database, 'QA-GOOD');
    seedFill(database, { orderId: 'O-G1', strategyId: 'QA-GOOD', symbol: SYMBOL, venue: 'GATE', side: 'BUY', quantity: '1', price: '100', fee: '0.05', createdAt: at(0) });
    seedFill(database, { orderId: 'O-G2', strategyId: 'QA-GOOD', symbol: SYMBOL, venue: 'GATE', side: 'SELL', quantity: '1', price: '110', fee: '0.055', createdAt: at(1) });
    seedSnapshot(database, SYMBOL, 'GATE', '110', '110');

    const listed = runtime.listStrategies();
    expect(listed).toHaveLength(2);
    expect(listed.find((s) => s.id === 'QA-BAD')?.pnl).toBeNull();
    const good = listed.find((s) => s.id === 'QA-GOOD');
    // Not just "non-null": the survivor must carry the correct numbers.
    expect(good?.pnl?.netPnl).toBe('9.895');
    expect(good?.pnl?.lockedProfitBps).toBe('989.5');
    expect(good?.pnl?.realizedPnl).toBe('10');
    expect(runtime.getStrategy('QA-BAD').pnl).toBeNull();
    // The legacy feed figure is untouched by the failure.
    expect(listed.find((s) => s.id === 'QA-GOOD')?.realizedPnl).toBe('0');
  });

  it('R2: the mark falls back mark_price → last_price → null', () => {
    const { database, runtime } = createHarness();
    seedStrategy(database, 'QA-MARK');
    seedFill(database, { orderId: 'O1', strategyId: 'QA-MARK', symbol: SYMBOL, venue: 'GATE', side: 'BUY', quantity: '1', price: '100', fee: '0', createdAt: at(0) });

    seedSnapshot(database, SYMBOL, 'GATE', '0', '108');
    expect(runtime.getStrategy('QA-MARK').pnl?.unrealizedPnl).toBe('8');

    // An unparseable mark must fall through to last_price rather than blowing the row up.
    database.prepare('UPDATE public_market_snapshots SET mark_price = ?').run('abc');
    expect(runtime.getStrategy('QA-MARK').pnl?.unrealizedPnl).toBe('8');

    // Both unusable ⇒ null, not zero.
    database.prepare('UPDATE public_market_snapshots SET last_price = ?').run('-1');
    expect(runtime.getStrategy('QA-MARK').pnl?.unrealizedPnl).toBeNull();
    expect(runtime.getStrategy('QA-MARK').pnl?.netPnl).toBeNull();
  });

  it('R3: a mark of "Infinity" is rejected and the figure degrades to null', () => {
    const { database, runtime } = createHarness();
    seedStrategy(database, 'QA-INF');
    seedFill(database, { orderId: 'O1', strategyId: 'QA-INF', symbol: SYMBOL, venue: 'GATE', side: 'BUY', quantity: '1', price: '100', fee: '0', createdAt: at(0) });
    seedSnapshot(database, SYMBOL, 'GATE', 'Infinity', 'Infinity');

    const pnl = runtime.getStrategy('QA-INF').pnl;
    // Fixed 2026-10-13 (D2): `positiveMarkOrNull` now requires `isFinite()`, because decimal.js
    // answers `new Decimal('Infinity').gt(0)` with true. A non-finite mark is missing data, so
    // the whole figure degrades to null instead of becoming the string "Infinity".
    expect(pnl?.unrealizedPnl).toBeNull();
    expect(pnl?.netPnl).toBeNull();
    // The legacy feed figure is untouched by the unusable mark.
    expect(runtime.getStrategy('QA-INF').realizedPnl).toBe('0');
  });

  it('R4: listStrategies and getStrategy agree when two strategies share a position pair', () => {
    const { database, runtime } = createHarness();
    for (const id of ['QA-S1', 'QA-S2']) {
      seedStrategy(database, id);
      seedFill(database, { orderId: `O-${id}`, strategyId: id, symbol: SYMBOL, venue: 'GATE', side: 'BUY', quantity: '1', price: '100', fee: '0', createdAt: at(0) });
    }
    seedSnapshot(database, SYMBOL, 'GATE', '100', '100');
    seedLivePosition(database, 'P1', SYMBOL, 'GATE', '2.5');

    for (const strategy of runtime.listStrategies()) {
      // Un-splittable venue-account funding ⇒ null on the list path…
      expect(strategy.pnl?.fundingFeeUsdt, `${strategy.id} list`).toBeNull();
      // …and on the single-strategy path, which builds its context separately.
      expect(runtime.getStrategy(strategy.id).pnl?.fundingFeeUsdt, `${strategy.id} single`).toBeNull();
      expect(strategy.pnl?.netPnl).toBe('0');
    }
  });

  it('R5: a sole owner gets the venue funding, and a carry strategy uses its collected figure', () => {
    const sole = createHarness();
    seedStrategy(sole.database, 'QA-SOLE');
    seedFill(sole.database, { orderId: 'O1', strategyId: 'QA-SOLE', symbol: SYMBOL, venue: 'GATE', side: 'BUY', quantity: '1', price: '100', fee: '0', createdAt: at(0) });
    seedSnapshot(sole.database, SYMBOL, 'GATE', '100', '100');
    seedLivePosition(sole.database, 'P1', SYMBOL, 'GATE', '2.5');
    const solePnl = sole.runtime.getStrategy('QA-SOLE').pnl;
    expect(solePnl?.fundingFeeUsdt).toBe('2.5');
    expect(solePnl?.netPnl).toBe('-2.5');
    expect(solePnl?.lockedProfitBps).toBeNull();

    const carry = createHarness();
    // A carry strategy's funding comes from its metrics snapshot, so the seeded blob must satisfy
    // `StrategyCarryMetricsSchema` in full or `carryMetricsFromRow` rejects it (→ null, not -3.5).
    seedStrategy(carry.database, 'QA-CARRY', 'carry', JSON.stringify({
      fundingCollectedUsdt: '3.5', basisEntryBps: '20', basisCurrentBps: '10',
      basisPnlUsdt: '1', feesPaidUsdt: '0.1', netPnlUsdt: '4.4',
      entryFundingApr: '18', nextFundingAccrualAt: null,
    }));
    seedFill(carry.database, { orderId: 'O1', strategyId: 'QA-CARRY', symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', side: 'BUY', quantity: '1', price: '100', fee: '0', createdAt: at(0) });
    seedFill(carry.database, { orderId: 'O2', strategyId: 'QA-CARRY', symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', side: 'SELL', quantity: '1', price: '100', fee: '0', createdAt: at(1) });
    seedSnapshot(carry.database, 'GATE_SPOT_BTC_USDT', 'GATE', '100', '100');

    const carryPnl = carry.runtime.getStrategy('QA-CARRY').pnl;
    // Collected funding is a credit ⇒ negative cost.
    expect(carryPnl?.fundingFeeUsdt).toBe('-3.5');
    expect(carryPnl?.netPnl).toBe('3.5');
    // The lock figure carries the same sign: (0 − 0 − (−3.5)) / 100 × 10000.
    expect(carryPnl?.lockedProfitBps).toBe('350');
  });
});
