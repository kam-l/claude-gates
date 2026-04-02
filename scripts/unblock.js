#!/usr/bin/env node
"use strict";
/**
 * Nuclear pipeline unblock — force-completes all stuck pipelines and clears markers.
 *
 * Usage (from within a Claude Code session):
 *   ! node ${CLAUDE_PLUGIN_ROOT}/scripts/unblock.js [session-id] [scope]
 *
 *   No args     → auto-detect session from .sessions/, nuke all active pipelines
 *   session-id  → specific session, nuke all
 *   scope       → nuke only that scope
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const pipeline_db_1 = require("./pipeline-db");
const pipeline_shared_1 = require("./pipeline-shared");
const args = process.argv.slice(2);
// ── Resolve session dir ─────────────────────────────────────────────
function findSessionDir() {
    const sessionsRoot = path_1.default.join(process.cwd(), ".sessions");
    if (!fs_1.default.existsSync(sessionsRoot))
        return null;
    // If session ID provided, use it
    if (args[0]) {
        const dir = (0, pipeline_shared_1.getSessionDir)(args[0]);
        if (fs_1.default.existsSync(path_1.default.join(dir, "session.db")))
            return dir;
        // Try raw arg as directory name
        const raw = path_1.default.join(sessionsRoot, args[0]);
        if (fs_1.default.existsSync(path_1.default.join(raw, "session.db")))
            return raw;
        console.error(`No session.db found for "${args[0]}"`);
        return null;
    }
    // Auto-detect: find most recent session.db
    let best = null;
    for (const entry of fs_1.default.readdirSync(sessionsRoot)) {
        const dbPath = path_1.default.join(sessionsRoot, entry, "session.db");
        try {
            const stat = fs_1.default.statSync(dbPath);
            if (!best || stat.mtimeMs > best.mtime) {
                best = { dir: path_1.default.join(sessionsRoot, entry), mtime: stat.mtimeMs };
            }
        }
        catch { }
    }
    return best ? best.dir : null;
}
const sessionDir = findSessionDir();
if (!sessionDir) {
    console.error("No session found. Usage: node unblock.js [session-id] [scope]");
    process.exit(1);
}
const scope = args[1] || null;
console.log(`Session: ${sessionDir}`);
if (scope)
    console.log(`Scope:   ${scope}`);
// ── Nuke ────────────────────────────────────────────────────────────
const db = (0, pipeline_db_1.getDb)(sessionDir);
if (!db) {
    console.error("Failed to open DB");
    process.exit(1);
}
try {
    const scopeFilter = scope ? ` WHERE scope = '${scope}'` : "";
    const stuckFilter = scope
        ? ` WHERE scope = '${scope}'`
        : ` WHERE status IN ('normal', 'revision')`;
    // Snapshot before nuke
    let stuckPipelines = [];
    let stuckSteps = [];
    try {
        stuckPipelines = db.prepare(`SELECT scope, status, current_step FROM pipeline_state${stuckFilter}`).all();
        stuckSteps = db.prepare(`SELECT scope, step_index, step_type, status, agent, round FROM pipeline_steps WHERE status IN ('active','revise','fix')` +
            (scope ? ` AND scope = '${scope}'` : "")).all();
    }
    catch { }
    if (stuckPipelines.length === 0 && stuckSteps.length === 0) {
        console.log("Nothing stuck.");
        db.close();
        process.exit(0);
    }
    // Print what we're nuking
    console.log(`\nNuking ${stuckPipelines.length} pipeline(s):`);
    for (const p of stuckPipelines) {
        console.log(`  ${p.scope}: status=${p.status} step=${p.current_step}`);
    }
    for (const s of stuckSteps) {
        console.log(`  ${s.scope}/step${s.step_index} (${s.step_type}): ${s.status} agent=${s.agent || '-'} round=${s.round}`);
    }
    // Nuclear delete
    const txn = db.transaction(() => {
        const scopes = stuckPipelines.map((p) => p.scope);
        for (const s of scopes) {
            db.prepare("DELETE FROM pipeline_steps WHERE scope = ?").run(s);
            db.prepare("DELETE FROM pipeline_state WHERE scope = ?").run(s);
            db.prepare("DELETE FROM agents WHERE scope = ?").run(s);
        }
        // Also nuke v2 gates if table exists
        try {
            db.prepare("DELETE FROM gates WHERE status IN ('active','revise','fix')").run();
        }
        catch { }
    });
    txn();
    console.log("Pipelines deleted.");
    // Clean running markers
    let markers = 0;
    try {
        for (const f of fs_1.default.readdirSync(sessionDir)) {
            if (f.startsWith(".running-")) {
                fs_1.default.unlinkSync(path_1.default.join(sessionDir, f));
                markers++;
            }
        }
    }
    catch { }
    // Clean pending scope markers
    try {
        for (const f of fs_1.default.readdirSync(sessionDir)) {
            if (f.startsWith(".pending-scope-")) {
                fs_1.default.unlinkSync(path_1.default.join(sessionDir, f));
                markers++;
            }
        }
    }
    catch { }
    // Drain notification file
    try {
        const notifPath = path_1.default.join(sessionDir, ".notifications");
        if (fs_1.default.existsSync(notifPath)) {
            fs_1.default.unlinkSync(notifPath);
            markers++;
        }
    }
    catch { }
    if (markers > 0)
        console.log(`Cleaned ${markers} marker/notification file(s).`);
    console.log("\nUnblocked. Retry your action.");
}
finally {
    db.close();
}
//# sourceMappingURL=unblock.js.map