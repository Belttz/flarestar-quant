import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SpreadQualityRow } from '@gate-crossex/shared-types';
import {
  SpreadQualitySourceBadge,
  SpreadQualitySymmetryBadge,
  SpreadQualityTable,
  formatHalfLifeHours,
  formatOpportunityScore,
  formatSpreadQualityBps,
  groupSpreadQualityRows,
} from './spread-quality-table.js';

function qualityRow(overrides: Partial<SpreadQualityRow> = {}): SpreadQualityRow {
  return {
    pairType: 'PERP_PERP', asset: 'BTC',
    leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BINANCE_FUTURE_BTC_USDT',
    leftVenue: 'GATE', rightVenue: 'BINANCE',
    currentSpreadBps: 42.5, meanSpreadBps: 30.25, spreadVolatilityBps: 8.5,
    skewness: 0.42, excessKurtosis: 1.8, symmetric: true,
    ar1Coefficient: 0.82, halfLifeHours: 3.5, holdingCostBps: 1.25,
    bookDepthUsdt: 250000, score: 87.5, sampleCount: 288, source: 'candles',
    updatedAt: '2026-08-01T00:00:00.000Z',
    assetClass: 'TOKEN', assetSuperClass: 'CRYPTO', variantSuffix: null, isPreIpo: false,
    ...overrides,
  };
}

/** Server-render the table directly; no effects run, so the controlled expansion stays as passed. */
function renderTable(rows: readonly SpreadQualityRow[], expandedAsset: string | null = null): string {
  return renderToStaticMarkup(
    <SpreadQualityTable rows={rows} expandedAsset={expandedAsset} onToggleExpand={() => undefined} />,
  );
}

describe('spread-quality formatters', () => {
  it('renders a missing statistic as an em dash and a real one at fixed precision', () => {
    expect(formatSpreadQualityBps(null)).toBe('—');
    expect(formatSpreadQualityBps(30.25)).toBe('30.25');
    expect(formatSpreadQualityBps(-4)).toBe('-4.00');
    expect(formatHalfLifeHours(null)).toBe('—');
    expect(formatHalfLifeHours(3.5)).toBe('3.5');
    expect(formatOpportunityScore(87.5)).toBe('87.5');
    expect(formatOpportunityScore(100)).toBe('100.0');
  });
});

describe('groupSpreadQualityRows', () => {
  it('buckets combinations per asset and keeps the payload order inside each group', () => {
    const groups = groupSpreadQualityRows([
      qualityRow({ asset: 'ETH', score: 91.2 }),
      qualityRow({
        asset: 'BTC', leftVenue: 'OKX', leftSymbol: 'OKX_FUTURE_BTC_USDT',
        rightVenue: 'BYBIT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', score: 70,
      }),
      qualityRow({ asset: 'BTC', score: 90 }),
    ]);
    // Insertion order: the first appearance of an asset fixes the group's rank on the board.
    expect(groups.map((group) => group.asset)).toEqual(['ETH', 'BTC']);
    // The server pre-ranks combinations by score, so the first row of an asset is its best
    // combination — the grouping mirrors the payload order and never re-sorts (v1 ships no
    // client-side sorting, exactly like the spread board's best-path row).
    expect(groups[1].best.score).toBe(70);
    expect(groups[1].combinations.map((row) => row.score)).toEqual([70, 90]);
    expect(groups[0].combinations).toHaveLength(1);
  });

  it('returns no groups for an empty payload', () => {
    expect(groupSpreadQualityRows([])).toEqual([]);
  });
});

