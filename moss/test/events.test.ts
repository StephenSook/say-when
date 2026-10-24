import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { MemoryStore } from '../src/memory.js';
import { MossRun } from '../src/session.js';
import { WebIndex } from '../src/web.js';
import { FakeMoss, FakeTimers, TEST_PROJECT_ID, TEST_PROJECT_KEY, harness, tempDir, testEnv } from './fake.js';

const OPS = new Set([
    'open session',
    'close session',
    'inspect snapshot',
    'memory add',
    'memory recall',
    'memory affinity',
    'memory write back',
    'web index',
    'web search',
    'web forget',
]);

describe('pipeline events', () => {
    let dir = '';
    beforeEach(() => {
        dir = tempDir();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('carry no memory, question or web text, no partner ids and no credentials', async () => {
        const { events, run } = harness(dir);
        await run.start();
        const memory = new MemoryStore(run, { scoreFloor: 0.1 });
        const web = new WebIndex(run);
        await memory.add([{ type: 'pref', text: 'Zanzibar marmalade on rye toast.' }]);
        await memory.writeBack({ question: 'Quixotic breakfast plan?', reply: 'Xylophone pancakes please.', partnerId: 'partner-maria' });
        const recall = await memory.recall('Quixotic breakfast plan?', 'partner-maria');
        assert.ok(recall.hits.length >= 1, 'the memory was found, so its absence below means something');
        await memory.affinity([{ id: 'o1', text: 'Xylophone pancakes please.' }], 'partner-maria');
        await web.index('q1', [
            { id: 'w1', source: 'web', title: 'Jabberwocky diner', text: 'Vorpal waffles served daily.', url: 'https://diner.example/menu', fetchedAt: '2026-10-24T18:00:00.000Z' },
        ]);
        assert.equal((await web.search('q1', 'vorpal waffles')).hits.length, 1);
        await web.forget('q1');
        await run.close();

        const dump = JSON.stringify(events);
        for (const secret of [
            'Zanzibar',
            'marmalade',
            'Quixotic',
            'Xylophone',
            'pancakes',
            'partner-maria',
            'Jabberwocky',
            'Vorpal',
            'waffles',
            'diner.example',
            TEST_PROJECT_ID,
            TEST_PROJECT_KEY,
        ]) {
            assert.ok(!dump.includes(secret), `an event holds ${secret}`);
        }
        for (const event of events) {
            assert.equal(event.stage, 'retrieve');
            assert.ok(OPS.has(event.detail), event.detail);
            assert.ok(event.status === 'started' ? event.ms === null : typeof event.ms === 'number');
        }
        assert.equal(events.filter((event) => event.status === 'started').length, 9);
        assert.equal(events.filter((event) => event.status === 'ok').length, 9);
    });

    it("report Moss's own timing beside wall time", async () => {
        const { events, run } = harness(dir);
        await run.start();
        await new MemoryStore(run).recall('Anything new?', 'maria');
        const ok = events.find((event) => event.detail === 'memory recall' && event.status === 'ok');
        assert.equal(ok?.counts?.mossMs, 1.5);
        assert.equal(typeof ok?.ms, 'number');
        await run.close();
    });

    it('name a paused project plainly, and the call still fails', async () => {
        const { moss, events, run } = harness(dir);
        await run.start();
        const paused = Object.assign(new Error("The project's usage limit has been reached; billing must be updated before it can be used."), {
            code: 'UNAUTHORIZED',
        });
        moss.session.failures.set('query', paused);
        await assert.rejects(new MemoryStore(run).recall('Anything new?', 'maria'), /usage limit/);
        assert.ok(events.some((event) => event.status === 'error' && event.detail === 'Moss paused: usage limit reached'));
        await run.close();
    });

    it('do not break retrieval when the dashboard sink throws', async () => {
        const moss = new FakeMoss();
        const run = new MossRun({
            env: testEnv(dir),
            connect: moss.connect,
            timers: new FakeTimers(),
            onEvent: () => {
                throw new Error('dashboard down');
            },
        });
        const warn = mock.method(console, 'warn', () => {});
        try {
            await run.start();
            const recall = await new MemoryStore(run).recall('Anything new?', 'maria');
            assert.deepEqual(recall.hits, []);
            assert.ok(warn.mock.callCount() > 0);
            await run.close();
        } finally {
            warn.mock.restore();
        }
    });

    it('contain an async sink that rejects, so the process never sees an unhandled rejection', async () => {
        const moss = new FakeMoss();
        const run = new MossRun({
            env: testEnv(dir),
            connect: moss.connect,
            timers: new FakeTimers(),
            onEvent: async () => {
                throw new Error('dashboard write failed');
            },
        });
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        const warn = mock.method(console, 'warn', () => {});
        try {
            await run.start();
            await new MemoryStore(run).recall('Anything new?', 'maria');
            await run.close();
            await new Promise((resolve) => setTimeout(resolve, 10));
            assert.equal(unhandled.length, 0);
            assert.ok(warn.mock.callCount() > 0);
        } finally {
            warn.mock.restore();
            process.off('unhandledRejection', onUnhandled);
        }
    });
});
