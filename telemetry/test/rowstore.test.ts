// The live columnstore test's cleanup, against a stub connection: every chunk is converted back even when one refuses,
// and the failure names that chunk.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RestoreError, restoreRowstore, type Queryable } from './live/rowstore.js';

const CHUNKS = ['A', 'B', 'C', 'D', 'E'].map((_, i) => `_timescaledb_internal._hyper_${17 + i}_${8 + i}_chunk`);

/** A stub TimescaleDB: chunks in the columnstore, a convert_to_rowstore that can be made to fail, a call log. */
function stub(options: { refuse?: ReadonlySet<string>; stateFailsFirst?: boolean } = {}) {
    const compressed = new Set(CHUNKS);
    const calls: string[] = [];
    let stateReads = 0;
    const db: Queryable = {
        async query(sql: string) {
            if (sql.includes('timescaledb_information.chunks')) {
                stateReads += 1;
                if (options.stateFailsFirst && stateReads === 1) throw new Error('canceling statement due to statement timeout');
                return { rows: CHUNKS.map((chunk) => ({ chunk, is_compressed: compressed.has(chunk) })) };
            }
            const m = /^CALL convert_to_rowstore\('([^']+)'\)$/.exec(sql);
            assert.ok(m, `unexpected statement ${sql}`);
            calls.push(m[1]!);
            if (options.refuse?.has(m[1]!)) throw new Error('canceling statement due to lock timeout');
            compressed.delete(m[1]!);
            return { rows: [] };
        },
    };
    return { db, calls, compressed };
}

const describeError = (e: unknown) => (e as Error).message;

describe('converting the live test chunks back to the rowstore', () => {
    test('converts every chunk still in the columnstore and returns them', async () => {
        const s = stub();
        assert.deepEqual(await restoreRowstore(s.db, CHUNKS, describeError), CHUNKS);
        assert.equal(s.compressed.size, 0);
        // A chunk already in the rowstore is left alone.
        assert.deepEqual(await restoreRowstore(s.db, CHUNKS, describeError), []);
    });

    test('a chunk that keeps refusing does not stop the others, and the error names it as still converted', async () => {
        const s = stub({ refuse: new Set([CHUNKS[0]!]) });
        await assert.rejects(restoreRowstore(s.db, CHUNKS, describeError), (e: unknown) => {
            const m = (e as Error).message;
            return m.includes(`${CHUNKS[0]}: canceling statement due to lock timeout`) && m.includes(`still in the columnstore: ${CHUNKS[0]}`);
        });
        assert.deepEqual(s.calls, CHUNKS, 'every chunk was attempted');
        assert.deepEqual([...s.compressed], [CHUNKS[0]], 'only the refusing chunk is left in the columnstore');
        // The after hook's second attempt tries it again and still reports it.
        await assert.rejects(restoreRowstore(s.db, CHUNKS, describeError), /still in the columnstore: _timescaledb_internal\._hyper_17_8_chunk/);
        assert.equal(s.calls.filter((c) => c === CHUNKS[0]).length, 2);
    });

    test('if the state cannot be read first, every chunk is still attempted, and the failure is reported', async () => {
        const s = stub({ stateFailsFirst: true });
        await assert.rejects(restoreRowstore(s.db, CHUNKS, describeError), /reading the chunk state: canceling statement due to statement timeout; still in the columnstore: none/);
        assert.deepEqual(s.calls, CHUNKS);
        assert.equal(s.compressed.size, 0);
    });

    test('with every chunk refusing, the error is a RestoreError naming all five, however long the message', async () => {
        const s = stub({ refuse: new Set(CHUNKS) });
        await assert.rejects(restoreRowstore(s.db, CHUNKS, describeError), (e: unknown) => {
            assert.ok(e instanceof RestoreError);
            assert.ok(e.message.length > 500, 'long enough that a 500-character cap would cut it');
            assert.ok(e.message.endsWith(`still in the columnstore: ${CHUNKS.join(', ')}`));
            return true;
        });
    });
});
