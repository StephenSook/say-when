#!/usr/bin/env python3
"""Talk to the Eleven SpacetimeDB module over plain HTTPS, with the Python standard library only.

This is the reference for any Python process that calls the module (the headset decoder's fallback path,
docs/spacetime.md 7.5) and the tool behind the HTTP numbers in spacetime/README.md. It never prints a token:
each identity's token lives in a file with mode 0600, outside the repo by default.

  python3 http_smoke.py identity --token-file ~/.config/say-when/stdb_token_station
  python3 http_smoke.py pair     --token-file ~/.config/say-when/stdb_token_station --role station --label "station 1"
  python3 http_smoke.py call     --token-file ~/.config/say-when/stdb_token_station start_session '["demo"]'
  python3 http_smoke.py call     --token-file ~/.config/say-when/stdb_token_station mint_voice_token '["tts"]'
  python3 http_smoke.py sql      "SELECT * FROM scan_state"
  python3 http_smoke.py route    stats
  python3 http_smoke.py beat     --token-file ... --seconds 30 [--start-session smoke]
  python3 http_smoke.py bench    --token-file ... --n 20
  python3 http_smoke.py pick     --token-file ... --timeout 30

Environment: STDB_HOST (default https://maincloud.spacetimedb.com; http://127.0.0.1:3000 for a local server)
and STDB_DB (default say-when-dev).

HTTP facts this relies on (checked against say-when-dev on Oct 24, 2026): a call is
POST /v1/database/<db>/call/<name> with a JSON array of the arguments in order; 200 means committed (a procedure
returns its value as JSON); 530 means the module refused (SenderError, do not retry); every call without a token
runs as a fresh anonymous identity.
"""

from __future__ import annotations

import argparse
import http.client
import json
import math
import os
import secrets
import statistics
import sys
import time
import urllib.parse
from pathlib import Path

HOST_URL = os.environ.get("STDB_HOST", "https://maincloud.spacetimedb.com")
DB = os.environ.get("STDB_DB", "say-when-dev")
ROLES = ("station", "partner", "speaker", "agent")


class Client:
    """One kept-alive HTTPS connection to the host. A token makes every call run as that identity.

    Maincloud closes an idle kept-alive connection (seen after about two minutes on Oct 24), and a request sent on
    a closed socket fails with no way to know whether it ran. So a connection idle for IDLE_RECONNECT_S is replaced
    before the next request, never after a failure."""

    IDLE_RECONNECT_S = 20.0

    def __init__(self, token: str | None = None, timeout: float = 10.0) -> None:
        url = urllib.parse.urlsplit(HOST_URL if "://" in HOST_URL else f"https://{HOST_URL}")
        self.secure = url.scheme == "https"
        self.netloc = url.netloc
        self.token = token
        self.timeout = timeout
        self.conn = self._connect()
        self.last_used = time.monotonic()

    def _connect(self) -> http.client.HTTPConnection:
        cls = http.client.HTTPSConnection if self.secure else http.client.HTTPConnection
        return cls(self.netloc, timeout=self.timeout)

    def reconnect(self) -> None:
        self.conn.close()
        self.conn = self._connect()

    def request(self, method: str, path: str, body: bytes | None = None, content_type: str = "application/json"):
        """Returns (status, text, milliseconds, lowercase headers). Never retries: a POST that failed in flight
        may still have run, so the caller decides (every reducer here is idempotent or fenced)."""
        headers = {}
        if body is not None:
            headers["Content-Type"] = content_type
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if time.monotonic() - self.last_used > self.IDLE_RECONNECT_S:
            self.reconnect()
        t0 = time.perf_counter()
        try:
            self.conn.request(method, path, body=body, headers=headers)
            resp = self.conn.getresponse()
            data = resp.read()
        except (OSError, http.client.HTTPException):
            self.reconnect()
            raise
        finally:
            self.last_used = time.monotonic()
        ms = (time.perf_counter() - t0) * 1000.0
        return resp.status, data.decode("utf-8", "replace"), ms, {k.lower(): v for k, v in resp.getheaders()}

    def call(self, name: str, args: list, confirmed: bool = True):
        query = "" if confirmed else "?confirmed=false"
        return self.request("POST", f"/v1/database/{DB}/call/{name}{query}", json.dumps(args).encode())


