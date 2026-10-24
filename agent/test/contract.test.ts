// Fails loudly when a SpacetimeDB name the sidecar depends on drifts: a reducer renamed, an argument added or
// reordered, a view field renamed. Three sources, each checked when it exists:
// 1. docs/spacetime.md, the contract (always).
// 2. spacetime/src, the module source (index.ts reducers, views.ts row types).
// 3. spacetime/bindings/agent, the generated bindings the sidecar actually loads.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONFIRM_MAX_AGE_MS, finalReport, lateReason } from '../src/calls.js';
import { CALL_CLAIM_MS, camel, DEVICE_STATUS, MODULE_EVENT_KEY, REDUCERS, VIEWS } from '../src/contract.js';
import type { CallOutcome } from '../src/ports.js';
import type { ReducerArgs, ReducerName } from '../src/types.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DOC = readFileSync(join(REPO, 'docs/spacetime.md'), 'utf8');
const MODULE_INDEX = join(REPO, 'spacetime/src/index.ts');
const MODULE_VIEWS = join(REPO, 'spacetime/src/views.ts');
const MODULE_CONSENT = join(REPO, 'spacetime/src/consent.ts');
const MODULE_AGENT = join(REPO, 'spacetime/src/agent.ts');
const BINDINGS = join(REPO, 'spacetime/bindings/agent');

/** Every `name(args)` signature of a wire name in the doc, as argument-name lists. */
function docSignatures(wire: string): string[][] {
    const out: string[][] = [];
    for (const match of DOC.matchAll(new RegExp(`\\b${wire}\\(([^)]*)\\)`, 'g'))) {
        const args = (match[1] ?? '').split(',').map((part) => part.trim().split(/\s+/)[0] ?? '').filter(Boolean);
        out.push(args);
    }
    return out;
}

