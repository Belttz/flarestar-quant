import type { SpreadLegFunding } from '@gate-crossex/shared-types';
import { useLanguage } from './i18n.js';

/**
 * Current funding rate of one spread leg, as a percentage of the position value per 8h.
 *
 * The backend sends the venue's own 8h-equivalent fraction (`0.00013` = 0.013%), the same unit the
 * funding board's `Per 8h` column uses, so the two never disagree. Four decimals match that column:
 * one settlement of a typical perpetual (0.01%) lands exactly on `0.0100%`.
 *
 * Missing data is an em dash — never `0.0000%`. A zero funding rate is a real measurement (the
 * pair carries for free) while a missing one means the leg has no rate at all (a spot leg, or a
 * venue that publishes none); rendering them alike would misprice the trade.
 */
export function formatFundingRatePercent(rate8h: string | null | undefined): string {
  if (rate8h === null || rate8h === undefined) return '—';
  if (typeof rate8h !== 'string' || rate8h.trim() === '') return '—';
  const parsed = Number(rate8h);
  if (!Number.isFinite(parsed)) return '—';
  return `${(parsed * 100).toFixed(4)}%`;
}

/**
 * Funding differential of the pair in bps per 8h, signed: positive means the pair collects
 * funding while both legs are held, negative means it pays. `null` (either leg unknown) is a
 * dash, for the same reason the per-leg rate is.
 */
export function formatFundingRateDiffBps(diffBps: number | null | undefined): string {
  if (diffBps === null || diffBps === undefined) return '—';
  if (!Number.isFinite(diffBps)) return '—';
  // A positive differential carries an explicit `+`: the sign is the actionable part (collect
  // vs pay), and a bare "1.30" would read as neutral.
  return `${diffBps > 0 ? '+' : ''}${diffBps.toFixed(2)}`;
}

/** Whether both legs publish a rate — the cell then renders the differential line. */
export function hasFundingRate(rate8h: string | null | undefined): boolean {
  return formatFundingRatePercent(rate8h) !== '—';
}

/**
 * The funding-rate cell of one spread row: the sell leg's rate over the buy leg's rate, then the
 * differential. Both rates are always rendered (a dash when unavailable) so the reader can see
 * *which* leg is missing instead of the whole cell silently collapsing.
 *
 * The leg order follows the boards' orientation — sell leg first, buy leg second — and matches the
 * neighbouring "Best path" / leg cells, so the first number is always the leg the row sells.
 */
export function LegFundingRates({
  leftFundingRate8h,
  rightFundingRate8h,
  fundingRateDiffBps,
}: SpreadLegFunding) {
  const { t } = useLanguage();
  const label = t('Funding rate (current)');
  const left = formatFundingRatePercent(leftFundingRate8h);
  const right = formatFundingRatePercent(rightFundingRate8h);
  const diff = formatFundingRateDiffBps(fundingRateDiffBps);
  const unavailable = !hasFundingRate(leftFundingRate8h) && !hasFundingRate(rightFundingRate8h);
  return <span className="opportunity-leg leg-funding-rates"
    data-funding-rates={unavailable ? 'unavailable' : 'available'}
    title={unavailable ? t('Funding rate unavailable') : `${label} · ${t('Per 8h')}`}>
    <b data-funding-leg="left" title={`${t('Sell leg')} · ${label} · ${t('Per 8h')}`}>{left}</b>
    <small data-funding-leg="right" title={`${t('Buy leg')} · ${label} · ${t('Per 8h')}`}>{right}</small>
    <small data-funding-diff="" title={t('Funding differential while both legs are held, per 8h')}>
      {diff === '—' ? 'Δ —' : `Δ ${diff} bps`}
    </small>
  </span>;
}
