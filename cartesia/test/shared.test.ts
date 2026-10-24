import './no-network.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emit, redact, type PipelineEvent } from '../src/events.js';
import { buildRequest, CartesiaNetworkError, encodeQuery, httpError, safeErrorCode, safeRequestId, send } from '../src/http.js';
import { buildKeyterms, MAX_KEYTERM_CHARS, MAX_KEYTERMS } from '../src/keyterms.js';
import { base64ToBytes, Downsampler, floatToPcm16, PcmChunker, pcmDurationMs, pcmToFloat32 } from '../src/pcm.js';
import { checkAccessToken, socketUrl } from '../src/ws.js';

describe('events', () => {
    it('masks keys, tokens and phone numbers', () => {
        assert.equal(
            redact('key sk_car_abc123 and access_token=tok_1&x=2 call +1 (415) 555-0123'),
            'key [key] and access_token=[token]&x=2 call [number]',
        );
    });

    it('cleans every event and survives a sink that throws', () => {
        const seen: PipelineEvent[] = [];
        emit((event) => seen.push(event), {
            stage: 'call',
            status: 'ok',
            detail: `dialed +14155550123 ${'x'.repeat(200)}`,
            ms: 12.6,
            counts: { polls: 3, bad: Number.NaN, 'no spaces': 1 },
        });
        assert.equal(seen.length, 1);
        assert.equal(seen[0]?.detail.includes('4155550123'), false);
        assert.equal(seen[0]?.detail.length, 120);
        assert.equal(seen[0]?.ms, 13);
        assert.deepEqual(seen[0]?.counts, { polls: 3 });
        assert.doesNotThrow(() =>
            emit(() => {
                throw new Error('sink broke');
            }, { stage: 'speak', status: 'ok', detail: 'clip ready', ms: 0 }),
        );
    });
});

describe('http', () => {
    it('builds REST requests with the bearer key and the version header', () => {
        const request = buildRequest('sk_car_k', 'PATCH', '/pronunciation-dicts/pdict_1', { body: { items: [] } });
        assert.equal(request.url, 'https://api.cartesia.ai/pronunciation-dicts/pdict_1');
        assert.deepEqual(request.headers, {
            Authorization: 'Bearer sk_car_k',
            'Cartesia-Version': '2026-08-14',
            'Content-Type': 'application/json',
        });
        assert.equal(request.body, '{"items":[]}');
        assert.throws(() => buildRequest('', 'GET', '/voices'), /CARTESIA_API_KEY/);
    });

    it('encodes spaces as %20, which the keyterm docs ask for', () => {
        assert.equal(encodeQuery([['keyterm', 'Ink 2'], ['q', 'a&b']]), 'keyterm=Ink%202&q=a%26b');
    });

    it('reads structured errors and redacts them', () => {
        const error = httpError(
            429,
            JSON.stringify({ error_code: 'concurrency_limited', title: 'Too many', message: 'sk_car_x hit it', request_id: '550e8400-e29b-41d4-a716-446655440000' }),
        );
        assert.equal(error.status, 429);
        assert.equal(error.errorCode, 'concurrency_limited');
        assert.equal(error.requestId, '550e8400-e29b-41d4-a716-446655440000');
        assert.equal(error.message.includes('sk_car_x'), false);
        assert.equal(httpError(500, 'plain text').message, 'HTTP 500: plain text');
    });

    it('drops an error code or request id that could carry a key or a number', () => {
        const error = httpError(400, JSON.stringify({ error_code: 'sk_car_leak', title: 'Bad +14155550123', message: 'm', request_id: '+14155550123' }));
        assert.equal(error.errorCode, null);
        assert.equal(error.requestId, null);
        const serialized = JSON.stringify(error);
        for (const secret of ['sk_car_leak', '4155550123']) assert.equal(serialized.includes(secret), false, secret);
        assert.equal(safeErrorCode('quota_exceeded'), 'quota_exceeded');
        for (const bad of ['voice_404', 'Quota', 'a'.repeat(65), 42, null]) assert.equal(safeErrorCode(bad), null, String(bad));
        assert.equal(safeRequestId('550e8400-e29b-41d4-a716-446655440000:ctx-1:x'), '550e8400-e29b-41d4-a716-446655440000');
    });

    it('cannot reach the real network from tests', async () => {
        await assert.rejects(send(buildRequest('sk_car_k', 'GET', '/voices')), CartesiaNetworkError);
    });
});

