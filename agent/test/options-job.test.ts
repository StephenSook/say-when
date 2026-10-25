import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';
import { ApifyHttpError } from '@say-when/apify-client';

import { DETAIL_PATTERN } from '../src/contract.js';
import { DEFAULT_PLACE_QUERY, placeQuery } from '../src/retrieval.js';
import { fourOptions, harness, LEON, memoryHit, placeRow, SECRET, settle, waitFor, webRow, yesNo, type Harness } from './helpers.js';

let open: Harness | null = null;
afterEach(async () => {
    await open?.orchestrator.stop(1_000);
    open = null;
});

function start(h: Harness): Harness {
    open = h;
    h.orchestrator.start();
    return h;
}

const finalPublish = (h: Harness) => h.db.publishes.find((p) => p.final);
const eventsOf = (h: Harness, stage: string) => h.db.events.filter((e) => e.stage === stage);

describe('the Options job', () => {
    it('publishes up to four options with distinct tones, sources and memory refs', async () => {
        const h = start(harness());
        h.memory.recallResult = { hits: [memoryHit(1)], instant: [], mossMs: 3, wallMs: 4 };
        h.api.replyWith(() => fourOptions([['w1'], ['m1'], [], ['w2']]));
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'job done');
        const published = finalPublish(h);
        assert.ok(published);
        assert.equal(published.answerMode, 'pick');
        assert.equal(published.options.length, 4);
        assert.equal(new Set(published.options.map((o) => o.tone)).size, 4);
        assert.ok(published.options.every((o) => o.text.length > 0 && o.text.length <= 200));
        const withWeb = published.options.find((o) => o.sources.length > 0);
        assert.equal(withWeb?.sources[0]?.url, 'https://example.com/page-1');
        assert.equal(withWeb?.provenance, 'web');
        const withMemory = published.options.find((o) => o.memoryRefs.length > 0);
        assert.deepEqual(withMemory?.memoryRefs, [memoryHit(1).id]);
        assert.equal(withMemory?.provenance, 'memory');
        assert.equal(h.web.forgotten.length, 1, 'the web passages are forgotten once the question is answered');
    });

    it('recalls memory before it searches (memory first)', async () => {
        const h = start(harness());
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        const recall = h.trace.indexOf('memory.recall');
        const search = h.trace.indexOf('search.web');
        assert.ok(recall >= 0 && search > recall, `order was ${h.trace.steps.join(', ')}`);
        assert.ok(h.trace.indexOf('web.index') > search);
        assert.ok(h.trace.indexOf('claude.create') > h.trace.indexOf('web.search'));
        const firstRetrieve = h.db.events.findIndex((e) => e.stage === 'retrieve');
        const firstSearch = h.db.events.findIndex((e) => e.stage === 'search');
        assert.ok(firstRetrieve < firstSearch, 'the memory event comes before the search event');
    });

    it('never searches when the question needs no outside facts (D8)', async () => {
        const h = start(harness());
        h.api.reply(yesNo());
        const jobId = h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.search.calls.length, 0);
        assert.equal(h.web.indexed.size, 0);
        const search = eventsOf(h, 'search');
        assert.equal(search.length, 1);
        assert.equal(search[0]?.detail, 'skipped');
        assert.deepEqual(JSON.parse(search[0]?.countsJson ?? '{}'), { needsWeb: false, searches: 0, rowCount: 0 });
        assert.match(h.api.userMessage(), /No web search was needed for this question\./);
        assert.match(h.api.userMessage(), /Web results: none\./);
    });

    it('answers a yes or no question with exactly two options, yes first, in the planner order', async () => {
        const h = start(harness());
        h.memory.order = ['o2', 'o1'];
        h.api.reply(yesNo());
        const jobId = h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        const published = finalPublish(h);
        assert.equal(published?.answerMode, 'yes_no');
        assert.deepEqual(
            published?.options.map((o) => o.text),
            ['Yes, a little tired.', 'No, I am fine.'],
        );
        assert.equal(h.memory.ranked.length, 0, 'yes or no answers are never reordered');
    });

    it('orders pick options by memory affinity', async () => {
        const h = start(harness());
        h.memory.order = ['o4', 'o3', 'o2', 'o1'];
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Want to grab lunch after this?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(
            finalPublish(h)?.options.map((o) => o.text),
            ['Only somewhere quiet.', 'Not today, thanks.', 'Maybe later today.', 'Yes, let us get lunch.'],
        );
    });

    it('reads the person\'s own past replies while the search runs (memory-first options)', async () => {
        const h = start(harness());
        h.memory.recallResult = {
            hits: [memoryHit(1, { reply: 'Sure, somewhere quiet.' }), memoryHit(2, { reply: 'Not today.' })],
            instant: ['Sure, somewhere quiet.', 'Not today.'],
            mossMs: 2,
            wallMs: 3,
        };
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Want to grab lunch nearby?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.db.publishes.length, 2);
        const early = h.db.publishes[0];
        assert.equal(early?.final, false);
        assert.deepEqual(
            early?.options.map((o) => [o.text, o.provenance]),
            [
                ['Sure, somewhere quiet.', 'memory'],
                ['Not today.', 'memory'],
            ],
        );
        assert.equal(new Set(early?.options.map((o) => o.tone)).size, 2);
        assert.equal(h.db.publishes[1]?.final, true);
    });

    it('does not publish memory-first options for a question that reads like yes or no', async () => {
        const h = start(harness());
        h.memory.recallResult = { hits: [], instant: ['Sure.', 'Not today.'], mossMs: 2, wallMs: 3 };
        h.api.reply(yesNo());
        const jobId = h.db.addOptionsJob({ questionText: 'Is the cafe on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.db.publishes.filter((p) => !p.final).length, 0);
    });

    it('searches places near the venue with a short query when it knows where the venue is', async () => {
        const h = start(harness({ placesNear: true }));
        h.search.rows = [placeRow(1), placeRow(2)];
        h.api.reply(fourOptions([['w1'], [], [], []]));
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(h.search.calls, [{ kind: 'maps', query: 'pharmacy', near: { lat: 37.87, lng: -122.27 } }]);
        const option = finalPublish(h)?.options.find((o) => o.sources.length > 0);
        assert.equal(option?.provenance, 'maps');
        assert.equal(option?.sources[0]?.placeId, 'place1');
    });

    it('drops a source whose link the module would refuse, instead of failing the publish', async () => {
        const h = start(harness());
        h.search.rows = [webRow(1, { url: `https://example.com/${'x'.repeat(600)}` }), webRow(2)];
        h.api.reply(fourOptions([['w1'], ['w2'], [], []]));
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        const sources = finalPublish(h)?.options.flatMap((o) => o.sources) ?? [];
        assert.ok(sources.every((s) => (s.url ?? '').length <= 500));
        assert.equal(sources.length, 1);
    });

    it('plans without web facts when there is no consent for web search, and writes no search event', async () => {
        const h = start(harness());
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?', webSearchAllowed: false });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.search.calls.length, 0);
        assert.equal(eventsOf(h, 'search').length, 0);
        assert.match(h.api.userMessage(), /Web search is turned off/);
    });

    it('keeps going when the search fails, and says so on the dashboard', async () => {
        const h = start(harness());
        h.search.error = new ApifyHttpError({ service: 'rag-web-browser', endpoint: 'GET rag-web-browser.apify.actor/search', kind: 'http', status: 502, attempts: 3 });
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        const failed = eventsOf(h, 'search').find((e) => e.status === 'error');
        assert.equal(failed?.detail, 'web http 502');
        assert.match(h.api.userMessage(), /The web search failed/);
    });

    it('stops a search that runs past its deadline', async () => {
        const h = start(harness({ searchTimeoutMs: 60 }));
        h.search.hang = true;
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(eventsOf(h, 'search').find((e) => e.status === 'error')?.detail, 'web timeout');
    });

    it('plans from the rows when Moss is closed', async () => {
        const h = start(harness());
        h.memory.open = false;
        h.api.reply(fourOptions([['w1'], [], [], []]));
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(eventsOf(h, 'retrieve')[0]?.detail, 'moss closed');
        assert.equal(h.web.indexed.size, 0);
        assert.match(h.api.userMessage(), /^w1 \(web page/m);
        assert.equal(finalPublish(h)?.options[0]?.sources[0]?.url, 'https://example.com/page-1');
    });

    it('reports a planner failure with agent_fail and a plan error event', async () => {
        const h = start(harness());
        h.api.reply({ answer_mode: 'pick', options: [] });
        const jobId = h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await waitFor(() => h.db.job(jobId)?.status === 'failed');
        const fail = h.db.applied.find((a) => a.name === 'agentFail')?.args as { reasonCode: string; reason: string };
        assert.equal(fail.reasonCode, 'planner_invalid_reply');
        assert.equal(fail.reason, 'I could not write options. Please ask again.');
        assert.equal(eventsOf(h, 'plan').find((e) => e.status === 'error')?.detail, 'claude invalid reply');
    });

    it('writes every finished step with its time and numbers', async () => {
        const h = start(harness());
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        for (const event of h.db.events) {
            assert.match(event.detail, DETAIL_PATTERN);
            if (event.status === 'started') assert.equal(event.ms, null);
            else assert.ok(Number.isInteger(event.ms) && (event.ms ?? -1) >= 0, `${event.stage} ${event.status} has no ms`);
        }
        const counts = (stage: string, detail: string) => JSON.parse(h.db.events.find((e) => e.stage === stage && e.status === 'ok' && e.detail === detail)?.countsJson ?? 'null');
        assert.equal(counts('search', 'web').rowCount, 2);
        assert.equal(counts('retrieve', 'memory recall').hitCount, 1);
        assert.equal(counts('retrieve', 'web index').chunks, 4);
        assert.equal(counts('retrieve', 'web search').hitCount, 3);
        const plan = counts('plan', 'claude');
        assert.equal(plan.optionCount, 4);
        assert.ok(Number.isInteger(plan.claudeMs));
        assert.equal(plan.inputTokens, 900);
        // Every write carries a unique event key, so a retried write is harmless.
        assert.equal(new Set(h.db.events.map((e) => e.eventKey)).size, h.db.events.length);
    });

    it('drops its work when the lease lapsed and another attempt owns the job', async () => {
        const h = start(harness());
        h.api.hang = true;
        const jobId = h.db.addOptionsJob({ questionText: 'Want to grab lunch after this?' });
        await waitFor(() => h.api.calls.length === 1, 3_000, 'planner called');
        h.db.expireLease(jobId);
        await waitFor(() => h.db.job(jobId)?.status === 'claimed' && h.db.job(jobId)?.attempt === 2, 3_000, 'second attempt');
        await waitFor(() => h.api.calls.length === 2, 3_000, 'second attempt planner call');
        assert.ok(h.log.entries.some((e) => e.message.includes('stopping its work')));
        assert.equal(h.db.applied.filter((a) => a.name === 'agentFail').length, 0);
        h.api.hang = false;
    });

    it('stops at once when the question is cancelled, and does not report a failure', async () => {
        const h = start(harness());
        h.search.hang = true;
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.search.calls.length === 1, 3_000, 'search started');
        h.db.cancelJob(jobId);
        await waitFor(() => h.orchestrator.busy === 0, 3_000, 'job stopped');
        assert.equal(h.api.calls.length, 0);
        assert.equal(h.db.publishes.length, 0);
        assert.equal(h.db.attempted.filter((a) => a.name === 'agentFail').length, 0);
    });

    it('verifies a claim whose reply was lost instead of claiming twice', async () => {
        const h = harness();
        h.db.failNext('agentClaim', 'unknown_result', { applied: true });
        h.api.reply(yesNo());
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.db.job(jobId)?.attempt, 1);
        assert.equal(h.db.attempted.filter((a) => a.name === 'agentClaim').length, 1);
    });

    it('sends a write again once the connection is back', async () => {
        const h = harness();
        h.db.failNext('agentPublishOptions', 'disconnected');
        h.api.reply(yesNo());
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.db.publishes.length, 1);
    });

    it('prepares a call option with the Dialer when a request went out in the last ten minutes', async () => {
        const h = start(harness({ contacts: [LEON] }));
        h.api.reply({
            answer_mode: 'pick',
            options: [
                { text: 'Not now.', kind: 'reply', tone: 'calm', laugh: false, sources: [], errand: null, call: null },
                { text: 'Call Leonora about it.', kind: 'call', tone: 'warm', laugh: false, sources: [], errand: null, call: { contact_id: 'leon' } },
            ],
        });
        const jobId = h.db.addOptionsJob({
            questionText: 'Call',
            origin: 'menu',
            menuItem: 'call',
            recentErrandTitle: 'Care team request',
            recentErrandSentAtMs: Date.now() - 60_000,
        });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.search.calls.length, 0, 'menu turns never search');
        assert.equal(h.dialer.prepared.length, 1);
        assert.equal(h.dialer.prepared[0]?.errand.title, 'Care team request');
        const call = finalPublish(h)?.options.find((o) => o.kind === 'call');
        const action = JSON.parse(call?.actionJson ?? '{}');
        assert.equal(action.digest, 'fedcba9876543210');
        assert.equal(action.contactId, 'leon');
        assert.match(action.requestId, /^[A-Za-z0-9_-]{1,64}$/);
    });

    it('offers no call when the recent request is older than ten minutes', async () => {
        const h = start(harness({ contacts: [LEON] }));
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Call', origin: 'menu', menuItem: 'call', recentErrandTitle: 'Care team request', recentErrandSentAtMs: Date.now() - 11 * 60_000 });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.match(h.api.userMessage(), /Contacts for a call: none/);
        assert.equal(h.dialer.prepared.length, 0);
    });

    it('drops a call option the Dialer refuses, keeps the replies, and fills back up to two choices', async () => {
        const h = start(harness({ contacts: [LEON] }));
        h.dialer.refusePrepare = true;
        h.api.reply({
            answer_mode: 'pick',
            options: [
                { text: 'Not now.', kind: 'reply', tone: 'calm', laugh: false, sources: [], errand: null, call: null },
                { text: 'Call Leonora about it.', kind: 'call', tone: 'warm', laugh: false, sources: [], errand: null, call: { contact_id: 'leon' } },
            ],
        });
        const jobId = h.db.addOptionsJob({ questionText: 'Call', origin: 'menu', menuItem: 'call', recentErrandTitle: 'Care team request', recentErrandSentAtMs: Date.now() - 60_000 });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        // Never a single answer (PLAN D22): a stock reply in a tone not already used takes the call's place.
        assert.deepEqual(
            finalPublish(h)?.options.map((o) => [o.kind, o.text, o.tone, o.provenance]),
            [
                ['reply', 'Not now.', 'calm', 'model'],
                ['reply', 'Ask me again later.', 'neutral', 'stock'],
            ],
        );
        assert.equal(JSON.parse(h.db.events.find((e) => e.detail === 'claude' && e.status === 'ok')?.countsJson ?? '{}').droppedCalls, 1);
    });
});

