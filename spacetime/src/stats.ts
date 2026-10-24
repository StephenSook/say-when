// The numbers behind `GET /route/stats` (docs/spacetime.md 6.2): recomputed from stored rows of the active
// session, numbers only, so any judge can check them with no key. Pure over the database, so tests call it.
import type { ReadDb } from './ctx';

export interface SessionStats {
  sessionId: number;
  questions: number;
  questionsAnswered: number;
  picks: number;
  medianLateByMs: number | null;
  latePicks: number;
  pauses: number;
  medianPauseLatencyMs: number | null;
  medianQuestionToFirstOptionMs: number | null;
  errandsSent: number;
  errandsStopped: number;
  gestures: number;
  gesturesIgnored: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function computeStats(db: ReadDb): SessionStats {
  const sessionId = db.config.id.find(0)?.activeSessionId ?? 0n;
  const late: number[] = [];
  const pauseLatency: number[] = [];
  let picks = 0;
  let pauses = 0;
  const firstScan = new Map<bigint, bigint>();
  for (const row of db.ledger.ledgerBySession.filter(sessionId)) {
    if (row.kind === 'pick') {
      picks += 1;
      late.push(row.ms);
    } else if (row.kind === 'pause') {
      pauses += 1;
      if (row.outcome === 'headset_lost') pauseLatency.push(row.ms);
    } else if (row.kind === 'scan_start' && row.questionId !== 0n && !firstScan.has(row.questionId)) {
      firstScan.set(row.questionId, row.at.microsSinceUnixEpoch);
    }
  }
  let questions = 0;
  let answered = 0;
  const toFirst: number[] = [];
  for (const q of db.question.questionBySession.filter(sessionId)) {
    // Both counts are partner questions: the person's own menu and its follow-ups are not "questions answered".
    if (q.origin.tag === 'Partner') questions += 1;
    if (q.origin.tag === 'Partner' && ['Released', 'Spoken', 'Acting'].includes(q.status.tag)) answered += 1;
    const first = firstScan.get(q.id);
    if (q.origin.tag === 'Partner' && first !== undefined) {
      toFirst.push(Number((first - q.askedAt.microsSinceUnixEpoch) / 1000n));
    }
  }
  let sent = 0;
  let stopped = 0;
  for (const e of db.errand.errandBySession.filter(sessionId)) {
    if (e.status.tag === 'Submitted') sent += 1;
    if (e.status.tag === 'Stopped') stopped += 1;
  }
  let gestures = 0;
  let ignoredCount = 0;
  for (const g of db.gestureLog.gestureBySession.filter(sessionId)) {
    gestures += 1;
    if (g.outcome.startsWith('ignored:')) ignoredCount += 1;
  }
  return {
    sessionId: Number(sessionId),
    questions,
    questionsAnswered: answered,
    picks,
    medianLateByMs: median(late),
    latePicks: late.filter((ms) => ms > 0).length,
    pauses,
    medianPauseLatencyMs: median(pauseLatency),
    medianQuestionToFirstOptionMs: median(toFirst),
    errandsSent: sent,
    errandsStopped: stopped,
    gestures,
    gesturesIgnored: ignoredCount,
  };
}
