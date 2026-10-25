import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  cancelPick,
  COMMAND_INFO,
  commandChipLabel,
  commandPhrase,
  commandWord,
  CONFIRM_PROMPT,
  CONFIRM_SHORT,
  confirmPick,
  gestureLegend,
  JAW_LANE_LEGEND,
  legendLine,
  optionBadge,
  optionLabel,
} from '../lib/commands';
import {
  COMMAND_ECHO_MS,
  hitDisplay,
  latestByStage,
  latestOfStage,
  latestOptions,
  litCommand,
  optionUnderCursor,
  pickedOption,
  scanProgress,
  spokenReply,
  timeToFirstOption,
  wordIndexAt,
} from '../lib/data/derive';
import { replayRowsAt } from '../lib/data/replay';
import { isCommand, parseDetail, timestampToMillis, withoutMemoryText } from '../lib/data/spacetime-map';
import {
  COMMANDS,
  PERSON_COMMANDS,
  pickCommand,
  pickRank,
  type AnswerOption,
  type CommandEvent,
  type MossHit,
  type PipelineEvent,
  type Question,
  type ScanState,
} from '../lib/data/types';
import { callStatusWord, statusFromCall, statusFromErrand, statusFromPipeline, STATUS_WORDS } from '../lib/status';

const START = Date.UTC(2026, 9, 24, 19, 40, 0);

function option(partial: Partial<AnswerOption> & Pick<AnswerOption, 'id' | 'version' | 'rank'>): AnswerOption {
  return { questionId: 'q', text: partial.id, kind: 'reply', tone: null, sources: [], ...partial };
}

function command(partial: Partial<CommandEvent> & Pick<CommandEvent, 'id' | 'command' | 'at'>): CommandEvent {
  return { accepted: true, ignoredReason: null, confidence: 0.9, questionId: 'q', optionId: null, ...partial };
}

describe('option helpers', () => {
  test('latestOptions keeps the newest version of one question, in rank order', () => {
    const options = [
      option({ id: 'a2', version: 1, rank: 2 }),
      option({ id: 'a1', version: 1, rank: 1 }),
      option({ id: 'b2', version: 2, rank: 2 }),
      option({ id: 'b1', version: 2, rank: 1 }),
      option({ id: 'other', version: 9, rank: 1, questionId: 'q-other' }),
    ];
    assert.deepEqual(
      latestOptions(options, 'q').map((o) => o.id),
      ['b1', 'b2'],
    );
    assert.deepEqual(latestOptions(options, null), []);
    assert.deepEqual(latestOptions(options, 'missing'), []);
  });

  test('optionUnderCursor follows the scan only while an option is read (D18: the wait is on no option); pickedOption follows the pick', () => {
    const options = [option({ id: 'v1r1', version: 1, rank: 1 }), option({ id: 'v1r2', version: 1, rank: 2 })];
    const scan: ScanState = {
      questionId: 'q',
      version: 1,
      mode: 'answer',
      answerMode: 'pick',
      phase: 'reading',
      cursor: 2,
      stepStartedAt: 1_000,
      stepEndsAt: 3_000,
      pass: 1,
      maxPasses: 2,
      outcome: null,
      pickedOptionId: null,
    };
    assert.equal(optionUnderCursor(scan, options)?.id, 'v1r2');
    assert.equal(optionUnderCursor({ ...scan, phase: 'window' }, options), null, 'the wait after the list is for any number');
    assert.equal(optionUnderCursor({ ...scan, outcome: 'none', cursor: null }, options), null);
    assert.equal(optionUnderCursor({ ...scan, phase: 'veto', pickedOptionId: 'v1r2' }, options), null, 'nothing new plays in the veto');
    assert.equal(optionUnderCursor({ ...scan, phase: 'paused' }, options), null);
    assert.equal(pickedOption(scan, options), null);
    assert.equal(pickedOption({ ...scan, phase: 'veto', pickedOptionId: 'v1r2' }, options)?.id, 'v1r2', 'known during the veto');
    assert.equal(pickedOption({ ...scan, phase: 'idle', outcome: 'picked', pickedOptionId: 'v1r2' }, options)?.id, 'v1r2');
    assert.equal(scanProgress(scan, 2_000), 0.5);
    assert.equal(scanProgress(scan, 9_000), 1);
    assert.equal(scanProgress(scan, 0), 0);
  });
});

