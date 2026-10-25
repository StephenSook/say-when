"""Decoder output in the shape PLAN.md agrees with the station page:

  {"type": "gesture", "id", "command", "onsetAgeMs", "confidence", "source"}
  {"type": "health", "decoderHealthy"}

command is YES, NO, CONFIRM, STOP or HEADSET_OFF. Nothing here talks to SpacetimeDB or the
station yet: messages go to stdout (one JSON object per line) and optionally to a .jsonl file.
"""
import json
import sys
import time
import uuid

from eeg import config

# PLAN D16: a single clench is STOP (a held one counts as a single), a double is CONFIRM.
JAW_COMMAND = {"double": "CONFIRM", "single": "STOP", "long": "STOP"}
# Jaw-only fallback (docs/brain-mode-test.md): a single clench is YES and there is no STOP gesture.
JAW_ONLY_COMMAND = {"double": "CONFIRM", "single": "YES"}


def gesture(command: str, onset: float, confidence: float, source: str, now: float = None) -> dict:
    if command not in config.COMMANDS:
        raise ValueError(f"unknown command {command}")
    now = time.time() if now is None else now
    return {"type": "gesture", "id": str(uuid.uuid4()), "command": command,
            "onsetAgeMs": max(0, int(round((now - onset) * 1000))), "confidence": round(float(confidence), 4),
            "source": source}


def health(ok: bool) -> dict:
    return {"type": "health", "decoderHealthy": bool(ok)}


def from_hand(ev: dict, now: float = None) -> dict:
    return gesture(config.HAND_COMMAND[ev["hand"]], ev["onset"], ev["confidence"], "imagery", now)


def from_jaw(ev: dict, jaw_only: bool = False, now: float = None):
    """double -> CONFIRM, single or long -> STOP; in the jaw-only fallback single -> YES and no STOP."""
    cmd = (JAW_ONLY_COMMAND if jaw_only else JAW_COMMAND).get(ev["kind"])
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
