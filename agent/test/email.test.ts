// PLAN D25: the care team email after a sent form. Drafted with the read-back, sent once through Apify's Send Email
// Actor only after the module took the errand's submitted result, never for a form that was not sent, and shown with
// a masked address only. No test reaches Apify: the mail port and fetch are fakes.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { UnknownOutcomeError } from '@say-when/apify-client';

import { readConfig } from '../src/config.js';
import {
    apifyMail,
    draftEmail,
    EmailBook,
    isEmailAddress,
    maskEmail,
    readBackWithEmail,
    type ErrandEmailDeps,
    type MailMessage,
    type MailOutcome,
    type MailPort,
} from '../src/email.js';
import { DEMO_FORM, errandResult, harness, SECRET, settle, waitFor, type Harness } from './helpers.js';

const ADDRESS = 'care.team@example.org';
const MASKED = 'c***@example.org';
/** Sun Oct 25 2026, 1:41 AM in Los Angeles. */
const NOW = Date.parse('2026-10-25T08:41:00Z');

class FakeMail implements MailPort {
    readonly sent: MailMessage[] = [];
    outcome: MailOutcome = { status: 'sent', ms: 1_200 };
    onSend: (() => void) | null = null;

    async send(message: MailMessage): Promise<MailOutcome> {
        this.sent.push(structuredClone(message));
        this.onSend?.();
        return this.outcome;
    }
}

function emailDeps(mail: MailPort): ErrandEmailDeps {
    return { to: ADDRESS, mail, book: new EmailBook(), forms: [DEMO_FORM], timeZone: 'America/Los_Angeles', now: () => NOW, clock: () => performance.now() };
}

const READ_BACK_TEXT = `To Care team request. What do you need?: Ride. Details: ${SECRET.formValue}. Confirm to send.`;
const FIELDS = JSON.stringify([
    { label: 'What do you need?', value: 'Ride', source: 'conversation' },
    { label: 'Details', value: SECRET.formValue, source: 'conversation' },
]);
const ERRAND = { formKey: 'care_team_request', formUrl: 'demo', formTitle: 'Care team request', fieldsJson: FIELDS };

let open: Harness | null = null;
afterEach(async () => {
    await open?.orchestrator.stop(1_000);
    open = null;
});

function start(mail: FakeMail | null): Harness {
    const h = harness({ forms: [DEMO_FORM], ...(mail ? { email: emailDeps(mail) } : {}) });
    h.errands.previewResult = errandResult({
        readBack: [
            { label: 'What do you need?', value: 'Ride', matchedBy: 'label' },
            { label: 'Details', value: SECRET.formValue, matchedBy: 'label' },
        ],
        readBackText: READ_BACK_TEXT,
    });
    open = h;
    h.orchestrator.start();
    return h;
}

async function previewed(h: Harness): Promise<bigint> {
    const { jobId, errandId } = h.db.addPreviewJob(ERRAND);
    await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'preview attached');
    return errandId;
}

/** Everything public or logged, as text: the events (labels, counts, payloads) and every log line. */
function everything(h: Harness): string {
    return JSON.stringify(h.db.events, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)) + h.log.text();
}

const emailEvents = (h: Harness) => h.db.events.filter((e) => e.detail.startsWith('email '));

