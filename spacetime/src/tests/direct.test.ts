// Direct select (D18, docs/direct-select.md): four gestures pick four options. The list is read once in rank
// order, then the clock waits for a pick; a reply is said at once; a Search, an errand and a call get a read-back
// and a two-option confirm (PICK_1 confirms, PICK_2 cancels); a Category starts its search with no confirm.
import { expect, test } from 'vitest';
import * as m from '../index';
import {
  advance,
  AGENT,
  as,
  ask,
  auth,
  beat,
  CALL_DIGEST,
  callOption,
  claim,
  clips,
  currentTimer,
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
  publish,
  question,
  reply,
  scan,
  settle,
  STATION,
  tick,
  timerAt,
  type Test,
} from './harness';
import type { OptionInput, Question } from '../schema';

function opt(kind: 'reply' | 'search' | 'category', label: string, text: string): OptionInput {
  return { kind, text, tone: '', laugh: false, provenance: 'model', sources: [], memoryRefs: [], actionJson: '', label };
}

const SMALL_TALK = [
  opt('reply', 'Good', "I'm doing awesome, how about you?"),
  opt('reply', 'Not great', 'Not great today.'),
  opt('reply', 'Tired', 'A bit tired.'),
  opt('reply', 'Excited', 'Excited, actually!'),
];

const PLANS = [
  opt('reply', 'Yes', 'Yes, I would love to.'),
  opt('reply', 'No', 'Not today, thanks.'),
  opt('search', 'Search the web', 'Search the web for ideas'),
  opt('reply', 'Something else', 'Let me think about it.'),
];

const CATEGORIES = [
  opt('category', 'Nature', 'Nature'),
  opt('category', 'Fun', 'Fun'),
  opt('category', 'Thrill', 'Thrill'),
  opt('category', 'Something else', 'Something else'),
];

const DIGEST = 'a1b2c3d4e5f60718';

/** A question asked in Direct mode, options published and clips in: option 1 is being read. */
function listening(db: Test, opts: OptionInput[] = SMALL_TALK, text = 'Hey, how are you?'): Question {
  const q = ask(db, text);
  const v = publish(db, q.id, opts);
  clips(db, q.id, v, 800);
  return question(db, q.id);
}

/** Reads the whole list, with a heartbeat after each read: the clock is in the wait after the last option. */
function waiting(db: Test, opts: OptionInput[] = SMALL_TALK): Question {
  const q = listening(db, opts);
  for (let i = 0; i < opts.length; i++) {
    tick(db);
    beat(db);
  }
  expect(scan(db).phase.tag).toBe('Window');
  return q;
}

/** The agent claims a follow-up's job of this kind and publishes one final version; the station's clips start it. */
function answer(db: Test, questionId: bigint, kind: 'Categories' | 'Search', opts: OptionInput[]): void {
  const job = claim(db, questionId, kind);
  as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: job.attempt, answerMode: 'pick', options: opts, final: true }));
  clips(db, questionId, question(db, questionId).version, 700);
}

function searchOf(db: Test) {
  const rows = [...db.db.searchRequest.searchBySession.filter(scan(db).sessionId)];
  return rows[rows.length - 1]!;
}

function errandOf(db: Test) {
  const rows = [...db.db.errand.errandBySession.filter(scan(db).sessionId)];
  return rows[rows.length - 1]!;
}

function callOf(db: Test) {
  const rows = [...db.db.callRequest.callBySession.filter(scan(db).sessionId)];
  return rows[rows.length - 1]!;
}

function jobsOf(db: Test, questionId: bigint) {
  return [...db.db.agentJob.jobByQuestion.filter(questionId)];
}

/** Picks the Search option (rank 3 of PLANS) and reads its read-back: the request is AwaitingConfirm, past the hold. */
function searchAwaiting(db: Test) {
  grantConsent(db, 'web_search');
  const q = listening(db, PLANS, 'Anything you want to do today in San Francisco?');
  live(db, 200);
  expect(gesture(db, 'PICK_3').outcome).toBe('accepted:pick_search');
  const r = searchOf(db);
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'search', id: r.id, digest: r.digest }));
  live(db, 1500);
  return { q, r: searchOf(db) };
}

// ---------- The clock ----------

test('direct mode is the default on a new database, and the list is read once in rank order with no window', () => {
  const db = newDb('direct');
  expect(db.db.config.id.find(0)!.inputMode.tag).toBe('Direct');
  listening(db);
  const first = scan(db);
  expect([first.phase.tag, first.cursor, first.optionCount, first.pass]).toEqual(['Reading', 1, 4, 1]);
  expect(first.listStartSeq).toBe(first.stepSeq);
  for (const rank of [2, 3, 4]) {
    tick(db);
    expect([scan(db).phase.tag, scan(db).cursor]).toEqual(['Reading', rank]);
  }
  tick(db);
  const wait = scan(db);
  expect([wait.phase.tag, wait.cursor]).toEqual(['Window', 4]);
  expect(micros(timerAt(currentTimer(db))) - micros(now(db))).toBe(120_000_000n); // idle_pause_ms
  expect(wait.listStartSeq).toBe(first.listStartSeq);
});