describe('conversation context', () => {
    it('gives the planner the recent turns with the same partner only', async () => {
        const h = start(harness());
        const alex = 'a1'.repeat(32);
        const sam = 'b2'.repeat(32);
        const remember = h.db.addRememberJob({ questionText: 'Want water?', replyText: 'Yes please, cold.', askedBy: alex });
        await waitFor(() => h.db.job(remember)?.status === 'done');
        h.api.reply(yesNo()).reply(yesNo());
        const fromAlex = h.db.addOptionsJob({ questionText: 'Are you tired?', askedBy: alex });
        await waitFor(() => h.db.job(fromAlex)?.status === 'done');
        const fromSam = h.db.addOptionsJob({ questionText: 'Are you cold?', askedBy: sam });
        await waitFor(() => h.db.job(fromSam)?.status === 'done');
        assert.match(h.api.userMessage(0), /Person: "Yes please, cold\."/);
        assert.doesNotMatch(h.api.userMessage(1), /Yes please, cold|Are you tired/);
    });
});

describe('the Remember job', () => {
    it('writes the spoken reply into memory for the partner who asked', async () => {
        const h = start(harness());
        const jobId = h.db.addRememberJob({ questionText: 'Want water?', replyText: 'Yes please.', askedBy: 'c'.repeat(64) });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(h.memory.written, [{ question: 'Want water?', reply: 'Yes please.', partnerId: 'c'.repeat(64), shareable: false }]);
        const done = h.db.applied.find((a) => a.name === 'agentDone')?.args as { countsJson: string };
        assert.deepEqual(JSON.parse(done.countsJson), { written: 1, added: 1, updated: 0 });
    });

    it('finishes without writing when Moss is closed', async () => {
        const h = start(harness());
        h.memory.open = false;
        const jobId = h.db.addRememberJob({ questionText: 'Want water?', replyText: 'Yes please.' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.memory.written.length, 0);
        const done = h.db.applied.find((a) => a.name === 'agentDone')?.args as { countsJson: string };
        assert.deepEqual(JSON.parse(done.countsJson), { written: 0, mossOpen: false });
    });
});

describe('consent revoked while a job runs', () => {
    /** Revokes `scope` right after the job writes the event with `detail` and `status`, as the owner might. */
    function revokeAt(h: Harness, scope: 'web_search' | 'memory', detail: string, status: string): void {
        const realCall = h.db.call.bind(h.db);
        h.db.call = (async (name: string, args: unknown) => {
            await realCall(name as never, args as never);
            const a = args as { detail?: string; status?: string };
            if (name === 'agentProgress' && a.detail === detail && a.status === status) h.db.revokeConsent(scope);
        }) as typeof h.db.call;
    }

    it('stops searching the moment web search consent is revoked', async () => {
        const h = harness();
        h.api.reply(fourOptions());
        revokeAt(h, 'web_search', 'memory recall', 'ok');
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.search.calls.length, 0, 'no search after the revocation');
        assert.equal(eventsOf(h, 'search').length, 0);
        assert.match(h.api.userMessage(), /Web results: none\./);
    });

    it('searches as usual when nothing is revoked (the control for the test above)', async () => {
        const h = start(harness());
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.search.calls.length, 1);
    });

    /** Two past replies, so a question that does not read like yes or no gets memory-first options. */
    function twoReplies(h: Harness): void {
        h.memory.recallResult = {
            hits: [memoryHit(1, { reply: 'Sure, somewhere quiet.' }), memoryHit(2, { reply: 'Not today.' })],
            instant: ['Sure, somewhere quiet.', 'Not today.'],
            mossMs: 2,
            wallMs: 3,
        };
    }

    it('sends no memory to Claude and publishes no memory options once memory consent is revoked', async () => {
        const h = harness();
        twoReplies(h);
        h.api.reply(fourOptions());
        revokeAt(h, 'memory', 'memory recall', 'ok');
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Want to grab lunch nearby?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.memory.recalls.length, 1, 'the recall ran before the revocation');
        assert.match(h.api.userMessage(), /Memory items: none\./);
        assert.ok(!h.api.userMessage().includes(SECRET.privateMemory));
        assert.equal(h.db.publishes.filter((p) => !p.final).length, 0, 'no memory-first options');
        assert.equal(h.memory.ranked.length, 0, 'no memory ranking');
    });

    it('never sends the question out when web consent is revoked while the search step starts', async () => {
        const h = harness();
        h.api.reply(fourOptions());
        revokeAt(h, 'web_search', 'web', 'started');
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.search.calls.length, 0);
        assert.match(h.api.userMessage(), /Web results: none\./);
    });

    it('uses nothing from memory when memory consent is revoked while the recall starts', async () => {
        const h = harness();
        h.api.reply(fourOptions());
        revokeAt(h, 'memory', 'memory recall', 'started');
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.memory.recalls.length, 0, 'Moss was not asked');
        const recall = h.db.events.find((e) => e.detail === 'memory recall' && e.status === 'ok');
        assert.equal(recall?.payloadJson, '', 'no memory hits are shown');
        assert.ok(!h.api.userMessage().includes(SECRET.privateMemory));
    });

    it('publishes no memory options when memory consent is revoked while that step starts', async () => {
        const h = harness();
        twoReplies(h);
        h.api.reply(fourOptions());
        revokeAt(h, 'memory', 'memory first', 'started');
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Want to grab lunch nearby?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.db.publishes.filter((p) => !p.final).length, 0);
        assert.ok(h.db.events.some((e) => e.detail === 'memory first refused'));
    });

    it('sends no memory to Claude when memory consent is revoked while the plan step starts', async () => {
        const h = harness();
        h.api.reply(fourOptions());
        revokeAt(h, 'memory', 'claude', 'started');
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.match(h.api.userMessage(), /Memory items: none\./);
        assert.ok(!h.api.userMessage().includes(SECRET.privateMemory));
    });

    it('reads memory consent again for a planner retry', async () => {
        const h = harness();
        h.api.fail(new Anthropic.APIConnectionTimeoutError()).reply(fourOptions());
        const create = h.api.create.bind(h.api);
        let calls = 0;
        h.api.create = async (params, options) => {
            // The first attempt left with memory; consent is revoked before the retry.
            if (++calls === 1) h.db.revokeConsent('memory');
            return create(params, options);
        };
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.api.calls.length, 2);
        assert.ok(h.api.userMessage(0).includes(SECRET.privateMemory), 'the first attempt had memory (the control)');
        assert.match(h.api.userMessage(1), /Memory items: none\./);
        assert.ok(!h.api.userMessage(1).includes(SECRET.privateMemory), 'the retry had none');
    });

    it('forgets the conversation and sends none of it once memory consent is off', async () => {
        const h = start(harness());
        const alex = 'a1'.repeat(32);
        const remember = h.db.addRememberJob({ questionText: 'Want tea?', replyText: 'Yes, with lemon please.', askedBy: alex });
        await waitFor(() => h.db.job(remember)?.status === 'done');
        h.api.reply(yesNo()).reply(yesNo());
        const without = h.db.addOptionsJob({ questionText: 'Are you tired?', askedBy: alex, memoryAllowed: false });
        await waitFor(() => h.db.job(without)?.status === 'done');
        assert.doesNotMatch(h.api.userMessage(0), /with lemon/, 'no kept reply without memory consent');
        const later = h.db.addOptionsJob({ questionText: 'Are you cold?', askedBy: alex });
        await waitFor(() => h.db.job(later)?.status === 'done');
        assert.doesNotMatch(h.api.userMessage(1), /with lemon|Are you tired/, 'what was kept before is gone');
    });

    it('writes the plan again without memory when memory consent is withdrawn while Claude writes it', async () => {
        const h = harness();
        h.api.replyWith(() => fourOptions([['m1'], [], [], []])).reply(fourOptions());
        const create = h.api.create.bind(h.api);
        let calls = 0;
        h.api.create = async (params, options) => {
            const answer = await create(params, options);
            // Revoked while the request was out: the answer was made with memory.
            if (++calls === 1) h.db.revokeConsent('memory');
            return answer;
        };
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.api.calls.length, 2, 'the plan was written again');
        assert.match(h.api.userMessage(1), /Memory items: none\./);
        const published = finalPublish(h);
        assert.ok(published && published.options.every((o) => o.memoryRefs.length === 0 && o.provenance !== 'memory'), 'nothing from memory was published');
    });

    it('publishes nothing from memory when memory consent is withdrawn while the ranking runs', async () => {
        const h = harness();
        h.api.replyWith(() => fourOptions([['m1'], [], [], []])).reply(fourOptions());
        h.memory.order = ['o4', 'o3', 'o2', 'o1'];
        const rank = h.memory.rank.bind(h.memory);
        h.memory.rank = async (partnerId, options) => {
            const ordering = await rank(partnerId, options);
            h.db.revokeConsent('memory');
            return ordering;
        };
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Want to grab lunch nearby?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.memory.ranked.length, 1, 'the ranking ran');
        assert.equal(h.api.calls.length, 2, 'the plan made with memory was written again without it');
        assert.match(h.api.userMessage(1), /Memory items: none\./);
        const published = finalPublish(h);
        assert.deepEqual(published?.options.map((o) => o.text), fourOptions().options.map((o) => o.text), 'the planner order, not the ranking');
        assert.ok(published?.options.every((o) => o.memoryRefs.length === 0 && o.provenance !== 'memory'));
    });

    it('writes the plan again when a consent is withdrawn while the plan step finishes', async () => {
        for (const scope of ['memory', 'web_search'] as const) {
            const h = harness();
            h.api.replyWith(() => fourOptions([['m1', 'w1'], [], [], []])).reply(fourOptions());
            revokeAt(h, scope, 'claude', 'ok');
            start(h);
            const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
            await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, `published (${scope})`);
            assert.equal(h.api.calls.length, 2, scope);
            const published = finalPublish(h);
            if (scope === 'memory') assert.ok(published?.options.every((o) => o.memoryRefs.length === 0), 'no memory refs');
            else assert.ok(published?.options.every((o) => o.sources.length === 0), 'no web sources');
            await h.orchestrator.stop(1_000);
            open = null;
        }
    });

    it('forgets the conversation when a memory revocation cancels the Remember job', async () => {
        const h = harness();
        const alex = 'a1'.repeat(32);
        const realCall = h.db.call.bind(h.db);
        let revoked = false;
        h.db.call = (async (name: string, args: unknown) => {
            await realCall(name as never, args as never);
            const a = args as { detail?: string; status?: string };
            if (!revoked && name === 'agentProgress' && a.detail === 'memory write back' && a.status === 'started') {
                revoked = true;
                h.db.revokeConsent('memory');
            }
        }) as typeof h.db.call;
        start(h);
        h.api.reply(yesNo()).reply(yesNo());
        const asked = h.db.addOptionsJob({ questionText: 'Are you tired?', askedBy: alex });
        await waitFor(() => h.db.job(asked)?.status === 'done');
        const remember = h.db.addRememberJob({ questionText: 'Are you tired?', replyText: 'Yes, a little sleepy.', askedBy: alex });
        await waitFor(() => h.db.job(remember)?.status === 'cancelled', 3_000, 'the revocation cancelled the Remember job');
        assert.ok(await h.orchestrator.idle(3_000));
        // Consent is given again; the next question must not carry what was kept before the revocation.
        h.db.grantConsent('memory');
        const later = h.db.addOptionsJob({ questionText: 'Are you cold?', askedBy: alex });
        await waitFor(() => h.db.job(later)?.status === 'done');
        assert.doesNotMatch(h.api.userMessage(1), /a little sleepy|Are you tired/);
        assert.equal(h.memory.written.length, 0);
    });

    it('forgets the kept conversation when memory consent is withdrawn in the middle of a job', async () => {
        const h = harness();
        const alex = 'a1'.repeat(32);
        // Withdrawn once, in the first job; consent is given again before the second question is asked.
        const realCall = h.db.call.bind(h.db);
        let revoked = false;
        h.db.call = (async (name: string, args: unknown) => {
            await realCall(name as never, args as never);
            const a = args as { detail?: string; status?: string };
            if (!revoked && name === 'agentProgress' && a.detail === 'memory recall' && a.status === 'ok') {
                revoked = true;
                h.db.revokeConsent('memory');
            }
        }) as typeof h.db.call;
        start(h);
        h.api.reply(yesNo()).reply(yesNo());
        const first = h.db.addOptionsJob({ questionText: 'Are you tired?', askedBy: alex });
        await waitFor(() => h.db.job(first)?.status === 'done');
        // A later question under memory consent: what was kept before the withdrawal is gone.
        h.db.grantConsent('memory');
        const later = h.db.addOptionsJob({ questionText: 'Are you cold?', askedBy: alex });
        await waitFor(() => h.db.job(later)?.status === 'done');
        assert.doesNotMatch(h.api.userMessage(1), /Are you tired/);
    });

    it('forgets the conversation when memory consent is revoked while the write into memory is under way', async () => {
        const h = harness();
        const alex = 'a1'.repeat(32);
        h.memory.writeBackDelayMs = 40;
        const realCall = h.db.call.bind(h.db);
        let revoked = false;
        h.db.call = (async (name: string, args: unknown) => {
            await realCall(name as never, args as never);
            const a = args as { detail?: string; status?: string };
            if (!revoked && name === 'agentProgress' && a.detail === 'memory write back' && a.status === 'started') {
                revoked = true;
                setTimeout(() => h.db.revokeConsent('memory'), 10);
            }
        }) as typeof h.db.call;
        start(h);
        h.api.reply(yesNo()).reply(yesNo());
        const asked = h.db.addOptionsJob({ questionText: 'Are you tired?', askedBy: alex });
        await waitFor(() => h.db.job(asked)?.status === 'done');
        const remember = h.db.addRememberJob({ questionText: 'Are you tired?', replyText: 'Yes, a little sleepy.', askedBy: alex });
        await waitFor(() => h.db.job(remember)?.status === 'cancelled', 3_000, 'cancelled during the write');
        assert.ok(await h.orchestrator.idle(3_000));
        h.db.grantConsent('memory');
        const later = h.db.addOptionsJob({ questionText: 'Are you cold?', askedBy: alex });
        await waitFor(() => h.db.job(later)?.status === 'done');
        assert.doesNotMatch(h.api.userMessage(1), /a little sleepy|Are you tired/);
    });

    it('writes nothing into memory when memory consent is revoked as the write starts', async () => {
        const h = harness();
        revokeAt(h, 'memory', 'memory write back', 'started');
        start(h);
        h.db.addRememberJob({ questionText: 'Want water?', replyText: 'Yes please.' });
        await waitFor(() => h.db.attempted.some((a) => a.name === 'agentProgress'), 3_000, 'the step started');
        assert.ok(await h.orchestrator.idle(3_000));
        assert.equal(h.memory.written.length, 0);
    });
});

