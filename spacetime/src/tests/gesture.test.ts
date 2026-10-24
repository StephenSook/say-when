// The command map (D11) as the decision table in docs/spacetime.md 4.2: YES, NO and STOP against the scan,
// matched to the step the person heard, with the grace window and refractory.
import { expect, test } from 'vitest';
import * as m from '../index';
import {
  advance,
  as,
  ask,
  auth,
  clips,
  currentTimer,
  emptyDb,
  failure,
  gesture,
  newDb,
  options,
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
  OWNER,
  pair,
} from './harness';

function myReply(db: ReturnType<typeof newDb>) {
  return m.mySession(db.viewContext(auth(SPEAKER)))?.reply;
}

test('YES on the option just heard goes to the veto, and the veto end releases the reply to the speaker', () => {
  const db = newDb();
  const q = scanning(db);
  const g = gesture(db, 'YES');
  expect(g.outcome).toBe('accepted:pick');
  const s = scan(db);
  expect(s.phase.tag).toBe('Veto');
  expect(s.pickedRank).toBe(1);
  expect(myReply(db)).toBeUndefined(); // nothing is said during the veto
  tick(db); // VetoEnd
  const done = question(db, q.id);
  expect(done.status.tag).toBe('Released');
  expect(done.replyText).toBe('Yes, please');
  expect(scan(db).phase.tag).toBe('Idle');
  expect(scan(db).outcome?.tag).toBe('Picked');
  expect(myReply(db)?.text).toBe('Yes, please');
  as(db, SPEAKER, (ctx) => m.replySpoken(ctx, { questionId: q.id, ms: 1400 }));
  expect(question(db, q.id).status.tag).toBe('Spoken');
  as(db, SPEAKER, (ctx) => m.replySpoken(ctx, { questionId: q.id, ms: 1400 })); // a second speaker: quiet
});

test('a late YES for the previous option inside grace_ms picks that option, with late_by_ms', () => {
  const db = newDb();
  scanning(db);
  const firstSteps = scan(db).stepSeq;
  tick(db); // option 1's window
  const heardStep = scan(db).stepSeq;
  tick(db); // option 2 is now being read
  expect(scan(db).cursor).toBe(2);
  expect(firstSteps).toBeLessThan(heardStep);
  advance(db, 600);
  const g = gesture(db, 'YES', { heardStepSeq: heardStep });
  expect(g.outcome).toBe('accepted:pick');
  expect(g.lateByMs).toBe(600);
  expect(scan(db).pickedRank).toBe(1);
  const pick = [...db.db.ledger.ledgerBySession.filter(scan(db).sessionId)].find((l) => l.kind === 'pick')!;
  expect(pick.ms).toBe(600);
});

test('a late YES after grace_ms is ignored as a stale step', () => {
  const db = newDb();
  scanning(db);
  tick(db);
  const heardStep = scan(db).stepSeq;
  tick(db);
  advance(db, 1001); // grace_ms is 1000
  const g = gesture(db, 'YES', { heardStepSeq: heardStep });
  expect(g.outcome).toBe('ignored:stale_step');
  expect(scan(db).phase.tag).toBe('Reading');
});

test('a heard option id that disagrees with the step fails closed', () => {
  const db = newDb();
  const q = scanning(db);
  const second = options(db, q.id, 1)[1]!;
  const g = gesture(db, 'YES', { heardOptionId: second.id });
  expect(g.outcome).toBe('ignored:heard_mismatch');
  expect(scan(db).phase.tag).toBe('Reading');
});

test('a step the station claims to have heard in the future is stale', () => {
  const db = newDb();
  scanning(db);
  const g = gesture(db, 'YES', { heardStepSeq: scan(db).stepSeq + 5n });
  expect(g.outcome).toBe('ignored:stale_step');
});

test('NO on the current option skips to the next one now', () => {
  const db = newDb();
  scanning(db);
  const no = gesture(db, 'NO');
  expect(no.outcome).toBe('accepted:skip');
  expect([scan(db).phase.tag, scan(db).cursor]).toEqual(['Reading', 2]);
  settle(db);
  expect(gesture(db, 'NO').outcome).toBe('accepted:skip');
  expect(scan(db).cursor).toBe(3);
  settle(db);
  expect(gesture(db, 'NO').outcome).toBe('accepted:skip'); // past the last option: the next pass
  expect([scan(db).cursor, scan(db).pass]).toEqual([1, 2]);
});

