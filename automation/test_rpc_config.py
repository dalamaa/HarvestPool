import json
import unittest
from unittest.mock import patch

from automation.finalizer import Config, ConfigurationError, NearRpc


class Response:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self):
        return json.dumps({"result": {"ok": True}}).encode()


class RpcConfigTests(unittest.TestCase):
    @patch("automation.finalizer.urlopen")
    def test_fastnear_key_uses_bearer_header(self, request):
        request.return_value = Response()
        result = NearRpc("https://rpc.testnet.fastnear.com", api_key="private-api-key").request("status", [])
        self.assertEqual(result, {"ok": True})
        sent_request = request.call_args.args[0]
        self.assertEqual(sent_request.get_header("Authorization"), "Bearer private-api-key")
        self.assertNotIn("private-api-key", sent_request.full_url)

    def test_rpc_timeout_is_bounded(self):
        with patch.dict("os.environ", {"HARVESTPOOL_FINALIZER_RPC_TIMEOUT_SECONDS": "10"}, clear=True):
            self.assertEqual(Config.from_env().rpc_timeout_seconds, 10)
        with patch.dict("os.environ", {"HARVESTPOOL_FINALIZER_RPC_TIMEOUT_SECONDS": "61"}, clear=True):
            with self.assertRaises(ConfigurationError):
                Config.from_env()


if __name__ == "__main__":
    unittest.main()
