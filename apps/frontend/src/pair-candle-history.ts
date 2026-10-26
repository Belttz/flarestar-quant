import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Candle, type CandleInterval, type CandleSeriesResponse } from './api.js';
import { mergeCandleHistory } from './premium-history.js';

/** Per-leg provenance of the last completed request, kept so the UI can explain an empty chart. */
export interface PairCandleLegMeta {
  /** Backend `source` string, e.g. `venue_public_rest_and_crossex_websocket`. */
  source: string | null;
  /** Backend `building` flag: fewer than 30 candles were servable when the request ran. */
  building: boolean;
  hasMore: boolean;
  /** True when the last completed request came back with no candles at all. */
  empty: boolean;
  /** Set when the request itself failed (network/HTTP), as opposed to returning an empty page. */
  failed: boolean;
}

const EMPTY_LEG_META: PairCandleLegMeta = { source: null, building: false, hasMore: true, empty: true, failed: false };

export interface PairCandleHistory {
  key: string;
  left: Candle[];
  right: Candle[];
  status: 'loading' | 'live' | 'failed';
  leftMeta: PairCandleLegMeta;
  rightMeta: PairCandleLegMeta;
  /** How many fetch rounds have completed for this key (drives "still collecting" hints). */
  completedRounds: number;
}

interface PairCandleHistoryState extends PairCandleHistory {
  leftHasMore: boolean;
  rightHasMore: boolean;
}

/**
 * Extra fetch rounds fired shortly after an empty page. The candles route serves cached rows
 * immediately and refreshes the venue page in the background, so a cold key legitimately answers
 * `candles: []` on the first call and has data seconds later. Waiting for the regular poll
 * (30s/60s) is what made the price-difference chart look permanently empty.
 */
const EMPTY_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 12_000];

function legMetaFrom(response: CandleSeriesResponse | null, failed: boolean): PairCandleLegMeta {
  if (response === null) return { ...EMPTY_LEG_META, failed };
  return {
    source: response.source ?? null,
    building: response.building === true,
    hasMore: response.hasMore === true,
    empty: response.candles.length === 0,
    failed: false,
  };
}

/**
 * Loads and paginates aligned candle inputs for a two-market derived chart.
 *
 * Beyond fetching, this hook owns the *state* of the fetch so callers can tell three cases apart:
 * still loading, a leg with no history at all, and an empty overlap between two real series. It
 * also retries a few times shortly after an empty page (see `EMPTY_RETRY_DELAYS_MS`) and exposes
 * `reload()` for an explicit user retry.
 */
