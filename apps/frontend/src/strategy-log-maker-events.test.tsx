import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  STRATEGY_LOG_CATEGORY_FETCH_EVENTS,
  STRATEGY_LOG_EVENT_CATEGORY,
  type StrategyLogCategory,
} from '@gate-crossex/shared-types';
import type { StrategyRecord } from './api.js';
import { LanguageContext, localizeLegDiagnostic, translate } from './i18n.js';
import { StrategyExecutionLogDialog } from './strategy-route.js';
import { classifyStrategyLogEvent, prepareStrategyLogView, type DisplayStrategyLog } from './strategy-logs.js';

/**
 * Coverage for the two maker entry-proximity events (`Maker quoting parked` / `Maker quoting
 * resumed`) and, more importantly, for the contract around them: the frontend owns the Chinese
 * wording of an event name, while the tab it lands in is derived from the shared registry. A future
 * backend event the frontend has not registered must degrade to its raw name, never to a blank cell.
 *
 * There is no jsdom here, so rendering goes through `renderToStaticMarkup` like the other log tests.
 */

const PARKED = 'Maker quoting parked';
const RESUMED = 'Maker quoting resumed';
const PARKED_ZH = '行情离入场价还太远，先不挂单，等走近再说';
const RESUMED_ZH = '行情已走近入场价，恢复挂单';
const MAKER_PROXIMITY_EVENTS = [PARKED, RESUMED] as const;

/**
 * The maker-quote / taker-hedge events that shipped with an English-only label. Prices, quantities
 * and bps thresholds are carried by `condition` / `quantity`, so no label here may contain a digit.
 */
const MAKER_HEDGE_LABELS: ReadonlyArray<readonly [event: string, chinese: string]> = [
  ['Maker quote placed', '挂单已报出，等成交'],
  ['Maker exit quote placed', '平仓挂单已报出，等成交'],
  ['Maker quote rejected', '挂单被交易所拒绝，稍后重新报价'],
  ['Hedging filled quantity', '挂单成交了，正在补上另一条腿'],
  ['Trimming residual imbalance', '正在把多出来的敞口剪平'],
  ['Hedge order settled', '对冲腿已成交完成'],
  ['Residual trim settled', '多出来的敞口已剪平'],
  ['Hedge order failed', '对冲腿下单失败'],
];

/** Every maker-tab wording the frontend owns, used for the no-numbers / no-duplicates guards. */
const ALL_MAKER_LABELS: string[] = [...MAKER_HEDGE_LABELS.map(([, chinese]) => chinese), PARKED_ZH, RESUMED_ZH];

/** The remaining execution / risk / system events that shipped with an English-only label. */
const REMAINING_EVENT_LABELS: ReadonlyArray<readonly [event: string, chinese: string]> = [
  ['Leg submission failed', '有一条腿下单失败，稍后重试'],
  ['Closing remaining exposure', '正在平掉剩下的敞口'],
  ['Residual close submission failed', '收尾平仓下单失败'],
  ['Residual close settled', '收尾平仓已结算'],
  ['Carry position opened', '套息仓位已建立'],
  ['Stop-loss triggered', '已触发止损，准备平仓'],
  ['Basis take-profit triggered', '基差止盈已触发'],
  ['Strategy engine error', '策略引擎报错'],
  ['Shutdown cancellation pending', '退出时撤单未确认'],
  ['Strategy pause pending', '等交易所确认暂停'],
  ['Strategy stop pending', '等交易所确认停止'],
  ['Waiting for funding threshold', '资金费还没到门槛，先不开仓'],
  ['Carry entry gate blocked', '余额不够，先不入场'],
  ['Carry entry gate passed', '余额够了，开始入场'],
  ['Funding interval unknown', '资金费结算周期未知，先用默认值估算'],
];

