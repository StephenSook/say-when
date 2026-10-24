# NeuroLingo: Plan and Coordination

> Living status doc for Stephen, Khadim, Shashank and Leon. Update it on every task change and push to `main`. This file is the single source of truth for who is working on what.

**Project:** Screenless reply and errand assistant for people who cannot speak or use their hands, driven by four head-worn switch commands.
**Team:** Stephen (the whole backend: SpacetimeDB, the agent sidecar and Claude planner, errand and call wiring, telemetry; all UI/UX; Apify, Moss, Cartesia), Khadim (no rows assigned yet, see Q8), Shashank (headset, decoder, calibration, brain test), Leon (user consult, consent, demo video)
**Deadline:** Submit on Devpost (cal-hacks-13-0.devpost.com; an organizer confirmed Devpost is the final submission, Oct 24 1:43am PT) by Sunday Oct 25, 8:50 AM PDT. Devpost itself closes at 9:00 AM; we aim for the earlier time. Judging 10:30 AM to 12:30 PM, whole team at the table. Winners announced 4:00 PM.
**Repo:** https://github.com/StephenSook/say-when

---

## Status Dashboard

Legend: ✅ done · 🟡 in progress · ⬜ not started · ⛔ blocked

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|-----------|---------|-------|--------|------|-------|
| 0.1 | Repo, PLAN.md, CI, hooks | `PLAN.md` | Stephen | ✅ | - | |
| 1.1 | SpacetimeDB module: tables, reducers, views, scan clock, consent gate | `spacetime/` | Stephen | ✅ | - | Built, 155 tests, four Codex rounds, live as `say-when-dev` (smoke 17 of 17). Gap fixes for the dashboard and sidecar in progress (module v2) plus a clean `say-when-demo` database. Design in `docs/spacetime.md`; niche features in D12 |
| 1.2 | Lock shared contracts (table and reducer names) | `PLAN.md` | Stephen | ✅ | 1.1 | Locked Oct 24 from `docs/spacetime.md` (see Shared Contracts below); announce changes with ⚠️ CONTRACT |
| 2.1 | Headset reader and four-command decoder | `switch/` | Shashank | ⬜ | - | Which headset? See Q1 |
| 2.2 | Calibration: per-person signal map and thresholds | `switch/` | Shashank | ⬜ | 2.1 | Idle false-activation rate goes on the dashboard |
| 2.3 | STOP, HEADSET-OFF watchdog and idle auto-pause | `switch/` | Shashank | ⬜ | 2.1 | 0.5 s packet watchdog; long jaw clench is STOP |
| 2.4 | Brain commands: imagined right fist = YES, left fist = NO | `switch/` | Shashank | ⬜ | 2.2 | Needs a C3/C4 headset (Q1). Must pass `docs/brain-mode-test.md` (left vs right vs rest) at the venue; else jaw-only fallback. See D11 |
| 3.1 | Partner speech to text (Cartesia Ink-2) | `cartesia/` | Stephen | ✅ | - | Built and tested offline (117 tests in `cartesia/`). Live smoke test pending |
| 3.2 | Apify search and scrape client (RAG Web Browser, Google Maps) | `apify/client/` | Stephen | ✅ | - | Built, 166 tests, Codex round 1 fixed (4891a05) |
| 3.3 | Moss retrieval over Apify results and memory | `moss/` | Stephen | ✅ | 3.2 | Built, 75 tests, six Codex rounds (last two clean). Memory first; text private unless shareable. First real Moss run pending |
| 3.4 | Option planner (Claude, up to four options) | `agent/` | Stephen | ✅ | 3.2, 3.3 | Built in the sidecar (claude-haiku-5-5, structured output, strict checks), 191 tests on fakes, seven Codex rounds. First live run against Anthropic, Apify, Moss and say-when-dev pending (needs the API keys). Skips the web search when no outside facts are needed (D8) |
| 3.5 | Earpiece voice (Cartesia Sonic, pronunciation dictionary) | `cartesia/` | Stephen | ✅ | 3.4 | Built and tested offline. Nobody has heard Sonic say "NeuroLingo" yet |
| 4.1 | Form-errand Apify Actor: preview, read back, submit | `apify/form-errand/` | Stephen | ✅ | - | Public on the Apify Store: https://apify.com/stephensookra/confirm-gated-form-errand (build 0.1.3, includes the round 1 fixes). Now build 0.1.4 (round 2 fixes), verified on the platform: preview, submit, and a repeat submit refused as a duplicate |
| 4.2 | Errand wiring: errand option or idle menu, read-back, CONFIRM, submit | `agent/` | Stephen | ✅ | 1.1, 4.1 | Built in the sidecar: preview, read-back digest, submit only after the module records a matching CONFIRM, unknown outcomes never retried. Live run pending. Errands and calls are options, not gestures (D11) |
| 4.3 | Care team request form (demo target) | external | Leon | ⬜ | - | Owned by the consenting caregiver |
| 4.4 | Outbound call agent (Cartesia Managed Agents) | `cartesia/` | Stephen | 🟡 | 1.1, 4.2 | Code built and tested offline. Still needed: create the agent from `cartesia/agent/*.txt`, consent re-confirmed under the NeuroLingo name (D13), one live test call to a consenting number |
| 5.0 | UI reference: `docs/ui.md` with tokens, wireframes and mockups | `docs/` | Stephen | ✅ | - | Open `docs/mockups/index.html`. Stephen builds the UI from it |
| 5.1 | Dashboard shell: Next.js, SpacetimeDB WebSocket subscriptions, layout | `web/` | Stephen | ✅ | 1.1 | Built, 141 tests; reads the live module as an anonymous viewer, no login. See D7 |
| 5.2 | Screen 1, Live data: each pipeline stage with its real payload as it flows | `web/` | Stephen | ✅ | 5.1 | Built and checked on live data |
| 5.3 | Screen 2, Agents at work: form errand and phone call, step by step | `web/` | Stephen | ✅ | 5.1, 4.1 | Built; errands checked on live data, calls on the replay (live call fields come with module v2) |
| 5.4 | Screen 3, Live conversation: question, options, pick, spoken reply | `web/` | Stephen | ✅ | 5.1 | Built and checked on live data |
| 5.5 | Partner phone view | `web/` | Stephen | 🟡 | 5.1 | Status view live. Asking built: pairing, typed `ask_question` (passed the live keyboard run L1 on Oct 24) and Hold to ask with Cartesia Ink-2 (not run yet: needs the Cartesia key on the module, then L3 on the real phone) |
| 5.6 | Station page: the wearer's laptop | `web/` | Stephen | 🟡 | 1.1, 2.1 | Built (`/station`). L1 on `say-when-dev`, Oct 24, silent keyboard mode: pairing, session label `keyboard-test`, a pick, a pick 52 ms late that still took the option heard, a yes or no answer, the refractory ignore, the dead-man pause and resume (hidden page simulated), reload and continue; 11 of 13 steps pass. Not run: the voiced read-back and CONFIRM (step 8) until the module has the Cartesia key; the decoder from Shashank (L4); a real hidden window (5.2) |
| 5.7 | Speaker page: the room voice | `web/` | Stephen | 🟡 | 1.1 | Built (`/speaker`): says each released reply once, reports `reply_spoken`, shows Missed after 20 s. Not run live until the module has the Cartesia key (L2) |
| 5.8 | Judge page | `web/` | Stephen | ⬜ | 5.1 | A three-minute itinerary with deep links, the live stats route and what is verified, no login |
| 6.1 | Telemetry to Tiger Data (switch timing, latency) | `telemetry/` | Stephen | ✅ | 1.1 | Built: free Tiger service `neurolingo-telemetry` (TimescaleDB, us-east-1), schema verified live, pinned TLS, 134 tests. The writer reads switch events from SpacetimeDB, so the decoder needs no Tiger code. Not yet run during a real session. Telemetry only, no app state |
| 6.2 | Tiger compression policy and a measured ratio on our own rows | `telemetry/` | Stephen | ⬜ | 6.1 | Compression is a core Timescale feature; measure it, do not quote it |
| 7.1 | User consult and consent per surface | - | Leon | ⬜ | - | |
| 7.2 | Demo script and video | `docs/` | Leon | ⬜ | 4.2 | |
| 7.3 | Devpost writeup | - | Stephen | ⬜ | 7.2 | |

