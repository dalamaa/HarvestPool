import unittest
from unittest.mock import patch

from web import app as web_app


class CommunityFundActivityTests(unittest.TestCase):
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
        self.assertIn("Separate SputnikDAO treasury", page)

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


if __name__ == "__main__":
    unittest.main()
