import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RefObject } from 'react';
import type { StrategyConfig, StrategyRecord } from './api.js';
import type { StrategyPnl } from '@gate-crossex/shared-types';
import { LanguageContext } from './i18n.js';
import { StrategyConfigDetailDialog } from './strategy-config-detail.js';

/**
 * Read-only strategy configuration detail (0.3.3 需求 3).
 *
 * The dialog is a pure view over `StrategyRecord`, so it is asserted from static markup — this
 * workspace has no jsdom. Two contracts matter most: every configured field is shown (a missing one
 * reads `—`, never `undefined`), and the dialog never emits `aria-pressed`, which a project-wide
 * SSR check rejects inside dialogs.
 */

function languageContext() {
  return { language: 'en' as const, theme: 'dark' as const, t: (key: string) => key, setLanguage: vi.fn() };
}

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
    id: 'PAIR-DETAIL01',
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

function renderDetail(strategy: StrategyRecord): string {
  const dialogRef: RefObject<HTMLElement | null> = { current: null };
  return renderToStaticMarkup(
    <LanguageContext.Provider value={languageContext()}>
      <StrategyConfigDetailDialog
        strategy={strategy}
        onViewLogs={vi.fn()}
        onCopy={vi.fn()}
        onClose={vi.fn()}
        dialogRef={dialogRef}
      />
    </LanguageContext.Provider>,
  );
}

