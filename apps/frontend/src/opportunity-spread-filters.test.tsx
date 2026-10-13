import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SpreadOpportunity } from '@gate-crossex/shared-types';
import { api } from './api.js';
import { OpportunitiesView } from './opportunity-route.js';
import {
  ALL_SPREAD_MARKETS,
  ALL_SPREAD_VENUES,
  parseMarketFilter,
  parseVenueFilter,
  serializeMarketFilter,
  serializeVenueFilter,
  spreadRowMatchesFilters,
  toggleSpreadFilterValue,
} from './opportunity-route.js';

/**
 * Independent acceptance tests for the spread board's exchange buttons and market-type switches.
 * The pure helpers are exercised exhaustively (round-trip idempotency over every subset), and
 * `OpportunitiesView` is server-rendered to prove the buttons really reflect a restored URL query.
 * There is no jsdom/@testing-library in this workspace, so click behaviour is covered through the
 * toggle helpers the click handlers call plus the SSR snapshot of `aria-checked`.
 */

const VENUE_COUNT = ALL_SPREAD_VENUES.length;
const MARKET_COUNT = ALL_SPREAD_MARKETS.length;

function spreadRow(overrides: Partial<SpreadOpportunity> = {}): SpreadOpportunity {
  return {
    pairType: 'PERP_PERP', asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT',
    rightSymbol: 'BINANCE_FUTURE_BTC_USDT', leftVenue: 'GATE', rightVenue: 'BINANCE',
    sellBid: '101.5', buyAsk: '100.9', spreadBps: 59.46,
    updatedAt: '2026-08-01T00:00:00.000Z', executable: true,
    assetClass: 'TOKEN', assetSuperClass: 'CRYPTO', variantSuffix: null, isPreIpo: false,
    leftStats: null, rightStats: null, combinations: [],
    ...overrides,
  };
}

/** Every subset of `items`, so round-trip properties are proven over the whole input space. */
function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((acc, item) => [...acc, ...acc.map((subset) => [...subset, item])], [[]]);
}

function checkedFlags(html: string): boolean[] {
  return [...html.matchAll(/aria-checked="(true|false)"/g)].map((match) => match[1] === 'true');
}

/**
 * Server-render the spread board with a stubbed `window.location.search`. renderToStaticMarkup
 * runs the useState initializers (where the query is parsed) but not effects, so no fetch happens.
 */
function renderSpreadBoard(search: string): string {
  vi.stubGlobal('window', {
    location: { search },
    history: { replaceState: () => undefined },
    setInterval: () => 0,
    clearInterval: () => undefined,
  });
  try {
    return renderToStaticMarkup(<OpportunitiesView board="spread" navigate={() => undefined} />);
  } finally {
    vi.unstubAllGlobals();
  }
}

