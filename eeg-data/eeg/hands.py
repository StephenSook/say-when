"""Imagined left / right squeeze: class probabilities -> sparse, debounced hand events.

Rules:
  * probabilities are smoothed (exponential moving average)
  * a moment is UNSURE unless the top class >= threshold and leads the next by >= margin
  * a hand fires only after it has been the sure answer for dwell_s
  * then silence for refractory_s, and the wearer must return to neutral for rearm_s before the
    next hand can fire (one long imagery = one event); it also starts disarmed
  * neutral = a sure REST when the model has a rest class, otherwise simply being UNSURE
  * suppress(until) blanks it, e.g. during and right after a jaw clench
"""
from dataclasses import dataclass
from typing import Dict, Optional


@dataclass
class HandConfig:
    threshold: float = 0.6
    margin: float = 0.15
    ema: float = 0.5           # weight of the previous smoothed value
    dwell_s: float = 1.0
    refractory_s: float = 2.0
    rearm_s: float = 0.5


class HandDecoder:
    def __init__(self, cfg: HandConfig = None, hands=("left", "right"), rest: str = "rest"):
        self.cfg, self.hands, self.rest = cfg or HandConfig(), tuple(hands), rest
        self.smoothed: Dict[str, float] = {}
        self.status = "UNSURE"
        self.armed = False
        self._cand, self._since = None, 0.0
        self._quiet_until = -1e18

    def suppress(self, until: float):
        self._quiet_until = max(self._quiet_until, until)
        self._cand, self.armed = None, False

    def update(self, t: float, proba: Dict[str, float]) -> Optional[dict]:
        a = self.cfg.ema
        for k, p in proba.items():
            self.smoothed[k] = p if k not in self.smoothed else a * self.smoothed[k] + (1 - a) * p
        ranked = sorted(self.smoothed.items(), key=lambda kv: kv[1], reverse=True)
        top, p1 = ranked[0]
        p2 = ranked[1][1] if len(ranked) > 1 else 0.0
        sure = p1 >= self.cfg.threshold and p1 - p2 >= self.cfg.margin
        neutral_is_rest = self.rest in proba
        if sure and top in self.hands:
            cand = top
        elif (sure and top == self.rest) or (not sure and not neutral_is_rest):
            cand = "neutral"
        else:
            cand = None
        self.status = cand.upper() if cand in self.hands else ("REST" if cand == "neutral" else "UNSURE")
        if cand != self._cand:
            self._cand, self._since = cand, t
        if t < self._quiet_until or cand is None:
            return None
        held = t - self._since
        if cand == "neutral":
            if not self.armed and held >= self.cfg.rearm_s - 1e-6:
                self.armed = True
            return None
        if self.armed and held >= self.cfg.dwell_s - 1e-6:
            self.armed = False
            self._quiet_until = t + self.cfg.refractory_s
            return {"hand": cand, "onset": self._since, "t": t, "confidence": round(float(p1), 4)}
        return None
