// Agent coordination: a leased job with an attempt number, so a stalled agent's late write is refused.
import { expect, test } from 'vitest';
import { Identity } from 'spacetimedb';
import * as m from '../index';
import { publicCode } from '../util';
import {
  advance,
  AGENT,
  as,
  ask,
  auth,
  claim,
  clips,
  failure,
  grantConsent,
  internal,
  micros,
  newDb,
  now,
  OWNER,
  pair,
  publish,
  question,
  reply,
  scan,
  scanning,
  SPEAKER,
  tick,
  gesture,
  timerAt,
  type Test,
} from './harness';

function leasesOf(db: Test, jobId: bigint) {
  return [...db.db.jobLease.jobId.filter(jobId)];
}

function lapse(db: Test, jobId: bigint, attempt: number) {
  const row = leasesOf(db, jobId).find((r) => r.attempt === attempt)!;
  db.clock.set(timerAt(row));
  internal(db, (ctx) => m.leaseExpired(ctx, { job: row }));
}

test('a claim gives attempt 1 and a 45 s lease row', () => {
  const db = newDb();
  const q = ask(db);
  const job = claim(db, q.id);
  expect([job.status.tag, job.attempt]).toEqual(['Claimed', 1]);
  const leases = leasesOf(db, job.id);
  expect(leases).toHaveLength(1);
  expect(micros(timerAt(leases[0]!)) - micros(now(db))).toBe(45_000_000n);
});

test('a lapsed lease requeues the job; the next claim is attempt 2, and attempt 1 is refused from then on', () => {
  const db = newDb();
  const q = ask(db);
  const first = claim(db, q.id);
  lapse(db, first.id, 1);
  const requeued = db.db.agentJob.id.find(first.id)!;
  expect([requeued.status.tag, requeued.attempt]).toEqual(['Pending', 1]);
  expect(requeued.claimedBy.isEqual(Identity.zero())).toBe(true);
  const second = claim(db, q.id);
  expect(second.attempt).toBe(2);
  expect(
    failure(() => as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: first.id, attempt: 1, answerMode: 'pick', options: [reply('Stale')], final: true }))),
  ).toBe('stale attempt');
  as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: first.id, attempt: 2, answerMode: 'pick', options: [reply('Fresh')], final: true }));
  expect(question(db, q.id).version).toBe(1);
});

test('an old lease row firing after a newer claim does nothing', () => {
  const db = newDb();
  const q = ask(db);
  const job = claim(db, q.id);
  const oldLease = leasesOf(db, job.id)[0]!;
  lapse(db, job.id, 1);
  claim(db, q.id); // attempt 2
  internal(db, (ctx) => m.leaseExpired(ctx, { job: oldLease }));
  const row = db.db.agentJob.id.find(job.id)!;
  expect([row.status.tag, row.attempt]).toEqual(['Claimed', 2]);
});

test('a write after the lease ran out is refused even before lease_expired runs, and cannot renew the lease', () => {
  const db = newDb();
  grantConsent(db, 'web_search');
  const q = ask(db);
  const job = claim(db, q.id);
  const lease = leasesOf(db, job.id)[0]!;
  advance(db, 45_000); // exactly the lease: it has run out
  const progress = () =>
    as(db, AGENT, (ctx) =>
      m.agentProgress(ctx, { jobId: job.id, attempt: 1, eventKey: 'late:search', stage: 'search', status: 'ok', detail: 'web', ms: 1, countsJson: '', payloadJson: '' }),
    );
  expect(failure(progress)).toBe('stale attempt');
  expect(
    failure(() => as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: 1, answerMode: 'pick', options: [reply('Late')], final: true }))),
  ).toBe('stale attempt');
  expect(leasesOf(db, job.id).map((r) => r.scheduledId)).toEqual([lease.scheduledId]); // not renewed
  expect(question(db, q.id).version).toBe(0);
  internal(db, (ctx) => m.leaseExpired(ctx, { job: lease }));
  expect(db.db.agentJob.id.find(job.id)!.status.tag).toBe('Pending');
});

test('an older lease row of the same attempt does nothing once progress extended the lease', () => {
  const db = newDb();
  grantConsent(db, 'web_search');
  const q = ask(db);
  const job = claim(db, q.id);
  const first = leasesOf(db, job.id)[0]!;
  advance(db, 10_000);
  as(db, AGENT, (ctx) =>
    m.agentProgress(ctx, { jobId: job.id, attempt: 1, eventKey: 'p1', stage: 'retrieve', status: 'ok', detail: 'memory', ms: 1, countsJson: '', payloadJson: '' }),
  );
  db.clock.set(timerAt(first)); // the old deadline: the lease now runs 10 s longer
  internal(db, (ctx) => m.leaseExpired(ctx, { job: first }));
  expect(db.db.agentJob.id.find(job.id)!.status.tag).toBe('Claimed');
});

