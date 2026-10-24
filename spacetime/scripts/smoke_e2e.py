#!/usr/bin/env python3
"""End-to-end smoke test of a NeuroLingo dev database on Maincloud (docs/spacetime.md 6.3 and 12). Owner only.

Plays every role with made-up content and prints what the database did:
  the owner      through the spacetime CLI you are logged in with (questions, pairing approval, consent, the toggle)
  a Station      over HTTPS from this process (session, heartbeats, gestures, read-back reports)
  a stand-in Agent over WebSocket: `npm run smoke -- watch --act-as-agent` (options, preview, claim, complete)

Phases, about 90 seconds in all:
  clock     a 4-option question read twice with no pick: every step after the first is a scheduled scan_tick
  picks     a yes or no question answered YES in its window; a 4-option question where a YES heard in option 1's
            window arrives after option 2 began (the grace window)
  errand    an errand option picked, previewed, every wrong release tried, then the right CONFIRM
  privacy   the anonymous board with sharing off, a refused toggle, then on with a board_text consent, then off
  deadman   heartbeats stop (the module pauses itself) and restart (it resumes)
  bench     20 heartbeat round trips confirmed and 20 unconfirmed on one kept-alive connection

Module v2 checks ride along (docs/spacetime.md 14): one speak step per option read with its rank, a select step only
for a pick, the station's word timings on one read, the option id on board_errands, the pick kept through a pause
and the end of the session, and the session-scoped board_events and board_session_ledger views.

  python3 scripts/smoke_e2e.py --station-token ~/.config/say-when/stdb_token_smoke_station \\
                               --agent-token ~/.config/say-when/stdb_token_smoke_agent [--revoke-devices]

Missing token files are created and paired (the owner CLI approves them). Refuses any database whose name does not
end in -dev: it writes sessions, questions, an errand and consent rows. It revokes the consents it granted. Tokens
are never printed. Environment: STDB_HOST, STDB_DB (default say-when-dev), SPACETIME_CLI (default: spacetime on
PATH, then ~/.local/bin/spacetime), SPACETIME_SERVER (the CLI's server nickname for owner calls, default maincloud).
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import secrets
import shutil
import signal
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE = HERE.parent
sys.path.insert(0, str(HERE))
import http_smoke as hs  # noqa: E402

DB = hs.DB
CLI = os.environ.get("SPACETIME_CLI") or shutil.which("spacetime") or str(Path.home() / ".local/bin/spacetime")
SERVER = os.environ.get("SPACETIME_SERVER", "maincloud")
T0 = time.monotonic()
results: list[tuple[str, str, str]] = []  # (check, outcome, detail)


def say(*parts: object) -> None:
    print(f"[{time.monotonic() - T0:7.2f}s]", *parts, flush=True)


def record(check: str, ok: bool, detail: str) -> None:
    results.append((check, "pass" if ok else "FAIL", detail))
    say(f"{'pass' if ok else 'FAIL'}: {check}: {detail}")


def owner(*args: str) -> tuple[int, str]:
    """One owner call through the CLI login. Returns (exit code, output without the UNSTABLE banner)."""
    r = subprocess.run(["nice", "-n", "15", CLI, "call", "--no-config", "--server", SERVER, DB, *args],
                       capture_output=True, text=True, timeout=60)
    out = (r.stdout + r.stderr).replace("WARNING: This command is UNSTABLE and subject to breaking changes.", "").strip()
    return r.returncode, out


reader = hs.Client()


def sql(query: str) -> list[dict]:
    return hs.sql_rows(reader, query)


def session_id() -> int:
    return int(sql("SELECT active_session_id FROM config")[0]["active_session_id"])


def scan(sid: int) -> dict | None:
    rows = sql(f"SELECT * FROM scan_state WHERE session_id = {sid}")
    return rows[0] if rows else None


def ledger_since(first_id: int, kind: str | None = None) -> list[dict]:
    """Ledger rows after first_id, oldest first. SQL returns rows in no fixed order, so sort by id."""
    rows = [r for r in sql("SELECT * FROM board_ledger") if r["id"] > first_id and (kind is None or r["kind"] == kind)]
    return sorted(rows, key=lambda r: int(r["id"]))


def last_ledger_id() -> int:
    return max([r["id"] for r in sql("SELECT * FROM board_ledger")] or [0])


def wait_until(fn, timeout: float, every: float = 0.25):
    """Polls fn() until it returns something truthy or the deadline passes. Always ends."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(every)
    return None


