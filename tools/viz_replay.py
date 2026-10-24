#!/usr/bin/env python3
"""Replay scripted Screen 1 scenarios (tools/mock-viz/*.jsonl) over the port 8766 viz protocol.

SCRIPTED MOCK DATA. Nothing this tool sends is a measurement.

It plays the files made by tools/mock-viz/make_scenarios.py to the /brain page, in real time, so the page can be
checked state by state before the real decoder bridge exists (tools/VIZ_PROTOCOL.md, tools/mock-viz/README.md).

Rules this tool keeps:
- Listens on 127.0.0.1 only. It refuses any other host, and refuses port 8765 (the station gesture and health
  channel, which this tool never touches).
- Every client gets a viz.meta first: the newest one already sent, or the scenario's first frame.
- Times are rewritten when a frame is sent: every numeric "t" becomes round(time.time(), 3), viz.meta
  baseline.recordedAt (seconds from the start of the file) becomes time.time() + (recordedAt - at) / speed, and each
  viz.marker id becomes a fresh uuid4 on every play (a repeated id in the file stays repeated within one play).
- A file that says "source": "live" is refused unless --allow-live-label is given, and then a warning is printed.
  Only the test fixture 90-live-label-test says live; --all skips it unless --allow-live-label is given.
- A viz.cmd baseline from the page replays the scenario's baseline frames (lines marked "baseline": true, only
  07-baseline-flow has them) and then the rest of the file. A scenario without them ignores it and says so.

The timeline starts when the first client connects and is shared by every client. When the last scenario ends the
frames stop but connections stay open, so the page shows No signal (use --loop to repeat, --exit-when-done to quit).

  python tools/viz_replay.py --list
  python tools/viz_replay.py 02-right-fist-yes
  python tools/viz_replay.py 02 04 06            # several, in this order
  python tools/viz_replay.py --all --loop
  python tools/viz_replay.py 20-demo-run --loop
  python tools/viz_replay.py 07 --speed 4 --exit-when-done
  python tools/viz_replay.py 04 --hold-at 4.05     # freeze on the muscle state to look at it

--hold-at S plays one scenario up to S seconds, then keeps re-sending the newest viz.mi, viz.spec and viz.quality
with a fresh t (never a marker or a meta) until Ctrl-C, so one state stays on screen. If no frame was due at S (after
06-headset-off stops), it sends nothing and the page shows No signal.

Needs only the websockets package (tools/requirements-viz.txt).
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import logging
import re
import signal
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from websockets.asyncio.server import ServerConnection, broadcast, serve
from websockets.exceptions import ConnectionClosed

HOST = "127.0.0.1"  # loopback only, never 0.0.0.0 or localhost
DEFAULT_PORT = 8766
GESTURE_PORT = 8765  # the station gesture and health channel; not ours
MOCK_DIR = Path(__file__).resolve().parent / "mock-viz"
WRITE_LIMIT = 32 * 1024  # bytes; a client above this misses stream frames
MAX_INCOMING = 4096  # bytes; client messages are tiny
MAX_SPEED = 50.0
LIVE_RE = re.compile(r'"source"\s*:\s*"live"')
ESSENTIAL = {"viz.meta", "viz.marker"}  # always queued, even for a slow client
TAG = "[viz-replay]"


def log(msg: str) -> None:
    print(f"{TAG} {msg}", flush=True)


def is_num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _no_constants(name: str):
    raise ValueError(f"{name} is not strict JSON; put a NaN or Infinity test in a raw line")


@dataclass
class Scenario:
    name: str
    path: Path
    description: str
    screen: str
    seconds: float
    lines: list[dict]
    baseline_start: int | None  # index of the first line marked "baseline": true
    sources: list[str]  # meta.source values in the file, in order, without repeats
    live_label: bool


def load(path: Path) -> Scenario:
    """Read and check one scenario file. Raises ValueError with the line number on anything wrong."""
    text = path.read_text(encoding="utf-8")
    lines: list[dict] = []
    for n, raw in enumerate(text.splitlines(), 1):
        if not raw.strip():
            continue
        try:
            line = json.loads(raw, parse_constant=_no_constants)
        except ValueError as exc:
            raise ValueError(f"{path.name}:{n}: {exc}") from None
        if not isinstance(line, dict) or not is_num(line.get("at")) or line["at"] < 0:
            raise ValueError(f"{path.name}:{n}: each line is an object with a number 'at' >= 0")
        kinds = [k for k in ("info", "frame", "raw", "bytes") if k in line]
        if len(kinds) != 1:
            raise ValueError(f"{path.name}:{n}: want exactly one of info, frame, raw, bytes; got {kinds}")
        if "raw" in line and not isinstance(line["raw"], str):
            raise ValueError(f"{path.name}:{n}: raw must be a string")
        if "bytes" in line:
            try:
                bytes.fromhex(line["bytes"])
            except (TypeError, ValueError):
                raise ValueError(f"{path.name}:{n}: bytes must be a hex string") from None
        if lines and line["at"] < lines[-1]["at"]:
            raise ValueError(f"{path.name}:{n}: 'at' goes back in time")
        lines.append(line)
    if not lines or "info" not in lines[0]:
        raise ValueError(f"{path.name}: the first line must be the info line")
    info = lines[0]["info"]
    seconds = info.get("seconds")
    if not is_num(seconds) or seconds <= 0 or seconds < lines[-1]["at"]:
        raise ValueError(f"{path.name}: info.seconds must cover every line")
    sources: list[str] = []
    live = bool(LIVE_RE.search(text))
    for line in lines:
        frame = line.get("frame")
        if "raw" in line:
            live = live or bool(LIVE_RE.search(line["raw"]))
        if isinstance(frame, dict) and frame.get("type") == "viz.meta" and line.get("expect") != "reject":
            src = frame.get("source")
            if isinstance(src, str) and src not in sources:
                sources.append(src)
            live = live or src == "live"
    marked = [i for i, line in enumerate(lines) if line.get("baseline") is True]
    return Scenario(
        name=path.stem,
        path=path,
        description=str(info.get("description", "")),
        screen=str(info.get("screen", "")),
        seconds=float(seconds),
        lines=lines,
        baseline_start=marked[0] if marked else None,
        sources=sources,
        live_label=live,
    )


def available(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.jsonl"))


def resolve(name: str, directory: Path) -> Path:
    """A scenario by file path, full name, or number prefix ("02" or "02-right-fist-yes")."""
    p = Path(name)
    if p.suffix == ".jsonl" and p.exists():
        return p
    stem = p.stem if p.suffix == ".jsonl" else name
    exact = directory / f"{stem}.jsonl"
    if exact.exists():
        return exact
    matches = [f for f in available(directory) if f.stem.split("-", 1)[0] == stem]
    if len(matches) == 1:
        return matches[0]
    raise ValueError(f"no scenario {name!r} in {directory} (try --list)")


class Replay:
    def __init__(self, playlist: list[Scenario], args: argparse.Namespace) -> None:
        self.playlist = playlist
        self.loop_forever: bool = args.loop
        self.speed: float = args.speed
        self.exit_when_done: bool = args.exit_when_done
        self.port: int = args.port
        self.origins = None if not args.origin else [*args.origin, None]
        self.clients: set[ServerConnection] = set()
        self.last_meta: str | None = None
        self.first_client = asyncio.Event()
        self.jump = asyncio.Event()
        self.current: Scenario | None = None
        self.sent = 0
        self.skipped_slow = 0
        self.hold_at: float | None = args.hold_at
        self.holding = False
        self.newest: dict[str, tuple[float, dict]] = {}  # stream type -> (at, frame as last sent), for --hold-at

    # ---- sending ----

    def send(self, message: str | bytes, essential: bool) -> None:
        targets = []
        for ws in self.clients:
            transport = ws.transport
            if not essential and transport is not None and transport.get_write_buffer_size() > WRITE_LIMIT:
                self.skipped_slow += 1
                continue
            targets.append(ws)
        if targets:
            broadcast(targets, message)
            self.sent += len(targets)

    def send_line(self, line: dict, ids: dict[str, str]) -> None:
        if "raw" in line:
            self.send(line["raw"], False)
            return
        if "bytes" in line:
            self.send(bytes.fromhex(line["bytes"]), False)
            return
        if "frame" not in line:
            return
        frame = copy.deepcopy(line["frame"])
        kind = frame.get("type") if isinstance(frame, dict) else None
        if isinstance(frame, dict):
            now = time.time()
            if is_num(frame.get("t")):
                frame["t"] = round(now, 3)
            baseline = frame.get("baseline") if kind == "viz.meta" else None
            if isinstance(baseline, dict) and is_num(baseline.get("recordedAt")):
                baseline["recordedAt"] = round(now + (baseline["recordedAt"] - line["at"]) / self.speed, 3)
            if kind == "viz.marker" and isinstance(frame.get("id"), str):
                frame["id"] = ids.setdefault(frame["id"], str(uuid.uuid4()))
        text = json.dumps(frame, separators=(",", ":"), allow_nan=False)
        if kind == "viz.meta" and line.get("expect") != "reject":
            self.last_meta = text
        if kind in ("viz.mi", "viz.spec", "viz.quality") and not line.get("expect"):
            self.newest[kind] = (line["at"], frame)
        self.send(text, kind in ESSENTIAL)
        if kind == "viz.marker" and line.get("expect") != "reject":
            conf = frame.get("confidence")
            log(f"  +{line['at']:.2f} s marker {frame.get('command')} from {frame.get('source')}"
                f"{'' if conf is None else f' {conf}'}")
        elif kind == "viz.meta" and line.get("expect") != "reject":
            b = frame.get("baseline", {})
            log(f"  +{line['at']:.2f} s meta source={frame.get('source')} baseline={b.get('state')}"
                f" brainTest={frame.get('brainTest', {}).get('state')}")

    # ---- clients ----

    async def handler(self, ws: ServerConnection) -> None:
        # No await between these lines, so the meta is queued before any stream frame reaches this client.
        if self.last_meta is not None:
            broadcast([ws], self.last_meta)
        self.clients.add(ws)
        self.first_client.set()
        log(f"client connected ({len(self.clients)} now)")
        try:
            async for raw in ws:
                self.on_client_message(raw)
        except ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)
            log(f"client left ({len(self.clients)} now)")

    def on_client_message(self, raw: str | bytes) -> None:
        if not isinstance(raw, str):
            return
        try:
            msg = json.loads(raw)
        except (ValueError, RecursionError):
            return
        if not (isinstance(msg, dict) and msg.get("type") == "viz.cmd" and msg.get("cmd") == "baseline"):
            return
        sc = self.current
        if self.holding:
            log("viz.cmd baseline ignored: holding (--hold-at)")
        elif sc is not None and sc.baseline_start is not None:
            log(f"viz.cmd baseline: replaying the baseline frames of {sc.name}")
            self.jump.set()
        else:
            log(f"viz.cmd baseline ignored: {sc.name if sc else 'nothing playing'} has no baseline frames")

    # ---- the timeline ----

    async def wait(self, delay: float) -> bool:
        """Sleep up to delay seconds. True if a baseline jump was asked for meanwhile."""
        if self.jump.is_set():
            return True
        if delay <= 0:
            return False
        try:
            await asyncio.wait_for(self.jump.wait(), timeout=delay)
            return True
        except asyncio.TimeoutError:
            return False

    async def play(self, sc: Scenario) -> None:
        loop = asyncio.get_running_loop()
        self.current = sc
        self.jump.clear()
        labels = ", ".join(sc.sources) or "no meta"
        log(f"playing {sc.name} ({sc.seconds:g} s at {self.speed:g}x, source {labels}): {sc.description}")
        log(f"  the screen should show: {sc.screen}")
        ids: dict[str, str] = {}
        lines = sc.lines
        anchor_wall, anchor_at = loop.time(), 0.0
        i = 0
        while True:
            at = lines[i]["at"] if i < len(lines) else sc.seconds  # past the last line: the silent tail
            due = anchor_wall + (at - anchor_at) / self.speed
            if await self.wait(due - loop.time()):
                self.jump.clear()
                if sc.baseline_start is not None:
                    i = sc.baseline_start
                    anchor_wall, anchor_at = loop.time(), lines[i]["at"]
                    continue
            if self.hold_at is not None and (i >= len(lines) or at > self.hold_at + 1e-9):
                await self.hold()
            if i >= len(lines):
                break
            if loop.time() - due > 0.5:  # fell far behind (sleep, debugger); resync, no burst
                anchor_wall, anchor_at = loop.time(), at
            self.send_line(lines[i], ids)
            i += 1
        log(f"finished {sc.name}")

    async def hold(self) -> None:
        """--hold-at: keep the newest stream frames coming at the protocol rates, with a fresh t, until Ctrl-C."""
        self.holding = True
        mi = self.newest.get("viz.mi")
        fresh = mi is not None and self.hold_at - mi[0] <= 0.2
        if fresh:
            log(f"holding at {self.hold_at:g} s: repeating the newest viz.mi, viz.spec and viz.quality with a fresh t"
                " (no markers, no meta). Ctrl-C to stop.")
        else:
            log(f"holding at {self.hold_at:g} s: no frame was due then, so nothing is sent (the page shows No signal)."
                " Ctrl-C to stop.")
        loop = asyncio.get_running_loop()
        next_t = loop.time()
        k = 0
        while True:
            next_t += 0.1
            await asyncio.sleep(max(0.0, next_t - loop.time()))
            if not fresh:
                continue
            kinds = ("viz.mi", "viz.spec", "viz.quality") if k % 5 == 0 else ("viz.mi", "viz.spec")
            for kind in kinds:
                item = self.newest.get(kind)
                if item is not None:
                    frame = dict(item[1])
                    frame["t"] = round(time.time(), 3)
                    self.send(json.dumps(frame, separators=(",", ":"), allow_nan=False), False)
            k += 1

    async def timeline(self) -> None:
        log("waiting for a client (open http://localhost:3000/brain, or any port the page runs on)")
        await self.first_client.wait()
        rounds = 0
        while True:
            rounds += 1
            if self.loop_forever and len(self.playlist) > 0:
                log(f"round {rounds}")
            for sc in self.playlist:
                await self.play(sc)
            if not self.loop_forever:
                break
        self.current = None
        if self.exit_when_done:
            log("done; --exit-when-done, closing.")
            return
        log("done. Frames stopped; connections stay open, so the page shows No signal. Ctrl-C to stop.")
        await asyncio.Event().wait()

    async def run(self) -> int:
        loop = asyncio.get_running_loop()
        stop = asyncio.Event()

        def on_signal() -> None:
            stop.set()
            for sig in (signal.SIGINT, signal.SIGTERM):  # a second Ctrl-C forces it
                loop.remove_signal_handler(sig)

        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, on_signal)
        try:
            server = await serve(
                self.handler,
                HOST,
                self.port,
                origins=self.origins,
                compression=None,
                max_size=MAX_INCOMING,
                max_queue=8,
                write_limit=WRITE_LIMIT,
                ping_interval=10,
                ping_timeout=10,
                close_timeout=2,
            )
        except OSError as exc:
            print(f"{TAG} cannot listen on {HOST}:{self.port}: {exc}", file=sys.stderr)
            return 1
        try:
            for sock in server.sockets:
                if sock.getsockname()[0] != HOST:
                    print(f"{TAG} refusing: bound to {sock.getsockname()}", file=sys.stderr)
                    return 1
            log(f"SCRIPTED MOCK DATA on ws://{HOST}:{self.port}: {len(self.playlist)} scenario(s)"
                f"{', looping' if self.loop_forever else ''}. Ctrl-C to stop.")
            player = asyncio.create_task(self.timeline())
            stopper = asyncio.create_task(stop.wait())
            done, _ = await asyncio.wait({player, stopper}, return_when=asyncio.FIRST_COMPLETED)
            crash = player.exception() if player in done else None
            for task in (player, stopper):
                task.cancel()
            await asyncio.gather(player, stopper, return_exceptions=True)
            if crash is not None:
                raise crash
        finally:
            server.close()
            await server.wait_closed()
        log(f"stopped. {self.sent} frames sent, {self.skipped_slow} skipped for a slow client.")
        return 0


def print_list(paths: list[Path]) -> int:
    width = max((len(p.stem) for p in paths), default=10)
    for p in paths:
        try:
            sc = load(p)
        except ValueError as exc:
            print(f"{p.stem:<{width}}  BROKEN: {exc}")
            continue
        label = "/".join(sc.sources) or "?"
        if sc.live_label:
            label += " (test only, needs --allow-live-label)"
        print(f"{sc.name:<{width}}  {sc.seconds:5.1f} s  {label:<10}  {sc.description}")
    return 0


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Replay scripted Screen 1 scenarios on ws://127.0.0.1:8766. Not a measurement.")
    ap.add_argument("scenario", nargs="*", help="scenario names or number prefixes (02, 02-right-fist-yes) or .jsonl paths")
    ap.add_argument("--all", action="store_true", help="every scenario in tools/mock-viz, in name order")
    ap.add_argument("--loop", action="store_true", help="repeat the playlist forever")
    ap.add_argument("--list", action="store_true", help="print the scenarios with one line each and exit")
    ap.add_argument("--speed", type=float, default=1.0, help=f"playback speed, above 0 up to {MAX_SPEED:g} (default 1)")
    ap.add_argument("--host", default=HOST, help="must be 127.0.0.1; anything else is refused")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"default {DEFAULT_PORT}; 8765 is refused")
    ap.add_argument("--dir", type=Path, default=MOCK_DIR, help="scenario folder (default tools/mock-viz)")
    ap.add_argument("--allow-live-label", action="store_true", help="serve a file that says source live (test fixtures only)")
    ap.add_argument("--exit-when-done", action="store_true", help="close and exit after the last scenario")
    ap.add_argument("--hold-at", type=float, metavar="S", help="one scenario only: play to S seconds, then repeat the newest frames until Ctrl-C")
    ap.add_argument("--origin", action="append", metavar="URL", help="allow only this browser Origin (repeatable). Default: any")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.host != HOST:
        print(f"{TAG} refusing host {args.host!r}: this tool binds {HOST} only.", file=sys.stderr)
        return 2
    if args.port == GESTURE_PORT:
        print(f"{TAG} refusing port 8765: that is the station gesture and health channel.", file=sys.stderr)
        return 2
    if not 1 <= args.port <= 65535:
        print(f"{TAG} bad port {args.port}", file=sys.stderr)
        return 2
    if not 0 < args.speed <= MAX_SPEED:
        print(f"{TAG} --speed must be above 0 and at most {MAX_SPEED:g}", file=sys.stderr)
        return 2
    if args.list:
        return print_list(available(args.dir))
    if not args.scenario and not args.all:
        print(f"{TAG} name a scenario, or use --all or --list", file=sys.stderr)
        return 2
    try:
        paths = available(args.dir) if args.all else [resolve(n, args.dir) for n in args.scenario]
        playlist = [load(p) for p in paths]
    except (OSError, ValueError) as exc:
        print(f"{TAG} {exc}", file=sys.stderr)
        return 2
    kept = []
    for sc in playlist:
        if sc.live_label and not args.allow_live_label:
            if args.all:
                log(f"skipping {sc.name}: it says source live (a test fixture). --allow-live-label serves it.")
                continue
            print(f"{TAG} refusing {sc.name}: it says source live, and the page would show Live headset for a"
                  " scripted file. Pass --allow-live-label only for a test.", file=sys.stderr)
            return 2
        if sc.live_label:
            log(f"WARNING: {sc.name} says source live. The page will show Live headset for SCRIPTED data."
                " Test use only; never in front of an audience.")
        kept.append(sc)
    if not kept:
        print(f"{TAG} nothing to play", file=sys.stderr)
        return 2
    if args.hold_at is not None:
        if len(kept) != 1 or args.loop or args.all or args.exit_when_done:
            print(f"{TAG} --hold-at takes one scenario, without --all, --loop or --exit-when-done", file=sys.stderr)
            return 2
        if not 0 <= args.hold_at <= kept[0].seconds:
            print(f"{TAG} --hold-at must be between 0 and {kept[0].seconds:g} s for {kept[0].name}", file=sys.stderr)
            return 2
    logging.basicConfig(level=logging.WARNING, format=f"{TAG} %(levelname)s %(name)s: %(message)s")
    try:
        return asyncio.run(Replay(kept, args).run())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