/** The `{ ... }` field list of a view's row in the doc's section 5 table. */
function docViewFields(wire: string): string[] {
    const row = DOC.split('\n').find((line) => line.startsWith(`| \`${wire}\``));
    assert.ok(row, `docs/spacetime.md has no section 5 row for ${wire}`);
    const fields = /`\{([^`]*)\}`/.exec(row)?.[1];
    assert.ok(fields, `the ${wire} row lists no fields`);
    return fields.split(',').map((part) => part.trim().split(/[\s(]/)[0] ?? '').filter(Boolean);
}

/** The object literal right after `marker`, with balanced braces. */
function objectAfter(source: string, marker: string): string | null {
    const at = source.indexOf(marker);
    if (at < 0) return null;
    const open = source.indexOf('{', at + marker.length);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
    }
    return null;
}

/** Top-level keys of an object literal body (`jobId: t.u64(), attempt: t.u32()`). */
function topKeys(body: string): string[] {
    const keys: string[] = [];
    let depth = 0;
    let token = '';
    for (const ch of body) {
        if ('{([' .includes(ch)) depth++;
        if ('})]'.includes(ch)) depth--;
        if (depth === 0 && ch === ':') {
            const key = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(token)?.[1];
            if (key) keys.push(key);
            token = '';
            continue;
        }
        if (depth === 0 && ch === ',') token = '';
        else token += ch;
    }
    return keys;
}

/** One sample of every reducer's arguments; TypeScript checks it is complete. */
const SAMPLES: { [K in ReducerName]: ReducerArgs[K] } = {
    agentClaim: { jobId: 1n },
    agentProgress: { jobId: 1n, attempt: 1, eventKey: 'k', stage: 'plan', status: 'ok', detail: 'claude', ms: 1, countsJson: '{}', payloadJson: '' },
    agentPublishOptions: { jobId: 1n, attempt: 1, answerMode: 'pick', options: [], final: true },
    agentAttachPreview: {
        jobId: 1n,
        attempt: 1,
        status: 'failed',
        formTitle: '',
        readBackText: '',
        readBackJson: '',
        previewDigest: '',
        screenshotUrl: '',
        reasonCode: '',
        reason: '',
        previewMs: 0,
    },
    agentFail: { jobId: 1n, attempt: 1, reasonCode: 'x', reason: 'y' },
    agentDone: { jobId: 1n, attempt: 1, countsJson: '{}' },
    claimErrand: { errandId: 1n, digest: '0123456789abcdef' },
    completeErrand: { errandId: 1n, attempt: 1, status: 'unknown', confirmationText: '', screenshotUrl: '', reasonCode: '', reason: '', submitMs: 0 },
    claimCall: { callId: 1n, digest: '0123456789abcdef' },
    reportCallStatus: { callId: 1n, attempt: 1, status: 'ended', result: 'answered', endReason: '', reasonCode: '', reason: '' },
    addCallLine: { callId: 1n, attempt: 1, lineKey: 'l', role: 'assistant', text: 't' },
    requestPairing: { code: 123456, role: 'agent', label: 'agent sidecar' },
};

describe('the contract against docs/spacetime.md', () => {
    for (const [name, spec] of Object.entries(REDUCERS) as [ReducerName, (typeof REDUCERS)[ReducerName]][]) {
        it(`${spec.wire} takes ${spec.args.join(', ')}`, () => {
            const signatures = docSignatures(spec.wire);
            assert.ok(signatures.length > 0, `docs/spacetime.md never shows ${spec.wire}(...)`);
            assert.ok(
                signatures.some((args) => args.join(',') === spec.args.join(',')),
                `no ${spec.wire} signature in the doc matches; the doc shows ${JSON.stringify(signatures)}`,
            );
            assert.deepEqual(Object.keys(SAMPLES[name]), spec.args.map(camel), 'the argument object keys follow the wire order');
        });
    }

    for (const view of Object.values(VIEWS)) {
        it(`${view.wire} has every field the sidecar reads`, () => {
            const fields = docViewFields(view.wire);
            for (const field of view.fields) assert.ok(fields.includes(field), `${view.wire}.${field} is not in docs/spacetime.md`);
        });
    }

    it('device_status is a public table with identity and role', () => {
        assert.match(DOC, /\*\*`device_status`\*\* \(public, primary key `identity`\): `role` Role/);
        assert.deepEqual([...DEVICE_STATUS.fields], ['identity', 'role']);
    });

    it('call_queue carries the CONFIRM\'s time, and claim_call refuses an old CONFIRM as final (module v2)', () => {
        const row = DOC.split('\n').find((line) => line.startsWith(`| \`${VIEWS.callQueue.wire}\``));
        assert.ok(row);
        assert.match(row, /`confirmed_at` is the CONFIRM's time/);
        assert.match(DOC, /`claim_call` can throw `confirm expired`: final, never retried/);
    });

    it('agent_consent is a per-identity view for the Agent, read to forget the conversation (module v2)', () => {
        const row = DOC.split('\n').find((line) => line.startsWith(`| \`${VIEWS.agentConsent.wire}\``));
        assert.ok(row);
        assert.match(row, /per identity/);
        assert.match(row, /\| Agent \|/);
        assert.match(DOC, /forget the kept conversation whenever `memory_allowed` is false, with or without a job/);
    });
});

/** A literal from the module source: the first capture of `pattern`, or a failed test naming what is missing. */
function sourceCapture(file: string, pattern: RegExp, what: string): string {
    const found = pattern.exec(readFileSync(file, 'utf8'))?.[1];
    assert.ok(found, `${what} is not in ${file}`);
    return found;
}

