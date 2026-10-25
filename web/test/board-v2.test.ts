/**
 * Module v2 on the board (docs/spacetime.md 14): rows shaped as the regenerated bindings give them, mapped by
 * boardRows and read by the screen models. One speak step per read with its rank and the station's word timings, a
 * select step only for a pick, the option id on errand and call rows, a call's read-back, confirm window and the
 * command that stopped it, the hold sentence, and the pick kept through a pause and the end of the session.
 * All content is made-up smoke content.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  callBadge,
  callEndReason,
  callHeadline,
  callHoldSentence,
  callPlan,
  errandBadge,
  stopReason,
} from '../components/agents/model';
import { buildConversationView, focusQuestion, wordBeingRead } from '../components/conversation/model';
import { buildLiveView, feedItems } from '../components/live/model';
import { eventsForQuestion, latestQuestion, spokenReply } from '../lib/data/derive';
import { boardRows, wordTimingsFromBoard, type BoardSnapshot } from '../lib/data/spacetime-map';
import type { DataRows } from '../lib/data/types';
import { call, config, errand, event, ledger, midScan, ms, option, question, read, scan, ts, wordTiming } from './board-fixtures';

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

const speakCard = (rows: DataRows) => liveOf(rows).cards.find((card) => card.stage === 'speak')!;

/** Text that only shows up when a value went missing on the way to the screen. */
const BROKEN = /undefined|NaN|\[object Object\]|Infinity/;

/** The question mid-scan with the module's v2 reads: option 1 read, option 2 being read now. */
function reading(partial: Partial<BoardSnapshot> = {}): BoardSnapshot {
  const base = midScan();
  return midScan({
    // The first read is written in the same transaction, so the same millisecond, as the scan's start row (43).
    pipelineEvents: [...base.pipelineEvents, read(44, 4_300, { optionId: 101, rank: 1, stepSeq: 3 }), read(45, 5_600, { optionId: 102, rank: 2, stepSeq: 5 })],
    scanStates: [scan({ phase: { tag: 'Reading' }, cursor: 2, stepSeq: 5n, stepStartedAt: ts(5_600), stepEndsAt: ts(6_350), optionStartSeq: 5n, optionStartedAt: ts(5_600) })],
    ...partial,
  });
}

