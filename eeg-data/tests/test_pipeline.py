import json
import os
import subprocess
import sys

import numpy as np
import pytest

from eeg import config, store
from eeg.evaluate import cv_folds, metrics, pick, split_test
from eeg.filters import FilterBank, filter_recording
from eeg.models import CANDIDATES, make
from eeg.sessions import list_sessions, load_session, make_epochs, new_session_path, window_starts
from tests.conftest import FS, fake_recording

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_labels_and_command_map():
    assert {k: config.LABELS[k] for k in ("left", "right", "rest", "both")} == {"left": 0, "right": 1, "rest": 2, "both": 3}
    assert config.DEFAULT_MODE == "direct"  # D18, docs/direct-select.md
    assert config.HAND_COMMANDS["direct"] == {"left": "PICK_1", "right": "PICK_2"}
    assert config.HAND_COMMANDS["scan"] == {"right": "YES", "left": "NO"}  # docs/brain-mode-test.md
    assert set(config.HANDS) == set(config.HAND_COMMANDS["direct"]) == set(config.HAND_COMMANDS["scan"])
    for mode in config.MODES:
        assert set(config.MODE_COMMANDS[mode]) <= set(config.COMMANDS)
    assert set(config.CUES) == set(config.LABELS)
    assert config.CHANNELS.index("C3") != config.CHANNELS.index("C4")


def test_chunked_filtering_equals_whole_recording():
    x = np.random.default_rng(0).normal(size=(8, 3000))
    whole = filter_recording(x, FS)
    bank, parts, i = FilterBank(FS), {b: [] for b in config.BANDS}, 0
    for size in [1, 9, 250, 4, 700] * 20:
        if i >= x.shape[1]:
            break
        for b, y in bank(x[:, i:i + size]).items():
            parts[b].append(y)
        i += size
    for b in config.BANDS:
        np.testing.assert_allclose(np.concatenate(parts[b], axis=1), whole[b], atol=1e-9)


def test_recording_roundtrip_and_no_overwrite(tmp_path):
    p1 = fake_recording(tmp_path, per_class=3)
    p2 = fake_recording(tmp_path, per_class=3)  # same stamp -> next number
    assert "ses-01" in p1 and "ses-02" in p2 and list_sessions(str(tmp_path)) == [p1, p2]
    s = load_session(p1)
    assert s["raw_eeg"].shape == (8, s["timestamps"].size) and set(s["labels"]) == {"left", "right", "rest"}
    with pytest.raises(FileExistsError):
        from eeg.sessions import save_session
        save_session(p1, s["raw_eeg"], s["timestamps"], FS, FS, [], {})
    with pytest.raises(ValueError):
        new_session_path(str(tmp_path), "../x", "s")


def test_copied_recordings_still_load():
    paths = list_sessions(os.path.join(HERE, "data", "sessions"))
    if not paths:
        pytest.skip("no copied recordings on this machine")
    s = load_session(paths[0])
    assert [str(c) for c in s["channels"]] == config.CHANNELS


def test_windows_never_cross_trials(tmp_path):
    ep = make_epochs([load_session(fake_recording(tmp_path, per_class=5))], ["left", "right", "rest"])
    assert window_starts(3.0, 2.0) == [0.5, 1.0]
    assert ep.X["8-30"].shape == (15 * 2, 8, int(2.0 * FS))
    for tr, va in cv_folds(ep)[0]:
        assert not set(ep.trial[tr]) & set(ep.trial[va])


def test_clench_windows_contain_the_spike(tmp_path):
    ep = make_epochs([load_session(fake_recording(tmp_path, classes=("left", "clench"), per_class=3))],
                     ["left", "clench"])
    assert set(ep.offset[ep.y == config.LABELS["clench"]]) == {0.5}   # spike at 0.6 s is inside 0.5-2.5 s only
    assert set(ep.offset[ep.y == config.LABELS["left"]]) == {0.5, 1.0}


def test_newest_big_session_is_the_test_set(recordings):
    _, paths = recordings
    ep = make_epochs([load_session(p) for p in paths], ["left", "right", "rest"])
    mask, desc = split_test(ep)  # 8 per class < 10 -> falls back to 20% of trials
    assert "20%" in desc and 0 < mask.mean() < 0.5


@pytest.mark.parametrize("name", ["majority"] + CANDIDATES)
def test_models_learn_synthetic_lateralisation(tmp_path, name):
    ep = make_epochs([load_session(fake_recording(tmp_path, per_class=10))], ["left", "right", "rest"])
    tr, va = cv_folds(ep)[0][0]
    m = make(name).fit(ep.take(tr).X, ep.y[tr])
    p = m.proba(ep.take(va).X)
    np.testing.assert_allclose(p.sum(1), 1, atol=1e-6)
    if name != "majority":
        assert (m.classes_[p.argmax(1)] == ep.y[va]).mean() > 0.6


def test_metrics_and_choice():
    y = np.array([0, 0, 1, 1, 2, 2])
    p = np.array([[.9, .05, .05], [.2, .7, .1], [.1, .8, .1], [.6, .3, .1], [.1, .1, .8], [.7, .2, .1]])
    m = metrics(y, p, [0, 1, 2])
    assert m["correct"] == 3 and m["hand_swaps"] == 2 and m["rest_read_as_command"] == 0.5
    assert pick({"fbcsp_lda": (.70, .03), "riemann_lr": (.72, .02)}, CANDIDATES) == "fbcsp_lda"
    assert pick({"fbcsp_lda": (.60, .03), "riemann_lr": (.72, .02)}, CANDIDATES) == "riemann_lr"


def test_train_cli_saves_a_loadable_model(recordings, tmp_path):
    root, _ = recordings
    out = tmp_path / "models"
    r = subprocess.run([sys.executable, "train.py", "--data", str(root), "--models", str(out)], cwd=HERE,
                       capture_output=True, text=True, env=dict(os.environ, PYTHONIOENCODING="utf-8"))
    assert r.returncode == 0, r.stdout + r.stderr
    model, meta, folder = store.load(str(out))
    assert meta["classes"] == ["left", "right", "rest"] and meta["window_s"] == 2.0
    assert json.load(open(os.path.join(folder, "report.json")))["chosen"] in CANDIDATES


def test_store_refuses_a_different_montage(tmp_path, recordings):
    _, paths = recordings
    ep = make_epochs([load_session(paths[0])], ["left", "right"])
    folder = store.save(str(tmp_path), make("riemann_lr").fit(ep.X, ep.y),
                        {"classes": ["left", "right"], "fs": FS, "window_s": 2.0}, {})
    meta_path = os.path.join(folder, "meta.json")
    meta = json.load(open(meta_path))
    meta["channels"] = meta["channels"][::-1]
    json.dump(meta, open(meta_path, "w"))
    with pytest.raises(ValueError, match="channels"):
        store.load(folder)
