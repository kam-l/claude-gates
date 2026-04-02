#!/usr/bin/env node
/**
 * ClaudeGates v2 — SQLite session state module.
 *
 * 4-table schema: agents, gates, edits, tool_history.
 * Requires better-sqlite3 (native SQLite binding).
 */

import fs from "fs";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";

let Database!: typeof BetterSqlite3;
try {
  Database = require("better-sqlite3");
} catch {
  // Installed node_modules live in CLAUDE_PLUGIN_DATA (survives plugin updates).
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

interface GateRow {
  order: number;
  gate_agent: string;
  max_rounds: number;
  status: string;
  round: number;
  source_agent: string;
  fixer_agent: string | null;
}

interface AgentRow {
  scope: string;
  agent: string;
  outputFilepath: string | null;
  verdict: string | null;
  round: number | null;
  attempts: number;
}

interface GateConfig {
  agent: string;
  maxRounds: number;
  fixer?: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  scope          TEXT NOT NULL,
  agent          TEXT NOT NULL,
  outputFilepath TEXT,
  verdict        TEXT,
  round          INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, agent)
);

CREATE TABLE IF NOT EXISTS gates (
  scope        TEXT NOT NULL,
  "order"      INTEGER NOT NULL,
  gate_agent   TEXT NOT NULL,
  max_rounds   INTEGER NOT NULL DEFAULT 3,
  status       TEXT NOT NULL DEFAULT 'pending',
  round        INTEGER NOT NULL DEFAULT 0,
  source_agent TEXT NOT NULL,
  fixer_agent  TEXT,
  PRIMARY KEY (scope, "order")
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

  // Create tables (no-op if they exist)
  db.exec(SCHEMA_SQL);
  db.exec(TRIGGER_SQL);

  // Upgrade edits table from old schema (add lines column if missing)
  try {
    db.prepare("SELECT lines FROM edits LIMIT 0").get();
  } catch {
    try { db.exec("ALTER TABLE edits ADD COLUMN lines INTEGER NOT NULL DEFAULT 0"); } catch {}
  }

  // Upgrade gates table (add fixer_agent column if missing)
  try {
    db.prepare("SELECT fixer_agent FROM gates LIMIT 0").get();
  } catch {
    try { db.exec("ALTER TABLE gates ADD COLUMN fixer_agent TEXT"); } catch {}
  }

  // Migrate old SQLite schema → new (if old tables exist)
  const hasOldScopes = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scopes'"
  ).get();
  if (hasOldScopes) {
    migrateOldSchema(db);
  }

  // Check JSON migration marker (now stored in agents table)
  const hasMigrated = db.prepare(
    "SELECT 1 FROM agents WHERE scope = '_meta' AND agent = 'json_migrated'"
  ).get();
  if (!hasMigrated) {
    const scopesFile = path.join(sessionDir, "session_scopes.json");
    const editsFile = path.join(sessionDir, "edits.log");
    const historyFile = path.join(sessionDir, "tool_history.json");
    const markerFile = path.join(sessionDir, ".stop-gate-nudged");

    const hasOldFiles = fs.existsSync(scopesFile) || fs.existsSync(editsFile) ||
                        fs.existsSync(historyFile) || fs.existsSync(markerFile);

    if (hasOldFiles) {
      migrateFromJson(sessionDir, db);
    }
  }

  return db;
}

