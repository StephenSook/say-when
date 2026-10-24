# NeuroLingo on SpacetimeDB: the backend plan

The plan anyone on the team can build against for PLAN rows 1.1 (the module) and 1.2 (the contracts). The product is NeuroLingo (PLAN D13, formerly Say When); code identifiers keep `say-when`, so the databases are `say-when-dev` and `say-when-demo`.

- **Status:** plan, version 1, written Fri Oct 23, 2026, about 11:15 PM PDT. No module code exists yet. Owner: Stephen (D6), built with Claude.
- **Follows:** D4 (the model never clicks or dials), D11 (the command map), D12 (the niche features), D13 (the name), the UI spec in `docs/ui.md`, and the research in the private workspace (`reports/Spacetime sponsor stack build.md` with its lane notes `spacetime_integration.md` and `spacetime_niche_features.md`).
- **Pins:** `"spacetimedb": "2.13.0"` exactly, in the module, the web app and the agent. The module is TypeScript.

Every claim carries one of four tags:

| Tag | Meaning |
|---|---|
| **checked** | Read tonight in the `spacetimedb` 2.13.0 package source (`web/node_modules/spacetimedb/src`), the 2.13.0 CLI help, this repo's own packages, or compiled tonight in a scratch typecheck against the 2.13.0 types (see Appendix B) |
| **research** | Verified at source by the research lanes before tonight; not re-read tonight |
| **design** | Our choice |
| **untested** | Needs Maincloud, the venue network, Chrome or the headset; the smoke test in section 6.3 decides it |

---

## 0. The short version

- SpacetimeDB is the only live-state store. The scan clock, the dead-man pause, the consent gate, the agent's job queue and every screen's data live in one module (D1, D12).
- **One clock.** A chain of one-shot scheduled reducers moves a public `scan_state` row; every screen and the earpiece follow it, and a YES is matched to the option the person heard, with a grace window.
- **Dead-man interlock.** Each station heartbeat pushes a one-shot `liveness_lease` row forward. If it fires, the module pauses the scan and voids anything waiting for a confirm. Two minutes without a command pauses too (`idle_timer`).
- **Consent is a row.** A form or a call leaves the room only after a CONFIRM that matches the digest the person heard, inside the window, used once. `claim_errand` refuses anything else, and a lapsed submit lease becomes `unknown_outcome`, never a resubmit.
- **Roles in reducers, privacy in views.** Four roles (Station, Partner, Speaker, Agent) checked in every reducer. Per-role views give each device its slice; anonymous board views show text only while the room's sharing toggle is on.
- **Short credentialed hops.** `mint_voice_token` hands browsers 60-second Cartesia tokens from a key in a typed module environment variable, if Maincloud allows outbound HTTP from procedures (untested). Otherwise the sidecar mints.
- **Live pipeline.** A public, content-free `pipeline_event` table drives the dashboards; a `cue_event` event table drives chimes and toasts.
- Decisions the team should know are in section 10.1. The Shared Contracts text for PLAN row 1.2 is Appendix A.

---

## 1. What runs where

### 1.1 Picture

```
 EEG LAPTOP (8 GB, wired Ethernet)
 [headset] -> BrainFlow -> [Python decoder] ---- psycopg, 1 s batches ----> [TIGER DATA]
                                |                                            telemetry only
                                | ws://127.0.0.1:<port>  gesture and health messages
                                v
                 [station page, Chrome, role Station]
                  plays options and read-backs into the earpiece (Cartesia Sonic)
                  relays each gesture with the step it heard; heartbeats every 500 ms
                                |
                                | WebSocket: gesture, heartbeat, report_clip_ready, report_readback_done
                                v
  +======================================================================+
  | SPACETIMEDB on Maincloud, database say-when-dev (later say-when-demo)|
  |  scan clock: scan_timer -> scan_tick (one-shot rows, step_seq fence) |
  |  dead-man: liveness_lease, idle_timer                                |
  |  consent gate: errand / call_request + consent + ledger              |
  |  agent queue: agent_job + job_lease (fencing attempt)                |
  |  views per role, anonymous board views, public pipeline_event        |
  |  procedure mint_voice_token; optional routes /stats, /apify/webhook  |
  +======================================================================+
      ^ WebSocket          ^ WebSocket        ^ WebSocket            ^ WebSocket, role Agent
      |                    |                  |                      |
 [partner phone]      [speaker page]     [dashboards, judge       [agent sidecar, Node 22,
  role Partner,        role Speaker,      board: anonymous]        second laptop]
  Ink-2 push to talk   says the reply     /live /agents            Apify, Moss, Claude,
  /partner             aloud /speaker     /conversation /judge     Cartesia Dialer
```

Rule of thumb (research): anything a person causes at human rate is a SpacetimeDB row; anything a sensor produces at machine rate goes to Tiger; anything that needs Node libraries or long waits runs in the sidecar; a short authenticated hop with a secret may run in a procedure.

### 1.2 Each client

