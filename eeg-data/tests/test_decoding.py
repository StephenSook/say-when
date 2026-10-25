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

# Sure enough to fire at once (PLAN D21: right at 0.90 or more is YES, left at 0.96 or more is NO).
L, R, REST = {"left": .97, "right": .02, "rest": .01}, {"left": .02, "right": .95, "rest": .03}, \
    {"left": .05, "right": .05, "rest": .9}


def p(right=0.0, left=0.0):
    """One prediction; rest takes what is left."""
    return {"left": left, "right": right, "rest": round(1 - left - right, 6)}


def frames(fn, t_end, dt=0.1):
    """(t, proba) every dt from 0 up to and including t_end, with proba = fn(t)."""
    return [(round(k * dt, 3), fn(round(k * dt, 3))) for k in range(int(round(t_end / dt)) + 1)]


def run_frames(dec, seq):
    """Feeds (t, proba) pairs; returns the events with the time each fired."""
    out = []
    for t, pr in seq:
        ev = dec.update(t, pr)
        if ev:
            out.append(ev)
    return out


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
    ev, t = feed(dec, [R] * 60, t)                   # 6 s of sustained right: one YES, at once
    assert [(e["hand"], e["how"]) for e in ev] == [("right", "instant")]
    _, t = feed(dec, [REST] * 6, t)
    ev, _ = feed(dec, [L] * 15, t + 2)
    assert [(e["hand"], e["how"]) for e in ev] == [("left", "instant")]


def test_suppression_blocks_hands():
    dec = HandDecoder(HandConfig(ema=0.0))
    _, t = feed(dec, [REST] * 6)
    dec.suppress(t + 5)
    ev, _ = feed(dec, [R] * 40, t)
    assert ev == []


def test_the_imagery_defaults_are_the_d21_numbers():
    c = HandConfig()
    assert (c.yes_threshold, c.no_threshold, c.fallback_s, c.fallback_threshold, c.fallback_min) == \
        (0.90, 0.96, 0.0, 0.65, 3)                       # the fallback is off by default (Oct 24, Stephen)
    assert (c.instant("right"), c.instant("left")) == (0.90, 0.96)


def test_live_prints_the_imagery_settings_at_startup():
    import live
    line = live.imagery_settings(HandConfig())
    assert "fallback off" in line
    on = live.imagery_settings(HandConfig(fallback_s=10.0))
    for part in (">= 0.90 (right fist)", ">= 0.96 (left fist)", "every 10 s", ">= 0.65", "at least 3"):
        assert part in on, part
    # Direct select is the default: the same per-hand thresholds, named by the word each hand sends.
    assert line.startswith("Imagery: PICK_2 at once at >= 0.90 (right fist), PICK_1 at once at >= 0.96 (left fist);")
    assert live.imagery_settings(HandConfig(), mode="scan").startswith(
        "Imagery: YES at once at >= 0.90 (right fist), NO at once at >= 0.96 (left fist);")
    assert live.imagery_settings(HandConfig(), jaw_only=True) == "Imagery: off (--jaw-only)"
    assert live.imagery_settings(HandConfig(), jaw_only=True, mode="scan") == "Imagery: off (--jaw-only)"


def test_right_at_0_91_is_yes_at_once():
    dec = HandDecoder(HandConfig(ema=0.0))           # ema 0: the confidence is exactly the prediction
    events = run_frames(dec, [(0.0, REST), (0.1, REST), (0.2, p(right=0.91))])
    assert [(e["hand"], e["how"], e["t"]) for e in events] == [("right", "instant", 0.2)]
    msg = messages.from_hand(events[0], mode="scan")
    assert msg["command"] == "YES" and msg["confidence"] == 0.91 and msg["source"] == "imagery"
    assert messages.from_hand(events[0])["command"] == "PICK_2"     # direct select, the default


def test_left_needs_0_96_to_be_no_at_once():
    dec = HandDecoder(HandConfig(ema=0.0))
    seq = frames(lambda t: REST if t < 0.3 else p(left=0.95), 3.0)          # 0.95 for nearly 3 s: nothing at once
    assert run_frames(dec, seq) == []
    events = run_frames(dec, [(3.1, p(left=0.97))])
    assert [(e["hand"], e["how"], e["t"]) for e in events] == [("left", "instant", 3.1)]
    assert messages.from_hand(events[0], mode="scan")["command"] == "NO"
    assert messages.from_hand(events[0])["command"] == "PICK_1"     # direct select, the default


