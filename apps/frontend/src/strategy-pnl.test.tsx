import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StrategyConfig, StrategyRecord } from './api.js';
import type { StrategyPnl } from '@gate-crossex/shared-types';
import { LanguageContext } from './i18n.js';
import { RunningStrategiesPanel, StrategyPnlCells, StrategyTableHead } from './strategy-route.js';
import { PNL_DASH, bpsFigure, pnlUsdtFigure, strategyPnlField } from './strategy-pnl.js';

/**
 * Strategy row PnL columns (0.3.3 需求 1).
 *
 * `Net PnL` and `Locked profit` replaced the history-only `Realized PnL` column and now appear in
 * **both** tabs. Both views are exported pure components so the contract can be asserted from
 * static markup — there is no jsdom here to click a tab with.
 */

function languageContext() {
  return { language: 'en' as const, theme: 'dark' as const, t: (key: string) => key, setLanguage: vi.fn() };
}

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(<LanguageContext.Provider value={languageContext()}>{element}</LanguageContext.Provider>);
}

const PNL: StrategyPnl = {
  realizedPnl: '2.5',
  unrealizedPnl: '-1.25',
  feesPaid: '0.4',
  fundingFeeUsdt: '-0.1',
  netPnl: '12.34',
  closedEntryNotionalUsdt: '1000',
  entryNotionalUsdt: '2000',
  lockedProfitBps: '12.3',
};

describe('strategy table head', () => {
  it('shows the two PnL columns in the running tab', () => {
    const html = render(<StrategyTableHead showingHistory={false} />);
    expect(html).toContain('<span>Net PnL</span><span>Locked profit</span>');
    expect(html).not.toContain('<span>Realized PnL</span>');
  });

  it('shows the same two PnL columns in the historical tab', () => {
    const html = render(<StrategyTableHead showingHistory />);
    expect(html).toContain('<span>Net PnL</span><span>Locked profit</span>');
    expect(html).toContain('<span>Start time</span>');
  });

  it('keeps exactly one track per grid column in both tabs', () => {
    // 13 tracks in `styles.css` (.running-head / .running-row): Start time is history-only and the
    // trailing action cell is running-only, so both tabs land on 13.
    for (const showingHistory of [false, true]) {
      const html = render(<StrategyTableHead showingHistory={showingHistory} />);
      expect((html.match(/<span/g) ?? []).length).toBe(13);
    }
  });
});

describe('strategy PnL cells', () => {
  it('renders the net result in USDT and the locked result in bps, with their basis', () => {
    const html = render(<StrategyPnlCells pnl={PNL} />);
    expect(html).toContain('<span class="strategy-pnl positive"><strong>+12.34 USDT</strong><small>Net of fees and funding</small></span>');
    expect(html).toContain('<span class="strategy-locked-bps positive"><strong>+12.3 bps</strong><small>Already closed</small></span>');
  });

  it('marks a loss with the negative tone (up is red, down is green)', () => {
    const html = render(<StrategyPnlCells pnl={{ ...PNL, netPnl: '-4', lockedProfitBps: '-4.04' }} />);
    expect(html).toContain('<span class="strategy-pnl negative"><strong>-4.00 USDT</strong>');
    expect(html).toContain('<span class="strategy-locked-bps negative"><strong>-4.0 bps</strong>');
  });

  it('renders a dash when a figure is unavailable — never a zero', () => {
    const html = render(<StrategyPnlCells pnl={{ ...PNL, netPnl: null, lockedProfitBps: null }} />);
    expect(html).toContain('<span class="strategy-pnl"><strong>—</strong><small>Net of fees and funding</small></span>');
    expect(html).toContain('<span class="strategy-locked-bps"><strong>—</strong><small>Already closed</small></span>');
    expect(html).not.toContain('0.00');
    expect(html).not.toContain('+0.0 bps');
  });

  it('renders two dashes when the record carries no pnl snapshot at all', () => {
    for (const pnl of [null, undefined]) {
      const html = render(<StrategyPnlCells pnl={pnl} />);
      expect((html.match(/<strong>—<\/strong>/g) ?? []).length).toBe(2);
    }
  });
});

