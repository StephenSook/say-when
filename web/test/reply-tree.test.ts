/**
 * The Suggested replies tree (lib/tree/model.ts) over the sample replay and over rows shaped as the live board gives
 * them (test/board-fixtures.ts, mapped by boardRows). Pure: no React, no browser. All content is made-up sample or
 * smoke content.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { boardRows } from '../lib/data/spacetime-map';
import { LOOP_MS, replayRowsAt } from '../lib/data/replay';
import { EMPTY_ROWS } from '../lib/data/types';
import { cameraFraming, cameraViewport, cardRects, drawnRect, READABLE_ZOOM, type Viewport } from '../lib/tree/camera';
import { CHILD_SLOTS, firstRoundRect, OPTION_SLOTS, optionRect, slot, stepRect, type Rect } from '../lib/tree/layout';
import { deriveReplyTree, pickPhrase, sourceLine, STOP_LINE, type OptionNode, type ReplyTree, type TreeNode } from '../lib/tree/model';
import { config, errand, event, ledger, midScan, option, question, scan, ts } from './board-fixtures';

const START = Date.UTC(2026, 9, 24, 19, 40, 0);
const at = (seconds: number) => replayRowsAt(START, START + Math.round(seconds * 1_000));
const treeAt = (seconds: number) => deriveReplyTree(at(seconds));

/** The node whose id ends with `suffix` ("notes:hub", "r1:o3"), or undefined. */
function node(tree: ReplyTree, suffix: string): TreeNode | undefined {
  return tree.nodes.find((n) => n.id === `${tree.questionId}:${suffix}` || n.id.endsWith(`:${suffix}`));
}

function options(tree: ReplyTree, round = 1): OptionNode[] {
  return tree.nodes.filter((n): n is OptionNode => n.kind === 'option' && n.round === round).sort((a, b) => a.rank - b.rank);
}