function migrateOldSchema(db: BetterSqlite3.Database): void {
  const migrate = db.transaction(() => {
    // Re-check inside transaction (concurrency guard)
    const hasOld = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scopes'"
    ).get();
    if (!hasOld) return;

    // Migrate cleared → agents
    try {
      const rows = db.prepare("SELECT scope, agent, verdict, round FROM cleared").all() as { scope: string; agent: string; verdict: string | null; round: number | null }[];
      for (const r of rows) {
        db.prepare(
          "INSERT OR IGNORE INTO agents (scope, agent, verdict, round) VALUES (?, ?, ?, ?)"
        ).run(r.scope, r.agent, r.verdict, r.round);
      }
    } catch {}

    // Migrate pending → agents (update outputFilepath)
    try {
      const rows = db.prepare("SELECT agent, scope, outputFilepath FROM pending").all() as { agent: string; scope: string; outputFilepath: string | null }[];
      for (const r of rows) {
        db.prepare(
          "INSERT INTO agents (scope, agent, outputFilepath) VALUES (?, ?, ?) " +
          "ON CONFLICT(scope, agent) DO UPDATE SET outputFilepath = excluded.outputFilepath"
        ).run(r.scope, r.agent, r.outputFilepath);
      }
    } catch {}

    // Migrate scope_gates → gates
    try {
      const rows = db.prepare(
        "SELECT scope, seq, gate_agent, max_rounds, status, round, source_agent FROM scope_gates"
      ).all() as { scope: string; seq: number; gate_agent: string; max_rounds: number; status: string; round: number; source_agent: string }[];
      for (const r of rows) {
        db.prepare(
          'INSERT OR IGNORE INTO gates (scope, "order", gate_agent, max_rounds, status, round, source_agent) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(r.scope, r.seq, r.gate_agent, r.max_rounds, r.status, r.round, r.source_agent);
      }
    } catch {}

    // Migrate markers → agents (special rows)
    try {
      const nudge = db.prepare("SELECT value FROM markers WHERE name = 'stop-gate-nudged'").get() as { value: string } | undefined;
      if (nudge) {
        db.prepare("INSERT OR IGNORE INTO agents (scope, agent) VALUES ('_nudge', 'stop-gate')").run();
      }
      const migrated = db.prepare("SELECT 1 FROM markers WHERE name = 'json_migrated'").get();
      if (migrated) {
        db.prepare("INSERT OR IGNORE INTO agents (scope, agent) VALUES ('_meta', 'json_migrated')").run();
      }
    } catch {}

    // Migrate edit_stats → agents (plan_gate_attempts)
    try {
      const attempts = db.prepare("SELECT value FROM edit_stats WHERE key = 'plan_gate_attempts'").get() as { value: number } | undefined;
      if (attempts) {
        db.prepare(
          "INSERT INTO agents (scope, agent, attempts) VALUES ('_system', 'plan-gate', ?) " +
          "ON CONFLICT(scope, agent) DO UPDATE SET attempts = excluded.attempts"
        ).run(attempts.value);
      }
    } catch {}

    // Drop old tables
    db.exec("DROP TABLE IF EXISTS scopes");
    db.exec("DROP TABLE IF EXISTS cleared");
    db.exec("DROP TABLE IF EXISTS pending");
    db.exec("DROP TABLE IF EXISTS scope_gates");
    db.exec("DROP TABLE IF EXISTS markers");
    db.exec("DROP TABLE IF EXISTS edit_stats");
  });
  migrate();
}

function migrateFromJson(sessionDir: string, db: BetterSqlite3.Database): void {
  const migrate = db.transaction(() => {
    // Re-check marker inside transaction (handles concurrent hooks)
    const already = db.prepare(
      "SELECT 1 FROM agents WHERE scope = '_meta' AND agent = 'json_migrated'"
    ).get();
    if (already) return;

    // Migrate session_scopes.json
    try {
      const scopesFile = path.join(sessionDir, "session_scopes.json");
      const scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8")) as Record<string, any>;
      for (const [scope, info] of Object.entries(scopes)) {
        if (scope === "_pending") {
          // Migrate pending entries
          if (info && typeof info === "object") {
            for (const [agent, pending] of Object.entries(info as Record<string, any>)) {
              if (pending && pending.outputFilepath) {
                db.prepare(
                  "INSERT INTO agents (scope, agent, outputFilepath) VALUES (?, ?, ?) " +
                  "ON CONFLICT(scope, agent) DO UPDATE SET outputFilepath = excluded.outputFilepath"
                ).run(pending.scope || "", agent, pending.outputFilepath);
              }
            }
          }
          continue;
        }
        if (info && info.cleared) {
          for (const [agent, val] of Object.entries(info.cleared as Record<string, any>)) {
            if (val && typeof val === "object") {
              db.prepare(
                "INSERT OR IGNORE INTO agents (scope, agent, verdict, round) VALUES (?, ?, ?, ?)"
              ).run(scope, agent, val.verdict || null, val.round || null);
            } else {
              // boolean true — cleared with no verdict
              db.prepare(
                "INSERT OR IGNORE INTO agents (scope, agent) VALUES (?, ?)"
              ).run(scope, agent);
            }
          }
        }
      }
    } catch {} // missing or invalid — skip

    // Migrate edits.log
    try {
      const editsFile = path.join(sessionDir, "edits.log");
      const content = fs.readFileSync(editsFile, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
          db.prepare("INSERT OR IGNORE INTO edits (filepath) VALUES (?)").run(trimmed);
        }
      }
    } catch {} // missing — skip

    // Migrate tool_history.json
    try {
      const historyFile = path.join(sessionDir, "tool_history.json");
      const history = JSON.parse(fs.readFileSync(historyFile, "utf-8"));
      if (Array.isArray(history)) {
        for (const hash of history) {
          db.prepare("INSERT INTO tool_history (hash) VALUES (?)").run(hash);
        }
      }
    } catch {} // missing — skip

    // Migrate .stop-gate-nudged marker
    try {
      const markerFile = path.join(sessionDir, ".stop-gate-nudged");
      if (fs.existsSync(markerFile)) {
        db.prepare(
          "INSERT OR IGNORE INTO agents (scope, agent) VALUES ('_nudge', 'stop-gate')"
        ).run();
      }
    } catch {} // missing — skip

    // Set migration marker
    db.prepare(
      "INSERT OR IGNORE INTO agents (scope, agent) VALUES ('_meta', 'json_migrated')"
    ).run();
  });

  migrate();
}

