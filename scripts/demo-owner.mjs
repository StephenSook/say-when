#!/usr/bin/env node
// The owner's side of the Eleven demo, from this Mac's spacetime CLI login (the owner of say-when-dev and say-when-demo).
//
//   node scripts/demo-owner.mjs --db say-when-demo state                 what is paired, what is consented, the session
//   node scripts/demo-owner.mjs --db say-when-demo approve 482913        approve a pairing code shown on a page
//   node scripts/demo-owner.mjs --db say-when-demo approve 482913 --caregiver
//   node scripts/demo-owner.mjs --db say-when-demo consents --call-contact stephen
//                                                                         grant the demo's consent rows that are missing
//   node scripts/demo-owner.mjs --db say-when-demo sharing on|off        the room's board text toggle
//   node scripts/demo-owner.mjs --db say-when-demo end-session           end the active session (voids anything pending)
//   node scripts/demo-owner.mjs --db say-when-demo revoke 0x<identity>
//   node scripts/demo-owner.mjs --db say-when-demo revoke-others --yes   revoke every device except the Agent
//   node scripts/demo-owner.mjs --db say-when-demo timers                ensure_timers (after any publish)
//
// Only say-when-dev and say-when-demo. It prints identities, roles, labels and consent scopes, never a token, a key,
// a phone number or any content. docs/demo-runbook.md has the order of the morning.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DATABASES = ['say-when-dev', 'say-when-demo'];

/** The consent rows every demo needs (docs/spacetime.md 9.4): scope and subject. A call row is added per contact. */
export const DEMO_CONSENTS = [
    { scope: 'web_search', subject: '' },
    { scope: 'memory', subject: '' },
    { scope: 'board_text', subject: '' },
    { scope: 'errand', subject: 'care_team_request' },
];

const CONTACT_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const IDENTITY = /^0x[0-9a-f]{64}$/;

/** The scope words the module takes, from the camelCase variant names `spacetime sql` prints. */
const SCOPE_WORDS = { webSearch: 'web_search', memory: 'memory', boardText: 'board_text', errand: 'errand', call: 'call' };

/** One cell of `spacetime sql` output: `(station = ())` is station, `"x"` is x, `(none = ())` is none. */
export function decodeCell(raw) {
    const cell = raw.trim();
    const variant = /^\((\w+) = .*\)$/.exec(cell);
    if (variant) return variant[1];
    if (cell.startsWith('"') && cell.endsWith('"') && cell.length >= 2) return cell.slice(1, -1);
    return cell;
}

/** The rows of `spacetime sql` output as objects keyed by column name. Lines before the header are ignored. */
export function parseSqlTable(text) {
    const lines = text.split('\n');
    const sep = lines.findIndex((line) => /^-+(\+-+)*\s*$/.test(line.trim()) && line.includes('-'));
    if (sep < 1) return [];
    const header = lines[sep - 1].split('|').map((h) => h.trim());
    const rows = [];
    for (const line of lines.slice(sep + 1)) {
        if (!line.includes('|') && line.trim() === '') continue;
        const cells = line.split('|');
        if (cells.length !== header.length) continue;
        const row = {};
        header.forEach((name, i) => (row[name] = decodeCell(cells[i])));
        rows.push(row);
    }
    return rows;
}

/** The consent rows still missing, given the module's consent table and the call contacts wanted. */
export function missingConsents(consentRows, callContacts = []) {
    const active = new Set(
        consentRows.filter((row) => row.revoked_at === 'none').map((row) => `${SCOPE_WORDS[row.scope] ?? row.scope}:${row.subject}`),
    );
    const wanted = [...DEMO_CONSENTS, ...callContacts.map((id) => ({ scope: 'call', subject: id }))];
    return wanted.filter((c) => !active.has(`${c.scope}:${c.subject}`));
}

/** The devices `revoke-others` revokes: every one not yet revoked, except the Agent. */
export function devicesToRevoke(deviceRows) {
    return deviceRows.filter((row) => row.revoked === 'false' && row.role !== 'agent').map((row) => row.identity);
}

export function parseArgs(argv) {
    const args = { db: '', command: '', rest: [], caregiver: false, yes: false, callContacts: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--db') args.db = argv[++i] ?? '';
        else if (a === '--caregiver') args.caregiver = true;
        else if (a === '--yes') args.yes = true;
        else if (a === '--call-contact') args.callContacts.push(argv[++i] ?? '');
        else if (!args.command) args.command = a;
        else args.rest.push(a);
    }
    return args;
}

