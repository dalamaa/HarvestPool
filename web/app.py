"""Read-only HarvestPool presentation shell.

This service is intentionally not a custodian: it has no NEAR private key and no endpoint
that can withdraw, redirect, approve, or mutate contract funds. Wallet transactions are
prepared in the browser and signed by the user's NEAR-compatible wallet.
"""

import base64
import hashlib
import os
import re
import sqlite3
import json
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
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
    CANONICAL_USDC_TOKEN_ID,
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
COMMUNITY_RPC_URL = os.environ.get(
    "HARVESTPOOL_COMMUNITY_RPC_URL", "https://rpc.testnet.fastnear.com"
).strip()
COMMUNITY_ACTIVITY_CACHE_SECONDS = max(
    15, int(os.environ.get("HARVESTPOOL_COMMUNITY_ACTIVITY_CACHE_SECONDS", "30"))
)
COMMUNITY_ACTIVITY_STALE_SECONDS = max(
    COMMUNITY_ACTIVITY_CACHE_SECONDS,
    int(os.environ.get("HARVESTPOOL_COMMUNITY_ACTIVITY_STALE_SECONDS", "900")),
)

_community_activity_cache = {}
_community_activity_cache_lock = threading.Lock()


def _community_evidence_config():
    """Return an all-or-nothing manifest for a previously verified public journey."""
    names = {
        "contributionHash": "HARVESTPOOL_COMMUNITY_EVIDENCE_CONTRIBUTION_TX",
        "contributor": "HARVESTPOOL_COMMUNITY_EVIDENCE_CONTRIBUTOR",
        "contributionAmount": "HARVESTPOOL_COMMUNITY_EVIDENCE_CONTRIBUTION_UNITS",
        "paymentHash": "HARVESTPOOL_COMMUNITY_EVIDENCE_PAYMENT_TX",
        "paymentSigner": "HARVESTPOOL_COMMUNITY_EVIDENCE_PAYMENT_SIGNER",
        "paymentProposalId": "HARVESTPOOL_COMMUNITY_EVIDENCE_PAYMENT_PROPOSAL_ID",
        "paymentReceiptId": "HARVESTPOOL_COMMUNITY_EVIDENCE_PAYMENT_RECEIPT",
        "paymentAmount": "HARVESTPOOL_COMMUNITY_EVIDENCE_PAYMENT_UNITS",
    }
    values = {key: os.environ.get(name, "").strip() for key, name in names.items()}
    if not any(values.values()):
        return {}
    if not all(values.values()):
        return {"error": "Community Goal evidence configuration must be complete."}
    hash_pattern = r"[1-9A-HJ-NP-Za-km-z]{40,64}"
    account_pattern = r"[a-z0-9]+(?:[._-][a-z0-9]+)*"
    if not all(
        re.fullmatch(hash_pattern, values[key])
        for key in ("contributionHash", "paymentHash", "paymentReceiptId")
    ):
        return {"error": "Community Goal evidence contains an invalid transaction or receipt hash."}
    if not all(
        re.fullmatch(account_pattern, values[key])
        for key in ("contributor", "paymentSigner")
    ):
        return {"error": "Community Goal evidence contains an invalid signer account."}
    if not all(
        values[key].isdigit() and int(values[key]) > 0
        for key in ("contributionAmount", "paymentAmount")
    ) or not values["paymentProposalId"].isdigit():
        return {"error": "Community Goal evidence amounts and proposal ID must be exact integers."}
    return values


def _community_goal_config():
    title = os.environ.get("HARVESTPOOL_COMMUNITY_GOAL_TITLE", "").strip()
    purpose = os.environ.get("HARVESTPOOL_COMMUNITY_GOAL_PURPOSE", "").strip()
    recipient = os.environ.get("HARVESTPOOL_COMMUNITY_GOAL_RECIPIENT", "").strip()
    currency = os.environ.get("HARVESTPOOL_COMMUNITY_GOAL_CURRENCY", "NEAR").strip().upper()
    target_near = os.environ.get("HARVESTPOOL_COMMUNITY_GOAL_TARGET_NEAR", "").strip()
    target_usdc = os.environ.get("HARVESTPOOL_COMMUNITY_GOAL_TARGET_USDC", "").strip()
    target = target_usdc if currency == "USDC" else target_near
    decimals = 6 if currency == "USDC" else 24
    values_present = any((title, purpose, recipient, target_near, target_usdc))
    errors = []
    target_units = ""
    if currency not in {"NEAR", "USDC"}:
        errors.append("Community Goal currency must be NEAR or USDC.")
    if currency == "USDC" and target_near:
        errors.append("USDC Community Goals cannot also configure a NEAR target.")
    if currency == "NEAR" and target_usdc:
        errors.append("NEAR Community Goals cannot also configure a USDC target.")
    if values_present and not all((title, purpose, recipient, target)):
        errors.append("All Community Goal fields must be configured together.")
    if len(title) > 120 or len(purpose) > 500:
        errors.append("Community Goal title or purpose exceeds its supported length.")
    if recipient and not re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*", recipient):
        errors.append("Community Goal recipient is not a valid NEAR account ID.")
    if recipient and not 2 <= len(recipient) <= 64:
        errors.append("Community Goal recipient must be 2 to 64 characters.")
    if target:
        try:
            target_value = Decimal(target)
            scaled = target_value * (Decimal(10) ** decimals)
            if target_value <= 0 or scaled != scaled.to_integral_value():
                raise InvalidOperation
            target_units = str(int(scaled))
        except (InvalidOperation, ValueError, OverflowError):
            errors.append(
                f"Community Goal target must be a positive {currency} amount with at most {decimals} decimals."
            )
    return {
        "configured": bool(values_present and not errors),
        "title": title,
        "purpose": purpose,
        "recipient": recipient,
        "currency": currency,
        "decimals": decimals,
        "tokenId": CANONICAL_USDC_TOKEN_ID if currency == "USDC" else "",
        "targetUnits": target_units,
        "targetYocto": target_units if currency == "NEAR" else "",
        "configurationError": " ".join(errors),
    }


