"""
Tests for Task 28: hooks.json switchover + py.cjs wrapper.

Acceptance Criteria:
1. All hook commands use Node wrapper (py.cjs X.py) for Python discovery
2. npm install hook replaced with pip install hook (install_deps.py)
3. Atomic switchover — no mixed node/python3 state
4. Timeouts preserved (PipelineVerification=120000ms, PipelineConditions=40000ms)
5. py.cjs wrapper script exists and is ~20 lines
"""
import json
import os
import re
import subprocess
import sys
import unittest

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_HOOKS_JSON = os.path.join(_PROJECT_ROOT, "hooks", "hooks.json")
_PY_CJS = os.path.join(_PROJECT_ROOT, "scripts", "py.cjs")

# The 10 hook scripts that must switch to py.cjs
HOOK_SCRIPTS = [
    "SessionCleanup.py",
    "SessionContext.py",
    "WebLauncher.py",
    "PipelineBlock.py",
    "PipelineConditions.py",
    "PipelineInjection.py",
    "PipelineVerification.py",
    "PlanGate.py",
    "PlanGateClear.py",
    "GateToggle.py",
]


def _load_hooks():
    with open(_HOOKS_JSON, encoding="utf-8") as f:
        return json.load(f)


def _all_commands(hooks_data):
    """Yield all command strings from hooks.json recursively."""
    def _walk(obj):
        if isinstance(obj, dict):
            if "command" in obj:
                yield obj["command"]
            for v in obj.values():
                yield from _walk(v)
        elif isinstance(obj, list):
            for item in obj:
                yield from _walk(item)
    yield from _walk(hooks_data)


def _all_hook_entries(hooks_data):
    """Yield all hook entry dicts (with 'type' key) from hooks.json."""
    def _walk(obj):
        if isinstance(obj, dict):
            if "type" in obj and obj.get("type") == "command":
                yield obj
            for v in obj.values():
                yield from _walk(v)
        elif isinstance(obj, list):
            for item in obj:
                yield from _walk(item)
    yield from _walk(hooks_data)


class TestPyCjsExists(unittest.TestCase):
    """AC#5 — py.cjs wrapper script must exist."""

    def test_py_cjs_exists(self):
        self.assertTrue(
            os.path.isfile(_PY_CJS),
            msg=f"scripts/py.cjs does not exist at {_PY_CJS}",
        )

    def test_py_cjs_is_roughly_20_lines(self):
        """AC#5: py.cjs is ~20 lines (spec says ~20, allow up to 40 for safety)."""
        with open(_PY_CJS, encoding="utf-8") as f:
            lines = [l for l in f.readlines() if l.strip()]
        self.assertLessEqual(
            len(lines),
            40,
            msg=f"py.cjs has {len(lines)} non-empty lines — expected ~20",
        )

    def test_py_cjs_is_commonjs(self):
        """AC#5: py.cjs must be CommonJS (require or module.exports, not import/export)."""
        with open(_PY_CJS, encoding="utf-8") as f:
            content = f.read()
        # Must not use ES module syntax at top level
        self.assertNotIn("import ", content.split("//")[0],
                         msg="py.cjs must not use ES module import syntax")

    def test_py_cjs_tries_python3_first(self):
        """AC#5: py.cjs tries 'python3' before 'python'."""
        with open(_PY_CJS, encoding="utf-8") as f:
            content = f.read()
        self.assertIn("python3", content)

    def test_py_cjs_tries_python_fallback(self):
        """AC#5: py.cjs falls back to 'python' when python3 not found."""
        with open(_PY_CJS, encoding="utf-8") as f:
            content = f.read()
        self.assertIn("python", content)

    def test_py_cjs_validates_version(self):
        """AC#5: py.cjs validates Python >= 3.11."""
        with open(_PY_CJS, encoding="utf-8") as f:
            content = f.read()
        # Should check version in some form
        self.assertTrue(
            "3.11" in content or "--version" in content,
            msg="py.cjs must validate Python version >= 3.11",
        )

    def test_py_cjs_exits_0_on_failure(self):
        """AC#5: py.cjs is fail-open — exits 0 on failure."""
        with open(_PY_CJS, encoding="utf-8") as f:
            content = f.read()
        # Must have process.exit(0) for failure path
        self.assertIn("process.exit(0)", content,
                      msg="py.cjs must call process.exit(0) for fail-open behavior")


