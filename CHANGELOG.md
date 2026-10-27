# Changelog

All notable changes to Gate CrossEx are documented in this file.

## [5.0.0] - 2026-10-27

### Added

- **Automatic perp ⇄ perp funding-rate arbitrage runner.** It mirrors the Funding page hedge board server-side, scans every 60 minutes (configurable), and applies the full gate stack: funding-differential APR, per-wave net edge after the 27.2 bps round-trip cost, trailing persistence filter with `off` / `24h` / `24h+7d` modes and customisable ratio/sample thresholds, one-scan confirmation (history-replayed after a restart), duplicate/cooldown/day-loss limits, instrument/margin checks and a dynamic maker-vs-taker leg split. A `dryRun` mode records decisions and virtual trades without submitting orders; a live mode launches paired `position` strategies through the engine. Panel on the Funding page, six `/api/funding-arb/*` endpoints, decision/trade audit tables and a three-tier risk governor (ADL rank 4 partial reduce, rank 5 close, half-leg/orphan guard with order de-dup).
- **Funding-driven exits for position strategies**: funding-decay exit with dwell debounce, flip exit, smart-decline exit, minimum and maximum holding time. Engine entry quotes gain a configurable maker offset and a timeout that only cancels (never converts to market).
- **Historical replay tooling** (`sim/funding_arb_decay_sim.py`) for the hold-until-decay strategy, including persistence/confirmation/per-wave gates and both stale- and forward-signal boundaries.

### Changed

- Settings persistence/validation extended with confirmation, persistence, margin-headroom, ADL and maker-leg controls; decision reason codes now include `CONFIRMATION_PENDING`, `PAIR_COOLDOWN`, `DAILY_LOSS_LIMIT`, `FUNDING_PERSISTENCE`, `FUNDING_SPIKE`.
- Dry-run open positions now rehydrate from SQLite on restart; history-replayed confirmation removes the two-scan wait after a restart.

### Fixed

- **KRAKEN legs were permanently rejected by the settlement-distance gate.** Kraken's ticker payload does not publish a next-funding timestamp, so the adapter hard-coded `nextFundingAt: null`; the funding-arb monitor treats an unknown timestamp as "settlement too close" and rejected every candidate containing a KRAKEN leg (including the highest-APR LQTY/TREAD pairs). The adapter now derives the next hourly boundary, matching Kraken's hourly settlement cadence.

### Not implemented

- **Exchange-side stop/TP brackets.** The Gate CrossEx SDK (`gate-api` `CrossexOrderRequest.Type`) exposes only `LIMIT` and `MARKET`; there is no conditional/stop order type to place venue-side protection. The engine keeps its bot-side stop-loss and the ADL/orphan guardian instead.

## [0.4.1] - 2026-10-24

### Added

- **Server-side close reconciliation** (R2/R3): two new endpoints, `POST /api/close/plan` and `POST /api/close/verify`, plan a close from the venue's *live* balances and positions instead of the terminal's local snapshot. `planClose` answers each leg with the real orderable quantity (lot-floored, `minSize`/`minNotional` checked) or a skip reason (`dust` / `no_market` / `no_balance` / `locked_balance`); dust is never auto-liquidated. `verifyClose` re-reads the venue after the close and lists residuals with a reason and a suggestion. The position-close dialog now calls the plan before anything is submitted, and a new residual dialog surfaces anything the close could not finish. The carry strategy row gained a one-click **Close all** that plans, submits a two-slice reduce-only close, and verifies afterwards.
- The closePlan engine path now **reconciles rejected quantities and converges on its own** (R3): a reduce-only quantity rejection re-reads the venue once (single-flight) and retries at the real size; a leg whose venue position is gone is marked satisfied (`Exit quote withdrawn`); when every target is satisfied the strategy stops early instead of idling through the slice interval; a failing leg logs a warning and never blocks the other leg, and the strategy always converges to `COMPLETED`. Residual reporting no longer phantom-counts legs the venue already confirmed as flat.
- The `funding-rankings` and `funding-history/series` endpoints now answer from a **TTL + single-flight cache** (30s/60s, parameters in the key, failures never cached) instead of hitting the venue on every request (R5). The opportunities boards adopted **stale-while-revalidate**: a board fresh in the client cache paints instantly and revalidates in the background, so navigating back to a page never blanks it behind a spinner.
- Spread rows now carry their **leg quote timestamps** and an alignment verdict (R4): a spread is only considered executable when both legs' `quoteUpdatedAt` sit inside a shared 2000 ms budget (`GCT_SPREAD_SKEW_MS` configurable). Misaligned combinations are sunk to the bottom of the rankings, excluded from the candidate selection, and badged `Quotes misaligned` on the spread-quality board. The strategy pages display each leg's **Quoted at** time and judge the displayed spread with the *same* yardstick the engine's `freshMarketPair` gate uses — display and execution share one source of truth.
- The opportunities **spread-quality board gained sort chips and a pager** (R8): six server-side sort keys (score / current / mean / volatility / half-life / depth) with click-to-flip direction, and 20/50-per-page paging executed on the server over the cached board, so browsing the whole candidate set costs one page of rows per view.

