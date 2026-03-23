#!/usr/bin/env node
/**
 * ClaudeGates v2 — SubagentStart injection hook.
 *
 * Injects output_filepath = {session_dir}/{agent_id}.md into agent context.
 * Uses agent_id (unique per spawn) — no DB lookup needed, no parallel collision.
 *
 * SubagentStop moves the artifact from {agent_id}.md to {scope}/{agent_type}.md
 * using the definitive scope from agent_transcript_path. This two-phase approach
 * eliminates the getPending race for parallel same-type agents:
 *   - Injection: write to unique temp path (agent_id) — collision-free
 *   - Verification: move to canonical path (scope/type) — transcript-authoritative
 *
 * Gate context (role, source_agent) is best-effort enrichment via DB.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { getDb, getPending, getActiveGate, getFixGate, getGates, initGates } = require("./claude-gates-db.js");
const { parseGates, findAgentMd } = require("./claude-gates-shared.js");

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));
  const HOME = process.env.USERPROFILE || process.env.HOME || "";

  const sessionId = data.session_id || "";
  const agentType = data.agent_type || "";
  const agentId = data.agent_id || "";

  if (!sessionId || !agentType) process.exit(0);

  const bareAgentType = agentType.includes(":") ? agentType.split(":").pop() : agentType;
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId).replace(/\\/g, "/");

  // Output path uses agent_id — unique per spawn, no collision possible.
  // SubagentStop moves this to {scope}/{agent_type}.md after resolving scope from transcript.
  const outputFilepath = agentId
    ? `${sessionDir}/${agentId}.md`
    : `${sessionDir}/${bareAgentType}.md`;

  // Best-effort gate context enrichment via DB
  let gateContext = "";
  const db = getDb(sessionDir);
  try {
    const pending = getPending(db, bareAgentType);
    if (pending && pending.scope) {
      const scope = pending.scope;

      // Initialize gates at spawn time (not completion) so gates exist
      // regardless of source verdict (PASS/FAIL/REVISE all need gates).
      const existingGates = getGates(db, scope);
      if (existingGates.length === 0) {
        const agentMdPath = findAgentMd(bareAgentType, process.cwd());
        if (agentMdPath) {
          const mdContent = fs.readFileSync(agentMdPath, "utf-8");
          const agentGates = parseGates(mdContent);
          if (agentGates) {
            initGates(db, scope, bareAgentType, agentGates);
            process.stderr.write(
              `[ClaudeGates] Initialized ${agentGates.length} gate(s) for scope "${scope}": ${agentGates.map(g => g.agent).join(" -> ")}.\n`
            );
          }
        }
      }

      const activeGate = getActiveGate(db, scope);
      if (activeGate && activeGate.gate_agent === bareAgentType) {
        // After fixer runs, reviewer should read fixer's output (latest version),
        // not the original source artifact.
        let sourceArtifact = `${sessionDir}/${scope}/${activeGate.source_agent}.md`;
        if (activeGate.fixer_agent && activeGate.round > 0) {
          const fixerArtifact = `${sessionDir}/${scope}/${activeGate.fixer_agent}.md`;
          if (fs.existsSync(fixerArtifact)) {
            sourceArtifact = fixerArtifact;
          }
        }
        gateContext =
          `role=gate\n` +
          `source_agent=${activeGate.source_agent}\n` +
          `source_artifact=${sourceArtifact}\n` +
          `gate_round=${activeGate.round}/${activeGate.max_rounds}\n`;
      }
      const fixGateRow = getFixGate(db, scope);
      if (fixGateRow && fixGateRow.fixer_agent === bareAgentType) {
        const sourceArtifact = `${sessionDir}/${scope}/${fixGateRow.source_agent}.md`;
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

  const context =
    `<agent_gate importance="critical">\n` +
    `output_filepath=${outputFilepath}\n` +
    gateContext +
    `Write your artifact to this exact path. Last line must be: Result: PASS or Result: FAIL\n` +
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