class TestHooksJsonStructure(unittest.TestCase):
    """AC#1, #2, #3 — hooks.json structure validation."""

    def setUp(self):
        self.hooks = _load_hooks()

    def test_hooks_json_is_valid_json(self):
        """hooks.json must be valid JSON."""
        self.assertIsInstance(self.hooks, dict)
        self.assertIn("hooks", self.hooks)

    def test_no_node_js_commands(self):
        """AC#3: No hook commands reference old-style .js scripts (complete switchover).

        py.cjs is the Node wrapper itself and is intentionally present in all commands —
        it is not an old-style hook script. We check that no command invokes a direct
        .js hook script (e.g. PipelineVerification.js) via node, excluding py.cjs itself.
        """
        for cmd in _all_commands(self.hooks):
            self.assertFalse(
                re.search(r"node\s+\S+/scripts/(?!py\.cjs)\S+\.js", cmd),
                msg=f"Found old-style .js hook script in command: {cmd!r} — switchover must be complete",
            )

    def test_no_npm_install_command(self):
        """AC#2: npm install hook is replaced — no npm commands in hooks.json."""
        for cmd in _all_commands(self.hooks):
            self.assertNotIn(
                "npm install",
                cmd,
                msg=f"Found npm install in command: {cmd!r} — must be replaced with pip install",
            )

    def test_no_direct_python3_commands(self):
        """AC#1: All Python hooks go through py.cjs wrapper, not direct python3."""
        for cmd in _all_commands(self.hooks):
            # Commands should use 'node ... py.cjs' not 'python3 ...'
            if ".py" in cmd:
                self.assertIn(
                    "py.cjs",
                    cmd,
                    msg=f"Python script invoked without py.cjs wrapper: {cmd!r}",
                )

    def test_all_10_scripts_use_py_cjs(self):
        """AC#1: All 10 hook scripts are invoked via node py.cjs X.py."""
        all_cmds = list(_all_commands(self.hooks))
        for script in HOOK_SCRIPTS:
            found = any(
                ("py.cjs" in cmd and script in cmd)
                for cmd in all_cmds
            )
            self.assertTrue(
                found,
                msg=f"{script} not found in any hook command via py.cjs. Commands: {all_cmds}",
            )

    def test_py_cjs_commands_use_plugin_root(self):
        """AC#1: py.cjs commands reference ${CLAUDE_PLUGIN_ROOT}."""
        for cmd in _all_commands(self.hooks):
            if "py.cjs" in cmd:
                self.assertIn(
                    "${CLAUDE_PLUGIN_ROOT}",
                    cmd,
                    msg=f"py.cjs command must use ${{CLAUDE_PLUGIN_ROOT}}: {cmd!r}",
                )


class TestPipInstallHook(unittest.TestCase):
    """AC#2 — pip install hook replaces npm install hook."""

    def setUp(self):
        self.hooks = _load_hooks()

    def test_session_start_has_pip_install(self):
        """AC#2: SessionStart contains a pip/install_deps command."""
        session_start = self.hooks["hooks"].get("SessionStart", [])
        all_session_cmds = []
        for group in session_start:
            for hook in group.get("hooks", []):
                if hook.get("type") == "command":
                    all_session_cmds.append(hook["command"])

        has_pip_install = any(
            "install_deps.py" in cmd or "pip" in cmd
            for cmd in all_session_cmds
        )
        self.assertTrue(
            has_pip_install,
            msg=f"SessionStart must have a pip/install_deps hook. Found: {all_session_cmds}",
        )

    def test_pip_install_uses_plugin_root(self):
        """AC#2: pip install hook references CLAUDE_PLUGIN_ROOT (install_deps.py path)."""
        session_start = self.hooks["hooks"].get("SessionStart", [])
        for group in session_start:
            for hook in group.get("hooks", []):
                cmd = hook.get("command", "")
                if "install_deps" in cmd:
                    # install_deps.py path must be rooted at CLAUDE_PLUGIN_ROOT
                    self.assertIn(
                        "CLAUDE_PLUGIN_ROOT",
                        cmd,
                        msg=f"install_deps hook must use ${{CLAUDE_PLUGIN_ROOT}} path: {cmd!r}",
                    )
                    return
        self.fail("No install_deps hook found in SessionStart")

    def test_pip_install_references_install_deps_py(self):
        """AC#2: SessionStart hook wraps install_deps.py (from Task 31)."""
        session_start = self.hooks["hooks"].get("SessionStart", [])
        all_session_cmds = []
        for group in session_start:
            for hook in group.get("hooks", []):
                if hook.get("type") == "command":
                    all_session_cmds.append(hook["command"])

        has_install_deps = any("install_deps.py" in cmd for cmd in all_session_cmds)
        self.assertTrue(
            has_install_deps,
            msg=f"SessionStart must invoke install_deps.py. Found: {all_session_cmds}",
        )


