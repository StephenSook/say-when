/**
 * The Email card under the form errand (PLAN D25, components/agents/email.ts): every state comes from the agent's email
 * steps, so the card never shows an email as sent unless the agent reported it sent, and a form that was not sent
 * never shows a sent email. The steps are the ones agent/src/errands.ts and jobs.ts write.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { emailCardView, emailSteps, isEmailStep, maskedAddress } from '../components/agents/email';
import { liveDetail } from '../lib/data/spacetime-map';
import type { Errand, ErrandStatus, PipelineEvent, PipelineStatus } from '../lib/data/types';

const T0 = Date.parse('2026-10-25T08:41:00Z');

function errand(status: ErrandStatus, extra: Partial<Errand> = {}): Errand {
  return {
    id: '7',
    questionId: '3',
    optionId: null,
    form: 'Care team request',
    status,
    previewDigest: '0123456789abcdef',
    readBackText: null,
    readBack: [],
    confirmationText: null,
    screenshotUrl: null,
    confirmClosesAt: null,
    reason: null,
    reasonCode: null,
    confirmCommandId: null,
    stopCommandId: null,
    createdAt: T0,
    previewedAt: T0 + 1_000,
    previewMs: 1_400,
    readAloudAt: null,
    confirmedAt: null,
    sentAt: null,
    endedAt: null,
    ...extra,
  };
}

const DRAFT = { to: 'c***@example.org', subject: 'Care team request: Ride', text: 'Care team request, sent with the Eleven app.\n\nWhat do you need? Ride', draftedAt: '2026-10-25T08:41:01.000Z' };

/** One errand step as the board maps it: the module's or the agent's label, counts and (shared) payload. */
function step(n: number, status: PipelineStatus, label: string, opts: { key?: string; counts?: object; payload?: object | null } = {}): PipelineEvent {
  const detail = liveDetail(
    'errand',
    status,
    { detail: label, countsJson: JSON.stringify(opts.counts ?? {}), eventKey: opts.key ?? `90:1:${n}:errand:${status}` },
    opts.payload === null || opts.payload === undefined ? null : JSON.stringify(opts.payload),
  );
  return { id: String(n), sessionId: '1', questionId: '3', stage: 'errand', status, detail, ms: status === 'started' ? null : 10, at: T0 + n * 1_000 };
}

const drafted = (payload: object | null = { email: DRAFT }) => step(1, 'ok', 'email drafted', { counts: { errandId: 7 }, payload });
const sending = () => step(5, 'started', 'email sending', { key: 'e7:email:sending', counts: { errandId: 7 }, payload: { email: DRAFT } });

