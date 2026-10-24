"""Record a calibration session: cued trials with the continuous raw EEG saved to a new file.

  python collect.py --subject S01                                 # left / right / rest, 20 each
  python collect.py --subject S01 --classes left right --trials 40 --runs 4
  python collect.py --subject S01 --classes clench --trials 20    # jaw clench trials

Each trial: get ready (2 s) -> cue (3 s, text + tone, optional voice) -> stop -> relax (2-3.5 s).
Cues are shuffled in balanced blocks (never more than 3 identical in a row). After each trial it reports
whether all data arrived, any quality problem, and how strong the trial looked. Ctrl+C or a crash still
saves every finished trial. Files are never overwritten.
"""
import argparse
import os
import random
import subprocess
import sys
import time

import numpy as np
from scipy.signal import sosfiltfilt

from eeg import board as headset
from eeg import config
from eeg.filters import bandpass, emg_envelope
from eeg.jaw import strongest_spike
from eeg.sessions import new_session_path, save_session

try:
    import winsound
except ImportError:
    winsound = None

HERE = os.path.dirname(os.path.abspath(__file__))
TONES = {"left": [(600, 150)], "right": [(1200, 150)], "both": [(600, 120), (1200, 120)], "rest": [(300, 300)],
         "clench": [(1600, 80)] * 3, "ready": [(800, 60)], "stop": [(400, 80)] * 2}
CONTRA = {"left": ("C4", "C3"), "right": ("C3", "C4")}  # (should drop, other side)

HOW_TO = """
For hand cues, IMAGINE the movement - do not do it:
  * feel a slow squeeze of the fist from the inside (fingers and palm), first person
  * hands flat and still, jaw and shoulders loose, eyes on one point, try not to blink
  * start the moment the cue appears and keep it up until 'stop'
  * REST: relax and imagine nothing.   CLENCH: bite down hard (a short bite is fine).
Use the same strategy every trial and every session.
"""


def tone(kind, on):
    if on and winsound:
        for f, ms in TONES.get(kind, TONES["ready"]):
            winsound.Beep(f, ms)


