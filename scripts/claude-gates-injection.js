#!/usr/bin/env node
/**
 * ClaudeGates v2 — SubagentStart injection hook.
 *
 * Injects output_filepath into agent context so the agent knows exactly
 * where to write its artifact. Resolves scope from the subagent's transcript
 * (first line contains the spawn prompt with scope=<name>).
 *
 * For gate agents, enhances context with source agent info.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { getDb, getAgent, getActiveGate, getFixGate } = require("./claude-gates-db.js");

/**
 * Extract scope= from the subagent's own transcript JSONL.
 * The first line is always the user message (spawn prompt) containing scope=.
 * Reads only the first 2KB — no performance concern.
 */
function extractScopeFromTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(2048);
    const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const match = buf.toString("utf-8", 0, bytesRead).match(/scope=([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
  } catch {}
  return null;
}

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));
  const HOME = process.env.USERPROFILE || process.env.HOME || "";

  const sessionId = data.session_id || "";
  const agentType = data.agent_type || "";

  if (!sessionId || !agentType) process.exit(0);

  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId).replace(/\\/g, "/");

  // Resolve scope from transcript (order-independent, parallel-safe)
  let scope = extractScopeFromTranscript(data.transcript_path);
  let outputFilepath = "";
  let gateContext = "";

  const db = getDb(sessionDir);
  try {
    if (scope) {
      const agentRow = getAgent(db, scope, agentType);
      if (agentRow && agentRow.outputFilepath) {
        outputFilepath = agentRow.outputFilepath;
      }
    }

    // Gate context: enhance for gate agents and fixer agents
    if (scope && outputFilepath) {
      const activeGate = getActiveGate(db, scope);
      if (activeGate && activeGate.gate_agent === agentType) {
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
      if (fixGateRow && fixGateRow.fixer_agent === agentType) {
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
