#!/usr/bin/env node
/**
 * Pipeline v3 — SubagentStop verification hook (BLOCKING).
 *
 * Two-layer verification:
 *   Layer 1 (deterministic): file exists, MCP verdict recorded, scope registered
 *   Layer 2 (semantic): claude -p judges whether content is substantive
 *
 * Scope resolution (parallel-safe):
 *   Primary: agent_transcript_path (subagent's own JSONL, first line has scope=)
 *   Fallback: extractArtifactPath (parse scope from last_assistant_message)
 *   Fallback: findAgentScope (DB lookup)
 *
 * Role dispatch via PipelineEngine.resolveRole() + step():
 *   source     → CHECK step check + engine.step({ role: 'source', ... })
 *   verifier   → implicit semantic + engine.step or retryGateAgent (semantic FAIL)
 *   fixer      → implicit semantic + engine.step({ role: 'fixer', ... })
 *   ungated    → exit(0)
 *
 * Engine is a pure state machine — semantic verdict resolution (gater quality check)
 * is handled here in the hook layer BEFORE calling engine.step().
 *
 * Gater verdicts: recorded via MCP gate_verdict (scope=verify-plan) — no regex fallback.
 *
 * Fail-open on infrastructure errors. Hard-block on intentional gates.
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
import { AgentRole, PipelineStatus, StepType, } from "./types/Enums";
import type { VerificationStep, } from "./types/Interfaces";

const PROJECT_ROOT = process.cwd();
const HOME = process.env.USERPROFILE || process.env.HOME || "";

/**
 * Extract scope= from a transcript JSONL file (first 2KB).
 */
function extractScopeFromTranscript(transcriptPath: string | null,): string | null
{
  if (!transcriptPath)
  {
    return null;
  }
  try
  {
    const fd = fs.openSync(transcriptPath, "r",);
    const buf = Buffer.alloc(2048,);
    const bytesRead = fs.readSync(fd, buf, 0, 2048, 0,);
    fs.closeSync(fd,);
    const match = buf.toString("utf-8", 0, bytesRead,).match(/scope=([A-Za-z0-9_-]+)/,);
    return match ? match[1] : null;
  }
  catch
  {
  }
  return null;
}

/**
 * Extract artifact path from the agent's last message.
 * Looks for: {session_dir}/{scope}/{agent_type}.md
 */
function extractArtifactPath(message: string, sessionDir: string, agentType: string,): { artifactPath: string; scope: string; } | null
{
  const normalizedDir = sessionDir.replace(/\\/g, "/",);
  const escapedDir = normalizedDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&",);
  const bareType = agentType.includes(":",) ? agentType.split(":",).pop() : agentType;
  const pattern = new RegExp(
    escapedDir + "/([A-Za-z0-9_-]+)/" + bareType!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&",) + "\\.md",
    "i",
  );
  const match = message.replace(/\\/g, "/",).match(pattern,);
  if (match && match[1] !== "_pending")
  {
    return { artifactPath: path.join(sessionDir, match[1], `${bareType}.md`,), scope: match[1], };
  }
  return null;
}

/**
 * Record a structured verdict object (SQLite).
 */
function recordVerdict(
  repo: PipelineRepository,
  scope: string,
  agentType: string,
  verdict: string,
): { verdict: string; round: number; } | null
{
  if (!scope)
  {
    return null;
  }
  try
  {
    const bare = agentType.includes(":",) ? agentType.split(":",).pop()! : agentType;
    const existing = repo.getAgent(scope, bare,);
    const round = (existing && existing.round) ? existing.round + 1 : 1;
    repo.setVerdict(scope, bare, verdict, round,);
    return { verdict, round, };
  }
  catch
  {
    return null;
  }
}

/**
 * Ensure MCP config file exists in session dir (reusable across calls).
 * Points to the claude-gates MCP server script.
 */