COMMUNITY_GOAL = _community_goal_config()
COMMUNITY_EVIDENCE = _community_evidence_config()
COMMUNITY_GARDEN_DAO_ID = "harvestpool-community-garden.sputnikv2.testnet"
COMMUNITY_GARDEN_GOAL = {
    "configured": True,
    "title": "Community Garden",
    "purpose": "Help fund community garden supplies and shared growing needs.",
    "contributionTerms": (
        "Contributions are public Testnet transfers to this fund and cannot be "
        "personally withdrawn or automatically refunded. HarvestPool stops contributions at the "
        "$100 goal in the app; the blockchain contracts do not enforce that limit."
    ),
    "recipient": "harvestpool-farmer-1.testnet",
    "currency": "USDC",
    "decimals": 6,
    "tokenId": CANONICAL_USDC_TOKEN_ID,
    "targetUnits": "100000000",
    "targetYocto": "",
    "configurationError": "",
    "uiContributionCap": True,
}
NEAR_PRICE_URL = os.environ.get(
    "HARVESTPOOL_NEAR_PRICE_URL",
    "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd&include_last_updated_at=true",
)
NEAR_PRICE_CACHE_SECONDS = max(30, int(os.environ.get("HARVESTPOOL_NEAR_PRICE_CACHE_SECONDS", "60")))
NEAR_PRICE_SOURCE = "CoinGecko"

_near_price_cache = None
_near_price_cache_lock = threading.Lock()


def _configured_community_funds():
    """Return verified fund configs without sharing DAO accounting or evidence."""
    funds = {
        "community-garden": {
            "slug": "community-garden",
            "daoId": COMMUNITY_GARDEN_DAO_ID,
            "goal": COMMUNITY_GARDEN_GOAL,
            "evidence": {},
            "category": "Neighborhood improvement",
        },
    }
    if COMMUNITY_DAO_ID and COMMUNITY_GOAL.get("configured"):
        funds["shared-community-equipment"] = {
            "slug": "shared-community-equipment",
            "daoId": COMMUNITY_DAO_ID,
            "goal": COMMUNITY_GOAL,
            "evidence": COMMUNITY_EVIDENCE,
            "category": "Community equipment",
        }
    return funds


def render_page(
    page, *, purchase_id=None, share_mode=False, fund_slug=None, community_fund=None
):
    """Render a client-driven page without moving contract authority into Flask."""
    active_fund = community_fund or {
        "daoId": COMMUNITY_DAO_ID,
        "goal": COMMUNITY_GOAL,
        "slug": fund_slug,
    }
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
        community_dao_id=active_fund.get("daoId", ""),
        community_dao_factory_id=COMMUNITY_DAO_FACTORY_ID,
        community_dao_code_hash=COMMUNITY_DAO_CODE_HASH,
        community_goal=active_fund.get("goal", {}),
        community_activity_url=(
            f"/api/community-funds/{active_fund['slug']}/activity"
            if active_fund.get("slug") in _configured_community_funds()
            else "/api/community-fund/activity"
        ),
        fund_slug=fund_slug,
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


def _community_rpc(method, params):
    """Make a bounded read-only call to finalized NEAR Testnet state."""
    request = Request(
        COMMUNITY_RPC_URL,
        data=json.dumps(
            {"jsonrpc": "2.0", "id": "harvestpool-community", "method": method, "params": params}
        ).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "HarvestPool/1.0",
        },
    )
    for attempt in range(3):
        try:
            with urlopen(request, timeout=8) as response:
                body = response.read(2_000_001)
                if len(body) > 2_000_000:
                    raise ValueError("NEAR RPC response exceeded the 2 MB safety limit")
                payload = json.loads(body.decode("utf-8"))
            if payload.get("error"):
                raise ValueError("NEAR RPC rejected the evidence lookup")
            if "result" not in payload:
                raise ValueError("NEAR RPC returned no result")
            return payload["result"]
        except HTTPError as error:
            if error.code != 429 or attempt == 2:
                raise
            retry_after = error.headers.get("Retry-After", "")
            try:
                delay = min(2.0, max(0.25, float(retry_after)))
            except (TypeError, ValueError):
                delay = 0.5 * (attempt + 1)
            time.sleep(delay)
    raise RuntimeError("NEAR RPC retry limit reached")


