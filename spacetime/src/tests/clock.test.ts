// The scan clock (D12 item 1): one public row moved by one-shot scheduled reducers, fenced by stepSeq.
import { expect, test } from 'vitest';
import * as m from '../index';
import {
  advance,
  AGENT,
  as,
  ask,
  claim,
  clips,
  currentTimer,
  fire,
  micros,
  newDb,
  now,
  options,
  publish,
  question,
  reply,
  scan,
  scanning,
  scanTimers,
  tick,
  timerAt,
} from './harness';

test('options plus measured clips start the scan at option 1, dwelling for the clip plus the audio pad', () => {
  const db = newDb();
  const q = ask(db);
  expect(scan(db).phase.tag).toBe('Preparing');
  expect(scan(db).questionId).toBe(q.id);
  const v = publish(db, q.id, [reply('Yes, please'), reply('No, thank you')]);
  expect(v).toBe(1);
  expect(scan(db).phase.tag).toBe('Preparing'); // waiting for clips
  clips(db, q.id, v, 1200);
  const s = scan(db);
  expect(s.phase.tag).toBe('Reading');
  expect([s.cursor, s.pass, s.optionCount]).toEqual([1, 1, 2]);
  expect(s.optionStartSeq).toBe(s.stepSeq);
  expect(micros(timerAt(currentTimer(db))) - micros(now(db))).toBe(1_350_000n); // 1200 ms clip + 150 ms pad
  expect(question(db, q.id).status.tag).toBe('Scanning');
  expect(scanTimers(db)).toHaveLength(1);
});

test('a tick moves Reading to the silent window, and the next tick reads the next option', () => {
  const db = newDb();
  scanning(db);
  const first = scan(db);
  tick(db);
  const window = scan(db);
  expect(window.phase.tag).toBe('Window');
  expect(window.cursor).toBe(1);
  expect(window.stepSeq).toBe(first.stepSeq + 1n);
  expect(micros(timerAt(currentTimer(db))) - micros(now(db))).toBe(3_500_000n); // response_window_ms
  tick(db);
  const second = scan(db);
  expect(second.phase.tag).toBe('Reading');
  expect(second.cursor).toBe(2);
  expect(second.prevCursor).toBe(1);
  expect(second.prevOptionStartSeq).toBe(first.optionStartSeq);
  expect(scanTimers(db)).toHaveLength(1); // every step deletes the old row before inserting the next
});

test('a stale tick (an older stepSeq) does nothing', () => {
  const db = newDb();
  scanning(db);
  const stale = currentTimer(db);
  tick(db);
  const before = scan(db);
  fire(db, stale);
  const after = scan(db);
  expect(after.stepSeq).toBe(before.stepSeq);
  expect(after.phase.tag).toBe('Window');
  expect(after.cursor).toBe(before.cursor);
});

test('after the last window of the last pass the scan ends No pick and nothing is said', () => {
  const db = newDb();
  const q = scanning(db);
  let guard = 0;
  while (scan(db).phase.tag !== 'Idle') {
    tick(db);
    if (++guard > 50) throw new Error('the scan never ended');
  }
  const s = scan(db);
  expect(s.outcome?.tag).toBe('NoPick');
  // 3 options x 2 passes x (reading + window) = 12 ticks
  expect(guard).toBe(12);
  const done = question(db, q.id);
  expect(done.status.tag).toBe('NoPick');
  expect(done.replyText).toBeUndefined();
  expect(done.releasedAt).toBeUndefined();
  expect(scanTimers(db)).toHaveLength(0);
});

test('the second pass starts again from option 1', () => {
  const db = newDb();
  scanning(db, [reply('Yes'), reply('No')]);
  for (let i = 0; i < 4; i++) tick(db); // both options, reading and window
  const s = scan(db);
  expect([s.phase.tag, s.cursor, s.pass]).toEqual(['Reading', 1, 2]);
});