export function usePairCandleHistory(
  leftSymbol: string,
  rightSymbol: string,
  interval: CandleInterval,
  enabled: boolean,
): PairCandleHistory & { loadOlder: () => void; reload: () => void } {
  const key = `${leftSymbol}:${rightSymbol}:${interval}`;
  const [reloadToken, setReloadToken] = useState(0);
  const [history, setHistory] = useState<PairCandleHistoryState>({
    key: '',
    left: [],
    right: [],
    leftHasMore: true,
    rightHasMore: true,
    status: 'loading',
    leftMeta: EMPTY_LEG_META,
    rightMeta: EMPTY_LEG_META,
    completedRounds: 0,
  });
  const loadingRef = useRef<Set<string>>(new Set());
  const requestedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    setHistory((current) => current.key === key
      ? { ...current, status: current.left.length > 0 && current.right.length > 0 ? 'live' : 'loading' }
      : {
        key,
        left: [],
        right: [],
        leftHasMore: true,
        rightHasMore: true,
        status: 'loading',
        leftMeta: EMPTY_LEG_META,
        rightMeta: EMPTY_LEG_META,
        completedRounds: 0,
      });

    const retryTimers: number[] = [];
    const clearRetries = () => { for (const timer of retryTimers.splice(0)) window.clearTimeout(timer); };

    const load = async (): Promise<{ leftEmpty: boolean; rightEmpty: boolean }> => {
      if (inFlight) return { leftEmpty: false, rightEmpty: false };
      inFlight = true;
      const [leftResult, rightResult] = await Promise.allSettled([
        api.candles(leftSymbol, interval, { limit: 300 }),
        api.candles(rightSymbol, interval, { limit: 300 }),
      ]);
      const leftResponse = leftResult.status === 'fulfilled' ? leftResult.value : null;
      const rightResponse = rightResult.status === 'fulfilled' ? rightResult.value : null;
      if (!cancelled) setHistory((current) => {
        if (current.key !== key) return current;
        const left = leftResponse ? mergeCandleHistory(current.left, leftResponse.candles) : current.left;
        const right = rightResponse ? mergeCandleHistory(current.right, rightResponse.candles) : current.right;
        const leftMeta = legMetaFrom(leftResponse, leftResult.status === 'rejected');
        const rightMeta = legMetaFrom(rightResponse, rightResult.status === 'rejected');
        return {
          key,
          left,
          right,
          leftHasMore: leftResponse?.hasMore ?? current.leftHasMore,
          rightHasMore: rightResponse?.hasMore ?? current.rightHasMore,
          // `failed` only when a request actually rejected. An empty page is a *result*: the leg
          // may simply have no venue history, which the caller reports separately.
          status: left.length > 0 && right.length > 0
            ? 'live'
            : leftResult.status === 'rejected' || rightResult.status === 'rejected' ? 'failed' : 'live',
          // A leg that already has candles stays non-empty even if this round failed, because the
          // merged series is what the chart draws.
          leftMeta: { ...leftMeta, empty: left.length === 0 ? leftMeta.empty : false },
          rightMeta: { ...rightMeta, empty: right.length === 0 ? rightMeta.empty : false },
          completedRounds: current.completedRounds + 1,
        };
      });
      inFlight = false;
      return { leftEmpty: (leftResponse?.candles.length ?? 0) === 0, rightEmpty: (rightResponse?.candles.length ?? 0) === 0 };
    };

    const loadWithRetries = async () => {
      const first = await load();
      if (cancelled || (!first.leftEmpty && !first.rightEmpty)) return;
      // One leg came back empty: the backend refreshes that venue page in the background, so a
      // couple of extra rounds usually land the missing half instead of leaving the chart blank
      // until the next regular poll. Each round re-checks both legs, so a leg that filled in the
      // meantime simply keeps the schedule going without extra traffic beyond `load()`'s guard.
      for (const delay of EMPTY_RETRY_DELAYS_MS) {
        retryTimers.push(window.setTimeout(() => {
          if (cancelled) return;
          void load();
        }, delay));
      }
    };

    void loadWithRetries();
    const timer = window.setInterval(() => void load(), interval === '1m' ? 30_000 : 60_000);
    return () => {
      cancelled = true;
      clearRetries();
      window.clearInterval(timer);
    };
  }, [enabled, interval, key, leftSymbol, reloadToken, rightSymbol]);

  const loadOlder = useCallback(() => {
    if (!enabled || history.key !== key || loadingRef.current.has(key)) return;
    const oldestLeft = history.left[0];
    const oldestRight = history.right[0];
    const loadLeft = history.leftHasMore && oldestLeft !== undefined;
    const loadRight = history.rightHasMore && oldestRight !== undefined;
    if (!loadLeft && !loadRight) return;
    const requestKey = `${key}:${loadLeft ? oldestLeft.startTime : 'done'}:${loadRight ? oldestRight.startTime : 'done'}`;
    if (requestedRef.current.has(requestKey)) return;
    loadingRef.current.add(key);
    requestedRef.current.add(requestKey);

    void Promise.allSettled([
      loadLeft ? api.candles(leftSymbol, interval, { before: oldestLeft.startTime, limit: 300 }) : null,
      loadRight ? api.candles(rightSymbol, interval, { before: oldestRight.startTime, limit: 300 }) : null,
    ]).then(([leftResult, rightResult]) => {
      const leftResponse = leftResult.status === 'fulfilled' ? leftResult.value : null;
      const rightResponse = rightResult.status === 'fulfilled' ? rightResult.value : null;
      setHistory((current) => current.key === key ? {
        ...current,
        left: leftResponse ? mergeCandleHistory(current.left, leftResponse.candles) : current.left,
        right: rightResponse ? mergeCandleHistory(current.right, rightResponse.candles) : current.right,
        leftHasMore: leftResponse ? leftResponse.candles.length > 0 && leftResponse.hasMore : current.leftHasMore,
        rightHasMore: rightResponse ? rightResponse.candles.length > 0 && rightResponse.hasMore : current.rightHasMore,
      } : current);
      if (leftResult.status === 'rejected' || rightResult.status === 'rejected') {
        requestedRef.current.delete(requestKey);
      }
    }).finally(() => {
      loadingRef.current.delete(key);
    });
  }, [enabled, history, interval, key, leftSymbol, rightSymbol]);

  /** Force one extra fetch round now — the retry affordance next to the chart placeholder. */
  const reload = useCallback(() => {
    requestedRef.current.clear();
    setReloadToken((current) => current + 1);
  }, []);

  return {
    key: history.key,
    left: history.left,
    right: history.right,
    status: history.status,
    leftMeta: history.leftMeta,
    rightMeta: history.rightMeta,
    completedRounds: history.completedRounds,
    loadOlder,
    reload,
  };
}
