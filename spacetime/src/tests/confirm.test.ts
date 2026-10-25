// Consent is a row (D12 item 3): a form leaves the room only after the full read-back, a quiet hold, inside the
// confirm window, with good contact and the digest the person heard, once. Then one digest-checked claim.
import { expect, test } from 'vitest';
import * as m from '../index';
import { onceAt } from '../util';
import {
  advance,
  AGENT,
  as,
  auth,
  CALL_DIGEST,
  callOption,
  claim,
  errandOption,
  failure,
  FORM_KEY,
  gesture,
  grantConsent,
  internal,
  live,
  micros,
  newDb,
  now,
  OWNER,
  question,
  reply,
  scan,
  scanning,
  settle,
  STATION,
  timerAt,
  type Test,
} from './harness';

const DIGEST = 'a1b2c3d4e5f60718';

function errandOf(db: Test) {
  const rows = [...db.db.errand.errandBySession.filter(scan(db).sessionId)];
  return rows[rows.length - 1]!;
}

function callOf(db: Test) {
  const rows = [...db.db.callRequest.callBySession.filter(scan(db).sessionId)];
  return rows[rows.length - 1]!;
}

/** Picks the errand option and attaches the Actor's preview: the errand is Previewed. */
function previewed(db: Test) {
  grantConsent(db, 'errand', FORM_KEY);
  const q = scanning(db, [errandOption(), reply('Nothing else')]);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick_errand');
  expect(question(db, q.id).status.tag).toBe('Acting');
  const e = errandOf(db);
  expect(e.status.tag).toBe('Drafted');
  const job = claim(db, q.id, 'ErrandPreview');
  as(db, AGENT, (ctx) =>
    m.agentAttachPreview(ctx, {
      jobId: job.id,
      attempt: job.attempt,
      status: 'previewed',
      formTitle: 'Care team request',
      readBackText: 'Request: Lunch, please.',
      readBackJson: '[{"label":"Request","value":"Lunch, please"}]',
      previewDigest: DIGEST,
      screenshotUrl: '',
      reasonCode: '',
      reason: '',
      previewMs: 4200,
    }),
  );
  expect(db.db.agentJob.id.find(job.id)!.status.tag).toBe('Done');
  return errandOf(db);
}

/** The station read the errand back: AwaitingConfirm, the quiet hold running. */
function awaiting(db: Test) {
  const e = previewed(db);
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'errand', id: e.id, digest: DIGEST }));
  return errandOf(db);
}

function confirmTimer(db: Test, errandId: bigint) {
  return [...db.db.errandLease.errandId.filter(errandId)].find((r) => r.kind.tag === 'ConfirmWindow');
}

test('without Errand consent for the form, picking the errand refuses it at once', () => {
  const db = newDb();
  scanning(db, [errandOption()]);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick_errand');
  const e = errandOf(db);
  expect([e.status.tag, e.reasonCode]).toEqual(['Refused', 'no_consent']);
  expect([...db.db.agentJob.jobByStatus.filter({ tag: 'Pending' })].filter((j) => j.kind.tag === 'ErrandPreview')).toHaveLength(0);
});

test('a picked errand is Drafted with a preview job, and the preview makes it Previewed with a read-back timer', () => {
  const db = newDb();
  const e = previewed(db);
  expect(e.status.tag).toBe('Previewed');
  expect([e.previewDigest, e.readBackText, e.previewMs]).toEqual([DIGEST, 'Request: Lunch, please.', 4200]);
  const timers = [...db.db.errandLease.errandId.filter(e.id)].map((r) => r.kind.tag);
  expect(timers).toEqual(['Readback']);
});

test('YES during the read-back is not a confirm, and CONFIRM before the read-back is done is ignored', () => {
  const db = newDb();
  previewed(db);
  settle(db);
  expect(gesture(db, 'YES').outcome).toBe('ignored:yes_is_not_confirm');
  settle(db);
  expect(gesture(db, 'CONFIRM', { heardDigest: DIGEST }).outcome).toBe('ignored:readback_not_done');
  expect(errandOf(db).status.tag).toBe('Previewed');
});

test('a read-back report with the wrong digest throws: the station played a stale read-back', () => {
  const db = newDb();
  const e = previewed(db);
  expect(failure(() => as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'errand', id: e.id, digest: 'ffffffffffffffff' })))).toContain('digest mismatch');
  expect(errandOf(db).status.tag).toBe('Previewed');
});

test('the read-back opens the confirm window after the quiet hold', () => {
  const db = newDb();
  const e = awaiting(db);
  expect(e.status.tag).toBe('AwaitingConfirm');
  expect(micros(e.confirmOpensAt) - micros(now(db))).toBe(1_000_000n); // quiet_hold_ms
  expect(micros(e.confirmClosesAt) - micros(e.confirmOpensAt)).toBe(8_000_000n); // confirm_window_ms
  expect(e.windowSeq).toBe(1);
  const t = confirmTimer(db, e.id)!;
  expect(t.seq).toBe(1);
  expect(micros(timerAt(t))).toBe(micros(e.confirmClosesAt));
});

test('CONFIRM inside the quiet hold is ignored and the hold restarts', () => {
  const db = newDb();
  const before = awaiting(db);
  advance(db, 1500); // past refractory, but the clench began 800 ms ago: inside the hold
  const g = gesture(db, 'CONFIRM', { heardDigest: DIGEST, onsetAgeMs: 800 });
  expect(g.outcome).toBe('ignored:quiet_hold');
  const after = errandOf(db);
  expect(after.status.tag).toBe('AwaitingConfirm');
  expect(after.windowSeq).toBe(before.windowSeq + 1);
  expect(micros(after.confirmOpensAt) - micros(now(db))).toBe(1_000_000n);
  expect(confirmTimer(db, after.id)!.seq).toBe(after.windowSeq);
});