def test_fallback_after_10_s_picks_the_hand_with_more_confident_moments():
    def fn(t):
        k = int(round(t * 10))
        if k % 10 == 5:
            return p(right=0.70)                         # 10 right moments at or above 0.65
        if k % 25 == 3:
            return p(left=0.80)                          # 4 left moments
        return [p(right=0.6), p(left=0.6), p(right=0.3, left=0.3), REST][k % 4]   # sub-threshold, not counted
    dec = HandDecoder(HandConfig(ema=0.0, fallback_s=10.0))
    events = run_frames(dec, frames(fn, 12.0))
    assert len(events) == 1
    ev = events[0]
    assert (ev["hand"], ev["how"], ev["t"]) == ("right", "fallback", 10.0)   # the window started at 0.0
    assert ev["counts"] == {"left": 4, "right": 10}
    assert ev["onset"] == 9.5 and ev["confidence"] == 0.7                     # the last counted moment, its mean
    assert messages.from_hand(ev, mode="scan")["command"] == "YES"
    assert messages.from_hand(ev)["command"] == "PICK_2"             # direct select, the default


def test_fallback_tie_or_too_few_sends_nothing():
    tie = HandDecoder(HandConfig(ema=0.0, fallback_s=10.0))
    seq = frames(lambda t: p(right=0.7) if t in (1.0, 2.0, 3.0, 4.0) else
                 p(left=0.7) if t in (5.0, 6.0, 7.0, 8.0) else REST, 12.0)
    assert run_frames(tie, seq) == []
    assert tie.counts == {"left": 0, "right": 0} and tie.window_start == 10.0   # the window started again
    few = HandDecoder(HandConfig(ema=0.0, fallback_s=10.0))
    assert run_frames(few, frames(lambda t: p(right=0.7) if t in (1.0, 2.0) else REST, 12.0)) == []
    assert run_frames(HandDecoder(HandConfig(ema=0.0, fallback_s=10.0, fallback_min=2)),
                      frames(lambda t: p(right=0.7) if t in (1.0, 2.0) else REST, 12.0))[0]["hand"] == "right"


def test_the_window_restarts_after_a_command():
    def fn(t):
        if t in (1.0, 2.0, 3.0, 4.0):
            return p(left=0.7)                           # counted, then wiped by the YES at 5 s
        if t == 5.0:
            return p(right=0.92)                         # YES at once; a new window starts at 5.0
        if t in (8.0, 8.5, 9.0, 9.5, 10.5):
            return p(right=0.7)
        return REST
    dec = HandDecoder(HandConfig(ema=0.0, fallback_s=10.0))
    events = run_frames(dec, frames(fn, 16.0))
    assert [(e["hand"], e["how"], e["t"]) for e in events] == [("right", "instant", 5.0), ("right", "fallback", 15.0)]
    assert events[1]["counts"] == {"left": 0, "right": 5}


def test_no_fallback_by_default_steady_noise_sends_nothing():
    # A steady 0.70 right (a confident moment, under the 0.90 at-once threshold) for 30 s: with the fallback off,
    # nothing is sent. With it on, this sent a stray pick every 10 s (Oct 24 live session).
    steady = frames(lambda t: p(right=0.70), 30.0)
    assert run_frames(HandDecoder(HandConfig(ema=0.0)), steady) == []
    assert len(run_frames(HandDecoder(HandConfig(ema=0.0, fallback_s=10.0)), steady)) == 3


