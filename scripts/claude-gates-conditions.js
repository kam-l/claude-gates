#!/usr/bin/env node
/**
 * ClaudeGates v2 — PreToolUse:Agent conditions hook.
 *
 * Checks `requires:` dependencies and `gates:` chain enforcement before
 * allowing an agent to spawn. Extracts `scope=<name>` from the agent's prompt.
 *
 * Flow:
 *   1. Resume? → allow (no gating on resumed agents)
 *   2. No agent type? → allow
 *   3. Find agent .md → parse frontmatter
 *   4. No agent .md? → allow (no gate definition)
 *   5. Has CG fields (gates/requires/conditions) but no scope? → BLOCK
 *   6. No scope? → allow (ungated agent, backward compatible)
 *   7. Requires check: all required artifacts must exist in scope dir
 *   8. Conditions: semantic pre-check via claude -p (if conditions: field present)
 *   9. Gate enforcement: active gate → only that gate agent; revise → only source agent
 *  10. Register scope + cleared + pending
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { parseRequires, parseConditions, requiresScope, findAgentMd } = require("./claude-gates-shared.js");
const gatesDb = require("./claude-gates-db.js");

const HOME = process.env.USERPROFILE || process.env.HOME || "";
const PROJECT_ROOT = process.cwd();

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  // PreToolUse:Agent provides tool_input with prompt and subagent_type
  const toolInput = data.tool_input || {};
  const agentType = toolInput.subagent_type || "";
  const prompt = toolInput.prompt || "";

  // Resume → allow (no gating)
  if (toolInput.resume) process.exit(0);

  // No agent type → allow
  if (!agentType) process.exit(0);

  // Find agent definition early (needed for scope-required check)
  const agentMdPath = findAgentMd(agentType, PROJECT_ROOT, HOME);
  let mdContent = null;
  if (agentMdPath) {
    mdContent = fs.readFileSync(agentMdPath, "utf-8");
  }

  // Extract scope
  const scopeMatch = prompt.match(/scope=([A-Za-z0-9_-]+)/);
  const scope = scopeMatch ? scopeMatch[1] : null;

  // No scope handling
  if (!scope) {
    if (mdContent && requiresScope(mdContent)) {
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: `[ClaudeGates] Agent "${agentType}" has gates/requires fields but was spawned without scope=<name>. Add scope=<name> to the prompt.`
      }));
    }
    process.exit(0);
  }

  // Reject reserved scope names
  if (scope === "_pending") process.exit(0);

  // No agent .md → no gate
  if (!agentMdPath || !mdContent) process.exit(0);

  // Session dir
  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);
  const scopeDir = path.join(sessionDir, scope);

  // Parse requires
  const requires = parseRequires(mdContent);

  // Check all required artifacts exist
  if (requires && requires.length > 0) {
    const missing = [];
    for (const req of requires) {
      const reqPath = path.join(scopeDir, `${req}.md`);
      if (!fs.existsSync(reqPath)) missing.push(req);
    }
    if (missing.length > 0) {
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: `[ClaudeGates] Cannot spawn ${agentType}: missing ${missing.map(m => m + ".md").join(", ")} in ${scope}/. Spawn ${missing.join(", ")} first.`
      }));
      process.exit(0);
    }
  }

  // ── Semantic pre-check (conditions:) ──
  const conditions = parseConditions(mdContent);
  if (conditions) {
    try {
      const condPrompt = conditions + "\n\nAgent spawn prompt:\n" + prompt;
      const condResult = execSync(
        "claude -p --model sonnet --agent claude-gates:gater --max-turns 1 --tools \"\" --no-chrome --strict-mcp-config",
        {
          input: condPrompt,
          cwd: PROJECT_ROOT,
          timeout: 30000,
          encoding: "utf-8",
          shell: true,
          env: { ...process.env, CLAUDECODE: "" }
        }
      ).trim();
      const condLines = condResult.split("\n").filter(l => l.trim());
      const condLast = condLines.length > 0 ? condLines[condLines.length - 1].trim() : "";
      const condMatch = /^(PASS|FAIL)(?:[:\s\u2014\u2013-]+(.*))?$/i.exec(condLast);
      if (condMatch && condMatch[1].toUpperCase() === "FAIL") {
        const reason = condMatch[2] ? condMatch[2].trim() : "Pre-spawn conditions check failed";
        process.stdout.write(JSON.stringify({
          decision: "block",
          reason: `[ClaudeGates] Conditions check failed for ${agentType}: ${reason}`
        }));
        process.exit(0);
      }
      process.stderr.write(`[ClaudeGates] Conditions: ${condMatch ? condMatch[1].toUpperCase() : "UNKNOWN"} for ${agentType}\n`);
    } catch {
      // Semantic check failed — fail-open
      process.stderr.write(`[ClaudeGates] Conditions check skipped for ${agentType} (claude -p unavailable)\n`);
    }
  }

  // Create scope dir if first agent
  if (!fs.existsSync(scopeDir)) {
    fs.mkdirSync(scopeDir, { recursive: true });
  }

  const outputFilepath = path.join(scopeDir, `${agentType}.md`).replace(/\\/g, "/");

  // SQLite: gate enforcement + scope registration
  const db = gatesDb.getDb(sessionDir);

  // ── Gate enforcement ──
  const activeGate = gatesDb.getActiveGate(db, scope);
  const reviseGate = gatesDb.getReviseGate(db, scope);
  const fixGate = gatesDb.getFixGate(db, scope);

  if (activeGate && agentType !== activeGate.gate_agent) {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `[ClaudeGates] Scope "${scope}" has active gate: ${activeGate.gate_agent}. Spawn ${activeGate.gate_agent} with scope=${scope}.`
    }));
    db.close();
    process.exit(0);
  }

  if (fixGate && agentType !== fixGate.fixer_agent) {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `[ClaudeGates] Scope "${scope}" gate "${fixGate.gate_agent}" returned REVISE. Spawn fixer "${fixGate.fixer_agent}" with scope=${scope} to fix, then re-run the gate.`
    }));
    db.close();
    process.exit(0);
  }

  if (reviseGate && agentType !== reviseGate.source_agent && agentType !== (reviseGate.fixer_agent || "")) {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `[ClaudeGates] Scope "${scope}" gate "${reviseGate.gate_agent}" returned REVISE. Resume source agent "${reviseGate.source_agent}" with scope=${scope} to fix, then re-run the gate.`
    }));
    db.close();
    process.exit(0);
  }

  // Single atomic insert/update
  gatesDb.registerAgent(db, scope, agentType, outputFilepath);
  db.close();

  // Allow
  process.exit(0);
} catch (err) {
  // Fail-open
  process.stderr.write(`[ClaudeGates conditions] Error: ${err.message}\n`);
  process.exit(0);
}
