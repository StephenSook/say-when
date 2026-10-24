// The SpacetimeDB source's connection lifecycle, against a stub shaped like the spacetimedb 2.13.0 client:
// a builder whose callbacks the test fires by hand, connections with five tables, and subscriptions.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { silentLogger } from '../src/log.js';
import type { SourceHandlers } from '../src/sources/source.js';
import { SpacetimeSource, SUBSCRIBED, type BuilderLike, type ConnectionLike } from '../src/sources/spacetime.js';

type Cb = (...args: unknown[]) => void;

class StubTable {
    readonly rows: unknown[] = [];
    readonly inserts = new Set<Cb>();
    readonly updates = new Set<Cb>();
    iter(): unknown[] {
        return this.rows;
    }
    onInsert(cb: Cb): void {
        this.inserts.add(cb);
    }
    removeOnInsert(cb: Cb): void {
        this.inserts.delete(cb);
    }
    onUpdate(cb: Cb): void {
        this.updates.add(cb);
    }
    removeOnUpdate(cb: Cb): void {
        this.updates.delete(cb);
    }
    insert(row: unknown): void {
        this.rows.push(row);
        for (const cb of [...this.inserts]) cb({}, row);
    }
    get callbacks(): number {
        return this.inserts.size + this.updates.size;
    }
}

interface Subscription {
    queries: string[];
    applied: Cb | null;
    error: Cb | null;
}

class StubConnection implements ConnectionLike {
    readonly db: Record<string, unknown> = {
        boardLedger: new StubTable(),
        scanState: new StubTable(),
        boardErrands: new StubTable(),
        boardCalls: new StubTable(),
        deviceStatus: new StubTable(),
    };
    readonly subscriptions: Subscription[] = [];
    disconnects = 0;

    table(name: string): StubTable {
        return this.db[name] as StubTable;
    }

    subscriptionBuilder() {
        const sub: Subscription = { queries: [], applied: null, error: null };
        const b = {
            onApplied: (cb: Cb) => ((sub.applied = cb), b),
            onError: (cb: Cb) => ((sub.error = cb), b),
            subscribe: (queries: string[]) => {
                sub.queries = queries;
                this.subscriptions.push(sub);
                return {};
            },
        };
        return b;
    }

    disconnect(): void {
        this.disconnects++;
    }
}

interface Built {
    conn: StubConnection;
    connect: Cb;
    connectError: Cb;
    disconnect: Cb;
}

class StubSdk {
    readonly built: Built[] = [];
    readonly builder = (): BuilderLike => {
        const hooks: Partial<Record<'connect' | 'reconnect' | 'connectError' | 'disconnect', Cb>> = {};
        const b: BuilderLike = {
            withUri: () => b,
            withDatabaseName: () => b,
            withAutomaticReconnect: () => b,
            onConnect: (cb) => ((hooks.connect = cb as Cb), b),
            onAutomaticReconnect: (cb) => ((hooks.reconnect = cb as Cb), b),
            onConnectError: (cb) => ((hooks.connectError = cb as Cb), b),
            onDisconnect: (cb) => ((hooks.disconnect = cb as Cb), b),
            build: () => {
                const conn = new StubConnection();
                this.built.push({ conn, connect: hooks.connect!, connectError: hooks.connectError!, disconnect: hooks.disconnect! });
                return conn;
            },
        };
        return b;
    };
}

function recorder() {
    const seen = { ledger: 0, scan: 0, action: 0, device: 0, ready: 0, lost: [] as string[] };
    const handlers: SourceHandlers = {
        ledger: () => void seen.ledger++,
        scan: () => void seen.scan++,
        action: () => void seen.action++,
        device: () => void seen.device++,
        ready: () => void seen.ready++,
        lost: (reason) => void seen.lost.push(reason),
    };
    return { seen, handlers };
}

