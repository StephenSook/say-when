"""Live brain view: connect the headset and watch your hand areas light up.

  python brain_view.py           # headset (connects on start)
  python brain_view.py --demo    # fake signals, no headset

The head map shows each electrode's mu/beta power against your own resting level: blue = below rest (that
part of the motor cortex is working), red = above. Imagining your LEFT fist should turn the RIGHT side (C4)
blue, and the right fist the LEFT side (C3). Rings mark electrodes that are off (red) or noisy (orange).
Press "I'm resting" while relaxed to reset the baseline. The side panel shows what the model decides.
"""
import argparse
import math
import os
import sys
import time

import numpy as np
from PyQt5 import QtCore, QtWidgets

from eeg import config, messages, store
from eeg.brainmap import BANDS, BrainState, HeadMap, Legend
from eeg.engine import Engine, Update
from eeg.hands import HandConfig
from eeg.ui import Bar, EngineThread, app

HERE = os.path.dirname(os.path.abspath(__file__))


class DemoEngine:
    """Fake headset: cycles rest -> imagine left -> rest -> imagine right -> jaw clench, 5 s each."""
    PHASES = ["rest", "left", "rest", "right", "clench"]

    def __init__(self, step=0.1):
        self.classes, self.fs, self.step, self.n = ["left", "right", "rest"], 125.0, step, 250
        self.total_samples, self.t0 = 0, None
        self.rng = np.random.default_rng(0)

    def start(self):
        time.sleep(0.5)
        self.t0 = time.time()
        self._sent_phase = None

    def healthy(self):
        return True

    def poll(self):
        time.sleep(self.step)
        el = time.time() - self.t0
        phase = self.PHASES[int(el // 5) % len(self.PHASES)]
        t = np.arange(self.n) / self.fs + el
        amp = np.full(len(config.CHANNELS), 20.0)
        drop = 0.45
        for ch in (("C4", "FC4", "CP4", "C2") if phase == "left" else ("C3", "FC3", "CP3", "C1") if phase == "right" else ()):
            amp[config.CHANNELS.index(ch)] *= drop
        mu = amp[:, None] * np.sin(2 * np.pi * 10 * t) + self.rng.normal(0, 3, (8, self.n))
        beta = 0.4 * amp[:, None] * np.sin(2 * np.pi * 20 * t) + self.rng.normal(0, 2, (8, self.n))
        jaw = 120.0 if phase == "clench" else 1.0
        slow = 4.0 * np.sin(2 * np.pi * 1.0 * t) + self.rng.normal(0, 1, (8, self.n))
        window = {"0.05-5": slow, "8-12": mu, "12-16": beta, "16-20": beta, "20-26": beta, "26-30": 0.6 * beta,
                  config.COV_BAND: mu + beta}
        raw = mu + beta + slow + (jaw / 4.0) * self.rng.normal(0, 1, (8, self.n))
        target = {"rest": [0.1, 0.1, 0.8], "left": [0.8, 0.1, 0.1], "right": [0.1, 0.8, 0.1], "clench": [0.3, 0.3, 0.4]}
        p = np.clip(np.array(target[phase]) + self.rng.normal(0, 0.05, 3), 0.01, None)
        p /= p.sum()
        self.total_samples += int(self.step * self.fs)
        commands = []
        n_phase = int(el // 5)
        if phase in ("left", "right") and el % 5 >= 1.5 and self._sent_phase != n_phase:
            self._sent_phase = n_phase  # one fake command per imagery phase, like the real decoder
            commands.append(messages.gesture("YES" if phase == "right" else "NO", time.time() - 1.0, 0.8,
                                             "imagery"))
        if phase == "clench" and el % 5 >= 1.0 and self._sent_phase != n_phase:
            self._sent_phase = n_phase
            commands.append(messages.gesture("CONFIRM", time.time() - 0.5, 0.9, "jaw"))
        return Update(commands=commands, t=time.time(), proba=dict(zip(self.classes, p)), smoothed=dict(zip(self.classes, p)),
                      status=phase.upper(), jaw_level=jaw * (1 + 0.1 * math.sin(el)), window=window, raw=raw,
                      samples=self.total_samples)

    def stop(self):
        pass


class BrainView(QtWidgets.QWidget):
    def __init__(self, engine, header: str, band: str):
        super().__init__()
        self.engine = engine
        self.state = BrainState(band)
        self.setWindowTitle("Brain view")
        root = QtWidgets.QHBoxLayout(self)
        left = QtWidgets.QVBoxLayout()
        self.title = QtWidgets.QLabel("Connecting to the headset ... sit still")
        self.title.setStyleSheet("font-size: 20px; font-weight: bold;")
        self.map = HeadMap(self.state)
        self.hand = QtWidgets.QLabel("")
        self.hand.setAlignment(QtCore.Qt.AlignCenter)
        self.hand.setStyleSheet("font-size: 18px; font-weight: bold; color: #1e5bd8;")
        for w in (self.title, self.map, Legend(), self.hand):
            left.addWidget(w)
        root.addLayout(left, stretch=3)

        side = QtWidgets.QVBoxLayout()
        info = QtWidgets.QLabel(header)
        info.setWordWrap(True)
        info.setStyleSheet("color: #777;")
        side.addWidget(info)
        row = QtWidgets.QHBoxLayout()
        self.band = QtWidgets.QComboBox()
        self.band.addItems(list(BANDS))
        self.band.setCurrentText(band)
        self.band.currentTextChanged.connect(self.state.set_band)
        rest = QtWidgets.QPushButton("I'm resting - reset baseline")
        rest.clicked.connect(self.state.rest_now)
        row.addWidget(QtWidgets.QLabel("band:"))
        row.addWidget(self.band)
        row.addWidget(rest)
        side.addLayout(row)
        side.addWidget(QtWidgets.QLabel("Model decision"))
        self.bars = {c: Bar(c) for c in engine.classes}
        for b in self.bars.values():
            side.addWidget(b)
        side.addWidget(QtWidgets.QLabel(f"Jaw muscle (clench at {config.JAW_RATIO:.0f}x rest)"))
        self.jaw = Bar("jaw", 1.0, "jaw")
        side.addWidget(self.jaw)
        self.hemi = QtWidgets.QLabel("")
        self.status = QtWidgets.QLabel("")
        self.last = QtWidgets.QLabel("")
        for w in (self.hemi, self.status, self.last):
            w.setWordWrap(True)
            w.setStyleSheet("font-size: 14px;")
            side.addWidget(w)
        side.addStretch(1)
        root.addLayout(side, stretch=2)

        self.thread = EngineThread(engine)
        self.thread.ready.connect(self.on_ready)
        self.thread.update.connect(self.on_update)
        self.thread.failed.connect(lambda e: self.title.setText(f"Headset error: {e}"))
        self.t_start, self.commands = time.time(), []
        self.thread.start()

    def on_ready(self):
        self.map.connected = True
        self.title.setText("Connected - live")
        self.t_start = time.time()

    def on_update(self, up: Update):
        if up.window is not None:
            self.state.update(up.window, self.engine.fs)
            self.map.update()
            left_h, right_h = self.state.hemispheres()
            self.hemi.setText(f"Left hemisphere (right hand): {left_h:+.0f}%\n"
                              f"Right hemisphere (left hand): {right_h:+.0f}%")
            hand = self.state.active_hand()
            self.hand.setText(f"{hand.upper()} hand area active ({'left' if hand == 'right' else 'right'} hemisphere)"
                              if hand else "")
            bad = [c for c, f in zip(config.CHANNELS, self.state.flat) if f]
            noisy = [c for c, n in zip(config.CHANNELS, self.state.noisy) if n]
            self.status.setText(("Electrode off: " + ", ".join(bad) + "\n" if bad else "") +
                                ("Noisy: " + ", ".join(noisy) + "\n" if noisy else "") +
                                f"{up.samples} samples, {up.samples / max(time.time() - self.t_start, 1e-3):.0f}/s")
        for c, b in self.bars.items():
            b.set(up.smoothed.get(c, 0.0))
        self.jaw.set(min(up.jaw_level / config.JAW_RATIO, 1.0), f" ({up.jaw_level:.0f}x)")
        for msg in up.commands:
            self.commands.insert(0, f"{time.strftime('%H:%M:%S')} {msg['command']} ({msg['source']})")
        if self.commands:
            self.last.setText("Commands:\n" + "\n".join(self.commands[:6]))

    def closeEvent(self, e):
        self.thread.stop()
        super().closeEvent(e)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demo", action="store_true", help="fake signals, no headset")
    ap.add_argument("--band", default="mu + beta", choices=list(BANDS))
    ap.add_argument("--models", default=os.path.join(HERE, "models"))
    ap.add_argument("--port", default=config.SERIAL_PORT)
    args = ap.parse_args()
    a = app()
    if args.demo:
        engine, header = DemoEngine(), "DEMO - fake signals cycling rest / left / rest / right / jaw clench, 5 s each"
    else:
        try:
            model, meta, _ = store.load(args.models)
        except (FileNotFoundError, ValueError) as e:
            sys.exit(f"cannot load model: {e}")
        engine = Engine(model, meta, HandConfig(), port=args.port, settle_s=5.0)
        header = f"Headset on {args.port} | model {meta['model_id']} ({', '.join(meta['classes'])})"
    w = BrainView(engine, header, args.band)
    w.resize(1150, 700)
    w.show()
    sys.exit(a.exec_())


if __name__ == "__main__":
    main()