/** Text that only shows up when a value went missing on the way to the screen. */
const BROKEN = /undefined|NaN|\[object Object\]|Infinity/;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('the Suggested replies tree over the sample replay', () => {
  test('every node keeps its slot as rows arrive: none ever moves, and no two cards overlap', () => {
    const seen = new Map<string, string>();
    let checked = 0;
    for (let t = 0; t < LOOP_MS * 2; t += 100) {
      const tree = deriveReplyTree(replayRowsAt(START, START + t));
      for (const n of tree.nodes) {
        const where = JSON.stringify(n.rect);
        const before = seen.get(n.id);
        if (before === undefined) seen.set(n.id, where);
        else assert.equal(where, before, `${n.id} moved at ${t} ms`);
        checked += 1;
      }
      const cards = tree.nodes.filter((n) => n.kind !== 'region');
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          assert.ok(!overlaps(cards[i]!.rect, cards[j]!.rect), `${cards[i]!.id} overlaps ${cards[j]!.id} at ${t} ms`);
        }
      }
    }
    assert.ok(checked > 10_000, `checked ${checked} node positions`);
    assert.ok(seen.size > 40, `saw ${seen.size} nodes across two loops`);
  });

  test('the slot functions are pure of what exists: the same index always gives the same place', () => {
    assert.deepEqual(slot('notes', 1), slot('notes', 1));
    assert.notDeepEqual(slot('notes', 0), slot('notes', 1));
    assert.ok(slot('notes', CHILD_SLOTS - 1).y + slot('notes', CHILD_SLOTS - 1).height <= slot('web', 0).y, 'notes stay above the web region');
    assert.throws(() => slot('web', CHILD_SLOTS));
    assert.throws(() => optionRect(1, OPTION_SLOTS + 1));
    assert.deepEqual(stepRect(2, 3, 1), stepRect(2, 3, 1));
  });

  test('statuses follow the rows: started is Working, ok is Done, no row is Idle, and only a running step animates', () => {
    const asking = treeAt(1);
    assert.equal(node(asking, 'question')?.word, 'Working');
    assert.equal(node(asking, 'notes:hub')?.word, 'Idle');
    assert.equal(node(asking, 'web:hub')?.word, 'Idle');
    assert.equal(node(asking, 'r1:draft')?.word, 'Idle');
    assert.deepEqual(asking.edges.filter((e) => e.running), [], 'nothing animates toward a step that has not started');

    const searching = treeAt(3);
    assert.equal(node(searching, 'question')?.word, 'Done');
    assert.equal(node(searching, 'web:hub')?.status, 'working');
    assert.equal(node(searching, 'notes:hub')?.status, 'idle');
    assert.deepEqual(searching.edges.filter((e) => e.running).map((e) => e.target), [node(searching, 'web:hub')!.id]);

    const drafting = treeAt(5);
    assert.equal(node(drafting, 'r1:draft')?.status, 'working');
    assert.ok(drafting.edges.filter((e) => e.running).every((e) => e.target === node(drafting, 'r1:draft')!.id), 'only edges into the drafting run');

    const done = treeAt(8);
    for (const suffix of ['question', 'notes:hub', 'web:hub', 'r1:draft']) assert.equal(node(done, suffix)?.word, 'Done', suffix);
    assert.equal(node(done, 'r1:draft')?.kind === 'hub' ? (node(done, 'r1:draft') as { tool: string | null }).tool : null, 'Claude', 'the plan rows say claude');
    assert.deepEqual(done.edges.filter((e) => e.running), []);
  });

  test('children come from the rows, capped at the slots with "+N more"; web passages stay out of the saved notes', () => {
    const tree = treeAt(8);
    const notes = tree.nodes.filter((n) => n.kind === 'child' && n.region === 'notes');
    // The sample recall has four hits: one shared memory, one private memory and two web passages.
    assert.deepEqual(
      notes.map((n) => (n.kind === 'child' ? n.title : '')),
      ['"Sample shared memory: Demo user likes quiet places with a ramp."', 'Private note'],
    );
    assert.equal(node(tree, 'notes:hub')?.kind === 'hub' && (node(tree, 'notes:hub') as { meta: string }).meta, '2 saved notes');
    const web = tree.nodes.filter((n) => (n.kind === 'child' || n.kind === 'more') && n.region === 'web');
    assert.equal(web.length, CHILD_SLOTS, 'six rows fill the three slots');
    assert.deepEqual(
      web.map((n) => (n.kind === 'child' || n.kind === 'more' ? `${n.title} (${n.meta})` : '')),
      ['Cafe on Bay St (Google Maps)', 'Thai kitchen on Lombard (Google Maps)', '+4 more (6 results in all)'],
    );
    assert.equal((node(tree, 'web:hub') as { meta: string }).meta, '6 results');
    assert.equal((node(tree, 'web:hub') as { detail: string }).detail, '6 results from 2 searches, 1.8 s');
  });

  test('three options, each with where it came from, its pick number, and the one in the earpiece marked', () => {
    const tree = treeAt(6.3);
    const opts = options(tree);
    assert.deepEqual(opts.map((o) => o.heading), ['Option 1 of 3', 'Option 2 of 3', 'Option 3 of 3']);
    assert.deepEqual(opts.map((o) => o.badge), ['1', '2', '3'], 'the number the person picks it by (D18)');
    assert.deepEqual(opts.map((o) => o.label), ['Cafeteria', 'Thai place', 'Cafe on Bay'], 'the earpiece labels');
    assert.deepEqual(opts.map((o) => o.source), ['From the web: example.net', 'From the web: Google Maps', "From the person's notes and the web"]);
    assert.deepEqual(opts.map((o) => o.state), ['idle', 'reading', 'idle'], 'option 2 is being read at 6.3 s');
    assert.equal(opts[1]!.word, 'In the earpiece now');
    const waiting = options(treeAt(10));
    assert.deepEqual(waiting.map((o) => o.state), ['idle', 'idle', 'idle'], 'the wait for a pick marks no single option');
  });

  test('a select row picks exactly that option: it turns Picked, the rest dim, and the camera frames it', () => {
    const pickedNow = treeAt(12);
    const during = options(pickedNow);
    assert.deepEqual(during.map((o) => o.state), ['dimmed', 'dimmed', 'picked']);
    assert.equal(during[2]!.pickLine, 'Picked with 3, a single jaw clench.', 'said at once: no veto in direct select');
    assert.equal(pickedNow.pickedId, during[2]!.id);
    assert.equal(pickedNow.camera.intent, 'pick');
    // Said at once (no veto): the camera frames the pick and its "Said out loud" step together.
    assert.deepEqual(pickedNow.camera.nodeIds, [during[2]!.id, node(pickedNow, 'r1:said')!.id]);

    const spoken = treeAt(15);
    const after = options(spoken);
    assert.equal(after.filter((o) => o.state === 'picked').length, 1);
    assert.equal(after[2]!.pickLine, 'Picked with 3, a single jaw clench. Spoken in the room.');
    assert.equal(node(spoken, 'r1:said')?.word, 'Spoken');
    assert.ok(spoken.edges.some((e) => e.tone === 'picked' && e.target === after[2]!.id), 'the path into the pick is drawn as picked');
    assert.equal(spoken.edges.filter((e) => e.tone === 'picked' && e.target.endsWith(':o3')).length, 1);
    assert.equal(after.filter((o) => o.state === 'dimmed').length, 2);
  });

  test('errand steps grow only from errand rows: read back, the confirm window, then sent; the confirm moves the camera', () => {
    const picked = treeAt(20.8);
    assert.equal(options(picked, 2).find((o) => o.state === 'picked')?.tag, 'Errand');
    assert.equal(options(picked, 2).find((o) => o.state === 'picked')?.pickLine, 'Picked with 1, an imagined left fist.');
    assert.equal(node(picked, 'r2:e1'), undefined, 'no errand row yet, so no errand step');
    const filling = treeAt(21.5);
    assert.equal(node(filling, 'r2:e1')?.word, 'Working');
    assert.equal(node(filling, 'r2:e2'), undefined);
    const waiting = treeAt(29);
    assert.equal(node(waiting, 'r2:e2')?.word, 'Waiting');
    assert.equal(node(waiting, 'r2:e2')?.kind === 'step' && (node(waiting, 'r2:e2') as { meta: string }).meta, 'Waiting for 1 to send, 2 to cancel.');
    assert.equal(node(waiting, 'r2:e3'), undefined);
    const sent = treeAt(33);
    assert.equal(node(sent, 'r2:e2')?.word, 'Confirmed');
    assert.equal(node(sent, 'r2:e3')?.word, 'Sent');
    const confirming = treeAt(30.5);
    assert.equal(confirming.camera.intent, 'confirm');
    assert.deepEqual(confirming.camera.nodeIds, [node(confirming, 'r2:e2')!.id, node(confirming, 'r2:e3')!.id]);
  });

  test('handoffs: one dot per real handoff, each on an edge that exists, keyed by the row that caused it', () => {
    for (const seconds of [3, 5, 8, 20, 30, 40, 60]) {
      const tree = treeAt(seconds);
      const keys = tree.handoffs.map((h) => h.key);
      assert.equal(new Set(keys).size, keys.length, `unique keys at ${seconds} s`);
      const edgeIds = new Set(tree.edges.map((e) => e.id));
      for (const h of tree.handoffs) assert.ok(edgeIds.has(h.edgeId), `${h.key} rides an edge at ${seconds} s`);
    }
    // A handoff, once made, keeps its key: the screen plays each one once.
    const early = new Set(treeAt(8).handoffs.map((h) => h.key));
    const later = new Set(treeAt(30).handoffs.map((h) => h.key));
    for (const key of early) assert.ok(later.has(key), `${key} is still there later`);
  });

  test('a new question starts a new tree; the camera key changes only when a row asks for it', () => {
    const one = treeAt(70);
    const two = treeAt(71.5);
    assert.notEqual(one.questionId, two.questionId);
    assert.equal(two.camera.intent, 'overview');
    assert.equal(treeAt(6).camera.key, treeAt(8).camera.key, 'reading options one after another does not move the camera');
    assert.equal(treeAt(6).camera.key, treeAt(10).camera.key, 'nor does the wait for a pick');
  });

  test('no broken value and no memory text that was not shared, every 100 ms of a loop', () => {
    for (let t = 0; t < LOOP_MS; t += 100) {
      const json = JSON.stringify(deriveReplyTree(replayRowsAt(START, START + t)));
      assert.doesNotMatch(json, BROKEN, `at ${t} ms`);
      assert.doesNotMatch(json, /Private memory/, 'the screen says Private note');
    }
  });
});

