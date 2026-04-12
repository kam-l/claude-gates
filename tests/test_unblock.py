"""Tests for scripts/unblock.py — CLI utility that force-completes stuck pipelines.

Acceptance Criteria:
1. Auto-detect most recent session (find_session_dir)
2. Explicit session-id argument resolution
3. Nuclear delete within transaction
4. Marker and notification cleanup
5. Audit trail via Tracing
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates.session import open_database
from src.claude_gates.repository import PipelineRepository
from src.claude_gates.messaging import NOTIFICATION_FILE


def _setup_sessions_dir(root: str) -> str:
    """Create a .sessions/ directory under root and return its path."""
    sessions_dir = os.path.join(root, ".sessions")
    os.makedirs(sessions_dir, exist_ok=True)
    return sessions_dir


def _make_session(sessions_dir: str, short_id: str) -> str:
    """Create a session directory with a session.db and return its path."""
    session_dir = os.path.join(sessions_dir, short_id)
    os.makedirs(session_dir, exist_ok=True)
    conn = open_database(session_dir)
    PipelineRepository.init_schema(conn)
    conn.close()
    return session_dir


def _insert_stuck_pipeline(session_dir: str, scope: str, status: str = "normal") -> None:
    """Insert a stuck pipeline with one active step."""
    conn = open_database(session_dir)
    conn.execute(
        "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) "
        "VALUES (?, 'test-agent', ?, 0, 1)",
        (scope, status),
    )
    conn.execute(
        "INSERT INTO pipeline_steps (scope, step_index, step_type, status, round, source_agent) "
        "VALUES (?, 0, 'check', 'active', 0, 'test-agent')",
        (scope,),
    )
    conn.execute(
        "INSERT INTO agents (scope, agent, attempts) VALUES (?, 'reviewer', 0)",
        (scope,),
    )
    conn.commit()
    conn.close()


def _import_unblock():
    """Import unblock module from scripts/ directory."""
    import importlib.util
    unblock_path = os.path.join(_PROJECT_ROOT, "scripts", "unblock.py")
    spec = importlib.util.spec_from_file_location("unblock", unblock_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ─────────────────────────────────────────────────────────────────────────────
# AC1: Auto-detect most recent session
# ─────────────────────────────────────────────────────────────────────────────

class TestFindSessionDirAutoDetect(unittest.TestCase):
    """AC1: find_session_dir() scans .sessions/ for most recently modified session.db."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.sessions_dir = _setup_sessions_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def _find(self, args=None):
        unblock = _import_unblock()
        with patch("os.getcwd", return_value=self.tmp), \
             patch("sys.argv", ["unblock.py"] + (args or [])):
            return unblock.find_session_dir()

    def test_no_sessions_dir_returns_none(self):
        """AC1: Returns None when .sessions/ directory does not exist."""
        shutil.rmtree(self.sessions_dir)
        result = self._find()
        self.assertIsNone(result)

    def test_empty_sessions_dir_returns_none(self):
        """AC1: Returns None when .sessions/ is empty (no session.db files)."""
        result = self._find()
        self.assertIsNone(result)

    def test_single_session_returns_it(self):
        """AC1: Returns the single session dir when only one exists."""
        session_dir = _make_session(self.sessions_dir, "aabbccdd")
        result = self._find()
        self.assertIsNotNone(result)
        self.assertIn("aabbccdd", result)

    def test_returns_most_recently_modified(self):
        """AC1: Returns the session dir with the most recently modified session.db."""
        old_dir = _make_session(self.sessions_dir, "11111111")
        # Backdate the old session
        old_db = os.path.join(old_dir, "session.db")
        old_time = 1000000.0
        os.utime(old_db, (old_time, old_time))

        new_dir = _make_session(self.sessions_dir, "22222222")
        # Keep new session with current mtime

        result = self._find()
        self.assertIsNotNone(result)
        self.assertIn("22222222", result)

    def test_ignores_dirs_without_session_db(self):
        """AC1: Skips directories that do not contain session.db."""
        # Create a dir without session.db
        empty_dir = os.path.join(self.sessions_dir, "empty123")
        os.makedirs(empty_dir)
        result = self._find()
        self.assertIsNone(result)

    def test_returns_none_when_only_non_session_dirs(self):
        """AC1: Returns None when no directory has session.db."""
        no_db_dir = os.path.join(self.sessions_dir, "abc00000")
        os.makedirs(no_db_dir)
        result = self._find()
        self.assertIsNone(result)


# ─────────────────────────────────────────────────────────────────────────────
# AC2: Explicit session-id argument
# ─────────────────────────────────────────────────────────────────────────────

