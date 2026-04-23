"""
Tests for scripts/WebServer.py — direct WebServer entry script (Task 23).

Acceptance criteria (spec.md):
AC1: sys.path setup identical to McpServer.py
     - {CLAUDE_PLUGIN_ROOT}/src in sys.path when env set
     - Falls back to two levels above script when CLAUDE_PLUGIN_ROOT absent
     - {CLAUDE_PLUGIN_DATA}/pylib in sys.path when CLAUDE_PLUGIN_DATA set
     - pylib NOT inserted when CLAUDE_PLUGIN_DATA absent
AC2: Exit code 1 on fatal startup error (web_server.main() raises OSError)
Edge: Falls back to script directory when CLAUDE_PLUGIN_ROOT not set
"""
import io
import os
import sys
import types
import unittest
from unittest.mock import patch

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SCRIPT_PATH = os.path.join(_PROJECT_ROOT, "scripts", "WebServer.py")


def _exec_script(env=None, extra_sys_modules=None, main_side_effect=None):
    """
    Execute scripts/WebServer.py in isolation.

    - env: complete environment dict (replaces os.environ entirely).
    - extra_sys_modules: dict of module_name -> mock to inject before exec.
    - main_side_effect: if set, the mock main() raises this exception.

    Returns (path_snapshot, stderr_text, exit_code).
    exit_code is None if sys.exit was not called.
    """
    with open(_SCRIPT_PATH, "r", encoding="utf-8") as fh:
        source = fh.read()

    fake_stderr = io.StringIO()
    exit_calls = []
    orig_path = sys.path[:]

    def fake_exit(code):
        exit_calls.append(code)
        raise SystemExit(code)

    exec_env = env if env is not None else {}

    # Build a mock web_server module with a controllable main()
    mock_main_calls = []

    def mock_main():
        mock_main_calls.append(1)
        if main_side_effect is not None:
            raise main_side_effect

    mock_web_server_mod = types.ModuleType("claude_gates.web_server")
    mock_web_server_mod.main = mock_main

    mock_claude_gates_pkg = types.ModuleType("claude_gates")
    mock_claude_gates_pkg.web_server = mock_web_server_mod

    default_modules = {
        "claude_gates": mock_claude_gates_pkg,
        "claude_gates.web_server": mock_web_server_mod,
    }
    if extra_sys_modules:
        default_modules.update(extra_sys_modules)

    import contextlib
    try:
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch("sys.stderr", fake_stderr))
            stack.enter_context(patch("sys.exit", side_effect=fake_exit))
            stack.enter_context(patch.dict("os.environ", exec_env, clear=True))
            stack.enter_context(patch.dict("sys.modules", default_modules))
            try:
                exec(compile(source, _SCRIPT_PATH, "exec"), {"__file__": _SCRIPT_PATH})
            except SystemExit:
                pass
    finally:
        pass

    path_snapshot = list(sys.path)
    sys.path[:] = orig_path

    exit_code = exit_calls[0] if exit_calls else None
    return path_snapshot, fake_stderr.getvalue(), exit_code, mock_main_calls


# ---------------------------------------------------------------------------
# AC1: sys.path setup identical to McpServer.py
# ---------------------------------------------------------------------------

class TestWebServerSysPath(unittest.TestCase):
    """AC1: sys.path setup matches McpServer.py pattern."""

    def test_plugin_root_src_inserted_when_env_set(self):
        """AC1: CLAUDE_PLUGIN_ROOT set → {CLAUDE_PLUGIN_ROOT}/src in sys.path."""
        path, _, _, _ = _exec_script(env={"CLAUDE_PLUGIN_ROOT": "/fake/root"})
        expected = os.path.join("/fake/root", "src")
        self.assertIn(expected, path)

    def test_fallback_two_levels_up_when_no_env(self):
        """AC1 edge: No CLAUDE_PLUGIN_ROOT → falls back to two levels above script file.

        The script is at scripts/WebServer.py:
          dirname(scripts/WebServer.py)   = scripts/
          dirname(scripts/)               = project_root/
        So plugin_root = project_root, src_path = project_root/src.
        """
        path, _, _, _ = _exec_script(env={})
        expected_fallback_src = os.path.join(_PROJECT_ROOT, "src")
        self.assertIn(expected_fallback_src, path)

    def test_plugin_data_pylib_inserted_when_env_set(self):
        """AC1: CLAUDE_PLUGIN_DATA set → {CLAUDE_PLUGIN_DATA}/pylib in sys.path."""
        path, _, _, _ = _exec_script(
            env={
                "CLAUDE_PLUGIN_ROOT": "/fake/root",
                "CLAUDE_PLUGIN_DATA": "/fake/data",
            }
        )
        expected = os.path.join("/fake/data", "pylib")
        self.assertIn(expected, path)

    def test_plugin_data_not_set_no_pylib_inserted(self):
        """AC1: CLAUDE_PLUGIN_DATA absent → pylib NOT added to sys.path."""
        path, _, _, _ = _exec_script(env={"CLAUDE_PLUGIN_ROOT": "/fake/root"})
        self.assertNotIn(os.path.join("/fake/data", "pylib"), path)

    def test_src_path_not_duplicated_when_already_present(self):
        """AC1: src_path not inserted twice if already in sys.path."""
        src_path = os.path.join("/fake/root", "src")
        orig_path = sys.path[:]
        sys.path.insert(0, src_path)
        try:
            path, _, _, _ = _exec_script(env={"CLAUDE_PLUGIN_ROOT": "/fake/root"})
            self.assertEqual(path.count(src_path), 1)
        finally:
            sys.path[:] = orig_path


# ---------------------------------------------------------------------------
# AC2: Exit code 1 on fatal startup error
# ---------------------------------------------------------------------------

class TestWebServerFatalError(unittest.TestCase):
    """AC2: web_server.main() raises OSError → exits 1."""

    def test_oserror_exits_1(self):
        """AC2: OSError from main() (e.g., port in use) → sys.exit(1)."""
        _, _, exit_code, _ = _exec_script(
            env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT},
            main_side_effect=OSError("address already in use"),
        )
        self.assertEqual(exit_code, 1)

    def test_oserror_not_exit_0(self):
        """AC2: exit code is not 0 — detached process must signal failure."""
        _, _, exit_code, _ = _exec_script(
            env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT},
            main_side_effect=OSError("port in use"),
        )
        self.assertNotEqual(exit_code, 0)


# ---------------------------------------------------------------------------
# Script calls web_server.main()
# ---------------------------------------------------------------------------

class TestWebServerCallsMain(unittest.TestCase):
    """Script calls web_server.main() on successful import."""

    def test_main_is_called_on_success(self):
        """main() from claude_gates.web_server is called when import succeeds."""
        _, _, _, call_log = _exec_script(env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT})
        self.assertEqual(len(call_log), 1)

    def test_main_called_exactly_once(self):
        """main() is called exactly once per script execution."""
        _, _, _, call_log = _exec_script(env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT})
        self.assertEqual(len(call_log), 1)

    def test_no_exit_on_success(self):
        """No sys.exit call when main() completes normally."""
        _, _, exit_code, _ = _exec_script(env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT})
        self.assertIsNone(exit_code)


if __name__ == "__main__":
    unittest.main()