function ensureMcpConfig(sessionDir: string,): string
{
  const mcpConfigPath = path.join(sessionDir, "mcp-config.json",);
  if (!fs.existsSync(mcpConfigPath,))
  {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || PROJECT_ROOT;
    const serverScript = path.join(pluginRoot, "scripts", "mcp-server.js",).replace(/\\/g, "/",);
    const config = {
      mcpServers: {
        "claude-gates": {
          command: "node",
          args: [serverScript,],
        },
      },
    };
    if (!fs.existsSync(sessionDir,))
    {
      fs.mkdirSync(sessionDir, { recursive: true, },);
    }
    fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2,), "utf-8",);
  }
  return mcpConfigPath.replace(/\\/g, "/",);
}

/**
 * Run claude -p semantic validation. Returns { verdict: 'PASS'|'FAIL', reason } or null on skip.
 *
 * When sessionId and scope are provided, the gater gets MCP access (gate_verdict tool)
 * and can submit verdicts structurally instead of writing "Result:" prose.
 */
function runSemanticCheck(
  prompt: string,
  artifactContent: string,
  artifactPath: string,
  contextContent: string,
  isReview: boolean,
  sessionId?: string,
  scope?: string,
): { verdict: string; reason: string; fullResponse: string; } | null
{
  let combinedPrompt = prompt + "\n\n";
  if (isReview)
  {
    combinedPrompt += `NOTE: This artifact is a REVIEW or FIX of another artifact, not primary content. `
      + `Judge whether this review/fix is well-structured, specific, and actionable. `
      + `Negative findings about the SOURCE artifact are expected and correct — do not penalize the reviewer for identifying problems.\n\n`;
  }
  combinedPrompt += `--- ${path.basename(artifactPath,)} ---\n${artifactContent}\n`;
  if (contextContent)
  {
    combinedPrompt += contextContent;
  }

  // Include session_id and scope so gater can call gate_verdict via MCP
  if (sessionId && scope)
  {
    combinedPrompt += `\nsession_id=${sessionId}\nscope=${scope}\n`;
  }

  // Build command — use MCP config when session context is available
  const sessionDir = sessionId ? SessionManager.getSessionDir(sessionId,) : null;
  let cmd: string;
  let timeout: number;
  if (sessionDir && sessionId && scope)
  {
    const mcpConfigPath = ensureMcpConfig(sessionDir,);
    cmd =
      `claude -p --model sonnet --agent claude-gates:gater --max-turns 5 --tools "mcp__claude-gates__*" --mcp-config ${mcpConfigPath} --no-chrome --strict-mcp-config --disable-slash-commands --no-session-persistence`;
    timeout = 180000;
  }
  else
  {
    cmd =
      `claude -p --model sonnet --agent claude-gates:gater --max-turns 1 --tools "" --no-chrome --strict-mcp-config --disable-slash-commands --no-session-persistence`;
    timeout = 90000;
  }

  try
  {
    const result = execSync(cmd, {
      input: combinedPrompt,
      cwd: PROJECT_ROOT,
      timeout,
      encoding: "utf-8",
      shell: true as any,
      env: { ...process.env, CLAUDECODE: "", },
    },).trim();

    // Try Result: line first (gater may still write prose)
    const match = /^Result:\s*(PASS|FAIL|REVISE|CONVERGED)\b(.*)?$/mi.exec(result,);
    if (match)
    {
      const raw = match[1].toUpperCase();
      const verdict = (raw === "PASS" || raw === "CONVERGED") ? "PASS" : "FAIL";
      return { verdict, reason: match[2] ? match[2].trim() : "", fullResponse: result, };
    }

    // No Result: line — gater may have used gate_verdict MCP instead.
    // Check DB for recorded verdict.
    if (sessionId && scope)
    {
      try
      {
        const checkDb = SessionManager.openDatabase(SessionManager.getSessionDir(sessionId,),);
        PipelineRepository.initSchema(checkDb,);
        const checkRepo = new PipelineRepository(checkDb,);
        try
        {
          const activeStep = checkRepo.getActiveStep(scope,);
          const agent = activeStep ? (activeStep.agent || activeStep.source_agent) : null;
          if (agent)
          {
            const agentRow = checkRepo.getAgent(scope, agent,);
            if (agentRow && agentRow.verdict)
            {
              const raw = agentRow.verdict.toUpperCase();
              const verdict = (raw === "PASS" || raw === "CONVERGED") ? "PASS" : "FAIL";
              process.stderr.write(`[ClaudeGates] MCP verdict from DB: ${verdict} (agent=${agent})\n`,);
              return { verdict, reason: "via gate_verdict MCP", fullResponse: result, };
            }
          }
        }
        finally
        {
          checkDb.close();
        }
      }
      catch
      {
      }
    }

    process.stderr.write(
      `[ClaudeGates] ⚠️ Semantic check: no verdict (Result: line or MCP) for ${path.basename(artifactPath,)} (${result.length} chars)\n`,
    );
    return null;
  }
  catch (err: any)
  {
    const timeoutSec = timeout / 1000;
    const reason = err.killed ? `timeout (${timeoutSec}s)` : `exit ${err.status}`;
    process.stderr.write(`[ClaudeGates] ⚠️ Semantic check failed (${reason}) for ${path.basename(artifactPath,)}\n`,);
    return null; // fail-open
  }
}

