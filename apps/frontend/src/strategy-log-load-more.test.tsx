import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { StrategyLogLoadMore, StrategyLogLoadMoreView } from './strategy-log-load-more.js';
import { LanguageContext } from './i18n.js';

function render(props: { hasMore: boolean; loading: boolean; onLoad: () => void }): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
      <StrategyLogLoadMore {...props} />
    </LanguageContext.Provider>,
  );
}

describe('StrategyLogLoadMore', () => {
  it('renders nothing once the backend reported the end of the log', () => {
    expect(render({ hasMore: false, loading: false, onLoad: vi.fn() })).toBe('');
  });

  it('renders the control while older entries remain', () => {
    const html = render({ hasMore: true, loading: false, onLoad: vi.fn() });
    expect(html).toContain('execution-log-load-more');
    expect(html).toContain('Load older entries');
    expect(html).not.toContain('disabled');
  });

  it('shows the loading label and disables the button while a continuation is in flight', () => {
    const html = render({ hasMore: true, loading: true, onLoad: vi.fn() });
    expect(html).toContain('Loading older entries…');
    expect(html).toContain('disabled');
  });

  it('wires the button click straight to the continuation callback', () => {
    const onLoad = vi.fn();
    // The view has no hooks, so it can be invoked directly and its onClick read off the element.
    const view = StrategyLogLoadMoreView({
      hasMore: true, loading: false, onLoad, loadLabel: 'Load older entries', loadingLabel: 'Loading older entries…',
    }) as ReactElement<{ children: ReactElement<{ onClick: () => void }> }>;
    view.props.children.props.onClick();
    expect(onLoad).toHaveBeenCalledTimes(1);
  });
});
