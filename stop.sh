#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/scripts/v5-common.sh"

STOP_FINALIZER=true
if [ "${1:-}" = "--web-only" ]; then
    STOP_FINALIZER=false
fi

if ! v5_load_and_validate_environment; then
    exit 1
fi

web_status=0

if [ ! -f "$V5_PID_FILE" ]; then
    printf 'HarvestPool V5 is not running (no managed PID file found).\n'
else
    pid="$(v5_read_pid || true)"
    case "$pid" in
        ''|*[!0-9]*)
            rm -f "$V5_PID_FILE"
            printf 'Removed stale HarvestPool V5 PID file: %s\n' "$V5_PID_FILE"
            ;;
        *)
            if ! v5_pid_is_alive "$pid"; then
                rm -f "$V5_PID_FILE"
                printf 'Removed stale HarvestPool V5 PID file for exited PID %s.\n' "$pid"
            elif ! v5_pid_is_owned "$pid"; then
                v5_error "PID $pid does not belong to the managed HarvestPool V5 process; it was not terminated."
                web_status=1
            else
                printf 'Stopping HarvestPool V5 (PID %s) gracefully...\n' "$pid"
                if ! kill -TERM -"$pid" 2>/dev/null; then
                    v5_error "Failed to send a graceful stop signal to HarvestPool V5 PID $pid."
                    web_status=1
                else
                    attempt=1
                    while [ "$attempt" -le 30 ]; do
                        if ! kill -0 -"$pid" 2>/dev/null; then
                            rm -f "$V5_PID_FILE"
                            printf 'HarvestPool V5 stopped successfully.\n'
                            break
                        fi
                        sleep 0.5
                        attempt=$((attempt + 1))
                    done
                    if [ -f "$V5_PID_FILE" ]; then
                        v5_error "HarvestPool V5 process group $pid is still running after 15 seconds."
                        printf 'The PID file was retained and no force-kill was attempted: %s\n' "$V5_PID_FILE" >&2
                        web_status=1
                    fi
                fi
            fi
            ;;
    esac
fi

if $STOP_FINALIZER; then
    if ! v5_resolve_python; then
        exit 1
    fi
    if ! v5_stop_finalizer; then
        exit 1
    fi
else
    printf 'Finalizer left running; restart.sh only restarts the V5 web process.\n'
fi

exit "$web_status"
