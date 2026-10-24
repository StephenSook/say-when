"""Classifiers for imagined left / right / rest.

Each model fits ALL of its learned transforms (spatial filters, Riemannian reference, scalers)
inside fit(), so evaluation can treat it as one black box trained on training data only.
The earlier stacked ensemble and MRCP features were dropped: on this wearer's data they never
beat the simpler models on held-out trials.
"""
from typing import Dict

import mne
import numpy as np
from mne.decoding import CSP
from sklearn.covariance import LedoitWolf
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from eeg import config

mne.set_log_level("ERROR")
Bands = Dict[str, np.ndarray]


class Model:
    name = "model"
    classes_: np.ndarray

    def fit(self, X: Bands, y: np.ndarray) -> "Model":
        raise NotImplementedError

    def proba(self, X: Bands) -> np.ndarray:
        raise NotImplementedError

    def predict(self, X: Bands) -> np.ndarray:
        return self.classes_[self.proba(X).argmax(axis=1)]


class Majority(Model):
    """Reference only: always answers with the training class frequencies."""
    name = "majority"

    def fit(self, X, y):
        self.classes_, n = np.unique(y, return_counts=True)
        self.prior_ = n / n.sum()
        return self

    def proba(self, X):
        return np.tile(self.prior_, (len(next(iter(X.values()))), 1))


class FilterBankCSP(Model):
    """Per band, one-vs-rest CSP spatial filters -> log band power -> shrinkage LDA."""
    name = "fbcsp_lda"

    def __init__(self, bands=tuple(config.FBCSP_BANDS), n_filters: int = 4):
        self.bands, self.n_filters = list(bands), n_filters

    def _targets(self):  # two classes need one binary CSP; more need one per class
        return self.classes_[:1] if len(self.classes_) == 2 else self.classes_

    def _features(self, X):
        return np.hstack([self.csp_[b, c].transform(X[b]) for b in self.bands for c in self._targets()])

    def fit(self, X, y):
        self.classes_ = np.unique(y)
        self.csp_ = {}
        for b in self.bands:
            for c in self._targets():
                self.csp_[b, c] = CSP(n_components=self.n_filters, reg="ledoit_wolf", log=True,
                                      transform_into="average_power", component_order="alternate"
                                      ).fit(X[b], (y == c).astype(int))
        self.clf_ = make_pipeline(StandardScaler(), LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto"))
        self.clf_.fit(self._features(X), y)
        return self

    def proba(self, X):
        return self.clf_.predict_proba(self._features(X))


# ---- symmetric positive definite helpers for the Riemannian model
def _eig_fn(C, fn):
    w, V = np.linalg.eigh(C)
    return (V * fn(np.clip(w, 1e-12, None))) @ V.T


def covariance(x: np.ndarray) -> np.ndarray:
    """Shrunk (Ledoit-Wolf) channel covariance of one window (n_ch, n_samples)."""
    c = LedoitWolf().fit(x.T).covariance_
    return (c + c.T) / 2


def riemann_mean(covs, iters: int = 8) -> np.ndarray:
    """Affine-invariant (geometric) mean of covariance matrices."""
    G = np.mean(covs, axis=0)
    for _ in range(iters):
        g_half, g_ihalf = _eig_fn(G, np.sqrt), _eig_fn(G, lambda w: 1 / np.sqrt(w))
        step = np.mean([_eig_fn(g_ihalf @ C @ g_ihalf, np.log) for C in covs], axis=0)
        G = g_half @ _eig_fn(step, np.exp) @ g_half
        G = (G + G.T) / 2
    return G


class TangentSpace(Model):
    """Covariances projected to the tangent space at the training mean -> logistic regression."""
    name = "riemann_lr"

    def __init__(self, band: str = config.COV_BAND, C: float = 1.0):
        self.band, self.C = band, C

    def _features(self, X):
        n = self.ref_.shape[0]
        iu = np.triu_indices(n)
        weight = np.where(iu[0] == iu[1], 1.0, np.sqrt(2.0))  # keeps the vector norm equal to the matrix norm
        return np.array([_eig_fn(self.ref_ @ covariance(x) @ self.ref_, np.log)[iu] * weight for x in X[self.band]])

    def fit(self, X, y):
        self.classes_ = np.unique(y)
        self.mean_ = riemann_mean([covariance(x) for x in X[self.band]])
        self.ref_ = _eig_fn(self.mean_, lambda w: 1 / np.sqrt(w))
        self.clf_ = make_pipeline(StandardScaler(), LogisticRegression(C=self.C, max_iter=5000,
                                                                       class_weight="balanced"))
        self.clf_.fit(self._features(X), y)
        return self

    def proba(self, X):
        return self.clf_.predict_proba(self._features(X))


CANDIDATES = ["fbcsp_lda", "riemann_lr"]  # simplest first: selection prefers earlier ones on ties


def make(name: str) -> Model:
    return {"majority": Majority, "fbcsp_lda": FilterBankCSP, "riemann_lr": TangentSpace}[name]()


def aligned(p: np.ndarray, have, want) -> np.ndarray:
    """Re-order probability columns from `have` classes to `want` classes (missing ones get 0)."""
    out = np.zeros((p.shape[0], len(want)))
    for j, c in enumerate(have):
        out[:, list(want).index(c)] = p[:, j]
    return out
