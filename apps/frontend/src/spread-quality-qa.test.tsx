import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpreadQualityResponseSchema, SpreadQualityRowSchema } from '@gate-crossex/shared-types';
import type { SpreadQualityRow } from '@gate-crossex/shared-types';
import { ApiError, api } from './api.js';
import {
  SpreadQualityTable,
  formatHalfLifeHours,
  formatOpportunityScore,
  formatSpreadQualityBps,
  groupSpreadQualityRows,
} from './spread-quality-table.js';

/**
 * Adversarial QA suite for the spread-quality board (fresh eyes, independent of the engineer's
 * own `spread-quality-table.test.tsx`). It deliberately re-pins the contract-critical behaviour
 * from the other side: null statistics must render as em dashes (never NaN/null/0/Infinity),
 * grouping must never re-sort the server's ranking, the component must stay free of the
 * project-banned `aria-pressed`, expansion must be fully controlled, the API client must map
 * its options into the query string, and the shared zod contract must accept nulls while
 * rejecting malformed rows.
 */

function qualityRow(overrides: Partial<SpreadQualityRow> = {}): SpreadQualityRow {
  return {
    pairType: 'SPOT_PERP', asset: 'BTC',
    leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'BINANCE_FUTURE_BTC_USDT',
    leftVenue: 'GATE', rightVenue: 'BINANCE',
    currentSpreadBps: 12.5, meanSpreadBps: 9.25, spreadVolatilityBps: 4.5,
    skewness: 0.11, excessKurtosis: 0.9, symmetric: true,
    ar1Coefficient: 0.77, halfLifeHours: 2.5, holdingCostBps: 0.75,
    bookDepthUsdt: 180000, score: 63.5, sampleCount: 288, source: 'candles',
    updatedAt: '2026-10-07T00:00:00.000Z',
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

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('formatters: null is a dash, a real zero is a value', () => {
  it('renders null as an em dash and keeps a genuine zero at fixed precision', () => {
    expect(formatSpreadQualityBps(null)).toBe('—');
    expect(formatSpreadQualityBps(0)).toBe('0.00');
    expect(formatSpreadQualityBps(-4)).toBe('-4.00');
    expect(formatHalfLifeHours(null)).toBe('—');
    expect(formatHalfLifeHours(0)).toBe('0.0');
    expect(formatHalfLifeHours(2.5)).toBe('2.5');
    expect(formatOpportunityScore(0)).toBe('0.0');
    expect(formatOpportunityScore(63.5)).toBe('63.5');
  });
});

describe('groupSpreadQualityRows: buckets, never re-sorts', () => {
  it('returns no groups for an empty payload', () => {
    expect(groupSpreadQualityRows([])).toEqual([]);
  });

  it('keeps a lone row as its own group, best and only combination', () => {
    const row = qualityRow();
    const groups = groupSpreadQualityRows([row]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.asset).toBe('BTC');
    expect(groups[0]?.best).toBe(row);
    expect(groups[0]?.combinations).toEqual([row]);
  });

  it('merges non-adjacent rows of the same asset without touching the payload order', () => {
    const groups = groupSpreadQualityRows([
      qualityRow({ asset: 'ETH', score: 95, leftSymbol: 'GATE_SPOT_ETH_USDT', rightSymbol: 'BINANCE_FUTURE_ETH_USDT' }),
      qualityRow({ asset: 'BTC', score: 70, leftSymbol: 'OKX_SPOT_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT' }),
      qualityRow({ asset: 'SOL', score: 80, leftSymbol: 'GATE_SPOT_SOL_USDT', rightSymbol: 'BINANCE_FUTURE_SOL_USDT' }),
      qualityRow({ asset: 'BTC', score: 90 }),
      qualityRow({ asset: 'BTC', score: 60, leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'OKX_FUTURE_BTC_USDT' }),
    ]);
    // Group order = first appearance of each asset; BTC's rows sit at positions 2, 4 and 5.
    expect(groups.map((group) => group.asset)).toEqual(['ETH', 'BTC', 'SOL']);
    // The group keeps the server's payload order verbatim — no client-side re-sort, even though
    // the second BTC row outscores the first.
    expect(groups[1]?.combinations.map((row) => row.score)).toEqual([70, 90, 60]);
    expect(groups[1]?.best.score).toBe(70);
    expect(groups[0]?.combinations).toHaveLength(1);
    expect(groups[2]?.combinations).toHaveLength(1);
  });

  it('preserves a score-descending payload exactly: group order by first appearance, best first inside', () => {
    const groups = groupSpreadQualityRows([
      qualityRow({ asset: 'ETH', score: 95, leftSymbol: 'GATE_SPOT_ETH_USDT', rightSymbol: 'BINANCE_FUTURE_ETH_USDT' }),
      qualityRow({ asset: 'BTC', score: 90 }),
      qualityRow({ asset: 'BTC', score: 80, leftSymbol: 'OKX_SPOT_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT' }),
      qualityRow({ asset: 'SOL', score: 60, leftSymbol: 'GATE_SPOT_SOL_USDT', rightSymbol: 'BINANCE_FUTURE_SOL_USDT' }),
    ]);
    expect(groups.map((group) => group.asset)).toEqual(['ETH', 'BTC', 'SOL']);
    const btc = groups[1];
    expect(btc?.combinations.map((row) => row.score)).toEqual([90, 80]);
    expect(btc?.best.score).toBe(90);
    // Group rank follows the best row's original relative position, not an alphabetical asset.
    expect(groups.map((group) => group.best.score)).toEqual([95, 90, 60]);
  });
});

describe('nullable statistics: every unavailable column renders an em dash', () => {
  const renderedNullables = [
    'meanSpreadBps', 'spreadVolatilityBps', 'skewness', 'excessKurtosis', 'halfLifeHours', 'holdingCostBps',
  ] as const;

  for (const field of renderedNullables) {
    it(`renders ${field}=null as a single em dash and nothing else`, () => {
      const html = renderTable([qualityRow({ [field]: null } as Partial<SpreadQualityRow>)]);
      expect(occurrences(html, '—')).toBe(1);
      expect(html).not.toContain('NaN');
      expect(html).not.toContain('null');
      expect(html).not.toContain('undefined');
      expect(html).not.toContain('Infinity');
      // No fake zero stands in for the missing statistic.
      expect(html).not.toContain('0.00');
      expect(html).not.toContain('>0<');
      // The remaining readings still render.
      expect(html).toContain('12.50');
      expect(html).toContain('63.5');
    });
  }

  it('renders all six nullable statistics as dashes together, with no NaN leaking anywhere', () => {
    const html = renderTable([qualityRow({
      meanSpreadBps: null, spreadVolatilityBps: null, skewness: null,
      excessKurtosis: null, ar1Coefficient: null, halfLifeHours: null, holdingCostBps: null,
    })]);
    expect(occurrences(html, '—')).toBe(6);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('null');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('Infinity');
    // A genuine zero mean spread is a value, not an absence — v1 must render it, not dash it.
    expect(renderTable([qualityRow({ meanSpreadBps: 0 })])).toContain('0.00');
  });

  it('never displays ar1Coefficient: null and a real value render identically', () => {
    const withNull = renderTable([qualityRow({ ar1Coefficient: null })]);
    const withValue = renderTable([qualityRow({ ar1Coefficient: 0.77 })]);
    expect(withNull).not.toContain('NaN');
    expect(withNull).not.toContain('0.77');
    expect(withNull).toBe(withValue);
  });

  it('dashes a null half-life inside the expanded combination table too', () => {
    const rows = [
      qualityRow({ asset: 'BTC', score: 90, halfLifeHours: null }),
      qualityRow({ asset: 'BTC', score: 70, leftSymbol: 'OKX_SPOT_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT', halfLifeHours: 4.5 }),
    ];
    const html = renderTable(rows, 'BTC');
    const detail = html.slice(html.indexOf('spread-quality-combination-table'));
    expect(occurrences(detail, '—')).toBe(1);
    expect(detail).toContain('4.5');
    expect(detail).not.toContain('NaN');
  });
});

describe('aria-pressed ban', () => {
  it('keeps aria-pressed out of the component source and of every render', () => {
    const source = readFileSync(new URL('./spread-quality-table.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('aria-pressed');

    const rows = [
      qualityRow({ score: 90 }),
      qualityRow({ asset: 'ETH', score: 50, leftSymbol: 'GATE_SPOT_ETH_USDT', rightSymbol: 'BINANCE_FUTURE_ETH_USDT' }),
    ];
    for (const html of [renderTable(rows, null), renderTable(rows, 'BTC')]) {
      expect(occurrences(html, 'aria-pressed')).toBe(0);
    }
  });
});

describe('controlled expansion', () => {
  const combos = [
    qualityRow({ asset: 'BTC', score: 90 }),
    qualityRow({ asset: 'BTC', score: 70, leftSymbol: 'OKX_SPOT_BTC_USDT', rightSymbol: 'BYBIT_FUTURE_BTC_USDT' }),
    qualityRow({ asset: 'BTC', score: 60, leftSymbol: 'GATE_SPOT_BTC_USDT', rightSymbol: 'OKX_FUTURE_BTC_USDT' }),
    qualityRow({ asset: 'ETH', score: 50, leftSymbol: 'GATE_SPOT_ETH_USDT', rightSymbol: 'BINANCE_FUTURE_ETH_USDT' }),
  ];

  it('mirrors the expandedAsset prop into aria-expanded, one toggle per asset', () => {
    const collapsed = renderTable(combos, null);
    expect([...collapsed.matchAll(/aria-expanded="(true|false)"/g)].map((match) => match[1]))
      .toEqual(['false', 'false']);
    expect(collapsed).not.toContain('spread-quality-combination-table');

    const expanded = renderTable(combos, 'BTC');
    expect([...expanded.matchAll(/aria-expanded="(true|false)"/g)].map((match) => match[1]))
      .toEqual(['true', 'false']);
    // Only the named asset opens: ETH stays a parent row.
    expect(occurrences(expanded, 'spread-quality-combination-table')).toBe(1);
  });

  it('lists every combination of the expanded asset, best first, mirroring the best into the parent row', () => {
    const html = renderTable(combos, 'BTC');
    // The parent row mirrors the best combination's legs; each combination repeats its own legs.
    expect(occurrences(html, 'GATE_SPOT_BTC_USDT')).toBe(3);
    expect(occurrences(html, 'BINANCE_FUTURE_BTC_USDT')).toBe(2);
    expect(occurrences(html, 'OKX_SPOT_BTC_USDT')).toBe(1);
    expect(occurrences(html, 'BYBIT_FUTURE_BTC_USDT')).toBe(1);
    expect(occurrences(html, 'OKX_FUTURE_BTC_USDT')).toBe(1);
    // Exactly one best tag, on the first combination row of the asset.
    expect(occurrences(html, 'best-tag')).toBe(1);
    // Combination order inside the detail table follows the payload (best first, no re-sort).
    const detail = html.slice(html.indexOf('spread-quality-combination-table'));
    expect(detail.indexOf('OKX_SPOT_BTC_USDT')).toBeLessThan(detail.indexOf('OKX_FUTURE_BTC_USDT'));
    expect(detail).toContain('90.0');
    expect(detail).toContain('70.0');
    expect(detail).toContain('60.0');
  });
});

describe('v1 table shape', () => {
  it('renders 13 plain header cells, no sorting affordance, and a matching detail colSpan', () => {
    const html = renderTable([qualityRow()]);
    expect([...html.matchAll(/<th[\s>]/g)]).toHaveLength(13);
    expect(html).not.toContain('aria-sort');
    const thead = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
    expect(thead).not.toContain('<button');
    // Rank numbering starts at 1.
    expect(html).toContain('class="mono">1</td>');
    // The expanded detail row spans exactly the header width (React serializes colSpan
    // case-preserved in static markup; HTML parsing lowercases it either way).
    expect(renderTable([qualityRow()], 'BTC')).toMatch(/colspan="13"/i);
  });

  it('renders deterministically: the same payload twice yields identical markup', () => {
    const rows = [
      qualityRow({ score: 90 }),
      qualityRow({ asset: 'ETH', score: 50, leftSymbol: 'GATE_SPOT_ETH_USDT', rightSymbol: 'BINANCE_FUTURE_ETH_USDT' }),
    ];
    expect(renderTable(rows, 'ETH')).toBe(renderTable(rows, 'ETH'));
  });
});

describe('api.spreadQuality client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const boardResponse = {
    rows: [qualityRow()],
    totalCandidates: 12,
    windowHours: 24,
    fetchedAt: '2026-10-07T00:00:00.000Z',
    cacheStatus: 'fresh',
  };

  function stubFetch(payload: unknown = boardResponse) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload)));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function calledUrl(fetchMock: ReturnType<typeof vi.fn>): URL {
    return new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://127.0.0.1');
  }

  it('hits the spread-quality endpoint with a clean query when no option is given', async () => {
    const fetchMock = stubFetch();
    await api.spreadQuality();
    const url = calledUrl(fetchMock);
    expect(url.pathname).toBe('/api/opportunities/spread-quality');
    expect([...url.searchParams.keys()]).toEqual([]);
  });

  it('sends refresh=1 when a forced refresh is requested', async () => {
    const fetchMock = stubFetch();
    await api.spreadQuality({ refresh: true });
    const url = calledUrl(fetchMock);
    expect(url.searchParams.get('refresh')).toBe('1');
    expect(url.searchParams.get('pairType')).toBeNull();
    expect(url.searchParams.get('limit')).toBeNull();
  });

  it('maps a non-default pairType into the query', async () => {
    const fetchMock = stubFetch();
    await api.spreadQuality({ pairType: 'SPOT_PERP' });
    expect(calledUrl(fetchMock).searchParams.get('pairType')).toBe('SPOT_PERP');
  });

  it('sends a non-default limit but omits the client default of 50', async () => {
    const fetchMock = stubFetch();
    await api.spreadQuality({ limit: 20 });
    expect(calledUrl(fetchMock).searchParams.get('limit')).toBe('20');

    const second = stubFetch();
    await api.spreadQuality({ limit: 50 });
    expect(calledUrl(second).searchParams.get('limit')).toBeNull();
  });

  it('carries pairType, limit and refresh together in one query', async () => {
    const fetchMock = stubFetch();
    await api.spreadQuality({ pairType: 'PERP_PERP', limit: 10, refresh: true });
    const url = calledUrl(fetchMock);
    expect(url.searchParams.get('pairType')).toBe('PERP_PERP');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('refresh')).toBe('1');
  });

  it('validates the payload through the shared schema before handing it to the UI', async () => {
    stubFetch();
    const response = await api.spreadQuality();
    expect(response.rows).toHaveLength(1);
    expect(response.rows[0]?.score).toBe(63.5);
    expect(response.totalCandidates).toBe(12);
  });

  it('rejects a contract-violating payload with invalid_backend_response', async () => {
    const missingScore = { ...boardResponse, rows: [{ ...qualityRow() }] };
    delete (missingScore.rows[0] as Partial<SpreadQualityRow>).score;
    stubFetch(missingScore);
    const failure = await api.spreadQuality().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('invalid_backend_response');

    // Deliberately contract-violating payload: a required non-nullable field arriving as null.
    const nullCurrent = { ...boardResponse, rows: [qualityRow({ currentSpreadBps: null } as unknown as Partial<SpreadQualityRow>)] };
    stubFetch(nullCurrent);
    const second = await api.spreadQuality().catch((error: unknown) => error);
    expect((second as ApiError).code).toBe('invalid_backend_response');
  });
});

