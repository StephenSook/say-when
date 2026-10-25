/**
 * What the room voice page shows (docs/station.md 3, "What it shows"), as a pure function of the engine's state and
 * the room, so every state is tested without a browser.
 *
 * - One large status with a word, a mark and a color: Waiting for a reply, Paused, Saying it out loud, Said out
 *   loud, Missed, Could not say the reply.
 * - The reply's words only while the room's toggle `config.share_text_on_board` is on, as on the board: the speech is
 *   heard in the room, but a screen is a lasting record. With it off: "Reply to question 7".
 * - A missed reply is muted, never red: nothing went wrong, it was too old to say (docs/ui.md).
 */
import type { SpeakerRoom } from '@/lib/speaker/rows';
import type { SpeakerReply, SpeakerState } from '@/lib/speaker/engine';
import type { MirrorState } from '@/lib/speaker/mirror';
import { formatAge, formatClock } from '@/lib/format';

export type SpeakerTone = 'plain' | 'working' | 'waiting' | 'done' | 'stopped' | 'failed';
export type SpeakerMark = 'ring' | 'spinner' | 'hourglass' | 'check' | 'pause' | 'cross';

export interface SpeakerLine {
  text: string;
  tone: SpeakerTone;
  mark: SpeakerMark;
  /** Raw detail for a tooltip only. */
  title: string | null;
}

export interface SpeakerView {
  /** Changes only when the state changes in a way worth announcing. */
  key: string;
  status: SpeakerLine;
  /** The reply's words in quotes (sharing on), or null. */
  words: string | null;
  /** "Reply to question 7" when the words are not shared, or null. */
  replyLabel: string | null;
  /** "Said at 12:41:08", or null. */
  meta: string | null;
  /** The link to offer: say the reply now, or nothing. */
  sayNow: boolean;
  /** Whether `reply_spoken` reached the database. */
  report: SpeakerLine | null;
  /** Two room voices online: both would talk. */
  warning: string | null;
}

export interface SpeakerViewInput {
  state: SpeakerState;
  room: SpeakerRoom;
  /** Laptop clock now. */
  now: number;
  /** Server clock minus laptop clock, from the engine. */
  offsetMs: number;
  /** True while the room voice runs (the tap was made). */
  audioRunning: boolean;
}

export const SPEAKER_TEXT = {
  waiting: 'Waiting for a reply.',
  paused: 'Paused. Nothing will be said.',
  needsAudio: 'A reply is waiting. Start the room voice to say it.',
  speaking: 'Saying it out loud',
  said: 'Said out loud',
  saidBeforeReload: 'Said out loud before this page reloaded.',
  failed: 'Could not say the reply.',
  twoSpeakers: 'Two room voices are on, so each reply would be said twice. Close one of them.',
} as const;

function line(text: string, tone: SpeakerTone, mark: SpeakerMark, title: string | null = null): SpeakerLine {
  return { text, tone, mark, title };
}

/** "question 7": the question id the speaker sees (`my_session.reply.question_id`). */
export function questionLabel(reply: SpeakerReply): string {
  return `question ${reply.questionId.toString()}`;
}

export function missedSentence(reply: SpeakerReply, now: number, offsetMs: number): string {
  const age = formatAge(reply.releasedAtMs, now + offsetMs);
  return age ? `Missed reply to ${questionLabel(reply)}, released ${age}.` : `Missed reply to ${questionLabel(reply)}.`;
}

function reportLine(state: SpeakerState): SpeakerLine | null {
  switch (state.report) {
    case 'none':
      return null;
    case 'sending':
      return line('Recording that it was said', 'working', 'spinner');
    case 'retrying':
      return line('Not connected. Trying again.', 'working', 'spinner');
    case 'done':
      return line('Recorded as said', 'done', 'check');
    case 'stopped':
      return line('Not recorded: the reply was no longer waiting.', 'stopped', 'pause', state.reportText);
    case 'refused':
      return line('Not recorded: the database refused it.', 'failed', 'cross', state.reportText);
    case 'gave_up':
      return line('Not recorded: no connection for a minute.', 'failed', 'cross', state.reportText);
  }
}

