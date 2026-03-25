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
const { VERDICT_RE } = require("./pipeline-shared.js");
const msg = require("./messages.js");

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
  } finally {
    db.close();
  }

  // No active pipeline — surface any pending notifications and allow
  if (!actions || actions.length === 0) {
    if (pending) process.stdout.write(JSON.stringify({ systemMessage: pending }));
    process.exit(0);
  }

  // Subagent calls gated by SubagentStop, not here
  if (callerAgent) process.exit(0);

  // Read-only + progress tracking tools always allowed
  if (ALLOWED_TOOLS.includes(toolName)) process.exit(0);

  // Build expected agents and allowed tools
  const expectedAgents = new Map();
  const commandAllowedTools = new Set();

  let hasBlockingActions = false;
  for (const act of actions) {
    if (act.action === "spawn" || act.action === "source") {
      expectedAgents.set(act.agent, { scope: act.scope, action: act });
      hasBlockingActions = true;
    } else if (act.action === "command") {
      for (const t of act.allowedTools || []) commandAllowedTools.add(t);
      commandAllowedTools.add("Skill");
      hasBlockingActions = true;
    }
  }

  if (!hasBlockingActions) {
    if (pending) process.stdout.write(JSON.stringify({ systemMessage: pending }));
    process.exit(0);
  }

  // Agent tool: allow expected agents
  if (toolName === "Agent") {
    const subagentType = toolInput.subagent_type || "";
    if (expectedAgents.has(subagentType)) process.exit(0);
  }

  // COMMAND step: allow listed tools
  if (commandAllowedTools.has(toolName)) process.exit(0);

  // Build block message
  const parts = [];
  for (const act of actions) {
    if (act.action === "spawn") {
      parts.push(`Spawn ${act.agent} (scope=${act.scope}, round ${act.round + 1}/${act.maxRounds}).`);
    } else if (act.action === "source") {
      parts.push(`Spawn ${act.agent} (scope=${act.scope}).`);
    } else if (act.action === "command") {
      parts.push(`Run ${act.command}, then /pass_or_revise (scope=${act.scope}).`);
    }
  }

  const reason = parts.join(" ");
  const out = { decision: "block", reason: msg.fmt("🔒", reason) };
  if (pending) out.systemMessage = pending;
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
