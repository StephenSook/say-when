"""Session recordings: one .npz per sitting with the continuous raw EEG and a marker per cue.

Trials are cut out only at training time, after the whole recording has been filtered causally,
so window length and filters can change without recording again.
"""
import glob
import json
import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Sequence

import numpy as np

from eeg import config
from eeg.filters import filter_recording

# A trial is unusable when the recorder flagged one of these (muscle during imagery is NOT one of them).
UNUSABLE = ("incomplete", "too few samples", "large spike", "flat channel", "clench not detected")


# ---------------------------------------------------------------- files
def new_session_path(root: str, subject: str, stamp: str) -> str:
    """<root>/<subject>/<subject>_ses-NN_<stamp>.npz, NN one above the highest existing number."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", subject):
        raise ValueError("subject may only contain letters, digits, '-' and '_'")
    folder = os.path.join(root, subject)
    os.makedirs(folder, exist_ok=True)
    taken = [int(m.group(1)) for f in os.listdir(folder) if (m := re.match(rf"{re.escape(subject)}_ses-(\d+)_", f))]
    return os.path.join(folder, f"{subject}_ses-{max(taken, default=0) + 1:02d}_{stamp}.npz")


def list_sessions(root: str, subject: str = None) -> List[str]:
    paths = glob.glob(os.path.join(root, subject or "*", "*_ses-*.npz"))
    return sorted(paths, key=lambda p: os.path.basename(p).split("_")[-2:])  # recording time, not name


def save_session(path: str, raw: np.ndarray, timestamps: np.ndarray, fs: float, fs_declared: float,
                 trials: List[dict], meta: dict) -> str:
    """Write a recording. Never overwrites: the file is opened in exclusive-create mode."""
    raw = np.asarray(raw, dtype=np.float32)
    timestamps = np.asarray(timestamps, dtype=np.float64)
    if raw.shape != (len(config.CHANNELS), timestamps.size):
        raise ValueError(f"raw {raw.shape} does not match {len(config.CHANNELS)} channels x {timestamps.size} samples")
    col = lambda key, default, dtype: np.array([t.get(key, default) for t in trials], dtype=dtype)  # noqa: E731
    cue, end = col("cue_time", 0.0, np.float64), col("end_time", 0.0, np.float64)
    labels = col("label", "", "U8")
    with open(path, "xb") as fh:
        np.savez(fh, format=config.SESSION_FORMAT, task=meta.get("task", "motor_imagery"),
                 channels=np.array(config.CHANNELS), raw_eeg=raw, timestamps=timestamps,
                 sr_ts=np.float32(fs), sr_decl=np.float32(fs_declared),
                 labels=labels, class_types=np.array([config.LABELS[l] for l in labels], dtype=np.int32),
                 cue_time=cue, end_time=end,
                 cue_sample=np.searchsorted(timestamps, cue).astype(np.int64),
                 end_sample=np.searchsorted(timestamps, end).astype(np.int64),
                 trial_index=col("trial", 0, np.int32), run_index=col("run", 0, np.int32),
                 online_emg_warning=col("muscle", False, bool),
                 online_bad_reason=np.array(["; ".join(t.get("problems", [])) for t in trials], dtype=str),
                 online_strength=col("strength", "", str),
                 clench_peak_sec=col("clench_peak_s", np.nan, np.float64),
                 metadata_json=json.dumps(dict(meta, format=config.SESSION_FORMAT, channels=config.CHANNELS)))
    return path


def load_session(path: str) -> dict:
    with np.load(path, allow_pickle=False) as f:
        s = {k: f[k] for k in f.files}
    if str(s.get("format", "")) != config.SESSION_FORMAT:
        raise ValueError(f"{path}: not a {config.SESSION_FORMAT} recording")
    if [str(c) for c in s["channels"]] != config.CHANNELS:
        raise ValueError(f"{path}: channel order {list(s['channels'])} differs from {config.CHANNELS}")
    n = len(s["labels"])
    s.setdefault("online_bad_reason", np.array([""] * n))  # recordings made before these columns existed
    s.setdefault("clench_peak_sec", np.full(n, np.nan))
    s["meta"] = json.loads(str(s["metadata_json"]))
    s["name"] = os.path.splitext(os.path.basename(path))[0]
    return s


# ---------------------------------------------------------------- trials -> windows
@dataclass
class Epochs:
    X: Dict[str, np.ndarray]     # band -> (n_windows, n_ch, n_samples)
    y: np.ndarray                # label codes
    trial: np.ndarray            # trial id (grouping key: windows of one trial never split train/test)
    session: np.ndarray
    offset: np.ndarray           # window start, seconds after the cue
    fs: float
    window_s: float
    info: dict = field(default_factory=dict)

    def take(self, idx) -> "Epochs":
        idx = np.flatnonzero(idx) if np.asarray(idx).dtype == bool else np.asarray(idx)
        return Epochs({b: a[idx] for b, a in self.X.items()}, self.y[idx], self.trial[idx], self.session[idx],
                      self.offset[idx], self.fs, self.window_s, dict(self.info))

    @property
    def n_trials(self) -> int:
        return len(np.unique(self.trial))


def window_starts(cue_s: float, window_s: float) -> List[float]:
    starts, t = [], config.CROP_START_S
    while t + window_s <= cue_s + 1e-9:
        starts.append(round(t, 6))
        t += config.CROP_STEP_S
    if not starts:
        raise ValueError(f"a {window_s} s window does not fit a {cue_s} s cue")
    return starts


def make_epochs(sessions: Sequence[dict], classes: Sequence[str], window_s: float = config.WINDOW_S) -> Epochs:
    """Filter each recording causally, then cut every usable trial of `classes` into windows."""
    fs_ref = float(np.median([float(s["sr_ts"]) for s in sessions]))
    for s in sessions:
        if abs(float(s["sr_ts"]) - fs_ref) / fs_ref > 0.02:
            raise ValueError(f"{s['name']}: sampling rate differs >2% from {fs_ref:.2f} Hz")
    n_win = int(round(window_s * fs_ref))
    wanted = {config.LABELS[c] for c in classes}
    jaw_codes = {config.LABELS[c] for c in config.JAW}
    X = {b: [] for b in config.BANDS}
    y, trial, sess, off = [], [], [], []
    dropped = {"flagged": 0, "spike": 0, "truncated": 0}
    for s in sessions:
        fs = float(s["sr_ts"])
        filt = filter_recording(s["raw_eeg"].astype(float), fs)
        cue_s = float(s["meta"].get("imagery_sec", config.CUE_S))
        for i, code in enumerate(s["class_types"].astype(int)):
            if code not in wanted:
                continue
            c0, c1 = int(s["cue_sample"][i]), int(s["end_sample"][i])
            if any(k in str(s["online_bad_reason"][i]) for k in UNUSABLE):
                dropped["flagged"] += 1
                continue
            if code not in jaw_codes and np.ptp(filt[config.COV_BAND][:, c0:c1], axis=1).max() > config.SPIKE_UV:
                dropped["spike"] += 1
                continue
            starts = window_starts(cue_s, window_s)
            peak = float(s["clench_peak_sec"][i])
            if code in jaw_codes and np.isfinite(peak):  # a clench can be brief: keep windows that contain it
                starts = [t for t in starts if t <= peak <= t + window_s] or \
                         [round(min(max(peak - window_s / 2, 0.0), cue_s - window_s), 6)]
            kept = 0
            for t in starts:
                a = c0 + int(round(t * fs))
                if a + n_win > min(filt[config.COV_BAND].shape[1], c1 + int(0.05 * fs)):
                    continue
                for b in config.BANDS:
                    X[b].append(filt[b][:, a:a + n_win])
                y.append(code)
                trial.append(f"{s['name']}#{int(s['trial_index'][i])}")
                sess.append(s["name"])
                off.append(t)
                kept += 1
            dropped["truncated"] += kept == 0
    if not y:
        raise ValueError("no usable trials for " + ", ".join(classes))
    return Epochs({b: np.stack(v) for b, v in X.items()}, np.array(y), np.array(trial), np.array(sess),
                  np.array(off), fs_ref, float(window_s), {"dropped_trials": dropped})


def names(codes) -> List[str]:
    return [config.LABEL_OF[int(c)] for c in codes]