test('each read writes its speak step with the label and kind in its private payload', () => {
  const db = newDb('direct');
  const q = listening(db, PLANS);
  const reads = [...db.db.pipelineEvent.eventBySession.filter(scan(db).sessionId)].filter((e) => e.detail === 'reading option');
  expect(reads).toHaveLength(1);
  const payload = JSON.parse(db.db.pipelinePayload.eventId.find(reads[0]!.id)!.payloadJson);
  expect([payload.rank, payload.kind, payload.label]).toEqual([1, 'reply', 'Yes']);
  tick(db);
  tick(db);
  const third = [...db.db.pipelineEvent.eventBySession.filter(scan(db).sessionId)].filter((e) => e.detail === 'reading option').pop()!;
  expect(JSON.parse(db.db.pipelinePayload.eventId.find(third.id)!.payloadJson).kind).toBe('search');
  expect(question(db, q.id).status.tag).toBe('Scanning');
});

test('a late clip is estimated from the number and the label the earpiece reads', () => {
  const db = newDb('direct');
  const q = ask(db);
  publish(db, q.id, SMALL_TALK);
  tick(db); // the clip deadline starts the list with estimates
  // "One: Good" is 9 characters: 300 + 60 * 9 = 840 ms, plus the 150 ms pad.
  expect(micros(timerAt(currentTimer(db))) - micros(now(db))).toBe(990_000n);
});

test('silence picks nothing: the wait runs out and the scan ends No pick', () => {
  const db = newDb('direct');
  const q = waiting(db);
  tick(db);
  expect([scan(db).phase.tag, scan(db).outcome?.tag]).toEqual(['Idle', 'NoPick']);
  expect([question(db, q.id).status.tag, question(db, q.id).replyText]).toEqual(['NoPick', undefined]);
});

test('a newer version waits for the end of the list, and one that arrives during the wait is read at once', () => {
  const db = newDb('direct');
  const q = ask(db);
  publish(db, q.id, SMALL_TALK.slice(0, 2), 'pick', false);
  clips(db, q.id, 1);
  const job = jobsOf(db, q.id).find((j) => j.status.tag === 'Claimed')!;
  as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: job.attempt, answerMode: 'pick', options: SMALL_TALK.slice(0, 3), final: false }));
  expect([question(db, q.id).pendingVersion, scan(db).version]).toEqual([2, 1]);
  clips(db, q.id, 2);
  tick(db); // option 2 of version 1
  tick(db); // the end of the list: version 2 switches in, its clips are in, so it is read from option 1
  expect([scan(db).version, scan(db).phase.tag, scan(db).cursor, scan(db).optionCount]).toEqual([2, 'Reading', 1, 3]);
  for (let i = 0; i < 3; i++) tick(db);
  expect(scan(db).phase.tag).toBe('Window');
  as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: job.attempt, answerMode: 'pick', options: SMALL_TALK, final: true }));
  expect([scan(db).version, scan(db).phase.tag]).toEqual([3, 'Preparing']);
  clips(db, q.id, 3);
  expect([scan(db).phase.tag, scan(db).cursor, scan(db).optionCount]).toEqual(['Reading', 1, 4]);
});

test('a yes or no publish is read as options 1 and 2 in direct mode', () => {
  const db = newDb('direct');
  const q = ask(db);
  publish(db, q.id, [opt('reply', 'Yes', 'Yes, please.'), opt('reply', 'No', 'No, thank you.')], 'yes_no');
  expect(question(db, q.id).answerMode.tag).toBe('Pick');
  clips(db, q.id, 1);
  expect([scan(db).answerMode.tag, scan(db).cursor, scan(db).optionCount]).toEqual(['Pick', 1, 2]);
});

test('a pause during the list resumes by reading it again from option 1, as a new list', () => {
  const db = newDb('direct');
  listening(db);
  tick(db);
  beat(db);
  tick(db); // option 3
  beat(db);
  const before = scan(db);
  beat(db, false); // the decoder reports bad contact: a signal pause
  expect([scan(db).phase.tag, scan(db).pauseReason?.tag]).toEqual(['Paused', 'HeadsetOff']);
  live(db, 3500); // healthy beats: the automatic resume
  const after = scan(db);
  expect([after.phase.tag, after.cursor]).toEqual(['Reading', 1]);
  expect(after.listStartSeq).toBeGreaterThan(before.listStartSeq);
  // A pick heard during the old list is stale now.
  settle(db);
  beat(db);
  expect(gesture(db, 'PICK_2', { heardStepSeq: before.stepSeq }).outcome).toBe('ignored:stale_question');
});

