import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ApifyHttpError, type HttpErrorKind, type RefusalCode } from '@say-when/apify-client';
import type { RunErrorCode } from '@say-when/moss';

import { DETAIL_PATTERN } from '../src/contract.js';
import { countsJson, label, payloadJson } from '../src/pipeline.js';
import type { PlannerErrorCode } from '../src/planner/types.js';
import { excerpt, maskPageText, memoryHitPayload, searchRowPayload } from '../src/privacy.js';
import { errandResult, harness, memoryHit, placeRow, reply, SECRET, snapshot, waitFor, webRow, type Harness } from './helpers.js';

let open: Harness | null = null;
afterEach(async () => {
    open?.dialer.handle?.finish({ result: 'answered' });
    await open?.orchestrator.stop(1_000);
    open = null;
});

const FIELDS = JSON.stringify([
    { label: 'What do you need?', value: 'Meal or drink' },
    { label: 'Details', value: SECRET.formValue },
]);

/** Runs a web question, an errand and a call with marker strings everywhere content can come from. */
async function fullFlow(): Promise<Harness> {
    const h = harness({ contacts: [{ contactId: 'leon', name: SECRET.contactName }] });
    open = h;
    h.memory.recallResult = {
        hits: [
            memoryHit(1, { text: `Q: Lunch?\nA: ${SECRET.privateMemory}`, reply: SECRET.privateMemory }),
            memoryHit(2, { text: `Q: Lunch?\nA: ${SECRET.sharedMemory}`, reply: SECRET.sharedMemory, shareable: true, sharedText: SECRET.sharedMemory }),
        ],
        instant: [SECRET.privateMemory, SECRET.sharedMemory],
        mossMs: 2,
        wallMs: 3,
    };
    h.search.rows = [webRow(1), placeRow(2)];
    h.api.reply({
        answer_mode: 'pick',
        options: [
            reply({ text: `${SECRET.option} one`, tone: 'warm', sources: ['w1', 'm1'] }),
            reply({ text: `${SECRET.option} two`, tone: 'calm', sources: ['m2'] }),
        ],
    });
    h.orchestrator.start();

    const jobId = h.db.addOptionsJob({ questionText: SECRET.question });
    await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'options');

    const { jobId: previewJob, errandId } = h.db.addPreviewJob({ formKey: 'care_team_request', formUrl: 'demo', formTitle: 'Care team request', fieldsJson: FIELDS });
    await waitFor(() => h.db.job(previewJob)?.status === 'done', 3_000, 'preview');
    h.db.confirmErrand(errandId);
    await waitFor(() => h.db.errands.get(errandId)?.status === 'submitted', 3_000, 'submitted');

    const callId = h.db.addConfirmedCall({ requestId: 'call-test-9', contactId: 'leon', digest: 'fedcba9876543210' });
    await waitFor(() => h.dialer.placed.length === 1, 3_000, 'placed');
    h.callRunner.onSnapshot(snapshot('call-test-9', 'connected', [{ role: 'user', text: `This is ${SECRET.contactName}, sure.` }]));
    h.dialer.handle?.finish({ result: 'answered' });
    await waitFor(() => h.db.calls.get(callId)?.status === 'ended', 3_000, 'ended');
    return h;
}

/** The failure paths, with content in every error message, body and reason the services could send back. */
async function failureFlow(): Promise<Harness> {
    const h = harness();
    open = h;
    h.memory.recallError = new Error(`moss down while reading ${SECRET.privateMemory} for ${SECRET.contactName}`);
    h.search.error = new ApifyHttpError({
        service: 'web-search',
        endpoint: 'POST /search',
        kind: 'http',
        status: 402,
        attempts: 1,
        bodySnippet: `${SECRET.question} ${SECRET.phone}`,
    });
    // Two options with the same text and tone: the planner's reply is invalid, and it quotes content back.
    h.api.reply({
        answer_mode: 'pick',
        options: [
            reply({ text: `${SECRET.option} ${SECRET.contactName}`, tone: 'warm' }),
            reply({ text: `${SECRET.option} ${SECRET.contactName}`, tone: 'warm' }),
        ],
    });
    h.errands.previewResult = errandResult({
        status: 'refused',
        previewDigest: null,
        readBackText: null,
        refusal: { code: 'captcha', reason: `The form for ${SECRET.formValue} wants a CAPTCHA` },
    });
    h.orchestrator.start();
    const jobId = h.db.addOptionsJob({ questionText: SECRET.question });
    await waitFor(() => h.db.job(jobId)?.status === 'failed', 3_000, 'options failed');
    const { errandId } = h.db.addPreviewJob({ formKey: 'care_team_request', formUrl: 'demo', formTitle: 'Care team request', fieldsJson: FIELDS });
    await waitFor(() => h.db.errands.get(errandId)?.status === 'refused', 3_000, 'preview refused');
    return h;
}

