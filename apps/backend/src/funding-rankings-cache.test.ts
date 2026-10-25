import { describe, expect, it } from 'vitest';
import { TtlSingleFlightCache } from './funding-rankings-cache.js';

describe('TtlSingleFlightCache', () => {
  it('reuses the cached value within the TTL window', async () => {
    let now = 1_000;
    const cache = new TtlSingleFlightCache<number>({ ttlMs: 500, now: () => now });
    let computations = 0;
    const compute = async (): Promise<number> => {
      computations += 1;
      return 42;
    };

    await expect(cache.run('k', compute)).resolves.toBe(42);
    await expect(cache.run('k', compute)).resolves.toBe(42);
    expect(computations).toBe(1);
    expect(cache.cacheSize()).toBe(1);

    now += 499;
    await expect(cache.run('k', compute)).resolves.toBe(42);
    expect(computations).toBe(1);

    now += 2;
    await expect(cache.run('k', compute)).resolves.toBe(42);
    expect(computations).toBe(2);
  });

  it('shares one in-flight computation between concurrent callers (single flight)', async () => {
    const cache = new TtlSingleFlightCache<string>({ ttlMs: 1_000, now: () => 0 });
    // Resolvers live in an array because a `let` variable assigned only inside the compute
    // callback stays narrowed to `null` for TypeScript's control-flow analysis.
    const resolvers: Array<(value: string) => void> = [];
    let computations = 0;
    const compute = (): Promise<string> => new Promise((resolvePromise) => {
      computations += 1;
      resolvers.push(resolvePromise);
    });

    const first = cache.run('k', compute);
    const second = cache.run('k', compute);
    const third = cache.run('k', compute);
    resolvers[0]?.('shared');
    await expect(first).resolves.toBe('shared');
    await expect(second).resolves.toBe('shared');
    await expect(third).resolves.toBe('shared');
    expect(computations).toBe(1);
  });

  it('never caches a failed computation so the next request can succeed', async () => {
    const cache = new TtlSingleFlightCache<number>({ ttlMs: 10_000, now: () => 0 });
    const compute = async (): Promise<number> => {
      throw new Error('upstream down');
    };
    await expect(cache.run('k', compute)).rejects.toThrow('upstream down');
    expect(cache.cacheSize()).toBe(0);
    await expect(cache.run('k', async () => 7)).resolves.toBe(7);
    expect(cache.cacheSize()).toBe(1);
  });

  it('different keys compute independently and evict expired entries first', async () => {
    const now = 0;
    const cache = new TtlSingleFlightCache<number>({ ttlMs: 100, maxEntries: 2, now: () => now });
    const counters = { a: 0, b: 0, c: 0 };
    const computeFor = (key: keyof typeof counters) => async (): Promise<number> => {
      counters[key] += 1;
      return counters[key];
    };

    await expect(cache.run('a', computeFor('a'))).resolves.toBe(1);
    await expect(cache.run('b', computeFor('b'))).resolves.toBe(1);
    await expect(cache.run('a', computeFor('a'))).resolves.toBe(1);
    await expect(cache.run('c', computeFor('c'))).resolves.toBe(1);
    expect(cache.cacheSize()).toBe(2);

    // `b` was touched least recently inside the same window — LRU keeps hot keys alive.
    await expect(cache.run('a', computeFor('a'))).resolves.toBe(1);
    expect(cache.cacheSize()).toBe(2);
    await expect(cache.run('b', computeFor('b'))).resolves.toBe(2);
  });

  it('invalidate drops every entry immediately', async () => {
    const now = 0;
    const cache = new TtlSingleFlightCache<number>({ ttlMs: 10_000, now: () => now });
    let computations = 0;
    const compute = async (): Promise<number> => {
      computations += 1;
      return computations;
    };
    await cache.run('k', compute);
    cache.invalidate();
    expect(cache.cacheSize()).toBe(0);
    await expect(cache.run('k', compute)).resolves.toBe(2);
  });
});
