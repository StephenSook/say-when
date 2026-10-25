// What a call says about the sent request (Oct 24 live test: "in demo can it just say what got booked and filled out").
// The form marks which fields may be spoken; the sidecar passes the values of the errand it actually sent, and only
// that one, to the Dialer, which checks them again and owns every word (cartesia/src/call.ts spokenValue).

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import { FormsFileError, loadForms, parseForms } from '../src/forms.js';
import { SentBook, speakableValues, type SentRecord } from '../src/jobs.js';
import type { AllowedForm } from '../src/types.js';
import { DEMO_FORM, errandResult, harness, LEON, SECRET, settle, waitFor, type Harness } from './helpers.js';

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

/** The demo form with the four fields forms.example.json marks speakable. */
const SPEAKING_FORM: AllowedForm = {
    ...DEMO_FORM,
    fields: DEMO_FORM.fields.map((field) => (field.fixedValue === undefined ? { ...field, speak: true } : field)),
};

/** Saturday October 24 2026, 4:30 PM in Los Angeles. */
const SENT_AT = Date.parse('2026-10-24T23:30:00Z');
const FIELDS = [
    { label: 'Who is this from?', value: 'Alex', source: 'profile' },
    { label: 'What do you need?', value: 'Meal or drink', source: 'conversation' },
    { label: 'Details', value: SECRET.formValue, source: 'conversation' },
    { label: 'When?', value: '5 PM', source: 'conversation' },
    { label: 'How urgent?', value: 'Today', source: 'conversation' },
];
const SPOKEN = ['Meal or drink', SECRET.formValue, '5 PM', 'Today'];
const ERRAND = { formKey: 'care_team_request', formUrl: 'demo', formTitle: 'Care team request', fieldsJson: JSON.stringify(FIELDS) };
const RECENT = { title: 'Care team request', sentAtMs: SENT_AT };

const record = (extra: Partial<SentRecord> = {}): SentRecord => ({ errandId: 1n, formKey: 'care_team_request', fields: FIELDS, fromMs: SENT_AT - 300, toMs: SENT_AT + 200, ...extra });

/** A YES on an errand option, the preview, the CONFIRM and the send, as in requests.test.ts. */
async function sent(h: Harness): Promise<bigint> {
    const { jobId, errandId } = h.db.addPreviewJob(ERRAND);
    await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'preview attached');
    h.db.confirmErrand(errandId);
    await waitFor(() => !['confirmed', 'submitting'].includes(h.db.errands.get(errandId)?.status ?? ''), 3_000, 'errand finished');
    await settle(30);
    return errandId;
}

/** Then the person picks Call: the planner offers a call to Leon about the recent request. */
async function callOption(h: Harness, recent: { title: string; sentAtMs: number } = RECENT): Promise<void> {
    h.api.reply({
        answer_mode: 'pick',
        options: [
            { text: 'Not now.', kind: 'reply', tone: 'calm', laugh: false, sources: [], errand: null, call: null },
            { text: 'Call Leonora about it.', kind: 'call', tone: 'warm', laugh: false, sources: [], errand: null, call: { contact_id: 'leon' } },
        ],
    });
    const jobId = h.db.addOptionsJob({ questionText: 'Call', origin: 'menu', menuItem: 'call', recentErrandTitle: recent.title, recentErrandSentAtMs: recent.sentAtMs });
    await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'options done');
}

describe('the speak flag in the forms file', () => {
    it('reads it, and refuses one that is not true or false, by position', () => {
        const forms = parseForms(JSON.stringify([{ ...SPEAKING_FORM, fields: [{ label: 'Details', speak: true }, { label: 'When?', speak: false }, { label: 'Other' }] }]));
        assert.deepEqual(
            forms[0]?.fields.map((f) => f.speak),
            [true, false, undefined],
        );
        assert.throws(
            () => parseForms(JSON.stringify([{ ...SPEAKING_FORM, fields: [{ label: 'Details', speak: 'yes' }] }])),
            (e: unknown) => e instanceof FormsFileError && e.message === 'Form 0 field 0 has a speak flag that is not true or false.',
        );
    });

    it('marks what was asked for, the details, when and how urgent in the example, and never who it is from', () => {
        const [form] = loadForms(fileURLToPath(new URL('../forms.example.json', import.meta.url)));
        assert.deepEqual(
            form?.fields.filter((f) => f.speak).map((f) => f.label),
            ['What do you need?', 'Details', 'When?', 'How urgent?'],
        );
        assert.equal(form?.fields.find((f) => f.fixedValue !== undefined)?.speak, undefined);
    });
});

describe('the sent book', () => {
    it('ties the recent errand to the one send whose window holds its time, allowing five seconds for the clocks', () => {
        const book = new SentBook();
        book.record(record(), SENT_AT);
        assert.equal(book.find(SENT_AT, SENT_AT)?.errandId, 1n);
        assert.equal(book.find(SENT_AT - 300 - 5_000, SENT_AT)?.errandId, 1n);
        assert.equal(book.find(SENT_AT + 200 + 5_000, SENT_AT)?.errandId, 1n);
        assert.equal(book.find(SENT_AT - 300 - 5_001, SENT_AT), null);
        assert.equal(book.find(SENT_AT + 200 + 5_001, SENT_AT), null);
    });

    it('uses no send when two windows hold the time, and forgets sends older than the call window', () => {
        const book = new SentBook();
        book.record(record({ errandId: 1n }), SENT_AT);
        book.record(record({ errandId: 2n, fromMs: SENT_AT + 1_000, toMs: SENT_AT + 1_500 }), SENT_AT + 1_500);
        assert.equal(book.find(SENT_AT + 100, SENT_AT + 2_000), null, 'both windows hold it');
        assert.equal(book.find(SENT_AT + 1_500 + 4_000, SENT_AT + 6_000)?.errandId, 2n);
        assert.equal(book.find(SENT_AT, SENT_AT + 16 * 60_000), null, 'forgotten after fifteen minutes');
    });
});