test('a YES for an option just skipped with NO can never land: grace_ms is at most refractory_ms', () => {
  const db = newDb();
  scanning(db);
  const heardFirst = scan(db).stepSeq;
  gesture(db, 'NO');
  advance(db, 300);
  expect(gesture(db, 'YES', { heardStepSeq: heardFirst }).outcome).toBe('ignored:refractory');
  expect(failure(() => as(db, OWNER, (ctx) => m.setTiming(ctx, { json: JSON.stringify({ grace_ms: 2000 }) })))).toContain('grace_ms');
});

test('a YES exactly refractory_ms after a NO cannot land on the option just skipped (grace_ms equals refractory_ms)', () => {
  const db = newDb(); // defaults: grace_ms 1000, refractory_ms 1000
  scanning(db);
  const heardFirst = scan(db).stepSeq;
  expect(gesture(db, 'NO').outcome).toBe('accepted:skip');
  expect(scan(db).prevOptionStartSeq).toBe(0n); // the refused option is no grace candidate
  advance(db, 1000); // refractory has just ended; the step changed exactly grace_ms ago
  expect(gesture(db, 'YES', { heardStepSeq: heardFirst }).outcome).toBe('ignored:stale_step');
  expect([scan(db).phase.tag, scan(db).cursor]).toEqual(['Reading', 2]);
});

test('the same holds for a NO on the last option: the next pass starts with no grace candidate', () => {
  const db = newDb();
  scanning(db);
  gesture(db, 'NO');
  settle(db);
  gesture(db, 'NO');
  settle(db);
  const heardLast = scan(db).stepSeq; // option 3 of 3
  expect(gesture(db, 'NO').outcome).toBe('accepted:skip');
  expect([scan(db).cursor, scan(db).pass, scan(db).prevOptionStartSeq]).toEqual([1, 2, 0n]);
  advance(db, 1000);
  expect(gesture(db, 'YES', { heardStepSeq: heardLast }).outcome).toBe('ignored:stale_step');
});

test('a late NO inside the grace window for the option just passed is already_passed', () => {
  const db = newDb();
  // Make refractory long enough not to interfere, and grace generous.
  as(db, OWNER, (ctx) => m.setTiming(ctx, { json: JSON.stringify({ grace_ms: 1500, refractory_ms: 1500 }) }));
  scanning(db);
  tick(db);
  const heardStep = scan(db).stepSeq; // option 1's window
  tick(db); // option 2
  advance(db, 400);
  const g = gesture(db, 'NO', { heardStepSeq: heardStep });
  expect(g.outcome).toBe('ignored:already_passed');
  expect(scan(db).cursor).toBe(2);
});

test('refractory: YES then NO inside refractory_ms ignores the NO, but STOP still works', () => {
  const db = newDb();
  const q = scanning(db);
  expect(gesture(db, 'YES').outcome).toBe('accepted:pick');
  advance(db, 500);
  expect(gesture(db, 'NO').outcome).toBe('ignored:refractory');
  expect(scan(db).phase.tag).toBe('Veto');
  advance(db, 100);
  expect(gesture(db, 'STOP').outcome).toBe('accepted:stop_reply');
  expect(question(db, q.id).status.tag).toBe('Stopped');
  expect(question(db, q.id).replyText).toBeUndefined();
});

test('STOP while reading means none of these', () => {
  const db = newDb();
  const q = scanning(db);
  const g = gesture(db, 'STOP');
  expect(g.outcome).toBe('accepted:none');
  expect(scan(db).phase.tag).toBe('Idle');
  expect(scan(db).outcome?.tag).toBe('None');
  expect(question(db, q.id).status.tag).toBe('None');
});

test('STOP during the veto cancels the reply: Stopped, nothing said', () => {
  const db = newDb();
  const q = scanning(db);
  gesture(db, 'YES');
  advance(db, 200);
  expect(gesture(db, 'STOP').outcome).toBe('accepted:stop_reply');
  expect(scan(db).outcome?.tag).toBe('Stopped');
  expect(question(db, q.id).releasedAt).toBeUndefined();
  expect(myReply(db)).toBeUndefined();
});

