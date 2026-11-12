"""Read-only HarvestPool presentation shell.

This service is intentionally not a custodian: it has no NEAR private key and no endpoint
that can withdraw, redirect, approve, or mutate contract funds. Wallet transactions are
prepared in the browser and signed by the user's NEAR-compatible wallet.
"""

import os
import re
import sqlite3
import json
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request

from web.config import (
    CANONICAL_CONTRACT_ID,
    CANONICAL_CONTRACT_VERSION,
    CANONICAL_NETWORK,
    CANONICAL_PORT,
    CANONICAL_SPUTNIK_DAO_CODE_HASH,
    CANONICAL_SPUTNIK_DAO_FACTORY_ID,
    CANONICAL_V3_CONTRACT_ID,
)


BASE_DIR = Path(__file__).resolve().parent
DATABASE = Path(os.environ.get("HARVESTPOOL_METADATA_DB", BASE_DIR / "metadata.sqlite3"))

app = Flask(__name__)

CONTRACT_ID = os.environ.get("HARVESTPOOL_CONTRACT_ID", CANONICAL_CONTRACT_ID)
V3_CONTRACT_ID = os.environ.get("HARVESTPOOL_V3_CONTRACT_ID", CANONICAL_V3_CONTRACT_ID)
CONTRACT_VERSION = os.environ.get(
    "HARVESTPOOL_CONTRACT_VERSION", CANONICAL_CONTRACT_VERSION
).upper()
PUBLIC_BASE_URL = os.environ.get("HARVESTPOOL_PUBLIC_BASE_URL", "").rstrip("/")
NETWORK = os.environ.get("NEAR_NETWORK", CANONICAL_NETWORK)
COMMUNITY_DAO_ID = os.environ.get("HARVESTPOOL_COMMUNITY_DAO_ID", "").strip()
COMMUNITY_DAO_FACTORY_ID = CANONICAL_SPUTNIK_DAO_FACTORY_ID
COMMUNITY_DAO_CODE_HASH = CANONICAL_SPUTNIK_DAO_CODE_HASH
NEARBLOCKS_TESTNET_API = "https://api-testnet.nearblocks.io"
NEARBLOCKS_API_KEY = os.environ.get("HARVESTPOOL_NEARBLOCKS_API_KEY", "").strip()
COMMUNITY_ACTIVITY_CACHE_SECONDS = max(
    15, int(os.environ.get("HARVESTPOOL_COMMUNITY_ACTIVITY_CACHE_SECONDS", "30"))
)
COMMUNITY_ACTIVITY_STALE_SECONDS = max(
    COMMUNITY_ACTIVITY_CACHE_SECONDS,
    int(os.environ.get("HARVESTPOOL_COMMUNITY_ACTIVITY_STALE_SECONDS", "900")),
)

_community_activity_cache = {}
_community_activity_cache_lock = threading.Lock()


def _community_goal_config():
    title = os.environ.get("HARVESTPOOL_COMMUNITY_GOAL_TITLE", "").strip()
    purpose = os.environ.get("HARVESTPOOL_COMMUNITY_GOAL_PURPOSE", "").strip()
    recipient = os.environ.get("HARVESTPOOL_COMMUNITY_GOAL_RECIPIENT", "").strip()
    target_near = os.environ.get("HARVESTPOOL_COMMUNITY_GOAL_TARGET_NEAR", "").strip()
    values_present = any((title, purpose, recipient, target_near))
    errors = []
    target_yocto = ""
    if values_present and not all((title, purpose, recipient, target_near)):
        errors.append("All Community Goal fields must be configured together.")
    if len(title) > 120 or len(purpose) > 500:
        errors.append("Community Goal title or purpose exceeds its supported length.")
    if recipient and not re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*", recipient):
        errors.append("Community Goal recipient is not a valid NEAR account ID.")
    if recipient and not 2 <= len(recipient) <= 64:
        errors.append("Community Goal recipient must be 2 to 64 characters.")
    if target_near:
        try:
            target_value = Decimal(target_near)
            scaled = target_value * (Decimal(10) ** 24)
            if target_value <= 0 or scaled != scaled.to_integral_value():
                raise InvalidOperation
            target_yocto = str(int(scaled))
        except (InvalidOperation, ValueError, OverflowError):
            errors.append("Community Goal target must be a positive NEAR amount with at most 24 decimals.")
    return {
        "configured": bool(values_present and not errors),
        "title": title,
        "purpose": purpose,
        "recipient": recipient,
        "targetYocto": target_yocto,
        "configurationError": " ".join(errors),
    }