test('CONFIRM after the window closed is ignored, and the window timer stops the errand', () => {
  const db = newDb();
  const e = awaiting(db);
  advance(db, 9001);
  expect(gesture(db, 'CONFIRM', { heardDigest: DIGEST }).outcome).toBe('ignored:window_closed');
  // Read harness state before opening a transaction: `db.db` inside `withReducerTx` deadlocks the test datastore.
  const window = confirmTimer(db, e.id)!;
  internal(db, (ctx) => m.errandTimeout(ctx, { job: window }));
  const stopped = errandOf(db);
  expect([stopped.status.tag, stopped.reasonCode]).toEqual(['Stopped', 'window_closed']);
});

test('a stale CONFIRM that arrives after the window closed never reopens it, whatever its onset age', () => {
  const db = newDb();
  const e = awaiting(db);
  const window = confirmTimer(db, e.id)!;
  advance(db, 9001); // the window closed at +9 s; its timer has not run yet
  // The clench began at the read-back's end, inside the quiet hold, but it arrives after the close.
  expect(gesture(db, 'CONFIRM', { heardDigest: DIGEST, onsetAgeMs: 9001 }).outcome).toBe('ignored:window_closed');
  const after = errandOf(db);
  expect([after.status.tag, after.windowSeq, micros(after.confirmClosesAt)]).toEqual(['AwaitingConfirm', e.windowSeq, micros(e.confirmClosesAt)]);
  expect(confirmTimer(db, e.id)!.scheduledId).toBe(window.scheduledId); // no new window was armed
  internal(db, (ctx) => m.errandTimeout(ctx, { job: window }));
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['Stopped', 'window_closed']);
});

test('CONFIRM with a digest the person did not hear is refused', () => {
  const db = newDb();
  awaiting(db);
  live(db, 1500);
  expect(gesture(db, 'CONFIRM', { heardDigest: 'ffffffffffffffff' }).outcome).toBe('ignored:digest_mismatch');
  expect(errandOf(db).status.tag).toBe('AwaitingConfirm');
});

test('CONFIRM without good contact on the latest heartbeat is refused', () => {
  const db = newDb();
  awaiting(db);
  live(db, 1500);
  for (const l of [...db.db.livenessLease.sessionId.filter(scan(db).sessionId)]) {
    db.db.livenessLease.scheduledId.update({ ...l, decoderHealthy: false });
  }
  expect(gesture(db, 'CONFIRM', { heardDigest: DIGEST }).outcome).toBe('ignored:no_contact');
});

test('CONFIRM after consent was revoked is refused (and the revoke already stopped the errand)', () => {
  const db = newDb();
  awaiting(db);
  live(db, 1500);
  const row = [...db.db.consent.consentByScope.filter({ tag: 'Errand' })][0]!;
  db.db.consent.id.update({ ...row, revokedAt: now(db) }); // revoked behind the reducer's back
  expect(gesture(db, 'CONFIRM', { heardDigest: DIGEST }).outcome).toBe('ignored:no_consent');
});

test('a valid CONFIRM confirms once; a second CONFIRM finds nothing to confirm, and a retried id is a no-op', () => {
  const db = newDb();
  awaiting(db);
  live(db, 1500);
  const g = gesture(db, 'CONFIRM', { heardDigest: DIGEST, gestureId: 'confirm-1' });
  expect(g.outcome).toBe('accepted:confirm');
  const e = errandOf(db);
  expect([e.status.tag, e.confirmedDigest, e.confirmGestureId]).toEqual(['Confirmed', DIGEST, 'confirm-1']);
  expect(confirmTimer(db, e.id)).toBeUndefined();
  gesture(db, 'CONFIRM', { heardDigest: DIGEST, gestureId: 'confirm-1' }); // retry: nothing new
  expect([...db.db.gestureLog.gestureBySession.filter(scan(db).sessionId)].filter((r) => r.gestureId === 'confirm-1')).toHaveLength(1);
  settle(db);
  expect(gesture(db, 'CONFIRM', { heardDigest: DIGEST }).outcome).toBe('ignored:nothing_to_confirm');
});

test('a CONFIRM replayed after its session was purged is refused, so it can never release a new errand', () => {
  const db = newDb();
  awaiting(db);
  live(db, 1500);
  expect(gesture(db, 'CONFIRM', { heardDigest: DIGEST, gestureId: 'confirm-a' }).outcome).toBe('accepted:confirm');
  const first = scan(db).sessionId;
  as(db, STATION, (ctx) => m.endSession(ctx, {}));
  as(db, OWNER, (ctx) => m.purgeSession(ctx, { sessionId: first }));
  expect(db.db.gestureLog.gestureId.find('confirm-a')).toBeNull();
  expect(db.db.spentGesture.gestureId.find('confirm-a')?.gestureId).toBe('confirm-a');
  // A new session with the same errand (same digest), read back and waiting inside its window.
  as(db, STATION, (ctx) => m.startSession(ctx, { label: 'demo' }));
  live(db, 500);
  const e = awaiting(db);
  expect(scan(db).sessionId).not.toBe(first);
  live(db, 1500);
  expect(failure(() => gesture(db, 'CONFIRM', { heardDigest: DIGEST, gestureId: 'confirm-a' }))).toBe('gesture_id was already used');
  expect(errandOf(db).status.tag).toBe('AwaitingConfirm');
  expect(gesture(db, 'CONFIRM', { heardDigest: DIGEST, gestureId: 'confirm-b' }).outcome).toBe('accepted:confirm');
  expect(errandOf(db).id).toBe(e.id);
});

test('NO or STOP while waiting for the confirm stops the errand: nothing is sent', () => {
  const db = newDb();
  awaiting(db);
  advance(db, 1500);
  expect(gesture(db, 'NO').outcome).toBe('accepted:stop_errand');
  const e = errandOf(db);
  expect([e.status.tag, e.reasonCode]).toEqual(['Stopped', 'no']);
  expect(e.stopGestureId).not.toBe('');

  const db2 = newDb();
  previewed(db2);
  expect(gesture(db2, 'STOP').outcome).toBe('accepted:stop_errand');
  expect(errandOf(db2).status.tag).toBe('Stopped');
});

