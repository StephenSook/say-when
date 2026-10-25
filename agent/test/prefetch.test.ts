// Search prefetch for direct select (src/prefetch.ts, AGENT_SEARCH_PREFETCH): the search for each category starts as
// the categories are published, and the category search job takes over the run for the picked category. Over the
// fakes (no network, no keys).

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { SearchResult } from '@say-when/apify-client';

import { readConfig } from '../src/config.js';
import { MemoryDb } from '../src/db/memory-db.js';
import { recordingLogger } from '../src/log.js';
import { buildUserMessage, SYSTEM_PROMPT } from '../src/planner/prompt.js';
import type { PlanReply } from '../src/planner/schema.js';
import type { PlanInput } from '../src/planner/types.js';
import { PREFETCH_LIMITS, SearchPrefetch } from '../src/prefetch.js';
import { SearchCache } from '../src/preload.js';
import { categorySearch, shortPlaceQuery, type PlannedSearch } from '../src/retrieval.js';
import { harness, placeRow, reply, waitFor, type Harness, type HarnessOptions } from './helpers.js';

let open: Harness | null = null;
afterEach(async () => {
    await open?.orchestrator.stop(1_000);
    open = null;
});

function start(options: HarnessOptions = {}): Harness {
    const h = harness({ direct: true, placesNear: true, prefetch: true, ...options });
    open = h;
    h.orchestrator.start();
    return h;
}

const FUN_QUESTION = 'Anything you want to do today in San Francisco?';
const NEAR = { lat: 37.87, lng: -122.27 };

function categoriesReply(): PlanReply {
    return {
        answer_mode: 'pick',
        options: [
            reply({ kind: 'category', label: 'Nature', text: 'Parks and gardens.', query: 'hiking trails in San Francisco' }),
            reply({ kind: 'category', label: 'Fun', text: 'Something fun.', query: 'arcades and museums in San Francisco' }),
            reply({ kind: 'category', label: 'Thrill', text: 'Something thrilling.', query: 'thrilling activities in San Francisco' }),
            reply({ kind: 'category', label: 'Something else', text: 'Something else.', query: 'things to do in San Francisco today' }),
        ],
    };
}

function placesReply(): PlanReply {
    return {
        answer_mode: 'pick',
        options: [
            reply({ label: 'Pharmacy 1', text: "Let's go to Pharmacy 1!", sources: ['w1'], tone: 'warm' }),
            reply({ label: 'Pharmacy 2', text: 'How about Pharmacy 2?', sources: ['w2'], tone: 'calm' }),
        ],
    };
}

const PREFETCHED = [
    { kind: 'maps', query: 'hiking trails', near: NEAR },
    { kind: 'maps', query: 'arcades and museums', near: NEAR },
    { kind: 'maps', query: 'thrilling activities', near: NEAR },
];

/** Runs the categories job for `parent` and waits until it is done. */
async function offerCategories(h: Harness, parent: bigint): Promise<void> {
    h.api.reply(categoriesReply());
    const jobId = h.db.addFollowUpJob({ kind: 'categories', questionText: FUN_QUESTION, parentQuestionId: parent });
    await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'categories published');
}

const searchEvents = (h: Harness, jobId: bigint) => h.db.events.filter((e) => e.stage === 'search' && e.jobId === jobId);
const counts = (json: string): Record<string, unknown> => JSON.parse(json) as Record<string, unknown>;
const logged = (h: Harness, message: string) => h.log.entries.filter((e) => e.message === message);

describe('search prefetch: the categories job', () => {
    it('starts one search per category, the first three, as the categories are published, and writes no search event', async () => {
        const h = start();
        await offerCategories(h, 100n);
        assert.deepEqual(h.search.calls, PREFETCHED, 'short place words, near the venue, the fourth category not prefetched');
        assert.equal(h.db.events.filter((e) => e.stage === 'search').length, 0, 'nothing on the categories job or the question');
        assert.equal(h.deps.prefetches?.size, 3);
        assert.ok(logged(h, 'categories published').some((e) => e.fields.prefetched === 3));
        // The planner is told the maps search is centred on the venue.
        assert.match(h.api.userMessage(), /Place searches look around where the person is now, so each query names only what to find, never a city\./);
    });

    it('starts nothing when prefetch is off, without web search consent, or without a search', async () => {
        const off = start({ prefetch: false });
        await offerCategories(off, 101n);
        assert.equal(off.search.calls.length, 0);
        await off.orchestrator.stop(1_000);

        const noConsent = start();
        noConsent.db.consent.webSearch = false;
        await offerCategories(noConsent, 102n);
        assert.equal(noConsent.search.calls.length, 0, 'the module shows no web search consent');
        await noConsent.orchestrator.stop(1_000);

        const noSearch = start({ search: false });
        await offerCategories(noSearch, 103n);
        assert.equal(noSearch.search.calls.length, 0);
    });
});

