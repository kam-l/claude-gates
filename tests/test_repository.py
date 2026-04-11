import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates.types import StepStatus, IPipelineState, IAgentRow


def _make_db() -> sqlite3.Connection:
    """Create an in-memory SQLite connection with settings matching open_database."""
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _import_repo():
    from src.claude_gates.repository import PipelineRepository
    return PipelineRepository


class TestInitSchema(unittest.TestCase):
    """AC3 + AC5: Schema creation via executescript(), CREATE TABLE IF NOT EXISTS, no trigger."""

    def setUp(self):
        self.conn = _make_db()
        PipelineRepository = _import_repo()
        PipelineRepository.init_schema(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_all_five_tables_exist(self):
        cursor = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        tables = {row[0] for row in cursor.fetchall()}
        expected = {"pipeline_steps", "pipeline_state", "agents", "edits", "tool_history"}
        self.assertTrue(expected.issubset(tables), f"Missing tables: {expected - tables}")

    def test_no_trim_history_trigger_in_schema(self):
        """AC4: Trim is done in Python, not via a SQLite trigger."""
        cursor = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name='trim_history'"
        )
        row = cursor.fetchone()
        self.assertIsNone(row, "trim_history trigger should NOT exist — Python handles trimming")

    def test_init_schema_idempotent(self):
        """Calling init_schema twice should not raise."""
        PipelineRepository = _import_repo()
        try:
            PipelineRepository.init_schema(self.conn)
        except Exception as e:
            self.fail(f"init_schema raised on second call: {e}")

    def test_pipeline_steps_columns(self):
        cursor = self.conn.execute("PRAGMA table_info(pipeline_steps)")
        cols = {row[1] for row in cursor.fetchall()}
        expected = {
            "scope", "step_index", "step_type", "prompt", "command",
            "allowed_tools", "agent", "max_rounds", "fixer", "status",
            "round", "source_agent",
        }
        self.assertEqual(expected, cols)

    def test_pipeline_state_columns(self):
        cursor = self.conn.execute("PRAGMA table_info(pipeline_state)")
        cols = {row[1] for row in cursor.fetchall()}
        expected = {
            "scope", "source_agent", "status", "current_step",
            "revision_step", "total_steps", "trace_id", "created_at",
        }
        self.assertEqual(expected, cols)

    def test_agents_columns(self):
        cursor = self.conn.execute("PRAGMA table_info(agents)")
        cols = {row[1] for row in cursor.fetchall()}
        expected = {"scope", "agent", "outputFilepath", "verdict", "check", "round", "attempts"}
        self.assertEqual(expected, cols)


