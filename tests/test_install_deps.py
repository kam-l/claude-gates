"""
Tests for install_deps.py — pip install SessionStart hook.

Acceptance criteria (spec.md task-31):
1. Hash-based cache invalidation — computes hash, compares to .deps-hash, skips on match
2. pip install --target isolates dependencies
3. Fail-open on pip failure — exits 0, removes cached hash for retry
4. Timeout 60000ms (documented; structural check)
Edge cases:
- pip not on PATH — try python3 -m pip as fallback
- CLAUDE_PLUGIN_DATA not set — skip install entirely
- First run (no cache file) — always installs
- Partial install (previous failure) — --target overwrites
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, call, patch

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates import install_deps


DEPS_HASH_FILENAME = ".deps-hash"


class TestHashCacheInvalidation(unittest.TestCase):
    """AC1: Hash-based cache invalidation."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_compute_hash_returns_string(self):
        """AC1: compute_hash(version) returns a non-empty string."""
        h = install_deps.compute_hash("4.5.0")
        self.assertIsInstance(h, str)
        self.assertTrue(len(h) > 0)

    def test_compute_hash_deterministic(self):
        """AC1: Same version always yields same hash."""
        h1 = install_deps.compute_hash("4.5.0")
        h2 = install_deps.compute_hash("4.5.0")
        self.assertEqual(h1, h2)

    def test_compute_hash_differs_for_different_versions(self):
        """AC1: Different versions produce different hashes."""
        h1 = install_deps.compute_hash("4.5.0")
        h2 = install_deps.compute_hash("4.6.0")
        self.assertNotEqual(h1, h2)

    def test_cache_hit_returns_true_when_hash_matches(self):
        """AC1: is_cache_hit returns True when .deps-hash matches current hash."""
        version = "4.5.0"
        current_hash = install_deps.compute_hash(version)
        hash_file = os.path.join(self.tmp, DEPS_HASH_FILENAME)
        with open(hash_file, "w") as f:
            f.write(current_hash)
        self.assertTrue(install_deps.is_cache_hit(self.tmp, version))

    def test_cache_miss_returns_false_when_hash_differs(self):
        """AC1: is_cache_hit returns False when .deps-hash has different hash."""
        hash_file = os.path.join(self.tmp, DEPS_HASH_FILENAME)
        with open(hash_file, "w") as f:
            f.write("old-hash-value")
        self.assertFalse(install_deps.is_cache_hit(self.tmp, "4.5.0"))

    def test_cache_miss_returns_false_when_no_cache_file(self):
        """Edge case: first run — no .deps-hash file → cache miss (always installs)."""
        self.assertFalse(install_deps.is_cache_hit(self.tmp, "4.5.0"))

    def test_write_cache_creates_hash_file(self):
        """AC1: write_cache writes hash to .deps-hash file."""
        version = "4.5.0"
        install_deps.write_cache(self.tmp, version)
        hash_file = os.path.join(self.tmp, DEPS_HASH_FILENAME)
        self.assertTrue(os.path.exists(hash_file))
        with open(hash_file) as f:
            stored = f.read().strip()
        self.assertEqual(stored, install_deps.compute_hash(version))

    def test_write_cache_then_cache_hit(self):
        """AC1: After write_cache, is_cache_hit returns True for same version."""
        version = "4.5.0"
        install_deps.write_cache(self.tmp, version)
        self.assertTrue(install_deps.is_cache_hit(self.tmp, version))

    def test_remove_cache_deletes_hash_file(self):
        """AC3: remove_cache deletes .deps-hash file."""
        hash_file = os.path.join(self.tmp, DEPS_HASH_FILENAME)
        with open(hash_file, "w") as f:
            f.write("some-hash")
        install_deps.remove_cache(self.tmp)
        self.assertFalse(os.path.exists(hash_file))

    def test_remove_cache_noop_when_no_file(self):
        """AC3: remove_cache does not raise when .deps-hash does not exist."""
        try:
            install_deps.remove_cache(self.tmp)
        except Exception as e:
            self.fail(f"remove_cache raised unexpectedly: {e}")


