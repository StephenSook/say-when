-- One row per change of the public `scan_state` row the writer observed: the scan clock's phase, cursor and step.
-- `time` is `scan_state.updated_at` (server). Steps are recorded while the writer is connected; nothing here is text.
CREATE TABLE IF NOT EXISTS telemetry.scan_steps (
    time timestamptz NOT NULL,
    session_id text NOT NULL,
    step_seq bigint NOT NULL,
    question_id bigint NOT NULL,
    phase text NOT NULL,
    mode text NOT NULL,
    answer_mode text NOT NULL,
    cursor smallint NOT NULL,
    option_count smallint NOT NULL,
    pass smallint NOT NULL,
    planned_ms integer,
    outcome text,
    pause_reason text,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT scan_steps_session_shape CHECK (session_id ~ '^(test-[A-Za-z0-9_-]{1,64}|[a-z0-9]+(-[a-z0-9]+)*:[0-9]{1,20})$'),
    CONSTRAINT scan_steps_phase_word CHECK (phase IN ('idle', 'preparing', 'reading', 'window', 'veto', 'paused', 'other')),
    CONSTRAINT scan_steps_mode_word CHECK (mode IN ('answer', 'menu', 'other')),
    CONSTRAINT scan_steps_answer_mode_word CHECK (answer_mode IN ('pick', 'yes_no', 'other')),
    CONSTRAINT scan_steps_outcome_word CHECK (outcome IS NULL OR outcome IN ('picked', 'none', 'no_pick', 'stopped', 'cancelled', 'other')),
    CONSTRAINT scan_steps_pause_word CHECK (pause_reason IS NULL OR pause_reason IN ('headset_lost', 'headset_off', 'stop', 'idle', 'operator', 'other')),
    CONSTRAINT scan_steps_small_ranges CHECK (cursor BETWEEN 0 AND 255 AND option_count BETWEEN 0 AND 255 AND pass BETWEEN 0 AND 255),
    CONSTRAINT scan_steps_planned_range CHECK (planned_ms IS NULL OR planned_ms BETWEEN 0 AND 3600000)
);

SELECT create_hypertable('telemetry.scan_steps', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS scan_steps_identity ON telemetry.scan_steps (session_id, step_seq, time);
