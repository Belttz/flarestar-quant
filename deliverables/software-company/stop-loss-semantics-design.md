# Auto Stop-Loss Semantics — Design & Options

**Repo:** `gate-crossex` · **Area:** `apps/backend/src/strategy-engine.ts` (`kind: 'auto'`)
**Scope:** design only — no source code is changed by this document.
**Status:** **Decided.** Per the user's final call: **Option A REJECTED** (stop-loss semantics stay absolute — closes O1/O2 in §7); **Option B APPROVED** (B1 + B2, gate including the maker path — resolves O3; O4 resolved: gate simply refuses future entries, no pause); **Option C APPROVED** (C1 + C2). A second increment was approved in the same breath: **laddered add-on entries (阶梯加仓)** — see the appended **§8** (design) and **§9** (consolidated implementation + test plan). **Follow-up decision (final): the ladder must be supported on `MAKER_TAKER` as well as `TAKER_TAKER` ("一起做，两种都支持")** — §8.5 was rewritten from "reject on maker" to a real maker-path ladder design, the `add_on_step_maker_unsupported` error code was removed, and §9 gained the maker-ladder steps/tests. §0–§7 below are **unchanged and still authoritative** for the defect itself.
**Root version:** `0.3.1` (root `package.json`). Do **not** bump; if ever needed, change the root `package.json` `version` and run `npm run version:sync`.

---

## 0. Verification of the assigned facts

Every file:line cited in the task brief was re-checked against the working tree. **All match**, with two immaterial refinements:

| Claim | Verified? | Note |
|---|---|---|
| `maybeTriggerAutoStopLoss()` starts `:1667`, `adverse` at `:1677` | ✅ | `entrySpreadBps(actor.config)` re-derived **live each tick** at `:1673` (variable named `entry` but it is the *current* spread — a second, latent readability bug worth fixing while here) |
| `evaluateTakerClip()` starts `:2086`, entry condition `:2096-2097` | ✅ | unbounded above for positive `entryBps` |
| `entrySpreadBps()` `:1574-1586`, `exitSpreadBps()` `:1588-1600` | ✅ | entry = `(sellLeg.bid − buyLeg.ask)/buyLeg.ask`; exit = `(sellLeg.ask − buyLeg.bid)/buyLeg.bid` |
| take-profit exit `exitSpread.lte(takeProfitBps)` `:2109` | ✅ | profiting = convergence |
| Test `strategy-engine.test.ts:2144-2177` "closes both legs and stops…" | ✅ | entry spread 150 bps > stopLossBps 30; then 150→40 = convergence, yet stop fires |
| `StrategyActor` interface + `stopLossArmed` | ✅ | interface spans **`:78-106`** (brief said 80-105); `stopLossArmed` declared `:99`, init `:824`; **7 references total** (`:99,824,1436,1641,1647,1669,1679`) — all in `strategy-engine.ts`, **never persisted** |
| `checkCompletion()` auto branch `:1436-1453`, STOPPED write `:1445-1446` | ✅ | only `status/open_position/stopped_at/updated_at` written |
| Validation precedent `:516-520` (`take_profit_must_be_below_entry`, 400) | ✅ | `StrategyEngineError` extends `TradingRuntimeError` (`:305`) |
| `shared-types/src/index.ts` `entryBps:1078`, `takeProfitBps:1079`, `stopLossBps:1081` | ✅ | `stopLossBps` is `z.number().gt(0).optional()` (a **number**, vs text schemas for the others) |
| `executeTakerClip()` `:2140`, `triggeredEvent :2163`, `executedEvent :2202` | ✅ | labels chosen by `intent` only |
| `continueAutoStopLossExit()` `:1689` | ✅ | unwinds in `perOrderQuantity` clips |

**One correction to the brief:** `StrategyActor` interface is `:78-106`, not `:80-105`. Immaterial to the conclusion.

Two extra facts that shape the design (not in the brief):

1. **The durable ledger already stores an executed average price, but the strategy query does not select it.** `execution_orders.executed_average_price TEXT` exists (`migrations/0006_execution_runtime.sql:16`), yet `strategyOrderRowsStatement` (`strategy-engine.ts:345`) selects only `strategy_leg, symbol, side, quantity, executed_quantity, strategy_clip, reduce_only`. So an entry reference spread **cannot** be reconstructed post-restart today without widening that SELECT.
2. **There is a ready precedent for persisting in-memory runtime state:** `execution_strategies.metrics_json TEXT` (`migrations/0021_strategy_carry_metrics.sql`), written by `persistCarryMetrics()` (`strategy-engine.ts:1934-1956`) via `runtime.updateStrategyMetrics`. Option A can reuse this shape instead of adding a new column.

---

## 1. Problem statement

The `auto` (cross-venue spread) stop-loss compares the **live** spread against the **absolute** `stopLossBps`, ignoring where the position actually entered.

```ts
// strategy-engine.ts:1675-1677  (inside maybeTriggerAutoStopLoss, :1667)
const entryLevel = new Decimal(actor.config.entryBps ?? '0');
const stop = new Decimal(stopLoss);
const adverse = entryLevel.gte(0) ? entry.spread.gte(stop) : entry.spread.lte(stop.neg());
```

`entryLevel` is used **only for its sign**; its magnitude is discarded. But entry requires the spread to have already reached `entryBps`:

```ts
// strategy-engine.ts:2096-2097  (inside evaluateTakerClip, :2086)
const entryTriggered = entry !== null
  && (entryLevel.gte(0) ? entry.spread.gte(entryLevel) : entry.spread.lte(entryLevel));
```

Entry is **unbounded above** for positive `entryBps`, and the trade profits on **convergence** (`exitSpread.lte(takeProfitBps)`, `:2109`), so widening is the adverse direction. Two failure modes follow:

| # | Failure mode | Mechanism | Config example |
|---|---|---|---|
| **(a)** | Effective stop distance = **`stopLossBps − entryBps`**, not `stopLossBps` | You only enter at `spread ≥ entryBps`; the stop fires at `spread ≥ stopLossBps`. Room = `stopLossBps − entryBps`. | `entryBps=65 / stopLossBps=100` → stopped after **35 bps**, not 100 |
| **(b)** | Entering while the live gap already `≥ stopLossBps` stops out on the **very next tick** | Entry has no upper bound, so a position can open with `spread` already past the stop; the next `maybeTriggerAutoStopLoss()` sees `adverse=true` immediately. | gap = 150 bps, `stopLossBps=100` → instant stop-out |

The repo's own test **encodes the bug as intended behaviour**: `strategy-engine.test.ts:2144-2177` enters at 150 bps with `stopLossBps=30` (failure mode b already present at entry), then moves 150→40 (a **convergence**) and asserts the stop fires because `40 ≥ 30` (absolute). Both failure modes live in that single test.

**Production evidence** (live DB, strategy `AUTO-1CCEAE53`, XDP):

| Trigger spread (bps) | Configured `stopLossBps` | Overshoot |
|---|---|---|
| 103.64 | 100 | 3.64 |
| 141.45 | 100 | 41.45 |
| 182.40 | 150 | 32.40 |
| 447.89 | 150 | 297.89 |

Trigger rows are labelled `Spread <X> bps hit the <Y> bps stop-loss` (`:1681`) — an **absolute** statement. Operators read the stop as "no more than Y bps from the entry level", which is not what the config delivers. The large overshoots (esp. 447.89) are a separate, expected polling artifact: the gap can jump past the threshold between ticks; fixing the semantics does **not** remove that.

**Cosmetic companion:** a stop-loss exit is logged by `executeTakerClip` as `Take-profit triggered` / `Take-profit Executed` (`:2163`, `:2202`) because the labels depend only on `intent === 'exit'`. A stop-loss run therefore emits `Stop-loss triggered` (warning) **and** two `Take-profit…` info lines, with the stop-loss reason passed as the `condition`.

---

## 2. Candidate fixes

### Option A — entry-relative (drawdown) stop

Stop when the spread has moved `stopLossBps` **against the entry**, not against zero.

**Semantics.** Latch an entry-reference spread `entryRef` and stop when:

```text
entryBps >= 0 :  liveSpread >= entryRef + stopLossBps     (gap widened by stopLossBps)
entryBps <  0 :  liveSpread <= entryRef - stopLossBps     (opening cost widened by stopLossBps)
```

