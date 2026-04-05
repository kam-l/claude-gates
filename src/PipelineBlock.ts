#!/usr/bin/env node
/**
 * Pipeline v3 — PreToolUse gate blocker (no matcher = all tools).
 *
 * When pipeline steps are active, blocks ALL tools except:
 *   - Tool calls from subagents (agent_type is set) — gated by SubagentStop
 *   - Read-only tools (Read, Glob, Grep) and progress tracking (TaskCreate, TaskUpdate, SendMessage)
 *   - Spawning an agent that matches ANY active pipeline's expected agent
 *
 * Also surfaces queued notifications from SubagentStop via systemMessage.
 *
 * Fail-open: no session / no DB / no active pipeline → allow.
 */

import fs from "fs";
import { Messaging, } from "./Messaging";
import { PipelineEngine, } from "./PipelineEngine";
import { PipelineRepository, } from "./PipelineRepository";
import { SessionManager, } from "./SessionManager";
import { Tracing, } from "./Tracing";
import { StepStatus, } from "./types/Enums";

const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "SendMessage", "ToolSearch",];

function sourceReason(act: any,)
{
  const step = act.step;
  if (!step)
  {
    return ".";
  }
  if (step.status === StepStatus.Fix)
  {
    return `: reviewer found issues — fixer must address them before next review round.`;
  }
  if (step.status === StepStatus.Revise)
  {
    return `: reviewer found issues — source must revise the artifact.`;
  }
  if (step.round > 0)
  {
    return `: revision round ${step.round} — address reviewer feedback.`;
  }
  return ".";
}

export async function onPreToolUse(data: any,): Promise<void>
{
  if (SessionManager.isGateDisabled())
  {
    process.exit(0,);
  }

  const sessionId = data.session_id || "";
  if (!sessionId)
  {
    process.exit(0,);
  }

  const toolName = data.tool_name || "";
  const toolInput = data.tool_input || {};
  const callerAgent = data.agent_type || "";
  let traceScopes: Record<string, string> = {}; // { scope: trace_id } — stashed before db.close()

  const sessionDir = SessionManager.getSessionDir(sessionId,);

  // Surface queued notifications from SubagentStop (side-channel)
  const pending = Messaging.drainNotifications(sessionDir,);

  let actions: any;
  let db: ReturnType<typeof SessionManager.openDatabase> | null = null;
  try
  {
    db = SessionManager.openDatabase(sessionDir,);
    PipelineRepository.initSchema(db,);
    const repo = new PipelineRepository(db,);
    const pipelineEngine = new PipelineEngine(repo,);
    actions = pipelineEngine.getAllNextActions();

    // Trace ID is now deterministic from sessionId — no DB stash needed
    traceScopes = {};
  }
  finally
  {
    db?.close();
  }

  // No active pipeline — surface any pending notifications and allow
  if (!actions || actions.length === 0)
  {
    if (pending)
    {
      Messaging.info("", pending.replace(/\[ClaudeGates\] /g, "",),);
    }
    process.exit(0,);
  }

  // Subagent calls gated by SubagentStop, not here
  if (callerAgent)
  {
    process.exit(0,);
  }

  // Read-only + progress tracking tools always allowed
  if (ALLOWED_TOOLS.includes(toolName,))
  {
    process.exit(0,);
  }

  // /unblock is user-invocable-only (model can't see it) — no Skill allowlist needed

  // Build expected agent names — Set avoids collisions when multiple scopes use the same agent name
  const expectedAgentNames = new Set<string>();

  let hasBlockingActions = false;
  for (const act of actions)
  {
    if (act.action === "spawn" || act.action === "source" || act.action === "semantic")
    {
      // Skip blocking if the expected agent is still running (marker set by conditions.js, cleared by verification.js)
      try
      {
        if (fs.existsSync(SessionManager.agentRunningMarker(sessionDir, act.scope,),))
        {
          continue;
        }
      }
      catch
      {
      }
      const agent = act.agent || (act.step && act.step.source_agent);
      if (agent)
      {
        expectedAgentNames.add(agent,);
      }
      hasBlockingActions = true;
    }
  }

  if (!hasBlockingActions)
  {
    process.exit(0,);
  }

  // Write/Edit scoped to session artifacts — allow writes to non-session paths
  if (toolName === "Write" || toolName === "Edit")
  {
    const targetPath = (toolInput.file_path || "").replace(/\\/g, "/",);
    if (targetPath && !targetPath.startsWith(sessionDir + "/",))
    {
      process.exit(0,);
    }
  }

  // Agent tool: allow expected agents (any scope expecting this agent name)
  if (toolName === "Agent")
  {
    const subagentType = toolInput.subagent_type || "";
    if (expectedAgentNames.has(subagentType,))
    {
      process.exit(0,);
    }
  }

  // Build block message — actions as clear instructions, notifications separate
  const parts: string[] = [];
  for (const act of actions)
  {
    const agent = act.agent || (act.step && act.step.source_agent);
    if (act.action === "spawn")
    {
      const isTransform = act.step && act.step.step_type === "TRANSFORM";
      const attempt = act.round + 1;
      const maxAttempts = act.maxRounds + 1;
      const reason = isTransform
        ? "transform step — auto-passes on completion"
        : attempt === 1
        ? "reviewer needs to evaluate the artifact"
        : "re-review after revision";
      parts.push(`Spawn ${agent} (scope=${act.scope}, round ${attempt}/${maxAttempts}): ${reason}.`,);
    }
    else if (act.action === "source" || act.action === "semantic")
    {
      const round = act.step ? act.step.round : 0;
      const verb = round > 0 ? "Resume" : "Spawn";
      const reason = sourceReason(act,);
      parts.push(`${verb} ${agent} (scope=${act.scope})${reason}`,);
    }
  }

  // Langfuse: trace block decisions — session-level trace with scope spans
  try
  {
    const { langfuse, enabled, } = Tracing.init();
    if (enabled)
    {
      const traceId = Tracing.sessionTraceId(sessionId,);
      const trace = langfuse.trace({ id: traceId, name: `session`, sessionId, },);
      for (const act of actions)
      {
        const scopeSpan = Tracing.scopeSpan(trace, act.scope,);
        scopeSpan.span({ name: "tool-blocked", input: { toolName, scope: act.scope, expectedAgent: act.agent, }, },).end();
        scopeSpan.end();
      }
      await Tracing.flush(langfuse, enabled,);
    }
  }
  catch
  {
  } // fail-open

  // Frame as instructions, not errors — Claude Code wraps this in "Error:" which misleads the orchestrator
  let message = `Pipeline actions pending (this is normal flow, not an error). Do these first:\n` + parts.join("\n",);

  // Append deduplicated notifications separately — don't pollute action instructions
  if (pending)
  {
    const uniqueNotes = [...new Set(pending.split("\n",).map(l => l.trim()).filter(Boolean,),),];
    message += `\nContext: ` + uniqueNotes.join(" | ",);
  }

  const out = { decision: "block", reason: Messaging.fmt("🔒", message,), };
  process.stdout.write(JSON.stringify(out,),);
  process.exit(0,);
}

// ── Entry point (thin wrapper) ──────────────────────────────────────

(async () =>
{
  try
  {
    await onPreToolUse(JSON.parse(fs.readFileSync(0, "utf-8",),),);
  }
  catch
  {
    process.exit(0,); // fail-open
  }
})();
