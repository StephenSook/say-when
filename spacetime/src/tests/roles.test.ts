// Roles in reducers, privacy in views (D12 item 4): every client reducer checks the caller's role, scheduled
// reducers only answer the scheduler, each device sees only its slice, and the anonymous board follows the toggle.
import { expect, test } from 'vitest';
import { ScheduleAt } from 'spacetimedb';
import * as m from '../index';
import { computeStats } from '../stats';
import {
  AGENT,
  as,
  ask,
  auth,
  CALL_DIGEST,
  callOption,
  clips,
  emptyDb,
  errandOption,
  failure,
  FORM_KEY,
  gesture,
  grantConsent,
  idOf,
  internal,
  live,
  NOW_MICROS,
  newDb,
  options,
  OWNER,
  pair,
  PARTNER,
  publish,
  question,
  reply,
  scan,
  scanning,
  settle,
  SPEAKER,
  STATION,
  tick,
  timerAt,
  type Test,
} from './harness';

const at = ScheduleAt.time(NOW_MICROS);
const q0 = 1n;

/** Each client reducer, called by someone it must refuse, and the refusal it must give. */
function refusals(db: Test): Array<[string, string, () => unknown, string]> {
  return [
    ['approve_pairing', PARTNER, () => as(db, PARTNER, (c) => m.approvePairing(c, { code: 123456, caregiver: false })), 'owner only'],
    ['revoke_device', STATION, () => as(db, STATION, (c) => m.revokeDevice(c, { identity: idOf(db, PARTNER) })), 'owner only'],
    ['grant_consent', SPEAKER, () => as(db, SPEAKER, (c) => m.grantConsent(c, { scope: 'errand', subject: '', method: 'wearer', note: '' })), 'owner or caregiver only'],
    ['revoke_consent', AGENT, () => as(db, AGENT, (c) => m.revokeConsent(c, { consentId: 1n })), 'owner or caregiver only'],
    ['set_timing', PARTNER, () => as(db, PARTNER, (c) => m.setTiming(c, { json: '{}' })), 'owner only'],
    ['set_board_sharing', STATION, () => as(db, STATION, (c) => m.setBoardSharing(c, { on: false })), 'owner or caregiver only'],
    ['ensure_timers', AGENT, () => as(db, AGENT, (c) => m.ensureTimers(c, {})), 'owner only'],
    ['start_session', PARTNER, () => as(db, PARTNER, (c) => m.startSession(c, { label: 'demo' })), 'not allowed'],
    ['end_session', PARTNER, () => as(db, PARTNER, (c) => m.endSession(c, {})), 'not allowed'],
    ['operator_pause', STATION, () => as(db, STATION, (c) => m.operatorPause(c, {})), 'not allowed'],
    ['operator_resume', PARTNER, () => as(db, PARTNER, (c) => m.operatorResume(c, {})), 'owner only'],
    ['purge_session', PARTNER, () => as(db, PARTNER, (c) => m.purgeSession(c, { sessionId: 1n })), 'owner only'],
    ['ask_question', STATION, () => as(db, STATION, (c) => m.askQuestion(c, { requestId: 'r-x', text: 'Hi', via: 'typed', listenMs: 0 })), 'not allowed'],
    ['cancel_question', SPEAKER, () => as(db, SPEAKER, (c) => m.cancelQuestion(c, { questionId: q0 })), 'not allowed'],
    ['partner_listening', STATION, () => as(db, STATION, (c) => m.partnerListening(c, { requestId: 'r-y', on: true })), 'not allowed'],
    ['report_clip_ready', PARTNER, () => as(db, PARTNER, (c) => m.reportClipReady(c, { optionId: 1n, clipMs: 900, synthMs: 1 })), 'not allowed'],
    ['report_readback_done', AGENT, () => as(db, AGENT, (c) => m.reportReadbackDone(c, { kind: 'errand', id: 1n, digest: '' })), 'not allowed'],
    ['heartbeat', PARTNER, () => as(db, PARTNER, (c) => m.heartbeat(c, { beatSeq: 1n, decoderHealthy: true })), 'not allowed'],
    ['reply_spoken', PARTNER, () => as(db, PARTNER, (c) => m.replySpoken(c, { questionId: q0, ms: 1 })), 'not allowed'],
    ['agent_claim', STATION, () => as(db, STATION, (c) => m.agentClaim(c, { jobId: 1n })), 'not allowed'],
    ['agent_progress', PARTNER, () => as(db, PARTNER, (c) => m.agentProgress(c, { jobId: 1n, attempt: 1, eventKey: 'k', stage: 'plan', status: 'ok', detail: 'x', ms: 0, countsJson: '', payloadJson: '' })), 'not allowed'],
    ['agent_publish_options', STATION, () => as(db, STATION, (c) => m.agentPublishOptions(c, { jobId: 1n, attempt: 1, answerMode: 'pick', options: [], final: true })), 'not allowed'],
    ['agent_attach_preview', PARTNER, () => as(db, PARTNER, (c) => m.agentAttachPreview(c, { jobId: 1n, attempt: 1, status: 'failed', formTitle: '', readBackText: '', readBackJson: '', previewDigest: '', screenshotUrl: '', reasonCode: '', reason: '', previewMs: 0 })), 'not allowed'],
    ['agent_fail', SPEAKER, () => as(db, SPEAKER, (c) => m.agentFail(c, { jobId: 1n, attempt: 1, reasonCode: '', reason: '' })), 'not allowed'],
    ['agent_done', STATION, () => as(db, STATION, (c) => m.agentDone(c, { jobId: 1n, attempt: 1, countsJson: '' })), 'not allowed'],
    ['claim_errand', STATION, () => as(db, STATION, (c) => m.claimErrand(c, { errandId: 1n, digest: '' })), 'not allowed'],
    ['complete_errand', PARTNER, () => as(db, PARTNER, (c) => m.completeErrand(c, { errandId: 1n, attempt: 1, status: 'submitted', confirmationText: '', screenshotUrl: '', reasonCode: '', reason: '', submitMs: 0 })), 'not allowed'],
    ['claim_call', PARTNER, () => as(db, PARTNER, (c) => m.claimCall(c, { callId: 1n, digest: '' })), 'not allowed'],
    ['report_call_status', STATION, () => as(db, STATION, (c) => m.reportCallStatus(c, { callId: 1n, attempt: 1, status: 'ringing', result: '', endReason: '', reasonCode: '', reason: '' })), 'not allowed'],
    ['add_call_line', SPEAKER, () => as(db, SPEAKER, (c) => m.addCallLine(c, { callId: 1n, attempt: 1, lineKey: 'l', role: 'assistant', text: 'x' })), 'not allowed'],
    ['gesture', PARTNER, () => as(db, PARTNER, (c) => m.gesture(c, { gestureId: 'g', command: 'YES', heardStepSeq: 0n, heardOptionId: 0n, heardDigest: '', confidence: 1, source: 'jaw', onsetAgeMs: 0 })), 'not allowed'],
    ['report_word_timings', PARTNER, () => as(db, PARTNER, (c) => m.reportWordTimings(c, { sessionId: 1n, stepSeq: 1n, optionId: 1n, startsMs: [0], endsMs: [10] })), 'not allowed'],
    ['set_sandbox', STATION, () => as(db, STATION, (c) => m.setSandbox(c, { json: '{"on":true}' })), 'owner only'],
  ];
}