// ── Agent operations ──────────────────────────────────────────────────

function registerAgent(db: BetterSqlite3.Database, scope: string, agent: string, outputFilepath: string): void {
  db.prepare(
    "INSERT INTO agents (scope, agent, outputFilepath) VALUES (?, ?, ?) " +
    "ON CONFLICT(scope, agent) DO UPDATE SET outputFilepath = excluded.outputFilepath"
  ).run(scope, agent, outputFilepath);
}

function setVerdict(db: BetterSqlite3.Database, scope: string, agent: string, verdict: string, round: number): void {
  db.prepare(
    "INSERT INTO agents (scope, agent, verdict, round) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(scope, agent) DO UPDATE SET verdict = excluded.verdict, round = excluded.round"
  ).run(scope, agent, verdict, round);
}

function getAgent(db: BetterSqlite3.Database, scope: string, agent: string): AgentRow | null {
  return db.prepare(
    "SELECT scope, agent, outputFilepath, verdict, round, attempts FROM agents WHERE scope = ? AND agent = ?"
  ).get(scope, agent) as AgentRow | undefined || null;
}

function isCleared(db: BetterSqlite3.Database, scope: string, agent: string): boolean {
  const row = db.prepare("SELECT 1 FROM agents WHERE scope = ? AND agent = ?").get(scope, agent);
  return !!row;
}

function findAgentScope(db: BetterSqlite3.Database, agent: string): string | null {
  const row = db.prepare(
    "SELECT scope FROM agents WHERE agent = ? AND SUBSTR(scope, 1, 1) != '_' ORDER BY CASE WHEN verdict IS NULL THEN 0 ELSE 1 END, rowid DESC LIMIT 1"
  ).get(agent) as { scope: string } | undefined;
  return row ? row.scope : null;
}

function getPending(db: BetterSqlite3.Database, agent: string): { scope: string; outputFilepath: string } | null {
  const row = db.prepare(
    "SELECT scope, outputFilepath FROM agents WHERE agent = ? AND outputFilepath IS NOT NULL AND SUBSTR(scope, 1, 1) != '_' ORDER BY CASE WHEN verdict IS NULL THEN 0 ELSE 1 END, rowid DESC LIMIT 1"
  ).get(agent) as { scope: string; outputFilepath: string } | undefined;
  return row || null;
}

function incrAttempts(db: BetterSqlite3.Database, scope: string, agent: string): void {
  db.prepare(
    "INSERT INTO agents (scope, agent, attempts) VALUES (?, ?, 1) " +
    "ON CONFLICT(scope, agent) DO UPDATE SET attempts = attempts + 1"
  ).run(scope, agent);
}

