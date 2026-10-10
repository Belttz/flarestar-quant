import { useLanguage } from './i18n.js';

export interface StrategyLogLoadMoreProps {
  /** Whether the backend reported more (older) rows past the newest loaded page. */
  hasMore: boolean;
  /** A continuation fetch is in flight; the button stays visible but disabled. */
  loading: boolean;
  onLoad: () => void;
}

/**
 * Fetches the next (older) keyset page of the execution log. The parent owns hasMore/loading and
 * the fetch itself, so this stays a dumb, testable control. It renders nothing once the backend
 * reports the end of the log, which also hides the control's footer row.
 */
export function StrategyLogLoadMore({ hasMore, loading, onLoad }: StrategyLogLoadMoreProps) {
  const { t } = useLanguage();
  return <StrategyLogLoadMoreView
    hasMore={hasMore}
    loading={loading}
    onLoad={onLoad}
    loadLabel={t('Load older entries')}
    loadingLabel={t('Loading older entries…')}
  />;
}

/**
 * Pure view with no hooks, so a server-render test can read the wired `onClick` off the returned
 * element (this workspace has no jsdom, so click behaviour is asserted through the element props).
 */
export function StrategyLogLoadMoreView({ hasMore, loading, onLoad, loadLabel, loadingLabel }: {
  hasMore: boolean;
  loading: boolean;
  onLoad: () => void;
  loadLabel: string;
  loadingLabel: string;
}) {
  if (!hasMore) return null;
  return <div className="execution-log-load-more">
    <button type="button" disabled={loading} onClick={onLoad}>{loading ? loadingLabel : loadLabel}</button>
  </div>;
}
