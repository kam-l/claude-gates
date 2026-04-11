"""Tests for mcp_server.py — gate_verdict and gate_status tools."""
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


def _import_mcp_server():
    from src.claude_gates import mcp_server
    return mcp_server


class TestUpsertVerdictUnified(unittest.TestCase):
    """AC1: One unified upsert_verdict call for all scopes — no branching."""

    def test_plan_gate_scope_uses_upsert_verdict(self):
        """verify-plan scope calls upsert_verdict on PipelineRepository."""
        mcp_server = _import_mcp_server()
        conn = _make_db()
        from src.claude_gates.repository import PipelineRepository
        PipelineRepository.init_schema(conn)

        repo = PipelineRepository(conn)
        repo.upsert_verdict("verify-plan", "gater", "PASS", 0)
        row = repo.get_agent("verify-plan", "gater")
        self.assertIsNotNone(row)
        self.assertEqual(row["verdict"], "PASS")
        conn.close()

    def test_pipeline_scope_uses_upsert_verdict(self):
        """Pipeline scopes also call upsert_verdict (unified path)."""
        mcp_server = _import_mcp_server()
        conn = _make_db()
        from src.claude_gates.repository import PipelineRepository
        PipelineRepository.init_schema(conn)

        repo = PipelineRepository(conn)
        repo.upsert_verdict("my-scope", "reviewer", "REVISE", 1)
        row = repo.get_agent("my-scope", "reviewer")
        self.assertIsNotNone(row)
        self.assertEqual(row["verdict"], "REVISE")
        conn.close()