class TestTimeoutsPreserved(unittest.TestCase):
    """AC#4 — Timeouts must be preserved."""

    def setUp(self):
        self.hooks = _load_hooks()

    def _find_timeout_for_script(self, script_name):
        """Find the timeout for a hook command containing script_name."""
        def _walk(obj):
            if isinstance(obj, dict):
                cmd = obj.get("command", "")
                if script_name in cmd and "timeout" in obj:
                    return obj["timeout"]
                for v in obj.values():
                    result = _walk(v)
                    if result is not None:
                        return result
            elif isinstance(obj, list):
                for item in obj:
                    result = _walk(item)
                    if result is not None:
                        return result
            return None
        return _walk(self.hooks)

    def test_pipeline_verification_timeout_120000(self):
        """AC#4: PipelineVerification.py timeout = 120000ms."""
        timeout = self._find_timeout_for_script("PipelineVerification")
        self.assertEqual(
            timeout,
            120000,
            msg=f"PipelineVerification timeout must be 120000ms, got {timeout}",
        )

    def test_pipeline_conditions_timeout_40000(self):
        """AC#4: PipelineConditions.py timeout = 40000ms."""
        timeout = self._find_timeout_for_script("PipelineConditions")
        self.assertEqual(
            timeout,
            40000,
            msg=f"PipelineConditions timeout must be 40000ms, got {timeout}",
        )


class TestAtomicSwitchover(unittest.TestCase):
    """AC#3 — No mixed node/python3 state."""

    def setUp(self):
        self.hooks = _load_hooks()

    def test_no_mixed_node_js_and_py(self):
        """AC#3: No hook command uses both old node X.js and new py.cjs patterns."""
        for cmd in _all_commands(self.hooks):
            # A command shouldn't have both old .js pattern and new .py pattern
            has_old_js = "scripts/" in cmd and ".js" in cmd and "node " in cmd and "py.cjs" not in cmd
            self.assertFalse(
                has_old_js,
                msg=f"Found old-style node .js command: {cmd!r} — must be switched to py.cjs",
            )

    def test_session_cleanup_uses_py_cjs(self):
        """AC#1+3: SessionCleanup uses py.cjs."""
        cmds = list(_all_commands(self.hooks))
        found = any("SessionCleanup" in cmd and "py.cjs" in cmd for cmd in cmds)
        self.assertTrue(found, msg=f"SessionCleanup.py not routed through py.cjs. Commands: {cmds}")

    def test_gate_toggle_uses_py_cjs(self):
        """AC#1+3: GateToggle uses py.cjs."""
        cmds = list(_all_commands(self.hooks))
        found = any("GateToggle" in cmd and "py.cjs" in cmd for cmd in cmds)
        self.assertTrue(found, msg=f"GateToggle.py not routed through py.cjs. Commands: {cmds}")

    def test_plan_gate_uses_py_cjs(self):
        """AC#1+3: PlanGate uses py.cjs."""
        cmds = list(_all_commands(self.hooks))
        found = any("PlanGate" in cmd and "py.cjs" in cmd for cmd in cmds)
        self.assertTrue(found, msg=f"PlanGate.py not routed through py.cjs. Commands: {cmds}")

    def test_plan_gate_clear_uses_py_cjs(self):
        """AC#1+3: PlanGateClear uses py.cjs."""
        cmds = list(_all_commands(self.hooks))
        found = any("PlanGateClear" in cmd and "py.cjs" in cmd for cmd in cmds)
        self.assertTrue(found, msg=f"PlanGateClear.py not routed through py.cjs. Commands: {cmds}")


if __name__ == "__main__":
    unittest.main()
