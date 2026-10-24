// Past requests (src/requests.ts): after a form was actually sent, one private note in Moss under memory consent, so
// the next time the conversation leads to the same form Claude can fill it from last time. The read-back and the
// CONFIRM stay: a note only fills an errand option, and nothing is sent without them.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { MemoryHit } from '@say-when/moss';

import { buildUserMessage, SYSTEM_PROMPT } from '../src/planner/prompt.js';
import type { PlanInput } from '../src/planner/types.js';
import { isPastRequest, NOTE_MAX_CHARS, pastRequestNote, pastRequestQuery } from '../src/requests.js';
import { DEMO_FORM, errandResult, harness, memoryHit, reply, SECRET, settle, waitFor, type Harness } from './helpers.js';

let open: Harness | null = null;
afterEach(async () => {
    await open?.orchestrator.stop(1_000);
    open = null;
});

function start(h: Harness): Harness {
    open = h;
    h.orchestrator.start();
    return h;
}

/** Saturday October 24 2026, 2:10 PM in Los Angeles (the harness time zone). */
const SENT_AT = Date.parse('2026-10-24T21:10:00Z');
const FIELDS = [
    { label: 'Who is this from?', value: 'Alex', source: 'profile' },
    { label: 'What do you need?', value: 'Meal or drink', source: 'conversation' },
    { label: 'Details', value: SECRET.formValue, source: 'conversation' },
];
const ERRAND = { formKey: 'care_team_request', formUrl: 'demo', formTitle: 'Care team request', fieldsJson: JSON.stringify(FIELDS) };
const NOTE = `Past request (Care team request, form care_team_request), sent Sat, Oct 24, 2:10 PM. Fields: {"What do you need?":"Meal or drink","Details":${JSON.stringify(SECRET.formValue)}}`;
/** Another destination that shares the demo form's title (Codex round 1). */
const TWIN = { ...DEMO_FORM, formKey: 'other_team_request', formUrl: 'https://forms.example.org/other' };

/** A YES on an errand option: the module drafted it, the sidecar previews it, and it waits for the CONFIRM. */
async function previewed(h: Harness, errand = ERRAND): Promise<bigint> {
    const { jobId, errandId } = h.db.addPreviewJob(errand);
    await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'preview attached');
    return errandId;
}

async function sent(h: Harness): Promise<bigint> {
    const errandId = await previewed(h);
    h.db.confirmErrand(errandId);
    await waitFor(() => !['confirmed', 'submitting'].includes(h.db.errands.get(errandId)?.status ?? ''), 3_000, 'errand finished');
    await settle(30);
    return errandId;
}

describe('the past request note', () => {
    it('keeps the sent values in structured text, without the fixed fields the app fills', () => {
        const note = pastRequestNote(DEMO_FORM, FIELDS, SENT_AT, 'America/Los_Angeles');
        assert.equal(note, NOTE);
        assert.ok(!note?.includes('Alex'), 'the fixed "from" value is not kept');
        assert.equal(pastRequestQuery(DEMO_FORM), 'Past request (Care team request, form care_team_request)');
        assert.ok(isPastRequest(NOTE));
        assert.ok(isPastRequest(NOTE, DEMO_FORM));
        assert.ok(!isPastRequest(NOTE, TWIN), 'a form with the same title and another key does not match');
        assert.ok(!isPastRequest('Sample note: prefers tea to coffee.'));
    });

    it('keeps lists and yes or no values as they were sent', () => {
        const note = pastRequestNote(DEMO_FORM, [{ label: 'Details', value: ['soup', 'tea'] }, { label: 'When?', value: true }], SENT_AT, 'UTC');
        assert.equal(note, 'Past request (Care team request, form care_team_request), sent Sat, Oct 24, 9:10 PM. Fields: {"Details":["soup","tea"],"When?":true}');
    });

    it('keeps nothing when only fixed fields were sent, or when the note would be too long for Moss', () => {
        assert.equal(pastRequestNote(DEMO_FORM, [FIELDS[0]!], SENT_AT, 'UTC'), null);
        assert.equal(pastRequestNote(DEMO_FORM, [{ label: 'Details', value: 'x'.repeat(NOTE_MAX_CHARS) }], SENT_AT, 'UTC'), null);
    });
});