**When the snapshot is taken.** Recommended: on the **first tick where the position is fully matched** — same latch point carry already uses (`:1722-1730`, `if (state.basisEntryBps === null)` guarded by `matched.gt(EPSILON)`). For auto that is the first tick inside `maybeTriggerAutoStopLoss()`/`evaluateTakerClip()` where `matchedQuantity(exposure) > QUANTITY_EPSILON` and the leg imbalance `≈ 0`. At that tick `entrySpreadBps(config)` is read once and frozen. This is deliberately **not** the config `entryBps`: the realised fill can be far from the trigger (that is exactly the 150 bps entry in the existing test).

Three reference definitions to choose from:

| Ref definition | Pros | Cons |
|---|---|---|
| **A1** Live spread at first fully-matched tick | Simplest; one read; mirrors carry | Slightly off the true fill (uses current book, not fills); one-tick latency |
| **A2** Derived from both legs' `executedAveragePrice` | Exact entry basis; survives restart via the ledger | Requires the fill prices (see persistence below); multiple clips need weighting |
| **A3** Volume-weighted across all entry clips until flat | Most accurate for accumulating entries | Most code; needs a running weighted mean; multi-clip complexity |

**Partially-filled entry.** Do **not** latch until the imbalance is `≈ 0` (the entry clip is hedged and the repair loop has topped up the lagging leg, `:2344`). If the entry never balances (a leg keeps failing), the stop cannot arm on a reference and the strategy should keep its current safety behaviour (pause-on-failure path, `:2192-2194`). Because the reference is latched only once (`if (entryRef === null)`), later top-ups do not move it.

**Restart / persistence.** Today `stopLossArmed` (and any `entryRef`) is in-memory only; a restart re-attaches RUNNING actors via `activatePersistedStrategies()` (`:419-431`) / `attach()` (`:813`) with a blank actor. Three viable strategies, in increasing durability:

| Approach | Mechanism | Migration? |
|---|---|---|
| **A-p1 fallback** | If `entryRef === null` after restart, treat the strategy as **un-armed and keep the current absolute rule** for this session | none |
| **A-p2 re-derive** | Add `executed_average_price` to `strategyOrderRowsStatement` (`:345`); compute `entryRef` from the filled **entry** clips (rows where `reduce_only = 0`) as a weighted mean of `(sellLegAvg − buyLegAvg)/buyLegAvg` | none (column exists) |
| **A-p3 persist** | Serialise `{ entryRef, armed }` into `metrics_json` exactly like carry (`persistCarryMetrics` `:1934-1956`) | none (column exists, `0021`) |

Recommended combination: **A-p3 to persist** + **A-p2 as the recovery of last resort** when the metrics row is missing (legacy/rows written before deploy).

**Interaction with `takeProfitBps` and the existing validation.** Unchanged: the take-profit still exits on `exitSpread.lte(takeProfitBps)` (`:2109`), and `take_profit_must_be_below_entry` still only guards `entryBps > 0` (`:516-520`). Option A only moves the stop reference. For `entryBps > 0`: `takeProfit < entryBps` and the trade has room `stopLossBps` from the realised entry (which may be `> entryBps`). For `entryBps < 0`: the take-profit validation is skipped today; the adverse direction is "more negative" and the stop is `entryRef − stopLossBps`.

**Risk direction: LOOSER.** With Option A a stop that today triggers after `stopLossBps − entryBps` bps (e.g. 35) triggers only after a full `stopLossBps` (100) of adverse movement. **For a user who wanted a tight stop, this is the opposite of what they asked for.** This is the decisive trade-off and is why A should be opt-in (see §4).

---

### Option B — keep absolute, add an entry gate + config validation

Keep the absolute comparison as the stop rule, but (1) refuse to **enter** when the adverse side is already breached, and (2) reject configs where the stop cannot provide positive headroom.

**B1 — start-time validation** (mirror the `:516-520` pattern, thrown as `StrategyEngineError(..., 400)`):

```ts
// strategy-engine.ts — alongside the existing auto checks around :516-520
if (input.kind === 'auto' && input.stopLossBps && input.entryBps
  && new Decimal(input.stopLossBps).lte(new Decimal(input.entryBps).abs())) {
  throw new StrategyEngineError('stop_loss_not_above_entry', 400);
}
```

Unified rule: **`stopLossBps > |entryBps|`** — for `entryBps ≥ 0` this is `stopLossBps > entryBps`; for `entryBps < 0` it guarantees headroom `stopLossBps − |entryBps| > 0`.
New error code: **`stop_loss_not_above_entry`** (HTTP 400), the direct mirror of `take_profit_must_be_below_entry`.

**B2 — runtime entry gate.** Refuse entry when the adverse side is already breached. Factor a single helper (removes the current drift risk between the stop and the gate):

```ts
// new private helper, near :1675
private adverseBreached(config: CreateStrategyInput, spread: Decimal): boolean {
  const stop = new Decimal(config.stopLossBps ?? '0');
  const level = new Decimal(config.entryBps ?? '0');
  return level.gte(0) ? spread.gte(stop) : spread.lte(stop.neg());
}
```

Then `maybeTriggerAutoStopLoss()` uses it (`:1677` becomes `const adverse = this.adverseBreached(actor.config, entry.spread);`), **and** the entry gate reuses it:

```ts
// strategy-engine.ts:2096-2097 — gate goes here
const entryTriggered = entry !== null
  && !(actor.kind === 'auto' && actor.config.stopLossBps && this.adverseBreached(actor.config, entry.spread))
  && (entryLevel.gte(0) ? entry.spread.gte(entryLevel) : entry.spread.lte(entryLevel));
```

**Placement (exact, relative to the surrounding code in `evaluateTakerClip`):**

```text
:2087  entry = entrySpreadBps()          // compute live spread
:2088-2090  exposure + imbalance guard
:2093  entryLevel
:2096-2097  ← ADD gate here (entryTriggered), BEFORE capacity is computed
:2099-2106  if (entry && entryTriggered) { capacity = remainingEntryCapacity(...); ... }
:2107-2115  take-profit exit block   ← UNAFFECTED, still runs
```

The gate belongs **before** `remainingEntryCapacity()` (`:2100`) so no capacity/in-flight math runs for a blocked entry, and **before** the take-profit block so it cannot suppress an exit — the take-profit block is reached regardless because it is a separate `if` (`:2107`).

**Operator sees.** New auto strategies with `stopLossBps ≤ |entryBps|` are rejected at launch with `stop_loss_not_above_entry` (rendered in the launch banner, `strategy-route.tsx:1083`). Existing RUNNING strategies are **not** re-validated at resume (resume has its own preflight at `:633`), but the **runtime gate** does apply to them after deploy: they simply stop opening new entries while the gap is breached (they still exit/stop normally).

**Gap to close:** the guard must also apply to the **maker** entry path (`evaluateMakerQuotes`, `:2259`), or `MAKER_TAKER` auto strategies keep failure mode (b). Recommended: apply the same `adverseBreached` check before the maker entry quote is placed (see Open Question O3).

**Risk direction: neutral-to-TIGHTER.** The stop rule is unchanged (absolute), so an existing position behaves identically; only bad entries are prevented and impossible configs are rejected.

---

### Option C — cosmetic / visibility only

Two changes, no semantics change.

**C1 — surface the real buffer in the create-strategy UI.**
The auto form is `apps/frontend/src/strategy-route.tsx`. The relevant field block is the compact-fields tail at **`:1127`**:

```tsx
// strategy-route.tsx:1127 (three inputs, in order)
<label>…Entry threshold…</label>
<label>…Take-profit threshold…</label>
<label>…Stop-loss threshold…</label>   // ← add hint here
```

Also update the two summary surfaces: the `launch-summary` grid **`:1314`** (`Stop loss → {stopLossThreshold} bps`) and the confirmation rows **`:1332-1336`** (`{ label: t('Stop loss'), value: … }`). The hint should read, for `entryBps ≥ 0`: **`Effective stop buffer: stopLossBps − entryBps bps`**, mirroring the real semantics; for `entryBps < 0` use `stopLossBps − |entryBps|`. Pair it with the fast-fail at `:969-980` (extend `sizeInputsValid` so the launcher disables when `stopLoss ≤ |entry|`).