/**
 * Write audit trail file.
 */
function writeAudit(
  sessionDir: string,
  scope: string | null,
  agentType: string,
  artifactPath: string,
  semanticResult: { verdict: string; reason: string; fullResponse: string; } | null,
)
{
  try
  {
    const auditDir = scope ? path.join(sessionDir, scope,) : sessionDir;
    if (!fs.existsSync(auditDir,))
    {
      fs.mkdirSync(auditDir, { recursive: true, },);
    }
    const auditFile = path.join(auditDir, `${agentType}-verification.md`,);
    fs.writeFileSync(
      auditFile,
      `# Pipeline: ${agentType}\n`
        + `- **Timestamp:** ${new Date().toISOString()}\n`
        + `- **Artifact:** ${artifactPath.replace(/\\/g, "/",)}\n`
        + (scope ? `- **Scope:** ${scope}\n` : "")
        + `- **Verdict:** ${semanticResult ? semanticResult.verdict : "UNKNOWN"}\n`
        + `- **Reason:** ${semanticResult && semanticResult.reason ? semanticResult.reason : "N/A"}\n`
        + `- **Full response:**\n\`\`\`\n${semanticResult ? semanticResult.fullResponse : "(skipped)"}\n\`\`\`\n`,
      "utf-8",
    );
  }
  catch
  {
  } // non-fatal
}

/**
 * Gather scope context (all .md files in scope dir, excluding self and audits).
 */
function gatherScopeContext(sessionDir: string, scope: string | null, agentType: string,): string
{
  if (!scope)
  {
    return "";
  }
  const bare = agentType.includes(":",) ? agentType.split(":",).pop() : agentType;
  let context = "";
  try
  {
    const scopeDir = path.join(sessionDir, scope,);
    for (const file of fs.readdirSync(scopeDir,))
    {
      if (!file.endsWith(".md",) || file === `${bare}.md` || file === `${bare}-verification.md`)
      {
        continue;
      }
      try
      {
        context += `\n--- ${scope}/${file} ---\n${fs.readFileSync(path.join(scopeDir, file,), "utf-8",)}\n`;
      }
      catch
      {
      }
    }
  }
  catch
  {
  }
  return context;
}

function notifyVerify(sessionDir: string, reason: string,)
{
  Messaging.notify(sessionDir, "🔐", reason,);
}

// ── Handler (exported for hook-handler barrel + testing) ────────────