describe('sockets', () => {
    it('puts the version and the access token in the query', () => {
        const url = new URL(socketUrl('/tts/websocket', 'tok_1'));
        assert.equal(`${url.protocol}//${url.host}${url.pathname}`, 'wss://api.cartesia.ai/tts/websocket');
        assert.equal(url.searchParams.get('cartesia_version'), '2026-08-14');
        assert.equal(url.searchParams.get('access_token'), 'tok_1');
    });

    it('refuses an API key where a browser expects an access token', () => {
        assert.throws(() => checkAccessToken('sk_car_live'), /API key/);
        assert.throws(() => checkAccessToken(''), /access token/);
        assert.equal(checkAccessToken('tok_ok'), 'tok_ok');
    });
});

describe('pcm', () => {
    it('measures clip length from bytes and sample rate', () => {
        assert.equal(pcmDurationMs(48_000, 'pcm_s16le', 24_000), 1000);
        assert.equal(pcmDurationMs(48_001, 'pcm_s16le', 24_000), 1000);
        assert.equal(pcmDurationMs(96_000, 'pcm_f32le', 24_000), 1000);
        assert.equal(pcmDurationMs(4_800, 'pcm_s16le', 24_000), 100);
        assert.equal(pcmDurationMs(0, 'pcm_s16le', 24_000), 0);
    });

    it('downsamples 48 kHz worklet blocks to 16 kHz without drift', () => {
        const downsampler = new Downsampler(48_000, 16_000);
        const block = new Float32Array(128).fill(0.5);
        let total = 0;
        for (let i = 0; i < 375; i++) {
            const out = downsampler.push(block);
            total += out.length;
            for (const value of out) assert.equal(value, 0.5);
        }
        assert.equal(total, 16_000);
    });

    it('downsamples 44.1 kHz too', () => {
        const downsampler = new Downsampler(44_100, 16_000);
        let total = 0;
        for (let sent = 0; sent < 44_100; sent += 128) total += downsampler.push(new Float32Array(Math.min(128, 44_100 - sent))).length;
        assert.ok(Math.abs(total - 16_000) <= 1, `got ${total}`);
        assert.throws(() => new Downsampler(16_000, 48_000), RangeError);
    });

    it('converts floats to clamped little-endian 16-bit and back', () => {
        const bytes = floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
        const view = new DataView(bytes.buffer);
        assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => view.getInt16(i * 2, true)), [0, 32767, -32768, 32767, -32768, 16384]);
        const floats = pcmToFloat32(bytes, 'pcm_s16le');
        assert.equal(floats.length, 6);
        assert.equal(floats[2], -1);
    });

    it('cuts 100 ms chunks and keeps the rest for flush', () => {
        const chunker = new PcmChunker(3200);
        assert.equal(chunker.push(new Uint8Array(3000)).length, 0);
        const out = chunker.push(new Uint8Array(3500));
        assert.deepEqual(out.map((chunk) => chunk.byteLength), [3200, 3200]);
        assert.equal(chunker.flush().byteLength, 100);
        assert.equal(chunker.flush().byteLength, 0);
    });

    it('decodes base64 audio', () => {
        assert.deepEqual([...base64ToBytes(Buffer.from([1, 2, 3]).toString('base64'))], [1, 2, 3]);
    });
});

describe('keyterms', () => {
    it('puts household names first, keeps the first spelling and drops common words', () => {
        const { keyterms, dropped } = buildKeyterms(['Siobhan', 'Khadim', 'the'], ['siobhan', 'Tartine  Manufactory', '', 'Gough Street']);
        assert.deepEqual(keyterms, ['Siobhan', 'Khadim', 'Tartine Manufactory', 'Gough Street']);
        assert.equal(dropped, 1);
    });

    it('stops at 100 terms and 1,200 characters', () => {
        const many = Array.from({ length: 150 }, (_, i) => `Name${i}`);
        const first = buildKeyterms(many);
        assert.equal(first.keyterms.length, MAX_KEYTERMS);
        assert.equal(first.dropped, 50);
        const long = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(98)}`);
        const second = buildKeyterms(long);
        assert.equal(second.keyterms.length, 12);
        assert.ok(second.keyterms.join('').length <= MAX_KEYTERM_CHARS);
    });
});
