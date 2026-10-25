import numpy as np

from eeg import config
from eeg.viz import FILTER_BANK, VizBridge

FS = 125.0


def window(amp):
    t = np.arange(250) / FS
    x = amp * np.sin(2 * np.pi * 10 * t)[None, :].repeat(8, 0) + np.random.default_rng(0).normal(0, 0.5, (8, 250))
    return {b["band"]: x for b in FILTER_BANK} | {config.COV_BAND: x}


def feed(bridge, amp, seconds, t0):
    msg = None
    for k in range(int(seconds * 10)):
        bridge.update(window(amp), None, 1.0, 1.0)
        msg = bridge.mi(t0 + k / 10)
    return msg, t0 + seconds


def test_baseline_then_erd_and_laterality_rules():
    b = VizBridge(FS, source="synthetic")
    b._started_at = 0.0
    msg, t = feed(b, 20.0, 6.0, 0.0)           # none -> recording -> set
    assert b.baseline_state == "set"
    msg, t = feed(b, 10.0, 1.0, t)             # half the amplitude = a quarter of the power
    assert -80 < msg["c3"]["mu"] < -70 and msg["laterality"] == round(msg["c4"]["mu"] - msg["c3"]["mu"], 1)
    assert msg["emgGate"] == (msg["emg"] > msg["emgThreshold"])


def test_a_baseline_caught_on_a_transient_is_replaced():
    b = VizBridge(FS, source="synthetic")
    b._started_at = 0.0
    _, t = feed(b, 400.0, 6.0, 0.0)            # baseline recorded during a huge settling transient
    assert b.baseline_state == "set"
    _, t = feed(b, 20.0, 4.0, t)               # real signal: everything pinned at -100 % for > 3 s
    assert b.baseline_state == "recording"
    _, t = feed(b, 20.0, 6.0, t)
    msg, _ = feed(b, 20.0, 1.0, t)
    assert b.baseline_state == "set" and abs(msg["c3"]["mu"]) < 20


class _Loop:
    """Stands in for the viz event loop: runs a scheduled call at once."""

    def call_soon_threadsafe(self, fn, *args):
        fn(*args)


def test_markers_carry_the_direct_words_and_the_jaw_source():
    from eeg import messages
    b = VizBridge(FS, source="synthetic")
    b.loop = _Loop()
    sent = []
    b._broadcast_now = lambda msg, stream: sent.append(msg)
    b.marker(messages.from_hand({"hand": "left", "onset": 1.0, "confidence": .8}, now=2.0))
    b.marker(messages.from_jaw({"kind": "double", "onset": 1.0, "t": 1.5, "strength": 50.0}, now=2.0))
    b.marker(messages.from_jaw({"kind": "long", "onset": 1.0, "t": 1.8, "strength": 50.0}, now=2.0))
    b.marker(messages.from_jaw({"kind": "single", "onset": 1.0, "t": 1.5, "strength": 50.0}, jaw_only=True, now=2.0))
    got = [(m["command"], m["source"], m["confidence"]) for m in sent]
    assert got == [("PICK_1", "imagery", 0.8), ("PICK_4", "jaw", None), ("STOP", "jaw", None), ("PICK_1", "jaw", None)]
