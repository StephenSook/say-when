/**
 * The words on the shared device parts (components/device/model.ts): the pairing card for every phase, the voice
 * status, the role connection and the audio tap. Every state has a word and a mark; a revocation or an expired code
 * is never drawn as a failure; the code and the owner's command appear only while a code waits.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  audioView,
  codeTimeLeft,
  EARPIECE_LABELS,
  pairingCardView,
  roleConnectionView,
  ROOM_VOICE_LABELS,
  runStatusChip,
  shortIdentity,
  voiceView,
} from '../components/device/model';
import type { RoleConnectionState } from '../lib/role/connection';
import { initialPairingState, type PairingPhase, type PairingState } from '../lib/role/pairing';
import type { AudioStartState, AudioUnlockSnapshot } from '../lib/voice/audio';

const SETTINGS = { host: 'https://maincloud.spacetimedb.com', db: 'say-when-dev' };
const NOW = 1_000_000;

function pairing(patch: Partial<PairingState>, role: 'station' | 'speaker' | 'partner' = 'station'): PairingState {
  return { ...initialPairingState(role), identityHex: 'c200aabbccddeeff00112233', ...patch };
}

const PHASES: PairingPhase[] = ['connecting', 'unpaired', 'requesting', 'waiting', 'expired', 'checking', 'paired', 'revoked', 'wrong_role', 'error'];

describe('the pairing card', () => {
  test('every phase has a title and a mark, for every role', () => {
    for (const role of ['station', 'speaker', 'partner'] as const) {
      for (const phase of PHASES) {
        const view = pairingCardView(pairing({ phase, code: 482913, expiresAt: NOW + 60_000, pairedRole: 'speaker', errorText: 'x' }, role), SETTINGS, NOW);
        assert.ok(view.title.length > 0, `${role} ${phase} title`);
        assert.ok(view.statusWord.length > 0, `${role} ${phase} word`);
      }
    }
  });

  test('waiting shows the code in two groups, the time left and the owner command', () => {
    const view = pairingCardView(pairing({ phase: 'waiting', code: 482913, expiresAt: NOW + 272_400 }), SETTINGS, NOW);
    assert.equal(view.codeText, '482 913');
    assert.equal(view.timeLeft, '4:33 left');
    assert.equal(view.command, 'spacetime call --no-config --server maincloud say-when-dev approve_pairing 482913 false');
    assert.equal(view.status, 'waiting');
    assert.equal(view.commandNote, null);
    assert.equal(view.action?.label, 'New code');
  });

  test('the partner phone is told how the caregiver phone differs', () => {
    const view = pairingCardView(pairing({ phase: 'waiting', code: 482913, expiresAt: NOW + 1_000, label: 'partner phone 1' }, 'partner'), SETTINGS, NOW);
    assert.match(view.commandNote ?? '', /true instead of false/);
  });

  test('no code or command outside waiting', () => {
    for (const phase of PHASES.filter((p) => p !== 'waiting')) {
      const view = pairingCardView(pairing({ phase, code: 482913, expiresAt: NOW + 60_000 }), SETTINGS, NOW);
      assert.equal(view.codeText, null, phase);
      assert.equal(view.command, null, phase);
    }
  });

  test('an expired code and a revocation are stopped, not failed', () => {
    assert.equal(pairingCardView(pairing({ phase: 'expired' }), SETTINGS, NOW).status, 'stopped');
    const revoked = pairingCardView(pairing({ phase: 'revoked', revokedBefore: true }), SETTINGS, NOW);
    assert.equal(revoked.status, 'stopped');
    assert.equal(revoked.title, 'This device is not paired anymore.');
    const waitingAgain = pairingCardView(pairing({ phase: 'waiting', revokedBefore: true, code: 111111, expiresAt: NOW + 5_000 }), SETTINGS, NOW);
    assert.match(waitingAgain.sentence ?? '', /^This device is not paired anymore\./);
  });

  test('the wrong role uses the sentence from docs/station.md 1.2', () => {
    const view = pairingCardView(pairing({ phase: 'wrong_role', pairedRole: 'speaker' }), SETTINGS, NOW);
    assert.equal(view.title, "This browser's station identity is paired as speaker.");
    assert.equal(view.sentence, 'Ask the owner to revoke it, or forget this device.');
    assert.equal(view.status, 'failed');
  });

  test('the partner phone picks a label before Get a code works', () => {
    const none = pairingCardView(pairing({ phase: 'unpaired', label: null }, 'partner'), SETTINGS, NOW);
    assert.equal(none.showLabelPicker, true);
    assert.deepEqual(none.labels, ['partner phone 1', 'partner phone 2', 'partner phone 3']);
    assert.equal(none.action?.label, 'Get a code');
    assert.equal(none.action?.disabled, true);
    const picked = pairingCardView(pairing({ phase: 'unpaired', label: 'partner phone 3' }, 'partner'), SETTINGS, NOW);
    assert.equal(picked.action?.disabled, false);
    // The station never shows a picker or asks a person to press anything to get its code.
    const station = pairingCardView(pairing({ phase: 'unpaired' }), SETTINGS, NOW);
    assert.equal(station.showLabelPicker, false);
    assert.equal(station.action, null);
  });

  test('the device id is shortened on screen; the revoke command carries the full id', () => {
    const view = pairingCardView(pairing({ phase: 'waiting', code: 482913, expiresAt: NOW }), SETTINGS, NOW);
    assert.equal(view.identityShort, '0xc200aabb');
    assert.equal(view.revoke, 'spacetime call --no-config --server maincloud say-when-dev revoke_device 0xc200aabbccddeeff00112233');
    assert.equal(shortIdentity(null), null);
    assert.equal(shortIdentity('0xABCDEF0123'), '0xABCDEF01');
  });

  test('time left rounds up and never goes below zero; nothing before the clock starts', () => {
    assert.equal(codeTimeLeft(NOW + 300_000, NOW), '5:00 left');
    assert.equal(codeTimeLeft(NOW + 1, NOW), '0:01 left');
    assert.equal(codeTimeLeft(NOW - 5_000, NOW), '0:00 left');
    assert.equal(codeTimeLeft(NOW + 1_000, 0), null, 'the server render reads 0');
    assert.equal(codeTimeLeft(null, NOW), null);
  });
});

describe('a status as a chip', () => {
  test('each docs/ui.md status has its own mark and color, and refused or stopped is never red', () => {
    assert.deepEqual(runStatusChip('waiting', 'Waiting'), { words: 'Waiting', tone: 'wait', lead: 'hourglass' });
    assert.deepEqual(runStatusChip('done', 'Done'), { words: 'Done', tone: 'accent', lead: 'check' });
    assert.deepEqual(runStatusChip('failed', 'Failed'), { words: 'Failed', tone: 'error', lead: 'cross' });
    assert.equal(runStatusChip('working', 'Working').lead, 'spinner');
    assert.equal(runStatusChip('not_started', 'Not started').lead, 'ring');
    for (const status of ['stopped', 'refused'] as const) assert.equal(runStatusChip(status, 'x').tone, 'muted');
  });
});

describe('the voice status', () => {
  test('words, marks and Retry for each answer', () => {
    assert.deepEqual(voiceView({ status: 'ready', at: 1 }), { words: 'Voice ready', tone: 'accent', lead: 'check', retry: false, code: null });
    assert.equal(voiceView({ status: 'checking' }).lead, 'spinner');
    assert.equal(voiceView({ status: 'unknown' }).words, 'Voice not checked');
    const key = voiceView({ status: 'problem', problem: 'key_missing', code: 'voice_key_missing', words: 'Voice off: the database has no Cartesia key.', at: 1 });
    assert.equal(key.words, 'Voice off: the database has no Cartesia key.');
    assert.equal(key.tone, 'error');
    assert.equal(key.lead, 'cross');
    assert.equal(key.retry, true);
    const service = voiceView({ status: 'problem', problem: 'service', code: 'voice_service_429', words: 'Voice service problem (voice_service_429).', at: 1 });
    assert.equal(service.retry, true);
    assert.equal(service.code, 'voice_service_429');
    const revoked = voiceView({ status: 'problem', problem: 'not_paired', code: 'not_paired_for_purpose', words: 'This device is not paired anymore.', at: 1 });
    assert.equal(revoked.tone, 'muted', 'not paired is not a failure');
  });
});

describe('the role connection', () => {
  const base: RoleConnectionState = { status: 'live', ready: true, identityHex: 'c200', problem: null, errorText: null, since: 0, tokenSaved: true };

  test('Live, Connecting, Reconnecting and Offline, each with a word and a mark', () => {
    assert.deepEqual(roleConnectionView(base), { words: 'Live', tone: 'live', lead: 'dot', sentence: null, forget: false });
    assert.equal(roleConnectionView({ ...base, status: 'connecting' }).lead, 'spinner');
    assert.equal(roleConnectionView({ ...base, status: 'reconnecting' }).sentence, 'Showing the last known state');
    const offline = roleConnectionView({ ...base, status: 'offline', problem: 'network' });
    assert.equal(offline.words, 'Offline');
    assert.equal(offline.sentence, 'Not connected. Check the network.');
  });

  test('a refused saved token offers Forget this device', () => {
    const view = roleConnectionView({ ...base, status: 'offline', problem: 'token_rejected' });
    assert.equal(view.forget, true);
    assert.match(view.sentence ?? '', /Forget this device/);
  });

  test('a browser that will not keep the token says a reload needs a new code', () => {
    assert.match(roleConnectionView({ ...base, tokenSaved: false }).sentence ?? '', /reload will need a new code/);
  });
});

describe('the audio tap', () => {
  const snap = (state: AudioStartState): AudioUnlockSnapshot => ({ state, errorText: null, startedAt: null, deviceChangedAt: null, wakeLock: 'off', latencyMs: 0 });

  test('a button whenever a tap is needed, none while running', () => {
    assert.equal(audioView(snap('locked')).button, 'Start audio');
    assert.equal(audioView(snap('suspended')).button, 'Start audio');
    assert.equal(audioView(snap('device_changed')).button, 'Start audio');
    assert.equal(audioView(snap('starting')).buttonDisabled, true);
    assert.equal(audioView(snap('running')).button, null);
    assert.equal(audioView(snap('running')).words, EARPIECE_LABELS.running);
    assert.equal(audioView(snap('failed')).button, 'Try again');
    assert.equal(audioView(snap('unsupported')).button, null);
  });

  test('the speaker page says room voice', () => {
    assert.equal(audioView(snap('locked'), ROOM_VOICE_LABELS).button, 'Start room voice');
    assert.equal(audioView(snap('running'), ROOM_VOICE_LABELS).words, 'Room voice on');
  });

  test('a device change is stopped, not failed, and says what to check', () => {
    const view = audioView(snap('device_changed'));
    assert.equal(view.status, 'stopped');
    assert.match(view.sentence ?? '', /earpiece/);
  });
});

describe('the owner command wraps only between words', () => {
  test('each word is one inline block, so --server and say-when-dev never split across lines', () => {
    const tsx = readFileSync(join(process.cwd(), 'components', 'device', 'PairingCard.tsx'), 'utf8');
    const css = readFileSync(join(process.cwd(), 'components', 'device', 'PairingCard.module.css'), 'utf8');
    assert.match(tsx, /view\.command\.split\(' '\)\.map/);
    assert.match(tsx, /className=\{styles\.commandWord\}/);
    const rule = /\.commandWord\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(rule, /display:\s*inline-block/);
    assert.match(rule, /max-width:\s*100%/);
  });
});
