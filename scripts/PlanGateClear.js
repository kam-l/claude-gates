#!/usr/bin/env node
"use strict";
/**
 * ClaudeGates v2 — PostToolUse:ExitPlanMode hook.
 *
 * Clears the gater verdict after every ExitPlanMode so the next plan
 * requires fresh verification. Fires regardless of accept/reject.
 *
 * Fail-open.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const GateRepository_1 = require("./GateRepository");
const SessionManager_1 = require("./SessionManager");
try {
    const data = JSON.parse(fs_1.default.readFileSync(0, "utf-8"));
    const sessionId = data.session_id || "";
    if (!sessionId) {
        process.exit(0);
    }
    const sessionDir = SessionManager_1.SessionManager.getSessionDir(sessionId);
    const db = GateRepository_1.GateRepository.createDb(sessionDir);
    try {
        // Clears ALL gater verdicts across all scopes — intentional.
        // Any new plan requires fresh verification regardless of scope.
        db.prepare("DELETE FROM agents WHERE agent = 'gater' AND verdict IS NOT NULL").run();
    }
    finally {
        db.close();
    }
    process.exit(0);
}
catch {
    process.exit(0); // fail-open
}
//# sourceMappingURL=PlanGateClear.js.map