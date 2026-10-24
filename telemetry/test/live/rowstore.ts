// Converting the live test's chunks back to the rowstore. Kept apart from the live test so the unit tests can run it
// against a stub connection: a chunk that refuses must not stop the others from being converted back.

/** The part of a pg pool this needs. */
export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export const CHUNK_RE = /^_timescaledb_internal\._hyper_\d+_\d+_chunk$/;

/**
 * The combined failure of `restoreRowstore`. Each part was already passed through the caller's `describe`, so callers
 * report `message` whole: passing it through `describe` again would cut the list of chunks still in the columnstore.
 */
export class RestoreError extends Error {
    override name = 'RestoreError';
}

/** Whether each telemetry chunk is in the columnstore, as timescaledb_information.chunks says now. */
export async function columnstoreState(db: Queryable): Promise<Map<string, boolean>> {
    const rows = (await db.query(
        "SELECT chunk_schema || '.' || chunk_name AS chunk, is_compressed FROM timescaledb_information.chunks WHERE hypertable_schema = 'telemetry'",
    )).rows as Array<{ chunk: string; is_compressed: boolean }>;
    return new Map(rows.map((r) => [r.chunk, r.is_compressed]));
}

/**
 * Converts back to the rowstore every chunk in `touched` that is still in the columnstore. Every chunk is attempted
 * even when an earlier one fails; then the actual state of all of them is read again. Returns the chunks converted
 * back, or throws one error naming every failure and every chunk still in the columnstore. If the state cannot be read
 * first, every chunk is attempted (convert_to_rowstore leaves a rowstore chunk alone).
 */
export async function restoreRowstore(db: Queryable, touched: readonly string[], describe: (error: unknown) => string): Promise<string[]> {
    const failures: string[] = [];
    let before: Map<string, boolean> | null = null;
    try {
        before = await columnstoreState(db);
    } catch (error) {
        failures.push(`reading the chunk state: ${describe(error)}`);
    }
    const back: string[] = [];
    for (const chunk of touched) {
        if (before && before.get(chunk) !== true) continue;
        if (!CHUNK_RE.test(chunk)) {
            failures.push(`${chunk}: not a chunk name`);
            continue;
        }
        try {
            await db.query(`CALL convert_to_rowstore('${chunk}')`);
            back.push(chunk);
        } catch (error) {
            failures.push(`${chunk}: ${describe(error)}`);
        }
    }
    let left: string[];
    try {
        const after = await columnstoreState(db);
        left = touched.filter((chunk) => after.get(chunk) === true);
    } catch (error) {
        failures.push(`reading the chunk state again: ${describe(error)}`);
        left = touched.filter((chunk) => !back.includes(chunk));
    }
    if (failures.length > 0 || left.length > 0) {
        throw new RestoreError(`converting back to the rowstore failed: ${failures.join('; ') || 'no error reported'}; still in the columnstore: ${left.join(', ') || 'none'}`);
    }
    return back;
}
