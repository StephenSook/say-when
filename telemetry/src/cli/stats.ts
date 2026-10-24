// npm run stats [-- --window=30] [-- --session=say-when-demo:3] [-- --include-test] [-- --json]
// Prints the dashboard numbers, read from Tiger over a server-enforced read-only session. No HTTP server.
import { getStats } from '../stats.js';
import { withTiger } from './common.js';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const windowMinutes = Number(arg('window') ?? 30);
const sessionId = arg('session');
const includeTest = process.argv.includes('--include-test');
const json = process.argv.includes('--json');

await withTiger('stats', async (conn) => {
    const s = await getStats(conn.pool, { windowMinutes, sessionId, includeTest });
    if (json) {
        console.log(JSON.stringify(s, null, 2));
        return 0;
    }
    const scope = sessionId ? `session ${sessionId}` : includeTest ? 'all sessions, test rows included' : 'real sessions only';
    console.log(`Eleven telemetry, last ${s.windowMinutes} minutes (${scope}), as of ${s.asOf}`);
    console.log(`  false activations per idle minute: ${s.falseActivationsPerIdleMinute ?? 'not enough rest yet'} (${s.falseActivations} in ${s.idleMinutes} idle minutes)`);
    console.log(`  YES at rest that opened the menu or lifted a pause: ${s.yesActedAtRest}`);
    console.log(`  time to pick: p50 ${s.timeToPick.p50Ms ?? '-'} ms, p95 ${s.timeToPick.p95Ms ?? '-'} ms over ${s.timeToPick.picks} picks (${s.timeToPick.method})`);
    console.log(`  commands per minute: ${s.commandsPerMinute} (${s.commands} commands)`);
    console.log(`  rows written: ${s.rowsWritten}; last write: ${s.lastWriteAt ?? 'never'}`);
    return 0;
}, { readOnly: true });
