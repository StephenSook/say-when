#!/usr/bin/env python3
"""Check a running viz bridge against the port 8766 protocol (tools/VIZ_PROTOCOL.md).

Connects to ws://127.0.0.1:<port>, collects messages for N seconds, validates
every message's shape, sends one {"type":"viz.cmd","cmd":"baseline"}, then
prints counts and measured rates per type. It also checks the optional filter
bank (viz.meta filterBank, viz.mi fb), which the synthetic tool must send.
With --expect-source synthetic it prints each band's mean ERD in the scripted
windows, and fails if mu (8 to 12 Hz) or the jaw clench rise is far off.

Exit codes: 0 all good, 1 protocol violations, 2 could not connect.

  python tools/check_viz_bridge.py                 # 6 s against port 8766
  python tools/check_viz_bridge.py --seconds 8
  python tools/check_viz_bridge.py --expect-source live   # the real decoder bridge
  python tools/check_viz_bridge.py --seconds 30           # a full scripted cycle
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import statistics
import sys
import time
import uuid

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

KEYS = {
    "viz.meta": {"type", "v", "source", "board", "srate", "channels", "units", "traceFilter",
                 "bands", "baseline", "recordedAt", "brainTest", "note"},
    "viz.mi": {"type", "t", "c3", "c4", "laterality", "emgGate", "baselineAgeS", "emg", "emgThreshold"},
    "viz.spec": {"type", "t", "freqs", "c3", "c4"},
    "viz.quality": {"type", "t", "contact"},
    "viz.marker": {"type", "t", "id", "command", "confidence", "source"},
}
# Optional keys: an older bridge may leave them out. The synthetic tool always sends them.
OPTIONAL_KEYS = {"viz.meta": {"filterBank"}, "viz.mi": {"fb"}}
EXPECTED_HZ = {"viz.mi": 10.0, "viz.spec": 10.0, "viz.quality": 2.0}
CONTACT_VALUES = {"good", "fair", "poor", "off"}
# Direct select (D18) words and the scan (D11 + D17) words: both decoder maps (eeg-data live.py --mode).
COMMANDS = {"PICK_1", "PICK_2", "PICK_3", "YES", "NO", "CONFIRM", "STOP", "HEADSET_OFF"}
FIST_COMMANDS = {"PICK_1", "PICK_2", "YES", "NO"}  # imagery, or the jaw in the jaw-only fallback
JAW_COMMANDS = {"PICK_3", "CONFIRM", "STOP"}  # always the jaw
SOURCE_RE = re.compile(r"^[a-z_]{1,16}$")
SPEC_FREQS = list(range(1, 41))
ERD_MIN, ERD_MAX = -100.0, 1000.0
MAX_BANDS = 12
BAND_ID_RE = re.compile(r"^[a-z0-9_]{1,16}$")
MAX_BAND_LABEL = 24
SYNTHETIC_BANDS = {"alpha_mu": [8, 12], "beta": [12, 30]}
SYNTHETIC_FILTER_BANK = [
    {"id": "mrcp", "lo": 0.05, "hi": 5, "label": "Slow potential 0.05-5 Hz"},
    {"id": "b8_12", "lo": 8, "hi": 12, "label": "Mu 8-12 Hz"},
    {"id": "b12_16", "lo": 12, "hi": 16, "label": "Low beta 12-16 Hz"},
    {"id": "b16_20", "lo": 16, "hi": 20, "label": "Beta 16-20 Hz"},
    {"id": "b20_26", "lo": 20, "hi": 26, "label": "Beta 20-26 Hz"},
    {"id": "b26_30", "lo": 26, "hi": 30, "label": "High beta 26-30 Hz"},
]
SYNTHETIC_BETA_IDS = ("b12_16", "b16_20", "b20_26", "b26_30")  # synthetic beta is their mean
# Scripted windows (seconds into the synthetic cycle, the plateaus only) for the summary.
SCRIPT_WINDOWS = {"rest": (0.5, 3.5), "right fist": (4.7, 6.3), "left fist": (11.7, 13.3)}
CYCLE_S = 24.0


def is_num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


class Checker:
    def __init__(self, expect_source: str) -> None:
        self.expect_source = expect_source
        self.violations: list[str] = []
        self.arrivals: dict[str, list[float]] = {k: [] for k in KEYS}
        self.baseline_state: str | None = None
        self.baseline_states: list[tuple[float, str]] = []
        self.marker_ids: set[str] = set()
        self.markers: list[tuple[float, str, object, str]] = []
        self.mi_stats: dict[str, list[float]] = {"c3.mu": [], "c3.beta": [], "c4.mu": [], "c4.beta": [],
                                                 "laterality": [], "emg": []}
        self.gate_frames = 0
        self.contact_seen: set[tuple[str, str]] = set()
        self.channels = ["C3", "C4"]
        self.count = 0
        self.synthetic = expect_source == "synthetic"
        self.filter_bank: list[dict] | None = None  # from the newest viz.meta
        self.fb_frames: list[tuple[float, bool, dict]] = []  # (rel, emgGate, fb) with a baseline set
        self.fb_seen = 0

    def bad(self, rel: float, what: str) -> None:
        self.violations.append(f"t+{rel:5.2f}s {what}")

    def check_t(self, rel: float, kind: str, t) -> None:
        if not is_num(t):
            self.bad(rel, f"{kind}: t is not a number: {t!r}")
        elif abs(t - time.time()) > 5.0:
            self.bad(rel, f"{kind}: t={t} is more than 5 s from this clock (want unix seconds)")

    def feed(self, rel: float, frame) -> None:
        self.count += 1
        if not isinstance(frame, str):
            self.bad(rel, "binary frame (protocol is JSON text frames only)")
            return
        try:
            msg = json.loads(frame)
        except ValueError as exc:
            self.bad(rel, f"invalid JSON: {exc}")
            return
        if not isinstance(msg, dict):
            self.bad(rel, "frame is not a JSON object")
            return
        kind = msg.get("type")
        if self.count == 1 and kind != "viz.meta":
            self.bad(rel, f"first message is {kind!r}, want viz.meta")
        if kind not in KEYS:
            self.bad(rel, f"unknown type {kind!r}")
            return
        self.arrivals[kind].append(rel)
        keys = set(msg)
        allowed = KEYS[kind] | OPTIONAL_KEYS.get(kind, set())
        if not KEYS[kind] <= keys <= allowed:
            self.bad(rel, f"{kind}: keys missing {sorted(KEYS[kind] - keys)} extra {sorted(keys - allowed)}")
            return
        if self.synthetic and not OPTIONAL_KEYS.get(kind, set()) <= keys:
            self.bad(rel, f"{kind}: the synthetic tool must send {sorted(OPTIONAL_KEYS[kind] - keys)}")
            return
        getattr(self, "check_" + kind.split(".")[1])(rel, msg)

    def check_meta(self, rel: float, m: dict) -> None:
        if m["v"] != 1:
            self.bad(rel, f"meta: v={m['v']!r}, want 1")
        if m["source"] != self.expect_source:
            self.bad(rel, f"meta: source={m['source']!r}, want {self.expect_source!r}")
        if not isinstance(m["board"], str) or not m["board"]:
            self.bad(rel, "meta: board must be a non-empty string")
        if not isinstance(m["srate"], int) or isinstance(m["srate"], bool) or m["srate"] <= 0:
            self.bad(rel, f"meta: srate={m['srate']!r}, want a positive integer")
        if m["channels"] != ["C3", "C4"]:
            self.bad(rel, f"meta: channels={m['channels']!r}, want ['C3', 'C4']")
        else:
            self.channels = m["channels"]
        if m["units"] != "uV":
            self.bad(rel, f"meta: units={m['units']!r}, want 'uV'")
        if not isinstance(m["traceFilter"], str):
            self.bad(rel, "meta: traceFilter must be a string")
        bands = m["bands"]
        if self.synthetic:
            if bands != SYNTHETIC_BANDS:
                self.bad(rel, f"meta: bands={bands!r}, want {SYNTHETIC_BANDS!r}")
        elif not (isinstance(bands, dict) and set(bands) == {"alpha_mu", "beta"} and all(
                isinstance(r, list) and len(r) == 2 and all(is_num(x) for x in r) and 0 <= r[0] < r[1]
                for r in bands.values())):
            self.bad(rel, f"meta: bands={bands!r}, want {{alpha_mu: [lo, hi], beta: [lo, hi]}}")
        self.filter_bank = self.check_filter_bank(rel, m.get("filterBank"))
        b = m["baseline"]
        if not isinstance(b, dict) or set(b) != {"state", "recordedAt"}:
            self.bad(rel, f"meta: baseline must be {{state, recordedAt}}, got {b!r}")
        else:
            if b["state"] not in ("none", "recording", "set"):
                self.bad(rel, f"meta: baseline.state={b['state']!r}")
            if b["state"] == "set":
                if not is_num(b["recordedAt"]) or abs(b["recordedAt"] - time.time()) > 86400 * 7:
                    self.bad(rel, f"meta: baseline set but recordedAt={b['recordedAt']!r}")
            elif b["recordedAt"] is not None:
                self.bad(rel, f"meta: baseline {b['state']} but recordedAt={b['recordedAt']!r}, want null")
            self.baseline_state = b["state"]
            self.baseline_states.append((rel, b["state"]))
        if m["recordedAt"] is not None and not is_num(m["recordedAt"]):
            self.bad(rel, f"meta: recordedAt={m['recordedAt']!r}, want null or unix seconds")
        bt = m["brainTest"]
        if not isinstance(bt, dict) or set(bt) != {"state", "summary"} or not isinstance(bt.get("state"), str):
            self.bad(rel, f"meta: brainTest must be {{state, summary}}, got {bt!r}")
        if not isinstance(m["note"], str) or not m["note"]:
            self.bad(rel, "meta: note must be a non-empty string")

    def check_filter_bank(self, rel: float, fbank) -> list[dict] | None:
        """Validate meta.filterBank (absent or null is fine). Returns the bands, or None."""
        if fbank is None:
            return None
        if not isinstance(fbank, list) or not 1 <= len(fbank) <= MAX_BANDS:
            self.bad(rel, f"meta: filterBank must be a list of 1 to {MAX_BANDS} bands, got {fbank!r}")
            return None
        ids: set[str] = set()
        for band in fbank:
            if not isinstance(band, dict) or set(band) != {"id", "lo", "hi", "label"}:
                self.bad(rel, f"meta: filterBank entry must be {{id, lo, hi, label}}, got {band!r}")
                return None
            bid, lo, hi, label = band["id"], band["lo"], band["hi"], band["label"]
            if not isinstance(bid, str) or not BAND_ID_RE.match(bid) or bid in ids:
                self.bad(rel, f"meta: filterBank id={bid!r}, want a unique id matching {BAND_ID_RE.pattern}")
                return None
            ids.add(bid)
            if not (is_num(lo) and is_num(hi) and 0 <= lo < hi <= 200):
                self.bad(rel, f"meta: filterBank {bid}: lo={lo!r} hi={hi!r}, want 0 <= lo < hi <= 200 Hz")
                return None
            if not isinstance(label, str) or len(label) > MAX_BAND_LABEL:
                self.bad(rel, f"meta: filterBank {bid}: label={label!r}, want a string up to {MAX_BAND_LABEL} chars")
                return None
        if self.synthetic and fbank != SYNTHETIC_FILTER_BANK:
            self.bad(rel, f"meta: filterBank={fbank!r}, want the six synthetic bands")
            return None
        return fbank

    def check_fb(self, rel: float, m: dict, vals: dict[str, float]) -> None:
        """Validate viz.mi fb against the newest filterBank and the older mu and beta fields."""
        fb = m.get("fb")
        if fb is None:
            return
        self.fb_seen += 1
        bands = self.filter_bank
        if bands is None:
            self.bad(rel, "mi: fb sent but the newest viz.meta has no filterBank")
            return
        if not isinstance(fb, dict) or set(fb) != {"c3", "c4"}:
            self.bad(rel, f"mi: fb must be {{c3, c4}}, got {fb!r}")
            return
        for ch in ("c3", "c4"):
            row = fb[ch]
            if not isinstance(row, list) or len(row) != len(bands):
                self.bad(rel, f"mi: fb.{ch} must have one entry per filterBank band ({len(bands)}), got {row!r}")
                return
            for band, v in zip(bands, row):
                if v is not None and (not is_num(v) or not ERD_MIN <= v <= ERD_MAX):
                    self.bad(rel, f"mi: fb.{ch} {band['id']}={v!r}, want null or ERD % from -100 to 1000")
                    return
                if self.baseline_state is not None and self.baseline_state != "set" and v not in (None, 0):
                    self.bad(rel, f"mi: baseline is {self.baseline_state} but fb.{ch} {band['id']}={v}, want 0")
                    return
        if not self.synthetic:
            return
        ids = [band["id"] for band in bands]
        for ch in ("c3", "c4"):
            row = dict(zip(ids, fb[ch]))
            if row["b8_12"] is None or abs(vals[f"{ch}.mu"] - row["b8_12"]) > 0.051:
                self.bad(rel, f"mi: {ch}.mu={vals[f'{ch}.mu']} but fb {ch} b8_12={row['b8_12']}; they must agree")
            beta = [row[i] for i in SYNTHETIC_BETA_IDS]
            if None in beta or abs(vals[f"{ch}.beta"] - sum(beta) / len(beta)) > 0.051:
                self.bad(rel, f"mi: {ch}.beta={vals[f'{ch}.beta']} is not the mean of fb {ch} 12 to 30 Hz {beta}")
        if self.baseline_state == "set":
            self.fb_frames.append((rel, m["emgGate"] is True, fb))

    def check_mi(self, rel: float, m: dict) -> None:
        self.check_t(rel, "mi", m["t"])
        vals = {}
        for ch in ("c3", "c4"):
            d = m[ch]
            if not isinstance(d, dict) or set(d) != {"mu", "beta"}:
                self.bad(rel, f"mi: {ch} must be {{mu, beta}}, got {d!r}")
                return
            for band in ("mu", "beta"):
                v = d[band]
                if not is_num(v) or not ERD_MIN <= v <= ERD_MAX:
                    self.bad(rel, f"mi: {ch}.{band}={v!r}, want a number from -100 to 1000 (ERD %)")
                    return
                vals[f"{ch}.{band}"] = float(v)
        if not is_num(m["laterality"]):
            self.bad(rel, f"mi: laterality={m['laterality']!r}")
        elif abs(m["laterality"] - (vals["c4.mu"] - vals["c3.mu"])) > 0.11:
            self.bad(rel, f"mi: laterality {m['laterality']} != c4.mu - c3.mu = {vals['c4.mu'] - vals['c3.mu']:.2f}")
        if not is_num(m["emg"]) or m["emg"] < 0:
            self.bad(rel, f"mi: emg={m['emg']!r}, want uV RMS >= 0")
            return
        if not is_num(m["emgThreshold"]) or m["emgThreshold"] <= 0:
            self.bad(rel, f"mi: emgThreshold={m['emgThreshold']!r}")
            return
        if not isinstance(m["emgGate"], bool):
            self.bad(rel, f"mi: emgGate={m['emgGate']!r}, want true or false")
        elif m["emgGate"] != (m["emg"] > m["emgThreshold"]):
            self.bad(rel, f"mi: emgGate={m['emgGate']} but emg={m['emg']} threshold={m['emgThreshold']}")
        age = m["baselineAgeS"]
        if age is not None and (not is_num(age) or age < 0):
            self.bad(rel, f"mi: baselineAgeS={age!r}, want null or seconds >= 0")
        if self.baseline_state is not None and self.baseline_state != "set":
            if age is not None or any(v != 0.0 for v in vals.values()):
                self.bad(rel, f"mi: baseline is {self.baseline_state} but ERD or baselineAgeS is not zero/null")
        elif self.baseline_state == "set":
            if age is None:
                self.bad(rel, "mi: baseline is set but baselineAgeS is null")
            for k, v in vals.items():
                self.mi_stats[k].append(v)
            self.mi_stats["laterality"].append(float(m["laterality"]))
        self.mi_stats["emg"].append(float(m["emg"]))
        if m["emgGate"] is True:
            self.gate_frames += 1
        self.check_fb(rel, m, vals)

    def check_spec(self, rel: float, m: dict) -> None:
        self.check_t(rel, "spec", m["t"])
        if m["freqs"] != SPEC_FREQS:
            self.bad(rel, "spec: freqs must be [1, 2, ..., 40]")
        for ch in ("c3", "c4"):
            v = m[ch]
            if not isinstance(v, list) or len(v) != len(SPEC_FREQS) or not all(is_num(x) for x in v):
                self.bad(rel, f"spec: {ch} must be {len(SPEC_FREQS)} finite numbers (log10 uV^2/Hz)")

    def check_quality(self, rel: float, m: dict) -> None:
        self.check_t(rel, "quality", m["t"])
        c = m["contact"]
        if not isinstance(c, dict) or set(c) != set(self.channels):
            self.bad(rel, f"quality: contact keys must be {self.channels}, got {c!r}")
            return
        for ch, v in c.items():
            if v not in CONTACT_VALUES:
                self.bad(rel, f"quality: contact.{ch}={v!r}, want one of {sorted(CONTACT_VALUES)}")
            self.contact_seen.add((ch, v))

    def check_marker(self, rel: float, m: dict) -> None:
        self.check_t(rel, "marker", m["t"])
        mid = m["id"]
        try:
            ok = isinstance(mid, str) and uuid.UUID(mid).version == 4
        except ValueError:
            ok = False
        if not ok:
            self.bad(rel, f"marker: id={mid!r}, want a uuid4 string")
        elif mid in self.marker_ids:
            self.bad(rel, f"marker: repeated id {mid}")
        else:
            self.marker_ids.add(mid)
        cmd, conf, src = m["command"], m["confidence"], m["source"]
        if cmd not in COMMANDS:
            self.bad(rel, f"marker: command={cmd!r}")
            return
        if cmd in FIST_COMMANDS and src == "jaw":  # the jaw-only fallback: no model confidence
            if conf is not None:
                self.bad(rel, f"marker: {cmd} from the jaw, confidence={conf!r}, want null")
        elif cmd in FIST_COMMANDS:
            if src != "imagery":
                self.bad(rel, f"marker: {cmd} source={src!r}, want 'imagery'")
            if not is_num(conf) or not 0.0 <= conf <= 1.0:
                self.bad(rel, f"marker: {cmd} confidence={conf!r}, want 0 to 1")
        elif cmd in JAW_COMMANDS:
            if src != "jaw":
                self.bad(rel, f"marker: {cmd} source={src!r}, want 'jaw'")
            if conf is not None:
                self.bad(rel, f"marker: {cmd} confidence={conf!r}, want null")
        else:  # HEADSET_OFF
            if not isinstance(src, str) or not SOURCE_RE.match(src):
                self.bad(rel, f"marker: HEADSET_OFF source={src!r}")
            if conf is not None and (not is_num(conf) or not 0.0 <= conf <= 1.0):
                self.bad(rel, f"marker: HEADSET_OFF confidence={conf!r}")
        self.markers.append((rel, cmd, conf, src))


async def run(port: int, seconds: float, baseline_at: float, expect_source: str) -> int:
    url = f"ws://127.0.0.1:{port}"
    chk = Checker(expect_source)
    try:
        ws = await connect(url, proxy=None, open_timeout=3, max_size=2**20)
    except (OSError, asyncio.TimeoutError) as exc:
        print(f"FAIL: cannot connect to {url}: {exc}")
        return 2
    t0 = time.monotonic()
    cmd_sent_at: float | None = None
    closed_early = None
    async with ws:
        deadline = t0 + seconds
        while True:
            now = time.monotonic()
            if cmd_sent_at is None and now - t0 >= baseline_at:
                await ws.send(json.dumps({"type": "viz.cmd", "cmd": "baseline"}))
                cmd_sent_at = now - t0
            left = deadline - now
            if left <= 0:
                break
            wait = left if cmd_sent_at is not None else min(left, t0 + baseline_at - now)
            try:
                frame = await asyncio.wait_for(ws.recv(), timeout=max(wait, 0.001))
            except asyncio.TimeoutError:
                continue
            except ConnectionClosed as exc:
                closed_early = f"connection closed after {time.monotonic() - t0:.2f} s: {exc}"
                break
            chk.feed(time.monotonic() - t0, frame)
    elapsed = time.monotonic() - t0

    if closed_early:
        chk.violations.append(closed_early)
    if chk.count == 0:
        chk.violations.append("no messages received")

    # The baseline command must start a recording promptly.
    if cmd_sent_at is not None:
        rec = [r for r, s in chk.baseline_states if s == "recording" and r >= cmd_sent_at]
        if not rec or rec[0] - cmd_sent_at > 1.5:
            chk.violations.append(f"no viz.meta baseline 'recording' within 1.5 s of viz.cmd baseline (sent t+{cmd_sent_at:.2f}s)")

    print(f"{url}: {chk.count} messages in {elapsed:.1f} s")
    print(f"{'type':<12} {'count':>5} {'rate Hz':>8} {'median gap ms':>14}  expected")
    for kind, times in chk.arrivals.items():
        n = len(times)
        rate = (n - 1) / (times[-1] - times[0]) if n >= 2 and times[-1] > times[0] else float("nan")
        gap = statistics.median(b - a for a, b in zip(times, times[1:])) * 1000 if n >= 3 else float("nan")
        exp = EXPECTED_HZ.get(kind)
        print(f"{kind:<12} {n:>5} {rate:>8.2f} {gap:>14.1f}  {f'{exp:g} Hz' if exp else 'on change / on event'}")
        if exp and elapsed >= 3.0:
            if n < 2:
                chk.violations.append(f"{kind}: only {n} received, want about {exp:g} Hz")
            elif not 0.8 * exp <= rate <= 1.2 * exp:
                chk.violations.append(f"{kind}: measured {rate:.2f} Hz, want {exp:g} Hz +/- 20 %")

    states = " -> ".join(f"{s}@{r:.1f}s" for r, s in chk.baseline_states)
    print(f"baseline states: {states or 'none seen'}")
    if cmd_sent_at is not None:
        rec = [r for r, s in chk.baseline_states if s == "recording" and r >= cmd_sent_at]
        later_set = [r for r, s in chk.baseline_states if s == "set" and rec and r > rec[0]]
        print(f"viz.cmd baseline sent at t+{cmd_sent_at:.2f}s; recording at "
              f"{f't+{rec[0]:.2f}s' if rec else 'never'}; set at "
              f"{f't+{later_set[0]:.2f}s' if later_set else 'not within this run (run longer than the baseline)'}")
    for k, v in chk.mi_stats.items():
        if v:
            print(f"  {k:<11} min {min(v):7.1f}  max {max(v):7.1f}  ({len(v)} frames with a baseline set)"
                  if k != "emg" else f"  {k:<11} min {min(v):7.1f}  max {max(v):7.1f}  emgGate true in {chk.gate_frames} frames")
    if chk.markers:
        print("markers: " + ", ".join(f"{c}({s}, {cf})@{r:.1f}s" for r, c, cf, s in chk.markers))
    if chk.contact_seen:
        print("contact values seen: " + ", ".join(f"{c}={v}" for c, v in sorted(chk.contact_seen)))
    if chk.filter_bank is not None:
        print(f"filterBank: {', '.join(b['id'] for b in chk.filter_bank)}; fb in {chk.fb_seen} of "
              f"{len(chk.arrivals['viz.mi'])} viz.mi frames")
    if chk.synthetic and chk.filter_bank is not None:
        script_summary(chk)

    if chk.violations:
        print(f"FAIL: {len(chk.violations)} protocol violation(s):")
        for v in chk.violations[:30]:
            print("  " + v)
        if len(chk.violations) > 30:
            print(f"  ... and {len(chk.violations) - 30} more")
        return 1
    print("PASS: every message matched the protocol.")
    return 0


def script_summary(chk: Checker) -> None:
    """Synthetic only: each band's mean ERD in the scripted windows, after this run's own baseline."""
    states = chk.baseline_states
    sets = [r for i, (r, s) in enumerate(states) if s == "set" and any(s2 == "recording" for _, s2 in states[:i])]
    if not sets:
        print("scripted windows: no baseline was set during this run (run at least --seconds 12)")
        return
    s0 = sets[-1]  # the cycle restarts when the baseline is set
    ids = [b["id"] for b in chk.filter_bank]
    groups: dict[str, list[dict]] = {name: [] for name in [*SCRIPT_WINDOWS, "jaw clench"]}
    for rel, gate, fb in chk.fb_frames:
        if rel <= s0:
            continue
        if gate:
            groups["jaw clench"].append(fb)
            continue
        pos = (rel - s0) % CYCLE_S
        for name, (lo, hi) in SCRIPT_WINDOWS.items():
            if lo <= pos <= hi:
                groups[name].append(fb)

    def mean(frames: list[dict], ch: str, band: int) -> float | None:
        v = [f[ch][band] for f in frames if f[ch][band] is not None]
        return sum(v) / len(v) if v else None

    def cell(x: float | None) -> str:
        return f"{x:+7.1f}" if x is not None else "      -"

    print(f"scripted windows, mean ERD % (baseline set at t+{s0:.1f}s; C3 then C4; frames per window: "
          + ", ".join(f"{k} {len(v)}" for k, v in groups.items()) + ")")
    print(f"  {'band':<8}" + "".join(f"{name:>17}" for name in groups))
    for i, bid in enumerate(ids):
        print(f"  {bid:<8}" + "".join(f"  {cell(mean(g, 'c3', i))} {cell(mean(g, 'c4', i))}" for g in groups.values()))
    # Loose checks on the bands that matter most, so a broken script fails the run.
    mu = ids.index("b8_12")
    for name, contra, ipsi in (("right fist", "c3", "c4"), ("left fist", "c4", "c3")):
        g = groups[name]
        if len(g) >= 5:
            c, o = mean(g, contra, mu), mean(g, ipsi, mu)
            if c is None or not -40.0 <= c <= -20.0:
                chk.violations.append(f"synthetic {name}: {contra} b8_12 mean {c}, want about -30 (-40 to -20)")
            if o is None or not -10.0 <= o <= 10.0:
                chk.violations.append(f"synthetic {name}: {ipsi} b8_12 mean {o}, want near 0 (-10 to +10)")
    if groups["jaw clench"]:
        for bid in ("b20_26", "b26_30"):
            for ch in ("c3", "c4"):
                x = mean(groups["jaw clench"], ch, ids.index(bid))
                if x is None or x < 75.0:
                    chk.violations.append(f"synthetic jaw clench: {ch} {bid} mean {x}, want a sharp rise (+150 to +300)")


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate a viz bridge on ws://127.0.0.1:<port>.")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--seconds", type=float, default=6.0, help="how long to listen (default 6)")
    ap.add_argument("--baseline-at", type=float, default=1.0, help="when to send viz.cmd baseline (s)")
    ap.add_argument("--expect-source", default="synthetic", choices=["live", "replay", "synthetic"], help="meta.source to require (default synthetic)")
    args = ap.parse_args()
    try:
        return asyncio.run(run(args.port, args.seconds, args.baseline_at, args.expect_source))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