test('after job_max_attempts lapses the job fails, and a question with nothing to read fails with it', () => {
  const db = newDb();
  const q = ask(db);
  for (let attempt = 1; attempt <= 3; attempt++) {
    claim(db, q.id);
    lapse(db, [...db.db.agentJob.jobByQuestion.filter(q.id)][0]!.id, attempt);
  }
  const job = [...db.db.agentJob.jobByQuestion.filter(q.id)][0]!;
  expect([job.status.tag, job.reason]).toEqual(['Failed', 'lease_lapsed']);
  expect(question(db, q.id).status.tag).toBe('Failed');
  expect(scan(db).phase.tag).toBe('Idle');
});

test('a job that fails after early options keeps the question scanning those options', () => {
  const db = newDb();
  const q = ask(db);
  publish(db, q.id, [reply('From memory')], 'pick', false);
  clips(db, q.id, 1);
  const job = [...db.db.agentJob.jobByQuestion.filter(q.id)][0]!;
  as(db, AGENT, (ctx) => m.agentFail(ctx, { jobId: job.id, attempt: job.attempt, reasonCode: 'search_failed', reason: '' }));
  expect(db.db.agentJob.id.find(job.id)!.status.tag).toBe('Failed');
  expect(question(db, q.id).status.tag).toBe('Scanning');
  expect(scan(db).phase.tag).toBe('Reading');
});

test('agent_fail with nothing to read fails the question and frees the clock', () => {
  const db = newDb();
  const q = ask(db);
  const job = claim(db, q.id);
  as(db, AGENT, (ctx) => m.agentFail(ctx, { jobId: job.id, attempt: 1, reasonCode: 'planner_timeout', reason: 'The model did not answer.' }));
  expect(question(db, q.id).status.tag).toBe('Failed');
  expect(scan(db).phase.tag).toBe('Idle');
  const errors = [...db.db.pipelineEvent.eventBySession.filter(scan(db).sessionId)].filter((e) => e.status === 'error');
  expect(errors.map((e) => [e.stage, e.detail])).toEqual([
    ['plan', 'failed: planner_timeout'],
    ['select', 'failed'],
  ]);
});

test('agent_progress writes a public, content-free event with a private payload, once per key, and extends the lease', () => {
  const db = newDb();
  grantConsent(db, 'web_search');
  const q = ask(db);
  const job = claim(db, q.id);
  advance(db, 10_000);
  const write = () =>
    as(db, AGENT, (ctx) =>
      m.agentProgress(ctx, {
        jobId: job.id,
        attempt: 1,
        eventKey: `${job.id}:1:search:ok`,
        stage: 'search',
        status: 'ok',
        detail: 'web partial',
        ms: 1800,
        countsJson: JSON.stringify({ rows: 6, needsWeb: true }),
        payloadJson: JSON.stringify({ reason: 'opening hours', rows: [] }),
      }),
    );
  write();
  write();
  const events = [...db.db.pipelineEvent.eventBySession.filter(scan(db).sessionId)].filter((e) => e.stage === 'search');
  expect(events).toHaveLength(1);
  expect([events[0]!.detail, events[0]!.ms, events[0]!.actor]).toEqual(['web partial', 1800, 'Agent']);
  expect(db.db.pipelinePayload.eventId.find(events[0]!.id)!.payloadJson).toContain('opening hours');
  const leases = leasesOf(db, job.id);
  expect(leases).toHaveLength(1);
  expect(micros(timerAt(leases[0]!)) - micros(now(db))).toBe(45_000_000n); // pushed forward from the progress
});

test('agent_progress refuses a search without web search consent, a free-text label and text in counts', () => {
  const db = newDb();
  const q = ask(db);
  const job = claim(db, q.id);
  const base = { jobId: job.id, attempt: 1, stage: 'search', status: 'started', detail: 'web', ms: 0, countsJson: '{}', payloadJson: '' };
  expect(failure(() => as(db, AGENT, (ctx) => m.agentProgress(ctx, { ...base, eventKey: 'k1' })))).toContain('web search is not allowed');
  expect(failure(() => as(db, AGENT, (ctx) => m.agentProgress(ctx, { ...base, stage: 'retrieve', eventKey: 'k2', detail: 'Found Leon at home' })))).toBe('bad detail');
  expect(
    failure(() => as(db, AGENT, (ctx) => m.agentProgress(ctx, { ...base, stage: 'retrieve', eventKey: 'k3', countsJson: JSON.stringify({ name: 'Leon' }) }))),
  ).toContain('numbers or booleans');
  // A key is public too: it must be an identifier, never a phrase.
  expect(
    failure(() => as(db, AGENT, (ctx) => m.agentProgress(ctx, { ...base, stage: 'retrieve', eventKey: 'k4', countsJson: JSON.stringify({ 'Jane Doe medication request': 1 }) }))),
  ).toContain('identifiers');
  as(db, AGENT, (ctx) => m.agentProgress(ctx, { ...base, stage: 'retrieve', eventKey: 'k5', countsJson: JSON.stringify({ hits: 3, mossMs: 12, skippedRows: 0 }) }));
});

