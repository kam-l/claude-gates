"""Tests for session_context.py — port of SessionContext.ts."""

import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates.types import StepType


# ── Helpers ────────────────────────────────────────────────────────────────────

def _make_check_step(prompt: str) -> dict:
    return {"type": StepType.Check, "prompt": prompt}


def _make_verify_step(agent: str, max_rounds: int) -> dict:
    return {"type": StepType.Verify, "agent": agent, "maxRounds": max_rounds}


def _make_verify_w_fixer_step(agent: str, max_rounds: int, fixer: str) -> dict:
    return {"type": StepType.VerifyWithFixer, "agent": agent, "maxRounds": max_rounds, "fixer": fixer}


def _make_transform_step(agent: str) -> dict:
    return {"type": StepType.Transform, "agent": agent, "maxRounds": 1}


def _write_agent_md(root: str, agent_name: str, content: str) -> str:
    agents_dir = os.path.join(root, ".claude", "agents")
    os.makedirs(agents_dir, exist_ok=True)
    path = os.path.join(agents_dir, f"{agent_name}.md")
    with open(path, "w") as f:
        f.write(content)
    return path


GATED_AGENT_MD = """\
---
name: reviewer
verification:
  - ["Check quality"]
  - [reviewer?, 3]
---
Reviewer agent.
"""

UNGATED_AGENT_MD = """\
---
name: simple
---
Simple agent with no pipeline fields.
"""


# ─────────────────────────────────────────────────────────────────────────────
# AC1: format_step renders each step type correctly
# ─────────────────────────────────────────────────────────────────────────────

class TestFormatStep(unittest.TestCase):

    def setUp(self):
        from src.claude_gates import session_context
        self.format_step = session_context.format_step

    def test_check_step_short_prompt(self):
        """CHECK step with short prompt — no truncation."""
        step = _make_check_step("check the output quality")
        result = self.format_step(step)
        self.assertEqual(result, 'CHECK("check the output quality")')

    def test_check_step_long_prompt_truncated(self):
        """CHECK step with >40 char prompt — truncated with '...'."""
        long_prompt = "A" * 41  # 41 chars, exceeds limit
        step = _make_check_step(long_prompt)
        result = self.format_step(step)
        # First 40 chars + "..."
        self.assertEqual(result, f'CHECK("{long_prompt[:40]}...")')

    def test_check_step_exactly_40_chars_no_truncation(self):
        """CHECK step with exactly 40 chars — not truncated."""
        prompt = "A" * 40
        step = _make_check_step(prompt)
        result = self.format_step(step)
        self.assertEqual(result, f'CHECK("{prompt}")')

    def test_verify_step(self):
        """VERIFY step renders agent + maxRounds."""
        step = _make_verify_step("reviewer", 3)
        result = self.format_step(step)
        self.assertEqual(result, "VERIFY(reviewer, 3)")

    def test_verify_w_fixer_step(self):
        """VERIFY_W_FIXER step renders agent + maxRounds + fixer."""
        step = _make_verify_w_fixer_step("reviewer", 3, "fixer")
        result = self.format_step(step)
        self.assertEqual(result, "VERIFY(reviewer, 3, fixer)")

    def test_transform_step(self):
        """TRANSFORM step renders just agent name."""
        step = _make_transform_step("cleaner")
        result = self.format_step(step)
        self.assertEqual(result, "TRANSFORM(cleaner)")


# ─────────────────────────────────────────────────────────────────────────────
# AC2: format_pipeline joins steps with arrow
# ─────────────────────────────────────────────────────────────────────────────

