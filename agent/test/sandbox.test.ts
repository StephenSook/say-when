// The judge try sandbox on the sidecar's side (src/sandbox.ts): the caps in front of the spending, the refusal the
// module sees, the settings that keep the sandbox off the demo, the sample notes and the health endpoint.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import { readConfig } from '../src/config.js';
import { isSandboxDatabase, SAMPLE_NOTES, SANDBOX_LIMIT_DEFAULTS, SandboxMeter, startHealthServer, TRY_LIMIT_CODE, TRY_LIMIT_SAY, type SandboxLimits } from '../src/sandbox.js';
import type { AgentQueueRow } from '../src/types.js';
import { seedNotes } from '../src/wiring.js';
import { fourOptions, harness, settle, waitFor, type Harness } from './helpers.js';

const HOUR = 60 * 60 * 1000;

function row(overrides: Partial<AgentQueueRow> = {}): AgentQueueRow {
    return {
        jobId: 1n,
        kind: 'options',
        status: 'claimed',
        attempt: 1,
        claimedByMe: true,
        questionId: 1n,
        questionText: 'What should we eat?',
        origin: 'partner',
        menuItem: 'none',
        askedBy: 'a'.repeat(64),
        webSearchAllowed: true,
        memoryAllowed: true,
        errandId: 0n,
        formKey: '',
        formUrl: '',
        formTitle: '',
        fieldsJson: '',
        replyText: '',
        recentErrandTitle: '',
        recentErrandSentAtMs: null,
        parentQuestionId: 0n,
        parentQuestionText: '',
        category: '',
        createdAtMs: 0,
        ...overrides,
    };
}

function meter(limits: Partial<SandboxLimits> = {}) {
    let now = 1_000_000;
    const m = new SandboxMeter({ ...SANDBOX_LIMIT_DEFAULTS, ...limits }, () => now);
    return { m, advance: (ms: number) => (now += ms) };
}

describe('the sandbox meter', () => {
    it('estimates a question with a search, one without, an errand and a remember job', () => {
        const { m } = meter({ usdPerPlan: 0.02, usdPerSearch: 0.03, usdPerErrand: 0.05 });
        assert.equal(m.estimate(row()), 0.05);
        assert.equal(m.estimate(row({ webSearchAllowed: false })), 0.02);
        assert.equal(m.estimate(row({ kind: 'errand_preview' })), 0.05);
        assert.equal(m.estimate(row({ kind: 'remember' })), 0);
    });

    it('refuses a job that would pass the daily ceiling, and opens again after 24 hours', () => {
        const { m, advance } = meter({ dailyUsd: 0.1, usdPerPlan: 0.03, usdPerSearch: 0.02, questionsPerPartnerPerHour: 100 });
        assert.equal(m.admit(row()).ok, true);
        assert.equal(m.admit(row()).ok, true);
        const third = m.admit(row());
        assert.equal(third.ok, false);
        assert.ok(!third.ok && third.reasonCode === TRY_LIMIT_CODE && third.reason === TRY_LIMIT_SAY.spend);
        // A smaller job that still fits runs.
        assert.equal(m.admit(row({ webSearchAllowed: false })).ok, false, '0.10 + 0.03 is past 0.10');
        assert.equal(m.usage().spentUsd, 0.1);
        assert.equal(m.usage().refusedToday, 2);
        advance(24 * HOUR);
        assert.equal(m.admit(row()).ok, true);
        assert.equal(m.usage().spentUsd, 0.05);
    });

    it('caps questions per partner per hour, and new partners per hour', () => {
        const { m, advance } = meter({ questionsPerPartnerPerHour: 2, partnersPerHour: 2 });
        const a = row({ askedBy: 'a'.repeat(64) });
        const b = row({ askedBy: 'b'.repeat(64) });
        const c = row({ askedBy: 'c'.repeat(64) });
        assert.equal(m.admit(a).ok, true);
        assert.equal(m.admit(a).ok, true);
        const third = m.admit(a);
        assert.ok(!third.ok && third.why === 'partner');
        assert.equal(m.admit(b).ok, true);
        const newcomer = m.admit(c);
        assert.ok(!newcomer.ok && newcomer.why === 'partners');
        advance(HOUR);
        assert.equal(m.admit(c).ok, true);
        assert.equal(m.admit(a).ok, true);
    });

    it('refuses every remember job: one judge\'s words are never saved for the next judge', () => {
        const { m } = meter();
        const refused = m.admit(row({ kind: 'remember', replyText: 'Thai noodles' }));
        assert.ok(!refused.ok && refused.why === 'memory' && refused.reasonCode === TRY_LIMIT_CODE);
        assert.equal(m.usage().jobsToday, 0);
    });

    it('caps every options job by who asked, menu turns included', () => {
        const { m } = meter({ questionsPerPartnerPerHour: 1, partnersPerHour: 1 });
        const station = 'c'.repeat(64);
        assert.equal(m.admit(row({ origin: 'menu', menuItem: 'need', askedBy: station })).ok, true);
        const again = m.admit(row({ origin: 'menu', menuItem: 'need', askedBy: station }));
        assert.ok(!again.ok && again.why === 'partner');
        const other = m.admit(row({ origin: 'menu', menuItem: 'say', askedBy: 'd'.repeat(64) }));
        assert.ok(!other.ok && other.why === 'partners');
    });

    it('charges the search whenever the job may search (jobs.ts: only a real menu item skips it)', () => {
        const { m } = meter({ usdPerPlan: 0.02, usdPerSearch: 0.03 });
        assert.equal(m.estimate(row({ origin: 'menu', menuItem: 'none' })), 0.05);
        assert.equal(m.estimate(row({ origin: 'menu', menuItem: 'need' })), 0.02);
        assert.equal(m.estimate(row({ origin: 'partner', webSearchAllowed: false })), 0.02);
    });
});

