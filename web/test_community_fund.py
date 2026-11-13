import base64
import io
import json
import unittest
import time
from urllib.error import HTTPError, URLError
from unittest.mock import patch

from web import app as web_app


class CommunityFundActivityTests(unittest.TestCase):
    def setUp(self):
        web_app._community_activity_cache.clear()

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


if __name__ == "__main__":
    unittest.main()
