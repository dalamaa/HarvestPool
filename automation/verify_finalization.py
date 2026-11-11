"""Read-only verification of a historical V5 finalization transaction."""

from __future__ import annotations

import argparse
import base64
import json
from typing import Any

from automation.finalizer import FINAL_METHOD, NearRpc, RpcError, V5_CONTRACT_ID


DEAL_4_TRANSACTION = "2wJwt7JuDW6NpTQjBh96TBRhiMY9jvVpMaRH9DDBEHzH"
DEAL_4_SIGNER = "service.harvestpool-v5-finalizer-20261111.testnet"


def verify(
    rpc: NearRpc,
    tx_hash: str = DEAL_4_TRANSACTION,
    signer_id: str = DEAL_4_SIGNER,
    purchase_id: str = "4",
) -> dict[str, Any]:
    outcome = rpc.transaction(tx_hash, signer_id)
    if outcome is None:
        raise RpcError("transaction is not available at finality")
    transaction = outcome.get("transaction") or {}
    actions = transaction.get("actions") or []
    if transaction.get("signer_id") != signer_id or transaction.get("receiver_id") != V5_CONTRACT_ID:
        raise RpcError("transaction signer or receiver does not match the recorded canary")
    if len(actions) != 1 or "FunctionCall" not in actions[0]:
        raise RpcError("transaction must contain exactly one function-call action")
    action = actions[0]["FunctionCall"]
    try:
        arguments = json.loads(base64.b64decode(action["args"]).decode("utf-8"))
    except (KeyError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RpcError("transaction arguments are invalid") from error
    if action.get("method_name") != FINAL_METHOD or arguments != {"purchase_id": purchase_id}:
        raise RpcError("transaction method or purchase ID does not match the recorded canary")
    if str(action.get("deposit")) != "0":
        raise RpcError("finalization transaction unexpectedly attached a deposit")
    if "SuccessValue" not in (outcome.get("status") or {}):
        raise RpcError("transaction does not have a successful final outcome")
    purchase = rpc.view(V5_CONTRACT_ID, "get_purchase", {"purchase_id": purchase_id})
    if not purchase or purchase.get("state") not in {"Funded", "Failed"}:
        raise RpcError("purchase does not have an authoritative final state")
    return {
        "transaction_hash": tx_hash,
        "signer_id": signer_id,
        "receiver_id": V5_CONTRACT_ID,
        "method_name": FINAL_METHOD,
        "purchase_id": purchase_id,
        "deposit": "0",
        "transaction_status": "SuccessValue",
        "authoritative_purchase_state": purchase["state"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc-url", default="https://rpc.testnet.fastnear.com")
    parser.add_argument("--transaction-hash", default=DEAL_4_TRANSACTION)
    parser.add_argument("--signer-id", default=DEAL_4_SIGNER)
    parser.add_argument("--purchase-id", default="4")
    args = parser.parse_args()
    try:
        print(json.dumps(verify(NearRpc(args.rpc_url), args.transaction_hash, args.signer_id, args.purchase_id), sort_keys=True))
    except RpcError as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
