import os
import re
import shutil
import sqlite3
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
    """Create a session dir and initialize schema, return path."""
    session_dir = os.path.join(root, "sessions", "abc12345")
    os.makedirs(session_dir, exist_ok=True)
    conn = open_database(session_dir)
    PipelineRepository.init_schema(conn)
    conn.close()
    return session_dir


def _make_plans_dir(root: str) -> str:
    plans_dir = os.path.join(root, ".claude", "plans")
    os.makedirs(plans_dir, exist_ok=True)
    return plans_dir


def _write_plan(plans_dir: str, name: str, line_count: int) -> str:
    path = os.path.join(plans_dir, name)
    with open(path, "w") as f:
        f.write("\n".join(["line"] * line_count))
    return path


def _run_exit_plan_mode(data, tmp_root, session_dir):
    """Helper: run on_exit_plan_mode with common patches applied."""
    from src.claude_gates import plan_gate
    with patch("src.claude_gates.plan_gate.is_gate_disabled", return_value=False), \
         patch("src.claude_gates.plan_gate.get_session_dir", return_value=session_dir), \
         patch.dict(os.environ, {"HOME": tmp_root, "USERPROFILE": tmp_root}):
        return plan_gate.on_exit_plan_mode(data)


def _run_clear(data, session_dir):
    from src.claude_gates import plan_gate
    with patch("src.claude_gates.plan_gate.is_gate_disabled", return_value=False), \
         patch("src.claude_gates.plan_gate.get_session_dir", return_value=session_dir):
        return plan_gate.on_clear(data)


# ─────────────────────────────────────────────────────────────────────────────
# on_exit_plan_mode tests
# ─────────────────────────────────────────────────────────────────────────────

class TestOnExitPlanModeGateDisabled(unittest.TestCase):
    """Gate disabled → return {}."""

    def test_gate_disabled_returns_empty(self):
        from src.claude_gates import plan_gate
        with patch("src.claude_gates.plan_gate.is_gate_disabled", return_value=True):
            result = plan_gate.on_exit_plan_mode({"session_id": "abc123"})
        self.assertEqual(result, {})


class TestOnExitPlanModeNoSession(unittest.TestCase):
    """No session_id → return {}."""

    def test_no_session_id_returns_empty(self):
        from src.claude_gates import plan_gate
        with patch("src.claude_gates.plan_gate.is_gate_disabled", return_value=False):
            result = plan_gate.on_exit_plan_mode({})
        self.assertEqual(result, {})

    def test_empty_session_id_returns_empty(self):
        from src.claude_gates import plan_gate
        with patch("src.claude_gates.plan_gate.is_gate_disabled", return_value=False):
            result = plan_gate.on_exit_plan_mode({"session_id": ""})
        self.assertEqual(result, {})


class TestOnExitPlanModeGaterVerified(unittest.TestCase):
    """Gater PASS/CONVERGED verdict in SQLite → return {}."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _insert_verdict(self, verdict):
        conn = open_database(self.session_dir)
        conn.execute(
            "INSERT INTO agents (scope, agent, verdict) VALUES ('test-scope', 'gater', ?)",
            (verdict,),
        )
        conn.close()

    def test_gater_pass_verdict_allows(self):
        self._insert_verdict("PASS")
        result = _run_exit_plan_mode({"session_id": "abc12345"}, self.tmp, self.session_dir)
        self.assertEqual(result, {})

    def test_gater_converged_verdict_allows(self):
        self._insert_verdict("CONVERGED")
        result = _run_exit_plan_mode({"session_id": "abc12345"}, self.tmp, self.session_dir)
        self.assertEqual(result, {})

    def test_gater_revise_verdict_does_not_allow(self):
        """REVISE verdict should NOT allow — continues to block check."""
        self._insert_verdict("REVISE")
        plans_dir = _make_plans_dir(self.tmp)
        _write_plan(plans_dir, "myplan.md", 25)
        result = _run_exit_plan_mode({"session_id": "abc12345"}, self.tmp, self.session_dir)
        self.assertEqual(result.get("decision"), "block")


class TestOnExitPlanModeTrivialPlan(unittest.TestCase):
    """Trivial plan (<=20 lines) → return {}."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)
        self.plans_dir = _make_plans_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_exactly_20_lines_is_trivial(self):
        _write_plan(self.plans_dir, "myplan.md", 20)
        result = _run_exit_plan_mode({"session_id": "abc12345"}, self.tmp, self.session_dir)
        self.assertEqual(result, {})

    def test_1_line_is_trivial(self):
        _write_plan(self.plans_dir, "myplan.md", 1)
        result = _run_exit_plan_mode({"session_id": "abc12345"}, self.tmp, self.session_dir)
        self.assertEqual(result, {})

    def test_21_lines_is_not_trivial(self):
        _write_plan(self.plans_dir, "myplan.md", 21)
        result = _run_exit_plan_mode({"session_id": "abc12345"}, self.tmp, self.session_dir)
        self.assertIn("decision", result)
        self.assertEqual(result["decision"], "block")


