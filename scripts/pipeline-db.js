#!/usr/bin/env node
/**
 * Pipeline v3 — SQLite session state module.
 *
 * Pure CRUD — no state machine logic. The engine (pipeline.js) owns transitions.
 *
 * Tables: pipeline_steps, pipeline_state, agents, edits, tool_history.
 * Requires better-sqlite3 (native SQLite binding).
 *
 * C# analogy: this entire module is like a static DbContext/Repository with
 * typed query methods. Each function takes a `db` (≈ SqlConnection) and returns
 * plain objects (≈ anonymous types or records — JS has no classes here).
 *
 * @typedef {Object} PipelineState
 * @property {string}  scope         - Primary key — pipeline scope name
 * @property {string}  source_agent  - Agent that owns this pipeline
 * @property {string}  status        - 'normal' | 'revision' | 'completed' | 'failed'
 * @property {number}  current_step  - Index of current step
 * @property {number|null} revision_step - Index of step being revised (null if not in revision)
 * @property {number}  total_steps   - Total number of verification steps
 * @property {string|null} trace_id  - Langfuse trace ID for cross-process correlation
 * @property {string}  created_at    - ISO timestamp
 *
 * @typedef {Object} PipelineStep
 * @property {string}  scope
 * @property {number}  step_index
 * @property {string}  step_type     - 'SEMANTIC' | 'COMMAND' | 'REVIEW' | 'REVIEW_WITH_FIXER'
 * @property {string|null} prompt    - Semantic check prompt (SEMANTIC steps only)
 * @property {string|null} command   - Slash command (COMMAND steps only)
 * @property {string|null} allowed_tools - Comma-separated tool names (COMMAND steps only)
 * @property {string|null} agent     - Reviewer agent name (REVIEW/REVIEW_WITH_FIXER steps only)
 * @property {number}  max_rounds    - Max revision rounds before exhaustion
 * @property {string|null} fixer     - Fixer agent name (REVIEW_WITH_FIXER steps only)
 * @property {string}  status        - 'pending' | 'active' | 'passed' | 'revise' | 'fix' | 'failed'
 * @property {number}  round         - Current revision round (0 = first run)
 * @property {string}  source_agent
 */

