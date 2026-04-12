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
from src.claude_gates.types import StepStatus, StepType


def _make_session_dir(root: str) -> str:
    session_dir = os.path.join(root, "sessions", "abc12345")
    os.makedirs(session_dir, exist_ok=True)
    conn = open_database(session_dir)
    PipelineRepository.init_schema(conn)
    conn.close()
    return session_dir


def _setup_pipeline(session_dir: str, scope: str, source_agent: str = "source-agent",
                    step_type: str = "VERIFY", agent: str = "reviewer", max_rounds: int = 3) -> None:
    conn = open_database(session_dir)
    PipelineRepository.init_schema(conn)
    repo = PipelineRepository(conn)
    repo.insert_pipeline(scope, source_agent, 1)
    repo.insert_step(scope, 0, {
        "type": step_type,
        "agent": agent,
        "maxRounds": max_rounds,
    }, source_agent)
    conn.close()


def _run_block(data: dict, session_dir: str) -> dict:
    from src.claude_gates import block
    with patch("src.claude_gates.block.is_gate_disabled", return_value=False), \
         patch("src.claude_gates.block.get_session_dir", return_value=session_dir):
        return block.on_pre_tool_use(data)


# ─────────────────────────────────────────────────────────────────────────────
# AC1: Gate disabled or no session → allow
# ─────────────────────────────────────────────────────────────────────────────

class TestGateDisabledOrNoSession(unittest.TestCase):
    def test_gate_disabled_returns_empty(self):
        from src.claude_gates import block
        with patch("src.claude_gates.block.is_gate_disabled", return_value=True):
            result = block.on_pre_tool_use({"session_id": "abc12345", "tool_name": "Write"})
        self.assertEqual(result, {})

    def test_no_session_id_returns_empty(self):
        from src.claude_gates import block
        with patch("src.claude_gates.block.is_gate_disabled", return_value=False):
            result = block.on_pre_tool_use({"session_id": "", "tool_name": "Write"})
        self.assertEqual(result, {})

    def test_missing_session_id_returns_empty(self):
        from src.claude_gates import block
        with patch("src.claude_gates.block.is_gate_disabled", return_value=False):
            result = block.on_pre_tool_use({"tool_name": "Write"})
        self.assertEqual(result, {})


# ─────────────────────────────────────────────────────────────────────────────
# AC2: Drain pending notifications on every call
# ─────────────────────────────────────────────────────────────────────────────

