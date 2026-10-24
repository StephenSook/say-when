/**
 * The live board mapping over rows recorded from say-when-dev (test/fixtures/board-recorded.json): smoke session 6,
 * read through the generated web bindings while the module's own smoke test drove it, in the runtime shapes the SDK
 * gives (enums as { tag, value }, unset options left out). Four moments: option 2's response window, an errand
 * waiting for CONFIRM, the room's sharing toggle on, and the dead-man pause. All content is made-up smoke content.
 *
 * Recorded before module v2 (docs/spacetime.md 14), so these are the older shapes: one speak step per scan, a select
 * step for every scan ending, no option id on errand rows, no word timings, and a pause that cleared the scan's pick.
 * The mapping still reads them right; test/board-v2.test.ts covers the v2 shapes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Identity, Timestamp } from 'spacetimedb';
import { errandBadge, errandHeadline } from '../components/agents/model';
import { buildConversationView, focusQuestion } from '../components/conversation/model';
import { buildLiveView } from '../components/live/model';
import { buildPartnerView, PARTNER_TEXT } from '../components/partner/model';
import { eventsForQuestion, latestQuestion, spokenReply } from '../lib/data/derive';
import { boardRows, type BoardSnapshot } from '../lib/data/spacetime-map';
import type { DataRows } from '../lib/data/types';

type Moment = 'mid_scan' | 'awaiting_confirm' | 'shared' | 'paused';

const RECORDED = JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'board-recorded.json'), 'utf8')) as {
  moments: Record<Moment, { recordedAtMs: number; board: unknown }>;
};

/** The fixture's markers back into SDK values: #b: a u64 (bigint), #t: a Timestamp in microseconds, #i: an identity. */
function revive(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^#b:\d+$/.test(value)) return BigInt(value.slice(3));
    if (/^#t:\d+$/.test(value)) return new Timestamp(BigInt(value.slice(3)));
    if (value === '#i:zero') return Identity.zero();
    return value;
  }
  if (Array.isArray(value)) return value.map(revive);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  return value;
}

function rowsAt(name: Moment): DataRows {
  return boardRows(revive(RECORDED.moments[name].board) as BoardSnapshot);
}

function views(rows: DataRows) {
  const focus = focusQuestion(rows.questions, rows.scan);
  const newest = latestQuestion(rows.questions);
  assert.ok(focus && newest, 'a question exists');
  const conversation = buildConversationView({
    question: focus,
    scan: rows.scan,
    options: rows.options,
    events: eventsForQuestion(rows.pipelineEvents, focus.id),
    errands: rows.errands,
    calls: rows.calls,
    safety: rows.safety,
    input: rows.input,
    hasReply: spokenReply(focus) !== null,
  });
  const partner = buildPartnerView({
    question: newest,
    events: eventsForQuestion(rows.pipelineEvents, newest.id),
    options: rows.options,
    errands: rows.errands,
    calls: rows.calls,
    scan: rows.scan,
    safety: rows.safety,
    input: rows.input,
    canType: false,
  });
  const live = buildLiveView({
    question: newest,
    nextQuestion: null,
    events: eventsForQuestion(rows.pipelineEvents, newest.id),
    options: rows.options,
    errands: rows.errands,
    calls: rows.calls,
    scan: rows.scan,
    safety: rows.safety,
    input: rows.input,
    freezeAt: null,
  });
  return { conversation, partner, live };
}

/** Text that only shows up when a value went missing on the way to the screen. */
const BROKEN = /undefined|NaN|\[object Object\]|Infinity/;
/** Words that exist only in the smoke test's private content. */
const PRIVATE_WORDS = /Smoke test|which drink|water|Send the smoke request|Yes, please/;

