/**
 * Screen 1's left and right convention, checked in one place so YES can never glow on the wrong side in front of
 * judges. Imagining a right-fist squeeze quiets C3, over the LEFT side of the head; the scene puts the subject's left
 * at negative x and anterior at negative z, and the camera looks down from above and behind, as in a standard EEG
 * top view: nose at the top, C3 on the viewer's left, C4 on the right.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CAMERA_POSITION, ELECTRODES, dot, electrodeDirection, pulseSide, screenRight, toScene } from '../lib/brain/model';

describe('Screen 1 hemispheres', () => {
  test('C3 is drawn at negative x (the subject\'s left) and C4 at positive x', () => {
    assert.ok(toScene(ELECTRODES.C3)[0] < 0);
    assert.ok(toScene(ELECTRODES.C4)[0] > 0);
    const half: [number, number, number] = [0.72, 0.62, 1];
    assert.ok(electrodeDirection('C3', half)![0] < 0);
    assert.ok(electrodeDirection('C4', half)![0] > 0);
  });

  test('up is +y and anterior is -z, a proper rotation with no mirror', () => {
    assert.ok(toScene(ELECTRODES.Cz)[1] > 0.99);
    assert.ok(toScene(ELECTRODES.Fz)[2] < 0, 'Fz is anterior');
    assert.ok(toScene(ELECTRODES.Pz)[2] > 0, 'Pz is posterior');
    // The images of the head axes keep their handedness: right x anterior = up.
    const r = toScene([1, 0, 0]);
    const a = toScene([0, 1, 0]);
    const u = toScene([0, 0, 1]);
    const cross: [number, number, number] = [r[1] * a[2] - r[2] * a[1], r[2] * a[0] - r[0] * a[2], r[0] * a[1] - r[1] * a[0]];
    assert.deepEqual(cross.map((v) => Math.round(v) + 0), u.map((v) => Math.round(v) + 0));
  });

  test('standard EEG top view: nose up, C3 on the viewer\'s left, C4 on the right', () => {
    assert.ok(CAMERA_POSITION[2] > 0, 'camera behind the head, so the nose points away, to the top of the screen');
    assert.ok(CAMERA_POSITION[1] > Math.abs(CAMERA_POSITION[2]), 'camera mostly above: a top view');
    const right = screenRight(CAMERA_POSITION);
    assert.ok(dot(right, toScene(ELECTRODES.C3)) < 0, 'C3 on the left');
    assert.ok(dot(right, toScene(ELECTRODES.C4)) > 0, 'C4 on the right');
  });

  test('an imagined YES pulses the C3 side and an imagined NO the C4 side; jaw, key and switch never pulse', () => {
    assert.equal(pulseSide({ command: 'YES', source: 'imagery' }), 'c3');
    assert.equal(pulseSide({ command: 'NO', source: 'imagery' }), 'c4');
    for (const source of ['jaw', 'key', 'switch', 'other']) {
      assert.equal(pulseSide({ command: 'YES', source }), null, source);
      assert.equal(pulseSide({ command: 'NO', source }), null, source);
    }
    assert.equal(pulseSide({ command: 'CONFIRM', source: 'imagery' }), null);
    assert.equal(pulseSide({ command: 'STOP', source: 'jaw' }), null);
  });

  test('every electrode position is a unit vector on the upper half of the head', () => {
    for (const [name, p] of Object.entries(ELECTRODES)) {
      assert.ok(Math.abs(Math.hypot(...p) - 1) < 0.01, name);
      assert.ok(p[2] > 0, name);
    }
  });
});
