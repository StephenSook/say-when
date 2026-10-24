// Shared helpers for the module's unit tests. Each test builds its own in-memory database from this module's
// schema with the 2.12+ harness (`spacetimedb/server/test-utils`), calls reducers directly as named callers, and
// reads the tables (private ones included). Timers never fire in the harness: a test reads the schedule row the
// module inserted, sets the clock to its time and calls the scheduled reducer itself as the database.
//
// Two harness facts the tests rely on: a fired one-shot row is not deleted (the host deletes it, the harness has
// no scheduler), and reading `test.db` from inside a `withReducerTx` body deadlocks the test datastore, so every
// helper reads state first and opens the transaction last.
import { ConnectionId, TimeDuration, Timestamp, type Identity } from 'spacetimedb';
import type { InferSchema } from 'spacetimedb/server';
import { createModuleTestHarness, TestAuth, type ModuleTestHarness } from 'spacetimedb/server/test-utils';
import type { Ctx } from '../ctx';
import * as m from '../index';
import spacetimedb, { type AnswerOption, type GestureLog, type OptionInput, type Question, type ScanState, type ScanTimer } from '../schema';

export type Test = ModuleTestHarness<InferSchema<typeof spacetimedb>>;

export const ISSUER = 'https://auth.example.test';
export const OWNER = 'owner';
export const STATION = 'station';
export const PARTNER = 'partner';
export const SPEAKER = 'speaker';
export const AGENT = 'agent';

/** Sat Oct 24 2026, 12:00:00 UTC. */
export const NOW_MICROS = 1_792_843_200_000_000n;

let nextConnection = 1n;
const auths = new Map<string, TestAuth>();

export function auth(subject: string): TestAuth {
  let a = auths.get(subject);
  if (!a) {
    a = TestAuth.fromJwtPayload(JSON.stringify({ iss: ISSUER, sub: subject }), new ConnectionId(nextConnection++));
    auths.set(subject, a);
  }
  return a;
}

export function idOf(test: Test, subject: string): Identity {
  return test.viewContext(auth(subject)).sender;
}

/** Run `body` as the client `subject`, in one transaction. */
export function as<T>(test: Test, subject: string, body: (ctx: Ctx) => T): T {
  return test.withReducerTx(auth(subject), body as never) as T;
}

/** Run `body` as the database itself (scheduled reducers). */
export function internal<T>(test: Test, body: (ctx: Ctx) => T): T {
  return test.withReducerTx(TestAuth.internal(), body as never) as T;
}

/** The message of the error `f` throws. Fails the test if it does not throw. */
export function failure(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected an error, but the call succeeded');
}

export function now(test: Test): Timestamp {
  return test.clock.now();
}

export function advance(test: Test, ms: number): void {
  test.clock.advance(TimeDuration.fromMillis(ms));
}

/** Lets `ms` pass the way a live station does: a healthy heartbeat every 500 ms keeps the dead-man lease alive. */
export function live(test: Test, ms: number): void {
  let left = ms;
  while (left > 0) {
    const step = Math.min(500, left);
    advance(test, step);
    beat(test);
    left -= step;
  }
}

export function micros(ts: Timestamp | undefined): bigint {
  if (!ts) throw new Error('no timestamp');
  return ts.microsSinceUnixEpoch;
}

/** A fresh database after `init`, published by OWNER. */
export function emptyDb(): Test {
  const test = createModuleTestHarness(spacetimedb, m);
  test.clock.set(new Timestamp(NOW_MICROS));
  as(test, OWNER, (ctx) => m.init(ctx, {}));
  return test;
}

let nextCode = 100000;

export function pair(test: Test, subject: string, role: 'station' | 'partner' | 'speaker' | 'agent', caregiver = false): void {
  const code = nextCode++;
  as(test, subject, (ctx) => m.requestPairing(ctx, { code, role, label: `${role} ${code}` }));
  as(test, OWNER, (ctx) => m.approvePairing(ctx, { code, caregiver }));
}

let nextBeat = 1n;