describe('boardRows over rows recorded from say-when-dev', () => {
  test('the fixture is real: four moments of session 6, with the SDK shapes', () => {
    assert.deepEqual(Object.keys(RECORDED.moments).sort(), ['awaiting_confirm', 'mid_scan', 'paused', 'shared']);
    const board = revive(RECORDED.moments.mid_scan.board) as BoardSnapshot;
    assert.equal(board.config[0]?.activeSessionId, 6n);
    assert.ok(board.scanStates.length > 1, 'scan rows of earlier sessions are there too');
    assert.deepEqual(board.scanStates.find((row) => row.sessionId === 6n)?.phase, { tag: 'Window', value: {} });
  });

  test("option 2's response window: the cursor, the time left, the partner's sentence and the first-option time", () => {
    const rows = rowsAt('mid_scan');
    assert.deepEqual(rows.questions.map((q) => [q.id, q.number, q.text, q.via, q.origin]), [['18', 1, null, 'typed', 'partner']]);
    assert.deepEqual(rows.options.map((o) => [o.id, o.text]), [['51', 'Option 1'], ['52', 'Option 2'], ['53', 'Option 3'], ['54', 'Option 4']]);
    const scan = rows.scan!;
    assert.deepEqual([scan.phase, scan.cursor, scan.pass, scan.maxPasses, scan.outcome], ['window', 2, 1, 2, null]);
    assert.equal(scan.stepEndsAt - scan.stepStartedAt, 3500, 'the response window is config.response_window_ms');
    assert.equal(rows.safety.state, 'ok', 'the smoke station was online and healthy');
    assert.deepEqual(rows.pipelineEvents.map((e) => `${e.stage} ${e.status}`), ['listen ok', 'plan started', 'plan ok', 'speak started']);
    const { conversation, partner, live } = views(rows);
    assert.equal(conversation.cursor?.optionId, '52');
    assert.equal(conversation.cursor?.phase, 'window');
    assert.equal(partner.status.text, 'They are choosing, option 2 of 4.');
    assert.equal(live.firstOption?.kind, 'final');
    const heardToFirst = rows.pipelineEvents[3]!.at - rows.pipelineEvents[0]!.at;
    assert.deepEqual(live.firstOption, { kind: 'final', ms: heardToFirst });
    assert.ok(heardToFirst >= 4_000 && heardToFirst < 6_000, `${heardToFirst} ms: the 4 s clip deadline, since no station made clips`);
    for (const view of [conversation, partner, live]) assert.doesNotMatch(JSON.stringify(view), BROKEN);
    assert.doesNotMatch(JSON.stringify(rows), PRIVATE_WORDS);
  });

  test('an errand waiting for CONFIRM: its option, the countdown, every screen, and only real picks as select steps', () => {
    const rows = rowsAt('awaiting_confirm');
    const errand = rows.errands[0]!;
    assert.deepEqual([errand.id, errand.questionId, errand.optionId, errand.status], ['5', '21', '61', 'awaiting_confirm']);
    assert.match(errand.previewDigest ?? '', /^[0-9a-f]{16}$/);
    assert.ok(errand.confirmClosesAt !== null && errand.readAloudAt !== null && errand.confirmClosesAt > errand.readAloudAt);
    assert.equal(errandHeadline(errand, rows.safety.state, rows.input).text, 'Waiting for the person to confirm. Nothing has been sent.');
    assert.equal(errandBadge(errand, rows.safety.state).countdownTo, errand.confirmClosesAt);
    const { conversation, partner, live } = views(rows);
    assert.equal(conversation.picked?.id, '61');
    // The recorded session's label is "smoke", which names no input mode, so no jaw clench is claimed (W1).
    assert.equal(rows.input, 'unknown');
    assert.equal(conversation.agent?.sentence, 'Waiting for CONFIRM. Nothing is sent yet.');
    assert.equal(partner.status.text, 'Waiting for them to confirm.');
    // Question 1 ended with no pick: its old "no pick" select step names no option, so it is not shown as a pick.
    const selects = rows.pipelineEvents.filter((e) => e.stage === 'select');
    assert.deepEqual(selects.map((e) => [e.questionId, e.detail.optionId, e.detail.kind]), [['19', '55', 'reply'], ['20', '57', 'reply'], ['21', '61', 'errand']]);
    assert.deepEqual(
      rows.commands.map((c) => [c.command, c.accepted, c.ignoredReason]),
      [
        ['YES', true, null],
        ['YES', true, null],
        ['YES', true, null],
        ['YES', false, 'YES does not confirm. Only CONFIRM sends'],
        ['CONFIRM', false, 'The read-back had not finished'],
      ],
    );
    for (const view of [conversation, partner, live]) assert.doesNotMatch(JSON.stringify(view), BROKEN);
    assert.doesNotMatch(JSON.stringify(rows), PRIVATE_WORDS);
  });

  test('sharing on: the words, the replies, the read-back and the sent form, with the CONFIRM that released it', () => {
    const rows = rowsAt('shared');
    assert.deepEqual(rows.questions.map((q) => q.text), [
      'Smoke test: which drink?',
      'Smoke test [yes_no]: is the room warm enough?',
      'Smoke test: which snack?',
      'Smoke test [errand]: send the request?',
    ]);
    assert.deepEqual(rows.questions.map((q) => q.replyText), [null, 'Yes, please', 'Water', null]);
    assert.deepEqual(rows.options.filter((o) => o.questionId === '21').map((o) => o.text), ['Send the smoke request', 'Not now']);
    const heard = rows.pipelineEvents.filter((e) => e.stage === 'listen').map((e) => e.detail.words);
    assert.deepEqual(heard, rows.questions.map((q) => q.text), "the listen steps carry the partner's words");
    const errand = rows.errands[0]!;
    assert.equal(errand.status, 'sent');
    assert.equal(errand.form, 'Smoke form');
    assert.deepEqual(errand.readBack, [{ label: 'Item', value: 'water' }]);
    assert.equal(errand.readBackText, 'Smoke form. Item: water. Nothing will be sent anywhere.');
    assert.equal(errand.confirmationText, 'Smoke test: the gate released it; nothing was sent anywhere.');
    const confirm = rows.commands.find((c) => c.id === errand.confirmCommandId);
    assert.deepEqual([confirm?.command, confirm?.accepted], ['CONFIRM', true]);
    const { conversation, live } = views(rows);
    assert.deepEqual(conversation.header, { eyebrow: 'The partner typed', lead: 'Smoke test [errand]: send the request?', quoted: true });
    assert.equal(conversation.agent?.sentence, 'Sent: Smoke form.');
    assert.equal(live.heardWords, 'Smoke test [errand]: send the request?');
    for (const view of Object.values(views(rows))) assert.doesNotMatch(JSON.stringify(view), BROKEN);
  });

  test('the dead-man pause: Paused on every screen, and the pick still known after the pause cleared it', () => {
    const rows = rowsAt('paused');
    const scan = rows.scan!;
    assert.equal(scan.phase, 'paused');
    assert.equal(scan.outcome, 'picked');
    assert.equal(scan.pickedOptionId, '61', "before module v2 the pause cleared the scan's picked id; the question keeps it");
    assert.deepEqual(rows.safety, { state: 'paused', since: scan.stepStartedAt });
    const { conversation, partner } = views(rows);
    assert.equal(conversation.paused, 'paused');
    assert.equal(partner.status.text, PARTNER_TEXT.paused);
    assert.doesNotMatch(JSON.stringify(rows), PRIVATE_WORDS);
  });
});
