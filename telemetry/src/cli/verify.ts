// npm run verify: reads the live catalog and checks every hypertable, aggregate and policy this package expects.
import { fileURLToPath } from 'node:url';

import { verifySchema, type VerifyReport } from '../migrate.js';
import { withTiger } from './common.js';

export function printChecks(report: VerifyReport): void {
    for (const c of report.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    const failed = report.checks.filter((c) => !c.ok).length;
    console.log(`${report.checks.length - failed} of ${report.checks.length} checks passed`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    await withTiger(
        'verify',
        async (conn) => {
            const report = await verifySchema(conn.pool);
            printChecks(report);
            return report.ok ? 0 : 1;
        },
        { readOnly: true },
    );
}