function getAttempts(db: BetterSqlite3.Database, scope: string, agent: string): number {
  const row = db.prepare("SELECT attempts FROM agents WHERE scope = ? AND agent = ?").get(scope, agent) as { attempts: number } | undefined;
  return row ? row.attempts : 0;
}

function resetAttempts(db: BetterSqlite3.Database, scope: string, agent: string): void {
  db.prepare(
    "INSERT INTO agents (scope, agent, attempts) VALUES (?, ?, 0) " +
    "ON CONFLICT(scope, agent) DO UPDATE SET attempts = 0"
  ).run(scope, agent);
}

// ── Edit tracking ─────────────────────────────────────────────────────

function addEdit(db: BetterSqlite3.Database, filepath: string, lines?: number): void {
  if (lines != null) {
    db.prepare(
      "INSERT INTO edits (filepath, lines) VALUES (?, ?) ON CONFLICT(filepath) DO UPDATE SET lines = excluded.lines"
    ).run(filepath, lines);
  } else {
    db.prepare("INSERT OR IGNORE INTO edits (filepath) VALUES (?)").run(filepath);
  }
}

function getEdits(db: BetterSqlite3.Database): string[] {
  const rows = db.prepare("SELECT filepath FROM edits").all() as { filepath: string }[];
  return rows.map(r => r.filepath);
}

function getEditCounts(db: BetterSqlite3.Database): { files: number; lines: number } {
  const row = db.prepare(
    "SELECT COUNT(*) as files, COALESCE(SUM(lines), 0) as lines FROM edits"
  ).get() as { files: number; lines: number };
  return { files: row.files, lines: row.lines };
}

// ── Tool history (ring buffer) ────────────────────────────────────────

function addToolHash(db: BetterSqlite3.Database, hash: string): void {
  db.prepare("INSERT INTO tool_history (hash) VALUES (?)").run(hash);
}

function getLastNHashes(db: BetterSqlite3.Database, n: number): string[] {
  const rows = db.prepare("SELECT hash FROM tool_history ORDER BY id DESC LIMIT ?").all(n) as { hash: string }[];
  return rows.map(r => r.hash).reverse();
}

// ── Gate operations ───────────────────────────────────────────────────

function initGates(db: BetterSqlite3.Database, scope: string, sourceAgent: string, gates: GateConfig[]): void {
  const init = db.transaction(() => {
    const existing = db.prepare("SELECT 1 FROM gates WHERE scope = ? LIMIT 1").get(scope);
    if (existing) return;
    for (let i = 0; i < gates.length; i++) {
      const status = i === 0 ? "active" : "pending";
      db.prepare(
        'INSERT INTO gates (scope, "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
      ).run(scope, i, gates[i].agent, gates[i].maxRounds, status, sourceAgent, gates[i].fixer || null);
    }
  });
  init();
}

function getActiveGate(db: BetterSqlite3.Database, scope: string): GateRow | null {
  return db.prepare(
    'SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? AND status = \'active\' LIMIT 1'
  ).get(scope) as GateRow | undefined || null;
}

function getReviseGate(db: BetterSqlite3.Database, scope: string): GateRow | null {
  return db.prepare(
    'SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? AND status = \'revise\' LIMIT 1'
  ).get(scope) as GateRow | undefined || null;
}

function getGates(db: BetterSqlite3.Database, scope: string): GateRow[] {
  return db.prepare(
    'SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? ORDER BY "order"'
  ).all(scope) as GateRow[];
}

function passGate(db: BetterSqlite3.Database, scope: string, order: number): { nextGate: GateRow | null; allPassed: boolean } {
  const result: { nextGate: GateRow | null; allPassed: boolean } = { nextGate: null, allPassed: false };
  const pass = db.transaction(() => {
    db.prepare('UPDATE gates SET status = \'passed\' WHERE scope = ? AND "order" = ?').run(scope, order);
    const next = db.prepare(
      'SELECT "order" FROM gates WHERE scope = ? AND "order" > ? AND status = \'pending\' ORDER BY "order" LIMIT 1'
    ).get(scope, order) as { order: number } | undefined;
    if (next) {
      db.prepare('UPDATE gates SET status = \'active\' WHERE scope = ? AND "order" = ?').run(scope, next.order);
      result.nextGate = db.prepare(
        'SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? AND "order" = ?'
      ).get(scope, next.order) as GateRow | undefined || null;
    } else {
      const nonPassed = db.prepare(
        "SELECT 1 FROM gates WHERE scope = ? AND status != 'passed' LIMIT 1"
      ).get(scope);
      result.allPassed = !nonPassed;
    }
  });
  pass();
  return result;
}

