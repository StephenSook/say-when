// Moss bridge for the restaurant test: the repo's own @say-when/moss package (../../moss/dist), driven over
// stdin/stdout with one JSON object per line. Requests: {id, op: start|index|search|close, ...}; replies {id, ok, ...}.
// It never logs document or query text (moss/README.md privacy rules): stderr only gets operation names.
import readline from 'node:readline';

import { MossRun, WebIndex, closeOnSignals } from '../../moss/dist/index.js';

const run = new MossRun({ onEvent: (e) => process.stderr.write(`moss: ${e.op ?? 'event'} ${e.ok === false ? 'failed' : ''}\n`) });
closeOnSignals(run);
const web = new WebIndex(run, { searchTopK: 50, maxChunksPerRow: 2 });
const reply = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const ops = {
    start: async () => ({ info: await run.start() }),
    index: async ({ questionId, rows }) => ({ result: await web.index(questionId, rows) }),
    search: async ({ questionId, query, topK }) => {
        const found = await web.search(questionId, query, { topK: topK ?? 50, source: 'maps' });
        const seen = new Set();
        const order = [];
        for (const hit of found.hits) {
            const id = hit.row?.id;
            if (id && !seen.has(id)) {
                seen.add(id);
                order.push({ id, score: hit.score });
            }
        }
        return { order, mossMs: found.mossMs, wallMs: found.wallMs };
    },
    forget: async ({ questionId }) => ({ removed: await web.forget(questionId) }),
    close: async () => ({ info: await run.close() }),
};

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
    let req;
    try {
        req = JSON.parse(line);
        const value = await ops[req.op](req);
        reply({ id: req.id, ok: true, ...value });
        if (req.op === 'close') break;
    } catch (err) {
        reply({ id: req?.id ?? null, ok: false, error: err?.code ?? err?.name ?? 'error', message: String(err?.message ?? err).slice(0, 300) });
    }
}
await run.close();
process.exit(0);
