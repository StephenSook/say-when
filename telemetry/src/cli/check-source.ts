// npm run check:source: a one-shot check of the live SpacetimeDB module through the generated bindings.
//
//   SPACETIMEDB_DB=say-when-dev npm run check:source
//
// It connects anonymously (an unpaired identity, so the module's presence hook writes nothing), subscribes to the five
// public tables telemetry reads, runs every row through the same normalizers the writer uses, prints counts and
// contract errors, and disconnects. It calls no reducer, prints no row contents and writes nothing anywhere.
// Exit 0: every row normalized. Exit 1: contract errors. Exit 2: no snapshot within the timeout.
import type { Logger } from '../log.js';
import type { SourceHandlers } from '../sources/source.js';
import { SpacetimeSource, SUBSCRIBED } from '../sources/spacetime.js';
import { builder } from './bindings.js';

const database = process.env.SPACETIMEDB_DB?.trim() || 'say-when-dev';
const uri = process.env.SPACETIMEDB_URI?.trim() || 'https://maincloud.spacetimedb.com';
const TIMEOUT_MS = 30_000;

const problems: string[] = [];
const log: Logger = {
    info: () => {},
    warn: (message, meta) => void problems.push(`${message}${meta && 'problem' in meta ? `: ${String(meta.problem)}` : ''}`),
    error: (message, meta) => void problems.push(`${message}${meta && 'name' in meta ? `: ${String(meta.name)}` : ''}`),
};

const ledger = new Map<bigint, string>();
const scans = new Map<bigint, string>();
const actions = new Map<string, string>();
const devices = new Map<string, { role: string; online: boolean; healthy: boolean | null }>();
const lost: string[] = [];

const tally = (values: Iterable<string>) => {
    const out: Record<string, number> = {};
    for (const v of values) out[v] = (out[v] ?? 0) + 1;
    return out;
};

const source = new SpacetimeSource({ uri, database, builder, log });

const done = new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(2), TIMEOUT_MS);
    const handlers: SourceHandlers = {
        ledger: (r) => void ledger.set(r.id, r.kind === 'gesture' ? `gesture ${r.outcome.split(':')[0] ?? ''}` : r.kind),
        scan: (r) => void scans.set(r.sessionId, r.pauseReason ? `${r.phase} (${r.pauseReason})` : r.phase),
        action: (r) => void actions.set(`${r.kind}:${r.id}`, `${r.kind} ${r.status}`),
        device: (r) => void devices.set(r.id, { role: r.role, online: r.online, healthy: r.decoderHealthy }),
        ready: () => {
            clearTimeout(timer);
            resolve(source.counters.contractErrors === 0 ? 0 : 1);
        },
        lost: (reason) => void lost.push(reason),
    };
    void source.start(handlers);
});

const code = await done;
source.stop();

const stations = [...devices.values()].filter((d) => d.role === 'station');
console.log(`SpacetimeDB ${database} at ${uri}: ${code === 2 ? 'no snapshot within the timeout' : 'snapshot applied'}`);
console.log(`subscribed: ${Object.values(SUBSCRIBED).join(', ')}`);
console.log(`ledger rows: ${ledger.size} ${JSON.stringify(tally(ledger.values()))}`);
console.log(`scan_state rows: ${scans.size} ${JSON.stringify(tally(scans.values()))}`);
console.log(`errand and call rows: ${actions.size} ${JSON.stringify(tally(actions.values()))}`);
console.log(
    `device_status rows: ${devices.size} (stations ${stations.length}, online ${stations.filter((d) => d.online).length}, healthy ${stations.filter((d) => d.healthy === true).length}, health unknown ${stations.filter((d) => d.healthy === null).length})`,
);
console.log(`rows normalized: ${source.counters.rows}, contract errors: ${source.counters.contractErrors}, losses: ${lost.length ? lost.join(', ') : 'none'}`);
for (const p of new Set(problems)) console.log(`problem: ${p}`);
process.exit(code);
