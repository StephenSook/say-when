import time

import numpy as np

from eeg import config, messages
from eeg.engine import Engine
from eeg.hands import HandConfig, HandDecoder
from eeg.jaw import JawDetector, strongest_spike
from eeg.filters import emg_envelope
from eeg.models import make
from eeg.sessions import load_session, make_epochs
from tests.conftest import FS, fake_recording

L, R, REST = {"left": .9, "right": .05, "rest": .05}, {"left": .05, "right": .9, "rest": .05}, \
    {"left": .05, "right": .05, "rest": .9}


def feed(dec, seq, t=0.0, dt=0.1):
    out = []
    for p in seq:
        ev = dec.update(t, p)
        out += [ev] if ev else []
        t += dt
    return out, t


def test_hand_decoder_needs_rest_first_and_fires_once():
    dec = HandDecoder(HandConfig(ema=0.0))
    ev, t = feed(dec, [R] * 30)
    assert ev == []                                  # starts disarmed
    _, t = feed(dec, [REST] * 6, t)
    ev, t = feed(dec, [R] * 60, t)                   # 6 s of sustained right
    assert [e["hand"] for e in ev] == ["right"]
    _, t = feed(dec, [REST] * 6, t)
    ev, _ = feed(dec, [L] * 15, t + 2)
    assert [e["hand"] for e in ev] == ["left"]


def test_suppression_blocks_hands():
    dec = HandDecoder(HandConfig(ema=0.0))
    _, t = feed(dec, [REST] * 6)
    dec.suppress(t + 5)
    ev, _ = feed(dec, [R] * 40, t)
    assert ev == []


def burst_signal(bursts, total_s=8.0, seed=0):
    """Quiet EEG with jaw bursts at (start_s, length_s)."""
    rng = np.random.default_rng(seed)
    n = int(total_s * FS)
    x = rng.normal(0, 3, (8, n))
    for start, length in bursts:
        a, b = int(start * FS), int((start + length) * FS)
        x[:, a:b] += rng.normal(0, 60, (8, b - a))
    return x


def run_jaw(bursts):
    det = JawDetector(FS)
    det.calibrate(np.random.default_rng(9).normal(0, 3, (8, int(5 * FS))))
    x = burst_signal(bursts)
    ts = np.arange(x.shape[1]) / FS
    events = []
    for i in range(0, x.shape[1], 13):
        events += det.process(x[:, i:i + 13], ts[i:i + 13])
    return [(e["kind"], round(e["onset"], 1)) for e in events]


def test_jaw_single_double_long_and_quiet():
    assert run_jaw([]) == []
    assert [k for k, _ in run_jaw([(1.0, 0.25)])] == ["single"]
    assert [k for k, _ in run_jaw([(1.0, 0.25), (1.6, 0.25)])] == ["double"]
    assert [k for k, _ in run_jaw([(1.0, 1.3)])] == ["long"]
    assert [k for k, _ in run_jaw([(1.0, 0.25), (4.0, 0.25)])] == ["single", "single"]


def test_jaw_messages_follow_the_command_map():
    # PLAN D17: a single clench is CONFIRM, a double or a held one is STOP.
    ev = {"kind": "single", "onset": 10.0, "t": 10.6, "strength": 50.0}
    m = messages.from_jaw(ev, now=10.7)
    assert m["type"] == "gesture" and m["command"] == "CONFIRM" and m["source"] == "jaw" and m["onsetAgeMs"] == 700
    assert messages.from_jaw(dict(ev, kind="double"))["command"] == "STOP"
    assert messages.from_jaw(dict(ev, kind="long"))["command"] == "STOP"
    # The jaw-only fallback keeps its own map: single is YES, double is CONFIRM, and there is no STOP gesture.
    assert messages.from_jaw(dict(ev, kind="long"), jaw_only=True) is None
    assert messages.from_jaw(dict(ev, kind="single"), jaw_only=True)["command"] == "YES"
    assert messages.from_jaw(dict(ev, kind="double"), jaw_only=True)["command"] == "CONFIRM"
    assert messages.from_hand({"hand": "right", "onset": 1.0, "confidence": .8}, now=2.0)["command"] == "YES"
    assert messages.from_hand({"hand": "left", "onset": 1.0, "confidence": .8}, now=2.0)["command"] == "NO"
    assert messages.health(True) == {"type": "health", "decoderHealthy": True}


def test_strongest_spike_needs_a_lead_in():
    x = burst_signal([], total_s=6.0) + 400  # big DC offset: edges ring without a lead-in
    base = float(np.median(emg_envelope(burst_signal([], total_s=20, seed=3), FS, config.JAW_SLICE_S)))
    with_lead, _ = strongest_spike(x, FS, base, lead_s=1.0)
    assert with_lead < config.JAW_RATIO


def test_engine_end_to_end_with_a_fake_headset(tmp_path):
    """Replays a synthetic recording (with a double clench appended) through the live engine."""
    s = load_session(fake_recording(tmp_path, per_class=10, seed=4))
    ep = make_epochs([s], ["left", "right", "rest"])
    meta = {"classes": ["left", "right", "rest"], "fs": FS, "window_s": 2.0}
    raw = np.concatenate([s["raw_eeg"], burst_signal([(1.0, 0.25), (1.6, 0.25)], total_s=4)], axis=1)
    ts = s["timestamps"][0] + np.arange(raw.shape[1]) / FS
    state = {"i": 0}

    def reader(_):
        i = state["i"]
        state["i"] += 13
        return raw[:, i:i + 13], ts[i:i + 13]

    eng = Engine(make("fbcsp_lda").fit(ep.X, ep.y), meta, HandConfig(dwell_s=0.5), settle_s=0, log=lambda *a: None,
                 reader=reader, opener=lambda: object(), closer=lambda b: None)
    eng.start()
    cmds = []
    while state["i"] < raw.shape[1]:
        cmds += [m["command"] for m in eng.poll().commands]
    assert {"YES", "NO"} <= set(cmds)          # synthetic data is easy; real EEG is not
    assert cmds[-1] == "STOP"                   # the appended double clench (PLAN D17)
    assert all(c in config.COMMANDS for c in cmds)


def test_watchdog_sends_headset_off():
    meta = {"classes": ["left", "right"], "fs": FS, "window_s": 2.0}
    feed_once = {"n": 0}

    def reader(_):
        feed_once["n"] += 1
        if feed_once["n"] < 40:
            return np.random.normal(0, 3, (8, 13)), time.time() + np.arange(13) / FS
        return np.empty((8, 0)), np.empty(0)

    eng = Engine(make("majority").fit({b: np.zeros((2, 8, 250)) for b in config.BANDS}, np.array([0, 1])), meta,
                 settle_s=0, log=lambda *a: None, reader=reader, opener=lambda: object(), closer=lambda b: None)
    eng.start()
    got, t_end = [], time.time() + 2
    while time.time() < t_end and "HEADSET_OFF" not in got:
        got += [m["command"] for m in eng.poll().commands]
    assert "HEADSET_OFF" in got and not eng.healthy()
