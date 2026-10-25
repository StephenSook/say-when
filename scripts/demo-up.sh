#!/usr/bin/env bash
# Starts the Eleven demo backend on this Mac: the agent sidecar (Claude planner, Apify search and maps, the form-errand
# Actor, Moss memory, Cartesia voice tokens and, when asked, consented phone calls), kept awake with caffeinate.
#
#   scripts/demo-up.sh --db say-when-demo [--calls] [--port 8791] [--moss-session NAME] [--no-warm] [--dry-run] [up]
#   scripts/demo-up.sh --db say-when-demo status     # is it running, and what does /healthz say
#   scripts/demo-up.sh --db say-when-demo warm       # right before a judge: wake the Actor, open Moss, mint one voice token
#   scripts/demo-up.sh --db say-when-demo stop       # clean stop, by exact pid
#   scripts/demo-up.sh --db say-when-demo pair       # once per database: pair the sidecar as Agent and approve it
#
# docs/demo-runbook.md has the whole morning. Rules this script keeps:
#
# - Only say-when-dev and say-when-demo. The judge try sandbox (say-when-try) has its own service and caps.
# - Keys come from the macOS Keychain at run time, go only into the sidecar's environment, and are never printed,
#   logged or written to a file. Settings files are skipped (AGENT_ENV_FILES=off); the call settings are copied from
#   the repo's private .env.local by name, never printed.
# - Calls are off unless --calls is given, and --calls starts the sidecar only when the private consent file and every
#   call setting are present and `npm run call:check` (cartesia/) passes with no contact every call would refuse.
#   Otherwise it stops and says why; run it again without --calls to go on with calls off.
# - Each database keeps its own Moss memory (session name = the database name, under moss/.memory), so a dev
#   rehearsal never writes into the demo's memory. The dev database may not use say-when-demo's memory, and the demo
#   database may not use say-when-dev's.
# - The health endpoint listens on 127.0.0.1 only. A port already answering (8790 is the try sidecar) is refused.
# - The log goes to ~/.config/say-when/demo-up/<database>-<time>.log (mode 600). It holds the sidecar's fixed
#   messages: ids, codes, counts and times, never a key or any content.
#
# Test hooks (scripts/test/demo-up.test.mjs): DEMO_UP_STATE_DIR, DEMO_UP_TOKEN_DIR, DEMO_UP_ENV_FILE, and
# DEMO_UP_CALL_CHECK (a command run instead of `npm run call:check`), which counts only together with
# DEMO_UP_TEST_HOOKS=1 and says so when it is used. bash 3.2 compatible (macOS).

set -euo pipefail

usage() {
    echo "usage: $0 --db say-when-dev|say-when-demo [--calls] [--port N] [--moss-session NAME] [--no-warm] [--dry-run] [up|status|warm|stop|pair]" >&2
    exit 2
}

die() {
    echo "demo-up: $*" >&2
    exit 1
}

db=""
command="up"
calls=0
port=8791
moss_session=""
warm=1
dry_run=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --db) [ "$#" -ge 2 ] || usage; db="$2"; shift 2 ;;
        --calls) calls=1; shift ;;
        --port) [ "$#" -ge 2 ] || usage; port="$2"; shift 2 ;;
        --moss-session) [ "$#" -ge 2 ] || usage; moss_session="$2"; shift 2 ;;
        --no-warm) warm=0; shift ;;
        --dry-run) dry_run=1; shift ;;
        up | status | warm | stop | pair) command="$1"; shift ;;
        *) usage ;;
    esac
done

[ -n "$db" ] || usage
case "$db" in
    say-when-dev | say-when-demo) ;;
    *) die "refusing database $db: this script runs only say-when-dev and say-when-demo (the try sandbox runs on its own service)." ;;
esac

case "$port" in
    '' | *[!0-9]*) die "--port must be a whole number." ;;
esac
if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
    die "--port must be from 1024 to 65535."
fi

[ -n "$moss_session" ] || moss_session="$db"
case "$moss_session" in
    *[!a-z0-9-]* | -*) die "--moss-session must be lowercase letters, digits and dashes." ;;