class TestPipelineCRUD(unittest.TestCase):
    """Pipeline insert, query, update, delete operations."""

    def setUp(self):
        self.conn = _make_db()
        PipelineRepository = _import_repo()
        PipelineRepository.init_schema(self.conn)
        self.repo = PipelineRepository(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_insert_pipeline_and_exists(self):
        self.repo.insert_pipeline("scope1", "writer", 3)
        self.assertTrue(self.repo.pipeline_exists("scope1"))

    def test_pipeline_not_exists_returns_false(self):
        self.assertFalse(self.repo.pipeline_exists("nope"))

    def test_get_pipeline_state_returns_none_for_missing(self):
        """Edge case: get_pipeline_state on non-existent scope returns None, not error."""
        result = self.repo.get_pipeline_state("nonexistent")
        self.assertIsNone(result)

    def test_get_pipeline_state_returns_state(self):
        self.repo.insert_pipeline("scope1", "writer", 3)
        state = self.repo.get_pipeline_state("scope1")
        self.assertIsNotNone(state)
        self.assertEqual(state["scope"], "scope1")
        self.assertEqual(state["source_agent"], "writer")
        self.assertEqual(state["total_steps"], 3)
        self.assertEqual(state["status"], "normal")
        self.assertEqual(state["current_step"], 0)

    def _check_step(self) -> dict:
        """Helper: minimal CHECK VerificationStep dict."""
        return {"type": "CHECK", "prompt": "Is it good?"}

    def _verify_step(self) -> dict:
        """Helper: minimal VERIFY VerificationStep dict."""
        return {"type": "VERIFY", "agent": "reviewer", "maxRounds": 3}

    def test_insert_step_sets_first_step_active(self):
        self.repo.insert_pipeline("scope1", "writer", 2)
        self.repo.insert_step("scope1", 0, self._check_step(), "writer")
        result = self.repo.get_step("scope1", 0)
        self.assertIsNotNone(result)
        self.assertEqual(result["status"], StepStatus.Active)

    def test_insert_step_sets_non_first_step_pending(self):
        self.repo.insert_pipeline("scope1", "writer", 2)
        self.repo.insert_step("scope1", 0, self._check_step(), "writer")
        self.repo.insert_step("scope1", 1, self._check_step(), "writer")
        result1 = self.repo.get_step("scope1", 1)
        self.assertEqual(result1["status"], StepStatus.Pending)

    def test_get_active_step(self):
        self.repo.insert_pipeline("scope1", "writer", 1)
        self.repo.insert_step("scope1", 0, self._check_step(), "writer")
        active = self.repo.get_active_step("scope1")
        self.assertIsNotNone(active)
        self.assertEqual(active["step_index"], 0)

    def test_update_step_status(self):
        self.repo.insert_pipeline("scope1", "writer", 1)
        self.repo.insert_step("scope1", 0, self._check_step(), "writer")
        self.repo.update_step_status("scope1", 0, StepStatus.Passed)
        result = self.repo.get_step("scope1", 0)
        self.assertEqual(result["status"], StepStatus.Passed)

    def test_update_step_status_with_round(self):
        self.repo.insert_pipeline("scope1", "writer", 1)
        self.repo.insert_step("scope1", 0, self._verify_step(), "writer")
        self.repo.update_step_status("scope1", 0, StepStatus.Revise, round=2)
        result = self.repo.get_step("scope1", 0)
        self.assertEqual(result["round"], 2)

    def test_update_pipeline_state(self):
        self.repo.insert_pipeline("scope1", "writer", 3)
        self.repo.update_pipeline_state("scope1", {"current_step": 2, "status": "revision"})
        state = self.repo.get_pipeline_state("scope1")
        self.assertEqual(state["current_step"], 2)
        self.assertEqual(state["status"], "revision")

    def test_delete_pipeline_removes_state_and_steps(self):
        """Edge case: delete_pipeline cascading cleanup."""
        self.repo.insert_pipeline("scope1", "writer", 1)
        self.repo.insert_step("scope1", 0, self._check_step(), "writer")
        self.repo.delete_pipeline("scope1")
        self.assertIsNone(self.repo.get_pipeline_state("scope1"))
        self.assertEqual(self.repo.get_steps("scope1"), [])

    def test_get_active_pipelines(self):
        self.repo.insert_pipeline("scope1", "writer", 1)
        self.repo.insert_pipeline("scope2", "writer", 1)
        self.repo.update_pipeline_state("scope2", {"status": "completed"})
        active = self.repo.get_active_pipelines()
        scopes = [p["scope"] for p in active]
        self.assertIn("scope1", scopes)
        self.assertNotIn("scope2", scopes)

    def test_has_non_passed_steps_true(self):
        self.repo.insert_pipeline("scope1", "writer", 1)
        self.repo.insert_step("scope1", 0, self._check_step(), "writer")
        self.assertTrue(self.repo.has_non_passed_steps("scope1"))

    def test_has_non_passed_steps_false_after_passing(self):
        self.repo.insert_pipeline("scope1", "writer", 1)
        self.repo.insert_step("scope1", 0, self._check_step(), "writer")
        self.repo.update_step_status("scope1", 0, StepStatus.Passed)
        self.assertFalse(self.repo.has_non_passed_steps("scope1"))

    def test_get_steps_returns_ordered_list(self):
        self.repo.insert_pipeline("scope1", "writer", 2)
        self.repo.insert_step("scope1", 0, self._check_step(), "writer")
        self.repo.insert_step("scope1", 1, self._check_step(), "writer")
        steps = self.repo.get_steps("scope1")
        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[0]["step_index"], 0)
        self.assertEqual(steps[1]["step_index"], 1)

    def test_get_step_by_status(self):
        self.repo.insert_pipeline("scope1", "writer", 2)
        self.repo.insert_step("scope1", 0, self._check_step(), "writer")
        self.repo.insert_step("scope1", 1, self._check_step(), "writer")
        # step 0 is active (first step), step 1 is pending
        result = self.repo.get_step_by_status("scope1", StepStatus.Pending)
        self.assertIsNotNone(result)
        self.assertEqual(result["step_index"], 1)


