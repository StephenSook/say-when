-- The input each session ran with (docs/station.md 2.3 and request T1), so a keyboard or switch session never counts
-- as a headset statistic. One row per session, written by the writer from the session's `session_start` ledger row,
-- whose outcome is the label the station chose (`<mode>-<purpose>`, for example `keyboard-test`). Only the input
-- word is stored, never the label: `headset`, `keyboard` or `switch` from the label's prefix, else `unknown`.
-- A plain table, not a hypertable: one row per session, a few a day. getStats counts headset sessions by default.
CREATE TABLE IF NOT EXISTS telemetry.session_inputs (
    session_id text NOT NULL,
    input text NOT NULL,
    started_at timestamptz NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT session_inputs_session_shape CHECK (session_id ~ '^(test-[A-Za-z0-9_-]{1,64}|[a-z0-9]+(-[a-z0-9]+)*:[0-9]{1,20})$'),
    CONSTRAINT session_inputs_input_word CHECK (input IN ('headset', 'keyboard', 'switch', 'unknown'))
);

-- The idempotency key: a session's input lands once (a restarted writer sends it again).
CREATE UNIQUE INDEX IF NOT EXISTS session_inputs_identity ON telemetry.session_inputs (session_id);
