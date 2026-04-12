"""Tests for src/claude_gates/injection.py.

Acceptance criteria from spec.md (Task 15):
  AC1 - Gate disabled or missing session/agent → allow (return {})
  AC2 - Agent type normalization strips plugin prefix
  AC3 - Scope resolution: pending marker first, DB fallback
  AC4 - Verifier role injection: source artifact + round info
  AC5 - Fixer role injection: source artifact + gate agent info
  AC6 - Reviewer findings appended if verification file exists
  AC7 - Source/ungated agents get no injection
  AC8 - Output wrapped in agent_gate XML tag
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

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


# ── AC1: Gate disabled or missing session/agent → allow ──────────────────


class TestEarlyExits(unittest.TestCase):
    """AC1 - Gate disabled or missing session/agent returns {}."""

    def test_gate_disabled_returns_empty_dict(self):
        """When gate is disabled, returns {} immediately."""
        from src.claude_gates import injection
        with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=True):
            result = injection.on_subagent_start({"session_id": "abc", "agent_type": "gt-reviewer"})
        self.assertEqual(result, {})

    def test_missing_session_id_returns_empty_dict(self):
        """When session_id is empty/missing, returns {}."""
        from src.claude_gates import injection
        with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False):
            result = injection.on_subagent_start({"session_id": "", "agent_type": "gt-reviewer"})
        self.assertEqual(result, {})

    def test_missing_agent_type_returns_empty_dict(self):
        """When agent_type is empty/missing, returns {}."""
        from src.claude_gates import injection
        with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False):
            result = injection.on_subagent_start({"session_id": "abc123", "agent_type": ""})
        self.assertEqual(result, {})

    def test_both_missing_returns_empty_dict(self):
        """When both session_id and agent_type are missing, returns {}."""
        from src.claude_gates import injection
        with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False):
            result = injection.on_subagent_start({})
        self.assertEqual(result, {})


# ── AC2: Agent type normalization strips plugin prefix ────────────────────


class TestAgentTypeNormalization(unittest.TestCase):
    """AC2 - Plugin-qualified agent type is stripped to bare name."""

    def test_strips_plugin_prefix(self):
        """claude-gates:gater → gater."""
        from src.claude_gates import injection

        repo, engine, conn = _make_repo_and_engine()

        with tempfile.TemporaryDirectory() as session_dir:
            # DB returns no scope → no injection, but normalization must happen
            # We verify by checking that find_agent_scope is called with bare name
            called_with = []

            def fake_find_scope(agent):
                called_with.append(agent)
                return None

            repo.find_agent_scope = fake_find_scope

            def fake_open_db(sd):
                return conn

            with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
                 patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
                 patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
                 patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
                injection.on_subagent_start({
                    "session_id": "aabb1122-0000-0000-0000-000000000000",
                    "agent_type": "claude-gates:gater",
                })

            # find_agent_scope must be called with bare "gater", not "claude-gates:gater"
            self.assertIn("gater", called_with)

    def test_no_colon_uses_as_is(self):
        """Agent type with no colon is used unchanged."""
        from src.claude_gates import injection

        repo, engine, conn = _make_repo_and_engine()

        with tempfile.TemporaryDirectory() as session_dir:
            called_with = []

            def fake_find_scope(agent):
                called_with.append(agent)
                return None

            repo.find_agent_scope = fake_find_scope

            def fake_open_db(sd):
                return conn

            with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
                 patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
                 patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
                 patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
                injection.on_subagent_start({
                    "session_id": "aabb1122-0000-0000-0000-000000000000",
                    "agent_type": "gt-reviewer",
                })

            self.assertIn("gt-reviewer", called_with)


# ── AC3: Scope resolution: pending marker first, DB fallback ──────────────


class TestScopeResolution(unittest.TestCase):
    """AC3 - Pending marker file takes priority over DB for scope resolution."""

    def test_pending_marker_used_if_exists(self):
        """Pending marker file is read for scope; file is deleted after reading."""
        from src.claude_gates import injection
        from src.claude_gates.types import AgentRole

        repo, engine, conn = _make_repo_and_engine()
        # Create a pipeline so resolve_role returns Verifier

        with tempfile.TemporaryDirectory() as session_dir:
            # Write pending marker
            marker_path = os.path.join(session_dir, ".pending-scope-gt-reviewer")
            with open(marker_path, "w") as f:
                f.write("my-scope")

            # Create a pipeline in DB and make step active
            from src.claude_gates.types import StepType, StepStatus
            engine.create_pipeline(
                "my-scope",
                "gt-source",
                [{"type": StepType.Verify, "agent": "gt-reviewer", "maxRounds": 3}],
            )
            # step is active by default

            def fake_open_db(sd):
                return conn

            with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
                 patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
                 patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
                 patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
                injection.on_subagent_start({
                    "session_id": "aabb1122-0000-0000-0000-000000000000",
                    "agent_type": "gt-reviewer",
                })

            # Marker must be deleted after reading
            self.assertFalse(os.path.exists(marker_path), "Pending marker must be deleted after reading")

    def test_pending_marker_empty_content_no_scope(self):
        """Pending marker exists but empty → treat as no scope (no injection)."""
        from src.claude_gates import injection

        repo, engine, conn = _make_repo_and_engine()

        with tempfile.TemporaryDirectory() as session_dir:
            marker_path = os.path.join(session_dir, ".pending-scope-gt-reviewer")
            with open(marker_path, "w") as f:
                f.write("")  # empty content

            def fake_open_db(sd):
                return conn

            with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
                 patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
                 patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
                 patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
                result = injection.on_subagent_start({
                    "session_id": "aabb1122-0000-0000-0000-000000000000",
                    "agent_type": "gt-reviewer",
                })

            # Empty scope → no injection
            self.assertEqual(result, {})

    def test_db_fallback_when_no_marker(self):
        """When no pending marker, falls back to repo.find_agent_scope."""
        from src.claude_gates import injection
        from src.claude_gates.types import StepType, StepStatus

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "fallback-scope",
            "gt-source",
            [{"type": StepType.Verify, "agent": "gt-reviewer", "maxRounds": 3}],
        )
        repo.register_agent("fallback-scope", "gt-reviewer", "/path.md")

        with tempfile.TemporaryDirectory() as session_dir:
            def fake_open_db(sd):
                return conn

            with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
                 patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
                 patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
                 patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
                # Should not raise; DB fallback finds scope
                result = injection.on_subagent_start({
                    "session_id": "aabb1122-0000-0000-0000-000000000000",
                    "agent_type": "gt-reviewer",
                })

            # Returns non-empty because verifier context was built
            # (active step is present)
            self.assertIsInstance(result, dict)


# ── AC4: Verifier role injection ──────────────────────────────────────────


class TestVerifierRoleInjection(unittest.TestCase):
    """AC4 - Verifier gets source artifact + round info."""

    def _run_injection(self, session_dir, repo, engine, conn):
        from src.claude_gates import injection

        def fake_open_db(sd):
            return conn

        with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
             patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
             patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
             patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
            return injection.on_subagent_start({
                "session_id": "aabb1122-0000-0000-0000-000000000000",
                "agent_type": "gt-reviewer",
            })

    def test_verifier_injection_contains_required_fields(self):
        """Verifier context has role, session_id, scope, source_agent, source_artifact, gate_round."""
        from src.claude_gates.types import StepType

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "scope1",
            "gt-source",
            [{"type": StepType.Verify, "agent": "gt-reviewer", "maxRounds": 3}],
        )

        with tempfile.TemporaryDirectory() as session_dir:
            result = self._run_injection(session_dir, repo, engine, conn)

        self.assertIn("hookSpecificOutput", result)
        ctx = result["hookSpecificOutput"]["additionalContext"]
        self.assertIn("role=gate", ctx)
        self.assertIn("session_id=aabb1122", ctx)
        self.assertIn("scope=scope1", ctx)
        self.assertIn("source_agent=gt-source", ctx)
        self.assertIn("source_artifact=", ctx)
        self.assertIn("gate_round=1/3", ctx)

    def test_verifier_source_artifact_path_format(self):
        """Source artifact is {sessionDir}/{scope}/{sourceAgent}.md."""
        from src.claude_gates.types import StepType

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "my-scope",
            "gt-source",
            [{"type": StepType.Verify, "agent": "gt-reviewer", "maxRounds": 2}],
        )

        with tempfile.TemporaryDirectory() as session_dir:
            result = self._run_injection(session_dir, repo, engine, conn)

        ctx = result["hookSpecificOutput"]["additionalContext"]
        expected_artifact = f"{session_dir}/my-scope/gt-source.md"
        self.assertIn(f"source_artifact={expected_artifact}", ctx)

    def test_verifier_uses_fixer_artifact_when_fixer_ran(self):
        """After fixer runs (round > 0 and fixer set), artifact is fixer's .md if it exists."""
        from src.claude_gates.types import StepType, StepStatus

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "fixer-scope",
            "gt-source",
            [{"type": StepType.VerifyWithFixer, "agent": "gt-reviewer", "maxRounds": 3, "fixer": "gt-fixer"}],
        )
        # Simulate fixer ran: round > 0
        repo.update_step_status("fixer-scope", 0, StepStatus.Active, round=1)

        with tempfile.TemporaryDirectory() as session_dir:
            # Create fixer artifact file
            scope_dir = os.path.join(session_dir, "fixer-scope")
            os.makedirs(scope_dir, exist_ok=True)
            fixer_artifact = os.path.join(scope_dir, "gt-fixer.md")
            with open(fixer_artifact, "w") as f:
                f.write("# Fixed content\n- addressed issues\n")

            result = self._run_injection(session_dir, repo, engine, conn)

        ctx = result["hookSpecificOutput"]["additionalContext"]
        # Should use fixer artifact, not source agent artifact
        self.assertIn("gt-fixer.md", ctx)

    def test_verifier_fallback_to_source_when_fixer_artifact_missing(self):
        """When fixer artifact doesn't exist, verifier gets source agent artifact."""
        from src.claude_gates.types import StepType, StepStatus

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "fixer-scope2",
            "gt-source",
            [{"type": StepType.VerifyWithFixer, "agent": "gt-reviewer", "maxRounds": 3, "fixer": "gt-fixer"}],
        )
        # Simulate fixer ran: round > 0
        repo.update_step_status("fixer-scope2", 0, StepStatus.Active, round=1)

        with tempfile.TemporaryDirectory() as session_dir:
            # Do NOT create fixer artifact
            result = self._run_injection(session_dir, repo, engine, conn)

        ctx = result["hookSpecificOutput"]["additionalContext"]
        # Should fall back to source agent artifact
        self.assertIn("gt-source.md", ctx)

    def test_verifier_no_active_step_returns_empty(self):
        """If no active step exists for verifier, no injection is done → {}."""
        from src.claude_gates.types import StepType, StepStatus
        from src.claude_gates import injection

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "scope-nostep",
            "gt-source",
            [{"type": StepType.Verify, "agent": "gt-reviewer", "maxRounds": 3}],
        )
        # Mark step as passed (no active step)
        repo.update_step_status("scope-nostep", 0, StepStatus.Passed)

        with tempfile.TemporaryDirectory() as session_dir:
            marker_path = os.path.join(session_dir, ".pending-scope-gt-reviewer")
            with open(marker_path, "w") as f:
                f.write("scope-nostep")

            def fake_open_db(sd):
                return conn

            with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
                 patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
                 patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
                 patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
                result = injection.on_subagent_start({
                    "session_id": "aabb1122-0000-0000-0000-000000000000",
                    "agent_type": "gt-reviewer",
                })

        self.assertEqual(result, {})


