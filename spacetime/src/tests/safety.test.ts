// The dead-man interlock (D12 item 2), idle auto-pause and the pause rules: a lost signal pauses every screen,
// voids anything waiting for a confirm, and resumes on the same option; deliberate pauses need a deliberate resume.
import { expect, test } from 'vitest';
import * as m from '../index';
import {
  advance,
  AGENT,
  as,
  ask,
  beat,
  callOption,
  CALL_DIGEST,
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
  PARTNER,
  question,
  reply,
  scan,
  scanning,
  settle,
  STATION,
  tick,
  timerAt,
  type Test,
} from './harness';

const DIGEST = 'a1b2c3d4e5f60718';

function lease(db: Test) {
  const rows = [...db.db.livenessLease.sessionId.filter(scan(db).sessionId)];
  return rows.sort((a, b) => (a.beatSeq < b.beatSeq ? 1 : -1))[0]!;
}

/** Fires the newest lease as the scheduler, at its deadline (or now, if the clock is already past it). */
function expireLease(db: Test) {
  const row = lease(db);
  if (micros(timerAt(row)) > micros(now(db))) db.clock.set(timerAt(row));
  internal(db, (ctx) => m.livenessExpired(ctx, { job: row }));
}

function errandAwaitingConfirm(db: Test) {
  grantConsent(db, 'errand', FORM_KEY);
  const q = scanning(db, [errandOption()]);
  gesture(db, 'YES');
  const job = claim(db, q.id, 'ErrandPreview');
  as(db, AGENT, (ctx) =>
    m.agentAttachPreview(ctx, { jobId: job.id, attempt: job.attempt, status: 'previewed', formTitle: 'Care team request', readBackText: 'Request: Lunch.', readBackJson: '', previewDigest: DIGEST, screenshotUrl: '', reasonCode: '', reason: '', previewMs: 1 }),
  );
  const e = [...db.db.errand.errandBySession.filter(scan(db).sessionId)][0]!;
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'errand', id: e.id, digest: DIGEST }));
  return e.id;
}

test('each heartbeat replaces the dead-man lease 1.5 s ahead', () => {
  const db = newDb();
  advance(db, 400);
  beat(db);
  const rows = [...db.db.livenessLease.sessionId.filter(scan(db).sessionId)];
  expect(rows).toHaveLength(1);
  expect(micros(timerAt(rows[0]!)) - micros(now(db))).toBe(1_500_000n);
  expect(rows[0]!.decoderHealthy).toBe(true);
});

test('a lease that lapses pauses the scan as headset lost, with the latency from server clocks', () => {
  const db = newDb();
  scanning(db);
  const before = scan(db);
  const row = lease(db);
  expireLease(db);
  const s = scan(db);
  expect([s.phase.tag, s.pauseReason?.tag, s.resumeCursor]).toEqual(['Paused', 'HeadsetLost', before.cursor]);
  expect(s.stepSeq).toBe(before.stepSeq + 1n);
  const pauseRow = [...db.db.ledger.ledgerBySession.filter(s.sessionId)].find((l) => l.kind === 'pause')!;
  expect(pauseRow.ms).toBe(Number((micros(timerAt(row)) - micros(row.lastBeatAt)) / 1000n));
  expect(pauseRow.ms).toBe(1500);
  const stationStatus = db.db.deviceStatus.identity.find(db.db.session.id.find(s.sessionId)!.station)!;
  expect(stationStatus.online).toBe(false);
});

test('an old lease row that a newer heartbeat replaced does nothing when it fires', () => {
  const db = newDb();
  scanning(db);
  const old = lease(db);
  advance(db, 500);
  beat(db);
  db.clock.set(timerAt(old));
  internal(db, (ctx) => m.livenessExpired(ctx, { job: old }));
  expect(scan(db).phase.tag).toBe('Reading');
});

