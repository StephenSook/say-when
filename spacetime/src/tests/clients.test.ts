// Module v2 (docs/spacetime.md section 14): what the dashboard and the agent sidecar need to show and act on live
// data. The call board names the option, the read-back, the confirm window and the commands; the errand board names
// the option; a select step means a pick; a paused or ended scan keeps its pick; each option read is a speak step
// with room for the station's word timings; a stale CONFIRM cannot dial; an ended call keeps its hold; the agent can
// read the consent; and the board has session-scoped views of the pipeline and the ledger.
import { expect, test } from 'vitest';
import * as m from '../index';
import {
  advance,
  AGENT,
  as,
  auth,
  beat,
  CALL_DIGEST,
  callOption,
  errandOption,
  failure,
  FORM_KEY,
  gesture,
  grantConsent,
  internal,
  live,
  micros,
  newDb,
  OWNER,
  options,
  PARTNER,
  publish,
  ask,
  question,
  reply,
  scan,
  scanning,
  sessionId,
  settle,
  STATION,
  tick,
  timerAt,
  type Test,
} from './harness';

const anon = (db: Test) => db.anonymousViewContext();
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** The session's pipeline events for one question, oldest first. */
function eventsOf(db: Test, questionId: bigint) {
  return [...db.db.pipelineEvent.eventBySession.filter(sessionId(db))]
    .filter((e) => e.questionId === questionId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

const readsOf = (db: Test, questionId: bigint) => eventsOf(db, questionId).filter((e) => e.stage === 'speak' && e.eventKey.includes(':read:'));
const selectsOf = (db: Test, questionId: bigint) => eventsOf(db, questionId).filter((e) => e.stage === 'select');
const counts = (e: { countsJson: string }) => JSON.parse(e.countsJson) as Record<string, number | boolean>;
const byEvent = <T extends { eventId: bigint }>(rows: T[]) => [...rows].sort((a, b) => (a.eventId < b.eventId ? -1 : 1));

/** The station reports word timings for one read of the active session. State is read before the transaction. */
function timings(db: Test, stepSeq: bigint, optionId: bigint, startsMs: number[], endsMs: number[], sid: bigint = sessionId(db)): void {
  as(db, STATION, (x) => m.reportWordTimings(x, { sessionId: sid, stepSeq, optionId, startsMs, endsMs }));
}

function callOf(db: Test) {
  const rows = [...db.db.callRequest.callBySession.filter(scan(db).sessionId)];
  return rows[rows.length - 1]!;
}

/** A call picked, read back and confirmed: Confirmed, not yet claimed. Returns the confirm's gesture row. */
function confirmedCall(db: Test) {
  grantConsent(db, 'call', 'leon');
  scanning(db, [callOption(db)]);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick_call');
  const c = callOf(db);
  as(db, STATION, (x) => m.reportReadbackDone(x, { kind: 'call', id: c.id, digest: CALL_DIGEST }));
  live(db, 1500);
  const confirm = gesture(db, 'CONFIRM', { heardDigest: CALL_DIGEST });
  expect(confirm.outcome).toBe('accepted:confirm');
  return confirm;
}

/** A call the agent claimed and the Dialer connected. */
function connectedCall(db: Test) {
  confirmedCall(db);
  const c = callOf(db);
  as(db, AGENT, (x) => m.claimCall(x, { callId: c.id, digest: CALL_DIGEST }));
  as(db, AGENT, (x) => m.reportCallStatus(x, { callId: c.id, attempt: 1, status: 'connected', result: '', endReason: '', reasonCode: '', reason: '' }));
  expect(callOf(db).status.tag).toBe('Connected');
  return callOf(db);
}

// ---------- 1 and 2: the call and errand boards ----------

test('board_calls gives the dashboard the option, the read-back time, the confirm window and the confirm and stop commands', () => {
  const db = newDb();
  const confirm = confirmedCall(db);
  const call = callOf(db);
  const picked = options(db, call.questionId, 1)[0]!;
  const row = m.boardCalls(anon(db))[0]!;
  expect(row.optionId).toBe(picked.id);
  expect([micros(row.readbackDoneAt), micros(row.confirmOpensAt), micros(row.confirmClosesAt)]).toEqual([
    micros(call.readbackDoneAt),
    micros(call.confirmOpensAt),
    micros(call.confirmClosesAt),
  ]);
  expect([row.confirmGestureId, row.stopGestureId, row.held]).toEqual([confirm.gestureId, '', false]);
  // STOP hangs up the live call: the board names that command too.
  as(db, AGENT, (x) => m.claimCall(x, { callId: call.id, digest: CALL_DIGEST }));
  const stop = gesture(db, 'STOP');
  expect(stop.outcome).toBe('accepted:hang_up');
  expect(m.boardCalls(anon(db))[0]!.stopGestureId).toBe(stop.gestureId);
});

test('board_calls names the NO that stopped a call before it dialed', () => {
  const db = newDb();
  grantConsent(db, 'call', 'leon');
  scanning(db, [callOption(db)]);
  gesture(db, 'YES');
  const c = callOf(db);
  as(db, STATION, (x) => m.reportReadbackDone(x, { kind: 'call', id: c.id, digest: CALL_DIGEST }));
  settle(db);
  const no = gesture(db, 'NO');
  expect(no.outcome).toBe('accepted:stop_call');
  const row = m.boardCalls(anon(db))[0]!;
  expect([row.status.tag, row.reasonCode, row.confirmGestureId, row.stopGestureId]).toEqual(['Stopped', 'no', '', no.gestureId]);
  expect(row.readbackDoneAt).toBeDefined();
});

test('board_errands names the option the person picked', () => {
  const db = newDb();
  grantConsent(db, 'errand', FORM_KEY);
  const q = scanning(db, [reply('Nothing else'), errandOption()]);
  expect(gesture(db, 'NO').outcome).toBe('accepted:skip'); // option 1 refused: option 2, the errand, is read
  settle(db);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick_errand');
  const row = m.boardErrands(anon(db))[0]!;
  expect(row.optionId).toBe(options(db, q.id, 1)[1]!.id);
  expect(row.optionId).not.toBe(0n);
});

// ---------- 3: a select step means a pick ----------

test('a scan that ends without a pick writes no select step; its outcome stays on scan_state', () => {
  const db = newDb();
  const q = scanning(db, [reply('Yes'), reply('No')]);
  for (let i = 0; i < 8; i++) tick(db); // two passes of reading and window over two options
  expect([scan(db).phase.tag, scan(db).outcome?.tag]).toEqual(['Idle', 'NoPick']);
  expect(selectsOf(db, q.id)).toEqual([]);
  // STOP while options are read: none of these, and still no select step.
  const q2 = scanning(db, [reply('Tea'), reply('Coffee')]);
  expect(gesture(db, 'STOP').outcome).toBe('accepted:none');
  expect(scan(db).outcome?.tag).toBe('None');
  expect(selectsOf(db, q2.id)).toEqual([]);
  // STOP during the veto: stopped, nothing said, no select step.
  const q3 = scanning(db, [reply('Juice'), reply('Water')]);
  settle(db);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick');
  expect(gesture(db, 'STOP').outcome).toBe('accepted:stop_reply');
  expect(scan(db).outcome?.tag).toBe('Stopped');
  expect(selectsOf(db, q3.id)).toEqual([]);
});

test('a reply pick writes one select step when the veto ends, with the option id and rank', () => {
  const db = newDb();
  const q = scanning(db, [reply('Yes, please'), reply('No, thank you')]);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick');
  expect(selectsOf(db, q.id)).toEqual([]); // NO or STOP can still cancel it
  tick(db); // VetoEnd: released
  const picked = options(db, q.id, 1)[0]!;
  const steps = selectsOf(db, q.id);
  expect(steps.map((e) => [e.status, e.detail])).toEqual([['ok', 'picked']]);
  expect(counts(steps[0]!)).toEqual({ optionId: Number(picked.id), rank: 1, pass: 1 });
});

test('an errand pick writes its select step at the pick', () => {
  const db = newDb();
  grantConsent(db, 'errand', FORM_KEY);
  const q = scanning(db, [errandOption(), reply('Nothing else')]);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick_errand');
  const steps = selectsOf(db, q.id);
  expect(steps.map((e) => [e.status, e.detail])).toEqual([['ok', 'picked']]);
  expect(counts(steps[0]!).optionId).toBe(Number(options(db, q.id, 1)[0]!.id));
});

// ---------- 4: a paused or ended scan keeps its pick ----------

test('a paused scan keeps the pick it ended with; a pause during the veto still cancels the pick', () => {
  const db = newDb();
  const q = scanning(db, [reply('Yes, please'), reply('No, thank you')]);
  gesture(db, 'YES');
  tick(db); // released
  const picked = options(db, q.id, 1)[0]!;
  expect([scan(db).outcome?.tag, scan(db).pickedOptionId]).toEqual(['Picked', picked.id]);
  expect(gesture(db, 'HEADSET_OFF').outcome).toBe('accepted:pause');
  const s = scan(db);
  expect([s.phase.tag, s.outcome?.tag, s.pickedOptionId, s.pickedRank]).toEqual(['Paused', 'Picked', picked.id, 1]);
  // Healthy contact resumes it, and the pick is still there.
  live(db, 3500);
  expect([scan(db).phase.tag, scan(db).outcome?.tag, scan(db).pickedOptionId]).toEqual(['Idle', 'Picked', picked.id]);

  const db2 = newDb();
  scanning(db2, [reply('Yes'), reply('No')]);
  gesture(db2, 'YES');
  gesture(db2, 'HEADSET_OFF'); // during the veto: the pick is cancelled
  expect([scan(db2).phase.tag, scan(db2).outcome, scan(db2).pickedOptionId]).toEqual(['Paused', undefined, undefined]);
});

test('ending the session keeps a finished scan\'s pick and outcome; an open scan still ends cancelled with no pick', () => {
  const db = newDb();
  grantConsent(db, 'errand', FORM_KEY);
  const q = scanning(db, [errandOption(), reply('Nothing else')]);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick_errand');
  const picked = options(db, q.id, 1)[0]!;
  as(db, STATION, (x) => m.endSession(x, {}));
  expect([scan(db).phase.tag, scan(db).outcome?.tag, scan(db).pickedOptionId, scan(db).pickedRank]).toEqual(['Idle', 'Picked', picked.id, 1]);

  // Picked, then paused, then ended: still the pick.
  const db2 = newDb();
  const q2 = scanning(db2, [reply('Yes'), reply('No')]);
  gesture(db2, 'YES');
  tick(db2);
  gesture(db2, 'HEADSET_OFF');
  as(db2, STATION, (x) => m.endSession(x, {}));
  expect([scan(db2).outcome?.tag, scan(db2).pickedOptionId]).toEqual(['Picked', options(db2, q2.id, 1)[0]!.id]);

  // An open scan, or one paused mid-scan, ends cancelled with no pick.
  const db3 = newDb();
  scanning(db3);
  as(db3, STATION, (x) => m.endSession(x, {}));
  expect([scan(db3).outcome?.tag, scan(db3).pickedOptionId]).toEqual(['Cancelled', undefined]);
  const db4 = newDb();
  scanning(db4);
  gesture(db4, 'HEADSET_OFF');
  as(db4, STATION, (x) => m.endSession(x, {}));
  expect([scan(db4).outcome?.tag, scan(db4).pickedOptionId]).toEqual(['Cancelled', undefined]);
});

// ---------- 5: one speak step per option read, and the station's word timings ----------

test('each option read is one speak step with its option id, rank, pass and dwell', () => {
  const db = newDb();
  const q = scanning(db, [reply('Yes, please'), reply('No, thank you'), reply('Later')]); // clips of 1000 ms
  const opts = options(db, q.id, 1);
  let reads = readsOf(db, q.id);
  expect(reads).toHaveLength(1);
  const first = reads[0]!;
  expect([first.status, first.detail, first.ms, first.actor]).toEqual(['started', 'reading option', undefined, 'Module']);
  expect(first.eventKey).toBe(`s${sessionId(db)}:read:${scan(db).stepSeq}`);
  expect(counts(first)).toEqual({ optionId: Number(opts[0]!.id), rank: 1, pass: 1, stepSeq: Number(scan(db).stepSeq), durationMs: 1150, estimated: false });
  tick(db); // the window after option 1: no read
  expect(readsOf(db, q.id)).toHaveLength(1);
  tick(db); // option 2
  expect(gesture(db, 'NO').outcome).toBe('accepted:skip'); // straight on to option 3
  reads = readsOf(db, q.id);
  expect(reads.map((e) => [counts(e).rank, counts(e).optionId])).toEqual([
    [1, Number(opts[0]!.id)],
    [2, Number(opts[1]!.id)],
    [3, Number(opts[2]!.id)],
  ]);
  expect(new Set(reads.map((e) => e.eventKey)).size).toBe(3);
  // Without measured clips the dwell is an estimate, and the step says so.
  const q2 = ask(db, 'Something else?');
  const v = publish(db, q2.id, [reply('Yes, please')]);
  const deadline = [...db.db.scanTimer.sessionId.filter(sessionId(db))].find((r) => r.kind.tag === 'ClipDeadline')!;
  db.clock.set(timerAt(deadline));
  internal(db, (x) => m.scanTick(x, { job: deadline }));
  const est = readsOf(db, q2.id);
  expect(est.map((e) => [counts(e).estimated, counts(e).durationMs])).toEqual([[true, 300 + 60 * 'Yes, please'.length + 150]]);
  expect(v).toBe(1);
});

test('a yes or no prompt read is a speak step with rank 0 and no option', () => {
  const db = newDb();
  const q = scanning(db, [reply('Yes'), reply('No')], 'yes_no');
  const reads = readsOf(db, q.id);
  expect(reads.map((e) => [e.detail, counts(e).rank, counts(e).optionId, counts(e).durationMs])).toEqual([['yes or no prompt', 0, 0, 900]]);
});

test("the station's word timings attach to one read, once, and the board shows them", () => {
  const db = newDb();
  const q = scanning(db, [reply('Yes, please'), reply('No, thank you')]);
  const o1 = options(db, q.id, 1)[0]!;
  const step = scan(db).stepSeq;
  timings(db, step, o1.id, [0, 320], [300, 700]);
  const read = readsOf(db, q.id)[0]!;
  const rows = () => byEvent(m.boardWordTimings(anon(db))).map((r) => [r.eventId, r.sessionId, r.questionId, r.optionId, r.rank, r.stepSeq, r.startsMs, r.endsMs]);
  expect(rows()).toEqual([[read.id, sessionId(db), q.id, o1.id, 1, step, [0, 320], [300, 700]]]);
  // A retry, even with other numbers, changes nothing: one row per read.
  timings(db, step, o1.id, [10], [20]);
  expect(rows()).toHaveLength(1);
  // The second pass reads option 1 again: its own step, its own row.
  for (let i = 0; i < 4; i++) tick(db);
  const again = scan(db);
  expect([again.cursor, again.pass]).toEqual([1, 2]);
  timings(db, again.stepSeq, o1.id, [0, 320], [300, 700]);
  expect(rows().map((r) => r[5])).toEqual([step, again.stepSeq]);
  // A yes or no prompt (option 0) can carry timings too. (State is read before the transaction: reading the test
  // database inside one deadlocks it.)
  const q2 = scanning(db, [reply('Yes'), reply('No')], 'yes_no');
  const promptStep = scan(db).stepSeq;
  timings(db, promptStep, 0n, [0, 200, 350], [180, 330, 600]);
  expect(m.boardWordTimings(anon(db)).filter((r) => r.questionId === q2.id).map((r) => [r.rank, r.optionId])).toEqual([[0, 0n]]);
});

test('word timings reported after the scan moved on still attach to their read, and a retry then changes nothing', () => {
  const db = newDb();
  const yn = scanning(db, [reply('Yes'), reply('No')], 'yes_no');
  const promptStep = scan(db).stepSeq;
  const q = scanning(db, [reply('Tea'), reply('Coffee')]); // a new question: the scan has moved on
  const optionStep = scan(db).stepSeq;
  const tea = options(db, q.id, 1)[0]!;
  const q3 = scanning(db, [reply('Juice'), reply('Water')]); // and on again
  expect(scan(db).questionId).toBe(q3.id);
  const report = (stepSeq: bigint, optionId: bigint, startsMs: number[], endsMs: number[]) => timings(db, stepSeq, optionId, startsMs, endsMs);
  report(promptStep, 0n, [0, 200], [180, 400]);
  report(optionStep, tea.id, [0], [300]);
  report(promptStep, 0n, [1], [2]); // retries, after the question changed
  report(optionStep, tea.id, [1], [2]);
  const rows = byEvent(m.boardWordTimings(anon(db))).map((r) => [r.questionId, r.optionId, r.rank, r.stepSeq, r.startsMs]);
  expect(rows).toEqual([
    [yn.id, 0n, 0, promptStep, [0, 200]],
    [q.id, tea.id, 1, optionStep, [0]],
  ]);
});

test("a late report from an earlier session never lands on the next session's read at the same step", () => {
  const db = newDb();
  scanning(db, [reply('Yes'), reply('No')], 'yes_no');
  const first = sessionId(db);
  const step = scan(db).stepSeq;
  as(db, STATION, (x) => m.endSession(x, {}));
  as(db, STATION, (x) => m.startSession(x, { label: 'demo' }));
  beat(db);
  const q2 = scanning(db, [reply('Yes'), reply('No')], 'yes_no');
  const second = sessionId(db);
  expect(scan(db).stepSeq).toBe(step); // step numbers restart in each session
  expect(failure(() => timings(db, step, 0n, [0], [100], first))).toBe('not the active session');
  expect(m.boardWordTimings(anon(db))).toEqual([]);
  timings(db, step, 0n, [0], [100], second);
  expect(m.boardWordTimings(anon(db)).map((r) => [r.sessionId, r.questionId])).toEqual([[second, q2.id]]);
});

test('only a read the module wrote takes word timings, and an agent cannot write under a key the module owns', () => {
  const db = newDb();
  const q = scanning(db, [reply('Yes, please'), reply('No, thank you')]);
  const sid = sessionId(db);
  // A speak row under a read key that the module did not write (inserted behind the reducers' back).
  db.db.pipelineEvent.insert({
    id: 0n,
    eventKey: `s${sid}:read:99`,
    sessionId: sid,
    questionId: q.id,
    stage: 'speak',
    status: 'started',
    detail: 'reading option',
    ms: undefined,
    countsJson: JSON.stringify({ optionId: 0, rank: 0 }),
    actor: 'Agent',
    at: db.clock.now(),
  });
  expect(failure(() => timings(db, 99n, 0n, [0], [100]))).toBe('no such read');
  // agent_progress refuses every prefix the module writes its own steps under; the sidecar's keys start with the job id.
  const q2 = ask(db, 'Something else?');
  const job = [...db.db.agentJob.jobByQuestion.filter(q2.id)][0]!;
  as(db, AGENT, (x) => m.agentClaim(x, { jobId: job.id }));
  const progress = (eventKey: string) => () =>
    as(db, AGENT, (x) => m.agentProgress(x, { jobId: job.id, attempt: 1, eventKey, stage: 'speak', status: 'started', detail: 'reading option', ms: 0, countsJson: '', payloadJson: '' }));
  for (const key of [`s${sid}:read:12`, `q${q2.id}:select`, `q${q2.id}:v1:plan`, 'e1:sent', 'c1:dialing', 'listen:req-9']) {
    expect(failure(progress(key)), key).toBe('event_key uses a prefix the module writes');
  }
  progress(`${job.id}:1:0:plan:started`)();
  expect(db.db.pipelineEvent.eventKey.find(`${job.id}:1:0:plan:started`)?.actor).toBe('Agent');
});

test('report_word_timings refuses timings out of order or out of range, an unknown read and another role', () => {
  const db = newDb();
  const q = scanning(db, [reply('Yes, please'), reply('No, thank you')]);
  const [o1, o2] = options(db, q.id, 1);
  const step = scan(db).stepSeq;
  const sid = sessionId(db);
  const call = (args: { sessionId?: bigint; stepSeq?: bigint; optionId?: bigint; startsMs: number[]; endsMs: number[] }, who = STATION) =>
    failure(() =>
      as(db, who, (x) =>
        m.reportWordTimings(x, { sessionId: args.sessionId ?? sid, stepSeq: args.stepSeq ?? step, optionId: args.optionId ?? o1!.id, startsMs: args.startsMs, endsMs: args.endsMs }),
      ),
    );
  expect(call({ startsMs: [], endsMs: [] })).toBe('word timings: 1 to 100 words');
  expect(call({ startsMs: Array.from({ length: 101 }, (_, i) => i), endsMs: Array.from({ length: 101 }, (_, i) => i) })).toBe('word timings: 1 to 100 words');
  expect(call({ startsMs: [0, 100], endsMs: [50] })).toBe('starts_ms and ends_ms must have the same length');
  expect(call({ startsMs: [300, 100], endsMs: [400, 200] })).toBe('word timings must be in order, each end at or after its start, at most 30000 ms');
  expect(call({ startsMs: [100], endsMs: [50] })).toBe('word timings must be in order, each end at or after its start, at most 30000 ms');
  expect(call({ startsMs: [0], endsMs: [30_001] })).toBe('word timings must be in order, each end at or after its start, at most 30000 ms');
  expect(call({ sessionId: sid + 1n, startsMs: [0], endsMs: [10] })).toBe('not the active session');
  expect(call({ optionId: 999n, startsMs: [0], endsMs: [10] })).toBe('not the option read at that step');
  expect(call({ stepSeq: step + 7n, startsMs: [0], endsMs: [10] })).toBe('no such read');
  expect(call({ stepSeq: step - 1n, startsMs: [0], endsMs: [10] })).toBe('no such read'); // a step that was not a read
  expect(call({ optionId: o2!.id, startsMs: [0], endsMs: [10] })).toBe('not the option read at that step');
  expect(call({ startsMs: [0], endsMs: [10] }, PARTNER)).toBe('not allowed');
  expect(m.boardWordTimings(anon(db))).toEqual([]);
});

// ---------- 6: a stale CONFIRM cannot dial ----------

test('call_queue carries the CONFIRM time, and claim_call refuses a CONFIRM older than the 12 s claim window', () => {
  const db = newDb();
  confirmedCall(db);
  const call = callOf(db);
  const queue = m.callQueue(db.viewContext(auth(AGENT)));
  expect(queue.map((r) => [r.callId, r.status.tag, micros(r.confirmedAt)])).toEqual([[call.id, 'Confirmed', micros(call.confirmedAt)]]);
  live(db, 12_000); // contact stays good; the CONFIRM is now 12 s old
  expect(failure(() => as(db, AGENT, (x) => m.claimCall(x, { callId: call.id, digest: CALL_DIGEST })))).toBe('confirm expired');
  expect(callOf(db).status.tag).toBe('Confirmed');

  // Inside the window the claim goes through, and the claim window's timer goes with it.
  const db2 = newDb();
  confirmedCall(db2);
  const c2 = callOf(db2);
  live(db2, 11_500);
  as(db2, AGENT, (x) => m.claimCall(x, { callId: c2.id, digest: CALL_DIGEST }));
  expect(callOf(db2).status.tag).toBe('Dialing');
  expect([...db2.db.callTimer.callId.filter(c2.id)].map((r) => r.kind.tag)).toEqual(['Lease']);
  expect(m.callQueue(db2.viewContext(auth(AGENT)))[0]!.confirmedAt).toEqual(c2.confirmedAt);
});

test('an unclaimed confirmed call is stopped when its claim window closes, and ensure_timers re-arms that timer', () => {
  const db = newDb();
  confirmedCall(db);
  const call = callOf(db);
  const windowTimer = () => [...db.db.callTimer.callId.filter(call.id)].find((r) => r.kind.tag === 'ConfirmWindow');
  const t = windowTimer()!;
  expect([t.seq, micros(timerAt(t)) - micros(call.confirmedAt)]).toEqual([call.windowSeq, 12_000_000n]);
  // Run early (an overdue timer of the same seq could), it does nothing: the deadline is decided by elapsed time.
  internal(db, (x) => m.callTimeout(x, { job: t }));
  expect(callOf(db).status.tag).toBe('Confirmed');
  db.clock.set(timerAt(t));
  internal(db, (x) => m.callTimeout(x, { job: t }));
  const stopped = callOf(db);
  expect([stopped.status.tag, stopped.reasonCode, stopped.reason]).toEqual(['Stopped', 'confirm_expired', 'Too much time passed after the confirm. No call was made.']);
  const board = m.boardCalls(anon(db))[0]!;
  expect([board.reasonCode, board.reason]).toEqual(['confirm_expired', 'Too much time passed after the confirm. No call was made.']);

  const db2 = newDb();
  confirmedCall(db2);
  const c2 = callOf(db2);
  for (const r of [...db2.db.callTimer.callId.filter(c2.id)]) db2.db.callTimer.scheduledId.delete(r.scheduledId);
  as(db2, OWNER, (x) => m.ensureTimers(x, {}));
  const rearmed = [...db2.db.callTimer.callId.filter(c2.id)];
  expect(rearmed.map((r) => [r.kind.tag, r.seq, micros(timerAt(r)) - micros(c2.confirmedAt)])).toEqual([['ConfirmWindow', c2.windowSeq, 12_000_000n]]);
});

// ---------- 7: an ended call keeps its reason, and the board says when a contact is on hold ----------

test('an ended call keeps its listed reason code and sentence, and board_calls says when the contact is on hold', () => {
  const db = newDb();
  const c = connectedCall(db);
  const sentence = 'Leon may not want more calls. Calls to Leon are on hold until someone checks.';
  as(db, AGENT, (x) => m.reportCallStatus(x, { callId: c.id, attempt: 1, status: 'ended', result: 'answered', endReason: 'hangup', reasonCode: 'opt_out_hold', reason: sentence }));
  const call = callOf(db);
  expect([call.status.tag, call.result, call.reasonCode, call.reason]).toEqual(['Ended', 'answered', 'opt_out_hold', sentence]);
  const off = m.boardCalls(anon(db))[0]!;
  expect([off.held, off.reasonCode, off.reason, off.contactName]).toEqual([true, 'opt_out_hold', 'Calls to this contact are on hold until someone checks.', 'Contact']);
  grantConsent(db, 'board_text');
  as(db, OWNER, (x) => m.setBoardSharing(x, { on: true }));
  const on = m.boardCalls(anon(db))[0]!;
  expect([on.held, on.reason, on.contactName]).toEqual([true, sentence, 'Leon']);

  // A call that ended with nothing held: no code, not held.
  const db2 = newDb();
  const c2 = connectedCall(db2);
  as(db2, AGENT, (x) => m.reportCallStatus(x, { callId: c2.id, attempt: 1, status: 'ended', result: 'answered', endReason: '', reasonCode: '', reason: '' }));
  const plain = m.boardCalls(anon(db2))[0]!;
  expect([plain.held, plain.reasonCode, plain.reason]).toEqual([false, '', '']);

  // A code that is not on the fixed list is not stored for an ended call.
  const db3 = newDb();
  const c3 = connectedCall(db3);
  as(db3, AGENT, (x) => m.reportCallStatus(x, { callId: c3.id, attempt: 1, status: 'ended', result: 'answered', endReason: '', reasonCode: 'Jane Doe hung up', reason: '' }));
  expect(callOf(db3).reasonCode).toBe('');
});

test('a failed or refused call whose sentence says the contact is on hold is held on the board too', () => {
  const db = newDb();
  const c = connectedCall(db);
  as(db, AGENT, (x) =>
    m.reportCallStatus(x, { callId: c.id, attempt: 1, status: 'failed', result: 'unknown', endReason: '', reasonCode: 'end_unknown', reason: 'I lost track of the call. Calls to Leon are on hold until someone checks.' }),
  );
  const row = m.boardCalls(anon(db))[0]!;
  expect([row.status.tag, row.held, row.reasonCode, row.reason]).toEqual(['Failed', true, 'end_unknown', '']);
  expect(show(row)).not.toContain('Leon');

  const db2 = newDb();
  confirmedCall(db2);
  const c2 = callOf(db2);
  as(db2, AGENT, (x) => m.claimCall(x, { callId: c2.id, digest: CALL_DIGEST }));
  as(db2, AGENT, (x) =>
    m.reportCallStatus(x, { callId: c2.id, attempt: 1, status: 'refused', result: 'refused', endReason: '', reasonCode: 'opt_out_hold', reason: 'Calls to that person are on hold until someone checks, so I did not call.' }),
  );
  expect(m.boardCalls(anon(db2))[0]!.held).toBe(true);
});

// ---------- 8: the agent can read the consent ----------

test('agent_consent shows the agent the memory and web search consent now, and nobody else', () => {
  const db = newDb();
  const read = () => m.agentConsent(db.viewContext(auth(AGENT))).map((r) => [r.sessionId, r.memoryAllowed, r.webSearchAllowed]);
  expect(read()).toEqual([[sessionId(db), false, false]]);
  grantConsent(db, 'memory');
  expect(read()).toEqual([[sessionId(db), true, false]]);
  grantConsent(db, 'web_search');
  expect(read()).toEqual([[sessionId(db), true, true]]);
  const memory = [...db.db.consent.consentByScope.filter({ tag: 'Memory' })][0]!;
  as(db, PARTNER, (x) => m.revokeConsent(x, { consentId: memory.id })); // the partner phone is a caregiver
  expect(read()).toEqual([[sessionId(db), false, true]]);
  for (const who of [STATION, PARTNER, 'stranger']) expect(m.agentConsent(db.viewContext(auth(who)))).toEqual([]);
  // Between sessions the agent still reads it, with session 0.
  as(db, STATION, (x) => m.endSession(x, {}));
  expect(read()).toEqual([[0n, false, true]]);
});

// ---------- 9: session-scoped board views ----------

test('board_events, board_session_ledger and board_word_timings hold only the board session\'s rows', () => {
  const db = newDb();
  const q1 = scanning(db);
  const read1 = { stepSeq: scan(db).stepSeq, optionId: options(db, q1.id, 1)[0]!.id };
  timings(db, read1.stepSeq, read1.optionId, [0], [400]);
  const first = sessionId(db);
  as(db, STATION, (x) => m.endSession(x, {}));
  as(db, STATION, (x) => m.startSession(x, { label: 'demo' }));
  beat(db);
  const second = sessionId(db);
  expect(second).not.toBe(first);
  const q2 = scanning(db, [reply('Tea'), reply('Coffee')]);
  const read2 = { stepSeq: scan(db).stepSeq, optionId: options(db, q2.id, 1)[0]!.id };
  timings(db, read2.stepSeq, read2.optionId, [0], [300]);

  const events = m.boardEvents(anon(db));
  expect(events.length).toBeGreaterThan(3);
  expect(new Set(events.map((e) => e.sessionId))).toEqual(new Set([second]));
  expect(events.map((e) => e.id).sort()).toEqual([...db.db.pipelineEvent.eventBySession.filter(second)].map((e) => e.id).sort());
  const ledger = m.boardSessionLedger(anon(db));
  expect(new Set(ledger.map((r) => r.sessionId))).toEqual(new Set([second]));
  expect(ledger.length).toBe([...db.db.ledger.ledgerBySession.filter(second)].length);
  expect(ledger.map((r) => r.kind)).toContain('session_start');
  expect(m.boardWordTimings(anon(db)).map((r) => r.sessionId)).toEqual([second]);
  // The unscoped ledger view still holds every session.
  const all = db.runQuery<{ sessionId: bigint }>(m.boardLedger(anon(db)));
  expect(new Set(all.map((r) => r.sessionId))).toContain(first);
  // After the session ends, the board keeps showing it, as public_board does.
  as(db, STATION, (x) => m.endSession(x, {}));
  expect(new Set(m.boardEvents(anon(db)).map((e) => e.sessionId))).toEqual(new Set([second]));
  expect(m.boardSessionLedger(anon(db)).map((r) => r.kind)).toContain('session_end');
});

test('the new board and agent surfaces carry no conversation content', () => {
  const db = newDb();
  grantConsent(db, 'memory');
  const q = scanning(db, [reply('Yes, please'), reply('No, thank you')]);
  const read = { stepSeq: scan(db).stepSeq, optionId: options(db, q.id, 1)[0]!.id };
  timings(db, read.stepSeq, read.optionId, [0, 320], [300, 700]);
  gesture(db, 'YES');
  tick(db);
  advance(db, 100);
  const rows = [
    ...m.boardEvents(anon(db)),
    ...m.boardSessionLedger(anon(db)),
    ...m.boardWordTimings(anon(db)),
    ...m.agentConsent(db.viewContext(auth(AGENT))),
    ...m.boardCalls(anon(db)),
    ...m.boardErrands(anon(db)),
  ];
  expect(rows.length).toBeGreaterThan(10);
  for (const row of rows) for (const w of ['water', 'Yes, please', 'No, thank you']) expect(show(row)).not.toContain(w);
  expect(question(db, q.id).replyText).toBe('Yes, please');
});
