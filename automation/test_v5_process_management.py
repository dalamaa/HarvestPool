import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMMON = ROOT / "scripts" / "v5-common.sh"


class V5ProcessManagementTests(unittest.TestCase):
    def run_common(self, body):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "v5.pid"
            script = textwrap.dedent(
                f"""\
                set -u
                . {str(COMMON)!r}
                V5_PID_FILE={str(pid_file)!r}
                V5_PYTHON_BIN={str(Path(os.sys.executable))!r}
                {body}
                """
            )
            return subprocess.run(
                ["bash", "-c", script],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            ), pid_file

    def test_unique_canonical_listener_recovers_atomically(self):
        result, _ = self.run_common(
            """
            v5_listener_pids() { printf '4242\\n'; }
            v5_pid_is_canonical_instance() { [ "$1" = 4242 ]; }
            v5_recover_pid_file
            test "$(cat "$V5_PID_FILE")" = 4242
            test ! -e "${V5_PID_FILE}.tmp.$$"
            """
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Recovered canonical HarvestPool V5 PID", result.stderr)

    def run_lifecycle_script(self, script_name, common_body):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            (project / "scripts").mkdir()
            (project / script_name).write_bytes((ROOT / script_name).read_bytes())
            (project / "scripts" / "v5-common.sh").write_text(
                textwrap.dedent(
                    f"""\
                    PROJECT_DIR={str(project)!r}
                    V5_PID_FILE="$PROJECT_DIR/.v5.pid"
                    V5_PORT=5011
                    V5_URL=http://127.0.0.1:5011/
                    V5_LOG_FILE="$PROJECT_DIR/v5.log"
                    v5_load_and_validate_environment() {{ return 0; }}
                    v5_resolve_python() {{ V5_PYTHON_BIN={str(Path(os.sys.executable))!r}; return 0; }}
                    v5_finalizer_validate_activation() {{ return 0; }}
                    v5_finalizer_is_enabled() {{ return 1; }}
                    v5_start_finalizer_or_verify() {{ return 0; }}
                    v5_stop_finalizer() {{ return 0; }}
                    v5_error() {{ printf 'ERROR: %s\\n' "$*" >&2; }}
                    {common_body}
                    """
                ),
                encoding="utf-8",
            )
            return subprocess.run(
                ["bash", str(project / script_name)],
                cwd=project,
                text=True,
                capture_output=True,
                check=False,
            )

    def test_start_refuses_an_unidentified_listener(self):
        result = self.run_lifecycle_script(
            "start.sh",
            """
            v5_recover_pid_file() { return 1; }
            v5_listener_pids() { printf '7777\\n'; }
            v5_show_listeners() { printf 'unknown listener\\n'; }
            """,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("occupied by an unrelated process", result.stderr)
        self.assertNotIn("Starting HarvestPool", result.stdout)

    def test_stop_refuses_an_unidentified_listener_without_signaling(self):
        result = self.run_lifecycle_script(
            "stop.sh",
            """
            v5_recover_pid_file() { return 1; }
            v5_listener_pids() { printf '7777\\n'; }
            v5_show_listeners() { printf 'unknown listener\\n'; }
            kill() { printf 'kill-called\\n'; return 99; }
            """,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not match the canonical HarvestPool V5 fingerprint", result.stderr)
        self.assertNotIn("kill-called", result.stdout + result.stderr)

    def test_unidentified_listener_is_never_adopted(self):
        result, _ = self.run_common(
            """
            v5_listener_pids() { printf '4242\\n'; }
            v5_pid_is_canonical_instance() { return 1; }
            if v5_recover_pid_file; then exit 9; fi
            test ! -e "$V5_PID_FILE"
            """
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_multiple_listeners_are_never_adopted(self):
        result, _ = self.run_common(
            """
            v5_listener_pids() { printf '4242\\n4343\\n'; }
            v5_pid_is_canonical_instance() { return 0; }
            if v5_recover_pid_file; then exit 9; fi
            test ! -e "$V5_PID_FILE"
            """
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_fingerprint_requires_every_canonical_boundary(self):
        result, _ = self.run_common(
            """
            v5_pid_is_alive() { return 0; }
            v5_pid_is_owned() { return 0; }
            v5_listener_pids() { printf '4242\\n'; }
            id() { printf '501\\n'; }
            ps() { printf '501\\n'; }
            v5_process_cwd() { printf '%s\\n' "$PROJECT_DIR"; }
            v5_process_executable() { printf '%s\\n' "$V5_PYTHON_BIN"; }
            v5_process_fd_path() {
                case "$2" in
                    0) printf '/dev/null\\n' ;;
                    1|2) printf '%s\\n' "$V5_LOG_FILE" ;;
                esac
            }
            v5_pid_is_canonical_instance 4242
            v5_process_cwd() { printf '/another/project\\n'; }
            if v5_pid_is_canonical_instance 4242; then exit 9; fi
            """
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