test('a heartbeat that arrives after its lease ran out pauses and voids, even before liveness_expired ran', () => {
  const db = newDb();
  const errandId = errandAwaitingConfirm(db);
  const lapsed = lease(db);
  advance(db, 1501); // the lease ran out 1 ms ago; its timer has not run
  beat(db); // healthy, but late: deleting the old lease must not cancel the pause it owed
  const s = scan(db);
  expect([s.phase.tag, s.pauseReason?.tag]).toEqual(['Paused', 'HeadsetLost']);
  expect([db.db.errand.id.find(errandId)!.status.tag, db.db.errand.id.find(errandId)!.reasonCode]).toEqual(['Stopped', 'headset_lost']);
  const pauseRow = [...db.db.ledger.ledgerBySession.filter(s.sessionId)].find((l) => l.kind === 'pause')!;
  expect([pauseRow.outcome, pauseRow.ms]).toEqual(['headset_lost', 1501]);
  internal(db, (ctx) => m.livenessExpired(ctx, { job: lapsed })); // the old row, if it still ran, does nothing more
  expect(scan(db).stepSeq).toBe(s.stepSeq);
  live(db, 3000); // the usual healthy-contact resume; the voided errand stays void
  expect(scan(db).phase.tag).not.toBe('Paused');
  expect(db.db.errand.id.find(errandId)!.status.tag).toBe('Stopped');
  expect(gesture(db, 'CONFIRM', { heardDigest: DIGEST }).outcome).toBe('ignored:nothing_to_confirm');
});

test('a heartbeat just inside its lease keeps everything running', () => {
  const db = newDb();
  const errandId = errandAwaitingConfirm(db);
  advance(db, 1499);
  beat(db);
  expect(scan(db).phase.tag).not.toBe('Paused');
  expect(db.db.errand.id.find(errandId)!.status.tag).toBe('AwaitingConfirm');
});

test('a lapsed lease voids a pending confirm, and the confirm stays void after the resume', () => {
  const db = newDb();
  const errandId = errandAwaitingConfirm(db);
  expireLease(db);
  const e = db.db.errand.id.find(errandId)!;
  expect([e.status.tag, e.reasonCode]).toEqual(['Stopped', 'headset_lost']);
  beat(db);
  live(db, 3000);
  expect(scan(db).phase.tag).not.toBe('Paused');
  expect(db.db.errand.id.find(errandId)!.status.tag).toBe('Stopped');
});

test('healthy heartbeats for resume_good_contact_ms resume the same option with a new step', () => {
  const db = newDb();
  scanning(db);
  live(db, 1000);
  tick(db);
  live(db, 1000);
  tick(db); // reading option 2
  const before = scan(db);
  expireLease(db);
  beat(db); // contact is back: healthy since now
  expect(scan(db).phase.tag).toBe('Paused');
  live(db, 2500);
  advance(db, 499);
  beat(db);
  expect(scan(db).phase.tag).toBe('Paused'); // 2999 ms of good contact
  advance(db, 1);
  beat(db);
  const s = scan(db);
  expect([s.phase.tag, s.cursor, s.pass]).toEqual(['Reading', 2, 1]);
  expect(s.stepSeq).toBeGreaterThan(before.stepSeq + 1n);
  expect(s.prevOptionStartSeq).toBe(0n); // no grace candidate across a pause
});

test('a healthy run only counts while heartbeats are continuous: a gap restarts it', () => {
  const db = newDb();
  scanning(db);
  beat(db, false);
  beat(db, true);
  advance(db, 3500); // no beat for longer than the 1.5 s lease
  beat(db, true);
  expect(scan(db).phase.tag).toBe('Paused');
  live(db, 3000);
  expect(scan(db).phase.tag).toBe('Reading');
});

test('healthy time from before a HEADSET_OFF pause does not count toward the resume', () => {
  const db = newDb();
  live(db, 10_000); // healthy for 10 s
  scanning(db);
  expect(gesture(db, 'HEADSET_OFF').outcome).toBe('accepted:pause');
  beat(db, true);
  expect(scan(db).phase.tag).toBe('Paused');
  live(db, 3000);
  expect(scan(db).phase.tag).toBe('Reading');
});

test('an unhealthy heartbeat pauses as headset off; with auto_resume off only a YES with good contact resumes', () => {
  const db = newDb();
  as(db, OWNER, (ctx) => m.setTiming(ctx, { json: JSON.stringify({ auto_resume: false }) }));
  scanning(db);
  beat(db, false);
  expect(scan(db).pauseReason?.tag).toBe('HeadsetOff');
  beat(db, true);
  live(db, 5000);
  expect(scan(db).phase.tag).toBe('Paused');
  beat(db, false);
  beat(db, true); // contact just came back
  expect(gesture(db, 'YES').outcome).toBe('ignored:no_contact');
  live(db, 3000);
  settle(db);
  beat(db, true);
  expect(gesture(db, 'YES').outcome).toBe('accepted:resume');
  expect(scan(db).phase.tag).toBe('Reading');
});

