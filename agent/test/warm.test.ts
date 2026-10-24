// `npm run warm` (src/warm.ts): each step on fakes, and the hand-off to the running sidecar.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
    askSidecar,
    checkVoiceToken,
    formatWarm,
    probeProcess,
    readPidFile,
    runningSidecar,
    wakeStandby,
    warmFiles,
    WarmFileError,
    warmMoss,
    writePidFile,
    writePrivate,
    writeWarmStatus,
    type ProcessInfo,
    type WarmLine,
} from '../src/warm.js';
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

describe('warm: the pid and status files', () => {
    it('writes through a temp file and a rename, at mode 600, and leaves no temp file', () => {
        const files = tempFiles();
        writePrivate(files.pid, 'one');
        writePrivate(files.pid, 'two');
        assert.equal(readFileSync(files.pid, 'utf8'), 'two');
        assert.equal((statSync(files.pid).mode & 0o777).toString(8), '600');
        assert.deepEqual(readdirSync(dirname(files.pid)).sort(), ['agent_token_test.pid']);
    });

    it('refuses a symlink in place of the file, and leaves its target alone (review round 1)', () => {
        const files = tempFiles();
        const token = join(dirname(files.pid), 'agent_token_test');
        writeFileSync(token, 'the identity token\n', { mode: 0o600 });
        symlinkSync(token, files.pid);
        assert.throws(() => writePrivate(files.pid, '{"pid":1}'), WarmFileError);
        assert.equal(readFileSync(token, 'utf8'), 'the identity token\n', 'the token is untouched');
    });

    it('never reads through a symlink, even to a well formed pid file', () => {
        const files = tempFiles();
        const elsewhere = join(dirname(files.pid), 'elsewhere.pid');
        writePidFile(elsewhere, 4321, NONCE);
        assert.deepEqual(readPidFile(elsewhere), { pid: 4321, nonce: NONCE }, 'the target itself reads fine');
        symlinkSync(elsewhere, files.pid);
        assert.equal(readPidFile(files.pid), null);
    });

    it('refuses a folder that others can write to (review round 1)', () => {
        const files = tempFiles();
        chmodSync(dirname(files.pid), 0o777);
        assert.throws(() => writePrivate(files.pid, '{"pid":1}'), WarmFileError);
        assert.equal(existsSync(files.pid), false);
    });

    it('reads back a pid and a nonce, and nothing else', () => {
        const files = tempFiles();
        writePidFile(files.pid, 4321, NONCE);
        assert.deepEqual(readPidFile(files.pid), { pid: 4321, nonce: NONCE });
        writePrivate(files.pid, `${process.pid}\n`);
        assert.equal(readPidFile(files.pid), null, 'the old bare-pid format is not trusted');
        writePrivate(files.pid, JSON.stringify({ pid: 1, nonce: NONCE }));
        assert.equal(readPidFile(files.pid), null, 'pid 1 is never a sidecar');
    });
});

const NONCE = '0123456789abcdef0123456789abcdef';
const AGENT_DIR = '/repo/agent';

/** The process this test runs in, presented as the sidecar: its command, its cwd and a start before the pid file. */
function sidecarInfo(overrides: Partial<ProcessInfo> = {}): (pid: number) => ProcessInfo | null {
    return () => ({ command: 'node --import tsx src/main.ts run', cwd: AGENT_DIR, startedAtMs: Date.now() - 60_000, ...overrides });
}

