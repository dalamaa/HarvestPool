import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

from automation.finalizer import (
    Config,
    ConfigurationError,
    Credentials,
    Finalizer,
    NearSigner,
    RpcError,
    Store,
)


CONTRACT = "v5.testnet"


def purchase(state="Open", deadline=10, total=0, minimum=2):
    return {
        "id": "0", "state": state, "join_deadline_ns": str(deadline),
        "total_quantity": total, "min_quantity": minimum,
    }


class Clock:
    def __init__(self, value=100.0):
        self.value = value

    def __call__(self):
        return self.value


class FakeRpc:
    def __init__(self, purchases=None, chain_time=20):
        self.purchases = purchases or []
        self.chain_time = chain_time
        self.broadcasts = []
        self.broadcast_error = None
        self.tx_outcome = None
        self.view_error = None

    def view(self, _contract, method, args=None):
        if self.view_error:
            raise RpcError(self.view_error)
        if method == "get_config":
            return {"version": "V5", "payment_asset": "native-usdc-nep141", "testnet_only": True}
        if method == "get_purchase_count":
            return str(len(self.purchases))
        if method == "get_purchase":
            return self.purchases[int(args["purchase_id"])]
        raise AssertionError(method)

    def chain_time_ns(self):
        return self.chain_time

    def broadcast(self, signed):
        self.broadcasts.append(signed)
        if self.broadcast_error:
            raise RpcError(self.broadcast_error)
        return "hash"

    def transaction(self, _tx_hash, _signer):
        return self.tx_outcome


class FakeSigner:
    def __init__(self, hook=None):
        self.credentials = SimpleNamespace(account_id="finalizer.testnet")
        self.calls = 0
        self.hook = hook

    def prepare(self, _rpc, _contract, purchase_id):
        self.calls += 1
        if self.hook:
            self.hook()
        return f"tx-{purchase_id}", f"signed-{purchase_id}"


class FinalizerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.db_path = Path(self.temp.name) / "worker.sqlite3"

    def tearDown(self):
        self.temp.cleanup()

    def worker(self, rpc, *, enabled=True, signer=None, **changes):
        values = dict(enabled=enabled, contract_id=CONTRACT, database=self.db_path, rebroadcast_seconds=30)
        values.update(changes)
        config = Config(**values)
        return Finalizer(config, rpc, Store(self.db_path, self.clock), signer=signer or FakeSigner(), now=self.clock)

    def test_disabled_by_default_needs_no_credentials_or_rpc(self):
        rpc = FakeRpc([purchase()])
        worker = self.worker(rpc, enabled=False, signer=None)
        self.assertFalse(worker.run_once()["enabled"])
        self.assertEqual(rpc.broadcasts, [])

    def test_open_deal_before_deadline_is_ignored(self):
        rpc = FakeRpc([purchase(deadline=21)], chain_time=20)
        worker = self.worker(rpc)
        worker.run_once()
        self.assertEqual(worker.store.candidates(), [])
        self.assertEqual(rpc.broadcasts, [])

    def test_expired_zero_buyer_deal_is_submitted_as_expected_failed(self):
        rpc = FakeRpc([purchase(total=0)])
        worker = self.worker(rpc)
        worker.run_once()
        row = worker.store.get("0")
        self.assertEqual(row["expected_state"], "Failed")
        self.assertEqual(row["status"], "unknown")
        self.assertEqual(rpc.broadcasts, ["signed-0"])

    def test_expired_below_minimum_deal_expects_failed(self):
        rpc = FakeRpc([purchase(total=1, minimum=2)])
        worker = self.worker(rpc)
        worker.run_once()
        self.assertEqual(worker.store.get("0")["expected_state"], "Failed")

    def test_minimum_satisfied_deal_expects_funded(self):
        rpc = FakeRpc([purchase(total=2, minimum=2)])
        worker = self.worker(rpc)
        worker.run_once()
        self.assertEqual(worker.store.get("0")["expected_state"], "Funded")

    def test_awaiting_supplier_always_expects_failed(self):
        rpc = FakeRpc([purchase(state="AwaitingSupplier", total=5, minimum=2)])
        worker = self.worker(rpc)
        worker.run_once()
        self.assertEqual(worker.store.get("0")["expected_state"], "Failed")

    def test_already_funded_and_failed_rows_confirm_without_submission(self):
        for final_state in ("Funded", "Failed"):
            with self.subTest(final_state=final_state):
                path = Path(self.temp.name) / f"{final_state}.sqlite3"
                store = Store(path, self.clock)
                store.discover(CONTRACT, "0", final_state)
                rpc = FakeRpc([purchase(state=final_state)])
                worker = Finalizer(Config(enabled=True, contract_id=CONTRACT, database=path), rpc, store, FakeSigner(), self.clock)
                worker.run_once()
                self.assertEqual(store.get("0")["status"], "confirmed")
                self.assertEqual(rpc.broadcasts, [])

    def test_completed_state_is_never_discovered_or_submitted(self):
        rpc = FakeRpc([purchase(state="Completed")])
        worker = self.worker(rpc)
        worker.run_once()
        self.assertEqual(worker.store.candidates(), [])
        self.assertEqual(rpc.broadcasts, [])

    def test_failed_rpc_poll_is_reported_without_submission(self):
        rpc = FakeRpc([purchase()])
        rpc.view_error = "rate limited"
        worker = self.worker(rpc)
        health = worker.run_once()
        self.assertFalse(health["ok"])
        self.assertIn("rate limited", health["last_error"])
        self.assertEqual(rpc.broadcasts, [])

    def test_lost_broadcast_response_persists_hash_and_exact_transaction(self):
        rpc = FakeRpc([purchase()])
        rpc.broadcast_error = "connection reset"
        signer = FakeSigner()
        worker = self.worker(rpc, signer=signer)
        worker.run_once()
        row = worker.store.get("0")
        self.assertEqual((row["tx_hash"], row["signed_tx"], row["status"]), ("tx-0", "signed-0", "unknown"))
        self.assertEqual(signer.calls, 1)

    def test_duplicate_scheduler_execution_does_not_sign_again(self):
        rpc = FakeRpc([purchase()])
        signer = FakeSigner()
        worker = self.worker(rpc, signer=signer)
        worker.run_once()
        worker.run_once()
        self.assertEqual(signer.calls, 1)

    def test_two_workers_racing_share_one_lease(self):
        store_a = Store(self.db_path, self.clock)
        store_b = Store(self.db_path, self.clock)
        store_a.discover(CONTRACT, "0", "Failed")
        barrier = threading.Barrier(3)
        results = []

        def claim(store, owner):
            barrier.wait()
            results.append(store.claim("0", owner, 90))

        threads = [threading.Thread(target=claim, args=(store_a, "a")), threading.Thread(target=claim, args=(store_b, "b"))]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join()
        self.assertEqual(sum(row is not None for row in results), 1)

    def test_different_deals_share_one_signer_and_only_one_can_be_inflight(self):
        rpc = FakeRpc([purchase(), {**purchase(), "id": "1"}])
        signer = FakeSigner()
        worker = self.worker(rpc, signer=signer)
        worker.run_once()
        self.assertEqual(signer.calls, 1)
        rows = [worker.store.get("0"), worker.store.get("1")]
        self.assertEqual(sum(row["tx_hash"] is not None for row in rows), 1)
        self.assertEqual(sum(row["status"] == "eligible" for row in rows), 1)

    def test_crash_restart_reconciles_same_hash_without_resigning(self):
        rpc = FakeRpc([purchase()])
        rpc.broadcast_error = "lost response"
        signer = FakeSigner()
        first = self.worker(rpc, signer=signer)
        first.run_once()
        rpc.broadcast_error = None
        rpc.purchases[0] = purchase(state="Failed")
        second = self.worker(rpc, signer=signer)
        second.run_once()
        self.assertEqual(signer.calls, 1)
        self.assertEqual(second.store.get("0")["status"], "confirmed")

    def test_state_change_between_check_and_submission_confirms_authoritative_result(self):
        rpc = FakeRpc([purchase()])
        signer = FakeSigner(lambda: rpc.purchases.__setitem__(0, purchase(state="Failed")))
        worker = self.worker(rpc, signer=signer)
        worker.run_once()
        self.assertEqual(worker.store.get("0")["status"], "confirmed")

    def test_missing_credentials_fails_closed_when_enabled(self):
        rpc = FakeRpc([purchase()])
        worker = Finalizer(Config(enabled=True, contract_id=CONTRACT, database=self.db_path), rpc, Store(self.db_path, self.clock), signer=None, now=self.clock)
        health = worker.run_once()
        self.assertFalse(health["ok"])
        self.assertIn("CREDENTIALS_FILE", health["last_error"])
        self.assertEqual(rpc.broadcasts, [])

    def test_confirmed_contract_rejection_is_not_blindly_retried(self):
        rpc = FakeRpc([purchase()])
        rpc.tx_outcome = {"status": {"Failure": {"ActionError": "deadline race"}}}
        signer = FakeSigner()
        worker = self.worker(rpc, signer=signer)
        worker.run_once()
        worker.run_once()
        self.assertEqual(worker.store.get("0")["status"], "contract_rejected")
        self.assertEqual(signer.calls, 1)
        self.assertEqual(len(rpc.broadcasts), 1)

    def test_delayed_authoritative_state_confirms_on_later_poll(self):
        rpc = FakeRpc([purchase()])
        rpc.tx_outcome = {"status": {"SuccessValue": ""}}
        worker = self.worker(rpc)
        worker.run_once()
        self.assertEqual(worker.store.get("0")["status"], "submitted")
        rpc.purchases[0] = purchase(state="Funded")
        worker.run_once()
        self.assertEqual(worker.store.get("0")["status"], "confirmed")

    def test_unknown_transaction_rebroadcasts_only_identical_bytes(self):
        rpc = FakeRpc([purchase()])
        signer = FakeSigner()
        worker = self.worker(rpc, signer=signer, rebroadcast_seconds=30, max_same_tx_broadcasts=3)
        worker.run_once()
        self.clock.value += 31
        worker.run_once()
        self.assertEqual(rpc.broadcasts, ["signed-0", "signed-0"])
        self.assertEqual(signer.calls, 1)


class SignerRestrictionTests(unittest.TestCase):
    def test_full_access_key_is_rejected(self):
        rpc = SimpleNamespace(access_key=lambda *_args: {"permission": "FullAccess"})
        signer = NearSigner(Credentials("worker.testnet", "ed25519:" + "1" * 32, "ed25519:" + "1" * 32))
        with self.assertRaisesRegex(ConfigurationError, "restricted function-call"):
            signer.prepare(rpc, CONTRACT, "0")

    def test_key_with_extra_method_is_rejected(self):
        rpc = SimpleNamespace(access_key=lambda *_args: {"permission": {"FunctionCall": {"receiver_id": CONTRACT, "method_names": ["finalize_purchase", "release_payment"]}}})
        signer = NearSigner(Credentials("worker.testnet", "ed25519:" + "1" * 32, "ed25519:" + "1" * 32))
        with self.assertRaisesRegex(ConfigurationError, "finalize_purchase only"):
            signer.prepare(rpc, CONTRACT, "0")


if __name__ == "__main__":
    unittest.main()