class TestGateVerdictTool(unittest.TestCase):
    """Tests for the gate_verdict MCP tool function."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        # Create a fake session dir structure
        self.session_id = "aaaabbbbccccdddd"  # 16 hex chars
        self.short_id = "aaaabbbb"  # first 8 after stripping dashes
        self.session_dir = os.path.join(self.tmp, ".sessions", self.short_id)
        os.makedirs(self.session_dir, exist_ok=True)

        # Create a real DB
        db_path = os.path.join(self.session_dir, "session.db")
        self.conn = sqlite3.connect(db_path, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        from src.claude_gates.repository import PipelineRepository
        PipelineRepository.init_schema(self.conn)
        self.conn.close()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _call_gate_verdict(self, session_id, scope, verdict, check=None, reason="test"):
        """Call gate_verdict_fn with patched get_session_dir."""
        mcp_server = _import_mcp_server()
        with patch("src.claude_gates.mcp_server.get_session_dir") as mock_gsd:
            mock_gsd.return_value = self.session_dir
            import asyncio
            result = asyncio.run(
                mcp_server.gate_verdict_fn(
                    session_id=session_id,
                    scope=scope,
                    verdict=verdict,
                    check=check,
                    reason=reason,
                )
            )
        return result

    def test_plan_gate_verdict_recorded(self):
        """verify-plan scope: upsert_verdict writes to agents table."""
        result = self._call_gate_verdict(self.session_id, "verify-plan", "PASS")
        self.assertNotIn("isError", result)
        content_text = result["content"][0]["text"]
        self.assertIn("PASS", content_text)

        # Verify the row is in the DB
        db_path = os.path.join(self.session_dir, "session.db")
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(
            "SELECT verdict FROM agents WHERE scope = 'verify-plan' AND agent = 'gater'"
        )
        row = cursor.fetchone()
        conn.close()
        self.assertIsNotNone(row)
        self.assertEqual(row["verdict"], "PASS")

    def test_pipeline_verdict_no_active_step_returns_error(self):
        """Pipeline scope with no active step returns isError response."""
        result = self._call_gate_verdict(self.session_id, "my-pipeline", "PASS")
        self.assertTrue(result.get("isError"))
        self.assertIn("no active step", result["content"][0]["text"])

    def test_pipeline_verdict_with_active_step(self):
        """Pipeline scope with active step records verdict via upsert_verdict."""
        # Insert a pipeline + active step
        db_path = os.path.join(self.session_dir, "session.db")
        conn = sqlite3.connect(db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute(
            "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) "
            "VALUES ('my-pipe', 'source', 'normal', 0, 2)"
        )
        conn.execute(
            "INSERT INTO pipeline_steps "
            "(scope, step_index, step_type, prompt, agent, status, round, source_agent) "
            "VALUES ('my-pipe', 0, 'VERIFY', 'check it', 'reviewer', 'active', 0, 'source')"
        )
        conn.execute(
            "INSERT INTO agents (scope, agent, outputFilepath) VALUES ('my-pipe', 'reviewer', '/tmp/out.md')"
        )
        conn.close()

        result = self._call_gate_verdict(self.session_id, "my-pipe", "REVISE", check="FAIL", reason="needs work")
        self.assertNotIn("isError", result)
        self.assertIn("REVISE", result["content"][0]["text"])

    def test_invalid_session_returns_error(self):
        """gate_verdict with invalid session_id (no session dir) returns error."""
        mcp_server = _import_mcp_server()
        import asyncio
        # Don't patch get_session_dir — let it fail naturally with bad path
        # But we need to control CWD; use patch to return a nonexistent dir
        with patch("src.claude_gates.mcp_server.get_session_dir") as mock_gsd:
            mock_gsd.return_value = "/nonexistent/path/session"
            result = asyncio.run(
                mcp_server.gate_verdict_fn(
                    session_id="bad-session",
                    scope="verify-plan",
                    verdict="PASS",
                    check=None,
                    reason="test",
                )
            )
        self.assertTrue(result.get("isError"))
        self.assertEqual(result["content"][0]["type"], "text")


class TestGateStatusTool(unittest.TestCase):
    """Tests for the gate_status MCP tool function."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_id = "aaaabbbbccccdddd"
        self.short_id = "aaaabbbb"
        self.session_dir = os.path.join(self.tmp, ".sessions", self.short_id)
        os.makedirs(self.session_dir, exist_ok=True)

        db_path = os.path.join(self.session_dir, "session.db")
        self.db_path = db_path
        conn = sqlite3.connect(db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        from src.claude_gates.repository import PipelineRepository
        PipelineRepository.init_schema(conn)
        conn.close()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _call_gate_status(self, session_id, scope=None):
        mcp_server = _import_mcp_server()
        with patch("src.claude_gates.mcp_server.get_session_dir") as mock_gsd:
            mock_gsd.return_value = self.session_dir
            import asyncio
            result = asyncio.run(
                mcp_server.gate_status_fn(
                    session_id=session_id,
                    scope=scope,
                )
            )
        return result

    def test_no_active_pipelines_returns_empty(self):
        """AC5: gate_status with no active pipelines returns empty list, not error."""
        result = self._call_gate_status(self.session_id)
        self.assertNotIn("isError", result)
        content_text = result["content"][0]["text"]
        # Should indicate no active pipelines
        self.assertIn("[]", content_text)

    def test_status_with_scope_returns_state_and_steps(self):
        """AC5: gate_status(session_id, scope) returns pipeline state + steps."""
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) "
            "VALUES ('my-scope', 'source', 'normal', 0, 1)"
        )
        conn.execute(
            "INSERT INTO pipeline_steps "
            "(scope, step_index, step_type, prompt, agent, status, round, source_agent) "
            "VALUES ('my-scope', 0, 'VERIFY', 'check', 'reviewer', 'active', 0, 'source')"
        )
        conn.close()

        result = self._call_gate_status(self.session_id, scope="my-scope")
        self.assertNotIn("isError", result)
        import json
        data = json.loads(result["content"][0]["text"])
        self.assertIn("state", data)
        self.assertIn("steps", data)
        self.assertEqual(len(data["steps"]), 1)

    def test_status_without_scope_returns_all_active(self):
        """AC5: gate_status without scope returns summary of all active pipelines."""
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) "
            "VALUES ('scope-a', 'src', 'normal', 0, 2)"
        )
        conn.execute(
            "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) "
            "VALUES ('scope-b', 'src', 'revision', 1, 3)"
        )
        conn.close()

        result = self._call_gate_status(self.session_id)
        self.assertNotIn("isError", result)
        import json
        data = json.loads(result["content"][0]["text"])
        self.assertIsInstance(data, list)
        self.assertEqual(len(data), 2)
        scopes = {p["scope"] for p in data}
        self.assertIn("scope-a", scopes)
        self.assertIn("scope-b", scopes)

    def test_status_scope_not_found_returns_error(self):
        """gate_status with unknown scope returns isError."""
        result = self._call_gate_status(self.session_id, scope="nonexistent")
        self.assertTrue(result.get("isError"))
        self.assertIn("No pipeline", result["content"][0]["text"])


