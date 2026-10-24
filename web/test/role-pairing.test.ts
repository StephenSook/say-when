/**
 * The pairing state machine (lib/role/pairing.ts, docs/station.md 1.2, 1.3 and 7.2 C2), with plain events and no
 * network: a code and a request when there is no row, paired once the voice check agrees, expiry, the one retry on
 * `code taken`, revocation, the wrong role, and labels only from the fixed list.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  autoPairingLabel,
  formatPairingCode,
  initialPairingState,
  isPairingLabel,
  newPairingCode,
  PAIRING_LABELS,
  pairingStep,
  showsPairingCard,
  type DeviceRowLite,
  type PairingEvent,
  type PairingState,
  type PairingStep,
} from '../lib/role/pairing';
import type { DeviceRole } from '../lib/role/storage';

const ME = 'c2001234abcd';
const OTHER = 'c200ffff0000';

function row(identityHex: string, role: string, stamp = '1000', label = role): DeviceRowLite {
  return { identityHex, role, label, online: false, stamp };
}

/** Runs events in order and keeps every effect. */
function run(role: DeviceRole, events: PairingEvent[], start?: PairingState): { state: PairingState; effects: PairingStep['effects'][] } {
  let state = start ?? initialPairingState(role);
  const effects: PairingStep['effects'][] = [];
  for (const event of events) {
    const step = pairingStep(state, event);
    state = step.state;
    effects.push(step.effects);
  }
  return { state, effects };
}

const live: PairingEvent = { type: 'connection', identityHex: ME, live: true };

describe('the fixed labels', () => {
  test('station and speaker have one each; the partner phone picks from three', () => {
    assert.deepEqual(PAIRING_LABELS.station, ['station']);
    assert.deepEqual(PAIRING_LABELS.speaker, ['speaker']);
    assert.deepEqual(PAIRING_LABELS.partner, ['partner phone 1', 'partner phone 2', 'partner phone 3']);
    assert.equal(autoPairingLabel('station'), 'station');
    assert.equal(autoPairingLabel('partner'), null);
    assert.equal(isPairingLabel('partner', 'partner phone 2'), true);
    assert.equal(isPairingLabel('partner', "Leon's phone"), false);
    assert.equal(isPairingLabel('station', 'speaker'), false);
  });

  test('a label outside the list is never kept or sent', () => {
    const { state } = run('partner', [live, { type: 'rows', rows: [] }, { type: 'choose_label', label: 'Mum' }]);
    assert.equal(state.label, null);
    const bad = run('partner', [live, { type: 'rows', rows: [] }, { type: 'request', code: 482913, label: 'Mum' }]);
    assert.equal(bad.state.phase, 'error');
    assert.equal(bad.state.code, null);
    assert.equal(initialPairingState('partner', 'Mum').label, null);
  });
});

describe('the pairing code', () => {
  test('is 6 digits from 100000 to 999999, without modulo bias', () => {
    assert.equal(newPairingCode((a) => ((a[0] = 0), a)), 100_000);
    assert.equal(newPairingCode((a) => ((a[0] = 899_999), a)), 999_999);
    assert.equal(newPairingCode((a) => ((a[0] = 900_000), a)), 100_000);
    // A value in the biased tail is drawn again.
    let draws = 0;
    const code = newPairingCode((a) => {
      draws++;
      a[0] = draws === 1 ? 0xffff_ffff : 382_913;
      return a;
    });
    assert.equal(draws, 2);
    assert.equal(code, 482_913);
    for (let i = 0; i < 200; i++) {
      const random = newPairingCode();
      assert.ok(Number.isInteger(random) && random >= 100_000 && random <= 999_999, `${random}`);
    }
  });

  test('reads in two groups of three', () => {
    assert.equal(formatPairingCode(482913), '482 913');
    assert.equal(formatPairingCode(100000), '100 000');
  });
});

