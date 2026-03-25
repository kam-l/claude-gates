#!/usr/bin/env node
/**
 * ClaudeGates v2 — SQLite session state module.
 *
 * 4-table schema: agents, gates, edits, tool_history.
 * Requires better-sqlite3 (native SQLite binding).
 *
 * Exports:
 *   getDb(sessionDir)                              → Database
 *   registerAgent(db, scope, agent, outputFilepath) → void
 *   setVerdict(db, scope, agent, verdict, round)   → void
 *   getAgent(db, scope, agent)                     → row | null
 *   isCleared(db, scope, agent)                    → boolean
 *   findAgentScope(db, agent)                      → string | null
 *   getPending(db, agent)                          → { scope, outputFilepath } | null
 *   incrAttempts(db, scope, agent)                 → void
 *   getAttempts(db, scope, agent)                  → number
 *   resetAttempts(db, scope, agent)                → void
 *   addEdit(db, filepath[, lines])                 → void
 *   getEdits(db)                                   → string[]
 *   getEditCounts(db)                              → { files, lines }
 *   addToolHash(db, hash)                          → void
 *   getLastNHashes(db, n)                          → string[]
 *   migrateFromJson(sessionDir, db)                → void
 *   // Gate operations
 *   initGates(db, scope, sourceAgent, gates)       → void
 *   getActiveGate(db, scope)                       → row | null
 *   getReviseGate(db, scope)                       → row | null
 *   getFixGate(db, scope)                          → row | null
 *   getGates(db, scope)                            → row[]
 *   passGate(db, scope, order)                     → { nextGate, allPassed }
 *   reviseGate(db, scope, order)                   → { status, round } | null
 *   fixGate(db, scope, order)                      → { status, round } | null
 *   reactivateReviseGate(db, scope)                → boolean
 *   reactivateFixGate(db, scope)                   → boolean
 *   hasActiveGates(db, scope)                      → boolean
 */

const fs = require("fs");
const path = require("path");

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  // Installed node_modules live in CLAUDE_PLUGIN_DATA (survives plugin updates).
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

/**
 * Open session DB, create tables, migrate if needed.
 */
