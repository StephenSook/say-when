"""Trained models on disk: models/<timestamp>/{model.joblib, meta.json, report.json} + models/LATEST.

Loading checks the montage, bands and format, so the live decoder can never silently run a model
that computes different features than it does.
"""
import json
import os
import time

import joblib

from eeg import config


def save(root: str, model, meta: dict, report: dict) -> str:
    stamp = time.strftime("%Y%m%d_%H%M%S")
    folder = os.path.join(root, stamp)
    os.makedirs(folder)
    meta = dict(meta, format=config.MODEL_FORMAT, model_id=stamp, channels=config.CHANNELS,
                bands={k: list(v) for k, v in config.BANDS.items()})
    joblib.dump(model, os.path.join(folder, "model.joblib"))
    for name, obj in (("meta.json", meta), ("report.json", report)):
        with open(os.path.join(folder, name), "w") as f:
            json.dump(obj, f, indent=2)
    with open(os.path.join(root, "LATEST"), "w") as f:
        f.write(stamp)
    return folder


def load(path: str):
    """Accepts a model folder or the models root (then LATEST is used). Returns (model, meta, folder)."""
    if not os.path.exists(os.path.join(path, "meta.json")):
        latest = os.path.join(path, "LATEST")
        if not os.path.exists(latest):
            raise FileNotFoundError(f"no trained model in {path} - run train.py first")
        with open(latest) as f:
            path = os.path.join(path, f.read().strip())
    with open(os.path.join(path, "meta.json")) as f:
        meta = json.load(f)
    problems = []
    if meta.get("format") != config.MODEL_FORMAT:
        problems.append(f"format {meta.get('format')!r}")
    if meta.get("channels") != config.CHANNELS:
        problems.append(f"channels {meta.get('channels')}")
    if meta.get("bands") != {k: list(v) for k, v in config.BANDS.items()}:
        problems.append("filter bands")
    if problems:
        raise ValueError(f"{path} does not match this code: " + ", ".join(problems))
    return joblib.load(os.path.join(path, "model.joblib")), meta, path
