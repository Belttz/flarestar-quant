import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionPagination } from './execution-pagination-control.js';
import { LanguageContext } from './i18n.js';

function render(itemCount: number): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
      <ExecutionPagination itemCount={itemCount} page={1} onPageChange={vi.fn()} />
    </LanguageContext.Provider>,
  );
}

describe('ExecutionPagination', () => {
  it('hides the current page and controls when there are fewer than ten rows', () => {
    expect(render(0)).toBe('');
    expect(render(9)).toBe('');
  });

  it('keeps the controls at the requested ten-row boundary', () => {
    expect(render(10)).toContain('class="page-indicator"');
  });
});

describe('ExecutionPagination page-size selector', () => {
  /** Render with the opportunity board's optional page-size wiring. */
  function renderWithSelector(itemCount: number, pageSize: number): string {
    return renderToStaticMarkup(
      <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
        <ExecutionPagination
          itemCount={itemCount}
          page={1}
          onPageChange={vi.fn()}
          pageSize={pageSize}
          pageSizeOptions={[25, 50, 100]}
          onPageSizeChange={vi.fn()}
        />
      </LanguageContext.Provider>,
    );
  }

  it('renders a labelled selector with every offered size', () => {
    const html = renderWithSelector(9, 50);
    // A short table stays visible once the page size itself is changeable.
    expect(html).toContain('class="page-indicator"');
    expect(html).toContain('<select');
    expect(html).toContain('aria-label="Rows per page"');
    expect(html).toContain('<option value="25">25</option>');
    expect(html).toMatch(/<option value="50" selected="">50<\/option>/);
    expect(html).toContain('<option value="100">100</option>');
  });

  it('marks the effective page size as the selected option', () => {
    const html = renderWithSelector(120, 100);
    // React SSR flags the selected option; both markups appear across React 18/19 output shapes.
    const selectedMarked = /<option[^>]*selected[^>]*value="100"/.test(html)
      || /<option[^>]*value="100"[^>]*selected/.test(html);
    expect(selectedMarked).toBe(true);
  });
});