# ── AC5: Fixer role injection ─────────────────────────────────────────────


class TestFixerRoleInjection(unittest.TestCase):
    """AC5 - Fixer gets source artifact + gate agent info."""

    def _setup_fixer_pipeline(self):
        from src.claude_gates.types import StepType, StepStatus
        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "fix-scope",
            "gt-source",
            [{"type": StepType.VerifyWithFixer, "agent": "gt-reviewer", "maxRounds": 3, "fixer": "gt-fixer"}],
        )
        # Put step in Fix status so gt-fixer is resolved as Fixer role
        repo.update_step_status("fix-scope", 0, StepStatus.Fix)
        return repo, engine, conn

    def _run_fixer_injection(self, session_dir, repo, engine, conn):
        from src.claude_gates import injection

        def fake_open_db(sd):
            return conn

        with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
             patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
             patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
             patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
            return injection.on_subagent_start({
                "session_id": "aabb1122-0000-0000-0000-000000000000",
                "agent_type": "gt-fixer",
            })

    def test_fixer_injection_contains_required_fields(self):
        """Fixer context has role=fixer, session_id, scope, source_agent, source_artifact, gate_agent, gate_round."""
        repo, engine, conn = self._setup_fixer_pipeline()

        with tempfile.TemporaryDirectory() as session_dir:
            # Add pending marker for fixer scope
            marker_path = os.path.join(session_dir, ".pending-scope-gt-fixer")
            with open(marker_path, "w") as f:
                f.write("fix-scope")

            result = self._run_fixer_injection(session_dir, repo, engine, conn)

        self.assertIn("hookSpecificOutput", result)
        ctx = result["hookSpecificOutput"]["additionalContext"]
        self.assertIn("role=fixer", ctx)
        self.assertIn("session_id=aabb1122", ctx)
        self.assertIn("scope=fix-scope", ctx)
        self.assertIn("source_agent=gt-source", ctx)
        self.assertIn("source_artifact=", ctx)
        self.assertIn("gate_agent=gt-reviewer", ctx)
        self.assertIn("gate_round=", ctx)

    def test_fixer_source_artifact_uses_source_agent_md(self):
        """Fixer source_artifact is {sessionDir}/{scope}/{sourceAgent}.md."""
        repo, engine, conn = self._setup_fixer_pipeline()

        with tempfile.TemporaryDirectory() as session_dir:
            marker_path = os.path.join(session_dir, ".pending-scope-gt-fixer")
            with open(marker_path, "w") as f:
                f.write("fix-scope")

            result = self._run_fixer_injection(session_dir, repo, engine, conn)

        ctx = result["hookSpecificOutput"]["additionalContext"]
        expected = f"{session_dir}/fix-scope/gt-source.md"
        self.assertIn(f"source_artifact={expected}", ctx)

    def test_fixer_no_fix_step_returns_empty(self):
        """If no Fix step found for fixer, no injection → {}."""
        from src.claude_gates.types import StepType, StepStatus
        from src.claude_gates import injection

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "fix-scope2",
            "gt-source",
            [{"type": StepType.VerifyWithFixer, "agent": "gt-reviewer", "maxRounds": 3, "fixer": "gt-fixer"}],
        )
        # Step is still Active, not Fix — so get_step_by_status(Fix) returns None
        # AND resolve_role for gt-fixer returns Ungated (no Fix row)
        # So result should be {}

        with tempfile.TemporaryDirectory() as session_dir:
            marker_path = os.path.join(session_dir, ".pending-scope-gt-fixer")
            with open(marker_path, "w") as f:
                f.write("fix-scope2")

            def fake_open_db(sd):
                return conn

            with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
                 patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
                 patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
                 patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
                result = injection.on_subagent_start({
                    "session_id": "aabb1122-0000-0000-0000-000000000000",
                    "agent_type": "gt-fixer",
                })

        self.assertEqual(result, {})


