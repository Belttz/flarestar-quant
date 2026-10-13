import { describe, expect, it } from 'vitest';
import {
  STRATEGY_LOG_CATEGORY_FETCH_EVENTS,
  STRATEGY_LOG_EVENT_CATEGORY,
  STRATEGY_LOG_LEG_EVENT_PREFIXES,
} from '@gate-crossex/shared-types';
import { localizeLegDiagnostic, translate } from './i18n.js';

/**
 * QA-i18n-v2 adversarial verdict suite (Edward / 严过关).
 *
 * This file owns ONE question: does the event extractor in
 * `qa-strategy-log-i18n.test.tsx` actually have teeth, or did the delivery weaken the
 * seam check until it is guaranteed green? It copies the extractor's helpers verbatim and
 * drives them over FIXTURE source strings — never the real backend file, which another
 * engineer is editing right now.
 *
 * A green run of the delivery's own tests cannot answer that: the extractor under test and
 * the extractor driving the test are the same code. The only way to falsify it is to feed it
 * shapes the delivery never showed it and confirm it either captures every branch (teeth) or
 * silently drops one (no teeth).
 *
 * Everything here reads only fixture strings defined below; nothing touches disk or the
 * backend tree.
 */

/* --------------------------------------------------------------------------------------------
 * Extractor helpers — copied verbatim from apps/frontend/src/qa-strategy-log-i18n.test.tsx so
 * the thing under test is exactly the shipped logic, bugs included.
 * ------------------------------------------------------------------------------------------ */

/** Split a call's arguments on top-level commas only. */
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

/** Every event name a `? :` chain can evaluate to, walking the chain arm by arm. */
function eventNamesInExpression(expression: string): string[] {
  const direct = literalEventName(expression);
  if (direct !== null) return direct.length > 0 ? [direct] : [];

  const question = indexOutsideStrings(expression, '?', 0);
  if (question < 0 || expression[question + 1] === '.') return [];

  const colon = indexOutsideStrings(expression, ':', question + 1);
  if (colon < 0) return eventNamesInExpression(expression.slice(question + 1));
  return [
    ...eventNamesInExpression(expression.slice(question + 1, colon)),
    ...eventNamesInExpression(expression.slice(colon + 1)),
  ];
}

/** Read the declaration body of a bare identifier argument back out of the file. */
function resolveEventArgument(argument: string, source: string): string {
  const identifier = argument.trim().match(/^[A-Za-z_$][\w$]*$/);
  if (!identifier) return argument;
  const start = new RegExp(`(?:const|let|var)\\s+${identifier[0]}\\s*=`).exec(source);
  if (!start) return argument;
  const equals = source.indexOf('=', start.index);
  const end = indexOutsideStrings(source, ';', equals + 1);
  return end < 0 ? argument : source.slice(equals + 1, end);
}

/** Event names the engine can write, recovered from `addStrategyLog(id, level, event, …)`. */
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

/** Keys of `STRATEGY_LOG_EVENT_CATEGORY`, limited to the registry block. */
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
function fetchSetMatches(category: 'execution' | 'risk' | 'maker' | 'system', event: string): boolean {
  return STRATEGY_LOG_CATEGORY_FETCH_EVENTS[category].some((entry) =>
    entry.endsWith('%') ? event.startsWith(entry.slice(0, -1)) : entry === event);
}

/* --------------------------------------------------------------------------------------------
 * Fixtures. Deliberately hostile: a 4-arm chain behind a bare identifier, an inline
 * `: cond ? 'X' : 'Y'` arm, the dynamic leg template, and a name registered nowhere.
 * ------------------------------------------------------------------------------------------ */

const ENGINE_FIXTURE = [
  '  const ghostEvent = kind === \'a\' ? \'Ghost alpha\'',
  '    : kind === \'b\' ? \'Ghost beta\'',
  '    : kind === \'c\' ? \'Ghost gamma\' : \'Ghost delta\';',
  '  this.runtime.addStrategyLog(actor.id, \'info\', ghostEvent, \'—\', \'—\', \'—\');',
  '  this.runtime.addStrategyLog(actor.id, \'info\',',
  '    kind === \'x\' ? \'Ghost left inline\' : \'Ghost right inline\', \'—\', \'—\', \'—\');',
  '  this.runtime.addStrategyLog(actor.id, \'info\',',
  '    `${order.strategyLeg === \'left\' ? \'Left\' : \'Right\'} leg ${order.state.toLowerCase()}`',
  '    , \'—\', \'—\', \'—\');',
  '  this.runtime.addStrategyLog(actor.id, \'info\', \'Ghost exit\', \'—\', \'—\', \'—\');',
].join('\n');