// ---------- Picks ----------

test('a reply pick is said in the room at once, with no veto', () => {
  const db = newDb('direct');
  const q = listening(db);
  tick(db); // option 2 is being read; option 3 has not been heard yet, and any rank may be picked
  live(db, 300);
  const g = gesture(db, 'PICK_3');
  expect(g.outcome).toBe('accepted:pick_reply');
  expect([g.optionId, g.questionId]).toEqual([question(db, q.id).pickedOptionId, q.id]);
  const done = question(db, q.id);
  expect([done.status.tag, done.replyText]).toEqual(['Released', 'A bit tired.']);
  expect([scan(db).phase.tag, scan(db).outcome?.tag, scan(db).pickedRank]).toEqual(['Idle', 'Picked', 3]);
  as(db, 'speaker', (ctx) => m.replySpoken(ctx, { questionId: q.id, ms: 1200 }));
  expect(question(db, q.id).status.tag).toBe('Spoken');
});

test('a pick during the wait after the list still counts', () => {
  const db = newDb('direct');
  const q = waiting(db);
  live(db, 500);
  expect(gesture(db, 'PICK_1').outcome).toBe('accepted:pick_reply');
  expect(question(db, q.id).replyText).toBe("I'm doing awesome, how about you?");
});

test('invalid picks are recorded and ignored with a reason', () => {
  const db = newDb('direct');
  expect(gesture(db, 'PICK_1').outcome).toBe('ignored:no_list'); // idle, nothing asked
  const q = ask(db);
  expect(gesture(db, 'PICK_1').outcome).toBe('ignored:no_list'); // preparing
  publish(db, q.id, SMALL_TALK.slice(0, 3));
  clips(db, q.id, 1);
  expect(gesture(db, 'PICK_4').outcome).toBe('ignored:rank_out_of_range');
  const s = scan(db);
  expect(gesture(db, 'PICK_1', { heardStepSeq: s.listStartSeq - 1n }).outcome).toBe('ignored:stale_question');
  expect(gesture(db, 'PICK_1', { heardStepSeq: s.stepSeq + 1n }).outcome).toBe('ignored:stale_question');
  expect(gesture(db, 'YES').outcome).toBe('ignored:direct_mode');
  expect(gesture(db, 'CONFIRM').outcome).toBe('ignored:direct_mode');
  expect(gesture(db, 'NO').outcome).toBe('ignored:direct_mode');
  expect(scan(db).phase.tag).toBe('Reading'); // none of these changed anything
  const logged = [...db.db.gestureLog.gestureBySession.filter(s.sessionId)].map((g) => [g.command.tag, g.reason]);
  expect(logged).toContainEqual(['Pick4', 'rank_out_of_range']);
});

test('a second pick inside the refractory time is ignored', () => {
  const db = newDb('direct');
  waiting(db, [...SMALL_TALK.slice(0, 1), opt('search', 'Search', 'Search the web for ideas')]);
  grantConsent(db, 'web_search');
  live(db, 200);
  expect(gesture(db, 'PICK_2').outcome).toBe('accepted:pick_search');
  expect(gesture(db, 'PICK_2').outcome).toBe('ignored:refractory');
  expect(searchOf(db).status.tag).toBe('Prepared');
});

test('a reply pick without good contact now is refused: nothing is said', () => {
  const db = newDb('direct');
  const q = listening(db);
  advance(db, 2000); // no heartbeat: the dead-man lease ran out, its timer has not run
  expect(gesture(db, 'PICK_1').outcome).toBe('ignored:no_contact');
  expect(question(db, q.id).status.tag).toBe('Scanning');
});

test('STOP clears the live list, and a new question replaces it', () => {
  const db = newDb('direct');
  const q = listening(db);
  expect(gesture(db, 'STOP').outcome).toBe('accepted:none');
  expect([question(db, q.id).status.tag, scan(db).phase.tag]).toEqual(['None', 'Idle']);
  expect(gesture(db, 'PICK_1').outcome).toBe('ignored:refractory'); // a pick right after any accepted command
  settle(db);
  expect(gesture(db, 'PICK_1').outcome).toBe('ignored:no_list');
  const first = listening(db);
  const second = ask(db, 'Something else?');
  expect(question(db, first.id).status.tag).toBe('Cancelled');
  expect([scan(db).questionId, scan(db).phase.tag]).toEqual([second.id, 'Preparing']);
});

test('while paused, PICK_1 resumes and the other ranks are ignored', () => {
  const db = newDb('direct');
  expect(gesture(db, 'STOP').outcome).toBe('accepted:pause');
  settle(db);
  expect(gesture(db, 'PICK_2').outcome).toBe('ignored:paused');
  expect(gesture(db, 'PICK_4').outcome).toBe('ignored:paused');
  expect(gesture(db, 'PICK_1').outcome).toBe('accepted:resume');
  expect(scan(db).phase.tag).toBe('Idle');
  as(db, OWNER, (ctx) => m.operatorPause(ctx, {}));
  settle(db);
  expect(gesture(db, 'PICK_1').outcome).toBe('ignored:operator_pause');
});

