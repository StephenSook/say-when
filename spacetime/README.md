# NeuroLingo SpacetimeDB module

The live backend for NeuroLingo (formerly Say When): one TypeScript module on SpacetimeDB 2.13.0 that holds the scan clock, the dead-man pause, the consent gate for errands and calls, the agent's job queue, and the data every screen shows. Every device and the agent talk to it, and to nothing else, for live state. The full design, with every table, reducer and rule, is [`docs/spacetime.md`](../docs/spacetime.md); this file says how to build, publish, pair and connect, and what Maincloud showed when we ran it.

## The live database

| | |
|---|---|
| Host | `https://maincloud.spacetimedb.com` (the SDK opens `wss://` on the same host) |
| Database | `say-when-dev`, identity `c200da44f7506b54809eb198b17556591cfb8035b08503b560171bb492f4b92e` |
| What it is for | development and smoke tests. Not locked. The demo database `say-when-demo` is published at the schema freeze (`docs/spacetime.md` 9.4) and does not exist yet |
| Published | Sat Oct 24, 2026, 1:09 AM PDT, from this folder by Stephen's CLI login, which `init` made the owner |
| Environment | none. `CARTESIA_API_KEY` is not set, so `mint_voice_token` answers `voice_key_missing` and never a token |
| Data in it | four smoke sessions with made-up questions ("Smoke test: which drink?"), three made-up errands that went nowhere, revoked smoke devices and revoked smoke consents. `purge_session 1` (2, 3, 4) deletes a session's rows |
| Dashboard | https://spacetimedb.com/say-when-dev (owner login: logs, SQL console, usage) |

## What it does that a plain database would not (PLAN D12)