const CHAIN_ARMS = ['Ghost alpha', 'Ghost beta', 'Ghost gamma', 'Ghost delta'];
const INLINE_ARMS = ['Ghost left inline', 'Ghost right inline'];
const LEG_TEMPLATES = ['Left leg <state>', 'Right leg <state>'];
const GHOST_ONLY = 'Ghost exit';
/** The two fixture arms the registry below actually registers; everything else is unregistered. */
const REGISTERED_ARMS = ['Ghost alpha', 'Ghost beta'];
const UNREGISTERED = [...CHAIN_ARMS, ...INLINE_ARMS, GHOST_ONLY].filter((event) => !REGISTERED_ARMS.includes(event));

const SHARED_FIXTURE = [
  'export const STRATEGY_LOG_EVENT_CATEGORY: Record<string, StrategyLogEventCategory> = {',
  "  'Strategy started': 'system',",
  "  'Ghost alpha': 'maker',",
  "  'Ghost beta': 'maker',",
  "  'Legacy never emitted': 'system',",
  '};',
  '',
  'export const STRATEGY_LOG_CATEGORY_FETCH_EVENTS = {',
  "  maker: ['Ghost alpha', 'Ghost beta'],",
  '};',
].join('\n');

const LEG_PREFIXES: string[] = [...STRATEGY_LOG_LEG_EVENT_PREFIXES];

/* --------------------------------------------------------------------------------------------
 * The teeth tests.
 * ------------------------------------------------------------------------------------------ */

describe('qa-i18n-v2: the extractor has teeth on a hostile fixture', () => {
  const emitted = collectEmittedEvents(ENGINE_FIXTURE);
  const registered = collectRegisteredEvents(SHARED_FIXTURE);
  const missing = [...emitted]
    .filter((event) => !registered.has(event) && !LEG_PREFIXES.some((prefix) => event.startsWith(prefix)))
    .sort();
  const orphaned = [...registered]
    .filter((event) => !emitted.has(event) && !LEG_PREFIXES.some((prefix) => event.startsWith(prefix)))
    .sort();

  it('captures EVERY arm of a 4-level chain bound to a bare identifier', () => {
    // The delivery's own fabricated fixture only exercises a 2-level chain. A three-deep
    // `: cond ? 'X' : 'Y'` chain is the shape a flat `? 'A' : 'B'` regex silently truncates.
    for (const arm of CHAIN_ARMS) {
      expect(emitted.has(arm), `chain arm: ${arm}`).toBe(true);
    }
  });

  it('captures every arm of an inline chain passed straight as the event argument', () => {
    for (const arm of INLINE_ARMS) {
      expect(emitted.has(arm), `inline arm: ${arm}`).toBe(true);
    }
  });

  it('normalises the dynamic leg template into Left/Right placeholders', () => {
    expect(emitted.has('Left leg <state>')).toBe(true);
    expect(emitted.has('Right leg <state>')).toBe(true);
    // The raw template must never be collected as an event name.
    for (const raw of emitted) expect(raw).not.toContain('${');
  });

  it('collects the whole fixture set with no false positives and no drops', () => {
    expect([...emitted].sort()).toEqual([...CHAIN_ARMS, ...INLINE_ARMS, ...LEG_TEMPLATES, GHOST_ONLY].sort());
  });

  it('never lets a ternary operand leak in as an event name', () => {
    for (const operand of ['left', 'right', 'a', 'b', 'c', 'x', 'kind']) {
      expect(emitted.has(operand), `operand: ${operand}`).toBe(false);
    }
  });

  it('reads the registry block only, never a neighbouring fetch-set array', () => {
    // `maker: ['Ghost alpha', 'Ghost beta']` re-uses the same literals; the scan must not
    // double-count or pick them up as registry entries outside the block.
    expect([...registered].sort()).toEqual(['Ghost alpha', 'Ghost beta', 'Legacy never emitted', 'Strategy started']);
  });

  it('flags the deliberately unregistered fixture names as missing (the seam diff bites)', () => {
    expect(missing).toEqual([...UNREGISTERED].sort());
    expect(missing).toContain(GHOST_ONLY);
    // …and the registered fixture names must NOT be flagged.
    expect(missing).not.toContain('Ghost alpha');
    expect(missing).not.toContain('Ghost beta');
  });

  it('flags a registered-but-never-emitted name as orphaned (the mirror check bites)', () => {
    expect(orphaned).toContain('Legacy never emitted');
    expect(orphaned).not.toContain('Ghost alpha');
  });
});