**C2 — stop mislabelling stop-loss exits as take-profit.** In `executeTakerClip` (`:2140`), branch the labels on the armed stop-loss state as well as `intent`:

```ts
// :2163
const stopLossExit = actor.kind === 'auto' && actor.stopLossArmed && intent === 'exit';
const triggeredEvent = stopLossExit ? 'Stop-loss exit triggered'
  : intent === 'exit' ? 'Take-profit triggered'
  : actor.config.reduceOnly ? 'Reduce-only triggered' : 'Entry triggered';
// :2202
const executedEvent = stopLossExit ? 'Stop-loss Executed'
  : intent === 'exit' ? 'Take-profit Executed'
  : actor.config.reduceOnly ? 'Reduce-only Executed' : 'Position open Executed';
```

**Registering the new events (mandatory, or log tabs drop rows):**
- Add both to `STRATEGY_LOG_EVENT_CATEGORY` in `packages/shared-types/src/index.ts` (risk block, `:1204-1212`): `'Stop-loss exit triggered': 'risk'`, `'Stop-loss Executed': 'risk'`.
- `STRATEGY_LOG_CATEGORY_FETCH_EVENTS` (`:1263-1270`) **auto-derives** the `risk` fetch set from `strategyLogEventsIn('risk')` (`:1244-1245`) — no manual edit, but **verify** the new names appear.
- `classifyStrategyLogEvent()` (`apps/frontend/src/strategy-logs.ts:185-190`) reads the same map — auto-covered.
- `groupStrategyLogs()` keys legacy leg-pairs on the literal `'Take-profit triggered'` (`strategy-logs.ts:103-104`) to decide `Take-profit Executed` vs `Position open Executed`. Add `'Stop-loss exit triggered'` to that check so a **legacy** stop-loss bundle is not mislabelled.
- `decorateStrategyLogExecutions()` (`strategy-logs.ts:146-148`) sets `isExecution` from three literal event names; add `'Stop-loss Executed'` there if the row should carry the spread metric.

**Risk direction: unchanged.** Pure visibility/labelling.

---

## 3. Trade-offs & compatibility

| Dimension | Option A (entry-relative) | Option B (gate + validation) | Option C (cosmetic) |
|---|---|---|---|
| **Blast radius** | Large: stop rule + actor state + persistence + recovery + tests | Small: 1 helper, 1 gate line, 1 validation block, tests | Small: 1 label branch, UI hint, shared-types table, i18n |
| **Changes meaning for EXISTING persisted strategies?** | Yes, if applied by default — a running position's stop moves from `stopLossBps−entryBps` to `stopLossBps` | Stop rule unchanged; the **gate** changes future entries of running strategies | No |
| **Data migration?** | None if reusing `metrics_json` (`0021`) + widened ledger SELECT; else a new column (migration `0024`) | None | None |
| **Risk direction** | **LOOSER** — a stop that fires at 35 bps today fires at 100 bps | Neutral→**TIGHTER** (bad entries and impossible configs removed) | Neutral |
| **Implementation risk** | High: reference timing, partial fills, restart recovery, negative branch | Low: deterministic, reuses an established pattern | Very low |
| **Fixes failure mode (a)?** | Yes (buffer becomes exactly `stopLossBps`) | Partly — guarantees a **positive** buffer `stopLossBps−entryBps`, but the buffer still depends on where you entered | No (merely makes the buffer visible) |
| **Fixes failure mode (b)?** | Yes (no reference until matched; entry still unbounded but the stop measures from entry) | Yes (entry refused while breached) | No |

**The decisive call-out:** Option A makes live risk **looser**. Converting `entryBps=65 / stopLossBps=100` from an effective 35 bps stop to a 100 bps stop is a **5× increase in tolerated adverse excursion** — the exact opposite of what an operator who configured a stop-loss wants. Option B is the only option that is strictly safer or equal, and it matches the **absolute** language the product already uses in its own logs (`Spread <X> bps hit the <Y> bps stop-loss`, `:1681`).

---

## 4. Recommendation

**Primary: ship Option B + Option C together; gate Option A behind explicit opt-in.**

1. **Option B is the fix.** It removes both failure modes with minimal blast radius, is deterministic, and reuses the repo's own validation idiom (`:516-520`). It aligns the engine with the operator's stated intent ("stop at 100 bps") and with the wording the system already emits. It is neutral-to-tighter on risk, so no existing operator is surprised in the dangerous (looser) direction.
2. **Option C ships with B** because B changes *which* configs are accepted and *when* entries are refused; the UI must (a) show the real buffer `stopLossBps − entryBps` and (b) stop mislabelling stop-loss exits as take-profit, or the operator cannot reconcile the new behaviour with the log.
3. **Option A is a feature, not a fix — gate it behind `stopLossMode`.** Add `stopLossMode: z.enum(['absolute', 'entry-relative']).optional()` (default `'absolute'`) so existing strategies keep today's semantics and only operators who explicitly want a drawdown-from-entry stop get the looser behaviour. Without the selector, enabling A by default would silently loosen every live stop — unacceptable.

**Why the production evidence supports B over A:** every trigger row is an **absolute** spread vs an **absolute** threshold (`103.64→100`, `141.45→100`, `182.40→150`, `447.89→150`). The gap is real and operators treat the threshold as absolute. The pathology in production (`AUTO-1CCEAE53` stopped with `Spread 141.45 bps hit the 100 bps stop-loss`) is consistent with either (a) a 65→100 config giving a 35 bps effective stop, or (b) a 141-bps entry stopping out immediately — **both** of which B addresses and A addresses without loosening. Making the stop relative (A) would instead have let that XDP position run to 165 bps before stopping.

---

## 5. Implementation plan (Option B + C only)

Root commands (Windows / Git Bash): `export PATH="$PWD/.runtime:$PATH"` before any `npm`. **Never** run `npx vitest run` at the repo root. Leave everything uncommitted. Do not touch the version.

### Step 1 — backend semantics (`apps/backend/src/strategy-engine.ts`)

| Edit | Location | Change |
|---|---|---|
| 5.1 | new helper near `:1675` | Add `private adverseBreached(config, spread): boolean` (see §2 B2) |
| 5.2 | `:1677` | Replace the inline ternary with `const adverse = this.adverseBreached(actor.config, entry.spread);` |
| 5.3 | `:2096-2097` | Prepend the auto gate `&& !(actor.kind === 'auto' && actor.config.stopLossBps && this.adverseBreached(actor.config, entry.spread))` |
| 5.4 | `:514-520` | Add the `stop_loss_not_above_entry` (400) validation: reject `stopLossBps ≤ |entryBps|` |
| 5.5 (C2) | `:2163`, `:2202` | Branch the exit labels on `actor.stopLossArmed`; emit `Stop-loss exit triggered` / `Stop-loss Executed` |
| 5.6 (opt.) | `maybeTriggerAutoStopLoss()` `:1673` | Rename the misleading local `entry` → `liveSpread` for readability (no behaviour change) |

Also (maker gap): apply `adverseBreached` before the maker entry quote in `evaluateMakerQuotes()` (`:2259`) so `MAKER_TAKER` auto strategies get the same gate. Tracked as Open Question **O3**.

### Step 2 — shared types (`packages/shared-types/src/index.ts`)

| Edit | Location | Change |
|---|---|---|
| 5.7 | `StrategyConfigSchema`, after `:1081` | `stopLossMode: z.enum(['absolute','entry-relative']).optional()` (needed only if Option A is later enabled; harmless to add now, default `'absolute'`) |
| 5.8 (C2) | `STRATEGY_LOG_EVENT_CATEGORY`, `:1204-1212` | Add `'Stop-loss exit triggered': 'risk'`, `'Stop-loss Executed': 'risk'` |
| 5.9 | `STRATEGY_LOG_CATEGORY_FETCH_EVENTS` `:1263-1270` | No edit required (derived); **verify** the two names appear in the `risk` array |

### Step 3 — frontend (`apps/frontend/src/strategy-route.tsx`)