export function beat(test: Test, healthy = true): void {
  as(test, STATION, (ctx) => m.heartbeat(ctx, { beatSeq: nextBeat++, decoderHealthy: healthy }));
}

/** Four paired devices, an active session, one healthy heartbeat. The partner is a caregiver. */
export function newDb(): Test {
  const test = emptyDb();
  pair(test, STATION, 'station');
  pair(test, PARTNER, 'partner', true);
  pair(test, SPEAKER, 'speaker');
  pair(test, AGENT, 'agent');
  as(test, STATION, (ctx) => m.startSession(ctx, { label: 'demo' }));
  beat(test);
  return test;
}

export function sessionId(test: Test): bigint {
  return test.db.config.id.find(0)!.activeSessionId;
}

export function scan(test: Test): ScanState {
  return test.db.scanState.sessionId.find(sessionId(test))!;
}

export function question(test: Test, id: bigint): Question {
  return test.db.question.id.find(id)!;
}

export function options(test: Test, questionId: bigint, version: number): AnswerOption[] {
  return [...test.db.answerOption.optionByQv.filter([questionId, version])].sort((a, b) => a.rank - b.rank);
}

let nextRequest = 1;

export function ask(test: Test, text = 'Do you want some water?'): Question {
  const requestId = `req-${nextRequest++}`;
  as(test, PARTNER, (ctx) => m.askQuestion(ctx, { requestId, text, via: 'voice', listenMs: 800 }));
  return test.db.question.requestId.find(requestId)!;
}

export function pendingJob(test: Test, questionId: bigint, kind: 'Options' | 'ErrandPreview' | 'Remember' = 'Options') {
  return [...test.db.agentJob.jobByQuestion.filter(questionId)].find((j) => j.kind.tag === kind && j.status.tag === 'Pending');
}

/** The agent claims the question's pending job of this kind. Returns the claimed row. */
export function claim(test: Test, questionId: bigint, kind: 'Options' | 'ErrandPreview' | 'Remember' = 'Options') {
  const job = pendingJob(test, questionId, kind);
  if (!job) throw new Error(`no pending ${kind} job for question ${questionId}`);
  as(test, AGENT, (ctx) => m.agentClaim(ctx, { jobId: job.id }));
  return test.db.agentJob.id.find(job.id)!;
}

export function reply(text: string, extra: Partial<OptionInput> = {}): OptionInput {
  return { kind: 'reply', text, tone: 'warm', laugh: false, provenance: 'memory', sources: [], memoryRefs: [], actionJson: '', ...extra };
}

export const FORM_KEY = 'care_team_request';

export function errandOption(text = 'Send the care team a lunch request', formKey = FORM_KEY): OptionInput {
  return {
    kind: 'errand',
    text,
    tone: 'calm',
    laugh: false,
    provenance: 'model',
    sources: [],
    memoryRefs: [],
    actionJson: JSON.stringify({ formKey, formUrl: 'demo', formTitle: 'Care team request', fields: [{ label: 'Request', value: 'Lunch, please' }] }),
  };
}

export const CALL_DIGEST = '0123456789abcdef';

export function callOption(test: Test, requestId = 'call-1', contactId = 'leon'): OptionInput {
  return {
    kind: 'call',
    text: 'Call Leon',
    tone: 'calm',
    laugh: false,
    provenance: 'model',
    sources: [],
    memoryRefs: [],
    actionJson: JSON.stringify({
      requestId,
      contactId,
      recipientName: 'Leon',
      readBack: 'Call Leon to say your care team request was sent.',
      digest: CALL_DIGEST,
      expiresAt: Number(now(test).toMillis()) + 120_000,
    }),
  };
}

/** Claims and publishes one version for a question. */
export function publish(test: Test, questionId: bigint, opts: OptionInput[], mode: 'pick' | 'yes_no' = 'pick', final = true): number {
  const job =
    [...test.db.agentJob.jobByQuestion.filter(questionId)].find((j) => j.kind.tag === 'Options' && j.status.tag === 'Claimed') ??
    claim(test, questionId);
  as(test, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: job.attempt, answerMode: mode, options: opts, final }));
  const q = question(test, questionId);
  return Math.max(q.version, q.pendingVersion);
}

