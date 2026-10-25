/**
 * W1 (docs/station.md 2.3, 2.5 and 9.2, check C6): the dashboards name the true input. The session label the station
 * starts with (`headset-demo`, `keyboard-test`, `switch-test`, ...) is in the public ledger as the `session_start` row's
 * outcome, so every screen reads the input mode from it. A keyboard session's commands are key presses and a switch
 * session's are switch presses, never imagined fists or jaw clenches; an unknown input names no brain or jaw signal.
 * Rows go through boardRows and the screen models, as on the live dashboard.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { agentsEmptySentence, callHeadline, errandHeadline, pauseWords, stopReason } from '../components/agents/model';
import { buildConversationView, focusQuestion } from '../components/conversation/model';
import { buildLiveView, feedItems, noClipReported } from '../components/live/model';
import { buildPartnerView, PARTNER_TEXT } from '../components/partner/model';
import { commandChipLabel, commandWord, inputChip, safetySentence } from '../lib/commands';
import { eventsForQuestion, latestQuestion, spokenReply } from '../lib/data/derive';
import { replayRowsAt } from '../lib/data/replay';
import { boardRows, inputFromLabel, inputFromLedger, type BoardSnapshot } from '../lib/data/spacetime-map';
import { PERSON_COMMANDS, type DataRows, type InputKind } from '../lib/data/types';
import { call, errand, event, ledger, midScan, option, question, read, scan, ts, wordTiming } from './board-fixtures';

const INPUTS: readonly InputKind[] = ['headset', 'keyboard', 'switch', 'unknown'];

/** The label each input's session starts with. "smoke" is what the smoke script used: it names no input. */
const LABELS: Readonly<Record<InputKind, string>> = {
  headset: 'headset-demo',
  keyboard: 'keyboard-test',
  switch: 'switch-test',
  unknown: 'smoke',
};

/** Any word that would pass a key or switch press off as a headset signal. `headset_off` is the module's state code, never shown. */
const HEADSET_WORDS = /jaw|imagined|fist|headset(?!_off)/i;

/** The words a view puts on screen: React keys (such as the phone's `21:headset-off` status key) are never shown. */
function shown(value: unknown): string {
  return JSON.stringify(value, (name, item: unknown) => (name === 'key' ? undefined : item));
}

/** The mid-scan board of a session started with `label`. `ledgerRows` are added after its start and question rows. */
function board(label: string, partial: Partial<BoardSnapshot> = {}, ledgerRows: BoardSnapshot['ledger'] = []): BoardSnapshot {
  const base = midScan(partial);
  return {
    ...base,
    ledger: [ledger(500, 'session_start', -5_000, { outcome: label }), ...midScan().ledger.filter((row) => row.kind !== 'session_start'), ...ledgerRows],
  };
}

function conversationOf(rows: DataRows) {
  const q = focusQuestion(rows.questions, rows.scan);
  assert.ok(q, 'a question exists');
  return buildConversationView({
    question: q,
    scan: rows.scan,
    options: rows.options,
    events: eventsForQuestion(rows.pipelineEvents, q.id),
    errands: rows.errands,
    calls: rows.calls,
    safety: rows.safety,
    input: rows.input,
    hasReply: spokenReply(q) !== null,
  });
}

function liveOf(rows: DataRows) {
  const q = latestQuestion(rows.questions);
  assert.ok(q, 'a question exists');
  return buildLiveView({
    question: q,
    nextQuestion: null,
    events: eventsForQuestion(rows.pipelineEvents, q.id),
    options: rows.options,
    errands: rows.errands,
    calls: rows.calls,
    scan: rows.scan,
    safety: rows.safety,
    input: rows.input,
    freezeAt: null,
  });
}

function partnerOf(rows: DataRows) {
  const q = latestQuestion(rows.questions);
  return buildPartnerView({
    question: q,
    events: eventsForQuestion(rows.pipelineEvents, q?.id ?? null),
    options: rows.options,
    errands: rows.errands,
    calls: rows.calls,
    scan: rows.scan,
    safety: rows.safety,
    input: rows.input,
    canType: false,
  });
}

const card = (rows: DataRows, stage: string) => liveOf(rows).cards.find((c) => c.stage === stage)!;

