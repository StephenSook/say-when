// Bridge to the repo's own TypeScript packages for the Python test harnesses: @say-when/moss (../../moss/dist)
// and @say-when/apify-client (../../apify/client/dist), driven over stdin/stdout with one JSON object per line.
// Requests: {id, op, ...}; replies {id, ok, ...}. Keys come from the environment the Python side passes in.
// It never logs questions, page text or keys (moss/ and apify/client/ privacy rules): stderr only gets op names.
import readline from 'node:readline';

import { MossRun, WebIndex, closeOnSignals } from '../../moss/dist/index.js';

const run = new MossRun({ onEvent: (e) => process.stderr.write(`moss: ${e.op ?? 'event'} ${e.ok === false ? 'failed' : ''}\n`) });
closeOnSignals(run);
const places = new WebIndex(run, { searchTopK: 50, maxChunksPerRow: 2 }); // short restaurant rows
const pages = new WebIndex(run, { searchTopK: 8 });                        // full web pages, chunked
const reply = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
let apify = null; // loaded on first use, so the restaurant test does not need APIFY_TOKEN

async function apifyClient() {
    if (!apify) {
        const mod = await import('../../apify/client/dist/index.js');
        apify = { mod, config: mod.loadConfig(process.env) };
    }
    return apify;
}

const ops = {
    start: async () => ({ info: await run.start() }),
    index: async ({ questionId, rows }) => ({ result: await places.index(questionId, rows) }),
    search: async ({ questionId, query, topK }) => {
        const found = await places.search(questionId, query, { topK: topK ?? 50, source: 'maps' });
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
    forget: async ({ questionId }) => ({ removed: (await places.forget(questionId)) + (await pages.forget(questionId)) }),

    // Apify RAG Web Browser: Google search + the top pages as text (16-31 s per query in the Actor's benchmark).
    // With Moss open, the pages are chunked and indexed and the passages closest to the question come back;
    // without it, the start of each page comes back.
    webAsk: async ({ questionId, question, maxResults, useMoss, topK }) => {
        const { mod, config } = await apifyClient();
        const t0 = performance.now();
        const found = await mod.searchWeb(question, { config, maxResults: maxResults ?? 3, maxTextChars: 12_000 });
        const searchMs = Math.round(performance.now() - t0);
        const sources = found.rows.map((r) => ({ title: r.title, url: r.url ?? null }));
        if (!useMoss) {
            return { passages: found.rows.map((r) => ({ text: r.text.slice(0, 1500), title: r.title, url: r.url ?? null })),
                     sources, searchMs, partial: found.partial, ranked: false };
        }
        await pages.index(questionId, found.rows);
        const hits = await pages.search(questionId, question, { topK: topK ?? 6, source: 'web' });
        return { passages: hits.hits.map((h) => ({ text: h.text, title: h.row?.title ?? '', url: h.row?.url ?? null, score: h.score })),
                 sources, searchMs, mossMs: hits.mossMs, partial: found.partial, ranked: true };
    },
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
        reply({ id: req?.id ?? null, ok: false, error: err?.code ?? err?.kind ?? err?.name ?? 'error',
                message: String(err?.message ?? err).slice(0, 300) });
    }
}
await run.close();
process.exit(0);