export function onSubagentStop(data: any,): void
{
  const isContinuation = !!data.stop_hook_active;

  const agentType = data.agent_type || "";
  if (!agentType)
  {
    process.exit(0,);
  }
  const bareAgentType = agentType.includes(":",) ? agentType.split(":",).pop() : agentType;

  const agentId = data.agent_id || "unknown";
  const sessionId = data.session_id || "unknown";
  const sessionDir = SessionManager.getSessionDir(sessionId,);
  const lastMessage = data.last_assistant_message || "";

  // Gater verdict recording: MCP gate_verdict (scope=verify-plan) handles plan-gate verdicts.
  // No regex fallback needed — gaters call gate_verdict directly via MCP.
  // Fall through — pipeline-participant gaters need engine.step().

  // Find agent definition
  const agentMdPath = FrontmatterParser.findAgentMd(bareAgentType, PROJECT_ROOT, HOME,);
  const mdContent = agentMdPath ? fs.readFileSync(agentMdPath, "utf-8",) : null;

  // ── Scope resolution (parallel-safe, three-tier fallback) ──
  const transcriptScope = extractScopeFromTranscript(data.agent_transcript_path,)
    || extractScopeFromTranscript(
      data.transcript_path && agentId !== "unknown"
        ? data.transcript_path.replace(/\.jsonl$/, "",) + "/subagents/agent-" + agentId + ".jsonl"
        : null,
    );

  const db = SessionManager.openDatabase(sessionDir,);
  PipelineRepository.initSchema(db,);
  const repo = new PipelineRepository(db,);
  const pipelineEngine = new PipelineEngine(repo,);

  try
  {
    // Resolve artifact: existing file → pivot agent to write one
    let scope = transcriptScope;
    let artifactPath: string | null = null;

    // Read agent-running marker mtime (agent spawn time) before artifact resolution
    let agentSpawnTime = 0;
    if (scope)
    {
      const markerPath = SessionManager.agentRunningMarker(sessionDir, scope,);
      try
      {
        agentSpawnTime = fs.statSync(markerPath,).mtimeMs;
      }
      catch
      {
      }
      try
      {
        fs.unlinkSync(markerPath,);
      }
      catch
      {
      }
    }

    if (scope)
    {
      const correctPath = path.join(sessionDir, scope, `${bareAgentType}.md`,);
      const tempPath = path.join(sessionDir, `${agentId}.md`,);
      const scopeDir = path.dirname(correctPath,);

      if (fs.existsSync(tempPath,))
      {
        // Agent wrote to temp path (via output_filepath), move to canonical
        if (!fs.existsSync(scopeDir,))
        {
          fs.mkdirSync(scopeDir, { recursive: true, },);
        }
        try
        {
          fs.copyFileSync(tempPath, correctPath,);
          fs.unlinkSync(tempPath,);
        }
        catch
        {
        }
      }
      else if (lastMessage)
      {
        if (!fs.existsSync(scopeDir,))
        {
          fs.mkdirSync(scopeDir, { recursive: true, },);
        }
        if (!fs.existsSync(correctPath,) && !isContinuation)
        {
          // First stop, no artifact file — pivot: tell agent to write it
          // Include verification context so agent knows what it'll be judged on
          const writePath = correctPath.replace(/\\/g, "/",);
          let pivotMsg = `Your work is done. Write your complete findings to: ${writePath}`;
          pivotMsg +=
            `\nThis artifact will be verified. Include evidence from tool output (file reads, diffs, test results) — assertions without evidence will be rejected.`;
          try
          {
            const role = pipelineEngine.resolveRole(scope, bareAgentType,);
            const activeStep = repo.getActiveStep(scope,);
            if (role === AgentRole.Verifier)
            {
              pivotMsg += `\nYou are a verifier. End with exactly one: Result: PASS, Result: REVISE, Result: FAIL, or Result: CONVERGED.`;
            }
            else if (activeStep && activeStep.step_type === StepType.Check && activeStep.prompt)
            {
              pivotMsg += `\nVerification criteria: ${activeStep.prompt}`;
            }
            else if (activeStep && (activeStep.step_type === StepType.Verify || activeStep.step_type === StepType.VerifyWithFixer))
            {
              pivotMsg += `\nA reviewer (${activeStep.agent}) will evaluate this artifact next.`;
            }
          }
          catch
          {
          }
          process.stdout.write(JSON.stringify({
            decision: "block",
            reason: `[ClaudeGates] ${pivotMsg}`,
          },),);
          process.exit(0,);
        }
        else if (!fs.existsSync(correctPath,) && isContinuation)
        {
          // Continuation but agent still didn't write file — fallback to lastMessage
          fs.writeFileSync(correctPath, lastMessage, "utf-8",);
        }
        else if (fs.existsSync(correctPath,) && agentSpawnTime > 0)
        {
          // File exists — check if agent updated it during THIS run
          try
          {
            const fileMtime = fs.statSync(correctPath,).mtimeMs;
            if (fileMtime < agentSpawnTime)
            {
              // Stale from previous round — overwrite with current output
              fs.writeFileSync(correctPath, lastMessage, "utf-8",);
            }
          }
          catch
          {
          }
        }
      }

      if (fs.existsSync(correctPath,))
      {
        artifactPath = correctPath;
      }
    }

    // Fallback: extract scope from last message
    if (!scope)
    {
      const info = extractArtifactPath(lastMessage, sessionDir, agentType,);
      if (info)
      {
        scope = info.scope;
        artifactPath = info.artifactPath;
      }
    }

    // Fallback: DB lookup
    if (!scope)
    {
      scope = repo.findAgentScope(bareAgentType,);
      if (scope)
      {
        artifactPath = path.join(sessionDir, scope, `${bareAgentType}.md`,);
        if (!fs.existsSync(artifactPath,))
        {
          artifactPath = null;
        }
      }
    }

    // ── Deferred pipeline creation (parallel-safe) ──
    // Pipeline is created here (SubagentStop) instead of SubagentStart so that
    // multiple source agents with different scopes can run in parallel.
    if (scope && mdContent)
    {
      const steps: VerificationStep[] | null = FrontmatterParser.parseVerification(mdContent,);
      if (steps && !repo.pipelineExists(scope,))
      {
        pipelineEngine.createPipeline(scope, bareAgentType, steps,);
        Tracing.trace(sessionDir, "pipeline.create", scope, { source: bareAgentType, steps: steps.map(s => s.type), },);
        Messaging.notify(
          sessionDir,
          "⚡",
          `pipeline: Initialized ${steps.length} step(s) for scope="${scope}": ${steps.map(s => s.type).join(" → ",)}.`,
        );
      }
    }

    // ── Role resolution ──
    // Called for ALL agents regardless of frontmatter. Role depends on pipeline_steps, not agent definition.
    const role = scope ? pipelineEngine.resolveRole(scope, bareAgentType,) : AgentRole.Ungated;

    if (role === AgentRole.Ungated)
    {
      // Check if agent has verification: but no scope — block
      if (mdContent)
      {
        const steps = FrontmatterParser.parseVerification(mdContent,);
        if (steps && !scope)
        {
          notifyVerify(sessionDir, `Agent "${bareAgentType}" has verification: but no scope. Add scope=<name> to the spawn prompt.`,);
        }
      }
      process.exit(0,);
    }

    // Artifact missing — treat as FAIL to avoid deadlock (step stays "active" forever otherwise)
    if (!artifactPath || !fs.existsSync(artifactPath,))
    {
      if (scope)
      {
        const expectedPath = `${sessionDir.replace(/\\/g, "/",)}/${scope}/${bareAgentType}.md`;
        notifyVerify(sessionDir, `${bareAgentType} completed without artifact. Treating as FAIL. Expected: ${expectedPath}`,);
        Tracing.trace(sessionDir, "verdict.no-artifact", scope, { agent: bareAgentType, role, },);
        pipelineEngine.step(scope, { role, artifactVerdict: "FAIL", },);
      }
      process.exit(0,);
    }

    const artifactContent = fs.readFileSync(artifactPath, "utf-8",);

    // Extract artifact verdict — what the agent decided (e.g. reviewer's PASS/REVISE).
    // This is distinct from the semantic verdict (gater's quality assessment of the review).
    const artifactVerdictMatch = /^(?:\*{0,2})(?:Result|Verdict):?\s*(PASS|FAIL|REVISE|CONVERGED)/mi.exec(artifactContent,);
    const artifactVerdict = artifactVerdictMatch ? artifactVerdictMatch[1].toUpperCase() : "UNKNOWN";

    // Scope context for semantic checks
    const scopeContext = gatherScopeContext(sessionDir, scope, agentType,);

    // ── Langfuse tracing ──
    const { langfuse, enabled, } = Tracing.init();
    const trace = Tracing.getOrCreateTrace(langfuse, enabled, db, scope!, sessionId,);

    // ── Dispatch by role ──

    if (role === AgentRole.Transformer)
    {
      handleTransformer(repo, pipelineEngine, scope!, bareAgentType, artifactPath, sessionDir, trace,);
    }
    else if (role === AgentRole.Source)
    {
      handleSource(
        repo,
        pipelineEngine,
        scope!,
        bareAgentType,
        artifactPath,
        artifactContent,
        artifactVerdict,
        scopeContext,
        sessionDir,
        sessionId,
        trace,
      );
    }
    else if (role === AgentRole.Verifier)
    {
      handleVerifier(
        repo,
        pipelineEngine,
        scope!,
        bareAgentType,
        artifactPath,
        artifactContent,
        artifactVerdict,
        scopeContext,
        sessionDir,
        sessionId,
        trace,
        false,
      );
    }
    else if (role === AgentRole.Fixer)
    {
      handleFixer(
        repo,
        pipelineEngine,
        scope!,
        bareAgentType,
        artifactPath,
        artifactContent,
        artifactVerdict,
        scopeContext,
        sessionDir,
        sessionId,
        trace,
      );
    }

    Tracing.flush(langfuse, enabled,);
  }
  finally
  {
    db.close();
  }

  process.exit(0,);
}

