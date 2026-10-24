# NeuroLingo agent sidecar

The sidecar is the backend worker behind NeuroLingo. It drafts the options the person hears (PLAN row 3.4), previews and sends form errands (row 4.2), and places consented calls. It runs on a laptop that is not the EEG laptop, connects to the SpacetimeDB module as the Agent role, and never acts on its own: a form or a call leaves the room only after the module records a fresh CONFIRM (double jaw clench) on the exact read-back the person heard (PLAN D4, D11).

Stephen's side owns the backend, this sidecar included (PLAN D14). Shashank owns the headset and the decoder in `switch/`, which reach the backend only through the SpacetimeDB contract in [docs/spacetime.md](../docs/spacetime.md). The product is NeuroLingo; code identifiers keep `say-when` (PLAN D13), so the package is `@say-when/agent`.

Nothing here reads thoughts. The jaw clench is a muscle signal; the imagined squeezes are the brain test in `docs/brain-mode-test.md`.

## What it does

The sidecar watches three views of the module and reacts to them (docs/spacetime.md 7.4). It also reads two public views: `device_status`, to tell whether it is paired, and `board_calls`, for the time of a call's CONFIRM.

**Options job** (`agent_queue`, kind Options), for a partner question or a menu item the person picked:

1. **Memory first.** Moss recalls the person's own past replies to this partner and their preferences, locally, in milliseconds.
2. **Search only when needed (D8).** `classifyQuestion` decides on the laptop whether the question needs outside facts. "Are you tired?" never waits on a search. Menu turns never search.
3. **Search.** RAG Web Browser, or the Google Maps Scraper near the venue for place questions when `AGENT_PLACES_NEAR` is set. The search has its own deadline (20 s by default) so it stays inside the module's 45 s job lease, and the client does not retry: the question is sent once, right after the sidecar read the web search consent. While it runs, the person's own past replies are published as early options (when at least two clear the score floor and the question does not read like yes or no).
4. **Retrieve.** The rows are chunked into the Moss web index for this question, the passages that match come back, and they are deleted once the question is answered. If Moss is closed, the planner reads the top rows directly. Every Moss call has its own deadline (recall 3 s, index 10 s, search 3 s, rank 3 s, write-back 5 s, forget 5 s), so a stuck call degrades that step instead of holding the job.
5. **Plan.** Claude writes up to four short options in the person's voice, each with its own tone, its kind (reply, errand or call) and the sources it used. A yes or no question gets exactly two (yes first). The reply is checked strictly (see "The planner").
6. **Publish.** Options are ordered by memory affinity (moss `rankOptions`; yes or no answers keep their order) and written with `agent_publish_options`.

**Errand preview job** (kind ErrandPreview, made when the person says YES to an errand option): the form-errand Actor fills the form and reads every value back off the page. The read-back text and the 16-character digest go to the errand row with `agent_attach_preview`. Nothing is sent.

**Errand submit** (`errand_queue`): when the module shows an errand Confirmed, the sidecar checks that the confirmed digest, form address and fields are exactly the ones it previewed. Then `claim_errand`, one submit, and `complete_errand`. A digest it did not preview is refused (claimed, then completed as `refused` with `digest_mismatch`, nothing sent). An errand this sidecar never previewed is left alone. A submit whose outcome is unclear is recorded as `unknown`, which the module shows as "It may have been sent. Check before trying again." A submit is never retried. A claim is tried again only when it provably never reached the module (the connection was down for every try), at most three rounds; a claim that may have landed is never sent again.

**Calls** (`call_queue`, stretch): a call option is prepared by the Cartesia Dialer when the planner offers it, so the read-back and digest exist at the pick. When the module shows the call Confirmed, the sidecar claims it and calls `dialer.place` (the Dialer re-checks consent, the do-not-call list and calling hours). Ringing, connected, transcript lines (numbers already masked) and the end are reported in order. STOP, HEADSET_OFF, the idle pause or an operator set `cancel_requested`, and the sidecar hangs up (or never dials). One call at a time: when `claim_call` answers `line busy` (another call is live), the call waits for the next change to the views and is claimed again then, when the freshness checks decide whether it may still be placed. A call whose dial lease lapsed in the module is hung up too: it stays in `call_queue` as Failed with `cancel_requested`, because it may still be on the line. When the Dialer puts the contact on hold (`held`: a possible refusal was heard, the end is unknown, or its hold file could not be written), the final report carries the Dialer's sentence ("Calls to <name> are on hold until someone checks.") in `reason`, with `opt_out_hold` or `hold_file_error` for a call that otherwise ended normally. One CONFIRM, one call.

