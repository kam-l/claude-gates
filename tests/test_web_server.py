"""
Tests for web_server.py — Task 20 acceptance criteria.

AC1: IdleHTTPServer self-terminates after 10 minutes idle
AC2: Session discovery finds valid session directories
AC3: Readonly database access prevents writes
AC4: API routes return correct JSON
AC5: Session ID validation prevents path traversal
AC6: Embedded HTML dashboard served at root
"""

import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from io import BytesIO
from unittest.mock import MagicMock, patch

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_handler_get(path: str):
    from src.claude_gates.web_server import RequestHandler
    handler = RequestHandler.__new__(RequestHandler)
    handler.command = "GET"
    handler.path = path
    handler.headers = {}
    handler.wfile = BytesIO()
    handler._response_code = None
    handler._response_headers = {}
    # Track call order to detect send_header-before-send_response
    handler._call_order = []
    def _track_send_response(code, msg=None):
        handler._response_code = code
        handler._call_order.append(('send_response', code))
    def _track_send_header(k, v):
        handler._response_headers[k.lower()] = v
        handler._call_order.append(('send_header', k))
    handler.send_response = _track_send_response
    handler.send_header = _track_send_header
    handler.end_headers = lambda: None
    handler.log_message = lambda *args: None
    return handler


def _make_session_db(sessions_dir: str, session_id: str) -> str:
    """Create a minimal session.db under sessions_dir/session_id/."""
    session_dir = os.path.join(sessions_dir, session_id)
    os.makedirs(session_dir, exist_ok=True)
    db_path = os.path.join(session_dir, "session.db")
    conn = sqlite3.connect(db_path)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS pipeline_state (
               scope TEXT PRIMARY KEY,
               source_agent TEXT,
               status TEXT,
               current_step INTEGER,
               total_steps INTEGER,
               trace_id TEXT,
               created_at TEXT
           )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS pipeline_steps (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               scope TEXT,
               step_index INTEGER,
               step_type TEXT,
               prompt TEXT,
               agent TEXT,
               max_rounds INTEGER,
               fixer TEXT,
               status TEXT,
               round INTEGER,
               source_agent TEXT
           )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS agents (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               scope TEXT,
               agent TEXT,
               outputFilepath TEXT,
               verdict TEXT,
               \"check\" TEXT,
               round INTEGER,
               attempts INTEGER
           )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS edits (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               filepath TEXT,
               lines INTEGER
           )"""
    )
    conn.commit()
    conn.close()
    return db_path


def _insert_pipeline(db_path: str, scope: str, source_agent: str = "test-agent",
                     status: str = "active", current_step: int = 0, total_steps: int = 2):
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps, trace_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
        (scope, source_agent, status, current_step, total_steps, None)
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# AC1: IdleHTTPServer self-terminates after 10 minutes idle
# ---------------------------------------------------------------------------

class TestIdleHTTPServer(unittest.TestCase):
    """AC1: service_actions() initiates shutdown after 10-min idle."""

    def test_no_shutdown_within_idle_window(self):
        """service_actions does NOT shut down when last request is recent."""
        from src.claude_gates.web_server import IdleHTTPServer
        with patch.object(IdleHTTPServer, '__init__', return_value=None):
            server = IdleHTTPServer.__new__(IdleHTTPServer)
            server.last_request_time = time.time()  # recent
            server._shutdown_initiated = False

        with patch.object(server, 'shutdown') as mock_shutdown:
            server.service_actions()
            mock_shutdown.assert_not_called()

    def test_shutdown_after_idle_timeout(self):
        """service_actions initiates shutdown in a daemon thread after 10-min idle."""
        from src.claude_gates.web_server import IdleHTTPServer
        with patch.object(IdleHTTPServer, '__init__', return_value=None):
            server = IdleHTTPServer.__new__(IdleHTTPServer)
            server.last_request_time = time.time() - 601
            server._shutdown_initiated = False

        shutdown_called = threading.Event()

        def fake_shutdown():
            shutdown_called.set()

        with patch.object(server, 'shutdown', side_effect=fake_shutdown):
            server.service_actions()
            shutdown_called.wait(timeout=2.0)
            self.assertTrue(shutdown_called.is_set(), "shutdown() was not called after idle timeout")
            self.assertTrue(server._shutdown_initiated)

    def test_shutdown_not_repeated(self):
        """service_actions does not spawn a second shutdown thread if already initiated."""
        from src.claude_gates.web_server import IdleHTTPServer
        with patch.object(IdleHTTPServer, '__init__', return_value=None):
            server = IdleHTTPServer.__new__(IdleHTTPServer)
            server.last_request_time = time.time() - 700
            server._shutdown_initiated = True  # already triggered

        with patch.object(server, 'shutdown') as mock_shutdown:
            server.service_actions()
            mock_shutdown.assert_not_called()


# ---------------------------------------------------------------------------
# AC2: Session discovery finds valid session directories
# ---------------------------------------------------------------------------

class TestDiscoverSessions(unittest.TestCase):
    """AC2: discover_sessions() returns IDs matching ^[0-9a-f]{8}$ with session.db."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.sessions_dir = os.path.join(self.tmpdir, ".sessions")
        os.makedirs(self.sessions_dir)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_returns_valid_session_ids(self):
        """Valid 8-char hex dir with session.db is included."""
        _make_session_db(self.sessions_dir, "abcd1234")
        from src.claude_gates import web_server
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            result = web_server.discover_sessions()
        self.assertIn("abcd1234", result)

    def test_skips_directories_without_db(self):
        """Directory matching pattern but missing session.db is skipped."""
        os.makedirs(os.path.join(self.sessions_dir, "deadbeef"))
        from src.claude_gates import web_server
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            result = web_server.discover_sessions()
        self.assertNotIn("deadbeef", result)

    def test_skips_non_matching_names(self):
        """Non-matching names are skipped (too long, uppercase, etc.)."""
        _make_session_db(self.sessions_dir, "abcd12345")  # 9 chars — invalid
        _make_session_db(self.sessions_dir, "ABCD1234")   # uppercase — invalid
        _make_session_db(self.sessions_dir, "xyz")        # too short — invalid
        from src.claude_gates import web_server
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            result = web_server.discover_sessions()
        self.assertEqual(result, [])

    def test_no_sessions_dir_returns_empty(self):
        """Missing .sessions dir returns []."""
        missing = os.path.join(self.tmpdir, "no_sessions")
        from src.claude_gates import web_server
        with patch.object(web_server, 'SESSIONS_DIR', missing):
            result = web_server.discover_sessions()
        self.assertEqual(result, [])

    def test_multiple_valid_sessions(self):
        """Multiple valid sessions are all returned."""
        _make_session_db(self.sessions_dir, "aabbccdd")
        _make_session_db(self.sessions_dir, "11223344")
        from src.claude_gates import web_server
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            result = web_server.discover_sessions()
        self.assertIn("aabbccdd", result)
        self.assertIn("11223344", result)