// ── Entry point (thin wrapper) ──────────────────────────────────────

try
{
  onSubagentStop(JSON.parse(fs.readFileSync(0, "utf-8",),),);
}
catch (err: any)
{
  Messaging.log("⚠️", `Error: ${err?.message}`,);
  process.exit(0,); // fail-open
}

// ── Role handlers ────────────────────────────────────────────────────

function handleSource(
  repo: PipelineRepository,
  pipelineEngine: PipelineEngine,
  scope: string,
  agentType: string,
  artifactPath: string,
  artifactContent: string,
  artifactVerdict: string,
  scopeContext: string,
  sessionDir: string,
  sessionId: string,
  trace: any,
)
{
  // If pipeline is in revision state, reactivate the step FIRST.
  // This ensures the CHECK step is "active" again before we check for it.
  const state = repo.getPipelineState(scope,);
  if (state && state.status === PipelineStatus.Revision)
  {
    const nextAction = pipelineEngine.step(scope, { role: "source", artifactVerdict, },);
    // If reactivated step is CHECK, fall through to run semantic check below.
    // Otherwise (VERIFY/done), log and return — no semantic check needed.
    if (!nextAction || nextAction.action !== "semantic")
    {
      recordVerdict(repo, scope, agentType, artifactVerdict,);
      logAction(sessionDir, nextAction, scope,);
      trace.span({
        name: "engine-step",
        input: { role: "source", artifactVerdict, },
        output: { action: nextAction && nextAction.action, },
      },).end();
      return;
    }
    // Fall through: CHECK step reactivated, run the check now
  }

  // Check if active step is CHECK — run semantic check with step's prompt
  const activeStep = repo.getActiveStep(scope,);
  let semanticVerdict: string | null = null;
  let semanticResult: { verdict: string; reason: string; fullResponse: string; } | null = null;

  if (activeStep && activeStep.step_type === StepType.Check && activeStep.prompt)
  {
    semanticResult = runSemanticCheck(activeStep.prompt, artifactContent, artifactPath, scopeContext, false, sessionId, scope,);
    writeAudit(sessionDir, scope, agentType, artifactPath, semanticResult,);
    semanticVerdict = semanticResult ? semanticResult.verdict : null;
    trace.span({ name: "semantic-check", input: { prompt: activeStep.prompt, }, output: { verdict: semanticVerdict, }, },).end();
  }

  // Source agents produce artifacts — they don't judge themselves.
  // Only verification steps CHECK/VERIFY) determine PASS/FAIL.
  // Source Result: line is recorded but doesn't drive pipeline flow.
  const finalVerdict = (semanticVerdict === "FAIL") ? "FAIL" : "PASS";
  recordVerdict(repo, scope, agentType, finalVerdict,);

  // Engine call — for normal state, processes verdict on active step
  const nextAction = pipelineEngine.step(scope, { role: "source", artifactVerdict: finalVerdict, },);
  Tracing.trace(sessionDir, "engine.step", scope, {
    agent: agentType,
    role: "source",
    verdict: finalVerdict,
    semanticVerdict,
    action: nextAction && nextAction.action,
  },);
  logAction(sessionDir, nextAction, scope,);
  trace.span({
    name: "engine-step",
    input: { role: "source", artifactVerdict: finalVerdict, },
    output: { action: nextAction && nextAction.action, },
  },).end();

  if (finalVerdict === "FAIL")
  {
    const reason = semanticResult && semanticResult.reason ? semanticResult.reason : "Semantic validation failed";
    Messaging.notify(sessionDir, "", `${reason}`,);
  }
}

