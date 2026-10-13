import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { TradingSession } from './trading-session.js';
import { DEFAULT_CREDENTIAL_PROFILE, MemoryCredentialVault } from './credential-vault.js';
import { TradingRuntime } from './trading-runtime.js';
import {
  STRATEGY_LOG_CATEGORY_FETCH_EVENTS,
  STRATEGY_LOG_EVENT_CATEGORY,
  STRATEGY_LOG_LEG_EVENT_PREFIXES,
  type StrategyLogCategory,
} from '@gate-crossex/shared-types';

/**
 * Regression cover for the "category tab is always empty" defect shape (0.3.1, and again for the
 * four reduce-only reconciliation events): a row reaches the unfiltered `all` tab but is invisible
 * in every category tab, because the tab asks the backend for a category whose SQL `event IN (...)`
 * set is derived from `STRATEGY_LOG_EVENT_CATEGORY` — and the event was never registered there.
 *
 * The existing frontend tests only exercised the in-memory `prepareStrategyLogView` buffer, so the
 * real fetch path never ran in a test. Everything here goes through the real SQL.
 */

// ---------------------------------------------------------------------------------------------
// 1. Static seam: every event the backend can emit must be registered.
// ---------------------------------------------------------------------------------------------

const BACKEND_SRC = fileURLToPath(new URL('./', import.meta.url));

/**
 * The leg diagnostic is the one dynamic event shape: `` `${Left|Right} leg ${state}` ``. It is
 * covered by `STRATEGY_LOG_LEG_EVENT_PREFIXES` (and by the SQL `LIKE` patterns derived from them),
 * so it is checked against the prefixes instead of the exact-name table.
 */
const LEG_TEMPLATE_MARKER = 'leg ${';

/** Every literal `addStrategyLog` event name we know is emitted, as a self-check on the scanner. */
const MINIMUM_EMITTED_EVENTS = 30;

/**
 * Deliberate exceptions: emitted event names that are intentionally not in the registry.
 * Empty on purpose — a new event must be registered in the same change that emits it, otherwise the
 * category tabs silently lose it. Add a name here only with a comment explaining the exception.
 */
const UNREGISTERED_EMIT_EXCEPTIONS: readonly string[] = [];