# ---------------------------------------------------------------------------
# AC3: Readonly database access prevents writes
# ---------------------------------------------------------------------------

class TestOpenReadonly(unittest.TestCase):
    """AC3: open_readonly uses URI mode with readonly flag."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.sessions_dir = os.path.join(self.tmpdir, ".sessions")
        os.makedirs(self.sessions_dir)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_returns_none_for_missing_db(self):
        """Returns None if session.db does not exist."""
        from src.claude_gates import web_server
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            result = web_server.open_readonly("abcd1234")
        self.assertIsNone(result)

    def test_returns_connection_for_existing_db(self):
        """Returns a sqlite3 connection for an existing session.db."""
        _make_session_db(self.sessions_dir, "abcd1234")
        from src.claude_gates import web_server
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            conn = web_server.open_readonly("abcd1234")
        self.assertIsNotNone(conn)
        conn.close()

    def test_readonly_connection_rejects_writes(self):
        """Connection opened with readonly mode raises on INSERT."""
        _make_session_db(self.sessions_dir, "abcd1234")
        from src.claude_gates import web_server
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            conn = web_server.open_readonly("abcd1234")
        self.assertIsNotNone(conn)
        with self.assertRaises(Exception):
            conn.execute("INSERT INTO pipeline_state (scope) VALUES ('x')")
        conn.close()

    def test_uses_uri_mode_with_uri_true(self):
        """open_readonly calls sqlite3.connect with uri=True (not just mode=ro in string)."""
        _make_session_db(self.sessions_dir, "abcd1234")
        from src.claude_gates import web_server

        captured = {}
        original_connect = sqlite3.connect

        def capturing_connect(*args, **kwargs):
            captured['args'] = args
            captured['kwargs'] = kwargs
            return original_connect(*args, **kwargs)

        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            with patch('src.claude_gates.web_server.sqlite3') as mock_sqlite:
                mock_sqlite.connect.side_effect = capturing_connect
                mock_sqlite.Row = sqlite3.Row
                try:
                    web_server.open_readonly("abcd1234")
                except Exception:
                    pass
                self.assertTrue(mock_sqlite.connect.called, "sqlite3.connect was not called")
                _, kwargs = mock_sqlite.connect.call_args
                # Must explicitly pass uri=True — not just rely on mode=ro in the path string
                self.assertTrue(
                    kwargs.get('uri') is True,
                    "sqlite3.connect must be called with uri=True, got kwargs={}".format(kwargs)
                )


# ---------------------------------------------------------------------------
# CRITICAL-1: send_response order — CORS header must come after send_response
# ---------------------------------------------------------------------------

class TestHttpResponseOrdering(unittest.TestCase):
    """CRITICAL-1: send_response must be called before any send_header."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.sessions_dir = os.path.join(self.tmpdir, ".sessions")
        os.makedirs(self.sessions_dir)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def _assert_send_response_first(self, path: str):
        """Assert that send_response is called before any send_header for the given path."""
        from src.claude_gates import web_server
        handler = _make_handler_get(path)
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        # find first send_response and first send_header positions
        response_positions = [i for i, (op, _) in enumerate(handler._call_order) if op == 'send_response']
        header_positions = [i for i, (op, _) in enumerate(handler._call_order) if op == 'send_header']
        self.assertTrue(len(response_positions) > 0, "send_response was never called for {}".format(path))
        if header_positions:
            self.assertLess(
                response_positions[0], header_positions[0],
                "send_header called before send_response for {}. Call order: {}".format(
                    path, handler._call_order
                )
            )

    def test_health_send_response_before_headers(self):
        """GET /health: send_response called before any send_header."""
        self._assert_send_response_first("/health")

    def test_root_send_response_before_headers(self):
        """GET /: send_response called before any send_header."""
        self._assert_send_response_first("/")

    def test_api_sessions_send_response_before_headers(self):
        """GET /api/sessions: send_response called before any send_header."""
        self._assert_send_response_first("/api/sessions")

    def test_404_send_response_before_headers(self):
        """404 response: send_response called before any send_header."""
        self._assert_send_response_first("/no-such-route")

    def test_api_sessions_pipelines_send_response_before_headers(self):
        """GET /api/sessions/{id}/pipelines: send_response called before any send_header."""
        db_path = _make_session_db(self.sessions_dir, "abcd1234")
        _insert_pipeline(db_path, "s1")
        self._assert_send_response_first("/api/sessions/abcd1234/pipelines")

    def test_cors_header_present_in_all_responses(self):
        """CORS header is present in all API responses."""
        from src.claude_gates import web_server
        for path in ["/health", "/api/sessions", "/no-such-route"]:
            handler = _make_handler_get(path)
            with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
                handler.do_GET()
            self.assertIn(
                "access-control-allow-origin",
                handler._response_headers,
                "CORS header missing for {}".format(path)
            )