A call must follow its CONFIRM closely. The Dialer starts its own 30 s window when `place` is called, so that window cannot see a slow sidecar or a view update that arrived late. Right before the dial, after the claim, the sidecar checks two clocks and dials only if both say the CONFIRM is recent:

1. The module's clock: the CONFIRM's time from the public `board_calls` view (`call_queue` does not carry it) must be at most 12 s old by the laptop's clock. If it is unknown, or more than 5 s in the future (the two clocks disagree), the call is refused with `confirm_time_unknown`.
2. The sidecar's own clock: at most 10 s since it first saw the call Confirmed. A Confirmed call that was already there when the views were loaded (startup or a reconnect) is of unknown age.

A call that fails either check is claimed and reported refused (`confirm_expired`, "Too much time passed after you confirmed, so I did not call. Ask again if you still want the call."), and never dialed. Claims are tried again by the same rule as errands.

A placed call is watched too. After `place` the Dialer still checks its Cartesia agent and voice (requests with 10 s and 15 s timeouts) before it dials, and its own 30 s window starts at `place`. If the Dialer has not dialed (no call id yet) by 30 s after the CONFIRM, less the 5 s allowed for clock difference, the sidecar cancels the call; the Dialer's last check before its outbound request then stops it, and the person hears the same `confirm_expired` sentence (with the Dialer's hold sentence when it put the contact on hold). A test reads the Dialer's 30 s window from `cartesia/src/call.ts`.

**Remember job**: the reply that was said aloud is written into Moss for that partner, so the next question already knows it.

**Leases.** A job that leaves the sidecar while it runs (cancelled, superseded, or requeued after its lease lapsed) is aborted, and the module refuses anything it still writes as a stale attempt. A job that does not stop within 5 s gives up its slot, so the requeued job can be claimed again at once. If a claim lands at a later attempt than the sidecar computed (another claim and a lapsed lease came first), the sidecar uses the attempt the module shows, also when the claim's reply was lost and the view had to be read to find out. Every `agent_progress` renews the lease, also one the module already has, so a step that waits on something slow (a planner retry, a search, a form preview) sends its own `started` event again every 10 s while it is open: no new rows, and the lease does not run out under work that is still going.

## Run it

You need:

- Node 22.
- `apify/client`, `moss` and `cartesia` built (`npm run build` in each): this package depends on their `dist/` through `file:` links.
- The module's generated bindings in `spacetime/bindings/agent`, and `npm ci` done in `spacetime/` (the bindings import `spacetimedb` from there). Generate them with `spacetime generate --no-config --lang typescript --out-dir spacetime/bindings/agent --module-path spacetime`.
- An Agent identity paired with the database, and the module's consent rows for web search, memory and each errand form (docs/spacetime.md 9.4).

In `agent/`:

```bash
npm ci
npm run check    # every setting by name, set or not, and whether the bindings are there. Never prints a value.
npm run pair     # once per database: prints the approve_pairing command for the owner, then waits for it
npm start        # runs the sidecar. Ctrl-C stops it cleanly; a second Ctrl-C exits at once.
```

`npm start` loads `agent/.env.local`, then the repo's `.env.local`, without overriding variables already set (`AGENT_ENV_FILES=off` skips both). It stops before connecting if a setting is malformed or there are no Anthropic credentials, and says which variable to fix.

## Settings

Names only; `.env.example` lists them all. Never commit real values.

