// Short credentialed hops (D12 item 5): the database mints 60-second Cartesia tokens for paired browsers.
// The harness cannot read module env vars (`env_get` is a host call it does not provide), so the key path is
// tested through `mintWithKey`, and the procedure is tested up to the point it would read the key.
import { expect, test } from 'vitest';
import { buildMintRequest as cartesiaBuildMintRequest } from '../../../cartesia/src/token';
import * as m from '../index';
import { buildMintRequest, mintWithKey } from '../voice';
import { AGENT, auth, newDb, OWNER, PARTNER, SPEAKER, STATION, type Test } from './harness';

type Responder = Parameters<ReturnType<Test['procedureContextBuilder']>['http']>[0];

function ctxFor(db: Test, subject: string, responder: Responder) {
  return db.procedureContextBuilder(auth(subject)).http(responder).build();
}

const neverCalled: Responder = () => {
  throw new Error('the procedure must not call out');
};

function answer(code: number, body: string): Responder {
  return () => ({ code, headers: { entries: [] }, version: { tag: 'Http11' as const }, body });
}

test('the request shape matches the cartesia package exactly', () => {
  for (const purpose of ['tts', 'stt'] as const) {
    const ours = buildMintRequest('sk_test_key', purpose, 60);
    const theirs = cartesiaBuildMintRequest('sk_test_key', purpose, 60);
    expect(ours.url).toBe(theirs.url);
    expect(ours.method).toBe(theirs.method);
    expect(ours.headers).toEqual(theirs.headers);
    expect(ours.body).toBe(theirs.body);
  }
});

test('a token request carries exactly one grant, never the agent grant, and a 60 s expiry', () => {
  const db = newDb();
  const seen: Array<{ uri: string; body: string }> = [];
  const ctx = ctxFor(db, STATION, (_t, req, body) => {
    seen.push({ uri: req.uri, body: new TextDecoder().decode(body) });
    return { code: 200, headers: { entries: [] }, version: { tag: 'Http11' }, body: JSON.stringify({ token: 'tok_abc' }) };
  });
  const out = mintWithKey(ctx, 'sk_test_key', 'tts');
  expect(out.error).toBe('');
  expect(out.token).toBe('tok_abc');
  expect(out.expiresAtMs).toBe(BigInt(Number(db.clock.now().toMillis()) + 60_000));
  expect(seen).toHaveLength(1);
  expect(seen[0]!.uri).toBe('https://api.cartesia.ai/access-token');
  expect(JSON.parse(seen[0]!.body)).toEqual({ grants: { tts: true, stt: false, agent: false }, expires_in: 60 });
});

test('errors are codes, never the key, the token or the body', () => {
  const db = newDb();
  const denied = mintWithKey(ctxFor(db, STATION, answer(401, 'invalid key sk_test_key')), 'sk_test_key', 'stt');
  expect(denied).toEqual({ token: '', expiresAtMs: 0n, error: 'voice_service_401' });
  const garbled = mintWithKey(ctxFor(db, STATION, answer(200, 'not json')), 'sk_test_key', 'stt');
  expect(garbled.error).toBe('voice_bad_response');
  const down = mintWithKey(ctxFor(db, STATION, () => { throw new Error('connection reset'); }), 'sk_test_key', 'stt');
  expect(down.error).toBe('voice_service_unreachable');
});

test('mint_voice_token refuses a device that is not paired for the purpose, without calling out', () => {
  const db = newDb();
  expect(m.mintVoiceToken(ctxFor(db, PARTNER, neverCalled), { purpose: 'tts' }).error).toBe('not_paired_for_purpose');
  expect(m.mintVoiceToken(ctxFor(db, STATION, neverCalled), { purpose: 'stt' }).error).toBe('not_paired_for_purpose');
  expect(m.mintVoiceToken(ctxFor(db, AGENT, neverCalled), { purpose: 'tts' }).error).toBe('not_paired_for_purpose');
  expect(m.mintVoiceToken(ctxFor(db, 'stranger', neverCalled), { purpose: 'stt' }).error).toBe('not_paired_for_purpose');
  expect(m.mintVoiceToken(ctxFor(db, SPEAKER, neverCalled), { purpose: 'both' }).error).toBe('bad_purpose');
});

test('a paired device reaches the key check (the harness has no env, so it reports the key missing)', () => {
  const db = newDb();
  expect(m.mintVoiceToken(ctxFor(db, SPEAKER, neverCalled), { purpose: 'tts' }).error).toBe('voice_key_missing');
  expect(m.mintVoiceToken(ctxFor(db, PARTNER, neverCalled), { purpose: 'stt' }).error).toBe('voice_key_missing');
});

test('smoke_fetch is owner-only and reports the status it got', () => {
  const db = newDb();
  expect(m.smokeFetch(ctxFor(db, PARTNER, neverCalled), { url: 'https://api.cartesia.ai' }).error).toBe('owner only');
  const out = m.smokeFetch(ctxFor(db, OWNER, answer(404, '')), { url: 'https://api.cartesia.ai' });
  expect([out.status, out.error]).toEqual([404, '']);
});