test('a preview that arrives after STOP leaves the errand stopped and finishes the job', () => {
  const db = newDb();
  grantConsent(db, 'errand', FORM_KEY);
  const q = scanning(db, [errandOption()]);
  gesture(db, 'YES');
  const job = claim(db, q.id, 'ErrandPreview');
  expect(gesture(db, 'STOP').outcome).toBe('accepted:stop_errand');
  // STOP cancelled the preview job, so the late preview is refused as stale.
  expect(
    failure(() =>
      as(db, AGENT, (ctx) =>
        m.agentAttachPreview(ctx, { jobId: job.id, attempt: job.attempt, status: 'previewed', formTitle: '', readBackText: 'x', readBackJson: '', previewDigest: DIGEST, screenshotUrl: '', reasonCode: '', reason: '', previewMs: 1 }),
      ),
    ),
  ).toBe('stale attempt');
  expect(errandOf(db).status.tag).toBe('Stopped');
});

test('the read-back and preview deadlines stop or fail a waiting errand', () => {
  const db = newDb();
  const e = previewed(db);
  const readback = [...db.db.errandLease.errandId.filter(e.id)].find((r) => r.kind.tag === 'Readback')!;
  internal(db, (ctx) => m.errandTimeout(ctx, { job: readback }));
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['Stopped', 'readback_not_finished']);

  const db2 = newDb();
  grantConsent(db2, 'errand', FORM_KEY);
  scanning(db2, [errandOption()]);
  gesture(db2, 'YES');
  const e2 = errandOf(db2);
  const preview = [...db2.db.errandLease.errandId.filter(e2.id)].find((r) => r.kind.tag === 'Preview')!;
  expect(micros(timerAt(preview)) - micros(now(db2))).toBe(60_000_000n);
  internal(db2, (ctx) => m.errandTimeout(ctx, { job: preview }));
  expect([errandOf(db2).status.tag, errandOf(db2).reasonCode]).toEqual(['Failed', 'preview_timeout']);
});

/** A Confirmed errand. */
function confirmed(db: Test) {
  awaiting(db);
  live(db, 1500);
  expect(gesture(db, 'CONFIRM', { heardDigest: DIGEST }).outcome).toBe('accepted:confirm');
  return errandOf(db);
}

test('claim_errand refuses the wrong digest and anything not Confirmed', () => {
  const db = newDb();
  const e = previewed(db);
  expect(failure(() => as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST })))).toBe('errand is not confirmed');
  const db2 = newDb();
  const e2 = confirmed(db2);
  expect(failure(() => as(db2, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e2.id, digest: 'ffffffffffffffff' })))).toBe('digest mismatch');
  expect(failure(() => as(db2, STATION, (ctx) => m.claimErrand(ctx, { errandId: e2.id, digest: DIGEST })))).toBe('not allowed');
});

test('the agent claims a confirmed errand once and completes it', () => {
  const db = newDb();
  const e = confirmed(db);
  as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST }));
  const sub = errandOf(db);
  expect([sub.status.tag, sub.claimAttempt]).toEqual(['Submitting', 1]);
  const lease = [...db.db.errandLease.errandId.filter(e.id)].find((r) => r.kind.tag === 'Submit')!;
  expect([lease.seq, micros(timerAt(lease)) - micros(now(db))]).toEqual([1, 60_000_000n]);
  expect(failure(() => as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST })))).toBe('errand is not confirmed');
  as(db, AGENT, (ctx) =>
    m.completeErrand(ctx, { errandId: e.id, attempt: 1, status: 'submitted', confirmationText: 'Your response has been recorded.', screenshotUrl: '', reasonCode: '', reason: '', submitMs: 3100 }),
  );
  const done = errandOf(db);
  expect([done.status.tag, done.confirmationText, done.submitMs]).toEqual(['Submitted', 'Your response has been recorded.', 3100]);
});

/** One `agent_errand_email` call as the agent (PLAN D25). */
function email(db: Test, errandId: bigint, status: string, detail: string, extra: { attempt?: number; payloadJson?: string; countsJson?: string } = {}) {
  return as(db, AGENT, (ctx) =>
    m.agentErrandEmail(ctx, { errandId, attempt: extra.attempt ?? 1, status, detail, ms: 12, countsJson: extra.countsJson ?? '{}', payloadJson: extra.payloadJson ?? '' }),
  );
}

test('agent_errand_email writes the email steps only for a Submitted errand claimed by this agent (PLAN D25)', () => {
  const db = newDb();
  const e = confirmed(db);
  // Not claimed yet, then claimed but still Submitting: no email step.
  expect(failure(() => email(db, e.id, 'started', 'email sending'))).toBe('stale attempt');
  as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST }));
  expect(failure(() => email(db, e.id, 'started', 'email sending'))).toBe('errand is not sent');
  as(db, AGENT, (ctx) =>
    m.completeErrand(ctx, { errandId: e.id, attempt: 1, status: 'submitted', confirmationText: 'Recorded.', screenshotUrl: '', reasonCode: '', reason: '', submitMs: 10 }),
  );
  // The wrong attempt, another caller, a detail that is not an email step, and an unknown status are refused.
  expect(failure(() => email(db, e.id, 'started', 'email sending', { attempt: 2 }))).toBe('stale attempt');
  expect(failure(() => as(db, STATION, (ctx) => m.agentErrandEmail(ctx, { errandId: e.id, attempt: 1, status: 'ok', detail: 'email sent', ms: 1, countsJson: '{}', payloadJson: '' })))).toBe('not allowed');
  expect(failure(() => email(db, e.id, 'ok', 'sent'))).toBe('detail must start with email');
  expect(failure(() => email(db, e.id, 'ok', 'email Sent'))).toBe('bad detail');
  expect(failure(() => email(db, e.id, 'done', 'email sent'))).toBe('status must be started, ok or error');
  expect(failure(() => email(db, e.id, 'ok', 'email sent', { countsJson: '{"to":"a sentence"}' }))).toBe('counts_json values must be numbers or booleans');

  email(db, e.id, 'started', 'email sending', { payloadJson: '{"email":{"to":"s***@example.com"}}' });
  email(db, e.id, 'ok', 'email sent', { countsJson: '{"mailMs":2400}', payloadJson: '{"email":{"to":"s***@example.com","subject":"Care team request: Ride"}}' });
  // A repeat of a step is a no-op: one row per step.
  email(db, e.id, 'ok', 'email sent');
  const sent = db.db.pipelineEvent.eventKey.find(`e${e.id}:email:sent`)!;
  expect([sent.stage, sent.status, sent.detail, sent.actor, sent.questionId, sent.countsJson]).toEqual(['errand', 'ok', 'email sent', 'Agent', e.questionId, '{"mailMs":2400}']);
  expect(db.db.pipelineEvent.eventKey.find(`e${e.id}:email:sending`)?.status).toBe('started');
  const payload = db.db.pipelinePayload.eventId.find(sent.id)!;
  expect(JSON.parse(payload.payloadJson)).toEqual({ email: { to: 's***@example.com', subject: 'Care team request: Ride' } });
  const ledger = [...db.db.ledger.ledgerBySession.filter(scan(db).sessionId)].filter((l) => l.kind === 'errand_email').map((l) => l.outcome);
  expect(ledger).toEqual(['sending', 'sent']);
  // The errand itself is unchanged.
  expect([errandOf(db).status.tag, errandOf(db).confirmationText]).toEqual(['Submitted', 'Recorded.']);
});