test('every client reducer refuses a caller with the wrong role', () => {
  const db = newDb();
  const cases = refusals(db);
  expect(cases).toHaveLength(33);
  for (const [name, , call, message] of cases) {
    expect(failure(call), name).toBe(message);
  }
});

test('an unpaired stranger and a revoked device are refused like the wrong role', () => {
  const db = newDb();
  expect(failure(() => as(db, 'stranger', (c) => m.askQuestion(c, { requestId: 'r-1', text: 'Hi', via: 'typed', listenMs: 0 })))).toBe('not allowed');
  as(db, OWNER, (c) => m.revokeDevice(c, { identity: idOf(db, PARTNER) }));
  expect(failure(() => as(db, PARTNER, (c) => m.askQuestion(c, { requestId: 'r-2', text: 'Hi', via: 'typed', listenMs: 0 })))).toBe('not allowed');
  expect(db.db.deviceStatus.identity.find(idOf(db, PARTNER))!.online).toBe(false);
});

test('every scheduled reducer refuses a client caller, even the owner', () => {
  const db = newDb();
  const calls: Array<() => unknown> = [
    () => as(db, OWNER, (c) => m.scanTick(c, { job: { scheduledId: 1n, scheduledAt: at, sessionId: 1n, stepSeq: 0n, kind: { tag: 'StepEnd' } } })),
    () => as(db, OWNER, (c) => m.livenessExpired(c, { job: { scheduledId: 1n, scheduledAt: at, sessionId: 1n, beatSeq: 0n, lastBeatAt: db.clock.now(), decoderHealthy: true, healthySince: undefined } })),
    () => as(db, OWNER, (c) => m.idlePause(c, { job: { scheduledId: 1n, scheduledAt: at, sessionId: 1n, idleSeq: 1n } })),
    () => as(db, OWNER, (c) => m.leaseExpired(c, { job: { scheduledId: 1n, scheduledAt: at, jobId: 1n, attempt: 1 } })),
    () => as(db, OWNER, (c) => m.errandTimeout(c, { job: { scheduledId: 1n, scheduledAt: at, errandId: 1n, kind: { tag: 'Submit' }, seq: 1 } })),
    () => as(db, OWNER, (c) => m.callTimeout(c, { job: { scheduledId: 1n, scheduledAt: at, callId: 1n, kind: { tag: 'Lease' }, seq: 1 } })),
    () => as(db, STATION, (c) => m.pairingExpired(c, { job: { scheduledId: 1n, scheduledAt: at, code: 123456 } })),
  ];
  for (const call of calls) expect(failure(call)).toBe('scheduler only');
});

