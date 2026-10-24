import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CredentialError, loadTarget, parseConnectionString, redact, safeMessage, TIGER_READ_ONLY_OPTION, type Runner } from '../src/credentials.js';
import { connectTiger, poolConfig } from '../src/db.js';
import { memoryLogger } from '../src/log.js';

const PASSWORD = 'p@ss:w/rd#42-Secret';
const ENCODED = encodeURIComponent(PASSWORD);
const URL_WITH_PASSWORD = `postgresql://tsdbadmin:${ENCODED}@ipx9051gbc.mz92ku10jd.tsdb.cloud.timescale.com:32869/tsdb?sslmode=require`;

describe('redaction', () => {
    test('removes the password, its encoded form and the whole connection string', () => {
        const text = `failed for ${URL_WITH_PASSWORD}; password was ${PASSWORD}; encoded ${ENCODED}`;
        const out = redact(text, [URL_WITH_PASSWORD, PASSWORD]);
        assert.ok(!out.includes(PASSWORD));
        assert.ok(!out.includes(ENCODED));
        assert.ok(!out.includes('ipx9051gbc.mz92ku10jd.tsdb.cloud.timescale.com:32869/tsdb?sslmode'));
        assert.ok(out.includes('[redacted]'));
    });

    test('strips the password from any postgres URL even without knowing it', () => {
        const out = redact('could not connect: postgres://someone:hunter2hunter2@db.example:5432/x');
        assert.equal(out, 'could not connect: postgres://someone:[redacted]@db.example:5432/x');
        assert.equal(safeMessage(new Error('postgresql://u:zzzzzzzz@h/d')), 'Error: postgresql://u:[redacted]@h/d');
    });

    test('a raw @ inside a password leaves no tail behind', () => {
        assert.equal(redact('postgresql://u:pre@post@db/x failed'), 'postgresql://u:[redacted]@db/x failed');
    });

    test('a bare password setting is removed even when the password is not known', () => {
        assert.equal(redact('auth failed, password=ReviewSentinel42 rejected'), 'auth failed, password=[redacted] rejected');
        assert.equal(redact('PASSWORD: ReviewSentinel42'), 'PASSWORD: [redacted]');
    });

    test('a quoted unknown password is removed whole, in both quote styles and through escapes', () => {
        assert.equal(redact("failure password='first second' host=db"), 'failure password=[redacted] host=db');
        assert.equal(redact('failure password="first second" host=db'), 'failure password=[redacted] host=db');
        assert.equal(redact("x password='it\\'s two words' host=db"), 'x password=[redacted] host=db');
        assert.equal(redact('x password="say \\"hi\\" there" host=db'), 'x password=[redacted] host=db');
        assert.equal(redact("x password='a''b c' host=db"), 'x password=[redacted] host=db');
        assert.equal(redact("x password='' host=db"), 'x password=[redacted] host=db');
    });

    test('an unterminated quote is redacted to the end rather than cut short', () => {
        assert.equal(redact("x password='never closed and long"), 'x password=[redacted]');
    });

    test('environment and JSON spellings are covered too', () => {
        assert.equal(redact('PGPASSWORD=ReviewSentinel42 psql'), 'PGPASSWORD=[redacted] psql');
        assert.equal(redact('{"password": "two words", "user": "u"}'), '{"password": [redacted], "user": "u"}');
    });
});

describe('parsing', () => {
    test('splits a Tiger URL into the client fields and ignores sslmode', () => {
        const t = parseConnectionString(URL_WITH_PASSWORD);
        assert.equal(t.host, 'ipx9051gbc.mz92ku10jd.tsdb.cloud.timescale.com');
        assert.equal(t.port, 32869);
        assert.equal(t.user, 'tsdbadmin');
        assert.equal(t.password, PASSWORD);
        assert.equal(t.database, 'tsdb');
    });

    test('errors never echo the string', () => {
        for (const bad of [`nonsense ${PASSWORD}`, `mysql://u:${PASSWORD}@h/d`, 'postgres://u@h/d', `postgres://u:${PASSWORD}@h:99999/d`]) {
            assert.throws(
                () => parseConnectionString(bad),
                (e: unknown) => e instanceof CredentialError && !e.message.includes(PASSWORD) && !e.message.includes(ENCODED),
            );
        }
    });

    test("a read-only string's options are kept, so it stays read-only", () => {
        const t = parseConnectionString(`${URL_WITH_PASSWORD}&options=${encodeURIComponent(TIGER_READ_ONLY_OPTION)}`);
        assert.equal(t.options, TIGER_READ_ONLY_OPTION);
        assert.equal(parseConnectionString(URL_WITH_PASSWORD).options, null);
        assert.equal(poolConfig(t, false, {}).options, TIGER_READ_ONLY_OPTION);
        assert.equal('options' in poolConfig(parseConnectionString(URL_WITH_PASSWORD), false, {}), false);
    });

    test('a parameter this package would not apply is refused, never silently dropped', () => {
        assert.throws(() => parseConnectionString(`${URL_WITH_PASSWORD}&target_session_attrs=read-only`), /does not apply/);
        assert.throws(() => parseConnectionString(`${URL_WITH_PASSWORD}&options=${encodeURIComponent('-c x=1; DROP')}`), /options value/);
    });
});

