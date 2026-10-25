"""The decoder's WebSocket server: ws://127.0.0.1:8765, the address PLAN.md agrees with the station page.

Sends text frames, one JSON object each, to every connected page:
  {"type": "gesture", ...}  {"type": "health", ...}   the station contract (docs/station.md 2.4)
  {"type": "eeg", ...}      live signal for the /eeg page; the station ignores types it does not know
Nothing is read back. Bound to 127.0.0.1 only, and only pages from ALLOWED_ORIGINS may connect: without that
check, any website open in the browser could read the wearer's EEG.
"""
import asyncio
import json
import threading
import time
from typing import Iterable, Optional

from eeg import config
from eeg.brainmap import POS, BrainState

HOST, PORT = "127.0.0.1", 8765
ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000", "https://neurolingo-web.vercel.app",
                   "https://eleven-calhacks.vercel.app"]


class DecoderServer:
    def __init__(self, host: str = HOST, port: int = PORT, origins: Iterable[str] = ALLOWED_ORIGINS, log=print):
        self.host, self.port, self.origins, self.log = host, port, list(origins), log
        self.clients = set()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._ready = threading.Event()
        self.error: Optional[str] = None

    async def _handler(self, ws):
        self.clients.add(ws)
        self.log(f"page connected ({len(self.clients)} open)")
        try:
            await ws.wait_closed()
        finally:
            self.clients.discard(ws)

    async def _main(self):
        from websockets.asyncio.server import serve
        try:
            async with serve(self._handler, self.host, self.port, origins=self.origins + [None]):
                self._ready.set()
                await asyncio.Future()  # forever
        except OSError as e:
            self.error = f"cannot listen on {self.host}:{self.port} ({e.strerror or e})"
            self._ready.set()

    def start(self) -> "DecoderServer":
        def run():
            self.loop = asyncio.new_event_loop()
            self.loop.run_until_complete(self._main())
        threading.Thread(target=run, daemon=True).start()
        self._ready.wait(5)
        if self.error:
            raise RuntimeError(self.error)
        self.log(f"decoder listening on ws://{self.host}:{self.port} (pages from {', '.join(self.origins)})")
        return self

    def send(self, msg: dict):
        if not self.loop or not self.clients:
            return
        text = json.dumps(msg)

        async def broadcast():
            for ws in list(self.clients):
                try:
                    await ws.send(text)
                except Exception:
                    self.clients.discard(ws)
        asyncio.run_coroutine_threadsafe(broadcast(), self.loop)


def eeg_frame(state: BrainState, smoothed: dict, status: str, jaw_level: float, samples_per_s: float) -> dict:
    """The /eeg page's live frame. Values only; no raw EEG leaves the decoder."""
    left_h, right_h = state.hemispheres()
    return {
        "type": "eeg",
        "t": round(time.time(), 3),
        "channels": [{"name": ch, "x": POS[ch][0], "y": POS[ch][1], "change": round(float(state.change[i]), 1),
                      "flat": bool(state.flat[i]), "noisy": bool(state.noisy[i])}
                     for i, ch in enumerate(config.CHANNELS)],
        "hemispheres": {"left": round(left_h, 1), "right": round(right_h, 1)},
        "activeHand": state.active_hand(),
        "proba": {k: round(float(v), 3) for k, v in smoothed.items()},
        "status": status,
        "jaw": round(float(jaw_level), 1),
        "jawThreshold": config.JAW_RATIO,
        "samplesPerSecond": round(float(samples_per_s), 1),
    }


class FrameMaker:
    """Keeps the brain state and the sample rate between engine updates."""

    def __init__(self, band: str = "mu + beta"):
        self.state = BrainState(band)
        self._t0, self._n0 = time.time(), 0
        self.rate = 0.0

    def __call__(self, up, fs: float) -> Optional[dict]:
        if up.window is None:
            return None
        self.state.update(up.window, fs)
        now = time.time()
        if now - self._t0 >= 1.0:
            self.rate = (up.samples - self._n0) / (now - self._t0)
            self._t0, self._n0 = now, up.samples
        return eeg_frame(self.state, up.smoothed, up.status, up.jaw_level, self.rate)


