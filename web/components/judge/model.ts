/**
 * The judge page (PLAN 5.8): every line it prints, built here from constants so a test can hold each one to the repo's
 * own docs. Pure, no React.
 *
 * Rules for this file:
 * - A measured line states only what its cited doc section states. `evidence` is a verbatim quote from that section,
 *   and every number in `text` must also be in `evidence` (test/judge-page.test.ts reads the doc and checks both).
 * - The "not measured yet" lines come from docs/station.md section 8 and the status tables, with the same check.
 * - The page shows a live number only when it fetched it from the public stats route itself; it never fills one in.
 */

export const REPO_URL = 'https://github.com/StephenSook/say-when';
export const ACTOR_URL = 'https://apify.com/stephensookra/confirm-gated-form-errand';
export const MAINCLOUD_URL = 'https://maincloud.spacetimedb.com';

/** The repo files a line may cite, relative to the repo root. */
export type DocFile = 'README.md' | 'web/README.md' | 'docs/spacetime.md' | 'docs/station.md';

export interface Citation {
  file: DocFile;
  /** The heading the line comes from: a section number such as "12.2" or "8", or a heading word such as "Status". */
  section: string;
  /** The date the doc gives for it. */
  date: string;
}

export interface Claim {
  /** The one line on the page. */
  text: string;
  cite: Citation;
  /** A verbatim quote from the cited section that backs the line. Every number in `text` is in here. */
  evidence: string;
}

export interface ItineraryStep {
  /** 1 to 4, in the order a judge should open them. */
  n: number;
  title: string;
  line: string;
  href: string;
}

export interface JudgeDatabase {
  db: string;
  note: string;
}

export interface JudgeLink {
  label: string;
  text: string;
  href: string;
}

export interface JudgePage {
  title: string;
  lead: string;
  signals: string;
  safety: string;
  tourTitle: string;
  itinerary: ItineraryStep[];
  replay: { before: string; link: string; href: string };
  checkTitle: string;
  databases: JudgeDatabase[];
  links: JudgeLink[];
  measuredTitle: string;
  measured: Claim[];
  notMeasuredTitle: string;
  notMeasured: Claim[];
}

const OCT_24 = 'Oct 24';

const ITINERARY: readonly Omit<ItineraryStep, 'n'>[] = [
  { title: 'Live data', href: '/live', line: 'Each step of a question as it runs, with its time.' },
  { title: 'Conversation', href: '/conversation', line: 'The options, and the cursor on the one in the earpiece.' },
  { title: 'Suggested replies', href: '/replies', line: 'Where each option came from: notes and the web.' },
  { title: 'Agents', href: '/agents', line: 'An errand read back, then its confirm window.' },
  { title: 'Partner phone', href: '/partner', line: 'The partner view. Open it on a phone, or at 390 px wide.' },
];