test('scan mode is unchanged: a PICK there is ignored, and YES still picks the option under the cursor', () => {
  const db = newDb(); // the scan suites' default
  expect(db.db.config.id.find(0)!.inputMode.tag).toBe('Scan');
  const q = ask(db);
  publish(db, q.id, [reply('Yes, please'), reply('No, thank you')]);
  clips(db, q.id, 1);
  expect(gesture(db, 'PICK_1').outcome).toBe('ignored:scan_mode');
  tick(db);
  expect(scan(db).phase.tag).toBe('Window'); // the response window is still there
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick');
  expect(scan(db).phase.tag).toBe('Veto');
});

test('set_input_mode switches between scan and direct, owner only, only while no session is active', () => {
  const db = newDb('direct');
  expect(failure(() => as(db, OWNER, (ctx) => m.setInputMode(ctx, { mode: 'scan' })))).toContain('a session is active');
  as(db, STATION, (ctx) => m.endSession(ctx, {}));
  as(db, OWNER, (ctx) => m.setInputMode(ctx, { mode: 'scan' }));
  expect(db.db.config.id.find(0)!.inputMode.tag).toBe('Scan');
  expect(failure(() => as(db, OWNER, (ctx) => m.setInputMode(ctx, { mode: 'sideways' })))).toBe('mode must be direct or scan');
  expect(() => as(db, STATION, (ctx) => m.setInputMode(ctx, { mode: 'direct' }))).toThrow();
});

// ---------- Errands and calls: the read-back, then PICK_1 confirms and PICK_2 cancels ----------

/** Picks the errand (rank 1) and attaches the Actor's preview and the station's read-back: AwaitingConfirm. */
function errandAwaiting(db: Test) {
  grantConsent(db, 'errand', FORM_KEY);
  const q = listening(db, [errandOption(), reply('Nothing else')]);
  live(db, 200);
  expect(gesture(db, 'PICK_1').outcome).toBe('accepted:pick_errand');
  expect(question(db, q.id).status.tag).toBe('Acting');
  const job = claim(db, q.id, 'ErrandPreview');
  as(db, AGENT, (ctx) =>
    m.agentAttachPreview(ctx, {
      jobId: job.id,
      attempt: job.attempt,
      status: 'previewed',
      formTitle: 'Care team request',
      readBackText: 'Request: a ride to the aquarium at 1.',
      readBackJson: '[]',
      previewDigest: DIGEST,
      screenshotUrl: '',
      reasonCode: '',
      reason: '',
      previewMs: 3000,
    }),
  );
  settle(db);
  beat(db);
  expect(gesture(db, 'PICK_1', { heardDigest: DIGEST }).outcome).toBe('ignored:readback_not_done');
  const id = errandOf(db).id; // read before the transaction: `db.db` inside one deadlocks the test datastore
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'errand', id, digest: DIGEST }));
  return errandOf(db);
}

test('an errand pick reads back, and PICK_1 with the heard digest confirms it once', () => {
  const db = newDb('direct');
  const e = errandAwaiting(db);
  expect(e.status.tag).toBe('AwaitingConfirm');
  live(db, 1500);
  expect(gesture(db, 'PICK_3', { heardDigest: DIGEST }).outcome).toBe('ignored:rank_out_of_range');
  expect(gesture(db, 'PICK_1', { heardDigest: 'ffffffffffffffff' }).outcome).toBe('ignored:digest_mismatch');
  const g = gesture(db, 'PICK_1', { heardDigest: DIGEST, gestureId: 'pick-confirm-1' });
  expect(g.outcome).toBe('accepted:confirm');
  expect([errandOf(db).status.tag, errandOf(db).confirmGestureId, errandOf(db).confirmedDigest]).toEqual(['Confirmed', 'pick-confirm-1', DIGEST]);
  as(db, AGENT, (ctx) => m.claimErrand(ctx, { errandId: e.id, digest: DIGEST }));
  expect(errandOf(db).status.tag).toBe('Submitting');
});

test('PICK_1 inside the quiet hold restarts it, as CONFIRM does', () => {
  const db = newDb('direct');
  const e = errandAwaiting(db);
  advance(db, 1200);
  beat(db);
  expect(gesture(db, 'PICK_1', { heardDigest: DIGEST, onsetAgeMs: 900 }).outcome).toBe('ignored:quiet_hold');
  expect(errandOf(db).windowSeq).toBe(e.windowSeq + 1);
});