class TestFindSessionDirExplicit(unittest.TestCase):
    """AC2: Resolves session dir via get_session_dir() then falls back to raw path."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.sessions_dir = _setup_sessions_dir(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def _find(self, args):
        unblock = _import_unblock()
        with patch("os.getcwd", return_value=self.tmp), \
             patch("sys.argv", ["unblock.py"] + args):
            return unblock.find_session_dir()

    def test_explicit_short_id_resolves(self):
        """AC2: Finds session via raw path when short_id given as arg."""
        session_dir = _make_session(self.sessions_dir, "abcdef12")
        result = self._find(["abcdef12"])
        self.assertIsNotNone(result)
        self.assertIn("abcdef12", result)

    def test_explicit_session_id_with_short_id_path(self):
        """AC2: Short-id path construction (strip dashes, first 8 chars) resolves correctly."""
        session_dir = _make_session(self.sessions_dir, "deadbeef")
        # arg "deadbeef" -> short_id "deadbeef" -> .sessions/deadbeef/
        result = self._find(["deadbeef"])
        self.assertIsNotNone(result)

    def test_explicit_invalid_id_returns_none(self):
        """AC2: Returns None when explicit session-id has no session.db."""
        result = self._find(["nonexistent"])
        self.assertIsNone(result)

    def test_explicit_id_no_session_db_prints_error(self):
        """AC2: Prints error message to stderr when session.db not found."""
        # Create dir but no DB
        no_db = os.path.join(self.sessions_dir, "nodb1234")
        os.makedirs(no_db)
        mock_stderr = io.StringIO()
        with patch("sys.stderr", mock_stderr):
            result = self._find(["nodb1234"])
        self.assertIsNone(result)
        self.assertIn('No session.db found', mock_stderr.getvalue())

    def test_invalid_id_does_not_create_orphaned_dir(self):
        """CRITICAL fix: failed lookup must not create spurious dirs in .sessions/."""
        entries_before = set(os.listdir(self.sessions_dir))
        with patch("os.getcwd", return_value=self.tmp), \
             patch("sys.argv", ["unblock.py", "badid999"]):
            unblock = _import_unblock()
            result = unblock.find_session_dir()
        entries_after = set(os.listdir(self.sessions_dir))
        self.assertIsNone(result)
        self.assertEqual(entries_before, entries_after,
                         "No new dirs should be created for an invalid session ID")


# ─────────────────────────────────────────────────────────────────────────────
# AC3: Nuclear delete within transaction
# ─────────────────────────────────────────────────────────────────────────────

class TestNukeFunction(unittest.TestCase):
    """AC3: nuke() deletes pipeline_steps, pipeline_state, agents (and gates) in a transaction."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.sessions_dir = _setup_sessions_dir(self.tmp)
        self.session_dir = _make_session(self.sessions_dir, "deadbeef")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def _nuke(self, scope=None):
        unblock = _import_unblock()
        conn = open_database(self.session_dir)
        PipelineRepository.init_schema(conn)
        args = ["unblock.py"]
        if scope:
            args += ["deadbeef", scope]
        with patch("os.getcwd", return_value=self.tmp), \
             patch("sys.argv", args):
            unblock.nuke(conn, scope)
        return conn

    def test_deletes_pipeline_state(self):
        """AC3: DELETE FROM pipeline_state for stuck scopes."""
        _insert_stuck_pipeline(self.session_dir, "scope1")
        conn = self._nuke()
        rows = conn.execute("SELECT * FROM pipeline_state WHERE scope = 'scope1'").fetchall()
        conn.close()
        self.assertEqual(len(rows), 0)

    def test_deletes_pipeline_steps(self):
        """AC3: DELETE FROM pipeline_steps for stuck scopes."""
        _insert_stuck_pipeline(self.session_dir, "scope1")
        conn = self._nuke()
        rows = conn.execute("SELECT * FROM pipeline_steps WHERE scope = 'scope1'").fetchall()
        conn.close()
        self.assertEqual(len(rows), 0)

    def test_deletes_agents(self):
        """AC3: DELETE FROM agents for stuck scopes."""
        _insert_stuck_pipeline(self.session_dir, "scope1")
        conn = self._nuke()
        rows = conn.execute("SELECT * FROM agents WHERE scope = 'scope1'").fetchall()
        conn.close()
        self.assertEqual(len(rows), 0)

    def test_scope_filter_only_nukes_matching_scope(self):
        """AC3: When scope specified, only nuke that scope."""
        _insert_stuck_pipeline(self.session_dir, "scope1")
        _insert_stuck_pipeline(self.session_dir, "scope2")
        conn = self._nuke(scope="scope1")
        rows1 = conn.execute("SELECT * FROM pipeline_state WHERE scope = 'scope1'").fetchall()
        rows2 = conn.execute("SELECT * FROM pipeline_state WHERE scope = 'scope2'").fetchall()
        conn.close()
        self.assertEqual(len(rows1), 0)
        self.assertEqual(len(rows2), 1)

    def test_no_stuck_returns_empty_list(self):
        """AC3: Returns empty list when no stuck pipelines found."""
        unblock = _import_unblock()
        conn = open_database(self.session_dir)
        PipelineRepository.init_schema(conn)
        with patch("os.getcwd", return_value=self.tmp), \
             patch("sys.argv", ["unblock.py"]):
            result = unblock.nuke(conn, None)
        conn.close()
        self.assertEqual(result, [])

    def test_nuke_attempts_delete_from_gates(self):
        """AC3: Also attempts DELETE FROM gates — succeeds or fails silently."""
        _insert_stuck_pipeline(self.session_dir, "scope1")
        # Create a gates table to test deletion
        conn_setup = open_database(self.session_dir)
        conn_setup.execute(
            "CREATE TABLE IF NOT EXISTS gates "
            "(id INTEGER PRIMARY KEY, status TEXT, scope TEXT)"
        )
        conn_setup.execute(
            "INSERT INTO gates (status, scope) VALUES ('active', 'scope1')"
        )
        conn_setup.commit()
        conn_setup.close()

        conn = self._nuke()
        rows = conn.execute("SELECT * FROM gates WHERE status IN ('active','revise','fix')").fetchall()
        conn.close()
        self.assertEqual(len(rows), 0)

    def test_nuke_ignores_completed_pipelines(self):
        """AC3: Does not delete pipelines with status not in (normal, revision)."""
        conn_setup = open_database(self.session_dir)
        conn_setup.execute(
            "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) "
            "VALUES ('done_scope', 'agent', 'completed', 0, 1)"
        )
        conn_setup.commit()
        conn_setup.close()

        conn = self._nuke()
        rows = conn.execute("SELECT * FROM pipeline_state WHERE scope = 'done_scope'").fetchall()
        conn.close()
        self.assertEqual(len(rows), 1)

    def test_revision_status_pipeline_is_nuked(self):
        """AC3: Pipelines with status='revision' are also nuked."""
        _insert_stuck_pipeline(self.session_dir, "rev_scope", status="revision")
        conn = self._nuke()
        rows = conn.execute("SELECT * FROM pipeline_state WHERE scope = 'rev_scope'").fetchall()
        conn.close()
        self.assertEqual(len(rows), 0)

    def test_orphaned_steps_are_deleted(self):
        """IMPORTANT-2 fix: stuck_steps with no matching pipeline_state are still deleted."""
        # Insert a step with no corresponding pipeline_state row
        conn_setup = open_database(self.session_dir)
        conn_setup.execute(
            "INSERT INTO pipeline_steps "
            "(scope, step_index, step_type, status, round, source_agent) "
            "VALUES ('orphan_scope', 0, 'check', 'active', 0, 'agent')"
        )
        conn_setup.commit()
        conn_setup.close()

        conn = self._nuke()
        rows = conn.execute(
            "SELECT * FROM pipeline_steps WHERE scope = 'orphan_scope'"
        ).fetchall()
        conn.close()
        self.assertEqual(len(rows), 0,
                         "Orphaned active steps must be deleted even without pipeline_state row")