# ---------- Tokens: a file with mode 0600, never printed ----------

def save_token(path: Path, token: str, force: bool) -> None:
    path = path.expanduser()
    if path.exists() and not force:
        sys.exit(f"{path} already exists; pass --force to replace it")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    os.chmod(path, 0o600)


def load_token(path: str | None) -> str | None:
    if not path:
        return None
    token = Path(path).expanduser().read_text().strip()
    if not token:
        sys.exit(f"{path} is empty")
    return token


# ---------- SQL over HTTP ----------

def sql_rows(client: Client, query: str) -> list[dict]:
    """Rows as dicts keyed by column name, decoded with the schema the answer carries (see decode)."""
    status, text, _, _ = client.request("POST", f"/v1/database/{DB}/sql", query.encode(), "text/plain")
    if status != 200:
        raise RuntimeError(f"sql answered {status}: {text[:200]}")
    rows: list[dict] = []
    for statement in json.loads(text):
        elements = statement["schema"]["elements"]
        for row in statement["rows"]:
            rows.append({e["name"].get("some", str(i)): decode(v, e["algebraic_type"])
                         for i, (e, v) in enumerate(zip(elements, row))})
    return rows


_WRAPPERS = ("__identity__", "__connection_id__", "__timestamp_micros_since_unix_epoch__", "__time_duration_micros__")


def decode(value, atype: dict):
    """SATS-JSON from the SQL endpoint: a sum is [variant index, payload], an option is a sum named some/none,
    and identities and timestamps are one-field products. Enums come back as their (snake case) variant name,
    options as the value or None, timestamps as microseconds, identities as hex."""
    if "Sum" in atype:
        variants = atype["Sum"]["variants"]
        names = [v["name"].get("some", "") for v in variants]
        index, payload = value
        if names == ["some", "none"]:
            return decode(payload, variants[0]["algebraic_type"]) if index == 0 else None
        inner = variants[index]["algebraic_type"]
        if inner.get("Product", {}).get("elements") == []:
            return names[index]
        return {names[index]: decode(payload, inner)}
    if "Product" in atype:
        elements = atype["Product"]["elements"]
        if len(elements) == 1 and elements[0]["name"].get("some") in _WRAPPERS:
            return value[0]
        return {e["name"].get("some", str(i)): decode(v, e["algebraic_type"])
                for i, (e, v) in enumerate(zip(elements, value))}
    if "Array" in atype:
        return [decode(v, atype["Array"]) for v in value]
    return value


# ---------- Numbers ----------

def summary(values: list[float]) -> str:
    if not values:
        return "no samples"
    ordered = sorted(values)
    p95 = ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)]
    return (f"n={len(ordered)} median={statistics.median(ordered):.0f} ms p95={p95:.0f} ms "
            f"max={ordered[-1]:.0f} ms min={ordered[0]:.0f} ms")


# ---------- Commands ----------

def cmd_identity(a: argparse.Namespace) -> int:
    status, text, ms, _ = Client().request("POST", "/v1/identity")
    if status != 200:
        print(f"identity: HTTP {status} {text[:200]}")
        return 1
    data = json.loads(text)
    save_token(Path(a.token_file), data["token"], a.force)
    print(f"identity {data['identity']} ({ms:.0f} ms); token saved to {a.token_file} with mode 600")
    return 0


def cmd_pair(a: argparse.Namespace) -> int:
    client = Client(load_token(a.token_file))
    code = 100000 + secrets.randbelow(900000)
    status, text, ms, _ = client.call("request_pairing", [code, a.role, a.label])
    if status != 200:
        print(f"request_pairing: HTTP {status} {text[:200]}")
        return 1
    print(f"pairing code {code} for role {a.role} ({ms:.0f} ms). The owner approves it with:")
    print(f"  spacetime call --no-config --server maincloud {DB} approve_pairing {code} false")
    return 0