class TestFormatPipeline(unittest.TestCase):

    def setUp(self):
        from src.claude_gates import session_context
        self.format_pipeline = session_context.format_pipeline

    def test_empty_list_returns_empty_string(self):
        result = self.format_pipeline([])
        self.assertEqual(result, "")

    def test_single_step(self):
        steps = [_make_verify_step("reviewer", 3)]
        result = self.format_pipeline(steps)
        self.assertEqual(result, "VERIFY(reviewer, 3)")

    def test_multiple_steps_joined_with_arrow(self):
        steps = [
            _make_check_step("check quality"),
            _make_verify_step("reviewer", 3),
            _make_transform_step("cleaner"),
        ]
        result = self.format_pipeline(steps)
        # Unicode arrow U+2192
        self.assertIn(" \u2192 ", result)
        parts = result.split(" \u2192 ")
        self.assertEqual(len(parts), 3)
        self.assertEqual(parts[0], 'CHECK("check quality")')
        self.assertEqual(parts[1], "VERIFY(reviewer, 3)")
        self.assertEqual(parts[2], "TRANSFORM(cleaner)")

    def test_uses_unicode_arrow(self):
        """Separator must be the Unicode arrow U+2192, not ASCII '->'."""
        steps = [_make_verify_step("a", 1), _make_verify_step("b", 1)]
        result = self.format_pipeline(steps)
        self.assertIn("\u2192", result)
        self.assertNotIn("->", result)


# ─────────────────────────────────────────────────────────────────────────────
# AC3: discover_gated_agents scans project-first, deduplicates by name
# ─────────────────────────────────────────────────────────────────────────────

class TestDiscoverGatedAgents(unittest.TestCase):

    def setUp(self):
        self.project_tmp = tempfile.mkdtemp()
        self.global_tmp = tempfile.mkdtemp()
        from src.claude_gates import session_context
        self.discover = session_context.discover_gated_agents

    def tearDown(self):
        shutil.rmtree(self.project_tmp, ignore_errors=True)
        shutil.rmtree(self.global_tmp, ignore_errors=True)

    def test_returns_gated_agents(self):
        """Agents with verification: frontmatter are included."""
        _write_agent_md(self.project_tmp, "reviewer", GATED_AGENT_MD)
        agents = self.discover(self.project_tmp, self.global_tmp)
        self.assertEqual(len(agents), 1)
        self.assertEqual(agents[0]["name"], "reviewer")
        self.assertEqual(agents[0]["source"], "project")

    def test_excludes_ungated_agents(self):
        """Agents without verification: are excluded."""
        _write_agent_md(self.project_tmp, "simple", UNGATED_AGENT_MD)
        agents = self.discover(self.project_tmp, self.global_tmp)
        self.assertEqual(len(agents), 0)

    def test_project_agent_shadows_global(self):
        """Project agent with same name shadows global agent."""
        _write_agent_md(self.project_tmp, "reviewer", GATED_AGENT_MD)
        _write_agent_md(self.global_tmp, "reviewer", GATED_AGENT_MD)
        agents = self.discover(self.project_tmp, self.global_tmp)
        # Only one, and it's the project one
        names = [a["name"] for a in agents]
        self.assertEqual(names.count("reviewer"), 1)
        reviewer = next(a for a in agents if a["name"] == "reviewer")
        self.assertEqual(reviewer["source"], "project")

    def test_global_agent_included_when_no_project_duplicate(self):
        """Global agent is included if no project agent with same name."""
        _write_agent_md(self.global_tmp, "reviewer", GATED_AGENT_MD)
        agents = self.discover(self.project_tmp, self.global_tmp)
        self.assertEqual(len(agents), 1)
        self.assertEqual(agents[0]["source"], "global")

    def test_agent_name_derived_from_filename(self):
        """Agent name = filename minus .md suffix."""
        _write_agent_md(self.project_tmp, "my-reviewer", GATED_AGENT_MD)
        agents = self.discover(self.project_tmp, self.global_tmp)
        self.assertEqual(agents[0]["name"], "my-reviewer")

    def test_project_scanned_before_global(self):
        """Project agents appear before global agents in result list."""
        _write_agent_md(self.project_tmp, "alpha", GATED_AGENT_MD)
        _write_agent_md(self.global_tmp, "beta", GATED_AGENT_MD)
        agents = self.discover(self.project_tmp, self.global_tmp)
        self.assertEqual(len(agents), 2)
        self.assertEqual(agents[0]["name"], "alpha")
        self.assertEqual(agents[0]["source"], "project")
        self.assertEqual(agents[1]["name"], "beta")
        self.assertEqual(agents[1]["source"], "global")

    def test_only_md_files_included(self):
        """Non-.md files in agents dir are ignored."""
        agents_dir = os.path.join(self.project_tmp, ".claude", "agents")
        os.makedirs(agents_dir, exist_ok=True)
        # Write a non-.md file
        with open(os.path.join(agents_dir, "reviewer.txt"), "w") as f:
            f.write(GATED_AGENT_MD)
        agents = self.discover(self.project_tmp, self.global_tmp)
        self.assertEqual(len(agents), 0)

    def test_returns_iagentsummary_structure(self):
        """Result items have name, source, steps keys."""
        _write_agent_md(self.project_tmp, "reviewer", GATED_AGENT_MD)
        agents = self.discover(self.project_tmp, self.global_tmp)
        agent = agents[0]
        self.assertIn("name", agent)
        self.assertIn("source", agent)
        self.assertIn("steps", agent)
        self.assertIsInstance(agent["steps"], list)