def wait_scan(sid: int, pred, timeout: float, every: float = 0.25):
    return wait_until(lambda: (lambda s: s if s is not None and pred(s) else None)(scan(sid)), timeout, every)


# ---------- Setup: identities, pairing, consent ----------

def ensure_station(token_file: Path) -> str:
    if not token_file.expanduser().exists():
        status, text, _, _ = hs.Client().request("POST", "/v1/identity")
        if status != 200:
            sys.exit(f"could not mint a station identity: HTTP {status}")
        hs.save_token(token_file, json.loads(text)["token"], force=False)
        say(f"new station identity, token in {token_file}")
    token = hs.load_token(str(token_file))
    code = 100000 + secrets.randbelow(900000)
    status, text, _, _ = hs.Client(token).call("request_pairing", [code, "station", "smoke station"])
    if status == 200:
        rc, out = owner("approve_pairing", str(code), "false")
        if rc != 0:
            sys.exit(f"approve_pairing failed: {out[:200]}")
        say("station paired")
    elif "already paired" not in text:
        sys.exit(f"station pairing refused: HTTP {status} {text[:200]}")
    return token


def ensure_agent(token_file: Path) -> None:
    code = 100000 + secrets.randbelow(900000)
    env = dict(os.environ, STDB_TOKEN_FILE=str(token_file.expanduser()), STDB_DB=DB)
    r = subprocess.run(["nice", "-n", "15", "npm", "run", "--silent", "smoke", "--", "pair", "--code", str(code)],
                       cwd=MODULE, env=env, capture_output=True, text=True, timeout=120)
    out = r.stdout + r.stderr
    if f"pairing code {code}" in out:
        rc, msg = owner("approve_pairing", str(code), "false")
        if rc != 0:
            sys.exit(f"approve_pairing failed: {msg[:200]}")
        say("agent paired")
    elif "already paired" not in out:
        sys.exit(f"agent pairing failed:\n{out[-600:]}")


def grant(scope: str, subject: str, note: str) -> int:
    """Grants a consent row and returns its id, read back from the public ledger (`consent:<id>`)."""
    before = last_ledger_id()
    rc, out = owner("grant_consent", scope, subject, "owner_cli", note)
    if rc != 0:
        sys.exit(f"grant_consent {scope} failed: {out[:200]}")
    rows = [r for r in ledger_since(before, "consent") if r["outcome"] == f"granted:{scope}"]
    return int(re.sub(r"\D", "", rows[-1]["reason"])) if rows else 0


# ---------- The station's heartbeats ----------

class Beats(threading.Thread):
    """Heartbeats every 500 ms over HTTPS while `on` is set, the way the station page beats."""

    def __init__(self, token: str) -> None:
        super().__init__(daemon=True)
        self.client = hs.Client(token)
        self.seq = int(time.time() * 1000)
        self.on = threading.Event()
        self.stop = threading.Event()
        self.rtts: list[float] = []
        self.failures: list[str] = []

    def run(self) -> None:
        next_at = time.monotonic()
        while not self.stop.is_set():
            if self.on.is_set():
                self.seq += 1
                try:
                    status, text, ms, _ = self.client.call("heartbeat", [self.seq, True], confirmed=False)
                    self.rtts.append(ms)
                    if status != 200:
                        self.failures.append(f"{status} {text[:80]}")
                except (OSError, http.client.HTTPException) as e:
                    self.failures.append(type(e).__name__)
            next_at += 0.5
            delay = next_at - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            else:
                next_at = time.monotonic()


# ---------- Phases ----------

def gesture(station: hs.Client, command: str, step: int = 0, digest: str = "") -> int:
    gid = f"smoke-{command.lower()}-{secrets.token_hex(4)}"
    status, _, _, _ = station.call("gesture", [gid, command, step, 0, digest, 0.9, "key", 0])
    return status


