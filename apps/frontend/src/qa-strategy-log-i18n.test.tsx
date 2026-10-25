import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  STRATEGY_LOG_CATEGORIES,
  STRATEGY_LOG_CATEGORY_FETCH_EVENTS,
  STRATEGY_LOG_EVENT_CATEGORY,
  STRATEGY_LOG_LEG_EVENT_PREFIXES,
  type StrategyLogCategory,
} from '@gate-crossex/shared-types';
import type { StrategyRecord } from './api.js';
import { LanguageContext, localizeLegDiagnostic, translate } from './i18n.js';
import { StrategyExecutionLogDialog } from './strategy-route.js';
import {
  classifyStrategyLogEvent,
  localizeStrategyLogResult,
  type DisplayStrategyLog,
} from './strategy-logs.js';

/**
 * Independent QA pass over the strategy-execution-log localization work:
 *
 *   1. `localizeLegDiagnostic` — the `Left leg <state>` / `Right leg <state>` template. The
 *      implementation's own suite only feeds it well-formed keys; this file feeds it the keys a
 *      gateway, a database row or a future venue can actually produce, and asserts none of them
 *      degrade to `undefined` / a blank cell / a JavaScript value leaking into the UI.
 *   2. The 30 newly worded static events (2 maker proximity + 8 maker/hedge + 15 execution/risk/
 *      system + `Maker exit fallback` + the 4 reduce-only reconciliation names) — Chinese under
 *      `zh`, verbatim under `en`.
 *   3. The category contract those events participate in: an event the frontend can word must also
 *      be reachable in the tab it classifies into.
 *
 * No jsdom here; rendering goes through `renderToStaticMarkup` like the other log tests.
 */

const PARKED = 'Maker quoting parked';
const RESUMED = 'Maker quoting resumed';

/** The static events the frontend words, and the Chinese each must render. */
const NEWLY_WORDED: ReadonlyArray<readonly [event: string, chinese: string]> = [
  ['Maker quoting parked', '行情离入场价还太远，先不挂单，等走近再说'],
  ['Maker quoting resumed', '行情已走近入场价，恢复挂单'],
  ['Maker quote placed', '挂单已报出，等成交'],
  ['Maker exit quote placed', '平仓挂单已报出，等成交'],
  ['Maker quote rejected', '挂单被交易所拒绝，稍后重新报价'],
  ['Hedging filled quantity', '挂单成交了，正在补上另一条腿'],
  ['Trimming residual imbalance', '正在把多出来的敞口剪平'],
  ['Hedge order settled', '对冲腿已成交完成'],
  ['Residual trim settled', '多出来的敞口已剪平'],
  ['Hedge order failed', '对冲腿下单失败'],
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
  // Landed with the reduce-only reconciliation batch: registered under `risk` by the backend lane.
  ['Maker exit fallback', '挂单平仓超时，改用兜底价格平仓'],
  // The four reduce-only reconciliation events, registered under `maker` (three) and `system`.
  ['Exit size drift', '平仓被交易所拒绝，正在核对真实持仓'],
  ['Exit size corrected', '已按交易所真实持仓修正平仓数量'],
  ['Exit quote withdrawn', '交易所已无可平仓位，撤销平仓挂单'],
  ['Position reconciliation failed', '与交易所核对持仓失败'],
  // v0.4.1 closePlan convergence (R3): a timed close that still leaves an orderable residual
  // after every retry logs this warning and converges to COMPLETED.
  ['Timed close ended with residual positions', '定时平仓结束仍有残量，请手动处理'],
];

/** Every state the leg dictionary enumerates, and the wording each side must use. */
const LEG_DICTIONARY: ReadonlyArray<readonly [state: string, chinese: string]> = [
  ['filled', '已成交'],
  ['partially_filled', '部分成交'],
  ['cancelled', '已取消'],
  ['rejected', '已拒绝'],
  ['expired', '已过期'],
  ['fail', '失败'],
  ['failed', '失败'],
  ['new', '已提交'],
  ['open', '挂单中'],
  ['pending_submit', '待提交'],
  ['remote_not_found', '交易所查不到该单'],
];

/**
 * Keys that look like a leg diagnostic but are not one. Each must fall through untouched: to the
 * ordinary dictionary when it has an entry, otherwise to the key itself.
 */
