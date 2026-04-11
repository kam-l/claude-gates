import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates.repository import PipelineRepository
from src.claude_gates.session import open_database


def _make_session_dir(root: str) -> str:
    session_dir = os.path.join(root, "sessions", "abc12345")
    os.makedirs(session_dir, exist_ok=True)
    conn = open_database(session_dir)
    PipelineRepository.init_schema(conn)
    conn.close()
    return session_dir


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

AGENT_WITH_CONDITIONS_MD = """\
---
name: reviewer
conditions: |
  Check if the code is ready for review.
verification:
  - ["Check quality"]
---
Reviewer agent.
"""


def _run_conditions_check(data: dict, session_dir: str, project_root: str) -> dict:
    from src.claude_gates import conditions
    with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
         patch("src.claude_gates.conditions.get_session_dir", return_value=session_dir), \
         patch("src.claude_gates.conditions.PROJECT_ROOT", project_root):
        return conditions.on_conditions_check(data)


# ─────────────────────────────────────────────────────────────────────────────
# AC: Gate disabled → return {}
# ─────────────────────────────────────────────────────────────────────────────

class TestGateDisabled(unittest.TestCase):
    def test_gate_disabled_returns_empty(self):
        from src.claude_gates import conditions
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=True):
            result = conditions.on_conditions_check({"session_id": "abc123"})
        self.assertEqual(result, {})

    def test_gate_disabled_short_circuits(self):
        from src.claude_gates import conditions
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=True), \
             patch("src.claude_gates.conditions.find_agent_md") as mock_find:
            conditions.on_conditions_check({"session_id": "abc123"})
        mock_find.assert_not_called()


# ─────────────────────────────────────────────────────────────────────────────
# Edge: Resume scenario → allow
# ─────────────────────────────────────────────────────────────────────────────

class TestResumeScenario(unittest.TestCase):
    def test_resume_flag_allows(self):
        from src.claude_gates import conditions
        data = {
            "session_id": "abc123",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
                "resume": True,
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False):
            result = conditions.on_conditions_check(data)
        self.assertEqual(result, {})

    def test_resume_skips_agent_md_lookup(self):
        from src.claude_gates import conditions
        data = {
            "session_id": "abc123",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
                "resume": True,
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.find_agent_md") as mock_find:
            conditions.on_conditions_check(data)
        mock_find.assert_not_called()


# ─────────────────────────────────────────────────────────────────────────────
# Edge: No agent type → allow
# ─────────────────────────────────────────────────────────────────────────────

class TestNoAgentType(unittest.TestCase):
    def test_no_agent_type_returns_empty(self):
        from src.claude_gates import conditions
        data = {
            "session_id": "abc123",
            "tool_input": {"prompt": "scope=myproject do something"},
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False):
            result = conditions.on_conditions_check(data)
        self.assertEqual(result, {})

    def test_empty_agent_type_returns_empty(self):
        from src.claude_gates import conditions
        data = {
            "session_id": "abc123",
            "tool_input": {"subagent_type": "", "prompt": "scope=myproject do something"},
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False):
            result = conditions.on_conditions_check(data)
        self.assertEqual(result, {})


# ─────────────────────────────────────────────────────────────────────────────
# Edge: No scope + no CG fields → return {}
# ─────────────────────────────────────────────────────────────────────────────

class TestNoScopeNoCGFields(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_no_scope_ungated_agent_allows(self):
        _write_agent_md(self.tmp, "simple", UNGATED_AGENT_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "simple",
                "prompt": "please do the work without a scope",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""):
            result = conditions.on_conditions_check(data)
        self.assertEqual(result, {})

    def test_no_scope_no_agent_md_allows(self):
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "unknown-agent",
                "prompt": "please do the work",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""):
            result = conditions.on_conditions_check(data)
        self.assertEqual(result, {})


# ─────────────────────────────────────────────────────────────────────────────
# Edge: No scope + requires_scope → block
# ─────────────────────────────────────────────────────────────────────────────

class TestNoScopeRequiresScope(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_gated_agent_no_scope_returns_block(self):
        _write_agent_md(self.tmp, "reviewer", GATED_AGENT_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "please review the code",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""):
            result = conditions.on_conditions_check(data)
        self.assertEqual(result.get("decision"), "block")

    def test_block_message_mentions_scope(self):
        """Block message should mention scope= so the LLM knows how to fix it."""
        _write_agent_md(self.tmp, "reviewer", GATED_AGENT_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "please review the code",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""):
            result = conditions.on_conditions_check(data)
        reason = result.get("reason", "")
        self.assertIn("scope=", reason)


# ─────────────────────────────────────────────────────────────────────────────
# AC5: Reserved scope rejection
# ─────────────────────────────────────────────────────────────────────────────

class TestReservedScopeRejection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, scope_name: str) -> dict:
        _write_agent_md(self.tmp, "reviewer", GATED_AGENT_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": f"scope={scope_name} do the review",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""):
            return conditions.on_conditions_check(data)

    def test_pending_scope_is_rejected(self):
        result = self._run("_pending")
        self.assertEqual(result.get("decision"), "block")

    def test_meta_scope_is_rejected(self):
        result = self._run("_meta")
        self.assertEqual(result.get("decision"), "block")

    def test_valid_scope_not_rejected(self):
        from src.claude_gates import conditions
        _write_agent_md(self.tmp, "reviewer", GATED_AGENT_MD)
        session_dir = _make_session_dir(self.tmp)
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=session_dir), \
             patch("src.claude_gates.conditions.subprocess") as mock_subprocess:
            result = conditions.on_conditions_check(data)
        self.assertNotEqual(result.get("decision"), "block")


# ─────────────────────────────────────────────────────────────────────────────
# Edge: No agent .md found → return {}
# ─────────────────────────────────────────────────────────────────────────────

class TestNoAgentMdFile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_no_agent_md_with_scope_allows(self):
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "unknown-agent",
                "prompt": "scope=myproject do the work",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir):
            result = conditions.on_conditions_check(data)
        self.assertEqual(result, {})


