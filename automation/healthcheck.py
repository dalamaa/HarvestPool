"""Small operator probe for the independent finalization worker."""

from __future__ import annotations

import argparse
import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


def inspect_health(url: str, timeout: float = 5.0) -> tuple[bool, dict[str, Any], list[str]]:
    payload: dict[str, Any] = {}
    status = 0
    try:
        with urlopen(url, timeout=timeout) as response:
            status = response.status
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        status = error.code
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except (OSError, ValueError):
            payload = {}
    except (OSError, URLError, ValueError, json.JSONDecodeError) as error:
        return False, payload, [f"health endpoint unavailable: {error}"]

    problems: list[str] = []
    if status != 200:
        problems.append(f"health endpoint returned HTTP {status}")
    if payload.get("ok") is not True:
        problems.append("worker reported ok=false")
    if payload.get("stale") is True:
        problems.append("worker heartbeat is stale")
    if payload.get("last_error"):
        problems.append(f"worker error: {payload['last_error']}")
    states = payload.get("states") if isinstance(payload.get("states"), dict) else {}
    for state in ("unknown", "contract_rejected"):
        if int(states.get(state, 0) or 0) > 0:
            problems.append(f"durable state {state}={states[state]}")
    return not problems, payload, problems


def main() -> int:
    parser = argparse.ArgumentParser(description="Check HarvestPool finalizer health for an operator or supervisor")
    default_url = "http://{}:{}/healthz".format(
        os.environ.get("HARVESTPOOL_FINALIZER_HEALTH_HOST", "127.0.0.1"),
        os.environ.get("HARVESTPOOL_FINALIZER_HEALTH_PORT", "8091"),
    )
    parser.add_argument("--url", default=default_url)
    parser.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args()
    healthy, payload, problems = inspect_health(args.url, args.timeout)
    report = {
        "healthy": healthy,
        "problems": problems,
        "heartbeat_age_seconds": payload.get("heartbeat_age_seconds"),
        "states": payload.get("states", {}),
    }
    print(json.dumps(report, sort_keys=True))
    return 0 if healthy else 2


if __name__ == "__main__":
    raise SystemExit(main())
