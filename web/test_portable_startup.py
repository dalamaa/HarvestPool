import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import run
from web import app as web_app
from web.config import (
    CANONICAL_CONTRACT_ID,
    CANONICAL_CONTRACT_VERSION,
    CANONICAL_NETWORK,
    CANONICAL_PORT,
    CANONICAL_USDC_TOKEN_ID,
    CANONICAL_V3_CONTRACT_ID,
)


class PortableStartupTests(unittest.TestCase):
    def test_clean_clone_uses_canonical_public_defaults(self):
        missing = Path(tempfile.gettempdir()) / "harvestpool-no-such-env"
        with patch.dict(os.environ, {}, clear=True):
            run.configure_environment(missing)
            self.assertEqual(os.environ["PORT"], str(CANONICAL_PORT))
            self.assertEqual(os.environ["NEAR_NETWORK"], CANONICAL_NETWORK)
            self.assertEqual(os.environ["HARVESTPOOL_CONTRACT_ID"], CANONICAL_CONTRACT_ID)
            self.assertEqual(
                os.environ["HARVESTPOOL_CONTRACT_VERSION"], CANONICAL_CONTRACT_VERSION
            )
            self.assertEqual(
                os.environ["HARVESTPOOL_V3_CONTRACT_ID"], CANONICAL_V3_CONTRACT_ID
            )
            self.assertEqual(
                os.environ["HARVESTPOOL_USDC_TOKEN_ID"], CANONICAL_USDC_TOKEN_ID
            )
            self.assertEqual(os.environ["HARVESTPOOL_FINALIZER_ENABLED"], "false")

    def test_environment_file_is_cross_platform_and_shell_environment_wins(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text(
                "\n".join(
                    [
                        "# Public values",
                        "export PORT=5511",
                        f"NEAR_NETWORK={CANONICAL_NETWORK}",
                        f"HARVESTPOOL_CONTRACT_ID={CANONICAL_CONTRACT_ID}",
                        'HARVESTPOOL_CONTRACT_VERSION="V5"',
                        f"HARVESTPOOL_V3_CONTRACT_ID={CANONICAL_V3_CONTRACT_ID}",
                        f"HARVESTPOOL_USDC_TOKEN_ID={CANONICAL_USDC_TOKEN_ID}",
                    ]
                ),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"PORT": "5512"}, clear=True):
                run.configure_environment(env_file)
                self.assertEqual(os.environ["PORT"], "5512")

    def test_legacy_contract_configuration_is_rejected(self):
        missing = Path(tempfile.gettempdir()) / "harvestpool-no-such-env"
        with patch.dict(
            os.environ,
            {"HARVESTPOOL_CONTRACT_ID": "harvestpool-v4-dalamaa-20261109.testnet"},
            clear=True,
        ):
            with self.assertRaises(run.ConfigurationError):
                run.configure_environment(missing)

    def test_flask_defaults_are_canonical_v5(self):
        self.assertEqual(web_app.CONTRACT_ID, CANONICAL_CONTRACT_ID)
        self.assertEqual(web_app.CONTRACT_VERSION, CANONICAL_CONTRACT_VERSION)
        self.assertEqual(web_app.V3_CONTRACT_ID, CANONICAL_V3_CONTRACT_ID)
        self.assertEqual(web_app.NETWORK, CANONICAL_NETWORK)
        response = web_app.app.test_client().get("/")
        self.assertEqual(response.status_code, 200)
        page = response.get_data(as_text=True)
        self.assertIn(CANONICAL_CONTRACT_ID, page)
        self.assertIn(CANONICAL_V3_CONTRACT_ID, page)


if __name__ == "__main__":
    unittest.main()
