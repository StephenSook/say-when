"""Imagined left / right squeeze: class probabilities -> sparse hand events (PLAN D21).

Every rule reads the smoothed probabilities (an exponential moving average of the model output, `ema`):
  * at once: RIGHT (YES) fires the moment its smoothed probability reaches yes_threshold (0.90), and LEFT (NO)
    the moment it reaches no_threshold (0.96). No dwell.
  * one long imagery = one event: after a hand fires, no hand fires at once again until both are below their
    thresholds (re-armed); the decoder also starts disarmed. Nothing fires or counts for refractory_s after an event.
  * fallback: a window of fallback_s (10 s) counts, per hand, the predictions at or above fallback_threshold (0.65).
    When it ends with no command, the hand with more counts fires, but only with at least fallback_min (3) of
    them; a tie, zero or too few sends nothing. Either way a new window starts. Predictions of a hand that is
    still above its instant threshold after it fired are not counted (they are the tail of that event).
  * the window starts with the first prediction and starts again after every command the decoder sends: a hand
    event here, and (through restart(), called by the engine) a jaw command or HEADSET_OFF.
  * suppress(until) blanks it, e.g. during and right after a jaw clench: no event and no counting until then.
"""
from dataclasses import dataclass
from typing import Dict, Optional

from eeg import config


@dataclass
class HandConfig:
    yes_threshold: float = config.YES_THRESHOLD            # right fist: YES at once at or above this
    no_threshold: float = config.NO_THRESHOLD              # left fist: NO at once at or above this
    fallback_s: float = config.FALLBACK_S                  # window length; 0 or less turns the fallback off
    fallback_threshold: float = config.FALLBACK_THRESHOLD  # a prediction this sure counts for its hand
    fallback_min: int = config.FALLBACK_MIN                # the winning hand needs at least this many counts
    ema: float = 0.5                                       # weight of the previous smoothed value
    refractory_s: float = 2.0

    def instant(self, hand: str) -> float:
        return self.yes_threshold if config.HAND_COMMAND.get(hand) == "YES" else self.no_threshold


class HandDecoder:
    def __init__(self, cfg: HandConfig = None, hands=("left", "right"), rest: str = "rest"):
        self.cfg, self.hands, self.rest = cfg or HandConfig(), tuple(hands), rest
        self.smoothed: Dict[str, float] = {}
        self.status = "UNSURE"
        self.armed = False
        self._quiet_until = -1e18
        self.restart()

    def restart(self, t: Optional[float] = None):
        """Start a new fallback window at t (None: at the next prediction) with every count at zero."""
        self.window_start = t
        self.counts: Dict[str, int] = {h: 0 for h in self.hands}
        self._sum = {h: 0.0 for h in self.hands}
        self._last = {h: None for h in self.hands}

    def suppress(self, until: float):
        self._quiet_until = max(self._quiet_until, until)
        self.armed = False

    def update(self, t: float, proba: Dict[str, float]) -> Optional[dict]:
        a = self.cfg.ema
        for k, p in proba.items():
            self.smoothed[k] = p if k not in self.smoothed else a * self.smoothed[k] + (1 - a) * p
        if self.window_start is None:
            self.window_start = t
        top = max(self.smoothed, key=self.smoothed.get)
        hot = [h for h in self.hands if self.smoothed.get(h, 0.0) >= self.cfg.instant(h)]
        if top in self.hands:
            self.status = top.upper() if self.smoothed[top] >= self.cfg.fallback_threshold else "UNSURE"
        else:
            self.status = "REST" if top == self.rest else "UNSURE"
        if t < self._quiet_until:
            return None
        if not hot:
            self.armed = True
        elif self.armed:
            hand = max(hot, key=lambda h: self.smoothed[h])
            return self._fire(hand, t, t, self.smoothed[hand], "instant")
        for h in self.hands:
            p = self.smoothed.get(h, 0.0)
            if h not in hot and p >= self.cfg.fallback_threshold:
                self.counts[h] += 1
                self._sum[h] += p
                self._last[h] = t
        if self.cfg.fallback_s > 0 and t - self.window_start >= self.cfg.fallback_s - 1e-6:
            ranked = sorted(self.hands, key=lambda h: self.counts[h], reverse=True)
            win = ranked[0]
            n, runner_up = self.counts[win], (self.counts[ranked[1]] if len(ranked) > 1 else 0)
            if n > runner_up and n >= self.cfg.fallback_min:
                return self._fire(win, self._last[win], t, self._sum[win] / n, "fallback",
                                  {h: self.counts[h] for h in self.hands})
            self.restart(t)
        return None

    def _fire(self, hand, onset, t, confidence, how, counts=None):
        self.armed = False
        self._quiet_until = t + self.cfg.refractory_s
        self.restart(t)
        ev = {"hand": hand, "onset": onset, "t": t, "confidence": round(float(confidence), 4), "how": how}
        if counts is not None:
            ev["counts"] = counts
        return ev
