// npm run call:delete -- <call_id> [<call_id> ...]
// After judging: deletes each call's transcript, recording and logs at Cartesia. Cannot be undone.

import { deleteCallData } from '../call.js';
import { apiKeyFromEnv } from '../server.js';
import { loadRepoEnv, positionals } from './args.js';

loadRepoEnv();
const ids = positionals(process.argv.slice(2));
if (ids.length === 0) {
    console.error('Pass one or more call ids (agent_call_id values).');
    process.exit(1);
}
const apiKey = apiKeyFromEnv();
let failed = 0;
for (const callId of ids) {
    const result = await deleteCallData({ apiKey, callId });
    if (!result.deleted) failed++;
    console.log(`${callId}: ${result.reason}`);
}
if (failed > 0) process.exitCode = 1;
