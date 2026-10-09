import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { LanguageContext, translate, type Language } from './i18n.js';
import { EquityCardBody, PortfolioEquityCard } from './portfolio-equity-card.js';

function renderInContext(node: ReactNode, language: Language = 'en'): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider
      value={{ language, theme: 'dark', t: (key) => translate(language, key), setLanguage: vi.fn() }}
    >
      {node}
    </LanguageContext.Provider>,
  );
}

const baseProps = {
  loading: false,
  error: false,
  points: [],
  firstSampleAt: null,
  range: '24h' as const,
  theme: 'dark' as const,
  locale: 'en-US',
  onRetry: vi.fn(),
  onRangeChange: vi.fn(),
};

describe('portfolio equity card', () => {
  it('renders the four range tabs with 24h pressed by default, and the loading state while fetching', () => {
    const html = renderInContext(<PortfolioEquityCard />);
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(3);
    expect(html).toContain('>24h</button>');
    expect(html).toContain('>7d</button>');
    expect(html).toContain('>30d</button>');
    expect(html).toContain('>All</button>');
    expect(html).toContain('role="group"');
    expect(html).toContain('Equity curve range');
    // Effects never run in SSR, so the card shows its loading state.
    expect(html).toContain('Loading equity curve…');
    expect(html).toContain('role="status"');
    expect(html).toContain('Curve covers the CrossEx account margin balance');
  });

  it('renders the empty state as a normal condition, never an error', () => {
    const html = renderInContext(<EquityCardBody {...baseProps} />);
    expect(html).toContain('No samples yet');
    expect(html).toContain('Samples are recorded while the terminal runs; the curve fills in over the first days.');
    expect(html).not.toContain('equity-message error');
    expect(html).not.toContain('Portfolio equity history');
  });

  it('renders the failure state with a retry affordance', () => {
    const html = renderInContext(<EquityCardBody {...baseProps} error />);
    expect(html).toContain('Equity curve unavailable');
    expect(html).toContain('Try again');
    expect(html).toContain('equity-message error');
  });

  it('renders the area chart with the localized first-sample note and the range change', () => {
    const html = renderInContext(<EquityCardBody
      {...baseProps}
      points={[{ time: Date.parse('2026-07-01T00:00:00.000Z'), value: 100 }, { time: Date.parse('2026-07-01T01:00:00.000Z'), value: 150 }]}
      firstSampleAt="2026-07-01T00:00:00.000Z"
      range="7d"
    />);
    expect(html).toContain('Portfolio equity history. 2 points. Latest $150.00.');
    expect(html).toContain('Sampling since');
    expect(html).toContain('Jul 1, 2026');
    expect(html).toContain('+$50');
    expect(html).toContain('+50%');
    expect(html).toContain('equity-change positive');
  });

  it('marks a falling range change as negative', () => {
    const html = renderInContext(<EquityCardBody
      {...baseProps}
      points={[{ time: 1_000, value: 150 }, { time: 2_000, value: 100 }]}
    />);
    expect(html).toContain('-$50');
    expect(html).toContain('-33.33%');
    expect(html).toContain('equity-change negative');
  });

  it('shows no range-change percentage when the first point of the range is zero', () => {
    // change / 0 is undefined: no percentage may be rendered (the whole change line is
    // suppressed by the current implementation — pinned here so the choice stays deliberate).
    const html = renderInContext(<EquityCardBody
      {...baseProps}
      points={[{ time: 1_000, value: 0 }, { time: 2_000, value: 100 }]}
    />);
    expect(html).not.toContain('equity-change');
    expect(html).not.toContain('%');
  });

  it('localizes headings, range labels, and the empty state into Chinese', () => {
    const html = renderInContext(
      <EquityCardBody {...baseProps} range="all" />,
      'zh',
    );
    expect(html).toContain('净值曲线');
    expect(html).toContain('净值周期');
    expect(html).toContain('>全部</button>');
    expect(html).toContain('暂无采样点');
    expect(html).toContain('采样点仅在终端运行期间记录，曲线会在最初几天逐步填满。');
    expect(html).toContain('曲线仅统计 CrossEx 账户保证金余额，不含 Gate 现货余额。');
  });

  it('renders the chart with live data and keeps the empty state for a lone point', () => {
    const appended = renderInContext(<EquityCardBody
      {...baseProps}
      points={[{ time: 1_000, value: 100 }, { time: 5_000, value: 190 }]}
    />);
    expect(appended).toContain('Latest $190.00');
    // A single point cannot draw a curve; the empty state covers it.
    const lonePoint = renderInContext(<EquityCardBody
      {...baseProps}
      points={[{ time: 9_000, value: 200 }]}
    />);
    expect(lonePoint).toContain('No samples yet');
  });
});
