from __future__ import annotations

import os
import sqlite3
import sys
import unittest

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates.types import (
    AgentRole,
    PipelineStatus,
    StepStatus,
    StepType,
    Verdict,
)


def _make_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _make_engine():
    from src.claude_gates.repository import PipelineRepository
    from src.claude_gates.engine import PipelineEngine

    conn = _make_db()
    PipelineRepository.init_schema(conn)
    repo = PipelineRepository(conn)
    engine = PipelineEngine(repo)
    return engine, repo, conn


# ── Helpers ────────────────────────────────────────────────────────────────────

def _check_step(prompt="Semantic check"):
    return {"type": "CHECK", "prompt": prompt}


def _verify_step(agent="gt-reviewer", max_rounds=3):
    return {"type": "VERIFY", "agent": agent, "maxRounds": max_rounds}


def _verify_fixer_step(agent="gt-reviewer", fixer="gt-fixer", max_rounds=3):
    return {"type": "VERIFY_W_FIXER", "agent": agent, "maxRounds": max_rounds, "fixer": fixer}


def _transform_step(agent="gt-cleaner", max_rounds=1):
    return {"type": "TRANSFORM", "agent": agent, "maxRounds": max_rounds}


# ── AC1: Unknown verdicts default to PASS ──────────────────────────────────────

class TestNormalizeVerdictUnknown(unittest.TestCase):

    def setUp(self):
        self.engine, self.repo, self.conn = _make_engine()

    def tearDown(self):
        self.conn.close()

    def test_unknown_verdict_returns_pass(self):
        from src.claude_gates.engine import PipelineEngine
        result = self.engine._normalize_verdict("SOMETHING_WEIRD")
        self.assertEqual(result, Verdict.Pass)

    def test_unknown_verdict_emits_stderr_warning(self):
        import io
        import sys
        buf = io.StringIO()
        old_stderr = sys.stderr
        sys.stderr = buf
        try:
            self.engine._normalize_verdict("BOGUS")
        finally:
            sys.stderr = old_stderr
        self.assertIn("BOGUS", buf.getvalue())

    def test_empty_string_verdict_returns_pass(self):
        result = self.engine._normalize_verdict("")
        self.assertEqual(result, Verdict.Pass)


# ── AC2: CONVERGED -> PASS, FAIL -> REVISE ────────────────────────────────────

class TestNormalizeVerdictAliases(unittest.TestCase):

    def setUp(self):
        self.engine, self.repo, self.conn = _make_engine()

    def tearDown(self):
        self.conn.close()

    def test_converged_maps_to_pass(self):
        result = self.engine._normalize_verdict("CONVERGED")
        self.assertEqual(result, Verdict.Pass)

    def test_fail_maps_to_revise(self):
        result = self.engine._normalize_verdict("FAIL")
        self.assertEqual(result, Verdict.Revise)

    def test_pass_maps_to_pass(self):
        result = self.engine._normalize_verdict("PASS")
        self.assertEqual(result, Verdict.Pass)

    def test_revise_maps_to_revise(self):
        result = self.engine._normalize_verdict("REVISE")
        self.assertEqual(result, Verdict.Revise)

    def test_lowercase_pass_maps_to_pass(self):
        result = self.engine._normalize_verdict("pass")
        self.assertEqual(result, Verdict.Pass)

    def test_lowercase_converged_maps_to_pass(self):
        result = self.engine._normalize_verdict("converged")
        self.assertEqual(result, Verdict.Pass)


# ── AC3: resolve_role always returns AgentRole ────────────────────────────────

