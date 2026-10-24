# Cartesia for Say When

Everything Say When does with Cartesia: the partner's question becomes text (Ink-2), options and replies are spoken with the tone the person picks (Sonic 3.6), hard names are said right (a pronunciation dictionary), browsers authenticate with short-lived access tokens, and, as a stretch, one consented phone call tells the form's recipient the request was sent (Managed Agents).

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
| `src/call.ts`, `src/call-script.ts`, `agent/` | server (sidecar) | The guarded outbound call: consent and do-not-call lists, calling hours, a read-back with a digest, one call per confirm, cancel-pending, polling, opt-outs, deleting call data. `agent/` holds the reviewed agent script. |
| `src/events.ts` | anywhere | `onEvent({ stage, status, detail, ms, counts })`, content-free, matching `pipeline_event` in PLAN.md. |

## Browser versus server

| Import | Where | Holds |
|---|---|---|
| `@say-when/cartesia/browser` | station, speaker page, partner phone | Access tokens only. Nothing it exports takes an API key. A token that looks like an API key (`sk_car_...`) is refused. |
| `@say-when/cartesia/server` | agent sidecar, CLIs | The API key, from `CARTESIA_API_KEY`. Never logged. |
| `@say-when/cartesia` | anywhere, including a SpacetimeDB module | Pure helpers: tokens, tones, keyterms, events, PCM. |

Browsers connect with `?cartesia_version=2026-08-14&access_token=<token>` because a browser cannot set WebSocket headers.

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
const prepared = dialer.prepare({ requestId, contactId: 'leon', errand: { title: 'Care team request', sentAt } });
// Speak prepared.call.readBack and store prepared.call.digest as call_request.script_digest.
// After a fresh confirm that carries the same digest:
const placed = dialer.place(requestId, confirmedDigest);
// NO, PAUSE or HEADSET-OFF: dialer.cancelActive('no' | 'pause' | 'headset_off')
const outcome = await placed.handle.done; // outcome.spoken is one sentence for the earpiece
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
| `CALL_DO_NOT_CALL_FILE`, `CALL_DO_NOT_CALL` | call | Private list, one number per line (or commas). Opt-outs heard on a call are appended to the file. |
| `CALL_CALLBACK_NUMBER` | call | A consenting teammate's US number in E.164. |
| `CALL_PERSON_NAME` | call | The name the call says it is calling for. |

The consent file is a JSON array. The example number is a 555-01XX number, which is reserved for fiction:

```json
[{ "id": "leon", "name": "Leon", "phone": "+14155550123", "consentText": "I agree to receive AI-voice phone calls from the Say When demo at this number during Cal Hacks 13 (Oct 23 to 25, 2026), and I agree that these calls are recorded and transcribed by Cartesia. I can say stop at any time.", "consentedAt": "2026-10-24T17:00:00Z", "expiresAt": "2026-10-26T07:00:00Z" }]
```

## Call safety rules, in plain words