function handleVerifier(
  repo: PipelineRepository,
  pipelineEngine: PipelineEngine,
  scope: string,
  agentType: string,
  artifactPath: string,
  artifactContent: string,
  artifactVerdict: string,
  scopeContext: string,
  sessionDir: string,
  sessionId: string,
  trace: any,
  _mcpVerdictPreExisted: boolean,
)
{
  // Implicit semantic check for gate agents.
  // The gater (claude -p) runs here — may call gate_verdict MCP (verdict → DB)
  // or write "Result:" prose (verdict → return value). Either way, runSemanticCheck
  // checks both and returns a verdict.
  const semanticResult = runSemanticCheck(
    "Is this review thorough? Does it identify real issues or correctly approve? Is the verdict justified given the scope artifacts?",
    artifactContent,
    artifactPath,
    scopeContext,
    true,
    sessionId,
    scope,
  );
  writeAudit(sessionDir, scope, agentType, artifactPath, semanticResult,);

  const semanticVerdict = semanticResult ? semanticResult.verdict : null;
  trace.span({ name: "semantic-check", input: { prompt: "implicit-verifier-check", }, output: { verdict: semanticVerdict, }, },).end();

  // Record raw artifact verdict — engine and DB must agree on what the reviewer said.
  recordVerdict(repo, scope, agentType, artifactVerdict,);

  // Semantic dispatch (hook layer, not engine):
  // If gater says FAIL and reviewer didn't say REVISE → retry reviewer via retryGateAgent.
  // Otherwise → normal engine.step with artifact verdict.
  if (semanticVerdict === "FAIL" && artifactVerdict.toUpperCase().trim() !== "REVISE")
  {
    const retryAction = pipelineEngine.retryGateAgent(scope,);
    Tracing.trace(sessionDir, "engine.retryGateAgent", scope, {
      agent: agentType,
      role: "verifier",
      verdict: artifactVerdict,
      semanticVerdict,
      action: retryAction && retryAction.action,
    },);
    logAction(sessionDir, retryAction, scope,);
    trace.span({
      name: "engine-step",
      input: { role: "verifier", artifactVerdict, semanticVerdict, },
      output: { action: retryAction && retryAction.action, },
    },).end();
    return;
  }

  const nextAction = pipelineEngine.step(scope, { role: "verifier", artifactVerdict, },);
  Tracing.trace(sessionDir, "engine.step", scope, {
    agent: agentType,
    role: "verifier",
    verdict: artifactVerdict,
    semanticVerdict,
    action: nextAction && nextAction.action,
  },);
  logAction(sessionDir, nextAction, scope,);
  trace.span({ name: "engine-step", input: { role: "verifier", artifactVerdict, }, output: { action: nextAction && nextAction.action, }, },)
    .end();
}

