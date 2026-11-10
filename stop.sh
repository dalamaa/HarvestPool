#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.harvestpool-server.pid"
HOST="127.0.0.1"
PORT="5010"

if [ ! -f "$PID_FILE" ]; then
    printf '%s\n' 'HarvestPool server is not running (no PID file found).'
    exit 0
fi

pid="$(tr -d '[:space:]' < "$PID_FILE")"
case "$pid" in
    ''|*[!0-9]*)
        rm -f "$PID_FILE"
        printf 'Removed stale HarvestPool PID file: %s\n' "$PID_FILE"
        exit 0
        ;;
esac

if [ "$pid" -le 0 ] 2>/dev/null; then
    rm -f "$PID_FILE"
    printf 'Removed stale HarvestPool PID file with invalid PID: %s\n' "$PID_FILE"
    exit 0
fi

if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    printf 'Removed stale HarvestPool PID file for exited PID %s.\n' "$pid"
    exit 0
fi

process_command="$(ps -p "$pid" -o command= 2>/dev/null | sed 's/^[[:space:]]*//')"
if [ -z "$process_command" ]; then
    printf 'ERROR: Could not inspect PID %s; refusing to terminate it.\n' "$pid" >&2
    exit 1
fi

case "$process_command" in
    *"web.app"*) ;;
    *)
        rm -f "$PID_FILE"
        printf 'ERROR: PID %s does not belong to HarvestPool; it was not terminated.\n' "$pid" >&2
        printf 'Removed the stale PID file: %s\n' "$PID_FILE" >&2
        exit 1
        ;;
esac

case "$process_command" in
    *"-m flask"*|*" flask "*) ;;
    *)
        rm -f "$PID_FILE"
        printf 'ERROR: PID %s is not a Flask HarvestPool process; it was not terminated.\n' "$pid" >&2
        printf 'Removed the stale PID file: %s\n' "$PID_FILE" >&2
        exit 1
        ;;
esac

case "$process_command" in
    *"--host $HOST"*|*"--host=$HOST"*) ;;
    *)
        rm -f "$PID_FILE"
        printf 'ERROR: PID %s is not the HarvestPool server on %s; it was not terminated.\n' "$pid" "$HOST" >&2
        printf 'Removed the stale PID file: %s\n' "$PID_FILE" >&2
        exit 1
        ;;
esac

case "$process_command" in
    *"--port $PORT"*|*"--port=$PORT"*) ;;
    *)
        rm -f "$PID_FILE"
        printf 'ERROR: PID %s is not the HarvestPool server on port %s; it was not terminated.\n' "$pid" "$PORT" >&2
        printf 'Removed the stale PID file: %s\n' "$PID_FILE" >&2
        exit 1
        ;;
esac

process_group="$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d '[:space:]')"
if [ -z "$process_group" ]; then
    printf 'ERROR: Could not verify the HarvestPool process group for PID %s; refusing to terminate it.\n' "$pid" >&2
    exit 1
fi

if [ "$process_group" != "$pid" ]; then
    printf 'ERROR: PID %s is not the controlled HarvestPool process-group leader; refusing to terminate it.\n' "$pid" >&2
    exit 1
fi

printf 'Stopping HarvestPool server (PID %s) gracefully...\n' "$pid"
if ! kill -TERM -"$pid" 2>/dev/null; then
    printf 'ERROR: Failed to send a graceful stop signal to HarvestPool PID %s.\n' "$pid" >&2
    exit 1
fi

attempt=1
while [ "$attempt" -le 30 ]; do
    if ! kill -0 -"$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        printf 'HarvestPool server stopped successfully.\n'
        exit 0
    fi
    sleep 0.5
    attempt=$((attempt + 1))
done

printf 'ERROR: HarvestPool process group %s is still running after 15 seconds.\n' "$pid" >&2
printf 'The PID file was retained and no force-kill was attempted: %s\n' "$PID_FILE" >&2
exit 1