| Edit | Location | Change |
|---|---|---|
| 5.10 (C1) | field block `:1127` | Under the Stop-loss input, render `Effective stop buffer: stopLossBps − entryBps bps` (signed by the entry branch) |
| 5.11 (C1) | summary `:1314` + confirmation `:1332-1336` | Append the same buffer to the "Stop loss" rows |
| 5.12 (C1) | `sizeInputsValid` `:969-980` | Extend the auto clause: when both are present, require `Number(stopLossThreshold) > Math.abs(Number(threshold))` |

### Step 4 — log classifier (`apps/frontend/src/strategy-logs.ts`)

| Edit | Location | Change |
|---|---|---|
| 5.13 (C2) | `groupStrategyLogs()` `:103-104` | Include `'Stop-loss exit triggered'` in the legacy leg-pair label check |
| 5.14 (C2, opt.) | `decorateStrategyLogExecutions()` `:146-148` | Add `'Stop-loss Executed'` to `isExecution` so the filled row carries the spread metric |

### Step 5 — i18n (`apps/frontend/src/i18n.tsx`)

The app keeps a single `chinese: Record<string,string>` map keyed by the English string; `translate()` (`:436-438`) falls back to the key. Add EN→ZH pairs:

| English key (used in code) | ZH value |
|---|---|
| `Effective stop buffer` | `止损实际缓冲` |
| `Stop-loss must exceed the entry threshold` | `止损阈值必须大于入场阈值的绝对值` |
| `Stop-loss exit triggered` | `止损平仓已触发` |
| `Stop-loss Executed` | `止损平仓已成交` |
| `Stop-loss exit in progress` (condition string, optional) | `止损平仓进行中` |

Existing keys reused: `Entry threshold` (`:187`), `Take-profit threshold` (`:187`), `Stop-loss threshold` (`:294`), `Stop loss` (`:294`). **Do not** reintroduce `aria-pressed` inside any dialog (SSR assertion); if a selector for `stopLossMode` is added later, use `role="radiogroup"` + `aria-checked`.

### Step 6 — tests (see §6)

---

## 6. Test plan

**Commands** (per workspace — never `npx vitest run` at root):

```bash
export PATH="$PWD/.runtime:$PATH"
npm run build:packages          # shared-types change must be built first
npm test -w apps/backend        # vitest run --passWithNoTests
npm test -w apps/frontend       # vitest run --passWithNoTests  (also run for C1/C2)
```

All suites must stay green; the frontend suite must run because C touches `strategy-logs.ts`, `strategy-route.tsx` and `i18n.tsx`.

### (a) Rewrite `apps/backend/src/strategy-engine.test.ts:2144-2177`

Coherent setup so the entry spread sits **between** `entryBps` and `stopLossBps`:

```ts
markets.set('BINANCE_FUTURE_BTC_USDT', '100200', '100201'); // sell bid 100200
markets.set('OKX_FUTURE_BTC_USDT',     '99999',  '100000'); // buy  ask 100000
// entrySpread = (100200 − 100000)/100000 = 20 bps → ≥ entryBps 10, < stopLossBps 30  (no instant stop)
// …start auto entryBps '10', takeProfitBps '2', stopLossBps 30, maxPosition/perOrderQuantity '0.1'
// ack entry fills → openPosition 0.1, strategy still RUNNING, no exit orders
markets.set('BINANCE_FUTURE_BTC_USDT', '100400', '100401'); // 40 bps → widened ≥ 30  (adverse)
// assert 2 exit orders (reduce-only), then ack both, assert status STOPPED
// assert log contains 'Stop-loss triggered'
```

### (b) New regression — no entry while breached (Option B)

```ts
markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151'); // sell bid 100150
markets.set('OKX_FUTURE_BTC_USDT',     '99999',  '100000'); // buy  ask 100000 → 150 bps ≥ stopLossBps 30
// start auto entryBps '10', stopLossBps 30, then tick
// assert gateway.createdOrders.length === 0   (entry refused: adverse side already breached)
// assert openPosition === '0' and status 'RUNNING'
```

### (c) Boundaries — negative `entryBps` branch

```ts
// entryBps '-6', stopLossBps 30  (30 > |−6| ✓)
// entry requires spread ≤ −6; stop requires spread ≤ −30 (adverse = MORE negative)
// a) gap ≤ −30 at start → gate refuses entry (0 orders)
// b) enter at spread ≈ −10, then widen to ≤ −30 → stop fires
// c) start with stopLossBps 6 (≤ |−6|) → assert rejects { code: 'stop_loss_not_above_entry' }
```

### (d) Convergence must not stop (the 150→40 case)

```ts
// open at ~20 bps (entryBps 10 / stopLossBps 30), takeProfitBps '2'
markets.set('BINANCE_FUTURE_BTC_USDT', '100050', '100051'); // → 5 bps (CONVERGED, still > takeProfit 2)
// tick → assert still RUNNING, no exit orders (convergence is NOT adverse)
```

### Existing tests to update

| Test | Why |
|---|---|
| `strategy-engine.test.ts:2144` | Encodes the wrong model; rewritten per (a) |
| `strategy-engine.test.ts:453-460` (`take_profit_must_be_below_entry`) | Add a sibling for `stop_loss_not_above_entry`; confirm the new validation does not fire on valid configs |
| Any test that starts an auto strategy with `stopLossBps ≤ |entryBps|` | Will now be rejected by Step 5.4 — audit fixtures (`takerTakerConfig` `:315-318` has no `stopLossBps`, so unaffected) |
| Frontend log tests (`strategy-route-logs.test.tsx`, `strategy-logs` unit tests) | New event names must classify into the `risk` tab and remain visible |

---

## 7. Open questions for the user

- **O1 — Parameter semantics.** Should `stopLossBps` mean **(i) a distance from the entry** (Option A) or **(ii) an absolute spread level** (Option B)? The product's own log wording (`Spread X bps hit the Y bps stop-loss`) implies (ii); the field name `stopLossBps` alongside a distance-like mental model could imply (i). This is the single decision that picks the primary option. If (ii): Option B ships and A stays opt-in.
- **O2 — Option A reference & restart.** If A is ever enabled: which reference definition (A1 live / A2 executed-avg / A3 VWAP), and how should a **restored** strategy behave when no snapshot exists — keep the absolute rule for the session (A-p1), re-derive from the ledger (A-p2), or persist in `metrics_json` (A-p3)? Recommended: A-p3 + A-p2 fallback.
- **O3 — Maker entry gate.** Should the Option B entry gate also cover `evaluateMakerQuotes()` (`:2259`) so `MAKER_TAKER` auto strategies cannot enter while breached? Recommended yes; needs a confirmation because it adds one more branch to the maker path.
- **O4 — Existing RUNNING strategies.** The runtime gate (Step 5.3) will start refusing entries for already-running auto strategies whose config is now "invalid". Acceptable, or should such strategies be paused with a review notice instead (mirroring the `:2191` margin pause)?
- **O5 — Version bump.** None needed for B+C. If leadership ever wants a version bump for this change, it must go through the root `package.json` `version` + `npm run version:sync` (single source of truth).

> **Decision (final):** A **rejected** (absolute semantics retained) ⇒ O1/O2 closed, §4 item 3 and Step 5.7 (`stopLossMode`) are **dropped** from scope. B **approved** (B1+B2, maker path included) ⇒ O3 closed. O4 accepted (gate refuses future entries; no pause). C **approved**. See §8–§9 for the newly approved ladder increment and the consolidated plan.

---

## 8. Increment: laddered add-on entries (阶梯加仓)

**User requirement (verbatim):** *"添加二次加仓功能，就是比如说我 50 个 bps 入场，那么可以设置再上涨 20 个 bps 加仓，再上涨 20 个 bps 加仓，就类似于网格的逻辑"* — i.e. enter the first clip at `entryBps`, then add **one `perOrderQuantity` clip each time the (widening) gap advances another `step` bps**, grid-like, capped by `maxPosition`.

### 8.0 This is a CONSTRAINT on existing accumulation — not a new mechanism