esac
if [ "$db" = "say-when-dev" ] && [ "$moss_session" = "say-when-demo" ]; then
    die "refusing Moss session say-when-demo on say-when-dev: a rehearsal never writes into the demo's memory."
fi
if [ "$db" = "say-when-demo" ] && [ "$moss_session" = "say-when-dev" ]; then
    die "refusing Moss session say-when-dev on say-when-demo: the demo keeps its own memory."
fi

scripts_dir="$(cd "$(dirname "$0")" && pwd)"
repo_dir="$(cd "$scripts_dir/.." && pwd)"
agent_dir="$repo_dir/agent"
cartesia_dir="$repo_dir/cartesia"
state_dir="${DEMO_UP_STATE_DIR:-$HOME/.config/say-when/demo-up}"
token_dir="${DEMO_UP_TOKEN_DIR:-$HOME/.config/say-when}"
env_file="${DEMO_UP_ENV_FILE:-$repo_dir/.env.local}"
token_file="$token_dir/agent_token_$db"
state_file="$state_dir/$db.state"
health_url="http://127.0.0.1:$port/healthz"

mkdir -p "$state_dir" "$token_dir"
chmod 700 "$state_dir"

# One GET of the health endpoint, printed as one line of JSON; exit 1 when nothing answers. python3, not curl or nc.
health_json() {
    python3 -I -c '
import sys, urllib.request
try:
    with urllib.request.urlopen(sys.argv[1], timeout=3) as r:
        sys.stdout.write(r.read().decode("utf-8", "replace").strip() + "\n")
except Exception:
    sys.exit(1)
' "$1"
}

# Exit 0 when the JSON on stdin says connected and paired.
health_ready() {
    python3 -I -c '
import json, sys
try:
    body = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)
sys.exit(0 if body.get("connected") is True and body.get("paired") is True else 1)
'
}

# Exit 0 when something already listens on 127.0.0.1:<port>.
port_in_use() {
    python3 -I -c '
import socket, sys
s = socket.socket()
s.settimeout(1)
try:
    s.connect(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
' "$1"
}

# macOS only: warn when the system's open-file table is nearly full (seen on this Mac on Oct 24 at 30,710 of 30,720),
# because then every new socket, pipe and file fails, the sidecar's included. Says nothing where sysctl has no answer.
files_check() {
    local used max
    used="$(sysctl -n kern.num_files 2>/dev/null || true)"
    max="$(sysctl -n kern.maxfiles 2>/dev/null || true)"
    case "$used$max" in '' | *[!0-9]*) return 0 ;; esac
    [ "$max" -gt 0 ] || return 0
    if [ $((used * 100 / max)) -ge 90 ]; then
        echo "Warning: $used of $max open files are in use on this Mac. Quit apps you do not need (or restart) before the demo, or new connections will fail." >&2
    else
        echo "open files: $used of $max"
    fi
}

# The state file: one key=value per line, written by `up`, read by status and stop.
state_get() {
    [ -f "$state_file" ] || return 0
    sed -n "s/^$1=//p" "$state_file" | tail -1
}

# The wrapper in the state file is ours only while it runs the sidecar and started when the state file says it did,
# so a pid the system reused after a restart is never signalled.
wrapper_ours() {
    local wrapper
    wrapper="$(state_get wrapper)"
    pid_matches "$wrapper" "src/main.ts run" || return 1
    [ "$(ps -o lstart= -p "$wrapper" 2>/dev/null || true)" = "$(state_get started)" ]
}

# A live pid's command line, with trailing spaces trimmed (some processes pad their title), or nothing.
pid_command() {
    local pid="$1" cmdline
    [ -n "$pid" ] || return 0
    kill -0 "$pid" 2>/dev/null || return 0
    cmdline="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    printf '%s' "${cmdline%"${cmdline##*[![:space:]]}"}"
}

# A pid is ours only when it is alive and its command line ENDS with the expected text (the sidecar and its wrapper
# both end in "src/main.ts run"), so a longer command that merely contains it does not count.
pid_matches() {
    local cmdline
    cmdline="$(pid_command "$1")"
    [ -n "$cmdline" ] || return 1
    case "$cmdline" in
        *"$2") return 0 ;;
        *) return 1 ;;
    esac
}

