import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, type ApifyConfig } from '../src/config.js';
import type { PipelineEvent } from '../src/events.js';
import { ApifyHttpError } from '../src/http.js';
import { searchPlaces, searchWeb } from '../src/search.js';
import { TOKEN, fakeFetch, hang, json, networkError, type Reply, type SeenCall } from './fake-fetch.js';
import {
    PLACE_BARE,
    PLACE_GONE,
    PLACE_OPEN,
    PLACE_SEATING_ONLY,
    PLACE_UNKNOWN,
    RAG_EMPTY,
    RAG_LOADED,
    RAG_LONG,
    RAG_NOT_FOUND,
    RAG_TIMED_OUT,
} from './fixtures.js';

const config: ApifyConfig = { token: TOKEN, ragWebBrowserUrl: 'https://rag-web-browser.apify.actor' };
const QUESTION = 'Is the corner cafe open late tonight?';

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    assert.fail('expected a rejection');
}

describe('searchWeb', () => {
    it('calls RAG Web Browser Standby with the question and our limits', async () => {
        const { fetch, calls } = fakeFetch(json([RAG_LOADED]));
        await searchWeb(`  ${QUESTION}  `, { config, fetch });
        const url = new URL(calls[0].url);
        assert.equal(calls[0].method, 'GET');
        assert.equal(`${url.origin}${url.pathname}`, 'https://rag-web-browser.apify.actor/search');
        assert.equal(url.searchParams.get('query'), QUESTION);
        assert.equal(url.searchParams.get('maxResults'), '3');
        assert.equal(url.searchParams.get('requestTimeoutSecs'), '40');
        assert.equal(url.searchParams.has('token'), false);
        assert.equal(url.searchParams.has('scrapingTool'), false);
        assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
    });

    it('maps loaded pages to rows and drops failed, timed-out, error and empty pages', async () => {
        const { fetch } = fakeFetch(json([RAG_LOADED, RAG_TIMED_OUT, RAG_NOT_FOUND, RAG_EMPTY, RAG_LONG]));
        // Five pages come back only when five were asked for; extra items beyond maxResults are ignored.
        const res = await searchWeb(QUESTION, { config, fetch, maxResults: 5 });
        assert.equal(res.query, QUESTION);
        assert.equal(res.partial, true);
        assert.equal(typeof res.ms, 'number');
        assert.deepEqual(
            res.rows.map((r) => r.url),
            ['https://cafe.example.com/hours', 'https://library.example.edu/hours'],
        );
        const [cafe, library] = res.rows;
        assert.match(cafe.id, /^web:[0-9a-f]{16}$/);
        assert.equal(cafe.source, 'web');
        assert.equal(cafe.title, 'Corner Cafe: hours and menu');
        assert.equal(cafe.text, RAG_LOADED.markdown);
        assert.equal(cafe.fetchedAt, '2026-10-24T18:02:11.482Z');
        assert.equal(cafe.rank, 1);
        assert.equal(cafe.placeId, undefined);
        assert.equal(cafe.facts, undefined);
        // An empty page title falls back to the search result's title.
        assert.equal(library.title, 'Library hours');
        assert.equal(library.rank, 5);
    });

    it('caps long page text near 20,000 characters on a word boundary', async () => {
        const { fetch } = fakeFetch(json([RAG_LONG]));
        const res = await searchWeb(QUESTION, { config, fetch });
        const page = res.rows[0].text;
        assert.ok(RAG_LONG.markdown.length > 20_000);
        assert.ok(page.length <= 20_000 && page.length > 19_800, String(page.length));
        assert.ok(RAG_LONG.markdown.startsWith(page));
        assert.match(page, /\S$/);
        const small = await searchWeb(QUESTION, { config, fetch, maxTextChars: 1_000 });
        assert.ok(small.rows[0].text.length <= 1_000);
    });

    it('gives the same page the same id and keeps it once', async () => {
        const again = { ...RAG_LOADED, searchResult: { ...RAG_LOADED.searchResult, rank: 4 } };
        const { fetch } = fakeFetch(json([RAG_LOADED, again]));
        const res = await searchWeb(QUESTION, { config, fetch });
        assert.equal(res.rows.length, 1);
        assert.equal(res.partial, false);
        const second = await searchWeb('another question', { config, fetch });
        assert.equal(second.rows[0].id, res.rows[0].id);
    });

    it('passes the optional speed settings, sending false as an empty value', async () => {
        const { fetch, calls } = fakeFetch(json([]));
        await searchWeb(QUESTION, {
            config,
            fetch,
            maxResults: 1,
            scrapingTool: 'browser-playwright',
            dynamicContentWaitSecs: 5,
            removeCookieWarnings: false,
        });
        const params = new URL(calls[0].url).searchParams;
        assert.equal(params.get('maxResults'), '1');
        assert.equal(params.get('scrapingTool'), 'browser-playwright');
        assert.equal(params.get('dynamicContentWaitSecs'), '5');
        assert.equal(params.get('removeCookieWarnings'), '');
        await searchWeb(QUESTION, { config, fetch, removeCookieWarnings: true });
        assert.equal(new URL(calls[1].url).searchParams.get('removeCookieWarnings'), 'true');
    });

    it('gives the server a cutoff 5 s before ours so it can send what loaded', async () => {
        const { fetch, calls } = fakeFetch(json([]));
        await searchWeb(QUESTION, { config, fetch, timeoutMs: 20_000 });
        assert.equal(new URL(calls[0].url).searchParams.get('requestTimeoutSecs'), '15');
        await searchWeb(QUESTION, { config, fetch, requestTimeoutSecs: 25 });
        assert.equal(new URL(calls[1].url).searchParams.get('requestTimeoutSecs'), '25');
    });

    it('treats the server timeout with nothing loaded as a timeout and does not retry it', async () => {
        const { fetch, calls } = fakeFetch(json({ errorMessage: 'Timed out.' }, 500), json([RAG_LOADED]));
        const error = await rejection(searchWeb(QUESTION, { config, fetch, retryBaseMs: 1 }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'timeout');
        assert.equal(error.status, 500);
        assert.equal(calls.length, 1);
    });

    it('retries a 503 from a cold Standby start', async () => {
        const { fetch, calls } = fakeFetch(json({ message: 'starting' }, 503), json([RAG_LOADED]));
        const res = await searchWeb(QUESTION, { config, fetch, retryBaseMs: 1 });
        assert.equal(calls.length, 2);
        assert.equal(res.rows.length, 1);
    });

    it('gives up at our own timeout without retrying', async () => {
        const { fetch, calls } = fakeFetch(hang);
        const error = await rejection(searchWeb(QUESTION, { config, fetch, timeoutMs: 60, requestTimeoutSecs: 1 }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'timeout');
        assert.equal(calls.length, 1);
    });

    it('rejects a 400 with the Actor message and a non-array body as bad_response', async () => {
        const first = fakeFetch(json({ errorMessage: 'The `query` parameter must be provided and non-empty.' }, 400));
        const error = await rejection(searchWeb(QUESTION, { config, fetch: first.fetch }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.status, 400);
        assert.match(error.bodySnippet, /query/);
        assert.equal(first.calls.length, 1);

        const second = fakeFetch(json({ not: 'an array' }));
        const shape = await rejection(searchWeb(QUESTION, { config, fetch: second.fetch }));
        assert.ok(shape instanceof ApifyHttpError);
        assert.equal(shape.kind, 'bad_response');
    });

    it('checks its arguments before any request', async () => {
        const { fetch, calls } = fakeFetch(json([]));
        await assert.rejects(searchWeb('   ', { config, fetch }), RangeError);
        await assert.rejects(searchWeb('x'.repeat(1_001), { config, fetch }), RangeError);
        await assert.rejects(searchWeb(QUESTION, { config, fetch, maxResults: 0 }), RangeError);
        await assert.rejects(searchWeb(QUESTION, { config, fetch, maxResults: 11 }), RangeError);
        await assert.rejects(searchWeb(QUESTION, { config, fetch, requestTimeoutSecs: 301 }), RangeError);
        assert.equal(calls.length, 0);
    });

    it('keeps no more pages than asked for, caps titles and drops overlong links', async () => {
        const pages = Array.from({ length: 6 }, (_, i) => ({
            ...RAG_LOADED,
            metadata: { ...RAG_LOADED.metadata, url: `https://cafe.example.com/${i}`, title: 't'.repeat(5_000) },
        }));
        const { fetch } = fakeFetch(json(pages));
        const res = await searchWeb(QUESTION, { config, fetch, maxResults: 2 });
        assert.equal(res.rows.length, 2);
        for (const row of res.rows) assert.ok(row.title.length <= 300);

        const longLink = `https://cafe.example.com/${'p'.repeat(3_000)}`;
        const second = fakeFetch(
            json([{ ...RAG_LOADED, metadata: { ...RAG_LOADED.metadata, url: longLink }, searchResult: { ...RAG_LOADED.searchResult, url: longLink } }]),
        );
        const dropped = await searchWeb(QUESTION, { config, fetch: second.fetch });
        assert.equal(dropped.rows.length, 0);
        assert.equal(dropped.partial, true);
    });

    it('refuses a hand-built config that would put a token in the URL', async () => {
        const { fetch, calls } = fakeFetch(json([]));
        const leaky: ApifyConfig = { ...config, ragWebBrowserUrl: `https://rag-web-browser.apify.actor/?token=${TOKEN}` };
        await assert.rejects(
            searchWeb(QUESTION, { config: leaky, fetch }),
            (e: unknown) => e instanceof ConfigError && !e.message.includes(TOKEN),
        );
        assert.equal(calls.length, 0);
    });

    it('reports content-free events', async () => {
        const events: PipelineEvent[] = [];
        const { fetch } = fakeFetch(json([RAG_LOADED, RAG_TIMED_OUT]), json({ errorMessage: 'Timed out.' }, 500));
        await searchWeb(QUESTION, { config, fetch, onEvent: (e) => void events.push(e) });
        await rejection(searchWeb(QUESTION, { config, fetch, onEvent: (e) => void events.push(e) }));
        assert.deepEqual(
            events.map((e) => [e.stage, e.status, e.detail]),
            [
                ['search', 'started', 'web'],
                ['search', 'ok', 'web partial'],
                ['search', 'started', 'web'],
                ['search', 'error', 'web timeout'],
            ],
        );
        assert.deepEqual(events[1].counts, { rows: 1, skipped: 1 });
        const all = JSON.stringify(events);
        for (const content of ['corner cafe', 'Corner Cafe', 'example.com', 'Open daily']) assert.ok(!all.includes(content), content);
    });

    it('ignores a listener that throws', async () => {
        const { fetch } = fakeFetch(json([RAG_LOADED]));
        const res = await searchWeb(QUESTION, {
            config,
            fetch,
            onEvent: () => {
                throw new Error('dashboard down');
            },
        });
        assert.equal(res.rows.length, 1);
    });
});

describe('searchPlaces', () => {
    const near = { lat: 37.8716, lng: -122.2727 };
    const RUN_ID = 'HG7ML7M8z78YcAPEB';
    const DATASET_ID = 'wmKPijuyDnPZAPRMk';
    const START = 'https://api.apify.com/v2/actors/compass~crawler-google-places/runs';
    const RUN = `https://api.apify.com/v2/actor-runs/${RUN_ID}`;
    const ITEMS = `https://api.apify.com/v2/datasets/${DATASET_ID}/items`;

    /** An Apify run object, as the start call (201) and the status call (200) send it. */
    const run = (status: string, httpStatus = 201, data: Record<string, unknown> = {}): Reply =>
        json({ data: { id: RUN_ID, actId: 'nwua9Gu5YrADL7ZDj', status, defaultDatasetId: DATASET_ID, ...data } }, httpStatus);
    /** A run that has ended with `status` when the start call answers, then its dataset holding `places`. */
    const ran = (places: unknown[], status = 'SUCCEEDED'): Reply[] => [run(status), json(places)];
    const path = (call: SeenCall) => {
        const url = new URL(call.url);
        return `${call.method} ${url.origin}${url.pathname}`;
    };
    const starts = (calls: SeenCall[]) => calls.filter((call) => path(call) === `POST ${START}`);
    async function until(check: () => boolean): Promise<void> {
        for (let i = 0; i < 1_000 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
        assert.ok(check(), 'the condition never held');
    }

    it('starts a Google Maps Scraper run with memory, a time limit, a charge cap and a wait, then reads its dataset', async () => {
        const { fetch, calls } = fakeFetch(...ran([PLACE_OPEN]));
        await searchPlaces('lunch', { config, fetch, near, radiusKm: 1.5, maxPlaces: 5 });
        assert.equal(calls.length, 2);
        const [start, items] = calls;

        assert.equal(path(start), `POST ${START}`);
        const params = new URL(start.url).searchParams;
        assert.equal(params.get('timeout'), '120');
        assert.equal(params.get('memory'), '4096');
        // Apify's minimum: a cap of 0.25 came back HTTP 400 max-total-charge-usd-below-minimum in the Oct 24 live test.
        assert.equal(params.get('maxTotalChargeUsd'), '0.5');
        // The run's limit plus 5 s, within Apify's 60 s cap.
        assert.equal(params.get('waitForFinish'), '60');
        assert.equal(params.has('fields'), false);
        assert.equal(params.has('token'), false);
        assert.equal(start.headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(start.headers['content-type'], 'application/json');
        assert.deepEqual(start.body, {
            searchStringsArray: ['lunch'],
            maxCrawledPlacesPerSearch: 5,
            language: 'en',
            scrapePlaceDetailPage: false,
            maxReviews: 0,
            maxImages: 0,
            scrapeReviewsPersonalData: false,
            customGeolocation: { type: 'Point', coordinates: [-122.2727, 37.8716], radiusKm: 1.5 },
        });

        assert.equal(path(items), `GET ${ITEMS}`);
        const read = new URL(items.url).searchParams;
        assert.equal(read.get('format'), 'json');
        assert.equal(read.get('clean'), 'true');
        assert.equal(read.get('limit'), '5');
        assert.deepEqual(read.get('fields')?.split(','), [
            'title', 'address', 'location', 'totalScore', 'reviewsCount', 'wasOpenAtScrapeTime', 'permanentlyClosed',
            'temporarilyClosed', 'categoryName', 'phone', 'url', 'placeId', 'scrapedAt', 'additionalInfo',
        ]);
        assert.equal(read.has('token'), false);
        assert.equal(items.headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(items.body, undefined);

        const short = fakeFetch(...ran([]));
        await searchPlaces('lunch', { config, fetch: short.fetch, timeoutSecs: 20 });
        assert.equal(new URL(short.calls[0].url).searchParams.get('waitForFinish'), '25');
    });

    it('always sends a place count, no geolocation without near, and finds no places without failing', async () => {
        const { fetch, calls } = fakeFetch(...ran([]));
        const res = await searchPlaces('lunch near the campanile', { config, fetch });
        const body = calls[0].body as Record<string, unknown>;
        assert.equal(body.maxCrawledPlacesPerSearch, 8);
        assert.equal('customGeolocation' in body, false);
        assert.deepEqual(res.rows, []);
        assert.equal(res.partial, false);
    });

    it('builds rows from the fields present and never infers accessibility', async () => {
        const { fetch } = fakeFetch(...ran([PLACE_OPEN, PLACE_UNKNOWN, PLACE_GONE, PLACE_SEATING_ONLY, PLACE_BARE]));
        const res = await searchPlaces('lunch', { config, fetch, near });
        assert.deepEqual(
            res.rows.map((r) => r.id),
            ['maps:ChIJexample0000001', 'maps:ChIJexample0000002', 'maps:ChIJexample0000004', 'maps:ChIJexample0000005'],
        );
        const [open, unknown, seating, bare] = res.rows;

        assert.equal(open.source, 'maps');
        assert.equal(open.placeId, 'ChIJexample0000001');
        assert.deepEqual(open.location, { lat: 37.8688, lng: -122.2595 });
        assert.equal(open.fetchedAt, '2026-10-24T18:05:00.000Z');
        assert.equal(open.rank, 1);
        assert.equal(open.url, PLACE_OPEN.url);
        assert.deepEqual(open.facts, {
            rating: 4.6,
            reviews: 1520,
            openNow: true,
            wheelchairEntrance: true,
            address: '100 Example St, Berkeley, CA 94704',
            phone: '(510) 555-0100',
            category: 'Coffee shop',
        });
        assert.equal(
            open.text,
            'Corner Cafe. Coffee shop. 100 Example St, Berkeley, CA 94704. Rated 4.6 from 1,520 reviews. Open when checked. Wheelchair accessible entrance. Phone (510) 555-0100.',
        );

        // Explicitly false entrance, unknown open state, temporarily closed.
        assert.equal(unknown.facts?.wheelchairEntrance, undefined);
        assert.equal(unknown.facts?.openNow, undefined);
        assert.equal(
            unknown.text,
            'Noodle Bar. Noodle shop. 200 Example Ave, Berkeley, CA 94704. Rated 4.1 from 1 review. Temporarily closed. Phone (510) 555-0101.',
        );
        assert.equal(unknown.rank, 2);

        // Accessible seating is not an accessible entrance, and a 0 score is no rating.
        assert.equal(seating.facts?.wheelchairEntrance, undefined);
        assert.equal(seating.facts?.rating, undefined);
        assert.equal(seating.facts?.reviews, 0);
        assert.equal(seating.facts?.openNow, false);
        assert.ok(!seating.text.includes('Wheelchair'));
        assert.match(seating.text, /Closed when checked\./);

        assert.equal(bare.text, 'Pop-up Kiosk.');
        assert.equal(bare.facts, undefined);
        assert.equal(bare.location, undefined);
        assert.match(bare.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);

        for (const row of res.rows) assert.ok(!/wheelchair/i.test(row.text) || row.facts?.wheelchairEntrance === true);
    });

    it('drops permanently closed places and reports the count', async () => {
        const events: PipelineEvent[] = [];
        const { fetch } = fakeFetch(...ran([PLACE_GONE, PLACE_OPEN]));
        const res = await searchPlaces('lunch', { config, fetch, onEvent: (e) => void events.push(e) });
        assert.equal(res.rows.length, 1);
        assert.equal(res.partial, false);
        assert.deepEqual(events.at(-1)?.counts, { rows: 1, closed: 1, skipped: 0 });
        assert.equal(events.at(-1)?.detail, 'maps');
        assert.ok(!JSON.stringify(events).includes('Corner Cafe'));
    });

    it('keeps the places a run found before its time limit, marked partial', async () => {
        // Oct 25: "parks and gardens", 1 km around the venue, a 20 s limit: the run timed out with 4 places in its
        // dataset, and the sync endpoint answered HTTP 400 with none of them.
        const events: PipelineEvent[] = [];
        const { fetch, calls } = fakeFetch(...ran([PLACE_OPEN, PLACE_UNKNOWN], 'TIMED-OUT'));
        const res = await searchPlaces('parks and gardens', { config, fetch, near, maxPlaces: 3, timeoutSecs: 20, onEvent: (e) => void events.push(e) });
        assert.deepEqual(
            res.rows.map((r) => r.id),
            ['maps:ChIJexample0000001', 'maps:ChIJexample0000002'],
        );
        assert.equal(res.partial, true);
        assert.equal(calls.length, 2);
        assert.equal(new URL(calls[1].url).searchParams.get('limit'), '3');
        assert.deepEqual(
            events.map((e) => [e.status, e.detail]),
            [
                ['started', 'maps'],
                ['ok', 'maps partial'],
            ],
        );
        assert.deepEqual(events[1].counts, { rows: 2, closed: 0, skipped: 0 });
    });

    it('treats a run that timed out with no places as a timeout', async () => {
        const events: PipelineEvent[] = [];
        const { fetch, calls } = fakeFetch(...ran([], 'TIMED-OUT'));
        const error = await rejection(searchPlaces('lunch', { config, fetch, timeoutSecs: 20, onEvent: (e) => void events.push(e) }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'timeout');
        assert.equal(error.status, null);
        assert.equal(calls.length, 2);
        assert.equal(events.at(-1)?.detail, 'maps timeout');
    });

    it('waits on a run that is still going, through its time-out, then reads its places', async () => {
        const { fetch, calls } = fakeFetch(run('RUNNING'), run('TIMING-OUT', 200), run('TIMED-OUT', 200), json([PLACE_OPEN]));
        const res = await searchPlaces('lunch', { config, fetch, timeoutSecs: 20 });
        assert.equal(res.rows.length, 1);
        assert.equal(res.partial, true);
        assert.deepEqual(calls.map(path), [`POST ${START}`, `GET ${RUN}`, `GET ${RUN}`, `GET ${ITEMS}`]);
        for (const poll of calls.slice(1, 3)) {
            // What is left of the 50 s call (the run's 20 s plus 30 s), less 5 s for the reply and the dataset read.
            const wait = Number(new URL(poll.url).searchParams.get('waitForFinish'));
            assert.ok(wait >= 40 && wait <= 45, String(wait));
            assert.equal(poll.headers.authorization, `Bearer ${TOKEN}`);
        }
    });

    it('rejects a run that failed or was aborted without reading its dataset or aborting it', async () => {
        for (const status of ['FAILED', 'ABORTED']) {
            const events: PipelineEvent[] = [];
            const { fetch, calls } = fakeFetch(run(status), json([PLACE_OPEN]));
            const error = await rejection(searchPlaces('lunch', { config, fetch, onEvent: (e) => void events.push(e) }));
            assert.ok(error instanceof ApifyHttpError);
            assert.equal(error.kind, 'bad_response');
            assert.equal(error.bodySnippet, `The run ended ${status}.`);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(calls.length, 1);
            assert.equal(events.at(-1)?.detail, 'maps bad response');
        }
    });

    it('treats 408 as a timeout and does not retry it', async () => {
        const body = { error: { type: 'run-timeout-exceeded', message: 'Actor run exceeded the timeout' } };
        const { fetch, calls } = fakeFetch(json(body, 408), ...ran([PLACE_OPEN]));
        const error = await rejection(searchPlaces('lunch', { config, fetch }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'timeout');
        assert.equal(error.status, 408);
        assert.match(error.bodySnippet, /^run-timeout-exceeded: /);
        assert.equal(calls.length, 1);
    });

    it('never retries starting a run, since each POST can start another paid run', async () => {
        for (const reply of [json({}, 502), json({}, 429), networkError('ECONNRESET')]) {
            const { fetch, calls } = fakeFetch(reply, ...ran([PLACE_OPEN]));
            await rejection(searchPlaces('lunch', { config, fetch }));
            assert.equal(calls.length, 1);
        }
    });

    it('tries a read once more after a 5xx, and never starts the run again', async () => {
        const { fetch, calls } = fakeFetch(run('SUCCEEDED'), json({}, 503, { 'retry-after': '0' }), json([PLACE_OPEN]));
        const res = await searchPlaces('lunch', { config, fetch });
        assert.equal(res.rows.length, 1);
        assert.deepEqual(calls.map(path), [`POST ${START}`, `GET ${ITEMS}`, `GET ${ITEMS}`]);

        const twice = fakeFetch(run('SUCCEEDED'), json({}, 503, { 'retry-after': '0' }));
        const error = await rejection(searchPlaces('lunch', { config, fetch: twice.fetch }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.status, 503);
        assert.equal(twice.calls.length, 3);
        assert.equal(starts(twice.calls).length, 1);
    });

    it('aborts the run and rejects as cancelled when the caller cancels while it waits', async () => {
        const events: PipelineEvent[] = [];
        const controller = new AbortController();
        const { fetch, calls } = fakeFetch(run('RUNNING'), hang, run('ABORTED', 200));
        const pending = rejection(searchPlaces('lunch', { config, fetch, signal: controller.signal, onEvent: (e) => void events.push(e) }));
        await until(() => calls.length === 2);
        controller.abort();
        const error = await pending;
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'aborted');
        await until(() => calls.length === 3);
        const abort = calls[2];
        assert.equal(path(abort), `POST ${RUN}/abort`);
        assert.equal(abort.headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(abort.body, undefined);
        assert.equal(new URL(abort.url).searchParams.has('token'), false);
        assert.equal(starts(calls).length, 1);
        assert.equal(events.at(-1)?.detail, 'maps aborted');

        // Cancelled before the start: nothing is sent at all.
        const early = fakeFetch(...ran([PLACE_OPEN]));
        const before = await rejection(searchPlaces('lunch', { config, fetch: early.fetch, signal: AbortSignal.abort() }));
        assert.ok(before instanceof ApifyHttpError);
        assert.equal(before.kind, 'aborted');
        assert.equal(before.attempts, 0);
        assert.equal(early.calls.length, 0);
    });

    it('gives up on a run that never ends after a bounded number of waits, and aborts it', async () => {
        const { fetch, calls } = fakeFetch(run('RUNNING'), run('RUNNING', 200));
        const error = await rejection(searchPlaces('lunch', { config, fetch, timeoutSecs: 20 }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'timeout');
        await until(() => calls.some((call) => path(call) === `POST ${RUN}/abort`));
        assert.equal(calls.filter((call) => path(call) === `GET ${RUN}`).length, 8);
        assert.equal(starts(calls).length, 1);
        assert.equal(calls.length, 10);
    });

    it('refuses a run reply it cannot use, and aborts a run whose status reply is not that run', async () => {
        const bad = [
            { id: '../../v2/users/me', status: 'SUCCEEDED', defaultDatasetId: DATASET_ID },
            { id: RUN_ID, status: 'SUCCEEDED' },
            { id: RUN_ID, status: 'PAUSED', defaultDatasetId: DATASET_ID },
            { id: RUN_ID, status: 'SUCCEEDED', defaultDatasetId: 'x/../y' },
        ];
        for (const data of bad) {
            const { fetch, calls } = fakeFetch(json({ data }, 201), json([PLACE_OPEN]));
            const error = await rejection(searchPlaces('lunch', { config, fetch }));
            assert.ok(error instanceof ApifyHttpError);
            assert.equal(error.kind, 'bad_response');
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(calls.length, 1, JSON.stringify(data));
        }

        const other = fakeFetch(run('RUNNING'), run('SUCCEEDED', 200, { id: 'SomeOtherRun00001' }), json({}));
        const error = await rejection(searchPlaces('lunch', { config, fetch: other.fetch }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'bad_response');
        await until(() => other.calls.length === 3);
        assert.equal(path(other.calls[2]), `POST ${RUN}/abort`);
    });

    it('names the route in an error, never the run or dataset id', async () => {
        const { fetch, calls } = fakeFetch(run('SUCCEEDED'), json({ error: { type: 'record-not-found', message: 'Dataset was not found.' } }, 404));
        const error = await rejection(searchPlaces('lunch', { config, fetch }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'http');
        assert.equal(error.status, 404);
        assert.equal(error.endpoint, 'GET api.apify.com/v2/datasets/:datasetId/items');
        assert.equal(error.attempts, 2);
        assert.equal(calls.length, 2);
        for (const text of [error.message, error.endpoint, error.bodySnippet]) {
            assert.ok(!text.includes(RUN_ID) && !text.includes(DATASET_ID), text);
        }

        const failed = fakeFetch(run('RUNNING'), run('FAILED', 200));
        const ended = await rejection(searchPlaces('lunch', { config, fetch: failed.fetch }));
        assert.ok(ended instanceof ApifyHttpError);
        assert.equal(ended.endpoint, 'GET api.apify.com/v2/actor-runs/:runId');
        assert.ok(!ended.message.includes(RUN_ID));
    });

    it('keeps no more places than asked for and caps every field', async () => {
        const huge = 'y'.repeat(250_000);
        const many = Array.from({ length: 20 }, (_, i) => ({
            ...PLACE_OPEN,
            placeId: `ChIJmany${i}`,
            title: `${huge} ${i}`,
            address: huge,
            categoryName: huge,
            phone: huge,
            url: `https://www.google.com/maps/${huge}`,
        }));
        const { fetch, calls } = fakeFetch(...ran(many.slice(0, 3)));
        const res = await searchPlaces('lunch', { config, fetch, maxPlaces: 1 });
        assert.equal(new URL(calls[1].url).searchParams.get('limit'), '1');
        assert.equal(res.rows.length, 1);
        const [row] = res.rows;
        assert.ok(row.title.length <= 300);
        assert.ok((row.facts?.address ?? '').length <= 300);
        assert.ok((row.facts?.category ?? '').length <= 100);
        assert.equal(row.facts?.phone, undefined);
        assert.equal(row.url, undefined);
        assert.ok(row.text.length < 1_000, String(row.text.length));

        const longId = fakeFetch(...ran([{ ...PLACE_BARE, placeId: 'z'.repeat(500) }]));
        const [bare] = (await searchPlaces('lunch', { config, fetch: longId.fetch })).rows;
        assert.equal(bare.placeId, undefined);
        assert.match(bare.id, /^maps:[0-9a-f]{16}$/);
    });

    it('refuses a dataset reply over 4 MiB while it streams in', async () => {
        const { fetch, calls } = fakeFetch(...ran(Array.from({ length: 20 }, () => ({ ...PLACE_OPEN, title: 'y'.repeat(250_000) }))));
        const error = await rejection(searchPlaces('lunch', { config, fetch }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'bad_response');
        assert.match(error.bodySnippet, /larger than/);
        assert.equal(calls.length, 2);
    });

    it('checks its arguments before any request', async () => {
        const { fetch, calls } = fakeFetch(...ran([]));
        await assert.rejects(searchPlaces('', { config, fetch }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, maxPlaces: 0 }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, maxPlaces: 51 }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, timeoutSecs: 300 }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, memoryMbytes: 3000 }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, maxChargeUsd: 0 }), RangeError);
        // Under Apify's $0.50 minimum: refused here, before a request Apify would answer with HTTP 400.
        await assert.rejects(searchPlaces('lunch', { config, fetch, maxChargeUsd: 0.25 }), /at least 0\.50/);
        await assert.rejects(searchPlaces('lunch', { config, fetch, maxChargeUsd: 0.49 }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, maxChargeUsd: 50 }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, near: { lat: 200, lng: 0 } }), RangeError);
        assert.equal(calls.length, 0);
    });

    it('sends a charge cap the caller sets, from the $0.50 minimum up to 5', async () => {
        const { fetch, calls } = fakeFetch(...ran([]), ...ran([]));
        await searchPlaces('lunch', { config, fetch, maxChargeUsd: 0.5 });
        await searchPlaces('lunch', { config, fetch, maxChargeUsd: 5 });
        assert.deepEqual(
            starts(calls).map((call) => new URL(call.url).searchParams.get('maxTotalChargeUsd')),
            ['0.5', '5'],
        );
    });
});
