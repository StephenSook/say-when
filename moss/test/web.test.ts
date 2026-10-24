import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MemoryStore } from '../src/memory.js';
import { MossRunError } from '../src/session.js';
import { WebIndex, chunkText, cleanMarkdown, nearValue, rowMetadata, sourceOf, webDocsFor, type SearchRow } from '../src/web.js';
import { harness, tempDir, type FakeSession } from './fake.js';

const isRunError = (code: string) => (error: unknown) => error instanceof MossRunError && error.code === code;

// 81 characters, so two whole sentences make a 163-character overlap.
const sentence = (i: number): string => `Sentence ${String(i).padStart(3, '0')} says the pharmacy on Shattuck opens at nine and closes at six daily.`;
const bodyOf = (chunk: string, title: string): string => chunk.slice(title.length + 2);
const FETCHED = '2026-10-24T18:00:00.000Z';

/** Length of the longest end of a that b starts with. */
function sharedEdge(a: string, b: string): number {
    for (let n = Math.min(a.length, b.length); n > 0; n -= 1) if (a.endsWith(b.slice(0, n))) return n;
    return 0;
}

const webRow = (id: string, text: string, title = 'Page'): SearchRow => ({ id, source: 'web', title, text, url: 'https://page.example/', fetchedAt: FETCHED });
const idsFor = (session: FakeSession, questionId: string): string[] =>
    [...session.docs.values()].filter((doc) => doc.metadata?.questionId === questionId).map((doc) => doc.id);

const place: SearchRow = {
    id: 'maps:ChIJ-near',
    source: 'maps',
    title: 'Shattuck Pharmacy',
    text: 'Neighborhood pharmacy with a pharmacist on duty.',
    placeId: 'ChIJ-near',
    location: { lat: 37.8715926, lng: -122.272747 },
    fetchedAt: FETCHED,
    rank: 2,
    facts: { rating: 4.6, reviews: 213, openNow: true, wheelchairEntrance: false, address: '2300 Shattuck Ave.', phone: '(510) 555-0100', category: 'Pharmacy' },
};

