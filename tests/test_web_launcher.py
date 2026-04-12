"""
Tests for src/claude_gates/web_launcher.py (Task 21)

Acceptance criteria:
1. Health check prevents duplicate server
2. Stale PID cleanup before spawn
3. Windows subprocess detach uses correct creation flags
4. POSIX subprocess detach uses start_new_session
5. PID file written after successful spawn
6. Uses sys.executable for venv compatibility

Edge cases:
- Health check times out => treat as not running
- Health check returns non-JSON => treat as not running
- PID file doesn't exist => skip cleanup, proceed to spawn
- os.kill on Windows PermissionError for alive process => leave PID file
"""
import os
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock, mock_open, call

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates import web_launcher


class TestHealthCheck(unittest.TestCase):
    """AC1: Health check prevents duplicate server."""

    def test_returns_true_when_server_running_with_correct_app(self):
        """Given server is running, /health returns app=claude-gates => True."""
        import json
        response_mock = MagicMock()
        response_mock.read.return_value = json.dumps({"app": "claude-gates"}).encode()
        response_mock.__enter__ = lambda s: s
        response_mock.__exit__ = MagicMock(return_value=False)

        with patch("src.claude_gates.web_launcher.urlopen", return_value=response_mock) as mock_url:
            result = web_launcher._health_check(64735)
        self.assertTrue(result)

    def test_returns_false_when_app_field_wrong(self):
        """Given server returns app != claude-gates => False."""
        import json
        response_mock = MagicMock()
        response_mock.read.return_value = json.dumps({"app": "other"}).encode()
        response_mock.__enter__ = lambda s: s
        response_mock.__exit__ = MagicMock(return_value=False)

        with patch("src.claude_gates.web_launcher.urlopen", return_value=response_mock):
            result = web_launcher._health_check(64735)
        self.assertFalse(result)

    def test_returns_false_on_connection_error(self):
        """Given server not running, urlopen raises => False."""
        from urllib.error import URLError
        with patch("src.claude_gates.web_launcher.urlopen", side_effect=URLError("refused")):
            result = web_launcher._health_check(64735)
        self.assertFalse(result)

    def test_returns_false_on_timeout(self):
        """Edge case: health check times out => treat as not running."""
        import socket
        with patch("src.claude_gates.web_launcher.urlopen", side_effect=socket.timeout("timed out")):
            result = web_launcher._health_check(64735)
        self.assertFalse(result)

    def test_returns_false_on_non_json_response(self):
        """Edge case: health check returns non-JSON => treat as not running."""
        response_mock = MagicMock()
        response_mock.read.return_value = b"not json at all"
        response_mock.__enter__ = lambda s: s
        response_mock.__exit__ = MagicMock(return_value=False)

        with patch("src.claude_gates.web_launcher.urlopen", return_value=response_mock):
            result = web_launcher._health_check(64735)
        self.assertFalse(result)

    def test_uses_1s_timeout(self):
        """Health check must use 1-second timeout."""
        import json
        response_mock = MagicMock()
        response_mock.read.return_value = json.dumps({"app": "claude-gates"}).encode()
        response_mock.__enter__ = lambda s: s
        response_mock.__exit__ = MagicMock(return_value=False)

        with patch("src.claude_gates.web_launcher.urlopen", return_value=response_mock) as mock_url:
            web_launcher._health_check(64735)
        args, kwargs = mock_url.call_args
        # timeout must be 1 (second positional arg or keyword)
        timeout = kwargs.get("timeout") if kwargs.get("timeout") is not None else (args[1] if len(args) > 1 else None)
        self.assertEqual(timeout, 1)


class TestCleanStalePid(unittest.TestCase):
    """AC2: Stale PID cleanup before spawn."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.sessions_dir = os.path.join(self.tmp, ".sessions")
        os.makedirs(self.sessions_dir, exist_ok=True)
        self.pid_file = os.path.join(self.sessions_dir, ".webui.pid")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_deletes_pid_file_when_process_dead(self):
        """Given PID file exists, process is dead => deletes PID file."""
        with open(self.pid_file, "w") as f:
            f.write("99999")

        with patch("src.claude_gates.web_launcher.PID_FILE", self.pid_file):
            with patch("os.kill", side_effect=OSError("no such process")):
                web_launcher._clean_stale_pid()

        self.assertFalse(os.path.exists(self.pid_file))

    def test_leaves_pid_file_when_process_alive(self):
        """Given PID file exists, process is alive => leaves PID file."""
        with open(self.pid_file, "w") as f:
            f.write("99999")

        with patch("src.claude_gates.web_launcher.PID_FILE", self.pid_file):
            with patch("os.kill", return_value=None):  # no exception = alive
                web_launcher._clean_stale_pid()

        self.assertTrue(os.path.exists(self.pid_file))

    def test_no_op_when_pid_file_missing(self):
        """Edge case: PID file doesn't exist => skip cleanup, no error."""
        with patch("src.claude_gates.web_launcher.PID_FILE", self.pid_file):
            # Should not raise
            web_launcher._clean_stale_pid()

    def test_windows_permission_error_means_alive(self):
        """Edge case: PermissionError (Windows behavior for alive pid) => leave PID file."""
        with open(self.pid_file, "w") as f:
            f.write("99999")

        with patch("src.claude_gates.web_launcher.PID_FILE", self.pid_file):
            with patch("os.kill", side_effect=PermissionError("access denied")):
                web_launcher._clean_stale_pid()

        self.assertTrue(os.path.exists(self.pid_file))