describe('qa-i18n-v2: the extractor refuses to accept a non-event operand', () => {
  it('returns nothing for a bare identifier with no matching declaration', () => {
    const emitted = collectEmittedEvents('this.runtime.addStrategyLog(actor.id, \'info\', mystery, \'—\', \'—\', \'—\');');
    expect([...emitted]).toEqual([]);
  });

  it('does not treat the optional-chaining `?.` as a ternary', () => {
    const emitted = collectEmittedEvents('this.runtime.addStrategyLog(actor.id, \'info\', a?.b, \'—\', \'—\', \'—\');');
    expect([...emitted]).toEqual([]);
  });

  it('does not read a later declaration when the identifier is undefined at the call', () => {
    // `resolveEventArgument` searches forward from file start, so a later `const` would be
    // found; this pins today's behaviour so a future change to that search is visible.
    const source = [
      'this.runtime.addStrategyLog(actor.id, \'info\', later, \'—\', \'—\', \'—\');',
      "const later = flag ? 'Ghost later A' : 'Ghost later B';",
    ].join('\n');
    expect([...collectEmittedEvents(source)].sort()).toEqual(['Ghost later A', 'Ghost later B']);
  });
});

/* --------------------------------------------------------------------------------------------
 * The five re-worded event names: verified against the backend call sites (read-only) and the
 * live translation table.
 * ------------------------------------------------------------------------------------------ */

describe('qa-i18n-v2: the five newly worded events translate and classify as claimed', () => {
  const EXPECTED: ReadonlyArray<readonly [event: string, chinese: string, category: string]> = [
    ['Exit size drift', '平仓被交易所拒绝，正在核对真实持仓', 'maker'],
    ['Exit size corrected', '已按交易所真实持仓修正平仓数量', 'maker'],
    ['Exit quote withdrawn', '交易所已无可平仓位，撤销平仓挂单', 'maker'],
    ['Maker exit fallback', '挂单平仓超时，改用兜底价格平仓', 'risk'],
    ['Position reconciliation failed', '与交易所核对持仓失败', 'system'],
  ];

  it('renders the exact Chinese the backend scenario calls for, and nothing else', () => {
    for (const [event, chinese] of EXPECTED) {
      expect(translate('zh', event), event).toBe(chinese);
      expect(translate('en', event), event).toBe(event);
      expect(chinese).not.toMatch(/[0-9]/);
    }
  });

  it('classifies each event into a tab that actually fetches it', () => {
    for (const [event, , category] of EXPECTED) {
      expect(STRATEGY_LOG_EVENT_CATEGORY[event], event).toBe(category);
      expect(fetchSetMatches(category as 'maker' | 'risk' | 'system', event), event).toBe(true);
    }
  });

  it('never folds two distinct reconciliation outcomes into the same wording', () => {
    const labels = EXPECTED.map(([, chinese]) => chinese);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('qa-i18n-v2: leg template hygiene holds under adversarial keys', () => {
  it('never hands back a non-string for a prototype-colliding tail', () => {
    for (const hostile of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      const rendered = translate('zh', `Left leg ${hostile}`);
      expect(typeof rendered).toBe('string');
      expect(rendered).toBe(`左腿 ${hostile}`);
    }
  });

  it('leaves a bare side and a near-miss key untouched', () => {
    expect(localizeLegDiagnostic('Left leg')).toBeUndefined();
    expect(localizeLegDiagnostic('Left legacy')).toBeUndefined();
    expect(translate('zh', 'Left leg')).toBe('Left leg');
  });
});
