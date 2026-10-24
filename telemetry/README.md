# NeuroLingo telemetry (Tiger Data)

PLAN row 6.1. A read-only subscriber to the SpacetimeDB module that turns what the person's switch did into content-free rows in a Tiger Data (TimescaleDB) service, plus one function that returns the numbers the dashboard shows. Telemetry only: no app state lives in Tiger (PLAN D2), and telemetry never writes to SpacetimeDB.

```
SpacetimeDB (public tables, anonymous views)            Tiger Cloud: neurolingo-telemetry (ipx9051gbc, free, us-east-1)
  board_ledger  scan_state  board_errands   --->  tracker  --->  writer  --->  5 hypertables
  board_calls   device_status                     (pure)        (1 s batches,   3 real-time continuous aggregates
  (station online and decoder health, ticks)                     bounded queue)   retention policies
                                                                                     |
                                                                getStats()  <--------+   npm run stats, a Next.js route
```

## What is stored, and what never is

Every row is ids, fixed words and numbers. Every text column is a word from a fixed list, a short code, or the session key, and has a CHECK that holds it there, so even a bug cannot store a sentence. `npm run verify` checks that from the live catalog, over every column of every hypertable: exactly the expected columns with their types (so none was added), no `gesture_id` under any type, and every text column held by a validated CHECK whose whole definition is the expected one (the pattern or word list of the SQL file, as PostgreSQL prints it), so a loosened pattern, a `LIKE '%'`, an added `OR` branch or a CHECK that only tests for NULL fails.

| Hypertable | One row per | Columns |
|---|---|---|
| `telemetry.switch_events` | command the module recorded (a `gesture` ledger row), accepted or ignored | time, session_id, ledger_id, command (YES, NO, CONFIRM, STOP, HEADSET_OFF), outcome (accepted or ignored), code (the action or the ignore reason), resting, false_activation, heard_step_seq, option_rank, heard_in (reading or window), latency_ms, late_by_ms |
| `telemetry.scan_steps` | change of the public `scan_state` row | time, session_id, step_seq, question_id, phase, mode, answer_mode, cursor, option_count, pass, planned_ms, outcome, pause_reason |
| `telemetry.picks` | accepted pick (a `pick` ledger row) | time, session_id, ledger_id, question_id, option_rank, pick_kind, time_to_pick_ms, late_by_ms |
| `telemetry.action_outcomes` | status an errand or call reached | time, session_id, kind (errand or call), action_id, status, result (calls only) |
| `telemetry.rest_minutes` | minute of a session with any rest | time (the minute), session_id, rest_mask (bit k set: second k was at rest), idle_ms |

`session_id` is `<SpacetimeDB database>:<session id>` (for example `say-when-demo:3`), because session ids restart at 1 in each database. Test data uses keys that start with `test-` and is never counted as usage.

Never stored: question text, option text, memory text, reply text, form values, read-backs, confirmation text, screenshots, contact names, phone numbers, call transcripts, digests, device labels, identities, and gesture ids. The station chooses each gesture id (any 1 to 64 letters, digits and `_:-`), so one could carry words; the writer uses it in memory only, to pair a pick with its gesture, and `ledger_id` links a row to the module's ledger (`sql/040` dropped the column the first schema had). The source does not subscribe to any view that carries them (`public_board`, `board_payloads` and the per-role views). The two board views it does read (`board_errands`, `board_calls`) have text columns that are filled while board sharing is on, and `device_status` has a label; the normalizers never read those columns, and a device identity is held in memory only, to tell devices apart. `test/privacy.test.ts` plants such text in every string field and checks none of it reaches a row or a SQL parameter.

## Why Tiger

The dashboard numbers are time-series questions over switch reliability: how often the headset fired with nothing to act on per minute of rest, over a sliding window; the median and 95th percentile time to pick; commands per minute. Tiger answers them where the rows live:

