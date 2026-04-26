#!/usr/bin/env node
"use strict";
/**
 * Pipeline Web UI — local HTTP server for live pipeline monitoring.
 *
 * Runs as a detached background process spawned by WebLauncher.ts.
 * Uses Node.js built-in http module + better-sqlite3 (readonly).
 * Self-terminates after 10 minutes of idle (no API requests).
 *
 * Port: env CLAUDE_GATES_PORT or 64735 ("gates" in leet speak).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const SESSIONS_DIR = path_1.default.join(process.cwd(), ".sessions");
const PORT = parseInt(process.env.CLAUDE_GATES_PORT || "64735", 10);
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_DIR_RE = /^[0-9a-f]{8}$/;
let Database;
try {
    Database = require("better-sqlite3");
}
catch {
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    if (dataDir) {
        try {
            Database = require(path_1.default.join(dataDir, "node_modules", "better-sqlite3"));
        }
        catch {
        }
    }
}
let lastRequestTime = Date.now();
// ── Session discovery ────────────────────────────────────────────────
function discoverSessions() {
    try {
        return fs_1.default.readdirSync(SESSIONS_DIR)
            .filter((entry) => SESSION_DIR_RE.test(entry) && fs_1.default.existsSync(path_1.default.join(SESSIONS_DIR, entry, "session.db")));
    }
    catch {
        return [];
    }
}
function openReadonly(sessionId) {
    if (!Database) {
        return null;
    }
    const dbPath = path_1.default.join(SESSIONS_DIR, sessionId, "session.db");
    if (!fs_1.default.existsSync(dbPath)) {
        return null;
    }
    try {
        return new Database(dbPath, { readonly: true, fileMustExist: true, });
    }
    catch {
        return null;
    }
}
function withDb(sessionId, fn) {
    const db = openReadonly(sessionId);
    if (!db) {
        return null;
    }
    try {
        return fn(db);
    }
    finally {
        db.close();
    }
}
// ── Scope directory file listing ─────────────────────────────────────
function listScopeFiles(sessionId, scope) {
    const scopeDir = path_1.default.join(SESSIONS_DIR, sessionId, scope);
    try {
        return fs_1.default.readdirSync(scopeDir).filter((f) => f.endsWith(".md"));
    }
    catch {
        return [];
    }
}
function readArtifact(sessionId, scope, filename) {
    const filePath = path_1.default.join(SESSIONS_DIR, sessionId, scope, filename);
    try {
        return fs_1.default.readFileSync(filePath, "utf-8");
    }
    catch {
        return null;
    }
}
// ── API handlers ─────────────────────────────────────────────────────
function apiSessions() {
    const sessions = discoverSessions();
    return sessions.map((id) => {
        const data = withDb(id, (db) => {
            try {
                const pipelines = db.prepare("SELECT scope, source_agent, status, current_step, total_steps, created_at FROM pipeline_state ORDER BY created_at DESC").all();
                return { id, pipelines, };
            }
            catch {
                return { id, pipelines: [], };
            }
        });
        return data || { id, pipelines: [], };
    });
}
function apiSession(sessionId) {
    if (!SESSION_DIR_RE.test(sessionId)) {
        return null;
    }
    return withDb(sessionId, (db) => {
        try {
            const pipelines = db.prepare("SELECT scope, source_agent, status, current_step, total_steps, trace_id, created_at FROM pipeline_state ORDER BY created_at DESC").all();
            for (const p of pipelines) {
                p.steps = db.prepare("SELECT step_index, step_type, prompt, agent, max_rounds, fixer, status, round, source_agent FROM pipeline_steps WHERE scope = ? ORDER BY step_index").all(p.scope);
                p.agents = db.prepare("SELECT agent, outputFilepath, verdict, \"check\", round, attempts FROM agents WHERE scope = ?").all(p.scope);
                p.files = listScopeFiles(sessionId, p.scope);
            }
            return { id: sessionId, pipelines, };
        }
        catch {
            return { id: sessionId, pipelines: [], };
        }
    });
}
function apiScope(sessionId, scope) {
    if (!SESSION_DIR_RE.test(sessionId)) {
        return null;
    }
    return withDb(sessionId, (db) => {
        try {
            const state = db.prepare("SELECT * FROM pipeline_state WHERE scope = ?").get(scope);
            if (!state) {
                return null;
            }
            const steps = db.prepare("SELECT * FROM pipeline_steps WHERE scope = ? ORDER BY step_index").all(scope);
            const agents = db.prepare("SELECT agent, outputFilepath, verdict, \"check\", round, attempts FROM agents WHERE scope = ?").all(scope);
            const files = listScopeFiles(sessionId, scope);
            const edits = db.prepare("SELECT filepath, lines FROM edits").all();
            return { state, steps, agents, files, edits, };
        }
        catch {
            return null;
        }
    });
}
function apiArtifact(sessionId, scope, agent) {
    if (!SESSION_DIR_RE.test(sessionId)) {
        return null;
    }
    // Try exact filename first, then with .md extension
    const filename = agent.endsWith(".md") ? agent : `${agent}.md`;
    return readArtifact(sessionId, scope, filename);
}
// ── HTML template (populated in Phase 3) ─────────────────────────────
function getHtml() {
    return `<!DOCTYPE html>
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
      const resp = await fetch(API + '/api/artifact/' + el.dataset.session + '/' + el.dataset.scope + '/' + el.dataset.agent);
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
      const r = await fetch(API + '/api/session/' + s.id);
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
</html>`;
}
// ── Route dispatch ───────────────────────────────────────────────────
function route(req, res) {
    lastRequestTime = Date.now();
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const segments = url.pathname.split("/").filter(Boolean);
    res.setHeader("Access-Control-Allow-Origin", "*");
    // GET /health
    if (url.pathname === "/health") {
        json(res, { app: "claude-gates", });
        return;
    }
    // GET /
    if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", });
        res.end(getHtml());
        return;
    }
    // GET /api/sessions
    if (url.pathname === "/api/sessions") {
        json(res, apiSessions());
        return;
    }
    // GET /api/session/:id
    if (segments[0] === "api" && segments[1] === "session" && segments[2]) {
        const result = apiSession(segments[2]);
        if (result) {
            json(res, result);
        }
        else {
            notFound(res);
        }
        return;
    }
    // GET /api/scope/:sessionId/:scope
    if (segments[0] === "api" && segments[1] === "scope" && segments[2] && segments[3]) {
        const result = apiScope(segments[2], segments[3]);
        if (result) {
            json(res, result);
        }
        else {
            notFound(res);
        }
        return;
    }
    // GET /api/artifact/:sessionId/:scope/:agent
    if (segments[0] === "api" && segments[1] === "artifact" && segments[2] && segments[3] && segments[4]) {
        const content = apiArtifact(segments[2], segments[3], segments[4]);
        if (content !== null) {
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", });
            res.end(content);
        }
        else {
            notFound(res);
        }
        return;
    }
    notFound(res);
}
function json(res, data) {
    res.writeHead(200, { "Content-Type": "application/json", });
    res.end(JSON.stringify(data));
}
function notFound(res) {
    res.writeHead(404);
    res.end("Not found");
}
// ── Server startup ───────────────────────────────────────────────────
const server = http_1.default.createServer(route);
server.listen(PORT, "127.0.0.1", () => {
    process.stderr.write(`[ClaudeGates] Web UI: http://localhost:${PORT}\n`);
});
server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        process.stderr.write(`[ClaudeGates] Port ${PORT} in use, web UI not started.\n`);
    }
    process.exit(0);
});
// ── Idle shutdown ────────────────────────────────────────────────────
setInterval(() => {
    if (Date.now() - lastRequestTime > IDLE_TIMEOUT_MS) {
        process.stderr.write("[ClaudeGates] Web UI idle timeout, shutting down.\n");
        server.close();
        process.exit(0);
    }
}, 60_000);
//# sourceMappingURL=WebServer.js.map