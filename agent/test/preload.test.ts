// PLAN D26 (Stephen, Oct 25 2:15 AM): the search is capped at 11 s with one attempt per pick, real Apify results are
// preloaded and used when the live search is slow or fails, place words such as "spots" go to the maps search, and the
// pinned place (AGENT_PINNED_PLACE) is always one reply to a place question. Over the fakes (no network, no keys).

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyQuestion, type SearchResult, type SearchRow } from '@say-when/apify-client';

import { readConfig } from '../src/config.js';
import { contentWords, loadPreload, parsePreload, placeKey, PreloadFileError, SearchCache, webMatchScore, type PreloadSearch } from '../src/preload.js';
import { placeQuery, withPlaceWords, type PlannedSearch } from '../src/retrieval.js';
import { harness, placeRow, reply, settle, waitFor, type Harness, type HarnessOptions } from './helpers.js';

let open: Harness | null = null;
let caches: SearchCache[] = [];
afterEach(async () => {
    for (const cache of caches) cache.close();
    caches = [];
    await open?.orchestrator.stop(1_000);
    open = null;
});

function start(options: HarnessOptions = {}): Harness {
    const h = harness({ direct: true, placesNear: true, ...options });
    h.deps.maxOptions = 3;
    open = h;
    h.orchestrator.start();
    return h;
}

const FUN_QUESTION = 'Anything you want to do today in San Francisco?';
const PRELOADED_AT = '2026-10-25T08:00:00.000Z';
const NEAR = { lat: 37.87, lng: -122.27 };

/** A maps row fetched by the preload, with its own fetchedAt. */
function preloadedRow(n: number, title = `Park ${n}`): SearchRow {
    return { ...placeRow(n), id: `maps:pre${n}`, title, placeId: `pre${n}`, fetchedAt: PRELOADED_AT };
}

const PALACE: SearchRow = { ...placeRow(9), id: 'maps:palace', title: 'Palace of Fine Arts', placeId: 'palace', fetchedAt: PRELOADED_AT };

interface Sent {
    calls: PlannedSearch[];
    send: (planned: PlannedSearch, signal: AbortSignal) => Promise<SearchResult>;
}

function fakeSend(rowsFor: (planned: PlannedSearch) => SearchRow[] = () => [preloadedRow(1), preloadedRow(2)]): Sent {
    const calls: PlannedSearch[] = [];
    return {
        calls,
        send: async (planned) => {
            calls.push(planned);
            return { rows: rowsFor(planned), ms: 1, query: planned.query, partial: false };
        },
    };
}

function cacheFor(h: Harness, searches: PreloadSearch[], sent: Sent, refreshMs = 0): SearchCache {
    const cache = new SearchCache(h.db, h.log, () => performance.now(), { searches, timeoutMs: 1_000, refreshMs, send: sent.send });
    caches.push(cache);
    h.deps.retrieval.cache = cache;
    return cache;
}

const searchEvents = (h: Harness, jobId: bigint) => h.db.events.filter((e) => e.stage === 'search' && e.jobId === jobId);
const counts = (json: string | undefined): Record<string, unknown> => JSON.parse(json ?? '{}') as Record<string, unknown>;
const finalPublish = (h: Harness, jobId: bigint) => h.db.publishes.filter((p) => p.jobId === jobId).at(-1);