# ─────────────────────────────────────────────────────────────────────────────
# AC4: Marker and notification cleanup
# ─────────────────────────────────────────────────────────────────────────────

class TestClearMarkers(unittest.TestCase):
    """AC4: Deletes .running-*, .pending-scope-* markers and .pipeline-notifications."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.sessions_dir = _setup_sessions_dir(self.tmp)
        self.session_dir = _make_session(self.sessions_dir, "deadbeef")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def _clear(self, scope=None):
        unblock = _import_unblock()
        with patch("os.getcwd", return_value=self.tmp), \
             patch("sys.argv", ["unblock.py"]):
            return unblock.clear_markers(self.session_dir, scope)

    def _make_file(self, name: str) -> str:
        path = os.path.join(self.session_dir, name)
        with open(path, "w") as f:
            f.write("")
        return path

    def test_removes_running_markers(self):
        """AC4: Deletes .running-* files."""
        marker = self._make_file(".running-scope1")
        self._clear()
        self.assertFalse(os.path.exists(marker))

    def test_removes_pending_scope_markers(self):
        """AC4: Deletes .pending-scope-* files."""
        marker = self._make_file(".pending-scope-abc")
        self._clear()
        self.assertFalse(os.path.exists(marker))

    def test_removes_pipeline_notifications(self):
        """AC4: Deletes .pipeline-notifications file."""
        notif = self._make_file(NOTIFICATION_FILE)
        self._clear()
        self.assertFalse(os.path.exists(notif))

    def test_preserves_unrelated_files(self):
        """AC4: Does not delete files that don't match the marker pattern."""
        other = self._make_file("session.db")
        self._clear()
        self.assertTrue(os.path.exists(other))

    def test_returns_list_of_cleaned_files(self):
        """AC4: Returns list of cleaned filenames (not just count)."""
        self._make_file(".running-scope1")
        self._make_file(".pending-scope-xyz")
        result = self._clear()
        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 2)
        self.assertIn(".running-scope1", result)
        self.assertIn(".pending-scope-xyz", result)

    def test_scope_filter_removes_only_matching_running_marker(self):
        """AC4: When scope given, removes only .running-{scope} marker."""
        marker1 = self._make_file(".running-scope1")
        marker2 = self._make_file(".running-scope2")
        self._clear(scope="scope1")
        self.assertFalse(os.path.exists(marker1))
        self.assertTrue(os.path.exists(marker2))

    def test_no_markers_returns_empty_list(self):
        """AC4: Returns empty list when no markers present."""
        result = self._clear()
        self.assertEqual(result, [])

    def test_scope_filter_removes_matching_pending_marker(self):
        """AC4: When scope given, also removes .pending-scope-{scope}."""
        marker = self._make_file(".pending-scope-scope1")
        self._clear(scope="scope1")
        self.assertFalse(os.path.exists(marker))