const fs = require("fs");
const path = require("path");

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  let loadError;
  if (dataDir) {
    try {
      Database = require(path.join(dataDir, "node_modules", "better-sqlite3"));
    } catch (e) {
      loadError = e;
    }
  }
  if (!Database) {
    const pluginDir = __dirname.replace(/[\\/]scripts$/, "");
    const isAbiMismatch = loadError && /NODE_MODULE_VERSION|was compiled against/.test(loadError.message);
    const hint = isAbiMismatch
      ? "ABI mismatch — rebuild with: cd \"" + dataDir + "\" && npm rebuild better-sqlite3"
      : "Run \"npm install\" in the plugin data directory.";
    process.stderr.write(
      `[ClaudeGates] ❌ better-sqlite3 failed to load. ${hint}\n` +
      `  Plugin path: ${pluginDir}\n` +
      `  Data dir: ${dataDir || "(CLAUDE_PLUGIN_DATA not set)"}\n` +
      (loadError ? `  Error: ${loadError.message}\n` : "")
    );
    throw new Error("better-sqlite3 not found");
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pipeline_steps (
  scope         TEXT NOT NULL,
  step_index    INTEGER NOT NULL,
  step_type     TEXT NOT NULL,
  prompt        TEXT,
  command       TEXT,
  allowed_tools TEXT,
  agent         TEXT,
  max_rounds    INTEGER DEFAULT 3,
  fixer         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  round         INTEGER NOT NULL DEFAULT 0,
  source_agent  TEXT NOT NULL,
  PRIMARY KEY (scope, step_index)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_steps_status ON pipeline_steps(status);

CREATE TABLE IF NOT EXISTS pipeline_state (
  scope          TEXT PRIMARY KEY,
  source_agent   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'normal',
  current_step   INTEGER NOT NULL DEFAULT 0,
  revision_step  INTEGER,
  total_steps    INTEGER NOT NULL,
  trace_id       TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  scope          TEXT NOT NULL,
  agent          TEXT NOT NULL,
  outputFilepath TEXT,
  verdict        TEXT,
  round          INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, agent)
);

CREATE TABLE IF NOT EXISTS edits (
  filepath TEXT PRIMARY KEY,
  lines    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tool_history (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL
);
`;

const TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS trim_history AFTER INSERT ON tool_history
BEGIN
  DELETE FROM tool_history WHERE id <= (
    SELECT id FROM tool_history ORDER BY id DESC LIMIT 1 OFFSET 10
  );
END;
`;

function getDb(sessionDir) {
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  const dbPath = path.join(sessionDir, "session.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  db.exec(TRIGGER_SQL);
  // Migration: add trace_id column for Langfuse tracing (idempotent)
  try { db.exec("ALTER TABLE pipeline_state ADD COLUMN trace_id TEXT"); } catch {}
  return db;
}

// ── Pipeline CRUD ────────────────────────────────────────────────────
// C# analogy: these are like a static Repository class with methods that
// take a DbConnection as the first parameter instead of using DI.

/**
 * Insert a new pipeline_state row. Like: INSERT INTO PipelineState VALUES(...)
 * @param {import("better-sqlite3").Database} db - SQLite connection (like SqlConnection)
 * @param {string} scope - Pipeline scope name (primary key)
 * @param {string} sourceAgent - Agent that owns this pipeline
 * @param {number} totalSteps - Number of verification steps
 */
function insertPipeline(db, scope, sourceAgent, totalSteps) {
  db.prepare(
    "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) VALUES (?, ?, 'normal', 0, ?)"
  ).run(scope, sourceAgent, totalSteps);
}

/**
 * Insert a pipeline step. First step (index 0) starts as "active", rest as "pending".
 * @param {import("better-sqlite3").Database} db
 * @param {string} scope
 * @param {number} stepIndex - Zero-based position in the pipeline
 * @param {{ type: string, prompt?: string, command?: string, allowedTools?: string[], agent?: string, maxRounds?: number, fixer?: string }} step
 * @param {string} sourceAgent
 */
function insertStep(db, scope, stepIndex, step, sourceAgent) {
  db.prepare(
    "INSERT INTO pipeline_steps (scope, step_index, step_type, prompt, command, allowed_tools, agent, max_rounds, fixer, status, round, source_agent) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)"
  ).run(
    scope, stepIndex, step.type,
    step.prompt || null,
    step.command || null,
    step.allowedTools ? step.allowedTools.join(",") : null,
    step.agent || null,
    step.maxRounds != null ? step.maxRounds : 3,
    step.fixer || null,
    stepIndex === 0 ? "active" : "pending",
    sourceAgent
  );
}

/** @param {import("better-sqlite3").Database} db  @param {string} scope  @returns {boolean} */
function pipelineExists(db, scope) {
  return !!db.prepare("SELECT 1 FROM pipeline_state WHERE scope = ? LIMIT 1").get(scope);
}

function getStep(db, scope, stepIndex) {
  return db.prepare(
    "SELECT * FROM pipeline_steps WHERE scope = ? AND step_index = ?"
  ).get(scope, stepIndex) || null;
}

/** @param {import("better-sqlite3").Database} db  @param {string} scope  @returns {PipelineStep|null} */
function getActiveStep(db, scope) {
  return db.prepare(
    "SELECT * FROM pipeline_steps WHERE scope = ? AND status = 'active' LIMIT 1"
  ).get(scope) || null;
}

function getStepByStatus(db, scope, status) {
  return db.prepare(
    "SELECT * FROM pipeline_steps WHERE scope = ? AND status = ? ORDER BY step_index LIMIT 1"
  ).get(scope, status) || null;
}

function getSteps(db, scope) {
  return db.prepare(
    "SELECT * FROM pipeline_steps WHERE scope = ? ORDER BY step_index"
  ).all(scope);
}

/** @param {import("better-sqlite3").Database} db  @param {string} scope  @returns {PipelineState|null} */
function getPipelineState(db, scope) {
  return db.prepare("SELECT * FROM pipeline_state WHERE scope = ?").get(scope) || null;
}

function updateStepStatus(db, scope, stepIndex, status, round) {
  if (round !== undefined) {
    db.prepare(
      "UPDATE pipeline_steps SET status = ?, round = ? WHERE scope = ? AND step_index = ?"
    ).run(status, round, scope, stepIndex);
  } else {
    db.prepare(
      "UPDATE pipeline_steps SET status = ? WHERE scope = ? AND step_index = ?"
    ).run(status, scope, stepIndex);
  }
}

/**
 * Update arbitrary columns on pipeline_state. Like a dynamic UPDATE SET.
 * @param {import("better-sqlite3").Database} db
 * @param {string} scope
 * @param {Object<string, any>} updates - Column name → new value (e.g., { status: "completed" })
 */
function updatePipelineState(db, scope, updates) {
  const sets = [];
  const vals = [];
  for (const [key, val] of Object.entries(updates)) {
    sets.push(`${key} = ?`);
    vals.push(val);
  }
  if (sets.length === 0) return;
  vals.push(scope);
  db.prepare(`UPDATE pipeline_state SET ${sets.join(", ")} WHERE scope = ?`).run(...vals);
}

function deletePipeline(db, scope) {
  const del = db.transaction(() => {
    db.prepare("DELETE FROM pipeline_steps WHERE scope = ?").run(scope);
    db.prepare("DELETE FROM pipeline_state WHERE scope = ?").run(scope);
  });
  del();
}

/** Returns all pipelines with status 'normal' or 'revision'. @returns {PipelineState[]} */
function getActivePipelines(db) {
  return db.prepare(
    "SELECT * FROM pipeline_state WHERE status IN ('normal', 'revision')"
  ).all();
}

function hasNonPassedSteps(db, scope) {
  return !!db.prepare(
    "SELECT 1 FROM pipeline_steps WHERE scope = ? AND status != 'passed' LIMIT 1"
  ).get(scope);
}

// ── Agent CRUD ───────────────────────────────────────────────────────

function registerAgent(db, scope, agent, outputFilepath) {
  db.prepare(
    "INSERT INTO agents (scope, agent, outputFilepath) VALUES (?, ?, ?) " +
    "ON CONFLICT(scope, agent) DO UPDATE SET outputFilepath = excluded.outputFilepath"
  ).run(scope, agent, outputFilepath);
}

function setVerdict(db, scope, agent, verdict, round) {
  db.prepare(
    "UPDATE agents SET verdict = ?, round = ? WHERE scope = ? AND agent = ?"
  ).run(verdict, round, scope, agent);
}

function getAgent(db, scope, agent) {
  return db.prepare("SELECT * FROM agents WHERE scope = ? AND agent = ?").get(scope, agent) || null;
}

function isCleared(db, scope, agent) {
  return !!db.prepare("SELECT 1 FROM agents WHERE scope = ? AND agent = ?").get(scope, agent);
}

function findAgentScope(db, agent) {
  const row = db.prepare(
    "SELECT scope FROM agents WHERE agent = ? AND scope != '_meta' AND scope != '_pending' ORDER BY verdict IS NULL DESC, rowid DESC LIMIT 1"
  ).get(agent);
  return row ? row.scope : null;
}

function getPending(db, agent) {
  return db.prepare(
    "SELECT scope, outputFilepath FROM agents WHERE agent = ? AND scope = '_pending' LIMIT 1"
  ).get(agent) || null;
}

// ── Edit tracking ────────────────────────────────────────────────────

function addEdit(db, filepath, lines) {
  db.prepare(
    "INSERT INTO edits (filepath, lines) VALUES (?, ?) ON CONFLICT(filepath) DO UPDATE SET lines = lines + excluded.lines"
  ).run(filepath, lines || 0);
}

function getEdits(db) {
  return db.prepare("SELECT filepath FROM edits").all().map(r => r.filepath);
}

function getEditCounts(db) {
  const row = db.prepare("SELECT COUNT(*) as files, COALESCE(SUM(lines), 0) as lines FROM edits").get();
  return { files: row.files, lines: row.lines };
}

// ── Tool history ─────────────────────────────────────────────────────

function addToolHash(db, hash) {
  db.prepare("INSERT INTO tool_history (hash) VALUES (?)").run(hash);
}

function getLastNHashes(db, n) {
  return db.prepare("SELECT hash FROM tool_history ORDER BY id DESC LIMIT ?").all(n).map(r => r.hash);
}

module.exports = {
  getDb,
  // Pipeline CRUD
  insertPipeline,
  insertStep,
  pipelineExists,
  getStep,
  getActiveStep,
  getStepByStatus,
  getSteps,
  getPipelineState,
  updateStepStatus,
  updatePipelineState,
  deletePipeline,
  getActivePipelines,
  hasNonPassedSteps,
  // Agents
  registerAgent,
  setVerdict,
  getAgent,
  isCleared,
  findAgentScope,
  getPending,
  // Edits
  addEdit,
  getEdits,
  getEditCounts,
  // Tool history
  addToolHash,
  getLastNHashes,
};