const NOT_LEG_DIAGNOSTICS: string[] = [
  'Left leg',              // no state at all
  'Right leg',             // ditto
  'Left leg ',             // one trailing space: the template requires a non-blank tail
  'Right leg ',            // ditto
  'Left leg   ',           // whitespace-only tail
  'Left leg\t',            // tab tail — `\S` must not match it
  'Left leg\n',            // newline tail — `$` is not multiline in JS
  'Left leg \n',
  'Left leg filled\n',     // trailing newline on an otherwise valid key
  'Left leg filled\nRight leg filled', // embedded newline
  'left leg filled',       // lower-case side
  'LEFT LEG FILLED',       // upper-case
  'Left LEG filled',
  ' Left leg filled',      // leading space
  '\tLeft leg filled',
  '\nLeft leg filled',
  'Left  leg filled',      // two spaces before `leg`
  'Left leg  filled',      // two spaces before the state
  'Left legacy filled',    // a different word that merely starts with `leg`
  'Left legged filled',
  'Left legs filled',
  'Middle leg filled',     // a side the template does not know
  'Leg left filled',
  'leg left',
  'Left side',             // ordinary UI strings that merely contain `Left`
  'Left venue',
  'Left symbol',
  'Maker leg',
  'Entry triggered',
  'Strategy',
  '',
];

/** Order states the dictionary does not know: the English tail has to survive verbatim. */
const UNKNOWN_LEG_STATES: string[] = [
  'reinstated',
  'unfilled_or_unknown',
  'order_not_exist',
  'FILLED',                // the engine lower-cases the state, but a legacy row may not
  'Cancelled',
  'partially filled',      // a space inside the tail: the template must keep all of it
  'filled and more',       // ditto
  'triggered@118500',
  'stale-9',
  '远程状态',
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

/**
 * Split a call's arguments on top-level commas only. A regex cannot do this: the emitted event
 * names sit next to nested calls and string literals containing `),`, so a naive pattern stops at
 * the first inner `);` and silently truncates the scan.
 */
function topLevelArgs(source: string, openIndex: number): string[] {
  let depth = 0;
  let current = '';
  const args: string[] = [];

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') { depth += 1; if (depth === 1) continue; }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) { args.push(current); return args; }
    }
    if (character === ',' && depth === 1) { args.push(current); current = ''; continue; }
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === '\\') { end += 2; continue; }
        if (source[end] === quote) break;
        end += 1;
      }
      current += source.slice(index, end + 1);
      index = end;
      continue;
    }
    current += character;
  }

  return args;
}

/** Index of the first `character` outside any quoted string, or -1. */
function indexOutsideStrings(source: string, character: string, from: number): number {
  for (let index = from; index < source.length; index += 1) {
    const current = source[index];
    if (current === '"' || current === "'" || current === '`') {
      const quote = current;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index] === quote) break;
        index += 1;
      }
      continue;
    }
    if (current === character) return index;
  }
  return -1;
}

/** A fragment that is exactly one single-quoted literal, e.g. `'Exit size drift'`. */
function literalEventName(fragment: string): string | null {
  return fragment.trim().match(/^'([^'\\]*)'$/)?.[1] ?? null;
}

/**
 * Every event name a `? :` chain can evaluate to. This walks the chain arm by arm instead of
 * running one flat regex: a single-level pattern (`\?\s*'A'\s*:\s*'B'`) only ever sees the innermost
 * pair and silently drops the outer arms of
 *
 *     cond ? 'A' : other ? 'B' : 'C'
 *
 * which is how `triggeredEvent` / `executedEvent` and `intent === 'entry' ? …` lost their outer
 * branches. Anchoring on the ternary operators also keeps the condition operands out: the `'exit'`
 * in `intent === 'exit' ? 'B' : 'C'` is neither a consequent nor an alternative, so it is not
 * reported as an event name.
 */
function eventNamesInExpression(expression: string): string[] {
  const direct = literalEventName(expression);
  if (direct !== null) return direct.length > 0 ? [direct] : [];

  const question = indexOutsideStrings(expression, '?', 0);
  // `?.` is optional chaining, not a ternary.
  if (question < 0 || expression[question + 1] === '.') return [];

  const colon = indexOutsideStrings(expression, ':', question + 1);
  if (colon < 0) return eventNamesInExpression(expression.slice(question + 1));
  return [
    ...eventNamesInExpression(expression.slice(question + 1, colon)),
    ...eventNamesInExpression(expression.slice(colon + 1)),
  ];
}

