#!/usr/bin/env bash
# Starts the Eleven agent sidecar with its keys read from the macOS Keychain at run time.
#
#   agent/scripts/run-with-keychain.sh [--allow-non-dev] [run|pair|check|warm]
#
# run (the default) is what `npm start` runs, pair is `npm run pair`, check is `npm run check`, warm is `npm run warm`
# (run it in a second terminal while the sidecar runs, right before a judge's first question).
#
# Each key is read from its Keychain item into this process's environment and handed to the sidecar by exec. No key
# is printed, logged, echoed, written to a file or put on a command line. Settings files are skipped
# (AGENT_ENV_FILES=off), so a key can never come from or go into an env file here.
#
# Refuses to start when a Keychain item is missing or empty (it names the variable, never a value), and refuses any
# database whose name does not end in -dev unless --allow-non-dev is given. Phone calls are always off here
# (AGENT_CALLS=off): calls need consent confirmed under the Eleven name first (cartesia/README.md).

set -euo pipefail

allow_non_dev=0
command="run"
for arg in "$@"; do
    case "$arg" in
        --allow-non-dev) allow_non_dev=1 ;;
        run | pair | check | warm) command="$arg" ;;
        *)
            echo "usage: $0 [--allow-non-dev] [run|pair|check|warm]" >&2
            exit 2
            ;;
    esac
done

agent_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_dir="$(cd "$agent_dir/.." && pwd)"

# Non-secret settings. A value already in the environment wins, except AGENT_CALLS and AGENT_ENV_FILES.
export SPACETIMEDB_URI="${SPACETIMEDB_URI:-https://maincloud.spacetimedb.com}"
export SPACETIMEDB_DB="${SPACETIMEDB_DB:-say-when-dev}"
export AGENT_PLANNER_MODEL="${AGENT_PLANNER_MODEL:-claude-haiku-5-5}"
export FORM_ERRAND_URL="${FORM_ERRAND_URL:-https://stephensookra--confirm-gated-form-errand.apify.actor}"
# The Actor's built-in demo form (formUrl "demo"), which sends nothing anywhere. Its formKey needs an Errand consent row.
export AGENT_FORMS_FILE="${AGENT_FORMS_FILE:-$agent_dir/forms.example.json}"
export MOSS_SNAPSHOT_DIR="${MOSS_SNAPSHOT_DIR:-$repo_dir/moss/.memory}"
# Outside the repo, one token per database, so a dev identity is never used on the demo database.
export AGENT_TOKEN_FILE="${AGENT_TOKEN_FILE:-$HOME/.config/say-when/agent_token_$SPACETIMEDB_DB}"
export AGENT_CALLS=off
export AGENT_ENV_FILES=off

case "$SPACETIMEDB_DB" in
    *-dev) ;;
    *)
        if [ "$allow_non_dev" -ne 1 ]; then
            echo "Refusing database $SPACETIMEDB_DB: its name does not end in -dev. Pass --allow-non-dev to use it on purpose." >&2
            exit 1
        fi
        ;;
esac

mkdir -p "$MOSS_SNAPSHOT_DIR" "$(dirname "$AGENT_TOKEN_FILE")"

# Each item is read by service AND account. Without the account, `security` returns the first item with that service,
# and this Mac has an older anthropic-api-key item (account "default") that Anthropic refuses with 401.
account="${KEYCHAIN_ACCOUNT:-$USER}"

# VARIABLE:keychain-service pairs. bash 3.2 on macOS has no associative arrays.
keys="ANTHROPIC_API_KEY:anthropic-api-key APIFY_TOKEN:apify-token MOSS_PROJECT_ID:moss-project-id MOSS_PROJECT_KEY:moss-project-key CARTESIA_API_KEY:cartesia-api-key"
for pair in $keys; do
    name="${pair%%:*}"
    service="${pair#*:}"
    value="$(security find-generic-password -s "$service" -a "$account" -w 2>/dev/null)" || value=""
    # An empty Keychain item still exits 0, so the length is the check.
    if [ "${#value}" -eq 0 ]; then
        echo "Refusing to start: $name is missing or empty (Keychain service $service, account $account)." >&2
        exit 1
    fi
    export "$name=$value"
done
unset value pair name service keys account

cd "$agent_dir"
exec ./node_modules/.bin/tsx src/main.ts "$command"