/** An errand option picked on question 21; the errand waits for CONFIRM. */
function errandWaiting(label: string): DataRows {
  return boardRows(
    board(label, {
      questions: [question({ status: { tag: 'Acting' }, outcome: { tag: 'Picked' }, pickedOptionId: 101n, options: [option(1, { kind: { tag: 'Errand' } }), option(2)] })],
      scanStates: [scan({ phase: { tag: 'Idle' }, outcome: { tag: 'Picked' }, pickedOptionId: 101n, cursor: 1, stepStartedAt: ts(8_000), stepEndsAt: ts(8_000) })],
      errands: [errand({ optionId: 101n, status: { tag: 'AwaitingConfirm' }, readbackDoneAt: ts(20_000), confirmOpensAt: ts(21_000), confirmClosesAt: ts(29_000) })],
    }),
  );
}

/** The session paused because its input went off (`HeadsetOff`: the decoder, or the keyboard page hidden). */
function inputOff(label: string): DataRows {
  return boardRows(board(label, { scanStates: [scan({ phase: { tag: 'Paused' }, pauseReason: { tag: 'HeadsetOff' }, pausedAt: ts(7_000) })] }));
}

describe('the input mode, from the session label in the public ledger', () => {
  test('labels name headset, keyboard or switch before the first hyphen; anything else is unknown', () => {
    for (const [label, input] of [
      ['headset-demo', 'headset'],
      ['headset-test', 'headset'],
      ['keyboard-test', 'keyboard'],
      ['keyboard-demo', 'keyboard'],
      ['switch-test', 'switch'],
      ['switch-demo', 'switch'],
      ['headset', 'headset'],
      ['smoke', 'unknown'],
      ['headsets-demo', 'unknown'],
      ['keyboardtest', 'unknown'],
      ['test-keyboard', 'unknown'],
      ['', 'unknown'],
    ] as const) {
      assert.equal(inputFromLabel(label), input, label);
    }
    assert.equal(inputFromLabel(null), 'unknown');
    assert.equal(inputFromLabel(undefined), 'unknown');
  });

  test('boardRows reads it from the newest session_start row; no row is unknown', () => {
    for (const input of INPUTS) assert.equal(boardRows(board(LABELS[input])).input, input, LABELS[input]);
    assert.equal(inputFromLedger([]), 'unknown');
    assert.equal(inputFromLedger([ledger(1, 'question', 0, { outcome: 'keyboard-test' })]), 'unknown', 'only a session_start row names the input');
    const restarted = [ledger(1, 'session_start', 0, { outcome: 'headset-demo' }), ledger(2, 'session_start', 10, { outcome: 'keyboard-test' })];
    assert.equal(inputFromLedger(restarted), 'keyboard');
  });

  test('the sample replay is a headset session by its own data', () => {
    const rows = replayRowsAt(0, 20_000);
    assert.equal(rows.input, 'headset');
    const yes = feedItems(rows.pipelineEvents, rows.commands, rows.errands, rows.calls, 40, rows.input).find((item) => item.name === 'YES' && item.status === 'accepted');
    assert.match(yes?.detail ?? '', /^imagined right fist/);
  });
});

describe('Conversation: the command strip and the turn', () => {
  test('the chips name the true input', () => {
    const chips = (input: InputKind) => PERSON_COMMANDS.map((name) => commandChipLabel(name, input));
    assert.deepEqual(chips('headset'), ['YES, imagined right fist', 'NO, imagined left fist', 'CONFIRM, single jaw clench', 'STOP, double jaw clench']);
    assert.deepEqual(chips('keyboard'), ['YES, key Y', 'NO, key N', 'CONFIRM, key C', 'STOP, key S']);
    assert.deepEqual(chips('switch'), ['YES, short switch press', 'NO, not on the switch', 'CONFIRM, double switch press', 'STOP, long switch press']);
    assert.deepEqual(chips('unknown'), ['YES', 'NO', 'CONFIRM', 'STOP']);
  });

  test('a picked errand waits for CONFIRM in the true input; the stopped cursor says Headset off only for the headset', () => {
    const sentences: Record<InputKind, string> = {
      headset: 'Waiting for CONFIRM, a single jaw clench. Nothing is sent yet.',
      keyboard: 'Waiting for CONFIRM, key C. Nothing is sent yet.',
      switch: 'Waiting for CONFIRM, a double switch press. Nothing is sent yet.',
      unknown: 'Waiting for CONFIRM. Nothing is sent yet.',
    };
    for (const input of INPUTS) {
      const view = conversationOf(errandWaiting(LABELS[input]));
      assert.equal(view.agent?.sentence, sentences[input], input);
      const off = conversationOf(inputOff(LABELS[input]));
      assert.equal(off.paused, 'headset_off');
      assert.equal(off.pausedWord, input === 'headset' ? 'Headset off' : 'Input off', input);
    }
  });
});

