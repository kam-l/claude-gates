#!/usr/bin/env node
/**
 * Pipeline v3 — SessionStart context injection.
 *
 * Scans for gated agents and displays a startup banner showing active gates,
 * verification pipelines, and toggle hints. Also injects behavioral guidance
 * so the orchestrator knows pipeline gates block other work.
 *
 * Fail-open.
 */

import fs from "fs";
import path from "path";
import { FrontmatterParser, } from "./FrontmatterParser";
import { SessionManager, } from "./SessionManager";
import { StepType, } from "./types/Enums";
import type { IAgentSummary, VerificationStep, } from "./types/Interfaces";

const HOME = process.env.USERPROFILE || process.env.HOME || "";
const PROJECT_ROOT = process.cwd();

// ── Exported helpers (tested in PipelineTest.ts) ─────────────────────

export function formatStep(step: VerificationStep,): string
{
  switch (step.type)
  {
    case StepType.Check:
    {
      const truncated = step.prompt.length > 40
        ? step.prompt.slice(0, 40,) + "..."
        : step.prompt;
      return `CHECK("${truncated}")`;
    }
    case StepType.Verify:
      return `VERIFY(${step.agent}, ${step.maxRounds})`;
    case StepType.VerifyWithFixer:
      return `VERIFY(${step.agent}, ${step.maxRounds}, ${step.fixer})`;
    case StepType.Transform:
      return `TRANSFORM(${step.agent})`;
  }
  return step satisfies never;
}

export function formatPipeline(steps: VerificationStep[],): string
{
  return steps.map(formatStep,).join(" \u2192 ",);
}

export function discoverGatedAgents(
  projectDir: string | null,
  globalDir: string | null,
): IAgentSummary[]
{
  const seen = new Set<string>();
  const results: IAgentSummary[] = [];

  function scanDir(dir: string, source: "project" | "global",): void
  {
    let entries: string[];
    try
    {
      entries = fs.readdirSync(dir,);
    }
    catch
    {
      return;
    }

    for (const file of entries)
    {
      if (!file.endsWith(".md",))
      {
        continue;
      }
      const name = file.slice(0, -3,);
      if (seen.has(name,))
      {
        continue;
      }

      try
      {
        const content = fs.readFileSync(path.join(dir, file,), "utf-8",);
        const steps = FrontmatterParser.parseVerification(content,);
        if (steps)
        {
          seen.add(name,);
          results.push({ name, source, steps, },);
        }
      }
      catch
      {
        // skip unreadable files
      }
    }
  }

  if (projectDir)
  {
    scanDir(path.join(projectDir, ".claude", "agents",), "project",);
  }
  if (globalDir)
  {
    scanDir(path.join(globalDir, ".claude", "agents",), "global",);
  }

  return results;
}

export function buildBanner(gateDisabled: boolean,): string
{
  const lines: string[] = [];

  lines.push(
    gateDisabled
      ? "[ClaudeGates] Session gates: PAUSED"
      : "[ClaudeGates] Session gates:",
  );

  lines.push(
    gateDisabled
      ? "  Plan Gate: OFF"
      : "  Plan Gate: ON",
  );

  const agents = discoverGatedAgents(PROJECT_ROOT, HOME,);
  if (agents.length === 0)
  {
    lines.push("  (no gated agents)",);
  }
  else
  {
    for (const agent of agents)
    {
      const suffix = agent.source === "global" ? " (global)" : "";
      lines.push(`  ${agent.name}: ${formatPipeline(agent.steps,)}${suffix}`,);
    }
  }

  lines.push(
    gateDisabled
      ? "Toggle: \"gate on\" to resume."
      : "Toggle: \"gate off\" to pause, \"gate on\" to resume.",
  );

  const port = process.env.CLAUDE_GATES_PORT || "64735";
  lines.push(`Monitor: http://localhost:${port}`,);

  return lines.join("\n",);
}

// ── Main (only when run directly, not imported) ─────────────────────

if (require.main === module)
{
  try
  {
    const gateDisabled = SessionManager.isGateDisabled();
    const banner = buildBanner(gateDisabled,);

    process.stderr.write(banner + "\n",);

    const modelContext = banner + "\n\n"
      + "Agents with `verification:` in their frontmatter have pipeline gates. "
      + "After each gated agent completes, its verification steps (reviewers, semantic checks) "
      + "will block other tools until processed. Plan accordingly: process gated agent results "
      + "before starting unrelated work. Run gated agents in foreground, not background.";

    process.stdout.write(JSON.stringify({ additionalContext: modelContext, },),);
    process.exit(0,);
  }
  catch
  {
    process.exit(0,);
  }
}
