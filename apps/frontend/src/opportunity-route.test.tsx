import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SpreadOpportunity } from '@gate-crossex/shared-types';
import { OpportunitiesView } from './opportunity-route.js';
import type { OpportunityBoard } from './frontend-routes.js';
import {
  ALL_ASSET_CLASSES,
  ALL_ASSET_SUPER_CLASSES,
  ALL_PRE_IPO_MODES,
  ALL_SPREAD_VENUES,
  DEFAULT_OPPORTUNITY_FILTERS,
  DEFAULT_OPPORTUNITY_PAGE_SIZE,
  OPPORTUNITY_PAGE_SIZES,
  applySortToggle,
  formatOpportunityAmount,
  parseAssetClassFilter,
  parseAssetSuperClassFilter,
  parsePageValue,
  parsePageSizeValue,
  parsePreIpoFilter,
  parseSortState,
  parseVenueFilter,
  serializeAssetClassFilter,
  serializeAssetSuperClassFilter,
  serializeOpportunityFilters,
  serializePreIpoFilter,
  serializeSortState,
  spreadCombinationVenues,
  opportunityRowMatchesAssetFilters,
  toggleSortState,
  toggleSpreadFilterValue,
  OpportunityClassBadge,
  OpportunitySortHeader,
} from './opportunity-route.js';

function spreadRow(overrides: Partial<SpreadOpportunity> = {}): SpreadOpportunity {
  return {
    pairType: 'PERP_PERP', asset: 'BTC', leftSymbol: 'GATE_FUTURE_BTC_USDT',
    rightSymbol: 'BINANCE_FUTURE_BTC_USDT', leftVenue: 'GATE', rightVenue: 'BINANCE',
    sellBid: '101.5', buyAsk: '100.9', spreadBps: 59.46,
    updatedAt: '2026-08-01T00:00:00.000Z', executable: true,
    assetClass: 'TOKEN', assetSuperClass: 'CRYPTO', variantSuffix: null, isPreIpo: false,
    leftStats: null, rightStats: null,
    combinations: [],
    ...overrides,
  };
}

/** Every subset of `items`, so round-trip properties are proven over the whole input space. */
function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((acc, item) => [...acc, ...acc.map((subset) => [...subset, item])], [[]]);
}

/**
 * Server-render one board with a stubbed `window.location.search`. renderToStaticMarkup runs the
 * useState initializers (where the query is parsed) but not effects, so no fetch happens.
 */
