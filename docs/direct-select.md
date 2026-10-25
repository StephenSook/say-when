# Direct select (D18, D23): three gestures pick three options

Status: live on `main` and the `say-when-direct` database since Sat Oct 24 2026, about 11:20 PM (PLAN D23), from Shashank's design (Discord 8:19 PM and 8:23 PM) with the jaw rules of D21. The scan mode and the `say-when-demo` database stay as the fallback (decoder `--mode scan`, the previous site build in Vercel).

## 1. What the person does

| Gesture (decoder) | Command word | Meaning |
|---|---|---|
| Imagined LEFT fist | `PICK_1` | choose option 1 |
| Imagined RIGHT fist | `PICK_2` | choose option 2 |
| Single jaw clench | `PICK_3` | choose option 3 |
| Double jaw clench | none | nothing (D21): still detected, so two quick clenches are never two picks |
| Held jaw clench (0.8 s or more) | `STOP` | cancel whatever is pending, hang up a call, pause |
| Headset off | `HEADSET_OFF` | same as today: cancel and pause |

There is no scanning cursor. The earpiece reads the (up to) three options once, numbered and short ("One: yes. Two: no. Three: search the web."), then waits. The person picks any time after the list starts. Silence picks nothing. A STOP or a new question clears the list. The partner's question is not read first: the station's "Read the partner's question in the earpiece" setting is off by default since Oct 25 (docs/station.md 2.9).

## 2. When a pick needs a confirm (Shashank, 8:23 PM)

Confirmation only for:
- **errands / messages** (the form-errand request), after the read-back;
- **calls**, after the read-back;
- **starting an internet search** (the "search the web" option).

The confirm is a fresh two-option choice spoken after the read-back: "One: send it. Two: cancel." (`PICK_1` = confirm, `PICK_2` = cancel; silence until the confirm window ends = cancel; STOP = cancel). It keeps every existing confirm rule: it starts only after the read-back ends, lands inside the confirm window, matches the read-back digest, and is used once.

Every other pick acts at once with no confirm: a reply is said out loud in the room right away; a category or a place pick moves straight on.

## 3. The conversation flows

1. **Small talk** ("Hey, how are you?"). Claude drafts four options, each with a 1 to 3 word `label` (read in the earpiece) and a full `text` (what the room voice says): e.g. 1 "Good" -> "I'm doing awesome, how about you?", 2 "Not great" -> ..., 3 and 4 other tones. No web search. A pick is spoken in the room at once.
2. **A question that may need outside facts** ("Anything you want to do today in San Francisco?"). Options: 1 yes-style reply, 2 no-style reply, 3 **Search the web** (kind `Search`), 4 something else. Picking 3 asks for the confirm ("Search the web for ideas? One: yes. Two: cancel."). On confirm, the earpiece offers **categories** (kind `Category`, no confirm): e.g. 1 Nature, 2 Fun, 3 Thrill, 4 Something else (the agent may tailor them to the question). Picking a category runs the Apify search (Google Maps near `AGENT_PLACES_NEAR` for places, RAG web otherwise), stores the results the usual way (SpacetimeDB rows plus the per-question Moss index), and offers four places as replies ("Palace of Fine Arts"). A place pick is spoken in the room at once ("Let's go to the Palace of Fine Arts!").
3. **A request** ("Can we send the care team a request for a ride to the aquarium at 1?"). Options include the errand (kind `Errand`, label e.g. "Send request") plus reply options. Picking the errand runs the existing preview and read-back, then the two-option confirm. Sent, as today.
4. **Letting the caregiver know** ("We should let Stephen know the request was sent?"). Options such as 1 "Call Stephen" (kind `Call`), 2 "Message" (only if a message path exists; otherwise a reply), 3 "Yes, agree" (reply), 4 "No need" (reply). The call runs the existing read-back, then the two-option confirm, then dials as today (consent list, 9 AM to 9 PM, AI disclosure, hangs up after goodbye).
5. **Stretch, only if everything above works:** when the call ends, the recipient's last reply (from the call transcript) becomes a follow-up prompt and the person gets four short options to say in the room.

Options are always short: the earpiece label is 1 to 3 words; the spoken text is one short sentence.

**Since D24 (Oct 25, section 4.4):** a list has at most three options (D23), and option 3 is always **Search the web** for a partner question the planner answers (small talk and flow 4 included), while web search consent is on: reply, reply (or the errand or the call), Search the web. When the partner says "do you know", the search runs at once and the replies come from its results.