| Variable | Needed for | Default or effect when missing |
|---|---|---|
| `SPACETIMEDB_URI` | the module | `https://maincloud.spacetimedb.com` |
| `SPACETIMEDB_DB` | the module | `say-when-dev` |
| `AGENT_TOKEN_FILE` | the sidecar's identity | `agent/.agent-token` (written with mode 600 by `npm run pair`, gitignored); its folder must exist, and a token that cannot be saved stops the start |
| `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` | the planner | or an `ant auth login` profile; without any, the sidecar does not start |
| `AGENT_PLANNER_MODEL` | the planner | `claude-haiku-5-5` |
| `AGENT_PLANNER_EFFORT` | the planner | `low` (`low`, `medium` or `high`) |
| `AGENT_PLANNER_TIMEOUT_MS` | the planner | 15000 per attempt |
| `APIFY_TOKEN` | search and errands | no web search and no errands |
| `FORM_ERRAND_URL` | errands | no errands |
| `RAG_WEB_BROWSER_URL` | search | the public RAG Web Browser |
| `AGENT_SEARCH_TIMEOUT_MS` | search | 20000 |
| `AGENT_PLACES_NEAR` | place search, as `lat,lng` | place questions use the web search |
| `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY`, `MOSS_SNAPSHOT_DIR` | memory | no memory |
| `AGENT_MOSS` | memory on or off | on when the three Moss settings are present |
| `AGENT_MOSS_REOPEN` | reopen Moss after its idle close | off (Moss bills session minutes; see moss/README.md) |
| `AGENT_MEMORY_SHAREABLE` | mark written-back replies shareable | off; turn on only if the person agreed their replies may show on screens |
| `AGENT_FORMS_FILE` | errand options | no errand options; see `forms.example.json` |
| `AGENT_CALLS` | calls | off |
| `CARTESIA_API_KEY`, `CARTESIA_AGENT_ID`, `CARTESIA_FROM_NUMBER_ID`, `CALL_CONSENT_FILE`, `CALL_DO_NOT_CALL_FILE`, `CALL_HOLD_FILE`, `CALL_CALLBACK_NUMBER`, `CALL_PERSON_NAME`, `CALL_ERRAND_TITLES` | calls | see cartesia/README.md; `CALL_HOLD_FILE` is where the Dialer keeps holds on contacts, and calls do not start without it |
| `AGENT_TIME_ZONE` | the date and times in the planner prompt | `America/Los_Angeles` |
| `AGENT_MAX_JOBS` | jobs at once | 3 |
| `AGENT_MAX_OPTIONS` | options per question | 4 |

Each errand form also needs an Errand consent row in the module for its `formKey`, and each call contact a Call consent row for its id; the module refuses the pick otherwise.

## What it writes where

| Reducer | Table | Who can see it | What goes in |
|---|---|---|---|
| `agent_claim` | `agent_job` | private | the claim; the attempt is the Pending row's attempt + 1 |
| `agent_progress` | `pipeline_event` | public | stage, status, a label from a fixed vocabulary, the time in ms, numbers only (rows, hits, tokens, options) |
| `agent_progress` | `pipeline_payload` | private; on the board only while the room shares text | search rows (300-character excerpts with phone numbers, keys and tokens masked, no place phone), Moss hits (memory: id, category, score, saved time, and `sharedText` only for a shared memory), the classify reason |
| `agent_publish_options` | `answer_option` | private | option text, tone, kind, provenance, web and place sources, memory ids, the errand or call action |
| `agent_attach_preview` | `errand` | private | the read-back text and values, the digest, the screenshot URL, a refusal code and sentence |
| `complete_errand` | `errand` | private | the confirmation text, or a refusal or unknown code and sentence |
| `report_call_status`, `add_call_line` | `call_request`, `call_line` | private | status, result, end reason; transcript lines with numbers masked |
| `agent_fail`, `agent_done` | `agent_job` | private | a reason code and a sentence for the person; counts |

## Privacy rules it enforces