describe('the Suggested replies tree on the live board', () => {
  test('idle before any question: one plain line, every job Idle, nothing moves', () => {
    const tree = deriveReplyTree(EMPTY_ROWS);
    assert.equal(tree.idle, true);
    assert.equal(tree.questionId, null);
    const root = tree.nodes.find((n) => n.kind === 'question');
    assert.equal(root?.kind === 'question' && root.label, 'Waiting for a question');
    assert.ok(tree.nodes.filter((n) => n.kind === 'hub').every((n) => n.status === 'idle' && n.word === 'Idle'));
    assert.deepEqual(tree.handoffs, []);
    assert.deepEqual(tree.edges.filter((e) => e.running), []);
    assert.equal(tree.camera.key, 'idle');
    assert.deepEqual(tree.camera.rect, firstRoundRect());
    assert.deepEqual(tree.stop, { used: false, text: STOP_LINE, detail: null });
  });

  test('sharing off: options show their rank only, sources are not claimed, and the cursor marks the option being read', () => {
    const rows = boardRows(midScan());
    const tree = deriveReplyTree(rows);
    const opts = options(tree);
    assert.deepEqual(opts.map((o) => o.text), [null, null, null, null]);
    assert.ok(opts.every((o) => o.source === 'Sources not shared on this screen'));
    assert.deepEqual(opts.map((o) => o.state), ['idle', 'idle', 'idle', 'idle'], 'the Window is the wait for a pick: no single option is marked');
    assert.deepEqual(opts.map((o) => o.label), [null, null, null, null], '"Option N" is no label');
    const reading = options(deriveReplyTree(boardRows(midScan({ scanStates: [scan({ phase: { tag: 'Reading' }, cursor: 2 })] }))));
    assert.deepEqual(reading.map((o) => o.state), ['idle', 'reading', 'idle', 'idle'], 'the cursor marks the option being read');
    // The smoke plan step is labelled "smoke options", not claude: the screen does not name Claude.
    assert.equal((node(tree, 'r1:draft') as { tool: string | null }).tool, 'Agent');
    assert.doesNotMatch(JSON.stringify(tree), BROKEN);
  });

  test('a keyboard session says the pick was a key press, never the headset', () => {
    const picked = (label: string) =>
      boardRows(
        midScan({
          ledger: [ledger(500, 'session_start', -5_000, { outcome: label })],
          scanStates: [scan({ phase: { tag: 'Idle' }, outcome: { tag: 'Picked' }, pickedOptionId: 102n, pickedRank: 2 })],
          pipelineEvents: [...midScan().pipelineEvents, event(70, 'q21:select', 'select', 'ok', 'picked', 7_000, { countsJson: '{"optionId":102,"rank":2,"pass":1}' })],
        }),
      );
    const keyboard = picked('keyboard-test');
    assert.equal(keyboard.input, 'keyboard');
    const pick = options(deriveReplyTree(keyboard)).find((o) => o.state === 'picked');
    assert.equal(pick?.rank, 2);
    assert.equal(pick?.pickLine, 'Picked with key 2 (keyboard test).');
    assert.doesNotMatch(JSON.stringify(deriveReplyTree(keyboard)), /headset/i);

    const headset = options(deriveReplyTree(picked('headset-demo'))).find((o) => o.state === 'picked');
    assert.equal(headset?.pickLine, 'Picked with 2, an imagined right fist.');
    assert.equal(pickPhrase('switch', 1), 'Picked with 1, a short switch press');
    assert.equal(pickPhrase('switch', 3), 'Picked with 3', '3 is not on the switch: no signal named');
    assert.equal(pickPhrase('unknown', 2), 'Picked with 2');
    assert.equal(pickPhrase('headset', 3), 'Picked with 3, a single jaw clench');
    assert.equal(pickPhrase('headset', 4), 'Picked with 4', 'no gesture gives 4 (a double jaw clench means nothing): no signal named');
  });

  test('an errand option picked: steps appear only once its errand row exists, with the true input for CONFIRM', () => {
    const base = midScan();
    const pickedErrand = {
      ledger: [ledger(500, 'session_start', -5_000, { outcome: 'keyboard-test' })],
      questions: [question({ options: [option(1), option(2), option(3, { kind: { tag: 'Errand' } }), option(4)] })],
      scanStates: [scan({ phase: { tag: 'Idle' }, outcome: { tag: 'Picked' }, pickedOptionId: 103n, pickedRank: 3 })],
      pipelineEvents: [...base.pipelineEvents, event(70, 'q21:select', 'select', 'ok', 'picked', 9_000, { countsJson: '{"optionId":103,"rank":3,"pass":1}' })],
    };
    const before = deriveReplyTree(boardRows(midScan(pickedErrand)));
    assert.equal(options(before).find((o) => o.state === 'picked')?.tag, 'Errand');
    assert.equal(before.nodes.filter((n) => n.kind === 'step').length, 0, 'no errand row, no errand step');

    const waiting = deriveReplyTree(boardRows(midScan({ ...pickedErrand, errands: [errand({ optionId: 103n })] })));
    const steps = waiting.nodes.filter((n) => n.kind === 'step');
    assert.deepEqual(steps.map((n) => n.word), ['Done', 'Waiting']);
    assert.equal(steps[1]?.kind === 'step' && steps[1].meta, 'Waiting for 1 to send, 2 to cancel.');
    assert.equal(steps[1]?.kind === 'step' && steps[1].until !== null, true, 'the confirm window counts down to its close');
  });

  test('a follow-up round replaces the options on the board: the earlier round keeps its slots and its pick', () => {
    // Round 1 picked option 2 (a reply); the board then scans version 2, the follow-up options.
    const followUp = boardRows(
      midScan({
        config: [config({ shareTextOnBoard: true })],
        questions: [
          question({
            textShared: true,
            text: 'Smoke test: which drink?',
            version: 2,
            options: [option(1, { optionId: 201n, label: 'Send the care team a request.', kind: { tag: 'Errand' } }), option(2, { optionId: 202n, label: 'Nothing else.' })],
          }),
        ],
        scanStates: [scan({ version: 2, phase: { tag: 'Reading' }, cursor: 1 })],
        payloads: [{ eventId: 70n, questionId: 21n, stage: 'select', payloadJson: '{"optionId":102,"rank":2,"text":"Tea"}' }],
        pipelineEvents: [
          ...midScan().pipelineEvents,
          event(70, 'q21:select', 'select', 'ok', 'picked', 7_000, { countsJson: '{"optionId":102,"rank":2,"pass":1}' }),
          event(71, '7:2:plan:started', 'plan', 'started', 'claude', 9_000, { actor: 'Agent' }),
          event(72, 'q21:v2:plan', 'plan', 'ok', 'claude', 9_600, { countsJson: '{"version":2,"optionCount":2,"followUp":true}', actor: 'Agent' }),
        ],
      }),
    );
    const tree = deriveReplyTree(followUp);
    const first = options(tree, 1);
    assert.deepEqual(first.map((o) => o.heading), ['Option 1 of 4', 'Option 2 of 4', 'Option 3 of 4', 'Option 4 of 4'], 'counted from the round 1 plan');
    assert.deepEqual(first.map((o) => o.state), ['dimmed', 'picked', 'dimmed', 'dimmed']);
    assert.equal(first[1]!.text, 'Tea', "the pick's own words from its select row");
    const second = options(tree, 2);
    assert.deepEqual(second.map((o) => o.text), ['Send the care team a request.', 'Nothing else.']);
    assert.deepEqual(second.map((o) => o.state), ['reading', 'idle']);
    assert.equal((node(tree, 'r2:draft') as { title: string }).title, 'Drafting follow-up options');
    assert.equal(tree.camera.intent, 'round');
  });

  test('STOP, none of these: the round says so beside its options, and the STOP line lights', () => {
    const rows = boardRows(midScan({ scanStates: [scan({ phase: { tag: 'Idle' }, outcome: { tag: 'None' }, cursor: undefined, stepStartedAt: ts(12_000) })] }));
    const tree = deriveReplyTree(rows);
    assert.ok(options(tree).every((o) => o.state === 'dimmed'));
    const end = node(tree, 'r1:end');
    assert.equal(end?.kind === 'step' && end.title, STOP_LINE);
    assert.equal(tree.stop.used, true);
    assert.equal(tree.announcement, 'STOP: none of these. Nothing was said or sent.');
  });

  test('results that arrive in two searches keep their slots: the first one never moves when more land', () => {
    const shared = { config: [config({ shareTextOnBoard: true })], questions: [question({ textShared: true, text: 'Smoke test: where to eat?' })] };
    const maps = [
      event(60, 'k60', 'search', 'started', 'maps', 400, { actor: 'Agent' }),
      event(61, 'k61', 'search', 'ok', 'maps', 900, { countsJson: '{"needsWeb":true,"searches":1,"rowCount":1}', actor: 'Agent' }),
    ];
    const web = [
      event(62, 'k62', 'search', 'started', 'web', 1_000, { actor: 'Agent' }),
      event(63, 'k63', 'search', 'ok', 'web', 1_800, { countsJson: '{"needsWeb":true,"searches":1,"rowCount":2}', actor: 'Agent' }),
    ];
    const payloads = [
      { eventId: 61n, questionId: 21n, stage: 'search', payloadJson: '{"rows":[{"id":"m1","source":"maps","title":"Smoke cafe","fetchedAt":"2026-10-24T13:00:00Z"}]}' },
      {
        eventId: 63n,
        questionId: 21n,
        stage: 'search',
        payloadJson:
          '{"rows":[{"id":"w1","source":"web","title":"Smoke guide","url":"https://example.com/a","fetchedAt":"2026-10-24T13:00:00Z"},{"id":"w2","source":"web","title":"Smoke list","url":"https://example.org/b","fetchedAt":"2026-10-24T13:00:00Z"}]}',
      },
    ];
    const first = deriveReplyTree(boardRows(midScan({ ...shared, payloads, pipelineEvents: [...maps] })));
    const both = deriveReplyTree(boardRows(midScan({ ...shared, payloads, pipelineEvents: [...maps, ...web] })));
    const c0 = node(first, 'web:c0');
    assert.equal(c0?.kind === 'child' && c0.title, 'Smoke cafe');
    assert.equal(node(first, 'web:c1'), undefined);
    assert.deepEqual(node(both, 'web:c0')?.rect, c0?.rect, 'the first result stays in slot 0');
    assert.deepEqual(
      both.nodes.filter((n) => n.kind === 'child' && n.region === 'web').map((n) => (n.kind === 'child' ? `${n.title} (${n.meta})` : '')),
      ['Smoke cafe (Google Maps)', 'Smoke guide (example.com)', 'Smoke list (example.org)'],
    );
    assert.equal((node(both, 'web:hub') as { detail: string }).detail, '3 results from 2 searches, 1.4 s');
  });

  test('sources in words: notes, the web by site, both, or drafted', () => {
    const base = { id: 'o', questionId: 'q', version: 1, rank: 1, text: 'x', kind: 'reply' as const, tone: null };
    assert.equal(sourceLine({ ...base, sources: [{ source: 'memory', fetchedAt: '' }] }, true), "From the person's notes");
    assert.equal(sourceLine({ ...base, sources: [{ source: 'web', url: 'https://www.example.org/a', fetchedAt: '' }] }, true), 'From the web: example.org');
    assert.equal(
      sourceLine({ ...base, sources: [{ source: 'web', url: 'https://a.example/x', fetchedAt: '' }, { source: 'maps', fetchedAt: '' }] }, true),
      'From the web: a.example and 1 more',
    );
    assert.equal(sourceLine({ ...base, sources: [] }, true), 'Drafted');
    assert.equal(sourceLine({ ...base, kind: 'menu', sources: [] }, true), "From the person's menu");
  });
});