/** Split a call's argument list on top-level commas, honouring strings and nested brackets. */
function topLevelArgs(source: string, openParen: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (let index = openParen + 1; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (quote) {
      current += character;
      if (character === '\\') {
        current += source[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    if (character === ')' || character === ']' || character === '}') {
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      depth -= 1;
    }
    if (character === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }

  args.push(current.trim());
  return args;
}

/**
 * Event names inside one `event` argument expression. Every quoted literal counts except the two
 * shapes that are never event names: comparison operands (`x === 'entry'`) and template
 * interpolations (`` `${flag ? 'Left' : 'Right'} leg ...` ``).
 */
function eventNamesIn(argument: string, source: string): string[] {
  const names: string[] = [];
  const literals = argument.match(/'([^']*)'/g) ?? [];
  for (const literal of literals) {
    const value = literal.slice(1, -1);
    if (value.length === 0) continue;
    const before = argument.slice(0, argument.indexOf(literal));
    // Inside a template interpolation: `${…}` opened and not yet closed before this literal.
    if (before.lastIndexOf('${') > before.lastIndexOf('}')) continue;
    // A comparison operand: `intent === 'exit'`, `state !== 'FAIL'`.
    if (/(?:===|!==|==|!=)\s*$/.test(before)) continue;
    names.push(value);
  }
  if (names.length > 0) return names;

  // No literal at all: the argument is a variable holding a ternary. Resolve it from its
  // declaration so both branches are still checked.
  const identifier = argument.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
  if (!identifier) return names;
  const declaration = new RegExp(`(?:const|let|var)\\s+${identifier}\\s*(?::[^=;]+)?=\\s*([\\s\\S]*?);`);
  const expression = source.match(declaration)?.[1];
  return expression ? eventNamesIn(expression, source) : names;
}

/** Every event name (or leg template) the backend's `addStrategyLog` call sites can write. */
function collectEmittedEvents(): { names: Set<string>; legTemplates: number; callSites: number } {
  const names = new Set<string>();
  let legTemplates = 0;
  let callSites = 0;

  for (const file of readdirSync(BACKEND_SRC).filter((entry) => entry.endsWith('.ts') && !entry.includes('.test.'))) {
    const source = readFileSync(join(BACKEND_SRC, file), 'utf8');
    let cursor = source.indexOf('addStrategyLog(');
    while (cursor !== -1) {
      const open = source.indexOf('(', cursor);
      const args = topLevelArgs(source, open);
      cursor = source.indexOf('addStrategyLog(', open + 1);
      // `addStrategyLog(fn): void {` is the declaration itself, not a call site.
      if (args.length < 6 || args[2]?.startsWith('event:')) continue;
      callSites += 1;
      const eventArgument = args[2] ?? '';
      if (eventArgument.includes(LEG_TEMPLATE_MARKER)) {
        legTemplates += 1;
        continue;
      }
      for (const name of eventNamesIn(eventArgument, source)) names.add(name);
    }
  }

  return { names, legTemplates, callSites };
}

/**
 * `@gate-crossex/shared-types` resolves to its built `dist/index.js` (its `main`), and no tsconfig
 * `paths` alias exists, so this suite must also compare the shipped artifact against the source
 * devs edit — otherwise "edited src, forgot `npm run build:packages`" silently passes here while
 * the running backend still selects the old fetch set.
 */
const SHARED_REGISTRY_SOURCE = fileURLToPath(new URL('../../../packages/shared-types/src/index.ts', import.meta.url));

function collectSourceRegistry(): Map<string, string> {
  const source = readFileSync(SHARED_REGISTRY_SOURCE, 'utf8');
  const start = source.indexOf('export const STRATEGY_LOG_EVENT_CATEGORY');
  const block = source.slice(start, source.indexOf('\n};', start));
  const entries = new Map<string, string>();
  for (const match of block.matchAll(/^\s*'([^']+)':\s*'(execution|risk|maker|system)',$/gm)) {
    const [name, category] = [match[1], match[2]];
    if (name && category) entries.set(name, category);
  }
  return entries;
}

describe('QA: backend event registry seam', () => {
  const { names, legTemplates, callSites } = collectEmittedEvents();

  it('ships the registry the source declares (no unbuilt shared-types change)', () => {
    const source = collectSourceRegistry();
    expect(source.size).toBeGreaterThan(40);
    expect([...source.entries()].sort()).toEqual([...Object.entries(STRATEGY_LOG_EVENT_CATEGORY)].sort());
  });

  it('recovers a non-trivial event set from the backend sources', () => {
    // Guards the scanner itself: a parse regression must not make the contract below pass vacuously.
    expect(callSites).toBeGreaterThan(30);
    expect(names.size).toBeGreaterThanOrEqual(MINIMUM_EMITTED_EVENTS);
    expect(legTemplates).toBeGreaterThan(0);
    expect([...names]).toContain('Maker quoting parked');
    expect([...names]).toContain('Exit size drift');
  });

  it('registers every event the backend can emit', () => {
    const unregistered = [...names]
      .filter((event) => STRATEGY_LOG_EVENT_CATEGORY[event] === undefined)
      .filter((event) => !UNREGISTERED_EMIT_EXCEPTIONS.includes(event))
      .sort();
    // A name here means the event lands in the `all` tab only: the category tab derives its SQL
    // `event IN (...)` from `STRATEGY_LOG_EVENT_CATEGORY`, so an unregistered name is unfetchable.
    expect(unregistered).toEqual([]);
  });

  it('leaves no stale exception in the list', () => {
    expect(UNREGISTERED_EMIT_EXCEPTIONS.filter((event) => STRATEGY_LOG_EVENT_CATEGORY[event] === undefined)).toEqual([]);
  });

  it('maps every emitted event into a fetch set that can select it', () => {
    for (const event of names) {
      const category = STRATEGY_LOG_EVENT_CATEGORY[event];
      if (category === undefined) continue; // reported by the case above
      expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS[category], `${event} -> ${category}`).toContain(event);
    }
  });

  it('covers the dynamic leg diagnostic through the shared prefixes', () => {
    for (const prefix of STRATEGY_LOG_LEG_EVENT_PREFIXES) {
      const pattern = `${prefix}%`;
      expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS.execution).toContain(pattern);
      expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS.risk).toContain(pattern);
    }
    // The registry must not also enumerate a leg name without the template being emitted, and the
    // other direction is covered by the frontend's orphan check.
    expect(STRATEGY_LOG_EVENT_CATEGORY['Left leg filled']).toBe('execution');
  });

  it('derives the fetch set from the registry instead of a hand-written second table', () => {
    for (const category of ['execution', 'risk', 'maker', 'system'] as const) {
      const derived = Object.keys(STRATEGY_LOG_EVENT_CATEGORY)
        .filter((event) => STRATEGY_LOG_EVENT_CATEGORY[event] === category);
      for (const event of derived) {
        expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS[category], `${event} -> ${category}`).toContain(event);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Real SQL evidence: a registered event is actually selectable through the fetch path.
// ---------------------------------------------------------------------------------------------

interface Harness {
  database: ReturnType<typeof openDatabase>;
  runtime: TradingRuntime;
  directory: string;
}

const harnesses: Harness[] = [];

function createHarness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'gct-log-category-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: fileURLToPath(new URL('../../../migrations', import.meta.url)),
  });
  const database = openDatabase(config.databasePath, config.migrationsDir);
  const session = new TradingSession();
  session.set('live');
  const vault = new MemoryCredentialVault();
  // Nothing in this suite submits orders; the runtime only needs a gateway object to construct.
  const runtime = new TradingRuntime(database, session, vault, {} as never, {});
  const harness = { database, runtime, directory };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

function seedStrategy(harness: Harness, id: string): void {
  const now = new Date().toISOString();
  harness.database.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json,
    progress, filled_quantity, filled_left, filled_right, open_position, created_at, updated_at, stopped_at)
    VALUES (?, 'premium', 'live', 'RUNNING', '{}', 0, '0', '0', '0', '0', ?, ?, NULL)`).run(id, now, now);
}

function insertLog(harness: Harness, row: { id: string; strategyId: string; event: string; createdAt: string }): void {
  harness.database.prepare(`INSERT INTO execution_strategy_logs
    (id, strategy_id, level, event, condition_text, quantity, result_text, created_at)
    VALUES (?, ?, 'info', ?, 'condition', '1', 'result', ?)`)
    .run(row.id, row.strategyId, row.event, row.createdAt);
}

function logEvents(harness: Harness, strategyId: string, category: StrategyLogCategory, limit = 50): string[] {
  return harness.runtime.strategyLogPage(strategyId, { category, limit }).logs.map((row) => row.event);
}

/** The four reduce-only reconciliation events this change registered, with their buckets. */
const REDUCE_ONLY_EVENTS: ReadonlyArray<readonly [event: string, category: 'maker' | 'system']> = [
  ['Exit size drift', 'maker'],
  ['Exit size corrected', 'maker'],
  ['Exit quote withdrawn', 'maker'],
  ['Position reconciliation failed', 'system'],
];

describe('QA: reduce-only reconciliation events are fetchable through the real SQL path', () => {
  it('returns each of them from its own category tab', () => {
    const harness = createHarness();
    const strategyId = 'QA-CAT-FETCH-1';
    seedStrategy(harness, strategyId);
    let minute = 0;
    for (const [event] of REDUCE_ONLY_EVENTS) {
      insertLog(harness, {
        id: `log-${minute}`,
        strategyId,
        event,
        createdAt: new Date(Date.UTC(2026, 0, 5, 0, minute, 0)).toISOString(),
      });
      minute += 1;
    }

    // `all` is the control: the rows exist and the unfiltered scan returns them.
    const all = logEvents(harness, strategyId, 'all');
    for (const [event] of REDUCE_ONLY_EVENTS) expect(all, `all <- ${event}`).toContain(event);

    for (const [event, category] of REDUCE_ONLY_EVENTS) {
      const fetched = logEvents(harness, strategyId, category);
      expect(fetched, `${event} must be visible in the ${category} tab`).toContain(event);
      // …and only in its own bucket: the fetch set must not leak across categories.
      for (const other of ['maker', 'system', 'execution', 'risk'] as const) {
        if (other === category) continue;
        expect(logEvents(harness, strategyId, other), `${event} must not appear in the ${other} tab`).not.toContain(event);
      }
    }
  });

  it('classifies them the way the tabs will show them', () => {
    expect(STRATEGY_LOG_EVENT_CATEGORY['Exit size drift']).toBe('maker');
    expect(STRATEGY_LOG_EVENT_CATEGORY['Exit size corrected']).toBe('maker');
    expect(STRATEGY_LOG_EVENT_CATEGORY['Exit quote withdrawn']).toBe('maker');
    expect(STRATEGY_LOG_EVENT_CATEGORY['Position reconciliation failed']).toBe('system');
  });

  it('filters by category before LIMIT, so an old row is not pushed out by newer other-category rows', () => {
    const harness = createHarness();
    const strategyId = 'QA-CAT-FETCH-2';
    seedStrategy(harness, strategyId);

    // 30 newer rows in the wrong bucket, then one older row from the maker bucket.
    for (let index = 0; index < 30; index += 1) {
      insertLog(harness, {
        id: `noise-${index}`,
        strategyId,
        event: 'Strategy started',
        createdAt: new Date(Date.UTC(2026, 0, 6, 0, index, 0)).toISOString(),
      });
    }
    insertLog(harness, {
      id: 'old-maker-row',
      strategyId,
      event: 'Exit size drift',
      createdAt: '2026-01-05T00:00:00.000Z',
    });

    // A page of 5 newest rows is entirely `Strategy started`. If the category filter ran after
    // `LIMIT` (or in JS), this page would be empty; filtering inside the SQL WHERE keeps the row.
    const makerPage = harness.runtime.strategyLogPage(strategyId, { category: 'maker', limit: 5 });
    expect(makerPage.logs.map((row) => row.event)).toEqual(['Exit size drift']);
    expect(makerPage.hasMore).toBe(false);
    expect(logEvents(harness, strategyId, 'system', 5)).toHaveLength(5);
  });

  it('keeps a category page honest when the matched rows exceed the limit', () => {
    const harness = createHarness();
    const strategyId = 'QA-CAT-FETCH-3';
    seedStrategy(harness, strategyId);
    for (let index = 0; index < 7; index += 1) {
      insertLog(harness, {
        id: `row-${index}`,
        strategyId,
        event: 'Exit size corrected',
        createdAt: new Date(Date.UTC(2026, 0, 7, 0, index, 0)).toISOString(),
      });
    }

    const page = harness.runtime.strategyLogPage(strategyId, { category: 'maker', limit: 5 });
    expect(page.logs).toHaveLength(5);
    expect(page.hasMore).toBe(true);
    expect(page.logs.every((row) => row.event === 'Exit size corrected')).toBe(true);
  });
});