The engine **already** accumulates on every tick. In `evaluateTakerClip()` (`:2099-2106`) the entry branch places `min(perOrder, remainingEntryCapacity)` whenever `entryTriggered`, and `remainingEntryCapacity()` (`:2058-2063`) is `max(0, strategyTarget − matched − inFlight)`. So while `spread ≥ entryBps`, each evaluation adds another `perOrderQuantity` clip until `maxPosition` — **driven by ticks, not by price levels**. The user's production config (`entryBps="65"`, `perOrderQuantity=1000`, `maxPosition=4500`) therefore fills 4 clips in 4 ticks with no notion of tiers.

**Consequence:** the feature must be implemented as a *level-based admission constraint* on the existing entry branch, and it must be **opt-in** so the ~20 live strategies are untouched. Proposal (recommended): a new optional field **`addOnStepBps`**; **absent ⇒ exactly today's tick-driven behaviour.** This mirrors the §0 finding that the accumulation itself needs no new code.

### 8.1 Tier arithmetic — stateless (restart-safe)

Adopt the stateless rule (no snapshot, survives restart — important because `stopLossArmed` is already memory-only, §0):

```ts
// new private helper
private tierIndexFor(config: CreateStrategyInput, spread: Decimal): number {
  const step = new Decimal(config.addOnStepBps ?? '0');
  if (!step.gt(0)) return 0;                       // no ladder
  const level = new Decimal(config.entryBps ?? '0');
  const advance = level.gte(0) ? spread.minus(level) : level.minus(spread); // negative branch mirrors
  return advance.lte(0) ? 0 : advance.div(step).floor().toNumber();
}
```

`tier = floor(advance/step)`; a clip may be added only while `clipsPlaced < tier + 1`. `clipsPlaced` is **derived from `matched` plus `inFlight`**, never from a counter:

```ts
// new private helper
private ladderAllowsAdd(actor, exposure, spread): boolean {
  const step = new Decimal(actor.config.addOnStepBps ?? '0');
  if (!step.gt(0)) return true;                    // no ladder ⇒ today's behaviour
  const perOrder = new Decimal(actor.config.perOrderQuantity);
  const matched  = this.matchedQuantity(exposure);
  const inFlight = this.inFlightQuantity(actor, new Set([...actor.quotes.values()].map((q) => q.orderId)));
  const allowedClips = new Decimal(this.tierIndexFor(actor.config, spread) + 1).mul(perOrder);
  return matched.plus(inFlight).lt(allowedClips.minus(QUANTITY_EPSILON));
}
```

Trace for `entryBps=50 / step=20 / stopLossBps=100` (`perOrder=1000`):

| Gap (bps) | `tier` | `allowedClips` | `matched+inFlight` | add? | clip # |
|---|---|---|---|---|---|
| 50 | 0 | 1·perOrder | 0 | ✅ | 1 |
| 55…69 | 0 | 1·perOrder | 1·perOrder | ❌ | — |
| 70 | 1 | 2·perOrder | 1·perOrder | ✅ | 2 |
| 90 | 2 | 3·perOrder | 2·perOrder | ✅ | 3 |
| 100 | ≥2 | — | — | stop fires first (8.2) | — |

**Verification vs the brief:** the proposed `tier = floor((spread − entryBps)/step)` + `clipsPlaced < tier + 1` is **adopted as-is** — it reproduces the user's 50/70/90 ladder exactly and needs no state. **Two refinements:** (i) `clipsPlaced` must be `matched + inFlight`, not `matched` alone — using `matched` alone would let a *stuck* non-terminal entry order (counted in `inFlight` by `inFlightQuantity()` `:2050-2056`) be submitted a second time on the next tick; (ii) apply a `QUANTITY_EPSILON` tolerance so lot/rounding noise cannot re-open a closed tier. Note the **catch-up** behaviour: if the strategy starts with the gap already at 70 (or a tier was missed), `tier=1` lets it place up to 2 clips over 2 ticks — desirable and, crucially, **stateless** (nothing to restore).

### 8.2 Interaction with the absolute stop, and tick ordering

Per-tick order in `evaluate()`: arm-stop `:1641-1646` → latched unwind `:1647-1649` → dispatch `:1650-1658` (taker at `:1657`) → `checkCompletion` `:1659`. `maybeTriggerAutoStopLoss()` runs **first** and, once `stopLossArmed`, only `continueAutoStopLossExit()` runs — the entry branch is never reached.

**Therefore the stop naturally caps the ladder.** For `50/20/100`, `tierIndexFor` at the stop line is `floor((100−50)/20)=2` (the last reachable tier is 90). **On a tick where the gap first crosses BOTH the next tier and the stop line**: `:1641` arms the stop, `:1642-1645` runs `checkCompletion()` and **returns**; `evaluateTakerClip` (`:1657`) is **not** reached ⇒ **the top-tier add-on does NOT happen; the stop wins.** State this explicitly in a comment and in a test (§9).

### 8.3 Interaction with B2's entry gate

B2's `adverseBreached()` (true when `spread ≥ stopLossBps` for positive entry) forbids entry **exactly at/above the stop line**, while the ladder only wants to add **below** it (validated in 8.6). The two are therefore **complementary, not conflicting**, and must be composed as separate ANDed conditions in `evaluateTakerClip`:

```ts
// strategy-engine.ts:2093-2097
const entryLevel = new Decimal(actor.config.entryBps ?? '0');
const breached   = entry !== null && this.adverseBreached(actor.config, entry.spread);         // B2
const atThreshold = entry !== null
  && (entryLevel.gte(0) ? entry.spread.gte(entryLevel) : entry.spread.lte(entryLevel));         // existing
const ladderOk   = entry !== null && this.ladderAllowsAdd(actor, exposure, entry!.spread);      // ladder
const entryTriggered = entry !== null && !breached && atThreshold && ladderOk;
```

**Evaluation order** (short-circuit, cheap→semantic): `!breached` → `atThreshold` → `ladderOk`. **Do NOT fold `adverseBreached` and the tier check into a single helper**: `adverseBreached` is also consumed by the stop path (`:1677`) and must stay single-purpose; `ladderAllowsAdd` is entry-only. Keep both as stateless helpers co-located near `:1675`.

### 8.4 Imbalance / repair

`evaluateTakerClip` returns early when `imbalance.abs() > QUANTITY_EPSILON` (`:2090`), and `reconcileExposure()` (`:1636` → `ensureHedged` `:2348`) tops up the lagging leg on the **same tick, before** the entry branch. `matchedQuantity()` (`:1086-1090`) is `min(|left|, |right|)` and returns `ZERO` while either leg is flat. So:

- while a clip is **half-filled**, entry is blocked (`:2090`) and the tier counter **cannot** advance;
- once the lagging leg is **repaired**, `matched` rises to a full `perOrderQuantity` ⇒ the topped-up clip **counts as exactly one placed clip**;
- the `inFlight` term (8.1) covers the window where a top-up order is open but not yet terminal.

### 8.5 Maker path — in scope (supersedes the earlier "reject on MAKER_TAKER")

**Decision (final): the ladder is supported on `MAKER_TAKER` as well as `TAKER_TAKER`.** Rationale on record: the user's own live strategy `AUTO-1CCEAE53` is `"executionMethod":"MAKER_TAKER","makerLeg":"right"`, and **9 of their 20 live strategies are `MAKER_TAKER`** (the other 11 are `TAKER_TAKER`). Rejecting the ladder on the maker path would make the feature unusable for the operator who requested it, so the earlier `add_on_step_maker_unsupported` rejection is **removed** from §8.6/§9.

#### 8.5.0 How many maker quotes can an actor hold today (the load-bearing fact)

**Exactly 2 — one entry, one exit.** `actor.quotes` is `Map<QuoteIntent, MakerQuote>` (`:85`) and `QuoteIntent = 'entry' | 'exit'` (`:68`). Quotes are stored **keyed by intent** (`actor.quotes.set(intent, …)`, `:2324`), and every consumer works in intent terms: delete-on-terminal (`:373`), cancel loop (`:2272-2281`), `cancelQuotes` (`:1498-1506`), `maintainQuote` (`:2291`, `:2302`), and the `inFlightQuantity` exclusion set (`:2060`). A second entry quote is impossible — `set('entry', …)` overwrites the first. **Consequence:** a *true multi-level grid* (one resting quote per tier) requires re-keying this map and updating all of those call sites; that drives F1 below.

#### 8.5.1 F1 — Sequential ladder (recommended) vs multi-level grid

