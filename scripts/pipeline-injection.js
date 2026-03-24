#!/usr/bin/env node
/**
 * Pipeline v3 — SubagentStart injection hook.
 *
 * Injects output_filepath = {session_dir}/{agent_id}.md into agent context.
 * Uses agent_id (unique per spawn) — no parallel collision.
 *
 * SubagentStop moves the artifact from {agent_id}.md to {scope}/{agent_type}.md
 * using the definitive scope from agent_transcript_path.
 *
 * Creates pipeline from verification: steps (idempotent).
 * Enriches context for gate agents and fixers with source artifact info.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { getDb, findAgentScope, getAgent, getActiveStep, getStepByStatus, getPipelineState } = require("./pipeline-db.js");
const { parseVerification, findAgentMd } = require("./pipeline-shared.js");
const engine = require("./pipeline.js");

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

  // Best-effort pipeline creation + context enrichment via DB
  let pipelineContext = "";
  const db = getDb(sessionDir);
  try {
    // Find scope registered by conditions.js (real scope, not _pending)
    const scope = findAgentScope(db, bareAgentType);
    if (scope) {

      // Create pipeline from verification: steps (idempotent — no-op if already exists)
      const agentMdPath = findAgentMd(bareAgentType, process.cwd(), HOME);
      if (agentMdPath) {
        const mdContent = fs.readFileSync(agentMdPath, "utf-8");
        const steps = parseVerification(mdContent);
        if (steps) {
          engine.createPipeline(db, scope, bareAgentType, steps);
          process.stderr.write(
            `[Pipeline] Initialized ${steps.length} step(s) for scope "${scope}": ${steps.map(s => s.type).join(" → ")}.\n`
          );
        }
      }

      // Role-based context enrichment
      const role = engine.resolveRole(db, scope, bareAgentType);

      if (role === "gate-agent") {
        // Gate agent: inject source artifact path + round info
        const activeStep = getActiveStep(db, scope);
        if (activeStep) {
          const state = getPipelineState(db, scope);
          const sourceAgent = state ? state.source_agent : "unknown";
          // After fixer runs, reviewer reads fixer's output (latest version)
          let sourceArtifact = `${sessionDir}/${scope}/${sourceAgent}.md`;
          if (activeStep.fixer && activeStep.round > 0) {
            const fixerArtifact = `${sessionDir}/${scope}/${activeStep.fixer}.md`;
            if (fs.existsSync(fixerArtifact)) {
              sourceArtifact = fixerArtifact;
            }
          }
          pipelineContext =
            `role=gate\n` +
            `source_agent=${sourceAgent}\n` +
            `source_artifact=${sourceArtifact}\n` +
            `gate_round=${activeStep.round}/${activeStep.max_rounds}\n`;
        }
      } else if (role === "fixer") {
        // Fixer: inject source artifact + gate agent info
        const fixStep = getStepByStatus(db, scope, "fix");
        if (fixStep) {
          const state = getPipelineState(db, scope);
          const sourceAgent = state ? state.source_agent : "unknown";
          const sourceArtifact = `${sessionDir}/${scope}/${sourceAgent}.md`;
          pipelineContext =
            `role=fixer\n` +
            `source_agent=${sourceAgent}\n` +
            `source_artifact=${sourceArtifact}\n` +
            `gate_agent=${fixStep.agent}\n` +
            `gate_round=${fixStep.round}/${fixStep.max_rounds}\n`;
        }
      }
      // source / ungated → no extra context (just output_filepath)
    }
  } finally {
    db.close();
  }

  const context =
    `<agent_gate importance="critical">\n` +
    `output_filepath=${outputFilepath}\n` +
    pipelineContext +
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
