/**
 * A paired page's device (lib/role/device.ts): the pairing machine's effects run against a fake connection. The
 * station asks for a code by itself, waits for the owner, is paired once its row appears and the voice check
 * answers, goes back to the card when a call is refused with `not allowed`, and Forget removes only its token.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SenderError } from 'spacetimedb';
import { tables } from '../lib/data/module_bindings';
import { approveCommand, cliServer, createRoleDevice, deviceRowLite, revokeCommand } from '../lib/role/device';
import { deviceStatusRow, FakeBuilder, FakeConnection, fakeTimers, flush, memoryStorage } from './role-fakes';

const SETTINGS = { host: 'https://maincloud.spacetimedb.com', db: 'say-when-dev' };
const ME = 'c200aaaa11112222';

function harness(role: 'station' | 'speaker' | 'partner', options: { codes?: number[]; ttlMs?: number } = {}) {
  const clock = fakeTimers();
  const storage = memoryStorage();
  const builders: FakeBuilder[] = [];
  const codes = [...(options.codes ?? [482913, 555555, 777777, 888888])];
  let reloads = 0;
  const device = createRoleDevice<any>({
    role,
    settings: SETTINGS,
    queries: [tables.scanState, tables.deviceStatus],
    builder: () => {
      const builder = new FakeBuilder(() => {
        const conn = new FakeConnection();
        conn.db.config.rows = [{ pairingTtlMs: options.ttlMs ?? 300_000 }];
        return conn;
      });
      builders.push(builder);
      return builder as any;
    },
    storage,
    drawCode: () => codes.shift() ?? 100000,
    reload: () => {
      reloads++;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const conn = () => builders[builders.length - 1]!.connection!;
  const connect = () => builders[builders.length - 1]!.connect(ME, 'secret-token');
  return { clock, storage, builders, device, conn, connect, reloads: () => reloads };
}

describe('the station device', () => {
  test('subscribes to device_status and config besides its own tables, without duplicates', () => {
    const h = harness('station');
    h.device.start();
    h.connect();
    const queries = h.conn().subscriptions[0]!.queries as unknown[];
    assert.equal(queries.length, 3);
    assert.ok(queries.includes(tables.deviceStatus));
    assert.ok(queries.includes(tables.config));
    assert.ok(queries.includes(tables.scanState));
    h.device.stop();
  });

  test('no row: asks with a random code, waits for the owner, then is paired by its row and the voice check', async () => {
    const h = harness('station', { ttlMs: 120_000 });
    h.device.start();
    h.connect();
    assert.deepEqual(h.conn().calls[0], { name: 'requestPairing', args: { code: 482913, role: 'station', label: 'station' } });
    await flush();
    let pairing = h.device.pairing.getState();
    assert.equal(pairing.phase, 'waiting');
    assert.equal(pairing.code, 482913);
    assert.equal(pairing.expiresAt, h.clock.now() + 120_000, 'the time left comes from config.pairing_ttl_ms');

    // The owner approves: approve_pairing writes my device_status row.
    h.conn().mintAnswer = async () => ({ token: '', expiresAtMs: 0n, error: 'voice_key_missing' });
    h.conn().db.deviceStatus.set([deviceStatusRow(ME, 'Station', 5_000n)]);
    assert.equal(h.device.pairing.getState().phase, 'checking');
    await flush();
    pairing = h.device.pairing.getState();
    assert.equal(pairing.phase, 'paired');
    assert.equal(h.device.isPaired(), true);
    assert.equal(pairing.voice, 'key_missing');
    const voice = h.device.voice.getState();
    assert.equal(voice.status === 'problem' && voice.words, 'Voice off: the database has no Cartesia key.');
    assert.deepEqual(
      h.conn().calls.filter((c) => c.name === 'mintVoiceToken').map((c) => c.args),
      [{ purpose: 'tts' }],
    );
    h.device.stop();
  });

  test('an identity that is already paired is paired again without a code (a reload)', async () => {
    const h = harness('station');
    h.device.start();
    h.conn().db.deviceStatus.rows = [deviceStatusRow(ME, 'Station', 9_000n)];
    h.conn().mintAnswer = async () => ({ token: 'tok', expiresAtMs: BigInt(h.clock.now() + 60_000), error: '' });
    h.connect();
    await flush();
    assert.equal(h.device.pairing.getState().phase, 'paired');
    assert.equal(h.conn().calls.filter((c) => c.name === 'requestPairing').length, 0);
    assert.equal(h.device.voice.getState().status, 'ready');
    h.device.stop();
  });

  test('the code runs out: Code expired, and New code asks again', async () => {
    const h = harness('station', { ttlMs: 60_000 });
    h.device.start();
    h.connect();
    await flush();
    h.clock.advance(60_100);
    assert.equal(h.device.pairing.getState().phase, 'expired');
    h.device.requestCode();
    await flush();
    const requests = h.conn().calls.filter((c) => c.name === 'requestPairing');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1]!.args, { code: 555555, role: 'station', label: 'station' });
    assert.equal(h.device.pairing.getState().phase, 'waiting');
    h.device.stop();
  });

  test('code taken: asks once more with a new code, then shows the error', async () => {
    const h = harness('station');
    h.device.start();
    h.conn().reducerAnswer = async () => {
      throw new SenderError('code taken: pick a new code');
    };
    h.connect();
    await flush();
    await flush();
    const codes = h.conn().calls.filter((c) => c.name === 'requestPairing').map((c) => (c.args as { code: number }).code);
    assert.deepEqual(codes, [482913, 555555]);
    assert.equal(h.device.pairing.getState().phase, 'error');
    h.device.stop();
  });

  test('a call refused with not allowed shows the card again with a new code', async () => {
    const h = harness('station');
    h.device.start();
    h.conn().db.deviceStatus.rows = [deviceStatusRow(ME, 'Station', 1_000n)];
    h.conn().mintAnswer = async () => ({ token: 'tok', expiresAtMs: 0n, error: '' });
    h.connect();
    await flush();
    assert.equal(h.device.pairing.getState().phase, 'paired');
    assert.equal(h.device.noteCallError(new SenderError('not allowed')), 'sender');
    await flush();
    const pairing = h.device.pairing.getState();
    assert.equal(pairing.revokedBefore, true);
    assert.equal(pairing.phase, 'waiting');
    assert.equal(h.conn().calls.filter((c) => c.name === 'requestPairing').length, 1);
    // Other refusals do not touch pairing.
    assert.equal(h.device.noteCallError(new SenderError('no active session')), 'sender');
    assert.equal(h.device.pairing.getState().phase, 'waiting');
    h.device.stop();
  });

  test('Forget removes this role token only, and reloads', () => {
    const h = harness('station');
    h.storage.setItem('https://maincloud.spacetimedb.com/say-when-dev/auth_token/speaker', 'speaker-token');
    h.device.start();
    h.connect();
    assert.equal(h.storage.items.get('https://maincloud.spacetimedb.com/say-when-dev/auth_token/station'), 'secret-token');
    h.device.forget();
    assert.equal(h.storage.items.has('https://maincloud.spacetimedb.com/say-when-dev/auth_token/station'), false);
    assert.equal(h.storage.items.get('https://maincloud.spacetimedb.com/say-when-dev/auth_token/speaker'), 'speaker-token');
    assert.equal(h.reloads(), 1);
  });

  test('stop clears every timer', async () => {
    const h = harness('station');
    h.device.start();
    h.connect();
    await flush();
    h.device.stop();
    assert.equal(h.clock.pending(), 0);
  });
});

describe('the partner phone device', () => {
  test('does not ask until a label is picked, then asks with that label and purpose stt', async () => {
    const h = harness('partner');
    h.device.start();
    h.connect();
    await flush();
    assert.equal(h.device.pairing.getState().phase, 'unpaired');
    assert.equal(h.conn().calls.length, 0);
    h.device.requestCode('partner phone 2');
    await flush();
    assert.deepEqual(h.conn().calls[0], { name: 'requestPairing', args: { code: 482913, role: 'partner', label: 'partner phone 2' } });
    h.conn().mintAnswer = async (purpose) => ({ token: purpose === 'stt' ? 'tok' : '', expiresAtMs: 0n, error: purpose === 'stt' ? '' : 'not_paired_for_purpose' });
    h.conn().db.deviceStatus.set([deviceStatusRow(ME, 'Partner', 2_000n, 'partner phone 2')]);
    await flush();
    assert.equal(h.device.pairing.getState().phase, 'paired');
    h.device.stop();
  });

  test('a label outside the fixed list is not sent', async () => {
    const h = harness('partner');
    h.device.start();
    h.connect();
    await flush();
    h.device.requestCode('Leon');
    await flush();
    assert.equal(h.conn().calls.length, 0);
    h.device.stop();
  });
});

describe('the owner commands and the row mapping', () => {
  test('approve and revoke commands name the server and database, never a token', () => {
    assert.equal(cliServer('https://maincloud.spacetimedb.com'), 'maincloud');
    assert.equal(cliServer('http://localhost:3000'), 'http://localhost:3000');
    assert.equal(approveCommand(SETTINGS, 482913), 'spacetime call --no-config --server maincloud say-when-dev approve_pairing 482913 false');
    assert.equal(approveCommand(SETTINGS, 482913, true), 'spacetime call --no-config --server maincloud say-when-dev approve_pairing 482913 true');
    assert.equal(revokeCommand(SETTINGS, 'c200ab'), 'spacetime call --no-config --server maincloud say-when-dev revoke_device 0xc200ab');
    assert.equal(revokeCommand(SETTINGS, '0xc200ab'), 'spacetime call --no-config --server maincloud say-when-dev revoke_device 0xc200ab');
  });

  test('a device_status row becomes plain values', () => {
    assert.deepEqual(deviceRowLite(deviceStatusRow('c200ab', 'Speaker', 123_456n)), {
      identityHex: 'c200ab',
      role: 'speaker',
      label: 'speaker',
      online: false,
      stamp: '123456',
    });
  });
});
