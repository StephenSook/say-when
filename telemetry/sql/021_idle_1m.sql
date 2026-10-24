-- Resting milliseconds per minute: the denominator of "false activations per idle minute".
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry.idle_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    time_bucket(INTERVAL '1 minute', time) AS bucket,
    session_id,
    sum(idle_ms)::bigint AS idle_ms
FROM telemetry.rest_minutes
GROUP BY bucket, session_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry.idle_1m',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);
