// Tests for scripts/demo-up.sh, run with fakes: a `security` that answers marker values, a private env file and
// consent file in a temp folder, and DEMO_UP_CALL_CHECK in place of `npm run call:check`. Only --dry-run, status and
// stop run here; starting the real sidecar is the rehearsal's job (docs/demo-runbook.md).
// Run: cd scripts && npm test

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo-up.sh');
const SECRET = 'SECRET-KEY-VALUE';
const PHONE = '+14155550123';
const CALLBACK = '+14155550188';

let root;
let bin;

before(() => {
    root = mkdtempSync(join(tmpdir(), 'demo-up-test-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    // A Keychain with every item set, except the one named in EMPTY_SERVICE.
    writeFileSync(
        join(bin, 'security'),
        `#!/bin/sh
service=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-s" ]; then service="$2"; fi
  shift
done
if [ "$service" = "\${EMPTY_SERVICE:-none}" ]; then exit 0; fi
printf '%s' "${SECRET}-$service"
`,
    );
    chmodSync(join(bin, 'security'), 0o755);
});

after(() => {
    // The temp folder holds only fakes; the OS clears tmp.
});

function setup({ token = true, envLines = null, consent = `[{"id":"stephen","phone":"${PHONE}"}]` } = {}) {
    const dir = mkdtempSync(join(root, 'case-'));
    const state = join(dir, 'state');
    const tokens = join(dir, 'tokens');
    mkdirSync(tokens);
    if (token) {
        writeFileSync(join(tokens, 'agent_token_say-when-dev'), 'token\n');
        writeFileSync(join(tokens, 'agent_token_say-when-demo'), 'token\n');
    }
    const consentFile = join(dir, 'consent.json');
    writeFileSync(consentFile, consent);
    const envFile = join(dir, 'env.local');
    const lines = envLines ?? [
        'CARTESIA_AGENT_ID=agent_x',
        'CARTESIA_FROM_NUMBER_ID=num_x',
        `CALL_CONSENT_FILE="${consentFile}"`,
        `CALL_HOLD_FILE=${join(dir, 'holds.jsonl')}`,
        `CALL_CALLBACK_NUMBER=${CALLBACK}`,
        'CALL_PERSON_NAME=Demo',
    ];
    writeFileSync(envFile, `${lines.join('\n')}\n`);
    return { dir, state, tokens, envFile, consentFile };
}

function demoUp(args, c, extraEnv = {}) {
    const result = spawnSync('bash', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: c.dir,
            USER: 'tester',
            DEMO_UP_STATE_DIR: c.state,
            DEMO_UP_TOKEN_DIR: c.tokens,
            DEMO_UP_ENV_FILE: c.envFile,
            DEMO_UP_TEST_HOOKS: '1',
            ...extraEnv,
        },
    });
    return { code: result.status, text: `${result.stdout}${result.stderr}` };
}

/** A live process whose command line reads like `name`, so the script's ps checks see it. Killed by the caller. */
function fakeProcess(name) {
    // cat with an open stdin waits; its whole command line is exactly `name`.
    const child = spawn('bash', ['-c', `exec -a "${name}" cat`], { stdio: ['pipe', 'ignore', 'ignore'] });
    return child;
}

