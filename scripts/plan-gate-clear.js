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
const claude_gates_db_1 = require("./claude-gates-db");
const pipeline_shared_1 = require("./pipeline-shared");
try {
    const data = JSON.parse(fs_1.default.readFileSync(0, "utf-8"));
    const sessionId = data.session_id || "";
    if (!sessionId)
        process.exit(0);
    const sessionDir = (0, pipeline_shared_1.getSessionDir)(sessionId);
    const db = (0, claude_gates_db_1.getDb)(sessionDir);
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
//# sourceMappingURL=plan-gate-clear.js.map