Each row says what the module does and what we measured on `say-when-dev` on Oct 24 between 1:09 and 1:43 AM PDT, from the build Mac on its current network (not checked to be venue Ethernet). The commands that produced every number are in [Smoke test](#smoke-test).

| Niche feature | How the module does it | Measured on Maincloud |
|---|---|---|
| **One clock for every screen** | A public `scan_state` row per session, moved only by reducers and a chain of one-shot `scan_timer` rows that fire the scheduled reducer `scan_tick`. Every step bumps `step_seq`; a stale tick does nothing | 76 scheduled steps ran a median 2 ms after their planned time (max 10 ms). A WebSocket client on the build Mac got each step within about 110 ms of the planned gap, with a median of 2 to 3 ms in the three long runs |
| **The YES lands on the option the person heard** | The station sends the `step_seq` it was playing; a YES for the option before is accepted inside `grace_ms` and logged with `late_by_ms` | A YES heard in option 1's window but arriving 174, 216 and 272 ms after option 2 began still picked option 1 each time, with those `late_by_ms` values in the ledger |
| **Dead-man interlock** | Each heartbeat replaces a one-shot `liveness_lease` row 1.5 s ahead. If it fires, the module pauses every screen and voids anything waiting for a confirm. Healthy beats resume the same option | Heartbeats stopped: the module paused itself 1501 or 1502 ms after the last beat, 4 times out of 4 (server clocks, lease 1500 ms). Healthy beats resumed it 3.5 s after the first good beat (it needs 3 s of good contact) |
| **Consent is a row** | An errand leaves the room only after the read-back, a 1 s quiet hold, inside the window, with good contact, the digest the person heard and an active consent row, once. The agent can claim only that Confirmed row, with that digest | On three errands: YES during the read-back, CONFIRM before the read-back, inside the quiet hold, with a digest the person did not hear, and a repeat CONFIRM were each recorded and ignored; a stale read-back digest was refused (HTTP 530). The right CONFIRM was accepted, and the agent's claim and completion followed 0.31 to 0.71 s later. A stand-in agent played the Actor, so nothing was sent anywhere |
| **Roles in reducers, privacy in views** | One role per identity, checked in every reducer; per-role views; anonymous board views that show text only while the room's sharing toggle is on, which needs a `board_text` consent row | An unpaired identity was refused (`start_session`: 530 not allowed); a revoked station was refused; the anonymous board showed "Question 4" and "Option 1", "Option 2" with sharing off, refused to turn sharing on without consent, and showed the real text only after the consent and the toggle |
| **The database runs short credentialed hops** | The procedure `mint_voice_token` reads the key from a typed module env var and returns a 60-second Cartesia token only to the caller | Outbound HTTP from a procedure works on Maincloud: `api.cartesia.ai` answered 200 in 92 to 254 ms, `api.apify.com` answered in 25 to 37 ms. With no key the procedure fails closed (`voice_key_missing`); a real mint has not been run (no key passed yet) |
| **A public pipeline and an event table** | Content-free `pipeline_event` rows and the `cue_event` event table drive every dashboard with no login; `GET /route/stats` recomputes numbers from the ledger | The watcher received each cue the runs produced (`again`, `no_pick`, `picked`, `reply_released`, `errand_preparing`, `say_confirm`, `confirmed`, `errand_sent`, `paused`, `resumed`). `/route/stats` answered 200 with `access-control-allow-origin: *` |
| Agent coordination | Jobs with a lease and an attempt number, so a stalled agent's late write is refused | The stand-in agent claimed each job and published options in 250 to 392 ms over WebSocket (three reducer calls in a row) |

## What is in it

| Piece | Where | What it does |
|---|---|---|
| Scan clock | `src/clock.ts`, `scan_tick` | The `scan_state` row and its one-shot timers; menu, pause and resume |
| Command map (D11) | `gesture`, `src/gesture.ts` | YES, NO, CONFIRM, STOP and HEADSET_OFF decided against the scan and anything pending. Valid commands with nothing to do are recorded as `ignored:<reason>`, never thrown |
| Dead-man pause | `heartbeat`, `liveness_expired`, `src/liveness.ts` | The lease, the pause and the automatic resume |
| Consent gate | `src/consent.ts` | Errands and calls: the read-back, the seven CONFIRM checks, the claim, the submit lease (a lapsed lease is `unknown_outcome`, never a resubmit) |
| Agent queue | `src/jobs.ts`, `src/agent.ts` | Jobs, leases, the attempt fence |
| Roles and views | `src/auth.ts`, `src/views.ts` | Pairing, the role guards, per-role and anonymous views |
| Voice tokens | `mint_voice_token`, `src/voice.ts` | 60-second Cartesia tokens for paired browsers |
| Checkable numbers | `GET /route/stats`, `src/stats.ts` | Picks, late picks, pause latency and errands from stored rows |
| Smoke tools | `scripts/` | `smoke_e2e.py` (the whole test), `http_smoke.py` (Python over HTTP), `watch-scan.ts` (a WebSocket watcher and stand-in agent on the generated bindings) |

## Build and test

Node 22. From this folder:

```bash
npm ci
npm run typecheck              # the module, the scripts and the generated bindings
npm test                       # vitest with the 2.12+ module test harness: 117 tests, no server needed
spacetime build --module-path .
```

The tests run every reducer, view and procedure against the in-memory test datastore, with a controlled clock. Timers never fire in the harness, so each test reads the schedule row the module inserted and calls the scheduled reducer itself.

## Publish (owner only)

Run each command with `nice -n 15`, one at a time, from the repo root. Every command names the database, the module path and the server and passes `--no-config`, because with `spacetime.json` present a database name it does not list is an error.

```bash
# The dev database, no secrets. env -u makes sure no CARTESIA_API_KEY rides along: the CLI stores a declared shell
# variable even when it is empty.
env -u CARTESIA_API_KEY nice -n 15 spacetime publish say-when-dev --no-config --module-path spacetime --server maincloud --yes=remote
nice -n 15 spacetime call --no-config --server maincloud say-when-dev ensure_timers   # after every publish
```

A breaking schema change on the dev database only: add `--delete-data=on-conflict` (it also wipes env values and re-runs `init`). Never on the demo database, and never publish to the demo database during judging.

**Adding the Cartesia key** (smoke step S1 passed, so the key belongs in the module env; nobody has done this yet). The key comes from the Keychain or the team vault into a shell variable for this one command, is checked for length (a Keychain item can be empty and still exit 0), and is never written to a file or printed:

```bash
read -rs CARTESIA_API_KEY      # paste it; nothing is shown
[ ${#CARTESIA_API_KEY} -gt 0 ] && CARTESIA_API_KEY="$CARTESIA_API_KEY" nice -n 15 spacetime publish say-when-dev --no-config --module-path spacetime --server maincloud --yes=remote
unset CARTESIA_API_KEY
```

`--env-only` on the same command updates the value without uploading the module (CLI help; not run here). To check the key is in place, ask a paired station for a token (`http_smoke.py` prints only its length), not `spacetime env list` or `env get`: **those print the values**.

## Pair a device

Each device has one role: `station`, `partner`, `speaker` or `agent`. It asks to pair with a random 6-digit code and a public label (neutral, like "partner phone 1", never a person's name); the owner approves the code within 5 minutes:

```bash
spacetime call --no-config --server maincloud say-when-dev approve_pairing 482913 false   # last argument: caregiver
spacetime call --no-config --server maincloud say-when-dev revoke_device 0x<identity>   # a revoked device can ask again
```

| Device | How it asks |
|---|---|
| A web page (station, partner, speaker) | shows the code and calls `request_pairing(code, role, label)`; keeps its token under `<host>/<db>/auth_token/<role>` in `localStorage` |
| The agent sidecar | `cd agent && npm run pair`, then `npm start` once approved (token in `agent/.agent-token`) |
| A Python process | `python3 spacetime/scripts/http_smoke.py identity --token-file ~/.config/say-when/stdb_token_station`, then `... pair --token-file ... --role station --label "station 1"` |
| The smoke watcher | `cd spacetime && npm run smoke -- pair` |

Dashboards never pair: they read public tables and anonymous views with an anonymous identity.

Consent and timing:

```bash
spacetime call --no-config --server maincloud say-when-dev grant_consent errand care_team_request owner_cli "demo form"
spacetime call --no-config --server maincloud say-when-dev grant_consent board_text "" owner_cli ""
spacetime call --no-config --server maincloud say-when-dev set_timing '{"response_window_ms":4000}'
```

## Connect

### The web app

```bash
# web/.env.local and the deployed project's settings. Neither value is a secret.
NEXT_PUBLIC_SPACETIMEDB_HOST=https://maincloud.spacetimedb.com
NEXT_PUBLIC_SPACETIMEDB_DB=say-when-dev
```

The bindings are `spacetime/bindings/web` (generated from this module, never edited). One connection per page:

```ts
import { DbConnection } from '<path to>/spacetime/bindings/web';

const conn = DbConnection.builder()
  .withUri(process.env.NEXT_PUBLIC_SPACETIMEDB_HOST!)
  .withDatabaseName(process.env.NEXT_PUBLIC_SPACETIMEDB_DB!)
  .withToken(savedToken)            // role pages only; dashboards leave it out and stay anonymous
  .withAutomaticReconnect()
  .onConnect((c, identity, token) => { /* save token under <host>/<db>/auth_token/<role> */ })
  .build();

conn.db.scanState.onUpdate((ctx, before, after) => { /* the clock: start or stop audio here, not in a render */ });
conn.subscriptionBuilder()
  .onApplied(() => { /* cache ready */ })
  .subscribe(['SELECT * FROM scan_state', 'SELECT * FROM pipeline_event', 'SELECT * FROM public_board', 'SELECT * FROM cue_event']);
```

`docs/spacetime.md` 7.1 lists what each screen subscribes to. In the SDK, enum tags are PascalCase (`NoPick`, `HeadsetLost`) and times are `Timestamp` objects. Reducers return promises that reject with the module's message (`SenderError`); procedures return their value (`conn.procedures.mintVoiceToken({ purpose: 'tts' })`).

### Python over HTTP

[`scripts/http_smoke.py`](scripts/http_smoke.py) is the reference: Python standard library only, one kept-alive HTTPS connection, the token in a file with mode 0600 and never printed. On the main path Python never calls SpacetimeDB (the station relays the decoder's gestures); this is for tools and the fallback in `docs/spacetime.md` 7.5.

```bash
python3 spacetime/scripts/http_smoke.py call --token-file ~/.config/say-when/stdb_token_station heartbeat '[1, true]'
python3 spacetime/scripts/http_smoke.py sql "SELECT * FROM scan_state"        # anonymous: public tables and views
python3 spacetime/scripts/http_smoke.py route stats
```

What the wire looks like (all seen on `say-when-dev`):

- A call is `POST /v1/database/say-when-dev/call/<name>` with `Content-Type: application/json`, `Authorization: Bearer <token>`, and a JSON array of the arguments in order. 200 means committed. 530 means the module refused, with its message as the body: never retry it. A procedure answers 200 with its return value as a JSON array in field order (`[200,93,""]`).
- Without a token every call runs as a new anonymous identity, so a process keeps one token (`POST /v1/identity` mints one).
- `?confirmed=false` returns once the transaction commits in memory. On Maincloud it saved nothing in two runs (93 to 95 ms median either way) and 18 ms of median in a third (94 against 112 ms); we cannot tell that from network noise yet.
- `POST /v1/database/say-when-dev/sql` with a `SELECT` needs no token for public tables and anonymous views (`public_board`, `board_ledger`, `board_errands`); a private table answers 400 "no such table". Enum values come back as `[variant index, payload]`, with the variant names in lowerCamelCase in the schema (`noPick`, `yesNo`, `awaitingConfirm`); options are a sum named `some`/`none`; identities and timestamps are one-field products. `http_smoke.py` decodes all of this.
- Maincloud closed a kept-alive connection that sat idle for about two minutes. `http_smoke.py` opens a new one before a request when the old one has been idle for 20 s, and never resends a request that failed, because it may have run.

### The agent sidecar

The sidecar in `agent/` connects over WebSocket as the Agent role: `SPACETIMEDB_URI` (default `https://maincloud.spacetimedb.com`), `SPACETIMEDB_DB` (default `say-when-dev`), `AGENT_TOKEN_FILE` (default `agent/.agent-token`, gitignored). Its generated bindings are `spacetime/bindings/agent`. The contract it follows is `docs/spacetime.md` 3.6 and 7.4: read `agent_queue` and `errand_queue`, `agent_claim` a Pending job, then write with `(job_id, attempt)`; claim a Confirmed errand with its `confirmed_digest`; drop any work whose write fails with `stale attempt`.

`npm run smoke -- watch --act-as-agent` in this folder is a stand-in that follows the same contract with made-up content, for testing without Apify, Moss or Claude. It refuses to run against a database whose name does not end in `-dev`.

## Smoke test

One command runs every check above against the dev database: the owner through the CLI, a station over HTTP, the stand-in agent over WebSocket. It pairs its two devices (approving them with your CLI login), grants and then revokes the consents it needs, and takes about 90 seconds. Owner only, dev database only.

```bash
cd spacetime
python3 scripts/smoke_e2e.py --station-token ~/.config/say-when/stdb_token_smoke_station \
                             --agent-token ~/.config/say-when/stdb_token_smoke_agent --revoke-devices
```

Last run, Oct 24 1:41 AM PDT (session 4): 17 of 17 checks passed, as did the run before it (session 3).

Watch the clock on its own (read-only, any database): `npm run smoke -- watch --seconds 60`.

## Measured numbers

All on `say-when-dev`, Oct 24, 2026, 1:09 to 1:43 AM PDT, from the build Mac on its current network. Repeat on venue Ethernet before quoting a network number.

| What | Result | How |
|---|---|---|
| Publish (build and upload) | 3.7 s, created the database | `spacetime publish` |
| Scheduled step lateness (server) | median 2 ms, max 10 ms, over 76 steps | `step_started_at` minus the previous `step_ends_at`, by `watch-scan.ts` |
| Step arrival at a WebSocket client | within about 110 ms of the planned gap; median 2 to 3 ms in the three long runs | gap between `scan_state` updates minus the planned dwell, same script |
| Dead-man pause | 1501 to 1502 ms after the last heartbeat, 4 of 4 | ledger `pause` row `ms` (server clocks); lease 1500 ms |
| Automatic resume | 3.5 s after the first healthy beat (a client polling SQL saw it 3.4 to 4.3 s after the beats restarted) | needs `resume_good_contact_ms` = 3000 |
| Late pick inside the grace window | picked the heard option at `late_by_ms` 174, 216 and 272 | ledger `pick` rows |
| Consent gate | 5 wrong releases ignored, 1 stale read-back refused, 1 right CONFIRM accepted, on each of 3 errands | ledger `gesture` rows |
| HTTP reducer round trip, kept-alive (`heartbeat`, 20 calls per mode, three runs) | confirmed: median 95, 93 and 112 ms; max 114, 145 and 220 ms. `confirmed=false`: median 94, 93 and 94 ms; max 104, 97 and 151 ms | `http_smoke.py` / `smoke_e2e.py` bench |
| First HTTP call on a new connection | 281 to 434 ms (TLS handshake) | same |
| Reducer execution on the host | 0.28 to 0.36 ms per `heartbeat` (median per run) | `spacetime-execution-duration-micros` header |
| Heartbeats over HTTP every 500 ms | 216 sent during scans, median 95 ms, max 308 ms, no failures | first run |
| Agent writes over WebSocket | claim, progress and publish: 250 to 392 ms; claim and preview: 181 to 271 ms; claim errand and complete: 181 to 344 ms | `watch-scan.ts` |
| Outbound HTTP from a procedure | `api.cartesia.ai` 200 in 92 to 254 ms; `api.apify.com/v2` 404 (Apify's answer for that bare path) in 25 to 37 ms | `smoke_fetch`, timed with transaction timestamps |
| HTTP routes | `/route/ping` 200 in 108 ms; `/route/stats` 200 in 100 to 278 ms | `http_smoke.py route` |
| An owner `spacetime call` | 1.1 to 1.7 s each (CLI start-up and a new connection) | the smoke scripts |

## Things we learned on Maincloud

- Every procedure call (HTTP or CLI) writes an `ERROR ... External attempt to call nonexistent reducer` line to the database log, and then runs the procedure and returns its value. Ignore that line when reading logs.
- `spacetime env list` and `spacetime env get` print secret values.
- The CLI and SQL show enum variants in lowerCamelCase (`(station = ())`, `noPick`); the TypeScript SDK shows PascalCase tags.
- A procedure's answer carries no `spacetime-energy-used` header; a reducer's does.
- A revoked device can ask to pair again, and approving it un-revokes the same identity.

## Client bindings

Generated, never edited, committed so the web app and the agent build without the CLI:

```bash
spacetime generate --yes        # from the repo root: spacetime.json writes both sets below
```

- `bindings/web` for the dashboards, the station, the partner phone and the speaker.
- `bindings/agent` for the agent sidecar and `scripts/watch-scan.ts`.

Regenerate after every schema change. With `spacetime.json` present, a `spacetime generate` that passes `--lang` or `--out-dir` also needs `--no-config`. The current bindings were regenerated after the publish and are byte for byte the same as before.

## Not built (by design)

- `gesture_http`: the HTTP fallback for the Python process, only if the station relay fails smoke step S3.
- The optional database dispatch of the errand submit (`errand_dispatch`, `errand_run`, `/apify/webhook`). Outbound HTTP and routes work on Maincloud now, so it is possible; it is still optional.
- The `voice_token` fallback table: not needed, because S1 passed.

## Still untested

- S3: the station page on the deployed https origin opening `ws://127.0.0.1` to the decoder (Chrome may block it), and Chrome slowing a background tab's heartbeats (needs a 30-minute soak).
- Any number on venue Ethernet, and every timing value on a real wearer.
- A real `mint_voice_token` with the key, calls (`claim_call`, `report_call_status`) on Maincloud, the two-minute idle pause on Maincloud, and a republish while a scan is running.
- The web app and the real agent sidecar against `say-when-dev` (their own workflows).
