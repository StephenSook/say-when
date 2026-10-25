"""Jaw clench detection from muscle (EMG) power - a muscle signal, not a brain signal.

Streaming: 30-55 Hz power averaged over channels, smoothed, compared with the wearer's resting
baseline. A burst starts at JAW_RATIO x baseline and ends below JAW_RATIO * JAW_RELEASE x baseline.

  long burst (>= LONG_CLENCH_S)              -> "long"    STOP, fired as soon as it gets that long
  two short bursts within DOUBLE_GAP_S       -> "double"  direct (D18): PICK_4; scan (D17): STOP
  one short burst, nothing within the gap    -> "single"  direct (D18): PICK_3; scan (D17): CONFIRM

The words per map, and the jaw-only fallback's, are in messages.JAW_COMMAND and messages.JAW_ONLY_COMMAND.
"""
import math
from typing import List, Optional

import numpy as np

from eeg import config
from eeg.filters import FilterBank


class JawDetector:
    def __init__(self, fs: float, n_ch: int = len(config.CHANNELS), baseline: Optional[float] = None,
                 ratio: float = config.JAW_RATIO):
        self.fs = float(fs)
        self.bank = FilterBank(fs, n_ch, {"emg": config.EMG_BAND})
        self.alpha = 1 - math.exp(-1 / (fs * config.JAW_SMOOTH_S))
        self.env = None
        self.baseline = baseline
        self.ratio = ratio
        self._warm: List[float] = []
        self._burst_start = None      # time the current burst started
        self._long_sent = False
        self._pending = None          # (onset, end) of a short burst waiting for a possible second one
        self.last_end = -1e18         # end of the most recent burst (for the imagery hold-off)
        self.level = 0.0              # envelope / baseline, for display

    @property
    def active(self) -> bool:
        return self._burst_start is not None

    def calibrate(self, chunk: np.ndarray):
        """Feed resting data; the baseline becomes the median envelope over everything fed so far."""
        self._run(chunk, np.zeros(chunk.shape[1]), learn=True)
        self.baseline = float(np.median(self._warm)) if self._warm else None

    def process(self, chunk: np.ndarray, ts: np.ndarray) -> List[dict]:
        return self._run(chunk, ts, learn=False)

    def _run(self, chunk, ts, learn):
        events = []
        if chunk.shape[1] == 0:
            return events
        power = np.mean(self.bank(chunk)["emg"] ** 2, axis=0)
        for p, t in zip(power, ts):
            self.env = p if self.env is None else self.env + self.alpha * (p - self.env)
            if learn:
                self._warm.append(self.env)
                continue
            if not self.baseline:
                continue
            self.level = self.env / self.baseline
            events += self._step(float(t))
        return events

    def _step(self, t):
        out = []
        if self._burst_start is None:
            if self._pending and t - self._pending[1] > config.DOUBLE_GAP_S:
                out.append(self._event("single", self._pending[0], t))
                self._pending = None
            if self.level >= self.ratio:
                self._burst_start, self._long_sent = t, False
        else:
            if not self._long_sent and t - self._burst_start >= config.LONG_CLENCH_S:
                out.append(self._event("long", self._burst_start, t))
                self._long_sent, self._pending = True, None
            if self.level < self.ratio * config.JAW_RELEASE:
                onset, self._burst_start, self.last_end = self._burst_start, None, t
                if not self._long_sent and t - onset >= config.MIN_BURST_S:
                    if self._pending and onset - self._pending[1] <= config.DOUBLE_GAP_S:
                        out.append(self._event("double", self._pending[0], t))
                        self._pending = None
                    else:
                        self._pending = (onset, t)
        return out

    def _event(self, kind, onset, t):
        return {"kind": kind, "onset": onset, "t": t, "strength": round(self.level, 1)}

    def holdoff_until(self, now: float) -> float:
        """Imagery must stay silent until this time (during a clench and JAW_HOLDOFF_S after it ends)."""
        return (now if self.active else self.last_end) + config.JAW_HOLDOFF_S


def strongest_spike(seg: np.ndarray, fs: float, baseline_power: float, lead_s: float = 0.0):
    """For recordings: (peak / baseline, time of peak in s after the lead-in) over JAW_SLICE_S slices.

    Pass ~1 s of signal before the cue as lead-in (lead_s): zero-phase filtering a short segment
    creates fake bursts at its edges, so the lead-in and the last slice are filtered but not searched.
    Measured on S01: without the lead-in, imagery trials looked like ~78x baseline; with it, 2-14x
    (clench trials: 97-1206x).
    """
    from eeg.filters import emg_envelope
    lead = int(round(lead_s * fs))
    tail = int(round(config.JAW_SLICE_S * fs))
    if seg.shape[1] < lead + tail + 32 or not baseline_power:
        return float("nan"), float("nan")
    env = emg_envelope(seg, fs, config.JAW_SLICE_S)[lead:seg.shape[1] - tail]
    i = int(np.argmax(env))
    return float(env[i] / baseline_power), i / fs