test('agent_errand_email is refused for an errand that ended without being sent', () => {
  const db = newDb();
  const e = confirmed(db);
  as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST }));
  as(db, AGENT, (ctx) =>
    m.completeErrand(ctx, { errandId: e.id, attempt: 1, status: 'failed', confirmationText: '', screenshotUrl: '', reasonCode: 'no_confirmation', reason: '', submitMs: 10 }),
  );
  expect(failure(() => email(db, e.id, 'error', 'email failed: timeout'))).toBe('errand is not sent');
  expect(db.db.pipelineEvent.eventKey.find(`e${e.id}:email:failed`) ?? null).toBeNull();
});

test('a lapsed submit lease becomes UnknownOutcome; nothing can claim it again; a late true result is recorded', () => {
  const db = newDb();
  const e = confirmed(db);
  as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST }));
  const lease = [...db.db.errandLease.errandId.filter(e.id)].find((r) => r.kind.tag === 'Submit')!;
  advance(db, 60_000);
  internal(db, (ctx) => m.errandTimeout(ctx, { job: lease }));
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['UnknownOutcome', 'lease_lapsed']);
  expect(failure(() => as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST })))).toBe('errand is not confirmed');
  expect(
    failure(() =>
      as(db, AGENT, (ctx) => m.completeErrand(ctx, { errandId: e.id, attempt: 2, status: 'submitted', confirmationText: '', screenshotUrl: '', reasonCode: '', reason: '', submitMs: 1 })),
    ),
  ).toBe('stale attempt');
  as(db, AGENT, (ctx) =>
    m.completeErrand(ctx, { errandId: e.id, attempt: 1, status: 'submitted', confirmationText: 'Recorded.', screenshotUrl: '', reasonCode: '', reason: '', submitMs: 61_000 }),
  );
  expect(errandOf(db).status.tag).toBe('Submitted');
  const kinds = [...db.db.ledger.ledgerBySession.filter(scan(db).sessionId)].map((l) => l.kind);
  expect(kinds).toContain('late_result');
});

test('an agent result reported as unknown is UnknownOutcome, never a resubmit', () => {
  const db = newDb();
  const e = confirmed(db);
  as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST }));
  as(db, AGENT, (ctx) => m.completeErrand(ctx, { errandId: e.id, attempt: 1, status: 'unknown', confirmationText: '', screenshotUrl: '', reasonCode: '', reason: '', submitMs: 0 }));
  expect(errandOf(db).status.tag).toBe('UnknownOutcome');
  expect(failure(() => as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST })))).toBe('errand is not confirmed');
});

test('complete_errand stores a listed reason code, and the board shows no outside sentence while sharing is off', () => {
  const db = newDb();
  const e = confirmed(db);
  as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST }));
  as(db, AGENT, (ctx) =>
    m.completeErrand(ctx, { errandId: e.id, attempt: 1, status: 'refused', confirmationText: '', screenshotUrl: '', reasonCode: 'Digest Mismatch', reason: 'The form for Jane Doe changed.', submitMs: 10 }),
  );
  const done = errandOf(db);
  expect([done.status.tag, done.reasonCode]).toEqual(['Refused', 'digest_mismatch']);
  const board = m.boardErrands(db.anonymousViewContext())[0]!;
  expect([board.reasonCode, board.reason]).toEqual(['digest_mismatch', '']);

  // A code that is not on the list is stored as the outcome's own word.
  const db2 = newDb();
  const e2 = confirmed(db2);
  as(db2, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e2.id, digest: DIGEST }));
  as(db2, AGENT, (ctx) =>
    m.completeErrand(ctx, { errandId: e2.id, attempt: 1, status: 'failed', confirmationText: '', screenshotUrl: '', reasonCode: 'jane doe form', reason: '', submitMs: 10 }),
  );
  expect([errandOf(db2).status.tag, errandOf(db2).reasonCode]).toEqual(['Failed', 'failed']);
});

test("a call report's code that is not on the list is stored as a module word", () => {
  const db = newDb();
  const c = connectedCall(db);
  as(db, AGENT, (ctx) =>
    m.reportCallStatus(ctx, { callId: c.id, attempt: 1, status: 'failed', result: 'failed', endReason: '', reasonCode: 'Jane Doe hung up', reason: '' }),
  );
  expect([callOf(db).status.tag, callOf(db).reasonCode]).toEqual(['Failed', 'call_failed']);
  const ledger = [...db.db.ledger.ledgerBySession.filter(scan(db).sessionId)].filter((l) => l.kind === 'call');
  for (const l of ledger) expect(l.reason).not.toContain('jane');
});

