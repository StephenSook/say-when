# Cartesia for NeuroLingo

Everything NeuroLingo does with Cartesia: the partner's question becomes text (Ink-2), options and replies are spoken with the tone the person picks (Sonic 3.6), hard names are said right (a pronunciation dictionary), browsers authenticate with short-lived access tokens, and, as a stretch, one consented phone call tells the form's recipient the request was sent (Managed Agents).

Every API detail here was checked on October 24, 2026 against docs.cartesia.ai for API version `2026-08-14`, the Cal Hacks starter pack, and the official JS SDK 4.2.0 type definitions. Sources are at the end. **Nothing in this package has been run against the live Cartesia API yet**: the tests use fake sockets and a fake fetch, and they cannot reach the network.

No voice cloning, and no hook for it. Every voice is from Cartesia's library.

## What each piece does

| File | Runs on | What it does |
|---|---|---|
| `src/stt.ts` | partner phone (browser) | Push to talk. Streams the mic to the Ink-2 turns socket only while the button is held, with household and place keyterms. Reports partial text, eager end and resume, and ends on the turn end (or on release). |
| `src/tts.ts` | wearer station and speaker page (browser) | Generates each option in its own context, one at a time, with its tone, the pronunciation dictionary, word timestamps and no server buffering. Returns the clip and its length in ms for the scan clock. Cancel, continuation streams, a stock phrase cache, playback and the word under the playhead. |
| `src/tones.ts` | anywhere | The voice for each kind of utterance, tones mapped to `generation_config.emotion`, the laugh tag, the person's pace, `<spell>` codes and `<break>` pauses, stock phrases, and an optional second language. |
| `src/keyterms.ts` | anywhere | Merges household names and current Apify place names into Ink-2 keyterms within the limits. |
| `src/token.ts` | SpacetimeDB procedure or the sidecar | Builds and reads the `POST /access-token` request with one grant and a short expiry. |
| `src/dictionary.ts` | server | Creates or replaces the private pronunciation dictionary from place and household names, and checks the echo. |
| `src/voices.ts` | server | Lists library voices to audition, and checks that configured ids are library voices. |
| `src/call.ts`, `src/call-script.ts`, `agent/` | server (sidecar) | The guarded outbound call: consent and do-not-call lists, calling hours, a read-back with a digest, one call per confirm, cancel-pending, polling, holds on possible refusals, deleting call data. `agent/` holds the reviewed agent script. |
| `src/events.ts` | anywhere | `onEvent({ stage, status, detail, ms, counts })`, content-free, matching `pipeline_event` in PLAN.md. |

## Browser versus server

| Import | Where | Holds |
|---|---|---|
| `@say-when/cartesia/browser` | station, speaker page, partner phone | Access tokens only. Nothing it exports takes an API key. A token that looks like an API key (`sk_car_...`) is refused. |
| `@say-when/cartesia/server` | agent sidecar, CLIs | The API key, from `CARTESIA_API_KEY`. Never logged. |
| `@say-when/cartesia` | anywhere, including a SpacetimeDB module | Pure helpers: tokens, tones, keyterms, events, PCM. |

Browsers connect with `?cartesia_version=2026-08-14&access_token=<token>` because a browser cannot set WebSocket headers.

The package keeps its old name, `@say-when/cartesia`, until the repo itself is renamed, so the imports here still use it.

## How to use it

Minting a token. In the sidecar:

```ts
import { apiKeyFromEnv, mintAccessToken } from '@say-when/cartesia/server';
const { token, expiresAt } = await mintAccessToken(apiKeyFromEnv(), 'stt'); // 'tts' for the station and speaker
```

In a SpacetimeDB procedure (`mint_voice_token`), the request is built and read here and sent with the module's own `ctx.http.fetch`, which takes `{ method, headers, body }` and returns `status` and `text()`. Check the caller is a paired device first. This path has not been tried on Maincloud.

```ts
import { buildMintRequest, parseMintResponse } from '@say-when/cartesia';
const request = buildMintRequest(apiKey, 'tts', 60);
const response = ctx.http.fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
return parseMintResponse(request, response.status, response.text(), nowMs);
```