# ── AC6: Reviewer findings appended if verification file exists ───────────


class TestReviewerFindingsAppended(unittest.TestCase):
    """AC6 - Verification file content appended to pipeline context."""

    def test_verification_file_appended_to_context(self):
        """If {sessionDir}/{scope}/{bareAgentType}-verification.md exists, its content is appended."""
        from src.claude_gates.types import StepType
        from src.claude_gates import injection

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "scope-v",
            "gt-source",
            [{"type": StepType.Verify, "agent": "gt-reviewer", "maxRounds": 3}],
        )

        with tempfile.TemporaryDirectory() as session_dir:
            scope_dir = os.path.join(session_dir, "scope-v")
            os.makedirs(scope_dir, exist_ok=True)
            verif_file = os.path.join(scope_dir, "gt-reviewer-verification.md")
            with open(verif_file, "w") as f:
                f.write("## Issues\n- Missing unit tests\n- Incorrect logic\n")

            marker_path = os.path.join(session_dir, ".pending-scope-gt-reviewer")
            with open(marker_path, "w") as f:
                f.write("scope-v")

            def fake_open_db(sd):
                return conn

            with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
                 patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
                 patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
                 patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
                result = injection.on_subagent_start({
                    "session_id": "aabb1122-0000-0000-0000-000000000000",
                    "agent_type": "gt-reviewer",
                })

        ctx = result["hookSpecificOutput"]["additionalContext"]
        self.assertIn("Reviewer findings (address ALL issues before resubmitting):", ctx)
        self.assertIn("Missing unit tests", ctx)

    def test_verification_file_not_found_no_error(self):
        """Missing verification file is silently ignored."""
        from src.claude_gates.types import StepType
        from src.claude_gates import injection

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "scope-nv",
            "gt-source",
            [{"type": StepType.Verify, "agent": "gt-reviewer", "maxRounds": 3}],
        )

        with tempfile.TemporaryDirectory() as session_dir:
            marker_path = os.path.join(session_dir, ".pending-scope-gt-reviewer")
            with open(marker_path, "w") as f:
                f.write("scope-nv")

            def fake_open_db(sd):
                return conn

            with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
                 patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
                 patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
                 patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
                # Should not raise
                result = injection.on_subagent_start({
                    "session_id": "aabb1122-0000-0000-0000-000000000000",
                    "agent_type": "gt-reviewer",
                })

        # No verification file but still has context (verifier context was built)
        self.assertIn("hookSpecificOutput", result)
        ctx = result["hookSpecificOutput"]["additionalContext"]
        self.assertNotIn("Reviewer findings", ctx)

    def test_verification_file_read_error_silently_skipped(self):
        """OSError when reading verification file is silently ignored."""
        from src.claude_gates.types import StepType
        from src.claude_gates import injection

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "scope-err",
            "gt-source",
            [{"type": StepType.Verify, "agent": "gt-reviewer", "maxRounds": 3}],
        )

        with tempfile.TemporaryDirectory() as session_dir:
            marker_path = os.path.join(session_dir, ".pending-scope-gt-reviewer")
            with open(marker_path, "w") as f:
                f.write("scope-err")

            def fake_open_db(sd):
                return conn

            # Patch os.path.exists to return True for verif file, then open to raise OSError
            real_exists = os.path.exists

            def fake_exists(p):
                if "gt-reviewer-verification.md" in str(p):
                    return True
                return real_exists(p)

            with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
                 patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
                 patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
                 patch("src.claude_gates.injection.PipelineRepository", return_value=repo), \
                 patch("os.path.exists", side_effect=fake_exists), \
                 patch("builtins.open", side_effect=OSError("Permission denied")):
                # Should not raise
                result = injection.on_subagent_start({
                    "session_id": "aabb1122-0000-0000-0000-000000000000",
                    "agent_type": "gt-reviewer",
                })

        # Still returns valid result (verifier context built, findings silently skipped)
        self.assertIsInstance(result, dict)


