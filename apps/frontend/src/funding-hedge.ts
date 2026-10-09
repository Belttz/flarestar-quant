import type { FundingHistoryEntry, FundingOverviewAsset } from './api.js';
import type { FundingOpportunity } from '@gate-crossex/shared-types';
import { cumulativeFundingPercent, fundingPercentScaledTo8h } from './funding-rates.js';
import type { ExchangeLogoId } from './exchange-logos.js';
import { exchanges, fundingVenueName, type PairedPositionPrefill } from './route-shared.js';

/**
 * Pure model behind the Opportunities funding boards.
 *
 * A funding hedge is two legs of the same asset: the leg we SHORT collects its funding rate, the
 * leg we LONG pays it, so the net funding received per 8h is `rate8h(short) − rate8h(long)`.
 * Orienting every pair towards the higher-rate venue makes that net non-negative, which is what
 * the board ranks. A spot leg always carries a zero rate, so the spot ⇄ perpetual carry board is
 * the same model with a spot leg instead of a second perpetual.
 *
 * Everything here is dependency-free so the tables can be unit-tested without a DOM.
 */

/** Funding settles three times a day on the 8h venues; the comparable rate is annualized on this. */
export const FUNDING_PERIODS_PER_YEAR = 1095;

export type FundingHedgeLegKind = 'spot' | 'perp';

export interface FundingHedgeLeg {
  /** Uppercase venue code, e.g. `BYBIT`. */
  venue: string;
  /** Executable symbol on that venue; the spot leg carries its own spot symbol. */
  symbol: string;
  kind: FundingHedgeLegKind;
  /** Native funding fraction in percent over the venue's own settlement interval. */
  ratePercent: number | null;
  /** Comparable 8h-equivalent funding fraction in percent. */
  rate8hPercent: number | null;
  /** Venue settlement interval in hours; null for a spot leg. */
  intervalHours: number | null;
  nextFundingAt: string | null;
}

export interface FundingHedgeRow {
  /** Stable identity: asset + both venue codes in canonical order. */
  key: string;
  asset: string;
  /** Exchange pair in canonical order, used for the `A ⇄ B` cell. */
  pair: [string, string];
  /** Display order of the two legs; always the same two objects as `short` / `long`. */
  legs: [FundingHedgeLeg, FundingHedgeLeg];
  /** Leg whose funding we collect (the higher-rate venue). */
  short: FundingHedgeLeg;
  /** Leg whose funding we pay (the lower-rate venue). */
  long: FundingHedgeLeg;
  /** Net funding received per 8h in percent of notional; never negative. */
  net8hPercent: number;
  /** net8hPercent annualized without compounding, in percent. */
  aprPercent: number;
  /** net8hPercent annualized with per-settlement compounding, in percent. */
  apyPercent: number;
  /** Aggregate open interest of the venues that publish it, in USD. */
  openInterestValue: number;
  /** Realized 24h funding of the row, resolved from history; null until it loads. */
  net24hPercent: number | null;
  /** Spot ⇄ perpetual rows keep their carry prefill source; perpetual pairs have none. */
  carry: FundingOpportunity | null;
}

export type FundingHedgeSortKey = 'net' | 'apr' | 'asset' | 'countdown' | 'oi';

/** Percent gained over one compounding period, converted into an annual percentage yield. */
export function fundingApyPercent(periodPercent: number, periodsPerYear: number): number {
  if (!Number.isFinite(periodPercent) || !Number.isFinite(periodsPerYear) || periodsPerYear <= 0) return 0;
  const growth = (1 + periodPercent / 100) ** periodsPerYear - 1;
  return Number.isFinite(growth) ? growth * 100 : 0;
}

