import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPortfolioSnapshot } from './api.js';
import { LanguageContext } from './i18n.js';
import { PortfolioView } from './portfolio-route.js';

function portfolio(): AuthenticatedPortfolioSnapshot {
  const timestamp = '2026-08-12T12:00:00.000Z';
  return {
    dataStatus: 'fresh', remoteStatus: 'healthy',
    snapshot: {
      account: {
        availableMargin: '700', marginBalance: '1200', initialMargin: '500', maintenanceMargin: '250',
        initialMarginRate: '2.4', maintenanceMarginRate: '4.8', positionMode: 'SINGLE',
        accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: timestamp,
      },
      balances: [],
      futuresPositions: [{
        positionId: 'position-1', symbol: 'BINANCE_FUTURE_BTC_USDT', positionSide: 'LONG',
        initialMargin: '500', maintenanceMargin: '250', quantity: '0.01', value: '640',
        unrealizedPnl: '20', unrealizedPnlRate: '0.03', entryPrice: '62000', markPrice: '64000',
        leverage: '3', maxLeverage: '20', riskLimit: '1', fee: '0.5', fundingFee: '1.2',
        fundingTime: timestamp, createdAt: timestamp, updatedAt: timestamp, realizedPnl: '4',
        crossExAdlRank: '4', exchangeAdlRank: '3',
      }],
      marginPositions: [], openOrders: [], recentFills: [], fetchedAt: timestamp,
      source: 'gate_crossex_authenticated_rest',
    },
    reconciliation: {
      id: 'reconciliation-1', createdAt: timestamp, status: 'clean', previousFetchedAt: timestamp,
      currentFetchedAt: timestamp, issues: [],
    },
  };
}

type BalanceRow = AuthenticatedPortfolioSnapshot['snapshot']['balances'][number];

/** One venue balance row; the fields the asset page does not read stay at zero. */
function balanceRow(venue: string, coin: string, balance: string, unrealizedPnl: string, equity: string): BalanceRow {
  return {
    venue, coin, balance, unrealizedPnl, equity,
    futuresInitialMargin: '0', futuresMaintenanceMargin: '0',
    borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    availableBalance: '0', liability: '0',
  };
}

/**
 * The live 2026-10-26T12:09Z snapshot: a fully hedged TREAD pair (HYPERLIQUID short 250 /
 * KRAKEN long 250) on an account that is really worth ~99.9.
 *
 * Gate reports `marginBalance 58.5366` because the HYPERLIQUID leg's margin (40.46) is subtracted
 * from that row's cash without being added back as an asset. Our own total is
 * `9.905 + 95.9641 - 12.6031 + 0.3065 + 6.1625 = 99.735` of stablecoin cash
 * `- 0.1044 + 0.2822 = 0.1778` of position uPnL = `99.9128`.
 * The ADA / ONE / SUI rows are coin quantities and must stay out of the sum.
 */
function livePortfolio(): AuthenticatedPortfolioSnapshot {
  const timestamp = '2026-10-26T12:09:00.000Z';
  return {
    dataStatus: 'fresh', remoteStatus: 'healthy',
    snapshot: {
      account: {
        availableMargin: '9.2', marginBalance: '58.5366', initialMargin: '49.33', maintenanceMargin: '8',
        initialMarginRate: '1.1865', maintenanceMarginRate: '0.1367', positionMode: 'SINGLE',
        accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: timestamp,
      },
      balances: [
        balanceRow('KRAKEN', 'USDC', '9.905', '0.2822', '10.1872'),
        balanceRow('CROSSEX', 'USDT', '95.9641', '0', '95.9641'),
        balanceRow('DERIBIT', 'USDC', '-12.6031', '0', '-12.6031'),
        balanceRow('LIGHTER', 'USDC', '0.3065', '0', '0.3065'),
        // The DEX leg whose locked margin Gate drops: balance 6.1625 but equity -34.3085.
        balanceRow('HYPERLIQUID', 'USDC', '6.1625', '-0.1044', '-34.3085'),
        // Coin quantities, not dollars.
        balanceRow('GATE', 'ADA', '0.9486', '0', '0.9486'),
        balanceRow('GATE', 'ONE', '0.4914', '0', '0.4914'),
        balanceRow('GATE', 'SUI', '0.0065', '0', '0.0065'),
      ],
      futuresPositions: [{
        positionId: 'hyperliquid-tread-short', symbol: 'HYPERLIQUID_FUTURE_TREAD_USDT', positionSide: 'SHORT',
        initialMargin: '40.1712', maintenanceMargin: '8', quantity: '250', value: '250',
        unrealizedPnl: '-0.1044', unrealizedPnlRate: '-0.0004', entryPrice: '1', markPrice: '1',
        leverage: '3', maxLeverage: '20', riskLimit: '1', fee: '0', fundingFee: '0',
        fundingTime: timestamp, createdAt: timestamp, updatedAt: timestamp, realizedPnl: '0',
      }],
      marginPositions: [{
        positionId: 'kraken-tread-long', symbol: 'KRAKEN_MARGIN_TREAD_USDT', positionSide: 'LONG',
        initialMargin: '39.8702', maintenanceMargin: '8', assetQuantity: '250', assetCoin: 'TREAD',
        value: '250', liability: '250', liabilityCoin: 'USDT', interest: '0', maxPositionQuantity: '1000',
        entryPrice: '1', indexPrice: '1', unrealizedPnl: '0.2822', unrealizedPnlRate: '0.0004',
        leverage: '3', maxLeverage: '5', createdAt: timestamp, updatedAt: timestamp,
      }],
      openOrders: [], recentFills: [], fetchedAt: timestamp,
      source: 'gate_crossex_authenticated_rest',
    },
    reconciliation: {
      id: 'reconciliation-live', createdAt: timestamp, status: 'clean', previousFetchedAt: timestamp,
      currentFetchedAt: timestamp, issues: [],
    },
  };
}

