# Moss retrieval

The retrieval layer for the Eleven agent sidecar. (Code identifiers, the `@say-when/moss` package name and the `say-when` session name, keep the old name until the repo is renamed; see PLAN.md D13.) One Moss session on the agent laptop holds two things:

1. **The person's own memory**: replies they confirmed before (with which partner asked and when) and their preferences. It is recalled locally the moment a question's text lands, before any web search, so the earpiece can start with the person's own past answers.
2. **The current question's web passages and places**, from the Apify rows. They are chunked and indexed on the laptop, searched, and deleted once the question is answered.

The planner's options are then ordered by memory affinity, and every confirmed reply is written back, so the next question from that partner already knows it.

## What judges see: memory-ranked scanning that learns from one confirm

- **The memory toggle.** `rankOptions` returns two orders at once. With memory on, the earpiece reads `withMemory`; with it off, `withoutMemory` (the planner's support alone). Flip the toggle and the options reorder.
- **The counter.** `ScanCounter.record(ordering, chosenId)` gives the options read before the chosen one, with memory and without, and `totals()` sums them over the run. Measure it on held-out real questions: build the memory from earlier consented replies and test on later ones, never on the items the memory was built from.
- **Moss's own timing.** Every recall and search returns `mossMs` (the SDK's `timeTakenInMs`) next to `wallMs`, and the pipeline events carry `mossMs` in their counts.
- **Learning from one confirm.** After `writeBack`, a paraphrased follow-up from the same partner ("Do you want a coffee now?") gets the confirmed reply as an instant option and as affinity evidence.
- **"The memory never leaves this laptop."** `run.snapshotInfo()` shows what the local snapshot holds: document count, vector size and model.

## Billing rules

Local queries are never metered, but session minutes are: 60 a month on the free Developer plan, then $0.05 a minute on pay-as-you-go (docs.moss.dev pricing). Moss's docs say every auto-refresh poll counts as session time, and other builders report being billed for the whole time a process holds a session, with large surprise bills. This package plans for that worst case, where an open session costs wall-clock minutes:

- **Nothing opens until `run.start()`.** Press Start when a judge arrives and Stop (`run.close()`) when they leave. Creating `MemoryStore` or `WebIndex` opens nothing.
- **Idle close.** A run closes itself after 3 minutes without a Moss call (`MOSS_IDLE_CLOSE_MS`, 10 seconds to 15 minutes). An open run keeps the Node process alive until then.
- **Every exit path closes.** `withRun` closes in a `finally` block, `closeOnSignals` closes on Ctrl-C and SIGTERM before exiting, and `close()` never throws.
- **Stop wins.** Stop pressed while a Start is still pending cancels it if it has not connected yet, and closes it right after if it has.
- **A close that may have left something open blocks new starts.** The SDK cannot retry a failed close, and a failed session open can leave a session it never hands back (see the SDK gap below). After either, a new client could hold a second session beside the first, so `start()` refuses with `restart_needed` until the agent process restarts, which frees everything.
- **Event sinks cannot interrupt a step.** Events reach `onEvent` after the current step settles, so a sink that calls `start()` or `close()` cannot open a second client or miss a pending start.
- **No cloud index, no upload, no auto-refresh.** The types this package uses leave out `pushIndex` and `loadIndex`, and a test fails if the source ever calls them or the inference gateway.
- **Never add a card.** A project over its usage limit is paused and its calls fail; the pipeline event then reads `Moss paused: usage limit reached`. Whether the free plan's credit covers minutes past the included 60 is not known, so plan for 60.
- **One person runs Moss-backed code.** Everyone else replays recorded events.
- **Watch the meter.** `run.meter()` is this process's own count of session time, for the operator console. The Moss portal is the bill.

## Privacy rules

