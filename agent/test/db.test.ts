import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DbCallError, toDbError } from '../src/db/db.js';
import { MemoryDb } from '../src/db/memory-db.js';
import { callReducer } from '../src/db/retry.js';
import { SpacetimeAgentDb, toAgentQueueRow, TokenSaveError, type BuilderLike, type ConnectionLike } from '../src/db/spacetime-db.js';
import { recordingLogger } from '../src/log.js';

const named = (name: string, message = '') => Object.assign(new Error(message), { name });

class FakeTable {
    rows: unknown[] = [];
    private readonly listeners = new Set<(...args: unknown[]) => void>();
    iter() {
        return this.rows;
    }
    onInsert(cb: (...args: unknown[]) => void) {
        this.listeners.add(cb);
    }
    removeOnInsert(cb: (...args: unknown[]) => void) {
        this.listeners.delete(cb);
    }
    onDelete(cb: (...args: unknown[]) => void) {
        this.listeners.add(cb);
    }
    removeOnDelete(cb: (...args: unknown[]) => void) {
        this.listeners.delete(cb);
    }
    insert(row: unknown) {
        this.rows.push(row);
        for (const cb of this.listeners) cb({}, row);
    }
}

function fakeConnection() {
    const calls: { name: string; args: unknown }[] = [];
    const queries: string[] = [];
    const tables: Record<string, FakeTable> & { agentQueue: FakeTable; deviceStatus: FakeTable; boardCalls: FakeTable } = {
        agentQueue: new FakeTable(),
        errandQueue: new FakeTable(),
        callQueue: new FakeTable(),
        deviceStatus: new FakeTable(),
        boardCalls: new FakeTable(),
    };
    let failWith: Error | null = null;
    const state = { disconnects: 0 };
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
                onError() {
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
        onDisconnect() {
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
            'SELECT * FROM device_status',
            'SELECT * FROM board_calls',
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

    it('reads the time of a call\'s CONFIRM from board_calls, and null when it is not known', async () => {
        const fake = fakeConnection();
        const log = recordingLogger();
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', log });
        await db.connect();
        fake.tables.boardCalls.insert({ callId: 4n, status: { tag: 'Confirmed' }, confirmedAt: { microsSinceUnixEpoch: 1_700_000_000_000_000n } });
        fake.tables.boardCalls.insert({ callId: 5n, status: { tag: 'AwaitingConfirm' }, confirmedAt: undefined });
        assert.equal(db.callConfirmedAt(4n), 1_700_000_000_000);
        assert.equal(db.callConfirmedAt(5n), null);
        assert.equal(db.callConfirmedAt(6n), null);
        fake.tables.boardCalls.rows.unshift({ status: { tag: 'Confirmed' } });
        assert.equal(db.callConfirmedAt(4n), null, 'a row that does not match the contract makes the time unknown');
        assert.ok(log.entries.some((e) => e.level === 'error' && e.fields.view === 'board_calls' && e.fields.problem === 'missing field call_id'));
    });

    it('says so when the bindings lack board_calls, and then knows no CONFIRM time', async () => {
        const fake = fakeConnection();
        const log = recordingLogger();
        delete (fake.tables as Record<string, unknown>).boardCalls;
        const db = new SpacetimeAgentDb({ builder: () => fake.builder, uri: 'https://example.test', database: 'say-when-dev', log });
        await db.connect();
        assert.equal(db.callConfirmedAt(4n), null);
        assert.ok(log.entries.some((e) => e.level === 'error' && e.fields.view === 'board_calls'));
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