test('a submit timer armed for another attempt does nothing', () => {
  const db = newDb();
  const e = confirmed(db);
  as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST }));
  const lease = [...db.db.errandLease.errandId.filter(e.id)].find((r) => r.kind.tag === 'Submit')!;
  advance(db, 60_000);
  internal(db, (ctx) => m.errandTimeout(ctx, { job: { ...lease, seq: lease.seq + 1 } }));
  expect(errandOf(db).status.tag).toBe('Submitting');
});

test('while a submit is in flight, YES does not open the menu, and NO or STOP are too late', () => {
  const db = newDb();
  const e = confirmed(db);
  as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST }));
  settle(db);
  expect(gesture(db, 'YES').outcome).toBe('ignored:busy');
  expect(scan(db).phase.tag).toBe('Idle');
  settle(db);
  expect(gesture(db, 'NO').outcome).toBe('ignored:too_late');
  expect(gesture(db, 'STOP').outcome).toBe('ignored:too_late');
  expect(errandOf(db).status.tag).toBe('Submitting');
});

test('claim_errand refuses once the dead-man deadline passed, even before its timer ran', () => {
  const db = newDb();
  const e = confirmed(db);
  advance(db, 1500); // the newest lease (from the last beat) has just run out; liveness_expired has not run
  expect(failure(() => as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST })))).toBe('no contact');
  expect(errandOf(db).status.tag).toBe('Confirmed');
  // The timer (or the next heartbeat) then voids it, so nothing ever leaves the room.
  const lease = [...db.db.livenessLease.sessionId.filter(scan(db).sessionId)][0]!;
  internal(db, (ctx) => m.livenessExpired(ctx, { job: lease }));
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['Stopped', 'headset_lost']);
});

test('claim_errand refuses once the idle deadline passed, even before the idle timer ran', () => {
  const db = newDb();
  as(db, OWNER, (ctx) => m.setTiming(ctx, { json: JSON.stringify({ idle_pause_ms: 30000 }) }));
  const e = confirmed(db); // the CONFIRM re-armed the idle timer 30 s ahead
  live(db, 30_000); // heartbeats keep contact good; no command for 30 s
  expect(failure(() => as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST })))).toBe('idle deadline passed');
  expect(errandOf(db).status.tag).toBe('Confirmed');
});

test('claim_errand refuses while the session is paused or after it ended', () => {
  const db = newDb();
  const e = confirmed(db);
  // Paused behind the reducers' back, so the errand is still Confirmed: the claim must still refuse.
  const s = scan(db);
  db.db.scanState.sessionId.update({ ...s, phase: { tag: 'Paused' }, pauseReason: { tag: 'Operator' } });
  expect(failure(() => as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST })))).toBe('session paused');
  db.db.scanState.sessionId.update(s);
  const session = db.db.session.id.find(s.sessionId)!;
  db.db.session.id.update({ ...session, endedAt: now(db) });
  expect(failure(() => as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST })))).toBe('session ended');
});

test('claim_call refuses once the dead-man deadline passed', () => {
  const db = newDb();
  grantConsent(db, 'call', 'leon');
  scanning(db, [callOption(db)]);
  gesture(db, 'YES');
  const c = callOf(db);
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'call', id: c.id, digest: CALL_DIGEST }));
  live(db, 1500);
  expect(gesture(db, 'CONFIRM', { heardDigest: CALL_DIGEST }).outcome).toBe('accepted:confirm');
  advance(db, 1500);
  expect(failure(() => as(db, AGENT, (ctx) => m.claimCall(ctx, { callId: c.id, digest: CALL_DIGEST })))).toBe('no contact');
  expect(callOf(db).status.tag).toBe('Confirmed');
});

test('a confirmed errand nobody has claimed is voided by a pause', () => {
  const db = newDb();
  confirmed(db);
  expect(gesture(db, 'HEADSET_OFF').outcome).toBe('accepted:pause');
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['Stopped', 'headset_off']);
});

test('a new partner question stops an errand nobody has claimed yet', () => {
  const db = newDb();
  awaiting(db);
  as(db, 'partner', (ctx) => m.askQuestion(ctx, { requestId: 'interrupt-1', text: 'Are you cold?', via: 'typed', listenMs: 0 }));
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['Stopped', 'interrupted']);
});

test('a call is prepared on the pick, confirmed after its read-back, claimed once, and STOP hangs up', () => {
  const db = newDb();
  grantConsent(db, 'call', 'leon');
  scanning(db, [callOption(db)]);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick_call');
  const c = callOf(db);
  expect([c.status.tag, c.contactName, c.scriptDigest]).toEqual(['Prepared', 'Leon', CALL_DIGEST]);
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'call', id: c.id, digest: CALL_DIGEST }));
  live(db, 1500);
  expect(gesture(db, 'CONFIRM', { heardDigest: CALL_DIGEST }).outcome).toBe('accepted:confirm');
  expect(callOf(db).status.tag).toBe('Confirmed');
  expect(failure(() => as(db, AGENT, (ctx) => m.claimCall(ctx, { callId: c.id, digest: 'ffffffffffffffff' })))).toBe('digest mismatch');
  as(db, AGENT, (ctx) => m.claimCall(ctx, { callId: c.id, digest: CALL_DIGEST }));
  expect([callOf(db).status.tag, callOf(db).claimAttempt]).toEqual(['Dialing', 1]);
  as(db, AGENT, (ctx) => m.reportCallStatus(ctx, { callId: c.id, attempt: 1, status: 'connected', result: '', endReason: '', reasonCode: '', reason: '' }));
  as(db, AGENT, (ctx) => m.addCallLine(ctx, { callId: c.id, attempt: 1, lineKey: 'line-1', role: 'assistant', text: 'Hello, this is Eleven.' }));
  as(db, AGENT, (ctx) => m.addCallLine(ctx, { callId: c.id, attempt: 1, lineKey: 'line-1', role: 'assistant', text: 'Hello, this is Eleven.' }));
  expect([...db.db.callLine.callId.filter(c.id)]).toHaveLength(1); // a retry of the same line_key
  settle(db);
  expect(gesture(db, 'STOP').outcome).toBe('accepted:hang_up');
  expect([callOf(db).cancelRequested, callOf(db).cancelReason]).toEqual([true, 'stop']);
  as(db, AGENT, (ctx) => m.reportCallStatus(ctx, { callId: c.id, attempt: 1, status: 'ended', result: 'cancelled', endReason: 'hangup', reasonCode: '', reason: '' }));
  expect([callOf(db).status.tag, callOf(db).result]).toEqual(['Ended', 'cancelled']);
  // A line for a call that has ended is dropped quietly.
  as(db, AGENT, (ctx) => m.addCallLine(ctx, { callId: c.id, attempt: 1, lineKey: 'line-2', role: 'recipient', text: 'Bye.' }));
  expect([...db.db.callLine.callId.filter(c.id)]).toHaveLength(1);
});

