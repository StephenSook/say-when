# NeuroLingo web

The live dashboard (Live data, Agents, Conversation) and the partner phone view for NeuroLingo, a screenless reply and errand assistant for a person who cannot speak or use their hands. A partner asks a question out loud; the system searches (Apify), recalls (Moss), drafts up to four options (Claude) and reads them into an earpiece (Cartesia); the person answers with a headset.

Next.js 16 App Router, React 19, TypeScript and plain CSS Modules, with the design tokens from `docs/ui.md` in `app/globals.css`. The npm package keeps the name `@say-when/web` until the repo is renamed.

## Run it

```bash
cd web
npm install
npm run dev         # http://localhost:3000 plays the sample replay
npm run typecheck   # next typegen, then tsc; works on a fresh clone
npm test            # node:test through tsx
npm run build
npm run bindings    # after every spacetime generate: copies spacetime/bindings/web into lib/data/module_bindings
npm run cartesia    # after any change in cartesia/src: copies the browser code into lib/cartesia
```

Routes: `/live`, `/agents`, `/conversation` (also `/`), and `/partner` for the phone. Keys 1, 2 and 3 switch the dashboard screens.

### Against the live database

The dashboard reads the SpacetimeDB module on Maincloud as an anonymous viewer: no token, no pairing, no login. Neither setting is a secret. Put them in `web/.env.local` for `next dev`, or pass them to the build, since Next.js writes `NEXT_PUBLIC_` values into the bundle at build time; on a host, set them in the project's settings.

```bash
NEXT_PUBLIC_SPACETIMEDB_HOST=https://maincloud.spacetimedb.com NEXT_PUBLIC_SPACETIMEDB_DB=say-when-dev npm run build
npx next start -p 3217     # http://localhost:3217/conversation shows say-when-dev, chip Live
```

The board shows the module's current or most recent session (`config.active_session_id`). To watch it move, run the module's smoke test from `spacetime/` (owner only, made-up content, about 90 s; `spacetime/README.md`, "Smoke test"); it starts a session, plays a station and a stand-in agent, ends the session and revokes its devices. `?replay=1` still plays the bannered sample replay on the same build.

## Where the rows come from

| Source | When | What the screens show |
|---|---|---|
| SpacetimeDB | `NEXT_PUBLIC_SPACETIMEDB_HOST` and `NEXT_PUBLIC_SPACETIMEDB_DB` are set | Live rows. A dropped connection shows Reconnecting with the last rows dimmed, then Offline after 10 s. It never falls back to the replay. |
| Sample replay | `next dev`, or `?replay=1` on any build | A loop of sample rows under the banner "Sample replay, not live data". The chip says Replay, never Live. |
| None | a production build with no settings, or `?replay=0` | "Not connected. No live data source is set up for this page." |

### How the live rows are wired

- **Bindings.** `lib/data/module_bindings` is a byte-for-byte copy of the module's generated web bindings (`spacetime/bindings/web`), so this app builds on its own: CI and the host install only `web/`. `npm run bindings` makes the copy, and `test/module-bindings.test.ts` fails while the two folders differ. Never edit the copy.
- **Subscriptions** (`lib/data/spacetime-bindings.ts`, loaded with a dynamic import, so the SDK ships in its own chunk): the public tables `config`, `scan_state` and `device_status`, and the anonymous views `public_board`, `board_payloads`, `board_errands`, `board_calls`, and since module v2 the session-scoped `board_events`, `board_session_ledger` and `board_word_timings` (`docs/spacetime.md` 7.1 and 14). The session views replace the unscoped `pipeline_event` table and `board_ledger` view, which grow with every session the database ever ran. `cue_event` is left out: no screen shows a cue yet.
- **Mapping** (`lib/data/spacetime-map.ts`, `boardRows`): only the board's session (`config.active_session_id`; the session views already hold only that one, and the filter stays as a guard); ids as strings; times in ms, moved onto the laptop's clock by the source (`lib/data/clock-offset.ts`); enum tags in snake case. Questions and options from `public_board`; pipeline steps from `board_events` with their shared payloads from `board_payloads` and the station's word timings from `board_word_timings`, both by event id; errands and calls from their board views; commands from the session ledger's gesture rows (an ignored one carries its reason in words); the scan clock from `scan_state`; the headset state from the scan's pause reason and the station's `device_status`.
- **What module v2 says outright** (`docs/spacetime.md` 14), so nothing is guessed: every read in the earpiece is one `started` speak step ("reading option", or "yes or no prompt") whose counts carry the option id, rank, pass and step; a select step is written only for a pick and names the option in its counts, so a select step is shown when it names an option and its label is not read; errand and call rows carry their own option id; a call row carries its read-back time, confirm window, the CONFIRM that released it, the command that stopped or hung it up, and `held`; and the scan row keeps its pick through a pause and the end of the session. The word timings are numbers only (milliseconds into the clip, no words), so the word mark puts the i-th timing on the i-th word on screen, scaled when the counts differ.
- **Older rows still read right:** a row written before module v2 (the recorded fixture) has a select step for every scan ending, but only a pick names its option, so the others drop out; an errand or call row without an option id gets its question's pick; and a scan row that lost its pick in a pause gets it from its question. A speak step gets its channel from its label ("aloud" or the earpiece). "Headset on" needs a live session with its station online and healthy; otherwise the chip says "Headset unknown".
- **Privacy.** Words reach the screens only while the room's sharing toggle is on (the module's views hold them back otherwise): with it off the screens show "Question N", "Option N", "Form" and "Contact". Memory text arrives only as `sharedText`. Free text goes through `maskPhoneNumbers`, and only http and https addresses become links or images. Word timings and the call's `held` flag are numbers and a yes or no, so they show with sharing off; the hold sentence then says "this contact", never a name.
- **Connection states are real:** Connecting until the subscription applies, then Live; a dropped socket shows Reconnecting with the last rows, Offline after 10 s, and Live again once the SDK's own reconnect replays the subscription.

