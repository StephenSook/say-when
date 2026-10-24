import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MemoryStore, type Affinity } from '../src/memory.js';
import { ScanCounter, orderOptions, rankOptions, readBefore, type CandidateOption } from '../src/rank.js';
import { harness, tempDir } from './fake.js';

const options: CandidateOption[] = [
    { id: 'a', text: 'Yes please', support: 0.9 },
    { id: 'b', text: 'Maybe later', support: 0.5 },
    { id: 'c', text: 'Black coffee, no sugar', support: 0.2 },
    { id: 'more', text: 'Something else', last: true },
];

const affinities: Affinity[] = [
    { optionId: 'c', score: 0.95, evidence: ['mem:reply:0123456789abcdef'], mossMs: 1 },
    { optionId: 'a', score: 0, evidence: [], mossMs: 1 },
    { optionId: 'b', score: 0, evidence: [], mossMs: 1 },
];

const ids = (order: Array<{ id: string }>): string[] => order.map((option) => option.id);

describe('ordering', () => {
    it('orders by memory when the toggle is on and by support alone when it is off', () => {
        const ordering = orderOptions(options, affinities);
        assert.deepEqual(ids(ordering.withoutMemory), ['a', 'b', 'c', 'more']);
        assert.deepEqual(ids(ordering.withMemory), ['c', 'a', 'b', 'more']);
        assert.deepEqual(ordering.withMemory[0].evidence, ['mem:reply:0123456789abcdef']);
        assert.ok(Math.abs(ordering.withMemory[0].score - (0.6 * 0.95 + 0.4 * 0.2)) < 1e-9);
    });

    it("keeps escape options last even with strong memory, and ties in the planner's order", () => {
        const ordering = orderOptions(
            [
                { id: 'x', text: 'One' },
                { id: 'more', text: 'More', last: true },
                { id: 'y', text: 'Two' },
                { id: 'else', text: 'Something else', last: true },
            ],
            [{ optionId: 'more', score: 1, evidence: [], mossMs: null }],
        );
        assert.deepEqual(ids(ordering.withMemory), ['x', 'y', 'more', 'else']);
        assert.deepEqual(ids(ordering.withoutMemory), ['x', 'y', 'more', 'else']);
    });

    it('refuses repeated option ids', () => {
        assert.throws(
            () =>
                orderOptions(
                    [
                        { id: 'a', text: 'Yes' },
                        { id: 'a', text: 'No' },
                    ],
                    [],
                ),
            RangeError,
        );
    });
});

describe('the counter', () => {
    it('counts options read before the chosen one, with and without memory', () => {
        const ordering = orderOptions(options, affinities);
        const counter = new ScanCounter();
        assert.deepEqual(counter.record(ordering, 'c'), { withMemory: 0, withoutMemory: 2 });
        assert.deepEqual(counter.record(ordering, 'a'), { withMemory: 1, withoutMemory: 0 });
        assert.deepEqual(counter.totals(), { questions: 2, withMemory: 1, withoutMemory: 2, saved: 1 });
        assert.equal(readBefore(ordering.withMemory, 'more'), 3);
        assert.throws(() => counter.record(ordering, 'missing'), RangeError);
        counter.reset();
        assert.equal(counter.totals().questions, 0);
    });
});

describe('ranking with memory', () => {
    let dir = '';
    beforeEach(() => {
        dir = tempDir();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('moves an option up after one confirmed reply', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const memory = new MemoryStore(run, { scoreFloor: 0.4 });
        const planned: CandidateOption[] = [
            { id: 'o1', text: 'Yes, a latte please', support: 0.6 },
            { id: 'o2', text: 'Yes, black, no sugar', support: 0.5 },
            { id: 'o3', text: 'No thanks', support: 0.4 },
            { id: 'more', text: 'Something else', last: true },
        ];
        const before = await rankOptions(memory, 'maria', planned);
        assert.deepEqual(ids(before.withMemory), ['o1', 'o2', 'o3', 'more']);
        await memory.writeBack({ question: 'Want a coffee?', reply: 'Yes, black, no sugar.', partnerId: 'maria' });
        const after = await rankOptions(memory, 'maria', planned);
        assert.deepEqual(ids(after.withMemory), ['o2', 'o1', 'o3', 'more']);
        assert.deepEqual(ids(after.withoutMemory), ['o1', 'o2', 'o3', 'more']);
        assert.deepEqual(new ScanCounter().record(after, 'o2'), { withMemory: 0, withoutMemory: 1 });
        // The escape option never costs a query.
        const affinityQueries = moss.session.calls.filter((call) => call.method === 'query' && call.args[0] === 'Something else');
        assert.equal(affinityQueries.length, 0);
        await run.close();
    });
});
