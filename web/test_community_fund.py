import unittest
import time
from urllib.error import URLError
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
            response = web_app.app.test_client().get("/community-goals")
        page = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn("community.sputnikv2.testnet", page)
        self.assertIn("School library books", page)
        self.assertIn("Community Goals", page)
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


if __name__ == "__main__":
    unittest.main()
