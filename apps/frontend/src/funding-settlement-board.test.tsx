import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  FundingSettlementBoard,
  type FundingBoardSort,
  type FundingPairBoardRow,
  type FundingSettlementLeg,
} from './funding-settlement-board.js';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');

/** One venue leg: 8h interval, positive rate, six settlements already charged. */
function leg(overrides: Partial<FundingSettlementLeg> = {}): FundingSettlementLeg {
  return {
    key: 'GATE:BTC',
    asset: 'BTC',
    venue: 'gate',
    venueName: 'Gate.io',
    venueShort: 'GT',
    symbol: 'GATE_FUTURE_BTC_USDT',
    ratePercent: 0.01,
    rate8hPercent: 0.01,
    intervalHours: 8,
    nextFundingAt: new Date(NOW + ((4 * 60 + 34) * 60_000)).toISOString(),
    recentPercent: [-0.002, 0.004, 0.006, -0.008, 0.01, 0.012],
    recentMeanPercent: 0.0037,
    latestSettledPercent: 0.012,
    latestSettledAt: new Date(NOW).toISOString(),
    settlementCount: 6,
    settlementStatus: 'ok',
    openInterest: 176_600_000,
    lastPrice: 98_640,
    change24hPercent: 1.23,
    ...overrides,
  };
}

/** A two-venue BTC pair: Gate charges longs 0.01%/8h, Binance charges 0.05%/8h. */
function pairRow(overrides: Partial<FundingPairBoardRow> = {}): FundingPairBoardRow {
  const long = leg({ key: 'GATE:BTC', venue: 'gate', venueName: 'Gate.io', venueShort: 'GT', symbol: 'GATE_FUTURE_BTC_USDT', ratePercent: 0.01, rate8hPercent: 0.01 });
  const short = leg({ key: 'BINANCE:BTC', venue: 'binance', venueName: 'Binance', venueShort: 'BN', symbol: 'BINANCE_FUTURE_BTC_USDT', ratePercent: -0.04, rate8hPercent: -0.04 });
  return {
    key: 'BTC:gate:binance',
    asset: 'BTC',
    name: 'Bitcoin',
    icon: '₿',
    symbol: 'gate:binance',
    long,
    short,
    spreadPercent: 0.05,
    annualizedPercent: 54.75,
    currentRatePercent: 0.01,
    latestSettledPercent: 0.012,
    nextFundingAt: new Date(NOW + ((4 * 60 + 34) * 60_000)).toISOString(),
    openInterest: 176_600_000,
    lastPrice: 98_640,
    change24hPercent: 1.23,
    ...overrides,
  };
}

function renderBoard(rows: readonly FundingPairBoardRow[], sortKey: FundingBoardSort = 'apr'): string {
  return renderToStaticMarkup(
    <FundingSettlementBoard
      rows={rows}
      now={NOW}
      sortKey={sortKey}
      sortDirection="desc"
      onSort={vi.fn()}
      settlementLimit={8}
    />,
  );
}

describe('funding settlement board', () => {
  it('renders one row per venue pair with both legs and both live rates', () => {
    const markup = renderBoard([pairRow()]);

    expect(markup).toContain('Pair');
    expect(markup).toContain('Long leg');
    expect(markup).toContain('Short leg');
    expect(markup).toContain('Funding spread');
    expect(markup).toContain('Annualized APR');
    expect(markup).toContain('Next settlement');
    expect(markup).toContain('Last 8 settled');
    // Both legs' live rates, each with its own interval label.
    expect(markup).toContain('+0.0100%');
    expect(markup).toContain('-0.0400%');
    expect(markup).toContain('per interval · 8h');
    expect(markup).toContain('GT ⇄ BN');
  });

  it('shows the spread and its annualized figure as separate columns', () => {
    const markup = renderBoard([pairRow()]);

    expect(markup).toContain('short − long · 8h');
    expect(markup).toContain('+0.0500%');
    expect(markup).toContain('+54.8%');
    expect(markup).toContain('×1095 / year');
  });

  it('keeps live rates apart from already-settled rates', () => {
    const markup = renderBoard([pairRow()]);

    // Settled rows render inside the strip column, not in the live cells.
    expect(markup).toContain('Long');
    expect(markup).toContain('Short');
    expect(markup).toContain('+0.0120% latest');
    expect(markup).toContain('+0.0037% mean');
    expect((markup.match(/funding-settlement-bar /g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it('formats the earlier leg countdown and its per-leg countdowns', () => {
    const markup = renderBoard([pairRow()]);

    expect(markup).toContain('in 4h 34m');
    expect(renderBoard([pairRow({
      long: leg({ nextFundingAt: new Date(NOW + 34 * 60_000 + 46_000).toISOString() }),
      short: leg({ key: 'BINANCE:BTC', nextFundingAt: new Date(NOW + 34 * 60_000 + 46_000).toISOString() }),
      nextFundingAt: new Date(NOW + 34 * 60_000 + 46_000).toISOString(),
    })])).toContain('in 34:46');
    expect(renderBoard([pairRow({
      long: leg({ nextFundingAt: null }),
      short: leg({ key: 'BINANCE:BTC', nextFundingAt: null }),
      nextFundingAt: null,
    })])).toContain('no schedule');
  });

  it('paints a charged rate red and a paid rate green', () => {
    const markup = renderBoard([pairRow()]);

    expect(markup).toContain('<strong class="funding-rate funding-tone-pay">+0.0100%</strong>');
    expect(markup).toContain('<strong class="funding-rate funding-tone-earn">-0.0400%</strong>');
    expect(markup).toContain('Charged to longs — you pay');
    expect(markup).toContain('Paid to longs — you receive');
  });

  it('shows an explicit empty state instead of a zero rate when nothing is cached', () => {
    const emptyLeg = leg({
      ratePercent: null,
      rate8hPercent: null,
      intervalHours: null,
      nextFundingAt: null,
      recentPercent: [],
      recentMeanPercent: null,
      latestSettledPercent: null,
      latestSettledAt: null,
      settlementCount: 0,
      settlementStatus: 'unavailable',
      openInterest: 0,
      change24hPercent: null,
    });
    const markup = renderBoard([pairRow({
      long: emptyLeg,
      short: { ...emptyLeg, key: 'BINANCE:BTC', venue: 'binance', venueName: 'Binance', venueShort: 'BN' },
      spreadPercent: null,
      annualizedPercent: null,
      currentRatePercent: null,
      latestSettledPercent: null,
      openInterest: 0,
      nextFundingAt: null,
    })]);

    expect(markup).toContain('No settled rates yet');
    expect(markup).toContain('Nothing cached locally');
    expect(markup).toContain('interval unknown');
    expect(markup).not.toContain('0.0000%');
    expect(markup).not.toContain('+0.00%');
  });

  it('renders the settled strips as loading rather than empty while the request is in flight', () => {
    const loadingLeg = leg({ recentPercent: [], recentMeanPercent: null, latestSettledPercent: null, settlementStatus: 'loading' });
    const markup = renderBoard([pairRow({ long: loadingLeg, short: { ...loadingLeg, key: 'BINANCE:BTC' } })]);

    expect(markup).toContain('Loading settlements…');
    expect(markup).not.toContain('No settled rates yet');
  });

  it('renders a table-level empty state when no pair matches', () => {
    expect(renderBoard([])).toContain('No venue pair matches the current filters.');
  });
});