function reviseGate(db: BetterSqlite3.Database, scope: string, order: number): { status: string; round: number } | null {
  let result: { status: string; round: number } | null = null;
  const revise = db.transaction(() => {
    const gate = db.prepare(
      'SELECT round, max_rounds FROM gates WHERE scope = ? AND "order" = ?'
    ).get(scope, order) as { round: number; max_rounds: number } | undefined;
    if (!gate) return;
    const newRound = gate.round + 1;
    if (newRound >= gate.max_rounds) {
      db.prepare('UPDATE gates SET status = \'failed\', round = ? WHERE scope = ? AND "order" = ?')
        .run(newRound, scope, order);
      result = { status: "failed", round: newRound };
    } else {
      db.prepare('UPDATE gates SET status = \'revise\', round = ? WHERE scope = ? AND "order" = ?')
        .run(newRound, scope, order);
      result = { status: "revise", round: newRound };
    }
  });
  revise();
  return result;
}

function reactivateReviseGate(db: BetterSqlite3.Database, scope: string): boolean {
  const gate = db.prepare(
    'SELECT "order" FROM gates WHERE scope = ? AND status = \'revise\' ORDER BY "order" LIMIT 1'
  ).get(scope) as { order: number } | undefined;
  if (!gate) return false;
  db.prepare('UPDATE gates SET status = \'active\' WHERE scope = ? AND "order" = ?').run(scope, gate.order);
  return true;
}

function getFixGate(db: BetterSqlite3.Database, scope: string): GateRow | null {
  return db.prepare(
    'SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? AND status = \'fix\' LIMIT 1'
  ).get(scope) as GateRow | undefined || null;
}

function fixGate(db: BetterSqlite3.Database, scope: string, order: number): { status: string; round: number } | null {
  let result: { status: string; round: number } | null = null;
  const fix = db.transaction(() => {
    const gate = db.prepare(
      'SELECT round, max_rounds FROM gates WHERE scope = ? AND "order" = ?'
    ).get(scope, order) as { round: number; max_rounds: number } | undefined;
    if (!gate) return;
    const newRound = gate.round + 1;
    if (newRound >= gate.max_rounds) {
      db.prepare('UPDATE gates SET status = \'failed\', round = ? WHERE scope = ? AND "order" = ?')
        .run(newRound, scope, order);
      result = { status: "failed", round: newRound };
    } else {
      db.prepare('UPDATE gates SET status = \'fix\', round = ? WHERE scope = ? AND "order" = ?')
        .run(newRound, scope, order);
      result = { status: "fix", round: newRound };
    }
  });
  fix();
  return result;
}

function reactivateFixGate(db: BetterSqlite3.Database, scope: string): boolean {
  const gate = db.prepare(
    'SELECT "order" FROM gates WHERE scope = ? AND status = \'fix\' ORDER BY "order" LIMIT 1'
  ).get(scope) as { order: number } | undefined;
  if (!gate) return false;
  db.prepare('UPDATE gates SET status = \'active\' WHERE scope = ? AND "order" = ?').run(scope, gate.order);
  return true;
}

function hasActiveGates(db: BetterSqlite3.Database, scope: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM gates WHERE scope = ? AND status IN ('pending','active','revise','fix') LIMIT 1"
  ).get(scope);
  return !!row;
}

export {
  getDb,
  registerAgent,
  setVerdict,
  getAgent,
  isCleared,
  findAgentScope,
  getPending,
  incrAttempts,
  getAttempts,
  resetAttempts,
  addEdit,
  getEdits,
  getEditCounts,
  addToolHash,
  getLastNHashes,
  migrateFromJson,
  // Gate operations
  initGates,
  getActiveGate,
  getReviseGate,
  getFixGate,
  getGates,
  passGate,
  reviseGate,
  fixGate,
  reactivateReviseGate,
  reactivateFixGate,
  hasActiveGates,
};
