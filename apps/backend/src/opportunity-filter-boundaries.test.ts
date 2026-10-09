import { describe, expect, it } from 'vitest';
import type { FundingOverviewResponse, MarketCatalogVenue } from '@gate-crossex/shared-types';
import type { LiveMarket, MarketSnapshot } from './market-hub.js';
import { OpportunityService } from './opportunity-service.js';

/**
 * Independent acceptance tests for the spread board's `venues` / `pairTypes` whitelists. They go
 * beyond the happy path: duplicate, mixed-case and unknown tokens, the AND semantics between the
 * two whitelists, the fact that the row cap is applied *after* the whitelist, and — critically —
 * that neither whitelist leaks into the funding board.
 */

const EPOCH = '2026-08-01T00:00:00.000Z';

function liveMarket(overrides: Partial<LiveMarket> & Pick<LiveMarket, 'symbol' | 'venue' | 'asset'>): LiveMarket {
  return {
    lastPrice: '100', bidPrice: '99', bidSize: '1', askPrice: '101', askSize: '1',
    open24h: '100', high24h: '110', low24h: '90', volume24h: '10', quoteVolume24h: '1000',
    fundingRate: '0', nextFundingAt: EPOCH, openInterest: '0', openInterestValue: '0',
    receivedAt: EPOCH, updatedAt: EPOCH, source: 'demo_seed',
    ...overrides,
  };
}

function emptyFunding(): FundingOverviewResponse {
  return { assets: [], venueStatus: [], fetchedAt: EPOCH, cacheStatus: 'fresh' as const };
}

interface FundingFixtureRow {
  asset: string;
  venue: string;
  symbol: string;
  rate8h: string;
}

function fundingOverview(rows: FundingFixtureRow[]): FundingOverviewResponse {
  const byAsset = new Map<string, FundingFixtureRow[]>();
  for (const row of rows) {
    const entries = byAsset.get(row.asset) ?? [];
    entries.push(row);
    byAsset.set(row.asset, entries);
  }
  return {
    assets: [...byAsset.entries()].map(([asset, entries]) => ({
      asset,
      venues: entries.map((entry) => ({
        venue: entry.venue, symbol: entry.symbol, quote: 'USDT',
        fundingRate: entry.rate8h, fundingIntervalHours: 8,
        fundingRate8h: entry.rate8h, nextFundingAt: EPOCH,
        openInterestValue: null, lastPrice: '100', change24h: null, fetchedAt: EPOCH,
      })),
    })),
    venueStatus: [],
    fetchedAt: EPOCH,
    cacheStatus: 'fresh' as const,
  };
}

class NoopHub {
  market(): LiveMarket | null { return null; }
  ensureMarkets(): boolean { return false; }
  snapshot(): MarketSnapshot {
    return { connectionState: 'healthy', updatedAt: EPOCH, markets: [] };
  }
}

interface CreateOptions {
  markets?: LiveMarket[];
  fundingRows?: FundingFixtureRow[];
  spotByAsset?: Record<string, Array<{ venue: string; symbol: string }>>;
}

function createService(options: CreateOptions = {}): OpportunityService {
  const spotByAsset = new Map(Object.entries(options.spotByAsset ?? {}));
  return new OpportunityService({
    fundingOverview: {
      ensureFresh: async () => undefined,
      buildResponse: () => (options.fundingRows ? fundingOverview(options.fundingRows) : emptyFunding()),
    },
    hub: new NoopHub(),
    spreadMarkets: async () => options.markets ?? [],
    spotSymbolsByAsset: () => spotByAsset,
  }, { now: () => Date.parse(EPOCH) });
}

const CATALOG = { assets: new Map<string, MarketCatalogVenue[]>() };

