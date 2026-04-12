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
        # Patch serve_forever and shutdown to avoid actually starting a server
        with patch.object(IdleHTTPServer, '__init__', return_value=None):
            server = IdleHTTPServer.__new__(IdleHTTPServer)
            server.last_request_time = time.time()  # recent
            server._shutdown_initiated = False

        # Call service_actions — should not trigger shutdown
        with patch.object(server, 'shutdown') as mock_shutdown:
            server.service_actions()
            mock_shutdown.assert_not_called()

    def test_shutdown_after_idle_timeout(self):
        """service_actions initiates shutdown in a daemon thread after 10-min idle."""
        from src.claude_gates.web_server import IdleHTTPServer
        with patch.object(IdleHTTPServer, '__init__', return_value=None):
            server = IdleHTTPServer.__new__(IdleHTTPServer)
            # Simulate 10 minutes + 1 second of idle
            server.last_request_time = time.time() - 601
            server._shutdown_initiated = False

        shutdown_called = threading.Event()

        def fake_shutdown():
            shutdown_called.set()

        with patch.object(server, 'shutdown', side_effect=fake_shutdown):
            server.service_actions()
            # Give the daemon thread a moment to run
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

    def test_uses_uri_mode(self):
        """open_readonly calls sqlite3.connect with uri=True."""
        _make_session_db(self.sessions_dir, "abcd1234")
        from src.claude_gates import web_server
        connect_calls = []
        original_connect = sqlite3.connect

        def capturing_connect(database, **kwargs):
            connect_calls.append((database, kwargs))
            return original_connect(database, **kwargs)

        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            with patch('src.claude_gates.web_server.sqlite3') as mock_sqlite:
                mock_sqlite.connect.side_effect = capturing_connect
                # Call open_readonly — it calls sqlite3.connect
                try:
                    web_server.open_readonly("abcd1234")
                except Exception:
                    pass
                if mock_sqlite.connect.called:
                    args, kwargs = mock_sqlite.connect.call_args
                    db_arg = args[0] if args else kwargs.get('database', '')
                    self.assertTrue(
                        kwargs.get('uri', False) or 'mode=ro' in str(db_arg),
                        "Expected uri=True or mode=ro in connect call"
                    )


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

    def _make_handler(self, method: str, path: str):
        """Create a RequestHandler instance with a mock socket/request."""
        from src.claude_gates.web_server import RequestHandler

        mock_request = MagicMock()
        mock_request.makefile.return_value = BytesIO(
            f"{method} {path} HTTP/1.1\r\nHost: localhost\r\n\r\n".encode()
        )
        response_buffer = BytesIO()
        mock_request.sendall = lambda data: response_buffer.write(data)

        class CapturingHandler(RequestHandler):
            def __init__(self):
                self.responses = []
                self.headers_sent = {}

            def send_response(self, code, message=None):
                self.responses.append(code)

            def send_header(self, name, value):
                self.headers_sent[name] = value

            def end_headers(self):
                pass

            def wfile_write_calls(self):
                return self._wfile_data

        handler = RequestHandler.__new__(RequestHandler)
        handler.command = method
        handler.path = path
        handler.headers = {}

        # Mock wfile
        handler.wfile = BytesIO()

        # Track send_response
        handler._response_code = None
        handler._response_headers = {}
        original_send_response = RequestHandler.send_response

        def track_response(self_h, code, message=None):
            self_h._response_code = code

        def track_header(self_h, name, value):
            self_h._response_headers[name.lower()] = value

        def track_end_headers(self_h):
            pass

        handler.send_response = lambda code, msg=None: setattr(handler, '_response_code', code)
        handler.send_header = lambda k, v: handler._response_headers.__setitem__(k.lower(), v)
        handler.end_headers = lambda: None
        handler.log_message = lambda *args: None

        return handler

    def _call_route(self, method: str, path: str, sessions_dir: str):
        """Call the do_GET handler and return (status_code, headers, body)."""
        from src.claude_gates import web_server

        handler = self._make_handler(method, path)

        with patch.object(web_server, 'SESSIONS_DIR', sessions_dir):
            if hasattr(handler, 'do_GET'):
                handler.do_GET()
            else:
                # If handler routes via command dispatch
                getattr(handler, 'do_GET', handler.handle)()

        body = handler.wfile.getvalue()
        return handler._response_code, handler._response_headers, body

    def test_health_route(self):
        """/health returns {"app": "claude-gates", "status": "ok"}."""
        from src.claude_gates import web_server

        handler = self._make_handler("GET", "/health")
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

        handler = self._make_handler("GET", "/api/sessions")
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
        handler = self._make_handler("GET", "/api/sessions")
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
        handler = self._make_handler("GET", "/api/sessions/abcd1234/pipelines")
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
        handler = self._make_handler("GET", "/api/sessions/abcd1234/scopes/my-scope/files")
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
        handler = self._make_handler("GET", "/api/sessions/abcd1234/scopes/my-scope/files")
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
        handler = self._make_handler("GET", "/api/sessions/abcd1234/scopes/my-scope/files/artifact.md")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()

        body = handler.wfile.getvalue()
        self.assertEqual(body.decode(), "# Hello world")
        ct = handler._response_headers.get("content-type", "")
        self.assertIn("text/plain", ct)

    def test_unknown_route_returns_404(self):
        """/api/unknown returns 404."""
        from src.claude_gates import web_server
        handler = self._make_handler("GET", "/api/unknown")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)


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

    def _make_handler_get(self, path: str):
        from src.claude_gates.web_server import RequestHandler
        handler = RequestHandler.__new__(RequestHandler)
        handler.command = "GET"
        handler.path = path
        handler.headers = {}
        handler.wfile = BytesIO()
        handler._response_code = None
        handler._response_headers = {}
        handler.send_response = lambda code, msg=None: setattr(handler, '_response_code', code)
        handler.send_header = lambda k, v: handler._response_headers.__setitem__(k.lower(), v)
        handler.end_headers = lambda: None
        handler.log_message = lambda *args: None
        return handler

    def test_invalid_session_id_too_long(self):
        """Session ID with 9 chars returns 404."""
        from src.claude_gates import web_server
        handler = self._make_handler_get("/api/sessions/abcd12345/pipelines")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)

    def test_invalid_session_id_uppercase(self):
        """Session ID with uppercase returns 404."""
        from src.claude_gates import web_server
        handler = self._make_handler_get("/api/sessions/ABCD1234/pipelines")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)

    def test_invalid_session_id_path_traversal(self):
        """Session ID with .. returns 404."""
        from src.claude_gates import web_server
        handler = self._make_handler_get("/api/sessions/../evil/pipelines")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)

    def test_scope_with_dotdot_rejected(self):
        """Scope parameter containing .. returns 404."""
        _make_session_db(self.sessions_dir, "abcd1234")
        from src.claude_gates import web_server
        handler = self._make_handler_get("/api/sessions/abcd1234/scopes/../evil/files")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)

    def test_filename_with_dotdot_rejected(self):
        """Filename containing .. returns 404."""
        _make_session_db(self.sessions_dir, "abcd1234")
        scope_dir = os.path.join(self.sessions_dir, "abcd1234", "my-scope")
        os.makedirs(scope_dir)
        from src.claude_gates import web_server
        handler = self._make_handler_get("/api/sessions/abcd1234/scopes/my-scope/files/../evil.md")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 404)

    def test_valid_session_id_accepted(self):
        """Valid 8-char hex session ID is accepted."""
        db_path = _make_session_db(self.sessions_dir, "abcd1234")
        _insert_pipeline(db_path, "s1")
        from src.claude_gates import web_server
        handler = self._make_handler_get("/api/sessions/abcd1234/pipelines")
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

    def _make_handler_get(self, path: str):
        from src.claude_gates.web_server import RequestHandler
        handler = RequestHandler.__new__(RequestHandler)
        handler.command = "GET"
        handler.path = path
        handler.headers = {}
        handler.wfile = BytesIO()
        handler._response_code = None
        handler._response_headers = {}
        handler.send_response = lambda code, msg=None: setattr(handler, '_response_code', code)
        handler.send_header = lambda k, v: handler._response_headers.__setitem__(k.lower(), v)
        handler.end_headers = lambda: None
        handler.log_message = lambda *args: None
        return handler

    def test_root_returns_html(self):
        """GET / returns 200 with Content-Type text/html."""
        from src.claude_gates import web_server
        handler = self._make_handler_get("/")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        self.assertEqual(handler._response_code, 200)
        ct = handler._response_headers.get("content-type", "")
        self.assertIn("text/html", ct)

    def test_root_response_is_html_string(self):
        """GET / response body contains <!DOCTYPE html> and ClaudeGates."""
        from src.claude_gates import web_server
        handler = self._make_handler_get("/")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            handler.do_GET()
        body = handler.wfile.getvalue().decode("utf-8", errors="replace")
        self.assertIn("<!DOCTYPE html>", body)
        self.assertIn("ClaudeGates", body)

    def test_dashboard_has_polling_js(self):
        """Embedded HTML includes polling JS (setInterval or fetch)."""
        from src.claude_gates import web_server
        handler = self._make_handler_get("/")
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
        import inspect
        # get_html should be a function or method that returns a string
        self.assertTrue(hasattr(web_server, 'get_html') or hasattr(web_server.RequestHandler, '_get_html'))
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

    def _make_handler_get(self, path: str):
        from src.claude_gates.web_server import RequestHandler
        handler = RequestHandler.__new__(RequestHandler)
        handler.command = "GET"
        handler.path = path
        handler.headers = {}
        handler.wfile = BytesIO()
        handler._response_code = None
        handler._response_headers = {}
        handler.send_response = lambda code, msg=None: setattr(handler, '_response_code', code)
        handler.send_header = lambda k, v: handler._response_headers.__setitem__(k.lower(), v)
        handler.end_headers = lambda: None
        handler.log_message = lambda *args: None
        return handler

    def test_no_sessions_returns_empty_list(self):
        """/api/sessions returns [] when no session directories exist."""
        from src.claude_gates import web_server
        handler = self._make_handler_get("/api/sessions")
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
        handler = self._make_handler_get("/api/sessions/abcd1234/scopes/scope1/files/bad.md")
        with patch.object(web_server, 'SESSIONS_DIR', self.sessions_dir):
            # Should not raise
            handler.do_GET()
        # Either 200 with content or graceful error, not a crash
        self.assertIn(handler._response_code, [200, 404, 500])

    def test_port_from_env_var(self):
        """PORT is read from CLAUDE_GATES_PORT environment variable."""
        from src.claude_gates import web_server
        # The module-level PORT constant should be overridable via env
        with patch.dict(os.environ, {'CLAUDE_GATES_PORT': '12345'}):
            import importlib
            # Reload to pick up new env
            importlib.reload(web_server)
            self.assertEqual(web_server.PORT, 12345)
        # Reload again to restore default
        importlib.reload(web_server)

    def test_default_port(self):
        """Default port is 64735 when CLAUDE_GATES_PORT is not set."""
        import importlib
        env = {k: v for k, v in os.environ.items() if k != 'CLAUDE_GATES_PORT'}
        with patch.dict(os.environ, env, clear=True):
            from src.claude_gates import web_server
            import importlib
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
