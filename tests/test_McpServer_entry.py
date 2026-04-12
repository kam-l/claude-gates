"""
Tests for scripts/McpServer.py — direct MCP server entry script.

Acceptance criteria (spec.md):
1. sys.path setup matches hook_runner pattern
2. Graceful ImportError handling (prints to stderr, exits 1)
3. Exit codes matter (unlike hooks) — fatal error exits 1
"""
import io
import os
import sys
import types
import unittest
from unittest.mock import patch

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SCRIPT_PATH = os.path.join(_PROJECT_ROOT, "scripts", "McpServer.py")


def _exec_script(env_overrides=None, extra_sys_modules=None, force_import_error=False):
    """
    Execute scripts/McpServer.py in isolation.

    - env_overrides: dict of env vars to override (merged with os.environ)
    - extra_sys_modules: dict of module_name -> mock to inject before exec
      (useful to intercept 'claude_gates.mcp_server' before the import fires)
    - force_import_error: if True, monkey-patches builtins.__import__ to raise
      ImportError when 'claude_gates.mcp_server' is imported

    Returns (path_snapshot, stderr_text, exit_code).
    exit_code is None if sys.exit was not called.
    """
    import builtins

    with open(_SCRIPT_PATH, "r", encoding="utf-8") as fh:
        source = fh.read()

    fake_stderr = io.StringIO()
    exit_calls = []
    orig_path = sys.path[:]

    def fake_exit(code):
        exit_calls.append(code)
        raise SystemExit(code)

    env = dict(os.environ)
    if env_overrides:
        env.update(env_overrides)

    modules_to_inject = extra_sys_modules or {}

    real_import = builtins.__import__

    def import_raising_error(name, *args, **kwargs):
        if force_import_error and "mcp_server" in name:
            raise ImportError("No module named 'mcp'")
        return real_import(name, *args, **kwargs)

    ctx_managers = [
        patch("sys.stderr", fake_stderr),
        patch("sys.exit", side_effect=fake_exit),
        patch.dict("os.environ", env, clear=True),
        patch.dict("sys.modules", modules_to_inject),
    ]
    if force_import_error:
        ctx_managers.append(patch("builtins.__import__", side_effect=import_raising_error))

    import contextlib
    with contextlib.ExitStack() as stack:
        for cm in ctx_managers:
            stack.enter_context(cm)
        try:
            exec(compile(source, _SCRIPT_PATH, "exec"), {"__file__": _SCRIPT_PATH})
        except SystemExit:
            pass

    path_snapshot = list(sys.path)
    sys.path[:] = orig_path

    exit_code = exit_calls[0] if exit_calls else None
    return path_snapshot, fake_stderr.getvalue(), exit_code


def _make_mock_mcp_server_module():
    """Create a fake claude_gates.mcp_server module with a no-op main()."""
    mod = types.ModuleType("claude_gates.mcp_server")
    mod.main = lambda: None
    return mod


def _make_mock_claude_gates_package():
    """Create a fake claude_gates package."""
    pkg = types.ModuleType("claude_gates")
    return pkg


class TestMcpServerSysPath(unittest.TestCase):
    """AC1: sys.path setup matches hook_runner pattern."""

    def _run_with_mocked_main(self, env_overrides):
        """Run with no-op mcp_server.main to avoid real MCP startup."""
        mock_mod = _make_mock_mcp_server_module()
        mock_pkg = _make_mock_claude_gates_package()
        mock_pkg.mcp_server = mock_mod
        return _exec_script(
            env_overrides=env_overrides,
            extra_sys_modules={
                "claude_gates": mock_pkg,
                "claude_gates.mcp_server": mock_mod,
            },
        )

    def test_plugin_root_src_inserted_when_env_set(self):
        """AC1: CLAUDE_PLUGIN_ROOT set → {CLAUDE_PLUGIN_ROOT}/src in sys.path."""
        path, _, _ = self._run_with_mocked_main(
            {"CLAUDE_PLUGIN_ROOT": "/fake/root"}
        )
        expected = os.path.join("/fake/root", "src")
        self.assertIn(expected, path)

    def test_fallback_two_levels_up_when_no_env(self):
        """AC1: No CLAUDE_PLUGIN_ROOT → falls back to two levels above script file."""
        # scripts/McpServer.py is one level below project root,
        # two levels up from __file__ gives project root → project_root/src
        env_without_root = {k: v for k, v in os.environ.items()
                            if k not in ("CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA")}
        path, _, _ = self._run_with_mocked_main(env_without_root)
        expected_fallback_src = os.path.join(_PROJECT_ROOT, "src")
        self.assertIn(expected_fallback_src, path)

    def test_plugin_data_pylib_inserted_when_env_set(self):
        """AC1: CLAUDE_PLUGIN_DATA set → {CLAUDE_PLUGIN_DATA}/pylib in sys.path."""
        path, _, _ = self._run_with_mocked_main({
            "CLAUDE_PLUGIN_ROOT": "/fake/root",
            "CLAUDE_PLUGIN_DATA": "/fake/data",
        })
        expected = os.path.join("/fake/data", "pylib")
        self.assertIn(expected, path)

    def test_plugin_data_not_set_no_pylib_inserted(self):
        """AC1: CLAUDE_PLUGIN_DATA not set → pylib NOT added to sys.path."""
        env_without_data = {k: v for k, v in os.environ.items()
                            if k != "CLAUDE_PLUGIN_DATA"}
        env_without_data["CLAUDE_PLUGIN_ROOT"] = "/fake/root"
        path, _, _ = self._run_with_mocked_main(env_without_data)
        self.assertNotIn(os.path.join("/fake/data", "pylib"), path)


class TestMcpServerImportError(unittest.TestCase):
    """AC2: ImportError from missing 'mcp' package → stderr message + exit 1."""

    def _run_with_import_error(self):
        """
        Force ImportError on claude_gates.mcp_server import via builtins.__import__
        patching. This simulates the 'mcp' package not being installed.
        """
        return _exec_script(
            env_overrides={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT},
            force_import_error=True,
        )

    def test_import_error_prints_message_to_stderr(self):
        """AC2: ImportError → prints message containing '[ClaudeGates]' to stderr."""
        _, stderr, _ = self._run_with_import_error()
        self.assertIn("[ClaudeGates]", stderr)

    def test_import_error_stderr_message_exact(self):
        """AC2: stderr message is the exact specified text."""
        _, stderr, _ = self._run_with_import_error()
        expected_msg = "[ClaudeGates] MCP server requires 'mcp' package. Run pip install."
        self.assertIn(expected_msg, stderr)

    def test_import_error_exits_1(self):
        """AC2+AC3: ImportError → exits with code 1 (not 0, unlike hooks)."""
        _, _, exit_code = self._run_with_import_error()
        self.assertEqual(exit_code, 1)


class TestMcpServerCallsMain(unittest.TestCase):
    """AC3: Script calls mcp_server.main() on successful import."""

    def test_main_is_called_on_success(self):
        """main() from claude_gates.mcp_server is called when import succeeds."""
        call_log = []

        mock_mod = types.ModuleType("claude_gates.mcp_server")
        mock_mod.main = lambda: call_log.append("called")
        mock_pkg = _make_mock_claude_gates_package()
        mock_pkg.mcp_server = mock_mod

        _exec_script(
            env_overrides={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT},
            extra_sys_modules={
                "claude_gates": mock_pkg,
                "claude_gates.mcp_server": mock_mod,
            },
        )
        self.assertEqual(call_log, ["called"])


if __name__ == "__main__":
    unittest.main()