# ---------------------------------------------------------------------------
# CRITICAL-2: Windows backslash path traversal
# ---------------------------------------------------------------------------

class TestBackslashPathTraversal(unittest.TestCase):
    """CRITICAL-2: _valid_path_component must reject backslash characters."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.sessions_dir = os.path.join(self.tmpdir, ".sessions")
        os.makedirs(self.sessions_dir)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_valid_path_component_rejects_backslash(self):
        """_valid_path_component returns False for component containing backslash."""
        from src.claude_gates.web_server import RequestHandler
        handler = RequestHandler.__new__(RequestHandler)
        self.assertFalse(
            handler._valid_path_component("evil\\path"),
            "_valid_path_component must reject backslash"
        )

    def test_valid_path_component_rejects_backslash_dotdot(self):
        """_valid_path_component returns False for ..\\evil pattern."""
        from src.claude_gates.web_server import RequestHandler
        handler = RequestHandler.__new__(RequestHandler)
        self.assertFalse(
            handler._valid_path_component("..\\evil"),
            "_valid_path_component must reject ..\\\\evil"
        )

    def test_valid_path_component_rejects_forward_slash(self):
        """_valid_path_component returns False for component with forward slash."""
        from src.claude_gates.web_server import RequestHandler
        handler = RequestHandler.__new__(RequestHandler)
        self.assertFalse(handler._valid_path_component("a/b"))

    def test_valid_path_component_rejects_dotdot(self):
        """_valid_path_component returns False for .. component."""
        from src.claude_gates.web_server import RequestHandler
        handler = RequestHandler.__new__(RequestHandler)
        self.assertFalse(handler._valid_path_component(".."))

    def test_valid_path_component_accepts_normal_name(self):
        """_valid_path_component returns True for a normal filename."""
        from src.claude_gates.web_server import RequestHandler
        handler = RequestHandler.__new__(RequestHandler)
        self.assertTrue(handler._valid_path_component("my-scope"))
        self.assertTrue(handler._valid_path_component("artifact.md"))

    def test_filename_with_backslash_rejected_by_route(self):
        """Route rejects filename containing literal backslash with 404."""
        _make_session_db(self.sessions_dir, "abcd1234")
        scope_dir = os.path.join(self.sessions_dir, "abcd1234", "my-scope")
        os.makedirs(scope_dir)
        from src.claude_gates import web_server
        # URL with a literal backslash in the filename position
        handler = _make_handler_get("/api/sessions/abcd1234/scopes/my-scope/files/evil\\traversal.md")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404,
                         "Route must return 404 when filename contains a backslash")


# ---------------------------------------------------------------------------
# AC4: API routes return correct JSON
# ---------------------------------------------------------------------------

class TestRequestHandler(unittest.TestCase):
    """AC4: Routes return correct JSON/content."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.sessions_dir = os.path.join(self.tmpdir, ".sessions")
        os.makedirs(self.sessions_dir)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_health_route(self):
        """/health returns {"app": "claude-gates", "status": "ok"}."""
        from src.claude_gates import web_server

        handler = _make_handler_get("/health")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()

        body = handler.wfile.getvalue()
        data = json.loads(body.decode())
        self.assertEqual(data["app"], "claude-gates")
        self.assertEqual(data["status"], "ok")
        self.assertEqual(handler._response_code, 200)

    def test_api_sessions_empty(self):
        """/api/sessions returns [] when no sessions exist."""
        from src.claude_gates import web_server

        handler = _make_handler_get("/api/sessions")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()

        body = handler.wfile.getvalue()
        data = json.loads(body.decode())
        self.assertEqual(data, [])

    def test_api_sessions_with_data(self):
        """/api/sessions returns pipeline summaries (scope, source_agent, status, etc.)."""
        db_path = _make_session_db(self.sessions_dir, "abcd1234")
        _insert_pipeline(db_path, "my-scope", "source-agent", "active", 1, 3)

        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()

        body = handler.wfile.getvalue()
        data = json.loads(body.decode())
        self.assertEqual(len(data), 1)
        session = data[0]
        self.assertEqual(session["id"], "abcd1234")
        self.assertIn("pipelines", session)
        pipelines = session["pipelines"]
        self.assertEqual(len(pipelines), 1)
        p = pipelines[0]
        self.assertEqual(p["scope"], "my-scope")
        self.assertEqual(p["source_agent"], "source-agent")
        self.assertEqual(p["status"], "active")
        self.assertEqual(p["current_step"], 1)
        self.assertEqual(p["total_steps"], 3)

    def test_api_sessions_id_pipelines(self):
        """/api/sessions/{id}/pipelines returns full pipeline detail."""
        db_path = _make_session_db(self.sessions_dir, "abcd1234")
        _insert_pipeline(db_path, "scope1", "agent-x", "active", 0, 1)

        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions/abcd1234/pipelines")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()

        body = handler.wfile.getvalue()
        data = json.loads(body.decode())
        self.assertEqual(data["id"], "abcd1234")
        self.assertIn("pipelines", data)
        p = data["pipelines"][0]
        self.assertIn("steps", p)
        self.assertIn("agents", p)
        self.assertIn("files", p)

    def test_api_scopes_files_empty(self):
        """/api/sessions/{id}/scopes/{scope}/files returns [] when no .md files."""
        _make_session_db(self.sessions_dir, "abcd1234")

        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions/abcd1234/scopes/my-scope/files")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()

        body = handler.wfile.getvalue()
        data = json.loads(body.decode())
        self.assertEqual(data, [])

    def test_api_scopes_files_lists_md_files(self):
        """/api/sessions/{id}/scopes/{scope}/files returns list of .md files."""
        _make_session_db(self.sessions_dir, "abcd1234")
        scope_dir = os.path.join(self.sessions_dir, "abcd1234", "my-scope")
        os.makedirs(scope_dir)
        with open(os.path.join(scope_dir, "artifact.md"), "w") as f:
            f.write("content")
        with open(os.path.join(scope_dir, "other.txt"), "w") as f:
            f.write("ignored")

        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions/abcd1234/scopes/my-scope/files")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()

        body = handler.wfile.getvalue()
        data = json.loads(body.decode())
        self.assertIn("artifact.md", data)
        self.assertNotIn("other.txt", data)

    def test_api_scopes_files_filename_returns_content(self):
        """/api/sessions/{id}/scopes/{scope}/files/{filename} returns text/plain content."""
        _make_session_db(self.sessions_dir, "abcd1234")
        scope_dir = os.path.join(self.sessions_dir, "abcd1234", "my-scope")
        os.makedirs(scope_dir)
        with open(os.path.join(scope_dir, "artifact.md"), "w") as f:
            f.write("# Hello world")

        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions/abcd1234/scopes/my-scope/files/artifact.md")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()

        body = handler.wfile.getvalue()
        self.assertEqual(body.decode(), "# Hello world")
        ct = handler._response_headers.get("content-type", "")
        self.assertIn("text/plain", ct)

    def test_unknown_route_returns_404(self):
        """/api/unknown returns 404."""
        from src.claude_gates import web_server
        handler = _make_handler_get("/api/unknown")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)

    def test_not_found_includes_content_type(self):
        """404 response includes Content-Type header."""
        from src.claude_gates import web_server
        handler = _make_handler_get("/no-such-route")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)
        self.assertIn("content-type", handler._response_headers)

    def test_not_found_includes_cors_header(self):
        """404 response includes CORS header for browser cross-origin access."""
        from src.claude_gates import web_server
        handler = _make_handler_get("/no-such-route")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertIn("access-control-allow-origin", handler._response_headers)


