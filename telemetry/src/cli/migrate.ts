// npm run migrate [-- --percentiles=toolkit|exact]: applies sql/*.sql to the live Tiger service, then verifies.
import { migrate, verifySchema, type PercentileMode } from '../migrate.js';
import { withTiger } from './common.js';
import { printChecks } from './verify.js';

const flag = process.argv.find((a) => a.startsWith('--percentiles='))?.split('=')[1];
if (flag !== undefined && flag !== 'toolkit' && flag !== 'exact' && flag !== 'auto') {
    console.error('telemetry migrate: --percentiles must be toolkit, exact or auto');
    process.exit(2);
}

await withTiger('migrate', async (conn) => {
    const report = await migrate(conn.pool, { percentiles: (flag as PercentileMode | 'auto' | undefined) ?? 'auto', log: (l) => console.log(l) });
    console.log(`timescaledb ${report.timescaledbVersion}; percentiles: ${report.percentiles}`);
    console.log(`applied ${report.applied.length}: ${report.applied.join(', ') || 'none'}`);
    console.log(`already applied ${report.skipped.length}: ${report.skipped.join(', ') || 'none'}`);
    const verified = await verifySchema(conn.pool);
    printChecks(verified);
    return verified.ok ? 0 : 1;
});