describe('search cap and preload (PLAN D26): searches', () => {
    it('uses the preloaded rows, with their own fetchedAt, when the live search fails', async () => {
        const h = start({ cacheGraceMs: 1_000 });
        const cache = cacheFor(h, [{ kind: 'maps', query: 'park' }], fakeSend());
        await cache.refresh();
        assert.equal(cache.size, 1);
        h.search.error = new Error('maps down');
        // "Nature" goes out as "parks and gardens", whose place key is park.
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, category: 'Nature' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.search.calls.length, 1, 'one live attempt');
        const events = searchEvents(h, jobId);
        assert.deepEqual(events.map((e) => [e.status, e.detail]), [['started', 'maps'], ['ok', 'maps cached']]);
        const c = counts(events[1]?.countsJson);
        assert.equal(c.cached, true);
        assert.equal(c.liveFailed, true);
        assert.equal(typeof c.ageS, 'number');
        const rows = (JSON.parse(events[1]?.payloadJson ?? '{}') as { rows: { fetchedAt: string }[] }).rows;
        assert.ok(rows.length === 2 && rows.every((r) => r.fetchedAt === PRELOADED_AT), 'the rows keep the time they were fetched');
        const published = finalPublish(h, jobId);
        assert.deepEqual(published?.options.map((o) => [o.label, o.sources[0]?.placeId, o.sources[0]?.fetchedAt]), [
            ['Park 1', 'pre1', PRELOADED_AT],
            ['Park 2', 'pre2', PRELOADED_AT],
        ]);
    });

    it('prefers a live result that arrives within the grace', async () => {
        const h = start({ cacheGraceMs: 2_000 });
        const cache = cacheFor(h, [{ kind: 'maps', query: 'park' }], fakeSend());
        await cache.refresh();
        h.search.rows = [placeRow(1), placeRow(2)];
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, category: 'Nature' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(searchEvents(h, jobId).map((e) => [e.status, e.detail]), [['started', 'maps'], ['ok', 'maps']]);
        assert.equal(counts(searchEvents(h, jobId)[1]?.countsJson).cached, undefined);
        assert.deepEqual(finalPublish(h, jobId)?.options.map((o) => o.sources[0]?.placeId), ['place1', 'place2']);
    });

    it('takes the preloaded rows once the grace passes, and stops the live search', async () => {
        const h = start({ cacheGraceMs: 50, searchTimeoutMs: 5_000 });
        const cache = cacheFor(h, [{ kind: 'maps', query: 'park' }], fakeSend());
        await cache.refresh();
        h.search.hang = true;
        const began = Date.now();
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, category: 'Nature' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.ok(Date.now() - began < 2_000, 'well inside the search deadline');
        const events = searchEvents(h, jobId);
        assert.deepEqual(events.map((e) => [e.status, e.detail]), [['started', 'maps'], ['ok', 'maps cached']]);
        assert.equal(counts(events[1]?.countsJson).liveFailed, false);
        assert.ok(h.log.entries.some((e) => e.message === 'search used preloaded results' && e.fields.why === 'slow'));
    });

    it('keeps to the search deadline with no preloaded match: one attempt, then no outside facts', async () => {
        const h = start({ searchTimeoutMs: 200 });
        h.search.hang = true;
        h.api.reply({ answer_mode: 'pick', options: [reply({ label: 'Not sure', text: 'Not sure, honestly.', tone: 'calm' }), reply({ label: 'Ask later', text: 'Ask me later.', tone: 'warm' })] });
        const began = Date.now();
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, category: 'Nature' });
        await waitFor(() => searchEvents(h, jobId).length === 2, 3_000, 'search ended');
        assert.ok(Date.now() - began < 2_000);
        assert.deepEqual(searchEvents(h, jobId).map((e) => [e.status, e.detail]), [['started', 'maps'], ['error', 'maps timeout']]);
        assert.equal(h.search.calls.length, 1);
    });

    it('does not preload or use the cache without web search consent, and drops it on a revocation', async () => {
        const h = start();
        h.db.revokeConsent('web_search');
        const sent = fakeSend();
        const cache = cacheFor(h, [{ kind: 'maps', query: 'park' }], sent);
        cache.start();
        await settle();
        assert.equal(sent.calls.length, 0, 'nothing goes out without consent');
        assert.equal(cache.find({ kind: 'maps', query: 'park' }), null);
        // Given again: the round that waited runs now.
        h.db.grantConsent('web_search');
        await waitFor(() => cache.size === 1, 3_000, 'preloaded after the grant');
        assert.ok(cache.find({ kind: 'maps', query: 'parks and gardens' }));
        h.db.revokeConsent('web_search');
        assert.equal(cache.find({ kind: 'maps', query: 'park' }), null, 'never used once consent is off');
        await waitFor(() => cache.size === 0, 3_000, 'a revocation empties the cache');
        assert.ok(h.log.entries.some((e) => e.message === 'search preload dropped' && e.fields.why === 'consent'));
    });

    it('refreshes on its timer, and the timer stops when the cache closes', async () => {
        const h = start();
        const sent = fakeSend();
        const cache = cacheFor(h, [{ kind: 'maps', query: 'park' }], sent, 30);
        cache.start();
        await waitFor(() => sent.calls.length >= 3, 3_000, 'three rounds');
        cache.close();
        const after = sent.calls.length;
        await settle(150);
        assert.equal(sent.calls.length, after, 'no round after close');
        assert.equal(cache.size, 0);
    });

    it('runs at most two preload searches at once and keeps a failed one out', async () => {
        const h = start();
        let running = 0;
        let most = 0;
        const searches: PreloadSearch[] = ['park', 'cafe', 'museum', 'restaurant', 'tourist attraction'].map((query) => ({ kind: 'maps', query }));
        const cache = new SearchCache(h.db, h.log, () => performance.now(), {
            searches,
            timeoutMs: 1_000,
            refreshMs: 0,
            send: async (planned) => {
                running += 1;
                most = Math.max(most, running);
                await settle(10);
                running -= 1;
                if (planned.query === 'museum') throw new Error('maps down');
                return { rows: [preloadedRow(1)], ms: 1, query: planned.query, partial: false };
            },
        });
        caches.push(cache);
        await cache.refresh();
        assert.equal(most, 2);
        assert.equal(cache.size, 4);
        assert.equal(cache.find({ kind: 'maps', query: 'museums' }), null);
        assert.ok(h.log.entries.some((e) => e.message === 'search preload done' && e.fields.ok === 4 && e.fields.failed === 1));
    });
});

