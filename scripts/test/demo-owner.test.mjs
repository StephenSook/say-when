// Tests for scripts/demo-owner.mjs: the spacetime CLI is a fake that records each call and answers SQL from fixtures.
// Run: cd scripts && npm test

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { consentContactIds, decodeCell, devicesToRevoke, missingConsents, parseSqlTable, run } from '../demo-owner.mjs';

// The exact shape `spacetime sql` printed for say-when-dev on Oct 24 (identities shortened in the fixtures below).
const CONSENT_SQL = ` id | scope            | subject             | revoked_at
----+------------------+---------------------+-------------------------------------------------------------------------------------
 24 | (errand = ())    | "care_team_request" | (some = (__timestamp_micros_since_unix_epoch__ = 2026-10-24T16:53:53.627787+00:00))
 25 | (memory = ())    | ""                  | (some = (__timestamp_micros_since_unix_epoch__ = 2026-10-24T16:53:54.720387+00:00))
 33 | (errand = ())    | "care_team_request" | (none = ())
 34 | (call = ())      | "stephen"           | (none = ())
`;

const ID_A = `0x${'a'.repeat(64)}`;
const ID_B = `0x${'b'.repeat(64)}`;
const ID_C = `0x${'c'.repeat(64)}`;

const DEVICE_SQL = ` identity | role | revoked
----------+------+---------
 ${ID_A} | (agent = ())   | false
 ${ID_B} | (station = ()) | false
 ${ID_C} | (partner = ()) | true
`;

const STATUS_SQL = ` identity | role | label | online
----------+------+-------+--------
 ${ID_A} | (agent = ())   | "agent sidecar" | true
 ${ID_B} | (station = ()) | "station"       | false
 ${ID_C} | (partner = ()) | "partner phone 1" | false
`;

function fakeCli(answers = {}) {
    const calls = [];
    const spacetime = (args) => {
        calls.push(args);
        if (args[0] === 'sql') {
            const query = args[args.length - 1];
            for (const [prefix, text] of Object.entries(answers)) if (query.startsWith(prefix)) return text;
            return ' x\n---\n';
        }
        return '';
    };
    return { calls, spacetime };
}

function capture() {
    const lines = [];
    return { lines, out: (line) => lines.push(line) };
}

describe('reading spacetime sql output', () => {
    it('decodes variants, quoted strings and plain cells', () => {
        assert.equal(decodeCell(' (station = ()) '), 'station');
        assert.equal(decodeCell('(none = ())'), 'none');
        assert.equal(decodeCell('(some = (__timestamp_micros_since_unix_epoch__ = 2026-10-24T16:53:53+00:00))'), 'some');
        assert.equal(decodeCell(' "smoke station" '), 'smoke station');
        assert.equal(decodeCell('""'), '');
        assert.equal(decodeCell(' true '), 'true');
    });

    it('reads every row by column name and skips the warning line', () => {
        const rows = parseSqlTable(`WARNING: This command is UNSTABLE and subject to breaking changes.\n\n${CONSENT_SQL}`);
        assert.equal(rows.length, 4);
        assert.deepEqual(rows[2], { id: '33', scope: 'errand', subject: 'care_team_request', revoked_at: 'none' });
        assert.equal(rows[1].subject, '');
        assert.equal(rows[0].revoked_at, 'some');
    });

    it('returns no rows for an empty table or text with no header', () => {
        assert.deepEqual(parseSqlTable(' id | scope\n----+------\n'), []);
        assert.deepEqual(parseSqlTable('nothing here'), []);
    });
});

