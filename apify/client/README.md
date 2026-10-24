# Say When Apify client

The Apify layer of the Say When agent sidecar: a local check for whether a question needs the web, live web and place search, and a client for our form-errand Actor. TypeScript, Node 22, no runtime dependencies.

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

| What comes back | Meaning | What to do |
|---|---|---|
| `status: 'submitted'` | Sent once; `confirmationText` is the page's confirmation. | Show it. |
| `status: 'duplicate'` | This digest was already sent, or is being sent, in the last ten minutes. Nothing new went out. | Treat as sent when `confirmationText` is set; otherwise check, as for an unknown outcome. |
| `status: 'refused'` | A gate failed before anything was clicked; `refusal.code` says which. | Nothing was sent. Speak `refusal.reason`. |
| `status: 'failed'` with `refusal.code: 'no_confirmation'` | Send was pressed but no confirmation appeared. | Unknown. Check before trying again. |
| `UnknownOutcomeError` | A timeout, a dropped connection, a 5xx or 408, a cancel after sending, or a reply we could not read. | Unknown. Do not resend; check first. |
| `ApifyHttpError` with `attempts: 0`, or status 400, 401, 402, 403, 404, 405, 413 or 429 | Refused before any errand ran. | Nothing was sent. |
| `TypeError` | `confirm` was not `true`, or the digest was not 16 hex characters. Thrown before any request. | Fix the call. |

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

## Partial results and timeouts

Web search:

- We send the Actor `requestTimeoutSecs` (default 40) and stop waiting ourselves 5 s later (`timeoutMs`, default 45,000). Set `timeoutMs` to fit the conversation and the Actor's limit follows it.
- When the Actor's limit runs out, it returns the pages that loaded and marks the rest failed. We drop those and set `partial: true`. `partial` is also true when a page failed, answered 400 or more, or had no text.
- If nothing loaded in time, the Actor answers HTTP 500 "Timed out." That becomes `ApifyHttpError` with `kind: 'timeout'` and is not retried. Our own timeout gives the same kind.

Places:

- `timeoutSecs` (default 120) is the run's own limit, and we wait up to 30 s longer for the reply. The sync API gives up at 300 s with HTTP 408, reported as `kind: 'timeout'`.
- The API docs do not say what comes back when a run hits its own limit. `partial` is set when the call took the whole limit and returned fewer places than asked, as a hint.

## Errors and retries

| Error | When |
|---|---|
| `ConfigError` | A missing or malformed environment variable or token. |
| `TypeError`, `RangeError` | A bad argument, thrown before any request. |
| `ApifyHttpError` | `kind` is `http` (see `status`), `timeout`, `network`, `aborted` or `bad_response`. The message names the service, method, host and path, never the query string or the token. `bodySnippet` holds up to 300 characters of the reply with the token scrubbed out. `attempts` counts requests actually sent. |
| `UnknownOutcomeError` | Submit only; see the table above. |

Reads (web, places, inspect, preview) retry after a 429, a 5xx or a network error, waiting 500 ms, then 1 s, doubling up to 4 s, as Apify's API docs suggest. A `Retry-After` of 4 s or less is followed; a longer one fails at once. Timeouts are never retried. Defaults: 2 retries for web, inspect and preview; 1 for places, since each retry is a new paid run under the same charge cap. Submit never retries.

## Events

`onEvent` receives `{ stage, status, detail, ms, counts? }`:

| Call | started | ok | error |
|---|---|---|---|
| `searchWeb` | `web` | `web` or `web partial`, counts `{ rows, skipped }` | `web timeout`, `web http 502`, `web network` |
| `searchPlaces` | `maps` | `maps` or `maps partial`, counts `{ rows, closed, skipped }` | `maps timeout`, `maps http 402` |
| errand | `preview` | `preview previewed`, counts `{ questions, readBack, unmatched, missingRequired }` | `preview refused: captcha`, `submit unknown outcome (timeout)` |

