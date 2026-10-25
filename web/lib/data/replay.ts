/**
 * Sample replay: a deterministic, timer-driven sample session. It is NOT live data, and the shell
 * always labels it "Sample replay, not live data". It only runs in `next dev` or with ?replay=1
 * (lib/data/source-mode.ts). The provider loads this file with a dynamic import, so it ships in its
 * own chunk and the browser fetches it only when the replay is on.
 *
 * One loop walks one question end to end with direct select (D18, docs/direct-select.md): the earpiece reads
 * the options once, numbered, then waits, and the person picks any of them by its number. Then the next loop asks
 * it again as a new question:
 *
 *   0.0 s   the partner asks; Listen runs
 *   2.4 s   Heard; Apify search, then Moss recall (one shared memory, one private), then Claude
 *           drafts three options in three tones, each with a short earpiece label
 *   5.3 s   the earpiece reads "One: cafeteria. Two: Thai place. Three: cafe on Bay.", then
 *           waits for a pick (silence never picks, D19)
 *  11.5 s   PICK_3 (a single jaw clench) picks option 3; it is said out loud at once (no veto in direct
 *           select); a repeat inside the refractory time is ignored
 *  16.5 s   Claude offers follow-up options; PICK_1 (the imagined left fist) picks the errand
 *  20.8 s   the errand: the form is filled, the values are read back off the page, the read-back plays
 *           with "One: send it. Two: cancel.", PICK_1 confirms, and the form is sent
 *  33.7 s   another follow-up with two options; a stray PICK_3 (a single jaw clench) is ignored (there is no
 *           option 3); PICK_1 picks the call; the script is read back, PICK_1 confirms, dialing, ringing,
 *           connected, transcript lines
 *  58.7 s   STOP (a held jaw clench, about 1 second) hangs up the call
 *  60.8 s   STOP while idle pauses; PICK_1 resumes
 *  64.4 s   the headset loses contact (HEADSET_OFF, a system event); PICK_1 resumes
 *  71.0 s   the loop starts again with a new question number
 *
 * Every name and value is obviously sample ("Demo user", "Cafe on Bay St", example.com links).
 * Memory hits follow moss/README.md: the shared memory carries `sharedText`, the private one has no text.
 * Data timing is fixed; reduced motion only changes the visuals.
 */
import { countWords } from '../format';
import { optionEarText } from '../station/phrases';
import { createStateStore, initialState, type DataSource } from './source';
import type {
  AnswerOption,
  CallRequest,
  CommandEvent,
  CommandName,
  DataRows,
  Errand,
  MossHit,
  PipelineEvent,
  PipelineStatus,
  Question,
  ReadBackItem,
  SafetyState,
  ScanState,
  SearchRow,
  SourceRef,
  Stage,
  StageDetailMap,
  WordTiming,
} from './types';

export const REPLAY_SESSION_ID = 'sample-session';

/**
 * Direct select (D18): after the last option is read, the list waits this long for a pick (the module's
 * `idle_pause_ms`, 2 minutes), then the scan ends with no pick. There is no window per option and no veto.
 */
export const PICK_WAIT_MS = 120_000;
/** The confirm window after a read-back ("One: send it. Two: cancel."). */
export const CONFIRM_WINDOW_MS = 8_000;

/** Length of one loop. */
export const LOOP_MS = 71_000;

/** Completed loops kept on screen, so earlier questions can still be browsed. */
export const HISTORY_LOOPS = 2;

/** Time per spoken word when the sample reads an option. */
const WORD_MS = 300;
/** How long a read-back plays in the earpiece in the sample. */
const READ_BACK_MS = 5_000;
/** Scanning starts with estimated clip lengths if the clips are not in by then (docs/spacetime.md `clip_deadline_ms`). */
const CLIP_DEADLINE_MS = 4_000;
// Direct select reads the list once (D18): one pass.
const MAX_PASSES = 1;

const QUESTION_TEXT = 'Where can we get dinner near the hospital tonight?';
const DAY_MS = 86_400_000;

interface MutableRows {
  questions: Question[];
  pipelineEvents: PipelineEvent[];
  options: AnswerOption[];
  errands: Errand[];
  calls: CallRequest[];
  commands: CommandEvent[];
  scan: ScanState | null;
  safety: SafetyState;
}

/** One moment in a loop. `t` is milliseconds from the start of the loop. */
export interface ReplayStep {
  t: number;
  label: string;
  apply(rows: MutableRows): void;
}