describe('search cap and preload (PLAN D26): matching and the list', () => {
    it('matches maps searches by place key and web searches by shared words', () => {
        assert.equal(placeKey('quiet cafe'), 'cafe');
        assert.equal(placeKey('coffee'), 'cafe');
        assert.equal(placeKey('parks and gardens'), 'park');
        assert.equal(placeKey('hiking trails'), 'park');
        assert.equal(placeKey('fun things to do'), 'tourist attraction');
        assert.equal(placeKey('lunch'), 'restaurant');
        const hours = contentWords('Palace of Fine Arts San Francisco hours');
        assert.ok(webMatchScore(contentWords('Do you know what time the Palace of Fine Arts closes?'), hours) >= 0.5);
        assert.equal(webMatchScore(contentWords('Do you know the weather in San Francisco?'), hours), 0);
        assert.equal(webMatchScore(contentWords('Who won the Giants game?'), hours), 0);
    });

    it('ships a preload list that parses, with the venue and the usual place categories', () => {
        const list = loadPreload(fileURLToPath(new URL('../preload.example.json', import.meta.url)));
        assert.ok(list.some((s) => s.kind === 'maps' && s.query === 'Palace of Fine Arts San Francisco'));
        for (const key of ['park', 'tourist attraction', 'restaurant', 'cafe']) assert.ok(list.some((s) => s.kind === 'maps' && placeKey(s.query) === key), key);
        assert.equal(list.filter((s) => s.kind === 'web').length, 3);
        assert.throws(() => parsePreload('{"searches":[{"kind":"news","query":"x"}]}'), PreloadFileError);
        assert.throws(() => parsePreload('[]'), PreloadFileError);
    });

    it('reads the settings: an 11 s search, the preload on by default, the pinned place', () => {
        const file = fileURLToPath(new URL('../preload.example.json', import.meta.url));
        const env = { ANTHROPIC_API_KEY: 'k', APIFY_TOKEN: 't', AGENT_PLACES_NEAR: '37.8029,-122.4484' };
        const token = join(tmpdir(), 'say-when-preload-test-token');
        const on = readConfig(env, token, () => true, file);
        assert.deepEqual(on.problems, []);
        assert.equal(on.config.search.timeoutMs, 11_000);
        assert.equal(on.config.preload.refreshMs, 20 * 60_000);
        assert.equal(on.config.preload.searches.length, 9);
        assert.equal(on.config.pinnedPlace, null);
        const noMaps = readConfig({ ANTHROPIC_API_KEY: 'k', APIFY_TOKEN: 't' }, token, () => true, file);
        assert.equal(noMaps.config.preload.searches.length, 3, 'maps searches need AGENT_PLACES_NEAR');
        assert.equal(readConfig({ ...env, AGENT_PRELOAD: 'off' }, token, () => true, file).config.preload.searches.length, 0);
        assert.equal(readConfig({ ...env, AGENT_PINNED_PLACE: 'Palace of Fine Arts' }, token, () => true, file).config.pinnedPlace, 'Palace of Fine Arts');
        assert.ok(readConfig({ ...env, AGENT_PRELOAD_REFRESH_MS: '500' }, token, () => true, file).problems.length > 0);
        assert.ok(readConfig({ ...env, AGENT_PRELOAD_FILE: '/nonexistent/preload.json' }, token, () => true, file).problems.length > 0);
    });
});

describe('place words go to the maps (PLAN D26)', () => {
    const classify = withPlaceWords(classifyQuestion);

    it('marks spots, places, somewhere and things to do as place questions, and leaves weather and small talk alone', () => {
        for (const q of ['Do you know any good spots?', 'Do you know any good outdoor spots?', 'Do you know somewhere fun to go?', 'Any good places to hang out?']) {
            assert.equal(classify(q).kind, 'places', q);
        }
        assert.equal(classify('How was your day outside?').kind, 'smalltalk');
        assert.notEqual(classify('Is it cold outside?').kind, 'places');
        assert.equal(placeQuery('Do you know any good spots?'), 'tourist attraction');
        assert.equal(placeQuery('Do you know any good outdoor spots?'), 'park');
        assert.equal(placeQuery('Do you know somewhere fun to go?'), 'tourist attraction');
    });

    for (const [question, query] of [
        ['Do you know any good spots?', 'tourist attraction'],
        ['Do you know any good outdoor spots?', 'park'],
        ['Do you know somewhere fun to go?', 'tourist attraction'],
    ] as const) {
        it(`searches the maps near the venue for "${question}"`, async () => {
            const h = start();
            h.search.rows = [placeRow(1), placeRow(2)];
            const jobId = h.db.addOptionsJob({ questionText: question });
            await waitFor(() => h.db.job(jobId)?.status === 'done');
            assert.deepEqual(h.search.calls, [{ kind: 'maps', query, near: NEAR }]);
            assert.deepEqual(finalPublish(h, jobId)?.options.map((o) => [o.kind, o.label]), [
                ['reply', 'Pharmacy 1'],
                ['reply', 'Pharmacy 2'],
                ['search', 'Search the web'],
            ]);
        });
    }
});