### Changed

- The trading page's bottom panel collapsed from **eight per-market tabs to two merged lists** (R6/R7): *Positions* (contract positions + spot holdings, one value-ordered table with a per-row market-type tag) and *Orders* (open orders / order history / trade history across both businesses). The former tabs survive as market-type filter chips (All / Perpetual / Spot), legacy persisted tab keys are normalized so an old session never blanks the panel, and every action (cancel, close, buy-back, repay explainer) keeps its original wiring.
- The top navigation collapsed to **six first-level entries** (R9): 交易 / 策略▾ / 机会▾ / 资金费率 / 资产 / 更多▾. Opportunities became a dropdown over its four boards, Portfolio was promoted to a first-level entry, and Boros moved into the More menu. All routes stay reachable.
- Mobile UX hardening (R1/R10): every dialog mounts through a React portal to `document.body`, its backdrop closes only on a *stationary* tap (pointer-down/up within 10 px, so scrolling the page never dismisses it), the launch button pairs `state` with a `ref` double-guard against synchronous double-taps, and a disabled launch button always shows the reason. On phones dialogs go near-fullscreen with internal scrolling over `100dvh`, touch targets in the topbar/tabs/rows meet 44 px, and icon containers can no longer clip. A `console.info('[R1] …')` trace on dialog open and submit supports the root-cause record in `docs/mobile-regression-checklist-v0.4.1.md`.
- New UI copy ships in English and Chinese throughout (`Quoted at`, `Quotes misaligned`, `Close all`, the residual dialog, the plan-status line, merged-tab labels).

### Fixed

- **Mobile strategy launch could silently die on the confirmation tap** (R1). The root-cause audit found a stack of contributing causes — the old backdrop closed on synthesized `mousedown` (which touch fires *before* `click`), fixed-position dialogs shifted under the iOS keyboard, autofocus landed on the "Go back" button, and silently disabled buttons left no trace. The portal + pointer-exemption + dvh + ref-guard + visible-disabled-reason combination addresses all of them; the checklist document records the trace fields for the on-device verdict.
- **A cross-exchange close could leave残量 behind when the local snapshot was stale** (R2). Quantities for the close plan now always come from the venue via `/api/close/plan`; the frontend no longer derives close sizes from a portfolio snapshot, and the engine-side reconcile covers the residual path during execution.

## [0.4.0] - 2026-10-13

### Added

