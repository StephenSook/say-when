"""Evaluate the imagery classifiers on recorded sessions, then train and save the chosen one.

  python train.py                                  # left / right / rest, all sessions in data/sessions
  python train.py --classes left right             # hands only
  python train.py --evaluate-only                  # report, save nothing

1. every recording is filtered causally (as live) and each trial is cut into 2 s windows
2. a final test set is put aside first: the newest session if it is big enough, else ~20% of trials
3. the rest is cross-validated, never splitting the windows of one trial
4. the simplest model within one standard error of the best is chosen
5. it is scored once on the test set, then refit on everything and saved to models/<timestamp>/
"""
import argparse
import os
import sys
import time
import warnings

import numpy as np

from eeg import config, store
from eeg.evaluate import cross_validate, cv_folds, metrics, per_trial, pick, split_test
from eeg.models import CANDIDATES, aligned, make
from eeg.sessions import list_sessions, load_session, make_epochs, names

HERE = os.path.dirname(os.path.abspath(__file__))
warnings.filterwarnings("ignore", message="y_pred contains classes not in y_true")


def per_class_line(m: dict) -> str:
    return ", ".join(f"{c} {d['right']}/{d['of']}" for c, d in m["per_class"].items())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=os.path.join(HERE, "data", "sessions"))
    ap.add_argument("--subject", default=None)
    ap.add_argument("--classes", nargs="+", default=list(config.IMAGERY), choices=list(config.LABELS))
    ap.add_argument("--window", type=float, default=config.WINDOW_S)
    ap.add_argument("--models", default=os.path.join(HERE, "models"))
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--evaluate-only", action="store_true")
    args = ap.parse_args()

    paths = list_sessions(args.data, args.subject)
    if not paths:
        sys.exit(f"no recordings in {args.data} - run collect.py first")
    ep = make_epochs([load_session(p) for p in paths], args.classes, args.window)
    classes = np.unique(ep.y)
    missing = set(args.classes) - set(names(classes))
    if missing:
        sys.exit(f"no usable trials for {sorted(missing)}")

    print(f"{ep.n_trials} trials ({len(ep.y)} windows of {ep.window_s:.1f} s @ {ep.fs:.1f} Hz); "
          f"dropped {ep.info['dropped_trials']}")
    for s in dict.fromkeys(ep.session):
        m = ep.session == s
        counts = {c: len({t for t, y in zip(ep.trial[m], ep.y[m]) if y == config.LABELS[c]}) for c in args.classes}
        print(f"  {s}: {counts}")

    test_mask, test_desc = split_test(ep, args.seed)
    dev, test = ep.take(~test_mask), ep.take(test_mask)
    folds, cv_desc = cv_folds(dev, args.seed)
    print(f"\nTest set (kept aside): {test_desc}, {test.n_trials} trials")
    print(f"Model choice: {cv_desc} on {dev.n_trials} trials\n")

    cv, scores = {}, {}
    for name in ["majority"] + CANDIDATES:
        t0 = time.time()
        oof = cross_validate(name, dev, folds, classes)
        fold_scores = [metrics(dev.y[va], oof[va], classes)["balanced_accuracy"] for _, va in folds]
        yt, pt = per_trial(dev, oof)
        cv[name] = {"windows": metrics(dev.y, oof, classes), "trials": metrics(yt, pt, classes),
                    "fold_scores": fold_scores}
        scores[name] = (float(np.mean(fold_scores)), float(np.std(fold_scores, ddof=1) / np.sqrt(len(folds))))
        print(f"  CV {name:<11} balanced acc {scores[name][0]:.3f} +/- {scores[name][1]:.3f}   "
              f"trials: {per_class_line(cv[name]['trials'])}   [{time.time() - t0:.0f} s]")
    chosen = pick(scores, CANDIDATES)
    print(f"\nChosen: {chosen}")

    tested = {}
    for name in ["majority"] + CANDIDATES:
        m = make(name).fit(dev.X, dev.y)
        yt, pt = per_trial(test, aligned(m.proba(test.X), m.classes_, classes))
        tested[name] = metrics(yt, pt, classes)
    t = tested[chosen]
    print(f"\nHeld-out test ({test_desc}), {chosen}: {t['correct']}/{t['n']} trials right "
          f"(balanced {t['balanced_accuracy']:.0%}, chance {t['chance']:.0%})")
    print(f"  per class: {per_class_line(t)}")
    if "hand_swaps" in t:
        print(f"  left/right swapped: {t['hand_swaps']}")
    if "rest_read_as_command" in t:
        print(f"  rest read as a hand (confident): {t['rest_read_as_command']:.0%}")
    print("  confusion (rows = true):", t["confusion"]["labels"])
    for lab, row in zip(t["confusion"]["labels"], t["confusion"]["rows_true"]):
        print(f"    {lab:<6} {row}")

    cvt = cv[chosen]["trials"]
    deployable = cvt["balanced_accuracy"] >= cvt["chance"] + 0.10 and cvt["p_vs_majority"] < 0.05
    print(f"\nUsable: {'yes' if deployable else 'NO - not clearly above chance on cross-validated trials'}")
    report = {"created": time.strftime("%Y-%m-%dT%H:%M:%S"), "classes": names(classes), "test": test_desc,
              "cv": cv_desc, "cv_results": cv, "test_results": tested, "chosen": chosen, "deployable": deployable,
              "dropped_trials": ep.info["dropped_trials"], "sessions": list(dict.fromkeys(ep.session))}
    if args.evaluate_only:
        print("Evaluate only: nothing saved.")
        return
    model = make(chosen).fit(ep.X, ep.y)
    meta = {"classes": names(model.classes_), "fs": ep.fs, "window_s": ep.window_s, "model": chosen,
            "sessions": report["sessions"], "trials": ep.n_trials, "deployable": deployable,
            "cv_trial_balanced_accuracy": cvt["balanced_accuracy"], "test_trial_balanced_accuracy":
            t["balanced_accuracy"], "test_correct": f"{t['correct']}/{t['n']}",
            "note": "refit on all trials after evaluation"}
    print("Saved to", store.save(args.models, model, meta, report))


if __name__ == "__main__":
    main()
