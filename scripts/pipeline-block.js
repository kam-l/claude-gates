#!/usr/bin/env node
"use strict";
/**
 * Pipeline v3 — PreToolUse gate blocker (no matcher = all tools).
 *
 * When pipeline steps are active, blocks ALL tools except:
 *   - Tool calls from subagents (agent_type is set) — gated by SubagentStop
 *   - Read-only tools (Read, Glob, Grep) and progress tracking (TaskCreate, TaskUpdate, SendMessage)
 *   - Spawning an agent that matches ANY active pipeline's expected agent
 *   - Tools listed in a COMMAND step's allowedTools (+ Skill always allowed for /pass_or_revise)
 *
 * Also surfaces queued notifications from SubagentStop via systemMessage.
 *
 * Fail-open: no session / no DB / no active pipeline → allow.
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
const pipeline_db_1 = require("./pipeline-db");
const engine = __importStar(require("./pipeline"));
const pipeline_shared_1 = require("./pipeline-shared");
const msg = __importStar(require("./messages"));
const tracing = __importStar(require("./tracing"));
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "SendMessage", "ToolSearch"];
function sourceReason(act) {
    const step = act.step;
    if (!step)
        return ".";
    if (step.status === "fix")
        return `: reviewer found issues — fixer must address them before next review round.`;
    if (step.status === "revise")
        return `: reviewer found issues — source must revise the artifact.`;
    if (step.round > 0)
        return `: revision round ${step.round} — address reviewer feedback.`;
    return ".";
}
try {
    const data = JSON.parse(fs_1.default.readFileSync(0, "utf-8"));
    const sessionId = data.session_id || "";
    if (!sessionId)
        process.exit(0);
    const toolName = data.tool_name || "";
    const toolInput = data.tool_input || {};
    const callerAgent = data.agent_type || "";
    let traceScopes = {}; // { scope: trace_id } — stashed before db.close()
    const sessionDir = (0, pipeline_shared_1.getSessionDir)(sessionId);
    // Surface queued notifications from SubagentStop (side-channel)
    const pending = msg.drainNotifications(sessionDir);
    const db = (0, pipeline_db_1.getDb)(sessionDir);
    if (!db) {
        if (pending)
            msg.info("", pending.replace(/\[ClaudeGates\] /g, ""));
        process.exit(0);
    }
    let actions;
    try {
        actions = engine.getAllNextActions(db);
        // ── COMMAND verdict file processing ──
        let verdictProcessed = false;
        for (const act of actions) {
            if (act.action !== "command")
                continue;
            const verdictPath = path_1.default.join(sessionDir, act.scope, ".command-verdict.md");
            if (!fs_1.default.existsSync(verdictPath))
                continue;
            try {
                const content = fs_1.default.readFileSync(verdictPath, "utf-8");
                const match = pipeline_shared_1.VERDICT_RE.exec(content);
                const verdict = match ? match[1].toUpperCase() : "UNKNOWN";
                engine.step(db, act.scope, { role: null, artifactVerdict: verdict });
                fs_1.default.unlinkSync(verdictPath);
                verdictProcessed = true;
                msg.log("⚡", `COMMAND verdict ${verdict} for scope="${act.scope}". Advanced.`);
            }
            catch (e) {
                msg.log("⚠️", `Verdict file error for scope="${act.scope}": ${e.message}`);
            }
        }
        if (verdictProcessed) {
            actions = engine.getAllNextActions(db);
        }
        // Stash trace IDs before closing DB (Langfuse needs them after db.close)
        traceScopes = {};
        if (actions && actions.length > 0) {
            for (const act of actions) {
                try {
                    const row = db.prepare("SELECT trace_id FROM pipeline_state WHERE scope = ?").get(act.scope);
                    if (row && row.trace_id)
                        traceScopes[act.scope] = row.trace_id;
                }
                catch { }
            }
        }
    }
    finally {
        db.close();
    }
    // No active pipeline — surface any pending notifications and allow
    if (!actions || actions.length === 0) {
        if (pending)
            msg.info("", pending.replace(/\[ClaudeGates\] /g, ""));
        process.exit(0);
    }
    // Subagent calls gated by SubagentStop, not here
    if (callerAgent)
        process.exit(0);
    // Read-only + progress tracking tools always allowed
    if (ALLOWED_TOOLS.includes(toolName))
        process.exit(0);
    // /unblock is user-invocable-only (model can't see it) — no Skill allowlist needed
    // Build expected agents and allowed tools
    const expectedAgents = new Map();
    const commandAllowedTools = new Set();
    let hasBlockingActions = false;
    for (const act of actions) {
        if (act.action === "spawn" || act.action === "source" || act.action === "semantic") {
            // Skip blocking if the expected agent is still running (marker set by conditions.js, cleared by verification.js)
            try {
                if (fs_1.default.existsSync((0, pipeline_shared_1.agentRunningMarker)(sessionDir, act.scope)))
                    continue;
            }
            catch { }
            const agent = act.agent || (act.step && act.step.source_agent);
            if (agent)
                expectedAgents.set(agent, { scope: act.scope, action: act });
            hasBlockingActions = true;
        }
        else if (act.action === "command") {
            for (const t of act.allowedTools || [])
                commandAllowedTools.add(t);
            commandAllowedTools.add("Skill");
            hasBlockingActions = true;
        }
    }
    if (!hasBlockingActions)
        process.exit(0);
    // Write/Edit scoped to session artifacts — allow writes to non-session paths
    if (toolName === "Write" || toolName === "Edit") {
        const targetPath = (toolInput.file_path || "").replace(/\\/g, "/");
        if (targetPath && !targetPath.startsWith(sessionDir + "/"))
            process.exit(0);
    }
    // Agent tool: allow expected agents
    if (toolName === "Agent") {
        const subagentType = toolInput.subagent_type || "";
        if (expectedAgents.has(subagentType))
            process.exit(0);
    }
    // COMMAND step: allow listed tools
    if (commandAllowedTools.has(toolName))
        process.exit(0);
    // Build block message — actions as clear instructions, notifications separate
    const parts = [];
    for (const act of actions) {
        const agent = act.agent || (act.step && act.step.source_agent);
        if (act.action === "spawn") {
            const spawnRound = act.round + 1;
            const reason = spawnRound === 1 ? "reviewer needs to evaluate the artifact" : "re-review after revision";
            parts.push(`Spawn ${agent} (scope=${act.scope}, round ${spawnRound}/${act.maxRounds}): ${reason}.`);
        }
        else if (act.action === "source" || act.action === "semantic") {
            const round = act.step ? act.step.round : 0;
            const verb = round > 0 ? "Resume" : "Spawn";
            const reason = sourceReason(act);
            parts.push(`${verb} ${agent} (scope=${act.scope})${reason}`);
        }
        else if (act.action === "command") {
            parts.push(`Run ${act.command}, then /pass_or_revise (scope=${act.scope}).`);
        }
    }
    // Langfuse: trace block decisions (fire-and-forget, no DB needed — trace IDs stashed earlier)
    try {
        const { langfuse, enabled } = tracing.init();
        if (enabled) {
            for (const act of actions) {
                const traceId = traceScopes[act.scope];
                if (!traceId)
                    continue;
                const trace = langfuse.trace({ id: traceId, name: `pipeline:${act.scope}`, sessionId });
                trace.span({ name: "tool-blocked", input: { toolName, scope: act.scope, expectedAgent: act.agent } }).end();
            }
            tracing.flush(langfuse, enabled);
        }
    }
    catch { } // fail-open
    // Frame as instructions, not errors — Claude Code wraps this in "Error:" which misleads the orchestrator
    let message = `Pipeline actions pending (this is normal flow, not an error). Do these first:\n` + parts.join("\n");
    // Append deduplicated notifications separately — don't pollute action instructions
    if (pending) {
        const uniqueNotes = [...new Set(pending.split("\n").map(l => l.trim()).filter(Boolean))];
        message += `\nContext: ` + uniqueNotes.join(" | ");
    }
    const out = { decision: "block", reason: msg.fmt("🔒", message) };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
}
catch {
    process.exit(0); // fail-open
}
//# sourceMappingURL=pipeline-block.js.map