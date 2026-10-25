// npm run writer: an anonymous, read-only SpacetimeDB subscription feeding Tiger, until Ctrl-C.
//
//   SPACETIMEDB_DB=say-when-demo npm run writer
//   SPACETIMEDB_DB=say-when-dev TELEMETRY_SESSIONS=13,15 npm run writer   # only those sessions' rows
//
// Environment: SPACETIMEDB_DB (required), SPACETIMEDB_URI (default https://maincloud.spacetimedb.com),
// TIGER_DATABASE_URL (optional; otherwise the Tiger CLI supplies the connection string in memory),
// TELEMETRY_SESSIONS (optional: comma-separated session ids; only their rows are written).
import { connectTiger } from '../db.js';
import { consoleLogger } from '../log.js';
import { AGGREGATES, COMMAND_CHECK_SQL, HYPERTABLES, judgeCommandCheck, PLAIN_TABLES } from '../migrate.js';
import { createPipeline } from '../pipeline.js';
import { PgSink, type RowSink } from '../sink.js';
import { SpacetimeSource } from '../sources/spacetime.js';
import { builder } from './bindings.js';

const log = consoleLogger;
const database = process.env.SPACETIMEDB_DB?.trim() ?? '';
const uri = process.env.SPACETIMEDB_URI?.trim() || 'https://maincloud.spacetimedb.com';
const sessionsText = process.env.TELEMETRY_SESSIONS?.trim() ?? '';
/** Stop writing well before the free service's 750 MB, where it would turn read-only. */
const STORAGE_LIMIT_BYTES = 600 * 1024 * 1024;

class StorageGuardError extends Error {
    override readonly name = 'StorageGuardError';
}

if (!database) {
    console.error('telemetry writer: set SPACETIMEDB_DB (for example say-when-dev or say-when-demo).');
    process.exit(2);
}
if (sessionsText !== '' && !/^[1-9][0-9]{0,19}(,[1-9][0-9]{0,19})*$/.test(sessionsText)) {
    console.error('telemetry writer: TELEMETRY_SESSIONS must be session ids separated by commas, for example 13,15.');
    process.exit(2);
}
const onlySessions = sessionsText === '' ? undefined : new Set(sessionsText.split(',').map((id) => BigInt(id)));

const conn = await connectTiger({ log, max: 1, applicationName: 'neurolingo-telemetry-writer' }).catch((error: unknown) => {
    console.error(`telemetry writer: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});

// Refuse to start against a service that was never migrated: rows would fail one batch at a time. That includes a
// service without sql/070, whose command CHECK refuses the direct select words (PICK_1 to PICK_3). If Tiger cannot
// be reached at all, start anyway: the writer buffers (up to its cap) and retries, as it would for a later outage.
let schemaComplete: boolean | null = null;
let commandCheck: { ok: boolean; detail: string } | null = null;
try {
    const r = await conn.pool.query(
        "SELECT count(*)::int AS n FROM timescaledb_information.continuous_aggregates WHERE view_schema = 'telemetry' AND view_name = ANY($1::text[])",
        [[...AGGREGATES]],
    );
    const h = await conn.pool.query("SELECT count(*)::int AS n FROM timescaledb_information.hypertables WHERE hypertable_schema = 'telemetry' AND hypertable_name = ANY($1::text[])", [
        [...HYPERTABLES],
    ]);
    const p = await conn.pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'telemetry' AND tablename = ANY($1::text[])", [[...PLAIN_TABLES]]);
    schemaComplete =
        (r.rows[0] as { n: number }).n === AGGREGATES.length && (h.rows[0] as { n: number }).n === HYPERTABLES.length && (p.rows[0] as { n: number }).n === PLAIN_TABLES.length;
    commandCheck = judgeCommandCheck(((await conn.pool.query(COMMAND_CHECK_SQL)).rows as Array<{ def: string }>).map((row) => row.def));
} catch (error) {
    log.warn('Tiger is not reachable; starting anyway, rows will queue and the writer will retry', { error: conn.describe(error) });
}
if (schemaComplete === false) {
    console.error('telemetry writer: the telemetry schema is incomplete; run npm run migrate first.');
    await conn.close();
    process.exit(1);
}
if (commandCheck && !commandCheck.ok) {
    console.error(`telemetry writer: ${commandCheck.detail}.`);
    await conn.close();
    process.exit(1);
}

const pg = new PgSink(conn.pool);
let overLimit = false;
let lastSizeCheck = 0;
const guarded: RowSink = {
    async insert(table, rows) {
        const now = Date.now();
        if (now - lastSizeCheck > 5 * 60_000) {
            lastSizeCheck = now;
            const size = Number(((await conn.pool.query('SELECT pg_database_size(current_database())::text AS b')).rows[0] as { b: string }).b);
            const wasOver = overLimit;
            overLimit = size > STORAGE_LIMIT_BYTES;
            if (overLimit !== wasOver) log[overLimit ? 'error' : 'info'](overLimit ? 'storage guard tripped: writes paused' : 'storage guard cleared', { megabytes: Math.round(size / 1048576) });
        }
        if (overLimit) throw new StorageGuardError('the Tiger service is above the 600 MB guard; writes are paused (retention frees space daily)');
        await pg.insert(table, rows);
    },
};

const source = new SpacetimeSource({ uri, database, builder, log });
const pipeline = createPipeline({ source, sink: guarded, log, describeError: (e) => conn.describe(e), onlySessions });

const status = setInterval(() => {
    const w = pipeline.writer.stats();
    log.info('status', {
        queued: w.queued,
        inFlight: w.inFlight,
        written: w.written,
        dropped: w.dropped,
        failures: w.consecutiveFailures,
        lastError: w.lastError,
        tracker: pipeline.tracker.counters,
        source: source.counters,
        tigerLeafMatchesPin: conn.leafMatchesPin(),
    });
}, 30_000);

let stopping = false;
const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal });
    clearInterval(status);
    await pipeline.stop(5_000);
    await conn.close();
    process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

log.info('starting', { database, uri, sessions: onlySessions ? [...onlySessions].map(String).join(',') : 'all' });
await pipeline.start();
