import json
import unittest
from unittest.mock import patch

from automation.healthcheck import inspect_health


class Response:
    def __init__(self, payload, status=200):
        self.status = status
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self):
        return json.dumps(self.payload).encode()


class HealthcheckTests(unittest.TestCase):
    @patch("automation.healthcheck.urlopen")
    def test_healthy_worker_passes(self, request):
        request.return_value = Response({"ok": True, "stale": False, "states": {"confirmed": 1}})
        healthy, _payload, problems = inspect_health("http://127.0.0.1:8091/healthz")
        self.assertTrue(healthy)
        self.assertEqual(problems, [])

    @patch("automation.healthcheck.urlopen")
    def test_uncertain_or_stale_worker_fails(self, request):
        request.return_value = Response({
            "ok": False,
            "stale": True,
            "last_error": "rate limited",
            "states": {"unknown": 1},
        })
        healthy, _payload, problems = inspect_health("http://127.0.0.1:8091/healthz")
        self.assertFalse(healthy)
        self.assertIn("worker heartbeat is stale", problems)
        self.assertIn("durable state unknown=1", problems)


if __name__ == "__main__":
    unittest.main()