# ─────────────────────────────────────────────────────────────────────────────
# AC5: Audit trail via Tracing
# ─────────────────────────────────────────────────────────────────────────────

class TestAuditTrail(unittest.TestCase):
    """AC5: Calls tracing.trace(session_dir, 'unblock', scope, {...}) for each nuked pipeline."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.sessions_dir = _setup_sessions_dir(self.tmp)
        self.session_dir = _make_session(self.sessions_dir, "deadbeef")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_audit_written_for_nuked_pipeline(self):
        """AC5: audit.jsonl entry written for each nuked pipeline."""
        _insert_stuck_pipeline(self.session_dir, "scope1")
        unblock = _import_unblock()
        conn = open_database(self.session_dir)
        PipelineRepository.init_schema(conn)

        with patch("os.getcwd", return_value=self.tmp), \
             patch("sys.argv", ["unblock.py", "deadbeef"]):
            nuked = unblock.nuke(conn, None)
            unblock.clear_markers(self.session_dir, None)
            for p in nuked:
                unblock.audit(self.session_dir, p, [])
        conn.close()

        audit_path = os.path.join(self.session_dir, "audit.jsonl")
        self.assertTrue(os.path.exists(audit_path))
        with open(audit_path) as f:
            lines = [json.loads(l) for l in f if l.strip()]
        self.assertTrue(len(lines) >= 1)
        entry = lines[0]
        self.assertEqual(entry["op"], "unblock")
        self.assertEqual(entry["scope"], "scope1")

    def test_audit_includes_status_step_markers(self):
        """AC5: audit entry includes status, step, markers fields with actual cleaned names."""
        _insert_stuck_pipeline(self.session_dir, "scope1")
        # Place a marker file so clear_markers returns a non-empty list
        marker_path = os.path.join(self.session_dir, ".running-scope1")
        with open(marker_path, "w") as f:
            f.write("")
        unblock = _import_unblock()
        conn = open_database(self.session_dir)
        PipelineRepository.init_schema(conn)

        with patch("os.getcwd", return_value=self.tmp), \
             patch("sys.argv", ["unblock.py", "deadbeef"]):
            nuked = unblock.nuke(conn, None)
            cleaned = unblock.clear_markers(self.session_dir, None)
            for p in nuked:
                unblock.audit(self.session_dir, p, cleaned)
        conn.close()

        audit_path = os.path.join(self.session_dir, "audit.jsonl")
        with open(audit_path) as f:
            entry = json.loads(f.readline())
        self.assertIn("status", entry)
        self.assertIn("step", entry)
        self.assertIn("markers", entry)
        # Verify actual filenames are recorded, not hardcoded []
        self.assertIn(".running-scope1", entry["markers"])


# ─────────────────────────────────────────────────────────────────────────────
# Edge Cases
# ─────────────────────────────────────────────────────────────────────────────

class TestEdgeCases(unittest.TestCase):
    """Edge cases: no sessions dir, nothing stuck, scope filter."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_no_sessions_dir_find_returns_none(self):
        """Edge: find_session_dir returns None when .sessions/ doesn't exist."""
        unblock = _import_unblock()
        with patch("os.getcwd", return_value=self.tmp), \
             patch("sys.argv", ["unblock.py"]):
            result = unblock.find_session_dir()
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
