import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type * as Actor from '../../form-errand/src/types.js';
import { ConfigError, type ApifyConfig } from '../src/config.js';
import type * as Client from '../src/errand-types.js';
import { FormErrandClient, UnknownOutcomeError, type SubmitRequest } from '../src/errand.js';
import type { PipelineEvent } from '../src/events.js';
import { ApifyHttpError } from '../src/http.js';
import { TOKEN, fakeFetch, hang, json, networkError, text } from './fake-fetch.js';
import { BAD_INPUT, CAPTCHA_REFUSED, PREVIEWED, SUBMITTED } from './fixtures.js';

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

    it('reports an unrecognized refusal code as "unknown", never its text', async () => {
        const events: PipelineEvent[] = [];
        const odd = { ...CAPTCHA_REFUSED, refusal: { code: 'Call Alex at 555-0100', reason: 'x' } };
        const { fetch } = fakeFetch(json(odd));
        await client(fetch, { events }).preview({ formUrl: 'demo', fields: FIELDS });
        assert.equal(events.at(-1)?.detail, 'preview refused: unknown');
        assert.ok(!JSON.stringify(events).includes('Alex'));
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