| | **Sequential (recommended — ship this)** | **Multi-level grid (defer)** |
|---|---|---|
| Resting quotes | one entry quote at the **next unfilled tier's** boundary | one entry quote **per reachable tier** simultaneously |
| Data change | none to `actor.quotes` (still `Map<QuoteIntent, MakerQuote>`) | re-key to `Map<string, MakerQuote>` (`${intent}:${tier}`) + touch `:68,:85,:373,:1498-1506,:2060,:2272-2281,:2287-2324,:2374,:2601` |
| Fill behaviour | one sweep fills one tier, then the quote walks outward one step | one sweep can fill several tiers (closer to "网格") |
| Risk | low — reuses the existing single-quote machinery | high — the repair loop, cancel loop, and B2 gate must all tolerate N quotes |

**Recommendation: SEQUENTIAL for this increment.** A true multi-level grid is the more faithful "grid", but it is materially riskier (it is a re-key of the quote book plus a rewrite of the placement/repair loop), and this document must not silently pick the bigger one. State plainly: **sequential is a deliberate reduction versus a true grid.** A follow-up for multi-level would need: (a) `actor.quotes` re-keyed by `(intent, tier)`; (b) `desiredMakerPrice()` taking a `tier` argument for every level; (c) the cancel loop (`:2272-2281`) and `cancelQuotes` (`:1496`) to iterate N entry quotes; (d) per-tier partial-fill/repair accounting. With sequential, everything above stays single-quote.

#### 8.5.2 F2 — Pricing a maker tier (must work for either `makerLeg`)

Extend `desiredMakerPrice(actor, intent, tier = 0)` so the entry threshold is the **next unfilled tier's level**, not the raw `entryBps`:

```ts
// :2234 — entry branch becomes tier-aware; exit branch (takeProfitBps) unchanged
const step = new Decimal(actor.config.addOnStepBps ?? '0');
const level = new Decimal(actor.config.entryBps ?? '0');
const entryThreshold = level.gte(0) ? level.plus(step.mul(tier)) : level.minus(step.mul(tier));
const threshold = intent === 'entry' ? entryThreshold : new Decimal(actor.config.takeProfitBps ?? '0');
const factor = threshold.div(BPS);              // :2235 unchanged
```

Everything downstream (`:2238-2254`) is **unchanged** and already side-agnostic: `legsForIntent()` + `makerLegKey` select the maker leg for either `left`/`right`; the SELL branch rounds **up** (`:2240`) and the BUY branch rounds **down** (`:2241`) to `tickSize`; the result is clamped to `makerTop` to join the best queue (`:2251-2254`). `tier` defaults to `0`, so a non-ladder strategy computes exactly today's price. The **mirror for negative `entryBps`** is `level − step·tier` (the existing signed math already handles a negative `entryBps`, so only the substitution changes).

Which tier index to price: `nextTier = min(clipsPlaced, maxReachableTier)` where `clipsPlaced = floor((matched + inFlight) / perOrder)` and `maxReachableTier = floor((stopLossBps − |entryBps|) / step)`. The quote therefore rests at `entryBps` (tier 0) for clip 1, at `entryBps + step` for clip 2, and so on — the maker quote **walks outward one step per filled clip**.

#### 8.5.3 F3 — Tier advance: reuse cancel-and-replace, add **zero** new churn

**Leave `maintainQuote`'s drift/throttle logic untouched; only feed it a tier-aware `desired.price`.** `maintainQuote` (`:2287-2309`) already cancels and replaces when `|desired.price − existing.price| ≥ tickSize` **and** `now − existing.quotedAt ≥ requoteIntervalMs` (default 2000ms, `:335`), throttled further by `lastQuoteAt < requoteIntervalMs/2` (`:2309`). Because the tier changes **only when a clip fills** (a bounded, event-driven change of at most `maxPosition/perOrderQuantity` times over the strategy's life), advancing a tier adds **at most one extra cancel/replace per tier filled** — it does **not** add a requote rate. Keep `cooldownUntil` and `repairAttempts` out of the tier math entirely so the ladder cannot amplify the cooldown backoff.

**What causes the production churn (explain to the operator):** the `CANCELLED` runs on `AUTO-1CCEAE53` (roughly one every few seconds, 08:18–08:25 UTC) are **not** a bug and are **not** caused by any ladder: `desiredMakerPrice()` recomputes `boundary` from the **live taker-leg book on every tick** (`:2234-2245`), so as the taker leg's ask/bid moves the resting price drifts by ≥1 `tickSize`, and after the 2 s `requoteIntervalMs` the order is cancelled and re-placed. This is the normal POC requote loop; the ladder leaves its rate unchanged.

#### 8.5.4 F4 — Clip accounting on the maker path

A maker tier produces **two orders**: one maker fill (the maker leg) and one taker hedge (the other leg). `clipsPlaced` must increment **once per completed clip**, never per order:

- `matchedQuantity()` (`:1086-1090`) is `min(|left|,|right|)` and returns `ZERO` while either leg is flat — so a maker fill whose hedge is still outstanding contributes `0` to `matched`;
- the outstanding hedge is a regular taker order (not a quote), so `inFlightQuantity()` (`:2050-2056`) counts it;
- therefore the §8.1 rule **`clipsPlaced = floor((matched + inFlight) / perOrder)` holds unchanged**, and exactly one clip is counted whether the hedge is still in flight (`inFlight`) or already filled (`matched`).

**Ordering guarantee:** `reconcileExposure()` runs at `:1636`, **before** the maker dispatch (`:1650` → `evaluateMakerQuotes` `:2259`), so the hedge order is submitted (and hence counted in `inFlight`) before the next entry intent is evaluated. Note the `:2090` imbalance early-return lives in the **taker** method; the maker path relies on this ordering instead. **Recommendation: do not add a `:2090`-style guard to `evaluateMakerQuotes` in this increment** (it would change existing maker behaviour beyond the ladder); the `matched + inFlight` accounting is sufficient.

#### 8.5.5 F5 — B2 gate × ladder composition (no deadlock)

**Note the helper split:** the taker path uses the **live-spread** helper `ladderAllowsAdd()` (§8.1/§8.3), because it acts on the current tick. The maker path is **passive** — its quote waits for the gap — so it uses the **clip-count** helper `nextLadderTier()` (§8.5.2) plus the stop-line cap `tierOk`, **not** `ladderAllowsAdd()`. Do not conflate the two.

In `evaluateMakerQuotes()` the entry intent is pushed only when **both** hold:

```ts
// :2264-2268 — entry intent guarded by the gate AND the next tier staying below the stop line
const liveSpread = this.entrySpreadBps(actor.config)?.spread;
const nextTier   = this.nextLadderTier(actor, exposure);           // perOrder-based clip count
const tierOk     = !actor.config.addOnStepBps
  || (nextTier !== null && this.absThreshold(actor.config, nextTier).lt(new Decimal(actor.config.stopLossBps ?? '0')));
const gateOk     = !actor.config.stopLossBps || (liveSpread !== undefined && !this.adverseBreached(actor.config, liveSpread));
if (entryCapacity.gt(QUANTITY_EPSILON) && gateOk && tierOk) { … push entry intent with quantity for the next tier … }
```

- **Below the stop line:** `adverseBreached()` is false (gate silent) and the next tier's level `< stopLossBps` ⇒ the ladder rests/advances normally.
- **At/above the stop line:** `adverseBreached()` is true ⇒ no entry intent; and any existing entry quote is cancelled by the intent-diff loop (`:2272-2281`). If a position is already open, `maybeTriggerAutoStopLoss()` (`:1641-1646`) has already armed the stop and `evaluate()` routes to `continueAutoStopLossExit()` (`:1647-1649`), so `evaluateMakerQuotes` is not even reached; `checkCompletion` cancels the quotes (`:1442`). **No deadlock:** the gate and the ladder are both silent in the same region, and the stop outranks both.

#### 8.5.6 F6 — UI is execution-method-agnostic (no per-method branch)

The tier **levels** (`entryBps + k·step`) and the stop-line cap are independent of `executionMethod`; only the fill mechanism differs. So `sizeInputsValid` (`strategy-route.tsx:969-980`) and the §8.7 ladder preview need **no execution-method branch** — the only change is to **remove the Maker–Taker exclusion** (there is none to add). Keep it minimal: a short static note next to the `Add-on step` input — *"Applies to Taker–Taker and Maker–Taker; on Maker–Taker tiers fill from a resting quote."*