- Public events never carry the question, option text, memory text, form values, read-back text, names, phone numbers or URLs: only fixed labels, durations and numbers.
- Page text (in payloads and in the planner prompt) has phone numbers (seven digits or more, in any script, with any spaces, characters with the Unicode Dash property or invisible separators), keys and tokens masked; opening hours, prices and street numbers stay, because the planner needs them. This is a different rule from the Cartesia package's, which masks every number in call transcripts.
- Memory text never reaches SpacetimeDB, an event, a log or a screen. A memory the person marked shareable appears only as `sharedText`; any other shows as "Private memory".
- Memory text and the conversation go to the Anthropic API inside the planner prompt, and only when the job has memory consent. They never go into a search query: Apify gets the partner's question, or a short place word such as "pharmacy".
- Consent can be revoked while a job runs: the module then clears the job's web search or memory flag, and cancels a Remember job. The sidecar reads the flags again right before each use, after every wait that comes first (the recall, the search, the early memory options, each planner attempt including a retry, the memory hits shown beside the web hits, the memory ranking, the write into memory), so nothing goes out on a consent that was just withdrawn. A plan that relied on memory, the conversation, web passages or a memory ranking whose consent was withdrawn on the way (while Claude wrote it, while the ranking ran, while the plan step's event was written, or between publish tries) is not published: it is written again without them, three rounds at most. The check fails closed: while the connection is down or the subscription is being applied again, a revocation could be missing from the views, so neither consent holds; and a job attempt that is no longer this sidecar's (a later attempt took it) sends neither. An aborted Remember attempt writes nothing and leaves the job to the next attempt; a Remember job that was taken away (aborted, or cancelled, which is how a memory revocation shows) also forgets the kept conversation.
- The conversation with each partner (the last turns, used as planner context) is kept and sent only under memory consent. Whenever a job sees memory consent withdrawn (at the start or at any later check), every kept turn is forgotten.
- Read-back values go only to the errand row. Call transcripts arrive masked from the Dialer and go only to `call_line`. Phone numbers never leave the Dialer.
- The terminal log has fixed messages with ids, codes, counts and times.
- Startup checks print each setting's name and whether it is set, never its value. When the sidecar cannot start, it prints only messages written to be shown (its own, and the sibling packages' configuration errors, which name settings and positions); any other error is reported by its code or name, because Node's messages quote file paths and JSON errors quote pieces of the file.

`test/privacy.test.ts` runs a question, an errand and a call seeded with marker strings, then the failure paths with content in every error message, body and reason a service could send back, and checks each rule. The checks ignore case and punctuation (the way `label()` reshapes text), catch a secret by any of its distinctive words, and accept only the fixed label vocabulary and the known count keys. Negative controls show each check catches a reshaped or partial leak.

## The planner

- **Model:** `claude-haiku-5-5`, the current fast model, because the person is waiting with the headset on. `AGENT_PLANNER_MODEL` overrides it (for example `claude-opus-5-5`).
- **Call:** the Anthropic TypeScript SDK (`@anthropic-ai/sdk` 0.137.0, the last 0.x; 1.x moves to API version 2026-10-21, which this code has not been checked against), `client.beta.messages.create` with `output_config.format` built from a zod schema (structured output), `output_config.effort` (`low` by default), and the model's default adaptive thinking. No sampling parameters. The fixed system prompt is marked for caching; everything that varies is in the user message.
- **Stop reason first:** a refusal or a cut-off reply is its own error, read before the reply is parsed.
- **Fallback:** for `claude-opus-5-5`, `claude-opus-5`, `claude-fable-5-1` and `claude-sonnet-5-5` the request opts into the server-side refusal fallback (`fallbacks: "default"`). Claude Haiku 5.5 has none, so a refusal there fails the job.
- **Retries:** the SDK's own retries are off. One attempt plus at most one retry on a timeout, a network error, a 5xx, a 529 or a 429 with a short Retry-After. Everything else fails at once with a clear code (`planner_<code>` in `agent_fail`; the person hears "I could not write options. Please ask again.").
- **Strict checks** (`src/planner/validate.ts`): 1 to 4 options for a pick, exactly two replies for yes or no with yes first; distinct tones from neutral, calm, warm, sad, firm; at most one laugh; no duplicate text, no markup, at most 200 characters; every cited source was in the prompt; at least one reply (an errand or a call is never the only option); an errand only for an allowed form, with known field labels, valid choices and every required field (fixed values such as who it is from are filled by the sidecar); a call only to a consented contact while a request sent less than eight minutes ago can still be reported. Any broken rule fails the reply with the rule names, never its text.