test('PICK_2 cancels an errand, during the read-back or in the confirm window', () => {
  const db = newDb('direct');
  errandAwaiting(db);
  live(db, 1500);
  expect(gesture(db, 'PICK_2').outcome).toBe('accepted:stop_errand');
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['Stopped', 'no']);
  live(db, 1100);
  expect(gesture(db, 'PICK_1', { heardDigest: DIGEST }).outcome).toBe('ignored:no_list');
});

test('STOP during the errand confirm cancels it', () => {
  const db = newDb('direct');
  errandAwaiting(db);
  live(db, 1500);
  expect(gesture(db, 'STOP').outcome).toBe('accepted:stop_errand');
  expect([errandOf(db).status.tag, errandOf(db).reasonCode]).toEqual(['Stopped', 'stop']);
});

test('a call pick reads back, PICK_1 confirms it, and PICK_2 would cancel it', () => {
  const db = newDb('direct');
  grantConsent(db, 'call', 'leon');
  listening(db, [callOption(db, 'call-a'), reply('Yes, agree'), reply('No need')]);
  live(db, 200);
  expect(gesture(db, 'PICK_1').outcome).toBe('accepted:pick_call');
  const callId = callOf(db).id;
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'call', id: callId, digest: CALL_DIGEST }));
  live(db, 1500);
  expect(gesture(db, 'PICK_1', { heardDigest: CALL_DIGEST }).outcome).toBe('accepted:confirm');
  expect(callOf(db).status.tag).toBe('Confirmed');

  const db2 = newDb('direct');
  grantConsent(db2, 'call', 'leon');
  listening(db2, [callOption(db2, 'call-b'), reply('No need')]);
  live(db2, 200);
  expect(gesture(db2, 'PICK_1').outcome).toBe('accepted:pick_call');
  live(db2, 1100);
  expect(gesture(db2, 'PICK_2').outcome).toBe('accepted:stop_call');
  expect([callOf(db2).status.tag, callOf(db2).reasonCode]).toEqual(['Stopped', 'no']);
});

// ---------- Search: read-back and confirm, then categories, then a category's search ----------

test('a Search pick creates a request with the fixed read-back and a digest; PICK_1 before the read-back is refused', () => {
  const db = newDb('direct');
  grantConsent(db, 'web_search');
  const q = listening(db, PLANS);
  live(db, 200);
  expect(gesture(db, 'PICK_3').outcome).toBe('accepted:pick_search');
  expect(question(db, q.id).status.tag).toBe('Acting');
  const r = searchOf(db);
  expect([r.status.tag, r.readBackText, r.questionId]).toEqual(['Prepared', 'Search the web for ideas? One: yes. Two: cancel.', q.id]);
  expect(r.digest).toMatch(/^[0-9a-f]{16}$/);
  expect([...db.db.searchTimer.searchId.filter(r.id)].map((t) => t.kind.tag)).toEqual(['Readback']);
  live(db, 1100);
  expect(gesture(db, 'PICK_1', { heardDigest: r.digest }).outcome).toBe('ignored:readback_not_done');
  // The station sees it on my_session.
  const mine = m.mySession(db.viewContext(auth(STATION)))!;
  expect([mine.search?.searchId, mine.search?.digest, mine.search?.status.tag]).toEqual([r.id, r.digest, 'Prepared']);
  expect(failure(() => as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'search', id: r.id, digest: 'ffffffffffffffff' })))).toContain('digest mismatch');
});

test('without web search consent a Search pick is refused at once', () => {
  const db = newDb('direct');
  listening(db, PLANS);
  live(db, 200);
  expect(gesture(db, 'PICK_3').outcome).toBe('accepted:pick_search');
  const r = searchOf(db);
  expect([r.status.tag, r.reasonCode]).toEqual(['Refused', 'no_consent']);
  expect([...db.db.searchTimer.searchId.filter(r.id)]).toHaveLength(0);
  expect([...db.db.question.questionBySession.filter(scan(db).sessionId)].filter((q) => q.via === 'search')).toHaveLength(0);
});

