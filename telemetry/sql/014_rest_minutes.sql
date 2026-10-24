-- Rest time per session per UTC minute, at one-second resolution. Bit k (0 to 59) of rest_mask is set when second
-- k of the minute was at rest; idle_ms is 1000 times the number of bits set. Rows merge with bitwise OR, so a writer
-- before and after a restart (or two writers) add up to the union of what they saw: never a double count.
-- "Resting" is defined in telemetry/README.md.
CREATE TABLE IF NOT EXISTS telemetry.rest_minutes (
    time timestamptz NOT NULL,
    session_id text NOT NULL,
    rest_mask bigint NOT NULL,
    idle_ms integer NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT rest_minutes_session_shape CHECK (session_id ~ '^(test-[A-Za-z0-9_-]{1,64}|[a-z0-9]+(-[a-z0-9]+)*:[0-9]{1,20})$'),
    -- Epoch arithmetic, so the minute is the same UTC-aligned minute as time_bucket('1 minute') in any time zone.
    CONSTRAINT rest_minutes_on_the_minute CHECK (mod(extract(epoch FROM time), 60) = 0),
    CONSTRAINT rest_minutes_sixty_seconds CHECK (rest_mask > 0 AND rest_mask < 1152921504606846976),
    CONSTRAINT rest_minutes_ms_from_mask CHECK (idle_ms = bit_count(rest_mask::bit(64)) * 1000)
);

SELECT create_hypertable('telemetry.rest_minutes', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS rest_minutes_identity ON telemetry.rest_minutes (session_id, time);
