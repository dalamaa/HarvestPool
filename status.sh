#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.harvestpool-server.pid"
HOST="127.0.0.1"
PORT="5010"
URL="http://${HOST}:${PORT}/"
QUIET=false
[ "${1:-}" = "--quiet" ] && QUIET=true

python_bin="${PYTHON_BIN:-}"
if [ -z "$python_bin" ]; then
    if command -v python3 >/dev/null 2>&1; then python_bin="$(command -v python3)"; else python_bin="$(command -v python 2>/dev/null || true)"; fi
fi

http_ok=false
if [ -n "$python_bin" ]; then
    "$python_bin" -c 'import sys, urllib.request; response = urllib.request.urlopen(sys.argv[1], timeout=2); sys.exit(0 if 200 <= response.status < 400 else 1)' "$URL" >/dev/null 2>&1 && http_ok=true
fi

pid=""
if [ -f "$PID_FILE" ]; then pid="$(tr -d '[:space:]' < "$PID_FILE")"; fi
pid_ok=false
if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then pid_ok=true; fi

if $pid_ok && $http_ok; then
    $QUIET || printf 'HarvestPool server: RUNNING\nURL: %s\nPID: %s\n\n' "$URL" "$pid"
    exit 0
fi

if $pid_ok; then
    $QUIET || printf 'HarvestPool server: STARTING OR UNHEALTHY\nPID: %s\nHTTP: unavailable at %s\n' "$pid" "$URL"
    exit 1
fi

if $http_ok; then
    $QUIET || printf 'HarvestPool server: HTTP RESPONDS, BUT CONTROL PID IS MISSING\nURL: %s\nNo process was terminated.\n' "$URL"
    exit 1
fi

$QUIET || printf 'HarvestPool server: STOPPED\nURL: %s\n' "$URL"
exit 1