test('the idle timer pauses after idle_pause_ms with no accepted command; a stale idle row does nothing', () => {
  const db = newDb();
  scanning(db);
  const stale = [...db.db.idleTimer.sessionId.filter(scan(db).sessionId)][0]!;
  expect(micros(timerAt(stale)) - micros(now(db))).toBe(120_000_000n - 0n);
  gesture(db, 'NO'); // an accepted command re-arms the idle timer with a new fence
  internal(db, (ctx) => m.idlePause(ctx, { job: stale }));
  expect(scan(db).phase.tag).toBe('Reading');
  const fresh = [...db.db.idleTimer.sessionId.filter(scan(db).sessionId)][0]!;
  expect(fresh.idleSeq).toBe(stale.idleSeq + 1n);
  db.clock.set(timerAt(fresh));
  internal(db, (ctx) => m.idlePause(ctx, { job: fresh }));
  expect([scan(db).phase.tag, scan(db).pauseReason?.tag]).toEqual(['Paused', 'Idle']);
});

test('the idle timer never hangs up a connected call: it re-arms instead', () => {
  const db = newDb();
  grantConsent(db, 'call', 'leon');
  scanning(db, [callOption(db)]);
  gesture(db, 'YES');
  const c = [...db.db.callRequest.callBySession.filter(scan(db).sessionId)][0]!;
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'call', id: c.id, digest: CALL_DIGEST }));
  live(db, 1500);
  gesture(db, 'CONFIRM', { heardDigest: CALL_DIGEST });
  as(db, AGENT, (ctx) => m.claimCall(ctx, { callId: c.id, digest: CALL_DIGEST }));
  as(db, AGENT, (ctx) => m.reportCallStatus(ctx, { callId: c.id, attempt: 1, status: 'connected', result: '', endReason: '', reasonCode: '', reason: '' }));
  const idle = [...db.db.idleTimer.sessionId.filter(scan(db).sessionId)][0]!;
  db.clock.set(timerAt(idle));
  internal(db, (ctx) => m.idlePause(ctx, { job: idle }));
  expect(scan(db).phase.tag).not.toBe('Paused');
  expect(db.db.callRequest.id.find(c.id)!.cancelRequested).toBe(false);
  const rearmed = [...db.db.idleTimer.sessionId.filter(scan(db).sessionId)][0]!;
  expect(rearmed.idleSeq).toBe(idle.idleSeq + 1n);
});

test('STOP while idle pauses; heartbeats never lift it, YES does', () => {
  const db = newDb();
  expect(gesture(db, 'STOP').outcome).toBe('accepted:pause');
  expect(scan(db).pauseReason?.tag).toBe('Stop');
  beat(db);
  advance(db, 10_000);
  beat(db);
  expect(scan(db).phase.tag).toBe('Paused');
  expect(gesture(db, 'NO').outcome).toBe('ignored:paused');
  expect(gesture(db, 'STOP').outcome).toBe('ignored:already_paused');
  settle(db);
  expect(gesture(db, 'YES').outcome).toBe('accepted:resume');
  expect(scan(db).phase.tag).toBe('Idle');
});

test('STOP during a signal pause makes it deliberate', () => {
  const db = newDb();
  scanning(db);
  beat(db, false);
  expect(scan(db).pauseReason?.tag).toBe('HeadsetOff');
  expect(gesture(db, 'STOP').outcome).toBe('accepted:pause');
  expect(scan(db).pauseReason?.tag).toBe('Stop');
  beat(db, true);
  live(db, 5000);
  expect(scan(db).phase.tag).toBe('Paused'); // a deliberate pause needs a deliberate resume
});

test('a lost signal never downgrades a deliberate pause into one that resumes on its own', () => {
  const db = newDb();
  scanning(db);
  expect(gesture(db, 'STOP').outcome).toBe('accepted:none');
  settle(db);
  expect(gesture(db, 'STOP').outcome).toBe('accepted:pause');
  beat(db, false); // the headset slips while paused
  expect(scan(db).pauseReason?.tag).toBe('Stop');
  expireLease(db); // and the station goes quiet
  expect(scan(db).pauseReason?.tag).toBe('Stop');
  beat(db, true);
  live(db, 5000); // good contact again: still paused, because STOP needs YES or the owner
  expect([scan(db).phase.tag, scan(db).pauseReason?.tag]).toEqual(['Paused', 'Stop']);
});

