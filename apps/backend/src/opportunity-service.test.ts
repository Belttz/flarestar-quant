import { describe, expect, it } from 'vitest';
import type { FundingOverviewResponse, MarketCatalogVenue, SpreadOpportunity } from '@gate-crossex/shared-types';
import type { LiveMarket, MarketDefinition, MarketSnapshot } from './market-hub.js';
import { OpportunityService, legsPricedComparably, spreadQuoteAlignment } from './opportunity-service.js';

const EPOCH = '2026-08-01T00:00:00.000Z';

function liveMarket(overrides: Partial<LiveMarket> & Pick<LiveMarket, 'symbol' | 'venue' | 'asset'>): LiveMarket {
  return {
    lastPrice: '100', bidPrice: '99', bidSize: '1', askPrice: '101', askSize: '1',
    open24h: '100', high24h: '110', low24h: '90', volume24h: '10', quoteVolume24h: '1000',
    fundingRate: '0', nextFundingAt: EPOCH, openInterest: '0', openInterestValue: '0',
    receivedAt: EPOCH, updatedAt: EPOCH, quoteUpdatedAt: EPOCH, source: 'demo_seed',
    ...overrides,
  };
}

class FakeHub {
  readonly ensured: MarketDefinition[] = [];
  failEnsure = false;
  private readonly markets: Map<string, LiveMarket>;

  constructor(markets: LiveMarket[]) {
    this.markets = new Map(markets.map((market) => [market.symbol, market]));
  }

  snapshot(): MarketSnapshot {
    return { connectionState: 'healthy', updatedAt: EPOCH, markets: [...this.markets.values()] };
  }

  market(symbol: string): LiveMarket | null {
    return this.markets.get(symbol) ?? null;
  }

  ensureMarkets(definitions: MarketDefinition[]): boolean {
    if (this.failEnsure) return false;
    for (const definition of definitions) {
      if (this.markets.has(definition.symbol)) continue;
      this.markets.set(definition.symbol, liveMarket({
        symbol: definition.symbol, venue: definition.venue, asset: definition.asset,
        bidPrice: '0', askPrice: '0', lastPrice: '0',
      }));
      this.ensured.push(definition);
    }
    return true;
  }
}

interface FundingRowFixture {
  asset: string;
  venue: string;
  symbol: string;
  rate8h: string | null;
}

function overviewResponse(rows: FundingRowFixture[]): FundingOverviewResponse {
  const byAsset = new Map<string, FundingRowFixture[]>();
  for (const row of rows) {
    const entries = byAsset.get(row.asset) ?? [];
    entries.push(row);
    byAsset.set(row.asset, entries);
  }
  return {
    assets: [...byAsset.entries()].map(([asset, entries]) => ({
      asset,
      venues: entries.map((entry) => ({
        venue: entry.venue,
        symbol: entry.symbol,
        quote: 'USDT',
        fundingRate: entry.rate8h,
        fundingIntervalHours: entry.rate8h === null ? null : 8,
        fundingRate8h: entry.rate8h,
        nextFundingAt: entry.rate8h === null ? null : EPOCH,
        openInterestValue: null,
        lastPrice: entry.rate8h === null ? null : '100',
        change24h: null,
        fetchedAt: entry.rate8h === null ? null : EPOCH,
      })),
    })),
    venueStatus: [],
    fetchedAt: EPOCH,
    cacheStatus: 'fresh' as const,
  };
}

interface ServiceFixture {
  service: OpportunityService;
  hub: FakeHub;
  ensureFreshCalls: () => number;
  /** Librarian clock: nothing advances it on its own, so `fetchedAt` stays pinned to `EPOCH`. */
  advance: (milliseconds: number) => void;
  spreadMarketCalls: () => number;
}

interface CreateServiceOptions {
  rows: FundingRowFixture[];
  markets?: LiveMarket[];
  /** Markets served by the merged spread view but absent from the hub (e.g. REST-only rows). */
  spreadMarkets?: LiveMarket[];
  spotByAsset?: Record<string, Array<{ venue: string; symbol: string }>>;
  spotRegistrationBudget?: number;
  failEnsure?: boolean;
  /** Board cache overrides; the production default is a 30s TTL. */
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  /** R4 leg-to-leg quote-skew budget (ms); the production default is 2000. */
  spreadQuoteMaxSkewMs?: number;
}

function createService(options: CreateServiceOptions): ServiceFixture {
  const hub = new FakeHub(options.markets ?? []);
  hub.failEnsure = options.failEnsure ?? false;
  let ensureFreshCalls = 0;
  let spreadCalls = 0;
  let nowMs = Date.parse(EPOCH);
  const spotByAsset = new Map(Object.entries(options.spotByAsset ?? {}));
  // Default merged view mirrors the production hub-first overlay using the same hub.
  const spreadMarkets = async (): Promise<ReadonlyArray<LiveMarket>> => {
    spreadCalls += 1;
    return options.spreadMarkets ?? hub.snapshot().markets;
  };
  const service = new OpportunityService({
    fundingOverview: {
      ensureFresh: async () => { ensureFreshCalls += 1; },
      buildResponse: () => overviewResponse(options.rows),
    },
    hub,
    spreadMarkets,
    spotSymbolsByAsset: () => spotByAsset,
  }, {
    now: () => nowMs,
    ...(options.spotRegistrationBudget !== undefined ? { spotRegistrationBudget: options.spotRegistrationBudget } : {}),
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.cacheMaxEntries !== undefined ? { cacheMaxEntries: options.cacheMaxEntries } : {}),
    ...(options.spreadQuoteMaxSkewMs !== undefined ? { spreadQuoteMaxSkewMs: options.spreadQuoteMaxSkewMs } : {}),
  });
  return {
    service,
    hub,
    ensureFreshCalls: () => ensureFreshCalls,
    spreadMarketCalls: () => spreadCalls,
    advance: (milliseconds: number) => { nowMs += milliseconds; },
  };
}

const CATALOG = { assets: new Map<string, MarketCatalogVenue[]>() };

