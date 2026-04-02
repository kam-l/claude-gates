#!/usr/bin/env node
"use strict";
/**
 * ClaudeGates v2 — PreToolUse:Bash commit-gate.
 *
 * Detects git commit in Bash commands and runs configured validation
 * commands before allowing. Opt-in via claude-gates.json.
 *
 * Fail-open.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const child_process_1 = require("child_process");
const claude_gates_config_1 = require("./claude-gates-config");
const GIT_COMMIT_RE = /(?:^|[;&|(]\s*)git\s+commit\b/m;
try {
    const data = JSON.parse(fs_1.default.readFileSync(0, "utf-8"));
    const config = (0, claude_gates_config_1.loadConfig)();
    if (!config.commit_gate.enabled)
        process.exit(0);
    if (!config.commit_gate.commands || config.commit_gate.commands.length === 0)
        process.exit(0);
    const command = (data.tool_input && data.tool_input.command) || "";
    if (!GIT_COMMIT_RE.test(command))
        process.exit(0);
    // Run all configured validation commands
    const failures = [];
    for (const cmd of config.commit_gate.commands) {
        process.stderr.write(`[ClaudeGates] ⚡ Running "${cmd}"...\n`);
        try {
            (0, child_process_1.execSync)(cmd, {
                encoding: "utf-8",
                timeout: 120000,
                stdio: ["pipe", "pipe", "pipe"],
                cwd: process.cwd()
            });
        }
        catch (err) {
            const output = (err.stderr || err.stdout || "").trim().split("\n").slice(0, 5).join("\n");
            failures.push({ cmd, output });
        }
    }
    if (failures.length > 0) {
        const detail = failures.map(f => `  ${f.cmd}${f.output ? ": " + f.output : ""}`).join("\n");
        const reason = `[ClaudeGates] ❌ Pre-commit failed.\n${detail}`;
        process.stdout.write(JSON.stringify({ decision: "block", reason }));
    }
    process.exit(0);
}
catch {
    process.exit(0); // fail-open
}
//# sourceMappingURL=commit-gate.js.map