-- One row per pick the module accepted (a `pick` row in its ledger). time_to_pick_ms runs from the moment the
-- picked option (or the yes or no prompt) began playing to the moment the module accepted the YES, both on the
-- SpacetimeDB server clock. It is NULL only when the writer never saw that option's reading step.
CREATE TABLE IF NOT EXISTS telemetry.picks (
    time timestamptz NOT NULL,
    session_id text NOT NULL,
    ledger_id bigint NOT NULL,
    question_id bigint NOT NULL,
    option_rank smallint NOT NULL,
    pick_kind text NOT NULL,
    time_to_pick_ms integer,
    late_by_ms integer NOT NULL DEFAULT 0,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT picks_session_shape CHECK (session_id ~ '^(test-[A-Za-z0-9_-]{1,64}|[a-z0-9]+(-[a-z0-9]+)*:[0-9]{1,20})$'),
    CONSTRAINT picks_kind_word CHECK (pick_kind IN ('reply', 'errand', 'call', 'menu', 'yes', 'no', 'other')),
    CONSTRAINT picks_rank_range CHECK (option_rank BETWEEN 0 AND 255),
    CONSTRAINT picks_time_range CHECK (time_to_pick_ms IS NULL OR time_to_pick_ms BETWEEN 0 AND 3600000),
    CONSTRAINT picks_late_range CHECK (late_by_ms BETWEEN 0 AND 3600000)
);

SELECT create_hypertable('telemetry.picks', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS picks_identity ON telemetry.picks (session_id, ledger_id, time);