# ─────────────────────────────────────────────────────────────────────────────
# AC4: discover_gated_agents tolerates missing directories
# ─────────────────────────────────────────────────────────────────────────────

class TestDiscoverGatedAgentsMissingDirs(unittest.TestCase):

    def setUp(self):
        from src.claude_gates import session_context
        self.discover = session_context.discover_gated_agents

    def test_none_project_dir(self):
        """None project_dir doesn't crash."""
        result = self.discover(None, None)
        self.assertEqual(result, [])

    def test_nonexistent_project_dir(self):
        """Non-existent directory path doesn't crash."""
        result = self.discover("/nonexistent/path/abc123", "/another/missing/path")
        self.assertEqual(result, [])

    def test_none_global_dir(self):
        """None global_dir is skipped silently."""
        tmp = tempfile.mkdtemp()
        try:
            result = self.discover(tmp, None)
            self.assertEqual(result, [])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_unreadable_file_skipped(self):
        """File that raises on read is skipped silently (no crash)."""
        tmp = tempfile.mkdtemp()
        try:
            _write_agent_md(tmp, "reviewer", GATED_AGENT_MD)
            # Patch open to raise on that specific file
            original_open = open

            def failing_open(path, *args, **kwargs):
                if "reviewer.md" in str(path):
                    raise PermissionError("no access")
                return original_open(path, *args, **kwargs)

            with patch("builtins.open", side_effect=failing_open):
                result = self.discover(tmp, None)
            # Should not crash, returns empty (or fewer items)
            self.assertIsInstance(result, list)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_frontmatter_no_verification_excluded(self):
        """Agent .md with frontmatter but no verification: is excluded."""
        tmp = tempfile.mkdtemp()
        try:
            _write_agent_md(tmp, "simple", UNGATED_AGENT_MD)
            agents = self.discover(tmp, None)
            self.assertEqual(len(agents), 0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ─────────────────────────────────────────────────────────────────────────────
# AC5: build_banner includes gate status, agents, toggle hints, and monitor URL
# ─────────────────────────────────────────────────────────────────────────────

class TestBuildBanner(unittest.TestCase):

    def setUp(self):
        from src.claude_gates import session_context
        self.build_banner = session_context.build_banner

    def test_header_gate_disabled(self):
        """Header says PAUSED when gate disabled."""
        with patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            banner = self.build_banner(gate_disabled=True)
        self.assertIn("[ClaudeGates] Session gates: PAUSED", banner)

    def test_header_gate_enabled(self):
        """Header says active (no PAUSED) when gate enabled."""
        with patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            banner = self.build_banner(gate_disabled=False)
        self.assertIn("[ClaudeGates] Session gates:", banner)
        self.assertNotIn("PAUSED", banner)

    def test_plan_gate_off_when_disabled(self):
        """Plan Gate: OFF when gate disabled."""
        with patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            banner = self.build_banner(gate_disabled=True)
        self.assertIn("  Plan Gate: OFF", banner)

    def test_plan_gate_on_when_enabled(self):
        """Plan Gate: ON when gate enabled."""
        with patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            banner = self.build_banner(gate_disabled=False)
        self.assertIn("  Plan Gate: ON", banner)

    def test_no_agents_shows_placeholder(self):
        """When no gated agents, shows placeholder line."""
        with patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            banner = self.build_banner(gate_disabled=False)
        self.assertIn("  (no gated agents)", banner)

    def test_agent_line_in_banner(self):
        """Each gated agent appears as '  name: pipeline'."""
        mock_agents = [
            {"name": "reviewer", "source": "project", "steps": [_make_verify_step("reviewer", 3)]}
        ]
        with patch("src.claude_gates.session_context.discover_gated_agents", return_value=mock_agents):
            banner = self.build_banner(gate_disabled=False)
        self.assertIn("  reviewer: VERIFY(reviewer, 3)", banner)

    def test_global_agent_has_suffix(self):
        """Global agents have ' (global)' suffix."""
        mock_agents = [
            {"name": "reviewer", "source": "global", "steps": [_make_verify_step("reviewer", 3)]}
        ]
        with patch("src.claude_gates.session_context.discover_gated_agents", return_value=mock_agents):
            banner = self.build_banner(gate_disabled=False)
        self.assertIn("  reviewer: VERIFY(reviewer, 3) (global)", banner)

    def test_project_agent_no_global_suffix(self):
        """Project agents have no '(global)' suffix."""
        mock_agents = [
            {"name": "reviewer", "source": "project", "steps": [_make_verify_step("reviewer", 3)]}
        ]
        with patch("src.claude_gates.session_context.discover_gated_agents", return_value=mock_agents):
            banner = self.build_banner(gate_disabled=False)
        self.assertNotIn("(global)", banner)

    def test_toggle_hint_when_enabled(self):
        """Toggle hint for enabled state mentions 'gate off'."""
        with patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            banner = self.build_banner(gate_disabled=False)
        self.assertIn("gate off", banner)

    def test_toggle_hint_when_disabled(self):
        """Toggle hint for disabled state mentions 'gate on'."""
        with patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            banner = self.build_banner(gate_disabled=True)
        self.assertIn("gate on", banner)

    def test_monitor_url_default_port(self):
        """Monitor URL uses default port 64735 when env var not set."""
        with patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            with patch.dict(os.environ, {}, clear=False):
                # Ensure env var is absent
                os.environ.pop("CLAUDE_GATES_PORT", None)
                banner = self.build_banner(gate_disabled=False)
        self.assertIn("Monitor: http://localhost:64735", banner)

    def test_monitor_url_custom_port(self):
        """Monitor URL uses CLAUDE_GATES_PORT env var when set."""
        with patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            with patch.dict(os.environ, {"CLAUDE_GATES_PORT": "9999"}):
                banner = self.build_banner(gate_disabled=False)
        self.assertIn("Monitor: http://localhost:9999", banner)


# ─────────────────────────────────────────────────────────────────────────────
# AC6: on_session_start returns additionalContext
# ─────────────────────────────────────────────────────────────────────────────

class TestOnSessionStart(unittest.TestCase):

    def setUp(self):
        from src.claude_gates import session_context
        self.on_session_start = session_context.on_session_start

    def test_returns_additional_context_key(self):
        """Result contains 'additionalContext' key."""
        with patch("src.claude_gates.session_context.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            result = self.on_session_start({})
        self.assertIn("additionalContext", result)

    def test_additional_context_contains_banner(self):
        """additionalContext starts with the banner text."""
        with patch("src.claude_gates.session_context.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            result = self.on_session_start({})
        context = result["additionalContext"]
        self.assertIn("[ClaudeGates]", context)

    def test_additional_context_contains_behavioral_guidance(self):
        """additionalContext includes guidance about pipeline blocking."""
        with patch("src.claude_gates.session_context.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            result = self.on_session_start({})
        context = result["additionalContext"]
        # Should mention gated agents and pipeline behavior
        self.assertIn("verification", context.lower())

    def test_additional_context_mentions_gated_agents(self):
        """Guidance text mentions gated agents."""
        with patch("src.claude_gates.session_context.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            result = self.on_session_start({})
        context = result["additionalContext"]
        self.assertIn("gated agent", context.lower())

    def test_writes_banner_to_stderr(self):
        """Banner is written to stderr."""
        import io
        stderr_capture = io.StringIO()
        with patch("src.claude_gates.session_context.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]), \
             patch("sys.stderr", stderr_capture):
            self.on_session_start({})
        stderr_output = stderr_capture.getvalue()
        self.assertIn("[ClaudeGates]", stderr_output)

    def test_result_is_dict(self):
        """Return value is a dict."""
        with patch("src.claude_gates.session_context.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            result = self.on_session_start({})
        self.assertIsInstance(result, dict)


# ─────────────────────────────────────────────────────────────────────────────
# Task 30: Python version check in on_session_start()
# ─────────────────────────────────────────────────────────────────────────────

class TestPythonVersionCheck(unittest.TestCase):
    """AC1: Version check at top of on_session_start().

    If sys.version_info < (3, 11):
      - log warning to stderr
      - return {"systemMessage": "[ClaudeGates] Python 3.11+ required (found X.Y). Gates disabled."}
      - do NOT crash
      - do NOT inject additionalContext / banner
    """

    def setUp(self):
        from src.claude_gates import session_context
        self.on_session_start = session_context.on_session_start

    def test_old_python_logs_to_stderr(self):
        """When version < 3.11, warning is written to stderr."""
        import io
        stderr_capture = io.StringIO()
        old_version = (3, 10, 0, "final", 0)
        with patch("sys.version_info", old_version), \
             patch("sys.stderr", stderr_capture):
            self.on_session_start({})
        stderr_output = stderr_capture.getvalue()
        self.assertIn("[ClaudeGates] Python 3.11+ required", stderr_output)
        self.assertIn("3.10", stderr_output)
        self.assertIn("Gates disabled", stderr_output)

    def test_old_python_returns_system_message(self):
        """When version < 3.11, returns systemMessage so user sees warning in-session."""
        old_version = (3, 10, 0, "final", 0)
        with patch("sys.version_info", old_version):
            result = self.on_session_start({})
        self.assertIn("systemMessage", result)
        self.assertIn("[ClaudeGates] Python 3.11+ required", result["systemMessage"])
        self.assertIn("3.10", result["systemMessage"])
        self.assertIn("Gates disabled", result["systemMessage"])

    def test_old_python_returns_empty_of_additional_context(self):
        """When version < 3.11, no additionalContext is returned (fail-open, no banner)."""
        old_version = (3, 10, 0, "final", 0)
        with patch("sys.version_info", old_version):
            result = self.on_session_start({})
        self.assertNotIn("additionalContext", result)

    def test_old_python_does_not_crash(self):
        """When version < 3.11, on_session_start does NOT raise."""
        old_version = (3, 10, 0, "final", 0)
        with patch("sys.version_info", old_version):
            try:
                result = self.on_session_start({})
            except Exception as e:
                self.fail(f"on_session_start raised unexpectedly: {e}")
        self.assertIsInstance(result, dict)

    def test_python_311_exactly_passes(self):
        """Python 3.11.0 exactly must pass the version check (>= 3.11)."""
        version_311 = (3, 11, 0, "final", 0)
        with patch("sys.version_info", version_311), \
             patch("src.claude_gates.session_context.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            result = self.on_session_start({})
        self.assertIn("additionalContext", result)
        self.assertNotIn("systemMessage", result)

    def test_python_312_passes(self):
        """Python 3.12 must pass (clearly >= 3.11)."""
        version_312 = (3, 12, 0, "final", 0)
        with patch("sys.version_info", version_312), \
             patch("src.claude_gates.session_context.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.session_context.discover_gated_agents", return_value=[]):
            result = self.on_session_start({})
        self.assertIn("additionalContext", result)
        self.assertNotIn("systemMessage", result)

    def test_python_39_fails_with_correct_version_in_message(self):
        """Python 3.9 — message contains '3.9'."""
        old_version = (3, 9, 7, "final", 0)
        with patch("sys.version_info", old_version):
            result = self.on_session_start({})
        self.assertIn("3.9", result["systemMessage"])

    def test_old_python_no_banner_injection(self):
        """When version < 3.11, build_banner is never called (no side effects)."""
        old_version = (3, 10, 0, "final", 0)
        with patch("sys.version_info", old_version), \
             patch("src.claude_gates.session_context.build_banner") as mock_banner:
            self.on_session_start({})
        mock_banner.assert_not_called()

    def test_module_has_no_unconditional_311_imports(self):
        """session_context.py must not import claude_gates.types or claude_gates.parser
        at module level unconditionally — those modules use StrEnum (3.11+) and would
        cause ImportError on Python 3.10 before on_session_start() is reached.

        Verified via AST: any ImportFrom of claude_gates.types or claude_gates.parser
        must be nested inside an If node (version guard), not at module top level.
        """
        import ast
        import pathlib

        src_path = pathlib.Path(_PROJECT_ROOT) / "src" / "claude_gates" / "session_context.py"
        source = src_path.read_text(encoding="utf-8")
        tree = ast.parse(source)

        # Collect all top-level ImportFrom nodes (direct children of module body)
        unsafe_modules = {"claude_gates.types", "claude_gates.parser"}
        top_level_imports = []
        for node in ast.iter_child_nodes(tree):
            if isinstance(node, ast.ImportFrom):
                full_name = node.module or ""
                if full_name in unsafe_modules:
                    top_level_imports.append(full_name)

        self.assertEqual(
            top_level_imports,
            [],
            msg=(
                f"Found unconditional top-level import(s) of 3.11+-only modules in "
                f"session_context.py: {top_level_imports}. "
                f"These must be guarded by 'if sys.version_info >= (3, 11):' so the "
                f"module is importable on Python 3.10."
            ),
        )

    def test_311_imports_guarded_by_correct_version_condition(self):
        """The If guard wrapping claude_gates.types/parser imports must test
        sys.version_info >= (3, 11) exactly — not (3, 9), (4, 0), or any other tuple.

        Validated via AST structural match:
          Compare(
            left=Attribute(value=Name(id='sys'), attr='version_info'),
            ops=[GtE()],
            comparators=[Tuple(elts=[Constant(3), Constant(11)])]
          )
        """
        import ast
        import pathlib

        src_path = pathlib.Path(_PROJECT_ROOT) / "src" / "claude_gates" / "session_context.py"
        source = src_path.read_text(encoding="utf-8")
        tree = ast.parse(source)

        unsafe_modules = {"claude_gates.types", "claude_gates.parser"}

        def _is_version_311_guard(if_test: ast.expr) -> bool:
            """Return True iff if_test is sys.version_info >= (3, 11)."""
            if not isinstance(if_test, ast.Compare):
                return False
            left = if_test.left
            if not (isinstance(left, ast.Attribute) and left.attr == "version_info"):
                return False
            if not (isinstance(left.value, ast.Name) and left.value.id == "sys"):
                return False
            if len(if_test.ops) != 1 or not isinstance(if_test.ops[0], ast.GtE):
                return False
            if len(if_test.comparators) != 1:
                return False
            tup = if_test.comparators[0]
            if not isinstance(tup, ast.Tuple) or len(tup.elts) != 2:
                return False
            major, minor = tup.elts
            if not (isinstance(major, ast.Constant) and major.value == 3):
                return False
            if not (isinstance(minor, ast.Constant) and minor.value == 11):
                return False
            return True

        # Find all If nodes at module top level that contain guarded imports
        guarded_by_correct_condition = []
        guarded_by_wrong_condition = []

        for node in ast.iter_child_nodes(tree):
            if not isinstance(node, ast.If):
                continue
            # Check whether this If body contains any of the unsafe imports
            for body_node in ast.walk(node):
                if isinstance(body_node, ast.ImportFrom):
                    full_name = body_node.module or ""
                    if full_name in unsafe_modules:
                        if _is_version_311_guard(node.test):
                            guarded_by_correct_condition.append(full_name)
                        else:
                            guarded_by_wrong_condition.append(full_name)
                        break

        self.assertEqual(
            guarded_by_wrong_condition,
            [],
            msg=(
                f"Import(s) {guarded_by_wrong_condition} are inside an If block but the "
                f"condition is NOT 'sys.version_info >= (3, 11)'. "
                f"The guard must use exactly (3, 11) to protect against Python 3.10."
            ),
        )
        self.assertTrue(
            len(guarded_by_correct_condition) > 0,
            msg=(
                "Expected at least one of claude_gates.types / claude_gates.parser to be "
                "guarded by 'if sys.version_info >= (3, 11):' but none was found."
            ),
        )


if __name__ == "__main__":
    unittest.main()