# The pid in the pid file the sidecar writes next to its token file once it can answer (agent/src/warm.ts), or nothing.
pidfile_pid() {
    [ -f "$token_file.pid" ] || return 0
    python3 -I -c '
import json, sys
try:
    pid = json.load(open(sys.argv[1])).get("pid")
    if isinstance(pid, int) and pid > 1:
        print(pid)
except Exception:
    pass
' "$token_file.pid"
}

# The sidecar's own pid, only when that process is a child of the wrapper this script started (tsx runs the sidecar
# as its child).
sidecar_pid() {
    local wrapper="$1" pid parent
    [ -n "$wrapper" ] || return 0
    pid="$(pidfile_pid)"
    [ -n "$pid" ] || return 0
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    if [ "$parent" = "$wrapper" ]; then printf '%s\n' "$pid"; fi
}

# Exit 0 when process <pid> started no later than <file> was last written (one second of slack), as warm.ts checks:
# a pid file outlives a killed sidecar, and its pid can be reused later by another process.
started_before_file() {
    local start
    start="$(ps -o lstart= -p "$1" 2>/dev/null || true)"
    [ -n "$start" ] || return 1
    python3 -I -c '
import os, sys, time
try:
    started = time.mktime(time.strptime(" ".join(sys.argv[1].split()), "%a %b %d %H:%M:%S %Y"))
except ValueError:
    sys.exit(1)
sys.exit(0 if started <= os.path.getmtime(sys.argv[2]) + 1 else 1)
' "$start" "$2"
}

# A live process the pid file names that runs the sidecar, whoever started it (another terminal, or a sidecar whose
# wrapper is gone), and that started before the file was written. This script never signals one; it reports it.
stray_sidecar() {
    local pid
    pid="$(pidfile_pid)"
    if pid_matches "$pid" "src/main.ts run" && started_before_file "$pid" "$token_file.pid"; then printf '%s\n' "$pid"; fi
}

# The caffeinate this script started: its whole command is exactly the one up ran, waiting on our wrapper's pid.
caffeinate_ours() {
    [ -n "$2" ] && [ "$(pid_command "$1")" = "caffeinate -dims -w $2" ]
}

# Keys from the Keychain, by service and account. An empty item still exits 0, so the length is the check.
load_keys() {
    local account pair name service value
    account="${KEYCHAIN_ACCOUNT:-$USER}"
    for pair in ANTHROPIC_API_KEY:anthropic-api-key APIFY_TOKEN:apify-token MOSS_PROJECT_ID:moss-project-id MOSS_PROJECT_KEY:moss-project-key CARTESIA_API_KEY:cartesia-api-key; do
        name="${pair%%:*}"
        service="${pair#*:}"
        value="$(security find-generic-password -s "$service" -a "$account" -w 2>/dev/null)" || value=""
        if [ "${#value}" -eq 0 ]; then
            die "$name is missing or empty in the Keychain (service $service, account $account)."
        fi
        export "$name=$value"
    done
}

# One setting from the private env file, by name: the last line wins, surrounding quotes go, a leading ~/ becomes $HOME.
env_value() {
    local value
    value="$(sed -n "s/^$1=//p" "$env_file" | tail -1)"
    case "$value" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    case "$value" in
        "~/"*) value="$HOME/${value#\~/}" ;;
    esac
    printf '%s' "$value"
}

