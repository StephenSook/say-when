import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ANY_PARTNER, MemoryStore, memoryDoc, memoryFilter, type MemoryItem } from '../src/memory.js';
import { MossInputError } from '../src/session.js';
import { harness, tempDir } from './fake.js';

const at = Date.UTC(2026, 9, 24, 19, 30);

describe('memory documents', () => {
    it('stores a reply with its partner and time, every metadata value a string', () => {
        const doc = memoryDoc({ type: 'reply', question: '  Want a\n coffee? ', reply: 'Yes, black, no sugar.', partnerId: 'maria' }, at);
        assert.equal(doc.text, 'Q: Want a coffee?\nA: Yes, black, no sugar.');
        assert.deepEqual(doc.metadata, { kind: 'memory', source: 'memory', type: 'reply', person: 'maria', ts: String(at / 1000), shareable: 'false' });
        assert.equal(doc.payload, JSON.stringify({ reply: 'Yes, black, no sugar.' }));
        assert.match(doc.id, /^mem:reply:[0-9a-f]{16}$/);
        for (const value of Object.values(doc.metadata ?? {})) assert.equal(typeof value, 'string');
    });

    it('defaults preferences to every partner and gives the same item the same id, with no text in it', () => {
        const a = memoryDoc({ type: 'pref', text: 'I take coffee black.' }, at);
        const b = memoryDoc({ type: 'pref', text: ' I take  coffee black. ' }, at + 5000);
        assert.equal(a.metadata?.person, ANY_PARTNER);
        assert.equal(a.id, b.id);
        assert.notEqual(a.id, memoryDoc({ type: 'pref', text: 'I take coffee black.', partnerId: 'maria' }, at).id);
        assert.ok(!a.id.includes('coffee'));
    });

    it('marks a memory shareable only when asked, without changing its id', () => {
        const kept = memoryDoc({ type: 'pref', text: 'I take coffee black.' }, at);
        const shared = memoryDoc({ type: 'pref', text: 'I take coffee black.', shareable: true }, at);
        assert.equal(kept.metadata?.shareable, 'false');
        assert.equal(shared.metadata?.shareable, 'true');
        assert.equal(shared.id, kept.id);
    });

    it('refuses bad items without repeating their text', () => {
        const long = 'very long reply '.repeat(40);
        const cases: Array<() => unknown> = [
            () => memoryDoc({ type: 'reply', question: 'Coffee?', reply: 'Sure.', partnerId: 'any' }, at),
            () => memoryDoc({ type: 'reply', question: 'Coffee?', reply: '   ', partnerId: 'maria' }, at),
            () => memoryDoc({ type: 'reply', question: 'Coffee?', reply: long, partnerId: 'maria' }, at),
            () => memoryDoc({ type: 'pref', text: 'Fine.', partnerId: '' }, at),
            () => memoryDoc({ type: 'note', text: 'Fine.' } as unknown as MemoryItem, at),
        ];
        for (const make of cases) {
            assert.throws(make, (error: unknown) => error instanceof MossInputError && !error.message.includes('very long'));
        }
    });

    it('filters to this partner plus shared items', () => {
        assert.deepEqual(memoryFilter('maria'), {
            $and: [
                { field: 'kind', condition: { $eq: 'memory' } },
                { field: 'person', condition: { $in: ['maria', 'any'] } },
            ],
        });
    });
});