- A **spread quality board** on the opportunities page (fourth tab, next to funding / funding-top / spread). It ranks every executable (asset, sell venue, buy venue) combination not by how wide the spread is right now, but by how wide, stable and quick to revert it has been over the last 24 hours. Six factors are combined as weighted percentiles inside the candidate group: net mean spread (mean spread minus holding cost) 30%, volatility 20%, reversion speed (AR(1) half-life) 15%, skewness 15%, excess kurtosis 10% and top-of-book depth 10%, scored 0–100. Each row shows the current spread, mean, volatility, skewness, excess kurtosis, a symmetry badge, the half-life, the holding cost and the depth; asset rows expand to all of their combinations, exactly like the spread board. The series is rebuilt from 24 hours of 5-minute candles, the top 50 combinations by |spread| × absorbable depth are evaluated, and the board recomputes at most once every 5 minutes. Missing statistics show `—`, never a fabricated zero.
- The spread quality board also keeps a **30-second sample log** of every candidate combination (spread, depth, leg prices) while the terminal runs. Once a combination has accumulated a full day of samples, its row is rebuilt from that series instead of candles — the row's source badge says which. Until then the candle rebuild carries the board, so the ranking works from the first minute and sharpens over the first day.
- Strategy rows now carry **Net PnL** and **Locked profit** columns (visible in both the running and history tabs). Net PnL is the result after fees and funding; locked profit is the already-closed result in bps over the closed notional. Because CrossEx only reports realized PnL on perpetual legs, spot-leg results are rebuilt from fills with a moving weighted-average cost, so spot-heavy strategies no longer under-report. Unavailable data shows `—`.
- A read-only **strategy detail dialog**: clicking a strategy row (or opening a `?strategyId=` deep link) shows what the strategy is actually running — thresholds, execution method, ladder, position and PnL rows — with actions to open its execution log or to copy its configuration into the launch form.
- Restored strategies now say when a market cannot be followed: if one of their symbols is neither in the venue's market catalog nor registrable with the market hub, a `Strategy market unavailable` entry is written to the execution log (system category). A strategy running without quotes is now visible in the log instead of looking healthy while silently doing nothing.

### Changed

- Strategy execution logs are now split into **category tabs** (all / execution / risk / maker / system) with the per-category row count shown on each tab, keyset pagination over `(created_at, id)`, and honest empty states. Leg-level events are treated as an open set matched by prefix, so new engine events land in the right tab without a frontend change, and a sparse category is no longer buried under maker noise.
- Copying a strategy configuration into the launch form now goes through a query-derived remount key, so navigating to the same strategy kind twice in a row reloads the form with the new strategy's values instead of silently reusing the previous instance's state.
- Maker entry quotes for auto strategies are now gated by **proximity to the entry trigger**: an entry quote is rested only while the market sits within **25 bps** of the level that would open the position (for laddered strategies, the next reachable tier's level). Outside that band the engine parks the entry quote instead of resting an order far from the trigger and waiting for the market to walk to it; the change of state is logged once on entering the parked band and once on returning inside it, never once per tick. Exit quotes are unaffected, and the band is inclusive — a distance of exactly 25 bps still rests.
- Interactive controls across the terminal were moved off `aria-pressed` onto the semantics their role actually calls for — `aria-selected` on the tab lists and `aria-checked` on radio and checkbox groups — so assistive technology announces the active tab, language, theme, execution method, maker leg and venue filters correctly. (Toggle-style buttons must not advertise `aria-pressed`; the grouping semantics were previously missing.)
- Every workspace manifest, the lockfile and the version shown in the UI are now unified to **0.4.0**. The root `package.json` stays the single source of truth (the frontend reads its own synced manifest at build time, not a hard-coded constant).

### Fixed

- **A Maker–Taker take-profit exit could livelock and churn a position forever.** As long as a position existed the engine kept a maker exit order resting, and the take-profit spread never entered the exit judgement — so after the maker leg filled, the "replenish the lagging leg" logic simply bought back the leg that had just been closed. The position could never reach zero: one leg churned endlessly while the other never received a closing order. Exits are now driven by a **price-triggered latch**: the exit sequence arms only once the spread enters the take-profit band. The maker leg then leaves through a reduce-only limit order and the hedge leg follows with its own reduce-only limit capped at 3 bps of slippage (an unfilled order is cancelled and re-quoted after 1500 ms). If the position is still not flat 30 seconds after arming, the slippage cap widens to 10 bps and a `Maker exit fallback` entry is written to the log — so the position actually closes instead of circling.
- **An armed take-profit exit no longer goes silent when market data drops.** Once the latch was armed, a missing spread series (an interrupted market-data channel) used to disable both the hedge-following path and the time fallback, leaving the position open forever with nothing in the log. The time-based fallback now keeps running regardless, so an interrupted feed delays the exit instead of silently cancelling it.
- **Sorting on the funding rankings was dead**: clicking the Funding APR, 24h volume or Open interest column header did nothing. The click handler spread `{ key, dir }` into a filter model whose field is named `sort`, so the request never carried the sort parameters and the backend always answered in its default order. The header now maps the column to the filter properly, and the choice round-trips through the URL. (The bug shipped in 0.3.2; the backend comparators were correct all along.)
- PnL reconstruction no longer counts the fee of a zero-quantity fill, treats an unparseable or infinite mark price as missing (`null`) instead of throwing or leaking an `Infinity` string into the API, and serialises very small magnitudes in plain decimal notation instead of `1e-18`.
- **A reduce-only exit rejected with `TRADE_REDUCE_ONLY_POSITION_QTY_ERROR` no longer burns the five-strike budget.** That error means the venue holds less than the engine's ledger believes — the position was closed outside the terminal (manually, by liquidation, or by the opposite leg) — so retrying could never succeed and the strategy drifted into `PAUSED` while still carrying the exposure. The engine now reconciles positions from the venue immediately on that error: a **Maker–Taker** exit re-reports at the venue's real size (`Exit size corrected`) or withdraws the quote when nothing is left to close (`Exit quote withdrawn`); a **Taker–Taker** exit that finds no reducible position pauses at once with the real reason instead of five more doomed attempts. When the venue confirms the ledger — or cannot be read — the rejection falls back to the ordinary accounting unchanged, so a genuine submission failure still surfaces exactly as before.
- **Restored strategies now re-subscribe to market data.** A strategy that came back after a restart (or after switching to live mode) was re-attached to the engine without registering its leg symbols with the market hub, so it sat in `RUNNING` while receiving no quotes and placing no live orders — only strategies opened *after* the restart had working quotes. The recovery path now registers and watches every restored strategy's markets, exactly like a fresh start. Strategies restored from a persisted close plan (`closePlan`) go through the same registration: previously they came back quote-less too, and a long slice interval could leave one stuck waiting for quotes that never arrived. (The hub's quote table is in-memory, so a restart always had to register the symbols again.)
- **A symbol that failed once is no longer blacklisted for good.** An upstream `invalidSymbols` verdict used to mute a symbol permanently, so a transient rejection — or a symbol the venue only listed later — could never recover while a running strategy kept it referenced. Invalid verdicts are now held for a bounded, exponential backoff window and are cleared the moment the channel delivers real data again; that clearing now covers the funding, open-interest, order-book, kline and trade channels, not just tickers (previously only the ticker branch ever released a symbol).

