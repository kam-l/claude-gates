"""
Tests for hook_runner.py — shared hook entry point.

Acceptance criteria (spec.md):
1. Catch BaseException for full fail-open
2. Log exceptions to stderr
3. Binary stdin read
4. Exactly one stdout write + flush
5. sys.path setup
"""
import io
import json
import os
import sys
import traceback
import unittest
from unittest.mock import MagicMock, patch, call


# Ensure src/claude_gates is importable
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates import hook_runner


class TestHookRunnerFailOpen(unittest.TestCase):
    """AC1 + AC2: BaseException catch, stderr logging, exits 0."""

    def _run_with_stdin(self, handler, stdin_bytes=b"{}"):
        """Helper: patch stdin/stdout/stderr and call run(handler)."""
        fake_stdin = MagicMock()
        fake_stdin.buffer.read.return_value = stdin_bytes

        fake_stdout = io.StringIO()
        fake_stderr = io.StringIO()

        with patch("sys.stdin", fake_stdin), \
             patch("sys.stdout", fake_stdout), \
             patch("sys.stderr", fake_stderr), \
             patch("sys.exit") as mock_exit:
            hook_runner.run(handler)

        return fake_stdout.getvalue(), fake_stderr.getvalue(), mock_exit

    def test_handler_raising_exception_writes_empty_dict(self):
        """AC1: Exception in handler → writes {} to stdout."""
        def bad_handler(data):
            raise ValueError("boom")

        stdout, _, _ = self._run_with_stdin(bad_handler)
        self.assertEqual(json.loads(stdout), {})

    def test_handler_raising_keyboard_interrupt_writes_empty_dict(self):
        """AC1: KeyboardInterrupt (BaseException) → writes {} and exits 0."""
        def ki_handler(data):
            raise KeyboardInterrupt()

        stdout, _, mock_exit = self._run_with_stdin(ki_handler)
        self.assertEqual(json.loads(stdout), {})
        mock_exit.assert_called_once_with(0)

    def test_handler_raising_system_exit_writes_empty_dict(self):
        """AC1: SystemExit (BaseException) → writes {} and exits 0."""
        def se_handler(data):
            raise SystemExit(1)

        stdout, _, mock_exit = self._run_with_stdin(se_handler)
        self.assertEqual(json.loads(stdout), {})
        mock_exit.assert_called_once_with(0)

    def test_exception_traceback_written_to_stderr(self):
        """AC2: traceback.print_exc() called on exception → appears in stderr."""
        def bad_handler(data):
            raise RuntimeError("test error for stderr")

        _, stderr, _ = self._run_with_stdin(bad_handler)
        self.assertIn("RuntimeError", stderr)
        self.assertIn("test error for stderr", stderr)

    def test_exception_stderr_before_stdout(self):
        """AC2: stderr traceback written before stdout {}. Both must be present."""
        def bad_handler(data):
            raise ValueError("ordering check")

        stdout, stderr, _ = self._run_with_stdin(bad_handler)
        self.assertEqual(json.loads(stdout), {})
        self.assertIn("ValueError", stderr)


class TestHookRunnerStdinReading(unittest.TestCase):
    """AC3: Binary stdin read via sys.stdin.buffer.read().decode('utf-8')."""

    def test_binary_stdin_buffer_read_used(self):
        """AC3: run() calls sys.stdin.buffer.read(), not sys.stdin.read()."""
        fake_stdin = MagicMock()
        fake_stdin.buffer.read.return_value = b'{"key": "value"}'

        received = {}

        def capture_handler(data):
            received.update(data)
            return data

        fake_stdout = io.StringIO()

        with patch("sys.stdin", fake_stdin), \
             patch("sys.stdout", fake_stdout), \
             patch("sys.exit"):
            hook_runner.run(capture_handler)

        fake_stdin.buffer.read.assert_called_once()
        # sys.stdin.read() (text mode) must NOT be called
        fake_stdin.read.assert_not_called()
        self.assertEqual(received, {"key": "value"})

    def test_crlf_preserved_in_values(self):
        """AC3: Windows CRLF in JSON string values preserved (no text-mode translation)."""
        payload = json.dumps({"content": "line1\r\nline2"}).encode("utf-8")
        fake_stdin = MagicMock()
        fake_stdin.buffer.read.return_value = payload

        received = {}

        def capture_handler(data):
            received.update(data)
            return data

        fake_stdout = io.StringIO()

        with patch("sys.stdin", fake_stdin), \
             patch("sys.stdout", fake_stdout), \
             patch("sys.exit"):
            hook_runner.run(capture_handler)

        self.assertEqual(received["content"], "line1\r\nline2")


