-- Errand and call outcomes, status only: one row per status an errand or call reached, at the server time the
-- module wrote it. No form values, read-backs, confirmation text, names, numbers or transcripts.
CREATE TABLE IF NOT EXISTS telemetry.action_outcomes (
    time timestamptz NOT NULL,
    session_id text NOT NULL,
    kind text NOT NULL,
    action_id bigint NOT NULL,
    status text NOT NULL,
    result text,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT action_outcomes_session_shape CHECK (session_id ~ '^(test-[A-Za-z0-9_-]{1,64}|[a-z0-9]+(-[a-z0-9]+)*:[0-9]{1,20})$'),
    CONSTRAINT action_outcomes_kind_word CHECK (kind IN ('errand', 'call')),
    CONSTRAINT action_outcomes_status_word CHECK (status IN (
        'drafted', 'previewed', 'awaiting_confirm', 'confirmed', 'submitting', 'submitted', 'refused', 'failed',
        'unknown_outcome', 'stopped', 'prepared', 'dialing', 'ringing', 'connected', 'ended', 'other')),
    CONSTRAINT action_outcomes_result_word CHECK (result IS NULL OR result IN (
        'answered', 'no_answer', 'busy', 'voicemail', 'cancelled', 'failed', 'refused', 'unknown', 'other'))
);

SELECT create_hypertable('telemetry.action_outcomes', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS action_outcomes_identity ON telemetry.action_outcomes (session_id, kind, action_id, status, time);