describe('speakableValues', () => {
    const book = () => {
        const b = new SentBook();
        b.record(record(), SENT_AT);
        return b;
    };

    it('gives the marked fields of the sent errand in form order, joining lists and leaving out yes or no values', () => {
        assert.deepEqual(speakableValues(book(), [SPEAKING_FORM], RECENT, SENT_AT), SPOKEN);
        const b = new SentBook();
        b.record(record({ fields: [{ label: 'how URGENT?', value: 'Now' }, { label: 'Details', value: ['soup', 'tea'] }, { label: 'When?', value: true }] }), SENT_AT);
        assert.deepEqual(speakableValues(b, [SPEAKING_FORM], RECENT, SENT_AT), ['soup, tea', 'Now']);
    });

    it("works for any listed form with marked fields, such as today's plan", () => {
        const planForm: AllowedForm = {
            formKey: 'todays_plan',
            formUrl: 'demo',
            formTitle: "Today's plan",
            fields: [
                { label: 'Who is this from?', fixedValue: 'Demo user' },
                { label: 'The plan', required: true, speak: true },
                { label: 'Ride to book', speak: true },
            ],
        };
        const plan = 'Aquarium at 1. Lunch at the Plant Cafe at noon, step-free entrance. Please book a wheelchair-accessible ride for 11:30.';
        const b = new SentBook();
        const fields = [
            { label: 'Who is this from?', value: 'Demo user', source: 'profile' },
            { label: 'The plan', value: plan },
            { label: 'Ride to book', value: 'Wheelchair-accessible ride, pickup 11:30' },
        ];
        b.record(record({ formKey: 'todays_plan', fields }), SENT_AT);
        assert.deepEqual(speakableValues(b, [SPEAKING_FORM, planForm], { title: "Today's plan", sentAtMs: SENT_AT }, SENT_AT), [plan, 'Wheelchair-accessible ride, pickup 11:30']);
        assert.deepEqual(speakableValues(b, [SPEAKING_FORM, planForm], RECENT, SENT_AT), [], 'the care team title does not match the plan form');
    });

    it('gives nothing without a sent book, a matching send, a listed form, the same title, or a marked field', () => {
        assert.deepEqual(speakableValues(undefined, [SPEAKING_FORM], RECENT, SENT_AT), []);
        assert.deepEqual(speakableValues(new SentBook(), [SPEAKING_FORM], RECENT, SENT_AT), []);
        assert.deepEqual(speakableValues(book(), [SPEAKING_FORM], { ...RECENT, sentAtMs: SENT_AT - 60_000 }, SENT_AT), []);
        assert.deepEqual(speakableValues(book(), [{ ...SPEAKING_FORM, formKey: 'other' }], RECENT, SENT_AT), []);
        assert.deepEqual(speakableValues(book(), [SPEAKING_FORM], { ...RECENT, title: 'Lunch order' }, SENT_AT), []);
        assert.deepEqual(speakableValues(book(), [DEMO_FORM], RECENT, SENT_AT), [], 'no field is marked');
    });
});

describe('a call after a sent errand', () => {
    it('passes the Dialer the speakable values of the errand that was sent, and logs none of them', async () => {
        const h = start(harness({ forms: [SPEAKING_FORM], contacts: [LEON], now: () => SENT_AT }));
        const errandId = await sent(h);
        assert.equal(h.db.errands.get(errandId)?.status, 'submitted');
        await callOption(h);
        assert.equal(h.dialer.prepared.length, 1);
        assert.deepEqual(h.dialer.prepared[0]?.errand, { title: 'Care team request', sentAt: SENT_AT, values: SPOKEN });
        assert.ok(!h.log.text().includes(SECRET.formValue), 'no field value in a log line');
        assert.ok(h.log.entries.some((e) => e.message === 'values for the call message'));
    });

    it('passes no values when the form was not sent', async () => {
        const h = start(harness({ forms: [SPEAKING_FORM], contacts: [LEON], now: () => SENT_AT }));
        h.errands.submitResult = errandResult({ status: 'refused', mode: 'submit', refusal: { code: 'not_allowed', reason: 'No.' } });
        const errandId = await sent(h);
        assert.equal(h.db.errands.get(errandId)?.status, 'refused');
        await callOption(h);
        assert.deepEqual(h.dialer.prepared[0]?.errand, { title: 'Care team request', sentAt: SENT_AT });
    });

    it('passes no values when the recent errand is not the one this sidecar sent', async () => {
        const h = start(harness({ forms: [SPEAKING_FORM], contacts: [LEON], now: () => SENT_AT + 60_000 }));
        await sent(h);
        // The module's recent errand was stamped a minute before this sidecar's send: some other send.
        await callOption(h, { title: 'Care team request', sentAtMs: SENT_AT });
        assert.deepEqual(h.dialer.prepared[0]?.errand, { title: 'Care team request', sentAt: SENT_AT });
    });

    it('passes no values for a form with no field marked speakable', async () => {
        const h = start(harness({ forms: [DEMO_FORM], contacts: [LEON], now: () => SENT_AT }));
        await sent(h);
        await callOption(h);
        assert.deepEqual(h.dialer.prepared[0]?.errand, { title: 'Care team request', sentAt: SENT_AT });
    });
});
