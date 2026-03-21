#!/usr/bin/env node
/**
 * ClaudeGates v2 — SubagentStop verification hook (BLOCKING).
 *
 * Hybrid enforcement:
 *   Layer 1 (deterministic): file exists, Result: line present, scope registered
 *   Layer 2 (semantic): claude -p judges whether content is substantive
 *
 * Verdict recording:
 *   After verification, records structured verdict objects to SQLite
 *   with round tracking.
 *
 * Fail-open on infrastructure errors. Hard-block on intentional gates.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { parseVerification, parseGates, findAgentMd, VERDICT_RE } = require("./claude-gates-shared.js");
const gatesDb = require("./claude-gates-db.js");

const PROJECT_ROOT = process.cwd();
const HOME = process.env.USERPROFILE || process.env.HOME || "";

try {
  let data;
  try { data = JSON.parse(fs.readFileSync(0, "utf-8")); } catch { process.exit(0); }

  if (data.stop_hook_active) process.exit(0);

  const agentType = data.agent_type || "";
  if (!agentType) process.exit(0);
  const bareAgentType = agentType.includes(":") ? agentType.split(":").pop() : agentType;

  const agentId = data.agent_id || "unknown";
  const sessionId = data.session_id || "unknown";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);
  const lastMessage = data.last_assistant_message || "";

  // Hardcoded gater fallback: record verdict from message when no artifact found.
  // The gater agent definition lives in the plugin's agents/ dir (not .claude/agents/),
  // so findAgentMd won't find it. Extract verdict directly from last_assistant_message
  // and write to session_scopes — plan-gate reads these to allow ExitPlanMode.
  if (bareAgentType === "gater" && lastMessage) {
    const gaterVerdict = VERDICT_RE.exec(lastMessage);
    if (gaterVerdict) {
      const db = gatesDb.getDb(sessionDir);
      try {
        recordVerdict(sessionDir, "gater-review", bareAgentType, gaterVerdict[1], db);
      } finally {
        db.close();
      }
    }
    process.exit(0);
  }

  // Find agent definition
  const agentMdPath = findAgentMd(bareAgentType, PROJECT_ROOT, HOME);
  if (!agentMdPath) process.exit(0);

  const mdContent = fs.readFileSync(agentMdPath, "utf-8");
  const verification = parseVerification(mdContent);
  const agentGates = parseGates(mdContent);

  // No verification prompt AND no gates → check if agent is a fixer/source for active gates
  if (!verification && !agentGates) {
    const db0 = gatesDb.getDb(sessionDir);
    try {
      // Try to extract scope from message for parallel-safe lookups
      const artifactInfo0 = extractArtifactPath(lastMessage, sessionDir, agentType);
      const targetScope0 = artifactInfo0 ? artifactInfo0.scope : null;

      // Check if this agent is a fixer completing for a gate in 'fix' status
      const fixRow = targetScope0
        ? db0.prepare("SELECT scope FROM gates WHERE fixer_agent = ? AND status = 'fix' AND scope = ? LIMIT 1").get(bareAgentType, targetScope0)
        : db0.prepare("SELECT scope FROM gates WHERE fixer_agent = ? AND status = 'fix' LIMIT 1").get(bareAgentType);
      if (fixRow) {
        const finalVerdict = extractVerdict(lastMessage);
        processGateTransitions(db0, fixRow.scope, bareAgentType, finalVerdict, mdContent);
        process.exit(0);
      }
      // Check if this agent is a source completing for a gate in 'revise' status
      const revRow = targetScope0
        ? db0.prepare("SELECT scope FROM gates WHERE source_agent = ? AND status = 'revise' AND scope = ? LIMIT 1").get(bareAgentType, targetScope0)
        : db0.prepare("SELECT scope FROM gates WHERE source_agent = ? AND status = 'revise' LIMIT 1").get(bareAgentType);
      if (revRow) {
        const finalVerdict = extractVerdict(lastMessage);
        processGateTransitions(db0, revRow.scope, bareAgentType, finalVerdict, mdContent);
        process.exit(0);
      }
    } finally {
      db0.close();
    }
    process.exit(0);
  }


  const db = gatesDb.getDb(sessionDir);

  try {
    // ── Locate artifact ──
    // Path 1: new schema — extract from last message
    const artifactInfo = extractArtifactPath(lastMessage, sessionDir, agentType);

    if (artifactInfo) {
      if (verification) {
        validateScopeAndVerify(artifactInfo, verification, sessionDir, agentType, agentId, mdContent, db);
      } else {
        // Gates-only: structural check + gate transitions, no semantic verification
        runGatesOnlyCheck(artifactInfo, sessionDir, agentType, mdContent, db);
      }
      process.exit(0);
    }

    // Path 2: scope lookup — agent was cleared but path not in message
    const clearedScope = findClearedScope(sessionDir, agentType, db);
    if (clearedScope) {
      const expectedPath = path.join(sessionDir, clearedScope, `${agentType}.md`);
      if (fs.existsSync(expectedPath)) {
        if (verification) {
          runVerification(expectedPath, clearedScope, verification, sessionDir, agentType, agentId, mdContent, db);
        } else {
          runGatesOnlyCheck({ artifactPath: expectedPath, scope: clearedScope }, sessionDir, agentType, mdContent, db);
        }
        process.exit(0);
      }
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: `[ClaudeGates] Write your artifact to ${sessionDir.replace(/\\/g, "/")}/${clearedScope}/${agentType}.md before stopping. Include a Result: PASS or Result: FAIL line.`
      }));
      process.exit(0);
    }

    // No scope match — if agent defines verification/gates, block.
    // PreToolUse:Agent enforces scope= at spawn, so the subagent received
    // output_filepath via injection and has all data needed to comply.
    if (verification || agentGates) {
      block(`Agent "${bareAgentType}" has verification/gates but no scope was found. Write your artifact to the output_filepath from <agent_gate> with a Result: PASS/FAIL line.`);
    }
    process.exit(0);
  } finally {
    db.close();
  }
} catch (err) {
  process.stderr.write(`[ClaudeGates verification] Error: ${err.message}\n`);
  process.exit(0); // fail-open
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract artifact path from the agent's last message.
 * Looks for: {session_dir}/{scope}/{agent_type}.md
 */
