"""Causal band-pass filters that keep their state between chunks.

Training filters each continuous recording with the same object the live decoder uses,
so a feature computed offline equals the feature computed live.
"""
from typing import Dict, Tuple

import numpy as np
from scipy.signal import butter, sosfilt, sosfilt_zi, sosfiltfilt

from eeg import config


def bandpass(low: float, high: float, fs: float, order: int = config.FILTER_ORDER) -> np.ndarray:
    nyq = fs / 2.0
    return butter(order, [max(low, 1e-3) / nyq, min(high, 0.99 * nyq) / nyq], btype="bandpass", output="sos")


class FilterBank:
    """Filters (n_ch, k) chunks into several bands; splitting a signal into chunks never changes the output."""

    def __init__(self, fs: float, n_ch: int = len(config.CHANNELS), bands: Dict[str, Tuple[float, float]] = None):
        self.fs, self.n_ch = float(fs), n_ch
        self.sos = {name: bandpass(lo, hi, fs) for name, (lo, hi) in (bands or config.BANDS).items()}
        self.state = None

    def __call__(self, chunk: np.ndarray) -> Dict[str, np.ndarray]:
        chunk = np.asarray(chunk, dtype=float)
        if chunk.shape[0] != self.n_ch:
            raise ValueError(f"expected {self.n_ch} channels, got {chunk.shape[0]}")
        if chunk.shape[1] == 0:
            return {name: np.empty((self.n_ch, 0)) for name in self.sos}
        if self.state is None:  # start from the first sample's level: no big step transient
            self.state = {name: np.stack([sosfilt_zi(s) * chunk[c, 0] for c in range(self.n_ch)], axis=1)
                          for name, s in self.sos.items()}
        out = {}
        for name, s in self.sos.items():
            out[name], self.state[name] = sosfilt(s, chunk, axis=1, zi=self.state[name])
        return out


def filter_recording(raw: np.ndarray, fs: float, bands=None) -> Dict[str, np.ndarray]:
    """Whole recording, causally - exactly what the live decoder would have produced."""
    return FilterBank(fs, raw.shape[0], bands)(raw)


def emg_envelope(seg: np.ndarray, fs: float, smooth_s: float) -> np.ndarray:
    """Zero-phase jaw-muscle power over time, averaged over channels (for offline checks of a recording)."""
    x = seg - seg.mean(axis=1, keepdims=True)
    p = np.mean(sosfiltfilt(bandpass(*config.EMG_BAND, fs), x, axis=1) ** 2, axis=0)
    w = max(1, int(round(smooth_s * fs)))
    return np.convolve(p, np.ones(w) / w, mode="same")
