/**
 * The keyboard test keys and the USB switch pattern (lib/station/keys.ts, docs/station.md 2.5 and 7.3 A4).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { StationCommand } from '../lib/station/commands';
import { canLearnSwitchKey, isTypingTarget, keyboardCommand, SwitchPattern } from '../lib/station/keys';
import { fakeTimers } from './role-fakes';

const key = (k: string, patch: Partial<{ repeat: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  repeat: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...patch,
});

describe('keyboard test keys', () => {
  test('Y N C S H map to the five commands, either case', () => {
    assert.equal(keyboardCommand(key('y')), 'YES');
    assert.equal(keyboardCommand(key('N')), 'NO');
    assert.equal(keyboardCommand(key('c')), 'CONFIRM');
    assert.equal(keyboardCommand(key('s')), 'STOP');
    assert.equal(keyboardCommand(key('h')), 'HEADSET_OFF');
  });

  test('other keys, repeats and modifier keys are ignored', () => {
    assert.equal(keyboardCommand(key('x')), null);
    assert.equal(keyboardCommand(key('1')), null);
    assert.equal(keyboardCommand(key('Enter')), null);
    assert.equal(keyboardCommand(key('y', { repeat: true })), null);
    assert.equal(keyboardCommand(key('y', { metaKey: true })), null);
    assert.equal(keyboardCommand(key('c', { ctrlKey: true })), null);
    assert.equal(keyboardCommand(key('s', { altKey: true })), null);
  });

  test('typing targets are recognized', () => {
    assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
    assert.equal(isTypingTarget({ tagName: 'textarea' }), true);
    assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
    assert.equal(isTypingTarget(null), false);
  });

  test('Tab and Escape cannot be learned as the switch key', () => {
    assert.equal(canLearnSwitchKey('Space'), true);
    assert.equal(canLearnSwitchKey('KeyJ'), true);
    assert.equal(canLearnSwitchKey('Tab'), false);
    assert.equal(canLearnSwitchKey('Escape'), false);
  });
});

function switchHarness() {
  const clock = fakeTimers(0);
  const commands: Array<[StationCommand, number, number]> = [];
  const pattern = new SwitchPattern({
    onCommand: (command, onset) => commands.push([command, onset, clock.now()]),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, commands, pattern };
}

describe('the switch pattern', () => {
  test('a short press gives YES 400 ms after the release, with the keydown as onset', () => {
    const h = switchHarness();
    h.clock.advance(1_000);
    h.pattern.down(1_000);
    h.clock.advance(150);
    h.pattern.up(1_150);
    h.clock.advance(399);
    assert.equal(h.commands.length, 0);
    h.clock.advance(1);
    assert.deepEqual(h.commands, [['YES', 1_000, 1_550]]);
  });

  test('a second press within 400 ms of the release gives CONFIRM at that keydown, with the first onset', () => {
    const h = switchHarness();
    h.clock.advance(1_000);
    h.pattern.down(1_000);
    h.clock.advance(120);
    h.pattern.up(1_120);
    h.clock.advance(300);
    h.pattern.down(1_420);
    assert.deepEqual(h.commands, [['CONFIRM', 1_000, 1_420]]);
    h.clock.advance(2_000);
    h.pattern.up(3_420);
    h.clock.advance(1_000);
    assert.equal(h.commands.length, 1, 'the second press makes nothing else, even when held');
  });

  test('a 1000 ms hold gives STOP when the hold is reached; its release makes nothing', () => {
    const h = switchHarness();
    h.clock.advance(1_000);
    h.pattern.down(1_000);
    h.clock.advance(1_000);
    assert.deepEqual(h.commands, [['STOP', 1_000, 2_000]]);
    h.clock.advance(500);
    h.pattern.up(2_500);
    h.clock.advance(1_000);
    assert.equal(h.commands.length, 1);
  });

  test('two presses further apart are two YES', () => {
    const h = switchHarness();
    h.pattern.down(0);
    h.clock.advance(100);
    h.pattern.up(100);
    h.clock.advance(600);
    h.pattern.down(700);
    h.clock.advance(100);
    h.pattern.up(800);
    h.clock.advance(400);
    assert.deepEqual(
      h.commands.map((c) => c[0]),
      ['YES', 'YES'],
    );
  });

  test('reset forgets a press in progress', () => {
    const h = switchHarness();
    h.pattern.down(0);
    h.pattern.reset();
    h.clock.advance(2_000);
    assert.equal(h.commands.length, 0);
  });
});