describe('search prefetch: the category search job', () => {
    it('uses the prefetched run: no second search, the run\'s own time on its event, and prefetched in its counts', async () => {
        let t = 0;
        const h = start({ clock: () => t });
        const release = h.search.hold();
        await offerCategories(h, 110n);
        h.search.rows = [placeRow(1), placeRow(2)];
        t = 1_500;
        release();
        await waitFor(() => logged(h, 'search prefetch done').length === 3, 3_000, 'prefetches done');

        h.api.reply(placesReply());
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 110n, category: 'Fun' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.search.calls.length, 3, 'the picked category was searched once in all');
        const events = searchEvents(h, jobId);
        assert.deepEqual(events.map((e) => [e.status, e.detail]), [['started', 'maps'], ['ok', 'maps']]);
        assert.equal(events[1]?.ms, 1_500, 'the time the prefetched run took');
        assert.deepEqual(counts(events[1]?.countsJson ?? '{}'), { needsWeb: true, searches: 1, prefetched: true, rowCount: 2, partial: false, waitMs: 0 });
        assert.ok(h.web.indexed.has(`q${h.db.questionOf(jobId)}`), 'its rows are indexed as usual');
        const published = h.db.publishes.at(-1);
        assert.deepEqual(published?.options.map((o) => [o.label, o.provenance, o.sources[0]?.placeId]), [
            ['Pharmacy 1', 'maps', 'place1'],
            ['Pharmacy 2', 'maps', 'place2'],
        ]);
        assert.ok(logged(h, 'category search').some((e) => e.fields.prefetched === true));
    });

    it('waits for a prefetched run that is still on its way', async () => {
        const h = start();
        const release = h.search.hold();
        await offerCategories(h, 111n);
        h.api.reply(placesReply());
        h.search.rows = [placeRow(1), placeRow(2)];
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 111n, category: 'Nature' });
        await waitFor(() => searchEvents(h, jobId).some((e) => e.status === 'started'), 3_000, 'search started');
        assert.equal(h.db.publishes.filter((p) => p.jobId === jobId).length, 0);
        release();
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.search.calls.length, 3);
        assert.deepEqual(searchEvents(h, jobId).map((e) => [e.status, e.detail]), [['started', 'maps'], ['ok', 'maps']]);
    });

    it('searches again when the prefetched run had already failed', async () => {
        const h = start();
        h.search.error = new Error('maps down');
        await offerCategories(h, 112n);
        await waitFor(() => logged(h, 'search prefetch done').length === 3, 3_000, 'prefetches done');
        h.search.error = null;
        h.search.rows = [placeRow(1), placeRow(2)];
        h.api.reply(placesReply());
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 112n, category: 'Nature' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(h.search.calls.at(-1), { kind: 'maps', query: 'hiking trails', near: NEAR });
        assert.equal(h.search.calls.length, 4);
        const events = searchEvents(h, jobId);
        assert.deepEqual(events.map((e) => [e.status, e.detail]), [['started', 'maps'], ['ok', 'maps']]);
        assert.equal(counts(events[1]?.countsJson ?? '{}').prefetched, undefined, 'a fresh search, not the prefetch');
        assert.ok(logged(h, 'search prefetch dropped unused').some((e) => e.fields.why === 'failed' && e.fields.unused === 1));
    });

    it('reports a prefetched run that fails while the job waits, and does not search again (D26: one search per pick)', async () => {
        const h = start();
        const places = h.search.places.bind(h.search);
        let fail: (error: Error) => void = () => undefined;
        const failing = new Promise<SearchResult>((_resolve, reject) => (fail = reject));
        let held = 0;
        h.search.places = (query, options) => {
            if (held >= 3) return places(query, options);
            held += 1;
            h.search.calls.push({ kind: 'maps', query });
            return failing;
        };
        await offerCategories(h, 113n);
        h.search.rows = [placeRow(1), placeRow(2)];
        h.api.reply({ answer_mode: 'pick', options: [reply({ label: 'Not sure', text: 'Not sure, honestly.', tone: 'calm' }), reply({ label: 'Ask later', text: 'Ask me later.', tone: 'warm' })] });
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 113n, category: 'Thrill' });
        await waitFor(() => searchEvents(h, jobId).some((e) => e.status === 'started'), 3_000, 'search started');
        fail(new Error('maps down'));
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        const events = searchEvents(h, jobId);
        assert.deepEqual(events.map((e) => [e.status, e.detail]), [
            ['started', 'maps'],
            ['error', 'maps error'],
        ]);
        assert.equal(counts(events[1]?.countsJson ?? '{}').prefetched, true);
        assert.equal(h.search.calls.length, 3, 'no second search for the pick');
        assert.ok(logged(h, 'the prefetched search failed; planning without outside facts (one search per pick)').length === 1);
    });

    it('uses the preloaded rows when the prefetched run fails while the job waits, with no second search (D26)', async () => {
        const h = start({ cacheGraceMs: 5_000 });
        const preloaded = { ...placeRow(7), fetchedAt: '2026-10-25T08:00:00.000Z' };
        const cache = new SearchCache(h.db, h.log, () => performance.now(), {
            searches: [{ kind: 'maps', query: 'park' }],
            timeoutMs: 1_000,
            refreshMs: 0,
            send: async (planned) => ({ rows: [preloaded], ms: 1, query: planned.query, partial: false }),
        });
        h.deps.retrieval.cache = cache;
        await cache.refresh();
        const places = h.search.places.bind(h.search);
        let fail: (error: Error) => void = () => undefined;
        const failing = new Promise<SearchResult>((_resolve, reject) => (fail = reject));
        let held = 0;
        h.search.places = (query, options) => {
            if (held >= 3) return places(query, options);
            held += 1;
            h.search.calls.push({ kind: 'maps', query });
            return failing;
        };
        await offerCategories(h, 116n);
        // "Nature" went out as "hiking trails", whose place key is park.
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 116n, category: 'Nature' });
        await waitFor(() => searchEvents(h, jobId).some((e) => e.status === 'started'), 3_000, 'search started');
        fail(new Error('maps down'));
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        cache.close();
        const events = searchEvents(h, jobId);
        assert.deepEqual(events.map((e) => [e.status, e.detail]), [['started', 'maps'], ['ok', 'maps cached']]);
        const c = counts(events[1]?.countsJson ?? '{}');
        assert.equal(c.prefetched, true);
        assert.equal(c.cached, true);
        assert.equal(c.liveFailed, true);
        assert.equal(h.search.calls.length, 3, 'no second search');
        assert.deepEqual(h.db.publishes.at(-1)?.options.map((o) => [o.sources[0]?.placeId, o.sources[0]?.fetchedAt]), [['place7', '2026-10-25T08:00:00.000Z']]);
    });

    it('searches again once a prefetched run is past its time to live, and counts the unused ones', async () => {
        let t = 0;
        const h = start({ clock: () => t });
        await offerCategories(h, 114n);
        await waitFor(() => logged(h, 'search prefetch done').length === 3, 3_000, 'prefetches done');
        t = PREFETCH_LIMITS.ttlMs + 1;
        h.search.rows = [placeRow(1)];
        h.api.reply(placesReply());
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 114n, category: 'Fun' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.search.calls.length, 4);
        assert.ok(logged(h, 'search prefetch dropped unused').some((e) => e.fields.why === 'expired' && e.fields.unused === 3));
        assert.equal(h.deps.prefetches?.size, 0);
    });

    it('uses no prefetched row once web search consent was revoked between the prefetch and the pick', async () => {
        const h = start();
        await offerCategories(h, 115n);
        h.db.revokeConsent('web_search');
        await waitFor(() => h.deps.prefetches?.size === 0, 3_000, 'the book emptied');
        assert.ok(logged(h, 'search prefetch dropped unused').some((e) => e.fields.why === 'consent' && e.fields.unused === 3));
        // The pick without consent is refused, as before.
        const refused = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 115n, category: 'Fun' });
        await waitFor(() => h.db.job(refused)?.status === 'failed');
        assert.equal(h.db.publishes.filter((p) => p.jobId === refused).length, 0);

        // Given again before the pick: the pick searches for itself, under the consent it has now.
        h.db.grantConsent('web_search');
        h.search.rows = [placeRow(1), placeRow(2)];
        h.api.reply(placesReply());
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 115n, category: 'Fun' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.search.calls.length, 4);
        assert.equal(counts(searchEvents(h, jobId)[1]?.countsJson ?? '{}').prefetched, undefined);
    });

    it('uses no row of a prefetched run when consent is revoked while the job waits for it', async () => {
        const h = start();
        const release = h.search.hold();
        await offerCategories(h, 116n);
        h.search.rows = [placeRow(1), placeRow(2)];
        h.api.reply({
            answer_mode: 'pick',
            options: [reply({ label: 'Not sure', text: 'Not sure, can we check later?', tone: 'calm' }), reply({ label: 'Never mind', text: 'Never mind, thanks.', tone: 'warm' })],
        });
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 116n, category: 'Fun' });
        await waitFor(() => searchEvents(h, jobId).some((e) => e.status === 'started'), 3_000, 'search started');
        h.db.revokeConsent('web_search');
        release();
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.search.calls.length, 3, 'no search after the revocation');
        assert.equal(h.web.indexed.size, 0, 'nothing indexed');
        assert.match(h.api.userMessage(1), /Web results: none\./);
        assert.ok(h.db.publishes.at(-1)?.options.every((o) => o.sources.length === 0));
    });

    it('uses no row when the job\'s own web search flag is cleared while it waits, even if the run comes back fine', async () => {
        const h = start();
        const release = h.search.hold();
        await offerCategories(h, 118n);
        h.search.rows = [placeRow(1), placeRow(2)];
        h.api.reply({
            answer_mode: 'pick',
            options: [reply({ label: 'Not sure', text: 'Not sure, can we check later?', tone: 'calm' }), reply({ label: 'Never mind', text: 'Never mind, thanks.', tone: 'warm' })],
        });
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 118n, category: 'Fun' });
        await waitFor(() => searchEvents(h, jobId).some((e) => e.status === 'started'), 3_000, 'search started');
        // Only the job's flag (as the module's stopUncovered clears it), with no change the prefetch book would hear.
        const job = h.db.job(jobId);
        assert.ok(job);
        job.webSearchAllowed = false;
        release();
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.ok(logged(h, 'search prefetch done').every((e) => e.fields.ok === true), 'the run itself came back fine');
        assert.equal(h.web.indexed.size, 0, 'nothing indexed');
        assert.match(h.api.userMessage(1), /Web results: none\./);
        assert.equal(h.search.calls.length, 3);
    });

    it('stops waiting when the job is aborted, and leaves the run for another attempt', async () => {
        const h = start();
        const release = h.search.hold();
        await offerCategories(h, 117n);
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 117n, category: 'Nature' });
        await waitFor(() => searchEvents(h, jobId).some((e) => e.status === 'started'), 3_000, 'search started');
        h.db.cancelJob(jobId);
        await waitFor(() => logged(h, 'job dropped: it belongs to another attempt now').some((e) => e.fields.job === jobId), 3_000, 'job dropped');
        assert.equal(h.db.publishes.filter((p) => p.jobId === jobId).length, 0);
        assert.equal(h.api.calls.length, 1, 'only the categories plan: the search job never planned');
        assert.equal(h.deps.prefetches?.size, 3, 'the runs go on');
        release();
        assert.equal(h.search.calls.length, 3);
    });
});

