import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { inspect } from 'node:util';

import { MemoryStore } from '../src/memory.js';
import { DEFAULT_IDLE_CLOSE_MS, MossCallError, MossRun, MossRunError, closeOnSignals, withRun, type MossDoc } from '../src/session.js';
import { WebIndex, type SearchRow } from '../src/web.js';
import { FAKE_SNAPSHOT_FILE, FakeMoss, FakeTimers, TEST_PROJECT_KEY, harness, tempDir, testEnv } from './fake.js';

const isRunError = (code: string) => (error: unknown) => error instanceof MossRunError && error.code === code;

const page: SearchRow = {
    id: 'w1',
    source: 'web',
    title: 'Cafe hours',
    text: 'The cafe opens at seven. It closes at three.',
    url: 'https://cafe.example/hours',
    fetchedAt: '2026-10-24T18:00:00.000Z',
    rank: 1,
};

const snapshotDocs = (dir: string): MossDoc[] => JSON.parse(readFileSync(join(dir, 'say-when', FAKE_SNAPSHOT_FILE), 'utf8')) as MossDoc[];

describe('starting a run', () => {
    let dir = '';
    beforeEach(() => {
        dir = tempDir();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('opens nothing until start is called', async () => {
        const { moss, run } = harness(dir);
        const memory = new MemoryStore(run);
        const web = new WebIndex(run);
        await assert.rejects(memory.recall('Want a coffee?', 'maria'), isRunError('not_open'));
        await assert.rejects(web.index('q1', [page]), isRunError('not_open'));
        assert.equal(moss.clients.length, 0);
        assert.equal(run.isOpen, false);
        assert.equal(await run.close(), null);
    });

    it('refuses bad settings before it connects to Moss', async () => {
        const bad = [
            { MOSS_SNAPSHOT_DIR: dir },
            testEnv('relative/memory'),
            testEnv(dir, { MOSS_SESSION_NAME: 'Maria Lopez' }),
            testEnv(dir, { MOSS_SESSION_NAME: '../outside' }),
            testEnv(dir, { MOSS_IDLE_CLOSE_MS: '0' }),
            testEnv(dir, { MOSS_IDLE_CLOSE_MS: String(60 * 60 * 1000) }),
        ];
        for (const env of bad) {
            const moss = new FakeMoss();
            const run = new MossRun({ env, connect: moss.connect, timers: new FakeTimers() });
            await assert.rejects(run.start(), isRunError('config'));
            assert.equal(moss.clients.length, 0);
        }
    });

    it('opens one session under a neutral name and arms the idle close', async () => {
        const { moss, timers, run } = harness(dir);
        const info = await run.start();
        assert.equal(info.sessionName, 'say-when');
        assert.equal(info.firstRun, true);
        assert.equal(info.restored, 0);
        assert.equal(typeof info.openMs, 'number');
        assert.equal(moss.clients.length, 1);
        assert.equal(moss.clients[0].projectKey, TEST_PROJECT_KEY);
        assert.equal(moss.session.name, 'say-when');
        assert.equal(moss.session.modelId, 'moss-minilm');
        assert.deepEqual(timers.delays(), [DEFAULT_IDLE_CLOSE_MS]);
        await assert.rejects(run.start(), isRunError('already_open'));
        assert.equal(moss.clients.length, 1);
        await run.close();
    });

    it('fails the start on a damaged snapshot, closes the client, and leaves the snapshot alone', async () => {
        mkdirSync(join(dir, 'say-when'), { recursive: true });
        writeFileSync(join(dir, 'say-when', FAKE_SNAPSHOT_FILE), 'not a snapshot');
        const { moss, events, run } = harness(dir);
        await assert.rejects(run.start(), (error: unknown) => error instanceof MossCallError && error.code === 'DESERIALIZATION');
        assert.equal(moss.clients[0].closed, true);
        assert.equal(run.isOpen, false);
        assert.equal(readFileSync(join(dir, 'say-when', FAKE_SNAPSHOT_FILE), 'utf8'), 'not a snapshot');
        assert.ok(events.some((event) => event.status === 'error' && event.detail === 'open session failed: DESERIALIZATION'));
        assert.equal(await run.close(), null);
    });

    it('lets Stop win over a Start queued behind a close', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const closing = run.close();
        const starting = run.start();
        const stopped = run.close();
        await closing;
        await assert.rejects(starting, isRunError('cancelled'));
        assert.equal(await stopped, null);
        assert.equal(run.isOpen, false);
        assert.equal(moss.clients.length, 1);
    });

    it('refuses a second Start while a run is open, and Stop still closes the open run', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const duplicate = run.start();
        const stopped = run.close();
        await assert.rejects(duplicate, isRunError('already_open'));
        const info = await stopped;
        assert.equal(info?.reason, 'stop');
        assert.equal(run.isOpen, false);
        assert.equal(moss.clients[0].closed, true);
        assert.equal(moss.clients.length, 1);
    });

    it('cancels a start when Stop comes before it connects, so no client opens', async () => {
        const { moss, run } = harness(dir);
        const starting = run.start();
        const stopped = run.close();
        await assert.rejects(starting, isRunError('cancelled'));
        assert.equal(await stopped, null);
        assert.equal(moss.clients.length, 0);
        assert.equal(run.isOpen, false);
        await run.start();
        assert.equal(run.isOpen, true);
        await run.close();
    });

    it('closes a run right after it opens when Stop comes while it is connecting', async () => {
        const moss = new FakeMoss();
        let reached = (): void => {};
        const connecting = new Promise<void>((resolve) => {
            reached = resolve;
        });
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const run = new MossRun({
            env: testEnv(dir),
            timers: new FakeTimers(),
            connect: async (projectId, projectKey) => {
                reached();
                await gate;
                return moss.connect(projectId, projectKey);
            },
        });
        const starting = run.start();
        await connecting;
        const stopped = run.close();
        release();
        await starting;
        const info = await stopped;
        assert.equal(info?.reason, 'stop');
        assert.equal(run.isOpen, false);
        assert.equal(moss.clients[0].closed, true);
    });

    it('opens one client even when an event sink calls start or close in the middle of a start', async () => {
        const moss = new FakeMoss();
        const reentered: Array<Promise<unknown>> = [];
        const run: MossRun = new MossRun({
            env: testEnv(dir),
            connect: moss.connect,
            timers: new FakeTimers(),
            onEvent: (event) => {
                if (event.detail === 'open session' && event.status === 'started') reentered.push(run.start().catch((error: unknown) => error));
            },
        });
        await run.start();
        assert.ok(isRunError('already_open')((await Promise.all(reentered))[0]));
        assert.equal(moss.clients.length, 1);
        await run.close();
        assert.equal(moss.clients[0].closed, true);

        const stopper = new FakeMoss();
        const stops: Array<Promise<unknown>> = [];
        const other: MossRun = new MossRun({
            env: testEnv(dir),
            connect: stopper.connect,
            timers: new FakeTimers(),
            onEvent: (event) => {
                if (event.detail === 'open session' && event.status === 'started') stops.push(other.close());
            },
        });
        await other.start();
        await Promise.all(stops);
        assert.equal(other.isOpen, false);
        assert.equal(stopper.clients[0].closed, true);
    });

    it('asks for a restart when the session failed to open, since the SDK may still hold it', async () => {
        const moss = new FakeMoss();
        moss.sessionFailure = Object.assign(new Error('model load failed'), { code: 'MODEL_UNAVAILABLE' });
        const run = new MossRun({ env: testEnv(dir), connect: moss.connect, timers: new FakeTimers() });
        await assert.rejects(run.start(), (error: unknown) => error instanceof MossCallError && error.code === 'MODEL_UNAVAILABLE');
        assert.equal(moss.clients[0].closed, true);
        moss.sessionFailure = null;
        await assert.rejects(run.start(), isRunError('restart_needed'));
        assert.equal(moss.clients.length, 1);
    });
});

