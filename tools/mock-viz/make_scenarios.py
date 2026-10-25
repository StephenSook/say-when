#!/usr/bin/env python3
"""Make the scripted Screen 1 scenarios in tools/mock-viz/ (one JSON Lines file per scenario).

SCRIPTED MOCK DATA. Nothing in these files is a measurement.

Each scenario file is JSON Lines. The first line describes the scenario; every other line is one thing the
replay tool (tools/viz_replay.py) sends at `at` seconds from the start:

  {"at":0.0,"info":{"scenario":"02-right-fist-yes","description":"...","screen":"...","seconds":10.0,"seed":2}}
  {"at":0.0,"frame":{"type":"viz.meta",...}}            one protocol message, exactly as the bridge sends it
  {"at":0.1,"frame":{"type":"viz.mi","t":0.1,...}}
  {"at":2.05,"raw":"{not json","expect":"reject","why":"bad JSON"}           12-malformed only: sent as is
  {"at":3.05,"bytes":"00ff","expect":"reject","why":"binary frame"}          12-malformed only: a binary frame

Extra keys on a line:
  "expect": "reject"      the page must ignore this line (applyFrame returns false)
  "expect": "fb_ignored"  the page uses the frame but drops its fb (the fb length does not fit the filter bank)
  "why":                  plain words on what is wrong with the line
  "baseline": true        part of the rest baseline recording (07-baseline-flow); viz_replay.py replays these
                          frames when the page asks for a new baseline

Times inside frames are placeholders, rewritten by viz_replay.py when it sends the frame:
  - every numeric "t" is written as the line's `at` (seconds from the start) and sent as round(time.time(), 3);
  - viz.meta "baseline.recordedAt" is written in seconds from the start (negative means before the file starts)
    and sent as time.time() + (recordedAt - at) / speed;
  - viz.marker "id" is a fixed uuid4 in the file and sent as a fresh uuid4 on every play (the same file id gets the
    same fresh id within one play, so a repeated id stays repeated);
  - viz.meta "recordedAt" (when a replayed session was recorded) is absolute unix seconds and sent as is.

The numbers follow the synthetic bridge (tools/viz_bridge_synthetic.py, tools/VIZ_PROTOCOL.md section 5): the same
six-band filter bank, the same imagery change per band, mu equal to the 8 to 12 Hz band, beta the mean of the four
bands from 12 to 30 Hz, laterality c4.mu - c3.mu, emgGate exactly when emg > emgThreshold.

  python tools/mock-viz/make_scenarios.py           # write every scenario file
  python tools/mock-viz/make_scenarios.py --check   # exit 1 if a file on disk differs from what this makes

Standard library only. Deterministic: each scenario has its own seed, so the same code always makes the same bytes.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import random
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent

TICK_S = 0.1  # viz.mi and viz.spec at 10 Hz
QUALITY_EVERY_TICKS = 5  # viz.quality at 2 Hz
RAMP_S = 0.5  # rise and fall of the imagery change, as in the synthetic bridge
SRATE = 250
CHANNELS = ("C3", "C4")
SIDES = ("c3", "c4")
# The decoder's filter bank, exactly as the synthetic bridge sends it: (id, lo Hz, hi Hz, label).
FILTER_BANK = (
    ("mrcp", 0.05, 5, "Slow potential 0.05-5 Hz"),
    ("b8_12", 8, 12, "Mu 8-12 Hz"),
    ("b12_16", 12, 16, "Low beta 12-16 Hz"),
    ("b16_20", 16, 20, "Beta 16-20 Hz"),
    ("b20_26", 20, 26, "Beta 20-26 Hz"),
    ("b26_30", 26, 30, "High beta 26-30 Hz"),
)
FB_IDS = tuple(band[0] for band in FILTER_BANK)
N_FB = len(FILTER_BANK)
MU_FB = FB_IDS.index("b8_12")
BETA_FB = tuple(FB_IDS.index(i) for i in ("b12_16", "b16_20", "b20_26", "b26_30"))
SPEC_FREQS = list(range(1, 41))
EMG_THRESHOLD = 40.0
ERD_MIN, ERD_MAX = -100.0, 1000.0

# Change in band power at full imagery on the side opposite the imagined hand (the synthetic bridge's table).
IMAGERY_CHANGE = {"mrcp": 0.25, "b8_12": -0.30, "b12_16": -0.24, "b16_20": -0.16, "b20_26": -0.11, "b26_30": -0.07}
IPSI_FRACTION = 0.1  # the same side as the hand moves by a tenth of it
# Jaw clench rise per band, both sides (a fraction). Chosen so a gated frame reads +150 to +300 at 20 to 30 Hz.
CLENCH_RISE = {"b16_20": (0.25, 0.45), "b20_26": (1.85, 2.3), "b26_30": (2.1, 2.6)}
CLENCH_SIDE_SPREAD = 0.05  # each side gets the clench rise times 0.95 to 1.05
# Clench shape per 100 ms frame: a lead-in frame, the gated frames, a trailing frame.
GATE_SHAPES = {1: (1.0,), 2: (1.0, 0.95), 3: (0.95, 1.0, 0.95), 9: (0.95,) + (1.0,) * 7 + (0.95,)}  # 9: a held clench
LEAD_SHAPE, TRAIL_SHAPE = 0.15, 0.1
EMG_PEAK = (95.0, 140.0)  # uV RMS at the top of a clench
# Rest wander: AR(1) on band power, about 2 % standard deviation, never past 4 %, so at rest each band reads within
# about plus or minus 4 points.
NOISE_KEEP, NOISE_STD, NOISE_CLIP = 0.8, 0.018, 0.04

BOARD = "SCRIPTED_MOCK"
TRACE_FILTER = "none (scripted mock)"
GOOD = {"C3": "good", "C4": "good"}
BASELINE_BEFORE = -40.0  # most scenarios: the rest baseline was set 40 s before the file starts


@dataclass
class Plan:
    """One scenario. Times are seconds from the start of the file."""

    name: str
    seed: int
    seconds: float
    description: str  # one line for viz_replay.py --list
    screen: str  # one line: what the page should show
    source: str = "synthetic"
    recorded_at: float | None = None  # meta.recordedAt, absolute unix seconds (replay only)
    brain_test: tuple[str, str | None] = ("not_run", None)
    filter_bank: bool = True  # False: an older bridge with no filterBank and no fb
    note: str | None = None
    # Baseline changes: (at, state, recordedAt in seconds from the start, or None).
    baseline: list[tuple[float, str, float | None]] = field(default_factory=lambda: [(0.0, "set", BASELINE_BEFORE)])
    tag_baseline_segment: bool = False  # tag the frames from "recording" to "set" with "baseline": true
    imagery: list[tuple[float, float, str, float]] = field(default_factory=list)  # (start, end, side that quiets, scale)
    clenches: list[tuple[float, int]] = field(default_factory=list)  # (first gated frame, gated frames)
    markers: list[tuple[float, str, str]] = field(default_factory=list)  # (at, command, source)
    contact: list[tuple[float, dict]] = field(default_factory=lambda: [(0.0, GOOD)])  # (from, contact)
    c4_extra: list[tuple[float, float, float, float]] = field(default_factory=list)  # (from, to, lo, hi) C4 power rise
    frames_until: float | None = None  # no frame after this time (06-headset-off)
    junk: bool = False  # 12-malformed: interleave junk lines


# ---------- small helpers ----------


def r3(x: float) -> float:
    return round(x + 0.0, 3)


def r1(x: float) -> float:
    v = round(x, 1)
    return 0.0 if v == 0 else v  # never "-0.0"


def smoothstep(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3.0 - 2.0 * x)


def envelope(pos: float, start: float, end: float) -> float:
    """0 outside the window, a smooth 0.5 s rise and fall, 1 in the middle (as in the synthetic bridge)."""
    if pos <= start + 1e-9 or pos >= end - 1e-9:
        return 0.0
    return min(smoothstep((pos - start) / RAMP_S), smoothstep((end - pos) / RAMP_S))


def uuid4(rng: random.Random) -> str:
    return str(uuid.UUID(int=rng.getrandbits(128), version=4))


def base_psd(side: str) -> list[float]:
    """A plain resting EEG shape in uV^2/Hz at 1..40 Hz: 1/f, a mu peak near 10 Hz, a small beta bump near 20 Hz."""
    peak = 10.0 if side == "c3" else 10.5
    return [
        25.0 / f ** 1.3 + 5.0 * math.exp(-0.5 * ((f - peak) / 1.6) ** 2) + 0.6 * math.exp(-0.5 * ((f - 20.0) / 3.0) ** 2) + 0.04
        for f in SPEC_FREQS
    ]


def spec_band(f: int) -> int | None:
    """Which filter-bank band a 1 Hz bin belongs to (bins from lo up to but not including hi)."""
    for i, (_, lo, hi, _) in enumerate(FILTER_BANK):
        if lo <= f < hi:
            return i
    return None


BASE_PSD = {side: base_psd(side) for side in SIDES}
SPEC_BAND = [spec_band(f) for f in SPEC_FREQS]
HIGH_BEYOND = FB_IDS.index("b26_30")  # EMG is broadband: the bins from 30 to 40 Hz rise like 26 to 30 Hz


def meta_frame(plan: Plan, state: str, recorded_rel: float | None) -> dict:
    m: dict = {
        "type": "viz.meta",
        "v": 1,
        "source": plan.source,
        "board": BOARD,
        "srate": SRATE,
        "channels": list(CHANNELS),
        "units": "uV",
        "traceFilter": TRACE_FILTER,
    }
    if plan.filter_bank:
        m["bands"] = {"alpha_mu": [8, 12], "beta": [12, 30]}
        m["filterBank"] = [{"id": i, "lo": lo, "hi": hi, "label": label} for i, lo, hi, label in FILTER_BANK]
    else:  # an older bridge with its own band edges and no filter bank
        m["bands"] = {"alpha_mu": [8, 13], "beta": [13, 30]}
    m["baseline"] = {"state": state, "recordedAt": recorded_rel if state == "set" else None}
    m["recordedAt"] = plan.recorded_at
    m["brainTest"] = {"state": plan.brain_test[0], "summary": plan.brain_test[1]}
    m["note"] = plan.note or f"Scripted mock scenario {plan.name} for UI testing. Not a measurement."
    return m


# ---------- the generator ----------


class Maker:
    def __init__(self, plan: Plan) -> None:
        self.plan = plan
        self.rng = random.Random(plan.seed)
        self.noise = [[0.0] * N_FB for _ in SIDES]
        self.emg_drift = 0.0
        self.lines: list[dict] = []
        self.clench_shape: dict[float, float] = {}  # at -> shape
        self.clench_rise: dict[float, list[list[float]]] = {}  # at -> rise per side and band
        self.clench_peak: dict[float, float] = {}
        self.gated_planned: set[float] = set()
        for first, n in plan.clenches:
            peak = self.rng.uniform(*EMG_PEAK)
            rise = [[0.0] * N_FB for _ in SIDES]
            for band, (lo, hi) in CLENCH_RISE.items():
                level = self.rng.uniform(lo, hi)
                for s in range(2):
                    rise[s][FB_IDS.index(band)] = level * self.rng.uniform(1 - CLENCH_SIDE_SPREAD, 1 + CLENCH_SIDE_SPREAD)
            frames = [(r3(first - TICK_S), LEAD_SHAPE)]
            frames += [(r3(first + k * TICK_S), shape) for k, shape in enumerate(GATE_SHAPES[n])]
            frames += [(r3(first + n * TICK_S), TRAIL_SHAPE)]
            for at, shape in frames:
                assert at not in self.clench_shape, f"{plan.name}: clench frames overlap at {at}"
                self.clench_shape[at] = shape
                self.clench_rise[at] = rise
                self.clench_peak[at] = peak
            self.gated_planned.update(r3(first + k * TICK_S) for k in range(n))
        self.marker_ids: dict[float, str] = {}
        self.last_mi: dict | None = None
        self.last_marker: dict | None = None
        self.meta: dict | None = None

    def add(self, at: float, **line) -> None:
        self.lines.append({"at": r3(at), **line})

    def step_noise(self) -> None:
        a = math.sqrt(1 - NOISE_KEEP ** 2) * NOISE_STD
        for s in range(2):
            for b in range(N_FB):
                v = NOISE_KEEP * self.noise[s][b] + a * self.rng.gauss(0.0, 1.0)
                self.noise[s][b] = min(NOISE_CLIP, max(-NOISE_CLIP, v))

    def gains(self, at: float) -> list[list[float]]:
        """Multipliers on band power, per side and band, from the script (imagery, clench, bad contact)."""
        g = [[1.0] * N_FB for _ in SIDES]
        for start, end, side, scale in self.plan.imagery:
            env = envelope(at, start, end)
            if env <= 0:
                continue
            for s, name in enumerate(SIDES):
                frac = 1.0 if name == side else IPSI_FRACTION
                for b, band in enumerate(FB_IDS):
                    g[s][b] *= 1.0 + IMAGERY_CHANGE[band] * scale * frac * env
        shape = self.clench_shape.get(r3(at), 0.0)
        if shape > 0:
            rise = self.clench_rise[r3(at)]
            for s in range(2):
                for b in range(N_FB):
                    g[s][b] *= 1.0 + rise[s][b] * shape
        for lo_at, hi_at, lo, hi in self.plan.c4_extra:
            if lo_at - 1e-9 <= at < hi_at - 1e-9:
                for b in range(N_FB):
                    g[1][b] *= 1.0 + self.rng.uniform(lo, hi)
        return g

    def emg(self, at: float) -> float:
        """Jaw muscle level, uV RMS: 2 to 6 at rest, 80 to 150 at the top of a clench (as in the synthetic bridge)."""
        self.emg_drift = 0.7 * self.emg_drift + self.rng.gauss(0.0, 0.6)
        level = min(6.0, max(2.0, 4.0 + self.emg_drift + self.rng.gauss(0.0, 0.3)))
        shape = self.clench_shape.get(r3(at), 0.0)
        if shape > 0:
            level += self.clench_peak[r3(at)] * shape * (1.0 + self.rng.gauss(0.0, 0.03))
        return r1(level)

    def contact(self, at: float) -> dict:
        current = GOOD
        for start, c in self.plan.contact:
            if start <= at + 1e-9:
                current = c
        return dict(current)

    def make(self) -> list[dict]:
        plan = self.plan
        self.add(0.0, info={
            "scenario": plan.name,
            "description": plan.description,
            "screen": plan.screen,
            "seconds": plan.seconds,
            "seed": plan.seed,
        })
        state, recorded_rel, set_at = "none", None, None
        in_segment = False
        markers = sorted(plan.markers)
        n_ticks = int(round(plan.seconds / TICK_S))
        last = plan.frames_until if plan.frames_until is not None else plan.seconds - TICK_S
        for k in range(n_ticks):
            at = r3(k * TICK_S)
            if at > last + 1e-9:
                break
            tick_lines_start = len(self.lines)
            for ev_at, ev_state, ev_rel in plan.baseline:
                if abs(ev_at - at) < 1e-9:
                    state, recorded_rel = ev_state, ev_rel
                    if state == "set":
                        set_at = ev_at if ev_rel is None else ev_rel
                    if state == "recording" and plan.tag_baseline_segment:
                        in_segment = True
                    self.meta = meta_frame(plan, state, recorded_rel)
                    self.add(at, frame=self.meta, **({"baseline": True} if in_segment else {}))
                    if state == "set":
                        in_segment = False
            self.step_noise()
            g = self.gains(at)
            emg = self.emg(at)
            fb = [[0.0] * N_FB for _ in SIDES]
            if state == "set":
                for s in range(2):
                    for b in range(N_FB):
                        erd = ((1.0 + self.noise[s][b]) * g[s][b] - 1.0) * 100.0
                        fb[s][b] = r1(min(ERD_MAX, max(ERD_MIN, erd)))
            mu = [fb[s][MU_FB] for s in range(2)]
            beta = [r1(sum(fb[s][b] for b in BETA_FB) / len(BETA_FB)) for s in range(2)]
            gate = emg > EMG_THRESHOLD
            assert gate == (at in self.gated_planned), f"{plan.name}: emgGate {gate} at {at} is not what the plan says"
            mi = {
                "type": "viz.mi",
                "t": at,
                "c3": {"mu": mu[0], "beta": beta[0]},
                "c4": {"mu": mu[1], "beta": beta[1]},
                "laterality": r1(mu[1] - mu[0]),
                "emgGate": gate,
                "baselineAgeS": r1(at - set_at) if state == "set" and set_at is not None else None,
                "emg": emg,
                "emgThreshold": EMG_THRESHOLD,
            }
            if plan.filter_bank:
                mi["fb"] = {"c3": fb[0], "c4": fb[1]}
            self.add(at, frame=mi)
            self.last_mi = mi
            self.add(at, frame=self.spec(at, g))
            if k % QUALITY_EVERY_TICKS == 0:
                self.add(at, frame={"type": "viz.quality", "t": at, "contact": self.contact(at)})
            while markers and markers[0][0] < at + TICK_S - 1e-9:
                m_at, command, source = markers.pop(0)
                marker = {
                    "type": "viz.marker",
                    "t": r3(m_at),
                    "id": uuid4(self.rng),
                    "command": command,
                    # At-once picks (PLAN D21): YES at 0.90 or more, NO at 0.96 or more.
                    "confidence": r3(round(self.rng.uniform(*((0.90, 0.97) if command == "YES" else (0.96, 0.99))), 2))
                    if source == "imagery" else None,
                    "source": source,
                }
                self.add(m_at, frame=marker)
                self.last_marker = marker
            if in_segment:
                for line in self.lines[tick_lines_start:]:
                    line["baseline"] = True
            if plan.junk:
                for line in junk_after(at, self):
                    self.lines.append(line)
        assert not markers, f"{plan.name}: markers after the last frame: {markers}"
        self.check()
        return self.lines

    def spec(self, at: float, g: list[list[float]]) -> dict:
        out = {}
        for s, side in enumerate(SIDES):
            row = []
            for i, f in enumerate(SPEC_FREQS):
                p = BASE_PSD[side][i]
                band = SPEC_BAND[i]
                if band is not None:
                    p *= g[s][band]
                elif f >= 30 and self.clench_shape.get(r3(at), 0.0) > 0:
                    p *= 1.0 + self.clench_rise[r3(at)][s][HIGH_BEYOND] * self.clench_shape[r3(at)]
                row.append(round(math.log10(max(p, 1e-12)) + self.rng.gauss(0.0, 0.03), 3))
            out[side] = row
        return {"type": "viz.spec", "t": at, "freqs": SPEC_FREQS, "c3": out["c3"], "c4": out["c4"]}

    def check(self) -> None:
        """The numbers the tests rely on, checked at the source so a change here cannot drift silently."""
        plan = self.plan
        ats = [line["at"] for line in self.lines]
        assert ats == sorted(ats), f"{plan.name}: lines are not in time order"
        for line in self.lines:
            frame = line.get("frame")
            if not isinstance(frame, dict) or frame.get("type") != "viz.mi" or line.get("expect"):
                continue
            at = line["at"]
            if frame["baselineAgeS"] is None:
                continue
            c3, c4 = frame["c3"]["mu"], frame["c4"]["mu"]
            busy = any(start - 0.05 <= at <= end + 0.05 for start, end, _, _ in plan.imagery)
            bad = any(lo <= at < hi for lo, hi, _, _ in plan.c4_extra)
            if not busy and not bad:
                assert abs(c3) <= 6 and abs(c4) <= 6, f"{plan.name}: rest mu {c3}, {c4} at {at}"
            for start, end, side, scale in plan.imagery:
                if start + RAMP_S <= at <= end - RAMP_S:
                    contra, ipsi = (c3, c4) if side == "c3" else (c4, c3)
                    assert -30 * scale - 5 <= contra <= -30 * scale + 5, f"{plan.name}: imagery mu {contra} at {at}"
                    assert -8 <= ipsi <= 2, f"{plan.name}: other side mu {ipsi} at {at}"
            if frame["emgGate"] and "fb" in frame:
                for side in SIDES:
                    for band in ("b20_26", "b26_30"):
                        v = frame["fb"][side][FB_IDS.index(band)]
                        assert 150 <= v <= 300, f"{plan.name}: clench {side} {band} {v} at {at}"


# ---------- 12-malformed: junk between the valid frames ----------


def junk_after(at: float, mk: Maker) -> list[dict]:
    """Junk lines sent 50 ms after the tick at `at`. Each says why it is junk and what the page must do with it."""
    j = JUNK.get(r3(at))
    if j is None:
        return []
    when = r3(at + 0.05)
    out = []
    for kind, payload, expect, why in j(mk):
        line: dict = {"at": when, kind: payload, "expect": expect, "why": why}
        out.append(line)
    return out


def _mi(mk: Maker, **over) -> dict:
    """A copy of the newest valid viz.mi with some fields changed (t moves to the junk line's time)."""
    m = copy.deepcopy(mk.last_mi)
    m["t"] = r3(m["t"] + 0.05)
    m.update(over)
    return m


def _fb(mk: Maker, c3=None, c4=None) -> dict:
    fb = copy.deepcopy(mk.last_mi["fb"])
    if c3 is not None:
        fb["c3"] = c3
    if c4 is not None:
        fb["c4"] = c4
    return fb


def _raw(frame: dict) -> str:
    return json.dumps(frame, separators=(",", ":"))


def _swap(text: str, old: str, new: str) -> str:
    """Replace one exact piece of a frame's text; fail loudly if it is not there."""
    assert old in text, f"junk: {old!r} not found"
    return text.replace(old, new, 1)


def _meta(mk: Maker, **over) -> dict:
    m = copy.deepcopy(mk.meta)
    m.update(over)
    return m


def _bank(n: int) -> list[dict]:
    return [{"id": f"b{i}", "lo": i, "hi": i + 1, "label": f"Band {i}"} for i in range(n)]


JUNK = {
    0.5: lambda mk: [("raw", _raw(_mi(mk))[:57], "reject", "bad JSON: the frame is cut off")],
    0.8: lambda mk: [("raw", "not json at all", "reject", "not JSON")],
    1.1: lambda mk: [
        ("raw", "[]", "reject", "an array, not an object"),
        ("raw", "42", "reject", "a number, not an object"),
        ("raw", "null", "reject", "null, not an object"),
    ],
    1.4: lambda mk: [("frame", {"type": "viz.trace", "t": r3(mk.last_mi["t"] + 0.05), "c3": [0.1, 0.2]}, "reject", "a type this page does not know")],
    1.7: lambda mk: [
        ("frame", {"type": "gesture", "id": "6f3c1e0b-3f43-4f53-9b0e-6c2a3c8f6d21", "command": "YES", "onsetAgeMs": 840, "confidence": 0.82, "source": "imagery"},
         "reject", "an 8765 gesture message on the viz channel"),
        ("frame", {"type": "health", "decoderHealthy": True}, "reject", "an 8765 health message on the viz channel"),
    ],
    2.0: lambda mk: [("frame", {"type": "viz.cmd", "cmd": "baseline"}, "reject", "a client message sent by the server")],
    2.3: lambda mk: [("raw", _swap(_raw(_mi(mk)), f'"mu":{mk.last_mi["c3"]["mu"]}', '"mu":NaN'), "reject", "NaN is not JSON")],
    2.6: lambda mk: [("raw", _swap(_raw(_mi(mk)), f'"beta":{mk.last_mi["c4"]["beta"]}', '"beta":Infinity'), "reject", "Infinity is not JSON")],
    2.9: lambda mk: [("raw", _swap(_raw(_mi(mk)), f'"laterality":{mk.last_mi["laterality"]}', '"laterality":1e999'), "reject",
                      "1e999 parses to Infinity, which is not a finite number")],
    3.2: lambda mk: [("frame", _mi(mk, c3={"mu": "NaN", "beta": 0.0}), "reject", "mu is the string NaN")],
    3.5: lambda mk: [("frame", _mi(mk, c4={"mu": None, "beta": 0.0}), "reject", "mu is null")],
    3.8: lambda mk: [("frame", _mi(mk, fb=_fb(mk, c4=mk.last_mi["fb"]["c4"][:5])), "reject", "fb c3 has 6 entries and c4 has 5")],
    4.1: lambda mk: [("frame", _mi(mk, fb=_fb(mk, c3=mk.last_mi["fb"]["c3"][:5], c4=mk.last_mi["fb"]["c4"][:5])), "fb_ignored",
                      "fb has 5 entries for a 6-band filter bank: the page drops fb and uses the rest")],
    4.4: lambda mk: [("frame", _mi(mk, fb=_fb(mk, c3=[0.0] * 13, c4=[0.0] * 13)), "reject", "fb has 13 entries, over the 12-band limit")],
    4.7: lambda mk: [("frame", _mi(mk, c3={"mu": -150.0, "beta": 0.0}), "reject", "ERD below -100 % is impossible")],
    5.0: lambda mk: [("frame", _mi(mk, fb=_fb(mk, c3=[0.0, 1500.0, 0.0, 0.0, 0.0, 0.0])), "reject", "fb entry above 1000 %")],
    5.3: lambda mk: [("frame", _mi(mk, fb=_fb(mk, c4=[0.0, -101.0, 0.0, 0.0, 0.0, 0.0])), "reject", "fb entry below -100 %")],
    5.6: lambda mk: [("frame", _mi(mk, c4={"mu": 0.0, "beta": 1001.0}), "reject", "beta above 1000 %")],
    5.9: lambda mk: [("frame", _mi(mk, emgGate="false"), "reject", "emgGate is a string, not true or false")],
    6.2: lambda mk: [("frame", {k: v for k, v in _mi(mk).items() if k != "t"}, "reject", "no t")],
    6.5: lambda mk: [("frame", {"type": "viz.spec", "t": r3(mk.last_mi["t"] + 0.05), "freqs": list(range(1, 301)), "c3": [0.0] * 300, "c4": [0.0] * 300},
                      "reject", "300 spectrum bins, over the 256 limit")],
    6.8: lambda mk: [("frame", {"type": "viz.spec", "t": r3(mk.last_mi["t"] + 0.05), "freqs": SPEC_FREQS, "c3": [0.0] * 39, "c4": [0.0] * 40},
                      "reject", "c3 has 39 bins for 40 freqs")],
    7.1: lambda mk: [("frame", {"type": "viz.quality", "t": r3(mk.last_mi["t"] + 0.05), "contact": {"C3": "good", "C4": "great"}}, "reject",
                      "contact great is not a contact value")],
    7.4: lambda mk: [("frame", {"type": "viz.quality", "t": r3(mk.last_mi["t"] + 0.05), "contact": {f"E{i}": "good" for i in range(65)}}, "reject",
                      "65 channels, over the 64 limit")],
    7.7: lambda mk: [("frame", _meta(mk, v=2), "reject", "protocol version 2")],
    8.0: lambda mk: [("frame", _meta(mk, source="demo"), "reject", "source demo is not live, replay or synthetic")],
    8.3: lambda mk: [
        ("frame", _meta(mk, filterBank=_bank(13)), "reject", "13 filter-bank bands, over the 12 limit"),
        ("frame", _meta(mk, filterBank=[{"id": "b8_12", "lo": 8, "hi": 12, "label": "Mu"}] * 2), "reject", "a filter-bank id twice"),
    ],
    8.6: lambda mk: [("frame", _meta(mk, channels=[f"E{i}" for i in range(65)]), "reject", "65 channels, over the 64 limit")],
    8.9: lambda mk: [
        ("frame", {"type": "viz.marker", "t": r3(mk.last_mi["t"] + 0.05), "id": "0d7e2c55-8f0a-4c3e-9d58-2b1f6e3a4c90", "command": "MAYBE",
                   "confidence": 0.5, "source": "imagery"}, "reject", "MAYBE is not one of the five commands"),
        ("frame", {"type": "viz.marker", "t": r3(mk.last_mi["t"] + 0.05), "id": "4b1d9a3e-2c6f-4e8a-a0b7-5f3c9d2e1a64", "command": "NO",
                   "confidence": 1.5, "source": "imagery"}, "reject", "confidence above 1"),
    ],
    9.2: lambda mk: [("frame", {**copy.deepcopy(mk.last_marker), "t": r3(mk.last_mi["t"] + 0.05)}, "reject",
                      "the same marker id again (the YES at 8.4 s): the page shows each marker once")],
    9.5: lambda mk: [("raw", _raw({"type": "viz.quality", "t": r3(mk.last_mi["t"] + 0.05), "contact": {"C3": "good", "C4": "good"}, "pad": "x" * 64100}),
                      "reject", "a frame over 64000 characters")],
    9.8: lambda mk: [("bytes", "00ff00ff7b7d", "reject", "a binary frame")],
    10.1: lambda mk: [("bytes", _raw({"type": "viz.marker", "t": r3(mk.last_mi["t"] + 0.05), "id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
                                      "command": "NO", "confidence": 0.9, "source": "imagery"}).encode().hex(), "reject",
                       "a valid NO marker sent as a binary frame: the page reads text frames only")],
    10.4: lambda mk: [("raw", "", "reject", "an empty frame")],
    10.7: lambda mk: [("raw", '{"type":"viz.mi"}', "reject", "a viz.mi with no fields")],
    11.0: lambda mk: [("raw", '"viz.meta"', "reject", "a JSON string, not an object")],
}


# ---------- the scenarios ----------

SEC = 10.0
PLANS = [
    Plan(
        name="01-rest", seed=101, seconds=SEC,
        description="Rest with a baseline set: every band near 0 on both sides, small noise.",
        screen="Synthetic test signal pill, no state line, both patches dark, strip lines on the dashed rest line.",
    ),
    Plan(
        name="02-right-fist-yes", seed=102, seconds=SEC,
        description="Right fist: C3 8-12 Hz drops to about -30 from 3 to 6 s, C4 stays near 0, then YES (imagery, 0.9 to 0.97).",
        screen="C3 patch glows cyan from about 3.5 s, C4 dark; at 5.4 s a cyan ring pulse on C3 and the pill Guess YES 0.9x.",
        imagery=[(3.0, 6.0, "c3", 1.0)],
        markers=[(5.4, "YES", "imagery")],
    ),
    Plan(
        name="03-left-fist-no", seed=103, seconds=SEC,
        description="Left fist: the mirror of 02. C4 8-12 Hz drops to about -30, C3 near 0, then NO (imagery, 0.96 to 0.99).",
        screen="C4 patch glows amber, C3 dark; at 5.4 s an amber ring pulse on C4 and the pill Guess NO 0.9x.",
        imagery=[(3.0, 6.0, "c4", 1.0)],
        markers=[(5.4, "NO", "imagery")],
    ),
    Plan(
        name="04-held-clench-stop", seed=104, seconds=SEC,
        description="Held jaw clench from 4.0 to 4.8 s: emgGate true for 9 frames, 20-30 Hz +150 to +300 on both sides; STOP at 4.8 s, while still held (jaw, PLAN D21).",
        screen="Muscle detected. Brain readings paused. for about 0.9 s with both patches dark; STOP pill in the jaw lane; no ring, no guess pill.",
        clenches=[(4.0, 9)],
        markers=[(4.8, "STOP", "jaw")],
    ),
    Plan(
        name="05-single-clench-confirm", seed=105, seconds=SEC,
        description="One jaw clench at 4.0 s: emgGate true for 3 frames, then CONFIRM (jaw, PLAN D17).",
        screen="Muscle detected. Brain readings paused. for about 0.3 s; CONFIRM pill in the jaw lane; no ring, no guess pill.",
        clenches=[(4.0, 3)],
        markers=[(4.8, "CONFIRM", "jaw")],
    ),
    Plan(
        name="06-headset-off", seed=106, seconds=SEC,
        description="Rest frames, contact poor at 4.5 s and off at 5.0 s, a HEADSET_OFF marker, then no frames at all.",
        screen="No signal 0.5 s after the last frame (5.0 s), patches dark, values cleared; the strip legend says C3 and C4 no contact.",
        contact=[(0.0, GOOD), (4.5, {"C3": "poor", "C4": "poor"}), (5.0, {"C3": "off", "C4": "off"})],
        markers=[(5.05, "HEADSET_OFF", "contact")],
        frames_until=5.0,
    ),
    Plan(
        name="07-baseline-flow", seed=107, seconds=16.0,
        description="Baseline none (0 to 2 s), recording (2 to 7 s), set at 7 s; every ERD field 0 until set; then a right fist at 11 to 14 s.",
        screen="No rest baseline with a Record link, then Recording rest baseline, then no state line; C3 glows cyan from about 11.5 s.",
        baseline=[(0.0, "none", None), (2.0, "recording", None), (7.0, "set", 7.0)],
        tag_baseline_segment=True,
        imagery=[(11.0, 14.0, "c3", 1.0)],
        markers=[(13.4, "YES", "imagery")],
    ),
    Plan(
        name="08-brain-test-failed", seed=108, seconds=SEC,
        description="meta.brainTest failed, then a right fist at 3 to 6 s with no YES (the decoder does not use imagery today).",
        screen="State line Brain test failed. YES is a jaw clench today.; the C3 glow is dimmed to about a third.",
        brain_test=("failed", "Right 11 of 20, left 9 of 20, rest 16 of 20. Below the 15 of 20 bar."),
        imagery=[(3.0, 6.0, "c3", 1.0)],
    ),
    Plan(
        name="09-replay-label", seed=109, seconds=SEC,
        description="meta.source replay with recordedAt set (a fixed time), then a left fist and NO.",
        screen="Pill Replay, recorded HH:MM (local time of 1792850400), C4 glows amber, NO pulse on C4.",
        source="replay",
        recorded_at=1792850400.0,
        note="Scripted mock labeled as a replay, to check the Replay pill. Not a recording of a person and not a measurement.",
        imagery=[(3.0, 6.0, "c4", 1.0)],
        markers=[(5.4, "NO", "imagery")],
    ),
    Plan(
        name="10-bad-contact", seed=110, seconds=12.0,
        description="Rest; viz.quality C4 poor from 2 to 7 s, then off to the end; C4 power rises (noise), C3 stays normal.",
        screen="Strip legend C4 poor contact, then C4 no contact; C4 rows climb above the rest line, C4 patch stays dark.",
        contact=[(0.0, GOOD), (2.0, {"C3": "good", "C4": "poor"}), (7.0, {"C3": "good", "C4": "off"})],
        c4_extra=[(2.0, 7.0, 0.05, 0.4), (7.0, 12.0, 1.5, 4.0)],
    ),
    Plan(
        name="11-legacy-bridge", seed=111, seconds=SEC,
        description="An older bridge: no filterBank, no fb, bands 8-13 and 13-30; a right fist at 3 to 6 s and YES.",
        screen="Strip shows two rows (Mu 8-13 Hz, Beta 13-30 Hz); C3 glows cyan from mu; YES pulse on C3.",
        filter_bank=False,
        imagery=[(3.0, 6.0, "c3", 1.0)],
        markers=[(5.4, "YES", "imagery")],
    ),
    Plan(
        name="12-malformed", seed=112, seconds=12.0,
        description="Valid frames with 41 bad lines between them (bad JSON, unknown types, NaN, bad fb, out-of-range ERD, oversized, binary): 40 dropped, 1 used without its fb; a right fist at 6 to 9 s and YES.",
        screen="Looks like 02 shifted to 6 s: the junk changes nothing, C3 glows cyan, one YES pulse, no MAYBE or extra NO anywhere.",
        imagery=[(6.0, 9.0, "c3", 1.0)],
        markers=[(8.4, "YES", "imagery")],
        junk=True,
    ),
    Plan(
        name="13-key-press", seed=113, seconds=SEC,
        description="Rest; YES at 2.5 s and NO at 6.0 s from source key (keyboard test), confidence null.",
        screen="Neutral (gray) guess pill YES, key press then NO, key press; no ring pulse; patches dark.",
        markers=[(2.5, "YES", "key"), (6.0, "NO", "key")],
    ),
    Plan(
        name="20-demo-run", seed=120, seconds=60.0,
        description="About 60 s labeled replay: rest, right fist YES, rest, left fist NO, rest, held clench STOP, rest, single clench CONFIRM (PLAN D17, D21).",
        screen="Pill Replay; cyan glow and YES at about 10 s, amber glow and NO at about 22 s, muscle line from 33 s and STOP at 33.8 s, CONFIRM at 45.8 s.",
        source="replay",
        recorded_at=None,
        note="Scripted demo run labeled as a replay. Nothing was recorded from a person. Not a measurement.",
        imagery=[(8.0, 11.0, "c3", 1.04), (20.0, 23.0, "c4", 0.97)],
        clenches=[(33.0, 9), (45.0, 3)],
        markers=[(10.4, "YES", "imagery"), (22.4, "NO", "imagery"), (33.8, "STOP", "jaw"), (45.8, "CONFIRM", "jaw")],
    ),
    Plan(
        name="90-live-label-test", seed=190, seconds=8.0,
        description="TEST FIXTURE ONLY, labeled live: for the automated test of the Live headset pill. viz_replay.py refuses it without --allow-live-label.",
        screen="Pill Live headset. Never play this in front of anyone: it is scripted, not the headset.",
        source="live",
        note="Test fixture only: labeled live to check the Live headset pill. Scripted, not a measurement.",
    ),
]


def render(plan: Plan) -> str:
    lines = Maker(plan).make()
    return "".join(json.dumps(line, separators=(",", ":"), allow_nan=False) + "\n" for line in lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Make the scripted Screen 1 scenarios in tools/mock-viz/.")
    ap.add_argument("--check", action="store_true", help="do not write; exit 1 if a file differs from what this makes")
    args = ap.parse_args(argv)
    names = [p.name for p in PLANS]
    assert len(set(names)) == len(names), "duplicate scenario name"
    differ = []
    for plan in PLANS:
        text = render(plan)
        path = HERE / f"{plan.name}.jsonl"
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                differ.append(path.name)
            continue
        path.write_text(text, encoding="utf-8")
        print(f"wrote {path.name}: {text.count(chr(10))} lines, {len(text.encode()) // 1024} KiB")
    extra = sorted(p.name for p in HERE.glob("*.jsonl") if p.stem not in names)
    if extra:
        print(f"note: files this script does not make: {', '.join(extra)}")
    if args.check:
        if differ:
            print(f"out of date: {', '.join(differ)}. Run tools/mock-viz/make_scenarios.py")
            return 1
        print(f"all {len(PLANS)} scenario files match.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