describe('stage helpers', () => {
  const rows = replayRowsAt(START, START + 4_330);
  const events = rows.pipelineEvents;

  test('latestByStage gives each stage its newest event', () => {
    const latest = latestByStage(events);
    assert.equal(latest.listen?.status, 'ok');
    assert.equal(latest.search?.status, 'ok');
    assert.equal(latest.retrieve?.status, 'started');
    assert.equal(latest.plan, undefined);
    assert.equal(latest.search?.detail.rows?.length, 6);
  });

  test('latestOfStage is typed for its detail', () => {
    const search = latestOfStage(events, 'search');
    assert.equal(search?.detail.searches, 2);
    assert.equal(latestOfStage(events, 'call'), null);
  });

  test('time to the first option needs both Heard and the first earpiece read', () => {
    assert.equal(timeToFirstOption(events), null);
    const heard: PipelineEvent = { id: 'l', sessionId: 's', questionId: 'q', stage: 'listen', status: 'ok', detail: {}, ms: 400, at: 10_000 };
    const aloud: PipelineEvent = { id: 'a', sessionId: 's', questionId: 'q', stage: 'speak', status: 'started', detail: { channel: 'aloud' }, ms: null, at: 11_000 };
    const read: PipelineEvent = { id: 'r', sessionId: 's', questionId: 'q', stage: 'speak', status: 'started', detail: { channel: 'earpiece' }, ms: null, at: 12_500 };
    assert.equal(timeToFirstOption([heard, aloud, read]), 2_500);
  });

  test('spokenReply reads the released reply from the question row', () => {
    const question: Question = {
      id: 'q',
      sessionId: 's',
      number: 1,
      text: 'Where to?',
      via: 'voice',
      origin: 'partner',
      askedAt: 1_000,
      replyText: null,
      spokenAt: null,
    };
    assert.equal(spokenReply(null), null);
    assert.equal(spokenReply(question), null, 'nothing before YES and the veto');
    assert.equal(spokenReply({ ...question, replyText: '   ' }), null);
    assert.deepEqual(spokenReply({ ...question, replyText: 'Yes, the cafe.' }), { text: 'Yes, the cafe.', spokenAt: null });
    assert.deepEqual(spokenReply({ ...question, replyText: 'Yes, the cafe.', spokenAt: 4_200 }), { text: 'Yes, the cafe.', spokenAt: 4_200 });
  });

  test('wordIndexAt marks the last word that has started', () => {
    const words = [
      { word: 'The', startMs: 0, endMs: 260 },
      { word: 'cafe', startMs: 300, endMs: 560 },
      { word: 'on', startMs: 600, endMs: 860 },
    ];
    assert.equal(wordIndexAt(words, -5), -1);
    assert.equal(wordIndexAt(words, 0), 0);
    assert.equal(wordIndexAt(words, 450), 1);
    assert.equal(wordIndexAt(words, 5_000), 2);
  });
});

describe('command echo', () => {
  test('litCommand lights the newest accepted person command for 1.2 s', () => {
    const commands = [command({ id: 'c1', command: 'PICK_1', at: 1_000 }), command({ id: 'c2', command: 'PICK_3', at: 5_000 })];
    assert.equal(COMMAND_ECHO_MS, 1_200);
    assert.equal(litCommand(commands, 5_000), 'PICK_3');
    assert.equal(litCommand(commands, 6_199), 'PICK_3');
    assert.equal(litCommand(commands, 6_200), null);
    assert.equal(litCommand(commands, 4_700), 'PICK_3', 'stamped slightly ahead of this clock: just arrived');
    assert.equal(litCommand(commands, 1_500), 'PICK_3', 'only the newest command matters, never an older one');
    assert.equal(litCommand([], 0), null);
  });

  test('ignored repeats and HEADSET_OFF never light a chip', () => {
    const ignored = [command({ id: 'c1', command: 'PICK_2', at: 1_000, accepted: false, ignoredReason: 'Repeat inside the refractory time' })];
    assert.equal(litCommand(ignored, 1_100), null);
    const headsetOff = [command({ id: 'c1', command: 'STOP', at: 1_000 }), command({ id: 'c2', command: 'HEADSET_OFF', at: 1_100, confidence: null })];
    assert.equal(litCommand(headsetOff, 1_200), 'STOP');
  });
});