class TestResolveRole(unittest.TestCase):

    def setUp(self):
        self.engine, self.repo, self.conn = _make_engine()

    def tearDown(self):
        self.conn.close()

    def test_returns_ungated_when_no_pipeline(self):
        result = self.engine.resolve_role("nonexistent-scope", "some-agent")
        self.assertEqual(result, AgentRole.Ungated)

    def test_source_agent_returns_source(self):
        self.engine.create_pipeline("s1", "writer", [_verify_step()])
        result = self.engine.resolve_role("s1", "writer")
        self.assertEqual(result, AgentRole.Source)

    def test_active_verifier_returns_verifier(self):
        self.engine.create_pipeline("s2", "writer", [_verify_step("gt-reviewer")])
        result = self.engine.resolve_role("s2", "gt-reviewer")
        self.assertEqual(result, AgentRole.Verifier)

    def test_transformer_returns_transformer(self):
        self.engine.create_pipeline("s3", "writer", [_transform_step("gt-cleaner")])
        result = self.engine.resolve_role("s3", "gt-cleaner")
        self.assertEqual(result, AgentRole.Transformer)

    def test_fixer_in_fix_status_returns_fixer(self):
        self.engine.create_pipeline("s4", "writer", [_verify_fixer_step("gt-reviewer", "gt-fixer")])
        # Put step into Fix status
        self.repo.update_step_status("s4", 0, StepStatus.Fix)
        result = self.engine.resolve_role("s4", "gt-fixer")
        self.assertEqual(result, AgentRole.Fixer)

    def test_dispatch_order_transformer_over_verifier(self):
        """A transform step active agent -> Transformer, not Verifier."""
        self.engine.create_pipeline("s5", "writer", [_transform_step("gt-cleaner")])
        result = self.engine.resolve_role("s5", "gt-cleaner")
        self.assertEqual(result, AgentRole.Transformer)

    def test_unknown_agent_returns_ungated(self):
        self.engine.create_pipeline("s6", "writer", [_verify_step("gt-reviewer")])
        result = self.engine.resolve_role("s6", "random-agent")
        self.assertEqual(result, AgentRole.Ungated)

    def test_never_returns_none(self):
        result = self.engine.resolve_role("", "anything")
        self.assertIsNotNone(result)

    def test_empty_scope_searches_all_active(self):
        """AC3 edge: empty scope -> searches active pipelines."""
        self.engine.create_pipeline("sx", "writer", [_verify_step("gt-reviewer")])
        result = self.engine.resolve_role("", "gt-reviewer")
        # Should find it as Verifier in some active pipeline
        self.assertEqual(result, AgentRole.Verifier)

    def test_empty_scope_prefers_revision_state(self):
        """resolve_role with empty scope prefers Revision state pipelines."""
        self.engine.create_pipeline("r1", "writer", [_verify_step("gt-reviewer")])
        self.engine.create_pipeline("r2", "writer", [_verify_fixer_step("gt-reviewer2", "gt-fixer")])
        # Put r2 in revision state
        self.repo.update_pipeline_state("r2", {"status": PipelineStatus.Revision, "revision_step": 0})
        self.repo.update_step_status("r2", 0, StepStatus.Fix)
        # Fixer query for gt-fixer should find it in r2
        result = self.engine.resolve_role("", "gt-fixer")
        self.assertEqual(result, AgentRole.Fixer)


# ── AC4: Engine only sets DB state, never filesystem ─────────────────────────

class TestReviseExhaustion(unittest.TestCase):

    def setUp(self):
        self.engine, self.repo, self.conn = _make_engine()

    def tearDown(self):
        self.conn.close()

    def test_revise_exhaustion_sets_db_failed(self):
        self.engine.create_pipeline("ex1", "writer", [_verify_step("gt-reviewer", max_rounds=1)])
        # Round starts at 0. First REVISE: new_round=1, 1 > 1 false → revise, source returns.
        self.engine.step("ex1", "REVISE")
        # Source reactivates the step
        self.engine.step("ex1", {"role": "source", "artifactVerdict": ""})
        # Second REVISE: new_round=2, 2 > 1 → exhaustion
        action = self.engine.step("ex1", "REVISE")
        self.assertEqual(action["action"], "failed")
        state = self.repo.get_pipeline_state("ex1")
        self.assertEqual(state["status"], PipelineStatus.Failed)

    def test_revise_exhaustion_action_contains_round_info(self):
        self.engine.create_pipeline("ex2", "writer", [_verify_step("gt-reviewer", max_rounds=1)])
        self.engine.step("ex2", "REVISE")
        self.engine.step("ex2", {"role": "source", "artifactVerdict": ""})
        action = self.engine.step("ex2", "REVISE")
        self.assertIn("round", action)
        self.assertIn("maxRounds", action)


# ── AC5: Transaction wrapping ────────────────────────────────────────────────

class TestTransactionWrapping(unittest.TestCase):
    """Verify step() uses transact() — tested via state consistency, not threads.
    Python's sqlite3 module isn't thread-safe on a single connection, so
    concurrent testing isn't meaningful here. Transaction safety is verified
    by checking that step() produces consistent state transitions."""

    def test_step_state_is_consistent_after_pass(self):
        engine, repo, conn = _make_engine()
        engine.create_pipeline("tx1", "writer", [_verify_step("gt-reviewer")])
        action = engine.step("tx1", "PASS")
        self.assertEqual(action["action"], "done")
        state = repo.get_pipeline_state("tx1")
        self.assertEqual(state["status"], PipelineStatus.Completed)
        step = repo.get_step("tx1", 0)
        self.assertEqual(step["status"], StepStatus.Passed)
        conn.close()


# ── Edge Cases from spec ──────────────────────────────────────────────────────