test('a newer version published while reading waits for the end of the pass, then switches in', () => {
  const db = newDb();
  const q = ask(db);
  publish(db, q.id, [reply('From memory 1'), reply('From memory 2')], 'pick', false);
  clips(db, q.id, 1);
  expect(scan(db).phase.tag).toBe('Reading');
  const job = [...db.db.agentJob.jobByQuestion.filter(q.id)][0]!;
  expect(job.status.tag).toBe('Claimed'); // final = false keeps the job
  as(db, AGENT, (ctx) =>
    m.agentPublishOptions(ctx, { jobId: job.id, attempt: job.attempt, answerMode: 'pick', options: [reply('From the web 1'), reply('From the web 2'), reply('From the web 3')], final: true }),
  );
  expect(question(db, q.id).pendingVersion).toBe(2);
  expect(scan(db).version).toBe(1); // still reading version 1
  clips(db, q.id, 2);
  for (let i = 0; i < 4; i++) tick(db); // finish pass 1 of version 1
  const s = scan(db);
  expect(s.version).toBe(2);
  expect([s.phase.tag, s.cursor, s.pass, s.optionCount]).toEqual(['Reading', 1, 1, 3]);
  expect(question(db, q.id).pendingVersion).toBe(0);
});

test('a late clip does not hold the scan: the clip deadline starts it with estimated lengths', () => {
  const db = newDb();
  const q = ask(db);
  publish(db, q.id, [reply('Yes'), reply('No')]);
  const deadline = currentTimer(db);
  expect(deadline.kind.tag).toBe('ClipDeadline');
  expect(micros(timerAt(deadline)) - micros(now(db))).toBe(4_000_000n);
  tick(db);
  const s = scan(db);
  expect(s.phase.tag).toBe('Reading');
  // estimate: 300 ms + 60 ms per character ("Yes" is 3) + 150 ms pad
  expect(micros(timerAt(currentTimer(db))) - micros(now(db))).toBe(630_000n);
});

test('a clip deadline with no options yet keeps the question preparing and arms nothing new', () => {
  const db = newDb();
  ask(db);
  const deadline = currentTimer(db);
  tick(db);
  expect(scan(db).phase.tag).toBe('Preparing');
  // The harness never deletes a fired one-shot row (the host does), so the only row left is the one that fired.
  expect(scanTimers(db).map((r) => r.scheduledId)).toEqual([deadline.scheduledId]);
});

test('a yes or no question starts at once with the stock prompt at cursor 0', () => {
  const db = newDb();
  scanning(db, [reply('Yes, I am tired'), reply('No, I am fine')], 'yes_no');
  const s = scan(db);
  expect(s.answerMode.tag).toBe('YesNo');
  expect([s.phase.tag, s.cursor, s.optionCount]).toEqual(['Reading', 0, 2]);
  expect(micros(timerAt(currentTimer(db))) - micros(now(db))).toBe(900_000n); // yes_no_cue_ms
});

test('a clip for an old version is ignored quietly', () => {
  const db = newDb();
  const q = ask(db);
  publish(db, q.id, [reply('One')], 'pick', false);
  const job = [...db.db.agentJob.jobByQuestion.filter(q.id)][0]!;
  as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: job.attempt, answerMode: 'pick', options: [reply('Two')], final: true }));
  // Preparing switched to version 2; a clip for version 1 changes nothing.
  expect(question(db, q.id).version).toBe(2);
  const old = options(db, q.id, 1)[0]!;
  as(db, 'station', (ctx) => m.reportClipReady(ctx, { optionId: old.id, clipMs: 900, synthMs: 100 }));
  expect(db.db.answerOption.id.find(old.id)!.clipMs).toBeUndefined();
  expect(scan(db).phase.tag).toBe('Preparing');
});

test('every step is written to the ledger with its dwell', () => {
  const db = newDb();
  scanning(db);
  advance(db, 10);
  const steps = [...db.db.ledger.ledgerBySession.filter(scan(db).sessionId)].filter((l) => l.kind === 'step');
  expect(steps).toHaveLength(1);
  expect(steps[0]!.ms).toBe(1150);
  expect(steps[0]!.cursor).toBe(1);
});

test('a claimed job extends its own lease, and a second claim of the same job is refused', () => {
  const db = newDb();
  const q = ask(db);
  claim(db, q.id);
  const job = [...db.db.agentJob.jobByQuestion.filter(q.id)][0]!;
  expect(() => as(db, AGENT, (ctx) => m.agentClaim(ctx, { jobId: job.id }))).toThrow('not pending');
});
