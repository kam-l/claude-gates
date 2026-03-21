#!/usr/bin/env node
/**
 * ClaudeGates v2 — SubagentStart injection hook.
 *
 * Injects the artifact path PATTERN into agent context. The agent derives
 * its own output_filepath from: session_dir + scope (from prompt) + agent_type.
 *
 * This eliminates the getPending race condition for parallel pipelines:
 * each agent knows its scope from its own prompt, so no DB lookup needed
 * for path resolution. No wrong-scope writes, no file collisions.
 *
 * Gate context (role, source_agent, source_artifact) is best-effort
 * enrichment via DB lookup — helpful but not required for correctness.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { getDb, getPending, getActiveGate, getFixGate } = require("./claude-gates-db.js");

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));
  const HOME = process.env.USERPROFILE || process.env.HOME || "";

  const sessionId = data.session_id || "";
  const agentType = data.agent_type || "";

  if (!sessionId || !agentType) process.exit(0);

  const bareAgentType = agentType.includes(":") ? agentType.split(":").pop() : agentType;
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId).replace(/\\/g, "/");

  // Best-effort gate context enrichment via DB.
  // Not required for path correctness — agent derives its own path.
  let gateContext = "";
  const db = getDb(sessionDir);
  try {
    const pending = getPending(db, bareAgentType);
    if (pending && pending.scope) {
      const scope = pending.scope;
      const activeGate = getActiveGate(db, scope);
      if (activeGate && activeGate.gate_agent === bareAgentType) {
        const sourceArtifact = path.join(
          sessionDir, scope, `${activeGate.source_agent}.md`
        ).replace(/\\/g, "/");
        gateContext =
          `role=gate\n` +
          `source_agent=${activeGate.source_agent}\n` +
          `source_artifact=${sourceArtifact}\n` +
          `gate_round=${activeGate.round}/${activeGate.max_rounds}\n`;
      }
      const fixGateRow = getFixGate(db, scope);
      if (fixGateRow && fixGateRow.fixer_agent === bareAgentType) {
        const sourceArtifact = path.join(
          sessionDir, scope, `${fixGateRow.source_agent}.md`
        ).replace(/\\/g, "/");
        gateContext =
          `role=fixer\n` +
          `source_agent=${fixGateRow.source_agent}\n` +
          `source_artifact=${sourceArtifact}\n` +
          `gate_agent=${fixGateRow.gate_agent}\n` +
          `gate_round=${fixGateRow.round}/${fixGateRow.max_rounds}\n`;
      }
    }
  } finally {
    db.close();
  }

  // Inject pattern — agent derives output_filepath from its own scope= and type.
  // No explicit path = no wrong-scope writes = no parallel collision.
  const context =
    `<agent_gate importance="critical">\n` +
    `session_dir=${sessionDir}\n` +
    gateContext +
    `Write your artifact to: {session_dir}/{scope}/{agent_type}.md\n` +
    `  - scope: extract from your prompt (scope=<name>)\n` +
    `  - agent_type: your agent name\n` +
    `  - Create the directory if needed\n` +
    `Last line must be: Result: PASS or Result: FAIL\n` +
    `</agent_gate>`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: context
    }
  }));
  process.exit(0);
} catch {
  process.exit(0);
}