The partner phone, push to talk:

```ts
import { buildKeyterms, listen, TURN_PROFILES } from '@say-when/cartesia/browser';

const { keyterms } = buildKeyterms(householdNames, placeNames); // household first, then current Apify places
let session;
askButton.onpointerdown = () => {
    session = listen({
        getToken: () => getVoiceToken('stt'), // your call to mint_voice_token
        keyterms,
        turn: TURN_PROFILES.patient, // or leave unset for the server default
        onPartial: (text) => showLive(text),
        onEagerEnd: (text) => startEarly(text),
        onResume: () => cancelEarly(),
    });
    session.done.then((result) => result.ok && askQuestion(requestId, result.text));
};
askButton.onpointerup = () => session?.release();
```

The wearer station:

```ts
import { AudioOut, PhraseCache, stockUtterances, TtsPlayer, utterance, voiceProfile, wordAt } from '@say-when/cartesia/browser';

const profile = voiceProfile({ assistantSpeed: 0.85 }); // the person's own pace for prompts and read-backs
const player = new TtsPlayer({ getToken: () => getVoiceToken('tts'), pronunciationDictId: dictId });
const cache = new PhraseCache(player);
await cache.warm(stockUtterances(profile)); // "Paused. Nothing will be sent." and the rest, once

for (const option of options) {
    // One at a time: the Free plan allows 2 concurrent TTS contexts and the player uses 1.
    const clip = await player.synthesize(utterance({ kind: 'option', text: option.text, tone: option.tone, laugh: option.laugh }, profile));
    reportClipReady(option.id, clip.durationMs); // dwell time for the scan clock
}
const out = new AudioOut(new AudioContext());
await out.play(clip); // highlight with wordAt(clip.words, out.positionMs())
```

Tones are `neutral`, `calm`, `warm`, `sad` and `firm`. An unknown tone sends no emotion rather than a guess. Read-backs can spell codes and pause: `utterance({ kind: 'readback', segments: ['Confirmation', spell('AB12CD')] }, profile)`.

A second language, off by default: `voiceProfile({ partnerLocale: 'es-MX' })` makes `reply` utterances use `locale: "es-MX"`, without emotion or laughter (emotion is English only). The planner has to write the reply in that language. Options in the earpiece stay English.

The dictionary, from a private lexicon file (gitignored under `private/`):

```json
{ "household": [{ "name": "Siobhan", "sayAs": "shi-VAWN" }, { "name": "Khadim" }], "places": [{ "name": "Gough Street", "sayAs": "goff street" }] }
```

`npm run dict:sync -- --file private/lexicon.json` creates the dictionary (or replaces its items when `CARTESIA_PRONUNCIATION_DICT_ID` is set) and prints the id. Only names with a `sayAs` become dictionary entries; every name becomes a keyterm. Get each pronunciation from the family, never from a guess.

