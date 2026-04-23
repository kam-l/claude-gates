import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch, MagicMock

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates import session


class TestOpenDatabase(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_returns_connection_with_row_factory(self):
        conn = session.open_database(self.tmp)
        try:
            self.assertEqual(conn.row_factory, sqlite3.Row)
        finally:
            conn.close()

    def test_wal_mode_set(self):
        conn = session.open_database(self.tmp)
        try:
            cursor = conn.execute("PRAGMA journal_mode")
            row = cursor.fetchone()
            self.assertEqual(row[0].upper(), "WAL")
        finally:
            conn.close()

    def test_busy_timeout_set(self):
        conn = session.open_database(self.tmp)
        try:
            cursor = conn.execute("PRAGMA busy_timeout")
            row = cursor.fetchone()
            self.assertEqual(int(row[0]), 5000)
        finally:
            conn.close()

    def test_isolation_level_none(self):
        conn = session.open_database(self.tmp)
        try:
            self.assertIsNone(conn.isolation_level)
        finally:
            conn.close()

    def test_pragma_failure_propagates(self):
        mock_conn = MagicMock()
        mock_conn.isolation_level = None
        mock_conn.execute.side_effect = sqlite3.OperationalError("PRAGMA failed")

        with patch("sqlite3.connect", return_value=mock_conn):
            with self.assertRaises(sqlite3.OperationalError):
                session.open_database(self.tmp)

    def test_database_file_created_in_session_dir(self):
        conn = session.open_database(self.tmp)
        try:
            expected_db = os.path.join(self.tmp, "session.db")
            self.assertTrue(os.path.exists(expected_db))
        finally:
            conn.close()


class TestGetSessionDir(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig_cwd = os.getcwd()
        os.chdir(self.tmp)

    def tearDown(self):
        os.chdir(self._orig_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_returns_first_8_hex_chars(self):
        session_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        result = session.get_session_dir(session_id)
        self.assertIn("a1b2c3d4", result)

    def test_directory_created_if_not_exists(self):
        session_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        result = session.get_session_dir(session_id)
        self.assertTrue(os.path.isdir(result.replace("/", os.sep)))

    def test_returns_forward_slashes(self):
        session_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        result = session.get_session_dir(session_id)
        self.assertNotIn("\\", result)

    def test_path_under_cwd_sessions(self):
        session_id = "ffffffff-0000-1111-2222-333333333333"
        result = session.get_session_dir(session_id)
        cwd_fwd = os.getcwd().replace("\\", "/")
        self.assertTrue(result.startswith(cwd_fwd + "/.sessions/ffffffff"))

    def test_called_twice_does_not_raise(self):
        session_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        session.get_session_dir(session_id)
        try:
            session.get_session_dir(session_id)
        except Exception as e:
            self.fail(f"get_session_dir raised on existing dir: {e}")


class TestGateDisabledMarker(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig_cwd = os.getcwd()
        os.chdir(self.tmp)

    def tearDown(self):
        os.chdir(self._orig_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_is_gate_disabled_false_when_no_marker(self):
        self.assertFalse(session.is_gate_disabled())

    def test_set_gate_disabled_true_creates_marker(self):
        session.set_gate_disabled(True)
        marker = session.gate_disabled_marker()
        self.assertTrue(os.path.exists(marker.replace("/", os.sep)))

    def test_is_gate_disabled_true_after_set(self):
        session.set_gate_disabled(True)
        self.assertTrue(session.is_gate_disabled())

    def test_set_gate_disabled_false_removes_marker(self):
        session.set_gate_disabled(True)
        self.assertTrue(session.is_gate_disabled())
        session.set_gate_disabled(False)
        self.assertFalse(session.is_gate_disabled())

    def test_set_gate_disabled_false_noop_when_absent(self):
        try:
            session.set_gate_disabled(False)
        except Exception as e:
            self.fail(f"set_gate_disabled(False) raised when marker absent: {e}")
        self.assertFalse(session.is_gate_disabled())

    def test_marker_path_at_project_level(self):
        marker = session.gate_disabled_marker()
        cwd_fwd = os.getcwd().replace("\\", "/")
        self.assertEqual(marker, cwd_fwd + "/.sessions/.gate-disabled")

    def test_marker_path_uses_forward_slashes(self):
        marker = session.gate_disabled_marker()
        self.assertNotIn("\\", marker)


class TestAgentRunningMarker(unittest.TestCase):

    def test_returns_expected_path(self):
        result = session.agent_running_marker("/tmp/sess/abc12345", "pipeline")
        self.assertEqual(result, "/tmp/sess/abc12345/.running-pipeline")

    def test_returns_forward_slashes(self):
        result = session.agent_running_marker("C:\\sessions\\abc12345", "pipeline")
        self.assertNotIn("\\", result)


class TestCleanup(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig_cwd = os.getcwd()
        os.chdir(self.tmp)

    def tearDown(self):
        os.chdir(self._orig_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_session_dir(self, sessions_base, name, age_days):
        d = os.path.join(sessions_base, name)
        os.makedirs(d, exist_ok=True)
        db_path = os.path.join(d, "session.db")
        with open(db_path, "w") as f:
            f.write("")
        past_time = time.time() - age_days * 86400
        os.utime(db_path, (past_time, past_time))
        os.utime(d, (past_time, past_time))
        return d

    def test_removes_old_session_dirs(self):
        sessions_dir = os.path.join(self.tmp, ".sessions")
        os.makedirs(sessions_dir, exist_ok=True)
        old_dir = self._make_session_dir(sessions_dir, "oldabc12", age_days=10)
        self.assertTrue(os.path.exists(old_dir))
        session.cleanup({})
        self.assertFalse(os.path.exists(old_dir))

    def test_keeps_recent_session_dirs(self):
        sessions_dir = os.path.join(self.tmp, ".sessions")
        os.makedirs(sessions_dir, exist_ok=True)
        recent_dir = self._make_session_dir(sessions_dir, "recentab", age_days=1)
        self.assertTrue(os.path.exists(recent_dir))
        session.cleanup({})
        self.assertTrue(os.path.exists(recent_dir))

    def test_missing_sessions_dir_no_error(self):
        try:
            session.cleanup({})
        except Exception as e:
            self.fail(f"cleanup() raised on missing .sessions/: {e}")

    def test_best_effort_continues_on_individual_error(self):
        sessions_dir = os.path.join(self.tmp, ".sessions")
        os.makedirs(sessions_dir, exist_ok=True)

        old_dir1 = self._make_session_dir(sessions_dir, "old11111", age_days=10)
        old_dir2 = self._make_session_dir(sessions_dir, "old22222", age_days=10)

        original_rmtree = shutil.rmtree
        call_count = [0]

        def failing_rmtree(path, **kwargs):
            call_count[0] += 1
            if "old11111" in path:
                raise OSError("permission denied")
            original_rmtree(path, **kwargs)

        with patch("shutil.rmtree", side_effect=failing_rmtree):
            try:
                session.cleanup({})
            except Exception as e:
                self.fail(f"cleanup() raised despite best-effort: {e}")

        self.assertFalse(os.path.exists(old_dir2))

    def test_skips_dirs_without_session_db(self):
        sessions_dir = os.path.join(self.tmp, ".sessions")
        os.makedirs(sessions_dir, exist_ok=True)
        no_db_dir = os.path.join(sessions_dir, "nodbdir1")
        os.makedirs(no_db_dir, exist_ok=True)
        past_time = time.time() - 10 * 86400
        os.utime(no_db_dir, (past_time, past_time))
        session.cleanup({})
        self.assertTrue(os.path.exists(no_db_dir))

    def test_scans_both_cwd_sessions_and_legacy(self):
        sessions_dir = os.path.join(self.tmp, ".sessions")
        os.makedirs(sessions_dir, exist_ok=True)
        old_cwd = self._make_session_dir(sessions_dir, "cwd11111", age_days=10)

        fake_home = tempfile.mkdtemp()
        legacy_sessions = os.path.join(fake_home, ".claude", "sessions")
        os.makedirs(legacy_sessions, exist_ok=True)
        old_legacy = self._make_session_dir(legacy_sessions, "leg11111", age_days=10)

        home_env = {"USERPROFILE": fake_home, "HOME": fake_home}

        try:
            with patch.dict(os.environ, home_env):
                session.cleanup({})
            self.assertFalse(os.path.exists(old_cwd), "CWD old dir should be removed")
            self.assertFalse(os.path.exists(old_legacy), "Legacy old dir should be removed")
        finally:
            shutil.rmtree(fake_home, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