- **The memory stays on this laptop.** It lives in a local session and a snapshot under `MOSS_SNAPSHOT_DIR`, and is never pushed. Moss telemetry never contains query or document text.
- **Keep the session name neutral.** Moss telemetry sends it as typed, so it defaults to `say-when` and must be lowercase letters, digits and dashes.
- **No content in events, errors or logs.** Events carry an operation name, a Moss error code, times and counts. A failed Moss call throws `MossCallError`, whose message is only the step and the code; the SDK's own error is kept off the logged form as the non-enumerable `original`, which may hold document text, so never log it. The package logs nothing but two fixed warnings.
- **No caller text in document ids.** Memory and web document ids are hashes. Question ids, row ids and partner ids stay in local metadata.
- **Memory text reaches SpacetimeDB or a screen only when the person shared it.** An item added or written back with `shareable: true` gives its hits a `sharedText` (the reply, or the preference text); every other memory hit has `sharedText: null` and shows as "Private memory" with its `type` (docs/ui.md). A hit that comes back without metadata counts as private. For evidence, use memory hit ids, types and scores (for example `Affinity.evidence`), and `sourceOf(hit)` for the `{ source, url or placeId, fetchedAt }` entry an option row expects.
- **The snapshot holds memory only.** Close removes every web passage before saving. If that removal ever fails, it saves anyway so the run's confirmed replies are kept, reports `memoryOnly: false`, and the next start removes the leftovers before anything reads the memory.
- **Only consented items go in.**

## Environment

| Variable | Required | What |
|---|---|---|
| `MOSS_PROJECT_ID` | yes | Moss project id. Agent laptop only. |
| `MOSS_PROJECT_KEY` | yes | Moss project key. Agent laptop only; never in a browser, SpacetimeDB or git. |
| `MOSS_SNAPSHOT_DIR` | yes | Absolute folder for the memory snapshot, for example `<repo>/moss/.memory` (gitignored). Moss writes `<folder>/<session name>/`. |
| `MOSS_IDLE_CLOSE_MS` | no | Idle close in milliseconds. Default `180000`. |
| `MOSS_SESSION_NAME` | no | Session name. Default `say-when`. |

Credentials are read from the environment on `start()` only and are never logged.

## Usage

```ts
import { MemoryStore, MossRun, ScanCounter, WebIndex, closeOnSignals, rankOptions, sourceOf } from '@say-when/moss';

const run = new MossRun({ onEvent: (event) => writePipelineEvent(event) });
closeOnSignals(run);
const memory = new MemoryStore(run);
const web = new WebIndex(run);
const counter = new ScanCounter();

await run.start(); // the operator pressed Start

// A question lands. Memory first, before any web search.
const recall = await memory.recall(question.text, question.partnerId);
if (recall.instant.length >= 2) publishInstantOptions(recall.instant);

// Then the web, from apify/client rows.
const { rows } = await searchWeb(question.text);
await web.index(question.id, rows);
const passages = await web.search(question.id, question.text);
const places = await web.search(question.id, 'pharmacy', { source: 'maps', near: { lat: 37.8716, lng: -122.2727, radiusMeters: 2000 } });

// The planner writes up to four options; memory sets the order.
const options = await planOptions(question, recall.hits, passages.hits, places.hits);
const ordering = await rankOptions(memory, question.partnerId, options);
speak(memoryOn ? ordering.withMemory : ordering.withoutMemory);

// The person confirms one.
counter.record(ordering, chosen.id);
await memory.writeBack({ question: question.text, reply: chosen.text, partnerId: question.partnerId });
await web.forget(question.id);

await run.close(); // the operator pressed Stop
```

Options are `{ id, text, support?, last? }`: `support` is the best score among the passages an option cites, and `last: true` keeps an escape option such as "something else" at the end of both orders. When the run is closed, every Moss call throws `MossRunError` with code `not_open`; show "Moss is closed, press Start" rather than reopening on your own. `start()` can also refuse with `cancelled` (Stop came first) or `restart_needed` (restart the agent process).

`memory.add(items)` loads consented items, such as `{ type: 'pref', text: 'I take my coffee black.' }` or an earlier reply `{ type: 'reply', question, reply, partnerId }`. Add `shareable: true` (also on `writeBack`) only for items the person agreed may be shown on screens. The same item added twice is stored once, and adding it again updates the flag: leaving `shareable` out makes it private again.