describe('opportunity service', () => {
  it('annualizes the 8h rate, ranks by |APR| descending, and advises the carry direction', async () => {
    const { service } = createService({
      rows: [
        { asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.0002' },
        { asset: 'BTC', venue: 'BINANCE', symbol: 'BINANCE_FUTURE_BTC_USDT', rate8h: '-0.0001' },
        { asset: 'BTC', venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT', rate8h: null },
        { asset: 'ETH', venue: 'BINANCE', symbol: 'BINANCE_FUTURE_ETH_USDT', rate8h: '0.00005' },
      ],
      spotByAsset: { BTC: [{ venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' }], ETH: [] },
    });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });

    // |0.0004 8h| × 3 × 365 × 100 = 43.8 for a fabricated high-rate row is avoided: null rows
    // are dropped, and the ordering is strictly |APR| descending across assets.
    expect(funding.map((row) => row.fundingApr)).toEqual([
      Math.abs(0.0002) * 3 * 365 * 100,
      Math.abs(-0.0001) * 3 * 365 * 100,
      Math.abs(0.00005) * 3 * 365 * 100,
    ]);
    expect(funding[0]).toMatchObject({
      asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT',
      direction: 'POSITIVE', fundingRate8h: '0.0002',
    });
    expect(funding[1]).toMatchObject({ venue: 'BINANCE', direction: 'NEGATIVE', fundingRate8h: '-0.0001' });
    expect(funding.every((row) => row.venue !== 'OKX')).toBe(true);
  });

  it('awaits the funding sweep only when the funding board is requested', async () => {
    const { service, ensureFreshCalls } = createService({
      rows: [{ asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.0001' }],
      spotByAsset: {},
    });
    await service.list(CATALOG, { funding: true, spread: false, limit: 50 });
    expect(ensureFreshCalls()).toBe(1);
    await service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    expect(ensureFreshCalls()).toBe(1);
  });

  it('resolves the GATE spot leg: registered candidates win, others register within budget', async () => {
    const { service, hub } = createService({
      rows: [
        { asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.0002' },
        { asset: 'ETH', venue: 'GATE', symbol: 'GATE_FUTURE_ETH_USDT', rate8h: '0.0001' },
      ],
      markets: [liveMarket({ symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC' })],
      spotByAsset: {
        BTC: [{ venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' }],
        ETH: [{ venue: 'GATE', symbol: 'GATE_SPOT_ETH_USDT' }, { venue: 'GATE', symbol: 'GATE_SPOT_ETH_USDC' }],
      },
    });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });

    expect(funding[0]).toMatchObject({ asset: 'BTC', spotSymbol: 'GATE_SPOT_BTC_USDT', executable: true });
    // BTC's spot leg was already registered; only ETH's USDT candidate is newly ensured.
    expect(funding[1]).toMatchObject({ asset: 'ETH', spotSymbol: 'GATE_SPOT_ETH_USDT', executable: true });
    expect(hub.ensured).toEqual([{ symbol: 'GATE_SPOT_ETH_USDT', venue: 'GATE', asset: 'ETH' }]);
  });

  it('lists every connected spot venue and registers the first venue-ordered candidate', async () => {
    const { service, hub } = createService({
      rows: [{ asset: 'BTC', venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT', rate8h: '0.0002' }],
      spotByAsset: {
        BTC: [
          { venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' },
          { venue: 'BINANCE', symbol: 'BINANCE_SPOT_BTC_USDT' },
          { venue: 'OKX', symbol: 'OKX_SPOT_BTC_USDT' },
        ],
      },
    });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });

    expect(funding[0]).toMatchObject({
      asset: 'BTC', spotSymbol: 'GATE_SPOT_BTC_USDT', executable: true,
      spotVenues: ['GATE', 'BINANCE', 'OKX'],
    });
    // The registration rides the candidate's own venue, not a hard-coded GATE.
    expect(hub.ensured).toEqual([{ symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC' }]);

    // Without a GATE listing the first venue-ordered candidate wins and still registers.
    const { service: binanceService, hub: binanceHub } = createService({
      rows: [{ asset: 'BTC', venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT', rate8h: '0.0002' }],
      spotByAsset: {
        BTC: [{ venue: 'BINANCE', symbol: 'BINANCE_SPOT_BTC_USDT' }],
      },
    });
    const binance = await binanceService.list(CATALOG, { funding: true, spread: false, limit: 50 });
    expect(binance.funding[0]).toMatchObject({
      spotSymbol: 'BINANCE_SPOT_BTC_USDT', spotVenues: ['BINANCE'], executable: true,
    });
    expect(binanceHub.ensured).toEqual([{ symbol: 'BINANCE_SPOT_BTC_USDT', venue: 'BINANCE', asset: 'BTC' }]);
  });

  it('collapses to one row per (asset, perpetual venue) with the preferred spot venue', async () => {
    const { service } = createService({
      rows: [{ asset: 'BTC', venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT', rate8h: '0.0002' }],
      spotByAsset: {
        BTC: [
          { venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' },
          { venue: 'BINANCE', symbol: 'BINANCE_SPOT_BTC_USDT' },
          { venue: 'BINANCE', symbol: 'BINANCE_SPOT_BTC_USDC' },
        ],
      },
    });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });
    expect(funding).toHaveLength(1);
    // The collapsed row keeps the venue-ordered preferred candidate: Gate first, USDT quote first.
    expect(funding[0]).toMatchObject({
      venue: 'OKX', spotVenue: 'GATE', spotSymbol: 'GATE_SPOT_BTC_USDT',
      spotVenues: ['GATE', 'BINANCE'], executable: true,
    });
  });

  it('expand=1 emits one row per (asset, spot venue, perpetual venue) combination', async () => {
    const { service, hub } = createService({
      rows: [{ asset: 'BTC', venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT', rate8h: '0.0002' }],
      spotByAsset: {
        BTC: [
          { venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' },
          { venue: 'BINANCE', symbol: 'BINANCE_SPOT_BTC_USDT' },
          { venue: 'BINANCE', symbol: 'BINANCE_SPOT_BTC_USDC' },
        ],
      },
    });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, expand: true, limit: 50 });
    // One row per spot venue — the USDC duplicate collapses into BINANCE's preferred quote —
    // sorted by the venue tiebreak (BINANCE < GATE). Each combination registers its own venue's
    // spot leg, in venue-ordered combination order (GATE first).
    expect(funding.map((row) => [row.spotVenue, row.spotSymbol])).toEqual([
      ['BINANCE', 'BINANCE_SPOT_BTC_USDT'],
      ['GATE', 'GATE_SPOT_BTC_USDT'],
    ]);
    expect(funding.every((row) => row.venue === 'OKX')).toBe(true);
    expect(hub.ensured).toEqual([
      { symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC' },
      { symbol: 'BINANCE_SPOT_BTC_USDT', venue: 'BINANCE', asset: 'BTC' },
    ]);
  });

  it('expand=1 with no connected spot leg yields the single null-venue row', async () => {
    const { service } = createService({
      rows: [{ asset: 'BTC', venue: 'OKX', symbol: 'OKX_FUTURE_BTC_USDT', rate8h: '0.0002' }],
      spotByAsset: {},
    });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, expand: true, limit: 50 });
    expect(funding).toHaveLength(1);
    expect(funding[0]).toMatchObject({ spotVenue: null, spotSymbol: null, executable: false });
  });

  it('marks rows beyond the registration budget or without a spot listing as not executable', async () => {
    const { service, hub } = createService({
      rows: [
        { asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.0002' },
        { asset: 'ZETA', venue: 'GATE', symbol: 'GATE_FUTURE_ZETA_USDT', rate8h: '0.0004' },
        { asset: 'ETH', venue: 'GATE', symbol: 'GATE_FUTURE_ETH_USDT', rate8h: '0.0001' },
      ],
      spotByAsset: {
        BTC: [{ venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' }],
        ZETA: [{ venue: 'GATE', symbol: 'GATE_SPOT_ZETA_USDT' }],
      },
      spotRegistrationBudget: 1,
    });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });

    expect(funding[0]).toMatchObject({ asset: 'ZETA', spotSymbol: 'GATE_SPOT_ZETA_USDT', executable: true });
    expect(funding[1]).toMatchObject({ asset: 'BTC', spotSymbol: null, executable: false });
    expect(funding[2]).toMatchObject({ asset: 'ETH', spotSymbol: null, executable: false });
    expect(hub.ensured).toHaveLength(1);
  });

  it('ranks executable rows ahead of not-executable ones before truncating the limit', async () => {
    const { service } = createService({
      rows: [
        // Highest APR but no connected spot leg: actionable rows must rank ahead of it.
        { asset: 'AAA', venue: 'GATE', symbol: 'GATE_FUTURE_AAA_USDT', rate8h: '0.0005' },
        { asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.0002' },
      ],
      markets: [liveMarket({ symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC' })],
      spotByAsset: { BTC: [{ venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' }], AAA: [] },
    });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 1 });
    expect(funding).toHaveLength(1);
    expect(funding[0]).toMatchObject({ asset: 'BTC', executable: true });

    const untruncated = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });
    expect(untruncated.funding.map((row) => [row.asset, row.executable]))
      .toEqual([['BTC', true], ['AAA', false]]);
  });

  it('degrades to not-executable when the hub cannot register the spot leg', async () => {
    const { service, hub } = createService({
      rows: [{ asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.0002' }],
      spotByAsset: { BTC: [{ venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' }] },
      failEnsure: true,
    });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });
    expect(funding[0]).toMatchObject({ spotSymbol: null, executable: false });
    expect(hub.ensured).toHaveLength(0);
  });

  it('applies minApr, asset, and limit filters to the funding board', async () => {
    const { service } = createService({
      rows: [
        { asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.0002' },
        { asset: 'ETH', venue: 'GATE', symbol: 'GATE_FUTURE_ETH_USDT', rate8h: '0.00001' },
      ],
      spotByAsset: {},
    });
    const filtered = await service.list(CATALOG, { funding: true, spread: false, minApr: 10, limit: 50 });
    expect(filtered.funding.map((row) => row.asset)).toEqual(['BTC']);

    const byAsset = await service.list(CATALOG, { funding: true, spread: false, asset: 'ETH', limit: 50 });
    expect(byAsset.funding.map((row) => row.asset)).toEqual(['ETH']);

    const limited = await service.list(CATALOG, { funding: true, spread: false, limit: 1 });
    expect(limited.funding).toHaveLength(1);
    expect(limited.funding[0]?.asset).toBe('BTC');
  });

  it('pairs same-asset same-quote markets, sells the high leg, and sorts by spread descending', async () => {
    const { service } = createService({
      rows: [],
      markets: [
        liveMarket({ symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '100', askPrice: '101' }),
        liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' }),
        liveMarket({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', asset: 'BTC', bidPrice: '100.8', askPrice: '100.9' }),
        // Cross-quote (USDC) and pending (zero-quote) markets must never join the USDT pairs.
        liveMarket({ symbol: 'OKX_FUTURE_BTC_USDC', venue: 'OKX', asset: 'BTC', bidPrice: '120', askPrice: '121' }),
        liveMarket({ symbol: 'BYBIT_FUTURE_BTC_USDT', venue: 'BYBIT', asset: 'BTC', bidPrice: '0', askPrice: '0' }),
      ],
      spotByAsset: {},
    });
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });

    // The board lists one row per asset; every (sell venue, buy venue) pair rides in `combinations`
    // and the parent mirrors the best-spread combination.
    expect(spread).toHaveLength(1);
    expect(spread[0]).toMatchObject({
      pairType: 'PERP_PERP',
      asset: 'BTC',
      leftSymbol: 'GATE_FUTURE_BTC_USDT',
      rightSymbol: 'BINANCE_FUTURE_BTC_USDT',
      leftVenue: 'GATE',
      rightVenue: 'BINANCE',
      sellBid: '101.5',
      buyAsk: '100.9',
      executable: true,
    });
    expect(spread[0]!.spreadBps).toBeCloseTo(((101.5 - 100.9) / 100.9) * 10_000, 6);
    // SPOT_PERP: sell GATE future at 101.5, buy spot at 101 → ~49.5 bps; PERP_PERP best goes first.
    const combinations = spread[0]!.combinations;
    expect(combinations).toHaveLength(3);
    expect(combinations[0]).toMatchObject({
      pairType: 'PERP_PERP',
      leftSymbol: 'GATE_FUTURE_BTC_USDT',
      rightSymbol: 'BINANCE_FUTURE_BTC_USDT',
    });
    expect(combinations[0]!.spreadBps).toBeCloseTo(((101.5 - 100.9) / 100.9) * 10_000, 6);
    expect(combinations[1]).toMatchObject({
      pairType: 'SPOT_PERP',
      leftSymbol: 'GATE_FUTURE_BTC_USDT',
      rightSymbol: 'GATE_SPOT_BTC_USDT',
    });
    expect(combinations[1]!.spreadBps).toBeCloseTo(((101.5 - 101) / 101) * 10_000, 6);
    // Strict descending order inside the detail list.
    for (let i = 1; i < combinations.length; i += 1) {
      expect(combinations[i - 1]!.spreadBps).toBeGreaterThanOrEqual(combinations[i]!.spreadBps);
    }
    // No cross-quote pairs, no same-symbol pairs, no pending legs. USDT and USD are one
    // settlement family (see `quoteFamily`); USDC is not.
    for (const combination of combinations) {
      const family = (symbol: string): string => symbol.slice(symbol.lastIndexOf('_') + 1).replace(/^USD$/, 'USDT');
      expect(family(combination.leftSymbol)).toBe(family(combination.rightSymbol));
      expect(combination.leftSymbol).not.toBe(combination.rightSymbol);
      expect(Number(combination.sellBid)).toBeGreaterThan(0);
      expect(Number(combination.buyAsk)).toBeGreaterThan(0);
    }
    expect(combinations.every((combination) => !combination.leftSymbol.includes('OKX_FUTURE_BTC_USDC') && !combination.rightSymbol.includes('OKX_FUTURE_BTC_USDC'))).toBe(true);
    expect(combinations.every((combination) => combination.pairType !== 'SPOT_PERP'
      || combination.leftSymbol.startsWith('GATE_SPOT_') || combination.rightSymbol.startsWith('GATE_SPOT_'))).toBe(true);
  });

  it('applies minBps and limit filters to the spread board', async () => {
    const { service } = createService({
      rows: [],
      markets: [
        liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' }),
        liveMarket({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', asset: 'BTC', bidPrice: '100.8', askPrice: '100.9' }),
        liveMarket({ symbol: 'OKX_FUTURE_BTC_USDT', venue: 'OKX', asset: 'BTC', bidPrice: '100.4', askPrice: '100.5' }),
      ],
      spotByAsset: {},
    });
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, minBps: 50, limit: 50 });
    expect(spread.length).toBeGreaterThan(0);
    expect(spread.every((row) => row.spreadBps >= 50)).toBe(true);

    const limited = await service.list(CATALOG, { funding: false, spread: true, limit: 1 });
    expect(limited.spread).toHaveLength(1);
    const rows: SpreadOpportunity[] = limited.spread;
    // Top row: sell GATE at 101.5, buy OKX at 100.5 → ~99.5 bps.
    expect(rows[0]?.spreadBps).toBeCloseTo(((101.5 - 100.5) / 100.5) * 10_000, 6);
  });

  it('keeps only spread rows whose both legs sit on a selected venue', async () => {
    const { service } = createService({
      rows: [],
      markets: [
        liveMarket({ symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '100', askPrice: '101' }),
        liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' }),
        liveMarket({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', asset: 'BTC', bidPrice: '100.8', askPrice: '100.9' }),
        liveMarket({ symbol: 'OKX_FUTURE_BTC_USDT', venue: 'OKX', asset: 'BTC', bidPrice: '100.4', askPrice: '100.5' }),
      ],
      spotByAsset: {},
    });
    const unfiltered = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    // One collapsed BTC row carrying all three pairs (2 spot⇄perp + 1 perp⇄perp).
    expect(unfiltered.spread).toHaveLength(1);
    expect(unfiltered.spread[0]!.combinations.length).toBeGreaterThan(1);

    const twoVenues = await service.list(CATALOG, { funding: false, spread: true, venues: ['GATE', 'BINANCE'], limit: 50 });
    expect(twoVenues.spread.length).toBeGreaterThan(0);
    for (const row of twoVenues.spread) {
      expect(['GATE', 'BINANCE']).toContain(row.leftVenue);
      expect(['GATE', 'BINANCE']).toContain(row.rightVenue);
      for (const combination of row.combinations) {
        expect(['GATE', 'BINANCE']).toContain(combination.leftVenue);
        expect(['GATE', 'BINANCE']).toContain(combination.rightVenue);
      }
    }
    expect(twoVenues.spread.every((row) => row.combinations.every((combination) => !combination.leftSymbol.includes('OKX') && !combination.rightSymbol.includes('OKX')))).toBe(true);

    // GATE alone lists one spot and one perpetual, so only the spot ⇄ perpetual pair survives.
    const gateOnly = await service.list(CATALOG, { funding: false, spread: true, venues: ['GATE'], limit: 50 });
    expect(gateOnly.spread).toHaveLength(1);
    expect(gateOnly.spread[0]!.combinations).toHaveLength(1);
    expect(gateOnly.spread[0]).toMatchObject({
      pairType: 'SPOT_PERP', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'GATE_SPOT_BTC_USDT',
    });

    // An empty whitelist means "every venue", never "no venue".
    const emptyVenues = await service.list(CATALOG, { funding: false, spread: true, venues: [], limit: 50 });
    expect(emptyVenues.spread).toEqual(unfiltered.spread);
  });

  it('restricts the spread board to the requested pair types', async () => {
    const { service } = createService({
      rows: [],
      markets: [
        liveMarket({ symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '100', askPrice: '101' }),
        liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' }),
        liveMarket({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', asset: 'BTC', bidPrice: '100.8', askPrice: '100.9' }),
      ],
      spotByAsset: {},
    });
    const spotOnly = await service.list(CATALOG, { funding: false, spread: true, pairTypes: ['SPOT_PERP'], limit: 50 });
    expect(spotOnly.spread.length).toBeGreaterThan(0);
    expect(spotOnly.spread.every((row) => row.combinations.every((combination) => combination.pairType === 'SPOT_PERP'))).toBe(true);

    const perpOnly = await service.list(CATALOG, { funding: false, spread: true, pairTypes: ['PERP_PERP'], limit: 50 });
    expect(perpOnly.spread.length).toBeGreaterThan(0);
    expect(perpOnly.spread.every((row) => row.combinations.every((combination) => combination.pairType === 'PERP_PERP'))).toBe(true);

    const both = await service.list(CATALOG, { funding: false, spread: true, pairTypes: ['SPOT_PERP', 'PERP_PERP'], limit: 50 });
    expect(both.spread.some((row) => row.combinations.some((combination) => combination.pairType === 'SPOT_PERP'))).toBe(true);
    expect(both.spread.some((row) => row.combinations.some((combination) => combination.pairType === 'PERP_PERP'))).toBe(true);

    const emptyTypes = await service.list(CATALOG, { funding: false, spread: true, pairTypes: [], limit: 50 });
    expect(emptyTypes.spread).toEqual(both.spread);
  });

  it('applies the venue and pair-type filters before the row cap', async () => {
    const { service } = createService({
      rows: [],
      markets: [
        liveMarket({ symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '100', askPrice: '101' }),
        liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' }),
        liveMarket({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', asset: 'BTC', bidPrice: '100.8', askPrice: '100.9' }),
        liveMarket({ symbol: 'OKX_FUTURE_BTC_USDT', venue: 'OKX', asset: 'BTC', bidPrice: '100.4', askPrice: '100.5' }),
      ],
      spotByAsset: {},
    });
    // Unfiltered top row: sell GATE at 101.5, buy OKX at 100.5 → ~99.5 bps.
    const unfiltered = await service.list(CATALOG, { funding: false, spread: true, limit: 1 });
    expect(unfiltered.spread).toHaveLength(1);
    expect(unfiltered.spread[0]?.spreadBps).toBeCloseTo(((101.5 - 100.5) / 100.5) * 10_000, 6);

    // Deselecting GATE must not shrink the capped board to zero: the cap serves the filtered set.
    const withoutGate = await service.list(CATALOG, { funding: false, spread: true, venues: ['BINANCE', 'OKX'], limit: 1 });
    expect(withoutGate.spread).toHaveLength(1);
    expect(withoutGate.spread[0]).toMatchObject({ leftVenue: 'BINANCE', rightVenue: 'OKX', pairType: 'PERP_PERP' });
    expect(withoutGate.spread[0]?.spreadBps).toBeCloseTo(((100.8 - 100.5) / 100.5) * 10_000, 6);

    const perpOnly = await service.list(CATALOG, { funding: false, spread: true, pairTypes: ['PERP_PERP'], limit: 1 });
    expect(perpOnly.spread).toHaveLength(1);
    expect(perpOnly.spread[0]?.pairType).toBe('PERP_PERP');
  });

  it('returns empty boards and the cache status when neither board is requested', async () => {
    const { service } = createService({
      rows: [{ asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.0001' }],
      markets: [liveMarket({ symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC' })],
      spotByAsset: { BTC: [{ venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' }] },
    });
    const response = await service.list(CATALOG, { funding: false, spread: false, limit: 50 });
    expect(response.funding).toEqual([]);
    expect(response.spread).toEqual([]);
    expect(response.fetchedAt).toBe(EPOCH);
    expect(response.cacheStatus).toBe('fresh');
  });

  it('returns empty boards for a zero row cap instead of an unbounded list', async () => {
    const { service } = createService({
      rows: [{ asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.0001' }],
      markets: [
        liveMarket({ symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '100', askPrice: '101' }),
        liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101', askPrice: '102' }),
      ],
      spotByAsset: { BTC: [{ venue: 'GATE', symbol: 'GATE_SPOT_BTC_USDT' }] },
    });
    const response = await service.list(CATALOG, { funding: true, spread: true, limit: 0 });
    expect(response.funding).toEqual([]);
    expect(response.spread).toEqual([]);
    expect(response.fetchedAt).toBe(EPOCH);
  });

  it('drops funding rows whose 8h rate text is not a usable number', async () => {
    const { service } = createService({
      rows: [
        { asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: 'not-a-number' },
        { asset: 'ETH', venue: 'GATE', symbol: 'GATE_FUTURE_ETH_USDT', rate8h: '0.0001' },
      ],
      spotByAsset: {},
    });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });
    expect(funding.map((row) => row.asset)).toEqual(['ETH']);
  });

  it('lists a pair through its valid orientation when one leg only has a usable ask', async () => {
    const { service } = createService({
      rows: [],
      markets: [
        // Pending spot registration: bid is still '0' (no sellable side), ask is live.
        liveMarket({ symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '0', askPrice: '101' }),
        liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '100', askPrice: '100.5' }),
      ],
      spotByAsset: {},
    });
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });

    // Only "sell future at 100 / buy spot at 101" is evaluable (~ −99 bps), and the legs follow
    // that orientation: left = the market with the usable bid, right = the usable ask.
    expect(spread).toHaveLength(1);
    expect(spread[0]).toMatchObject({
      pairType: 'SPOT_PERP',
      leftSymbol: 'GATE_FUTURE_BTC_USDT',
      rightSymbol: 'GATE_SPOT_BTC_USDT',
      sellBid: '100',
      buyAsk: '101',
      executable: true,
    });
    expect(spread[0]!.spreadBps).toBeCloseTo(((100 - 101) / 101) * 10_000, 6);
  });

  it('lists spread pairs from the REST view even when the hub never registered them', async () => {
    const { service, hub } = createService({
      rows: [],
      // Empty hub: nothing was subscribed, so the old hub-scan would have returned no rows.
      markets: [],
      // The merged view supplies REST-swept quotes for symbols nobody is watching.
      spreadMarkets: [
        liveMarket({ symbol: 'GATE_FUTURE_SIREN_USDT', venue: 'GATE', asset: 'SIREN', bidPrice: '0.120', askPrice: '0.121' }),
        liveMarket({ symbol: 'BYBIT_FUTURE_SIREN_USDT', venue: 'BYBIT', asset: 'SIREN', bidPrice: '0.125', askPrice: '0.126' }),
      ],
      spotByAsset: {},
    });
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });

    expect(spread).toHaveLength(1);
    expect(spread[0]).toMatchObject({
      pairType: 'PERP_PERP',
      asset: 'SIREN',
      leftSymbol: 'BYBIT_FUTURE_SIREN_USDT',
      rightSymbol: 'GATE_FUTURE_SIREN_USDT',
      leftVenue: 'BYBIT',
      rightVenue: 'GATE',
      sellBid: '0.125',
      buyAsk: '0.121',
      executable: true,
    });
    expect(spread[0]!.spreadBps).toBeCloseTo(((0.125 - 0.121) / 0.121) * 10_000, 6);
    // The board scan must not touch the hub's registration surface: no market was ensured.
    expect(hub.ensured).toHaveLength(0);
  });
});

/** One catalog entry per asset; `hasSpot` decides whether the asset can derive CONTRACT. */
function catalog(assets: Record<string, boolean>): { assets: Map<string, MarketCatalogVenue[]> } {
  const map = new Map<string, MarketCatalogVenue[]>();
  for (const [asset, hasSpot] of Object.entries(assets)) {
    const venues: MarketCatalogVenue[] = [
      { venue: 'GATE', symbol: `GATE_FUTURE_${asset}_USDT`, quote: 'USDT', business: 'FUTURE' },
    ];
    if (hasSpot) venues.push({ venue: 'GATE', symbol: `GATE_SPOT_${asset}_USDT`, quote: 'USDT', business: 'SPOT' });
    map.set(asset, venues);
  }
  return { assets: map };
}

/** AAPL = tokenised stock, OPENAI = pre-IPO, SIREN = plain token; volumes differ per asset. */
const CLASSIFICATION_ROWS: FundingRowFixture[] = [
  { asset: 'AAPL', venue: 'GATE', symbol: 'GATE_FUTURE_AAPL_USDT', rate8h: '0.0001' },
  { asset: 'OPENAI', venue: 'GATE', symbol: 'GATE_FUTURE_OPENAI_USDT', rate8h: '0.0002' },
  { asset: 'SIREN', venue: 'GATE', symbol: 'GATE_FUTURE_SIREN_USDT', rate8h: '0.0003' },
];

const CLASSIFICATION_MARKETS: LiveMarket[] = [
  liveMarket({
    symbol: 'GATE_FUTURE_AAPL_USDT', venue: 'GATE', asset: 'AAPL',
    volume24h: '1000', quoteVolume24h: '200000', openInterest: '500', openInterestValue: '100000',
  }),
  liveMarket({
    symbol: 'GATE_FUTURE_OPENAI_USDT', venue: 'GATE', asset: 'OPENAI',
    volume24h: '10', quoteVolume24h: '5000', openInterest: '2', openInterestValue: '9000',
  }),
  // SIREN publishes nothing usable: every placeholder zero must read back as null.
  liveMarket({
    symbol: 'GATE_FUTURE_SIREN_USDT', venue: 'GATE', asset: 'SIREN',
    volume24h: '0', quoteVolume24h: '0', openInterest: '0', openInterestValue: '0',
  }),
];

describe('opportunity board asset classification', () => {
  it('carries the derived class on every funding row', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });

    expect(funding.find((row) => row.asset === 'AAPL')).toMatchObject({
      assetClass: 'STOCK', assetSuperClass: 'RWA', isPreIpo: false, variantSuffix: null,
    });
    expect(funding.find((row) => row.asset === 'OPENAI')).toMatchObject({
      assetClass: 'PRE_IPO', assetSuperClass: 'RWA', isPreIpo: true,
    });
    expect(funding.find((row) => row.asset === 'SIREN')).toMatchObject({
      assetClass: 'TOKEN', assetSuperClass: 'CRYPTO', isPreIpo: false,
    });
  });

  it('merges variant assets onto their base class', async () => {
    const { service } = createService({
      rows: [{ asset: 'AAPLX', venue: 'GATE', symbol: 'GATE_FUTURE_AAPLX_USDT', rate8h: '0.0001' }],
    });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });

    expect(funding[0]).toMatchObject({ asset: 'AAPLX', assetClass: 'STOCK', assetSuperClass: 'RWA', variantSuffix: 'X' });
  });

  it('derives CONTRACT for perpetual-only assets and TOKEN when the catalog has a spot listing', async () => {
    const rows: FundingRowFixture[] = [
      { asset: 'ZZZPERP', venue: 'GATE', symbol: 'GATE_FUTURE_ZZZPERP_USDT', rate8h: '0.0001' },
      { asset: 'ZZZSPOT', venue: 'GATE', symbol: 'GATE_FUTURE_ZZZSPOT_USDT', rate8h: '0.0001' },
    ];
    const { service } = createService({ rows });
    const { funding } = await service.list(catalog({ ZZZPERP: false, ZZZSPOT: true }), { funding: true, spread: false, limit: 50 });

    expect(funding.find((row) => row.asset === 'ZZZPERP')?.assetClass).toBe('CONTRACT');
    expect(funding.find((row) => row.asset === 'ZZZSPOT')?.assetClass).toBe('TOKEN');
  });

  it('filters by super class and by fine-grained class', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });

    const rwa = await service.list(CATALOG, { funding: true, spread: false, limit: 50, assetSuperClasses: ['RWA'] });
    expect(rwa.funding.map((row) => row.asset)).toEqual(['OPENAI', 'AAPL']);
    expect(rwa.totals.funding).toBe(2);

    const crypto = await service.list(CATALOG, { funding: true, spread: false, limit: 50, assetSuperClasses: ['CRYPTO'] });
    expect(crypto.funding.map((row) => row.asset)).toEqual(['SIREN']);

    const stocks = await service.list(CATALOG, { funding: true, spread: false, limit: 50, assetClasses: ['STOCK'] });
    expect(stocks.funding.map((row) => row.asset)).toEqual(['AAPL']);
  });

  it('implements the three-state pre-IPO switch and defaults to showing everything', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });

    const all = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });
    expect(all.funding).toHaveLength(3);

    const only = await service.list(CATALOG, { funding: true, spread: false, limit: 50, preIpo: 'only' });
    expect(only.funding.map((row) => row.asset)).toEqual(['OPENAI']);

    const excluded = await service.list(CATALOG, { funding: true, spread: false, limit: 50, preIpo: 'exclude' });
    expect(excluded.funding.map((row) => row.asset)).toEqual(['SIREN', 'AAPL']);
  });

  it('applies the class filter before the row cap instead of filtering the capped window', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });
    // AAPL has the lowest APR of the three, so a naive "cap first, filter after" implementation
    // would return nothing at all.
    const { funding, totals } = await service.list(CATALOG, {
      funding: true, spread: false, limit: 1, assetClasses: ['STOCK'],
    });

    expect(funding.map((row) => row.asset)).toEqual(['AAPL']);
    expect(totals.funding).toBe(1);
  });
});

describe('opportunity board sorting', () => {
  it('sorts by 24h volume and keeps rows without a measurement last in both directions', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });

    const desc = await service.list(CATALOG, { funding: true, spread: false, limit: 50, sort: 'volume', dir: 'desc' });
    expect(desc.funding.map((row) => row.asset)).toEqual(['AAPL', 'OPENAI', 'SIREN']);

    const asc = await service.list(CATALOG, { funding: true, spread: false, limit: 50, sort: 'volume', dir: 'asc' });
    expect(asc.funding.map((row) => row.asset)).toEqual(['OPENAI', 'AAPL', 'SIREN']);
  });

  it('sorts by open interest with the same null-last convention', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });

    const desc = await service.list(CATALOG, { funding: true, spread: false, limit: 50, sort: 'oi', dir: 'desc' });
    expect(desc.funding.map((row) => row.asset)).toEqual(['AAPL', 'OPENAI', 'SIREN']);

    const asc = await service.list(CATALOG, { funding: true, spread: false, limit: 50, sort: 'oi', dir: 'asc' });
    expect(asc.funding.map((row) => row.asset)).toEqual(['OPENAI', 'AAPL', 'SIREN']);
  });

  it('sorts by asset name in both directions', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });

    const asc = await service.list(CATALOG, { funding: true, spread: false, limit: 50, sort: 'asset', dir: 'asc' });
    expect(asc.funding.map((row) => row.asset)).toEqual(['AAPL', 'OPENAI', 'SIREN']);

    const desc = await service.list(CATALOG, { funding: true, spread: false, limit: 50, sort: 'asset', dir: 'desc' });
    expect(desc.funding.map((row) => row.asset)).toEqual(['SIREN', 'OPENAI', 'AAPL']);
  });

  it('keeps the |APR| ranking as the funding board default', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });
    expect(funding.map((row) => row.asset)).toEqual(['SIREN', 'OPENAI', 'AAPL']);
  });

  it('sorts the spread board by spread bps and by the larger leg volume', async () => {
    const markets: LiveMarket[] = [
      // Low-volume pair: smaller spread, smaller turnover.
      liveMarket({ symbol: 'GATE_SPOT_AAPL_USDT', venue: 'GATE', asset: 'AAPL', bidPrice: '99', askPrice: '101', quoteVolume24h: '1000' }),
      liveMarket({ symbol: 'BYBIT_FUTURE_AAPL_USDT', venue: 'BYBIT', asset: 'AAPL', bidPrice: '100', askPrice: '100.5', quoteVolume24h: '2000' }),
      // High-volume pair: bigger spread, bigger turnover.
      liveMarket({ symbol: 'GATE_SPOT_SIREN_USDT', venue: 'GATE', asset: 'SIREN', bidPrice: '0.119', askPrice: '0.121', quoteVolume24h: '900000' }),
      liveMarket({ symbol: 'BYBIT_FUTURE_SIREN_USDT', venue: 'BYBIT', asset: 'SIREN', bidPrice: '0.125', askPrice: '0.126', quoteVolume24h: '900000' }),
    ];
    const { service } = createService({ rows: [], markets, spreadMarkets: markets });

    const bySpread = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    expect(bySpread.spread.map((row) => row.asset)).toEqual(['SIREN', 'AAPL']);

    const byVolume = await service.list(CATALOG, { funding: false, spread: true, limit: 50, sort: 'volume', dir: 'asc' });
    expect(byVolume.spread.map((row) => row.asset)).toEqual(['AAPL', 'SIREN']);
  });
});

describe('opportunity board paging', () => {
  it('returns totals of the filtered board and slices with offset + limit', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });

    const firstPage = await service.list(CATALOG, { funding: true, spread: false, limit: 2 });
    expect(firstPage.funding.map((row) => row.asset)).toEqual(['SIREN', 'OPENAI']);
    expect(firstPage.totals.funding).toBe(3);
    expect(firstPage.offset).toBe(0);
    expect(firstPage.limit).toBe(2);

    const secondPage = await service.list(CATALOG, { funding: true, spread: false, limit: 2, offset: 2 });
    expect(secondPage.funding.map((row) => row.asset)).toEqual(['AAPL']);
    expect(secondPage.totals.funding).toBe(3);
    expect(secondPage.offset).toBe(2);

    const past = await service.list(CATALOG, { funding: true, spread: false, limit: 2, offset: 10 });
    expect(past.funding).toEqual([]);
    expect(past.totals.funding).toBe(3);
  });

  it('reports an independent total per board', async () => {
    const markets: LiveMarket[] = [
      liveMarket({ symbol: 'GATE_SPOT_AAPL_USDT', venue: 'GATE', asset: 'AAPL', bidPrice: '99', askPrice: '101' }),
      liveMarket({ symbol: 'BYBIT_FUTURE_AAPL_USDT', venue: 'BYBIT', asset: 'AAPL', bidPrice: '100', askPrice: '100.5' }),
      liveMarket({ symbol: 'GATE_SPOT_SIREN_USDT', venue: 'GATE', asset: 'SIREN', bidPrice: '0.119', askPrice: '0.121' }),
      liveMarket({ symbol: 'BYBIT_FUTURE_SIREN_USDT', venue: 'BYBIT', asset: 'SIREN', bidPrice: '0.125', askPrice: '0.126' }),
    ];
    const { service } = createService({ rows: CLASSIFICATION_ROWS, markets, spreadMarkets: markets });
    const response = await service.list(CATALOG, { funding: true, spread: true, limit: 1 });

    expect(response.funding).toHaveLength(1);
    expect(response.spread).toHaveLength(1);
    expect(response.totals).toEqual({ funding: 3, spread: 2 });
  });

  it('returns empty boards without touching upstream when neither board is requested', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });
    const response = await service.list(CATALOG, { funding: false, spread: false, limit: 50 });

    expect(response).toMatchObject({ funding: [], spread: [], totals: { funding: 0, spread: 0 } });
  });
});

