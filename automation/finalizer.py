"""Permission-limited, durable V5 purchase finalization worker.

The worker is disabled by default.  It can call only ``finalize_purchase`` and deliberately has
no code path for refunds, reconciliation, fulfillment, or supplier payments.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import os
import secrets
import signal
import sqlite3
import stat
import struct
import threading
import time
from contextlib import closing
from dataclasses import dataclass, replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


FINAL_METHOD = "finalize_purchase"
V5_CONTRACT_ID = "harvestpool-v5-usdc-dalamaa-20261109.testnet"
V5_TOKEN_ID = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"
V5_TOKEN_DECIMALS = 6
ELIGIBLE_STATES = {"Open", "AwaitingSupplier"}
FINAL_STATES = {"Funded", "Failed"}
GAS = 30_000_000_000_000
LOG = logging.getLogger("harvestpool.finalizer")


class RpcError(RuntimeError):
    pass


class ConfigurationError(RuntimeError):
    pass


def _base58_decode(value: str) -> bytes:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number = 0
    for char in value:
        try:
            digit = alphabet.index(char)
        except ValueError as error:
            raise ConfigurationError("invalid base58 key material") from error
        number = number * 58 + digit
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    return b"\0" * (len(value) - len(value.lstrip("1"))) + raw


def _base58_encode(value: bytes) -> str:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    zeroes = len(value) - len(value.lstrip(b"\0"))
    number = int.from_bytes(value, "big")
    encoded = ""
    while number:
        number, digit = divmod(number, 58)
        encoded = alphabet[digit] + encoded
    return "1" * zeroes + encoded


def _borsh_bytes(value: bytes) -> bytes:
    return struct.pack("<I", len(value)) + value


def _borsh_string(value: str) -> bytes:
    return _borsh_bytes(value.encode("utf-8"))


class NearRpc:
    def __init__(self, url: str, timeout: float = 10.0, api_key: str | None = None):
        self.url = url
        self.timeout = timeout
        self.api_key = api_key
        self._request_id = 0

    def request(self, method: str, params: Any) -> Any:
        self._request_id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._request_id, "method": method, "params": params}).encode()
        headers = {"Content-Type": "application/json", "User-Agent": "HarvestPool-Finalizer/1"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = Request(self.url, data=body, headers=headers)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (OSError, HTTPError, URLError, json.JSONDecodeError) as error:
            raise RpcError(f"RPC transport failure: {error}") from error
        if payload.get("error"):
            raise RpcError(json.dumps(payload["error"], sort_keys=True))
        return payload.get("result")

    def view(self, contract_id: str, method: str, args: dict[str, Any] | None = None) -> Any:
        result = self.request("query", {
            "request_type": "call_function", "finality": "final", "account_id": contract_id,
            "method_name": method, "args_base64": base64.b64encode(json.dumps(args or {}).encode()).decode(),
        })
        try:
            return json.loads(bytes(result["result"]).decode("utf-8"))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise RpcError(f"invalid view response for {method}") from error

    def chain_time_ns(self) -> int:
        result = self.request("status", [])
        value = result["sync_info"]["latest_block_time"]
        # RFC3339 has nanoseconds; retaining microseconds is sufficient for a deadline gate.
        from datetime import datetime
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1_000_000_000)

    def access_key(self, account_id: str, public_key: str) -> dict[str, Any]:
        return self.request("query", {"request_type": "view_access_key", "finality": "final", "account_id": account_id, "public_key": public_key})

    def broadcast(self, signed_transaction: str) -> Any:
        return self.request("broadcast_tx_async", [signed_transaction])

    def transaction(self, tx_hash: str, signer_id: str) -> Any | None:
        try:
            return self.request("tx", {"tx_hash": tx_hash, "sender_account_id": signer_id, "wait_until": "FINAL"})
        except RpcError as error:
            if "UNKNOWN_TRANSACTION" in str(error).upper() or "doesn't exist" in str(error):
                return None
            raise


@dataclass(frozen=True)
class Credentials:
    account_id: str
    public_key: str
    private_key: str

    @classmethod
    def load(cls, path: Path) -> "Credentials":
        if not path.is_file():
            raise ConfigurationError(f"credentials file not found: {path}")
        if stat.S_IMODE(path.stat().st_mode) & 0o077:
            raise ConfigurationError("credentials file must not be group- or world-accessible")
        payload = json.loads(path.read_text(encoding="utf-8"))
        try:
            return cls(payload["account_id"], payload["public_key"], payload["private_key"])
        except KeyError as error:
            raise ConfigurationError(f"credentials file is missing {error.args[0]}") from error


class NearSigner:
    def __init__(self, credentials: Credentials):
        self.credentials = credentials

    def validate(self, rpc: NearRpc, contract_id: str) -> dict[str, Any]:
        access_key = rpc.access_key(self.credentials.account_id, self.credentials.public_key)
        permission = access_key.get("permission")
        if not isinstance(permission, dict) or "FunctionCall" not in permission:
            raise ConfigurationError("service key must be a restricted function-call key, not FullAccess")
        restriction = permission["FunctionCall"]
        methods = restriction.get("method_names") or []
        if restriction.get("receiver_id") != contract_id or set(methods) != {FINAL_METHOD}:
            raise ConfigurationError("service key must be restricted to this contract and finalize_purchase only")
        allowance = restriction.get("allowance")
        try:
            finite_allowance = int(allowance)
        except (TypeError, ValueError) as error:
            raise ConfigurationError("service key must have a finite positive gas allowance") from error
        if finite_allowance <= 0:
            raise ConfigurationError("service key must have a finite positive gas allowance")
        return access_key

    def prepare(self, rpc: NearRpc, contract_id: str, purchase_id: str) -> tuple[str, str]:
        access_key = self.validate(rpc, contract_id)
        public_raw = _base58_decode(self.credentials.public_key.removeprefix("ed25519:"))
        private_raw = _base58_decode(self.credentials.private_key.removeprefix("ed25519:"))
        block_hash = _base58_decode(access_key["block_hash"])
        if len(public_raw) != 32 or len(private_raw) not in {32, 64} or len(block_hash) != 32:
            raise ConfigurationError("invalid NEAR ed25519 credential length")
        private_key = Ed25519PrivateKey.from_private_bytes(private_raw[:32])
        derived_public = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        if derived_public != public_raw:
            raise ConfigurationError("private key does not match the configured public key")
        args = json.dumps({"purchase_id": str(purchase_id)}, separators=(",", ":")).encode()
        action = b"\x02" + _borsh_string(FINAL_METHOD) + _borsh_bytes(args) + struct.pack("<Q", GAS) + (0).to_bytes(16, "little")
        transaction = (
            _borsh_string(self.credentials.account_id) + b"\x00" + public_raw
            + struct.pack("<Q", int(access_key["nonce"]) + 1)
            + _borsh_string(contract_id) + block_hash + struct.pack("<I", 1) + action
        )
        digest = hashlib.sha256(transaction).digest()
        signature = private_key.sign(digest)
        signed = transaction + b"\x00" + signature
        return _base58_encode(digest), base64.b64encode(signed).decode()


@dataclass(frozen=True)
class Config:
    enabled: bool = False
    rpc_url: str = "https://rpc.testnet.fastnear.com"
    rpc_timeout_seconds: float = 10.0
    rpc_api_key: str | None = None
    contract_id: str = V5_CONTRACT_ID
    database: Path = Path("automation/finalizer.sqlite3")
    credentials_file: Path | None = None
    poll_seconds: int = 60
    lease_seconds: int = 90
    rebroadcast_seconds: int = 30
    max_same_tx_broadcasts: int = 3
    health_host: str = "127.0.0.1"
    health_port: int = 8091
    health_stale_seconds: int = 180
    purchase_ids: tuple[str, ...] | None = None
    dry_run: bool = False
    reconcile_only: bool = False

    @classmethod
    def from_env(cls) -> "Config":
        enabled = os.environ.get("HARVESTPOOL_FINALIZER_ENABLED", "").lower() in {"1", "true", "yes"}
        credential_value = os.environ.get("HARVESTPOOL_FINALIZER_CREDENTIALS_FILE")
        purchase_ids_value = os.environ.get("HARVESTPOOL_FINALIZER_PURCHASE_IDS")
        purchase_ids = None
        if purchase_ids_value is not None:
            purchase_ids = tuple(part.strip() for part in purchase_ids_value.split(",") if part.strip())
            if not purchase_ids:
                raise ConfigurationError("HARVESTPOOL_FINALIZER_PURCHASE_IDS must contain at least one purchase ID")
            _validate_purchase_ids(purchase_ids)
        poll_seconds = max(15, int(os.environ.get("HARVESTPOOL_FINALIZER_POLL_SECONDS", cls.poll_seconds)))
        stale_default = max(poll_seconds * 3, poll_seconds + 30)
        health_stale_seconds = int(os.environ.get("HARVESTPOOL_FINALIZER_HEALTH_STALE_SECONDS", stale_default))
        if health_stale_seconds <= poll_seconds:
            raise ConfigurationError("HARVESTPOOL_FINALIZER_HEALTH_STALE_SECONDS must exceed the polling interval")
        rpc_timeout_seconds = float(os.environ.get("HARVESTPOOL_FINALIZER_RPC_TIMEOUT_SECONDS", cls.rpc_timeout_seconds))
        if not 1 <= rpc_timeout_seconds <= 60:
            raise ConfigurationError("HARVESTPOOL_FINALIZER_RPC_TIMEOUT_SECONDS must be between 1 and 60")
        return cls(
            enabled=enabled,
            rpc_url=os.environ.get("HARVESTPOOL_FINALIZER_RPC_URL", cls.rpc_url),
            rpc_timeout_seconds=rpc_timeout_seconds,
            rpc_api_key=os.environ.get("FASTNEAR_API_KEY") or None,
            contract_id=os.environ.get("HARVESTPOOL_FINALIZER_CONTRACT_ID", cls.contract_id),
            database=Path(os.environ.get("HARVESTPOOL_FINALIZER_DB", str(cls.database))),
            credentials_file=Path(credential_value) if credential_value else None,
            poll_seconds=poll_seconds,
            health_host=os.environ.get("HARVESTPOOL_FINALIZER_HEALTH_HOST", cls.health_host),
            health_port=int(os.environ.get("HARVESTPOOL_FINALIZER_HEALTH_PORT", cls.health_port)),
            health_stale_seconds=health_stale_seconds,
            purchase_ids=purchase_ids,
        )


def _validate_purchase_ids(purchase_ids: tuple[str, ...]) -> None:
    if any(not value.isdecimal() or str(int(value)) != value for value in purchase_ids):
        raise ConfigurationError("purchase IDs must be canonical non-negative integers")
    if len(set(purchase_ids)) != len(purchase_ids):
        raise ConfigurationError("purchase IDs must not be duplicated")


class Store:
    def __init__(self, path: Path, now: Callable[[], float] = time.time):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.now = now
        self._initialize()

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=10000")
        return db

    def _initialize(self) -> None:
        with closing(self.connect()) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS finalizations (
                    purchase_id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, status TEXT NOT NULL,
                    expected_state TEXT, observed_state TEXT, tx_hash TEXT, signed_tx TEXT,
                    broadcast_count INTEGER NOT NULL DEFAULT 0, last_broadcast_at REAL,
                    lease_owner TEXT, lease_until REAL,
                    last_error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS finalization_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id TEXT NOT NULL,
                    event TEXT NOT NULL, detail TEXT, created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS worker_locks (
                    name TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until REAL NOT NULL
                );
            """)

    def discover(self, contract_id: str, purchase_id: str, expected: str) -> None:
        now = self.now()
        with closing(self.connect()) as db:
            cursor = db.execute("INSERT OR IGNORE INTO finalizations (purchase_id, contract_id, status, expected_state, created_at, updated_at) VALUES (?, ?, 'eligible', ?, ?, ?)", (purchase_id, contract_id, expected, now, now))
            if cursor.rowcount:
                db.execute("INSERT INTO finalization_events (purchase_id, event, detail, created_at) VALUES (?, 'discovered', ?, ?)", (purchase_id, expected, now))
                LOG.info(json.dumps({"event": "discovered", "purchase_id": purchase_id, "expected_state": expected}))

    def candidates(self) -> list[str]:
        with closing(self.connect()) as db:
            return [row[0] for row in db.execute("SELECT purchase_id FROM finalizations WHERE status NOT IN ('confirmed', 'contract_rejected', 'ineligible') ORDER BY CAST(purchase_id AS INTEGER)")]

    def claim(self, purchase_id: str, owner: str, lease_seconds: int) -> sqlite3.Row | None:
        now = self.now()
        with closing(self.connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM finalizations WHERE purchase_id = ?", (purchase_id,)).fetchone()
            if not row or (row["lease_until"] and row["lease_until"] > now and row["lease_owner"] != owner):
                db.execute("ROLLBACK")
                return None
            db.execute("UPDATE finalizations SET lease_owner = ?, lease_until = ? WHERE purchase_id = ?", (owner, now + lease_seconds, purchase_id))
            db.execute("COMMIT")
        return self.get(purchase_id)

    def update(self, purchase_id: str, status_value: str, **values: Any) -> None:
        allowed = {"observed_state", "tx_hash", "signed_tx", "broadcast_count", "last_broadcast_at", "last_error", "lease_owner", "lease_until"}
        if not set(values) <= allowed:
            raise ValueError("unsupported finalization column")
        values.update(status=status_value, updated_at=self.now())
        assignment = ", ".join(f"{key} = ?" for key in values)
        with closing(self.connect()) as db:
            db.execute(f"UPDATE finalizations SET {assignment} WHERE purchase_id = ?", (*values.values(), purchase_id))
            db.execute("INSERT INTO finalization_events (purchase_id, event, detail, created_at) VALUES (?, ?, ?, ?)", (purchase_id, status_value, values.get("last_error") or values.get("observed_state"), self.now()))
        LOG.info(json.dumps({"event": status_value, "purchase_id": purchase_id, "observed_state": values.get("observed_state"), "error": values.get("last_error")}))

    def release_purchase(self, purchase_id: str, owner: str) -> None:
        with closing(self.connect()) as db:
            db.execute("UPDATE finalizations SET lease_owner = NULL, lease_until = NULL WHERE purchase_id = ? AND lease_owner = ?", (purchase_id, owner))

    def claim_lock(self, name: str, owner: str, lease_seconds: int) -> bool:
        now = self.now()
        with closing(self.connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT owner, lease_until FROM worker_locks WHERE name = ?", (name,)).fetchone()
            if row and row["lease_until"] > now and row["owner"] != owner:
                db.execute("ROLLBACK")
                return False
            db.execute("INSERT INTO worker_locks (name, owner, lease_until) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, lease_until = excluded.lease_until", (name, owner, now + lease_seconds))
            db.execute("COMMIT")
            return True

    def release_lock(self, name: str, owner: str) -> None:
        with closing(self.connect()) as db:
            db.execute("DELETE FROM worker_locks WHERE name = ? AND owner = ?", (name, owner))

    def has_other_inflight(self, purchase_id: str) -> bool:
        with closing(self.connect()) as db:
            row = db.execute("SELECT 1 FROM finalizations WHERE purchase_id != ? AND status IN ('prepared', 'submitted', 'unknown') LIMIT 1", (purchase_id,)).fetchone()
            return row is not None

    def get(self, purchase_id: str) -> sqlite3.Row | None:
        with closing(self.connect()) as db:
            return db.execute("SELECT * FROM finalizations WHERE purchase_id = ?", (purchase_id,)).fetchone()

    def summary(self) -> dict[str, int]:
        with closing(self.connect()) as db:
            return {row[0]: row[1] for row in db.execute("SELECT status, COUNT(*) FROM finalizations GROUP BY status")}


class Finalizer:
    def __init__(self, config: Config, rpc: NearRpc, store: Store, signer: Any | None = None, now: Callable[[], float] = time.time):
        self.config, self.rpc, self.store, self.now = config, rpc, store, now
        self.owner = f"worker-{secrets.token_hex(6)}"
        self.signer = signer
        self.last_error: str | None = None
        self.last_poll: float | None = None
        self.inspections: list[dict[str, Any]] = []

    def _validate_startup(self) -> None:
        if not self.config.enabled:
            return
        if self.config.contract_id != V5_CONTRACT_ID:
            raise ConfigurationError(f"finalizer receiver must be the canonical V5 contract {V5_CONTRACT_ID}")
        config = self.rpc.view(self.config.contract_id, "get_config")
        if (
            config.get("version") != "V5"
            or config.get("payment_asset") != "native-usdc-nep141"
            or not config.get("testnet_only")
            or config.get("token_contract_id") != V5_TOKEN_ID
            or int(config.get("token_decimals", -1)) != V5_TOKEN_DECIMALS
        ):
            raise ConfigurationError("finalizer requires the verified Testnet V5 native-USDC contract interface")
        if self.config.dry_run:
            return
        if self.signer is None:
            if self.config.credentials_file is None:
                raise ConfigurationError("enabled finalizer requires HARVESTPOOL_FINALIZER_CREDENTIALS_FILE")
            self.signer = NearSigner(Credentials.load(self.config.credentials_file))
        if isinstance(self.signer, NearSigner):
            self.signer.validate(self.rpc, self.config.contract_id)

    def run_once(self) -> dict[str, Any]:
        self.last_poll = self.now()
        if not self.config.enabled:
            return self.health()
        try:
            self._validate_startup()
            chain_now = self.rpc.chain_time_ns()
            count = int(self.rpc.view(self.config.contract_id, "get_purchase_count"))
            target_ids = self.config.purchase_ids or tuple(str(number) for number in range(count))
            _validate_purchase_ids(target_ids)
            if any(int(purchase_id) >= count for purchase_id in target_ids):
                raise ConfigurationError(f"purchase allowlist contains an ID outside current purchase count {count}")
            self.inspections = []
            for purchase_id in target_ids:
                purchase = self.rpc.view(self.config.contract_id, "get_purchase", {"purchase_id": purchase_id})
                eligible = self._eligible(purchase, chain_now)
                expected = None
                if eligible:
                    expected = "Funded" if purchase["state"] == "Open" and int(purchase["total_quantity"]) >= int(purchase["min_quantity"]) else "Failed"
                self.inspections.append({
                    "purchase_id": purchase_id,
                    "state": purchase.get("state") if purchase else None,
                    "join_deadline_ns": purchase.get("join_deadline_ns") if purchase else None,
                    "chain_time_ns": chain_now,
                    "eligible": eligible,
                    "expected_state": expected,
                    "total_quantity": purchase.get("total_quantity") if purchase else None,
                    "total_funded_amount": purchase.get("total_funded_amount") if purchase else None,
                    "commitment_count": len(purchase.get("commitments", [])) if purchase else None,
                })
                if eligible and not self.config.dry_run and not self.config.reconcile_only:
                    self.store.discover(self.config.contract_id, purchase_id, expected)
            if self.config.dry_run:
                self.last_error = None
                return self.health()
            candidate_ids = list(target_ids) if self.config.reconcile_only else self.store.candidates()
            for purchase_id in candidate_ids:
                if self.config.purchase_ids is not None and purchase_id not in self.config.purchase_ids:
                    continue
                if self.config.reconcile_only:
                    existing = self.store.get(purchase_id)
                    if existing is None or not existing["tx_hash"] or not existing["signed_tx"]:
                        raise ConfigurationError(
                            f"reconcile-only requires a durable signed transaction for purchase {purchase_id}"
                        )
                row = self.store.claim(purchase_id, self.owner, self.config.lease_seconds)
                if not row:
                    continue
                if not self.store.claim_lock("signer", self.owner, self.config.lease_seconds):
                    self.store.release_purchase(purchase_id, self.owner)
                    continue
                try:
                    row = self.store.get(purchase_id)
                    if row["tx_hash"] is None and self.store.has_other_inflight(purchase_id):
                        self.store.release_purchase(purchase_id, self.owner)
                        continue
                    self._process(row, chain_now)
                finally:
                    self.store.release_lock("signer", self.owner)
            self.last_error = None
        except (RpcError, ConfigurationError, ValueError, KeyError) as error:
            self.last_error = str(error)
            LOG.error(json.dumps({"event": "poll_failed", "error": self.last_error}))
        return self.health()

    @staticmethod
    def _eligible(purchase: dict[str, Any] | None, chain_now: int) -> bool:
        return bool(purchase and purchase.get("state") in ELIGIBLE_STATES and chain_now >= int(purchase["join_deadline_ns"]))

    def _process(self, row: sqlite3.Row, chain_now: int) -> None:
        purchase_id = row["purchase_id"]
        try:
            purchase = self.rpc.view(self.config.contract_id, "get_purchase", {"purchase_id": purchase_id})
            state = purchase.get("state") if purchase else None
            if state in FINAL_STATES:
                self.store.update(purchase_id, "confirmed", observed_state=state, lease_owner=None, lease_until=None, last_error=None)
                return
            if not self._eligible(purchase, chain_now):
                self.store.update(purchase_id, "ineligible", observed_state=state, lease_owner=None, lease_until=None, last_error="authoritative state is no longer eligible")
                return
            if row["tx_hash"]:
                self._reconcile(row)
                return
            tx_hash, signed_tx = self.signer.prepare(self.rpc, self.config.contract_id, purchase_id)
            # Persist the exact signed transaction before any network submission.
            self.store.update(purchase_id, "prepared", tx_hash=tx_hash, signed_tx=signed_tx, broadcast_count=0, last_error=None)
            self._broadcast(purchase_id, signed_tx, 0)
            self._reconcile(self.store.get(purchase_id))
        except ConfigurationError:
            raise
        except RpcError as error:
            self.store.update(purchase_id, "unknown", last_error=str(error), lease_owner=None, lease_until=None)

    def _broadcast(self, purchase_id: str, signed_tx: str, previous_count: int) -> None:
        count = previous_count + 1
        try:
            self.rpc.broadcast(signed_tx)
            self.store.update(purchase_id, "submitted", broadcast_count=count, last_broadcast_at=self.now(), last_error=None)
        except RpcError as error:
            self.store.update(purchase_id, "unknown", broadcast_count=count, last_broadcast_at=self.now(), last_error=str(error))

    def _reconcile(self, row: sqlite3.Row) -> None:
        purchase_id = row["purchase_id"]
        purchase = self.rpc.view(self.config.contract_id, "get_purchase", {"purchase_id": purchase_id})
        if purchase and purchase.get("state") in FINAL_STATES:
            self.store.update(purchase_id, "confirmed", observed_state=purchase["state"], lease_owner=None, lease_until=None, last_error=None)
            return
        outcome = self.rpc.transaction(row["tx_hash"], self.signer.credentials.account_id)
        if outcome is not None:
            status_value = outcome.get("status", {})
            if "Failure" in status_value:
                self.store.update(purchase_id, "contract_rejected", last_error=json.dumps(status_value["Failure"], sort_keys=True), lease_owner=None, lease_until=None)
                return
            if "SuccessValue" in status_value:
                # A final RPC may lag the transaction result briefly; retain the lock and reread.
                self.store.update(purchase_id, "submitted", last_error="transaction succeeded; awaiting authoritative final state", lease_owner=None, lease_until=None)
                return
        age = self.now() - (row["last_broadcast_at"] or row["updated_at"])
        if row["signed_tx"] and row["broadcast_count"] < self.config.max_same_tx_broadcasts and age >= self.config.rebroadcast_seconds:
            self._broadcast(purchase_id, row["signed_tx"], row["broadcast_count"])
        else:
            self.store.update(purchase_id, "unknown", last_error="transaction outcome not yet known; no new transaction will be signed", lease_owner=None, lease_until=None)

    def health(self) -> dict[str, Any]:
        heartbeat_age = None if self.last_poll is None else max(0.0, self.now() - self.last_poll)
        stale = bool(
            self.config.enabled
            and not self.config.dry_run
            and (heartbeat_age is None or heartbeat_age > self.config.health_stale_seconds)
        )
        return {
            "enabled": self.config.enabled,
            "dry_run": self.config.dry_run,
            "purchase_ids": list(self.config.purchase_ids) if self.config.purchase_ids is not None else None,
            "ok": self.last_error is None and not stale,
            "last_poll": self.last_poll,
            "heartbeat_age_seconds": heartbeat_age,
            "stale_after_seconds": self.config.health_stale_seconds,
            "stale": stale,
            "last_error": self.last_error,
            "inspections": self.inspections,
            "states": self.store.summary(),
        }


def serve_health(worker: Finalizer) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/healthz":
                self.send_error(404)
                return
            payload = json.dumps(worker.health(), sort_keys=True).encode()
            self.send_response(200 if worker.health()["ok"] else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    server = ThreadingHTTPServer((worker.config.health_host, worker.config.health_port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run_continuous(
    worker: Finalizer,
    stop_event: threading.Event,
    server_factory: Callable[[Finalizer], ThreadingHTTPServer] = serve_health,
) -> None:
    """Poll in the foreground until SIGINT/SIGTERM asks for a graceful stop."""
    server = server_factory(worker)
    try:
        while not stop_event.is_set():
            worker.run_once()
            stop_event.wait(worker.config.poll_seconds)
    finally:
        server.shutdown()
        server.server_close()


def main() -> int:
    parser = argparse.ArgumentParser(description="HarvestPool V5 automatic finalizer")
    parser.add_argument("--once", action="store_true", help="run one poll and exit")
    parser.add_argument("--purchase-id", action="append", help="restrict discovery and processing to this purchase ID")
    parser.add_argument("--dry-run", action="store_true", help="read eligibility without loading a key, signing, or broadcasting")
    parser.add_argument(
        "--reconcile-only",
        action="store_true",
        help="recover an allowlisted persisted transaction without signing a new transaction",
    )
    args = parser.parse_args()
    if args.dry_run and not args.once:
        parser.error("--dry-run requires --once")
    if args.reconcile_only and (not args.once or args.dry_run or not args.purchase_id):
        parser.error("--reconcile-only requires --once and --purchase-id, and cannot be combined with --dry-run")
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    config = Config.from_env()
    if args.purchase_id:
        purchase_ids = tuple(args.purchase_id)
        _validate_purchase_ids(purchase_ids)
        config = replace(config, purchase_ids=purchase_ids)
    if args.dry_run:
        config = replace(config, enabled=True, dry_run=True)
    if args.reconcile_only:
        config = replace(config, reconcile_only=True)
    store = Store(config.database)
    worker = Finalizer(
        config,
        NearRpc(config.rpc_url, timeout=config.rpc_timeout_seconds, api_key=config.rpc_api_key),
        store,
    )
    if args.once:
        print(json.dumps(worker.run_once(), sort_keys=True))
        return 0 if worker.last_error is None else 1
    stop_event = threading.Event()

    def request_stop(_signum: int, _frame: Any) -> None:
        stop_event.set()

    signal.signal(signal.SIGINT, request_stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, request_stop)
    try:
        run_continuous(worker, stop_event)
    except KeyboardInterrupt:
        stop_event.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