describe('shared contract conformance', () => {
  it('accepts the test factory as a contract-valid row', () => {
    expect(SpreadQualityRowSchema.safeParse(qualityRow()).success).toBe(true);
  });

  it('accepts null in every nullable statistic and keeps the nulls', () => {
    const parsed = SpreadQualityRowSchema.parse(qualityRow({
      meanSpreadBps: null, spreadVolatilityBps: null, skewness: null,
      excessKurtosis: null, ar1Coefficient: null, halfLifeHours: null, holdingCostBps: null,
    }));
    expect(parsed.meanSpreadBps).toBeNull();
    expect(parsed.spreadVolatilityBps).toBeNull();
    expect(parsed.skewness).toBeNull();
    expect(parsed.excessKurtosis).toBeNull();
    expect(parsed.ar1Coefficient).toBeNull();
    expect(parsed.halfLifeHours).toBeNull();
    expect(parsed.holdingCostBps).toBeNull();
    // Required fields survive untouched.
    expect(parsed.score).toBe(63.5);
    expect(parsed.currentSpreadBps).toBe(12.5);
  });

  it('rejects a row that drops a required field', () => {
    const missingScore = { ...qualityRow() } as Partial<SpreadQualityRow>;
    delete missingScore.score;
    expect(SpreadQualityRowSchema.safeParse(missingScore).success).toBe(false);

    const missingSymmetric = { ...qualityRow() } as Partial<SpreadQualityRow>;
    delete missingSymmetric.symmetric;
    expect(SpreadQualityRowSchema.safeParse(missingSymmetric).success).toBe(false);
  });

  it('rejects NaN, Infinity and a negative half-life smuggled into the payload', () => {
    expect(SpreadQualityRowSchema.safeParse(qualityRow({ meanSpreadBps: NaN })).success).toBe(false);
    expect(SpreadQualityRowSchema.safeParse(qualityRow({ halfLifeHours: Infinity })).success).toBe(false);
    expect(SpreadQualityRowSchema.safeParse(qualityRow({ halfLifeHours: -1 })).success).toBe(false);
    expect(SpreadQualityRowSchema.safeParse(qualityRow({ currentSpreadBps: null } as unknown as Partial<SpreadQualityRow>)).success).toBe(false);
  });

  it('parses the board response and defaults the window to 24h', () => {
    const parsed = SpreadQualityResponseSchema.parse({
      rows: [], totalCandidates: 0, fetchedAt: '2026-10-07T00:00:00.000Z', cacheStatus: 'fresh',
    });
    expect(parsed.windowHours).toBe(24);
    expect(parsed.rows).toEqual([]);
    expect(SpreadQualityResponseSchema.safeParse({ rows: [] }).success).toBe(false);
  });
});