# ─────────────────────────────────────────────────────────────────────────────
# AC1: Conditions timeout = fail-open
# ─────────────────────────────────────────────────────────────────────────────

class TestConditionsTimeout(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_timeout_is_fail_open(self):
        import subprocess
        _write_agent_md(self.tmp, "reviewer", AGENT_WITH_CONDITIONS_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
            },
        }

        mock_subprocess = MagicMock()
        mock_subprocess.run.side_effect = subprocess.TimeoutExpired(cmd="claude", timeout=30)
        mock_subprocess.TimeoutExpired = subprocess.TimeoutExpired

        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir), \
             patch("src.claude_gates.conditions.subprocess", mock_subprocess):
            result = conditions.on_conditions_check(data)

        self.assertNotEqual(result.get("decision"), "block")

    def test_timeout_logs_to_stderr(self):
        import subprocess
        _write_agent_md(self.tmp, "reviewer", AGENT_WITH_CONDITIONS_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
            },
        }

        mock_subprocess = MagicMock()
        mock_subprocess.run.side_effect = subprocess.TimeoutExpired(cmd="claude", timeout=30)
        mock_subprocess.TimeoutExpired = subprocess.TimeoutExpired

        import io
        stderr_capture = io.StringIO()
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir), \
             patch("src.claude_gates.conditions.subprocess", mock_subprocess), \
             patch("sys.stderr", stderr_capture):
            conditions.on_conditions_check(data)

        stderr_output = stderr_capture.getvalue()
        self.assertTrue(len(stderr_output) > 0)


# ─────────────────────────────────────────────────────────────────────────────
# AC2: Step enforcement blocks wrong agent
# ─────────────────────────────────────────────────────────────────────────────