The replay script is loaded with a dynamic import inside the effect that starts it, so it ships in its own chunk and a deployed page downloads it only with `?replay=1`.

## The sample replay

One loop takes 71 s and then repeats as a new question. Every name in it is obviously sample (Demo user, Demo caregiver, Cafe on Bay St, example.com links). It follows the module's decision table in `docs/spacetime.md` (sections 4.1 to 4.4).

1. The partner asks "Where can we get dinner near the hospital tonight?" Heard, searched (6 Apify rows), recalled (4 Moss hits: one shared memory, one private memory, two web passages), drafted: four options in four tones.
2. Option 1 is read; silence, so the scan moves on when its window closes. Option 2 is read; NO skips it. Option 3 is read; YES picks it, and after a 0.7 s veto (NO or STOP could still cancel it) the reply is said out loud. One repeat YES inside the refractory time is ignored.
3. Follow-up options: YES picks "Send the care team a dinner request." The form is filled, the values are read back off the page, the read-back plays, CONFIRM, and the form is sent with its confirmation text.
4. Another follow-up: YES picks "Call Demo caregiver to meet us there." The script is read back, CONFIRM, dialing, ringing, connected, transcript lines, and STOP hangs up: the call shows "Hanging up" until the line drops a moment later. A STOP during a call does not pause.
5. STOP while idle pauses and YES resumes; then the headset loses contact and YES resumes. Both safety banners show.

Each option's response window is 3.5 s, and the first option of each scan gets 4 s. The confirm window after a read-back is 8 s.

The scan clock's phases are idle, preparing, reading, window, veto and paused (`ScanPhase` in `lib/data/types.ts`).

## The command map (PLAN D11)

| Command | Signal | Means |
|---|---|---|
| YES | imagine squeezing the right fist | Pick this option, or answer yes. While nothing is happening, it opens the person's menu. |
| NO | imagine squeezing the left fist | Skip this option, or answer no. |
| CONFIRM | double jaw clench | The only way anything leaves the room (a form or a call), after the read-back. |
| STOP | long jaw clench, about 1 s | Cancel, none of these, hang up, pause. |

HEADSET_OFF is a system event, not a command the person gives. It and the 2-minute idle auto-pause cancel anything pending. Errands and calls are not gestures: Claude offers them as follow-up options, YES picks one, the read-back plays, and only a fresh CONFIRM matched to the read-back digest sends it. Silence moves on.

Honest wording: the jaw clench is a muscle signal and the imagined squeeze is the brain part. Never claim more than those two signals. The words for every command live in `lib/commands.ts`.

## Privacy on screen

- A Moss memory shows its text only when the hit carries `sharedText` (the person marked it shareable). Every other memory reads "Private memory" with its category. Render every hit through `hitDisplay(hit)`; the SpacetimeDB mapping also drops memory text before any screen sees it.
- Contacts by name only. Never show a phone number; run transcript lines through `maskPhoneNumbers`.

## For the screen builders

Each screen has its own file pair. Change only yours; everything else is shared.

| Screen | Files | Spec |
|---|---|---|
| Live data | `components/screens/LiveData.tsx`, `LiveData.module.css` | docs/ui.md Screen 1, docs/mockups/live.html |
| Agents | `components/screens/Agents.tsx`, `Agents.module.css` | docs/ui.md Screen 2, docs/mockups/agents.html |
| Conversation | `components/screens/Conversation.tsx`, `Conversation.module.css` | docs/ui.md Screen 3, docs/mockups/conversation.html |
| Partner phone | `components/screens/Partner.tsx`, `Partner.module.css` | docs/ui.md Screen 4, docs/mockups/partner.html |