---

## Coordination Protocol

1. **Before starting a task:** set status to 🟡, commit PLAN.md, push. This is your lock. `./scripts/plan claim 3.4`
2. **After finishing:** flip to ✅, commit PLAN.md, push. `./scripts/plan done 3.4`
3. **If blocked:** set to ⛔ with a one-line reason. `./scripts/plan block 3.4 "waiting on contract"`
4. **Before starting ANY task:** run `git pull` and check this file. If someone else has 🟡 on overlapping files, talk first.
5. **Hotfixes:** skip the protocol. Commit the fix, update PLAN.md after. Process never blocks a real emergency.
6. **PLAN.md commits are atomic.** Never bundle a status update with code changes.
7. **Commit messages:** `status: [task #] [emoji] [description]` for plan updates, for example `status: 2.1 🟡 starting decoder`.
8. **Handoffs:** `./scripts/plan handoff 4.2 Stephen` moves a row to someone else.
9. **Stale locks:** a 🟡 row carries a timestamp in Notes. No commit on it for 4 hours means anyone can claim it after pinging the owner.
10. **Contract changes need an announcement.** Changing anything in Shared Contracts means telling every consumer first and putting `⚠️ CONTRACT` in the commit message.

---

## Shared Contracts

> Locked Oct 24 from `docs/spacetime.md` (row 1.2, Stephen). Exact fields, reducers and views live there (Appendix A and the change sections); this table is the summary. Announce any change with ⚠️ CONTRACT.