describe('the call and event rules against the module source (module v2)', () => {
    it('the sidecar\'s CONFIRM age limit is the module\'s claim window', (t) => {
        if (!existsSync(MODULE_CONSENT)) return t.skip('spacetime/src/consent.ts does not exist yet');
        const claimMs = Number(sourceCapture(MODULE_CONSENT, /export const CALL_CLAIM_MS = ([\d_]+);/, 'CALL_CLAIM_MS').replace(/_/g, ''));
        assert.equal(CALL_CLAIM_MS, claimMs);
        assert.equal(CONFIRM_MAX_AGE_MS, claimMs, 'a call the module would still let through is the most the sidecar dials');
        const source = readFileSync(MODULE_CONSENT, 'utf8');
        const claim = source.slice(source.indexOf('export function claimCall('), source.indexOf('const CALL_RESULTS'));
        assert.ok(claim.indexOf("'confirm expired'") > 0 && claim.indexOf("'confirm expired'") < claim.indexOf("'line busy'"), 'checked before line busy, so it is final');
    });

    it('every held outcome the sidecar reports reads as held to the module, and no other does', (t) => {
        if (!existsSync(MODULE_CONSENT)) return t.skip('spacetime/src/consent.ts does not exist yet');
        const codes = sourceCapture(MODULE_CONSENT, /const HOLD_CODES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/, 'HOLD_CODES')
            .split(',')
            .map((code) => code.trim().replace(/^'|'$/g, ''));
        const sentence = new RegExp(sourceCapture(MODULE_CONSENT, /const HOLD_SENTENCE_RE = \/(.+)\/;/, 'HOLD_SENTENCE_RE'));
        const isHeld = (report: { reasonCode: string; reason: string }) => codes.includes(report.reasonCode) || sentence.test(report.reason);
        const hold = ' Calls to Leon are on hold until someone checks.';
        const base: CallOutcome = {
            requestId: 'r',
            result: 'answered',
            dialed: true,
            callId: 'c',
            endReason: null,
            cancelReason: null,
            refusal: null,
            optedOut: false,
            held: true,
            spoken: `Leon picked up. The call has ended.${hold}`,
            summary: null,
            ms: 1,
        };
        const held: CallOutcome[] = [
            { ...base, optedOut: true, spoken: `Leon may not want more calls.${hold}` },
            base,
            { ...base, result: 'no_answer', spoken: `Leon did not answer.${hold}` },
            { ...base, result: 'failed', spoken: `The call could not be placed.${hold}` },
            { ...base, result: 'unknown', dialed: 'unknown', spoken: `I could not tell if the call went out. Check before trying again.${hold}` },
            { ...base, result: 'refused', dialed: false, refusal: { code: 'hold_file_error', reason: 'I could not record the call safely, so I did not call.' }, spoken: `I could not record the call safely, so I did not call.${hold}` },
        ];
        for (const outcome of held) assert.ok(isHeld(finalReport(outcome)), `${outcome.result} with a hold reads as held`);
        assert.ok(isHeld({ reasonCode: 'confirm_expired', reason: lateReason({ ...base, result: 'cancelled', dialed: false }) }), 'a late cancel keeps the hold');
        assert.equal(finalReport({ ...base, held: false, spoken: 'Leon picked up. The call has ended.' }).reasonCode, '');
        assert.ok(!isHeld(finalReport({ ...base, held: false, spoken: 'Leon picked up. The call has ended.' })), 'no hold, not held');
        for (const code of ['opt_out_hold', 'hold_file_error']) assert.ok(codes.includes(code), `${code} is a module hold code`);
    });

    it('the module prefixes the sidecar must not write under are the ones the module refuses', (t) => {
        if (!existsSync(MODULE_AGENT)) return t.skip('spacetime/src/agent.ts does not exist yet');
        assert.equal(sourceCapture(MODULE_AGENT, /const MODULE_KEY_RE = \/(.+)\/;/, 'MODULE_KEY_RE'), MODULE_EVENT_KEY.source);
        // The sidecar's own keys: `${jobId}:${attempt}:${seq}:${stage}:${status}` (src/pipeline.ts).
        for (const key of ['7:1:1:plan:started', '12:3:9:errand:ok', '1:1:1:search:error']) assert.doesNotMatch(key, MODULE_EVENT_KEY);
        for (const key of ['s8:read:3', 'q12:select', 'c4:dialing', 'e2:submit', 'listen:1']) assert.match(key, MODULE_EVENT_KEY);
    });
});