# ---------------------------------------------------------------------------
# AC5: Session ID validation prevents path traversal
# ---------------------------------------------------------------------------

class TestSessionIdValidation(unittest.TestCase):
    """AC5: Invalid session IDs return 404; scope/filename must not contain .. or /."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.sessions_dir = os.path.join(self.tmpdir, ".sessions")
        os.makedirs(self.sessions_dir)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_invalid_session_id_too_long(self):
        """Session ID with 9 chars returns 404."""
        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions/abcd12345/pipelines")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)

    def test_invalid_session_id_uppercase(self):
        """Session ID with uppercase returns 404."""
        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions/ABCD1234/pipelines")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)

    def test_invalid_session_id_path_traversal(self):
        """Session ID with .. returns 404."""
        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions/../evil/pipelines")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)

    def test_scope_with_dotdot_rejected(self):
        """Scope parameter containing .. returns 404."""
        _make_session_db(self.sessions_dir, "abcd1234")
        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions/abcd1234/scopes/../evil/files")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)

    def test_filename_with_dotdot_rejected(self):
        """Filename containing .. returns 404."""
        _make_session_db(self.sessions_dir, "abcd1234")
        scope_dir = os.path.join(self.sessions_dir, "abcd1234", "my-scope")
        os.makedirs(scope_dir)
        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions/abcd1234/scopes/my-scope/files/../evil.md")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)

    def test_valid_session_id_accepted(self):
        """Valid 8-char hex session ID is accepted."""
        db_path = _make_session_db(self.sessions_dir, "abcd1234")
        _insert_pipeline(db_path, "s1")
        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions/abcd1234/pipelines")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 200)


# ---------------------------------------------------------------------------
# AC6: Embedded HTML dashboard served at root
# ---------------------------------------------------------------------------

class TestDashboardRoute(unittest.TestCase):
    """AC6: GET / returns embedded HTML, no external files."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.sessions_dir = os.path.join(self.tmpdir, ".sessions")
        os.makedirs(self.sessions_dir)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_root_returns_html(self):
        """GET / returns 200 with Content-Type text/html."""
        from src.claude_gates import web_server
        handler = _make_handler_get("/")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 200)
        ct = handler._response_headers.get("content-type", "")
        self.assertIn("text/html", ct)

    def test_root_response_is_html_string(self):
        """GET / response body contains <!DOCTYPE html> and ClaudeGates."""
        from src.claude_gates import web_server
        handler = _make_handler_get("/")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        body = handler.wfile.getvalue().decode("utf-8", errors="replace")
        self.assertIn("<!DOCTYPE html>", body)
        self.assertIn("ClaudeGates", body)

    def test_dashboard_has_polling_js(self):
        """Embedded HTML includes polling JS (setInterval or fetch)."""
        from src.claude_gates import web_server
        handler = _make_handler_get("/")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        body = handler.wfile.getvalue().decode("utf-8", errors="replace")
        self.assertTrue(
            "setInterval" in body or "fetch(" in body,
            "Dashboard should contain polling JS"
        )

    def test_dashboard_is_inline_no_external_files(self):
        """get_html() is an inline Python string, not read from a file."""
        from src.claude_gates import web_server
        self.assertTrue(hasattr(web_server, 'get_html'))
        html = web_server.get_html()
        self.assertIsInstance(html, str)
        self.assertGreater(len(html), 1000, "Dashboard HTML should be substantial (~300+ lines)")


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases(unittest.TestCase):
    """Edge cases from spec: no sessions, non-UTF-8 files, port env var."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.sessions_dir = os.path.join(self.tmpdir, ".sessions")
        os.makedirs(self.sessions_dir)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_no_sessions_returns_empty_list(self):
        """/api/sessions returns [] when no session directories exist."""
        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        body = handler.wfile.getvalue()
        self.assertEqual(json.loads(body.decode()), [])

    def test_non_utf8_artifact_handled_gracefully(self):
        """Artifact with non-UTF-8 bytes is served without crashing."""
        _make_session_db(self.sessions_dir, "abcd1234")
        scope_dir = os.path.join(self.sessions_dir, "abcd1234", "scope1")
        os.makedirs(scope_dir)
        with open(os.path.join(scope_dir, "bad.md"), "wb") as f:
            f.write(b"hello \xff\xfe world")

        from src.claude_gates import web_server
        handler = _make_handler_get("/api/sessions/abcd1234/scopes/scope1/files/bad.md")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        # Either 200 with content or graceful error, not a crash
        self.assertIn(handler._response_code, [200, 404, 500])

    def test_port_from_env_var(self):
        """PORT is read from CLAUDE_GATES_PORT environment variable."""
        import importlib
        with patch.dict(os.environ, {'CLAUDE_GATES_PORT': '12345'}):
            from src.claude_gates import web_server
            importlib.reload(web_server)
            self.assertEqual(web_server.PORT, 12345)
        importlib.reload(web_server)

    def test_default_port(self):
        """Default port is 64735 when CLAUDE_GATES_PORT is not set."""
        import importlib
        env = {k: v for k, v in os.environ.items() if k != 'CLAUDE_GATES_PORT'}
        with patch.dict(os.environ, env, clear=True):
            from src.claude_gates import web_server
            importlib.reload(web_server)
            self.assertEqual(web_server.PORT, 64735)

    def test_list_scope_files_only_returns_md(self):
        """list_scope_files returns only .md files."""
        _make_session_db(self.sessions_dir, "abcd1234")
        scope_dir = os.path.join(self.sessions_dir, "abcd1234", "scope1")
        os.makedirs(scope_dir)
        for fname in ["a.md", "b.md", "c.txt", "d.json"]:
            with open(os.path.join(scope_dir, fname), "w") as f:
                f.write("")

        from src.claude_gates import web_server
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            files = web_server.list_scope_files("abcd1234", "scope1")
        self.assertIn("a.md", files)
        self.assertIn("b.md", files)
        self.assertNotIn("c.txt", files)
        self.assertNotIn("d.json", files)


if __name__ == "__main__":
    unittest.main()