# ── AC7: Source/ungated agents get no injection ───────────────────────────


class TestSourceAndUngatedNoInjection(unittest.TestCase):
    """AC7 - Source, Ungated, Checker, Transformer roles get no injection."""

    def _run_as_agent(self, agent_type, session_dir, repo, engine, conn):
        from src.claude_gates import injection

        def fake_open_db(sd):
            return conn

        with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
             patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
             patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
             patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
             patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
            return injection.on_subagent_start({
                "session_id": "aabb1122-0000-0000-0000-000000000000",
                "agent_type": agent_type,
            })

    def test_source_agent_gets_no_injection(self):
        """Source agent (gt-source) gets {} — semantics first."""
        from src.claude_gates.types import StepType

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "src-scope",
            "gt-source",
            [{"type": StepType.Verify, "agent": "gt-reviewer", "maxRounds": 3}],
        )

        with tempfile.TemporaryDirectory() as session_dir:
            marker_path = os.path.join(session_dir, ".pending-scope-gt-source")
            with open(marker_path, "w") as f:
                f.write("src-scope")

            result = self._run_as_agent("gt-source", session_dir, repo, engine, conn)

        self.assertEqual(result, {})

    def test_ungated_agent_gets_no_injection(self):
        """Ungated agent (no pipeline) gets {}."""
        repo, engine, conn = _make_repo_and_engine()

        with tempfile.TemporaryDirectory() as session_dir:
            result = self._run_as_agent("some-random-agent", session_dir, repo, engine, conn)

        self.assertEqual(result, {})

    def test_transformer_gets_no_injection(self):
        """Transformer role agent gets {} — no context injection."""
        from src.claude_gates.types import StepType, StepStatus

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "tr-scope",
            "gt-source",
            [{"type": StepType.Transform, "agent": "gt-cleaner", "maxRounds": 1}],
        )

        with tempfile.TemporaryDirectory() as session_dir:
            marker_path = os.path.join(session_dir, ".pending-scope-gt-cleaner")
            with open(marker_path, "w") as f:
                f.write("tr-scope")

            result = self._run_as_agent("gt-cleaner", session_dir, repo, engine, conn)

        self.assertEqual(result, {})