test('an operator pause ignores YES; only the owner lifts it', () => {
  const db = newDb();
  scanning(db);
  as(db, PARTNER, (ctx) => m.operatorPause(ctx, {}));
  expect(scan(db).pauseReason?.tag).toBe('Operator');
  settle(db);
  expect(gesture(db, 'YES').outcome).toBe('ignored:operator_pause');
  expect(failure(() => as(db, PARTNER, (ctx) => m.operatorResume(ctx, {})))).toBe('owner only');
  as(db, OWNER, (ctx) => m.operatorResume(ctx, {}));
  expect(scan(db).phase.tag).toBe('Reading');
});

test('HEADSET_OFF voids everything pending and asks the agent to hang up a live call', () => {
  const db = newDb();
  const errandId = errandAwaitingConfirm(db);
  expect(gesture(db, 'HEADSET_OFF').outcome).toBe('accepted:pause');
  expect(db.db.errand.id.find(errandId)!.status.tag).toBe('Stopped');
  expect(gesture(db, 'HEADSET_OFF').outcome).toBe('ignored:already_paused');

  const db2 = newDb();
  grantConsent(db2, 'call', 'leon');
  scanning(db2, [callOption(db2)]);
  gesture(db2, 'YES');
  const c = [...db2.db.callRequest.callBySession.filter(scan(db2).sessionId)][0]!;
  as(db2, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'call', id: c.id, digest: CALL_DIGEST }));
  live(db2, 1500);
  gesture(db2, 'CONFIRM', { heardDigest: CALL_DIGEST });
  as(db2, AGENT, (ctx) => m.claimCall(ctx, { callId: c.id, digest: CALL_DIGEST }));
  gesture(db2, 'HEADSET_OFF');
  const dialing = db2.db.callRequest.id.find(c.id)!;
  expect([dialing.status.tag, dialing.cancelRequested, dialing.cancelReason]).toEqual(['Dialing', true, 'headset_off']);
});

test('a question during a pause waits; a question during an idle pause resumes the clock', () => {
  const db = newDb();
  gesture(db, 'STOP');
  const waiting = ask(db, 'Are you cold?');
  expect([scan(db).phase.tag, question(db, waiting.id).status.tag]).toEqual(['Paused', 'Drafting']);
  settle(db);
  gesture(db, 'YES'); // resume: the waiting question is prepared
  expect([scan(db).phase.tag, scan(db).questionId]).toEqual(['Preparing', waiting.id]);

  const db2 = newDb();
  const idle = [...db2.db.idleTimer.sessionId.filter(scan(db2).sessionId)][0]!;
  db2.clock.set(timerAt(idle));
  internal(db2, (ctx) => m.idlePause(ctx, { job: idle }));
  expect(scan(db2).pauseReason?.tag).toBe('Idle');
  const q = ask(db2, 'Hungry?');
  expect([scan(db2).phase.tag, scan(db2).questionId]).toEqual(['Preparing', q.id]);
});

test('a pause during the veto cancels the pick: nothing is said, and the resume re-reads that option', () => {
  const db = newDb();
  const q = scanning(db, [reply('Yes'), reply('No')]);
  gesture(db, 'YES');
  expect(scan(db).phase.tag).toBe('Veto');
  gesture(db, 'HEADSET_OFF');
  expect(scan(db).pickedRank).toBeUndefined();
  expect(question(db, q.id).status.tag).toBe('Scanning');
  beat(db);
  live(db, 3000);
  expect([scan(db).phase.tag, scan(db).cursor]).toEqual(['Reading', 1]);
  expect(question(db, q.id).releasedAt).toBeUndefined();
});

test('ending the session voids what is pending and stops every clock; later gestures find no session', () => {
  const db = newDb();
  const errandId = errandAwaitingConfirm(db);
  as(db, STATION, (ctx) => m.endSession(ctx, {}));
  expect(db.db.errand.id.find(errandId)!.reasonCode).toBe('session_ended');
  const sid = scan(db).sessionId;
  expect([...db.db.livenessLease.sessionId.filter(sid)]).toHaveLength(0);
  expect([...db.db.idleTimer.sessionId.filter(sid)]).toHaveLength(0);
  expect([...db.db.scanTimer.sessionId.filter(sid)]).toHaveLength(0);
  expect(gesture(db, 'YES').outcome).toBe('ignored:no_session');
  expect(failure(() => beat(db))).toBe('no active session');
});