function renderFundingBoard(search: string): string {
  vi.stubGlobal('window', {
    location: { search },
    history: { replaceState: () => undefined },
    setInterval: () => 0,
    clearInterval: () => undefined,
  });
  try {
    return renderToStaticMarkup(<OpportunitiesView board="funding" navigate={() => undefined} />);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('venue filter URL round-trip', () => {
  it('is idempotent over every non-empty venue subset', () => {
    // The empty subset is deliberately excluded: it serializes to the same blank text as the full
    // selection (see the next test), so it has no canonical round-trip. The UI never produces it
    // because toggleSpreadFilterValue keeps at least one entry selected.
    for (const subset of subsets<string>(ALL_SPREAD_VENUES).filter((entry) => entry.length > 0)) {
      const canonical = ALL_SPREAD_VENUES.filter((venue) => subset.includes(venue));
      const text = serializeVenueFilter(subset);
      expect(parseVenueFilter(text)).toEqual(canonical);
      expect(serializeVenueFilter(parseVenueFilter(text))).toBe(text);
      // A second round must not drift either.
      expect(serializeVenueFilter(parseVenueFilter(serializeVenueFilter(parseVenueFilter(text))))).toBe(text);
    }
  });

  it('serializes the full selection to blank and a partial one in catalog order', () => {
    expect(serializeVenueFilter(ALL_SPREAD_VENUES)).toBe('');
    expect(serializeVenueFilter([...ALL_SPREAD_VENUES].reverse())).toBe('');
    expect(serializeVenueFilter(['LIGHTER', 'OKX', 'GATE'])).toBe('GATE,OKX,LIGHTER');
    expect(parseVenueFilter('lighter,okx,gate')).toEqual(['GATE', 'OKX', 'LIGHTER']);
  });

  it('collapses the empty selection onto the full selection (documented, not a bug)', () => {
    // An empty selection and a full selection both serialize to blank and both parse back to
    // "every exchange". This is intentional: the board requires at least one exchange, so the
    // empty selection is unreachable from the UI (toggleSpreadFilterValue enforces the floor).
    expect(serializeVenueFilter([])).toBe('');
    expect(parseVenueFilter(serializeVenueFilter([]))).toEqual([...ALL_SPREAD_VENUES]);
    expect(parseVenueFilter(serializeVenueFilter([...ALL_SPREAD_VENUES]))).toEqual([...ALL_SPREAD_VENUES]);
  });

  it('falls back to every exchange for unknown, blank or duplicated-but-unknown input', () => {
    expect(parseVenueFilter('')).toEqual([...ALL_SPREAD_VENUES]);
    expect(parseVenueFilter(' , , ')).toEqual([...ALL_SPREAD_VENUES]);
    expect(parseVenueFilter('NOT_A_VENUE')).toEqual([...ALL_SPREAD_VENUES]);
    expect(parseVenueFilter('GATE,NOT_A_VENUE,,GATE')).toEqual(['GATE']);
  });
});

describe('market filter URL round-trip', () => {
  it('is idempotent over every non-empty market subset', () => {
    for (const subset of subsets<typeof ALL_SPREAD_MARKETS[number]>(ALL_SPREAD_MARKETS).filter((entry) => entry.length > 0)) {
      const canonical = ALL_SPREAD_MARKETS.filter((market) => subset.includes(market));
      const text = serializeMarketFilter(subset);
      expect(parseMarketFilter(text)).toEqual(canonical);
      expect(serializeMarketFilter(parseMarketFilter(text))).toBe(text);
    }
  });

  it('serializes both market types to blank and reads tokens case-insensitively', () => {
    expect(serializeMarketFilter(ALL_SPREAD_MARKETS)).toBe('');
    expect(serializeMarketFilter(['perp', 'spot'])).toBe('');
    expect(parseMarketFilter('PERP')).toEqual(['perp']);
    expect(parseMarketFilter(' Spot , perp ')).toEqual(['spot', 'perp']);
    expect(parseMarketFilter('swap')).toEqual(['spot', 'perp']);
  });
});

describe('toggleSpreadFilterValue', () => {
  it('keeps the last remaining entry selected for venues and markets alike', () => {
    for (const venue of ALL_SPREAD_VENUES) {
      expect(toggleSpreadFilterValue([venue], venue)).toEqual([venue]);
    }
    for (const market of ALL_SPREAD_MARKETS) {
      expect(toggleSpreadFilterValue([market], market)).toEqual([market]);
    }
  });

  it('never returns an empty selection when starting from a canonical non-empty one', () => {
    for (const subset of subsets<string>(ALL_SPREAD_VENUES)) {
      if (subset.length === 0) continue;
      for (const venue of ALL_SPREAD_VENUES) {
        const next = toggleSpreadFilterValue(subset, venue);
        expect(next.length).toBeGreaterThan(0);
        // Re-serializing keeps the selection stable through a URL round-trip.
        expect(parseVenueFilter(serializeVenueFilter(next))).toEqual(
          ALL_SPREAD_VENUES.filter((entry) => next.includes(entry)),
        );
      }
    }
  });

  it('adds an unselected entry and drops a selected one', () => {
    expect(toggleSpreadFilterValue(['GATE', 'OKX'], 'BYBIT')).toEqual(['GATE', 'OKX', 'BYBIT']);
    expect(toggleSpreadFilterValue(['GATE', 'OKX', 'BYBIT'], 'OKX')).toEqual(['GATE', 'BYBIT']);
    expect(toggleSpreadFilterValue(['spot'], 'perp')).toEqual(['spot', 'perp']);
    expect(toggleSpreadFilterValue(['spot', 'perp'], 'spot')).toEqual(['perp']);
  });

  it('restores catalog order after toggles that append out of order', () => {
    // Toggling OKX onto a GATE-only selection yields [GATE, OKX]; appending BYBIT yields
    // [GATE, OKX, BYBIT], which must serialize back in catalog order regardless.
    const afterFirst = toggleSpreadFilterValue(['GATE'], 'OKX');
    const afterSecond = toggleSpreadFilterValue(afterFirst, 'BYBIT');
    expect(afterSecond).toEqual(['GATE', 'OKX', 'BYBIT']);
    expect(serializeVenueFilter(afterSecond)).toBe('GATE,OKX,BYBIT');
    expect(parseVenueFilter(serializeVenueFilter(afterSecond))).toEqual(['GATE', 'OKX', 'BYBIT']);
    // Reverse insertion order must produce the same serialized text.
    const reversed = toggleSpreadFilterValue(toggleSpreadFilterValue(['GATE'], 'BYBIT'), 'OKX');
    expect(serializeVenueFilter(reversed)).toBe(serializeVenueFilter(afterSecond));
  });
});

describe('spreadRowMatchesFilters', () => {
  it('requires both legs to sit on a selected exchange (cross-venue and same-venue rows)', () => {
    const cross = spreadRow({ leftVenue: 'GATE', rightVenue: 'BINANCE' });
    const same = spreadRow({ leftVenue: 'OKX', rightVenue: 'OKX', pairType: 'SPOT_PERP' });
    expect(spreadRowMatchesFilters(cross, ['GATE', 'BINANCE'], ALL_SPREAD_MARKETS)).toBe(true);
    expect(spreadRowMatchesFilters(cross, ['GATE'], ALL_SPREAD_MARKETS)).toBe(false);
    expect(spreadRowMatchesFilters(cross, ['BINANCE'], ALL_SPREAD_MARKETS)).toBe(false);
    expect(spreadRowMatchesFilters(same, ['OKX'], ALL_SPREAD_MARKETS)).toBe(true);
    expect(spreadRowMatchesFilters(same, ['GATE', 'BINANCE'], ALL_SPREAD_MARKETS)).toBe(false);
    expect(spreadRowMatchesFilters(same, ALL_SPREAD_VENUES, ALL_SPREAD_MARKETS)).toBe(true);
  });

  it('normalizes lower-case venue ids coming off a stale snapshot', () => {
    const row = spreadRow({ leftVenue: 'gate', rightVenue: 'binance' });
    expect(spreadRowMatchesFilters(row, ['GATE', 'BINANCE'], ALL_SPREAD_MARKETS)).toBe(true);
    expect(spreadRowMatchesFilters(row, ['GATE'], ALL_SPREAD_MARKETS)).toBe(false);
  });

  it('treats an empty whitelist as "no restriction" for venues and markets', () => {
    expect(spreadRowMatchesFilters(spreadRow({ pairType: 'PERP_PERP' }), [], [])).toBe(true);
    expect(spreadRowMatchesFilters(spreadRow({ pairType: 'SPOT_PERP' }), [], [])).toBe(true);
  });

  it('maps spot to SPOT_PERP and perp to PERP_PERP', () => {
    const spotPerp = spreadRow({ pairType: 'SPOT_PERP' });
    const perpPerp = spreadRow({ pairType: 'PERP_PERP' });
    expect(spreadRowMatchesFilters(spotPerp, ALL_SPREAD_VENUES, ['spot'])).toBe(true);
    expect(spreadRowMatchesFilters(spotPerp, ALL_SPREAD_VENUES, ['perp'])).toBe(false);
    expect(spreadRowMatchesFilters(perpPerp, ALL_SPREAD_VENUES, ['perp'])).toBe(true);
    expect(spreadRowMatchesFilters(perpPerp, ALL_SPREAD_VENUES, ['spot'])).toBe(false);
    expect(spreadRowMatchesFilters(spotPerp, ALL_SPREAD_VENUES, ['spot', 'perp'])).toBe(true);
    expect(spreadRowMatchesFilters(perpPerp, ALL_SPREAD_VENUES, ['spot', 'perp'])).toBe(true);
  });

  it('ANDs the venue and market conditions', () => {
    const row = spreadRow({ pairType: 'SPOT_PERP', leftVenue: 'GATE', rightVenue: 'BINANCE' });
    expect(spreadRowMatchesFilters(row, ['GATE', 'BINANCE'], ['spot'])).toBe(true);
    expect(spreadRowMatchesFilters(row, ['GATE', 'BINANCE'], ['perp'])).toBe(false);
    expect(spreadRowMatchesFilters(row, ['GATE'], ['spot'])).toBe(false);
  });
});

describe('spread board filter buttons', () => {
  it('renders one button per exchange plus the two market switches', () => {
    const html = renderSpreadBoard('');
    expect(html).toContain('exchange-filter');
    expect(html).toContain('market-filter');
    expect(html).toContain('opportunity-filter-groups');
    const flags = checkedFlags(html);
    expect(flags).toHaveLength(VENUE_COUNT + MARKET_COUNT);
    // Default: every exchange is on, and only the perpetual market is enabled — spot legs start
    // off because they carry far more cross-exchange symbol mismatches than genuine opportunities.
    expect(flags.slice(0, VENUE_COUNT).every((flag) => flag)).toBe(true);
    expect(flags.slice(VENUE_COUNT)).toEqual([false, true]);
    const selected = [...html.matchAll(/class="selected"/g)].length;
    expect(selected).toBe(VENUE_COUNT + 1);
  });

  it('restores a partial selection from the URL query', () => {
    const html = renderSpreadBoard('?venues=GATE,OKX&markets=spot');
    const flags = checkedFlags(html);
    expect(flags).toHaveLength(VENUE_COUNT + MARKET_COUNT);
    expect(flags.slice(0, VENUE_COUNT)).toEqual([true, false, true, false, false, false, false, false]);
    // Market switches follow the venue buttons: spot on, perpetual off.
    expect(flags.slice(VENUE_COUNT)).toEqual([true, false]);
    expect([...html.matchAll(/class="selected"/g)].length).toBe(3);
  });

  it('restores a lower-case hand-edited query and falls back to full selection for junk', () => {
    const lower = renderSpreadBoard('?venues=okx,gate&markets=PERP');
    expect(checkedFlags(lower).slice(0, VENUE_COUNT)).toEqual([true, false, true, false, false, false, false, false]);
    expect(checkedFlags(lower).slice(VENUE_COUNT)).toEqual([false, true]);

    const junk = renderSpreadBoard('?venues=NOT_A_VENUE&markets=swap');
    expect(checkedFlags(junk).every((flag) => flag)).toBe(true);
  });

  it('leaves the funding board without the new spread filter groups', () => {
    const html = renderFundingBoard('?venues=GATE&markets=spot');
    expect(html).not.toContain('opportunity-filter-groups');
    expect(html).not.toContain('market-filter');
    // No spread-filter checkboxes: the funding board's only checked control is the hedge-mode radiogroup.
    expect([...html.matchAll(/role="checkbox"/g)]).toHaveLength(0);
  });
});

describe('opportunities request assembly', () => {
  it('omits venues and markets for the default full selection and sends them otherwise', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        funding: [], spread: [], fetchedAt: '2026-08-01T00:00:00.000Z', cacheStatus: 'fresh',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    try {
      await api.opportunities({ funding: false, spread: true, limit: 50 });
      await api.opportunities({ funding: false, spread: true, venues: ['GATE', 'OKX'], markets: ['spot'], limit: 50 });
      await api.opportunities({ funding: false, spread: true, venues: [], markets: [], limit: 50 });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(urls).toHaveLength(3);
    const [defaultUrl, filteredUrl, emptyUrl] = urls.map((url) => decodeURIComponent(url));
    expect(defaultUrl).not.toContain('venues=');
    expect(defaultUrl).not.toContain('markets=');
    expect(filteredUrl).toContain('venues=GATE,OKX');
    expect(filteredUrl).toContain('markets=spot');
    expect(emptyUrl).not.toContain('venues=');
    expect(emptyUrl).not.toContain('markets=');
    for (const url of urls.map((entry) => decodeURIComponent(entry))) {
      expect(url).toContain('spread=1');
      // A disabled board is expressed by omitting its flag entirely, never by funding=0.
      expect(url).not.toContain('funding=');
      expect(url).toContain('limit=50');
    }
  });
});
