#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.harvestpool-server.pid"
HOST="127.0.0.1"
PORT="5010"

if [ -x "$SCRIPT_DIR/status.sh" ] && "$SCRIPT_DIR/status.sh" --quiet; then
    printf 'HarvestPool server is already running at http://%s:%s/\n' "$HOST" "$PORT"
    exit 0
fi

port_busy=0
if command -v lsof >/dev/null 2>&1; then
    for port_pid in $(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
        if kill -0 "$port_pid" 2>/dev/null; then
            port_busy=1
            break
        fi
    done
fi
if [ "$port_busy" -eq 1 ]; then
    printf 'ERROR: Port %s is already in use. No process was terminated.\n' "$PORT" >&2
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
    exit 1
fi

exec "$SCRIPT_DIR/restart.sh"