- **Hypertables** partitioned by day, each with an idempotency index (`(session_id, ledger_id, time)` and so on), so a replayed row lands once.
- **Real-time continuous aggregates** (`switch_1m`, `idle_1m`, `picks_1m`, `materialized_only = false`): the dashboard reads one-minute buckets that a policy refreshes every minute, plus the newest raw rows for the buckets not yet refreshed.
- **timescaledb_toolkit percentiles**: each `picks_1m` bucket stores a UddSketch (`percentile_agg`); p50 and p95 over any window come from `rollup()` of the buckets, never from averaging per-bucket percentiles. The migration picks this variant when the service has the extension (it does), else an exact variant that computes `percentile_cont` at query time.
- **Retention policies** keep the free service (750 MB) far from full: raw rows 7 days, aggregates 30 days. Raw retention (7 days) is longer than every refresh window (3 days), so retention can never erase rows an aggregate still recomputes.

SpacetimeDB holds the live state (D1); Tiger holds the measurements.

## Definitions

All times are SpacetimeDB server timestamps (microseconds), never this laptop's clock. Durations are differences of two server timestamps.

- **Resting.** The session is live (after its `session_start` ledger row, before its `session_end`), nothing is on offer, nothing is in flight, and the decoder is reading the person:
  - `scan_state.phase` is `idle`, or `paused` on purpose (`pause_reason` stop, idle or operator). The deliberate pause counts because the module pauses itself after 2 minutes without a command (`idle_pause`), and a person at rest spends most of the time in that state. A pause for a lost or removed headset (`headset_lost`, `headset_off`) is not resting.
  - no errand is open (drafted, previewed, awaiting_confirm, confirmed or submitting) and no call is open (prepared, awaiting_confirm, confirmed, dialing, ringing or connected);
  - the session's own station is online, has reported a healthy decoder, and was seen within the last 8 seconds (`device_status`). Health must be reported: a station that has not sent a heartbeat yet has none, and counts as not reading. The 8 seconds come from the module: `device_status` is refreshed about every 2 s, and if heartbeats stall the dead-man lease (at most 5 s) marks the station offline, so a live station is always seen again within about 7 s. "Its own station" is read from public rows: the module runs one session at a time, only that session's station can heartbeat, and `start_session` stamps it with the start time, so a station counts for a session only if it was seen since the session started. That matters because `end_session` never marks a station offline: a station left online by an ended session never vouches for a later one. A station whose identity is paired again with another role (revoked, then paired as a partner) stops counting at once, as lost at its last sighting as a station. The station rule matters most inside a deliberate pause: when the station drops then, the module keeps the pause as it is (a signal pause never replaces a deliberate one), and `device_status` going offline is the only public sign that nobody is being read.
