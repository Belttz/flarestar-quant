import { FUNDING_STAT_VENUES, PublicMarketDataError } from '@gate-crossex/public-data';
import type { FundingStatVenue, PublicMarketDataGateway, VenueFundingStat } from '@gate-crossex/public-data';
import type { FundingOverviewResponse, FundingOverviewVenueEntry, MarketCatalogVenue } from '@gate-crossex/shared-types';

interface VenueCacheEntry {
  rows: Map<string, VenueFundingStat>;
  fetchedAt: string | null;
  ok: boolean;
  rowCount: number;
}

export interface FundingOverviewCatalogView {
  assets: ReadonlyMap<string, MarketCatalogVenue[]>;
}

export interface FundingOverviewServiceOptions {
  /** Age after which a request triggers a background refresh; a cold cache always awaits one sweep. */
  freshMs?: number;
  /** More frequent refresh interval around the hourly funding settlements on Hyperliquid and Lighter. */
  settlementFreshMs?: number;
  now?: () => number;
  warn?: (venue: string, reason: string) => void;
}

const DEFAULT_FRESH_MS = 5 * 60_000;
const DEFAULT_SETTLEMENT_FRESH_MS = 30_000;
const SETTLEMENT_WINDOW_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const CROSSEX_FUTURE_SYMBOL = /^[A-Z0-9]+_FUTURE_([A-Z0-9]+)_(?:USDT|USDC|USD)$/;

function nativeAssetFromSymbol(symbol: string): string | null {
  return CROSSEX_FUTURE_SYMBOL.exec(symbol)?.[1] ?? null;
}

/** Refresh faster from five minutes before until five minutes after each UTC hour. */
export function fundingOverviewRefreshInterval(now: number): number {
  const positionInHour = ((now % HOUR_MS) + HOUR_MS) % HOUR_MS;
  return positionInHour >= HOUR_MS - SETTLEMENT_WINDOW_MS || positionInHour < SETTLEMENT_WINDOW_MS
    ? DEFAULT_SETTLEMENT_FRESH_MS
    : DEFAULT_FRESH_MS;
}

/**
 * Aggregates funding rate and open interest for every catalog perpetual from the venues' bulk
 * public REST feeds. The CrossEx WebSocket cannot cover this breadth — its public channels are
 * capped at 100 symbols per connection — so the overview is REST-polled instead, on demand only:
 * nothing is fetched until the funding page asks, and nothing runs while it is closed.
 */
export class FundingOverviewService {
  private readonly venues = new Map<FundingStatVenue, VenueCacheEntry>();
  private refreshInFlight: Promise<void> | null = null;
  private lastRefreshCompletedAt: number | null = null;
  private readonly freshMs: number;
  private readonly settlementFreshMs: number;
  private readonly now: () => number;
  private readonly warn: (venue: string, reason: string) => void;

  constructor(private readonly gateway: PublicMarketDataGateway, options: FundingOverviewServiceOptions = {}) {
    this.freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
    // A fixed freshMs in tests/custom deployments remains fixed unless an explicit settlement
    // interval is also supplied.
    this.settlementFreshMs = options.settlementFreshMs ?? options.freshMs ?? DEFAULT_SETTLEMENT_FRESH_MS;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? (() => undefined);
  }

  /** Cold call awaits the first sweep; warm calls serve cached rows and revalidate in the background. */
  async ensureFresh(): Promise<void> {
    if (typeof this.gateway.queryVenueFundingStats !== 'function') return;
    const last = this.lastRefreshCompletedAt;
    const now = this.now();
    if (last !== null && now - last <= this.currentFreshMs(now)) return;
    const refresh = this.refresh();
    if (last === null) await refresh;
  }

  private currentFreshMs(now = this.now()): number {
    return fundingOverviewRefreshInterval(now) === DEFAULT_SETTLEMENT_FRESH_MS
      ? this.settlementFreshMs
      : this.freshMs;
  }

