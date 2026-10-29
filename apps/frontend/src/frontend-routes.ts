export type StrategyRouteKind = 'position' | 'auto' | 'premium' | 'carry' | 'boros' | 'us-stock';

/**
 * Which Opportunities board a route opens: the cross-exchange spread ranking, the funding hedge
 * board, the single-venue funding-rate extremes ranking, and the spread-quality ranking (24h
 * distribution statistics per asset/venue pair).
 */
export type OpportunityBoard = 'funding' | 'funding-top' | 'spread' | 'spread-quality';

/** Query parameters appended to a page path (one-click prefill, architecture §4.2). */
export type FrontendQuery = Record<string, string>;

export type FrontendRoute =
  | { workspace: 'Trade' }
  | { workspace: 'Strategy'; strategyKind: StrategyRouteKind; query?: FrontendQuery | null }
  | { workspace: 'Funding Rates'; asset: string | null }
  | { workspace: 'Portfolio' }
  | { workspace: 'Trading Fees' }
  | { workspace: 'Opportunities'; board: OpportunityBoard; query?: FrontendQuery | null };

export const DEFAULT_FRONTEND_ROUTE: FrontendRoute = { workspace: 'Trade' };

const STRATEGY_PATHS: Record<StrategyRouteKind, string> = {
  position: '/strategies/paired-position',
  auto: '/strategies/price-difference',
  premium: '/strategies/sk-hynix-premium',
  carry: '/strategies/spot-perp-carry',
  boros: '/strategies/boros',
  // 美股价差溢价套利: custom cross-asset pairs (SNDK vs SNXX and friends).
  'us-stock': '/strategies/us-stock-spread',
};

const OPPORTUNITY_BOARD_PATHS: Record<OpportunityBoard, string> = {
  funding: '/opportunities/funding',
  'funding-top': '/opportunities/funding-top',
  spread: '/opportunities/spread',
  'spread-quality': '/opportunities/spread-quality',
};

/** Append prefill query parameters to a path; empty or absent queries leave the path untouched. */
function withQuery(path: string, query: FrontendQuery | null | undefined): string {
  const entries = Object.entries(query ?? {});
  if (entries.length === 0) return path;
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.set(key, value);
  return `${path}?${params.toString()}`;
}

/**
 * A same-path navigation can still change the prefill: clicking 复制 on the page you are already
 * standing on keeps the pathname but replaces the query with `copyStrategyId`. `history.pushState`
 * must run for that case too, otherwise the strategy form's mount initializers read the old
 * `window.location.search` and the copy silently does nothing.
 */
export function historyNeedsUpdate(currentPathAndSearch: string, nextPath: string): boolean {
  return currentPathAndSearch !== nextPath;
}

/** Convert an application page into its canonical, reload-safe browser path. */
export function frontendPath(route: FrontendRoute): string {
  if (route.workspace === 'Trade') return '/';
  if (route.workspace === 'Strategy') return withQuery(STRATEGY_PATHS[route.strategyKind], route.query);
  if (route.workspace === 'Portfolio') return '/portfolio';
  if (route.workspace === 'Trading Fees') return '/tools/trading-fees';
  if (route.workspace === 'Opportunities') return withQuery(OPPORTUNITY_BOARD_PATHS[route.board], route.query);
  return route.asset ? `/funding-rates/${encodeURIComponent(route.asset)}` : '/funding-rates';
}

/** Resolve only known frontend paths; API and secure backend paths must never become app pages. */
export function frontendRoute(pathname: string): FrontendRoute | null {
  // Query strings are a one-shot prefill channel for the mounted page; route resolution matches
  // the path only so a stale query never changes which workspace opens.
  const rawPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const path = rawPath.split('?')[0] || rawPath;
  if (path === '/') return DEFAULT_FRONTEND_ROUTE;
  if (path === '/portfolio') return { workspace: 'Portfolio' };
  if (path === '/tools/trading-fees') return { workspace: 'Trading Fees' };
  // The legacy /opportunities path resolves to the funding board; App canonicalizes the URL.
  if (path === '/opportunities' || path === '/opportunities/funding') {
    return { workspace: 'Opportunities', board: 'funding' };
  }
  if (path === '/opportunities/spread') return { workspace: 'Opportunities', board: 'spread' };
  if (path === '/opportunities/spread-quality') return { workspace: 'Opportunities', board: 'spread-quality' };
  if (path === '/opportunities/funding-top') return { workspace: 'Opportunities', board: 'funding-top' };
  if (path === '/funding-rates') return { workspace: 'Funding Rates', asset: null };

  const strategyKind = (Object.entries(STRATEGY_PATHS) as Array<[StrategyRouteKind, string]>)
    .find(([, strategyPath]) => strategyPath === path)?.[0];
  if (strategyKind) return { workspace: 'Strategy', strategyKind };

  const fundingMatch = /^\/funding-rates\/([^/]+)$/.exec(path);
  if (!fundingMatch?.[1]) return null;
  try {
    const asset = decodeURIComponent(fundingMatch[1]).trim().toUpperCase();
    return asset && /^[A-Z0-9]+$/.test(asset) ? { workspace: 'Funding Rates', asset } : null;
  } catch {
    return null;
  }
}
