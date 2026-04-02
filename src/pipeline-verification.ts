#!/usr/bin/env node
/**
 * Pipeline v3 — SubagentStop verification hook (BLOCKING).
 *
 * Two-layer verification:
 *   Layer 1 (deterministic): file exists, Result: line present, scope registered
 *   Layer 2 (semantic): claude -p judges whether content is substantive
 *
 * Scope resolution (parallel-safe):
 *   Primary: agent_transcript_path (subagent's own JSONL, first line has scope=)
 *   Fallback: extractArtifactPath (parse scope from last_assistant_message)
 *   Fallback: findAgentScope (DB lookup)
 *
 * Role dispatch via engine.resolveRole() + engine.step({ role, artifactVerdict, semanticVerdict }):
 *   source     → SEMANTIC step check + engine.step({ role: 'source', ... })
 *   verifier → implicit semantic + engine.step({ role: 'verifier', ... })
 *   fixer      → implicit semantic + engine.step({ role: 'fixer', ... })
 *   ungated    → exit(0)
 *
 * The engine owns ALL state transitions — hooks never touch crud directly for transitions.
 *
 * Gater hardcoded fallback: records verdict from last_assistant_message (feeds plan-gate.js).
 *
 * Fail-open on infrastructure errors. Hard-block on intentional gates.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { parseVerification, findAgentMd, VERDICT_RE, getSessionDir, agentRunningMarker } from "./pipeline-shared";
import * as crud from "./pipeline-db";
import * as engine from "./pipeline";
import * as msg from "./messages";
import * as tracing from "./tracing";

const PROJECT_ROOT = process.cwd();
const HOME = process.env.USERPROFILE || process.env.HOME || "";

/**
 * Extract scope= from a transcript JSONL file (first 2KB).
 */
