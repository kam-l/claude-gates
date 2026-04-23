"""
Tests for scripts/PipelineVerification.py, PipelineBlock.py, PipelineConditions.py,
PipelineInjection.py, PlanGate.py, PlanGateClear.py, GateToggle.py,
SessionContext.py, SessionCleanup.py, WebLauncher.py

Acceptance Criteria (spec.md):
1. Each script follows the exact 3-line pattern
2. All 10 scripts map to correct handlers
3. PlanGate and PlanGateClear both import from plan_gate
4. Scripts coexist with .js counterparts (no collision)
"""
import ast
import os
import subprocess
import sys
import unittest

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SCRIPTS_DIR = os.path.join(_PROJECT_ROOT, "scripts")

# AC#2 — the full mapping table from spec
HOOK_SCRIPTS = [
    ("GateToggle.py",            "gate_toggle",   "on_user_prompt"),
    ("SessionContext.py",        "session_context", "on_session_start"),
    ("SessionCleanup.py",        "session",        "cleanup"),
    ("WebLauncher.py",           "web_launcher",   "launch"),
    ("PipelineBlock.py",         "block",          "on_pre_tool_use"),
    ("PipelineConditions.py",    "conditions",     "on_conditions_check"),
    ("PipelineInjection.py",     "injection",      "on_subagent_start"),
    ("PipelineVerification.py",  "verification",   "on_subagent_stop"),
    ("PlanGate.py",              "plan_gate",      "on_exit_plan_mode"),
    ("PlanGateClear.py",         "plan_gate",      "on_clear"),
]


def _read_script(filename):
    path = os.path.join(_SCRIPTS_DIR, filename)
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def _parse_script(source, filename):
    """Parse source into an AST; raises AssertionError with filename on syntax error."""
    try:
        return ast.parse(source)
    except SyntaxError as exc:
        raise AssertionError(f"{filename}: SyntaxError — {exc}") from exc


class TestHookEntryScriptsExist(unittest.TestCase):
    """All 10 hook entry script files must exist."""

    def test_all_scripts_exist(self):
        for filename, _, _ in HOOK_SCRIPTS:
            path = os.path.join(_SCRIPTS_DIR, filename)
            self.assertTrue(
                os.path.isfile(path),
                msg=f"Missing script: scripts/{filename}",
            )


class TestExactThreeLinePattern(unittest.TestCase):
    """AC#1 — Each script contains exactly 3 non-empty lines matching the template."""

    def _assert_three_line_pattern(self, filename, module, handler):
        source = _read_script(filename)
        lines = [l for l in source.splitlines() if l.strip()]
        self.assertEqual(
            len(lines),
            3,
            msg=f"{filename}: expected 3 non-empty lines, got {len(lines)}: {lines!r}",
        )

        line1 = f"from claude_gates.hook_runner import run"
        line2 = f"from claude_gates.{module} import {handler}"
        line3 = f"run({handler})"

        self.assertEqual(
            lines[0],
            line1,
            msg=f"{filename}: line 1 mismatch.\n  expected: {line1!r}\n  got:      {lines[0]!r}",
        )
        self.assertEqual(
            lines[1],
            line2,
            msg=f"{filename}: line 2 mismatch.\n  expected: {line2!r}\n  got:      {lines[1]!r}",
        )
        self.assertEqual(
            lines[2],
            line3,
            msg=f"{filename}: line 3 mismatch.\n  expected: {line3!r}\n  got:      {lines[2]!r}",
        )

    def test_GateToggle_pattern(self):
        self._assert_three_line_pattern("GateToggle.py", "gate_toggle", "on_user_prompt")

    def test_SessionContext_pattern(self):
        self._assert_three_line_pattern("SessionContext.py", "session_context", "on_session_start")

    def test_SessionCleanup_pattern(self):
        self._assert_three_line_pattern("SessionCleanup.py", "session", "cleanup")

    def test_WebLauncher_pattern(self):
        self._assert_three_line_pattern("WebLauncher.py", "web_launcher", "launch")

    def test_PipelineBlock_pattern(self):
        self._assert_three_line_pattern("PipelineBlock.py", "block", "on_pre_tool_use")

    def test_PipelineConditions_pattern(self):
        self._assert_three_line_pattern("PipelineConditions.py", "conditions", "on_conditions_check")

    def test_PipelineInjection_pattern(self):
        self._assert_three_line_pattern("PipelineInjection.py", "injection", "on_subagent_start")

    def test_PipelineVerification_pattern(self):
        self._assert_three_line_pattern("PipelineVerification.py", "verification", "on_subagent_stop")

    def test_PlanGate_pattern(self):
        self._assert_three_line_pattern("PlanGate.py", "plan_gate", "on_exit_plan_mode")

    def test_PlanGateClear_pattern(self):
        self._assert_three_line_pattern("PlanGateClear.py", "plan_gate", "on_clear")