def outcome_of(first_id: int, gesture_status: int) -> str:
    rows = ledger_since(first_id, "gesture")
    return rows[-1]["outcome"] if rows else f"HTTP {gesture_status}, no ledger row"


def events_of(question_id: int) -> list[dict]:
    """One question's pipeline events from the session-scoped board view (module v2), oldest first."""
    rows = [e for e in sql("SELECT * FROM board_events") if int(e["question_id"]) == question_id]
    return sorted(rows, key=lambda e: int(e["id"]))


def reads_of(events: list[dict]) -> list[dict]:
    return [e for e in events if e["stage"] == "speak" and e["detail"] == "reading option"]


def phase_clock(station: hs.Client, sid: int) -> None:
    rc, out = owner("ask_question", f"smoke-{secrets.token_hex(4)}", "Smoke test: which drink?", "typed", "0")
    t_ask = time.monotonic()
    started = wait_scan(sid, lambda s: s["phase"] == "reading" and int(s["version"]) > 0, 20)
    record("options drafted and scan started", bool(started) and rc == 0,
           f"{time.monotonic() - t_ask:.1f} s after the ask (4 s of it is the clip deadline, no station synthesizes)" if started else out[:120])
    ended = wait_scan(sid, lambda s: s["phase"] == "idle" and s["outcome"] is not None, 90)
    record("two passes with no pick end in no pick", bool(ended) and ended["outcome"] == "noPick",
           f"outcome {ended['outcome'] if ended else 'none'} {time.monotonic() - t_ask:.1f} s after the ask")
    events = events_of(int(ended["question_id"])) if ended else []
    ranks = [json.loads(e["counts_json"]).get("rank") for e in reads_of(events)]
    record("each option read is its own speak step with its rank (module v2)", ranks == [1, 2, 3, 4, 1, 2, 3, 4],
           f"read ranks {ranks}")
    selects = [e for e in events if e["stage"] == "select"]
    record("a scan that ends with no pick writes no select step (module v2)", bool(ended) and not selects,
           f"{len(selects)} select steps; the outcome is on scan_state")


def phase_picks(station: hs.Client, sid: int) -> None:
    first = last_ledger_id()
    owner("ask_question", f"smoke-{secrets.token_hex(4)}", "Smoke test [yes_no]: is the room warm enough?", "typed", "0")
    s = wait_scan(sid, lambda s: s["phase"] == "window" and s["answer_mode"] == "yesNo", 30, 0.15)
    status = gesture(station, "YES", int(s["step_seq"])) if s else 0
    ended = wait_scan(sid, lambda s: s["phase"] == "idle" and s["answer_mode"] == "yesNo" and s["outcome"] is not None, 20)
    record("YES in a yes or no window picks the yes reply after the veto", bool(ended) and ended["outcome"] == "picked",
           f"{outcome_of(first, status)}; scan outcome {ended['outcome'] if ended else 'none'}")

    first = last_ledger_id()
    q_before = int(scan(sid)["question_id"])
    owner("ask_question", f"smoke-{secrets.token_hex(4)}", "Smoke test: which snack?", "typed", "0")
    s = wait_scan(sid, lambda s: s["phase"] == "reading" and s["answer_mode"] == "pick" and int(s["cursor"]) == 2
                  and int(s["question_id"]) > q_before, 40, 0.1)
    status = gesture(station, "YES", int(s["step_seq"]) - 1) if s else 0  # heard during option 1's window
    done = wait_scan(sid, lambda s: s["phase"] == "idle" and int(s["question_id"]) > q_before and s["outcome"] is not None, 20)
    picks = ledger_since(first, "pick")
    late = int(picks[-1]["ms"]) if picks else -1
    record("a late YES inside the grace window picks the option the person heard",
           bool(picks) and int(picks[-1]["cursor"]) == 1 and late > 0,
           f"{outcome_of(first, status)}; picked rank {picks[-1]['cursor'] if picks else '?'} with late_by_ms {late}")

    # Module v2: the pick is one select step naming the option, and the station's word timings attach to one read.
    events = events_of(int(done["question_id"])) if done else []
    selects = [e for e in events if e["stage"] == "select"]
    counts = json.loads(selects[0]["counts_json"]) if len(selects) == 1 else {}
    record("a pick writes one select step with the option id and rank (module v2)",
           len(selects) == 1 and selects[0]["detail"] == "picked" and int(counts.get("optionId", 0)) > 0 and counts.get("rank") == 1,
           f"{len(selects)} select steps, counts {counts}")
    reads = reads_of(events)
    if not reads:
        record("the station's word timings attach to one read, once (module v2)", False, "no read step to attach to")
        return
    read = reads[0]
    c = json.loads(read["counts_json"])
    args = [sid, int(c["stepSeq"]), int(c["optionId"]), [0, 240], [220, 520]]
    first_status, text, _, _ = station.call("report_word_timings", args)
    again_status, _, _, _ = station.call("report_word_timings", [*args[:3], [5], [9]])  # a retry changes nothing
    rows = [r for r in sql("SELECT * FROM board_word_timings") if int(r["event_id"]) == int(read["id"])]
    record("the station's word timings attach to one read, once (module v2)",
           first_status == 200 and again_status == 200 and len(rows) == 1 and rows[0]["starts_ms"] == [0, 240] and rows[0]["ends_ms"] == [220, 520],
           f"HTTP {first_status} then {again_status}; rows {[(r['rank'], r['starts_ms'], r['ends_ms']) for r in rows]} {text[:80]}")


