/**
 * The room voice's audio: Cartesia Sonic through the copied browser code in lib/cartesia (docs/station.md 3, step 3).
 *
 * - One `TtsPlayer` with `maxActive: 1` (the Free plan allows 2 TTS contexts per account: one station, one speaker).
 *   `getToken` is called once per socket; the page passes `device.voice.getToken`, which mints a fresh 60 s token.
 * - A reply streams its chunks into one `AudioOut` as they arrive, for the lowest latency, in the reply voice with
 *   its tone, an optional laugh, and the room volume (`generation_config.volume`, 0.5 to 2).
 * - `done` resolves only after the last chunk has finished playing, and only as a success when the AudioContext was
 *   running the whole time and the clip had sound, so the page never reports words nobody heard.
 * - The retry (attempt 2) closes the player first, so it opens a fresh socket with a fresh token.
 */
import { AudioOut, TtsPlayer, utterance, voiceProfile, type AudioContextLike, type Clip, type Utterance, type WordTiming } from '../cartesia/browser';
import type { SayJob, SayResult } from './engine';

/** The Test voice sentence (docs/station.md Appendix A, speaker only). */
export const TEST_VOICE_TEXT = 'This is the NeuroLingo room voice.';

/** How often the end of playback is checked. */
export const PLAYBACK_POLL_MS = 100;

/** Playback may run this long past the clip's own length before it counts as stuck. */
export const PLAYBACK_SLACK_MS = 3_000;

/** The parts of TtsPlayer this file uses. */
export interface PlayerLike {
  speak(u: Utterance, options: { onAudio?: (pcm: Uint8Array) => void }): { done: Promise<Clip>; cancel(): void };
  close(): void;
}

/** The parts of AudioOut this file uses. */
export interface OutLike {
  enqueue(pcm: Uint8Array): void;
  stop(): void;
  readonly playing: boolean;
  positionMs(): number;
}

export interface ContextLike {
  readonly state: string;
}

export interface SayText {
  text: string;
  tone: string;
  laugh: boolean;
}

