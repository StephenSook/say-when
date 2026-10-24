-- Time to pick per minute without timescaledb_toolkit: counts and sums only. p50 and p95 are then computed at
-- query time with percentile_cont over the raw `picks` rows in the window (src/stats.ts).
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry.picks_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    time_bucket(INTERVAL '1 minute', time) AS bucket,
    session_id,
    count(*) AS picks,
    count(time_to_pick_ms) AS timed_picks,
    sum(time_to_pick_ms)::bigint AS time_to_pick_ms_sum
FROM telemetry.picks
GROUP BY bucket, session_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry.picks_1m',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);
