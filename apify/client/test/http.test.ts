import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { ConfigError } from '../src/config.js';
import { ApifyHttpError, requestJson, scrub, snippetOf, type FetchLike, type RequestOptions } from '../src/http.js';
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

    it('scrubs a short configured token too', async () => {
        const short = 'k3y9Zq';
        const { fetch } = fakeFetch(json({ error: { type: 'invalid-token', message: `token ${short} rejected` } }, 401));
        const error = await rejection(requestJson(base({ fetch, token: short })));
        assert.ok(error instanceof ApifyHttpError);
        assert.ok(!error.message.includes(short), error.message);
        assert.ok(!String(error.stack).includes(short));
        assert.equal(scrub(`a ${short} b`, short), 'a [token] b');
    });
});

/** A streamed reply of `chunks` pieces of `size` bytes, counting how many pieces were pulled. */
function streamed(chunks: number, size: number, headers: Record<string, string> = {}): { reply: () => Response; pulled: () => number } {
    let pulled = 0;
    const piece = new TextEncoder().encode('x'.repeat(size));
    const reply = () =>
        new Response(
            new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        if (pulled >= chunks) {
                            controller.close();
                            return;
                        }
                        pulled += 1;
                        controller.enqueue(piece);
                    },
                },
                // Produce a piece only when a read asks for one, so "pulled" counts what the client read.
                { highWaterMark: 0 },
            ),
            { status: 200, headers },
        );
    return { reply, pulled: () => pulled };
}

describe('reply size limit', () => {
    it('stops reading as soon as the reply passes maxBytes, before parsing it', async () => {
        const big = streamed(1_000, 1_024);
        const error = await rejection(requestJson(base({ fetch: fakeFetch(big.reply).fetch, maxBytes: 10 * 1_024 })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'bad_response');
        assert.match(error.bodySnippet, /larger than 10240 bytes/);
        assert.ok(big.pulled() <= 12, `pulled ${big.pulled()} pieces`);
    });

    it('fails before reading when the declared length is over the limit', async () => {
        const declared = streamed(5, 10, { 'content-length': String(64 * 1_024) });
        const error = await rejection(requestJson(base({ fetch: fakeFetch(declared.reply).fetch, maxBytes: 1_024 })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'bad_response');
        assert.equal(declared.pulled(), 0);
    });

    it('reads a reply under the limit and does not retry an oversized one', async () => {
        const { fetch, calls } = fakeFetch(json(['ok']));
        assert.deepEqual((await requestJson(base({ fetch, maxBytes: 1_024 }))).body, ['ok']);
        const big = streamed(100, 1_024);
        const second = fakeFetch(big.reply);
        await rejection(requestJson(base({ fetch: second.fetch, maxBytes: 1_024, retries: 3 })));
        assert.equal(second.calls.length, 1);
        assert.equal(calls.length, 1);
    });
});

/**
 * A JSON string sent one byte per piece, the way a slow or hostile server can trickle a reply. With `stallAfter`,
 * it stops sending after that many bytes without ever closing. It records whether the reader cancelled it.
 */
function trickle(body: string, stallAfter?: number) {
    const bytes = new TextEncoder().encode(body);
    let sent = 0;
    let cancelled = false;
    let response: Response | undefined;
    const reply = (): Response => {
        response = new Response(
            new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        if (stallAfter !== undefined && sent >= stallAfter) return new Promise<void>(() => undefined);
                        if (sent >= bytes.length) {
                            controller.close();
                            return;
                        }
                        controller.enqueue(bytes.slice(sent, sent + 1));
                        sent += 1;
                    },
                    cancel() {
                        cancelled = true;
                    },
                },
                { highWaterMark: 0 },
            ),
            { status: 200 },
        );
        return response;
    };
    return { reply, sent: () => sent, cancelled: () => cancelled, locked: () => response?.body?.locked };
}

// Codex review, round 2: every piece added a reaction to the pending stop promise and kept its own buffer,
// so 100,000 one-byte pieces under a 1 MiB cap grew the heap by tens of MiB.
describe('reply made of many tiny pieces', () => {
    it('reads 100,000 one-byte pieces with one race against the stop, not one per piece', async () => {
        const stream = trickle(`"${'x'.repeat(100_000)}"`);
        const race = mock.method(Promise, 'race');
        let races: number;
        let body: unknown;
        try {
            body = (await requestJson(base({ fetch: fakeFetch(stream.reply).fetch, maxBytes: 1_024 * 1_024, timeoutMs: 60_000 }))).body;
        } finally {
            races = race.mock.callCount();
            race.mock.restore();
        }
        assert.equal(body, 'x'.repeat(100_000));
        // One race for the response headers and one for the whole body.
        assert.ok(races <= 2, `${races} races`);
        assert.equal(stream.locked(), false, 'the reader must be released');
    });

    it('stops at the cap, then cancels and releases the stream', async () => {
        const stream = trickle(`"${'x'.repeat(100_000)}"`);
        const error = await rejection(
            requestJson(base({ fetch: fakeFetch(stream.reply).fetch, maxBytes: 50_000, timeoutMs: 60_000, retries: 3 })),
        );
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'bad_response');
        assert.match(error.bodySnippet, /larger than 50000 bytes/);
        assert.ok(stream.sent() <= 50_001, `sent ${stream.sent()} bytes`);
        assert.equal(stream.cancelled(), true, 'the stream must be cancelled');
        assert.equal(stream.locked(), false, 'the reader must be released');
    });

    it('cancels and releases a body that stalls when the attempt times out', async () => {
        const stream = trickle(`"${'x'.repeat(1_000)}"`, 10);
        const error = await rejection(requestJson(base({ fetch: fakeFetch(stream.reply).fetch, timeoutMs: 100 })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'timeout');
        assert.equal(stream.sent(), 10);
        assert.equal(stream.cancelled(), true, 'the stream must be cancelled');
        assert.equal(stream.locked(), false, 'the reader must be released');
    });

    it('refuses a body whose pieces are not bytes, so its size cannot go uncounted', async () => {
        const notBytes = () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue('"abc"' as unknown as Uint8Array);
                        controller.close();
                    },
                }),
            );
        const error = await rejection(requestJson(base({ fetch: fakeFetch(notBytes).fetch, retries: 0 })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'network');
    });

    it('drops the body of a fetch that ignores its signal and answers after the attempt gave up', async () => {
        const stream = trickle(`"${'x'.repeat(100)}"`);
        const late: FetchLike = () => new Promise((resolve) => setTimeout(() => resolve(stream.reply()), 100));
        const error = await rejection(requestJson(base({ fetch: late, timeoutMs: 20 })));
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'timeout');
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(stream.sent(), 0);
        assert.equal(stream.cancelled(), true, 'the late body must be cancelled');
    });

    it('cancels and releases a body when the caller aborts mid-read', async () => {
        const stream = trickle(`"${'x'.repeat(1_000)}"`, 10);
        const controller = new AbortController();
        const pending = requestJson(base({ fetch: fakeFetch(stream.reply).fetch, timeoutMs: 5_000, signal: controller.signal }));
        setTimeout(() => controller.abort(), 20);
        const error = await rejection(pending);
        assert.ok(error instanceof ApifyHttpError);
        assert.equal(error.kind, 'aborted');
        assert.equal(stream.cancelled(), true, 'the stream must be cancelled');
        assert.equal(stream.locked(), false, 'the reader must be released');
    });
});
