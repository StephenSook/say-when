-- Columnstore (TimescaleDB compression) for the five raw hypertables, so older chunks take less of the free service.
-- Layout: each table is segmented by session_id (the first column of its idempotency index and the GROUP BY of every
-- aggregate) and ordered by time, newest first, then by the rest of its idempotency key. So every column of the unique
-- index is a segmentby or orderby column, the rule TimescaleDB applies to a unique key on a columnstore (it warns when
-- a key column is neither, tsl/src/compression/create.c). An INSERT into a columnstore chunk decompresses the batches
-- that could conflict, then the unique index decides as usual: ON CONFLICT DO NOTHING skips a replayed row and the
-- rest_minutes upsert merges with OR as before (src/chunk_tuple_routing.c, tsl/src/compression/compression_dml.c).
-- Invariant: every aggregate's refresh start_offset (3 days, 02*) <= columnstore after (3 days) < raw drop_after
-- (7 days, 030). A 1-day chunk is converted only once its end is 3 days old, so the rows the per-minute refresh and the
-- real-time view read are always in the rowstore. A late row older than 3 days (a backlog after an outage, or a replay
-- after a reconnect; the writer never sends one older than 6 days) can land in a columnstore chunk: it is checked
-- against the unique index there, and the writer refreshes the aggregates over it explicitly, as before (src/sink.ts).
-- The three aggregates stay in the rowstore. TimescaleDB refuses a columnstore policy that overlaps an aggregate's
-- refresh window (tsl/src/bgw_policy/policies_v2.c), and the writer's explicit refresh rewrites buckets up to 6 days
-- old, so keeping that refresh off converted buckets would need an `after` of 7 days or more. Their chunks are 10 days
-- wide, so only buckets 7 to 30 days old would ever convert, at one row per session per minute, and picks_1m holds a
-- timescaledb_toolkit UddSketch column that was not tested in the columnstore here. `npm run verify` checks that they
-- stay in the rowstore. ALTER TABLE sets fixed values and the policies use if_not_exists, like the other files.
ALTER TABLE telemetry.switch_events SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'session_id', timescaledb.orderby = 'time DESC, ledger_id');

ALTER TABLE telemetry.scan_steps SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'session_id', timescaledb.orderby = 'time DESC, step_seq');

ALTER TABLE telemetry.picks SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'session_id', timescaledb.orderby = 'time DESC, ledger_id');

ALTER TABLE telemetry.action_outcomes SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'session_id', timescaledb.orderby = 'time DESC, kind, action_id, status');

ALTER TABLE telemetry.rest_minutes SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'session_id', timescaledb.orderby = 'time DESC');

-- add_columnstore_policy is a procedure (CALL). Its job is policy_compression in timescaledb_information.jobs.
CALL add_columnstore_policy('telemetry.switch_events', after => INTERVAL '3 days', if_not_exists => true);

CALL add_columnstore_policy('telemetry.scan_steps', after => INTERVAL '3 days', if_not_exists => true);

CALL add_columnstore_policy('telemetry.picks', after => INTERVAL '3 days', if_not_exists => true);

CALL add_columnstore_policy('telemetry.action_outcomes', after => INTERVAL '3 days', if_not_exists => true);

CALL add_columnstore_policy('telemetry.rest_minutes', after => INTERVAL '3 days', if_not_exists => true);