describe('keeping a past request after a send', () => {
    it('writes one private note when the form was sent under memory consent', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        const errandId = await sent(h);
        assert.equal(h.db.errands.get(errandId)?.status, 'submitted');
        assert.deepEqual(h.memory.notes, [{ text: NOTE, shareable: false }]);
        assert.ok(!h.log.text().includes(SECRET.formValue), 'no field value in a log line');
        assert.ok(h.log.entries.some((e) => e.message === 'past request kept'));
    });

    it('writes nothing without memory consent', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        h.db.revokeConsent('memory');
        const errandId = await sent(h);
        assert.equal(h.db.errands.get(errandId)?.status, 'submitted', 'the form itself is still sent');
        assert.equal(h.memory.notes.length, 0);
    });

    it('writes nothing when memory consent is revoked while the form is sent', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        h.errands.onSubmit = () => h.db.revokeConsent('memory');
        const errandId = await sent(h);
        assert.equal(h.db.errands.get(errandId)?.status, 'submitted');
        assert.equal(h.memory.notes.length, 0);
    });

    it('writes nothing when memory consent comes on only after the CONFIRM', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        h.db.revokeConsent('memory');
        h.errands.onSubmit = () => h.db.grantConsent('memory');
        await sent(h);
        assert.equal(h.memory.notes.length, 0);
    });

    // Security review (consent at the CONFIRM): the consent must be shown to hold from before the CONFIRM to the
    // write without a break, not only at the claim and the write.
    it('writes nothing when memory consent is revoked and given again while the form is sent', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        h.errands.onSubmit = () => {
            h.db.revokeConsent('memory');
            h.db.grantConsent('memory');
        };
        await sent(h);
        assert.equal(h.memory.notes.length, 0);
    });

    it('writes nothing when memory consent was revoked and given again between the preview and the CONFIRM', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        const errandId = await previewed(h);
        h.db.revokeConsent('memory');
        h.db.grantConsent('memory');
        h.db.confirmErrand(errandId);
        await waitFor(() => h.db.errands.get(errandId)?.status === 'submitted', 3_000, 'submitted');
        await settle(30);
        assert.equal(h.memory.notes.length, 0);
    });

    it('writes nothing when memory consent was given only after the CONFIRM, while the sidecar was disconnected', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        h.db.revokeConsent('memory');
        const errandId = await previewed(h);
        h.db.setConnected(false);
        h.db.confirmErrand(errandId);
        h.db.grantConsent('memory');
        h.db.setConnected(true);
        await waitFor(() => h.db.errands.get(errandId)?.status === 'submitted', 3_000, 'submitted');
        await settle(30);
        assert.equal(h.memory.notes.length, 0);
    });

    it('writes nothing when the session changed after the preview', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        const errandId = await previewed(h);
        h.db.sessionId = 2n;
        h.db.confirmErrand(errandId);
        await waitFor(() => h.db.errands.get(errandId)?.status === 'submitted', 3_000, 'submitted');
        await settle(30);
        assert.equal(h.memory.notes.length, 0);
    });

    it('writes nothing after a lost connection between the preview and the write, even with consent on throughout', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        const errandId = await previewed(h);
        h.db.setConnected(false);
        h.db.setConnected(true);
        h.db.confirmErrand(errandId);
        await waitFor(() => h.db.errands.get(errandId)?.status === 'submitted', 3_000, 'submitted');
        await settle(30);
        assert.equal(h.memory.notes.length, 0);
    });

    it('writes nothing when the form was not sent (refused, or an unknown outcome)', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        h.errands.submitResult = errandResult({ status: 'refused', mode: 'submit', refusal: { code: 'captcha', reason: 'The form asks for a CAPTCHA, so I stopped.' } });
        const refused = await sent(h);
        assert.equal(h.db.errands.get(refused)?.status, 'refused');
        h.errands.submitResult = new Error('lost');
        const unknown = await sent(h);
        assert.equal(h.db.errands.get(unknown)?.status, 'unknown_outcome');
        assert.equal(h.memory.notes.length, 0);
    });

    it('writes nothing in the judge try sandbox, even with memory consent', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT, sandbox: true }));
        const errandId = await sent(h);
        assert.equal(h.db.errands.get(errandId)?.status, 'submitted');
        assert.equal(h.memory.notes.length, 0);
    });

    it('writes nothing for a form that is not on the allowed list, or while Moss is closed', async () => {
        const unlisted = start(harness({ now: () => SENT_AT }));
        await sent(unlisted);
        assert.equal(unlisted.memory.notes.length, 0);
        await unlisted.orchestrator.stop(1_000);
        const closed = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        closed.memory.open = false;
        await sent(closed);
        assert.equal(closed.memory.notes.length, 0);
    });

    it('a failed note write never changes the errand result', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        h.memory.noteError = new Error('moss down');
        const errandId = await sent(h);
        assert.equal(h.db.errands.get(errandId)?.status, 'submitted');
        assert.equal(h.errands.submits.length, 1);
        assert.ok(h.log.entries.some((e) => e.message === 'the past request could not be kept'));
    });
});

