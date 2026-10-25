"""The decoder's viz bridge for Screen 1 (/brain): ws://127.0.0.1:8766, tools/VIZ_PROTOCOL.md version 1.

Display only, and kept apart from the station channel on 8765: its own server, thread and event loop. The decoder
hands it a copy of its newest filtered window, raw samples and jaw level after its one board read (update()) and
never waits for it; this side sends on its own clock (viz.mi and viz.spec 10 Hz, viz.quality 2 Hz) and republishes
every 8765 gesture as a viz.marker afterwards. ERD uses the decoder's own filter bank against a display baseline that
only this bridge keeps: a viz.cmd baseline from the page never touches the decoder or anything it sends on 8765.
"""
import asyncio
import json
import math
import threading
import time
from typing import Iterable, Optional

import numpy as np
from scipy.signal import welch

from eeg import config

HOST, PORT = "127.0.0.1", 8766
BASELINE_S = 5.0
SLOW_CLIENT_BYTES = 32 * 1024
C3, C4 = config.CHANNELS.index("C3"), config.CHANNELS.index("C4")
# The decoder's bands, ids and labels as VIZ_PROTOCOL.md 3.2.1 names them (b8_12 is the one the glow reads).
FILTER_BANK = [
    {"id": "mrcp", "lo": 0.05, "hi": 5, "label": "Slow potential 0.05-5 Hz", "band": "0.05-5"},
    {"id": "b8_12", "lo": 8, "hi": 12, "label": "Mu 8-12 Hz", "band": "8-12"},
    {"id": "b12_16", "lo": 12, "hi": 16, "label": "Low beta 12-16 Hz", "band": "12-16"},
    {"id": "b16_20", "lo": 16, "hi": 20, "label": "Beta 16-20 Hz", "band": "16-20"},
    {"id": "b20_26", "lo": 20, "hi": 26, "label": "Beta 20-26 Hz", "band": "20-26"},
    {"id": "b26_30", "lo": 26, "hi": 30, "label": "High beta 26-30 Hz", "band": "26-30"},
]
BETA_IDS = ("b12_16", "b16_20", "b20_26", "b26_30")


def _r1(x: float) -> float:
    return round(float(x), 1)


def board_name(board_id: int) -> str:
    try:
        from brainflow.board_shim import BoardIds
        return BoardIds(board_id).name
    except Exception:
        return f"BRAINFLOW_BOARD_{board_id}"


