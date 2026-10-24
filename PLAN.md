# Say When: Plan and Coordination

> Living status doc for Stephen, Khadim, Shashank and Leon. Update it on every task change and push to `main`. This file is the single source of truth for who is working on what.

**Project:** Screenless reply and errand assistant for people who cannot speak or use their hands, driven by four head-worn switch commands.
**Team:** Stephen (frontend UI/UX, Apify, Moss), Khadim (frontend UI/UX), Shashank (backend, AI, hardware and EEG), Leon (user consult, consent, demo video)
**Deadline:** Sunday Oct 25, 8:50 AM PDT submission. Judging 10:30 AM to 12:30 PM.
**Repo:** https://github.com/StephenSook/say-when

---

## Status Dashboard

Legend: ✅ done · 🟡 in progress · ⬜ not started · ⛔ blocked

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|-----------|---------|-------|--------|------|-------|
| 0.1 | Repo, PLAN.md, CI, hooks | `PLAN.md` | Stephen | ✅ | - | |
| 1.1 | SpacetimeDB module: tables, reducers, scan clock | `spacetime/` | Shashank | ⬜ | - | Start from the draft contracts below |
| 1.2 | Lock shared contracts (table and reducer names) | `PLAN.md` | Shashank | ⬜ | 1.1 | Announce changes with ⚠️ CONTRACT |
| 2.1 | Headset reader and four-command decoder | `switch/` | Shashank | ⬜ | - | Which headset? See Q1 |
| 2.2 | Calibration: per-person signal map and thresholds | `switch/` | Shashank | ⬜ | 2.1 | Idle false-activation rate goes on the dashboard |
| 2.3 | PAUSE and HEADSET-OFF watchdog | `switch/` | Shashank | ⬜ | 2.1 | 0.5 s packet watchdog |
| 3.1 | Partner speech to text (Cartesia Ink-2) | `agent/` | Shashank | ⬜ | - | |
| 3.2 | Apify search and scrape client (RAG Web Browser, Google Maps) | `apify/search/` | Stephen | 🟡 | - | Stephen, since Oct 23 8:45pm PT |
| 3.3 | Moss retrieval over Apify results and memory | `moss/` | Stephen | ⬜ | 3.2 | Starts after the sponsor research lands |
| 3.4 | Option planner (Claude, up to four options) | `agent/` | Shashank | ⬜ | 3.2, 3.3 | |
| 3.5 | Earpiece voice (Cartesia Sonic, pronunciation dictionary) | `agent/` | Shashank | ⬜ | 3.4 | |
| 4.1 | Form-errand Apify Actor: preview, read back, submit | `apify/form-errand/` | Stephen | 🟡 | - | Stephen, since Oct 23 8:45pm PT. Public on Apify Store |
| 4.2 | Errand wiring: ERRAND, read-back, confirm_errand, submit | `agent/` | Shashank | ⬜ | 1.1, 4.1 | |
| 4.3 | Care team request form (demo target) | external | Leon | ⬜ | - | Owned by the consenting caregiver |
| 4.4 | Outbound call agent (Cartesia Managed Agents) | `agent/` | Shashank | ⬜ | 1.1, 4.2 | Consenting number only |
| 5.1 | Dashboard shell: Next.js, SpacetimeDB WebSocket subscriptions, layout | `web/` | Khadim | ⬜ | 1.1 | Must work on any laptop with no login. See D7 |
| 5.2 | Screen 1, Live data: each pipeline stage with its real payload as it flows | `web/` | Stephen | ⬜ | 5.1 | Reads `pipeline_event` |
| 5.3 | Screen 2, Agents at work: form errand and phone call, step by step | `web/` | Stephen | ⬜ | 5.1, 4.1 | Reads `errand`, `call_request` |
| 5.4 | Screen 3, Live conversation: question, options, pick, spoken reply | `web/` | Khadim | ⬜ | 5.1 | Reads `option`, command events |
| 5.5 | Partner phone view | `web/` | Khadim | ⬜ | 5.1 | |
| 6.1 | Telemetry to Tiger Data (switch timing, latency) | `telemetry/` | Shashank | ⬜ | 2.1 | Telemetry only, no app state |
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

> DRAFT until Shashank locks 1.2. Field names, data formats and API shapes more than one person depends on.

