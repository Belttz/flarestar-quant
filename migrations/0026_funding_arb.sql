-- Automatic perp ⇄ perp funding-rate arbitrage runner.
--
-- `funding_arb_settings` stores the operator's single settings object (one row, JSON). The runner
-- re-validates it against `FundingArbSettingsSchema` on every read, so a corrupt or hand-edited
-- row falls back to the defaults instead of taking the scanner down.
--
-- `funding_arb_decisions` is the audit trail: every candidate of every scan (PASS or REJECT with
-- its reason codes), the sizing result and the strategy it produced. It is the only way to answer
-- "why did it open / not open that pair" after the fact.
--
-- `funding_arb_dry_run_trades` holds the virtual trades of the dry-run mode: what the runner would
-- have opened, when it would have exited, and the estimated funding minus fees. Dry-run never
-- submits an order; these rows are what the panel shows while the settings say `dryRun: true`.
CREATE TABLE IF NOT EXISTS funding_arb_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS funding_arb_decisions (
  id TEXT PRIMARY KEY,
  scanned_at TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  strategy_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS funding_arb_decisions_scanned_at
  ON funding_arb_decisions (scanned_at DESC);

CREATE INDEX IF NOT EXISTS funding_arb_decisions_strategy_id
  ON funding_arb_decisions (strategy_id);

CREATE TABLE IF NOT EXISTS funding_arb_dry_run_trades (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL,
  short_venue TEXT NOT NULL,
  long_venue TEXT NOT NULL,
  quantity TEXT NOT NULL,
  notional_usd TEXT NOT NULL,
  entry_bps TEXT NOT NULL,
  apr_percent REAL NOT NULL,
  entered_at TEXT NOT NULL,
  exit_at TEXT,
  closed_at TEXT,
  funding_usd TEXT NOT NULL,
  fees_usd TEXT NOT NULL,
  pnl_usd TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS funding_arb_dry_run_trades_entered_at
  ON funding_arb_dry_run_trades (entered_at DESC);