| Contract | Owner | Consumers | Definition |
|----------|-------|-----------|------------|
| Decoder event | Shashank | station page (Stephen) | The decoder sends `{ type: "gesture", id, command, onsetAgeMs, confidence, source }` and `{ type: "health", decoderHealthy }` (at least every 250 ms) over `ws://127.0.0.1:8765` to the station page (port confirmed by Shashank, Oct 24 8:45 AM). `command` is `YES`, `NO`, `CONFIRM`, `STOP` or `HEADSET_OFF` (D11). The decoder never calls SpacetimeDB itself. |
| Gesture reducer | Stephen | station page | `gesture(gesture_id, command, heard_step_seq, heard_option_id, heard_digest, confidence, source, onset_age_ms)`, Station role only, idempotent on `gesture_id`. A refused command is recorded as `ignored:<reason>`, not thrown. |
| Options | Stephen | station, web | Private `answer_option` rows, written only by the sidecar through `agent_publish_options(job_id, attempt, ...)`: 1 to 4 options, exactly 2 for a yes or no question; `kind` is `reply`, `errand`, `call` or `menu`. |
| Pipeline event | Stephen | web | Public, content-free `pipeline_event { stage, status, detail, ms, counts_json, ... }`; content lives in the private `pipeline_payload` and reaches the board only while sharing is on. |
| Search client | Stephen | agent | `searchWeb(question)` and `searchPlaces(query, near)` return `{ rows, ms }`. Each row is `{ id, source, title, text, url or placeId, fetchedAt }`. See `apify/client/README.md`. |
| Form-errand Actor | Stephen | agent | Standby `POST /preview { formUrl, fields }` returns `{ status, readBack, readBackText, previewDigest, screenshot }`. `POST /submit { formUrl, fields, confirmDigest }` returns `{ status, confirmationText }`. See `apify/form-errand/README.md`. |
| Errand row | Stephen | agent, web, station | Private `errand` row. A CONFIRM counts only after the read-back and the quiet hold, inside the window, with the digest the station played, once; then `claim_errand` and `complete_errand`. A lapsed submit lease is `unknown_outcome` and nothing resubmits. |
| Call request | Stephen | agent, web, station | Private `call_request` row; consent per contact; one call at a time (`line_busy`); STOP hangs up. Consent, do-not-call and holds are checked again by the Dialer before the dial. |
| Moss docs | Stephen | agent | One index per session. Doc `{ id, text, metadata }`, metadata values are strings: `source`, `url` or `placeId`, `fetchedAt`, `questionId`. |

---

## Decisions

### D1: SpacetimeDB is the shared real-time state

Every pipeline step and every command lands in SpacetimeDB. The dashboard and the partner phone subscribe over WebSocket, so any laptop shows the same live state. Convex is out.

**Locked Oct 23 by Stephen.**

### D2: Tiger Data holds telemetry only

Switch timing, response windows and latency go to Tiger Data in batches from the laptop. No app state lives there.

**Locked Oct 23 by Stephen.**

### D3: Four commands (superseded by D11)

The first map (SELECT, NO, ERRAND, CALL, with eye movements) is replaced: the headset reads the jaw and imagined hand squeezes, not the eyes.

**Superseded Oct 24 by D11.**

### D4: The model never clicks or dials

An errand or call option only prepares and reads back. A fresh CONFIRM (double jaw clench) after the full read-back releases the action. Silence, a timeout, NO, STOP or a lost signal all mean no action.