class TestDrainNotifications(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_drain_called_with_session_dir(self):
        from src.claude_gates import block
        data = {"session_id": "abc12345", "tool_name": "Read"}
        with patch("src.claude_gates.block.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.block.get_session_dir", return_value=self.session_dir), \
             patch("src.claude_gates.block.messaging") as mock_msg:
            mock_msg.drain_notifications.return_value = None
            mock_msg.info.return_value = {}
            block.on_pre_tool_use(data)
        mock_msg.drain_notifications.assert_called_once_with(self.session_dir)

    def test_notifications_surfaced_when_no_active_actions(self):
        """When no active pipeline actions, pending notifications are surfaced via info."""
        from src.claude_gates import block
        data = {"session_id": "abc12345", "tool_name": "Write"}
        with patch("src.claude_gates.block.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.block.get_session_dir", return_value=self.session_dir), \
             patch("src.claude_gates.block.messaging") as mock_msg:
            mock_msg.drain_notifications.return_value = "[ClaudeGates] step done"
            mock_msg.info.return_value = {"systemMessage": "[ClaudeGates]  step done"}
            result = block.on_pre_tool_use(data)
        mock_msg.info.assert_called_once()
        # First arg is emoji, second is text (stripped of [ClaudeGates] prefix)
        args = mock_msg.info.call_args
        self.assertEqual(result, {"systemMessage": "[ClaudeGates]  step done"})


# ─────────────────────────────────────────────────────────────────────────────
# AC3: No active actions → allow (with optional notifications)
# ─────────────────────────────────────────────────────────────────────────────

class TestNoActiveActions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_no_pipeline_no_notifications_returns_empty(self):
        """No active pipeline and no notifications → {}."""
        data = {"session_id": "abc12345", "tool_name": "Write"}
        result = _run_block(data, self.session_dir)
        self.assertEqual(result, {})

    def test_no_pipeline_with_notifications_returns_info(self):
        """No active pipeline but notifications pending → info message."""
        from src.claude_gates import block
        # Write a notification file
        notif_file = os.path.join(self.session_dir, ".pipeline-notifications")
        with open(notif_file, "w") as f:
            f.write("[ClaudeGates] Pipeline step completed\n")

        data = {"session_id": "abc12345", "tool_name": "Write"}
        with patch("src.claude_gates.block.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.block.get_session_dir", return_value=self.session_dir):
            result = block.on_pre_tool_use(data)

        self.assertIn("systemMessage", result)

    def test_none_actions_treated_as_empty(self):
        """actions=None (DB error scenario) → treat as empty, allow."""
        from src.claude_gates import block
        data = {"session_id": "abc12345", "tool_name": "Write"}
        with patch("src.claude_gates.block.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.block.get_session_dir", return_value=self.session_dir), \
             patch("src.claude_gates.block.PipelineEngine") as MockEngine:
            mock_engine = MockEngine.return_value
            mock_engine.get_all_next_actions.return_value = None
            result = block.on_pre_tool_use(data)
        self.assertEqual(result, {})


# ─────────────────────────────────────────────────────────────────────────────
# AC4: Subagent callers always allowed
# ─────────────────────────────────────────────────────────────────────────────

class TestSubagentCallersAllowed(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)
        _setup_pipeline(self.session_dir, "myproject")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_subagent_with_agent_type_allowed(self):
        """Tool call from a subagent (agent_type set) → always allow."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Write",
            "agent_type": "some-subagent",
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result, {})

    def test_empty_agent_type_not_exempt(self):
        """Empty agent_type string is not a subagent exemption."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Write",
            "agent_type": "",
        }
        result = _run_block(data, self.session_dir)
        # Should proceed to other checks (not immediately allowed)
        # With an active pipeline, this should eventually block
        self.assertNotEqual(result, {})  # Should be blocked


# ─────────────────────────────────────────────────────────────────────────────
# AC5: Allowlisted tools always pass
# ─────────────────────────────────────────────────────────────────────────────

class TestAllowlistedTools(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)
        _setup_pipeline(self.session_dir, "myproject")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _test_tool_allowed(self, tool_name: str):
        data = {"session_id": "abc12345", "tool_name": tool_name}
        result = _run_block(data, self.session_dir)
        self.assertEqual(result, {}, f"Expected {tool_name} to be allowed, got: {result}")

    def test_read_allowed(self):
        self._test_tool_allowed("Read")

    def test_glob_allowed(self):
        self._test_tool_allowed("Glob")

    def test_grep_allowed(self):
        self._test_tool_allowed("Grep")

    def test_task_create_allowed(self):
        self._test_tool_allowed("TaskCreate")

    def test_task_update_allowed(self):
        self._test_tool_allowed("TaskUpdate")

    def test_task_get_allowed(self):
        self._test_tool_allowed("TaskGet")

    def test_task_list_allowed(self):
        self._test_tool_allowed("TaskList")

    def test_send_message_allowed(self):
        self._test_tool_allowed("SendMessage")

    def test_tool_search_allowed(self):
        self._test_tool_allowed("ToolSearch")

    def test_write_not_in_allowlist(self):
        """Write is NOT in allowlist (session path writes are blocked)."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Write",
            "tool_input": {"file_path": self.session_dir + "/myproject/artifact.md"},
        }
        result = _run_block(data, self.session_dir)
        self.assertIn("decision", result)
        self.assertEqual(result["decision"], "block")


# ─────────────────────────────────────────────────────────────────────────────
# AC6: Running-marker skips blocking for that scope
# ─────────────────────────────────────────────────────────────────────────────

class TestRunningMarkerSkipsBlocking(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)
        _setup_pipeline(self.session_dir, "myproject")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_running_marker_allows_tool(self):
        """When .running-{scope} marker exists, that scope is skipped → allow."""
        marker = os.path.join(self.session_dir, ".running-myproject")
        with open(marker, "w") as f:
            f.write("")

        data = {
            "session_id": "abc12345",
            "tool_name": "Write",
            "tool_input": {"file_path": "/some/other/path.md"},
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result, {})

    def test_no_running_marker_still_blocks(self):
        """Without marker, scope actions still block."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Write",
            "tool_input": {"file_path": self.session_dir + "/myproject/artifact.md"},
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result.get("decision"), "block")


