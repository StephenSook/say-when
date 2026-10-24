"""True / false quiz answered with imagined squeezes, with live bars - a practice and test tool.

  python quiz.py              # headset + latest model
  python quiz.py --demo       # fake signals, no headset
  python quiz.py --swap       # TRUE = LEFT instead

TRUE = YES = imagine your RIGHT fist, FALSE = NO = imagine your LEFT fist (the Eleven command map).
Each question: 1 s get-ready (not counted), then up to 10 s. RIGHT at 90%+ or LEFT at 97%+ answers at once;
otherwise the hand with the most confident moments (65%+) wins. When REST is the top bar nothing counts.
The result shows for 2 s, read aloud, then the next question. A log goes to data/quiz_logs/.
"""
import argparse
import json
import os
import random
import subprocess
import sys
import time

import numpy as np
from PyQt5 import QtCore, QtWidgets

from eeg import config, store
from eeg.engine import Engine, Update
from eeg.hands import HandConfig

try:
    import winsound
except ImportError:
    winsound = None

HERE = os.path.dirname(os.path.abspath(__file__))
LOGS = os.path.join(HERE, "data", "quiz_logs")

QUESTIONS = [  # very simple and mixed; half true, half false
    ("The sky is blue on a clear day.", True), ("Grass is green.", True), ("Snow is white.", True),
    ("Grass is purple.", False), ("Snow is black.", False), ("The Sun is cold.", False),
    ("Dogs can bark.", True), ("Fish live in water.", True), ("Birds have wings.", True),
    ("Cats can fly.", False), ("Cows can talk.", False), ("Fish can climb trees.", False),
    ("1 + 1 equals 2.", True), ("2 + 2 equals 4.", True), ("10 is bigger than 5.", True),
    ("1 + 1 equals 5.", False), ("3 is bigger than 9.", False), ("5 + 5 equals 20.", False),
    ("A week has seven days.", True), ("The Sun rises in the morning.", True), ("A year has 12 months.", True),
    ("A week has ten days.", False), ("Rain is dry.", False), ("A year has two days.", False),
    ("People have two eyes.", True), ("People breathe air.", True), ("Hands have fingers.", True),
    ("People have three eyes.", False), ("People have wheels instead of feet.", False), ("Dogs have six legs.", False),
    ("Ripe bananas are yellow.", True), ("Ice is cold.", True), ("Fire is hot.", True),
    ("Ice is hot.", False), ("Water is dry.", False), ("Apples grow on the Moon.", False),
    ("A triangle has three sides.", True), ("A square has four sides.", True),
    ("A circle has four corners.", False), ("A triangle has ten sides.", False),
]


