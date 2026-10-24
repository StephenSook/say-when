// npm run call:check   checks the CALL setup without calling anyone: lists, script, the published agent, the hour.
// Prints counts and results only. No phone number is printed.

import { dialerFromEnv } from '../server.js';
import { loadRepoEnv } from './args.js';

loadRepoEnv();
const report = await dialerFromEnv().preflight();
console.log(`consent list: ${report.consentCount} people`);
console.log(`do-not-call list: ${report.doNotCallCount} numbers`);
console.log(`script: ${report.scriptProblems.length === 0 ? 'ok' : report.scriptProblems.join('; ')}`);
console.log(`published agent: ${report.agent === 'skipped' ? 'not checked' : report.agent.ok ? 'matches the script' : `${report.agent.code} (${report.agent.what})`}`);
console.log(`calling hours now: ${report.insideHoursNow ? 'yes' : 'no (9 AM to 9 PM Pacific only)'}`);
if (!report.ok) process.exitCode = 1;