def _successful_execution(result):
    return result.get("final_execution_status") == "FINAL" and isinstance(
        result.get("status"), dict
    ) and any(key.startswith("Success") for key in result["status"])


def _function_call(transaction, method_name):
    actions = transaction.get("actions") or []
    if len(actions) != 1 or not isinstance(actions[0], dict):
        raise ValueError("Evidence transaction must contain one reviewed action")
    call = actions[0].get("FunctionCall")
    if not isinstance(call, dict) or call.get("method_name") != method_name:
        raise ValueError("Evidence transaction method does not match")
    try:
        args = json.loads(base64.b64decode(call.get("args") or "", validate=True).decode("utf-8"))
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Evidence transaction arguments are invalid") from error
    if not isinstance(args, dict):
        raise ValueError("Evidence transaction arguments are invalid")
    return call, args


def _successful_nep141_transfer(result, token_id, old_owner, new_owner, amount, receipt_id=None):
    matches = []
    for receipt in result.get("receipts_outcome") or []:
        outcome = receipt.get("outcome") or {}
        status = outcome.get("status") or {}
        if outcome.get("executor_id") != token_id or not any(
            key.startswith("Success") for key in status
        ):
            continue
        if receipt_id and receipt.get("id") != receipt_id:
            continue
        for log in outcome.get("logs") or []:
            if not isinstance(log, str) or not log.startswith("EVENT_JSON:"):
                continue
            try:
                event = json.loads(log.removeprefix("EVENT_JSON:"))
            except json.JSONDecodeError:
                continue
            if event.get("standard") != "nep141" or event.get("event") != "ft_transfer":
                continue
            for transfer in event.get("data") or []:
                if (
                    isinstance(transfer, dict)
                    and transfer.get("old_owner_id") == old_owner
                    and transfer.get("new_owner_id") == new_owner
                    and str(transfer.get("amount") or "") == amount
                ):
                    matches.append(receipt.get("id"))
    if len(matches) != 1:
        raise ValueError("Evidence did not contain one exact successful token transfer")
    return matches[0]


def _transaction_timestamp(result):
    block_hash = str(result.get("transaction_outcome", {}).get("block_hash") or "")
    if not block_hash:
        raise ValueError("Evidence transaction has no finalized block")
    block = _community_rpc("block", {"block_id": block_hash})
    timestamp = str(block.get("header", {}).get("timestamp_nanosec") or "")
    if not timestamp.isdigit() or int(timestamp) <= 0:
        raise ValueError("Evidence block has no valid timestamp")
    return timestamp