describe('loading the target', () => {
    test('TIGER_DATABASE_URL wins, and both secrets are registered for redaction', async () => {
        const loaded = await loadTarget({ env: { TIGER_DATABASE_URL: URL_WITH_PASSWORD }, run: () => Promise.reject(new Error('must not run')) });
        assert.equal(loaded.source, 'env');
        assert.ok(loaded.secrets.includes(PASSWORD));
        assert.ok(loaded.secrets.includes(URL_WITH_PASSWORD));
    });

    test('otherwise the Tiger CLI is asked, with the service id and --with-password, and its output stays in memory', async () => {
        const calls: Array<readonly string[]> = [];
        const run: Runner = async (_file, args) => {
            calls.push(args);
            return { stdout: `A new version is available\n${URL_WITH_PASSWORD}\n`, stderr: '' };
        };
        const loaded = await loadTarget({ env: {}, run });
        assert.equal(loaded.source, 'tiger-cli');
        assert.equal(loaded.target.password, PASSWORD);
        assert.deepEqual(calls[0], ['db', 'connection-string', 'ipx9051gbc', '--with-password', '--skip-update-check']);
    });

    test('a failing CLI produces an error with no secret in it: its output is never repeated', async () => {
        for (const stderr of [`error near ${URL_WITH_PASSWORD}`, 'postgresql://u:pre@post@db/x', 'password=ReviewSentinel42']) {
            const run: Runner = () => Promise.reject(Object.assign(new Error(stderr), { exitCode: 1, stderr }));
            await assert.rejects(loadTarget({ env: {}, run }), (e: unknown) => {
                const m = (e as Error).message;
                return e instanceof CredentialError && !m.includes(ENCODED) && !m.includes(PASSWORD) && !m.includes('post@') && !m.includes('ReviewSentinel42') && m.includes('exit 1');
            });
        }
        const odd: Runner = () => Promise.reject(Object.assign(new Error('x'), { exitCode: 'not; a code' }));
        await assert.rejects(loadTarget({ env: {}, run: odd }), (e: unknown) => (e as Error).message.includes('exit unknown'));
    });

    test('CLI output without a URL is refused without echoing it', async () => {
        const run: Runner = async () => ({ stdout: `password: ${PASSWORD}`, stderr: '' });
        await assert.rejects(loadTarget({ env: {}, run }), (e: unknown) => e instanceof CredentialError && !(e as Error).message.includes(PASSWORD));
    });

    test('read-only asks the CLI for a read-only string, and adds the switch to one from the environment', async () => {
        const calls: Array<readonly string[]> = [];
        const run: Runner = async (_file, args) => {
            calls.push(args);
            return { stdout: `${URL_WITH_PASSWORD}&options=${encodeURIComponent(TIGER_READ_ONLY_OPTION)}\n`, stderr: '' };
        };
        const cli = await loadTarget({ env: {}, run, readOnly: true });
        assert.ok(calls[0]?.includes('--read-only'));
        assert.equal(cli.target.options, TIGER_READ_ONLY_OPTION);
        const fromEnv = await loadTarget({ env: { TIGER_DATABASE_URL: URL_WITH_PASSWORD, TIGER_READ_ONLY: '1' } });
        assert.equal(fromEnv.target.options, TIGER_READ_ONLY_OPTION);
    });

    test('a bad service id is refused before anything runs', async () => {
        await assert.rejects(loadTarget({ env: { TIGER_SERVICE_ID: 'x; rm -rf /' }, run: () => Promise.reject(new Error('must not run')) }), CredentialError);
    });
});

describe('connecting', () => {
    test('a connection string for another host is refused before any network, with no secret in the error', async () => {
        const other = `postgres://tsdbadmin:${ENCODED}@other.example.com:32869/tsdb`;
        await assert.rejects(connectTiger({ env: { TIGER_DATABASE_URL: other }, log: memoryLogger() }), (e: unknown) => {
            const m = (e as Error).message;
            return /pinned certificate is for/.test(m) && !m.includes(PASSWORD) && !m.includes(ENCODED);
        });
    });
});
