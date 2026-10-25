-- Direct select (PLAN D18, docs/direct-select.md): the decoder also sends PICK_1 (imagined left fist), PICK_2 (imagined
-- right fist) and PICK_3 (single jaw clench), and the module records each as a `gesture` ledger row, so they reach
-- switch_events like YES, NO, CONFIRM and STOP. HEADSET_OFF stays a system event (PLAN D11). There is no PICK_4.
-- This replaces the word list of switch_events_command_word (sql/010, applied, its checksum recorded) with eight words.
-- One ALTER TABLE drops and re-adds the named CHECK, so the change is atomic: the column is held by the old list or by
-- the new one, never by none. The new list holds every old word, so every stored row passes, and the CHECK is validated
-- as it is added (a scan of a few hundred rows under a short lock). NOT VALID then VALIDATE would only shorten that lock
-- on a large table, and its second statement could leave the CHECK unvalidated, which npm run verify reads as no CHECK.
-- Each chunk inherits the hypertable's CHECK, so the change reaches every chunk; TimescaleDB allows adding and dropping
-- constraints on a hypertable with the columnstore on (sql/050). DROP ... IF EXISTS keeps a re-run harmless.
-- Apply with npm run migrate before a writer that knows these words runs: the old CHECK refuses a PICK row, and one
-- refused row fails its whole batch on every retry. The writer refuses to start until this file is applied.
ALTER TABLE telemetry.switch_events
    DROP CONSTRAINT IF EXISTS switch_events_command_word,
    ADD CONSTRAINT switch_events_command_word CHECK (command IN ('YES', 'NO', 'CONFIRM', 'STOP', 'HEADSET_OFF', 'PICK_1', 'PICK_2', 'PICK_3'));