test('pairing: a code is held for one requester, approved once by the owner, and expires', () => {
  const db = emptyDb();
  as(db, 'phone', (c) => m.requestPairing(c, { code: 482913, role: 'partner', label: 'partner phone 1' }));
  expect(failure(() => as(db, 'other', (c) => m.requestPairing(c, { code: 482913, role: 'partner', label: 'x' })))).toContain('code taken');
  expect(failure(() => as(db, 'other', (c) => m.requestPairing(c, { code: 99, role: 'partner', label: 'x' })))).toContain('6 digits');
  expect(failure(() => as(db, 'other', (c) => m.requestPairing(c, { code: 222222, role: 'admin', label: 'x' })))).toContain('role must be');
  as(db, OWNER, (c) => m.approvePairing(c, { code: 482913, caregiver: true }));
  const d = db.db.device.identity.find(idOf(db, 'phone'))!;
  expect([d.role.tag, d.caregiver, d.label]).toEqual(['Partner', true, 'partner phone 1']);
  expect(db.db.deviceStatus.identity.find(idOf(db, 'phone'))!.online).toBe(false);
  expect(failure(() => as(db, 'phone', (c) => m.requestPairing(c, { code: 333333, role: 'agent', label: 'x' })))).toBe('already paired');

  as(db, 'late', (c) => m.requestPairing(c, { code: 444444, role: 'speaker', label: 'speaker 1' }));
  const timer = [...db.db.pairingTimer.iter()].find((r) => r.code === 444444)!;
  db.clock.set(timerAt(timer));
  internal(db, (c) => m.pairingExpired(c, { job: timer }));
  expect(db.db.pairingRequest.code.find(444444)).toBeNull();
  expect(failure(() => as(db, OWNER, (c) => m.approvePairing(c, { code: 444444, caregiver: false })))).toBe('unknown or expired code');
});

