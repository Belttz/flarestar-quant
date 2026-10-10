/**
 * QA boundary tests for the client-side opportunity board cache.
 *
 * The author's own cases cover the happy path (hit, expiry, single-flight, paging). What decides
 * whether this change is safe in production are the edges: the strictness of the freshness window,
 * whether a *forced* failure can poison the cache, and whether the cache key really spans every
 * parameter that changes the returned rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpportunityResponse } from '@gate-crossex/shared-types';
import { api } from './api.js';
import {
  clearOpportunityCache,
  loadOpportunityBoard,
  opportunityRequestKey,
  type OpportunityRequest,
} from './opportunity-route.js';

const EPOCH = '2026-08-01T00:00:00.000Z';

function board(cacheStatus: OpportunityResponse['cacheStatus'] = 'fresh'): OpportunityResponse {
  return {
    funding: [], spread: [], totals: { funding: 0, spread: 0 },
    offset: 0, limit: 50, fetchedAt: EPOCH, cacheStatus,
  };
}

const REQUEST: OpportunityRequest = { funding: true, spread: false, pageSize: 50, offset: 0 };

describe('QA opportunity board cache boundaries', () => {
  beforeEach(() => {
    clearOpportunityCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearOpportunityCache();
  });

  it('treats the freshness window as half-open: cached at 29_999, stale at exactly 30_000', async () => {
    const spy = vi.spyOn(api, 'opportunities').mockResolvedValue(board());

    await loadOpportunityBoard(REQUEST);
    vi.advanceTimersByTime(29_999);
    await loadOpportunityBoard(REQUEST);
    expect(spy).toHaveBeenCalledTimes(1);

    // The millisecond boundary matters: the UI promises a board no older than 30s, so an entry must
    // not outlive its window even by one tick.
    vi.advanceTimersByTime(1);
    await loadOpportunityBoard(REQUEST);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries immediately after a *forced* request fails', async () => {
    // The Refresh button is exactly when a failure is most visible to a user, so a forced request
    // must not leave a rejected promise behind for the rest of the window.
    const spy = vi.spyOn(api, 'opportunities')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(board());

    await expect(loadOpportunityBoard(REQUEST, true)).rejects.toThrow('network down');
    await expect(loadOpportunityBoard(REQUEST)).resolves.toMatchObject({ cacheStatus: 'fresh' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not replay a failed promise to a second caller waiting on the same entry', async () => {
    let reject!: (error: Error) => void;
    const spy = vi.spyOn(api, 'opportunities').mockImplementation(() =>
      new Promise<OpportunityResponse>((_, rejectPromise) => { reject = rejectPromise; }));

    const first = loadOpportunityBoard(REQUEST);
    const second = loadOpportunityBoard(REQUEST);
    reject(new Error('gateway timeout'));
    await expect(first).rejects.toThrow('gateway timeout');
    await expect(second).rejects.toThrow('gateway timeout');

    spy.mockResolvedValue(board());
    await expect(loadOpportunityBoard(REQUEST)).resolves.toMatchObject({ cacheStatus: 'fresh' });
  });

  it('shares the in-flight promise of a forced request with an ordinary caller', async () => {
    let resolve!: (value: OpportunityResponse) => void;
    const spy = vi.spyOn(api, 'opportunities').mockImplementation(() =>
      new Promise<OpportunityResponse>((resolvePromise) => { resolve = resolvePromise; }));

    const forced = loadOpportunityBoard(REQUEST, true);
    // The soft-refresh timer can land inside that window; it must join rather than double-fetch.
    const ordinary = loadOpportunityBoard(REQUEST);
    resolve(board());
    await Promise.all([forced, ordinary]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ refresh: true });
  });

  it('empties the cache through its public seam', async () => {
    const spy = vi.spyOn(api, 'opportunities').mockResolvedValue(board());
    await loadOpportunityBoard(REQUEST);
    await loadOpportunityBoard(REQUEST);
    expect(spy).toHaveBeenCalledTimes(1);

    clearOpportunityCache();
    await loadOpportunityBoard(REQUEST);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keys every parameter the backend varies rows by', () => {
    const base = opportunityRequestKey(REQUEST);
    const variations: OpportunityRequest[] = [
      { ...REQUEST, funding: false, spread: true },
      { ...REQUEST, minApr: 1 },
      { ...REQUEST, minBps: 1 },
      { ...REQUEST, asset: 'BTC' },
      { ...REQUEST, expand: true },
      { ...REQUEST, venues: ['GATE'] },
      { ...REQUEST, markets: ['spot'] },
      { ...REQUEST, assetClass: ['COIN'] },
      { ...REQUEST, assetSuperClass: ['RWA'] },
      { ...REQUEST, preIpo: 'only' },
      { ...REQUEST, sort: 'volume' },
      { ...REQUEST, dir: 'asc' },
      { ...REQUEST, offset: 50 },
      { ...REQUEST, pageSize: 100 },
      { ...REQUEST, limit: 25 },
    ];
    expect(variations.length).toBeGreaterThan(0);
    for (const variation of variations) {
      expect(opportunityRequestKey(variation), JSON.stringify(variation)).not.toBe(base);
    }
  });

  it('ignores ordering within every categorical list and the refresh transport flag', () => {
    expect(opportunityRequestKey({ ...REQUEST, markets: ['spot', 'perp'] }))
      .toBe(opportunityRequestKey({ ...REQUEST, markets: ['perp', 'spot'] }));
    expect(opportunityRequestKey({ ...REQUEST, assetClass: ['COIN', 'STOCK'] }))
      .toBe(opportunityRequestKey({ ...REQUEST, assetClass: ['STOCK', 'COIN'] }));
    expect(opportunityRequestKey({ ...REQUEST, assetSuperClass: ['RWA', 'CRYPTO'] }))
      .toBe(opportunityRequestKey({ ...REQUEST, assetSuperClass: ['CRYPTO', 'RWA'] }));
    // `refresh` tells the server how to answer; it is not part of what the answer *is*.
    expect(opportunityRequestKey({ ...REQUEST, refresh: true })).toBe(opportunityRequestKey(REQUEST));
  });

  it('does not confuse an absent value with a zero threshold', () => {
    expect(opportunityRequestKey({ ...REQUEST, minApr: 0 }))
      .not.toBe(opportunityRequestKey({ ...REQUEST, minApr: undefined }));
    expect(opportunityRequestKey({ ...REQUEST, minBps: 0 }))
      .not.toBe(opportunityRequestKey({ ...REQUEST, minBps: undefined }));
  });

  it('fetches each page exactly once while a session walks the pager', async () => {
    const spy = vi.spyOn(api, 'opportunities').mockResolvedValue(board());
    for (let page = 0; page < 80; page += 1) {
      await loadOpportunityBoard({ ...REQUEST, offset: page * 50 });
    }
    const offsets = spy.mock.calls.map((call) => (call[0] as OpportunityRequest).offset);
    expect(offsets).toHaveLength(80);
    // Every page was computed once — no thrash, no repeated fetch of the same slice.
    expect(new Set(offsets).size).toBe(80);
  });

  it('recycles the least recently used page once capacity is exceeded', async () => {
    const spy = vi.spyOn(api, 'opportunities').mockResolvedValue(board());
    // Capacity is 32 entries, so walking further back than that must recycle rather than grow.
    for (let page = 0; page < 34; page += 1) {
      await loadOpportunityBoard({ ...REQUEST, offset: page * 50 });
    }
    await loadOpportunityBoard({ ...REQUEST, offset: 33 * 50 });
    expect(spy).toHaveBeenCalledTimes(34);
    // The first page has aged out and is re-requested; the newest page is still a cache hit.
    await loadOpportunityBoard({ ...REQUEST, offset: 0 });
    expect(spy).toHaveBeenCalledTimes(35);
    await loadOpportunityBoard({ ...REQUEST, offset: 33 * 50 });
    expect(spy).toHaveBeenCalledTimes(35);
  });
});
