#!/usr/bin/env node
"use strict";
/**
 * ClaudeGates v2 — SQLite session state module.
 *
 * 4-table schema: agents, gates, edits, tool_history.
 * Requires better-sqlite3 (native SQLite binding).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.registerAgent = registerAgent;
exports.setVerdict = setVerdict;
exports.getAgent = getAgent;
exports.isCleared = isCleared;
exports.findAgentScope = findAgentScope;
exports.getPending = getPending;
exports.incrAttempts = incrAttempts;
exports.getAttempts = getAttempts;
exports.resetAttempts = resetAttempts;
exports.addEdit = addEdit;
exports.getEdits = getEdits;
exports.getEditCounts = getEditCounts;
exports.addToolHash = addToolHash;
exports.getLastNHashes = getLastNHashes;
exports.migrateFromJson = migrateFromJson;
exports.initGates = initGates;
exports.getActiveGate = getActiveGate;
exports.getReviseGate = getReviseGate;
exports.getFixGate = getFixGate;
exports.getGates = getGates;
exports.passGate = passGate;
exports.reviseGate = reviseGate;
exports.fixGate = fixGate;
exports.reactivateReviseGate = reactivateReviseGate;
exports.reactivateFixGate = reactivateFixGate;
exports.hasActiveGates = hasActiveGates;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
let Database;
try {
    Database = require("better-sqlite3");
}
catch {
    // Installed node_modules live in CLAUDE_PLUGIN_DATA (survives plugin updates).
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    let loadError;
    if (dataDir) {
        try {
            Database = require(path_1.default.join(dataDir, "node_modules", "better-sqlite3"));
        }
        catch (e) {
            loadError = e;
        }
    }
    if (!Database) {
        const pluginDir = __dirname.replace(/[\\/]scripts$/, "");
        const isAbiMismatch = loadError && /NODE_MODULE_VERSION|was compiled against/.test(loadError.message);
        const hint = isAbiMismatch
            ? "ABI mismatch — rebuild with: cd \"" + dataDir + "\" && npm rebuild better-sqlite3"
            : "Run \"npm install\" in the plugin data directory.";
        process.stderr.write(`[ClaudeGates] ❌ better-sqlite3 failed to load. ${hint}\n` +
            `  Plugin path: ${pluginDir}\n` +
            `  Data dir: ${dataDir || "(CLAUDE_PLUGIN_DATA not set)"}\n` +
            (loadError ? `  Error: ${loadError.message}\n` : ""));
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
function getDb(sessionDir) {
    if (!fs_1.default.existsSync(sessionDir)) {
        fs_1.default.mkdirSync(sessionDir, { recursive: true });
    }
    const dbPath = path_1.default.join(sessionDir, "session.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    // Create tables (no-op if they exist)
    db.exec(SCHEMA_SQL);
    db.exec(TRIGGER_SQL);
    // Upgrade edits table from old schema (add lines column if missing)
    try {
        db.prepare("SELECT lines FROM edits LIMIT 0").get();
    }
    catch {
        try {
            db.exec("ALTER TABLE edits ADD COLUMN lines INTEGER NOT NULL DEFAULT 0");
        }
        catch { }
    }
    // Upgrade gates table (add fixer_agent column if missing)
    try {
        db.prepare("SELECT fixer_agent FROM gates LIMIT 0").get();
    }
    catch {
        try {
            db.exec("ALTER TABLE gates ADD COLUMN fixer_agent TEXT");
        }
        catch { }
    }
    // Migrate old SQLite schema → new (if old tables exist)
    const hasOldScopes = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scopes'").get();
    if (hasOldScopes) {
        migrateOldSchema(db);
    }
    // Check JSON migration marker (now stored in agents table)
    const hasMigrated = db.prepare("SELECT 1 FROM agents WHERE scope = '_meta' AND agent = 'json_migrated'").get();
    if (!hasMigrated) {
        const scopesFile = path_1.default.join(sessionDir, "session_scopes.json");
        const editsFile = path_1.default.join(sessionDir, "edits.log");
        const historyFile = path_1.default.join(sessionDir, "tool_history.json");
        const markerFile = path_1.default.join(sessionDir, ".stop-gate-nudged");
        const hasOldFiles = fs_1.default.existsSync(scopesFile) || fs_1.default.existsSync(editsFile) ||
            fs_1.default.existsSync(historyFile) || fs_1.default.existsSync(markerFile);
        if (hasOldFiles) {
            migrateFromJson(sessionDir, db);
        }
    }
    return db;
}
function migrateOldSchema(db) {
    const migrate = db.transaction(() => {
        // Re-check inside transaction (concurrency guard)
        const hasOld = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scopes'").get();
        if (!hasOld)
            return;
        // Migrate cleared → agents
        try {
            const rows = db.prepare("SELECT scope, agent, verdict, round FROM cleared").all();
            for (const r of rows) {
                db.prepare("INSERT OR IGNORE INTO agents (scope, agent, verdict, round) VALUES (?, ?, ?, ?)").run(r.scope, r.agent, r.verdict, r.round);
            }
        }
        catch { }
        // Migrate pending → agents (update outputFilepath)
        try {
            const rows = db.prepare("SELECT agent, scope, outputFilepath FROM pending").all();
            for (const r of rows) {
                db.prepare("INSERT INTO agents (scope, agent, outputFilepath) VALUES (?, ?, ?) " +
                    "ON CONFLICT(scope, agent) DO UPDATE SET outputFilepath = excluded.outputFilepath").run(r.scope, r.agent, r.outputFilepath);
            }
        }
        catch { }
        // Migrate scope_gates → gates
        try {
            const rows = db.prepare("SELECT scope, seq, gate_agent, max_rounds, status, round, source_agent FROM scope_gates").all();
            for (const r of rows) {
                db.prepare('INSERT OR IGNORE INTO gates (scope, "order", gate_agent, max_rounds, status, round, source_agent) ' +
                    "VALUES (?, ?, ?, ?, ?, ?, ?)").run(r.scope, r.seq, r.gate_agent, r.max_rounds, r.status, r.round, r.source_agent);
            }
        }
        catch { }
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
        }
        catch { }
        // Migrate edit_stats → agents (plan_gate_attempts)
        try {
            const attempts = db.prepare("SELECT value FROM edit_stats WHERE key = 'plan_gate_attempts'").get();
            if (attempts) {
                db.prepare("INSERT INTO agents (scope, agent, attempts) VALUES ('_system', 'plan-gate', ?) " +
                    "ON CONFLICT(scope, agent) DO UPDATE SET attempts = excluded.attempts").run(attempts.value);
            }
        }
        catch { }
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
function migrateFromJson(sessionDir, db) {
    const migrate = db.transaction(() => {
        // Re-check marker inside transaction (handles concurrent hooks)
        const already = db.prepare("SELECT 1 FROM agents WHERE scope = '_meta' AND agent = 'json_migrated'").get();
        if (already)
            return;
        // Migrate session_scopes.json
        try {
            const scopesFile = path_1.default.join(sessionDir, "session_scopes.json");
            const scopes = JSON.parse(fs_1.default.readFileSync(scopesFile, "utf-8"));
            for (const [scope, info] of Object.entries(scopes)) {
                if (scope === "_pending") {
                    // Migrate pending entries
                    if (info && typeof info === "object") {
                        for (const [agent, pending] of Object.entries(info)) {
                            if (pending && pending.outputFilepath) {
                                db.prepare("INSERT INTO agents (scope, agent, outputFilepath) VALUES (?, ?, ?) " +
                                    "ON CONFLICT(scope, agent) DO UPDATE SET outputFilepath = excluded.outputFilepath").run(pending.scope || "", agent, pending.outputFilepath);
                            }
                        }
                    }
                    continue;
                }
                if (info && info.cleared) {
                    for (const [agent, val] of Object.entries(info.cleared)) {
                        if (val && typeof val === "object") {
                            db.prepare("INSERT OR IGNORE INTO agents (scope, agent, verdict, round) VALUES (?, ?, ?, ?)").run(scope, agent, val.verdict || null, val.round || null);
                        }
                        else {
                            // boolean true — cleared with no verdict
                            db.prepare("INSERT OR IGNORE INTO agents (scope, agent) VALUES (?, ?)").run(scope, agent);
                        }
                    }
                }
            }
        }
        catch { } // missing or invalid — skip
        // Migrate edits.log
        try {
            const editsFile = path_1.default.join(sessionDir, "edits.log");
            const content = fs_1.default.readFileSync(editsFile, "utf-8");
            for (const line of content.split("\n")) {
                const trimmed = line.trim();
                if (trimmed) {
                    db.prepare("INSERT OR IGNORE INTO edits (filepath) VALUES (?)").run(trimmed);
                }
            }
        }
        catch { } // missing — skip
        // Migrate tool_history.json
        try {
            const historyFile = path_1.default.join(sessionDir, "tool_history.json");
            const history = JSON.parse(fs_1.default.readFileSync(historyFile, "utf-8"));
            if (Array.isArray(history)) {
                for (const hash of history) {
                    db.prepare("INSERT INTO tool_history (hash) VALUES (?)").run(hash);
                }
            }
        }
        catch { } // missing — skip
        // Migrate .stop-gate-nudged marker
        try {
            const markerFile = path_1.default.join(sessionDir, ".stop-gate-nudged");
            if (fs_1.default.existsSync(markerFile)) {
                db.prepare("INSERT OR IGNORE INTO agents (scope, agent) VALUES ('_nudge', 'stop-gate')").run();
            }
        }
        catch { } // missing — skip
        // Set migration marker
        db.prepare("INSERT OR IGNORE INTO agents (scope, agent) VALUES ('_meta', 'json_migrated')").run();
    });
    migrate();
}
// ── Agent operations ──────────────────────────────────────────────────
function registerAgent(db, scope, agent, outputFilepath) {
    db.prepare("INSERT INTO agents (scope, agent, outputFilepath) VALUES (?, ?, ?) " +
        "ON CONFLICT(scope, agent) DO UPDATE SET outputFilepath = excluded.outputFilepath").run(scope, agent, outputFilepath);
}
function setVerdict(db, scope, agent, verdict, round) {
    db.prepare("INSERT INTO agents (scope, agent, verdict, round) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(scope, agent) DO UPDATE SET verdict = excluded.verdict, round = excluded.round").run(scope, agent, verdict, round);
}
function getAgent(db, scope, agent) {
    return db.prepare("SELECT scope, agent, outputFilepath, verdict, round, attempts FROM agents WHERE scope = ? AND agent = ?").get(scope, agent) || null;
}
function isCleared(db, scope, agent) {
    const row = db.prepare("SELECT 1 FROM agents WHERE scope = ? AND agent = ?").get(scope, agent);
    return !!row;
}
function findAgentScope(db, agent) {
    const row = db.prepare("SELECT scope FROM agents WHERE agent = ? AND SUBSTR(scope, 1, 1) != '_' ORDER BY CASE WHEN verdict IS NULL THEN 0 ELSE 1 END, rowid DESC LIMIT 1").get(agent);
    return row ? row.scope : null;
}
function getPending(db, agent) {
    const row = db.prepare("SELECT scope, outputFilepath FROM agents WHERE agent = ? AND outputFilepath IS NOT NULL AND SUBSTR(scope, 1, 1) != '_' ORDER BY CASE WHEN verdict IS NULL THEN 0 ELSE 1 END, rowid DESC LIMIT 1").get(agent);
    return row || null;
}
function incrAttempts(db, scope, agent) {
    db.prepare("INSERT INTO agents (scope, agent, attempts) VALUES (?, ?, 1) " +
        "ON CONFLICT(scope, agent) DO UPDATE SET attempts = attempts + 1").run(scope, agent);
}
function getAttempts(db, scope, agent) {
    const row = db.prepare("SELECT attempts FROM agents WHERE scope = ? AND agent = ?").get(scope, agent);
    return row ? row.attempts : 0;
}
function resetAttempts(db, scope, agent) {
    db.prepare("INSERT INTO agents (scope, agent, attempts) VALUES (?, ?, 0) " +
        "ON CONFLICT(scope, agent) DO UPDATE SET attempts = 0").run(scope, agent);
}
// ── Edit tracking ─────────────────────────────────────────────────────
function addEdit(db, filepath, lines) {
    if (lines != null) {
        db.prepare("INSERT INTO edits (filepath, lines) VALUES (?, ?) ON CONFLICT(filepath) DO UPDATE SET lines = excluded.lines").run(filepath, lines);
    }
    else {
        db.prepare("INSERT OR IGNORE INTO edits (filepath) VALUES (?)").run(filepath);
    }
}
function getEdits(db) {
    const rows = db.prepare("SELECT filepath FROM edits").all();
    return rows.map(r => r.filepath);
}
function getEditCounts(db) {
    const row = db.prepare("SELECT COUNT(*) as files, COALESCE(SUM(lines), 0) as lines FROM edits").get();
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
function initGates(db, scope, sourceAgent, gates) {
    const init = db.transaction(() => {
        const existing = db.prepare("SELECT 1 FROM gates WHERE scope = ? LIMIT 1").get(scope);
        if (existing)
            return;
        for (let i = 0; i < gates.length; i++) {
            const status = i === 0 ? "active" : "pending";
            db.prepare('INSERT INTO gates (scope, "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(scope, i, gates[i].agent, gates[i].maxRounds, status, sourceAgent, gates[i].fixer || null);
        }
    });
    init();
}
function getActiveGate(db, scope) {
    return db.prepare('SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? AND status = \'active\' LIMIT 1').get(scope) || null;
}
function getReviseGate(db, scope) {
    return db.prepare('SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? AND status = \'revise\' LIMIT 1').get(scope) || null;
}
function getGates(db, scope) {
    return db.prepare('SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? ORDER BY "order"').all(scope);
}
function passGate(db, scope, order) {
    const result = { nextGate: null, allPassed: false };
    const pass = db.transaction(() => {
        db.prepare('UPDATE gates SET status = \'passed\' WHERE scope = ? AND "order" = ?').run(scope, order);
        const next = db.prepare('SELECT "order" FROM gates WHERE scope = ? AND "order" > ? AND status = \'pending\' ORDER BY "order" LIMIT 1').get(scope, order);
        if (next) {
            db.prepare('UPDATE gates SET status = \'active\' WHERE scope = ? AND "order" = ?').run(scope, next.order);
            result.nextGate = db.prepare('SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? AND "order" = ?').get(scope, next.order) || null;
        }
        else {
            const nonPassed = db.prepare("SELECT 1 FROM gates WHERE scope = ? AND status != 'passed' LIMIT 1").get(scope);
            result.allPassed = !nonPassed;
        }
    });
    pass();
    return result;
}
function reviseGate(db, scope, order) {
    let result = null;
    const revise = db.transaction(() => {
        const gate = db.prepare('SELECT round, max_rounds FROM gates WHERE scope = ? AND "order" = ?').get(scope, order);
        if (!gate)
            return;
        const newRound = gate.round + 1;
        if (newRound >= gate.max_rounds) {
            db.prepare('UPDATE gates SET status = \'failed\', round = ? WHERE scope = ? AND "order" = ?')
                .run(newRound, scope, order);
            result = { status: "failed", round: newRound };
        }
        else {
            db.prepare('UPDATE gates SET status = \'revise\', round = ? WHERE scope = ? AND "order" = ?')
                .run(newRound, scope, order);
            result = { status: "revise", round: newRound };
        }
    });
    revise();
    return result;
}
function reactivateReviseGate(db, scope) {
    const gate = db.prepare('SELECT "order" FROM gates WHERE scope = ? AND status = \'revise\' ORDER BY "order" LIMIT 1').get(scope);
    if (!gate)
        return false;
    db.prepare('UPDATE gates SET status = \'active\' WHERE scope = ? AND "order" = ?').run(scope, gate.order);
    return true;
}
function getFixGate(db, scope) {
    return db.prepare('SELECT "order", gate_agent, max_rounds, status, round, source_agent, fixer_agent FROM gates WHERE scope = ? AND status = \'fix\' LIMIT 1').get(scope) || null;
}
function fixGate(db, scope, order) {
    let result = null;
    const fix = db.transaction(() => {
        const gate = db.prepare('SELECT round, max_rounds FROM gates WHERE scope = ? AND "order" = ?').get(scope, order);
        if (!gate)
            return;
        const newRound = gate.round + 1;
        if (newRound >= gate.max_rounds) {
            db.prepare('UPDATE gates SET status = \'failed\', round = ? WHERE scope = ? AND "order" = ?')
                .run(newRound, scope, order);
            result = { status: "failed", round: newRound };
        }
        else {
            db.prepare('UPDATE gates SET status = \'fix\', round = ? WHERE scope = ? AND "order" = ?')
                .run(newRound, scope, order);
            result = { status: "fix", round: newRound };
        }
    });
    fix();
    return result;
}
function reactivateFixGate(db, scope) {
    const gate = db.prepare('SELECT "order" FROM gates WHERE scope = ? AND status = \'fix\' ORDER BY "order" LIMIT 1').get(scope);
    if (!gate)
        return false;
    db.prepare('UPDATE gates SET status = \'active\' WHERE scope = ? AND "order" = ?').run(scope, gate.order);
    return true;
}
function hasActiveGates(db, scope) {
    const row = db.prepare("SELECT 1 FROM gates WHERE scope = ? AND status IN ('pending','active','revise','fix') LIMIT 1").get(scope);
    return !!row;
}
//# sourceMappingURL=claude-gates-db.js.map