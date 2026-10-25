"""Live decoding loop: headset -> filters -> imagery model + jaw detector -> commands.

The command words follow `mode` (config.MODES): direct sends PICK_1..PICK_4 and STOP, scan sends YES/NO/CONFIRM/STOP.

Used by live.py (headless or with a window) and quiz.py. Call start() once, then poll() in a loop;
each poll returns an Update with the latest probabilities and any new command messages.
"""
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np

from eeg import board as headset
from eeg import config, messages
from eeg.filters import FilterBank
from eeg.hands import HandConfig, HandDecoder
from eeg.jaw import JawDetector


@dataclass
class Update:
    t: float
    proba: Optional[Dict[str, float]] = None       # raw model output for this window (None if no new window)
    smoothed: Dict[str, float] = field(default_factory=dict)
    status: str = "UNSURE"
    jaw_level: float = 0.0
    commands: List[dict] = field(default_factory=list)
    jaw_events: List[dict] = field(default_factory=list)   # raw single / double / long clenches
    window: Optional[Dict[str, np.ndarray]] = None          # latest filtered 2 s window per band (for displays)
    raw: Optional[np.ndarray] = None                         # latest raw samples, a copy (for the viz spectrum)
    samples: int = 0


class Engine:
    def __init__(self, model, meta: dict, hand_cfg: HandConfig = None, step_s: float = 0.1,
                 settle_s: float = 5.0, port: str = config.SERIAL_PORT, board_id: int = config.BOARD_ID,
                 use_imagery: bool = True, use_jaw: bool = True, jaw_only: bool = False, log=print,
                 reader=None, opener=None, closer=None, mode: str = config.DEFAULT_MODE):
        if mode not in config.MODES:
            raise ValueError(f"unknown mode {mode}; use one of {', '.join(config.MODES)}")
        self.model, self.meta, self.mode = model, meta, mode
        self.classes = list(meta["classes"])
        self.fs = float(meta["fs"])
        self.n_win = int(round(meta["window_s"] * self.fs))
        self.step = max(1, int(round(step_s * self.fs)))
        self.settle_s, self.port, self.board_id, self.log = settle_s, port, board_id, log
        self.use_imagery = use_imagery and not jaw_only
        self.use_jaw, self.jaw_only = use_jaw or jaw_only, jaw_only
        self.hands = HandDecoder(hand_cfg, hands=[c for c in self.classes if c in config.HANDS])
        self.bank = FilterBank(self.fs)
        self.jaw = JawDetector(self.fs)
        self.buf = None
        self.raw = np.empty((len(config.CHANNELS), 0))     # copy of the newest raw samples, after the one read
        self.since_pred = 0
        self.total_samples = 0
        self.last_packet = None
        self.headset_off_sent = False
        # injectable for tests / demos
        self._read = reader or (lambda b: headset.read(b, self.board_id))
        self._open = opener or (lambda: headset.open_board(self.board_id, self.port, log=self.log))
        self._close = closer or headset.close_board
        self.board = None

    # ------------------------------------------------------------ setup
    def start(self):
        self.board = self._open()
        self.log(f"Warming up {self.settle_s:.0f} s - relax, jaw loose ...")
        t_end, stamps = time.time() + self.settle_s, []
        while time.time() < t_end or self.buf is None or self.buf[config.COV_BAND].shape[1] < self.n_win:
            eeg, ts = self._read(self.board)
            if ts.size:
                self._filter(eeg)
                self.jaw.calibrate(eeg)  # resting jaw level = baseline
                stamps.append(ts)
                self.last_packet = time.time()
            else:
                time.sleep(0.005)
        fs_live = headset.sampling_rate(np.concatenate(stamps), self.fs)
        self.log(f"Live {fs_live:.2f} Hz (model {self.fs:.2f} Hz); jaw baseline set")
        if abs(fs_live - self.fs) / self.fs > 0.02:
            self.log("WARNING: live sampling rate differs >2% from training")

    def stop(self):
        if self.board is not None:
            self._close(self.board)
            self.board = None

    # ------------------------------------------------------------ loop
    def _filter(self, eeg):
        f = self.bank(eeg)
        self.buf = f if self.buf is None else {b: np.concatenate([self.buf[b], a], axis=1) for b, a in f.items()}
        self.buf = {b: a[:, -self.n_win:] for b, a in self.buf.items()}

    def healthy(self) -> bool:
        return self.last_packet is not None and time.time() - self.last_packet < config.WATCHDOG_S

    def poll(self) -> Update:
        now = time.time()
        up = Update(t=now, samples=self.total_samples)
        eeg, ts = self._read(self.board)
        if not ts.size:
            if self.last_packet and not self.healthy() and not self.headset_off_sent:
                self.headset_off_sent = True  # watchdog: no packets for WATCHDOG_S
                up.commands.append(messages.gesture("HEADSET_OFF", self.last_packet, 1.0, "watchdog", now))
            time.sleep(0.003)
            return up
        self.last_packet, self.headset_off_sent = now, False
        self.raw = np.concatenate([self.raw, eeg], axis=1)[:, -int(2.5 * self.fs):]
        self._filter(eeg)
        self.total_samples += ts.size
        up.samples = self.total_samples
        if self.use_jaw:
            for ev in self.jaw.process(eeg, ts):
                up.jaw_events.append(ev)
                msg = messages.from_jaw(ev, self.jaw_only, now, mode=self.mode)
                if msg:
                    up.commands.append(msg)
            up.jaw_level = self.jaw.level
            t_last = float(ts[-1])
            if t_last < self.jaw.holdoff_until(t_last):  # a jaw clench must never be read as a fist
                self.hands.suppress(self.jaw.holdoff_until(t_last))
        self.since_pred += ts.size
        if self.use_imagery and self.since_pred >= self.step:
            self.since_pred = 0
            up.window = {b: a.copy() for b, a in self.buf.items()}
            up.raw = self.raw.copy()
            p = self.model.proba({b: a[None] for b, a in self.buf.items()})[0]
            up.proba = {c: float(v) for c, v in zip(self.classes, p)}
            ev = self.hands.update(float(ts[-1]), up.proba)
            if ev:
                up.commands.append(messages.from_hand(ev, now, mode=self.mode))
        up.smoothed, up.status = dict(self.hands.smoothed), self.hands.status
        return up