test('revoking the session station pauses the scan for the operator', () => {
  const db = newDb();
  scanning(db);
  as(db, OWNER, (c) => m.revokeDevice(c, { identity: idOf(db, STATION) }));
  expect(scan(db).pauseReason?.tag).toBe('Operator');
});

test('my_options gives the station the candidates and a partner nothing', () => {
  const db = newDb();
  const q = scanning(db);
  const station = m.myOptions(db.viewContext(auth(STATION)));
  expect(station.map((o) => [o.rank, o.text, o.current])).toEqual([
    [1, 'Yes, please', true],
    [2, 'No, thank you', true],
    [3, 'Later', true],
  ]);
  expect(m.myOptions(db.viewContext(auth(PARTNER)))).toEqual([]);
  expect(m.myOptions(db.viewContext(auth(AGENT)))).toEqual([]);
  expect(options(db, q.id, 1)).toHaveLength(3);
});

test('partner_view shows progress and the reply, never the candidate options', () => {
  const db = newDb();
  const q = scanning(db);
  const before = m.partnerView(db.viewContext(auth(PARTNER)));
  expect(before.map((r) => [r.text, r.step, r.askedByMe])).toEqual([['Do you want some water?', 'reading', true]]);
  const text = JSON.stringify(before, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  for (const o of options(db, q.id, 1)) expect(text).not.toContain(o.text);
  gesture(db, 'YES');
  tick(db);
  const after = m.partnerView(db.viewContext(auth(PARTNER)));
  expect([after[0]!.step, after[0]!.replyText]).toEqual(['picked', 'Yes, please']);
  expect(m.partnerView(db.viewContext(auth(STATION)))).toEqual([]);
});

test('my_session gives the station the scanned question and the speaker only the released reply', () => {
  const db = newDb();
  scanning(db);
  const station = m.mySession(db.viewContext(auth(STATION)))!;
  expect([station.role, station.questionText, station.answerMode.tag]).toEqual(['station', 'Do you want some water?', 'Pick']);
  const speaker = m.mySession(db.viewContext(auth(SPEAKER)))!;
  expect([speaker.questionText, speaker.reply]).toEqual(['', undefined]);
  expect(m.mySession(db.viewContext(auth(PARTNER)))).toBeUndefined();
});

test('the public board shows "Question N" and "Option N" until sharing is on, and sharing needs board_text consent', () => {
  const db = newDb();
  const q = scanning(db, [reply('Yes, please', { sources: [{ source: 'maps', url: undefined, placeId: 'abc', fetchedAt: '2026-10-24T12:00:00Z' }] })]);
  const off = m.publicBoard(db.anonymousViewContext());
  expect([off[0]!.text, off[0]!.textShared, off[0]!.options[0]!.label, off[0]!.options[0]!.sources]).toEqual(['Question 1', false, 'Option 1', []]);
  expect(m.boardPayloads(db.anonymousViewContext())).toEqual([]);
  expect(failure(() => as(db, OWNER, (c) => m.setBoardSharing(c, { on: true })))).toBe('no board_text consent');
  grantConsent(db, 'board_text');
  as(db, PARTNER, (c) => m.setBoardSharing(c, { on: true })); // the partner phone is a caregiver
  const on = m.publicBoard(db.anonymousViewContext());
  expect([on[0]!.text, on[0]!.options[0]!.label, on[0]!.options[0]!.sources.length]).toEqual(['Do you want some water?', 'Yes, please', 1]);
  const payloads = m.boardPayloads(db.anonymousViewContext());
  expect(payloads.some((p) => p.stage === 'listen' && p.payloadJson.includes('Do you want some water?'))).toBe(true);
  expect(question(db, q.id).text).toBe('Do you want some water?');
});

test('revoking board_text consent turns sharing off', () => {
  const db = newDb();
  grantConsent(db, 'board_text');
  as(db, OWNER, (c) => m.setBoardSharing(c, { on: true }));
  const consentId = [...db.db.consent.consentByScope.filter({ tag: 'BoardText' })][0]!.id;
  as(db, PARTNER, (c) => m.revokeConsent(c, { consentId }));
  expect(db.db.config.id.find(0)!.shareTextOnBoard).toBe(false);
});

test('board_errands hides the form title, the read-back and the result unless sharing is on', () => {
  const db = newDb();
  grantConsent(db, 'errand', FORM_KEY);
  const q = scanning(db, [errandOption()]);
  gesture(db, 'YES');
  const job = [...db.db.agentJob.jobByQuestion.filter(q.id)].find((j) => j.kind.tag === 'ErrandPreview')!;
  as(db, AGENT, (c) => m.agentClaim(c, { jobId: job.id }));
  as(db, AGENT, (c) =>
    m.agentAttachPreview(c, { jobId: job.id, attempt: 1, status: 'previewed', formTitle: 'Care team request', readBackText: 'Request: Lunch.', readBackJson: '[]', previewDigest: 'a1b2c3d4e5f60718', screenshotUrl: 'https://example.test/s.png', reasonCode: '', reason: '', previewMs: 10 }),
  );
  const off = m.boardErrands(db.anonymousViewContext())[0]!;
  expect([off.status.tag, off.formTitle, off.previewDigest, off.readBackText, off.screenshotUrl]).toEqual(['Previewed', 'Form', 'a1b2c3d4e5f60718', '', '']);
  grantConsent(db, 'board_text');
  as(db, OWNER, (c) => m.setBoardSharing(c, { on: true }));
  const on = m.boardErrands(db.anonymousViewContext())[0]!;
  expect([on.formTitle, on.readBackText]).toEqual(['Care team request', 'Request: Lunch.']);
});

test("with sharing off the board shows only the module's own reason sentences, and codes come from the fixed list", () => {
  const db = newDb();
  grantConsent(db, 'errand', FORM_KEY);
  const q = scanning(db, [errandOption()]);
  gesture(db, 'YES');
  const job = [...db.db.agentJob.jobByQuestion.filter(q.id)].find((j) => j.kind.tag === 'ErrandPreview')!;
  as(db, AGENT, (c) => m.agentClaim(c, { jobId: job.id }));
  // The Actor's own refusal code `login`, sent in another case: kept. A sentence in the code would not be.
  as(db, AGENT, (c) =>
    m.agentAttachPreview(c, { jobId: job.id, attempt: 1, status: 'refused', formTitle: 'Jane Doe medication request', readBackText: '', readBackJson: '', previewDigest: '', screenshotUrl: '', reasonCode: 'Login', reason: "Jane Doe's medication request needs a login.", previewMs: 10 }),
  );
  const e = [...db.db.errand.errandBySession.filter(scan(db).sessionId)][0]!;
  expect([e.status.tag, e.reasonCode, e.reason]).toEqual(['Refused', 'login', "Jane Doe's medication request needs a login."]);
  const off = m.boardErrands(db.anonymousViewContext())[0]!;
  expect([off.formTitle, off.reasonCode, off.reason]).toEqual(['Form', 'login', '']);
  const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  const publicRows = [...m.boardErrands(db.anonymousViewContext()), ...db.runQuery(m.boardLedger(db.anonymousViewContext())), ...db.db.pipelineEvent.iter()];
  for (const row of publicRows) expect(show(row)).not.toContain('Jane');

  // A module-made stop keeps its own plain sentence on the board.
  const db2 = newDb();
  grantConsent(db2, 'errand', FORM_KEY);
  scanning(db2, [errandOption()]);
  gesture(db2, 'YES');
  gesture(db2, 'STOP');
  const stopped = m.boardErrands(db2.anonymousViewContext())[0]!;
  expect([stopped.status.tag, stopped.reasonCode, stopped.reason]).toEqual(['Stopped', 'stop', 'Stopped. Nothing was sent.']);

  // A refusal whose code is a sentence: stored and shown as the module word for the outcome, never the words.
  const db3 = newDb();
  grantConsent(db3, 'errand', FORM_KEY);
  const q3 = scanning(db3, [errandOption()]);
  gesture(db3, 'YES');
  const job3 = [...db3.db.agentJob.jobByQuestion.filter(q3.id)].find((j) => j.kind.tag === 'ErrandPreview')!;
  as(db3, AGENT, (c) => m.agentClaim(c, { jobId: job3.id }));
  as(db3, AGENT, (c) =>
    m.agentAttachPreview(c, { jobId: job3.id, attempt: 1, status: 'refused', formTitle: '', readBackText: '', readBackJson: '', previewDigest: '', screenshotUrl: '', reasonCode: 'Jane Doe takes lithium', reason: '', previewMs: 10 }),
  );
  const e3 = [...db3.db.errand.errandBySession.filter(scan(db3).sessionId)][0]!;
  expect([e3.status.tag, e3.reasonCode]).toEqual(['Refused', 'refused']);
  const rows3 = [...m.boardErrands(db3.anonymousViewContext()), ...db3.runQuery(m.boardLedger(db3.anonymousViewContext())), ...db3.db.pipelineEvent.iter()];
  for (const row of rows3) expect(show(row).toLowerCase()).not.toContain('jane');
});

test('board_calls hides the name, the end reason and outside sentences unless sharing is on', () => {
  const db = newDb();
  grantConsent(db, 'call', 'leon');
  scanning(db, [callOption(db)]);
  gesture(db, 'YES');
  const c = [...db.db.callRequest.callBySession.filter(scan(db).sessionId)][0]!;
  as(db, STATION, (x) => m.reportReadbackDone(x, { kind: 'call', id: c.id, digest: CALL_DIGEST }));
  live(db, 1500);
  expect(gesture(db, 'CONFIRM', { heardDigest: CALL_DIGEST }).outcome).toBe('accepted:confirm');
  as(db, AGENT, (x) => m.claimCall(x, { callId: c.id, digest: CALL_DIGEST }));
  as(db, AGENT, (x) =>
    m.reportCallStatus(x, { callId: c.id, attempt: 1, status: 'failed', result: 'failed', endReason: 'jane_doe_hung_up', reasonCode: 'Outside Hours', reason: 'Jane Doe was asleep, so I did not call.' }),
  );
  expect(db.db.callRequest.id.find(c.id)!.reasonCode).toBe('outside_hours'); // a listed Dialer code, kept
  const off = m.boardCalls(db.anonymousViewContext())[0]!;
  expect([off.status.tag, off.contactName, off.endReason, off.reasonCode, off.reason]).toEqual(['Failed', 'Contact', '', 'outside_hours', '']);
  grantConsent(db, 'board_text');
  as(db, OWNER, (x) => m.setBoardSharing(x, { on: true }));
  const on = m.boardCalls(db.anonymousViewContext())[0]!;
  expect([on.contactName, on.endReason, on.reason]).toEqual(['Leon', 'jane_doe_hung_up', 'Jane Doe was asleep, so I did not call.']);
});

test('public tables carry no conversation content', () => {
  const db = newDb();
  const q = scanning(db);
  gesture(db, 'YES');
  tick(db);
  as(db, SPEAKER, (c) => m.replySpoken(c, { questionId: q.id, ms: 900 }));
  const words = ['water', 'Yes, please', 'No, thank you', 'Later'];
  const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  const publicRows = [
    ...db.db.pipelineEvent.iter(),
    ...db.db.scanState.iter(),
    ...db.db.config.iter(),
    ...db.db.deviceStatus.iter(),
    ...db.runQuery(m.boardLedger(db.anonymousViewContext())),
  ];
  expect(publicRows.length).toBeGreaterThan(10);
  for (const row of publicRows) {
    for (const w of words) expect(show(row)).not.toContain(w);
  }
});

test('the ledger view lists every content-free state change', () => {
  const db = newDb();
  scanning(db);
  const rows = db.runQuery<{ kind: string }>(m.boardLedger(db.anonymousViewContext()));
  const kinds = rows.map((r) => r.kind);
  expect(kinds).toEqual(expect.arrayContaining(['device_paired', 'session_start', 'question', 'options', 'clips_ready', 'scan_start', 'step']));
});

test('client_connected marks a partner online and never touches the station', () => {
  const db = newDb();
  as(db, PARTNER, (c) => m.clientConnected(c, {}));
  expect(db.db.deviceStatus.identity.find(idOf(db, PARTNER))!.online).toBe(true);
  const stationBefore = db.db.deviceStatus.identity.find(idOf(db, STATION))!;
  as(db, STATION, (c) => m.clientDisconnected(c, {}));
  expect(db.db.deviceStatus.identity.find(idOf(db, STATION))!.online).toBe(stationBefore.online);
});

test('ensure_timers re-arms missing schedule rows and is idempotent', () => {
  const db = newDb();
  scanning(db);
  const sid = scan(db).sessionId;
  for (const r of [...db.db.scanTimer.sessionId.filter(sid)]) db.db.scanTimer.scheduledId.delete(r.scheduledId);
  for (const r of [...db.db.livenessLease.sessionId.filter(sid)]) db.db.livenessLease.scheduledId.delete(r.scheduledId);
  as(db, OWNER, (c) => m.ensureTimers(c, {}));
  as(db, OWNER, (c) => m.ensureTimers(c, {}));
  const timers = [...db.db.scanTimer.sessionId.filter(sid)];
  expect(timers).toHaveLength(1);
  expect(timers[0]!.stepSeq).toBe(scan(db).stepSeq);
  const leases = [...db.db.livenessLease.sessionId.filter(sid)];
  expect(leases.map((l) => l.decoderHealthy)).toEqual([false]); // fail closed until the next heartbeat
});

test('set_timing applies known keys in range and changes nothing otherwise', () => {
  const db = newDb();
  as(db, OWNER, (c) => m.setTiming(c, { json: JSON.stringify({ response_window_ms: 4000, max_passes: 3 }) }));
  const cfg = db.db.config.id.find(0)!;
  expect([cfg.responseWindowMs, cfg.maxPasses]).toEqual([4000, 3]);
  expect(failure(() => as(db, OWNER, (c) => m.setTiming(c, { json: JSON.stringify({ response_window_ms: 99999 }) })))).toContain('1000 to 10000');
  expect(failure(() => as(db, OWNER, (c) => m.setTiming(c, { json: JSON.stringify({ volume: 3 }) })))).toContain('unknown timing key');
  // Names on Object.prototype are unknown keys, not lookups into it.
  for (const json of ['{"constructor":5}', '{"toString":true}', '{"__proto__":1}', '{"hasOwnProperty":2}']) {
    expect(failure(() => as(db, OWNER, (c) => m.setTiming(c, { json }))), json).toContain('unknown timing key');
  }
  expect(db.db.config.id.find(0)!.responseWindowMs).toBe(4000);
});

test('the stats a judge can check are recomputed from stored rows', () => {
  const db = newDb();
  const q = scanning(db);
  gesture(db, 'YES');
  tick(db);
  as(db, SPEAKER, (c) => m.replySpoken(c, { questionId: q.id, ms: 900 }));
  const s = computeStats(db.db);
  expect([s.questions, s.questionsAnswered, s.picks, s.medianLateByMs, s.gestures, s.gesturesIgnored]).toEqual([1, 1, 1, 0, 1, 0]);
  expect(s.medianQuestionToFirstOptionMs).toBe(0);
});

test("the stats count only partner questions as answered: the person's own menu pick is not one", () => {
  const db = newDb();
  expect(gesture(db, 'YES').outcome).toBe('accepted:menu_open');
  const menu = question(db, scan(db).questionId);
  clips(db, menu.id, 1);
  settle(db);
  expect(gesture(db, 'YES', { heardStepSeq: scan(db).stepSeq }).outcome).toBe('accepted:menu_item');
  expect(question(db, menu.id).status.tag).toBe('Acting');
  const s = computeStats(db.db);
  expect([s.questions, s.questionsAnswered]).toEqual([0, 0]);
});

test("purge_session deletes an ended session's private rows and jobs, keeps only spent gesture ids, and refuses an active one", () => {
  const db = newDb();
  grantConsent(db, 'memory');
  const q = scanning(db);
  const sid = scan(db).sessionId;
  const g = gesture(db, 'YES');
  tick(db); // the reply is released
  as(db, SPEAKER, (c) => m.replySpoken(c, { questionId: q.id, ms: 900 })); // queues a Remember job
  const remember = [...db.db.agentJob.jobByQuestion.filter(q.id)].find((j) => j.kind.tag === 'Remember')!;
  as(db, AGENT, (c) => m.agentClaim(c, { jobId: remember.id }));
  expect(failure(() => as(db, OWNER, (c) => m.purgeSession(c, { sessionId: sid })))).toBe('session still active');
  as(db, STATION, (c) => m.endSession(c, {}));
  as(db, OWNER, (c) => m.purgeSession(c, { sessionId: sid }));
  expect(db.db.question.id.find(q.id)).toBeNull();
  expect([...db.db.ledger.ledgerBySession.filter(sid)]).toHaveLength(0);
  expect([...db.db.gestureLog.gestureBySession.filter(sid)]).toHaveLength(0);
  expect([...db.db.agentJob.jobByQuestion.filter(q.id)]).toHaveLength(0);
  expect([...db.db.jobLease.jobId.filter(remember.id)]).toHaveLength(0);
  expect([...db.db.spentGesture.iter()].map((r) => r.gestureId)).toEqual([g.gestureId]);
  // The agent's claimed Remember job is gone, so its late write is refused.
  expect(failure(() => as(db, AGENT, (c) => m.agentDone(c, { jobId: remember.id, attempt: 1, countsJson: '' })))).toBe('stale attempt');
});

test('ask_question is idempotent on request_id', () => {
  const db = newDb();
  as(db, PARTNER, (c) => m.askQuestion(c, { requestId: 'same', text: 'Water?', via: 'voice', listenMs: 700 }));
  as(db, PARTNER, (c) => m.askQuestion(c, { requestId: 'same', text: 'Water?', via: 'voice', listenMs: 700 }));
  expect([...db.db.question.questionBySession.filter(scan(db).sessionId)]).toHaveLength(1);
  expect(failure(() => as(db, PARTNER, (c) => m.askQuestion(c, { requestId: 'r-long', text: 'x'.repeat(501), via: 'voice', listenMs: 1 })))).toContain('longer than 500');
  expect(failure(() => as(db, PARTNER, (c) => m.askQuestion(c, { requestId: 'r-via', text: 'Hi', via: 'carrier pigeon', listenMs: 1 })))).toContain('via must be');
});

test('a question can be cancelled by the partner until it is picked', () => {
  const db = newDb();
  const q = ask(db);
  as(db, PARTNER, (c) => m.cancelQuestion(c, { questionId: q.id }));
  expect(question(db, q.id).status.tag).toBe('Cancelled');
  expect(scan(db).phase.tag).toBe('Idle');
  expect(failure(() => as(db, PARTNER, (c) => m.cancelQuestion(c, { questionId: q.id })))).toBe('already released, picked or ended');
  const q2 = ask(db);
  publish(db, q2.id, [reply('Yes')]);
  expect(question(db, q2.id).status.tag).toBe('Ready');
});
