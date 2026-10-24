"""Honest evaluation: the windows of one trial never land on both sides of a split,
a final test set is put aside before anything is chosen, and every number says how many trials it rests on.
"""
from typing import Dict, List, Sequence, Tuple

import numpy as np
from scipy.stats import binomtest
from sklearn.metrics import balanced_accuracy_score, confusion_matrix, precision_recall_fscore_support
from sklearn.model_selection import StratifiedGroupKFold

from eeg import config
from eeg.models import aligned, make
from eeg.sessions import Epochs, names

MIN_PER_CLASS = 5        # a session needs this many trials per class to be its own CV fold
MIN_TEST_PER_CLASS = 10  # ...and this many to be the held-out test session


def _trials_per_class(ep: Epochs, mask=None) -> Dict[int, int]:
    m = np.ones(len(ep.y), bool) if mask is None else mask
    per_trial = dict(zip(ep.trial[m], ep.y[m]))
    return {c: sum(v == c for v in per_trial.values()) for c in np.unique(ep.y)}


def _grouped_folds(ep: Epochs, k: int, seed: int):
    k = int(min(k, min(_trials_per_class(ep).values())))
    if k < 2:
        raise ValueError("need at least 2 trials per class")
    return list(StratifiedGroupKFold(n_splits=k, shuffle=True, random_state=seed).split(ep.y, ep.y, ep.trial))


def split_test(ep: Epochs, seed: int = 0) -> Tuple[np.ndarray, str]:
    """Test mask: the newest session if it is big enough (a cross-session test), else ~20% of trials."""
    newest = list(dict.fromkeys(ep.session))[-1]
    test = ep.session == newest
    if len(set(ep.session)) > 1 and min(_trials_per_class(ep, test).values()) >= MIN_TEST_PER_CLASS \
            and min(_trials_per_class(ep, ~test).values()) >= MIN_PER_CLASS:
        return test, f"newest session {newest}"
    _, te = _grouped_folds(ep, 5, seed)[0]
    test = np.zeros(len(ep.y), bool)
    test[te] = True
    return test, "about 20% of trials, grouped by trial"


def cv_folds(ep: Epochs, seed: int = 0) -> Tuple[list, str]:
    sessions = list(dict.fromkeys(ep.session))
    if len(sessions) > 1 and all(min(_trials_per_class(ep, ep.session == s).values()) >= MIN_PER_CLASS
                                 for s in sessions):
        return [(np.flatnonzero(ep.session != s), np.flatnonzero(ep.session == s)) for s in sessions], \
            f"leave-one-session-out ({len(sessions)} sessions)"
    folds = _grouped_folds(ep, 5, seed)
    return folds, f"{len(folds)}-fold, grouped by trial"


def per_trial(ep: Epochs, p: np.ndarray):
    """A trial's probability = mean over its windows."""
    ids = list(dict.fromkeys(ep.trial))
    return np.array([ep.y[ep.trial == t][0] for t in ids]), np.array([p[ep.trial == t].mean(0) for t in ids])


def metrics(y: np.ndarray, p: np.ndarray, classes: Sequence[int], confident: float = 0.6) -> dict:
    classes = np.asarray(classes)
    pred = classes[p.argmax(axis=1)]
    sure = p.max(axis=1) >= confident
    prec, rec, _, sup = precision_recall_fscore_support(y, pred, labels=classes, zero_division=0)
    n_ok = int((pred == y).sum())
    majority = np.bincount(np.searchsorted(classes, y), minlength=len(classes)).max() / len(y)
    out = {
        "n": int(len(y)),
        "correct": n_ok,
        "accuracy": n_ok / len(y),
        "balanced_accuracy": float(balanced_accuracy_score(y, pred)),
        "chance": 1 / len(classes),
        "per_class": {c: {"right": int(round(r * s)), "of": int(s), "recall": float(r), "precision": float(pr)}
                      for c, r, pr, s in zip(names(classes), rec, prec, sup)},
        "confusion": {"labels": names(classes), "rows_true": confusion_matrix(y, pred, labels=classes).tolist()},
        "unsure_fraction": float(1 - sure.mean()),
        "p_vs_majority": float(binomtest(n_ok, len(y), majority, alternative="greater").pvalue),
    }
    rest = config.LABELS["rest"]
    if rest in classes and (y == rest).any():
        out["rest_read_as_command"] = float(((pred != rest) & sure)[y == rest].mean())
    left, right = config.LABELS["left"], config.LABELS["right"]
    hands = np.isin(y, [left, right])
    if hands.any():  # the costly mistake: YES read as NO or the reverse
        out["hand_swaps"] = int((((y == left) & (pred == right)) | ((y == right) & (pred == left)))[hands].sum())
    return out


def cross_validate(name: str, ep: Epochs, folds, classes) -> np.ndarray:
    oof = np.zeros((len(ep.y), len(classes)))
    for tr, va in folds:
        m = make(name).fit(ep.take(tr).X, ep.y[tr])
        oof[va] = aligned(m.proba(ep.take(va).X), m.classes_, classes)
    return oof


def pick(scores: Dict[str, Tuple[float, float]], order: List[str]) -> str:
    """Simplest model whose CV score is within one standard error of the best."""
    best = max(order, key=lambda n: scores[n][0])
    return next(n for n in order if scores[n][0] >= scores[best][0] - scores[best][1])
