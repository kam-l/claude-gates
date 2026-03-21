#!/usr/bin/env node
/**
 * ClaudeGates v2 — SubagentStart injection hook.
 *
 * Injects output_filepath into agent context so the agent knows exactly
 * where to write its artifact.
 *
 * Scope resolution at SubagentStart: best-effort via DB (getPending).
 *
 * WHY NOT TRANSCRIPT: The subagent's JSONL doesn't exist yet at
 * SubagentStart — Claude Code writes the first line AFTER this hook.
 * For parallel same-type agents, getPending may return wrong scope.
 * This is acceptable: SubagentStop reads agent_transcript_path
 * (which DOES exist by then) and blocks until the artifact is at
 * the correct path. See claude-gates-verification.js for the
 * authoritative scope resolver.
 *
 * For gate agents, enhances context with source agent info.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { getDb, getAgent, getPending, getActiveGate, getFixGate } = require("./claude-gates-db.js");

/**
 * Extract scope= from a transcript JSONL file.
 * Reads the first 2KB. Returns scope string or null.
 * At SubagentStart this usually fails (file doesn't exist yet) — kept
 * as future-proofing in case Claude Code changes the write order.
 */
function extractScopeFromTranscript(transcriptPath, agentId) {
  if (!transcriptPath || !agentId) return null;
  const subagentPath = transcriptPath.replace(/\.jsonl$/, "")
    + "/subagents/agent-" + agentId + ".jsonl";
  try {
    const fd = fs.openSync(subagentPath, "r");
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
  const agentId = data.agent_id || "";
  const bareAgentType = agentType.includes(":") ? agentType.split(":").pop() : agentType;

  if (!sessionId || !agentType) process.exit(0);

  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId).replace(/\\/g, "/");

  // Try transcript first (usually fails at SubagentStart — file doesn't exist yet)
  let scope = extractScopeFromTranscript(data.transcript_path, agentId);
  let outputFilepath = "";
  let gateContext = "";

  const db = getDb(sessionDir);
  try {
    // If transcript resolved scope, look up the registered entry
    if (scope) {
      const agentRow = getAgent(db, scope, bareAgentType);
      if (agentRow && agentRow.outputFilepath) {
        outputFilepath = agentRow.outputFilepath;
      }
    }

    // Fallback: DB lookup via getPending.
    // This is the primary path at SubagentStart (transcript doesn't exist).
    // For parallel same-type agents, may return wrong scope — SubagentStop corrects.
    if (!outputFilepath) {
      const pending = getPending(db, bareAgentType);
      if (pending && pending.outputFilepath) {
        scope = pending.scope;
        outputFilepath = pending.outputFilepath;
      }
    }

    // Gate context: enhance for gate agents and fixer agents
    if (scope && outputFilepath) {
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
