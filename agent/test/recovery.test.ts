// Stalls and lease races (Codex review round 1): a Moss call that never answers, an aborted job that will not stop,
// and a claim that lands at a later attempt than the sidecar computed.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ApifyHttpError } from '@say-when/apify-client';

import { JobAbortedError, withDeadline } from '../src/deadline.js';
import { runRememberJob } from '../src/jobs.js';
import { searchPort } from '../src/wiring.js';
import { fourOptions, harness, SECRET, waitFor, type Harness } from './helpers.js';

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

/** Runs `body` and returns every promise rejection nobody handled meanwhile (Node would end the process on one). */
async function unhandledDuring(body: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const record = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', record);
    try {
        await body();
        await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
        process.off('unhandledRejection', record);
    }
    return seen;
}

describe('recovery', () => {
    it('cuts off a Moss recall that never answers and still publishes options', async () => {
        const h = harness();
        h.deps.retrieval.mossDeadlines = { recall: 40 };
        h.memory.recallHang = true;
        h.api.reply(fourOptions());
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Are you warm enough?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        const failed = h.db.events.find((e) => e.stage === 'retrieve' && e.status === 'error');
        assert.equal(failed?.detail, 'memory recall failed: timeout');
        assert.match(h.api.userMessage(), /Memory items: none\./);
        assert.ok(!h.api.userMessage().includes(SECRET.privateMemory));
    });

    it('releases the slot of an aborted job that will not stop, so the requeued job runs again at once', async () => {
        const h = harness({ abortGraceMs: 20 });
        // The first attempt waits in the planner, and its cleanup then never answers whatever the signal says.
        h.deps.retrieval.mossDeadlines = { forget: 3_000 };
        h.api.hang = true;
        h.web.hangForgets = 1;
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: SECRET.question });
        await waitFor(() => h.api.calls.length === 1, 3_000, 'the first attempt reached the planner');
        h.api.hang = false;
        h.api.reply(fourOptions());
        // The lease lapses: the module requeues the job for a new attempt.
        h.db.expireLease(jobId);
        // Without the release, the stuck cleanup would hold the slot for the 3 s forget deadline.
        await waitFor(() => h.db.job(jobId)?.status === 'done', 2_000, 'the second attempt published');
        assert.equal(h.db.job(jobId)?.attempt, 2);
        assert.equal(finalPublish(h)?.attempt, 2);
        assert.ok(h.log.entries.some((e) => e.message === 'a job did not stop after it was aborted; releasing its slot'));
    });

    it('publishes with the attempt its claim actually landed at', async () => {
        const h = harness();
        h.api.reply(fourOptions());
        const realCall = h.db.call.bind(h.db);
        let raced = false;
        h.db.call = (async (name: string, args: unknown) => {
            if (name === 'agentClaim' && !raced) {
                raced = true;
                // Between reading the Pending row and this claim arriving, another claim ran and its lease lapsed.
                const job = h.db.job((args as { jobId: bigint }).jobId);
                if (job) job.attempt += 1;
            }
            await realCall(name as never, args as never);
        }) as typeof h.db.call;
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Are you warm enough?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.db.job(jobId)?.attempt, 2);
        assert.equal(finalPublish(h)?.attempt, 2);
        assert.ok(h.log.entries.some((e) => e.message === 'the claim landed at a later attempt than expected'));
    });

    it('runs the job when its claim landed at a later attempt and the reply was lost', async () => {
        const h = harness();
        h.api.reply(fourOptions());
        // The claim runs, then its reply is lost, so the sidecar has to read the view to know it holds the job.
        h.db.failNext('agentClaim', 'unknown_result', { applied: true });
        const realCall = h.db.call.bind(h.db);
        let raced = false;
        h.db.call = (async (name: string, args: unknown) => {
            if (name === 'agentClaim' && !raced) {
                raced = true;
                const job = h.db.job((args as { jobId: bigint }).jobId);
                if (job) job.attempt += 1;
            }
            await realCall(name as never, args as never);
        }) as typeof h.db.call;
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Are you warm enough?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(finalPublish(h)?.attempt, 2);
        assert.equal(h.db.attempted.filter((a) => a.name === 'agentClaim').length, 1, 'the claim was not sent twice');
    });

    it('aborts a job cancelled while Claude is writing, though no view changed since its claim', async () => {
        const h = harness();
        // Pipeline events change no agent view, so nothing between the claim and the cancel tells the orchestrator.
        h.api.hang = true;
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Are you warm enough?' });
        await waitFor(() => h.api.calls.length === 1, 3_000, 'the planner call started');
        h.db.cancelJob(jobId);
        await waitFor(() => h.api.calls[0]?.options?.signal?.aborted === true, 2_000, 'the planner call was aborted');
        assert.ok(await h.orchestrator.idle(2_000), 'the job stopped');
    });

    it('keeps the job lease while Claude takes longer than the lease, with no new public rows', async () => {
        const h = harness({ leaseMs: 150, leaseHeartbeatMs: 40 });
        h.api.delayMs = 450;
        h.api.reply(fourOptions());
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Are you warm enough?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published');
        assert.equal(h.db.job(jobId)?.attempt, 1, 'the lease never ran out');
        assert.equal(finalPublish(h)?.attempt, 1);
        const sent = h.db.attempted.filter((a) => a.name === 'agentProgress').length;
        assert.ok(sent > h.db.events.length, 'the step renewed its lease by sending its started event again');
        // Renewals add no rows: every step has one started row and one row that ends it, and nothing else.
        const steps = new Map<string, string[]>();
        for (const e of h.db.events) {
            const [, , seq, stage, status] = e.eventKey.split(':');
            const key = `${seq}:${stage}`;
            steps.set(key, [...(steps.get(key) ?? []), status ?? '']);
        }
        for (const [key, statuses] of steps) {
            if (!statuses.includes('started')) continue;
            assert.equal(statuses.length, 2, `step ${key} has rows ${statuses.join(', ')}`);
        }
    });

    it('loses the lease to a slow planner when nothing renews it (the control for the test above)', async () => {
        const h = harness({ leaseMs: 150, leaseHeartbeatMs: 0 });
        h.api.delayMs = 450;
        h.api.reply(fourOptions());
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Are you warm enough?' });
        await waitFor(() => (h.db.job(jobId)?.attempt ?? 0) >= 2, 3_000, 'the module requeued the job');
        assert.equal(h.db.publishes.filter((p) => p.final && p.attempt === 1).length, 0, 'the first attempt could not publish');
    });

    it('handles a late failure of work whose wait ended because the job was aborted first', async () => {
        const unhandled = await unhandledDuring(async () => {
            const controller = new AbortController();
            controller.abort();
            let fail: (error: Error) => void = () => undefined;
            const work = new Promise<never>((_resolve, reject) => (fail = reject));
            await assert.rejects(withDeadline(work, 1_000, 'memory recall', controller.signal), JobAbortedError);
            fail(new Error('moss failed late'));
        });
        assert.deepEqual(unhandled, []);
    });

    it('survives a Moss recall that fails after its job was cancelled while the recall ran', async () => {
        const h = harness();
        h.memory.recallError = new Error('moss failed');
        h.memory.recallDelayMs = 40;
        let jobId = 0n;
        const realCall = h.db.call.bind(h.db);
        h.db.call = (async (name: string, args: unknown) => {
            await realCall(name as never, args as never);
            const a = args as { detail?: string; status?: string };
            // Cancelled while Moss is working: the job is aborted, and the recall fails afterwards.
            if (name === 'agentProgress' && a.detail === 'memory recall' && a.status === 'started') setTimeout(() => h.db.cancelJob(jobId), 10);
        }) as typeof h.db.call;
        const unhandled = await unhandledDuring(async () => {
            start(h);
            jobId = h.db.addOptionsJob({ questionText: 'Are you warm enough?' });
            await waitFor(() => h.memory.recalls.length === 1, 3_000, 'the recall ran');
            assert.ok(await h.orchestrator.idle(3_000), 'the job stopped');
            await new Promise((resolve) => setTimeout(resolve, 60));
        });
        assert.deepEqual(unhandled, []);
        assert.equal(h.api.calls.length, 0, 'the cancelled job never reached the planner');
    });

    it('lets a replaced Remember attempt write nothing, even when its last event went through', async () => {
        const h = harness();
        const jobId = h.db.addRememberJob({ questionText: 'Want water?', replyText: 'Yes please.' });
        await h.db.call('agentClaim', { jobId });
        const row = h.db.agentQueue().find((r) => r.jobId === jobId);
        assert.ok(row);
        const realCall = h.db.call.bind(h.db);
        h.db.call = (async (name: string, args: unknown) => {
            await realCall(name as never, args as never);
            const a = args as { detail?: string; status?: string };
            if (name === 'agentProgress' && a.detail === 'memory write back' && a.status === 'started') {
                // Its reply was slow: meanwhile the lease ran out and attempt 2 took the job.
                h.db.expireLease(jobId);
                await realCall('agentClaim' as never, { jobId } as never);
            }
        }) as typeof h.db.call;
        await runRememberJob(row, 1, h.deps).catch(() => undefined);
        assert.equal(h.db.job(jobId)?.attempt, 2);
        assert.equal(h.memory.written.length, 0, 'the replaced attempt did not write');
    });

    it('fails closed on consent while the views are not current, and sends no memory', async () => {
        const h = harness();
        h.api.reply(fourOptions());
        const realCall = h.db.call.bind(h.db);
        h.db.call = (async (name: string, args: unknown) => {
            await realCall(name as never, args as never);
            const a = args as { detail?: string; status?: string };
            if (name === 'agentProgress' && a.detail === 'claude' && a.status === 'started') {
                // The connection drops as the plan starts; a revocation could be on its way and unseen.
                h.db.setConnected(false);
                setTimeout(() => h.db.setConnected(true), 50);
            }
        }) as typeof h.db.call;
        start(h);
        const jobId = h.db.addOptionsJob({ questionText: 'Are you warm enough?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'published after the reconnect');
        assert.match(h.api.userMessage(), /Memory items: none\./);
        assert.ok(!h.api.userMessage().includes(SECRET.privateMemory));
    });

    it('sends the question to the web search once: no retry inside the client', async () => {
        let requests = 0;
        const fetchFn = async () => {
            requests += 1;
            return new Response('busy', { status: 503 });
        };
        const port = searchPort({ token: 'apify_api_placeholder', ragWebBrowserUrl: 'https://rag.example.test' }, 5_000, fetchFn);
        await assert.rejects(port.web('Is the pharmacy open?', { signal: new AbortController().signal }), (e: unknown) => e instanceof ApifyHttpError);
        assert.equal(requests, 1);
    });

    it('runs a place search with a charge cap Apify accepts and a run limit inside the search deadline', async () => {
        const urls: string[] = [];
        const fetchFn = async (input: string) => {
            urls.push(input);
            return new Response('[]', { status: 201, headers: { 'content-type': 'application/json' } });
        };
        // The sidecar's default search deadline (AGENT_SEARCH_TIMEOUT_MS).
        const port = searchPort({ token: 'apify_api_placeholder', ragWebBrowserUrl: 'https://rag.example.test' }, 20_000, fetchFn);
        const result = await port.places('lunch', { signal: new AbortController().signal, near: { lat: 37.8716, lng: -122.2727 } });
        assert.deepEqual(result.rows, []);
        assert.equal(urls.length, 1);
        const url = new URL(urls[0] ?? '');
        // Apify refuses a cap under $0.50 with HTTP 400 max-total-charge-usd-below-minimum (live test, Oct 24), and the
        // port passes no cap of its own, so the client's default must be one Apify accepts.
        assert.ok(Number(url.searchParams.get('maxTotalChargeUsd')) >= 0.5, url.search);
        assert.equal(url.searchParams.get('timeout'), '15');
    });
});
