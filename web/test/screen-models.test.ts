/**
 * Every screen model, run over one loop of the sample replay the way its screen calls it. Pure, no
 * React and no browser: this checks the words each screen would show at each moment, and that no
 * screen ever prints a broken value or something it must keep private.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { callBadge, callHeadline, errandBadge, errandHeadline } from '../components/agents/model';
import { buildConversationView, focusQuestion, PICK_LEGEND } from '../components/conversation/model';
import { buildLiveView } from '../components/live/model';
import { buildPartnerView, PARTNER_TEXT } from '../components/partner/model';
import { eventsForQuestion, hitDisplay, latestQuestion, spokenReply } from '../lib/data/derive';
import { LOOP_MS, replayRowsAt } from '../lib/data/replay';
import type { DataRows } from '../lib/data/types';

const START = Date.UTC(2026, 9, 24, 19, 40, 0);
const at = (seconds: number) => replayRowsAt(START, START + Math.round(seconds * 1_000));

function partnerAt(rows: DataRows) {
  const question = latestQuestion(rows.questions);
  return buildPartnerView({
    question,
    events: eventsForQuestion(rows.pipelineEvents, question?.id ?? null),
    options: rows.options,
    errands: rows.errands,
    calls: rows.calls,
    scan: rows.scan,
    safety: rows.safety,
    input: rows.input,
    canType: false,
  });
}

function conversationAt(rows: DataRows) {
  const question = focusQuestion(rows.questions, rows.scan);
  assert.ok(question, 'a question exists');
  return buildConversationView({
    question,
    scan: rows.scan,
    options: rows.options,
    events: eventsForQuestion(rows.pipelineEvents, question.id),
    errands: rows.errands,
    calls: rows.calls,
    safety: rows.safety,
    input: rows.input,
    hasReply: spokenReply(question) !== null,
  });
}

function liveAt(rows: DataRows) {
  const question = latestQuestion(rows.questions);
  assert.ok(question, 'a question exists');
  return buildLiveView({
    question,
    nextQuestion: null,
    events: eventsForQuestion(rows.pipelineEvents, question.id),
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

describe('screen models over the sample replay', () => {
  test('no screen ever shows a broken value, every 100 ms of a loop', () => {
    for (let t = 0; t < LOOP_MS; t += 100) {
      const rows = replayRowsAt(START, START + t);
      for (const [name, view] of [
        ['partner', partnerAt(rows)],
        ['conversation', conversationAt(rows)],
        ['live', liveAt(rows)],
      ] as const) {
        const json = JSON.stringify(view);
        assert.doesNotMatch(json, BROKEN, `${name} at ${t} ms`);
      }
    }
  });

  test('the partner phone follows the question in plain words', () => {
    assert.equal(partnerAt(at(1)).status.text, PARTNER_TEXT.listening);
    // Direct select (D18): the list is read once, numbered, then the wait for a pick.
    assert.equal(partnerAt(at(7)).status.text, 'They are choosing, option 3 of 3.');
    assert.equal(partnerAt(at(7)).hint, PARTNER_TEXT.listeningToOptions);
    assert.equal(partnerAt(at(10)).status.text, 'They are choosing from 3 options.');
    assert.equal(partnerAt(at(15)).status.text, PARTNER_TEXT.answered);
    assert.equal(partnerAt(at(15)).answer?.text, 'The cafe on Bay St, it has a ramp.');
    assert.match(partnerAt(at(29)).status.text, /confirm/i);
    assert.match(partnerAt(at(43.5)).status.text, /confirm the call/i);
    assert.equal(partnerAt(at(61.5)).status.text, PARTNER_TEXT.paused);
    assert.equal(partnerAt(at(65)).status.text, PARTNER_TEXT.headsetOff);
  });

  test('the partner phone never shows the words of an option the person did not pick', () => {
    const notPicked = ['The hospital cafeteria is fine.', "The Thai place on Lombard, it's quiet.", 'Send the care team a dinner request.', 'Call Demo caregiver to meet us there.', 'Nothing else.'];
    for (let t = 0; t < LOOP_MS; t += 250) {
      const json = JSON.stringify(partnerAt(replayRowsAt(START, START + t)));
      for (const words of notPicked) assert.ok(!json.includes(words), `"${words}" at ${t} ms`);
    }
  });

  test('Live conversation reads the numbered list with real word timings, waits for a pick, and says the pick at once', () => {
    const reading = conversationAt(at(7));
    assert.equal(reading.cursor?.phase, 'reading');
    assert.ok(reading.cursor?.words && reading.cursor.words.length === 4, 'the clip word timings ("Three: Cafe on Bay.") arrive with the start of the read');
    assert.equal(reading.legend, PICK_LEGEND);
    assert.deepEqual(reading.pass, { pass: 1, max: 1 });
    const wait = conversationAt(at(10));
    assert.equal(wait.cursor?.optionId, null);
    assert.equal(wait.cursor?.waitingFor, '1 to 3', 'three options, one per pick gesture (D21)');
    assert.equal(wait.cursor?.phase, 'window');
    const picked = conversationAt(at(12));
    assert.equal(picked.vetoing, false, 'no veto in direct select');
    assert.equal(picked.picked?.text, 'The cafe on Bay St, it has a ramp.');
    const waiting = conversationAt(at(29));
    assert.equal(waiting.agent?.kind, 'errand');
    assert.equal(waiting.agent?.status, 'waiting');
    assert.equal(waiting.agent?.sentence, 'Waiting for 3 to send. Nothing is sent yet.');
    assert.equal(conversationAt(at(61.5)).paused, 'paused');
    assert.equal(conversationAt(at(65)).paused, 'headset_off');
  });

  test('Agents: the confirm waits, the send is shown, and STOP during the call shows the hang-up', () => {
    const waiting = at(29).errands[0]!;
    assert.equal(errandHeadline(waiting, 'ok', 'headset').text, 'Waiting for the person to confirm. Nothing has been sent.');
    assert.equal(errandBadge(waiting, 'ok').status, 'waiting');
    assert.equal(errandHeadline(at(33).errands[0]!, 'ok', 'headset').status, 'done');
    assert.equal(errandHeadline(at(33).errands[0]!, 'ok', 'headset').text, 'Sent after the person confirmed with a jaw clench.');
    const hangingUp = at(58.8).calls[0]!;
    assert.equal(hangingUp.status, 'connected');
    assert.equal(hangingUp.cancelRequested, true);
    assert.equal(callHeadline(hangingUp, 'ok', 'headset').text, 'Hanging up on Demo caregiver. The person used STOP.');
    assert.equal(callBadge(hangingUp, 'ok').word, 'Hanging up');
    assert.equal(conversationAt(at(58.8)).agent?.sentence, 'Hanging up on Demo caregiver.', 'Conversation says it too');
    assert.equal(partnerAt(at(58.8)).status.text, 'Hanging up.', 'and the phone, without the name');
    const ended = at(60).calls[0]!;
    assert.equal(ended.status, 'ended');
    assert.equal(callHeadline(ended, 'ok', 'headset').text, 'The call ended. The person hung up with STOP.');
  });

  test('Live data: the shared memory shows its words and the private one reads "Private memory"', () => {
    const view = liveAt(at(15));
    // The panel renders every hit through hitDisplay, as here.
    const shown = view.recall.hits.map(hitDisplay);
    assert.deepEqual(
      shown.filter((hit) => hit.origin === 'memory').map((hit) => hit.text),
      ['Sample shared memory: Demo user likes quiet places with a ramp.', 'Private memory'],
    );
    assert.ok(view.recall.hits.every((hit) => hit.origin === 'web' || hit.text === undefined), 'no memory text rides in `text`');
    assert.deepEqual(view.firstOption, { kind: 'final', ms: 2_900 }, '2.9 s to the first option');
  });
});