const ALL_SECRETS = Object.entries(SECRET);

/** Lower case, every run of other characters as one space: how label() and loose rendering reshape text. */
const loose = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Distinctive words of the secrets, so a partial or reshaped leak is caught as well as a whole one. */
const MARKERS = ['zorbleton', 'privmem', 'sharedmem', 'leonora', 'formvalue', 'optiontext', '415 555 0199', '4155550199'];

/** The secrets found in `text`, whole or by a distinctive word, ignoring case and punctuation. */
function leaks(text: string): string[] {
    const hay = loose(text);
    const found: string[] = [];
    for (const [name, secret] of ALL_SECRETS) if (hay.includes(loose(secret))) found.push(name);
    for (const marker of MARKERS) if (hay.includes(marker)) found.push(marker);
    return found;
}

// Every label the sidecar can write, built from its fixed parts. A Record over each code union, so a new code fails
// the typecheck until it is added here.
const PLANNER_CODES: Record<PlannerErrorCode, true> = {
    timeout: true,
    network: true,
    rate_limited: true,
    overloaded: true,
    unavailable: true,
    refused: true,
    truncated: true,
    invalid_reply: true,
    auth: true,
    bad_request: true,
    not_found: true,
    aborted: true,
    error: true,
};
const REFUSAL_CODES: Record<RefusalCode, true> = {
    bad_input: true,
    bad_url: true,
    load_failed: true,
    captcha: true,
    login: true,
    payment: true,
    upload: true,
    no_form: true,
    not_allowed: true,
    unmatched_fields: true,
    missing_required: true,
    not_confirmed: true,
    digest_mismatch: true,
    no_submit_button: true,
    no_confirmation: true,
    click_uncertain: true,
};
const HTTP_KINDS: Record<Exclude<HttpErrorKind, 'http'>, true> = { timeout: true, network: true, aborted: true, bad_response: true };
const RUN_CODES: Record<Exclude<RunErrorCode, 'not_open'>, true> = { config: true, already_open: true, cancelled: true, restart_needed: true };
/** moss/src/events.ts MOSS_CODES, lowercased by label(), plus its ERROR fallback. */
const MOSS_CALL_CODES = ['invalid_argument', 'not_found', 'unauthorized', 'network', 'deserialization', 'model_unavailable', 'internal', 'error'];

const ALLOWED_LABELS: ReadonlySet<string> = (() => {
    const set = new Set<string>([
        'memory off',
        'moss closed',
        'moss paused: usage limit reached',
        'memory recall',
        'web index',
        'web search',
        'memory write back',
        'memory write back failed',
        'skipped',
        'search off',
        'memory first',
        'memory first refused',
        'claude',
        'claude error',
        'preview',
        'preview previewed',
        'preview read-back too long',
        'preview bad response',
        'preview error',
    ]);
    const space = (code: string) => code.replace(/_/g, ' ');
    for (const step of ['memory recall', 'web index', 'web search']) {
        set.add(`${step} failed`);
        for (const code of ['timeout', 'moss closed', ...Object.keys(RUN_CODES), ...MOSS_CALL_CODES]) set.add(`${step} failed: ${code}`);
    }
    for (const kind of ['web', 'maps']) {
        for (const tail of ['', ' partial', ' error', ' http', ...Object.keys(HTTP_KINDS).map((k) => ` ${space(k)}`)]) set.add(`${kind}${tail}`);
    }
    for (const code of Object.keys(PLANNER_CODES)) set.add(`claude ${space(code)}`);
    for (const code of Object.keys(HTTP_KINDS)) set.add(`preview ${space(code)}`);
    for (const code of [...Object.keys(REFUSAL_CODES), 'unknown']) set.add(`preview refused: ${code}`);
    return set;
})();

/** `web http 402`, `preview http 0`: a status number is the only free part of a label. */
const HTTP_LABEL = /^(web|maps|preview) http \d{1,3}$/;

const labelAllowed = (detail: string) => ALLOWED_LABELS.has(detail) || HTTP_LABEL.test(detail);

/** Every count key the sidecar writes. */
const COUNT_KEYS: ReadonlySet<string> = new Set([
    'hitCount', 'memoryAllowed', 'mossOpen', 'instant', 'mossMs', 'needsWeb', 'searches', 'rowCount', 'partial', 'rows',
    'chunks', 'indexMs', 'skippedRows', 'memoryHits', 'webHits', 'optionCount', 'final', 'yesNo', 'attempts', 'claudeMs',
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'fallbackUsed', 'droppedCalls', 'problems', 'readBack', 'unmatched',
    'missingRequired', 'previewMs', 'written', 'empty', 'added', 'updated', 'payloadTrimmed',
]);

