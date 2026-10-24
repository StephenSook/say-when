// The names the SpacetimeDB source uses must exist in the contract (docs/spacetime.md) and in the module source
// (spacetime/src), and the normalizers must accept rows shaped like the generated bindings. When the module renames
// something, this fails before a live writer silently skips rows.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { camel, SUBSCRIBED, toCallIn, toDeviceIn, toErrandIn, toLedgerIn, toScanIn } from '../src/sources/spacetime.js';
import { sec } from './fixtures.js';

const DOC = new URL('../../docs/spacetime.md', import.meta.url);
const SCHEMA = new URL('../../spacetime/src/schema.ts', import.meta.url);
const VIEWS = new URL('../../spacetime/src/views.ts', import.meta.url);
const ts = (s: number) => ({ microsSinceUnixEpoch: sec(s), toMillis: () => sec(s) / 1000n });

describe('names against the contract and the module', () => {
    test('every table and view the source reads is in docs/spacetime.md as a public table or anonymous view', () => {
        const doc = readFileSync(DOC, 'utf8');
        for (const wire of Object.values(SUBSCRIBED)) assert.ok(doc.includes(`\`${wire}\``), wire);
        assert.match(doc, /\| `scan_state` \| \*\*public\*\*/);
        assert.match(doc, /\| `device_status` \| \*\*public\*\*/);
        assert.match(doc, /\| `board_ledger` \| anonymous/);
        assert.match(doc, /\| `board_errands` \| anonymous/);
        assert.match(doc, /\| `board_calls` \(stretch\) \| anonymous/);
    });

    test('the module declares every accessor and field the normalizers read', () => {
        assert.ok(existsSync(SCHEMA), 'spacetime/src/schema.ts is missing from this checkout');
        const schema = readFileSync(SCHEMA, 'utf8');
        const views = readFileSync(VIEWS, 'utf8');
        assert.match(schema, /export const scanState = table\(\s*\{ public: true \}/);
        assert.match(schema, /export const deviceStatus = table\(\s*\{ public: true \}/);
        for (const wire of ['board_ledger', 'board_errands', 'board_calls']) assert.match(views, new RegExp(`export const ${camel(wire)} = spacetimedb\\.anonymousView`), wire);
        const ledger = schema.slice(schema.indexOf("t.row('Ledger'"), schema.indexOf('export type Ledger'));
        for (const f of ['id', 'sessionId', 'at', 'kind', 'questionId', 'optionId', 'errandId', 'callId', 'gestureId', 'command', 'stepSeq', 'cursor', 'outcome', 'reason', 'ms']) {
            assert.match(ledger, new RegExp(`\\b${f}: t\\.`), `ledger.${f}`);
        }
        const scan = schema.slice(schema.indexOf("t.row('ScanState'"), schema.indexOf('export type ScanState'));
        for (const f of ['sessionId', 'questionId', 'mode', 'answerMode', 'phase', 'cursor', 'optionCount', 'pass', 'stepSeq', 'stepStartedAt', 'stepEndsAt', 'outcome', 'pauseReason', 'updatedAt']) {
            assert.match(scan, new RegExp(`\\b${f}: `), `scan_state.${f}`);
        }
        const errand = views.slice(views.indexOf("t.row('BoardErrand'"), views.indexOf('const BoardCallLine'));
        for (const f of ['errandId', 'sessionId', 'status', 'createdAt', 'previewedAt', 'readbackDoneAt', 'confirmedAt', 'claimedAt', 'submittedAt', 'endedAt', 'updatedAt']) {
            assert.match(errand, new RegExp(`\\b${f}: `), `board_errands.${f}`);
        }
        const call = views.slice(views.indexOf("t.row('BoardCall'"), views.indexOf('// ---------- Shared reads'));
        for (const f of ['callId', 'sessionId', 'status', 'result', 'createdAt', 'confirmedAt', 'dialedAt', 'ringingAt', 'connectedAt', 'endedAt', 'updatedAt']) {
            assert.match(call, new RegExp(`\\b${f}: `), `board_calls.${f}`);
        }
        const device = schema.slice(schema.indexOf("t.row('DeviceStatus'"), schema.indexOf('export type DeviceStatus'));
        assert.match(device, /\bidentity: t\.identity\(\)/);
        assert.match(device, /\brole: Role/);
        assert.match(device, /\bonline: t\.bool\(\)/);
        assert.match(device, /\blastSeenAt: t\.timestamp\(\)/);
        assert.match(device, /\bdecoderHealthy: t\.option\(t\.bool\(\)\)/);
        // The rest rule leans on two module behaviours: liveness_expired marks the station offline even when a
        // deliberate pause keeps the scan unchanged, and a signal pause never replaces a deliberate one.
        const index = readFileSync(new URL('../../spacetime/src/index.ts', import.meta.url), 'utf8');
        assert.match(index, /livenessExpired[\s\S]{0,900}deviceStatus\.identity\.update\(\{ \.\.\.ds, online: false \}\)/, 'liveness_expired sets the station offline');
        const clockSrc = readFileSync(new URL('../../spacetime/src/clock.ts', import.meta.url), 'utf8');
        assert.match(clockSrc, /PAUSE_RANK\[reason\] <= PAUSE_RANK\[current\]\) return false/, 'a signal pause does not replace a deliberate one');
        // The gesture outcome vocabulary the tracker reads (docs/spacetime.md 4.2).
        const gesture = readFileSync(new URL('../../spacetime/src/gesture.ts', import.meta.url), 'utf8');
        const clock = readFileSync(new URL('../../spacetime/src/clock.ts', import.meta.url), 'utf8');
        for (const reason of ['idle', 'nothing_to_confirm', 'paused', 'already_paused']) assert.ok(gesture.includes(`ignored('${reason}'`), `ignored:${reason}`);
        for (const action of ['skip', 'answer_yes', 'answer_no', 'menu_open']) assert.ok(gesture.includes(`accepted('${action}'`), `accepted:${action}`);
        for (const action of ['pick', 'pick_errand', 'pick_call', 'menu_item']) assert.ok(clock.includes(`return '${action}';`), `accepted:${action}`);
        // The ledger rows the tracker indexes.
        assert.ok(clock.includes("appendLedger(ctx, s.sessionId, 'step'"), 'step rows');
        assert.ok(clock.includes("appendLedger(ctx, s.sessionId, 'pick'"), 'pick rows');
    });
});

describe('normalizers on rows shaped like the generated bindings', () => {
    test('ledger rows: bigint ids, Timestamp objects, plain strings', () => {
        const row = toLedgerIn({
            id: 12n,
            sessionId: 3n,
            at: ts(5),
            kind: 'gesture',
            actor: 'Station',
            questionId: 7n,
            optionId: 101n,
            errandId: 0n,
            callId: 0n,
            jobId: 0n,
            gestureId: 'a1b2',
            command: 'YES',
            stepSeq: 9n,
            cursor: 1,
            digest: '',
            outcome: 'accepted:pick',
            reason: '',
            ms: 120,
        });
        assert.equal(row.at, sec(5));
        assert.equal(row.stepSeq, 9n);
        assert.equal(row.outcome, 'accepted:pick');
    });

    test('scan_state rows: enum tags become snake_case words, unset options become null', () => {
        const row = toScanIn({
            sessionId: 3n,
            questionId: 7n,
            version: 1,
            mode: { tag: 'Menu' },
            answerMode: { tag: 'YesNo' },
            phase: { tag: 'Paused' },
            cursor: 0,
            optionCount: 4,
            pass: 1,
            maxPasses: 2,
            stepSeq: 4n,
            stepStartedAt: ts(1),
            stepEndsAt: ts(2),
            optionStartSeq: 3n,
            optionStartedAt: ts(1),
            prevCursor: 0,
            prevOptionStartSeq: 0n,
            outcome: undefined,
            pickedRank: undefined,
            pickedOptionId: undefined,
            pauseReason: { tag: 'HeadsetLost' },
            pausedAt: ts(1),
            resumeCursor: 1,
            updatedAt: ts(1),
        });
        assert.equal(row.mode, 'menu');
        assert.equal(row.answerMode, 'yes_no');
        assert.equal(row.phase, 'paused');
        assert.equal(row.pauseReason, 'headset_lost');
        assert.equal(row.outcome, null);
    });

    test('errand and call rows: the status time comes from the status column, else updated_at', () => {
        const errand = toErrandIn({ errandId: 1n, sessionId: 3n, status: { tag: 'AwaitingConfirm' }, readbackDoneAt: ts(8), updatedAt: ts(9), createdAt: ts(1) });
        assert.equal(errand.status, 'awaiting_confirm');
        assert.equal(errand.statusAt, sec(8));
        const call = toCallIn({ callId: 2n, sessionId: 3n, status: { tag: 'AwaitingConfirm' }, result: '', updatedAt: ts(9), createdAt: ts(1) });
        assert.equal(call.statusAt, sec(9));
    });

    test('device_status rows: identity as hex, role as a word, unset health as null', () => {
        const station = toDeviceIn({ identity: { toHexString: () => 'c200ab' }, role: { tag: 'Station' }, label: 'station', online: false, lastSeenAt: ts(42), decoderHealthy: false });
        assert.deepEqual(station, { id: 'c200ab', role: 'station', online: false, decoderHealthy: false, lastSeenAt: sec(42) });
        const phone = toDeviceIn({ identity: { toHexString: () => 'c200ac' }, role: { tag: 'Partner' }, label: 'phone', online: true, lastSeenAt: ts(43), decoderHealthy: undefined });
        assert.equal(phone.decoderHealthy, null);
        assert.throws(() => toDeviceIn({ identity: 'c200ad', role: { tag: 'Station' }, online: true, lastSeenAt: ts(1) }), /expected an identity/);
    });

    test('a missing or mistyped field is a contract error, not a crash downstream', () => {
        assert.throws(() => toLedgerIn({ id: 1n }), /missing field sessionId/);
        assert.throws(() => toScanIn({ sessionId: 1n, questionId: 1n, phase: 'Idle' }), /expected an enum value/);
        assert.throws(() => toLedgerIn({ id: -1n }), /expected a u64/);
    });
});
