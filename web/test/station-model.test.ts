/**
 * The station screen's words (lib/station/model.ts, docs/station.md 2.2, 2.3, 2.10, 2.14 and 7.3 A1), from fixed
 * snapshots: every setup step and session state, the honest input labels, the pause sentences, and words that follow
 * the room's sharing toggle.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { initialPairingState } from '../lib/role/pairing';
import type { CommandEntry } from '../lib/station/commands';
import {
  bigStatus,
  commandRows,
  DECODER_PERMISSION_NOTE,
  decoderNotes,
  earpieceHero,
  heartbeatChip,
  inputBanner,
  inputChip,
  keyboardLegend,
  lastWorkLine,
  pauseSentence,
  SESSION_LABEL_RE,
  sessionLabel,
  sessionLine,
  setupSteps,
  startBlocker,
  timingLine,
  tuningNotes,
} from '../lib/station/model';
import type { ScanView, StationSnapshot } from '../lib/station/snapshot';

const NOW = 1_700_000_000_000;

function base(patch: Partial<StationSnapshot> = {}): StationSnapshot {
  return {
    hasSettings: true,
    cliTarget: { server: 'maincloud', db: 'say-when-dev' },
    connection: { status: 'live', ready: true, identityHex: 'c200', problem: null, errorText: null, since: 0, tokenSaved: true },
    pairing: { ...initialPairingState('station'), phase: 'paired' },
    voice: { status: 'ready', at: 0 },
    audio: { state: 'running', errorText: null, startedAt: 0, deviceChangedAt: null, wakeLock: 'held', latencyMs: 30 },
    setup: { mode: 'headset', purpose: 'demo', silent: false, port: 8765, switchKey: null, learningSwitch: false, assistantSpeed: null, optionSpeed: null },
    decoder: { word: 'healthy', port: 8765, badMessages: 0, idsReplaced: 0, recentBad: false, recentIdReplaced: false, errorText: null, slowConnect: false },
    inputHealthy: true,
    visible: true,
    focused: true,
    phrases: { ready: 34, failed: 0, total: 34, warming: false },
    config: { shareText: false, heartbeatMs: 500, idlePauseMs: 120_000, menuEnabled: true, yesNoCueMs: 900, replyVetoMs: 700, audioPadMs: 150 },
    session: { id: null, ownership: 'none', label: null, error: null, questionId: null, questionText: '', origin: null },
    scan: null,
    options: [
      { optionId: 11n, rank: 1, text: 'Tea please', tone: 'calm', kind: 'Reply', ready: true },
      { optionId: 12n, rank: 2, text: 'Send the care team a request', tone: 'warm', kind: 'Errand', ready: true },
    ],
    earpiece: { readyCount: 2, optionCount: 2, synthesizing: null, lagMedianMs: 80, nowPlaying: null, waitingFor: null, wordTimingsOff: false, yesNoPromptMs: null },
    playing: null,
    readback: { phase: 'idle', kind: null, id: null, windowStartedAt: null, windowMs: 8_000, message: null, windowStartedWall: null },
    work: { errand: null, call: null },
    commands: [],
    heartbeat: { armed: false, intervalMs: 500, beats: 0, lastHealthy: null, lastOkAt: null, problem: false, rttMedianMs: null, refusedText: null },
    stale: false,
    keysOffAt: null,
    lastCue: null,
    voiceDown: false,
    ...patch,
  };
}

function scan(patch: Partial<ScanView>): ScanView {
  return { phase: 'reading', mode: 'answer', answerMode: 'pick', cursor: 2, optionCount: 2, pass: 1, maxPasses: 2, stepMs: 3_000, arrivedWall: NOW - 1_000, pauseReason: null, pickedRank: null, ...patch };
}

const running = (patch: Partial<StationSnapshot> = {}) =>
  base({ session: { id: 7n, ownership: 'mine', label: 'headset-demo', error: null, questionId: 3n, questionText: 'Which drink?', origin: 'partner' }, ...patch });

describe('honest input labels', () => {
  test('the keyboard and the switch say they are not headset signals; the headset says nothing extra', () => {
    assert.equal(inputBanner(base()), null);
    assert.equal(inputBanner(base({ setup: { ...base().setup, mode: 'keyboard' } })), 'Keyboard test input. These are key presses, not headset signals.');
    assert.equal(inputBanner(base({ setup: { ...base().setup, mode: 'switch' } })), 'USB switch input. These are switch presses, not headset signals.');
    assert.match(inputBanner(base({ setup: { ...base().setup, mode: 'keyboard', silent: true } })) ?? '', /Silent test: options are not voiced\.$/);
    assert.equal(keyboardLegend(base({ setup: { ...base().setup, mode: 'keyboard' } })), 'Y = YES   N = NO   C = CONFIRM   S = STOP   H = headset off (test)');
    assert.equal(keyboardLegend(base()), null);
  });

  test('session labels: keyboard is always a test; labels pass the module check', () => {
    assert.equal(sessionLabel('keyboard', 'demo'), 'keyboard-test');
    assert.equal(sessionLabel('headset', 'demo'), 'headset-demo');
    assert.equal(sessionLabel('switch', 'test'), 'switch-test');
    for (const label of ['keyboard-test', 'headset-demo', 'headset-test', 'switch-demo', 'switch-test']) assert.ok(SESSION_LABEL_RE.test(label));
  });

  test('the decoder chip words', () => {
    const chip = (word: 'healthy' | 'not_ready' | 'silent' | 'not_found' | 'connecting') => inputChip(base({ decoder: { ...base().decoder!, word } })).words;
    assert.equal(chip('healthy'), 'Decoder healthy');
    assert.equal(chip('not_ready'), 'Decoder says the headset is not ready');
    assert.equal(chip('silent'), 'Decoder silent');
    assert.equal(chip('not_found'), 'Decoder not found on 127.0.0.1:8765');
    assert.equal(inputChip(base({ setup: { ...base().setup, mode: 'keyboard' }, visible: false })).words, 'Input off: page hidden');
    assert.equal(inputChip(base({ setup: { ...base().setup, mode: 'switch' } })).words, 'Switch key not learned');
  });
});

describe('before a session', () => {
  test('every setup step done, Start session allowed', () => {
    assert.ok(setupSteps(base()).every((step) => step.status === 'done'));
    assert.equal(startBlocker(base()), null);
    assert.equal(bigStatus(base(), NOW).title, 'No session running');
    assert.equal(bigStatus(base(), NOW).sentence, 'Ready to start.');
  });

  test('a missing decoder blocks Start session with the way out', () => {
    const s = base({ decoder: { ...base().decoder!, word: 'not_found' } });
    assert.equal(startBlocker(s), 'Start the decoder, or switch to keyboard test.');
  });

  test('a missing voice key blocks a voiced session; keyboard mode points to the silent test', () => {
    const voice = { status: 'problem' as const, problem: 'key_missing' as const, code: 'voice_key_missing', words: 'Voice off: the database has no Cartesia key.', at: 0 };
    assert.equal(startBlocker(base({ voice })), 'Voice off: the database has no Cartesia key.');
    assert.match(startBlocker(base({ voice, setup: { ...base().setup, mode: 'keyboard' } })) ?? '', /silent test works without it/);
    const silent = base({ voice, setup: { ...base().setup, mode: 'keyboard', silent: true }, audio: { ...base().audio, state: 'locked' }, phrases: { ready: 0, failed: 0, total: 0, warming: false } });
    assert.equal(startBlocker(silent), null, 'the silent keyboard test needs no voice, audio or phrases');
  });

  test('audio and phrases block until ready', () => {
    assert.equal(startBlocker(base({ audio: { ...base().audio, state: 'locked' } })), 'Press Start audio.');
    assert.equal(startBlocker(base({ phrases: { ready: 12, failed: 0, total: 34, warming: true } })), 'Waiting for the phrases.');
    assert.equal(setupSteps(base({ phrases: { ready: 12, failed: 0, total: 34, warming: true } })).find((s) => s.key === 'phrases')?.label, 'Phrases 12 of 34');
  });

  test('an active session this page did not start offers Continue; another station owns it says so with the command', () => {
    const active = base({ session: { ...base().session, id: 7n } });
    assert.equal(bigStatus(active, NOW).title, 'Session 7 is active.');
    const other = base({ session: { ...base().session, id: 7n, ownership: 'other' } });
    const status = bigStatus(other, NOW);
    assert.equal(status.title, 'This session belongs to another station.');
    assert.equal(status.command, 'spacetime call --no-config --server maincloud say-when-dev end_session');
    assert.equal(status.status, 'failed');
  });

  test('not paired, offline and no database come first', () => {
    assert.equal(bigStatus(base({ pairing: initialPairingState('station') }), NOW).title, 'Not paired');
    assert.equal(bigStatus(base({ connection: { ...base().connection, status: 'offline' } }), NOW).title, 'Not connected');
    assert.equal(bigStatus(base({ hasSettings: false }), NOW).title, 'No database is set up for this page.');
  });
});

describe('during a session', () => {
  test('reading, window, veto, preparing, idle', () => {
    assert.equal(bigStatus(running({ scan: scan({ phase: 'reading' }) }), NOW).title, 'Reading option 2 of 2');
    assert.equal(bigStatus(running({ scan: scan({ phase: 'window' }) }), NOW).title, 'Window open for option 2 of 2');
    assert.equal(bigStatus(running({ scan: scan({ phase: 'reading', answerMode: 'yes_no', cursor: 0 }) }), NOW).title, 'Reading: Yes or no?');
    assert.equal(bigStatus(running({ scan: scan({ phase: 'reading', mode: 'menu', cursor: 3, optionCount: 4 }) }), NOW).title, 'Reading menu item 3 of 4');
    const veto = bigStatus(running({ scan: scan({ phase: 'veto', stepMs: 700, arrivedWall: NOW, pickedRank: 2 }) }), NOW);
    assert.equal(veto.title, 'Picked option 2. Saying it in 0.7 s.');
    assert.equal(veto.sentence, 'NO or STOP cancels.');
    assert.equal(bigStatus(running({ scan: scan({ phase: 'preparing' }) }), NOW).title, 'Getting options ready');
    assert.equal(bigStatus(running({ scan: scan({ phase: 'idle' }) }), NOW).sentence, "YES opens the person's menu.");
  });

  test('every pause reason has its sentence; a helper pause shows the owner command', () => {
    assert.equal(pauseSentence('stop', 'headset', 120_000), 'Paused. YES resumes.');
    assert.equal(pauseSentence('idle', 'headset', 120_000), 'Paused after 2 minutes. YES resumes.');
    assert.equal(pauseSentence('headset_off', 'headset', 120_000), 'Headset off. Nothing will be sent.');
    assert.equal(pauseSentence('headset_off', 'keyboard', 120_000), 'Input off. Nothing will be sent.');
    assert.equal(pauseSentence('headset_lost', 'switch', 120_000), 'Signal lost. Nothing will be sent.');
    const helper = bigStatus(running({ scan: scan({ phase: 'paused', pauseReason: 'operator' }) }), NOW);
    assert.equal(helper.title, 'Paused by a helper. Only the owner can resume.');
    assert.equal(helper.command, 'spacetime call --no-config --server maincloud say-when-dev operator_resume');
    assert.equal(helper.status, 'stopped', 'a pause is never drawn as a failure');
  });

  test('read-back states, and a window that runs out is stopped, not failed', () => {
    const rb = (phase: StationSnapshot['readback']['phase'], extra: Partial<StationSnapshot['readback']> = {}) =>
      bigStatus(running({ readback: { ...base().readback, phase, ...extra } }), NOW);
    assert.equal(rb('playing').title, 'Reading it back');
    assert.equal(rb('hold').title, 'Waiting for your confirm');
    assert.equal(rb('window', { windowStartedWall: NOW - 3_000 }).sentence, '5.0 s left. Silence sends nothing.');
    assert.equal(rb('window', { windowStartedWall: NOW - 3_000 }).status, 'waiting');
    assert.equal(rb('too_long').status, 'stopped');
    assert.equal(rb('late').title, 'Not sent: the read-back took too long.');
  });

  test('a stale link says nothing will be sent', () => {
    const s = bigStatus(running({ stale: true, scan: scan({}) }), NOW);
    assert.equal(s.title, 'Connection lost. Nothing will be sent.');
  });

  test('the earpiece hero shows option words only while sharing is on', () => {
    const off = earpieceHero(running({ scan: scan({ phase: 'reading', cursor: 2 }) }), NOW);
    assert.equal(off.title, 'Option 2 of 2, warm, a request');
    assert.equal(off.words, null);
    const on = earpieceHero(running({ scan: scan({ phase: 'reading', cursor: 1 }), config: { ...base().config!, shareText: true } }), NOW);
    assert.equal(on.title, 'Option 1 of 2, calm');
    assert.equal(on.words, 'Tea please');
    assert.equal(on.bar?.label, 'Reading the option');
    const window = earpieceHero(running({ scan: scan({ phase: 'window', stepMs: 3_000, arrivedWall: NOW - 1_000 }) }), NOW);
    assert.equal(window.bar?.valueText, 'window, 2.0 s left');
    const silent = earpieceHero(running({ setup: { ...base().setup, mode: 'keyboard', silent: true }, scan: scan({ phase: 'reading', cursor: 1 }) }), NOW);
    assert.equal(silent.title, 'Option 1, not voiced');
    assert.equal(silent.note, 'Silent test: options are not voiced.');
  });

  test('the last errand line says the reason only while sharing is on', () => {
    const work = { errand: { status: 'Refused', formTitle: 'Dinner', reason: 'Calls to Leon are on hold.' }, call: null };
    assert.equal(lastWorkLine(running({ work })), 'Last request: Not sent.');
    assert.equal(lastWorkLine(running({ work, config: { ...base().config!, shareText: true } })), 'Last request: Not sent. Calls to Leon are on hold.');
  });

  test('command rows: the source in words, ignored is muted, HEADSET_OFF from a key is labeled a test', () => {
    const entry = (patch: Partial<CommandEntry>): CommandEntry => ({
      gestureId: 'g',
      command: 'YES',
      source: 'key',
      via: 'key',
      at: NOW,
      status: 'accepted',
      words: 'Picked option 2',
      outcome: 'accepted:pick',
      idReplaced: false,
      errorText: null,
      ...patch,
    });
    const rows = commandRows([
      entry({ gestureId: 'a' }),
      entry({ gestureId: 'b', status: 'ignored', words: 'Ignored: Repeat inside the refractory time' }),
      entry({ gestureId: 'c', command: 'HEADSET_OFF' }),
      entry({ gestureId: 'd', source: 'jaw', via: 'decoder', idReplaced: true }),
    ]);
    assert.equal(rows[0]!.status, 'done');
    assert.equal(rows[1]!.status, 'stopped');
    assert.equal(rows[2]!.command, 'HEADSET_OFF (test)');
    assert.equal(rows[3]!.source, 'jaw');
    assert.equal(rows[3]!.note, 'Decoder id replaced');
  });

  test('timing notes for the owner: start lag over audio_pad_ms, a long yes or no prompt, no word timings', () => {
    assert.deepEqual(tuningNotes(running()), []);
    const notes = tuningNotes(running({ earpiece: { ...base().earpiece, lagMedianMs: 210, yesNoPromptMs: 1_100, wordTimingsOff: true } }));
    assert.equal(notes[0], 'Earpiece start lag 210 ms is over audio_pad_ms 150. The owner raises audio_pad_ms with set_timing.');
    assert.equal(notes[1], 'The "Yes or no?" prompt is 1100 ms, longer than yes_no_cue_ms 900. The owner raises it to 1250 with set_timing.');
    assert.equal(notes.length, 3);
  });

  test('the session, heartbeat and timing lines', () => {
    assert.equal(sessionLine(running()), 'Session 7, headset-demo, running.');
    const hb = { armed: true, intervalMs: 500, beats: 10, lastHealthy: true, lastOkAt: 1, problem: false, rttMedianMs: 95, refusedText: null };
    assert.equal(timingLine(running({ heartbeat: hb })), 'Heartbeat every 500 ms. Module round trip 95 ms. Earpiece start lag 80 ms.');
    assert.equal(heartbeatChip(running({ heartbeat: hb })).words, 'Heartbeat on');
    assert.equal(heartbeatChip(running({ heartbeat: { ...hb, problem: true } })).words, 'Connection problem');
  });
});

describe('the decoder permission hint (docs/station.md 5.1)', () => {
  const decoder = (patch: Partial<NonNullable<StationSnapshot['decoder']>>) =>
    ({ word: 'connecting', port: 8765, badMessages: 0, idsReplaced: 0, recentBad: false, recentIdReplaced: false, errorText: null, slowConnect: false, ...patch }) as const;

  test('shown only while the first socket has been connecting for 3 s', () => {
    assert.deepEqual(decoderNotes({ decoder: decoder({}) }), []);
    assert.deepEqual(decoderNotes({ decoder: decoder({ slowConnect: true }) }), [DECODER_PERMISSION_NOTE]);
    assert.deepEqual(decoderNotes({ decoder: decoder({ slowConnect: true, word: 'healthy' }) }), []);
    assert.deepEqual(decoderNotes({ decoder: null }), []);
    assert.match(DECODER_PERMISSION_NOTE, /click Allow/);
  });
});
