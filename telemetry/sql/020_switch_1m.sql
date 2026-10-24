-- Per-minute command counts, as a real-time continuous aggregate (materialized buckets plus the newest raw rows).
-- `commands` counts the person's four commands (YES, NO, CONFIRM, STOP); HEADSET_OFF is a system event (PLAN D11).
-- `false_activations` follows the definition in telemetry/README.md. sum(CASE ...) is the form known to work here.
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry.switch_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    time_bucket(INTERVAL '1 minute', time) AS bucket,
    session_id,
    count(*) AS events,
    sum(CASE WHEN command IN ('YES', 'NO', 'CONFIRM', 'STOP') THEN 1 ELSE 0 END) AS commands,
    sum(CASE WHEN command = 'YES' THEN 1 ELSE 0 END) AS yes_count,
    sum(CASE WHEN command = 'NO' THEN 1 ELSE 0 END) AS no_count,
    sum(CASE WHEN command = 'CONFIRM' THEN 1 ELSE 0 END) AS confirm_count,
    sum(CASE WHEN command = 'STOP' THEN 1 ELSE 0 END) AS stop_count,
    sum(CASE WHEN command = 'HEADSET_OFF' THEN 1 ELSE 0 END) AS headset_off_count,
    sum(CASE WHEN outcome = 'accepted' THEN 1 ELSE 0 END) AS accepted,
    sum(CASE WHEN outcome = 'ignored' THEN 1 ELSE 0 END) AS ignored,
    sum(CASE WHEN outcome = 'ignored' AND code = 'refractory' THEN 1 ELSE 0 END) AS refractory,
    sum(CASE WHEN false_activation THEN 1 ELSE 0 END) AS false_activations,
    sum(CASE WHEN resting IS TRUE AND command IN ('YES', 'NO', 'CONFIRM', 'STOP') THEN 1 ELSE 0 END) AS commands_at_rest,
    -- A YES at rest that did something (opened the menu, or lifted a pause). Intended or not cannot be told
    -- apart, so it is reported beside the false activations, never inside them.
    sum(CASE WHEN resting IS TRUE AND command = 'YES' AND outcome = 'accepted' THEN 1 ELSE 0 END) AS yes_acted_at_rest,
    sum(CASE WHEN latency_ms IS NOT NULL THEN 1 ELSE 0 END) AS timed_commands,
    sum(coalesce(latency_ms, 0))::bigint AS latency_ms_sum
FROM telemetry.switch_events
GROUP BY bucket, session_id
WITH NO DATA;

-- Refresh the last 3 days every minute (only changed buckets are recomputed). Raw retention (7 days, 030) must
-- stay longer than this start_offset, or retention would silently erase buckets the refresh still covers.
SELECT add_continuous_aggregate_policy('telemetry.switch_1m',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);