def cmd_call(a: argparse.Namespace) -> int:
    client = Client(load_token(a.token_file))
    args = json.loads(a.args)
    if not isinstance(args, list):
        sys.exit("arguments must be a JSON array, in the reducer's order")
    status, text, ms, headers = client.call(a.name, args, confirmed=not a.unconfirmed)
    shown = text
    if a.name == "mint_voice_token" and status == 200:
        # Never print a token: show only whether one came back, its expiry and the error code.
        shown = redact_voice_token(text)
    energy = headers.get("spacetime-energy-used", "?")
    print(f"{a.name}: HTTP {status} in {ms:.0f} ms (energy {energy}) {shown[:400]}")
    return 0 if status == 200 else 1


def redact_voice_token(text: str) -> str:
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return "<unparsed>"
    if isinstance(value, list) and len(value) == 3:
        token, expires, error = value
    elif isinstance(value, dict):
        token, expires, error = value.get("token", ""), value.get("expires_at_ms", 0), value.get("error", "")
    else:
        return "<unexpected shape>"
    return json.dumps({"token": f"<{len(token)} characters>" if token else "", "expires_at_ms": expires, "error": error})


def cmd_sql(a: argparse.Namespace) -> int:
    client = Client(load_token(a.token_file))
    t0 = time.perf_counter()
    rows = sql_rows(client, a.query)
    print(f"{len(rows)} rows in {(time.perf_counter() - t0) * 1000:.0f} ms")
    for row in rows:
        print(json.dumps(row))
    return 0


def cmd_route(a: argparse.Namespace) -> int:
    status, text, ms, headers = Client().request("GET", f"/v1/database/{DB}/route/{a.path.lstrip('/')}")
    cors = headers.get("access-control-allow-origin", "")
    print(f"GET /route/{a.path.lstrip('/')}: HTTP {status} in {ms:.0f} ms (cors {cors or 'none'}) {text[:600]}")
    return 0 if status == 200 else 1


def cmd_beat(a: argparse.Namespace) -> int:
    """Heartbeats from a paired Station for a bounded time, the way the station page beats (docs 3.4)."""
    client = Client(load_token(a.token_file))
    if a.start_session:
        status, text, ms, _ = client.call("start_session", [a.start_session])
        print(f"start_session: HTTP {status} in {ms:.0f} ms {text[:200]}", flush=True)
        if status != 200:
            return 1
    seq = int(time.time() * 1000)
    rtts: list[float] = []
    failures = 0
    end = time.monotonic() + a.seconds
    next_at = time.monotonic()
    while time.monotonic() < end:
        seq += 1
        try:
            status, text, ms, _ = client.call("heartbeat", [seq, not a.unhealthy], confirmed=a.confirmed)
            rtts.append(ms)
            if status != 200:
                failures += 1
                print(f"heartbeat {seq}: HTTP {status} {text[:200]}", flush=True)
        except (OSError, http.client.HTTPException) as e:
            failures += 1
            print(f"heartbeat {seq}: {type(e).__name__}", flush=True)
        next_at += a.interval
        delay = next_at - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            next_at = time.monotonic()
    late = sum(1 for r in rtts if r > a.interval * 1000)
    print(f"beat: {len(rtts)} heartbeats, {failures} failed, {late} slower than the {a.interval:.1f} s interval; "
          f"{summary(rtts)}", flush=True)
    return 0 if failures == 0 else 1


def cmd_bench(a: argparse.Namespace) -> int:
    """Round trips of a real write reducer (heartbeat) on one kept-alive connection, confirmed and not."""
    client = Client(load_token(a.token_file))
    seq = int(time.time() * 1000)
    seq += 1
    status, text, first_ms, _ = client.call("heartbeat", [seq, True])  # opens the connection; not counted
    if status != 200:
        print(f"heartbeat: HTTP {status} {text[:200]} (needs a paired Station with an active session)")
        return 1
    print(f"first call, including the TLS handshake: {first_ms:.0f} ms")
    for confirmed in (True, False):
        rtts: list[float] = []
        energy: list[float] = []
        exec_us: list[float] = []
        for _ in range(a.n):
            seq += 1
            status, text, ms, headers = client.call("heartbeat", [seq, True], confirmed=confirmed)
            if status != 200:
                print(f"heartbeat: HTTP {status} {text[:200]}")
                return 1
            rtts.append(ms)
            if "spacetime-energy-used" in headers:
                energy.append(float(headers["spacetime-energy-used"]))
            if "spacetime-execution-duration-micros" in headers:
                exec_us.append(float(headers["spacetime-execution-duration-micros"]))
        label = "confirmed=true (default, waits for durability)" if confirmed else "confirmed=false"
        print(f"{label}: {summary(rtts)}")
        if exec_us:
            print(f"  reducer execution on the host: median {statistics.median(exec_us):.0f} us")
        if energy:
            print(f"  energy per call: median {statistics.median(energy):.0f}")
    return 0