describe('the contract against the module source', () => {
    it('every reducer the sidecar calls exists with the same arguments in spacetime/src/index.ts', (t) => {
        if (!existsSync(MODULE_INDEX)) return t.skip('spacetime/src/index.ts does not exist yet');
        const source = readFileSync(MODULE_INDEX, 'utf8');
        for (const spec of Object.values(REDUCERS)) {
            const body = objectAfter(source, `export const ${camel(spec.wire)} = spacetimedb.reducer(`);
            assert.ok(body !== null, `${camel(spec.wire)} is not exported from spacetime/src/index.ts`);
            assert.deepEqual(topKeys(body), spec.args.map(camel), `${spec.wire} arguments drifted`);
        }
    });

    it('every view field the sidecar reads exists in spacetime/src/views.ts', (t) => {
        if (!existsSync(MODULE_VIEWS)) return t.skip('spacetime/src/views.ts does not exist yet');
        const source = readFileSync(MODULE_VIEWS, 'utf8');
        for (const view of Object.values(VIEWS)) {
            const rowType = new RegExp(`export const ${camel(view.wire)} = spacetimedb\\.view\\(\\{ public: true \\}, t\\.array\\((\\w+)\\)`).exec(source)?.[1];
            assert.ok(rowType, `${camel(view.wire)} is not exported as a view from spacetime/src/views.ts`);
            const body = objectAfter(source, `const ${rowType} = t.row('${rowType}', `);
            assert.ok(body !== null, `the row type ${rowType} is not in views.ts`);
            const keys = topKeys(body);
            for (const field of view.fields) assert.ok(keys.includes(camel(field)), `${view.wire}.${field} drifted in views.ts`);
        }
    });

    /** The source of one exported view, from its `export const` to the next one. */
    function viewSource(source: string, wire: string): string {
        const start = source.indexOf(`export const ${camel(wire)} = `);
        assert.ok(start >= 0, `${camel(wire)} is not exported from spacetime/src/views.ts`);
        const end = source.indexOf('export const', start + 1);
        return source.slice(start, end < 0 ? undefined : end);
    }

    it('call_queue gives each call the time of its own CONFIRM in spacetime/src/views.ts', (t) => {
        if (!existsSync(MODULE_VIEWS)) return t.skip('spacetime/src/views.ts does not exist yet');
        const view = viewSource(readFileSync(MODULE_VIEWS, 'utf8'), VIEWS.callQueue.wire);
        // The value is the call request's own CONFIRM time, not some other time column.
        assert.match(view, /callId: c\.id,/);
        assert.match(view, /confirmedAt: c\.confirmedAt,/);
    });

    it('agent_consent shows the module\'s memory and web search consent to the Agent only', (t) => {
        if (!existsSync(MODULE_VIEWS)) return t.skip('spacetime/src/views.ts does not exist yet');
        const view = viewSource(readFileSync(MODULE_VIEWS, 'utf8'), VIEWS.agentConsent.wire);
        assert.match(view, /liveRole\(ctx\.db, ctx\.sender\) !== 'Agent'\) return \[\]/);
        assert.match(view, /memoryAllowed: hasConsent\(ctx\.db, 'Memory', ''\)/);
        assert.match(view, /webSearchAllowed: hasConsent\(ctx\.db, 'WebSearch', ''\)/);
    });
});

function filesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });
}

describe('the contract against the generated bindings', () => {
    const skip = 'spacetime/bindings/agent is not generated yet: the adapter is checked against the doc and the module source only';

    it('every reducer the sidecar calls takes its arguments in the contract order', async (t) => {
        if (!existsSync(BINDINGS)) return t.skip(skip);
        for (const spec of Object.values(REDUCERS)) {
            const file = join(BINDINGS, `${spec.wire}_reducer.ts`);
            assert.ok(existsSync(file), `the bindings have no ${spec.wire} reducer`);
            const generated = (await import(pathToFileURL(file).href)) as { default: Record<string, unknown> };
            assert.deepEqual(Object.keys(generated.default), spec.args.map(camel), `${spec.wire} arguments drifted in the bindings`);
        }
    });

    it('every view row the sidecar reads has the columns the adapter needs', async (t) => {
        if (!existsSync(BINDINGS)) return t.skip(skip);
        for (const view of [...Object.values(VIEWS), DEVICE_STATUS]) {
            const file = join(BINDINGS, `${view.wire}_table.ts`);
            assert.ok(existsSync(file), `the bindings have no ${view.wire} table or view`);
            const generated = (await import(pathToFileURL(file).href)) as { default: { row?: Record<string, unknown> } };
            const columns = Object.keys(generated.default.row ?? {});
            assert.ok(columns.length > 0, `${view.wire} has no columns in the bindings`);
            for (const field of view.fields) assert.ok(columns.includes(camel(field)), `${view.wire}.${field} is missing from the bindings`);
        }
    });

    it('the generated index names every view and reducer the sidecar uses', (t) => {
        if (!existsSync(BINDINGS)) return t.skip(skip);
        const text = filesUnder(BINDINGS)
            .filter((file) => file.endsWith('index.ts'))
            .map((file) => readFileSync(file, 'utf8'))
            .join('\n');
        for (const spec of Object.values(REDUCERS)) assert.ok(text.includes(`"${spec.wire}"`), `index.ts does not register ${spec.wire}`);
        for (const view of Object.values(VIEWS)) assert.ok(text.includes(`name: '${view.wire}'`), `index.ts does not register ${view.wire}`);
    });
});