describe('consent as the module shows it (agent_consent, module v2)', () => {
    const alex = 'a1'.repeat(32);

    /** Keeps one spoken reply in the conversation with Alex, and waits until no job runs. */
    async function keepOneReply(h: Harness): Promise<void> {
        const remember = h.db.addRememberJob({ questionText: 'Want tea?', replyText: 'Yes, with lemon please.', askedBy: alex });
        await waitFor(() => h.db.job(remember)?.status === 'done');
        assert.ok(await h.orchestrator.idle(3_000));
    }

    it('keeps the conversation when consent does not change (the control for the tests below)', async () => {
        const h = start(harness());
        await keepOneReply(h);
        h.api.reply(yesNo());
        const later = h.db.addOptionsJob({ questionText: 'Are you cold?', askedBy: alex });
        await waitFor(() => h.db.job(later)?.status === 'done');
        assert.match(h.api.userMessage(0), /with lemon/);
    });

    it('forgets the conversation when memory consent is revoked and given again with no job running', async () => {
        const h = start(harness());
        await keepOneReply(h);
        // Revoked and given again before the sidecar looks at the views: no job's flags ever show it.
        h.db.revokeConsent('memory');
        h.db.grantConsent('memory');
        h.api.reply(yesNo());
        const later = h.db.addOptionsJob({ questionText: 'Are you cold?', askedBy: alex });
        await waitFor(() => h.db.job(later)?.status === 'done');
        assert.equal(h.db.job(later)?.memoryAllowed, true, 'the new job has memory consent');
        assert.doesNotMatch(h.api.userMessage(0), /with lemon|Want tea/);
    });

    it('forgets the conversation when memory consent is revoked and given again while the connection is down', async () => {
        const h = start(harness());
        await keepOneReply(h);
        h.db.setConnected(false);
        // Neither change reaches the sidecar: when the views come back, agent_consent shows memory allowed.
        h.db.revokeConsent('memory');
        h.db.grantConsent('memory');
        h.db.setConnected(true);
        h.api.reply(yesNo());
        const later = h.db.addOptionsJob({ questionText: 'Are you cold?', askedBy: alex });
        await waitFor(() => h.db.job(later)?.status === 'done');
        assert.doesNotMatch(h.api.userMessage(0), /with lemon|Want tea/);
    });

    it('forgets the conversation on a fresh load of the views, even if no memory-off call ever came', async () => {
        const h = harness();
        // The orchestrator's own rule, without the db's memory-off calls (the adapter makes them on a disconnect).
        h.db.onMemoryOff = () => () => undefined;
        start(h);
        await keepOneReply(h);
        h.db.setConnected(false);
        h.db.revokeConsent('memory');
        h.db.grantConsent('memory');
        h.db.setConnected(true);
        await settle(20);
        h.api.reply(yesNo());
        const later = h.db.addOptionsJob({ questionText: 'Are you cold?', askedBy: alex });
        await waitFor(() => h.db.job(later)?.status === 'done');
        assert.doesNotMatch(h.api.userMessage(0), /with lemon|Want tea/);
    });

    it('forgets the conversation at the next look once agent_consent shows memory off, with no job running', async () => {
        const h = start(harness());
        await keepOneReply(h);
        // Only the view changes (no listener call, no job): the next look at the views forgets.
        h.db.consent.memory = false;
        h.db.grantConsent('web_search');
        await settle(20);
        h.db.grantConsent('memory');
        h.api.reply(yesNo());
        const later = h.db.addOptionsJob({ questionText: 'Are you cold?', askedBy: alex });
        await waitFor(() => h.db.job(later)?.status === 'done');
        assert.doesNotMatch(h.api.userMessage(0), /with lemon|Want tea/);
    });

    it('uses no memory and sends no search when agent_consent cannot be read, whatever the job flags say', async () => {
        const h = start(harness());
        h.db.consentRowShown = false;
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?', memoryAllowed: true, webSearchAllowed: true });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.memory.recalls.length, 0, 'Moss was not asked');
        assert.equal(h.search.calls.length, 0, 'the question never went out');
        assert.match(h.api.userMessage(), /Memory items: none\./);
        assert.match(h.api.userMessage(), /Web results: none\./);
    });

    it('stops memory when agent_consent shows it off before the job\'s own flag does', async () => {
        const h = start(harness());
        h.db.consent.memory = false;
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?', memoryAllowed: true });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.memory.recalls.length, 0);
        assert.ok(!h.api.userMessage().includes(SECRET.privateMemory));
        assert.equal(h.search.calls.length, 1, 'web search consent still holds (the control)');
    });
});