/** The station reports a measured clip for every option of a version. */
export function clips(test: Test, questionId: bigint, version: number, clipMs = 1000): void {
  for (const o of options(test, questionId, version)) {
    as(test, STATION, (ctx) => m.reportClipReady(ctx, { optionId: o.id, clipMs, synthMs: 200 }));
  }
}

/** A question asked, options published and clips in: the scan is Reading option 1. */
export function scanning(test: Test, opts: OptionInput[] = [reply('Yes, please'), reply('No, thank you'), reply('Later')], mode: 'pick' | 'yes_no' = 'pick'): Question {
  const q = ask(test);
  const v = publish(test, q.id, opts, mode);
  if (mode === 'pick') clips(test, q.id, v);
  return question(test, q.id);
}

export function scanTimers(test: Test): ScanTimer[] {
  return [...test.db.scanTimer.sessionId.filter(sessionId(test))];
}

/** The one-shot row armed for the current step. */
export function currentTimer(test: Test): ScanTimer {
  const s = scan(test);
  const rows = scanTimers(test).filter((r) => r.stepSeq === s.stepSeq);
  if (rows.length !== 1) throw new Error(`expected one timer for step ${s.stepSeq}, found ${rows.length}`);
  return rows[0]!;
}

export function timerAt(row: { scheduledAt: { tag: string; value: unknown } }): Timestamp {
  if (row.scheduledAt.tag !== 'Time') throw new Error('expected a one-shot timer');
  return row.scheduledAt.value as Timestamp;
}

/** Fires a scan timer row as the scheduler, at its time. */
export function fire(test: Test, row: ScanTimer): void {
  const at = timerAt(row);
  if (at.microsSinceUnixEpoch > test.clock.now().microsSinceUnixEpoch) test.clock.set(at);
  internal(test, (ctx) => m.scanTick(ctx, { job: row }));
}

/** Fires the current step's timer. */
export function tick(test: Test): void {
  fire(test, currentTimer(test));
}

export function currentOption(test: Test): AnswerOption | undefined {
  const s = scan(test);
  return options(test, s.questionId, s.version).find((o) => o.rank === s.cursor);
}

let nextGesture = 1;

export interface GestureOpts {
  heardStepSeq?: bigint;
  heardOptionId?: bigint;
  heardDigest?: string;
  onsetAgeMs?: number;
  gestureId?: string;
  source?: string;
}

/** Relays one command as the station, by default heard at the current step on the current option. */
export function gesture(test: Test, command: 'YES' | 'NO' | 'CONFIRM' | 'STOP' | 'HEADSET_OFF', opts: GestureOpts = {}): GestureLog {
  const s = scan(test);
  const gestureId = opts.gestureId ?? `g-${nextGesture++}`;
  as(test, STATION, (ctx) =>
    m.gesture(ctx, {
      gestureId,
      command,
      heardStepSeq: opts.heardStepSeq ?? s.stepSeq,
      heardOptionId: opts.heardOptionId ?? 0n,
      heardDigest: opts.heardDigest ?? '',
      confidence: 0.9,
      source: opts.source ?? (command === 'YES' || command === 'NO' ? 'imagery' : 'jaw'),
      onsetAgeMs: opts.onsetAgeMs ?? 0,
    }),
  );
  return test.db.gestureLog.gestureId.find(gestureId)!;
}

/** Moves past the refractory time so the next YES, NO or CONFIRM counts. */
export function settle(test: Test): void {
  advance(test, test.db.config.id.find(0)!.refractoryMs + 1);
}

export function grantConsent(test: Test, scope: 'web_search' | 'memory' | 'errand' | 'call' | 'board_text', subject = ''): void {
  as(test, OWNER, (ctx) => m.grantConsent(ctx, { scope, subject, method: 'owner_cli', note: 'test' }));
}

export function ledgerKinds(test: Test): string[] {
  return [...test.db.ledger.ledgerBySession.filter(sessionId(test))].sort((a, b) => (a.id < b.id ? -1 : 1)).map((l) => l.kind);
}
