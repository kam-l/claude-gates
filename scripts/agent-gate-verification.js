#!/usr/bin/env node
/**
 * AgentGate v1 — SubagentStop verification hook (BLOCKING).
 *
 * Hybrid enforcement:
 *   Layer 1 (deterministic): file exists, Result: line present, scope registered
 *   Layer 2 (semantic): claude -p judges whether content is substantive
 *
 * Fail-open on infrastructure errors. Hard-block on intentional gates.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { parseVerification, findAgentMd, VERDICT_RE } = require("./agent-gate-shared.js");

const PROJECT_ROOT = process.cwd();
const HOME = process.env.USERPROFILE || process.env.HOME || "";

try {
  let data;
  try { data = JSON.parse(fs.readFileSync(0, "utf-8")); } catch { process.exit(0); }

  if (data.stop_hook_active) process.exit(0);

  const agentType = data.agent_type || "";
  if (!agentType) process.exit(0);

  const agentId = data.agent_id || "unknown";
  const sessionId = data.session_id || "unknown";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);
  const lastMessage = data.last_assistant_message || "";

  // Find agent definition
  const agentMdPath = findAgentMd(agentType, PROJECT_ROOT, HOME);
  if (!agentMdPath) process.exit(0);

  const mdContent = fs.readFileSync(agentMdPath, "utf-8");
  const verification = parseVerification(mdContent);

  // No verification prompt → no gate
  if (!verification) process.exit(0);

  // ── Locate artifact ──
  // Path 1: new schema — extract from last message
  const artifactInfo = extractArtifactPath(lastMessage, sessionDir, agentType);

  if (artifactInfo) {
    validateScopeAndVerify(artifactInfo, verification, sessionDir, agentType, agentId);
    process.exit(0);
  }

  // Path 2: legacy — old gate: schema with .context/tasks/
  try {
    const compat = require("./agent-gate-compat.js");
    const legacyInfo = compat.extractLegacyArtifactPath(mdContent, PROJECT_ROOT);
    if (legacyInfo) {
      compat.runLegacyVerification(legacyInfo, verification, mdContent, data, PROJECT_ROOT, HOME, runSemanticCheck);
      process.exit(0);
    }
  } catch {} // compat module missing → skip legacy path

  // Path 3: scope lookup — agent was cleared but path not in message
  const clearedScope = findClearedScope(sessionDir, agentType);
  if (clearedScope) {
    const expectedPath = path.join(sessionDir, clearedScope, `${agentType}.md`);
    if (fs.existsSync(expectedPath)) {
      runVerification(expectedPath, clearedScope, verification, sessionDir, agentType, agentId);
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `[AgentGate] Write your artifact to ${sessionDir.replace(/\\/g, "/")}/${clearedScope}/${agentType}.md before stopping. Include a Result: PASS or Result: FAIL line.`
    }));
    process.exit(0);
  }

  // No scope, no legacy match → fail-open (ungated usage)
  process.exit(0);
} catch (err) {
  process.stderr.write(`[AgentGate verification] Error: ${err.message}\n`);
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
 * Find which scope this agent was cleared for in session_scopes.json.
 */
function findClearedScope(sessionDir, agentType) {
  try {
    const scopesFile = path.join(sessionDir, "session_scopes.json");
    const scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8"));
    for (const [scope, info] of Object.entries(scopes)) {
      if (info.cleared && info.cleared[agentType]) return scope;
    }
  } catch {}
  return null;
}

/**
 * Validate scope registration then run verification.
 */
function validateScopeAndVerify(artifactInfo, verification, sessionDir, agentType, agentId) {
  const { artifactPath, scope } = artifactInfo;

  // Validate scope against session_scopes.json
  if (scope) {
    try {
      const scopes = JSON.parse(fs.readFileSync(path.join(sessionDir, "session_scopes.json"), "utf-8"));
      if (!scopes[scope]) {
        block(`Scope "${scope}" not registered. Were you spawned with scope=${scope}?`);
        return;
      }
      if (!scopes[scope].cleared || !scopes[scope].cleared[agentType]) {
        block(`Agent "${agentType}" not cleared for scope "${scope}".`);
        return;
      }
    } catch {} // missing scopes file → proceed (fail-open)
  }

  if (!fs.existsSync(artifactPath)) {
    block(`Artifact not found at ${artifactPath.replace(/\\/g, "/")}. Write it before stopping.`);
    return;
  }

  runVerification(artifactPath, scope, verification, sessionDir, agentType, agentId);
}

/**
 * Layer 1 (deterministic) + Layer 2 (semantic) verification.
 */
function runVerification(artifactPath, scope, verification, sessionDir, agentType, agentId) {
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
  runSemanticCheck(verification, artifactContent, artifactPath, contextContent, agentType, agentId, null, scope, sessionDir);
}

/**
 * Run claude -p semantic validation.
 * Uses stdin pipe — no shell expansion, no injection risk.
 */
function runSemanticCheck(prompt, artifactContent, artifactPath, contextContent, agentType, agentId, sessionId, scope, sessionDir) {
  const resolvedSessionDir = sessionDir || (sessionId ? path.join(HOME, ".claude", "sessions", sessionId) : null);

  let combinedPrompt = prompt + "\n\n";
  combinedPrompt += `--- ${path.basename(artifactPath)} ---\n${artifactContent}\n`;
  if (contextContent) combinedPrompt += contextContent;

  let result;
  try {
    // Pipe prompt via stdin — eliminates shell injection and temp files
    result = execSync(
      "claude -p --model sonnet --max-turns 1",
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
    return; // fail-open
  }

  // Parse last line for PASS/FAIL
  const lines = result.split("\n").filter(l => l.trim());
  const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";
  const verdictMatch = /^(PASS|FAIL)(?:[:\s\u2014\u2013-]+(.*))?$/i.exec(lastLine);

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
        `# AgentGate: ${agentType}\n` +
        `- **Timestamp:** ${new Date().toISOString()}\n` +
        `- **Artifact:** ${artifactPath.replace(/\\/g, "/")}\n` +
        (scope ? `- **Scope:** ${scope}\n` : "") +
        `- **Verdict:** ${verdictMatch ? verdictMatch[1].toUpperCase() : "UNKNOWN"}\n` +
        `- **Reason:** ${verdictMatch && verdictMatch[2] ? verdictMatch[2].trim() : "N/A"}\n` +
        `- **Full response:**\n\`\`\`\n${result}\n\`\`\`\n`,
        "utf-8"
      );
    } catch {} // non-fatal
  }

  if (verdictMatch && verdictMatch[1].toUpperCase() === "FAIL") {
    const reason = verdictMatch[2] ? verdictMatch[2].trim() : "Semantic validation failed";
    block(`Your ${path.basename(artifactPath)} failed semantic validation: ${reason}. Rewrite it with substantive content.`);
    return;
  }

  // PASS or unparseable → allow (fail-open)
  process.stderr.write(`[AgentGate] ${agentType}: ${lastLine}\n`);
}

/**
 * Output a block decision.
 */
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: `[AgentGate] ${reason}` }));
}
