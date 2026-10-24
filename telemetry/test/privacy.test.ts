import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { insertParams } from '../src/sink.js';
import { SUBSCRIBED, toCallIn, toDeviceIn, toErrandIn, toLedgerIn, toScanIn } from '../src/sources/spacetime.js';
import { Tracker } from '../src/tracker.js';
import type { TelemetryRow } from '../src/types.js';
import { sec } from './fixtures.js';

// Text a person might say, a memory, an option, a form value, a name and a number: none may ever reach a row.
const QUESTION = 'Would you like some chamomile tea';
const OPTION = 'Yes please with honey';
const MEMORY = 'Leon loves late night jazz';
const FORM = 'Lunch request for Room 214';
const NAME = 'Leon Marquez';
const PHONE = '+1 415 555 0142';
/** Words shaped like an id: a gesture id may be any 1 to 64 of [A-Za-z0-9:_-], so a station could send this. */
const ID_SHAPED = 'my_medication_is_metformin';
const SENTINELS = [QUESTION, OPTION, MEMORY, FORM, NAME, PHONE, ID_SHAPED];

const ts = (s: number) => ({ microsSinceUnixEpoch: sec(s) });

function ledgerRow(id: number, fields: Record<string, unknown>) {
    return {
        id: BigInt(id),
        sessionId: 1n,
        at: ts(id),
        kind: 'gesture',
        actor: `Station ${NAME}`,
        questionId: 7n,
        optionId: 0n,
        errandId: 0n,
        callId: 0n,
        jobId: 0n,
        gestureId: `g-${id}`,
        command: 'NO',
        stepSeq: 1n,
        cursor: 0,
        digest: QUESTION,
        outcome: 'ignored:idle',
        reason: 'idle',
        ms: 0,
        ...fields,
    };
}

