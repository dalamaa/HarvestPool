#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PID_FILE="$SCRIPT_DIR/.harvestpool-server.pid"
LOG_FILE="${HARVESTPOOL_V4_LOG_FILE:-${TMPDIR:-/tmp}/harvestpool-v4.log}"
HOST="127.0.0.1"
PORT="5010"
URL="http://${HOST}:${PORT}/"

# This is the explicit legacy path. It does not read the canonical V5 .env file.
export PORT
export NEAR_NETWORK="testnet"
export HARVESTPOOL_CONTRACT_ID="harvestpool-v4-dalamaa-20261109.testnet"
export HARVESTPOOL_CONTRACT_VERSION="V4"
export HARVESTPOOL_V3_CONTRACT_ID="harvestpool-v3-v4-dalamaa-20261109.testnet"
unset HARVESTPOOL_USDC_TOKEN_ID

if ! "$SCRIPT_DIR/scripts/stop-v4.sh"; then
    printf '%s\n' 'ERROR: Existing managed legacy V4 server could not be stopped; refusing to start another instance.' >&2
    exit 1
fi

if ! command -v lsof >/dev/null 2>&1; then
    printf '%s\n' 'ERROR: lsof is required to verify that port 5010 is not owned by an unrelated process.' >&2
    exit 1
fi
listener_pids="$(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$listener_pids" ]; then
    printf 'ERROR: Legacy V4 port %s is occupied by an unrelated process. No process was terminated.\n' "$PORT" >&2
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
    exit 1
fi

if [ -n "${PYTHON_BIN:-}" ]; then
    python_bin="$PYTHON_BIN"
elif command -v python3 >/dev/null 2>&1; then
    python_bin="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
    python_bin="$(command -v python)"
else
    printf '%s\n' 'ERROR: No Python interpreter was found in the existing environment.' >&2
    exit 1
fi
if ! "$python_bin" -c 'import flask' >/dev/null 2>&1; then
    printf 'ERROR: Flask is not available in the existing Python environment: %s\n' "$python_bin" >&2
    exit 1
fi

if ! cd "$SCRIPT_DIR"; then
    printf 'ERROR: Could not enter the HarvestPool project directory: %s\n' "$SCRIPT_DIR" >&2
    exit 1
fi

export FLASK_APP="web.app"
export FLASK_DEBUG=1
printf 'Starting legacy HarvestPool V4 at %s with Flask debug reload enabled...\n' "$URL"
nohup "$python_bin" -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    "$python_bin" -m flask --app web.app run --host "$HOST" --port "$PORT" --debug --reload \
    >"$LOG_FILE" 2>&1 < /dev/null &
server_pid=$!
printf '%s\n' "$server_pid" > "$PID_FILE"

attempt=1
while [ "$attempt" -le 30 ]; do
    if "$python_bin" -c 'import sys, urllib.request; response = urllib.request.urlopen(sys.argv[1], timeout=2); sys.exit(0 if 200 <= response.status < 400 else 1)' "$URL" >/dev/null 2>&1; then
        printf 'Legacy HarvestPool V4 is accessible at %s\n' "$URL"
        printf 'Legacy V4 PID: %s | Log: %s\n' "$server_pid" "$LOG_FILE"
        exit 0
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        printf 'ERROR: Legacy V4 exited before becoming accessible. Check the log: %s\n' "$LOG_FILE" >&2
        exit 1
    fi
    sleep 0.5
    attempt=$((attempt + 1))
done

printf 'ERROR: Legacy V4 did not become accessible at %s within 15 seconds.\n' "$URL" >&2
exit 1
