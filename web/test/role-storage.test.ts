/**
 * What the role pages keep in the browser (lib/role/storage.ts, docs/station.md 1.4 and 7.2 C1): the token key is
 * exactly `<host>/<db>/auth_token/<role>`, every access survives a storage that throws, and the setup values are
 * checked on the way in and on the way out.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_DECODER_PORT,
  forgetToken,
  readAssistantSpeed,
  readDecoderPort,
  readInputMode,
  readOptionSpeed,
  readReadQuestion,
  readReplyVolume,
  readSpeakerProgress,
  readSwitchKey,
  readToken,
  saveDecoderPort,
  saveInputMode,
  saveReadQuestion,
  saveReplyVolume,
  saveSpeakerProgress,
  saveSpeed,
  saveSwitchKey,
  saveToken,
  speakerProgressKey,
  STATION_KEYS,
  tokenKey,
  type StorageLike,
} from '../lib/role/storage';

const MAINCLOUD = { host: 'https://maincloud.spacetimedb.com', db: 'say-when-dev' };

function memoryStorage(): StorageLike & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

/** A private window: every access throws. */
const throwingStorage: StorageLike = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
};

describe('the identity token key', () => {
  test('is exactly <host>/<db>/auth_token/<role>', () => {
    assert.equal(tokenKey(MAINCLOUD, 'station'), 'https://maincloud.spacetimedb.com/say-when-dev/auth_token/station');
    assert.equal(tokenKey(MAINCLOUD, 'speaker'), 'https://maincloud.spacetimedb.com/say-when-dev/auth_token/speaker');
    assert.equal(tokenKey(MAINCLOUD, 'partner'), 'https://maincloud.spacetimedb.com/say-when-dev/auth_token/partner');
  });

  test('keeps the host exactly as set', () => {
    assert.equal(tokenKey({ host: 'http://localhost:3000', db: 'x' }, 'station'), 'http://localhost:3000/x/auth_token/station');
  });

  test('each role has its own token in one browser', () => {
    const storage = memoryStorage();
    assert.equal(saveToken(MAINCLOUD, 'station', 'token-a', storage), true);
    assert.equal(saveToken(MAINCLOUD, 'speaker', 'token-b', storage), true);
    assert.equal(readToken(MAINCLOUD, 'station', storage), 'token-a');
    assert.equal(readToken(MAINCLOUD, 'speaker', storage), 'token-b');
    assert.equal(readToken(MAINCLOUD, 'partner', storage), undefined);
  });

  test('forget removes only that role', () => {
    const storage = memoryStorage();
    saveToken(MAINCLOUD, 'station', 'token-a', storage);
    saveToken(MAINCLOUD, 'speaker', 'token-b', storage);
    assert.equal(forgetToken(MAINCLOUD, 'station', storage), true);
    assert.equal(readToken(MAINCLOUD, 'station', storage), undefined);
    assert.equal(readToken(MAINCLOUD, 'speaker', storage), 'token-b');
  });

  test('an empty value is no token, and an empty token is not saved', () => {
    const storage = memoryStorage();
    storage.setItem(tokenKey(MAINCLOUD, 'station'), '  ');
    assert.equal(readToken(MAINCLOUD, 'station', storage), undefined);
    assert.equal(saveToken(MAINCLOUD, 'station', '', storage), false);
  });

  test('a throwing storage never throws out', () => {
    assert.equal(readToken(MAINCLOUD, 'station', throwingStorage), undefined);
    assert.equal(saveToken(MAINCLOUD, 'station', 'token-a', throwingStorage), false);
    assert.equal(forgetToken(MAINCLOUD, 'station', throwingStorage), false);
    assert.equal(readToken(MAINCLOUD, 'station', null), undefined);
    assert.equal(saveToken(MAINCLOUD, 'station', 'token-a', null), false);
  });
});

