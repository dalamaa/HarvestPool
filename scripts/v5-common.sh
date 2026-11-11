#!/usr/bin/env bash

# Shared configuration and ownership checks for the canonical V5 web process.

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
V5_HOST="127.0.0.1"
V5_PORT="5011"
V5_URL="http://${V5_HOST}:${V5_PORT}/"
V5_CONTRACT_ID="harvestpool-v5-usdc-dalamaa-20261109.testnet"
V5_V3_CONTRACT_ID="harvestpool-v3-v5-dalamaa-20261109.testnet"
V5_USDC_TOKEN_ID="3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"
V5_PID_FILE="$PROJECT_DIR/.harvestpool-v5.pid"
V5_LOG_FILE="${HARVESTPOOL_V5_LOG_FILE:-${TMPDIR:-/tmp}/harvestpool-v5.log}"
V5_FINALIZER_PID_FILE="$PROJECT_DIR/.harvestpool-finalizer.pid"
V5_FINALIZER_LOG_FILE="${HARVESTPOOL_FINALIZER_LOG_FILE:-${TMPDIR:-/tmp}/harvestpool-finalizer.log}"

v5_error() {
    printf 'ERROR: %s\n' "$*" >&2
}

v5_load_and_validate_environment() {
    local env_file load_status contract_version_upper
    env_file="${HARVESTPOOL_ENV_FILE:-$PROJECT_DIR/.env}"
    if [ ! -f "$env_file" ]; then
        v5_error "V5 environment file is missing: $env_file"
        v5_error "Create it from .env.example; root scripts do not fall back to V4 or V2 settings."
        return 1
    fi

    # Do not let stale V4/V2 values from the invoking shell survive a partial .env file.
    unset PORT NEAR_NETWORK HARVESTPOOL_CONTRACT_ID HARVESTPOOL_CONTRACT_VERSION \
        HARVESTPOOL_V3_CONTRACT_ID HARVESTPOOL_USDC_TOKEN_ID
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    load_status=$?
    set +a
    if [ "$load_status" -ne 0 ]; then
        v5_error "Could not load V5 environment file: $env_file"
        return 1
    fi

    if [ "${PORT:-}" != "$V5_PORT" ]; then
        v5_error "Expected PORT=$V5_PORT for V5, got '${PORT:-<unset>}'. V4 uses port 5010 and is never a fallback."
        return 1
    fi
    if [ "${NEAR_NETWORK:-}" != "testnet" ]; then
        v5_error "Expected NEAR_NETWORK=testnet for the deployed V5 contracts, got '${NEAR_NETWORK:-<unset>}'."
        return 1
    fi
    if [ "${HARVESTPOOL_CONTRACT_ID:-}" != "$V5_CONTRACT_ID" ]; then
        v5_error "Expected HARVESTPOOL_CONTRACT_ID=$V5_CONTRACT_ID, got '${HARVESTPOOL_CONTRACT_ID:-<unset>}'. Refusing V4/V2 configuration."
        return 1
    fi
    contract_version_upper="$(printf '%s' "${HARVESTPOOL_CONTRACT_VERSION:-}" | tr '[:lower:]' '[:upper:]')"
    if [ "$contract_version_upper" != "V5" ]; then
        v5_error "Expected HARVESTPOOL_CONTRACT_VERSION=V5, got '${HARVESTPOOL_CONTRACT_VERSION:-<unset>}'. Refusing V4/V2 configuration."
        return 1
    fi
    if [ "${HARVESTPOOL_V3_CONTRACT_ID:-}" != "$V5_V3_CONTRACT_ID" ]; then
        v5_error "Expected HARVESTPOOL_V3_CONTRACT_ID=$V5_V3_CONTRACT_ID, got '${HARVESTPOOL_V3_CONTRACT_ID:-<unset>}'. Refusing a mismatched governance contract."
        return 1
    fi
    if [ "${HARVESTPOOL_USDC_TOKEN_ID:-}" != "$V5_USDC_TOKEN_ID" ]; then
        v5_error "Expected Circle Testnet USDC token $V5_USDC_TOKEN_ID, got '${HARVESTPOOL_USDC_TOKEN_ID:-<unset>}'."
        return 1
    fi

    return 0
}

v5_finalizer_is_enabled() {
    local value
    value="$(printf '%s' "${HARVESTPOOL_FINALIZER_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')"
    case "$value" in
        1|true|yes|on) return 0 ;;
        *) return 1 ;;
    esac
}

v5_finalizer_health_url() {
    printf 'http://%s:%s/healthz' \
        "${HARVESTPOOL_FINALIZER_HEALTH_HOST:-127.0.0.1}" \
        "${HARVESTPOOL_FINALIZER_HEALTH_PORT:-8091}"
}

