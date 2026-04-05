#!/usr/bin/env node
"use strict";
/**
 * ClaudeGates v2 — PreToolUse:ExitPlanMode gate.
 *
 * Blocks ExitPlanMode until plan has been verified by gater agent.
 *
 * Allows if:
 *   - gater agent has a PASS or CONVERGED verdict in SQLite, OR
 *   - most recent .md in ~/.claude/plans/ is <=20 lines (trivial plan), OR
 *   - plans dir is absent (fail-open), OR
 *   - plan_gate_attempts >= MAX_ATTEMPTS (safety valve)
 *
 * Verdict-based: reads gater verdicts from the agents table (SQLite).
 *
 * Fail-open.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onExitPlanMode = onExitPlanMode;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const GateRepository_1 = require("./GateRepository");
const SessionManager_1 = require("./SessionManager");
const TRIVIAL_LINE_LIMIT = 20;
const MAX_ATTEMPTS = 3;
function onExitPlanMode(data) {
    if (SessionManager_1.SessionManager.isGateDisabled()) {
        process.exit(0);
    }
    const sessionId = data.session_id || "";
    if (!sessionId) {
        process.exit(0);
    }
    const HOME = process.env.USERPROFILE || process.env.HOME || "";
    const sessionDir = SessionManager_1.SessionManager.getSessionDir(sessionId);
    const plansDir = path_1.default.join(HOME, ".claude", "plans");
    // ── Check for gater verdict (SQLite) ──
    let gaterVerified = false;
    let db = null;
    try {
        db = GateRepository_1.GateRepository.createDb(sessionDir);
        const row = db.prepare("SELECT 1 FROM agents WHERE agent = 'gater' AND verdict IN ('PASS','CONVERGED') LIMIT 1").get();
        gaterVerified = !!row;
    }
    catch {
    }
    finally {
        db?.close();
        db = null;
    }
    if (gaterVerified) {
        process.exit(0); // verified — allow
    }
    // ── Trivial plan bypass ──
    let planFiles;
    try {
        planFiles = fs_1.default.readdirSync(plansDir)
            .filter(f => f.endsWith(".md") && !/-agent-/.test(f))
            .map(f => ({ name: f, mtime: fs_1.default.statSync(path_1.default.join(plansDir, f)).mtimeMs, }))
            .sort((a, b) => b.mtime - a.mtime);
    }
    catch {
        process.exit(0); // no plans dir — fail-open
    }
    if (planFiles.length === 0) {
        process.exit(0); // no plans — allow
    }
    const planPath = path_1.default.join(plansDir, planFiles[0].name);
    const lines = fs_1.default.readFileSync(planPath, "utf-8").split("\n").length;
    if (lines <= TRIVIAL_LINE_LIMIT) {
        process.exit(0); // trivial plan — allow
    }
    // ── Attempt tracking — auto-allow after MAX_ATTEMPTS ──
    let safetyValve = false;
    try {
        db = GateRepository_1.GateRepository.createDb(sessionDir);
        const gateRepo = new GateRepository_1.GateRepository(db);
        gateRepo.incrAttempts("_system", "plan-gate");
        const attempts = gateRepo.getAttempts("_system", "plan-gate");
        if (attempts >= MAX_ATTEMPTS) {
            gateRepo.resetAttempts("_system", "plan-gate");
            safetyValve = true;
        }
    }
    finally {
        db?.close();
    }
    if (safetyValve) {
        process.stderr.write(`[ClaudeGates] ⚠️ Safety valve activated.\n`);
        process.exit(0);
    }
    // ── Block ──
    const reason = `[ClaudeGates] 🔐 "${planFiles[0].name}" (${lines} lines) unverified. Spawn claude-gates:gater with scope=verify-plan.`;
    process.stdout.write(JSON.stringify({ decision: "block", reason, }));
    process.exit(0);
}
// ── Entry point (thin wrapper) ──────────────────────────────────────
try {
    onExitPlanMode(JSON.parse(fs_1.default.readFileSync(0, "utf-8")));
}
catch {
    process.exit(0); // fail-open
}
//# sourceMappingURL=PlanGate.js.map