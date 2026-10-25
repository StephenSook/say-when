"""Live decoder: headset -> YES / NO / CONFIRM / STOP / HEADSET_OFF messages.

  python live.py                 # headless: JSON lines on stdout, logs on stderr
  python live.py --window        # same, plus a window with live bars
  python live.py --jaw-only      # fallback from docs/brain-mode-test.md: single clench = YES, silence = NO
  python live.py --log events.jsonl

Output (PLAN.md decoder contract), as JSON lines on stdout and on ws://127.0.0.1:8765 for the station page
and the /eeg page of the web app (--no-serve turns the server off):
  {"type": "gesture", "id", "command", "onsetAgeMs", "confidence", "source"}
  {"type": "health", "decoderHealthy"}   every 250 ms
  {"type": "eeg", ...}                   about 10 per second, server only: per-electrode change, model bars, jaw

Right fist imagined = YES, left = NO, double jaw clench = CONFIRM, single jaw clench = STOP (PLAN D16),
no packets for 0.5 s = HEADSET_OFF. Imagery is ignored during a clench and for 1 s after it.
"""
import argparse
import os
import sys
import threading
import time

from eeg import config, messages, store
from eeg.engine import Engine
from eeg.hands import HandConfig
from eeg.server import ALLOWED_ORIGINS, DecoderServer, FrameMaker
from eeg.viz import VizBridge

HERE = os.path.dirname(os.path.abspath(__file__))


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def _jaw_base(engine):
    jaw = getattr(engine, "jaw", None)
    return getattr(jaw, "baseline", None)


def make_viz(args, fs: float, source: str):
    if args.no_viz:
        return None
    return VizBridge(fs, source=source, origins=ALLOWED_ORIGINS + args.allow_origin, log=log).start()


def headless(engine: Engine, out: messages.Output):
    frames = FrameMaker()
    engine.start()
    log("Running - Ctrl+C to stop.")
    stop = threading.Event()

    def heartbeat():  # its own timer: the contract wants health at least every 250 ms, whatever the loop is doing
        while not stop.wait(0.2):
            out.send(messages.health(engine.healthy()))
    threading.Thread(target=heartbeat, daemon=True).start()
    try:
        while True:
            up = engine.poll()
            for msg in up.commands:
                out.send(msg)
            out.live(frames(up, engine.fs))
            if out.viz:
                out.viz.update(up.window, getattr(up, "raw", None), up.jaw_level, _jaw_base(engine))
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
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

    frames = FrameMaker()

    def on_update(up):
        out.live(frames(up, engine.fs))
        if out.viz:
            out.viz.update(up.window, getattr(up, "raw", None), up.jaw_level, _jaw_base(engine))
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
    ap.add_argument("--no-serve", action="store_true", help="do not open ws://127.0.0.1:8765 for the web app")
    ap.add_argument("--no-viz", action="store_true", help="do not open the /brain viz bridge on ws://127.0.0.1:8766")
    ap.add_argument("--allow-origin", action="append", default=[],
                    help="another web origin allowed to connect (default: localhost:3000 and the Vercel site)")
    ap.add_argument("--step", type=float, default=0.1, help="seconds between imagery predictions")
    ap.add_argument("--threshold", type=float, default=0.6)
    ap.add_argument("--margin", type=float, default=0.15)
    ap.add_argument("--ema", type=float, default=0.5)
    ap.add_argument("--dwell", type=float, default=1.0)
    ap.add_argument("--refractory", type=float, default=2.0)
    ap.add_argument("--rearm", type=float, default=0.5)
    ap.add_argument("--allow-unusable", action="store_true", help="run a model that failed the chance check")
    ap.add_argument("--demo", action="store_true", help="no headset: fake signals and commands, to try the web page")
    args = ap.parse_args()

    if args.demo:
        from brain_view import DemoEngine
        server = None if args.no_serve else DecoderServer(origins=ALLOWED_ORIGINS + args.allow_origin, log=log).start()
        log("DEMO: fake signals cycling rest / left / rest / right / jaw clench, 5 s each")
        demo = DemoEngine()
        return headless(demo, messages.Output(args.log, server=server, viz=make_viz(args, demo.fs, "synthetic")))
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
    server = None if args.no_serve else DecoderServer(origins=ALLOWED_ORIGINS + args.allow_origin, log=log).start()
    out = messages.Output(args.log, server=server, viz=make_viz(args, float(meta["fs"]), "live"))
    if args.window:
        windowed(engine, out, f"Headset decoder - model {meta['model_id']}")
    else:
        headless(engine, out)


if __name__ == "__main__":
    main()