function renderPortfolio(portfolioSnapshot: AuthenticatedPortfolioSnapshot): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
      <PortfolioView
        tradingSnapshot={null}
        balances={{}}
        portfolio={portfolioSnapshot}
        accountStream={null}
        tradingMode="readonly"
        onOpenModeDialog={vi.fn()}
        onRefresh={vi.fn(async () => undefined)}
      />
    </LanguageContext.Provider>,
  );
}

describe('portfolio risk rendering', () => {
  it('renders both account-wide rates, their explanations, and the compact ADL signal', () => {
    const html = renderToStaticMarkup(
      <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
        <PortfolioView
          tradingSnapshot={null}
          balances={{}}
          portfolio={portfolio()}
          accountStream={null}
          tradingMode="readonly"
          onOpenModeDialog={vi.fn()}
          onRefresh={vi.fn(async () => undefined)}
        />
      </LanguageContext.Provider>,
    );

    expect(html).toContain('Current total initial margin ratio');
    expect(html).toContain('240%');
    expect(html).toContain('Above 110%, margin can be transferred out');
    expect(html).toContain('Current total maintenance margin ratio');
    expect(html).toContain('480%');
    expect(html).toContain('At or below 100%, CrossEx force-liquidates positions.');
    expect(html).toContain('Exchange ADL: 4/5 (raw rank 3)');
    expect(html).toContain('CrossEx ADL: 4/5');
    expect(html.match(/adl-signal danger/g)).toHaveLength(1);
    expect(html.match(/class="lit"/g)).toHaveLength(4);
  });

  it('shows our own total equity as the KPI, demotes Gate margin balance to the sub-line, and keeps available margin', () => {
    const html = renderPortfolio(livePortfolio());

    // KPI: stablecoin cash + position uPnL, i.e. 99.9128 and never Gate's 58.5366.
    expect(html).toContain('Total equity');
    expect(html).toContain('$99.91');
    // Gate's own figure survives as the secondary "Gate basis" line (58.5366 → 58.54), next to
    // the initial margin. The KPI above must not have been replaced by it.
    expect(html).toContain('$58.5');
    expect(html).toContain('Initial margin $49.33');
    // Available margin keeps its own source (`account.availableMargin`, 9.2).
    expect(html).toContain('Available margin');
    expect(html).toContain('$9.2');
    // The risk ratios still use the Gate basis and say so (58.5366 / 49.33 = 118.65%).
    expect(html).toContain('118.65%');
    expect(html).toContain('Gate basis: the denominator is Gate margin balance');
  });

  /**
   * The venues whose public REST is unreachable (Binance / OKX / Bybit / Kraken on this machine)
   * return positions without a mark price. Before this, the row fell back to `markPrice = 0`, so the
   * notional rendered a confident `0` — a fake loss on a real position.
   *
   * The assertions are scoped to the exact cells (size → notional → entry → mark) because `0 USDT`
   * also appears legitimately in the transfer form, and `+20.00 USDT` contains `0.00 USDT`.
   */
  it('renders an unknown notional instead of a fabricated zero when the venue sends no price', () => {
    const missingPrice = portfolio();
    missingPrice.snapshot.futuresPositions = [{
      ...missingPrice.snapshot.futuresPositions[0],
      markPrice: '',
      value: '',
    }];
    const html = renderPortfolio(missingPrice);

    // Size cell, then the notional cell: unknown, not `0 USDT`.
    expect(html).toContain('<td>0.0100 BTC</td><td>—</td>');
    // The entry price is venue-reported and independent of the mark price, so it still shows.
    expect(html).toContain('<td>62,000.0</td><td>—</td>');
    expect(html).toContain('+20.00 USDT');
    // The page-level marker explains the missing total, and exposure skips the unpriced leg.
    expect(html).toContain('Position notional — · 1');
    expect(html).toContain('Gross exposure</span><strong>$0</strong>');
  });

  it('keeps the venue-reported notional when only the mark price is missing', () => {
    const noMark = portfolio();
    noMark.snapshot.futuresPositions = [{
      ...noMark.snapshot.futuresPositions[0],
      markPrice: '0',
      value: '640',
    }];
    const html = renderPortfolio(noMark);

    // 640 of venue-marked notional survives (`formatAmount` drops the trailing zeros)...
    expect(html).toContain('<td>0.0100 BTC</td><td>640 USDT</td>');
    // ...while a `0` mark price is "no price", so the price cells print `—`.
    expect(html).toContain('<td>62,000.0</td><td>—</td>');
    expect(html).toContain('Gross exposure</span><strong>$640</strong>');
    // A known notional means nothing is missing from the totals, so no chip is shown.
    expect(html).not.toContain('Position notional — ·');
  });
});