def phase_errand(station: hs.Client, sid: int) -> None:
    q_before = int(scan(sid)["question_id"])
    owner("ask_question", f"smoke-{secrets.token_hex(4)}", "Smoke test [errand]: send the request?", "typed", "0")
    s = wait_scan(sid, lambda s: s["phase"] == "reading" and int(s["cursor"]) == 1 and int(s["question_id"]) > q_before
                  and int(s["version"]) > 0, 30, 0.15)
    first = last_ledger_id()
    gesture(station, "YES", int(s["step_seq"])) if s else None
    e = wait_until(lambda: next((r for r in sql("SELECT * FROM board_errands") if r["status"] == "previewed"), None), 20)
    record("YES on an errand option drafts it; the agent previews it", bool(e),
           f"errand {e['errand_id']} previewed, digest {e['preview_digest']}" if e else "no preview")
    if not e:
        return
    record("board_errands names the option the person picked (module v2)", int(e.get("option_id") or 0) > 0,
           f"option_id {e.get('option_id')}")
    eid, digest = int(e["errand_id"]), e["preview_digest"]
    time.sleep(1.1)  # past the refractory window of the YES that picked it
    wrong = []
    wrong.append(("YES during the read-back", gesture(station, "YES", int(scan(sid)["step_seq"])), "ignored:yes_is_not_confirm"))
    wrong.append(("CONFIRM before the read-back finished", gesture(station, "CONFIRM", 0, digest), "ignored:readback_not_done"))
    status, text, _, _ = station.call("report_readback_done", ["errand", eid, "0000000000000000"])
    record("a stale read-back digest is refused", status == 530 and "digest mismatch" in text, f"HTTP {status} {text[:80]}")
    status, _, _, _ = station.call("report_readback_done", ["errand", eid, digest])
    wrong.append(("CONFIRM inside the quiet hold", gesture(station, "CONFIRM", 0, digest), "ignored:quiet_hold"))
    time.sleep(1.3)
    wrong.append(("CONFIRM with a digest the person did not hear", gesture(station, "CONFIRM", 0, "ffffffffffffffff"), "ignored:digest_mismatch"))
    t_confirm = time.monotonic()
    good = gesture(station, "CONFIRM", 0, digest)
    wrong.append(("a second CONFIRM", gesture(station, "CONFIRM", 0, digest), "ignored:refractory"))
    outcomes = [r["outcome"] for r in ledger_since(first, "gesture")]
    expected = ["accepted:pick_errand", wrong[0][2], wrong[1][2], wrong[2][2], wrong[3][2], "accepted:confirm", wrong[4][2]]
    record("every wrong release is recorded and ignored; the right CONFIRM is accepted",
           outcomes == expected and good == 200, ", ".join(outcomes))
    done = wait_until(lambda: next((r for r in sql("SELECT * FROM board_errands")
                                    if int(r["errand_id"]) == eid and r["status"] == "submitted"), None), 20)
    record("the agent claims the confirmed errand with its digest and completes it", bool(done),
           f"submitted {time.monotonic() - t_confirm:.2f} s after the CONFIRM returned (stand-in agent; nothing sent)" if done else "not submitted")