test('counts_json is stored as the checked object, so a duplicate key cannot hide a sentence in the public row', () => {
  const db = newDb();
  const q = ask(db);
  const job = claim(db, q.id);
  // JSON.parse keeps the last `rows`, so the checks pass; the original text still holds the first one.
  const sneaky = '{"rows":"alice takes lithium","rows":1}';
  as(db, AGENT, (ctx) =>
    m.agentProgress(ctx, { jobId: job.id, attempt: 1, eventKey: 'dup:1', stage: 'retrieve', status: 'ok', detail: 'memory', ms: 3, countsJson: sneaky, payloadJson: '' }),
  );
  const row = db.db.pipelineEvent.eventKey.find('dup:1')!;
  expect(row.countsJson).toBe('{"rows":1}');
  expect(row.countsJson).not.toContain('alice');
});

test('a reason code reaches public rows only from the fixed list: anything else becomes a module word', () => {
  const db = newDb();
  const q = ask(db);
  const job = claim(db, q.id);
  // Code-shaped is not content-free: `normCode` alone would publish this as `alice_takes_lithium`.
  as(db, AGENT, (ctx) => m.agentFail(ctx, { jobId: job.id, attempt: 1, reasonCode: 'Alice takes lithium', reason: 'The model did not answer.' }));
  const rows = db.runQuery<{ kind: string; reason: string }>(m.boardLedger(db.anonymousViewContext()));
  expect(rows.find((r) => r.kind === 'job_failed')!.reason).toBe('agent_failed');
  expect(db.db.agentJob.id.find(job.id)!.reason).toBe('agent_failed');
  const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  for (const row of [...rows, ...db.db.pipelineEvent.iter()]) expect(show(row).toLowerCase()).not.toContain('alice');

  // The sidecar's own codes keep their meaning: exact codes, prefixed codes and HTTP statuses, in any case.
  const q2 = ask(db, 'Shall I check the bus times?');
  const job2 = claim(db, q2.id);
  as(db, AGENT, (ctx) => m.agentFail(ctx, { jobId: job2.id, attempt: 1, reasonCode: 'Planner_Timeout', reason: '' }));
  expect(db.db.agentJob.id.find(job2.id)!.reason).toBe('planner_timeout');
  for (const [given, kept] of [
    ['preview_http_404', 'preview_http_404'],
    ['not_sent_network', 'not_sent_network'],
    ['captcha', 'captcha'],
    ['preview_alice', 'x'],
    ['http_999', 'x'],
    ['planner_', 'x'],
  ] as const) {
    expect(publicCode(given, 'x'), given).toBe(kept);
  }
});

test('publish refuses a call expiry that would not fit the stored timestamp', () => {
  const db = newDb();
  const q = ask(db);
  const job = claim(db, q.id);
  const call = (expiresAt: number) => ({
    kind: 'call',
    text: 'Call Leon',
    tone: '',
    laugh: false,
    provenance: 'model',
    sources: [],
    memoryRefs: [],
    actionJson: JSON.stringify({ requestId: 'c-1', contactId: 'leon', recipientName: 'Leon', readBack: 'Call Leon.', digest: '0123456789abcdef', expiresAt }),
  });
  for (const bad of [2 ** 64, -1, 1.5, 8_640_000_000_000_001]) {
    expect(
      failure(() => as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: 1, answerMode: 'pick', options: [call(bad)], final: false }))),
    ).toBe('bad expiresAt');
  }
  as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: 1, answerMode: 'pick', options: [call(Number(now(db).toMillis()) + 120_000)], final: true }));
  expect(question(db, q.id).version).toBe(1);
});

test('publish validates the options: counts, yes_no pairs, tones and errand actions', () => {
  const db = newDb();
  const q = ask(db);
  const job = claim(db, q.id);
  const publishWith = (answerMode: string, options: ReturnType<typeof reply>[]) => () =>
    as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: 1, answerMode, options, final: false }));
  expect(failure(publishWith('pick', [1, 2, 3, 4, 5].map((n) => reply(`Option ${n}`))))).toContain('pick takes 1 to 4');
  expect(failure(publishWith('yes_no', [reply('Yes'), reply('No'), reply('Maybe')]))).toContain('exactly 2');
  expect(failure(publishWith('pick', [reply('Shout', { tone: 'angry' })]))).toContain('tone must be');
  expect(failure(publishWith('pick', [reply('Send it', { kind: 'errand', actionJson: '{}' })]))).toBe('bad formKey');
  expect(failure(publishWith('maybe', [reply('Yes')]))).toContain('answer_mode');
  expect(question(db, q.id).version).toBe(0); // nothing was written
});

