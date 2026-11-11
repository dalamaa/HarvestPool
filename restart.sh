#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if ! "$SCRIPT_DIR/stop.sh" --web-only; then
    printf '%s\n' 'ERROR: Existing managed HarvestPool V5 server could not be stopped; refusing to start another instance.' >&2
    exit 1
fi

exec "$SCRIPT_DIR/start.sh"
