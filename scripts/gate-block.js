#!/usr/bin/env node
/**
 * ClaudeGates v2 — PreToolUse gate blocker (no matcher = all tools).
 *
 * When a gate is active, blocks ALL tools except:
 *   - Read-only tools (Read, Glob, Grep)
 *   - Spawning the correct agent (gate agent when active, source agent when revise, fixer when fix)
 *
 * Prevents the orchestrator from bypassing gates by using Bash, Edit, MCP tools, etc.
 *
 * Fail-open: no session / no DB / no active gate → allow.
 */

const fs = require("fs");
const path = require("path");
const { getDb } = require("./claude-gates-db.js");

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const toolName = data.tool_name || "";
  const toolInput = data.tool_input || {};

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);

  const db = getDb(sessionDir);
  if (!db) process.exit(0);

  // Check for any active, revise, or fix gate across all scopes
  const gate = db.prepare(
    "SELECT scope, gate_agent, source_agent, fixer_agent, status FROM gates WHERE status IN ('active','revise','fix') LIMIT 1"
  ).get();

  if (!gate) {
    db.close();
    process.exit(0);
  }

  db.close();

  // Read-only tools always allowed
  if (READ_ONLY_TOOLS.includes(toolName)) process.exit(0);

  // Agent tool: allow correct agent only
  if (toolName === "Agent") {
    const subagentType = toolInput.subagent_type || "";
    if (gate.status === "active" && subagentType === gate.gate_agent) process.exit(0);
    if (gate.status === "revise" && subagentType === gate.source_agent) process.exit(0);
    if (gate.status === "fix" && subagentType === gate.fixer_agent) process.exit(0);
  }

  // Block everything else
  const expectedAgent = gate.status === "fix" ? gate.fixer_agent
    : gate.status === "revise" ? gate.source_agent
    : gate.gate_agent;
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: `[ClaudeGates] Active gate: spawn ${expectedAgent} with scope=${gate.scope}. All other tools blocked until gate resolves.`
  }));
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
