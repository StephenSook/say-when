import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type * as Actor from '../../form-errand/src/types.js';
import { ConfigError, type ApifyConfig } from '../src/config.js';
import type * as Client from '../src/errand-types.js';
import { FormErrandClient, UnknownOutcomeError, type SubmitRequest } from '../src/errand.js';
import type { PipelineEvent } from '../src/events.js';
import { ApifyHttpError } from '../src/http.js';
import { TOKEN, fakeFetch, hang, json, networkError, text } from './fake-fetch.js';
import {
    BAD_INPUT,
    CAPTCHA_REFUSED,
    CLICK_UNCERTAIN,
    CONFIRMED_DUPLICATE,
    NO_CONFIRMATION,
    PREVIEWED,
    SUBMITTED,
    UNCONFIRMED_DUPLICATE,
} from './fixtures.js';

// Compile-time check, run by `npm run typecheck`: our copies must be identical to the Actor's own types.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const typesMatch: [
    Same<Client.ErrandResult, Actor.ErrandResult>,
    Same<Client.FieldInput, Actor.FieldInput>,
    Same<Client.FieldValue, Actor.FieldValue>,
    Same<Client.RefusalCode, Actor.RefusalCode>,
    Same<Client.Refusal, Actor.Refusal>,
    Same<Client.ErrandStatus, Actor.ErrandStatus>,
    Same<Client.ReadBackItem, Actor.ReadBackItem>,
    Same<Client.QuestionInfo, Actor.QuestionInfo>,
    Same<Client.Mode, Actor.Mode>,
] = [true, true, true, true, true, true, true, true, true];

const URL_BASE = 'https://someone--confirm-gated-form-errand.apify.actor';
const FIELDS = [
    { label: 'Who is this from?', value: 'Demo user', source: 'memory' },
    { label: 'What do you need?', value: 'Meal or drink' },
    { label: 'Details', value: 'Lunch at the cafe across the street.' },
];
const SUBMIT: SubmitRequest = { formUrl: 'demo', fields: FIELDS, confirm: true, confirmDigest: '3172ba2e39fc4791' };

function client(fetch: ConstructorParameters<typeof FormErrandClient>[0]['fetch'], extra: { events?: PipelineEvent[] } = {}) {
    return new FormErrandClient({
        url: `${URL_BASE}/`,
        token: TOKEN,
        fetch,
        retryBaseMs: 1,
        timeoutsMs: { preview: 200, submit: 200 },
        ...(extra.events ? { onEvent: (e: PipelineEvent) => void extra.events?.push(e) } : {}),
    });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    assert.fail('expected a rejection');
}