## [0.3.2] - 2026-10-11

### Added

- Optional laddered add-ons for auto spread strategies: a new **Add-on step** field (bps, auto only) admits one clip (= per-order quantity) each time the spread advances another step past the entry threshold, instead of adding a clip on every evaluation tick. Blank keeps today's tick-driven accumulation, so every already-running strategy is unaffected.
- The add-on ladder works on both execution methods. On Taker–Taker the tier is derived from the live spread; on Maker–Taker the resting entry quote is priced at the next unfilled tier's level and walks outward one step per filled clip, still keeping a single resting entry quote.
- The auto form now shows the **effective stop buffer** (`stopLossBps − |entryBps|`) next to the stop-loss field, in the launch summary and in the confirmation rows. The stop compares an absolute spread level while entry only requires `spread >= entryBps`, so a 65 bps entry under a 100 bps stop tolerates 35 bps of further adverse move — previously the UI implied 100.
- A live **add-on tier preview** under the threshold fields lists every reachable tier and the cap that limits it, e.g. `Add-on tiers: 50 / 70 / 90 bps · 3 clips before the 100 bps stop`, or `· 5 clips · limited by max position`.
- Add-on clips carry their tier in the log condition (`Add-on tier 2 · spread 88.40 bps ≥ 70 bps`) instead of a new event name, so existing log filters keep working.

### Changed