### 8.6 Schema & validation

**zod change** (`packages/shared-types/src/index.ts`, next to `:1081`):

```ts
/** Auto only: optional ladder step (bps). Absent ⇒ tick-driven accumulation (today's behaviour). */
addOnStepBps: z.number().gt(0).optional(),
```

**Type rationale:** `stopLossBps` is `z.number().gt(0).optional()` (`:1081`) while `entryBps`/`takeProfitBps` are text schemas (`:1078-1079`). `addOnStepBps` is the same *kind* of optional positive bps knob as `stopLossBps` (a small risk/execution parameter supplied by the UI as a number), so `z.number().gt(0)` is the consistent choice and pairs cleanly with the existing `stopLossBps` comparison logic. (The alternative `PositiveDecimalTextSchema` would force string/number conversions at every comparison; rejected.)

**Start-time validation** (in `startStrategy`, alongside B1 at `:514-527`):

| Rule | Behaviour | Code |
|---|---|---|
| `stopLossBps > |entryBps|` | reject | `stop_loss_not_above_entry` (400) — **B1** |
| `addOnStepBps > 0` | enforced by schema (`gt(0)`) | ZodError |
| first add-on tier below the stop line: `|entryBps| + step < stopLossBps` (when both present) | reject | `add_on_step_beyond_stop_loss` (400) |

Both engine checks follow the established `StrategyEngineError(..., 400)` idiom (`:516-520`). **`addOnStepBps` is valid for both `TAKER_TAKER` and `MAKER_TAKER`** — no execution-method rejection (§8.5).

### 8.7 UI

Field block `apps/frontend/src/strategy-route.tsx:1127` (Entry / Take-profit / Stop-loss inputs). Add a fourth input:

- label `Add-on step`, placeholder `Optional`, unit `bps`; state `const [addOnStep, setAddOnStep] = useState('')`; include in the launch config (`:1064-1076`) as `...(addOnStep.trim() !== '' ? { addOnStepBps: Number(addOnStep) } : {})` (mirrors `stopLossBps` at `:1070`). Static note beside the input (§8.5.6): *"Applies to Taker–Taker and Maker–Taker; on Maker–Taker tiers fill from a resting quote."*

**Ladder preview — RECOMMENDED (include).** It directly expresses the user's mental model and prevents impossible configs. When `entryBps`, `stopLossBps` and `addOnStep` are all present, render a derived list, e.g.:

> `Add-on tiers: 50 / 70 / 90 bps · 3 clips before the 100 bps stop`

Computed as the levels `entryBps + k·step` (`k = 0,1,2,…`) while `level < stopLossBps`, capped by `maxPosition / perOrderQuantity`; show the binding cap (stop line vs `maxPosition`). Extend the two summaries (`:1314` launch grid and `:1332-1336` confirmation rows) with an `Add-on ladder` row. Extend the fast-fail at `:969-980` so the launcher disables when a provided `addOnStep` fails `> 0` or puts the first tier at/above the stop. **No execution-method branch** (§8.5.6): the maker path is supported, so the ladder validation is identical for `Taker–Taker` and `Maker–Taker`.

### 8.8 Observability

**Recommendation: REUSE** the existing `Entry triggered` / `Position open Executed` events (already categorised `execution` at `:1185`/`:1187`) and carry the tier in the **condition string** — do **not** invent a new event name. Rationale: C2 already introduces two new risk events; adding a third set multiplies the registration/classifier/grouping surface for no categorisation benefit (an add-on clip *is* an entry clip). Change the condition at `:2103` for a ladder add to:

```ts
`Add-on tier ${tierIndex + 1} · spread ${entry.spread.toFixed(2)} bps ≥ ${levelBps} bps`
```

(and keep the plain `Spread … ≥ … bps` condition when no ladder). **No** new entry is needed in `STRATEGY_LOG_EVENT_CATEGORY` (`:1204-1212`), `classifyStrategyLogEvent()` or `groupStrategyLogs()`. Minor caveat: condition strings are not translated in the ZH log view (`strategy-logs.ts:34-37` only rewrites `Premium`), so the tier text stays English — consistent with today's conditions; optionally extend `localizeStrategyLogCondition` if ZH fidelity is wanted.

---

## 9. Consolidated implementation & test plan (full approved scope)

**Scope:** B1, B2 (incl. maker path), C1, C2, ladder (8.x). **Option A and `stopLossMode` are OUT** (rejected).

**Commands (Windows / Git Bash):**

```bash
export PATH="$PWD/.runtime:$PATH"        # before ANY npm; there is no global Node
npm run build:packages                   # shared-types is a BUILD DEPENDENCY of the frontend
npm test -w apps/backend                 # vitest run --passWithNoTests  (NEVER npx vitest run at root)
npm test -w apps/frontend                # vitest run --passWithNoTests
```

**Hard constraints:** do not bump the version (root `package.json` `version` + `npm run version:sync` is the only source of truth if ever needed); **commit nothing** — leave the tree as-is; frontend dialogs must not use `aria-pressed` (SSR assertion) — use `role="radiogroup"` + `aria-checked` if a selector is added; run test suites **per workspace**.

### 9.1 File ownership (disjoint — two engineers in parallel)

- **Engineer A:** `packages/shared-types/**` + `apps/backend/**`
- **Engineer B:** `apps/frontend/**`

### 9.2 Steps

| Step | Owner | Files | Depends on | Notes |
|---|---|---|---|---|
| **A1** | A | `packages/shared-types/src/index.ts` | — | Add `addOnStepBps` (§8.6, near `:1081`); add C2 events to `STRATEGY_LOG_EVENT_CATEGORY` (`:1204-1212`). Then run `npm run build:packages`. **This step must land (and build) before B2/B3/B4 can typecheck.** |
| **A2** | A | `apps/backend/src/strategy-engine.ts` (`startStrategy` `:504-528`) | A1 | B1 `stop_loss_not_above_entry`; ladder `add_on_step_beyond_stop_loss`. **No execution-method rejection** — `addOnStepBps` is valid for both taker and maker (§8.5). |
| **A3** | A | `strategy-engine.ts` (near `:1675`) | A1 | Add `adverseBreached()` (§2 B2), `tierIndexFor()` + `ladderAllowsAdd()` (§8.1) and `nextLadderTier()`/`absThreshold()` (§8.5.2, §8.5.5); rewire the stop at `:1677` to use `adverseBreached()`. |
| **A4 (taker)** | A | `strategy-engine.ts` — `evaluateTakerClip` `:2086-2116` | A3 | Compose `entryTriggered` per §8.3 (`!breached && atThreshold && ladderOk`); keep `capacity` at `:2100`; new condition string `:2103` (§8.8). |
| **A4b (maker — ladder in scope)** | A | `strategy-engine.ts` — `desiredMakerPrice` `:2225-2257`; `evaluateMakerQuotes` `:2259-2285`; `maintainQuote` `:2287-2341` (call site only) | A3, A4 | Make `desiredMakerPrice(actor, intent, tier)` tier-aware for entry (`:2234`, §8.5.2); guard the entry-intent push at `:2264-2268` with the **B2** `adverseBreached` gate **and** `tierOk` (§8.5.5); pass the next-tier index from `maintainQuote` (§8.5.3). Sequential ladder only — **do not** re-key `actor.quotes` (multi-level is deferred, §8.5.1). |
| **A5** | A | `strategy-engine.ts` — `executeTakerClip` `:2163`, `:2202` | A1 | C2: branch exit labels on `actor.stopLossArmed` ⇒ `Stop-loss exit triggered` / `Stop-loss Executed`. Do **not** add a ladder event (§8.8). |
| **A6** | A | `apps/backend/src/strategy-engine.test.ts` | A2–A4b, A5 | All backend tests (§9.3, A-tests). |
| **B1** | B | `apps/frontend/src/i18n.tsx` | — | EN→ZH keys (§9.4). Independent of A1. |
| **B2** | B | `apps/frontend/src/strategy-route.tsx` | A1 (built) | Add the `Add-on step` input at `:1127`; ladder preview; summaries `:1314`, `:1332-1336`; launch config `:1064-1076`; fast-fail `:969-980`; C1 buffer hint (existing §5.10-5.12). |
| **B3** | B | `apps/frontend/src/strategy-logs.ts` | A1 (built) | C2: add `'Stop-loss exit triggered'` to the `groupStrategyLogs` literal check (`:103-104`); add `'Stop-loss Executed'` to `isExecution` (`:146-148`). |
| **B4** | B | frontend tests (`strategy-route-logs.test.tsx`, `strategy-logs` tests, route/prefill tests) | B1–B3 | Frontend tests (§9.3, B-tests). |

