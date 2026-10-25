"""Decoder output in the shape PLAN.md agrees with the station page:

  {"type": "gesture", "id", "command", "onsetAgeMs", "confidence", "source"}
  {"type": "health", "decoderHealthy"}

command depends on the map (config.MODES, live.py --mode):
  direct (D18, default): PICK_1, PICK_2, PICK_3, PICK_4, STOP or HEADSET_OFF
  scan   (D11 + D17):    YES, NO, CONFIRM, STOP or HEADSET_OFF
Nothing here talks to SpacetimeDB: messages go to stdout (one JSON object per line), the 8765 server and optionally
a .jsonl file.
"""
import json
import sys
import time
import uuid

from eeg import config

# Jaw clench -> command, per map. A clench is a muscle signal (EMG), never a brain signal.
JAW_COMMAND = {
    # D18 direct select: single = option 3, double = option 4, a held clench (LONG_CLENCH_S) = STOP.
    "direct": {"single": "PICK_3", "double": "PICK_4", "long": "STOP"},
    # D17 scan: single = CONFIRM, double or held = STOP.
    "scan": {"single": "CONFIRM", "double": "STOP", "long": "STOP"},
}
# Jaw-only fallback (docs/brain-mode-test.md), imagery off.
JAW_ONLY_COMMAND = {
    # Direct: the jaw takes over the two fist picks, so every confirm ("One: send it. Two: cancel.") still works:
    # single = PICK_1, double = PICK_2, held = STOP. Options 3 and 4 need the station keys 3 and 4.
    "direct": {"single": "PICK_1", "double": "PICK_2", "long": "STOP"},
    # Scan, unchanged since D16: single = YES, double = CONFIRM, silence = NO, no STOP gesture.
    "scan": {"double": "CONFIRM", "single": "YES"},
}


def _mode(mode: str) -> str:
    if mode not in config.MODES:
        raise ValueError(f"unknown mode {mode}; use one of {', '.join(config.MODES)}")
    return mode


def gesture(command: str, onset: float, confidence: float, source: str, now: float = None) -> dict:
    if command not in config.COMMANDS:
        raise ValueError(f"unknown command {command}")
    now = time.time() if now is None else now
    return {"type": "gesture", "id": str(uuid.uuid4()), "command": command,
            "onsetAgeMs": max(0, int(round((now - onset) * 1000))), "confidence": round(float(confidence), 4),
            "source": source}


def health(ok: bool) -> dict:
    return {"type": "health", "decoderHealthy": bool(ok)}


def from_hand(ev: dict, now: float = None, *, mode: str = config.DEFAULT_MODE) -> dict:
    """direct: left -> PICK_1, right -> PICK_2. scan: right -> YES, left -> NO."""
    return gesture(config.HAND_COMMANDS[_mode(mode)][ev["hand"]], ev["onset"], ev["confidence"], "imagery", now)


def from_jaw(ev: dict, jaw_only: bool = False, now: float = None, *, mode: str = config.DEFAULT_MODE):
    """A clench event (single / double / long) as a command, or None when the map has no command for it."""
    table = JAW_ONLY_COMMAND if jaw_only else JAW_COMMAND
    cmd = table[_mode(mode)].get(ev["kind"])
    conf = min(1.0, ev["strength"] / (2 * config.JAW_RATIO))
    return gesture(cmd, ev["onset"], conf, "jaw", now) if cmd else None


class Output:
    """Writes messages as JSON lines to stdout and, optionally, appends them to a file."""

    def __init__(self, jsonl_path: str = None, stream=sys.stdout, server=None, viz=None):
        self.stream, self.server, self.viz = stream, server, viz
        self.file = open(jsonl_path, "a", encoding="utf-8") if jsonl_path else None

    def send(self, msg: dict):
        line = json.dumps(msg)
        if self.stream:
            print(line, file=self.stream, flush=True)
        if self.file:
            self.file.write(line + "\n")
            self.file.flush()
        if self.server:
            self.server.send(msg)
        if self.viz:  # after 8765, never before or instead of it (VIZ_PROTOCOL.md 6.3)
            self.viz.marker(msg)

    def live(self, frame: dict):
        """A live signal frame: only to the web page, never to stdout or the log."""
        if self.server and frame:
            self.server.send(frame)
