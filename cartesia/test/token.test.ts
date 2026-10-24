import './no-network.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CartesiaHttpError } from '../src/http.js';
import { buildMintRequest, mintAccessToken, parseMintResponse, TokenError } from '../src/token.js';
import { fakeFetch } from './fakes.js';

// A plainly fake key. A random-looking one trips gitleaks' generic-api-key rule in CI.
const KEY = 'sk_car_fake_key';

describe('access tokens', () => {
    it('builds POST /access-token with the version header and only the TTS grant', () => {
        const request = buildMintRequest(KEY, 'tts');
        assert.equal(request.url, 'https://api.cartesia.ai/access-token');
        assert.equal(request.method, 'POST');
        assert.deepEqual(request.headers, {
            Authorization: `Bearer ${KEY}`,
            'Cartesia-Version': '2026-08-14',
            'Content-Type': 'application/json',
        });
        assert.deepEqual(JSON.parse(request.body), { grants: { tts: true, stt: false, agent: false }, expires_in: 60 });
    });

    it('gives the partner phone only the STT grant', () => {
        const body = JSON.parse(buildMintRequest(KEY, 'stt', 120).body) as unknown;
        assert.deepEqual(body, { grants: { tts: false, stt: true, agent: false }, expires_in: 120 });
    });

    it('keeps the expiry between 1 second and 1 hour', () => {
        assert.doesNotThrow(() => buildMintRequest(KEY, 'tts', 3600));
        for (const bad of [0, 3601, 1.5, -5]) assert.throws(() => buildMintRequest(KEY, 'tts', bad), TokenError);
        assert.throws(() => buildMintRequest('  ', 'tts'), /CARTESIA_API_KEY/);
        assert.throws(() => buildMintRequest(KEY, 'agent' as never), TokenError);
    });

    it('reads the token and counts the expiry from before the request', () => {
        const request = buildMintRequest(KEY, 'tts');
        assert.deepEqual(parseMintResponse(request, 200, '{"token":"tok_abc"}', 1000), { token: 'tok_abc', purpose: 'tts', expiresAt: 61_000 });
        assert.throws(() => parseMintResponse(request, 200, '{}', 0), /no token/);
        assert.throws(() => parseMintResponse(request, 200, 'not json', 0), /not JSON/);
    });

    it('turns a Cartesia error into one that never shows the key', () => {
        const request = buildMintRequest(KEY, 'tts');
        const body = JSON.stringify({ error_code: 'quota_exceeded', title: 'Quota exceeded', message: `key ${KEY} is out of credits`, request_id: 'r1' });
        assert.throws(
            () => parseMintResponse(request, 402, body, 0),
            (error: unknown) => error instanceof CartesiaHttpError && error.errorCode === 'quota_exceeded' && !error.message.includes(KEY),
        );
    });

    it('sends one request through the given fetch', async () => {
        const fetch = fakeFetch(() => ({ status: 200, body: { token: 'tok_1' } }));
        const minted = await mintAccessToken(KEY, 'stt', { fetch, now: () => 5000, expiresInSeconds: 120 });
        assert.deepEqual(minted, { token: 'tok_1', purpose: 'stt', expiresAt: 125_000 });
        assert.equal(fetch.calls.length, 1);
        assert.equal(fetch.calls[0]?.url, 'https://api.cartesia.ai/access-token');
        assert.equal(fetch.calls[0]?.headers['Cartesia-Version'], '2026-08-14');
    });
});
