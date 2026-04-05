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
 * Pipeline creation is deferred to SubagentStop (parallel pipelines).
 *
 * Fail-open.
 */

import fs from "fs";
import path from "path";
import { PipelineEngine, } from "./PipelineEngine";
import { PipelineRepository, } from "./PipelineRepository";
import { SessionManager, } from "./SessionManager";
import { AgentRole, StepStatus, } from "./types/Enums";

const HOME = process.env.USERPROFILE || process.env.HOME || "";

export function onSubagentStart(data: any,): void
{
  if (SessionManager.isGateDisabled())
  {
    process.exit(0,);
  }

  const sessionId = data.session_id || "";
  const agentType = data.agent_type || "";

  if (!sessionId || !agentType)
  {
    process.exit(0,);
  }

  const bareAgentType = agentType.includes(":",) ? agentType.split(":",).pop() : agentType;
  const sessionDir = SessionManager.getSessionDir(sessionId,);

  // Context enrichment via DB (pipeline creation deferred to SubagentStop)
  let pipelineContext = "";
  let db: ReturnType<typeof SessionManager.openDatabase> | null = null;
  try
  {
    db = SessionManager.openDatabase(sessionDir,);
    PipelineRepository.initSchema(db,);
    const repo = new PipelineRepository(db,);
    const pipelineEngine = new PipelineEngine(repo,);
    // Find scope: prefer pending marker (accurate for parallel agents), fall back to DB
    let scope: string | null = null;
    const pendingMarker = path.join(sessionDir, `.pending-scope-${bareAgentType}`,);
    try
    {
      if (fs.existsSync(pendingMarker,))
      {
        scope = fs.readFileSync(pendingMarker, "utf-8",).trim();
        fs.unlinkSync(pendingMarker,);
      }
    }
    catch
    {
    }
    if (!scope)
    {
      scope = repo.findAgentScope(bareAgentType,);
    }
    if (scope)
    {
      // Pipeline creation is deferred to SubagentStop (enables parallel source agents).
      // SubagentStart only enriches context for verifiers/fixers whose pipelines already exist.

      // Role-based context enrichment
      const role = pipelineEngine.resolveRole(scope, bareAgentType,);

      if (role === AgentRole.Verifier)
      {
        // Gate agent: inject source artifact path + round info
        const activeStep = repo.getActiveStep(scope,);
        if (activeStep)
        {
          const state = repo.getPipelineState(scope,);
          const sourceAgent = state ? state.source_agent : "unknown";
          // After fixer runs, reviewer reads fixer's output (latest version)
          let sourceArtifact = `${sessionDir}/${scope}/${sourceAgent}.md`;
          if (activeStep.fixer && activeStep.round > 0)
          {
            const fixerArtifact = `${sessionDir}/${scope}/${activeStep.fixer}.md`;
            if (fs.existsSync(fixerArtifact,))
            {
              sourceArtifact = fixerArtifact;
            }
          }
          pipelineContext = `role=gate\n`
            + `session_id=${sessionId}\n`
            + `scope=${scope}\n`
            + `source_agent=${sourceAgent}\n`
            + `source_artifact=${sourceArtifact}\n`
            + `gate_round=${activeStep.round + 1}/${activeStep.max_rounds}\n`;
        }
      }
      else if (role === AgentRole.Fixer)
      {
        // Fixer: inject source artifact + gate agent info
        const fixStep = repo.getStepByStatus(scope, StepStatus.Fix,);
        if (fixStep)
        {
          const state = repo.getPipelineState(scope,);
          const sourceAgent = state ? state.source_agent : "unknown";
          const sourceArtifact = `${sessionDir}/${scope}/${sourceAgent}.md`;
          pipelineContext = `role=fixer\n`
            + `session_id=${sessionId}\n`
            + `scope=${scope}\n`
            + `source_agent=${sourceAgent}\n`
            + `source_artifact=${sourceArtifact}\n`
            + `gate_agent=${fixStep.agent}\n`
            + `gate_round=${fixStep.round + 1}/${fixStep.max_rounds}\n`;
        }
      }
      // Verification file exists → inject it (file existence IS the signal)
      try
      {
        const verificationFile = path.join(sessionDir, scope, `${bareAgentType}-verification.md`,);
        if (fs.existsSync(verificationFile,))
        {
          const findings = fs.readFileSync(verificationFile, "utf-8",);
          pipelineContext += `artifact=${sessionDir}/${scope}/${bareAgentType}.md\n`
            + `\nReviewer findings (address ALL issues before resubmitting):\n${findings}\n`;
        }
      }
      catch
      {
      }
      // source (first run) / ungated → no context injection (semantics first)
    }
  }
  finally
  {
    db?.close();
  }

  // Only inject if there's role context to provide (verifier/fixer)
  if (!pipelineContext)
  {
    process.exit(0,);
  }

  const context = `<agent_gate importance="critical">\n`
    + pipelineContext
    + `</agent_gate>`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: context,
    },
  },),);
  process.exit(0,);
}

// ── Entry point (thin wrapper) ──────────────────────────────────────

try
{
  onSubagentStart(JSON.parse(fs.readFileSync(0, "utf-8",),),);
}
catch
{
  process.exit(0,);
}