**Proposed Oct 23. Team to confirm.**

### D5: Our own form-errand Actor, public on the Apify Store

Deterministic Playwright, not an LLM clicking. Preview by default, a form allowlist, and refusals for CAPTCHA, login, password, payment and upload.

**Locked Oct 23 by Stephen.**

### D6: Stephen owns SpacetimeDB, Apify, Moss, Cartesia and all UI/UX

Apify search, the form-errand Actor, Moss retrieval, and every Cartesia piece (Ink-2 speech to text, Sonic earpiece voice, pronunciation dictionary, and the outbound call agent) are Stephen's, and so is all of the UI/UX (every dashboard screen and the partner phone view) and, from Oct 23 10:45 PM, the SpacetimeDB module. Claude implements these for Stephen. Shashank keeps the headset and decoder, the option planner and Tiger telemetry.

**Locked Oct 23 by Stephen.**

### D8: Search the web only when the question needs outside facts

Small talk and personal questions ("Are you tired?", "Want some water?") never wait on Apify. Moss recalls memory first, locally, in milliseconds. A fast check decides whether the question needs outside facts (places, opening hours, news, prices, weather); only then does the search run, in parallel with memory, and memory-based options can be read while it runs. Suggested by Khadim.

**Locked Oct 23 by Stephen.**

### D9: Brain commands are gated by a test written before measuring

Imagined left and right fist squeezes are YES and NO only if they pass the three-class test (left, right, rest) in `docs/brain-mode-test.md`, committed before any measurement. They are never the confirm, and they are never claimed to read thoughts. If they fail, YES becomes a single short jaw clench and NO becomes silence, and the result is reported as an experiment.

**Updated Oct 24 for D11. Needs a C3/C4 headset (Q1).**

### D10: Cartesia uses its own library voices, no cloning, and as many of its features as fit

A steady assistant voice for prompts and read-backs and a warm reply voice for options and spoken replies, both from Cartesia's library. On top: a pronunciation dictionary built from place and household names on every request, an emotion per option, speed set to the person's pace, word timestamps for the on-screen highlight, streaming contexts with cancel, cached stock phrases, Ink-2 with keyterms and turn detection, short-lived access tokens for every browser, and a Managed Agents outbound call. No voice cloning.

**Locked Oct 23 by Stephen.**

### D11: The command map: the brain chooses, the jaw commits or stops

The headset reads two things: imagined hand squeezes and the jaw. No eyes.

| Signal | Command | Means |
|---|---|---|
| Imagine squeezing your right fist | YES | Pick this one, or answer yes. While idle, it opens the person's own menu. |
| Imagine squeezing your left fist | NO | Skip, or answer no. |
| Double jaw clench | CONFIRM | The only way anything leaves the room (a form or a call). |
| Long jaw clench, about 1 s | STOP | Cancel, none of these, hang up, pause. |

How it plays out: a yes or no question costs one thought ("Are you tired?" then right fist, the voice says "Yes"); an open question plays four options in four tones and silence moves on, so the person thinks once on the one they want; when the talk leads to an errand or a call, Claude offers it as a follow-up option ("Send the care team a lunch request", "Call Leon", "Nothing else"), YES picks it, the read-back plays, and only a double clench sends it; while nothing is happening, YES opens the person's own menu, which keeps their independence; during a call a long clench hangs up. HEADSET-OFF and the 2-minute idle auto-pause still cancel anything pending. Imagined movement is slow, so each option's response window is about 3 to 4 seconds, set at calibration. Proposed by Khadim; adopted by Stephen.

**Locked Oct 24 by Stephen.**

### D12: How we use SpacetimeDB (the niche features)

SpacetimeDB is the whole live backend, not a store behind an API:

