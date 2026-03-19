#!/usr/bin/env node
/**
 * AgentGate v1 — PreToolUse:Agent conditions hook.
 *
 * Checks `requires:` dependencies before allowing an agent to spawn.
 * Extracts `scope=<name>` from the agent's prompt to locate scope directory.
 *
 * Flow:
 *   1. Resume? → allow (no gating on resumed agents)
 *   2. Extract scope from prompt (regex: scope=([A-Za-z0-9_-]+))
 *   3. No scope? → allow (ungated agent, backward compatible)
 *   4. Find agent .md → parse requires:
 *   5. No requires → allow
 *   6. For each required type: check {session_dir}/{scope}/{type}.md exists
 *   7. Missing → exit 2: "Missing {type}.md — spawn {type} first"
 *   8. All exist → allow
 *
 * Also: creates scope dir, registers scope + cleared agent in session_scopes.json.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { parseRequires, findAgentMd } = require("./agent-gate-shared.js");

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

  // Extract scope
  const scopeMatch = prompt.match(/scope=([A-Za-z0-9_-]+)/);
  const scope = scopeMatch ? scopeMatch[1] : null;

  // No scope → ungated, allow
  if (!scope) process.exit(0);

  // Reject reserved scope names (collide with internal keys in session_scopes.json)
  if (scope === "_pending") process.exit(0);

  // No agent type → allow
  if (!agentType) process.exit(0);

  // Session dir
  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);
  const scopeDir = path.join(sessionDir, scope);

  // Find agent definition and parse requires
  const agentMdPath = findAgentMd(agentType, PROJECT_ROOT, HOME);
  if (!agentMdPath) process.exit(0); // no agent .md → no gate

  const mdContent = fs.readFileSync(agentMdPath, "utf-8");
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
        reason: `[AgentGate] Cannot spawn ${agentType}: missing ${missing.map(m => m + ".md").join(", ")} in ${scope}/. Spawn ${missing.join(", ")} first.`
      }));
      process.exit(0);
    }
  }

  // Create scope dir if first agent
  if (!fs.existsSync(scopeDir)) {
    fs.mkdirSync(scopeDir, { recursive: true });
  }

  // Register scope + cleared agent in session_scopes.json
  const scopesFile = path.join(sessionDir, "session_scopes.json");
  let scopes = {};
  try {
    scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8"));
  } catch {} // missing or invalid → start fresh

  if (!scopes[scope]) scopes[scope] = { cleared: {} };
  scopes[scope].cleared[agentType] = true;

  // Stage output_filepath for injection hook (SubagentStart reads this)
  const outputFilepath = path.join(scopeDir, `${agentType}.md`).replace(/\\/g, "/");
  if (!scopes._pending) scopes._pending = {};
  scopes._pending[agentType] = { scope, outputFilepath };

  // Ensure session dir exists before writing
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  fs.writeFileSync(scopesFile, JSON.stringify(scopes, null, 2), "utf-8");

  // Allow
  process.exit(0);
} catch (err) {
  // Fail-open
  process.stderr.write(`[AgentGate conditions] Error: ${err.message}\n`);
  process.exit(0);
}