class TestStepEdgeCases(unittest.TestCase):

    def setUp(self):
        self.engine, self.repo, self.conn = _make_engine()

    def tearDown(self):
        self.conn.close()

    def test_step_nonexistent_scope_returns_none(self):
        result = self.engine.step("does-not-exist", "PASS")
        self.assertIsNone(result)

    def test_step_completed_pipeline_returns_none(self):
        self.engine.create_pipeline("done1", "writer", [_verify_step()])
        self.repo.update_pipeline_state("done1", {"status": PipelineStatus.Completed})
        result = self.engine.step("done1", "PASS")
        self.assertIsNone(result)

    def test_step_failed_pipeline_returns_none(self):
        self.engine.create_pipeline("fail1", "writer", [_verify_step()])
        self.repo.update_pipeline_state("fail1", {"status": PipelineStatus.Failed})
        result = self.engine.step("fail1", "PASS")
        self.assertIsNone(result)


# ── create_pipeline ───────────────────────────────────────────────────────────

class TestCreatePipeline(unittest.TestCase):

    def setUp(self):
        self.engine, self.repo, self.conn = _make_engine()

    def tearDown(self):
        self.conn.close()

    def test_create_pipeline_sets_first_step_active(self):
        self.engine.create_pipeline("cp1", "writer", [_check_step(), _verify_step()])
        step0 = self.repo.get_step("cp1", 0)
        step1 = self.repo.get_step("cp1", 1)
        self.assertEqual(step0["status"], StepStatus.Active)
        self.assertEqual(step1["status"], StepStatus.Pending)

    def test_create_pipeline_idempotent(self):
        """Calling create_pipeline twice on same scope is a no-op."""
        self.engine.create_pipeline("cp2", "writer", [_verify_step()])
        self.engine.create_pipeline("cp2", "writer", [_verify_step(), _verify_step()])
        state = self.repo.get_pipeline_state("cp2")
        self.assertEqual(state["total_steps"], 1)

    def test_create_pipeline_inserts_state_row(self):
        self.engine.create_pipeline("cp3", "writer", [_verify_step(), _verify_step()])
        state = self.repo.get_pipeline_state("cp3")
        self.assertIsNotNone(state)
        self.assertEqual(state["total_steps"], 2)
        self.assertEqual(state["source_agent"], "writer")


# ── step() transitions ────────────────────────────────────────────────────────

class TestStepTransitions(unittest.TestCase):

    def setUp(self):
        self.engine, self.repo, self.conn = _make_engine()

    def tearDown(self):
        self.conn.close()

    def test_pass_advances_to_next_step(self):
        self.engine.create_pipeline("t1", "writer", [_verify_step("gt-r"), _verify_step("gt-r2")])
        action = self.engine.step("t1", "PASS")
        state = self.repo.get_pipeline_state("t1")
        self.assertEqual(state["current_step"], 1)
        step1 = self.repo.get_step("t1", 1)
        self.assertEqual(step1["status"], StepStatus.Active)

    def test_pass_on_last_step_completes_pipeline(self):
        self.engine.create_pipeline("t2", "writer", [_verify_step("gt-r")])
        action = self.engine.step("t2", "PASS")
        self.assertEqual(action["action"], "done")
        state = self.repo.get_pipeline_state("t2")
        self.assertEqual(state["status"], PipelineStatus.Completed)

    def test_revise_sets_pipeline_to_revision(self):
        self.engine.create_pipeline("t3", "writer", [_verify_step("gt-r", max_rounds=3)])
        action = self.engine.step("t3", "REVISE")
        state = self.repo.get_pipeline_state("t3")
        self.assertEqual(state["status"], PipelineStatus.Revision)
        self.assertEqual(action["action"], "source")
        self.assertEqual(action["agent"], "writer")

    def test_revise_with_fixer_returns_fixer_agent(self):
        self.engine.create_pipeline("t4", "writer", [_verify_fixer_step("gt-r", "gt-fixer", max_rounds=3)])
        action = self.engine.step("t4", "REVISE")
        self.assertEqual(action["action"], "source")
        self.assertEqual(action["agent"], "gt-fixer")

    def test_transform_step_auto_advances_for_transformer(self):
        """When active step is TRANSFORM and role=Transformer, advance without verdict."""
        self.engine.create_pipeline("t5", "writer", [_transform_step("gt-cleaner"), _verify_step("gt-r")])
        action = self.engine.step("t5", {"role": "transformer", "artifactVerdict": "UNKNOWN"})
        state = self.repo.get_pipeline_state("t5")
        self.assertEqual(state["current_step"], 1)

    def test_fixer_reactivates_revision_step(self):
        """After fixer completes, revision step is reactivated."""
        self.engine.create_pipeline("t6", "writer", [_verify_fixer_step("gt-r", "gt-fixer", max_rounds=3)])
        # Send REVISE to put into Fix status
        self.engine.step("t6", "REVISE")
        # Now fixer completes
        action = self.engine.step("t6", {"role": "fixer", "artifactVerdict": "DONE"})
        # Should have reactivated the verify step
        step0 = self.repo.get_step("t6", 0)
        self.assertEqual(step0["status"], StepStatus.Active)

    def test_source_in_revision_reactivates_step(self):
        """After source revises in Revision state, step gets reactivated."""
        self.engine.create_pipeline("t7", "writer", [_verify_step("gt-r", max_rounds=3)])
        # REVISE -> revision state
        self.engine.step("t7", "REVISE")
        # source completes revision
        action = self.engine.step("t7", {"role": "source", "artifactVerdict": "DONE"})
        step0 = self.repo.get_step("t7", 0)
        self.assertEqual(step0["status"], StepStatus.Active)

    def test_check_step_returns_semantic_action(self):
        self.engine.create_pipeline("t8", "writer", [_check_step("Is it good?")])
        action = self.engine.get_next_action("t8")
        self.assertEqual(action["action"], "semantic")

    def test_converged_treated_as_pass(self):
        self.engine.create_pipeline("t9", "writer", [_verify_step("gt-r")])
        action = self.engine.step("t9", "CONVERGED")
        state = self.repo.get_pipeline_state("t9")
        self.assertEqual(state["status"], PipelineStatus.Completed)

    def test_step_with_istepinput_dict(self):
        """step() accepts IStepInput dict."""
        self.engine.create_pipeline("t10", "writer", [_verify_step("gt-r")])
        action = self.engine.step("t10", {"role": "verifier", "artifactVerdict": "PASS"})
        state = self.repo.get_pipeline_state("t10")
        self.assertEqual(state["status"], PipelineStatus.Completed)