test('a call option without consent for the contact is refused at the pick', () => {
  const db = newDb();
  scanning(db, [callOption(db, 'call-2', 'stranger')]);
  gesture(db, 'YES');
  expect([callOf(db).status.tag, callOf(db).reasonCode]).toEqual(['Refused', 'no_consent']);
});

// ---------- Review round 2: deadlines decided by elapsed time, not by which timer ran first ----------

test('a CONFIRM after the idle deadline, before its timer ran, finds the idle pause applied: nothing is confirmed', () => {
  const db = newDb();
  as(db, OWNER, (ctx) => m.setTiming(ctx, { json: JSON.stringify({ idle_pause_ms: 30000 }) }));
  const e = previewed(db); // the YES that picked the errand set the idle deadline 30 s ahead
  live(db, 25_000);
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'errand', id: e.id, digest: DIGEST }));
  live(db, 5_100); // the window is open; the idle deadline passed 100 ms ago and idle_pause has not run
  const session = db.db.session.id.find(scan(db).sessionId)!;
  expect(gesture(db, 'CONFIRM', { heardDigest: DIGEST }).outcome).toBe('ignored:paused');
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['Stopped', 'idle']);
  expect([scan(db).phase.tag, scan(db).pauseReason?.tag]).toEqual(['Paused', 'Idle']);
  // The deadline was not pushed forward: no new idle timer, the same fence.
  expect([...db.db.idleTimer.sessionId.filter(session.id)]).toHaveLength(0);
  expect(db.db.session.id.find(session.id)!.idleSeq).toBe(session.idleSeq);
  expect(failure(() => as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST })))).toBe('errand is not confirmed');
});

test('a YES after the idle deadline, before its timer ran, resumes instead of picking, so no reply is released', () => {
  const db = newDb(); // the idle deadline is 120 s after the session started
  live(db, 118_000);
  const q = scanning(db);
  live(db, 2_010); // option 1 is still being read; the deadline passed 10 ms ago and idle_pause has not run
  expect(gesture(db, 'YES', { heardStepSeq: scan(db).stepSeq }).outcome).toBe('accepted:resume');
  const s = scan(db);
  expect([s.phase.tag, s.cursor, s.pickedOptionId]).toEqual(['Reading', 1, undefined]); // option 1 again, from its start
  expect(question(db, q.id).status.tag).toBe('Scanning');
  const kinds = [...db.db.ledger.ledgerBySession.filter(s.sessionId)].map((l) => [l.kind, l.outcome]);
  expect(kinds).toContainEqual(['pause', 'idle']);
});

test('a veto whose tick finds the idle pause due pauses instead of releasing the reply', () => {
  const db = newDb();
  const q = scanning(db);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick');
  // Move the idle deadline behind the veto's end (only a very late tick could see this in practice).
  const sid = scan(db).sessionId;
  for (const r of [...db.db.idleTimer.sessionId.filter(sid)]) {
    db.db.idleTimer.scheduledId.update({ ...r, scheduledAt: onceAt(now(db)) });
  }
  const veto = [...db.db.scanTimer.sessionId.filter(sid)].find((r) => r.kind.tag === 'VetoEnd')!;
  db.clock.set(timerAt(veto));
  internal(db, (ctx) => m.scanTick(ctx, { job: veto }));
  expect([scan(db).phase.tag, scan(db).pauseReason?.tag]).toEqual(['Paused', 'Idle']);
  expect(question(db, q.id).status.tag).toBe('Scanning'); // not Released
});

test('a read-back reported after its deadline is refused, and the timer then stops the errand', () => {
  const db = newDb();
  const e = previewed(db);
  const readback = [...db.db.errandLease.errandId.filter(e.id)].find((r) => r.kind.tag === 'Readback')!;
  live(db, 30_000); // the read-back deadline has passed; errand_timeout has not run
  expect(failure(() => as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'errand', id: e.id, digest: DIGEST })))).toBe('read-back deadline passed');
  expect([errandOf(db).status.tag, confirmTimer(db, e.id)]).toEqual(['Previewed', undefined]);
  internal(db, (ctx) => m.errandTimeout(ctx, { job: readback }));
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['Stopped', 'readback_not_finished']);
});

test('a preview after its deadline is refused as stale, and the timer then fails the errand', () => {
  const db = newDb();
  grantConsent(db, 'errand', FORM_KEY);
  const q = scanning(db, [errandOption()]);
  gesture(db, 'YES');
  const e = errandOf(db);
  const preview = [...db.db.errandLease.errandId.filter(e.id)].find((r) => r.kind.tag === 'Preview')!;
  live(db, 30_000);
  const job = claim(db, q.id, 'ErrandPreview'); // its own lease runs to +75 s, past the preview deadline
  live(db, 30_000); // the 60 s preview deadline has passed; errand_timeout has not run
  expect(
    failure(() =>
      as(db, AGENT, (ctx) =>
        m.agentAttachPreview(ctx, { jobId: job.id, attempt: job.attempt, status: 'previewed', formTitle: '', readBackText: 'Request: Lunch.', readBackJson: '', previewDigest: DIGEST, screenshotUrl: '', reasonCode: '', reason: '', previewMs: 1 }),
      ),
    ),
  ).toBe('stale attempt');
  expect(errandOf(db).status.tag).toBe('Drafted');
  internal(db, (ctx) => m.errandTimeout(ctx, { job: preview }));
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['Failed', 'preview_timeout']);
  expect(db.db.agentJob.id.find(job.id)!.status.tag).toBe('Cancelled');
});