test('a confirmed search opens a categories turn; a category pick opens its search turn; a place pick is said at once', () => {
  const db = newDb('direct');
  const { q, r } = searchAwaiting(db);
  expect(r.status.tag).toBe('AwaitingConfirm');
  expect(gesture(db, 'PICK_1', { heardDigest: 'ffffffffffffffff' }).outcome).toBe('ignored:digest_mismatch');
  const g = gesture(db, 'PICK_1', { heardDigest: r.digest });
  expect(g.outcome).toBe('accepted:confirm_search');
  const confirmed = searchOf(db);
  expect(confirmed.status.tag).toBe('Confirmed');

  // The categories turn: a follow-up question on the original one, with a Categories job and no web call.
  const cats = question(db, confirmed.followUpQuestionId);
  expect([cats.via, cats.parentQuestionId, cats.text, cats.status.tag]).toEqual(['search', q.id, q.text, 'Drafting']);
  expect(g.questionId).toBe(cats.id);
  expect([scan(db).questionId, scan(db).phase.tag]).toEqual([cats.id, 'Preparing']);
  const catJob = jobsOf(db, cats.id)[0]!;
  expect([catJob.kind.tag, catJob.webSearchAllowed]).toEqual(['Categories', false]);
  const queued = m.agentQueue(db.viewContext(auth(AGENT))).find((row) => row.jobId === catJob.id)!;
  expect([queued.parentQuestionId, queued.parentQuestionText, queued.category]).toEqual([q.id, q.text, '']);

  answer(db, cats.id, 'Categories', CATEGORIES);
  expect([scan(db).phase.tag, scan(db).questionId, scan(db).optionCount]).toEqual(['Reading', cats.id, 4]);
  live(db, 1100);
  expect(gesture(db, 'PICK_2').outcome).toBe('accepted:pick_category');

  // The search turn: the category and the original question, with a Search job that may search the web.
  const turns = [...db.db.question.questionBySession.filter(scan(db).sessionId)].filter((x) => x.via === 'category');
  expect(turns).toHaveLength(1);
  const places = turns[0]!;
  expect([places.parentQuestionId, places.category, places.text]).toEqual([q.id, 'Fun', q.text]);
  expect(question(db, cats.id).status.tag).toBe('Acting');
  const searchJob = jobsOf(db, places.id)[0]!;
  expect([searchJob.kind.tag, searchJob.webSearchAllowed]).toEqual(['Search', true]);
  const row = m.agentQueue(db.viewContext(auth(AGENT))).find((x) => x.jobId === searchJob.id)!;
  expect([row.category, row.parentQuestionId, row.parentQuestionText]).toEqual(['Fun', q.id, q.text]);

  const claimed = claim(db, places.id, 'Search');
  as(db, AGENT, (ctx) =>
    m.agentProgress(ctx, { jobId: claimed.id, attempt: claimed.attempt, eventKey: `${claimed.id}:1:search`, stage: 'search', status: 'ok', detail: 'maps', ms: 900, countsJson: '{"places":2}', payloadJson: '' }),
  );
  as(db, AGENT, (ctx) =>
    m.agentPublishOptions(ctx, {
      jobId: claimed.id,
      attempt: claimed.attempt,
      answerMode: 'pick',
      options: [opt('reply', 'Palace of Fine Arts', "Let's go to the Palace of Fine Arts!"), opt('reply', 'Exploratorium', "Let's go to the Exploratorium!")],
      final: true,
    }),
  );
  clips(db, places.id, 1, 700);
  live(db, 1100);
  expect(gesture(db, 'PICK_1').outcome).toBe('accepted:pick_reply');
  expect([question(db, places.id).status.tag, question(db, places.id).replyText]).toEqual(['Released', "Let's go to the Palace of Fine Arts!"]);
});

test('PICK_1 inside the quiet hold restarts it for a search too', () => {
  const db = newDb('direct');
  grantConsent(db, 'web_search');
  listening(db, PLANS);
  live(db, 200);
  gesture(db, 'PICK_3');
  const r = searchOf(db);
  as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'search', id: r.id, digest: r.digest }));
  advance(db, 1100);
  beat(db);
  expect(gesture(db, 'PICK_1', { heardDigest: r.digest, onsetAgeMs: 900 }).outcome).toBe('ignored:quiet_hold');
  expect(searchOf(db).windowSeq).toBe(2);
});

test('PICK_2 cancels a search, STOP cancels a search, and PICK_3 is out of range during its confirm', () => {
  const db = newDb('direct');
  searchAwaiting(db);
  expect(gesture(db, 'PICK_3').outcome).toBe('ignored:rank_out_of_range');
  expect(gesture(db, 'PICK_2').outcome).toBe('accepted:stop_search');
  expect([searchOf(db).status.tag, searchOf(db).reasonCode, searchOf(db).reason]).toEqual(['Stopped', 'no', 'Stopped. No search was started.']);
  expect([...db.db.searchTimer.searchId.filter(searchOf(db).id)]).toHaveLength(0);

  const db2 = newDb('direct');
  searchAwaiting(db2);
  expect(gesture(db2, 'STOP').outcome).toBe('accepted:stop_search');
  expect([searchOf(db2).status.tag, searchOf(db2).reasonCode]).toEqual(['Stopped', 'stop']);
  expect([...db2.db.question.questionBySession.filter(scan(db2).sessionId)].filter((q) => q.via === 'search')).toHaveLength(0);
});