def pick_questions(n, rng):
    """Equal true/false (odd extra to a random side), never more than 2 identical answers in a row."""
    trues, falses = [q for q in QUESTIONS if q[1]], [q for q in QUESTIONS if not q[1]]
    n_true = min(n // 2 + (n % 2) * rng.randint(0, 1), len(trues))
    chosen = rng.sample(trues, n_true) + rng.sample(falses, min(n - n_true, len(falses)))
    for _ in range(1000):
        rng.shuffle(chosen)
        if all(len({q[1] for q in chosen[i:i + 3]}) > 1 for i in range(len(chosen) - 2)):
            break
    return chosen


def beep(freq, ms):
    if winsound:
        winsound.Beep(freq, ms)


def say(text, on):
    if on and sys.platform == "win32":
        text = text.replace("'", "''")
        subprocess.Popen(["powershell", "-NoProfile", "-Command", "Add-Type -AssemblyName System.Speech; "
                          f"(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{text}')"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class DemoEngine:
    """Stand-in for Engine: drifting fake probabilities at ~125 samples/s."""

    def __init__(self, step_s):
        self.classes, self.fs, self.step = ["left", "right", "rest"], 125.0, step_s
        self.total_samples, self._x, self._last = 0, np.zeros(3), None
        self.smoothed = {}

    def start(self):
        time.sleep(1.0)
        self._last = time.time()

    def poll(self):
        time.sleep(self.step)
        now = time.time()
        self.total_samples += int(round((now - self._last) * self.fs))
        self._last = now
        self._x = 0.85 * self._x + np.random.normal(0, 0.9, 3)
        p = np.exp(self._x) / np.exp(self._x).sum()
        proba = dict(zip(self.classes, p))
        self.smoothed = {k: 0.3 * self.smoothed.get(k, v) + 0.7 * v for k, v in proba.items()}
        return Update(t=now, proba=proba, smoothed=dict(self.smoothed), samples=self.total_samples)

    def stop(self):
        pass


class Quiz(QtWidgets.QWidget):
    def __init__(self, args, engine, header):
        from eeg.ui import Bar, EngineThread
        super().__init__()
        self.a, self.engine = args, engine
        self.classes = list(engine.classes)
        self.yes_hand, self.no_hand = ("left", "right") if args.swap else ("right", "left")
        self.qs = pick_questions(args.n, random.Random(args.seed))
        self.i, self.state, self.results = -1, "connecting", []
        self.t0 = self.t_shown = 0.0
        self.samples, self.samples0 = 0, 0
        self.votes = {"left": 0, "right": 0}
        self.resting = False
        # LEFT saturates when resting only if the model has no rest class
        self.left_is_rest = 0 if "rest" in self.classes else args.left_rest_above

        self.setWindowTitle("Imagery quiz")
        lay = QtWidgets.QVBoxLayout(self)
        lay.setContentsMargins(30, 20, 30, 20)
        self.info = QtWidgets.QLabel(header)
        self.info.setStyleSheet("color: #777;")
        self.progress = QtWidgets.QLabel("")
        self.question = QtWidgets.QLabel("Connecting to the headset ... sit still and relax")
        self.question.setWordWrap(True)
        self.question.setAlignment(QtCore.Qt.AlignCenter)
        self.question.setMinimumHeight(150)
        self.q_style = "font-size: 30px; font-weight: bold;"
        self.question.setStyleSheet(self.q_style)
        mapping = QtWidgets.QLabel(f"TRUE = imagine {self.yes_hand.upper()} fist      "
                                   f"FALSE = imagine {self.no_hand.upper()} fist")
        mapping.setAlignment(QtCore.Qt.AlignCenter)
        mapping.setStyleSheet("font-size: 18px;")
        marks = {"right": args.right_instant, "left": args.left_instant}
        self.bars = {c: Bar(c, marks.get(c)) for c in self.classes}
        rule = QtWidgets.QLabel(f"first {args.grace:.0f} s not counted; RIGHT {args.right_instant:.0%}+ or LEFT "
                                f"{args.left_instant:.0%}+ answers at once; otherwise after {args.time:.0f} s the hand "
                                f"with the most {args.vote_min:.0%}+ moments wins; REST on top = nothing counts")
        rule.setWordWrap(True)
        rule.setAlignment(QtCore.Qt.AlignCenter)
        rule.setStyleSheet("color: #777;")
        self.status, self.last, self.data, self.score = (QtWidgets.QLabel("") for _ in range(4))
        for w, css in ((self.status, "font-size: 20px;"), (self.last, "font-size: 15px;"),
                       (self.data, "font-size: 13px; color: #555;"), (self.score, "font-size: 18px; font-weight: bold;")):
            w.setAlignment(QtCore.Qt.AlignCenter)
            w.setWordWrap(True)
            w.setStyleSheet(css)
        for w in [self.info, self.progress, self.question, mapping] + list(self.bars.values()) + \
                [rule, self.status, self.last, self.data, self.score]:
            lay.addWidget(w)

        self.thread = EngineThread(engine)
        self.thread.ready.connect(self.next_question)
        self.thread.update.connect(self.on_update)
        self.thread.failed.connect(lambda e: (self.question.setText("Headset error"), self.status.setText(e)))
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self.tick)
        self.timer.start(100)
        self.thread.start()

    # ---------------------------------------------------------- signal
    def on_update(self, up: Update):
        self.samples = up.samples
        sm = up.smoothed
        for c, b in self.bars.items():
            sat = c == "left" and self.left_is_rest and sm.get(c, 0) >= self.left_is_rest
            b.set(sm.get(c, 0.0), " =rest" if sat else "", dim=bool(sat))
        if self.state != "asking" or time.time() - self.t0 < self.a.grace or up.proba is None:
            return
        left, right = sm.get("left", 0.0), sm.get("right", 0.0)
        self.resting = "rest" in sm and sm["rest"] >= max(left, right)
        if self.resting or (self.left_is_rest and left >= self.left_is_rest):
            return
        for hand, level in (("right", self.a.right_instant), ("left", self.a.left_instant)):
            if sm.get(hand, 0.0) >= level:
                return self.answer(hand, sm[hand], f"{hand.upper()} reached {sm[hand]:.0%}")
        top = "left" if left >= right else "right"
        if sm[top] >= self.a.vote_min:
            self.votes[top] += 1

    # ---------------------------------------------------------- flow
    def next_question(self):
        for b in self.bars.values():
            b.bold = False
        self.i += 1
        if self.i >= len(self.qs):
            return self.finish()
        text, _ = self.qs[self.i]
        self.question.setStyleSheet(self.q_style)
        self.question.setText(text)
        self.progress.setText(f"Question {self.i + 1} of {len(self.qs)}")
        self.state, self.t0, self.samples0 = "asking", time.time(), self.samples
        self.votes = {"left": 0, "right": 0}
        beep(900, 120)
        say(text, self.a.speak)

    def data_check(self):
        secs = time.time() - self.t0
        got, want = self.samples - self.samples0, int(round(secs * self.engine.fs))
        ok = got >= config.MIN_DATA_FRACTION * want
        self.data.setText(f"data recorded: {'YES' if ok else 'NO'} ({got}/{want} samples, {secs:.1f} s)")
        return {"ok": ok, "samples": got, "expected": want, "seconds": round(secs, 2)}

    def answer(self, hand, conf, how):
        text, truth = self.qs[self.i]
        said_true = hand == self.yes_hand
        ok = said_true == truth
        self.bars[hand].bold = True
        self.results.append({"q": text, "truth": truth, "answer": said_true, "hand": hand.upper(),
                             "confidence": round(float(conf), 3), "how": how, "votes": dict(self.votes),
                             "seconds": round(time.time() - self.t0, 2), "correct": ok, "data": self.data_check()})
        self.show_result()

    def no_answer(self, why):
        text, truth = self.qs[self.i]
        self.results.append({"q": text, "truth": truth, "answer": None, "correct": False, "how": why,
                             "votes": dict(self.votes), "data": self.data_check()})
        self.show_result()

    def show_result(self):
        r = self.results[-1]
        truth = "TRUE" if r["truth"] else "FALSE"
        if r["answer"] is None:
            big, bg, spoken = f"NO RESPONSE<br><span style='font-size:20px'>answer was {truth}</span>", "#9e9e9e", \
                f"No response. The answer was {truth.lower()}."
        else:
            picked = "TRUE" if r["answer"] else "FALSE"
            verdict = "CORRECT" if r["correct"] else f"WRONG - answer was {truth}"
            big = f"{picked} ({r['hand']})<br><span style='font-size:22px'>{verdict}</span>"
            bg = "#2e9d4f" if r["correct"] else "#c0392b"
            spoken = f"{picked.capitalize()}. " + ("Correct." if r["correct"] else f"Wrong. The answer was {truth.lower()}.")
        n_ok = sum(x["correct"] for x in self.results)
        self.score.setText(f"Score: {n_ok}/{len(self.results)}")
        self.last.setText(f"last: \"{r['q']}\" - {r['how']}")
        say(spoken, self.a.speak)
        beep(1200 if r["correct"] else 400, 200)
        if self.a.pause <= 0:
            return self.next_question()
        self.question.setText(big)
        self.question.setStyleSheet(f"font-size: 40px; font-weight: bold; color: white; background: {bg}; "
                                    "border-radius: 14px; padding: 10px;")
        self.status.setText(f"next question in {self.a.pause:.0f} s ...")
        self.state, self.t_shown = "showing", time.time()

    def tick(self):
        if self.state == "asking":
            el = time.time() - self.t0
            left = self.a.grace + self.a.time - el
            if el < self.a.grace:
                self.status.setText("get ready ...")
            elif left <= 0:
                v = self.votes
                if v["left"] == v["right"]:
                    self.no_answer("tie" if v["left"] else "no confident moment")
                else:
                    hand = "left" if v["left"] > v["right"] else "right"
                    self.answer(hand, v[hand] / (v["left"] + v["right"]),
                                f"{v['left']} LEFT vs {v['right']} RIGHT confident moments")
            else:
                self.status.setText(f"{'resting ... ' if self.resting else ''}imagine your answer ...  {left:.0f} s"
                                    f"     (LEFT {self.votes['left']} : {self.votes['right']} RIGHT)")
        elif self.state == "showing" and time.time() - self.t_shown >= self.a.pause:
            self.next_question()

    def finish(self):
        self.state = "done"
        n, ok = len(self.results), sum(r["correct"] for r in self.results)
        bad = sum(not r["data"]["ok"] for r in self.results)
        self.progress.setText("Finished")
        self.question.setStyleSheet(self.q_style)
        self.question.setText(f"Score: {ok}/{n} ({ok / max(n, 1):.0%}) - chance 50%")
        self.status.setText(f"answered {sum(r['answer'] is not None for r in self.results)}/{n}; "
                            f"complete EEG data on {n - bad}/{n}")
        say(f"Finished. You got {ok} out of {n}.", self.a.speak)
        os.makedirs(LOGS, exist_ok=True)
        path = os.path.join(LOGS, f"quiz_{time.strftime('%Y%m%d_%H%M%S')}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"settings": vars(self.a), "true_hand": self.yes_hand.upper(), "results": self.results}, f,
                      indent=2, default=str)
        self.data.setText(f"log: {path}")

    def closeEvent(self, e):
        self.thread.stop()
        super().closeEvent(e)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demo", action="store_true", help="fake signals, no headset")
    ap.add_argument("--n", type=int, default=10, help="number of questions")
    ap.add_argument("--time", type=float, default=10.0, help="counted seconds per question")
    ap.add_argument("--grace", type=float, default=1.0, help="uncounted seconds at the start of each question")
    ap.add_argument("--pause", type=float, default=2.0, help="seconds the result is shown")
    ap.add_argument("--right-instant", type=float, default=0.90)
    ap.add_argument("--left-instant", type=float, default=0.97)
    ap.add_argument("--vote-min", type=float, default=0.65)
    ap.add_argument("--left-rest-above", type=float, default=0.99, help="only for models without a rest class")
    ap.add_argument("--ema", type=float, default=0.3, help="bar smoothing (0 = raw)")
    ap.add_argument("--step", type=float, default=0.1, help="seconds between bar updates")
    ap.add_argument("--swap", action="store_true", help="TRUE = LEFT, FALSE = RIGHT")
    ap.add_argument("--no-speak", dest="speak", action="store_false")
    ap.add_argument("--models", default=os.path.join(HERE, "models"))
    ap.add_argument("--port", default=config.SERIAL_PORT)
    ap.add_argument("--allow-unusable", action="store_true")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    from eeg.ui import app
    a = app()
    if args.demo:
        engine, header = DemoEngine(args.step), "DEMO - fake signals, no headset"
    else:
        try:
            model, meta, _ = store.load(args.models)
        except (FileNotFoundError, ValueError) as e:
            sys.exit(f"cannot load model: {e}")
        if not meta["deployable"] and not args.allow_unusable:
            sys.exit("This model did not beat chance; --allow-unusable to try anyway.")
        if not {"left", "right"} <= set(meta["classes"]):
            sys.exit(f"the quiz needs left and right; this model has {meta['classes']}")
        engine = Engine(model, meta, HandConfig(ema=args.ema), step_s=args.step, port=args.port, use_jaw=False)
        header = f"model {meta['model_id']} ({meta['model']}), classes {meta['classes']}, held-out {meta['test_correct']}"
    win = Quiz(args, engine, header)
    win.resize(1000, 700)
    win.show()
    sys.exit(a.exec_())


if __name__ == "__main__":
    main()