export const MEASURED: readonly Claim[] = [
  {
    text: 'The scan clock ran its steps a median 2 ms after the planned time, max 10 ms, over 76 steps.',
    cite: { file: 'docs/spacetime.md', section: '12.2', date: OCT_24 },
    evidence: '76 steps run by `scan_tick` over five runs: a median 2 ms after the planned time, max 10 ms',
  },
  {
    text: 'A YES sent up to 272 ms after the next option began still picked the option heard.',
    cite: { file: 'docs/spacetime.md', section: '12.2', date: OCT_24 },
    evidence: "A YES heard in option 1's window and sent after option 2 began picked option 1 with `late_by_ms` 272, 174 and 216",
  },
  {
    text: 'With heartbeats stopped, the database paused itself 1501 to 1502 ms after the last one, 4 of 4.',
    cite: { file: 'docs/spacetime.md', section: '12.2', date: OCT_24 },
    evidence: '`liveness_expired` paused the session 1501 to 1502 ms after the last beat, 4 of 4',
  },
  {
    text: 'Each wrong release we tried was recorded and ignored: YES, an early CONFIRM, a CONFIRM in the quiet hold, a wrong digest, a repeat.',
    cite: { file: 'docs/spacetime.md', section: '12.2', date: OCT_24 },
    evidence:
      'each of these was recorded and ignored, in order: YES during the read-back (`yes_is_not_confirm`), CONFIRM before the read-back (`readback_not_done`), CONFIRM inside the quiet hold (`quiet_hold`), CONFIRM with a digest the person did not hear (`digest_mismatch`), a second CONFIRM (`refractory`)',
  },
  {
    text: "The module's end-to-end smoke test passed 25 of 25 checks on Maincloud.",
    cite: { file: 'docs/spacetime.md', section: '14.4', date: OCT_24 },
    evidence: '`spacetime/scripts/smoke_e2e.py` passed 25 of 25',
  },
  {
    text: 'The live keyboard run passed 11 of 13 steps, with a pick 52 ms late that still took the option heard.',
    cite: { file: 'README.md', section: 'Status', date: OCT_24 },
    evidence:
      'Live keyboard run on `say-when-dev` (Oct 24, no voice yet): 11 of 13 checks pass, including a pick that landed 52 ms after the next option began and still took the option heard',
  },
  {
    text: 'The first end-to-end live run, voiced: Claude drafted, Apify searched, Moss recalled, Cartesia read the options, and an errand was sent only after a fresh CONFIRM, 3.9 s after it.',
    cite: { file: 'docs/station.md', section: '7.5', date: OCT_24 },
    evidence: 'the errand read Sent 3.9 s after the confirm',
  },
  {
    text: 'In that run, a question reached its first option read in 19.2 to 27.0 s.',
    cite: { file: 'docs/station.md', section: '7.5', date: OCT_24 },
    evidence: 'Question to first option read: 19.2 to 27.0 s on the four open questions that were not paused',
  },
  {
    text: 'The form-errand Actor, build 0.1.4 on Apify: a preview, a submit with the confirmed digest, and a repeat submit refused as a duplicate.',
    cite: { file: 'README.md', section: 'Status', date: OCT_24 },
    evidence:
      'Verified on the platform with build 0.1.4 (Oct 24): preview, submit with the confirmed digest, and a repeat submit refused as a duplicate',
  },
];

export const NOT_MEASURED: readonly Claim[] = [
  {
    text: 'No wearer yet. The numbers above come from test runs, not a person using it.',
    cite: { file: 'docs/station.md', section: '8', date: OCT_24 },
    evidence: 'A smoke-test number as if a wearer produced it',
  },
  {
    text: 'Keyboard sessions are key presses, not brain or jaw signals.',
    cite: { file: 'docs/station.md', section: '8', date: OCT_24 },
    evidence: 'Those are key and switch presses',
  },
  {
    text: 'Imagined fist squeezes count only once a wearer passes the brain test.',
    cite: { file: 'docs/station.md', section: '8', date: OCT_24 },
    evidence: 'Imagined fist squeezes as commands unless the wearer passed `docs/brain-mode-test.md` today',
  },
  {
    text: 'The headset has not driven the deployed station page yet.',
    cite: { file: 'docs/station.md', section: '8', date: OCT_24 },
    evidence: 'That the headset drives the deployed station page: 5.1 and L4 have not run.',
  },
  {
    text: 'Moss memory was empty in that run, so no memory hit has been shown yet.',
    cite: { file: 'docs/station.md', section: '7.5', date: OCT_24 },
    evidence: 'Moss recall ran in 86 to 117 ms with 0 hits, because the memory was empty',
  },
  {
    text: 'The room voice speaking a reply live has not been seen since its fix.',
    cite: { file: 'docs/station.md', section: '7.5', date: OCT_24 },
    evidence: 'the room voice ignored a reply arriving as an update to the session row (it never spoke live)',
  },
  {
    text: 'No phone call has run yet.',
    cite: { file: 'web/README.md', section: 'Limits', date: OCT_24 },
    evidence: 'no call has run on `say-when-dev` yet',
  },
  {
    text: 'No latency figures yet: command to pick, reply in the room, earpiece start, speech to text.',
    cite: { file: 'docs/station.md', section: '8', date: OCT_24 },
    evidence: 'Any latency: command to pick, pick to the reply in the room, earpiece start lag, speech to text time.',
  },
];

export const JUDGE_DATABASES: readonly JudgeDatabase[] = [
  { db: 'say-when-demo', note: 'The demo database. Empty until the demo session runs.' },
  { db: 'say-when-dev', note: 'Test sessions with made-up content.' },
];

