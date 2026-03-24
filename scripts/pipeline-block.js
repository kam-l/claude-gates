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
 * COMMAND verdict file signaling:
 *   /pass_or_revise writes {scope}/.command-verdict.md
 *   This hook reads it on next PreToolUse, feeds verdict to engine, deletes file.
 *
 * Scope-aware: supports parallel pipelines via engine.getAllNextActions().
 *
 * Fail-open: no session / no DB / no active pipeline → allow.
 */

const fs = require("fs");
const path = require("path");
const { getDb } = require("./pipeline-db.js");
const engine = require("./pipeline.js");
const { VERDICT_RE } = require("./pipeline-shared.js");

const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "SendMessage"];

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const toolName = data.tool_name || "";
  const toolInput = data.tool_input || {};
  const callerAgent = data.agent_type || "";

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);

  const db = getDb(sessionDir);
  if (!db) process.exit(0);

  let actions;
  try {
    actions = engine.getAllNextActions(db);

    // ── COMMAND verdict file processing ──
    // Check for verdict files written by /pass_or_revise skill.
    // If found, feed verdict to engine and re-query actions.
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
        process.stderr.write(`[Pipeline] COMMAND verdict: ${verdict} for scope="${act.scope}". Pipeline advanced.\n`);
      } catch (e) {
        // Verdict file read/process failed — leave it for next cycle
        process.stderr.write(`[Pipeline] Verdict file error for scope="${act.scope}": ${e.message}\n`);
      }
    }

    // Re-query if any verdict was processed (steps may have advanced)
    if (verdictProcessed) {
      actions = engine.getAllNextActions(db);
    }
  } finally {
    db.close();
  }

  if (!actions || actions.length === 0) process.exit(0);

  // Subagent calls are gated by SubagentStop, not here.
  // Blocking them causes cross-scope deadlocks with parallel pipelines.
  if (callerAgent) process.exit(0);

  // Read-only + progress tracking tools always allowed
  if (ALLOWED_TOOLS.includes(toolName)) process.exit(0);

  // Build expected agents and allowed tools from all active actions
  const expectedAgents = new Map(); // agent_type → { scope, action }
  const commandAllowedTools = new Set();

  let hasBlockingActions = false;
  for (const act of actions) {
    if (act.action === "spawn" || act.action === "source") {
      expectedAgents.set(act.agent, { scope: act.scope, action: act });
      hasBlockingActions = true;
    } else if (act.action === "command") {
      for (const t of act.allowedTools || []) {
        commandAllowedTools.add(t);
      }
      // Always allow Skill tool for COMMAND steps (/pass_or_revise)
      commandAllowedTools.add("Skill");
      hasBlockingActions = true;
    }
    // semantic → non-blocking (processed synchronously at SubagentStop, not via agent spawn)
    // done → non-blocking (pipeline complete)
  }

  // If only semantic/done actions remain, don't block — these are transient states
  if (!hasBlockingActions) process.exit(0);

  // Agent tool: allow spawning any expected agent across all scopes
  if (toolName === "Agent") {
    const subagentType = toolInput.subagent_type || "";
    if (expectedAgents.has(subagentType)) process.exit(0);
  }

  // COMMAND step: allow listed tools + Skill
  if (commandAllowedTools.has(toolName)) process.exit(0);

  // Build shield UI message
  const parts = [];
  for (const act of actions) {
    if (act.action === "spawn") {
      parts.push(`\`${act.agent}\` (scope=${act.scope}, round ${act.round + 1}/${act.maxRounds})`);
    } else if (act.action === "source") {
      parts.push(`\`${act.agent}\` (scope=${act.scope})`);
    } else if (act.action === "command") {
      const verdictPath = path.join(sessionDir, act.scope, ".command-verdict.md").replace(/\\/g, "/");
      parts.push(`COMMAND \`${act.command}\` (scope=${act.scope}) — Run ${act.command}, then /pass_or_revise. Write verdict to: ${verdictPath}`);
    } else if (act.action === "semantic") {
      parts.push(`semantic check pending (scope=${act.scope})`);
    }
  }

  const msg = parts.length > 0
    ? `[Pipeline] ${parts.join(", ")}.`
    : `[Pipeline] Pipeline active — waiting for step completion.`;

  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: msg
  }));
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
