#!/usr/bin/env node
/**
 * ClaudeGates v2 — PreToolUse gate blocker (no matcher = all tools).
 *
 * When gates are active, blocks ALL tools except:
 *   - Tool calls from an expected agent itself (detected via agent_type)
 *   - Read-only tools (Read, Glob, Grep)
 *   - Spawning an agent that matches ANY open scope's expected agent
 *
 * Scope-aware: supports parallel pipelines. Each scope tracks its own
 * gate chain independently. The orchestrator can spawn agents for any
 * scope that needs one.
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
  const callerAgent = data.agent_type || "";

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);

  const db = getDb(sessionDir);
  if (!db) process.exit(0);

  // Get ALL active gates across all scopes (parallel-aware)
  const gates = db.prepare(
    "SELECT scope, gate_agent, source_agent, fixer_agent, status FROM gates WHERE status IN ('active','revise','fix')"
  ).all();

  db.close();

  if (gates.length === 0) process.exit(0);

  // Build set of expected agents across all open scopes
  const expectedAgents = new Map(); // agent_type → { scope, status }
  for (const g of gates) {
    const expected = g.status === "fix" ? g.fixer_agent
      : g.status === "revise" ? g.source_agent
      : g.gate_agent;
    if (expected) expectedAgents.set(expected, { scope: g.scope, status: g.status });
  }

  // If the tool call is from ANY subagent (agent_type is set), allow it.
  // Gate-block locks the ORCHESTRATOR, not subagents. Subagents are gated
  // by SubagentStop verification — blocking them here causes cross-scope
  // deadlocks when parallel pipelines have active gates.
  if (callerAgent) process.exit(0);

  // Read-only tools always allowed
  if (READ_ONLY_TOOLS.includes(toolName)) process.exit(0);

  // Agent tool: allow spawning any expected agent across all scopes
  if (toolName === "Agent") {
    const subagentType = toolInput.subagent_type || "";
    if (expectedAgents.has(subagentType)) process.exit(0);
  }

  // Block everything else — list all pending scopes in message
  const pending = [...expectedAgents.entries()]
    .map(([agent, info]) => `\`${agent}\` (scope=${info.scope})`)
    .join(", ");
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: `[ClaudeGates] Spawn: ${pending}.`
  }));
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