def phase_privacy() -> list[int]:
    b = sql("SELECT * FROM board_errands")
    q = sql("SELECT * FROM public_board")
    last = max(q, key=lambda r: int(r["question_id"])) if q else {}
    off_ok = bool(b) and b[-1]["read_back_text"] == "" and str(last.get("text", "")).startswith("Question")
    record("sharing off: the anonymous board shows Question N and Option N, no read-back", off_ok,
           f"text {last.get('text')!r}, labels {[o['label'] for o in last.get('options', [])]}")
    rc, out = owner("set_board_sharing", "true")
    record("sharing on without a board_text consent is refused", rc != 0 and "no board_text consent" in out, out.splitlines()[0][:80] if out else "")
    consent_id = grant("board_text", "", "smoke test")
    rc, _ = owner("set_board_sharing", "true")
    q = sql("SELECT * FROM public_board")
    last = max(q, key=lambda r: int(r["question_id"])) if q else {}
    record("sharing on with consent shows the text", rc == 0 and not str(last.get("text", "")).startswith("Question"),
           f"text {last.get('text')!r}")
    owner("set_board_sharing", "false")
    return [consent_id]


def phase_deadman(beats: Beats, sid: int) -> None:
    first = last_ledger_id()
    beats.on.clear()
    stopped = time.monotonic()
    paused = wait_scan(sid, lambda s: s["phase"] == "paused", 10)
    rows = ledger_since(first, "pause")
    record("no heartbeat for the lease: the module pauses itself", bool(paused) and bool(rows),
           f"{rows[-1]['outcome']} {rows[-1]['ms']} ms after the last beat (server clocks; lease 1500 ms); "
           f"seen here {time.monotonic() - stopped:.1f} s after the beats stopped" if rows else "no pause")
    # Module v2: the errand pick ended the last scan Picked, and a pause keeps that pick.
    record("a paused scan keeps the pick it ended with (module v2)",
           bool(paused) and paused["outcome"] == "picked" and paused["picked_option_id"] is not None,
           f"outcome {paused['outcome'] if paused else None}, picked_option_id {paused['picked_option_id'] if paused else None}")
    beats.on.set()
    restarted = time.monotonic()
    resumed = wait_scan(sid, lambda s: s["phase"] != "paused", 15)
    record("healthy beats resume it after the good-contact time", bool(resumed),
           f"resumed, seen {time.monotonic() - restarted:.1f} s after beats restarted (needs 3 s of good contact)")