  private refresh(): Promise<void> {
    this.refreshInFlight ??= (async () => {
      const query = this.gateway.queryVenueFundingStats;
      if (!query) return;
      const results = await Promise.allSettled(
        FUNDING_STAT_VENUES.map(async (venue) => await query.call(this.gateway, venue)),
      );
      const fetchedAt = new Date(this.now()).toISOString();
      results.forEach((result, index) => {
        const venue = FUNDING_STAT_VENUES[index];
        if (!venue) return;
        if (result.status === 'fulfilled') {
          const rows = new Map<string, VenueFundingStat>();
          for (const stat of result.value) rows.set(`${stat.base}:${stat.quote}`, stat);
          this.venues.set(venue, { rows, fetchedAt, ok: true, rowCount: rows.size });
          return;
        }
        this.warn(venue, result.reason instanceof PublicMarketDataError ? result.reason.code : 'PUBLIC_DATA_ERROR');
        // Keep last-good rows so one upstream blip does not blank the page; status reports the failure.
        const previous = this.venues.get(venue);
        this.venues.set(venue, {
          rows: previous?.rows ?? new Map(),
          fetchedAt: previous?.fetchedAt ?? null,
          ok: false,
          rowCount: previous?.rowCount ?? 0,
        });
      });
      this.lastRefreshCompletedAt = this.now();
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  /**
   * Cached funding settlement interval in hours for one executable perpetual symbol, or null
   * when the venue row is unknown (never fetched, upstream error, or non-futures symbol). The
   * carry strategy engine uses this to annualize funding and advance its accrual clock.
   */
  fundingIntervalFor(symbol: string): number | null {
    const match = CROSSEX_FUTURE_SYMBOL.exec(symbol);
    if (!match) return null;
    const nativeAsset = match[1];
    if (!nativeAsset) return null;
    const parts = symbol.split('_');
    const venue = parts[0] as FundingStatVenue;
    const quote = parts[3] ?? '';
    return this.venues.get(venue)?.rows.get(`${nativeAsset}:${quote}`)?.fundingIntervalHours ?? null;
  }

  buildResponse(catalog: FundingOverviewCatalogView): FundingOverviewResponse {
    const assets = [...catalog.assets.entries()].map(([asset, venueList]) => ({
      asset,
      // Spot catalog rows share the perpetual's base/quote but carry no funding, so they are
      // skipped — otherwise they would join a perp stat and fabricate a funding row.
      venues: venueList.filter((entry) => entry.business !== 'SPOT').map((entry): FundingOverviewVenueEntry => {
        const cached = this.venues.get(entry.venue as FundingStatVenue);
        // Catalog assets are canonical identities, while venue statistics retain the native
        // ticker. Join through the executable CrossEx symbol so aliases never alter routing.
        const nativeAsset = nativeAssetFromSymbol(entry.symbol) ?? asset;
        const stat = cached?.rows.get(`${nativeAsset}:${entry.quote}`);
        return {
          venue: entry.venue,
          symbol: entry.symbol,
          quote: entry.quote,
          fundingRate: stat?.fundingRate ?? null,
          fundingIntervalHours: stat?.fundingIntervalHours ?? null,
          fundingRate8h: stat?.fundingRate8h ?? null,
          nextFundingAt: stat?.nextFundingAt ?? null,
          openInterestValue: stat?.openInterestValue ?? null,
          lastPrice: stat?.lastPrice ?? null,
          change24h: stat?.change24h ?? null,
          fetchedAt: stat ? cached?.fetchedAt ?? null : null,
        };
      }),
    }));
    const venueStatus = FUNDING_STAT_VENUES.map((venue) => {
      const entry = this.venues.get(venue);
      return {
        venue,
        status: entry?.ok ? ('ok' as const) : ('error' as const),
        fetchedAt: entry?.fetchedAt ?? null,
        rowCount: entry?.rowCount ?? 0,
      };
    });
    const newestFetch = venueStatus.reduce<string | null>(
      (newest, entry) => (entry.fetchedAt && (!newest || entry.fetchedAt > newest) ? entry.fetchedAt : newest),
      null,
    );
    return {
      assets,
      venueStatus,
      fetchedAt: newestFetch ?? new Date(this.now()).toISOString(),
      cacheStatus: this.lastRefreshCompletedAt !== null && this.now() - this.lastRefreshCompletedAt <= this.currentFreshMs() * 2 ? 'fresh' : 'stale',
    };
  }
}