describe('Live data: the feed and the steps', () => {
  test('the feed names each command by the true input; HEADSET_OFF is the H test key in a keyboard test', () => {
    const gestures = [
      ledger(610, 'gesture', 6_100, { command: 'YES', gestureId: 'g-yes', outcome: 'accepted:resume' }),
      ledger(611, 'gesture', 6_200, { command: 'HEADSET_OFF', gestureId: 'g-off', outcome: 'accepted:headset_off' }),
      ledger(612, 'gesture', 6_300, { command: 'CONFIRM', gestureId: 'g-confirm', outcome: 'ignored:no_contact', reason: 'no_contact' }),
    ];
    const expected: Record<InputKind, [string, string, string, string]> = {
      headset: ['imagined right fist', 'Headset off', 'system event, not a command', 'The headset contact was not good'],
      keyboard: ['key Y', 'Input off', 'key H, a test', 'The input was not ready'],
      switch: ['short switch press', 'Input off', 'system event, not a command', 'The input was not ready'],
      unknown: ['', 'Input off', 'system event, not a command', 'The input was not ready'],
    };
    for (const input of INPUTS) {
      const rows = boardRows(board(LABELS[input], {}, gestures));
      const feed = feedItems(rows.pipelineEvents, rows.commands, rows.errands, rows.calls, 40, rows.input);
      const byKey = new Map(feed.map((item) => [item.key, item]));
      const [yes, offName, offDetail, ignored] = expected[input];
      assert.equal(byKey.get('command:g-yes')?.detail, yes, `${input}: YES`);
      assert.equal(byKey.get('command:g-off')?.name, offName, `${input}: HEADSET_OFF name`);
      assert.equal(byKey.get('command:g-off')?.detail, offDetail, `${input}: HEADSET_OFF detail`);
      assert.equal(byKey.get('command:g-confirm')?.detail, ignored, `${input}: ignored for contact`);
      if (input !== 'headset') assert.doesNotMatch(shown(feed), HEADSET_WORDS, `${input}: no headset words in the feed`);
    }
  });

  test('Picked names the input as its tool; a step cut by the input going off says Headset off only for the headset', () => {
    const tools: Record<InputKind, string> = { headset: 'Headset', keyboard: 'Keyboard', switch: 'USB switch', unknown: 'Input' };
    for (const input of INPUTS) {
      assert.equal(card(boardRows(board(LABELS[input])), 'select').tool, tools[input], input);
      const speak = card(inputOff(LABELS[input]), 'speak');
      assert.equal(speak.status, 'stopped');
      assert.equal(speak.word, input === 'headset' ? 'Headset off' : 'Input off', input);
      assert.equal(speak.payload, `${input === 'headset' ? 'Headset off' : 'Input off'}. Nothing will be sent.`, input);
      assert.equal(commandWord('HEADSET_OFF', input), input === 'headset' ? 'Headset off' : 'Input off');
    }
  });

  test('the errand line waits for CONFIRM in the true input', () => {
    const lines: Record<InputKind, string> = {
      headset: 'Waiting for CONFIRM, a single jaw clench.',
      keyboard: 'Waiting for CONFIRM, key C.',
      switch: 'Waiting for CONFIRM, a double switch press.',
      unknown: 'Waiting for CONFIRM.',
    };
    for (const input of INPUTS) {
      const line = liveOf(errandWaiting(LABELS[input])).actions.find((action) => action.kind === 'errand');
      assert.equal(line?.sentence, lines[input], input);
    }
  });

  test('Speaking names the Cartesia voice only when a clip was reported for a read', () => {
    const reads = [read(44, 4_300, { optionId: 101, rank: 1, stepSeq: 3 }), read(45, 5_600, { optionId: 102, rank: 2, stepSeq: 5 })];
    const reading = (partial: Partial<BoardSnapshot> = {}) =>
      boardRows(board('keyboard-test', { pipelineEvents: [...midScan().pipelineEvents, ...reads], ...partial }));

    // The silent keyboard test of Oct 24: every read estimated, no word timings.
    const silent = reading();
    assert.equal(noClipReported(silent.pipelineEvents), true);
    assert.equal(card(silent, 'speak').tool, 'No voice clip reported');
    assert.equal(card(silent, 'speak').passed, '2 scanned');

    // The station's word timings for a read mean its clip played.
    const timed = reading({ wordTimings: [wordTiming(45, [0, 240], [220, 520])] });
    assert.equal(noClipReported(timed.pipelineEvents), false);
    assert.equal(card(timed, 'speak').tool, 'Cartesia Sonic, into the earpiece');
    assert.equal(card(timed, 'speak').passed, '2 played');

    // A read the module planned from a measured clip is not judged silent either.
    const measured = event(46, 's6:read:7', 'speak', 'started', 'reading option', 6_900, {
      countsJson: JSON.stringify({ optionId: 101, rank: 1, pass: 1, stepSeq: 7, durationMs: 900, estimated: false }),
    });
    const clipped = reading({ pipelineEvents: [...midScan().pipelineEvents, ...reads, measured] });
    assert.equal(card(clipped, 'speak').tool, 'Cartesia Sonic, into the earpiece');

    // Only the scan's start row, or only the yes or no prompt: nothing to judge, so the card is unchanged.
    assert.equal(noClipReported(boardRows(board('keyboard-test')).pipelineEvents), false);
    const prompt = read(47, 4_300, { optionId: 0, rank: 0, stepSeq: 22, durationMs: 900 });
    assert.equal(noClipReported(boardRows(board('keyboard-test', { pipelineEvents: [...midScan().pipelineEvents, prompt] })).pipelineEvents), false);

    // The sample replay carries word timings on every read: the voice stays.
    const replay = replayRowsAt(0, 7_000);
    assert.equal(liveOf(replay).cards.find((c) => c.stage === 'speak')?.tool, 'Cartesia Sonic, into the earpiece');
  });

  test('Drafting says Claude only when the agent labelled its step claude', () => {
    assert.equal(card(boardRows(board('keyboard-test')), 'plan').tool, 'Agent', 'the smoke stand-in labels its step "smoke options"');
    const claude = board('headset-demo');
    claude.pipelineEvents = claude.pipelineEvents.map((row) => (row.stage === 'plan' && row.status === 'started' ? { ...row, detail: 'claude' } : row));
    assert.equal(card(boardRows(claude), 'plan').tool, 'Claude');
    assert.equal(liveOf(replayRowsAt(0, 7_000)).cards.find((c) => c.stage === 'plan')?.tool, 'Claude', 'the sample labels its plan steps claude');
  });
});