describe('SpreadQualityTable rendering', () => {
  it('renders every nullable statistic as an em dash, never a fake zero', () => {
    const row = qualityRow({
      meanSpreadBps: null, spreadVolatilityBps: null, skewness: null,
      excessKurtosis: null, halfLifeHours: null, holdingCostBps: null,
    });
    const html = renderTable([row]);
    // Six nullable statistics on the parent row — one dash each, and no zero standing in.
    expect([...html.matchAll(/—/g)]).toHaveLength(6);
    expect(html).not.toContain('0.00');
    expect(html).not.toContain('>0<');
    // Non-nullable readings still render.
    expect(html).toContain('42.50');
    expect(html).toContain('87.5');
  });

  it('presents rows in the server’s score-descending order', () => {
    const rows = [
      qualityRow({ asset: 'ETH', leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BINANCE_FUTURE_ETH_USDT', score: 91.2 }),
      qualityRow({ asset: 'SOL', leftSymbol: 'GATE_FUTURE_SOL_USDT', rightSymbol: 'BINANCE_FUTURE_SOL_USDT', score: 64.8 }),
      qualityRow({ asset: 'DOGE', leftSymbol: 'GATE_FUTURE_DOGE_USDT', rightSymbol: 'BINANCE_FUTURE_DOGE_USDT', score: 12.3 }),
    ];
    const scores = [...renderTable(rows).matchAll(/quality-score">(-?[\d.]+)</g)].map((match) => Number(match[1]));
    expect(scores).toEqual([91.2, 64.8, 12.3]);
    expect(scores.every((score, index) => index === 0 || scores[index - 1] >= score)).toBe(true);
  });

  it('marks a skewed distribution with a warning badge and a symmetric one with a check', () => {
    const skewed = renderTable([qualityRow({ symmetric: false })]);
    expect(skewed).toContain('quality-symmetry skew');
    expect(skewed).toContain('⚠');
    expect(skewed).toContain('title="Skewed distribution"');
    expect(skewed).not.toContain('quality-symmetry ok');

    const symmetric = renderTable([qualityRow({ symmetric: true })]);
    expect(symmetric).toContain('quality-symmetry ok');
    expect(symmetric).toContain('✓');
    expect(symmetric).toContain('title="Symmetric distribution"');
    expect(symmetric).not.toContain('⚠');
  });

  it('renders the standalone symmetry badge for both states', () => {
    expect(renderToStaticMarkup(<SpreadQualitySymmetryBadge symmetric={false} />)).toContain('quality-symmetry skew');
    expect(renderToStaticMarkup(<SpreadQualitySymmetryBadge symmetric />)).toContain('quality-symmetry ok');
  });

  it('renders both legs as a venue badge plus the mono symbol', () => {
    const html = renderTable([qualityRow()]);
    expect([...html.matchAll(/class="venue-badge"/g)]).toHaveLength(2);
    expect(html).toContain('Gate.io');
    expect(html).toContain('Binance');
    expect(html).toContain('GATE_FUTURE_BTC_USDT');
    expect(html).toContain('BINANCE_FUTURE_BTC_USDT');
  });

  it('formats the book depth compactly and reads zero as absent', () => {
    expect(renderTable([qualityRow({ bookDepthUsdt: 250000 })])).toContain('250K');
    expect(renderTable([qualityRow({ bookDepthUsdt: 0 })])).toContain('—');
  });

  it('exposes the per-asset expansion through an aria-expanded button', () => {
    const rows = [
      qualityRow({ score: 90 }),
      qualityRow({
        asset: 'BTC', leftVenue: 'OKX', leftSymbol: 'OKX_FUTURE_BTC_USDT',
        rightVenue: 'BYBIT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', score: 70,
      }),
      qualityRow({ asset: 'ETH', leftSymbol: 'GATE_FUTURE_ETH_USDT', rightSymbol: 'BINANCE_FUTURE_ETH_USDT', score: 50 }),
    ];
    const collapsed = renderTable(rows, null);
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).not.toContain('spread-quality-combination-table');

    const expanded = renderTable(rows, 'BTC');
    // One toggle per asset: the expanded one open, the other closed.
    expect([...expanded.matchAll(/aria-expanded="(true|false)"/g)].map((match) => match[1]))
      .toEqual(['true', 'false']);
    expect(expanded).toContain('spread-quality-combination-table');
    // The expanded asset lists every combination, best first; the other stays a parent row.
    expect(expanded).toContain('OKX_FUTURE_BTC_USDT');
    expect(expanded).toContain('best-tag');
    expect([...expanded.matchAll(/class="best"/g)]).toHaveLength(1);
  });
});

describe('SpreadQualitySourceBadge', () => {
  it('labels candles as a rebuild and samples as live sampling', () => {
    expect(renderToStaticMarkup(<SpreadQualitySourceBadge source="candles" />)).toContain('Candle rebuild');
    expect(renderToStaticMarkup(<SpreadQualitySourceBadge source="samples" />)).toContain('Live sampling');
  });
});
