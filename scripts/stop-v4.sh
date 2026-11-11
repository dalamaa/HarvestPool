#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PID_FILE="$SCRIPT_DIR/.harvestpool-server.pid"
HOST="127.0.0.1"
PORT="5010"

if [ ! -f "$PID_FILE" ]; then
    printf 'Legacy HarvestPool V4 is not running (no legacy PID file found).\n'
    exit 0
fi

pid="$(tr -d '[:space:]' < "$PID_FILE")"
case "$pid" in
    ''|*[!0-9]*)
        rm -f "$PID_FILE"
        printf 'Removed stale legacy V4 PID file: %s\n' "$PID_FILE"
        exit 0
        ;;
esac

if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    printf 'Removed stale legacy V4 PID file for exited PID %s.\n' "$pid"
    exit 0
fi

process_command="$(ps -p "$pid" -o command= 2>/dev/null | sed 's/^[[:space:]]*//' || true)"
case "$process_command" in
    *"web.app"*"-m flask"*|*"-m flask"*"web.app"*) ;;
    *)
        printf 'ERROR: PID %s is not the managed legacy V4 Flask process; it was not terminated.\n' "$pid" >&2
        exit 1
        ;;
esac
case "$process_command" in
    *"--host $HOST"*|*"--host=$HOST"*) ;;
    *) printf 'ERROR: PID %s is not the legacy V4 server on %s; it was not terminated.\n' "$pid" "$HOST" >&2; exit 1 ;;
esac
case "$process_command" in
    *"--port $PORT"*|*"--port=$PORT"*) ;;
    *) printf 'ERROR: PID %s is not the legacy V4 server on port %s; it was not terminated.\n' "$pid" "$PORT" >&2; exit 1 ;;
esac

process_group="$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d '[:space:]' || true)"
if [ "$process_group" != "$pid" ]; then
    printf 'ERROR: PID %s is not the controlled legacy V4 process-group leader; it was not terminated.\n' "$pid" >&2
    exit 1
fi

printf 'Stopping legacy HarvestPool V4 (PID %s) gracefully...\n' "$pid"
if ! kill -TERM -"$pid" 2>/dev/null; then
    printf 'ERROR: Failed to stop legacy HarvestPool V4 PID %s.\n' "$pid" >&2
    exit 1
fi

attempt=1
while [ "$attempt" -le 30 ]; do
    if ! kill -0 -"$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        printf 'Legacy HarvestPool V4 stopped successfully.\n'
        exit 0
    fi
    sleep 0.5
    attempt=$((attempt + 1))
done

printf 'ERROR: Legacy V4 process group %s is still running; no force-kill was attempted.\n' "$pid" >&2
exit 1