describe('a station with no device row', () => {
  test('asks for a code at once', () => {
    const { state, effects } = run('station', [live, { type: 'rows', rows: [row(OTHER, 'speaker')] }]);
    assert.deepEqual(effects[1], [{ type: 'send_request', fresh: true }]);
    assert.equal(state.phase, 'requesting');
    assert.equal(showsPairingCard(state.phase), true);
  });

  test('waits with the code, then expires it after pairing_ttl_ms', () => {
    const { state } = run('station', [
      live,
      { type: 'rows', rows: [] },
      { type: 'request', code: 482913, label: 'station' },
      { type: 'request_ok', code: 482913, at: 10_000, ttlMs: 300_000 },
    ]);
    assert.equal(state.phase, 'waiting');
    assert.equal(state.code, 482913);
    assert.equal(state.expiresAt, 310_000);
    assert.equal(pairingStep(state, { type: 'tick', at: 309_999 }).state.phase, 'waiting');
    const expired = pairingStep(state, { type: 'tick', at: 310_000 }).state;
    assert.equal(expired.phase, 'expired');
    // New code: a fresh request.
    const again = pairingStep(expired, { type: 'request', code: 123456, label: 'station' }).state;
    assert.equal(again.phase, 'requesting');
    assert.equal(again.code, 123456);
    assert.equal(again.expiresAt, null);
  });

  test('my row appearing starts the voice check, and the check makes it paired', () => {
    const waiting = run('station', [
      live,
      { type: 'rows', rows: [] },
      { type: 'request', code: 482913, label: 'station' },
      { type: 'request_ok', code: 482913, at: 0, ttlMs: 300_000 },
    ]).state;
    const appeared = pairingStep(waiting, { type: 'rows', rows: [row(ME, 'station', '5000')] });
    assert.equal(appeared.state.phase, 'checking');
    assert.deepEqual(appeared.effects, [{ type: 'check_voice' }]);
    const paired = pairingStep(appeared.state, { type: 'voice', outcome: 'ok', at: 1_000 }).state;
    assert.equal(paired.phase, 'paired');
    assert.equal(paired.code, null);
    assert.equal(showsPairingCard(paired.phase), false);
  });

  test('voice off (no Cartesia key) or a voice service problem is still paired', () => {
    for (const outcome of ['key_missing', 'service', 'bug'] as const) {
      const checking: PairingState = run('station', [live, { type: 'rows', rows: [row(ME, 'station')] }]).state;
      assert.equal(checking.phase, 'checking');
      const paired: PairingState = pairingStep(checking, { type: 'voice', outcome, at: 0 }).state;
      assert.equal(paired.phase, 'paired', outcome);
      assert.equal(paired.voice, outcome);
    }
  });

  test('a voice check that could not reach the module waits for the connection', () => {
    const checking = run('station', [live, { type: 'rows', rows: [row(ME, 'station')] }]).state;
    const offline = pairingStep({ ...checking, live: false }, { type: 'voice', outcome: 'offline', at: 0 });
    assert.equal(offline.state.phase, 'checking');
    assert.deepEqual(offline.effects, []);
    const back = pairingStep(offline.state, live);
    assert.deepEqual(back.effects, [{ type: 'check_voice' }]);
  });
});

describe('refusals of request_pairing', () => {
  const requesting = () =>
    run('station', [live, { type: 'rows', rows: [] }, { type: 'request', code: 482913, label: 'station' }]).state;

  test('code taken: one retry with a new code, then an error', () => {
    const first = pairingStep(requesting(), { type: 'request_failed', code: 482913, kind: 'sender', message: 'code taken: pick a new code' });
    assert.deepEqual(first.effects, [{ type: 'send_request', fresh: true }]);
    const second = pairingStep(first.state, { type: 'request', code: 555555, label: 'station' }).state;
    const again = pairingStep(second, { type: 'request_failed', code: 555555, kind: 'sender', message: 'code taken: pick a new code' });
    assert.deepEqual(again.effects, []);
    assert.equal(again.state.phase, 'error');
    assert.match(again.state.errorText ?? '', /New code/);
  });

  test('already paired: read the row again through the voice check', () => {
    const step = pairingStep(requesting(), { type: 'request_failed', code: 482913, kind: 'sender', message: 'already paired' });
    assert.equal(step.state.phase, 'checking');
    assert.deepEqual(step.effects, [{ type: 'check_voice' }]);
  });

  test('a dropped connection sends the same code again once live', () => {
    const offline = pairingStep({ ...requesting(), live: false }, { type: 'request_failed', code: 482913, kind: 'disconnected', message: '' });
    assert.equal(offline.state.resendPending, true);
    assert.deepEqual(offline.effects, []);
    const back = pairingStep(offline.state, live);
    assert.deepEqual(back.effects, [{ type: 'send_request', fresh: false }]);
    // While the connection claims to be live, the resend waits a little.
    const unknown = pairingStep(requesting(), { type: 'request_failed', code: 482913, kind: 'unknown_result', message: '' });
    assert.deepEqual(unknown.effects, [{ type: 'send_request', fresh: false, delayMs: 2_000 }]);
  });

  test('any other refusal is shown as is', () => {
    const step = pairingStep(requesting(), { type: 'request_failed', code: 482913, kind: 'sender', message: 'label is longer than 40 characters' });
    assert.equal(step.state.phase, 'error');
    assert.equal(step.state.errorText, 'label is longer than 40 characters');
  });

  test('an answer for an old code is ignored', () => {
    const state = requesting();
    assert.equal(pairingStep(state, { type: 'request_ok', code: 111111, at: 0, ttlMs: 300_000 }).state, state);
  });
});