describe('search prefetch: the book', () => {
    const result = (query: string): SearchResult => ({ rows: [], ms: 1, query, partial: false });
    const plan = (query: string): PlannedSearch => ({ kind: 'maps', query });

    it('sends at most three searches per question, never the same words twice, and only under consent and while the job is live', () => {
        const db = new MemoryDb();
        const book = new SearchPrefetch(db, recordingLogger(), () => 0);
        const sent: string[] = [];
        const send = async (p: PlannedSearch) => (sent.push(p.query), result(p.query));
        const plans = ['parks', 'Parks ', 'cafes', 'museums', 'bakeries'].map(plan);
        assert.equal(book.start(1n, plans, 5_000, () => true, send), 3);
        assert.deepEqual(sent, ['parks', 'cafes', 'museums']);
        assert.equal(book.start(1n, plans, 5_000, () => true, send), 0, 'a second attempt reuses the runs already going');
        assert.equal(book.start(2n, plans, 5_000, () => false, send), 0, 'the categories job is no longer this attempt\'s');
        db.consent.webSearch = false;
        assert.equal(book.start(3n, plans, 5_000, () => true, send), 0, 'no web search consent');
        assert.equal(sent.length, 3);
        assert.equal(book.take(1n, plan('parks')), null, 'not handed over without consent');
    });

    it('hands a run over only in the session and the views it went out under', () => {
        const db = new MemoryDb();
        const book = new SearchPrefetch(db, recordingLogger(), () => 0);
        book.start(1n, [plan('parks'), plan('cafes')], 5_000, () => true, async (p) => result(p.query));
        assert.equal(book.take(1n, plan('PARKS'))?.kind, 'maps', 'found by its words, whatever their case');
        assert.equal(book.take(1n, { kind: 'web', query: 'parks' }), null, 'a web search is another run');
        assert.equal(book.take(9n, plan('parks')), null, 'another question');
        db.sessionId = 2n;
        assert.equal(book.take(1n, plan('cafes')), null, 'another session');
    });

    it('keeps at most maxEntries runs, dropping the oldest', () => {
        const db = new MemoryDb();
        const log = recordingLogger();
        const book = new SearchPrefetch(db, log, () => 0, { ...PREFETCH_LIMITS, maxEntries: 2 });
        book.start(1n, [plan('a'), plan('b'), plan('c')], 5_000, () => true, async (p) => result(p.query));
        assert.equal(book.size, 2);
        assert.equal(book.take(1n, plan('a')), null);
        assert.ok(book.take(1n, plan('c')));
        assert.ok(log.entries.some((e) => e.message === 'search prefetch dropped unused' && e.fields.why === 'full'));
    });
});

