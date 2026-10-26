import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SpreadQualityRow } from '@gate-crossex/shared-types';
import {
  LegFundingRates,
  formatFundingRateDiffBps,
  formatFundingRatePercent,
  hasFundingRate,
} from './leg-funding-rates.js';
import { SpreadQualityTable } from './spread-quality-table.js';

/**
 * The current funding rate of both spread legs.
 *
 * `renderToStaticMarkup` is the project's SSR harness: it runs the render path (no effects, no
 * fetch), which is exactly what these assertions need — the cell is pure presentation.
 */
function renderCell(props: { left?: string | null; right?: string | null; diff?: number | null }): string {
  return renderToStaticMarkup(<LegFundingRates
    leftFundingRate8h={props.left ?? null}
    rightFundingRate8h={props.right ?? null}
    fundingRateDiffBps={props.diff ?? null}
  />);
}

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

describe('funding-rate formatting', () => {
  it('renders a Decimal fraction as a percentage of the position per 8h', () => {
    // 0.00013 is the venue's own 8h-equivalent fraction — 0.0130% of the position.
    expect(formatFundingRatePercent('0.00013')).toBe('0.0130%');
    expect(formatFundingRatePercent('0.0001')).toBe('0.0100%');
    expect(formatFundingRatePercent('-0.00005')).toBe('-0.0050%');
    // A genuine zero is a measurement: the venue reported free carry, so it renders as 0.
    expect(formatFundingRatePercent('0')).toBe('0.0000%');
  });

  it('renders a missing rate as an em dash instead of a fake zero', () => {
    expect(formatFundingRatePercent(null)).toBe('—');
    expect(formatFundingRatePercent(undefined)).toBe('—');
    expect(formatFundingRatePercent('')).toBe('—');
    expect(formatFundingRatePercent('not-a-number')).toBe('—');
    expect(hasFundingRate(null)).toBe(false);
    expect(hasFundingRate('0')).toBe(true);
  });

  it('signs the funding differential so its direction is readable', () => {
    expect(formatFundingRateDiffBps(1.8)).toBe('+1.80');
    expect(formatFundingRateDiffBps(-0.3)).toBe('-0.30');
    expect(formatFundingRateDiffBps(0)).toBe('0.00');
    expect(formatFundingRateDiffBps(null)).toBe('—');
    expect(formatFundingRateDiffBps(undefined)).toBe('—');
    expect(formatFundingRateDiffBps(Number.NaN)).toBe('—');
  });
});

describe('LegFundingRates SSR', () => {
  it('shows both legs\' current rate and the differential when the venues publish them', () => {
    const html = renderCell({ left: '0.00013', right: '-0.00005', diff: 1.8 });
    expect(html).toContain('data-funding-rates="available"');
    expect(html).toContain('data-funding-leg="left"');
    expect(html).toContain('data-funding-leg="right"');
    expect(html).toContain('0.0130%');
    expect(html).toContain('-0.0050%');
    expect(html).toContain('+1.80 bps');
    expect(html).not.toContain('—');
  });

  it('renders em dashes — never 0.0000% — when neither leg has a funding rate', () => {
    const html = renderCell({ left: null, right: null, diff: null });
    expect(html).toContain('data-funding-rates="unavailable"');
    // Both legs plus the differential: three dashes, and no fabricated zero anywhere.
    expect(html.split('—')).toHaveLength(4);
    expect(html).not.toContain('0.0000%');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
    // The tooltip explains the blank instead of leaving the reader guessing.
    expect(html).toContain('Funding rate unavailable');
  });

  it('keeps a known leg visible when only the other leg has no rate', () => {
    // A spot leg has no funding; the perpetual leg's rate must still show, and the differential
    // of a half-known pair stays unknown rather than passing the known leg off as the net.
    const html = renderCell({ left: '0.0001', right: null, diff: null });
    expect(html).toContain('data-funding-rates="available"');
    expect(html).toContain('0.0100%');
    expect(html).toContain('Δ —');
  });
});

describe('spread-quality board funding column', () => {
  it('renders the column header and both states in one board', () => {
    const html = renderToStaticMarkup(<SpreadQualityTable
      rows={[
        qualityRow({ leftFundingRate8h: '0.00013', rightFundingRate8h: '-0.00005', fundingRateDiffBps: 1.8 }),
        qualityRow({
          asset: 'ETH', score: 50,
          leftSymbol: 'GATE_SPOT_ETH_USDT', rightSymbol: 'BINANCE_FUTURE_ETH_USDT',
          leftFundingRate8h: null, rightFundingRate8h: null, fundingRateDiffBps: null,
        }),
      ]}
      expandedAsset={null}
      onToggleExpand={() => undefined}
    />);
    expect(html).toContain('Funding rate');
    // The published pair renders its numbers…
    expect(html).toContain('0.0130%');
    expect(html).toContain('+1.80 bps');
    // …and the spot-legged pair, which has no funding to report, renders dashes.
    expect(html).toContain('data-funding-rates="unavailable"');
    expect(html).not.toContain('0.0000%');
  });

  it('renders a rate the payload omits entirely (old backend) as a dash, not a crash', () => {
    const legacy = qualityRow();
    delete (legacy as { leftFundingRate8h?: string | null }).leftFundingRate8h;
    delete (legacy as { rightFundingRate8h?: string | null }).rightFundingRate8h;
    delete (legacy as { fundingRateDiffBps?: number | null }).fundingRateDiffBps;
    const html = renderToStaticMarkup(<SpreadQualityTable
      rows={[legacy]}
      expandedAsset={null}
      onToggleExpand={() => undefined}
    />);
    expect(html).toContain('data-funding-rates="unavailable"');
    expect(html).toContain('—');
    expect(html).not.toContain('NaN');
  });
});