/** States the leg template must word, and states it must leave verbatim. */
const LEG_KNOWN_STATES: ReadonlyArray<readonly [event: string, chinese: string]> = [
  ['Left leg filled', '左腿已成交'],
  ['Right leg filled', '右腿已成交'],
  ['Left leg partially_filled', '左腿部分成交'],
  ['Right leg cancelled', '右腿已取消'],
  ['Left leg rejected', '左腿已拒绝'],
  ['Right leg expired', '右腿已过期'],
  ['Left leg fail', '左腿失败'],
  ['Right leg new', '右腿已提交'],
  ['Left leg open', '左腿挂单中'],
  ['Right leg pending_submit', '右腿待提交'],
  // `PENDING_CANCEL` is one of the five canonical open states (trading-runtime.ts OPEN_ORDER_STATES)
  // and really reaches the log: `awaitTerminalOrder` resolves with the stored row when its deadline
  // fires, so a cancel the venue never confirms lands here.
  ['Left leg pending_cancel', '左腿待撤单'],
  ['Right leg pending_cancel', '右腿待撤单'],
  ['Left leg remote_not_found', '左腿交易所查不到该单'],
];

/** Keys whose tail collides with `Object.prototype`: the lookup must stay own-property only. */
const LEG_PROTOTYPE_TAILS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

/** Gateway states nobody enumerated: the tail has to survive untouched. */
const LEG_UNKNOWN_STATES: ReadonlyArray<readonly [event: string, chinese: string]> = [
  ['Left leg reinstated', '左腿 reinstated'],
  ['Right leg unfilled_or_unknown', '右腿 unfilled_or_unknown'],
  ['Left leg order_not_exist', '左腿 order_not_exist'],
];