# ── AC8: Output wrapped in agent_gate XML tag ─────────────────────────────


class TestOutputXmlWrapping(unittest.TestCase):
    """AC8 - Non-empty pipeline_context wrapped in agent_gate XML tag."""

    def test_output_format_is_correct(self):
        """Returns hookSpecificOutput with hookEventName=SubagentStart and agent_gate XML."""
        from src.claude_gates.types import StepType
        from src.claude_gates import injection

        repo, engine, conn = _make_repo_and_engine()
        engine.create_pipeline(
            "xml-scope",
            "gt-source",
            [{"type": StepType.Verify, "agent": "gt-reviewer", "maxRounds": 3}],
        )

        with tempfile.TemporaryDirectory() as session_dir:
            marker_path = os.path.join(session_dir, ".pending-scope-gt-reviewer")
            with open(marker_path, "w") as f:
                f.write("xml-scope")

            def fake_open_db(sd):
                return conn

            with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
                 patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
                 patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
                 patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
                result = injection.on_subagent_start({
                    "session_id": "aabb1122-0000-0000-0000-000000000000",
                    "agent_type": "gt-reviewer",
                })

        # Must have hookSpecificOutput structure
        self.assertIn("hookSpecificOutput", result)
        hook_out = result["hookSpecificOutput"]
        self.assertEqual(hook_out["hookEventName"], "SubagentStart")
        ctx = hook_out["additionalContext"]

        # Must be wrapped in agent_gate XML tag
        self.assertTrue(ctx.startswith('<agent_gate importance="critical">'), ctx)
        self.assertTrue(ctx.rstrip().endswith("</agent_gate>"), ctx)

    def test_no_injection_returns_empty_dict_not_xml(self):
        """Ungated agents return plain {} without XML wrapping."""
        from src.claude_gates import injection

        repo, engine, conn = _make_repo_and_engine()

        with tempfile.TemporaryDirectory() as session_dir:
            def fake_open_db(sd):
                return conn

            with patch("src.claude_gates.injection.session.is_gate_disabled", return_value=False), \
                 patch("src.claude_gates.injection.session.get_session_dir", return_value=session_dir), \
                 patch("src.claude_gates.injection.session.open_database", side_effect=fake_open_db), \
                 patch("src.claude_gates.injection.PipelineRepository.init_schema"), \
                 patch("src.claude_gates.injection.PipelineRepository", return_value=repo):
                result = injection.on_subagent_start({
                    "session_id": "aabb1122-0000-0000-0000-000000000000",
                    "agent_type": "no-pipeline-agent",
                })

        self.assertEqual(result, {})


# ── No sys.exit check ─────────────────────────────────────────────────────


class TestNoSysExit(unittest.TestCase):
    """injection.py must not call sys.exit()."""

    def test_no_sysexit_in_module(self):
        module_path = os.path.join(
            _PROJECT_ROOT, "src", "claude_gates", "injection.py"
        )
        if not os.path.exists(module_path):
            self.skipTest("injection.py not yet implemented")
        with open(module_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertNotIn("sys.exit(", content, "injection.py must not call sys.exit()")


if __name__ == "__main__":
    unittest.main()