function extractArtifactPath(message, sessionDir, agentType) {
  const normalizedDir = sessionDir.replace(/\\/g, "/");
  const escapedDir = normalizedDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    escapedDir + "/([A-Za-z0-9_-]+)/" + agentType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.md",
    "i"
  );
  const match = message.replace(/\\/g, "/").match(pattern);
  if (match && match[1] !== "_pending") {
    return { artifactPath: path.join(sessionDir, match[1], `${agentType}.md`), scope: match[1] };
  }
  return null;
}

/**
 * Find which scope this agent was cleared for (SQLite).
 */
function findClearedScope(sessionDir, agentType, db) {
  return gatesDb.findAgentScope(db, agentType);
}

/**
 * Record a structured verdict object (SQLite).
 * Returns { verdict, round } or null on error.
 */
function recordVerdict(sessionDir, scope, agentType, verdict, db) {
  if (!scope || !sessionDir) return null;
  try {
    const existing = gatesDb.getAgent(db, scope, agentType);
    const round = (existing && existing.round) ? existing.round + 1 : 1;
    gatesDb.setVerdict(db, scope, agentType, verdict, round);
    return { verdict, round };
  } catch {
    return null;
  }
}

/**
 * Validate scope registration then run verification.
 */
function validateScopeAndVerify(artifactInfo, verification, sessionDir, agentType, agentId, mdContent, db) {
  const { artifactPath, scope } = artifactInfo;

  // Validate scope registration
  if (scope) {
    if (!gatesDb.isCleared(db, scope, agentType)) {
      // Check if scope exists at all
      const scopeExists = db.prepare("SELECT 1 FROM agents WHERE scope = ?").get(scope);
      if (!scopeExists) {
        block(`Scope "${scope}" not registered. Were you spawned with scope=${scope}?`);
        return;
      }
      block(`Agent "${agentType}" not cleared for scope "${scope}".`);
      return;
    }
  }

  if (!fs.existsSync(artifactPath)) {
    block(`Artifact not found at ${artifactPath.replace(/\\/g, "/")}. Write it before stopping.`);
    return;
  }

  runVerification(artifactPath, scope, verification, sessionDir, agentType, agentId, mdContent, db);
}

