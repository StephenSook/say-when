import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DbCallError, toDbError } from '../src/db/db.js';
import { MemoryDb } from '../src/db/memory-db.js';
import { callReducer } from '../src/db/retry.js';
import { SpacetimeAgentDb, toAgentQueueRow, toCallQueueRow, TokenSaveError, type BuilderLike, type ConnectionLike } from '../src/db/spacetime-db.js';
import { recordingLogger } from '../src/log.js';
import { MemoryWatch } from '../src/requests.js';

const named = (name: string, message = '') => Object.assign(new Error(message), { name });

/** A generated table as the SDK shows it: onInsert passes (ctx, row), onUpdate (ctx, oldRow, row). */
class FakeTable {
    rows: unknown[] = [];
    private readonly inserts = new Set<(...args: unknown[]) => void>();
    private readonly deletes = new Set<(...args: unknown[]) => void>();
    private readonly updates = new Set<(...args: unknown[]) => void>();
    iter() {
        return this.rows;
    }
    onInsert(cb: (...args: unknown[]) => void) {
        this.inserts.add(cb);
    }
    removeOnInsert(cb: (...args: unknown[]) => void) {
        this.inserts.delete(cb);
    }
    onDelete(cb: (...args: unknown[]) => void) {
        this.deletes.add(cb);
    }
    removeOnDelete(cb: (...args: unknown[]) => void) {
        this.deletes.delete(cb);
    }
    onUpdate(cb: (...args: unknown[]) => void) {
        this.updates.add(cb);
    }
    removeOnUpdate(cb: (...args: unknown[]) => void) {
        this.updates.delete(cb);
    }
    insert(row: unknown) {
        this.rows.push(row);
        for (const cb of this.inserts) cb({}, row);
    }
    /** Removes row `index` and calls the delete listeners with it. */
    remove(index: number) {
        const [row] = this.rows.splice(index, 1);
        for (const cb of this.deletes) cb({}, row);
    }
    /** Replaces row `index` and calls the update listeners with the old and the new row. */
    update(index: number, row: unknown) {
        const old = this.rows[index];
        this.rows[index] = row;
        for (const cb of this.updates) cb({}, old, row);
    }
}

function fakeConnection() {
    const calls: { name: string; args: unknown }[] = [];
    const queries: string[] = [];
    const tables: Record<string, FakeTable> & { agentQueue: FakeTable; callQueue: FakeTable; agentConsent: FakeTable; deviceStatus: FakeTable } = {
        agentQueue: new FakeTable(),
        errandQueue: new FakeTable(),
        callQueue: new FakeTable(),
        agentConsent: new FakeTable(),
        deviceStatus: new FakeTable(),
    };
    let failWith: Error | null = null;
    const state: { disconnects: number; subscriptionError: (ctx: unknown) => void } = { disconnects: 0, subscriptionError: () => undefined };
    const conn: ConnectionLike = {
        db: tables,
        reducers: {
            agentClaim: async (args: unknown) => {
                calls.push({ name: 'agentClaim', args });
                if (failWith) throw failWith;
            },
        },
        subscriptionBuilder() {
            let applied: (ctx: unknown) => void = () => undefined;
            const builder = {
                onApplied(cb: (ctx: unknown) => void) {
                    applied = cb;
                    return builder;
                },
                onError(cb: (ctx: unknown) => void) {
                    state.subscriptionError = cb;
                    return builder;
                },
                subscribe(list: string[]) {
                    queries.push(...list);
                    queueMicrotask(() => applied({}));
                    return {};
                },
            };
            return builder;
        },
        disconnect() {
            state.disconnects += 1;
        },
    };
    const identity = { toHexString: () => 'c'.repeat(64) };
    const builder: BuilderLike & { options: Record<string, unknown> } = {
        options: {},
        withUri(uri) {
            this.options.uri = uri;
            return this;
        },
        withDatabaseName(name) {
            this.options.database = name;
            return this;
        },
        withToken(token) {
            this.options.token = token;
            return this;
        },
        withAutomaticReconnect() {
            return this;
        },
        onConnect(cb) {
            this.options.onConnect = cb;
            return this;
        },
        onAutomaticReconnect() {
            return this;
        },
        onConnectError() {
            return this;
        },
        onDisconnect(cb) {
            this.options.onDisconnect = cb;
            return this;
        },
        build() {
            const onConnect = this.options.onConnect as (c: ConnectionLike, id: typeof identity, token: string) => void;
            queueMicrotask(() => onConnect(conn, identity, 'new-token'));
            return conn;
        },
    };
    return { conn, builder, tables, calls, queries, state, setFailure: (error: Error | null) => (failWith = error) };
}

