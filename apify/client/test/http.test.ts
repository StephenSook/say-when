import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError } from '../src/config.js';
import { ApifyHttpError, requestJson, scrub, snippetOf, type RequestOptions } from '../src/http.js';
import { TOKEN, deaf, fakeFetch, hang, json, networkError, recordSleep, text } from './fake-fetch.js';

const base = (extra: Partial<RequestOptions>): RequestOptions => ({
    service: 'test-service',
    method: 'GET',
    url: 'https://example.apify.actor/search?query=secret%20question',
    token: TOKEN,
    timeoutMs: 1_000,
    idempotent: true,
    ...extra,
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    assert.fail('expected a rejection');
}

describe('requestJson', () => {
    it('sends the token only as a Bearer header and refuses redirects', async () => {
        const { fetch, calls } = fakeFetch(json([{ ok: true }]));
        const res = await requestJson(base({ fetch }));
        assert.deepEqual(res.body, [{ ok: true }]);
        assert.equal(res.attempts, 1);
        assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(calls[0].headers.accept, 'application/json');
        assert.equal(calls[0].redirect, 'error');
        assert.ok(!calls[0].url.includes(TOKEN));
    });

    it('sends a JSON body with a content type', async () => {
        const { fetch, calls } = fakeFetch(json({ ok: true }, 201));
        const res = await requestJson(base({ fetch, method: 'POST', body: { a: 1 } }));
        assert.equal(res.status, 201);
        assert.equal(calls[0].method, 'POST');
        assert.equal(calls[0].headers['content-type'], 'application/json');
        assert.deepEqual(calls[0].body, { a: 1 });
    });

    it('retries idempotent reads on 429, 5xx and network errors with doubling waits', async () => {
        const { sleep, waits } = recordSleep();
        const { fetch, calls } = fakeFetch(json({}, 503), networkError(), json({}, 429), json(['done']));
        const res = await requestJson(base({ fetch, sleep, retries: 3 }));
        assert.deepEqual(res.body, ['done']);
        assert.equal(calls.length, 4);
        assert.equal(res.attempts, 4);
        assert.deepEqual(waits, [500, 1000, 2000]);
    });

    it('stops after the allowed retries and reports the last status', async () => {
        const { sleep } = recordSleep();
        const { fetch, calls } = fakeFetch(json({ error: { type: 'server-error', message: 'Busy' } }, 502));
        const error = await rejection(requestJson(base({ fetch, sleep, retries: 2 })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'http');
        assert.equal(error.status, 502);
        assert.equal(error.attempts, 3);
        assert.equal(error.bodySnippet, 'server-error: Busy');
        assert.equal(calls.length, 3);
    });

    it('never retries a call that is not idempotent', async () => {
        const { sleep, waits } = recordSleep();
        for (const reply of [json({}, 503), networkError()]) {
            const { fetch, calls } = fakeFetch(reply, json(['should not be reached']));
            await rejection(requestJson(base({ fetch, sleep, idempotent: false, retries: 5 })));
            assert.equal(calls.length, 1);
        }
        assert.deepEqual(waits, []);
    });

    it('does not retry other 4xx statuses', async () => {
        const { fetch, calls } = fakeFetch(json({ error: { type: 'invalid-input', message: 'Bad' } }, 400));
        const error = await rejection(requestJson(base({ fetch })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.status, 400);
        assert.equal(calls.length, 1);
    });

    it('waits as long as Retry-After asks when that is short, and gives up when it is long', async () => {
        const short = recordSleep();
        const first = fakeFetch(json({}, 429, { 'retry-after': '2' }), json([]));
        await requestJson(base({ fetch: first.fetch, sleep: short.sleep }));
        assert.deepEqual(short.waits, [2000]);

        const long = recordSleep();
        const second = fakeFetch(json({}, 429, { 'retry-after': '60' }), json([]));
        const error = await rejection(requestJson(base({ fetch: second.fetch, sleep: long.sleep })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.status, 429);
        assert.equal(second.calls.length, 1);
        assert.deepEqual(long.waits, []);
    });

    it('times out, aborts the request, and does not retry a timeout', async () => {
        const { fetch, calls } = fakeFetch(hang, json(['late']));
        const started = Date.now();
        const error = await rejection(requestJson(base({ fetch, timeoutMs: 50, retries: 3 })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'timeout');
        assert.equal(error.status, null);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].signal?.aborted, true);
        assert.ok(Date.now() - started < 1_000);
    });

    it('still gives up on time when fetch ignores its abort signal', async () => {
        const { fetch } = fakeFetch(deaf);
        const error = await rejection(requestJson(base({ fetch, timeoutMs: 50 })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'timeout');
    });

    it('lets a verdict turn a status into a timeout that is not retried', async () => {
        const { fetch, calls } = fakeFetch(json({ errorMessage: 'Timed out.' }, 500));
        const error = await rejection(requestJson(base({ fetch, classify: () => 'timeout' })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'timeout');
        assert.equal(error.status, 500);
        assert.equal(calls.length, 1);
    });

    it('reports a caller abort, with zero attempts when it came before sending', async () => {
        const before = new AbortController();
        before.abort();
        const first = fakeFetch(json([]));
        const early = await rejection(requestJson(base({ fetch: first.fetch, signal: before.signal })));
        assert.ok(early instanceof ApifyHttpError);
        assert.equal(early.kind, 'aborted');
        assert.equal(early.attempts, 0);
        assert.equal(first.calls.length, 0);

        const during = new AbortController();
        const second = fakeFetch(hang);
        const pending = requestJson(base({ fetch: second.fetch, signal: during.signal, timeoutMs: 5_000 }));
        setTimeout(() => during.abort(), 10);
        const late = await rejection(pending);
        assert.ok(late instanceof ApifyHttpError);
        assert.equal(late.kind, 'aborted');
        assert.equal(late.attempts, 1);
    });

    it('turns a 2xx body that is not JSON into bad_response', async () => {
        const { fetch } = fakeFetch(text('<html>gateway</html>', 200));
        const error = await rejection(requestJson(base({ fetch })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'bad_response');
    });

    it('returns the body of a passed-through status with a snippet', async () => {
        const { fetch } = fakeFetch(json({ status: 'refused' }, 400));
        const res = await requestJson(base({ fetch, passStatuses: [400] }));
        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { status: 'refused' });
        assert.equal(typeof res.snippet, 'string');
    });

    it('reports a network failure with its code only', async () => {
        const { fetch } = fakeFetch(networkError('ECONNREFUSED'));
        const error = await rejection(requestJson(base({ fetch, retries: 0 })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'network');
        assert.equal(error.code, 'ECONNREFUSED');
    });

    it('keeps the query string out of the message', async () => {
        const { fetch } = fakeFetch(json({ errorMessage: 'nope' }, 400));
        const error = await rejection(requestJson(base({ fetch })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.endpoint, 'GET example.apify.actor/search');
        assert.ok(!error.message.includes('secret question'));
        assert.ok(!error.message.includes('query'));
    });
});

describe('token safety', () => {
    it('scrubs the token, Apify-shaped tokens, token query params and Bearer values', () => {
        const other = ['apify', 'api', 'OTHERvalue123'].join('_');
        const out = scrub(`a ${TOKEN} b ${other} c https://x.test/?token=abc123&q=1 Authorization: Bearer zzz9`, TOKEN);
        assert.ok(!out.includes(TOKEN));
        assert.ok(!out.includes(other));
        assert.ok(!out.includes('abc123'));
        assert.ok(!out.includes('zzz9'));
        assert.match(out, /\?token=\[token\]&q=1/);
    });

    it('never puts the token in an error, even when the server echoes it', async () => {
        for (const reply of [
            json({ error: { type: 'invalid-token', message: `Token ${TOKEN} is not valid` } }, 401),
            text(`<pre>Authorization: Bearer ${TOKEN}</pre>`, 500),
            json({ errorMessage: `echo ${TOKEN}` }, 400),
        ]) {
            const { fetch } = fakeFetch(reply);
            const error = await rejection(requestJson(base({ fetch, retries: 0 })));
            assert.ok(error instanceof ApifyHttpError);
            assert.ok(!error.message.includes(TOKEN), error.message);
            assert.ok(!error.bodySnippet.includes(TOKEN), error.bodySnippet);
            assert.ok(!JSON.stringify(error).includes(TOKEN));
            assert.ok(!String(error.stack).includes(TOKEN));
        }
    });

    it('refuses a token that would break the header, without echoing it', async () => {
        const { fetch, calls } = fakeFetch(json([]));
        const bad = `${TOKEN}\nX-Injected: 1`;
        const error = await rejection(requestJson(base({ fetch, token: bad })));
        assert.ok(error instanceof ConfigError);
        assert.ok(!error.message.includes(TOKEN));
        assert.equal(calls.length, 0);
    });

    it('cuts snippets to 300 characters after scrubbing', () => {
        const long = `${'x'.repeat(295)}${TOKEN}`;
        const out = snippetOf(long, TOKEN);
        assert.ok(out.length <= 300);
        assert.ok(!out.includes(TOKEN.slice(0, 12)));
    });
});