function ledgerRow(id: bigint) {
    const t = { microsSinceUnixEpoch: 1_761_300_000_000_000n };
    return {
        id,
        sessionId: 1n,
        at: t,
        kind: 'gesture',
        actor: 'station',
        questionId: 0n,
        optionId: 0n,
        errandId: 0n,
        callId: 0n,
        jobId: 0n,
        gestureId: `g-${id}`,
        command: 'NO',
        stepSeq: 0n,
        cursor: 0,
        digest: '',
        outcome: 'ignored:idle',
        reason: 'idle',
        ms: 0,
    };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function source(sdk: StubSdk) {
    return new SpacetimeSource({ uri: 'https://example.invalid', database: 'say-when-dev', builder: sdk.builder, log: silentLogger, retryDelaysMs: [0] });
}

describe('the SpacetimeDB source lifecycle', () => {
    test('subscribes to the five public tables and hands rows over, read-only', async () => {
        const sdk = new StubSdk();
        const { seen, handlers } = recorder();
        const src = source(sdk);
        await src.start(handlers);
        const first = sdk.built[0]!;
        first.connect(first.conn, {}, 'token');
        assert.deepEqual(first.conn.subscriptions[0]?.queries, Object.values(SUBSCRIBED).map((t) => `SELECT * FROM ${t}`));
        first.conn.table('boardLedger').insert(ledgerRow(1n));
        assert.equal(seen.ledger, 1);
        first.conn.subscriptions[0]!.applied!({});
        assert.equal(seen.ready, 1);
        assert.equal(seen.ledger, 2, 'the cache is replayed on apply; the tracker drops the repeat');
        first.conn.table('boardLedger').insert({ id: 2n });
        assert.equal(src.counters.contractErrors, 1, 'a row missing fields is counted, never passed on');
        src.stop();
        assert.equal(first.conn.table('boardLedger').callbacks, 0);
    });

    test('a connection that completes after stop is retired: no subscription, no rows, no ready', async () => {
        const sdk = new StubSdk();
        const { seen, handlers } = recorder();
        const src = source(sdk);
        await src.start(handlers);
        const first = sdk.built[0]!;
        src.stop();
        assert.equal(first.conn.disconnects, 1, 'the pending connection is closed at stop');
        first.connect(first.conn, {}, 'token');
        assert.equal(first.conn.subscriptions.length, 0);
        assert.equal(first.conn.table('boardLedger').callbacks, 0);
        first.conn.table('boardLedger').insert(ledgerRow(1n));
        assert.deepEqual(seen, { ledger: 0, scan: 0, action: 0, device: 0, ready: 0, lost: [] });
        await tick();
        assert.equal(sdk.built.length, 1, 'nothing is rebuilt after stop');
    });

    test('after a rebuild, the old connection is closed and its late callbacks are ignored', async () => {
        const sdk = new StubSdk();
        const { seen, handlers } = recorder();
        const src = source(sdk);
        await src.start(handlers);
        const first = sdk.built[0]!;
        first.connectError({}, new Error('refused'), undefined); // the SDK will not retry a failed first connection
        assert.deepEqual(seen.lost, ['connect_error']);
        assert.equal(first.conn.disconnects, 1);
        await tick();
        assert.equal(sdk.built.length, 2, 'a new connection is built after the wait');
        first.connect(first.conn, {}, 'token');
        first.disconnect({}, new Error('late'), undefined);
        assert.equal(first.conn.subscriptions.length, 0);
        assert.deepEqual(seen.lost, ['connect_error'], 'a stale connection reports nothing');
        assert.equal(sdk.built.length, 2, 'and triggers no rebuild');
        const second = sdk.built[1]!;
        second.connect(second.conn, {}, 'token');
        second.conn.subscriptions[0]!.applied!({});
        second.conn.table('boardLedger').insert(ledgerRow(5n));
        assert.equal(seen.ready, 1);
        assert.equal(seen.ledger, 1);
        src.stop();
    });

    test("retiring a stale connection never removes the current connection's callbacks", async () => {
        const sdk = new StubSdk();
        const { handlers } = recorder();
        const src = source(sdk);
        await src.start(handlers);
        const first = sdk.built[0]!;
        first.connectError({}, new Error('refused'), undefined);
        await tick();
        const second = sdk.built[1]!;
        second.connect(second.conn, {}, 'token');
        assert.equal(second.conn.table('boardLedger').callbacks, 2);
        first.connect(first.conn, {}, 'token'); // stale: retired on arrival
        assert.equal(second.conn.table('boardLedger').callbacks, 2);
        src.stop();
        assert.equal(second.conn.table('boardLedger').callbacks, 0, 'stop removes exactly the callbacks it registered');
        assert.equal(second.conn.disconnects, 1);
    });

    test('a refused subscription starts over with a new connection', async () => {
        const sdk = new StubSdk();
        const { seen, handlers } = recorder();
        const src = source(sdk);
        await src.start(handlers);
        const first = sdk.built[0]!;
        first.connect(first.conn, {}, 'token');
        first.conn.subscriptions[0]!.error!({});
        assert.deepEqual(seen.lost, ['subscription_error']);
        assert.equal(first.conn.disconnects, 1);
        assert.equal(first.conn.table('boardLedger').callbacks, 0);
        await tick();
        assert.equal(sdk.built.length, 2);
        src.stop();
    });

    test('a drop the SDK will retry keeps the connection; one it will not retry rebuilds it', async () => {
        const sdk = new StubSdk();
        const { seen, handlers } = recorder();
        const src = source(sdk);
        await src.start(handlers);
        const first = sdk.built[0]!;
        first.connect(first.conn, {}, 'token');
        first.disconnect({}, new Error('network'), 1, 1000);
        assert.deepEqual(seen.lost, ['disconnect']);
        assert.equal(first.conn.disconnects, 0, 'the SDK reconnects this one itself');
        await tick();
        assert.equal(sdk.built.length, 1);
        first.disconnect({}, new Error('gone'), undefined);
        assert.equal(first.conn.disconnects, 1);
        await tick();
        assert.equal(sdk.built.length, 2);
        src.stop();
    });
});