# ─────────────────────────────────────────────────────────────────────────────
# AC7: Write/Edit to non-session paths allowed
# ─────────────────────────────────────────────────────────────────────────────

class TestWriteEditNonSessionPaths(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)
        _setup_pipeline(self.session_dir, "myproject")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_write_to_non_session_path_allowed(self):
        """Write to a path outside session_dir is allowed."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Write",
            "tool_input": {"file_path": "/some/other/path.py"},
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result, {})

    def test_edit_to_non_session_path_allowed(self):
        """Edit to a path outside session_dir is allowed."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Edit",
            "tool_input": {"file_path": "/some/other/path.py"},
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result, {})

    def test_write_to_session_path_blocked(self):
        """Write to a path inside session_dir is blocked."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Write",
            "tool_input": {"file_path": self.session_dir + "/myproject/artifact.md"},
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result.get("decision"), "block")

    def test_edit_to_session_path_blocked(self):
        """Edit to a path inside session_dir is blocked."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Edit",
            "tool_input": {"file_path": self.session_dir + "/myproject/artifact.md"},
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result.get("decision"), "block")

    def test_backslash_path_normalized(self):
        """Backslashes in file_path are normalized to forward slashes before comparison."""
        # session_dir uses forward slashes already (from session.get_session_dir)
        # Use a non-session path with backslashes → should be allowed
        data = {
            "session_id": "abc12345",
            "tool_name": "Write",
            "tool_input": {"file_path": "C:\\some\\other\\path.py"},
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result, {})

    def test_missing_tool_input_allowed(self):
        """Write with no tool_input dict → default to {} → treat as non-session path, allow."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Write",
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result, {})

    def test_tool_input_not_dict_allowed(self):
        """Write with tool_input not a dict → default to {} → allow."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Write",
            "tool_input": "not-a-dict",
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result, {})

    def test_session_dir_backslash_in_comparison(self):
        """If session_dir itself has backslashes, the comparison must still block session writes."""
        from src.claude_gates import block
        # Simulate a session_dir with backslashes (Windows path not yet normalized)
        win_session_dir = self.session_dir.replace("/", "\\")
        # The file_path uses forward slashes but matches the session_dir location
        file_path = self.session_dir + "/myproject/artifact.md"
        data = {
            "session_id": "abc12345",
            "tool_name": "Write",
            "tool_input": {"file_path": file_path},
        }
        # Patch get_session_dir to return backslash version
        with patch("src.claude_gates.block.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.block.get_session_dir", return_value=win_session_dir):
            result = block.on_pre_tool_use(data)
        # After normalization of both sides, session path should still be blocked
        self.assertEqual(result.get("decision"), "block")


# ─────────────────────────────────────────────────────────────────────────────
# AC8: Agent tool spawning expected agent → allow
# ─────────────────────────────────────────────────────────────────────────────

