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


def _exec_script(env=None, extra_sys_modules=None, force_import_error=False):
    """
    Execute scripts/McpServer.py in isolation.

    - env: complete environment dict to use (replaces os.environ entirely).
      Use _base_env() as a starting point, then add/remove as needed.
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

    # Default to a minimal safe env (PATH only) if not specified
    exec_env = env if env is not None else {}

    modules_to_inject = extra_sys_modules or {}

    real_import = builtins.__import__

    def import_raising_error(name, *args, **kwargs):
        if "mcp_server" in name:
            raise ImportError("No module named 'mcp'")
        return real_import(name, *args, **kwargs)

    # When forcing import error, evict mcp_server from sys.modules cache
    # so the import machinery fires and our __import__ patch intercepts it.
    modules_to_remove = {}
    if force_import_error:
        for key in list(sys.modules.keys()):
            if "mcp_server" in key:
                modules_to_remove[key] = sys.modules.pop(key)

    ctx_managers = [
        patch("sys.stderr", fake_stderr),
        patch("sys.exit", side_effect=fake_exit),
        patch.dict("os.environ", exec_env, clear=True),
        patch.dict("sys.modules", modules_to_inject),
    ]
    if force_import_error:
        ctx_managers.append(patch("builtins.__import__", side_effect=import_raising_error))

    import contextlib
    try:
        with contextlib.ExitStack() as stack:
            for cm in ctx_managers:
                stack.enter_context(cm)
            try:
                exec(compile(source, _SCRIPT_PATH, "exec"), {"__file__": _SCRIPT_PATH})
            except SystemExit:
                pass
    finally:
        # Restore any modules we temporarily removed
        sys.modules.update(modules_to_remove)

    path_snapshot = list(sys.path)
    sys.path[:] = orig_path

    exit_code = exit_calls[0] if exit_calls else None
    return path_snapshot, fake_stderr.getvalue(), exit_code


def _make_mock_mcp_server_module(call_log=None):
    """Create a fake claude_gates.mcp_server module with a no-op (or logging) main()."""
    mod = types.ModuleType("claude_gates.mcp_server")
    if call_log is not None:
        mod.main = lambda: call_log.append("called")
    else:
        mod.main = lambda: None
    return mod


def _make_mock_claude_gates_package():
    """Create a fake claude_gates package."""
    return types.ModuleType("claude_gates")


def _mock_modules(call_log=None):
    """Return extra_sys_modules dict with mocked claude_gates.mcp_server."""
    mock_mod = _make_mock_mcp_server_module(call_log)
    mock_pkg = _make_mock_claude_gates_package()
    mock_pkg.mcp_server = mock_mod
    return {
        "claude_gates": mock_pkg,
        "claude_gates.mcp_server": mock_mod,
    }


class TestMcpServerSysPath(unittest.TestCase):
    """AC1: sys.path setup matches hook_runner pattern."""

    def test_plugin_root_src_inserted_when_env_set(self):
        """AC1: CLAUDE_PLUGIN_ROOT set → {CLAUDE_PLUGIN_ROOT}/src in sys.path."""
        path, _, _ = _exec_script(
            env={"CLAUDE_PLUGIN_ROOT": "/fake/root"},
            extra_sys_modules=_mock_modules(),
        )
        expected = os.path.join("/fake/root", "src")
        self.assertIn(expected, path)

    def test_fallback_two_levels_up_when_no_env(self):
        """AC1: No CLAUDE_PLUGIN_ROOT → falls back to two levels above script file.

        The script is at scripts/McpServer.py:
          dirname(scripts/McpServer.py)   = scripts/
          dirname(scripts/)               = project_root/
        So plugin_root = project_root, src_path = project_root/src.
        """
        # Empty env: CLAUDE_PLUGIN_ROOT explicitly absent
        path, _, _ = _exec_script(
            env={},
            extra_sys_modules=_mock_modules(),
        )
        expected_fallback_src = os.path.join(_PROJECT_ROOT, "src")
        self.assertIn(expected_fallback_src, path)

    def test_plugin_data_pylib_inserted_when_env_set(self):
        """AC1: CLAUDE_PLUGIN_DATA set → {CLAUDE_PLUGIN_DATA}/pylib in sys.path."""
        path, _, _ = _exec_script(
            env={
                "CLAUDE_PLUGIN_ROOT": "/fake/root",
                "CLAUDE_PLUGIN_DATA": "/fake/data",
            },
            extra_sys_modules=_mock_modules(),
        )
        expected = os.path.join("/fake/data", "pylib")
        self.assertIn(expected, path)

    def test_plugin_data_not_set_no_pylib_inserted(self):
        """AC1: CLAUDE_PLUGIN_DATA absent → pylib NOT added to sys.path."""
        path, _, _ = _exec_script(
            env={"CLAUDE_PLUGIN_ROOT": "/fake/root"},
            extra_sys_modules=_mock_modules(),
        )
        self.assertNotIn(os.path.join("/fake/data", "pylib"), path)

    def test_src_path_not_duplicated_when_already_present(self):
        """AC1: src_path not inserted twice if already in sys.path.

        This tests the guard 'if src_path not in sys.path'.
        We pre-insert the path, then check it appears exactly once.
        """
        src_path = os.path.join("/fake/root", "src")
        orig_path = sys.path[:]
        sys.path.insert(0, src_path)
        try:
            path, _, _ = _exec_script(
                env={"CLAUDE_PLUGIN_ROOT": "/fake/root"},
                extra_sys_modules=_mock_modules(),
            )
            self.assertEqual(path.count(src_path), 1)
        finally:
            sys.path[:] = orig_path


class TestMcpServerImportError(unittest.TestCase):
    """AC2: ImportError from missing 'mcp' package → stderr message + exit 1."""

    def test_import_error_prints_message_to_stderr(self):
        """AC2: ImportError → prints message containing '[ClaudeGates]' to stderr."""
        _, stderr, _ = _exec_script(
            env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT},
            force_import_error=True,
        )
        self.assertIn("[ClaudeGates]", stderr)

    def test_import_error_stderr_message_exact(self):
        """AC2: stderr message is the exact specified text (from spec)."""
        _, stderr, _ = _exec_script(
            env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT},
            force_import_error=True,
        )
        expected_msg = "[ClaudeGates] MCP server requires 'mcp' package. Run pip install."
        self.assertIn(expected_msg, stderr)

    def test_import_error_exits_1(self):
        """AC2+AC3: ImportError → exits with code 1 (not 0, unlike hooks)."""
        _, _, exit_code = _exec_script(
            env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT},
            force_import_error=True,
        )
        self.assertEqual(exit_code, 1)

    def test_import_error_not_exit_0(self):
        """AC3: exit code is not 0 — hooks always exit 0, this script must not."""
        _, _, exit_code = _exec_script(
            env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT},
            force_import_error=True,
        )
        self.assertNotEqual(exit_code, 0)


class TestMcpServerCallsMain(unittest.TestCase):
    """AC3: Script calls mcp_server.main() on successful import."""

    def test_main_is_called_on_success(self):
        """main() from claude_gates.mcp_server is called when import succeeds."""
        call_log = []
        _exec_script(
            env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT},
            extra_sys_modules=_mock_modules(call_log),
        )
        self.assertEqual(call_log, ["called"])

    def test_main_called_exactly_once(self):
        """main() is called exactly once per script execution."""
        call_log = []
        _exec_script(
            env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT},
            extra_sys_modules=_mock_modules(call_log),
        )
        self.assertEqual(len(call_log), 1)

    def test_main_exception_propagates(self):
        """Edge case (spec): unhandled exception from main() propagates freely.

        The script does NOT catch generic exceptions — only ImportError.
        MCP protocol handles crash propagation.
        """
        def crashing_main():
            raise RuntimeError("mcp crash")

        mock_mod = types.ModuleType("claude_gates.mcp_server")
        mock_mod.main = crashing_main
        mock_pkg = _make_mock_claude_gates_package()
        mock_pkg.mcp_server = mock_mod

        with self.assertRaises(RuntimeError):
            _exec_script(
                env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT},
                extra_sys_modules={
                    "claude_gates": mock_pkg,
                    "claude_gates.mcp_server": mock_mod,
                },
            )


if __name__ == "__main__":
    unittest.main()
