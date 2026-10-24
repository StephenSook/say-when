import { Actor, log } from 'apify';

import { launchBrowser } from './browser.js';
import { runErrand, type ErrandDeps } from './errand.js';
import { parsePrefixes, refusal } from './guards.js';
import { SubmitLedger, type RecordStore } from './ledger.js';
import { createErrandServer, type Route } from './server.js';
import type { ErrandInput, ErrandResult } from './types.js';
import { InputError, parseInput } from './validate.js';

await Actor.init();

const standby = Actor.config.get('metaOrigin') === 'STANDBY' || process.env.FORM_ERRAND_SERVE === '1';
let shuttingDown = false;

const browser = await launchBrowser();
browser.on('disconnected', () => {
    if (shuttingDown) return;
    // Standby guidance: exit on an unrecoverable error so the platform starts a fresh run.
    log.error('The browser closed unexpectedly. Exiting so a fresh run takes over.');
    process.exit(1);
});

const ledgerStore = await Actor.openKeyValueStore('form-errand-ledger');
const runStore = await Actor.openKeyValueStore();

const records: RecordStore = {
    getValue: (key) => ledgerStore.getValue(key),
    setValue: (key, value) => ledgerStore.setValue(key, value),
};

const deps: ErrandDeps = {
    browser,
    ledger: new SubmitLedger(records),
    screenshots: {
        async save(key, jpeg) {
            await runStore.setValue(key, jpeg, { contentType: 'image/jpeg' });
            return await runStore.getPublicUrl(key);
        },
    },
    allowedPrefixes: parsePrefixes(process.env.ALLOWED_FORM_PREFIXES),
    allowLocal: false,
    log: (message) => log.info(message),
};

Actor.on('aborting', async () => {
    shuttingDown = true;
    await browser.close().catch(() => undefined);
    await Actor.exit();
});

function inputErrorResult(raw: unknown, message: string): ErrandResult {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
        status: 'refused',
        mode: r.mode === 'inspect' || r.mode === 'submit' ? r.mode : 'preview',
        formUrl: typeof r.formUrl === 'string' ? r.formUrl : '',
        finalUrl: null,
        formTitle: null,
        fillAllowed: false,
        questions: [],
        readBack: [],
        readBackText: null,
        previewDigest: null,
        unmatched: [],
        missingRequired: [],
        refusal: refusal('bad_input', message),
        confirmationText: null,
        screenshotKey: null,
        screenshotUrl: null,
        timings: { loadMs: null, fillMs: null, submitMs: null, totalMs: 0 },
        submittedAt: null,
    };
}

async function handle(raw: unknown): Promise<ErrandResult> {
    let input: ErrandInput;
    try {
        input = parseInput(raw);
    } catch (e) {
        if (e instanceof InputError) return inputErrorResult(raw, e.message);
        throw e;
    }
    log.info(`errand ${input.mode}`, { answers: input.fields.length });
    return runErrand(input, deps);
}

if (standby) {
    const about = {
        name: 'confirm-gated-form-errand',
        endpoints: {
            'POST /inspect': 'List the questions on a form.',
            'POST /preview': 'Fill the form, read every value back, return a digest and a screenshot. Never submits.',
            'POST /submit': 'Submit only with confirm: true and the digest from the preview.',
        },
    };
    const server = createErrandServer(async (route: Route, body: unknown) => {
        const mode = route.slice(1);
        const merged = body && typeof body === 'object' && !Array.isArray(body) ? { ...body, mode } : body;
        const result = await handle(merged);
        return { status: result.refusal?.code === 'bad_input' ? 400 : 200, body: result };
    }, about);
    const port = Number(Actor.config.get('standbyPort') ?? process.env.PORT ?? 4321);
    server.listen(port, Actor.isAtHome() ? undefined : '127.0.0.1', () => log.info(`Standby server listening on ${port}`));
} else {
    const raw = await Actor.getInput();
    const result = await handle(raw);
    const { screenshotBase64: _omit, ...stored } = result;
    await Actor.setValue('OUTPUT', stored);
    await Actor.pushData({
        status: result.status,
        mode: result.mode,
        formTitle: result.formTitle,
        formUrl: result.formUrl,
        fillAllowed: result.fillAllowed,
        readBackText: result.readBackText,
        previewDigest: result.previewDigest,
        confirmationText: result.confirmationText,
        screenshotUrl: result.screenshotUrl,
        unmatched: result.unmatched,
        missingRequired: result.missingRequired,
        refusalCode: result.refusal?.code ?? null,
        refusalReason: result.refusal?.reason ?? null,
        totalMs: result.timings.totalMs,
        submittedAt: result.submittedAt,
    });
    const line =
        result.status === 'refused' || result.status === 'failed'
            ? `${result.status}: ${result.refusal?.reason ?? ''}`
            : `${result.status}${result.previewDigest ? ` (digest ${result.previewDigest})` : ''}`;
    await Actor.setStatusMessage(line);
    shuttingDown = true;
    await browser.close();
    await Actor.exit();
}