class TestOnExitPlanModeNoPlanDir(unittest.TestCase):
    """No plans dir → fail-open, return {}."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_no_plans_dir_returns_empty(self):
        # No plans dir created in self.tmp
        result = _run_exit_plan_mode({"session_id": "abc12345"}, self.tmp, self.session_dir)
        self.assertEqual(result, {})


class TestOnExitPlanModeNoPlansInDir(unittest.TestCase):
    """Plans dir exists but no .md files → return {}."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)
        self.plans_dir = _make_plans_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_no_md_files_returns_empty(self):
        result = _run_exit_plan_mode({"session_id": "abc12345"}, self.tmp, self.session_dir)
        self.assertEqual(result, {})

    def test_agent_md_files_filtered_out_returns_empty(self):
        """Files with -agent- in name are filtered and should not count."""
        _write_plan(self.plans_dir, "plan-agent-review.md", 30)
        result = _run_exit_plan_mode({"session_id": "abc12345"}, self.tmp, self.session_dir)
        self.assertEqual(result, {})

    def test_mixed_dir_non_agent_files_still_trigger_gate(self):
        """AC5: directory with both agent and non-agent .md files — non-agent ones trigger gate."""
        _write_plan(self.plans_dir, "plan-agent-review.md", 30)  # filtered out
        _write_plan(self.plans_dir, "myplan.md", 25)             # should trigger gate
        result = _run_exit_plan_mode({"session_id": "abc12345"}, self.tmp, self.session_dir)
        self.assertEqual(result.get("decision"), "block")


class TestOnExitPlanModeSafetyValve(unittest.TestCase):
    """Safety valve: >= MAX_ATTEMPTS → reset attempts, return {}, write stderr warning."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)
        self.plans_dir = _make_plans_dir(self.tmp)
        _write_plan(self.plans_dir, "myplan.md", 25)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self):
        return _run_exit_plan_mode({"session_id": "abc12345"}, self.tmp, self.session_dir)

    def test_first_attempt_blocks(self):
        result = self._run()
        self.assertEqual(result.get("decision"), "block")

    def test_second_attempt_blocks(self):
        self._run()  # attempt 1
        result = self._run()  # attempt 2
        self.assertEqual(result.get("decision"), "block")

    def test_third_attempt_is_safety_valve_returns_system_message(self):
        """Third attempt hits safety valve (MAX_ATTEMPTS=3) → systemMessage (not a block)."""
        self._run()  # attempt 1
        self._run()  # attempt 2
        result = self._run()  # attempt 3 — safety valve
        # AC1: safety valve returns a systemMessage dict (allows exit, informs LLM)
        self.assertIn("systemMessage", result)
        self.assertNotIn("decision", result)

    def test_third_attempt_safety_valve_not_a_block(self):
        """Safety valve must not return a block decision."""
        self._run()  # 1
        self._run()  # 2
        result = self._run()  # 3 — safety valve
        self.assertNotEqual(result.get("decision"), "block")

    def test_safety_valve_resets_attempts(self):
        """After safety valve fires, attempts are reset so next cycle starts fresh."""
        self._run()  # 1
        self._run()  # 2
        self._run()  # 3 — safety valve fires, resets
        result = self._run()  # 4 — should block again (new cycle attempt 1)
        self.assertEqual(result.get("decision"), "block")


class TestOnExitPlanModeBlock(unittest.TestCase):
    """Non-trivial plan, not verified, under MAX_ATTEMPTS → block dict returned."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)
        self.plans_dir = _make_plans_dir(self.tmp)
        _write_plan(self.plans_dir, "bigplan.md", 25)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self):
        return _run_exit_plan_mode({"session_id": "abc12345"}, self.tmp, self.session_dir)

    def test_block_has_decision_and_reason(self):
        result = self._run()
        self.assertEqual(result["decision"], "block")
        self.assertIn("reason", result)

    def test_block_reason_mentions_plan_filename(self):
        result = self._run()
        self.assertIn("bigplan.md", result["reason"])

    def test_block_reason_mentions_gater(self):
        result = self._run()
        self.assertIn("gater", result["reason"])