describe('FormErrandClient', () => {
    it('keeps its copied types identical to the Actor types', () => {
        assert.ok(typesMatch.every(Boolean));
    });

    it('previews with a POST that carries only the allowed fields', async () => {
        const { fetch, calls } = fakeFetch(json(PREVIEWED));
        const res = await client(fetch).preview({ formUrl: 'demo', fields: FIELDS, includeScreenshot: false, disclosureText: '' });
        assert.equal(res.status, 'previewed');
        assert.equal(res.previewDigest, '3172ba2e39fc4791');
        assert.equal(calls[0].url, `${URL_BASE}/preview`);
        assert.equal(calls[0].method, 'POST');
        assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(calls[0].headers['content-type'], 'application/json');
        assert.deepEqual(calls[0].body, { formUrl: 'demo', fields: FIELDS, includeScreenshot: false, disclosureText: '' });
    });

    it('inspects with only the form address', async () => {
        const { fetch, calls } = fakeFetch(json({ ...PREVIEWED, status: 'inspected', mode: 'inspect', readBack: [] }));
        const res = await client(fetch).inspect({ formUrl: 'https://forms.example.com/f' });
        assert.equal(res.status, 'inspected');
        assert.equal(calls[0].url, `${URL_BASE}/inspect`);
        assert.deepEqual(calls[0].body, { formUrl: 'https://forms.example.com/f' });
    });

    it('submits with confirm and the digest and returns the confirmation', async () => {
        const { fetch, calls } = fakeFetch(json(SUBMITTED));
        const res = await client(fetch).submit(SUBMIT);
        assert.equal(res.status, 'submitted');
        assert.equal(res.confirmationText, 'Your request was received.');
        assert.equal(calls[0].url, `${URL_BASE}/submit`);
        assert.deepEqual(calls[0].body, { formUrl: 'demo', fields: FIELDS, confirm: true, confirmDigest: '3172ba2e39fc4791' });
    });

    it('refuses to submit without confirm or a valid digest, before any request', async () => {
        const { fetch, calls } = fakeFetch(json(SUBMITTED));
        const c = client(fetch);
        const unconfirmed = { ...SUBMIT, confirm: false } as unknown as SubmitRequest;
        await assert.rejects(c.submit(unconfirmed), TypeError);
        await assert.rejects(c.submit({ ...SUBMIT, confirmDigest: 'XYZ' }), TypeError);
        await assert.rejects(c.submit({ ...SUBMIT, confirmDigest: '3172BA2E39FC4791' }), TypeError);
        await assert.rejects(c.submit({ ...SUBMIT, fields: [] }), TypeError);
        await assert.rejects(c.submit({ ...SUBMIT, formUrl: ' ' }), TypeError);
        assert.equal(calls.length, 0);
    });

    it('never retries a submit; doubt becomes UnknownOutcomeError', async () => {
        for (const [reply, reason] of [
            [json({ error: 'Internal error. Nothing was sent.' }, 500), 'server_error'],
            [json({}, 503), 'server_error'],
            [json({}, 408), 'server_error'],
            [networkError('ECONNRESET'), 'network'],
            [hang, 'timeout'],
            [json({ unexpected: true }), 'bad_response'],
        ] as const) {
            const { fetch, calls } = fakeFetch(reply, json(SUBMITTED));
            const error = await rejection(client(fetch).submit(SUBMIT));
            assert.ok(error instanceof UnknownOutcomeError, String(error));
            assert.equal(error.reason, reason);
            assert.equal(calls.length, 1, 'submit must be sent at most once');
            assert.ok(!error.message.includes(TOKEN));
            assert.ok(!error.message.includes('Demo user'));
        }
    });

    it('treats a submit cancelled after it left as an unknown outcome, and one cancelled before as not sent', async () => {
        const during = new AbortController();
        const first = fakeFetch(hang);
        const pending = client(first.fetch).submit(SUBMIT, { signal: during.signal });
        setTimeout(() => during.abort(), 10);
        const late = await rejection(pending);
        assert.ok(late instanceof UnknownOutcomeError);
        assert.equal(late.reason, 'aborted');

        const before = new AbortController();
        before.abort();
        const second = fakeFetch(json(SUBMITTED));
        const early = await rejection(client(second.fetch).submit(SUBMIT, { signal: before.signal }));
        assert.ok(early instanceof ApifyHttpError);
        assert.equal(early.kind, 'aborted');
        assert.equal(early.attempts, 0);
        assert.equal(second.calls.length, 0);
    });

    it('reports a submit the platform refused outright as a plain error, since nothing ran', async () => {
        const { fetch, calls } = fakeFetch(json({ error: { type: 'invalid-token', message: 'Authentication token is not valid.' } }, 401));
        const error = await rejection(client(fetch).submit(SUBMIT));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.status, 401);
        assert.equal(calls.length, 1);
    });

    it('returns the Actor refusal that comes with HTTP 400', async () => {
        const { fetch } = fakeFetch(json(BAD_INPUT, 400));
        const res = await client(fetch).submit(SUBMIT);
        assert.equal(res.status, 'refused');
        assert.equal(res.refusal?.code, 'bad_input');
    });

    it('throws for a 400 that is not an errand result', async () => {
        const { fetch } = fakeFetch(json({ error: 'The body must be JSON.' }, 400));
        const error = await rejection(client(fetch).preview({ formUrl: 'demo', fields: FIELDS }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.status, 400);
        assert.equal(error.bodySnippet, 'The body must be JSON.');
    });

    it('retries a preview after a 503, since previewing never sends', async () => {
        const { fetch, calls } = fakeFetch(json({}, 503), json(PREVIEWED));
        const res = await client(fetch).preview({ formUrl: 'demo', fields: FIELDS });
        assert.equal(res.status, 'previewed');
        assert.equal(calls.length, 2);
    });

    it('rejects a 2xx preview body that is not an errand result', async () => {
        const { fetch } = fakeFetch(text('<html>proxy page</html>', 200), json({ status: 'weird' }));
        const error = await rejection(client(fetch).preview({ formUrl: 'demo', fields: FIELDS }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'bad_response');
    });

    it('reports content-free events, with refusals as errors', async () => {
        const events: PipelineEvent[] = [];
        const { fetch } = fakeFetch(json(PREVIEWED), json(CAPTCHA_REFUSED), json({}, 503));
        const c = client(fetch, { events });
        await c.preview({ formUrl: 'demo', fields: FIELDS });
        await c.preview({ formUrl: 'https://forms.example.com/f', fields: FIELDS });
        await rejection(c.submit(SUBMIT));
        assert.deepEqual(
            events.map((e) => [e.stage, e.status, e.detail]),
            [
                ['errand', 'started', 'preview'],
                ['errand', 'ok', 'preview previewed'],
                ['errand', 'started', 'preview'],
                ['errand', 'error', 'preview refused: captcha'],
                ['errand', 'started', 'submit'],
                ['errand', 'error', 'submit unknown outcome (server_error)'],
            ],
        );
        assert.deepEqual(events[1].counts, { questions: 5, readBack: 5, unmatched: 0, missingRequired: 0 });
        const all = JSON.stringify(events);
        for (const content of ['Demo user', 'Meal or drink', 'Lunch', 'Care team', 'forms.example.com', '3172ba2e39fc4791']) {
            assert.ok(!all.includes(content), content);
        }
    });

    it('refuses a reply with an unrecognized refusal code, and never puts its text in events', async () => {
        const events: PipelineEvent[] = [];
        const odd = { ...CAPTCHA_REFUSED, refusal: { code: 'Call Alex at 555-0100', reason: 'x' } };
        const { fetch } = fakeFetch(json(odd));
        const error = await rejection(client(fetch, { events }).preview({ formUrl: 'demo', fields: FIELDS }));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'bad_response');
        assert.equal(events.at(-1)?.detail, 'preview bad response');
        assert.ok(!JSON.stringify(events).includes('Alex'));
        assert.ok(!error.message.includes('Alex'));
    });

    it('keeps the token out of JSON and checks its URL', () => {
        const c = client(undefined);
        assert.equal(c.url, URL_BASE);
        assert.ok(!JSON.stringify(c).includes(TOKEN));
        assert.throws(() => new FormErrandClient({ url: 'http://example.com', token: TOKEN }), ConfigError);
        assert.throws(() => new FormErrandClient({ url: `${URL_BASE}?token=abc`, token: TOKEN }), ConfigError);
        assert.doesNotThrow(() => new FormErrandClient({ url: 'http://127.0.0.1:4321', token: TOKEN }));
    });

    it('builds from config and names FORM_ERRAND_URL when it is missing', () => {
        const config: ApifyConfig = { token: TOKEN, ragWebBrowserUrl: 'https://rag-web-browser.apify.actor' };
        assert.throws(() => FormErrandClient.fromConfig(config), (e: unknown) => e instanceof ConfigError && /FORM_ERRAND_URL/.test(e.message));
        assert.equal(FormErrandClient.fromConfig({ ...config, formErrandUrl: URL_BASE }).url, URL_BASE);
    });
});

