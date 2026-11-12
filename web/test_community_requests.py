import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from web import app as web_app


def valid_request(**overrides):
    payload = {
        "title": "Library tool lending shelf",
        "category": "Community equipment",
        "city": "Chicago",
        "state": "IL",
        "description": "Create a shared shelf of reliable household tools for neighbors to borrow.",
        "intended_purpose": "Reduce duplicate purchases and make basic repairs more accessible.",
        "cover_image_url": "https://example.org/tools.jpg",
        "organizer_name": "Neighborhood Library",
        "contact_email": "organizer@example.org",
        "organizer_role": "Library volunteer coordinator",
        "contact_method": "https://example.org/community",
        "share_contact": False,
        "target_amount": "1250.50",
        "budget": "Tools: $900; storage shelf: $250; labels and maintenance supplies: $100.50.",
        "contribution_deadline": "2099-05-01",
        "completion_date": "2099-06-01",
        "beneficiary": "Neighborhood Library",
        "reached_terms": "Purchase the itemized equipment only after the configured approval threshold is met.",
        "not_reached_terms": "Use the configured refund process; do not redirect money to a different purpose.",
        "payment_requesters": "The library coordinator named during treasury setup.",
        "payment_approvers": "The fixed DAO members named in the reviewed treasury policy.",
        "payment_refund_rules": "Payments require the configured threshold. Refund availability must be defined before contributions open.",
        "unused_money_terms": "Retain unused money in the isolated fund until members approve a documented refund or related expense.",
        "terms_acknowledged": True,
        "owner_token": "owner_token_12345678901234567890",
    }
    payload.update(overrides)
    return payload


class CommunityFundRequestTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database = Path(self.temporary_directory.name) / "metadata.sqlite3"
        self.database_patch = patch.object(web_app, "DATABASE", self.database)
        self.database_patch.start()
        self.client = web_app.app.test_client()

    def tearDown(self):
        self.database_patch.stop()
        self.temporary_directory.cleanup()

    def test_valid_request_persists_with_truthful_status_and_shareable_url(self):
        response = self.client.post("/api/community-funds", json=valid_request())
        self.assertEqual(response.status_code, 201)
        saved = response.get_json()
        self.assertEqual(saved["status"], "Awaiting Fund Setup")
        self.assertEqual(saved["url"], "/community-funds/library-tool-lending-shelf")

        refreshed_client = web_app.app.test_client()
        detail = refreshed_client.get(
            f"/api/community-funds/{saved['slug']}",
            headers={"X-HarvestPool-Owner-Token": "owner_token_12345678901234567890"},
        )
        self.assertEqual(detail.status_code, 200)
        fund = detail.get_json()["fund"]
        self.assertEqual(fund["targetAmount"], "1250.50")
        self.assertTrue(fund["isMine"])
        self.assertEqual(fund["contact_email"], "organizer@example.org")
        self.assertEqual(fund["contributions"], [])
        self.assertEqual(fund["paymentRequests"], [])

    def test_private_contact_is_not_exposed_publicly(self):
        saved = self.client.post("/api/community-funds", json=valid_request()).get_json()
        fund = self.client.get(f"/api/community-funds/{saved['slug']}").get_json()["fund"]
        self.assertNotIn("contact_email", fund)
        self.assertNotIn("contact_method", fund)
        self.assertFalse(fund["isMine"])

    def test_false_string_cannot_opt_private_contact_into_public_view(self):
        saved = self.client.post(
            "/api/community-funds", json=valid_request(share_contact="false")
        ).get_json()
        fund = self.client.get(f"/api/community-funds/{saved['slug']}").get_json()["fund"]
        self.assertFalse(fund["shareContact"])
        self.assertNotIn("contact_method", fund)

    def test_backend_rejects_invalid_amount_dates_terms_and_location(self):
        response = self.client.post(
            "/api/community-funds",
            json=valid_request(
                target_amount="0.001",
                state="Illinois",
                contribution_deadline="2020-01-01",
                completion_date="2019-01-01",
                terms_acknowledged=False,
            ),
        )
        self.assertEqual(response.status_code, 400)
        fields = response.get_json()["fields"]
        self.assertIn("target_amount", fields)
        self.assertIn("state", fields)
        self.assertIn("contribution_deadline", fields)
        self.assertIn("completion_date", fields)
        self.assertIn("terms_acknowledged", fields)

    def test_request_detail_has_no_edit_deposit_or_approval_endpoint(self):
        saved = self.client.post("/api/community-funds", json=valid_request()).get_json()
        self.assertEqual(self.client.patch(f"/api/community-funds/{saved['slug']}", json={}).status_code, 405)
        self.assertEqual(self.client.post(f"/api/community-funds/{saved['slug']}/contributions", json={}).status_code, 404)
        page = self.client.get(saved["url"])
        self.assertEqual(page.status_code, 200)
        self.assertIn(b"community-request-root", page.data)

    def test_directory_and_legacy_verified_routes_are_separate(self):
        directory = self.client.get("/community-funds")
        self.assertIn(b"Explore community funds", directory.data)
        verified = self.client.get("/community-fund")
        self.assertIn(b"Verified fund", verified.data)


if __name__ == "__main__":
    unittest.main()
