#!/usr/bin/env node
/**
 * Pipeline v3 — PreToolUse:Agent conditions hook.
 *
 * Checks `conditions:` and pipeline step enforcement before
 * allowing an agent to spawn. Extracts `scope=<name>` from the agent's prompt.
 *
 * Flow:
 *   1. Resume? → allow (no gating on resumed agents)
 *   2. No agent type? → allow
 *   3. Find agent .md → parse frontmatter
 *   4. No scope + requiresScope → BLOCK
 *   5. No scope + no CG fields → allow (backward compatible)
 *   6. Conditions: semantic pre-check via claude -p
 *   7. Step enforcement: engine.getAllNextActions() → only expected agents per-scope
 *   8. Register scope in SQLite
 *
 * Fail-open.
 */

import { execSync, } from "child_process";
import fs from "fs";
import path from "path";
import { FrontmatterParser, } from "./FrontmatterParser";
import { Messaging, } from "./Messaging";
import { PipelineEngine, } from "./PipelineEngine";
import { PipelineRepository, } from "./PipelineRepository";
import { SessionManager, } from "./SessionManager";
import { Tracing, } from "./Tracing";

const HOME = process.env.USERPROFILE || process.env.HOME || "";
const PROJECT_ROOT = process.cwd();

export function onConditionsCheck(data: any,): void
{
  // PreToolUse:Agent provides tool_input with prompt and subagent_type
  const toolInput = data.tool_input || {};
  const agentType = toolInput.subagent_type || "";
  const prompt = toolInput.prompt || "";

  // Resume → allow (no gating)
  if (toolInput.resume)
  {
    process.exit(0,);
  }

  // No agent type → allow
  if (!agentType)
  {
    process.exit(0,);
  }

  // Normalize agent type (strip plugin prefix)
  const bareAgentType = agentType.includes(":",) ? agentType.split(":",).pop() : agentType;

  // Find agent definition
  const agentMdPath = FrontmatterParser.findAgentMd(bareAgentType, PROJECT_ROOT, HOME,);
  let mdContent: string | null = null;
  if (agentMdPath)
  {
    mdContent = fs.readFileSync(agentMdPath, "utf-8",);
  }

  // Extract scope
  const scopeMatch = prompt.match(/scope=([A-Za-z0-9_-]+)/,);
  const scope = scopeMatch ? scopeMatch[1] : null;

  // No scope handling
  if (!scope)
  {
    if (mdContent && FrontmatterParser.requiresScope(mdContent,))
    {
      Messaging.block("🔏", `Agent "${bareAgentType}" needs scope=<name>. Add it to the spawn prompt.`,);
    }
    process.exit(0,);
  }

  // Reject reserved scope names
  if (scope === "_pending" || scope === "_meta")
  {
    process.exit(0,);
  }

  // No agent .md → no gate
  if (!agentMdPath || !mdContent)
  {
    process.exit(0,);
  }

  // Session dir
  const sessionId = data.session_id || "";
  if (!sessionId)
  {
    process.exit(0,);
  }
  const sessionDir = SessionManager.getSessionDir(sessionId,);

  // ── Semantic pre-check (conditions:) ──
  const conditions = FrontmatterParser.parseConditions(mdContent,);
  if (conditions)
  {
    try
    {
      const condPrompt = conditions + "\n\nAgent spawn prompt:\n" + prompt;
      const condResult = execSync(
        "claude -p --model sonnet --agent claude-gates:gater --max-turns 1 --tools \"\" --no-chrome --strict-mcp-config --disable-slash-commands --no-session-persistence",
        {
          input: condPrompt,
          cwd: PROJECT_ROOT,
          timeout: 30000,
          encoding: "utf-8",
          shell: true as any,
          env: { ...process.env, CLAUDECODE: "", },
        },
      ).trim();
      const condMatch = /^Result:\s*(PASS|FAIL|REVISE|CONVERGED)\b(.*)?$/mi.exec(condResult,);
      const condRaw = condMatch ? condMatch[1].toUpperCase() : "UNKNOWN";
      const condVerdict = (condRaw === "FAIL" || condRaw === "REVISE") ? "FAIL" : "PASS";
      if (condVerdict === "FAIL")
      {
        const reason = condMatch![2] ? condMatch![2].trim() : "Pre-spawn conditions check failed";
        Messaging.block("🔏", `Failed for ${bareAgentType}: ${reason}`,);
        process.exit(0,);
      }
      Messaging.log("✅", `${condVerdict} for ${bareAgentType}`,);
    }
    catch
    {
      // Semantic check failed — fail-open
      Messaging.log("⚠️", `Skipped for ${bareAgentType} (claude -p unavailable)`,);
    }
  }

  // ── Step enforcement via engine ──
  const db = SessionManager.openDatabase(sessionDir,);
  PipelineRepository.initSchema(db,);
  const repo = new PipelineRepository(db,);
  const pipelineEngine = new PipelineEngine(repo,);
  try
  {
    const actions = pipelineEngine.getAllNextActions();

    if (actions && actions.length > 0)
    {
      // Check if any action expects this agent type for this scope
      const scopeAction = actions.find(a => a.scope === scope);

      if (scopeAction)
      {
        // spawn/source → only the expected agent
        if (scopeAction.action === "spawn" || scopeAction.action === "source")
        {
          if (scopeAction.agent !== bareAgentType)
          {
            Messaging.block("🔏", `Scope "${scope}" expects "${scopeAction.agent}", not "${bareAgentType}". Spawn ${scopeAction.agent}.`,);
            db.close();
            process.exit(0,);
          }
        }
        // semantic → block agent spawns (runs at SubagentStop)
        else if (scopeAction.action === "semantic")
        {
          // Semantic steps fire after source completion at SubagentStop.
          // If we're here, a new agent is being spawned for this scope — allow it
          // (it's likely the source agent being spawned for the first time).
        }
      }
      // No action for this scope — allow (parallel pipelines supported)
    }

    // Create scope dir if first agent
    const scopeDir = path.join(sessionDir, scope,);
    if (!fs.existsSync(scopeDir,))
    {
      fs.mkdirSync(scopeDir, { recursive: true, },);
    }

    // Register agent
    const outputFilepath = path.join(scopeDir, `${bareAgentType}.md`,).replace(/\\/g, "/",);
    repo.registerAgent(scope, bareAgentType, outputFilepath,);
    Tracing.trace(sessionDir, "spawn.allow", scope, { agent: bareAgentType, },);

    // Mark agent as running — pipeline-block skips blocking while marker exists
    try
    {
      fs.writeFileSync(SessionManager.agentRunningMarker(sessionDir, scope,), "", "utf-8",);
    }
    catch
    {
    }

    // Write pending scope marker — SubagentStart (injection) reads this to resolve scope
    // (SubagentStart doesn't have the prompt, so it can't extract scope= itself)
    try
    {
      fs.writeFileSync(path.join(sessionDir, `.pending-scope-${bareAgentType}`,), scope, "utf-8",);
    }
    catch
    {
    }

    // Warn orchestrator that this agent's pipeline will block other work
    if (mdContent && FrontmatterParser.requiresScope(mdContent,))
    {
      Messaging.log(
        "🔏",
        `${bareAgentType} (scope=${scope}) has verification gates — process its results before starting unrelated work.`,
      );
    }
  }
  finally
  {
    db.close();
  }

  // Allow
  process.exit(0,);
}

// ── Entry point (thin wrapper) ──────────────────────────────────────

try
{
  onConditionsCheck(JSON.parse(fs.readFileSync(0, "utf-8",),),);
}
catch
{
  process.exit(0,);
}
