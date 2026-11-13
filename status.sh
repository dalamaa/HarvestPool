#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/scripts/v5-common.sh"

QUIET=false
[ "${1:-}" = "--quiet" ] && QUIET=true

if ! v5_load_and_validate_environment || ! v5_resolve_python; then
    exit 2
fi

if [ ! -e "$V5_PID_FILE" ]; then
    v5_recover_pid_file || true
fi

pid=""
if [ -f "$V5_PID_FILE" ]; then
    pid="$(v5_read_pid || true)"
fi

pid_ok=false
owned_ok=false
if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && v5_pid_is_alive "$pid"; then
    pid_ok=true
    if v5_pid_is_owned "$pid"; then owned_ok=true; fi
fi

http_code="$(v5_http_status)"
http_ok=false
case "$http_code" in
    2*|3*) http_ok=true ;;
esac

finalizer_ok=true
finalizer_enabled=false
if v5_finalizer_is_enabled; then
    finalizer_enabled=true
fi

if $QUIET; then
    if $finalizer_enabled; then
        finalizer_ok=false
        if [ -f "$V5_FINALIZER_PID_FILE" ]; then
            finalizer_pid="$(v5_finalizer_read_pid || true)"
            if [[ "$finalizer_pid" =~ ^[1-9][0-9]*$ ]] && v5_pid_is_alive "$finalizer_pid" && v5_finalizer_pid_is_owned "$finalizer_pid" && [ "$(v5_finalizer_http_status)" = "200" ]; then
                finalizer_ok=true
            fi
        fi
    fi
    $owned_ok && $http_ok && $finalizer_ok
    exit $?
fi

printf 'HarvestPool V5\nURL: %s\nExpected port: %s\n' "$V5_URL" "$V5_PORT"
if $owned_ok; then
    printf 'Process: MANAGED\nPID: %s\n' "$pid"
elif $pid_ok; then
    printf 'Process: PID FILE POINTS TO AN UNOWNED LIVE PROCESS\nPID: %s\n' "$pid"
elif $http_ok; then
    printf 'Process: HTTP RESPONDS, BUT MANAGED V5 PID IS MISSING\n'
else
    printf 'Process: STOPPED OR MANAGED PID MISSING\n'
fi
if $http_ok; then
    printf 'HTTP: HEALTHY (%s)\n' "$http_code"
else
    printf 'HTTP: UNAVAILABLE at %s\n' "$V5_URL"
fi

if ! $finalizer_enabled; then
    printf 'Finalizer: disabled\n'
else
    printf 'Finalizer: enabled\n'
    finalizer_pid=""
    if [ -f "$V5_FINALIZER_PID_FILE" ]; then
        finalizer_pid="$(v5_finalizer_read_pid || true)"
    fi
    if [[ "$finalizer_pid" =~ ^[1-9][0-9]*$ ]] && v5_pid_is_alive "$finalizer_pid"; then
        if v5_finalizer_pid_is_owned "$finalizer_pid"; then
            printf 'Finalizer process: MANAGED (PID %s)\n' "$finalizer_pid"
        else
            printf 'Finalizer process: PID FILE POINTS TO AN UNOWNED LIVE PROCESS (PID %s)\n' "$finalizer_pid"
            finalizer_ok=false
        fi
    else
        printf 'Finalizer process: STOPPED OR MANAGED PID MISSING\n'
        finalizer_ok=false
    fi

    finalizer_health="$(v5_finalizer_http_status)"
    case "$finalizer_health" in
        200) printf 'Finalizer health: HEALTHY (HTTP 200)\n' ;;
        503) printf 'Finalizer health: UNHEALTHY (HTTP 503)\n'; finalizer_ok=false ;;
        *) printf 'Finalizer health: UNAVAILABLE (%s)\n' "$finalizer_health"; finalizer_ok=false ;;
    esac
    health_report="$("$V5_PYTHON_BIN" -c '
import json, sys
from urllib.error import HTTPError
from urllib.request import urlopen
status = "000"
payload = {}
try:
    with urlopen(sys.argv[1], timeout=2) as response:
        status = str(response.status)
        payload = json.loads(response.read().decode("utf-8"))
except HTTPError as error:
    status = str(error.code)
    try:
        payload = json.loads(error.read().decode("utf-8"))
    except (OSError, ValueError):
        payload = {}
except (OSError, ValueError):
    pass
states = json.dumps(payload.get("states", {}), sort_keys=True, separators=(",", ":"))
print("\t".join([
    str(payload.get("ok", False)),
    str(payload.get("heartbeat_age_seconds", "unknown")),
    str(payload.get("stale_after_seconds", "unknown")),
    str(payload.get("stale", "unknown")),
    str(payload.get("last_error") or "none"),
    states,
]))
' "$(v5_finalizer_health_url)" 2>/dev/null || printf 'false\tunknown\tunknown\tunknown\tunavailable\t{}\n')"
IFS=$'\t' read -r finalizer_worker_ok heartbeat_age stale_after stale last_error states <<EOF
$health_report
EOF
printf 'Finalizer worker: %s\n' "$([ "$finalizer_worker_ok" = "True" ] && printf 'OK' || printf 'NOT OK')"
if [ "$finalizer_worker_ok" != "True" ]; then
    finalizer_ok=false
fi
printf 'Finalizer heartbeat: %s seconds ago (stale after %s seconds; stale=%s)\n' "$heartbeat_age" "$stale_after" "$stale"
if [ "$last_error" != "none" ]; then
    printf 'Finalizer last error: %s\n' "$last_error"
fi
printf 'Finalizer durable states: %s\n' "$states"
fi

if $owned_ok && $http_ok && $finalizer_ok; then
    exit 0
fi
if $http_ok && ! $owned_ok; then
    printf 'No process was terminated; the responding listener is not controlled by the V5 PID file.\n'
fi
exit 1