/** Checks every public event of a run: no content, only known labels and count keys. */
function checkPublicEvents(h: Harness): void {
    assert.ok(h.db.events.length > 0);
    for (const event of h.db.events) {
        const text = `${event.stage} ${event.status} ${event.detail} ${event.countsJson}`;
        assert.deepEqual(leaks(text), [], `content reached a public event: ${event.stage} ${event.status}`);
        assert.match(event.detail, DETAIL_PATTERN);
        assert.ok(labelAllowed(event.detail), `a label outside the vocabulary: "${event.detail}"`);
        for (const [key, value] of Object.entries(JSON.parse(event.countsJson) as Record<string, unknown>)) {
            assert.ok(COUNT_KEYS.has(key), `a count key outside the vocabulary: ${key}`);
            assert.ok(typeof value === 'number' || typeof value === 'boolean', 'counts are numbers or booleans only');
        }
    }
}

describe('privacy', () => {
    it('keeps every piece of content out of the public pipeline events', async () => {
        checkPublicEvents(await fullFlow());
    });

    it('keeps content out of the public events on the failure paths too', async () => {
        const h = await failureFlow();
        checkPublicEvents(h);
        const details = h.db.events.map((e) => e.detail);
        assert.ok(details.includes('memory recall failed'));
        assert.ok(details.includes('web http 402'));
        assert.ok(details.includes('claude invalid reply'));
        assert.ok(details.includes('preview refused: captcha'));
    });

    it('keeps every piece of content out of the logs', async () => {
        for (const flow of [fullFlow, failureFlow]) {
            const h = await flow();
            const logs = h.log.text();
            assert.ok(logs.length > 0);
            assert.deepEqual(leaks(logs), [], 'content reached the log');
            await h.orchestrator.stop(1_000);
            open = null;
        }
    });

    it('catches reshaped, partial and off-vocabulary leaks (negative controls for the checks above)', () => {
        assert.deepEqual(leaks(label('web search')), []);
        assert.ok(leaks(label('searched', SECRET.question)).includes('question'), 'a question run through label() is caught whole');
        assert.ok(leaks(SECRET.contactName.toUpperCase()).includes('leonora'), 'case does not hide a name');
        assert.ok(leaks('step zorbleton').length > 0, 'a partial leak is caught by its distinctive word');
        assert.ok(leaks('call 415-555-0199').length > 0 && leaks('{"n":4155550199}').length > 0, 'a phone number in any shape');
        assert.ok(!labelAllowed(label('claude', SECRET.contactName)), 'a label carrying a name is outside the vocabulary');
        assert.ok(!labelAllowed(label('preview refused:', 'leonora')));
        assert.ok(labelAllowed('web http 402') && labelAllowed('preview refused: captcha') && labelAllowed('memory recall failed: timeout'));
        assert.ok(!COUNT_KEYS.has('leonora'));
    });

    it('never puts private memory text or the question in a payload; shared memory only as sharedText', async () => {
        const h = await fullFlow();
        const payloads = h.db.events.map((e) => e.payloadJson).filter(Boolean);
        const text = payloads.join('\n');
        assert.ok(!loose(text).includes('privmem'), 'private memory text reached a payload');
        assert.ok(!loose(text).includes(loose(SECRET.question)) && !loose(text).includes('zorbleton'), 'the question reached a payload');
        assert.ok(!loose(text).includes('415 555 0199'), 'a phone number reached a payload');
        assert.ok(text.includes('[number]'), 'numbers in page text are masked, not dropped silently');
        const hits = payloads.flatMap((p) => (JSON.parse(p) as { hits?: { sharedText?: string; text?: string; origin: string }[] }).hits ?? []);
        const shared = hits.filter((hit) => hit.sharedText !== undefined);
        assert.ok(shared.length > 0 && shared.every((hit) => hit.origin === 'memory' && hit.sharedText === SECRET.sharedMemory));
        assert.ok(hits.filter((hit) => hit.origin === 'memory').every((hit) => hit.text === undefined), 'memory hits carry no text field');
        const rows = payloads.flatMap((p) => (JSON.parse(p) as { rows?: { facts?: Record<string, unknown> }[] }).rows ?? []);
        assert.ok(rows.length > 0 && rows.every((row) => !row.facts || !('phone' in row.facts)), 'place phone numbers are dropped');
    });

    it('sends only the question to the web search, never memory', async () => {
        const h = await fullFlow();
        assert.equal(h.search.calls.length, 1);
        const query = loose(h.search.calls[0]?.query ?? '');
        assert.ok(!query.includes('privmem') && !query.includes('sharedmem'));
    });

    it('sends memory to the planner only when the job allows memory', async () => {
        const h = harness();
        open = h;
        h.memory.recallResult = { hits: [memoryHit(1)], instant: [], mossMs: 2, wallMs: 3 };
        h.api.reply({ answer_mode: 'yes_no', options: [reply({ text: 'Yes.', tone: 'warm' }), reply({ text: 'No.', tone: 'calm' })] });
        h.orchestrator.start();
        const jobId = h.db.addOptionsJob({ questionText: 'Are you tired?', memoryAllowed: false });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.memory.recalls.length, 0);
        assert.ok(!loose(h.api.userMessage()).includes('privmem'));
        assert.match(h.api.userMessage(), /Memory items: none\./);
    });

    it('writes read-back values only to the errand row, never to an event', async () => {
        const h = await fullFlow();
        const attach = h.db.applied.find((a) => a.name === 'agentAttachPreview')?.args as { readBackText: string };
        assert.equal(attach.readBackText, SECRET.readBack);
        const everything = loose(h.db.events.map((e) => `${e.detail} ${e.countsJson} ${e.payloadJson}`).join('\n'));
        assert.ok(!everything.includes(loose(SECRET.readBack)) && !everything.includes('formvalue'));
    });

    it('builds payloads by the screen rules', () => {
        assert.deepEqual(Object.keys(memoryHitPayload(memoryHit(1))).sort(), ['id', 'memoryType', 'origin', 'savedAt', 'score']);
        const shared = memoryHitPayload(memoryHit(1, { shareable: true, sharedText: 'Hello there' }));
        assert.equal(shared.sharedText, 'Hello there');
        const row = searchRowPayload(placeRow(1));
        assert.equal(row.facts?.address, '12 Main St');
        assert.ok(!('phone' in (row.facts ?? {})));
        assert.match(row.text, /\[number\]/);
        assert.equal(excerpt('a'.repeat(1000)).length, 300);
    });

    it('masks phone numbers, keys and tokens in page text, and keeps the facts the planner needs', () => {
        for (const phone of [
            '+1 415 555 0199',
            '(415) 555-0199',
            '415.555.0199',
            '555-0199',
            '+44 20 7946 0958',
            '415\u2011555\u20110199',
            '\u0664\u0661\u0665\u0665\u0665\u0665\u0660\u0661\u0669\u0669',
            '415\u00a0555\u00a00199',
            '415\u2053555\u20530199',
        ]) {
            assert.equal(maskPageText(`Call ${phone} today`), 'Call [number] today', phone);
        }
        for (const fact of ['Open 9 to 9 today', '12 Main St', 'Lunch is $12.99', 'Closed on 2026-10-24', 'Hours 10:00-22:00', 'Rated 4.5 by 120 people']) {
            assert.equal(maskPageText(fact), fact, fact);
        }
        assert.equal(excerpt('It opens at 9 and closes at 9.  Call 415 555 0199.'), 'It opens at 9 and closes at 9. Call [number].', 'the planner context keeps its facts');
        assert.equal(maskPageText('Call 415\u200b555\u200b0199 today'), 'Call [number] today', 'zero-width separators');
        assert.equal(maskPageText('Call \uff14\uff11\uff15-\uff15\uff15\uff15-\uff10\uff11\uff19\uff19 today'), 'Call [number] today', 'full-width digits');
        assert.equal(maskPageText('key sk-ant-abc123DEF here'), 'key [key] here');
        assert.equal(maskPageText('https://x.test/?api_key=SECRET1&q=1'), 'https://x.test/?api_key=[token]&q=1');
    });

    it('keeps labels in the module vocabulary and counts to numbers and booleans', () => {
        assert.equal(label('Moss paused: usage limit reached'), 'moss paused: usage limit reached');
        assert.equal(label('preview refused:', 'captcha'), 'preview refused: captcha');
        assert.equal(label('submit unknown outcome (click_uncertain)'), 'submit unknown outcome click_uncertain');
        assert.equal(label('', ''), 'step');
        assert.deepEqual(JSON.parse(countsJson({ rows: 2, partial: false, text: 'no' as unknown as number, bad: Number.NaN, 'bad key': 1 })), { rows: 2, partial: false });
        const big = payloadJson({ rows: Array.from({ length: 200 }, (_, i) => ({ id: i, text: 'x'.repeat(300) })) }, 'rows');
        assert.ok(Buffer.byteLength(big.json, 'utf8') <= 16_000);
        assert.ok(big.dropped > 0);
    });
});