describe('strategy pnl helpers', () => {
  it('formats a positive figure with an explicit plus and a negative one with its sign', () => {
    expect(pnlUsdtFigure('12.34')).toEqual({ text: '+12.34', tone: 'positive' });
    expect(pnlUsdtFigure('-4')).toEqual({ text: '-4.00', tone: 'negative' });
    expect(bpsFigure('12.34')).toEqual({ text: '+12.3', tone: 'positive' });
    expect(bpsFigure('-4.04')).toEqual({ text: '-4.0', tone: 'negative' });
  });

  it('treats null, undefined, blank, and non-numeric text as unavailable', () => {
    for (const value of [null, undefined, '', '   ', 'n/a']) {
      expect(pnlUsdtFigure(value)).toBeNull();
      expect(bpsFigure(value)).toBeNull();
    }
    expect(PNL_DASH).toBe('—');
  });

  it('reads a field off a missing snapshot as unavailable', () => {
    expect(strategyPnlField(null, 'netPnl')).toBeNull();
    expect(strategyPnlField(undefined, 'netPnl')).toBeNull();
    expect(strategyPnlField(PNL, 'netPnl')).toBe('12.34');
  });
});

describe('strategy rows carry the two PnL columns', () => {
  function config(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
    return {
      kind: 'position',
      asset: 'BTC',
      leftVenue: 'BINANCE',
      rightVenue: 'OKX',
      leftSide: 'SELL',
      rightSide: 'BUY',
      entryBps: '10',
      totalAmount: '0.1',
      perOrderQuantity: '0.1',
      reduceOnly: false,
      executionMethod: 'TAKER_TAKER',
      ...overrides,
    };
  }

  function record(overrides: Partial<StrategyRecord> = {}): StrategyRecord {
    return {
      id: 'PAIR-PNL01',
      kind: 'position',
      status: 'RUNNING',
      accountProfileId: 'gate-crossex-default',
      accountLabel: 'Gate CrossEx',
      config: config(),
      progress: 40,
      filledQuantity: '0.1',
      filledLeft: '0.05',
      filledRight: '0.05',
      openPosition: '0.1',
      realizedPnl: '2.5',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:01:00.000Z',
      stoppedAt: null,
      ...overrides,
    };
  }

  function renderPanel(strategies: StrategyRecord[]): string {
    return render(<RunningStrategiesPanel
      strategies={strategies}
      authenticatedPortfolio={null}
      tradingSnapshot={null}
      instruments={[]}
      tradingMode="live"
      onOpenModeDialog={vi.fn()}
      onStrategiesChanged={vi.fn(async () => undefined)}
      onPositionsRefresh={vi.fn(async () => undefined)}
      onOpenStrategyConfig={vi.fn()}
      onCopyStrategy={vi.fn()}
    />);
  }

  it('renders both columns and the figures for a running row', () => {
    const html = renderPanel([record({ pnl: PNL })]);
    expect(html).toContain('<span>Net PnL</span><span>Locked profit</span>');
    expect(html).toContain('<strong>+12.34 USDT</strong>');
    expect(html).toContain('<strong>+12.3 bps</strong>');
  });

  it('dashes a row whose record carries no pnl snapshot', () => {
    const html = renderPanel([record({ pnl: null })]);
    expect(html).toContain('<span class="strategy-pnl"><strong>—</strong>');
    expect(html).toContain('<span class="strategy-locked-bps"><strong>—</strong>');
  });

  it('no longer renders the history-only Realized PnL column', () => {
    const html = renderPanel([record({ pnl: PNL, status: 'STOPPED', stoppedAt: '2026-08-14T01:00:00.000Z' })]);
    expect(html).not.toContain('>Realized PnL<');
    expect(html).not.toContain('strategy-realized-pnl');
  });
});
