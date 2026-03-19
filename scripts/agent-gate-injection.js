#!/usr/bin/env node
/**
 * AgentGate v1 — SubagentStart injection hook.
 *
 * Injects output_filepath into agent context so the agent knows exactly
 * where to write its artifact. Reads scope from _pending in
 * session_scopes.json (staged by the conditions hook).
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));
  const HOME = process.env.USERPROFILE || process.env.HOME || "";

  const sessionId = data.session_id || "";
  const agentType = data.agent_type || "";

  if (!sessionId || !agentType) process.exit(0);

  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId).replace(/\\/g, "/");

  // Read output_filepath from _pending (staged by conditions hook)
  let outputFilepath = "";
  try {
    const scopesFile = path.join(HOME, ".claude", "sessions", sessionId, "session_scopes.json");
    const scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8"));
    const pending = scopes._pending && scopes._pending[agentType];
    if (pending && pending.outputFilepath) {
      outputFilepath = pending.outputFilepath;
    }
  } catch {} // missing or unreadable → no filepath injection

  let context;
  if (outputFilepath) {
    context =
      `<agent_gate importance="critical">\n` +
      `output_filepath=${outputFilepath}\n` +
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