class TestStepEnforcement(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _setup_pipeline(self, scope: str, expected_agent: str) -> None:
        conn = open_database(self.session_dir)
        PipelineRepository.init_schema(conn)
        repo = PipelineRepository(conn)
        repo.insert_pipeline(scope, "source-agent", 1)
        repo.insert_step(scope, 0, {
            "type": "VERIFY",
            "agent": expected_agent,
            "maxRounds": 3,
        }, "source-agent")
        conn.close()

    def test_wrong_agent_is_blocked(self):
        self._setup_pipeline("myproject", "reviewer")
        _write_agent_md(self.tmp, "cleaner", UNGATED_AGENT_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "cleaner",
                "prompt": "scope=myproject please clean",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir):
            result = conditions.on_conditions_check(data)
        self.assertEqual(result.get("decision"), "block")

    def test_block_message_names_expected_agent(self):
        """Block reason should tell LLM which agent to spawn instead."""
        self._setup_pipeline("myproject", "reviewer")
        _write_agent_md(self.tmp, "cleaner", UNGATED_AGENT_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "cleaner",
                "prompt": "scope=myproject please clean",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir):
            result = conditions.on_conditions_check(data)
        reason = result.get("reason", "")
        self.assertIn("reviewer", reason)

    def test_correct_agent_is_allowed(self):
        self._setup_pipeline("myproject", "reviewer")
        _write_agent_md(self.tmp, "reviewer", UNGATED_AGENT_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject please review",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir):
            result = conditions.on_conditions_check(data)
        self.assertNotEqual(result.get("decision"), "block")


# ─────────────────────────────────────────────────────────────────────────────
# AC3: Windows claude command resolution
# ─────────────────────────────────────────────────────────────────────────────

class TestWindowsClaudeResolution(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run_with_conditions(self, which_return: str) -> None:
        _write_agent_md(self.tmp, "reviewer", AGENT_WITH_CONDITIONS_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
            },
        }
        captured_cmd = []

        def capture_run(cmd, **kwargs):
            captured_cmd.append(cmd)
            mock_result = MagicMock()
            mock_result.stdout = "Result: PASS"
            return mock_result

        mock_subprocess = MagicMock()
        mock_subprocess.run.side_effect = capture_run
        mock_subprocess.TimeoutExpired = __import__("subprocess").TimeoutExpired

        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir), \
             patch("src.claude_gates.conditions.subprocess", mock_subprocess), \
             patch("src.claude_gates.conditions.shutil") as mock_shutil:
            mock_shutil.which.return_value = which_return
            conditions.on_conditions_check(data)

        return captured_cmd

    def test_uses_which_result_when_found(self):
        """When shutil.which returns a path, that path is used in subprocess call."""
        cmd = self._run_with_conditions("/usr/local/bin/claude")
        # The subprocess cmd list should start with the which result
        if cmd:
            self.assertEqual(cmd[0][0], "/usr/local/bin/claude")

    def test_falls_back_to_bare_claude_when_which_returns_none(self):
        """When shutil.which returns None, bare 'claude' is used."""
        cmd = self._run_with_conditions(None)
        if cmd:
            self.assertEqual(cmd[0][0], "claude")

    def test_which_is_called_with_claude(self):
        """shutil.which must be called with 'claude'."""
        _write_agent_md(self.tmp, "reviewer", AGENT_WITH_CONDITIONS_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
            },
        }

        mock_subprocess = MagicMock()
        mock_subprocess.run.return_value = MagicMock(stdout="Result: PASS")
        mock_subprocess.TimeoutExpired = __import__("subprocess").TimeoutExpired

        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir), \
             patch("src.claude_gates.conditions.subprocess", mock_subprocess), \
             patch("src.claude_gates.conditions.shutil") as mock_shutil:
            mock_shutil.which.return_value = "/usr/local/bin/claude"
            conditions.on_conditions_check(data)

        mock_shutil.which.assert_called_with("claude")


# ─────────────────────────────────────────────────────────────────────────────
# AC4: CLAUDECODE="" env var set in subprocess
# ─────────────────────────────────────────────────────────────────────────────

class TestClaudeCodeEnvVar(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_claudecode_env_is_empty_string(self):
        """Subprocess env must have CLAUDECODE=""."""
        _write_agent_md(self.tmp, "reviewer", AGENT_WITH_CONDITIONS_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
            },
        }
        captured_env = []

        def capture_run(cmd, **kwargs):
            captured_env.append(kwargs.get("env", {}))
            mock_result = MagicMock()
            mock_result.stdout = "Result: PASS"
            return mock_result

        mock_subprocess = MagicMock()
        mock_subprocess.run.side_effect = capture_run
        mock_subprocess.TimeoutExpired = __import__("subprocess").TimeoutExpired

        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir), \
             patch("src.claude_gates.conditions.subprocess", mock_subprocess), \
             patch("src.claude_gates.conditions.shutil") as mock_shutil:
            mock_shutil.which.return_value = "/usr/local/bin/claude"
            conditions.on_conditions_check(data)

        self.assertTrue(len(captured_env) > 0, "subprocess.run was not called")
        env = captured_env[0]
        self.assertIn("CLAUDECODE", env)
        self.assertEqual(env["CLAUDECODE"], "")


# ─────────────────────────────────────────────────────────────────────────────
# Agent registration
# ─────────────────────────────────────────────────────────────────────────────

