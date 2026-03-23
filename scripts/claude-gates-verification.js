#!/usr/bin/env node
/**
 * ClaudeGates v2 — SubagentStop verification hook (BLOCKING).
 *
 * Hybrid enforcement:
 *   Layer 1 (deterministic): file exists, Result: line present, scope registered
 *   Layer 2 (semantic): claude -p judges whether content is substantive
 *
 * Scope resolution (parallel-safe):
 *   Primary: agent_transcript_path (subagent's own JSONL, first line has scope=)
 *   Fallback: extractArtifactPath (parse scope from last_assistant_message)
 *   Fallback: findClearedScope (DB lookup)
 *
 * If injection gave wrong scope (parallel race in getPending), SubagentStop
 * detects the mismatch via transcript and moves the artifact to the correct
 * scope directory before verifying.
 *
 * Verdict recording:
 *   After verification, records structured verdict objects to SQLite
 *   with round tracking.
 *
 * NOTE: hook stderr goes to subagent transcripts
 * (~/.claude/projects/.../subagents/agent-{id}.jsonl), not terminal.
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

/**
 * Extract scope= from a transcript JSONL file (first 2KB).
 * The first line is the user message (spawn prompt) containing scope=.
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
  // so findAgentMd won't find it. Extract verdict directly from last_assistant_message.
  // NOTE: gaters use hardcoded "gater-review" scope — they don't participate in pipeline
  // scoping. This block must stay ABOVE the transcript scope resolution.
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
      // Try transcript first for parallel-safe scope, then extractArtifactPath
      const transcriptScope0 = extractScopeFromTranscript(data.agent_transcript_path)
        || extractScopeFromTranscript(
          data.transcript_path && agentId !== "unknown"
            ? data.transcript_path.replace(/\.jsonl$/, "") + "/subagents/agent-" + agentId + ".jsonl"
            : null
        );
      const artifactInfo0 = extractArtifactPath(lastMessage, sessionDir, agentType);
      const targetScope0 = transcriptScope0 || (artifactInfo0 ? artifactInfo0.scope : null);

      // Check if this agent is a fixer completing for a gate in 'fix' status
      const fixRow = targetScope0
        ? db0.prepare("SELECT scope FROM gates WHERE fixer_agent = ? AND status = 'fix' AND scope = ? LIMIT 1").get(bareAgentType, targetScope0)
        : db0.prepare("SELECT scope FROM gates WHERE fixer_agent = ? AND status = 'fix' LIMIT 1").get(bareAgentType);
      if (fixRow) {
        // Move fixer artifact to canonical path so reviewer can read it
        if (targetScope0 && agentId && agentId !== "unknown") {
          const tempPath = path.join(sessionDir, `${agentId}.md`);
          const canonPath = path.join(sessionDir, fixRow.scope, `${bareAgentType}.md`);
          if (fs.existsSync(tempPath)) {
            try {
              fs.mkdirSync(path.dirname(canonPath), { recursive: true });
              fs.copyFileSync(tempPath, canonPath);
              fs.unlinkSync(tempPath);
            } catch {}
          }
        }
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
      // Check if this agent is a gate agent completing its review
      const gateRow = targetScope0
        ? db0.prepare("SELECT scope FROM gates WHERE gate_agent = ? AND status = 'active' AND scope = ? LIMIT 1").get(bareAgentType, targetScope0)
        : db0.prepare("SELECT scope FROM gates WHERE gate_agent = ? AND status = 'active' LIMIT 1").get(bareAgentType);
      if (gateRow) {
        const finalVerdict = extractVerdict(lastMessage);
        processGateTransitions(db0, gateRow.scope, bareAgentType, finalVerdict, mdContent);
        process.exit(0);
      }
    } finally {
      db0.close();
    }
    process.exit(0);
  }

  // ── Authoritative scope resolution via subagent transcript ──────────
  // agent_transcript_path = subagent's own JSONL (exists at SubagentStop).
  // First line is the spawn prompt containing scope=<name>.
  // Parallel-safe: each agent_id has its own transcript with correct scope.
  // Falls back to deriving the path from transcript_path + agent_id.
  const transcriptScope = extractScopeFromTranscript(data.agent_transcript_path)
    || extractScopeFromTranscript(
      data.transcript_path && agentId !== "unknown"
        ? data.transcript_path.replace(/\.jsonl$/, "") + "/subagents/agent-" + agentId + ".jsonl"
        : null
    );

  const db = gatesDb.getDb(sessionDir);

  try {
    // ── Transcript-resolved scope: move agent_id artifact to canonical path ──
    // Injection writes to {session_dir}/{agent_id}.md (unique, collision-free).
    // Here we move it to {session_dir}/{scope}/{agent_type}.md (canonical path
    // used by gate chains and artifact completeness checks).
    if (transcriptScope) {
      const correctPath = path.join(sessionDir, transcriptScope, `${bareAgentType}.md`);
      const scopeDir = path.dirname(correctPath);

      // Move from agent_id temp path to canonical scope path.
      // Always overwrite — on retries (FAIL/REVISE) the new artifact replaces the stale one.
      const tempPath = path.join(sessionDir, `${agentId}.md`);
      if (fs.existsSync(tempPath)) {
        if (!fs.existsSync(scopeDir)) fs.mkdirSync(scopeDir, { recursive: true });
        try {
          fs.copyFileSync(tempPath, correctPath);
          fs.unlinkSync(tempPath);
        } catch {} // if move fails, fall through to block
      }

      if (fs.existsSync(correctPath)) {
        // Artifact at canonical path → proceed with verification
        if (verification) {
          runVerification(correctPath, transcriptScope, verification, sessionDir, agentType, agentId, mdContent, db);
        } else {
          runGatesOnlyCheck({ artifactPath: correctPath, scope: transcriptScope }, sessionDir, agentType, mdContent, db);
        }
        process.exit(0);
      }

      // Artifact missing — block until agent writes it
      if (!fs.existsSync(scopeDir)) fs.mkdirSync(scopeDir, { recursive: true });
      block(`Write your artifact to ${sessionDir.replace(/\\/g, "/")}/${transcriptScope}/${bareAgentType}.md before stopping. Include a Result: PASS or Result: FAIL line.`);
      process.exit(0);
    }

    // ── Fallback: no transcript scope (ungated or transcript missing) ──

    // Path 1: extract scope from last_assistant_message
    const artifactInfo = extractArtifactPath(lastMessage, sessionDir, agentType);

    if (artifactInfo) {
      if (verification) {
        validateScopeAndVerify(artifactInfo, verification, sessionDir, agentType, agentId, mdContent, db);
      } else {
        runGatesOnlyCheck(artifactInfo, sessionDir, agentType, mdContent, db);
      }
      process.exit(0);
    }

    // Path 2: scope lookup from DB
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

  // Detect if this is a gate/fixer agent (their artifact is a review, not primary content)
  const bareType = agentType.includes(":") ? agentType.split(":").pop() : agentType;
  const isGateOrFixer = db && scope && db.prepare(
    "SELECT 1 FROM gates WHERE (gate_agent = ? OR fixer_agent = ?) AND scope = ? LIMIT 1"
  ).get(bareType, bareType, scope);

  let combinedPrompt = prompt + "\n\n";
  if (isGateOrFixer) {
    combinedPrompt += `NOTE: This artifact is a REVIEW or FIX of another artifact, not primary content. ` +
      `Judge whether this review/fix is well-structured, specific, and actionable. ` +
      `Negative findings about the SOURCE artifact are expected and correct — do not penalize the reviewer for identifying problems.\n\n`;
  }
  combinedPrompt += `--- ${path.basename(artifactPath)} ---\n${artifactContent}\n`;
  if (contextContent) combinedPrompt += contextContent;

  let result = "";
  let semanticSkipped = false;
  try {
    // Pipe prompt via stdin — eliminates shell injection and temp files
    result = execSync(
      "claude -p --model sonnet --agent claude-gates:gater --max-turns 1 --tools \"\" --no-chrome --strict-mcp-config --system-prompt \"\" --disable-slash-commands --no-session-persistence",
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
  // Semantic FAIL overrides artifact verdict for ALL agents:
  //   Source agents: FAIL → exit(2), gate-block forces resume
  //   Gate agents: FAIL → REVISE (bad review = no review, gate agent must retry)
  // FAIL→revise transition prevents the old deadlock where gate stayed 'active'.

  let finalVerdict = "UNKNOWN";
  const artifactVerdictMatch = VERDICT_RE.exec(artifactContent);

  // Check if this agent is a gate agent (has active gate row in DB)
  const isGateAgent = db && scope && db.prepare(
    "SELECT 1 FROM gates WHERE gate_agent = ? AND scope = ? AND status = 'active' LIMIT 1"
  ).get(agentType.includes(":") ? agentType.split(":").pop() : agentType, scope);

  if (semanticMatch && semanticMatch[1].toUpperCase() === "FAIL" && !isGateAgent) {
    // Source agent: semantic FAIL overrides
    finalVerdict = "FAIL";
  } else if (semanticMatch && semanticMatch[1].toUpperCase() === "FAIL" && isGateAgent) {
    // Gate agent: bad review is no review — gate stays active, gate agent must retry.
    // Increment round to prevent infinite retries; exhaust → failed.
    const bare = agentType.includes(":") ? agentType.split(":").pop() : agentType;
    const gateRow = db.prepare(
      'SELECT "order", round, max_rounds FROM gates WHERE gate_agent = ? AND scope = ? AND status = \'active\' LIMIT 1'
    ).get(bare, scope);
    if (gateRow) {
      const newRound = gateRow.round + 1;
      if (newRound >= gateRow.max_rounds) {
        db.prepare('UPDATE gates SET status = \'failed\', round = ? WHERE scope = ? AND "order" = ?')
          .run(newRound, scope, gateRow.order);
        process.stderr.write(`[ClaudeGates] Gate ${bare} semantic FAIL — exhausted ${gateRow.max_rounds} rounds. Scope "${scope}" gate chain FAILED.\n`);
      } else {
        db.prepare('UPDATE gates SET round = ? WHERE scope = ? AND "order" = ?')
          .run(newRound, scope, gateRow.order);
        process.stderr.write(`[ClaudeGates] Gate ${bare} semantic FAIL (bad review) — re-spawn ${bare} with scope=${scope} (round ${newRound}/${gateRow.max_rounds}).\n`);
      }
    }
    // Record the FAIL verdict but skip processGateTransitions (handled above)
    recordVerdict(resolvedSessionDir, scope, agentType, "FAIL", db);
    process.stderr.write(`[ClaudeGates] Verdict: FAIL (semantic).\n`);
    process.exit(2);
  } else {
    // Use artifact's own Result: line
    finalVerdict = artifactVerdictMatch ? artifactVerdictMatch[1].toUpperCase() : "UNKNOWN";
  }

  // Record verdict
  const verdictObj = recordVerdict(resolvedSessionDir, scope, agentType, finalVerdict, db);

  if (verdictObj) {
    process.stderr.write(`[ClaudeGates] Verdict: ${finalVerdict}.\n`);
  }

  // PASS/REVISE/CONVERGED/UNKNOWN → allow (orchestrator reads session_scopes.json for retry decisions)
  if (!verdictObj) {
    process.stderr.write(`[ClaudeGates] ${agentType}: ${lastLine}\n`);
  }

  // ── Gate state machine transitions ──
  // Always run transitions — even on FAIL. SubagentStop may not support
  // decision:block, so the agent completes regardless. Gate agent FAIL is
  // treated as REVISE (routes to fixer or source agent for improvement).
  processGateTransitions(db, scope, agentType, finalVerdict, mdContent);

  // FAIL: exit 2 + stderr → orchestrator sees the reason and can re-spawn/resume.
  // stdout block doesn't work at SubagentStop; exit 2 feeds stderr to the parent.
  if (finalVerdict === "FAIL") {
    const reason = semanticMatch && semanticMatch[2] ? semanticMatch[2].trim() : "Semantic validation failed";
    process.stderr.write(`[ClaudeGates] FAIL: ${path.basename(artifactPath)} — ${reason}. Resume or re-spawn ${agentType} with scope=${scope} to fix.\n`);
    process.exit(2);
  }
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

  // Normalize to bare agent type — gates table stores bare names (from conditions hook)
  const bare = agentType.includes(":") ? agentType.split(":").pop() : agentType;

  const gates = gatesDb.getGates(db, scope);

  if (gates.length > 0) {
    // Case 1: This agent IS an active gate agent
    const activeGate = gates.find(g => g.gate_agent === bare && g.status === "active");
    if (activeGate) {
      if (finalVerdict === "PASS" || finalVerdict === "CONVERGED") {
        const { nextGate, allPassed } = gatesDb.passGate(db, scope, activeGate.order);
        if (allPassed) {
          process.stderr.write(`[ClaudeGates] All gates passed for scope "${scope}". Scope fully unblocked.\n`);
        } else if (nextGate) {
          process.stderr.write(`[ClaudeGates] Gate ${activeGate.gate_agent} passed. Next gate: ${nextGate.gate_agent} (spawn with scope=${scope}).\n`);
        }
      } else if (finalVerdict === "FAIL") {
        // FAIL = *this* gate agent failed — stays active, re-run gate agent itself.
        // Round increment + exhaustion handled by gate-agent semantic FAIL path above.
        // If we reach here from artifact Result: FAIL (not semantic), bump round too.
        const newRound = activeGate.round + 1;
        if (newRound >= activeGate.max_rounds) {
          db.prepare('UPDATE gates SET status = \'failed\', round = ? WHERE scope = ? AND "order" = ?')
            .run(newRound, scope, activeGate.order);
          process.stderr.write(`[ClaudeGates] Gate ${activeGate.gate_agent} FAIL — exhausted ${activeGate.max_rounds} rounds. Scope "${scope}" gate chain FAILED.\n`);
        } else {
          db.prepare('UPDATE gates SET round = ? WHERE scope = ? AND "order" = ?')
            .run(newRound, scope, activeGate.order);
          process.stderr.write(`[ClaudeGates] Gate ${activeGate.gate_agent} FAIL — re-spawn ${activeGate.gate_agent} with scope=${scope} (round ${newRound}/${activeGate.max_rounds}).\n`);
        }
      } else if (finalVerdict === "REVISE") {
        // REVISE = *reviewed* source agent failed — route to fixer or source
        if (activeGate.fixer_agent) {
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
    const fixGateRow = gates.find(g => g.fixer_agent === bare && g.status === "fix");
    if (fixGateRow) {
      const reactivated = gatesDb.reactivateFixGate(db, scope);
      if (reactivated) {
        process.stderr.write(`[ClaudeGates] Fixer agent "${bare}" completed. Gate reactivated for re-run.\n`);
      }
      return;
    }

    // Case 2b: This agent is the SOURCE agent for gates in revise status
    const sourceAgent = gates[0].source_agent;
    if (sourceAgent === bare) {
      const reactivated = gatesDb.reactivateReviseGate(db, scope);
      if (reactivated) {
        process.stderr.write(`[ClaudeGates] Source agent "${bare}" re-completed. Gate reactivated for re-run.\n`);
      }
    }
  } else {
    // Gates should already be initialized at SubagentStart (injection hook).
    // Fallback: init here if injection didn't run (e.g. hook ordering race).
    const agentGates = parseGates(mdContent);
    if (agentGates && gatesDb.getGates(db, scope).length === 0) {
      gatesDb.initGates(db, scope, bare, agentGates);
      process.stderr.write(
        `[ClaudeGates] Initialized ${agentGates.length} gate(s) for scope "${scope}" (fallback). Next: spawn ${agentGates[0].agent} with scope=${scope}.\n`
      );
    }
  }
}

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
