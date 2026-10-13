-- Spread samples: 30-second top-of-book snapshots behind the spread-quality board's
-- `samples` source. The board's primary source rebuilds a pair's spread series from 24h of
-- 5m candles; this table is the second track of the approved dual-track design: while the
-- terminal runs, the sampler persists the *executable* spread of every quality-board
-- candidate once per 30s boundary. A pair that accumulates a full 24h of samples at >=80%
-- coverage is rebuilt from its own sample series instead (`source: 'samples'`), which sees
-- intra-candle dislocations a 5m close can never show; thinner pairs keep using candles.
-- `sampled_at` is aligned to the 30s boundary and doubles as the upsert key, so a retried
-- tick overwrites its bucket instead of duplicating a point.
-- Prices are stored as REAL, not the TEXT/Decimal convention of funding_rate_history and
-- portfolio_equity_samples: these rows are machine-computed float64 statistics inputs
-- (bps / notional), never user money, and REAL keeps the ~2.9k rows/pair/day insert cheap.
-- Known limitation, shared with portfolio_equity_samples: samples are only written while
-- the terminal runs, so the series has gaps whenever it is closed; the 24h coverage
-- requirement absorbs occasional gaps, and candles remain the fallback source throughout.
CREATE TABLE IF NOT EXISTS spread_samples (
  pair_type TEXT NOT NULL CHECK (pair_type IN ('SPOT_PERP', 'PERP_PERP')),
  asset TEXT NOT NULL,
  left_symbol TEXT NOT NULL,
  right_symbol TEXT NOT NULL,
  sampled_at INTEGER NOT NULL,
  spread_bps REAL NOT NULL,
  depth_usdt REAL NOT NULL DEFAULT 0,
  left_price REAL,
  right_price REAL,
  PRIMARY KEY (left_symbol, right_symbol, sampled_at)
);

CREATE INDEX IF NOT EXISTS spread_samples_pair_recency
  ON spread_samples(left_symbol, right_symbol, sampled_at DESC);