# Every check a call needs before the sidecar starts with AGENT_CALLS=on. Prints only names, counts and contact ids.
prepare_calls() {
    local name value check_log status
    [ -f "$env_file" ] || die "--calls needs the private call settings in $env_file, which does not exist. Start without --calls."
    for name in CARTESIA_AGENT_ID CARTESIA_FROM_NUMBER_ID CALL_CONSENT_FILE CALL_HOLD_FILE CALL_CALLBACK_NUMBER CALL_PERSON_NAME; do
        value="$(env_value "$name")"
        [ "${#value}" -gt 0 ] || die "--calls needs $name in the private env file. Start without --calls."
        export "$name=$value"
    done
    for name in CALL_DO_NOT_CALL_FILE CALL_ERRAND_TITLES; do
        value="$(env_value "$name")"
        if [ "${#value}" -gt 0 ]; then export "$name=$value"; fi
    done
    [ -s "$CALL_CONSENT_FILE" ] || die "--calls needs the private consent file (CALL_CONSENT_FILE), which is missing or empty. Start without --calls."
    [ -d "$(dirname "$CALL_HOLD_FILE")" ] || die "--calls needs the folder of CALL_HOLD_FILE. Start without --calls."
    check_log="$state_dir/$db-call-check.log"
    echo "Checking the call setup (cartesia call:check; it places no call and prints no number)..."
    status=0
    if [ -n "${DEMO_UP_CALL_CHECK:-}" ] && [ "${DEMO_UP_TEST_HOOKS:-}" = "1" ]; then
        echo "  test hook: DEMO_UP_CALL_CHECK runs instead of call:check"
        (cd "$cartesia_dir" && sh -c "$DEMO_UP_CALL_CHECK") >"$check_log" 2>&1 || status=$?
    else
        (cd "$cartesia_dir" && npm run --silent call:check) >"$check_log" 2>&1 || status=$?
    fi
    chmod 600 "$check_log"
    sed 's/^/  /' "$check_log"
    [ "$status" -eq 0 ] || die "call:check failed (exit $status). Nothing was started. Start without --calls, or fix the setup above."
    grep -q '^contacts every call would refuse: none$' "$check_log" || die "call:check lists a contact every call would refuse. Nothing was started. Start without --calls, or fix the setup above."
    if ! grep -q '^calling hours now: yes' "$check_log"; then
        echo "Note: outside calling hours right now (9 AM to 9 PM). The dialer refuses calls until then."
    fi
    export AGENT_CALLS=on
}

# The settings every command shares. Values a person might have set in the shell are replaced, not inherited.
base_env() {
    export SPACETIMEDB_URI=https://maincloud.spacetimedb.com
    export SPACETIMEDB_DB="$db"
    export AGENT_TOKEN_FILE="$token_file"
    export AGENT_PLANNER_MODEL=claude-haiku-5-5
    export FORM_ERRAND_URL=https://stephensookra--confirm-gated-form-errand.apify.actor
    # The Actor's built-in demo form (formUrl "demo"), which sends nothing anywhere; consent: errand care_team_request.
    export AGENT_FORMS_FILE="$agent_dir/forms.example.json"
    export MOSS_SNAPSHOT_DIR="$repo_dir/moss/.memory"
    export MOSS_SESSION_NAME="$moss_session"
    # Moss closes after 3 idle minutes; reopening on the next question keeps "same as last time" working between judges.
    export AGENT_MOSS_REOPEN=on
    export PORT="$port"
    export AGENT_HEALTH_HOST=127.0.0.1
    export AGENT_ENV_FILES=off
    export AGENT_CALLS=off
    unset AGENT_TRY AGENT_TOKEN AGENT_DRAFT_FIRST
    mkdir -p "$MOSS_SNAPSHOT_DIR"
}

cmd_status() {
    local wrapper caffeinate_pid sidecar body state_port
    wrapper="$(state_get wrapper)"
    caffeinate_pid="$(state_get caffeinate)"
    state_port="$(state_get port)"
    [ -n "$state_port" ] || state_port="$port"
    if wrapper_ours; then
        sidecar="$(sidecar_pid "$wrapper")"
        echo "running: $db, pid $wrapper (sidecar ${sidecar:-unknown}), calls $(state_get calls), Moss session $(state_get moss), log $(state_get log)"
    else
        sidecar="$(stray_sidecar)"
        if [ -n "$sidecar" ]; then
            echo "not started by this script, but a sidecar for $db is running as pid $sidecar (the pid file names it)"
        else
            echo "not running: $db"
        fi
    fi
    if caffeinate_ours "$caffeinate_pid" "$wrapper"; then echo "caffeinate: on (pid $caffeinate_pid)"; else echo "caffeinate: off"; fi
    files_check
    if body="$(health_json "http://127.0.0.1:$state_port/healthz" 2>/dev/null)"; then
        echo "health: $body"
    else
        echo "health: no answer on port $state_port"
    fi
}