describe('closing a run', () => {
    let dir = '';
    beforeEach(() => {
        dir = tempDir();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('closes by itself after the idle time, and every Moss call resets the clock', async () => {
        const { moss, timers, run } = harness(dir, { MOSS_IDLE_CLOSE_MS: '60000' });
        await run.start();
        const armedAtStart = [...timers.pending.keys()];
        const memory = new MemoryStore(run);
        const recalling = memory.recall('Want a coffee?', 'maria');
        const armedDuringCall = [...timers.pending.keys()];
        await recalling;
        const armedAfterCall = [...timers.pending.keys()];
        assert.equal(armedAtStart.length, 1);
        assert.equal(armedDuringCall.length, 1);
        assert.equal(armedAfterCall.length, 1);
        assert.notEqual(armedDuringCall[0], armedAtStart[0], 'the call re-armed the idle timer as it began');
        assert.notEqual(armedAfterCall[0], armedDuringCall[0], 'and again as it ended');
        assert.deepEqual(timers.delays(), [60000]);
        timers.fireAll();
        const info = await run.close(); // joins the idle close already under way
        assert.equal(info?.reason, 'idle');
        assert.equal(info?.clientClosed, true);
        assert.equal(moss.clients[0].closed, true);
        assert.equal(run.isOpen, false);
        assert.equal(timers.pending.size, 0);
        await assert.rejects(memory.recall('Still there?', 'maria'), isRunError('not_open'));
    });

    it('removes web passages and saves a memory-only snapshot that the next run restores', async () => {
        const first = harness(dir);
        await first.run.start();
        const memory = new MemoryStore(first.run, { scoreFloor: 0.3 });
        await memory.add([{ type: 'pref', text: 'I take coffee black with no sugar.' }]);
        await memory.writeBack({ question: 'Want a coffee?', reply: 'Yes, black, no sugar.', partnerId: 'maria' });
        await new WebIndex(first.run).index('q1', [page]);
        const closed = await first.run.close();
        assert.equal(closed?.saved, true);
        assert.equal(closed?.memoryOnly, true);
        assert.equal(closed?.purged, 1);
        const saved = snapshotDocs(dir);
        assert.equal(saved.length, 2);
        assert.ok(saved.every((doc) => doc.metadata?.kind === 'memory'));

        const second = harness(dir);
        const started = await second.run.start();
        assert.equal(started.firstRun, false);
        assert.equal(started.restored, 2);
        const recall = await new MemoryStore(second.run, { scoreFloor: 0.3 }).recall('Want a coffee now?', 'maria');
        assert.deepEqual(recall.instant, ['Yes, black, no sugar.']);
        await second.run.close();
    });

    it('saves the memory even when removing web passages fails, and the next start removes them first', async () => {
        const first = harness(dir);
        await first.run.start();
        await new MemoryStore(first.run).add([{ type: 'pref', text: 'Call me Sam.' }]);
        await new WebIndex(first.run).index('q1', [page]);
        first.moss.session.failures.set('getDocs', Object.assign(new Error('getDocs failed'), { code: 'INTERNAL' }));
        const closed = await first.run.close();
        assert.equal(closed?.saved, true);
        assert.equal(closed?.memoryOnly, false);
        assert.equal(snapshotDocs(dir).length, 2);

        const second = harness(dir);
        const started = await second.run.start();
        assert.equal(started.restored, 1);
        assert.deepEqual(
            [...second.moss.session.docs.values()].map((doc) => doc.metadata?.kind),
            ['memory'],
        );
        await second.run.close();
    });

    it('waits for a write back already under way before saving', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const memory = new MemoryStore(run);
        const release = moss.session.hold('addDocs');
        const writing = memory.writeBack({ question: 'Window open?', reply: 'Yes, a little.', partnerId: 'maria' });
        const closing = run.close();
        await assert.rejects(memory.recall('Window?', 'maria'), isRunError('not_open'));
        release();
        await writing;
        const info = await closing;
        assert.equal(info?.saved, true);
        assert.deepEqual(
            snapshotDocs(dir).map((doc) => doc.text),
            ['Q: Window open?\nA: Yes, a little.'],
        );
    });

    it('closes in a finally path when the work throws, and still saves the memory', async () => {
        const moss = new FakeMoss();
        await assert.rejects(
            withRun({ env: testEnv(dir), connect: moss.connect, timers: new FakeTimers() }, async (run) => {
                await new MemoryStore(run).add([{ type: 'pref', text: 'Call me Sam.' }]);
                throw new Error('planner crashed');
            }),
            /planner crashed/,
        );
        assert.equal(moss.clients[0].closed, true);
        assert.equal(snapshotDocs(dir).length, 1);
    });

    it('closes on Ctrl-C before the process exits', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const proc = Object.assign(new EventEmitter(), { exit: (_code: number): void => {} });
        const exited = new Promise<number>((resolve) => {
            proc.exit = resolve;
        });
        const remove = closeOnSignals(run, proc);
        proc.emit('SIGINT', 'SIGINT');
        assert.equal(await exited, 130);
        assert.equal(moss.clients[0].closed, true);
        remove();
        assert.equal(proc.listenerCount('SIGTERM'), 0);
    });

    it('is safe to close twice, and a new start opens a fresh session', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        assert.notEqual(await run.close(), null);
        assert.equal(await run.close(), null);
        assert.equal(moss.clients[0].closeCalls, 1);
        await run.start();
        assert.equal(moss.clients.length, 2);
        assert.equal(run.generation, 2);
        await run.close();
        assert.equal(run.meter().open, false);
        assert.equal(run.meter().runs, 2);
    });

    it('still closes the client when saving fails, and says so', async () => {
        const { moss, events, run } = harness(dir);
        moss.onSession = (session) => session.failures.set('saveToDisk', Object.assign(new Error('disk full'), { code: 'INTERNAL' }));
        await run.start();
        const info = await run.close();
        assert.equal(info?.saved, false);
        assert.equal(info?.clientClosed, true);
        assert.equal(moss.clients[0].closed, true);
        assert.ok(events.some((event) => event.status === 'error' && event.detail === 'close session failed: INTERNAL'));
    });

    it('refuses a new start after the SDK fails to close, so a second session never opens beside the first', async () => {
        const { moss, events, run } = harness(dir);
        await run.start();
        moss.clients[0].closeFailure = Object.assign(new Error('native close failed'), { code: 'INTERNAL' });
        const info = await run.close();
        assert.equal(info?.clientClosed, false);
        assert.equal(info?.saved, true);
        assert.equal(run.isOpen, false);
        await assert.rejects(run.start(), isRunError('restart_needed'));
        assert.equal(moss.clients.length, 1);
        assert.ok(events.some((event) => event.status === 'error' && event.detail === 'close session failed: INTERNAL'));
    });

    it('throws content-free errors and keeps the SDK error out of the logged form', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        moss.session.failures.set('query', Object.assign(new Error('bad document Xylophone pancakes please'), { code: 'INVALID_ARGUMENT' }));
        const error: unknown = await new MemoryStore(run).recall('Anything new?', 'maria').then(
            () => null,
            (thrown: unknown) => thrown,
        );
        assert.ok(error instanceof MossCallError);
        assert.equal(error.message, 'memory recall failed: INVALID_ARGUMENT');
        assert.equal(error.code, 'INVALID_ARGUMENT');
        assert.ok(!inspect(error).includes('Xylophone'));
        assert.ok(!JSON.stringify(error).includes('Xylophone'));
        assert.match((error.original as Error).message, /Xylophone/);
        await run.close();
    });

    it('counts held session time on the meter', async () => {
        let now = 1_000_000;
        const moss = new FakeMoss();
        const run = new MossRun({ env: testEnv(dir), connect: moss.connect, timers: new FakeTimers(), now: () => now });
        await run.start();
        now += 90_000;
        assert.equal(run.meter().heldMs, 90_000);
        const info = await run.close();
        assert.equal(info?.heldMs, 90_000);
        assert.equal(run.meter().totalHeldMs, 90_000);
    });

    it('describes the snapshot on disk for the "never leaves this laptop" line', async () => {
        const first = harness(dir);
        await first.run.start();
        assert.equal(await first.run.snapshotInfo(), null);
        await new MemoryStore(first.run).add([{ type: 'pref', text: 'Call me Sam.' }]);
        await first.run.close();
        const second = harness(dir);
        await second.run.start();
        const info = await second.run.snapshotInfo();
        assert.equal(info?.docCount, 1);
        assert.equal(info?.modelId, 'moss-minilm');
        await second.run.close();
    });
});
