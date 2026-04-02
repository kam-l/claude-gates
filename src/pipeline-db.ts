#!/usr/bin/env node
/**
 * Pipeline v3 — SQLite session state module.
 *
 * Pure CRUD — no state machine logic. The engine (pipeline.js) owns transitions.
 *
 * Tables: pipeline_steps, pipeline_state, agents, edits, tool_history.
 * Requires better-sqlite3 (native SQLite binding).
 */

import fs from "fs";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";
import { PipelineState, PipelineStep, VerificationStep } from "./types";

let Database!: typeof BetterSqlite3;
try {
  Database = require("better-sqlite3");
} catch {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  let loadError: Error | undefined;
  if (dataDir) {
    try {
      Database = require(path.join(dataDir, "node_modules", "better-sqlite3"));
    } catch (e) {
      loadError = e as Error;
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

function getDb(sessionDir: string): BetterSqlite3.Database {
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

function insertPipeline(db: BetterSqlite3.Database, scope: string, sourceAgent: string, totalSteps: number): void {
  db.prepare(
    "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) VALUES (?, ?, 'normal', 0, ?)"
  ).run(scope, sourceAgent, totalSteps);
}

function insertStep(db: BetterSqlite3.Database, scope: string, stepIndex: number, step: VerificationStep, sourceAgent: string): void {
  db.prepare(
    "INSERT INTO pipeline_steps (scope, step_index, step_type, prompt, command, allowed_tools, agent, max_rounds, fixer, status, round, source_agent) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)"
  ).run(
    scope, stepIndex, step.type,
    ("prompt" in step ? step.prompt : null),
    ("command" in step ? step.command : null),
    ("allowedTools" in step ? step.allowedTools.join(",") : null),
    ("agent" in step ? step.agent : null),
    ("maxRounds" in step ? step.maxRounds : 3),
    ("fixer" in step ? step.fixer : null),
    stepIndex === 0 ? "active" : "pending",
    sourceAgent
  );
}

function pipelineExists(db: BetterSqlite3.Database, scope: string): boolean {
  return !!db.prepare("SELECT 1 FROM pipeline_state WHERE scope = ? LIMIT 1").get(scope);
}

function getStep(db: BetterSqlite3.Database, scope: string, stepIndex: number): PipelineStep | null {
  return db.prepare(
    "SELECT * FROM pipeline_steps WHERE scope = ? AND step_index = ?"
  ).get(scope, stepIndex) as PipelineStep | undefined || null;
}

function getActiveStep(db: BetterSqlite3.Database, scope: string): PipelineStep | null {
  return db.prepare(
    "SELECT * FROM pipeline_steps WHERE scope = ? AND status = 'active' LIMIT 1"
  ).get(scope) as PipelineStep | undefined || null;
}

function getStepByStatus(db: BetterSqlite3.Database, scope: string, status: string): PipelineStep | null {
  return db.prepare(
    "SELECT * FROM pipeline_steps WHERE scope = ? AND status = ? ORDER BY step_index LIMIT 1"
  ).get(scope, status) as PipelineStep | undefined || null;
}

function getSteps(db: BetterSqlite3.Database, scope: string): PipelineStep[] {
  return db.prepare(
    "SELECT * FROM pipeline_steps WHERE scope = ? ORDER BY step_index"
  ).all(scope) as PipelineStep[];
}

function getPipelineState(db: BetterSqlite3.Database, scope: string): PipelineState | null {
  return db.prepare("SELECT * FROM pipeline_state WHERE scope = ?").get(scope) as PipelineState | undefined || null;
}

function updateStepStatus(db: BetterSqlite3.Database, scope: string, stepIndex: number, status: string, round?: number): void {
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

function updatePipelineState(db: BetterSqlite3.Database, scope: string, updates: Partial<PipelineState>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, val] of Object.entries(updates)) {
    sets.push(`${key} = ?`);
    vals.push(val);
  }
  if (sets.length === 0) return;
  vals.push(scope);
  db.prepare(`UPDATE pipeline_state SET ${sets.join(", ")} WHERE scope = ?`).run(...vals);
}

function deletePipeline(db: BetterSqlite3.Database, scope: string): void {
  const del = db.transaction(() => {
    db.prepare("DELETE FROM pipeline_steps WHERE scope = ?").run(scope);
    db.prepare("DELETE FROM pipeline_state WHERE scope = ?").run(scope);
  });
  del();
}

function getActivePipelines(db: BetterSqlite3.Database): PipelineState[] {
  return db.prepare(
    "SELECT * FROM pipeline_state WHERE status IN ('normal', 'revision')"
  ).all() as PipelineState[];
}

function hasNonPassedSteps(db: BetterSqlite3.Database, scope: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM pipeline_steps WHERE scope = ? AND status != 'passed' LIMIT 1"
  ).get(scope);
}

// ── Agent CRUD ───────────────────────────────────────────────────────

interface AgentRow {
  scope: string;
  agent: string;
  outputFilepath: string | null;
  verdict: string | null;
  round: number | null;
  attempts: number;
}

function registerAgent(db: BetterSqlite3.Database, scope: string, agent: string, outputFilepath: string): void {
  db.prepare(
    "INSERT INTO agents (scope, agent, outputFilepath) VALUES (?, ?, ?) " +
    "ON CONFLICT(scope, agent) DO UPDATE SET outputFilepath = excluded.outputFilepath"
  ).run(scope, agent, outputFilepath);
}

function setVerdict(db: BetterSqlite3.Database, scope: string, agent: string, verdict: string, round: number): void {
  db.prepare(
    "UPDATE agents SET verdict = ?, round = ? WHERE scope = ? AND agent = ?"
  ).run(verdict, round, scope, agent);
}

function getAgent(db: BetterSqlite3.Database, scope: string, agent: string): AgentRow | null {
  return db.prepare("SELECT * FROM agents WHERE scope = ? AND agent = ?").get(scope, agent) as AgentRow | undefined || null;
}

function isCleared(db: BetterSqlite3.Database, scope: string, agent: string): boolean {
  return !!db.prepare("SELECT 1 FROM agents WHERE scope = ? AND agent = ?").get(scope, agent);
}

function findAgentScope(db: BetterSqlite3.Database, agent: string): string | null {
  const row = db.prepare(
    "SELECT scope FROM agents WHERE agent = ? AND scope != '_meta' AND scope != '_pending' ORDER BY verdict IS NULL DESC, rowid DESC LIMIT 1"
  ).get(agent) as { scope: string } | undefined;
  return row ? row.scope : null;
}

function getPending(db: BetterSqlite3.Database, agent: string): { scope: string; outputFilepath: string } | null {
  return db.prepare(
    "SELECT scope, outputFilepath FROM agents WHERE agent = ? AND scope = '_pending' LIMIT 1"
  ).get(agent) as { scope: string; outputFilepath: string } | undefined || null;
}

// ── Edit tracking ────────────────────────────────────────────────────

function addEdit(db: BetterSqlite3.Database, filepath: string, lines?: number): void {
  db.prepare(
    "INSERT INTO edits (filepath, lines) VALUES (?, ?) ON CONFLICT(filepath) DO UPDATE SET lines = lines + excluded.lines"
  ).run(filepath, lines || 0);
}

function getEdits(db: BetterSqlite3.Database): string[] {
  return db.prepare("SELECT filepath FROM edits").all().map((r: any) => r.filepath);
}

function getEditCounts(db: BetterSqlite3.Database): { files: number; lines: number } {
  const row = db.prepare("SELECT COUNT(*) as files, COALESCE(SUM(lines), 0) as lines FROM edits").get() as { files: number; lines: number };
  return { files: row.files, lines: row.lines };
}

// ── Tool history ─────────────────────────────────────────────────────

function addToolHash(db: BetterSqlite3.Database, hash: string): void {
  db.prepare("INSERT INTO tool_history (hash) VALUES (?)").run(hash);
}

function getLastNHashes(db: BetterSqlite3.Database, n: number): string[] {
  return db.prepare("SELECT hash FROM tool_history ORDER BY id DESC LIMIT ?").all(n).map((r: any) => r.hash);
}

export {
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
