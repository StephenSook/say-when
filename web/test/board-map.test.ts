/**
 * The live board mapping (lib/data/spacetime-map.ts boardRows): rows shaped exactly as the generated bindings give
 * them (lib/data/module_bindings/types, so a schema change breaks this file at the typecheck), with the labels, event
 * keys, ledger kinds and outcomes the module writes (docs/spacetime.md 11.4, spacetime/src) and the config values
 * read from say-when-dev on Oct 24. Then the mapped rows go through the screen models, as on the live dashboard.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildConversationView, focusQuestion, PICK_LEGEND } from '../components/conversation/model';
import { buildLiveView } from '../components/live/model';
import { buildPartnerView, PARTNER_TEXT } from '../components/partner/model';
import { errandHeadline } from '../components/agents/model';
import { eventsForQuestion, hitDisplay, latestQuestion, spokenReply } from '../lib/data/derive';
import type { BoardPayload, ScanState as ScanRow } from '../lib/data/module_bindings/types';
import {
  boardRows,
  CALL_STATUSES,
  ERRAND_STATUSES,
  ignoredReasonWords,
  readBackItems,
} from '../lib/data/spacetime-map';
import { EMPTY_ROWS, type DataRows, type MossHit } from '../lib/data/types';
import { statusFromCall, statusFromErrand } from '../lib/status';
import { call, config, errand, event, ledger, midScan, ms, option, question, scan, station, ts } from './board-fixtures';

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

/** Text that only shows up when a value went missing on the way to the screen. */
const BROKEN = /undefined|NaN|\[object Object\]|Infinity/;