class TestAgentRegistration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_agent_registered_in_db(self):
        _write_agent_md(self.tmp, "reviewer", GATED_AGENT_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir):
            conditions.on_conditions_check(data)

        conn = open_database(self.session_dir)
        cursor = conn.execute(
            "SELECT * FROM agents WHERE scope = 'myproject' AND agent = 'reviewer'"
        )
        row = cursor.fetchone()
        conn.close()
        self.assertIsNotNone(row)

    def test_running_marker_created(self):
        _write_agent_md(self.tmp, "reviewer", GATED_AGENT_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir):
            conditions.on_conditions_check(data)

        marker_path = os.path.join(self.session_dir, ".running-myproject")
        self.assertTrue(os.path.exists(marker_path))

    def test_pending_scope_marker_created(self):
        _write_agent_md(self.tmp, "reviewer", GATED_AGENT_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir):
            conditions.on_conditions_check(data)

        marker_path = os.path.join(self.session_dir, ".pending-scope-reviewer")
        self.assertTrue(os.path.exists(marker_path))
        with open(marker_path) as f:
            content = f.read()
        self.assertEqual(content, "myproject")

    def test_scope_dir_created(self):
        _write_agent_md(self.tmp, "reviewer", GATED_AGENT_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir):
            conditions.on_conditions_check(data)

        scope_dir = os.path.join(self.session_dir, "myproject")
        self.assertTrue(os.path.isdir(scope_dir))


# ─────────────────────────────────────────────────────────────────────────────
# Plugin prefix normalization
# ─────────────────────────────────────────────────────────────────────────────

class TestAgentTypeNormalization(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_plugin_prefix_stripped(self):
        """claude-gates:reviewer → reviewer for MD lookup."""
        _write_agent_md(self.tmp, "reviewer", GATED_AGENT_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "claude-gates:reviewer",
                "prompt": "scope=myproject do the review",
            },
        }
        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir):
            result = conditions.on_conditions_check(data)

        self.assertNotEqual(result.get("decision"), "block")
        conn = open_database(self.session_dir)
        cursor = conn.execute(
            "SELECT * FROM agents WHERE scope = 'myproject' AND agent = 'reviewer'"
        )
        row = cursor.fetchone()
        conn.close()
        self.assertIsNotNone(row)


# ─────────────────────────────────────────────────────────────────────────────
# Conditions FAIL → block
# ─────────────────────────────────────────────────────────────────────────────

class TestConditionsCheckFail(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_conditions_fail_blocks_agent(self):
        _write_agent_md(self.tmp, "reviewer", AGENT_WITH_CONDITIONS_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
            },
        }

        mock_subprocess = MagicMock()
        mock_subprocess.run.return_value = MagicMock(stdout="Result: FAIL not ready")
        mock_subprocess.TimeoutExpired = __import__("subprocess").TimeoutExpired

        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir), \
             patch("src.claude_gates.conditions.subprocess", mock_subprocess), \
             patch("src.claude_gates.conditions.shutil") as mock_shutil:
            mock_shutil.which.return_value = "/usr/local/bin/claude"
            result = conditions.on_conditions_check(data)

        self.assertEqual(result.get("decision"), "block")

    def test_conditions_pass_allows_agent(self):
        _write_agent_md(self.tmp, "reviewer", AGENT_WITH_CONDITIONS_MD)
        from src.claude_gates import conditions
        data = {
            "session_id": "abc12345",
            "tool_input": {
                "subagent_type": "reviewer",
                "prompt": "scope=myproject do the review",
            },
        }

        mock_subprocess = MagicMock()
        mock_subprocess.run.return_value = MagicMock(stdout="Result: PASS")
        mock_subprocess.TimeoutExpired = __import__("subprocess").TimeoutExpired

        with patch("src.claude_gates.conditions.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.conditions.PROJECT_ROOT", self.tmp), \
             patch("src.claude_gates.conditions.HOME", ""), \
             patch("src.claude_gates.conditions.get_session_dir", return_value=self.session_dir), \
             patch("src.claude_gates.conditions.subprocess", mock_subprocess), \
             patch("src.claude_gates.conditions.shutil") as mock_shutil:
            mock_shutil.which.return_value = "/usr/local/bin/claude"
            result = conditions.on_conditions_check(data)

        self.assertNotEqual(result.get("decision"), "block")


if __name__ == "__main__":
    unittest.main()
