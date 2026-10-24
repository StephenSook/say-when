/**
 * One pipeline event's detail from the module's three columns (lib/data/spacetime-map.ts pipelineDetail):
 * the label, `counts_json` and the board's `payload_json`. The labels and counts below are the ones the
 * module and the agent sidecar write (docs/spacetime.md 11.4, agent/src/retrieval.ts).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hitDisplay } from '../lib/data/derive';
import { pipelineDetail, STAGE_ERROR_SENTENCES } from '../lib/data/spacetime-map';

describe('pipelineDetail', () => {
  test('counts, then the shared payload, plus the label', () => {
    const detail = pipelineDetail('listen', 'ok', 'heard', '{"wordCount":9}', '{"words":"Where can we get dinner near the hospital tonight?"}');
    assert.deepEqual(detail, { wordCount: 9, words: 'Where can we get dinner near the hospital tonight?', label: 'heard' });
  });

  test('the board does not share text: the counts and the label still show', () => {
    const detail = pipelineDetail('search', 'ok', 'web', '{"needsWeb":true,"searches":1,"rowCount":6,"partial":false}', null);
    assert.deepEqual(detail, { needsWeb: true, searches: 1, rowCount: 6, partial: false, label: 'web' });
  });

  test('a count named like a payload list is renamed, so a number never stands in for the list', () => {
    const search = pipelineDetail('search', 'ok', 'web', '{"rows":6}', '{"rows":[{"id":"r1","source":"web","title":"A","fetchedAt":"2026-10-24T19:40:04Z"}]}');
    assert.equal(search.rowCount, 6);
    assert.equal(search.rows?.length, 1);
    const retrieve = pipelineDetail('retrieve', 'ok', 'recalled', '{"hits":4}', null);
    assert.equal(retrieve.hitCount, 4);
    assert.equal(retrieve.hits, undefined);
    const listen = pipelineDetail('listen', 'ok', 'heard', '{"words":9}', null);
    assert.equal(listen.wordCount, 9);
    assert.equal(listen.words, undefined);
  });

  test('a failed step gets its sentence, with the label as the raw text for the tooltip', () => {
    const plan = pipelineDetail('plan', 'error', 'failed: timeout', '{}', null);
    assert.deepEqual(plan.error, { sentence: STAGE_ERROR_SENTENCES.plan, raw: 'failed: timeout' });
    assert.equal(plan.label, 'failed: timeout');
    const own = pipelineDetail('listen', 'error', 'failed', null, '{"error":{"sentence":"Could not hear that.","raw":"stt closed"}}');
    assert.deepEqual(own.error, { sentence: 'Could not hear that.', raw: 'stt closed' }, "the payload's own error wins");
  });

  test('memory text never comes through unless the person shared it', () => {
    const payload = JSON.stringify({
      hits: [
        { id: 'm1', origin: 'memory', memoryType: 'pref', score: 0.8, sharedText: 'Likes quiet places.' },
        { id: 'm2', origin: 'memory', memoryType: 'reply', score: 0.7, text: 'a private memory that a bug let through' },
        { id: 'w1', origin: 'web', score: 0.6, text: 'Thai kitchen on Lombard' },
      ],
    });
    const detail = pipelineDetail('retrieve', 'ok', 'recalled', '{"hitCount":3}', payload);
    const shown = (detail.hits ?? []).map(hitDisplay).map((hit) => hit.text);
    assert.deepEqual(shown, ['Likes quiet places.', 'Private memory', 'Thai kitchen on Lombard']);
    assert.doesNotMatch(JSON.stringify(detail), /private memory that a bug/);
  });

  test('never throws: unreadable JSON is skipped and named in the raw text, and other count values are dropped', () => {
    const detail = pipelineDetail('speak', 'ok', 'earpiece', '{"clips":4,"note":"text is not a count"}', '{not json');
    assert.equal(detail.label, 'earpiece');
    assert.equal((detail as Record<string, unknown>).clips, 4);
    assert.equal((detail as Record<string, unknown>).note, undefined, 'counts are numbers and booleans only');
    assert.equal(detail.error?.sentence, "This step's details could not be read.");
    assert.match(detail.error?.raw ?? '', /not json/);
    assert.deepEqual(pipelineDetail('call', 'started', '  ', '', undefined), {});
  });
});
