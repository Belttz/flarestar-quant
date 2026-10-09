-- Portfolio equity samples: compact point series backing the asset-page equity curve.
-- `portfolio_snapshots` keeps only the 20 most recent whole documents (~100 minutes at the
-- ~5 minute reconciliation cadence), which cannot back 7d/30d charts. Three granularities are
-- persisted here instead; `bucket_start` is the epoch millisecond a sample aggregates to
-- (exact capture time for `raw`, floored hour/day boundary otherwise) and doubles as the
-- upsert key so a re-read of the same bucket overwrites instead of duplicating.
-- Newest sample in an hour/day bucket wins, which for a point-in-time balance is the
-- correct aggregate.
-- Known limitation: samples are only written while the terminal runs, so the series has
-- gaps whenever the terminal is closed; 7d/30d charts fill in over the first days.
CREATE TABLE IF NOT EXISTS portfolio_equity_samples (
  granularity TEXT NOT NULL CHECK (granularity IN ('raw', 'hour', 'day')),
  bucket_start INTEGER NOT NULL,
  sampled_at INTEGER NOT NULL,
  equity TEXT NOT NULL,
  unrealized_pnl TEXT,
  PRIMARY KEY (granularity, bucket_start)
);

CREATE INDEX IF NOT EXISTS portfolio_equity_samples_bucket_desc
  ON portfolio_equity_samples(granularity, bucket_start DESC);
