#!/usr/bin/env node
"use strict";
/**
 * Pipeline v3 — SessionStart cleanup.
 *
 * Prunes old session directories from {CWD}/.sessions/ (and legacy ~/.claude/sessions/).
 * Deletes dirs where session.db is older than MAX_AGE_DAYS.
 * Skips the current session. Fail-open.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const MAX_AGE_DAYS = 7;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
try {
    const data = JSON.parse(fs_1.default.readFileSync(0, "utf-8"));
    const currentSession = data.session_id || "";
    const currentShort = currentSession.replace(/-/g, "").slice(0, 8);
    const HOME = process.env.USERPROFILE || process.env.HOME || "";
    const sessionsDirs = [
        path_1.default.join(process.cwd(), ".sessions"),
        path_1.default.join(HOME, ".claude", "sessions") // legacy location
    ];
    const now = Date.now();
    let pruned = 0;
    for (const sessionsDir of sessionsDirs) {
        if (!fs_1.default.existsSync(sessionsDir))
            continue;
        for (const entry of fs_1.default.readdirSync(sessionsDir, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            if (entry.name === currentSession || entry.name === currentShort)
                continue;
            const dirPath = path_1.default.join(sessionsDir, entry.name);
            const dbPath = path_1.default.join(dirPath, "session.db");
            // Only prune dirs that have a session.db (ours)
            if (!fs_1.default.existsSync(dbPath))
                continue;
            try {
                const stat = fs_1.default.statSync(dbPath);
                if (now - stat.mtimeMs > MAX_AGE_MS) {
                    fs_1.default.rmSync(dirPath, { recursive: true, force: true });
                    pruned++;
                }
            }
            catch { } // skip on permission/lock errors
        }
    }
    if (pruned > 0) {
        process.stderr.write(`[ClaudeGates] 🧹 Pruned ${pruned} session(s) older than ${MAX_AGE_DAYS} days.\n`);
    }
    process.exit(0);
}
catch {
    process.exit(0); // fail-open
}
//# sourceMappingURL=session-cleanup.js.map