// D19, the paced scan: silence reads the same option again; only NO moves on, only YES picks, the idle pause caps it.
import { expect, test } from 'vitest';
import { PACED_SCAN, scanPolicy } from '../clock';
import * as m from '../index';
import { gesture, internal, micros, newDb, question, reply, scan, scanning, settle, tick, timerAt } from './harness';

function pacedDb(): ReturnType<typeof newDb> {
  const db = newDb();
  scanPolicy.silenceRepeats = true;
  return db;
}

test('the module ships with the paced scan on', () => {
  expect(PACED_SCAN).toBe(true);
});

test('silence reads the same option again, and it stays one option from its first read', () => {
  const db = pacedDb();
  const q = scanning(db);
  const first = scan(db);
  for (let i = 0; i < 6; i++) tick(db); // Reading, Window, three times over
  const again = scan(db);
  expect([again.phase.tag, again.cursor, again.pass]).toEqual(['Reading', 1, 1]);
  expect(again.stepSeq).toBe(first.stepSeq + 6n);
  expect(again.optionStartSeq).toBe(first.optionStartSeq);
  expect(micros(again.optionStartedAt)).toBe(micros(first.optionStartedAt));
  expect(question(db, q.id).status.tag).toBe('Scanning');
});

test('a YES heard on the first read still picks that option after it was read again', () => {
  const db = pacedDb();
  scanning(db);
  const first = scan(db);
  tick(db); // Window
  tick(db); // read again
  tick(db); // Window
  const g = gesture(db, 'YES', { heardStepSeq: first.stepSeq });
  expect(g.outcome).toBe('accepted:pick');
  expect([scan(db).phase.tag, scan(db).pickedRank]).toEqual(['Veto', 1]);
});

test('NO moves to the next option, and silence then repeats that one', () => {
  const db = pacedDb();
  scanning(db);
  tick(db); // Window on option 1
  expect(gesture(db, 'NO').outcome).toBe('accepted:skip');
  expect([scan(db).phase.tag, scan(db).cursor]).toEqual(['Reading', 2]);
  tick(db);
  tick(db);
  expect([scan(db).phase.tag, scan(db).cursor, scan(db).pass]).toEqual(['Reading', 2, 1]);
});

test('NO on the last option still ends the pass: the next pass starts at option 1', () => {
  const db = pacedDb();
  scanning(db, [reply('Yes, please'), reply('No, thank you')]);
  gesture(db, 'NO');
  settle(db);
  gesture(db, 'NO');
  expect([scan(db).phase.tag, scan(db).cursor, scan(db).pass]).toEqual(['Reading', 1, 2]);
});

test('a yes or no prompt is asked again on silence and never ends in No pick by itself', () => {
  const db = pacedDb();
  const q = scanning(db, [reply('Yes'), reply('No')], 'yes_no');
  for (let i = 0; i < 8; i++) tick(db);
  expect([scan(db).phase.tag, scan(db).cursor, scan(db).pass]).toEqual(['Reading', 0, 1]);
  expect(question(db, q.id).status.tag).toBe('Scanning');
  expect(gesture(db, 'YES').outcome).toBe('accepted:answer_yes');
  expect([scan(db).phase.tag, scan(db).pickedRank]).toEqual(['Veto', 1]);
});

test('the idle pause still ends a wait with no answer, and nothing is said', () => {
  const db = pacedDb();
  const q = scanning(db);
  for (let i = 0; i < 4; i++) tick(db); // repeats do not re-arm the idle timer
  const idle = [...db.db.idleTimer.sessionId.filter(scan(db).sessionId)][0]!;
  db.clock.set(timerAt(idle));
  internal(db, (ctx) => m.idlePause(ctx, { job: idle }));
  expect([scan(db).phase.tag, scan(db).pauseReason?.tag]).toEqual(['Paused', 'Idle']);
  expect(question(db, q.id).replyText).toBeFalsy();
});
