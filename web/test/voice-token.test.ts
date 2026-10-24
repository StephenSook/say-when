/**
 * Cartesia access tokens from `mint_voice_token` (lib/voice/token.ts, docs/station.md 1.3, 1.4 and 7.2 C4): each
 * answer's words, a fresh token per socket, the voice check's spare token and its expiry, and no token ever in an
 * error message or on screen.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DisconnectedError, SenderError } from 'spacetimedb';
import {
  createVoiceTokenClient,
  mintVia,
  safeVoiceCode,
  VOICE_OFFLINE,
  VOICE_TOKEN_MIN_LIFE_MS,
  VOICE_TOKEN_TTL_MS,
  voiceProblemOf,
  voicePurposeFor,
  voiceWords,
  VoiceTokenError,
  type VoiceTokenRow,
} from '../lib/voice/token';

const T0 = 1_800_000_000_000;

function clock() {
  let now = T0;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

function minting(rows: Array<VoiceTokenRow | Error>) {
  const purposes: string[] = [];
  let i = 0;
  const mint = async (purpose: string): Promise<VoiceTokenRow> => {
    purposes.push(purpose);
    const next = rows[Math.min(i, rows.length - 1)]!;
    i++;
    if (next instanceof Error) throw next;
    return next;
  };
  return { mint, purposes, count: () => i };
}

const ok = (token: string, expiresAtMs: bigint = BigInt(T0 + 60_000)): VoiceTokenRow => ({ token, expiresAtMs, error: '' });
const err = (error: string): VoiceTokenRow => ({ token: '', expiresAtMs: 0n, error });

describe('the mint answers in words', () => {
  test('each code from docs/station.md 1.3', () => {
    assert.equal(voiceWords('not_paired_for_purpose'), 'This device is not paired anymore.');
    assert.equal(voiceWords('voice_key_missing'), 'Voice off: the database has no Cartesia key.');
    assert.equal(voiceWords('voice_service_unreachable'), 'Voice service problem (voice_service_unreachable).');
    assert.equal(voiceWords('voice_service_429'), 'Voice service problem (voice_service_429).');
    assert.equal(voiceWords('voice_bad_response'), 'Voice service problem (voice_bad_response).');
    assert.equal(voiceWords('bad_purpose'), 'Voice check failed (bad_purpose).');
    assert.equal(voiceWords(VOICE_OFFLINE), 'Voice check is waiting for the connection.');
  });

  test('problems by code', () => {
    assert.equal(voiceProblemOf('not_paired_for_purpose'), 'not_paired');
    assert.equal(voiceProblemOf('voice_key_missing'), 'key_missing');
    assert.equal(voiceProblemOf('voice_service_503'), 'service');
    assert.equal(voiceProblemOf('bad_purpose'), 'bug');
    assert.equal(voiceProblemOf(VOICE_OFFLINE), 'offline');
  });

  test('a code that is not short snake case is never shown', () => {
    assert.equal(safeVoiceCode('voice_service_500'), 'voice_service_500');
    assert.equal(safeVoiceCode('sk_car_0123 leaked key'), 'voice_bad_response');
    assert.equal(safeVoiceCode('sk_car_abc'), 'voice_bad_response');
    assert.equal(safeVoiceCode('not_paired_for_purpose'), 'not_paired_for_purpose');
    assert.equal(safeVoiceCode('<b>x</b>'), 'voice_bad_response');
    assert.equal(safeVoiceCode(undefined), 'voice_bad_response');
  });

  test('tts for the station and speaker, stt for the partner phone', () => {
    assert.equal(voicePurposeFor('station'), 'tts');
    assert.equal(voicePurposeFor('speaker'), 'tts');
    assert.equal(voicePurposeFor('partner'), 'stt');
  });
});

describe('the voice token client', () => {
  test('the voice check says Voice ready and keeps its token for the first socket only', async () => {
    const c = clock();
    const m = minting([ok('tok-1'), ok('tok-2'), ok('tok-3')]);
    const client = createVoiceTokenClient({ purpose: 'tts', mint: m.mint, now: c.now });
    assert.deepEqual(client.getState(), { status: 'unknown' });
    const state = await client.check();
    assert.equal(state.status, 'ready');
    assert.equal(await client.getToken(), 'tok-1', 'the check token opens the first socket');
    assert.equal(await client.getToken(), 'tok-2', 'every later socket gets a fresh token');
    assert.deepEqual(m.purposes, ['tts', 'tts']);
  });

  test('a spare token with less than 15 s left is not handed out', async () => {
    const c = clock();
    const m = minting([ok('tok-1'), ok('tok-2')]);
    const client = createVoiceTokenClient({ purpose: 'tts', mint: m.mint, now: c.now });
    await client.check();
    c.advance(VOICE_TOKEN_TTL_MS - VOICE_TOKEN_MIN_LIFE_MS + 1);
    assert.equal(await client.getToken(), 'tok-2');
  });

  test('the module expiry counts when it is earlier, and 60 s is the most a token gets', async () => {
    const c = clock();
    // The module says it ends in 20 s: after 6 s it has 14 s left, too little for a spare.
    const short = minting([ok('tok-1', BigInt(T0 + 20_000)), ok('tok-2')]);
    const a = createVoiceTokenClient({ purpose: 'tts', mint: short.mint, now: c.now });
    await a.check();
    c.advance(6_000);
    assert.equal(await a.getToken(), 'tok-2');

    // A module clock far ahead cannot stretch a token past 60 s.
    const c2 = clock();
    const long = minting([ok('tok-1', BigInt(T0 + 3_600_000)), ok('tok-2')]);
    const b = createVoiceTokenClient({ purpose: 'tts', mint: long.mint, now: c2.now });
    await b.check();
    c2.advance(50_000);
    assert.equal(await b.getToken(), 'tok-2');
  });

  test('a token minted just now is used even when the clocks disagree about its expiry', async () => {
    const c = clock();
    const m = minting([ok('tok-1', BigInt(T0 - 5_000))]);
    const client = createVoiceTokenClient({ purpose: 'stt', mint: m.mint, now: c.now });
    assert.equal(await client.getToken(), 'tok-1');
  });

  test('voice_key_missing: Voice off, and getToken rejects with the code', async () => {
    const m = minting([err('voice_key_missing')]);
    const client = createVoiceTokenClient({ purpose: 'tts', mint: m.mint });
    const state = await client.check();
    assert.equal(state.status, 'problem');
    assert.equal(state.status === 'problem' && state.words, 'Voice off: the database has no Cartesia key.');
    await assert.rejects(client.getToken(), (error: unknown) => error instanceof VoiceTokenError && error.code === 'voice_key_missing' && error.problem === 'key_missing');
  });

  test('not_paired_for_purpose tells pairing, and drops any spare', async () => {
    let told = 0;
    const m = minting([ok('tok-1'), err('not_paired_for_purpose')]);
    const client = createVoiceTokenClient({ purpose: 'tts', mint: m.mint, onNotPaired: () => told++ });
    await client.check();
    await client.check();
    assert.equal(told, 1);
    assert.equal(client.getState().status, 'problem');
    await assert.rejects(client.getToken(), (error: unknown) => error instanceof VoiceTokenError && error.problem === 'not_paired');
  });

  test('a call that never reached the module keeps the last real answer', async () => {
    const m = minting([ok('tok-1'), new DisconnectedError()]);
    const client = createVoiceTokenClient({ purpose: 'tts', mint: m.mint });
    await client.check();
    await client.getToken();
    await assert.rejects(client.getToken(), (error: unknown) => error instanceof VoiceTokenError && error.code === VOICE_OFFLINE);
    assert.equal(client.getState().status, 'ready');
  });

  test('a procedure that throws for another reason is a voice service problem', async () => {
    const m = minting([new SenderError('boom')]);
    const client = createVoiceTokenClient({ purpose: 'tts', mint: m.mint });
    const state = await client.check();
    assert.equal(state.status === 'problem' && state.code, 'voice_check_failed');
  });

  test('no token ever reaches an error message or the state', async () => {
    const m = minting([{ token: 'tok-SECRET', expiresAtMs: 0n, error: 'voice_service_500' }, { token: '', expiresAtMs: 0n, error: 'sk_car_LEAK' }]);
    const client = createVoiceTokenClient({ purpose: 'tts', mint: m.mint });
    await assert.rejects(client.getToken(), (error: unknown) => error instanceof Error && !error.message.includes('tok-SECRET'));
    await assert.rejects(client.getToken(), (error: unknown) => error instanceof VoiceTokenError && error.code === 'voice_bad_response' && !error.message.includes('sk_car'));
    assert.ok(!JSON.stringify(client.getState()).includes('tok-SECRET'));
    assert.ok(!JSON.stringify(client.getState()).includes('sk_car'));
  });

  test('checks in flight share one mint', async () => {
    const m = minting([ok('tok-1')]);
    const client = createVoiceTokenClient({ purpose: 'tts', mint: m.mint });
    const [a, b] = await Promise.all([client.check(), client.check()]);
    assert.equal(a, b);
    assert.equal(m.count(), 1);
  });

  test('clear() drops the spare token', async () => {
    const m = minting([ok('tok-1'), ok('tok-2')]);
    const client = createVoiceTokenClient({ purpose: 'tts', mint: m.mint });
    await client.check();
    client.clear();
    assert.equal(await client.getToken(), 'tok-2');
  });

  test('mintVia: no connection is a DisconnectedError, and the procedure gets the purpose', async () => {
    await assert.rejects(mintVia(() => null)('tts'), (error: unknown) => error instanceof Error && error.name === 'DisconnectedError');
    const seen: unknown[] = [];
    const conn = {
      procedures: {
        mintVoiceToken: async (args: { purpose: string }) => {
          seen.push(args);
          return ok('tok-1');
        },
      },
    };
    assert.deepEqual(await mintVia(() => conn)('stt'), ok('tok-1'));
    assert.deepEqual(seen, [{ purpose: 'stt' }]);
  });
});