describe('search prefetch: the search words', () => {
    it('keeps a maps query short: what to find, with no city and no time', () => {
        assert.equal(shortPlaceQuery('parks and gardens in San Francisco'), 'parks and gardens');
        assert.equal(shortPlaceQuery('things to do today in San Francisco'), 'things to do');
        assert.equal(shortPlaceQuery('coffee near Fort Mason'), 'coffee');
        assert.equal(shortPlaceQuery('quiet cafe'), 'quiet cafe');
        assert.equal(shortPlaceQuery('park with a view'), 'park with a view');
        // Still long, or the question itself: the place query rules.
        assert.equal(shortPlaceQuery('best quiet coffee shops with outdoor seating and wifi'), 'coffee shop');
        assert.equal(shortPlaceQuery('Anything you want to do today in San Francisco'), 'tourist attraction');
    });

    it('plans the maps search near the venue for a place question, and the web search with the words as they are', () => {
        assert.deepEqual(categorySearch({ placesNear: NEAR }, 'parks in San Francisco', true), { kind: 'maps', query: 'parks' });
        assert.deepEqual(categorySearch({ placesNear: NEAR }, 'Giants score last night', false), { kind: 'web', query: 'Giants score last night' });
        assert.deepEqual(categorySearch({ placesNear: null }, 'parks in San Francisco', true), { kind: 'web', query: 'parks in San Francisco' });
    });

    it('asks the planner for short category words, and names no city when the maps search is centred on the venue', () => {
        assert.match(SYSTEM_PROMPT, /2 to 5 words naming what to find, for example "quiet cafe" or "park with a view"/);
        const input: PlanInput = {
            question: FUN_QUESTION,
            origin: 'partner',
            menuItem: 'none',
            history: [],
            memory: [],
            web: [],
            forms: [],
            contacts: [],
            recentErrand: null,
            search: 'none',
            task: 'categories',
            maxOptions: 4,
            nowMs: Date.parse('2026-10-24T20:05:00Z'),
            timeZone: 'America/Los_Angeles',
        };
        assert.doesNotMatch(buildUserMessage(input), /never a city/);
        assert.match(buildUserMessage({ ...input, placesNear: true }), /each query names only what to find, never a city\./);
    });

    it('is on by default, and off with AGENT_SEARCH_PREFETCH=off', () => {
        const token = join(tmpdir(), 'say-when-prefetch-test-token');
        assert.equal(readConfig({}, token, () => true).config.speed.prefetch, true);
        assert.equal(readConfig({ AGENT_SEARCH_PREFETCH: 'off' }, token, () => true).config.speed.prefetch, false);
        assert.ok(readConfig({ AGENT_SEARCH_PREFETCH: 'maybe' }, token, () => true).problems.includes('AGENT_SEARCH_PREFETCH must be on or off.'));
    });
});