cmd_stop() {
    local wrapper caffeinate_pid sidecar waited
    wrapper="$(state_get wrapper)"
    caffeinate_pid="$(state_get caffeinate)"
    if [ -z "$wrapper" ]; then
        echo "not running: $db (no state file)"
        return 0
    fi
    if ! wrapper_ours; then
        sidecar="$(stray_sidecar)"
        if [ -n "$sidecar" ]; then
            die "the wrapper this script started is gone, but the pid file names a running sidecar (pid $sidecar). It was not signalled; check it with ps, stop it with kill -TERM $sidecar, then run stop again."
        fi
        if caffeinate_ours "$caffeinate_pid" "$wrapper"; then kill -TERM "$caffeinate_pid"; fi
        rm -f "$state_file"
        echo "not running: $db (removed an old state file)"
        return 0
    fi
    sidecar="$(sidecar_pid "$wrapper")"
    # Only the sidecar itself gets the signal: a second signal through its wrapper would make it exit without saving Moss.
    if pid_matches "$sidecar" "src/main.ts run"; then
        kill -TERM "$sidecar"
        echo "stopping the sidecar (pid $sidecar); it saves Moss and closes its jobs first..."
    elif pid_matches "$wrapper" "src/main.ts run"; then
        kill -TERM "$wrapper"
        echo "stopping pid $wrapper..."
    fi
    waited=0
    while { pid_matches "$sidecar" "src/main.ts run" || pid_matches "$wrapper" "src/main.ts run"; } && [ "$waited" -lt 40 ]; do
        sleep 1
        waited=$((waited + 1))
    done
    if pid_matches "$sidecar" "src/main.ts run" || pid_matches "$wrapper" "src/main.ts run"; then
        die "still running after 40 s (sidecar ${sidecar:-?}, wrapper ${wrapper:-?}); stop it with kill <pid> and check the log."
    fi
    if caffeinate_ours "$caffeinate_pid" "$wrapper"; then kill -TERM "$caffeinate_pid"; fi
    rm -f "$state_file"
    echo "stopped: $db (after ${waited} s)"
}

cmd_warm() {
    base_env
    load_keys
    cd "$agent_dir"
    ./node_modules/.bin/tsx src/main.ts warm
}

cmd_pair() {
    local out pid code waited status
    base_env
    load_keys
    out="$state_dir/$db-pair.out"
    : >"$out"
    chmod 600 "$out"
    (cd "$agent_dir" && exec ./node_modules/.bin/tsx src/main.ts pair) >"$out" 2>&1 &
    pid=$!
    code=""
    waited=0
    while [ -z "$code" ] && kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 60 ]; do
        sleep 1
        waited=$((waited + 1))
        code="$(sed -n 's/.*approve_pairing \([0-9]\{6\}\) false.*/\1/p' "$out" | tail -1)"
    done
    if [ -n "$code" ]; then
        echo "Approving the sidecar's pairing code $code as the owner (spacetime CLI login on this Mac)..."
        if ! spacetime call --no-config --server maincloud "$db" approve_pairing "$code" false; then
            kill -TERM "$pid" 2>/dev/null || true
            die "the approval failed; is this Mac's spacetime login the database owner?"
        fi
    fi
    status=0
    wait "$pid" || status=$?
    grep -v '"name"' "$out" | tail -5 || true
    [ "$status" -eq 0 ] || die "pairing did not finish (exit $status); see $out"
    echo "paired: the sidecar's identity for $db is in $token_file"
}