/**
 * Layer 1 (deterministic) + Layer 2 (semantic) verification.
 */
function runVerification(artifactPath, scope, verification, sessionDir, agentType, agentId, mdContent, db) {
  const artifactContent = fs.readFileSync(artifactPath, "utf-8");

  // Layer 1: Result: line must exist
  if (!VERDICT_RE.test(artifactContent)) {
    block(`Your ${agentType}.md is missing a Result: line. Add 'Result: PASS' or 'Result: FAIL' as a standalone line.`);
    return;
  }

  // Gather scope context (all .md files in scope dir, excluding self and audits)
  let contextContent = "";
  if (scope) {
    const scopeDir = path.join(sessionDir, scope);
    try {
      for (const file of fs.readdirSync(scopeDir)) {
        if (!file.endsWith(".md") || file === `${agentType}.md` || file.startsWith(".gate-")) continue;
        try {
          contextContent += `\n--- ${scope}/${file} ---\n${fs.readFileSync(path.join(scopeDir, file), "utf-8")}\n`;
        } catch {}
      }
    } catch {}
  }

  // Layer 2: semantic verification
  runSemanticCheck(verification, artifactContent, artifactPath, contextContent, agentType, agentId, null, scope, sessionDir, mdContent, db);
}

/**
 * Run claude -p semantic validation.
 * Uses stdin pipe — no shell expansion, no injection risk.
 *
 * Verdict precedence:
 *   1. Semantic checker says FAIL → verdict = FAIL (quality gate)
 *   2. Else → use artifact's Result: line (PASS/FAIL/REVISE/CONVERGED)
 *   3. No match → "UNKNOWN", allow (fail-open)
 *
 * mdContent is required for gate transitions.
 */