test('a call read-back reported after its deadline is refused', () => {
  const db = newDb();
  grantConsent(db, 'call', 'leon');
  scanning(db, [callOption(db)]);
  gesture(db, 'YES');
  const c = callOf(db);
  live(db, 30_000);
  expect(failure(() => as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'call', id: c.id, digest: CALL_DIGEST })))).toBe('read-back deadline passed');
  expect(callOf(db).status.tag).toBe('Prepared');
});

/** A call the agent claimed and the Dialer connected. */
function connectedCall(db: Test) {
  grantConsent(db, 'call', 'leon');
  scanning(db, [callOption(db)]);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick_call');
  const c = callOf(db);
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'call', id: c.id, digest: CALL_DIGEST }));
  live(db, 1500);
  expect(gesture(db, 'CONFIRM', { heardDigest: CALL_DIGEST }).outcome).toBe('accepted:confirm');
  as(db, AGENT, (ctx) => m.claimCall(ctx, { callId: c.id, digest: CALL_DIGEST }));
  as(db, AGENT, (ctx) => m.reportCallStatus(ctx, { callId: c.id, attempt: 1, status: 'connected', result: '', endReason: '', reasonCode: '', reason: '' }));
  expect(callOf(db).status.tag).toBe('Connected');
  return callOf(db);
}

/** Mid-call, the partner asks something else and the person picks an errand option: it waits for its preview. */
function errandDuringCall(db: Test) {
  grantConsent(db, 'errand', FORM_KEY);
  scanning(db, [errandOption()]); // a new partner question: it supersedes, but leaves the live call alone
  live(db, 1001); // past refractory, with the station still beating
  expect(gesture(db, 'YES', { heardStepSeq: scan(db).stepSeq }).outcome).toBe('accepted:pick_errand');
  expect(errandOf(db).status.tag).toBe('Drafted');
}

test('STOP during a call hangs it up even when an errand picked during the call is waiting, and stops that too', () => {
  const db = newDb();
  const call = connectedCall(db);
  errandDuringCall(db);
  expect(gesture(db, 'STOP').outcome).toBe('accepted:stop_errand_hang_up');
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['Stopped', 'stop']);
  const after = db.db.callRequest.id.find(call.id)!;
  expect([after.status.tag, after.cancelRequested, after.cancelReason]).toEqual(['Connected', true, 'stop']);
});

test('with a call connected, a passed idle deadline voids nothing, so the confirm and the claim still go through', () => {
  const db = newDb();
  as(db, OWNER, (ctx) => m.setTiming(ctx, { json: JSON.stringify({ idle_pause_ms: 30000 }) }));
  connectedCall(db);
  errandDuringCall(db);
  const job = claim(db, errandOf(db).questionId, 'ErrandPreview');
  as(db, AGENT, (ctx) =>
    m.agentAttachPreview(ctx, { jobId: job.id, attempt: job.attempt, status: 'previewed', formTitle: '', readBackText: 'Request: Lunch.', readBackJson: '', previewDigest: DIGEST, screenshotUrl: '', reasonCode: '', reason: '', previewMs: 1 }),
  );
  live(db, 25_000);
  const e = errandOf(db);
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'errand', id: e.id, digest: DIGEST }));
  live(db, 5_000); // the idle deadline (30 s after the YES) has passed, but `idle_pause` would only re-arm
  expect(gesture(db, 'CONFIRM', { heardDigest: DIGEST }).outcome).toBe('accepted:confirm');
  live(db, 30_000); // the next idle deadline passes too
  as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST }));
  expect(errandOf(db).status.tag).toBe('Submitting');
});

test('STOP during a reply veto while a call is connected hangs the call up and still cancels the reply', () => {
  const db = newDb();
  const call = connectedCall(db);
  const q = scanning(db); // a partner question mid-call, with three replies
  live(db, 1001);
  expect(gesture(db, 'YES', { heardStepSeq: scan(db).stepSeq }).outcome).toBe('accepted:pick');
  expect(scan(db).phase.tag).toBe('Veto');
  expect(gesture(db, 'STOP').outcome).toBe('accepted:stop_reply_hang_up');
  expect(db.db.callRequest.id.find(call.id)!.cancelRequested).toBe(true);
  expect([scan(db).phase.tag, question(db, q.id).status.tag, question(db, q.id).replyText]).toEqual(['Idle', 'Stopped', undefined]);
});

test('STOP while options are read during a call hangs the call up and ends the scan: none of these', () => {
  const db = newDb();
  const call = connectedCall(db);
  const q = scanning(db);
  expect(gesture(db, 'STOP').outcome).toBe('accepted:none_hang_up');
  expect(db.db.callRequest.id.find(call.id)!.cancelRequested).toBe(true);
  expect(question(db, q.id).status.tag).toBe('None');
});

test('one call at a time: a call picked during a live call is refused, a second cannot be claimed, and STOP hangs up every live call', () => {
  const db = newDb();
  const a = connectedCall(db);
  grantConsent(db, 'call', 'mia');
  scanning(db, [callOption(db, 'call-mia', 'mia')]);
  live(db, 1001);
  expect(gesture(db, 'YES', { heardStepSeq: scan(db).stepSeq }).outcome).toBe('accepted:pick_call');
  const b = callOf(db);
  expect([b.status.tag, b.reasonCode, b.reason]).toEqual(['Refused', 'line_busy', 'A call is already in progress. No call was made.']);
  // A second Confirmed call, written behind the reducers' back, still cannot be claimed while A is on the line.
  const ghost = db.db.callRequest.insert({ ...a, id: 0n, requestId: 'call-ghost', status: { tag: 'Confirmed' }, claimAttempt: 0, cancelRequested: false });
  expect(failure(() => as(db, AGENT, (ctx) => m.claimCall(ctx, { callId: ghost.id, digest: CALL_DIGEST })))).toBe('line busy');
  // And if two were ever live, one STOP hangs up both (not only the newest).
  db.db.callRequest.id.update({ ...db.db.callRequest.id.find(ghost.id)!, status: { tag: 'Dialing' } });
  expect(gesture(db, 'STOP').outcome).toBe('accepted:hang_up');
  expect([a.id, ghost.id].map((id) => db.db.callRequest.id.find(id)!.cancelRequested)).toEqual([true, true]);
});