v5_finalizer_validate_activation() {
    local credentials_file
    if ! v5_finalizer_is_enabled; then
        return 0
    fi

    credentials_file="${HARVESTPOOL_FINALIZER_CREDENTIALS_FILE:-}"
    if [ -z "$credentials_file" ]; then
        v5_error 'Finalizer activation requires HARVESTPOOL_FINALIZER_CREDENTIALS_FILE; credentials alone never activate it.'
        return 1
    fi
    if [ ! -f "$credentials_file" ]; then
        v5_error "Finalizer credentials file was not found: $credentials_file"
        return 1
    fi
    if ! "$V5_PYTHON_BIN" -c 'import os, stat, sys; sys.exit(0 if stat.S_IMODE(os.stat(sys.argv[1]).st_mode) & 0o077 == 0 else 1)' "$credentials_file"; then
        v5_error "Finalizer credentials file must be private to its service user (mode 0600 or stricter): $credentials_file"
        return 1
    fi
}

v5_resolve_python() {
    if [ -n "${PYTHON_BIN:-}" ]; then
        V5_PYTHON_BIN="$PYTHON_BIN"
    elif command -v python3 >/dev/null 2>&1; then
        V5_PYTHON_BIN="$(command -v python3)"
    elif command -v python >/dev/null 2>&1; then
        V5_PYTHON_BIN="$(command -v python)"
    else
        v5_error 'No Python interpreter was found in the existing environment.'
        return 1
    fi

    if ! "$V5_PYTHON_BIN" -c 'import flask' >/dev/null 2>&1; then
        v5_error "Flask is not available in the existing Python environment: $V5_PYTHON_BIN"
        return 1
    fi
    export V5_PYTHON_BIN
    return 0
}

v5_listener_pids() {
    lsof -t -nP -iTCP:"$V5_PORT" -sTCP:LISTEN 2>/dev/null || true
}

v5_show_listeners() {
    lsof -nP -iTCP:"$V5_PORT" -sTCP:LISTEN 2>/dev/null || true
}

v5_read_pid() {
    [ -f "$V5_PID_FILE" ] || return 1
    tr -d '[:space:]' < "$V5_PID_FILE"
}

v5_pid_is_alive() {
    local pid="$1"
    kill -0 "$pid" 2>/dev/null
}

# Ownership is the PID file plus an exact Flask/web.app/host/port fingerprint and
# a process-group-leader check. Callers must refuse to signal a PID that fails this.
v5_pid_is_owned() {
    local pid="$1" process_command process_group
    process_command="$(ps -p "$pid" -o command= 2>/dev/null | sed 's/^[[:space:]]*//' || true)"
    [ -n "$process_command" ] || return 1
    case "$process_command" in
        *"web.app"*) ;;
        *) return 1 ;;
    esac
    case "$process_command" in
        *"-m flask"*|*" flask "*) ;;
        *) return 1 ;;
    esac
    case "$process_command" in
        *"--host $V5_HOST"*|*"--host=$V5_HOST"*) ;;
        *) return 1 ;;
    esac
    case "$process_command" in
        *"--port $V5_PORT"*|*"--port=$V5_PORT"*) ;;
        *) return 1 ;;
    esac

    process_group="$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d '[:space:]' || true)"
    [ "$process_group" = "$pid" ]
}

v5_finalizer_read_pid() {
    [ -f "$V5_FINALIZER_PID_FILE" ] || return 1
    tr -d '[:space:]' < "$V5_FINALIZER_PID_FILE"
}

v5_finalizer_pid_is_owned() {
    local pid="$1" process_command process_group
    process_command="$(ps -p "$pid" -o command= 2>/dev/null | sed 's/^[[:space:]]*//' || true)"
    case "$process_command" in
        *"-m automation.finalizer"*) ;;
        *) return 1 ;;
    esac
    process_group="$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d '[:space:]' || true)"
    [ "$process_group" = "$pid" ]
}

v5_http_is_healthy() {
    "$V5_PYTHON_BIN" -c 'import sys, urllib.request; response = urllib.request.urlopen(sys.argv[1], timeout=2); sys.exit(0 if 200 <= response.status < 400 else 1)' "$V5_URL" >/dev/null 2>&1
}

v5_http_status() {
    "$V5_PYTHON_BIN" -c 'import sys, urllib.request; response = urllib.request.urlopen(sys.argv[1], timeout=2); print(response.status)' "$V5_URL" 2>/dev/null || true
}

