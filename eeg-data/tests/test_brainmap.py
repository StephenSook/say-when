import numpy as np

from eeg import config
from eeg.brainmap import BrainState

FS = 125.0


def window(drop=(), off=(), amp=20.0):
    t = np.arange(250) / FS
    a = np.full(8, amp)
    for ch in drop:
        a[config.CHANNELS.index(ch)] *= 0.4
    mu = a[:, None] * np.sin(2 * np.pi * 10 * t) + np.random.default_rng(0).normal(0, 2, (8, 250))
    for ch in off:
        mu[config.CHANNELS.index(ch)] = 0.0
    return {"8-12": mu, "16-20": 0.3 * mu, "20-26": 0.3 * mu, config.COV_BAND: mu}


def test_left_imagery_lights_the_right_hemisphere():
    s = BrainState(smooth=1.0)
    for _ in range(20):
        s.update(window(), FS)
    assert s.active_hand() is None
    for _ in range(10):
        s.update(window(drop=("C4", "FC4", "CP4", "C2")), FS)
    left_h, right_h = s.hemispheres()
    assert right_h < -50 and abs(left_h) < 10 and s.active_hand() == "left"
    for _ in range(10):
        s.update(window(drop=("C3", "FC3", "CP3", "C1")), FS)
    assert s.active_hand() == "right"


def test_baseline_does_not_learn_activity():
    s = BrainState(smooth=1.0, baseline_s=1.0)  # very fast drift: would absorb activity if not gated
    for _ in range(10):
        s.update(window(), FS)
    for _ in range(50):
        s.update(window(drop=("C4",)), FS)
    assert s.change[config.CHANNELS.index("C4")] < -50


def test_flat_electrode_is_flagged_and_ignored():
    s = BrainState(smooth=1.0)
    s.update(window(off=("C3",)), FS)
    assert s.flat[config.CHANNELS.index("C3")] and s.flat.sum() == 1
