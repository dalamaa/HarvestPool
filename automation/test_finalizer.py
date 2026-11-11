import base64
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
    V5_CONTRACT_ID,
    V5_TOKEN_ID,
    run_continuous,
)
from automation.verify_finalization import DEAL_4_SIGNER, verify


CONTRACT = V5_CONTRACT_ID


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
    def __init__(self, purchases=None, chain_time=20, config=None):
        self.purchases = purchases or []
        self.chain_time = chain_time
        self.broadcasts = []
        self.broadcast_error = None
        self.tx_outcome = None
        self.view_error = None
        self.purchase_views = []
        self.config = config or {
            "version": "V5",
            "payment_asset": "native-usdc-nep141",
            "testnet_only": True,
            "token_contract_id": V5_TOKEN_ID,
            "token_decimals": 6,
        }

    def view(self, _contract, method, args=None):
        if self.view_error:
            raise RpcError(self.view_error)
        if method == "get_config":
            return self.config
        if method == "get_purchase_count":
            return str(len(self.purchases))
        if method == "get_purchase":
            self.purchase_views.append(str(args["purchase_id"]))
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

    def test_dry_run_allowlist_reads_only_target_without_signing_or_persistence(self):
        purchases = [{**purchase(), "id": str(number)} for number in range(5)]
        rpc = FakeRpc(purchases)
        signer = FakeSigner()
        config = Config(
            enabled=True, dry_run=True, contract_id=CONTRACT, database=self.db_path,
            purchase_ids=("4",),
        )
        worker = Finalizer(config, rpc, Store(self.db_path, self.clock), signer=signer, now=self.clock)

        health = worker.run_once()

        self.assertTrue(health["ok"])
        self.assertTrue(health["dry_run"])
        self.assertEqual(rpc.purchase_views, ["4"])
        self.assertEqual(health["inspections"][0]["expected_state"], "Failed")
        self.assertEqual(signer.calls, 0)
        self.assertEqual(rpc.broadcasts, [])
        self.assertEqual(worker.store.candidates(), [])

    def test_allowlist_does_not_process_preexisting_row_for_another_purchase(self):
        store = Store(self.db_path, self.clock)
        store.discover(CONTRACT, "0", "Failed")
        rpc = FakeRpc([purchase(), {**purchase(), "id": "1"}])
        signer = FakeSigner()
        config = Config(
            enabled=True, contract_id=CONTRACT, database=self.db_path,
            purchase_ids=("1",),
        )
        worker = Finalizer(config, rpc, store, signer=signer, now=self.clock)

        worker.run_once()

        self.assertEqual(rpc.purchase_views[0], "1")
        self.assertNotIn("signed-0", rpc.broadcasts)
        self.assertEqual(store.get("0")["status"], "eligible")
        self.assertEqual(signer.calls, 1)

    def test_out_of_range_allowlist_fails_without_signing(self):
        rpc = FakeRpc([purchase()])
        signer = FakeSigner()
        worker = self.worker(rpc, signer=signer, purchase_ids=("4",))

        health = worker.run_once()

        self.assertFalse(health["ok"])
        self.assertIn("outside current purchase count", health["last_error"])
        self.assertEqual(signer.calls, 0)
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

    def test_failed_rpc_poll_recovers_and_clears_health_error(self):
        rpc = FakeRpc([purchase()])
        rpc.view_error = "temporarily unavailable"
        worker = self.worker(rpc, dry_run=True)
        self.assertFalse(worker.run_once()["ok"])
        rpc.view_error = None
        self.assertTrue(worker.run_once()["ok"])

    def test_stale_heartbeat_is_unhealthy_without_inferring_deal_failure(self):
        worker = self.worker(FakeRpc([purchase()]), health_stale_seconds=30)
        worker.last_poll = 50
        health = worker.health()
        self.assertFalse(health["ok"])
        self.assertTrue(health["stale"])
        self.assertEqual(health["heartbeat_age_seconds"], 50)
        self.assertEqual(worker.store.candidates(), [])

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

    def test_reconcile_only_recovers_persisted_hash_without_resigning(self):
        rpc = FakeRpc([purchase()])
        rpc.broadcast_error = "lost response"
        signer = FakeSigner()
        self.worker(rpc, signer=signer).run_once()
        rpc.broadcast_error = None
        rpc.purchases[0] = purchase(state="Failed")
        recovery = self.worker(rpc, signer=signer, purchase_ids=("0",), reconcile_only=True)

        health = recovery.run_once()

        self.assertTrue(health["ok"])
        self.assertEqual(recovery.store.get("0")["status"], "confirmed")
        self.assertEqual(signer.calls, 1)

    def test_reconcile_only_refuses_to_create_a_new_transaction(self):
        signer = FakeSigner()
        worker = self.worker(
            FakeRpc([purchase()]), signer=signer, purchase_ids=("0",), reconcile_only=True
        )

        health = worker.run_once()

        self.assertFalse(health["ok"])
        self.assertIn("durable signed transaction", health["last_error"])
        self.assertEqual(signer.calls, 0)

    def test_wrong_contract_or_token_configuration_fails_closed(self):
        signer = FakeSigner()
        wrong_contract = self.worker(FakeRpc([purchase()]), signer=signer, contract_id="other.testnet")
        self.assertFalse(wrong_contract.run_once()["ok"])
        wrong_token_config = {
            "version": "V5", "payment_asset": "native-usdc-nep141", "testnet_only": True,
            "token_contract_id": "wrong-token.testnet", "token_decimals": 6,
        }
        wrong_token = self.worker(FakeRpc([purchase()], config=wrong_token_config), signer=signer)
        self.assertFalse(wrong_token.run_once()["ok"])
        self.assertEqual(signer.calls, 0)

    def test_foreground_loop_stops_gracefully_and_closes_health_server(self):
        stop_event = threading.Event()

        class Worker:
            config = SimpleNamespace(poll_seconds=15)
            polls = 0

            def run_once(self):
                self.polls += 1
                stop_event.set()

        class Server:
            shutdown_called = False
            close_called = False

            def shutdown(self):
                self.shutdown_called = True

            def server_close(self):
                self.close_called = True

        worker = Worker()
        server = Server()
        run_continuous(worker, stop_event, server_factory=lambda _worker: server)
        self.assertEqual(worker.polls, 1)
        self.assertTrue(server.shutdown_called)
        self.assertTrue(server.close_called)


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

    def test_key_for_another_receiver_is_rejected(self):
        rpc = SimpleNamespace(access_key=lambda *_args: {"permission": {"FunctionCall": {"receiver_id": "other.testnet", "method_names": ["finalize_purchase"]}}})
        signer = NearSigner(Credentials("worker.testnet", "ed25519:" + "1" * 32, "ed25519:" + "1" * 32))
        with self.assertRaisesRegex(ConfigurationError, "this contract"):
            signer.validate(rpc, CONTRACT)

    def test_exact_receiver_and_method_restriction_is_accepted(self):
        access_key = {"permission": {"FunctionCall": {"receiver_id": CONTRACT, "method_names": ["finalize_purchase"], "allowance": "100000000000000000000000"}}}
        rpc = SimpleNamespace(access_key=lambda *_args: access_key)
        signer = NearSigner(Credentials("worker.testnet", "ed25519:" + "1" * 32, "ed25519:" + "1" * 32))
        self.assertIs(signer.validate(rpc, CONTRACT), access_key)

    def test_unlimited_or_missing_allowance_is_rejected(self):
        signer = NearSigner(Credentials("worker.testnet", "ed25519:" + "1" * 32, "ed25519:" + "1" * 32))
        for allowance in (None, "0"):
            with self.subTest(allowance=allowance):
                access_key = {"permission": {"FunctionCall": {
                    "receiver_id": CONTRACT,
                    "method_names": ["finalize_purchase"],
                    "allowance": allowance,
                }}}
                rpc = SimpleNamespace(access_key=lambda *_args, value=access_key: value)
                with self.assertRaisesRegex(ConfigurationError, "finite positive gas allowance"):
                    signer.validate(rpc, CONTRACT)


class HistoricalReceiptTests(unittest.TestCase):
    def test_read_only_verifier_checks_transaction_and_authoritative_state(self):
        action_args = base64.b64encode(json.dumps({"purchase_id": "4"}).encode()).decode()

        class Rpc:
            def transaction(self, _tx_hash, _signer):
                return {
                    "status": {"SuccessValue": ""},
                    "transaction": {
                        "signer_id": DEAL_4_SIGNER,
                        "receiver_id": CONTRACT,
                        "actions": [{"FunctionCall": {
                            "method_name": "finalize_purchase",
                            "args": action_args,
                            "deposit": "0",
                        }}],
                    },
                }

            def view(self, _contract, _method, _args):
                return {"state": "Failed"}

        result = verify(Rpc())
        self.assertEqual(result["authoritative_purchase_state"], "Failed")
        self.assertEqual(result["deposit"], "0")


if __name__ == "__main__":
    unittest.main()
