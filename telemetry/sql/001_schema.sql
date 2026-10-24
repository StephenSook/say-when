-- NeuroLingo telemetry lives in its own schema. Telemetry only: no app state (PLAN D2), and no content.
-- Statements are run one at a time, outside any transaction block; each one ends with a semicolon at the end of a line.
CREATE SCHEMA IF NOT EXISTS telemetry;
