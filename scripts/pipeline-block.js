#!/usr/bin/env node
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

const fs = require("fs");
const path = require("path");
const { getDb } = require("./pipeline-db.js");
const engine = require("./pipeline.js");
const { VERDICT_RE, getSessionDir, agentRunningMarker } = require("./pipeline-shared.js");
const msg = require("./messages.js");
const tracing = require("./tracing.js");

const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "SendMessage", "ToolSearch"];

function sourceReason(act) {
  const step = act.step;
  if (!step) return ".";
  if (step.status === "fix") return `: reviewer found issues — fixer must address them before next review round.`;
  if (step.status === "revise") return `: reviewer found issues — source must revise the artifact.`;
  if (step.round > 0) return `: revision round ${step.round} — address reviewer feedback.`;
  return ".";
}

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const toolName = data.tool_name || "";
  const toolInput = data.tool_input || {};
  const callerAgent = data.agent_type || "";
  let traceScopes = {}; // { scope: trace_id } — stashed before db.close()

  const sessionDir = getSessionDir(sessionId);

  // Surface queued notifications from SubagentStop (side-channel)
  const pending = msg.drainNotifications(sessionDir);

  const db = getDb(sessionDir);
  if (!db) {
    if (pending) msg.info("", pending.replace(/\[ClaudeGates\] /g, ""));
    process.exit(0);
  }

  let actions;
  try {
    actions = engine.getAllNextActions(db);

    // ── COMMAND verdict file processing ──
    let verdictProcessed = false;
    for (const act of actions) {
      if (act.action !== "command") continue;
      const verdictPath = path.join(sessionDir, act.scope, ".command-verdict.md");
      if (!fs.existsSync(verdictPath)) continue;

      try {
        const content = fs.readFileSync(verdictPath, "utf-8");
        const match = VERDICT_RE.exec(content);
        const verdict = match ? match[1].toUpperCase() : "UNKNOWN";
        engine.step(db, act.scope, { role: null, artifactVerdict: verdict });
        fs.unlinkSync(verdictPath);
        verdictProcessed = true;
        msg.log("⚡", `COMMAND verdict ${verdict} for scope="${act.scope}". Advanced.`);
      } catch (e) {
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
          if (row && row.trace_id) traceScopes[act.scope] = row.trace_id;
        } catch {}
      }
    }
  } finally {
    db.close();
  }

  // No active pipeline — surface any pending notifications and allow
  if (!actions || actions.length === 0) {
    if (pending) msg.info("", pending.replace(/\[ClaudeGates\] /g, ""));
    process.exit(0);
  }

  // Subagent calls gated by SubagentStop, not here
  if (callerAgent) process.exit(0);

  // Read-only + progress tracking tools always allowed
  if (ALLOWED_TOOLS.includes(toolName)) process.exit(0);

  // /heal skill always allowed — escape hatch for stuck gates
  if (toolName === "Skill") {
    const skill = (toolInput.skill || "").replace(/^.*:/, "");
    if (skill === "heal") process.exit(0);
  }

  // Build expected agents and allowed tools
  const expectedAgents = new Map();
  const commandAllowedTools = new Set();

  let hasBlockingActions = false;
  for (const act of actions) {
    if (act.action === "spawn" || act.action === "source" || act.action === "semantic") {
      // Skip blocking if the expected agent is still running (marker set by conditions.js, cleared by verification.js)
      try { if (fs.existsSync(agentRunningMarker(sessionDir, act.scope))) continue; } catch {}
      const agent = act.agent || (act.step && act.step.source_agent);
      if (agent) expectedAgents.set(agent, { scope: act.scope, action: act });
      hasBlockingActions = true;
    } else if (act.action === "command") {
      for (const t of act.allowedTools || []) commandAllowedTools.add(t);
      commandAllowedTools.add("Skill");
      hasBlockingActions = true;
    }
  }

  if (!hasBlockingActions) process.exit(0);

  // Write/Edit scoped to session artifacts — allow writes to non-session paths
  if (toolName === "Write" || toolName === "Edit") {
    const targetPath = (toolInput.file_path || "").replace(/\\/g, "/");
    if (targetPath && !targetPath.startsWith(sessionDir + "/")) process.exit(0);
  }

  // Agent tool: allow expected agents
  if (toolName === "Agent") {
    const subagentType = toolInput.subagent_type || "";
    if (expectedAgents.has(subagentType)) process.exit(0);
  }

  // COMMAND step: allow listed tools
  if (commandAllowedTools.has(toolName)) process.exit(0);

  // Build block message — actions as clear instructions, notifications separate
  const parts = [];
  for (const act of actions) {
    const agent = act.agent || (act.step && act.step.source_agent);
    if (act.action === "spawn") {
      const spawnRound = act.round + 1;
      const reason = spawnRound === 1 ? "reviewer needs to evaluate the artifact" : "re-review after revision";
      parts.push(`Spawn ${agent} (scope=${act.scope}, round ${spawnRound}/${act.maxRounds}): ${reason}.`);
    } else if (act.action === "source" || act.action === "semantic") {
      const round = act.step ? act.step.round : 0;
      const verb = round > 0 ? "Resume" : "Spawn";
      const reason = sourceReason(act);
      parts.push(`${verb} ${agent} (scope=${act.scope})${reason}`);
    } else if (act.action === "command") {
      parts.push(`Run ${act.command}, then /pass_or_revise (scope=${act.scope}).`);
    }
  }

  // Langfuse: trace block decisions (fire-and-forget, no DB needed — trace IDs stashed earlier)
  try {
    const { langfuse, enabled } = tracing.init();
    if (enabled) {
      for (const act of actions) {
        const traceId = traceScopes[act.scope];
        if (!traceId) continue;
        const trace = langfuse.trace({ id: traceId, name: `pipeline:${act.scope}`, sessionId });
        trace.span({ name: "tool-blocked", input: { toolName, scope: act.scope, expectedAgent: act.agent } }).end();
      }
      tracing.flush(langfuse, enabled);
    }
  } catch {} // fail-open

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
} catch {
  process.exit(0); // fail-open
}