test('NO during the veto cancels the pick and scanning goes on at the next option', () => {
  const db = newDb();
  scanning(db);
  gesture(db, 'YES');
  settle(db);
  expect(gesture(db, 'NO').outcome).toBe('accepted:veto_cancel');
  const s = scan(db);
  expect([s.phase.tag, s.cursor]).toEqual(['Reading', 2]);
  expect(s.pickedRank).toBeUndefined();
});

test('yes or no mode: YES answers with rank 1 and NO with rank 2, each after a veto', () => {
  const db = newDb();
  const q = scanning(db, [reply('Yes, I am tired'), reply('No, I am fine')], 'yes_no');
  expect(gesture(db, 'NO').outcome).toBe('accepted:answer_no');
  expect(scan(db).pickedRank).toBe(2);
  tick(db);
  expect(question(db, q.id).replyText).toBe('No, I am fine');

  const db2 = newDb();
  const q2 = scanning(db2, [reply('Yes, I am tired'), reply('No, I am fine')], 'yes_no');
  tick(db2); // the prompt's window
  expect(gesture(db2, 'YES').outcome).toBe('accepted:answer_yes');
  tick(db2);
  expect(question(db2, q2.id).replyText).toBe('Yes, I am tired');
});

test('YES while idle opens the menu: four module-made options, then Preparing', () => {
  const db = newDb();
  const g = gesture(db, 'YES');
  expect(g.outcome).toBe('accepted:menu_open');
  const s = scan(db);
  expect(s.phase.tag).toBe('Preparing');
  expect(s.mode.tag).toBe('Menu');
  const menu = question(db, s.questionId);
  expect([menu.origin.tag, menu.via, menu.number]).toEqual(['Menu', 'menu', 0]);
  expect(options(db, menu.id, 1).map((o) => [o.kind.tag, o.text])).toEqual([
    ['Menu', 'I need something'],
    ['Menu', 'Send a request'],
    ['Menu', 'Call'],
    ['Menu', 'Say something else'],
  ]);
  // No agent work for the menu itself.
  expect([...db.db.agentJob.jobByQuestion.filter(menu.id)]).toHaveLength(0);
});

test('with menu_enabled off, YES while idle is ignored', () => {
  const db = newDb();
  as(db, OWNER, (ctx) => m.setTiming(ctx, { json: JSON.stringify({ menu_enabled: false }) }));
  expect(gesture(db, 'YES').outcome).toBe('ignored:idle');
  expect(scan(db).phase.tag).toBe('Idle');
});

test('YES while options are being prepared is not_ready', () => {
  const db = newDb();
  ask(db);
  expect(gesture(db, 'YES').outcome).toBe('ignored:not_ready');
  expect(gesture(db, 'NO').outcome).toBe('ignored:not_ready');
});

test('picking "Send a request" in the menu makes a Menu-origin question and an Options job', () => {
  const db = newDb();
  gesture(db, 'YES');
  const menu = question(db, scan(db).questionId);
  clips(db, menu.id, 1, 700);
  expect(scan(db).phase.tag).toBe('Reading');
  tick(db); // window of item 1
  tick(db); // item 2: Send a request
  settle(db);
  expect(gesture(db, 'YES').outcome).toBe('accepted:menu_item');
  expect(question(db, menu.id).status.tag).toBe('Acting');
  const s = scan(db);
  const follow = question(db, s.questionId);
  expect(follow.id).not.toBe(menu.id);
  expect([follow.origin.tag, follow.menuItem.tag, follow.text, follow.number]).toEqual(['Menu', 'Request', 'Send a request', 1]);
  expect(s.phase.tag).toBe('Preparing');
  const jobs = [...db.db.agentJob.jobByQuestion.filter(follow.id)];
  expect(jobs.map((j) => [j.kind.tag, j.status.tag])).toEqual([['Options', 'Pending']]);
});

test('a repeated gesture id is a retry; the same id with another command throws', () => {
  const db = newDb();
  scanning(db);
  gesture(db, 'YES', { gestureId: 'same-id' });
  const before = scan(db).stepSeq;
  gesture(db, 'YES', { gestureId: 'same-id' });
  expect(scan(db).stepSeq).toBe(before);
  expect(failure(() => gesture(db, 'NO', { gestureId: 'same-id' }))).toContain('already used');
});

test('with no active session a gesture is recorded, not thrown', () => {
  const db = emptyDb();
  pair(db, STATION, 'station');
  as(db, STATION, (ctx) =>
    m.gesture(ctx, { gestureId: 'early', command: 'YES', heardStepSeq: 0n, heardOptionId: 0n, heardDigest: '', confidence: 1, source: 'key', onsetAgeMs: 0 }),
  );
  expect(db.db.gestureLog.gestureId.find('early')!.outcome).toBe('ignored:no_session');
});