- **Idle minutes.** Resting time the writer observed, at one-second resolution: a second counts when its midpoint falls inside a rest period. Each minute of a session is one `rest_minutes` row whose 60-bit mask marks its rest seconds; rows merge with bitwise OR, so a writer before and after a restart (or two writers) add up to the union of what they saw, never a double count. `idle_1m` sums them per minute. A healthy sighting vouches for 8 seconds. When a station is reported lost (offline, or an unhealthy decoder), rest ends at its last sighting, whichever of that row or the module's pause arrives first, and also when the loss is only seen in the snapshot after a reconnect. When no such row comes and the server clock moves more than 8 seconds past the last healthy sighting, rest ends 8 seconds after it, at once, so nothing judged later can land in the silence; a station seen again starts rest again. Rest is written only up to a settled time (the last healthy sighting, a loss, or the end of a sighting's 8 seconds), so a row that arrives later can still correct what follows it. After a restart, rest in an idle scan is counted back to the scan's last change (a station drop would have paused it), but rest in a deliberate pause only from the moment the writer is connected. Rows more than 6 days behind the latest server time are dropped and counted (`tooOld`): raw rows are kept 7 days, and recomputing an aggregate over rows whose neighbours retention already removed could replace a complete bucket with a partial one.
- **False activation.** A YES, NO, CONFIRM or STOP that the module recorded as having nothing to act on, while the session was resting: `ignored:idle` (NO, or YES with the menu off, with nothing on offer), `ignored:nothing_to_confirm` (CONFIRM with nothing awaiting confirmation), `ignored:paused` (NO or CONFIRM during a pause), `ignored:already_paused` (STOP during a pause). The module's own decision (docs/spacetime.md 4.2) says there was nothing to act on; the writer's timeline says the person was at rest. HEADSET_OFF is a system event (D11) and never counts. Refractory repeats, stale steps and the like are not counted (they are about a command that had something to act on). The resting state used is the one strictly before the command, so a command that changed the state (a YES that opened the menu) is judged by the state it found. Commands are judged on the same timeline as the rest seconds, so a command more than 8 seconds after the last healthy sighting is never at rest, and a command replayed after a reconnect is at rest only where the reconnect could prove rest.
- **False activations per idle minute.** False activations in the window divided by idle minutes in the window. It is null (shown as "not enough rest yet") until the window holds at least one idle minute, so a few seconds of rest cannot turn one misfire into a large rate. Commands and rest the writer did not observe are both left out, so a gap can leave the rate unknown but can never inflate it.
- **YES at rest that acted.** A YES at rest that opened the menu or lifted a pause. Whether it was meant cannot be told from the records, so it is reported beside the rate (`yesActedAtRest`), never inside it. With the menu on (the default, PLAN Q9), a false YES at rest opens the menu and shows up here, not in the rate.
- **Latency (`switch_events.latency_ms`).** For a command the module matched to an option (pick, skip, yes or no answer, a NO for an option already passed): from the moment that option began playing (the `step` ledger row of the reading the station reported hearing) to the module's decision. `heard_in` says whether the command was heard during the option's audio or in the silent window after it. `late_by_ms` is the module's grace-window lateness.
- **Time to pick (`picks.time_to_pick_ms`).** From the moment the picked option (or the yes or no prompt) began playing to the moment the module accepted the YES. The `pick` row and its gesture row share a transaction and a gesture id; the pick is timed from the reading that gesture was matched to, so a late pick inside the grace window, even one under a millisecond late, is timed from the option the person heard. If the gesture row never arrives (it always should), the pick is timed from the question's readings instead and counted as unpaired. Null only if the writer never saw the reading.
- **Commands per minute.** The person's four commands (YES, NO, CONFIRM, STOP, accepted or ignored) in the window, divided by the minutes the window has covered.
- **Rows written** and **last write.** Rows stored in the five hypertables for real sessions (within retention), and the newest `ingested_at`, which is Tiger's own clock at insert.
- **The window.** The 30 one-minute buckets ending with the current one (the newest still filling), so it spans between 29 and 30 minutes. Numerators and denominators use the same buckets.

## Running it

Node 22. From `telemetry/`:

```
npm install
npm run migrate                              # applies sql/*.sql to the service, one statement per call, then verifies
npm run verify                               # read-only: checks every hypertable, aggregate, policy, job and index against the live catalog
SPACETIMEDB_DB=say-when-demo npm run writer  # subscribes and writes until Ctrl-C
SPACETIMEDB_DB=say-when-dev npm run check:source  # one-shot: reads the module through the bindings, prints counts and contract errors, writes nothing
npm run stats                                # read-only: prints the dashboard numbers; add -- --json, -- --window=10
npm test                                     # unit tests, no network
npm run test:live                            # TIGER_IT=1: writes a synthetic test- session to the live service, checks, deletes it
npm run cert:check                           # compares the server's certificate chain with the pin
```

| Variable | Used by | Default |
|---|---|---|
| `TIGER_DATABASE_URL` | everything | unset: the Tiger CLI supplies the string (`tiger db connection-string ipx9051gbc --with-password`), kept in memory |
| `TIGER_SERVICE_ID` | everything | `ipx9051gbc` |
| `TIGER_READ_ONLY=1` | everything | read-only for `stats` and `verify` only |
| `TIGER_PIN_LEAF=1` | everything | off: also require the exact leaf certificate |
| `SPACETIMEDB_DB` | writer, check:source | writer: required, for example `say-when-dev` or `say-when-demo`; check:source: `say-when-dev` |
| `SPACETIMEDB_URI` | writer, check:source | `https://maincloud.spacetimedb.com` |