describe('consents', () => {
    it('grants only what is missing, counting only active rows and reading camelCase scopes', () => {
        const missing = missingConsents(parseSqlTable(CONSENT_SQL), ['stephen']);
        assert.deepEqual(missing, [
            { scope: 'web_search', subject: '' },
            { scope: 'memory', subject: '' },
            { scope: 'board_text', subject: '' },
        ]);
        const all = missingConsents([], ['stephen']);
        assert.equal(all.length, 5);
        assert.deepEqual(all[4], { scope: 'call', subject: 'stephen' });
    });

    it('a revoked row does not count, and no call row is granted unless a contact is named', () => {
        const rows = [{ scope: 'webSearch', subject: '', revoked_at: 'some' }];
        assert.ok(missingConsents(rows).some((c) => c.scope === 'web_search'));
        assert.ok(!missingConsents([]).some((c) => c.scope === 'call'));
    });

    it('the consents command calls grant_consent once per missing row, on the named database', () => {
        const { calls, spacetime } = fakeCli({ 'SELECT id, scope, subject, revoked_at FROM consent': CONSENT_SQL });
        const { lines, out } = capture();
        assert.equal(run(['--db', 'say-when-demo', 'consents', '--call-contact', 'stephen'], { spacetime, out, contacts: () => ['stephen'] }), 0);
        const grants = calls.filter((c) => c[0] === 'call');
        assert.deepEqual(
            grants.map((c) => c.slice(4)),
            [
                ['say-when-demo', 'grant_consent', 'web_search', '', 'owner_cli', 'demo'],
                ['say-when-demo', 'grant_consent', 'memory', '', 'owner_cli', 'demo'],
                ['say-when-demo', 'grant_consent', 'board_text', '', 'owner_cli', 'demo'],
            ],
        );
        for (const c of calls) assert.deepEqual(c.slice(1, 4), ['--no-config', '--server', 'maincloud']);
        assert.equal(lines.length, 3);
    });

    it('refuses a contact id that is not an id, without echoing what was typed', () => {
        const { calls, spacetime } = fakeCli();
        const { lines, out } = capture();
        assert.equal(run(['--db', 'say-when-demo', 'consents', '--call-contact', '+14155550123'], { spacetime, out, contacts: () => ['stephen'] }), 2);
        assert.equal(calls.length, 0);
        assert.ok(!lines.join(' ').includes('4155550123'));
    });

    it('grants a call row only for a contact in the private consent file', () => {
        const unknown = fakeCli({ 'SELECT id, scope, subject, revoked_at FROM consent': CONSENT_SQL });
        assert.equal(run(['--db', 'say-when-demo', 'consents', '--call-contact', 'leon'], { spacetime: unknown.spacetime, out: () => {}, contacts: () => ['stephen'] }), 2);
        assert.equal(unknown.calls.length, 0, 'nothing granted, not even the other rows');
        const unreadable = fakeCli();
        assert.equal(run(['--db', 'say-when-demo', 'consents', '--call-contact', 'stephen'], { spacetime: unreadable.spacetime, out: () => {}, contacts: () => null }), 1);
        assert.equal(unreadable.calls.length, 0);
        const noCall = fakeCli();
        run(['--db', 'say-when-demo', 'consents'], { spacetime: noCall.spacetime, out: () => {}, contacts: () => assert.fail('the file is read only when a call contact is named') });
    });

    it('reads only the ids from the consent file the env file names', () => {
        const dir = mkdtempSync(join(tmpdir(), 'demo-owner-'));
        const consent = join(dir, 'consent.json');
        writeFileSync(consent, JSON.stringify([{ id: 'stephen', phone: '+14155550123' }, { id: 'sam', phone: '+14155550124' }, { phone: '+1415' }]));
        writeFileSync(join(dir, 'env.local'), `OTHER=1\nCALL_CONSENT_FILE="${consent}"\n`);
        assert.deepEqual(consentContactIds(join(dir, 'env.local')), ['stephen', 'sam']);
        writeFileSync(join(dir, 'env2.local'), 'OTHER=1\n');
        assert.equal(consentContactIds(join(dir, 'env2.local')), null);
        assert.equal(consentContactIds(join(dir, 'missing')), null);
        writeFileSync(join(dir, 'env3.local'), `CALL_CONSENT_FILE=${join(dir, 'nope.json')}\n`);
        assert.equal(consentContactIds(join(dir, 'env3.local')), null);
    });
});

describe('the database rule', () => {
    for (const db of ['say-when-try', 'say-when-try-dev', '', 'say-when']) {
        it(`refuses "${db}" before any CLI call`, () => {
            const { calls, spacetime } = fakeCli();
            assert.equal(run(['--db', db, 'state'], { spacetime, out: () => {} }), 2);
            assert.equal(calls.length, 0);
        });
    }
});