function renderBoard(board: OpportunityBoard, search: string): string {
  vi.stubGlobal('window', {
    location: { search },
    history: { replaceState: () => undefined },
    setInterval: () => 0,
    clearInterval: () => undefined,
  });
  try {
    return renderToStaticMarkup(<OpportunitiesView board={board} navigate={() => undefined} />);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('asset super-class filter (RWA / Crypto chips)', () => {
  it('is idempotent over every non-empty subset', () => {
    for (const subset of subsets<(typeof ALL_ASSET_SUPER_CLASSES)[number]>(ALL_ASSET_SUPER_CLASSES)) {
      if (subset.length === 0) continue;
      const canonical = ALL_ASSET_SUPER_CLASSES.filter((entry) => subset.includes(entry));
      const text = serializeAssetSuperClassFilter(subset);
      expect(parseAssetSuperClassFilter(text)).toEqual(canonical);
      expect(serializeAssetSuperClassFilter(parseAssetSuperClassFilter(text))).toBe(text);
    }
  });

  it('serializes the full selection to blank and reads tokens case-insensitively', () => {
    expect(serializeAssetSuperClassFilter(ALL_ASSET_SUPER_CLASSES)).toBe('');
    expect(serializeAssetSuperClassFilter(['RWA'])).toBe('RWA');
    expect(serializeAssetSuperClassFilter(['CRYPTO'])).toBe('CRYPTO');
    expect(parseAssetSuperClassFilter('rwa')).toEqual(['RWA']);
    expect(parseAssetSuperClassFilter(' CRYPTO , rwa ')).toEqual(['RWA', 'CRYPTO']);
  });

  it('falls back to both super classes for unknown or blank input', () => {
    expect(parseAssetSuperClassFilter('')).toEqual(['RWA', 'CRYPTO']);
    expect(parseAssetSuperClassFilter('NOT_A_CLASS')).toEqual(['RWA', 'CRYPTO']);
    expect(parseAssetSuperClassFilter('RWA,NOT_A_CLASS')).toEqual(['RWA']);
  });
});

describe('asset class filter (fine-class chips)', () => {
  it('is idempotent over every non-empty subset', () => {
    for (const subset of subsets<(typeof ALL_ASSET_CLASSES)[number]>(ALL_ASSET_CLASSES)) {
      if (subset.length === 0) continue;
      const canonical = ALL_ASSET_CLASSES.filter((entry) => subset.includes(entry));
      const text = serializeAssetClassFilter(subset);
      expect(parseAssetClassFilter(text)).toEqual(canonical);
      expect(serializeAssetClassFilter(parseAssetClassFilter(text))).toBe(text);
    }
  });

  it('serializes the full selection to blank and keeps canonical order', () => {
    expect(serializeAssetClassFilter(ALL_ASSET_CLASSES)).toBe('');
    expect(serializeAssetClassFilter(['ETF', 'STOCK'])).toBe('STOCK,ETF');
    expect(parseAssetClassFilter('token,stock')).toEqual(['STOCK', 'TOKEN']);
    expect(parseAssetClassFilter('PRE_IPO')).toEqual([...ALL_ASSET_CLASSES]);
  });

  it('keeps at least one entry selected through the shared toggle helper', () => {
    for (const subset of subsets<(typeof ALL_ASSET_CLASSES)[number]>(ALL_ASSET_CLASSES)) {
      if (subset.length === 0) continue;
      for (const entry of ALL_ASSET_CLASSES) {
        expect(toggleSpreadFilterValue(subset, entry).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('pre-IPO three-state switch', () => {
  it('parses the three states case-insensitively and defaults to all', () => {
    expect(parsePreIpoFilter('')).toBe('all');
    expect(parsePreIpoFilter('all')).toBe('all');
    expect(parsePreIpoFilter('ONLY')).toBe('only');
    expect(parsePreIpoFilter(' exclude ')).toBe('exclude');
    expect(parsePreIpoFilter('junk')).toBe('all');
  });

  it('serializes `all` to blank and the restrictive states by name', () => {
    for (const mode of ALL_PRE_IPO_MODES) {
      expect(parsePreIpoFilter(serializePreIpoFilter(mode))).toBe(mode);
    }
    expect(serializePreIpoFilter('all')).toBe('');
    expect(serializePreIpoFilter('only')).toBe('only');
    expect(serializePreIpoFilter('exclude')).toBe('exclude');
  });
});

describe('sort state', () => {
  it('falls back to the board ranking for unknown keys and directions', () => {
    expect(parseSortState(null, null)).toEqual({ key: 'default', dir: 'desc' });
    expect(parseSortState('junk', 'asc')).toEqual({ key: 'default', dir: 'desc' });
    expect(parseSortState('volume', 'asc')).toEqual({ key: 'volume', dir: 'asc' });
    expect(parseSortState(' volume ', 'junk')).toEqual({ key: 'volume', dir: 'desc' });
  });

  it('serializes the default ranking and desc direction to blank', () => {
    expect(serializeSortState({ key: 'default', dir: 'desc' })).toEqual({ sort: '', dir: '' });
    expect(serializeSortState({ key: 'apr', dir: 'desc' })).toEqual({ sort: 'apr', dir: '' });
    expect(serializeSortState({ key: 'apr', dir: 'asc' })).toEqual({ sort: 'apr', dir: 'asc' });
  });

  it('round-trips every state', () => {
    for (const key of ['default', 'spread', 'apr', 'volume', 'oi', 'asset'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const { sort, dir: dirText } = serializeSortState({ key, dir });
        // The default ranking serializes to blank (both keys) and always parses back to desc:
        // a direction is meaningless without a column, so only real columns round-trip asc.
        const expected = key === 'default' ? { key: 'default', dir: 'desc' } : { key, dir };
        expect(parseSortState(sort || null, dirText || null)).toEqual(expected);
      }
    }
  });

  it('starts a new column descending and flips the active column', () => {
    expect(toggleSortState({ key: 'default', dir: 'desc' }, 'volume')).toEqual({ key: 'volume', dir: 'desc' });
    expect(toggleSortState({ key: 'apr', dir: 'desc' }, 'apr')).toEqual({ key: 'apr', dir: 'asc' });
    expect(toggleSortState({ key: 'apr', dir: 'asc' }, 'apr')).toEqual({ key: 'apr', dir: 'desc' });
    expect(toggleSortState({ key: 'apr', dir: 'asc' }, 'oi')).toEqual({ key: 'oi', dir: 'desc' });
  });
});

describe('sort toggle wiring (filter model)', () => {
  // The regression this block pins: a header click must write the clicked column into the
  // filter model's `sort` field. An earlier version spread `toggleSortState`'s `{ key, dir }`
  // result straight into the filters, so `sort` stayed `default` forever and every sort
  // button (Funding APR / 24h volume / Open interest) was a silent no-op.
  const base = { ...DEFAULT_OPPORTUNITY_FILTERS, page: '3' };

  it('writes the clicked column into sort and resets the page', () => {
    const next = applySortToggle(base, 'volume');
    expect(next.sort).toBe('volume');
    expect(next.dir).toBe('desc');
    expect(next.page).toBe('1');
    expect(Object.keys(next)).not.toContain('key');
  });

  it('flips the direction when the active column is clicked again', () => {
    const first = applySortToggle(base, 'apr');
    expect(first).toMatchObject({ sort: 'apr', dir: 'desc' });
    const second = applySortToggle(first, 'apr');
    expect(second).toMatchObject({ sort: 'apr', dir: 'asc' });
    expect(applySortToggle(second, 'apr')).toMatchObject({ sort: 'apr', dir: 'desc' });
  });

  it('returns to descending when a different column takes over', () => {
    const aprAsc = applySortToggle(applySortToggle(base, 'apr'), 'apr');
    expect(applySortToggle(aprAsc, 'oi')).toMatchObject({ sort: 'oi', dir: 'desc' });
  });

  it('leaves every unrelated filter untouched', () => {
    const next = applySortToggle({ ...base, minApr: '12', asset: 'btc' }, 'oi');
    expect(next.minApr).toBe('12');
    expect(next.asset).toBe('btc');
  });

  it('carries the toggled column into the URL record the board request reads', () => {
    // End of the wiring: `useFilterQuerySync` writes this record to the URL and `boardRequest`
    // sends `sort`/`dir` to /api/opportunities from the same filter model, so the click only
    // re-orders the board if the column survives serialization.
    const next = applySortToggle(base, 'apr');
    expect(serializeOpportunityFilters(next)).toMatchObject({ sort: 'apr', dir: '' });
    const asc = applySortToggle(next, 'apr');
    expect(serializeOpportunityFilters(asc)).toMatchObject({ sort: 'apr', dir: 'asc' });
  });

  it('toggles through every column the boards expose', () => {
    for (const key of ['apr', 'volume', 'oi', 'asset'] as const) {
      const next = applySortToggle(base, key);
      expect(next.sort).toBe(key);
      expect(parseSortState(key, next.dir).key).toBe(key);
    }
  });
});

describe('page and page-size parsing', () => {
  it('falls back to page 1 for blank, zero and junk input', () => {
    expect(parsePageValue('')).toBe(1);
    expect(parsePageValue('1')).toBe(1);
    expect(parsePageValue('7')).toBe(7);
    expect(parsePageValue('0')).toBe(1);
    expect(parsePageValue('-2')).toBe(1);
    expect(parsePageValue('2.5')).toBe(1);
    expect(parsePageValue('abc')).toBe(1);
  });

  it('accepts only the offered page sizes', () => {
    expect(OPPORTUNITY_PAGE_SIZES).toEqual([25, 50, 100]);
    expect(parsePageSizeValue('')).toBe(DEFAULT_OPPORTUNITY_PAGE_SIZE);
    expect(parsePageSizeValue('25')).toBe(25);
    expect(parsePageSizeValue('100')).toBe(100);
    expect(parsePageSizeValue('10')).toBe(DEFAULT_OPPORTUNITY_PAGE_SIZE);
    expect(parsePageSizeValue('junk')).toBe(DEFAULT_OPPORTUNITY_PAGE_SIZE);
  });
});

describe('formatOpportunityAmount', () => {
  it('renders missing data as an em dash', () => {
    expect(formatOpportunityAmount(null)).toBe('—');
    expect(formatOpportunityAmount(undefined)).toBe('—');
    expect(formatOpportunityAmount('')).toBe('—');
    expect(formatOpportunityAmount('0')).toBe('—');
    expect(formatOpportunityAmount('-5')).toBe('—');
    expect(formatOpportunityAmount('not-a-number')).toBe('—');
  });

  it('formats positive amounts compactly', () => {
    expect(formatOpportunityAmount('999')).toBe('999');
    expect(formatOpportunityAmount('1234567')).toBe('1.2M');
    expect(formatOpportunityAmount('2500000000')).toBe('2.5B');
    expect(formatOpportunityAmount('0.5')).toBe('0.5');
  });
});

describe('opportunityRowMatchesAssetFilters', () => {
  const cryptoRow = spreadRow();
  const stockRow = spreadRow({ assetClass: 'STOCK', assetSuperClass: 'RWA', isPreIpo: false });
  const preIpoRow = spreadRow({ assetClass: 'PRE_IPO', assetSuperClass: 'RWA', isPreIpo: true });

  it('keeps every row while the chips and the switch are at their defaults', () => {
    for (const row of [cryptoRow, stockRow, preIpoRow]) {
      expect(opportunityRowMatchesAssetFilters(row, [], [], 'all')).toBe(true);
    }
  });

  it('applies the super-class whitelist', () => {
    expect(opportunityRowMatchesAssetFilters(cryptoRow, ['CRYPTO'], [], 'all')).toBe(true);
    expect(opportunityRowMatchesAssetFilters(cryptoRow, ['RWA'], [], 'all')).toBe(false);
    expect(opportunityRowMatchesAssetFilters(stockRow, ['RWA'], [], 'all')).toBe(true);
  });

  it('applies the fine-class whitelist', () => {
    expect(opportunityRowMatchesAssetFilters(stockRow, [], ['STOCK'], 'all')).toBe(true);
    expect(opportunityRowMatchesAssetFilters(stockRow, [], ['TOKEN'], 'all')).toBe(false);
  });

  it('applies the three-state pre-IPO switch', () => {
    expect(opportunityRowMatchesAssetFilters(preIpoRow, [], [], 'only')).toBe(true);
    expect(opportunityRowMatchesAssetFilters(cryptoRow, [], [], 'only')).toBe(false);
    expect(opportunityRowMatchesAssetFilters(cryptoRow, [], [], 'exclude')).toBe(true);
    expect(opportunityRowMatchesAssetFilters(preIpoRow, [], [], 'exclude')).toBe(false);
    expect(opportunityRowMatchesAssetFilters(preIpoRow, [], [], 'all')).toBe(true);
  });

  it('ANDs the chips with the switch', () => {
    expect(opportunityRowMatchesAssetFilters(preIpoRow, ['RWA'], [], 'only')).toBe(true);
    expect(opportunityRowMatchesAssetFilters(preIpoRow, ['CRYPTO'], [], 'only')).toBe(false);
    expect(opportunityRowMatchesAssetFilters(preIpoRow, [], ['STOCK'], 'only')).toBe(false);
  });
});

describe('spread board SSR of the asset-type chips', () => {
  it('marks the two super-class chips selected by default (chips use data-on, not aria-pressed)', () => {
    const html = renderBoard('spread', '');
    const onFlags = [...html.matchAll(/data-on="(true|false)"/g)].map((match) => match[1] === 'true');
    // The fine-class and pre-IPO chip groups were removed: RWA / Crypto only.
    expect(onFlags).toHaveLength(ALL_ASSET_SUPER_CLASSES.length);
    expect(onFlags.filter((flag) => flag)).toHaveLength(ALL_ASSET_SUPER_CLASSES.length);
  });

  it('restores a partial super-class selection from the URL query', () => {
    const html = renderBoard('spread', '?assetSuperClass=RWA');
    const onFlags = [...html.matchAll(/data-on="(true|false)"/g)].map((match) => match[1] === 'true');
    expect(onFlags).toEqual([true, false]);
  });

  it('falls back to both super classes for hand-edited junk', () => {
    const html = renderBoard('spread', '?assetSuperClass=junk');
    const onFlags = [...html.matchAll(/data-on="(true|false)"/g)].map((match) => match[1] === 'true');
    expect(onFlags.filter((flag) => flag)).toHaveLength(ALL_ASSET_SUPER_CLASSES.length);
  });
});

describe('sortable headers', () => {
  /**
   * The boards render their tables only once rows have loaded (an SSR snapshot holds no data),
   * so the `aria-sort` contract is asserted directly against the header component.
   */
  function renderHeader(state: ReturnType<typeof parseSortState>): string {
    return renderToStaticMarkup(
      <OpportunitySortHeader label="Funding APR" sortKey="apr" state={state} onToggle={() => undefined} />,
    );
  }

  it('renders an unsorted header for the default ranking', () => {
    const html = renderHeader({ key: 'default', dir: 'desc' });
    expect(html).toContain('aria-sort="none"');
    expect(html).not.toContain('aria-sort="ascending"');
    expect(html).not.toContain('aria-sort="descending"');
  });

  it('marks the active column and direction', () => {
    expect(renderHeader({ key: 'apr', dir: 'asc' })).toContain('aria-sort="ascending"');
    expect(renderHeader({ key: 'apr', dir: 'desc' })).toContain('aria-sort="descending"');
  });

  it('leaves other columns unsorted while one column is active', () => {
    expect(renderHeader({ key: 'volume', dir: 'desc' })).toContain('aria-sort="none"');
  });
});

describe('funding board SSR', () => {
  it('renders only the asset-type chips: the fine-class and pre-IPO groups are gone', () => {
    const html = renderBoard('funding', '');
    expect(html).toContain('asset-class-filters');
    expect(html).toContain('Asset type');
    expect(html).toContain('RWA');
    expect(html).toContain('Crypto');
    expect(html).not.toContain('All types');
    expect(html).not.toContain('Only pre-IPO');
    expect(html).not.toContain('Exclude pre-IPO');
    expect(html).not.toContain('opportunity-filter-groups');
    expect(html).not.toContain('market-filter');
    // The project bans aria-pressed everywhere: no render may reintroduce it.
    expect([...html.matchAll(/aria-pressed=/g)]).toHaveLength(0);
  });

  it('opens on the perpetual ⇄ perpetual board and offers the spot switch', () => {
    const html = renderBoard('funding', '');
    expect(html).toContain('hedge-mode-switch');
    expect(html).toContain('Spot ⇄ perpetual');
    expect(html).toContain('Perpetual ⇄ perpetual');
    // The mode switch is a radio group: exactly one mode is active, and it starts on perp/perp.
    const segment = html.slice(html.indexOf('hedge-mode-switch'));
    const group = segment.slice(0, segment.indexOf('</div>'));
    expect([...group.matchAll(/aria-checked="(true|false)"/g)].map((match) => match[1])).toEqual(['false', 'true']);
    expect(html).toContain('Cross-exchange funding hedge');
    expect(html).not.toContain('Positive funding buys spot against the perpetual');
  });
});

describe('funding-rate ranking board SSR', () => {
  it('renders the single-venue toolbar and none of the other boards', () => {
    const html = renderBoard('funding-top', '');
    expect(html).toContain('Funding-rate ranking');
    expect(html).toContain('Every perpetual on the selected exchange');
    // No exchange multi-select, no asset chips, and the spread table never leaks into this tab
    // (the tab bar itself still lists the other two boards).
    expect(html).not.toContain('Best path');
    expect(html).not.toContain('opportunity-spread-title');
    expect(html).not.toContain('asset-class-filters');
    expect(html).not.toContain('opportunity-filter-groups');
    expect([...html.matchAll(/aria-pressed=/g)]).toHaveLength(0);
    expect([...html.matchAll(/aria-checked=/g)]).toHaveLength(0);
  });
});

describe('OpportunityClassBadge', () => {
  it('labels the asset RWA or Crypto and nothing else', () => {
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => undefined } });
    try {
      const rwa = renderToStaticMarkup(<OpportunityClassBadge row={{ assetSuperClass: 'RWA' }} />);
      expect(rwa).toContain('RWA');
      expect(rwa).toContain('rwa');
      const crypto = renderToStaticMarkup(<OpportunityClassBadge row={{ assetSuperClass: 'CRYPTO' }} />);
      expect(crypto).toContain('Crypto');
      expect(crypto).toContain('crypto');
      // The former fine class (e.g. TOKEN) and the pre-IPO marker no longer render.
      expect(crypto).not.toContain('Pre-IPO');
      expect(crypto).not.toContain('<small>');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('spread board default market filter', () => {
  it('opens with spot filtering off and perpetual-only selected', () => {
    const html = renderBoard('spread', '');
    const segment = html.slice(html.indexOf('market-filter'));
    const group = segment.slice(0, segment.indexOf('</div>'));
    expect([...group.matchAll(/aria-checked="true"/g)]).toHaveLength(1);
    expect(group).toContain('aria-checked="false"');
  });
});

describe('spreadCombinationVenues', () => {
  it('deduplicates the venues of every combination into one sorted coverage list', () => {
    const row = spreadRow({
      combinations: [
        { pairType: 'PERP_PERP', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'BINANCE_FUTURE_BTC_USDT', leftVenue: 'GATE', rightVenue: 'BINANCE', sellBid: '101.5', buyAsk: '100.9', spreadBps: 59.46, updatedAt: '2026-08-01T00:00:00.000Z', executable: true },
        { pairType: 'SPOT_PERP', leftSymbol: 'GATE_FUTURE_BTC_USDT', rightSymbol: 'OKX_SPOT_BTC_USDT', leftVenue: 'GATE', rightVenue: 'OKX', sellBid: '101.5', buyAsk: '101', spreadBps: 49.5, updatedAt: '2026-08-01T00:00:00.000Z', executable: true },
        { pairType: 'PERP_PERP', leftSymbol: 'OKX_FUTURE_BTC_USDT', rightSymbol: 'BINANCE_FUTURE_BTC_USDT', leftVenue: 'OKX', rightVenue: 'BINANCE', sellBid: '101.2', buyAsk: '100.9', spreadBps: 29.7, updatedAt: '2026-08-01T00:00:00.000Z', executable: true },
      ],
    });
    // GATE and BINANCE repeat across pairs; each venue appears exactly once, in catalog order.
    expect(spreadCombinationVenues(row)).toEqual(['BINANCE', 'GATE', 'OKX']);
  });

  it('returns an empty coverage list for an asset without combinations', () => {
    expect(spreadCombinationVenues(spreadRow())).toEqual([]);
  });
});

describe('parseVenueFilter', () => {
  it('treats a blank selection as every exchange', () => {
    expect(parseVenueFilter('')).toEqual([...ALL_SPREAD_VENUES]);
    expect(parseVenueFilter('   ')).toEqual([...ALL_SPREAD_VENUES]);
  });

  it('reads a comma-separated selection and returns it in catalog order', () => {
    expect(parseVenueFilter('GATE,BINANCE')).toEqual(['GATE', 'BINANCE']);
    expect(parseVenueFilter(' okx , binance ')).toEqual(['BINANCE', 'OKX']);
  });

  it('ignores unknown and blank entries instead of emptying the board', () => {
    expect(parseVenueFilter('GATE,,NOT_A_VENUE')).toEqual(['GATE']);
    expect(parseVenueFilter('NOT_A_VENUE')).toEqual([...ALL_SPREAD_VENUES]);
  });
});

describe('spread-quality board SSR', () => {
  it('opens the fourth tab with no aria-pressed anywhere and no leaked filters', () => {
    const html = renderBoard('spread-quality', '');
    expect(html).toContain('Spread quality board');
    expect(html).toContain('Spread quality');
    expect(html).toContain('Ranked by 24h spread-distribution quality');
    // The board keeps no URL-synced filters: no asset chips, no exchange / market button groups.
    expect(html).not.toContain('asset-class-filters');
    expect(html).not.toContain('opportunity-filter-groups');
    // The filter buttons use role=checkbox (+aria-checked); aria-pressed is banned project-wide.
    expect([...html.matchAll(/aria-pressed=/g)]).toHaveLength(0);
    // Four boards in the tablist, exactly one selected.
    expect([...html.matchAll(/role="tab"/g)]).toHaveLength(4);
    expect([...html.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
    // The table renders only once rows arrive; the SSR snapshot holds the loading empty state.
    expect(html).toContain('opportunity-spread-quality-title');
    expect(html).not.toContain('opportunity-spread-quality-table');
    expect(html).toContain('Loading…');
  });

  it('never leaks the spread table into the spread-quality board', () => {
    const html = renderBoard('spread-quality', '');
    expect(html).not.toContain('Best path');
    expect(html).not.toContain('opportunity-spread-title');
    expect(html).not.toContain('hedge-mode-switch');
  });
});