const bindingRow = {
    jobId: 7n,
    kind: { tag: 'ErrandPreview' },
    status: { tag: 'Claimed' },
    attempt: 2,
    claimedByMe: true,
    questionId: 3n,
    questionText: 'q',
    origin: { tag: 'Partner' },
    menuItem: { tag: 'None' },
    askedBy: 'ab',
    webSearchAllowed: true,
    memoryAllowed: false,
    errandId: 9n,
    formKey: 'care_team_request',
    formUrl: 'demo',
    formTitle: 'Care team request',
    fieldsJson: '[]',
    replyText: '',
    recentErrandTitle: 'Care team request',
    recentErrandSentAt: { toMillis: () => 1_700_000_000_000n },
    createdAt: { microsSinceUnixEpoch: 1_700_000_000_000_000n },
    // Direct select (module 7eeaabb): 0 and empty on every job but a categories or search turn.
    parentQuestionId: 0n,
    parentQuestionText: '',
    category: '',
};

const callRow = {
    callId: 4n,
    status: { tag: 'Confirmed' },
    claimAttempt: 0,
    claimedByMe: false,
    requestId: 'call-test-1',
    contactId: 'leon',
    scriptDigest: 'fedcba9876543210',
    cancelRequested: false,
    cancelReason: '',
    confirmedAt: { microsSinceUnixEpoch: 1_700_000_000_000_000n } as unknown,
};