/** The CLI runner: `spacetime <args>` with the output returned. Tests pass their own. */
export function cliRunner(args) {
    return execFileSync('spacetime', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
}

export function run(argv, { spacetime = cliRunner, out = (line) => process.stdout.write(`${line}\n`) } = {}) {
    const args = parseArgs(argv);
    if (!DATABASES.includes(args.db)) {
        out(`Refusing database "${args.db}": use --db say-when-dev or --db say-when-demo.`);
        return 2;
    }
    const sql = (query) => parseSqlTable(spacetime(['sql', '--no-config', '--server', 'maincloud', args.db, query]));
    const call = (...reducerArgs) => spacetime(['call', '--no-config', '--server', 'maincloud', args.db, ...reducerArgs]);

    switch (args.command) {
        case 'state': {
            const [config] = sql('SELECT active_session_id, share_text_on_board, menu_enabled FROM config');
            const status = sql('SELECT identity, role, label, online FROM device_status');
            const revoked = new Map(sql('SELECT identity, revoked FROM device').map((row) => [row.identity, row.revoked]));
            const consents = sql('SELECT id, scope, subject, revoked_at FROM consent').filter((row) => row.revoked_at === 'none');
            const sessions = sql('SELECT id, label, ended_at FROM session').filter((row) => row.ended_at === 'none');
            out(`database ${args.db}`);
            out(`active session: ${sessions.length === 0 ? 'none' : sessions.map((s) => `${s.id} (${s.label})`).join(', ')}; board sharing ${config?.share_text_on_board ?? '?'}; idle menu ${config?.menu_enabled ?? '?'}`);
            const live = status.filter((row) => revoked.get(row.identity) !== 'true');
            out(`devices paired and not revoked: ${live.length}`);
            for (const row of live) out(`  ${row.role.padEnd(8)} ${row.label.padEnd(18)} ${row.online === 'true' ? 'online ' : 'offline'} ${row.identity}`);
            out(`devices revoked: ${status.length - live.length}`);
            out(`consent rows active: ${consents.length === 0 ? 'none' : consents.map((c) => `${SCOPE_WORDS[c.scope] ?? c.scope}${c.subject ? ` ${c.subject}` : ''}`).join(', ')}`);
            return 0;
        }
        case 'devices': {
            const revoked = new Map(sql('SELECT identity, revoked FROM device').map((row) => [row.identity, row.revoked]));
            for (const row of sql('SELECT identity, role, label, online FROM device_status')) {
                out(`${row.role.padEnd(8)} ${row.label.padEnd(18)} ${row.online === 'true' ? 'online ' : 'offline'} ${revoked.get(row.identity) === 'true' ? 'revoked' : 'paired '} ${row.identity}`);
            }
            return 0;
        }
        case 'approve': {
            const code = args.rest[0] ?? '';
            if (!/^[1-9][0-9]{5}$/.test(code)) {
                out('approve needs the 6-digit code the page shows.');
                return 2;
            }
            call('approve_pairing', code, args.caregiver ? 'true' : 'false');
            out(`approved ${code}${args.caregiver ? ' as a caregiver' : ''}; the page turns paired within a few seconds.`);
            return 0;
        }
        case 'consents': {
            const bad = args.callContacts.find((id) => !CONTACT_ID.test(id));
            if (bad !== undefined) {
                out(`--call-contact must be a contact id from the consent file (lowercase, starting with a letter), not "${bad}".`);
                return 2;
            }
            const missing = missingConsents(sql('SELECT id, scope, subject, revoked_at FROM consent'), args.callContacts);
            for (const c of missing) {
                call('grant_consent', c.scope, c.subject, 'owner_cli', 'demo');
                out(`granted ${c.scope}${c.subject ? ` ${c.subject}` : ''}`);
            }
            if (missing.length === 0) out('every demo consent row is already active.');
            return 0;
        }
        case 'sharing': {
            const on = args.rest[0];
            if (on !== 'on' && on !== 'off') {
                out('sharing needs on or off.');
                return 2;
            }
            call('set_board_sharing', on === 'on' ? 'true' : 'false');
            out(`board sharing ${on}: the public screens ${on === 'on' ? 'show the words' : 'hide the words'}.`);
            return 0;
        }
        case 'end-session': {
            const sessions = sql('SELECT id, label, ended_at FROM session').filter((row) => row.ended_at === 'none');
            if (sessions.length === 0) {
                out('no active session.');
                return 0;
            }
            call('end_session');
            out(`ended session ${sessions.map((s) => s.id).join(', ')}.`);
            return 0;
        }
        case 'revoke': {
            const identity = (args.rest[0] ?? '').toLowerCase();
            if (!IDENTITY.test(identity)) {
                out('revoke needs a full identity, 0x and 64 hex digits (see the devices list).');
                return 2;
            }
            call('revoke_device', identity);
            out(`revoked ${identity}`);
            return 0;
        }
        case 'revoke-others': {
            const targets = devicesToRevoke(sql('SELECT identity, role, revoked FROM device'));
            if (!args.yes) {
                out(`would revoke ${targets.length} device(s), every one but the Agent; run again with --yes.`);
                return targets.length === 0 ? 0 : 1;
            }
            for (const identity of targets) {
                call('revoke_device', identity);
                out(`revoked ${identity}`);
            }
            if (targets.length === 0) out('nothing to revoke.');
            return 0;
        }
        case 'timers': {
            call('ensure_timers');
            out('ensure_timers ran.');
            return 0;
        }
        default:
            out('usage: node scripts/demo-owner.mjs --db say-when-dev|say-when-demo state|devices|approve CODE [--caregiver]|consents [--call-contact ID]|sharing on|off|end-session|revoke 0x<identity>|revoke-others --yes|timers');
            return 2;
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    try {
        process.exitCode = run(process.argv.slice(2));
    } catch (error) {
        // The CLI's own message (a module refusal such as "unknown or expired code"), never a stack.
        const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim().split('\n').slice(-3).join(' ') : '';
        process.stderr.write(`demo-owner: the spacetime call failed${stderr ? `: ${stderr}` : ''}\n`);
        process.exitCode = 1;
    }
}
