import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpportunityResponse } from '@gate-crossex/shared-types';
import { api } from './api.js';
import {
  clearOpportunityCache,
  loadOpportunityBoard,
  opportunityRequestKey,
  type OpportunityRequest,
} from './opportunity-route.js';

/**
 * The board cache is what keeps re-opening the opportunities page from re-pairing every market
 * server side. These tests drive it directly — no DOM — through the same entry point the view uses.
 */
const EPOCH = '2026-08-01T00:00:00.000Z';

function board(): OpportunityResponse {
  return {
    funding: [], spread: [], totals: { funding: 0, spread: 0 },
    offset: 0, limit: 50, fetchedAt: EPOCH, cacheStatus: 'fresh',
  };
}

const REQUEST: OpportunityRequest = { funding: true, spread: false, pageSize: 50, offset: 0 };

describe('opportunity board request cache', () => {
  beforeEach(() => {
    clearOpportunityCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearOpportunityCache();
  });

  it('serves repeated requests without another round trip', async () => {
    const spy = vi.spyOn(api, 'opportunities').mockResolvedValue(board());

    await loadOpportunityBoard(REQUEST);
    await loadOpportunityBoard(REQUEST);
    await loadOpportunityBoard(REQUEST);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refreshes after the 30s window and stays superseded before it', async () => {
    const spy = vi.spyOn(api, 'opportunities').mockResolvedValue(board());

    await loadOpportunityBoard(REQUEST);
    vi.advanceTimersByTime(29_000);
    await loadOpportunityBoard(REQUEST);
    expect(spy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await loadOpportunityBoard(REQUEST);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent identical requests into one call', async () => {
    let resolveOpportunities!: (value: OpportunityResponse) => void;
    const gate = new Promise<OpportunityResponse>((resolve) => { resolveOpportunities = resolve; });
    const spy = vi.spyOn(api, 'opportunities').mockImplementation(() => gate);

    const pending = Promise.all([
      loadOpportunityBoard(REQUEST),
      loadOpportunityBoard(REQUEST),
      loadOpportunityBoard(REQUEST),
    ]);
    // Released only after all three callers reached the cache, which is what proves single-flight.
    resolveOpportunities(board());
    await pending;

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('pages separately, so flipping pages does not serve the wrong slice', async () => {
    const spy = vi.spyOn(api, 'opportunities').mockResolvedValue(board());

    await loadOpportunityBoard({ ...REQUEST, offset: 0 });
    await loadOpportunityBoard({ ...REQUEST, offset: 50 });
    await loadOpportunityBoard({ ...REQUEST, offset: 50 });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((call) => (call[0] as OpportunityRequest).offset)).toEqual([0, 50]);
  });

  it('treats reordered categorical filters as one query', async () => {
    const spy = vi.spyOn(api, 'opportunities').mockResolvedValue(board());

    await loadOpportunityBoard({ funding: false, spread: true, venues: ['GATE', 'OKX'] });
    await loadOpportunityBoard({ funding: false, spread: true, venues: ['OKX', 'GATE'] });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('always refetches when the refresh button forces it', async () => {
    const spy = vi.spyOn(api, 'opportunities').mockResolvedValue(board());

    await loadOpportunityBoard(REQUEST);
    await loadOpportunityBoard(REQUEST, true);
    // The forced request replaces the cached one, so the very next ordinary call reuses it.
    await loadOpportunityBoard(REQUEST);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[0]).toMatchObject({ refresh: true });
  });

  it('retries immediately after a failure instead of caching it', async () => {
    const spy = vi.spyOn(api, 'opportunities')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(board());

    await expect(loadOpportunityBoard(REQUEST)).rejects.toThrow('network down');
    await expect(loadOpportunityBoard(REQUEST)).resolves.toMatchObject({ cacheStatus: 'fresh' });

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keys include every parameter that changes the returned rows', () => {
    expect(opportunityRequestKey({ ...REQUEST, asset: 'btc' }))
      .toBe(opportunityRequestKey({ ...REQUEST, asset: 'BTC' }));
    expect(opportunityRequestKey({ ...REQUEST, minApr: 5 }))
      .not.toBe(opportunityRequestKey({ ...REQUEST, minApr: 6 }));
    expect(opportunityRequestKey({ ...REQUEST, sort: 'apr', dir: 'asc' }))
      .not.toBe(opportunityRequestKey({ ...REQUEST, sort: 'apr', dir: 'desc' }));
    expect(opportunityRequestKey({ ...REQUEST, preIpo: 'only' }))
      .not.toBe(opportunityRequestKey({ ...REQUEST, preIpo: 'exclude' }));
  });
});
