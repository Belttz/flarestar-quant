-- Saved spread pairs (美股/跨标的自定义价差组合).
--
-- The pair strategies shipped so far derived both legs from ONE asset (`config.asset`), so a
-- cross-asset spread (SNDK vs SNXX — two different US-stock perps) could only be expressed by
-- hand-building a config. This table stores the pair itself so the 美股价差溢价套利 page can
-- list, reload and relaunch it: the two explicit leg symbols, the quantity conversion between
-- them, and the entry threshold that pair is normally traded at.
--
-- `ratio` is LEFT units per ONE right unit (right_qty = left_qty / ratio), the same convention
-- the premium/ADR strategies already use, so equal-notional pairs store ratio ≈ leftPrice /
-- rightPrice at save time and keep trading on that number until it is re-saved.
CREATE TABLE IF NOT EXISTS saved_strategy_pairs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  left_symbol TEXT NOT NULL,
  right_symbol TEXT NOT NULL,
  ratio TEXT NOT NULL,
  entry_bps TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS saved_strategy_pairs_name
  ON saved_strategy_pairs (name);
