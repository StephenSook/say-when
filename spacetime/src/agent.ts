// The agent sidecar's fenced writes (docs/spacetime.md 3.6, 4.5): progress, options, failures, lapsed leases.
import { SenderError } from 'spacetimedb/server';
import { closeQuestion, enterPreparing, isScanActive } from './clock';
import { getConfig } from './config';
import { checkCallAction, checkErrandAction, failDraftedErrand } from './consent';
import type { Ctx } from './ctx';
import { endJob, extendLease, requeueJob } from './jobs';
import type { AgentJob, AnswerMode, OptionInput, OptionKind, Question } from './schema';
import {
  appendLedger,
  DETAIL_RE,
  KEY_RE,
  normCode,
  requireCountsJson,
  requireMatch,
  requireOptionalText,
  requireText,
  STAGE_STATUSES,
  STAGES,
  writePipeline,
} from './util';

/** The Cartesia tones the station can play (`cartesia/src/tones.ts` TONES). Empty means the voice's default. */
export const TONES = ['neutral', 'calm', 'warm', 'sad', 'firm'] as const;
const PROVENANCE_RE = /^[a-z_]{0,16}$/;
const OPEN_STATUSES = ['Drafting', 'Ready', 'Scanning'];

function sessionOf(ctx: Ctx, job: AgentJob): bigint {
  return ctx.db.question.id.find(job.questionId)?.sessionId ?? 0n;
}

export interface ProgressInput {
  eventKey: string;
  stage: string;
  status: string;
  detail: string;
  ms: number;
  countsJson: string;
  payloadJson: string;
}

/** `agent_progress`: one pipeline event (and its private payload), and a longer lease. */
export function agentProgress(ctx: Ctx, job: AgentJob, p: ProgressInput): void {
  requireMatch(p.eventKey, KEY_RE, 'event_key');
  if (!(STAGES as readonly string[]).includes(p.stage)) throw new SenderError(`stage must be one of ${STAGES.join(', ')}`);
  if (!(STAGE_STATUSES as readonly string[]).includes(p.status)) throw new SenderError('status must be started, ok or error');
  requireMatch(p.detail, DETAIL_RE, 'detail');
  const countsJson = requireCountsJson(p.countsJson);
  if (p.payloadJson.length > 16384) throw new SenderError('payload_json is larger than 16 KB');
  if (p.stage === 'search' && !job.webSearchAllowed) throw new SenderError('web search is not allowed for this job');
  if (!ctx.db.pipelineEvent.eventKey.find(p.eventKey)) {
    writePipeline(ctx, {
      eventKey: p.eventKey,
      sessionId: sessionOf(ctx, job),
      questionId: job.questionId,
      stage: p.stage as (typeof STAGES)[number],
      status: p.status as (typeof STAGE_STATUSES)[number],
      detail: p.detail,
      ms: p.ms,
      countsJson,
      actor: 'Agent',
      payloadJson: p.payloadJson,
    });
  }
  extendLease(ctx, job);
}

function parseAnswerMode(value: string): AnswerMode {
  if (value === 'pick') return { tag: 'Pick' };
  if (value === 'yes_no') return { tag: 'YesNo' };
  throw new SenderError('answer_mode must be pick or yes_no');
}

function parseKind(value: string): OptionKind {
  if (value === 'reply') return { tag: 'Reply' };
  if (value === 'errand') return { tag: 'Errand' };
  if (value === 'call') return { tag: 'Call' };
  throw new SenderError('option kind must be reply, errand or call');
}