The writer and `check:source` import the generated bindings from `spacetime/bindings/agent`, which resolve `spacetimedb` from `spacetime/node_modules`, so run `npm install` in `spacetime/` as well.

Migrations are recorded in `telemetry.migrations` with a checksum: a second run skips them, and an edited file that was already applied is refused (write a new file instead).

The writer batches every second (at most 500 rows per insert) and keeps a bounded queue (20,000 rows). On a Tiger outage it keeps the rows and retries with a doubling wait (1 s up to 30 s); past the cap it drops the oldest rows, counts the drops per table and releases their memory. If Tiger cannot be reached when the writer starts, it starts anyway and queues. On Ctrl-C it waits for a batch already out, sends what is left within 5 seconds, and logs how many rows it could not write. It checks the database size every 5 minutes and pauses writes above 600 MB (the free service turns read-only at 750 MB). It logs a status line every 30 seconds. A batch holding rows older than the aggregates' 3-day refresh window (a backlog after a long outage) is followed by an explicit `refresh_continuous_aggregate` over the minutes those old rows touched, so they reach the aggregates too. The range is built from the old rows alone, so it never reaches the current, still-filling minute (refreshing that would hide its later rows from the real-time view until the next refresh). Rows more than 6 days old are refused and counted, never inserted or refreshed.

## Credentials

A password, or a connection string that contains one, is never printed, logged, written to disk or committed. It comes from `TIGER_DATABASE_URL` if set; otherwise `tiger db connection-string <service> --with-password` runs as a child process and its output stays in memory. If that command fails, its output (stdout or stderr) is never repeated: the error carries only the exit code and fixed guidance. Every other error that leaves the package goes through `redact`, which removes the password, its URL-encoded form, the whole string, the password part of any postgres URL even when it is not known (up to the last `@`, so a raw `@` in a password leaves no tail), and the value of any `password=`, `password:`, `PGPASSWORD=` or JSON `"password":` setting, removed whole when it is quoted (single or double quotes, through backslash or doubled-quote escapes; an unclosed quote is removed to the end of the text). The URL's `sslmode` is ignored (TLS is set here and cannot be weakened by the URL); its `options` are kept, because that is how a Tiger read-only string stays read-only; any other parameter is refused rather than dropped.

`stats` and `verify` open the session in Tiger's server-enforced read-only mode (`-c tsdb_admin.read_only_connection=true`, what `tiger db connection-string --read-only` prints); the live test checks that the server refuses an INSERT on such a session.

## TLS: the pinned certificate

Free Tiger services do not present a certificate from a public CA, so ordinary verification fails, and turning verification off would accept any server. Instead the package pins:

