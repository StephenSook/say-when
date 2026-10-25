/**
 * Pure helpers the screens share for reading rows. All inputs are sorted oldest first.
 */
import {
  PERSON_COMMANDS,
  type AnswerOption,
  type CommandEvent,
  type MemoryType,
  type MossHit,
  type PersonCommand,
  type PipelineEvent,
  type PipelineEventOf,
  type Question,
  type ScanState,
  type Stage,
  type WordTiming,
} from './types';

/** The newest question, or null. */
export function latestQuestion(questions: readonly Question[]): Question | null {
  return questions.length === 0 ? null : (questions[questions.length - 1] ?? null);
}

/** One question's events, oldest first. */
export function eventsForQuestion(events: readonly PipelineEvent[], questionId: string | null): PipelineEvent[] {
  if (questionId === null) return [];
  return events.filter((event) => event.questionId === questionId);
}

export type LatestByStage = { [S in Stage]?: PipelineEventOf<S> };

/** The newest event per stage, for one question's events. Its status is the stage's status. */
export function latestByStage(events: readonly PipelineEvent[]): LatestByStage {
  const latest: LatestByStage = {};
  for (const event of events) {
    (latest as Record<Stage, PipelineEvent>)[event.stage] = event;
  }
  return latest;
}

/** The newest event of one stage, typed for its detail. */
export function latestOfStage<S extends Stage>(events: readonly PipelineEvent[], stage: S): PipelineEventOf<S> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event && event.stage === stage) return event as PipelineEventOf<S>;
  }
  return null;
}

/** The newest version of one question's options, in reading order. */
export function latestOptions(options: readonly AnswerOption[], questionId: string | null): AnswerOption[] {
  if (questionId === null) return [];
  let version = -Infinity;
  for (const option of options) {
    if (option.questionId === questionId && option.version > version) version = option.version;
  }
  return options
    .filter((option) => option.questionId === questionId && option.version === version)
    .sort((a, b) => a.rank - b.rank);
}

/**
 * docs/ui.md headline latency, "2.9 s to the first option": from the moment the partner's words were
 * heard (Listen ok) to the first option starting in the earpiece (the first Speak started after it).
 * null until both exist.
 */
export function timeToFirstOption(questionEvents: readonly PipelineEvent[]): number | null {
  let heardAt: number | null = null;
  for (const event of questionEvents) {
    if (event.stage === 'listen' && event.status === 'ok') heardAt = event.at;
    if (
      heardAt !== null &&
      event.stage === 'speak' &&
      event.status === 'started' &&
      event.detail.channel !== 'aloud' &&
      event.at >= heardAt
    ) {
      return event.at - heardAt;
    }
  }
  return null;
}

/** The option in the earpiece: the one under the cursor while it is read or its window is open. */
export function optionUnderCursor(scan: ScanState | null, options: readonly AnswerOption[]): AnswerOption | null {
  if (!scan || scan.cursor === null || scan.outcome !== null) return null;
  // Direct select (D18): only a read is on one option; the Window after the list waits for any number.
  if (scan.phase !== 'reading') return null;
  return options.find((option) => option.questionId === scan.questionId && option.version === scan.version && option.rank === scan.cursor) ?? null;
}

/** The option the person picked: after the pick (and during a veto, on a scan database). null when nothing was picked. */
export function pickedOption(scan: ScanState | null, options: readonly AnswerOption[]): AnswerOption | null {
  if (!scan || scan.pickedOptionId === null) return null;
  return options.find((option) => option.id === scan.pickedOptionId) ?? null;
}

/** The newest command event, accepted or ignored. */
export function latestCommand(commands: readonly CommandEvent[]): CommandEvent | null {
  return commands.length === 0 ? null : (commands[commands.length - 1] ?? null);
}

/** docs/ui.md "Command strip": a chip lights for 1.2 s when its command arrives. */
export const COMMAND_ECHO_MS = 1_200;

/**
 * Which of the person's four commands to light on the command strip at `now`: the newest accepted
 * YES, NO, CONFIRM or STOP that arrived less than `holdMs` ago. Ignored repeats and HEADSET_OFF never light.
 * A command stamped a little after `now` counts as just arrived: the database's clock and the
 * laptop's clock can differ by a few hundred milliseconds.
 */
export function litCommand(commands: readonly CommandEvent[], now: number, holdMs: number = COMMAND_ECHO_MS): PersonCommand | null {
  for (let i = commands.length - 1; i >= 0; i--) {
    const event = commands[i];
    if (!event || !event.accepted) continue;
    if (!(PERSON_COMMANDS as readonly string[]).includes(event.command)) continue;
    return now - event.at < holdMs ? (event.command as PersonCommand) : null;
  }
  return null;
}

/** What is said out loud for the room after YES picks a reply ("Said out loud" on the screens). */
export interface SpokenReply {
  text: string;
  /** When it was said out loud. null while it is released but not spoken yet. */
  spokenAt: number | null;
}

/**
 * The reply for one question, from the question row (docs/spacetime.md: `reply_text` and `spoken_at`
 * on `public_board`). null until YES picks a reply and the veto ends. The 'aloud' speak events in the
 * pipeline show the same moment on Live data.
 */
export function spokenReply(question: Question | null): SpokenReply | null {
  const text = question?.replyText?.trim();
  if (!question || !text) return null;
  return { text, spokenAt: question.spokenAt };
}

/**
 * Which word is playing `elapsedMs` into a clip, for the "In the earpiece now" highlight.
 * Same rule as cartesia's wordAt: the last word that has started. -1 before the first word.
 */
export function wordIndexAt(words: readonly WordTiming[], elapsedMs: number): number {
  let index = -1;
  for (let i = 0; i < words.length; i++) {
    if ((words[i]?.startMs ?? Infinity) <= elapsedMs) index = i;
  }
  return index;
}

/** How far through the current scan phase we are, from 0 to 1. */
export function scanProgress(scan: ScanState, now: number): number {
  const span = scan.stepEndsAt - scan.stepStartedAt;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - scan.stepStartedAt) / span));
}

/** A memory's category in words, for "Private memory" and its meta line. */
export const MEMORY_CATEGORY_WORDS: Readonly<Record<MemoryType, string>> = {
  pref: 'Preference',
  reply: 'Past reply',
};

export interface HitDisplay {
  /** The words a screen may show. "Private memory" for a memory the person did not mark shareable. */
  text: string;
  /** true when the memory's text is withheld. */
  isPrivate: boolean;
  origin: 'memory' | 'web';
  /** For memory hits: "Preference", "Past reply", or "Memory" when the category is missing. null for web hits. */
  category: string | null;
}

/**
 * The memory privacy rule in one place (docs/ui.md "Retrieve"). A web hit shows its text. A memory
 * hit shows its text only when it carries `sharedText`; every other memory reads "Private memory"
 * with its category. Anything not marked as a web hit is treated as a memory, and a memory's `text`
 * field is never shown, even if a mapping bug fills it.
 */
export function hitDisplay(hit: MossHit): HitDisplay {
  if (hit.origin === 'web') {
    return { text: hit.text?.trim() || 'Web passage', isPrivate: false, origin: 'web', category: null };
  }
  const category = hit.memoryType ? (MEMORY_CATEGORY_WORDS[hit.memoryType] ?? 'Memory') : 'Memory';
  const shared = hit.sharedText?.trim();
  if (shared) return { text: shared, isPrivate: false, origin: 'memory', category };
  return { text: 'Private memory', isPrivate: true, origin: 'memory', category };
}
