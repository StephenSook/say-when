"""Live brain map: per-electrode mu/beta power change against the wearer's own resting level, drawn on a head.

Imagining a hand movement lowers mu (8-12 Hz) and beta (16-26 Hz) power over the OPPOSITE hemisphere's hand area
(event-related desynchronisation): left hand -> C4 side, right hand -> C3 side. Blue = power below resting level
(that area is working), red = above. Only the 8 electrodes' neighbourhood is coloured: there is no data elsewhere.
"""
from typing import Dict, Optional

import numpy as np
from PyQt5 import QtCore, QtGui, QtWidgets

from eeg import config

# Top view, x to the right, y to the front; 1.0 = ear level. Azimuthal projection of MNE's standard_1005 positions.
POS = {"FC4": (0.521, 0.198), "C4": (0.515, -0.084), "CP4": (0.465, -0.326), "C2": (0.256, -0.065),
       "C1": (-0.243, -0.067), "CP3": (-0.449, -0.332), "C3": (-0.502, -0.089), "FC3": (-0.511, 0.193)}
LEFT_HEMI = ("C3", "FC3", "CP3", "C1")     # controls the RIGHT hand
RIGHT_HEMI = ("C4", "FC4", "CP4", "C2")    # controls the LEFT hand
BANDS = {"mu": ["8-12"], "beta": ["16-20", "20-26"], "mu + beta": ["8-12", "16-20", "20-26"]}


class BrainState:
    """Turns filtered windows into per-channel % change vs a slowly adapting resting baseline."""

    def __init__(self, band: str = "mu + beta", baseline_s: float = 30.0, smooth: float = 0.3):
        self.band, self.baseline_s, self.smooth = band, baseline_s, smooth
        self.power: Optional[np.ndarray] = None
        self.baseline: Optional[np.ndarray] = None
        self.change = np.zeros(len(config.CHANNELS))
        self.flat = np.zeros(len(config.CHANNELS), bool)
        self.noisy = np.zeros(len(config.CHANNELS), bool)
        self._collect = None  # samples gathered for a manual "this is my rest" baseline

    def set_band(self, band: str):
        self.band, self.power, self.baseline = band, None, None

    def rest_now(self):
        """Use the next few updates as the resting baseline."""
        self._collect = []

    def update(self, window: Dict[str, np.ndarray], fs: float, dt: float = 0.1):
        n = max(1, int(fs))  # last second
        p = np.mean([np.mean(window[b][:, -n:] ** 2, axis=1) for b in BANDS[self.band]], axis=0) + 1e-9
        self.power = p if self.power is None else self.power + self.smooth * (p - self.power)
        if self._collect is not None:
            self._collect.append(p)
            if len(self._collect) >= int(3 / dt):
                self.baseline, self._collect = np.median(self._collect, axis=0), None
        elif self.baseline is None:
            self.baseline = self.power.copy()
        else:  # slow drift tracking, only for electrodes near rest, so activity does not become the new normal
            near_rest = np.abs(100 * (self.power / self.baseline - 1)) < 15
            self.baseline += near_rest * min(1.0, dt / self.baseline_s) * (self.power - self.baseline)
        self.change = 100 * (self.power / self.baseline - 1)
        b = window[config.COV_BAND]
        self.flat = b.std(axis=1) < config.FLAT_UV
        self.noisy = np.ptp(b, axis=1) > config.SPIKE_UV

    def hemispheres(self):
        """(left-hemisphere change, right-hemisphere change) averaged over good electrodes."""
        def avg(chs):
            idx = [config.CHANNELS.index(c) for c in chs if not self.flat[config.CHANNELS.index(c)]]
            return float(np.mean(self.change[idx])) if idx else 0.0
        return avg(LEFT_HEMI), avg(RIGHT_HEMI)

    def active_hand(self, drop: float = -20.0, gap: float = 10.0) -> Optional[str]:
        """'right' if the left hand area dropped clearly more than the right, 'left' for the reverse."""
        left_h, right_h = self.hemispheres()
        if left_h <= drop and left_h < right_h - gap:
            return "right"
        if right_h <= drop and right_h < left_h - gap:
            return "left"
        return None


def diverging(v: float, span: float = 50.0) -> QtGui.QColor:
    """-span (blue) .. 0 (white) .. +span (red)."""
    t = max(-1.0, min(1.0, v / span))
    if t < 0:
        return QtGui.QColor(int(255 * (1 + t)), int(255 * (1 + 0.55 * t)), 255)
    return QtGui.QColor(255, int(255 * (1 - 0.8 * t)), int(255 * (1 - t)))