function emptyRows(): MutableRows {
  return {
    questions: [],
    pipelineEvents: [],
    options: [],
    errands: [],
    calls: [],
    commands: [],
    scan: null,
    safety: { state: 'unknown', since: null },
  };
}

/** A stable 16-hex-character sample digest. */
export function sampleHex(seed: string): string {
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (let i = 0; i < seed.length; i++) {
    const code = seed.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function wordTimings(text: string): WordTiming[] {
  return text
    .trim()
    .split(/\s+/)
    .map((word, i) => ({ word, startMs: i * WORD_MS, endMs: i * WORD_MS + WORD_MS - 40 }));
}

function readMs(text: string): number {
  return countWords(text) * WORD_MS;
}

/** A plain picture of the filled sample form, standing in for the Actor's preview screenshot. */
function previewScreenshot(items: readonly ReadBackItem[]): string {
  const rows = items
    .map((item, i) => {
      const y = 116 + i * 66;
      return (
        `<text x="32" y="${y}" font-size="14" fill="#4a4a52">${escapeXml(item.label)}</text>` +
        `<rect x="32" y="${y + 8}" width="576" height="32" rx="4" fill="#ffffff" stroke="#b9b9c2"/>` +
        `<text x="44" y="${y + 29}" font-size="15" fill="#1b1b1f">${escapeXml(item.value)}</text>`
      );
    })
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400" font-family="Helvetica, Arial, sans-serif">` +
    `<rect width="640" height="400" fill="#f4f4f6"/>` +
    `<text x="32" y="52" font-size="24" font-weight="600" fill="#1b1b1f">Care team request</text>` +
    `<text x="32" y="78" font-size="13" fill="#5a5a63">Sample form. The replay never sends anything.</text>` +
    rows +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface OptionDraft {
  /** The short earpiece words (1 to 3 words): the earpiece reads "One: <label>." */
  label: string;
  text: string;
  kind: AnswerOption['kind'];
  /** One of cartesia/src/tones.ts TONES: neutral, calm, warm, sad, firm. */
  tone: string;
  sources: SourceRef[];
}

/** Builds every step of one loop. Ids carry the loop number, so they never repeat. */
export function buildLoop(loop: number, loopStart: number): ReplayStep[] {
  const steps: ReplayStep[] = [];
  const at = (t: number) => loopStart + t;
  const iso = (t: number) => new Date(at(t)).toISOString();
  const qid = `q-${loop}`;
  const errandId = `err-${loop}`;
  const callId = `call-${loop}`;
  let eventCount = 0;
  let commandCount = 0;

  const step = (t: number, label: string, apply: (rows: MutableRows) => void) => {
    steps.push({ t, label, apply });
  };

  const event = <S extends Stage>(t: number, stage: S, status: PipelineStatus, detail: StageDetailMap[S], ms: number | null) => {
    const id = `ev-${loop}-${++eventCount}`;
    step(t, `${stage} ${status}`, (rows) => {
      rows.pipelineEvents.push({
        id,
        sessionId: REPLAY_SESSION_ID,
        questionId: qid,
        stage,
        status,
        detail,
        ms,
        at: at(t),
      } as PipelineEvent);
    });
  };

  const command = (
    t: number,
    name: CommandName,
    extra: Partial<Omit<CommandEvent, 'id' | 'command' | 'at'>> = {},
    apply?: (rows: MutableRows, id: string) => void,
  ) => {
    const id = `cmd-${loop}-${++commandCount}`;
    step(t, `command ${name}${extra.accepted === false ? ' ignored' : ''}`, (rows) => {
      rows.commands.push({
        id,
        command: name,
        at: at(t),
        accepted: true,
        ignoredReason: null,
        confidence: 0.95,
        questionId: qid,
        optionId: null,
        ...extra,
      });
      apply?.(rows, id);
    });
    return id;
  };

  const idleScan = (version: number): ScanState => ({
    questionId: qid,
    version,
    mode: 'answer',
    answerMode: 'pick',
    phase: 'idle',
    cursor: null,
    stepStartedAt: at(0),
    stepEndsAt: at(0),
    pass: 1,
    maxPasses: MAX_PASSES,
    outcome: null,
    pickedOptionId: null,
  });

  const setScan = (t: number, label: string, patch: Partial<ScanState>) => {
    step(t, label, (rows) => {
      rows.scan = { ...(rows.scan ?? idleScan(0)), ...patch };
    });
  };

  const updateQuestion = (t: number, label: string, patch: Partial<Question>) => {
    step(t, label, (rows) => {
      const question = rows.questions.find((q) => q.id === qid);
      if (question) Object.assign(question, patch);
    });
  };

  const updateErrand = (t: number, label: string, patch: Partial<Errand>) => {
    step(t, label, (rows) => {
      const errand = rows.errands.find((e) => e.id === errandId);
      if (errand) Object.assign(errand, patch);
    });
  };

  const updateCall = (t: number, label: string, patch: Partial<CallRequest>) => {
    step(t, label, (rows) => {
      const call = rows.calls.find((c) => c.id === callId);
      if (call) Object.assign(call, patch);
    });
  };

  // Sample sources, all obviously sample.
  const cafeRef: SourceRef = { source: 'maps', placeId: 'sample-place-cafe-bay-st', fetchedAt: iso(4_000) };
  const thaiRef: SourceRef = { source: 'maps', placeId: 'sample-place-thai-lombard', fetchedAt: iso(4_000) };
  const accessRef: SourceRef = { source: 'web', url: 'https://example.org/accessible-dining-guide', fetchedAt: iso(4_100) };
  const visitorRef: SourceRef = { source: 'web', url: 'https://example.net/hospital-visitor-guide', fetchedAt: iso(4_150) };
  const sharedMemoryRef: SourceRef = { source: 'memory', fetchedAt: new Date(loopStart - 12 * DAY_MS).toISOString() };

  const searchRows: SearchRow[] = [
    {
      id: 'maps:sample-place-cafe-bay-st',
      source: 'maps',
      title: 'Cafe on Bay St',
      text: 'Cafe, 0.3 mi away, open until 10 pm, wheelchair entrance listed.',
      placeId: 'sample-place-cafe-bay-st',
      fetchedAt: iso(4_000),
      rank: 1,
      facts: { category: 'Cafe', openNow: true, wheelchairEntrance: true, rating: 4.6, reviews: 212 },
    },
    {
      id: 'maps:sample-place-thai-lombard',
      source: 'maps',
      title: 'Thai kitchen on Lombard',
      text: 'Thai restaurant, 0.5 mi away, open until 9 pm.',
      placeId: 'sample-place-thai-lombard',
      fetchedAt: iso(4_000),
      rank: 2,
      facts: { category: 'Thai restaurant', openNow: true, rating: 4.4, reviews: 98 },
    },
    {
      id: 'maps:sample-place-noodle-polk',
      source: 'maps',
      title: 'Noodle bar on Polk',
      text: 'Noodle shop, 0.8 mi away, open until 11 pm.',
      placeId: 'sample-place-noodle-polk',
      fetchedAt: iso(4_000),
      rank: 3,
      facts: { category: 'Noodle shop', openNow: true, rating: 4.1, reviews: 57 },
    },
    {
      id: 'web:sample-late-dinner',
      source: 'web',
      title: 'Late dinner spots near the medical center',
      text: 'Five places that stay open after 9 pm within a short walk.',
      url: 'https://example.com/late-dinner-near-the-medical-center',
      fetchedAt: iso(4_050),
      rank: 1,
    },
    {
      id: 'web:sample-accessible-dining',
      source: 'web',
      title: 'Accessible restaurants in the neighborhood',
      text: 'Step-free entrances, ramps and accessible restrooms, checked by visitors.',
      url: 'https://example.org/accessible-dining-guide',
      fetchedAt: iso(4_100),
      rank: 2,
    },
    {
      id: 'web:sample-visitor-guide',
      source: 'web',
      title: 'Hospital visitor guide: food and parking',
      text: 'The cafeteria is open until 8 pm. Visitor parking is on level 2.',
      url: 'https://example.net/hospital-visitor-guide',
      fetchedAt: iso(4_150),
      rank: 3,
    },
  ];

  // One memory the person marked shareable (it carries sharedText) and one private memory (no text at all).
  const mossHits: MossHit[] = [
    {
      id: `memory:sample-shared-${loop}`,
      origin: 'memory',
      memoryType: 'pref',
      sharedText: 'Sample shared memory: Demo user likes quiet places with a ramp.',
      score: 0.82,
      savedAt: loopStart - 12 * DAY_MS,
    },
    { id: `memory:sample-private-${loop}`, origin: 'memory', memoryType: 'reply', score: 0.71, savedAt: loopStart - 3 * DAY_MS },
    { id: `web:sample-thai-${loop}`, origin: 'web', score: 0.64, text: 'Thai kitchen on Lombard, 0.5 mi', source: thaiRef },
    { id: `web:sample-ramp-${loop}`, origin: 'web', score: 0.58, text: 'Cafe on Bay St has a ramp at the side door', source: accessRef },
  ];

  // An open question: three options in three tones, each with a short earpiece label (D18, at most 3 by gesture).
  const firstOptions: OptionDraft[] = [
    { label: 'Cafeteria', text: 'The hospital cafeteria is fine.', kind: 'reply', tone: 'neutral', sources: [visitorRef] },
    { label: 'Thai place', text: "The Thai place on Lombard, it's quiet.", kind: 'reply', tone: 'calm', sources: [thaiRef] },
    { label: 'Cafe on Bay', text: 'The cafe on Bay St, it has a ramp.', kind: 'reply', tone: 'warm', sources: [cafeRef, accessRef, sharedMemoryRef] },
  ];

  // Follow-ups after the pick: an errand, a call, or nothing else.
  const errandOptions: OptionDraft[] = [
    { label: 'Send request', text: 'Send the care team a dinner request.', kind: 'errand', tone: 'calm', sources: [] },
    { label: 'Call caregiver', text: 'Call Demo caregiver to meet us there.', kind: 'call', tone: 'calm', sources: [] },
    { label: 'Nothing else', text: 'Nothing else.', kind: 'reply', tone: 'neutral', sources: [] },
  ];
  const callOptions: OptionDraft[] = [
    { label: 'Call caregiver', text: 'Call Demo caregiver to meet us there.', kind: 'call', tone: 'calm', sources: [] },
    { label: 'Nothing else', text: 'Nothing else.', kind: 'reply', tone: 'neutral', sources: [] },
  ];

  const optionId = (version: number, rank: number) => `opt-${loop}-v${version}-${rank}`;

  /** Claude publishes a version of options; the module makes their clips before reading starts. */
  const publishOptions = (t: number, version: number, drafts: readonly OptionDraft[]) => {
    step(t, `options v${version}`, (rows) => {
      drafts.forEach((draft, i) => {
        rows.options.push({
          id: optionId(version, i + 1),
          questionId: qid,
          version,
          rank: i + 1,
          text: draft.text,
          label: draft.label,
          kind: draft.kind,
          tone: draft.tone,
          sources: draft.sources,
        });
      });
    });
    setScan(t, `scan v${version} preparing`, {
      version,
      phase: 'preparing',
      cursor: null,
      stepStartedAt: at(t),
      stepEndsAt: at(t + CLIP_DEADLINE_MS),
      pass: 1,
      outcome: null,
      pickedOptionId: null,
    });
  };

  /**
   * Direct select: reads every option once, numbered ("One: cafeteria."), back to back in rank order, then waits for a
   * pick. Returns when the list ends and the wait begins.
   */
  const readList = (start: number, version: number, drafts: readonly OptionDraft[]) => {
    let t = start;
    drafts.forEach((draft, i) => {
      const rank = i + 1;
      const words = optionEarText(rank, draft.label, draft.text);
      const reading = readMs(words);
      const id = optionId(version, rank);
      setScan(t, `scan v${version} option ${rank} reading`, {
        version,
        phase: 'reading',
        cursor: rank,
        stepStartedAt: at(t),
        stepEndsAt: at(t + reading),
      });
      // The clip is made before reading starts, so its length and word timings ride on the start
      // (PLAN D10: word timings drive the on-screen word mark).
      const clip = { optionId: id, rank, text: words, channel: 'earpiece' as const, tone: draft.tone, durationMs: reading, words: wordTimings(words) };
      event(t, 'speak', 'started', clip, null);
      event(t + reading, 'speak', 'ok', clip, reading);
      t += reading;
    });
    // The wait for a pick: any number, any time; silence picks nothing.
    setScan(t, `scan v${version} waiting for a pick`, { phase: 'window', cursor: drafts.length, stepStartedAt: at(t), stepEndsAt: at(t + PICK_WAIT_MS) });
    return t;
  };

  /** The picked option: the module acts at once (a reply is said, an errand or call starts its read-back). */
  const picked = (t: number, version: number, rank: number, draft: OptionDraft) => {
    const id = optionId(version, rank);
    setScan(t, `scan v${version} picked ${rank}`, {
      phase: 'idle',
      cursor: null,
      outcome: 'picked',
      pickedOptionId: id,
      stepStartedAt: at(t),
      stepEndsAt: at(t),
    });
    event(t, 'select', 'started', { optionId: id, rank, text: draft.text, kind: draft.kind }, null);
    event(t + 50, 'select', 'ok', { optionId: id, rank, text: draft.text, kind: draft.kind }, 50);
    return id;
  };

  /** A pick of a reply: said out loud in the room at once (D18 has no veto). */
  const pickReply = (t: number, version: number, rank: number, name: CommandName, draft: OptionDraft) => {
    command(t, name, { confidence: 0.96, optionId: optionId(version, rank) });
    const id = picked(t, version, rank, draft);
    updateQuestion(t + 50, 'reply released', { replyText: draft.text });
    return { id, releasedAt: t + 50 };
  };

  /** A pick of an errand or call: its own read-back and a fresh PICK_1 ("One: send it") follow. */
  const pickAction = (t: number, version: number, rank: number, name: CommandName, draft: OptionDraft) => {
    command(t, name, { confidence: 0.96, optionId: optionId(version, rank) });
    return picked(t, version, rank, draft);
  };

  // 0.0 s: a new question while the partner talks. The headset is on.
  step(0, 'question asked', (rows) => {
    rows.questions.push({
      id: qid,
      sessionId: REPLAY_SESSION_ID,
      number: loop + 1,
      text: null,
      via: 'voice',
      origin: 'partner',
      askedAt: at(0),
      replyText: null,
      spokenAt: null,
    });
    rows.scan = idleScan(0);
    rows.safety = { state: 'ok', since: at(0) };
  });
  event(0, 'listen', 'started', {}, null);

  updateQuestion(2_400, 'question heard', { text: QUESTION_TEXT });
  event(2_400, 'listen', 'ok', { words: QUESTION_TEXT, wordCount: countWords(QUESTION_TEXT) }, 412);
  setScan(2_400, 'scan preparing', { phase: 'preparing', stepStartedAt: at(2_400), stepEndsAt: at(2_400 + CLIP_DEADLINE_MS) });

  event(2_450, 'search', 'started', { needsWeb: true, reason: 'Plans a meal or an outing, so nearby places help.', searches: 2 }, null);
  event(4_250, 'search', 'ok', { needsWeb: true, searches: 2, rowCount: searchRows.length, rows: searchRows, partial: false }, 1_800);

  event(4_300, 'retrieve', 'started', {}, null);
  event(4_380, 'retrieve', 'ok', { hitCount: mossHits.length, hits: mossHits, mossMs: 12 }, 80);

  event(4_400, 'plan', 'started', { label: 'claude' }, null);
  event(5_150, 'plan', 'ok', { label: 'claude', version: 1, optionCount: firstOptions.length }, 750);
  publishOptions(5_150, 1, firstOptions);

  // The list: three numbered options, read once (5.3 s to 8.0 s), then the wait. PICK_3, a single jaw clench, picks
  // option 3 at 11.5 s, 3.5 s into the wait.
  const firstListEnd = readList(5_300, 1, firstOptions);
  const replyPickAt = firstListEnd + 3_500;
  const replyPick = pickReply(replyPickAt, 1, 3, 'PICK_3', firstOptions[2]!);
  command(replyPickAt + 200, 'PICK_3', {
    accepted: false,
    ignoredReason: 'Repeat inside the refractory time',
    confidence: 0.88,
    optionId: replyPick.id,
  });

  // The picked reply is said out loud for the room, at once.
  const replyText = firstOptions[2]!.text;
  const aloudAt = replyPick.releasedAt + 100;
  const aloudMs = readMs(replyText);
  event(aloudAt, 'speak', 'started', { optionId: replyPick.id, rank: 3, text: replyText, channel: 'aloud', tone: firstOptions[2]!.tone }, null);
  event(
    aloudAt + aloudMs,
    'speak',
    'ok',
    { optionId: replyPick.id, rank: 3, text: replyText, channel: 'aloud', tone: firstOptions[2]!.tone, durationMs: aloudMs, words: wordTimings(replyText) },
    aloudMs,
  );
  updateQuestion(aloudAt + aloudMs, 'reply spoken', { spokenAt: at(aloudAt + aloudMs) });

  // Follow-up options: Claude offers the errand, a call, or nothing else. PICK_1 picks the errand.
  const followUpAt = aloudAt + aloudMs + 1_400;
  event(followUpAt, 'plan', 'started', { label: 'claude' }, null);
  event(followUpAt + 700, 'plan', 'ok', { label: 'claude', version: 2, optionCount: errandOptions.length, followUp: true }, 700);
  publishOptions(followUpAt + 700, 2, errandOptions);
  const errandListEnd = readList(followUpAt + 800, 2, errandOptions);
  const errandPickAt = errandListEnd + 1_500;
  const errandOptionId = pickAction(errandPickAt, 2, 1, 'PICK_1', errandOptions[0]!);

  // The errand: nothing is sent without a fresh PICK_1 after the read-back.
  const readBack: ReadBackItem[] = [
    { label: 'Who is this from?', value: 'Demo user', source: 'memory' },
    { label: 'What do you need?', value: 'Meal or drink' },
    { label: 'Details', value: 'Dinner at the cafe on Bay St with my partner.' },
    { label: 'When?', value: '7 pm tonight' },
  ];
  const errandReadBackText =
    'Care team request, from Demo user. Meal or drink: dinner at the cafe on Bay St with my partner, 7 pm tonight. ' +
    'Confirm to send it and email the care team. One: send it. Two: cancel.';
  const errandAt = errandPickAt + 100;
  step(errandAt, 'errand drafted', (rows) => {
    rows.errands.push({
      id: errandId,
      questionId: qid,
      optionId: errandOptionId,
      form: 'Care team request',
      status: 'preparing',
      previewDigest: null,
      readBackText: null,
      readBack: [],
      confirmationText: null,
      screenshotUrl: null,
      confirmClosesAt: null,
      reason: null,
      reasonCode: null,
      confirmCommandId: null,
      stopCommandId: null,
      createdAt: at(errandAt),
      previewedAt: null,
      previewMs: null,
      readAloudAt: null,
      confirmedAt: null,
      sentAt: null,
      endedAt: null,
    });
  });
  event(errandAt, 'errand', 'started', { errandId }, null);
  const previewAt = errandAt + 1_800;
  updateErrand(previewAt, 'errand previewed', {
    status: 'previewed',
    previewedAt: at(previewAt),
    previewMs: 1_800,
    previewDigest: sampleHex(`errand-${loop}`),
    readBack,
    readBackText: errandReadBackText,
    screenshotUrl: previewScreenshot(readBack),
  });
  // PLAN D25: the care team email, drafted with the read-back and sent only after the form (agent/src/email.ts).
  const requested = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }).format(at(previewAt));
  const email = {
    to: 'c***@example.org',
    subject: 'Care team request: Meal or drink',
    text: [
      'Care team request, sent with the Eleven app.',
      '',
      ...readBack.map((item) => (item.label.endsWith('?') ? `${item.label} ${item.value}` : `${item.label}: ${item.value}`)),
      '',
      `Requested: ${requested}.`,
      'The person heard these values read back and confirmed them before the form and this email were sent. The Eleven app sent both on their behalf.',
    ].join('\n'),
    draftedAt: iso(previewAt),
  };
  event(previewAt, 'errand', 'ok', { errandId, label: 'email drafted', email }, 0);
  updateErrand(previewAt + 100, 'errand reading back', { status: 'reading_back' });
  const errandWindowAt = previewAt + 100 + READ_BACK_MS;
  updateErrand(errandWindowAt, 'errand waiting for confirm', {
    status: 'awaiting_confirm',
    readAloudAt: at(errandWindowAt),
    confirmClosesAt: at(errandWindowAt + CONFIRM_WINDOW_MS),
  });
  const errandConfirmAt = errandWindowAt + 2_600;
  command(errandConfirmAt, 'PICK_1', { confidence: 0.98 }, (rows, id) => {
    const errand = rows.errands.find((e) => e.id === errandId);
    if (errand) Object.assign(errand, { status: 'confirmed', confirmedAt: at(errandConfirmAt), confirmCommandId: id });
  });
  updateErrand(errandConfirmAt + 300, 'errand submitting', { status: 'submitting' });
  const sentAt = errandConfirmAt + 1_600;
  updateErrand(sentAt, 'errand sent', {
    status: 'sent',
    sentAt: at(sentAt),
    confirmationText: 'Your response has been recorded.',
  });
  event(sentAt, 'errand', 'ok', { errandId }, sentAt - errandAt);
  event(sentAt + 100, 'errand', 'started', { errandId, label: 'email sending', email }, null);
  const emailSentAt = sentAt + 1_000;
  event(emailSentAt, 'errand', 'ok', { errandId, label: 'email sent', email: { ...email, outcome: 'sent', sentAt: iso(emailSentAt) }, mailMs: 900 }, 900);

  // Another follow-up: the call, or nothing else. A stray PICK_3 (a single jaw clench) finds no option 3 in this
  // two-option list; PICK_1 picks the call.
  const callFollowUpAt = sentAt + 1_200;
  event(callFollowUpAt, 'plan', 'started', { label: 'claude' }, null);
  event(callFollowUpAt + 500, 'plan', 'ok', { label: 'claude', version: 3, optionCount: callOptions.length, followUp: true }, 500);
  publishOptions(callFollowUpAt + 500, 3, callOptions);
  const callListEnd = readList(callFollowUpAt + 600, 3, callOptions);
  command(callListEnd + 600, 'PICK_3', {
    accepted: false,
    ignoredReason: 'There is no option with that number',
    confidence: 0.9,
  });
  const callPickAt = callListEnd + 1_900;
  const callOptionId = pickAction(callPickAt, 3, 1, 'PICK_1', callOptions[0]!);

  // The call: a consented call to the caregiver, released only by its own fresh PICK_1.
  const callAt = callPickAt + 100;
  step(callAt, 'call prepared', (rows) => {
    rows.calls.push({
      id: callId,
      questionId: qid,
      optionId: callOptionId,
      contactName: 'Demo caregiver',
      scriptDigest: sampleHex(`call-${loop}`),
      readBackText:
        'Call Demo caregiver. Tell them Demo user and their partner are having dinner at the cafe on Bay St at 7 tonight, ' +
        'and ask if they can meet there. One: send it. Two: cancel.',
      status: 'prepared',
      result: null,
      endReason: null,
      reason: null,
      consentOnFile: true,
      readAloudAt: null,
      confirmClosesAt: null,
      confirmCommandId: null,
      stopCommandId: null,
      cancelRequested: false,
      createdAt: at(callAt),
      confirmedAt: null,
      dialedAt: null,
      ringingAt: null,
      startedAt: null,
      endedAt: null,
      transcript: [],
    });
  });
  event(callAt, 'call', 'started', { callId }, null);
  const callWindowAt = callAt + READ_BACK_MS;
  updateCall(callWindowAt, 'call waiting for confirm', {
    status: 'awaiting_confirm',
    readAloudAt: at(callWindowAt),
    confirmClosesAt: at(callWindowAt + CONFIRM_WINDOW_MS),
  });
  const callConfirmAt = callWindowAt + 2_100;
  command(callConfirmAt, 'PICK_1', { confidence: 0.98 }, (rows, id) => {
    const call = rows.calls.find((c) => c.id === callId);
    if (call) Object.assign(call, { status: 'confirmed', confirmedAt: at(callConfirmAt), confirmCommandId: id });
  });
  updateCall(callConfirmAt + 100, 'call dialing', { status: 'dialing', dialedAt: at(callConfirmAt + 100) });
  updateCall(callConfirmAt + 900, 'call ringing', { status: 'ringing', ringingAt: at(callConfirmAt + 900) });
  const connectedAt = callConfirmAt + 3_700;
  updateCall(connectedAt, 'call connected', { status: 'connected', startedAt: at(connectedAt) });
  // The welcome follows cartesia/agent/welcome.txt (Oct 25: straight to the point, no callback number).
  const lines: Array<[number, 'assistant' | 'recipient', string]> = [
    [connectedAt + 300, 'assistant', 'Hi Demo caregiver, this is an AI assistant from the Eleven app, and this call is recorded.'],
    [
      connectedAt + 4_300,
      'assistant',
      'Demo user and their partner are having dinner at the cafe on Bay St at 7 tonight, and they ask if you can meet them there.',
    ],
    [connectedAt + 8_300, 'recipient', 'Yes, I got it. I will be there at 7.'],
  ];
  lines.forEach(([lineAt, role, text], i) => {
    step(lineAt, `call line ${i + 1}`, (rows) => {
      const call = rows.calls.find((c) => c.id === callId);
      call?.transcript.push({ id: `line-${loop}-${i + 1}`, role, text, at: at(lineAt) });
    });
  });

  // STOP, a held jaw clench, hangs up. During a call STOP does not pause (docs/spacetime.md 4.2): the
  // module asks the call agent to hang up (`cancel_requested`), and the call ends once the line drops.
  const hangUpAt = connectedAt + 10_300;
  command(hangUpAt, 'STOP', { confidence: 0.97 }, (rows, id) => {
    const call = rows.calls.find((c) => c.id === callId);
    if (call) Object.assign(call, { stopCommandId: id, cancelRequested: true });
  });
  const endedAt = hangUpAt + 600;
  updateCall(endedAt, 'call ended', {
    status: 'ended',
    result: 'cancelled',
    endReason: 'The person hung up with STOP.',
    endedAt: at(endedAt),
  });
  event(endedAt, 'call', 'ok', { callId }, endedAt - callAt);

  // STOP while idle pauses; PICK_1 resumes.
  const pauseAt = hangUpAt + 2_100;
  command(pauseAt, 'STOP', { confidence: 0.97 }, (rows) => {
    rows.safety = { state: 'paused', since: at(pauseAt) };
  });
  setScan(pauseAt, 'scan paused', { phase: 'paused', stepStartedAt: at(pauseAt), stepEndsAt: at(pauseAt) });
  const resumeAt = pauseAt + 2_600;
  command(resumeAt, 'PICK_1', { confidence: 0.95 }, (rows) => {
    rows.safety = { state: 'ok', since: at(resumeAt) };
  });
  setScan(resumeAt, 'scan resumed', { phase: 'idle', stepStartedAt: at(resumeAt), stepEndsAt: at(resumeAt) });

  // The headset loses contact. HEADSET_OFF is a system event, not a command the person gives. PICK_1 resumes once contact is good.
  const headsetOffAt = resumeAt + 1_000;
  command(headsetOffAt, 'HEADSET_OFF', { confidence: null }, (rows) => {
    rows.safety = { state: 'headset_off', since: at(headsetOffAt) };
  });
  setScan(headsetOffAt, 'scan paused, headset off', { phase: 'paused', stepStartedAt: at(headsetOffAt), stepEndsAt: at(headsetOffAt) });
  const contactAt = headsetOffAt + 2_600;
  command(contactAt, 'PICK_1', { confidence: 0.95 }, (rows) => {
    rows.safety = { state: 'ok', since: at(contactAt) };
  });
  setScan(contactAt, 'scan resumed after contact', { phase: 'idle', stepStartedAt: at(contactAt), stepEndsAt: at(contactAt) });

  // Stable sort keeps the written order for steps at the same moment.
  return steps.sort((a, b) => a.t - b.t);
}

function toDataRows(rows: MutableRows): DataRows {
  return {
    questions: rows.questions,
    pipelineEvents: rows.pipelineEvents,
    options: rows.options,
    errands: rows.errands,
    calls: rows.calls,
    commands: rows.commands,
    scan: rows.scan,
    safety: rows.safety,
    // The sample is a headset session by design: its commands are the headset's, with decoder confidences.
    input: 'headset',
  };
}

/** Every row the replay shows at `now`, for a replay that started at `startedAt`. Pure. */
export function replayRowsAt(startedAt: number, now: number): DataRows {
  const elapsed = Math.max(0, now - startedAt);
  const current = Math.floor(elapsed / LOOP_MS);
  const first = Math.max(0, current - HISTORY_LOOPS);
  const rows = emptyRows();
  for (let loop = first; loop <= current; loop++) {
    const loopStart = startedAt + loop * LOOP_MS;
    const limit = loop < current ? Number.POSITIVE_INFINITY : elapsed - loop * LOOP_MS;
    for (const s of buildLoop(loop, loopStart)) {
      if (s.t > limit) break;
      s.apply(rows);
    }
  }
  return toDataRows(rows);
}

/** The next moment after `now` when the replay changes. Always later than `now`. */
export function nextChangeAt(startedAt: number, now: number): number {
  const elapsed = Math.max(0, now - startedAt);
  const loop = Math.floor(elapsed / LOOP_MS);
  const loopStart = startedAt + loop * LOOP_MS;
  for (const s of buildLoop(loop, loopStart)) {
    if (loopStart + s.t > now) return loopStart + s.t;
  }
  return startedAt + (loop + 1) * LOOP_MS;
}

export interface ReplayClock {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** The sample replay as a data source. It reports Live as soon as it starts. */
export function createReplaySource(clock: ReplayClock = {}): DataSource {
  const now = clock.now ?? Date.now;
  const setTimer = clock.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = clock.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const store = createStateStore(initialState('replay'));
  let startedAt = 0;
  let timer: unknown = null;
  let running = false;

  const schedule = (from: number) => {
    const next = nextChangeAt(startedAt, from);
    timer = setTimer(tick, Math.max(0, next - from));
  };

  function tick() {
    timer = null;
    if (!running) return;
    const t = now();
    store.set({ rows: replayRowsAt(startedAt, t) }, t);
    schedule(t);
  }

  return {
    mode: 'replay',
    getState: store.get,
    subscribe: store.subscribe,
    start() {
      if (running) return;
      running = true;
      startedAt = now();
      store.set(
        { connection: 'live', ready: true, reason: null, errorText: null, rows: replayRowsAt(startedAt, startedAt) },
        startedAt,
      );
      schedule(startedAt);
    },
    stop() {
      running = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