describe('devices', () => {
    it('revoke-others keeps the Agent and skips devices already revoked', () => {
        assert.deepEqual(devicesToRevoke(parseSqlTable(DEVICE_SQL)), [ID_B]);
    });

    it('revoke-others revokes nothing without --yes', () => {
        const { calls, spacetime } = fakeCli({ 'SELECT identity, role, revoked FROM device': DEVICE_SQL });
        const { lines, out } = capture();
        assert.equal(run(['--db', 'say-when-dev', 'revoke-others'], { spacetime, out }), 1);
        assert.equal(calls.filter((c) => c[0] === 'call').length, 0);
        assert.match(lines[0], /would revoke 1 device/);
        run(['--db', 'say-when-dev', 'revoke-others', '--yes'], { spacetime, out });
        assert.deepEqual(calls.filter((c) => c[0] === 'call').map((c) => c.slice(5)), [['revoke_device', ID_B]]);
    });

    it('state lists only devices not revoked, and the active consent rows', () => {
        const { spacetime } = fakeCli({
            'SELECT identity, role, label, online FROM device_status': STATUS_SQL,
            'SELECT identity, revoked FROM device': DEVICE_SQL,
            'SELECT id, scope, subject, revoked_at FROM consent': CONSENT_SQL,
            'SELECT active_session_id': ' active_session_id | share_text_on_board | menu_enabled\n---+---+---\n 0 | false | true\n',
            'SELECT id, label, ended_at FROM session': ' id | label | ended_at\n---+---+---\n 3 | "keyboard-test" | (some = (x = 1))\n',
        });
        const { lines, out } = capture();
        assert.equal(run(['--db', 'say-when-demo', 'state'], { spacetime, out }), 0);
        const text = lines.join('\n');
        assert.match(text, /active session: none/);
        assert.match(text, /devices paired and not revoked: 2/);
        assert.match(text, /devices revoked: 1/);
        assert.match(text, /consent rows active: errand care_team_request, call stephen/);
        assert.ok(!text.includes('partner phone 1'), 'a revoked device is not listed as paired');
    });

    it('approve and revoke check their argument before calling', () => {
        const { calls, spacetime } = fakeCli();
        assert.equal(run(['--db', 'say-when-demo', 'approve', '12345'], { spacetime, out: () => {} }), 2);
        assert.equal(run(['--db', 'say-when-demo', 'revoke', 'abc'], { spacetime, out: () => {} }), 2);
        assert.equal(calls.length, 0);
        assert.equal(run(['--db', 'say-when-demo', 'approve', '482913', '--caregiver'], { spacetime, out: () => {} }), 0);
        assert.deepEqual(calls[0].slice(4), ['say-when-demo', 'approve_pairing', '482913', 'true']);
    });

    it('sharing takes only on or off', () => {
        const { calls, spacetime } = fakeCli();
        assert.equal(run(['--db', 'say-when-demo', 'sharing', 'yes'], { spacetime, out: () => {} }), 2);
        assert.equal(run(['--db', 'say-when-demo', 'sharing', 'off'], { spacetime, out: () => {} }), 0);
        assert.deepEqual(calls[0].slice(5), ['set_board_sharing', 'false']);
    });

    it('end-session ends only an active session', () => {
        const none = fakeCli({ 'SELECT id, label, ended_at FROM session': ' id | label | ended_at\n---+---+---\n 3 | "x" | (some = (x = 1))\n' });
        run(['--db', 'say-when-demo', 'end-session'], { spacetime: none.spacetime, out: () => {} });
        assert.equal(none.calls.filter((c) => c[0] === 'call').length, 0);
        const live = fakeCli({ 'SELECT id, label, ended_at FROM session': ' id | label | ended_at\n---+---+---\n 4 | "keyboard-test" | (none = ())\n' });
        run(['--db', 'say-when-demo', 'end-session'], { spacetime: live.spacetime, out: () => {} });
        assert.deepEqual(live.calls.filter((c) => c[0] === 'call').map((c) => c.slice(5)), [['end_session']]);
    });
});
