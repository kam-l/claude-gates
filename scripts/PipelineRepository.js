"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PipelineRepository = void 0;
const Enums_1 = require("./types/Enums");
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
class PipelineRepository {
    _db;
    constructor(db) {
        this._db = db;
    }
    static initSchema(db) {
        db.exec(SCHEMA_SQL);
        db.exec(TRIGGER_SQL);
        try {
            db.exec("ALTER TABLE pipeline_state ADD COLUMN trace_id TEXT");
        }
        catch {
        }
    }
    // ── Pipeline CRUD ──────────────────────────────────────────────────
    insertPipeline(scope, sourceAgent, totalSteps) {
        this._db.prepare("INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) VALUES (?, ?, 'normal', 0, ?)").run(scope, sourceAgent, totalSteps);
    }
    insertStep(scope, stepIndex, step, sourceAgent) {
        this._db.prepare("INSERT INTO pipeline_steps (scope, step_index, step_type, prompt, command, allowed_tools, agent, max_rounds, fixer, status, round, source_agent) "
            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)").run(scope, stepIndex, step.type, "prompt" in step ? step.prompt : null, null, null, "agent" in step ? step.agent : null, "maxRounds" in step ? step.maxRounds : 3, "fixer" in step ? step.fixer : null, stepIndex === 0 ? Enums_1.StepStatus.Active : Enums_1.StepStatus.Pending, sourceAgent);
    }
    pipelineExists(scope) {
        return !!this._db.prepare("SELECT 1 FROM pipeline_state WHERE scope = ? LIMIT 1").get(scope);
    }
    getStep(scope, stepIndex) {
        return this._db.prepare("SELECT * FROM pipeline_steps WHERE scope = ? AND step_index = ?").get(scope, stepIndex) || null;
    }
    getActiveStep(scope) {
        return this._db.prepare("SELECT * FROM pipeline_steps WHERE scope = ? AND status = 'active' LIMIT 1").get(scope) || null;
    }
    getStepByStatus(scope, status) {
        return this._db.prepare("SELECT * FROM pipeline_steps WHERE scope = ? AND status = ? ORDER BY step_index LIMIT 1").get(scope, status) || null;
    }
    getSteps(scope) {
        return this._db.prepare("SELECT * FROM pipeline_steps WHERE scope = ? ORDER BY step_index").all(scope);
    }
    getPipelineState(scope) {
        return this._db.prepare("SELECT * FROM pipeline_state WHERE scope = ?").get(scope) || null;
    }
    updateStepStatus(scope, stepIndex, status, round) {
        if (round !== undefined) {
            this._db.prepare("UPDATE pipeline_steps SET status = ?, round = ? WHERE scope = ? AND step_index = ?").run(status, round, scope, stepIndex);
        }
        else {
            this._db.prepare("UPDATE pipeline_steps SET status = ? WHERE scope = ? AND step_index = ?").run(status, scope, stepIndex);
        }
    }
    updatePipelineState(scope, updates) {
        const sets = [];
        const vals = [];
        for (const [key, val,] of Object.entries(updates)) {
            sets.push(`${key} = ?`);
            vals.push(val);
        }
        if (sets.length === 0) {
            return;
        }
        vals.push(scope);
        this._db.prepare(`UPDATE pipeline_state SET ${sets.join(", ")} WHERE scope = ?`).run(...vals);
    }
    deletePipeline(scope) {
        const del = this._db.transaction(() => {
            this._db.prepare("DELETE FROM pipeline_steps WHERE scope = ?").run(scope);
            this._db.prepare("DELETE FROM pipeline_state WHERE scope = ?").run(scope);
        });
        del();
    }
    getActivePipelines() {
        return this._db.prepare("SELECT * FROM pipeline_state WHERE status IN ('normal', 'revision')").all();
    }
    hasNonPassedSteps(scope) {
        return !!this._db.prepare("SELECT 1 FROM pipeline_steps WHERE scope = ? AND status != 'passed' LIMIT 1").get(scope);
    }
    // ── Agent CRUD ─────────────────────────────────────────────────────
    registerAgent(scope, agent, outputFilepath) {
        this._db.prepare("INSERT INTO agents (scope, agent, outputFilepath) VALUES (?, ?, ?) "
            + "ON CONFLICT(scope, agent) DO UPDATE SET outputFilepath = excluded.outputFilepath").run(scope, agent, outputFilepath);
    }
    setVerdict(scope, agent, verdict, round) {
        this._db.prepare("UPDATE agents SET verdict = ?, round = ? WHERE scope = ? AND agent = ?").run(verdict, round, scope, agent);
    }
    getAgent(scope, agent) {
        return this._db.prepare("SELECT * FROM agents WHERE scope = ? AND agent = ?").get(scope, agent) || null;
    }
    isCleared(scope, agent) {
        return !!this._db.prepare("SELECT 1 FROM agents WHERE scope = ? AND agent = ?").get(scope, agent);
    }
    findAgentScope(agent) {
        const row = this._db.prepare("SELECT scope FROM agents WHERE agent = ? AND scope != '_meta' AND scope != '_pending' ORDER BY verdict IS NULL DESC, rowid DESC LIMIT 1").get(agent);
        return row ? row.scope : null;
    }
    getPending(agent) {
        return this._db.prepare("SELECT scope, outputFilepath FROM agents WHERE agent = ? AND scope = '_pending' LIMIT 1").get(agent) || null;
    }
    // ── Edit tracking ──────────────────────────────────────────────────
    addEdit(filepath, lines) {
        this._db.prepare("INSERT INTO edits (filepath, lines) VALUES (?, ?) ON CONFLICT(filepath) DO UPDATE SET lines = lines + excluded.lines").run(filepath, lines || 0);
    }
    getEdits() {
        return this._db.prepare("SELECT filepath FROM edits").all().map((r) => r.filepath);
    }
    getEditCounts() {
        const row = this._db.prepare("SELECT COUNT(*) as files, COALESCE(SUM(lines), 0) as lines FROM edits").get();
        return { files: row.files, lines: row.lines, };
    }
    // ── Tool history ───────────────────────────────────────────────────
    addToolHash(hash) {
        this._db.prepare("INSERT INTO tool_history (hash) VALUES (?)").run(hash);
    }
    getLastNHashes(n) {
        return this._db.prepare("SELECT hash FROM tool_history ORDER BY id DESC LIMIT ?").all(n).map((r) => r.hash);
    }
    // ── Trace support ──────────────────────────────────────────────────
    getTraceId(scope) {
        const row = this._db.prepare("SELECT trace_id FROM pipeline_state WHERE scope = ?").get(scope);
        return row ? row.trace_id : null;
    }
    setTraceId(scope, traceId) {
        this._db.prepare("UPDATE pipeline_state SET trace_id = ? WHERE scope = ?").run(traceId, scope);
    }
    // ── Transaction helper ─────────────────────────────────────────────
    transaction(fn) {
        return this._db.transaction(fn)();
    }
}
exports.PipelineRepository = PipelineRepository;
//# sourceMappingURL=PipelineRepository.js.map