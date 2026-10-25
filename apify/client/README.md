# Eleven Apify client

The Apify layer of the Eleven agent sidecar: a local check for whether a question needs the web, live web and place search, and a client for our form-errand Actor. TypeScript, Node 22, no runtime dependencies.

## What it does

- **`classifyQuestion(question)`** decides on the laptop, with no network call, whether a partner's question needs outside facts (D8 in [PLAN.md](../../PLAN.md)). Small talk and personal questions never wait on a search.
- **`searchWeb(question)`** searches Google and reads the top pages with [RAG Web Browser](https://apify.com/apify/rag-web-browser) in Standby, and returns them as rows.
- **`searchPlaces(query, { near })`** finds places with the [Google Maps Scraper](https://apify.com/compass/crawler-google-places) and returns them as rows with their facts.
- **`FormErrandClient`** calls the Standby API of our [form-errand Actor](../form-errand/README.md): `inspect`, `preview` and `submit`. Submit is sent once and never retried.
- Every call can report content-free progress events for the `pipeline_event` table.

## Setup

```bash
cd apify/client
npm install
npm run typecheck   # sources and tests; also compares the errand types with apify/form-errand/src/types.ts
npm test            # a fake fetch only: no Apify calls, no token needed
npm run build       # writes dist/ for other folders to import
```

Another folder can depend on it with `"@say-when/apify-client": "file:../apify/client"` after `npm run build` here.

## Environment

| Variable | Needed for | Notes |
|---|---|---|
| `APIFY_TOKEN` | everything | Server side only. Never in a browser bundle, a log or SpacetimeDB. |
| `FORM_ERRAND_URL` | `FormErrandClient` | The Actor's Standby URL from its Endpoints tab, without `?token=`. |
| `RAG_WEB_BROWSER_URL` | optional | Defaults to `https://rag-web-browser.apify.actor`. |

`loadConfig()` reads these from `process.env`; an empty value counts as unset. Errors name the variable and never print its value. Load `.env.local` with Node's own flag, for example `node --env-file=.env.local agent.js`.

## Usage

```ts
import { classifyQuestion, loadConfig, searchPlaces, searchWeb, type PipelineEvent } from '@say-when/apify-client';

const config = loadConfig();
const onEvent = (event: PipelineEvent) => {
    // Write a pipeline_event row; add id, session_id and at.
};

const question = 'Want to grab lunch after this?';
const check = classifyQuestion(question);
// { needsWeb: true, kind: 'places', reason: 'Plans a meal or an outing, so nearby places help.' }

if (check.needsWeb) {
    const found =
        check.kind === 'places'
            ? await searchPlaces('lunch', { config, near: { lat: 37.8716, lng: -122.2727 }, onEvent })
            : await searchWeb(question, { config, onEvent });
    // found.rows go to Moss; found.partial is true when some results were dropped.
}
```

The place query is a short search string such as `lunch` or `pharmacy`, not the whole question.

```ts
import { FormErrandClient, UnknownOutcomeError } from '@say-when/apify-client';

const errands = FormErrandClient.fromConfig(config, { onEvent });
const formUrl = 'demo'; // or the consenting caregiver's form address
const fields = [
    { label: 'Who is this from?', value: 'Alex', source: 'memory' },
    { label: 'What do you need?', value: 'Meal or drink' },
];

const preview = await errands.preview({ formUrl, fields });
if (preview.status === 'previewed' && preview.previewDigest) {
    // Speak preview.readBackText. Submit only after a fresh confirm whose digest matches.
    try {
        const sent = await errands.submit({ formUrl, fields, confirm: true, confirmDigest: preview.previewDigest });
    } catch (error) {
        if (error instanceof UnknownOutcomeError) {
            // Do not resend. Check the errand row or the form's responses first.
        }
        throw error;
    }
}
```

### Submit outcomes

`submit` resolves only when the outcome is known. Everything else rejects with `UnknownOutcomeError`. A `submitted` or `duplicate` reply counts only when its `previewDigest` is the digest the person confirmed and its `confirmationText` has visible text (not empty, spaces or invisible characters).

| What comes back | Meaning | What to do |
|---|---|---|
| `status: 'submitted'` | Sent once, for the digest the person confirmed; `confirmationText` is the page's confirmation. | Show it. |
| `status: 'duplicate'` | This digest was sent and confirmed in the last ten minutes. Nothing new went out. | Treat as sent; `confirmationText` is the first send's confirmation. |
| `status: 'refused'` | A gate failed before anything was clicked; `refusal.code` says which. | Nothing was sent. Speak `refusal.reason`. |
| `UnknownOutcomeError` | `reason` says why: `timeout`, `network`, `aborted` (cancelled after sending), `server_error` (a 5xx or 408), `bad_response` (an invalid or oversized reply, a `submitted` or `duplicate` reply for another digest or none, or a `submitted` reply without a confirmation), `click_uncertain` (the click on send failed partway), `no_confirmation` (send was pressed, no confirmation appeared) or `unconfirmed_duplicate` (a repeat of a send that has no confirmation on record). | Unknown. Do not resend; check the errand row or the form's responses first. When the Actor sent a result, it is on `error.result`, which is not enumerable, so logging the error does not print form values. |
| `ApifyHttpError` with `attempts: 0`, or status 400, 401, 402, 403, 404, 405, 413 or 429 | Refused before any errand ran. | Nothing was sent. |
| `TypeError` | `confirm` was not `true`, or the digest was not 16 hex characters. Thrown before any request. | Fix the call. |

Every reply is checked field by field against `ErrandResult` and against the statuses its route can return (inspect: `inspected` or `refused`; preview: `previewed` or `refused`; submit: `submitted`, `duplicate`, `refused` or `failed`) before anything reads it. An invalid reply is an `ApifyHttpError` with `kind: 'bad_response'` for inspect and preview, and an `UnknownOutcomeError` for submit. The error names the field that failed and never quotes the reply.

## Search rows

```ts
interface SearchRow {
    id: string; // "web:" + 16 hex of the URL's sha256, or "maps:" + placeId
    source: 'web' | 'maps';
    title: string;
    text: string;
    url?: string;
    placeId?: string;
    location?: { lat: number; lng: number };
    fetchedAt: string; // ISO 8601
    rank?: number;
    facts?: PlaceFacts; // maps rows only
}

interface PlaceFacts {
    rating?: number;
    reviews?: number;
    openNow?: boolean;
    wheelchairEntrance?: true; // only ever true; see below
    address?: string;
    phone?: string;
    category?: string;
}
```

| Field | Web rows | Maps rows |
|---|---|---|
| `id` | `web:` plus 16 hex characters of the page URL's sha256, so the same page always gets the same id | `maps:` plus the Google `placeId` |
| `title` | Page title, else the search result title, else the URL | Place name |
| `text` | Page markdown, cut near 20,000 characters at a word (`maxTextChars`) | A short plain summary built only from the fields present |
| `url` | The page that loaded | The Google Maps link |
| `placeId`, `location` | not set | From the scraper |
| `fetchedAt` | When the page loaded (`crawl.loadedAt`) | When the place was scraped (`scrapedAt`) |
| `rank` | Google result rank | Position in the scraper's output, from 1 |
| `facts` | not set | `rating`, `reviews`, `openNow`, `wheelchairEntrance`, `address`, `phone`, `category` |

Rules for place facts:

- Each fact is set only when its source field was present. `rating` is left out when the score is missing or 0.
- `openNow` comes from `wasOpenAtScrapeTime`: open when fetched, not open now. Read it with `fetchedAt`.
- `wheelchairEntrance` is only ever `true`, and only when `additionalInfo.Accessibility` holds `{ "Wheelchair accessible entrance": true }`. A missing list, a `false` entry, or accessible seating never sets it. We run without the detail page add-on (`scrapePlaceDetailPage: false`) and have not confirmed that the Accessibility list is filled in that mode, so expect it to be missing often.
- Places Google marks `permanentlyClosed` are dropped. `temporarilyClosed` is said in `text`.

For Moss (the "Moss docs" contract in PLAN.md): metadata values are strings, so convert numbers and booleans with `String()`, and keep `fetchedAt` so an option can say when it was checked. Web text is long; chunk it before indexing.

## Size limits

A reply is counted while it streams in and refused, before any parsing, once it passes its limit: 16 MiB for RAG Web Browser, 4 MiB for a Google Maps Scraper dataset (1 MiB for a run object) and 16 MiB for the form errand (room for an inline screenshot). A declared `Content-Length` over the limit fails before anything is read. An oversized reply is `ApifyHttpError` with `kind: 'bad_response'` and is not retried.

The pieces are copied into one buffer that never grows past the limit, so a reply sent one byte at a time takes no more memory than one sent whole. When a read stops early (too large, timed out or cancelled), the body is cancelled and its reader released, and a body that arrives only after we gave up is cancelled unread.

After parsing, a search keeps at most `maxResults` pages or `maxPlaces` places, whatever the reply holds. Titles are cut to 300 characters, addresses to 300 and categories to 100. Links over 2,048 characters, phone numbers over 40 and place ids over 200 are dropped rather than cut, since a cut one would be wrong; a web page without a usable link is skipped.

## Partial results and timeouts

Web search:

- We send the Actor `requestTimeoutSecs` (default 40) and stop waiting ourselves 5 s later (`timeoutMs`, default 45,000). Set `timeoutMs` to fit the conversation and the Actor's limit follows it.
- When the Actor's limit runs out, it returns the pages that loaded and marks the rest failed. We drop those and set `partial: true`. `partial` is also true when a page failed, answered 400 or more, or had no text.
- If nothing loaded in time, the Actor answers HTTP 500 "Timed out." That becomes `ApifyHttpError` with `kind: 'timeout'` and is not retried. Our own timeout gives the same kind.

Places:

- A place search is three steps: start a run (`POST /v2/actors/compass~crawler-google-places/runs` with `timeout`, `memory`, `maxTotalChargeUsd` and `waitForFinish`), wait for it to end, then read its dataset (`GET /v2/datasets/<defaultDatasetId>/items?format=json&clean=true&fields=...&limit=<maxPlaces>`). Apify holds each reply until the run ends or the wait runs out (60 s at most); a run still going is asked again (`GET /v2/actor-runs/<id>?waitForFinish=...`), at most 8 times.
- `timeoutSecs` (default 120) is the run's own limit. The first wait is that limit plus 5 s (at most 60), and the whole call, start to places, gets the limit plus 30 s. Past that it is `kind: 'timeout'`.
- **A run that reaches its own limit keeps the places it found.** Apify marks it `TIMED-OUT`; we read its dataset anyway and return those places with `partial: true` (event `maps partial`). A `TIMED-OUT` run with no places is `kind: 'timeout'`. We moved off the sync endpoint (`run-sync-get-dataset-items`) for this: on Oct 25 a 20 s run timed out with 4 places in its dataset, and the sync endpoint answered HTTP 400 with none of them.
- A `SUCCEEDED` run with no places resolves with no rows: nothing matched. A run that ended `FAILED` or `ABORTED` rejects with `kind: 'bad_response'` and `bodySnippet` "The run ended FAILED." (or ABORTED), without reading its dataset.
- When the caller cancels, our deadline passes, or a status reply is unusable while the run is still going, we ask Apify to abort that run (`POST /v2/actor-runs/<id>/abort`, once, not awaited, failures ignored), so it stops charging. A run whose start was cancelled before Apify answered cannot be aborted, since we never learned its id; its own limit and charge cap still hold.
- Run and dataset ids are checked to be short and alphanumeric before they go into a URL path, and errors name the route (`GET api.apify.com/v2/actor-runs/:runId`), never the ids: the run object and its storages can be read with the id alone.

## Errors and retries

| Error | When |
|---|---|
| `ConfigError` | A missing or malformed environment variable or token. |
| `TypeError`, `RangeError` | A bad argument, thrown before any request. |
| `ApifyHttpError` | `kind` is `http` (see `status`), `timeout`, `network`, `aborted` or `bad_response`. The message names the service, method, host and path, never the query string or the token. `bodySnippet` holds up to 300 characters of the reply with every configured token scrubbed out, whatever its length. `attempts` counts requests actually sent. |
| `UnknownOutcomeError` | Submit only; see the table above. |

Web search, inspect and preview retry after a 429, a 5xx or a network error, waiting 500 ms, then 1 s, doubling up to 4 s, as Apify's API docs suggest; the default is 2 retries. A `Retry-After` of 4 s or less is followed; a longer one fails at once. Timeouts and oversized replies are never retried. Place search never retries starting a run: each POST can start a new paid run, and after a dropped connection the first run may still be going. Its reads (the run's status and its dataset) change nothing and are tried once more after a 429, a 5xx or a network error, inside the call's deadline. Submit never retries.

## Events

`onEvent` receives `{ stage, status, detail, ms, counts? }`:

| Call | started | ok | error |
|---|---|---|---|
| `searchWeb` | `web` | `web` or `web partial`, counts `{ rows, skipped }` | `web timeout`, `web http 502`, `web network` |
| `searchPlaces` | `maps` | `maps` or `maps partial`, counts `{ rows, closed, skipped }` | `maps timeout`, `maps http 402`, `maps bad response` (also a run that ended `FAILED` or `ABORTED`), `maps aborted` |
| errand | `preview` | `preview previewed`, counts `{ questions, readBack, unmatched, missingRequired }` | `preview refused: captcha`, `preview bad response`, `submit unknown outcome (click_uncertain)` |

Events never carry the question, page text, answers, form values, URLs, digests or reply bodies. A listener that throws is ignored. `counts` is not a column in the `pipeline_event` contract; fold it into `detail` or leave it out.

## Question check

`classifyQuestion(question)` returns `{ needsWeb, kind, reason }`, with `kind` one of `places`, `facts`, `smalltalk` or `personal`. The rules run in this order:

1. The clock. "What time is it?" is `facts` with no search.
2. Outside facts. Places first (open, closed or closing times, near and nearest, directions, a meal or outing), then facts (weather, news, scores, prices, hours and schedules, "when is the ...", general knowledge), then requests to look something up ("can you look up ...", "check if ...", "find out ...") and current events ("what happened ... today"). These win even when the question is also personal, so "Want to grab lunch nearby?" and "Can you check if Target is closed?" search.
3. Talk about what the person already did ("How was your day at the park?", "Did you have a good time at the restaurant?") and shared memories ("Do you remember ...?"). No search, even with a place word in it.
4. Place words such as pharmacy, cafe or restaurant.
5. Names. A capitalized name in the middle of a sentence is looked up, unless it reads like someone the person knows ("How's Sarah doing?", "Is Dr. Lee coming?"). A question naming more than 16 people or places is not something said aloud, so it is treated as a lookup.
6. Small talk and personal questions: greetings, thanks, feelings, wants, care, family and plans. No search.
7. Anything left is unsure and searches, so the planner can decide.

`reason` is one sentence from a fixed list and never quotes the question. These are fast plain rules, not a model: they will misjudge some questions, and they lean toward searching when unsure. A transcript without capital letters loses the name check. The tests cover more than 70 example questions, lowercase transcripts included.

Only the first 2,000 characters are classified (`MAX_QUESTION_CHARS`, leading spaces not counted), far more than any spoken question, so a long or garbled transcript still takes only milliseconds (under 5 ms for each of 22 hostile inputs in our local check). Rules that look for one phrase followed later by another ("what happened ... today", "how late ... open") run as two plain searches rather than one pattern, which would slow down sharply on a transcript that repeats the first phrase.

## Costs and latency (indicative)

- **RAG Web Browser:** the Actor's README benchmark shows 16 to 31 s per query (three queries, 1 or 3 results, 4 or 8 GB). When we checked on Oct 23, 2026, the Store listed $0.00348 per search and $0.00228 per fetched page on the Free tier. Fewer results and `raw-http` (its default) are faster.
- **Google Maps Scraper:** on Oct 23 the Store listed $0.004 per place, plus $0.001 per place for each paid filter; we use none. By default each call runs with 4,096 MB, a 120 s limit and `maxTotalChargeUsd=0.5`. That cap is Apify's minimum: on Oct 24 a cap of 0.25 was refused before the run started (HTTP 400 `max-total-charge-usd-below-minimum`, "Maximum cost per run is less than the allowed minimum of $0.50"), so `maxChargeUsd` below 0.50 now throws a `RangeError` instead. The cap is a ceiling, not the price. It publishes no latency figure; in our Oct 24 probe with a 0.50 cap, one run returned 6 places in 11.4 s.
- **Form errand:** in our local measurement on the demo form, a cold preview took about 5 s and a submit about 3 s.
- **Memory:** Apify's Free plan caps the combined memory of all running runs and builds (16,384 MB on its limits page when we checked). RAG Web Browser Standby takes 8,192 MB and a Maps run 4,096 MB, so avoid parallel Maps runs and builds during a demo.

## Safety notes

- The token goes only in the `Authorization` header, never in a URL. A token with spaces or line breaks is refused, redirects are refused so the header never follows one, error messages and snippets are scrubbed, and `FormErrandClient` keeps the token in a private field.
- The question text goes to Apify and, through RAG Web Browser, to Google Search. Personal questions stay on the laptop when the sidecar follows `classifyQuestion`. Never add details from the person's memory to a search query.
- Submit is sent at most once. The Actor's ten-minute duplicate guard is a second line of defense, not a reason to resend.
- Accessibility is never inferred, `openNow` means open when fetched, and permanently closed places are dropped.

## What was checked, and against what

- RAG Web Browser query parameters, item fields, how failed and timed-out pages are marked, and the "Timed out." reply: read in its source, [apify/actor-rag-web-browser](https://github.com/apify/actor-rag-web-browser), on Oct 24, 2026. One detail from that source: Standby passes query values through as strings, so `removeCookieWarnings: false` is sent as an empty value, the only one that reads as false there.
- The Apify API `/v2/actors/` prefix, the 201 success status, the `{ error: { type, message } }` body and the `fields` parameter: read in Apify's OpenAPI spec, [apify/apify-docs](https://github.com/apify/apify-docs), on Oct 24, 2026.
- The run API used by place search: read in Apify's API reference on Oct 25, 2026. Run Actor (`POST /v2/actors/:actorId/runs`) takes `timeout`, `memory`, `maxTotalChargeUsd` and `waitForFinish` (0 to 60 s) and answers 201 with `{ data: run }`, where the run has `id`, `status` and `defaultDatasetId`; statuses are `READY`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMING-OUT`, `TIMED-OUT`, `ABORTING` and `ABORTED`. Get run (`GET /v2/actor-runs/:runId`) takes the same `waitForFinish`. Get dataset items (`GET /v2/datasets/:datasetId/items`) takes `format`, `clean`, `fields` and `limit` and answers with a JSON array. Abort run is `POST /v2/actor-runs/:runId/abort`. That the dataset of a `TIMED-OUT` run holds the places it found is from the Oct 25 run above, not from the docs.
- Google Maps Scraper input and output fields: from the Actor's README, its only public description, since the Actor is closed source.
- Form-errand routes and result types: [apify/form-errand](../form-errand/README.md) in this repo.
- No test calls Apify; they run against a fake `fetch` with fixtures shaped like the sources above. The run, wait and dataset steps of place search have not run against live Apify yet, so make one real place search before the demo.
