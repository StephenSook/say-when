import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, type ApifyConfig } from '../src/config.js';
import type { PipelineEvent } from '../src/events.js';
import { ApifyHttpError } from '../src/http.js';
import { searchPlaces, searchWeb } from '../src/search.js';
import { TOKEN, fakeFetch, hang, json } from './fake-fetch.js';
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
        const res = await searchWeb(QUESTION, { config, fetch });
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

    it('runs the Google Maps Scraper synchronously with memory, a time limit and a charge cap', async () => {
        const { fetch, calls } = fakeFetch(json([PLACE_OPEN], 201));
        await searchPlaces('lunch', { config, fetch, near, radiusKm: 1.5, maxPlaces: 5 });
        const call = calls[0];
        const url = new URL(call.url);
        assert.equal(call.method, 'POST');
        assert.equal(
            `${url.origin}${url.pathname}`,
            'https://api.apify.com/v2/actors/compass~crawler-google-places/run-sync-get-dataset-items',
        );
        assert.equal(url.searchParams.get('timeout'), '120');
        assert.equal(url.searchParams.get('memory'), '4096');
        assert.equal(url.searchParams.get('maxTotalChargeUsd'), '0.25');
        assert.deepEqual(url.searchParams.get('fields')?.split(','), [
            'title', 'address', 'location', 'totalScore', 'reviewsCount', 'wasOpenAtScrapeTime', 'permanentlyClosed',
            'temporarilyClosed', 'categoryName', 'phone', 'url', 'placeId', 'scrapedAt', 'additionalInfo',
        ]);
        assert.equal(url.searchParams.has('token'), false);
        assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(call.headers['content-type'], 'application/json');
        assert.deepEqual(call.body, {
            searchStringsArray: ['lunch'],
            maxCrawledPlacesPerSearch: 5,
            language: 'en',
            scrapePlaceDetailPage: false,
            maxReviews: 0,
            maxImages: 0,
            scrapeReviewsPersonalData: false,
            customGeolocation: { type: 'Point', coordinates: [-122.2727, 37.8716], radiusKm: 1.5 },
        });
    });

    it('always sends a place count, and no geolocation without near', async () => {
        const { fetch, calls } = fakeFetch(json([], 201));
        await searchPlaces('lunch near the campanile', { config, fetch });
        const body = calls[0].body as Record<string, unknown>;
        assert.equal(body.maxCrawledPlacesPerSearch, 8);
        assert.equal('customGeolocation' in body, false);
    });

    it('builds rows from the fields present and never infers accessibility', async () => {
        const { fetch } = fakeFetch(json([PLACE_OPEN, PLACE_UNKNOWN, PLACE_GONE, PLACE_SEATING_ONLY, PLACE_BARE], 201));
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
        const { fetch } = fakeFetch(json([PLACE_GONE, PLACE_OPEN], 201));
        const res = await searchPlaces('lunch', { config, fetch, onEvent: (e) => void events.push(e) });
        assert.equal(res.rows.length, 1);
        assert.equal(res.partial, false);
        assert.deepEqual(events.at(-1)?.counts, { rows: 1, closed: 1, skipped: 0 });
        assert.equal(events.at(-1)?.detail, 'maps');
        assert.ok(!JSON.stringify(events).includes('Corner Cafe'));
    });

    it('treats 408 as a timeout and does not retry it', async () => {
        const body = { error: { type: 'run-timeout-exceeded', message: 'Actor run exceeded the timeout of 300 seconds for this API endpoint' } };
        const { fetch, calls } = fakeFetch(json(body, 408), json([PLACE_OPEN], 201));
        const error = await rejection(searchPlaces('lunch', { config, fetch, retryBaseMs: 1 }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'timeout');
        assert.equal(error.status, 408);
        assert.match(error.bodySnippet, /^run-timeout-exceeded: /);
        assert.equal(calls.length, 1);
    });

    it('retries a 5xx once by default, then gives up', async () => {
        const { fetch, calls } = fakeFetch(json({}, 502));
        await rejection(searchPlaces('lunch', { config, fetch, retryBaseMs: 1 }));
        assert.equal(calls.length, 2);
    });

    it('checks its arguments before any request', async () => {
        const { fetch, calls } = fakeFetch(json([], 201));
        await assert.rejects(searchPlaces('', { config, fetch }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, maxPlaces: 0 }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, maxPlaces: 51 }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, timeoutSecs: 300 }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, memoryMbytes: 3000 }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, maxChargeUsd: 0 }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, maxChargeUsd: 50 }), RangeError);
        await assert.rejects(searchPlaces('lunch', { config, fetch, near: { lat: 200, lng: 0 } }), RangeError);
        assert.equal(calls.length, 0);
    });
});