| Contract | Owner | Consumers | Definition |
|----------|-------|-----------|------------|
| Command event | Shashank | agent, web | Decoder calls reducer `record_gesture(command, confidence, window_id)`. `command` is one of `SELECT`, `NO`, `ERRAND`, `CALL`, `PAUSE`, `HEADSET_OFF`. One row per accepted gesture, consumed once. |
| Option row | Shashank | web, agent | `option { id, question_id, version, rank, text, kind, sources }`. `kind` is `reply`, `errand` or `call`. `sources` is a list of `{ source, url or placeId, fetchedAt }`. |
| Pipeline event | Shashank | web | `pipeline_event { id, session_id, stage, status, detail, ms, at }`. `stage` is `listen`, `search`, `retrieve`, `plan`, `speak`, `select`, `errand` or `call`. `status` is `started`, `ok` or `error`. The dashboard renders these live. |
| Search client | Stephen | agent | `searchWeb(question)` and `searchPlaces(query, near)` return `{ rows, ms }`. Each row is `{ id, source, title, text, url or placeId, fetchedAt }`. See `apify/search/README.md`. |
| Form-errand Actor | Stephen | agent | Standby `POST /preview { formUrl, fields }` returns `{ status, readBack, readBackText, previewDigest, screenshot }`. `POST /submit { formUrl, fields, confirmDigest }` returns `{ status, confirmationText }`. See `apify/form-errand/README.md`. |
| Errand row | Shashank | agent, web | `errand { id, form, status, preview_digest, read_back_text, confirmation_text, screenshot_url }`. Reducer `confirm_errand(errand_id, digest)` accepts only when the row awaits confirmation, the window is open and the digest matches. |
| Call request | Shashank | agent, web | `call_request { id, contact, script_digest, status }`. Consent and do-not-call list are private tables. One call per confirm, retries off. |
| Moss docs | Stephen | agent | One index per session. Doc `{ id, text, metadata }`, metadata values are strings: `source`, `url` or `placeId`, `fetchedAt`, `questionId`. |

---

## Decisions

### D1: SpacetimeDB is the shared real-time state

Every pipeline step and every command lands in SpacetimeDB. The dashboard and the partner phone subscribe over WebSocket, so any laptop shows the same live state. Convex is out.

**Locked Oct 23 by Stephen.**

### D2: Tiger Data holds telemetry only

Switch timing, response windows and latency go to Tiger Data in batches from the laptop. No app state lives there.

**Locked Oct 23 by Stephen.**

### D3: Four commands: SELECT, NO, ERRAND, CALL

ERRAND makes the Apify Actor fill a form. CALL makes the agent place an outbound call to say the form was sent. PAUSE and HEADSET-OFF are automatic safety states outside the four.

**Locked Oct 23 by Stephen.**

### D4: The model never clicks or dials

ERRAND and CALL only prepare and read back. A fresh SELECT after the full read-back releases the action. Silence, a timeout, NO, PAUSE or a lost signal all mean no action.

**Proposed Oct 23. Team to confirm.**

### D5: Our own form-errand Actor, public on the Apify Store

Deterministic Playwright, not an LLM clicking. Preview by default, a form allowlist, and refusals for CAPTCHA, login, password, payment and upload.

**Locked Oct 23 by Stephen.**

### D6: Stephen owns Apify and Moss

Apify search, the form-errand Actor and Moss retrieval are Stephen's, alongside frontend work with Khadim.

**Locked Oct 23 by Stephen.**

### D7: Three live dashboard screens

All three update over SpacetimeDB subscriptions, so every laptop shows the same thing at the same moment.

1. **Live data.** The data actually flowing: the partner's words from Ink-2, the Apify rows that came back (with source and fetch time), the Moss hits, the options Claude drafted, the voice clip Sonic played, and how long each step took.
2. **Agents at work.** The agents doing their jobs: the form-errand Actor's preview screenshot, the values it read back off the page, the digest, the confirm, and the confirmation text after submit. Then the call: who is being called, ringing, connected, the live transcript, and how it ended.
3. **Live conversation.** The conversation itself: the partner's question, the four options as each is read aloud, the scan cursor moving, which option the person picked, and the reply that was spoken.

**Locked Oct 23 by Stephen.**

---

## Open Questions

- [ ] **Q1:** Which headset are we using? It decides which signals are possible (a Muse cannot read an imagined movement). Needs Shashank.
- [ ] **Q2:** Lock the SpacetimeDB table and reducer names in Shared Contracts. Needs Shashank.
- [ ] **Q3:** Demo form: a Google Form owned by the caregiver, or our own page on the dashboard domain? Needs Leon and Stephen.
- [ ] **Q4:** Can the free Cartesia phone number be set up without a card? Needs Shashank.
- [ ] **Q5:** Who plays the caller's recipient, and is their consent written down? Needs Leon.

---

_Last updated: Oct 23 by Stephen._