function everyRow(): TelemetryRow[] {
    const rows: TelemetryRow[] = [];
    const t = new Tracker({ database: 'test-privacy', emit: (r) => rows.push(r) });
    // A station whose label (public, but never read) carries a name.
    const station = (s: number) =>
        toDeviceIn({ identity: { toHexString: () => 'ab12' }, role: { tag: 'Station' }, label: `${NAME} station`, online: true, lastSeenAt: ts(s), decoderHealthy: true });
    t.device(station(1));
    t.ledger(toLedgerIn(ledgerRow(1, { kind: 'session_start', outcome: QUESTION, reason: MEMORY })));
    t.scan(
        toScanIn({
            sessionId: 1n,
            questionId: 7n,
            phase: { tag: 'Idle' },
            mode: { tag: 'Answer' },
            answerMode: { tag: 'Pick' },
            cursor: 0,
            optionCount: 4,
            pass: 1,
            stepSeq: 1n,
            stepStartedAt: ts(1),
            stepEndsAt: ts(1),
            outcome: { tag: 'Picked' },
            pauseReason: undefined,
            updatedAt: ts(1),
        }),
    );
    t.markReady();
    // Free text in every string a ledger row has.
    t.ledger(toLedgerIn(ledgerRow(2, { outcome: `ignored:${QUESTION}`, reason: QUESTION })));
    t.ledger(toLedgerIn(ledgerRow(3, { outcome: `accepted:${OPTION}`, reason: MEMORY })));
    t.ledger(toLedgerIn(ledgerRow(4, { gestureId: `${FORM}`, outcome: 'ignored:idle' })));
    t.ledger(toLedgerIn(ledgerRow(5, { command: OPTION })));
    t.ledger(toLedgerIn(ledgerRow(6, { kind: 'pick', outcome: OPTION, cursor: 1, reason: MEMORY })));
    t.ledger(toLedgerIn(ledgerRow(7, { kind: 'question', outcome: QUESTION, reason: QUESTION })));
    t.ledger(toLedgerIn(ledgerRow(8, { kind: 'step', outcome: OPTION, cursor: 1 })));
    // A valid command whose gesture id is words in id shape: the row is kept, the id never is.
    t.ledger(toLedgerIn(ledgerRow(9, { gestureId: ID_SHAPED, outcome: 'ignored:idle' })));
    // An errand and a call carrying every text column the board views have, as when board sharing is on.
    t.action(
        toErrandIn({
            errandId: 3n,
            sessionId: 1n,
            questionId: 7n,
            status: { tag: 'Submitted' },
            formTitle: FORM,
            previewDigest: QUESTION,
            reasonCode: MEMORY,
            reason: QUESTION,
            confirmGestureId: NAME,
            stopGestureId: NAME,
            createdAt: ts(9),
            previewedAt: ts(9),
            readbackDoneAt: undefined,
            confirmOpensAt: undefined,
            confirmClosesAt: undefined,
            confirmedAt: undefined,
            claimedAt: undefined,
            submittedAt: ts(10),
            endedAt: undefined,
            updatedAt: ts(10),
            textShared: true,
            readBackText: `${FORM} for ${NAME}`,
            readBackJson: JSON.stringify({ name: NAME, phone: PHONE }),
            confirmationText: `Thanks ${NAME}`,
            screenshotUrl: 'https://example.com/shot.png',
        }),
    );
    t.action(
        toCallIn({
            callId: 4n,
            sessionId: 1n,
            questionId: 7n,
            status: { tag: 'Ended' },
            result: `${NAME} said ${MEMORY}`,
            endReason: QUESTION,
            reasonCode: MEMORY,
            reason: QUESTION,
            scriptDigest: OPTION,
            consentOnFile: true,
            cancelRequested: false,
            createdAt: ts(11),
            confirmedAt: undefined,
            dialedAt: undefined,
            ringingAt: undefined,
            connectedAt: undefined,
            endedAt: ts(12),
            updatedAt: ts(12),
            textShared: true,
            contactName: NAME,
            readBackText: `Call ${NAME} at ${PHONE}`,
            transcript: [{ role: 'recipient', text: `${MEMORY} ${PHONE}`, at: ts(12) }],
        }),
    );
    t.device(station(100));
    t.checkpoint();
    return rows;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

describe('privacy: no question, option, memory, form, name or number text reaches a row', () => {
    const rows = everyRow();

    test('the planted text appears in no row and in no SQL parameter', () => {
        assert.ok(rows.length >= 6, 'the scenario produced rows of several kinds');
        const params = rows.map((r) => insertParams(r.table, [r.row as never]));
        const all = json(rows) + json(params);
        for (const s of SENTINELS) {
            assert.ok(!all.includes(s), `found "${s}"`);
            for (const word of s.split(' ').filter((w) => w.length > 4)) assert.ok(!all.includes(word), `found the word "${word}"`);
        }
    });

    test('every string in every row is a short code, id or word (no spaces, no sentences)', () => {
        for (const r of rows) {
            for (const [key, value] of Object.entries(r.row)) {
                if (typeof value !== 'string') continue;
                assert.match(value, /^[A-Za-z0-9:_-]{1,72}$/, `${r.table}.${key} = ${value}`);
            }
        }
    });

    test('free text in a code becomes other, and a malformed id or command drops the row', () => {
        const events = rows.filter((r) => r.table === 'switch_events').map((r) => r.row as { code: string; ledgerId: bigint });
        assert.deepEqual(
            events.map((e) => [Number(e.ledgerId), e.code]),
            [
                [2, 'other'],
                [3, 'other'],
                [9, 'idle'],
            ],
        );
        for (const e of events) assert.ok(!('gestureId' in e), 'a switch event row carries no gesture id');
        const pick = rows.find((r) => r.table === 'picks')?.row as { pickKind: string } | undefined;
        assert.equal(pick?.pickKind, 'other');
        const call = rows.find((r) => r.table === 'action_outcomes' && (r.row as { kind: string }).kind === 'call')?.row as { result: string } | undefined;
        assert.equal(call?.result, 'other');
        // The session label (here a sentence) is never stored: only the input word, and a label naming no input is unknown.
        const inputs = rows.filter((r) => r.table === 'session_inputs').map((r) => r.row as { input: string });
        assert.deepEqual(inputs.map((r) => r.input), ['unknown']);
    });

    test('the source subscribes to no view that carries content', () => {
        const wires = Object.values(SUBSCRIBED) as string[];
        for (const forbidden of ['public_board', 'board_payloads', 'partner_view', 'my_session', 'my_options', 'agent_queue', 'pipeline_payload', 'question', 'answer_option']) {
            assert.ok(!wires.includes(forbidden), forbidden);
        }
    });

    test('the normalizers never read a text column', () => {
        const source = readFileSync(new URL('../src/sources/spacetime.ts', import.meta.url), 'utf8');
        const body = source.slice(source.indexOf('export function toLedgerIn'), source.indexOf('// ---------- The source ----------'));
        for (const column of ['readBackText', 'readBackJson', 'confirmationText', 'screenshotUrl', 'contactName', 'transcript', 'formTitle', 'digest', 'scriptDigest', 'previewDigest', "'reason'", 'endReason', 'reasonCode', 'actor']) {
            if (column === "'reason'") {
                // The ledger's reason code is read (it is a code, held to CODE_RE downstream); no errand or call reason is.
                const errandAndCall = body.slice(body.indexOf('export function toErrandIn'));
                assert.ok(!errandAndCall.includes(column), 'toErrandIn or toCallIn reads reason');
                continue;
            }
            assert.ok(!body.includes(column), `a normalizer reads ${column}`);
        }
        // device_status has a public label; only role, online, health, last seen and the identity are read.
        assert.ok(!body.includes("'label'") && !body.includes('.label'), 'a normalizer reads the device label');
    });

    test('every text column in the schema is held to a shape or a word list by a CHECK', () => {
        const dir = new URL('../sql/', import.meta.url);
        const tableFiles = readdirSync(dir).filter((f) => /^(01\d|060)_.*\.sql$/.test(f));
        assert.ok(tableFiles.includes('060_session_inputs.sql'));
        for (const file of tableFiles) {
            const sql = readFileSync(new URL(file, dir), 'utf8');
            const textColumns = [...sql.matchAll(/^\s+([a-z_]+) text\b/gm)].map((m) => m[1]!);
            assert.ok(textColumns.length > 0, file);
            for (const col of textColumns) {
                const guarded = new RegExp(`CHECK \\([^\\n]*\\b${col}\\b[^\\n]*(~|IN \\()`).test(sql);
                assert.ok(guarded, `${file}: ${col} has no CHECK`);
            }
        }
    });
});