test('another agent cannot write to a job it does not hold', () => {
  const db = newDb();
  pair(db, 'agent-2', 'agent');
  const q = ask(db);
  const job = claim(db, q.id);
  expect(
    failure(() => as(db, 'agent-2', (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: 1, answerMode: 'pick', options: [reply('Hijack')], final: true }))),
  ).toBe('stale attempt');
});

test('a spoken reply with Memory consent queues a Remember job that only agent_done finishes', () => {
  const db = newDb();
  grantConsent(db, 'memory');
  const q = scanning(db);
  gesture(db, 'YES');
  tick(db);
  as(db, SPEAKER, (ctx) => m.replySpoken(ctx, { questionId: q.id, ms: 1200 }));
  const job = claim(db, q.id, 'Remember');
  expect(
    failure(() => as(db, AGENT, (ctx) => m.agentPublishOptions(ctx, { jobId: job.id, attempt: 1, answerMode: 'pick', options: [reply('x')], final: true }))),
  ).toBe('not an options job');
  as(db, AGENT, (ctx) => m.agentDone(ctx, { jobId: job.id, attempt: 1, countsJson: JSON.stringify({ docs: 1 }) }));
  expect(db.db.agentJob.id.find(job.id)!.status.tag).toBe('Done');
});

test('agent_queue shows pending jobs to every agent and claimed jobs only to their holder', () => {
  const db = newDb();
  pair(db, 'agent-2', 'agent');
  const q1 = ask(db, 'Do you want water?');
  const q2 = ask(db, 'Are you cold?');
  claim(db, q2.id);
  const mine = m.agentQueue(db.viewContext(auth(AGENT)));
  const theirs = m.agentQueue(db.viewContext(auth('agent-2')));
  // q1 was superseded by q2, so its job is cancelled and gone from both queues.
  expect(mine.map((r) => [r.questionText, r.status.tag, r.claimedByMe])).toEqual([['Are you cold?', 'Claimed', true]]);
  expect(theirs).toEqual([]);
  expect(question(db, q1.id).status.tag).toBe('Cancelled');
  expect(m.agentQueue(db.viewContext(auth(SPEAKER)))).toEqual([]);
});

test('revoking memory or web search consent reaches the jobs not yet done', () => {
  const db = newDb();
  grantConsent(db, 'memory');
  grantConsent(db, 'web_search');
  const q = scanning(db);
  gesture(db, 'YES');
  tick(db); // the reply is released
  as(db, SPEAKER, (c) => m.replySpoken(c, { questionId: q.id, ms: 900 })); // queues a Remember job
  const remember = claim(db, q.id, 'Remember');
  const q2 = ask(db, 'Shall I look up the bus times?');
  const options = claim(db, q2.id);
  expect([options.webSearchAllowed, options.memoryAllowed]).toEqual([true, true]);
  const revoke = (scope: 'WebSearch' | 'Memory') => {
    const row = [...db.db.consent.consentByScope.filter({ tag: scope })].find((r) => r.revokedAt === undefined)!;
    as(db, OWNER, (c) => m.revokeConsent(c, { consentId: row.id }));
  };

  revoke('WebSearch');
  expect([db.db.agentJob.id.find(options.id)!.webSearchAllowed, db.db.agentJob.id.find(options.id)!.status.tag]).toEqual([false, 'Claimed']);
  const search = { jobId: options.id, attempt: 1, eventKey: 'after-revoke', stage: 'search', status: 'started', detail: 'web', ms: 0, countsJson: '', payloadJson: '' };
  expect(failure(() => as(db, AGENT, (c) => m.agentProgress(c, search)))).toContain('web search is not allowed');

  revoke('Memory');
  expect(db.db.agentJob.id.find(options.id)!.memoryAllowed).toBe(false);
  expect([db.db.agentJob.id.find(remember.id)!.status.tag, db.db.agentJob.id.find(remember.id)!.reason]).toEqual(['Cancelled', 'consent_revoked']);
  // The reply is never written into memory: the sidecar's late write is refused.
  expect(failure(() => as(db, AGENT, (c) => m.agentDone(c, { jobId: remember.id, attempt: 1, countsJson: '' })))).toBe('stale attempt');
});
