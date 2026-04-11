"""Tests for src/claude_gates/verification.py.

Acceptance criteria from spec.md:
  AC1 - Deferred pipeline creation on first SubagentStop
  AC2 - Semantic check can override PASS to REVISE
  AC3 - MCP config always overwritten
  AC4 - Scope resolution fallback chain with fail-open terminal
  AC5 - All early exits return {}
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


def _make_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _make_repo_and_engine():
    from src.claude_gates.repository import PipelineRepository
    from src.claude_gates.engine import PipelineEngine
    conn = _make_db()
    PipelineRepository.init_schema(conn)
    repo = PipelineRepository(conn)
    engine = PipelineEngine(repo)
    return repo, engine, conn


# ── Scope resolution helpers ───────────────────────────────────────────


class TestExtractScopeFromTranscript(unittest.TestCase):
    """Tests for _extract_scope_from_transcript."""

    def test_returns_scope_from_first_2kb(self):
        from src.claude_gates.verification import _extract_scope_from_transcript
        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
            f.write('{"type":"system","content":"scope=my-task"}\n')
            path = f.name
        try:
            result = _extract_scope_from_transcript(path)
            self.assertEqual(result, "my-task")
        finally:
            os.unlink(path)

    def test_returns_none_for_missing_file(self):
        from src.claude_gates.verification import _extract_scope_from_transcript
        result = _extract_scope_from_transcript("/nonexistent/path.jsonl")
        self.assertIsNone(result)

    def test_returns_none_for_none_path(self):
        from src.claude_gates.verification import _extract_scope_from_transcript
        result = _extract_scope_from_transcript(None)
        self.assertIsNone(result)


class TestExtractArtifactPath(unittest.TestCase):
    """Tests for _extract_artifact_path."""

    def test_extracts_scope_from_message(self):
        from src.claude_gates.verification import _extract_artifact_path
        session_dir = "/sessions/abc123"
        agent_type = "gt-planner"
        message = f"I wrote to {session_dir}/my-scope/gt-planner.md"
        result = _extract_artifact_path(message, session_dir, agent_type)
        self.assertIsNotNone(result)
        self.assertEqual(result["scope"], "my-scope")

    def test_strips_plugin_prefix_from_agent_type(self):
        from src.claude_gates.verification import _extract_artifact_path
        session_dir = "/sessions/abc123"
        agent_type = "claude-gates:gt-planner"
        message = f"saved to {session_dir}/scope1/gt-planner.md"
        result = _extract_artifact_path(message, session_dir, agent_type)
        self.assertIsNotNone(result)
        self.assertEqual(result["scope"], "scope1")

    def test_returns_none_when_no_match(self):
        from src.claude_gates.verification import _extract_artifact_path
        result = _extract_artifact_path("no path here", "/sessions/abc", "gt-planner")
        self.assertIsNone(result)

    def test_ignores_pending_scope(self):
        from src.claude_gates.verification import _extract_artifact_path
        session_dir = "/sessions/abc123"
        message = f"{session_dir}/_pending/gt-planner.md"
        result = _extract_artifact_path(message, session_dir, "gt-planner")
        self.assertIsNone(result)


# ── AC4: Scope resolution fallback chain with fail-open ────────────────


class TestResolveScope(unittest.TestCase):
    """AC4 - scope resolution fail-open terminal."""

    def test_all_fallbacks_fail_returns_none(self):
        """When transcript, artifact-path, and DB all fail, returns None (fail-open)."""
        from src.claude_gates.verification import _resolve_scope
        repo, engine, conn = _make_repo_and_engine()
        data = {
            "agent_type": "gt-planner",
            "agent_id": "unknown",
            "last_assistant_message": "",
            "agent_transcript_path": None,
            "transcript_path": None,
            "stop_hook_active": False,
        }
        with tempfile.TemporaryDirectory() as session_dir:
            result = _resolve_scope(data, repo, session_dir, "gt-planner")
            self.assertIsNone(result["scope"])

    def test_transcript_path_wins(self):
        """Primary scope from transcript file is returned."""
        from src.claude_gates.verification import _resolve_scope
        repo, engine, conn = _make_repo_and_engine()
        with tempfile.TemporaryDirectory() as session_dir:
            # Write transcript with scope=
            transcript = os.path.join(session_dir, "agent.jsonl")
            with open(transcript, "w") as f:
                f.write('{"prompt":"scope=task-abc implement the feature"}\n')
            data = {
                "agent_type": "gt-planner",
                "agent_id": "unknown",
                "last_assistant_message": "",
                "agent_transcript_path": transcript,
                "transcript_path": None,
                "stop_hook_active": False,
            }
            result = _resolve_scope(data, repo, session_dir, "gt-planner")
            self.assertEqual(result["scope"], "task-abc")

    def test_db_fallback_finds_scope(self):
        """DB fallback: repo.find_agent_scope() returns a scope."""
        from src.claude_gates.verification import _resolve_scope
        repo, engine, conn = _make_repo_and_engine()
        # Register agent in DB
        repo.register_agent("db-scope", "gt-planner", "/some/path.md")
        data = {
            "agent_type": "gt-planner",
            "agent_id": "unknown",
            "last_assistant_message": "",
            "agent_transcript_path": None,
            "transcript_path": None,
            "stop_hook_active": False,
        }
        with tempfile.TemporaryDirectory() as session_dir:
            # Create the artifact file so it's found
            scope_dir = os.path.join(session_dir, "db-scope")
            os.makedirs(scope_dir, exist_ok=True)
            artifact = os.path.join(scope_dir, "gt-planner.md")
            with open(artifact, "w") as f:
                f.write("# Content\n- bullet\n")
            result = _resolve_scope(data, repo, session_dir, "gt-planner")
            self.assertEqual(result["scope"], "db-scope")


# ── AC1: Deferred pipeline creation ───────────────────────────────────


class TestDeferredPipelineCreation(unittest.TestCase):
    """AC1 - Pipeline created at SubagentStop (not SubagentStart)."""

    def test_pipeline_created_on_first_subagent_stop(self):
        """Pipeline does not exist before on_subagent_stop; exists after."""
        from src.claude_gates.verification import on_subagent_stop
        from src.claude_gates.repository import PipelineRepository
        from src.claude_gates.engine import PipelineEngine

        with tempfile.TemporaryDirectory() as tmpdir:
            # Write agent .md with verification frontmatter
            agents_dir = os.path.join(tmpdir, ".claude", "agents")
            os.makedirs(agents_dir, exist_ok=True)
            agent_md = os.path.join(agents_dir, "gt-planner.md")
            with open(agent_md, "w") as f:
                f.write(
                    '---\nname: gt-planner\nverification:\n  - ["Check content is thorough"]\n---\n# Planner\n'
                )

            # Session dir setup
            sessions_dir = os.path.join(tmpdir, ".sessions", "aabb1122")
            os.makedirs(sessions_dir, exist_ok=True)
            scope_dir = os.path.join(sessions_dir, "task-x")
            os.makedirs(scope_dir, exist_ok=True)
            artifact = os.path.join(scope_dir, "gt-planner.md")
            with open(artifact, "w") as f:
                f.write("# Plan\n- step one\n- step two\n")

            # Write transcript with scope= (literal format, not JSON key)
            transcript = os.path.join(sessions_dir, "agent.jsonl")
            with open(transcript, "w") as f:
                f.write('{"prompt":"scope=task-x implement the feature"}\n')

            data = {
                "agent_type": "gt-planner",
                "agent_id": "aabbccdd",
                "session_id": "aabb1122-ffff-0000-0000-000000000000",
                "last_assistant_message": "",
                "agent_transcript_path": transcript,
                "transcript_path": None,
                "stop_hook_active": False,
            }

            # Use file-based DB so we can re-open after hook closes it
            import sqlite3
            db_path = os.path.join(sessions_dir, "session.db")
            conn = sqlite3.connect(db_path, isolation_level=None)
            conn.row_factory = sqlite3.Row
            PipelineRepository.init_schema(conn)

            # Pipeline must NOT exist before hook runs
            repo = PipelineRepository(conn)
            self.assertFalse(repo.pipeline_exists("task-x"))
            conn.close()

            def _open_db(sd):
                c = sqlite3.connect(db_path, isolation_level=None)
                c.row_factory = sqlite3.Row
                return c

            with patch("src.claude_gates.verification.get_session_dir", return_value=sessions_dir), \
                 patch("src.claude_gates.verification.open_database", side_effect=_open_db), \
                 patch("src.claude_gates.verification.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.verification._run_semantic_check", return_value=None), \
                 patch("src.claude_gates.verification.find_agent_md", return_value=agent_md), \
                 patch("os.getcwd", return_value=tmpdir):
                result = on_subagent_stop(data)

            # Re-open to check — the hook closed its connection
            conn2 = sqlite3.connect(db_path, isolation_level=None)
            conn2.row_factory = sqlite3.Row
            PipelineRepository.init_schema(conn2)
            repo2 = PipelineRepository(conn2)
            self.assertTrue(repo2.pipeline_exists("task-x"))
            conn2.close()


# ── AC2: Semantic check overrides PASS to REVISE ──────────────────────


class TestSemanticCheckOverridePassToRevise(unittest.TestCase):
    """AC2 - Semantic FAIL on verifier triggers retry_gate_agent, not step."""

    def test_semantic_fail_calls_retry_gate_agent(self):
        """Verifier returns PASS but semantic check returns FAIL → retry_gate_agent."""
        from src.claude_gates.verification import _handle_verifier
        from src.claude_gates.types import StepType, StepStatus

        repo, engine, conn = _make_repo_and_engine()
        # Set up a pipeline with a VERIFY step
        engine.create_pipeline(
            "scope1",
            "gt-source",
            [{"type": StepType.Verify, "agent": "gt-reviewer", "maxRounds": 3}],
        )
        # Activate the step (already active from create)
        with tempfile.TemporaryDirectory() as session_dir:
            artifact_path = os.path.join(session_dir, "gt-reviewer.md")
            with open(artifact_path, "w") as f:
                f.write("# Review\n- checked all\nResult: PASS\n")

            mock_trace = MagicMock()
            mock_trace.span.return_value = MagicMock()
            mock_trace.span.return_value.end = MagicMock()

            # Semantic check returns FAIL (hallucinated PASS detected)
            semantic_result = {"verdict": "FAIL", "check": None, "reason": "nonsensical", "fullResponse": "bad"}

            with patch("src.claude_gates.verification._run_semantic_check", return_value=semantic_result), \
                 patch("src.claude_gates.verification._write_audit"), \
                 patch("claude_gates.tracing.trace"):
                _handle_verifier(
                    repo=repo,
                    engine=engine,
                    scope="scope1",
                    agent_type="gt-reviewer",
                    artifact_path=artifact_path,
                    artifact_content="# Review\n- checked all\nResult: PASS\n",
                    artifact_verdict="PASS",
                    scope_context="",
                    session_dir=session_dir,
                    session_id="test-session",
                    span=mock_trace,
                    enabled=False,
                )

            # After retry_gate_agent, step round should have incremented (still active)
            step = repo.get_active_step("scope1")
            self.assertIsNotNone(step)
            self.assertEqual(step["round"], 1)  # retried → round 1


# ── AC3: MCP config always overwritten ────────────────────────────────


class TestEnsureMcpConfig(unittest.TestCase):
    """AC3 - _ensure_mcp_config always writes, even when file exists."""

    def test_writes_config_when_missing(self):
        from src.claude_gates.verification import _ensure_mcp_config
        with tempfile.TemporaryDirectory() as session_dir:
            config_path = _ensure_mcp_config(session_dir)
            self.assertTrue(os.path.exists(config_path))
            with open(config_path, "r") as f:
                cfg = json.load(f)
            self.assertIn("mcpServers", cfg)
            self.assertIn("claude-gates", cfg["mcpServers"])

    def test_overwrites_existing_config(self):
        """Config is always overwritten — idempotent."""
        from src.claude_gates.verification import _ensure_mcp_config
        with tempfile.TemporaryDirectory() as session_dir:
            config_path = os.path.join(session_dir, "mcp-config.json")
            with open(config_path, "w") as f:
                f.write('{"stale": true}')

            result_path = _ensure_mcp_config(session_dir)
            with open(result_path, "r") as f:
                cfg = json.load(f)
            # Must have been overwritten
            self.assertNotIn("stale", cfg)
            self.assertIn("mcpServers", cfg)

    def test_config_points_to_python_mcp_server(self):
        """MCP config must use python3 (or sys.executable) + McpServer.py."""
        from src.claude_gates.verification import _ensure_mcp_config
        with tempfile.TemporaryDirectory() as session_dir:
            config_path = _ensure_mcp_config(session_dir)
            with open(config_path, "r") as f:
                cfg = json.load(f)
            server = cfg["mcpServers"]["claude-gates"]
            # Args must include McpServer.py
            args_str = " ".join(str(a) for a in server.get("args", []))
            self.assertIn("McpServer.py", args_str)


# ── AC5: No sys.exit — all early exits return {} ─────────────────────


class TestNoSysExit(unittest.TestCase):
    """AC5 - on_subagent_stop returns {} on all early-exit paths; no sys.exit."""

    def test_gate_disabled_returns_empty_dict(self):
        from src.claude_gates.verification import on_subagent_stop
        with patch("src.claude_gates.verification.is_gate_disabled", return_value=True):
            result = on_subagent_stop({})
        self.assertEqual(result, {})

    def test_missing_agent_type_returns_empty_dict(self):
        from src.claude_gates.verification import on_subagent_stop
        with patch("src.claude_gates.verification.is_gate_disabled", return_value=False):
            result = on_subagent_stop({"agent_type": "", "session_id": "s"})
        self.assertEqual(result, {})

    def test_ungated_agent_returns_empty_dict(self):
        """Agent with no pipeline returns {} (ungated path)."""
        from src.claude_gates.verification import on_subagent_stop
        conn = _make_db()
        from src.claude_gates.repository import PipelineRepository
        PipelineRepository.init_schema(conn)

        with tempfile.TemporaryDirectory() as tmpdir:
            sessions_dir = os.path.join(tmpdir, ".sessions", "aabb1122")
            os.makedirs(sessions_dir, exist_ok=True)

            data = {
                "agent_type": "some-ungated-agent",
                "agent_id": "unknown",
                "session_id": "aabb1122-ffff-0000-0000-000000000000",
                "last_assistant_message": "",
                "agent_transcript_path": None,
                "transcript_path": None,
                "stop_hook_active": False,
            }

            with patch("src.claude_gates.verification.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.verification.get_session_dir", return_value=sessions_dir), \
                 patch("src.claude_gates.verification.open_database", return_value=conn), \
                 patch("src.claude_gates.verification.find_agent_md", return_value=None):
                result = on_subagent_stop(data)
            self.assertEqual(result, {})

    def test_no_sysexit_in_module(self):
        """verification.py must not contain sys.exit() calls."""
        module_path = os.path.join(
            _PROJECT_ROOT, "src", "claude_gates", "verification.py"
        )
        if not os.path.exists(module_path):
            self.skipTest("verification.py not yet implemented")
        with open(module_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertNotIn("sys.exit(", content, "verification.py must not call sys.exit()")


# ── Handler routing ────────────────────────────────────────────────────


class TestHandlerRouting(unittest.TestCase):
    """Dispatcher routes to correct handler by AgentRole."""

    def _make_pipeline(self, step_type, agent="gt-reviewer"):
        from src.claude_gates.types import StepType
        repo, engine, conn = _make_repo_and_engine()
        steps = [{"type": step_type, "agent": agent, "maxRounds": 3}]
        engine.create_pipeline("sc", "gt-source", steps)
        return repo, engine, conn

    def test_transformer_auto_pass(self):
        """Transformer handler calls engine.step with auto PASS — no semantic check."""
        from src.claude_gates.verification import _handle_transformer
        from src.claude_gates.types import StepType

        repo, engine, conn = self._make_pipeline(StepType.Transform, "gt-cleaner")
        mock_span = MagicMock()
        mock_span.span.return_value = MagicMock()

        with tempfile.TemporaryDirectory() as session_dir:
            artifact = os.path.join(session_dir, "gt-cleaner.md")
            with open(artifact, "w") as f:
                f.write("# Cleaned\n- done\n")

            with patch("claude_gates.tracing.trace"):
                _handle_transformer(
                    repo=repo,
                    engine=engine,
                    scope="sc",
                    agent_type="gt-cleaner",
                    artifact_path=artifact,
                    session_dir=session_dir,
                    span=mock_span,
                    enabled=False,
                )

        # After transformer auto-pass, pipeline should advance (step passed)
        from src.claude_gates.types import StepStatus
        step = repo.get_step("sc", 0)
        self.assertEqual(step["status"], StepStatus.Passed)

    def test_fixer_runs_semantic_check(self):
        """Fixer handler calls _run_semantic_check."""
        from src.claude_gates.verification import _handle_fixer
        from src.claude_gates.types import StepType, StepStatus

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "sc2",
            "gt-source",
            [{"type": StepType.VerifyWithFixer, "agent": "gt-reviewer", "maxRounds": 3, "fixer": "gt-fixer"}],
        )
        # Put step in fix status
        repo.update_step_status("sc2", 0, StepStatus.Fix)

        mock_span = MagicMock()
        mock_span.span.return_value = MagicMock()

        called = []

        def fake_semantic(*args, **kwargs):
            called.append(True)
            return None

        with tempfile.TemporaryDirectory() as session_dir:
            artifact = os.path.join(session_dir, "gt-fixer.md")
            with open(artifact, "w") as f:
                f.write("# Fix\n- addressed all issues\n")

            with patch("src.claude_gates.verification._run_semantic_check", side_effect=fake_semantic), \
                 patch("src.claude_gates.verification._write_audit"), \
                 patch("claude_gates.tracing.trace"):
                _handle_fixer(
                    repo=repo,
                    engine=engine,
                    scope="sc2",
                    agent_type="gt-fixer",
                    artifact_path=artifact,
                    artifact_content="# Fix\n- addressed all issues\n",
                    artifact_verdict="PASS",
                    scope_context="",
                    session_dir=session_dir,
                    session_id="sess",
                    span=mock_span,
                    enabled=False,
                )

        self.assertTrue(called, "Fixer should call _run_semantic_check")


# ── Implicit source check ──────────────────────────────────────────────


class TestImplicitSourceCheck(unittest.TestCase):
    def test_empty_artifact_fails(self):
        from src.claude_gates.verification import _implicit_source_check
        result = _implicit_source_check("", "some.md")
        self.assertIsNotNone(result)

    def test_trivially_short_fails(self):
        from src.claude_gates.verification import _implicit_source_check
        result = _implicit_source_check("hi", "some.md")
        self.assertIsNotNone(result)

    def test_no_structure_fails(self):
        from src.claude_gates.verification import _implicit_source_check
        result = _implicit_source_check("a" * 100, "some.md")
        self.assertIsNotNone(result)

    def test_valid_artifact_passes(self):
        from src.claude_gates.verification import _implicit_source_check
        result = _implicit_source_check("# Title\n\n- bullet point one explaining the approach\n- another bullet with sufficient detail\n", "some.md")
        self.assertIsNone(result)


# ── _record_verdict ────────────────────────────────────────────────────


class TestRecordVerdict(unittest.TestCase):
    def test_upserts_verdict(self):
        from src.claude_gates.verification import _record_verdict
        repo, engine, conn = _make_repo_and_engine()
        repo.register_agent("sc", "gt-planner", "/path.md")
        _record_verdict(repo, "sc", "gt-planner", "PASS")
        row = repo.get_agent("sc", "gt-planner")
        self.assertEqual(row["verdict"], "PASS")

    def test_strips_plugin_prefix(self):
        from src.claude_gates.verification import _record_verdict
        repo, engine, conn = _make_repo_and_engine()
        repo.register_agent("sc", "gt-planner", "/path.md")
        _record_verdict(repo, "sc", "claude-gates:gt-planner", "PASS")
        row = repo.get_agent("sc", "gt-planner")
        self.assertEqual(row["verdict"], "PASS")

    def test_no_scope_returns_none(self):
        from src.claude_gates.verification import _record_verdict
        repo, engine, conn = _make_repo_and_engine()
        result = _record_verdict(repo, "", "gt-planner", "PASS")
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