| Client | Runs on | Connects by | Role | Calls | Reads |
|---|---|---|---|---|---|
| Station page `/station` (name is the web workflow's) | Chrome on the EEG laptop | WebSocket, own token | Station | `start_session`, `end_session`, `gesture`, `heartbeat`, `report_clip_ready`, `report_readback_done`; procedure `mint_voice_token('tts')` | `my_session`, `my_options`, `scan_state`, `config`, `cue_event` |
| Partner phone `/partner` | the partner's phone browser | WebSocket, own token | Partner | `ask_question`, `cancel_question`, `partner_listening` (optional), `operator_pause`, `set_board_sharing` and `grant_consent` (caregiver phones only); `mint_voice_token('stt')` | `partner_view`, `scan_state`, `pipeline_event`, `device_status`, `cue_event` |
| Speaker page `/speaker` | a laptop or phone with a loudspeaker | WebSocket, own token | Speaker | `reply_spoken`, `operator_pause`; `mint_voice_token('tts')` | `my_session` (the reply to say), `cue_event` |
| Dashboards `/live`, `/agents`, `/conversation`, `/judge` | any browser (Vercel), no login (D7) | WebSocket, anonymous | none | nothing | `config`, `scan_state`, `pipeline_event`, `device_status`, `cue_event`, `public_board`, `board_payloads`, `board_errands`, `board_calls`, `board_ledger` |
| Agent sidecar `agent/` | Node 22 on a laptop that is NOT the EEG laptop | WebSocket, `.agent-token`, automatic reconnect | Agent | `agent_claim`, `agent_progress`, `agent_publish_options`, `agent_attach_preview`, `agent_fail`, `agent_done`, `claim_errand`, `complete_errand`, `claim_call`, `report_call_status`, `add_call_line` | `agent_queue`, `errand_queue`, `call_queue` |
| Python headset process `switch/` | the EEG laptop | not at all on the main path; HTTP `/call` only in the fallback (7.5) | Station (fallback only) | `gesture_http` (fallback only) | nothing |
| Form-errand Actor | Apify Standby | never (optional webhook in 6.2 only) | none | none | its input from the sidecar |
| Cartesia | Cartesia cloud | browsers with access tokens; the sidecar with the key; the module only to mint tokens | none | none | none |
| Tiger Data | Tiger Cloud | never | none | none | none |
| The owner (Stephen's CLI login) | Stephen's laptop | `spacetime call` and `spacetime sql` | owner (`config.owner`, the publisher) | `approve_pairing`, `revoke_device`, `grant_consent`, `revoke_consent`, `set_timing`, `set_board_sharing`, `ensure_timers`, `operator_pause`, `operator_resume`, `end_session`, `purge_session` | everything (an owner can read private tables) |

### 1.3 Roles, pairing and identity (design on research primitives)

- **One role per identity.** The private `device` table maps an identity to `Station`, `Partner`, `Speaker` or `Agent`. Every client reducer starts with a role check and throws `SenderError` on a mismatch.
- **Owner.** `init` stores the publisher as `config.owner` (research: the lifecycle doc says `init`'s sender is the publisher). Only the owner approves devices, changes timing and grants consent from the CLI.
- **Pairing flow.** A page with no device row shows a random 6-digit code and calls `request_pairing(code, role, label)`. Stephen runs `spacetime call say-when-dev approve_pairing 482913 false` (the last argument is `caregiver`). The request expires after `pairing_ttl_ms` (5 minutes) through `pairing_timer`.
- **Labels are public** (they appear in `device_status`), so use neutral ones: "partner phone 1", not a person's name.
- **Tokens.** Each browser keeps its SpacetimeDB token under `<host>/<db>/auth_token/<role>` in `localStorage`, so two role pages in one browser never share an identity (research: the Next.js template keys tokens per host and database only). The sidecar keeps `.agent-token` (chmod 600, gitignored). The Python fallback keeps `~/.config/say-when/stdb_token` (chmod 600).
- **Anonymous viewers** (dashboards, judges) never pair. They read public tables and anonymous views only.
- **Caregiver flag.** A Partner approved with `caregiver = true` may grant or revoke consent and flip the board's sharing toggle. Anyone paired can pause; only the wearer (YES) or the owner can resume a deliberate pause.

### 1.4 Where every secret lives

| Secret | Lives in | Used by | Never in |
|---|---|---|---|
| Cartesia API key | module env var `CARTESIA_API_KEY`, passed as a shell variable at publish, if smoke step S1 passes; otherwise the agent laptop's env | `mint_voice_token` (or the sidecar), the sidecar's Dialer and dictionary sync | a browser, Vercel, git, chat |
| Apify token | agent laptop env (`APIFY_TOKEN`) | sidecar: RAG Web Browser, Maps, the form-errand Actor | a browser, git; the module only for the optional database dispatch (6.2) |
| Moss project id and key | agent laptop env | sidecar | a browser, SpacetimeDB, git |
| Anthropic API key | agent laptop env | sidecar's option writer | a browser, git |
| Phone numbers, consent and do-not-call lists for calls | private files on the agent laptop (`CALL_CONSENT_FILE`, `CALL_DO_NOT_CALL_FILE`) | the Cartesia Dialer | SpacetimeDB, the repo, any screen |
| `APIFY_WEBHOOK_SECRET` (optional upgrade only) | module env var and the Apify webhook's header template | the `/apify/webhook` route | git |
| Tiger writer and reader connection strings | EEG laptop env; Vercel server env | Python writer; `/api/tiger-stats` | the browser bundle, git |
| SpacetimeDB identity tokens | per-role `localStorage` keys; `.agent-token`; the Python token file | that device | git, chat, screenshots |

Keys live in macOS Keychain or the team vault. Read a key into the shell only for the command that needs it, and check it is not empty first (a Keychain item can exist with a zero-byte value and still return exit 0).

---

## 2. Tables

### 2.1 Conventions

- **Names.** Wire names are snake_case. The TypeScript module declares camelCase keys (`scanState`, `stepSeq`) and the 2.13 default case policy converts them, so `scanState` is the table `scan_state` and `agentClaim` is the reducer `agent_claim` (checked: `schema.ts` `CASE_CONVERSION_POLICY` defaults to snake case; research: Scrabblebot relies on it). Generated TypeScript bindings use camelCase again.
- **Private by default.** Tables are private unless marked public (research). Public tables carry no conversation content: no question text, option text, form values, names, phone numbers or URLs.
- **Content-free** means ids, enums, counts, durations, digests and words from a fixed vocabulary only.
- **Ids.** `u64` auto-increment primary keys, inserted with `0n`. Client-made ids (`request_id`, `gesture_id`, `event_key`) are strings with a unique constraint, which makes retries harmless.
- **Times** are `timestamp` columns from `ctx.timestamp`. Durations are `u32` milliseconds. A screen draws a countdown from the duration (`step_ends_at - step_started_at`) starting at the moment the row arrives, never by comparing a laptop clock with a server timestamp.
- **Enums** are `t.enum('Name', [...])` with values `{ tag: 'Name' }`. New variants go only at the end (Scrabblebot appends `TournamentStatus` variants this way, research). The web maps a tag to snake case (`AwaitingConfirm` to `awaiting_confirm`).
- **String arguments that name an enum value** use lowercase snake case (`station`, `web_search`, `yes_no`, `errand`), so the CLI, the HTTP fallback and the SDK all send plain strings. The one exception is `command`, which uses the D11 words `YES`, `NO`, `CONFIRM`, `STOP`, `HEADSET_OFF` from the existing contract. JSON keys in `set_timing` are the snake_case names in 2.10.
- **Optional values** are `t.option(...)`, set to `undefined`.
- **Schedule tables** have `scheduledId: t.u64().primaryKey().autoInc()` and `scheduledAt: t.scheduleAt()`, and are bound with `spacetimedb.reducer({ onSchedule: table }, { job: table.rowType }, fn)` (checked). Every row is one-shot, `ScheduleAt.time(micros)`; never `ScheduleAt.interval`, and never a zero interval (research: an interval row is never deleted and a zero interval re-fires).
- **Every schedule row carries a fence** (a sequence or attempt number). Overdue rows can dispatch out of order (research), so a scheduled reducer compares its row's fence with the current row and returns if stale.

### 2.2 Enums

| Enum | Values |
|---|---|
| `Role` | Station, Partner, Speaker, Agent |
| `Command` | Yes, No, Confirm, Stop, HeadsetOff (wire strings `YES`, `NO`, `CONFIRM`, `STOP`, `HEADSET_OFF`) |
| `Phase` | Idle, Preparing, Reading, Window, Veto, Paused |
| `ScanMode` | Answer, Menu |
| `AnswerMode` | Pick, YesNo |
| `ScanOutcome` | Picked, None, NoPick, Stopped, Cancelled |
| `PauseReason` | HeadsetLost, HeadsetOff, Stop, Idle, Operator |
| `Origin` | Partner, Menu |
| `MenuItem` | None, Need, Request, Call, Say |
| `QuestionStatus` | Drafting, Ready, Scanning, Released, Spoken, Acting, None, NoPick, Stopped, Cancelled, Failed |
| `OptionKind` | Reply, Errand, Call, Menu |
| `JobKind` | Options, ErrandPreview, Remember |
| `JobStatus` | Pending, Claimed, Done, Failed, Cancelled |
| `ErrandStatus` | Drafted, Previewed, AwaitingConfirm, Confirmed, Submitting, Submitted, Refused, Failed, UnknownOutcome, Stopped |
| `CallStatus` | Prepared, AwaitingConfirm, Confirmed, Dialing, Ringing, Connected, Ended, Failed, Stopped, Refused |
| `ConsentScope` | WebSearch, Memory, Errand, Call, BoardText |
| `ScanTimerKind` | StepEnd, VetoEnd, ClipDeadline |
| `ErrandTimerKind` | Preview, Readback, ConfirmWindow, Submit |
| `CallTimerKind` | Readback, ConfirmWindow, Lease |

`pipeline_event.stage` and `.status` stay lowercase strings (`listen`, `ok`, ...) to match the existing contract and the producers in `apify/client`, `moss` and `cartesia`, which already emit those words.

### 2.3 All tables at a glance

| Table | Visibility | Kind | Holds |
|---|---|---|---|
| `config` | public | singleton (id 0) | owner, active session, sharing toggle, the person's timing |
| `device` | private | registry | identity to role |
| `pairing_request` | private | | pending pairings |
| `consent` | private | append, revocable | consent rows per scope and subject |
| `session` | private | | one armed run of the station |
| `question` | private | | partner questions and menu turns, the reply text |
| `answer_option` | private | | up to four options per version |
| `scan_state` | **public** | one row per session | the clock: ids, phase, step numbers, no text |
| `gesture_log` | private | keyed by `gesture_id` | every gesture and what it did |
| `ledger` | private, read through `board_ledger` | append-only, content-free | every state change |
| `errand` | private | state machine | form errands |
| `call_request` | private | state machine (stretch) | outbound calls |
| `call_line` | private | (stretch) | call transcript lines, numbers masked |
| `agent_job` | private | queue | work for the sidecar, with lease and attempt |
| `pipeline_event` | **public** | append, content-free | stage, status, label, ms, counts |
| `pipeline_payload` | private | | the content behind a pipeline event |
| `device_status` | **public** | one row per device | online, last seen, decoder health |
| `cue_event` | **public** | **event table** | chimes and toasts, never stored |
| `scan_timer` | private | **schedule** -> `scan_tick` | the next step, veto end, clip deadline |
| `liveness_lease` | private | **schedule** -> `liveness_expired` | the dead-man deadline and the last heartbeat |
| `idle_timer` | private | **schedule** -> `idle_pause` | the 2-minute idle deadline |
| `job_lease` | private | **schedule** -> `lease_expired` | agent job leases |
| `errand_lease` | private | **schedule** -> `errand_timeout` | preview, read-back, confirm window, submit lease |
| `call_timer` | private | **schedule** -> `call_timeout` | (stretch) read-back, confirm window, dial lease |
| `pairing_timer` | private | **schedule** -> `pairing_expired` | pairing expiry |
| `errand_dispatch`, `errand_run` | private | schedule -> procedure `dispatch_errand`; lookup | optional database dispatch only (6.2) |
| `voice_token` and its expiry schedule | private | | only if smoke step S1 fails: tokens the sidecar mints (6.1); adding tables later is a safe migration |

### 2.4 Config, devices, consent and sessions

**`config`** (public, one row, `id = 0`). Public because it holds no secrets and no content; anonymous views and the station read it.

| Column | Type | Notes |
|---|---|---|
| `id` | u8, primary key | always 0 |
| `owner` | identity | the publisher, set in `init` |
| `active_session_id` | u64 | the current or most recent session; 0 before the first |
| `share_text_on_board` | bool | the room's privacy toggle; true needs an active `BoardText` consent row |
| `menu_enabled` | bool | YES while idle opens the menu (D11; PLAN Q9 can flip it without a schema change) |
| `auto_resume` | bool | resume a signal pause on its own when contact is good again (10.1) |
| `dispatch_mode` | string | `sidecar` (default) or `database` (the optional upgrade in 6.2); declared now so it never needs a migration |
| timing columns | u32 ms or u8 | the person's timing, defaults in 2.10 |

**`device`** (private): `identity` identity primary key; `role` Role (btree `device_by_role`); `label` string (max 40); `caregiver` bool; `paired_at` timestamp; `revoked` bool.

**`pairing_request`** (private): `code` u32 primary key (100000 to 999999); `requester` identity unique; `role` Role; `label` string; `requested_at`, `expires_at` timestamp.

**`consent`** (private): `id` u64 primary key auto-inc; `scope` ConsentScope (btree `consent_by_scope`); `subject` string (empty means every subject; a `form_key` for Errand, a `contact_id` for Call); `granted_by` identity; `method` string (`owner_cli`, `caregiver`, `wearer`); `note` string (max 80, no names or numbers); `granted_at` timestamp; `revoked_at` option timestamp. A scope check finds a row with `revoked_at` unset and `subject` equal to the asked subject or empty.

**`session`** (private): `id` u64 primary key auto-inc; `station` identity (the Station that armed it); `label` string (`demo`, `rehearsal`); `started_at` timestamp; `ended_at` option timestamp; `question_count` u32; `last_accepted_at` option timestamp (refractory clock); `last_command_at` timestamp; `idle_seq` u64 (fence for `idle_timer`). One active session at a time: the one in `config.active_session_id` with `ended_at` unset.

### 2.5 Questions and options

**`question`** (private; btree `question_by_session` on `session_id`):

| Column | Type | Notes |
|---|---|---|
| `id` | u64 primary key auto-inc | |
| `session_id` | u64 | |
| `request_id` | string unique | made by the partner phone (UUID); menu turns use `menu:<gesture_id>` |
| `origin` | Origin | Partner or Menu |
| `via` | string | `voice`, `typed` or `menu` (`docs/ui.md` gap 7) |
| `menu_item` | MenuItem | None for partner questions |
| `asked_by` | identity | the Partner, or the Station for menu turns |
| `text` | string | max 500; the partner's words or the menu item |
| `number` | u32 | 1-based count in the session for "Question 7"; 0 for the menu itself; a menu follow-up (an item picked) takes the next number |
| `answer_mode` | AnswerMode | set when options are published |
| `version` | u32 | the option version being scanned; 0 before the first publish |
| `pending_version` | u32 | a newer version waiting for the end of the current pass; 0 none |
| `status` | QuestionStatus | |
| `outcome` | option ScanOutcome | |
| `picked_option_id` | option u64 | |
| `reply_text`, `reply_tone` | option string | copied from the picked reply option when released (`docs/ui.md` gap 6) |
| `listen_ms` | u32 | speech to text time reported by the phone |
| `asked_at` | timestamp | |
| `ready_at`, `released_at`, `spoken_at`, `ended_at` | option timestamp | |

**`answer_option`** (private; btree `option_by_qv` on `question_id, version`):

| Column | Type | Notes |
|---|---|---|
| `id` | u64 primary key auto-inc | |
| `question_id`, `version` | u64, u32 | |
| `rank` | u8 | 1-based reading order; in YesNo mode rank 1 is yes and rank 2 is no |
| `kind` | OptionKind | Reply, Errand, Call (offered by Claude) or Menu (made by the module) |
| `menu_item` | MenuItem | Menu options only |
| `text` | string | max 200 |
| `tone` | string | one Cartesia emotion from the allowlist in `cartesia/src/tones.ts`, or empty (D10) |
| `laugh` | bool | the option ends with `[laughter]` |
| `provenance` | string | `memory`, `web`, `maps`, `model`, `menu` |
| `sources` | array of `SourceRef` | `SourceRef = { source, url?, place_id?, fetched_at }`, the existing Option row contract |
| `memory_refs` | array of string | Moss memory ids behind the option (content-free) |
| `action_json` | string | errand: `{ formKey, formUrl, formTitle, fields: [{ label, value, source? }] }`; call: the Dialer's `PreparedCall` `{ requestId, contactId, recipientName, readBack, digest, expiresAt }`; empty for replies |
| `clip_ms` | option u32 | measured by the station from the synthesized clip |
| `created_at` | timestamp | |

Memory text never goes into SpacetimeDB unless the person marked that memory shareable (moss/README.md: a hit's `sharedText`). A memory-based option's own text is fine: it is the answer the person may say.

### 2.6 The scan clock

**`scan_state`** (public, one row per session, primary key `session_id`). Ids and numbers only, so it is safe to publish.

| Column | Type | Notes |
|---|---|---|
| `session_id` | u64 primary key | |
| `question_id`, `version` | u64, u32 | what is being scanned; kept after the scan ends so the board can show the last turn |
| `mode` | ScanMode | Answer, or Menu while the person's menu is read |
| `answer_mode` | AnswerMode | Pick, or YesNo (one prompt, YES or NO answers) |
| `phase` | Phase | Idle, Preparing, Reading, Window, Veto, Paused |
| `cursor` | u8 | 1-based rank under the cursor; 0 for the YesNo prompt or no option |
| `option_count` | u8 | |
| `pass`, `max_passes` | u8 | 1-based pass; `max_passes` from config |
| `step_seq` | u64 | bumps on every phase or cursor change, pause and resume |
| `step_started_at`, `step_ends_at` | timestamp | the current phase's start and planned end |
| `option_start_seq` | u64 | `step_seq` when the current option's Reading began |
| `option_started_at` | timestamp | when the current option's Reading began |
| `prev_cursor`, `prev_option_start_seq` | u8, u64 | the option before, for the grace window |
| `outcome` | option ScanOutcome | set when a scan ends |
| `picked_rank`, `picked_option_id` | option u8, option u64 | |
| `pause_reason` | option PauseReason | |
| `paused_at` | option timestamp | |
| `resume_cursor` | u8 | the option to re-read after a pause |
| `updated_at` | timestamp | |

**`scan_timer`** (private schedule table, bound to `scan_tick`): `scheduled_id`, `scheduled_at`, `session_id` (btree), `step_seq` (fence), `kind` ScanTimerKind.

### 2.7 Gestures and the ledger

**`gesture_log`** (private; btree `gesture_by_session`). One row per gesture call, accepted or not, so the board can show the debounce.

| Column | Type | Notes |
|---|---|---|
| `gesture_id` | string primary key | UUID made by the Python decoder, shared with Tiger's `selection_events` |
| `session_id` | u64 | |
| `device` | identity | the station that relayed it |
| `command` | Command | |
| `source` | string | `imagery`, `jaw`, `key` or `switch` (keyboard and USB switch are labelled on screen) |
| `confidence` | f32 | the decoder's score |
| `heard_step_seq`, `heard_option_id` | u64 | what the station was playing at the gesture's onset |
| `heard_digest` | string | for CONFIRM: the digest of the read-back the station played |
| `onset_age_ms` | u32 | ms between the onset and the call |
| `received_at` | timestamp | server time |
| `outcome` | string | `accepted:<action>` or `ignored:<reason>` (vocabulary in 4.2) |
| `reason` | string | the ignore reason code, or empty |
| `question_id`, `option_id`, `errand_id`, `call_id` | u64 | what it acted on; 0 if nothing |
| `late_by_ms` | u32 | for a pick attributed to the previous option: ms since the step changed |

**`ledger`** (private, append-only, content-free; btree `ledger_by_session`). Written in the same transaction as every state change, so it cannot disagree with the state (research: a reducer is one atomic transaction).

| Column | Type | Notes |
|---|---|---|
| `id` | u64 primary key auto-inc | |
| `session_id` | u64 | |
| `at` | timestamp | |
| `kind` | string | `session_start`, `session_end`, `question`, `options`, `clips_ready`, `scan_start`, `step`, `gesture`, `pick`, `veto_cancel`, `reply_released`, `reply_spoken`, `scan_end`, `menu_open`, `errand`, `call`, `pause`, `resume`, `job_claimed`, `job_requeued`, `job_failed`, `consent`, `board_sharing`, `device_paired`, `device_revoked`, `timing`, `late_result` |
| `actor` | string | `Station`, `Partner`, `Speaker`, `Agent`, `Owner`, `Scheduler` |
| `question_id`, `option_id`, `errand_id`, `call_id`, `job_id` | u64 | |
| `gesture_id`, `command` | string | |
| `step_seq` | u64 | |
| `cursor` | u8 | |
| `digest` | string | 16 hex characters for errand and call rows |
| `outcome`, `reason` | string | the new status and a reason code |
| `ms` | u32 | a measured duration: `late_by_ms` for picks, pause latency for pauses, dwell for steps |

Nothing updates or deletes ledger rows, except the optional owner-only `purge_session` after the event (privacy rule: delete real-session rows).

### 2.8 Errands and calls

**`errand`** (private; btree `errand_by_status`, `errand_by_session`):

| Column | Type | Notes |
|---|---|---|
| `id` | u64 primary key auto-inc | |
| `session_id`, `question_id`, `option_id` | u64 | |
| `status` | ErrandStatus | state machine 4.3 |
| `form_key` | string | the allowlisted form (`care_team_request`); the consent subject |
| `form_url`, `form_title` | string | the URL is not a secret; the title is from the approved list |
| `fields_json` | string | the `FieldInput[]` from the option, sent to the Actor at preview and submit |
| `preview_digest` | string | 16 hex characters from the Actor's preview (`apify/form-errand/src/digest.ts`) |
| `read_back_text` | string | the Actor's `readBackText`, built from values read back off the page |
| `read_back_json` | string | the Actor's `ReadBackItem[]` |
| `screenshot_url` | string | |
| `confirmation_text` | string | after submit |
| `reason_code`, `reason` | string | why it stopped, was refused or failed; `reason` is one sentence to speak (the Actor's refusal sentences are written to be spoken) |
| `window_seq` | u32 | fence for read-back and confirm-window timers |
| `readback_done_at`, `confirm_opens_at`, `confirm_closes_at` | option timestamp | `docs/ui.md` gap 5 |
| `confirmed_digest` | string | copied from `preview_digest` by a valid CONFIRM |
| `confirm_gesture_id`, `stop_gesture_id` | string | the command that released or stopped it |
| `confirmed_at` | option timestamp | |
| `claim_attempt` | u32 | fencing token for the submit lease |
| `claimed_by` | identity | zero identity until claimed |
| `claimed_at`, `submitted_at`, `previewed_at`, `ended_at` | option timestamp | |
| `preview_ms`, `submit_ms` | u32 | from the Actor's timings |
| `created_at`, `updated_at` | timestamp | |

**`errand_lease`** (private schedule table, bound to `errand_timeout`): `scheduled_id`, `scheduled_at`, `errand_id` (btree), `kind` ErrandTimerKind, `seq` u32 (`window_seq` for Readback and ConfirmWindow, `claim_attempt` for Submit, 0 for Preview).

**`call_request`** (private, stretch; btree `call_by_status`, `call_by_session`). No phone number is ever stored here; the Dialer keeps numbers on the agent laptop.

| Column | Type | Notes |
|---|---|---|
| `id` | u64 primary key auto-inc | |
| `session_id`, `question_id`, `option_id` | u64 | |
| `request_id` | string unique | the Dialer's `requestId` (`^[A-Za-z0-9_-]{1,64}$`, checked in `cartesia/src/call.ts`) |
| `contact_id`, `contact_name` | string | the Dialer's `contactId` and `recipientName`; the consent subject is `contact_id` |
| `read_back_text` | string | `PreparedCall.readBack`, for example "Call Leon to say your Care team request was sent." |
| `script_digest` | string | `PreparedCall.digest`, 16 hex over who is called and every word of the script |
| `prepared_expires_at` | timestamp | `PreparedCall.expiresAt` (the Dialer's default is 2 minutes after prepare) |
| `status` | CallStatus | state machine 4.4 |
| `result` | string | `answered`, `no_answer`, `busy`, `voicemail`, `cancelled`, `failed`, `refused`, `unknown` (the Dialer's `CallResult`) |
| `end_reason`, `reason_code`, `reason` | string | |
| `cancel_requested` | bool | STOP, HEADSET_OFF, idle or operator during a live call |
| `cancel_reason` | string | the Dialer's `CancelReason`: `stop`, `headset_off`, `auto_pause`, `operator` |
| `window_seq`, `claim_attempt` | u32 | fences |
| `claimed_by` | identity | |
| `confirm_gesture_id`, `stop_gesture_id` | string | |
| `readback_done_at`, `confirm_opens_at`, `confirm_closes_at`, `confirmed_at`, `dialed_at`, `ringing_at`, `connected_at`, `ended_at` | option timestamp | our own Ringing and Connected times (`docs/ui.md` gap 9) |
| `created_at`, `updated_at` | timestamp | |

**`call_line`** (private, stretch): `id` u64 primary key auto-inc; `call_id` u64 (btree); `line_key` string unique (idempotent writes); `role` string (`assistant`, `recipient`); `text` string (numbers masked by the Dialer); `at` timestamp.

**`call_timer`** (private schedule table, bound to `call_timeout`): `scheduled_id`, `scheduled_at`, `call_id` (btree), `kind` CallTimerKind, `seq` u32.

### 2.9 Agent work, pipeline, devices, cues and other schedules

**`agent_job`** (private; btree `job_by_status`, `job_by_claimer` on `claimed_by`, `job_by_question`):

| Column | Type | Notes |
|---|---|---|
| `id` | u64 primary key auto-inc | |
| `kind` | JobKind | Options (draft options for a question or a menu item), ErrandPreview (run the Actor's `/preview`), Remember (write a spoken reply into Moss) |
| `status` | JobStatus | state machine 4.5 |
| `question_id`, `errand_id` | u64 | 0 when not used |
| `attempt` | u32 | the fencing token; the claimer's attempt is the Pending row's `attempt + 1` |
| `claimed_by` | identity | zero identity while Pending |
| `lease_expires_at` | option timestamp | |
| `web_search_allowed`, `memory_allowed` | bool | from `consent` when the job is made; the sidecar obeys them and `agent_progress` refuses a search stage without them |
| `reason` | string | failure or cancel reason code |
| `created_at`, `updated_at` | timestamp | |

**`job_lease`** (private schedule table, bound to `lease_expired`): `scheduled_id`, `scheduled_at`, `job_id` (btree), `attempt` u32 (fence).

**`pipeline_event`** (public, append, content-free; btree `event_by_session`):

| Column | Type | Notes |
|---|---|---|
| `id` | u64 primary key auto-inc | |
| `event_key` | string unique | idempotency key, for example `<job_id>:<attempt>:search:started` |
| `session_id`, `question_id` | u64 | `question_id` added (`docs/ui.md` gap 1); 0 for a listen start before the question exists |
| `stage` | string | `listen`, `search`, `retrieve`, `plan`, `speak`, `select`, `errand`, `call` |
| `status` | string | `started`, `ok`, `error` |
| `detail` | string | a short label from a fixed vocabulary, matching `^[a-z0-9 :_-]{1,120}$`; the same field the producers' events call `detail` (checked: `apify/client`, `cartesia` and `moss` emit labels such as `web partial`, `preview refused: captcha`, `read-back ready`). The reducer can check the shape, not the meaning: keeping words out of it is the producers' job |
| `ms` | option u32 | final time; unset while `started` |
| `counts_json` | string | a JSON object whose values are numbers or booleans only (checked by the reducer), for example `{"rows":6,"searches":2,"needsWeb":true}` |
| `actor` | string | `Partner`, `Agent`, `Station`, `Speaker`, `Module` |
| `at` | timestamp | |

**`pipeline_payload`** (private; btree `payload_by_session`, `payload_by_question`): `event_id` u64 primary key; `session_id`, `question_id` u64; `stage` string; `payload_json` string (max 16 KB). The content behind an event, in the shapes of `web/lib/data/types.ts`:

| Stage | Payload |
|---|---|
| listen | `{ "words": "<partner's words>" }` |
| search | `{ "reason": "<classify sentence>", "rows": [SearchRow] }` with each row's text cut to 300 characters |
| retrieve | `{ "hits": [MossHit] }`; memory hits carry id, type, score, saved time and `sharedText` (null unless shareable); web hits carry a 300-character excerpt and their `SourceRef` |
| speak | `{ "optionId", "rank", "text", "channel": "earpiece" or "aloud", "durationMs" }` |
| select | `{ "optionId", "rank", "text" }` |
| plan, errand, call | none (the board reads `public_board`, `board_errands`, `board_calls`) |

**`device_status`** (public, primary key `identity`): `role` Role; `label` string; `online` bool; `last_seen_at` timestamp (updated at most every 2 s, so heartbeats do not flood the board); `decoder_healthy` option bool (Station only).

**`cue_event`** (public **event table**, `event: true`): `session_id`, `kind` string, `reason` string (a code, never text), `question_id`, `option_id`, `errand_id`, `call_id` u64, `rank` u8, `at` timestamp. Rows are broadcast on commit and never stored, clients only get `onInsert`, views cannot read them, and the event flag cannot change after the first publish (research: event tables doc). Kinds: `menu_open`, `not_ready`, `picked`, `veto_cancelled`, `reply_released`, `none`, `no_pick`, `again`, `more_options`, `say_confirm`, `confirmed`, `not_sent`, `errand_preparing`, `errand_refused`, `errand_failed`, `errand_sent`, `errand_unknown`, `too_late`, `call_cancelling`, `call_ended`, `paused`, `resumed`, `question_waiting`, `failed`. The station maps each kind to a cached stock phrase; the board shows a toast.

**`liveness_lease`** (private schedule table, bound to `liveness_expired`): `scheduled_id`, `scheduled_at`, `session_id` (btree), `beat_seq` u64, `last_beat_at` timestamp, `decoder_healthy` bool, `healthy_since` option timestamp. The row is the deadline and the last heartbeat at once: each heartbeat deletes it and inserts a new one.

**`idle_timer`** (private schedule table, bound to `idle_pause`): `scheduled_id`, `scheduled_at`, `session_id` (btree), `idle_seq` u64 (fence against `session.idle_seq`).

**`pairing_timer`** (private schedule table, bound to `pairing_expired`): `scheduled_id`, `scheduled_at`, `code` u32.

### 2.10 The person's timing (config defaults)

Starting values; set each from the wearer's calibration with `set_timing`. Sources: D11 for the response window; the commands lane (section 4.6 of the research) for the rest; the report's section 4.2 for the lease.

| Key | Builder default | Starting point for an ALS user | Allowed range | What it does |
|---|---|---|---|---|
| `response_window_ms` | 3500 | 4000 to 6000 | 1000 to 10000 | silent window after each option (D11: imagined movement is slow); the person's 90th-percentile response plus 0.5 s, capped at 6 s |
| `grace_ms` | 1000 | tune on recordings | 0 to 3000 | how late a YES for the previous option may arrive after the step changed; at least the decoder's p90 latency plus the network's p90, and no more than `refractory_ms`, so a YES can never land on an option the person just skipped with NO |
| `refractory_ms` | 1000 | 1500 | 200 to 5000 | YES, NO and CONFIRM within this time of an accepted command are ignored; STOP and HEADSET_OFF never are |
| `quiet_hold_ms` | 1000 | 1000 | 500 to 5000 | quiet time after a read-back before the confirm window opens |
| `confirm_window_ms` | 8000 | 10000 | 3000 to 20000 | how long CONFIRM is accepted |
| `reply_veto_ms` | 700 | 1000 | 300 to 3000 | after YES on a reply, time for STOP or NO before it is said aloud |
| `yes_no_cue_ms` | 900 | 900 | 300 to 3000 | dwell of the "Yes or no?" prompt |
| `audio_pad_ms` | 150 | 150 | 0 to 1000 | added to each clip so the window starts after the audio ends at the station |
| `clip_deadline_ms` | 4000 | 4000 | 1000 to 15000 | start scanning with estimated clip lengths if clips are late |
| `max_passes` | 2 | 2 | 1 to 3 | passes over the options before "No pick" |
| `max_options` | 4 | 4 | 2 to 4 | |
| `heartbeat_ms` | 500 | 500 | 200 to 2000 | how often the station beats (the station reads it) |
| `liveness_lease_ms` | 1500 | 1500 to 2500 after measuring | 1000 to 5000 | dead-man deadline |
| `resume_good_contact_ms` | 3000 | 5000 | 0 to 30000 | healthy heartbeats needed before an automatic resume |
| `idle_pause_ms` | 120000 | set with the family | 30000 to 1800000 | pause after this long with no accepted command |
| `readback_deadline_ms` | 30000 | 30000 | 5000 to 120000 | an unfinished read-back stops the errand or call |
| `preview_timeout_ms` | 60000 | 60000 | 10000 to 180000 | a preview that does not arrive fails |
| `submit_lease_ms` | 60000 | 60000 | 10000 to 180000 | must be longer than the sidecar's own submit timeout |
| `call_lease_ms` | 240000 | 240000 | 60000 to 600000 | the Dialer's span is ring 25 s plus a 2-minute cap plus 60 s |
| `job_lease_ms` | 45000 | 45000 | 5000 to 180000 | agent job lease, extended by each `agent_progress` |
| `job_max_attempts` | 3 | 3 | 1 to 5 | |
| `pairing_ttl_ms` | 300000 | 300000 | 30000 to 900000 | |

---

## 3. Reducers

Every reducer is one serializable transaction: it commits all of its writes or none (research). Names are wire names; arguments are listed in order (the HTTP `/call` body is a JSON array in this order).

### 3.1 Guards and how a reducer fails

| Guard | Check | On failure |
|---|---|---|
| `requireOwner` | `config.owner` equals `ctx.sender` | `SenderError('owner only')` |
| `requireRole(...roles)` | a `device` row for `ctx.sender`, not revoked, with one of the roles | `SenderError('not allowed')` |
| `requireStation` | `requireRole('Station')` and, for session work, `session.station` equals the sender | `SenderError('not the session station')` |
| `requireScheduler` | `ctx.sender.isEqual(ctx.databaseIdentity)` | `SenderError('scheduler only')` |
| `requireActiveSession` | `config.active_session_id` names a session with `ended_at` unset | `SenderError('no active session')`, except in `gesture`, which records `ignored:no_session` |

- Scheduled reducers always start with `requireScheduler`. Scheduled functions are private in 2.x, but the owner and collaborators can still call them, and `ctx.senderAuth.isInternal` is false for every call on a real host in the TypeScript library (checked: `AuthCtxImpl.fromBackend` in `runtime.ts` sets `isInternal: false`; research: Clockwork's Scrabblebot guards with the database identity for this reason). In the test harness, `TestAuth.internal()` runs with the module identity, so the same guard passes (checked: `test-utils/index.ts`).
- **Throw `SenderError`** for a caller that is not allowed or input that is malformed. The whole transaction rolls back; HTTP callers get 530; SDK callers get a rejected promise (`SenderError`, checked in `lib/errors.ts`).
- **Record, do not throw,** when a person's command is valid but has nothing to do (refractory, wrong phase, stale step, window closed). `gesture` writes `gesture_log` and `ledger` with `ignored:<reason>` and returns success. A throw would roll back the record of what the person did.
- **Agent writes from an old attempt throw** `SenderError('stale attempt')`, so the sidecar knows to drop its work.
- **Idempotency.** Retrying any client call is safe: `gesture_id`, `request_id`, `event_key` and `line_key` are unique, and every state change checks the current status first. A call that failed with `UnknownCallResultError` is retried with the same arguments (research: 2.12 SDK, in-flight calls "may have executed").

### 3.2 Pairing, consent, config and sessions

| Reducer (arguments) | Caller | Checks | Writes | Fails |
|---|---|---|---|---|
| `init` | lifecycle, the publisher | `config` missing | `config` with `owner = sender` and the defaults in 2.10 | |
| `request_pairing(code u32, role string, label string)` | any identity without a live device row | code is 6 digits and free; role is `station`, `partner`, `speaker` or `agent`; label 1 to 40 characters | `pairing_request`; `pairing_timer` at `expires_at` | already paired; code taken (pick a new code); bad role or label |
| `approve_pairing(code u32, caregiver bool)` | owner | request exists and has not expired | `device`, `device_status` (offline until it connects), deletes the request; ledger `device_paired` | unknown or expired code |
| `revoke_device(identity)` | owner | | `device.revoked = true`; `device_status.online = false`; if it was the session's station, pause (Operator); ledger `device_revoked` | |
| `grant_consent(scope string, subject string, method string, note string)` | owner, or a caregiver Partner | scope is `web_search`, `memory`, `errand`, `call` or `board_text` | `consent` row; ledger `consent` | bad scope; note too long |
| `revoke_consent(consent_id u64)` | owner, or a caregiver Partner | row active | `revoked_at`; revoking Errand or Call stops pending items for that subject (`consent_revoked`); revoking BoardText turns sharing off | |
| `set_timing(json string)` | owner | a JSON object whose keys are the snake_case names in 2.10, each inside its range | config; ledger `timing` | unknown key or out of range (nothing changes) |
| `set_board_sharing(on bool)` | owner, or a caregiver Partner | turning on needs an active BoardText consent row | `config.share_text_on_board`; ledger `board_sharing` | no BoardText consent |
| `ensure_timers()` | owner | | repairs timers after a republish: a missing `scan_timer` for the current step (at `step_ends_at`, or now if past), a missing `liveness_lease` for the active session, a missing `idle_timer`, a missing `job_lease` for each Claimed job, missing `errand_lease`/`call_timer` rows for waiting errands and calls; inserts `config` if absent. Idempotent | |
| `start_session(label string)` | Station | no active session | `session` (station = sender); `scan_state` (Idle); `liveness_lease` at now + lease; `idle_timer`; `config.active_session_id`; ledger `session_start` | a session is active |
| `end_session()` | the session's Station, or owner | active session | voids pending items (`session_ended`); `scan_state` Idle; deletes the session's scan, liveness and idle timers; `ended_at`; ledger `session_end` | |
| `operator_pause()` | owner, Partner or Speaker | active session | pause (Operator) | |
| `operator_resume()` | owner | paused | resume | not paused |
| `purge_session(session_id u64)` (optional) | owner | the session has ended | deletes its questions, options, payloads, gestures, ledger, errands, calls and lines | session still active |

### 3.3 The partner

| Reducer (arguments) | Caller | Checks | Writes | Fails |
|---|---|---|---|---|
| `ask_question(request_id string, text string, via string, listen_ms u32)` | Partner (or owner for tests) | active session; `request_id` new (else return: a retry); text 1 to 500 characters; `via` is `voice` or `typed` | `question` (Drafting, `number = question_count + 1`); `agent_job` Options with `web_search_allowed` and `memory_allowed` from consent; `pipeline_event` listen ok (`event_key = listen:<request_id>`, `ms = listen_ms`, counts `{wordCount}`) with payload `{words}`. Then: if the scan is in Veto or Paused, the question waits (cue `question_waiting` while paused; an Idle pause resumes). Otherwise it supersedes: the older question in Drafting, Ready or Scanning (including an open menu) becomes Cancelled (`superseded`) with its job; errands and calls that no agent has claimed yet are stopped (`interrupted`); `scan_state` goes to Preparing for the new question; `ClipDeadline` timer | no session; text empty or too long |
| `cancel_question(question_id u64)` | Partner (or owner) | question in Drafting, Ready or Scanning | scan ends Cancelled if it is the scanned one; job Cancelled; question Cancelled | already released, picked or ended |
| `partner_listening(request_id string, on bool)` (optional) | Partner | | `pipeline_event` listen started (`question_id = 0`) so the board shows "Listening" | |

### 3.4 The station

**`report_clip_ready(option_id u64, clip_ms u32, synth_ms u32)`** (Station). The option belongs to the scanned or pending version, else return quietly (late clips are normal). Sets `clip_ms`. When every option of the scanned version has a clip and the phase is Preparing, the scan starts (4.1). On the last clip it writes `pipeline_event` speak ok (`detail: earpiece`, counts `{clips}`, `ms` = publish to last clip).

**`report_readback_done(kind string, id u64, digest string)`** (the session's Station). `kind` is `errand` or `call`. The row is Previewed (errand) or Prepared (call) and `digest` equals its `preview_digest` or `script_digest`. Sets `readback_done_at`, `confirm_opens_at = now + quiet_hold_ms`, `confirm_closes_at = confirm_opens_at + confirm_window_ms`, `window_seq += 1`, status AwaitingConfirm, and a ConfirmWindow timer at `confirm_closes_at`. A digest mismatch throws (the station played a stale read-back).

**`heartbeat(beat_seq u64, decoder_healthy bool)`** (the session's Station), every `heartbeat_ms`:
1. Reads the session's `liveness_lease` row, keeps `healthy_since` if both beats are healthy, deletes it and inserts a new one at `now + liveness_lease_ms` with `beat_seq`, `last_beat_at = now`, `decoder_healthy`, `healthy_since`.
2. Updates `device_status` only when `online` or `decoder_healthy` changes, or 2 s have passed.
3. `decoder_healthy = false` while not paused for a signal reason: pause (HeadsetOff).
4. Paused for HeadsetLost or HeadsetOff, `config.auto_resume` on, healthy for at least `resume_good_contact_ms`: resume.

No view reads `liveness_lease`, so twice-a-second heartbeats do not recompute any view.

**`gesture(gesture_id string, command string, heard_step_seq u64, heard_option_id u64, heard_digest string, confidence f32, source string, onset_age_ms u32)`** (the session's Station). The heart of the module:
1. `requireStation`. `command` must be `YES`, `NO`, `CONFIRM`, `STOP` or `HEADSET_OFF`; `gesture_id` 1 to 64 characters; else throw.
2. A `gesture_log` row with this id already exists: return (a retry). Same id with a different command: throw.
3. No active session: record `ignored:no_session`.
4. Decide with the table in 4.2. Refractory applies to YES, NO and CONFIRM only.
5. Resolve the heard option for YES and NO while Reading or Window:
   - `option_start_seq <= heard_step_seq <= step_seq`: the current option.
   - `prev_option_start_seq <= heard_step_seq < option_start_seq`, and `now - option_started_at <= grace_ms`: the previous option, with `late_by_ms = now - option_started_at`.
   - Anything else: `ignored:stale_step`.
   - If `heard_option_id` is not 0 and differs from the resolved option: `ignored:heard_mismatch` (fail closed).
6. The CONFIRM checks are the fail-closed rule (research, commands lane 6.1) made into code. All must hold, else `ignored:<reason>`:
   1. from the session's Station, command CONFIRM;
   2. the errand or call is AwaitingConfirm, so its read-back finished (`readback_done_at` set);
   3. the onset is after the quiet hold: `now - onset_age_ms >= confirm_opens_at` (else `ignored:quiet_hold`, and the hold restarts with a new `window_seq`);
   4. inside the window: `now <= confirm_closes_at` (else `ignored:window_closed`);
   5. good contact: not paused, and the latest `liveness_lease` says `decoder_healthy` (else `ignored:no_contact`);
   6. `heard_digest` equals `preview_digest` (or `script_digest`) (else `ignored:digest_mismatch`);
   7. never used: the gesture id is new and the row is still AwaitingConfirm; for a call, an active Call consent for `contact_id`; for an errand, an active Errand consent for `form_key` (else `ignored:no_consent`).
   On success: status Confirmed, `confirmed_digest`, `confirm_gesture_id`, `confirmed_at`; cue `confirmed`; ledger `errand`/`call` `confirmed`.
7. Writes `gesture_log`, a ledger `gesture` row (command, outcome, `late_by_ms`), and for accepted commands `session.last_accepted_at`, `session.last_command_at`, a fresh `idle_timer` (`idle_seq += 1`) and the cue.

**`gesture_http(gesture_id string, command string, age_ms u32, confidence f32, source string)`** (any Station device; fallback only, 7.5). Same as `gesture`, except the heard option comes from durations: `onset = now - age_ms`; the current option if `onset >= option_started_at`, the previous option if `onset >= previous option's start` and `now - option_started_at <= grace_ms`. No digest is sent, so CONFIRM over this path takes the digest from the row being confirmed and logs `heard_digest` as empty. Build it only if the station relay fails the smoke test.

### 3.5 The speaker

**`reply_spoken(question_id u64, ms u32)`** (Speaker). The question is Released: status Spoken, `spoken_at`; `pipeline_event` speak ok (`detail: aloud`, `ms`); ledger `reply_spoken`; if a Memory consent is active, an `agent_job` Remember. A second Speaker's call returns quietly.

### 3.6 The agent sidecar

All `(job_id, attempt)` writes are fenced: the job is Claimed, `job.attempt == attempt` and `job.claimed_by == sender`, else `SenderError('stale attempt')`.

| Reducer (arguments) | Checks | Writes |
|---|---|---|
| `agent_claim(job_id u64)` | Agent; job Pending | Claimed, `attempt += 1`, `claimed_by`, `lease_expires_at`; `job_lease` at `now + job_lease_ms`; ledger `job_claimed`. Not Pending: `SenderError('not pending')` (someone else has it) |
| `agent_progress(job_id, attempt, event_key string, stage string, status string, detail string, ms u32, counts_json string, payload_json string)` | fenced; `event_key` new (else return); stage and status in their vocabularies; `detail` matches the label rule; `counts_json` numbers and booleans only; payload at most 16 KB; a `search` stage needs `web_search_allowed` | `pipeline_event` (+ `pipeline_payload` if not empty); lease extended (delete and insert the `job_lease` row, new `lease_expires_at`) |
| `agent_publish_options(job_id, attempt, answer_mode string, options OptionInput[], final bool)` | fenced; job kind Options; if the question is no longer Drafting, Ready or Scanning (the person already picked, or it was cancelled), nothing is written and a final publish marks the job Done; `answer_mode` is `pick` (1 to `max_options` options) or `yes_no` (exactly 2, rank 1 yes); texts 1 to 200 characters; tone in the allowlist or empty; kind `reply`, `errand` or `call`; an errand's `action_json` names a `form_key`; a call's `action_json` carries a `requestId`, a `contactId` and a 16-hex `digest` | `answer_option` rows at `version = max(version, pending_version) + 1`; `pipeline_event` plan ok (counts `{version, optionCount}`). If the scan is Preparing for an older version, or the question has no version yet: this version becomes current and the scan waits for clips (YesNo starts at once: the prompt is a stock phrase). If the scan is Reading or Window: `pending_version`, switched in at the end of the pass with cue `more_options`. Otherwise the rows are kept and not scanned. `final = true` marks the job Done; `final = false` keeps it Claimed (memory-first options, then web options, D8) |
| `agent_attach_preview(job_id, attempt, status string, form_title string, read_back_text string, read_back_json string, preview_digest string, screenshot_url string, reason_code string, reason string, preview_ms u32)` | fenced; job kind ErrandPreview; status is `previewed`, `refused` or `failed`; for `previewed` the digest is 16 hex and the Errand consent is still active | errand Drafted only: Previewed (with `previewed_at`, a Readback timer) or Refused or Failed; job Done. If the errand already left Drafted (STOP was quicker), the job is Done and the errand is unchanged |
| `agent_fail(job_id, attempt, reason_code string, reason string)` | fenced | job Failed; for Options the question Failed with cue `failed` and a pipeline `plan error`; for ErrandPreview the errand Failed |
| `agent_done(job_id, attempt, counts_json string)` | fenced; kind Remember | job Done |
| `claim_errand(errand_id u64, digest string)` | Agent; errand Confirmed; `digest == confirmed_digest == preview_digest`; Errand consent active | Submitting, `claim_attempt += 1`, `claimed_by`, `claimed_at`; Submit timer at `now + submit_lease_ms` with `seq = claim_attempt`; ledger. Else `SenderError` |
| `complete_errand(errand_id u64, attempt u32, status string, confirmation_text string, screenshot_url string, reason_code string, reason string, submit_ms u32)` | Agent; `attempt == claim_attempt` and `claimed_by == sender`; errand Submitting, or UnknownOutcome (a late true result from the same attempt) | `submitted` or `duplicate`: Submitted with `confirmation_text`, `screenshot_url`, `submitted_at`, cue `errand_sent`; `refused`: Refused; `failed`: Failed; `unknown`: UnknownOutcome, cue `errand_unknown`. A late result after UnknownOutcome writes ledger `late_result` |

`OptionInput` is `{ kind, text, tone, laugh, provenance, sources: SourceRef[], memoryRefs: string[], actionJson }` (checked: arrays of named objects compile as reducer arguments and columns).

### 3.7 Calls (stretch: build after the errand path passes two rehearsals)

| Reducer (arguments) | Checks | Writes |
|---|---|---|
| `claim_call(call_id u64, digest string)` | Agent; call Confirmed; `digest == script_digest`; Call consent for `contact_id` active | Dialing, `claim_attempt += 1`, `claimed_by`, `dialed_at`; Lease timer at `now + call_lease_ms`. The sidecar must then call `dialer.place(requestId, digest)` at once: the Dialer refuses a dial more than 30 s after the confirm (checked: `maxConfirmToDialMs` default 30000 in `cartesia/src/call.ts`) |
| `report_call_status(call_id u64, attempt u32, status string, result string, end_reason string, reason_code string, reason string)` | fenced by `claim_attempt` and `claimed_by` | `ringing`, `connected`, `ended`, `failed` or `refused` with the matching times; Ended and Failed carry `result`; a Dialer refusal becomes Refused with its code and sentence |
| `add_call_line(call_id u64, attempt u32, line_key string, role string, text string)` | fenced; `line_key` new (else return); role `assistant` or `recipient`; text max 500 | `call_line` |

A call is never retried: one CONFIRM, one call (Cartesia package and D4).

### 3.8 Scheduled reducers

All start with `requireScheduler` and compare their row's fence before acting.

| Reducer | Table | Fence | Does |
|---|---|---|---|
| `scan_tick` | `scan_timer` | `job.step_seq == scan_state.step_seq` | StepEnd: Reading to Window; Window to the next option's Reading, or the end of the pass (4.1). VetoEnd: release the reply. ClipDeadline: start the scan with estimated clip lengths if still Preparing |
| `liveness_expired` | `liveness_lease` | the session is active and its current lease row is this one (same `scheduled_id` and `beat_seq`; a newer heartbeat would have replaced it) | pause (HeadsetLost) with ledger `ms = now - last_beat_at` (the pause latency, from server clocks only); `device_status` station offline |
| `idle_pause` | `idle_timer` | `job.idle_seq == session.idle_seq` | if not paused and no call is Connected: pause (Idle). With a Connected call it re-arms instead, so an idle timer never hangs up a live call |
| `lease_expired` | `job_lease` | `job.status == Claimed && job.attempt == row.attempt` | back to Pending if `attempt < job_max_attempts` and the work is still wanted (ledger `job_requeued`); otherwise Failed (question Failed, cue `failed`) or Cancelled if its question or errand has moved on |
| `errand_timeout` | `errand_lease` | kind-specific | Preview: still Drafted, Failed (`preview_timeout`). Readback: still Previewed and `seq == window_seq`, Stopped (`readback_not_finished`). ConfirmWindow: still AwaitingConfirm and `seq == window_seq`, Stopped (`window_closed`, cue `not_sent`). Submit: still Submitting and `seq == claim_attempt`, UnknownOutcome (`lease_lapsed`, cue `errand_unknown`); nothing resubmits |
| `call_timeout` | `call_timer` | kind-specific | Readback and ConfirmWindow: Stopped, as for errands. Lease: still Dialing, Ringing or Connected with the same attempt, Failed with result `unknown` |
| `pairing_expired` | `pairing_timer` | the request with this code still exists | deletes it |

Deleting a pending schedule row cancels it (research: turn-based guide). Step changes delete the session's pending `scan_timer` rows before inserting the next one; whether updating a schedule row in place reschedules it is unknown, so the plan always deletes and inserts.

### 3.9 Lifecycle reducers

- `client_connected` and `client_disconnected` update `device_status.online` and `last_seen_at` for Partner, Speaker and Agent devices only. They never pause anything.
- The station's presence comes only from heartbeats. Two reasons (research): every HTTP `/call` runs `client_connected`, the call and `client_disconnected` around it, so lifecycle cannot track an HTTP caller; and a silent network drop can leave a socket looking open for the server's idle timeout (30 s by default) while the browser SDK never fires `onDisconnect`.

### 3.10 Shared helpers (module-internal, not exported from `index.ts`)

| Helper | Does |
|---|---|
| `startScan(question, version)` | sets mode, answer mode, `option_count`, pass 1, cursor 1 (0 for YesNo), Reading; question Scanning; pipeline speak started; ledger `scan_start` |
| `enterReading(cursor)` | `prev_cursor` and `prev_option_start_seq` from the current option; `step_seq += 1`; `option_start_seq = step_seq`; `option_started_at = now`; dwell `clip_ms + audio_pad_ms` (estimate when missing: 300 ms plus 60 ms per character, capped at 6 s; YesNo: `yes_no_cue_ms`); StepEnd timer; ledger `step` |
| `enterWindow()` | Window; `step_seq += 1`; dwell `response_window_ms`; StepEnd timer |
| `endPass()` | a `pending_version` waits: switch to it (Preparing if its clips are missing), cue `more_options`; else `pass < max_passes`: next pass from option 1, cue `again`; else `finishScan(NoPick)` |
| `finishScan(outcome)` | Idle, outcome, `step_seq += 1`, deletes scan timers; question status from the outcome; pipeline select and speak; ledger `scan_end`; cue; then `startNextIfQueued` |
| `startNextIfQueued()` | the newest Drafting or Ready question in the session that is newer than the scanned one becomes Preparing |
| `pause(reason)` | keeps the cursor in `resume_cursor`; a Veto pick is cancelled (nothing said); Paused, `step_seq += 1`, `pause_reason`, `paused_at`; deletes scan and idle timers; `voidPending(reason)`; ledger `pause`; cue `paused`. A signal reason never replaces a deliberate one (Stop, Idle, Operator), because a deliberate pause needs a deliberate resume |
| `voidPending(reason)` | errands Drafted, Previewed, AwaitingConfirm or Confirmed become Stopped; calls Prepared, AwaitingConfirm or Confirmed become Stopped; calls Dialing, Ringing or Connected get `cancel_requested` with the Dialer's cancel reason (`headset_lost` maps to `headset_off`, `idle` to `auto_pause`); Submitting errands are left alone (too late to recall) |
| `resume(by)` | clears the pause; a question mid-scan re-reads `resume_cursor` from its start (new `step_seq`, same pass); otherwise `startNextIfQueued` (a waiting Drafting or Ready question goes to Preparing); else Idle; fresh `idle_timer`; ledger `resume`; cue `resumed` |
| `appendLedger`, `emitCue`, `writePipeline`, `pushIdle` | one-line writers used everywhere |

---

## 4. State machines

### 4.1 Scan

| State (`phase`, `mode`) | Entered by | Earpiece plays | Timer | Leaves to |
|---|---|---|---|---|
| **idle** | session start; every scan end; reply release | nothing | none | preparing (new question, menu open, menu item picked); paused |
| **preparing** | `ask_question`; menu open; a menu item picked; switching to a version whose clips are missing | "One moment" only if a YES or NO arrives | ClipDeadline | reading (all clips in, or the deadline); idle (STOP: Stopped; `cancel_question`: Cancelled; the agent failed); paused |
| **reading** (answer, pick) | scan start; the previous option's window ended; NO skipped the previous option; resume | option `cursor` in its tone (D10) | StepEnd at `clip_ms + audio_pad_ms` | window; veto (YES on a reply); idle Picked (YES on an errand or call option); preparing (YES on a menu item); reading of the next option (NO); idle None (STOP); paused |
| **window** (answer, pick) | StepEnd from reading | silence: the response window | StepEnd at `response_window_ms` | reading of the next option; reading of option 1 on the next pass or the pending version; idle NoPick after the last pass; the same exits as reading for YES, NO and STOP |
| **reading and window** (answer, yes_no) | scan start | the stock prompt "Yes or no?", then silence | `yes_no_cue_ms`, then `response_window_ms` | veto (YES picks rank 1, NO picks rank 2); the prompt again on the next pass; idle NoPick; idle None (STOP) |
| **menu** (`mode = Menu`, reading and window over the four menu items) | YES while idle, nothing pending, `menu_enabled` | "I need something", "Send a request", "Call", "Say something else" from the stock phrase cache | as reading and window | preparing for a new Menu-origin question (an item picked); idle None or NoPick; paused |
| **veto** | YES on a reply (or YES or NO in yes_no) | nothing new (the station already clicked) | VetoEnd at `reply_veto_ms` | idle Picked with the reply Released (VetoEnd); reading again (NO: back to scanning at the next option, or the prompt); idle Stopped (STOP); paused (signal: the pick is cancelled) |
| **paused** | STOP while idle; HEADSET_OFF; heartbeat with `decoder_healthy = false`; `liveness_expired`; `idle_pause`; `operator_pause`; `revoke_device` of the station | "Paused" once | none | reading at `resume_cursor` (resume mid-scan); preparing; idle |

`menu` is a mode, not its own phase: the menu is read with the same reading and window steps as answers, so one scan engine serves both (10.1). Menu items are module-made `answer_option` rows of kind Menu on a fresh Menu-origin question, so `my_options`, clip reporting and attribution work unchanged.

### 4.2 What each command does (the gesture decision table)

Accepted outcomes are written `accepted:<action>`, ignored ones `ignored:<reason>`. Refractory (`ignored:refractory`) applies to YES, NO and CONFIRM within `refractory_ms` of the last accepted command; STOP and HEADSET_OFF are never blocked.

| State | YES | NO | CONFIRM | STOP | HEADSET_OFF |
|---|---|---|---|---|---|
| idle, nothing pending | open the menu (`ignored:idle` if `menu_enabled` is off) | `ignored:idle` | `ignored:nothing_to_confirm` | pause (Stop) | pause (HeadsetOff) |
| preparing | `ignored:not_ready`, cue `not_ready` | `ignored:not_ready` | `ignored:nothing_to_confirm` | cancel: question and scan outcome Stopped, job Cancelled | pause |
| reading or window, pick (answers or menu) | pick the heard option (4.1) | skip: if the heard option is the current one, read the next now; a late NO for an option already passed is `ignored:already_passed` | `ignored:nothing_to_confirm` | none of these | pause |
| reading or window, yes_no | answer yes: veto with rank 1 | answer no: veto with rank 2 | `ignored:nothing_to_confirm` | none of these | pause |
| veto | `ignored:veto` | cancel the pick, back to scanning | `ignored:nothing_to_confirm` | cancel the reply: Stopped, nothing said | pause; the pick is cancelled |
| errand Previewed (read-back playing) | `ignored:yes_is_not_confirm`, cue `say_confirm` | stop the errand (`no`) | `ignored:readback_not_done` | stop the errand | pause; errand Stopped |
| errand AwaitingConfirm, quiet hold | `ignored:yes_is_not_confirm` | stop the errand | `ignored:quiet_hold`; the hold restarts | stop the errand | pause; Stopped |
| errand AwaitingConfirm, window open | `ignored:yes_is_not_confirm` | stop the errand | confirm if all seven checks pass (3.4) | stop the errand | pause; Stopped |
| errand Drafted or Confirmed | `ignored:busy` | stop the errand | `ignored:nothing_to_confirm` | stop the errand | pause; Stopped |
| errand Submitting | `ignored:busy` | `ignored:too_late` | `ignored:nothing_to_confirm` | `ignored:too_late`, cue `too_late` | pause; the submit finishes |
| call Prepared or AwaitingConfirm | as for an errand | stop the call | confirm if all checks pass | stop the call | pause; Stopped |
| call Confirmed, Dialing, Ringing or Connected | `ignored:busy` | `ignored:busy` | `ignored:nothing_to_confirm` | hang up: `cancel_requested` (`stop`), cue `call_cancelling` | pause; `cancel_requested` (`headset_off`) |
| paused (Stop or Idle) | resume | `ignored:paused` | `ignored:paused` | `ignored:already_paused` | the reason stays Stop or Idle |
| paused (HeadsetLost or HeadsetOff) | resume if the latest heartbeat is healthy and has been for `resume_good_contact_ms`, else `ignored:no_contact` | `ignored:paused` | `ignored:paused` | the pause becomes Stop (deliberate) | `ignored:already_paused` |
| paused (Operator) | `ignored:operator_pause` | `ignored:paused` | `ignored:paused` | `ignored:already_paused` | `ignored:already_paused` |

Silence never acts: no timer ever picks, confirms, sends or dials. A timeout means no.

### 4.3 Errand

| From | Event | Guard | To | Side effects |
|---|---|---|---|---|
| (new) | YES on an errand option | Errand consent for `form_key` | drafted | ErrandPreview job; Preview timer; cue `errand_preparing`; pipeline errand started. Without consent: refused (`no_consent`) |
| drafted | `agent_attach_preview` previewed | fenced; 16-hex digest; consent active | previewed | Readback timer; the station reads `read_back_text` back in the steady voice |
| drafted | `agent_attach_preview` refused | fenced | refused | cue `errand_refused` with the Actor's code |
| drafted | `agent_attach_preview` failed, `agent_fail`, Preview timer | | failed | cue `errand_failed` |
| previewed | `report_readback_done(digest)` | digest equals `preview_digest` | awaiting_confirm | `confirm_opens_at`, `confirm_closes_at`, `window_seq`, ConfirmWindow timer |
| previewed | Readback timer | still previewed | stopped (`readback_not_finished`) | cue `not_sent` |
| awaiting_confirm | CONFIRM, all checks | | confirmed | `confirmed_digest`, `confirm_gesture_id`; cue `confirmed` |
| awaiting_confirm | CONFIRM inside the quiet hold | | awaiting_confirm | the hold restarts (`window_seq += 1`, new timer) |
| awaiting_confirm | ConfirmWindow timer, same `window_seq` | | stopped (`window_closed`) | "Stopped, nothing sent", never a red timeout (`docs/ui.md`) |
| drafted, previewed, awaiting_confirm, confirmed | STOP, NO, HEADSET_OFF, lease, idle, operator, a new question, consent revoked, session end | | stopped (reason) | `stop_gesture_id` for gestures; cue `not_sent` |
| confirmed | `claim_errand(digest)` | Agent; digests match; consent active | submitting | `claim_attempt += 1`; Submit timer |
| submitting | `complete_errand` submitted or duplicate | same attempt | submitted | `confirmation_text`, `screenshot_url`; cue `errand_sent` |
| submitting | `complete_errand` refused or failed | same attempt | refused or failed | the Actor refused, for example `digest_mismatch` because the page changed |
| submitting | `complete_errand` unknown, or the Submit timer | same attempt | unknown_outcome | cue `errand_unknown`: "It may or may not have gone through." Nothing resubmits |
| unknown_outcome | `complete_errand` from the same attempt | | submitted, refused or failed | ledger `late_result` |

Terminal: submitted, refused, failed, stopped; unknown_outcome is terminal except for a late result from the same attempt.

### 4.4 Call (stretch)

| From | Event | Guard | To | Side effects |
|---|---|---|---|---|
| (new) | YES on a call option | Call consent for `contact_id`; `prepared_expires_at` not passed | prepared | the station reads `read_back_text` back. Without consent or expired: refused |
| prepared | `report_readback_done(digest)` | equals `script_digest` | awaiting_confirm | confirm window, as for errands |
| prepared | Readback timer | | stopped | |
| awaiting_confirm | CONFIRM, all checks | | confirmed | |
| awaiting_confirm | ConfirmWindow timer | | stopped (`window_closed`) | |
| prepared, awaiting_confirm, confirmed | STOP, NO, HEADSET_OFF, lease, idle, operator, a new question | | stopped | |
| confirmed | `claim_call(digest)` | Agent; consent | dialing | Lease timer; the sidecar dials at once |
| dialing | `report_call_status` ringing | fenced | ringing | `ringing_at` |
| dialing or ringing | connected | fenced | connected | `connected_at` |
| dialing, ringing or connected | ended | fenced | ended | `result`: answered, no_answer, busy, voicemail, cancelled |
| dialing, ringing or connected | failed, or the Lease timer | | failed | `result` failed or unknown; never retried |
| dialing or ringing | refused (the Dialer's re-check before the dial) | fenced | refused | the Dialer's code and sentence |
| dialing, ringing or connected | STOP, HEADSET_OFF, idle, operator | | (unchanged) | `cancel_requested` with the reason; the sidecar calls `dialer.cancelActive(reason)`, then reports ended (cancelled) |

### 4.5 Agent job

| From | Event | To |
|---|---|---|
| pending | `agent_claim` | claimed (attempt + 1, lease) |
| claimed | `agent_progress`, `agent_publish_options` with `final = false` | claimed (lease extended) |
| claimed | `agent_publish_options` with `final = true`, `agent_attach_preview`, `agent_done` | done |
| claimed | `agent_fail` | failed |
| claimed | `lease_expired`, same attempt, attempts left, still wanted | pending |
| claimed | `lease_expired`, no attempts left | failed |
| pending or claimed | its question cancelled or superseded, its errand stopped | cancelled |

Option jobs and previews are read-only and safe to rerun; a form submit is never a job (errand lease, 4.3).

---

## 5. Views

Rules (research, views doc): views are read-only; a view reads tables only through indexes (`find`, `filter`) and `count()`, never `iter()`, even though the 2.13.0 types still offer `iter()` (checked), so a mistake compiles and fails on the host; a view result with duplicate primary keys fails the transaction that triggered it; event tables cannot be read in views; row-level security is experimental, so it is not used. Every view needs `{ public: true }` (checked: `ViewOpts` requires it). A view whose row type has a primary key gets `onUpdate` callbacks in clients (research).

| View | Kind | For | Returns |
|---|---|---|---|
| `my_session` | per identity, `t.option(MySession)` | Station, Speaker | Station: the active session id, the scanned question's text, origin and answer mode; the active errand `{ errand_id, status, form_title, read_back_text, preview_digest, confirm_opens_at, confirm_closes_at, reason_code, reason }`; the active call (same fields with `contact_name`, `script_digest`); `last_gesture_id`, `last_gesture_outcome`. Speaker: only `reply = { question_id, text, tone, laugh, released_at }` for the newest Released question. Anyone else: nothing |
| `my_options` | per identity | Station | options of the scanned version and the pending version: `{ option_id, question_id, version, rank, kind, menu_item, text, tone, laugh, clip_ms, current }`, so the station can synthesize the next version early |
| `partner_view` | per identity | Partner | questions of the active session: `{ question_id, number, text, via, step, outcome, reply_text, released_at, spoken_at, asked_by_me, action, asked_at }`. `step` is the phone's step word (`heard`, `looking_up`, `reading`, `picked`, `said`, `none`, `no_pick`, `stopped`, `cancelled`, `failed`). `action` is content-free (`errand:previewed`). Never the candidate options (research decision: the partner sees progress and the reply) |
| `agent_queue` | per identity | Agent | Pending jobs plus jobs Claimed by the caller, joined with what the job needs: `{ job_id, kind, status, attempt, claimed_by_me, question_id, question_text, origin, menu_item, asked_by (hex, the Moss partner id), web_search_allowed, memory_allowed, errand_id, form_key, form_url, form_title, fields_json, reply_text, recent_errand_title, recent_errand_sent_at, created_at }`. The recent errand is the newest Submitted errand in the last 10 minutes, which the Dialer needs to prepare a call option |
| `errand_queue` | per identity | Agent | Confirmed errands plus Submitting errands claimed by the caller: `{ errand_id, status, claim_attempt, claimed_by_me, form_key, form_url, fields_json, confirmed_digest, confirmed_at }` |
| `call_queue` (stretch) | per identity | Agent | Confirmed calls plus calls claimed by the caller: `{ call_id, status, claim_attempt, claimed_by_me, request_id, contact_id, script_digest, cancel_requested, cancel_reason }` |
| `public_board` | anonymous, `t.array(BoardQuestion)` | dashboards | the last 20 questions of the active session, each with its scanned version's options nested: `{ question_id, session_id, number, origin, via, text_shared, text, answer_mode, status, outcome, version, options: [{ option_id, rank, kind, label, tone, laugh, provenance, sources, clip_ms }], picked_option_id, reply_text, released_at, spoken_at, asked_at }`. With sharing off: `text` is "Question N" (or "Menu"), `label` is "Option N", `sources` is empty, `reply_text` is empty |
| `board_payloads` | anonymous | Live data | `{ event_id, question_id, stage, payload_json }` for the last 5 questions, only while sharing is on; empty otherwise |
| `board_errands` | anonymous | Agents screen | every errand of the active session: status, `form_title`, `preview_digest`, reason code and sentence, every time column, `confirm_gesture_id`, `stop_gesture_id`, and, only while sharing is on, `read_back_text`, `read_back_json`, `confirmation_text`, `screenshot_url` |
| `board_calls` (stretch) | anonymous | Agents screen | every call of the active session: status, result, reasons, digest, times, `consent_on_file = true`, and while sharing is on `contact_name`, `read_back_text` and `transcript: [{ role, text, at }]`; with sharing off the name is "Contact" |
| `board_ledger` | anonymous, query-builder form `ctx.from.ledger` | replay, command strip, judges | every ledger row (content-free); clients filter by `session_id`. The query-builder form is evaluated incrementally (research), so a growing ledger does not recompute the whole list on each insert (checked: a view may return a `RowTypedQuery`) |

Bounding the board views (last 20 questions, last 5 questions of payloads) keeps each recompute small: an array view reruns when a row it read changes.

---

## 6. The procedure, HTTP routes and the smoke test

### 6.1 `mint_voice_token(purpose string)` returns `VoiceToken { token string, expires_at_ms u64, error string }`

- Inside `ctx.withTx`: the caller is a paired, unrevoked Station or Speaker for `tts`, or a Partner for `stt`. Otherwise `{ error: 'not_paired_for_purpose' }`.
- Outside the transaction (a procedure cannot fetch while holding one, research): build the request with `buildMintRequest(ctx.env.CARTESIA_API_KEY, purpose, 60)` from `cartesia/src/token.ts`, send it with `ctx.http.fetch(url, { method, headers, body, timeout: TimeDuration.fromMillis(5000) })`, and read it with `parseMintResponse(request, status, text, requestedAtMs)`. Return the token with `expires_at_ms`. One grant per token; the agent grant is always false (checked in `token.ts`). Errors never carry the key or the token.
- The return value goes only to the caller, never to other clients (research: procedures doc).
- The browser opens Cartesia sockets with `?cartesia_version=2026-08-14&access_token=<token>` (checked: `cartesia/README.md`). Mint a new token per socket; tokens last 60 s.
- Using the `cartesia` helpers: add `"@say-when/cartesia": "file:../cartesia"` to the module and build `cartesia` first, or copy the two pure functions into `spacetime/src/voice.ts` with a test that compares the request shape against `cartesia`'s. `cartesia/src/index.ts` says its shared exports are safe in a SpacetimeDB module, but whether `spacetime build` bundles a `file:` dependency is untested.
- `withTx` may run its body more than once, so keep it free of side effects outside the database (research).

**Fallback if smoke step S1 fails:** the station or phone calls `request_voice_token(purpose, nonce)`; the sidecar sees the request in its queue, mints with `mintAccessToken` from `@say-when/cartesia/server`, and writes the token into a private `voice_token` row that only the requester's `my_voice_token` view returns, deleted after 60 s by a one-shot timer. The browser code changes only where the token comes from. Build this only if S1 fails.

### 6.2 HTTP routes (beta, optional)

HTTP handlers are beta; routes are served at `https://maincloud.spacetimedb.com/v1/database/<db>/route/<path>` with exact-path routing, and SpacetimeDB does not authenticate the `Authorization` header on them (research). `Router` offers `get`, `post`, `put`, `delete`, `patch`, `head`, `options`, `any`, `nest`, `merge`; a handler's context has `env`, `timestamp`, `http`, `identity`, `random` and `withTx` (checked).

| Route | Purpose | Notes |
|---|---|---|
| `GET /stats` | a number any judge can check with no key | recomputed inside `withTx` from the ledger of the active session: picks, median `late_by_ms`, median pause latency, questions answered, median time from question to the first option heard, errands sent and stopped. Numbers only. Send `access-control-allow-origin: *` so the board can fetch it |
| `POST /apify/webhook` | optional database dispatch of the errand submit | below |
| `GET /ping` | smoke test only | delete after S2 |

**Optional database dispatch (build only after the core and only if S1 and S2 pass).** With `config.dispatch_mode = 'database'`, a valid CONFIRM also inserts an `errand_dispatch` row at `ScheduleAt.time(now)`. The scheduled procedure `dispatch_errand` re-checks consent, status and digest inside `withTx`, sets Submitting, starts a normal (not Standby) run of the form-errand Actor in submit mode with an ad-hoc webhook pointing at `/route/apify/webhook` (base64 JSON in the `webhooks` query parameter, a secret in `headersTemplate`), and stores the run id in `errand_run`. The route checks the secret, maps the run id to the errand and completes it; a second scheduled procedure reads the run's output for the confirmation text. The default path, the sidecar's `claim_errand`, needs none of these untested features.

### 6.3 The smoke test that decides where things run

Run on `say-when-dev` before relying on any of it. Write each result into the table and into PLAN.

| Step | What | Pass means | Fail means |
|---|---|---|---|
| S1 | owner-only procedure `smoke_fetch(url)` returns the status and elapsed ms for `https://api.cartesia.ai` and `https://api.apify.com/v2` (Appendix B has the code; time it with transaction timestamps, not `Date.now()`) | Maincloud allows outbound HTTP from procedures: `mint_voice_token` runs in the database; the key goes in the module env | the sidecar mints (6.1 fallback); the key stays on the agent laptop |
| S2 | `GET /route/ping` answers a phone browser | routes work: `/stats` is possible; the webhook route is possible | drop the routes; the checkable number becomes the anonymous `POST /v1/database/<db>/sql` with a `SELECT` on `pipeline_event` (research: anonymous SQL reads public tables) |
| S3 | the station page on the deployed (https) origin opens `ws://127.0.0.1:<port>` to the Python process, relays 20 test gestures and times each round trip over venue Ethernet | the station relay is the gesture path | serve the station page from `http://localhost` on the EEG laptop, or build `gesture_http` (7.5). Chrome may block a public https page from reaching localhost (Private Network Access); untested |
| S4 | a chain of one-shot scheduled reducers at 2.5 s steps; the phone and the board show the same `step_seq`; measure jitter | the scan clock is usable as designed | lengthen steps; raise `grace_ms` |
| S5 | 20 `heartbeat` calls a second apart; unplug the network for 3 s | `liveness_expired` pauses, and heartbeats resume it | tune `liveness_lease_ms` |
| S6 | Python `POST /call/gesture_http` 20 times with `confirmed=true` and 20 with `false` | p50 and p95 recorded for the fallback | |

Results (fill in): S1 ___ S2 ___ S3 ___ S4 jitter ___ ms S5 ___ S6 p95 ___ ms.

---

## 7. How each client talks to the module

### 7.1 The web app

- **Bindings.** Generate with `spacetime generate --no-config --lang typescript --out-dir spacetime/bindings/web --module-path spacetime` and the same with `--out-dir spacetime/bindings/agent` (checked: the 2.13.0 CLI flags). Private tables are left out of the bindings unless `--include-private`; views appear like tables (`tables.publicBoard`). The web app currently expects bindings at `web/lib/data/module_bindings` (`web/lib/data/spacetime-bindings.ts`); the web workflow either imports `spacetime/bindings/web` through a path alias or copies it after each generate. Regenerate after every schema change.
- **Connection.** One `DbConnection` per page with `withUri`, `withDatabaseName`, `withToken` (per-role key, 1.3), `withAutomaticReconnect`, then `subscriptionBuilder().onApplied(...).subscribe([...])` (checked: the builder methods in `sdk/db_connection_builder.ts`; the web's `spacetime.ts` already uses them). Reducers return a `Promise<void>` that rejects with `SenderError`, `DisconnectedError` or `UnknownCallResultError`; procedures return a promise of their value (`conn.procedures.mintVoiceToken({ purpose })`, or React's `useProcedure`) (checked).
- **Audio-critical callbacks** (`scanState.onUpdate`, `cueEvent.onInsert`) are registered once at connect, not in a React render, so the earpiece starts on receipt.
- **Staleness.** A dropped network may never fire `onDisconnect` (research: WikiWatch commit). While scanning, if `scan_state` has not changed within `step_ends_at - step_started_at` plus 1.5 s, the station stops speaking and says "Reconnecting"; the board dims and shows "Showing the last known state" (`docs/ui.md`).

What each screen subscribes to:

| Screen | Public tables | Views | Reducers and procedures |
|---|---|---|---|
| Shell (all dashboards) | `config`, `scan_state`, `device_status`, `cue_event` | | |
| Live data `/live` | `pipeline_event` | `public_board`, `board_payloads` | |
| Agents `/agents` | | `board_errands`, `board_calls`, `board_ledger` | |
| Conversation `/conversation` | | `public_board`, `board_ledger` (gesture rows for the command strip) | |
| Judge `/judge` | `pipeline_event` | `public_board`, `board_ledger`; the `/stats` link or the SQL command | |
| Partner `/partner` | `scan_state`, `pipeline_event`, `device_status`, `cue_event` | `partner_view` | `ask_question`, `cancel_question`, `partner_listening`, `operator_pause`; caregiver: `set_board_sharing`, `grant_consent`; `mint_voice_token('stt')` |
| Station `/station` | `config`, `scan_state`, `cue_event` | `my_session`, `my_options` | `start_session`, `end_session`, `gesture`, `heartbeat`, `report_clip_ready`, `report_readback_done`; `mint_voice_token('tts')` |
| Speaker `/speaker` | `cue_event` | `my_session` | `reply_spoken`, `operator_pause`; `mint_voice_token('tts')` |

**Mapping onto `web/lib/data/types.ts` (`DataRows`):**

| `DataRows` field | Source | Notes |
|---|---|---|
| `questions` | `public_board` | `text` is null when `text_shared` is false (the screen shows "Question N"); `askedAt` from `asked_at.toMillis()` |
| `pipelineEvents` | `pipeline_event` merged with `board_payloads` by `event_id` | `detail` (the web's object) = `{ ...counts_json, ...payload_json }`, with the label from `pipeline_event.detail`; `ms`, `at` |
| `options` | `public_board[].options` | `text` = `label`; `tone` empty becomes null; `kind` adds `menu` |
| `errands` | `board_errands` | status map: drafted to `preparing`; previewed to `previewed` (the read-back is playing, `reading_back`); awaiting_confirm; confirmed and submitting to `submitting`; submitted to `sent`; stopped, refused, failed; unknown_outcome needs a new web value |
| `calls` | `board_calls` | `contactName` only; never a number |
| `commands` | `board_ledger` rows with `kind = 'gesture'` | `id` = `gesture_id`; `accepted` = outcome starts with `accepted`; `ignoredReason` = `reason`; `confidence` null |
| `scan` | `scan_state` plus the scanned question in `public_board` | `cursor` 0 becomes null; `phase` reading or window, plus the new phases; `spokenReply` = `reply_text`; `spokenAt` |
| `safety` | `scan_state.pause_reason` and the station's `device_status` | `headset_off` for HeadsetOff; `paused` for Stop, Idle, Operator and HeadsetLost; `ok` otherwise |

Changes the web types need (the web workflow owns them): `CommandName` becomes `YES`, `NO`, `CONFIRM`, `STOP`, `HEADSET_OFF` (D11; `docs/ui.md` already shows these four chips); `ScanPhase` adds `idle`, `preparing`, `veto`, `paused`, plus a `mode` (answer or menu) and `answerMode`; `OptionKind` adds `menu`; `ErrandStatus` adds `confirmed` and `unknown_outcome`; `CallStatus` adds `awaiting_confirm` and `confirmed`; `Question` adds `origin`.

### 7.2 The station page

1. Pair once as Station; then `start_session('demo')` when the wearer is ready, and send the first heartbeat as soon as that call resolves (the first lease is already counting).
2. Open `ws://127.0.0.1:<port>` to the Python decoder. Messages (proposal for Shashank, PLAN row 2.1): `{ "type": "gesture", "id": "<uuid>", "command": "YES", "onsetAgeMs": 840, "confidence": 0.82, "source": "imagery" }` and `{ "type": "health", "decoderHealthy": true }` at least every 250 ms. The keyboard and a USB switch produce the same messages with `source: "key"` or `"switch"`, labelled on screen.
3. Keep a short local log of `(step_seq, option_id, local receipt time)` from each `scan_state` update. For a gesture, `onset = now - onsetAgeMs`; `heard_step_seq` and `heard_option_id` are the latest entry received before the onset.
4. Play a local click at once, then call `gesture(...)`. For CONFIRM, pass `heard_digest` = the digest of the read-back it played (`my_session.errand.preview_digest`).
5. Heartbeat every `heartbeat_ms` with the decoder's health; a health gap over 0.5 s means `decoderHealthy: false`, and a removed headset also sends `HEADSET_OFF`.
6. Synthesize each option of `my_options` one at a time (Free allows 2 TTS contexts, research), in the reply voice with its tone and the pronunciation dictionary, measure it and call `report_clip_ready`. Skip this in yes_no mode: the earpiece plays only the stock prompt, and the Speaker says the chosen reply. Start the cached clip when `scan_state` enters Reading with a new `step_seq`; stop audio on any other phase.
7. When `my_session.errand.status` becomes Previewed, read `read_back_text` in the steady assistant voice (`<spell>` for codes), then call `report_readback_done('errand', id, digest)`; the same for calls.
8. Keep the tab in the foreground, ideally playing audio: Chrome throttles timers in background tabs, which would starve heartbeats (untested; run a 30-minute soak test).

### 7.3 The partner phone and the speaker

- Partner: hold to talk; Ink-2 with a `stt` token streams only while held; on the turn end call `ask_question(uuid, text, 'voice', listen_ms)`. A retry after a dropped socket reuses the same `request_id`. Typed questions use `via: 'typed'`. Show the step list and the reply from `partner_view`; show "Paused. Please wait." from `scan_state`.
- Speaker: when `my_session.reply` appears, synthesize it in the reply voice with its tone (and `[laughter]` if `laugh`), play it aloud, then `reply_spoken(question_id, ms)`.

### 7.4 The agent sidecar's job loop

1. Connect as Agent with `.agent-token` and `withAutomaticReconnect`; subscribe to `agent_queue`, `errand_queue` and `call_queue`. Run one sidecar per database (research: the official sidecar guide); the lease makes a second one safe anyway.
2. On a Pending job: `await agentClaim({ jobId })`. A `SenderError` means another agent has it. Success means the attempt is the Pending row's `attempt + 1`, and the row reappears as Claimed by you.
3. Options job: Moss memory first. If two or more memory options clear the score floor, publish them with `final: false`. If the question needs outside facts (D8) and `web_search_allowed`, run Apify, chunk into Moss, ask Claude for up to four options with tones and sources, and publish with `final: true`. Report each stage with `agent_progress`, which also extends the lease. Menu-origin questions pick the prompt by `menu_item` (Need: needs; Request: errand options for allowlisted forms; Call: call options prepared with `dialer.prepare` for consented contacts and the recent errand; Say: things to say).
4. ErrandPreview job: `FormErrandClient.preview({ formUrl, fields })`, then `agent_attach_preview` with the Actor's result (never the screenshot bytes).
5. Remember job: write the spoken reply into Moss with its partner id (`asked_by`), `shareable` only if the person agreed; then `agent_done`.
6. `errand_queue` shows a Confirmed errand: `claim_errand(id, confirmed_digest)`, then `FormErrandClient.submit({ formUrl, fields, confirm: true, confirmDigest })` once, then `complete_errand(id, attempt, ...)`. An `UnknownOutcomeError` from the client is reported as `unknown`. Never resubmit; the module's row says what happened.
7. Calls: `claim_call`, `dialer.place(requestId, digest)` at once, `report_call_status` from the Dialer's `onUpdate`, `add_call_line` for transcript lines, and `dialer.cancelActive(reason)` when `cancel_requested` appears.
8. Any fenced call that throws `SenderError('stale attempt')`: drop that work. A `DisconnectedError` or `UnknownCallResultError`: retry the same call after reconnect; every agent write is idempotent.

### 7.5 The Python process over HTTP (fallback only)

On the main path Python never calls SpacetimeDB. If S3 fails, Python calls reducers directly (research, checked against the 2.13.0 HTTP route by the integration lane):

- Token: `POST https://maincloud.spacetimedb.com/v1/identity` once, store the token (chmod 600). Pair with `POST .../call/request_pairing` body `[482913, "station", "headset process"]`; Stephen approves.
- Call: `POST https://maincloud.spacetimedb.com/v1/database/say-when-dev/call/gesture_http` with `Content-Type: application/json`, `Authorization: Bearer <token>`, body `["<uuid>", "YES", 840, 0.82, "imagery"]` (arguments in order). One `httpx.Client` with keep-alive, connect timeout 1 s, read 2 s.
- Outcomes: 200 with an empty body committed; 530 the module refused (`SenderError`), never retry; 400 bad arguments; 402 out of energy; 404 unknown database or reducer; 504 durability timed out with the outcome unknown, so retry with the same `gesture_id` (safe). Since 2.13, `confirmed` defaults to true and success waits for durability with a 5-second deadline; measure `?confirmed=false` too.
- Keep HTTP arguments to strings, small integers, floats and booleans: SATS-JSON numbers lose precision above 2^53.
- Every HTTP call runs `client_connected` and `client_disconnected` around it; the module ignores both for Station devices.

---

## 8. The niche features (D12), and where each one lives

| D12 feature | Tables | Reducers and views | Line a judge can check |
|---|---|---|---|
| 1. One clock for every screen | `scan_state` (public), `scan_timer` (schedule) | `scan_tick`, `report_clip_ready` (dwell from the measured clip), `gesture` (`heard_step_seq`, `grace_ms`, `late_by_ms`) | "Every screen, the earpiece and your phone follow one scan cursor that lives in SpacetimeDB: a chain of one-shot scheduled reducers. The YES lands on the option the person heard: picked [N], heard at step [S], accepted [M] ms after the server moved on, read from the ledger." |
| 2. Dead-man interlock | `liveness_lease`, `idle_timer` (schedules), `device_status` | `heartbeat`, `liveness_expired`, `idle_pause`, `pause`, `voidPending`, `resume` | "Unplug the headset: SpacetimeDB itself pauses every screen [X] s after the last heartbeat, measured on server clocks, voids anything waiting for a confirm, and resumes on the same option." |
| 3. Consent is a row | `consent`, `errand`, `call_request`, `ledger` | `gesture` (the seven checks), `report_readback_done`, `claim_errand`, `complete_errand`, `errand_timeout` | "A form is released only by a CONFIRM row that matches the digest the person heard; the agent can claim only that confirmed row, and a lapsed lease becomes unknown, never a resubmit." (see 10.1 item 14 for what this does and does not enforce) |
| 4. Roles in reducers, privacy in views | `device`, `pairing_request`, `config.share_text_on_board` | `request_pairing`, `approve_pairing`, the role guard in every reducer; `my_session`, `my_options`, `partner_view`, `agent_queue`, `errand_queue`, `public_board`, `board_*` | "Each device has one role checked in every reducer: the phone sees progress and the reply, the station sees the candidates, and the room toggle switches the public board between text and Option N." |
| 5. Short credentialed hops | env `CARTESIA_API_KEY`; optional `errand_dispatch`, `errand_run` | `mint_voice_token`; optional `dispatch_errand`, `/apify/webhook`, `/stats` | "A procedure mints each paired browser a 60-second Cartesia token, so the key stays in the database's environment." (only after S1 passes) |
| 6. Public pipeline table and event table | `pipeline_event` (public), `pipeline_payload`, `cue_event` (event table) | `agent_progress`, `ask_question`, `board_payloads` | "Any laptop opens the dashboard with no login and watches Apify, Moss, Claude and Cartesia work, live, from one public table." |
| Agent coordination (supports D12) | `agent_job`, `job_lease` | `agent_claim`, the fenced `agent_*` writes, `lease_expired` | "The agent claims work with a lease and an attempt number, so a stalled agent's late write is refused." |
| Tests (supports D12) | | the module test harness (9.1) | "`npm test` in `spacetime/` proves the clock, grace window, refractory, fresh confirm, digest refusal, fencing and pause rules with no server." |

Bracketed numbers are measured on site and read from the ledger before anyone says them.

**Do not claim:** commitlog "time travel" (no user-facing API); row-level security (experimental); MCP as the product path (unstable); horizontal scaling or async calls between databases (dated Oct 31); "open source" (BSL 1.1); that memory text lives in SpacetimeDB (only text the person marked shareable, and only in private rows); procedure HTTP or routes on Maincloud before S1 and S2 pass (all research).

---

## 9. Tests, publishing and operations

### 9.1 Module tests

Vitest with the 2.12+ harness: `spacetimedb/server/test-utils` (`createModuleTestHarness(schema, moduleExports)`, `test.clock.set` and `advance`, `withReducerTx(auth, ctx => ...)`, `TestAuth.internal()`, `TestAuth.fromJwtPayload(payload, connectionId)`, `viewContext`, `anonymousViewContext`, `procedureContextBuilder(auth).http(responder)`) and `spacetimedbModuleTestPlugin()` from `spacetimedb/server/test-utils/vitest` in `vitest.config.ts` (checked: `test-utils/index.ts`; Scrabblebot's `src/tests/harness.ts` uses the same calls). Node 22. Timers never fire in the harness, so a test reads the inserted schedule row and calls the scheduled reducer itself as `internal`. The harness drops event-table rows at commit (checked: `commitTx(tx, 'DropEventTableRows')`), so assert cues inside the same `withReducerTx` body or not at all. Views are plain functions: `myOptions(test.viewContext(auth))`.

| Area | Tests |
|---|---|
| Clock | publish plus clips gives Reading at cursor 1 with a StepEnd row at `clip_ms + audio_pad_ms`; the tick gives Window, then cursor 2; a stale `step_seq` row does nothing; the last window of the last pass ends NoPick with nothing said; a pending version switches in at the end of the pass |
| Grace window | YES for the previous option within `grace_ms` picks it with `late_by_ms`; after `grace_ms` it is `ignored:stale_step`; a mismatched `heard_option_id` is `ignored:heard_mismatch`; a NO for a passed option is `ignored:already_passed` |
| Refractory | YES then NO inside `refractory_ms`: the second is ignored; STOP inside it still works |
| Fresh confirm | CONFIRM before the read-back is done, inside the quiet hold (and the hold restarts), after the window, without contact, while paused, or reusing a gesture id: all ignored; a valid one confirms once and a second is ignored |
| Digest refusal | CONFIRM with the wrong `heard_digest`; `report_readback_done` with the wrong digest; `claim_errand` with the wrong digest or before Confirmed |
| Lease fencing | claim gives attempt 1; `lease_expired` requeues; a second claim gives attempt 2; publishing with attempt 1 throws; the submit lease lapsing gives UnknownOutcome and nothing can claim it again; a late `complete_errand` from the same attempt records the true result |
| Liveness pause | a heartbeat then 1.4 s of clock leaves the scan running; `liveness_expired` pauses with the latency in the ledger and stops a waiting errand; healthy beats for `resume_good_contact_ms` resume the same option with a new `step_seq`; a stale lease row after a newer heartbeat does nothing |
| Idle menu | YES while idle opens the menu (four Menu options, Preparing); with `menu_enabled` off it is ignored; YES while Preparing is `ignored:not_ready`; YES during an errand read-back is `ignored:yes_is_not_confirm`; picking "Send a request" makes a Menu-origin question and an Options job |
| Veto and yes_no | YES on a reply goes to Veto; STOP there says nothing; VetoEnd releases the reply and `my_session` shows it to the Speaker; in yes_no mode YES picks rank 1 and NO rank 2 |
| Pauses | STOP while idle pauses (Stop) and only YES or the owner resumes; HEADSET_OFF voids everything; `idle_pause` with a Connected call re-arms instead |
| Roles and views | every client reducer refuses the wrong role; scheduled reducers refuse a client caller; `my_options` is empty for a Partner; `partner_view` never contains option text; `public_board` shows "Option N" with sharing off and text with it on; `board_payloads` is empty with sharing off; turning sharing on without BoardText consent fails |
| Procedure | `mint_voice_token` with a test HTTP responder: wrong role returns an error without calling out; the request carries one grant and a 60 s expiry |

Add a `spacetime` job to `.github/workflows/ci.yml` that runs `npm ci`, the typecheck and `npm test` in `spacetime/`.

### 9.2 Layout

```
spacetime.json            { "server": "maincloud", "module-path": "./spacetime" }
spacetime.local.json      { "database": "say-when-dev" }   (gitignored; Scrabblebot uses this pair)
spacetime/
  package.json            "spacetimedb": "2.13.0" exact; vitest, typescript, @types/node as dev dependencies
  tsconfig.json
  vitest.config.ts        spacetimedbModuleTestPlugin()
  src/schema.ts           enums, tables, env declarations
  src/index.ts            default export plus every reducer, view, procedure and router, and nothing else
  src/*.ts                clock, safety, errand, call, agent, views, util helpers
  src/tests/              harness.ts and *.test.ts
  bindings/web/           generated, never edited
  bindings/agent/         generated, never edited
```

`index.ts` may export only module exports (reducers, views, procedures, HTTP handlers and routers) plus the default schema. Any other exported value, such as a constant or a helper, makes the module throw "exporting something that is not a spacetime export" at load (checked: `registerModuleExports` in `server/schema.ts`). Type exports are fine. Keep helpers in other files, as Scrabblebot does.

Add to `.gitignore`: `spacetime.local.json` and `.agent-token` (the existing `.token-*` pattern does not match it). `node_modules/` and `spacetime/**/dist/` are already ignored. Commit the generated bindings so the web app and the agent build without the CLI.

### 9.3 Environment variables

Declared in `schema(tables, { env: { ... } })` with `t.string().optional()`, so a teammate can publish a dev database without secrets (checked: `.optional()` makes a declaration optional in `server/environment.ts`; limits: 256 keys, 8 KiB per value, names `[A-Za-z_][A-Za-z0-9_]*`). Read as `ctx.env.NAME` in reducers, procedures, views and handlers.

| Variable | Needed for | Default path |
|---|---|---|
| `CARTESIA_API_KEY` | `mint_voice_token` | set only if S1 passes |
| `APIFY_TOKEN`, `APIFY_FORM_ACTOR`, `APIFY_WEBHOOK_SECRET`, `PUBLIC_DB_URL` | optional database dispatch | unset |

Publishing keeps env values you do not pass; declared shell variables override config values, including empty strings; `--env-only` updates values without uploading the module; `--unset-env KEY` removes one (checked: CLI 2.13.0 help). `--delete-data` wipes env values too (research).

### 9.4 Publishing and operations

Every command passes the database, the module path and the server explicitly with `--no-config`, because with a `spacetime.json` present a positional database name that the config does not list is an error (research: the `spacetime.json` doc). Run each with `nice -n 15`, one at a time.

| When | Command |
|---|---|
| Dev loop | `spacetime publish say-when-dev --no-config --module-path spacetime --server maincloud`, then `spacetime call say-when-dev ensure_timers`. Only on a breaking schema change and only on the dev database: add `--delete-data=on-conflict` (the value attached with `=`) |
| Dev with the key (after S1) | read the key from Keychain into `CARTESIA_API_KEY` in the shell, check `${#CARTESIA_API_KEY}` is not 0, then run the same publish command in that shell; the CLI prints key names, not values |
| Rotate a key | the same with `--env-only` |
| Bindings | `spacetime generate --no-config --lang typescript --out-dir spacetime/bindings/web --module-path spacetime` and the same for `spacetime/bindings/agent` |
| Pair a device | `spacetime call say-when-dev approve_pairing 482913 false` |
| Consent | `spacetime call say-when-dev grant_consent errand care_team_request owner_cli "demo form, Leon owns it"`; `web_search`, `memory` and `board_text` take an empty subject (`""`); `call` takes the contact id as its subject (`leon`) |
| Timing | `spacetime call say-when-dev set_timing '{"response_window_ms":4000}'` |
| Watch | `spacetime logs say-when-dev -f`; `spacetime sql say-when-dev "SELECT * FROM scan_state"`; `spacetime describe say-when-dev`; `spacetime env list say-when-dev` (`call`, `sql`, `describe` are marked unstable in the CLI) |
| Schema freeze, Sat 8 PM | Stephen publishes `say-when-demo` with the same `--no-config` command (the name must match `^[a-z0-9]+(-[a-z0-9]+)*$`; choose another if taken), runs `ensure_timers`, pairs the demo devices, grants consent, then `spacetime lock say-when-demo` (lock only blocks deletion, checked) |
| Judging, Sun 10:30 AM to 12:30 PM | no publish to `say-when-demo`: a publish hot-swaps the module but "clients may witness brief interruptions in scheduled reducers" (research) |
| After the event | `purge_session` for any real person's sessions |

Schema-freeze rules after the first demo publish (research, automatic migrations doc):
- Safe: add tables, indexes and reducers; make a private table public.
- Allowed with care: add a column only at the end of a table and only with `.default(...)`; append enum variants at the end.
- Forbidden: remove a non-empty table; change or reorder columns; add a unique or primary-key constraint; change whether a table is a schedule table or an event table; rename an index accessor.
- `init` runs only when a database is created (or cleared); run `ensure_timers` after every publish.
- A misspelled table option compiles without an error (checked: `evnt: true` passed the typecheck), so read every `event: true` and `public: true` twice.

Energy: heartbeats twice a second are about 7,200 calls an hour, a few percent of the free monthly allowance over the weekend, and Stephen's event credits sit on top (research; the credits are a secondary note). Arm heartbeats only while a session is active.

---

## 10. Decisions, open questions and what was checked

### 10.1 Decisions this plan makes

1. **The command reducer is `gesture`, not `record_gesture(command, confidence, window_id)`.** The station, not Python, calls it, with the step it heard (research decision 2.6: the station relay). Commands are the uppercase D11 strings.
2. **`menu` is a scan mode, not a separate phase.** The menu is read with the same reading and window steps as answers, so one engine serves both. The phases are idle, preparing, reading, window, veto, paused; **preparing** was added so a YES that arrives while options are being drafted cannot open the menu.
3. **YesNo answer mode.** A yes or no question is one prompt: YES says the yes reply, NO says the no reply (D11's "one thought"). Claude decides the mode when it publishes.
4. **What NO and STOP mean in each state** (4.2). NO during a read-back or confirm wait means "do not send". YES is never a confirm. STOP cancels whatever is pending and, when nothing is, pauses.
5. **Signal pauses resume on their own** (`auto_resume`, default on) after `resume_good_contact_ms` of healthy heartbeats, re-reading the same option; voided confirms stay void. The commands lane suggested 5 s of good contact plus a fresh select; set `auto_resume` off and `resume_good_contact_ms` to 5000 for that behavior. Deliberate pauses (STOP, idle, operator) need a YES or the owner.
6. **`grace_ms` starts at 1000**, not 700, because imagined movement decodes more slowly than a jaw clench; tune it to the decoder's measured latency.
7. **`pipeline_event` stays public and content-free; content moves to the private `pipeline_payload`** and reaches the board only through `board_payloads` while sharing is on. Board sharing itself needs a BoardText consent row.
8. **An errand is created when the person picks it,** from the fields Claude put in the option, and previewed then (lazy preview). A call option is prepared by the Dialer when Claude offers it, because the Dialer must build the read-back and digest; the call row is created on the pick.
9. **No phone number ever enters SpacetimeDB.** Call consent is a `consent` row per `contact_id`; the Dialer re-checks its own consent and do-not-call lists before dialing (two independent checks).
10. **A new partner question supersedes the current scan** and stops any errand or call that has not been claimed; a question that arrives during a veto or a pause waits.
11. **Idle auto-pause has its own schedule table** (`idle_timer`), and calls have `call_timer`, because a schedule table binds exactly one reducer. That makes seven schedule tables, not five.
12. **The agent learns its attempt as the Pending row's attempt plus one**, so it needs no extra view.
13. **A late true result after `unknown_outcome` is recorded** if it comes from the same attempt; nothing ever resubmits.
14. **What the database enforces, and what it trusts.** The module decides when an errand or call may go (Confirmed, digest match, one claim, lease). It cannot stop a process that holds the Apify token from calling the Actor on its own, so the guarantee rests on our sidecar having one submit path, after a successful `claim_errand`, with the Actor re-checking the digest against the live page. The optional database dispatch (6.2) closes that gap by moving the submit, and the token, into the module. Likewise the station is trusted to relay only what the decoder sent. Say "the agent can only claim a confirmed row", not "the database sends the form", unless 6.2 is built.
15. **Bindings live in `spacetime/bindings/web` and `spacetime/bindings/agent`;** the web workflow decides whether to import or copy them.
16. **`config` is public** (no secrets, no content), so the station and anonymous views read timing and the toggle directly.
17. **Names follow D13:** NeuroLingo in prose; `say-when-dev` and `say-when-demo` for databases.

### 10.2 Open questions

- PLAN Q9 (YES while idle opens the menu): built as `config.menu_enabled`, default on.
- PLAN Q10 (no way to CONFIRM without the jaw): not built; future work.
- The station page route name and where the station page is served (S3).
- Who owns the decoder-to-station message format (proposed in 7.2; PLAN row 2.1 is Shashank's).
- Whether teammates need collaborator access to `say-when-demo` (how to add them was not read).
- The Spacetime Best Use entry route and judges (no Devpost row at the last check, research).

### 10.3 What was checked tonight, and what was not

Checked tonight:
- A scratch module with every table in section 2 and the patterns in Appendix B compiled against the `spacetimedb` 2.13.0 types (`tsc` exit 0). A second run with four planted errors failed with exit 2, so the check does bite; it also showed a misspelled table option is not caught.
- In the 2.13.0 source: `TableOpts`, `ViewOpts`, the reducer, view, procedure and HTTP-handler signatures, `ReducerCtx`, `ProcedureCtx` and `HandlerContext` members, `ScheduleAt.time` and `interval`, `isInternal` being false on a real host, env declarations, `registerModuleExports`, the test harness, the client builder, reducer promises, error classes and procedure calls.
- CLI 2.13.0 help for `generate`, `publish` (env behavior), `lock`.
- This repo: `apify/client` and `apify/form-errand` types (digest, statuses, refusal codes, `UnknownOutcomeError`), `cartesia/src/token.ts` and `call.ts` (Dialer, `PreparedCall`, cancel reasons, the 30 s confirm-to-dial limit), `moss/README.md` (shareable memory), `web/lib/data/types.ts` and `spacetime.ts`, `docs/ui.md` gaps 1 to 9.

Not checked, from the research lanes: one-shot schedule semantics and out-of-order dispatch, event-table semantics, the view `iter()` rule, migration rules, `init` and republish behavior, HTTP `/call` status codes and lifecycle wrapping, confirmed reads and the 504 unknown outcome, procedure `withTx` rules, HTTP handler routing and authentication, anonymous SQL.

Untested anywhere: everything on Maincloud (procedure HTTP, routes, timer jitter, durability latency), the station's localhost socket from an https page, Chrome background throttling, `spacetime build` with a `file:` dependency, nested arrays in view rows at runtime (they compile), and every number in the timing table on a real wearer.

---

## Appendix A: Shared Contracts for PLAN row 1.2

Paste over the Shared Contracts table in `PLAN.md`. Names are wire names (snake_case); TypeScript bindings use camelCase. Changing any row follows Coordination Protocol rule 10.

| Contract | Owner | Consumers | Definition |
|---|---|---|---|
| Decoder event (localhost) | Shashank | station (Stephen) | Python sends `{ type: "gesture", id, command, onsetAgeMs, confidence, source }` and `{ type: "health", decoderHealthy }` (at least every 250 ms) over `ws://127.0.0.1:<port>` to the station page. `command` is `YES`, `NO`, `CONFIRM`, `STOP` or `HEADSET_OFF` (D11); `source` is `imagery`, `jaw`, `key` or `switch`; `id` is a UUID that is also Tiger's `selection_events` key. Python never calls SpacetimeDB on the main path. |
| Gesture reducer | Stephen | station | `gesture(gesture_id, command, heard_step_seq, heard_option_id, heard_digest, confidence, source, onset_age_ms)`, from the session's Station only. Idempotent on `gesture_id`. A refused command is recorded, not thrown: `gesture_log.outcome` is `accepted:<action>` or `ignored:<reason>`. What each command does in each state: `docs/spacetime.md` 4.2. Replaces the draft `record_gesture`. Fallback `gesture_http(gesture_id, command, age_ms, confidence, source)` only if the station relay fails the smoke test. |
| Scan clock | Stephen | station, web, partner | Public `scan_state`, one row per session, ids only: `phase` (idle, preparing, reading, window, veto, paused), `mode` (answer, menu), `answer_mode` (pick, yes_no), `cursor` (1-based rank, 0 none), `option_count`, `pass`, `max_passes`, `step_seq`, `step_started_at`, `step_ends_at`, `option_start_seq`, `option_started_at`, `outcome` (picked, none, no_pick, stopped, cancelled), `picked_option_id`, `pause_reason` (headset_lost, headset_off, stop, idle, operator). Moved only by reducers and the scheduled `scan_tick`. Countdowns are drawn from the duration, not from clock differences. |
| Question and reply | Stephen | partner, station, speaker, agent | `ask_question(request_id, text, via, listen_ms)` from a Partner; `request_id` (UUID) makes retries safe; `via` is `voice` or `typed`. Private `question` with `status`, `reply_text`, `released_at`, `spoken_at`. The Speaker reads the released reply from `my_session` and calls `reply_spoken(question_id, ms)`. `cancel_question(question_id)`. |
| Option row | Stephen (written by Shashank's planner) | station, web, agent | Private `answer_option { id, question_id, version, rank, kind, menu_item, text, tone, laugh, provenance, sources, memory_refs, action_json, clip_ms }`. `kind` is `reply`, `errand`, `call` or `menu` (menu rows are made by the module). `sources` is a list of `{ source, url?, place_id?, fetched_at }`. Written only by `agent_publish_options(job_id, attempt, answer_mode, options, final)`: 1 to 4 options, or exactly 2 for `yes_no` with rank 1 the yes. Errand `action_json`: `{ formKey, formUrl, formTitle, fields }`; call `action_json`: the Dialer's `PreparedCall`. The station reads `my_options`; the board reads `public_board`. |
| Pipeline event | Stephen | web, agent | Public, content-free `pipeline_event { id, event_key, session_id, question_id, stage, status, detail, ms, counts_json, actor, at }`. `stage`: listen, search, retrieve, plan, speak, select, errand, call. `status`: started, ok, error. `detail`: the producers' short fixed-vocabulary label. `counts_json`: numbers and booleans only. Content goes to the private `pipeline_payload { event_id, payload_json }` and reaches the board only through `board_payloads` while sharing is on. Memory text appears only as `sharedText` for memories the person marked shareable. The agent writes through `agent_progress(job_id, attempt, event_key, stage, status, detail, ms, counts_json, payload_json)`. |
| Agent job | Stephen | agent sidecar (Shashank, Stephen) | Private `agent_job { kind: options, errand_preview or remember; status: pending, claimed, done, failed, cancelled; attempt }`. The sidecar reads `agent_queue`, calls `agent_claim(job_id)` (its attempt is the pending row's attempt + 1; 45 s lease), then `agent_progress`, `agent_publish_options`, `agent_attach_preview`, `agent_fail` or `agent_done`, each with `(job_id, attempt)`. A lapsed lease requeues the job (at most 3 attempts); a write from an old attempt fails with `SenderError`. |
| Errand row | Stephen | agent, web, station | Private `errand` with `status` drafted, previewed, awaiting_confirm, confirmed, submitting, submitted, refused, failed, unknown_outcome, stopped; `form_key`, `form_title`, `preview_digest` (16 hex), `read_back_text`, `read_back_json`, `screenshot_url`, `confirmation_text`, `reason_code`, `reason`, `confirm_opens_at`, `confirm_closes_at`, `confirm_gesture_id`, `stop_gesture_id`. Made when the person picks an errand option. The station reads it back and calls `report_readback_done('errand', id, digest)`. CONFIRM counts only after the read-back and the quiet hold, inside the window, with the digest the station played, once. Then `claim_errand(errand_id, digest)` and `complete_errand(errand_id, attempt, status, confirmation_text, screenshot_url, reason_code, reason, submit_ms)`. A lapsed submit lease means unknown_outcome; nothing resubmits. The web reads `board_errands`. |
| Call request | Stephen | agent, web, station | Private `call_request` (stretch) with `status` prepared, awaiting_confirm, confirmed, dialing, ringing, connected, ended, failed, stopped, refused; `request_id`, `contact_id`, `contact_name`, `read_back_text`, `script_digest`, `result`, `reason`, `cancel_requested`, `cancel_reason`. Built from the Dialer's `prepare()`; no phone number in SpacetimeDB. Consent is a `consent` row per `contact_id`, and the Dialer re-checks its private consent and do-not-call lists. One call per confirm, retries off. `claim_call(call_id, digest)`, `report_call_status(call_id, attempt, status, result, end_reason, reason_code, reason)`, `add_call_line(call_id, attempt, line_key, role, text)`. STOP, HEADSET_OFF and idle set `cancel_requested`. The web reads `board_calls`. |
| Devices, pairing and consent | Stephen | every client | Roles: Station, Partner, Speaker, Agent. `request_pairing(code, role, label)` with `role` as `station`, `partner`, `speaker` or `agent`; the owner runs `spacetime call <db> approve_pairing <code> <caregiver>`. Each browser keeps its token under `<host>/<db>/auth_token/<role>`. Public `device_status { identity, role, label, online, last_seen_at, decoder_healthy }`. Consent rows: `grant_consent(scope, subject, method, note)` with scope `web_search`, `memory`, `errand`, `call` or `board_text`; owner or a caregiver phone. |
| Voice token | Stephen | station, speaker, partner | Procedure `mint_voice_token(purpose)` returns `{ token, expires_at_ms, error }`: `tts` for Station and Speaker, `stt` for Partner, 60 s, one grant, built with `buildMintRequest` and read with `parseMintResponse` from `cartesia/src/token.ts`. If the smoke test shows no outbound HTTP from procedures on Maincloud, the sidecar mints instead and the return shape stays the same. |
| Board and privacy toggle | Stephen | web | Dashboards are anonymous. Public tables: `config`, `scan_state`, `pipeline_event`, `device_status`, event table `cue_event`. Anonymous views: `public_board` (questions with options nested), `board_payloads`, `board_errands`, `board_calls`, `board_ledger`. Text shows only while `config.share_text_on_board` is true, which needs a `board_text` consent row; `set_board_sharing(on)` by the owner or a caregiver phone. |
| Cue event | Stephen | station, web | Public event table `cue_event { session_id, kind, reason, question_id, option_id, errand_id, call_id, rank, at }`, never stored, `onInsert` only. Kinds are listed in `docs/spacetime.md` 2.9; `reason` is a code, never text. |
| Search client | Stephen | agent | `searchWeb(question)` and `searchPlaces(query, near)` return `{ rows, ms }`. Each row is `{ id, source, title, text, url or placeId, fetchedAt }`. See `apify/client/README.md`. |
| Form-errand Actor | Stephen | agent | Standby `POST /preview { formUrl, fields }` returns `{ status, readBack, readBackText, previewDigest, screenshot }`. `POST /submit { formUrl, fields, confirmDigest }` returns `{ status, confirmationText }`. See `apify/form-errand/README.md`. |
| Moss docs | Stephen | agent | One index per session. Doc `{ id, text, metadata }`, metadata values are strings: `source`, `url` or `placeId`, `fetchedAt`, `questionId`. |

---

## Appendix B: Code patterns checked against spacetimedb 2.13.0

Excerpts of a scratch module compiled tonight with `tsc` against the 2.13.0 types (`/* ... */` marks parts left out here); none of it has run on a server. Copy the shapes, not the names.

**Schema pieces.**

```ts
import { schema, t, table } from 'spacetimedb/server';

export const Phase = t.enum('Phase', ['Idle', 'Preparing', 'Reading', 'Window', 'Veto', 'Paused']);
export const SourceRef = t.object('SourceRef', {
  source: t.string(), url: t.option(t.string()), placeId: t.option(t.string()), fetchedAt: t.string(),
});

// A schedule table: one-shot rows, each carrying its fence.
export const scanTimer = table({}, t.row('ScanTimer', {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
  sessionId: t.u64().index('btree'),
  stepSeq: t.u64(),
  kind: t.enum('ScanTimerKind', ['StepEnd', 'VetoEnd', 'ClipDeadline']),
}));

// A public event table: broadcast on commit, never stored.
export const cueEvent = table({ public: true, event: true }, t.row('CueEvent', {
  sessionId: t.u64(), kind: t.string(), reason: t.string(), questionId: t.u64(),
  optionId: t.u64(), errandId: t.u64(), callId: t.u64(), rank: t.u8(), at: t.timestamp(),
}));

// A multi-column index, queried as optionByQv.filter([questionId, version]).
export const answerOption = table(
  { indexes: [{ accessor: 'optionByQv', algorithm: 'btree', columns: ['questionId', 'version'] }] },
  t.row('AnswerOption', { id: t.u64().primaryKey().autoInc(), questionId: t.u64(), version: t.u32(),
    rank: t.u8(), text: t.string(), sources: t.array(SourceRef), clipMs: t.option(t.u32()) /* ... */ }),
);

const spacetimedb = schema({ /* every table */ scanTimer, cueEvent, answerOption },
  { env: { CARTESIA_API_KEY: t.string().optional() } });
export default spacetimedb;
```

**A scheduled reducer with the scheduler guard and the step fence, and the next step.**

```ts
import { Identity, ScheduleAt, TimeDuration, Timestamp } from 'spacetimedb'; // ScheduleAt from 'spacetimedb', not 'spacetimedb/server'
import { SenderError, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
// requireRole and requireOwner as in 3.1

const plusMs = (ts: Timestamp, ms: number) => new Timestamp(ts.microsSinceUnixEpoch + BigInt(ms) * 1000n);
function requireScheduler(ctx: Ctx) {
  if (!ctx.sender.isEqual(ctx.databaseIdentity)) throw new SenderError('scheduler only');
}

export const scanTick = spacetimedb.reducer({ onSchedule: scanTimer }, { job: scanTimer.rowType }, (ctx, { job }) => {
  requireScheduler(ctx);
  const s = ctx.db.scanState.sessionId.find(job.sessionId);
  if (!s || s.stepSeq !== job.stepSeq) return; // stale tick
  // ... decide the next phase, then:
  for (const r of [...ctx.db.scanTimer.sessionId.filter(s.sessionId)]) ctx.db.scanTimer.scheduledId.delete(r.scheduledId);
  const next = { ...s, phase: { tag: 'Window' as const }, stepSeq: s.stepSeq + 1n,
    stepStartedAt: ctx.timestamp, stepEndsAt: plusMs(ctx.timestamp, 3500), updatedAt: ctx.timestamp };
  ctx.db.scanState.sessionId.update(next);
  ctx.db.scanTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(next.stepEndsAt.microsSinceUnixEpoch),
    sessionId: s.sessionId, stepSeq: next.stepSeq, kind: { tag: 'StepEnd' } });
});
```

**A fenced agent write, and the lease that fences it.**

```ts
export const agentClaim = spacetimedb.reducer({ jobId: t.u64() }, (ctx, { jobId }) => {
  requireRole(ctx, 'Agent');
  const job = ctx.db.agentJob.id.find(jobId);
  if (!job || job.status.tag !== 'Pending') throw new SenderError('not pending');
  const attempt = job.attempt + 1;
  const ends = plusMs(ctx.timestamp, ctx.db.config.id.find(0)!.jobLeaseMs);
  ctx.db.agentJob.id.update({ ...job, status: { tag: 'Claimed' }, attempt, claimedBy: ctx.sender,
    leaseExpiresAt: ends, updatedAt: ctx.timestamp });
  ctx.db.jobLease.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(ends.microsSinceUnixEpoch), jobId, attempt });
});

export const leaseExpired = spacetimedb.reducer({ onSchedule: jobLease }, { job: jobLease.rowType }, (ctx, { job }) => {
  requireScheduler(ctx);
  const row = ctx.db.agentJob.id.find(job.jobId);
  if (!row || row.status.tag !== 'Claimed' || row.attempt !== job.attempt) return; // fenced
  ctx.db.agentJob.id.update({ ...row, status: { tag: 'Pending' }, claimedBy: Identity.zero(),
    leaseExpiresAt: undefined, updatedAt: ctx.timestamp });
});
```

**Views: per identity, anonymous with the privacy toggle, and the query-builder form.**

```ts
export const myOptions = spacetimedb.view({ public: true }, t.array(MyOption), (ctx) => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.revoked || d.role.tag !== 'Station') return [];
  const cfg = ctx.db.config.id.find(0);
  const s = cfg && ctx.db.scanState.sessionId.find(cfg.activeSessionId);
  if (!s || s.questionId === 0n) return [];
  return [...ctx.db.answerOption.optionByQv.filter([s.questionId, s.version])].map((o) => ({ /* fields */ }));
});

export const publicBoard = spacetimedb.anonymousView({ public: true }, t.array(BoardQuestion), (ctx) => {
  const cfg = ctx.db.config.id.find(0);
  if (!cfg || cfg.activeSessionId === 0n) return [];
  const share = cfg.shareTextOnBoard;
  return [...ctx.db.question.questionBySession.filter(cfg.activeSessionId)].map((q) => ({
    questionId: q.id, number: q.number, textShared: share, text: share ? q.text : `Question ${q.number}`,
    /* options nested with label: share ? o.text : `Option ${o.rank}` */
  }));
});

export const boardLedger = spacetimedb.anonymousView({ public: true }, t.array(ledger.rowType), (ctx) => ctx.from.ledger);
```

**The procedure, and the owner-only smoke probe.**

```ts
const VoiceToken = t.object('VoiceToken', { token: t.string(), expiresAtMs: t.u64(), error: t.string() });

export const mintVoiceToken = spacetimedb.procedure({ purpose: t.string() }, VoiceToken, (ctx, { purpose }) => {
  const allowed = ctx.withTx((tx) => {
    const d = tx.db.device.identity.find(tx.sender);
    if (!d || d.revoked) return false;
    return purpose === 'stt' ? d.role.tag === 'Partner' : d.role.tag === 'Station' || d.role.tag === 'Speaker';
  });
  if (!allowed) return { token: '', expiresAtMs: 0n, error: 'not_paired_for_purpose' };
  const key = ctx.env.CARTESIA_API_KEY;
  if (!key) return { token: '', expiresAtMs: 0n, error: 'voice_key_missing' };
  // Build with buildMintRequest(key, purpose, 60) and read with parseMintResponse from cartesia/src/token.ts:
  const res = ctx.http.fetch('https://api.cartesia.ai/access-token', { method: 'POST', headers: { /* ... */ },
    body: '/* ... */', timeout: TimeDuration.fromMillis(5000) });
  /* ... */
});

export const smokeFetch = spacetimedb.procedure({ url: t.string() }, SmokeResult, (ctx, { url }) => {
  const isOwner = ctx.withTx((tx) => { const c = tx.db.config.id.find(0); return !!c && c.owner.isEqual(tx.sender); });
  if (!isOwner) return { status: 0, ms: 0, error: 'owner only' };
  const elapsedMs = () => ctx.withTx((tx) => tx.timestamp).since(ctx.timestamp).millis;
  try {
    const r = ctx.http.fetch(url, { method: 'GET', timeout: TimeDuration.fromMillis(5000) });
    return { status: r.status, ms: elapsedMs(), error: '' };
  } catch (e) {
    return { status: 0, ms: elapsedMs(), error: String(e) };
  }
});
```

**An HTTP route.**

```ts
import { Router, SyncResponse } from 'spacetimedb/server';

export const stats = spacetimedb.httpHandler((ctx, _req) => {
  const picks = ctx.withTx((tx) => tx.db.gestureLog.count());
  return new SyncResponse(JSON.stringify({ picks: Number(picks) }), {
    status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
});
export const routes = spacetimedb.httpRouter(new Router().get('/stats', stats));
```