## Swapping pieces

Everything outside the sidecar sits behind a small interface in `src/ports.ts` (search, memory, web index, form errands, Dialer, planner) and `src/db/db.ts` (the module). `src/wiring.ts` builds the real ones; the tests pass fakes. `MemoryDb` (`src/db/memory-db.ts`) applies the module's rules for the agent reducers, for tests and offline runs.

Every SpacetimeDB name the sidecar uses is in `src/contract.ts`. The bindings load at run time from `spacetime/bindings/agent` (`src/db/bindings.ts`), because the generated files use extensionless imports that run under tsx but do not type-check under this package's NodeNext settings. `npm run typecheck` also compiles `typecheck/bindings.check.ts` against them: it fails if the generated connection stops fitting the adapter, a reducer stops taking the sidecar's arguments, or a view row or an enum changes. `test/contract.test.ts` checks the same names against docs/spacetime.md, the module source and the generated files. After every `spacetime generate`, run `npm run typecheck` and `npm test` here.

## Tests

```bash
npm run typecheck
npm test
```

The tests use fakes for Claude, Apify, Moss, the form-errand Actor, the Dialer and the module, and make no network calls. They cover the option shape and count, the yes or no path, the no-search path (D8), memory before search, the early memory options, place search, source limits, a failed or slow search, Moss closed, a Moss call that never answers, planner retries and stop reasons, every validation rule, the errand preview, the full errand path, a digest mismatch refusal, an unknown outcome, the never-resend rule, the call path with STOP and HEADSET_OFF, the hang-up of a call whose dial lease lapsed, a call that ended with the contact on hold, the dial deadline after a CONFIRM (and a call left alone once it dialed), consent revoked in the middle of a job and while each step starts (the recall, the search, the early options, the plan, a planner retry, the memory write; with a control), the conversation forgotten without memory consent and when consent is withdrawn mid-job, a plan written again after a withdrawal during the request, a ranking ignored after a withdrawal, consent failing closed while disconnected, a replaced Remember attempt, the web search sent once, consent withdrawn during the ranking and while the plan step finishes (memory and web), a Remember job cancelled by a revocation (also while its write is under way), a call waiting for the line (also when the views change while that claim is out), no dial when the connection drops after the claim, the call freshness rules (startup, reconnect, a slow claim, a view update that arrived late, an unknown CONFIRM time, clocks that disagree, and calls just inside each window), claims tried again only when they never reached the module, stale attempts and cancelled jobs, a job cancelled before any other change reached the orchestrator, the job lease kept by a slow step (and lost without the renewal, as a control), a job that will not stop after it is aborted, a claim that lands at a later attempt (also with its reply lost), a Moss failure that arrives after its job was aborted, lost replies on claims and writes, privacy on the happy and failure paths, the page text masking (phone numbers masked, facts kept), what a startup failure prints, a token that cannot be saved, timing fields, the startup checks, and the contract against the doc, the module source and the bindings (including `board_calls`).

## What is verified, and what is not

Verified, offline: everything in the test list above; the type check against the generated bindings and the spacetimedb 2.13.0 types; that the safety tests fail when the digest check is skipped, when memory text leaks into a payload, when a submit is sent twice, when the call freshness check or the reload rule is removed, when a claim is retried after a refusal or never retried, when the retry cap is removed, when the claimed attempt is ignored, when a stuck job keeps its slot, when the Moss recall deadline is removed, when an error body reaches a label, when an error message reaches the log, when the module's CONFIRM time, its unknown case or the clock check is dropped, when an outside error message is printed at startup, when a late failure after an abort is left unhandled, when a freshly claimed job is not watched for cancellation, when a slow step stops renewing the lease or renews it with new rows, when a token that cannot be saved escapes as a raw error, when the CONFIRM age limit no longer fits the Dialer's window, when the token folder check is dropped, when a consent revoked mid-job is not read again before the search, the planner prompt or the memory write, when a hold is dropped from the call report, when page text keeps phone numbers or loses every number, when consent is not read again after a step starts or before a planner retry, when the conversation is kept without memory consent, when the dial deadline is dropped or cancels a call that already dialed, when the web search retries inside the client, when consent is read from a stale cache or without the attempt, when a plan made with withdrawn memory is kept, when a ranking is used after a withdrawal, when a withdrawal does not forget the conversation, when page text masking handles only ASCII digits, when a late cancel drops the hold sentence, when consent is not read again after the ranking or the plan step's event, when a cancelled Remember job keeps the conversation, when the dash class misses a Unicode dash, when `line busy` is treated as final or a look owed to a waiting call is dropped, when a Remember job cancelled during its write keeps the conversation, or when a call is placed on stale views (each mutation was tried and caught, and the file restored byte for byte). The `board_calls` type checks were also shown to fail on a wrong field type and on a missing field.

