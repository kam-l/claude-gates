#!/usr/bin/env node
"use strict";
/**
 * Pipeline v3 — PreToolUse gate blocker (no matcher = all tools).
 *
 * When pipeline steps are active, blocks ALL tools except:
 *   - Tool calls from subagents (agent_type is set) — gated by SubagentStop
 *   - Read-only tools (Read, Glob, Grep) and progress tracking (TaskCreate, TaskUpdate, SendMessage)
 *   - Spawning an agent that matches ANY active pipeline's expected agent
 *
 * Also surfaces queued notifications from SubagentStop via systemMessage.
 *
 * Fail-open: no session / no DB / no active pipeline → allow.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onPreToolUse = onPreToolUse;
const fs_1 = __importDefault(require("fs"));
const Messaging_1 = require("./Messaging");
const PipelineEngine_1 = require("./PipelineEngine");
const PipelineRepository_1 = require("./PipelineRepository");
const SessionManager_1 = require("./SessionManager");
const Tracing_1 = require("./Tracing");
const Enums_1 = require("./types/Enums");
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "SendMessage", "ToolSearch",];
function sourceReason(act) {
    const step = act.step;
    if (!step) {
        return ".";
    }
    if (step.status === Enums_1.StepStatus.Fix) {
        return `: reviewer found issues — fixer must address them before next review round.`;
    }
    if (step.status === Enums_1.StepStatus.Revise) {
        return `: reviewer found issues — source must revise the artifact.`;
    }
    if (step.round > 0) {
        return `: revision round ${step.round} — address reviewer feedback.`;
    }
    return ".";
}
function onPreToolUse(data) {
    const sessionId = data.session_id || "";
    if (!sessionId) {
        process.exit(0);
    }
    const toolName = data.tool_name || "";
    const toolInput = data.tool_input || {};
    const callerAgent = data.agent_type || "";
    let traceScopes = {}; // { scope: trace_id } — stashed before db.close()
    const sessionDir = SessionManager_1.SessionManager.getSessionDir(sessionId);
    // Surface queued notifications from SubagentStop (side-channel)
    const pending = Messaging_1.Messaging.drainNotifications(sessionDir);
    const db = SessionManager_1.SessionManager.openDatabase(sessionDir);
    if (!db) {
        if (pending) {
            Messaging_1.Messaging.info("", pending.replace(/\[ClaudeGates\] /g, ""));
        }
        process.exit(0);
    }
    PipelineRepository_1.PipelineRepository.initSchema(db);
    let actions;
    try {
        const repo = new PipelineRepository_1.PipelineRepository(db);
        const pipelineEngine = new PipelineEngine_1.PipelineEngine(repo);
        actions = pipelineEngine.getAllNextActions();
        // Stash trace IDs before closing DB (Langfuse needs them after db.close)
        traceScopes = {};
        if (actions && actions.length > 0) {
            for (const act of actions) {
                try {
                    const state = repo.getPipelineState(act.scope);
                    if (state && state.trace_id) {
                        traceScopes[act.scope] = state.trace_id;
                    }
                }
                catch {
                }
            }
        }
    }
    finally {
        db.close();
    }
    // No active pipeline — surface any pending notifications and allow
    if (!actions || actions.length === 0) {
        if (pending) {
            Messaging_1.Messaging.info("", pending.replace(/\[ClaudeGates\] /g, ""));
        }
        process.exit(0);
    }
    // Subagent calls gated by SubagentStop, not here
    if (callerAgent) {
        process.exit(0);
    }
    // Read-only + progress tracking tools always allowed
    if (ALLOWED_TOOLS.includes(toolName)) {
        process.exit(0);
    }
    // /unblock is user-invocable-only (model can't see it) — no Skill allowlist needed
    // Build expected agents
    const expectedAgents = new Map();
    let hasBlockingActions = false;
    for (const act of actions) {
        if (act.action === "spawn" || act.action === "source" || act.action === "semantic") {
            // Skip blocking if the expected agent is still running (marker set by conditions.js, cleared by verification.js)
            try {
                if (fs_1.default.existsSync(SessionManager_1.SessionManager.agentRunningMarker(sessionDir, act.scope))) {
                    continue;
                }
            }
            catch {
            }
            const agent = act.agent || (act.step && act.step.source_agent);
            if (agent) {
                expectedAgents.set(agent, { scope: act.scope, action: act, });
            }
            hasBlockingActions = true;
        }
    }
    if (!hasBlockingActions) {
        process.exit(0);
    }
    // Write/Edit scoped to session artifacts — allow writes to non-session paths
    if (toolName === "Write" || toolName === "Edit") {
        const targetPath = (toolInput.file_path || "").replace(/\\/g, "/");
        if (targetPath && !targetPath.startsWith(sessionDir + "/")) {
            process.exit(0);
        }
    }
    // Agent tool: allow expected agents
    if (toolName === "Agent") {
        const subagentType = toolInput.subagent_type || "";
        if (expectedAgents.has(subagentType)) {
            process.exit(0);
        }
    }
    // Build block message — actions as clear instructions, notifications separate
    const parts = [];
    for (const act of actions) {
        const agent = act.agent || (act.step && act.step.source_agent);
        if (act.action === "spawn") {
            const isTransform = act.step && act.step.step_type === "TRANSFORM";
            const attempt = act.round + 1;
            const maxAttempts = act.maxRounds + 1;
            const reason = isTransform
                ? "transform step — auto-passes on completion"
                : attempt === 1
                    ? "reviewer needs to evaluate the artifact"
                    : "re-review after revision";
            parts.push(`Spawn ${agent} (scope=${act.scope}, round ${attempt}/${maxAttempts}): ${reason}.`);
        }
        else if (act.action === "source" || act.action === "semantic") {
            const round = act.step ? act.step.round : 0;
            const verb = round > 0 ? "Resume" : "Spawn";
            const reason = sourceReason(act);
            parts.push(`${verb} ${agent} (scope=${act.scope})${reason}`);
        }
    }
    // Langfuse: trace block decisions (fire-and-forget, no DB needed — trace IDs stashed earlier)
    try {
        const { langfuse, enabled, } = Tracing_1.Tracing.init();
        if (enabled) {
            for (const act of actions) {
                const traceId = traceScopes[act.scope];
                if (!traceId) {
                    continue;
                }
                const trace = langfuse.trace({ id: traceId, name: `pipeline:${act.scope}`, sessionId, });
                trace.span({ name: "tool-blocked", input: { toolName, scope: act.scope, expectedAgent: act.agent, }, }).end();
            }
            Tracing_1.Tracing.flush(langfuse, enabled);
        }
    }
    catch {
    } // fail-open
    // Frame as instructions, not errors — Claude Code wraps this in "Error:" which misleads the orchestrator
    let message = `Pipeline actions pending (this is normal flow, not an error). Do these first:\n` + parts.join("\n");
    // Append deduplicated notifications separately — don't pollute action instructions
    if (pending) {
        const uniqueNotes = [...new Set(pending.split("\n").map(l => l.trim()).filter(Boolean)),];
        message += `\nContext: ` + uniqueNotes.join(" | ");
    }
    const out = { decision: "block", reason: Messaging_1.Messaging.fmt("🔒", message), };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
}
// ── Entry point (thin wrapper) ──────────────────────────────────────
try {
    onPreToolUse(JSON.parse(fs_1.default.readFileSync(0, "utf-8")));
}
catch {
    process.exit(0); // fail-open
}
//# sourceMappingURL=PipelineBlock.js.map