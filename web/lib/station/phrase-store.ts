/**
 * Stock phrase audio kept across page loads (docs/station.md 2.9 "Phrases ready", the optional IndexedDB note).
 *
 * Every station load voices the same 34 stock phrases and 4 menu items, about 900 characters, which is about 900
 * Cartesia credits a load. This keeps each clip in IndexedDB under the same key `PhraseCache` uses (the model,
 * format, dictionary, words, voice, language, emotion, speed and volume), so a reload plays them from the browser
 * and voices only what changed. Only what goes through `PhraseCache` is kept: the stock phrases and the module's
 * four menu items. Options, read-backs and replies are voiced fresh every time and never stored.
 *
 * A storage that is missing, blocked or full never fails a phrase: the clip is voiced as before.
 */
import type { Clip } from '../cartesia/tts';
import type { Utterance } from '../cartesia/tones';

/** What `PhraseCache` needs from a player (lib/cartesia/tts.ts). */
export interface Synthesizer {
  synthesize(u: Utterance): Promise<Clip>;
  settingsKey(): string;
}

export interface ClipStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: StoredClip): Promise<void>;
}

/** What is kept for one phrase: the audio and its timings, nothing about the request. */
export interface StoredClip {
  v: 1;
  kind: Clip['kind'];
  pcm: Uint8Array;
  encoding: Clip['encoding'];
  sampleRate: Clip['sampleRate'];
  durationMs: number;
  words: Clip['words'];
}

export const PHRASE_DB = 'neurolingo-station-phrases';
const STORE = 'clips';

/**
 * The key, built exactly as `PhraseCache.key` builds it (test/station-phrase-store.test.ts compares the two), so a
 * stored clip is reused only for the same model, format, dictionary, words, voice, language, emotion, speed and volume.
 */
export function phraseStoreKey(settingsKey: string, u: Utterance): string {
  return JSON.stringify([
    settingsKey,
    u.transcript,
    u.voiceId,
    u.language ?? null,
    u.locale ?? null,
    u.generationConfig.emotion ?? null,
    u.generationConfig.speed ?? null,
    u.generationConfig.volume ?? null,
  ]);
}

/** A stored value back as a clip, or null when it is not one this code wrote. */
export function clipFromStore(value: unknown): Clip | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Partial<StoredClip>;
  if (s.v !== 1 || !(s.pcm instanceof Uint8Array) || s.pcm.byteLength === 0) return null;
  if (typeof s.durationMs !== 'number' || !(s.durationMs > 0) || !Array.isArray(s.words)) return null;
  if (typeof s.encoding !== 'string' || typeof s.sampleRate !== 'number' || typeof s.kind !== 'string') return null;
  return {
    contextId: 'stored',
    kind: s.kind,
    pcm: s.pcm,
    encoding: s.encoding,
    sampleRate: s.sampleRate,
    durationMs: s.durationMs,
    words: s.words,
    firstAudioMs: 0,
    totalMs: 0,
  };
}

export function clipToStore(clip: Clip): StoredClip {
  return {
    v: 1,
    kind: clip.kind,
    pcm: clip.pcm,
    encoding: clip.encoding,
    sampleRate: clip.sampleRate,
    durationMs: clip.durationMs,
    words: clip.words,
  };
}

/** The player behind `PhraseCache`, answering from the store first and storing what it voices. */
export function persistentSynth(player: Synthesizer, store: ClipStore | null): Synthesizer {
  if (!store) return player;
  return {
    settingsKey: () => player.settingsKey(),
    async synthesize(u: Utterance): Promise<Clip> {
      const key = phraseStoreKey(player.settingsKey(), u);
      try {
        const stored = clipFromStore(await store.get(key));
        if (stored) return stored;
      } catch {
        // A storage that cannot be read: voice it.
      }
      const clip = await player.synthesize(u);
      if (clip.durationMs > 0 && clip.pcm.byteLength > 0) {
        try {
          await store.put(key, clipToStore(clip));
        } catch {
          // Full or blocked: the clip still plays, it is only not kept.
        }
      }
      return clip;
    },
  };
}

/** IndexedDB in this browser, or null where there is none (a server render, a test, a blocked profile). */
export function indexedDbClipStore(factory: IDBFactory | undefined = typeof indexedDB !== 'undefined' ? indexedDB : undefined): ClipStore | null {
  if (!factory) return null;
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(PHRASE_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB did not open.'));
      request.onblocked = () => reject(new Error('IndexedDB is blocked.'));
    }).catch((error: unknown) => {
      opened = null;
      throw error;
    });
    return opened;
  };
  const run = <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest): Promise<T> =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(STORE, mode);
          const request = act(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(request.result as T);
          tx.onerror = () => reject(tx.error ?? new Error('IndexedDB failed.'));
          tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted.'));
        }),
    );
  return {
    get: (key) => run<unknown>('readonly', (s) => s.get(key)),
    put: (key, value) => run<undefined>('readwrite', (s) => s.put(value, key)).then(() => undefined),
  };
}
