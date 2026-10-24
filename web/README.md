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
```

Routes: `/live`, `/agents`, `/conversation` (also `/`), and `/partner` for the phone. Keys 1, 2 and 3 switch the dashboard screens.

## Where the rows come from

| Source | When | What the screens show |
|---|---|---|
| SpacetimeDB | `NEXT_PUBLIC_SPACETIMEDB_HOST` and `NEXT_PUBLIC_SPACETIMEDB_DB` are set | Live rows. A dropped connection shows Reconnecting with the last rows dimmed, then Offline after 10 s. It never falls back to the replay. |
| Sample replay | `next dev`, or `?replay=1` on any build | A loop of sample rows under the banner "Sample replay, not live data". The chip says Replay, never Live. |
| None | a production build with no settings, or `?replay=0` | "Not connected. No live data source is set up for this page." |

The SpacetimeDB module (`spacetime/`) and its generated web bindings (`spacetime/bindings/web`) exist, but this app is not wired to them yet, so a build with settings reports Offline: "This build has no SpacetimeDB tables wired in yet". `lib/data/spacetime-bindings.ts` lists the steps to wire them in. Once wired, the source moves every row time from the server's clock onto the laptop's clock (`lib/data/clock-offset.ts`), so countdowns stay right when the two clocks disagree.

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

Pure helpers: `lib/data/derive.ts` (`latestByStage`, `latestOfStage`, `timeToFirstOption`, `optionUnderCursor`, `pickedOption`, `litCommand`, `spokenReply`, `wordIndexAt`, `scanProgress`, `hitDisplay`), `lib/status.ts` (`STATUS_WORDS`, `statusFromPipeline`, `statusFromErrand`, `statusFromCall`, `callStatusWord`), `lib/commands.ts` (`COMMAND_INFO`, `commandChipLabel`, `commandWord`) and `lib/format.ts` (times, counts, `maskPhoneNumbers`). For the SpacetimeDB mapping: `lib/data/spacetime-map.ts` (`pipelineDetail` builds an event's detail from its label, `counts_json` and the board's payload) and `lib/data/clock-offset.ts`.

Shared parts, from `@/components/ui`: `StatusMark`, `StepList`, `Row` and `RowList`, `Chip`, `Card`, `Bar`, `Spinner`, `StatusLine`, `TextLink`, `Dialog`, `PillInput` and the icons. From `@/components/shell`: `ConnectionChip`, `ConnectionGate`, `HeadsetChip`, `safetySentence`.

Rules for every screen: one clear focus with big labels, the docs/ui.md words, words plus an icon plus a color for every state, a visible focus outline, 16 px minimum body text, no sideways scroll at 390 px, reduced motion respected, and no sample data presented as real.

## Checks

`npm test` runs the unit tests and `test/writing.test.ts`, which walks every source file in web/ and fails on an en or em dash, a curly quote, a word from the team's blocklist, the old product name, a retired command name, or a claim that goes beyond the two headset signals. `test/screen-models.test.ts` runs every screen's model over a loop of the sample replay, every 100 ms, and fails on a broken value on screen or on option words reaching the partner's phone.

## Limits

- Fields marked "draft" in `lib/data/types.ts` are the screens' needs, not yet in PLAN.md. PLAN 1.2 locks the contracts. The types already include the changes `docs/spacetime.md` section 7.1 asks of the web app.
- Live SpacetimeDB data has never reached these screens: the generated bindings are not wired in, and the module is not published yet.
- The word marked in the option being read uses Cartesia's word timings when a speak event carries them, as the sample replay does. The module does not publish per-option timings yet, so on live data the mark is an estimate spread over the clip, and its tooltip says so.
- "Hold to ask" on the phone opens the microphone and shows its level, but speech to text is not wired in, so the note under it says nothing is sent.