test('a malformed command throws', () => {
  const db = newDb();
  expect(
    failure(() =>
      as(db, STATION, (ctx) =>
        m.gesture(ctx, { gestureId: 'x1', command: 'SELECT', heardStepSeq: 0n, heardOptionId: 0n, heardDigest: '', confidence: 1, source: 'jaw', onsetAgeMs: 0 }),
      ),
    ),
  ).toContain('command must be');
});

test('only the session station may relay a gesture', () => {
  const db = newDb();
  pair(db, 'station-2', 'station');
  expect(
    failure(() =>
      as(db, 'station-2', (ctx) =>
        m.gesture(ctx, { gestureId: 'x2', command: 'YES', heardStepSeq: 0n, heardOptionId: 0n, heardDigest: '', confidence: 1, source: 'jaw', onsetAgeMs: 0 }),
      ),
    ),
  ).toBe('not the session station');
  expect(
    failure(() =>
      as(db, PARTNER, (ctx) =>
        m.gesture(ctx, { gestureId: 'x3', command: 'YES', heardStepSeq: 0n, heardOptionId: 0n, heardDigest: '', confidence: 1, source: 'jaw', onsetAgeMs: 0 }),
      ),
    ),
  ).toBe('not allowed');
});

test('a new partner question while reading supersedes the old one and prepares the new one', () => {
  const db = newDb();
  const first = scanning(db);
  const second = ask(db, 'Are you cold?');
  expect(question(db, first.id).status.tag).toBe('Cancelled');
  const s = scan(db);
  expect([s.phase.tag, s.questionId]).toEqual(['Preparing', second.id]);
  const oldJob = [...db.db.agentJob.jobByQuestion.filter(first.id)][0]!;
  expect(oldJob.status.tag).toBe('Done'); // final publish already finished it
  expect(currentTimer(db).kind.tag).toBe('ClipDeadline');
});

test('a question that arrives during the veto waits, then starts when the reply is released', () => {
  const db = newDb();
  const first = scanning(db);
  gesture(db, 'YES');
  const second = ask(db, 'Are you cold?');
  expect(scan(db).phase.tag).toBe('Veto');
  expect(question(db, second.id).status.tag).toBe('Drafting');
  tick(db); // VetoEnd
  expect(question(db, first.id).status.tag).toBe('Released');
  expect([scan(db).phase.tag, scan(db).questionId]).toEqual(['Preparing', second.id]);
});

test('STOP while preparing stops the question and cancels its job; a late publish is refused as stale', () => {
  const db = newDb();
  const q = ask(db);
  const job = [...db.db.agentJob.jobByQuestion.filter(q.id)][0]!;
  as(db, 'agent', (ctx) => m.agentClaim(ctx, { jobId: job.id }));
  expect(gesture(db, 'STOP').outcome).toBe('accepted:stop');
  expect(question(db, q.id).status.tag).toBe('Stopped');
  expect(scan(db).phase.tag).toBe('Idle');
  const claimed = db.db.agentJob.id.find(job.id)!;
  expect(claimed.status.tag).toBe('Cancelled');
  expect(
    failure(() =>
      as(db, 'agent', (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: 1, answerMode: 'pick', options: [reply('Too late')], final: true })),
    ),
  ).toBe('stale attempt');
  expect(options(db, q.id, 1)).toHaveLength(0);
});

test('a final publish for a question the person already answered writes nothing and marks the job done', () => {
  const db = newDb();
  const q = ask(db);
  const job = [...db.db.agentJob.jobByQuestion.filter(q.id)][0]!;
  as(db, 'agent', (ctx) => m.agentClaim(ctx, { jobId: job.id }));
  // The question ends some other way while the job is still claimed (the partner cancels it); the job survives
  // only if it was not an Options job of that question, so simulate a job left claimed.
  db.db.question.id.update({ ...question(db, q.id), status: { tag: 'Spoken' } });
  as(db, 'agent', (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: 1, answerMode: 'pick', options: [reply('Late')], final: true }));
  expect(db.db.agentJob.id.find(job.id)!.status.tag).toBe('Done');
  expect(options(db, q.id, 1)).toHaveLength(0);
});
