-- Retention keeps the free service (750 MB) far from full. Raw rows: 7 days. Per-minute aggregates: 30 days.
-- Invariant: raw drop_after (7 days) exceeds every aggregate's refresh start_offset (3 days), with 4 days of margin
-- to notice a failed refresh before retention could drop rows the aggregate still needs. Rows written later than
-- the refresh window (a backlog) are refreshed explicitly by the writer (src/sink.ts).
SELECT add_retention_policy('telemetry.switch_events', drop_after => INTERVAL '7 days', if_not_exists => TRUE);

SELECT add_retention_policy('telemetry.scan_steps', drop_after => INTERVAL '7 days', if_not_exists => TRUE);

SELECT add_retention_policy('telemetry.picks', drop_after => INTERVAL '7 days', if_not_exists => TRUE);

SELECT add_retention_policy('telemetry.action_outcomes', drop_after => INTERVAL '7 days', if_not_exists => TRUE);

SELECT add_retention_policy('telemetry.rest_minutes', drop_after => INTERVAL '7 days', if_not_exists => TRUE);

SELECT add_retention_policy('telemetry.switch_1m', drop_after => INTERVAL '30 days', if_not_exists => TRUE);

SELECT add_retention_policy('telemetry.idle_1m', drop_after => INTERVAL '30 days', if_not_exists => TRUE);

SELECT add_retention_policy('telemetry.picks_1m', drop_after => INTERVAL '30 days', if_not_exists => TRUE);