- The model never dials. CALL only prepares; the person hears a read-back and confirms with a fresh gesture whose digest matches what they heard.
- It calls only people on the private consent list. Numbers live in that file, never in code, events or logs.
- It refuses anyone on the do-not-call list. After a call, if the transcript shows the person asking not to be called (phrases such as "stop calling" or "don't call"), their number is added to that list.
- It never calls an emergency or service number. This is not an emergency tool.
- It calls only US numbers (Cartesia numbers reach US destinations only).
- It calls only between 9 AM and 9 PM Pacific, and only when the whole call (ringing plus the 2 minute cap) fits inside that window. California bars these calls from 9 PM to 9 AM.
- It only reports an errand sent in the last ten minutes, and it only says "your request was sent at this time". It never speaks as the person and never makes new commitments.
- One confirm places one call. Retries are off: a dial that gets no answer is reported as "could not tell", never sent again.
- The opening line (the agent's welcome message) says it is an automated assistant with an AI-generated voice calling for the named person, says the call is recorded, and gives the callback number before the message. The agent's instructions tell it to give the callback number again before it hangs up; that part depends on the agent following its prompt.
- Before every call it reads the published agent and refuses if the welcome or instructions differ from `agent/`, if a voicemail message is set, or if the voice is not a library voice.
- NO, PAUSE and HEADSET-OFF cancel. Cartesia can only cancel a call that has started, so a cancel while ringing waits and fires the moment the call connects; the 25 second ring timeout bounds the rest.
- Status comes from polling Get Call about every 1.5 seconds (lifecycle webhooks are not available yet).
- After judging, delete the call data: `npm run call:delete -- <call ids>` or `dialer.deleteAll()`.

This is not legal advice.

## Setting up the calling agent (human steps, not done here)

1. In the Playground, provision the one free Cartesia number (Phone Numbers, Add Number, Cartesia Number). Note whether it asked for a card.
2. Create an agent. Paste `agent/welcome.txt` into the welcome message and `agent/instructions.txt` into the instructions, exactly. Pick a library voice. Turn voicemail detection off, or leave its message empty. Optionally set the pronunciation dictionary. Publish it: Preview does not publish.
3. Put the agent id and the number's id in `.env.local`, plus the consent file path, the callback number and the person's name.
4. Run `npm run call:check`. It reads the lists and the published agent and places no call.
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
18. Our own limits, not Cartesia's: 500 dictionary entries, 30 seconds per question, 1 to 10 minute calls, 100 to 3000 ms pauses.

## Tests

```bash
npm install
npm run typecheck
npm test
```

`test/no-network.ts` replaces `fetch` and `WebSocket` with functions that throw, so no test can reach Cartesia. The suites cover the token request shape, the TTS message shape (emotion, laughter, dictionary, timestamps, buffering), clip length from audio bytes, one-at-a-time generation, cancel, streams, the phrase cache, playback scheduling, the STT URL and keyterms, turn handling, the dictionary payload and echo check, library voices, every call guard (consent, do-not-call, emergency numbers, hours, one call per confirm, no retries, cancel-pending, the agent check, opt-outs, deleting data), and that no key or phone number reaches events or logs. The repo's CI does not run this package yet.

## Sources

Cartesia docs, read October 24, 2026: [Cal Hacks starter pack](https://docs.cartesia.ai/calhacks), [authenticate client apps](https://docs.cartesia.ai/get-started/authenticate-your-client-applications), [access token](https://docs.cartesia.ai/api-reference/auth/access-token), [API conventions](https://docs.cartesia.ai/use-the-api/api-conventions), [API errors](https://docs.cartesia.ai/use-the-api/api-errors), [TTS WebSocket](https://docs.cartesia.ai/api-reference/tts/websocket), [contexts](https://docs.cartesia.ai/use-the-api/tts-websocket/contexts), [buffering](https://docs.cartesia.ai/use-the-api/tts-websocket/buffering), [volume, speed and emotion](https://docs.cartesia.ai/build-with-cartesia/capability-guides/volume-speed-emotion), [SSML tags](https://docs.cartesia.ai/build-with-cartesia/capability-guides/ssml-tags), [Sonic 3.6](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest), [TTS caching](https://docs.cartesia.ai/build-with-cartesia/capability-guides/tts-caching), [multilingual voices](https://docs.cartesia.ai/build-with-cartesia/capability-guides/multilingual-voices), [custom pronunciations](https://docs.cartesia.ai/build-with-cartesia/capability-guides/custom-pronunciations), [dictionary create](https://docs.cartesia.ai/api-reference/pronunciation-dicts/create), [dictionary update](https://docs.cartesia.ai/api-reference/pronunciation-dicts/update), [list voices](https://docs.cartesia.ai/api-reference/voices/list), [STT turns WebSocket](https://docs.cartesia.ai/api-reference/stt/turns/websocket), [turn detection](https://docs.cartesia.ai/use-the-api/stt/turns), [keyterms](https://docs.cartesia.ai/use-the-api/stt/keyterms), [audio input](https://docs.cartesia.ai/build-with-cartesia/stt/audio-input), [concurrency and timeouts](https://docs.cartesia.ai/use-the-api/concurrency-limits-and-timeouts), [pricing](https://docs.cartesia.ai/pricing), [outbound calling](https://docs.cartesia.ai/line/integrations/telephony/outbound-dialing), [Cartesia numbers](https://docs.cartesia.ai/line/integrations/telephony/cartesia-numbers), [create outbound call](https://docs.cartesia.ai/api-reference/agents/calls/create-outbound-call), [get call](https://docs.cartesia.ai/api-reference/agents/calls/get-call), [cancel call](https://docs.cartesia.ai/api-reference/agents/calls/cancel-call), [delete call](https://docs.cartesia.ai/api-reference/agents/calls/delete-call), [get agent](https://docs.cartesia.ai/api-reference/agents/get), [agent configuration](https://docs.cartesia.ai/agents/configuration), [dynamic variables](https://docs.cartesia.ai/agents/dynamic-variables). Plans: [cartesia.ai/pricing](https://www.cartesia.ai/pricing). SDK: `@cartesia/cartesia-js` 4.2.0 type definitions (read as text, not run).
