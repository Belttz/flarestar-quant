-- Carry strategy accounting snapshot (funding accrual, basis levels, fees, net PnL). Written by
-- the strategy engine and surfaced on the strategy record; NULL for every non-carry strategy.
ALTER TABLE execution_strategies ADD COLUMN metrics_json TEXT;