describe('the care team email (PLAN D25)', () => {
    it('is off when ERRAND_EMAIL_TO is not set: the read-back is the Actor\'s own and no email step is written', async () => {
        const h = start(null);
        const errandId = await previewed(h);
        assert.equal(h.db.errands.get(errandId)?.readBackText, READ_BACK_TEXT);
        h.db.confirmErrand(errandId);
        await waitFor(() => h.db.errands.get(errandId)?.status === 'submitted', 3_000, 'submitted');
        await settle(30);
        assert.deepEqual(emailEvents(h), []);
        assert.equal(h.db.attempted.filter((a) => a.name === 'agentErrandEmail').length, 0);
    });

    it('is drafted with the read-back, which then says it emails the care team; nothing is sent yet', async () => {
        const mail = new FakeMail();
        const h = start(mail);
        const errandId = await previewed(h);
        assert.equal(h.db.errands.get(errandId)?.readBackText, READ_BACK_TEXT.replace('Confirm to send.', 'Confirm to send it and email the care team.'));
        const drafted = h.db.events.find((e) => e.detail === 'email drafted');
        assert.ok(drafted, 'an email drafted step');
        assert.equal(drafted.stage, 'errand');
        assert.equal(drafted.status, 'ok');
        assert.deepEqual(JSON.parse(drafted.countsJson), { errandId: Number(errandId) });
        const payload = JSON.parse(drafted.payloadJson) as { email: { to: string; subject: string; text: string } };
        assert.equal(payload.email.to, MASKED);
        assert.equal(payload.email.subject, 'Care team request: Ride');
        assert.match(payload.email.text, /What do you need\? Ride/);
        assert.match(payload.email.text, /Requested: Sun, Oct 25, 1:41 AM PDT\./);
        assert.match(payload.email.text, /sent both on their behalf/);
        await settle(40);
        assert.equal(mail.sent.length, 0, 'nothing is sent before the CONFIRM');
        assert.ok(!everything(h).includes(ADDRESS), 'the full address never reaches an event or a log line');
    });

    it('is sent once, right after the module took the submitted result, and its steps show a masked address', async () => {
        const mail = new FakeMail();
        const h = start(mail);
        const errandId = await previewed(h);
        let sendingFirst = false;
        mail.onSend = () => {
            sendingFirst = h.db.errands.get(errandId)?.status === 'submitted' && h.db.events.some((e) => e.eventKey === `e${errandId}:email:sending`);
        };
        h.db.confirmErrand(errandId);
        await waitFor(() => h.db.events.some((e) => e.eventKey === `e${errandId}:email:sent`), 3_000, 'email sent step');
        assert.equal(mail.sent.length, 1);
        assert.equal(mail.sent[0]?.to, ADDRESS, 'the real address goes only to the mail port');
        assert.equal(mail.sent[0]?.subject, 'Care team request: Ride');
        assert.ok(sendingFirst, 'the form was Submitted and the sending step written before the email went');
        const sent = h.db.events.find((e) => e.eventKey === `e${errandId}:email:sent`);
        assert.equal(sent?.status, 'ok');
        assert.equal(sent?.detail, 'email sent');
        assert.equal(JSON.parse(sent?.countsJson ?? '{}').mailMs, 1_200);
        const payload = JSON.parse(sent?.payloadJson ?? '{}') as { email: { to: string; outcome: string; sentAt: string } };
        assert.deepEqual([payload.email.to, payload.email.outcome, payload.email.sentAt], [MASKED, 'sent', new Date(NOW).toISOString()]);
        assert.equal(h.db.events.find((e) => e.eventKey === `e${errandId}:email:sending`)?.status, 'started');
        assert.ok(!everything(h).includes(ADDRESS), 'the full address never reaches an event or a log line');
        // Later changes to the views never send it again.
        h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await settle(50);
        assert.equal(mail.sent.length, 1);
    });

    it('is never sent when the confirmed digest is not the previewed one (refused, nothing sent)', async () => {
        const mail = new FakeMail();
        const h = start(mail);
        const errandId = await previewed(h);
        h.db.confirmErrand(errandId, 'ffffffffffffffff');
        await waitFor(() => h.db.errands.get(errandId)?.status === 'refused', 3_000, 'refused');
        await settle(40);
        assert.equal(mail.sent.length, 0);
        assert.equal(emailEvents(h).filter((e) => e.detail !== 'email drafted').length, 0);
    });

    it('is never sent when the form was refused or its outcome is unknown', async () => {
        for (const [status, result] of [
            ['unknown_outcome', new UnknownOutcomeError('click_uncertain')],
            ['refused', errandResult({ status: 'refused', refusal: { code: 'no_confirmation', reason: 'No confirmation page, so I stopped.' } })],
        ] as const) {
            const mail = new FakeMail();
            const h = start(mail);
            h.errands.submitResult = result;
            const errandId = await previewed(h);
            h.db.confirmErrand(errandId);
            await waitFor(() => h.db.errands.get(errandId)?.status === status, 3_000, status);
            await settle(40);
            assert.equal(mail.sent.length, 0, `no email when the errand is ${status}`);
            assert.equal(h.db.attempted.filter((a) => a.name === 'agentErrandEmail').length, 0);
            await h.orchestrator.stop(1_000);
        }
    });

    it('is never sent when the person never confirmed (stopped or cancelled before the CONFIRM)', async () => {
        const mail = new FakeMail();
        const h = start(mail);
        const errandId = await previewed(h);
        const errand = h.db.errands.get(errandId);
        assert.ok(errand);
        errand.status = 'stopped';
        h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await settle(60);
        assert.equal(mail.sent.length, 0);
    });

    it('sends no second email for a duplicate, and says so', async () => {
        const mail = new FakeMail();
        const h = start(mail);
        h.errands.submitResult = errandResult({ status: 'duplicate', mode: 'submit', confirmationText: 'Already received.' });
        const errandId = await previewed(h);
        h.db.confirmErrand(errandId);
        await waitFor(() => h.db.events.some((e) => e.eventKey === `e${errandId}:email:failed`), 3_000, 'not sent step');
        assert.equal(mail.sent.length, 0);
        const step = h.db.events.find((e) => e.eventKey === `e${errandId}:email:failed`);
        assert.equal(step?.detail, 'email not sent: duplicate');
        assert.equal(JSON.parse(step?.countsJson ?? '{}').notSent, true);
    });

    it('reports a failed or unknown send, and never sends it again', async () => {
        for (const [outcome, detail, maybeSent] of [
            [{ status: 'failed', code: 'http_402', ms: 300 }, 'email failed: http_402', false],
            [{ status: 'unknown', code: 'timeout', ms: 40_000 }, 'email unknown: timeout', true],
        ] as const) {
            const mail = new FakeMail();
            mail.outcome = outcome;
            const h = start(mail);
            const errandId = await previewed(h);
            h.db.confirmErrand(errandId);
            await waitFor(() => h.db.events.some((e) => e.eventKey === `e${errandId}:email:failed`), 3_000, detail);
            const step = h.db.events.find((e) => e.eventKey === `e${errandId}:email:failed`);
            assert.equal(step?.status, 'error');
            assert.equal(step?.detail, detail);
            assert.equal(JSON.parse(step?.countsJson ?? '{}').maybeSent, maybeSent);
            assert.equal(h.db.errands.get(errandId)?.status, 'submitted', 'the email never changes the errand');
            await settle(40);
            assert.equal(mail.sent.length, 1, 'never retried');
            await h.orchestrator.stop(1_000);
        }
    });

    it('still sends the email when the module cannot show its steps (agent_errand_email not published)', async () => {
        const mail = new FakeMail();
        const h = harness({ forms: [DEMO_FORM], email: emailDeps(mail) });
        h.errands.previewResult = errandResult({ readBackText: READ_BACK_TEXT });
        h.db.failNext('agentErrandEmail', 'internal', { times: 10 });
        open = h;
        h.orchestrator.start();
        const errandId = await previewed(h);
        h.db.confirmErrand(errandId);
        await waitFor(() => mail.sent.length === 1, 3_000, 'email sent');
        await settle(30);
        assert.match(h.log.text(), /agent_errand_email is not published there/);
        assert.equal(h.db.errands.get(errandId)?.status, 'submitted');
    });
});

