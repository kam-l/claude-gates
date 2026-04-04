"use strict";
/**
 * Gate-specific DB operations — plan-gate attempts and MCP verdict storage.
 *
 * Shares the `agents` table with PipelineRepository (single DDL source in
 * PipelineRepository.initSchema). This class adds plan-gate-specific operations
 * (attempts tracking) and the upsert variant of setVerdict for MCP verdicts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GateRepository = void 0;
const PipelineRepository_1 = require("./PipelineRepository");
const SessionManager_1 = require("./SessionManager");
class GateRepository {
    _db;
    constructor(db) {
        this._db = db;
    }
    static createDb(sessionDir) {
        const db = SessionManager_1.SessionManager.openDatabase(sessionDir);
        PipelineRepository_1.PipelineRepository.initSchema(db);
        return db;
    }
    getAttempts(scope, agent) {
        const row = this._db.prepare("SELECT attempts FROM agents WHERE scope = ? AND agent = ?").get(scope, agent);
        return row ? row.attempts : 0;
    }
    incrAttempts(scope, agent) {
        this._db.prepare("INSERT INTO agents (scope, agent, attempts) VALUES (?, ?, 1) "
            + "ON CONFLICT(scope, agent) DO UPDATE SET attempts = attempts + 1").run(scope, agent);
    }
    resetAttempts(scope, agent) {
        this._db.prepare("INSERT INTO agents (scope, agent, attempts) VALUES (?, ?, 0) "
            + "ON CONFLICT(scope, agent) DO UPDATE SET attempts = 0").run(scope, agent);
    }
    setVerdict(scope, agent, verdict, round) {
        this._db.prepare("INSERT INTO agents (scope, agent, verdict, round) VALUES (?, ?, ?, ?) "
            + "ON CONFLICT(scope, agent) DO UPDATE SET verdict = excluded.verdict, round = excluded.round").run(scope, agent, verdict, round);
    }
}
exports.GateRepository = GateRepository;
//# sourceMappingURL=GateRepository.js.map