Not verified, because no keys were used to build this: no request has gone from this package to Anthropic, Apify, Moss, Cartesia or SpacetimeDB. Untested anywhere: subscribing to the views with `SELECT * FROM agent_queue` on Maincloud, reconnects, real latency, the quality of Haiku 5.5's options at low effort, and the timing table on a real wearer. Make one real question, one errand and one call on `say-when-dev` before the demo.

Open review items. Seven rounds of an outside review (Codex, read-only) ran on this package; the last round's findings were fixed except where noted, and these remain:

- A placed call whose connection to the module drops after `place` and before the Dialer dials: a STOP or a revocation during that outage does not reach the sidecar until the connection is back. The dial deadline still bounds it. A cancel of undialed calls when the connection drops would close it.
- A write into memory that is already under way when memory consent is revoked completes (Moss calls cannot be cancelled), so that one reply may be stored. The kept conversation is forgotten.
- Revoking memory consent and giving it again with no job running in between leaves the in-process conversation in place: the module shows the revocation only through the flags of jobs that exist at that moment. A memory consent state the agent can read (a flag or an epoch in a view) would close it.
- The module drops `reason` for ended calls, so the hold sentence of a call that went through is lost (see Known limits).
- The end-to-end bound from CONFIRM to dial needs the Dialer to take the CONFIRM time (see Known limits).

## Known limits

- The digests this sidecar previewed are kept in memory. After a restart, an errand that was previewed before the restart and confirmed after it is left alone (the next question, a pause or the end of the session stops it).
- A sidecar that dies during a submit or a call leaves it to the module's leases: the submit becomes unknown_outcome, the call failed with result unknown. Nothing is resent.
- The module keeps `reason` and `reason_code` only for failed and refused calls. A call that went through but left the contact on hold (a possible refusal was heard) is reported with the hold sentence, and the module drops it, so the dashboard cannot say it yet. Keeping `reason` for ended calls in `report_call_status`, or a `held` flag there, would fix that.
- Run one sidecar per identity. Two processes sharing `.agent-token` look like one agent to the module.
- The module writes its own `plan ok` event when options are published; the sidecar writes one too, with the Claude time and token counts.
- Conversation history (the last turns with each partner) lives in process memory, only under memory consent, and is lost on restart.
- A call is placed only while the views are current; if the connection is down at the moment of the dial, the call is refused (`disconnected`, "I lost the connection, so I did not call. Ask again if you still want the call."), and the report lands once the connection is back.
- The call freshness check compares the module's CONFIRM time with the laptop's clock, so it is only as good as the two clocks' agreement (both normally keep network time; a gap of more than 5 s refuses calls). The check is the sidecar's alone: the module's `claim_call` does not refuse an old CONFIRM, and the Dialer measures its own window from `place`. The end-to-end fix is in those two places: `confirmed_at` in the `call_queue` view with an expiry enforced in `claim_call`, and a Dialer whose `place` takes the CONFIRM time and checks it right before the outbound request. Until then the sidecar's own deadline cancels a call that has not dialed in time; a cancel that lands while the Dialer's outbound request is already on its way cannot stop that request, and the Dialer then hangs up as soon as it has the call id, so the phone may ring briefly. Errands have no such window: a confirmed errand is submitted when its claim lands, and one confirmed before a restart is left alone (see the first limit).