class TestAgentToolSpawningExpectedAgent(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)
        _setup_pipeline(self.session_dir, "myproject", agent="reviewer")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_agent_tool_with_expected_agent_allowed(self):
        """Agent tool spawning the expected agent name → allow."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "reviewer"},
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result, {})

    def test_agent_tool_with_unexpected_agent_blocked(self):
        """Agent tool spawning unexpected agent name → block."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "unexpected-agent"},
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result.get("decision"), "block")

    def test_agent_tool_multiple_scopes_deduplication(self):
        """Multiple scopes with same agent name → Set deduplication handles it."""
        _setup_pipeline(self.session_dir, "otherscope", agent="reviewer")
        data = {
            "session_id": "abc12345",
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "reviewer"},
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result, {})

    def test_agent_tool_uses_subagent_type_not_agent_type(self):
        """AC8 uses tool_input.subagent_type (the spawned agent), not data.agent_type (caller).
        These are distinct: data.agent_type empty = orchestrator caller; tool_input.subagent_type
        = the Agent tool target. Using agent_type from tool_input would be the wrong field."""
        data = {
            "session_id": "abc12345",
            "tool_name": "Agent",
            # Correct field: subagent_type = the agent being spawned
            "tool_input": {"subagent_type": "reviewer"},
            # agent_type is empty (orchestrator caller, not a subagent)
            "agent_type": "",
        }
        result = _run_block(data, self.session_dir)
        self.assertEqual(result, {})


# ─────────────────────────────────────────────────────────────────────────────
# AC9: Block message framed as instructions, not errors
# ─────────────────────────────────────────────────────────────────────────────

class TestBlockMessageFormat(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_block_message_starts_with_pipeline_actions_pending(self):
        """Block message must start with the framing text."""
        _setup_pipeline(self.session_dir, "myproject", agent="reviewer")
        data = {
            "session_id": "abc12345",
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "unexpected-agent"},
        }
        result = _run_block(data, self.session_dir)
        reason = result.get("reason", "")
        self.assertIn("Pipeline actions pending (this is normal flow, not an error).", reason)

    def test_spawn_action_message_format(self):
        """Spawn action shows Spawn {agent} (scope={scope}, round {attempt}/{max}): {reason}."""
        _setup_pipeline(self.session_dir, "myproject", agent="reviewer", max_rounds=3)
        data = {
            "session_id": "abc12345",
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "unexpected-agent"},
        }
        result = _run_block(data, self.session_dir)
        reason = result.get("reason", "")
        self.assertIn("Spawn reviewer", reason)
        self.assertIn("scope=myproject", reason)
        self.assertIn("round", reason)

    def test_source_action_message_format(self):
        """Source/revision action shows Spawn/Resume {agent} (scope={scope}){reason}."""
        # Set up a pipeline in revision state
        conn = open_database(self.session_dir)
        PipelineRepository.init_schema(conn)
        repo = PipelineRepository(conn)
        repo.insert_pipeline("myproject", "source-agent", 1)
        repo.insert_step("myproject", 0, {
            "type": "VERIFY",
            "agent": "reviewer",
            "maxRounds": 3,
        }, "source-agent")
        # Force status to revision (revise)
        repo.update_step_status("myproject", 0, StepStatus.Revise, 1)
        repo.update_pipeline_state("myproject", {"status": "revision", "revision_step": 0})
        conn.close()

        data = {
            "session_id": "abc12345",
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "unexpected-agent"},
        }
        result = _run_block(data, self.session_dir)
        reason = result.get("reason", "")
        # In revision state, source-agent needs to Resume/Spawn
        self.assertIn("source-agent", reason)
        self.assertIn("scope=myproject", reason)

    def test_notifications_appended_to_block_message(self):
        """When blocking AND notifications pending, notifications appended with Context:."""
        _setup_pipeline(self.session_dir, "myproject", agent="reviewer")
        notif_file = os.path.join(self.session_dir, ".pipeline-notifications")
        with open(notif_file, "w") as f:
            f.write("[ClaudeGates] Step completed\n")

        data = {
            "session_id": "abc12345",
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "unexpected-agent"},
        }
        result = _run_block(data, self.session_dir)
        reason = result.get("reason", "")
        self.assertIn("Context:", reason)

    def test_duplicate_notifications_deduplicated(self):
        """Duplicate notification lines are deduplicated and joined with ' | '."""
        _setup_pipeline(self.session_dir, "myproject", agent="reviewer")
        notif_file = os.path.join(self.session_dir, ".pipeline-notifications")
        with open(notif_file, "w") as f:
            f.write("[ClaudeGates] Step done\n[ClaudeGates] Step done\n[ClaudeGates] Step done\n")

        data = {
            "session_id": "abc12345",
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "unexpected-agent"},
        }
        result = _run_block(data, self.session_dir)
        reason = result.get("reason", "")
        # Should have step done only once (not three times)
        self.assertIn("Context:", reason)
        # Count occurrences - deduplicated means it appears only once
        context_part = reason.split("Context:")[-1] if "Context:" in reason else ""
        self.assertEqual(context_part.count("Step done"), 1)