describe('FormErrandClient reply checks', () => {
    const long = 'x'.repeat(20_001);
    const malformed: Array<[string, unknown]> = [
        ['a null read-back item', { ...PREVIEWED, readBack: [null] }],
        ['no timings', { ...PREVIEWED, timings: undefined }],
        ['a read-back value that is not text', { ...PREVIEWED, readBack: [{ label: 'Details', value: 7, matchedBy: 'label' }] }],
        ['a question of an unknown kind', { ...PREVIEWED, questions: [{ label: 'Q', kind: 'slider', required: false }] }],
        ['a digest that is not 16 hex characters', { ...PREVIEWED, previewDigest: 'not-a-digest' }],
        ['the wrong mode', { ...PREVIEWED, mode: 'submit' }],
        ['a status preview cannot return', { ...SUBMITTED, mode: 'preview' }],
        ['a refusal on a preview', { ...PREVIEWED, refusal: { code: 'captcha', reason: 'x' } }],
        ['a preview without a digest', { ...PREVIEWED, previewDigest: null }],
        ['a label that is far too long', { ...PREVIEWED, readBack: [{ label: long, value: 'v', matchedBy: 'label' }] }],
        ['too many read-back items', { ...PREVIEWED, readBack: Array.from({ length: 51 }, () => PREVIEWED.readBack[0]) }],
        ['an inline screenshot that is not text', { ...PREVIEWED, screenshotBase64: 12 }],
    ];

    for (const [what, body] of malformed) {
        it(`preview refuses a reply with ${what}, without quoting it`, async () => {
            const { fetch } = fakeFetch(json(body));
            const error = await rejection(client(fetch).preview({ formUrl: 'demo', fields: FIELDS }));
            assert.ok(error instanceof ApifyHttpError, String(error));
            assert.equal(error.kind, 'bad_response');
            for (const content of ['Demo user', 'Meal or drink', 'Lunch', long.slice(0, 50)]) assert.ok(!error.message.includes(content));
        });
    }

    it('submit treats a malformed reply as an unknown outcome and never reports it as submitted', async () => {
        const events: PipelineEvent[] = [];
        const { fetch } = fakeFetch(json({ ...SUBMITTED, readBack: [null], timings: undefined }));
        const error = await rejection(client(fetch, { events }).submit(SUBMIT));
        assert.ok(error instanceof UnknownOutcomeError);
        assert.equal(error.reason, 'bad_response');
        assert.deepEqual(events.map((e) => e.detail), ['submit', 'submit unknown outcome (bad_response)']);
    });

    it('submit never accepts a status only a preview can return', async () => {
        const { fetch } = fakeFetch(json({ ...PREVIEWED, mode: 'submit' }));
        const error = await rejection(client(fetch).submit(SUBMIT));
        assert.ok(error instanceof UnknownOutcomeError);
        assert.equal(error.reason, 'bad_response');
    });

    it('a refused result that carries an unknown-outcome code is invalid, so unknown', async () => {
        const { fetch } = fakeFetch(json({ ...BAD_INPUT, refusal: { code: 'click_uncertain', reason: 'x' } }));
        const error = await rejection(client(fetch).submit(SUBMIT));
        assert.ok(error instanceof UnknownOutcomeError);
        assert.equal(error.reason, 'bad_response');
    });

    it('click_uncertain and no_confirmation reject with UnknownOutcomeError, keeping the result out of logs', async () => {
        for (const [reply, reason] of [
            [CLICK_UNCERTAIN, 'click_uncertain'],
            [NO_CONFIRMATION, 'no_confirmation'],
        ] as const) {
            const events: PipelineEvent[] = [];
            const { fetch, calls } = fakeFetch(json(reply), json(SUBMITTED));
            const error = await rejection(client(fetch, { events }).submit(SUBMIT));
            assert.ok(error instanceof UnknownOutcomeError);
            assert.equal(error.reason, reason);
            assert.equal(error.result?.status, 'failed');
            assert.equal(error.result?.refusal?.code, reason);
            assert.equal(calls.length, 1);
            assert.ok(!Object.keys(error).includes('result'));
            assert.ok(!JSON.stringify(error).includes('Demo user'));
            assert.equal(events.at(-1)?.detail, `submit unknown outcome (${reason})`);
        }
    });

    it('a duplicate resolves only when the first send was confirmed', async () => {
        const confirmed = fakeFetch(json(CONFIRMED_DUPLICATE));
        const res = await client(confirmed.fetch).submit(SUBMIT);
        assert.equal(res.status, 'duplicate');
        assert.equal(res.confirmationText, 'Your request was received.');

        const unconfirmed = fakeFetch(json(UNCONFIRMED_DUPLICATE));
        const error = await rejection(client(unconfirmed.fetch).submit(SUBMIT));
        assert.ok(error instanceof UnknownOutcomeError);
        assert.equal(error.reason, 'unconfirmed_duplicate');
    });

    it('does not trust a "submitted" reply for a digest the person did not confirm', async () => {
        const { fetch } = fakeFetch(json({ ...SUBMITTED, previewDigest: 'aaaaaaaaaaaaaaaa' }));
        const error = await rejection(client(fetch).submit(SUBMIT));
        assert.ok(error instanceof UnknownOutcomeError);
        assert.equal(error.reason, 'bad_response');
    });

    // Codex review, round 2: a duplicate skipped the digest check, and only a literal null confirmation counted.
    const zeroWidth = String.fromCharCode(0x200b);
    const notProof: Array<[string, unknown, string]> = [
        ['a duplicate for another digest', { ...CONFIRMED_DUPLICATE, previewDigest: 'aaaaaaaaaaaaaaaa' }, 'bad_response'],
        ['a duplicate with no digest', { ...CONFIRMED_DUPLICATE, previewDigest: null }, 'bad_response'],
        ['a duplicate with an empty confirmation', { ...CONFIRMED_DUPLICATE, confirmationText: '' }, 'unconfirmed_duplicate'],
        ['a duplicate with a blank confirmation', { ...CONFIRMED_DUPLICATE, confirmationText: ' \n\t ' }, 'unconfirmed_duplicate'],
        ['a duplicate with an invisible confirmation', { ...CONFIRMED_DUPLICATE, confirmationText: zeroWidth }, 'unconfirmed_duplicate'],
        ['a submit with an empty confirmation', { ...SUBMITTED, confirmationText: '' }, 'bad_response'],
        ['a submit with a blank confirmation', { ...SUBMITTED, confirmationText: '   ' }, 'bad_response'],
        ['a submit with an invisible confirmation', { ...SUBMITTED, confirmationText: `${zeroWidth} ` }, 'bad_response'],
        ['a submit with no digest', { ...SUBMITTED, previewDigest: null }, 'bad_response'],
    ];
    for (const [what, reply, reason] of notProof) {
        it(`never resolves ${what}; it is an unknown outcome`, async () => {
            const events: PipelineEvent[] = [];
            const { fetch, calls } = fakeFetch(json(reply), json(SUBMITTED));
            const error = await rejection(client(fetch, { events }).submit(SUBMIT));
            assert.ok(error instanceof UnknownOutcomeError, String(error));
            assert.equal(error.reason, reason);
            assert.equal(calls.length, 1, 'submit must be sent at most once');
            assert.equal(events.at(-1)?.detail, `submit unknown outcome (${reason})`);
            for (const content of ['Demo user', 'Meal or drink', 'Lunch', 'received', '3172ba2e39fc4791']) {
                assert.ok(!error.message.includes(content), content);
                assert.ok(!JSON.stringify(error).includes(content), content);
            }
        });
    }

    it('still resolves a duplicate for the confirmed digest whose confirmation has text', async () => {
        const { fetch } = fakeFetch(json({ ...CONFIRMED_DUPLICATE, confirmationText: '  Your response has been recorded.  ' }));
        const res = await client(fetch).submit(SUBMIT);
        assert.equal(res.status, 'duplicate');
        assert.equal(res.previewDigest, SUBMIT.confirmDigest);
    });

    it('refuses a reply that says it is larger than 16 MiB before reading it', async () => {
        const huge = (): Response =>
            new Response(JSON.stringify(SUBMITTED), { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(17 * 1024 * 1024) } });
        const preview = await rejection(client(fakeFetch(huge).fetch).preview({ formUrl: 'demo', fields: FIELDS }));
        assert.ok(preview instanceof ApifyHttpError);
        assert.equal(preview.kind, 'bad_response');
        assert.match(preview.bodySnippet, /larger than/);
        const submit = await rejection(client(fakeFetch(huge).fetch).submit(SUBMIT));
        assert.ok(submit instanceof UnknownOutcomeError);
        assert.equal(submit.reason, 'bad_response');
    });
});