The dashboard screens render inside the shell's `<main>` behind `ConnectionGate`, so rows exist when they render; do not render another `<main>`. The phone view has no header and no gate: it draws its own top row and handles loading and offline itself.

Hooks, from `@/lib/data/provider`:

| Hook | Returns |
|---|---|
| `useConnection()` | `{ status, mode, ready, reason, errorText, since, phase, dimmed, line }` |
| `useSourceMode()` | `'spacetime'`, `'replay'` or `'none'` |
| `useRows()` | every row |
| `useQuestions()`, `useCurrentQuestion()` | questions, oldest first; the newest one |
| `usePipelineEvents()`, `useQuestionEvents(questionId)` | the raw feed; one question's events |
| `useOptions(questionId)` | the newest option version, in reading order |
| `useSpokenReply(questionId)` | `{ text, spokenAt }` once YES picks a reply and the veto ends, or null |
| `useErrands()`, `useCalls()` | newest last |
| `useCommands()` | command events, ignored repeats included |
| `useScanState()` | the scan clock, or null |
| `useSafety()` | `{ state: 'unknown' or 'ok' or 'paused' or 'headset_off', since }` |
| `useHref(path)` | an in-app link that keeps `?replay` |
| `useNow(ms)` (`@/lib/use-now`) | a shared ticking clock, 0 during the server render |

Pure helpers: `lib/data/derive.ts` (`latestByStage`, `latestOfStage`, `timeToFirstOption`, `optionUnderCursor`, `pickedOption`, `litCommand`, `spokenReply`, `wordIndexAt`, `scanProgress`, `hitDisplay`), `lib/status.ts` (`STATUS_WORDS`, `statusFromPipeline`, `statusFromErrand`, `statusFromCall`, `callStatusWord`), `lib/commands.ts` (`COMMAND_INFO`, `commandChipLabel`, `commandWord`) and `lib/format.ts` (times, counts, `maskPhoneNumbers`). For the SpacetimeDB mapping: `lib/data/spacetime-map.ts` (`boardRows` turns the subscribed tables and views into these rows; `pipelineDetail` and `liveDetail` build an event's detail from its label, `counts_json` and the board's payload) and `lib/data/clock-offset.ts`.

Shared parts, from `@/components/ui`: `StatusMark`, `StepList`, `Row` and `RowList`, `Chip`, `Card`, `Bar`, `Spinner`, `StatusLine`, `TextLink`, `Dialog`, `PillInput` and the icons. From `@/components/shell`: `ConnectionChip`, `ConnectionGate`, `HeadsetChip`, `safetySentence`.

Rules for every screen: one clear focus with big labels, the docs/ui.md words, words plus an icon plus a color for every state, a visible focus outline, 16 px minimum body text, no sideways scroll at 390 px, reduced motion respected, and no sample data presented as real.

### Paired pages (station, speaker, partner asking)

These pages pair as a role and call reducers, unlike the anonymous dashboards (`docs/station.md` sections 1 and 7.2, track C). The shared parts:

| Where | What |
|---|---|
| `lib/role/storage.ts` | the identity token under `<host>/<db>/auth_token/<role>` in `localStorage`, and the station and speaker setup values; every access in a `try` |
| `lib/role/connection.ts` | `createRoleConnection`: one authenticated `DbConnection` per role page, token saved on connect, rebuilds after 1, 2, 4 and 8 s, Offline after 10 s, a refused saved token stops the retries |
| `lib/role/pairing.ts` | the pairing state machine (pure): a random 6-digit code, waiting, expiry, one retry on `code taken`, revoked, wrong role, labels only from a fixed list |
| `lib/role/device.ts` | `createRoleDevice`: connection, pairing and the voice check wired together, plus the owner's approve and revoke commands |
| `lib/role/calls.ts` | reducer errors by name, `sendWithResend` with an age limit, and `wordTimingsReducer` (null with bindings from before module v2) |
| `lib/role/hooks.ts` | `useRoleDevice`, `useAudioUnlock` |
| `lib/voice/token.ts` | `mint_voice_token` answers in words, and `getToken` for Cartesia sockets (a fresh 60 s token per socket, memory only) |
| `lib/voice/audio.ts` | the tap that starts audio, the chimes from Appendix A, the device change watch |
| `lib/cartesia/` | the cartesia browser code, a byte-for-byte copy of `cartesia/src` made by `npm run cartesia` |
| `components/device/` | `PairingCard`, `StartAudio`, `VoiceStatus`, `RoleConnectionChip` |
| `lib/routes.ts` | `/station` and `/speaker` get a bare frame (no tabs, no screen keys 1 2 3, no headset chip, no replay banner) and the board source never starts there; `/partner` keeps the phone frame |
| `lib/station/`, `components/station/` | the station: the engine, the heard log, commands and resends, the decoder bridge, keys and the switch pattern, the heartbeat, the earpiece, read-backs, cues, staleness and the screen's words |
| `lib/speaker/`, `components/speaker/` | the room voice: says each released reply once, then `reply_spoken` |
| `lib/partner/`, `components/partner/AskArea.tsx`, `PairPhone.tsx` | asking from the phone: Hold to ask with Ink-2 and the typed box, one sender with a request id |