describe('the email pieces', () => {
    it('checks and masks an address', () => {
        assert.equal(isEmailAddress('stephen@gmail.com'), true);
        assert.equal(isEmailAddress('a@b.co'), true);
        assert.equal(isEmailAddress('two@a.com, three@b.com'), false);
        assert.equal(isEmailAddress('no-at-sign.com'), false);
        assert.equal(isEmailAddress('x@localhost'), false);
        assert.equal(maskEmail('stephen@gmail.com'), 's***@gmail.com');
        assert.equal(maskEmail('@bad'), '***');
    });

    it('adds the email to the read-back', () => {
        assert.equal(readBackWithEmail('To Care team request. Details: x. Confirm to send.'), 'To Care team request. Details: x. Confirm to send it and email the care team.');
        assert.equal(readBackWithEmail('Some other read-back.'), 'Some other read-back. Sending it also emails the care team.');
    });

    it('drafts the subject from the first field with choices, and the body from the values read back', () => {
        const { subject, text } = draftEmail({
            formTitle: 'Care team request',
            readBack: [
                { label: 'Who is this from?', value: 'Alex', matchedBy: 'label' },
                { label: 'What do you need?', value: 'Meal or drink', matchedBy: 'label' },
                { label: 'When?', value: '', matchedBy: 'label' },
            ],
            form: DEMO_FORM,
            nowMs: NOW,
            timeZone: 'America/Los_Angeles',
        });
        assert.equal(subject, 'Care team request: Meal or drink');
        assert.match(text, /^Care team request, sent with the Eleven app\./);
        assert.match(text, /Who is this from\? Alex\nWhat do you need\? Meal or drink\nWhen\? \(blank\)/);
        assert.match(text, /heard these values read back and confirmed them/);
        assert.equal(draftEmail({ formTitle: 'Care team request', readBack: [], nowMs: NOW, timeZone: 'UTC' }).subject, 'Care team request');
    });

    it('drops a draft once taken, so it can never be sent twice', () => {
        const book = new EmailBook();
        book.record({ errandId: 7n, digest: '0123456789abcdef', to: ADDRESS, toMasked: MASKED, subject: 's', text: 't', draftedAtMs: NOW });
        assert.ok(book.take(7n));
        assert.equal(book.take(7n), undefined);
    });
});