- `certs/tiger-ca.crt` is the certificate the service presents as its issuer, `O=Timescale Inc, CN=ca.timescale.com` (SHA-256 `06:5A:75:...:64:57`, valid to 2027-10-20), fetched once with `openssl s_client -starttls postgres -showcerts`. It is a public certificate, not a secret. The `.crt` name is because the repo's `.gitignore` ignores `*.pem`.
- `certs/tiger-pin.json` records the host, port, both fingerprints, the dates, and how the pin was fetched.
- Every connection requires a chain that ends at the pinned certificate (Node's verification, `rejectUnauthorized: true`), a host check (the leaf must name `ipx9051gbc.mz92ku10jd.tsdb.cloud.timescale.com`, through `tls.checkServerIdentity`), and that the host dialled is the pinned host. A connection string for any other host or port is refused before connecting. With `TIGER_PIN_LEAF=1` the exact leaf is required as well; by default a new leaf from the same CA for the same host passes, and the writer logs once when the leaf differs from the recorded one.
- There is no unverified fallback. If the pin cannot be read, does not match its recorded fingerprint, has expired, or the server does not match it, the connection fails with a message that points here.

Trust: a certificate fetched over a network proves nothing about who sent it. One independent check was possible: the leaf's notBefore (2026-10-24 07:53:06 UTC) equals the service's creation time reported by the Tiger API over CA-verified HTTPS (2026-10-24T07:53:06.430368Z), to the second. That is consistent with a certificate Tiger issued when the service was made, not proof. The data is content-free and pseudonymous either way; rotate the service password after the event.

Refreshing the pin (if Tiger rotates its CA, or the service is replaced): run `npm run cert:check`; if it reports a mismatch, run `npm run cert:refresh`, which fetches the chain, checks the leaf against the presented CA and the host name, compares the leaf's start with the service's creation time from the Tiger API, and prints the new fingerprints. Compare them from a second network if you can, then run `npm run cert:refresh -- --write` and review the diff of `certs/` before committing.

## The SpacetimeDB source

`src/sources/spacetime.ts` connects anonymously (no token, no pairing, so the module's presence hook writes nothing) and subscribes to `board_ledger`, `scan_state`, `board_errands`, `board_calls` and `device_status`: exactly what any judge's browser can read. It calls no reducer. On each subscription apply it replays the client cache, and every handler is idempotent, so rows seen twice land once. The SDK reconnects a dropped connection on its own (the same connection object, replaying the subscription); when it reports that it will not retry (a failed first connection, a terminal failure) or the subscription is refused, the source retires the connection and builds a new one after a doubling wait (1 s up to 30 s). Every SDK and row callback is tied to the attempt that registered it: a stop or a rebuild closes a connection that is still being built, and late callbacks from an old connection are ignored and close it. A dropped connection marks the time after the last server timestamp as unknown; after the reconnect, if nothing the rest state depends on changed during the gap, rest is counted through it, otherwise the gap stays unknown.

The bindings: `spacetime/bindings/agent` (generated by spacetimedb 2.13.0, committed with the module in 618b2ef) is imported statically by `src/cli/bindings.ts`, which hands `DbConnection.builder` to the source. The library itself is written against structural types, so it builds without them; `bindings.ts` is where the two meet, and `npm run typecheck` fails there if a regenerated binding drops one of the five tables, renames or retypes any field a normalizer reads, or changes the connection API (three deliberate mutations of those checks each turned the typecheck red). `test/contract.test.ts` also checks every name against docs/spacetime.md and the module source in `spacetime/src`, including the module behaviours the rest rule leans on.

`src/sources/fake.ts` is a replayable source for tests. Its database name must start with `test-`, so whatever it produces is test data.

## Dashboard route

The web app should read the numbers on the server, never in the browser. A Next.js route handler (Node runtime), with `TIGER_DATABASE_URL` set to a read-only string (`tiger db connection-string ipx9051gbc --read-only --with-password`) in the deployment's server environment:

```ts
// web/app/api/telemetry/route.ts
import { connectTiger, consoleLogger, getStats, type TigerConnection } from '@say-when/telemetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One pool per server instance, one connection, read-only, short statement timeout.
let tiger: Promise<TigerConnection> | null = null;

export async function GET() {
    try {
        tiger ??= connectTiger({ log: consoleLogger, max: 1, readOnly: true, statementTimeoutMs: 3_000, applicationName: 'neurolingo-dashboard' });
        const stats = await getStats((await tiger).pool, { windowMinutes: 30 });
        return Response.json(stats, { headers: { 'cache-control': 'public, s-maxage=5, stale-while-revalidate=10' } });
    } catch {
        tiger = null; // reconnect on the next request; the error text stays in the server log
        return Response.json({ error: 'telemetry unavailable' }, { status: 503 });
    }
}
```

`getStats` returns `falseActivationsPerIdleMinute`, `falseActivations`, `idleMinutes`, `yesActedAtRest`, `timeToPick { p50Ms, p95Ms, picks, method }`, `commandsPerMinute`, `commands`, `rowsWritten`, `lastWriteAt`, `windowStart` and `asOf`. Show the rate as a dash while it is null. The package reads `certs/` at run time from next to its own code; a bundled deployment must keep that folder (for example with `outputFileTracingIncludes`) or pass `certDir`. That deployment path is untested.

## What is verified

On Sat Oct 24, 2026, against the live service (PostgreSQL 18.6, TimescaleDB 2.31.0, timescaledb_toolkit 1.26.0):

- `npm run migrate` applied all 10 files; a second run applied none; later it applied `sql/040` (no gesture id) as the eleventh. `npm run verify`: 45 of 45 checks pass, read from the live catalog: 5 hypertables partitioned by time in 1-day chunks, 3 aggregates with `materialized_only = false`, 3 refresh policies every minute over 3 days, 8 retention policies, the retention invariant, each refresh job's own run history (144 runs each, 0 failures, at the last check), 5 idempotency indexes checked in `pg_index` (unique, valid, no predicate, no expressions, no INCLUDE columns, on the right table, the exact key columns), exactly the 49 expected columns of the 5 hypertables with their types, no gesture id, and each of the 18 text columns held by a validated CHECK whose definition matches the expected one word for word, the toolkit variant, and storage at 12.6 MB of 750 MB.
- The SpacetimeDB source against the live module (`say-when-dev` on Maincloud), read-only through the generated bindings: `npm run check:source` subscribed to all five tables and normalized 446 rows with 0 contract errors. Then the module's rows went through the tracker and the writer into the live Tiger service under a `test-` session key, three times as the code changed. The last run, with the final code, read 590 rows (the dev module had grown) with 0 contract errors and wrote 36 switch events, 5 scan steps, 12 picks (all 12 timed, none unpaired) and 1 errand outcome, all accepted by the CHECK constraints (0 failed batches, 0 rows unsent, 0 contract skips); then they were deleted, the touched aggregate buckets refreshed, and a count showed 0 rows left. `say-when-dev` holds the team's test sessions, so these rows were test data, not usage.
- TLS: TLS 1.3 (`pg_stat_ssl`), chain verified against the pin, leaf matches the recorded one. The live test also shows the real server refused under a CA that is not the pin, and refused by the host check for a name its leaf does not hold.
- `npm run test:live` (6 tests, last run after `sql/040` with the final tracker): a synthetic `test-` session (26 commands, 4 false activations, 5.27 idle minutes, 21 picks timed 1.0 s to 5.0 s) went through the fake source, tracker, writer and pinned connection into the hypertables; the raw rows matched values computed independently in the test, and `getStats` through the aggregates returned 0.759 false activations per idle minute, p50 3002 ms and p95 4803 ms (exact values 3000 and 4800; UddSketch is approximate). The session is anchored to the time of the run and seconds are counted by their midpoint, so the idle total moves by a few seconds between runs (an earlier run: 5.2 minutes, 0.769); each run is checked against its own independent computation. Replaying the whole session a second time changed nothing (the union held, every ledger row landed once). A pick four days old reached `picks_1m` through the sink's own refresh. A read-only session read the stats and the server refused its INSERT. Then every row of that session was deleted and the aggregates refreshed, and a count showed no aggregate rows left for it. These were test rows, not usage.
- `npm test`: 134 unit tests, no network: mapping, the rest timeline (station liveness and freshness, unreported health, silences with and without a later sighting, a state change during a silence, both orders of a station loss, a loss seen only in a reconnect snapshot, an unobserved stretch before a reconnect, a health loss that never recovers, a station left online by an ended session, a station re-paired with another role, deliberate pauses, restarts, reconnects), false activations (none in an unobserved stretch or on another session's station), pick pairing, batching, back-pressure, outage handling and shutdown, privacy, credentials and redaction (quoted values included), SQL shapes, the backlog refresh and its age limits, the identity index and column checks (and that the expected columns match the SQL files), the source's connection lifecycle against an SDK-shaped stub, stats math, the contract names, and the pinning through the real pg client against a local TLS server with throwaway certificates (a wrong CA, a wrong host and a rotated leaf). A mutation check broke 30 rules one at a time (among them the strictly-before rule, chain verification, the host check, the code allowlist, the queue bound, station freshness, the live staleness cut and its 8-second point, the session's own station, a role change, reported health, the cut at the last sighting and in a snapshot, the settled emission bound, the age limits, the partial-index refusal, the exact column set, its types, the exact CHECK per text column and the forbidden column, the stale-connection guards, the unstored gesture id and quoted-password redaction) and the tests failed for every one; each file was restored byte for byte.
- Review: an adversarial review by a second model (Codex) after each round of fixes, six rounds in all. Round 1 found 8 issues, round 2 found 8, round 3 found 3, round 4 found 3 and round 5 found 2; every one was checked against the code and fixed, with a test. Round 6 found 2 of medium severity and none high or critical, which ended the review: one is fixed (the column check now compares whole CHECK definitions), and one is open (below).

Not verified, and open:

- The writer running continuously against Maincloud during a real session (the replays above ran on the dev module's stored rows), the dashboard route in a deployment, and any number from a real wearer.
- Open, medium (review round 6): a command is classified when it arrives. A command that lands just after the station's last `device_status` sighting is judged at rest and can count as a false activation; if the loss row arrives after it (the station's offline row, or, after a reconnect, its identity paired again with another role), rest is cut back to that last sighting and the stored command is not corrected (`ON CONFLICT DO NOTHING`). The gap is at most the time between that sighting and the loss row (about 2 seconds plus the dead-man lease), and it can only add a false activation, never rest. The fix is to hold commands judged at rest until their time is settled, then classify them; it is not built.
- The TLS unit tests (a local TLS server with throwaway certificates) were run here but could not run in the reviewer's read-only sandbox, so the second model did not exercise them.

## Known limits

- Rows that arrive after their bucket was materialized (a writer catching up) show up after the next policy refresh, within about a minute; rows older than the 3-day policy window are refreshed by the writer itself.
- History before the writer's first snapshot is classified only back to the last change of the rest state (in a deliberate pause, not before the writer connected); earlier commands are stored with `resting` null and never counted.
- Rest is kept to the second. A station that drops is noticed at its last `device_status` sighting, up to about 2 seconds early.
- If a station falls silent and no offline row ever arrives (the module sends one within its dead-man lease, so this means a row was missed), up to 8 seconds after its last sighting count as rest, the same 8 seconds in which its commands count as at rest.
- Which station belongs to which session is inferred from the module running one session at a time (a station counts for a session only if it was seen since the session started). If the module ever ran two sessions at once, a healthy station could vouch for the other session.
- The 8-second freshness window is sized to the module's limits. If `heartbeat_ms` or the dead-man lease were set so that a live station could go more than 8 seconds between `device_status` updates, the time from 8 seconds after one sighting to the next would be left out of rest (less rest, never more; with fewer idle minutes the rate would read higher).
- A command in the last moment before a station drop can count as a false activation while its second is not counted as rest (the open item above).
- The expected CHECK definitions are compared as PostgreSQL 18.6 prints them. An upgrade that prints them differently makes `npm run verify` fail (never pass) until `EXPECTED_TEXT_CHECKS` in `src/migrate.ts` is updated after a look at the new wording.
- `start_session` copies the station's previous decoder health into its new `device_status` row, so the first moment of a session (until the first heartbeat, 500 ms by default) can count as rest on that earlier reading.
- A call's `awaiting_confirm` has no status column in `board_calls`, so its outcome row uses `updated_at` and can repeat after a writer restart. Other outcomes use their own status column and land once.
- Percentiles from UddSketch are approximate (about 1% here) and noisy for a handful of picks; `picks` is returned with them.
- The free service has no connection pooler. The writer uses one connection, `stats` and `verify` one each.