describe('boardRows: the live SpacetimeDB board as the dashboard rows', () => {
  test('no session yet (active_session_id 0, or no config row): empty rows, safety unknown', () => {
    assert.equal(boardRows(midScan({ config: [config({ activeSessionId: 0n })] })), EMPTY_ROWS);
    assert.equal(boardRows(midScan({ config: [] })), EMPTY_ROWS);
  });

  test('a question mid-scan with sharing off: ids as strings, server times in ms, "Option N" and no words', () => {
    const rows = boardRows(midScan());
    assert.deepEqual(rows.questions, [
      { id: '21', sessionId: '6', number: 1, text: null, via: 'typed', origin: 'partner', askedAt: ms(0), replyText: null, spokenAt: null },
    ]);
    assert.deepEqual(
      rows.options.map((o) => [o.id, o.questionId, o.version, o.rank, o.text, o.kind, o.tone, o.sources.length]),
      [
        ['101', '21', 1, 1, 'Option 1', 'reply', 'warm', 0],
        ['102', '21', 1, 2, 'Option 2', 'reply', 'warm', 0],
        ['103', '21', 1, 3, 'Option 3', 'reply', 'warm', 0],
        ['104', '21', 1, 4, 'Option 4', 'reply', 'warm', 0],
      ],
    );
    assert.deepEqual(rows.scan, {
      questionId: '21',
      version: 1,
      mode: 'answer',
      answerMode: 'pick',
      phase: 'window',
      cursor: 2,
      stepStartedAt: ms(6_000),
      stepEndsAt: ms(9_500),
      pass: 1,
      maxPasses: 2,
      outcome: null,
      pickedOptionId: null,
    });
    assert.deepEqual(rows.safety, { state: 'ok', since: ms(-5_000) }, 'the station is online and healthy since the session started');
    assert.deepEqual(
      rows.pipelineEvents.map((e) => [e.id, e.questionId, e.stage, e.status, e.ms, e.at]),
      [
        ['40', '21', 'listen', 'ok', 0, ms(0)],
        ['41', '21', 'plan', 'started', null, ms(200)],
        ['42', '21', 'plan', 'ok', 120, ms(300)],
        ['43', '21', 'speak', 'started', null, ms(4_300)],
      ],
    );
    assert.deepEqual(rows.pipelineEvents[0]?.detail, { wordCount: 4, label: 'typed' });
    assert.deepEqual(rows.pipelineEvents[2]?.detail, { version: 1, optionCount: 4, final: true, label: 'options' });
    assert.deepEqual(rows.pipelineEvents[3]?.detail, { version: 1, optionCount: 4, label: 'scan started', channel: 'earpiece' });
  });

  test('the screens read it: Conversation, the partner phone and Live data follow option 2 in its window', () => {
    const rows = boardRows(midScan());
    const view = conversationOf(rows);
    assert.equal(view.question.id, '21');
    assert.equal(view.header.lead, 'Question 1', 'sharing is off, so no words');
    assert.equal(view.options.length, 4);
    assert.equal(view.cursor?.optionId, '102');
    assert.equal(view.cursor?.phase, 'window');
    assert.equal(view.legend, PICK_LEGEND);
    assert.deepEqual(view.pass, { pass: 1, max: 2 });
    assert.equal(partnerOf(rows).status.text, 'They are choosing, option 2 of 4.');
    const live = liveOf(rows);
    assert.deepEqual(live.firstOption, { kind: 'final', ms: 4_300 }, 'from heard to the first option in the earpiece');
    for (const view of [conversationOf(rows), partnerOf(rows), live]) assert.doesNotMatch(JSON.stringify(view), BROKEN);
  });

  test('only the board session: other sessions in the public tables and the ledger are dropped', () => {
    const rows = boardRows(
      midScan({
        scanStates: [scan({ sessionId: 5n, phase: { tag: 'Idle' }, questionId: 17n }), scan()],
        pipelineEvents: [event(1, 'q17:select', 'select', 'ok', 'picked', -60_000, { sessionId: 5n, questionId: 17n }), ...midScan().pipelineEvents],
        ledger: [ledger(400, 'gesture', -60_000, { sessionId: 5n, command: 'YES', gestureId: 'smoke-yes-old', outcome: 'accepted:pick_reply' }), ...midScan().ledger],
        questions: [question({ sessionId: 5n, questionId: 17n }), question()],
      }),
    );
    assert.deepEqual(rows.questions.map((q) => q.id), ['21']);
    assert.ok(rows.pipelineEvents.every((e) => e.sessionId === '6'));
    assert.deepEqual(rows.commands, []);
    assert.equal(rows.scan?.questionId, '21');
  });

  test('rows come out oldest first by their microsecond time, then by id, whatever order the cache gives', () => {
    const shuffled = midScan();
    const rows = boardRows({ ...shuffled, pipelineEvents: [...shuffled.pipelineEvents].reverse() });
    assert.deepEqual(rows.pipelineEvents.map((e) => e.id), ['40', '41', '42', '43']);
    const tie = boardRows(midScan({ pipelineEvents: [event(9, 'b', 'plan', 'ok', 'options', 50), event(8, 'a', 'plan', 'started', 'x', 50)] }));
    assert.deepEqual(tie.pipelineEvents.map((e) => e.id), ['8', '9']);
  });

  test('a stage or status outside the contract is not a step, and is dropped', () => {
    const rows = boardRows(midScan({ pipelineEvents: [event(1, 'k1', 'dance', 'ok', 'x', 0), event(2, 'k2', 'plan', 'done', 'x', 0), event(3, 'k3', 'plan', 'ok', 'options', 0)] }));
    assert.deepEqual(rows.pipelineEvents.map((e) => e.id), ['3']);
  });

  test('sharing on: the words, the reply, http sources only, and the shared payloads merged into the steps', () => {
    const shared = question({
      textShared: true,
      text: 'Smoke test: which drink? Call me at 415 555 0100',
      status: { tag: 'Spoken' },
      outcome: { tag: 'Picked' },
      pickedOptionId: 102n,
      replyText: 'Tea, please.',
      releasedAt: ts(7_000),
      spokenAt: ts(8_200),
      options: [
        option(1, { label: 'Water' }),
        option(2, {
          label: 'Tea',
          sources: [
            { source: 'web', url: 'https://example.com/tea', placeId: undefined, fetchedAt: '2026-10-24T13:00:00Z' },
            { source: 'web', url: 'javascript:alert(1)', placeId: undefined, fetchedAt: '2026-10-24T13:00:00Z' },
          ],
        }),
      ],
    });
    const payloads: BoardPayload[] = [
      { eventId: 40n, questionId: 21n, stage: 'listen', payloadJson: '{"words":"Smoke test: which drink? Call me at 415 555 0100"}' },
      { eventId: 50n, questionId: 21n, stage: 'select', payloadJson: '{"optionId":102,"rank":2,"text":"Tea"}' },
      { eventId: 51n, questionId: 21n, stage: 'speak', payloadJson: '{"optionId":102,"rank":2,"text":"Tea, please.","channel":"aloud","durationMs":900}' },
      {
        eventId: 44n,
        questionId: 21n,
        stage: 'retrieve',
        payloadJson: JSON.stringify({
          hits: [
            { id: 'm1', origin: 'memory', memoryType: 'pref', score: 0.8, sharedText: 'Likes tea.', savedAt: 1 },
            { id: 'm2', origin: 'memory', memoryType: 'reply', score: 0.7, text: 'a private memory that must not show' },
            null,
          ],
        }),
      },
    ];
    const rows = boardRows(
      midScan({
        config: [config({ shareTextOnBoard: true })],
        questions: [shared],
        scanStates: [scan({ phase: { tag: 'Idle' }, outcome: { tag: 'Picked' }, pickedOptionId: 102n, pickedRank: 2, cursor: 2 })],
        payloads,
        pipelineEvents: [
          event(40, 'listen:smoke-a1', 'listen', 'ok', 'typed', 0, { countsJson: '{"wordCount":9}' }),
          event(44, '7:1:retrieve:ok', 'retrieve', 'ok', 'recalled', 400, { countsJson: '{"hits":2}', actor: 'Agent' }),
          event(50, 'q21:select', 'select', 'ok', 'picked', 7_000, { countsJson: '{"rank":2,"pass":1}' }),
          event(51, 'q21:aloud', 'speak', 'ok', 'aloud', 8_200, { actor: 'Speaker' }),
        ],
      }),
    );
    const q = rows.questions[0]!;
    assert.equal(q.text, 'Smoke test: which drink? Call me at [number hidden]');
    assert.equal(q.replyText, 'Tea, please.');
    assert.equal(q.spokenAt, ms(8_200));
    assert.deepEqual(spokenReply(q), { text: 'Tea, please.', spokenAt: ms(8_200) });
    assert.deepEqual(rows.options.map((o) => o.text), ['Water', 'Tea']);
    assert.deepEqual(rows.options[1]?.sources, [{ source: 'web', url: 'https://example.com/tea', fetchedAt: '2026-10-24T13:00:00Z' }, { source: 'web', fetchedAt: '2026-10-24T13:00:00Z' }]);

    const byId = new Map(rows.pipelineEvents.map((e) => [e.id, e]));
    assert.deepEqual(byId.get('40')?.detail, { wordCount: 9, words: 'Smoke test: which drink? Call me at [number hidden]', label: 'typed' });
    assert.deepEqual(byId.get('50')?.detail, { rank: 2, pass: 1, optionId: '102', text: 'Tea', label: 'picked', kind: 'reply' }, 'the option id is a string id');
    assert.equal((byId.get('51')?.detail as Record<string, unknown>).channel, 'aloud');
    const hits = (byId.get('44')?.detail as { hits?: MossHit[] }).hits ?? [];
    assert.deepEqual(hits.map((hit) => hitDisplay(hit).text), ['Likes tea.', 'Private memory'], 'a hit that is not an object is dropped');
    assert.doesNotMatch(JSON.stringify(rows), /private memory that must not show/);

    const live = liveOf(rows);
    assert.equal(live.draft.pickedId, '102');
    assert.ok(live.actions.some((line) => line.kind === 'reply' && line.sentence === '"Tea, please."'), 'Said out loud shows the reply');
    assert.doesNotMatch(JSON.stringify(live), BROKEN);
  });

  test('sharing off hides every word the views hold back, even if a payload row slipped through', () => {
    const rows = boardRows(
      midScan({
        questions: [question({ status: { tag: 'Released' }, outcome: { tag: 'Picked' }, pickedOptionId: 102n, releasedAt: ts(7_000) })],
        errands: [errand({ readBackText: 'should not show', readBackJson: '[{"label":"Item","value":"water"}]', confirmationText: 'should not show', screenshotUrl: 'https://example.com/shot.png' })],
        calls: [call({ readBackText: 'should not show', endReason: 'should not show', transcript: [{ role: 'recipient', text: 'should not show', at: ts(40_000) }] })],
      }),
    );
    assert.equal(rows.questions[0]?.text, null);
    assert.equal(rows.questions[0]?.replyText, null);
    const e = rows.errands[0]!;
    assert.equal(e.form, 'Form');
    assert.equal(e.readBackText, null);
    assert.deepEqual(e.readBack, []);
    assert.equal(e.confirmationText, null);
    assert.equal(e.screenshotUrl, null);
    const c = rows.calls[0]!;
    assert.equal(c.contactName, 'Contact');
    assert.equal(c.readBackText, null);
    assert.equal(c.endReason, null);
    assert.deepEqual(c.transcript, []);
    assert.doesNotMatch(JSON.stringify(rows), /should not show/);
  });

  test('an errand: every time column, the digest, the read-back items, and the gesture ids that released or stopped it', () => {
    const rows = boardRows(
      midScan({
        config: [config({ shareTextOnBoard: true })],
        errands: [
          errand({
            status: { tag: 'Submitted' },
            textShared: true,
            formTitle: 'Smoke form',
            readBackText: 'Smoke form. Item: water. Nothing will be sent anywhere.',
            readBackJson: '[{"label":"Item","value":"water"},{"label":"Phone","value":"415-555-0100","source":"memory"},{"nope":1}]',
            confirmationText: 'Smoke test: the gate released it; nothing was sent anywhere.',
            screenshotUrl: 'ftp://example.com/shot.png',
            confirmGestureId: 'smoke-confirm-1a2b3c4d',
            confirmedAt: ts(16_000),
            claimedAt: ts(16_300),
            submittedAt: ts(16_700),
            endedAt: ts(16_700),
          }),
        ],
      }),
    );
    assert.deepEqual(rows.errands[0], {
      id: '12',
      questionId: '21',
      optionId: null,
      form: 'Smoke form',
      status: 'sent',
      previewDigest: '9f2c4a1b7e3d5c60',
      readBackText: 'Smoke form. Item: water. Nothing will be sent anywhere.',
      readBack: [
        { label: 'Item', value: 'water' },
        { label: 'Phone', value: '[number hidden]', source: 'memory' },
      ],
      confirmationText: 'Smoke test: the gate released it; nothing was sent anywhere.',
      screenshotUrl: null,
      confirmClosesAt: ms(23_000),
      confirmOpensAt: ms(15_000),
      reason: null,
      reasonCode: null,
      confirmCommandId: 'smoke-confirm-1a2b3c4d',
      stopCommandId: null,
      createdAt: ms(10_000),
      previewedAt: ms(11_000),
      previewMs: null,
      readAloudAt: ms(14_000),
      confirmedAt: ms(16_000),
      sentAt: ms(16_700),
      endedAt: ms(16_700),
    });
  });

  test('the errand waiting for CONFIRM drives the Agents headline and the countdown', () => {
    const rows = boardRows(midScan({ errands: [errand()] }));
    const e = rows.errands[0]!;
    assert.equal(e.status, 'awaiting_confirm');
    assert.equal(errandHeadline(e, rows.safety.state, rows.input).text, 'Waiting for the person to confirm. Nothing has been sent.');
  });

  test('rows written before module v2: a select step that names no option is dropped, and an errand without an option id gets the pick', () => {
    const rows = boardRows(
      midScan({
        questions: [
          question({
            status: { tag: 'Acting' },
            outcome: { tag: 'Picked' },
            pickedOptionId: 101n,
            options: [option(1, { kind: { tag: 'Errand' }, tone: 'calm' }), option(2, { tone: 'neutral' })],
          }),
        ],
        scanStates: [scan({ phase: { tag: 'Idle' }, outcome: { tag: 'Picked' }, pickedOptionId: 101n, pickedRank: 1, cursor: 1, stepStartedAt: ts(7_000), stepEndsAt: ts(7_000) })],
        pipelineEvents: [
          event(72, 'q19:select', 'select', 'error', 'failed', 5_000, { questionId: 19n }),
          event(71, 'q20:select', 'select', 'ok', 'no pick', 6_000, { questionId: 20n, countsJson: '{"pass":2}' }),
          event(70, 'q21:select', 'select', 'ok', 'picked', 7_000, { countsJson: '{"rank":1,"pass":1}', ms: 0 }),
          event(73, 'q21:scan:end', 'speak', 'ok', 'scan ended', 7_000),
        ],
        errands: [errand({ status: { tag: 'Drafted' }, createdAt: ts(7_000), previewedAt: undefined, readbackDoneAt: undefined, confirmOpensAt: undefined, confirmClosesAt: undefined })],
      }),
    );
    assert.deepEqual(rows.pipelineEvents.map((e) => e.id), ['70', '73'], 'only the pick is a select step');
    assert.deepEqual(rows.pipelineEvents[0]?.detail, { rank: 1, pass: 1, label: 'picked', optionId: '101', kind: 'errand' });
    assert.equal(rows.errands[0]?.optionId, '101');
    assert.equal(rows.errands[0]?.status, 'preparing');
    const partner = partnerOf(rows);
    assert.equal(partner.status.text, 'Getting their request ready.');
    assert.equal(partner.answer?.text, 'They chose an errand.');
    assert.equal(conversationOf(rows).agent?.sentence, 'Filling in the form. Nothing is sent yet.');
  });

  test('a scan that ended with no pick reads as no pick on every screen, never as a pick (and an old "no pick" step names no option)', () => {
    const rows = boardRows(
      midScan({
        questions: [question({ status: { tag: 'NoPick' }, outcome: { tag: 'NoPick' } })],
        scanStates: [scan({ phase: { tag: 'Idle' }, outcome: { tag: 'NoPick' }, cursor: 4, pass: 2, stepStartedAt: ts(40_000), stepEndsAt: ts(40_000) })],
        pipelineEvents: [
          ...midScan().pipelineEvents,
          event(80, 'q21:select', 'select', 'ok', 'no pick', 40_000, { countsJson: '{"pass":2}', ms: 0 }),
          event(81, 'q21:scan:end', 'speak', 'ok', 'scan ended', 40_000),
        ],
      }),
    );
    assert.ok(!rows.pipelineEvents.some((e) => e.stage === 'select'));
    assert.equal(liveOf(rows).cards.find((card) => card.stage === 'select')?.word, 'No pick');
    assert.equal(partnerOf(rows).answer?.text, PARTNER_TEXT.noAnswer);
    assert.equal(conversationOf(rows).ending?.outcome, 'no_pick');
  });

  test('every module errand and call state has a web state the screens know', () => {
    for (const status of Object.values(ERRAND_STATUSES)) assert.ok(statusFromErrand(status));
    for (const status of Object.values(CALL_STATUSES)) assert.ok(statusFromCall(status));
    assert.equal(ERRAND_STATUSES.Drafted, 'preparing');
    assert.equal(ERRAND_STATUSES.Previewed, 'reading_back');
    assert.equal(ERRAND_STATUSES.Submitted, 'sent');
    assert.equal(ERRAND_STATUSES.UnknownOutcome, 'unknown_outcome');
    assert.equal(CALL_STATUSES.AwaitingConfirm, 'awaiting_confirm');
  });

  test('a call: the name only with numbers hidden, the result, the hang-up request and the transcript', () => {
    const rows = boardRows(
      midScan({
        config: [config({ shareTextOnBoard: true })],
        calls: [
          call({
            status: { tag: 'Ended' },
            result: 'cancelled',
            textShared: true,
            contactName: 'Demo caregiver (415) 555-0100',
            endReason: 'The person hung up with STOP.',
            cancelRequested: true,
            endedAt: ts(45_000),
            transcript: [
              { role: 'assistant', text: 'Hi, this is a call for Demo user. Call back at 415 555 0100.', at: ts(39_500) },
              { role: 'robot', text: 'not a role', at: ts(40_000) },
              { role: 'recipient', text: 'Sure.', at: ts(41_000) },
            ],
          }),
        ],
      }),
    );
    const c = rows.calls[0]!;
    assert.equal(c.contactName, 'Demo caregiver [number hidden]');
    assert.equal(c.status, 'ended');
    assert.equal(c.result, 'cancelled');
    assert.equal(c.cancelRequested, true);
    assert.equal(c.startedAt, ms(39_000));
    assert.deepEqual(c.transcript, [
      { id: '3:0', role: 'assistant', text: 'Hi, this is a call for Demo user. Call back at [number hidden].', at: ms(39_500) },
      { id: '3:2', role: 'recipient', text: 'Sure.', at: ms(41_000) },
    ]);
    assert.equal(boardRows(midScan({ calls: [call({ result: 'exploded' })] })).calls[0]?.result, null, 'a result outside the list is no result');
  });

  test('errand and call steps name their row from the event key; a speak step gets its channel from the label', () => {
    const rows = boardRows(
      midScan({
        pipelineEvents: [
          event(60, 'e12:previewed', 'errand', 'ok', 'previewed', 11_000),
          event(61, 'c3:dialing', 'call', 'started', 'dialing', 33_200),
          event(62, 'q21:v1:clips', 'speak', 'ok', 'earpiece', 4_000, { countsJson: '{"clips":4,"synthMs":0}' }),
          event(63, 'q21:aloud', 'speak', 'ok', 'aloud', 8_000),
        ],
      }),
    );
    const detail = (id: string) => rows.pipelineEvents.find((e) => e.id === id)?.detail as Record<string, unknown>;
    assert.equal(detail('60').errandId, '12');
    assert.equal(detail('61').callId, '3');
    assert.equal(detail('62').channel, 'earpiece');
    assert.equal(detail('63').channel, 'aloud');
  });

  test('commands are the ledger gesture rows: accepted, ignored with a reason in words, D11 names only', () => {
    const rows = boardRows(
      midScan({
        ledger: [
          ...midScan().ledger,
          ledger(510, 'gesture', 6_100, { command: 'YES', gestureId: 'smoke-yes-1', questionId: 21n, optionId: 102n, outcome: 'accepted:pick_reply', cursor: 2 }),
          ledger(511, 'gesture', 6_400, { command: 'YES', gestureId: 'smoke-yes-2', outcome: 'ignored:refractory', reason: 'refractory' }),
          ledger(512, 'gesture', 6_500, { command: 'CONFIRM', gestureId: 'smoke-confirm-3', outcome: 'ignored:quiet_hold', reason: 'quiet_hold', errandId: 12n }),
          ledger(513, 'gesture', 6_600, { command: 'STOP', gestureId: '', outcome: 'accepted:stop_errand_hang_up' }),
          ledger(514, 'gesture', 6_700, { command: 'SELECT', gestureId: 'old-name', outcome: 'accepted:pick' }),
          ledger(515, 'pick', 6_100, { questionId: 21n, optionId: 102n, outcome: 'reply' }),
        ],
      }),
    );
    assert.deepEqual(rows.commands, [
      { id: 'smoke-yes-1', command: 'YES', at: ms(6_100), accepted: true, ignoredReason: null, confidence: null, questionId: '21', optionId: '102' },
      { id: 'smoke-yes-2', command: 'YES', at: ms(6_400), accepted: false, ignoredReason: 'Repeat inside the refractory time', confidence: null, questionId: null, optionId: null },
      { id: 'smoke-confirm-3', command: 'CONFIRM', at: ms(6_500), accepted: false, ignoredReason: 'Too soon after the read-back', confidence: null, questionId: null, optionId: null },
      { id: 'ledger:513', command: 'STOP', at: ms(6_600), accepted: true, ignoredReason: null, confidence: null, questionId: null, optionId: null },
    ]);
  });

  test('ignored reasons in words: known codes, unknown codes as words, and no object property names', () => {
    assert.equal(ignoredReasonWords('stale_step'), 'Arrived after its option had moved on');
    assert.equal(ignoredReasonWords('line_busy'), 'Line busy');
    assert.equal(ignoredReasonWords('constructor'), 'Constructor');
    assert.equal(ignoredReasonWords('  '), 'Ignored');
  });

  test('the scan: cursor 0 is no cursor, the yes or no prompt and the menu, and the pick after the session ended', () => {
    const yesNo = boardRows(midScan({ scanStates: [scan({ answerMode: { tag: 'YesNo' }, cursor: 0, phase: { tag: 'Reading' } })] })).scan!;
    assert.equal(yesNo.answerMode, 'yes_no');
    assert.equal(yesNo.cursor, null);
    const menu = boardRows(midScan({ scanStates: [scan({ mode: { tag: 'Menu' }, phase: { tag: 'Veto' }, pickedOptionId: 103n })] })).scan!;
    assert.equal(menu.mode, 'menu');
    assert.equal(menu.phase, 'veto');
    assert.equal(menu.pickedOptionId, '103');
    // Before module v2, end_session kept the outcome but cleared the scan's picked id; the question keeps it.
    const ended = boardRows(
      midScan({
        scanStates: [scan({ phase: { tag: 'Idle' }, outcome: { tag: 'Picked' }, pickedOptionId: undefined })],
        questions: [question({ status: { tag: 'Spoken' }, outcome: { tag: 'Picked' }, pickedOptionId: 104n })],
      }),
    ).scan!;
    assert.equal(ended.outcome, 'picked');
    assert.equal(ended.pickedOptionId, '104');
    const noPick = boardRows(midScan({ scanStates: [scan({ phase: { tag: 'Idle' }, outcome: { tag: 'NoPick' } })] })).scan!;
    assert.equal(noPick.outcome, 'no_pick');
    assert.equal(noPick.pickedOptionId, null);
  });

  test('safety: headset off, the other pauses, no station online, and an ended session', () => {
    const paused = (reason: NonNullable<ScanRow['pauseReason']>['tag']) =>
      boardRows(midScan({ scanStates: [scan({ phase: { tag: 'Paused' }, pauseReason: { tag: reason }, pausedAt: ts(7_000) })] })).safety;
    assert.deepEqual(paused('HeadsetOff'), { state: 'headset_off', since: ms(7_000) });
    for (const reason of ['HeadsetLost', 'Stop', 'Idle', 'Operator'] as const) assert.deepEqual(paused(reason), { state: 'paused', since: ms(7_000) });
    assert.deepEqual(boardRows(midScan({ devices: [station({ online: false })] })).safety, { state: 'unknown', since: null });
    assert.deepEqual(boardRows(midScan({ devices: [station({ decoderHealthy: false })] })).safety, { state: 'unknown', since: null });
    assert.deepEqual(boardRows(midScan({ devices: [station({ role: { tag: 'Agent' } })] })).safety, { state: 'unknown', since: null });
    const ended = boardRows(midScan({ ledger: [...midScan().ledger, ledger(520, 'session_end', 60_000)] }));
    assert.deepEqual(ended.safety, { state: 'unknown', since: null }, 'nobody wears the headset after the session ends');
    const resumed = boardRows(midScan({ ledger: [...midScan().ledger, ledger(521, 'pause', 2_000), ledger(522, 'resume', 5_500)] }));
    assert.deepEqual(resumed.safety, { state: 'ok', since: ms(5_500) });
  });

  test('a malformed payload or read-back never throws', () => {
    assert.deepEqual(readBackItems('{not json'), []);
    assert.deepEqual(readBackItems('{"label":"x"}'), []);
    const rows = boardRows(
      midScan({
        config: [config({ shareTextOnBoard: true })],
        payloads: [{ eventId: 40n, questionId: 21n, stage: 'listen', payloadJson: '{not json' }],
      }),
    );
    assert.equal(rows.pipelineEvents[0]?.detail.error?.sentence, "This step's details could not be read.");
  });
});