Voices: `npm run voices -- --q warm --language en` lists library voices with Playground links to listen. `npm run voices -- --check` confirms the configured ids are library voices. The defaults are Skylar (`db6b0ed5-d5d3-463d-ae85-518a07d3c2b4`, a stable voice the Sonic 3.6 page lists for agents) for prompts and read-backs, and Tessa (`6ccbfb76-1fc6-48f7-b71d-91ac6298247b`, on the emotion page's list of voices with the best emotional response) for options and replies. Daniel (`47c38ca4-5f35-497b-b1a3-415245fb35e1`) is the other stable voice from the Sonic 3.6 page. Audition before the demo and swap ids through `voiceProfile` or the env overrides.

The call, from the sidecar:

```ts
import { dialerFromEnv } from '@say-when/cartesia/server';

const dialer = dialerFromEnv(process.env, { onEvent, onUpdate });
// The title must be on the approved list; the form's own title only picks one of them.
const prepared = dialer.prepare({ requestId, contactId: 'leon', errand: { title: 'Care team request', sentAt } });
// Speak prepared.call.readBack and store prepared.call.digest as call_request.script_digest.
// After a fresh CONFIRM (double jaw clench) that carries the same digest. confirmedAtMs is when the CONFIRM itself
// happened (call_queue.confirmed_at from the module, in ms since 1970), never when the sidecar saw it:
const placed = dialer.place(requestId, confirmedDigest, confirmedAtMs);
// placed.ok is false with refusal.code 'expired' when that CONFIRM is over 30 s old, or 'confirm_time_unknown' when
// the time is missing, not a number, or more than 5 s ahead of this laptop's clock.
// STOP (long jaw clench), HEADSET-OFF or the idle auto-pause: dialer.cancelActive('stop' | 'headset_off' | 'auto_pause')
const outcome = await placed.handle.done; // outcome.spoken is one sentence for the earpiece
// outcome.held means the contact is on hold: a possible refusal, an end the dialer could not read, or a hold file
// problem. After a person has checked with them (not while a call is in progress):
dialer.clearHold('leon', 'Talked with Leon by text; he still wants these calls.');
```

## Environment variables

All server side. Put real values in `.env.local` at the repo root (gitignored); the CLIs load it.

| Variable | Used by | Notes |
|---|---|---|
| `CARTESIA_API_KEY` | token minting, dictionary, voices, call | The only secret. Never in a browser, never logged. |
| `CARTESIA_PRONUNCIATION_DICT_ID` | `dict:sync` update, then every TTS request | An id, not a secret. |
| `CARTESIA_ASSISTANT_VOICE_ID`, `CARTESIA_REPLY_VOICE_ID` | `voices --check` | Optional overrides. |
| `CARTESIA_AGENT_ID`, `CARTESIA_FROM_NUMBER_ID` | call | Ids from the Playground, not phone numbers. |
| `CALL_CONSENT_FILE` or `CALL_CONSENT` | call | Path to the private consent JSON, or the JSON inline. No list means no calls. |
| `CALL_DO_NOT_CALL_FILE`, `CALL_DO_NOT_CALL` | call | Private list, one number per line (or commas). Numbers added with `dialer.optOut()` are appended to the file. |
| `CALL_HOLD_FILE` | call, `call:clear-hold` | Required for calls, and must be writable (created owner-only if missing; spaces around the path are trimmed). Private hold file (JSON lines, gitignored). A pending hold is added before every dial and released after a call that ended with nothing heard; every possible refusal and every clear, with its reason, is added too. Every prepare, confirm, dial and clear reads it again, so holds survive a restart and count for every dialer that shares the file. Never edit or delete it by hand. |
| `CALL_CALLBACK_NUMBER` | call | A consenting teammate's US number in E.164. |
| `CALL_PERSON_NAME` | call | The name the call says it is calling for. |
| `CALL_ERRAND_TITLES` | call | Comma-separated errand titles a call may report. Empty means `Care team request` only. Up to 40 letters, digits, spaces or basic punctuation each. |

The consent file is a JSON array. Every entry needs the recipient's own IANA time zone (`America/...` or `Pacific/...`), and the id must start with a letter. The example number is a 555-01XX number, which is reserved for fiction:

```json
[{ "id": "leon", "name": "Leon", "phone": "+14155550123", "timeZone": "America/Los_Angeles", "consentText": "I agree to receive AI-voice phone calls from the NeuroLingo demo at this number during Cal Hacks 13 (Oct 23 to 25, 2026), and I agree that these calls are recorded and transcribed by Cartesia. I can say stop at any time.", "consentedAt": "2026-10-24T17:00:00Z", "expiresAt": "2026-10-26T07:00:00Z" }]
```

## Call safety rules, in plain words

- The model never dials. The person hears a read-back, and only a fresh CONFIRM (double jaw clench) whose digest matches what they heard releases the dial.
- It calls only people on the private consent list. Numbers live in that file, never in code, events or logs.
- It refuses anyone on the do-not-call list, and anyone on hold. Every call is on hold from just before its dial request: a pending hold goes into `CALL_HOLD_FILE` first (if it cannot be written, there is no call), and it is released only when the call has ended in a known way with nothing heard. A crash, a timeout, a lost answer or an end the dialer could not read leaves the contact on hold.
- A call ends with a refusal hold when the transcript shows the person called saying any word from one short shared list (`HOLD_TRIGGERS` in `src/call-script.ts`: stop, remove, unsubscribe, opt out, take me off, take us off, take my, take our, leave me alone, leave us alone, leave me be, leave us be, lose my, lose our, forget my, forget our, no more, no longer, not interested, enough, record, desist, delete, erase, harass, quit it, knock it off, cut it out, go away), or "off" or "from" followed within three words by "list" ("off your list", "off the call list", "off our calling list", "off of this list", "from your contact list"), or a word that refuses, negates or ends (not, never, no, don't, won't, can't, quit, cease, end and similar) followed within eight words by a calling word ("don't call", "no calls", "quit calling", "end these calls", "never contact", "did not consent"), or the agent answering that it will not call again. All of the person's turns are read together, so a refusal split across two turns still counts. Before matching, accents and other combining marks are removed and full-width or styled letters become plain ones (NFKD), so "stop" written with an accented "o", or with a separate accent mark after a letter, still reads as "stop". There is no attempt to read intent: harmless uses ("I'll stop by", "don't forget to call me", "is this being recorded?") hold the contact too, on purpose. A false hold costs a person one check; a missed refusal could mean calling someone who said no.
- A hold lasts until a person checks with the contact and clears it with a short reason: `npm run call:clear-hold -- --contact <id> --reason "<why it is safe to call again>"`, or `dialer.clearHold(id, reason)`. Each clear names the exact hold it ends, so a clear based on an old read never ends a newer hold, and the file is the log. The dialer will not clear a hold while a call is in progress, and a refusal heard on a call is written as that call's last record, so a clear made from outside during the call cannot outlast it.
- Every prepare, confirm, dial and clear reads the hold file again, so a hold saved by another dialer or process that shares the file counts at once. Of two dialers racing to call one number, only the one whose pending hold reached the file first dials. If the hold file cannot be read, nothing is called. If a refusal hold cannot be written, the dialer refuses every call until it is restarted, and the call's pending hold, never released, still holds the number after the restart. If a release cannot be written, the contact stays on hold. The agent is told to apologize and end the call on any refusal.
- It never calls an emergency or service number. This is not an emergency tool.
- It calls only US numbers (Cartesia numbers reach US destinations only). A number written with a plus sign must be +1 and exactly ten digits.
- It calls only when the whole call (ringing plus the 2 minute cap) fits inside 9 AM to 9 PM in the recipient's own time zone, and also in Pacific time for the venue. California bars these calls from 9 PM to 9 AM.
- It only reports an errand sent in the last ten minutes, and it only says "<person>'s <title> was sent at <time>". The title comes from the team's approved list, never from a web page, and the agent's instructions quote the message and call it data, not instructions. It never speaks as the person and never makes new commitments.
- Every guard runs again right before the dial request: consent, do-not-call, holds (read again from the file), the number, the hours, and a CONFIRM no older than 30 seconds. This last check comes after the dialer's final update to the station and the dashboard and after the hold file is read and written, so a STOP, HEADSET-OFF or opt-out sent while "dialing" shows still stops the call.
- The 30 seconds are counted from the CONFIRM itself, not from when the dialer was asked to call. `place()` takes the CONFIRM's own time (the module's `call_queue.confirmed_at`) and checks it twice: when it is called, and again with nothing between that check and the dial request. So a CONFIRM that reached the sidecar late, or went stale while the published agent was checked or the hold file was written, never rings a phone, not even briefly. A CONFIRM time that is missing, is not a number, or is more than 5 seconds ahead of this laptop's clock is refused (`confirm_time_unknown`: "I could not check when you confirmed, so I did not call."). When the CONFIRM's time reads ahead of this clock by up to 5 seconds, the window starts at `place()` instead, so the dial still comes at most 30 seconds after the call to `place()`. The window can be set shorter, never longer than 30 seconds, and the allowed clock difference smaller, never larger than 5 seconds; a value that is not a number stops startup.
- One CONFIRM places one call. Retries are off. A dial that gets no answer, a server error or an unreadable reply is reported as "could not tell", never as "not dialed", and never sent again, and the contact stays on hold until a person checks.
- The opening line (the agent's welcome message) says it is an automated assistant with an AI-generated voice calling for the named person through the NeuroLingo app, says the call is recorded, and gives the callback number before the message. The check refuses a welcome that leaves any of these out or says them after the message. The agent's instructions tell it to give the callback number again before it hangs up; that part depends on the agent following its prompt.
- Before every call it reads the published agent and compares it, character for character, with `agent/welcome.txt` and `agent/instructions.txt`, which are the only baseline. It refuses on any difference, if a voicemail message is set, or if the voice is not a library voice. There is no way to skip this check.
- STOP (long jaw clench), HEADSET-OFF and the 2-minute idle auto-pause cancel or hang up. Cartesia can only cancel a call that has started, so a cancel while ringing waits and fires the moment the call connects; the 25 second ring timeout bounds the rest.
- Status comes from polling Get Call about every 1.5 seconds (lifecycle webhooks are not available yet). Every copy of text that leaves the dialer (dashboard transcript lines, the call summary, event details, error messages) goes through `redact()`: the text is normalized (NFKC), invisible characters are dropped, keys and tokens are masked, then every number character in any script or form (circled, superscript, full-width) becomes `#`, and every spoken number word (zero to nineteen, the tens, hundred, thousand, oh, o, nought, double, triple, and any word made only of these) becomes `#`. There are no exceptions: dates, times, prices and ages are masked too, so "415-555-0188" shows as "###-###-####" and "at 9:30" as "at #:##". The private transcript stays inside the dialer unchanged; only the hold check reads it.
- After judging, delete the call data: `npm run call:delete -- <call ids>` or `dialer.deleteAll()`.

This is not legal advice.

## Setting up the calling agent (human steps, not done here)

1. In the Playground, provision the one free Cartesia number (Phone Numbers, Add Number, Cartesia Number). Note whether it asked for a card.
2. Create an agent. Paste `agent/welcome.txt` into the welcome message and `agent/instructions.txt` into the instructions, exactly: the check compares character for character, and the only difference allowed is each file's final newline. Pick a library voice. Turn voicemail detection off, or leave its message empty. Optionally set the pronunciation dictionary. Publish it: Preview does not publish.
3. Put the agent id and the number's id in `.env.local`, plus the consent file path (each entry with its `timeZone`), the hold file path (`CALL_HOLD_FILE`, a private file the dialer may create), the callback number, the person's name and, if needed, `CALL_ERRAND_TITLES`.
4. Run `npm run call:check`. It reads the lists, the hold file and the published agent, prints how many contacts are on hold, prints where the first difference is if the script does not match, and places no call.
5. Make one daytime test call to the consenting number. Note what `created` and `started` actually mean and check the usage page for LLM charges.

## Credits on the Free plan

- 20,000 credits a month. Sonic costs about 1 credit per character (about 27 minutes of speech a month). Ink-2 costs 3 credits per second of audio sent, silence included (about 1 hour 51 minutes a month).
- That is why the mic streams only while the button is held, stops at the first turn end, and has a 30 second hard limit. A stream left open for an hour would cost 10,800 credits, over half the month.
- A rough flow (our estimate): 10 seconds of question (30), four options of about 60 characters (240), a read-back of about 150 characters (150): about 420 credits.
- Cached stock phrases cost credits once. Replay an option's clip instead of generating it again.
- The Free plan allows 2 concurrent TTS contexts (the player uses 1) and 8 concurrent STT streams.
- Calls draw from $1 of prepaid agent dollars a month: $0.06 a minute plus $0.014 on a Cartesia number, so about 13.5 minutes before any LLM token charges.

## Which Cartesia features are wired, tested, or only documented

"Tested" means unit tests against fakes. None of it has run against the live API.

| Feature | Status |
|---|---|
| Access tokens, one grant each, browsers refuse API keys | Wired, tested |
| Sonic TTS WebSocket, one context per option, one at a time | Wired, tested |
| `generation_config.emotion` per option (tones) | Wired, tested. Beta; no listening test yet |
| `[laughter]` | Wired, tested. Not heard yet |
| `generation_config.speed` (the person's pace) and `volume` | Wired, tested |
| `<spell>` and `<break>` in read-backs | Wired, tested in `renderSegments`. The errand read-back builder does not use them yet |
| Pronunciation dictionary on every TTS request | Wired, tested. `dict:sync` creates or replaces it |
| Word timestamps and the word under the playhead | Wired, tested |
| `max_buffer_delay_ms: 0` for whole text | Wired, tested |
| Continuation streams (`continue: true`) with managed buffering | Wired, tested. Not used by the station flow yet |
| Context cancel | Wired, tested |
| Stock phrase cache | Wired, tested |
| Streamed playback with Web Audio (`AudioOut`) | Wired, tested with a fake AudioContext. Never played in a browser |
| Ink-2 turns socket, keyterms, turn profiles, eager end and resume, close command | Wired, tested |
| Mic capture (getUserMedia, AudioWorklet, 16 kHz downsampling) | Wired. The downsampler and PCM steps are tested; `MicCapture` itself has never run in a browser |
| Library voice list and check (`GET /voices`) | Wired, tested |
| Second language for replies (`locale`) | Wired, tested, off by default. Not heard yet |
| Managed Agents outbound call, Get Call polling, cancel, delete, Get Agent check | Wired, tested. No agent or number exists yet |
| Pending holds around every dial, holds on possible refusals, the hold file and `call:clear-hold` | Wired, tested through the exported functions with an in-memory file and a real one; the command itself has not been run |
| Voice cloning | Not used, by decision |
| Infill, batch calls, agent webhook tools, SSE and bytes endpoints, batch STT, the official SDK | Not used |

## What was not verified

1. No request has gone to Cartesia from this code. Every shape below matches the docs and the SDK types, not a live answer.
2. Dictionary item field: the 2026-08-14 reference requires `pronunciation`, SDK 4.2.0 types it `alias`. We send `pronunciation` and check that the response echoes each one; if it does not, `dict:sync` fails and says to try `--field alias`.
3. Whether PATCH on a dictionary replaces or merges its items. We always send the full list.
4. Whether the dated snapshot `sonic-3.6-2026-08-27` is accepted on the WebSocket (it is not in that schema's model enum). The default is `sonic-3.6`, which is.
5. Turn detection defaults: the reference says 0.8, 0.6, 0.3 and 5600 ms; the SDK 4.2.0 comments say 0.4 for eager end and 0.2 for end. We send none unless a profile is chosen.
6. Call statuses: the reference lists `created`, `started`, `completed` and `failed`; SDK 4.2.0 types `active`, `completed`, `failed` and `cancelled`. Both are handled. Reading `created` as ringing and `started` as connected is our inference.
7. Whether the STT grant covers `/stt/turns/websocket`. The auth guide lists `/stt/websocket`; the reference says the grant covers "any STT endpoint".
8. Whether an open TTS socket survives its token's expiry. The player mints a fresh token whenever it reconnects.
9. Whether word timings in later timestamp messages are measured from the start of the clip. The code assumes so.
10. What `use_normalized_timestamps: false` returns after a dictionary replacement.
11. Whether `[laughter]` works outside English. We drop it there.
12. Whether a voicemail message fills `{{variables}}`. The docs do not say, so the call check requires no voicemail message.
13. Whether `GET /voices?q=<id>` finds a voice by its exact id. The reference says `q` searches by voice id.
14. How Sonic reads the callback number "415-555-0123". The SSML guide says to write phone numbers as plain text.
15. Whether the free number needs a card, and whether LLM tokens are billed on calls today (three Cartesia pages disagree).
16. `MicCapture` on a real phone: the permission prompt, AudioWorklet support and the sample rate.
17. The tone mapping (`warm` to `content`, `firm` to `angry`) is our choice. It needs a listening test.
18. Our own limits, not Cartesia's: 500 dictionary entries, 30 seconds per question, 1 to 10 minute calls, 100 to 3000 ms pauses, 30 seconds from CONFIRM to dial, 10 seconds to get a token, 5 seconds to finish after the button is let go.
19. Whether the Playground stores a pasted script exactly as typed. If it adds or trims anything, the exact check refuses and `call:check` says where.
20. The recipient's time zone comes from the consent file. The code checks it is a real `America/` or `Pacific/` zone the runtime knows, not that it matches where the phone actually is.
21. How Sonic and the call agent say "NeuroLingo". If it comes out wrong, add it to the private lexicon with a `sayAs` the team has listened to; the dictionary has no entry for it today.
22. The hold word list is ours, not Cartesia's, and English only. A refusal that uses none of its words, no refusing word before a calling word and no list to come off (for example one in another language) is caught only if the agent answers that it will not call again, and not at all if the call ends first. Accented and styled letters are folded to plain ones, but letters from other alphabets that look like Latin ones (a Cyrillic letter that looks like "o" inside "stop") are not. Transcript roles `user`, `assistant` (the agent) and `system` come from the SDK 4.2.0 types.
23. Holds on harmless speech, accepted: "I'll stop by", "don't forget to call me", "is this being recorded?", "good enough", "no more questions", "no, call me later", "at the end of the day, call me" and name corrections such as "don't call me Lee" all put the contact on hold until a person clears it.
24. Holding on any objection to the recording is our policy choice: the consent text covers recorded calls, and every call is recorded.
25. Over-masking, accepted: every digit and number word is masked in the dashboard transcript, the summary, events and errors, including dates, times, prices, ages and ordinary words such as "one" in "the one I sent".
26. The masked copy is the normalized text: full-width letters become plain letters, invisible characters disappear and a few symbols change form (an ellipsis character becomes three dots). The private transcript keeps the original.
27. Only English number words are masked, and letters from other alphabets that look like Latin ones (a Cyrillic letter that looks like "o", written inside "one") are not folded, so a number spoken in another language, or spelled with such letters, would show as words.
28. Letters typed in place of digits inside a number (an O for 0, an l for 1) stay visible, though every real digit around them is masked.
29. A hold is kept by phone number with the contact id it was placed for. If a consent entry's number changes, the hold stays on the old number; clearing goes by the contact id the hold was placed under.
30. The hold and masking design is the newest part of this package. One outside review of it found six problems in the hold file design (missing refusal words, a hold lost after a failed write and a restart, a clear during a call, a second dialer, a stale clear, spaces in the path) and one in the clear command's output; each is fixed here with a regression test, and the fixes have not had an outside review.
31. The hold file has no lock. Each record is one small append, which a local file system does not interleave, and only the first pending hold for a number in the file may dial. Not covered: a hold file on a network share, and editing or deleting the file by hand (a deleted file reads as empty, which frees every number). Run one dialer process and leave the file alone.
32. `npm run call:clear-hold` run while another process has a call in progress can free that number until the call ends (the call writes its hold back at the end if anything was heard). Clear holds only when no call is in progress.
33. Whether the transcript is complete when Get Call first reads `completed`. The pending hold is released on the first terminal status with nothing heard, so a refusal that reaches the transcript only after that would be missed.
34. Holds on unknown ends, accepted: a call whose end the dialer could not read (no clear answer to the dial, a server error, polling that ran out) keeps its contact on hold until a person clears it, with the same sentence and the same reason as a refusal hold.
35. The CONFIRM's time comes from the module's clock and the 30 second check runs on this laptop's clock. If the module's clock runs ahead of this one, a CONFIRM looks younger than it is by that much, and a CONFIRM whose time reads more than 5 seconds ahead is refused; either way the dial never comes more than 30 seconds after `place()`. If the module's clock runs behind, a CONFIRM looks older, and calls are refused sooner. The two clocks have not been compared on Maincloud.

## Tests

```bash
npm install
npm run typecheck
npm test
```

`test/no-network.ts` replaces `fetch` and `WebSocket` with functions that throw, so no test can reach Cartesia. The suites cover the token request shape, the TTS message shape (emotion, laughter, dictionary, timestamps, buffering), clip length from audio bytes, one-at-a-time generation, cancel, streams, the phrase cache, playback scheduling, the STT URL and keyterms, turn handling, the dictionary payload and echo check, library voices, every call guard (consent, do-not-call, emergency numbers, the recipient's hours, approved errand titles, the re-check before dialing, including a cancel or opt-out from any callback before the dial, the age of the CONFIRM counted from its own time at the confirm and again right before the dial request (stale, exactly 30 seconds, missing, not a number, ahead of the clock, and the window and clock settings), one call per confirm, no retries, unclear dial answers, cancel-pending, the exact agent check, holds on every word in the trigger list and every refusal wording found in review, the pending hold around every dial, holds that survive a restart and a failed write, need a reason to clear and cannot be cleared during a call, a second dialer sharing the file, two dialers racing for one number, a stale clear, masking of every digit and number word in every form found in review, deleting data), cancels during token and socket setup, and that no key or phone number reaches events, error properties or logs. The repo's CI runs the typecheck, the build and these tests, with a floor on the number of passing tests.

## Sources

Cartesia docs, read October 24, 2026: [Cal Hacks starter pack](https://docs.cartesia.ai/calhacks), [authenticate client apps](https://docs.cartesia.ai/get-started/authenticate-your-client-applications), [access token](https://docs.cartesia.ai/api-reference/auth/access-token), [API conventions](https://docs.cartesia.ai/use-the-api/api-conventions), [API errors](https://docs.cartesia.ai/use-the-api/api-errors), [TTS WebSocket](https://docs.cartesia.ai/api-reference/tts/websocket), [contexts](https://docs.cartesia.ai/use-the-api/tts-websocket/contexts), [buffering](https://docs.cartesia.ai/use-the-api/tts-websocket/buffering), [volume, speed and emotion](https://docs.cartesia.ai/build-with-cartesia/capability-guides/volume-speed-emotion), [SSML tags](https://docs.cartesia.ai/build-with-cartesia/capability-guides/ssml-tags), [Sonic 3.6](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest), [TTS caching](https://docs.cartesia.ai/build-with-cartesia/capability-guides/tts-caching), [multilingual voices](https://docs.cartesia.ai/build-with-cartesia/capability-guides/multilingual-voices), [custom pronunciations](https://docs.cartesia.ai/build-with-cartesia/capability-guides/custom-pronunciations), [dictionary create](https://docs.cartesia.ai/api-reference/pronunciation-dicts/create), [dictionary update](https://docs.cartesia.ai/api-reference/pronunciation-dicts/update), [list voices](https://docs.cartesia.ai/api-reference/voices/list), [STT turns WebSocket](https://docs.cartesia.ai/api-reference/stt/turns/websocket), [turn detection](https://docs.cartesia.ai/use-the-api/stt/turns), [keyterms](https://docs.cartesia.ai/use-the-api/stt/keyterms), [audio input](https://docs.cartesia.ai/build-with-cartesia/stt/audio-input), [concurrency and timeouts](https://docs.cartesia.ai/use-the-api/concurrency-limits-and-timeouts), [pricing](https://docs.cartesia.ai/pricing), [outbound calling](https://docs.cartesia.ai/line/integrations/telephony/outbound-dialing), [Cartesia numbers](https://docs.cartesia.ai/line/integrations/telephony/cartesia-numbers), [create outbound call](https://docs.cartesia.ai/api-reference/agents/calls/create-outbound-call), [get call](https://docs.cartesia.ai/api-reference/agents/calls/get-call), [cancel call](https://docs.cartesia.ai/api-reference/agents/calls/cancel-call), [delete call](https://docs.cartesia.ai/api-reference/agents/calls/delete-call), [get agent](https://docs.cartesia.ai/api-reference/agents/get), [agent configuration](https://docs.cartesia.ai/agents/configuration), [dynamic variables](https://docs.cartesia.ai/agents/dynamic-variables). Plans: [cartesia.ai/pricing](https://www.cartesia.ai/pricing). SDK: `@cartesia/cartesia-js` 4.2.0 type definitions (read as text, not run).