describe('recall', () => {
    let dir = '';
    beforeEach(() => {
        dir = tempDir();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    async function seeded() {
        const h = harness(dir);
        await h.run.start();
        const memory = new MemoryStore(h.run, { scoreFloor: 0.3, now: () => at });
        const { ids } = await memory.add([
            { type: 'reply', question: 'Want a coffee?', reply: 'Yes, black, no sugar.', partnerId: 'maria' },
            { type: 'reply', question: 'Want a coffee?', reply: 'No thanks, it is late.', partnerId: 'leon' },
            { type: 'pref', text: 'I take my coffee black with no sugar.' },
            { type: 'pref', text: 'Maria makes the best coffee on Sundays.', partnerId: 'maria' },
            { type: 'pref', text: 'Leon likes to talk about baseball.', partnerId: 'leon' },
        ]);
        return { ...h, memory, ids };
    }

    it("returns only this partner's memory and shared items, with instant options from past replies", async () => {
        const { memory, run } = await seeded();
        const recall = await memory.recall('Want a coffee?', 'maria');
        assert.deepEqual(recall.instant, ['Yes, black, no sugar.']);
        assert.ok(recall.hits.every((hit) => hit.partnerId === 'maria' || hit.partnerId === ANY_PARTNER));
        assert.ok(recall.hits.some((hit) => hit.type === 'pref' && hit.partnerId === ANY_PARTNER));
        assert.equal(recall.hits[0].at, at);
        assert.equal(recall.mossMs, 1.5);
        assert.equal(typeof recall.wallMs, 'number');
        await run.close();
    });

    it('drops hits under the score floor', async () => {
        const { memory, moss, ids, run } = await seeded();
        moss.session.scores.set(ids[2], 0.29);
        const recall = await memory.recall('Want a coffee?', 'maria');
        assert.ok(!recall.hits.some((hit) => hit.id === ids[2]));
        assert.ok(recall.hits.some((hit) => hit.id === ids[3]));
        await run.close();
    });

    it("keeps Moss's hybrid order even when the scores disagree", async () => {
        const { memory, moss, ids, run } = await seeded();
        moss.session.scores.set(ids[0], 0.55).set(ids[2], 0.9).set(ids[3], 0.7);
        const recall = await memory.recall('Want a coffee?', 'maria');
        assert.deepEqual(
            recall.hits.map((hit) => hit.id),
            [ids[0], ids[2], ids[3]],
        );
        await run.close();
    });

    it('still reads the type and the reply when hits come back without payload or metadata', async () => {
        const { memory, moss, run } = await seeded();
        moss.session.reshape = (hit) => ({ id: hit.id, text: hit.text, score: hit.score });
        const recall = await memory.recall('Want a coffee?', 'maria');
        assert.deepEqual(recall.instant, ['Yes, black, no sugar.']);
        assert.equal(recall.hits[0].type, 'reply');
        assert.equal(recall.hits[1].type, 'pref');
        // Without metadata nothing is known to be shareable, so nothing is shown.
        assert.ok(recall.hits.every((hit) => hit.shareable === false && hit.sharedText === null));
        await run.close();
    });

    it('gives screen text only for memories the person marked shareable', async () => {
        const { run } = harness(dir);
        await run.start();
        const memory = new MemoryStore(run, { scoreFloor: 0.2 });
        await memory.add([
            { type: 'pref', text: 'I take my coffee black with no sugar.', shareable: true },
            { type: 'pref', text: 'My coffee mug is the blue one.' },
        ]);
        await memory.writeBack({ question: 'Want a coffee?', reply: 'Yes, black, no sugar.', partnerId: 'maria', shareable: true });
        await memory.writeBack({ question: 'Coffee after dinner?', reply: 'No, it keeps me up.', partnerId: 'maria' });
        const recall = await memory.recall('Want a coffee after dinner?', 'maria');
        const shown = new Map(recall.hits.map((hit) => [hit.text, hit.sharedText]));
        assert.equal(shown.get('Q: Want a coffee?\nA: Yes, black, no sugar.'), 'Yes, black, no sugar.');
        assert.equal(shown.get('I take my coffee black with no sugar.'), 'I take my coffee black with no sugar.');
        assert.equal(shown.get('Q: Coffee after dinner?\nA: No, it keeps me up.'), null);
        assert.equal(shown.get('My coffee mug is the blue one.'), null);
        await run.close();
    });

    it('follows a change of consent on an item already stored, and leaving the flag out means private', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const memory = new MemoryStore(run, { scoreFloor: 0.2 });
        const sharedText = async (): Promise<string | null | undefined> =>
            (await memory.recall('How do you take your coffee?', 'maria')).hits.find((hit) => hit.type === 'pref')?.sharedText;
        await memory.add([{ type: 'pref', text: 'I take my coffee black.', shareable: true }]);
        assert.equal(await sharedText(), 'I take my coffee black.');
        await memory.add([{ type: 'pref', text: 'I take my coffee black.' }]);
        assert.equal(await sharedText(), null);
        await memory.add([{ type: 'pref', text: 'I take my coffee black.', shareable: true }]);
        assert.equal(await sharedText(), 'I take my coffee black.');
        assert.equal(moss.session.docs.size, 1);
        await run.close();
    });

    it('shares only the reply of a shared reply, even when a hit comes back without its payload', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const memory = new MemoryStore(run, { scoreFloor: 0.2 });
        await memory.writeBack({ question: 'Want a coffee?', reply: 'Yes, black, no sugar.', partnerId: 'maria', shareable: true });
        moss.session.reshape = (hit) => ({ id: hit.id, text: hit.text, score: hit.score, metadata: hit.metadata });
        const recall = await memory.recall('Want a coffee?', 'maria');
        assert.equal(recall.hits[0].sharedText, 'Yes, black, no sugar.');
        await run.close();
    });
});