/**
 * The third argument may be a bare identifier bound earlier in the file — the engine passes
 * `triggeredEvent` / `executedEvent`, both assigned from a chained ternary. Read that declaration
 * back so its branches are seen; a literal argument comes back unchanged.
 */
function resolveEventArgument(argument: string, source: string): string {
  const identifier = argument.trim().match(/^[A-Za-z_$][\w$]*$/);
  if (!identifier) return argument;
  const start = new RegExp(`(?:const|let|var)\\s+${identifier[0]}\\s*=`).exec(source);
  if (!start) return argument;
  const equals = source.indexOf('=', start.index);
  const end = indexOutsideStrings(source, ';', equals + 1);
  return end < 0 ? argument : source.slice(equals + 1, end);
}

/**
 * Event names the engine can write, recovered from the `addStrategyLog(id, level, event, …)` call
 * sites. The event is a literal, a (possibly chained) ternary, or an identifier bound to one; the
 * leg diagnostic contributes its two prefixes. Words that are not event names are rejected rather
 * than tolerated: only ternary arms and whole literals are accepted, never a bare operand.
 */
function collectEmittedEvents(engineSource: string): Set<string> {
  const events = new Set<string>();
  let cursor = 0;

  while ((cursor = engineSource.indexOf('addStrategyLog(', cursor)) !== -1) {
    const open = engineSource.indexOf('(', cursor);
    const args = topLevelArgs(engineSource, open);
    const event = (args[2] ?? '').trim();
    cursor = open + 1;

    if (event.includes('strategyLeg') && event.includes('leg ')) {
      events.add('Left leg <state>');
      events.add('Right leg <state>');
      continue;
    }
    for (const name of eventNamesInExpression(resolveEventArgument(event, engineSource))) {
      events.add(name);
    }
  }

  return events;
}

/**
 * Keys of `STRATEGY_LOG_EVENT_CATEGORY`. The category value is part of the pattern so the scan
 * cannot pick up unrelated `'x': 'y'` entries elsewhere in the file.
 */
function collectRegisteredEvents(sharedSource: string): Set<string> {
  const start = sharedSource.indexOf('export const STRATEGY_LOG_EVENT_CATEGORY');
  const end = sharedSource.indexOf('\n};', start);
  const block = sharedSource.slice(start, end);
  const registered = new Set<string>();

  for (const match of block.matchAll(/^\s*'([^']+)':\s*'(?:execution|risk|maker|system)',$/gm)) {
    const name = match[1];
    if (name) registered.add(name);
  }

  return registered;
}

/** A fetch-set entry matches either exactly or as a trailing-only `LIKE` prefix pattern. */
function fetchSetMatches(category: Exclude<StrategyLogCategory, 'all'>, event: string): boolean {
  return STRATEGY_LOG_CATEGORY_FETCH_EVENTS[category].some((entry) =>
    entry.endsWith('%') ? event.startsWith(entry.slice(0, -1)) : entry === event);
}

describe('leg template: keys that must NOT be localised', () => {
  it('returns undefined for every near-miss key', () => {
    for (const key of NOT_LEG_DIAGNOSTICS) {
      expect(localizeLegDiagnostic(key), `key: ${JSON.stringify(key)}`).toBeUndefined();
    }
  });

  it('passes every near-miss key through translate unchanged, or into the dictionary', () => {
    for (const key of NOT_LEG_DIAGNOSTICS) {
      const rendered = translate('zh', key);
      expect(typeof rendered, `key: ${JSON.stringify(key)}`).toBe('string');
      // "Either the dictionary owns it, or the key comes back verbatim — never mangled" is carried
      // by the two prefix assertions below: a near-miss key that the template grabbed would render
      // as `左腿…`/`右腿…`, and the sibling case above already pins `localizeLegDiagnostic(key)`
      // to `undefined` for this exact list, so no extra (and unavoidably tautological) branch is
      // added here.
      expect(rendered.startsWith('左腿'), `key: ${JSON.stringify(key)}`).toBe(false);
      expect(rendered.startsWith('右腿'), `key: ${JSON.stringify(key)}`).toBe(false);
    }
  });

  it('still localises a real UI string that shares the "Left " prefix', () => {
    // Guards against over-eager matching: these are dictionary keys, not leg diagnostics.
    expect(translate('zh', 'Left side')).toBe('左侧方向');
    expect(translate('zh', 'Left venue')).toBe('左侧交易所');
    expect(translate('zh', 'Maker leg')).toBe('挂单腿');
  });
});