function extractScopeFromTranscript(transcriptPath: string | null): string | null {
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

/**
 * Extract artifact path from the agent's last message.
 * Looks for: {session_dir}/{scope}/{agent_type}.md
 */
function extractArtifactPath(message: string, sessionDir: string, agentType: string): { artifactPath: string; scope: string } | null {
  const normalizedDir = sessionDir.replace(/\\/g, "/");
  const escapedDir = normalizedDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bareType = agentType.includes(":") ? agentType.split(":").pop() : agentType;
  const pattern = new RegExp(
    escapedDir + "/([A-Za-z0-9_-]+)/" + bareType!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.md",
    "i"
  );
  const match = message.replace(/\\/g, "/").match(pattern);
  if (match && match[1] !== "_pending") {
    return { artifactPath: path.join(sessionDir, match[1], `${bareType}.md`), scope: match[1] };
  }
  return null;
}

/**
 * Record a structured verdict object (SQLite).
 */
function recordVerdict(db: any, scope: string, agentType: string, verdict: string): { verdict: string; round: number } | null {
  if (!scope) return null;
  try {
    const bare = agentType.includes(":") ? agentType.split(":").pop()! : agentType;
    const existing = crud.getAgent(db, scope, bare);
    const round = (existing && existing.round) ? existing.round + 1 : 1;
    crud.setVerdict(db, scope, bare, verdict, round);
    return { verdict, round };
  } catch {
    return null;
  }
}

/**
 * Run claude -p semantic validation. Returns { verdict: 'PASS'|'FAIL', reason } or null on skip.
 */
function runSemanticCheck(prompt: string, artifactContent: string, artifactPath: string, contextContent: string, isReview: boolean): { verdict: string; reason: string; fullResponse: string } | null {
  let combinedPrompt = prompt + "\n\n";
  if (isReview) {
    combinedPrompt += `NOTE: This artifact is a REVIEW or FIX of another artifact, not primary content. ` +
      `Judge whether this review/fix is well-structured, specific, and actionable. ` +
      `Negative findings about the SOURCE artifact are expected and correct — do not penalize the reviewer for identifying problems.\n\n`;
  }
  combinedPrompt += `--- ${path.basename(artifactPath)} ---\n${artifactContent}\n`;
  if (contextContent) combinedPrompt += contextContent;

  try {
    const result = execSync(
      "claude -p --model sonnet --agent claude-gates:gater --max-turns 1 --tools \"\" --no-chrome --strict-mcp-config --disable-slash-commands --no-session-persistence",
      {
        input: combinedPrompt,
        cwd: PROJECT_ROOT,
        timeout: 60000,
        encoding: "utf-8",
        shell: true as any,
        env: { ...process.env, CLAUDECODE: "" }
      }
    ).trim();

    const match = /^Result:\s*(PASS|FAIL|REVISE|CONVERGED)\b(.*)?$/mi.exec(result);
    if (!match) return null;
    // Normalize: REVISE→FAIL (quality check failed), CONVERGED→PASS
    const raw = match[1].toUpperCase();
    const verdict = (raw === "PASS" || raw === "CONVERGED") ? "PASS" : "FAIL";
    return { verdict, reason: match[2] ? match[2].trim() : "", fullResponse: result };
  } catch {
    return null; // fail-open
  }
}

/**
 * Write audit trail file.
 */
function writeAudit(sessionDir: string, scope: string | null, agentType: string, artifactPath: string, semanticResult: { verdict: string; reason: string; fullResponse: string } | null) {
  try {
    const auditDir = scope ? path.join(sessionDir, scope) : sessionDir;
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
    const auditFile = path.join(auditDir, `${agentType}-verification.md`);
    fs.writeFileSync(
      auditFile,
      `# Pipeline: ${agentType}\n` +
      `- **Timestamp:** ${new Date().toISOString()}\n` +
      `- **Artifact:** ${artifactPath.replace(/\\/g, "/")}\n` +
      (scope ? `- **Scope:** ${scope}\n` : "") +
      `- **Verdict:** ${semanticResult ? semanticResult.verdict : "UNKNOWN"}\n` +
      `- **Reason:** ${semanticResult && semanticResult.reason ? semanticResult.reason : "N/A"}\n` +
      `- **Full response:**\n\`\`\`\n${semanticResult ? semanticResult.fullResponse : "(skipped)"}\n\`\`\`\n`,
      "utf-8"
    );
  } catch {} // non-fatal
}

/**
 * Gather scope context (all .md files in scope dir, excluding self and audits).
 */
function gatherScopeContext(sessionDir: string, scope: string | null, agentType: string): string {
  if (!scope) return "";
  const bare = agentType.includes(":") ? agentType.split(":").pop() : agentType;
  let context = "";
  try {
    const scopeDir = path.join(sessionDir, scope);
    for (const file of fs.readdirSync(scopeDir)) {
      if (!file.endsWith(".md") || file === `${bare}.md` || file === `${bare}-verification.md`) continue;
      try {
        context += `\n--- ${scope}/${file} ---\n${fs.readFileSync(path.join(scopeDir, file), "utf-8")}\n`;
      } catch {}
    }
  } catch {}
  return context;
}

function notifyVerify(sessionDir: string, reason: string) {
  msg.notify(sessionDir, "🔐", reason);
}

// ── Main ─────────────────────────────────────────────────────────────

try {
  let data: any;
  try { data = JSON.parse(fs.readFileSync(0, "utf-8")); } catch { process.exit(0); }

  const isContinuation = !!data.stop_hook_active;

  const agentType = data.agent_type || "";
  if (!agentType) process.exit(0);
  const bareAgentType = agentType.includes(":") ? agentType.split(":").pop() : agentType;

  const agentId = data.agent_id || "unknown";
  const sessionId = data.session_id || "unknown";
  const sessionDir = getSessionDir(sessionId);
  const lastMessage = data.last_assistant_message || "";

  // ── Gater verdict recording (feeds plan-gate.js) ──
  // Always record to "gater-review" scope for plan-gate, then fall through to normal processing.
  // Standalone gaters (not pipeline participants) will resolve as "ungated" and exit harmlessly.
  if (bareAgentType === "gater" && lastMessage) {
    const gaterVerdict = VERDICT_RE.exec(lastMessage);
    if (gaterVerdict) {
      const tempDb = crud.getDb(sessionDir);
      try {
        recordVerdict(tempDb, "gater-review", bareAgentType, gaterVerdict[1]);
      } finally {
        tempDb.close();
      }
    }
    // Fall through — do NOT exit early. Pipeline-participant gaters need engine.step().
  }

  // Find agent definition
  const agentMdPath = findAgentMd(bareAgentType, PROJECT_ROOT, HOME);
  const mdContent = agentMdPath ? fs.readFileSync(agentMdPath, "utf-8") : null;

  // ── Scope resolution (parallel-safe, three-tier fallback) ──
  const transcriptScope = extractScopeFromTranscript(data.agent_transcript_path)
    || extractScopeFromTranscript(
      data.transcript_path && agentId !== "unknown"
        ? data.transcript_path.replace(/\.jsonl$/, "") + "/subagents/agent-" + agentId + ".jsonl"
        : null
    );

  const db = crud.getDb(sessionDir);

  try {
    // Resolve artifact: existing file → pivot agent to write one
    let scope = transcriptScope;
    let artifactPath: string | null = null;

    // Read agent-running marker mtime (agent spawn time) before artifact resolution
    let agentSpawnTime = 0;
    if (scope) {
      const markerPath = agentRunningMarker(sessionDir, scope);
      try { agentSpawnTime = fs.statSync(markerPath).mtimeMs; } catch {}
      try { fs.unlinkSync(markerPath); } catch {}
    }

    if (scope) {
      const correctPath = path.join(sessionDir, scope, `${bareAgentType}.md`);
      const tempPath = path.join(sessionDir, `${agentId}.md`);
      const scopeDir = path.dirname(correctPath);

      if (fs.existsSync(tempPath)) {
        // Agent wrote to temp path (via output_filepath), move to canonical
        if (!fs.existsSync(scopeDir)) fs.mkdirSync(scopeDir, { recursive: true });
        try {
          fs.copyFileSync(tempPath, correctPath);
          fs.unlinkSync(tempPath);
        } catch {}
      } else if (lastMessage) {
        if (!fs.existsSync(scopeDir)) fs.mkdirSync(scopeDir, { recursive: true });
        if (!fs.existsSync(correctPath) && !isContinuation) {
          // First stop, no artifact file — pivot: tell agent to write it
          // Include verification context so agent knows what it'll be judged on
          const writePath = correctPath.replace(/\\/g, "/");
          let pivotMsg = `Your work is done. Write your complete findings to: ${writePath}`;
          pivotMsg += `\nThis artifact will be verified. Include evidence from tool output (file reads, diffs, test results) — assertions without evidence will be rejected.`;
          try {
            const role = engine.resolveRole(db, scope, bareAgentType);
            const activeStep = crud.getActiveStep(db, scope);
            if (role === "verifier") {
              pivotMsg += `\nYou are a verifier. End with exactly one: Result: PASS, Result: REVISE, Result: FAIL, or Result: CONVERGED.`;
            } else if (activeStep && activeStep.step_type === "SEMANTIC" && activeStep.prompt) {
              pivotMsg += `\nVerification criteria: ${activeStep.prompt}`;
            } else if (activeStep && (activeStep.step_type === "REVIEW" || activeStep.step_type === "REVIEW_WITH_FIXER")) {
              pivotMsg += `\nA reviewer (${activeStep.agent}) will evaluate this artifact next.`;
            }
          } catch {}
          process.stdout.write(JSON.stringify({
            decision: "block",
            reason: `[ClaudeGates] ${pivotMsg}`
          }));
          process.exit(0);
        } else if (!fs.existsSync(correctPath) && isContinuation) {
          // Continuation but agent still didn't write file — fallback to lastMessage
          fs.writeFileSync(correctPath, lastMessage, "utf-8");
        } else if (fs.existsSync(correctPath) && agentSpawnTime > 0) {
          // File exists — check if agent updated it during THIS run
          try {
            const fileMtime = fs.statSync(correctPath).mtimeMs;
            if (fileMtime < agentSpawnTime) {
              // Stale from previous round — overwrite with current output
              fs.writeFileSync(correctPath, lastMessage, "utf-8");
            }
          } catch {}
        }
      }

      if (fs.existsSync(correctPath)) {
        artifactPath = correctPath;
      }
    }

    // Fallback: extract scope from last message
    if (!scope) {
      const info = extractArtifactPath(lastMessage, sessionDir, agentType);
      if (info) {
        scope = info.scope;
        artifactPath = info.artifactPath;
      }
    }

    // Fallback: DB lookup
    if (!scope) {
      scope = crud.findAgentScope(db, bareAgentType);
      if (scope) {
        artifactPath = path.join(sessionDir, scope, `${bareAgentType}.md`);
        if (!fs.existsSync(artifactPath)) artifactPath = null;
      }
    }

    // ── Role resolution ──
    // Called for ALL agents regardless of frontmatter. Role depends on pipeline_steps, not agent definition.
    const role = scope ? engine.resolveRole(db, scope, bareAgentType) : "ungated";

    if (role === "ungated") {
      // Check if agent has verification: but no scope — block
      if (mdContent) {
        const steps = parseVerification(mdContent);
        if (steps && !scope) {
          notifyVerify(sessionDir, `Agent "${bareAgentType}" has verification: but no scope. Add scope=<name> to the spawn prompt.`);
        }
      }
      process.exit(0);
    }

    // Artifact missing — treat as FAIL to avoid deadlock (step stays "active" forever otherwise)
    if (!artifactPath || !fs.existsSync(artifactPath)) {
      if (scope) {
        const expectedPath = `${sessionDir.replace(/\\/g, "/")}/${scope}/${bareAgentType}.md`;
        notifyVerify(sessionDir, `${bareAgentType} completed without artifact. Treating as FAIL. Expected: ${expectedPath}`);
        engine.step(db, scope, { role, artifactVerdict: "FAIL" });
      }
      process.exit(0);
    }

    const artifactContent = fs.readFileSync(artifactPath, "utf-8");

    // Layer 1: Result: line — only required from verifiers.
    // Source agents and fixers just produce content; their verdicts are overridden by handlers.
    if (role === "verifier" && !VERDICT_RE.test(artifactContent)) {
      // Verifier artifact exists but missing verdict — treat as FAIL.
      // (The artifact pivot already told verifiers to include their verdict.)
      notifyVerify(sessionDir, `${bareAgentType}.md missing Result: line. Treating as FAIL.`);
      engine.step(db, scope!, { role, artifactVerdict: "FAIL" });
      process.exit(0);
    }

    const artifactVerdictMatch = VERDICT_RE.exec(artifactContent);
    const artifactVerdict = artifactVerdictMatch ? artifactVerdictMatch[1].toUpperCase() : "UNKNOWN";

    // Scope context for semantic checks
    const scopeContext = gatherScopeContext(sessionDir, scope, agentType);

    // ── Langfuse tracing ──
    const { langfuse, enabled } = tracing.init();
    const trace = tracing.getOrCreateTrace(langfuse, enabled, db, scope!, sessionId);

    // ── Dispatch by role ──

    if (role === "source") {
      handleSource(db, scope!, bareAgentType, artifactPath, artifactContent, artifactVerdict, scopeContext, sessionDir, trace);
    } else if (role === "verifier") {
      handleVerifier(db, scope!, bareAgentType, artifactPath, artifactContent, artifactVerdict, scopeContext, sessionDir, trace);
    } else if (role === "fixer") {
      handleFixer(db, scope!, bareAgentType, artifactPath, artifactContent, artifactVerdict, scopeContext, sessionDir, trace);
    }

    tracing.flush(langfuse, enabled);
  } finally {
    db.close();
  }

  process.exit(0);
} catch (err: any) {
  msg.log("⚠️", `Error: ${err.message}`);
  process.exit(0); // fail-open
}

// ── Role handlers ────────────────────────────────────────────────────

function handleSource(db: any, scope: string, agentType: string, artifactPath: string, artifactContent: string, artifactVerdict: string, scopeContext: string, sessionDir: string, trace: any) {
  // If pipeline is in revision state, reactivate the step FIRST.
  // This ensures the SEMANTIC step is "active" again before we check for it.
  const state = crud.getPipelineState(db, scope);
  if (state && state.status === "revision") {
    const nextAction = engine.step(db, scope, { role: "source", artifactVerdict });
    // If reactivated step is SEMANTIC, fall through to run semantic check below.
    // Otherwise (REVIEW/COMMAND/done), log and return — no semantic check needed.
    if (!nextAction || nextAction.action !== "semantic") {
      recordVerdict(db, scope, agentType, artifactVerdict);
      logAction(sessionDir, nextAction, scope);
      trace.span({ name: "engine-step", input: { role: "source", artifactVerdict }, output: { action: nextAction && nextAction.action } }).end();
      return;
    }
    // Fall through: SEMANTIC step reactivated, run the check now
  }

  // Check if active step is SEMANTIC — run semantic check with step's prompt
  const activeStep = crud.getActiveStep(db, scope);
  let semanticVerdict: string | null = null;
  let semanticResult: { verdict: string; reason: string; fullResponse: string } | null = null;

  if (activeStep && activeStep.step_type === "SEMANTIC" && activeStep.prompt) {
    semanticResult = runSemanticCheck(activeStep.prompt, artifactContent, artifactPath, scopeContext, false);
    writeAudit(sessionDir, scope, agentType, artifactPath, semanticResult);
    semanticVerdict = semanticResult ? semanticResult.verdict : null;
    trace.span({ name: "semantic-check", input: { prompt: activeStep.prompt }, output: { verdict: semanticVerdict } }).end();
  }

  // Source agents produce artifacts — they don't judge themselves.
  // Only verification steps (SEMANTIC/REVIEW) determine PASS/FAIL.
  // Source Result: line is recorded but doesn't drive pipeline flow.
  const finalVerdict = (semanticVerdict === "FAIL") ? "FAIL" : "PASS";
  recordVerdict(db, scope, agentType, finalVerdict);

  // Engine call — for normal state, processes verdict on active step
  const nextAction = engine.step(db, scope, { role: "source", artifactVerdict: finalVerdict, semanticVerdict });
  logAction(sessionDir, nextAction, scope);
  trace.span({ name: "engine-step", input: { role: "source", artifactVerdict: finalVerdict, semanticVerdict }, output: { action: nextAction && nextAction.action } }).end();

  if (finalVerdict === "FAIL") {
    const reason = semanticResult && semanticResult.reason ? semanticResult.reason : "Semantic validation failed";
    msg.notify(sessionDir, "", `${reason}`);
  }
}

function handleVerifier(db: any, scope: string, agentType: string, artifactPath: string, artifactContent: string, artifactVerdict: string, scopeContext: string, sessionDir: string, trace: any) {
  // Implicit semantic check for gate agents
  const semanticResult = runSemanticCheck(
    "Is this review thorough? Does it identify real issues or correctly approve? Is the verdict justified given the scope artifacts?",
    artifactContent, artifactPath, scopeContext, true
  );
  writeAudit(sessionDir, scope, agentType, artifactPath, semanticResult);

  const semanticVerdict = semanticResult ? semanticResult.verdict : null;
  const finalVerdict = (semanticVerdict === "FAIL") ? "FAIL" : artifactVerdict;
  recordVerdict(db, scope, agentType, finalVerdict);
  trace.span({ name: "semantic-check", input: { prompt: "implicit-verifier-check" }, output: { verdict: semanticVerdict } }).end();

  // Single engine call — engine handles gate-retry (semantic FAIL) vs normal step
  const nextAction = engine.step(db, scope, { role: "verifier", artifactVerdict, semanticVerdict });
  logAction(sessionDir, nextAction, scope);
  trace.span({ name: "engine-step", input: { role: "verifier", artifactVerdict, semanticVerdict }, output: { action: nextAction && nextAction.action } }).end();
}

function handleFixer(db: any, scope: string, agentType: string, artifactPath: string, artifactContent: string, artifactVerdict: string, scopeContext: string, sessionDir: string, trace: any) {
  // Implicit semantic check for fixers
  const semanticResult = runSemanticCheck(
    "Did this fix address the revision instructions?",
    artifactContent, artifactPath, scopeContext, true
  );
  writeAudit(sessionDir, scope, agentType, artifactPath, semanticResult);

  const semanticVerdict = semanticResult ? semanticResult.verdict : null;
  recordVerdict(db, scope, agentType, artifactVerdict);
  trace.span({ name: "semantic-check", input: { prompt: "implicit-fixer-check" }, output: { verdict: semanticVerdict } }).end();

  // Single engine call — engine always reactivates the revision step for fixers
  const nextAction = engine.step(db, scope, { role: "fixer", artifactVerdict, semanticVerdict });
  logAction(sessionDir, nextAction, scope);
  trace.span({ name: "engine-step", input: { role: "fixer", artifactVerdict, semanticVerdict }, output: { action: nextAction && nextAction.action } }).end();
}

// ── Logging helper ───────────────────────────────────────────────────

function logAction(sessionDir: string, action: any, scope: string) {
  if (!action) return;
  // Stderr only — pipeline-block.js owns the user/Claude-facing block message.
  const a = action.action;
  if (a === "done")         msg.log("✅", `Pipeline complete (scope=${scope}).`);
  else if (a === "failed")  msg.log("❌", `Pipeline exhausted (scope=${scope}).`);
  else if (a === "spawn")   msg.log("🔄", `Next: ${action.agent} (scope=${scope}, round ${(action.round||0)+1}/${action.maxRounds}).`);
  else if (a === "source")  msg.log("🔄", `Next: ${action.agent} (scope=${scope}).`);
  else                      msg.log("⚡", `Next: ${a} (scope=${scope}).`);
}

export {};