class TestPipInstallTarget(unittest.TestCase):
    """AC2: pip install --target isolates dependencies."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    @patch("subprocess.run")
    def test_pip_install_uses_target_flag(self, mock_run):
        """AC2: run_pip_install uses --target pointing to pylib dir."""
        mock_run.return_value = MagicMock(returncode=0)
        install_deps.run_pip_install(self.tmp)
        args, kwargs = mock_run.call_args
        cmd = args[0]
        # --target must be present
        self.assertIn("--target", cmd)
        # target value must be pylib inside plugin_data
        target_idx = cmd.index("--target") + 1
        self.assertEqual(cmd[target_idx], os.path.join(self.tmp, "pylib"))

    @patch("subprocess.run")
    def test_pip_install_installs_mcp_and_langfuse(self, mock_run):
        """AC2: run_pip_install installs both mcp and langfuse packages."""
        mock_run.return_value = MagicMock(returncode=0)
        install_deps.run_pip_install(self.tmp)
        args, _ = mock_run.call_args
        cmd = args[0]
        self.assertIn("mcp", cmd)
        self.assertIn("langfuse", cmd)

    @patch("subprocess.run")
    def test_pip_install_returns_true_on_success(self, mock_run):
        """AC2: run_pip_install returns True when pip exits 0."""
        mock_run.return_value = MagicMock(returncode=0)
        result = install_deps.run_pip_install(self.tmp)
        self.assertTrue(result)

    @patch("subprocess.run")
    def test_pip_install_returns_false_on_failure(self, mock_run):
        """AC3: run_pip_install returns False when pip exits non-zero."""
        mock_run.return_value = MagicMock(returncode=1)
        result = install_deps.run_pip_install(self.tmp)
        self.assertFalse(result)

    @patch("subprocess.run")
    def test_pip_stdout_suppressed(self, mock_run):
        """Stdout must be suppressed so pip output doesn't corrupt hook JSON output."""
        mock_run.return_value = MagicMock(returncode=0)
        install_deps.run_pip_install(self.tmp)
        _, kwargs = mock_run.call_args
        # stdout must be redirected away from the hook process stdout
        self.assertIn("stdout", kwargs)
        self.assertNotEqual(kwargs["stdout"], None)  # None means inherit — not allowed

    @patch("subprocess.run")
    def test_pip_stdout_is_devnull_or_pipe(self, mock_run):
        """Stdout must be DEVNULL or PIPE — never inherited (None)."""
        mock_run.return_value = MagicMock(returncode=0)
        install_deps.run_pip_install(self.tmp)
        _, kwargs = mock_run.call_args
        allowed = {subprocess.DEVNULL, subprocess.PIPE}
        self.assertIn(kwargs.get("stdout"), allowed)