/** Signed percentage from a decimal fraction string, e.g. `'0.0001'` → `0.01`. */
function fractionPercent(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = Number(value) * 100;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Orient a pair towards the higher-rate venue. Returns null when either leg has no comparable
 * rate, because an unrated leg cannot be ranked or executed.
 */
export function orientFundingHedge(
  first: FundingHedgeLeg,
  second: FundingHedgeLeg,
): { short: FundingHedgeLeg; long: FundingHedgeLeg; net8hPercent: number } | null {
  const firstRate = first.rate8hPercent ?? (first.kind === 'spot' ? 0 : null);
  const secondRate = second.rate8hPercent ?? (second.kind === 'spot' ? 0 : null);
  if (firstRate === null || secondRate === null) return null;
  const short = firstRate >= secondRate ? first : second;
  const long = firstRate >= secondRate ? second : first;
  return { short, long, net8hPercent: Math.abs(firstRate - secondRate) };
}

function hedgeFinancials(net8hPercent: number): { aprPercent: number; apyPercent: number } {
  return {
    aprPercent: net8hPercent * FUNDING_PERIODS_PER_YEAR,
    apyPercent: fundingApyPercent(net8hPercent, FUNDING_PERIODS_PER_YEAR),
  };
}

/** Venue options shared by the funding toolbar and the ranking selector. */
export function fundingVenueOptions(): ReadonlyArray<{ code: string; id: string; name: string; short: string }> {
  return exchanges.map((venue) => ({ code: venue.id.toUpperCase(), id: venue.id, name: venue.name, short: venue.short }));
}

/**
 * Perpetual ⇄ perpetual funding hedges: every venue pair on one asset whose both legs publish a
 * comparable 8h rate, restricted to the selected venues. The result is one row per (asset, pair).
 */
export function buildPerpFundingHedges(
  assets: ReadonlyArray<FundingOverviewAsset>,
  venues: ReadonlyArray<string>,
): FundingHedgeRow[] {
  const allowed = new Set(venues.map((venue) => venue.toUpperCase()));
  const rows: FundingHedgeRow[] = [];
  for (const entry of assets) {
    const legs = entry.venues.flatMap((venue): FundingHedgeLeg[] => {
      if (!allowed.has(venue.venue.toUpperCase())) return [];
      const rate = fractionPercent(venue.fundingRate);
      const rate8h = fractionPercent(venue.fundingRate8h)
        ?? fundingPercentScaledTo8h(rate, venue.fundingIntervalHours);
      if (rate8h === null) return [];
      return [{
        venue: venue.venue.toUpperCase(),
        symbol: venue.symbol,
        kind: 'perp',
        ratePercent: rate,
        rate8hPercent: rate8h,
        intervalHours: venue.fundingIntervalHours,
        nextFundingAt: venue.nextFundingAt,
      }];
    }).sort((left, right) => left.venue.localeCompare(right.venue));
    for (let i = 0; i < legs.length; i += 1) {
      for (let j = i + 1; j < legs.length; j += 1) {
        const first = legs[i]!;
        const second = legs[j]!;
        const oriented = orientFundingHedge(first, second);
        if (!oriented) continue;
        // The pairs were built from a venue-sorted leg list, so pair order is already canonical.
        const pair: [string, string] = [first.venue, second.venue];
        const openInterestValue = entry.venues
          .filter((venue) => allowed.has(venue.venue.toUpperCase()) && pair.includes(venue.venue.toUpperCase()))
          .reduce((total, venue) => total + (Number(venue.openInterestValue) || 0), 0);
        rows.push({
          key: `${entry.asset}:${pair[0]}:${pair[1]}`,
          asset: entry.asset,
          pair,
          legs: [first, second],
          short: oriented.short,
          long: oriented.long,
          net8hPercent: oriented.net8hPercent,
          ...hedgeFinancials(oriented.net8hPercent),
          openInterestValue,
          net24hPercent: null,
          carry: null,
        });
      }
    }
  }
  return rows;
}

/**
 * Spot ⇄ perpetual carry rows restyled into the hedge model: the perpetual carries the funding,
 * the spot leg is rated zero, and the carry prefill source is preserved for the execute button.
 */
export function buildCarryFundingHedges(rows: ReadonlyArray<FundingOpportunity>): FundingHedgeRow[] {
  return rows.flatMap((row): FundingHedgeRow[] => {
    const ratePercent = fractionPercent(row.fundingRate8h);
    if (ratePercent === null) return [];
    const perp: FundingHedgeLeg = {
      venue: row.venue.toUpperCase(),
      symbol: row.symbol,
      kind: 'perp',
      ratePercent,
      rate8hPercent: ratePercent,
      intervalHours: row.fundingIntervalHours,
      nextFundingAt: row.nextFundingAt,
    };
    const spotVenue = (row.spotVenue ?? 'GATE').toUpperCase();
    const spot: FundingHedgeLeg = {
      venue: spotVenue,
      symbol: row.spotSymbol ?? '',
      kind: 'spot',
      ratePercent: 0,
      rate8hPercent: 0,
      intervalHours: null,
      nextFundingAt: null,
    };
    const oriented = orientFundingHedge(perp, spot);
    if (!oriented) return [];
    // The perpetual always leads: it is the leg that carries the funding rate being harvested.
    return [{
      key: `${row.asset}:${perp.venue}:${spot.venue}`,
      asset: row.asset,
      pair: [perp.venue, spot.venue],
      legs: [perp, spot],
      short: oriented.short,
      long: oriented.long,
      net8hPercent: oriented.net8hPercent,
      ...hedgeFinancials(oriented.net8hPercent),
      openInterestValue: Number(row.perpStats?.openInterestValue ?? 0) || 0,
      net24hPercent: null,
      carry: row,
    }];
  });
}

/**
 * Realized 24h funding of one hedge, resolved from the per-symbol history cache. A spot leg
 * contributes exactly zero; a leg without loaded history makes the whole row unknown.
 */
export function hedgeNet24hPercent(
  row: FundingHedgeRow,
  historyBySymbol: Readonly<Record<string, FundingHistoryEntry>>,
): number | null {
  const legCumulative = (leg: FundingHedgeLeg): number | null => {
    if (leg.kind === 'spot') return 0;
    const entry = historyBySymbol[leg.symbol];
    if (!entry || entry.status !== 'ok') return null;
    return cumulativeFundingPercent(entry.rate24h);
  };
  const short = legCumulative(row.short);
  const long = legCumulative(row.long);
  if (short === null || long === null) return null;
  return short - long;
}

/** Milliseconds until a settlement; null when the venue publishes no next-settlement time. */
export function fundingCountdownMs(targetIso: string | null, nowMs: number): number | null {
  if (targetIso === null || targetIso === '') return null;
  const target = Date.parse(targetIso);
  if (!Number.isFinite(target)) return null;
  return target - nowMs;
}

/** Compact countdown label: `3h 12m`, `46m`, `now`. */
export function formatFundingCountdown(ms: number | null): string {
  if (ms === null) return '—';
  if (ms <= 0) return 'now';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Signed percentage with a leading `+` for positive values. */
export function formatFundingPercent(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

/** The settlement leg of a hedge: the perpetual side that actually pays or collects funding. */
export function hedgeFundingLeg(row: FundingHedgeRow): FundingHedgeLeg {
  return row.short.kind === 'perp' ? row.short : row.long;
}

/** Human-readable exchange pair, e.g. `Binance ⇄ Bybit`. */
export function hedgePairLabel(row: FundingHedgeRow): string {
  return `${fundingVenueName(row.pair[0])} ⇄ ${fundingVenueName(row.pair[1])}`;
}

/**
 * Prefill for the paired-position strategy form. The paired-position page never reads the URL
 * query — it only accepts this prefill object — so a hedge row has to be translated here rather
 * than navigated to with query parameters. The higher-funding venue becomes leg A (the short).
 */
export function hedgePairedPositionPrefill(row: FundingHedgeRow): PairedPositionPrefill {
  return {
    asset: row.asset,
    shortVenue: row.short.venue.toLowerCase() as ExchangeLogoId,
    longVenue: row.long.venue.toLowerCase() as ExchangeLogoId,
  };
}

/** The ranking's own order plus every column the funding board can sort by. */
export function sortFundingHedges(
  rows: ReadonlyArray<FundingHedgeRow>,
  key: FundingHedgeSortKey,
  direction: 'asc' | 'desc',
  nowMs: number,
): FundingHedgeRow[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    if (key === 'asset') return left.asset.localeCompare(right.asset) * multiplier || left.key.localeCompare(right.key);
    if (key === 'oi') return (left.openInterestValue - right.openInterestValue) * multiplier || left.key.localeCompare(right.key);
    if (key === 'countdown') {
      const leftMs = fundingCountdownMs(hedgeFundingLeg(left).nextFundingAt, nowMs);
      const rightMs = fundingCountdownMs(hedgeFundingLeg(right).nextFundingAt, nowMs);
      if (leftMs === null || rightMs === null) return leftMs === rightMs ? left.key.localeCompare(right.key) : leftMs === null ? 1 : -1;
      return (leftMs - rightMs) * multiplier || left.key.localeCompare(right.key);
    }
    const leftValue = key === 'apr' ? left.aprPercent : left.net8hPercent;
    const rightValue = key === 'apr' ? right.aprPercent : right.net8hPercent;
    return (leftValue - rightValue) * multiplier || left.key.localeCompare(right.key);
  });
}

export interface VenueFundingRankingRow {
  asset: string;
  symbol: string;
  /** Native funding fraction in percent over the venue's own interval. */
  ratePercent: number;
  /** |ratePercent|, the ranking key. */
  absRatePercent: number;
  intervalHours: number | null;
  nextFundingAt: string | null;
  openInterestValue: number | null;
  lastPrice: string | null;
  change24hPercent: number | null;
  updatedAt: string | null;
}

/**
 * One venue's perpetual funding ranking, largest absolute rate first — the funding-rate-extremes
 * view: it needs no second venue, so it surfaces the pairs the hedge board cannot rank.
 */
export function buildVenueFundingRanking(
  assets: ReadonlyArray<FundingOverviewAsset>,
  venueCode: string,
  limit: number,
): VenueFundingRankingRow[] {
  const target = venueCode.toUpperCase();
  const rows: VenueFundingRankingRow[] = [];
  for (const entry of assets) {
    const venue = entry.venues.find((candidate) => candidate.venue.toUpperCase() === target);
    if (!venue) continue;
    const ratePercent = fractionPercent(venue.fundingRate);
    if (ratePercent === null) continue;
    const openInterest = venue.openInterestValue === null ? null : Number(venue.openInterestValue);
    const change = fractionPercent(venue.change24h);
    rows.push({
      asset: entry.asset,
      symbol: venue.symbol,
      ratePercent,
      absRatePercent: Math.abs(ratePercent),
      intervalHours: venue.fundingIntervalHours,
      nextFundingAt: venue.nextFundingAt,
      openInterestValue: openInterest !== null && Number.isFinite(openInterest) ? openInterest : null,
      lastPrice: venue.lastPrice,
      change24hPercent: change,
      updatedAt: venue.fetchedAt ?? null,
    });
  }
  return rows
    .sort((left, right) => right.absRatePercent - left.absRatePercent || left.asset.localeCompare(right.asset))
    .slice(0, Math.max(0, limit));
}

/** Expanded view of one asset: every venue that lists its perpetual, selected venue or not. */
export interface AssetFundingVenueRow {
  venue: string;
  /** Executable CrossEx symbol on that venue. */
  symbol: string;
  quote: string;
  /** Native funding fraction in percent over the venue's own settlement interval. */
  ratePercent: number | null;
  /** 8h-equivalent funding fraction in percent. */
  rate8hPercent: number | null;
  /** |ratePercent|; null when the venue publishes no rate at all. */
  absRatePercent: number | null;
  intervalHours: number | null;
  nextFundingAt: string | null;
  openInterestValue: number | null;
  lastPrice: string | null;
  updatedAt: string | null;
}

/**
 * Every venue's perpetual funding on one asset, ranked by absolute native rate. A venue whose
 * rate is missing keeps its row with nulls instead of disappearing — the gap is the information,
 * and the asset detail exists precisely to show which venue is missing.
 */
export function buildAssetFundingVenues(
  assets: ReadonlyArray<FundingOverviewAsset>,
  asset: string,
): AssetFundingVenueRow[] {
  const entry = assets.find((candidate) => candidate.asset === asset);
  if (!entry) return [];
  return entry.venues.map((venue): AssetFundingVenueRow => {
    const ratePercent = fractionPercent(venue.fundingRate);
    const rate8hPercent = fractionPercent(venue.fundingRate8h)
      ?? fundingPercentScaledTo8h(ratePercent, venue.fundingIntervalHours);
    const openInterest = venue.openInterestValue === null ? null : Number(venue.openInterestValue);
    return {
      venue: venue.venue.toUpperCase(),
      symbol: venue.symbol,
      quote: venue.quote,
      ratePercent,
      rate8hPercent,
      absRatePercent: ratePercent === null ? null : Math.abs(ratePercent),
      intervalHours: venue.fundingIntervalHours,
      nextFundingAt: venue.nextFundingAt,
      openInterestValue: openInterest !== null && Number.isFinite(openInterest) ? openInterest : null,
      lastPrice: venue.lastPrice,
      updatedAt: venue.fetchedAt ?? null,
    };
  }).sort((left, right) => {
    if (left.absRatePercent === null || right.absRatePercent === null) {
      return left.absRatePercent === right.absRatePercent
        ? left.venue.localeCompare(right.venue)
        : left.absRatePercent === null ? 1 : -1;
    }
    return right.absRatePercent - left.absRatePercent || left.venue.localeCompare(right.venue);
  });
}

/** `8h` / `4h` / `1h`, or null when the venue publishes no interval. */
export function formatFundingInterval(hours: number | null): string | null {
  if (hours === null || !Number.isFinite(hours) || hours <= 0) return null;
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`;
}