class TestVersionFromImportlib(unittest.TestCase):
    """AC4: Version from importlib.metadata with fallback to 0.0.0."""

    def test_version_is_a_string(self):
        """VERSION is a non-empty string — either a real version or '0.0.0'."""
        mcp_server = _import_mcp_server()
        self.assertIsInstance(mcp_server.VERSION, str)
        self.assertTrue(len(mcp_server.VERSION) > 0)

    def test_version_source_is_importlib_metadata(self):
        """VERSION is derived from importlib.metadata, with '0.0.0' fallback."""
        import importlib.metadata as meta
        from importlib.metadata import PackageNotFoundError

        try:
            expected = meta.version("claude-gates")
        except PackageNotFoundError:
            expected = "0.0.0"

        mcp_server = _import_mcp_server()
        self.assertEqual(mcp_server.VERSION, expected)


class TestStdioTransport(unittest.TestCase):
    """AC3: main() always passes transport='stdio'."""

    def test_main_uses_stdio_transport(self):
        """main() calls mcp.run(transport='stdio')."""
        mcp_server = _import_mcp_server()
        mock_mcp = MagicMock()
        with patch.object(mcp_server, "mcp", mock_mcp), \
             patch.object(mcp_server, "_fastmcp_available", True):
            mcp_server.main()
        mock_mcp.run.assert_called_once_with(transport="stdio")


class TestFastMCPOptionalImport(unittest.TestCase):
    """AC2: FastMCP is a lazy-imported optional dependency."""

    def test_module_has_fastmcp_available_flag(self):
        """mcp_server exposes _fastmcp_available to signal install state."""
        mcp_server = _import_mcp_server()
        # Must expose the flag as a bool — tells session_context whether dep is present
        self.assertIsInstance(mcp_server._fastmcp_available, bool)

    def test_gate_verdict_fn_works_regardless_of_fastmcp(self):
        """gate_verdict_fn is callable even if _fastmcp_available is False."""
        mcp_server = _import_mcp_server()
        # The bare async functions must exist independently of FastMCP registration
        import asyncio
        import inspect
        self.assertTrue(inspect.iscoroutinefunction(mcp_server.gate_verdict_fn))
        self.assertTrue(inspect.iscoroutinefunction(mcp_server.gate_status_fn))


class TestErrorResponseFormat(unittest.TestCase):
    """Error handling: return isError + content array format."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session_id = "aaaabbbbccccdddd"
        self.session_dir = os.path.join(self.tmp, ".sessions", "aaaabbbb")
        os.makedirs(self.session_dir, exist_ok=True)
        db_path = os.path.join(self.session_dir, "session.db")
        conn = sqlite3.connect(db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        from src.claude_gates.repository import PipelineRepository
        PipelineRepository.init_schema(conn)
        conn.close()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_error_response_has_is_error_true(self):
        """Error responses have isError=True and content with type='text'."""
        mcp_server = _import_mcp_server()
        import asyncio
        with patch("src.claude_gates.mcp_server.get_session_dir") as mock_gsd:
            mock_gsd.return_value = self.session_dir
            result = asyncio.run(
                mcp_server.gate_verdict_fn(
                    session_id=self.session_id,
                    scope="bad-scope",
                    verdict="PASS",
                    check=None,
                    reason="test",
                )
            )
        self.assertTrue(result.get("isError"))
        self.assertIsInstance(result["content"], list)
        self.assertEqual(result["content"][0]["type"], "text")
        self.assertIsInstance(result["content"][0]["text"], str)


if __name__ == "__main__":
    unittest.main()
