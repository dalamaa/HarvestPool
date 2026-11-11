import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class StatusScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name)
        (self.project / "scripts").mkdir()
        shutil.copy2(ROOT / "status.sh", self.project / "status.sh")
        (self.project / ".v5.pid").write_text("111\n", encoding="utf-8")
        (self.project / ".finalizer.pid").write_text("222\n", encoding="utf-8")
        common = textwrap.dedent(
            """\
            PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
            V5_PORT=5011
            V5_URL=http://127.0.0.1:5011/
            V5_PID_FILE="$PROJECT_DIR/.v5.pid"
            V5_FINALIZER_PID_FILE="$PROJECT_DIR/.finalizer.pid"
            v5_load_and_validate_environment() { return 0; }
            v5_resolve_python() { V5_PYTHON_BIN="$MOCK_PYTHON_BIN"; return 0; }
            v5_read_pid() { tr -d '[:space:]' < "$V5_PID_FILE"; }
            v5_finalizer_read_pid() { tr -d '[:space:]' < "$V5_FINALIZER_PID_FILE"; }
            v5_pid_is_alive() {
                if [ "$1" = 111 ]; then [ "$MOCK_WEB_ALIVE" = true ]; else [ "$MOCK_FINALIZER_ALIVE" = true ]; fi
            }
            v5_pid_is_owned() { [ "$MOCK_WEB_OWNED" = true ]; }
            v5_finalizer_pid_is_owned() { [ "$MOCK_FINALIZER_OWNED" = true ]; }
            v5_http_status() { printf '%s\n' "$MOCK_WEB_HTTP"; }
            v5_http_is_healthy() { [ "$MOCK_WEB_HTTP" = 200 ]; }
            v5_finalizer_http_status() { printf '%s\n' "$MOCK_FINALIZER_HTTP"; }
            v5_finalizer_health_url() { printf 'http://127.0.0.1:8091/healthz'; }
            v5_finalizer_is_enabled() { [ "$MOCK_FINALIZER_ENABLED" = true ]; }
            """
        )
        (self.project / "scripts" / "v5-common.sh").write_text(common, encoding="utf-8")
        mock_python = self.project / "mock-python"
        mock_python.write_text("#!/usr/bin/env bash\nprintf '%s\\n' \"$MOCK_HEALTH_REPORT\"\n", encoding="utf-8")
        mock_python.chmod(0o755)
        self.environment = {
            **os.environ,
            "MOCK_PYTHON_BIN": str(mock_python),
            "MOCK_WEB_ALIVE": "true",
            "MOCK_WEB_OWNED": "true",
            "MOCK_WEB_HTTP": "200",
            "MOCK_FINALIZER_ENABLED": "true",
            "MOCK_FINALIZER_ALIVE": "true",
            "MOCK_FINALIZER_OWNED": "true",
            "MOCK_FINALIZER_HTTP": "200",
            "MOCK_HEALTH_REPORT": 'True\t1\t180\tFalse\tnone\t{"confirmed":3}',
        }

    def tearDown(self):
        self.temp.cleanup()

    def run_status(self, *arguments, **changes):
        environment = {**self.environment, **changes}
        return subprocess.run(
            ["bash", str(self.project / "status.sh"), *arguments],
            cwd=self.project,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_healthy_managed_web_and_finalizer_exit_zero(self):
        result = self.run_status()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Finalizer worker: OK", result.stdout)
        self.assertNotIn("not controlled by the V5 PID file", result.stdout)

    def test_disabled_finalizer_is_accurate_and_web_can_be_healthy(self):
        result = self.run_status(MOCK_FINALIZER_ENABLED="false")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Finalizer: disabled", result.stdout)

    def test_unmanaged_web_listener_still_fails_and_warns(self):
        result = self.run_status(MOCK_WEB_OWNED="false")
        self.assertEqual(result.returncode, 1)
        self.assertIn("PID FILE POINTS TO AN UNOWNED LIVE PROCESS", result.stdout)
        self.assertIn("not controlled by the V5 PID file", result.stdout)

    def test_unowned_finalizer_fails_without_mislabeling_web(self):
        result = self.run_status(MOCK_FINALIZER_OWNED="false")
        self.assertEqual(result.returncode, 1)
        self.assertIn("PID FILE POINTS TO AN UNOWNED LIVE PROCESS", result.stdout)
        self.assertNotIn("not controlled by the V5 PID file", result.stdout)

    def test_stopped_finalizer_with_stale_pid_file_fails(self):
        result = self.run_status(MOCK_FINALIZER_ALIVE="false")
        self.assertEqual(result.returncode, 1)
        self.assertIn("STOPPED OR MANAGED PID MISSING", result.stdout)
        self.assertNotIn("not controlled by the V5 PID file", result.stdout)

    def test_worker_payload_failure_is_not_suppressed(self):
        result = self.run_status(
            MOCK_HEALTH_REPORT='False\t181\t180\tTrue\trate limited\t{"unknown":1}'
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("Finalizer worker: NOT OK", result.stdout)
        self.assertIn("Finalizer last error: rate limited", result.stdout)

    def test_quiet_mode_preserves_success_and_failure_codes(self):
        self.assertEqual(self.run_status("--quiet").returncode, 0)
        self.assertEqual(self.run_status("--quiet", MOCK_FINALIZER_HTTP="503").returncode, 1)


if __name__ == "__main__":
    unittest.main()