def cmd_pick(a: argparse.Namespace) -> int:
    """Waits (bounded) for the active session's scan to enter a response window, then sends YES for that step."""
    station = Client(load_token(a.token_file))
    reader = Client()
    config = sql_rows(reader, "SELECT active_session_id FROM config")
    session_id = config[0]["active_session_id"] if config else 0
    deadline = time.monotonic() + a.timeout
    while time.monotonic() < deadline:
        rows = sql_rows(reader, f"SELECT * FROM scan_state WHERE session_id = {int(session_id)}")
        if rows and rows[0]["phase"] == "window":
            step = int(rows[0]["step_seq"])
            gesture_id = f"smoke-yes-{secrets.token_hex(6)}"
            status, text, ms, _ = station.call(
                "gesture", [gesture_id, "YES", step, 0, "", 0.9, "key", 0])
            print(f"YES at step {step} (cursor {rows[0]['cursor']}, pass {rows[0]['pass']}): HTTP {status} "
                  f"in {ms:.0f} ms; gesture id {gesture_id}")
            return 0 if status == 200 else 1
        time.sleep(0.25)
    print(f"no response window within {a.timeout:.0f} s")
    return 1


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("identity", help="mint a new identity and save its token")
    s.add_argument("--token-file", required=True)
    s.add_argument("--force", action="store_true")
    s.set_defaults(fn=cmd_identity)

    s = sub.add_parser("pair", help="ask to pair this identity as one role")
    s.add_argument("--token-file", required=True)
    s.add_argument("--role", choices=ROLES, required=True)
    s.add_argument("--label", required=True, help="public, so neutral: 'station 1', never a name")
    s.set_defaults(fn=cmd_pair)

    s = sub.add_parser("call", help="call one reducer or procedure")
    s.add_argument("--token-file")
    s.add_argument("--unconfirmed", action="store_true", help="return once committed in memory")
    s.add_argument("name")
    s.add_argument("args", nargs="?", default="[]", help="JSON array, in the reducer's order")
    s.set_defaults(fn=cmd_call)

    s = sub.add_parser("sql", help="run a SELECT (public tables and views without a token)")
    s.add_argument("--token-file")
    s.add_argument("query")
    s.set_defaults(fn=cmd_sql)

    s = sub.add_parser("route", help="GET one of the module's HTTP routes")
    s.add_argument("path")
    s.set_defaults(fn=cmd_route)

    s = sub.add_parser("beat", help="heartbeat as the session's Station for a bounded time")
    s.add_argument("--token-file", required=True)
    s.add_argument("--seconds", type=float, default=30.0)
    s.add_argument("--interval", type=float, default=0.5)
    s.add_argument("--start-session", metavar="LABEL")
    s.add_argument("--unhealthy", action="store_true", help="send decoder_healthy = false")
    s.add_argument("--confirmed", action="store_true", help="wait for durability on each beat")
    s.set_defaults(fn=cmd_beat)

    s = sub.add_parser("bench", help="time N heartbeat round trips, confirmed and not")
    s.add_argument("--token-file", required=True)
    s.add_argument("--n", type=int, default=20)
    s.set_defaults(fn=cmd_bench)

    s = sub.add_parser("pick", help="send YES in the next response window of the active scan")
    s.add_argument("--token-file", required=True)
    s.add_argument("--timeout", type=float, default=30.0)
    s.set_defaults(fn=cmd_pick)

    a = p.parse_args()
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