def _known_community_activity(dao_id, token_id, goal, evidence):
    """Verify configured public hashes against finalized RPC without trusting an indexer list."""
    if not evidence or evidence.get("error"):
        raise ValueError(evidence.get("error") if evidence else "No known evidence is configured")
    if not token_id or goal.get("currency") != "USDC":
        raise ValueError("Known Community Goal evidence requires the configured USDC token")

    contribution = _community_rpc(
        "tx",
        {
            "tx_hash": evidence["contributionHash"],
            "sender_account_id": evidence["contributor"],
            "wait_until": "FINAL",
        },
    )
    if not _successful_execution(contribution):
        raise ValueError("Configured contribution transaction did not finalize successfully")
    contribution_tx = contribution.get("transaction") or {}
    contribution_call, contribution_args = _function_call(contribution_tx, "ft_transfer")
    if (
        contribution_tx.get("hash") != evidence["contributionHash"]
        or contribution_tx.get("signer_id") != evidence["contributor"]
        or contribution_tx.get("receiver_id") != token_id
        or str(contribution_call.get("deposit") or "") != "1"
        or contribution_args.get("receiver_id") != dao_id
        or str(contribution_args.get("amount") or "") != evidence["contributionAmount"]
    ):
        raise ValueError("Configured contribution transaction does not match this goal")
    contribution_receipt = _successful_nep141_transfer(
        contribution,
        token_id,
        evidence["contributor"],
        dao_id,
        evidence["contributionAmount"],
    )

    payment = _community_rpc(
        "tx",
        {
            "tx_hash": evidence["paymentHash"],
            "sender_account_id": evidence["paymentSigner"],
            "wait_until": "FINAL",
        },
    )
    if not _successful_execution(payment):
        raise ValueError("Configured payment transaction did not finalize successfully")
    payment_tx = payment.get("transaction") or {}
    _payment_call, payment_args = _function_call(payment_tx, "act_proposal")
    if (
        payment_tx.get("hash") != evidence["paymentHash"]
        or payment_tx.get("signer_id") != evidence["paymentSigner"]
        or payment_tx.get("receiver_id") != dao_id
        or str(payment_args.get("id")) != evidence["paymentProposalId"]
        or payment_args.get("action") != "VoteApprove"
    ):
        raise ValueError("Configured payment transaction does not match this DAO proposal")
    payment_receipt = _successful_nep141_transfer(
        payment,
        token_id,
        dao_id,
        goal.get("recipient"),
        evidence["paymentAmount"],
        evidence["paymentReceiptId"],
    )

    return {
        "complete": True,
        "boundedEvidence": True,
        "contributions": [
            {
                "amount": evidence["contributionAmount"],
                "contributor": evidence["contributor"],
                "timestamp": _transaction_timestamp(contribution),
                "transactionHash": evidence["contributionHash"],
                "receiptId": contribution_receipt,
                "tokenId": token_id,
            }
        ],
        "proposalTransactions": {
            evidence["paymentProposalId"]: [
                {
                    "action": "VoteApprove",
                    "signer": evidence["paymentSigner"],
                    "timestamp": _transaction_timestamp(payment),
                    "transactionHash": evidence["paymentHash"],
                    "transfers": [
                        {
                            "amount": evidence["paymentAmount"],
                            "receiver": goal.get("recipient"),
                            "receiptId": payment_receipt,
                            "tokenId": token_id,
                        }
                    ],
                }
            ]
        },
        "source": "Finalized NEAR Testnet RPC evidence",
        "sourceUrl": f"https://testnet.nearblocks.io/address/{dao_id}",
        "tokenId": token_id,
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "stale": False,
    }


def _nearblocks_account_pages(dao_id, suffix):
    records = []
    next_page = None
    complete = True
    for _page in range(5):
        params = {"limit": 100}
        if next_page:
            params["next"] = next_page
        payload = _nearblocks_json(
            f"/v3/accounts/{quote(dao_id, safe='.')}/{suffix}", params
        )
        batch = payload.get("data")
        if not isinstance(batch, list):
            raise ValueError("NearBlocks returned an invalid transaction list")
        records.extend(batch)
        next_page = payload.get("meta", {}).get("next_page")
        if not next_page:
            break
    else:
        complete = not bool(next_page)
    return records, complete


