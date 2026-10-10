import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StrategyRecord } from './api.js';
import type { StrategyLogCategory } from '@gate-crossex/shared-types';
import { StrategyExecutionLogDialog } from './strategy-route.js';
import type { DisplayStrategyLog } from './strategy-logs.js';
import { LanguageContext } from './i18n.js';

/**
 * There is no jsdom/@testing-library in this workspace, so the dialog's ARIA contract is asserted
 * from static markup: the category control is a real `role="tablist"`, and the modal must never
 * emit `aria-pressed` (that flag belongs to other boards and a project-wide SSR check rejects it).
 */
function strategy(): StrategyRecord {
  return {
    id: 'PREM-ABC12345',
    kind: 'position',
    status: 'RUNNING',
    accountProfileId: 'gate-crossex-default',
    accountLabel: 'Gate CrossEx',
    config: {
      kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
      leftSide: 'SELL', rightSide: 'BUY', entryBps: '10', totalAmount: '0.1',
      perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
    },
    progress: 0,
    filledQuantity: '0',
    filledLeft: '0',
    filledRight: '0',
    openPosition: '0',
    realizedPnl: '0',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:01:00.000Z',
    stoppedAt: null,
  };
}

function rows(count: number): DisplayStrategyLog[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `log-${index}`,
    level: 'info',
    event: 'Entry triggered',
    condition: 'Premium 35.20% ≥ 35.00%',
    quantity: '0.1 SKHY',
    result: 'Filled',
    createdAt: '2026-07-24T00:00:00.000Z',
    executionPremiumPct: null,
    executionSpreadBps: null,
  }));
}

function render(props: {
  rows: DisplayStrategyLog[];
  activeCategory?: StrategyLogCategory;
  hasMore?: boolean;
  loadState?: { status: 'idle' | 'loading' | 'loaded' | 'error'; message?: string };
  errorKind?: 'network' | 'timeout' | 'cancelled' | 'backend' | null;
}): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
      <StrategyExecutionLogDialog
        strategy={strategy()}
        rows={props.rows}
        loadState={props.loadState ?? { status: 'loaded' }}
        activeCategory={props.activeCategory ?? 'all'}
        onCategoryChange={vi.fn()}
        page={1}
        onPageChange={vi.fn()}
        hasMore={props.hasMore ?? false}
        loadingOlder={false}
        onLoadOlder={vi.fn()}
        errorKind={props.errorKind ?? null}
        onRetry={vi.fn()}
        onClose={vi.fn()}
        dialogRef={{ current: null }}
      />
    </LanguageContext.Provider>,
  );
}

describe('execution-log dialog category tabs', () => {
  it('renders the classification control as an ARIA tablist with exactly one selected tab', () => {
    const html = render({ rows: rows(3) });
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('class="strategy-log-tabs"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Execution log category"');
    expect([...html.matchAll(/role="tab"/g)]).toHaveLength(5);
    expect([...html.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
    expect([...html.matchAll(/aria-selected="false"/g)]).toHaveLength(4);
    // Labels come from the shared category table via `t` (identity in this stub).
    expect(html).toContain('Open / Close');
    expect(html).toContain('Maker &amp; hedge');
  });

  it('marks the active category tab as selected', () => {
    const html = render({ rows: rows(2), activeCategory: 'risk' });
    const selected = html.match(/<button[^>]*aria-selected="true"[^>]*>([^<]*)<\/button>/);
    expect(selected?.[1]).toBe('Take-profit &amp; risk');
  });

  it('never emits aria-pressed inside the log dialog', () => {
    const html = render({ rows: rows(4), activeCategory: 'maker' });
    expect([...html.matchAll(/aria-pressed=/g)]).toHaveLength(0);
  });
});

describe('execution-log dialog paging and states', () => {
  it('only shows the pager once the buffered rows exceed one page', () => {
    expect(render({ rows: rows(20) })).not.toContain('class="page-indicator"');
    expect(render({ rows: rows(60) })).toContain('class="page-indicator"');
  });

  it('renders the load-more control only while hasMore is set', () => {
    expect(render({ rows: rows(3), hasMore: false })).not.toContain('execution-log-load-more');
    expect(render({ rows: rows(3), hasMore: true })).toContain('Load older entries');
  });

  it('renders a retry alert for backend failures but stays silent for cancelled requests', () => {
    const failed = render({ rows: [], loadState: { status: 'error', message: 'boom' }, errorKind: 'network' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Could not reach the backend.');
    expect(failed).toContain('Try again');

    const cancelled = render({ rows: [], loadState: { status: 'error', message: 'aborted' }, errorKind: 'cancelled' });
    expect(cancelled).not.toContain('role="alert"');
  });
});