def phase_bench(token: str, n: int) -> None:
    client = hs.Client(token)
    seq = int(time.time() * 1000) + 50_000_000
    seq += 1
    status, _, first_ms, _ = client.call("heartbeat", [seq, True])
    for confirmed in (True, False):
        rtts: list[float] = []
        exec_us: list[float] = []
        for _ in range(n):
            seq += 1
            status, text, ms, headers = client.call("heartbeat", [seq, True], confirmed=confirmed)
            if status != 200:
                break
            rtts.append(ms)
            if "spacetime-execution-duration-micros" in headers:
                exec_us.append(float(headers["spacetime-execution-duration-micros"]))
        label = "confirmed (default)" if confirmed else "confirmed=false"
        record(f"HTTP reducer round trip, {label}", len(rtts) == n,
               f"{hs.summary(rtts)}; host execution median {statistics.median(exec_us) if exec_us else 0:.0f} us; "
               f"first call with the TLS handshake {first_ms:.0f} ms")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--station-token", required=True, type=Path)
    p.add_argument("--agent-token", required=True, type=Path)
    p.add_argument("--bench", type=int, default=20, help="round trips per mode; 0 skips the bench")
    p.add_argument("--revoke-devices", action="store_true", help="revoke the smoke station and agent at the end")
    a = p.parse_args()
    if not DB.endswith("-dev"):
        sys.exit("this test writes sessions, an errand and consent rows, so it runs only on a database ending in -dev")
    if not Path(CLI).exists():
        sys.exit(f"spacetime CLI not found at {CLI}; set SPACETIME_CLI")

    station_token = ensure_station(a.station_token)
    ensure_agent(a.agent_token)
    consents = [grant("errand", "smoke_form", "smoke test, nothing is sent")]

    env = dict(os.environ, STDB_TOKEN_FILE=str(a.agent_token.expanduser()), STDB_DB=DB)
    log_path = Path(os.environ.get("TMPDIR", "/tmp")) / f"say-when-smoke-watch-{os.getpid()}.log"
    log = open(log_path, "w")
    watcher = subprocess.Popen(["nice", "-n", "15", "npm", "run", "--silent", "smoke", "--", "watch", "--act-as-agent", "--seconds", "400"],
                               cwd=MODULE, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    station = hs.Client(station_token)
    beats = Beats(station_token)
    beats.start()
    code = 1
    try:
        time.sleep(4)  # the watcher connects and subscribes
        status, text, _, _ = station.call("start_session", ["smoke"])
        if status != 200:
            sys.exit(f"start_session: HTTP {status} {text[:200]} (end the active session first: spacetime call ... end_session)")
        beats.on.set()
        sid = session_id()
        say(f"session {sid} started; watcher log {log_path}")
        phase_clock(station, sid)
        phase_picks(station, sid)
        phase_errand(station, sid)
        consents += phase_privacy()
        phase_deadman(beats, sid)
        if a.bench > 0:
            beats.on.clear()
            phase_bench(station_token, a.bench)
        beats.on.clear()
        status, _, _, _ = station.call("end_session", [])
        record("the station ends the session", status == 200, f"HTTP {status}")
        s = scan(sid)
        record("ending the session keeps the pick the scan ended with (module v2)",
               bool(s) and s["outcome"] == "picked" and s["picked_option_id"] is not None,
               f"outcome {s['outcome'] if s else None}, picked_option_id {s['picked_option_id'] if s else None}")
        events, ledger = sql("SELECT * FROM board_events"), sql("SELECT * FROM board_session_ledger")
        record("board_events and board_session_ledger hold only this session (module v2)",
               bool(events) and bool(ledger) and all(int(r["session_id"]) == sid for r in events + ledger)
               and any(r["kind"] == "session_end" for r in ledger),
               f"{len(events)} events and {len(ledger)} ledger rows, all of session {sid}")
        status, text, ms, _ = hs.Client().request("GET", f"/v1/database/{DB}/route/stats")
        record("GET /route/stats answers with numbers recomputed from the ledger", status == 200, f"{ms:.0f} ms {text}")
        code = 0 if all(r[1] == "pass" for r in results) else 1
    finally:
        beats.stop.set()
        for cid in consents:
            if cid:
                owner("revoke_consent", str(cid))
        if a.revoke_devices:
            for rows in (sql("SELECT * FROM device_status"),):
                for d in rows:
                    if d["label"] in ("smoke station", "smoke agent"):
                        owner("revoke_device", d["identity"])
        try:
            os.killpg(watcher.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            watcher.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(watcher.pid, signal.SIGKILL)
            watcher.wait(timeout=10)
        log.close()
    print("\nWatcher summary (scan_state as one WebSocket client saw it):")
    print("\n".join(line for line in log_path.read_text().splitlines() if "stopping" in line or "lateness" in line
                    or "drift" in line or "updates seen" in line or "jobs claimed" in line or "cues:" in line))
    print(f"\n{sum(r[1] == 'pass' for r in results)} of {len(results)} checks passed on {DB}")
    return code


if __name__ == "__main__":
    sys.exit(main())