function runSemanticCheck(prompt, artifactContent, artifactPath, contextContent, agentType, agentId, sessionId, scope, sessionDir, mdContent, db) {
  const resolvedSessionDir = sessionDir || (sessionId ? path.join(HOME, ".claude", "sessions", sessionId) : null);

  let combinedPrompt = prompt + "\n\n";
  combinedPrompt += `--- ${path.basename(artifactPath)} ---\n${artifactContent}\n`;
  if (contextContent) combinedPrompt += contextContent;

  let result = "";
  let semanticSkipped = false;
  try {
    // Pipe prompt via stdin — eliminates shell injection and temp files
    result = execSync(
      "claude -p --model sonnet --agent claude-gates:gater --max-turns 1 --tools \"\"",
      {
        input: combinedPrompt,
        cwd: PROJECT_ROOT,
        timeout: 60000,
        encoding: "utf-8",
        shell: true,
        env: { ...process.env, CLAUDECODE: "" } // prevent hook re-entry
      }
    ).trim();
  } catch {
    // Semantic check failed — skip semantic layer but continue with
    // verdict recording and gate transitions (fail-open on semantic only)
    semanticSkipped = true;
  }

  // Parse last line for PASS/FAIL from semantic checker
  const lines = result.split("\n").filter(l => l.trim());
  const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";
  const semanticMatch = semanticSkipped ? null : /^(PASS|FAIL)(?:[:\s\u2014\u2013-]+(.*))?$/i.exec(lastLine);

  // Write audit trail
  const auditDir = scope && resolvedSessionDir ? path.join(resolvedSessionDir, scope) : resolvedSessionDir;
  if (auditDir) {
    try {
      if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
      const auditFile = scope
        ? path.join(auditDir, `.gate-${agentType}.audit.md`)
        : path.join(auditDir, `${agentType}_${agentId}.md`);
      fs.writeFileSync(
        auditFile,
        `# ClaudeGates: ${agentType}\n` +
        `- **Timestamp:** ${new Date().toISOString()}\n` +
        `- **Artifact:** ${artifactPath.replace(/\\/g, "/")}\n` +
        (scope ? `- **Scope:** ${scope}\n` : "") +
        `- **Verdict:** ${semanticMatch ? semanticMatch[1].toUpperCase() : "UNKNOWN"}\n` +
        `- **Reason:** ${semanticMatch && semanticMatch[2] ? semanticMatch[2].trim() : "N/A"}\n` +
        `- **Full response:**\n\`\`\`\n${result}\n\`\`\`\n`,
        "utf-8"
      );
    } catch {} // non-fatal
  }

  // ── Verdict precedence ──
  // 1. Semantic checker FAIL → hard block (quality gate)
  // 2. Else → use artifact's Result: line as authoritative verdict
  // 3. No match → UNKNOWN, allow (fail-open)

  let finalVerdict = "UNKNOWN";

  if (semanticMatch && semanticMatch[1].toUpperCase() === "FAIL") {
    finalVerdict = "FAIL";
  } else {
    // Use artifact's own Result: line
    const artifactVerdictMatch = VERDICT_RE.exec(artifactContent);
    if (artifactVerdictMatch) {
      finalVerdict = artifactVerdictMatch[1].toUpperCase();
    }
  }

  // Record verdict
  const verdictObj = recordVerdict(resolvedSessionDir, scope, agentType, finalVerdict, db);

  if (verdictObj) {
    process.stderr.write(`[ClaudeGates] Verdict: ${finalVerdict}.\n`);
  }

  // Only FAIL blocks; REVISE/CONVERGED/PASS/UNKNOWN allow
  if (finalVerdict === "FAIL") {
    const reason = semanticMatch && semanticMatch[2] ? semanticMatch[2].trim() : "Semantic validation failed";
    block(`Your ${path.basename(artifactPath)} failed semantic validation: ${reason}. Rewrite it with substantive content.`);
    return;
  }

  // PASS/REVISE/CONVERGED/UNKNOWN → allow (orchestrator reads session_scopes.json for retry decisions)
  if (!verdictObj) {
    process.stderr.write(`[ClaudeGates] ${agentType}: ${lastLine}\n`);
  }

  // ── Gate state machine transitions ──
  processGateTransitions(db, scope, agentType, finalVerdict, mdContent);
}

/**
 * Gates-only check: structural verification + gate transitions (no semantic layer).
 * Used when agent has gates: but no verification: field.
 */
function runGatesOnlyCheck(artifactInfo, sessionDir, agentType, mdContent, db) {
  const { artifactPath, scope } = artifactInfo;

  if (!fs.existsSync(artifactPath)) {
    block(`Artifact not found at ${artifactPath.replace(/\\/g, "/")}. Write it before stopping.`);
    return;
  }

  const artifactContent = fs.readFileSync(artifactPath, "utf-8");

  // Layer 1 only: Result: line must exist
  if (!VERDICT_RE.test(artifactContent)) {
    block(`Your ${agentType}.md is missing a Result: line. Add 'Result: PASS' or 'Result: FAIL' as a standalone line.`);
    return;
  }

  // Use artifact's Result: line as authoritative verdict (no semantic check)
  const artifactVerdictMatch = VERDICT_RE.exec(artifactContent);
  const finalVerdict = artifactVerdictMatch ? artifactVerdictMatch[1].toUpperCase() : "UNKNOWN";

  // Record verdict
  recordVerdict(sessionDir, scope, agentType, finalVerdict, db);

  process.stderr.write(`[ClaudeGates] ${agentType}: ${finalVerdict} (gates-only, no semantic check)\n`);

  // Gate state machine transitions
  processGateTransitions(db, scope, agentType, finalVerdict, mdContent);
}