describe('the camera on a projector', () => {
  const onScreen = (rect: { x: number; y: number; width: number; height: number }, vp: { x: number; y: number; zoom: number }, w: number, h: number) =>
    rect.x * vp.zoom + vp.x >= -0.5 && rect.y * vp.zoom + vp.y >= -0.5 && (rect.x + rect.width) * vp.zoom + vp.x <= w + 0.5 && (rect.y + rect.height) * vp.zoom + vp.y <= h + 0.5;

  test('1920 x 1080: the whole first round fits, and its smallest 23 unit line is at least 20 px', () => {
    // The canvas under the header, the replay banner and the title row, as measured in the browser check.
    const [w, h] = [1920, 890];
    const target = deriveReplyTree(EMPTY_ROWS).camera;
    const vp = cameraViewport(target, w, h);
    assert.ok(vp.zoom * 23 >= 20, `zoom ${vp.zoom}`);
    assert.ok(onScreen(firstRoundRect(), vp, w, h));
  });

  test('1280 x 720: never below the readable floor; the tight view stays whole and slides toward the rest', () => {
    const [w, h] = [1280, 540];
    const options = treeAt(8).camera;
    const vp = cameraViewport(options, w, h);
    assert.equal(vp.zoom, READABLE_ZOOM);
    assert.ok(READABLE_ZOOM * 29 >= 20, 'titles and option words stay at 20 px');
    assert.ok(onScreen(options.tight, vp, w, h), 'the drafting hub and every option slot are in view');
    const centered = (options.tight.x + options.tight.width / 2) * vp.zoom + vp.x;
    assert.ok(centered > w / 2, 'the view slid left to show more of the lookup');
  });
});

