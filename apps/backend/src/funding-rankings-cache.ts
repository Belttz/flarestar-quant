/**
 * TTL + single-flight cache for the heavy funding endpoints (`funding-rankings`,
 * `funding-history/series`) — the same shape as the opportunity board's and funding-overview's
 * caches (R5): one upstream computation per distinct parameter set per TTL window, concurrent
 * callers sharing the in-flight promise, and failures never cached.
 */
export class TtlSingleFlightCache<T> {
  private readonly entries = new Map<string, { key: string; expiresAt: number; promise: Promise<T> }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { ttlMs: number; maxEntries?: number; now?: () => number }) {
    this.ttlMs = Math.max(0, options.ttlMs);
    this.maxEntries = Math.max(1, options.maxEntries ?? 32);
    this.now = options.now ?? Date.now;
  }

  /**
   * Answer `key` from the cache when it is inside its TTL, otherwise run `compute` once —
   * concurrent callers for the same key await the same promise. A rejected computation is
   * dropped immediately so the next request can succeed. When `cacheable` is provided and
   * returns false for a computed value, the value is answered but not stored — used for
   * snapshots of mutable state (e.g. a cold `pending` ranking) that must not outlive the
   * state change that invalidates them.
   */
  async run(
    key: string,
    compute: () => Promise<T>,
    options?: { cacheable?: (value: T) => boolean },
  ): Promise<T> {
    const current = this.entries.get(key);
    if (current && current.expiresAt > this.now()) {
      // Touch: reinsertion keeps the entry newest, so hot keys are never evicted mid-flight.
      this.entries.delete(key);
      this.entries.set(key, current);
      return await current.promise;
    }
    const promise = compute();
    this.entries.set(key, { key, expiresAt: this.now() + this.ttlMs, promise });
    this.trim(key);
    try {
      const value = await promise;
      if (options?.cacheable && !options.cacheable(value)) {
        const entry = this.entries.get(key);
        if (entry?.promise === promise) this.entries.delete(key);
      }
      return value;
    } catch (error) {
      // Never cache a failure: the next request must be able to succeed.
      const entry = this.entries.get(key);
      if (entry?.promise === promise) this.entries.delete(key);
      throw error;
    }
  }

  /** Live cache-entry count; a test seam that also lets operators confirm reuse. */
  cacheSize(): number {
    return this.entries.size;
  }

  /** Drop every cached entry — used by `refresh=1` style forced refreshes. */
  invalidate(): void {
    this.entries.clear();
  }

  /** Age out expired entries first, then the least recently touched one. */
  private trim(justAddedKey: string): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (key !== justAddedKey && entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}