- Auto strategies now refuse to open while the live spread already sits at or beyond the stop-loss line, on the maker path as well as the taker path. Previously a position could be opened that stopped out on the very next evaluation.
- Laddered add-ons stop at the stop-loss line: no entry clip or maker entry quote is placed once the next tier's level would reach the stop. The strategy stays `RUNNING` and can still place exit quotes.
- Auto configs are now validated at launch: `stopLossBps` must exceed `|entryBps|` (a stop at or inside the entry level could never be held), and `|entryBps| + addOnStepBps` must stay below `stopLossBps` (otherwise the first add-on tier is unreachable). The strategy form blocks both with a plain-language reason before anything reaches the engine.
- The stop-loss judgement is now a single shared predicate used by both the stop path and the entry gate, so the two can no longer drift apart.

### Fixed

- Stop-loss exits were logged as `Take-profit triggered` / `Take-profit Executed`, so an unwind driven by the stop-loss showed up as a take-profit in the log list and in the risk tab. They are now logged as `Stop-loss exit triggered` / `Stop-loss Executed`, classified under **risk**, and historical clips that were mislabelled before this release regroup under the stop-loss label.

## [0.3.1] - 2026-10-11

### Added

- `npm run version:sync` (`scripts/sync-version.mjs`): pins every workspace manifest and `package-lock.json` to the version declared in the root `package.json`, which is now the single source of truth. Supports `--check` for CI and fails loudly on structural problems.
- `npm run release:server` (`scripts/release-server.mjs`): one-command release helper — verifies version consistency, builds, produces `deliverables/dist/flarestar-quant-<version>-src.tar.gz` from HEAD via `git archive`, and prints the tag/push and server-upgrade commands. It never commits, tags, or pushes.
- `npm run test:version` (`scripts/version-consistency.test.mjs`): regression test asserting workspace versions, `@gate-crossex/*` dependency ranges, the sync plan, and the `cloud.env` ignore rule.

### Changed

- Unified all workspace versions from the drifting `0.3.0`/`0.2.5` values to `0.3.1`, so the release-bundle version guard passes again.
- `.gitignore` now ignores the root `cloud.env` (domain + login password) in a root-anchored way; `deploy/cloud.env.example` stays tracked.

### Fixed

- `/health` now reports the real application version. The endpoint previously used `process.env.npm_package_version`, which is unset when the Docker image starts the server with a bare `node`, so it always reported the hard-coded `0.1.0`; it now reads the backend package version (compiled and source layouts alike) with a safe fallback.

## [0.3.0] - 2026-10-10

### Added

- One-command server deployment. `deploy/server/bootstrap.sh` clones the repository and installs (or upgrades) the terminal on a fresh Linux host from a single `curl … | bash`, then builds and starts a Docker Compose stack whose Caddy reverse proxy provisions HTTPS. Re-running the same command upgrades in place and keeps `cloud.env` and `.local-data/`.
- Windows one-click deployment under `deploy/windows/`: private Node bootstrap, dependency install, build, background start, Start-menu shortcut, optional autostart, and a read-only health check.
- Funding-rate, spread, and single-venue funding rankings on the opportunities page, with per-venue asset detail, category filtering, sorting, pagination, and collapse/expand per asset.
- Trade-page execution tabs for both business lines (positions, open orders, order history, fills), with row-level cancellation of resting and historical orders.
- Portfolio equity sampling with 1D/1W/1M/1Y chart periods, plus CrossEx account transfers from the funding page.
- Carry strategies can now trade both legs across every venue pair — the spot leg on a venue that runs a spot business, the perpetual leg on a venue that runs futures — with balance gating routed per leg and annualised yield derived from each venue's actual funding interval.
- Short spot positions are visible and closable: a CrossEx coin liability is shown as a signed negative holding with one-click market buy-back, and a "how to repay" guide appears when the venue has no spot market for that coin.

### Changed

- Renamed the product to **星闪量化 FlareStar Quant** (previously StarFlash Quant). The source repository is now `Belttz/flarestar-quant`.
- A spot sell ticket now caps quantity at the coin's available balance instead of the quote-currency balance, so a sell without the asset is rejected before it reaches Gate.
- Market-data WebSocket connections are sharded so every channel stays within Gate's 100-symbols-per-connection limit; oversized subscriptions were rejected wholesale upstream.

### Fixed