describe('module v2 on the board (docs/spacetime.md 14)', () => {
  test('every read is one speak step with its option, rank, pass and step; the station word timings ride on it', () => {
    const rows = boardRows(reading({ wordTimings: [wordTiming(45, [0, 240], [220, 520], { stepSeq: 5n })] }));
    const byId = new Map(rows.pipelineEvents.map((e) => [e.id, e]));
    assert.deepEqual(byId.get('44')?.detail, {
      optionId: '101',
      rank: 1,
      pass: 1,
      stepSeq: 3,
      durationMs: 750,
      estimated: true,
      label: 'reading option',
      channel: 'earpiece',
    });
    assert.deepEqual(byId.get('45')?.detail, {
      optionId: '102',
      rank: 2,
      pass: 1,
      stepSeq: 5,
      durationMs: 750,
      estimated: true,
      label: 'reading option',
      channel: 'earpiece',
      words: [
        { startMs: 0, endMs: 220 },
        { startMs: 240, endMs: 520 },
      ],
    });
  });

  test('Live data: the Speaking step names the option being read by its rank and counts the options played', () => {
    const rows = boardRows(reading());
    const card = speakCard(rows);
    assert.equal(card.status, 'working');
    assert.equal(card.payload, 'Option 2, warm voice', 'sharing is off, so the rank and the tone, no words');
    // Both reads are estimated with no word timings (no station made clips), so the card names no voice (W1).
    assert.equal(card.tool, 'No voice clip reported');
    assert.equal(card.passed, '2 scanned');
    // Once the station's word timings for a read arrive, a clip played: the card names the voice again.
    const voiced = speakCard(boardRows(reading({ wordTimings: [wordTiming(45, [0, 240], [220, 520])] })));
    assert.equal(voiced.tool, 'Cartesia Sonic, into the earpiece');
    assert.equal(voiced.passed, '2 played');
    const feed = feedItems(rows.pipelineEvents, rows.commands, rows.errands, rows.calls, 10, rows.input);
    // Newest first, and rows of the same millisecond newest first too: the first read above its scan's start.
    assert.deepEqual(
      feed.filter((item) => item.name === 'speak').map((item) => item.detail),
      ['reading option, option 2, pass 1, earpiece', 'reading option, option 1, pass 1, earpiece', 'scan started, earpiece'],
    );
    assert.doesNotMatch(JSON.stringify(liveOf(rows)), BROKEN);
  });

  test('a scan read twice with no pick: one step per read, the last read named after "scan ended", and no select step', () => {
    const reads = [1, 2, 3, 4, 1, 2, 3, 4].map((rank, i) =>
      read(44 + i, 4_300 + i * 4_000, { optionId: 100 + rank, rank, pass: i < 4 ? 1 : 2, stepSeq: 3 + i * 2 }),
    );
    const rows = boardRows(
      midScan({
        pipelineEvents: [...midScan().pipelineEvents, ...reads, event(60, 'q21:scan:end', 'speak', 'ok', 'scan ended', 36_400, { ms: 36_000 })],
        scanStates: [scan({ phase: { tag: 'Idle' }, outcome: { tag: 'NoPick' }, cursor: 4, pass: 2, stepStartedAt: ts(36_400), stepEndsAt: ts(36_400) })],
        questions: [question({ status: { tag: 'NoPick' }, outcome: { tag: 'NoPick' } })],
      }),
    );
    assert.deepEqual(
      rows.pipelineEvents.filter((e) => e.stage === 'speak' && e.detail.label === 'reading option').map((e) => (e.detail as { rank?: number }).rank),
      [1, 2, 3, 4, 1, 2, 3, 4],
    );
    assert.ok(!rows.pipelineEvents.some((e) => e.stage === 'select'));
    const card = speakCard(rows);
    assert.equal(card.status, 'done');
    assert.equal(card.payload, 'Option 4, warm voice, pass 2');
    assert.equal(card.passed, '4 scanned', 'every read estimated and untimed: no voice clip was reported');
    assert.equal(liveOf(rows).cards.find((c) => c.stage === 'select')?.word, 'No pick');
  });

  test('a read of the yes or no prompt names no option; the Speaking step says so', () => {
    const rows = boardRows(
      midScan({
        questions: [question({ answerMode: { tag: 'YesNo' }, options: [option(1, { label: 'Yes' }), option(2, { label: 'No' })] })],
        scanStates: [scan({ answerMode: { tag: 'YesNo' }, phase: { tag: 'Reading' }, cursor: 0, stepSeq: 22n, stepStartedAt: ts(4_300), stepEndsAt: ts(5_200) })],
        pipelineEvents: [
          ...midScan().pipelineEvents.slice(0, 3),
          event(43, 'q21:v1:scan', 'speak', 'started', 'yes or no prompt', 4_300, { countsJson: '{"version":1,"optionCount":2}' }),
          read(46, 4_300, { optionId: 0, rank: 0, stepSeq: 22, durationMs: 900 }),
        ],
      }),
    );
    const prompt = rows.pipelineEvents.find((e) => e.id === '46')!;
    assert.equal(prompt.detail.label, 'yes or no prompt');
    assert.equal((prompt.detail as Record<string, unknown>).optionId, undefined, 'option 0 is no option');
    assert.equal((prompt.detail as Record<string, unknown>).rank, undefined, 'rank 0 is no rank');
    const card = speakCard(rows);
    assert.equal(card.payload, 'The yes or no prompt');
    assert.equal(card.passed, '1 played');
    assert.equal(conversationOf(rows).cursor?.optionId, null);
  });

  test('Live conversation: the word mark uses the station word timings when the read has them, and says it is an estimate otherwise', () => {
    const timed = conversationOf(boardRows(reading({ wordTimings: [wordTiming(45, [0, 240], [220, 520])] })));
    assert.equal(timed.cursor?.optionId, '102');
    assert.equal(timed.cursor?.phase, 'reading');
    assert.deepEqual(timed.cursor?.words, [
      { startMs: 0, endMs: 220 },
      { startMs: 240, endMs: 520 },
    ]);
    const start = timed.cursor!.startedAt;
    assert.deepEqual(wordBeingRead(['Option', '2'], timed.cursor!.words, start, timed.cursor!.endsAt, start + 100), { index: 0, estimated: false });
    assert.deepEqual(wordBeingRead(['Option', '2'], timed.cursor!.words, start, timed.cursor!.endsAt, start + 300), { index: 1, estimated: false });
    // Cartesia may time more words than the screen shows (sharing off: "Option 2"); the mark keeps its place.
    const more = conversationOf(boardRows(reading({ wordTimings: [wordTiming(45, [0, 200, 400, 600], [180, 380, 580, 780])] })));
    assert.deepEqual(wordBeingRead(['Option', '2'], more.cursor!.words, start, more.cursor!.endsAt, start + 650), { index: 1, estimated: false });

    const untimed = conversationOf(boardRows(reading()));
    assert.equal(untimed.cursor?.words, null);
    assert.equal(wordBeingRead(['Option', '2'], untimed.cursor!.words, start, untimed.cursor!.endsAt, start + 100).estimated, true);
  });

  test('word timings are kept only when they pair up in order, inside 30 s, for the board session', () => {
    assert.deepEqual(wordTimingsFromBoard({ startsMs: [0, 240], endsMs: [220, 520] }), [
      { startMs: 0, endMs: 220 },
      { startMs: 240, endMs: 520 },
    ]);
    assert.equal(wordTimingsFromBoard({ startsMs: [], endsMs: [] }), null);
    assert.equal(wordTimingsFromBoard({ startsMs: [0, 240], endsMs: [220] }), null);
    assert.equal(wordTimingsFromBoard({ startsMs: [240, 0], endsMs: [520, 220] }), null, 'out of order');
    assert.equal(wordTimingsFromBoard({ startsMs: [100], endsMs: [50] }), null, 'ends before it starts');
    assert.equal(wordTimingsFromBoard({ startsMs: [0], endsMs: [30_001] }), null, 'past the longest clip');
    assert.equal(wordTimingsFromBoard({ startsMs: [0, Number.NaN], endsMs: [10, 20] }), null);
    const otherSession = boardRows(reading({ wordTimings: [wordTiming(45, [0], [200], { sessionId: 5n })] }));
    const otherDetail = otherSession.pipelineEvents.find((e) => e.id === '45')?.detail as { words?: unknown } | undefined;
    assert.ok(otherDetail, 'the read is there');
    assert.equal(otherDetail.words, undefined);
  });

  test('a select step is a pick because the module names the option in its counts; the label is not read', () => {
    const rows = boardRows(
      midScan({
        questions: [question({ status: { tag: 'Spoken' }, outcome: { tag: 'Picked' }, pickedOptionId: 104n })],
        scanStates: [scan({ phase: { tag: 'Idle' }, outcome: { tag: 'Picked' }, pickedOptionId: 104n, pickedRank: 4, cursor: 4 })],
        pipelineEvents: [event(70, 'q21:select', 'select', 'ok', 'chosen', 7_000, { countsJson: '{"optionId":104,"rank":4,"pass":2}', ms: 0 })],
      }),
    );
    assert.deepEqual(rows.pipelineEvents.map((e) => e.detail), [{ optionId: '104', rank: 4, pass: 2, label: 'chosen', kind: 'reply' }]);
    assert.equal(liveOf(rows).draft.pickedId, '104');
    assert.equal(liveOf(rows).cards.find((c) => c.stage === 'select')?.payload, 'Option 4');

    // Counts that do not name an option (a boolean, a zero) are no pick.
    for (const countsJson of ['{"rank":true,"pass":1}', '{"optionId":0,"rank":0,"pass":1}', '{"optionId":false}']) {
      const none = boardRows(midScan({ pipelineEvents: [event(71, 'q21:select', 'select', 'ok', 'picked', 7_000, { countsJson })] }));
      assert.deepEqual(none.pipelineEvents, [], countsJson);
    }
  });

  test('an errand names its own option, and its confirm window opens after the quiet hold', () => {
    const rows = boardRows(
      midScan({
        questions: [question({ outcome: { tag: 'Picked' }, pickedOptionId: 101n, options: [option(1, { kind: { tag: 'Errand' } }), option(2), option(3, { kind: { tag: 'Errand' } })] })],
        errands: [errand({ optionId: 103n })],
      }),
    );
    const e = rows.errands[0]!;
    assert.equal(e.optionId, '103', "the row's own option id wins over the question's pick");
    assert.equal(e.readAloudAt, ms(14_000));
    assert.equal(e.confirmOpensAt, ms(15_000));
    assert.equal(errandBadge(e, rows.safety.state).countdownTo, ms(23_000));
  });

  test('the pick survives a pause and the end of the session, straight from the scan row', () => {
    const picked = {
      questions: [question({ status: { tag: 'Acting' }, outcome: { tag: 'Picked' }, pickedOptionId: undefined, options: [option(1, { kind: { tag: 'Errand' } }), option(2)] })],
      errands: [errand({ optionId: 101n, status: { tag: 'Drafted' }, previewedAt: undefined, readbackDoneAt: undefined, confirmOpensAt: undefined, confirmClosesAt: undefined })],
    } satisfies Partial<BoardSnapshot>;
    const paused = boardRows(
      midScan({
        ...picked,
        scanStates: [scan({ phase: { tag: 'Paused' }, pauseReason: { tag: 'HeadsetLost' }, pausedAt: ts(8_000), outcome: { tag: 'Picked' }, pickedOptionId: 101n, pickedRank: 1, cursor: 1 })],
      }),
    );
    assert.equal(paused.scan?.pickedOptionId, '101');
    assert.equal(paused.safety.state, 'paused');
    const view = conversationOf(paused);
    assert.equal(view.picked?.id, '101');
    assert.equal(view.paused, 'paused');
    assert.equal(view.agent?.sentence, 'Filling in the form. Nothing is sent yet.');
    assert.equal(liveOf(paused).draft.pickedId, '101');

    const ended = boardRows(
      midScan({
        ...picked,
        scanStates: [scan({ phase: { tag: 'Idle' }, outcome: { tag: 'Picked' }, pickedOptionId: 101n, pickedRank: 1, cursor: 1 })],
        ledger: [...midScan().ledger, ledger(530, 'session_end', 60_000)],
      }),
    );
    assert.equal(ended.scan?.pickedOptionId, '101');
    assert.equal(ended.safety.state, 'unknown');
    assert.equal(conversationOf(ended).picked?.id, '101');
  });

  test('a call waiting for CONFIRM: its option, the read-back time and the confirm countdown, with sharing off', () => {
    const rows = boardRows(
      midScan({
        calls: [
          call({
            status: { tag: 'AwaitingConfirm' },
            optionId: 104n,
            readbackDoneAt: ts(32_000),
            confirmOpensAt: ts(33_000),
            confirmClosesAt: ts(41_000),
            confirmedAt: undefined,
            dialedAt: undefined,
            ringingAt: undefined,
            connectedAt: undefined,
          }),
        ],
      }),
    );
    const c = rows.calls[0]!;
    assert.deepEqual(
      [c.optionId, c.contactName, c.readAloudAt, c.confirmOpensAt, c.confirmClosesAt, c.confirmCommandId, c.stopCommandId, c.held],
      ['104', 'Contact', ms(32_000), ms(33_000), ms(41_000), null, null, false],
    );
    assert.deepEqual(callBadge(c, rows.safety.state), { status: 'waiting', word: 'Waiting for confirm', countdownTo: ms(41_000) });
    assert.deepEqual(callPlan(c), { script: 'done', confirm: 'waiting', ring: 'not_started', talk: 'not_started', end: 'not_started' });
    assert.equal(callHeadline(c, rows.safety.state, rows.input).text, 'Waiting for the person to confirm the call. Nobody has been called.');
  });

  test('what stopped a call: the STOP before the dial, the claim window, and the STOP that hung it up', () => {
    const stop = (id: string, at: number) => ledger(600 + at, 'gesture', at, { command: 'STOP', gestureId: id, outcome: 'accepted:stop' });
    const rows = boardRows(
      midScan({
        ledger: [...midScan().ledger, stop('smoke-stop-1', 36_000), stop('smoke-stop-2', 50_000)],
        calls: [
          call({ callId: 3n, status: { tag: 'Stopped' }, stopGestureId: 'smoke-stop-1', reasonCode: '', reason: '', confirmedAt: undefined, dialedAt: undefined, ringingAt: undefined, connectedAt: undefined, readbackDoneAt: ts(32_000), endedAt: ts(36_000) }),
          call({ callId: 4n, status: { tag: 'Stopped' }, reasonCode: 'confirm_expired', reason: 'Too much time passed after the confirm. No call was made.', confirmGestureId: 'smoke-confirm-9', dialedAt: undefined, ringingAt: undefined, connectedAt: undefined, endedAt: ts(45_000) }),
          call({ callId: 5n, status: { tag: 'Ended' }, result: 'cancelled', stopGestureId: 'smoke-stop-2', cancelRequested: true, endedAt: ts(50_400) }),
        ],
      }),
    );
    const [beforeDial, expired, hungUp] = rows.calls;
    assert.equal(beforeDial?.stopCommandId, 'smoke-stop-1');
    // The fixture's session label is "smoke", which names no input, so the STOP is named without a signal (W1).
    assert.equal(rows.input, 'unknown');
    assert.equal(stopReason(beforeDial!, rows.commands, rows.input), 'The person used STOP.');
    assert.equal(stopReason(beforeDial!, rows.commands, 'headset'), 'The person used STOP, a held jaw clench.');
    assert.equal(expired?.reasonCode, 'confirm_expired');
    assert.equal(expired?.confirmCommandId, 'smoke-confirm-9');
    assert.equal(stopReason(expired!, rows.commands, rows.input), 'Too much time passed after the confirm. No call was made.');
    assert.equal(stopReason({ ...expired!, reason: null }, rows.commands, rows.input), 'Too much time passed after the confirm.');
    assert.equal(callEndReason(hungUp!, rows.input, rows.commands), 'The person used STOP.');
    assert.equal(callEndReason(hungUp!, 'headset', rows.commands), 'The person used STOP, a held jaw clench.');
    assert.equal(callHeadline(hungUp!, rows.safety.state, rows.input, rows.commands).text, 'The call ended. The person used STOP.');
    assert.equal(callEndReason(hungUp!, rows.input), 'The call was hung up.', 'without the command rows, the result');

    // Sharing on: the call agent reports Cartesia's end reason code and its own sentence; the STOP still says what ended it.
    const shared = boardRows(
      midScan({
        ledger: [...midScan().ledger, stop('smoke-stop-2', 50_000)],
        calls: [call({ callId: 5n, status: { tag: 'Ended' }, result: 'cancelled', textShared: true, endReason: 'api_cancelled', reason: 'The call was cancelled.', stopGestureId: 'smoke-stop-2', endedAt: ts(50_400) })],
      }),
    );
    assert.equal(shared.calls[0]?.endReason, null, 'a bare end reason code is not words');
    assert.equal(callHeadline(shared.calls[0]!, shared.safety.state, 'headset', shared.commands).text, 'The call ended. The person used STOP, a held jaw clench.');
    const words = boardRows(midScan({ calls: [call({ textShared: true, endReason: 'No answer after 25 s' })] }));
    assert.equal(words.calls[0]?.endReason, 'No answer after 25 s', 'an end reason in words stays');
  });

  test('a call that ended held: "Calls to <name> are on hold until someone checks" on Agents, once, by name only', () => {
    const held = (partial: Parameters<typeof call>[0]) =>
      boardRows(midScan({ config: [config({ shareTextOnBoard: partial?.textShared === true })], calls: [call({ status: { tag: 'Ended' }, result: 'answered', endedAt: ts(60_000), held: true, ...partial })] })).calls[0]!;

    // Sharing off: the module's own sentence for the hold code, and the name stays "Contact".
    const off = held({ reasonCode: 'opt_out_hold', reason: 'Calls to this contact are on hold until someone checks.' });
    assert.equal(off.held, true);
    assert.equal(callHoldSentence(off), 'Calls to this contact are on hold until someone checks.');
    assert.equal(callHeadline(off, 'unknown', 'unknown').text, 'The call ended. Calls to this contact are on hold until someone checks.', 'said once');

    // Sharing on, and the stored reason does not carry the sentence: it is added with the name, and a number is hidden.
    const on = held({ status: { tag: 'Failed' }, result: 'failed', textShared: true, contactName: 'Demo caregiver 415 555 0100', reasonCode: 'call_failed', reason: '' });
    assert.equal(callHoldSentence(on), 'Calls to Demo caregiver [number hidden] are on hold until someone checks.');
    assert.equal(callHeadline(on, 'unknown', 'unknown').text, 'The call failed. Calls to Demo caregiver [number hidden] are on hold until someone checks.');

    const notHeld = held({ held: false });
    assert.equal(callHoldSentence(notHeld), null);
    assert.doesNotMatch(callHeadline(notHeld, 'unknown', 'unknown').text, /on hold/);
  });

  test('the whole v2 board through every screen model: no broken value and no private words', () => {
    const rows = boardRows(
      reading({
        wordTimings: [wordTiming(45, [0, 240], [220, 520])],
        errands: [errand({ optionId: 101n })],
        calls: [call({ optionId: 104n, held: true, status: { tag: 'Ended' }, result: 'answered', endedAt: ts(60_000) })],
      }),
    );
    for (const view of [conversationOf(rows), liveOf(rows)]) assert.doesNotMatch(JSON.stringify(view), BROKEN);
    assert.doesNotMatch(JSON.stringify(rows), BROKEN);
  });
});