describe('opportunity board volume and open interest', () => {
  it('fills the funding row stats from the merged market view', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });

    expect(funding.find((row) => row.asset === 'AAPL')?.perpStats).toEqual({
      volume24h: '1000', quoteVolume24h: '200000', openInterest: '500', openInterestValue: '100000',
    });
  });

  it('reports nulls instead of zeros when the venue published nothing', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });
    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });

    expect(funding.find((row) => row.asset === 'SIREN')?.perpStats).toEqual({
      volume24h: null, quoteVolume24h: null, openInterest: null, openInterestValue: null,
    });
  });

  it('fills both spread legs and clears open interest on the spot leg', async () => {
    const markets: LiveMarket[] = [
      liveMarket({
        symbol: 'GATE_SPOT_AAPL_USDT', venue: 'GATE', asset: 'AAPL', bidPrice: '99', askPrice: '101',
        volume24h: '50', quoteVolume24h: '5000', openInterest: '9', openInterestValue: '999',
      }),
      liveMarket({
        symbol: 'BYBIT_FUTURE_AAPL_USDT', venue: 'BYBIT', asset: 'AAPL', bidPrice: '100', askPrice: '100.5',
        volume24h: '800', quoteVolume24h: '80000', openInterest: '40', openInterestValue: '40000',
      }),
    ];
    const { service } = createService({ rows: [], markets, spreadMarkets: markets });
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });

    expect(spread).toHaveLength(1);
    const row = spread[0]!;
    expect(row.leftStats).not.toBeNull();
    expect(row.rightStats).not.toBeNull();
    const spotStats = row.leftSymbol.includes('_SPOT_') ? row.leftStats : row.rightStats;
    expect(spotStats?.volume24h).toBe('50');
    // A spot listing has no open interest — a definition, not a gap.
    expect(spotStats?.openInterest).toBeNull();
    expect(spotStats?.openInterestValue).toBeNull();
    const perpStats = row.leftSymbol.includes('_SPOT_') ? row.rightStats : row.leftStats;
    expect(perpStats?.openInterestValue).toBe('40000');
  });
});