class TestAgentCRUD(unittest.TestCase):
    """Agent register, set_verdict (upsert), get, is_cleared, find_scope, get_pending."""

    def setUp(self):
        self.conn = _make_db()
        PipelineRepository = _import_repo()
        PipelineRepository.init_schema(self.conn)
        self.repo = PipelineRepository(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_register_agent(self):
        self.repo.register_agent("scope1", "reviewer", "/path/output.md")
        agent = self.repo.get_agent("scope1", "reviewer")
        self.assertIsNotNone(agent)
        self.assertEqual(agent["outputFilepath"], "/path/output.md")

    def test_register_agent_upserts_filepath(self):
        self.repo.register_agent("scope1", "reviewer", "/old/path.md")
        self.repo.register_agent("scope1", "reviewer", "/new/path.md")
        agent = self.repo.get_agent("scope1", "reviewer")
        self.assertEqual(agent["outputFilepath"], "/new/path.md")

    def test_set_verdict_upsert_without_prior_register(self):
        """AC1: set_verdict uses INSERT...ON CONFLICT so it works without prior register_agent."""
        # No register_agent call first
        self.repo.set_verdict("scope1", "reviewer", "PASS", 1)
        agent = self.repo.get_agent("scope1", "reviewer")
        self.assertIsNotNone(agent)
        self.assertEqual(agent["verdict"], "PASS")
        self.assertEqual(agent["round"], 1)

    def test_set_verdict_after_register(self):
        """AC1: set_verdict also works when row already exists via register_agent."""
        self.repo.register_agent("scope1", "reviewer", "/path/output.md")
        self.repo.set_verdict("scope1", "reviewer", "REVISE", 2)
        agent = self.repo.get_agent("scope1", "reviewer")
        self.assertEqual(agent["verdict"], "REVISE")
        self.assertEqual(agent["round"], 2)
        # outputFilepath preserved by upsert
        self.assertEqual(agent["outputFilepath"], "/path/output.md")

    def test_set_verdict_with_null_verdict(self):
        """Edge case: set_verdict with None (clear scenario)."""
        self.repo.register_agent("scope1", "reviewer", "/path/output.md")
        self.repo.set_verdict("scope1", "reviewer", None, 0)
        agent = self.repo.get_agent("scope1", "reviewer")
        self.assertIsNone(agent["verdict"])

    def test_set_verdict_with_check(self):
        self.repo.register_agent("scope1", "reviewer", "/path/output.md")
        self.repo.set_verdict("scope1", "reviewer", "PASS", 1, check="semantic check passed")
        agent = self.repo.get_agent("scope1", "reviewer")
        self.assertEqual(agent["check"], "semantic check passed")

    def test_is_cleared_true_after_register(self):
        self.repo.register_agent("scope1", "reviewer", "/path/output.md")
        self.assertTrue(self.repo.is_cleared("scope1", "reviewer"))

    def test_is_cleared_false_when_not_registered(self):
        self.assertFalse(self.repo.is_cleared("scope1", "unknown"))

    def test_get_agent_returns_none_for_missing(self):
        result = self.repo.get_agent("scope1", "nobody")
        self.assertIsNone(result)

    def test_find_agent_scope(self):
        self.repo.insert_pipeline("scope1", "writer", 1)
        self.repo.register_agent("scope1", "reviewer", "/path/output.md")
        scope = self.repo.find_agent_scope("reviewer")
        self.assertEqual(scope, "scope1")

    def test_find_agent_scope_returns_none_when_not_found(self):
        result = self.repo.find_agent_scope("ghost-agent")
        self.assertIsNone(result)

    def test_get_pending(self):
        self.repo.register_agent("_pending", "reviewer", "/path/output.md")
        pending = self.repo.get_pending("reviewer")
        self.assertIsNotNone(pending)
        self.assertEqual(pending["scope"], "_pending")
        self.assertEqual(pending["outputFilepath"], "/path/output.md")

    def test_get_pending_returns_none_when_missing(self):
        result = self.repo.get_pending("nobody")
        self.assertIsNone(result)


class TestGateMethods(unittest.TestCase):
    """Gate methods: get_attempts, incr_attempts, reset_attempts, upsert_verdict."""

    def setUp(self):
        self.conn = _make_db()
        PipelineRepository = _import_repo()
        PipelineRepository.init_schema(self.conn)
        self.repo = PipelineRepository(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_get_attempts_returns_zero_for_new(self):
        result = self.repo.get_attempts("scope1", "gater")
        self.assertEqual(result, 0)

    def test_incr_attempts_creates_row(self):
        self.repo.incr_attempts("scope1", "gater")
        self.assertEqual(self.repo.get_attempts("scope1", "gater"), 1)

    def test_incr_attempts_increments(self):
        self.repo.incr_attempts("scope1", "gater")
        self.repo.incr_attempts("scope1", "gater")
        self.assertEqual(self.repo.get_attempts("scope1", "gater"), 2)

    def test_reset_attempts(self):
        self.repo.incr_attempts("scope1", "gater")
        self.repo.incr_attempts("scope1", "gater")
        self.repo.reset_attempts("scope1", "gater")
        self.assertEqual(self.repo.get_attempts("scope1", "gater"), 0)

    def test_upsert_verdict_no_prior_row(self):
        """upsert_verdict (gate pattern) works without prior register_agent — INSERT ON CONFLICT."""
        self.repo.upsert_verdict("scope1", "gater", "PASS", 1)
        agent = self.repo.get_agent("scope1", "gater")
        self.assertIsNotNone(agent)
        self.assertEqual(agent["verdict"], "PASS")

    def test_upsert_verdict_with_existing_row(self):
        self.repo.incr_attempts("scope1", "gater")  # creates row
        self.repo.upsert_verdict("scope1", "gater", "REVISE", 2)
        agent = self.repo.get_agent("scope1", "gater")
        self.assertEqual(agent["verdict"], "REVISE")
        self.assertEqual(agent["round"], 2)

    def test_set_verdict_vs_upsert_verdict_distinction(self):
        """
        AC1 critical check: set_verdict uses upsert (works without prior register).
        upsert_verdict is the gate-pattern method (from GateRepository).
        Both must work without prior register_agent.
        """
        # set_verdict without prior register
        self.repo.set_verdict("scope1", "agent-a", "PASS", 1)
        row_a = self.repo.get_agent("scope1", "agent-a")
        self.assertIsNotNone(row_a, "set_verdict must work without prior register_agent")

        # upsert_verdict without prior register
        self.repo.upsert_verdict("scope1", "agent-b", "REVISE", 1)
        row_b = self.repo.get_agent("scope1", "agent-b")
        self.assertIsNotNone(row_b, "upsert_verdict must work without prior register_agent")


class TestEditTracking(unittest.TestCase):

    def setUp(self):
        self.conn = _make_db()
        PipelineRepository = _import_repo()
        PipelineRepository.init_schema(self.conn)
        self.repo = PipelineRepository(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_add_edit_and_get_edits(self):
        self.repo.add_edit("/path/to/file.py", 10)
        edits = self.repo.get_edits()
        self.assertIn("/path/to/file.py", edits)

    def test_add_edit_accumulates_lines(self):
        self.repo.add_edit("/path/to/file.py", 5)
        self.repo.add_edit("/path/to/file.py", 3)
        counts = self.repo.get_edit_counts()
        self.assertEqual(counts["files"], 1)
        self.assertEqual(counts["lines"], 8)

    def test_get_edit_counts_empty(self):
        counts = self.repo.get_edit_counts()
        self.assertEqual(counts["files"], 0)
        self.assertEqual(counts["lines"], 0)


class TestToolHistory(unittest.TestCase):

    def setUp(self):
        self.conn = _make_db()
        PipelineRepository = _import_repo()
        PipelineRepository.init_schema(self.conn)
        self.repo = PipelineRepository(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_add_tool_hash_and_get(self):
        self.repo.add_tool_hash("abc123")
        hashes = self.repo.get_last_n_hashes(5)
        self.assertIn("abc123", hashes)

    def test_get_last_n_hashes_order(self):
        for i in range(5):
            self.repo.add_tool_hash(f"hash{i}")
        hashes = self.repo.get_last_n_hashes(3)
        self.assertEqual(len(hashes), 3)
        # Most recent first
        self.assertEqual(hashes[0], "hash4")
        self.assertEqual(hashes[1], "hash3")
        self.assertEqual(hashes[2], "hash2")

    def test_add_tool_hash_trims_to_10_in_python(self):
        """AC4: After 10+ inserts, Python code keeps only last 10. No trigger."""
        for i in range(15):
            self.repo.add_tool_hash(f"hash{i:03d}")
        hashes = self.repo.get_last_n_hashes(100)
        self.assertEqual(len(hashes), 10, f"Expected 10 rows, got {len(hashes)}")
        # Most recent should be hash014
        self.assertEqual(hashes[0], "hash014")

    def test_add_tool_hash_trim_keeps_most_recent(self):
        """AC4: Trim keeps the last 10, drops oldest."""
        for i in range(12):
            self.repo.add_tool_hash(f"h{i}")
        hashes = self.repo.get_last_n_hashes(100)
        self.assertNotIn("h0", hashes, "Oldest hash should have been trimmed")
        self.assertNotIn("h1", hashes, "Second-oldest hash should have been trimmed")
        self.assertIn("h11", hashes, "Most recent hash should remain")


class TestTraceSupport(unittest.TestCase):

    def setUp(self):
        self.conn = _make_db()
        PipelineRepository = _import_repo()
        PipelineRepository.init_schema(self.conn)
        self.repo = PipelineRepository(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_get_trace_id_returns_none_when_no_trace(self):
        self.repo.insert_pipeline("scope1", "writer", 1)
        result = self.repo.get_trace_id("scope1")
        self.assertIsNone(result)

    def test_set_and_get_trace_id(self):
        self.repo.insert_pipeline("scope1", "writer", 1)
        self.repo.set_trace_id("scope1", "trace-abc-123")
        result = self.repo.get_trace_id("scope1")
        self.assertEqual(result, "trace-abc-123")


class TestTransact(unittest.TestCase):
    """AC2: transact helper — BEGIN IMMEDIATE, retry on SQLITE_BUSY, raise after 3 attempts."""

    def setUp(self):
        self.conn = _make_db()
        PipelineRepository = _import_repo()
        PipelineRepository.init_schema(self.conn)
        self.repo = PipelineRepository(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_transact_executes_fn_and_returns_value(self):
        PipelineRepository = _import_repo()
        result = PipelineRepository.transact(self.conn, lambda: 42)
        self.assertEqual(result, 42)

    def test_transact_commits_on_success(self):
        PipelineRepository = _import_repo()

        def do_insert():
            self.conn.execute(
                "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) "
                "VALUES ('tx-scope', 'writer', 'normal', 0, 1)"
            )

        PipelineRepository.transact(self.conn, do_insert)
        state = self.repo.get_pipeline_state("tx-scope")
        self.assertIsNotNone(state)

    def test_transact_rollback_on_exception(self):
        PipelineRepository = _import_repo()

        def bad_fn():
            self.conn.execute(
                "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) "
                "VALUES ('tx-scope', 'writer', 'normal', 0, 1)"
            )
            raise RuntimeError("intentional failure")

        with self.assertRaises(RuntimeError):
            PipelineRepository.transact(self.conn, bad_fn)

        # Row should not have been committed
        state = self.repo.get_pipeline_state("tx-scope")
        self.assertIsNone(state)

    def test_transact_raises_after_3_busy_retries(self):
        """AC2: After 3 SQLITE_BUSY retries, transact raises."""
        import unittest.mock as mock
        PipelineRepository = _import_repo()

        call_count = [0]
        original_execute = self.conn.execute

        def mock_execute(sql, *args, **kwargs):
            if "BEGIN IMMEDIATE" in sql:
                call_count[0] += 1
                raise sqlite3.OperationalError("database is locked")
            return original_execute(sql, *args, **kwargs)

        with mock.patch.object(self.conn, "execute", side_effect=mock_execute):
            with self.assertRaises(sqlite3.OperationalError):
                PipelineRepository.transact(self.conn, lambda: None)

        # Should have tried 3 times (not more, not fewer)
        self.assertGreaterEqual(call_count[0], 3)


if __name__ == "__main__":
    unittest.main()