cmd_up() {
    local log wrapper caffeinate_pid waited body sidecar
    if wrapper_ours; then
        echo "already running:"
        cmd_status
        return 0
    fi
    [ -s "$token_file" ] || die "the sidecar is not paired with $db yet (no $token_file). Run: $0 --db $db pair"
    sidecar="$(stray_sidecar)"
    if [ -n "$sidecar" ]; then
        die "a sidecar for $db is already running as pid $sidecar, not under this script (one identity runs one sidecar). Stop it first."
    fi
    if port_in_use "$port"; then
        die "port $port already answers on this Mac (8790 is the try sidecar). Pick another with --port."
    fi
    files_check
    base_env
    load_keys
    if [ "$calls" -eq 1 ]; then prepare_calls; fi

    if [ "$dry_run" -eq 1 ]; then
        echo "dry run: would start the sidecar on $db with calls $AGENT_CALLS, Moss session $MOSS_SESSION_NAME, health $health_url"
        echo "dry run: keys from the Keychain: ANTHROPIC_API_KEY APIFY_TOKEN MOSS_PROJECT_ID MOSS_PROJECT_KEY CARTESIA_API_KEY (values not shown)"
        return 0
    fi

    log="$state_dir/$db-$(date +%Y%m%d-%H%M%S).log"
    : >"$log"
    chmod 600 "$log"
    cd "$agent_dir"
    nohup ./node_modules/.bin/tsx src/main.ts run >>"$log" 2>&1 </dev/null &
    wrapper=$!
    # -d display, -i idle, -m disk, -s system sleep (on power); it ends by itself when the sidecar's wrapper ends.
    nohup caffeinate -dims -w "$wrapper" >/dev/null 2>&1 </dev/null &
    caffeinate_pid=$!
    {
        echo "wrapper=$wrapper"
        echo "started=$(ps -o lstart= -p "$wrapper" 2>/dev/null || true)"
        echo "caffeinate=$caffeinate_pid"
        echo "port=$port"
        echo "calls=$AGENT_CALLS"
        echo "moss=$MOSS_SESSION_NAME"
        echo "log=$log"
    } >"$state_file"
    chmod 600 "$state_file"
    ln -sf "$log" "$state_dir/$db.log"
    echo "started the sidecar on $db (pid $wrapper, calls $AGENT_CALLS, Moss session $MOSS_SESSION_NAME); waiting for it to connect..."

    waited=0
    body=""
    while [ "$waited" -lt 90 ]; do
        if ! kill -0 "$wrapper" 2>/dev/null; then
            echo "The sidecar exited during startup. The last lines of $log:" >&2
            tail -20 "$log" >&2
            if caffeinate_ours "$caffeinate_pid" "$wrapper"; then kill -TERM "$caffeinate_pid"; fi
            rm -f "$state_file"
            exit 1
        fi
        if body="$(health_json "$health_url" 2>/dev/null)" && printf '%s' "$body" | health_ready; then
            break
        fi
        body=""
        sleep 1
        waited=$((waited + 1))
    done
    if [ -z "$body" ]; then
        die "no healthy answer from $health_url after 90 s; it is still running (pid $wrapper). Check $log, or stop it with: $0 --db $db stop"
    fi
    sidecar="$(sidecar_pid "$wrapper")"
    echo "connected and paired after ${waited} s: $body"
    if [ "$warm" -eq 1 ]; then
        echo "Warming (the form-errand Actor, Moss, one voice token)..."
        warm_out="$state_dir/$db-warm.out"
        warm_status=0
        ./node_modules/.bin/tsx src/main.ts warm >"$warm_out" 2>&1 || warm_status=$?
        chmod 600 "$warm_out"
        grep '^warm ' "$warm_out" || true
        cat "$warm_out" >>"$log"
        if [ "$warm_status" -ne 0 ]; then
            echo "Warm reported a step not ok (above). The sidecar keeps running; run: $0 --db $db warm" >&2
        fi
    fi
    echo
    echo "Eleven backend is up on $db."
    echo "  sidecar pid ${sidecar:-?} (wrapper $wrapper), caffeinate pid $caffeinate_pid, calls $AGENT_CALLS"
    echo "  health  $health_url"
    echo "  log     $log"
    echo "  stop    $0 --db $db stop"
    echo "Next: pair the station, speaker and partner phone (approve each code: node scripts/demo-owner.mjs --db $db approve <code>),"
    echo "      then check: node scripts/demo-owner.mjs --db $db state   (docs/demo-runbook.md)"
}

case "$command" in
    up) cmd_up ;;
    status) cmd_status ;;
    stop) cmd_stop ;;
    warm) cmd_warm ;;
    pair) cmd_pair ;;
esac