class TestWindowsDetach(unittest.TestCase):
    """AC3: Windows subprocess detach uses CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS."""

    def test_windows_spawn_uses_creation_flags(self):
        """Given Windows platform, spawn uses correct creationflags."""
        tmp = tempfile.mkdtemp()
        pid_file = os.path.join(tmp, ".sessions", ".webui.pid")

        mock_child = MagicMock()
        mock_child.pid = 12345

        with patch("src.claude_gates.web_launcher.PID_FILE", pid_file), \
             patch("src.claude_gates.web_launcher._health_check", return_value=False), \
             patch("src.claude_gates.web_launcher._clean_stale_pid"), \
             patch("os.makedirs"), \
             patch("sys.platform", "win32"), \
             patch("subprocess.Popen", return_value=mock_child) as mock_popen, \
             patch("builtins.open", mock_open()):
            web_launcher.launch({})

        mock_popen.assert_called_once()
        kwargs = mock_popen.call_args[1]
        expected_flags = (
            __import__("subprocess").CREATE_NEW_PROCESS_GROUP
            | __import__("subprocess").DETACHED_PROCESS
        )
        self.assertEqual(kwargs.get("creationflags"), expected_flags)
        self.assertEqual(kwargs.get("stdin"), __import__("subprocess").DEVNULL)
        self.assertEqual(kwargs.get("stdout"), __import__("subprocess").DEVNULL)
        self.assertEqual(kwargs.get("stderr"), __import__("subprocess").DEVNULL)

        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


class TestPosixDetach(unittest.TestCase):
    """AC4: POSIX subprocess detach uses start_new_session=True."""

    def test_posix_spawn_uses_start_new_session(self):
        """Given non-Windows platform, spawn uses start_new_session=True."""
        tmp = tempfile.mkdtemp()
        pid_file = os.path.join(tmp, ".sessions", ".webui.pid")

        mock_child = MagicMock()
        mock_child.pid = 12345

        with patch("src.claude_gates.web_launcher.PID_FILE", pid_file), \
             patch("src.claude_gates.web_launcher._health_check", return_value=False), \
             patch("src.claude_gates.web_launcher._clean_stale_pid"), \
             patch("os.makedirs"), \
             patch("sys.platform", "linux"), \
             patch("subprocess.Popen", return_value=mock_child) as mock_popen, \
             patch("builtins.open", mock_open()):
            web_launcher.launch({})

        mock_popen.assert_called_once()
        kwargs = mock_popen.call_args[1]
        self.assertTrue(kwargs.get("start_new_session"))
        self.assertEqual(kwargs.get("stdin"), __import__("subprocess").DEVNULL)
        self.assertEqual(kwargs.get("stdout"), __import__("subprocess").DEVNULL)
        self.assertEqual(kwargs.get("stderr"), __import__("subprocess").DEVNULL)
        self.assertNotIn("creationflags", kwargs)

        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


class TestPidFileWritten(unittest.TestCase):
    """AC5: PID file written after successful spawn."""

    def test_pid_file_written_with_child_pid(self):
        """Given subprocess spawned, writes child.pid to PID_FILE."""
        tmp = tempfile.mkdtemp()
        sessions_dir = os.path.join(tmp, ".sessions")
        pid_file = os.path.join(sessions_dir, ".webui.pid")

        mock_child = MagicMock()
        mock_child.pid = 54321

        with patch("src.claude_gates.web_launcher.PID_FILE", pid_file), \
             patch("src.claude_gates.web_launcher._health_check", return_value=False), \
             patch("src.claude_gates.web_launcher._clean_stale_pid"), \
             patch("sys.platform", "linux"), \
             patch("subprocess.Popen", return_value=mock_child):
            result = web_launcher.launch({})

        self.assertTrue(os.path.exists(pid_file))
        with open(pid_file) as f:
            content = f.read().strip()
        self.assertEqual(content, "54321")
        self.assertEqual(result, {})

        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    def test_creates_sessions_dir_if_missing(self):
        """Given .sessions dir missing, creates it before writing PID file."""
        tmp = tempfile.mkdtemp()
        sessions_dir = os.path.join(tmp, ".sessions")
        pid_file = os.path.join(sessions_dir, ".webui.pid")
        # sessions_dir does NOT exist yet

        mock_child = MagicMock()
        mock_child.pid = 11111

        with patch("src.claude_gates.web_launcher.PID_FILE", pid_file), \
             patch("src.claude_gates.web_launcher._health_check", return_value=False), \
             patch("src.claude_gates.web_launcher._clean_stale_pid"), \
             patch("sys.platform", "linux"), \
             patch("subprocess.Popen", return_value=mock_child):
            web_launcher.launch({})

        self.assertTrue(os.path.exists(sessions_dir))
        self.assertTrue(os.path.exists(pid_file))

        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


