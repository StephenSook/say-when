#!/usr/bin/env python3
"""Synthetic viz bridge for Screen 1 (the live brain view).

SYNTHETIC TEST SIGNAL. Nothing this tool sends is a measurement.

It streams the port 8766 viz protocol (tools/VIZ_PROTOCOL.md) from BrainFlow's
SYNTHETIC_BOARD plus a scripted imagery and jaw cycle, so the browser page can
be built and tested without a headset. It sends the decoder's filter bank
(viz.meta filterBank, viz.mi fb): one ERD value per band per side.

Rules this tool keeps:
- Listens on 127.0.0.1 only. It refuses any other host, and refuses port 8765
  (the station gesture and health channel, which this tool never touches).
- Reads the board only with get_current_board_data(), which does not remove
  samples. It never calls get_board_data(). In the real setup only the decoder
  makes that one destructive read.
- Every viz.meta says "source": "synthetic", so the page shows its
  SYNTHETIC TEST SIGNAL badge.

Run (from the repo root, with the venv from tools/requirements-viz.txt):
  python tools/viz_bridge_synthetic.py
  python tools/viz_bridge_synthetic.py --port 8766 --baseline-seconds 5
  python tools/viz_bridge_synthetic.py --no-script --no-contact-blips
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import random
import signal
import sys
import time
import uuid

import numpy as np
from brainflow.board_shim import BoardIds, BoardShim, BrainFlowError, BrainFlowInputParams
from scipy.signal import welch
from websockets.asyncio.server import ServerConnection, broadcast, serve
from websockets.exceptions import ConnectionClosed

HOST = "127.0.0.1"  # loopback only, never 0.0.0.0
DEFAULT_PORT = 8766
GESTURE_PORT = 8765  # the station gesture and health channel; not ours

TICK_S = 0.1  # viz.mi and viz.spec at 10 Hz
QUALITY_EVERY_TICKS = 5  # viz.quality at 2 Hz
STATUS_EVERY_S = 10.0
BOARD_BUFFER_S = 10  # BrainFlow ring size; it wraps, we only ever peek at it
# Light smoothing of the raw band power (time constant about 0.3 s). The
# synthetic board has only a faint white-noise floor in some bands, so
# unsmoothed 1 s estimates jump around by 10 % or more from tick to tick.
# The scripted suppression is applied after this, so its ramps stay crisp.
BP_SMOOTHING = 0.3

CHANNELS = ("C3", "C4")
# The decoder's filter bank (Shashank's model), in display order: (id, lo Hz, hi Hz, label).
# Each band takes the bins from lo up to but not including hi.
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
SLOW_FB = FB_IDS.index("mrcp")
MU_FB = FB_IDS.index("b8_12")  # viz.mi c3.mu and c4.mu repeat this band
BETA_FB = tuple(FB_IDS.index(i) for i in ("b12_16", "b16_20", "b20_26", "b26_30"))  # beta is their mean
MU_BAND = (8, 12)  # Hz, what c3.mu and c4.mu now mean (the b8_12 band)
BETA_BAND = (12, 30)  # Hz, what beta now means (the mean of the four bands from 12 to 30 Hz)
SLOW_WINDOW_S = 2  # the slow band uses the last 2 s, 0.5 Hz bins 0.5 to 4.5 Hz
# The synthetic board has almost no energy in some bands (C3 above 16 Hz, C4 below 5 Hz), so the
# 1 s estimates there jump by 20 to 40 % from tick to tick and would bury the scripted changes.
# A steady synthetic background of BACKGROUND_PSD / f uV^2/Hz is added to every band's power
# before the baseline and ERD math. viz.spec does not include it.
BACKGROUND_PSD = 2.0
BACKGROUND = np.array([BACKGROUND_PSD * np.log(hi / lo) for _, lo, hi, _ in FILTER_BANK])
ERD_MIN, ERD_MAX = -100.0, 1000.0  # the page rejects values outside this range
SPEC_FREQS = list(range(1, 41))  # 1 Hz bins, 1..40 Hz
EMG_THRESHOLD = 40.0  # uV RMS

WRITE_LIMIT = 32 * 1024  # bytes; a client above this misses stream frames
MAX_INCOMING = 4096  # bytes; client messages are tiny

# Scripted cycle, seconds from the start of the cycle.
CYCLE_S = 24.0
RAMP_S = 0.5  # rise and fall of the imagery suppression
IMAGERY = ((4.0, 7.0, 0), (11.0, 14.0, 1))  # (start, end, contralateral channel index)
CLENCHES = ((18.0, 1.0), (21.8, 0.3))  # (onset, length): held (STOP, PLAN D21), then single
CLENCH_EDGE_S = 0.04
MARKERS = (
    (6.4, "YES", "imagery"),
    (13.4, "NO", "imagery"),
    (18.8, "STOP", "jaw"),  # the held clench, 0.8 s in, while still held (PLAN D21)
    (22.3, "CONFIRM", "jaw"),  # the single clench
)
CONTACT_BLIP = (15.0, 17.0)  # C4 reads "poor" in this window
# Scripted change in band power on the side opposite the imagined hand, at full imagery,
# as a fraction: negative is a drop (desynchronization), positive a rise. The slow
# potential (movement-related cortical potential) rises. Scaled by 0.9 to 1.1 per cycle.
IMAGERY_CHANGE = {"mrcp": 0.25, "b8_12": -0.30, "b12_16": -0.24, "b16_20": -0.16, "b20_26": -0.11, "b26_30": -0.07}
IPSI_FRACTION = 0.1  # the same side as the hand moves by a tenth of that, so it stays near 0
# A jaw clench is muscle, not brain: it raises the upper bands on both sides at once.
# (low, high) rise as a fraction, rolled per clench per cycle, times 0.9 to 1.1 per side.
CLENCH_RISE = {"b16_20": (0.25, 0.45), "b20_26": (1.5, 2.5), "b26_30": (2.0, 3.0)}

NOTE_SCRIPTED = "Scripted imagery cycle for UI testing. Not a measurement."
NOTE_RAW = "Raw synthetic board noise for UI testing, no scripted cycle. Not a measurement."


def smoothstep(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3.0 - 2.0 * x)


def imagery_envelope(pos: float, start: float, end: float) -> float:
    """0 outside the window, smooth 0.5 s rise and fall, 1 in the middle."""
    if pos <= start or pos >= end:
        return 0.0
    return min(smoothstep((pos - start) / RAMP_S), smoothstep((end - pos) / RAMP_S))


def clench_shape(pos: float, onset: float, length: float) -> float:
    if pos < onset or pos > onset + length:
        return 0.0
    return min(1.0, (pos - onset) / CLENCH_EDGE_S, (onset + length - pos) / CLENCH_EDGE_S)


def dumps(msg: dict) -> str:
    return json.dumps(msg, separators=(",", ":"), allow_nan=False)


class Baseline:
    """Rest baseline: mean band power per channel over a recording window."""

    def __init__(self, seconds: float) -> None:
        self.seconds = seconds
        self.state = "none"  # none | recording | set
        self.recorded_at: float | None = None  # unix seconds, when set
        self.set_mono: float | None = None
        self.power: np.ndarray | None = None  # (channel, filter-bank band) in uV^2; NaN if never computed
        self._acc: list[np.ndarray] = []
        self._until = 0.0

    def start(self, now_mono: float) -> None:
        self.state = "recording"
        self.recorded_at = None
        self.set_mono = None
        self.power = None
        self._acc = []
        self._until = now_mono + self.seconds

    def feed(self, bp: np.ndarray, now_mono: float) -> bool:
        """Add one tick of raw band power. Returns True when the baseline just got set."""
        if self.state != "recording":
            return False
        self._acc.append(bp.copy())
        if now_mono < self._until:
            return False
        # Mean over the ticks that had a value. The slow band needs 2 s of data, so it can be
        # missing at the start; a band with no value at all stays NaN and is sent as null.
        acc = np.array(self._acc)
        have = ~np.isnan(acc)
        n = have.sum(axis=0)
        mean = np.where(have, acc, 0.0).sum(axis=0) / np.maximum(n, 1)
        self.power = np.where(n > 0, np.maximum(mean, 1e-12), np.nan)
        self._acc = []
        self.state = "set"
        self.recorded_at = round(time.time(), 3)
        self.set_mono = now_mono
        return True

    def age_s(self, now_mono: float) -> float | None:
        if self.state != "set" or self.set_mono is None:
            return None
        return round(now_mono - self.set_mono, 1)


class Script:
    """The scripted ~24 s cycle: imagery suppression, jaw EMG, markers, contact blip."""

    def __init__(self, enabled: bool, contact_blips: bool) -> None:
        self.enabled = enabled
        self.contact_blips = contact_blips
        self.rng = random.Random()
        self.t0: float | None = None  # monotonic start of the cycle; None while paused
        self.prev_pos: float | None = None
        self.wobble = np.zeros((2, N_FB))  # slow multiplicative noise per channel and band
        self.emg_drift = 0.0
        self._roll_cycle()

    def _roll_cycle(self) -> None:
        scale = self.rng.uniform(0.9, 1.1)
        self.imagery_change = np.array([IMAGERY_CHANGE[i] * scale for i in FB_IDS])
        self.clench_peaks = [self.rng.uniform(80.0, 150.0) for _ in CLENCHES]
        self.clench_rise = []  # per clench, shape (channel, band)
        for _ in CLENCHES:
            rise = np.zeros((2, N_FB))
            for band, (lo, hi) in CLENCH_RISE.items():
                level = self.rng.uniform(lo, hi)
                for ch in range(2):
                    rise[ch, FB_IDS.index(band)] = level * self.rng.uniform(0.9, 1.1)
            self.clench_rise.append(rise)

    def restart(self, now_mono: float) -> None:
        self.t0 = now_mono
        self.prev_pos = None
        self._roll_cycle()

    def pause(self) -> None:
        self.t0 = None
        self.prev_pos = None

    def position(self, now_mono: float) -> float | None:
        if self.t0 is None:
            return None
        return (now_mono - self.t0) % CYCLE_S

    def gains(self, pos: float | None) -> np.ndarray:
        """Multipliers on band power, shape (channel, filter-bank band)."""
        g = np.ones((2, N_FB))
        if not self.enabled or pos is None:
            return g
        for start, end, contra in IMAGERY:
            env = imagery_envelope(pos, start, end)
            if env <= 0.0:
                continue
            ipsi = 1 - contra
            g[contra] *= 1.0 + self.imagery_change * env
            g[ipsi] *= 1.0 + self.imagery_change * IPSI_FRACTION * env
        # Jaw clench: the same shape as the EMG level, so the bands jump while emgGate is true.
        for (onset, length), rise in zip(CLENCHES, self.clench_rise):
            shape = clench_shape(pos, onset, length)
            if shape > 0.0:
                g *= 1.0 + rise * shape
        # AR(1) wobble, std about 2 %, so the numbers look alive.
        self.wobble = 0.85 * self.wobble + 0.527 * 0.02 * np.array(
            [[self.rng.gauss(0, 1) for _ in range(N_FB)] for _ in range(2)]
        )
        return g * (1.0 + self.wobble)

    def emg(self, pos: float | None) -> float:
        """Synthetic jaw muscle level, uV RMS."""
        self.emg_drift = 0.7 * self.emg_drift + self.rng.gauss(0.0, 0.6)
        level = min(6.0, max(2.0, 4.0 + self.emg_drift + self.rng.gauss(0.0, 0.3)))
        if self.enabled and pos is not None:
            for (onset, length), peak in zip(CLENCHES, self.clench_peaks):
                shape = clench_shape(pos, onset, length)
                if shape > 0.0:
                    level += peak * shape * (1.0 + self.rng.gauss(0.0, 0.05))
        return round(level, 1)

    def contact(self, pos: float | None) -> dict:
        c4 = "good"
        if self.contact_blips and pos is not None and CONTACT_BLIP[0] <= pos < CONTACT_BLIP[1]:
            c4 = "poor"
        return {"C3": "good", "C4": c4}

    def due_markers(self, pos: float | None) -> list[tuple[str, str]]:
        """Markers whose cycle time was crossed since the last tick."""
        if pos is None:
            self.prev_pos = None
            return []
        prev, self.prev_pos = self.prev_pos, pos
        if prev is None:
            return []
        if pos >= prev:
            crossed = [m for m in MARKERS if prev < m[0] <= pos]
        else:  # wrapped into a new cycle
            crossed = [m for m in MARKERS if m[0] > prev or m[0] <= pos]
            self._roll_cycle()
        if not self.enabled:
            return []
        return [(command, source) for _, command, source in crossed]

    def confidence(self) -> float:
        # The decoder sends YES and NO only at 0.9 or more (PLAN D21).
        return round(min(0.97, max(0.9, 0.93 + self.rng.uniform(-0.03, 0.03))), 2)


class Bridge:
    def __init__(self, args: argparse.Namespace) -> None:
        self.port: int = args.port
        self.origins = None if not args.origin else [*args.origin, None]
        self.baseline = Baseline(args.baseline_seconds)
        self.script = Script(enabled=not args.no_script, contact_blips=not args.no_contact_blips)
        self.note = NOTE_SCRIPTED if self.script.enabled else NOTE_RAW
        self.board_id = BoardIds.SYNTHETIC_BOARD.value
        self.srate = int(BoardShim.get_sampling_rate(self.board_id))
        # Pretend the first two EEG rows of the synthetic board are C3 and C4.
        self.rows = list(BoardShim.get_eeg_channels(self.board_id)[:2])
        if self.srate < 2 * SPEC_FREQS[-1]:
            raise SystemExit(f"sampling rate {self.srate} Hz is too low for a 1 to 40 Hz spectrum")
        self.board: BoardShim | None = None
        self.clients: set[ServerConnection] = set()
        self.meta_version = 0
        self.frames_sent = 0
        self.frames_skipped_slow = 0
        self.frames_dropped_bad = 0
        self.bp_smooth: np.ndarray | None = None

    # ---- board ----

    def open_board(self) -> None:
        BoardShim.disable_board_logger()
        self.board = BoardShim(self.board_id, BrainFlowInputParams())
        self.board.prepare_session()
        self.board.start_stream(self.srate * BOARD_BUFFER_S)

    def close_board(self) -> None:
        board, self.board = self.board, None
        if board is None:
            return
        try:
            board.stop_stream()
        except BrainFlowError:
            pass
        try:
            if board.is_prepared():
                board.release_session()
        except BrainFlowError:
            pass
        del board

    # ---- sending ----

    def send_all(self, msg: dict, essential: bool = False) -> None:
        """Broadcast without blocking. Stream frames skip a client whose buffer is full."""
        try:
            text = dumps(msg)
        except ValueError:  # NaN or infinity slipped in; never send invalid JSON
            self.frames_dropped_bad += 1
            return
        targets = []
        for ws in self.clients:
            transport = ws.transport
            if not essential and transport is not None and transport.get_write_buffer_size() > WRITE_LIMIT:
                self.frames_skipped_slow += 1
                continue
            targets.append(ws)
        if targets:
            broadcast(targets, text)
            self.frames_sent += len(targets)

    def meta(self) -> dict:
        return {
            "type": "viz.meta",
            "v": 1,
            "source": "synthetic",
            "board": BoardIds.SYNTHETIC_BOARD.name,
            "srate": self.srate,
            "channels": list(CHANNELS),
            "units": "uV",
            "traceFilter": "none (synthetic)",
            "bands": {"alpha_mu": list(MU_BAND), "beta": list(BETA_BAND)},
            "filterBank": [{"id": i, "lo": lo, "hi": hi, "label": label} for i, lo, hi, label in FILTER_BANK],
            "baseline": {"state": self.baseline.state, "recordedAt": self.baseline.recorded_at},
            "recordedAt": None,
            "brainTest": {"state": "not_run", "summary": None},
            "note": self.note,
        }

    def publish_meta(self) -> None:
        self.meta_version += 1
        self.send_all(self.meta(), essential=True)

    def start_baseline(self) -> None:
        self.baseline.start(time.monotonic())
        self.script.pause()  # the wearer rests while the baseline records
        self.publish_meta()

    # ---- clients ----

    async def handler(self, ws: ServerConnection) -> None:
        try:
            sent_version = self.meta_version
            await ws.send(dumps(self.meta()))
            self.clients.add(ws)
            if sent_version != self.meta_version:  # baseline changed while we sent
                await ws.send(dumps(self.meta()))
            async for raw in ws:
                self.on_client_message(raw)
        except ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)

    def on_client_message(self, raw: str | bytes) -> None:
        if not isinstance(raw, str):
            return
        try:
            msg = json.loads(raw)
        except (ValueError, RecursionError):
            return
        if isinstance(msg, dict) and msg.get("type") == "viz.cmd" and msg.get("cmd") == "baseline":
            self.start_baseline()

    # ---- signal processing ----

    def band_powers(self, x2: np.ndarray) -> np.ndarray:
        """Power (uV^2) per channel and filter-bank band, shape (channel, band), plus the background.

        The 8 to 30 Hz bands use the last 1 s (Welch, 0.25 s Hann segments, 1 Hz bins). The slow
        band uses the last 2 s as one Hann segment (0.5 Hz bins, so 0.5 to 4.5 Hz; 0.05 Hz cannot
        be resolved in 2 s) and is NaN until 2 s of data exist.
        """
        out = np.full((2, N_FB), np.nan)
        x1 = x2[:, -self.srate:]
        f, p = welch(x1, fs=self.srate, nperseg=min(x1.shape[1], self.srate // 4), nfft=self.srate, axis=-1)
        for i, (_, lo, hi, _) in enumerate(FILTER_BANK):
            if i != SLOW_FB:
                out[:, i] = p[:, (f >= lo) & (f < hi)].sum(axis=-1) * (f[1] - f[0])
        n = SLOW_WINDOW_S * self.srate
        if x2.shape[1] >= n:
            _, lo, hi, _ = FILTER_BANK[SLOW_FB]
            f, p = welch(x2[:, -n:], fs=self.srate, nperseg=n, nfft=n, axis=-1)
            out[:, SLOW_FB] = p[:, (f >= lo) & (f < hi)].sum(axis=-1) * (f[1] - f[0])
        return out + BACKGROUND

    def spectrum(self, x: np.ndarray, gains: np.ndarray) -> np.ndarray:
        """log10 PSD (uV^2/Hz) at 1..40 Hz from up to the last 2 s, with each band's scripted change."""
        nperseg = min(x.shape[1], self.srate)
        f, p = welch(x, fs=self.srate, nperseg=nperseg, nfft=self.srate, axis=-1)
        idx = np.searchsorted(f, SPEC_FREQS)
        p = p[:, idx]
        freqs = f[idx]
        for i, (_, lo, hi, _) in enumerate(FILTER_BANK):
            p[:, (freqs >= lo) & (freqs < hi)] *= gains[:, i:i + 1]
        return np.log10(np.maximum(p, 1e-12))

    # ---- the 10 Hz loop ----

    def step(self, tick: int) -> None:
        now_mono = time.monotonic()
        now = round(time.time(), 3)
        # Non-destructive peek at the newest 2 s. Never get_board_data().
        data = self.board.get_current_board_data(2 * self.srate)
        x2 = data[self.rows]
        pos = None
        if x2.shape[1] >= self.srate // 2:  # skip until at least 0.5 s of data
            raw = self.band_powers(x2)
            if self.bp_smooth is None:
                self.bp_smooth = raw
            else:  # a band without a value yet takes the first one it gets
                s = self.bp_smooth
                self.bp_smooth = np.where(np.isnan(s), raw, np.where(np.isnan(raw), s, s + BP_SMOOTHING * (raw - s)))
            bp = self.bp_smooth
            if self.baseline.state == "none":
                self.start_baseline()
            if self.baseline.feed(bp, now_mono):
                self.script.restart(now_mono)
                self.publish_meta()
            pos = self.script.position(now_mono)
            gains = self.script.gains(pos)
            emg = self.script.emg(pos)

            erd = np.zeros((2, N_FB))  # zeros while there is no baseline
            if self.baseline.state == "set":
                erd = (bp * gains - self.baseline.power) / self.baseline.power * 100.0
            erd = np.round(np.clip(erd, ERD_MIN, ERD_MAX), 1)  # NaN (a band not computed) stays NaN
            fb = [[None if np.isnan(v) else float(v) for v in row] for row in erd]
            # The older fields repeat the filter bank, so the two can never disagree. A NaN here
            # (never expected: these bands need only 0.5 s of data) makes send_all drop the frame.
            c3, c4 = (
                {"mu": float(erd[ch, MU_FB]), "beta": round(float(np.mean(erd[ch, list(BETA_FB)])), 1)}
                for ch in range(2)
            )
            self.send_all({
                "type": "viz.mi",
                "t": now,
                "c3": c3,
                "c4": c4,
                "laterality": round(c4["mu"] - c3["mu"], 1),
                "emgGate": emg > EMG_THRESHOLD,
                "baselineAgeS": self.baseline.age_s(now_mono),
                "emg": emg,
                "emgThreshold": EMG_THRESHOLD,
                "fb": {"c3": fb[0], "c4": fb[1]},
            })

            spec = np.round(self.spectrum(x2, gains), 3)
            self.send_all({
                "type": "viz.spec",
                "t": now,
                "freqs": SPEC_FREQS,
                "c3": spec[0].tolist(),
                "c4": spec[1].tolist(),
            })

            for command, source in self.script.due_markers(pos):
                self.send_all({
                    "type": "viz.marker",
                    "t": round(time.time(), 3),
                    "id": str(uuid.uuid4()),
                    "command": command,
                    "confidence": self.script.confidence() if source == "imagery" else None,
                    "source": source,
                }, essential=True)
        else:
            pos = self.script.position(now_mono)

        if tick % QUALITY_EVERY_TICKS == 0:
            self.send_all({"type": "viz.quality", "t": now, "contact": self.script.contact(pos)})

    async def tick_loop(self) -> None:
        loop = asyncio.get_running_loop()
        next_t = loop.time()
        next_status = next_t + STATUS_EVERY_S
        last_frames = 0
        tick = 0
        while True:
            next_t += TICK_S
            delay = next_t - loop.time()
            if delay > 0:
                await asyncio.sleep(delay)
            elif delay < -0.5:  # fell far behind (sleep, debugger); resync, no burst
                next_t = loop.time()
            self.step(tick)
            tick += 1
            if loop.time() >= next_status:
                next_status += STATUS_EVERY_S
                print(
                    f"[viz-synthetic] clients={len(self.clients)} frames_sent={self.frames_sent}"
                    f" (+{self.frames_sent - last_frames} in 10 s) skipped_slow={self.frames_skipped_slow}"
                    f" baseline={self.baseline.state}",
                    flush=True,
                )
                last_frames = self.frames_sent

    async def run(self) -> int:
        loop = asyncio.get_running_loop()
        stop = asyncio.Event()

        def on_signal() -> None:
            stop.set()
            for sig in (signal.SIGINT, signal.SIGTERM):  # a second Ctrl-C forces it
                loop.remove_signal_handler(sig)

        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, on_signal)

        self.open_board()
        try:
            try:
                server = await serve(
                    self.handler,
                    HOST,
                    self.port,
                    origins=self.origins,
                    compression=None,  # loopback; save the CPU
                    max_size=MAX_INCOMING,
                    max_queue=8,
                    write_limit=WRITE_LIMIT,
                    ping_interval=10,
                    ping_timeout=10,
                    close_timeout=2,
                )
            except OSError as exc:
                print(f"[viz-synthetic] cannot listen on {HOST}:{self.port}: {exc}", file=sys.stderr)
                return 1
            try:
                for sock in server.sockets:
                    if sock.getsockname()[0] != HOST:
                        print(f"[viz-synthetic] refusing: bound to {sock.getsockname()}", file=sys.stderr)
                        return 1
                print(
                    f"[viz-synthetic] SYNTHETIC TEST SIGNAL on ws://{HOST}:{self.port}"
                    f" ({self.srate} Hz, C3/C4 = synthetic EEG rows {self.rows[0]},{self.rows[1]},"
                    f" script {'on' if self.script.enabled else 'off'}). Ctrl-C to stop.",
                    flush=True,
                )
                ticker = asyncio.create_task(self.tick_loop())
                stopper = asyncio.create_task(stop.wait())
                done, _ = await asyncio.wait({ticker, stopper}, return_when=asyncio.FIRST_COMPLETED)
                crash = ticker.exception() if ticker in done else None
                for task in (ticker, stopper):
                    task.cancel()
                await asyncio.gather(ticker, stopper, return_exceptions=True)
                if crash is not None:
                    raise crash
            finally:
                server.close()
                await server.wait_closed()
        finally:
            self.close_board()
        print("[viz-synthetic] stopped, board released.", flush=True)
        return 0


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Synthetic EEG viz bridge (port 8766). Not a measurement.")
    ap.add_argument("--host", default=HOST, help="must be 127.0.0.1; anything else is refused")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"default {DEFAULT_PORT}; 8765 is refused")
    ap.add_argument("--baseline-seconds", type=float, default=5.0, help="rest baseline length (1 to 120 s)")
    ap.add_argument("--no-script", action="store_true", help="no scripted cycle: raw synthetic ERD noise only")
    ap.add_argument("--no-contact-blips", action="store_true", help="no scripted 2 s 'C4 poor' blip per cycle")
    ap.add_argument(
        "--origin",
        action="append",
        metavar="URL",
        help="allow only this browser Origin (repeatable), e.g. http://localhost:3000. Default: any",
    )
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.host != HOST:
        print(f"[viz-synthetic] refusing host {args.host!r}: this bridge binds {HOST} only.", file=sys.stderr)
        return 2
    if args.port == GESTURE_PORT:
        print("[viz-synthetic] refusing port 8765: that is the station gesture and health channel.", file=sys.stderr)
        return 2
    if not 1 <= args.port <= 65535:
        print(f"[viz-synthetic] bad port {args.port}", file=sys.stderr)
        return 2
    if not 1.0 <= args.baseline_seconds <= 120.0:
        print("[viz-synthetic] --baseline-seconds must be between 1 and 120", file=sys.stderr)
        return 2
    logging.basicConfig(level=logging.WARNING, format="[viz-synthetic] %(levelname)s %(name)s: %(message)s")
    try:
        return asyncio.run(Bridge(args).run())
    except KeyboardInterrupt:  # second Ctrl-C during shutdown
        return 130


if __name__ == "__main__":
    sys.exit(main())
