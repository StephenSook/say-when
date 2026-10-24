"""Synthetic recordings for tests: noise + a 10 Hz rhythm that weakens on the opposite side for left/right
cues, and strong 30-55 Hz bursts for jaw clenches. They exercise the code; they say nothing about the BCI."""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from eeg import config  # noqa: E402
from eeg.sessions import new_session_path, save_session  # noqa: E402

FS = 125.0
T0 = 1.7e9


def fake_recording(root, subject="T01", classes=("left", "right", "rest"), per_class=8, cue_s=3.0, seed=0,
                   stamp="20260101_000000", effect=0.85):
    rng = np.random.default_rng(seed)
    labels = [c for c in classes for _ in range(per_class)]
    rng.shuffle(labels)
    trial_s = 2.0 + cue_s + 2.5
    n = int((15 + len(labels) * trial_s + 3) * FS)
    t = np.arange(n) / FS
    raw = rng.normal(0, 5.0, (8, n))
    amp = np.full((8, n), 20.0)
    c3, c4 = config.CHANNELS.index("C3"), config.CHANNELS.index("C4")
    trials, pos = [], 15.0
    for k, lab in enumerate(labels, 1):
        cue = pos + 2.0
        a, b = int(cue * FS), int((cue + cue_s) * FS)
        if lab == "left":
            amp[c4, a:b] *= 1 - effect
        if lab == "right":
            amp[c3, a:b] *= 1 - effect
        if lab == "clench":
            raw[:, a + 40:a + 110] += rng.normal(0, 120, (8, 70))
        trials.append({"label": lab, "cue_time": T0 + cue, "end_time": T0 + cue + cue_s, "trial": k, "run": 1,
                       "clench_peak_s": 0.6 if lab == "clench" else np.nan})
        pos += trial_s
    raw += amp * np.sin(2 * np.pi * 10 * t + rng.uniform(0, 2 * np.pi, (8, 1)))
    path = new_session_path(str(root), subject, stamp)
    return save_session(path, raw, T0 + t, FS, FS, trials, {"imagery_sec": cue_s, "synthetic": True})


@pytest.fixture
def recordings(tmp_path):
    root = tmp_path / "sessions"
    return root, [fake_recording(root, seed=1, stamp="20260101_000000"),
                  fake_recording(root, seed=2, stamp="20260102_000000")]