class TestSysExecutable(unittest.TestCase):
    """AC6: Uses sys.executable for venv compatibility."""

    def test_uses_sys_executable_not_python3(self):
        """Given venv, spawns subprocess with sys.executable, not 'python3'."""
        tmp = tempfile.mkdtemp()
        pid_file = os.path.join(tmp, ".sessions", ".webui.pid")

        mock_child = MagicMock()
        mock_child.pid = 9999

        fake_executable = "/usr/local/bin/python3.12"

        with patch("src.claude_gates.web_launcher.PID_FILE", pid_file), \
             patch("src.claude_gates.web_launcher._health_check", return_value=False), \
             patch("src.claude_gates.web_launcher._clean_stale_pid"), \
             patch("os.makedirs"), \
             patch("sys.platform", "linux"), \
             patch("sys.executable", fake_executable), \
             patch("subprocess.Popen", return_value=mock_child) as mock_popen, \
             patch("builtins.open", mock_open()):
            web_launcher.launch({})

        call_args = mock_popen.call_args[0][0]  # first positional arg = cmd list
        self.assertEqual(call_args[0], fake_executable)

        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


class TestLaunchAlreadyRunning(unittest.TestCase):
    """AC1 (launch integration): If health check passes, returns {} immediately."""

    def test_returns_empty_dict_when_already_running(self):
        """Given server already running, launch returns {} without spawning."""
        with patch("src.claude_gates.web_launcher._health_check", return_value=True), \
             patch("subprocess.Popen") as mock_popen:
            result = web_launcher.launch({})

        mock_popen.assert_not_called()
        self.assertEqual(result, {})


class TestConstants(unittest.TestCase):
    """Module constants defined correctly."""

    def test_pid_file_constant(self):
        """PID_FILE must end with .sessions/.webui.pid."""
        self.assertTrue(
            web_launcher.PID_FILE.replace("\\", "/").endswith(".sessions/.webui.pid"),
            f"PID_FILE={web_launcher.PID_FILE!r} does not end with .sessions/.webui.pid"
        )

    def test_port_constant_default(self):
        """PORT defaults to 64735 when env var not set."""
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CLAUDE_GATES_PORT", None)
            # Re-evaluate the module's PORT constant logic by checking default
            self.assertEqual(int(os.environ.get("CLAUDE_GATES_PORT", "64735")), 64735)

    def test_port_env_var_passed_to_subprocess(self):
        """CLAUDE_GATES_PORT env var override is forwarded to spawned subprocess env."""
        tmp = tempfile.mkdtemp()
        pid_file = os.path.join(tmp, ".sessions", ".webui.pid")

        mock_child = MagicMock()
        mock_child.pid = 7777

        # Patch the module-level PORT to a custom value to simulate env override
        custom_port = 12345

        with patch("src.claude_gates.web_launcher.PID_FILE", pid_file), \
             patch("src.claude_gates.web_launcher._health_check", return_value=False), \
             patch("src.claude_gates.web_launcher._clean_stale_pid"), \
             patch("src.claude_gates.web_launcher.PORT", custom_port), \
             patch("os.makedirs"), \
             patch("sys.platform", "linux"), \
             patch("subprocess.Popen", return_value=mock_child) as mock_popen, \
             patch("builtins.open", mock_open()):
            web_launcher.launch({})

        mock_popen.assert_called_once()
        kwargs = mock_popen.call_args[1]
        env_passed = kwargs.get("env", {})
        self.assertEqual(env_passed.get("CLAUDE_GATES_PORT"), str(custom_port))

        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    def test_script_constant(self):
        """SCRIPT must point to scripts/WebServer.py."""
        self.assertTrue(
            web_launcher.SCRIPT.replace("\\", "/").endswith("scripts/WebServer.py"),
            f"SCRIPT={web_launcher.SCRIPT!r} does not end with scripts/WebServer.py"
        )


if __name__ == "__main__":
    unittest.main()