v5_finalizer_http_status() {
    "$V5_PYTHON_BIN" -c '
import sys
from urllib.error import HTTPError
from urllib.request import urlopen
try:
    with urlopen(sys.argv[1], timeout=2) as response:
        print(response.status)
except HTTPError as error:
    print(error.code)
except OSError:
    print("000")
' "$(v5_finalizer_health_url)" 2>/dev/null || printf '000\n'
}

v5_start_finalizer_or_verify() {
    local pid attempt health_status
    if ! v5_finalizer_is_enabled; then
        return 0
    fi
    if ! v5_finalizer_validate_activation; then
        return 1
    fi

    if [ -f "$V5_FINALIZER_PID_FILE" ]; then
        pid="$(v5_finalizer_read_pid || true)"
        case "$pid" in
            ''|*[!0-9]*)
                rm -f "$V5_FINALIZER_PID_FILE"
                ;;
            *)
                if v5_pid_is_alive "$pid"; then
                    if v5_finalizer_pid_is_owned "$pid"; then
                        printf 'HarvestPool finalizer is already running (PID %s); preserving its independent lifecycle.\n' "$pid"
                        return 0
                    fi
                    v5_error "Finalizer PID file points to a live process that is not the managed worker; refusing to signal or adopt it."
                    return 1
                fi
                rm -f "$V5_FINALIZER_PID_FILE"
                ;;
        esac
    fi

    health_status="$(v5_finalizer_http_status)"
    case "$health_status" in
        000|"")
            ;;
        *)
            v5_error "Finalizer health endpoint $(v5_finalizer_health_url) is already responding without a managed PID; refusing to adopt it."
            return 1
            ;;
    esac

    if ! cd "$PROJECT_DIR"; then
        v5_error "Could not enter the HarvestPool project directory: $PROJECT_DIR"
        return 1
    fi
    printf 'Starting HarvestPool finalizer in independent foreground mode...\n'
    nohup "$V5_PYTHON_BIN" -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
        "$V5_PYTHON_BIN" -m automation.finalizer \
        >"$V5_FINALIZER_LOG_FILE" 2>&1 < /dev/null &
    pid=$!
    printf '%s\n' "$pid" > "$V5_FINALIZER_PID_FILE"

    attempt=1
    while [ "$attempt" -le 30 ]; do
        health_status="$(v5_finalizer_http_status)"
        if [ "$health_status" = "200" ]; then
            printf 'HarvestPool finalizer is healthy at %s (PID %s)\n' "$(v5_finalizer_health_url)" "$pid"
            return 0
        fi
        if ! v5_pid_is_alive "$pid"; then
            rm -f "$V5_FINALIZER_PID_FILE"
            v5_error "HarvestPool finalizer exited before becoming healthy. Check the log: $V5_FINALIZER_LOG_FILE"
            return 1
        fi
        sleep 0.5
        attempt=$((attempt + 1))
    done

    v5_error "HarvestPool finalizer did not become healthy within 15 seconds. Check $V5_FINALIZER_LOG_FILE and $V5_FINALIZER_HEALTH_PORT."
    return 1
}

v5_stop_finalizer() {
    local pid attempt
    if [ ! -f "$V5_FINALIZER_PID_FILE" ]; then
        printf 'HarvestPool finalizer is not running (no managed PID file found).\n'
        return 0
    fi

    pid="$(v5_finalizer_read_pid || true)"
    case "$pid" in
        ''|*[!0-9]*)
            rm -f "$V5_FINALIZER_PID_FILE"
            printf 'Removed stale finalizer PID file: %s\n' "$V5_FINALIZER_PID_FILE"
            return 0
            ;;
    esac
    if ! v5_pid_is_alive "$pid"; then
        rm -f "$V5_FINALIZER_PID_FILE"
        printf 'Removed stale finalizer PID file for exited PID %s.\n' "$pid"
        return 0
    fi
    if ! v5_finalizer_pid_is_owned "$pid"; then
        v5_error "Finalizer PID $pid is not the managed worker; it was not terminated."
        return 1
    fi

    printf 'Stopping HarvestPool finalizer (PID %s) gracefully...\n' "$pid"
    if ! kill -TERM -"$pid" 2>/dev/null; then
        v5_error "Failed to send a graceful stop signal to HarvestPool finalizer PID $pid."
        return 1
    fi
    attempt=1
    while [ "$attempt" -le 30 ]; do
        if ! kill -0 -"$pid" 2>/dev/null; then
            rm -f "$V5_FINALIZER_PID_FILE"
            printf 'HarvestPool finalizer stopped successfully. SQLite state was preserved.\n'
            return 0
        fi
        sleep 0.5
        attempt=$((attempt + 1))
    done
    v5_error "Finalizer process group $pid is still running after 15 seconds; no force-kill was attempted."
    return 1
}