describe('the camera never cuts a card at the screen edge', () => {
  /** The canvas sizes measured in the browser: 1920 x 1080 and 1280 x 720, with and without the replay banner. */
  const SCREENS: Array<[number, number]> = [
    [1920, 899],
    [1920, 935],
    [1280, 539],
    [1280, 575],
  ];

  function cut(rect: Rect, vp: Viewport, w: number, h: number): boolean {
    const left = rect.x * vp.zoom + vp.x;
    const top = rect.y * vp.zoom + vp.y;
    const right = (rect.x + rect.width) * vp.zoom + vp.x;
    const bottom = (rect.y + rect.height) * vp.zoom + vp.y;
    const hits = left < w - 0.5 && right > 0.5 && top < h - 0.5 && bottom > 0.5;
    const inside = left >= -0.5 && right <= w + 0.5 && top >= -0.5 && bottom <= h + 0.5;
    return hits && !inside;
  }

  test('every 100 ms of a replay loop, at 1920 and 1280: each card is fully on screen or fully off, the pick whole', () => {
    for (const [w, h] of SCREENS) {
      let key: string | null = null;
      let vp: Viewport | null = null;
      for (let t = 0; t < LOOP_MS; t += 100) {
        const tree = deriveReplyTree(replayRowsAt(START, START + t));
        // The screen moves the camera only when the key changes, so later nodes must also land clean.
        if (tree.camera.key !== key) {
          key = tree.camera.key;
          vp = cameraFraming(tree.camera, tree.nodes, w, h);
          assert.ok(vp.zoom >= READABLE_ZOOM - 1e-9, `${w}x${h} at ${t} ms: zoom ${vp.zoom}`);
        }
        const v: Viewport = vp!;
        const cutCards: string[] = tree.nodes.filter((n) => n.kind !== 'region' && cut(drawnRect(n), v, w, h)).map((n) => n.id);
        assert.deepEqual(cutCards, [], `${w}x${h} at ${t} ms (${key})`);
        if (tree.camera.nodeIds) {
          for (const id of tree.camera.nodeIds) {
            const n = tree.nodes.find((node) => node.id === id)!;
            const r = drawnRect(n);
            assert.ok(r.x * v.zoom + v.x >= 0 && (r.x + r.width) * v.zoom + v.x <= w && r.y * v.zoom + v.y >= 0 && (r.y + r.height) * v.zoom + v.y <= h, `${id} whole at ${t} ms`);
          }
        }
      }
    }
  });

  test('the pick frame at 1920: the green option and "Said out loud" whole, close in, no card cut', () => {
    const tree = treeAt(15);
    assert.equal(tree.camera.intent, 'pick');
    assert.ok(node(tree, 'r1:said'), 'the "Said out loud" step is there');
    const vp = cameraFraming(tree.camera, tree.nodes, 1920, 899);
    assert.ok(vp.zoom >= 1, `comes close: ${vp.zoom}`);
    assert.deepEqual(cardRects(tree.nodes).filter((r) => cut(r, vp, 1920, 899)), []);
  });
});