function checkOption(o: OptionInput, mode: AnswerMode): OptionKind {
  const kind = parseKind(o.kind);
  if (mode.tag === 'YesNo' && kind.tag !== 'Reply') throw new SenderError('yes_no options must be replies');
  requireText(o.text, 'option text', 200);
  if (o.tone !== '' && !(TONES as readonly string[]).includes(o.tone)) throw new SenderError(`tone must be one of ${TONES.join(', ')} or empty`);
  requireMatch(o.provenance, PROVENANCE_RE, 'provenance');
  if (o.sources.length > 10) throw new SenderError('at most 10 sources');
  for (const s of o.sources) {
    requireText(s.source, 'source', 40);
    if ((s.url ?? '').length > 500 || (s.placeId ?? '').length > 200 || s.fetchedAt.length > 40) throw new SenderError('source is too long');
  }
  if (o.memoryRefs.length > 20 || o.memoryRefs.some((m) => m.length > 100)) throw new SenderError('too many memory refs');
  if (kind.tag === 'Errand') checkErrandAction(o.actionJson);
  else if (kind.tag === 'Call') checkCallAction(o.actionJson);
  else if (o.actionJson !== '') throw new SenderError('a reply has no action_json');
  return kind;
}

/**
 * `agent_publish_options`: a new version of 1 to `max_options` options (exactly 2 for yes_no, rank 1 the yes).
 * Where it goes depends on the scan: current while Preparing, pending while reading, current for a question
 * still waiting its turn, kept but not scanned once the person picked.
 */
export function publishOptions(ctx: Ctx, job: AgentJob, answerMode: string, options: OptionInput[], final: boolean): void {
  if (job.kind.tag !== 'Options') throw new SenderError('not an options job');
  const q = ctx.db.question.id.find(job.questionId);
  if (!q || !OPEN_STATUSES.includes(q.status.tag)) {
    // The person already picked, or the question was cancelled: nothing is written.
    if (final) endJob(ctx, job, 'Done', 'question_ended');
    else extendLease(ctx, job);
    return;
  }
  const cfg = getConfig(ctx.db);
  const mode = parseAnswerMode(answerMode);
  if (mode.tag === 'YesNo' && options.length !== 2) throw new SenderError('yes_no takes exactly 2 options');
  if (mode.tag === 'Pick' && (options.length < 1 || options.length > cfg.maxOptions)) {
    throw new SenderError(`pick takes 1 to ${cfg.maxOptions} options`);
  }
  const kinds = options.map((o) => checkOption(o, mode));
  const version = Math.max(q.version, q.pendingVersion) + 1;
  options.forEach((o, i) => {
    ctx.db.answerOption.insert({
      id: 0n,
      questionId: q.id,
      version,
      rank: i + 1,
      kind: kinds[i]!,
      menuItem: { tag: 'None' },
      text: o.text,
      tone: o.tone,
      laugh: o.laugh,
      provenance: o.provenance,
      sources: o.sources,
      memoryRefs: o.memoryRefs,
      actionJson: o.actionJson,
      clipMs: undefined,
      createdAt: ctx.timestamp,
    });
  });
  writePipeline(ctx, {
    eventKey: `q${q.id}:v${version}:plan`,
    sessionId: q.sessionId,
    questionId: q.id,
    stage: 'plan',
    status: 'ok',
    detail: mode.tag === 'YesNo' ? 'yes or no' : final ? 'options' : 'early options',
    countsJson: JSON.stringify({ version, optionCount: options.length, final }),
    actor: 'Agent',
  });
  appendLedger(ctx, q.sessionId, 'options', 'Agent', { questionId: q.id, jobId: job.id, outcome: mode.tag === 'YesNo' ? 'yes_no' : 'pick', reason: `version:${version}` });

  const s = ctx.db.scanState.sessionId.find(q.sessionId);
  const scanningThis = !!s && s.questionId === q.id;
  if (scanningThis && s!.phase.tag === 'Preparing') {
    // Preparing for an older version, or the question has no version yet: this one becomes current.
    const current = saveQ(ctx, { ...q, version, answerMode: mode, pendingVersion: 0, status: { tag: 'Ready' }, readyAt: q.readyAt ?? ctx.timestamp });
    enterPreparing(ctx, s!, current);
  } else if (scanningThis && (s!.phase.tag === 'Reading' || s!.phase.tag === 'Window' || (s!.phase.tag === 'Paused' && q.status.tag === 'Scanning'))) {
    // Switched in at the end of the pass, with the cue `more_options`.
    saveQ(ctx, { ...q, pendingVersion: version, pendingAnswerMode: mode });
  } else if (!(scanningThis && isScanActive(s!)) && (q.status.tag === 'Drafting' || q.status.tag === 'Ready')) {
    // Still waiting its turn (behind a veto or a pause): the newest version is the one it will scan.
    saveQ(ctx, { ...q, version, answerMode: mode, pendingVersion: 0, status: { tag: 'Ready' }, readyAt: q.readyAt ?? ctx.timestamp });
  }
  // Otherwise (a veto on this question): kept and not scanned.
  if (final) endJob(ctx, job, 'Done');
  else extendLease(ctx, job);
}