describe('chunking', () => {
    const title = 'Pharmacy hours';
    const text = Array.from({ length: 60 }, (_, i) => sentence(i)).join(' ');
    const chunks = chunkText(title, text);

    it('cuts at sentence ends, keeps chunks at or under 1,200 characters, and puts the title on top of each', () => {
        assert.ok(chunks.length >= 4, `got ${chunks.length} chunks`);
        for (const chunk of chunks) {
            assert.ok(chunk.length <= 1200, `chunk of ${chunk.length}`);
            assert.ok(chunk.startsWith(`${title}\n\n`));
            assert.match(chunk, /six daily\.$/);
        }
        for (const chunk of chunks.slice(0, -1)) assert.ok(chunk.length >= 800, `short chunk of ${chunk.length}`);
        for (let i = 0; i < 60; i += 1) assert.ok(chunks.some((chunk) => chunk.includes(sentence(i))), `lost sentence ${i}`);
    });

    it('starts each chunk with 150 to 200 characters of whole sentences from the one before', () => {
        for (let k = 1; k < chunks.length; k += 1) {
            const overlap = sharedEdge(bodyOf(chunks[k - 1], title), bodyOf(chunks[k], title));
            assert.ok(overlap >= 150 && overlap <= 200, `overlap of ${overlap}`);
            assert.ok(bodyOf(chunks[k], title).startsWith('Sentence '));
        }
    });

    it('never splits a sentence that fits a chunk on its own; that chunk starts without the overlap instead', () => {
        const short = `S${'x'.repeat(198)}.`;
        const long = `Long ${'word '.repeat(208)}end.`;
        assert.equal(short.length, 200);
        assert.equal(long.length, 1049);
        assert.deepEqual(chunkText('T', `${short} ${long}`), [`T\n\n${short}`, `T\n\n${long}`]);
    });

    it('cuts only a sentence longer than a whole chunk, between words, still overlapping', () => {
        const long = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');
        const parts = chunkText('Long', long);
        assert.ok(parts.length >= 3);
        const words = new Set(long.split(' '));
        for (const part of parts) {
            assert.ok(part.length <= 1200);
            for (const word of bodyOf(part, 'Long').split(' ')) assert.ok(words.has(word), `cut inside a word: ${word}`);
        }
        for (let k = 1; k < parts.length; k += 1) {
            const overlap = sharedEdge(bodyOf(parts[k - 1], 'Long'), bodyOf(parts[k], 'Long'));
            assert.ok(overlap >= 150 && overlap <= 200, `overlap of ${overlap}`);
        }
    });

    it('refuses chunk options that cannot work instead of looping', () => {
        assert.throws(() => chunkText('', 'x', { maxChars: 1, overlapMin: 0, overlapMax: 0 }), RangeError);
        assert.throws(() => chunkText('', 'x', { maxChars: 1200, overlapMin: 300, overlapMax: 200 }), RangeError);
        assert.throws(() => chunkText('', 'x', { maxChars: 400, overlapMax: 250 }), RangeError);
        assert.deepEqual(chunkText('Tiny', 'One. Two.', { maxChars: 200, overlapMin: 0, overlapMax: 0 }), ['Tiny\n\nOne. Two.']);
    });

    it('keeps a title-only chunk for a page with no text, and cleans light markdown', () => {
        assert.deepEqual(chunkText('Shattuck Pharmacy', ''), ['Shattuck Pharmacy']);
        assert.deepEqual(chunkText('', '   '), []);
        const cleaned = cleanMarkdown('## Hours\n- Open [daily](https://x.example/a) ![logo](https://x.example/l.png)');
        assert.doesNotMatch(cleaned, /https|#|\[|\]|logo/);
        assert.deepEqual(chunkText('Cafe', '## Hours\nOpen [daily](https://x.example/a).'), ['Cafe\n\nHours Open daily.']);
    });
});

describe('web documents', () => {
    it('stringifies every metadata value, including location and place facts, and hashes the parent id', () => {
        const { parentId, ...rest } = rowMetadata('q7', place);
        assert.match(parentId, /^web:[0-9a-f]{16}$/);
        assert.deepEqual(rest, {
            kind: 'web',
            source: 'maps',
            questionId: 'q7',
            rowId: 'maps:ChIJ-near',
            title: 'Shattuck Pharmacy',
            fetchedAt: FETCHED,
            placeId: 'ChIJ-near',
            rank: '2',
            location: '37.871593,-122.272747',
            rating: '4.6',
            reviews: '213',
            openNow: 'true',
            wheelchairEntrance: 'false',
            address: '2300 Shattuck Ave.',
            phone: '(510) 555-0100',
            category: 'Pharmacy',
        });
        for (const value of Object.values(rowMetadata('q7', place))) assert.equal(typeof value, 'string');
        assert.deepEqual(Object.keys(rowMetadata('q7', webRow('w1', 'Open.'))).sort(), [
            'fetchedAt',
            'kind',
            'parentId',
            'questionId',
            'rowId',
            'source',
            'title',
            'url',
        ]);
    });

    it('keeps a url or placeId that is not text out of metadata and sources', () => {
        const odd = { ...place, url: 42, placeId: { id: 'x' } } as unknown as SearchRow;
        const meta = rowMetadata('q7', odd);
        assert.equal(meta.url, undefined);
        assert.equal(meta.placeId, undefined);
        for (const value of Object.values(meta)) assert.equal(typeof value, 'string');
        assert.deepEqual(sourceOf({ id: 'x', questionId: 'q7', score: 1, text: '', row: odd }), { source: 'maps', fetchedAt: FETCHED });
    });

    it('numbers each chunk under its row, and writes place facts into the text only when a place has none', () => {
        const { docs, truncated } = webDocsFor('q7', place);
        assert.equal(truncated, false);
        assert.equal(docs.length, 1);
        assert.match(docs[0].id, /^web:[0-9a-f]{16}#0$/);
        assert.equal(docs[0].id, `${docs[0].metadata?.parentId}#0`);
        assert.equal(docs[0].metadata?.chunk, '0');
        // apify/client already summarizes the facts in text, so they are not written twice.
        assert.equal(docs[0].text, 'Shattuck Pharmacy\n\nNeighborhood pharmacy with a pharmacist on duty.');
        const bare = webDocsFor('q7', { ...place, text: '', facts: { ...place.facts, wheelchairEntrance: true } }).docs;
        assert.equal(
            bare[0].text,
            'Shattuck Pharmacy\n\nPharmacy. 2300 Shattuck Ave. Rated 4.6 from 213 reviews. Open when checked. Wheelchair accessible entrance. Phone (510) 555-0100.',
        );
    });

    it('stops long pages at maxChunksPerRow and says so', () => {
        const long = Array.from({ length: 200 }, (_, i) => sentence(i)).join(' ');
        const built = webDocsFor('q8', webRow('w', long, 'Long page'), { maxChunksPerRow: 3 });
        assert.equal(built.docs.length, 3);
        assert.equal(built.truncated, true);
    });

    it('builds the $near value Moss expects and refuses a bad point or radius', () => {
        assert.equal(nearValue({ lat: 37.8716, lng: -122.2727, radiusMeters: 1500.4 }), '37.8716,-122.2727,1500');
        assert.throws(() => nearValue({ lat: 91, lng: 0, radiusMeters: 100 }));
        assert.throws(() => nearValue({ lat: 37, lng: -122, radiusMeters: 0 }));
    });
});

describe('web index', () => {
    let dir = '';
    beforeEach(() => {
        dir = tempDir();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("deletes a question's chunks once it is answered and leaves the rest alone", async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        await new MemoryStore(run).add([{ type: 'pref', text: 'Call me Sam.' }]);
        const long = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ');
        const first = await web.index('q1', [webRow('w1', long, 'Hours'), place]);
        await web.index('q2', [webRow('w2', 'Soup of the day.', 'Menu')]);
        const q1 = idsFor(moss.session, 'q1');
        assert.ok(first.chunks >= 3);
        assert.equal(q1.length, first.chunks);
        assert.equal(await web.forget('q1'), q1.length);
        assert.deepEqual(idsFor(moss.session, 'q1'), []);
        assert.ok(idsFor(moss.session, 'q2').length > 0);
        assert.ok([...moss.session.docs.values()].some((doc) => doc.metadata?.kind === 'memory'));
        assert.equal(await web.forget('q1'), 0);
        await run.close();
    });

    it('keeps question and row ids apart, so one question never overwrites or deletes another', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        await web.index('a:b', [webRow('c', 'First question page.')]);
        await web.index('a', [webRow('b:c', 'Second question page.')]);
        assert.equal(moss.session.docs.size, 2);
        assert.equal(await web.forget('a:b'), 1);
        assert.deepEqual(
            [...moss.session.docs.values()].map((doc) => doc.metadata?.questionId),
            ['a'],
        );
        await run.close();
    });

    it('keeps a question tracked when its delete fails, so forget can be tried again', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        await web.index('q1', [webRow('w1', 'Open daily.')]);
        moss.session.failures.set('deleteDocs', Object.assign(new Error('delete failed'), { code: 'INTERNAL' }));
        await assert.rejects(web.forget('q1'));
        assert.equal(moss.session.docs.size, 1);
        assert.equal(await web.forget('q1'), 1);
        assert.equal(moss.session.docs.size, 0);
        await run.close();
    });

    it('waits for an index still under way before forgetting that question', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        // The add is held open, as a slow embed would be, so a delete that did not wait would run first and miss it.
        const release = moss.session.hold('addDocs');
        const adding = web.index('q1', [webRow('w1', 'Open daily.')]);
        const forgetting = web.forget('q1');
        await new Promise((resolve) => setTimeout(resolve, 10)); // every queued call has run up to the held add
        release();
        assert.equal(await forgetting, 1);
        await adding;
        assert.equal(moss.session.docs.size, 0);
        await run.close();
    });

    it('removes chunks a page no longer fills when the same row is indexed again', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        const long = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ');
        const first = await web.index('q1', [webRow('w1', long, 'Hours')]);
        assert.ok(first.chunks >= 3);
        const second = await web.index('q1', [webRow('w1', 'Closed permanently.', 'Hours')]);
        assert.equal(second.chunks, 1);
        assert.equal(second.removed, first.chunks - 1);
        assert.deepEqual(
            [...moss.session.docs.values()].map((doc) => doc.text),
            ['Hours\n\nClosed permanently.'],
        );
        assert.equal(await web.forget('q1'), 1);
        await run.close();
    });

    it('keeps overlapping replacements of one row tracked, so forget still removes every chunk', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        const long = Array.from({ length: 50 }, (_, i) => sentence(i)).join(' ');
        const seeded = await web.index('q1', [webRow('w1', long, 'Hours')]);
        assert.ok(seeded.chunks >= 4);
        const shorter = web.index('q1', [webRow('w1', 'Closed today.', 'Hours')]);
        const longer = web.index('q1', [webRow('w1', long, 'Hours')]);
        await Promise.all([shorter, longer]);
        assert.equal(idsFor(moss.session, 'q1').length, seeded.chunks);
        assert.equal(await web.forget('q1'), seeded.chunks);
        assert.equal(moss.session.docs.size, 0);
        await run.close();
    });

    it('keeps an index that starts while a forget is still running', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        await web.index('q1', [webRow('w1', 'Open daily.')]);
        const release = moss.session.hold('deleteDocs');
        const forgetting = web.forget('q1');
        await new Promise((resolve) => setTimeout(resolve, 10));
        const adding = web.index('q1', [webRow('w1', 'Open daily, even Sundays.')]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        release();
        assert.equal(await forgetting, 1);
        await adding;
        assert.equal(moss.session.docs.size, 1);
        assert.equal(await web.forget('q1'), 1);
        assert.equal(moss.session.docs.size, 0);
        await run.close();
    });

    it('keeps the old source on chunks whose replacement failed', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        await web.index('q1', [{ ...webRow('w1', 'Open at nine.'), url: 'https://a.example/' }]);
        moss.session.failures.set('addDocs', Object.assign(new Error('add failed'), { code: 'INTERNAL' }));
        await assert.rejects(web.index('q1', [{ ...webRow('w1', 'Closed for good.'), url: 'https://b.example/' }]));
        const found = await web.search('q1', 'open nine');
        assert.equal(found.hits.length, 1);
        assert.match(found.hits[0].text, /Open at nine/);
        assert.equal(found.hits[0].row?.url, 'https://a.example/');
        assert.equal(sourceOf(found.hits[0])?.url, 'https://a.example/');
        await run.close();
    });

    it('keeps its own copy of each row, so a caller changing its row later cannot change a source', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        const row = { ...webRow('w1', 'Open at nine.'), url: 'https://a.example/' };
        await web.index('q1', [row]);
        row.url = 'https://b.example/';
        row.text = 'Closed for good.';
        moss.session.failures.set('addDocs', Object.assign(new Error('add failed'), { code: 'INTERNAL' }));
        await assert.rejects(web.index('q1', [row]));
        const found = await web.search('q1', 'open nine');
        assert.equal(found.hits[0].row?.url, 'https://a.example/');
        assert.equal(found.hits[0].row?.text, 'Open at nine.');
        await run.close();
    });

    it('hands each search its own copy of a row, so editing a hit cannot change the next search', async () => {
        const { run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        await web.index('q1', [place]);
        const first = await web.search('q1', 'neighborhood pharmacy');
        const row = first.hits[0].row;
        assert.ok(row?.facts);
        row.url = 'https://changed.example/';
        row.facts.rating = 1;
        const second = await web.search('q1', 'neighborhood pharmacy');
        assert.equal(second.hits[0].row?.url, undefined);
        assert.equal(second.hits[0].row?.facts?.rating, 4.6);
        await run.close();
    });

    it('refuses search hits that come back after their run closed and a new one opened', { timeout: 5000 }, async () => {
        const { moss, timers, run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        await web.index('q1', [{ ...webRow('w1', 'Open at nine.'), url: 'https://a.example/' }]);
        const release = moss.session.hold('query');
        const searching = web.search('q1', 'open nine');
        await new Promise((resolve) => setTimeout(resolve, 10));
        const closing = run.close();
        await new Promise((resolve) => setTimeout(resolve, 10));
        timers.fireAll(); // ends the wait for the query in flight
        await closing;
        await run.start();
        await web.index('q1', [{ ...webRow('w1', 'Closed for good.'), url: 'https://b.example/' }]);
        release();
        await assert.rejects(searching, isRunError('not_open'));
        await run.close();
    });

    it('lets a restarted run use a question whose earlier add stalled, and drops calls queued in the old run', { timeout: 5000 }, async () => {
        const { moss, timers, run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        const release = moss.session.hold('addDocs');
        const stalled = web.index('q1', [webRow('w1', 'Open daily.')]);
        const queued = web.index('q1', [webRow('w2', 'Closed Sundays.')]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const closing = run.close();
        await new Promise((resolve) => setTimeout(resolve, 10));
        timers.fireAll(); // ends the wait for the stalled call in flight
        await closing;
        await run.start();
        const fresh = await web.index('q1', [webRow('w3', 'Open late Fridays.')]);
        assert.equal(fresh.chunks, 1);
        release();
        await stalled;
        await assert.rejects(queued, isRunError('not_open'));
        assert.deepEqual(
            [...moss.session.docs.values()].map((doc) => doc.metadata?.rowId),
            ['w3'],
        );
        assert.equal(await web.forget('q1'), 1);
        await run.close();
    });

    it('refuses options that cannot work when the index is created', () => {
        const { run } = harness(dir);
        assert.throws(() => new WebIndex(run, { maxChars: 50 }), RangeError);
        assert.throws(() => new WebIndex(run, { maxChunksPerRow: 0 }), RangeError);
        assert.throws(() => new WebIndex(run, { searchAlpha: 0 }), RangeError);
    });

    it('skips malformed and repeated rows and counts them, and takes an epoch fetchedAt as text', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const result = await new WebIndex(run).index('q1', [
            place,
            place,
            webRow('', 'Empty id.'),
            { ...webRow('x', 'Wrong source.'), source: 'news' } as unknown as SearchRow,
            { ...webRow('epoch', 'Epoch time.'), fetchedAt: 1761328800000 } as unknown as SearchRow,
        ]);
        assert.equal(result.rows, 2);
        assert.equal(result.skipped, 3);
        assert.equal(result.chunks, 2);
        const epoch = [...moss.session.docs.values()].find((doc) => doc.metadata?.rowId === 'epoch');
        assert.equal(epoch?.metadata?.fetchedAt, '1761328800000');
        await run.close();
    });

    it('finds places near a point with $near, and hands back the row as it was indexed', async () => {
        const { moss, run } = harness(dir);
        await run.start();
        const web = new WebIndex(run);
        await new MemoryStore(run).add([{ type: 'pref', text: 'My pharmacy is the one open now on Shattuck.' }]);
        const far: SearchRow = { ...place, id: 'maps:ChIJ-far', placeId: 'ChIJ-far', title: 'Mission Pharmacy', location: { lat: 37.7599, lng: -122.4148 } };
        await web.index('q3', [place, far, webRow('w3', 'How to pick a pharmacy.', 'Pharmacy guide')]);
        const found = await web.search('q3', 'pharmacy open now', { source: 'maps', near: { lat: 37.871, lng: -122.273, radiusMeters: 2000 } });
        assert.deepEqual(
            found.hits.map((hit) => hit.row?.id),
            ['maps:ChIJ-near'],
        );
        assert.deepEqual(sourceOf(found.hits[0]), { source: 'maps', placeId: 'ChIJ-near', fetchedAt: FETCHED });
        assert.equal(found.mossMs, 1.5);
        const query = moss.session.calls.filter((call) => call.method === 'query').at(-1);
        assert.deepEqual((query?.args[1] as { filter: unknown }).filter, {
            $and: [
                { field: 'kind', condition: { $eq: 'web' } },
                { field: 'questionId', condition: { $eq: 'q3' } },
                { field: 'source', condition: { $eq: 'maps' } },
                { field: 'location', condition: { $near: '37.871,-122.273,2000' } },
            ],
        });
        const all = await web.search('q3', 'pharmacy open now');
        assert.equal(all.hits.length, 3);
        assert.ok(all.hits.every((hit) => hit.questionId === 'q3'));
        await run.close();
    });
});