/**
 * Process gate state machine transitions after an agent completes.
 *
 * Two cases:
 *   1. Source agent completed → initialize gates (first time) or reactivate revise gate
 *   2. Gate agent completed → advance chain (PASS) or request revision (REVISE)
 */
function processGateTransitions(db, scope, agentType, finalVerdict, mdContent) {
  if (!db || !scope) return;

  const gates = gatesDb.getGates(db, scope);

  if (gates.length > 0) {
    // Case 1: This agent IS an active gate agent
    const activeGate = gates.find(g => g.gate_agent === agentType && g.status === "active");
    if (activeGate) {
      if (finalVerdict === "PASS" || finalVerdict === "CONVERGED") {
        const { nextGate, allPassed } = gatesDb.passGate(db, scope, activeGate.order);
        if (allPassed) {
          process.stderr.write(`[ClaudeGates] All gates passed for scope "${scope}". Scope fully unblocked.\n`);
        } else if (nextGate) {
          process.stderr.write(`[ClaudeGates] Gate ${activeGate.gate_agent} passed. Next gate: ${nextGate.gate_agent} (spawn with scope=${scope}).\n`);
        }
      } else if (finalVerdict === "REVISE") {
        if (activeGate.fixer_agent) {
          // Fixer defined — route to fixer instead of source
          const result = gatesDb.fixGate(db, scope, activeGate.order);
          if (result && result.status === "failed") {
            process.stderr.write(`[ClaudeGates] Gate ${activeGate.gate_agent} exhausted rounds. Scope "${scope}" gate chain FAILED.\n`);
          } else if (result) {
            process.stderr.write(`[ClaudeGates] Gate ${activeGate.gate_agent} returned REVISE. Spawn fixer "${activeGate.fixer_agent}" with scope=${scope}.\n`);
          }
        } else {
          const result = gatesDb.reviseGate(db, scope, activeGate.order);
          if (result && result.status === "failed") {
            process.stderr.write(`[ClaudeGates] Gate ${activeGate.gate_agent} exhausted rounds. Scope "${scope}" gate chain FAILED.\n`);
          } else if (result) {
            process.stderr.write(`[ClaudeGates] Gate ${activeGate.gate_agent} returned REVISE. Resume source agent "${activeGate.source_agent}" with scope=${scope}.\n`);
          }
        }
      }
      return; // gate agent handled, don't check source path
    }

    // Case 2a: This agent is the FIXER agent for a gate in fix status
    const fixGateRow = gates.find(g => g.fixer_agent === agentType && g.status === "fix");
    if (fixGateRow) {
      const reactivated = gatesDb.reactivateFixGate(db, scope);
      if (reactivated) {
        process.stderr.write(`[ClaudeGates] Fixer agent "${agentType}" completed. Gate reactivated for re-run.\n`);
      }
      return;
    }

    // Case 2b: This agent is the SOURCE agent for gates in revise status
    const sourceAgent = gates[0].source_agent;
    if (sourceAgent === agentType) {
      const reactivated = gatesDb.reactivateReviseGate(db, scope);
      if (reactivated) {
        process.stderr.write(`[ClaudeGates] Source agent "${agentType}" re-completed. Gate reactivated for re-run.\n`);
      }
    }
  } else {
    // No gates in DB yet — check if this agent defines gates (first completion)
    const agentGates = parseGates(mdContent);
    if (agentGates && (finalVerdict === "PASS" || finalVerdict === "CONVERGED")) {
      gatesDb.initGates(db, scope, agentType, agentGates);
      process.stderr.write(
        `[ClaudeGates] Initialized ${agentGates.length} gate(s) for scope "${scope}": ${agentGates.map(g => g.agent).join(" -> ")}. ` +
        `Next: spawn ${agentGates[0].agent} with scope=${scope}.\n`
      );
    }
  }
}

/**
 * Output a block decision.
 */
/**
 * Extract verdict from a message string using VERDICT_RE.
 */
function extractVerdict(message) {
  const match = VERDICT_RE.exec(message);
  return match ? match[1].toUpperCase() : "UNKNOWN";
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: `[ClaudeGates] ${reason}` }));
}
