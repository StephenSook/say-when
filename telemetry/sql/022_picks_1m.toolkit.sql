-- Time to pick per minute, with a timescaledb_toolkit percentile sketch (UddSketch) per bucket, so p50 and p95 over
-- any window come from rollup() of the buckets, never from averaging per-bucket percentiles. Chosen by
-- `npm run migrate` when the service has timescaledb_toolkit; 022_picks_1m.exact.sql is the other variant.
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;

CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry.picks_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    time_bucket(INTERVAL '1 minute', time) AS bucket,
    session_id,
    count(*) AS picks,
    count(time_to_pick_ms) AS timed_picks,
    sum(time_to_pick_ms)::bigint AS time_to_pick_ms_sum,
    percentile_agg(time_to_pick_ms::double precision) AS time_to_pick
FROM telemetry.picks
GROUP BY bucket, session_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry.picks_1m',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);
