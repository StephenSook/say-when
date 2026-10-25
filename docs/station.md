# Eleven station, speaker and partner asking: the design

For PLAN rows 5.6 (station page), 5.7 (speaker page) and 5.5 (the partner phone's asking flow). Design only: nothing in this doc has been built, installed or run. A build team starts from it.

- **Status:** version 1, Sat Oct 24, 2026. Written against `main` at `797eb61`: the module as described in `docs/spacetime.md` version 4 (with sections 11 and 13), the web app, `cartesia/` and `agent/` as committed. While this was written, another workflow had module v2 in the working tree, not yet committed or published (`docs/spacetime.md` section 14). The one v2 change the station uses is the new reducer `report_word_timings` (2.9); everything else here works on the published module. Before building, regenerate the bindings (`npm run bindings` in `web/`) and re-check every name in Appendix B.
- **Follows:** PLAN D4, D7, D10, D11, D12, D14 and rows 5.5 to 5.8; `docs/spacetime.md` 1.3, 2.9, 3.4, 4.1, 4.2, 5, 6.1, 7.1 to 7.3, 10.1, 11, 13, and the in-progress 14; `spacetime/README.md` "Review notes for client builders" and "Module v2"; `cartesia/README.md`; `docs/ui.md`; `agent/README.md`.
- **Owner:** Stephen (D6). Shashank owns the decoder that the station connects to (D14).
- **Read first:** section 0, then run the Chrome tests in section 5 (2 minutes each). Test 5.1 decides where the station page is served, so run it before anyone builds the decoder bridge.

| Tag | Meaning |
|---|---|
| **checked** | Read today in this repo's code; the file is named |
| **measured** | A number from the Maincloud smoke runs in `docs/spacetime.md` section 12 |
| **design** | Our choice in this doc |
| **UNVERIFIED** | Not confirmed by code we read or by any run |
| **UNTESTED** | A browser or device behavior nobody has run; section 5 has a 2-minute test |

Plain words, as in PLAN D13: the jaw clench is a muscle signal; the imagined fist squeeze is the brain test in `docs/brain-mode-test.md`. Nothing in this design knows what a person intends, and no screen may suggest it does.

---

## 0. The short version

1. Three role pages in the existing Next.js app: `/station` (role Station), `/speaker` (role Speaker), and asking on the existing `/partner` page (role Partner). Each pairs once with `request_pairing` and the owner's `approve_pairing`, keeps its SpacetimeDB token in `localStorage` under `<host>/<db>/auth_token/<role>`, and never puts a token in the page address.
2. The station never runs its own clock. It plays what `scan_state` says, and relays each command to `gesture(...)` with the step and option the wearer was actually hearing at the command's onset (the heard log, 2.6).
3. Input is the decoder over `ws://127.0.0.1:8765` (port confirmed by Shashank, Oct 24 8:45 AM PDT), or a labeled keyboard or USB switch. Key and switch presses carry `source` `key` or `switch`, the session label starts with `keyboard-` or `switch-`, and the station screen says so in words.
4. The station beats `heartbeat(beat_seq, decoder_healthy)` every `config.heartbeat_ms` (500) while it owns the session and its earpiece audio is running. `decoder_healthy` means "the person's input path is live" for the chosen mode.
5. Earpiece: Cartesia Sonic through a byte-for-byte copy of the cartesia browser code, one context per option, the option's own tone, the pronunciation dictionary id when one exists, every option of a version synthesized in rank order before its scan, stock phrases cached once. Each clip's length goes to `report_clip_ready` (the scan's dwell), and each read's word timestamps go to `report_word_timings` (module v2, in progress) so the board can mark the word being read.
6. Errands and calls: when the newest errand is Previewed (or the newest call is Prepared), the station reads it back in the steady voice with a fixed confirm sentence on the end, then calls `report_readback_done`. CONFIRM carries the digest of the read-back this station finished playing.
7. Speaker: says the newest released reply once in the reply voice, then calls `reply_spoken(question_id, clip_ms)`.
8. Partner: Hold to ask streams to Ink-2 only while held and sends `ask_question` with a UUID `request_id`, so a retry can never ask twice. The typed box uses the same call.
9. Highest risks: Chrome may block the deployed https page from opening `ws://127.0.0.1` (fallback: serve `/station` from `http://localhost:3000` on the EEG laptop); background or covered windows throttle the heartbeat; the module has no Cartesia key yet, so no voice works until Stephen publishes with one (open question O2).

---

## 1. Routes, roles and pairing

### 1.1 Routes

| Route | Role | Runs on | Pairs with role string | Public label (fixed list, no free text) |
|---|---|---|---|---|
| `/station` | Station | Chrome on the EEG laptop, wired earpiece | `station` | `station` |
| `/speaker` | Speaker | a laptop with a loudspeaker (a phone works, see 5.6) | `speaker` | `speaker` |
| `/partner` (asking) | Partner | the partner's phone | `partner` | `partner phone 1`, `partner phone 2` or `partner phone 3` |
| `/live`, `/agents`, `/conversation`, `/judge` | none | any browser | never pair | |

Labels are public in `device_status` (**checked**: `spacetime/src/schema.ts`; `docs/spacetime.md` 13.2). The page offers only the fixed labels above, so nobody types a name into a public field (**design**).

### 1.2 Pairing, step by step

Calls used (**checked**: `spacetime/src/index.ts`): `request_pairing(code u32, role string, label string)` by the device; `approve_pairing(code u32, caregiver bool)` and `revoke_device(identity)` by the owner from the CLI; the public table `device_status`; the procedure `mint_voice_token(purpose)`.

1. **Load.** Read the SpacetimeDB token from `localStorage` key `<host>/<db>/auth_token/<role>`. `host` is `NEXT_PUBLIC_SPACETIMEDB_HOST` exactly as set and `db` is `NEXT_PUBLIC_SPACETIMEDB_DB`. Example: `https://maincloud.spacetimedb.com/say-when-dev/auth_token/station`. Two role pages in one browser never share an identity (`docs/spacetime.md` 1.3).
2. **Connect** with `.withToken(token)` (undefined on a first visit). `onConnect(conn, identity, token)`: save the token under the key when it differs. A first visit gets a new identity and token from the server (**checked**: SDK `db_connection_builder.d.ts` `onConnect`).
3. **Am I paired?** Subscribe to `device_status`. If a row has `identity` equal to mine and its `role` matches the page: paired; run the voice check (1.3). If the role differs: show "This browser's station identity is paired as speaker. Ask the owner to revoke it, or forget this device." (should not happen, since keys are per role).
4. **Not paired:** show the pairing card.
   - Code: a random whole number from 100000 to 999999 from `crypto.getRandomValues`.
   - Call `request_pairing(code, role, label)`.
   - Show the code in large digits (`482 913`) and the owner's command, with a copy button: `spacetime call --no-config --server maincloud say-when-dev approve_pairing 482913 false`. The last argument is `true` only for a caregiver's phone (a caregiver Partner may grant consent and flip board sharing; **checked** `requireOwnerOrCaregiver` in `auth.ts`).
   - Show the time left from `config.pairing_ttl_ms` (300000 by default; **checked** `config.ts`).
   - Wait for my `device_status` row to appear. `approve_pairing` writes `device` and `device_status` in one transaction (**checked**).
   - Refusals: `code taken: pick a new code`: draw a new code and ask again, once. `already paired`: read `device_status` again. After expiry the module deletes the request (`pairing_expired`); show "Code expired" and a New code button. A new `request_pairing` from the same identity replaces its older request (**checked**).
5. **What a person types or scans:** nothing on the device. The owner reads the 6 digits off the device and types them into the CLI on the owner's laptop (about 1.1 to 1.7 s per CLI call, **measured**). The partner opens `/partner` by typing the address or scanning a QR code that holds only the address. No QR code or link ever holds a token (**design**).

### 1.3 Reload, voice check, revocation, forget

- **Reload:** the same token gives the same identity, and the device row is keyed by identity, so the page is paired again as soon as it connects (**checked**: `device` primary key `identity`). The station must also take its session back explicitly (2.10).
- **Voice check:** after pairing and after every load, call `mint_voice_token(purpose)` once: `tts` for station and speaker, `stt` for partner. Answers (**checked**: `index.ts`, `voice.ts`):

| Answer | Meaning | Page shows |
|---|---|---|
| a token | paired, voice works | "Voice ready" (the token opens the first Cartesia socket) |
| `not_paired_for_purpose` | revoked, or the wrong role | the pairing card again: "This device is not paired anymore." |
| `voice_key_missing` | paired; the module has no `CARTESIA_API_KEY` | "Voice off: the database has no Cartesia key." (open question O2) |
| `voice_service_unreachable`, `voice_service_<status>`, `voice_bad_response` | Cartesia did not answer or refused | "Voice service problem (`<code>`)." Retry button |
| `bad_purpose` | a bug in the page | shown as is |

- **Revoked:** `device_status` keeps the row after `revoke_device` (it only sets `online` to false; there is no public revoked flag, **checked**). The page learns it from any role call: a reducer rejects with `not allowed`, or the mint answers `not_paired_for_purpose`. Show the pairing card. Approving the same identity again un-revokes it (**measured**, `spacetime/README.md`).
- **Revoking the session's station** pauses the scan with reason Operator, and only the owner lifts it with `operator_resume` (**checked**: `revokeDevice`, `operatorResume`).
- **Forget this device:** a text link that deletes the key and reloads, which gives a new identity. The page shows the first 8 hex characters of its identity and copies the full hex for the owner's `spacetime call --no-config --server maincloud say-when-dev revoke_device 0x<identity>` (identities are not secrets).

### 1.4 Tokens

| Token | Stored | Lives | Sent where |
|---|---|---|---|
| SpacetimeDB identity token, one per role per browser profile | `localStorage` key `<host>/<db>/auth_token/<role>` | until forgotten; whether Maincloud tokens expire is **UNVERIFIED** (test in 5.7) | the SDK POSTs it in an `Authorization` header to `/v1/identity/websocket-token`, then opens the WebSocket with the short-lived token it gets back in the query (**checked**: `spacetimedb` 2.13.0 `dist/sdk/index.browser.mjs`) |
| Cartesia access token | memory only, one per Cartesia socket | 60 s, one grant (`tts` or `stt`, never `agent`) | the Cartesia `wss://` address as `access_token=`, the documented browser method, because a browser cannot set WebSocket headers (**checked**: `cartesia/src/ws.ts` `socketUrl`; `cartesia/README.md`) |

Never in the page address, a link, a QR code, a log line, an error message or the screen. A page address ends up in history, server logs, screenshots, shared links and `Referer` headers.

Why `localStorage` is acceptable here (**design**):

- Each token is one device with one narrow role, and the owner revokes it with one CLI call.
- Only scripts from our own origin can read it. The app loads no third-party scripts: fonts come through `next/font/google` (**checked**: `web/app/layout.tsx`), which downloads them at build time and serves them from our origin (**UNVERIFIED** for this build; check the Network tab once). The remaining exposures are a script injection bug in our code or someone at the device.
- `sessionStorage` would drop the pairing when a tab closes, mid-demo. A cookie would ride along on every request, and the SDK needs the token in JavaScript anyway.
- The station token can send CONFIRM. The module still demands the read-back digest, the quiet hold, the window, good contact and consent (**checked**: `consent.ts` `gateReason`), but a stolen station token can read `my_session`, which holds the digest. That is the trust model in `docs/spacetime.md` 10.1 item 14. So: a dedicated Chrome profile on the EEG laptop, nobody else's scripts on the origin, revoke and `purge_session` after the event.
- Every `localStorage` read and write sits in a `try`: a private window can throw.

### 1.5 One connection per role page

Each role page opens its own `DbConnection` with its role token, outside React (a plain module), and registers the callbacks that drive audio (`scanState.onUpdate`, `cueEvent.onInsert`, `mySession.onUpdate`) once at connect, never in a render (`docs/spacetime.md` 7.1). Subscriptions use the generated query builder (`tables.scanState` and so on, from `web/lib/data/module_bindings`), never SQL strings: `web/test/writing.test.ts` fails on the word `SELECT` in any non-test file (**checked**).

| Page | Subscribes | Calls |
|---|---|---|
| Station | `config`, `scan_state`, `device_status`, `cue_event`, `my_session`, `my_options` | `request_pairing`, `start_session`, `end_session`, `heartbeat`, `gesture`, `report_clip_ready`, `report_readback_done`, `report_word_timings` (module v2); `mint_voice_token('tts')` |
| Speaker | `config`, `scan_state`, `device_status`, `my_session` | `request_pairing`, `reply_spoken`; `mint_voice_token('tts')` |
| Partner (asking) | `config`, `device_status` | `request_pairing`, `ask_question`, `partner_listening`; `mint_voice_token('stt')` |

Call shapes in the generated web bindings (**checked**: `web/lib/data/module_bindings/*_reducer.ts`, `mint_voice_token_procedure.ts`):

```ts
conn.reducers.gesture({ gestureId, command, heardStepSeq /* bigint */, heardOptionId /* bigint */, heardDigest, confidence, source, onsetAgeMs })
conn.reducers.heartbeat({ beatSeq /* bigint */, decoderHealthy })
conn.reducers.reportClipReady({ optionId /* bigint */, clipMs, synthMs })
conn.reducers.reportReadbackDone({ kind /* 'errand' | 'call' */, id /* bigint */, digest })
conn.reducers.startSession({ label }); conn.reducers.endSession({})
conn.reducers.replySpoken({ questionId /* bigint */, ms })
conn.reducers.askQuestion({ requestId, text, via /* 'voice' | 'typed' */, listenMs })
conn.reducers.partnerListening({ requestId, on })
conn.reducers.requestPairing({ code, role, label })
conn.procedures.mintVoiceToken({ purpose })   // resolves to { token, expiresAtMs /* bigint */, error }
// Module v2, in the working-tree bindings (spacetime/bindings/web/report_word_timings_reducer.ts), not yet on main:
conn.reducers.reportWordTimings({ stepSeq /* bigint */, optionId /* bigint */, startsMs /* number[] */, endsMs /* number[] */ })
```

Every reducer promise rejects with `SenderError` (the module refused; never retry), `DisconnectedError` (not sent) or `UnknownCallResultError` (the connection dropped before the answer; it may have run) (**checked**: `spacetimedb/dist/lib/errors.d.ts`). Classify by `error.name`.

Connection rules (**design**, the same as `web/lib/data/spacetime.ts`): `withAutomaticReconnect({ minDelayMs: 1000, maxDelayMs: 8000 })`; the SDK never retries a failed first connect, so rebuild after 1, 2, 4 then 8 s; "Offline" after 10 s without a live connection.

Per-identity views over WebSocket: the smoke watcher (Node, not a browser) subscribed to `agent_queue` and `errand_queue` on Maincloud and acted on them (**measured**). `my_session`, `my_options` and `partner_view` have never been subscribed to on Maincloud, from a browser or otherwise (**UNVERIFIED**; live run L1 in 7.5 covers it).

The partner phone keeps the anonymous board connection that `DataProvider` already opens (its status view reads those rows) and adds the role connection for asking: two sockets on the phone, and no change to the shared provider for `/partner` (**design**).

### 1.6 Frames and the dashboards' provider

- `web/components/shell/Shell.tsx`: `/station` and `/speaker` get a bare frame: no tabs, no keys 1 2 3, no headset chip, no replay banner. `/partner` keeps `PhoneFrame` (**design**).
- `web/lib/data/provider.tsx`: when the path at mount is `/station` or `/speaker`, start no source (keep the pending source). The EEG laptop has 8 GB and should not run the board mapping it never shows (**design**).

---

## 2. The station (`/station`)

### 2.1 Parts

Plain TypeScript classes in one engine, outside React. React renders a snapshot from a small store (the pattern of `createStateStore` in `web/lib/data/source.ts`).

```
 decoder ws://127.0.0.1:8765 ---> DecoderBridge --+
 keyboard or USB switch -------> KeyInput -------+--> CommandSender ---> gesture(...)
                                                  |        ^ heard_step_seq, heard_option_id, heard_digest
 scan_state, my_options -------> HeardLog <-------+--------+   (filled from real audio start times)
 scan_state, my_options, cues -> Earpiece: TtsPlayer, PhraseCache, two AudioOut, chimes
 my_session.errand / .call ----> ReadBack ---> report_readback_done
 worker tick every heartbeat_ms -> Heartbeat ---> heartbeat(beat_seq, decoder_healthy)
```

### 2.2 The screen

One focus: what is in the earpiece now. Tokens and words from `docs/ui.md`.

```
+--------------------------------------------------------------------------------------------+
| Eleven station    (o Live)  (Decoder healthy)  (Earpiece on)  (Voice ready)            |
+--------------------------------------------------------------------------------------------+
| Keyboard test input. These are key presses, not headset signals.     (keyboard mode only)  |
+--------------------------------------------------------------------------------------------+
|  In the earpiece now                                                                       |
|  Option 2 of 4, warm                                                    --text-hero        |
|  "<option words: only while board sharing is on>"                                          |
|  [==========---------]  window, 2.1 s left                                                 |
|                                                                                            |
|  Last commands                                                                             |
|  12:41:06   YES   jaw     Picked option 2                                                  |
|  12:41:02   NO    jaw     Skipped option 1                                                 |
|  12:40:58   YES   jaw     Ignored: repeat inside the refractory time                       |
|                                                                                            |
|  Session 7, headset-demo, running.    End session                                          |
|  Heartbeat every 500 ms. Module round trip 95 ms. Earpiece start lag 80 ms.               |
+--------------------------------------------------------------------------------------------+
```

- Words on this screen follow the room's toggle `config.share_text_on_board`: with it off the hero says "Option 2 of 4, warm" and a word-progress bar, never the words (**design**: the station is in the room).
- Keyboard legend in keyboard mode, in large text: `Y = YES   N = NO   C = CONFIRM   S = STOP   H = headset off (test)`.
- Before a session: a step list. Paired, Voice ready, Input mode picked (2.3), Earpiece on (Start audio button), Phrases ready (N of 34), Input ready, then Start session with the purpose picker (demo or test).
- Errand or call in progress: "Getting it ready", "Reading it back", "Waiting for your confirm" with a countdown bar drawn from durations, "Confirmed", "Sending", "Sent" or "Not sent: <reason>".
- Every state in words with an icon, never color alone (`docs/ui.md`).

### 2.3 Input modes and session labels

| Mode | Commands come from | `source` sent | Session label | `decoder_healthy` in heartbeats |
|---|---|---|---|---|
| Headset | decoder messages only | the decoder's own `source` (`imagery`, `jaw`, ...) | `headset-demo` or `headset-test` | the decoder socket is open, the last health message is at most 500 ms old, and it said `true` |
| Keyboard test | keys Y, N, C, S, H | `key` | `keyboard-test` | the page is visible (`document.visibilityState === 'visible'`) |
| USB switch | one learned key, jaw-only pattern (2.5) | `switch` | `switch-demo` or `switch-test` | the page is visible and focused; a focus loss counts only after 2 s |

- The mode is picked before Start session and is fixed for the session. In headset mode the keys do nothing except show "Keys are off in headset mode." In keyboard and switch modes the decoder is not used (**design**).
- The label goes into the public ledger as the `session_start` row's `outcome` (**checked**: `startSession`; the label must match `^[a-z0-9_-]{1,20}$`). The dashboards can read the input mode from it (request W1, section 9).
- A USB switch types like a keyboard, so the page cannot tell a switch from a keyboard. The operator declares it, and the screen says "USB switch input. These are switch presses, not headset signals."

### 2.4 Decoder bridge

**Contract** (PLAN Shared Contracts, Shashank owns it; `docs/spacetime.md` Appendix A):

```json
{ "type": "gesture", "id": "<uuid>", "command": "YES", "onsetAgeMs": 840, "confidence": 0.82, "source": "imagery" }
{ "type": "health", "decoderHealthy": true }
```

`command` is `YES`, `NO`, `CONFIRM`, `STOP` or `HEADSET_OFF`. `health` comes at least every 250 ms. The decoder never calls SpacetimeDB on this path.

| Item | Rule |
|---|---|
| Address | `ws://127.0.0.1:<port>`, port 8765 by default (confirmed by Shashank, Oct 24 8:45 AM PDT; `switch/` is empty today, **checked**). The port is a field on the setup screen, kept in `localStorage` key `neurolingo/station/decoder_port`. |
| When | Open in headset mode only, as soon as the page is paired, with or without a session, so the screen shows decoder health before Start session. |
| Reconnect | On close or error: wait 500 ms, then 1 s, then 2 s, then every 2 s, forever while in headset mode (**design**: it is local, and the decoder may restart). |
| Frames | Text frames only; binary frames are ignored. Each frame is one JSON object. |
| `health` | Store `{ healthy, at }` with `at = performance.now()`. Fresh means at most 500 ms old (two missed messages; `docs/spacetime.md` 7.2 item 5). A change from healthy to not healthy sends one extra heartbeat at once instead of waiting for the next tick, and stops option audio locally at once. |
| `gesture` | Stamp `receivedAt = performance.now()`; `onsetLocal = receivedAt - onsetAgeMs`. Validate (next row), then hand it to the command sender (2.7). |
| Validation | Unknown `type`: ignore and count. `command` not one of the five words: drop, count, show "Bad decoder message". Bad or missing `id` (must match `^[A-Za-z0-9:_-]{1,64}$`, **checked** `GESTURE_ID_RE`): use a fresh UUID so a STOP is never lost, and show "Decoder id replaced" (the decoder's own log can no longer be matched to that command). `source` not matching `^[a-z_]{1,16}$` (**checked** `SOURCE_RE`): send `decoder`. `onsetAgeMs` missing or negative: 0. `confidence` missing or out of 0 to 1: clamp, missing is 0. |
| Repeats | Keep the last 500 relayed ids; a repeated id from the decoder is not relayed again. |
| No ack | The station sends nothing back to the decoder (the contract has no ack). |

**Decoder health chip:** "Decoder healthy"; "Decoder says the headset is not ready" (health `false`); "Decoder silent" (socket open, no fresh health); "Decoder not found on 127.0.0.1:8765" (socket not open).

**Decoder missing:** in headset mode Start session stays disabled with "Start the decoder, or switch to keyboard test." If it goes away mid-session, heartbeats say `false`, the module pauses with HeadsetOff (**checked**: `heartbeat`), the wearer hears "Headset off. Nothing will be sent.", and the module resumes on its own after 3 s of healthy beats once the decoder is back (`auto_resume`, `resume_good_contact_ms`; **checked**). The station never makes up a HEADSET_OFF command: only the decoder or the H test key sends one (**design**).

### 2.5 Keyboard test and USB switch

**Keyboard test keys** (**design**). One capturing `keydown` listener on `window`, active only in keyboard mode during a session. It calls `preventDefault()` on mapped keys, ignores `event.repeat` and any key held with Cmd, Ctrl or Alt.

| Key | Command | Onset |
|---|---|---|
| Y | YES | `event.timeStamp` of the keydown (same time base as `performance.now()` in Chrome, **UNVERIFIED** for every browser) |
| N | NO | same |
| C | CONFIRM | same |
| S | STOP | same |
| H | HEADSET_OFF (labeled "test" on screen) | same |

**USB switch, jaw-only pattern on one key** (**design**, the fallback map in `docs/brain-mode-test.md`):

| Press | Command | Emitted when | Onset |
|---|---|---|---|
| short press, no second press within 400 ms of its release | YES | 400 ms after the release | the keydown |
| two presses, the second keydown within 400 ms of the first release | CONFIRM | at the second keydown | the first keydown (so the whole double press must fall after the quiet hold) |
| held 1000 ms | STOP | when the hold reaches 1000 ms | the keydown |
| (none) | NO is silence | | |

- The setup screen learns the switch's key: "Press your switch now" stores `event.code` in `localStorage` key `neurolingo/station/switch_key`.
- A switch that sends Enter or Space would also click a focused button. The capturing listener calls `preventDefault()` and `stopPropagation()` for the learned key, and session buttons are not focusable while a switch session runs.
- A real jaw-only demo with the headset is the decoder's job: its messages arrive with `source: "jaw"`. The switch mode is for a physical switch or a keyboard stand-in.

**How nothing is passed off as headset input:**

| Where | What records the source |
|---|---|
| Module | `gesture_log.source` is `key` or `switch` for every press (**checked**: `handleGesture` stores `a.source`). `gesture_log` is private; the owner reads it with `spacetime sql`. |
| Station screen | the banner above, and every command line shows its source word (`YES  key`). |
| Public board | today it cannot show a source: `board_ledger` rows have no source column, and the web maps commands from the ledger only (**checked**: `schema.ts` `ledger`, `web/lib/data/spacetime-map.ts` `commandsFromLedger`). The session label is public, so W1 (section 9) makes the dashboards say "Keyboard input" instead of "Headset on" for `keyboard-` and `switch-` sessions. R1 adds the source per command. Until W1 lands, the presenter says out loud that the keys are a stand-in. |
| Telemetry | `telemetry.switch_events` has no source column (**checked**: `telemetry/README.md`), so keyboard sessions would count as headset events. Request T1, section 9. |

### 2.6 What was heard: the heard log

The module picks the option by the step the station says the wearer heard: the current option if `option_start_seq <= heard_step_seq <= step_seq`, the previous option if the step changed no more than `grace_ms` ago, else `ignored:stale_step`; a non-zero `heard_option_id` that disagrees is `ignored:heard_mismatch` (**checked**: `gesture.ts` `resolveHeard`). So the station must send the step the wearer was hearing at the onset, measured by when the audio actually played, not by when the row arrived (**design**; this refines `docs/spacetime.md` 7.2 item 3, which used the row's arrival time).

Each `scan_state` update for the active session with a higher `step_seq` adds one entry:

| Phase in the update | Entry's `optionId` | Entry's `heardFromMs` |
|---|---|---|
| Reading, answer mode Pick, cursor >= 1 | the `my_options` row with this `question_id`, `version` and `rank = cursor` | empty until that clip starts playing; then `playStart + HEARD_MARGIN_MS` |
| Reading, answer mode YesNo (cursor 0) | 0 | empty until the "Yes or no?" prompt starts playing; then `playStart + HEARD_MARGIN_MS` |
| Window | the same option as its Reading entry | the arrival time; if that option's clip never played, the entry is marked unheard |
| Preparing, Veto, Idle, Paused | 0 | the arrival time |

- `playStart = performance.now()` at the moment of `play()`, plus the 50 ms lead of `AudioOut` (**checked**: `leadSeconds = 0.05` in `cartesia/src/tts.ts`), plus `(audioContext.outputLatency + audioContext.baseLatency) * 1000` when the browser gives them (**UNVERIFIED** values; a Bluetooth earpiece can add a few hundred ms, so use a wired one).
- `HEARD_MARGIN_MS = 200` (**design**): nobody can react to an option's words within 200 ms of its first sound, so an onset that early belongs to the option before. Tune it from recordings; keep it in one constant.
- A Reading entry whose clip has not started is skipped by the lookup; once its step is over without audio, it and its Window entry are marked unheard and skipped for good (fail closed).
- **Lookup at onset T:** walk from the newest entry back; skip entries that are empty or unheard; return the first entry with `heardFromMs <= T`. No entry: return step 0 and option 0, which the module treats as stale for a pick (**checked**: `resolveHeard` fails `stale_step` when `heard_step_seq` is below `prev_option_start_seq`).
- Keep 60 s of entries.
- Silent test mode (2.9) has no audio, so every entry uses its arrival time.

### 2.7 From a command to a `gesture(...)` call

Every command from any input goes through one sender (**design**):

1. Play the local sound for that command at once (Appendix A, chimes). The sound says "your signal reached the station", not "it counted".
2. Build the arguments:

| Argument | YES | NO | CONFIRM | STOP | HEADSET_OFF |
|---|---|---|---|---|---|
| `gesture_id` | the decoder's id, or a new UUID for keys, switch, or a bad decoder id | same | same | same | same |
| `command` | `YES` | `NO` | `CONFIRM` | `STOP` | `HEADSET_OFF` |
| `heard_step_seq` | heard log at the onset | same (logged) | same (logged) | same (logged) | same (logged) |
| `heard_option_id` | heard log at the onset (0 in yes or no mode) | same | same (logged) | same (logged) | same (logged) |
| `heard_digest` | `''` | `''` | see below | `''` | `''` |
| `confidence` | decoder value; keys and switch `1` | same | same | same | same |
| `source` | decoder `source`; `key`; `switch` | same | same | same | same |
| `onset_age_ms` | see below | same | same | same | same |

- **`heard_digest` for CONFIRM:** if `my_session.errand` is Drafted, Previewed, AwaitingConfirm or Confirmed, the digest this station recorded when it finished playing that errand's read-back (2.11); otherwise, if `my_session.call` is Prepared, AwaitingConfirm or Confirmed, the same for the call; otherwise `''`. This matches the module's order, errand before call (**checked**: `onConfirm`, `pendingWork`). A digest is recorded only when the read-back audio ended on its own (`play()` resolved `'ended'`), never when it was cut off. No recorded digest means `''`, which the module refuses (`ignored:digest_mismatch`): fail closed.
- **`onset_age_ms`** = `performance.now()` at the moment of the call, minus `onsetLocal`, plus `oneWayMs`; rounded and clamped to 0 to 600000. `onsetLocal` is `receivedAt - onsetAgeMs` for a decoder command (2.4) and the keydown's time for a key or switch (2.5). `oneWayMs` is half the median round trip of the last 20 heartbeats (the time from the call to its promise resolving). A resend recomputes it. The module uses this age only for CONFIRM's quiet hold, `onset >= confirm_opens_at` (**checked**: `gateReason`); a larger age makes that check stricter, so the error falls on the safe side (**design**).
3. Call `conn.reducers.gesture(...)`.
4. On the answer:

| Answer | YES, NO, CONFIRM | STOP, HEADSET_OFF |
|---|---|---|
| resolves | done; read the outcome (step 5) | same |
| `SenderError` | never retry. Show the message. `not allowed`: pairing card. `not the session station` or `no active session` (from other calls): stop relaying and show the session card. Anything else is a bug: show it. | same |
| `DisconnectedError` | after the reconnect, send the same `gesture_id` and arguments with a fresh `onset_age_ms`, if the onset is less than 3 s old; else drop and show "Not sent: connection" | same, if less than 30 s old |
| `UnknownCallResultError` | same as above (a repeated id with the same command returns quietly in the module, **checked**) | same |

5. **Outcome:** when the call resolves, read `my_session.last_gesture_id` and `last_gesture_outcome`; if the id is not ours yet, take it from the next `my_session` update, waiting at most 1 s (whether the view update arrives before the promise resolves is **UNVERIFIED**). Put it in the command list with `ignoredReasonWords` from `web/lib/data/spacetime-map.ts` (**checked**, exported).
6. **Earpiece feedback for the outcome** (**design**; accepted commands also produce module cues, 2.13):

| Outcome | Earpiece |
|---|---|
| `accepted:pick`, `accepted:answer_yes`, `accepted:answer_no`, `accepted:pick_errand`, `accepted:pick_call`, `accepted:menu_item` | nothing here; the module's `picked` cue plays the "counted" chime (it is emitted for every pick and yes or no answer, **checked**: `pickOption`, `onYes`, `onNo`) |
| `ignored:quiet_hold` | "Too soon. Wait a moment, then {act}." (the module has restarted the hold, **checked**) |
| `ignored:stale_step`, `ignored:heard_mismatch`, `ignored:no_contact`, `ignored:digest_mismatch` | the "not counted" chime |
| `ignored:refractory`, `ignored:veto`, `ignored:already_passed`, `ignored:already_paused`, `ignored:idle`, `ignored:paused`, `ignored:busy` | nothing |
| `ignored:not_ready`, `ignored:yes_is_not_confirm`, `ignored:too_late` | nothing here; the module's cue speaks (`not_ready`, `say_confirm`, `too_late`) |

`{act}` is "clench once" in headset mode (a single clench is CONFIRM, PLAN D17), "press C" in keyboard mode, "press twice" in switch mode.

What each command does in each state is the module's decision table (`docs/spacetime.md` 4.2 and section 13 rows 10, 13, 18; **checked** in `gesture.ts`). The station does not second-guess it.

### 2.8 Heartbeat

- **Tick:** a dedicated Web Worker posts a tick every `config.heartbeat_ms` (500 by default, 200 to 2000 allowed, **checked**); the page sends one `heartbeat` per tick. The worker is there because Chrome slows main-thread timers in hidden or covered windows (**UNTESTED**, 5.2; fall back to `setInterval` if the worker does not help). Re-arm when `config.heartbeat_ms` changes.
- **Arguments:** `beat_seq` starts at `BigInt(Date.now())` when the page loads and adds 1 per beat, so it keeps rising across reloads. `decoder_healthy` is the value from 2.3 for the session's mode.
- **First beat:** right after `start_session` resolves, and right after "Continue session" (2.10). The first lease is already counting (**checked**: `start_session` inserts it with `decoder_healthy = false`).
- **Extra beat:** at once when the input goes from healthy to not healthy, so the pause does not wait for the next tick.
- **Round trip:** time each beat from call to resolve; show the median; use it for `oneWayMs` (2.7). A beat with no answer after 3 s marks "Connection problem" on screen.

| Beats are sent while | Beats stop when |
|---|---|
| the connection is live (skip ticks while it is down; do not queue them) | `end_session` resolves, or `my_session` shows no active session |
| this station owns the active session (its `start_session` or a Continue that beat successfully) | a beat rejects with `not the session station`, `no active session` or `not allowed` |
| the earpiece is running: the `AudioContext` state is `running` and the chosen output device is present (silent test mode skips this) | the earpiece stops running: no `AudioContext`, a suspended one after a reload, or the earpiece device unplugged (5.5) |

- Stopping the beats is how the station makes the module pause when the wearer cannot hear the scan: the lease lapses and the module pauses with HeadsetLost about 1.5 s later (**measured**: 1501 to 1502 ms). The module has no "station audio failed" reason, so the ledger says `headset_lost`; R4 in section 9 would fix the word (**design**).
- Beats do not stop for a hidden tab (they may slow down, 5.2) or for an unhealthy input (they carry `false` instead).
- Energy: about 7,200 calls an hour while a session runs (`docs/spacetime.md` 9.4). Beat only during a session.

### 2.9 Earpiece audio

**Player and voices** (**checked**: `cartesia/src/tts.ts`, `tones.ts`):

- One `TtsPlayer({ getToken: () => mintVoiceToken('tts'), pronunciationDictId, maxActive: 1 })`. `getToken` is called once per socket, so the player mints a fresh 60 s token whenever it opens or reopens its socket. Whether Cartesia closes an open socket when its token expires is **UNVERIFIED** (`cartesia/README.md` item 8); if it does, any generation in flight fails with code `closed`, and the station retries that utterance once.
- The Free plan allows 2 TTS contexts at once per account (`cartesia/README.md`, from Cartesia's docs, not run). The station uses 1 and the speaker uses 1, so that is the whole budget. Never open a second station or speaker tab. Whether Managed Agent calls count against it is **UNVERIFIED**.
- `voiceProfile()` defaults: Skylar (assistant voice) for prompts and read-backs at the person's pace, Tessa (reply voice) for options and replies. The station's setup screen keeps two speeds in `localStorage` (`assistantSpeed` 0.6 to 1.5, `optionSpeed` 0.6 to 1.5 or unset); changing one empties the phrase cache, because speed is part of its key (**checked**: `PhraseCache.key`).
- **Tones:** each option is `utterance({ kind: 'option', text, tone, laugh }, profile)`. The planner gives each option its own tone from `neutral`, `calm`, `warm`, `sad`, `firm` (four options, four different tones; **checked**: `agent/README.md` strict checks), mapped to Sonic emotions (`warm` to `content`, `firm` to `angry`; **checked**). An unknown tone sends no emotion. Emotion is Beta and has had no listening test (**UNVERIFIED**).
- **Pronunciation dictionary:** pass `NEXT_PUBLIC_CARTESIA_DICT_ID` when set (an id, not a secret: `cartesia/README.md`). No dictionary exists yet (`dict:sync` has not run), so leave it unset until one does. Without it, names may be said wrong; nobody has heard Sonic say "Eleven" (PLAN row 3.5).
- **Word timestamps:** every clip carries `words` (**checked**: `add_timestamps: true`). While an option or read-back plays, the station screen marks `wordAt(clip.words, out.positionMs())` on each animation frame, only while sharing is on. The same timings, as numbers only, go to the module for the board (`report_word_timings`, below). Whether later timestamps count from the clip start is **UNVERIFIED** (`cartesia/README.md` item 9).

**Two outputs and the chimes** (**design**): `optionsOut = new AudioOut(ctx)` for options and read-backs; `promptOut = new AudioOut(ctx)` for stock phrases; chimes and command ticks are short `OscillatorNode` beeps straight into `ctx.destination`, so they mix over speech instead of cutting it. `AudioOut.play()` stops whatever that output was playing (**checked**), which is why options and prompts use different outputs.

**Start audio:** a button. Its click creates the one `AudioContext` and calls `resume()`; Chrome starts audio only after a user gesture (**UNTESTED**, 5.3). After a reload the page needs this click again, and until then the heartbeats are off (2.8), so the module pauses: the safe outcome. The same click asks for a Screen Wake Lock (`navigator.wakeLock.request('screen')`, **UNVERIFIED**) and plays one tick so the operator hears the earpiece.

**The partner's question in the earpiece** (`lib/station/question.ts`): a checkbox on the setup screen, "Read the partner's question in the earpiece before its options". **Off by default since Oct 25** (Stephen: "take off question repeating"), so the earpiece goes straight to the numbered options. Turned on, a new partner question is said as "Question: ..." before its list (direct select only). Kept in `localStorage` key `neurolingo/station/read_question_v2`; the old key `neurolingo/station/read_question` is ignored, so a station that saved "on" before Oct 25 starts off once.

**Phrases ready:** after Start audio, `PhraseCache.warm()` every phrase in Appendix A (the variants for the input mode already picked; `confirmTail` is spoken inside each read-back, not cached alone) plus the four menu items, one at a time (**checked**: `warm` is sequential). That is 34 clips and about 900 characters. The screen counts "Phrases 12 of 34". Cost is about one Cartesia credit per character, so roughly 900 credits per page load (**UNVERIFIED** price; `cartesia/README.md` says about 1 credit per character on Free, 20,000 a month). Optional: keep the PCM of stock phrases in IndexedDB so a reload does not pay again.

**Synthesis order** (**design**; "prefetch" means every clip is ready before the cursor reaches it):

1. When `my_options` shows rows of the current version (`current = true`) and `scan_state.answer_mode` for that question is Pick, synthesize them in `rank` order, one at a time. Menu options are found in the phrase cache by their text (**checked**: `MENU_ITEMS` in `clock.ts`: "I need something", "Send a request", "Call", "Say something else").
2. After each clip: `report_clip_ready(option_id, clip.durationMs, clip.totalMs)` once per option id. `clip_ms` must be 1 to 30000 or the module throws (**checked**), so a clip of 0 ms is not reported; the scan then starts at `clip_deadline_ms` (4 s) with an estimate. When every option of the version has a clip and the phase is Preparing, the module starts the scan (**checked**: `reportClipReady`, `allClipsIn`).
3. Then the pending version (`current = false`), so a better version can switch in at the end of the pass without a wait. The views do not say a pending version's answer mode, so synthesize it either way; two short unused clips are the cost (**checked**: `my_options` has no answer mode; `question.pending_answer_mode` is private).
4. In yes or no mode the current version is not synthesized: the scan starts at once with the stock prompt and the speaker says the chosen reply (**checked**: `enterPreparing` starts a YesNo version without clips).
5. Options of a question that left `my_options` (superseded or ended): cancel their jobs and drop their clips.
6. Keep at most 16 option clips (about 2 to 3 MB of PCM; the laptop has 8 GB).
7. A late clip is still reported: later steps use the real length (**checked**: `enterReading` reads `clip_ms` at each step).

**Playback rules, driven only by `scan_state`** (**design**; the station never times a scan itself):

| `scan_state` update | Earpiece |
|---|---|
| Reading with a new `step_seq`, Pick | play that option's clip on `optionsOut`; record `playStart` in the heard log. If the clip is not ready yet, play it the moment it is, but only while that same step or its Window is current; otherwise drop it |
| Reading with a new `step_seq`, YesNo | play the "Yes or no?" phrase on `optionsOut` (its dwell is `yes_no_cue_ms`, 900 ms, **checked**; measure the phrase, and if it is longer, the owner raises `yes_no_cue_ms` to its length plus 150 with `set_timing`) |
| Window | nothing new; a clip still playing for the same option finishes |
| Veto | nothing (the command tick already played) |
| Preparing | nothing |
| Idle | stop `optionsOut` |
| Paused | stop `optionsOut` and any read-back at once; the cue speaks (2.13) |

**Earpiece start lag:** for each Reading step, `playStart - arrival time`. Show the median on screen. If it is over `audio_pad_ms` (150), the wearer hears the end of an option inside its window; the owner raises `audio_pad_ms` with `set_timing`.

**Speak timing to the module:** two reducers.

- `report_clip_ready(option_id, clip_ms, synth_ms)` sets the read's dwell (above; **checked** on `main`).
- `report_word_timings(step_seq, option_id, starts_ms, ends_ms)` is module v2, in the working tree and not yet published (**checked** in the uncommitted `spacetime/src/index.ts` and `clock.ts`; `docs/spacetime.md` 14). Each Reading step now writes its own speak step with key `q<question>:v<version>:read:<step_seq>`, and these timings attach to it, so the board can mark the word being read with numbers only, whatever the sharing toggle says. The station's rules (**design**, following the module's checks):

| Rule | Value |
|---|---|
| When | right after the read's clip (or the "Yes or no?" prompt) starts playing; once per read, keyed by `step_seq`; a re-read after a resume is a new read with a new `step_seq` |
| `step_seq` | the `step_seq` of the Reading update that started the read, which is `scan_state.option_start_seq` |
| `option_id` | the `my_options` row that was read; `0` for the yes or no prompt (the module then takes the scanned question) |
| `starts_ms`, `ends_ms` | `clip.words[i].startMs` and `.endMs`, whole milliseconds into the clip; sorted by start; each end raised to at least its start; capped at 30000; at most the first 100 words |
| Skip | a clip with no words; a read whose clip never played; menu reads are reported like any other read; read-backs are not reads and are never reported |
| Refusals | `no such read`, `not the option read at that step`, `no such option`, and the shape errors (**checked**): log them, never retry |
| `DisconnectedError`, `UnknownCallResultError` | resend within 10 s; a repeat changes nothing (one row per read, **checked**) |
| Module without v2 | the call fails (how an unknown reducer fails in the SDK is **UNVERIFIED**); log once and stop calling for the session. Nothing else depends on it |

The earpiece start lag (above) is still not reported: word timings are measured inside the clip, not against the clock. R2 (section 9) would add it.

**Silent test mode** (**design**): a checkbox "No earpiece voice (test only)", offered only in keyboard mode. Nothing is synthesized or reported, so each scan starts after `clip_deadline_ms` with estimated lengths; the heard log uses arrival times; heartbeats skip the earpiece check; the screen and the banner say "Silent test: options are not voiced." It exists so L1 (7.5) can run before the Cartesia key is set.

### 2.10 Sessions

| On the screen | Action |
|---|---|
| No active session (`my_session` empty) | Start session with the mode and purpose picked: `start_session('<mode>-<purpose>')`. Enabled only when paired, voice ready (or silent test), earpiece on, phrases ready and the input ready. Then the first heartbeat at once. |
| An active session exists and this page did not start it in this load | "Session N is active." Continue: start beating; the first beat proves ownership, and `not the session station` means another station owns it ("This session belongs to another station. End it there, or the owner runs `spacetime call --no-config --server maincloud say-when-dev end_session`."). End it: `end_session()`, allowed for the session's station or the owner (**checked**). |
| Running | End session: `end_session()` voids anything pending and stops the clock (**checked**). Then stop beating. |

- `my_session` returns the active session to any Station device, not only its owner (**checked**: `views.ts` `mySession`), which is why ownership is proved by a beat.
- After a reload mid-session the beats stop for a few seconds, the module pauses (HeadsetLost) and voids anything waiting for a confirm, and healthy beats resume it after 3 s (**measured** behavior of the dead-man pause). Continue and Start audio are one button after a reload: "Start audio and continue session N".
- A reload is not free: the stock phrases are synthesized again unless they are kept in IndexedDB.

### 2.11 Read-back, `report_readback_done` and the confirm window

1. **Start:** when `my_session.errand` has status Previewed, a 16-hex `preview_digest` and a non-empty `read_back_text`, and this page has not finished a read-back for that `errand_id`. Calls: when `my_session.call` has status Prepared with `script_digest` and `read_back_text`. One read-back at a time; an errand comes before a call (**checked** precedence in `gesture.ts`).
2. **Say it:** `utterance({ kind: 'readback', segments: [read_back_text, confirmTail] }, profile)` in the assistant voice at the person's pace. `confirmTail` is "To send it, {act}. To cancel, do nothing." (Appendix A). The Actor's read-back is built from values read back off the page (**checked**: `docs/spacetime.md` 2.8). `renderSegments` removes markup characters from the text (**checked**). Play on `optionsOut`.
3. **Stop it** at once, and report nothing, when: the errand or call leaves Previewed or Prepared (NO, STOP, a new question, a timer), a pause cue arrives, or the session ends.
4. **Done:** only when `play()` resolves `'ended'`: record `playedDigest[id] = digest`, then call `report_readback_done('errand', errand_id, preview_digest)` or `('call', call_id, script_digest)`.

| Answer | Do |
|---|---|
| resolves | start the local quiet-hold timer (5) |
| `read-back deadline passed` | nothing to fix; the module's Readback timer stops it and the `not_sent` cue follows. Show "The read-back took too long." |
| `digest mismatch: the station played a stale read-back` | a newer preview replaced the text while it played; the next Previewed update starts a new read-back |
| `errand is not waiting for a read-back` | it was stopped meanwhile; nothing to do |
| `DisconnectedError`, `UnknownCallResultError` | retry with the same arguments after the reconnect; a repeat after success returns quietly (**checked**: `readbackDone`) |

5. **Quiet hold and window:** the module sets `confirm_opens_at = now + quiet_hold_ms` (1000) and `confirm_closes_at` 8000 ms later (**checked**). Locally: at `quiet_hold_ms` after the report resolved, play the "window open" chime and start an 8 s countdown bar (durations only, never a clock difference: `docs/spacetime.md` 2.1). Because it starts after the server's commit, the chime never comes before the real opening (**design**).
6. **Early CONFIRM:** `ignored:quiet_hold` restarts the hold (**checked**). The station plays "Too soon. Wait a moment, then {act}.", and when `my_session.errand.confirm_opens_at` changes, restarts the local chime and bar from that update's arrival.
7. **Window ends without a confirm:** the module stops it with `window_closed` and the cue `not_sent`; the wearer hears "Stopped, nothing sent." (the module's own words, **checked** `SAY.window_closed`). A timeout is never shown in red (`docs/ui.md`).
8. **Length risk:** `read_back_text` may be up to 2000 characters (**checked**: `attachPreview`), far more than fits in `readback_deadline_ms` (30000). If the clip is longer than the time left (deadline minus the time since the Previewed update arrived), do not start it: say "That request is too long to read back. Nothing will be sent." and let the timer stop it. The demo form's read-back is short (**UNVERIFIED** until the real form is previewed).

### 2.12 The veto window and the idle menu

- **Veto** (**checked**: `enterVeto`, `releaseReply`): YES on a reply enters Veto for `reply_veto_ms` (700). The wearer hears the YES tick and the "counted" chime, nothing else; the screen shows "Picked option 2. Saying it in 0.7 s. NO or STOP cancels." NO during the veto cancels the pick and the scan goes on with the next option (falling chime). STOP during the veto ends the scan and nothing is said ("Cancelled. Nothing was said."). When the veto ends, the module releases the reply only with good contact (newest lease healthy and not lapsed, **checked** section 13 row 21); the speaker says it in the room.
- **Idle menu** (**checked**: `openMenu`, `pickMenuItem`): YES while idle with nothing pending and `config.menu_enabled` on opens the person's menu: four module-made options read like answers, from cached clips, reported at once so the scan starts within one round trip. YES on an item ends the menu and asks the agent for options under that item (a Menu-origin question). With `menu_enabled` off, YES while idle is `ignored:idle` and makes no sound.
- A YES whose onset was during a veto but which arrives after the reply was released, and after the refractory time, opens the menu: the module does not check the heard step for an idle YES (**checked**). Harmless (silence or STOP closes the menu); R3 in section 9 would ignore it.

### 2.13 Cues: what the wearer hears

`cue_event` rows are broadcast and never stored, so only `onInsert` fires (**checked**). Handle only rows whose `session_id` is the active session. Priority rules (**design**):

1. **Safety cues interrupt everything:** stop `optionsOut` and `promptOut`, then speak.
2. **A read-back is never interrupted** except by a safety cue or by its own errand or call leaving Previewed or Prepared.
3. **Mid-scan cues are chimes, not speech:** the module's timing leaves no room for a sentence when the next option starts in the same transaction.
4. **Info phrases** play on `promptOut` only while `optionsOut` is silent; one older than 3 s when the earpiece frees up is dropped.

| Cue kind (all **checked** in `spacetime/src`) | Earpiece |
|---|---|
| `paused` (reason `stop`) | safety: "Paused. Nothing will be sent." |
| `paused` (reason `idle`) | safety: "Paused after a quiet spell. Nothing will be sent." |
| `paused` (reason `operator`) | safety: "Paused by a helper. Nothing will be sent." |
| `paused` (reason `headset_off`) | safety: headset mode "Headset off. Nothing will be sent."; keyboard and switch modes "Input off. Nothing will be sent." |
| `paused` (reason `headset_lost`) | safety: "Signal lost. Nothing will be sent." |
| `call_cancelling` | safety: "Hanging up." |
| `too_late` | safety: "Too late to stop it. It is already sending." |
| `resumed` | if the same update shows Reading: the "on" chime (the option is read again at once); if Idle: "Resumed." |
| `again` | chime (pass 2 starts at once) |
| `more_options` | chime |
| `menu_open` | chime |
| `picked` | the "counted" chime |
| `veto_cancelled` | if the same update shows Reading: falling chime; if Idle: "Cancelled. Nothing was said." |
| `reply_released` | nothing (the room hears the reply) |
| `none` | "None of these." |
| `no_pick` | "No pick. Nothing was said." |
| `not_ready` | "One moment." |
| `say_confirm` | during a read-back: nothing (its last sentence says how to confirm); while waiting for a confirm: "That needs a confirm. To send it, {act}." |
| `confirmed` | "Confirmed." |
| `errand_preparing` | "Getting it ready." |
| `errand_sent` | "Sent." |
| `errand_unknown` | "It may or may not have gone through." |
| `not_sent` (reason `window_closed`) | "Stopped, nothing sent." |
| `not_sent` (reason `readback_not_finished`) | "The read-back did not finish. Nothing was sent." |
| `not_sent` (any other reason) | for an errand: "Not sent."; for a call (the cue carries a call id): "No call was made." |
| `errand_refused`, `errand_failed` | the errand row's `reason` sentence when it has one (Actor sentences are written to be spoken, **checked** `docs/spacetime.md` 2.8), synthesized on demand; else "Not sent." |
| `call_refused` | the call row's `reason` sentence when it has one; else "No call was made." |
| `call_ended` | "The call ended." |
| `question_waiting` | "A new question is waiting." |
| `failed` | "No options this time. Nothing was said." |

Changes with no cue: when the module stops an errand or call because of a pause or a new question it emits no `not_sent` (**checked**: `voidPending` passes `cue: false`). A pause already speaks. For reason `interrupted` the station says "A new question came in. Nothing was sent." (the module's own sentence, **checked** `SAY.interrupted`) when it sees `my_session.errand` or `.call` change to Stopped with that reason code.

Reason sentences can name a person ("Calls to Leon are on hold until someone checks."). They go to the earpiece only, and to the station screen only while sharing is on.

### 2.14 Safety states: exactly what the wearer hears

| State | Starts when | Earpiece | Station screen | Ends when |
|---|---|---|---|---|
| Paused, STOP | STOP while idle | "Paused. Nothing will be sent." | "Paused. YES resumes." | YES (**checked**) |
| Paused, idle | `idle_pause_ms` (120000) with no accepted command | "Paused after a quiet spell. Nothing will be sent." | "Paused after 2 minutes. YES resumes." | YES, or a partner question (it resumes an idle pause, **checked** `askQuestion`) |
| Paused, helper | `operator_pause` from a phone, the speaker or the owner; or the station revoked | "Paused by a helper. Nothing will be sent." | "Paused by a helper. Only the owner can resume: `spacetime call --no-config --server maincloud say-when-dev operator_resume`" | the owner's `operator_resume` only; YES is `ignored:operator_pause` (**checked**) |
| Headset off | a beat with `decoder_healthy = false`, or a HEADSET_OFF command | headset mode "Headset off. Nothing will be sent."; keyboard and switch "Input off. Nothing will be sent." | the input chip says why | `resume_good_contact_ms` (3000) of healthy beats with `auto_resume` on; YES also resumes once contact has been good that long (**checked**) |
| Signal lost | no beat for `liveness_lease_ms` (1500) | "Signal lost. Nothing will be sent." if the cue reaches the station; if the station itself lost the module, its own "Connection lost. Nothing will be sent." (2.15) | "Reconnecting" | as for headset off |
| Any pause | | option audio and any read-back stop at once; whatever waited for a confirm is void (the module's rule) | | |

STOP during a signal pause turns it into a deliberate Stop pause, which needs YES (**checked**: `onStop`).

### 2.15 Staleness and the station's own connection

- After each `scan_state` update in Reading, Window or Veto, arm a local timer for the step's planned length (`step_ends_at - step_started_at`, a duration) plus 1.5 s. If no newer update arrives first, the station treats the link as dead: stop `optionsOut`, say "Connection lost. Nothing will be sent." once from the cache, show "Reconnecting" (`docs/spacetime.md` 7.1, Staleness). Preparing is never timed this way: it can wait for the agent with no timer behind it (**checked**: the ClipDeadline tick does nothing while a question has no version).
- A silent network drop may never fire `onDisconnect` (`docs/spacetime.md` 7.1). The timer above and the 3 s heartbeat answer check (2.8) catch it.
- While disconnected: no beats (the module pauses by itself), no commands sent, commands kept for the resend windows in 2.7.
- On reconnect: the SDK replays the subscriptions; resume beats if this station owns the session; the module resumes after 3 s of healthy beats. Cue rows from the gap are gone for good (event table), so after a reconnect the screen reads its state from `scan_state.pause_reason` and `my_session`, not from cues.

---

## 3. The speaker (`/speaker`)

**What it does:** says the newest released reply aloud in the room, once, then records it with `reply_spoken`. Its own view never shows options (the mirror below reads the public board instead) (**checked**: `my_session` gives a Speaker only `reply = { question_id, text, tone, laugh, released_at }` for the newest Released question).

**Start:** pairing (1.2), the voice check with `tts`, then a Start room voice button (the click starts the `AudioContext`, 5.3). A Test voice link plays "This is the Eleven room voice." aloud so the operator can set the volume.

**Saying a reply** (**design**):

1. Trigger: a `my_session` insert or update whose `reply.question_id` is greater than the last question id this page spoke or skipped.
2. If the reply arrived in a subscription snapshot (it was there when `onApplied` fired, which happens at connect and after every reconnect) and was released more than 20 s ago by the server clock estimate, do not say it. Show "Missed reply to question 7, released 3 min ago." with a Say it now link. The server clock estimate: the largest `(updated_at of a live scan_state update) - (arrival time)` seen in the last minute, as in `web/lib/data/clock-offset.ts`; with no sample, assume the clocks agree. Live updates are said at once, whatever their timestamp.
3. Speak with low latency: `player.speak(utterance({ kind: 'reply', text, tone, laugh }, profile), { onAudio: (pcm) => out.enqueue(pcm) })` streams chunks into one `AudioOut` (**checked**: `speak` with `onAudio`, `AudioOut.enqueue`). The room volume is `replyVolume` (0.5 to 2, kept in `localStorage`).
4. When `done` resolves and `out.playing` turns false, call `reply_spoken(question_id, clip.durationMs)`. `ms` is the length of the speech, matching the payload's `durationMs` (**checked**: `replySpoken` writes `durationMs: ms`).
5. Retry `reply_spoken` on `DisconnectedError` or `UnknownCallResultError` for up to 60 s; it is idempotent (a Spoken question returns quietly, **checked**). `reply is not released` or `no such question` (purged): stop.
6. Record progress in `localStorage` key `neurolingo/speaker/<db>/last` as `{ questionId, state: 'started' | 'done' }`. After a reload, a reply marked `started` that is still Released is said again from the start if it is under 20 s old, else shown as missed.
7. A TTS failure: retry once (a fresh socket and token). If it fails again, show "Could not say the reply" with Say it now. Never call `reply_spoken` for words nobody heard.

**What it shows** (**design**):

```
+----------------------------------+
| Eleven room voice   (o Live) |
|                                  |
| Said out loud                    |
| "<reply words: sharing on only>" |   --text-lead, current word marked
|   or  "Reply to question 7"      |
| Said at 12:41:08                 |
|                                  |
| Test voice      Volume 1.0       |
+----------------------------------+
```

- Idle: "Waiting for a reply." Paused (from `scan_state`): "Paused. Nothing will be said."
- Words follow `config.share_text_on_board`, as on the board: the speech is heard in the room, but a screen is a lasting record.
- Two speakers online (two Speaker rows online in `device_status`): a warning, because both would talk. The module lets both report (the second returns quietly, **checked**).

**On a reconnect:** the SDK replays the subscription; step 2 decides whether a reply in the snapshot is still worth saying; a `reply_spoken` that failed during the gap is retried (step 5); audio that was playing locally finishes on its own.

**Say read-backs** (Sun Oct 25 2026, `web/lib/speaker/mirror.ts`, `mirror-rows.ts`; a toggle on the page labelled "Say read-backs", on by default, kept in `localStorage` key `neurolingo/speaker/mirror_earpiece`; it was "Mirror the earpiece" until Oct 25): judges in the room cannot hear the headset, so the room voice also says every read-back the wearer hears, through the same Cartesia voice and volume as the reply.

- What it says: every read-back ("... One: send it. Two: cancel."; a search read-back as the module wrote it), with the same words and voice as the earpiece (`readbackSegments`); phone numbers are said as "a number" and keys or tokens as "a code". **Since Oct 25 it does not say the partner's question or the numbered options** (Stephen: "take off question repeating", "take off answer choices being repeated"); the wearer still hears the options in the earpiece.
- Where the words come from: `my_session` gives a Speaker only the reply, so the page also subscribes the anonymous board views `public_board`, `board_errands`, `board_calls` and `board_searches`, on their own subscription (an error there never touches the reply). Triggers: a board errand Previewed, call Prepared or search Prepared with its digest. A live `scan_state` update whose `question_id` is newer only moves the mirror on to that question (older read-backs go); a Paused step clears everything. The board shows words only while `config.share_text_on_board` is on, so the mirror runs only then and the page says so. No module change.
- Order and priority: one line at a time, in arrival order; a newer question drops older lines and cuts the one being said; a pause drops everything, a stopped errand or call drops its read-back. The picked reply always wins: it cuts a line, the lines of its question are dropped, and no line starts while it (or the Test voice) plays. Snapshot rows (connect, reconnect) are only a starting point: nothing old is said, and a line older than 20 s when its turn comes is dropped.
- Playing every time: a line the audio cut goes back to the front and is said once the room voice runs again; a failed line is tried once more on a fresh socket and token; one small status line says what the mirror does or needs ("Tap Start room voice to hear the read-backs here.", "Read-backs need board sharing on.").

**Audio that plays every time** (Sun Oct 25 2026): the room voice keeps running when the audio devices change (`onDeviceChange: 'report'`: plugging in a projector or a speaker moves the sound, which is the point here; the earpiece still stops, 5.5), resumes by itself after the first tap when the browser suspends it (`autoResume`, and again when the page comes back into view), replaces a Cartesia socket unused for two minutes before speaking (a laptop that slept can keep a dead socket that still says it is open), fails a generation after 5 s with no message so the retry on a fresh socket comes quickly, counts a chunk the output refused as a failure rather than "said", and a reply cut by the audio stopping waits for the room voice and is said again from the start once it runs, if it is under 20 s old, instead of showing "Could not say the reply".

---

## 4. Partner asking (`/partner`)

The status view stays as built: it reads the anonymous board rows, so words already follow the room's toggle (**checked**: `components/partner/model.ts`, `buildPartnerView`). Asking adds pairing and two senders.

### 4.1 Pairing on the phone

- A text link under the button, "Pair this phone to ask", opens the pairing card (1.2) with the label picker (partner phone 1, 2 or 3). Unpaired phones stay read-only, so a judge's phone can watch without pairing.
- The owner approves with `false`, or `true` for the caregiver's phone.

### 4.2 Hold to ask (Ink-2)

Wire `HoldToAsk`'s `onHoldChange` (**checked**: the prop exists and the note under the button changes once it is passed):

1. **Press:** `requestId = newRequestId()` (a UUID, **checked** `useAsk.ts`); `partner_listening(requestId, true)` without waiting (the board shows "Listening"; errors ignored); then

```ts
listen({
  getToken: () => mintVoiceToken('stt'),   // one token per hold; no real mint has run (UNVERIFIED time; S1 fetched Cartesia in 92 to 254 ms)
  keyterms,                                // below
  endOn: 'release',                        // push to talk: the partner decides when the question is over
  maxMs: 30_000,                           // hard stop for a stuck button; Ink-2 bills every second sent
  onPartial: (text) => showPartial(text),  // live words, or a word count with sharing off (4.4)
})
```

   `listen` starts the mic before the socket opens and holds up to about 5 s of audio until it does (**checked**: `MAX_PENDING_CHUNKS = 50` of 100 ms). With `endOn: 'release'`, turn ends do not stop the session; turns are joined with spaces (**checked**). No turn profile is set, so the server default applies.
2. **Release:** `session.release()`, then `partner_listening(requestId, false)`. `done` resolves after the last events (at most 5 s of drain, 5 s release deadline; **checked** defaults). The drain was 3 s until Oct 24, when a live test caught a slow Ink-2 final transcript 3.5 s after the close command and the question was cut to "What should we have for" (**measured**).
3. **Result:**

| `done` result | Phone |
|---|---|
| `ok: true` with text | send with `ask_question(requestId, text, 'voice', listenMs)` (4.3). `listenMs` = time from the release to `done` resolving: how long speech to text took after the partner stopped, the "Heard 0.4 s" figure on Live data (**design**, matching `docs/ui.md`) |
| `ok: false`, `no_speech` | "Did not catch that. Hold and ask again." |
| `ok: false`, `error` (token, socket, Ink-2) | "Speech to text is not working. Type your question." Show the error code in a tooltip only |
| `ok: true`, reason `timeout` | send what was heard; also end the hold on screen (pass `disabled` while sending, which ends the hold, **checked** `HoldToAsk`) |

- **Keyterms:** `buildKeyterms(['Eleven', 'Cal Hacks', 'care team'])`. Household names belong in keyterms (`cartesia/README.md`), but they live in a private lexicon file, and a list in the page would ship names in a public bundle. No household names in v1 (**design**; open question O7).
- **The token:** minted per hold by the module, never stored. The session is at most 30 s, so it ends long before its 60 s token would (whether Cartesia cuts an open socket at expiry is **UNVERIFIED** and does not matter here).
- **Two microphone users:** the existing level meter opens the mic itself (**checked**: `micMeter.ts`) and `listen` opens it again through `MicCapture`. Two streams on one phone are **UNTESTED** (5.4). If they clash, stop the meter while listening and show a static "Listening".
- **iOS risk:** `MicCapture` creates its `AudioContext` after awaiting `getUserMedia`, outside the press (**checked**: `cartesia/src/stt.ts`). Safari may keep that context suspended (**UNTESTED**, 5.4). The fix, if the test fails: pass `audio:` (an `AudioSource`, **checked** in `ListenOptions`) built from an `AudioContext` created inside the press, with cartesia's own `Downsampler`, `PcmChunker` and `floatToPcm16`.
- **A scan in progress:** a new question replaces the current one (**checked**: `askQuestion` supersedes). While the board shows Reading or Window, the note under the button says "Asking now replaces the question they are answering."

### 4.3 Sending: `ask_question` with request id retries

One sender for voice and typed (wire `useAsk()` to return it once paired, **checked**: the typed box appears as soon as `useAsk` returns a function, and it already reuses the request id while the words stay the same).

- Before sending: trim; 1 to 500 characters (**checked**: `requireText`); otherwise "Too long. Keep it under 500 characters." Control characters other than tab, newline and carriage return are removed (the module refuses them, **checked**: `CONTROL_RE` in `util.ts`).
- `request_id`: the UUID made at the press (voice) or for those words (typed). It matches `^[A-Za-z0-9:_-]{1,64}$`; a repeated id returns without asking again (**checked**).

| Answer | Do |
|---|---|
| resolves | done; the status sentence takes over |
| `SenderError` | never retry. `no active session`: "The station is not running. Nothing was sent." `not allowed`: the pairing card. Anything else: "Could not send. Try again." with the text in a tooltip |
| `DisconnectedError`, `UnknownCallResultError` | after the reconnect, send again with the same `request_id`, up to 3 tries within 30 s; meanwhile "Not connected. Trying again." Then "Could not send. Try again."; Send again keeps the same `request_id` |

- A question asked while the scan is paused waits (cue `question_waiting`), and one asked during an idle pause resumes it (**checked**). The phone already shows "Paused. Please wait." from the board.

### 4.4 What the phone shows at each step

The room toggle is `config.share_text_on_board`, read by the role connection. The status sentences come from the existing model and are unchanged.

| Step | Sharing on | Sharing off |
|---|---|---|
| Not paired | the status view; under the button "Pair this phone to ask." | same |
| Pairing | "Pairing code 482 913. Ask the owner to approve it." with the time left | same |
| Ready | Hold to ask, "Listening only while you hold.", the typed box | same |
| Holding | "Listening" with the level, and the words as Ink-2 hears them | "Listening" with the level and "12 words so far" (no words) |
| Released | "Sending" with a spinner | same |
| Sent | the model's sentences ("Looking it up.", "Getting options ready.", "They are choosing, option 2 of 4.") and "You asked" with the words | the same sentences, and "You asked: Question 7" |
| Reply | "Their answer" with the words, then "Said at 12:41" | "They answered out loud." |
| No speech | "Did not catch that. Hold and ask again." | same |
| Speech to text broken | "Speech to text is not working. Type your question." | same |
| Not sent after retries | "Could not send. Try again." | same |
| No session | "The station is not running. Nothing was sent." | same |
| Paused or headset off | "Paused. Please wait." or "Headset off. Please wait." (as built) | same |

The phone never shows option words in any state (**checked**: `buildPartnerView`, `partner_view`).

Not in this build: Cancel question (`cancel_question`), the helper Pause (`operator_pause`; only the owner can lift it), and the caregiver's consent and sharing controls.

---

## 5. Chrome and device realities

Every item below is **UNTESTED**: nothing has run in a browser. Each has a test that takes about 2 minutes. Write each result (pass or fail, Chrome version from `chrome://version`, the device) into PLAN row 5.6 and here.

### 5.1 An https page opening `ws://127.0.0.1` (mixed content, local network access)

- **Why it matters:** the deployed station page is https and the decoder is `ws://` on loopback. Chrome may treat that as mixed content or ask for local network permission, or refuse. If it refuses, the headset path does not exist on the deployed page (smoke step S3 in `docs/spacetime.md`).
- **Test (EEG laptop):**
  1. Start a stand-in decoder (needs `pip install websockets`; the handler takes one argument in websockets 10.1 or later, **UNVERIFIED** for the laptop's version):

     ```python
     # decoder stand-in: health every 200 ms; type y, n, c, s or h then Enter to send a command (source "standin")
     import asyncio, json, uuid, websockets
     CMDS = {"y": "YES", "n": "NO", "c": "CONFIRM", "s": "STOP", "h": "HEADSET_OFF"}
     async def handler(ws):
         async def health():
             while True:
                 await ws.send(json.dumps({"type": "health", "decoderHealthy": True}))
                 await asyncio.sleep(0.2)
         task = asyncio.create_task(health())
         loop = asyncio.get_running_loop()
         try:
             while True:
                 line = (await loop.run_in_executor(None, input)).strip().lower()
                 if line in CMDS:
                     await ws.send(json.dumps({"type": "gesture", "id": str(uuid.uuid4()), "command": CMDS[line],
                                               "onsetAgeMs": 0, "confidence": 1.0, "source": "standin"}))
         finally:
             task.cancel()
     async def main():
         async with websockets.serve(handler, "127.0.0.1", 8765):
             await asyncio.Future()
     asyncio.run(main())
     ```

  2. Open any page of the deployed https origin (for example `/conversation`), open DevTools, run:

     ```js
     const w = new WebSocket('ws://127.0.0.1:8765'); w.onopen = () => console.log('open');
     w.onmessage = (e) => console.log('msg', e.data); w.onerror = () => console.log('error'); w.onclose = (e) => console.log('close', e.code);
     ```

- **Pass:** `open`, then health messages. If Chrome shows a prompt about devices on the local network, click Allow, note it, and run again (whether the answer is kept per site and profile is **UNVERIFIED**).
- **Fail:** a Mixed Content or local network error in the console, or `error` then `close 1006`.
- **If it fails:** serve the station from the EEG laptop. In `web/`: `npm ci`, then `NEXT_PUBLIC_SPACETIMEDB_HOST=https://maincloud.spacetimedb.com NEXT_PUBLIC_SPACETIMEDB_DB=say-when-dev npm run build`, then `npx next start -p 3000`, and open `http://localhost:3000/station`. Chrome treats `http://localhost` as a secure context, so audio and `crypto` work (**UNVERIFIED** in this Chrome). Run the console test from `http://localhost:3000` first. `localStorage` is per origin, so pair the station again there, and always use `localhost`, not `127.0.0.1`, in the address. Cost: about 150 to 300 MB more on the 8 GB laptop (**UNVERIFIED**). Last resort, and slow to build: `gesture_http` from the Python process (`docs/spacetime.md` 7.5), which needs module work that is not built.

### 5.2 Timers in a hidden, covered or minimized window

- **Why it matters:** the lease is 1500 ms and beats are every 500 ms. Chrome slows main-thread timers in background tabs, possibly to once a second, and far more after minutes hidden (**UNVERIFIED** details). Late beats mean the module pauses mid-demo.
- **Test:** on the deployed station origin, DevTools:

  ```js
  let last = performance.now(), worst = 0;
  setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 500);
  const wk = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 500)'])));
  let wl = performance.now(), ww = 0; wk.onmessage = () => { const n = performance.now(); ww = Math.max(ww, n - wl); wl = n; };
  setInterval(() => { console.log('timer worst', Math.round(worst), 'worker worst', Math.round(ww)); worst = 0; ww = 0; }, 20000);
  ```

  Then for 20 s each: switch to another tab; cover the Chrome window fully with another app; minimize it; leave it in front.
- **Pass:** worst gap under 1000 ms in the layout used for the demo (station window in front and uncovered), and the worker's worst gap under 1000 ms when hidden.
- **If it fails:** keep the station window in front and uncovered on its own screen; mains power; turn off Energy saver and add the site to "Always keep these sites active" under Memory saver; use the worker tick (2.8); launch a dedicated profile with `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows` (**UNVERIFIED** for current Chrome); and the owner may raise `liveness_lease_ms` to 2500 (allowed 1000 to 5000, **checked**). Run a 30-minute soak before the demo either way.

### 5.3 Autoplay: audio needs a tap

- **Why it matters:** an `AudioContext` made before any click stays suspended (**UNVERIFIED** for this Chrome). After a reload, the earpiece is silent until someone clicks.
- **Test:** open `/station` on the deployed origin, and in DevTools before clicking: `const c = new AudioContext(); console.log(c.state)`. Click the page, then:

  ```js
  await c.resume(); console.log(c.state);
  const o = c.createOscillator(); o.connect(c.destination); o.start(); o.stop(c.currentTime + 0.2);
  ```

  Reload and check `state` again before clicking.
- **Pass:** `suspended`, then `running` after the click with a beep in the earpiece, and `suspended` again after the reload. That confirms the Start audio button and the "Start audio and continue session" button after a reload.
- **If it fails** (no sound after a click): check the output device and that the tab is not muted. For the dedicated EEG laptop profile, `--autoplay-policy=no-user-gesture-required` (**UNVERIFIED**) removes the click; keep the button anyway.

### 5.4 The microphone on the partner phone

- **Why it matters:** Hold to ask needs `getUserMedia` (https only) and a running capture context. On iOS the capture context may stay suspended (4.2).
- **Test:** on the real partner phone, open the deployed `/partner`, hold the button. The existing meter opens the mic (**checked**). Pass: a permission prompt, Allow, bars move. Once asking is wired: hold, say "Testing one two three", release. Pass: words (sharing on) or a word count appear while holding, and a question lands.
- **If it fails:** blocked: allow the microphone in the browser's site settings (iOS Safari: Settings, Safari, Microphone, or the page's site settings) and reload. Bars move but no words: build the in-press capture source (4.2). Either way the typed box works.

### 5.5 The earpiece output device

- **Why it matters:** if the earpiece unplugs or a Bluetooth earpiece drops, the browser may move the options to the laptop speakers, into the room (**UNVERIFIED**).
- **Test:** play the 5.3 beep through the earpiece, unplug it, play it again. Note where the sound goes. Then `navigator.mediaDevices.ondevicechange = () => console.log('devices changed')` and unplug again.
- **Pass:** we can see the change. The station then stops all audio and stops beating (the module pauses) until the earpiece is back and the operator clicks Start audio.
- **If the event never fires:** use a wired earpiece and turn the laptop's speakers down to zero for the demo. Optional pinning with `AudioContext.setSinkId(deviceId)` (Chrome 110 and later, **UNVERIFIED**; not in the TypeScript DOM types, **checked**, so it needs a cast).

### 5.6 The speaker page on a phone

- **Why it matters:** on iPhones the silent switch can mute Web Audio, and a locked screen stops it (**UNVERIFIED**).
- **Test:** open `/speaker` on the phone, Start room voice, Test voice with the silent switch on and then off; lock the screen and check whether the page reconnects after unlocking.
- **If it fails:** run the speaker on a laptop with a loudspeaker.

### 5.7 SpacetimeDB tokens from a browser

- **Why it matters:** the dashboards connect anonymously, so no browser of ours has exchanged a saved token at `/v1/identity/websocket-token` yet. Whether Maincloud tokens expire is also unknown (the SDK can refresh tokens "near expiry", **checked** in `db_connection_impl.d.ts`, which suggests some do).
- **Test:** pair `/station` from the deployed origin, reload, and check that it is paired again without a new code. In DevTools, without printing the token: `JSON.parse(atob(localStorage.getItem('https://maincloud.spacetimedb.com/say-when-dev/auth_token/station').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp`.
- **Pass:** paired after the reload; `exp` is missing or far in the future.
- **If it fails:** a reload that cannot reconnect with `WebSocketTokenError`: Forget this device and pair again (a new identity), and tell Stephen so the module side can be checked.

**Ranked by risk** (what breaks, and how likely): 5.1 (the headset path from the deployed page), 5.2 (spurious pauses mid-demo), 5.4 (asking by voice on an iPhone), 5.3 (a silent earpiece after a reload, safe but awkward), 5.5 (options leaking into the room), 5.7 (pairing lost after a reload), 5.6 (speaker on a phone).

---

## 6. Failure modes

| Failure | Wearer hears | Room, board and partner phone | Recovery |
|---|---|---|---|
| Decoder not running at start | nothing (no session) | nothing | start the decoder, or keyboard mode |
| Decoder drops or goes silent mid-session | "Headset off. Nothing will be sent." | board "Headset off", banner; phone "Headset off. Please wait." | decoder back: resumes after 3 s of healthy beats |
| Decoder says not healthy (electrodes off) | same | same | fix the headset; same resume |
| Bad decoder message | nothing; a STOP with a bad id is still sent | nothing | screen counts bad messages; tell Shashank |
| Station network drops under 1.5 s | nothing; at most a resent command | nothing | the SDK reconnects |
| Station network drops longer | "Connection lost. Nothing will be sent." (local) | board "Paused" (HeadsetLost), pending errands void; phone "Paused. Please wait." | reconnect, then auto-resume after 3 s |
| Silent socket death | same, after the step plus 1.5 s | same once the lease lapses | the staleness timer and the 3 s beat check catch it |
| Station window hidden or covered | maybe nothing, maybe "Signal lost" if beats slow too much | maybe "Paused" | window in front (5.2) |
| Station page reload | silence until Start audio; then the option again | "Paused" for a few seconds, pending confirms void | one click: "Start audio and continue session N" |
| Laptop sleeps | nothing | "Paused" | wake, click Start audio and continue |
| Earpiece unplugged | nothing (audio stopped) | "Paused" | plug in, Start audio (5.5) |
| No Cartesia key in the module | nothing; Start session blocked | nothing | O2: publish with the key; or silent test mode for keyboard tests |
| Cartesia refuses or errors (credits, 429, outage) | the cached "The voice is not working. Nothing will be sent." once; then silence; scans end No pick | board shows the scan moving although nothing is heard; phone "They are choosing" then "No pick." | fix the account; re-ask. Do not demo on a dead voice |
| Cartesia socket closes at token expiry | at most one option late (one retry) | nothing | automatic |
| Module refuses a gesture (`SenderError`) | nothing | nothing | the screen shows the message; `not allowed`: pair again |
| Module ignores a gesture | the 2.7 table | the board shows the ignored command with its reason | none needed: that is the debounce working |
| `report_readback_done` refused (deadline) | "The read-back did not finish. Nothing was sent." | errand Stopped | ask again with a shorter form |
| Speaker offline when a reply is released | nothing | the reply is not said; phone shows "They answered" with the words (sharing on) | reconnect within 20 s: said late; else Say it now |
| Speaker audio blocked | nothing | silence in the room | click Start room voice |
| Two speakers online | nothing | the reply is said twice | close one |
| Partner phone offline | nothing | "Not connected. Trying again." | reconnect; the same `request_id` is resent |
| Ink-2 fails or mic blocked | nothing | "Speech to text is not working. Type your question." | typed box |
| Partner not paired or revoked | nothing | the pairing card | owner approves the code |
| Owner not available to approve | nothing | pages wait on the code | approve before the demo; pairing survives reloads |
| SpacetimeDB token rejected | silence until fixed | that device offline | Forget this device and pair again (5.7) |
| Module republished during a session | timers may hiccup (`docs/spacetime.md` 9.4) | brief stalls | never publish during judging; `ensure_timers` after any publish |

---

## 7. Build plan

### 7.1 Order and split

Three tracks run in parallel after a short shared start. All files are in `web/`. Run the 5.1 test first, because it decides how the station is served.

| When | Track C (shared) | Track A (station) | Track B (speaker and partner) |
|---|---|---|---|
| First 45 min | C1 storage and connection, C2 pairing (interfaces first), C3 cartesia copy | A2 heard log and A3 command builder against fakes | B1 speaker engine against fakes |
| Next | C4 voice helpers, C5 frames and provider | A4 inputs, A5 heartbeat, A6 earpiece | B3 partner asking |
| Then | C6 dashboard input label (with the dashboard owner) | A7 read-back, A8 cues, A9 staleness, A1 screen | B2 speaker screen |
| Together | live runs L1 to L5 (7.5) | | |

### 7.2 Track C: shared pairing, connection and audio

| Step | Files | Tests |
|---|---|---|
| C1 Storage and connection | `lib/role/storage.ts` (token key, read, save, forget; port, mode, switch key, speeds; every access in `try`), `lib/role/connection.ts` (DbConnection with the role token, reconnect rules from 1.5, connection state store, identity), `lib/role/calls.ts` (classify `SenderError`, `DisconnectedError`, `UnknownCallResultError` by `name`; a resend helper with an age limit) | `test/role-storage.test.ts`: the key is exactly `https://maincloud.spacetimedb.com/say-when-dev/auth_token/station`; a throwing storage does not throw out. `test/role-calls.test.ts`: classification; resend stops at its age limit (fake clock) |
| C2 Pairing | `lib/role/pairing.ts` (pure state machine: connecting, unpaired with code and expiry, waiting, paired, wrong role, revoked, error), `components/role/PairingCard.tsx` and `.module.css` | `test/role-pairing.test.ts`: no row gives a code and a `request_pairing`; my row appears gives paired; expiry gives a new code; `code taken` retries once with a new code; `not allowed` or `not_paired_for_purpose` gives revoked; another role's row gives wrong role; the label comes only from the fixed list |
| C3 Cartesia browser code | `scripts/sync-cartesia.mjs` and `npm run cartesia`: copy `cartesia/src/{browser,constants,events,http,keyterms,pcm,stt,tones,tts,ws}.ts` (the whole browser closure, no `node:` imports, **checked**) into `lib/cartesia/` byte for byte, as `npm run bindings` does for the bindings | `test/cartesia-copy.test.ts` fails while any copied file differs from `cartesia/src`. Then `npm run build` must resolve the `./x.js` import specifiers to the `.ts` files (**UNVERIFIED** for Next 16 with Turbopack); if it does not, the script strips the `.js` endings and the test applies the same rewrite before comparing. The ten files pass the web writing rules today (**checked** with the test's patterns) |
| C4 Voice helpers | `lib/voice/token.ts` (`mintVoiceToken` wrapper: a token, or a thrown error carrying the code; code to words, 1.3), `lib/voice/audio.ts` (start audio on a click, chimes and ticks, latency, device change watch), `lib/voice/phrases.ts` (Appendix A as data, the cue table of 2.13 as a pure function of cue, mode and phase) | `test/voice-phrases.test.ts`: every cue kind in 2.13 maps; the `{act}` variants per mode; mid-scan cues are chimes; `say_confirm` during a read-back is dropped. `test/voice-token.test.ts`: each error code to its words |
| C5 Frames and provider | `components/shell/Shell.tsx` (bare frame for `/station` and `/speaker`), `lib/data/provider.tsx` (no source on those paths) | a unit test for the route check; the existing tests stay green |
| C6 Dashboard input label (W1) | `lib/data/spacetime-map.ts` (input from the newest `session_start` ledger row's outcome prefix: `headset`, `keyboard`, `switch`), `lib/data/types.ts` (`SafetyState.input`), `components/shell/HeadsetChip.tsx` and `SafetyBanner.tsx` (headset sessions: "Headset on" and "Headset off"; keyboard and switch sessions: "Keyboard input" or "Switch input", and "Input off. Nothing will be sent."), the command strip legend ("YES, key press" instead of "YES, imagined right fist") | a map test with a `keyboard-test` session; the chip, banner and legend words. Coordinate with whoever is editing the dashboards now |

### 7.3 Track A: the station

| Step | Files | Tests |
|---|---|---|
| A1 Page and screen | `app/station/page.tsx`, `components/station/Station.tsx` and `.module.css` (2.2), small parts in `components/station/` | renders each setup step and session state from a fixed store snapshot; words follow the sharing flag |
| A2 Heard log | `lib/station/heard.ts` | `test/station-heard.test.ts`: onset in option 1's window gives option 1; onset 100 ms after option 2's audio starts gives option 1 (margin 200); 300 ms after gives option 2; a clip that never played is skipped; yes or no gives option 0; nothing logged gives step 0 and option 0; silent mode uses arrival times |
| A3 Commands | `lib/station/commands.ts` | `test/station-commands.test.ts`: arguments per command (2.7); the CONFIRM digest is the errand's before the call's, `''` when no read-back finished, never a digest from a read-back that was cut off; `onset_age_ms` includes the one-way estimate; resend windows (3 s and 30 s); repeated decoder ids relayed once |
| A4 Inputs | `lib/station/decoder.ts`, `lib/station/keys.ts` | `test/station-decoder.test.ts`: parsing and every validation rule of 2.4; health fresh only within 500 ms; reconnect waits 0.5, 1, 2, 2 s (fake timers). `test/station-keys.test.ts`: the keyboard map, repeats and modifier keys ignored; switch short press gives YES 400 ms after release, double press gives CONFIRM with the first onset, 1000 ms hold gives STOP |
| A5 Heartbeat | `lib/station/heartbeat.ts`, `lib/station/heartbeat-worker.ts` | `test/station-heartbeat.test.ts`: `decoder_healthy` per mode (keyboard: visible; switch: visible and focused with 2 s grace; headset: fresh and true); no beats without ownership or a running earpiece (unless silent); one extra beat on a healthy-to-unhealthy change; beats stop on the three `SenderError` messages; `beat_seq` keeps rising |
| A6 Earpiece | `lib/station/earpiece.ts` | `test/station-earpiece.test.ts` with a fake player and a fake `AudioOut`: rank order; one `report_clip_ready` per option id; no report for a 0 ms clip; menu clips from the cache; no synthesis for a current yes or no version; pending version after the current one; jobs cancelled when options leave; play on a new Reading step only; stop on Idle and Paused; the play start goes to the heard log; one `report_word_timings` per read with the read's `step_seq`, its option id (0 for the prompt) and cleaned timings (sorted, ends at or after starts, at most 30000, at most 100 words), none for a read-back or a clip with no words, and a missing reducer stops the calls without breaking playback |
| A7 Read-back | `lib/station/readback.ts` | `test/station-readback.test.ts`: one read-back per errand id; the mode's confirm sentence on the end; stops when the status leaves Previewed; reports only after `'ended'`; resends after a disconnect; the digest is recorded at the end; the window chime comes `quiet_hold_ms` after the report resolved; a read-back too long for the time left is not started |
| A8 Cues | `lib/station/cues.ts` | `test/station-cues.test.ts`: the 2.13 priorities, including a safety cue that cuts an option and a read-back |
| A9 Staleness | `lib/station/staleness.ts` | `test/station-staleness.test.ts`: a Reading step without a newer update in its length plus 1.5 s is stale; Preparing never is |

### 7.4 Track B: the speaker and partner asking

| Step | Files | Tests |
|---|---|---|
| B1 Speaker engine | `lib/speaker/engine.ts` | `test/speaker-engine.test.ts`: says each question id once; never an older id; a snapshot reply older than 20 s is missed, a live one is said; `reply_spoken` after playback with the clip length; resends for 60 s; a reload during speech says it again only if under 20 s |
| B2 Speaker page | `app/speaker/page.tsx`, `components/speaker/Speaker.tsx` and `.module.css` | renders idle, speaking, said, missed, paused; words follow the sharing flag |
| B3 Partner asking | `components/partner/useAsk.ts` (return the sender once paired), `components/partner/usePushToTalk.ts`, `components/partner/PairPhone.tsx`; edits to `components/screens/Partner.tsx` and `components/partner/HoldToAsk.tsx` (pass `onHoldChange`, show the partial words or a word count, the sending state) | `test/partner-ask.test.ts`: the same text reuses its `request_id`; resend only on `DisconnectedError` and `UnknownCallResultError`, at most 3 within 30 s; `no_speech` and `error` results map to their sentences; partial words hidden with sharing off; `listenMs` is release to done; text over 500 characters is refused before sending. `test/screen-models.test.ts` still finds no option words on the phone |

### 7.5 Acceptance checks

**Every step:** in `web/`, `npm run typecheck`, `npm test` and `npm run build` each exit 0, run one at a time with no pipe on the exit path. `test/writing.test.ts` stays green (no `SELECT` strings, no banned words, no dashes or curly quotes in any new file).

**L1, the keyboard live run on `say-when-dev`** (owner present; made-up content only; about 20 minutes):

1. Owner: `spacetime call --no-config --server maincloud say-when-dev ensure_timers`. If the Cartesia key is not set yet, use silent test mode on the station and expect no speaker audio. Grant the smoke errand consent: `spacetime call --no-config --server maincloud say-when-dev grant_consent errand smoke_form owner_cli "smoke"`.
2. Stand-in agent on a laptop that is not the EEG laptop, instead of the real sidecar (never both): `cd spacetime && npm run smoke -- pair` once (owner approves), then `npm run smoke -- watch --act-as-agent --seconds 1200`. It answers with made-up options: four replies by default, two for a question containing `[yes_no]`, an errand option for one containing `[errand]`; it refuses any database not ending in `-dev` (**checked**: `spacetime/scripts/watch-scan.ts`).
3. Station: open `/station`, pair (owner approves), pick Keyboard test, Start audio, wait for the phrases, Start session with purpose test. Check: the session label is `keyboard-test` (the owner can see it in `board_ledger` or with `spacetime sql`).
4. Partner: open `/partner` on a phone, pair, type "Smoke test: which drink?". Check: the phone shows the status sentences.
5. Pick: press Y during option 2's window. Check: the screen shows "Picked option 2"; after 0.7 s the speaker page says "Tea" (if it runs and the key is set) and the phone shows "They answered". Owner (find N with `spacetime sql --no-config --server maincloud say-when-dev "SELECT active_session_id FROM config"`):
   `spacetime sql --no-config --server maincloud say-when-dev "SELECT command, source, outcome, late_by_ms FROM gesture_log WHERE session_id = <N>"`: `accepted:pick`, source `key`.
6. Grace window: on a new question, press Y in option 2's window just before option 3 starts. Check: `accepted:pick` on option 2, with `late_by_ms` above 0 when the press reached the module after option 3 began (the smoke runs saw 174 to 272 ms, **measured**). The 200 ms heard margin itself is proved by the A2 unit test, not by hand timing.
7. Yes or no: type "Smoke test: tired? [yes_no]"; press N during the window. Check `accepted:answer_no`.
8. Errand: type "Smoke test: send a request? [errand]"; press Y on "Send the smoke request". Check, in order: "Getting it ready", the read-back plays with "To send it, press C", C pressed during the read-back gives `ignored:readback_not_done`; C right after the read-back ends gives `ignored:quiet_hold` and "Too soon"; C after the window chime gives `accepted:confirm`; the stand-in claims and completes it; "Sent.".
9. Refractory: press Y twice within 1 s. Check: the second is `ignored:refractory` and shows on the board's feed.
10. Dead man: minimize the station window (keyboard mode counts hidden as input off) for 5 s. Check: board "Headset off" (or "Input off" after W1), pending confirms void, then resume 3 s after the window is back; ledger `pause` rows: `spacetime sql --no-config --server maincloud say-when-dev "SELECT kind, outcome, reason, ms FROM ledger WHERE session_id = <N>"`.
11. Reload the station mid-scan. Check: paired again without a code; one click resumes; the module paused and resumed.
12. Every row of the session in `gesture_log` has `source = key`. `curl -s https://maincloud.spacetimedb.com/v1/database/say-when-dev/route/stats` shows the picks. If module v2 is published and the run was voiced: one `word_timing` row per read, `spacetime sql --no-config --server maincloud say-when-dev "SELECT step_seq, option_id FROM word_timing WHERE session_id = <N>"`.
13. End session. Revoke the test devices afterwards if they will not be reused.

**L1 result, Oct 24 about 8:00 to 8:16 AM PDT** (session 13, `keyboard-test`, silent mode because the module has no Cartesia key; station and phone in a browser on `localhost`; stand-in agent from `spacetime/scripts/watch-scan.ts`; made-up content): 11 of 13 steps pass (**measured**): 1 to 4, 6, 7 and 9 to 13; step 5 passes except its speaker check, which was not run (no voice); step 8 fails (below). The grace pick (step 6) landed 52 ms after option 3 began and took option 2 (`late_by_ms` 52). All 9 `gesture_log` rows have `source = key`. Step 10 was simulated by overriding `document.visibilityState`, because the browser tool keeps pages visible; the module paused with `headset_off` 43 ms after the hide and resumed 3.53 s after the page was visible again. Step 11: the reload paused with `headset_off` 65 ms later (the unload sends an unhealthy beat first) and the silent checkbox had to be ticked again before Continue. Step 8 **fails in silent mode by design**: there is no read-back voice, so the module stopped the errand with `readback_not_finished` after 30 s and a C press gave `ignored:readback_not_done`. Rerun step 8, the speaker in step 5 and the `word_timing` check in step 12 once the key is set. The run found one bug, fixed with tests: a failed read-back stayed in the station's status line after the module had stopped its errand. Fixed since, the same morning: W1 (the board labelled key presses as headset commands), the status words "Waiting for confirm" and "Not started" during an idle session, and the veto headline for a yes or no NO ("Answered no"). Still open: the session label missing after a reload.

**First end-to-end live run, Oct 24 about 9:35 to 9:50 AM PDT** (session 15 on `say-when-dev`, `keyboard-test`, voiced; the real agent sidecar started with `agent/scripts/run-with-keychain.sh`; made-up content; the team as operators, not a wearer; calls off): every step of the loop ran on the live services (**measured**, from the public board rows and the ledger). The station showed "Voice ready", which needs a real token from `mint_voice_token`. Claude drafted the options (one plan took 7.56 s); the Apify RAG Web Browser returned 3 rows for one question in 17.7 s, and one later search timed out while Claude still drafted 4 options; Moss recall ran in 86 to 117 ms with 0 hits, because the memory was empty; Cartesia voiced the options and stored their word timings. Question to first option read: 19.2 to 27.0 s on the four open questions that were not paused, 9.9 s on a yes or no question. A pick released the reply 702 ms later, which is the designed 700 ms window in which NO or STOP can still cancel it. The errand step 8 passed voiced: YES picked the errand, its read-back played, a C during the read-back gave `ignored:readback_not_done`, a C right after it `ignored:quiet_hold`, and a C after the window chime `accepted:confirm`; the Actor's submit step took 3.7 s and the errand read Sent 3.9 s after the confirm. An earlier errand that got no confirm stopped on its own and nothing was sent. Found and fixed after the run: the room voice ignored a reply arriving as an update to the session row (it never spoke live), and the phone called the lookup Failed when only the memory recall failed. Moss closes itself after 3 idle minutes, so the first question after a quiet stretch had no recall.

**L2, speaker:** with the key set, one reply is said once; a second Speaker tab shows the two-speaker warning; a speaker reloaded within 20 s of a release says it; after 20 s it shows Missed.

**L3, partner voice:** on the real phone, Hold to ask "What should we eat?". Check: `via = voice` and `listen_ms` above 0 on the board's Live data; with sharing off, no words while holding.

**L4, headset path (S3):** with Shashank's decoder or the 5.1 stand-in on the deployed origin (or `http://localhost:3000` if 5.1 failed): 20 relayed commands; time each from the decoder's send to the reducer's resolve; the screen shows decoder health; pulling the decoder pauses the session within about 2 s and it resumes 3 s after the decoder is back. Record the numbers in PLAN.

**L5, soak:** 30 minutes of a running session with the station window in front, as it will be in the demo. Pass: no HeadsetLost pause in the ledger.

---

## 8. What not to claim in the demo until it is measured

- That the headset drives the deployed station page: 5.1 and L4 have not run.
- That any command came from the brain or the jaw in a `keyboard-` or `switch-` session. Those are key and switch presses, and the board must say so (W1) or the presenter must.
- Imagined fist squeezes as commands unless the wearer passed `docs/brain-mode-test.md` today. Never "thought commands", "mind control" or "it reads what they want" (the wording rule in that file).
- Any latency: command to pick, pick to the reply in the room, earpiece start lag, speech to text time. Measure on venue Ethernet with the wearer, then quote the measured number with how it was measured.
- That the module mints the voice tokens, until the key is set and one real mint has worked (`docs/spacetime.md` 8).
- That Sonic says "Eleven" or the household's names right, that the pronunciation dictionary is on, or that the tones sound like their names: none has been heard.
- That Ink-2 understood the partner, before L3 on the real phone.
- That the earpiece is private, before 5.5.
- That the station survives a 30-minute session or a hidden window, before 5.2 and L5.
- Telemetry numbers from keyboard or switch sessions as headset numbers (T1).
- A smoke-test number as if a wearer produced it (`docs/spacetime.md` 8).
- That the room voice is the person's own voice: it is a Cartesia library voice, with no cloning (D10).

---

## 9. Open questions and requests

### 9.1 Open questions that block the build

| # | Question | Blocks | Who |
|---|---|---|---|
| O1 | Port 8765 confirmed (Shashank, Oct 24 8:45 AM PDT, after the contract messages and the 250 ms health rule were sent to him). Still open: a first run of his decoder against the station (L4). `switch/` is empty (**checked**) | the headset path (not keyboard tests) | Shashank |
| O2 | Key set Oct 24 about 9:05 AM PDT: `say-when-dev` and `say-when-demo` were both published with `CARTESIA_API_KEY` from the Keychain (length checked, value never printed). Real mints and a voiced run followed the same morning (7.5, first end-to-end live run) | every voice: earpiece, speaker, Ink-2. Without it only silent keyboard tests run | Stephen |
| O3 | Result of Chrome test 5.1 on the EEG laptop | where the station is served (deployed https or `http://localhost:3000`) | first person with the laptop |
| O4 | Approve the input labeling: session labels `<mode>-<purpose>` and W1 on the dashboards, and whether R1 lands before the Sat 8 PM schema freeze | showing any keyboard or switch session to judges | Stephen |
| O5 | Closed Oct 24: Vercel project `neurolingo-web`, root `web/`, production alias `neurolingo-web.vercel.app`, reading `say-when-demo` | the deployed station, speaker and partner asking | Stephen |
| O6 | Which device is the speaker: a laptop with a loudspeaker, or a phone (5.6) | B2 testing | Stephen |
| O7 | Household names for Ink-2 keyterms need a private route; v1 ships none | name accuracy only | Stephen |
| O8 | Confirm that the paired partner phone keeps following the room toggle (no words with sharing off), as designed in 4.4 | B3 details | Stephen |
| O9 | The Cartesia plan: Free allows 2 TTS contexts and about 20,000 credits a month (`cartesia/README.md`); rehearsals plus the demo may need more | rehearsal count | Stephen |
| O10 | Publish module v2 (`docs/spacetime.md` 14, uncommitted when this was written) and copy its bindings into `web/`. Its working tree adds `report_word_timings` and leaves the station's other reducers and views (`gesture`, `heartbeat`, `report_clip_ready`, `report_readback_done`, `my_session`, `my_options`) unchanged (**checked** in the uncommitted diff); re-check after it lands. Copy the v2 bindings into `web/` together with the v2 publish, not before: v2 grows the rows of `board_calls`, `board_errands` and `call_queue`, and bindings that disagree with the module misread them (`spacetime/README.md`, Module v2). The station's own subscriptions do not change | word timings on the board (A6); every track's bindings copy | Stephen |

### 9.2 Requests to other owners

| # | To | Request | Why |
|---|---|---|---|
| R1 | module (Stephen), before the schema freeze; a CONTRACT change, announced per PLAN protocol rule 10 | Append `source` (string, default `''`) to `ledger` and fill it on `gesture` rows, or add an anonymous view `board_gestures` with `gesture_log`'s content-free columns | the board can label each command's source, not only the session |
| R2 | module, optional | A station reducer such as `report_heard(step_seq, lag_ms)`, or a `lag_ms` argument on `report_word_timings` | a judge-checkable earpiece start lag (word timings are measured inside the clip, not against the clock) |
| R3 | module, optional | YES while idle ignores a command whose `heard_step_seq` is older than the step at which the scan ended (`ignored:stale_step`) | a late YES from a veto does not open the menu |
| R4 | module, optional | A pause reason for station audio failure (an appended `PauseReason` variant) and a station-callable pause | an earpiece failure does not read as "headset lost" |
| W1 | dashboards (Stephen) | Done Oct 24: the input kind comes from the session label in `board_session_ledger`; keyboard and switch sessions read as key or switch presses on every screen, and a label that names no input claims no brain or jaw signal (`web/test/input-words.test.ts`). Per-command source still needs R1 | nothing is passed off as headset input |
| T1 | telemetry (Stephen) | Skip or tag sessions whose label starts with `keyboard-` or `switch-` | headset statistics stay headset statistics |
| D1 | decoder (Shashank) | Port 8765 (confirmed Oct 24), the contract messages, a `source` of `imagery` or `jaw` per command; optional later: an ack message | 2.4 |

---

## Appendix A: what the earpiece says

All stock phrases use the assistant voice at the person's pace and are cached at start (**design**). `{act}` is "clench once" (headset, PLAN D17), "press C" (keyboard) or "press twice" (switch).

| Key | Words |
|---|---|
| `paused` | Paused. Nothing will be sent. (same words as `cartesia` `STOCK_PHRASES.paused`) |
| `pausedIdle` | Paused after a quiet spell. Nothing will be sent. |
| `pausedHelper` | Paused by a helper. Nothing will be sent. |
| `headsetOff` | Headset off. Nothing will be sent. (`STOCK_PHRASES.headsetOff`) |
| `inputOff` | Input off. Nothing will be sent. |
| `signalLost` | Signal lost. Nothing will be sent. |
| `connectionLost` | Connection lost. Nothing will be sent. |
| `resumed` | Resumed. |
| `oneMoment` | One moment. (`STOCK_PHRASES.oneMoment`) |
| `yesOrNo` | Yes or no? |
| `noneOfThese` | None of these. (`STOCK_PHRASES.noneOfThese`) |
| `noPick` | No pick. Nothing was said. |
| `cancelled` | Cancelled. Nothing was said. |
| `noOptions` | No options this time. Nothing was said. |
| `questionWaiting` | A new question is waiting. |
| `confirmTail` (3 variants; spoken as the end of every read-back clip, not cached alone) | To send it, {act}. To cancel, do nothing. |
| `sayConfirm` (3 variants) | That needs a confirm. To send it, {act}. |
| `tooSoon` (3 variants) | Too soon. Wait a moment, then {act}. |
| `confirmed` | Confirmed. |
| `preparing` | Getting it ready. |
| `sent` | Sent. (`STOCK_PHRASES.sent`) |
| `notSent` | Not sent. (`STOCK_PHRASES.notSent`) |
| `windowClosed` | Stopped, nothing sent. (the module's sentence for `window_closed`) |
| `readbackLate` | The read-back did not finish. Nothing was sent. (the module's sentence) |
| `interrupted` | A new question came in. Nothing was sent. (the module's sentence) |
| `unknownOutcome` | It may or may not have gone through. (the module's sentence for `lease_lapsed`) |
| `tooLate` | Too late to stop it. It is already sending. |
| `noCall` | No call was made. |
| `hangingUp` | Hanging up. |
| `callEnded` | The call ended. |
| `voiceDown` | The voice is not working. Nothing will be sent. |
| `tooLong` | That request is too long to read back. Nothing will be sent. |
| menu items (reply voice, no tone) | I need something. / Send a request. / Call. / Say something else. (module text; `utterance` adds the full stop) |

Speaker only: `testVoice`: This is the Eleven room voice.

**Chimes and ticks** (**design**; short sine beeps at low gain straight to `ctx.destination`, never through `AudioOut`):

| Name | Sound | When |
|---|---|---|
| YES tick | 1200 Hz, 40 ms | YES relayed |
| NO tick | 500 Hz, 40 ms | NO relayed |
| CONFIRM tick | 900 Hz, 40 ms, twice, 80 ms apart | CONFIRM relayed |
| STOP tone | 300 Hz, 250 ms | STOP relayed |
| counted | 1500 Hz, 60 ms | a pick or answer accepted |
| not counted | 250 Hz, 50 ms, twice | 2.7 table |
| on | 700 then 1000 Hz, 60 ms each | `again`, `more_options`, `menu_open`, `resumed` mid-scan |
| off | 1000 then 600 Hz, 60 ms each | `veto_cancelled` mid-scan |
| window open | 1100 Hz, 80 ms | the confirm window opens (2.11) |

---

## Appendix B: names this design depends on

Re-check each after regenerating the bindings (**checked** today at `797eb61` unless marked).

| Name | Where checked |
|---|---|
| `request_pairing(code, role, label)`: code 100000 to 999999; role `station`, `speaker`, `partner`, `agent`; label 1 to 40 characters; `already paired`; `code taken: pick a new code` | `spacetime/src/index.ts` |
| `approve_pairing`, `revoke_device`, `operator_resume`, `end_session` (station or owner) | `spacetime/src/index.ts` |
| `start_session(label)`: Station; no active session; label `^[a-z0-9_-]{1,20}$`; first lease with `decoder_healthy = false` | `spacetime/src/index.ts` |
| `heartbeat(beat_seq, decoder_healthy)`: session station only; a beat after its lease lapsed pauses first; `false` pauses HeadsetOff; resume after `resume_good_contact_ms` with `auto_resume` | `spacetime/src/index.ts`, `liveness.ts` |
| `gesture(...)`: id `^[A-Za-z0-9:_-]{1,64}$`; source `^[a-z_]{1,16}$`; `heard_digest` at most 64 characters; repeat id with the same command returns; due idle pause applied first; the decision table | `spacetime/src/gesture.ts` |
| `report_clip_ready(option_id, clip_ms, synth_ms)`: `clip_ms` 1 to 30000; late clips ignored only when their version is neither current nor pending | `spacetime/src/index.ts` |
| `report_readback_done(kind, id, digest)`: retry returns; mismatch and deadline throw | `spacetime/src/consent.ts` |
| `report_word_timings(step_seq, option_id, starts_ms, ends_ms)` (module v2, uncommitted): session station only; 1 to 100 words; starts in order; each end at or after its start; at most 30000 ms; the read must be a `q<question>:v<version>:read:<step_seq>` speak step of this session with that option (0 for the prompt); one row per read | uncommitted `spacetime/src/index.ts`, `clock.ts` `recordWordTimings`; `spacetime/bindings/web/report_word_timings_reducer.ts` |
| CONFIRM checks in order: read-back done, window not closed, quiet hold, contact, digest, consent | `spacetime/src/consent.ts` `gateReason` |
| `reply_spoken(question_id, ms)`: Speaker; Spoken returns quietly | `spacetime/src/index.ts` |
| `ask_question(request_id, text, via, listen_ms)`: Partner or owner; request id `^[A-Za-z0-9:_-]{1,64}$`; text 1 to 500; `voice` or `typed` | `spacetime/src/index.ts` |
| `partner_listening(request_id, on)`: needs an active session | `spacetime/src/index.ts` |
| `mint_voice_token(purpose)` and its error codes | `spacetime/src/index.ts`, `voice.ts` |
| `my_session` (Station and Speaker), `my_options` (`current` flag), cue kinds, `MENU_ITEMS` | `spacetime/src/views.ts`, `clock.ts`, `consent.ts` |
| config defaults (`heartbeat_ms` 500, `liveness_lease_ms` 1500, `grace_ms` 1000, `refractory_ms` 1000, `quiet_hold_ms` 1000, `confirm_window_ms` 8000, `reply_veto_ms` 700, `yes_no_cue_ms` 900, `audio_pad_ms` 150, `clip_deadline_ms` 4000, `idle_pause_ms` 120000, `readback_deadline_ms` 30000, `resume_good_contact_ms` 3000, `pairing_ttl_ms` 300000) | `spacetime/src/config.ts` |
| Generated call shapes and the query builder (`tables.cueEvent` is an event table) | `web/lib/data/module_bindings` |
| SDK token exchange, error classes, reconnect options | `web/node_modules/spacetimedb` 2.13.0 |
| `TtsPlayer`, `PhraseCache`, `AudioOut`, `wordAt`, `utterance`, `voiceProfile`, `STOCK_PHRASES`, `listen`, `MicCapture`, `buildKeyterms` | `cartesia/src/tts.ts`, `tones.ts`, `stt.ts`, `keyterms.ts` |
| `ignoredReasonWords`, `buildPartnerView`, `HoldToAsk`, `useAsk`, `TypedQuestion`, the writing rules | `web/lib/data/spacetime-map.ts`, `web/components/partner/`, `web/test/writing.test.ts` |