class TestNoForbiddenElements(unittest.TestCase):
    """AC#1 — No shebang, no docstring, no try/catch."""

    def _check_no_forbidden(self, filename):
        source = _read_script(filename)
        lines = source.splitlines()

        # No shebang
        if lines:
            self.assertFalse(
                lines[0].startswith("#!"),
                msg=f"{filename}: must not have a shebang line",
            )

        tree = _parse_script(source, filename)
        for node in ast.walk(tree):
            # No docstrings (module-level Expr with a Constant string)
            if isinstance(node, ast.Module):
                for child in ast.iter_child_nodes(node):
                    if (
                        isinstance(child, ast.Expr)
                        and isinstance(child.value, ast.Constant)
                        and isinstance(child.value.value, str)
                    ):
                        self.fail(f"{filename}: must not have a module-level docstring")

            # No try/except
            if isinstance(node, ast.Try):
                self.fail(f"{filename}: must not have try/except blocks")

    def test_GateToggle_no_forbidden(self):
        self._check_no_forbidden("GateToggle.py")

    def test_SessionContext_no_forbidden(self):
        self._check_no_forbidden("SessionContext.py")

    def test_SessionCleanup_no_forbidden(self):
        self._check_no_forbidden("SessionCleanup.py")

    def test_WebLauncher_no_forbidden(self):
        self._check_no_forbidden("WebLauncher.py")

    def test_PipelineBlock_no_forbidden(self):
        self._check_no_forbidden("PipelineBlock.py")

    def test_PipelineConditions_no_forbidden(self):
        self._check_no_forbidden("PipelineConditions.py")

    def test_PipelineInjection_no_forbidden(self):
        self._check_no_forbidden("PipelineInjection.py")

    def test_PipelineVerification_no_forbidden(self):
        self._check_no_forbidden("PipelineVerification.py")

    def test_PlanGate_no_forbidden(self):
        self._check_no_forbidden("PlanGate.py")

    def test_PlanGateClear_no_forbidden(self):
        self._check_no_forbidden("PlanGateClear.py")


class TestPlanGateSharedModule(unittest.TestCase):
    """AC#3 — PlanGate.py and PlanGateClear.py both import from claude_gates.plan_gate."""

    def _get_import_from_module(self, filename):
        """Return the module name from the ImportFrom node (from claude_gates.<module> import ...)."""
        source = _read_script(filename)
        tree = _parse_script(source, filename)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("claude_gates."):
                return node.module[len("claude_gates."):]
        raise AssertionError(f"{filename}: no 'from claude_gates.<module> import ...' found")

    def test_PlanGate_imports_from_plan_gate(self):
        module = self._get_import_from_module("PlanGate.py")
        self.assertEqual(module, "plan_gate", msg="PlanGate.py must import from claude_gates.plan_gate")

    def test_PlanGateClear_imports_from_plan_gate(self):
        module = self._get_import_from_module("PlanGateClear.py")
        self.assertEqual(module, "plan_gate", msg="PlanGateClear.py must import from claude_gates.plan_gate")

    def test_PlanGate_and_PlanGateClear_different_handlers(self):
        source_gate = _read_script("PlanGate.py")
        source_clear = _read_script("PlanGateClear.py")
        lines_gate = [l for l in source_gate.splitlines() if l.strip()]
        lines_clear = [l for l in source_clear.splitlines() if l.strip()]
        # line 3 is run(<handler>)
        self.assertNotEqual(
            lines_gate[2],
            lines_clear[2],
            msg="PlanGate.py and PlanGateClear.py must call different handlers",
        )