describe('opportunity board paging boundaries', () => {
  it('clamps a negative offset to the first page instead of dropping rows', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });

    const clamped = await service.list(CATALOG, { funding: true, spread: false, limit: 2, offset: -5 });
    expect(clamped.offset).toBe(0);
    expect(clamped.funding.map((row) => row.asset)).toEqual(['SIREN', 'OPENAI']);
    expect(clamped.totals.funding).toBe(3);
  });

  it('keeps the totals intact when the offset sits past the end of the board', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });

    const past = await service.list(CATALOG, { funding: true, spread: false, limit: 2, offset: 99 });
    expect(past.funding).toEqual([]);
    expect(past.spread).toEqual([]);
    expect(past.totals.funding).toBe(3);
    expect(past.offset).toBe(99);
  });
});

describe('opportunity board cross-board sort-key fallbacks', () => {
  it('ranks the funding board by |APR| when asked to sort by spread', async () => {
    const { service } = createService({ rows: CLASSIFICATION_ROWS, spreadMarkets: CLASSIFICATION_MARKETS });

    const bySpreadKey = await service.list(CATALOG, { funding: true, spread: false, limit: 50, sort: 'spread' });
    const byDefault = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });
    expect(bySpreadKey.funding.map((row) => row.asset)).toEqual(['SIREN', 'OPENAI', 'AAPL']);
    expect(bySpreadKey.funding).toEqual(byDefault.funding);
  });

  it('ranks the spread board by spread bps when asked to sort by apr', async () => {
    const markets: LiveMarket[] = [
      liveMarket({ symbol: 'GATE_SPOT_AAPL_USDT', venue: 'GATE', asset: 'AAPL', bidPrice: '99', askPrice: '101' }),
      liveMarket({ symbol: 'BYBIT_FUTURE_AAPL_USDT', venue: 'BYBIT', asset: 'AAPL', bidPrice: '100', askPrice: '100.5' }),
      liveMarket({ symbol: 'GATE_SPOT_SIREN_USDT', venue: 'GATE', asset: 'SIREN', bidPrice: '0.119', askPrice: '0.121' }),
      liveMarket({ symbol: 'BYBIT_FUTURE_SIREN_USDT', venue: 'BYBIT', asset: 'SIREN', bidPrice: '0.125', askPrice: '0.126' }),
    ];
    const { service } = createService({ rows: [], markets, spreadMarkets: markets });

    const byAprKey = await service.list(CATALOG, { funding: false, spread: true, limit: 50, sort: 'apr' });
    const bySpreadKey = await service.list(CATALOG, { funding: false, spread: true, limit: 50, sort: 'spread' });
    expect(byAprKey.spread.map((row) => row.asset)).toEqual(['SIREN', 'AAPL']);
    expect(byAprKey.spread).toEqual(bySpreadKey.spread);
  });
});