class TestHookRunnerStdoutWrite(unittest.TestCase):
    """AC4: Exactly one write + flush. Handler None → {}."""

    def test_successful_handler_result_written_once(self):
        """AC4: Handler returns dict → written exactly once to stdout."""
        fake_stdin = MagicMock()
        fake_stdin.buffer.read.return_value = b"{}"

        write_calls = []
        flush_calls = []

        class TrackingStringIO(io.StringIO):
            def write(self, s):
                write_calls.append(s)
                return super().write(s)
            def flush(self):
                flush_calls.append(True)
                return super().flush()

        fake_stdout = TrackingStringIO()

        def good_handler(data):
            return {"status": "ok"}

        with patch("sys.stdin", fake_stdin), \
             patch("sys.stdout", fake_stdout), \
             patch("sys.exit"):
            hook_runner.run(good_handler)

        self.assertEqual(len(write_calls), 1)
        self.assertGreaterEqual(len(flush_calls), 1)
        self.assertEqual(json.loads(write_calls[0]), {"status": "ok"})

    def test_handler_returning_none_writes_empty_dict(self):
        """AC4: Handler returns None → writes {}."""
        fake_stdin = MagicMock()
        fake_stdin.buffer.read.return_value = b"{}"
        fake_stdout = io.StringIO()

        def none_handler(data):
            return None

        with patch("sys.stdin", fake_stdin), \
             patch("sys.stdout", fake_stdout), \
             patch("sys.exit"):
            hook_runner.run(none_handler)

        self.assertEqual(json.loads(fake_stdout.getvalue()), {})

    def test_handler_returning_non_dict_coerced_to_empty_dict(self):
        """Edge case: handler returns non-dict (string, list) → coerce to {}."""
        fake_stdin = MagicMock()
        fake_stdin.buffer.read.return_value = b"{}"
        fake_stdout = io.StringIO()

        def list_handler(data):
            return ["not", "a", "dict"]

        with patch("sys.stdin", fake_stdin), \
             patch("sys.stdout", fake_stdout), \
             patch("sys.exit"):
            hook_runner.run(list_handler)

        self.assertEqual(json.loads(fake_stdout.getvalue()), {})

    def test_always_exits_0(self):
        """AC1/AC4: sys.exit(0) called on every execution path."""
        fake_stdin = MagicMock()
        fake_stdin.buffer.read.return_value = b"{}"
        fake_stdout = io.StringIO()

        def good_handler(data):
            return {"ok": True}

        with patch("sys.stdin", fake_stdin), \
             patch("sys.stdout", fake_stdout), \
             patch("sys.exit") as mock_exit:
            hook_runner.run(good_handler)

        mock_exit.assert_called_once_with(0)

    def test_empty_stdin_treated_as_empty_dict(self):
        """Edge case: 0 bytes stdin → handler called with {} (no crash)."""
        fake_stdin = MagicMock()
        fake_stdin.buffer.read.return_value = b""
        fake_stdout = io.StringIO()

        received = {}

        def capture_handler(data):
            received.update(data)
            return data

        with patch("sys.stdin", fake_stdin), \
             patch("sys.stdout", fake_stdout), \
             patch("sys.exit"):
            hook_runner.run(capture_handler)

        self.assertEqual(received, {})
        self.assertEqual(json.loads(fake_stdout.getvalue()), {})


class TestHookRunnerSysPath(unittest.TestCase):
    """AC5: sys.path setup for CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA."""

    def _run_minimal(self, env_vars, stdin_bytes=b"{}"):
        """Run with patched env, return sys.path state observed inside handler."""
        path_snapshot = []

        def path_capture_handler(data):
            path_snapshot.extend(sys.path[:])
            return {}

        fake_stdin = MagicMock()
        fake_stdin.buffer.read.return_value = stdin_bytes
        fake_stdout = io.StringIO()

        original_path = sys.path[:]
        with patch("sys.stdin", fake_stdin), \
             patch("sys.stdout", fake_stdout), \
             patch("sys.exit"), \
             patch.dict("os.environ", env_vars, clear=False):
            hook_runner.run(path_capture_handler)

        return path_snapshot

    def test_plugin_root_src_inserted_when_env_set(self):
        """AC5: CLAUDE_PLUGIN_ROOT set → {CLAUDE_PLUGIN_ROOT}/src in sys.path."""
        path = self._run_minimal({"CLAUDE_PLUGIN_ROOT": "/fake/root"})
        expected = os.path.join("/fake/root", "src")
        self.assertIn(expected, path)

    def test_plugin_data_pylib_inserted_when_env_set(self):
        """AC5: CLAUDE_PLUGIN_DATA set → {CLAUDE_PLUGIN_DATA}/pylib in sys.path."""
        path = self._run_minimal({
            "CLAUDE_PLUGIN_ROOT": "/fake/root",
            "CLAUDE_PLUGIN_DATA": "/fake/data",
        })
        expected = os.path.join("/fake/data", "pylib")
        self.assertIn(expected, path)

    def test_plugin_data_not_set_no_error(self):
        """Edge case: CLAUDE_PLUGIN_DATA not set → skip pylib, no error."""
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PLUGIN_DATA"}
        fake_stdin = MagicMock()
        fake_stdin.buffer.read.return_value = b"{}"
        fake_stdout = io.StringIO()

        try:
            with patch("sys.stdin", fake_stdin), \
                 patch("sys.stdout", fake_stdout), \
                 patch("sys.exit"), \
                 patch.dict("os.environ", env, clear=True):
                hook_runner.run(lambda data: {})
        except Exception as e:
            self.fail(f"run() raised unexpected exception when CLAUDE_PLUGIN_DATA missing: {e}")


if __name__ == "__main__":
    unittest.main()