function strategy(): StrategyRecord {
  return {
    id: 'AUTO-MAKER001',
    kind: 'auto',
    status: 'RUNNING',
    accountProfileId: 'gate-crossex-default',
    accountLabel: 'Gate CrossEx',
    config: {
      kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
      leftSide: 'SELL', rightSide: 'BUY', entryBps: '10', totalAmount: '0.1',
      perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'MAKER_TAKER',
      makerLeg: 'left',
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

function logRow(id: string, event: string): DisplayStrategyLog {
  return {
    id,
    level: 'info',
    event,
    condition: '18.40 bps',
    quantity: '',
    result: '',
    createdAt: '2026-08-14T00:02:00.000Z',
    executionPremiumPct: null,
    executionSpreadBps: null,
  };
}

/** Render the log dialog with the real translation table instead of the identity stub. */
function renderDialog(events: string[], language: 'en' | 'zh', activeCategory: StrategyLogCategory = 'all'): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider
      value={{ language, theme: 'dark', t: (key) => translate(language, key), setLanguage: vi.fn() }}
    >
      <StrategyExecutionLogDialog
        strategy={strategy()}
        rows={events.map((event, index) => logRow(`log-${index}`, event))}
        loadState={{ status: 'loaded' }}
        activeCategory={activeCategory}
        onCategoryChange={vi.fn()}
        page={1}
        onPageChange={vi.fn()}
        hasMore={false}
        loadingOlder={false}
        onLoadOlder={vi.fn()}
        errorKind={null}
        onRetry={vi.fn()}
        onClose={vi.fn()}
        dialogRef={{ current: null }}
        categoryTotals={{}}
        scannedRows={0}
      />
    </LanguageContext.Provider>,
  );
}

describe('maker entry-proximity events: Chinese wording', () => {
  it('translates both events into plain Chinese', () => {
    expect(translate('zh', PARKED)).toBe(PARKED_ZH);
    expect(translate('zh', RESUMED)).toBe(RESUMED_ZH);
  });

  it('leaves both events untouched in English', () => {
    expect(translate('en', PARKED)).toBe(PARKED);
    expect(translate('en', RESUMED)).toBe(RESUMED);
  });

  it('renders both events in Chinese inside the log dialog', () => {
    const html = renderDialog([PARKED, RESUMED], 'zh');
    expect(html).toContain(PARKED_ZH);
    expect(html).toContain(RESUMED_ZH);
    // The raw English name must not leak into a Chinese row.
    expect(html).not.toContain(PARKED);
    expect(html).not.toContain(RESUMED);
    expect([...html.matchAll(/class="execution-log-row"/g)]).toHaveLength(2);
  });

  it('renders both events in English when the language is English', () => {
    const html = renderDialog([PARKED, RESUMED], 'en');
    expect(html).toContain(PARKED);
    expect(html).toContain(RESUMED);
  });
});

describe('maker quote and hedge events: Chinese wording', () => {
  it('translates all eight events into plain Chinese', () => {
    for (const [event, chinese] of MAKER_HEDGE_LABELS) {
      expect(translate('zh', event)).toBe(chinese);
    }
  });

  it('leaves all eight events untouched in English', () => {
    for (const [event] of MAKER_HEDGE_LABELS) {
      expect(translate('en', event)).toBe(event);
    }
  });

  it('renders the whole maker set in Chinese inside the log dialog', () => {
    const events = [...MAKER_HEDGE_LABELS.map(([event]) => event), PARKED, RESUMED];
    const html = renderDialog(events, 'zh');
    for (const [, chinese] of MAKER_HEDGE_LABELS) expect(html).toContain(chinese);
    expect(html).toContain(PARKED_ZH);
    expect(html).toContain(RESUMED_ZH);
    // Not one raw English event name may survive into a Chinese row.
    for (const event of events) expect(html).not.toContain(event);
    expect([...html.matchAll(/class="execution-log-row"/g)]).toHaveLength(events.length);
  });

  it('keeps the two "settled" events distinct — the hedge leg is not the residual', () => {
    // Same verb, different object: one settles the taker hedge, the other the left-over exposure.
    expect(translate('zh', 'Hedge order settled')).not.toBe(translate('zh', 'Residual trim settled'));
    expect(translate('zh', 'Hedge order settled')).toContain('对冲腿');
    expect(translate('zh', 'Residual trim settled')).not.toContain('对冲腿');
  });

  it('never hard-codes a number in a maker label', () => {
    // Quote prices, quantities and bps thresholds are runtime values delivered through
    // `condition` / `quantity`; a digit baked into a label goes stale the moment a threshold moves.
    for (const chinese of ALL_MAKER_LABELS) {
      expect(chinese).not.toMatch(/[0-9]/);
    }
  });

  it('gives every maker label its own wording', () => {
    expect(new Set(ALL_MAKER_LABELS).size).toBe(ALL_MAKER_LABELS.length);
  });

  it('gives every registered maker event a Chinese label', () => {
    // The regression guard: the maker tab used to render most of its rows in English. Any event
    // added to the shared registry without a matching `chinese` entry fails here.
    const makerEvents = Object.keys(STRATEGY_LOG_EVENT_CATEGORY)
      .filter((event) => STRATEGY_LOG_EVENT_CATEGORY[event] === 'maker');
    expect(makerEvents.length).toBeGreaterThan(0);
    for (const event of makerEvents) {
      expect(translate('zh', event)).not.toBe(event);
    }
  });
});

describe('remaining execution / risk / system events: Chinese wording', () => {
  it('translates every remaining event into plain Chinese', () => {
    for (const [event, chinese] of REMAINING_EVENT_LABELS) {
      expect(translate('zh', event)).toBe(chinese);
    }
  });

  it('leaves every remaining event untouched in English', () => {
    for (const [event] of REMAINING_EVENT_LABELS) {
      expect(translate('en', event)).toBe(event);
    }
  });

  it('renders the whole set in Chinese inside the log dialog', () => {
    const events = REMAINING_EVENT_LABELS.map(([event]) => event);
    const html = renderDialog(events, 'zh');
    for (const [, chinese] of REMAINING_EVENT_LABELS) expect(html).toContain(chinese);
    for (const event of events) expect(html).not.toContain(event);
    expect([...html.matchAll(/class="execution-log-row"/g)]).toHaveLength(events.length);
  });

  it('keeps stop-loss arming and stop-loss exit apart', () => {
    // `Stop-loss triggered` arms the exit; `Stop-loss exit triggered` is the clip-level exit.
    expect(translate('zh', 'Stop-loss triggered')).not.toBe(translate('zh', 'Stop-loss exit triggered'));
    expect(translate('zh', 'Stop-loss exit triggered')).toBe('止损平仓已触发');
  });

  it('keeps the three pending states away from the terminal ones', () => {
    // A pending row means "asked the venue, still waiting" — it must never read as already done.
    for (const pending of ['Shutdown cancellation pending', 'Strategy pause pending', 'Strategy stop pending']) {
      expect(translate('zh', pending)).not.toBe(translate('zh', 'Strategy paused'));
      expect(translate('zh', pending)).not.toBe(translate('zh', 'Strategy stopped'));
    }
  });

  it('keeps the carry entry gate pair symmetric', () => {
    const blocked = translate('zh', 'Carry entry gate blocked');
    const passed = translate('zh', 'Carry entry gate passed');
    expect(blocked).not.toBe(passed);
    expect(blocked).toContain('不入场');
    expect(passed).toContain('入场');
  });

  it('never hard-codes a number in any of these labels', () => {
    for (const [, chinese] of REMAINING_EVENT_LABELS) {
      expect(chinese).not.toMatch(/[0-9]/);
    }
  });
});

describe('leg diagnostics: template translation', () => {
  it('words both sides and every known order state', () => {
    for (const [event, chinese] of LEG_KNOWN_STATES) {
      expect(translate('zh', event)).toBe(chinese);
    }
  });

  it('keeps an unregistered state tail verbatim instead of dropping it', () => {
    // The whole point of the template: the state tail is an open set, so an unknown state must
    // survive as-is — never `undefined`, never an empty cell.
    for (const [event, chinese] of LEG_UNKNOWN_STATES) {
      expect(translate('zh', event)).toBe(chinese);
    }
  });

  it('never renders undefined, blank or NaN for any leg row', () => {
    const states = ['filled', 'remote_not_found', 'fail', '', 'unknown_state_9'];
    for (const prefix of ['Left leg ', 'Right leg ']) {
      for (const state of states) {
        const rendered = translate('zh', `${prefix}${state}`);
        expect(typeof rendered).toBe('string');
        expect(rendered.length).toBeGreaterThan(0);
        expect(rendered).not.toContain('undefined');
        expect(rendered).not.toContain('NaN');
      }
    }
  });

  it('leaves leg diagnostics untouched in English', () => {
    expect(translate('en', 'Left leg filled')).toBe('Left leg filled');
    expect(translate('en', 'Right leg remote_not_found')).toBe('Right leg remote_not_found');
  });

  it('never leaks a JavaScript value for a prototype-colliding state tail', () => {
    // Both lookup tables are plain object literals, so a bare `table[key]` resolves `constructor`,
    // `toString`, … up the prototype chain and concatenates a function into the label.
    for (const hostile of LEG_PROTOTYPE_TAILS) {
      for (const prefix of ['Left leg ', 'Right leg ']) {
        const rendered = translate('zh', `${prefix}${hostile}`);
        expect(rendered).toBe(`${prefix === 'Left leg ' ? '左腿' : '右腿'} ${hostile}`);
        expect(rendered).not.toContain('function');
        expect(rendered).not.toContain('[object');
        expect(rendered).not.toContain('[native code]');
      }
    }
  });

  it('does not touch keys that are not leg diagnostics', () => {
    // The template must stay narrow: ordinary strings fall through to the dictionary or the key.
    expect(translate('zh', 'Entry triggered')).toBe('已触发开仓');
    expect(translate('zh', 'Left leg')).toBe('Left leg');
    expect(translate('zh', 'Leg day')).toBe('Leg day');
    expect(localizeLegDiagnostic('Entry triggered')).toBeUndefined();
  });

  it('renders a leg row in Chinese inside the log dialog', () => {
    const html = renderDialog(['Left leg filled', 'Right leg unfilled_or_unknown'], 'zh');
    expect(html).toContain('左腿已成交');
    // The unregistered tail survives into the rendered row instead of vanishing.
    expect(html).toContain('右腿 unfilled_or_unknown');
    expect(html).not.toContain('undefined');
    expect([...html.matchAll(/class="execution-log-row"/g)]).toHaveLength(2);
  });

  it('still routes leg diagnostics to the execution tab', () => {
    // The template only changes wording; classification is untouched by this change.
    expect(classifyStrategyLogEvent('Left leg filled')).toBe('execution');
    expect(classifyStrategyLogEvent('Left leg remote_not_found')).toBe('execution');
    expect(classifyStrategyLogEvent('Right leg reinstated')).toBe('execution');
  });
});

describe('dictionary lookups never read through the prototype chain', () => {
  it('falls back to the raw key for a prototype-colliding key', () => {
    // `chinese` is a plain object literal, so `chinese['constructor']` used to resolve up to
    // `Object.prototype` and hand the renderer a function instead of a string.
    for (const hostile of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(translate('zh', hostile)).toBe(hostile);
      expect(translate('en', hostile)).toBe(hostile);
    }
  });

  it('always returns a string, never a function or an object', () => {
    for (const hostile of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      for (const language of ['zh', 'en'] as const) {
        const rendered = translate(language, hostile);
        expect(typeof rendered, `${language}:${hostile}`).toBe('string');
        expect(rendered).not.toContain('function');
        expect(rendered).not.toContain('[object');
        expect(rendered).not.toContain('[native code]');
      }
    }
  });

  it('still resolves ordinary keys through the dictionary', () => {
    // The guard must be invisible to real UI strings: 959 distinct keys are passed to `t()` across
    // the app and none of them is inherited from `Object.prototype`.
    expect(translate('zh', 'More')).toBe('更多');
    expect(translate('zh', 'Best ask')).toBe('最优卖价');
    expect(translate('en', 'More')).toBe('More');
  });
});

describe('every registered event has a Chinese label', () => {
  it('leaves no static event in the shared registry untranslated', () => {
    // The permanent gate: a backend engineer adding an event without a matching `chinese` entry
    // turns this red. Leg diagnostics are a dynamic `Left leg <state>` template, handled by
    // `localizeLegDiagnostic` rather than the dictionary, so they are excluded on purpose.
    const legPrefixes = ['Left leg ', 'Right leg '];
    const staticEvents = Object.keys(STRATEGY_LOG_EVENT_CATEGORY)
      .filter((event) => !legPrefixes.some((prefix) => event.startsWith(prefix)));
    expect(staticEvents.length).toBeGreaterThan(40);
    for (const event of staticEvents) {
      expect(translate('zh', event)).not.toBe(event);
    }
  });

  it('covers the leg diagnostics through the template instead', () => {
    for (const event of Object.keys(STRATEGY_LOG_EVENT_CATEGORY)) {
      if (!/^(Left|Right) leg /.test(event)) continue;
      expect(translate('zh', event)).not.toBe(event);
      expect(translate('zh', event)).toMatch(/^(左腿|右腿)/);
    }
  });
});

describe('maker entry-proximity events: tab placement', () => {
  it('derives the tab from the shared registry, never from a second frontend list', () => {
    // The 0.3.1 defect ("several categories always empty") came from a category assignment that
    // disagreed with the backend fetch set. Every registered event must classify exactly as the
    // registry says, and both new events take part in that loop.
    for (const [event, category] of Object.entries(STRATEGY_LOG_EVENT_CATEGORY)) {
      expect(classifyStrategyLogEvent(event)).toBe(category);
    }
    for (const event of MAKER_PROXIMITY_EVENTS) {
      expect(classifyStrategyLogEvent(event)).toBe('maker');
    }
  });

  it('is registered under maker rather than falling back to system', () => {
    // The `system` fallback is for events the backend can emit but nobody registered — it is not a
    // valid home for these two.
    for (const event of MAKER_PROXIMITY_EVENTS) {
      expect(STRATEGY_LOG_EVENT_CATEGORY[event], event).toBe('maker');
    }
  });

  it('keeps every registered event in the fetch set of the tab it lands in', () => {
    // The client-side `system` fallback is NOT a safety net: the backend builds its SQL from
    // `STRATEGY_LOG_CATEGORY_FETCH_EVENTS`, which is derived from the very same registry. An
    // unregistered event is therefore selected by no category query at all and only ever shows up
    // in the unfiltered "all" scan — the 0.3.1 "categories always empty" signature.
    for (const event of MAKER_PROXIMITY_EVENTS) {
      const category = STRATEGY_LOG_EVENT_CATEGORY[event];
      expect(category, event).toBe('maker');
      expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS[category!], event).toContain(event);
    }
  });

  it('is fetchable by the maker query, so neither row can go invisible', () => {
    // The end of the dependency chain: the maker tab's backend query selects them, which is what
    // makes the rows reachable at all. Both are asserted, so a future deregistration cannot make
    // the log silently lose them in every category tab again.
    for (const event of MAKER_PROXIMITY_EVENTS) {
      expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS.maker, event).toContain(event);
      expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS.system, event).not.toContain(event);
    }
  });

  it('shows them in the maker tab and hides them from the unrelated ones', () => {
    const rows = [logRow('p', PARKED), logRow('r', RESUMED), logRow('e', 'Entry triggered')];

    expect(prepareStrategyLogView(rows, 'all').map((row) => row.id)).toEqual(['p', 'r', 'e']);
    expect(prepareStrategyLogView(rows, 'maker').map((row) => row.id)).toEqual(['p', 'r']);
    // `Entry triggered` is an execution row, so it belongs to no other tab either: it proves the
    // filter is really filtering and not just returning the buffer.
    expect(prepareStrategyLogView(rows, 'maker').map((row) => row.id)).not.toContain('e');
    for (const other of ['execution', 'risk', 'system'] as const) {
      expect(prepareStrategyLogView(rows, other).map((row) => row.id)).not.toContain('p');
      expect(prepareStrategyLogView(rows, other).map((row) => row.id)).not.toContain('r');
    }
    // Registered under maker, so the system tab must no longer claim them: only `Entry triggered`
    // would land there, and that one is an execution row.
    expect(prepareStrategyLogView(rows, 'system').map((row) => row.id)).toEqual([]);
  });
});