describe('the direct select command map (D18)', () => {
  test('the person gives four picks and STOP; HEADSET_OFF is a system event', () => {
    assert.deepEqual(PERSON_COMMANDS, ['PICK_1', 'PICK_2', 'PICK_3', 'PICK_4', 'STOP']);
    assert.deepEqual(COMMANDS, ['PICK_1', 'PICK_2', 'PICK_3', 'PICK_4', 'STOP', 'HEADSET_OFF']);
    assert.equal(COMMAND_INFO.HEADSET_OFF.kind, 'system');
    assert.equal(COMMAND_INFO.PICK_1.kind, 'imagined');
    assert.equal(COMMAND_INFO.PICK_2.kind, 'imagined');
    assert.equal(COMMAND_INFO.PICK_3.kind, 'jaw');
    assert.equal(COMMAND_INFO.PICK_4.kind, 'jaw');
    assert.equal(COMMAND_INFO.STOP.kind, 'jaw');
    assert.deepEqual([pickRank('PICK_3'), pickRank('STOP'), pickCommand(4), pickCommand(5)], [3, null, 'PICK_4', null]);
  });

  test('chip labels and feed words: one legend for every screen', () => {
    assert.deepEqual(PERSON_COMMANDS.map((name) => commandChipLabel(name, 'headset')), [
      '1, imagined left fist',
      '2, imagined right fist',
      '3, single jaw clench',
      '4, double jaw clench',
      'STOP, long jaw clench',
    ]);
    assert.deepEqual(gestureLegend('headset').map((row) => `${row.label} = ${row.signal}`), [
      '1 = imagined left fist',
      '2 = imagined right fist',
      '3 = single jaw clench',
      '4 = double jaw clench',
      'STOP = long jaw clench',
    ]);
    assert.equal(legendLine('keyboard'), '1 = key 1 · 2 = key 2 · 3 = key 3 · 4 = key 4 · STOP = key S');
    assert.equal(JAW_LANE_LEGEND, '3 single / 4 double / long = STOP');
    assert.equal(CONFIRM_PROMPT, 'One: send it. Two: cancel.');
    assert.equal(CONFIRM_SHORT, '1 to send, 2 to cancel');
    assert.equal(confirmPick('headset'), '1 (an imagined left fist)');
    assert.equal(confirmPick('keyboard'), '1 (key 1)');
    assert.equal(confirmPick('unknown'), '1');
    assert.equal(cancelPick('switch'), '2 (a double switch press)');
    assert.equal(commandWord('HEADSET_OFF', 'headset'), 'Headset off');
    assert.equal(commandWord('PICK_3', 'headset'), '3');
    assert.equal(commandPhrase('PICK_3', 'headset'), 'Pick 3');
    assert.equal(commandWord('STOP', 'headset'), 'STOP');
    assert.equal(optionBadge(2), '2');
    assert.equal(optionBadge(5), '');
    assert.equal(optionLabel({ label: 'Good', text: "I'm doing awesome" }), 'Good');
    assert.equal(optionLabel({ label: '', text: "I'm doing awesome" }), "I'm doing awesome");
  });

  test('the mapping accepts only the direct select names; the scan words are retired here', () => {
    for (const name of COMMANDS) assert.ok(isCommand(name), name);
    for (const retired of ['SELECT', 'ERRAND', 'CALL', 'PAUSE', 'YES', 'NO', 'CONFIRM', 'pick_1', '']) assert.equal(isCommand(retired), false, retired);
  });
});