class HeadMap(QtWidgets.QWidget):
    GRID = 90

    def __init__(self, state: BrainState):
        super().__init__()
        self.state = state
        self.setMinimumSize(460, 460)
        self.connected = False
        g = np.linspace(-1, 1, self.GRID)
        self.gx, self.gy = np.meshgrid(g, -g)
        pts = np.array([POS[c] for c in config.CHANNELS])
        d = np.sqrt((self.gx[..., None] - pts[:, 0]) ** 2 + (self.gy[..., None] - pts[:, 1]) ** 2) + 1e-3
        self.weights = (1 / d ** 2) / (1 / d ** 2).sum(axis=-1, keepdims=True)    # inverse-distance interpolation
        self.alpha = np.clip(1 - (d.min(axis=-1) - 0.12) / 0.25, 0, 1)           # fade away from the electrodes
        self.inside = self.gx ** 2 + self.gy ** 2 <= 1

    def _image(self) -> QtGui.QImage:
        """Whole map in one go: interpolated change -> diverging colours -> RGBA image."""
        t = np.clip((self.weights @ np.where(self.state.flat, 0.0, self.state.change)) / 50.0, -1, 1)
        neg = t < 0
        rgba = np.empty(t.shape + (4,), np.uint8)
        rgba[..., 0] = np.where(neg, 255 * (1 + t), 255)
        rgba[..., 1] = np.where(neg, 255 * (1 + 0.55 * t), 255 * (1 - 0.8 * t))
        rgba[..., 2] = np.where(neg, 255, 255 * (1 - t))
        rgba[..., 3] = (230 * self.alpha * self.inside).astype(np.uint8)
        self._buf = np.ascontiguousarray(rgba)  # QImage does not copy: keep the buffer alive
        return QtGui.QImage(self._buf.data, self.GRID, self.GRID, 4 * self.GRID, QtGui.QImage.Format_RGBA8888)

    def paintEvent(self, _):
        p = QtGui.QPainter(self)
        p.setRenderHint(QtGui.QPainter.Antialiasing)
        side = min(self.width(), self.height()) - 40
        R = side / 2 * 0.86
        cx, cy = self.width() / 2, self.height() / 2 + 10
        to_px = lambda x, y: QtCore.QPointF(cx + x * R, cy - y * R)  # noqa: E731
        # head, nose, ears
        p.setPen(QtGui.QPen(QtGui.QColor(70, 70, 70), 3))
        p.setBrush(QtGui.QColor(250, 247, 242))
        p.drawEllipse(QtCore.QPointF(cx, cy), R, R)
        p.drawPolyline(QtGui.QPolygonF([to_px(-0.12, 0.99), to_px(0, 1.13), to_px(0.12, 0.99)]))
        for s in (-1, 1):
            p.drawArc(QtCore.QRectF(cx + s * R - 12, cy - 28, 24, 56), (90 if s < 0 else -90) * 16, 180 * 16)
        if self.connected:
            p.drawImage(QtCore.QRectF(cx - R, cy - R, 2 * R, 2 * R), self._image())
            hand = self.state.active_hand()
            if hand:  # glow over the active hand area (opposite hemisphere)
                cxh = -0.43 if hand == "right" else 0.43
                glow = QtGui.QRadialGradient(to_px(cxh, -0.05), R * 0.38)
                glow.setColorAt(0, QtGui.QColor(30, 110, 255, 120))
                glow.setColorAt(1, QtGui.QColor(30, 110, 255, 0))
                p.setPen(QtCore.Qt.NoPen)
                p.setBrush(glow)
                p.drawEllipse(to_px(cxh, -0.05), R * 0.38, R * 0.38)
        # midline + labels
        p.setPen(QtGui.QPen(QtGui.QColor(160, 160, 160), 1, QtCore.Qt.DashLine))
        p.drawLine(to_px(0, 1), to_px(0, -1))
        f = p.font()
        f.setPointSize(9)
        p.setFont(f)
        p.setPen(QtGui.QColor(110, 110, 110))
        p.drawText(to_px(-1.0, 1.12), "LEFT hemisphere (right hand)")
        p.drawText(to_px(0.42, 1.12), "RIGHT hemisphere (left hand)")
        p.drawText(to_px(-0.09, 1.2), "front")
        # electrodes
        for k, ch in enumerate(config.CHANNELS):
            pt = to_px(*POS[ch])
            flat, noisy = self.state.flat[k], self.state.noisy[k]
            ring = QtGui.QColor(220, 40, 40) if flat else QtGui.QColor(240, 150, 0) if noisy else QtGui.QColor(40, 40, 40)
            p.setPen(QtGui.QPen(ring, 3 if (flat or noisy) else 1.5))
            p.setBrush(diverging(self.state.change[k]) if self.connected and not flat else QtGui.QColor(225, 225, 225))
            p.drawEllipse(pt, 15, 15)
            f.setPointSize(8)
            f.setBold(True)
            p.setFont(f)
            p.setPen(QtGui.QColor(20, 20, 20))
            p.drawText(QtCore.QRectF(pt.x() - 20, pt.y() - 9, 40, 18), QtCore.Qt.AlignCenter, ch)
            f.setBold(False)
            p.setFont(f)
            note = "OFF" if flat else ("noisy" if noisy else f"{self.state.change[k]:+.0f}%") if self.connected else ""
            p.drawText(QtCore.QRectF(pt.x() - 30, pt.y() + 15, 60, 16), QtCore.Qt.AlignCenter, note)
        p.end()


class Legend(QtWidgets.QWidget):
    def __init__(self):
        super().__init__()
        self.setFixedHeight(42)

    def paintEvent(self, _):
        p = QtGui.QPainter(self)
        w = self.width() - 40
        for i in range(w):
            p.setPen(diverging(-50 + 100 * i / w))
            p.drawLine(20 + i, 4, 20 + i, 18)
        p.setPen(QtGui.QColor(60, 60, 60))
        p.drawText(QtCore.QRectF(20, 20, w, 18), QtCore.Qt.AlignLeft, "-50%  power drop (area working)")
        p.drawText(QtCore.QRectF(20, 20, w, 18), QtCore.Qt.AlignCenter, "resting level")
        p.drawText(QtCore.QRectF(20, 20, w, 18), QtCore.Qt.AlignRight, "+50%  power rise")
        p.end()