1. **One clock for every screen.** The scan cursor is a chain of one-shot scheduled reducers. Each step writes `scan_state` (cursor, step number, when the step ends) and schedules the next tick, so the earpiece, the partner's phone and the dashboard advance on the same server tick. A YES is matched to the step the person actually heard, with a short grace window.
2. **A dead-man interlock.** While a session is live the station sends a heartbeat; each one pushes a one-shot liveness row forward. If heartbeats stop (headset off, laptop asleep, network gone), the row fires, pauses the scan and voids any pending confirm.
3. **Consent is a row, enforced in a reducer.** The Apify preview's digest is stored with the errand; only a fresh CONFIRM inside the window, matching that digest, moves it to Confirmed, and the agent can only submit a Confirmed errand with that digest. Every step lands in an append-only ledger.
4. **Roles in reducers, privacy in views.** Each device has one role (Station, Partner, Speaker, Agent); every reducer checks it. Per-role views give each device only what it needs, and an anonymous public board shows judges the live pipeline without private text.
5. **The database runs short credentialed hops.** A procedure mints 60-second Cartesia tokens for paired browsers, so no key reaches a browser; an optional scheduled procedure can start the Apify submit and an HTTP route can receive its webhook.
6. **A public pipeline table drives the live dashboards** on any laptop, and an event table carries chimes and toasts.

**Locked Oct 23 by Stephen. Design detail in `docs/spacetime.md`.**

### D14: Stephen's side owns the whole backend

Stephen (with Claude) builds and runs all of the backend: the SpacetimeDB module, the agent sidecar and the Claude option planner, the errand and call wiring, and the Tiger Data telemetry writer, along with the UI and the Apify, Moss and Cartesia packages. Shashank owns the headset: the reader, the four-command decoder, calibration and the brain test. The decoder talks to the backend only through the SpacetimeDB contract in `docs/spacetime.md`.

**Locked Oct 24 by Stephen.**

### D13: The product is called NeuroLingo

It was "Say When" until Oct 23. Every screen, document and spoken line, including the outbound call's AI disclosure, now says NeuroLingo. Code identifiers (package names, the Moss session name, the SpacetimeDB database name) and the repo URL keep `say-when` until Stephen decides whether to rename the repo. Consent collected under the old name is confirmed again under the new name before any real call. The copy stays honest: the jaw clench is a muscle signal, the imagined squeeze is the brain test, and nothing claims to read thoughts.

**Locked Oct 23 by Stephen.**

### D7: Three live dashboard screens

All three update over SpacetimeDB subscriptions, so every laptop shows the same thing at the same moment. Stephen builds the UI. Every page stays very simple: one clear focus per screen, big labels, and nothing a judge has to decode. Style and layout follow `docs/ui.md`.

1. **Live data.** The data actually flowing: the partner's words from Ink-2, the Apify rows that came back (with source and fetch time), the Moss hits, the options Claude drafted, the voice clip Sonic played, and how long each step took.
2. **Agents at work.** The agents doing their jobs: the form-errand Actor's preview screenshot, the values it read back off the page, the digest, the confirm, and the confirmation text after submit. Then the call: who is being called, ringing, connected, the live transcript, and how it ended.
3. **Live conversation.** The conversation itself: the partner's question, the four options as each is read aloud, the scan cursor moving, which option the person picked, and the reply that was spoken.

**Locked Oct 23 by Stephen.**

---

## Open Questions

- [ ] **Q1:** Which headset are we using? It decides which signals are possible (a Muse cannot read an imagined movement). Needs Shashank.
- [ ] **Q2:** Lock the SpacetimeDB table and reducer names in Shared Contracts. Needs Stephen (row 1.2); Shashank checks the decoder side.
- [ ] **Q3:** Demo form: a Google Form owned by the caregiver, or our own page on the dashboard domain? Needs Leon and Stephen.
- [ ] **Q4:** Can the free Cartesia phone number be set up without a card? Needs Stephen (Cartesia account; the call agent and number do not exist yet).
- [ ] **Q5:** Who plays the caller's recipient, and is their consent written down? Needs Leon.
- [x] **Q6:** Voice clone? Decided Oct 23 by Stephen: no cloning. See D10.
- [ ] **Q7:** Pitch opening: lead with ALS and the recent implant stories (implants need brain surgery; NeuroLingo uses a headband that reads jaw clenches and imagined hand squeezes). Every implant fact must be checked and cited before it goes in the script. Needs Leon and Stephen.
- [ ] **Q8:** What does Khadim own now that all UI/UX moved to Stephen? Needs Stephen.
- [ ] **Q9:** YES while idle opens the person's menu (Khadim recommends keeping it: it is the most brain-first piece, and a misfire only opens the menu). Default: keep. Needs Stephen to confirm.
- [ ] **Q10:** Someone with ALS who loses the jaw has no way to CONFIRM. A brain-only confirm (for example two YES in a row after the read-back) is the next step; default: say it in the pitch as future work, do not build it this weekend. Needs Stephen to confirm.

---

_Last updated: Oct 24 by Stephen._