export function buildSpeakerView(input: SpeakerViewInput): SpeakerView {
  const { state, room } = input;
  const reply = state.reply;
  const warning = room.speakersOnline > 1 ? SPEAKER_TEXT.twoSpeakers : null;
  const words = reply && room.sharing && reply.text.trim() !== '' ? `"${reply.text.trim()}"` : null;
  const replyLabel = reply && words === null ? `Reply to ${questionLabel(reply)}` : null;
  const id = reply ? reply.questionId.toString() : 'none';
  const base = { words, replyLabel, meta: null, sayNow: false, report: reportLine(state), warning };

  switch (state.phase) {
    case 'idle':
      if (room.paused) return { ...base, key: 'paused', status: line(SPEAKER_TEXT.paused, 'stopped', 'pause'), words: null, replyLabel: null };
      return { ...base, key: 'idle', status: line(SPEAKER_TEXT.waiting, 'plain', 'ring'), words: null, replyLabel: null };
    case 'waiting_audio':
      return {
        ...base,
        key: `${id}:needs-audio`,
        status: line(SPEAKER_TEXT.needsAudio, 'waiting', 'hourglass'),
        sayNow: input.audioRunning && state.stillReleased,
      };
    case 'speaking':
      return { ...base, key: `${id}:speaking`, status: line(SPEAKER_TEXT.speaking, 'working', 'spinner') };
    case 'said':
      return {
        ...base,
        key: `${id}:said`,
        status: line(SPEAKER_TEXT.said, 'done', 'check'),
        meta: state.saidAt !== null ? `Said at ${formatClock(state.saidAt)}` : SPEAKER_TEXT.saidBeforeReload,
      };
    case 'missed':
      return {
        ...base,
        key: `${id}:missed`,
        status: line(reply ? missedSentence(reply, input.now, input.offsetMs) : 'Missed a reply.', 'stopped', 'pause'),
        sayNow: input.audioRunning && state.stillReleased,
      };
    case 'failed':
      return {
        ...base,
        key: `${id}:failed`,
        status: line(SPEAKER_TEXT.failed, 'failed', 'cross', state.errorText),
        sayNow: input.audioRunning && state.stillReleased,
      };
  }
}

// ---------- Say read-backs (lib/speaker/mirror.ts; read-backs only since Oct 25) ----------

export const MIRROR_TEXT = {
  off: 'Read-backs off. Only the picked reply is said.',
  noSharing: 'Read-backs need board sharing on. Only the picked reply is said.',
  unavailable: 'Read-backs unavailable: the board could not be read.',
  needsAudio: 'Tap Start room voice to hear the read-backs here.',
  waitingAudio: 'A read-back is waiting. Tap Start room voice.',
  idle: 'Saying read-backs.',
  question: 'Saying the question',
  option: 'Saying an option',
  readback: 'Saying the read-back',
  failed: 'Could not play the last read-back.',
} as const;

export interface MirrorView {
  line: SpeakerLine;
  /** The line being said, in quotes (sharing is on whenever the mirror speaks), or null. */
  words: string | null;
}

/** The mirror's one status line under the reply, and the words it is saying. */
export function buildMirrorView(mirror: MirrorState, audioRunning: boolean): MirrorView {
  switch (mirror.phase) {
    case 'off':
      return { line: line(MIRROR_TEXT.off, 'plain', 'ring'), words: null };
    case 'no_sharing':
      return { line: line(MIRROR_TEXT.noSharing, 'stopped', 'pause'), words: null };
    case 'unavailable':
      return { line: line(MIRROR_TEXT.unavailable, 'failed', 'cross', mirror.errorText), words: null };
    case 'waiting_audio':
      return { line: line(MIRROR_TEXT.waitingAudio, 'waiting', 'hourglass'), words: null };
    case 'speaking': {
      const item = mirror.current;
      const text = item?.kind === 'question' ? MIRROR_TEXT.question : item?.kind === 'readback' ? MIRROR_TEXT.readback : MIRROR_TEXT.option;
      return { line: line(text, 'working', 'spinner'), words: item ? `"${item.text}"` : null };
    }
    case 'failed':
      return { line: line(MIRROR_TEXT.failed, 'failed', 'cross', mirror.errorText), words: null };
    case 'idle':
      if (!audioRunning) return { line: line(MIRROR_TEXT.needsAudio, 'waiting', 'hourglass'), words: null };
      return { line: line(MIRROR_TEXT.idle, 'done', 'check'), words: null };
  }
}
