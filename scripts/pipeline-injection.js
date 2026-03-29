#!/usr/bin/env node
/**
 * Pipeline v3 — SubagentStart injection hook.
 *
 * Semantics first, structure later: no output format or filepath constraints
 * are injected. Agents think freely. SubagentStop captures their output.
 *
 * Only injects role context for verifiers (source artifact path, round info)
 * and fixers (source artifact, gate agent info). Source agents get nothing.
 *
 * Creates pipeline from verification: steps (idempotent).
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { getDb, findAgentScope, getAgent, getActiveStep, getStepByStatus, getPipelineState } = require("./pipeline-db.js");
const { parseVerification, findAgentMd, getSessionDir } = require("./pipeline-shared.js");
const engine = require("./pipeline.js");
const msg = require("./messages.js");

const HOME = process.env.USERPROFILE || process.env.HOME || "";

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));
  const sessionId = data.session_id || "";
  const agentType = data.agent_type || "";
  const agentId = data.agent_id || "";

  if (!sessionId || !agentType) process.exit(0);

  const bareAgentType = agentType.includes(":") ? agentType.split(":").pop() : agentType;
  const sessionDir = getSessionDir(sessionId);

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
          msg.notify(sessionDir, "⚡", "pipeline", `Initialized ${steps.length} step(s) for scope="${scope}": ${steps.map(s => s.type).join(" → ")}.`);
        }
      }

      // Role-based context enrichment
      const role = engine.resolveRole(db, scope, bareAgentType);

      if (role === "verifier") {
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
            `gate_round=${activeStep.round + 1}/${activeStep.max_rounds}\n`;
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
            `gate_round=${fixStep.round + 1}/${fixStep.max_rounds}\n`;
        }
      }
      // Source in revision → inject artifact path so it knows what to revise
      if (role === "source") {
        const state = getPipelineState(db, scope);
        if (state && state.status === "revision") {
          const artifactPath = `${sessionDir}/${scope}/${bareAgentType}.md`;
          pipelineContext =
            `role=source\n` +
            `revision=true\n` +
            `artifact=${artifactPath}\n` +
            `Update your artifact at this path to address the review feedback.\n`;
        }
      }
      // source (first run) / ungated → no context injection (semantics first)
    }
  } finally {
    db.close();
  }

  // Only inject if there's role context to provide (verifier/fixer)
  if (!pipelineContext) process.exit(0);

  const context =
    `<agent_gate importance="critical">\n` +
    pipelineContext +
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