class TestJsCoexistence(unittest.TestCase):
    """AC#4 — .py files coexist with .js counterparts without collision."""

    def test_py_and_js_coexist_for_all_hooks(self):
        """Both .py and .js files exist side-by-side for each hook script."""
        for filename, _, _ in HOOK_SCRIPTS:
            py_path = os.path.join(_SCRIPTS_DIR, filename)
            js_name = filename.replace(".py", ".js")
            js_path = os.path.join(_SCRIPTS_DIR, js_name)
            self.assertTrue(
                os.path.isfile(py_path),
                msg=f"Missing .py: scripts/{filename}",
            )
            self.assertTrue(
                os.path.isfile(js_path),
                msg=f"Missing .js counterpart: scripts/{js_name} (pre-existing, should still be there)",
            )


class TestTotalScriptCount(unittest.TestCase):
    """ls scripts/*.py should list 12 files after landing (10 new + McpServer.py + unblock.py)."""

    def test_twelve_python_scripts_total(self):
        import glob
        py_files = glob.glob(os.path.join(_SCRIPTS_DIR, "*.py"))
        self.assertGreaterEqual(
            len(py_files),
            12,
            msg=f"Expected at least 12 .py files in scripts/, found {len(py_files)}: {[os.path.basename(f) for f in sorted(py_files)]}",
        )


class TestSubprocessInvocation(unittest.TestCase):
    """CRITICAL-2 — Each entry script must run without TypeError/ImportError when invoked as a subprocess."""

    _ENTRY_SCRIPTS = [filename for filename, _, _ in HOOK_SCRIPTS]

    def _run_script(self, filename):
        script_path = os.path.join(_SCRIPTS_DIR, filename)
        env = os.environ.copy()
        src_dir = os.path.join(_PROJECT_ROOT, "src")
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = f"{src_dir}{os.pathsep}{existing}" if existing else src_dir
        result = subprocess.run(
            [sys.executable, script_path],
            input="{}",
            capture_output=True,
            text=True,
            timeout=5,
            env=env,
        )
        return result

    def _assert_clean_exit(self, filename):
        result = self._run_script(filename)
        self.assertEqual(
            result.returncode,
            0,
            msg=f"{filename}: expected exit code 0, got {result.returncode}\nstderr: {result.stderr}",
        )
        for marker in ("Traceback", "TypeError", "ImportError"):
            self.assertNotIn(
                marker,
                result.stderr,
                msg=f"{filename}: found '{marker}' in stderr:\n{result.stderr}",
            )

    def test_SessionCleanup_subprocess(self):
        """Regression: cleanup() must accept data arg — was TypeError before fix."""
        self._assert_clean_exit("SessionCleanup.py")

    def test_GateToggle_subprocess(self):
        self._assert_clean_exit("GateToggle.py")

    def test_SessionContext_subprocess(self):
        self._assert_clean_exit("SessionContext.py")

    def test_WebLauncher_subprocess(self):
        self._assert_clean_exit("WebLauncher.py")

    def test_PipelineBlock_subprocess(self):
        self._assert_clean_exit("PipelineBlock.py")

    def test_PipelineConditions_subprocess(self):
        self._assert_clean_exit("PipelineConditions.py")

    def test_PipelineInjection_subprocess(self):
        self._assert_clean_exit("PipelineInjection.py")

    def test_PipelineVerification_subprocess(self):
        self._assert_clean_exit("PipelineVerification.py")

    def test_PlanGate_subprocess(self):
        self._assert_clean_exit("PlanGate.py")

    def test_PlanGateClear_subprocess(self):
        self._assert_clean_exit("PlanGateClear.py")


if __name__ == "__main__":
    unittest.main()