describe('leg template: keys that must be localised', () => {
  it('words both sides for every enumerated state', () => {
    for (const [state, chinese] of LEG_DICTIONARY) {
      expect(translate('zh', `Left leg ${state}`)).toBe(`左腿${chinese}`);
      expect(translate('zh', `Right leg ${state}`)).toBe(`右腿${chinese}`);
    }
  });

  it('covers both shared prefixes, so the template and the registry cannot drift', () => {
    for (const prefix of STRATEGY_LOG_LEG_EVENT_PREFIXES) {
      const side = prefix.startsWith('Left') ? '左腿' : '右腿';
      expect(translate('zh', `${prefix}filled`)).toBe(`${side}已成交`);
    }
  });

  it(
    'every canonical open order state is worded, never left in English',
    () => {
      // `OPEN_ORDER_STATES` (apps/backend/src/trading-runtime.ts:363) is the authoritative set:
      // PENDING_SUBMIT, PENDING_CANCEL, NEW, OPEN, PARTIALLY_FILLED. `awaitTerminalOrder` resolves
      // with `this.getOrder(id)` when its deadline fires, so a cancel the venue never confirms is
      // persisted as `Left leg pending_cancel`. `pending_cancel` was the missing fifth; this stays
      // as a permanent guard that no canonical state falls back to its English tail.
      const canonical = ['pending_submit', 'pending_cancel', 'new', 'open', 'partially_filled'];
      for (const state of canonical) {
        const rendered = translate('zh', `Left leg ${state}`);
        expect(rendered, `Left leg ${state}`).not.toMatch(/[a-z]/);
      }
    },
  );

  it('keeps every leg event in the shared registry translated', () => {
    const legEvents = Object.keys(STRATEGY_LOG_EVENT_CATEGORY)
      .filter((event) => STRATEGY_LOG_LEG_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix)));
    expect(legEvents.length).toBeGreaterThan(0);
    for (const event of legEvents) {
      const rendered = translate('zh', event);
      expect(rendered).not.toBe(event);
      expect(rendered).toMatch(/^(左腿|右腿)/);
    }
  });
});

describe('leg template: output hygiene', () => {
  it('never renders undefined, blank, NaN or a JavaScript value for any well-formed key', () => {
    const states = [...LEG_DICTIONARY.map(([state]) => state), ...UNKNOWN_LEG_STATES];
    for (const prefix of STRATEGY_LOG_LEG_EVENT_PREFIXES) {
      for (const state of states) {
        const rendered = translate('zh', `${prefix}${state}`);
        expect(typeof rendered, `${prefix}${state}`).toBe('string');
        expect(rendered.length, `${prefix}${state}`).toBeGreaterThan(0);
        expect(rendered, `${prefix}${state}`).not.toContain('undefined');
        expect(rendered, `${prefix}${state}`).not.toContain('NaN');
        expect(rendered, `${prefix}${state}`).not.toContain('function');
        expect(rendered, `${prefix}${state}`).not.toContain('[object');
      }
    }
  });

  it('keeps an unregistered state tail verbatim after the side, separated by one space', () => {
    for (const state of UNKNOWN_LEG_STATES) {
      expect(translate('zh', `Left leg ${state}`)).toBe(`左腿 ${state}`);
      expect(translate('zh', `Right leg ${state}`)).toBe(`右腿 ${state}`);
    }
  });

  it(
    'a state tail that collides with Object.prototype must not leak a JavaScript value',
    () => {
      // Both lookup tables are plain object literals, so a bare `table[key]` walks up to
      // `Object.prototype` and `chineseLegState['constructor']` used to return the Object
      // constructor, rendering `左腿function Object() { [native code] }`. Resolved by reading own
      // properties only (`ownTranslation`); kept as a permanent guard.
      for (const hostile of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
        expect(translate('zh', `Left leg ${hostile}`)).toBe(`左腿 ${hostile}`);
      }
    },
  );
});