describe('place queries', () => {
    it('uses a short place word, never the whole question when one is there', () => {
        assert.equal(placeQuery('Is the pharmacy on Bancroft still open?'), 'pharmacy');
        assert.equal(placeQuery('Want to grab lunch nearby?'), 'lunch');
        assert.equal(placeQuery('Where is the nearest bus stop?'), 'bus stop');
        assert.equal(placeQuery('Is Target still open?'), 'Target');
    });

    it('never sends the whole spoken sentence to Maps (it times out on one)', () => {
        assert.equal(
            placeQuery('All right, uh, call me later, all right? So, you can remind me to go to Palace of Fine Arts.'),
            'Palace of Fine Arts',
        );
        assert.equal(
            placeQuery("Oh, but I'm kind of think of like uh nature or something. You have anything like in particular? like nearby that you want to try out?"),
            'park',
        );
        // A place after "near" is where to look (Maps searches around it), so it is not the query.
        assert.equal(placeQuery('Where should we go near the Palace of Fine Arts?'), DEFAULT_PLACE_QUERY);
        assert.equal(placeQuery('Anything outdoors near the Palace of Fine Arts?'), 'park');
        assert.equal(placeQuery('Anywhere fun nearby you want to try?'), DEFAULT_PLACE_QUERY);
        assert.equal(placeQuery('Somewhere with a nice view?'), 'scenic viewpoint');
    });
});

// Keep the event loop free of stray timers between files.
afterEach(() => settle(1));