const NEWEST: MemoryHit = memoryHit(9, {
    id: 'mem:pref:newestrequest',
    type: 'pref',
    partnerId: 'any',
    at: SENT_AT,
    score: 0.9,
    text: NOTE,
    reply: null,
});
const OLDER: MemoryHit = memoryHit(8, {
    id: 'mem:pref:olderrequest',
    type: 'pref',
    partnerId: 'any',
    at: SENT_AT - 86_400_000,
    score: 0.95,
    text: 'Past request (Care team request, form care_team_request), sent Fri, Oct 23, 2:10 PM. Fields: {"Details":"OLDVALUE"}',
    reply: null,
});
const SAME_AGAIN = 'Send the same lunch request as last time.';

function repeatPlan() {
    return {
        answer_mode: 'pick' as const,
        options: [
            reply({ text: 'Nothing else for now.', tone: 'calm' }),
            reply({
                text: SAME_AGAIN,
                kind: 'errand',
                tone: 'warm',
                sources: ['m1'],
                errand: { form_key: 'care_team_request', fields: [{ label: 'What do you need?', value: 'Meal or drink' }, { label: 'Details', value: SECRET.formValue }] },
            }),
        ],
    };
}

async function optionsJob(h: Harness, memoryAllowed = true): Promise<bigint> {
    const jobId = h.db.addOptionsJob({ questionText: 'Lunch like yesterday?', webSearchAllowed: false, memoryAllowed });
    await waitFor(() => ['done', 'failed'].includes(h.db.job(jobId)?.status ?? ''), 3_000, 'options published');
    return jobId;
}