describe('newly worded static events', () => {
  it('translates every newly worded event into Chinese', () => {
    for (const [event, chinese] of NEWLY_WORDED) {
      expect(translate('zh', event), event).toBe(chinese);
    }
  });

  it('leaves every newly worded event verbatim in English', () => {
    for (const [event] of NEWLY_WORDED) {
      expect(translate('en', event), event).toBe(event);
    }
  });

  it('never hard-codes a number in a new label', () => {
    // Prices, quantities and bps thresholds arrive through `condition` / `quantity`; a digit baked
    // into a label goes stale the moment a threshold moves.
    for (const [, chinese] of NEWLY_WORDED) {
      expect(chinese, chinese).not.toMatch(/[0-9]/);
    }
  });

  it('gives every new label its own wording', () => {
    const labels = NEWLY_WORDED.map(([, chinese]) => chinese);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('English mode: zero regression', () => {
  it('passes every key through untouched, including the leg template', () => {
    const keys = [
      ...NEWLY_WORDED.map(([event]) => event),
      ...LEG_DICTIONARY.flatMap(([state]) => [`Left leg ${state}`, `Right leg ${state}`]),
      ...UNKNOWN_LEG_STATES.map((state) => `Left leg ${state}`),
      ...NOT_LEG_DIAGNOSTICS,
      'Left leg constructor',
      'Maker quote repriced by venue',
    ];
    for (const key of keys) {
      expect(translate('en', key), key).toBe(key);
    }
  });

  it('renders the log dialog in English without a stray Chinese label', () => {
    const html = renderDialog([PARKED, 'Left leg filled'], 'en');
    expect(html).toContain(PARKED);
    expect(html).toContain('Left leg filled');
    expect(html).not.toContain('左腿');
  });
});

describe('Chinese word order', () => {
  it('joins a known state to the side without a separator', () => {
    // `左腿已成交`, not `左腿 已成交` and not `已成交左腿`.
    for (const [state, chinese] of LEG_DICTIONARY) {
      expect(translate('zh', `Left leg ${state}`)).toBe(`左腿${chinese}`);
    }
  });

  it('keeps the side in front and the raw tail behind for an unknown state', () => {
    // `remote_not_found` is enumerated, so it is fully worded; only a genuinely unregistered tail
    // keeps its English. Both halves of the contract are asserted here so the two can never be
    // confused again — the change brief cited `左腿 remote_not_found` as the fallback example.
    expect(translate('zh', 'Left leg remote_not_found')).toBe('左腿交易所查不到该单');
    expect(translate('zh', 'Right leg remote_not_found')).toBe('右腿交易所查不到该单');
    expect(translate('zh', 'Left leg reinstated')).toBe('左腿 reinstated');
    expect(translate('zh', 'Right leg unfilled_or_unknown')).toBe('右腿 unfilled_or_unknown');
  });

  it('does not duplicate the side when the tail is already Chinese', () => {
    // The template only prefixes the side once; it never re-translates its own output.
    const once = translate('zh', 'Left leg 已成交');
    expect(once).toBe('左腿 已成交');
    expect(once.match(/左腿/g)).toHaveLength(1);
    expect(once).not.toContain('左腿左腿');
  });

  it('names exactly one side per leg row', () => {
    for (const state of ['filled', 'remote_not_found', 'unknown_1']) {
      for (const prefix of STRATEGY_LOG_LEG_EVENT_PREFIXES) {
        const rendered = translate('zh', `${prefix}${state}`);
        const sides = (rendered.match(/左腿|右腿/g) ?? []).length;
        expect(sides, rendered).toBe(1);
      }
    }
  });
});

describe('category contract for the two new maker events', () => {
  it('registers them under maker and fetches them for the maker tab', () => {
    // Fixed: both are registered as `maker` in `STRATEGY_LOG_EVENT_CATEGORY`, and
    // `STRATEGY_LOG_CATEGORY_FETCH_EVENTS.maker` is derived from that very registry, so the backend
    // selects them. While they were unregistered, `classifyStrategyLogEvent` fell back to `system`
    // yet the `system` fetch set omitted them, so the rows were invisible in every category tab —
    // the 0.3.1 "categories always empty" signature. Both halves are asserted now.
    for (const event of [PARKED, RESUMED]) {
      expect(STRATEGY_LOG_EVENT_CATEGORY[event], event).toBe('maker');
      expect(classifyStrategyLogEvent(event), event).toBe('maker');
      expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS.maker, event).toContain(event);
      expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS.system, event).not.toContain(event);
    }
  });

  it(
    'every event the frontend words is fetchable in the tab it lands in',
    () => {
      // Resolved: the two maker events are registered, so `classifyStrategyLogEvent` no longer
      // needs its `system` fallback for them. Kept as a permanent guard — any newly worded event
      // that nobody registers fails here instead of silently vanishing from every category tab.
      const worded = [...NEWLY_WORDED.map(([event]) => event)];
      for (const event of worded) {
        const category = classifyStrategyLogEvent(event);
        expect(fetchSetMatches(category, event), `${event} -> ${category}`).toBe(true);
      }
    },
  );

  it('keeps the registry and the fetch set consistent for everything already registered', () => {
    for (const category of STRATEGY_LOG_CATEGORIES) {
      if (category === 'all') continue;
      for (const entry of STRATEGY_LOG_CATEGORY_FETCH_EVENTS[category]) {
        if (entry.includes('%')) continue;
        expect(Object.keys(STRATEGY_LOG_EVENT_CATEGORY), entry).toContain(entry);
      }
    }
  });

  it('includes the leg patterns in the execution and risk fetch sets', () => {
    for (const category of ['execution', 'risk'] as const) {
      for (const prefix of STRATEGY_LOG_LEG_EVENT_PREFIXES) {
        expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS[category]).toContain(`${prefix}%`);
      }
    }
  });
});

/**
 * The seam that produced the 0.3.1 "categories always empty" incident: the frontend classifies a
 * row with `classifyStrategyLogEvent`, which falls back to `system`, but the backend only selects the
 * events listed in `STRATEGY_LOG_CATEGORY_FETCH_EVENTS[<category>]` — a set derived from the very
 * registry the fallback just missed. An event the engine can emit but nobody registered therefore
 * appears in the `all` tab (unfiltered) and is invisible in *every* category tab, with no error and
 * no log. Nothing in either package's own tests can see it, because they only filter an in-memory
 * buffer and never exercise the fetch.
 *
 * These assertions close that blind spot statically: they read both sources off disk and diff the
 * emitted set against the registered set. They read only — nothing here writes outside
 * `apps/frontend/**`.
 */
describe('backend/registry seam: every emitted event must be registered and worded', () => {
  const engineSource = readFileSync(new URL('../../../apps/backend/src/strategy-engine.ts', import.meta.url), 'utf8');
  const sharedSource = readFileSync(new URL('../../../packages/shared-types/src/index.ts', import.meta.url), 'utf8');
  const emitted = collectEmittedEvents(engineSource);
  const registered = collectRegisteredEvents(sharedSource);

  const legPrefixes: string[] = [...STRATEGY_LOG_LEG_EVENT_PREFIXES];
  const missing = [...emitted].filter((event) =>
    !registered.has(event) && !legPrefixes.some((prefix) => event.startsWith(prefix))).sort();

  it('reads a non-trivial set from both sides of the seam', () => {
    // Guards the extractor itself: a silent parse regression would otherwise make every
    // assertion below pass vacuously against empty sets.
    expect(emitted.size).toBeGreaterThan(20);
    expect(registered.size).toBeGreaterThan(20);
  });

  it(
    'registers the four reduce-only reconciliation events',
    () => {
      // Resolved: `Exit size drift` / `Exit size corrected` / `Exit quote withdrawn` are registered
      // under `maker` and `Position reconciliation failed` under `system`. Kept as a guard so a
      // further unregistered emit fails here rather than dropping out of every category tab.
      expect(missing).toEqual([]);
    },
  );

  it(
    'words the four reduce-only events in Chinese too',
    () => {
      // Separate from registration on purpose: an event can be registered yet still render
      // raw English in the Chinese UI. Both halves have to be true.
      for (const event of ['Exit size drift', 'Exit size corrected', 'Exit quote withdrawn',
        'Position reconciliation failed'] as const) {
        expect(translate('zh', event), event).not.toBe(event);
      }
    },
  );

  it('resolves event names the engine passes through a variable or a chained ternary', () => {
    // Extractor regression guard. `triggeredEvent` (strategy-engine.ts:2468) and `executedEvent`
    // (:2526) bind a four-arm chained ternary, and `Maker quote placed` / `Exit size corrected`
    // sit in inline chains. A flat `? 'A' : 'B'` regex saw only the innermost arm, so eight of
    // these were reported as registered-but-never-emitted orphans.
    for (const name of [
      'Stop-loss exit triggered', 'Take-profit triggered', 'Reduce-only triggered', 'Entry triggered',
      'Stop-loss Executed', 'Take-profit Executed', 'Reduce-only Executed', 'Position open Executed',
      'Maker quote placed', 'Maker exit quote placed', 'Exit size corrected', 'Exit quote withdrawn',
      'Strategy pause pending', 'Strategy stop pending',
    ]) {
      expect(emitted.has(name), name).toBe(true);
    }
    // …and the operator operands must not leak in as events: these are order states and intents.
    for (const operand of ['exit', 'entry', 'PAUSED', 'left', 'right']) {
      expect(emitted.has(operand), operand).toBe(false);
    }
  });

  it('flags a fabricated unregistered emit as missing (the check has teeth)', () => {
    // Drives the extractor and the diff over a source snippet instead of mutating the engine: two
    // fabricated names — one plain, one buried in a chained ternary — must both surface as
    // `missing`, while the registered names in the same snippet must not. Without this the whole
    // seam check could pass vacuously against an extractor that stopped parsing.
    const fabricated = `
      this.runtime.addStrategyLog(actor.id, 'info', 'Brand new unregistered event', '—', '—', '—');
      const hidden = kind === 'a' ? 'Brand new chained event'
        : kind === 'b' ? 'Strategy started' : 'Strategy paused';
      this.runtime.addStrategyLog(actor.id, 'info', hidden, '—', '—', '—');
    `;
    const extracted = collectEmittedEvents(fabricated);
    expect([...extracted].sort()).toEqual([
      'Brand new chained event', 'Brand new unregistered event', 'Strategy paused', 'Strategy started',
    ]);
    const missingHere = [...extracted].filter((event) => !registered.has(event)).sort();
    expect(missingHere).toEqual(['Brand new chained event', 'Brand new unregistered event']);
  });

  const orphaned = [...registered].filter((event) =>
    !emitted.has(event) && !legPrefixes.some((prefix) => event.startsWith(prefix))).sort();

  it('registers no event the engine never emits (catches typos in the table)', () => {
    // The mirror image of the check above: a registry key spelled slightly differently from the
    // emitted name is invisible in both directions — the row silently falls through to `system`.
    expect(orphaned).toEqual([]);
  });

  it('tolerated no unregistered event once the four were registered', () => {
    // Superseded the exact-match pin that listed the four reduce-only events: that list is now
    // empty, so the guard is the stronger "no tolerated list at all" instead of a fixed set. A new
    // unregistered emit fails here rather than being appended to an allow-list.
    expect(missing).toEqual([]);
    expect(orphaned).toEqual([]);
  });
});

describe('log dialog ARIA contract', () => {
  it('uses role=tab + aria-selected for the category switch, never aria-pressed', () => {
    const html = renderDialog([PARKED, 'Left leg filled'], 'zh');
    expect([...html.matchAll(/aria-pressed/g)]).toHaveLength(0);
    expect([...html.matchAll(/role="tab"/g)].length).toBeGreaterThan(0);
    expect([...html.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
  });
});

describe('result localization: untouched by this change', () => {
  it('keeps the pre-existing result wording', () => {
    expect(localizeStrategyLogResult('Filled', 'zh')).toBe('已成交');
    expect(localizeStrategyLogResult('Stopped', 'zh')).toBe('已停止');
    expect(localizeStrategyLogResult('Monitoring live spreads', 'zh')).toBe('正在监控实时价差');
    expect(localizeStrategyLogResult('Both legs fully executed and hedged', 'zh'))
      .toBe('两条分腿均已完全执行并完成对冲');
  });

  it('keeps the pre-existing global market/hedge substitution', () => {
    // Documented quirk, not a regression: the whole-word swap rewrites result text too.
    expect(localizeStrategyLogResult('Hedge order placed at market', 'zh')).toBe('对冲腿 order placed at 市价');
    expect(localizeStrategyLogResult('Hedge order placed at market', 'en')).toBe('Hedge order placed at market');
  });
});