describe('unknown event names degrade to their raw text', () => {
  it('returns the key itself instead of blank or undefined', () => {
    const unknown = 'Maker quote repriced by venue';
    expect(translate('zh', unknown)).toBe(unknown);
    expect(translate('en', unknown)).toBe(unknown);
    expect(translate('zh', '')).toBe('');
  });

  it('renders an unregistered event row without crashing and without a blank cell', () => {
    const unknown = 'Maker quote repriced by venue';
    const html = renderDialog([unknown, PARKED], 'zh');
    // Fallback: the event name is shown verbatim, not swallowed and not rendered as `undefined`.
    expect(html).toContain(unknown);
    expect(html).not.toContain('undefined');
    expect([...html.matchAll(/class="execution-log-row"/g)]).toHaveLength(2);
    // The registered sibling still localizes, so the fallback is per-row, not global.
    expect(html).toContain('行情离入场价还太远，先不挂单，等走近再说');
  });

  it('classifies an unregistered event as system so the row is never hidden', () => {
    expect(classifyStrategyLogEvent('Maker quote repriced by venue')).toBe('system');
    expect(prepareStrategyLogView([logRow('u', 'Maker quote repriced by venue')], 'system')).toHaveLength(1);
    expect(prepareStrategyLogView([logRow('u', 'Maker quote repriced by venue')], 'all')).toHaveLength(1);
  });
});
