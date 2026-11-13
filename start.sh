#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/scripts/v5-common.sh"

if ! v5_load_and_validate_environment || ! v5_resolve_python; then
    exit 1
fi

if ! v5_finalizer_validate_activation; then
    exit 1
fi

if [ ! -e "$V5_PID_FILE" ]; then
    v5_recover_pid_file || true
fi

if [ -f "$V5_PID_FILE" ]; then
    pid="$(v5_read_pid || true)"
    case "$pid" in
        ''|*[!0-9]*)
            rm -f "$V5_PID_FILE"
            ;;
        *)
            if v5_pid_is_alive "$pid"; then
                if v5_pid_is_owned "$pid"; then
                    if v5_http_is_healthy; then
                        if ! v5_start_finalizer_or_verify; then
                            exit 1
                        fi
                        printf 'HarvestPool V5 is already running at %s (PID %s).\n' "$V5_URL" "$pid"
                        exit 0
                    fi
                    v5_error "Managed V5 PID $pid is alive but HTTP health is not ready; refusing to start a duplicate."
                    exit 1
                fi
                v5_error "PID file $V5_PID_FILE points to a live process that is not the managed V5 server; refusing to signal it."
                exit 1
            fi
            rm -f "$V5_PID_FILE"
            ;;
    esac
fi

if ! command -v lsof >/dev/null 2>&1; then
    v5_error 'lsof is required to verify that port 5011 is not owned by an unrelated process.'
    exit 1
fi

listener_pids="$(v5_listener_pids)"
if [ -n "$listener_pids" ]; then
    v5_error "Port $V5_PORT is occupied by an unrelated process. No process was terminated."
    v5_show_listeners >&2
    exit 1
fi

if ! cd "$PROJECT_DIR"; then
    v5_error "Could not enter the HarvestPool project directory: $PROJECT_DIR"
    exit 1
fi

export FLASK_APP="web.app"
export FLASK_DEBUG=0

printf 'Starting HarvestPool V5 at %s...\n' "$V5_URL"
nohup "$V5_PYTHON_BIN" -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    "$V5_PYTHON_BIN" -m flask --app web.app run --host "$V5_HOST" --port "$V5_PORT" --no-debugger --no-reload \
    >"$V5_LOG_FILE" 2>&1 < /dev/null &
server_pid=$!

if ! v5_write_pid "$server_pid"; then
    v5_error "Could not atomically write the V5 PID ownership record: $V5_PID_FILE"
    kill -TERM -"$server_pid" 2>/dev/null || true
    exit 1
fi

attempt=1
while [ "$attempt" -le 30 ]; do
    if v5_http_is_healthy; then
        if ! v5_start_finalizer_or_verify; then
            printf '%s\n' 'V5 is healthy, but the explicitly enabled finalizer could not be started or verified.' >&2
            exit 1
        fi
        printf 'HarvestPool V5 is accessible at %s\n' "$V5_URL"
        printf 'V5 PID: %s | Log: %s\n' "$server_pid" "$V5_LOG_FILE"
        exit 0
    fi

    if ! v5_pid_is_alive "$server_pid"; then
        rm -f "$V5_PID_FILE"
        v5_error "HarvestPool V5 exited before becoming accessible. Check the log: $V5_LOG_FILE"
        exit 1
    fi

    sleep 0.5
    attempt=$((attempt + 1))
done

v5_error "HarvestPool V5 did not become accessible at $V5_URL within 15 seconds."
printf 'The managed process may still be running; inspect the log: %s\n' "$V5_LOG_FILE" >&2
exit 1