describe('the station setup values', () => {
  test('decoder port: 8765 by default, whole numbers from 1 to 65535 only', () => {
    const storage = memoryStorage();
    assert.equal(readDecoderPort(storage), DEFAULT_DECODER_PORT);
    assert.equal(DEFAULT_DECODER_PORT, 8765);
    assert.equal(saveDecoderPort(9001, storage), true);
    assert.equal(storage.items.get('neurolingo/station/decoder_port'), '9001');
    assert.equal(readDecoderPort(storage), 9001);
    assert.equal(saveDecoderPort(0, storage), false);
    assert.equal(saveDecoderPort(70_000, storage), false);
    assert.equal(saveDecoderPort(80.5, storage), false);
    storage.items.set(STATION_KEYS.decoderPort, 'abc');
    assert.equal(readDecoderPort(storage), DEFAULT_DECODER_PORT);
    assert.equal(readDecoderPort(throwingStorage), DEFAULT_DECODER_PORT);
  });

  test('input mode, switch key and speeds', () => {
    const storage = memoryStorage();
    assert.equal(readInputMode(storage), null);
    assert.equal(saveInputMode('keyboard', storage), true);
    assert.equal(readInputMode(storage), 'keyboard');
    storage.items.set(STATION_KEYS.inputMode, 'brain');
    assert.equal(readInputMode(storage), null);

    assert.equal(saveSwitchKey('Space', storage), true);
    assert.equal(storage.items.get('neurolingo/station/switch_key'), 'Space');
    assert.equal(readSwitchKey(storage), 'Space');
    assert.equal(saveSwitchKey('<script>', storage), false);

    assert.equal(readAssistantSpeed(storage), null);
    assert.equal(saveSpeed('assistant', 0.8, storage), true);
    assert.equal(readAssistantSpeed(storage), 0.8);
    assert.equal(saveSpeed('option', 2, storage), false);
    assert.equal(saveSpeed('option', 1.2, storage), true);
    assert.equal(readOptionSpeed(storage), 1.2);
    assert.equal(saveSpeed('option', null, storage), true);
    assert.equal(readOptionSpeed(storage), null);
  });

  test("reading the partner's question in the earpiece is off unless turned on (Oct 25)", () => {
    const storage = memoryStorage();
    assert.equal(readReadQuestion(storage), false);
    storage.items.set('neurolingo/station/read_question', 'on');
    assert.equal(readReadQuestion(storage), false, 'an "on" saved under the old key is ignored');
    assert.equal(saveReadQuestion(true, storage), true);
    assert.equal(storage.items.get('neurolingo/station/read_question_v2'), 'on');
    assert.equal(readReadQuestion(storage), true);
    assert.equal(saveReadQuestion(false, storage), true);
    assert.equal(storage.items.get('neurolingo/station/read_question_v2'), 'off');
    assert.equal(readReadQuestion(storage), false);
    assert.equal(readReadQuestion(throwingStorage), false, 'a storage that throws keeps the default');
  });
});

describe('the speaker values', () => {
  test('volume from 0.5 to 2, default 1', () => {
    const storage = memoryStorage();
    assert.equal(readReplyVolume(storage), 1);
    assert.equal(saveReplyVolume(1.5, storage), true);
    assert.equal(readReplyVolume(storage), 1.5);
    assert.equal(saveReplyVolume(3, storage), false);
  });

  test('progress lives under neurolingo/speaker/<db>/last and survives a bad value', () => {
    const storage = memoryStorage();
    assert.equal(speakerProgressKey('say-when-dev'), 'neurolingo/speaker/say-when-dev/last');
    assert.equal(saveSpeakerProgress('say-when-dev', { questionId: '18446744073709551615', state: 'started' }, storage), true);
    assert.deepEqual(readSpeakerProgress('say-when-dev', storage), { questionId: '18446744073709551615', state: 'started' });
    storage.items.set(speakerProgressKey('say-when-dev'), '{not json');
    assert.equal(readSpeakerProgress('say-when-dev', storage), null);
    storage.items.set(speakerProgressKey('say-when-dev'), JSON.stringify({ questionId: 7, state: 'done' }));
    assert.equal(readSpeakerProgress('say-when-dev', storage), null);
    assert.equal(saveSpeakerProgress('say-when-dev', { questionId: '-1', state: 'done' }, storage), false);
    assert.equal(readSpeakerProgress('say-when-dev', throwingStorage), null);
  });
});