export interface SpeakerVoiceOptions {
  getToken: () => Promise<string>;
  /** The page's started AudioContext, or null before the tap. */
  context: () => (ContextLike & object) | null;
  /** The room volume, 0.5 to 2. */
  volume: () => number;
  pronunciationDictId?: string;
  makePlayer?: (getToken: () => Promise<string>, pronunciationDictId: string | undefined) => PlayerLike;
  makeOut?: (context: ContextLike & object) => OutLike;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SpeakerVoice {
  /** Says a reply aloud (engine `say`). */
  say(reply: SayText, attempt: number): SayJob;
  /** Plays the Test voice sentence. Not reported anywhere. */
  testVoice(): SayJob;
  /** The words of what is playing now, once its timings have arrived, and the position in it, for marking. */
  words(): readonly WordTiming[];
  positionMs(): number;
  /** Stops speech and closes the socket. The next say opens a new one. */
  close(): void;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'TtsCancelled';
}

const defaultPlayer = (getToken: () => Promise<string>, pronunciationDictId: string | undefined): PlayerLike =>
  new TtsPlayer({ getToken, pronunciationDictId, maxActive: 1 });

const defaultOut = (context: ContextLike & object): OutLike => new AudioOut(context as unknown as AudioContextLike);

/** The reply as Cartesia's utterance: reply voice, its tone, a laugh if asked, the room volume. Throws on empty text. */
export function replyUtterance(reply: SayText, volume: number): Utterance {
  const replyVolume = Number.isFinite(volume) ? Math.min(2, Math.max(0.5, volume)) : 1;
  return utterance({ kind: 'reply', text: reply.text, tone: reply.tone, laugh: reply.laugh }, voiceProfile({ replyVolume }));
}

export function createSpeakerVoice(options: SpeakerVoiceOptions): SpeakerVoice {
  const makePlayer = options.makePlayer ?? defaultPlayer;
  const makeOut = options.makeOut ?? defaultOut;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let player: PlayerLike | null = null;
  let out: { context: object; out: OutLike } | null = null;
  let currentWords: readonly WordTiming[] = [];
  let current: { cancel(): void } | null = null;

  const playerNow = (fresh: boolean): PlayerLike => {
    if (fresh && player) {
      try {
        player.close();
      } catch {
        // Already closed.
      }
      player = null;
    }
    if (!player) player = makePlayer(options.getToken, options.pronunciationDictId);
    return player;
  };

  const outFor = (context: ContextLike & object): OutLike => {
    if (!out || out.context !== context) out = { context, out: makeOut(context) };
    return out.out;
  };

  const failed = (message: string): SayJob => ({ done: Promise.resolve({ ok: false, reason: 'failed', message }), cancel() {} });

  const play = (u: Utterance, fresh: boolean): SayJob => {
    const context = options.context();
    if (!context || context.state !== 'running') return failed('The room voice is not started.');
    current?.cancel();
    const output = outFor(context);
    output.stop();
    currentWords = [];
    let cancelled = false;
    let timer: unknown = null;
    let generation: { done: Promise<Clip>; cancel(): void };
    try {
      generation = playerNow(fresh).speak(u, { onAudio: (pcm) => output.enqueue(pcm) });
    } catch (error) {
      return failed(errorText(error));
    }

    /** Waits until the output is quiet, the context stops, or the clip's length plus slack has passed. */
    const untilQuiet = (clip: Clip) =>
      new Promise<SayResult>((resolve) => {
        const deadline = Math.max(0, clip.durationMs) + PLAYBACK_SLACK_MS;
        let waited = 0;
        const check = () => {
          timer = null;
          if (cancelled) return resolve({ ok: false, reason: 'stopped', message: 'Stopped.' });
          if (context.state !== 'running') return resolve({ ok: false, reason: 'failed', message: 'The audio stopped before the end.' });
          if (!output.playing) {
            if (clip.durationMs <= 0) return resolve({ ok: false, reason: 'failed', message: 'The speech had no sound.' });
            return resolve({ ok: true, clipMs: clip.durationMs });
          }
          if (waited >= deadline) return resolve({ ok: false, reason: 'failed', message: 'The speech did not finish playing.' });
          waited += PLAYBACK_POLL_MS;
          timer = setTimer(check, PLAYBACK_POLL_MS);
        };
        check();
      });

    const done = generation.done.then(
      (clip) => {
        if (cancelled) return { ok: false, reason: 'stopped', message: 'Stopped.' } as SayResult;
        currentWords = clip.words;
        return untilQuiet(clip);
      },
      (error: unknown): SayResult =>
        cancelled || isCancelled(error) ? { ok: false, reason: 'stopped', message: 'Stopped.' } : { ok: false, reason: 'failed', message: errorText(error) },
    );
    const job = {
      done,
      cancel() {
        if (cancelled) return;
        cancelled = true;
        if (timer !== null) clearTimer(timer);
        timer = null;
        generation.cancel();
        output.stop();
      },
    };
    current = job;
    void done.then(() => {
      if (current === job) current = null;
    });
    return job;
  };

  return {
    say(reply, attempt) {
      let u: Utterance;
      try {
        u = replyUtterance(reply, options.volume());
      } catch (error) {
        return failed(errorText(error));
      }
      return play(u, attempt > 1);
    },
    testVoice() {
      return play(replyUtterance({ text: TEST_VOICE_TEXT, tone: 'neutral', laugh: false }, options.volume()), false);
    },
    words: () => currentWords,
    positionMs: () => out?.out.positionMs() ?? 0,
    close() {
      current?.cancel();
      current = null;
      if (player) {
        try {
          player.close();
        } catch {
          // Already closed.
        }
      }
      player = null;
    },
  };
}