# ─────────────────────────────────────────────────────────────────────────────
# on_clear tests
# ─────────────────────────────────────────────────────────────────────────────

class TestOnClearGateDisabled(unittest.TestCase):
    """Gate disabled → return {}."""

    def test_gate_disabled_returns_empty(self):
        from src.claude_gates import plan_gate
        with patch("src.claude_gates.plan_gate.is_gate_disabled", return_value=True):
            result = plan_gate.on_clear({"session_id": "abc123"})
        self.assertEqual(result, {})


class TestOnClearNoSession(unittest.TestCase):
    """No session_id → return {}."""

    def test_no_session_id_returns_empty(self):
        from src.claude_gates import plan_gate
        with patch("src.claude_gates.plan_gate.is_gate_disabled", return_value=False):
            result = plan_gate.on_clear({})
        self.assertEqual(result, {})

    def test_empty_session_id_returns_empty(self):
        from src.claude_gates import plan_gate
        with patch("src.claude_gates.plan_gate.is_gate_disabled", return_value=False):
            result = plan_gate.on_clear({"session_id": ""})
        self.assertEqual(result, {})


class TestOnClearDeletesGaterVerdicts(unittest.TestCase):
    """on_clear deletes gater rows with non-null verdict from agents table."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_dir = _make_session_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _read_agents(self, query, params=()):
        conn = open_database(self.session_dir)
        cursor = conn.execute(query, params)
        result = cursor.fetchone()
        conn.close()
        return result

    def test_returns_empty_dict(self):
        result = _run_clear({"session_id": "abc12345"}, self.session_dir)
        self.assertEqual(result, {})

    def test_gater_verdict_deleted(self):
        """Gater rows with non-null verdict are removed."""
        conn = open_database(self.session_dir)
        conn.execute(
            "INSERT INTO agents (scope, agent, verdict) VALUES ('s1', 'gater', 'PASS')"
        )
        conn.close()
        _run_clear({"session_id": "abc12345"}, self.session_dir)
        row = self._read_agents(
            "SELECT 1 FROM agents WHERE agent = 'gater' AND verdict IS NOT NULL"
        )
        self.assertIsNone(row)

    def test_gater_null_verdict_not_deleted(self):
        """Gater rows with NULL verdict are preserved."""
        conn = open_database(self.session_dir)
        conn.execute(
            "INSERT INTO agents (scope, agent, verdict) VALUES ('s1', 'gater', NULL)"
        )
        conn.close()
        _run_clear({"session_id": "abc12345"}, self.session_dir)
        row = self._read_agents(
            "SELECT 1 FROM agents WHERE agent = 'gater' AND verdict IS NULL"
        )
        self.assertIsNotNone(row)

    def test_other_agents_not_deleted(self):
        """Non-gater agents are not affected."""
        conn = open_database(self.session_dir)
        conn.execute(
            "INSERT INTO agents (scope, agent, verdict) VALUES ('s1', 'reviewer', 'PASS')"
        )
        conn.close()
        _run_clear({"session_id": "abc12345"}, self.session_dir)
        row = self._read_agents("SELECT 1 FROM agents WHERE agent = 'reviewer'")
        self.assertIsNotNone(row)

    def test_gater_across_all_scopes_deleted(self):
        """All gater verdicts across all scopes are cleared."""
        conn = open_database(self.session_dir)
        conn.execute(
            "INSERT INTO agents (scope, agent, verdict) VALUES ('scope1', 'gater', 'PASS')"
        )
        conn.execute(
            "INSERT INTO agents (scope, agent, verdict) VALUES ('scope2', 'gater', 'CONVERGED')"
        )
        conn.close()
        _run_clear({"session_id": "abc12345"}, self.session_dir)
        conn2 = open_database(self.session_dir)
        cursor = conn2.execute(
            "SELECT COUNT(*) FROM agents WHERE agent = 'gater' AND verdict IS NOT NULL"
        )
        count = cursor.fetchone()[0]
        conn2.close()
        self.assertEqual(count, 0)


if __name__ == "__main__":
    unittest.main()
