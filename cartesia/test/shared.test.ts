import './no-network.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emit, redact, redactAll, type PipelineEvent } from '../src/events.js';
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

    it('masks numbers written with Unicode dashes, spaces, dots, invisible marks or words', () => {
        const forms = [
            '415\u{2011}555\u{2011}0188', // non-breaking hyphen
            '415\u{2010}555\u{2010}0188', // hyphen
            '415\u{2012}555\u{2012}0188', // figure dash
            '415\u{2013}555\u{2013}0188', // en dash
            '415\u{2014}555\u{2014}0188', // em dash
            '415\u{2212}555\u{2212}0188', // minus sign
            '415\u{FE63}555\u{FE63}0188', // small hyphen-minus
            '415\u{FF0D}555\u{FF0D}0188', // fullwidth hyphen-minus
            '415\u{00A0}555\u{00A0}0188', // no-break space
            '415\u{2009}555\u{2009}0188', // thin space
            '415\u{202F}555\u{202F}0188', // narrow no-break space
            '415\u{00B7}555\u{00B7}0188', // middle dot
            '415\u{2027}555\u{2027}0188', // hyphenation point
            '415\u{FF0E}555\u{FF0E}0188', // fullwidth full stop
            '415\u{200B}555\u{200B}0188', // zero width space
            '415\u{00AD}555\u{00AD}0188', // soft hyphen
            '415\u{2022}555\u{2022}0188', // bullet
            '415\u{2066}555\u{2069}0188', // directional isolates
            '415\u{202E}555\u{202C}0188', // directional override
            '415\u{034F}555\u{034F}0188', // combining grapheme joiner
            '415\u{FE0F}555\u{FE0F}0188', // variation selector
            '415\u{3164}555\u{3164}0188', // Hangul filler, an invisible letter
            '415 555 zero one eight eight', // digits and words mixed
            'four one five / five five five / zero one eight eight',
            'four\u{034F}one\u{034F}five five five five oh one eight eight',
            '415\u{2044}555\u{2044}0188', // fraction slash
            '415 / 555 / 0188',
            '415  /  555  /  0188',
            '1 / 415\t/\t555 /0188',
            'four one five  /  five five five  /  zero one eight eight',
            '415*555*0188',
            '415_555_0188',
            '(415)\u{3000}555\u{30FB}0188', // ideographic space, katakana middle dot
            '\u{FF0B}1 \u{FF14}\u{FF11}\u{FF15} \u{FF15}\u{FF15}\u{FF15} \u{FF10}\u{FF11}\u{FF18}\u{FF18}', // fullwidth
            '\u{0664}\u{0661}\u{0665}\u{0665}\u{0665}\u{0665}\u{0660}\u{0661}\u{0668}\u{0668}', // Arabic-Indic digits
            '415/555/0188',
            'four one five, five five five, zero one eight eight',
            'Four one five double five five oh one eight eight',
            'four\u{2011}one\u{2011}five five five five zero one eight eight',
            'four fifteen, five fifty five, oh one eighty eight', // grouped the way people say them
            'five fifty-five, twelve thirty-four', // a local number, grouped
            'four one five, five five five, o one eight eight',
            'four fifteen / five fifty five / oh one eighty eight', // grouped and slashed
            '4 1 5/5 5 5/0 1 8 8', // spaced digits: "5/5" inside is not a date
            '4  1  5/5  5  5/0  1  8  8', // the same with wider spacing
            '415/5550188',
            '555/0188', // a local number with a slash
        ];
        for (const form of forms) assert.equal(redact(`Call me at ${form} please`), 'Call me at [number] please', JSON.stringify(form));
    });

    it('treats every ASCII character the way its Unicode class says', () => {
        for (let code = 0; code < 128; code++) {
            const ch = String.fromCharCode(code);
            // A letter or a colon breaks a number, except the letter O, which people say and write for zero.
            const masked = !/[\p{L}\p{M}:+]/u.test(ch) || ch === 'o' || ch === 'O';
            assert.equal(redact(`415${ch}555${ch}0188`) === '[number]', masked, `code ${code}`);
        }
    });

    it('leaves everything that is not a number exactly as written', () => {
        for (const text of [
            'Leon got it at 10:30 AM. One or two of them, said Zo\u{00EB}.',
            'Appointment on 10/24/2026, from 9:00-17:00.',
            'Or 10 / 24 / 2026, or 2026 / 10 / 24.',
            'The room is 12 m\u{00B2}.',
            'Leon \u{2014} he got it \u{2026} thanks\u{00A0}!',
            '\u{2022} First point\n\u{2022} Second point',
        ]) {
            assert.equal(redact(text), text, JSON.stringify(text));
        }
    });

    it('masks a number split across texts read together, and nothing more', () => {
        assert.deepEqual(redactAll(['My number is 415 555', '0188, thanks']), ['My number is [number]', '[number], thanks']);
        assert.deepEqual(redactAll(['Room 12', '34 people', 'sk_car_x1']), ['Room 12', '34 people', '[key]']);
        assert.deepEqual(redactAll([]), []);
        // An empty text inside a number stays empty, and a text of separators alone is left as it was.
        assert.deepEqual(redactAll(['415 555', '', ' - ', '0188']), ['[number]', '', ' - ', '[number]']);
    });

    it('masks shorter runs when asked, for fragments that may be the start of a number', () => {
        assert.deepEqual(redactAll(['My number is 415 555'], 3), ['My number is [number]']);
        assert.deepEqual(redactAll(['Room 12, at five o\u{2019}clock'], 3), ['Room 12, at five o\u{2019}clock']);
        assert.deepEqual(redactAll(['It was 2026, in words twenty twenty six'], 3), ['It was [number], in words [number]']);
        for (const bad of [1, 16, 2.5]) assert.throws(() => redactAll(['x'], bad), RangeError);
        // Dates keep their shape even at the short threshold.
        const dates = 'On 10/24, 10/2026, 10/24/26, 10/24/2026 or 2026/10/24.';
        assert.deepEqual(redactAll([dates], 3), [dates]);
        // Only digits make a date: spoken words never do, and a digit beside a "date" makes it a number, unless that digit
        // belongs to another date or to a short time.
        assert.deepEqual(redactAll(['Twelve/thirty or 12/30'], 3), ['[number] or 12/30']);
        assert.deepEqual(redactAll(['It is 4 1 5/5'], 3), ['It is [number]']);
        assert.deepEqual(redactAll(['Call 4  1  5/5  5  5/0  1  2  3'], 3), ['Call [number]']);
        for (const text of ['Appointment 10/24/2026 9:00 AM', 'On 10/24 10/25', 'At 9 am 10/24/2026', '10/24/2026 9 am', 'Due 9:00 10/24']) {
            assert.deepEqual(redactAll([text], 3), [text], text);
            assert.equal(redact(text), text, text);
        }
        assert.deepEqual(redactAll(['10/24/2026 415 555 0188'], 3), ['[number]']);
        // A date-shaped piece that is part of a number cannot vouch for the next one.
        assert.equal(redact('Call me at 415 5/5 5/01/23 please'), 'Call me at [number] please');
        assert.deepEqual(redactAll(['Call me at 415 5/5 5/01/23 please'], 3), ['Call me at [number] please']);
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

    it('masks a number written with Unicode dashes in an error message and title', () => {
        const error = httpError(400, JSON.stringify({ title: 'Bad 415\u{2011}555\u{2011}0188', message: 'call 415\u{2013}555\u{2013}0188 back', request_id: 'r' }));
        for (const text of [error.message, error.title]) {
            assert.equal(/555|0188/.test(text), false, text);
            assert.match(text, /\[number\]/);
        }
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