No token is ever put in a page address, a link, a log line, an error message or the screen.

`lib/cartesia` drops the `.js` ending of each relative import (`stripJsSpecifiers` in `scripts/cartesia-files.json`): `next build` (Turbopack) does not resolve `./tts.js` to `tts.ts`, and `test/cartesia-copy.test.ts` applies the same rewrite before comparing.

The decoder runs on `ws://127.0.0.1:8765`. From an https page, Chrome 156 holds that socket in "connecting", with no error, until someone answers its local network permission prompt (checked Oct 24 in a Playwright Chrome on a Mac; `docs/station.md` 5.1); after 3 s the station says to click Allow. From `http://localhost` no prompt is needed.

## Checks

`npm test` runs the unit tests and `test/writing.test.ts`, which walks every source file in web/ and fails on an en or em dash, a curly quote, a word from the team's blocklist, the old product name, a retired command name, or a claim that goes beyond the two headset signals. `test/screen-models.test.ts` runs every screen's model over a loop of the sample replay, every 100 ms, and fails on a broken value on screen or on option words reaching the partner's phone.

For the live data: `test/board-map.test.ts` maps rows built with the generated binding types (`test/board-fixtures.ts`) and runs the screen models over them; `test/board-v2.test.ts` does the same for the module v2 rows (a speak step per read, word timings, picks only as select steps, option ids on errands and calls, a call's read-back, confirm window, stop command and hold, the pick through a pause); `test/board-recorded.test.ts` does the same over rows recorded from `say-when-dev` during a smoke session before module v2 (`test/fixtures/board-recorded.json`: made-up smoke content, identities zeroed), so older rows keep reading right; `test/spacetime.test.ts` checks the real bindings file subscribes to the ten tables and views and watches and reads each one; `test/module-bindings.test.ts` checks the bindings copy.

For the paired pages: `test/role-storage.test.ts`, `role-calls`, `role-connection`, `role-pairing` and `role-device` (against fakes of the SDK builder and connection, `test/role-fakes.ts`), `test/voice-token.test.ts`, `voice-audio`, `device-model`, and `test/cartesia-copy.test.ts`, which fails while `lib/cartesia` differs from `cartesia/src`; `test/station-*.test.ts`, `speaker-engine`, `speaker-page`, `partner-ask` and `routes`.

## Limits

- Fields marked "draft" in `lib/data/types.ts` are the screens' needs, not yet in PLAN.md. PLAN 1.2 locks the contracts. The types already include the changes `docs/spacetime.md` section 7.1 asks of the web app.
- Checked against `say-when-dev` on Oct 24 with the module's smoke test (sessions 6 and 7, made-up content, no wearer): Live data, Agents, Conversation and the phone followed the scan, the picks, an errand from preview to sent, the room's sharing toggle and the dead-man pause. Again after module v2 (sessions 9 to 11, about 7:00 to 7:12 AM PDT, a production build in a browser): Live data showed one speak step per read with its rank and pass, the read that got word timings, and select steps only for picks; Conversation followed the cursor and kept the pick through the dead-man pause and the session end; Agents showed the errand's own option and its confirm window counting down; the phone showed no option words. Not seen live yet: a call (the module's call rows), a real agent sidecar's search and recall steps with their payloads, and a real station reporting clips.
- A call's read-back time, confirm countdown, stop command and hold come from `board_calls` since module v2, but no call has run on `say-when-dev` yet (the smoke test has no call agent), so they are checked against rows built with the binding types (`test/board-v2.test.ts`), not seen live. The call agent reports Cartesia's end reason as a code (`api_cancelled`), which the screens leave out: `result` says the same in words.
- The smoke test reports its one word timing after the read it belongs to has ended, so the live word mark has not yet been seen moving on real timings; `test/board-v2.test.ts` covers it.
- With the room's sharing toggle off, "Said out loud" stays at "Nothing yet": the reply's words are private, and the screen has no words for "a reply was said, its words are not shared".
- The word marked in the option being read uses the station's word timings when the module has them for that read (`board_word_timings`), and Cartesia's timings in the sample replay. The station page reports them (`report_word_timings`) once a read has played; a read without them gets a mark spread over the clip, and its tooltip says so.
- "Hold to ask" and the typed box send questions only from a paired phone; an unpaired phone stays read-only. None of the paired pages has run against the live module with a voice yet: the module has no Cartesia key confirmed, so only silent keyboard tests can run (see `docs/station.md` 7.5 L1).