function getDb(sessionDir) {
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

/**
 * Migrate old SQLite schema (8 tables) → new (4 tables).
 * Called when old 'scopes' table is detected.
 */
function migrateOldSchema(db) {
  const migrate = db.transaction(() => {
    // Re-check inside transaction (concurrency guard)
    const hasOld = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scopes'"
    ).get();
    if (!hasOld) return;

    // Migrate cleared → agents
    try {
      const rows = db.prepare("SELECT scope, agent, verdict, round FROM cleared").all();
      for (const r of rows) {
        db.prepare(
          "INSERT OR IGNORE INTO agents (scope, agent, verdict, round) VALUES (?, ?, ?, ?)"
        ).run(r.scope, r.agent, r.verdict, r.round);
      }
    } catch {}

    // Migrate pending → agents (update outputFilepath)
    try {
      const rows = db.prepare("SELECT agent, scope, outputFilepath FROM pending").all();
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
      ).all();
      for (const r of rows) {
        db.prepare(
          'INSERT OR IGNORE INTO gates (scope, "order", gate_agent, max_rounds, status, round, source_agent) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(r.scope, r.seq, r.gate_agent, r.max_rounds, r.status, r.round, r.source_agent);
      }
    } catch {}

    // Migrate markers → agents (special rows)
    try {
      const nudge = db.prepare("SELECT value FROM markers WHERE name = 'stop-gate-nudged'").get();
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
      const attempts = db.prepare("SELECT value FROM edit_stats WHERE key = 'plan_gate_attempts'").get();
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

/**
 * One-time import of JSON state into SQLite, inside a transaction.
 */
function migrateFromJson(sessionDir, db) {
  const migrate = db.transaction(() => {
    // Re-check marker inside transaction (handles concurrent hooks)
    const already = db.prepare(
      "SELECT 1 FROM agents WHERE scope = '_meta' AND agent = 'json_migrated'"
    ).get();
    if (already) return;

    // Migrate session_scopes.json
    try {
      const scopesFile = path.join(sessionDir, "session_scopes.json");
      const scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8"));
      for (const [scope, info] of Object.entries(scopes)) {
        if (scope === "_pending") {
          // Migrate pending entries
          if (info && typeof info === "object") {
            for (const [agent, pending] of Object.entries(info)) {
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
          for (const [agent, val] of Object.entries(info.cleared)) {
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

/**
 * Register an agent for a scope. Creates row or updates outputFilepath.
 * Does NOT overwrite verdict/round — preserves existing verdicts on re-spawn.
 */
function registerAgent(db, scope, agent, outputFilepath) {
  db.prepare(
    "INSERT INTO agents (scope, agent, outputFilepath) VALUES (?, ?, ?) " +
    "ON CONFLICT(scope, agent) DO UPDATE SET outputFilepath = excluded.outputFilepath"
  ).run(scope, agent, outputFilepath);
}

/**
 * Record a structured verdict. Creates row if missing.
 */
function setVerdict(db, scope, agent, verdict, round) {
  db.prepare(
    "INSERT INTO agents (scope, agent, verdict, round) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(scope, agent) DO UPDATE SET verdict = excluded.verdict, round = excluded.round"
  ).run(scope, agent, verdict, round);
}

/**
 * Get full agent row. Returns null if not found.
 */
function getAgent(db, scope, agent) {
  return db.prepare(
    "SELECT scope, agent, outputFilepath, verdict, round, attempts FROM agents WHERE scope = ? AND agent = ?"
  ).get(scope, agent) || null;
}

/**
 * Check if agent is registered (row exists).
 */
function isCleared(db, scope, agent) {
  const row = db.prepare("SELECT 1 FROM agents WHERE scope = ? AND agent = ?").get(scope, agent);
  return !!row;
}

/**
 * Find which scope an agent is registered in (excludes system scopes starting with _).
 */
function findAgentScope(db, agent) {
  // Prefer entries with no verdict (just spawned, not yet completed).
  // Among those, take the most recently inserted (highest rowid).
  const row = db.prepare(
    "SELECT scope FROM agents WHERE agent = ? AND SUBSTR(scope, 1, 1) != '_' ORDER BY CASE WHEN verdict IS NULL THEN 0 ELSE 1 END, rowid DESC LIMIT 1"
  ).get(agent);
  return row ? row.scope : null;
}

/**
 * Get pending info (scope + outputFilepath) for an agent.
 * Excludes system scopes.
 */
function getPending(db, agent) {
  // For parallel pipelines, the same agent_type may exist in multiple scopes.
  // Prefer entries with no verdict (just spawned, not yet completed).
  // Among those, take the most recently inserted (highest rowid).
  // This is safe because registerAgent is called sequentially per spawn,
  // and SubagentStart fires after PreToolUse:Agent for the same spawn.
  const row = db.prepare(
    "SELECT scope, outputFilepath FROM agents WHERE agent = ? AND outputFilepath IS NOT NULL AND SUBSTR(scope, 1, 1) != '_' ORDER BY CASE WHEN verdict IS NULL THEN 0 ELSE 1 END, rowid DESC LIMIT 1"
  ).get(agent);
  return row || null;
}

/**
 * Increment attempts counter for an agent. Creates row if missing.
 */
function incrAttempts(db, scope, agent) {
  db.prepare(
    "INSERT INTO agents (scope, agent, attempts) VALUES (?, ?, 1) " +
    "ON CONFLICT(scope, agent) DO UPDATE SET attempts = attempts + 1"
  ).run(scope, agent);
}

/**
 * Get attempts counter for an agent.
 */
function getAttempts(db, scope, agent) {
  const row = db.prepare("SELECT attempts FROM agents WHERE scope = ? AND agent = ?").get(scope, agent);
  return row ? row.attempts : 0;
}

/**
 * Reset attempts counter for an agent.
 */
function resetAttempts(db, scope, agent) {
  db.prepare(
    "INSERT INTO agents (scope, agent, attempts) VALUES (?, ?, 0) " +
    "ON CONFLICT(scope, agent) DO UPDATE SET attempts = 0"
  ).run(scope, agent);
}

// ── Edit tracking ─────────────────────────────────────────────────────

/**
 * Track an edited file. If lines provided, updates lines count.
 * Without lines, INSERT OR IGNORE (no-op on existing).
 */
function addEdit(db, filepath, lines) {
  if (lines != null) {
    db.prepare(
      "INSERT INTO edits (filepath, lines) VALUES (?, ?) ON CONFLICT(filepath) DO UPDATE SET lines = excluded.lines"
    ).run(filepath, lines);
  } else {
    db.prepare("INSERT OR IGNORE INTO edits (filepath) VALUES (?)").run(filepath);
  }
}

function getEdits(db) {
  const rows = db.prepare("SELECT filepath FROM edits").all();
  return rows.map(r => r.filepath);
}

/**
 * Get aggregate edit counts: { files, lines }.
 */
function getEditCounts(db) {
  const row = db.prepare(
    "SELECT COUNT(*) as files, COALESCE(SUM(lines), 0) as lines FROM edits"
  ).get();
  return { files: row.files, lines: row.lines };
}

// ── Tool history (ring buffer) ────────────────────────────────────────

function addToolHash(db, hash) {
  db.prepare("INSERT INTO tool_history (hash) VALUES (?)").run(hash);
}

function getLastNHashes(db, n) {
  const rows = db.prepare("SELECT hash FROM tool_history ORDER BY id DESC LIMIT ?").all(n);
  return rows.map(r => r.hash).reverse();
}

// ── Gate operations ───────────────────────────────────────────────────

/**
 * Initialize gates for a scope. Called when source agent first completes.
 * Inserts all gates as pending, sets first to active.
 * No-op if gates already exist for this scope.
 */
function initGates(db, scope, sourceAgent, gates) {
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

/**
 * Get the currently active gate for a scope.
 */
function getActiveGate(db, scope) {
  return db.prepare(
    'SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? AND status = \'active\' LIMIT 1'
  ).get(scope) || null;
}

/**
 * Get a gate in 'revise' status for a scope.
 */
function getReviseGate(db, scope) {
  return db.prepare(
    'SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? AND status = \'revise\' LIMIT 1'
  ).get(scope) || null;
}

/**
 * Get all gates for a scope, ordered by "order".
 */
function getGates(db, scope) {
  return db.prepare(
    'SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? ORDER BY "order"'
  ).all(scope);
}

/**
 * Transition a gate to 'passed' and activate the next gate (if any).
 * Returns { nextGate: row | null, allPassed: boolean }.
 */
function passGate(db, scope, order) {
  const result = { nextGate: null, allPassed: false };
  const pass = db.transaction(() => {
    db.prepare('UPDATE gates SET status = \'passed\' WHERE scope = ? AND "order" = ?').run(scope, order);
    const next = db.prepare(
      'SELECT "order" FROM gates WHERE scope = ? AND "order" > ? AND status = \'pending\' ORDER BY "order" LIMIT 1'
    ).get(scope, order);
    if (next) {
      db.prepare('UPDATE gates SET status = \'active\' WHERE scope = ? AND "order" = ?').run(scope, next.order);
      result.nextGate = db.prepare(
        'SELECT "order", gate_agent, max_rounds, status, round, source_agent FROM gates WHERE scope = ? AND "order" = ?'
      ).get(scope, next.order);
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

/**
 * Set a gate to 'revise' status and increment round.
 * If round >= maxRounds, set to 'failed' instead.
 */
function reviseGate(db, scope, order) {
  let result = null;
  const revise = db.transaction(() => {
    const gate = db.prepare(
      'SELECT round, max_rounds FROM gates WHERE scope = ? AND "order" = ?'
    ).get(scope, order);
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

/**
 * Reactivate a gate that was in 'revise' status (after source agent re-completes).
 * Returns true if a gate was reactivated.
 */
function reactivateReviseGate(db, scope) {
  const gate = db.prepare(
    'SELECT "order" FROM gates WHERE scope = ? AND status = \'revise\' ORDER BY "order" LIMIT 1'
  ).get(scope);
  if (!gate) return false;
  db.prepare('UPDATE gates SET status = \'active\' WHERE scope = ? AND "order" = ?').run(scope, gate.order);
  return true;
}

/**
 * Get a gate in 'fix' status for a scope (fixer is working).
 */
function getFixGate(db, scope) {
  return db.prepare(
    'SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? AND status = \'fix\' LIMIT 1'
  ).get(scope) || null;
}

/**
 * Set a gate to 'fix' status (fixer handles revision) and increment round.
 * If round >= maxRounds, set to 'failed' instead.
 * Called INSTEAD of reviseGate() when fixer is defined.
 */
function fixGate(db, scope, order) {
  let result = null;
  const fix = db.transaction(() => {
    const gate = db.prepare(
      'SELECT round, max_rounds FROM gates WHERE scope = ? AND "order" = ?'
    ).get(scope, order);
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

/**
 * Reactivate a gate from 'fix' status (after fixer agent completes).
 * Returns true if a gate was reactivated.
 */
function reactivateFixGate(db, scope) {
  const gate = db.prepare(
    'SELECT "order" FROM gates WHERE scope = ? AND status = \'fix\' ORDER BY "order" LIMIT 1'
  ).get(scope);
  if (!gate) return false;
  db.prepare('UPDATE gates SET status = \'active\' WHERE scope = ? AND "order" = ?').run(scope, gate.order);
  return true;
}

/**
 * Check if scope has any non-terminal gates (pending, active, revise, fix).
 */
function hasActiveGates(db, scope) {
  const row = db.prepare(
    "SELECT 1 FROM gates WHERE scope = ? AND status IN ('pending','active','revise','fix') LIMIT 1"
  ).get(scope);
  return !!row;
}

module.exports = {
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
  hasActiveGates
};