function saveQ(ctx: Ctx, q: Question): Question {
  ctx.db.question.id.update(q);
  return q;
}

/** A failed or abandoned options job fails its question only if the question has nothing to read yet. */
function failOptionsQuestion(ctx: Ctx, job: AgentJob, code: string, actor: 'Agent' | 'Scheduler'): void {
  const q = ctx.db.question.id.find(job.questionId);
  writePipeline(ctx, {
    eventKey: `q${job.questionId}:plan:error:${job.attempt}`,
    sessionId: q?.sessionId ?? 0n,
    questionId: job.questionId,
    stage: 'plan',
    status: 'error',
    detail: `failed: ${code.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40) || 'unknown'}`,
    actor,
  });
  if (!q || !OPEN_STATUSES.includes(q.status.tag)) return;
  if (q.version > 0 || q.pendingVersion > 0) return; // options already exist: keep scanning them
  closeQuestion(ctx, q, { status: 'Failed', outcome: 'Cancelled', reason: code, actor, cue: 'failed' });
}

export function agentFail(ctx: Ctx, job: AgentJob, reasonCode: string, reason: string): void {
  requireOptionalText(reasonCode, 'reason_code', 40);
  requireOptionalText(reason, 'reason', 300);
  // The code reaches the public ledger and cue rows: keep it code-shaped whatever the sidecar sent.
  const code = normCode(reasonCode) || 'agent_failed';
  endJob(ctx, job, 'Failed', code);
  appendLedger(ctx, sessionOf(ctx, job), 'job_failed', 'Agent', { jobId: job.id, questionId: job.questionId, errandId: job.errandId, reason: code });
  if (job.kind.tag === 'Options') failOptionsQuestion(ctx, job, code, 'Agent');
  if (job.kind.tag === 'ErrandPreview') failDraftedErrand(ctx, job.errandId, code, reason, 'Agent');
}

/** Is the work behind a job still wanted? */
function stillWanted(ctx: Ctx, job: AgentJob): boolean {
  switch (job.kind.tag) {
    case 'Options': {
      const q = ctx.db.question.id.find(job.questionId);
      return !!q && OPEN_STATUSES.includes(q.status.tag);
    }
    case 'ErrandPreview':
      return ctx.db.errand.id.find(job.errandId)?.status.tag === 'Drafted';
    case 'Remember':
      return true;
  }
}

/** `lease_expired`, already fenced: requeue while attempts remain, else fail; cancel work nobody wants. */
export function leaseLapsed(ctx: Ctx, job: AgentJob): void {
  const cfg = getConfig(ctx.db);
  const sessionId = sessionOf(ctx, job);
  if (!stillWanted(ctx, job)) {
    endJob(ctx, job, 'Cancelled', 'not_wanted');
    return;
  }
  if (job.attempt < cfg.jobMaxAttempts) {
    requeueJob(ctx, job);
    appendLedger(ctx, sessionId, 'job_requeued', 'Scheduler', { jobId: job.id, questionId: job.questionId, errandId: job.errandId, outcome: `attempt:${job.attempt}` });
    return;
  }
  endJob(ctx, job, 'Failed', 'lease_lapsed');
  appendLedger(ctx, sessionId, 'job_failed', 'Scheduler', { jobId: job.id, questionId: job.questionId, errandId: job.errandId, reason: 'lease_lapsed' });
  if (job.kind.tag === 'Options') failOptionsQuestion(ctx, job, 'agent_lost', 'Scheduler');
  if (job.kind.tag === 'ErrandPreview') failDraftedErrand(ctx, job.errandId, 'agent_lost', '', 'Scheduler');
}
