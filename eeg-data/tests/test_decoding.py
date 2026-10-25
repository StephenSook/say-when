import time

import numpy as np
import pytest

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
    # A short clench then a held one is one STOP, never also a pick (D18: STOP must not pick option 3 first).
    assert [k for k, _ in run_jaw([(1.0, 0.25), (1.6, 1.2)])] == ["long"]


def test_jaw_messages_follow_the_direct_map_by_default():
    # D18 direct select: single = PICK_3, double = PICK_4, a held clench = STOP.
    ev = {"kind": "single", "onset": 10.0, "t": 10.6, "strength": 50.0}
    m = messages.from_jaw(ev, now=10.7)
    assert m["type"] == "gesture" and m["command"] == "PICK_3" and m["source"] == "jaw" and m["onsetAgeMs"] == 700
    assert messages.from_jaw(dict(ev, kind="double"))["command"] == "PICK_4"
    assert messages.from_jaw(dict(ev, kind="long"))["command"] == "STOP"
    assert messages.from_jaw(dict(ev, kind="single"), mode="direct")["command"] == "PICK_3"
    # The fists pick options 1 and 2: left is 1, right is 2.
    assert messages.from_hand({"hand": "left", "onset": 1.0, "confidence": .8}, now=2.0)["command"] == "PICK_1"
    assert messages.from_hand({"hand": "right", "onset": 1.0, "confidence": .8}, now=2.0)["command"] == "PICK_2"
    assert messages.from_hand({"hand": "right", "onset": 1.0, "confidence": .8}, now=2.0)["source"] == "imagery"
    # Jaw-only in direct select: the jaw takes the two confirm picks, a held clench is STOP.
    assert messages.from_jaw(dict(ev, kind="single"), jaw_only=True)["command"] == "PICK_1"
    assert messages.from_jaw(dict(ev, kind="double"), jaw_only=True)["command"] == "PICK_2"
    assert messages.from_jaw(dict(ev, kind="long"), jaw_only=True)["command"] == "STOP"
    assert messages.health(True) == {"type": "health", "decoderHealthy": True}


def test_jaw_messages_follow_the_scan_map():
    # PLAN D17 (say-when-demo): a single clench is CONFIRM, a double or a held one is STOP.
    ev = {"kind": "single", "onset": 10.0, "t": 10.6, "strength": 50.0}
    m = messages.from_jaw(ev, now=10.7, mode="scan")
    assert m["command"] == "CONFIRM" and m["source"] == "jaw" and m["onsetAgeMs"] == 700
    assert messages.from_jaw(dict(ev, kind="double"), mode="scan")["command"] == "STOP"
    assert messages.from_jaw(dict(ev, kind="long"), mode="scan")["command"] == "STOP"
    # The scan jaw-only fallback keeps its own map: single is YES, double is CONFIRM, and there is no STOP gesture.
    assert messages.from_jaw(dict(ev, kind="long"), jaw_only=True, mode="scan") is None
    assert messages.from_jaw(dict(ev, kind="single"), jaw_only=True, mode="scan")["command"] == "YES"
    assert messages.from_jaw(dict(ev, kind="double"), jaw_only=True, mode="scan")["command"] == "CONFIRM"
    assert messages.from_hand({"hand": "right", "onset": 1.0, "confidence": .8}, now=2.0, mode="scan")["command"] == "YES"
    assert messages.from_hand({"hand": "left", "onset": 1.0, "confidence": .8}, now=2.0, mode="scan")["command"] == "NO"


def test_every_map_sends_only_its_own_words():
    ev = {"onset": 1.0, "t": 1.5, "strength": 50.0, "confidence": .8}
    for mode in config.MODES:
        sent = {messages.from_hand(dict(ev, hand=h), mode=mode)["command"] for h in config.HANDS}
        for jaw_only in (False, True):
            for kind in ("single", "double", "long"):
                m = messages.from_jaw(dict(ev, kind=kind), jaw_only=jaw_only, mode=mode)
                if m:
                    sent.add(m["command"])
        assert sent <= set(config.MODE_COMMANDS[mode]), (mode, sent)
    with pytest.raises(ValueError):
        messages.from_jaw(dict(ev, kind="single"), mode="sideways")
    with pytest.raises(ValueError):
        messages.gesture("MAYBE", 1.0, 0.5, "imagery")


def test_strongest_spike_needs_a_lead_in():
    x = burst_signal([], total_s=6.0) + 400  # big DC offset: edges ring without a lead-in
    base = float(np.median(emg_envelope(burst_signal([], total_s=20, seed=3), FS, config.JAW_SLICE_S)))
    with_lead, _ = strongest_spike(x, FS, base, lead_s=1.0)
    assert with_lead < config.JAW_RATIO


def _replay_engine(tmp_path, mode=None):
    """A live engine fed a synthetic recording with a double clench appended."""
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

    extra = {} if mode is None else {"mode": mode}
    eng = Engine(make("fbcsp_lda").fit(ep.X, ep.y), meta, HandConfig(dwell_s=0.5), settle_s=0, log=lambda *a: None,
                 reader=reader, opener=lambda: object(), closer=lambda b: None, **extra)
    eng.start()
    cmds = []
    while state["i"] < raw.shape[1]:
        cmds += [m["command"] for m in eng.poll().commands]
    return cmds


def test_engine_end_to_end_with_a_fake_headset(tmp_path):
    """Replays a synthetic recording (with a double clench appended) through the live engine, direct select."""
    cmds = _replay_engine(tmp_path)
    assert {"PICK_1", "PICK_2"} <= set(cmds)    # synthetic data is easy; real EEG is not
    assert cmds[-1] == "PICK_4"                  # the appended double clench (D18)
    assert all(c in config.MODE_COMMANDS["direct"] for c in cmds)


def test_engine_end_to_end_with_the_scan_map(tmp_path):
    cmds = _replay_engine(tmp_path, mode="scan")
    assert {"YES", "NO"} <= set(cmds)
    assert cmds[-1] == "STOP"                   # the appended double clench (PLAN D17)
    assert all(c in config.MODE_COMMANDS["scan"] for c in cmds)


def test_engine_refuses_an_unknown_mode():
    meta = {"classes": ["left", "right"], "fs": FS, "window_s": 2.0}
    with pytest.raises(ValueError):
        Engine(make("majority").fit({b: np.zeros((2, 8, 250)) for b in config.BANDS}, np.array([0, 1])), meta,
               settle_s=0, log=lambda *a: None, mode="sideways")


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