describe('recalling past requests for the plan', () => {
    it('brings the newest past request of each allowed form into the memory context, first', async () => {
        const h = start(harness({ forms: [DEMO_FORM] }));
        h.memory.pastRequestHits = [OLDER, NEWEST];
        h.memory.recallResult = { hits: [OLDER, memoryHit(1)], instant: [`${SECRET.privateMemory} 1`], mossMs: 3, wallMs: 4 };
        h.api.reply(repeatPlan());
        await optionsJob(h);
        assert.ok(h.memory.recalls.some((r) => r.question === 'Past request (Care team request, form care_team_request)'), 'a past-request query by the form name and key');
        const message = h.api.userMessage(0);
        assert.ok(message.includes('m1 (past request, saved Oct 24): '), message);
        assert.ok(message.includes('m2 (past reply'), 'the question recall follows');
        assert.ok(!message.includes('OLDVALUE'), 'an older request of the same form is left out: only the newest is "last time"');
        const recall = h.db.events.find((e) => e.detail === 'memory recall' && e.status === 'ok');
        assert.equal(JSON.parse(recall?.countsJson ?? '{}').pastRequests, 1);
        assert.ok(!(recall?.payloadJson ?? '').includes(SECRET.formValue), 'the note text stays private on the board');
    });

    // Codex round 1: the two queries rank by similarity and can return different notes; the newest of both wins.
    it('takes the newest note of a form from either query', async () => {
        const h = start(harness({ forms: [DEMO_FORM] }));
        h.memory.pastRequestHits = [OLDER];
        h.memory.recallResult = { hits: [NEWEST, memoryHit(1)], instant: [], mossMs: 3, wallMs: 4 };
        h.api.reply(repeatPlan());
        await optionsJob(h);
        const message = h.api.userMessage(0);
        assert.ok(message.includes('m1 (past request, saved Oct 24): '), message);
        assert.ok(!message.includes('OLDVALUE'));
        assert.equal(message.split('past request,').length - 1, 1, 'one note per form');
    });

    // Codex round 1: a past-request query that never answers must not cost the question's own recall.
    it('keeps the question recall when a past-request query hangs', async () => {
        const h = start(harness({ forms: [DEMO_FORM] }));
        h.deps.retrieval.mossDeadlines = { recall: 150 };
        h.memory.pastRequestHang = true;
        h.api.reply({ answer_mode: 'pick', options: [reply({ text: 'Not now.', tone: 'calm' }), reply({ text: 'Maybe later.', tone: 'warm' })] });
        await optionsJob(h);
        const message = h.api.userMessage(0);
        assert.ok(message.includes('m1 (past reply'), message);
        const recall = h.db.events.find((e) => e.detail === 'memory recall' && e.status === 'ok');
        assert.equal(JSON.parse(recall?.countsJson ?? '{}').pastRequests, 0);
    });

    // Codex round 1: two destinations can share a title; one's values must never fill the other.
    it('never uses a note of another form that shares the title', async () => {
        const h = start(harness({ forms: [TWIN] }));
        h.memory.pastRequestHits = [NEWEST];
        h.memory.recallResult = { hits: [NEWEST, memoryHit(1)], instant: [], mossMs: 3, wallMs: 4 };
        h.api.reply({ answer_mode: 'pick', options: [reply({ text: 'Not now.', tone: 'calm' }), reply({ text: 'Maybe later.', tone: 'warm' })] });
        await optionsJob(h);
        assert.ok(!h.api.userMessage(0).includes(SECRET.formValue));
        assert.ok(h.memory.recalls.some((r) => r.question === 'Past request (Care team request, form other_team_request)'));
    });

    it('publishes the memory-filled errand option with the note as its memory source', async () => {
        const h = start(harness({ forms: [DEMO_FORM] }));
        h.memory.pastRequestHits = [NEWEST];
        h.api.reply(repeatPlan());
        await optionsJob(h);
        const published = h.db.publishes.find((p) => p.final);
        const errand = published?.options.find((o) => o.kind === 'errand');
        assert.equal(errand?.text, SAME_AGAIN);
        assert.equal(errand?.provenance, 'memory');
        assert.deepEqual(errand?.memoryRefs, ['mem:pref:newestrequest']);
        const action = JSON.parse(errand?.actionJson ?? '{}') as { fields: { label: string; value: string }[] };
        assert.deepEqual(
            action.fields.map((f) => f.value),
            ['Alex', 'Meal or drink', SECRET.formValue],
        );
    });

    it('looks for no past request without memory consent, or when no form is allowed', async () => {
        const off = start(harness({ forms: [DEMO_FORM] }));
        off.api.reply({ answer_mode: 'pick', options: [reply({ text: 'Not now.', tone: 'calm' }), reply({ text: 'Maybe later.', tone: 'warm' })] });
        await optionsJob(off, false);
        assert.equal(off.memory.recalls.length, 0);
        await off.orchestrator.stop(1_000);
        const none = start(harness());
        none.memory.pastRequestHits = [NEWEST];
        none.api.reply({ answer_mode: 'pick', options: [reply({ text: 'Not now.', tone: 'calm' }), reply({ text: 'Maybe later.', tone: 'warm' })] });
        await optionsJob(none);
        assert.deepEqual(
            none.memory.recalls.map((r) => r.question),
            ['Lunch like yesterday?'],
        );
    });
});

