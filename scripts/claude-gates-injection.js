#!/usr/bin/env node
/**
 * ClaudeGates v2 — SubagentStart injection hook.
 *
 * Injects output_filepath into agent context so the agent knows exactly
 * where to write its artifact. Reads scope from _pending in
 * session_scopes.json (staged by the conditions hook).
 *
 * For gate agents, enhances context with source agent info.
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

  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId).replace(/\\/g, "/");

  // Read output_filepath and gate context from DB or JSON
  let outputFilepath = "";
  let gateContext = "";
  const db = getDb(sessionDir);
  if (db) {
    try {
      // SQLite path
      const pending = getPending(db, agentType);
      if (pending && pending.outputFilepath) {
        outputFilepath = pending.outputFilepath;
        // Check if this is a gate agent or fixer agent
        if (pending.scope) {
          const activeGate = getActiveGate(db, pending.scope);
          if (activeGate && activeGate.gate_agent === agentType) {
            const sourceArtifact = path.join(
              sessionDir, pending.scope, `${activeGate.source_agent}.md`
            ).replace(/\\/g, "/");
            gateContext =
              `role=gate\n` +
              `source_agent=${activeGate.source_agent}\n` +
              `source_artifact=${sourceArtifact}\n` +
              `gate_round=${activeGate.round}/${activeGate.max_rounds}\n`;
          }
          const fixGateRow = getFixGate(db, pending.scope);
          if (fixGateRow && fixGateRow.fixer_agent === agentType) {
            const sourceArtifact = path.join(
              sessionDir, pending.scope, `${fixGateRow.source_agent}.md`
            ).replace(/\\/g, "/");
            gateContext =
              `role=fixer\n` +
              `source_agent=${fixGateRow.source_agent}\n` +
              `source_artifact=${sourceArtifact}\n` +
              `gate_agent=${fixGateRow.gate_agent}\n` +
              `gate_round=${fixGateRow.round}/${fixGateRow.max_rounds}\n`;
          }
        }
      }
    } finally {
      db.close();
    }
  } else {
    // JSON path (existing behavior)
    try {
      const scopesFile = path.join(HOME, ".claude", "sessions", sessionId, "session_scopes.json");
      const scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8"));
      const pending = scopes._pending && scopes._pending[agentType];
      if (pending && pending.outputFilepath) {
        outputFilepath = pending.outputFilepath;
      }
    } catch {} // missing or unreadable → no filepath injection
  }

  let context;
  if (outputFilepath) {
    context =
      `<agent_gate importance="critical">\n` +
      `output_filepath=${outputFilepath}\n` +
      gateContext +
      `Write your artifact to this exact path. Last line must be: Result: PASS or Result: FAIL\n` +
      `</agent_gate>`;
  } else {
    // Ungated agent — inject session_dir for backward compatibility
    context = `<agent_gate>session_dir=${sessionDir}</agent_gate>`;
  }

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
