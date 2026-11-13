import base64
import io
import json
import tempfile
import unittest
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError
from unittest.mock import patch

from web import app as web_app


class CommunityFundActivityTests(unittest.TestCase):
    def setUp(self):
        self._database = web_app.DATABASE
        self._tempdir = tempfile.TemporaryDirectory()
        web_app.DATABASE = web_app.Path(self._tempdir.name) / "metadata.sqlite3"
        web_app._community_activity_cache.clear()

    def tearDown(self):
        web_app.DATABASE = self._database
        self._tempdir.cleanup()

    def test_activity_counts_only_successful_direct_transfers_and_maps_votes(self):
        transaction_page = {
            "data": [
                {
                    "actions": [{"action": "TRANSFER", "method": None}],
                    "actions_agg": {"deposit": "250000000000000000000000"},
                    "block_timestamp": "1794430000000000000",
                    "outcomes": {"status": True},
                    "receiver_account_id": "community.sputnikv2.testnet",
                    "signer_account_id": "alice.testnet",
                    "transaction_hash": "contribution-hash",
                },
                {
                    "actions": [{"action": "FUNCTION_CALL", "method": "add_proposal"}],
                    "actions_agg": {"deposit": "100000000000000000000000"},
                    "block_timestamp": "1794431000000000000",
                    "outcomes": {"status": True},
                    "receiver_account_id": "community.sputnikv2.testnet",
                    "signer_account_id": "alice.testnet",
                    "transaction_hash": "proposal-hash",
                },
                {
                    "actions": [{"action": "FUNCTION_CALL", "method": "act_proposal"}],
                    "actions_agg": {"deposit": "0"},
                    "block_timestamp": "1794432000000000000",
                    "outcomes": {"status": True},
                    "receiver_account_id": "community.sputnikv2.testnet",
                    "signer_account_id": "bob.testnet",
                    "transaction_hash": "vote-hash",
                },
            ],
            "meta": {},
        }
        vote_detail = {
            "data": {
                "actions": [
                    {
                        "method": "act_proposal",
                        "args": {"args_json": {"id": 7, "action": "VoteApprove"}},
                    }
                ],
                "signer_account_id": "bob.testnet",
                "block_timestamp": "1794432000000000000",
            }
        }
        vote_receipts = {
            "data": {
                "predecessor_account_id": "bob.testnet",
                "receiver_account_id": "community.sputnikv2.testnet",
                "actions": [],
                "outcome": {"status": True},
                "receipts": [
                    {
                        "predecessor_account_id": "community.sputnikv2.testnet",
                        "receiver_account_id": "recipient.testnet",
                        "receipt_id": "payment-receipt",
                        "actions": [
                            {
                                "action": "TRANSFER",
                                "args": {"deposit": "100000000000000000000000"},
                            }
                        ],
                        "outcome": {"status": True},
                        "receipts": [
                            {
                                "predecessor_account_id": "community.sputnikv2.testnet",
                                "receiver_account_id": "recipient.testnet",
                                "receipt_id": "nested-bond-like-receipt",
                                "actions": [
                                    {
                                        "action": "TRANSFER",
                                        "args": {
                                            "deposit": "100000000000000000000000"
                                        },
                                    }
                                ],
                                "outcome": {"status": True},
                                "receipts": [],
                            }
                        ],
                    }
                ],
            }
        }

        def fake_read(path, params=None):
            if path.endswith("/txns"):
                return transaction_page
            if path.endswith("/vote-hash"):
                return vote_detail
            if path.endswith("/vote-hash/receipts"):
                return vote_receipts
            raise AssertionError(path)

        with patch.object(web_app, "_nearblocks_json", side_effect=fake_read):
            result = web_app._community_activity("community.sputnikv2.testnet")

        self.assertTrue(result["complete"])
        self.assertEqual(len(result["contributions"]), 1)
        self.assertEqual(result["contributions"][0]["contributor"], "alice.testnet")
        self.assertEqual(
            result["contributions"][0]["amount"], "250000000000000000000000"
        )
        self.assertEqual(result["proposalTransactions"]["7"][0]["signer"], "bob.testnet")
        self.assertEqual(
            result["proposalTransactions"]["7"][0]["transactionHash"], "vote-hash"
        )
        self.assertEqual(
            result["proposalTransactions"]["7"][0]["transfers"][0]["receiptId"],
            "payment-receipt",
        )
        self.assertEqual(
            len(result["proposalTransactions"]["7"][0]["transfers"]), 1
        )

    def test_unconfigured_activity_endpoint_fails_closed(self):
        with patch.object(web_app, "COMMUNITY_DAO_ID", ""):
            response = web_app.app.test_client().get("/api/community-fund/activity")
        self.assertEqual(response.status_code, 404)
        self.assertIn("not configured", response.get_json()["error"])

    def test_nearblocks_rate_limit_retries_are_bounded(self):
        rate_limit = HTTPError(
            "https://api-testnet.nearblocks.io/example", 429, "rate limited",
            {"Retry-After": "0"}, None,
        )

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return io.BytesIO(b'{"data": []}').read()

        with (
            patch.object(web_app, "urlopen", side_effect=[rate_limit, rate_limit, Response()]) as read,
            patch.object(web_app.time, "sleep") as sleep,
        ):
            result = web_app._nearblocks_json("/example")

        self.assertEqual(result, {"data": []})
        self.assertEqual(read.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_activity_cache_reuses_fresh_data_and_preserves_last_confirmed_on_failure(self):
        payload = {"complete": True, "contributions": [], "verifiedAt": "2026-11-12T00:00:00+00:00", "stale": False}
        with patch.object(web_app, "_community_activity", return_value=payload) as read:
            first = web_app._cached_community_activity("community.sputnikv2.testnet")
            second = web_app._cached_community_activity("community.sputnikv2.testnet")
        self.assertEqual(read.call_count, 1)
        self.assertFalse(first["stale"])
        self.assertEqual(second["verifiedAt"], payload["verifiedAt"])

        web_app._community_activity_cache[("community.sputnikv2.testnet", "")] = {
            "cached_at": time.monotonic(),
            "payload": payload,
        }
        with patch.object(web_app, "_community_activity", side_effect=URLError("rate limited")):
            stale = web_app._cached_community_activity("community.sputnikv2.testnet", force=True)
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["verifiedAt"], payload["verifiedAt"])

        confirmed = {
            **payload,
            "contributions": [{"transactionHash": "in"}],
            "proposalTransactions": {"1": [{"transfers": [{"receiptId": "paid"}]}]},
        }
        web_app._community_activity_cache[("community.sputnikv2.testnet", "")] = {
            "cached_at": time.monotonic(),
            "payload": confirmed,
        }
        lower_coverage = {**payload, "contributions": [{"transactionHash": "in"}], "proposalTransactions": {}}
        with patch.object(web_app, "_community_activity", return_value=lower_coverage):
            preserved = web_app._cached_community_activity("community.sputnikv2.testnet", force=True)
        self.assertTrue(preserved["stale"])
        self.assertEqual(preserved["proposalTransactions"]["1"][0]["transfers"][0]["receiptId"], "paid")

    def test_community_page_exposes_separate_dao_configuration(self):
        goal = {
            "configured": True,
            "title": "School library books",
            "purpose": "Buy books for the shared school library.",
            "recipient": "school.testnet",
            "targetYocto": "1500000000000000000000000",
            "configurationError": "",
        }
        with (
            patch.object(web_app, "COMMUNITY_DAO_ID", "community.sputnikv2.testnet"),
            patch.object(web_app, "COMMUNITY_GOAL", goal),
        ):
            response = web_app.app.test_client().get("/community-fund")
        page = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn("community.sputnikv2.testnet", page)
        self.assertIn("School library books", page)
        self.assertIn("Community Funds", page)
        self.assertIn("Separate from Group Deal funds", page)

    def test_community_garden_page_uses_its_own_dao_target_and_activity_endpoint(self):
        response = web_app.app.test_client().get("/community-funds/community-garden")
        page = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn("harvestpool-community-garden.sputnikv2.testnet", page)
        self.assertIn('"targetUnits": "100000000"', page)
        self.assertIn('"communityActivityUrl": "/api/community-funds/community-garden/activity"', page)
        self.assertIn("Community Garden", page)
        self.assertNotIn("community-garden-deploy", page)

    def test_verified_fund_activity_selects_evidence_by_dao(self):
        payload = {"complete": True, "contributions": [], "proposalTransactions": {}}
        with (
            patch.object(web_app, "_discover_contribution_candidates", return_value=([], True)),
            patch.object(web_app, "_cached_community_activity", return_value=payload) as read,
            patch.object(web_app, "_finalized_ft_balance", return_value="0"),
        ):
            response = web_app.app.test_client().get(
                "/api/community-funds/community-garden/activity?refresh=1"
            )
        self.assertEqual(response.status_code, 200)
        args, kwargs = read.call_args
        self.assertEqual(args[0], "harvestpool-community-garden.sputnikv2.testnet")
        self.assertEqual(args[1], web_app.CANONICAL_USDC_TOKEN_ID)
        self.assertEqual(kwargs["evidence"], web_app.COMMUNITY_GARDEN_EVIDENCE)
        self.assertEqual(kwargs["goal"]["targetUnits"], "100000000")

    def test_garden_uses_strict_finalized_rpc_evidence_when_nearblocks_is_rate_limited(self):
        evidence = web_app.COMMUNITY_GARDEN_EVIDENCE
        token_id = web_app.CANONICAL_USDC_TOKEN_ID
        dao_id = web_app.COMMUNITY_GARDEN_DAO_ID
        args = base64.b64encode(json.dumps({
            "receiver_id": dao_id,
            "amount": evidence["contributionAmount"],
            "memo": "Contribution toward Community Garden",
        }).encode()).decode()
        transaction = {
            "final_execution_status": "FINAL",
            "status": {"SuccessValue": ""},
            "transaction": {
                "hash": evidence["contributionHash"],
                "signer_id": evidence["contributor"],
                "receiver_id": token_id,
                "actions": [{"FunctionCall": {
                    "method_name": "ft_transfer", "args": args, "deposit": "1",
                }}],
            },
            "transaction_outcome": {"block_hash": "garden-block"},
            "receipts_outcome": [{
                "id": "garden-receipt",
                "outcome": {
                    "executor_id": token_id,
                    "status": {"SuccessValue": ""},
                    "logs": ["EVENT_JSON:" + json.dumps({
                        "standard": "nep141", "event": "ft_transfer", "data": [{
                            "old_owner_id": evidence["contributor"],
                            "new_owner_id": dao_id,
                            "amount": evidence["contributionAmount"],
                        }],
                    })],
                },
            }],
        }

        def rpc(method, params):
            if method == "tx":
                return transaction
            if method == "block":
                return {"header": {"timestamp_nanosec": "1794566800000000000"}}
            if method == "query":
                return {"result": list(json.dumps("100000").encode())}
            raise AssertionError((method, params))

        rate_limit = HTTPError("nearblocks", 429, "rate limited", {}, None)
        with (
            patch.object(web_app, "_community_rpc", side_effect=rpc),
            patch.object(web_app, "_community_activity", side_effect=rate_limit),
        ):
            result = web_app._cached_community_activity(
                dao_id, token_id, goal=web_app.COMMUNITY_GARDEN_GOAL, evidence=evidence
            )

        self.assertFalse(result["complete"])
        self.assertTrue(result["boundedEvidence"])
        self.assertEqual(result["treasuryBalance"], "100000")
        self.assertEqual(result["contributions"][0]["transactionHash"], evidence["contributionHash"])

    def test_garden_cold_activity_does_not_call_failed_providers(self):
        with (
            patch.object(web_app, "_discover_contribution_candidates") as discovery,
            patch.object(web_app, "_cached_community_activity") as activity,
            patch.object(web_app, "_finalized_ft_balance") as balance,
        ):
            response = web_app.app.test_client().get(
                "/api/community-funds/community-garden/activity"
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["verifiedContributionSubtotal"], "0")
        discovery.assert_not_called()
        activity.assert_not_called()
        balance.assert_not_called()

    def test_cold_activity_serves_partial_then_complete_persisted_history(self):
        record = {
            "transactionHash": "A" * 44,
            "receiptId": "B" * 44,
            "contributor": "alice.testnet",
            "amount": "100000",
            "timestamp": "1794566734681505711",
            "tokenId": web_app.CANONICAL_USDC_TOKEN_ID,
        }
        web_app._store_verified_contribution(
            "community-garden", web_app.COMMUNITY_GARDEN_DAO_ID,
            web_app.CANONICAL_USDC_TOKEN_ID, record,
        )
        web_app._store_treasury_snapshot(
            "community-garden", web_app.COMMUNITY_GARDEN_DAO_ID,
            web_app.CANONICAL_USDC_TOKEN_ID, "100000",
        )
        client = web_app.app.test_client()

        partial = client.get("/api/community-funds/community-garden/activity").get_json()
        self.assertFalse(partial["contributionHistoryComplete"])
        self.assertEqual(partial["verifiedContributionSubtotal"], "100000")
        self.assertIsNone(partial["lifetimeRaised"])
        self.assertEqual(partial["treasuryBalance"], "100000")

        checkpoint = web_app._store_history_snapshot("community-garden", "100000")
        complete = client.get("/api/community-funds/community-garden/activity").get_json()
        self.assertTrue(complete["contributionHistoryComplete"])
        self.assertEqual(complete["lifetimeRaised"], "100000")
        self.assertEqual(complete["historyVerifiedAt"], checkpoint["verifiedAt"])

    def test_garden_activity_recovers_after_a_total_upstream_failure(self):
        bounded = {
            "complete": False, "boundedEvidence": True,
            "contributions": [{"transactionHash": "known", "amount": "100000"}],
            "proposalTransactions": {}, "stale": False,
        }
        indexed = {
            "complete": True,
            "contributions": [
                {"transactionHash": "known", "amount": "100000"},
                {"transactionHash": "new", "amount": "10000"},
            ],
            "proposalTransactions": {}, "stale": False,
        }
        with (
            patch.object(web_app, "_known_community_activity", side_effect=[URLError("rpc unavailable"), bounded]),
            patch.object(web_app, "_community_activity", return_value=indexed) as indexer,
        ):
            with self.assertRaises(URLError):
                web_app._cached_community_activity(
                    "garden.testnet", "usdc.testnet", goal={"currency": "USDC"}, evidence={"known": True}
                )
            recovered = web_app._cached_community_activity(
                "garden.testnet", "usdc.testnet", goal={"currency": "USDC"}, evidence={"known": True}
            )
        self.assertTrue(recovered["complete"])
        self.assertEqual(indexer.call_count, 1)
        self.assertEqual({item["transactionHash"] for item in recovered["contributions"]}, {"known", "new"})

    def test_directory_maps_two_verified_funds_to_independent_daos(self):
        payload = {"complete": True, "contributions": [], "proposalTransactions": {}}
        seen = []

        def activity(fund):
            seen.append(fund["daoId"])
            return payload

        with patch.object(web_app, "_persisted_community_activity", side_effect=activity):
            directory = web_app.app.test_client().get("/api/community-funds").get_json()["funds"]
        verified = {item["slug"]: item for item in directory if item["isVerifiedFund"]}
        self.assertEqual(verified["community-garden"]["targetAmount"], "100.00")
        self.assertEqual(
            verified["community-garden"]["detailUrl"],
            "/community-funds/community-garden",
        )
        self.assertIn("harvestpool-community-garden.sputnikv2.testnet", seen)
        if "shared-community-equipment" in verified:
            self.assertIn(web_app.COMMUNITY_DAO_ID, seen)

    def test_directory_shell_never_starts_blocking_activity_reads(self):
        with (
            patch.object(web_app, "_peek_community_activity_cache", return_value=None),
            patch.object(web_app, "_cached_community_activity") as blocking_read,
        ):
            directory = web_app.app.test_client().get("/api/community-funds").get_json()["funds"]
        blocking_read.assert_not_called()
        garden = next(item for item in directory if item.get("slug") == "community-garden")
        self.assertEqual(garden["raisedAmount"], "0.00")
        self.assertEqual(garden["activityUrl"], "/api/community-funds/community-garden/activity")
        self.assertEqual(garden["decimals"], 6)
        self.assertEqual(garden["targetUnits"], "100000000")
        self.assertEqual(garden["raisedUnits"], "0")
        self.assertEqual(garden["status"], "Open for contributions")
        self.assertEqual(garden["verificationState"], "partial")

    def test_directory_does_not_treat_nonpayment_proposals_as_spending(self):
        fund = web_app._configured_community_funds()["community-garden"]
        activity = {
            "complete": True,
            "contributions": [],
            "proposalTransactions": {"0": [{"action": "VoteApprove", "transfers": []}]},
        }
        with patch.object(web_app, "_durable_community_activity", return_value=activity):
            item = web_app._verified_fund_directory_item(fund)
        self.assertEqual(item["status"], "Open for contributions")
        self.assertEqual(item["raisedAmount"], "0.00")

    def test_directory_keeps_goal_reached_after_verified_payments(self):
        fund = web_app._configured_community_funds()["community-garden"]
        activity = {
            "complete": True,
            "contributions": [{"amount": "100000000", "contributor": "alice.testnet"}],
            "proposalTransactions": {"1": [{"transfers": [{"amount": "80000"}]}]},
        }
        with patch.object(web_app, "_durable_community_activity", return_value=activity):
            item = web_app._verified_fund_directory_item(fund)
        self.assertEqual(item["status"], "Goal reached")
        self.assertEqual(item["raisedAmount"], "100.00")

    def test_goal_configuration_is_all_or_nothing_and_uses_exact_yocto(self):
        complete = {
            "HARVESTPOOL_COMMUNITY_GOAL_TITLE": "School library books",
            "HARVESTPOOL_COMMUNITY_GOAL_PURPOSE": "Buy books for the shared library.",
            "HARVESTPOOL_COMMUNITY_GOAL_RECIPIENT": "school.testnet",
            "HARVESTPOOL_COMMUNITY_GOAL_TARGET_NEAR": "1.500001",
        }
        with patch.dict("os.environ", complete, clear=False):
            goal = web_app._community_goal_config()
        self.assertTrue(goal["configured"])
        self.assertEqual(goal["targetYocto"], "1500001000000000000000000")

        incomplete = {**complete, "HARVESTPOOL_COMMUNITY_GOAL_RECIPIENT": ""}
        with patch.dict("os.environ", incomplete, clear=False):
            goal = web_app._community_goal_config()
        self.assertFalse(goal["configured"])
        self.assertIn("configured together", goal["configurationError"])

    def test_usdc_goal_configuration_uses_exact_six_decimal_units(self):
        complete = {
            "HARVESTPOOL_COMMUNITY_GOAL_TITLE": "Shared equipment",
            "HARVESTPOOL_COMMUNITY_GOAL_PURPOSE": "Buy a shared equipment kit.",
            "HARVESTPOOL_COMMUNITY_GOAL_RECIPIENT": "recipient.testnet",
            "HARVESTPOOL_COMMUNITY_GOAL_CURRENCY": "USDC",
            "HARVESTPOOL_COMMUNITY_GOAL_TARGET_USDC": "1.250001",
            "HARVESTPOOL_COMMUNITY_GOAL_TARGET_NEAR": "",
        }
        with patch.dict("os.environ", complete, clear=False):
            goal = web_app._community_goal_config()
        self.assertTrue(goal["configured"])
        self.assertEqual(goal["targetUnits"], "1250001")
        self.assertEqual(goal["targetYocto"], "")
        self.assertEqual(goal["tokenId"], web_app.CANONICAL_USDC_TOKEN_ID)

        mixed = {**complete, "HARVESTPOOL_COMMUNITY_GOAL_TARGET_NEAR": "1"}
        with patch.dict("os.environ", mixed, clear=False):
            goal = web_app._community_goal_config()
        self.assertFalse(goal["configured"])
        self.assertIn("cannot also configure a NEAR target", goal["configurationError"])

    def test_usdc_activity_separates_ft_history_and_requires_successful_payment_receipt(self):
        token_id = web_app.CANONICAL_USDC_TOKEN_ID
        transaction_page = {
            "data": [{
                "actions": [{"action": "FUNCTION_CALL", "method": "act_proposal"}],
                "outcomes": {"status": True},
                "receiver_account_id": "community.sputnikv2.testnet",
                "signer_account_id": "bob.testnet",
                "transaction_hash": "vote-hash",
            }],
            "meta": {},
        }
        ft_page = {
            "data": [
                {
                    "contract_account_id": token_id,
                    "delta_amount": "250000",
                    "involved_account_id": "alice.testnet",
                    "transaction_hash": "contribution-hash",
                    "receipt_id": "contribution-receipt",
                    "block_timestamp": "1794430000000000000",
                },
                {
                    "contract_account_id": token_id,
                    "delta_amount": "-200000",
                    "involved_account_id": "recipient.testnet",
                    "transaction_hash": "vote-hash",
                    "receipt_id": "payment-receipt",
                    "block_timestamp": "1794432000000000000",
                },
                {
                    "contract_account_id": token_id,
                    "delta_amount": "-999999",
                    "involved_account_id": "attacker.testnet",
                    "transaction_hash": "vote-hash",
                    "receipt_id": "failed-receipt",
                    "block_timestamp": "1794432000000000000",
                },
            ],
            "meta": {},
        }
        detail = {"data": {
            "actions": [{"method": "act_proposal", "args": {"args_json": {"id": 9, "action": "VoteApprove"}}}],
            "signer_account_id": "bob.testnet",
            "block_timestamp": "1794432000000000000",
        }}
        receipts = {"data": {
            "outcome": {"status": True},
            "receipts": [{
                "receipt_id": "payment-receipt",
                "outcome": {"status": True},
                "receipts": [],
            }, {
                "receipt_id": "failed-receipt",
                "outcome": {"status": False},
                "receipts": [],
            }],
        }}

        def fake_read(path, params=None):
            if path.endswith("/txns"):
                return transaction_page
            if path.endswith("/ft-txns"):
                return ft_page
            if path.endswith("/vote-hash/receipts"):
                return receipts
            if path.endswith("/vote-hash"):
                return detail
            raise AssertionError(path)

        with patch.object(web_app, "_nearblocks_json", side_effect=fake_read):
            result = web_app._community_activity("community.sputnikv2.testnet", token_id)

        self.assertEqual(result["tokenId"], token_id)
        self.assertEqual(result["contributions"][0]["amount"], "250000")
        transfers = result["proposalTransactions"]["9"][0]["transfers"]
        self.assertEqual(transfers, [{
            "amount": "200000",
            "receiver": "recipient.testnet",
            "receiptId": "payment-receipt",
            "tokenId": token_id,
        }])

    def test_known_usdc_evidence_uses_finalized_rpc_when_indexer_is_unavailable(self):
        token_id = web_app.CANONICAL_USDC_TOKEN_ID
        dao_id = "community.sputnikv2.testnet"
        recipient = "recipient.testnet"
        evidence = {
            "contributionHash": "A" * 44,
            "contributor": "alice.testnet",
            "contributionAmount": "1000000",
            "paymentHash": "B" * 44,
            "paymentSigner": "bob.testnet",
            "paymentProposalId": "2",
            "paymentReceiptId": "C" * 44,
            "paymentAmount": "800000",
        }

        def encoded(value):
            return base64.b64encode(json.dumps(value).encode()).decode()

        def transaction(tx_hash, signer, receiver, method, args, block_hash, transfer):
            receipt_id, old_owner, new_owner, amount = transfer
            return {
                "final_execution_status": "FINAL",
                "status": {"SuccessValue": ""},
                "transaction": {
                    "hash": tx_hash,
                    "signer_id": signer,
                    "receiver_id": receiver,
                    "actions": [{"FunctionCall": {
                        "method_name": method,
                        "args": encoded(args),
                        "deposit": "1" if method == "ft_transfer" else "0",
                    }}],
                },
                "transaction_outcome": {"block_hash": block_hash},
                "receipts_outcome": [{
                    "id": receipt_id,
                    "outcome": {
                        "executor_id": token_id,
                        "status": {"SuccessValue": ""},
                        "logs": ["EVENT_JSON:" + json.dumps({
                            "standard": "nep141",
                            "event": "ft_transfer",
                            "data": [{
                                "old_owner_id": old_owner,
                                "new_owner_id": new_owner,
                                "amount": amount,
                            }],
                        })],
                    },
                }],
            }

        contribution = transaction(
            evidence["contributionHash"], evidence["contributor"], token_id,
            "ft_transfer", {"receiver_id": dao_id, "amount": "1000000"},
            "contribution-block", ("D" * 44, evidence["contributor"], dao_id, "1000000"),
        )
        payment = transaction(
            evidence["paymentHash"], evidence["paymentSigner"], dao_id,
            "act_proposal", {"id": 2, "action": "VoteApprove"},
            "payment-block", (evidence["paymentReceiptId"], dao_id, recipient, "800000"),
        )

        def fake_rpc(method, params):
            if method == "tx":
                return contribution if params["tx_hash"] == evidence["contributionHash"] else payment
            if method == "block":
                timestamp = "1794430000000000000" if params["block_id"] == "contribution-block" else "1794432000000000000"
                return {"header": {"timestamp_nanosec": timestamp}}
            raise AssertionError((method, params))

        with patch.object(web_app, "_community_rpc", side_effect=fake_rpc):
            result = web_app._known_community_activity(
                dao_id, token_id, {"currency": "USDC", "recipient": recipient}, evidence
            )

        self.assertTrue(result["complete"])
        self.assertTrue(result["boundedEvidence"])
        self.assertEqual(result["contributions"][0]["amount"], "1000000")
        transfer = result["proposalTransactions"]["2"][0]["transfers"][0]
        self.assertEqual(transfer["receiptId"], evidence["paymentReceiptId"])
        self.assertEqual(transfer["amount"], "800000")

    def test_known_usdc_evidence_rejects_wrong_payment_receipt(self):
        result = {
            "receipts_outcome": [{
                "id": "different-receipt",
                "outcome": {
                    "executor_id": web_app.CANONICAL_USDC_TOKEN_ID,
                    "status": {"SuccessValue": ""},
                    "logs": ["EVENT_JSON:" + json.dumps({
                        "standard": "nep141",
                        "event": "ft_transfer",
                        "data": [{
                            "old_owner_id": "community.sputnikv2.testnet",
                            "new_owner_id": "recipient.testnet",
                            "amount": "800000",
                        }],
                    })],
                },
            }],
        }
        with self.assertRaisesRegex(ValueError, "exact successful token transfer"):
            web_app._successful_nep141_transfer(
                result,
                web_app.CANONICAL_USDC_TOKEN_ID,
                "community.sputnikv2.testnet",
                "recipient.testnet",
                "800000",
                "expected-receipt",
            )

    def test_finalized_evidence_merges_new_indexed_contributions_without_duplicates(self):
        evidence = {
            "complete": True,
            "boundedEvidence": True,
            "contributions": [{"transactionHash": "baseline", "amount": "1000000"}],
            "proposalTransactions": {"2": [{"transactionHash": "payment", "action": "VoteApprove"}]},
            "sourceUrl": "https://testnet.nearblocks.io/address/community.testnet",
        }
        indexed = {
            "complete": True,
            "contributions": [
                {"transactionHash": "baseline", "amount": "1000000"},
                {"transactionHash": "new-contribution", "amount": "10000"},
            ],
            "proposalTransactions": {"2": [{"transactionHash": "payment", "action": "VoteApprove"}]},
            "verifiedAt": "2026-11-12T12:00:00+00:00",
            "stale": False,
        }

        merged = web_app._merge_community_activity(evidence, indexed)

        self.assertTrue(merged["complete"])
        self.assertFalse(merged["boundedEvidence"])
        self.assertEqual(
            {item["transactionHash"] for item in merged["contributions"]},
            {"baseline", "new-contribution"},
        )
        self.assertEqual(len(merged["proposalTransactions"]["2"]), 1)

    def test_durable_receipts_survive_restart_and_provider_outage(self):
        fund = web_app._configured_community_funds()["community-garden"]
        records = [
            {
                "transactionHash": f"tx-{index}",
                "receiptId": f"receipt-{index}",
                "contributor": "alice.testnet",
                "amount": amount,
                "timestamp": str(1000 + index),
                "tokenId": web_app.CANONICAL_USDC_TOKEN_ID,
            }
            for index, amount in enumerate(("100000", "1000000", "1000000"), 1)
        ]
        broad = {
            "complete": True, "contributions": [], "proposalTransactions": {},
            "stale": False,
        }
        with (
            patch.object(web_app, "_discover_contribution_candidates", return_value=(records, True)),
            patch.object(web_app, "_cached_community_activity", return_value=broad),
            patch.object(web_app, "_finalized_ft_balance", return_value="2100000"),
        ):
            current = web_app._durable_community_activity(fund)

        self.assertTrue(current["contributionHistoryComplete"])
        self.assertEqual(current["lifetimeRaised"], "2100000")
        self.assertEqual(current["treasuryBalance"], "2100000")

        web_app._community_activity_cache.clear()
        with (
            patch.object(web_app, "_discover_contribution_candidates", side_effect=URLError("indexer down")),
            patch.object(web_app, "_cached_community_activity", side_effect=URLError("nearblocks down")),
            patch.object(web_app, "_finalized_ft_balance", side_effect=URLError("rpc down")),
        ):
            preserved = web_app._durable_community_activity(fund)

        self.assertTrue(preserved["contributionHistoryComplete"])
        self.assertEqual(preserved["lifetimeRaised"], "2100000")
        self.assertTrue(preserved["historyStale"])
        self.assertEqual(preserved["verifiedContributionSubtotal"], "2100000")
        self.assertEqual(preserved["treasuryBalance"], "2100000")
        self.assertTrue(preserved["treasuryBalanceStale"])
        self.assertEqual(len(preserved["contributions"]), 3)

    def test_exact_verification_endpoint_is_idempotent(self):
        record = {
            "transactionHash": "A" * 44,
            "receiptId": "B" * 44,
            "contributor": "alice.testnet",
            "amount": "1000000",
            "timestamp": "1794575420755944648",
            "tokenId": web_app.CANONICAL_USDC_TOKEN_ID,
        }
        client = web_app.app.test_client()
        body = {
            "transactionHash": record["transactionHash"],
            "signerId": record["contributor"],
            "amount": record["amount"],
            "memo": "Contribution toward Community Garden",
        }
        with patch.object(web_app, "_verify_contribution_transaction", return_value=record) as verify:
            first = client.post(
                "/api/community-funds/community-garden/contributions/verify", json=body
            )
            second = client.post(
                "/api/community-funds/community-garden/contributions/verify", json=body
            )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(verify.call_count, 1)
        self.assertEqual(len(web_app._verified_contribution_ledger("community-garden")), 1)

    def test_two_observed_attempts_move_from_awaiting_to_confirmed_without_duplicates(self):
        fund = web_app._configured_community_funds()["community-garden"]
        memo = "Contribution toward Community Garden"
        baseline = {
            "transactionHash": "C" * 44,
            "receiptId": "D" * 44,
            "contributor": "baseline.testnet",
            "amount": "50000000",
            "timestamp": "1794575420755944000",
            "tokenId": web_app.CANONICAL_USDC_TOKEN_ID,
            "memo": memo,
        }
        web_app._store_verified_contribution(
            "community-garden", fund["daoId"], web_app.CANONICAL_USDC_TOKEN_ID,
            baseline,
        )
        attempts = {
            "alice.testnet": {
                "transactionHash": "A" * 44, "contributor": "alice.testnet",
                "amount": "5000000", "tokenId": web_app.CANONICAL_USDC_TOKEN_ID,
                "memo": memo,
            },
            "bob.testnet": {
                "transactionHash": "B" * 44, "contributor": "bob.testnet",
                "amount": "15000000", "tokenId": web_app.CANONICAL_USDC_TOKEN_ID,
                "memo": memo,
            },
        }

        def pending(transaction_hash, signer_id, *_args):
            self.assertEqual(transaction_hash, attempts[signer_id]["transactionHash"])
            raise web_app.ContributionTransactionPending(attempts[signer_id])

        client = web_app.app.test_client()
        with patch.object(web_app, "_verify_contribution_transaction", side_effect=pending):
            for signer_id, record in attempts.items():
                body = {
                    "transactionHash": record["transactionHash"],
                    "signerId": signer_id, "amount": record["amount"], "memo": memo,
                }
                self.assertEqual(client.post(
                    "/api/community-funds/community-garden/contributions/verify", json=body
                ).status_code, 202)
            duplicate = client.post(
                "/api/community-funds/community-garden/contributions/verify",
                json={
                    "transactionHash": attempts["alice.testnet"]["transactionHash"],
                    "signerId": "alice.testnet", "amount": "5000000", "memo": memo,
                },
            )
        self.assertEqual(duplicate.status_code, 202)
        summary = client.get("/api/community-funds/community-garden/activity").get_json()
        self.assertEqual(summary["verifiedContributionSubtotal"], "50000000")
        self.assertEqual(summary["awaitingConfirmation"], "20000000")
        self.assertEqual(summary["awaitingAttemptCount"], 2)

        verified_alice = {
            **attempts["alice.testnet"], "receiptId": "E" * 44,
            "timestamp": "1794575420755945000",
        }
        with patch.object(web_app, "_verify_contribution_transaction", return_value=verified_alice):
            response = client.post(
                "/api/community-funds/community-garden/contributions/verify",
                json={
                    "transactionHash": verified_alice["transactionHash"],
                    "signerId": "alice.testnet", "amount": "5000000", "memo": memo,
                },
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["summary"]["verifiedContributionSubtotal"], "55000000")
        self.assertEqual(response.get_json()["summary"]["awaitingConfirmation"], "15000000")

        verified_bob = {
            **attempts["bob.testnet"], "receiptId": "F" * 44,
            "timestamp": "1794575420755946000",
        }
        with patch.object(web_app, "_verify_contribution_transaction", return_value=verified_bob):
            response = client.post(
                "/api/community-funds/community-garden/contributions/verify",
                json={
                    "transactionHash": verified_bob["transactionHash"],
                    "signerId": "bob.testnet", "amount": "15000000", "memo": memo,
                },
            )
        self.assertEqual(response.get_json()["summary"]["verifiedContributionSubtotal"], "70000000")
        self.assertEqual(response.get_json()["summary"]["awaitingConfirmation"], "0")

    def test_pending_attempt_requires_an_exact_rpc_observed_transfer_identity(self):
        transaction_hash = "K" * 44
        signer_id = "alice.testnet"
        dao_id = web_app.COMMUNITY_GARDEN_DAO_ID
        token_id = web_app.CANONICAL_USDC_TOKEN_ID
        amount = "5000000"
        memo = "Contribution toward Community Garden"
        args = base64.b64encode(json.dumps({
            "receiver_id": dao_id, "amount": amount, "memo": memo,
        }).encode()).decode()
        pending_result = {
            "final_execution_status": "EXECUTED_OPTIMISTIC",
            "transaction": {
                "hash": transaction_hash,
                "signer_id": signer_id,
                "receiver_id": token_id,
                "actions": [{"FunctionCall": {
                    "method_name": "ft_transfer", "args": args, "deposit": "1",
                }}],
            },
        }
        with patch.object(web_app, "_community_rpc", return_value=pending_result) as rpc:
            with self.assertRaises(web_app.ContributionTransactionPending):
                web_app._verify_contribution_transaction(
                    transaction_hash, signer_id, dao_id, token_id, amount, memo
                )
        self.assertEqual(rpc.call_args.args[1]["wait_until"], "NONE")

        wrong_receiver = {
            **pending_result,
            "transaction": {**pending_result["transaction"], "receiver_id": "fake-token.testnet"},
        }
        with patch.object(web_app, "_community_rpc", return_value=wrong_receiver):
            with self.assertRaisesRegex(ValueError, "does not exactly match"):
                web_app._verify_contribution_transaction(
                    transaction_hash, signer_id, dao_id, token_id, amount, memo
                )
        self.assertEqual(web_app._contribution_summary("community-garden")["awaitingConfirmation"], "0")

    def test_failed_attempt_leaves_awaiting_and_provider_failure_preserves_observed_state(self):
        memo = "Contribution toward Community Garden"
        record = {
            "transactionHash": "G" * 44,
            "contributor": "alice.testnet",
            "amount": "5000000",
            "tokenId": web_app.CANONICAL_USDC_TOKEN_ID,
            "memo": memo,
        }
        body = {
            "transactionHash": record["transactionHash"],
            "signerId": record["contributor"], "amount": record["amount"], "memo": memo,
        }
        client = web_app.app.test_client()
        with patch.object(
            web_app, "_verify_contribution_transaction",
            side_effect=web_app.ContributionTransactionPending(record),
        ):
            self.assertEqual(client.post(
                "/api/community-funds/community-garden/contributions/verify", json=body
            ).status_code, 202)
        with patch.object(web_app, "_verify_contribution_transaction", side_effect=URLError("rpc down")):
            preserved = client.post(
                "/api/community-funds/community-garden/contributions/verify", json=body
            )
        self.assertEqual(preserved.status_code, 200)
        self.assertTrue(preserved.get_json()["verificationUnavailable"])
        self.assertEqual(preserved.get_json()["summary"]["awaitingConfirmation"], "5000000")

        with patch.object(
            web_app, "_verify_contribution_transaction",
            side_effect=web_app.ContributionTransactionFailed(record),
        ):
            failed = client.post(
                "/api/community-funds/community-garden/contributions/verify", json=body
            )
        self.assertEqual(failed.get_json()["state"], "failed")
        self.assertEqual(failed.get_json()["summary"]["awaitingConfirmation"], "0")
        self.assertEqual(failed.get_json()["summary"]["verifiedContributionSubtotal"], "0")

    def test_concurrent_attempt_writes_are_idempotent_and_survive_new_connections(self):
        fund = web_app._configured_community_funds()["community-garden"]
        memo = "Contribution toward Community Garden"
        records = [
            {
                "transactionHash": character * 44,
                "contributor": signer,
                "amount": amount,
                "tokenId": web_app.CANONICAL_USDC_TOKEN_ID,
                "memo": memo,
            }
            for character, signer, amount in (
                ("H", "alice.testnet", "5000000"),
                ("J", "bob.testnet", "15000000"),
            )
        ]
        # Initialize the additive schema before concurrent worker connections begin.
        self.assertEqual(web_app._contribution_summary("community-garden")["awaitingConfirmation"], "0")

        def store(record):
            return web_app._store_contribution_attempt(
                "community-garden", fund["daoId"], web_app.CANONICAL_USDC_TOKEN_ID,
                record, "awaiting",
            )

        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(store, [records[0], records[1], records[0], records[1]]))
        summary = web_app._contribution_summary("community-garden")
        self.assertEqual(summary["awaitingConfirmation"], "20000000")
        self.assertEqual(summary["awaitingAttemptCount"], 2)
        web_app._community_activity_cache.clear()
        restarted = web_app.app.test_client().get(
            "/api/community-funds/community-garden/activity"
        ).get_json()
        self.assertEqual(restarted["awaitingConfirmation"], "20000000")
        self.assertEqual(restarted["awaitingAttemptCount"], 2)

    def test_background_refresh_reconciles_known_attempts_without_browser_or_indexer(self):
        fund = web_app._configured_community_funds()["community-garden"]
        memo = "Contribution toward Community Garden"
        alice = {
            "transactionHash": "L" * 44, "contributor": "alice.testnet",
            "amount": "5000000", "tokenId": web_app.CANONICAL_USDC_TOKEN_ID,
            "memo": memo,
        }
        bob = {
            "transactionHash": "M" * 44, "contributor": "bob.testnet",
            "amount": "15000000", "tokenId": web_app.CANONICAL_USDC_TOKEN_ID,
            "memo": memo,
        }
        for record in (alice, bob):
            web_app._store_contribution_attempt(
                "community-garden", fund["daoId"], web_app.CANONICAL_USDC_TOKEN_ID,
                record, "awaiting",
            )
        verified_alice = {
            **alice, "receiptId": "N" * 44,
            "timestamp": "1794575420755947000",
        }
        with patch.object(
            web_app, "_verify_contribution_transaction",
            side_effect=[verified_alice, web_app.ContributionTransactionFailed(bob)],
        ) as verify:
            web_app._reconcile_contribution_attempts(fund)
        self.assertEqual(verify.call_count, 2)
        summary = web_app._contribution_summary("community-garden")
        self.assertEqual(summary["verifiedContributionSubtotal"], "5000000")
        self.assertEqual(summary["awaitingConfirmation"], "0")
        self.assertEqual(summary["awaitingAttemptCount"], 0)

    def test_hashless_recovery_refuses_ambiguous_exact_candidates(self):
        timestamp = 1794575420755944648
        candidates = [
            {
                "transactionHash": character * 44,
                "receiptId": receipt * 44,
                "contributor": "alice.testnet",
                "amount": "1000000",
                "timestamp": str(timestamp + offset),
                "tokenId": web_app.CANONICAL_USDC_TOKEN_ID,
                "memo": "Contribution toward Community Garden",
            }
            for character, receipt, offset in (("A", "C", 1), ("B", "D", 2))
        ]
        with patch.object(
            web_app, "_discover_contribution_candidates", return_value=(candidates, True)
        ):
            response = web_app.app.test_client().post(
                "/api/community-funds/community-garden/contributions/verify",
                json={
                    "signerId": "alice.testnet",
                    "amount": "1000000",
                    "memo": "Contribution toward Community Garden",
                    "startedAtNs": str(timestamp),
                },
            )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["candidateCount"], 2)
        self.assertEqual(web_app._verified_contribution_ledger("community-garden"), [])

    def test_fastnear_discovery_verifies_only_new_exact_candidates(self):
        dao_id = "garden.testnet"
        token_id = "usdc.testnet"

        def indexed_transaction(tx_hash, amount):
            args = base64.b64encode(json.dumps({
                "receiver_id": dao_id,
                "amount": amount,
                "memo": "Contribution toward Community Garden",
            }).encode()).decode()
            return {"transaction": {
                "hash": tx_hash,
                "signer_id": "alice.testnet",
                "receiver_id": token_id,
                "actions": [{"FunctionCall": {
                    "method_name": "ft_transfer", "args": args, "deposit": "1",
                }}],
            }}

        transactions = [indexed_transaction("known", "100000"), indexed_transaction("new", "1000000")]

        def fastnear(path, _payload):
            if path == "/v0/account":
                return {"account_txs": [
                    {"transaction_hash": "known", "is_success": True},
                    {"transaction_hash": "new", "is_success": True},
                ]}
            if path == "/v0/transactions":
                return {"transactions": transactions}
            raise AssertionError(path)

        verified = {
            "transactionHash": "new", "receiptId": "receipt", "contributor": "alice.testnet",
            "amount": "1000000", "timestamp": "123", "tokenId": token_id,
            "memo": "Contribution toward Community Garden",
        }
        with (
            patch.object(web_app, "_fastnear_json", side_effect=fastnear),
            patch.object(web_app, "_verify_contribution_transaction", return_value=verified) as verify,
        ):
            records, complete = web_app._discover_contribution_candidates(
                dao_id, token_id, {"known"}
            )

        self.assertTrue(complete)
        self.assertEqual(records, [verified])
        verify.assert_called_once_with("new", "alice.testnet", dao_id, token_id, "1000000")


if __name__ == "__main__":
    unittest.main()