describe('revocation', () => {
  const paired = () => {
    const checking = run('station', [live, { type: 'rows', rows: [row(ME, 'station', '1000')] }]).state;
    return pairingStep(checking, { type: 'voice', outcome: 'ok', at: 0 }).state;
  };

  test('a reducer refused with not allowed shows the card again with a new code', () => {
    const step = pairingStep(paired(), { type: 'not_allowed' });
    assert.equal(step.state.revokedBefore, true);
    assert.equal(step.state.phase, 'requesting');
    assert.deepEqual(step.effects, [{ type: 'send_request', fresh: true }]);
    assert.equal(step.state.staleStamp, '1000');
  });

  test('the mint saying not_paired_for_purpose on load is a revocation', () => {
    const checking = run('station', [live, { type: 'rows', rows: [row(ME, 'station', '1000')] }]).state;
    const step = pairingStep(checking, { type: 'voice', outcome: 'not_paired', at: 0 });
    assert.equal(step.state.revokedBefore, true);
    assert.deepEqual(step.effects, [{ type: 'send_request', fresh: true }]);
  });

  test('the stale row does not count; a re-approval rewrites it and pairs again', () => {
    let state = pairingStep(paired(), { type: 'not_allowed' }).state;
    state = pairingStep(state, { type: 'request', code: 482913, label: 'station' }).state;
    state = pairingStep(state, { type: 'request_ok', code: 482913, at: 0, ttlMs: 300_000 }).state;
    // The same revoked row again (online flips do not change the stamp after a revoke): still waiting.
    const same = pairingStep(state, { type: 'rows', rows: [row(ME, 'station', '1000')] });
    assert.equal(same.state.phase, 'waiting');
    assert.deepEqual(same.effects, []);
    // approve_pairing writes the row with a new last_seen_at.
    const approved = pairingStep(state, { type: 'rows', rows: [row(ME, 'station', '2000')] });
    assert.equal(approved.state.phase, 'checking');
    const done = pairingStep(approved.state, { type: 'voice', outcome: 'ok', at: 1 }).state;
    assert.equal(done.phase, 'paired');
    assert.equal(done.revokedBefore, false);
  });

  test('a check that still says not paired while the code is good keeps waiting', () => {
    let state = pairingStep(paired(), { type: 'not_allowed' }).state;
    state = pairingStep(state, { type: 'request', code: 482913, label: 'station' }).state;
    state = pairingStep(state, { type: 'request_ok', code: 482913, at: 0, ttlMs: 300_000 }).state;
    state = pairingStep(state, { type: 'rows', rows: [row(ME, 'station', '3000')] }).state;
    const step = pairingStep(state, { type: 'voice', outcome: 'not_paired', at: 1_000 });
    assert.equal(step.state.phase, 'waiting');
    assert.equal(step.state.code, 482913);
    assert.deepEqual(step.effects, []);
  });

  test('the partner phone does not ask on its own after a revocation', () => {
    const checking = run('partner', [live, { type: 'rows', rows: [row(ME, 'partner', '1000', 'partner phone 1')] }]).state;
    const pairedPhone = pairingStep(checking, { type: 'voice', outcome: 'ok', at: 0 }).state;
    const step = pairingStep(pairedPhone, { type: 'not_allowed' });
    assert.equal(step.state.phase, 'revoked');
    assert.deepEqual(step.effects, []);
  });
});

describe('roles', () => {
  test("another role's row for this identity is the wrong role", () => {
    const { state, effects } = run('station', [live, { type: 'rows', rows: [row(ME, 'speaker')] }]);
    assert.equal(state.phase, 'wrong_role');
    assert.equal(state.pairedRole, 'speaker');
    assert.deepEqual(effects[1], []);
  });

  test('the partner phone waits for a label before asking', () => {
    const { state, effects } = run('partner', [live, { type: 'rows', rows: [] }]);
    assert.equal(state.phase, 'unpaired');
    assert.deepEqual(effects[1], []);
    const chosen = pairingStep(state, { type: 'choose_label', label: 'partner phone 2' }).state;
    assert.equal(chosen.label, 'partner phone 2');
    const asked = pairingStep(chosen, { type: 'request', code: 482913, label: 'partner phone 2' }).state;
    assert.equal(asked.phase, 'requesting');
  });

  test('a station that is not live yet asks as soon as it is', () => {
    const offline = { type: 'connection', identityHex: ME, live: false } as const;
    let state = run('station', [live, { type: 'rows', rows: [row(ME, 'station')] }]).state;
    state = pairingStep(state, { type: 'voice', outcome: 'ok', at: 0 }).state;
    state = pairingStep(state, offline).state;
    const lost = pairingStep(state, { type: 'not_allowed' });
    assert.equal(lost.state.resendPending, true);
    assert.deepEqual(lost.effects, []);
    const back = pairingStep(lost.state, live);
    assert.deepEqual(back.effects, [{ type: 'send_request', fresh: true }]);
  });
});