describe('the pinned place (AGENT_PINNED_PLACE, PLAN D26)', () => {
    const PINNED = 'Palace of Fine Arts';

    it('is the first reply to a place question, with no source when the maps did not find it; Search the web stays third', async () => {
        const h = start({ pinnedPlace: PINNED });
        h.search.rows = [placeRow(1), placeRow(2)];
        const jobId = h.db.addOptionsJob({ questionText: 'Do you know any good spots?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(finalPublish(h, jobId)?.options.map((o) => [o.kind, o.label, o.text, o.provenance, o.sources.length]), [
            ['reply', 'Palace of Fine Arts', "Let's go to Palace of Fine Arts!", 'stock', 0],
            ['reply', 'Pharmacy 1', "Let's go to Pharmacy 1!", 'maps', 1],
            ['search', 'Search the web', 'Search the web for ideas.', 'stock', 0],
        ]);
    });

    it('cites the maps row when the search found it', async () => {
        const h = start({ pinnedPlace: PINNED });
        h.search.rows = [placeRow(1), { ...PALACE, fetchedAt: '2026-10-24T19:00:00.000Z' }];
        const jobId = h.db.addOptionsJob({ questionText: 'Do you know any good outdoor spots?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(finalPublish(h, jobId)?.options.map((o) => [o.label, o.provenance, o.sources[0]?.placeId]), [
            ['Palace of Fine Arts', 'maps', 'palace'],
            ['Pharmacy 1', 'maps', 'place1'],
            ['Search the web', 'stock', undefined],
        ]);
    });

    it('cites the preloaded row for it when the live search did not find it', async () => {
        const h = start({ pinnedPlace: PINNED });
        const cache = cacheFor(h, [{ kind: 'maps', query: 'Palace of Fine Arts San Francisco' }], fakeSend(() => [PALACE]));
        await cache.refresh();
        h.search.rows = [placeRow(1), placeRow(2)];
        const jobId = h.db.addOptionsJob({ questionText: 'Do you know somewhere fun to go?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        const first = finalPublish(h, jobId)?.options[0];
        assert.deepEqual([first?.label, first?.provenance, first?.sources[0]?.placeId, first?.sources[0]?.fetchedAt], [PINNED, 'maps', 'palace', PRELOADED_AT]);
        assert.equal(first?.text, "Let's go to Palace of Fine Arts!", 'its name only: no address, hours or rating');
    });

    it('is one of the three category search replies', async () => {
        const h = start({ pinnedPlace: PINNED });
        h.search.rows = [placeRow(1), placeRow(2), placeRow(3)];
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, category: 'Nature' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(finalPublish(h, jobId)?.options.map((o) => [o.kind, o.label]), [
            ['reply', 'Palace of Fine Arts'],
            ['reply', 'Pharmacy 1'],
            ['reply', 'Pharmacy 2'],
        ]);
    });

    it('is still offered first when the maps search failed and Claude wrote the replies', async () => {
        const h = start({ pinnedPlace: PINNED });
        h.search.error = new Error('maps down');
        h.api.reply({ answer_mode: 'pick', options: [reply({ label: 'Not sure', text: 'Not sure, honestly.', tone: 'calm' }), reply({ label: 'Ask later', text: 'Ask me later.', tone: 'warm' })] });
        const jobId = h.db.addOptionsJob({ questionText: 'Do you know any good spots?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(finalPublish(h, jobId)?.options.map((o) => [o.kind, o.label, o.sources.length]), [
            ['reply', 'Palace of Fine Arts', 0],
            ['reply', 'Not sure', 0],
            ['search', 'Search the web', 0],
        ]);
    });

    it('is not added to a question that is not about places', async () => {
        const h = start({ pinnedPlace: PINNED });
        h.api.reply({ answer_mode: 'pick', options: [reply({ label: 'Giants won', text: 'I think the Giants won.', tone: 'warm' }), reply({ label: 'No idea', text: 'No idea, honestly.', tone: 'calm' })] });
        const jobId = h.db.addOptionsJob({ questionText: 'Do you know who won the Giants game last night?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.ok(!finalPublish(h, jobId)?.options.some((o) => o.label === PINNED));
    });
});
