"""
Pipeline Web UI — local HTTP server for live pipeline monitoring.

Runs as a detached background process spawned by web_launcher.py.
Uses Python built-in http.server + sqlite3 (readonly).
Self-terminates after 10 minutes of idle (no API requests).

Port: env CLAUDE_GATES_PORT or 64735 ("gates" in leet speak).
"""

import http.server
import json
import os
import re
import sqlite3
import sys
import threading
import time

PORT = int(os.environ.get("CLAUDE_GATES_PORT", "64735"))
IDLE_TIMEOUT_SECONDS = 10 * 60  # 10 minutes
SESSION_DIR_RE = re.compile(r"^[0-9a-f]{8}$")

# SESSIONS_DIR is frozen to os.getcwd() at module import time.
# Tests patch this name directly via patch.object(web_server, 'SESSIONS_DIR', ...).
SESSIONS_DIR = os.path.join(os.getcwd(), ".sessions")


# ── Session discovery ────────────────────────────────────────────────


def discover_sessions() -> list:
    """Find session dirs matching ^[0-9a-f]{8}$ that have a session.db."""
    try:
        entries = os.listdir(SESSIONS_DIR)
    except OSError:
        return []
    result = []
    for entry in entries:
        if SESSION_DIR_RE.match(entry):
            db_path = os.path.join(SESSIONS_DIR, entry, "session.db")
            if os.path.exists(db_path):
                result.append(entry)
    return result


def open_readonly(session_id: str):
    """Open session.db in sqlite3 readonly URI mode. Returns None on failure."""
    db_path = os.path.join(SESSIONS_DIR, session_id, "session.db")
    if not os.path.exists(db_path):
        return None
    try:
        uri = "file:{}?mode=ro".format(db_path.replace("\\", "/"))
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception:
        return None


def with_db(session_id: str, fn):
    """Open readonly DB, call fn(conn), close, return result. Returns None on error."""
    conn = open_readonly(session_id)
    if conn is None:
        return None
    try:
        return fn(conn)
    finally:
        conn.close()


# ── Scope directory file listing ─────────────────────────────────────


def list_scope_files(session_id: str, scope: str) -> list:
    """List .md files in the scope directory for a session."""
    scope_dir = os.path.join(SESSIONS_DIR, session_id, scope)
    try:
        return [f for f in os.listdir(scope_dir) if f.endswith(".md")]
    except OSError:
        return []


def read_artifact(session_id: str, scope: str, filename: str):
    """Read artifact file content. Returns None if not found."""
    file_path = os.path.join(SESSIONS_DIR, session_id, scope, filename)
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


# ── API handlers ─────────────────────────────────────────────────────


def _row_to_dict(row) -> dict:
    """Convert sqlite3.Row to plain dict."""
    return dict(row)


def api_sessions() -> list:
    """List active sessions with pipeline summaries."""
    sessions = discover_sessions()
    result = []
    for session_id in sessions:

        def _query(conn, sid=session_id):
            try:
                rows = conn.execute(
                    "SELECT scope, source_agent, status, current_step, total_steps, created_at"
                    " FROM pipeline_state ORDER BY created_at DESC"
                ).fetchall()
                pipelines = [_row_to_dict(r) for r in rows]
                return {"id": sid, "pipelines": pipelines}
            except Exception:
                return {"id": sid, "pipelines": []}

        data = with_db(session_id, _query)
        result.append(data if data is not None else {"id": session_id, "pipelines": []})
    return result


def api_session(session_id: str):
    """Full pipeline detail for a session (steps, agents, files per scope)."""
    if not SESSION_DIR_RE.match(session_id):
        return None

    def _query(conn):
        try:
            rows = conn.execute(
                "SELECT scope, source_agent, status, current_step, total_steps,"
                " trace_id, created_at FROM pipeline_state ORDER BY created_at DESC"
            ).fetchall()
            pipelines = [_row_to_dict(r) for r in rows]
            for p in pipelines:
                scope = p["scope"]
                step_rows = conn.execute(
                    "SELECT step_index, step_type, prompt, agent, max_rounds, fixer,"
                    " status, round, source_agent FROM pipeline_steps"
                    " WHERE scope = ? ORDER BY step_index",
                    (scope,),
                ).fetchall()
                p["steps"] = [_row_to_dict(r) for r in step_rows]

                agent_rows = conn.execute(
                    'SELECT agent, outputFilepath, verdict, "check", round, attempts'
                    " FROM agents WHERE scope = ?",
                    (scope,),
                ).fetchall()
                p["agents"] = [_row_to_dict(r) for r in agent_rows]
                p["files"] = list_scope_files(session_id, scope)
            return {"id": session_id, "pipelines": pipelines}
        except Exception:
            return {"id": session_id, "pipelines": []}

    return with_db(session_id, _query)