describe('the phone when the memory recall fails', () => {
  test('the lookup reads as done without the memory once options came, failed only while nothing else ran', () => {
    const base = midScan().pipelineEvents;
    const withRecallError = (extra: ReturnType<typeof event>[]) =>
      partnerOf(boardRows(midScan({ pipelineEvents: [...base.slice(0, 1), ...extra, ...base.slice(1)] })));
    const done = withRecallError([
      event(45, '7:1:search:ok', 'search', 'ok', 'searched', 150, { countsJson: '{"rows":3}', actor: 'Agent' }),
      event(46, '7:1:retrieve:error', 'retrieve', 'error', 'moss closed', 180, { actor: 'Agent' }),
    ]);
    const step = done.steps.find((s) => s.key === 'looked-up');
    assert.equal(step?.status, 'done', 'options came, so the lookup did not fail the turn');
    assert.equal(step?.statusWord, 'Done without the memory lookup');

    const early = partnerOf(
      boardRows(midScan({ pipelineEvents: [base[0]!, event(46, '7:1:retrieve:error', 'retrieve', 'error', 'moss closed', 180, { actor: 'Agent' })] })),
    );
    assert.equal(early.steps.find((s) => s.key === 'looked-up')?.status, 'failed', 'with nothing after it, the failure shows');
  });
});
