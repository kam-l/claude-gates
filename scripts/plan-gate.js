#!/usr/bin/env node
/**
 * ClaudeGates v2 — PreToolUse:ExitPlanMode gate.
 *
 * Blocks ExitPlanMode until plan has been verified by gater agent.
 *
 * Allows if:
 *   - gater agent has a PASS or CONVERGED verdict in SQLite, OR
 *   - most recent .md in ~/.claude/plans/ is <=20 lines (trivial plan), OR
 *   - plans dir is absent (fail-open), OR
 *   - plan_gate_attempts >= MAX_ATTEMPTS (safety valve)
 *
 * Verdict-based: reads gater verdicts from the agents table (SQLite).
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { getDb, getAttempts, incrAttempts, resetAttempts } = require("./claude-gates-db.js");

const TRIVIAL_LINE_LIMIT = 20;
const MAX_ATTEMPTS = 3;

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);
  const plansDir = path.join(HOME, ".claude", "plans");

  // ── Check for gater verdict (SQLite) ──
  const db = getDb(sessionDir);
  let gaterVerified = false;

  try {
    const row = db.prepare(
      "SELECT 1 FROM agents WHERE agent = 'gater' AND verdict IN ('PASS','CONVERGED') LIMIT 1"
    ).get();
    gaterVerified = !!row;
  } catch {}
  db.close();

  if (gaterVerified) process.exit(0); // verified — allow

  // ── Trivial plan bypass ──
  let planFiles;
  try {
    planFiles = fs.readdirSync(plansDir)
      .filter(f => f.endsWith(".md") && !/-agent-/.test(f))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(plansDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    process.exit(0); // no plans dir — fail-open
  }

  if (planFiles.length === 0) process.exit(0); // no plans — allow

  const planPath = path.join(plansDir, planFiles[0].name);
  const lines = fs.readFileSync(planPath, "utf-8").split("\n").length;
  if (lines <= TRIVIAL_LINE_LIMIT) process.exit(0); // trivial plan — allow

  // ── Attempt tracking — auto-allow after MAX_ATTEMPTS ──
  const db2 = getDb(sessionDir);
  incrAttempts(db2, "_system", "plan-gate");
  const attempts = getAttempts(db2, "_system", "plan-gate");
  if (attempts >= MAX_ATTEMPTS) {
    resetAttempts(db2, "_system", "plan-gate");
    db2.close();
    process.stderr.write(`[ClaudeGates] ⚠️ plan: Safety valve activated.\n`);
    process.exit(0);
  }
  db2.close();

  // ── Block ──
  const reason = `[ClaudeGates] 🔒 plan: "${planFiles[0].name}" (${lines} lines) unverified. Spawn claude-gates:gater with scope=verify-plan.`;
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason,
    systemMessage: reason,
  }));
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