describe('the header chip and the banner', () => {
  test('a headset session keeps its words; keys and a switch say so; an unknown input says Input', () => {
    const words = (input: InputKind) => (['ok', 'headset_off', 'paused', 'unknown'] as const).map((state) => inputChip(state, input).words);
    assert.deepEqual(words('headset'), ['Headset on', 'Headset off', 'Paused', 'Headset unknown']);
    assert.deepEqual(words('keyboard'), ['Keyboard input', 'Input off', 'Paused', 'Keyboard input']);
    assert.deepEqual(words('switch'), ['Switch input', 'Input off', 'Paused', 'Switch input']);
    assert.deepEqual(words('unknown'), ['Input on', 'Input off', 'Paused', 'Input unknown']);
    assert.equal(inputChip('ok', 'keyboard').dashed, false);
    assert.equal(inputChip('unknown', 'keyboard').dashed, true, 'an ended keyboard session still says keyboard, dashed');
    assert.equal(inputChip('ok', 'keyboard').lead, 'dot', 'no headset icon for keys');
    assert.equal(inputChip('ok', 'headset').lead, 'headset');
    assert.equal(safetySentence('headset_off', 'headset'), 'Headset off. Nothing will be sent.');
    for (const input of ['keyboard', 'switch', 'unknown'] as const) assert.equal(safetySentence('headset_off', input), 'Input off. Nothing will be sent.');
    assert.equal(safetySentence('paused', 'keyboard'), 'Paused. Nothing will be sent.');
    assert.equal(safetySentence('ok', 'keyboard'), null);
  });
});