describe('memory privacy', () => {
  const memory: MossHit = { id: 'm1', origin: 'memory', memoryType: 'pref', score: 0.8 };

  test('a private memory reads "Private memory" with its category', () => {
    assert.deepEqual(hitDisplay(memory), { text: 'Private memory', isPrivate: true, origin: 'memory', category: 'Preference' });
    assert.equal(hitDisplay({ ...memory, memoryType: 'reply' }).category, 'Past reply');
    assert.equal(hitDisplay({ ...memory, memoryType: undefined }).category, 'Memory');
  });

  test('a shared memory shows its sharedText', () => {
    assert.deepEqual(hitDisplay({ ...memory, sharedText: 'Likes quiet places.' }), {
      text: 'Likes quiet places.',
      isPrivate: false,
      origin: 'memory',
      category: 'Preference',
    });
    assert.equal(hitDisplay({ ...memory, sharedText: '   ' }).text, 'Private memory', 'blank shared text stays private');
  });

  test('a memory never shows a `text` field, even if a mapping bug fills it', () => {
    assert.equal(hitDisplay({ ...memory, text: 'Should never show' }).text, 'Private memory');
    assert.equal(hitDisplay({ ...memory, origin: 'unknown' as MossHit['origin'], text: 'Should never show' }).text, 'Private memory');
  });

  test('a web hit shows its text', () => {
    assert.deepEqual(hitDisplay({ id: 'w1', origin: 'web', score: 0.6, text: 'Cafe on Bay St has a ramp' }), {
      text: 'Cafe on Bay St has a ramp',
      isPrivate: false,
      origin: 'web',
      category: null,
    });
  });

  test('the SpacetimeDB mapping drops memory text before any screen sees it', () => {
    const detail = withoutMemoryText({
      hits: [
        { id: 'm1', origin: 'memory', score: 0.8, text: 'Private words' },
        { id: 'm2', origin: 'memory', score: 0.7, sharedText: 'Shared words' },
        { id: 'w1', origin: 'web', score: 0.6, text: 'Web words' },
      ],
    });
    assert.equal(detail.hits?.[0]?.text, undefined);
    assert.equal(detail.hits?.[1]?.sharedText, 'Shared words');
    assert.equal(detail.hits?.[2]?.text, 'Web words');
    const parsed = parseDetail('retrieve', JSON.stringify({ hits: [{ id: 'm1', origin: 'memory', score: 0.8, text: 'Private words' }] }));
    assert.equal(parsed.hits?.[0]?.text, undefined);
  });
});

describe('status vocabulary', () => {
  test('pipeline status maps to the docs/ui.md words', () => {
    assert.equal(STATUS_WORDS[statusFromPipeline('started')], 'Working');
    assert.equal(STATUS_WORDS[statusFromPipeline('ok')], 'Done');
    assert.equal(STATUS_WORDS[statusFromPipeline('error')], 'Failed');
    assert.equal(STATUS_WORDS[statusFromPipeline(undefined)], 'Not started');
  });

  test('a stopped errand is Stopped, never Failed; a waiting one is Waiting for confirm', () => {
    assert.equal(statusFromErrand('stopped'), 'stopped');
    assert.equal(statusFromErrand('awaiting_confirm'), 'waiting');
    assert.equal(statusFromErrand('confirmed'), 'working');
    assert.equal(statusFromErrand('refused'), 'refused');
    assert.equal(statusFromErrand('sent'), 'done');
    assert.equal(statusFromErrand('unknown_outcome'), 'failed');
  });

  test('calls in words, including the read-back and the CONFIRM window', () => {
    assert.equal(statusFromCall('prepared'), 'working');
    assert.equal(statusFromCall('awaiting_confirm'), 'waiting');
    assert.equal(statusFromCall('confirmed'), 'working');
    assert.equal(statusFromCall('ringing'), 'working');
    assert.equal(callStatusWord({ status: 'awaiting_confirm', result: null }), 'Waiting for confirm');
    assert.equal(callStatusWord({ status: 'ringing', result: null }), 'Ringing');
    assert.equal(callStatusWord({ status: 'ended', result: 'no_answer' }), 'No answer');
    assert.equal(callStatusWord({ status: 'ended', result: 'cancelled' }), 'Ended');
  });
});

describe('SpacetimeDB mapping helpers', () => {
  test('detail JSON parses, and bad JSON becomes a readable error instead of a crash', () => {
    assert.deepEqual(parseDetail('search', '{"rowCount":6}'), { rowCount: 6 });
    assert.deepEqual(parseDetail('listen', ''), {});
    assert.deepEqual(parseDetail('listen', null), {});
    const bad = parseDetail('plan', '{not json');
    assert.equal(bad.error?.sentence, "This step's details could not be read.");
    assert.equal(bad.error?.raw, '{not json');
    assert.equal(parseDetail('plan', '[1,2]').error?.raw, '[1,2]');
  });

  test('a SpacetimeDB Timestamp becomes epoch milliseconds', () => {
    assert.equal(timestampToMillis({ toMillis: () => 1_792_870_800_123n }), 1_792_870_800_123);
    assert.equal(timestampToMillis(null), null);
  });
});