describe('the orchestrator with the sandbox caps', () => {
    let open: Harness | null = null;
    afterEach(async () => {
        await open?.orchestrator.stop(1_000);
        open = null;
    });

    it('fails a job past a cap with try_limit before any model call or search', async () => {
        const { m } = meter({ questionsPerPartnerPerHour: 1 });
        const h = harness({ admit: (r) => m.admit(r) });
        open = h;
        h.orchestrator.start();
        h.api.replyWith(() => fourOptions());
        const first = h.db.addOptionsJob({ questionText: 'Is the cafe on Bancroft open?' });
        await waitFor(() => h.db.job(first)?.status === 'done', 3_000, 'first job done');
        const calls = h.api.calls.length;
        const searches = h.trace.steps.filter((s) => s === 'search.web').length;
        const second = h.db.addOptionsJob({ questionText: 'And the library?' });
        await waitFor(() => h.db.job(second)?.status === 'failed', 3_000, 'second job failed');
        const fail = h.db.applied.find((a) => a.name === 'agentFail');
        assert.ok(fail);
        assert.equal((fail.args as { reasonCode: string }).reasonCode, TRY_LIMIT_CODE);
        assert.equal(h.api.calls.length, calls, 'no Claude call for a refused job');
        assert.equal(h.trace.steps.filter((s) => s === 'search.web').length, searches, 'no search for a refused job');
    });

    it('without the caps (control), the same second job runs', async () => {
        const h = harness();
        open = h;
        h.orchestrator.start();
        // One queued reply per Claude call.
        h.api.replyWith(() => fourOptions()).replyWith(() => fourOptions());
        const first = h.db.addOptionsJob({ questionText: 'Is the cafe on Bancroft open?' });
        await waitFor(() => h.db.job(first)?.status === 'done');
        const second = h.db.addOptionsJob({ questionText: 'And the library?' });
        await waitFor(() => h.db.job(second)?.status === 'done');
        assert.equal(h.db.applied.some((a) => a.name === 'agentFail'), false);
    });
});

describe('the sandbox settings', () => {
    const base = {
        ANTHROPIC_API_KEY: 'x',
        SPACETIMEDB_DB: 'say-when-try',
        AGENT_TRY: 'on',
    };

    it('runs only against a try database, with calls off and its own Moss memory', () => {
        assert.deepEqual(readConfig(base, '/tmp/t').problems, []);
        assert.ok(readConfig({ ...base, SPACETIMEDB_DB: 'say-when-demo' }, '/tmp/t').problems.some((p) => p.includes('say-when-try')));
        assert.ok(readConfig({ ...base, AGENT_CALLS: 'on' }, '/tmp/t').problems.some((p) => p.includes('AGENT_CALLS must be off')));
        const moss = { MOSS_PROJECT_ID: 'p', MOSS_PROJECT_KEY: 'k', MOSS_SNAPSHOT_DIR: '/tmp/m' };
        assert.ok(readConfig({ ...base, ...moss }, '/tmp/t').problems.some((p) => p.includes('MOSS_SESSION_NAME')));
        assert.ok(readConfig({ ...base, ...moss, MOSS_SESSION_NAME: 'say-when' }, '/tmp/t').problems.some((p) => p.includes('MOSS_SESSION_NAME')));
        assert.deepEqual(readConfig({ ...base, ...moss, MOSS_SESSION_NAME: 'say-when-try' }, '/tmp/t').problems, []);
    });

    it('a try database never runs without the caps; the demo never runs with them', () => {
        assert.ok(readConfig({ ...base, AGENT_TRY: 'off' }, '/tmp/t').problems.some((p) => p.includes('AGENT_TRY must be on')));
        assert.equal(readConfig({ ANTHROPIC_API_KEY: 'x', SPACETIMEDB_DB: 'say-when-demo' }, '/tmp/t').config.sandbox, null);
        assert.equal(isSandboxDatabase('say-when-try'), true);
        assert.equal(isSandboxDatabase('say-when-try-dev'), true);
        assert.equal(isSandboxDatabase('say-when-demo'), false);
        assert.equal(isSandboxDatabase('say-when-dev'), false);
    });

    it('reads the daily ceiling in cents, the token from the environment and the port', () => {
        const { config, problems, checks } = readConfig({ ...base, AGENT_TRY_DAILY_CENTS: '250', AGENT_TOKEN: 'secret-token-value', PORT: '10000' }, '/tmp/t');
        assert.deepEqual(problems, []);
        assert.equal(config.sandbox?.dailyUsd, 2.5);
        assert.equal(config.spacetime.token, 'secret-token-value');
        assert.equal(config.port, 10000);
        assert.ok(!JSON.stringify(checks).includes('secret-token-value'), 'a setting check never prints a value');
        assert.ok(readConfig({ ...base, AGENT_TRY_DAILY_CENTS: '0' }, '/tmp/t').problems.length > 0);
    });

    it('keeps the health endpoint on loopback when AGENT_HEALTH_HOST says so, and refuses any other address', () => {
        assert.equal(readConfig({ ...base }, '/tmp/t').config.healthHost, null, 'unset: every address, as on a host');
        for (const host of ['127.0.0.1', '::1', 'localhost']) {
            const result = readConfig({ ...base, PORT: '8791', AGENT_HEALTH_HOST: ` ${host} ` }, '/tmp/t');
            assert.deepEqual(result.problems, []);
            assert.equal(result.config.healthHost, host);
        }
        for (const host of ['0.0.0.0', '192.168.1.20', 'example.com']) {
            const result = readConfig({ ...base, PORT: '8791', AGENT_HEALTH_HOST: host }, '/tmp/t');
            assert.ok(result.problems.some((p) => p.includes('AGENT_HEALTH_HOST')), host);
            assert.ok(!JSON.stringify(result.checks).includes(host), 'a setting check never prints a value');
        }
    });
});