# ── Embedded HTML dashboard ───────────────────────────────────────────


def get_html() -> str:
    """Return the embedded single-page HTML dashboard."""
    return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClaudeGates Pipeline Monitor</title>
<style>
:root {
  --bg: #1a1a2e; --fg: #e0e0e0; --accent: #7c3aed;
  --pass: #22c55e; --fail: #ef4444; --active: #3b82f6;
  --revise: #f59e0b; --pending: #6b7280; --surface: #16213e;
  --border: #2a2a4a; --mono: 'Cascadia Code', 'Fira Code', monospace;
}
[data-theme="light"] {
  --bg: #f8fafc; --fg: #1e293b; --surface: #ffffff;
  --border: #e2e8f0; --accent: #7c3aed;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: var(--mono); font-size: 13px; line-height: 1.6;
  background: var(--bg); color: var(--fg);
  padding: 16px; max-width: 1200px; margin: 0 auto;
}
header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 0; border-bottom: 1px solid var(--border); margin-bottom: 16px;
}
header h1 { font-size: 16px; color: var(--accent); }
#theme-toggle {
  background: none; border: 1px solid var(--border); color: var(--fg);
  padding: 4px 8px; border-radius: 4px; cursor: pointer; font-family: var(--mono);
}
.session { margin-bottom: 12px; }
.session > summary {
  cursor: pointer; padding: 8px 12px; background: var(--surface);
  border: 1px solid var(--border); border-radius: 6px;
  list-style: none; display: flex; justify-content: space-between;
}
.session > summary::-webkit-details-marker { display: none; }
.session[open] > summary { border-radius: 6px 6px 0 0; }
.session-body { border: 1px solid var(--border); border-top: none; border-radius: 0 0 6px 6px; padding: 8px 12px; }
.scope { margin: 6px 0; }
.scope > summary {
  cursor: pointer; padding: 4px 8px; border-radius: 4px;
  list-style: none; display: flex; gap: 12px; align-items: center;
}
.scope > summary:hover { background: var(--surface); }
.pipeline-steps { margin-left: 24px; padding: 4px 0; }
.step {
  display: flex; gap: 8px; align-items: center; padding: 2px 0;
}
.step-icon { width: 20px; text-align: center; }
.status-passed { color: var(--pass); }
.status-active { color: var(--active); }
.status-failed { color: var(--fail); }
.status-revise, .status-fix { color: var(--revise); }
.status-pending { color: var(--pending); }
.agent-row {
  display: flex; gap: 8px; padding: 2px 0 2px 24px; align-items: center;
}
.verdict-badge {
  padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: bold;
}
.verdict-PASS { background: var(--pass); color: #000; }
.verdict-REVISE { background: var(--revise); color: #000; }
.verdict-FAIL { background: var(--fail); color: #fff; }
.artifact-panel {
  margin: 4px 0 4px 48px; padding: 8px; background: var(--surface);
  border: 1px solid var(--border); border-radius: 4px;
  white-space: pre-wrap; font-size: 12px; max-height: 400px; overflow-y: auto;
}
.file-link {
  color: var(--accent); cursor: pointer; text-decoration: underline;
  font-size: 12px;
}
.files-list { margin-left: 24px; padding: 4px 0; }
.badge {
  padding: 1px 6px; border-radius: 3px; font-size: 11px;
}
.badge-active { background: var(--active); color: #fff; }
.badge-completed { background: var(--pass); color: #000; }
.badge-failed { background: var(--fail); color: #fff; }
.badge-normal { background: var(--active); color: #fff; }
.badge-revision { background: var(--revise); color: #000; }
.empty { color: var(--pending); font-style: italic; padding: 8px; }
.refresh-indicator { font-size: 11px; color: var(--pending); }
</style>
</head>
<body>
<header>
  <h1>ClaudeGates Pipeline Monitor</h1>
  <div>
    <span class="refresh-indicator" id="refresh-status">polling...</span>
    <button id="theme-toggle">theme</button>
  </div>
</header>
<main id="app"><div class="empty">Loading...</div></main>
<script>
const API = '';
let data = [];
let expandedArtifacts = {};

document.getElementById('theme-toggle').onclick = () => {
  const html = document.documentElement;
  html.dataset.theme = html.dataset.theme === 'light' ? '' : 'light';
};

function statusIcon(s) {
  const map = { passed: '\\u2713', active: '\\u25cf', failed: '\\u2717', pending: '\\u25cb', revise: '\\u21ba', fix: '\\u2699' };
  return map[s] || '?';
}

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso + 'Z').getTime();
  if (ms < 60000) return Math.round(ms/1000) + 's ago';
  if (ms < 3600000) return Math.round(ms/60000) + 'm ago';
  return Math.round(ms/3600000) + 'h ago';
}

function renderStep(step) {
  const icon = statusIcon(step.status);
  const cls = 'status-' + step.status;
  let label = step.step_type;
  if (step.agent) label += ' ' + step.agent;
  let meta = '';
  if (step.status === 'active' || step.status === 'revise' || step.status === 'fix')
    meta = ' round ' + (step.round + 1) + '/' + step.max_rounds;
  return '<div class="step"><span class="step-icon ' + cls + '">' + icon + '</span>'
    + '<span>' + label + '</span><span class="' + cls + '">' + step.status + meta + '</span></div>';
}

function renderAgent(sessionId, scope, agent) {
  let html = '<div class="agent-row">';
  html += '<span>' + agent.agent + '</span>';
  if (agent.verdict)
    html += '<span class="verdict-badge verdict-' + agent.verdict + '">' + agent.verdict + '</span>';
  if (agent.round !== null)
    html += '<span>round ' + agent.round + '</span>';
  if (agent.outputFilepath) {
    const key = sessionId + '/' + scope + '/' + agent.agent;
    html += ' <span class="file-link" data-key="' + key + '" data-session="' + sessionId
      + '" data-scope="' + scope + '" data-agent="' + agent.agent + '">view artifact</span>';
  }
  html += '</div>';
  if (expandedArtifacts[sessionId + '/' + scope + '/' + agent.agent])
    html += '<div class="artifact-panel">' + escHtml(expandedArtifacts[sessionId + '/' + scope + '/' + agent.agent]) + '</div>';
  return html;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderFiles(sessionId, scope, files) {
  if (!files || files.length === 0) return '';
  let html = '<div class="files-list"><strong>Files:</strong>';
  for (const f of files) {
    const key = sessionId + '/' + scope + '/file:' + f;
    html += ' <span class="file-link" data-key="' + key + '" data-session="' + sessionId
      + '" data-scope="' + scope + '" data-agent="' + f + '">' + f + '</span>';
  }
  html += '</div>';
  for (const f of files) {
    const key = sessionId + '/' + scope + '/file:' + f;
    if (expandedArtifacts[key])
      html += '<div class="artifact-panel">' + escHtml(expandedArtifacts[key]) + '</div>';
  }
  return html;
}

function render() {
  const app = document.getElementById('app');
  if (!data.length) { app.innerHTML = '<div class="empty">No sessions found</div>'; return; }
  let html = '';
  for (const session of data) {
    const pCount = session.pipelines ? session.pipelines.length : 0;
    html += '<details class="session" open><summary><span>session ' + session.id + '</span>'
      + '<span>' + pCount + ' pipeline' + (pCount !== 1 ? 's' : '') + '</span></summary>';
    html += '<div class="session-body">';
    if (!pCount) { html += '<div class="empty">(no pipelines)</div>'; }
    for (const p of (session.pipelines || [])) {
      const badge = 'badge-' + p.status;
      html += '<details class="scope" open><summary>'
        + '<span>scope: <strong>' + p.scope + '</strong></span>'
        + '<span class="badge ' + badge + '">' + p.status + '</span>'
        + '<span>step ' + (p.current_step + 1) + '/' + p.total_steps + '</span>'
        + '<span>' + timeAgo(p.created_at) + '</span>'
        + '</summary>';
      html += '<div class="pipeline-steps">';
      if (p.steps) for (const s of p.steps) html += renderStep(s);
      html += '</div>';
      if (p.agents && p.agents.length) {
        html += '<div style="margin-left:24px;padding:4px 0"><strong>Agents:</strong></div>';
        for (const a of p.agents) html += renderAgent(session.id, p.scope, a);
      }
      html += renderFiles(session.id, p.scope, p.files);
      html += '</details>';
    }
    html += '</div></details>';
  }
  app.innerHTML = html;
  // Re-attach click handlers for artifact links
  document.querySelectorAll('.file-link').forEach(el => {
    el.onclick = async () => {
      const key = el.dataset.key;
      if (expandedArtifacts[key]) { delete expandedArtifacts[key]; render(); return; }
      const resp = await fetch(API + '/api/sessions/' + el.dataset.session + '/scopes/' + el.dataset.scope + '/files/' + el.dataset.agent);
      if (resp.ok) { const text = await resp.text(); expandedArtifacts[key] = text || '(empty)'; }
      else expandedArtifacts[key] = '(failed to load)';
      render();
    };
  });
}

async function poll() {
  try {
    const resp = await fetch(API + '/api/sessions');
    if (!resp.ok) return;
    const sessions = await resp.json();
    // Fetch full details for each session
    const detailed = await Promise.all(sessions.map(async s => {
      const r = await fetch(API + '/api/sessions/' + s.id + '/pipelines');
      return r.ok ? r.json() : s;
    }));
    data = detailed;
    render();
    document.getElementById('refresh-status').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('refresh-status').textContent = 'poll error';
  }
}

poll();
setInterval(poll, 2000);
</script>
</body>
</html>"""


# ── Request handler ───────────────────────────────────────────────────


class RequestHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler for pipeline monitoring dashboard."""

    def do_GET(self):
        """Route GET requests."""
        # Update last_request_time on the server instance
        if hasattr(self, 'server') and hasattr(self.server, 'last_request_time'):
            self.server.last_request_time = time.time()

        path = self.path.split("?", 1)[0]  # strip query string
        segments = [s for s in path.split("/") if s]

        # GET /
        if path == "/":
            html = get_html()
            encoded = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return

        # GET /health
        if path == "/health":
            self._send_json({"app": "claude-gates", "status": "ok"})
            return

        # GET /api/sessions
        if path == "/api/sessions":
            self._send_json(api_sessions())
            return

        # /api/sessions/{id} — no sub-resource, not a valid route
        if (len(segments) == 3 and segments[0] == "api"
                and segments[1] == "sessions" and segments[2]):
            self._send_not_found()
            return

        # GET /api/sessions/{id}/pipelines
        if (len(segments) == 4 and segments[0] == "api"
                and segments[1] == "sessions" and segments[3] == "pipelines"):
            session_id = segments[2]
            if not self._valid_session_id(session_id):
                self._send_not_found()
                return
            result = api_session(session_id)
            if result is not None:
                self._send_json(result)
            else:
                self._send_not_found()
            return

        # /api/sessions/{id}/scopes/{scope} — no sub-resource
        if (len(segments) == 5 and segments[0] == "api"
                and segments[1] == "sessions" and segments[3] == "scopes"):
            self._send_not_found()
            return

        # GET /api/sessions/{id}/scopes/{scope}/files
        if (len(segments) == 6 and segments[0] == "api"
                and segments[1] == "sessions" and segments[3] == "scopes"
                and segments[5] == "files"):
            session_id = segments[2]
            scope = segments[4]
            if not self._valid_session_id(session_id):
                self._send_not_found()
                return
            if not self._valid_path_component(scope):
                self._send_not_found()
                return
            files = list_scope_files(session_id, scope)
            self._send_json(files)
            return

        # GET /api/sessions/{id}/scopes/{scope}/files/{filename}
        if (len(segments) == 7 and segments[0] == "api"
                and segments[1] == "sessions" and segments[3] == "scopes"
                and segments[5] == "files"):
            session_id = segments[2]
            scope = segments[4]
            filename = segments[6]
            if not self._valid_session_id(session_id):
                self._send_not_found()
                return
            if not self._valid_path_component(scope):
                self._send_not_found()
                return
            if not self._valid_path_component(filename):
                self._send_not_found()
                return
            content = read_artifact(session_id, scope, filename)
            if content is not None:
                encoded = content.encode("utf-8", errors="replace")
                self.send_response(200)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            else:
                self._send_not_found()
            return

        self._send_not_found()

    def _valid_session_id(self, session_id: str) -> bool:
        return bool(SESSION_DIR_RE.match(session_id))

    def _valid_path_component(self, component: str) -> bool:
        """Reject components containing .., /, or \\ (path traversal guards)."""
        return (
            ".." not in component
            and "/" not in component
            and "\\" not in component
        )

    def _send_json(self, data) -> None:
        """Send a 200 JSON response. send_response is always called first."""
        body = json.dumps(data).encode("utf-8")
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_not_found(self) -> None:
        """Send a 404 response. send_response is always called first."""
        self.send_response(404)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", "9")
        self.end_headers()
        self.wfile.write(b"Not found")

    def log_message(self, fmt, *args):
        """Suppress default access log output."""
        pass


# ── Idle shutdown server ──────────────────────────────────────────────


class IdleHTTPServer(http.server.HTTPServer):
    """HTTPServer that shuts itself down after IDLE_TIMEOUT_SECONDS of no requests."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.last_request_time = time.time()
        self._shutdown_initiated = False

    def service_actions(self):
        """Called periodically by serve_forever(). Check for idle timeout."""
        super().service_actions()
        if self._shutdown_initiated:
            return
        if time.time() - self.last_request_time > IDLE_TIMEOUT_SECONDS:
            self._shutdown_initiated = True
            t = threading.Thread(target=self.shutdown, daemon=True)
            t.start()


# ── Entry point ───────────────────────────────────────────────────────


def main() -> None:
    """Bind to 0.0.0.0:{PORT} and serve forever."""
    try:
        server = IdleHTTPServer(("0.0.0.0", PORT), RequestHandler)
    except OSError as e:
        print(
            "[ClaudeGates] Port {} in use or bind failed: {}".format(PORT, e),
            file=sys.stderr,
        )
        return

    print("[ClaudeGates] Web UI: http://localhost:{}".format(PORT), file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