/** One spot leg and three perpetuals; every price is picked so the ranking is hand-checkable. */
const BTC_MARKETS: LiveMarket[] = [
  liveMarket({ symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '100', askPrice: '101' }),
  liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' }),
  liveMarket({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', asset: 'BTC', bidPrice: '100.8', askPrice: '100.9' }),
  liveMarket({ symbol: 'OKX_FUTURE_BTC_USDT', venue: 'OKX', asset: 'BTC', bidPrice: '100.4', askPrice: '100.5' }),
];

describe('spread board venue whitelist boundaries', () => {
  it('treats duplicate venue entries as one and ignores blank entries', async () => {
    const service = createService({ markets: BTC_MARKETS });
    const single = await service.list(CATALOG, { funding: false, spread: true, venues: ['GATE'], limit: 50 });
    const duplicated = await service.list(CATALOG, {
      funding: false, spread: true, venues: ['GATE', 'GATE', '', ' ', 'GATE'], limit: 50,
    });
    // A blank entry is not a venue: it must not widen the whitelist to "everything".
    expect(duplicated.spread).toEqual(single.spread);
    expect(duplicated.spread.length).toBeGreaterThan(0);
  });

  it('matches the whitelist against the uppercased row venue only (caller must uppercase)', async () => {
    const service = createService({ markets: BTC_MARKETS });
    // The HTTP layer uppercases before forwarding (app.ts), so the service contract is an exact
    // match on the uppercase venue id. A lowercase entry therefore matches nothing — documented
    // here so a future refactor that drops the HTTP-side uppercase is caught.
    const lowercase = await service.list(CATALOG, { funding: false, spread: true, venues: ['gate'], limit: 50 });
    expect(lowercase.spread).toEqual([]);
    const mixed = await service.list(CATALOG, { funding: false, spread: true, venues: ['gate', 'GATE'], limit: 50 });
    expect(mixed.spread).toEqual(
      (await service.list(CATALOG, { funding: false, spread: true, venues: ['GATE'], limit: 50 })).spread,
    );
  });

  it('empties the board for an unknown venue instead of silently ignoring the filter', async () => {
    const service = createService({ markets: BTC_MARKETS });
    const unknown = await service.list(CATALOG, {
      funding: false, spread: true, venues: ['NOT_A_VENUE'], limit: 50,
    });
    expect(unknown.spread).toEqual([]);
    // A known venue alongside the unknown one still yields that venue's own rows.
    const partial = await service.list(CATALOG, {
      funding: false, spread: true, venues: ['NOT_A_VENUE', 'GATE'], limit: 50,
    });
    expect(partial.spread.length).toBeGreaterThan(0);
    for (const row of partial.spread) {
      expect(row.leftVenue).toBe('GATE');
      expect(row.rightVenue).toBe('GATE');
    }
  });

  it('requires BOTH legs of a row to sit on a selected venue', async () => {
    const service = createService({ markets: BTC_MARKETS });
    const gateBinance = await service.list(CATALOG, {
      funding: false, spread: true, venues: ['GATE', 'BINANCE'], limit: 50,
    });
    expect(gateBinance.spread.length).toBeGreaterThan(0);
    for (const row of gateBinance.spread) {
      expect(['GATE', 'BINANCE']).toContain(row.leftVenue);
      expect(['GATE', 'BINANCE']).toContain(row.rightVenue);
    }
    // The GATE↔OKX perpetual pair (the unfiltered board's top row) must be gone.
    expect(gateBinance.spread.some((row) => row.leftVenue === 'OKX' || row.rightVenue === 'OKX')).toBe(false);
  });

  it('ANDs the venue whitelist with the pair-type whitelist', async () => {
    const service = createService({ markets: BTC_MARKETS });
    // The only spot leg lives on GATE, so a BINANCE-only spot board is necessarily empty.
    const binanceSpot = await service.list(CATALOG, {
      funding: false, spread: true, venues: ['BINANCE'], pairTypes: ['SPOT_PERP'], limit: 50,
    });
    expect(binanceSpot.spread).toEqual([]);

    const gateBinanceSpot = await service.list(CATALOG, {
      funding: false, spread: true, venues: ['GATE', 'BINANCE'], pairTypes: ['SPOT_PERP'], limit: 50,
    });
    expect(gateBinanceSpot.spread.length).toBeGreaterThan(0);
    for (const row of gateBinanceSpot.spread) {
      expect(row.pairType).toBe('SPOT_PERP');
      expect(['GATE', 'BINANCE']).toContain(row.leftVenue);
      expect(['GATE', 'BINANCE']).toContain(row.rightVenue);
    }
  });
});

describe('spread board market whitelist boundaries', () => {
  it('treats both pair types as "no restriction"', async () => {
    const service = createService({ markets: BTC_MARKETS });
    const both = await service.list(CATALOG, { funding: false, spread: true, pairTypes: ['SPOT_PERP', 'PERP_PERP'], limit: 50 });
    const none = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    const explicitEmpty = await service.list(CATALOG, { funding: false, spread: true, pairTypes: [], limit: 50 });
    expect(both.spread).toEqual(none.spread);
    expect(explicitEmpty.spread).toEqual(none.spread);
    expect(both.spread.some((row) => row.combinations.some((combination) => combination.pairType === 'SPOT_PERP'))).toBe(true);
    expect(both.spread.some((row) => row.combinations.some((combination) => combination.pairType === 'PERP_PERP'))).toBe(true);
  });

  it('keeps only the requested shape and never mixes the two', async () => {
    const service = createService({ markets: BTC_MARKETS });
    const spotOnly = await service.list(CATALOG, { funding: false, spread: true, pairTypes: ['SPOT_PERP'], limit: 50 });
    expect(spotOnly.spread.length).toBeGreaterThan(0);
    expect(spotOnly.spread.every((row) => row.pairType === 'SPOT_PERP')).toBe(true);
    for (const row of spotOnly.spread) {
      const legs = [row.leftSymbol, row.rightSymbol];
      expect(legs.some((symbol) => symbol.includes('_SPOT_'))).toBe(true);
    }

    const perpOnly = await service.list(CATALOG, { funding: false, spread: true, pairTypes: ['PERP_PERP'], limit: 50 });
    expect(perpOnly.spread.length).toBeGreaterThan(0);
    expect(perpOnly.spread.every((row) => row.pairType === 'PERP_PERP')).toBe(true);
    for (const row of perpOnly.spread) {
      expect(row.leftSymbol.includes('_SPOT_')).toBe(false);
      expect(row.rightSymbol.includes('_SPOT_')).toBe(false);
    }
  });
});

describe('filter ordering versus the row cap', () => {
  it('caps the FILTERED board, so the spot-only top row differs from the unfiltered top row', async () => {
    const service = createService({ markets: BTC_MARKETS });
    // Unfiltered top row: sell GATE perp at 101.5, buy OKX perp at 100.5 → ~99.5 bps (PERP_PERP).
    const unfiltered = await service.list(CATALOG, { funding: false, spread: true, limit: 1 });
    expect(unfiltered.spread).toHaveLength(1);
    expect(unfiltered.spread[0]?.pairType).toBe('PERP_PERP');
    expect(unfiltered.spread[0]?.spreadBps).toBeCloseTo(((101.5 - 100.5) / 100.5) * 10_000, 6);

    // With the spot switch alone the top row is the best SPOT_PERP pair: sell the GATE perp at
    // 101.5, buy GATE spot at 101 → ~49.5 bps. A cap applied before the filter would have
    // dropped this row and returned an empty board.
    const spotOnly = await service.list(CATALOG, { funding: false, spread: true, pairTypes: ['SPOT_PERP'], limit: 1 });
    expect(spotOnly.spread).toHaveLength(1);
    expect(spotOnly.spread[0]?.pairType).toBe('SPOT_PERP');
    expect(spotOnly.spread[0]?.spreadBps).toBeCloseTo(((101.5 - 101) / 101) * 10_000, 6);
    expect(spotOnly.spread[0]?.spreadBps).not.toBeCloseTo(unfiltered.spread[0]?.spreadBps ?? 0, 6);
  });

  it('caps the filtered board for the venue whitelist too', async () => {
    const service = createService({ markets: BTC_MARKETS });
    // Deselecting GATE (which owns the unfiltered top row) must still fill the cap.
    const withoutGate = await service.list(CATALOG, {
      funding: false, spread: true, venues: ['BINANCE', 'OKX'], limit: 1,
    });
    expect(withoutGate.spread).toHaveLength(1);
    expect(withoutGate.spread[0]).toMatchObject({ leftVenue: 'BINANCE', rightVenue: 'OKX', pairType: 'PERP_PERP' });
    expect(withoutGate.spread[0]?.spreadBps).toBeCloseTo(((100.8 - 100.5) / 100.5) * 10_000, 6);
  });

  it('combines venues, minBps, asset and limit into one ANDed request', async () => {
    const service = createService({
      markets: [
        ...BTC_MARKETS,
        liveMarket({ symbol: 'GATE_SPOT_ETH_USDT', venue: 'GATE', asset: 'ETH', bidPrice: '50', askPrice: '51' }),
        liveMarket({ symbol: 'OKX_FUTURE_ETH_USDT', venue: 'OKX', asset: 'ETH', bidPrice: '52', askPrice: '52.1' }),
      ],
    });
    // asset=ETH narrows the board to ETH rows only.
    const eth = await service.list(CATALOG, { funding: false, spread: true, asset: 'ETH', limit: 50 });
    expect(eth.spread.length).toBeGreaterThan(0);
    expect(eth.spread.every((row) => row.asset === 'ETH')).toBe(true);

    // asset=ETH AND venues=GATE drops the GATE↔OKX ETH pair (OKX deselected) → empty board.
    const ethGateOnly = await service.list(CATALOG, {
      funding: false, spread: true, asset: 'ETH', venues: ['GATE'], limit: 50,
    });
    expect(ethGateOnly.spread).toEqual([]);

    // asset=ETH AND minBps above every ETH spread → empty board (proves minBps is ANDed too).
    const ethHighBps = await service.list(CATALOG, {
      funding: false, spread: true, asset: 'ETH', minBps: 10_000, limit: 50,
    });
    expect(ethHighBps.spread).toEqual([]);

    // venues + minBps together: the GATE↔OKX BTC perp pair (~99.5 bps) survives a 90 bps floor
    // but a BINANCE/OKX-only board (best ~29.9 bps) does not.
    const floorWithGate = await service.list(CATALOG, {
      funding: false, spread: true, asset: 'BTC', minBps: 90, limit: 50,
    });
    expect(floorWithGate.spread.length).toBeGreaterThan(0);
    const floorWithoutGate = await service.list(CATALOG, {
      funding: false, spread: true, asset: 'BTC', venues: ['BINANCE', 'OKX'], minBps: 90, limit: 50,
    });
    expect(floorWithoutGate.spread).toEqual([]);
  });
});

describe('spread whitelists never touch the funding board', () => {
  it('returns the identical funding board with and without the spread whitelists', async () => {
    const fundingRows: FundingFixtureRow[] = [
      { asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.00013' },
      { asset: 'BTC', venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT', rate8h: '0.0001' },
      { asset: 'ETH', venue: 'BINANCE', symbol: 'BINANCE_FUTURE_ETH_USDT', rate8h: '0.0002' },
    ];
    const base = await createService({
      markets: BTC_MARKETS,
      fundingRows,
      spotByAsset: { BTC: [{ venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' }] },
    }).list(CATALOG, { funding: true, spread: true, limit: 50 });

    const filtered = await createService({
      markets: BTC_MARKETS,
      fundingRows,
      spotByAsset: { BTC: [{ venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' }] },
    }).list(CATALOG, {
      funding: true, spread: true, venues: ['NOT_A_VENUE'], pairTypes: ['PERP_PERP'], limit: 50,
    });

    expect(base.funding.length).toBeGreaterThan(0);
    expect(filtered.funding).toEqual(base.funding);
    // The same request did empty the spread board, so the whitelists were really applied.
    expect(filtered.spread).toEqual([]);
    expect(base.spread.length).toBeGreaterThan(0);
  });

  it('leaves the funding board untouched when only the funding board is requested', async () => {
    const fundingRows: FundingFixtureRow[] = [
      { asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.00013' },
    ];
    const service = createService({
      fundingRows,
      spotByAsset: { BTC: [{ venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' }] },
    });
    const plain = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });
    const withVenues = await service.list(CATALOG, {
      funding: true, spread: false, venues: ['NOT_A_VENUE'], limit: 50,
    });
    expect(withVenues.funding).toEqual(plain.funding);
    expect(withVenues.spread).toEqual([]);
  });
});