# ── get_next_action / get_all_next_actions ────────────────────────────────────

class TestActionQueries(unittest.TestCase):

    def setUp(self):
        self.engine, self.repo, self.conn = _make_engine()

    def tearDown(self):
        self.conn.close()

    def test_get_next_action_returns_none_for_unknown_scope(self):
        result = self.engine.get_next_action("unknown")
        self.assertIsNone(result)

    def test_get_next_action_returns_spawn_for_verify_step(self):
        self.engine.create_pipeline("a1", "writer", [_verify_step("gt-r")])
        action = self.engine.get_next_action("a1")
        self.assertEqual(action["action"], "spawn")
        self.assertEqual(action["agent"], "gt-r")

    def test_get_all_next_actions_empty_when_no_pipelines(self):
        results = self.engine.get_all_next_actions()
        self.assertEqual(results, [])

    def test_get_all_next_actions_returns_all_active(self):
        self.engine.create_pipeline("b1", "w1", [_verify_step("gt-r1")])
        self.engine.create_pipeline("b2", "w2", [_verify_step("gt-r2")])
        results = self.engine.get_all_next_actions()
        self.assertEqual(len(results), 2)


# ── retry_gate_agent ──────────────────────────────────────────────────────────

class TestRetryGateAgent(unittest.TestCase):

    def setUp(self):
        self.engine, self.repo, self.conn = _make_engine()

    def tearDown(self):
        self.conn.close()

    def test_retry_increments_round(self):
        self.engine.create_pipeline("rg1", "writer", [_verify_step("gt-r", max_rounds=3)])
        action = self.engine.retry_gate_agent("rg1")
        step0 = self.repo.get_step("rg1", 0)
        self.assertEqual(step0["round"], 1)

    def test_retry_exhaustion_sets_failed(self):
        self.engine.create_pipeline("rg2", "writer", [_verify_step("gt-r", max_rounds=1)])
        # round is 0, max_rounds is 1; new_round=1 is not > 1 so first retry ok
        action = self.engine.retry_gate_agent("rg2")
        self.assertNotEqual(action["action"], "failed")
        # Now round=1, max_rounds=1; new_round=2 > 1 -> fail
        action2 = self.engine.retry_gate_agent("rg2")
        self.assertEqual(action2["action"], "failed")
        state = self.repo.get_pipeline_state("rg2")
        self.assertEqual(state["status"], PipelineStatus.Failed)

    def test_retry_no_active_step_returns_none(self):
        self.engine.create_pipeline("rg3", "writer", [_verify_step("gt-r")])
        # Mark step as passed
        self.repo.update_step_status("rg3", 0, StepStatus.Passed)
        result = self.engine.retry_gate_agent("rg3")
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