describe('cross-venue price plausibility guard', () => {
  it('accepts same-product legs and rejects multiplier or ticker collisions', () => {
    expect(legsPricedComparably(100, 101)).toBe(true);
    expect(legsPricedComparably(0.0000123, 0.0000125)).toBe(true);
    expect(legsPricedComparably(100, 80)).toBe(true);
    // The band boundary itself still passes; anything past it does not.
    expect(legsPricedComparably(135, 100)).toBe(true);
    expect(legsPricedComparably(136, 100)).toBe(false);
    // BINANCE 1000PEPE (~0.0123) against a PEPE book (~0.0000123): a 1000× contract is a
    // different product, and pairing them produced a 213% "spread".
    expect(legsPricedComparably(0.0123, 0.0000123)).toBe(false);
    // A tokenised equity named CAT (~807) against the CAT meme coin (~0.000002).
    expect(legsPricedComparably(807.4, 0.000002034)).toBe(false);
    // Missing data is the callers' concern, not this guard's: it never fabricates a rejection.
    expect(legsPricedComparably(Number.NaN, 1)).toBe(true);
    expect(legsPricedComparably(0, 1)).toBe(true);
  });

  it('drops a spread pair whose two legs are priced like different products', async () => {
    const { service } = createService({
      rows: [],
      markets: [],
      spreadMarkets: [
        liveMarket({ symbol: 'GATE_FUTURE_CAT_USDT', venue: 'GATE', asset: 'CAT', bidPrice: '807.4', askPrice: '807.5' }),
        liveMarket({ symbol: 'OKX_SPOT_CAT_USDT', venue: 'OKX', asset: 'CAT', bidPrice: '0.000002034', askPrice: '0.000002035' }),
      ],
      spotByAsset: {},
    });

    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    expect(spread).toEqual([]);
  });

  it('still lists the comparable legs of an asset another venue collides on', async () => {
    const { service } = createService({
      rows: [],
      markets: [],
      spreadMarkets: [
        liveMarket({ symbol: 'GATE_FUTURE_CAT_USDT', venue: 'GATE', asset: 'CAT', bidPrice: '807.4', askPrice: '807.5' }),
        liveMarket({ symbol: 'GATE_SPOT_CAT_USDT', venue: 'GATE', asset: 'CAT', bidPrice: '807.1', askPrice: '807.2' }),
        liveMarket({ symbol: 'OKX_SPOT_CAT_USDT', venue: 'OKX', asset: 'CAT', bidPrice: '0.000002034', askPrice: '0.000002035' }),
      ],
      spotByAsset: {},
    });

    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    expect(spread).toHaveLength(1);
    expect(spread[0]).toMatchObject({
      asset: 'CAT',
      leftSymbol: 'GATE_FUTURE_CAT_USDT',
      rightSymbol: 'GATE_SPOT_CAT_USDT',
    });
  });

  it('skips a funding spot leg priced like another product and falls back to a comparable venue', async () => {
    const { service } = createService({
      rows: [{ asset: 'PEPE', venue: 'GATE', symbol: 'GATE_FUTURE_PEPE_USDT', rate8h: '0.0001' }],
      // The funding fixture prices every perpetual leg at 100.
      markets: [
        liveMarket({ symbol: 'BINANCE_SPOT_PEPE_USDT', venue: 'BINANCE', asset: 'PEPE', lastPrice: '0.0123' }),
        liveMarket({ symbol: 'OKX_SPOT_PEPE_USDT', venue: 'OKX', asset: 'PEPE', lastPrice: '100.4' }),
      ],
      spotByAsset: {
        PEPE: [
          { venue: 'BINANCE', symbol: 'BINANCE_SPOT_PEPE_USDT' },
          { venue: 'OKX', symbol: 'OKX_SPOT_PEPE_USDT' },
        ],
      },
    });

    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });
    expect(funding).toHaveLength(1);
    expect(funding[0]).toMatchObject({ spotSymbol: 'OKX_SPOT_PEPE_USDT', spotVenue: 'OKX' });
  });

  it('leaves the funding spot leg unconnected when every candidate is another product', async () => {
    const { service } = createService({
      rows: [{ asset: 'PEPE', venue: 'GATE', symbol: 'GATE_FUTURE_PEPE_USDT', rate8h: '0.0001' }],
      markets: [
        liveMarket({ symbol: 'BINANCE_SPOT_PEPE_USDT', venue: 'BINANCE', asset: 'PEPE', lastPrice: '0.0123' }),
      ],
      spotByAsset: { PEPE: [{ venue: 'BINANCE', symbol: 'BINANCE_SPOT_PEPE_USDT' }] },
    });

    const { funding } = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });
    expect(funding[0]!.spotSymbol).toBeNull();
  });
});

