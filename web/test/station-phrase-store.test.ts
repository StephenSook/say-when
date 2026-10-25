/**
 * Stock phrase audio kept across page loads (lib/station/phrase-store.ts): the key matches PhraseCache's, a second
 * load voices nothing it already has, a stored value this code did not write is voiced again, and a storage that
 * cannot be read or written never fails a phrase.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PhraseCache, type Clip } from '../lib/cartesia/tts';
import { utterance, voiceProfile, type Utterance } from '../lib/cartesia/tones';
import { clipFromStore, clipToStore, indexedDbClipStore, persistentSynth, phraseStoreKey, type ClipStore, type StoredClip, type Synthesizer } from '../lib/station/phrase-store';
import { isMenuItemText, MENU_ITEM_TEXTS } from '../lib/station/phrases';

function fakeClip(u: Utterance, durationMs = 900): Clip {
  return {
    contextId: `ctx-${u.transcript}`,
    kind: u.kind,
    pcm: new Uint8Array([1, 2, 3, 4]),
    encoding: 'pcm_s16le',
    sampleRate: 24_000,
    durationMs,
    words: [{ word: 'Paused.', startMs: 0, endMs: 400 }],
    firstAudioMs: 120,
    totalMs: 300,
  } as Clip;
}

function fakePlayer(settings = '["sonic","pcm_s16le",24000,null]', durationMs = 900): Synthesizer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    settingsKey: () => settings,
    synthesize: async (u) => {
      calls.push(u.transcript);
      return fakeClip(u, durationMs);
    },
  };
}

function mapStore(): ClipStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key) => map.get(key),
    put: async (key, value) => {
      map.set(key, structuredClone(value));
    },
  };
}

const profile = voiceProfile({ assistantSpeed: 0.85 });
const phrases = [
  utterance({ kind: 'prompt', text: 'Paused. Nothing will be sent.' }, profile),
  utterance({ kind: 'prompt', text: 'Yes or no?' }, profile),
  utterance({ kind: 'option', text: 'I need something', tone: '', laugh: false }, profile),
  utterance({ kind: 'option', text: 'Tea, please.', tone: 'warm', laugh: false }, voiceProfile({ optionSpeed: 1.2 })),
];

describe('the phrase store key', () => {
  test('is exactly the key PhraseCache uses, for prompts, menu items and a toned option', () => {
    const player = fakePlayer();
    const cache = new PhraseCache(player);
    for (const u of phrases) assert.equal(phraseStoreKey(player.settingsKey(), u), cache.key(u));
  });

  test('changes with the voice settings, so a new model, format or dictionary voices again', () => {
    const u = phrases[0];
    assert.notEqual(phraseStoreKey('["a"]', u), phraseStoreKey('["b"]', u));
    assert.notEqual(phraseStoreKey('["a"]', phrases[0]), phraseStoreKey('["a"]', phrases[1]));
  });
});

describe('a reload', () => {
  test('voices each phrase once on the first load and none on the second', async () => {
    const store = mapStore();
    const first = fakePlayer();
    const cacheA = new PhraseCache(persistentSynth(first, store));
    assert.deepEqual(await cacheA.warm(phrases), { ready: 4, failed: 0 });
    assert.equal(first.calls.length, 4);
    assert.equal(store.map.size, 4);

    const second = fakePlayer();
    const cacheB = new PhraseCache(persistentSynth(second, store));
    assert.deepEqual(await cacheB.warm(phrases), { ready: 4, failed: 0 });
    assert.equal(second.calls.length, 0, 'no credits spent on the reload');
    const clip = await cacheB.get(phrases[0]);
    assert.equal(clip.durationMs, 900);
    assert.deepEqual([...clip.pcm], [1, 2, 3, 4]);
    assert.equal(clip.words[0]?.word, 'Paused.');
  });

  test('a different voice speed is voiced again, not taken from the store', async () => {
    const store = mapStore();
    await new PhraseCache(persistentSynth(fakePlayer(), store)).warm([phrases[0]]);
    const faster = utterance({ kind: 'prompt', text: 'Paused. Nothing will be sent.' }, voiceProfile({ assistantSpeed: 1.3 }));
    const player = fakePlayer();
    await new PhraseCache(persistentSynth(player, store)).get(faster);
    assert.equal(player.calls.length, 1);
  });

  test('keeps only the audio and its timings', async () => {
    const store = mapStore();
    await persistentSynth(fakePlayer(), store).synthesize(phrases[0]);
    const kept = [...store.map.values()][0] as StoredClip;
    assert.deepEqual(Object.keys(kept).sort(), ['durationMs', 'encoding', 'kind', 'pcm', 'sampleRate', 'v', 'words']);
  });

  test('an empty clip is not kept', async () => {
    const store = mapStore();
    await persistentSynth(fakePlayer(undefined, 0), store).synthesize(phrases[0]);
    assert.equal(store.map.size, 0);
  });
});

describe('a storage that misbehaves never fails a phrase', () => {
  test('a read that throws voices the phrase', async () => {
    const player = fakePlayer();
    const synth = persistentSynth(player, { get: async () => Promise.reject(new Error('blocked')), put: async () => {} });
    assert.equal((await synth.synthesize(phrases[0])).durationMs, 900);
    assert.equal(player.calls.length, 1);
  });

  test('a write that throws still returns the clip', async () => {
    const synth = persistentSynth(fakePlayer(), { get: async () => undefined, put: async () => Promise.reject(new Error('quota')) });
    assert.equal((await synth.synthesize(phrases[0])).durationMs, 900);
  });

  test('a value this code did not write is voiced again', async () => {
    for (const bad of [null, 'x', { v: 2 }, { v: 1, pcm: [1, 2], durationMs: 900, words: [], encoding: 'pcm_s16le', sampleRate: 24000, kind: 'prompt' }, { ...clipToStore(fakeClip(phrases[0])), durationMs: 0 }, { ...clipToStore(fakeClip(phrases[0])), pcm: new Uint8Array() }]) {
      assert.equal(clipFromStore(bad), null);
      const player = fakePlayer();
      await persistentSynth(player, { get: async () => bad, put: async () => {} }).synthesize(phrases[0]);
      assert.equal(player.calls.length, 1);
    }
  });

  test('no store at all is the plain player', () => {
    const player = fakePlayer();
    assert.equal(persistentSynth(player, null), player);
    assert.equal(indexedDbClipStore(undefined), null);
  });
});

describe('menu rows', () => {
  test('only the four module menu items go through the phrase cache and its store', () => {
    for (const text of MENU_ITEM_TEXTS) assert.equal(isMenuItemText(text), true);
    for (const text of ['Call Sam about the lunch', 'I need something now', 'call', '']) assert.equal(isMenuItemText(text), false, text);
  });
});
