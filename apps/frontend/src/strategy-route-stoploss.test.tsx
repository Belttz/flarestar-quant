import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LanguageContext, translate, type Language } from './i18n.js';
import { StrategyView } from './strategy-route.js';
import { AutoThresholdHints } from './strategy-threshold-hints.js';
import { describeAutoThresholds, type AutoThresholdDraft } from './strategy-ladder.js';

function context(language: Language = 'en') {
  return {
    language,
    theme: 'dark' as const,
    // Mirror the real provider: `translate` falls back to the English key.
    t: (key: string) => translate(language, key),
    setLanguage: vi.fn(),
  };
}

const SHARED_PROPS = {
  marketSnapshot: null,
  catalog: null,
  strategies: [],
  balances: {},
  authenticatedPortfolio: null,
  tradingSnapshot: null,
  tradingMode: 'live' as const,
  onOpenModeDialog: vi.fn(),
  onStrategiesChanged: vi.fn(async () => undefined),
  onPositionsRefresh: vi.fn(async () => undefined),
  watchQuotes: vi.fn(),
};

/**
 * There is no jsdom in this workspace, so the auto form is asserted from static markup.
 * `renderToStaticMarkup` runs the `useState` initializers — where the URL query is parsed — but not
 * effects, so no backend calls are needed.
 */
function renderAutoForm(search: string, language: Language = 'en'): string {
  vi.stubGlobal('window', { location: { search } });
  try {
    return renderToStaticMarkup(
      <LanguageContext.Provider value={context(language)}>
        <StrategyView {...SHARED_PROPS} mode="auto" fees={[]} />
      </LanguageContext.Provider>,
    );
  } finally {
    vi.unstubAllGlobals();
  }
}

function renderHints(draft: AutoThresholdDraft, armed = true, language: Language = 'en'): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={context(language)}>
      <AutoThresholdHints view={describeAutoThresholds(draft)} armed={armed} />
    </LanguageContext.Provider>,
  );
}

/** `entryBps=50 / step=20 / stopLossBps=100` — the ladder example from the design (§8.1). */
const LADDER_DRAFT: AutoThresholdDraft = {
  entryBps: '50',
  stopLossBps: '100',
  addOnStepBps: '20',
  maxPosition: '3000',
  perOrderQuantity: '1000',
};

describe('auto form effective tolerance hint (design §5.10)', () => {
  it('shows the real tolerance, not the raw stop-loss value', () => {
    // 65 bps entry under a 100 bps stop ⇒ 35 bps of room, the production `AUTO-1CCEAE53` case.
    const html = renderAutoForm('?asset=BTC&entryBps=65');

    expect(html).toContain('Effective stop buffer: 35 bps');
  });

  it('explains the gap in plain language instead of leaving a bare number', () => {
    const html = renderAutoForm('?asset=BTC&entryBps=65');

    expect(html).toContain('You enter at 65 bps, but the stop is an absolute 100 bps spread — so only 35 bps of adverse move remain before it exits');
  });

  it('updates live as the entry threshold changes', () => {
    expect(renderAutoForm('?entryBps=80')).toContain('Effective stop buffer: 20 bps');
    expect(renderAutoForm('?entryBps=0')).toContain('Effective stop buffer: 100 bps');
    expect(renderAutoForm('?entryBps=-6')).toContain('Effective stop buffer: 94 bps');
  });

  it('raises no warning for a stop that leaves room, and warns when it does not', () => {
    const roomy = renderHints({ ...LADDER_DRAFT, entryBps: '99.9' }, false);
    expect(roomy).toContain('Effective stop buffer: 0.1 bps');
    expect(roomy).not.toContain('Stop-loss must exceed the entry threshold');

    const blocked = renderHints({ ...LADDER_DRAFT, entryBps: '100' }, false);
    expect(blocked).toContain('Effective stop buffer: 0 bps');
    expect(blocked).toContain('Stop-loss must exceed the entry threshold');
  });
});

describe('add-on step input (design §8.7)', () => {
  it('renders an optional bps field in the same group as the thresholds', () => {
    const html = renderAutoForm('?entryBps=50');

    expect(html).toContain('Add-on step');
    expect(html).toContain('placeholder="Optional"');
  });

  it('stays execution-method agnostic: no maker exclusion, just a static note', () => {
    const html = renderHints(LADDER_DRAFT, true);
    expect(html).toContain('Applies to Taker–Taker and Maker–Taker; on Maker–Taker tiers fill from a resting quote.');
    // The ladder is supported on both paths, so there is no "unsupported" copy to show.
    expect(html).not.toContain('unsupported');
  });

  it('hides the maker note while the step is blank, i.e. on today\'s behaviour', () => {
    const html = renderHints({ ...LADDER_DRAFT, addOnStepBps: '' }, false);
    expect(html).not.toContain('Applies to Taker–Taker');
  });

  it('never uses aria-pressed, which is reserved for the spread board buttons', () => {
    expect([...renderHints(LADDER_DRAFT).matchAll(/aria-pressed=/g)]).toHaveLength(0);
  });
});

describe('ladder preview', () => {
  it('lists the reachable tiers and the clip count before the stop line', () => {
    const html = renderHints(LADDER_DRAFT);

    expect(html).toContain('Add-on tiers: 50 / 70 / 90 bps');
    expect(html).toContain('3 clips before the 100 bps stop');
  });

  it('omits the truncation clause when no stop-loss is configured', () => {
    const html = renderHints({ ...LADDER_DRAFT, stopLossBps: '' });

    expect(html).toContain('Add-on tiers: 50 / 70 / 90 bps');
    expect(html).not.toContain('clips before the');
  });

  it('names max position as the binding cap when it binds first', () => {
    const html = renderHints({ ...LADDER_DRAFT, stopLossBps: '1000', maxPosition: '2000' });

    expect(html).toContain('Add-on tiers: 50 / 70 bps');
    expect(html).toContain('2 clips');
    expect(html).toContain('limited by max position');
  });

  it('flags a non-positive step instead of previewing nonsense tiers', () => {
    expect(renderHints({ ...LADDER_DRAFT, addOnStepBps: '0' })).toContain('Add-on step must be positive');
    expect(renderHints({ ...LADDER_DRAFT, addOnStepBps: '-5' })).toContain('Add-on step must be positive');
  });

  it('flags a step that pushes the first add-on tier onto the stop line', () => {
    expect(renderHints({ ...LADDER_DRAFT, addOnStepBps: '50' })).toContain('The first add-on tier must sit below the stop-loss');
  });
});

describe('threshold hint localization (design §5 Step 5)', () => {
  it('translates the buffer label and the ladder heading into Chinese', () => {
    const html = renderHints(LADDER_DRAFT, true, 'zh');

    expect(html).toContain('止损实际缓冲: 50 bps');
    expect(html).toContain('加仓档位: 50 / 70 / 90 bps');
    // Untranslated English copy must not leak through.
    expect(html).not.toContain('Effective stop buffer');
    expect(html).not.toContain('Add-on tiers');
  });

  it('keeps English when the interface language is English', () => {
    const html = renderHints(LADDER_DRAFT, true, 'en');

    expect(html).toContain('Effective stop buffer: 50 bps');
    expect(html).toContain('Add-on tiers: 50 / 70 / 90 bps');
  });
});