describe('write back', () => {
    let dir = '';
    beforeEach(() => {
        dir = tempDir();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('learns from one confirm: the next question from the same partner gets the reply first', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const memory = new MemoryStore(run, { scoreFloor: 0.3 });
        assert.deepEqual((await memory.recall('Want a coffee?', 'maria')).instant, []);
        const written = await memory.writeBack({ question: 'Want a coffee?', reply: 'Yes, black, no sugar.', partnerId: 'maria' });
        assert.equal(written.added, 1);
        assert.equal(written.updated, 0);
        assert.equal(moss.session.docs.get(written.id)?.metadata?.person, 'maria');
        assert.deepEqual((await memory.recall('Do you want a coffee now?', 'maria')).instant, ['Yes, black, no sugar.']);
        assert.deepEqual((await memory.recall('Do you want a coffee now?', 'leon')).instant, []);
        await run.close();
    });

    it('stores the same confirmed reply once and refreshes its time', async () => {
        let now = at;
        const { moss, run } = harness(dir);
        await run.start();
        const memory = new MemoryStore(run, { now: () => now });
        const first = await memory.writeBack({ question: 'Want a coffee?', reply: 'Yes, black, no sugar.', partnerId: 'maria' });
        now += 60_000;
        const second = await memory.writeBack({ question: 'Want a coffee?', reply: 'Yes, black, no sugar.', partnerId: 'maria' });
        assert.equal(second.id, first.id);
        assert.equal(second.added, 0);
        assert.equal(second.updated, 1);
        assert.equal(moss.session.docs.size, 1);
        assert.equal(moss.session.docs.get(first.id)?.metadata?.ts, String((at + 60_000) / 1000));
        await run.close();
    });
});

describe('affinity', () => {
    let dir = '';
    beforeEach(() => {
        dir = tempDir();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('scores each option by its best memory hit at or above the floor, with evidence ids', async () => {
        const { run } = harness(dir);
        await run.start();
        const memory = new MemoryStore(run, { scoreFloor: 0.4 });
        const { ids } = await memory.add([
            { type: 'reply', question: 'Want a coffee?', reply: 'Yes, black, no sugar.', partnerId: 'maria' },
            { type: 'pref', text: 'Tea makes me sleepy.' },
        ]);
        const result = await memory.affinity(
            [
                { id: 'o1', text: 'Black coffee, no sugar' },
                { id: 'o2', text: 'Something else' },
            ],
            'maria',
        );
        assert.equal(result[0].optionId, 'o1');
        assert.equal(result[0].score, 1);
        assert.deepEqual(result[0].evidence, [ids[0]]);
        assert.deepEqual(result[1], { optionId: 'o2', score: 0, evidence: [], mossMs: 1.5 });
        await run.close();
    });
});