describe('Agents: what the person did, in the true input', () => {
  test('confirmed, sent, connected, the STOP that stopped it, the pause, and the empty state', () => {
    const phrase: Record<InputKind, string | null> = { headset: 'a single jaw clench', keyboard: 'key C', switch: 'a double switch press', unknown: null };
    const stop: Record<InputKind, string> = { headset: 'STOP, a double jaw clench', keyboard: 'STOP, key S', switch: 'STOP, a long switch press', unknown: 'STOP' };
    for (const input of INPUTS) {
      const rows = boardRows(
        board(
          LABELS[input],
          {
            errands: [errand({ status: { tag: 'Submitting' } })],
            calls: [
              call({ callId: 3n, status: { tag: 'Connected' } }),
              call({ callId: 4n, status: { tag: 'Stopped' }, stopGestureId: 'g-stop', confirmedAt: undefined, dialedAt: undefined, ringingAt: undefined, connectedAt: undefined, endedAt: ts(36_000) }),
              call({ callId: 5n, status: { tag: 'Stopped' }, stopGestureId: 'g-off', confirmedAt: undefined, dialedAt: undefined, ringingAt: undefined, connectedAt: undefined, endedAt: ts(37_000) }),
            ],
          },
          [
            ledger(620, 'gesture', 36_000, { command: 'STOP', gestureId: 'g-stop', outcome: 'accepted:stop' }),
            ledger(621, 'gesture', 37_000, { command: 'HEADSET_OFF', gestureId: 'g-off', outcome: 'accepted:headset_off' }),
          ],
        ),
      );
      const p = phrase[input];
      assert.equal(errandHeadline(rows.errands[0]!, 'ok', rows.input).text, p ? `Confirmed with ${p}. Sending the form.` : 'Confirmed. Sending the form.', input);
      assert.equal(
        errandHeadline({ ...rows.errands[0]!, status: 'sent' }, 'ok', rows.input).text,
        p ? `Sent after the person confirmed with ${p}.` : 'Sent after the person confirmed.',
        input,
      );
      const [connected, stopped, off] = rows.calls;
      assert.equal(callHeadline(connected!, 'ok', rows.input).text, `On the phone with Contact. ${input === 'unknown' ? 'STOP hangs up.' : `${stop[input]}, hangs up.`}`, input);
      assert.equal(stopReason(stopped!, rows.commands, rows.input), `The person used ${stop[input]}.`, input);
      assert.equal(stopReason(off!, rows.commands, rows.input), input === 'headset' ? 'The headset lost contact.' : 'The input went off.', input);
      assert.equal(pauseWords('headset_off', rows.input), input === 'headset' ? 'Headset off.' : 'Input off.');
      assert.equal(agentsEmptySentence(rows.input).endsWith(`Nothing is sent without ${p ?? 'a CONFIRM'}.`), true, input);
      if (input !== 'headset') {
        const all = [
          errandHeadline(rows.errands[0]!, 'headset_off', rows.input),
          callHeadline(connected!, 'ok', rows.input),
          callHeadline(off!, 'ok', rows.input, rows.commands),
          agentsEmptySentence(rows.input),
        ];
        assert.doesNotMatch(shown(all), HEADSET_WORDS, input);
      }
    }
  });
});

describe('Partner phone: no jaw clench and no headset for keys or a switch', () => {
  test('the hold sentence and the confirm hint', () => {
    for (const input of INPUTS) {
      const off = partnerOf(inputOff(LABELS[input]));
      assert.equal(off.status.text, input === 'headset' ? PARTNER_TEXT.headsetOff : PARTNER_TEXT.inputOff, input);
      const waiting = partnerOf(errandWaiting(LABELS[input]));
      assert.equal(waiting.status.text, 'Waiting for them to confirm.');
      assert.equal(waiting.hint, input === 'headset' ? 'Nothing is sent without their single jaw clench.' : 'Nothing is sent until they confirm.', input);
      if (input !== 'headset') assert.doesNotMatch(shown([off, waiting]), HEADSET_WORDS, input);
    }
  });
});

describe('the whole keyboard-test board through every screen: no headset words', () => {
  test('Conversation, Live data and the phone for keyboard, switch and unknown sessions', () => {
    for (const input of ['keyboard', 'switch', 'unknown'] as const) {
      for (const rows of [boardRows(board(LABELS[input])), errandWaiting(LABELS[input]), inputOff(LABELS[input])]) {
        const views = [conversationOf(rows), liveOf(rows), partnerOf(rows), PERSON_COMMANDS.map((name) => commandChipLabel(name, rows.input))];
        assert.doesNotMatch(shown(views), HEADSET_WORDS, input);
      }
    }
  });
});