describe('opportunity board cross-venue pairing', () => {
  it('pairs a USD-settled perpetual with every USD-stable leg, which is how Kraken appears', async () => {
    const { service } = createService({
      rows: [],
      markets: [
        liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' }),
        // Kraken settles in cash USD and has no CrossEx spot leg at all. Before the settlement
        // family existed this sat alone in its own group and produced zero rows.
        liveMarket({ symbol: 'KRAKEN_FUTURE_BTC_USD', venue: 'KRAKEN', asset: 'BTC', bidPrice: '100.6', askPrice: '100.7' }),
        liveMarket({ symbol: 'GATE_SPOT_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '100', askPrice: '100.2' }),
      ],
      spotByAsset: {},
    });
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });

    expect(spread).toHaveLength(1);
    const symbols = (spread[0]?.combinations ?? []).flatMap((entry) => [entry.leftSymbol, entry.rightSymbol]);
    expect(symbols).toContain('KRAKEN_FUTURE_BTC_USD');
    expect(symbols).toContain('GATE_FUTURE_BTC_USDT');
    expect(symbols).toContain('GATE_SPOT_BTC_USDT');
    // The Kraken pair is priced, not merely listed: GATE's perpetual bids 101.5 against Kraken
    // asking 100.7, and that row is what makes a Kraken ⇄ other-exchange opportunity visible.
    const krakenPair = (spread[0]?.combinations ?? []).find((entry) =>
      [entry.leftSymbol, entry.rightSymbol].includes('KRAKEN_FUTURE_BTC_USD')
      && [entry.leftSymbol, entry.rightSymbol].includes('GATE_FUTURE_BTC_USDT'));
    expect(krakenPair).toMatchObject({
      pairType: 'PERP_PERP', leftVenue: 'GATE', rightVenue: 'KRAKEN', sellBid: '101.5', buyAsk: '100.7',
    });
    expect(krakenPair?.spreadBps).toBeCloseTo(((101.5 - 100.7) / 100.7) * 10_000, 6);
  });

  it('still never pairs USDT with USDC', async () => {
    const { service } = createService({
      rows: [],
      markets: [
        liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' }),
        liveMarket({ symbol: 'OKX_FUTURE_BTC_USDC', venue: 'OKX', asset: 'BTC', bidPrice: '120', askPrice: '121' }),
      ],
      spotByAsset: {},
    });
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    // USDC keeps its own settlement family: its peg drift must never be sold as a spread.
    expect(spread).toHaveLength(0);
  });
});

