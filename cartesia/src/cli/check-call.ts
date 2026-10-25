// npm run call:check   checks the CALL setup without calling anyone: lists, holds, script, the published agent, the hour.
// Prints counts and results only. No phone number is printed.

import { dialerFromEnv } from '../server.js';
import { loadRepoEnv } from './args.js';

loadRepoEnv();
const report = await dialerFromEnv().preflight();
console.log(`consent list: ${report.consentCount} people`);
console.log(`do-not-call list: ${report.doNotCallCount} numbers`);
console.log(`hold file: ${report.holdsReadable ? 'readable' : 'cannot be read, so no call will be placed'}`);
console.log(`on hold: ${report.holdCount} (clear each with npm run call:clear-hold after checking with the person)`);
console.log(`script: ${report.scriptProblems.length === 0 ? 'ok' : report.scriptProblems.join('; ')}`);
console.log(`published agent: ${report.agent.ok ? 'matches cartesia/agent/ exactly' : `${report.agent.code} (${report.agent.what})`}`);
console.log(`calling hours now: ${report.insideHoursNow ? 'yes, for everyone on the list' : 'no (9 AM to 9 PM in their time zone and in Pacific time)'}`);
console.log(`contacts every call would refuse: ${report.unreachable.length === 0 ? 'none' : report.unreachable.map((u) => `${u.contact} (${u.code})`).join(', ')}`);
if (!report.ok) process.exitCode = 1;
