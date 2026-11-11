"""Cross-platform launcher for the canonical HarvestPool V5 web application.

This launcher needs no private credential. It loads an optional repository-root
.env file without relying on shell syntax, applies safe public V5 defaults, and
refuses to start against a legacy or mismatched contract configuration.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from web.config import (
    CANONICAL_CONTRACT_ID,
    CANONICAL_CONTRACT_VERSION,
    CANONICAL_HOST,
    CANONICAL_NETWORK,
    CANONICAL_PORT,
    CANONICAL_USDC_TOKEN_ID,
    CANONICAL_V3_CONTRACT_ID,
)


ROOT = Path(__file__).resolve().parent
PUBLIC_DEFAULTS = {
    "PORT": str(CANONICAL_PORT),
    "NEAR_NETWORK": CANONICAL_NETWORK,
    "HARVESTPOOL_CONTRACT_ID": CANONICAL_CONTRACT_ID,
    "HARVESTPOOL_CONTRACT_VERSION": CANONICAL_CONTRACT_VERSION,
    "HARVESTPOOL_V3_CONTRACT_ID": CANONICAL_V3_CONTRACT_ID,
    "HARVESTPOOL_USDC_TOKEN_ID": CANONICAL_USDC_TOKEN_ID,
    "HARVESTPOOL_PUBLIC_BASE_URL": "",
    "HARVESTPOOL_FINALIZER_ENABLED": "false",
}


class ConfigurationError(ValueError):
    """Raised when startup configuration is invalid or unsafe."""


def read_env_file(path: Path) -> dict[str, str]:
    """Read the simple KEY=VALUE format used by the checked-in example."""
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ConfigurationError(f"{path}:{line_number}: expected KEY=VALUE")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or not key.replace("_", "").isalnum() or key[0].isdigit():
            raise ConfigurationError(f"{path}:{line_number}: invalid environment name")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def configure_environment(env_file: Path | None = None) -> None:
    """Load optional public configuration and enforce canonical V5 values."""
    path = env_file if env_file is not None else ROOT / ".env"
    for key, value in read_env_file(path).items():
        os.environ.setdefault(key, value)
    for key, value in PUBLIC_DEFAULTS.items():
        os.environ.setdefault(key, value)

    expected = {
        "NEAR_NETWORK": CANONICAL_NETWORK,
        "HARVESTPOOL_CONTRACT_ID": CANONICAL_CONTRACT_ID,
        "HARVESTPOOL_CONTRACT_VERSION": CANONICAL_CONTRACT_VERSION,
        "HARVESTPOOL_V3_CONTRACT_ID": CANONICAL_V3_CONTRACT_ID,
        "HARVESTPOOL_USDC_TOKEN_ID": CANONICAL_USDC_TOKEN_ID,
    }
    for key, expected_value in expected.items():
        actual = os.environ.get(key, "")
        if key == "HARVESTPOOL_CONTRACT_VERSION":
            actual = actual.upper()
            os.environ[key] = actual
        if actual != expected_value:
            raise ConfigurationError(
                f"{key} must be {expected_value!r} for the canonical V5 launcher; got {actual!r}"
            )

    try:
        port = int(os.environ["PORT"])
    except ValueError as error:
        raise ConfigurationError("PORT must be an integer") from error
    if not 1 <= port <= 65535:
        raise ConfigurationError("PORT must be between 1 and 65535")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run HarvestPool V5 locally")
    parser.add_argument("--host", default=CANONICAL_HOST, help="listen host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, help="listen port (default: PORT or 5011)")
    return parser.parse_args()


def main() -> int:
    if sys.version_info < (3, 10):
        print("ERROR: HarvestPool requires Python 3.10 or newer.", file=sys.stderr)
        return 2
    args = parse_args()
    try:
        configure_environment()
        if args.port is not None:
            if not 1 <= args.port <= 65535:
                raise ConfigurationError("--port must be between 1 and 65535")
            os.environ["PORT"] = str(args.port)
    except (ConfigurationError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2

    os.chdir(ROOT)
    try:
        from web.app import app
    except ModuleNotFoundError as error:
        if error.name == "flask":
            print(
                "ERROR: Flask is not installed. Run: python -m pip install -r web/requirements.txt",
                file=sys.stderr,
            )
            return 2
        raise

    port = int(os.environ["PORT"])
    print(f"HarvestPool V5: http://{args.host}:{port}")
    print(f"Contract: {CANONICAL_CONTRACT_ID} ({CANONICAL_NETWORK})")
    print("Local finalizer: not started by this portable web launcher and not required for the app.")
    app.run(host=args.host, port=port, debug=False, use_reloader=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