describe('apify/send-mail through the Apify API', () => {
    type Seen = { url: string; init: RequestInit };
    const fake = (respond: (seen: Seen) => Promise<Response>) => {
        const calls: Seen[] = [];
        return {
            calls,
            fetch: async (url: string, init?: RequestInit) => {
                const seen = { url, init: init ?? {} };
                calls.push(seen);
                return respond(seen);
            },
        };
    };
    const message = { to: ADDRESS, subject: 'Care team request: Ride', text: 'Body' };

    it('starts one run of apify~send-mail with the token in the header and to, subject and text in the body', async () => {
        const f = fake(async () => new Response(JSON.stringify({ data: { id: 'run1', status: 'SUCCEEDED' } }), { status: 201 }));
        const outcome = await apifyMail({ token: 'apify_api_TEST', fetch: f.fetch }).send(message);
        assert.equal(outcome.status, 'sent');
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0]?.url, 'https://api.apify.com/v2/acts/apify~send-mail/runs?waitForFinish=30');
        assert.equal(f.calls[0]?.init.method, 'POST');
        assert.equal(f.calls[0]?.init.redirect, 'error');
        assert.equal((f.calls[0]?.init.headers as Record<string, string>).Authorization, 'Bearer apify_api_TEST');
        assert.ok(!f.calls[0]?.url.includes('token'), 'the token is never in the URL');
        assert.deepEqual(JSON.parse(String(f.calls[0]?.init.body)), message);
    });

    it('maps a refused start to failed, a run still going or a server error to unknown, and never retries', async () => {
        const cases: [Response, MailOutcome['status'], string][] = [
            [new Response('{"error":{"type":"not-enough-usage-to-run-paid-actor"}}', { status: 402 }), 'failed', 'http_402'],
            [new Response('{}', { status: 401 }), 'failed', 'http_401'],
            [new Response('{}', { status: 502 }), 'unknown', 'http_502'],
            [new Response(JSON.stringify({ data: { status: 'RUNNING' } }), { status: 201 }), 'unknown', 'still_running'],
            // A run that started and then failed, was aborted or timed out may already have sent it.
            [new Response(JSON.stringify({ data: { status: 'FAILED' } }), { status: 201 }), 'unknown', 'run_failed'],
            [new Response(JSON.stringify({ data: { status: 'ABORTED' } }), { status: 201 }), 'unknown', 'run_failed'],
            [new Response(JSON.stringify({ data: { status: 'TIMED-OUT' } }), { status: 201 }), 'unknown', 'run_failed'],
            [new Response('not json', { status: 201 }), 'unknown', 'bad_response'],
        ];
        for (const [response, status, code] of cases) {
            const f = fake(async () => response);
            const outcome = await apifyMail({ token: 't', fetch: f.fetch }).send(message);
            assert.deepEqual([outcome.status, 'code' in outcome ? outcome.code : ''], [status, code]);
            assert.equal(f.calls.length, 1, 'never retried');
        }
    });

    it('maps a connection refused to failed and a timeout to unknown', async () => {
        const refused = fake(async () => {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        });
        assert.deepEqual(await apifyMail({ token: 't', fetch: refused.fetch }).send(message).then((o) => [o.status, 'code' in o ? o.code : '']), ['failed', 'network']);
        const hang = fake(
            ({ init }) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                }),
        );
        const outcome = await apifyMail({ token: 't', fetch: hang.fetch, timeoutMs: 20 }).send(message);
        assert.deepEqual([outcome.status, 'code' in outcome ? outcome.code : ''], ['unknown', 'timeout']);
    });
});