test('a search times out: the read-back deadline or the confirm window stops it, and a timeout means no', () => {
  const db = newDb('direct');
  grantConsent(db, 'web_search');
  listening(db, PLANS);
  live(db, 200);
  gesture(db, 'PICK_3');
  const r = searchOf(db);
  const readback = [...db.db.searchTimer.searchId.filter(r.id)][0]!;
  db.clock.set(timerAt(readback));
  expect(failure(() => as(db, STATION, (ctx) => m.reportReadbackDone(ctx, { kind: 'search', id: r.id, digest: r.digest })))).toBe('read-back deadline passed');
  internal(db, (ctx) => m.searchTimeout(ctx, { job: readback }));
  expect([searchOf(db).status.tag, searchOf(db).reasonCode]).toEqual(['Stopped', 'readback_not_finished']);

  const db2 = newDb('direct');
  const { r: r2 } = searchAwaiting(db2);
  const window = [...db2.db.searchTimer.searchId.filter(r2.id)].find((t) => t.kind.tag === 'ConfirmWindow')!;
  expect(micros(timerAt(window))).toBe(micros(r2.confirmClosesAt));
  live(db2, 8000);
  expect(gesture(db2, 'PICK_1', { heardDigest: r2.digest }).outcome).toBe('ignored:window_closed');
  internal(db2, (ctx) => m.searchTimeout(ctx, { job: window }));
  expect([searchOf(db2).status.tag, searchOf(db2).reasonCode]).toEqual(['Stopped', 'window_closed']);
});

test('a pause, a new question or a revoked consent voids a search waiting for its confirm', () => {
  const db = newDb('direct');
  searchAwaiting(db);
  expect(gesture(db, 'HEADSET_OFF').outcome).toBe('accepted:pause');
  expect([searchOf(db).status.tag, searchOf(db).reasonCode]).toEqual(['Stopped', 'headset_off']);

  const db2 = newDb('direct');
  searchAwaiting(db2);
  ask(db2, 'Never mind, are you hungry?');
  expect([searchOf(db2).status.tag, searchOf(db2).reasonCode]).toEqual(['Stopped', 'interrupted']);

  const db3 = newDb('direct');
  searchAwaiting(db3);
  const consent = [...db3.db.consent.consentByScope.filter({ tag: 'WebSearch' })][0]!;
  as(db3, OWNER, (ctx) => m.revokeConsent(ctx, { consentId: consent.id }));
  expect([searchOf(db3).status.tag, searchOf(db3).reasonCode]).toEqual(['Stopped', 'consent_revoked']);
});

test('a confirmed search is used once: a replayed confirm finds nothing to confirm', () => {
  const db = newDb('direct');
  const { r } = searchAwaiting(db);
  expect(gesture(db, 'PICK_1', { heardDigest: r.digest, gestureId: 'search-ok' }).outcome).toBe('accepted:confirm_search');
  gesture(db, 'PICK_1', { heardDigest: r.digest, gestureId: 'search-ok' }); // a retry of the same call: no-op
  expect([...db.db.question.questionBySession.filter(scan(db).sessionId)].filter((q) => q.via === 'search')).toHaveLength(1);
  live(db, 1100);
  expect(gesture(db, 'PICK_1', { heardDigest: r.digest }).outcome).toBe('ignored:no_list'); // the categories turn is preparing
});

test('a category pick needs web search consent and a categories turn', () => {
  const db = newDb('direct');
  const { r } = searchAwaiting(db);
  gesture(db, 'PICK_1', { heardDigest: r.digest });
  const cats = searchOf(db).followUpQuestionId;
  answer(db, cats, 'Categories', CATEGORIES);
  const consent = [...db.db.consent.consentByScope.filter({ tag: 'WebSearch' })][0]!;
  as(db, OWNER, (ctx) => m.revokeConsent(ctx, { consentId: consent.id }));
  live(db, 1100);
  expect(gesture(db, 'PICK_1').outcome).toBe('ignored:no_consent');
  expect([...db.db.question.questionBySession.filter(scan(db).sessionId)].filter((q) => q.via === 'category')).toHaveLength(0);

  // A Category row on an ordinary question (written behind the reducers' back) is never acted on.
  const db2 = newDb('direct');
  grantConsent(db2, 'web_search');
  const q = listening(db2);
  const first = [...db2.db.answerOption.optionByQv.filter([q.id, 1])].find((o) => o.rank === 1)!;
  db2.db.answerOption.id.update({ ...first, kind: { tag: 'Category' } });
  live(db2, 200);
  expect(gesture(db2, 'PICK_1').outcome).toBe('ignored:not_allowed');
});

// ---------- Which job may publish which kind ----------

test('only a categories turn may offer categories, a search turn answers with replies, and scan mode offers neither', () => {
  const db = newDb('direct');
  const q = ask(db);
  const job = claim(db, q.id);
  const publishAs = (j: { id: bigint; attempt: number }, opts: OptionInput[]) =>
    failure(() => as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: j.id, attempt: j.attempt, answerMode: 'pick', options: opts, final: false })));
  expect(publishAs(job, CATEGORIES)).toBe('a Options job cannot publish a Category option');
  expect(publishAs(job, [opt('reply', 'x'.repeat(41), 'Too long a label')])).toBe('label is longer than 40 characters');
  expect(publishAs(job, [{ ...opt('search', 'Search', 'Search the web'), actionJson: '{}' }])).toBe('a search option has no action_json');

  const scanDb = newDb();
  const sq = ask(scanDb);
  const sj = claim(scanDb, sq.id);
  expect(failure(() => as(scanDb, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: sj.id, attempt: sj.attempt, answerMode: 'pick', options: PLANS, final: true })))).toBe(
    'search and category options need direct input mode',
  );
});

