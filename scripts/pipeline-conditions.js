#!/usr/bin/env node
"use strict";
/**
 * Pipeline v3 — PreToolUse:Agent conditions hook.
 *
 * Checks `conditions:` and pipeline step enforcement before
 * allowing an agent to spawn. Extracts `scope=<name>` from the agent's prompt.
 *
 * Flow:
 *   1. Resume? → allow (no gating on resumed agents)
 *   2. No agent type? → allow
 *   3. Find agent .md → parse frontmatter
 *   4. No scope + requiresScope → BLOCK
 *   5. No scope + no CG fields → allow (backward compatible)
 *   6. Conditions: semantic pre-check via claude -p
 *   7. Step enforcement: engine.getAllNextActions() → only expected agents allowed
 *   8. Register scope in SQLite
 *
 * Fail-open.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const pipeline_shared_1 = require("./pipeline-shared");
const pipeline_db_1 = require("./pipeline-db");
const engine = __importStar(require("./pipeline"));
const msg = __importStar(require("./messages"));
const HOME = process.env.USERPROFILE || process.env.HOME || "";
const PROJECT_ROOT = process.cwd();
try {
    const data = JSON.parse(fs_1.default.readFileSync(0, "utf-8"));
    // PreToolUse:Agent provides tool_input with prompt and subagent_type
    const toolInput = data.tool_input || {};
    const agentType = toolInput.subagent_type || "";
    const prompt = toolInput.prompt || "";
    // Resume → allow (no gating)
    if (toolInput.resume)
        process.exit(0);
    // No agent type → allow
    if (!agentType)
        process.exit(0);
    // Normalize agent type (strip plugin prefix)
    const bareAgentType = agentType.includes(":") ? agentType.split(":").pop() : agentType;
    // Find agent definition
    const agentMdPath = (0, pipeline_shared_1.findAgentMd)(bareAgentType, PROJECT_ROOT, HOME);
    let mdContent = null;
    if (agentMdPath) {
        mdContent = fs_1.default.readFileSync(agentMdPath, "utf-8");
    }
    // Extract scope
    const scopeMatch = prompt.match(/scope=([A-Za-z0-9_-]+)/);
    const scope = scopeMatch ? scopeMatch[1] : null;
    // No scope handling
    if (!scope) {
        if (mdContent && (0, pipeline_shared_1.requiresScope)(mdContent)) {
            msg.block("🔏", `Agent "${bareAgentType}" needs scope=<name>. Add it to the spawn prompt.`);
        }
        process.exit(0);
    }
    // Reject reserved scope names
    if (scope === "_pending" || scope === "_meta")
        process.exit(0);
    // No agent .md → no gate
    if (!agentMdPath || !mdContent)
        process.exit(0);
    // Session dir
    const sessionId = data.session_id || "";
    if (!sessionId)
        process.exit(0);
    const sessionDir = (0, pipeline_shared_1.getSessionDir)(sessionId);
    // ── Semantic pre-check (conditions:) ──
    const conditions = (0, pipeline_shared_1.parseConditions)(mdContent);
    if (conditions) {
        try {
            const condPrompt = conditions + "\n\nAgent spawn prompt:\n" + prompt;
            const condResult = (0, child_process_1.execSync)("claude -p --model sonnet --agent claude-gates:gater --max-turns 1 --tools \"\" --no-chrome --strict-mcp-config --disable-slash-commands --no-session-persistence", {
                input: condPrompt,
                cwd: PROJECT_ROOT,
                timeout: 30000,
                encoding: "utf-8",
                shell: true,
                env: { ...process.env, CLAUDECODE: "" }
            }).trim();
            const condMatch = /^Result:\s*(PASS|FAIL|REVISE|CONVERGED)\b(.*)?$/mi.exec(condResult);
            const condRaw = condMatch ? condMatch[1].toUpperCase() : "UNKNOWN";
            const condVerdict = (condRaw === "FAIL" || condRaw === "REVISE") ? "FAIL" : "PASS";
            if (condVerdict === "FAIL") {
                const reason = condMatch[2] ? condMatch[2].trim() : "Pre-spawn conditions check failed";
                msg.block("🔏", `Failed for ${bareAgentType}: ${reason}`);
                process.exit(0);
            }
            msg.log("✅", `${condVerdict} for ${bareAgentType}`);
        }
        catch {
            // Semantic check failed — fail-open
            msg.log("⚠️", `Skipped for ${bareAgentType} (claude -p unavailable)`);
        }
    }
    // ── Step enforcement via engine ──
    const db = (0, pipeline_db_1.getDb)(sessionDir);
    try {
        const actions = engine.getAllNextActions(db);
        if (actions && actions.length > 0) {
            // Check if any action expects this agent type for this scope
            const scopeAction = actions.find(a => a.scope === scope);
            if (scopeAction) {
                // spawn/source → only the expected agent
                if (scopeAction.action === "spawn" || scopeAction.action === "source") {
                    if (scopeAction.agent !== bareAgentType) {
                        msg.block("🔏", `Scope "${scope}" expects "${scopeAction.agent}", not "${bareAgentType}". Spawn ${scopeAction.agent}.`);
                        db.close();
                        process.exit(0);
                    }
                }
                // command → block agent spawns (command runs inline)
                else if (scopeAction.action === "command") {
                    msg.block("🔏", `Scope "${scope}" has active COMMAND "${scopeAction.command}". Run it, then /pass_or_revise.`);
                    db.close();
                    process.exit(0);
                }
                // semantic → block agent spawns (runs at SubagentStop)
                else if (scopeAction.action === "semantic") {
                    // Semantic steps fire after source completion at SubagentStop.
                    // If we're here, a new agent is being spawned for this scope — allow it
                    // (it's likely the source agent being spawned for the first time).
                }
            }
            // No action for this scope — block if other scopes have pending actions (sequential enforcement)
            else {
                const pending = actions.filter(a => a.scope !== scope);
                if (pending.length > 0) {
                    const parts = pending.map((a) => {
                        const agent = a.agent || (a.step && a.step.source_agent);
                        return `${a.action} ${agent || ""} (scope=${a.scope})`;
                    });
                    msg.block("🔏", `Other pipeline(s) active — finish them first:\n${parts.join("\n")}`);
                    db.close();
                    process.exit(0);
                }
            }
        }
        // Create scope dir if first agent
        const scopeDir = path_1.default.join(sessionDir, scope);
        if (!fs_1.default.existsSync(scopeDir)) {
            fs_1.default.mkdirSync(scopeDir, { recursive: true });
        }
        // Register agent
        const outputFilepath = path_1.default.join(scopeDir, `${bareAgentType}.md`).replace(/\\/g, "/");
        (0, pipeline_db_1.registerAgent)(db, scope, bareAgentType, outputFilepath);
        // Mark agent as running — pipeline-block skips blocking while marker exists
        try {
            fs_1.default.writeFileSync((0, pipeline_shared_1.agentRunningMarker)(sessionDir, scope), "", "utf-8");
        }
        catch { }
        // Write pending scope marker — SubagentStart (injection) reads this to resolve scope
        // (SubagentStart doesn't have the prompt, so it can't extract scope= itself)
        try {
            fs_1.default.writeFileSync(path_1.default.join(sessionDir, `.pending-scope-${bareAgentType}`), scope, "utf-8");
        }
        catch { }
        // Warn orchestrator that this agent's pipeline will block other work
        if (mdContent && (0, pipeline_shared_1.requiresScope)(mdContent)) {
            msg.log("🔏", `${bareAgentType} (scope=${scope}) has verification gates — process its results before starting unrelated work.`);
        }
    }
    finally {
        db.close();
    }
    // Allow
    process.exit(0);
}
catch (err) {
    // Fail-open
    msg.log("⚠️", `Error: ${err.message}`);
    process.exit(0);
}
//# sourceMappingURL=pipeline-conditions.js.map