**Since D28 (Oct 25, section 4.6):** when the partner asks to "call <name>" or "check in with <name>" for a consented contact, the call is option 1 even with no request sent: Call <name>, a reply, Search the web.

## 4. Interfaces (the contract between the three build tracks)

- **Database:** a NEW Maincloud database `say-when-direct`, published from this branch. No migration from `say-when-demo` is needed, so schema changes are free here. Owner = this Mac's spacetime CLI login.
- **Module (spacetime/):**
  - `OptionKind` adds `Search` and `Category`. `answer_option` adds `label: string` (short earpiece text; empty means use `text`).
  - Config/session gets an input mode `Direct` (default `Direct` on this database; keep the scan code path for `Scan`).
  - New gesture handling: the existing `gesture` reducer accepts the command words above. Add `Pick` (with a `rank: u8` 1..4) to the `Command` enum, or add a separate `pick` reducer; the module track decides and documents it here. **Decided (track 1, section 4.1):** no new reducer; `Command` adds four unit variants `Pick1`..`Pick4` (wire `PICK_1`..`PICK_4`), the rank being the variant's number. A pick is valid only while a list is live for the current question (after the first option clip started), for an existing rank; otherwise it is logged and ignored with a reason, like today's ignored gestures.
  - Pick handling by kind: `Reply` -> spoken now (existing reply path). `Category` -> creates the search job for that category (no confirm). `Search`, `Errand`, `Call` -> existing preview/read-back -> confirm phase where `PICK_1` = CONFIRM and `PICK_2` = cancel.
  - Scan clock in Direct mode: read every option clip once in rank order (no per-option response window, no passes), then wait for a pick until `idle_pause_ms`.
  - Everything else unchanged: roles, pairing, consent gate, dead-man heartbeat pause, idle pause, ledger, public pipeline rows, stats.
- **Agent sidecar (agent/):** the planner returns, per option, `label` (1 to 3 words) and `text` (one short sentence), and a kind. It offers `Search` only when the question could use outside facts; small talk never searches (superseded by D24, section 4.4: `Search` is always option 3, and "do you know" searches at once). A `Category` follow-up job is answered with up to four category options (no web call); a category pick triggers the search and returns places as `Reply` options with sources. Errand and call options work as today. Never put words in the person's mouth beyond short drafts; the person always picks.
- **Decoder (eeg-data/) and station (web/):** the decoder maps the gestures in section 1 to the command words on ws://127.0.0.1:8765 (keep `HEADSET_OFF` and health messages). The station accepts `PICK_1`..`PICK_4` and `STOP`, sends them to the module, and keeps the keyboard fallback (keys 1, 2, 3, 4 and S). The earpiece reads labels with their numbers. The screens (/replies, /agents, /conversation, /station, /brain) show the numbered options and the gesture legend from one source of truth (web/lib/commands.ts). The /brain screen labels the left fist as "1" and the right fist as "2", and the jaw lane as "3 (single) / 4 (double)".

### 4.1 The module as built (track 1, Sat Oct 24 2026, branch `direct-select-module`)

