-- The station chooses each gesture id (1 to 64 letters, digits and _ : -), so an id could carry words. The writer
-- needs it only in memory, to pair a pick with its gesture; ledger_id already links a row to the module's ledger.
-- Dropping the column (its CHECK goes with it) leaves every stored text column a fixed word, a code or the session key.
ALTER TABLE telemetry.switch_events DROP COLUMN IF EXISTS gesture_id;