COMMUNITY_GOAL = _community_goal_config()
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
        community_dao_id=COMMUNITY_DAO_ID,
        community_dao_factory_id=COMMUNITY_DAO_FACTORY_ID,
        community_dao_code_hash=COMMUNITY_DAO_CODE_HASH,
        community_goal=COMMUNITY_GOAL,
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


def _nearblocks_json(path, params=None):
    url = f"{NEARBLOCKS_TESTNET_API}{path}"
    if params:
        url = f"{url}?{urlencode(params)}"
    headers = {"Accept": "application/json", "User-Agent": "HarvestPool/1.0"}
    if NEARBLOCKS_API_KEY:
        headers["Authorization"] = f"Bearer {NEARBLOCKS_API_KEY}"
    request = Request(url, headers=headers)
    for attempt in range(3):
        try:
            with urlopen(request, timeout=6) as response:
                body = response.read(2_000_001)
                if len(body) > 2_000_000:
                    raise ValueError("NearBlocks response exceeded the 2 MB safety limit")
                return json.loads(body.decode("utf-8"))
        except HTTPError as error:
            if error.code != 429 or attempt == 2:
                raise
            retry_after = error.headers.get("Retry-After", "")
            try:
                delay = min(2.0, max(0.25, float(retry_after)))
            except (TypeError, ValueError):
                delay = 0.5 * (attempt + 1)
            time.sleep(delay)
    raise RuntimeError("NearBlocks retry limit reached")


def _community_activity(dao_id):
    transactions = []
    next_page = None
    complete = True
    for _page in range(5):
        params = {"limit": 100}
        if next_page:
            params["next"] = next_page
        payload = _nearblocks_json(
            f"/v3/accounts/{quote(dao_id, safe='.')}/txns", params
        )
        batch = payload.get("data")
        if not isinstance(batch, list):
            raise ValueError("NearBlocks returned an invalid transaction list")
        transactions.extend(batch)
        next_page = payload.get("meta", {}).get("next_page")
        if not next_page:
            break
    else:
        complete = not bool(next_page)

    contributions = []
    proposal_transactions = {}
    proposal_candidates = []
    receipt_reads_complete = True
    for transaction in transactions:
        actions = transaction.get("actions") or []
        success = transaction.get("outcomes", {}).get("status") is True
        receiver = str(transaction.get("receiver_account_id") or "")
        signer = str(transaction.get("signer_account_id") or "")
        transaction_hash = str(transaction.get("transaction_hash") or "")
        if (
            success
            and receiver == dao_id
            and signer != dao_id
            and len(actions) == 1
            and actions[0].get("action") == "TRANSFER"
        ):
            amount = str(transaction.get("actions_agg", {}).get("deposit") or "0")
            if amount.isdigit() and int(amount) > 0 and transaction_hash:
                contributions.append(
                    {
                        "amount": amount,
                        "contributor": signer,
                        "timestamp": str(transaction.get("block_timestamp") or "0"),
                        "transactionHash": transaction_hash,
                    }
                )
        if (
            success
            and receiver == dao_id
            and transaction_hash
            and any(action.get("method") == "act_proposal" for action in actions)
        ):
            proposal_candidates.append(transaction_hash)

    for transaction_hash in proposal_candidates[:40]:
        try:
            detail = _nearblocks_json(
                f"/v3/txns/{quote(transaction_hash, safe='')}"
            ).get("data", {})
            receipt_root = _nearblocks_json(
                f"/v3/txns/{quote(transaction_hash, safe='')}/receipts"
            ).get("data", {})
            transfers = []

            def collect_transfers(receipt, depth=0):
                if not isinstance(receipt, dict):
                    return
                if (
                    depth == 1
                    and str(receipt.get("predecessor_account_id") or "") == dao_id
                    and receipt.get("outcome", {}).get("status") is True
                ):
                    for receipt_action in receipt.get("actions") or []:
                        if receipt_action.get("action") != "TRANSFER":
                            continue
                        amount = str(receipt_action.get("args", {}).get("deposit") or "0")
                        receiver = str(receipt.get("receiver_account_id") or "")
                        if amount.isdigit() and int(amount) > 0 and receiver:
                            transfers.append(
                                {
                                    "amount": amount,
                                    "receiver": receiver,
                                    "receiptId": str(receipt.get("receipt_id") or ""),
                                }
                            )
                for child in receipt.get("receipts") or []:
                    collect_transfers(child, depth + 1)

            collect_transfers(receipt_root)
            for action in detail.get("actions") or []:
                if action.get("method") != "act_proposal":
                    continue
                args = action.get("args", {}).get("args_json") or {}
                proposal_id = args.get("id")
                action_name = args.get("action")
                if proposal_id is None or action_name not in {
                    "VoteApprove", "VoteReject", "VoteRemove", "Finalize"
                }:
                    continue
                key = str(proposal_id)
                proposal_transactions.setdefault(key, []).append(
                    {
                        "action": action_name,
                        "signer": str(detail.get("signer_account_id") or ""),
                        "timestamp": str(detail.get("block_timestamp") or "0"),
                        "transactionHash": transaction_hash,
                        "transfers": transfers,
                    }
                )
        except (OSError, URLError, ValueError, TypeError, json.JSONDecodeError):
            receipt_reads_complete = False
            continue

    complete = complete and len(proposal_candidates) <= 40 and receipt_reads_complete

    verified_at = datetime.now(timezone.utc).isoformat()
    return {
        "complete": complete,
        "contributions": contributions,
        "proposalTransactions": proposal_transactions,
        "source": "NearBlocks Testnet API",
        "sourceUrl": f"https://testnet.nearblocks.io/address/{dao_id}",
        "verifiedAt": verified_at,
        "stale": False,
    }