function handleFixer(
  repo: PipelineRepository,
  pipelineEngine: PipelineEngine,
  scope: string,
  agentType: string,
  artifactPath: string,
  artifactContent: string,
  artifactVerdict: string,
  scopeContext: string,
  sessionDir: string,
  sessionId: string,
  trace: any,
)
{
  // Implicit semantic check for fixers
  const semanticResult = runSemanticCheck(
    "Did this fix address the revision instructions?",
    artifactContent,
    artifactPath,
    scopeContext,
    true,
    sessionId,
    scope,
  );
  writeAudit(sessionDir, scope, agentType, artifactPath, semanticResult,);

  const semanticVerdict = semanticResult ? semanticResult.verdict : null;
  recordVerdict(repo, scope, agentType, artifactVerdict,);
  trace.span({ name: "semantic-check", input: { prompt: "implicit-fixer-check", }, output: { verdict: semanticVerdict, }, },).end();

  // Single engine call — engine always reactivates the revision step for fixers
  const nextAction = pipelineEngine.step(scope, { role: "fixer", artifactVerdict, },);
  Tracing.trace(sessionDir, "engine.step", scope, {
    agent: agentType,
    role: "fixer",
    verdict: artifactVerdict,
    semanticVerdict,
    action: nextAction && nextAction.action,
  },);
  logAction(sessionDir, nextAction, scope,);
  trace.span({ name: "engine-step", input: { role: "fixer", artifactVerdict, }, output: { action: nextAction && nextAction.action, }, },)
    .end();
}