test('a call reported connected after the idle deadline first gets the idle pause it owed: waiting work stops, the call is hung up', () => {
  const db = newDb();
  as(db, OWNER, (ctx) => m.setTiming(ctx, { json: JSON.stringify({ idle_pause_ms: 30000 }) }));
  grantConsent(db, 'call', 'leon');
  scanning(db, [callOption(db)]);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick_call');
  const c = callOf(db);
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'call', id: c.id, digest: CALL_DIGEST }));
  live(db, 1500);
  expect(gesture(db, 'CONFIRM', { heardDigest: CALL_DIGEST }).outcome).toBe('accepted:confirm');
  as(db, AGENT, (ctx) => m.claimCall(ctx, { callId: c.id, digest: CALL_DIGEST }));
  as(db, AGENT, (ctx) => m.reportCallStatus(ctx, { callId: c.id, attempt: 1, status: 'ringing', result: '', endReason: '', reasonCode: '', reason: '' }));
  errandDuringCall(db); // its YES set the idle deadline 30 s ahead; the call only rings, so idle_pause would pause
  live(db, 30_000); // the idle pause is due and idle_pause has not run
  as(db, AGENT, (ctx) => m.reportCallStatus(ctx, { callId: c.id, attempt: 1, status: 'connected', result: '', endReason: '', reasonCode: '', reason: '' }));
  expect([scan(db).phase.tag, scan(db).pauseReason?.tag]).toEqual(['Paused', 'Idle']);
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['Stopped', 'idle']);
  const call = db.db.callRequest.id.find(c.id)!;
  expect([call.status.tag, call.cancelRequested, call.cancelReason]).toEqual(['Connected', true, 'auto_pause']);
});

test('NO during a call stops a waiting errand and leaves the call alone', () => {
  const db = newDb();
  const call = connectedCall(db);
  errandDuringCall(db);
  settle(db);
  expect(gesture(db, 'NO').outcome).toBe('accepted:stop_errand');
  expect(errandOf(db).status.tag).toBe('Stopped');
  expect(db.db.callRequest.id.find(call.id)!.cancelRequested).toBe(false);
});

test('a lapsed dial lease marks the call unknown and asks for the hang-up, and the agent still sees the row', () => {
  const db = newDb();
  as(db, OWNER, (ctx) => m.setTiming(ctx, { json: JSON.stringify({ call_lease_ms: 60000 }) }));
  const c = connectedCall(db);
  const lease = [...db.db.callTimer.callId.filter(c.id)].find((r) => r.kind.tag === 'Lease')!;
  live(db, 60_000);
  internal(db, (ctx) => m.callTimeout(ctx, { job: lease }));
  const after = callOf(db);
  expect([after.status.tag, after.result, after.reasonCode, after.cancelRequested, after.cancelReason]).toEqual(['Failed', 'unknown', 'lease_lapsed', true, 'operator']);
  // The sidecar's reconcile cancels on `cancel_requested`, so the row stays in its queue.
  const queue = m.callQueue(db.viewContext(auth(AGENT)));
  expect(queue.map((r) => [r.callId, r.status.tag, r.cancelRequested, r.claimedByMe])).toEqual([[c.id, 'Failed', true, true]]);
  // Its later report of the hang-up changes nothing; the board says unknown, never sent or not sent.
  as(db, AGENT, (ctx) => m.reportCallStatus(ctx, { callId: c.id, attempt: 1, status: 'ended', result: 'cancelled', endReason: '', reasonCode: '', reason: '' }));
  expect([callOf(db).status.tag, callOf(db).result]).toEqual(['Failed', 'unknown']);
});

test('call progress after the dial lease ran out is ignored before call_timeout runs; a final report still lands', () => {
  const db = newDb();
  as(db, OWNER, (ctx) => m.setTiming(ctx, { json: JSON.stringify({ call_lease_ms: 60000 }) }));
  grantConsent(db, 'call', 'leon');
  scanning(db, [callOption(db)]);
  gesture(db, 'YES');
  const c = callOf(db);
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'call', id: c.id, digest: CALL_DIGEST }));
  live(db, 1500);
  expect(gesture(db, 'CONFIRM', { heardDigest: CALL_DIGEST }).outcome).toBe('accepted:confirm');
  as(db, AGENT, (ctx) => m.claimCall(ctx, { callId: c.id, digest: CALL_DIGEST }));
  live(db, 60_000); // the lease ran out; call_timeout has not run
  as(db, AGENT, (ctx) => m.reportCallStatus(ctx, { callId: c.id, attempt: 1, status: 'connected', result: '', endReason: '', reasonCode: '', reason: '' }));
  expect(callOf(db).status.tag).toBe('Dialing');
  as(db, AGENT, (ctx) => m.addCallLine(ctx, { callId: c.id, attempt: 1, lineKey: 'late-1', role: 'recipient', text: 'Hello?' }));
  expect([...db.db.callLine.callId.filter(c.id)]).toHaveLength(0);
  as(db, AGENT, (ctx) => m.reportCallStatus(ctx, { callId: c.id, attempt: 1, status: 'ended', result: 'no_answer', endReason: '', reasonCode: '', reason: '' }));
  expect([callOf(db).status.tag, callOf(db).result]).toEqual(['Ended', 'no_answer']);
});