describe('ERRAND_EMAIL_TO', () => {
    const VALUES = {
        ANTHROPIC_API_KEY: 'sk-ant-SECRETVALUE-123',
        APIFY_TOKEN: 'apify_api_SECRETVALUE',
        FORM_ERRAND_URL: 'https://secret-standby.apify.actor',
        SPACETIMEDB_DB: 'say-when-demo',
    };
    const TOKEN_FILE = join(tmpdir(), 'neurolingo-agent-test-no-token');
    const check = (checks: { name: string; state: string; note: string }[]) => checks.find((c) => c.name === 'ERRAND_EMAIL_TO');

    it('turns the email on, and shows the address only masked', () => {
        const { config, checks, problems } = readConfig({ ...VALUES, ERRAND_EMAIL_TO: ADDRESS }, TOKEN_FILE);
        assert.deepEqual(problems, []);
        assert.equal(config.email.to, ADDRESS);
        assert.equal(check(checks)?.state, 'set');
        assert.ok(!JSON.stringify(checks).includes(ADDRESS));
        assert.match(check(checks)?.note ?? '', /c\*\*\*@example\.org/);
    });

    it('is off when unset, in the try sandbox, or without errands; a malformed value stops the start without echoing it', () => {
        assert.equal(readConfig(VALUES, TOKEN_FILE).config.email.to, null);
        const sandbox = readConfig({ ...VALUES, SPACETIMEDB_DB: 'say-when-try', AGENT_TRY: 'on', ERRAND_EMAIL_TO: ADDRESS }, TOKEN_FILE);
        assert.equal(sandbox.config.email.to, null);
        assert.match(check(sandbox.checks)?.note ?? '', /try sandbox/);
        const { FORM_ERRAND_URL: _url, ...noErrands } = VALUES;
        assert.equal(readConfig({ ...noErrands, ERRAND_EMAIL_TO: ADDRESS }, TOKEN_FILE).config.email.to, null);
        const bad = readConfig({ ...VALUES, ERRAND_EMAIL_TO: 'secret-person@, other@x.com' }, TOKEN_FILE);
        assert.equal(bad.config.email.to, null);
        assert.deepEqual(bad.problems, ['ERRAND_EMAIL_TO must be one email address.']);
        assert.ok(!JSON.stringify(bad).includes('secret-person'));
    });
});