describe('warm: finding the running sidecar', () => {
    it('confirms a live process by its command, its working folder and a start before the pid file', () => {
        const files = tempFiles();
        assert.deepEqual(runningSidecar(files.pid, AGENT_DIR, sidecarInfo()), { skip: 'none' }, 'no pid file');
        writePidFile(files.pid, process.pid, NONCE);
        assert.deepEqual(runningSidecar(files.pid, AGENT_DIR, sidecarInfo()), { pid: process.pid, nonce: NONCE });
        assert.deepEqual(runningSidecar(files.pid, `${AGENT_DIR}/`, sidecarInfo()), { pid: process.pid, nonce: NONCE }, 'a trailing slash is the same folder');
    });

    it('does not signal another program that reused the pid, even one named src/main.ts run (review round 1)', () => {
        const files = tempFiles();
        writePidFile(files.pid, process.pid, NONCE);
        assert.deepEqual(runningSidecar(files.pid, AGENT_DIR, sidecarInfo({ cwd: '/unrelated-service' })), { skip: 'unconfirmed' });
        assert.deepEqual(runningSidecar(files.pid, AGENT_DIR, sidecarInfo({ command: '/usr/bin/some-other-program' })), { skip: 'unconfirmed' });
        assert.deepEqual(
            runningSidecar(files.pid, AGENT_DIR, sidecarInfo({ startedAtMs: Date.now() + 5_000 })),
            { skip: 'unconfirmed' },
            'a process that started after the pid file was written is not the one that wrote it',
        );
        assert.deepEqual(runningSidecar(files.pid, AGENT_DIR, () => null), { skip: 'unconfirmed' }, 'when it cannot be checked, it is not signalled');
        writePidFile(files.pid, 999_999_999, NONCE);
        assert.deepEqual(runningSidecar(files.pid, AGENT_DIR, sidecarInfo()), { skip: 'none' }, 'a dead pid');
    });

    it('asks the confirmed sidecar and prints the answer that carries its nonce', async () => {
        const files = tempFiles();
        writePidFile(files.pid, process.pid, NONCE);
        const signalled: number[] = [];
        const answer: WarmLine = { step: 'moss', ok: true, ms: 812, note: 'opened in the sidecar; it closes after 3 idle minutes' };
        const line = await askSidecar(files, {
            expectedCwd: AGENT_DIR,
            probe: sidecarInfo(),
            pollMs: 5,
            signal: (pid) => {
                signalled.push(pid);
                setTimeout(() => writeWarmStatus(files.status, answer, NONCE), 20);
            },
        });
        assert.deepEqual(signalled, [process.pid]);
        assert.deepEqual(line, answer);
    });

    it('ignores an answer with another nonce, and an old one, then gives up after its time', async () => {
        const files = tempFiles();
        writePidFile(files.pid, process.pid, NONCE);
        writeWarmStatus(files.status, { step: 'moss', ok: true, ms: 1, note: 'an old answer' }, NONCE);
        const line = await askSidecar(files, {
            expectedCwd: AGENT_DIR,
            probe: sidecarInfo(),
            pollMs: 5,
            timeoutMs: 150,
            signal: () => setTimeout(() => writeWarmStatus(files.status, { step: 'moss', ok: true, ms: 2, note: 'another sidecar' }, 'f'.repeat(32)), 20),
        });
        assert.deepEqual([line.ok, line.note], [false, 'the sidecar did not answer in time']);
    });

    it('skips Moss and signals nothing when the pid file names a process it cannot confirm', async () => {
        const files = tempFiles();
        writePidFile(files.pid, process.pid, NONCE);
        let signalled = 0;
        const line = await askSidecar(files, { expectedCwd: AGENT_DIR, probe: sidecarInfo({ cwd: '/unrelated-service' }), signal: () => void (signalled += 1) });
        assert.deepEqual([line.ok, signalled], [false, 0]);
        assert.match(line.note, /^skipped: /);
    });

    it('signals nothing when no sidecar runs', async () => {
        const files = tempFiles();
        let signalled = 0;
        const line = await askSidecar(files, { expectedCwd: AGENT_DIR, probe: sidecarInfo(), signal: () => void (signalled += 1) });
        assert.deepEqual([line.ok, signalled, existsSync(files.status)], [false, 0, false]);
        assert.match(line.note, /no running sidecar found/);
    });

    it('reads this very process with the real probe: its command and its working folder', () => {
        const info = probeProcess(process.pid);
        assert.ok(info, 'ps and lsof answered');
        assert.equal(realpathSync(info.cwd), realpathSync(process.cwd()));
        assert.ok(info.startedAtMs <= Date.now() && info.startedAtMs > Date.now() - 3_600_000);
    });
});