/** Every line the judge page prints, in reading order. */
export function buildJudgePage(): JudgePage {
  return {
    title: 'For judges',
    lead: 'A person who cannot speak or use their hands hears up to four replies in an earpiece and picks one with an EEG headset.',
    signals:
      'YES and NO are imagined right and left fist squeezes, read over the motor cortex. CONFIRM and STOP are jaw clenches, a muscle signal. No thoughts are read.',
    safety: 'A form or a phone call is read back first and goes only after a fresh CONFIRM.',
    tourTitle: 'In three minutes',
    itinerary: buildItinerary(),
    replay: { before: 'Nothing running?', link: 'Play the sample replay', href: '/conversation?replay=1' },
    checkTitle: 'Check it yourself, no login',
    databases: JUDGE_DATABASES.map((d) => ({ ...d })),
    links: [
      { label: 'Code', text: 'github.com/StephenSook/say-when', href: REPO_URL },
      { label: 'Apify Actor', text: 'apify.com/stephensookra/confirm-gated-form-errand', href: ACTOR_URL },
    ],
    measuredTitle: 'Measured',
    measured: MEASURED.map(copyClaim),
    notMeasuredTitle: 'Not measured yet',
    notMeasured: NOT_MEASURED.map(copyClaim),
  };
}

export function buildItinerary(): ItineraryStep[] {
  return ITINERARY.map((step, i) => ({ n: i + 1, ...step }));
}

function copyClaim(claim: Claim): Claim {
  return { text: claim.text, evidence: claim.evidence, cite: { ...claim.cite } };
}

/** "docs/spacetime.md 12.2, Oct 24": the small line under a claim. */
export function citationLabel(cite: Citation): string {
  return `${cite.file} ${cite.section}, ${cite.date}`;
}

/** The cited file on GitHub. */
export function citationUrl(cite: Citation): string {
  return `${REPO_URL}/blob/main/${cite.file}`;
}

/** The module's public HTTP routes (docs/spacetime.md 6.2): no key, CORS `*`. */
export function routeUrl(db: string, route: 'stats' | 'ping'): string {
  return `${MAINCLOUD_URL}/v1/database/${encodeURIComponent(db)}/route/${route}`;
}

/** Display only: keeps a number on the same line as its unit ("2 ms", "390 px") when a line wraps on a phone. */
export function keepUnits(text: string): string {
  return text.replace(/(\d) (ms|px)\b/g, '$1 $2');
}

/** Every number in a line, as written: "1501", "0.1.4". */
export function numbersIn(text: string): string[] {
  return text.match(/\d+(?:\.\d+)*/g) ?? [];
}

// The stats route's answer (`SessionStats` in spacetime/src/stats.ts, the board's active or most recent session). Only
// these counts are shown, in this order; the medians are left to the link (docs/station.md 8: no latency claims yet).
const STAT_FIELDS: readonly { key: string; label: string }[] = [
  { key: 'questions', label: 'Questions' },
  { key: 'questionsAnswered', label: 'Answered' },
  { key: 'picks', label: 'Picks' },
  { key: 'latePicks', label: 'Late picks' },
  { key: 'pauses', label: 'Pauses' },
  { key: 'errandsSent', label: 'Errands sent' },
  { key: 'errandsStopped', label: 'Errands stopped' },
  { key: 'gestures', label: 'Commands' },
  { key: 'gesturesIgnored', label: 'Ignored' },
];

/** The words around the live stats, one per state. */
export const STATS_WORDS = {
  loading: 'Loading the stats',
  session: 'Session',
  noSession: 'No session yet.',
  invalid: 'The answer was not the stats. Open the link.',
  failed: 'Could not load the stats here. Open the link.',
  statsLink: 'Stats',
  pingLink: 'Ping',
} as const;

/** How long the page waits for one stats answer before it says it could not load it. */
export const STATS_TIMEOUT = 8_000;

export interface StatField {
  label: string;
  value: number;
}

export type StatsView =
  | { kind: 'session'; session: number; fields: StatField[] }
  | { kind: 'no_session' }
  | { kind: 'invalid' };

/**
 * What the page shows for one stats answer, or `invalid` for anything that is not one. Values are shown only as whole
 * numbers taken from the answer; a missing or non-numeric field is left out, never filled in.
 */
export function statsView(body: unknown): StatsView {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { kind: 'invalid' };
  const record = body as Record<string, unknown>;
  const session = record.sessionId;
  if (!isCount(session)) return { kind: 'invalid' };
  if (session === 0) return { kind: 'no_session' };
  const fields: StatField[] = [];
  for (const { key, label } of STAT_FIELDS) {
    const value = record[key];
    if (isCount(value)) fields.push({ label, value });
  }
  if (fields.length === 0) return { kind: 'invalid' };
  return { kind: 'session', session, fields };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