async function settled(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function freePort() {
    return new Promise((resolve) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

const PASSING_CHECK = `printf '%s\\n' 'consent list: 1 people' 'published agent: matches cartesia/agent/ exactly' 'contacts every call would refuse: none'`;

describe('which database', () => {
    for (const db of ['say-when-try', 'say-when-try-dev', 'say-when', 'prod']) {
        it(`refuses ${db}`, () => {
            const r = demoUp(['--db', db, '--dry-run'], setup());
            assert.equal(r.code, 1);
            assert.match(r.text, /runs only say-when-dev, say-when-demo and say-when-direct/);
        });
    }

    it('needs --db', () => {
        assert.equal(demoUp(['--dry-run'], setup()).code, 2);
    });

    it('refuses calls on any database but the two', () => {
        const r = demoUp(['--db', 'say-when-try', '--calls', '--dry-run'], setup());
        assert.equal(r.code, 1);
        assert.doesNotMatch(r.text, /calls on/);
    });
});

describe('Moss memory per database', () => {
    it('defaults the session to the database name', async () => {
        const port = await freePort();
        const dev = demoUp(['--db', 'say-when-dev', '--port', String(port), '--dry-run'], setup());
        assert.equal(dev.code, 0, dev.text);
        assert.match(dev.text, /Moss session say-when-dev/);
        const demo = demoUp(['--db', 'say-when-demo', '--port', String(port), '--dry-run'], setup());
        assert.match(demo.text, /Moss session say-when-demo/);
    });

    it("never lets a dev rehearsal use the demo's memory, or the demo use dev's", () => {
        const a = demoUp(['--db', 'say-when-dev', '--moss-session', 'say-when-demo', '--dry-run'], setup());
        assert.equal(a.code, 1);
        assert.match(a.text, /never writes into the demo's memory/);
        const b = demoUp(['--db', 'say-when-demo', '--moss-session', 'say-when-dev', '--dry-run'], setup());
        assert.equal(b.code, 1);
        assert.equal(demoUp(['--db', 'say-when-dev', '--moss-session', 'Bad_Name', '--dry-run'], setup()).code, 1);
    });
});

describe('keys and pairing', () => {
    it('never prints a key, and says calls are off without --calls', async () => {
        const r = demoUp(['--db', 'say-when-dev', '--port', String(await freePort()), '--dry-run'], setup());
        assert.equal(r.code, 0, r.text);
        assert.match(r.text, /calls off/);
        assert.ok(!r.text.includes(SECRET), 'no key value in the output');
    });

    it('refuses an empty Keychain item and names the variable, not a value', async () => {
        const r = demoUp(['--db', 'say-when-dev', '--port', String(await freePort()), '--dry-run'], setup(), { EMPTY_SERVICE: 'apify-token' });
        assert.equal(r.code, 1);
        assert.match(r.text, /APIFY_TOKEN is missing or empty/);
        assert.ok(!r.text.includes(SECRET));
    });

    it('refuses to start before the sidecar is paired with that database', () => {
        const r = demoUp(['--db', 'say-when-demo', '--dry-run'], setup({ token: false }));
        assert.equal(r.code, 1);
        assert.match(r.text, /not paired with say-when-demo yet/);
    });

    it('refuses a port that already answers', async () => {
        const server = createServer().listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        try {
            const r = demoUp(['--db', 'say-when-dev', '--port', String(server.address().port), '--dry-run'], setup());
            assert.equal(r.code, 1);
            assert.match(r.text, /already answers/);
        } finally {
            server.close();
        }
        assert.equal(demoUp(['--db', 'say-when-dev', '--port', '80', '--dry-run'], setup()).code, 1);
    });
});

describe('calls', () => {
    it('turns calls on only when the settings, the consent file and call:check all pass', async () => {
        const r = demoUp(['--db', 'say-when-demo', '--calls', '--port', String(await freePort()), '--dry-run'], setup(), { DEMO_UP_CALL_CHECK: PASSING_CHECK });
        assert.equal(r.code, 0, r.text);
        assert.match(r.text, /calls on/);
        for (const secret of [SECRET, PHONE, CALLBACK]) assert.ok(!r.text.includes(secret), `never prints ${secret.slice(0, 6)}...`);
    });

    it('refuses with no private env file', async () => {
        const c = setup();
        const r = demoUp(['--db', 'say-when-demo', '--calls', '--port', String(await freePort()), '--dry-run'], c, { DEMO_UP_ENV_FILE: join(c.dir, 'missing'), DEMO_UP_CALL_CHECK: PASSING_CHECK });
        assert.equal(r.code, 1);
        assert.match(r.text, /does not exist/);
    });

    it('refuses when a call setting is missing, naming it', async () => {
        const c = setup({ envLines: ['CARTESIA_AGENT_ID=a', 'CARTESIA_FROM_NUMBER_ID=b', 'CALL_CONSENT_FILE=/x', 'CALL_HOLD_FILE=/tmp/h', `CALL_CALLBACK_NUMBER=${CALLBACK}`] });
        const r = demoUp(['--db', 'say-when-demo', '--calls', '--port', String(await freePort()), '--dry-run'], c, { DEMO_UP_CALL_CHECK: PASSING_CHECK });
        assert.equal(r.code, 1);
        assert.match(r.text, /needs CALL_PERSON_NAME/);
        assert.ok(!r.text.includes(CALLBACK));
    });

    it('refuses an empty consent file', async () => {
        const r = demoUp(['--db', 'say-when-demo', '--calls', '--port', String(await freePort()), '--dry-run'], setup({ consent: '' }), { DEMO_UP_CALL_CHECK: PASSING_CHECK });
        assert.equal(r.code, 1);
        assert.match(r.text, /consent file/);
    });

    it('refuses when call:check fails', async () => {
        const r = demoUp(['--db', 'say-when-demo', '--calls', '--port', String(await freePort()), '--dry-run'], setup(), { DEMO_UP_CALL_CHECK: `${PASSING_CHECK}; exit 1` });
        assert.equal(r.code, 1);
        assert.match(r.text, /call:check failed/);
        assert.doesNotMatch(r.text, /calls on/);
    });

    it('refuses when call:check passes but lists a contact every call would refuse', async () => {
        const check = `printf '%s\\n' 'published agent: matches cartesia/agent/ exactly' 'contacts every call would refuse: stephen (bad_number)'`;
        const r = demoUp(['--db', 'say-when-demo', '--calls', '--port', String(await freePort()), '--dry-run'], setup(), { DEMO_UP_CALL_CHECK: check });
        assert.equal(r.code, 1);
        assert.match(r.text, /lists a contact every call would refuse/);
    });

    it('turns calls on with no calling-hours line or note: calls are not limited to 9 AM to 9 PM (PLAN D20)', async () => {
        const r = demoUp(['--db', 'say-when-demo', '--calls', '--port', String(await freePort()), '--dry-run'], setup(), { DEMO_UP_CALL_CHECK: PASSING_CHECK });
        assert.equal(r.code, 0, r.text);
        assert.match(r.text, /calls on/);
        assert.doesNotMatch(r.text, /calling hours/i);
        assert.doesNotMatch(r.text, /refuses calls until/);
    });
});

describe('the open-file table', () => {
    function sysctlBin(used) {
        const dir = mkdtempSync(join(root, 'sysctl-'));
        writeFileSync(join(dir, 'sysctl'), `#!/bin/sh\ncase "$2" in kern.num_files) echo ${used} ;; kern.maxfiles) echo 30720 ;; esac\n`);
        chmodSync(join(dir, 'sysctl'), 0o755);
        return `${dir}:${bin}:${process.env.PATH}`;
    }

    it('warns when the system is nearly out of open files, and starts nothing differently otherwise', async () => {
        const full = demoUp(['--db', 'say-when-dev', '--port', String(await freePort()), '--dry-run'], setup(), { PATH: sysctlBin(30710) });
        assert.equal(full.code, 0, full.text);
        assert.match(full.text, /30710 of 30720 open files are in use/);
        const fine = demoUp(['--db', 'say-when-dev', '--port', String(await freePort()), '--dry-run'], setup(), { PATH: sysctlBin(1200) });
        assert.match(fine.text, /open files: 1200 of 30720/);
        assert.doesNotMatch(fine.text, /Warning/);
    });
});

describe('status and stop', () => {
    it('stop with nothing running says so', () => {
        const r = demoUp(['--db', 'say-when-dev', 'stop'], setup());
        assert.equal(r.code, 0);
        assert.match(r.text, /not running/);
    });

    it('never signals a pid it did not start: an old state file naming another process is only removed', () => {
        const c = setup();
        mkdirSync(c.state, { recursive: true });
        // This test's own node process: alive, but not the sidecar.
        writeFileSync(join(c.state, 'say-when-dev.state'), `wrapper=${process.pid}\nstarted=x\ncaffeinate=${process.pid}\nport=1\n`);
        const r = demoUp(['--db', 'say-when-dev', 'stop'], c);
        assert.equal(r.code, 0, r.text);
        assert.match(r.text, /removed an old state file/);
        const status = demoUp(['--db', 'say-when-dev', 'status'], c);
        assert.match(status.text, /not running/);
    });

    it('an old state file never gets another caffeinate killed, only the one waiting on its own wrapper', async () => {
        const c = setup();
        mkdirSync(c.state, { recursive: true });
        const dead = 999_999;
        const other = fakeProcess('caffeinate');
        const ours = fakeProcess(`caffeinate -dims -w ${dead}`);
        await settled(300);
        try {
            writeFileSync(join(c.state, 'say-when-dev.state'), `wrapper=${dead}\nstarted=x\ncaffeinate=${other.pid}\n`);
            assert.equal(demoUp(['--db', 'say-when-dev', 'stop'], c).code, 0);
            await settled(200);
            assert.ok(alive(other.pid), 'a caffeinate that waits on another pid is left alone');
            writeFileSync(join(c.state, 'say-when-dev.state'), `wrapper=${dead}\nstarted=x\ncaffeinate=${ours.pid}\n`);
            assert.equal(demoUp(['--db', 'say-when-dev', 'stop'], c).code, 0);
            await settled(300);
            assert.ok(!alive(ours.pid), 'the one waiting on the recorded wrapper is stopped (control)');
        } finally {
            other.kill();
            ours.kill();
        }
    });

    it('a caffeinate waiting on a longer pid that starts with the recorded one is left alone', async () => {
        const c = setup();
        mkdirSync(c.state, { recursive: true });
        const longer = fakeProcess('caffeinate -dims -w 999995');
        await settled(300);
        try {
            writeFileSync(join(c.state, 'say-when-dev.state'), `wrapper=99999\nstarted=x\ncaffeinate=${longer.pid}\n`);
            assert.equal(demoUp(['--db', 'say-when-dev', 'stop'], c).code, 0);
            await settled(200);
            assert.ok(alive(longer.pid));
        } finally {
            longer.kill();
        }
    });

    it('a pid file older than the process it names is a stale file, not a running sidecar', async () => {
        const c = setup();
        mkdirSync(c.state, { recursive: true });
        const pidFile = join(c.tokens, 'agent_token_say-when-dev.pid');
        const later = fakeProcess('node src/main.ts run');
        await settled(300);
        try {
            writeFileSync(pidFile, `${JSON.stringify({ pid: later.pid, nonce: 'n'.repeat(32) })}\n`);
            const past = new Date(Date.now() - 60_000);
            utimesSync(pidFile, past, past);
            writeFileSync(join(c.state, 'say-when-dev.state'), `wrapper=999999\nstarted=x\n`);
            const stop = demoUp(['--db', 'say-when-dev', 'stop'], c);
            assert.equal(stop.code, 0, stop.text);
            assert.match(stop.text, /removed an old state file/);
            assert.ok(alive(later.pid), 'never signalled');
            const up = demoUp(['--db', 'say-when-dev', '--port', String(await freePort()), '--dry-run'], c);
            assert.equal(up.code, 0, up.text);
        } finally {
            later.kill();
        }
    });

    it('a sidecar still running without its wrapper is reported, never signalled, and blocks a second start', async () => {
        const c = setup();
        mkdirSync(c.state, { recursive: true });
        const stray = fakeProcess('node src/main.ts run');
        await settled(300);
        try {
            writeFileSync(join(c.tokens, 'agent_token_say-when-dev.pid'), `${JSON.stringify({ pid: stray.pid, nonce: 'n'.repeat(32) })}\n`);
            writeFileSync(join(c.state, 'say-when-dev.state'), `wrapper=999999\nstarted=x\ncaffeinate=999998\n`);
            const stop = demoUp(['--db', 'say-when-dev', 'stop'], c);
            assert.equal(stop.code, 1);
            assert.match(stop.text, new RegExp(`names a running sidecar \\(pid ${stray.pid}\\)`));
            assert.ok(existsSync(join(c.state, 'say-when-dev.state')), 'the state file stays');
            await settled(200);
            assert.ok(alive(stray.pid), 'not signalled');
            const up = demoUp(['--db', 'say-when-dev', '--port', String(await freePort()), '--dry-run'], c);
            assert.equal(up.code, 1);
            assert.match(up.text, /already running as pid/);
            const status = demoUp(['--db', 'say-when-dev', 'status'], c);
            assert.match(status.text, new RegExp(`a sidecar for say-when-dev is running as pid ${stray.pid}`));
        } finally {
            stray.kill();
        }
    });
});

describe('the call check hook', () => {
    it('is ignored without DEMO_UP_TEST_HOOKS=1: the real call:check runs', async () => {
        const dir = mkdtempSync(join(root, 'npm-'));
        writeFileSync(join(dir, 'npm'), '#!/bin/sh\necho "fake npm $*"\nexit 3\n');
        chmodSync(join(dir, 'npm'), 0o755);
        const r = demoUp(['--db', 'say-when-demo', '--calls', '--port', String(await freePort()), '--dry-run'], setup(), {
            PATH: `${dir}:${bin}:${process.env.PATH}`,
            DEMO_UP_TEST_HOOKS: '',
            DEMO_UP_CALL_CHECK: PASSING_CHECK,
        });
        assert.equal(r.code, 1);
        assert.match(r.text, /fake npm run --silent call:check/);
        assert.match(r.text, /call:check failed \(exit 3\)/);
        assert.doesNotMatch(r.text, /calls on/);
    });
});