Events never carry the question, page text, answers, form values, URLs, digests or reply bodies. A listener that throws is ignored. `counts` is not a column in the `pipeline_event` contract; fold it into `detail` or leave it out.

## Question check

`classifyQuestion(question)` returns `{ needsWeb, kind, reason }`, with `kind` one of `places`, `facts`, `smalltalk` or `personal`. The rules run in this order:

1. The clock. "What time is it?" is `facts` with no search.
2. Outside facts. Places first (open or closing times, near and nearest, directions, a meal or outing, words such as pharmacy, cafe or restaurant), then facts (weather, news, scores, prices, hours and schedules, "when is the ...", general knowledge). These win even when the question is also personal, so "Want to grab lunch nearby?" searches.
3. Shared memories ("Do you remember ...?").
4. Names. A capitalized name in the middle of a sentence is looked up, unless it reads like someone the person knows ("How's Sarah doing?", "Is Dr. Lee coming?").
5. Small talk and personal questions: greetings, thanks, feelings, wants, care, family and plans. No search.
6. Anything left is unsure and searches, so the planner can decide.

`reason` is one sentence from a fixed list and never quotes the question. These are fast plain rules, not a model: they will misjudge some questions, and they lean toward searching when unsure. A transcript without capital letters loses the name check. The tests cover more than 50 example questions.

## Costs and latency (indicative)

- **RAG Web Browser:** the Actor's README benchmark shows 16 to 31 s per query (three queries, 1 or 3 results, 4 or 8 GB). When we checked on Oct 23, 2026, the Store listed $0.00348 per search and $0.00228 per fetched page on the Free tier. Fewer results and `raw-http` (its default) are faster.
- **Google Maps Scraper:** on Oct 23 the Store listed $0.004 per place, plus $0.001 per place for each paid filter; we use none. By default each call runs with 4,096 MB, a 120 s limit and `maxTotalChargeUsd=0.25`. It publishes no latency figure.
- **Form errand:** in our local measurement on the demo form, a cold preview took about 5 s and a submit about 3 s.
- **Memory:** Apify's Free plan caps the combined memory of all running runs and builds (16,384 MB on its limits page when we checked). RAG Web Browser Standby takes 8,192 MB and a Maps run 4,096 MB, so avoid parallel Maps runs and builds during a demo.

## Safety notes

- The token goes only in the `Authorization` header, never in a URL. A token with spaces or line breaks is refused, redirects are refused so the header never follows one, error messages and snippets are scrubbed, and `FormErrandClient` keeps the token in a private field.
- The question text goes to Apify and, through RAG Web Browser, to Google Search. Personal questions stay on the laptop when the sidecar follows `classifyQuestion`. Never add details from the person's memory to a search query.
- Submit is sent at most once. The Actor's ten-minute duplicate guard is a second line of defense, not a reason to resend.
- Accessibility is never inferred, `openNow` means open when fetched, and permanently closed places are dropped.

## What was checked, and against what

- RAG Web Browser query parameters, item fields, how failed and timed-out pages are marked, and the "Timed out." reply: read in its source, [apify/actor-rag-web-browser](https://github.com/apify/actor-rag-web-browser), on Oct 24, 2026. One detail from that source: Standby passes query values through as strings, so `removeCookieWarnings: false` is sent as an empty value, the only one that reads as false there.
- The Apify API run-sync path (`/v2/actors/`), its 201 success status, the `{ error: { type, message } }` body, 408 at 300 s and the `fields` parameter: read in Apify's OpenAPI spec, [apify/apify-docs](https://github.com/apify/apify-docs), on Oct 24, 2026.
- Google Maps Scraper input and output fields: from the Actor's README, its only public description, since the Actor is closed source.
- Form-errand routes and result types: [apify/form-errand](../form-errand/README.md) in this repo.
- No test calls Apify; they run against a fake `fetch` with fixtures shaped like the sources above. Nothing here has run against live Apify yet, so make one real call of each before the demo.