def _community_activity(dao_id, token_id=""):
    transactions, complete = _nearblocks_account_pages(dao_id, "txns")
    ft_events = []
    if token_id:
        ft_events, ft_complete = _nearblocks_account_pages(dao_id, "ft-txns")
        complete = complete and ft_complete
        ft_events = [
            event for event in ft_events
            if str(event.get("contract_account_id") or "") == token_id
        ]

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
            not token_id
            and success
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
            successful_receipt_ids = set()

            def collect_successful_receipts(receipt):
                if not isinstance(receipt, dict):
                    return
                receipt_id = str(receipt.get("receipt_id") or "")
                if receipt_id and receipt.get("outcome", {}).get("status") is True:
                    successful_receipt_ids.add(receipt_id)
                for child in receipt.get("receipts") or []:
                    collect_successful_receipts(child)

            collect_successful_receipts(receipt_root)

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

            if not token_id:
                collect_transfers(receipt_root)
            else:
                for event in ft_events:
                    if str(event.get("transaction_hash") or "") != transaction_hash:
                        continue
                    amount = str(event.get("delta_amount") or "")
                    receipt_id = str(event.get("receipt_id") or "")
                    if (
                        not re.fullmatch(r"-\d+", amount)
                        or not receipt_id
                        or receipt_id not in successful_receipt_ids
                    ):
                        continue
                    transfers.append(
                        {
                            "amount": amount[1:],
                            "receiver": str(event.get("involved_account_id") or ""),
                            "receiptId": receipt_id,
                            "tokenId": token_id,
                        }
                    )
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
        except (OSError, URLError, RuntimeError, ValueError, TypeError, json.JSONDecodeError):
            receipt_reads_complete = False
            continue

    if token_id:
        for event in ft_events:
            amount = str(event.get("delta_amount") or "")
            if not re.fullmatch(r"\d+", amount) or int(amount) <= 0:
                continue
            contributor = str(event.get("involved_account_id") or "")
            transaction_hash = str(event.get("transaction_hash") or "")
            if contributor and transaction_hash:
                contributions.append(
                    {
                        "amount": amount,
                        "contributor": contributor,
                        "timestamp": str(event.get("block_timestamp") or "0"),
                        "transactionHash": transaction_hash,
                        "receiptId": str(event.get("receipt_id") or ""),
                        "tokenId": token_id,
                    }
                )

    complete = complete and len(proposal_candidates) <= 40 and receipt_reads_complete

    verified_at = datetime.now(timezone.utc).isoformat()
    return {
        "complete": complete,
        "contributions": contributions,
        "proposalTransactions": proposal_transactions,
        "source": "NearBlocks Testnet API",
        "sourceUrl": f"https://testnet.nearblocks.io/address/{dao_id}",
        "tokenId": token_id,
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


def _merge_community_activity(evidence, indexed):
    """Keep finalized baseline evidence while adding newly indexed public transactions."""
    contributions = {}
    for item in [*(evidence.get("contributions") or []), *(indexed.get("contributions") or [])]:
        transaction_hash = str(item.get("transactionHash") or "")
        if transaction_hash:
            contributions[transaction_hash] = item

    proposal_transactions = {}
    proposal_ids = set(evidence.get("proposalTransactions") or {}) | set(
        indexed.get("proposalTransactions") or {}
    )
    for proposal_id in proposal_ids:
        actions = {}
        for item in [
            *(evidence.get("proposalTransactions", {}).get(proposal_id) or []),
            *(indexed.get("proposalTransactions", {}).get(proposal_id) or []),
        ]:
            key = (str(item.get("transactionHash") or ""), str(item.get("action") or ""))
            if key[0]:
                actions[key] = item
        proposal_transactions[proposal_id] = list(actions.values())

    indexed_complete = bool(indexed.get("complete"))
    return {
        **indexed,
        "complete": indexed_complete,
        "boundedEvidence": not indexed_complete,
        "contributions": list(contributions.values()),
        "proposalTransactions": proposal_transactions,
        "source": "Finalized NEAR RPC evidence + NearBlocks Testnet API",
        "sourceUrl": indexed.get("sourceUrl") or evidence.get("sourceUrl"),
        "stale": not indexed_complete,
    }


def _cached_community_activity(
    dao_id, token_id="", *, force=False, goal=None, evidence=None
):
    cache_key = (dao_id, token_id)
    now = time.monotonic()
    with _community_activity_cache_lock:
        cached = _community_activity_cache.get(cache_key)
        if cached and not force and now - cached["cached_at"] < COMMUNITY_ACTIVITY_CACHE_SECONDS:
            return dict(cached["payload"])
    try:
        selected_goal = COMMUNITY_GOAL if goal is None else goal
        selected_evidence = COMMUNITY_EVIDENCE if evidence is None else evidence
        if selected_evidence:
            known_evidence = _known_community_activity(
                dao_id, token_id, selected_goal, selected_evidence
            )
            try:
                indexed = _community_activity(dao_id, token_id)
            except (OSError, URLError, RuntimeError, ValueError, TypeError, json.JSONDecodeError):
                payload = known_evidence
            else:
                payload = _merge_community_activity(known_evidence, indexed)
        else:
            payload = _community_activity(dao_id, token_id)
    except (OSError, URLError, RuntimeError, ValueError, TypeError, json.JSONDecodeError):
        with _community_activity_cache_lock:
            cached = _community_activity_cache.get(cache_key)
            if cached and now - cached["cached_at"] < COMMUNITY_ACTIVITY_STALE_SECONDS:
                stale_payload = dict(cached["payload"])
                stale_payload["stale"] = True
                return stale_payload
        raise
    with _community_activity_cache_lock:
        cached = _community_activity_cache.get(cache_key)
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
        _community_activity_cache[cache_key] = {"cached_at": time.monotonic(), "payload": payload}
    return dict(payload)


def _peek_community_activity_cache(dao_id, token_id=""):
    """Return only fresh, already-verified activity without starting an indexer read."""
    cache_key = (dao_id, token_id)
    now = time.monotonic()
    with _community_activity_cache_lock:
        cached = _community_activity_cache.get(cache_key)
        if cached and now - cached["cached_at"] < COMMUNITY_ACTIVITY_CACHE_SECONDS:
            return dict(cached["payload"])
    return None


@app.get("/api/community-fund/activity")
def community_fund_activity():
    if not COMMUNITY_DAO_ID:
        return jsonify({"error": "Community Goals DAO is not configured."}), 404
    try:
        force = request.args.get("refresh") == "1"
        token_id = COMMUNITY_GOAL.get("tokenId", "") if COMMUNITY_GOAL.get("configured") else ""
        return jsonify(_cached_community_activity(COMMUNITY_DAO_ID, token_id, force=force))
    except (OSError, URLError, RuntimeError, ValueError, TypeError, json.JSONDecodeError) as error:
        return jsonify({"error": f"Community Goals transaction history unavailable: {error}"}), 503


@app.get("/api/community-funds/<slug>/activity")
def configured_community_fund_activity(slug):
    fund = _configured_community_funds().get(slug)
    if not fund:
        return jsonify({"error": "Verified Community Fund is not configured."}), 404
    try:
        force = request.args.get("refresh") == "1"
        goal = fund["goal"]
        token_id = goal.get("tokenId", "") if goal.get("configured") else ""
        return jsonify(_cached_community_activity(
            fund["daoId"], token_id, force=force, goal=goal, evidence=fund["evidence"]
        ))
    except (OSError, URLError, RuntimeError, ValueError, TypeError, json.JSONDecodeError) as error:
        return jsonify({"error": f"Community Fund transaction history unavailable: {error}"}), 503


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
        _ensure_community_fund_schema(g.db)
    return g.db


COMMUNITY_FUND_CATEGORIES = {
    "Community equipment",
    "Food access",
    "Education",
    "Emergency support",
    "Neighborhood improvement",
    "Other",
}
def _ensure_community_fund_schema(db):
    """Create additive local metadata tables; this never changes on-chain state."""
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS community_fund_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            city TEXT NOT NULL,
            state TEXT NOT NULL,
            description TEXT NOT NULL,
            intended_purpose TEXT NOT NULL,
            cover_image_url TEXT NOT NULL DEFAULT '',
            organizer_name TEXT NOT NULL,
            contact_email TEXT NOT NULL,
            organizer_role TEXT NOT NULL,
            contact_method TEXT NOT NULL DEFAULT '',
            share_contact INTEGER NOT NULL DEFAULT 0 CHECK (share_contact IN (0, 1)),
            target_cents INTEGER NOT NULL CHECK (target_cents > 0),
            budget TEXT NOT NULL,
            contribution_deadline TEXT NOT NULL,
            completion_date TEXT NOT NULL,
            beneficiary TEXT NOT NULL,
            reached_terms TEXT NOT NULL,
            not_reached_terms TEXT NOT NULL,
            payment_requesters TEXT NOT NULL,
            payment_approvers TEXT NOT NULL,
            payment_refund_rules TEXT NOT NULL,
            unused_money_terms TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'Awaiting Fund Setup',
            owner_token_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS community_fund_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fund_id INTEGER NOT NULL REFERENCES community_fund_requests(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            summary TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS community_fund_events_fund_id
            ON community_fund_events(fund_id, id);
        """
    )
    db.commit()


def _owner_token_hash(value):
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def _clean_text(payload, name, *, minimum=1, maximum=2000, errors):
    value = str(payload.get(name, "")).strip()
    if len(value) < minimum:
        errors[name] = "This field is required."
    elif len(value) > maximum:
        errors[name] = f"Use {maximum} characters or fewer."
    return value


def _fund_slug(db, title):
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60] or "community-fund"
    slug = base
    counter = 2
    while db.execute("SELECT 1 FROM community_fund_requests WHERE slug = ?", (slug,)).fetchone():
        slug = f"{base}-{counter}"
        counter += 1
    return slug


def _validate_community_fund(payload):
    errors = {}
    fields = {
        "title": _clean_text(payload, "title", maximum=120, errors=errors),
        "category": _clean_text(payload, "category", maximum=80, errors=errors),
        "city": _clean_text(payload, "city", maximum=80, errors=errors),
        "state": _clean_text(payload, "state", maximum=2, errors=errors).upper(),
        "description": _clean_text(payload, "description", minimum=40, maximum=3000, errors=errors),
        "intended_purpose": _clean_text(payload, "intended_purpose", minimum=20, maximum=1000, errors=errors),
        "organizer_name": _clean_text(payload, "organizer_name", maximum=120, errors=errors),
        "contact_email": _clean_text(payload, "contact_email", maximum=254, errors=errors),
        "organizer_role": _clean_text(payload, "organizer_role", maximum=160, errors=errors),
        "budget": _clean_text(payload, "budget", minimum=20, maximum=3000, errors=errors),
        "contribution_deadline": _clean_text(payload, "contribution_deadline", maximum=10, errors=errors),
        "completion_date": _clean_text(payload, "completion_date", maximum=10, errors=errors),
        "beneficiary": _clean_text(payload, "beneficiary", maximum=200, errors=errors),
        "reached_terms": _clean_text(payload, "reached_terms", minimum=20, maximum=1500, errors=errors),
        "not_reached_terms": _clean_text(payload, "not_reached_terms", minimum=20, maximum=1500, errors=errors),
        "payment_requesters": _clean_text(payload, "payment_requesters", minimum=10, maximum=500, errors=errors),
        "payment_approvers": _clean_text(payload, "payment_approvers", minimum=10, maximum=500, errors=errors),
        "payment_refund_rules": _clean_text(payload, "payment_refund_rules", minimum=20, maximum=1500, errors=errors),
        "unused_money_terms": _clean_text(payload, "unused_money_terms", minimum=20, maximum=1500, errors=errors),
    }
    fields["cover_image_url"] = str(payload.get("cover_image_url", "")).strip()[:1000]
    fields["contact_method"] = str(payload.get("contact_method", "")).strip()[:300]
    fields["share_contact"] = payload.get("share_contact") is True
    if fields["category"] not in COMMUNITY_FUND_CATEGORIES:
        errors["category"] = "Choose a listed category."
    if not re.fullmatch(r"[A-Z]{2}", fields["state"]):
        errors["state"] = "Enter a two-letter US state code."
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", fields["contact_email"]):
        errors["contact_email"] = "Enter a valid email address."
    if fields["cover_image_url"]:
        parsed = urlparse(fields["cover_image_url"])
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            errors["cover_image_url"] = "Enter a complete http:// or https:// image URL."
    try:
        amount = Decimal(str(payload.get("target_amount", "")))
        cents = amount * 100
        if amount < Decimal("1") or amount > Decimal("1000000") or cents != cents.to_integral_value():
            raise InvalidOperation
        fields["target_cents"] = int(cents)
    except (InvalidOperation, ValueError, TypeError):
        errors["target_amount"] = "Enter an amount from $1.00 to $1,000,000.00 with at most two decimals."
    today = datetime.now(timezone.utc).date()
    parsed_dates = {}
    for name in ("contribution_deadline", "completion_date"):
        try:
            parsed_dates[name] = datetime.strptime(fields[name], "%Y-%m-%d").date()
        except ValueError:
            errors[name] = "Enter a valid date."
    if parsed_dates.get("contribution_deadline") and parsed_dates["contribution_deadline"] < today:
        errors["contribution_deadline"] = "The contribution deadline cannot be in the past."
    if parsed_dates.get("completion_date") and parsed_dates.get("contribution_deadline") and parsed_dates["completion_date"] < parsed_dates["contribution_deadline"]:
        errors["completion_date"] = "The completion date must be on or after the contribution deadline."
    if payload.get("terms_acknowledged") is not True:
        errors["terms_acknowledged"] = "Confirm that these are proposed terms and contributions stay disabled until setup."
    token = str(payload.get("owner_token", "")).strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,128}", token):
        errors["owner_token"] = "This browser could not create a secure organizer reference. Refresh and try again."
    fields["owner_token_hash"] = _owner_token_hash(token)
    return fields, errors


def _public_fund(row, *, owner_token="", include_private=False):
    item = dict(row)
    item["targetAmount"] = f"{Decimal(item.pop('target_cents')) / Decimal(100):.2f}"
    item["location"] = f"{item['city']}, {item['state']}"
    item["isMine"] = bool(owner_token and item.pop("owner_token_hash") == _owner_token_hash(owner_token))
    item.pop("owner_token_hash", None)
    item["shareContact"] = bool(item.pop("share_contact"))
    if not include_private:
        item.pop("contact_email", None)
        if not item["shareContact"]:
            item.pop("contact_method", None)
    return item


@app.teardown_appcontext
def close_db(_error):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def _verified_fund_directory_item(fund, *, cached_only=False):
    """Return one verified treasury without mixing its activity with another fund."""
    dao_id = fund["daoId"]
    goal = fund["goal"]
    if not dao_id or not goal.get("configured"):
        return None
    contributed = None
    contributor_count = None
    try:
        activity = (
            _peek_community_activity_cache(dao_id, goal.get("tokenId", ""))
            if cached_only
            else _cached_community_activity(
                dao_id, goal.get("tokenId", ""), goal=goal, evidence=fund["evidence"]
            )
        )
        if activity is None:
            raise RuntimeError("Verified activity is not cached yet.")
        if activity.get("complete") or activity.get("boundedEvidence"):
            contributions = activity.get("contributions", [])
            contributed = sum(int(item.get("amount", "0")) for item in contributions)
            contributor_count = len({
                item.get("contributor") or item.get("account")
                for item in contributions
                if item.get("contributor") or item.get("account")
            })
    except (OSError, URLError, RuntimeError, ValueError, TypeError, json.JSONDecodeError):
        pass
    target = int(goal.get("targetUnits") or goal.get("targetYocto") or "0")
    if contributed is None:
        status = "In Progress"
    elif contributed >= target:
        status = "Goal reached"
    else:
        status = "Open for contributions"
    decimals = int(goal.get("decimals", 6))
    amount = None if contributed is None else f"{Decimal(contributed) / (Decimal(10) ** decimals):.2f}"
    target_amount = f"{Decimal(target) / (Decimal(10) ** decimals):.2f}"
    return {
        "slug": fund["slug"],
        "title": goal["title"],
        "category": fund["category"],
        "location": "Online · NEAR Testnet",
        "description": goal["purpose"],
        "status": status,
        "targetAmount": target_amount,
        "raisedAmount": amount,
        "contributorsCount": contributor_count,
        "contribution_deadline": "No deadline configured",
        "isVerifiedFund": True,
        "isMine": False,
        "detailUrl": f"/community-funds/{fund['slug']}",
        "activityUrl": f"/api/community-funds/{fund['slug']}/activity",
        "decimals": decimals,
    }


@app.get("/api/community-funds")
def list_community_funds():
    owner_token = request.headers.get("X-HarvestPool-Owner-Token", "")
    rows = get_db().execute(
        "SELECT * FROM community_fund_requests ORDER BY created_at DESC, id DESC"
    ).fetchall()
    items = []
    for fund in _configured_community_funds().values():
        # The directory shell must never wait serially for third-party indexer reads. Each
        # verified card hydrates its own finalized activity after this response is rendered.
        verified = _verified_fund_directory_item(fund, cached_only=True)
        if verified:
            items.append(verified)
    for row in rows:
        item = _public_fund(row, owner_token=owner_token)
        item.update(
            {
                "raisedAmount": "0.00",
                "contributorsCount": 0,
                "isVerifiedFund": False,
                "detailUrl": f"/community-funds/{quote(item['slug'])}",
            }
        )
        items.append(item)
    return jsonify({"funds": items})


@app.post("/api/community-funds")
def create_community_fund_request():
    if request.content_length is not None and request.content_length > 64 * 1024:
        return jsonify({"error": "The fund request is too large."}), 413
    if not request.is_json:
        return jsonify({"error": "Send the fund request as JSON."}), 415
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "The fund request is not valid JSON."}), 400
    fields, errors = _validate_community_fund(payload)
    if errors:
        return jsonify({"error": "Review the highlighted fields.", "fields": errors}), 400
    db = get_db()
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    slug = _fund_slug(db, fields["title"])
    columns = [
        "slug", "title", "category", "city", "state", "description", "intended_purpose",
        "cover_image_url", "organizer_name", "contact_email", "organizer_role", "contact_method",
        "share_contact", "target_cents", "budget", "contribution_deadline", "completion_date",
        "beneficiary", "reached_terms", "not_reached_terms", "payment_requesters",
        "payment_approvers", "payment_refund_rules", "unused_money_terms", "status",
        "owner_token_hash", "created_at", "updated_at",
    ]
    values = {
        **fields,
        "slug": slug,
        "status": "Awaiting Fund Setup",
        "created_at": now,
        "updated_at": now,
    }
    placeholders = ", ".join("?" for _ in columns)
    cursor = db.execute(
        f"INSERT INTO community_fund_requests ({', '.join(columns)}) VALUES ({placeholders})",
        [values[name] for name in columns],
    )
    db.execute(
        "INSERT INTO community_fund_events (fund_id, event_type, summary, created_at) VALUES (?, ?, ?, ?)",
        (cursor.lastrowid, "Fund request submitted", "Submitted for treasury and payment-rule review.", now),
    )
    db.commit()
    return jsonify(
        {
            "status": "Awaiting Fund Setup",
            "slug": slug,
            "url": f"/community-funds/{quote(slug)}",
            "message": "Fund request saved. Contributions remain disabled until an isolated treasury and reviewed payment rules are configured.",
        }
    ), 201


@app.get("/api/community-funds/<slug>")
def community_fund_request_detail(slug):
    owner_token = request.headers.get("X-HarvestPool-Owner-Token", "")
    row = get_db().execute(
        "SELECT * FROM community_fund_requests WHERE slug = ?", (slug,)
    ).fetchone()
    if row is None:
        return jsonify({"error": "Community fund not found."}), 404
    is_owner = bool(owner_token and row["owner_token_hash"] == _owner_token_hash(owner_token))
    item = _public_fund(row, owner_token=owner_token, include_private=is_owner)
    events = [dict(event) for event in get_db().execute(
        "SELECT event_type, summary, created_at FROM community_fund_events WHERE fund_id = ? ORDER BY id DESC",
        (row["id"],),
    ).fetchall()]
    item.update(
        {
            "raisedAmount": "0.00",
            "contributorsCount": 0,
            "events": events,
            "contributions": [],
            "paymentRequests": [],
            "votes": [],
        }
    )
    return jsonify({"fund": item})


@app.get("/")
def index():
    return render_page("home")


@app.get("/favicon.ico")
def favicon():
    return "", 204


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
@app.get("/community-funds")
def community_fund():
    return render_page("community_directory")


@app.get("/community-funds/start")
def start_community_fund():
    return render_page("community_create")


@app.get("/community-funds/shared-community-equipment")
@app.get("/community-fund")
def verified_community_fund():
    fund = _configured_community_funds().get("shared-community-equipment")
    return render_page(
        "community_fund", fund_slug="shared-community-equipment", community_fund=fund
    )


@app.get("/community-funds/community-garden")
def community_garden_fund():
    fund = _configured_community_funds()["community-garden"]
    return render_page(
        "community_fund", fund_slug="community-garden", community_fund=fund
    )


@app.get("/community-funds/<slug>")
def requested_community_fund(slug):
    if get_db().execute("SELECT 1 FROM community_fund_requests WHERE slug = ?", (slug,)).fetchone() is None:
        return render_page("community_not_found", fund_slug=slug), 404
    return render_page("community_request", fund_slug=slug)


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