def _activity_coverage(payload):
    contributions = len(payload.get("contributions") or [])
    actions = sum(len(items or []) for items in (payload.get("proposalTransactions") or {}).values())
    transfers = sum(
        len(action.get("transfers") or [])
        for items in (payload.get("proposalTransactions") or {}).values()
        for action in (items or [])
    )
    return contributions, actions, transfers


def _cached_community_activity(dao_id, *, force=False):
    now = time.monotonic()
    with _community_activity_cache_lock:
        cached = _community_activity_cache.get(dao_id)
        if cached and not force and now - cached["cached_at"] < COMMUNITY_ACTIVITY_CACHE_SECONDS:
            return dict(cached["payload"])
    try:
        payload = _community_activity(dao_id)
    except (OSError, URLError, ValueError, TypeError, json.JSONDecodeError):
        with _community_activity_cache_lock:
            cached = _community_activity_cache.get(dao_id)
            if cached and now - cached["cached_at"] < COMMUNITY_ACTIVITY_STALE_SECONDS:
                stale_payload = dict(cached["payload"])
                stale_payload["stale"] = True
                return stale_payload
        raise
    with _community_activity_cache_lock:
        cached = _community_activity_cache.get(dao_id)
        coverage_dropped = cached and any(
            current < previous
            for current, previous in zip(
                _activity_coverage(payload), _activity_coverage(cached["payload"])
            )
        )
        if cached and (
            (cached["payload"].get("complete") and not payload.get("complete"))
            or coverage_dropped
        ):
            stale_payload = dict(cached["payload"])
            stale_payload["stale"] = True
            return stale_payload
    with _community_activity_cache_lock:
        _community_activity_cache[dao_id] = {"cached_at": time.monotonic(), "payload": payload}
    return dict(payload)


@app.get("/api/community-fund/activity")
def community_fund_activity():
    if not COMMUNITY_DAO_ID:
        return jsonify({"error": "Community Goals DAO is not configured."}), 404
    try:
        force = request.args.get("refresh") == "1"
        return jsonify(_cached_community_activity(COMMUNITY_DAO_ID, force=force))
    except (OSError, URLError, ValueError, TypeError, json.JSONDecodeError) as error:
        return jsonify({"error": f"Community Goals transaction history unavailable: {error}"}), 503


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


@app.get("/community-goals")
@app.get("/community-fund")
def community_fund():
    return render_page("community_fund")


@app.get("/guide")
def guide():
    return render_page("guide")


@app.get("/farmer")
def farmer():
    return render_page("farmer")


if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=int(os.environ.get("PORT", str(CANONICAL_PORT))),
        debug=False,
    )