Published to `say-when-direct` (identity `c200a165db1a8df2e44dd28b9a0e58f96fb23c73d21570c1e3487e0e4ba609a0`) at about 8:45 PM PDT with no `CARTESIA_API_KEY`; `ensure_timers` ran clean; `config.input_mode` reads `direct`. Republished about 9:01 PM PDT from `1f40ccd` (the review fixes below; an empty migration plan, no schema change), `ensure_timers` clean again. Module tests: 233 passing (189 before, 44 new in `spacetime/src/tests/direct.test.ts`); the CI floor is now 233. A Codex adversarial pass on the diff found four defects (an Options job could search before any confirm, a pause left an unclaimed search turn claimable, a Category pick did not check contact, follow-up request ids could collide with a partner's). The last three are fixed and tested; the first is an accepted residual (below), because the agent uses that flag to offer Search. A second security review then found that a pause left a CLAIMED search turn (and a requeue after a lapsed lease) able to run; fixed and tested as below.

**Commands.** The `gesture` reducer (same arguments) takes `PICK_1`..`PICK_4`, `STOP` and `HEADSET_OFF`. In Direct mode `YES`, `NO` and `CONFIRM` are recorded as `ignored:direct_mode`; in Scan mode a `PICK_n` is `ignored:scan_mode`. A PICK is refractory like YES (`refractory_ms` after any accepted command). The order when more than one thing is live is the Scan order: a pause, then a read-back or confirm, then the live list, then idle.

| State | `PICK_1` | `PICK_2` | `PICK_3`, `PICK_4` |
|---|---|---|---|
| Paused | resumes (as YES did; `operator_pause`, `no_contact` as before) | `ignored:paused` | `ignored:paused` |
| Errand, call or search waiting for its read-back or confirm | confirm, with `heard_digest` and `onset_age_ms` (every CONFIRM rule: read-back done, quiet hold, window, contact, digest, consent, once) | cancel (`accepted:stop_errand`, `stop_call`, `stop_search`) | `ignored:rank_out_of_range` |
| A list is live (Reading, or the wait after it) | picks rank 1 | rank 2 | rank 3, 4 |
| Preparing or idle | `ignored:no_list` | same | same |

A list pick counts only if `scan_state.list_start_seq <= heard_step_seq <= scan_state.step_seq` (else `ignored:stale_question`) and the rank exists (else `ignored:rank_out_of_range`). `heard_option_id` is ignored for list picks. Accepted outcomes: `pick_reply`, `pick_errand`, `pick_call`, `pick_search`, `pick_category`, `confirm`, `confirm_search`, `stop_*`, `resume`. STOP also gives `accepted:stop_search`.

**Clock.** `config.input_mode` (`InputMode`: `Scan` | `Direct`) is `Direct` on a new database; the owner reducer `set_input_mode("direct" | "scan")` changes it only while no session is active. In Direct mode each option is read once (`Reading` 1, 2, ..., N, no Window between), then `Window` is the wait for a pick, `idle_pause_ms` long; when it runs out the scan ends No pick. A newer version waits for the end of the list, or is read at once if it arrives during the wait. A resume reads the list again from option 1 as a new list (new `list_start_seq`). A `yes_no` publish is read as options 1 and 2. A late clip is estimated from "One: Good" (the number and the label). The session's idle pause and every other rule are unchanged.

**Picks by kind.** `Reply`: said in the room at once, no veto (question Released, the Speaker says it), only with good contact now (else `ignored:no_contact`). `Errand` and `Call`: the existing rows, preview and read-back; then PICK_1/PICK_2. `Search`: a `search_request` row (Prepared) with the module's read-back `Search the web for ideas? One: yes. Two: cancel.` and a 16-hex digest; no web search consent means Refused `no_consent`. The station reads it from `my_session.search`, then calls `report_readback_done("search", search_id, digest)`; PICK_1 with that digest confirms it once and opens the categories turn. Read-back deadline and confirm window are timers (`search_timeout`); a pause, a new question, the session end or revoked web search consent stop it. `Category`: starts its search at once, with no confirm, but only on a categories turn (else `ignored:not_allowed`) and with web search consent (else `ignored:no_consent`).

**Follow-up turns and the agent jobs.** `JobKind` adds `Categories` and `Search`. Each is a new question (the next number, `text` copied from the person's original question) with `parent_question_id` (the original question) and `category`:
- After a confirmed Search: `via` `search`, job `Categories` (`web_search_allowed` false). The agent publishes up to four `category` options (or `reply`).
- After a Category pick: `via` `category`, `category` = the picked label (or its text), job `Search` (`web_search_allowed` from consent). The agent runs the search and publishes `reply` options (places, with sources); a place pick is said at once.
- `agent_queue` rows add `parent_question_id`, `parent_question_text` and `category`.
- An Options job's `web_search_allowed` still follows web search consent. In Direct mode it means the agent may OFFER a Search option (agent/src/direct.ts offers Search only when it is true, and writes a `search` `offered` step on that job); the agent makes no web call in an Options job. Since D24 (section 4.4) the agent does search in an Options job, once, when the partner says "do you know", under that same flag. The module cannot see the agent's HTTP calls, so that rule rests on the agent's code; the module enforces the rest (no Category option, and so no category search, without a confirmed Search). A review fix that cleared the flag in Direct mode was reverted because it removed the Search option.
- A pause (STOP, HEADSET_OFF, the dead-man lease, idle, operator) cancels every search turn whose Search job is Pending or Claimed, with the pause's code: the job is cancelled, so a claimed job's later progress and publish are `stale attempt` (a web call already in flight cannot be recalled, but nothing it finds is offered). While the session is paused, `agent_claim` refuses a Search job (`session paused`), and a Search or Categories job whose lease lapses is cancelled with its turn, never requeued. A Category pick needs good contact now, like a reply.
- Kinds each job may publish: Options job `reply`, `errand`, `call`, `search`; Categories job `category`, `reply`; Search job `reply`. `search` and `category` need Direct mode and take an empty `action_json`.

**Schema and views.** `OptionInput` and `answer_option` add `label` (at most 40 characters; empty means read `text`). `scan_state` adds `list_start_seq`; `question` adds `parent_question_id` and `category`; new private tables `search_request` and `search_timer` (schedule, `search_timeout`). `my_options` rows add `label`; `my_session` adds `search`; `public_board` options add `short_label` (the label, or "Option N" while sharing is off; `label` there is still the full text) and questions add `parent_question_id` and `category` (shared only); new anonymous view `board_searches`. Each read's speak step and the select step carry a private payload `{optionId, rank, kind, label, text}` (`board_payloads`, sharing on). Search pipeline keys are `w<search_id>:prepared`, `:readback`, `:confirmed`, `:stopped` (stage `search`); an agent key may not start with `w<n>:`. `ensure_timers` re-arms search timers and `purge_session` deletes search rows.

**Not done here.** The Cartesia key is not in `say-when-direct` yet (the owner adds it with the README's key command, naming `say-when-direct`); no consent rows or devices exist yet. Nothing was run against the live database beyond `ensure_timers`, a config read and the two routes.

### 4.2 The agent sidecar as built (track 2, Sat Oct 24 2026, branch `direct-select-agent`)

`AGENT_INPUT_MODE=direct` is the sidecar's default on this branch (`scan` keeps the scan path); the code is `agent/src/direct.ts`, every module name goes through `agent/src/contract.ts` `DIRECT`, and agent/README.md "Direct select" has the detail.
- **Options job (changed by D24, section 4.4):** no search inside it. Every option has a `label` (1 to 3 words, a place name up to 5, at most 40 characters) and a one-sentence `text`. Small talk gets four replies. A question the local D8 check says could use outside facts, with web search consent, gets yes-style, no-style, `Search the web` (kind `search`, added by the sidecar if Claude leaves it out), something else; never right after a request was sent, on a menu turn or without consent. The yes or no fast path ("Yes", "No") stays for plain yes or no questions only.
- **Categories job:** up to four `category` options from the question alone (no web call, no memory, no conversation); their search words are kept in the sidecar by original question. Stock categories if Claude fails.
- **Search job (sidecar `category_search`):** Google Maps near `AGENT_PLACES_NEAR` for a place question, RAG web otherwise, with the category's words; rows through the usual pipeline events and the question's Moss web index; up to four `reply` options with sources. Places by name if Claude fails. No web search consent: `agent_fail` `web_search_off`, "Web search is turned off, so I did not search."
- **Tests:** 351 passing in `agent/` (320 before), including contract checks against this module's source and bindings. Not run against `say-when-direct` yet. Not done: the call-transcript follow-up (stretch, section 3 item 5).

### 4.3 The decoder, station and screens as built (track 3, Sat Oct 24 2026, branch `direct-select-web`)

- **Decoder (`eeg-data/`):** `python live.py --window --mode direct` (the default): imagined left fist `PICK_1`, right fist `PICK_2`, single jaw clench `PICK_3`, double `PICK_4`, a clench held 0.8 s (`LONG_CLENCH_S`) `STOP`, no packets for 0.5 s `HEADSET_OFF`. `--mode scan` keeps YES / NO / CONFIRM / STOP for `say-when-demo`. `--jaw-only` in direct mode: single `PICK_1`, double `PICK_2`, held `STOP` (3 and 4 from the station keys). A short clench followed by a held one is one STOP, never also a pick. The 8766 markers carry the same words (`tools/VIZ_PROTOCOL.md` 3.5); `tools/viz_bridge_synthetic.py --mode` and `tools/check_viz_bridge.py` accept both maps (checker PASS in both). A stray single clench is now a real pick of option 3, so raise `JAW_RATIO` to about 30 before a live run (eeg-data/README.md). Decoder tests: 39 passed, 1 skipped (no copied recordings).
- **Station (`web/lib/station/`):** relays `PICK_1`..`PICK_4`, `STOP` and `HEADSET_OFF` to `gesture` with the exact word, `heard_step_seq` from the heard log at the onset, `heard_option_id` 0 for a pick, and the read-back digest on `PICK_1` (errand, then call, then search). Keys 1, 2, 3, 4, S (H is the headset-off test); a USB switch: short press 1, double press 2, 1 s hold STOP. A decoder still on `--mode scan` sends YES/NO/CONFIRM, which the station drops with the note "restart it with python live.py --window --mode direct". The earpiece reads each option as "One: <label>." (the text when the label is empty); errand and call read-backs end "One: send it. Two: cancel."; the search read-back (`my_session.search`) is read as the module wrote it and reported with `report_readback_done("search", ...)`. The stock phrases changed (the confirm is the same in every input), so the IndexedDB phrase store voices them once more.
- **Screens:** one legend in `web/lib/commands.ts` (`COMMAND_INFO`, `gestureLegend`, `CONFIRM_SHORT`, `JAW_LANE_LEGEND`). /conversation: numbered rows with the earpiece label ("Ear: Cafe on Bay"), the command strip 1, 2, 3, 4, STOP, and "Waiting for a pick: 1 to 4" during the wait. /replies: a number badge on every option card and the pick line "Picked with 3, a single jaw clench". /agents: "Waiting for 1 to send, 2 to cancel". /station: the numbered list with each number's gesture, and the legend. /brain: "1: C4 left-fist imagery", "2: C3 right-fist imagery", the jaw lane "Jaw muscle, not brain 3 single / 4 double / long = STOP", "C4 · 1" and "C3 · 2" on the patches. /try: buttons 1, 2, 3, 4, STOP (its `NEXT_PUBLIC_TRY_SPACETIMEDB_DB` must name a Direct database). The sample replay (`web/lib/data/replay.ts`) is a direct select story. Web: typecheck, 687 tests (CI floor 524) and `next build` pass.
- **Not done:** no live run against `say-when-direct`; the anonymous `board_searches` view is not on the dashboards (a search shows in the conversation and the earpiece, not as an Agents card); `tools/mock-viz` scenarios still carry the scan words (the live decoder and the synthetic bridge send the direct words).

### 4.4 Search the web always third, and "do you know" (D24, Sun Oct 25 2026, branch `search-option`)

Stephen, about 1:20 AM: "when Khadim says 'do you know', that should automatically signal Apify to start web searching", and "as a third option, when the options are back to the EEG, one of the options should be to web search, so Apify can work". Sidecar only (`agent/src/direct.ts`, `agent/src/planner/prompt.ts`); the module, the station and the screens do not change.

- **Option 3 is always Search the web** for a partner question the planner answers, while web search consent is on and Apify is set up: small talk too, and in the ten minutes after a request was sent too (the old suppression is gone; the call option keeps its own rule). Order: 1 a reply, 2 a second reply or the errand or the call, 3 Search the web (`withSearch` moves an errand or a call to rank 2, fills a short list with a stock reply as D22 does, and guarantees rank 3 is the Search option; the planner prompt asks for the same order). Not offered: the stock yes or no fast path ("Yes", "No"), the person's own menu, the categories and results turns, no web search consent, no Apify. A planner `yes_no` answer becomes a pick with Search third, as before. The offer writes one `search ok offered` event (its `needsWeb` count is the D8 check, so small talk still shows as not needing outside facts). Picking it is unchanged: read-back, PICK_1 confirm, categories, the category search.
- **"Do you know" searches at once.** A partner question with "do you know" or "d'you know" (any case, whole words; `asksDoYouKnow`) and web search consent: the Options job runs the scan path's search right away (Google Maps near `AGENT_PLACES_NEAR` for a place question, the RAG web search with the question otherwise; `searchStep`), indexes the rows in the question's Moss web index (forgotten at the end), and Claude writes the replies from the results, each citing its rows (`sources`). No Search pick, no confirm, no categories. The pipeline events are the real ones (`search started`, then `ok` with the rows or `error`; reason `Asked "do you know", so the web search ran at once.`), so the screens show Apify working. Option 3 stays **Search the web**: it starts a new, narrower search through the categories, so it does not repeat the first one. If the search fails, the planner is told so and the replies say they are not sure.
- **The confirm is skipped for this one phrase, on purpose.** The question goes to Apify without a pick, under web search consent, as the scan path sends it. The trigger is the literal phrase, so "How do you know her?" and "Do you know what time it is?" search too.
- **Tests** (`agent/test/direct.test.ts`): Search always rank 3, including after a recent errand with a call option; "do you know" runs one search before Claude drafts and its replies cite the rows (web and maps); a failed search is written as an error; no "do you know" means no search before a pick; no consent means no search and no Search option.

### 4.5 Search capped at 11 s, preloaded results, place words, the pinned place (D26, Sun Oct 25 2026, branch `search-preload`)

Stephen, 2:15 AM: "Apify errored a couple times, I think it's timing out. Preload some data for Google Maps and any other sites, and max 11 seconds for it." Sidecar only; the module, the station and the screens do not change.

- **One search per pick, 11 s at most** (`AGENT_SEARCH_TIMEOUT_MS`, default 11000). A Category pick takes over its prefetched run (section 3); if that run fails or runs out of time, there is no second search. The Apify runs end on Apify's side 2 s before the deadline (RAG Web Browser `requestTimeoutSecs`, Maps `timeout`, at least 10 s for Maps).
- **Preloaded results** (`agent/src/preload.ts`, `AGENT_PRELOAD`, `AGENT_PRELOAD_FILE`, `AGENT_PRELOAD_REFRESH_MS`, `AGENT_PRELOAD_TIMEOUT_MS`). A fixed list of real searches (`agent/preload.example.json`) runs at start and every 20 minutes, two at a time, under web search consent only. A search that matches an entry waits 1.5 s for its live result, then uses the preloaded rows (and stops the live run), or uses them when the live search fails. The event says `maps cached` or `web cached` (`cached`, `ageS`, `liveFailed`), and every row keeps its original `fetchedAt`, so the screens show when it was fetched. A revocation empties the cache.
- **Place words** ("any good spots?", "somewhere fun", "things to do", "hang out") go to Google Maps near the venue (`withPlaceWords`).
- **Places as the replies.** A place question whose maps search found places gets those places as its replies, by name, each citing its row ("Let's go to Crissy Field!"), with no plan; Search the web stays third on "do you know". `AGENT_PINNED_PLACE` ("Palace of Fine Arts" at the demo) is always the first of them, cited from the live or preloaded maps row when there is one, and otherwise a plain reply with its name only.

### 4.6 A call asked for by name is option 1 (D28, Sun Oct 25 2026, branch `call-trigger`)

Stephen, about 2:52 AM: "any time it says 'check in with Stephen' or 'call Stephen', it just does the call on the agent screen as well." Sidecar and `cartesia/src/call.ts`; the module, the station and the screens do not change.

- **The trigger** (`askedToCall`): "call <name>", "check in with <name>", "give <name> a call" or "ring <name>" in the partner's question, any case, whole words, where <name> is a consented contact (full name or first word), and not right after "don't", "do not", "never" or "no need to". Then the list is 1 **Call <name>**, 2 a reply ("Not now" when Claude wrote none), 3 Search the web while it is offered (`callFirst` guarantees this order). No recent request is needed. Without the trigger, a call is still offered only in the ten minutes after a sent request.
- **What the call says.** With a recent request, the errand message as before. Without one, a check-in: the Dialer's own words "<person> asked me to check in with you.", read back as "Call <name> to check in for you." Picking it goes through the read-back and the two-option confirm (1 sends, 2 cancels), then dials and shows on the Agents screen like any call. Consent list, do-not-call, holds and never an emergency number all still apply.
- **No promises in replies.** The planner is told a reply is only said aloud, so a reply never says "Yes, call him" or "I'll send it"; only the call, errand or search option itself does that.

## 5. Honesty and safety (unchanged rules)

- Nothing leaves the room (errand, message, call, web search start) without a read-back and a fresh confirm pick. One exception since D24: a partner question with "do you know" is searched at once, under web search consent (section 4.4).
- The jaw clench is a muscle signal; the fists are imagined movements. No "mind reading" wording.
- Calls: consent list only, AI disclosure, never emergency numbers (PLAN D20 removed the 9 AM to 9 PM rule). Since D28 a call can be offered with no sent request when the partner asks for it by name (section 4.6); it then only checks in.

## 6. Build tracks

1. Module (spacetime/) + bindings regeneration + tests + publish to `say-when-direct`.
2. Agent sidecar (agent/) planner and job handling + tests.
3. Decoder mapping (eeg-data/) + station, earpiece and screens (web/) + tests.

Each track works on its own branch off `direct-select` in its own worktree, stages named paths only (never the node_modules symlinks), and merges into `direct-select` when its tests pass. Integration and the live run on `say-when-direct` come last.