function handleTransformer(
  repo: PipelineRepository,
  pipelineEngine: PipelineEngine,
  scope: string,
  agentType: string,
  artifactPath: string,
  sessionDir: string,
  trace: any,
)
{
  // Transformers auto-pass — no verdict check, no semantic check.
  recordVerdict(repo, scope, agentType, "PASS",);
  const nextAction = pipelineEngine.step(scope, { role: "transformer", artifactVerdict: "PASS", },);
  Tracing.trace(sessionDir, "engine.step", scope, {
    agent: agentType,
    role: "transformer",
    verdict: "PASS",
    action: nextAction && nextAction.action,
  },);
  logAction(sessionDir, nextAction, scope,);
  trace.span({ name: "engine-step", input: { role: "transformer", }, output: { action: nextAction && nextAction.action, }, },).end();
}

// ── Logging helper ───────────────────────────────────────────────────

function logAction(sessionDir: string, action: any, scope: string,)
{
  if (!action)
  {
    return;
  }
  // Stderr only — pipeline-block.js owns the user/Claude-facing block message.
  const a = action.action;
  if (a === "done")
  {
    Messaging.log("✅", `Pipeline complete (scope=${scope}).`,);
  }
  else if (a === "failed")
  {
    Messaging.log("❌", `Pipeline exhausted (scope=${scope}).`,);
  }
  else if (a === "spawn")
  {
    Messaging.log("🔄", `Next: ${action.agent} (scope=${scope}, round ${(action.round || 0) + 1}/${action.maxRounds}).`,);
  }
  else if (a === "source")
  {
    Messaging.log("🔄", `Next: ${action.agent} (scope=${scope}).`,);
  }
  else
  {
    Messaging.log("⚡", `Next: ${a} (scope=${scope}).`,);
  }
}

export {};