def test_the_live_defaults_still_fire_through_smoothing():
    # ema 0.5: a steady 0.92 right reaches 0.90 within a second; a steady 0.95 left never reaches 0.96 at once.
    dec = HandDecoder(HandConfig())
    events = run_frames(dec, frames(lambda t: REST if t < 1.0 else p(right=0.92), 3.0))
    assert [e["how"] for e in events] == ["instant"] and 1.0 < events[0]["t"] <= 2.0
    assert events[0]["confidence"] >= 0.90
    dec = HandDecoder(HandConfig())
    assert run_frames(dec, frames(lambda t: REST if t < 1.0 else p(left=0.95), 9.0)) == []


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
    # D18 direct select with PLAN D21: single = PICK_3, a held clench = STOP, a double sends nothing (no PICK_4).
    ev = {"kind": "single", "onset": 10.0, "t": 10.6, "strength": 50.0}
    m = messages.from_jaw(ev, now=10.7)
    assert m["type"] == "gesture" and m["command"] == "PICK_3" and m["source"] == "jaw" and m["onsetAgeMs"] == 700
    assert messages.from_jaw(dict(ev, kind="double")) is None
    assert messages.from_jaw(dict(ev, kind="double"), mode="direct") is None
    assert messages.from_jaw(dict(ev, kind="long"))["command"] == "STOP"
    assert messages.from_jaw(dict(ev, kind="single"), mode="direct")["command"] == "PICK_3"
    assert messages.JAW_COMMAND["direct"] == {"single": "PICK_3", "long": "STOP"}
    assert "PICK_4" not in config.COMMANDS and config.PICKS == ("PICK_1", "PICK_2", "PICK_3")
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
    # PLAN D21 (say-when-demo): a single clench is CONFIRM (D17), a held one is STOP, and a double sends nothing.
    ev = {"kind": "single", "onset": 10.0, "t": 10.6, "strength": 50.0}
    m = messages.from_jaw(ev, now=10.7, mode="scan")
    assert m["command"] == "CONFIRM" and m["source"] == "jaw" and m["onsetAgeMs"] == 700
    assert messages.from_jaw(dict(ev, kind="double"), mode="scan") is None
    assert messages.from_jaw(dict(ev, kind="long"), mode="scan")["command"] == "STOP"
    assert messages.JAW_COMMAND["scan"] == {"single": "CONFIRM", "long": "STOP"}
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


def run_engine(tmp_path, bursts, mode=None):
    """Replays a synthetic recording, with jaw bursts appended, through the live engine; returns the commands and
    the raw clench kinds."""
    s = load_session(fake_recording(tmp_path, per_class=10, seed=4))
    ep = make_epochs([s], ["left", "right", "rest"])
    meta = {"classes": ["left", "right", "rest"], "fs": FS, "window_s": 2.0}
    raw = np.concatenate([s["raw_eeg"], burst_signal(bursts, total_s=4)], axis=1)
    ts = s["timestamps"][0] + np.arange(raw.shape[1]) / FS
    state = {"i": 0}

    def reader(_):
        i = state["i"]
        state["i"] += 13
        return raw[:, i:i + 13], ts[i:i + 13]

    extra = {} if mode is None else {"mode": mode}
    eng = Engine(make("fbcsp_lda").fit(ep.X, ep.y), meta, HandConfig(), settle_s=0, log=lambda *a: None,
                 reader=reader, opener=lambda: object(), closer=lambda b: None, **extra)
    eng.start()
    cmds, jaw = [], []
    while state["i"] < raw.shape[1]:
        up = eng.poll()
        cmds += [m["command"] for m in up.commands]
        jaw += [e["kind"] for e in up.jaw_events]
    assert all(c in config.MODE_COMMANDS[eng.mode] for c in cmds), (eng.mode, cmds)
    return cmds, jaw


def test_engine_end_to_end_with_a_fake_headset(tmp_path):
    """Direct select, the default: the fists are PICK_1 and PICK_2, a held clench at the end is STOP (PLAN D21)."""
    cmds, jaw = run_engine(tmp_path, [(1.0, 1.3)])
    assert {"PICK_1", "PICK_2"} <= set(cmds)  # synthetic data is easy; real EEG is not
    assert jaw == ["long"] and cmds[-1] == "STOP"   # the recording has no clench trials, so this is the only one
    assert cmds.count("STOP") == 1 and "PICK_3" not in cmds


def test_engine_end_to_end_with_the_scan_map(tmp_path):
    """A held clench at the end is STOP (PLAN D21)."""
    cmds, jaw = run_engine(tmp_path, [(1.0, 1.3)], mode="scan")
    assert {"YES", "NO"} <= set(cmds)
    assert jaw == ["long"] and cmds[-1] == "STOP"
    assert cmds.count("STOP") == 1 and "CONFIRM" not in cmds


@pytest.mark.parametrize("mode", ["direct", "scan"])
def test_engine_double_clench_sends_nothing(tmp_path, mode):
    """A double clench at the end is detected but sends no command in either map, and does not crash (PLAN D21)."""
    cmds, jaw = run_engine(tmp_path, [(1.0, 0.25), (1.6, 0.25)], mode=mode)
    assert set(config.HAND_COMMANDS[mode].values()) <= set(cmds)
    assert jaw == ["double"]
    assert not {"STOP", "CONFIRM", "PICK_3", "PICK_4"} & set(cmds)


