"""Live decoder: headset -> YES / NO / CONFIRM / STOP / HEADSET_OFF messages.

  python live.py                 # headless: JSON lines on stdout, logs on stderr
  python live.py --window        # same, plus a window with live bars
  python live.py --jaw-only      # fallback from docs/brain-mode-test.md: single clench = YES, silence = NO
  python live.py --log events.jsonl

Output (PLAN.md decoder contract, not connected to the station yet):
  {"type": "gesture", "id", "command", "onsetAgeMs", "confidence", "source"}
  {"type": "health", "decoderHealthy"}   every 250 ms

Right fist imagined = YES, left = NO, double jaw clench = CONFIRM, long (~1 s) jaw clench = STOP,
no packets for 0.5 s = HEADSET_OFF. Imagery is ignored during a clench and for 1 s after it.
"""
import argparse
import os
import sys
import time

from eeg import config, messages, store
from eeg.engine import Engine
from eeg.hands import HandConfig

HERE = os.path.dirname(os.path.abspath(__file__))


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def headless(engine: Engine, out: messages.Output):
    engine.start()
    log("Running - Ctrl+C to stop.")
    next_health = 0.0
    try:
        while True:
            up = engine.poll()
            for msg in up.commands:
                out.send(msg)
            if time.time() >= next_health:
                out.send(messages.health(engine.healthy()))
                next_health = time.time() + 0.25
    except KeyboardInterrupt:
        pass
    finally:
        engine.stop()


def windowed(engine: Engine, out: messages.Output, title: str):
    from PyQt5 import QtCore, QtWidgets
    from eeg.ui import Bar, EngineThread, app

    a = app()
    win = QtWidgets.QWidget()
    win.setWindowTitle(title)
    lay = QtWidgets.QVBoxLayout(win)
    head = QtWidgets.QLabel("connecting ...")
    head.setStyleSheet("font-size: 26px; font-weight: bold;")
    lay.addWidget(head)
    bars = {c: Bar(c, engine.hands.cfg.threshold) for c in engine.classes}
    jaw = Bar("jaw", 1.0, "jaw")
    for b in list(bars.values()) + [jaw]:
        lay.addWidget(b)
    history = QtWidgets.QLabel("")
    history.setStyleSheet("font-size: 15px;")
    lay.addWidget(history)
    seen = []
    thread = EngineThread(engine)

    def on_update(up):
        for c, b in bars.items():
            b.set(up.smoothed.get(c, 0.0))
        jaw.set(min(up.jaw_level / config.JAW_RATIO, 1.0), f" ({up.jaw_level:.0f}x)")
        head.setText(f"now: {up.status}")
        for msg in up.commands:
            out.send(msg)
            seen.insert(0, f"{time.strftime('%H:%M:%S')}  {msg['command']}  ({msg['source']}, {msg['confidence']:.2f})")
        history.setText("\n".join(seen[:8]))

    thread.ready.connect(lambda: head.setText("ready"))
    thread.update.connect(on_update)
    thread.failed.connect(lambda e: head.setText(f"headset error: {e}"))
    health = QtCore.QTimer()
    health.timeout.connect(lambda: out.send(messages.health(engine.healthy())))
    health.start(250)
    a.aboutToQuit.connect(thread.stop)
    win.resize(900, 520)
    win.show()
    thread.start()
    a.exec_()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", default=os.path.join(HERE, "models"))
    ap.add_argument("--port", default=config.SERIAL_PORT)
    ap.add_argument("--board-id", type=int, default=config.BOARD_ID)
    ap.add_argument("--window", action="store_true", help="show live bars")
    ap.add_argument("--jaw-only", action="store_true", help="fallback: single clench = YES, imagery off")
    ap.add_argument("--no-jaw", action="store_true", help="imagery only")
    ap.add_argument("--log", help="also append every message to this .jsonl file")
    ap.add_argument("--step", type=float, default=0.1, help="seconds between imagery predictions")
    ap.add_argument("--threshold", type=float, default=0.6)
    ap.add_argument("--margin", type=float, default=0.15)
    ap.add_argument("--ema", type=float, default=0.5)
    ap.add_argument("--dwell", type=float, default=1.0)
    ap.add_argument("--refractory", type=float, default=2.0)
    ap.add_argument("--rearm", type=float, default=0.5)
    ap.add_argument("--allow-unusable", action="store_true", help="run a model that failed the chance check")
    args = ap.parse_args()

    try:
        model, meta, folder = store.load(args.models)
    except (FileNotFoundError, ValueError) as e:
        sys.exit(f"cannot load model: {e}")
    log(f"Model {meta['model_id']} ({meta['model']}): classes {meta['classes']}, trained on {meta['trials']} trials, "
        f"held-out {meta['test_correct']} right, usable={meta['deployable']}")
    if not meta["deployable"] and not (args.allow_unusable or args.jaw_only):
        sys.exit("This model did not beat chance. Use --jaw-only (the fallback) or --allow-unusable for testing.")
    hand_cfg = HandConfig(args.threshold, args.margin, args.ema, args.dwell, args.refractory, args.rearm)
    engine = Engine(model, meta, hand_cfg, step_s=args.step, port=args.port, board_id=args.board_id,
                    use_jaw=not args.no_jaw, jaw_only=args.jaw_only, log=log)
    out = messages.Output(args.log)
    if args.window:
        windowed(engine, out, f"Headset decoder - model {meta['model_id']}")
    else:
        headless(engine, out)


if __name__ == "__main__":
    main()