test('a search turn may publish only replies', () => {
  const db = newDb('direct');
  const { r } = searchAwaiting(db);
  gesture(db, 'PICK_1', { heardDigest: r.digest });
  const cats = searchOf(db).followUpQuestionId;
  const catJob = claim(db, cats, 'Categories');
  expect(
    failure(() => as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: catJob.id, attempt: catJob.attempt, answerMode: 'pick', options: [PLANS[2]!], final: false }))),
  ).toBe('a Categories job cannot publish a Search option');
  as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: catJob.id, attempt: catJob.attempt, answerMode: 'pick', options: CATEGORIES, final: true }));
  clips(db, cats, 1, 700);
  live(db, 1100);
  gesture(db, 'PICK_1');
  const places = [...db.db.question.questionBySession.filter(scan(db).sessionId)].find((x) => x.via === 'category')!;
  const sj = claim(db, places.id, 'Search');
  expect(failure(() => as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: sj.id, attempt: sj.attempt, answerMode: 'pick', options: CATEGORIES, final: true })))).toBe(
    'a Search job cannot publish a Category option',
  );
});

test('an agent failure on a categories turn fails that question, like an options job', () => {
  const db = newDb('direct');
  const { r } = searchAwaiting(db);
  gesture(db, 'PICK_1', { heardDigest: r.digest });
  const cats = searchOf(db).followUpQuestionId;
  const j = claim(db, cats, 'Categories');
  as(db, AGENT, (ctx) => m.agentFail(ctx, { jobId: j.id, attempt: j.attempt, reasonCode: 'planner_timeout', reason: '' }));
  expect(question(db, cats).status.tag).toBe('Failed');
  expect(scan(db).phase.tag).toBe('Idle');
});

// ---------- Views and repairs ----------

test('the board shows short labels and kinds only while sharing is on, and lists search requests', () => {
  const db = newDb('direct');
  grantConsent(db, 'web_search');
  const q = listening(db, PLANS);
  const anon = () => db.anonymousViewContext();
  const hidden = m.publicBoard(anon()).find((x) => x.questionId === q.id)!;
  expect(hidden.options.map((o) => [o.rank, o.kind.tag, o.shortLabel])).toEqual([
    [1, 'Reply', 'Option 1'],
    [2, 'Reply', 'Option 2'],
    [3, 'Search', 'Option 3'],
    [4, 'Reply', 'Option 4'],
  ]);
  grantConsent(db, 'board_text');
  as(db, OWNER, (ctx) => m.setBoardSharing(ctx, { on: true }));
  const shown = m.publicBoard(anon()).find((x) => x.questionId === q.id)!;
  expect(shown.options.map((o) => o.shortLabel)).toEqual(['Yes', 'No', 'Search the web', 'Something else']);
  expect(m.myOptions(db.viewContext(auth(STATION))).map((o) => o.label)).toEqual(['Yes', 'No', 'Search the web', 'Something else']);
  live(db, 200);
  gesture(db, 'PICK_3');
  const board = m.boardSearches(anon());
  expect(board.map((b) => [b.status.tag, b.questionId, b.readBackText])).toEqual([['Prepared', q.id, 'Search the web for ideas? One: yes. Two: cancel.']]);
});

test('ensure_timers re-arms a missing search timer, and purge_session deletes search requests', () => {
  const db = newDb('direct');
  const { r } = searchAwaiting(db);
  for (const t of [...db.db.searchTimer.searchId.filter(r.id)]) db.db.searchTimer.scheduledId.delete(t.scheduledId);
  as(db, OWNER, (ctx) => m.ensureTimers(ctx, {}));
  const rearmed = [...db.db.searchTimer.searchId.filter(r.id)];
  expect(rearmed.map((t) => [t.kind.tag, t.seq])).toEqual([['ConfirmWindow', r.windowSeq]]);
  const sessionId = scan(db).sessionId;
  as(db, STATION, (ctx) => m.endSession(ctx, {}));
  expect(searchOf(db).status.tag).toBe('Stopped'); // the session end voided it
  as(db, OWNER, (ctx) => m.purgeSession(ctx, { sessionId }));
  expect([...db.db.searchRequest.searchBySession.filter(sessionId)]).toHaveLength(0);
  expect([...db.db.searchTimer.searchId.filter(r.id)]).toHaveLength(0);
});