describe('strategy configuration detail dialog', () => {
  it('titles the dialog with the strategy id and names the market it runs', () => {
    const html = renderDetail(record());
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('<h2 id="strategy-config-detail-title">PAIR-DETAIL01</h2>');
    expect(html).toContain('BTC · BINANCE ⇄ OKX');
  });

  it('renders every configured field from the stored config', () => {
    const html = renderDetail(record({
      config: config({
        hedgeAsset: 'USDT',
        entryBps: '8',
        takeProfitBps: '40',
        stopLossBps: 100,
        addOnStepBps: 20,
        maxPosition: '5',
        leftLeverage: '3',
        rightLeverage: '2',
        executionMethod: 'MAKER_TAKER',
        makerLeg: 'right',
        reduceOnly: true,
      }),
    }));

    expect(html).toContain('<dt>Market</dt><dd>BTC</dd>');
    expect(html).toContain('<dt>Hedge asset</dt><dd>USDT</dd>');
    expect(html).toContain('<dt>Left venue</dt><dd>BINANCE</dd>');
    expect(html).toContain('<dt>Right venue</dt><dd>OKX</dd>');
    expect(html).toContain('<dt>Entry threshold</dt><dd>8 bps</dd>');
    expect(html).toContain('<dt>Take-profit threshold</dt><dd>40 bps</dd>');
    expect(html).toContain('<dt>Stop-loss threshold</dt><dd>100 bps</dd>');
    expect(html).toContain('<dt>Add-on step</dt><dd>20 bps</dd>');
    expect(html).toContain('<dt>Max position</dt><dd>5</dd>');
    expect(html).toContain('<dt>Per-order quantity</dt><dd>0.1</dd>');
    expect(html).toContain('<dt>Execution method</dt><dd>MAKER_TAKER</dd>');
    expect(html).toContain('<dt>Maker leg</dt><dd>right</dd>');
    expect(html).toContain('<dt>Left leverage</dt><dd>3</dd>');
    expect(html).toContain('<dt>Right leverage</dt><dd>2</dd>');
    expect(html).toContain('<dt>Reduce only</dt><dd>Yes</dd>');
  });

  it('labels the leg product from the stored symbol and shows a dash when it is absent', () => {
    const spot = renderDetail(record({
      config: config({ leftSymbol: 'BINANCE_SPOT_BTC_USDT', rightSymbol: 'OKX_FUTURE_BTC_USDT' }),
    }));
    expect(spot).toContain('<dt>Left product</dt><dd>Spot</dd>');
    expect(spot).toContain('<dt>Right product</dt><dd>Perpetual</dd>');
    expect(spot).toContain('<dt>Left symbol</dt><dd>BINANCE_SPOT_BTC_USDT</dd>');

    const absent = renderDetail(record());
    expect(absent).toContain('<dt>Left product</dt><dd>—</dd>');
    expect(absent).toContain('<dt>Stop-loss threshold</dt><dd>—</dd>');
    expect(absent).toContain('<dt>Add-on step</dt><dd>—</dd>');
  });

  it('adds the carry-only and close-plan rows only when the record has them', () => {
    const carry = renderDetail(record({
      kind: 'carry',
      config: config({
        kind: 'carry',
        fundingDirection: 'NEGATIVE',
        fundingAprMin: 12,
        basisTakeProfitBps: 30,
        inventoryCheck: true,
      }),
    }));
    expect(carry).toContain('<dt>Funding direction</dt><dd>NEGATIVE</dd>');
    expect(carry).toContain('<dt>Funding APR threshold</dt><dd>12%</dd>');
    expect(carry).toContain('<dt>Inventory check</dt><dd>Yes</dd>');

    const plain = renderDetail(record());
    expect(plain).not.toContain('Funding direction');
    expect(plain).not.toContain('Close plan orders');

    const timed = renderDetail(record({
      config: config({
        closePlan: {
          orderCount: 3,
          intervalSeconds: 60,
          targets: [{ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', quantity: '0.1', positionSide: 'NONE' }],
        },
      }),
    }));
    expect(timed).toContain('<dt>Close plan orders</dt><dd>3</dd>');
    expect(timed).toContain('<dt>Close plan interval</dt><dd>60s</dd>');
    expect(timed).toContain('<dt>Close plan targets</dt><dd>1</dd>');
  });
});

describe('strategy configuration detail dialog — profit and loss', () => {
  const pnl: StrategyPnl = {
    realizedPnl: '2.5',
    unrealizedPnl: '1.25',
    feesPaid: '0.4',
    fundingFeeUsdt: '-0.1',
    netPnl: '12.34',
    closedEntryNotionalUsdt: '1000',
    entryNotionalUsdt: '2000',
    lockedProfitBps: '12.3',
  };

  it('renders each pnl figure with its unit and an explicit sign', () => {
    const html = renderDetail(record({ pnl }));
    expect(html).toContain('<dt>Realized</dt><dd>+2.50 USDT</dd>');
    expect(html).toContain('<dt>Floating</dt><dd>+1.25 USDT</dd>');
    expect(html).toContain('<dt>Net PnL</dt><dd>+12.34 USDT</dd>');
    expect(html).toContain('<dt>Fees paid</dt><dd>+0.40 USDT</dd>');
    expect(html).toContain('<dt>Funding fee</dt><dd>-0.10 USDT</dd>');
    expect(html).toContain('<dt>Entry notional</dt><dd>+2000.00 USDT</dd>');
    expect(html).toContain('<dt>Locked profit</dt><dd>+12.3 bps</dd>');
  });

  it('shows a dash — never a zero — for the fields the backend could not attribute', () => {
    const html = renderDetail(record({
      pnl: {
        ...pnl,
        unrealizedPnl: null,
        fundingFeeUsdt: null,
        netPnl: null,
        lockedProfitBps: null,
      },
    }));

    expect(html).toContain('<dt>Realized</dt><dd>+2.50 USDT</dd>');
    expect(html).toContain('<dt>Floating</dt><dd>—</dd>');
    expect(html).toContain('<dt>Net PnL</dt><dd>—</dd>');
    expect(html).toContain('<dt>Funding fee</dt><dd>—</dd>');
    expect(html).toContain('<dt>Locked profit</dt><dd>—</dd>');
    // An unavailable figure must never be rendered as a zero.
    expect(html).not.toContain('<dd>0.00 USDT</dd>');
  });

  it('dashes the whole section when the record carries no pnl snapshot at all', () => {
    const html = renderDetail(record({ pnl: null }));
    for (const label of ['Realized', 'Floating', 'Net PnL', 'Fees paid', 'Funding fee', 'Locked profit']) {
      expect(html).toContain(`<dt>${label}</dt><dd>—</dd>`);
    }
  });

  it('explains why a figure can be unavailable', () => {
    const html = renderDetail(record({ pnl: null }));
    expect(html).toContain('shows as — when unavailable');
  });
});

describe('strategy configuration detail dialog — accessibility', () => {
  it('never emits aria-pressed, which the project rejects inside dialogs', () => {
    expect(renderDetail(record({ pnl: null }))).not.toContain('aria-pressed');
    expect(renderDetail(record())).not.toContain('aria-pressed');
  });

  it('offers the log, copy, and close actions', () => {
    const html = renderDetail(record());
    expect(html).toContain('>Close<');
    expect(html).toContain('>Execution log<');
    expect(html).toContain('Copy as new strategy');
  });
});
