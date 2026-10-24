-- One row per command the SpacetimeDB module recorded (a `gesture` row in its ledger), accepted or ignored.
-- Content-free by construction: ids, fixed words and numbers, each held to a fixed shape by a CHECK.
-- `time` is the module's own decision time (a SpacetimeDB server timestamp), never a laptop clock.
CREATE TABLE IF NOT EXISTS telemetry.switch_events (
    time timestamptz NOT NULL,
    session_id text NOT NULL,
    ledger_id bigint NOT NULL,
    gesture_id text NOT NULL,
    command text NOT NULL,
    outcome text NOT NULL,
    code text NOT NULL,
    resting boolean,
    false_activation boolean NOT NULL DEFAULT false,
    heard_step_seq bigint,
    option_rank smallint,
    heard_in text,
    latency_ms integer,
    late_by_ms integer,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT switch_events_session_shape CHECK (session_id ~ '^(test-[A-Za-z0-9_-]{1,64}|[a-z0-9]+(-[a-z0-9]+)*:[0-9]{1,20})$'),
    CONSTRAINT switch_events_gesture_shape CHECK (gesture_id ~ '^[A-Za-z0-9:_-]{1,64}$'),
    CONSTRAINT switch_events_command_word CHECK (command IN ('YES', 'NO', 'CONFIRM', 'STOP', 'HEADSET_OFF')),
    CONSTRAINT switch_events_outcome_word CHECK (outcome IN ('accepted', 'ignored')),
    CONSTRAINT switch_events_code_shape CHECK (code ~ '^[a-z][a-z0-9_]{0,39}$'),
    CONSTRAINT switch_events_false_needs_rest CHECK (NOT false_activation OR resting IS TRUE),
    CONSTRAINT switch_events_heard_in_word CHECK (heard_in IS NULL OR heard_in IN ('reading', 'window')),
    CONSTRAINT switch_events_rank_range CHECK (option_rank IS NULL OR option_rank BETWEEN 0 AND 255),
    CONSTRAINT switch_events_latency_range CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 3600000),
    CONSTRAINT switch_events_late_range CHECK (late_by_ms IS NULL OR late_by_ms BETWEEN 0 AND 3600000)
);

SELECT create_hypertable('telemetry.switch_events', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);

-- The idempotency key: a replayed ledger row lands once. A hypertable's unique index must include `time`.
CREATE UNIQUE INDEX IF NOT EXISTS switch_events_identity ON telemetry.switch_events (session_id, ledger_id, time);