describe('the Email card', () => {
  test('no card when the agent drafted no email for the errand (the feature is off)', () => {
    const preview = step(1, 'ok', 'preview previewed', { counts: { errandId: 7 } });
    assert.equal(emailCardView(errand('awaiting_confirm'), [preview]), null);
    // Another errand's email is not this errand's.
    assert.equal(emailCardView(errand('awaiting_confirm', { id: '8' }), [drafted()]), null);
  });

  test('Drafted: subject, masked address and body, and it waits for the form', () => {
    const view = emailCardView(errand('awaiting_confirm'), [drafted()]);
    assert.ok(view);
    assert.deepEqual([view.state, view.word, view.status], ['drafted', 'Drafted', 'not_started']);
    assert.equal(view.sentence, 'Drafted. It goes to the care team only after the form is sent.');
    assert.deepEqual([view.to, view.subject, view.shared], ['c***@example.org', 'Care team request: Ride', true]);
    assert.match(view.body ?? '', /What do you need\? Ride/);
    assert.equal(view.draftedAt, T0 + 1_000);
    assert.equal(view.sentAt, null);
  });

  test('Sending, then Sent with its time', () => {
    const view = emailCardView(errand('sent'), [drafted(), sending()]);
    assert.deepEqual([view?.state, view?.word, view?.status, view?.sendingSince], ['sending', 'Sending', 'working', T0 + 5_000]);
    const sentAt = '2026-10-25T08:42:10.000Z';
    const sent = step(6, 'ok', 'email sent', { key: 'e7:email:sent', counts: { errandId: 7, mailMs: 1_200 }, payload: { email: { ...DRAFT, outcome: 'sent', sentAt } } });
    const done = emailCardView(errand('sent'), [sent, drafted(), sending()]);
    assert.deepEqual([done?.state, done?.word, done?.status], ['sent', 'Sent', 'done']);
    assert.equal(done?.sentAt, Date.parse(sentAt));
    assert.equal(done?.sentence, 'Sent to the care team after the form was sent.');
  });

  test('an email step is told apart from the form\'s own steps (Live data times the form without it)', () => {
    assert.equal(isEmailStep(step(6, 'ok', 'email sent', { key: 'e7:email:sent' })), true);
    assert.equal(isEmailStep(step(6, 'ok', 'sent', { key: 'e7:submitted' })), false);
    assert.equal(isEmailStep(step(6, 'ok', 'preview previewed')), false);
  });

  test('a module step is tied to its errand by its key, without a payload', () => {
    const sent = step(6, 'ok', 'email sent', { key: 'e7:email:sent' });
    assert.equal(sent.stage === 'errand' ? sent.detail.errandId : null, '7');
    assert.equal(emailSteps(errand('sent'), [sent]).length, 1);
  });

  test('Failed, Outcome unknown and Not sent (duplicate), each with its sentence', () => {
    const failed = step(6, 'error', 'email failed: http_402', {
      key: 'e7:email:failed',
      counts: { errandId: 7, maybeSent: false },
      payload: { email: { ...DRAFT, outcome: 'failed', reason: 'The email service needs credit, so no email was sent.' } },
    });
    const f = emailCardView(errand('sent'), [drafted(), sending(), failed]);
    assert.deepEqual([f?.state, f?.word, f?.status, f?.sentence], ['failed', 'Failed', 'failed', 'The email service needs credit, so no email was sent.']);

    const unknown = step(6, 'error', 'email unknown: timeout', { key: 'e7:email:failed', counts: { errandId: 7, maybeSent: true } });
    const u = emailCardView(errand('sent'), [drafted(), sending(), unknown]);
    assert.deepEqual([u?.state, u?.word, u?.sentence], ['unknown', 'Outcome unknown', 'The email may or may not have gone out. It was not sent again.']);

    const duplicate = step(6, 'error', 'email not sent: duplicate', { key: 'e7:email:failed', counts: { errandId: 7, notSent: true } });
    const d = emailCardView(errand('sent'), [drafted(), duplicate]);
    assert.deepEqual([d?.state, d?.word, d?.status], ['not_sent', 'Not sent', 'stopped']);
  });

  test('a form that was not sent never shows a sent email', () => {
    for (const status of ['stopped', 'refused', 'failed'] as const) {
      const view = emailCardView(errand(status, { endedAt: T0 + 9_000 }), [drafted()]);
      assert.deepEqual([view?.state, view?.word, view?.sentence], ['not_sent', 'Not sent', 'Not sent, because the form was not sent.'], status);
    }
    const unknown = emailCardView(errand('unknown_outcome'), [drafted()]);
    assert.deepEqual([unknown?.state, unknown?.sentence], ['not_sent', 'Not sent: it is not known whether the form went through, so no email went out.']);
  });

  test('a sent form whose email has not reported yet stays Drafted, and says so', () => {
    const view = emailCardView(errand('sent'), [drafted()]);
    assert.deepEqual([view?.state, view?.sentence], ['drafted', 'The form was sent. The email has not reported back yet.']);
  });

  test('with sharing off the card shows the state only; an unmasked address and phone numbers never reach it', () => {
    const hidden = emailCardView(errand('awaiting_confirm'), [drafted(null)]);
    assert.deepEqual([hidden?.state, hidden?.shared, hidden?.to, hidden?.subject, hidden?.body], ['drafted', false, null, null, null]);
    const leaky = emailCardView(errand('awaiting_confirm'), [drafted({ email: { to: 'stephen@gmail.com', subject: 'Call me at 415 555 0199', text: 'Number 415 555 0199' } })]);
    assert.equal(leaky?.to, 's***@gmail.com');
    assert.ok(!(leaky?.subject ?? '').includes('555 0199'));
    assert.ok(!(leaky?.body ?? '').includes('555 0199'));
    assert.equal(maskedAddress('c***@example.org'), 'c***@example.org');
    assert.equal(maskedAddress(''), null);
  });
});