# ─────────────────────────────────────────────────────────────────────────────
# AC10: Langfuse tracing for block decisions
# ─────────────────────────────────────────────────────────────────────────────

class TestTracingForBlockDecisions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)
        _setup_pipeline(self.session_dir, "myproject", agent="reviewer")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_tracing_called_when_blocking(self):
        """When blocking, tracing.init() is called."""
        from src.claude_gates import block
        data = {
            "session_id": "abc12345",
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "unexpected-agent"},
        }
        with patch("src.claude_gates.block.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.block.get_session_dir", return_value=self.session_dir), \
             patch("src.claude_gates.block.tracing") as mock_tracing:
            mock_tracing.init.return_value = {"langfuse": MagicMock(), "enabled": True}
            mock_tracing.session_trace_id.return_value = "abc123trace"
            mock_tracing.scope_span.return_value = MagicMock()
            block.on_pre_tool_use(data)
        mock_tracing.init.assert_called_once()

    def test_tracing_errors_caught_silently(self):
        """Tracing errors must not cause block hook to fail (fail-open)."""
        from src.claude_gates import block
        data = {
            "session_id": "abc12345",
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "unexpected-agent"},
        }
        with patch("src.claude_gates.block.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.block.get_session_dir", return_value=self.session_dir), \
             patch("src.claude_gates.block.tracing") as mock_tracing:
            mock_tracing.init.side_effect = RuntimeError("tracing exploded")
            # Should not raise — fail-open
            result = block.on_pre_tool_use(data)
        self.assertEqual(result.get("decision"), "block")


# ─────────────────────────────────────────────────────────────────────────────
# Edge: _source_reason helper
# ─────────────────────────────────────────────────────────────────────────────

class TestSourceReasonHelper(unittest.TestCase):
    def test_no_step_returns_dot(self):
        from src.claude_gates.block import _source_reason
        result = _source_reason({"action": "source", "scope": "x"})
        self.assertEqual(result, ".")

    def test_fix_status_returns_reviewer_message(self):
        from src.claude_gates.block import _source_reason
        act = {"action": "source", "step": {"status": StepStatus.Fix, "round": 1}}
        result = _source_reason(act)
        self.assertIn("fixer", result)

    def test_revise_status_returns_revise_message(self):
        from src.claude_gates.block import _source_reason
        act = {"action": "source", "step": {"status": StepStatus.Revise, "round": 1}}
        result = _source_reason(act)
        self.assertIn("revise", result.lower())

    def test_round_greater_than_zero_returns_round_message(self):
        from src.claude_gates.block import _source_reason
        act = {"action": "source", "step": {"status": StepStatus.Active, "round": 2}}
        result = _source_reason(act)
        self.assertIn("2", result)

    def test_round_zero_normal_returns_dot(self):
        from src.claude_gates.block import _source_reason
        act = {"action": "source", "step": {"status": StepStatus.Active, "round": 0}}
        result = _source_reason(act)
        self.assertEqual(result, ".")


# ─────────────────────────────────────────────────────────────────────────────
# Edge: ALLOWED_TOOLS list matches spec exactly
# ─────────────────────────────────────────────────────────────────────────────

class TestAllowedToolsList(unittest.TestCase):
    def test_allowed_tools_list(self):
        from src.claude_gates.block import ALLOWED_TOOLS
        expected = ["Read", "Glob", "Grep", "TaskCreate", "TaskUpdate", "TaskGet",
                    "TaskList", "SendMessage", "ToolSearch"]
        self.assertEqual(sorted(ALLOWED_TOOLS), sorted(expected))


if __name__ == "__main__":
    unittest.main()
