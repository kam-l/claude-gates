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
 *   gate-agent → implicit semantic + engine.step({ role: 'gate-agent', ... })
 *   fixer      → implicit semantic + engine.step({ role: 'fixer', ... })
 *   ungated    → exit(0)
 *
 * The engine owns ALL state transitions — hooks never touch crud directly for transitions.
 *
 * Gater hardcoded fallback: records verdict from last_assistant_message (feeds plan-gate.js).
 *
 * Fail-open on infrastructure errors. Hard-block on intentional gates.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { parseVerification, findAgentMd, VERDICT_RE, getSessionDir } = require("./pipeline-shared.js");
const crud = require("./pipeline-db.js");
const engine = require("./pipeline.js");
const msg = require("./messages.js");

const PROJECT_ROOT = process.cwd();
const HOME = process.env.USERPROFILE || process.env.HOME || "";

/**
 * Extract scope= from a transcript JSONL file (first 2KB).
 */
function extractScopeFromTranscript(transcriptPath) {
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
function extractArtifactPath(message, sessionDir, agentType) {
  const normalizedDir = sessionDir.replace(/\\/g, "/");
  const escapedDir = normalizedDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bareType = agentType.includes(":") ? agentType.split(":").pop() : agentType;
  const pattern = new RegExp(
    escapedDir + "/([A-Za-z0-9_-]+)/" + bareType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.md",
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
function recordVerdict(db, scope, agentType, verdict) {
  if (!scope) return null;
  try {
    const bare = agentType.includes(":") ? agentType.split(":").pop() : agentType;
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
function runSemanticCheck(prompt, artifactContent, artifactPath, contextContent, isReview) {
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
      "claude -p --model sonnet --agent claude-gates:gater --max-turns 1 --tools \"\" --no-chrome --strict-mcp-config --system-prompt \"\" --disable-slash-commands --no-session-persistence",
      {
        input: combinedPrompt,
        cwd: PROJECT_ROOT,
        timeout: 60000,
        encoding: "utf-8",
        shell: true,
        env: { ...process.env, CLAUDECODE: "" }
      }
    ).trim();

    const lines = result.split("\n").filter(l => l.trim());
    const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";
    const match = /^(PASS|FAIL)(?:[:\s\u2014\u2013-]+(.*))?$/i.exec(lastLine);
    return match
      ? { verdict: match[1].toUpperCase(), reason: match[2] ? match[2].trim() : "", fullResponse: result }
      : null;
  } catch {
    return null; // fail-open
  }
}

/**
 * Write audit trail file.
 */
function writeAudit(sessionDir, scope, agentType, artifactPath, semanticResult) {
  try {
    const auditDir = scope ? path.join(sessionDir, scope) : sessionDir;
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
    const auditFile = path.join(auditDir, `.gate-${agentType}.audit.md`);
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
function gatherScopeContext(sessionDir, scope, agentType) {
  if (!scope) return "";
  const bare = agentType.includes(":") ? agentType.split(":").pop() : agentType;
  let context = "";
  try {
    const scopeDir = path.join(sessionDir, scope);
    for (const file of fs.readdirSync(scopeDir)) {
      if (!file.endsWith(".md") || file === `${bare}.md` || file.startsWith(".gate-")) continue;
      try {
        context += `\n--- ${scope}/${file} ---\n${fs.readFileSync(path.join(scopeDir, file), "utf-8")}\n`;
      } catch {}
    }
  } catch {}
  return context;
}

function notifyVerify(sessionDir, reason) {
  msg.notify(sessionDir, "🔐", reason);
}

// ── Main ─────────────────────────────────────────────────────────────

try {
  let data;
  try { data = JSON.parse(fs.readFileSync(0, "utf-8")); } catch { process.exit(0); }

  if (data.stop_hook_active) process.exit(0);

  const agentType = data.agent_type || "";
  if (!agentType) process.exit(0);
  const bareAgentType = agentType.includes(":") ? agentType.split(":").pop() : agentType;

  const agentId = data.agent_id || "unknown";
  const sessionId = data.session_id || "unknown";
  const sessionDir = getSessionDir(sessionId);
  const lastMessage = data.last_assistant_message || "";

  // ── Gater hardcoded fallback ──
  // Record verdict from message (feeds plan-gate.js). Must stay above scope resolution.
  if (bareAgentType === "gater" && lastMessage) {
    const gaterVerdict = VERDICT_RE.exec(lastMessage);
    if (gaterVerdict) {
      const db = crud.getDb(sessionDir);
      try {
        recordVerdict(db, "gater-review", bareAgentType, gaterVerdict[1]);
      } finally {
        db.close();
      }
    }
    process.exit(0);
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
    // Move artifact from temp path to canonical path
    let scope = transcriptScope;
    let artifactPath = null;

    if (scope) {
      const correctPath = path.join(sessionDir, scope, `${bareAgentType}.md`);
      const tempPath = path.join(sessionDir, `${agentId}.md`);

      if (fs.existsSync(tempPath)) {
        const scopeDir = path.dirname(correctPath);
        if (!fs.existsSync(scopeDir)) fs.mkdirSync(scopeDir, { recursive: true });
        try {
          fs.copyFileSync(tempPath, correctPath);
          fs.unlinkSync(tempPath);
        } catch {}
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
          notifyVerify(sessionDir, `Agent "${bareAgentType}" has verification: but no scope. Write to output_filepath with a Result: line.`);
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

    // Layer 1: Result: line must exist — treat missing as FAIL to avoid deadlock
    if (!VERDICT_RE.test(artifactContent)) {
      notifyVerify(sessionDir, `${bareAgentType}.md missing Result: line. Treating as FAIL.`);
      engine.step(db, scope, { role, artifactVerdict: "FAIL" });
      process.exit(0);
    }

    const artifactVerdictMatch = VERDICT_RE.exec(artifactContent);
    const artifactVerdict = artifactVerdictMatch ? artifactVerdictMatch[1].toUpperCase() : "UNKNOWN";

    // Scope context for semantic checks
    const scopeContext = gatherScopeContext(sessionDir, scope, agentType);

    // ── Dispatch by role ──

    if (role === "source") {
      handleSource(db, scope, bareAgentType, artifactPath, artifactContent, artifactVerdict, scopeContext, sessionDir);
    } else if (role === "gate-agent") {
      handleGateAgent(db, scope, bareAgentType, artifactPath, artifactContent, artifactVerdict, scopeContext, sessionDir);
    } else if (role === "fixer") {
      handleFixer(db, scope, bareAgentType, artifactPath, artifactContent, artifactVerdict, scopeContext, sessionDir);
    }

  } finally {
    db.close();
  }

  process.exit(0);
} catch (err) {
  msg.log("⚠️", `Error: ${err.message}`);
  process.exit(0); // fail-open
}

// ── Role handlers ────────────────────────────────────────────────────

function handleSource(db, scope, agentType, artifactPath, artifactContent, artifactVerdict, scopeContext, sessionDir) {
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
      return;
    }
    // Fall through: SEMANTIC step reactivated, run the check now
  }

  // Check if active step is SEMANTIC — run semantic check with step's prompt
  const activeStep = crud.getActiveStep(db, scope);
  let semanticVerdict = null;
  let semanticResult = null;

  if (activeStep && activeStep.step_type === "SEMANTIC" && activeStep.prompt) {
    semanticResult = runSemanticCheck(activeStep.prompt, artifactContent, artifactPath, scopeContext, false);
    writeAudit(sessionDir, scope, agentType, artifactPath, semanticResult);
    semanticVerdict = semanticResult ? semanticResult.verdict : null;
  }

  // Determine final verdict for recording (semantic FAIL overrides)
  const finalVerdict = (semanticVerdict === "FAIL") ? "FAIL" : artifactVerdict;
  recordVerdict(db, scope, agentType, finalVerdict);

  // Engine call — for normal state, processes verdict on active step
  const nextAction = engine.step(db, scope, { role: "source", artifactVerdict: finalVerdict, semanticVerdict });
  logAction(sessionDir, nextAction, scope);

  if (finalVerdict === "FAIL") {
    const reason = semanticResult && semanticResult.reason ? semanticResult.reason : "Semantic validation failed";
    msg.notify(sessionDir, "", `${reason}`);
  }
}

function handleGateAgent(db, scope, agentType, artifactPath, artifactContent, artifactVerdict, scopeContext, sessionDir) {
  // Implicit semantic check for gate agents
  const semanticResult = runSemanticCheck(
    "Is this review thorough? Does it identify real issues or correctly approve? Is the verdict justified given the scope artifacts?",
    artifactContent, artifactPath, scopeContext, true
  );
  writeAudit(sessionDir, scope, agentType, artifactPath, semanticResult);

  const semanticVerdict = semanticResult ? semanticResult.verdict : null;
  const finalVerdict = (semanticVerdict === "FAIL") ? "FAIL" : artifactVerdict;
  recordVerdict(db, scope, agentType, finalVerdict);

  // Single engine call — engine handles gate-retry (semantic FAIL) vs normal step
  const nextAction = engine.step(db, scope, { role: "gate-agent", artifactVerdict, semanticVerdict });
  logAction(sessionDir, nextAction, scope);

}

function handleFixer(db, scope, agentType, artifactPath, artifactContent, artifactVerdict, scopeContext, sessionDir) {
  // Implicit semantic check for fixers
  const semanticResult = runSemanticCheck(
    "Did this fix address the revision instructions? Is the Result: line justified?",
    artifactContent, artifactPath, scopeContext, true
  );
  writeAudit(sessionDir, scope, agentType, artifactPath, semanticResult);

  const semanticVerdict = semanticResult ? semanticResult.verdict : null;
  recordVerdict(db, scope, agentType, artifactVerdict);

  // Single engine call — engine always reactivates the revision step for fixers
  const nextAction = engine.step(db, scope, { role: "fixer", artifactVerdict, semanticVerdict });
  logAction(sessionDir, nextAction, scope);
}

// ── Logging helper ───────────────────────────────────────────────────

function logAction(sessionDir, action, scope) {
  if (!action) return;
  // Stderr only — pipeline-block.js owns the user/Claude-facing block message.
  const a = action.action;
  if (a === "done")         msg.log("✅", `Pipeline complete (scope=${scope}).`);
  else if (a === "failed")  msg.log("❌", `Pipeline exhausted (scope=${scope}).`);
  else if (a === "spawn")   msg.log("🔄", `Next: ${action.agent} (scope=${scope}, round ${(action.round||0)+1}/${action.maxRounds}).`);
  else if (a === "source")  msg.log("🔄", `Next: ${action.agent} (scope=${scope}).`);
  else                      msg.log("⚡", `Next: ${a} (scope=${scope}).`);
}