`web.index` and `web.forget` calls for the same question run one at a time, in the order they were made. A call still waiting when its run closes is dropped (`not_open`), and so is a search whose results come back after a restart, so nothing from a closed run lands in the next one. Each hit's `row` is a copy taken at index time, so editing it changes nothing stored.

## Pipeline events

`onEvent` receives `{ stage: 'retrieve', status, detail, ms, counts? }` for every Moss step, matching the content-free `pipeline_event` contract in [PLAN.md](../PLAN.md). The agent adds `id`, `session_id` and `at`.

- `detail` is one of `open session`, `close session`, `inspect snapshot`, `memory add`, `memory recall`, `memory affinity`, `memory write back`, `web index`, `web search`, `web forget`. On failure it reads `<step> failed: <Moss error code>`, or `Moss paused: usage limit reached`.
- `ms` is wall time on the laptop (null while `started`).
- `counts` holds numbers only, such as `hits`, `instant`, `chunks`, `added`, `deleted`, `purged`, `heldMs`, and `mossMs`.
- The sink may be async. A sink that throws or rejects only drops that one event, with a fixed warning.

## Chunking

The JS SDK has no chunker, so `chunkText` follows Moss's own tips: chunks of about 800 to 1,200 characters cut at sentence boundaries (by the runtime's `Intl.Segmenter`), 150 to 200 characters of overlap with the chunk before, and the page title on top of every chunk. A sentence that fits in a chunk is never split: if it is too long to share its chunk with the overlap, that chunk starts without one, and only a sentence longer than a whole chunk is cut between words. Re-indexing a row deletes the chunks its new text no longer fills. Links keep their words and images are dropped. Every row's fields go into string metadata for filters (`location` as `"lat,lng"` for `$near`, place facts such as `rating` and `openNow` as `"4.6"` and `"true"`). apify/client already writes a place's facts into its text; a place row with no text gets them written as sentences, so search can still match them. A page stops at 20 chunks, which covers the roughly 20,000 characters apify/client keeps.

## Run and test

```bash
cd moss
npm install
npm run typecheck
npm test
```

The tests use a fake that implements the same interface as the SDK calls this package makes, so they never open a Moss session and need no credentials. The typecheck also proves that the real `SessionIndex` and `MossClient` from `@moss-js/moss` 1.21.0 fit that interface.

## Honest limits

- **Not yet run against real Moss.** No credentials were used to build this. The first real run is the smoke test: start, add a few documents, query, close, and read the portal's usage page before and after.
- **Starting guesses.** The score floor (0.5) and the ranking weights (0.6 memory, 0.4 support) are not measured. Tune them on real questions on the demo laptop; Moss's own docs say to tune score floors on your own queries.
- **Typed but not yet seen in a real run:** metadata and payload on JS session hits. Recall falls back to the document id and text if they are missing.
- **Snapshots.** Moss's Python docs give one error code for a missing and a damaged snapshot, so this package tells a first run apart by whether the snapshot folder exists. A damaged snapshot fails the start instead of being overwritten with an empty memory; move the folder aside to start fresh. The core can also report a snapshot "locked by another process", so use one snapshot folder per process.
- **Speed.** Moss does not publish embedding speed for `addDocs`. Measure indexing time on the demo laptop before quoting it.
- **A Moss call that never returns** holds up later index and forget calls for that question until the run is stopped and started again. Close waits at most 10 seconds for calls in flight.
- **Network.** Opening a session needs the Moss cloud. Whether an open session keeps working through a Wi-Fi drop is not known yet.
- **One gap inside the SDK.** In 1.21.0, `client.session()` creates the native session, then loads the model, and only then registers the session with the client. If the model load fails, `client.close()` cannot reach that session and this package never gets a handle to it; it lives until garbage collection, and whether Moss bills it meanwhile is not known. A failed credential check looks the same from outside, so any failed session open asks for a process restart. Start on a known-good connection.
- **License.** `@moss-js/moss` is under the PolyForm Shield License 1.0.0; this package is MIT.
