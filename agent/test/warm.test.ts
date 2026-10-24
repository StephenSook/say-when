// `npm run warm` (src/warm.ts): each step on fakes, and the hand-off to the running sidecar.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { askSidecar, checkVoiceToken, formatWarm, runningSidecar, wakeStandby, warmFiles, warmMoss, writePrivate, type WarmLine } from '../src/warm.js';
import { FakeMemory } from './helpers.js';

const TOKEN = 'apify_api_SECRETVALUE123';
const URL_ = 'https://secret-standby.apify.actor';
const KEY = 'sk_car_SECRETVALUE456';

function tempFiles() {
    const dir = mkdtempSync(join(tmpdir(), 'eleven-warm-'));
    return warmFiles(join(dir, 'agent_token_test'));
}

describe('warm: the Apify step', () => {
    it('sends one GET to the Standby root with the token in the header only, and no body', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const line = await wakeStandby(`${URL_}/`, TOKEN, {
            fetch: async (url, init) => {
                calls.push({ url, init });
                return { status: 200, body: null };
            },
        });
        assert.equal(calls.length, 1, 'one request');
        assert.equal(calls[0]?.url, `${URL_}/`);
        assert.equal(calls[0]?.init.method, 'GET');
        assert.equal(calls[0]?.init.body, undefined, 'nothing is sent: no preview, no submit');
        assert.equal(calls[0]?.init.redirect, 'error');
        assert.deepEqual(calls[0]?.init.headers, { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' });
        assert.equal(line.ok, true);
        assert.equal(line.step, 'apify');
    });

    it('reports an HTTP refusal or no answer by status or error name, never the URL or the token', async () => {
        const refused = await wakeStandby(URL_, TOKEN, { fetch: async () => ({ status: 503, body: null }) });
        assert.deepEqual([refused.ok, refused.note], [false, 'the form-errand Actor answered http 503']);
        const failed = await wakeStandby(URL_, TOKEN, {
            fetch: async () => {
                throw new TypeError(`fetch failed for ${URL_} with ${TOKEN}`);
            },
        });
        assert.deepEqual([failed.ok, failed.note], [false, 'no answer (TypeError)']);
        for (const line of [refused, failed]) {
            const text = formatWarm(line);
            assert.ok(!text.includes(TOKEN) && !text.includes('secret-standby'), text);
        }
    });

    it('names a missing setting and sends nothing', async () => {
        let sent = 0;
        const fetch = async () => {
            sent += 1;
            return { status: 200, body: null };
        };
        assert.equal((await wakeStandby(undefined, TOKEN, { fetch })).note, 'FORM_ERRAND_URL is not set');
        assert.equal((await wakeStandby(URL_, undefined, { fetch })).note, 'APIFY_TOKEN is not set');
        assert.equal(sent, 0);
    });
});

describe('warm: the Cartesia step', () => {
    it('mints one token and never prints it or the key', async () => {
        const minted: string[] = [];
        const line = await checkVoiceToken(KEY, async (key) => {
            minted.push(key);
            return { token: 'tok_SECRETTOKEN', purpose: 'tts', expiresAt: 0 };
        });
        assert.deepEqual(minted, [KEY]);
        assert.equal(line.ok, true);
        const text = formatWarm(line);
        assert.ok(!text.includes('SECRET'), text);
    });

    it('reports a failed mint by error name only, and a missing key without a request', async () => {
        const failed = await checkVoiceToken(KEY, async () => {
            throw new Error(`401 for key ${KEY}`);
        });
        assert.deepEqual([failed.ok, failed.note], [false, 'no token (Error)']);
        let asked = 0;
        const missing = await checkVoiceToken('  ', async () => {
            asked += 1;
        });
        assert.deepEqual([missing.ok, missing.note, asked], [false, 'CARTESIA_API_KEY is not set', 0]);
    });
});

describe('warm: Moss in the sidecar', () => {
    it('opens a closed Moss', async () => {
        let starts = 0;
        const memory = new FakeMemory();
        const line = await warmMoss({ isOpen: false, start: async () => void (starts += 1) }, memory);
        assert.deepEqual([line.ok, starts, memory.recalls.length], [true, 1, 0]);
        assert.match(line.note, /^opened in the sidecar/);
    });

    it('makes one read on an open Moss, so its idle clock starts again, and never opens a second session', async () => {
        let starts = 0;
        const memory = new FakeMemory();
        const line = await warmMoss({ isOpen: true, start: async () => void (starts += 1) }, memory);
        assert.deepEqual([line.ok, starts, memory.recalls.length], [true, 0, 1]);
        assert.equal(memory.written.length, 0, 'nothing is written into memory');
    });

    it('is bounded: a Moss start that never answers does not hold the sidecar', { timeout: 5_000 }, async () => {
        const line = await warmMoss({ isOpen: false, start: () => new Promise(() => undefined) }, new FakeMemory(), undefined, 50);
        assert.deepEqual([line.ok, line.note], [false, 'not warmed (DeadlineError)']);
    });

    it('reports memory off when this sidecar has no Moss', async () => {
        assert.deepEqual((await warmMoss(null, null)).note, 'memory is off in this sidecar');
    });
});

describe('warm: finding the running sidecar', () => {
    it('signals only a live process whose command is the sidecar\'s run', () => {
        const files = tempFiles();
        assert.equal(runningSidecar(files.pid), null, 'no pid file');
        writePrivate(files.pid, `${process.pid}\n`);
        assert.equal((statSync(files.pid).mode & 0o777).toString(8), '600');
        assert.equal(runningSidecar(files.pid, () => 'node --import tsx src/main.ts run\n'), process.pid);
        assert.equal(runningSidecar(files.pid, () => '/usr/bin/some-other-program\n'), null, 'a reused pid is not signalled');
        writeFileSync(files.pid, '999999999\n');
        assert.equal(runningSidecar(files.pid, () => 'src/main.ts run'), null, 'a dead pid is not signalled');
        writeFileSync(files.pid, 'not a pid\n');
        assert.equal(runningSidecar(files.pid, () => 'src/main.ts run'), null);
    });

    it('asks the sidecar and prints what it wrote back', async () => {
        const files = tempFiles();
        writePrivate(files.pid, `${process.pid}\n`);
        const signalled: number[] = [];
        const answer: WarmLine = { step: 'moss', ok: true, ms: 812, note: 'opened in the sidecar; it closes after 3 idle minutes' };
        const line = await askSidecar(files, {
            commandOf: () => 'src/main.ts run',
            pollMs: 5,
            signal: (pid) => {
                signalled.push(pid);
                setTimeout(() => writePrivate(files.status, JSON.stringify(answer)), 20);
            },
        });
        assert.deepEqual(signalled, [process.pid]);
        assert.deepEqual(line, answer);
        assert.equal(JSON.parse(readFileSync(files.status, 'utf8')).ms, 812);
    });

    it('ignores an old status file and gives up after its time when the sidecar does not answer', async () => {
        const files = tempFiles();
        writePrivate(files.pid, `${process.pid}\n`);
        writePrivate(files.status, JSON.stringify({ step: 'moss', ok: true, ms: 1, note: 'an old answer' }));
        const line = await askSidecar(files, { commandOf: () => 'src/main.ts run', pollMs: 5, timeoutMs: 100, signal: () => undefined });
        assert.deepEqual([line.ok, line.note], [false, 'the sidecar did not answer in time']);
    });

    it('signals nothing when no sidecar runs', async () => {
        const files = tempFiles();
        let signalled = 0;
        const line = await askSidecar(files, { signal: () => void (signalled += 1) });
        assert.deepEqual([line.ok, signalled, existsSync(files.status)], [false, 0, false]);
        assert.match(line.note, /no running sidecar found/);
    });
});