class VizBridge:
    def __init__(self, fs: float, source: str = "live", board: str = board_name(config.BOARD_ID),
                 host: str = HOST, port: int = PORT, origins: Iterable[str] = (), log=print):
        if source not in ("live", "replay", "synthetic"):
            raise ValueError("source must be live, replay or synthetic")
        if host != HOST or port == 8765:
            raise ValueError("the viz bridge listens on 127.0.0.1 only, never on 8765")
        self.fs, self.source, self.board = float(fs), source, board
        self.host, self.port, self.origins, self.log = host, port, list(origins), log
        self.clients = set()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._lock = threading.Lock()
        self._latest = None          # (window, raw, jaw_level, jaw_baseline_power)
        self._started_at = None      # first data time
        self.baseline_state, self.baseline_at = "none", None
        self._rec_start, self._rec = None, []
        self._ref = None             # baseline band power: {channel: [power per FILTER_BANK band]}
        self._ready = threading.Event()
        self.error = None

    # ------------------------------------------------------------ decoder side (never blocks)
    def update(self, window, raw, jaw_level: float, jaw_baseline: Optional[float]):
        if window is None:
            return
        with self._lock:
            self._latest = (window, raw, float(jaw_level), jaw_baseline)
            if self._started_at is None:
                self._started_at = time.time()

    def marker(self, gesture: dict):
        """Republish an 8765 gesture (already sent there) as a viz.marker with the same id."""
        if gesture.get("type") != "gesture" or not self.loop:
            return
        jaw = gesture.get("command") in ("CONFIRM", "STOP")
        msg = {"type": "viz.marker", "t": round(time.time(), 3), "id": gesture["id"], "command": gesture["command"],
               "confidence": None if jaw or gesture.get("command") == "HEADSET_OFF" else gesture.get("confidence"),
               "source": "jaw" if jaw else gesture.get("source", "imagery")}
        self._send_soon(msg, stream=False)

    # ------------------------------------------------------------ messages
    def meta(self) -> dict:
        live = self.source == "live"
        return {
            "type": "viz.meta", "v": 1, "source": self.source, "board": self.board, "srate": int(round(self.fs)),
            "channels": ["C3", "C4"], "units": "uV",
            "traceFilter": "causal 4th-order Butterworth band-pass filter bank, the same one the decoder classifies",
            "bands": {"alpha_mu": [8, 12], "beta": [12, 30]},
            "filterBank": [{k: b[k] for k in ("id", "lo", "hi", "label")} for b in FILTER_BANK],
            "baseline": {"state": self.baseline_state, "recordedAt": self.baseline_at},
            "recordedAt": None,
            "brainTest": {"state": "not_run", "summary": None},
            "note": ("Live headset through the decoder. The baseline here is for this screen only."
                     if live else "Fake demo signal from eeg-data live.py --demo. Not a measurement."),
        }

    def _band_power(self, window) -> dict:
        n = max(1, int(round(self.fs)))  # last 1 s, as the decoder's own windows
        out = {}
        for name, idx in (("c3", C3), ("c4", C4)):
            out[name] = [float(np.mean(window[b["band"]][idx, -n:] ** 2)) if b["band"] in window else None
                         for b in FILTER_BANK]
        return out

    def _step_baseline(self, power, now):
        if self.baseline_state == "none" and self._started_at and now - self._started_at >= 0.5:
            self._begin_baseline(now)
        if self.baseline_state == "recording":
            self._rec.append(power)
            if now - self._rec_start >= BASELINE_S:
                self._ref = {ch: [None if any(p[ch][i] is None for p in self._rec) else
                                  float(np.mean([p[ch][i] for p in self._rec])) for i in range(len(FILTER_BANK))]
                             for ch in ("c3", "c4")}
                self.baseline_state, self.baseline_at = "set", round(now, 3)
                self._broadcast_now(self.meta(), stream=False)

    def _begin_baseline(self, now):
        self.baseline_state, self.baseline_at, self._rec_start, self._rec, self._ref = "recording", None, now, [], None
        self._broadcast_now(self.meta(), stream=False)

    def mi(self, now) -> Optional[dict]:
        with self._lock:
            latest = self._latest
        if latest is None:
            return None
        window, raw, level, jaw_base = latest
        power = self._band_power(window)
        self._step_baseline(power, now)
        fb = {"c3": [0.0] * len(FILTER_BANK), "c4": [0.0] * len(FILTER_BANK)}
        if self.baseline_state == "set":
            for ch in ("c3", "c4"):
                fb[ch] = [None if (a is None or r is None or r <= 0) else _r1(max(-100.0, min(1000.0, (a - r) / r * 100)))
                          for a, r in zip(power[ch], self._ref[ch])]
        ids = [b["id"] for b in FILTER_BANK]

        def summary(row):
            d = dict(zip(ids, row))
            beta = [d[i] for i in BETA_IDS if d[i] is not None]
            return {"mu": d["b8_12"] if d["b8_12"] is not None else 0.0,
                    "beta": _r1(sum(beta) / len(beta)) if beta else 0.0}
        c3, c4 = summary(fb["c3"]), summary(fb["c4"])
        base = jaw_base if jaw_base and jaw_base > 0 else 1.0
        emg = _r1(math.sqrt(max(level, 0.0) * base))       # uV RMS of the jaw band
        threshold = _r1(math.sqrt(config.JAW_RATIO * base))  # the decoder's clench level, in the same units
        return {"type": "viz.mi", "t": round(now, 3), "c3": c3, "c4": c4, "laterality": _r1(c4["mu"] - c3["mu"]),
                "emgGate": bool(emg > threshold), "emg": emg, "emgThreshold": threshold,
                "baselineAgeS": _r1(now - self.baseline_at) if self.baseline_state == "set" else None, "fb": fb}

    def spec(self, now) -> Optional[dict]:
        with self._lock:
            latest = self._latest
        if latest is None or latest[1] is None or latest[1].shape[1] < int(self.fs):
            return None
        raw = latest[1][:, -int(round(2 * self.fs)):]
        freqs = list(range(1, 41))
        out = {"type": "viz.spec", "t": round(now, 3), "freqs": freqs}
        for name, idx in (("c3", C3), ("c4", C4)):
            f, p = welch(raw[idx] - raw[idx].mean(), fs=self.fs, nperseg=int(round(self.fs)), window="hann")
            out[name] = [round(float(np.log10(max(v, 1e-12))), 3) for v in np.interp(freqs, f, p)]
        return out

    def quality(self, now) -> Optional[dict]:
        with self._lock:
            latest = self._latest
        if latest is None:
            return None
        band = latest[0][config.COV_BAND]

        def contact(i):
            x = band[i]
            if x.std() < config.FLAT_UV:
                return "off"
            if np.ptp(x) > config.SPIKE_UV:
                return "poor"
            return "fair" if np.ptp(x) > config.SPIKE_UV / 2 else "good"
        return {"type": "viz.quality", "t": round(now, 3), "contact": {"C3": contact(C3), "C4": contact(C4)}}

    # ------------------------------------------------------------ server (own thread and loop)
    async def _handler(self, ws):
        try:
            await ws.send(json.dumps(self.meta()))  # always the first message on a connection
            self.clients.add(ws)
            async for message in ws:  # only viz.cmd baseline is honoured; anything else is ignored
                if isinstance(message, str):
                    try:
                        cmd = json.loads(message)
                    except ValueError:
                        continue
                    if isinstance(cmd, dict) and cmd.get("type") == "viz.cmd" and cmd.get("cmd") == "baseline":
                        if self._latest is not None:
                            self._begin_baseline(time.time())
        except Exception:
            pass
        finally:
            self.clients.discard(ws)

    def _broadcast_now(self, msg: dict, stream: bool):
        """Called on the viz loop. Stream frames skip a client whose send buffer is over 32 KiB."""
        text = json.dumps(msg)
        for ws in list(self.clients):
            try:
                if stream and ws.transport.get_write_buffer_size() > SLOW_CLIENT_BYTES:
                    continue
                asyncio.ensure_future(ws.send(text))
            except Exception:
                self.clients.discard(ws)

    def _send_soon(self, msg: dict, stream: bool):
        try:
            self.loop.call_soon_threadsafe(self._broadcast_now, msg, stream)
        except Exception:
            pass

    async def _clock(self):
        tick = 0
        while True:
            await asyncio.sleep(0.1 - (time.time() % 0.1))
            now = time.time()
            try:
                for msg in (self.mi(now), self.spec(now), self.quality(now) if tick % 5 == 0 else None):
                    if msg:
                        self._broadcast_now(msg, stream=True)
            except Exception as e:  # a viz error never reaches the decoder
                self.log(f"viz: {e!r}")
            tick += 1

    async def _main(self):
        from websockets.asyncio.server import serve
        try:
            async with serve(self._handler, self.host, self.port, origins=self.origins + [None],
                             max_size=4096, ping_interval=10, ping_timeout=10):
                self._ready.set()
                await self._clock()
        except OSError as e:
            self.error = f"cannot listen on {self.host}:{self.port} ({e.strerror or e})"
            self._ready.set()

    def start(self) -> "VizBridge":
        def run():
            self.loop = asyncio.new_event_loop()
            self.loop.run_until_complete(self._main())
        threading.Thread(target=run, daemon=True, name="viz-bridge").start()
        self._ready.wait(5)
        if self.error:
            raise RuntimeError(self.error)
        self.log(f"viz bridge for /brain on ws://{self.host}:{self.port} (source {self.source})")
        return self