def say(text, on):
    if on and sys.platform == "win32":
        text = text.replace("'", "''")
        subprocess.Popen(["powershell", "-NoProfile", "-Command", "Add-Type -AssemblyName System.Speech; "
                          f"(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{text}')"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def schedule(classes, per_class, runs, rng):
    base, extra = divmod(per_class, runs)
    blocks = []
    for r in range(runs):
        block = [c for c in classes for _ in range(base + (r < extra))]
        for _ in range(1000):
            rng.shuffle(block)
            if all(len(set(block[i:i + 4])) > 1 for i in range(len(block) - 3)):
                break
        blocks.append(block)
    return blocks


class Recorder:
    def __init__(self, read):
        self.read, self.eeg, self.ts = read, [], []

    def run(self, seconds):
        end = time.time() + seconds
        while True:
            eeg, ts = self.read()
            if ts.size:
                self.eeg.append(eeg)
                self.ts.append(ts)
            if time.time() >= end:
                return
            time.sleep(0.005)

    def all(self):
        if not self.ts:
            return np.empty((len(config.CHANNELS), 0)), np.empty(0)
        return np.concatenate(self.eeg, axis=1), np.concatenate(self.ts)

    def between(self, t0, t1):
        eeg, ts = self.all()
        return eeg[:, (ts >= t0) & (ts < t1)]


def problems(seg, label, fs, expected, jaw_base, lead=None):
    """Reasons a trial is unusable (muscle during imagery is NOT one: it is only reported)."""
    out = []
    if seg.shape[1] < config.MIN_DATA_FRACTION * expected:
        out.append(f"incomplete data ({seg.shape[1]}/{expected} samples)")
    if seg.shape[1] < 32:
        return out
    band = sosfiltfilt(bandpass(*config.BANDS[config.COV_BAND], fs), seg - seg.mean(1, keepdims=True), axis=1)
    if label not in config.JAW:
        spikes = [f"{config.CHANNELS[i]} {v:.0f}uV" for i, v in enumerate(np.ptp(band, axis=1)) if v > config.SPIKE_UV]
        if spikes:
            out.append("large spike / movement: " + ", ".join(spikes))
    flat = [config.CHANNELS[i] for i, v in enumerate(band.std(axis=1)) if v < config.FLAT_UV]
    if flat:
        out.append("flat channel (electrode off?): " + ", ".join(flat))
    if label in config.JAW:
        ratio, _ = strongest_spike(seg if lead is None else lead, fs, jaw_base, 0.0 if lead is None else 1.0)
        if not ratio >= config.JAW_RATIO:
            out.append(f"clench not detected (strongest {ratio:.1f}x, need {config.JAW_RATIO:.0f}x)")
    return out


def strength(seg_with_pre, n_pre, label, fs, jaw_base):
    """(rating, detail). Hands: mu/beta drop on the opposite side vs the 2 s before the cue."""
    if label in config.JAW:
        ratio, t = strongest_spike(seg_with_pre, fs, jaw_base, n_pre / fs)
        rating = "STRONG" if ratio >= 2 * config.JAW_RATIO else "ok" if ratio >= config.JAW_RATIO else "weak"
        return rating, f"strongest jaw spike {ratio:.1f}x at {t:.1f} s", t
    x = seg_with_pre - seg_with_pre.mean(1, keepdims=True)
    skip = n_pre + int(0.5 * fs)
    change = {}
    for band, (lo, hi) in {"mu": (8, 12), "beta": (16, 26)}.items():
        p = sosfiltfilt(bandpass(lo, hi, fs), x, axis=1) ** 2
        for ch in ("C3", "C4"):
            i = config.CHANNELS.index(ch)
            change[band, ch] = 100 * (p[i, skip:].mean() / (p[i, :n_pre].mean() + 1e-12) - 1)
    if label in CONTRA:
        a, b = CONTRA[label]
        band = min(("mu", "beta"), key=lambda k: change[k, a])
        d, o = change[band, a], change[band, b]
        rating = "STRONG" if d <= -30 and d < o - 10 else "moderate" if d <= -15 and d < o else "weak"
        return rating, f"{a} {band} {d:+.0f}%, {b} {o:+.0f}% (want {a} to drop most)", np.nan
    if label == "both":
        band = min(("mu", "beta"), key=lambda k: max(change[k, "C3"], change[k, "C4"]))
        worst = max(change[band, "C3"], change[band, "C4"])
        rating = "STRONG" if worst <= -30 else "moderate" if worst <= -15 else "weak"
        return rating, f"C3 {change[band, 'C3']:+.0f}%, C4 {change[band, 'C4']:+.0f}% (want both to drop)", np.nan
    drop = min(change.values())
    return ("ok" if drop > -30 else "drop"), f"largest drop {drop:+.0f}% (want none below -30%)", np.nan


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--subject", default="S01")
    ap.add_argument("--classes", nargs="+", default=list(config.IMAGERY), choices=list(config.LABELS))
    ap.add_argument("--trials", type=int, default=20, help="trials per class")
    ap.add_argument("--runs", type=int, default=3, help="blocks with a break between them")
    ap.add_argument("--cue", type=float, default=config.CUE_S, help="seconds per cue")
    ap.add_argument("--prep", type=float, default=config.PREP_S)
    ap.add_argument("--iti", type=float, nargs=2, default=config.ITI_S)
    ap.add_argument("--settle", type=float, default=config.SETTLE_S)
    ap.add_argument("--port", default=config.SERIAL_PORT)
    ap.add_argument("--board-id", type=int, default=config.BOARD_ID)
    ap.add_argument("--data", default=os.path.join(HERE, "data", "sessions"))
    ap.add_argument("--speak", action="store_true", help="also say each cue out loud")
    ap.add_argument("--quiet", action="store_true", help="no tones")
    ap.add_argument("--notes", default="")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()
    if args.trials < args.runs:
        ap.error("--trials must be >= --runs")

    seed = args.seed if args.seed is not None else random.SystemRandom().randrange(2 ** 31)
    blocks = schedule(args.classes, args.trials, args.runs, random.Random(seed))
    total = sum(map(len, blocks))
    path = new_session_path(args.data, args.subject, time.strftime("%Y%m%d_%H%M%S"))
    beeps = not args.quiet
    print(HOW_TO)
    print(f"{args.subject}: {args.classes} x {args.trials} = {total} trials in {args.runs} runs, "
          f"~{total * (args.prep + args.cue + sum(args.iti) / 2) / 60:.0f} min + breaks\nSaving to {path}")
    input("Press Enter to connect ...")

    b = headset.open_board(args.board_id, args.port)
    rec = Recorder(lambda: headset.read(b, args.board_id))
    trials, complete, started = [], False, time.strftime("%Y-%m-%dT%H:%M:%S")
    fs = config.FS_NOMINAL
    try:
        print(f"\nResting baseline: relax, jaw loose, eyes open ({args.settle:.0f} s) ...")
        t0 = time.time()
        rec.run(args.settle)
        fs = headset.sampling_rate(rec.all()[1])
        rest_seg = rec.between(t0 + 5, time.time())
        jaw_base = float(np.median(emg_envelope(rest_seg, fs, config.JAW_SLICE_S))) if rest_seg.shape[1] > 64 else None
        print(f"Sampling rate {fs:.2f} Hz")
        for issue in problems(rest_seg, "rest", fs, rest_seg.shape[1], jaw_base):
            print(f"  ! baseline: {issue}")
        k = 0
        for r, block in enumerate(blocks, 1):
            print(f"\n=== run {r}/{len(blocks)}: {len(block)} trials ===")
            input("Enter when ready (then keep still) ...")
            rec.run(5.0)
            for label in block:
                k += 1
                print(f"\n[{k:>3}/{total}] get ready ...")
                tone("ready", beeps)
                rec.run(args.prep)
                cue = time.time()
                print(f"      >>> {config.CUES[label]}  ({args.cue:.0f} s)")
                say(config.CUES[label].split(" - ")[0].lower(), args.speak)
                tone(label, beeps)
                rec.run(args.cue - (time.time() - cue))
                end = time.time()
                print("      stop - relax")
                tone("stop", beeps)

                seg = rec.between(cue, end)
                expected = int(round((end - cue) * fs))
                print(f"      data recorded: {'YES' if seg.shape[1] >= config.MIN_DATA_FRACTION * expected else 'NO'} "
                      f"({seg.shape[1]}/{expected} samples)")
                bad = problems(seg, label, fs, expected, jaw_base, rec.between(cue - 1.0, end))
                print("      X BAD TRIAL: " + "; ".join(bad) if bad else "      ok")
                pre = min(args.prep, 2.0)
                rating, detail, peak = strength(rec.between(cue - pre, end), int(pre * fs), label, fs, jaw_base)
                print(f"      strength: {rating:<8} {detail}")
                spike, _ = strongest_spike(rec.between(cue - 1.0, end), fs, jaw_base, 1.0)
                muscle = label not in config.JAW and spike >= config.JAW_RATIO  # reported, never dropped
                if muscle:
                    print(f"      note: jaw-level muscle burst ({spike:.0f}x) during imagery")
                trials.append({"label": label, "cue_time": cue, "end_time": end, "trial": k, "run": r,
                               "problems": bad, "strength": rating, "muscle": bool(muscle),
                               "clench_peak_s": peak if not bad else np.nan})
                rec.run(random.uniform(*args.iti))
        complete = True
    except KeyboardInterrupt:
        print("\nStopped - saving finished trials.")
    except Exception as e:  # never lose finished trials
        print(f"\nERROR {e!r} - saving finished trials.")
    finally:
        try:
            rec.run(0.5)
        finally:
            headset.close_board(b)

    if not trials:
        print("No trials recorded; nothing saved.")
        return
    raw, ts = rec.all()
    meta = {"task": "motor_imagery", "subject": args.subject, "started_at": started, "complete": complete,
            "classes": args.classes, "trials_per_class": args.trials, "runs": args.runs, "imagery_sec": args.cue,
            "prep_sec": args.prep, "iti_range_sec": list(args.iti), "board_id": args.board_id, "port": args.port,
            "seed": seed, "spoken_cues": args.speak, "notes": args.notes}
    save_session(path, raw, ts, headset.sampling_rate(ts, fs), config.FS_NOMINAL, trials, meta)
    print(f"\nSaved {len(trials)} trials -> {path}")
    for c in args.classes:
        rs = [t["strength"] for t in trials if t["label"] == c]
        print(f"  {c:<6} strength {dict((r, rs.count(r)) for r in dict.fromkeys(rs))}")
    bad = [t for t in trials if t["problems"]]
    print(f"{len(bad)} unusable trial(s) (left out of training)" if bad else "All trials passed the checks.")
    for t in bad:
        print(f"  trial {t['trial']} ({t['label']}): " + "; ".join(t["problems"]))


if __name__ == "__main__":
    main()
