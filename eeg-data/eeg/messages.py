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

JAW_COMMAND = {"double": "CONFIRM", "long": "STOP"}


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
    """double -> CONFIRM, long -> STOP; single -> YES only in the jaw-only fallback, else nothing."""
    cmd = JAW_COMMAND.get(ev["kind"]) or ("YES" if jaw_only and ev["kind"] == "single" else None)
    conf = min(1.0, ev["strength"] / (2 * config.JAW_RATIO))
    return gesture(cmd, ev["onset"], conf, "jaw", now) if cmd else None


class Output:
    """Writes messages as JSON lines to stdout and, optionally, appends them to a file."""

    def __init__(self, jsonl_path: str = None, stream=sys.stdout):
        self.stream = stream
        self.file = open(jsonl_path, "a", encoding="utf-8") if jsonl_path else None

    def send(self, msg: dict):
        line = json.dumps(msg)
        if self.stream:
            print(line, file=self.stream, flush=True)
        if self.file:
            self.file.write(line + "\n")
            self.file.flush()
