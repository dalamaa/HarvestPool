"""Read-only HarvestPool presentation shell.

This service is intentionally not a custodian: it has no NEAR private key and no endpoint
that can withdraw, redirect, approve, or mutate contract funds. Wallet transactions are
prepared in the browser and signed by the user's NEAR-compatible wallet.
"""

import os
import sqlite3
import json
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from urllib.error import URLError
from urllib.request import Request, urlopen
from pathlib import Path

from flask import Flask, g, jsonify, render_template


BASE_DIR = Path(__file__).resolve().parent
DATABASE = Path(os.environ.get("HARVESTPOOL_METADATA_DB", BASE_DIR / "metadata.sqlite3"))

app = Flask(__name__)

CONTRACT_ID = os.environ.get("HARVESTPOOL_CONTRACT_ID", "harvestpool-v2-dalamaa-20261108.testnet")
V3_CONTRACT_ID = os.environ.get("HARVESTPOOL_V3_CONTRACT_ID", "")
CONTRACT_VERSION = os.environ.get("HARVESTPOOL_CONTRACT_VERSION", "V2").upper()
PUBLIC_BASE_URL = os.environ.get("HARVESTPOOL_PUBLIC_BASE_URL", "").rstrip("/")
NETWORK = os.environ.get("NEAR_NETWORK", "testnet")
NEAR_PRICE_URL = os.environ.get(
    "HARVESTPOOL_NEAR_PRICE_URL",
    "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd&include_last_updated_at=true",
)
NEAR_PRICE_CACHE_SECONDS = max(30, int(os.environ.get("HARVESTPOOL_NEAR_PRICE_CACHE_SECONDS", "60")))
NEAR_PRICE_SOURCE = "CoinGecko"

_near_price_cache = None
_near_price_cache_lock = threading.Lock()


def render_page(page, *, purchase_id=None, share_mode=False):
    """Render a client-driven page without moving contract authority into Flask."""
    return render_template(
        "index.html",
        page=page,
        purchase_id=purchase_id,
        share_mode=share_mode,
        network=NETWORK,
        contract_id=CONTRACT_ID,
        v3_contract_id=V3_CONTRACT_ID,
        contract_version=CONTRACT_VERSION,
        public_base_url=PUBLIC_BASE_URL,
    )


def _near_price_payload():
    """Read a live quote and retain the last good quote for a short, bounded cache."""
    global _near_price_cache
    now = time.monotonic()
    with _near_price_cache_lock:
        if _near_price_cache and now - _near_price_cache["cached_at"] < NEAR_PRICE_CACHE_SECONDS:
            return _near_price_cache["payload"]

    request = Request(
        NEAR_PRICE_URL,
        headers={"Accept": "application/json", "User-Agent": "HarvestPool/1.0"},
    )
    try:
        with urlopen(request, timeout=4) as response:
            body = json.loads(response.read().decode("utf-8"))
        usd = body.get("near", {}).get("usd")
        try:
            if not isinstance(usd, (int, float, str)) or Decimal(str(usd)) <= 0:
                raise ValueError("price source returned no positive NEAR/USD quote")
        except (InvalidOperation, ValueError) as error:
            raise ValueError("price source returned no positive NEAR/USD quote") from error
        source_timestamp = body.get("near", {}).get("last_updated_at")
        if source_timestamp is not None:
            source_timestamp = datetime.fromtimestamp(
                int(source_timestamp), tz=timezone.utc
            ).isoformat()
        fetched_at = datetime.now(timezone.utc).isoformat()
        payload = {
            "asset": "NEAR",
            "usd": str(usd),
            "source": NEAR_PRICE_SOURCE,
            "source_url": NEAR_PRICE_URL,
            "source_timestamp": source_timestamp or fetched_at,
            "fetched_at": fetched_at,
            "stale": False,
        }
        with _near_price_cache_lock:
            _near_price_cache = {"cached_at": time.monotonic(), "payload": payload}
        return payload
    except (OSError, URLError, ValueError, TypeError, json.JSONDecodeError) as error:
        with _near_price_cache_lock:
            if _near_price_cache:
                stale_payload = dict(_near_price_cache["payload"])
                stale_payload["stale"] = True
                return stale_payload
        raise RuntimeError(f"NEAR/USD price source unavailable: {error}") from error


@app.get("/api/near-price")
def near_price():
    try:
        return jsonify(_near_price_payload())
    except RuntimeError as error:
        return jsonify({"error": str(error), "source": NEAR_PRICE_SOURCE}), 503


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_error):
    db = g.pop("db", None)
    if db is not None:
        db.close()


@app.get("/")
def index():
    return render_page("home")


@app.get("/purchases")
@app.get("/deals")
def purchases():
    return render_page("explore")


@app.get("/purchases/<int:purchase_id>")
@app.get("/deals/<int:purchase_id>")
def purchase_details(purchase_id):
    return render_page("details", purchase_id=purchase_id)


@app.get("/purchases/<int:purchase_id>/join")
@app.get("/deals/<int:purchase_id>/join")
def join_purchase(purchase_id):
    return render_page("agreement", purchase_id=purchase_id)


@app.get("/purchases/<int:purchase_id>/issue")
@app.get("/deals/<int:purchase_id>/issue")
def raise_issue(purchase_id):
    return render_page("issue_form", purchase_id=purchase_id)


@app.get("/share/<int:purchase_id>")
def share_purchase(purchase_id):
    return render_page("details", purchase_id=purchase_id, share_mode=True)


@app.get("/supplier-invitations/<int:purchase_id>")
def supplier_invitation(purchase_id):
    return render_page("supplier_invitation", purchase_id=purchase_id)


@app.get("/create")
def create_purchase():
    return render_page("create")


@app.get("/dashboard")
def dashboard():
    return render_page("dashboard")


@app.get("/decisions")
def decisions():
    return render_page("decisions")


@app.get("/guide")
def guide():
    return render_page("guide")


@app.get("/farmer")
def farmer():
    return render_page("farmer")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5010")), debug=False)