describe('the SpacetimeDB adapter', () => {
    it('connects, saves the token, subscribes to the agent views by their wire names, and reads binding rows', async () => {
        const fake = fakeConnection();
        const saved: string[] = [];
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', saveToken: (t) => saved.push(t), log: recordingLogger() });
        await db.connect();
        assert.equal(await db.ready(1_000), true);
        assert.deepEqual(saved, ['new-token']);
        assert.deepEqual(fake.queries, [
            'SELECT * FROM agent_queue',
            'SELECT * FROM errand_queue',
            'SELECT * FROM call_queue',
            'SELECT * FROM agent_consent',
            'SELECT * FROM device_status',
        ]);
        let changes = 0;
        db.onChange(() => changes++);
        fake.tables.agentQueue.insert(bindingRow);
        fake.tables.agentQueue.insert({ ...bindingRow, jobId: 8n });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(changes, 1, 'one callback per burst of rows');
        const rows = db.agentQueue();
        assert.equal(rows.length, 2);
        assert.equal(rows[0]?.kind, 'errand_preview');
        assert.equal(rows[0]?.status, 'claimed');
        assert.equal(rows[0]?.origin, 'partner');
        assert.equal(rows[0]?.recentErrandSentAtMs, 1_700_000_000_000);
        assert.equal(rows[0]?.createdAtMs, 1_700_000_000_000);
    });

    it('skips a row that lacks a contract field, and says which view', async () => {
        const fake = fakeConnection();
        const log = recordingLogger();
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', log });
        await db.connect();
        const { claimedByMe: _dropped, ...broken } = bindingRow;
        fake.tables.agentQueue.insert(broken);
        assert.deepEqual(db.agentQueue(), []);
        assert.ok(log.entries.some((e) => e.level === 'error' && e.fields.view === 'agent_queue' && e.fields.problem === 'missing field claimed_by_me'));
    });

    it('calls reducers by their generated accessor and maps the SDK errors', async () => {
        const fake = fakeConnection();
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', log: recordingLogger() });
        await db.connect();
        await db.call('agentClaim', { jobId: 5n });
        assert.deepEqual(fake.calls, [{ name: 'agentClaim', args: { jobId: 5n } }]);
        const cases: [Error, string][] = [
            [named('SenderError', 'stale attempt'), 'stale'],
            [named('SenderError', 'not pending'), 'refused'],
            [named('DisconnectedError'), 'disconnected'],
            [named('UnknownCallResultError'), 'unknown_result'],
            [named('InternalError'), 'internal'],
        ];
        for (const [error, kind] of cases) {
            fake.setFailure(error);
            await assert.rejects(db.call('agentClaim', { jobId: 5n }), (e: unknown) => e instanceof DbCallError && e.kind === kind);
        }
        await assert.rejects(db.call('agentDone', { jobId: 5n, attempt: 1, countsJson: '{}' }), (e: unknown) => e instanceof DbCallError && e.kind === 'internal' && /missing from the generated bindings/.test(e.message));
    });

    it('rejects connect, closes, and quotes no path when the identity token cannot be saved', async () => {
        const fake = fakeConnection();
        const log = recordingLogger();
        const saveToken = () => {
            throw Object.assign(new Error("ENOENT: no such file or directory, open '/nonexistent/Leonora-14155550199/.agent-token'"), { code: 'ENOENT' });
        };
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', saveToken, log });
        await assert.rejects(db.connect(), (e: unknown) => e instanceof TokenSaveError && e.code === 'ENOENT' && !/leonora|4155550199/i.test(e.message));
        assert.equal(fake.state.disconnects, 1, 'the connection is closed');
        assert.deepEqual(fake.queries, [], 'nothing was subscribed');
        assert.ok(!/leonora|4155550199/i.test(log.text()));
        assert.ok(log.entries.some((e) => e.level === 'error' && e.fields.code === 'ENOENT'));
    });

    it('knows whether this identity is paired as Agent', async () => {
        const fake = fakeConnection();
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', log: recordingLogger() });
        await db.connect();
        assert.equal(db.isPairedAgent(), false);
        fake.tables.deviceStatus.insert({ identity: { toHexString: () => 'c'.repeat(64) }, role: { tag: 'Agent' } });
        assert.equal(db.isPairedAgent(), true);
    });

    it('reads the time of a call\'s CONFIRM from call_queue, and null when the row does not carry it', async () => {
        const fake = fakeConnection();
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', log: recordingLogger() });
        await db.connect();
        fake.tables.callQueue.insert({ ...callRow, callId: 4n, confirmedAt: { microsSinceUnixEpoch: 1_700_000_000_000_000n } });
        fake.tables.callQueue.insert({ ...callRow, callId: 5n, confirmedAt: undefined });
        const { confirmedAt: _old, ...noTime } = callRow;
        fake.tables.callQueue.insert({ ...noTime, callId: 6n });
        assert.deepEqual(
            db.callQueue().map((r) => [r.callId, r.confirmedAtMs]),
            [
                [4n, 1_700_000_000_000],
                [5n, null],
                [6n, null],
            ],
            'unset, or missing in bindings older than module v2, is unknown',
        );
        assert.equal(toCallQueueRow({ ...callRow, confirmedAt: { toMillis: () => 1_700_000_000_123n } }).confirmedAtMs, 1_700_000_000_123);
        assert.throws(() => toCallQueueRow({ ...callRow, confirmedAt: 'yesterday' }), /expected a timestamp/);
    });

    it('reads the module\'s consent from agent_consent, and knows none without exactly one readable row', async () => {
        const fake = fakeConnection();
        const log = recordingLogger();
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', log });
        await db.connect();
        assert.equal(db.agentConsent(), null, 'no row: not known');
        fake.tables.agentConsent.insert({ sessionId: 8n, memoryAllowed: true, webSearchAllowed: false });
        assert.deepEqual(db.agentConsent(), { sessionId: 8n, memoryAllowed: true, webSearchAllowed: false });
        fake.tables.agentConsent.rows[0] = { sessionId: 8n, webSearchAllowed: true };
        assert.equal(db.agentConsent(), null, 'a row that does not match the contract is not consent');
        assert.ok(log.entries.some((e) => e.level === 'error' && e.fields.view === 'agent_consent' && e.fields.problem === 'missing field memory_allowed'));
        fake.tables.agentConsent.rows = [
            { sessionId: 8n, memoryAllowed: true, webSearchAllowed: true },
            { sessionId: 9n, memoryAllowed: true, webSearchAllowed: true },
        ];
        assert.equal(db.agentConsent(), null, 'two rows: not known');
    });

    it('tells onMemoryOff listeners of every row that turns memory off, also one followed at once by a new grant', async () => {
        const fake = fakeConnection();
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', log: recordingLogger() });
        await db.connect();
        let off = 0;
        let changes = 0;
        db.onMemoryOff(() => off++);
        db.onChange(() => changes++);
        fake.tables.agentConsent.insert({ sessionId: 8n, memoryAllowed: true, webSearchAllowed: true });
        assert.equal(off, 0, 'consent on: nothing to forget');
        // Revoked and given again in one burst: the burst's single change reads memory on, the listener still heard.
        fake.tables.agentConsent.update(0, { sessionId: 8n, memoryAllowed: false, webSearchAllowed: true });
        fake.tables.agentConsent.update(0, { sessionId: 8n, memoryAllowed: true, webSearchAllowed: true });
        assert.equal(off, 1, 'heard at once, inside the update');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(db.agentConsent()?.memoryAllowed, true);
        assert.ok(changes >= 1, 'a change to agent_consent is a change to the views');
        fake.tables.agentConsent.insert({ sessionId: 9n, webSearchAllowed: true });
        assert.equal(off, 2, 'a row that cannot be read counts as memory off');
    });

    // Codex round 2: the row can go (the Agent device revoked) and come back without a reconnect; a revocation, a
    // CONFIRM and a new grant in that gap would otherwise go unseen by a past-request mark (src/requests.ts).
    it('counts a removed agent_consent row as memory off, so a consent mark taken before it no longer holds', async () => {
        const fake = fakeConnection();
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', log: recordingLogger() });
        await db.connect();
        let off = 0;
        db.onMemoryOff(() => off++);
        const watch = new MemoryWatch(db);
        fake.tables.agentConsent.insert({ sessionId: 8n, memoryAllowed: true, webSearchAllowed: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const mark = watch.mark();
        assert.ok(mark, 'memory consent holds');
        fake.tables.agentConsent.remove(0);
        assert.equal(off, 1, 'the row went: what it allowed is no longer known');
        fake.tables.agentConsent.insert({ sessionId: 8n, memoryAllowed: true, webSearchAllowed: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(db.agentConsent()?.memoryAllowed, true);
        assert.equal(watch.heldSince(mark), false);
    });

    it('counts a lost connection or a refused subscription as memory off', async () => {
        const fake = fakeConnection();
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', log: recordingLogger() });
        await db.connect();
        let off = 0;
        db.onMemoryOff(() => off++);
        fake.tables.agentConsent.insert({ sessionId: 8n, memoryAllowed: true, webSearchAllowed: true });
        assert.equal(off, 0);
        (fake.builder.options.onDisconnect as (ctx: unknown, error?: Error) => void)({}, new Error('gone'));
        assert.equal(off, 1, 'a revocation during the outage may never show');
        assert.equal(db.isCurrent(), false);
        fake.state.subscriptionError({});
        assert.equal(off, 2, 'without the subscription no revocation can arrive');
    });

    it('says so when the bindings lack agent_consent, and then knows no consent', async () => {
        const fake = fakeConnection();
        const log = recordingLogger();
        delete (fake.tables as Record<string, unknown>).agentConsent;
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', log });
        await db.connect();
        assert.equal(db.agentConsent(), null);
        assert.ok(log.entries.some((e) => e.level === 'error' && e.fields.view === 'agent_consent' && /not allowed/.test(e.message)));
    });

    it('rejects a value the contract does not know', () => {
        assert.throws(() => toAgentQueueRow({ ...bindingRow, kind: { tag: 'Mystery' } }), /unknown job kind mystery/);
    });
});

describe('calling a reducer over an unreliable network', () => {
    it('sends a call again once the connection is back', async () => {
        const db = new MemoryDb();
        const jobId = db.addOptionsJob({ questionText: 'q' });
        db.connected = false;
        setTimeout(() => db.setConnected(true), 20);
        const outcome = await callReducer(db, 'agentClaim', { jobId }, { onUnknown: 'verify', verify: () => 'unclear' });
        assert.deepEqual(outcome, { ok: true, uncertain: false });
    });

    it('gives up when the connection does not come back in time', async () => {
        const db = new MemoryDb();
        db.connected = false;
        const outcome = await callReducer(db, 'agentClaim', { jobId: 1n }, { onUnknown: 'repeat', readyTimeoutMs: 30 });
        assert.equal(outcome.ok, false);
        assert.equal(!outcome.ok && outcome.kind, 'disconnected');
    });

    it('verifies a claim whose reply was lost, without sending it twice', async () => {
        const db = new MemoryDb();
        const jobId = db.addOptionsJob({ questionText: 'q' });
        db.failNext('agentClaim', 'unknown_result', { applied: true });
        const verify = () => (db.job(jobId)?.status === 'claimed' ? 'applied' : 'not_applied');
        const outcome = await callReducer(db, 'agentClaim', { jobId }, { onUnknown: 'verify', verify, settleMs: 1 });
        assert.deepEqual(outcome, { ok: true, uncertain: true });
        assert.equal(db.attempted.length, 1);
    });

    it('sends a claim again when the lost call did not run', async () => {
        const db = new MemoryDb();
        const jobId = db.addOptionsJob({ questionText: 'q' });
        db.failNext('agentClaim', 'unknown_result', { applied: false });
        const verify = () => (db.job(jobId)?.status === 'claimed' ? 'applied' : 'not_applied');
        const outcome = await callReducer(db, 'agentClaim', { jobId }, { onUnknown: 'verify', verify, settleMs: 1 });
        assert.equal(outcome.ok, true);
        assert.equal(db.attempted.length, 2);
        assert.equal(db.job(jobId)?.attempt, 1);
    });

    it('reports an unclear claim as unknown rather than guessing', async () => {
        const db = new MemoryDb();
        const jobId = db.addOptionsJob({ questionText: 'q' });
        db.failNext('agentClaim', 'unknown_result', { applied: true });
        const outcome = await callReducer(db, 'agentClaim', { jobId }, { onUnknown: 'verify', verify: () => 'unclear', settleMs: 1 });
        assert.equal(!outcome.ok && outcome.kind, 'unknown_result');
    });

    it('never retries a refusal', async () => {
        const db = new MemoryDb();
        const outcome = await callReducer(db, 'agentClaim', { jobId: 99n }, { onUnknown: 'repeat' });
        assert.equal(!outcome.ok && outcome.kind, 'refused');
        assert.equal(db.attempted.length, 1);
    });

    it('maps errors by name, so a second copy of the SDK still works', () => {
        assert.equal(toDbError(named('SenderError', 'stale attempt'), 'x').kind, 'stale');
        assert.equal(toDbError(new Error('boom'), 'x').kind, 'internal');
    });
});

describe('the in-memory module', () => {
    it('fences writes by attempt: a lapsed lease makes the old attempt stale', async () => {
        const db = new MemoryDb();
        const jobId = db.addOptionsJob({ questionText: 'q' });
        await db.call('agentClaim', { jobId });
        db.expireLease(jobId);
        await db.call('agentClaim', { jobId });
        await assert.rejects(
            db.call('agentFail', { jobId, attempt: 1, reasonCode: 'x', reason: 'y' }),
            (e: unknown) => e instanceof DbCallError && e.kind === 'stale',
        );
        await db.call('agentFail', { jobId, attempt: 2, reasonCode: 'x', reason: 'y' });
        assert.equal(db.job(jobId)?.status, 'failed');
    });

    it('refuses an event key under a prefix the module writes, as the module does since v2', async () => {
        const db = new MemoryDb();
        const jobId = db.addOptionsJob({ questionText: 'q' });
        await db.call('agentClaim', { jobId });
        const event = (eventKey: string) => ({ jobId, attempt: 1, eventKey, stage: 'plan' as const, status: 'started' as const, detail: 'claude', ms: 0, countsJson: '{}', payloadJson: '' });
        for (const key of ['s1:read:3', 'q2:select', 'c3:dialing', 'e4:submit', 'listen:5']) {
            await assert.rejects(db.call('agentProgress', event(key)), (e: unknown) => e instanceof DbCallError && e.message === 'event_key uses a prefix the module writes', key);
        }
        await db.call('agentProgress', event(`${jobId}:1:1:plan:started`));
        assert.equal(db.events.length, 1);
    });

    it('refuses a call claim 12 s after its CONFIRM, or with no CONFIRM time, as the module does since v2', async () => {
        let now = 1_000_000;
        const db = new MemoryDb({ now: () => now });
        const fresh = db.addConfirmedCall({ requestId: 'r1', contactId: 'leon', digest: 'fedcba9876543210' });
        const unknown = db.addConfirmedCall({ requestId: 'r2', contactId: 'leon', digest: 'fedcba9876543210', confirmedAtMs: null });
        now += 12_000;
        await assert.rejects(db.call('claimCall', { callId: fresh, digest: 'fedcba9876543210' }), (e: unknown) => e instanceof DbCallError && e.message === 'confirm expired');
        await assert.rejects(db.call('claimCall', { callId: unknown, digest: 'fedcba9876543210' }), (e: unknown) => e instanceof DbCallError && e.message === 'confirm expired');
        const inside = db.addConfirmedCall({ requestId: 'r3', contactId: 'leon', digest: 'fedcba9876543210' });
        now += 11_999;
        await db.call('claimCall', { callId: inside, digest: 'fedcba9876543210' });
        assert.equal(db.calls.get(inside)?.status, 'dialing');
    });

    it('keeps an ended call\'s reason and shows a hold, as the module does since v2', async () => {
        const db = new MemoryDb();
        const callId = db.addConfirmedCall({ requestId: 'r1', contactId: 'leon', digest: 'fedcba9876543210' });
        await db.call('claimCall', { callId, digest: 'fedcba9876543210' });
        await db.call('reportCallStatus', { callId, attempt: 1, status: 'ended', result: 'answered', endReason: '', reasonCode: 'opt_out_hold', reason: 'Leon may not want more calls. Calls to Leon are on hold until someone checks.' });
        assert.equal(db.calls.get(callId)?.reasonCode, 'opt_out_hold');
        assert.match(db.calls.get(callId)?.reason ?? '', /on hold until someone checks/);
        assert.equal(db.held(callId), true);
    });

    it('refuses a search event for a job without web search consent', async () => {
        const db = new MemoryDb();
        const jobId = db.addOptionsJob({ questionText: 'q', webSearchAllowed: false });
        await db.call('agentClaim', { jobId });
        await assert.rejects(
            db.call('agentProgress', { jobId, attempt: 1, eventKey: 'k1', stage: 'search', status: 'started', detail: 'web', ms: 0, countsJson: '{}', payloadJson: '' }),
            (e: unknown) => e instanceof DbCallError && e.kind === 'refused',
        );
    });
});