describe('opportunity board cache', () => {
  const spreadBoardFilters = { funding: false, spread: true, limit: 50 } as const;

  it('reuses one computation for repeated requests inside the TTL', async () => {
    const { service, spreadMarketCalls } = createService({
      rows: [],
      markets: [liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' })],
      spotByAsset: {},
    });

    await service.list(CATALOG, spreadBoardFilters);
    expect(spreadMarketCalls()).toBe(1);
    // Re-opening the page inside the freshness window must not re-pair every market.
    await service.list(CATALOG, spreadBoardFilters);
    await service.list(CATALOG, spreadBoardFilters);
    expect(spreadMarketCalls()).toBe(1);
  });

  it('recomputes once the 30s window has passed', async () => {
    const { service, spreadMarketCalls, advance } = createService({
      rows: [],
      markets: [liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' })],
      spotByAsset: {},
    });

    await service.list(CATALOG, spreadBoardFilters);
    advance(29_000);
    await service.list(CATALOG, spreadBoardFilters);
    expect(spreadMarketCalls()).toBe(1);

    advance(2_000);
    await service.list(CATALOG, spreadBoardFilters);
    expect(spreadMarketCalls()).toBe(2);
  });

  it('shares one computation between concurrent identical requests', async () => {
    const { service, spreadMarketCalls } = createService({
      rows: [],
      markets: [liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' })],
      spotByAsset: {},
    });
    const [first, second, third] = await Promise.all([
      service.list(CATALOG, spreadBoardFilters),
      service.list(CATALOG, spreadBoardFilters),
      service.list(CATALOG, spreadBoardFilters),
    ]);
    expect(spreadMarketCalls()).toBe(1);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(third.fetchedAt).toBe(first.fetchedAt);
  });

  it('keys distinct filter sets separately and pages inside one cached result', async () => {
    const { service, spreadMarketCalls, advance } = createService({
      rows: [
        { asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.0002' },
        { asset: 'ETH', venue: 'GATE', symbol: 'GATE_FUTURE_ETH_USDT', rate8h: '0.0001' },
      ],
      markets: [
        liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' }),
        liveMarket({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', asset: 'BTC', bidPrice: '100.8', askPrice: '100.9' }),
      ],
      spotByAsset: {},
    });

    await service.list(CATALOG, { funding: true, spread: true, limit: 50 });
    expect(spreadMarketCalls()).toBe(1);
    // A different asset filter is a different board.
    await service.list(CATALOG, { funding: true, spread: true, asset: 'BTC', limit: 50 });
    expect(spreadMarketCalls()).toBe(2);
    // Paging must not recompute: the full row set is already cached.
    await service.list(CATALOG, { funding: true, spread: true, limit: 1, offset: 1 });
    expect(spreadMarketCalls()).toBe(2);
    expect(service.cacheSize()).toBe(2);

    advance(31_000);
    await service.list(CATALOG, { funding: true, spread: true, limit: 50 });
    expect(spreadMarketCalls()).toBe(3);
  });

  it('keeps `totals` the full row count while serving a page from cache', async () => {
    const { service } = createService({
      rows: [
        { asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.0002' },
        { asset: 'BTC', venue: 'BINANCE', symbol: 'BINANCE_FUTURE_BTC_USDT', rate8h: '0.0001' },
      ],
      spotByAsset: {},
    });
    const full = await service.list(CATALOG, { funding: true, spread: false, limit: 50 });
    const page = await service.list(CATALOG, { funding: true, spread: false, limit: 1, offset: 1 });
    expect(full.totals.funding).toBe(2);
    expect(page.totals.funding).toBe(2);
    expect(page.funding).toHaveLength(1);
    expect(page.funding[0]?.venue).toBe('BINANCE');
  });

  it('drops every cached board on an explicit refresh', async () => {
    const { service, spreadMarketCalls } = createService({
      rows: [],
      markets: [liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' })],
      spotByAsset: {},
    });
    await service.list(CATALOG, spreadBoardFilters);
    service.invalidateCache();
    expect(service.cacheSize()).toBe(0);
    await service.list(CATALOG, spreadBoardFilters);
    expect(spreadMarketCalls()).toBe(2);
  });

  it('evicts the oldest entry when the cache is full', async () => {
    const { service } = createService({
      rows: [
        { asset: 'BTC', venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', rate8h: '0.0002' },
        { asset: 'ETH', venue: 'GATE', symbol: 'GATE_FUTURE_ETH_USDT', rate8h: '0.0001' },
        { asset: 'SOL', venue: 'GATE', symbol: 'GATE_FUTURE_SOL_USDT', rate8h: '0.0001' },
      ],
      spotByAsset: {},
      cacheMaxEntries: 2,
    });
    for (const asset of ['BTC', 'ETH', 'SOL']) {
      await service.list(CATALOG, { funding: true, spread: false, asset, limit: 50 });
    }
    // Capacity is a bound, not a promise of growth: the map must never exceed it.
    expect(service.cacheSize()).toBe(2);
  });
});

describe('spread quote alignment (R4)', () => {
  it('accepts legs whose quote timestamps sit inside the skew budget', () => {
    const base = '2026-08-01T00:00:00.000Z';
    expect(spreadQuoteAlignment(base, '2026-08-01T00:00:01.999Z', 2_000)).toBe(true);
    // The boundary itself is still "the same moment".
    expect(spreadQuoteAlignment(base, '2026-08-01T00:00:02.000Z', 2_000)).toBe(true);
    expect(spreadQuoteAlignment(base, '2026-08-01T00:00:02.001Z', 2_000)).toBe(false);
    // Direction does not matter; the skew is absolute.
    expect(spreadQuoteAlignment('2026-08-01T00:00:05.000Z', base, 2_000)).toBe(false);
  });

  it('never calls a pair aligned when a leg carries no usable quote timestamp', () => {
    const base = '2026-08-01T00:00:00.000Z';
    expect(spreadQuoteAlignment(undefined, base, 2_000)).toBe(false);
    expect(spreadQuoteAlignment(base, undefined, 2_000)).toBe(false);
    expect(spreadQuoteAlignment(undefined, undefined, 2_000)).toBe(false);
    expect(spreadQuoteAlignment('not-a-timestamp', base, 2_000)).toBe(false);
  });

  it('marks unaligned rows on the board, sorts them below aligned rows, and rides the timestamps along', async () => {
    const stale = '2026-07-31T23:59:50.000Z'; // 10s before EPOCH — far outside any budget.
    const markets: LiveMarket[] = [
      // BTC: both legs quote at the same moment (the fixture epoch).
      liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' }),
      liveMarket({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', asset: 'BTC', bidPrice: '100.8', askPrice: '100.9' }),
      // ETH: the BINANCE leg last quoted 10s ago — a genuinely unaligned pair with a wider spread.
      liveMarket({ symbol: 'GATE_FUTURE_ETH_USDT', venue: 'GATE', asset: 'ETH', bidPrice: '101.5', askPrice: '102' }),
      liveMarket({
        symbol: 'BINANCE_FUTURE_ETH_USDT', venue: 'BINANCE', asset: 'ETH', bidPrice: '99', askPrice: '99.1',
        quoteUpdatedAt: stale,
      }),
    ];
    const { service } = createService({ rows: [], markets, spreadMarkets: markets });
    const { spread } = await service.list(CATALOG, { funding: false, spread: true, limit: 50 });

    expect(spread).toHaveLength(2);
    // ETH's 100+ bps spread would normally head the board; the alignment tie-break sinks it.
    expect(spread.map((row) => row.asset)).toEqual(['BTC', 'ETH']);
    const btc = spread[0]!;
    const eth = spread[1]!;
    expect(btc.quoteAligned).toBe(true);
    expect(eth).toMatchObject({
      quoteAligned: false,
      leftQuoteUpdatedAt: EPOCH,
      rightQuoteUpdatedAt: stale,
    });
    // The timestamps ride on the collapsed combinations too (AC-2).
    expect(eth.combinations[0]).toMatchObject({
      leftQuoteUpdatedAt: EPOCH,
      rightQuoteUpdatedAt: stale,
      quoteAligned: false,
    });
  });

  it('honours a narrower configured skew budget', async () => {
    const markets: LiveMarket[] = [
      liveMarket({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', bidPrice: '101.5', askPrice: '102' }),
      liveMarket({
        symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', asset: 'BTC', bidPrice: '100.8', askPrice: '100.9',
        quoteUpdatedAt: '2026-08-01T00:00:01.500Z',
      }),
    ];
    // 1.5s apart: inside the default 2s budget, outside a 1s one.
    const lenient = createService({ rows: [], markets, spreadMarkets: markets });
    const strict = createService({ rows: [], markets, spreadMarkets: markets, spreadQuoteMaxSkewMs: 1_000 });
    const lenientBoard = await lenient.service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    const strictBoard = await strict.service.list(CATALOG, { funding: false, spread: true, limit: 50 });
    expect(lenientBoard.spread[0]?.quoteAligned).toBe(true);
    expect(strictBoard.spread[0]?.quoteAligned).toBe(false);
  });
});
