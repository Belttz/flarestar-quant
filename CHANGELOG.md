# Changelog

All notable changes to Gate CrossEx are documented in this file.

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
