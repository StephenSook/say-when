/**
 * The stage view (/stage): the frame it picks for a window, what fills the brain slot, the decoder panel's words, and
 * the side column's block, run over a loop of the sample replay. Pure, no React and no browser.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { buildConversationView, focusQuestion } from '../components/conversation/model';
import { nowBlock } from '../components/stage/model';
import { eventsForQuestion, spokenReply } from '../lib/data/derive';
import { LOOP_MS, replayRowsAt } from '../lib/data/replay';
import type { CommandEvent, DataRows, InputKind } from '../lib/data/types';
import { buildDecoderView, decoderLine, EARLIER_COUNT, NO_COMMAND_COUNTED, NO_COMMAND_YET } from '../lib/stage/decoder';
import { brainSlotKind, parseSize, SIDE_COMPACT, SIDE_WIDE, stageLayout } from '../lib/stage/layout';
import { deriveReplyTree } from '../lib/tree/model';

const START = Date.UTC(2026, 9, 25, 17, 30, 0);
const BROKEN = /undefined|NaN|\[object Object\]|Infinity/;

function command(id: string, name: CommandEvent['command'], at: number, extra: Partial<CommandEvent> = {}): CommandEvent {
  return {
    id,
    command: name,
    at,
    accepted: true,
    ignoredReason: null,
    confidence: name === 'HEADSET_OFF' ? null : 0.91,
    questionId: null,
    optionId: null,
    ...extra,
  };
}

function conversationOf(rows: DataRows) {
  const question = focusQuestion(rows.questions, rows.scan);
  if (question === null) return null;
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

describe('stage frame', () => {
  test('a 1920 x 1080 projector gets the tree beside the full side column', () => {
    assert.deepEqual(stageLayout({ width: 1920, height: 1080 }), { kind: 'wide', sideWidth: SIDE_WIDE, canvas: true });
    assert.deepEqual(stageLayout({ width: 1680, height: 1050 }), { kind: 'wide', sideWidth: SIDE_WIDE, canvas: true });
  });

  test('a 1280 x 720 laptop or projector keeps the canvas with a narrower side column', () => {
    assert.deepEqual(stageLayout({ width: 1280, height: 720 }), { kind: 'compact', sideWidth: SIDE_COMPACT, canvas: true });
    assert.deepEqual(stageLayout({ width: 1440, height: 900 }), { kind: 'compact', sideWidth: SIDE_COMPACT, canvas: true });
    assert.ok(SIDE_COMPACT < SIDE_WIDE);
  });

  test('a phone or a very short window gets one column with the tree as a list', () => {
    for (const size of [
      { width: 390, height: 844 },
      { width: 959, height: 1080 },
      { width: 1280, height: 500 },
    ]) {
      assert.deepEqual(stageLayout(size), { kind: 'stacked', sideWidth: null, canvas: false }, JSON.stringify(size));
    }
  });

  test('before the window is known (the server render) the page gets the projector frame', () => {
    assert.equal(stageLayout(null).kind, 'wide');
    assert.equal(stageLayout({ width: 0, height: 0 }).kind, 'wide');
    assert.equal(stageLayout({ width: Number.NaN, height: 900 }).kind, 'wide');
  });

  test('the window size key parses, and anything else is unknown', () => {
    assert.deepEqual(parseSize('1920x1080'), { width: 1920, height: 1080 });
    for (const key of [null, '', '1920', 'x1080', '1920x', 'wide']) assert.equal(parseSize(key), null, String(key));
  });
});

describe('brain slot', () => {
  test('without the live brain on this build, the slot is the decoder panel whatever the address says', () => {
    for (const search of [null, '', '?brain=1', '?replay=1', '?brain=0']) assert.equal(brainSlotKind(false, search), 'decoder', String(search));
  });

  test('with the live brain on this build, the slot shows it unless the address says brain=0', () => {
    assert.equal(brainSlotKind(true, ''), 'live-brain');
    assert.equal(brainSlotKind(true, '?replay=1'), 'live-brain');
    assert.equal(brainSlotKind(true, '?brain=0'), 'decoder');
    assert.equal(brainSlotKind(true, '?replay=1&brain=0'), 'decoder');
    assert.equal(brainSlotKind(true, 'brain=0'), 'decoder');
  });

  test('the switch is one line: the slot is off on this build, and the comment holds the line that turns it on', () => {
    const source = readFileSync(join(process.cwd(), 'components', 'stage', 'live-brain.ts'), 'utf8');
    const off = 'export const LIVE_BRAIN: ComponentType | null = null;';
    const on = " * export const LIVE_BRAIN: ComponentType | null = dynamic(() => import('@/components/brain/BrainScreen'), { ssr: false, loading: () => null });";
    assert.equal(source.split('\n').filter((line) => line === off).length, 1, 'the active line is the off line, once');
    assert.equal(source.split('\n').filter((line) => line === on).length, 1, 'the comment holds the on line, once');
    assert.match(source, /^import dynamic from 'next\/dynamic';$/m, 'dynamic is already imported for the on line');
    assert.match(source, /^import type \{ ComponentType \} from 'react';$/m);
  });
});

describe('decoder panel words', () => {
  const now = START + 10_000;

  test('a headset session: YES and NO are imagined fists with a hand mark; the jaw commands have none', () => {
    const view = buildDecoderView(
      [
        command('c1', 'STOP', START + 1_000),
        command('c2', 'CONFIRM', START + 2_000),
        command('c3', 'NO', START + 3_000, { confidence: 0.84 }),
        command('c4', 'YES', START + 9_000),
      ],
      'headset',
      now,
    );
    assert.equal(view.title, 'Headset');
    assert.match(view.how ?? '', /Imagined fists choose\. Jaw clenches send or stop\./);
    assert.deepEqual(view.last, {
      id: 'c4',
      word: 'YES',
      signal: 'imagined right fist',
      hand: 'yes',
      ago: 'just now',
      ignored: null,
      confidence: '0.91',
    });
    assert.deepEqual(
      view.earlier.map((line) => [line.word, line.signal, line.hand]),
      [
        ['NO', 'imagined left fist', 'no'],
        ['CONFIRM', 'double jaw clench', null],
        ['STOP', 'single jaw clench', null],
      ],
    );
    assert.equal(view.earlier[0]?.ago, '7 s ago');
  });

  test('a keyboard session names the keys, never a fist, the jaw or the brain, and shows no confidence', () => {
    const commands = (['YES', 'NO', 'CONFIRM', 'STOP', 'HEADSET_OFF'] as const).map((name, i) => command(`k${i}`, name, START + i * 1_000));
    const view = buildDecoderView(commands, 'keyboard', now);
    assert.equal(view.title, 'Keyboard test');
    assert.equal(view.last?.word, 'Input off');
    assert.deepEqual(
      view.earlier.map((line) => line.signal),
      ['key S', 'key C', 'key N'],
    );
    const json = JSON.stringify(view);
    assert.doesNotMatch(json, /imagined|fist|jaw|clench|brain|headset/i);
    for (const line of [view.last!, ...view.earlier]) {
      assert.equal(line.hand, null);
      assert.equal(line.confidence, null);
    }
  });

  test('a switch session names presses, and NO has no signal on a switch', () => {
    assert.equal(decoderLine(command('s1', 'YES', START), 'switch', now).signal, 'short switch press');
    assert.equal(decoderLine(command('s2', 'NO', START), 'switch', now).signal, null);
    assert.equal(decoderLine(command('s3', 'STOP', START), 'switch', now).signal, 'long switch press');
    assert.equal(buildDecoderView([], 'switch', now).title, 'Switch');
  });

  test('an unknown input names no signal and says nothing about how it works', () => {
    const view = buildDecoderView([command('u1', 'YES', START)], 'unknown', now);
    assert.equal(view.title, 'Commands');
    assert.equal(view.how, null);
    assert.equal(view.last?.signal, null);
    assert.equal(view.last?.hand, null);
    assert.equal(view.last?.confidence, null);
  });

  test('an ignored command says why it did not count; a headset off is a system event with no hand', () => {
    const ignored = decoderLine(command('i1', 'YES', START, { accepted: false, ignoredReason: 'Repeat inside the refractory time' }), 'headset', now);
    assert.equal(ignored.ignored, 'Repeat inside the refractory time');
    assert.equal(decoderLine(command('i2', 'NO', START, { accepted: false, ignoredReason: null }), 'headset', now).ignored, 'Did not count');
    const off = decoderLine(command('h1', 'HEADSET_OFF', START), 'headset', now);
    assert.deepEqual([off.word, off.signal, off.hand, off.confidence], ['Headset off', null, null, null]);
  });

  test('an ignored repeat never takes the place of the command that counted; it is listed as not counted', () => {
    const view = buildDecoderView(
      [
        command('r1', 'NO', START + 1_000),
        command('r2', 'YES', START + 5_000),
        command('r3', 'YES', START + 5_200, { accepted: false, ignoredReason: 'Repeat inside the refractory time' }),
      ],
      'headset',
      now,
    );
    assert.equal(view.last?.id, 'r2');
    assert.equal(view.last?.ignored, null);
    assert.equal(view.none, null);
    assert.deepEqual(
      view.earlier.map((line) => [line.id, line.ignored]),
      [
        ['r3', 'Repeat inside the refractory time'],
        ['r1', null],
      ],
    );
    const onlyIgnored = buildDecoderView([command('o1', 'YES', START, { accepted: false, ignoredReason: 'Low confidence' })], 'headset', now);
    assert.equal(onlyIgnored.last, null);
    assert.equal(onlyIgnored.none, NO_COMMAND_COUNTED);
    assert.equal(onlyIgnored.earlier[0]?.ignored, 'Low confidence');
  });

  test('no command yet, the newest first, at most a few earlier ones, and no time text before the clock runs', () => {
    assert.deepEqual(buildDecoderView([], 'headset', now), {
      title: 'Headset',
      how: 'Imagined fists choose. Jaw clenches send or stop.',
      last: null,
      none: NO_COMMAND_YET,
      earlier: [],
    });
    const many = Array.from({ length: 9 }, (_, i) => command(`m${i}`, i % 2 === 0 ? 'YES' : 'NO', START + i * 500));
    const view = buildDecoderView(many, 'headset', now);
    assert.equal(view.last?.id, 'm8');
    assert.deepEqual(
      view.earlier.map((line) => line.id),
      ['m7', 'm6', 'm5'],
    );
    assert.equal(view.earlier.length, EARLIER_COUNT);
    assert.equal(buildDecoderView(many, 'headset', 0).last?.ago, '');
  });
});

describe('stage over the sample replay', () => {
  test('no broken value in the tree, the side column or the decoder panel, every 100 ms of a loop', () => {
    const seen = new Set<string>();
    for (let t = 0; t < LOOP_MS; t += 100) {
      const rows = replayRowsAt(START, START + t);
      const view = conversationOf(rows);
      assert.ok(view, `a question at ${t} ms`);
      const block = nowBlock(view);
      seen.add(block.kind);
      const decoder = buildDecoderView(rows.commands, rows.input, START + t);
      for (const [name, value] of [
        ['now', block],
        ['decoder', decoder],
        ['tree', deriveReplyTree(rows).announcement ?? ''],
      ] as const) {
        assert.doesNotMatch(JSON.stringify(value), BROKEN, `${name} at ${t} ms`);
      }
      if (block.kind === 'ear' && block.option !== null) assert.equal(block.option.id, block.cursor.optionId, `cursor option at ${t} ms`);
      if (block.kind === 'picked') assert.equal(block.option.id, view.picked?.id, `picked at ${t} ms`);
      assert.equal(decoder.last?.ignored ?? null, null, `the large command counted, at ${t} ms`);
    }
    // One loop shows each moment the stage is built for: the wait, the earpiece, the pick.
    for (const kind of ['note', 'ear', 'picked']) assert.ok(seen.has(kind), `the loop shows a ${kind} block`);
  });

  test('the side column and the tree follow the same question all loop', () => {
    for (let t = 0; t < LOOP_MS; t += 500) {
      const rows = replayRowsAt(START, START + t);
      assert.equal(deriveReplyTree(rows).questionId, focusQuestion(rows.questions, rows.scan)?.id ?? null, `at ${t} ms`);
    }
  });

  test('the replay is a headset session, so its YES is an imagined right fist; with keys it would say key Y', () => {
    const rows = replayRowsAt(START, START + LOOP_MS - 1);
    const firstYes = rows.commands.find((event) => event.command === 'YES' && event.accepted);
    assert.ok(firstYes, 'the loop has an accepted YES');
    for (const [input, signal, hand] of [
      ['headset', 'imagined right fist', 'yes'],
      ['keyboard', 'key Y', null],
      ['switch', 'short switch press', null],
      ['unknown', null, null],
    ] as const) {
      const line = decoderLine(firstYes, input as InputKind, START + LOOP_MS);
      assert.deepEqual([line.signal, line.hand], [signal, hand], input);
    }
    assert.equal(rows.input, 'headset');
  });
});