describe('the sample notes', () => {
    it('are labelled as sample notes, shareable, and hold for every partner', () => {
        assert.ok(SAMPLE_NOTES.length >= 3);
        for (const note of SAMPLE_NOTES) {
            assert.equal(note.type, 'pref');
            assert.ok(note.type === 'pref' && note.text.startsWith('Sample note: '));
            assert.equal(note.shareable, true);
            assert.ok(note.type === 'pref' && note.partnerId === undefined);
        }
    });

    it('are added once Moss is open, and a failure only logs', async () => {
        const added: unknown[] = [];
        const lines: string[] = [];
        const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m), debug: () => {} };
        await seedNotes({ add: async (items) => (added.push(...items), { ids: [], added: items.length, updated: 0 }) }, SAMPLE_NOTES, log as never);
        assert.equal(added.length, SAMPLE_NOTES.length);
        await seedNotes({ add: async () => Promise.reject(Object.assign(new Error('moss down'), { code: 'not_open' })) }, SAMPLE_NOTES, log as never);
        assert.ok(lines.some((l) => l.includes('could not be added')));
        await seedNotes({ add: async () => assert.fail('no notes, no call') }, [], log as never);
    });
});

describe('the health endpoint', () => {
    function get(port: number, path: string): Promise<{ status: number; body: string }> {
        return new Promise((resolve, reject) => {
            const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            });
            req.on('error', reject);
            req.end();
        });
    }

    it('answers numbers and yes or no only, and 404 for anything else', async () => {
        const { m } = meter();
        m.admit(row({ questionText: 'A private question nobody else should read' }));
        const server = startHealthServer(0, { database: 'say-when-try', connected: () => true, paired: () => true, usage: () => m.usage() });
        await new Promise((resolve) => server.once('listening', resolve));
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        try {
            const ok = await get(port, '/healthz');
            assert.equal(ok.status, 200);
            const body = JSON.parse(ok.body);
            assert.equal(body.ok, true);
            assert.equal(body.database, 'say-when-try');
            assert.equal(body.sandbox.jobsToday, 1);
            assert.ok(!ok.body.includes('private question'));
            assert.ok(!ok.body.includes('a'.repeat(16)), 'no identity');
            assert.equal((await get(port, '/anything')).status, 404);
        } finally {
            server.close();
            await settle(5);
        }
    });

    it('listens only on the host it is given', async () => {
        const server = startHealthServer(0, { database: 'say-when-demo', connected: () => true, paired: () => true, usage: () => null }, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        const address = server.address();
        try {
            assert.ok(typeof address === 'object' && address !== null);
            assert.equal(address.address, '127.0.0.1');
            const ok = await get(address.port, '/healthz');
            assert.equal(ok.status, 200);
            assert.equal(JSON.parse(ok.body).sandbox, null);
        } finally {
            server.close();
            await settle(5);
        }
    });

    it('listens on every address without a host (a web service host), as before', async () => {
        const server = startHealthServer(0, { database: 'say-when-try', connected: () => true, paired: () => true, usage: () => null });
        await new Promise((resolve) => server.once('listening', resolve));
        const address = server.address();
        try {
            assert.ok(typeof address === 'object' && address !== null);
            assert.ok(address.address === '::' || address.address === '0.0.0.0', address.address);
        } finally {
            server.close();
            await settle(5);
        }
    });
});