class TestFailOpen(unittest.TestCase):
    """AC3: Fail-open on pip failure — exits 0, removes cached hash."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    @patch("src.claude_gates.install_deps.run_pip_install", return_value=False)
    def test_install_fail_removes_cached_hash(self, mock_pip):
        """AC3: If pip fails, .deps-hash is removed so next session retries."""
        # Pre-write a hash file
        hash_file = os.path.join(self.tmp, DEPS_HASH_FILENAME)
        with open(hash_file, "w") as f:
            f.write("some-hash")

        install_deps.run_install(self.tmp, "4.5.0")
        self.assertFalse(os.path.exists(hash_file))

    @patch("src.claude_gates.install_deps.run_pip_install", return_value=True)
    def test_install_success_writes_cache(self, mock_pip):
        """AC3/AC1: If pip succeeds, .deps-hash is written."""
        install_deps.run_install(self.tmp, "4.5.0")
        hash_file = os.path.join(self.tmp, DEPS_HASH_FILENAME)
        self.assertTrue(os.path.exists(hash_file))

    @patch("src.claude_gates.install_deps.run_pip_install", side_effect=Exception("pip exploded"))
    def test_install_exception_does_not_raise(self, mock_pip):
        """AC3: Exception in pip install → fail-open, does not propagate."""
        try:
            install_deps.run_install(self.tmp, "4.5.0")
        except Exception as e:
            self.fail(f"run_install raised unexpectedly: {e}")

    @patch("src.claude_gates.install_deps.run_pip_install", side_effect=Exception("boom"))
    def test_install_exception_removes_cache(self, mock_pip):
        """AC3: Exception in pip install → .deps-hash removed for retry."""
        hash_file = os.path.join(self.tmp, DEPS_HASH_FILENAME)
        with open(hash_file, "w") as f:
            f.write("old")
        install_deps.run_install(self.tmp, "4.5.0")
        self.assertFalse(os.path.exists(hash_file))

    def test_no_plugin_data_skips_install_entirely(self):
        """Edge case: CLAUDE_PLUGIN_DATA not set → skip install, no error."""
        try:
            install_deps.run_install(None, "4.5.0")
        except Exception as e:
            self.fail(f"run_install raised when plugin_data is None: {e}")

    @patch("src.claude_gates.install_deps.run_pip_install", return_value=True)
    def test_cache_hit_skips_pip_install(self, mock_pip):
        """AC1: Cache hit → pip install not called."""
        version = "4.5.0"
        # Pre-write matching hash
        install_deps.write_cache(self.tmp, version)
        install_deps.run_install(self.tmp, version)
        mock_pip.assert_not_called()


class TestPipFallback(unittest.TestCase):
    """Edge case: pip not on PATH — try python3 -m pip as fallback."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    @patch("subprocess.run")
    @patch("shutil.which")
    def test_uses_pip_when_available(self, mock_which, mock_run):
        """pip on PATH → command starts with ['pip', 'install', ...]."""
        mock_which.side_effect = lambda cmd: "/usr/bin/pip" if cmd == "pip" else None
        mock_run.return_value = MagicMock(returncode=0)
        install_deps.run_pip_install(self.tmp)
        args, _ = mock_run.call_args
        cmd = args[0]
        self.assertEqual(cmd[0], "pip")

    @patch("subprocess.run")
    @patch("shutil.which")
    def test_falls_back_to_python3_m_pip_when_pip_not_found(self, mock_which, mock_run):
        """Edge case: pip not on PATH → falls back to python3 -m pip."""
        mock_which.side_effect = lambda cmd: None  # pip not found anywhere
        mock_run.return_value = MagicMock(returncode=0)
        install_deps.run_pip_install(self.tmp)
        args, _ = mock_run.call_args
        cmd = args[0]
        # Should use python3 -m pip
        self.assertEqual(cmd[:3], ["python3", "-m", "pip"])

    @patch("subprocess.run")
    @patch("shutil.which")
    def test_fallback_still_uses_target_flag(self, mock_which, mock_run):
        """Edge case: python3 -m pip fallback still uses --target."""
        mock_which.side_effect = lambda cmd: None
        mock_run.return_value = MagicMock(returncode=0)
        install_deps.run_pip_install(self.tmp)
        args, _ = mock_run.call_args
        cmd = args[0]
        self.assertIn("--target", cmd)


class TestMainEntryPoint(unittest.TestCase):
    """Tests for main() — reads env vars and orchestrates install."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    @patch("src.claude_gates.install_deps.run_install")
    def test_main_reads_plugin_data_from_env(self, mock_run_install):
        """main() reads CLAUDE_PLUGIN_DATA env var and passes to run_install."""
        with patch.dict("os.environ", {"CLAUDE_PLUGIN_DATA": self.tmp,
                                        "CLAUDE_PLUGIN_ROOT": "/fake/root"}):
            # Need a plugin.json to read version from
            with patch("src.claude_gates.install_deps.read_version", return_value="4.5.0"):
                install_deps.main()
        mock_run_install.assert_called_once_with(self.tmp, "4.5.0")

    @patch("src.claude_gates.install_deps.run_install")
    def test_main_skips_when_plugin_data_not_set(self, mock_run_install):
        """main(): CLAUDE_PLUGIN_DATA not set → run_install called with None."""
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLAUDE_PLUGIN_DATA",)}
        with patch.dict("os.environ", env, clear=True):
            with patch("src.claude_gates.install_deps.read_version", return_value="4.5.0"):
                install_deps.main()
        mock_run_install.assert_called_once_with(None, "4.5.0")

    @patch("src.claude_gates.install_deps.run_install", side_effect=Exception("fatal"))
    def test_main_is_fail_open(self, mock_run_install):
        """main() is fail-open — exceptions do not propagate."""
        try:
            with patch("src.claude_gates.install_deps.read_version", return_value="4.5.0"):
                install_deps.main()
        except Exception as e:
            self.fail(f"main() raised unexpectedly: {e}")


if __name__ == "__main__":
    unittest.main()