**Ordering / parallelism:** A1 first (blocking build dependency). Then A2–A3 run in parallel with B1; A4 and A4b follow A3 (A4b also touches `maintainQuote`'s call site, so sequence it after A4 to keep the diff readable); B2/B3/B4 additionally require A1's `npm run build:packages` to have run. A6 and B4 are last. **Independent steps:** B1 is fully independent of A; A2–A5 are independent of all B steps. **No other hard ordering** — the two engineers own disjoint files, so there are no merge conflicts. Note the maker ladder (A4b) and the `desiredMakerPrice` change are backend-only; the frontend (B) needs **no** execution-method branch (§8.5.6), only the static UI note.

### 9.3 Consolidated test plan

**Backend (`npm test -w apps/backend`), owner A:**

| # | Test | Setup / assertion |
|---|---|---|
| T1 | **Rewrite `strategy-engine.test.ts:2144`** (coherent entry between `entryBps` and `stopLossBps`) | Enter at ~20 bps (`entryBps` 10 / `stopLossBps` 30); widen to 40 bps ⇒ stop fires; convergence does not (§6 (a),(d), unchanged) |
| T2 | **B2 gate — no entry while breached** | Gap 150 bps, `stopLossBps` 30 ⇒ `createdOrders.length === 0`, `openPosition '0'`, `RUNNING` (§6 (b)) |
| T3 | **B2 gate — maker path** | `MAKER_TAKER` auto, gap ≥ `stopLossBps` ⇒ **no entry quote placed**; below the line ⇒ entry quote placed |
| T4 | **B1 rejection** | `stopLossBps ≤ |entryBps|` ⇒ rejects `{ code: 'stop_loss_not_above_entry' }` (positive and negative `entryBps`); a valid config still starts |
| T5 | **Ladder: one clip per tier, never two in one tick** | `entryBps` 50 / step 20 / `stopLossBps` 100 (`maxPosition` 3000, `perOrderQuantity` 1000). Tick at 50 ⇒ 1 clip; tick at 50 again ⇒ **still 1**; tick at 70 ⇒ 2; tick at 70 again ⇒ **still 2**; tick at 90 ⇒ 3 |
| T6 | **Ladder: no clip until a full step** | Enter at 50, move to **69** ⇒ no add; to **70** ⇒ add |
| T7 | **Ladder stops at the stop line** | From 90, tick where the gap jumps straight to 100 ⇒ **stop arms and exits; no 4th clip is added** (verifies §8.2 ordering) |
| T8 | **`addOnStepBps` absent ⇒ today's behaviour** | Same config without `addOnStepBps`: ticks at 50/51/52… add one clip per tick until `maxPosition` (regression guard for the ~20 live strategies) |
| T9 | **Ladder config rejection (both methods accepted)** | `entryBps` 50 / step 60 / `stopLossBps` 100 ⇒ rejects `{ code: 'add_on_step_beyond_stop_loss' }`; the same ladder with `MAKER_TAKER` **starts successfully** (no execution-method rejection) |
| T10 | **Negative `entryBps` boundary** | `entryBps` −6 / `stopLossBps` 30: gate refuses at gap ≤ −30; stop fires at ≤ −30; ladder step mirrored toward more-negative levels |
| T11 | **Restart safety (statelessness)** | Restart mid-ladder (re-attach via `activatePersistedStrategies` `:419-431`); assert the tier index is recomputed from `matched + inFlight` and no extra clip is placed |
| **T15 (maker ladder)** | **Sequential maker ladder walks one tier per filled clip** | `MAKER_TAKER`, `makerLeg` right, `entryBps` 50 / step 20 / `stopLossBps` 100. Assert the single resting entry quote is priced at the **tier-0** boundary; fill it + hedge ⇒ `matched` = 1 clip ⇒ next entry quote repriced to the **tier-1** boundary (70); repeat ⇒ tier-2 boundary (90). Assert **only one entry quote exists** at any time (§8.5.0) |
| **T16 (maker ladder)** | **Maker tier is not double-counted / no advance while the hedge is outstanding** | After a maker fill but before the hedge terminal, `clipsPlaced` must not increment (maker-leg fill ⇒ `matched` = 0, hedge counted via `inFlight`); assert no second entry quote is placed and the tier does not advance until both legs are flat (§8.5.4) |
| **T17 (maker ladder)** | **Maker ladder stops at the stop line; B2 gate live** | Live gap ≥ `stopLossBps` ⇒ **no entry quote** is placed and any resting entry quote is cancelled; below the line the ladder still rests the next tier. Assert `adverseBreached` and `tierOk` compose with no deadlock (§8.5.5) |
| **T18 (maker ladder)** | **`addOnStepBps` absent ⇒ today's maker behaviour; no extra churn** | Same `MAKER_TAKER` config without `addOnStepBps`: quote/requote cadence is unchanged from the current single-quote behaviour (drift ≥ 1 `tickSize` + `requoteIntervalMs`), proving the tier change adds **no** extra cancel/replace (§8.5.3) |

**Frontend (`npm test -w apps/frontend`), owner B:**

| # | Test | Assertion |
|---|---|---|
| T12 | Ladder input + preview | `Add-on step` renders; preview shows `50 / 70 / 90` and the 100 bps stop cap; launcher disabled for step ≤ 0 or first-tier-past-stop; **no** `Maker–Taker` exclusion (the maker note is shown instead) |
| T13 | C1 buffer hint | The buffer row shows `stopLossBps − entryBps` and updates live |
| T14 | C2 classification | `Stop-loss exit triggered` and `Stop-loss Executed` classify into the **`risk`** tab via `classifyStrategyLogEvent`; a legacy leg-pair with `Stop-loss exit triggered` groups/labels correctly; rows remain visible (not dropped) |

**Green-gate:** all backend + frontend suites must pass; nothing committed.

### 9.4 New i18n keys (EN → ZH) — `apps/frontend/src/i18n.tsx`

| English key | ZH |
|---|---|
| `Add-on step` | `加仓步长` |
| `Add-on ladder` | `加仓阶梯` |
| `Add-on tiers` | `加仓档位` |
| `clips before the` | `笔，受限于` |
| `Add-on step must be positive` | `加仓步长必须为正数` |
| `The first add-on tier must sit below the stop-loss` | `首个加仓档位必须低于止损阈值` |
| `Applies to Taker–Taker and Maker–Taker; on Maker–Taker tiers fill from a resting quote.` | `适用于吃单–吃单与挂单–吃单；挂单–吃单时各档位由挂单成交。` |
| *(existing)* `Effective stop buffer`, `Stop-loss must exceed the entry threshold`, `Stop-loss exit triggered`, `Stop-loss Executed` | (per §5) |

Reused keys: `Entry threshold` (`:187`), `Take-profit threshold` (`:187`), `Stop-loss threshold` (`:294`), `Stop loss` (`:294`), `Optional` (`:294`).

### 9.5 Resolved decisions traceability

| Item | Decision | Where implemented |
|---|---|---|
| Option A | **Rejected** — absolute semantics kept | not implemented |
| B1 | Approved | A2 (`stop_loss_not_above_entry`) |
| B2 | Approved, **incl. maker** | A4 (taker `:2096-2097` + maker `:2265`) |
| O4 | Gate refuses future entries; **no pause** | A4 |
| C1 | Approved | B2 |
| C2 | Approved | A5 + B3 + A1 |
| Ladder | Approved, opt-in `addOnStepBps`; **supports both `TAKER_TAKER` and `MAKER_TAKER`** (sequential ladder) | A1–A4b + B1–B3 |
