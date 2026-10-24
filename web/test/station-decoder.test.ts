/**
 * The decoder bridge (lib/station/decoder.ts, docs/station.md 2.4 and 7.3 A4): every validation rule, health fresh
 * only within 500 ms, the onset on the station's clock, and reconnects after 0.5, 1, 2, then every 2 s.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CommandInput } from '../lib/station/commands';
import { DecoderBridge, decoderUrl, parseDecoderFrame, type DecoderSocketLike } from '../lib/station/decoder';
import { fakeTimers } from './role-fakes';

describe('decoder frames', () => {
  test('health: true only when decoderHealthy is exactly true', () => {
    assert.deepEqual(parseDecoderFrame('{"type":"health","decoderHealthy":true}'), { kind: 'health', healthy: true });
    assert.deepEqual(parseDecoderFrame('{"type":"health","decoderHealthy":"yes"}'), { kind: 'health', healthy: false });
  });

  test('a good gesture keeps its id, source, confidence and age', () => {
    const frame = parseDecoderFrame(JSON.stringify({ type: 'gesture', id: 'a1-b2', command: 'YES', onsetAgeMs: 840, confidence: 0.82, source: 'imagery' }));
    assert.deepEqual(frame, { kind: 'gesture', command: 'YES', gestureId: 'a1-b2', idReplaced: false, source: 'imagery', confidence: 0.82, onsetAgeMs: 840 });
  });

  test('a bad or missing id is replaced, so a STOP is never lost', () => {
    for (const id of [undefined, '', 'has space', 'x'.repeat(65), 42]) {
      const frame = parseDecoderFrame(JSON.stringify({ type: 'gesture', id, command: 'STOP' }));
      assert.equal(frame.kind, 'gesture');
      if (frame.kind === 'gesture') {
        assert.equal(frame.gestureId, null);
        assert.equal(frame.idReplaced, true);
        assert.equal(frame.command, 'STOP');
      }
    }
  });

  test('a bad source becomes decoder; a missing or negative age is 0; confidence is clamped, missing is 0', () => {
    const frame = parseDecoderFrame(JSON.stringify({ type: 'gesture', id: 'g', command: 'NO', source: 'Jaw Clench', onsetAgeMs: -5, confidence: 3 }));
    assert.ok(frame.kind === 'gesture');
    if (frame.kind !== 'gesture') return;
    assert.equal(frame.source, 'decoder');
    assert.equal(frame.onsetAgeMs, 0);
    assert.equal(frame.confidence, 1);
    const bare = parseDecoderFrame(JSON.stringify({ type: 'gesture', id: 'g', command: 'NO' }));
    assert.ok(bare.kind === 'gesture' && bare.confidence === 0 && bare.onsetAgeMs === 0 && bare.source === 'decoder');
  });

  test('a command outside the five words is bad; an unknown type and binary frames are ignored', () => {
    assert.deepEqual(parseDecoderFrame(JSON.stringify({ type: 'gesture', id: 'g', command: 'MAYBE' })), { kind: 'bad', reason: 'bad_command' });
    assert.deepEqual(parseDecoderFrame(JSON.stringify({ type: 'gesture', id: 'g', command: 'yes' })), { kind: 'bad', reason: 'bad_command' });
    assert.deepEqual(parseDecoderFrame('not json'), { kind: 'bad', reason: 'not_json' });
    assert.deepEqual(parseDecoderFrame('[1,2]'), { kind: 'bad', reason: 'not_json' });
    assert.deepEqual(parseDecoderFrame(JSON.stringify({ type: 'telemetry' })), { kind: 'ignored', reason: 'unknown_type' });
    assert.deepEqual(parseDecoderFrame(new Uint8Array([1, 2])), { kind: 'ignored', reason: 'binary' });
  });
});

class FakeSocket implements DecoderSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
  close() {
    this.closed = true;
  }
}

function harness(port = 8765) {
  const clock = fakeTimers(5_000);
  const sockets: FakeSocket[] = [];
  const commands: CommandInput[] = [];
  let changes = 0;
  const bridge = new DecoderBridge({
    port,
    onCommand: (c) => commands.push(c),
    onChange: () => changes++,
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { bridge, clock, sockets, commands, changes: () => changes };
}

describe('the decoder bridge', () => {
  test('connects to 127.0.0.1 on the port', () => {
    const h = harness(9001);
    h.bridge.start();
    assert.equal(h.sockets[0]!.url, decoderUrl(9001));
    assert.equal(decoderUrl(8765), 'ws://127.0.0.1:8765');
    assert.equal(h.bridge.healthWord(), 'connecting');
  });

  test('health is fresh only within 500 ms of the last message, and only when it said true', () => {
    const h = harness();
    h.bridge.start();
    h.sockets[0]!.open();
    assert.equal(h.bridge.healthWord(), 'silent');
    h.sockets[0]!.message('{"type":"health","decoderHealthy":true}');
    assert.equal(h.bridge.healthyNow(), true);
    assert.equal(h.bridge.healthWord(), 'healthy');
    h.clock.advance(500);
    assert.equal(h.bridge.healthyNow(), true);
    h.clock.advance(1);
    assert.equal(h.bridge.healthyNow(), false);
    assert.equal(h.bridge.healthWord(), 'silent');
    h.sockets[0]!.message('{"type":"health","decoderHealthy":false}');
    assert.equal(h.bridge.healthyNow(), false);
    assert.equal(h.bridge.healthWord(), 'not_ready');
  });

  test('a stale health redraws the screen without a message', () => {
    const h = harness();
    h.bridge.start();
    h.sockets[0]!.open();
    h.sockets[0]!.message('{"type":"health","decoderHealthy":true}');
    const before = h.changes();
    h.clock.advance(750);
    assert.ok(h.changes() > before);
  });

  test('a gesture is handed on with its onset on the station clock', () => {
    const h = harness();
    h.bridge.start();
    h.sockets[0]!.open();
    h.sockets[0]!.message(JSON.stringify({ type: 'gesture', id: 'g-1', command: 'CONFIRM', onsetAgeMs: 840, confidence: 0.9, source: 'jaw' }));
    assert.equal(h.commands.length, 1);
    assert.deepEqual(h.commands[0], { command: 'CONFIRM', gestureId: 'g-1', source: 'jaw', confidence: 0.9, onsetLocal: 5_000 - 840, via: 'decoder', idReplaced: false });
  });

  test('bad messages are counted and dropped; replaced ids are counted and still relayed', () => {
    const h = harness();
    h.bridge.start();
    h.sockets[0]!.open();
    h.sockets[0]!.message(JSON.stringify({ type: 'gesture', id: 'g', command: 'LOUDER' }));
    h.sockets[0]!.message(JSON.stringify({ type: 'other' }));
    h.sockets[0]!.message(JSON.stringify({ type: 'gesture', command: 'STOP' }));
    assert.equal(h.bridge.getState().badMessages, 1);
    assert.equal(h.bridge.getState().ignoredMessages, 1);
    assert.equal(h.bridge.getState().idsReplaced, 1);
    assert.equal(h.commands.length, 1);
    assert.equal(h.commands[0]!.gestureId, null);
  });

  test('reconnects after 0.5, 1, 2, then every 2 s; an open resets the waits', () => {
    const h = harness();
    h.bridge.start();
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const count = h.sockets.length;
      h.sockets[count - 1]!.drop();
      let waited = 0;
      while (h.sockets.length === count) {
        h.clock.advance(100);
        waited += 100;
      }
      waits.push(waited);
    }
    assert.deepEqual(waits, [500, 1_000, 2_000, 2_000, 2_000]);
    assert.equal(h.bridge.healthWord(), 'not_found');
    h.sockets[h.sockets.length - 1]!.open();
    const count = h.sockets.length;
    h.sockets[count - 1]!.drop();
    h.clock.advance(500);
    assert.equal(h.sockets.length, count + 1);
  });

  test('stop closes the socket and stops reconnecting', () => {
    const h = harness();
    h.bridge.start();
    h.sockets[0]!.open();
    h.bridge.stop();
    assert.equal(h.sockets[0]!.closed, true);
    h.clock.advance(10_000);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.bridge.healthWord(), 'off');
  });

  test('a new port reconnects at once', () => {
    const h = harness();
    h.bridge.start();
    h.bridge.setPort(9100);
    assert.equal(h.sockets.length, 2);
    assert.equal(h.sockets[1]!.url, 'ws://127.0.0.1:9100');
    assert.equal(h.sockets[0]!.closed, true);
  });
});

describe('a decoder socket that never opens (docs/station.md 5.1)', () => {
  test('still connecting after 3 s is marked slow and redraws; opening clears it', () => {
    const h = harness();
    h.bridge.start();
    assert.equal(h.bridge.getState().slowConnect, false);
    h.clock.advance(2_999);
    assert.equal(h.bridge.getState().slowConnect, false);
    const before = h.changes();
    h.clock.advance(1);
    assert.equal(h.bridge.getState().slowConnect, true);
    assert.ok(h.changes() > before, 'the screen redraws without any socket event');
    assert.equal(h.bridge.healthWord(), 'connecting');
    h.sockets[0]!.open();
    assert.equal(h.bridge.getState().slowConnect, false);
  });

  test('a socket that opens in time is never slow, and a dropped one clears the flag', () => {
    const h = harness();
    h.bridge.start();
    h.sockets[0]!.open();
    h.clock.advance(10_000);
    assert.equal(h.bridge.getState().slowConnect, false);
    h.sockets[0]!.drop();
    assert.equal(h.bridge.getState().slowConnect, false);
  });

  test('stop clears the flag and its timer', () => {
    const h = harness();
    h.bridge.start();
    h.bridge.stop();
    h.clock.advance(5_000);
    assert.equal(h.bridge.getState().slowConnect, false);
  });
});
