#!/usr/bin/env node
"use strict";
/**
 * ClaudeGates v2 — PostToolUse:Edit|Write gate.
 *
 * Tracks edited files in SQLite (stop-gate reads them).
 * Runs opt-in formatter commands on each newly-edited file (deduped).
 *
 * Config (claude-gates.json):
 *   edit_gate.commands: ["dotnet format --include {file}"]
 *   {file} is replaced with the absolute path of the just-edited file.
 *   Commands run only on NEW files (dedup — same file edited twice doesn't re-run).
 *   Failures are non-fatal (stderr warning, never blocks).
 *
 * Fail-open.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const claude_gates_db_1 = require("./claude-gates-db");
const claude_gates_config_1 = require("./claude-gates-config");
const pipeline_shared_1 = require("./pipeline-shared");
try {
    const data = JSON.parse(fs_1.default.readFileSync(0, "utf-8"));
    const sessionId = data.session_id || "";
    if (!sessionId)
        process.exit(0);
    const sessionDir = (0, pipeline_shared_1.getSessionDir)(sessionId);
    // Extract file_path from tool_input (Edit/Write both use file_path)
    const toolInput = data.tool_input || {};
    let filePath = toolInput.file_path || "";
    // Fallback: try tool_result if tool_input doesn't have it
    if (!filePath && data.tool_result) {
        const resultMatch = String(data.tool_result).match(/(?:file|path)[:\s]+([^\n,]+)/i);
        if (resultMatch)
            filePath = resultMatch[1].trim();
    }
    if (!filePath)
        process.exit(0);
    // Normalize path (resolve + forward slashes)
    const normalized = path_1.default.resolve(filePath).replace(/\\/g, "/");
    // SQLite: track edits
    const db = (0, claude_gates_db_1.getDb)(sessionDir);
    // Check if this is a new file (not already tracked)
    const editsBefore = (0, claude_gates_db_1.getEdits)(db);
    const isNew = !editsBefore.includes(normalized);
    // Track the file
    (0, claude_gates_db_1.addEdit)(db, normalized);
    // Run formatter commands on new files only (dedup)
    if (isNew) {
        const config = (0, claude_gates_config_1.loadConfig)();
        const commands = config.edit_gate.commands || [];
        for (const cmd of commands) {
            const expanded = cmd.replace(/\{file\}/g, normalized);
            try {
                (0, child_process_1.execSync)(expanded, {
                    encoding: "utf-8",
                    timeout: 30000,
                    stdio: ["pipe", "pipe", "pipe"]
                });
            }
            catch (err) {
                // Non-fatal — show stderr output to user
                const output = (err.stderr || "").trim();
                if (output) {
                    process.stderr.write(`[ClaudeGates] ⚠️ Formatter — ${output}\n`);
                }
                else {
                    process.stderr.write(`[ClaudeGates] ⚠️ Formatter failed — ${expanded}\n`);
                }
            }
        }
    }
    db.close();
    process.exit(0);
}
catch {
    process.exit(0); // fail-open
}
//# sourceMappingURL=edit-gate.js.map