- `/opportunities/funding-top` and `/tools/trading-fees` returned 404 on a hard refresh because the backend never registered them as client routes.
- Spot closes no longer submit the raw balance and skip lot-size rounding, which Gate rejected with `TRADE_ORDER_LOT_SIZE_ERROR`.
- The strategy asset-search dropdown rendered behind the exchange-B selector.
- Quote-currency debts can be bought back when the venue lists the pair, and liability-only spot holdings are no longer dropped by the venue's spot-business filter.

## [0.2.5] - 2026-09-16

### Added

- Added Lighter as a CrossEx venue: `LIGHTER_FUTURE_{asset}_USDC` perpetuals now appear in the market catalog, execution-venue menu, strategy legs, favorites, funding overview, and funding history. Chart backfill and realized funding come from Lighter's public REST API (hourly settlements, signed by paying side), and the `CROSSEX_LIGHTER` transfer account is offered for USDC moves to and from Gate Spot, matching Gate's documented restriction.
- Boros strategies with a Lighter leg are now executable on CrossEx instead of being marked manual-only.

## [0.2.4] - 2026-09-05

### Fixed

- Reconciliation now gets stuck orders cancelled by itself when Gate will not act on the id the terminal holds: it adopts the id Gate lists for the order and cancels by that id, treats Gate's `TRADE_ORDER_NOT_FOUND_ERROR` like a 404, and closes a local row only after Gate's open-order list confirms the order is gone.
- The blocked-activation panel no longer asks users to cancel orders on a Gate website, which CrossEx does not have; Retry re-sends the cancellations from the terminal and Gate's not-found responses are explained in plain language.

## [0.2.3] - 2026-09-05

### Fixed

- Live-mode activation and credential changes no longer stay blocked by stale local orders: order reconciliation now cross-checks Gate's open-order list when the order endpoint refuses an id, closes rows Gate no longer lists, and tolerates sparse order payloads.
- Blocked activations now report each unconfirmed order with its symbol, side, state, and reason in the trading-mode dialog, the backend log, and the audit trail, with a retry action instead of a bare list of ids.

### Changed

- Refreshed the transitive `browserslist` and `fast-uri` dependencies to clear the high-severity advisories that gate releases.

## [0.2.2] - 2026-08-14

### Added

- Added secure multi-account credential profiles with switching, renaming, deletion, and account-aware strategy ownership.
- Added a shared grouped-position view across Trade, Strategies, and Portfolio, including live ADL risk indicators and position-closing controls.
- Added direction-aware realized funding analytics and streamed premium-history data for paired strategies.

### Changed

- Strengthened strategy launch, execution, recovery, and ticker-delivery checks while reducing redundant authenticated and market-data work.
- Improved venue selectors, responsive layouts, light-theme coverage, typography, translations, and accessibility checks.

### Fixed

- Serialized credential mutations against live orders, leverage changes, strategy operations, and transfers.
- Prevented stale positions, fee schedules, portfolio activity, and transfer state from leaking across account switches.
- Bounded supplemental ADL enrichment so unavailable or rate-limited rank data cannot stall portfolio refreshes.

## [0.2.1] - 2026-08-10

### Added

- Added a bilingual interactive CLI update check that detects newer published GitHub releases and offers to run the existing update workflow before startup.

### Changed

- Update checks now skip non-interactive launches, development branches, pinned source refs, offline failures, and sessions with `GCT_SKIP_UPDATE_CHECK=1`.
- Source bootstraps now validate that the update-check helper is present before activating a downloaded source tree.

## [0.2.0] - 2026-08-10

### Added

- Added a Boros by Pendle fixed-rate workflow for comparing and executing fixed funding-rate opportunities.
- Added asset-grouped positions with immediate or scheduled, batched reduce-only closing.
- Added account trading-fee comparison by market.

### Changed

- Funding rates now use each venue's native settlement interval, with normalized comparisons, more efficient refreshes, and last-known-good data retention.
- Strategy launches and direct orders now validate margin requirements and leverage-tier position limits before execution.
- Strategy reconciliation and recovery now handle maker/taker execution and residual hedge repair more robustly.

### Fixed

- Added stop and log support for close-position strategies.
- Kept funding data available when optional Gate or Binance market metadata cannot be loaded.
- Updated the transitive `nanoid` dependency to a release without high-severity audit findings.