def test_engine_refuses_an_unknown_mode():
    meta = {"classes": ["left", "right"], "fs": FS, "window_s": 2.0}
    with pytest.raises(ValueError):
        Engine(make("majority").fit({b: np.zeros((2, 8, 250)) for b in config.BANDS}, np.array([0, 1])), meta,
               settle_s=0, log=lambda *a: None, mode="sideways")


class SteadyModel:
    """Always the same prediction: right at 0.70, under YES's 0.90 but a confident moment for the fallback."""

    def proba(self, _bands):
        return np.array([[0.05, 0.70, 0.25]])   # left, right, rest


class ScriptModel:
    """Rest for the first rest_n predictions, then p (left, right, rest) for good."""

    def __init__(self, p, rest_n=10):
        self.p, self.rest_n, self.k = np.array([p]), rest_n, 0

    def proba(self, _bands):
        self.k += 1
        return np.array([[0.05, 0.05, 0.90]]) if self.k <= self.rest_n else self.p


def run_steady(bursts, total_s=26.0, model=None, mode=None):
    """The live engine on quiet EEG with jaw bursts and a scripted model (default: stuck at right 0.70); returns
    (stream time, command) pairs."""
    meta = {"classes": ["left", "right", "rest"], "fs": FS, "window_s": 2.0}
    raw = burst_signal(bursts, total_s=total_s, seed=5)
    ts = 1000.0 + np.arange(raw.shape[1]) / FS
    state = {"i": 0}

    def reader(_):
        i = state["i"]
        state["i"] += 13
        return raw[:, i:i + 13], ts[i:i + 13]

    extra = {} if mode is None else {"mode": mode}
    # These engine runs exercise the D21 fallback window, so they turn it on (it is off by default).
    eng = Engine(model or SteadyModel(), meta, HandConfig(fallback_s=10.0), settle_s=0, log=lambda *a: None,
                 reader=reader, opener=lambda: object(), closer=lambda b: None, **extra)
    eng.start()
    out = []
    while state["i"] < raw.shape[1]:
        up = eng.poll()
        out += [(float(ts[min(state["i"], len(ts)) - 1]) - 1000.0, m["command"]) for m in up.commands]
    return out


@pytest.mark.parametrize("mode, right, single", [("scan", "YES", "CONFIRM"), ("direct", "PICK_2", "PICK_3")])
def test_a_jaw_command_restarts_the_imagery_window(mode, right, single):
    # Without a clench: the window starts with the first prediction (about 2 s in, after the warm-up) and the
    # fallback sends the right fist 10 s later, then every 10 s while the model stays at 0.70 (the trade-off in
    # PLAN D21).
    alone = run_steady([], mode=mode)
    assert [c for _, c in alone] == [right, right]
    assert 11.5 < alone[0][0] < 12.5 and 9.5 < alone[1][0] - alone[0][0] < 10.5
    # A single clench at 6 s is sent about 7 s in; the window starts again there, so the fist waits 10 s more.
    clench = run_steady([(6.0, 0.25)], mode=mode)
    assert [c for _, c in clench][:2] == [single, right]
    (t_jaw, _), (t_fist, _) = clench[:2]
    assert 6.5 < t_jaw < 7.5 and 9.9 < t_fist - t_jaw < 10.5


@pytest.mark.parametrize("mode, right, left", [("direct", "PICK_2", "PICK_1"), ("scan", "YES", "NO")])
def test_each_hand_keeps_its_own_threshold_in_both_maps(mode, right, left):
    # The right fist at 0.92 clears its 0.90 (--yes-threshold): sent at once, well under a second after the rest.
    out = run_steady([], total_s=6.0, model=ScriptModel((0.03, 0.92, 0.05)), mode=mode)
    assert [c for _, c in out] == [right] and out[0][0] < 4.5
    # The left fist at 0.95 is under its 0.96 (--no-threshold): nothing at once in either map, so it waits for the
    # 10 s fallback window (it counts there, at 0.65 or more).
    out = run_steady([], total_s=14.0, model=ScriptModel((0.95, 0.03, 0.02)), mode=mode)
    assert [c for _, c in out] == [left] and 11.5 < out[0][0] < 12.5


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
    assert eng.hands.window_start is None      # HEADSET_OFF restarts the imagery window (PLAN D21)