describe('the planner prompt for a repeated errand', () => {
    it('lets an errand option fill from the newest past request, preferring what was said now', () => {
        assert.match(SYSTEM_PROMPT, /past request/);
        assert.match(SYSTEM_PROMPT, /newest past request of that form/);
        assert.match(SYSTEM_PROMPT, /use what was said now/);
        assert.match(SYSTEM_PROMPT, /Send the same lunch request as last time: vegetarian, no nuts, room 412\./);
        assert.match(SYSTEM_PROMPT, /only the listed field labels/);
    });

    it('labels a past request apart from a preference in the memory items', () => {
        const input: PlanInput = {
            question: 'Lunch?',
            origin: 'partner',
            menuItem: 'none',
            history: [],
            memory: [
                { ref: 'm1', id: 'a', type: 'pref', text: NOTE, savedAtMs: SENT_AT },
                { ref: 'm2', id: 'b', type: 'pref', text: 'Likes tea.', savedAtMs: null },
            ],
            web: [],
            forms: [DEMO_FORM],
            contacts: [],
            recentErrand: null,
            search: 'not_needed',
            maxOptions: 4,
            nowMs: SENT_AT,
            timeZone: 'America/Los_Angeles',
        };
        const message = buildUserMessage(input);
        assert.ok(message.includes('m1 (past request, saved Oct 24): '));
        assert.ok(message.includes('m2 (preference): "Likes tea."'));
    });
});

describe('a memory-filled errand still needs the read-back and the CONFIRM', () => {
    it('sends nothing until the person heard the read-back and confirmed it, then sends the memory values once', async () => {
        const h = start(harness({ forms: [DEMO_FORM], now: () => SENT_AT }));
        h.memory.pastRequestHits = [NEWEST];
        h.api.reply(repeatPlan());
        await optionsJob(h);
        const option = h.db.publishes.find((p) => p.final)?.options.find((o) => o.kind === 'errand');
        const action = JSON.parse(option?.actionJson ?? '{}') as { formKey: string; formUrl: string; formTitle: string; fields: unknown[] };

        // The pick drafts the errand; the sidecar previews it. That is a preview, never a send.
        const errandId = await previewed(h, { formKey: action.formKey, formUrl: action.formUrl, formTitle: action.formTitle, fieldsJson: JSON.stringify(action.fields) });
        const errand = h.db.errands.get(errandId);
        assert.equal(errand?.status, 'previewed');
        assert.equal(errand?.readBackText, SECRET.readBack, 'the read-back the person hears is attached');
        await settle(50);
        assert.equal(h.errands.submits.length, 0, 'nothing is sent on the pick, from memory or not');

        // A CONFIRM for a different read-back sends nothing.
        h.db.confirmErrand(errandId, 'ffffffffffffffff');
        await waitFor(() => h.db.errands.get(errandId)?.status === 'refused', 3_000, 'mismatched CONFIRM refused');
        assert.equal(h.errands.submits.length, 0);

        // The same memory-filled errand again, confirmed for the read-back it previewed: sent once.
        const again = await previewed(h, { formKey: action.formKey, formUrl: action.formUrl, formTitle: action.formTitle, fieldsJson: JSON.stringify(action.fields) });
        await settle(30);
        assert.equal(h.errands.submits.length, 0);
        h.db.confirmErrand(again);
        await waitFor(() => h.db.errands.get(again)?.status === 'submitted', 3_000, 'submitted');
        assert.equal(h.errands.submits.length, 1);
        assert.equal(h.errands.submits[0]?.confirm, true);
        assert.equal(h.errands.submits[0]?.confirmDigest, '0123456789abcdef');
        assert.deepEqual(h.errands.submits[0]?.fields, action.fields);
    });
});
