// Direct select (D18, docs/direct-select.md): four gestures pick four options. The list is read once in rank
// order, then the clock waits for a pick; a reply is said at once; a Search, an errand and a call get a read-back
// and a two-option confirm (PICK_1 confirms, PICK_2 cancels); a Category starts its search with no confirm.
import { expect, test } from 'vitest';
import * as m from '../index';
import {
  AGENT,
  as,
  ask,
  CALL_DIGEST,
  callOption,
  claim,
  clips,
  currentTimer,
  errandOption,
  FORM_KEY,
  gesture,
  grantConsent,
  internal,
  live,
  micros,
  newDb,
  now,
  options,
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
import type { OptionInput } from '../schema';

function opt(kind: 'reply' | 'search' | 'category', label: string, text: string): OptionInput {
  return { kind, text, tone: '', laugh: false, provenance: 'model', sources: [], memoryRefs: [], actionJson: '', label };
}

const SMALL_TALK = [opt('reply', 'Good', "I'm doing awesome, how about you?"), opt('reply', 'Not great', 'Not great today.'), opt('reply', 'Tired', 'A bit tired.'), opt('reply', 'Excited', 'Excited, actually!')];

/** A question asked in Direct mode, options published and clips in: option 1 is being read. */
function listening(db: Test, opts: OptionInput[] = SMALL_TALK) {
  const q = ask(db, 'Hey, how are you?');
  const v = publish(db, q.id, opts);
  clips(db, q.id, v, 800);
  return question(db, q.id);
}

test('direct mode is the default on a new database, and the list is read once in rank order with no window', () => {
  const db = newDb('direct');
  expect(db.db.config.id.find(0)!.inputMode.tag).toBe('Direct');
  listening(db);
  const first = scan(db);
  expect([first.phase.tag, first.cursor, first.optionCount]).toEqual(['Reading', 1, 4]);
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

test('a reply pick is said in the room at once, with its label and kind on the board', () => {
  const db = newDb('direct');
  const q = listening(db);
  tick(db); // option 2 is being read
  live(db, 300);
  const g = gesture(db, 'PICK_3');
  expect(g.outcome).toBe('accepted:pick_reply');
  const done = question(db, q.id);
  expect([done.status.tag, done.replyText]).toEqual(['Released', 'A bit tired.']);
  expect([scan(db).phase.tag, scan(db).pickedRank]).toEqual(['Idle', 3]);
});

test('set_input_mode switches between scan and direct only while no session is active', () => {
  const db = newDb('direct');
  expect(() => as(db, OWNER, (ctx) => m.setInputMode(ctx, { mode: 'scan' }))).toThrow('a session is active');
  as(db, STATION, (ctx) => m.endSession(ctx, {}));
  as(db, OWNER, (ctx) => m.setInputMode(ctx, { mode: 'scan' }));
  expect(db.db.config.id.find(0)!.inputMode.tag).toBe('Scan');
  expect(() => as(db, OWNER, (ctx) => m.setInputMode(ctx, { mode: 'sideways' }))).toThrow('mode must be direct or scan');
  expect(() => as(db, STATION, (ctx) => m.setInputMode(ctx, { mode: 'direct' }))).toThrow();
});

export { AGENT, CALL_DIGEST, callOption, claim, errandOption, FORM_KEY, grantConsent, internal, options, settle };
