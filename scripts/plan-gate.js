#!/usr/bin/env node
/**
 * ClaudeGates v2 — PreToolUse:ExitPlanMode gate.
 *
 * Blocks ExitPlanMode until plan has been verified by gater agent.
 *
 * Allows if:
 *   - gater agent has a PASS or CONVERGED verdict in session_scopes, OR
 *   - most recent .md in ~/.claude/plans/ is <=20 lines (trivial plan), OR
 *   - plans dir is absent (fail-open), OR
 *   - plan_gate_attempts >= MAX_ATTEMPTS (auto-allow after 3 blocks)
 *
 * Verdict-based: reads gater verdicts from the cleared table (SQLite) or
 * session_scopes.json (JSON fallback). No separate stamp mechanism needed.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { getDb, getEditStat, incrEditStat, setEditStat } = require("./claude-gates-db.js");

const TRIVIAL_LINE_LIMIT = 20;
const MAX_ATTEMPTS = 3;

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);
  const plansDir = path.join(HOME, ".claude", "plans");

  // ── Check for gater verdict ──
  const db = getDb(sessionDir);
  let gaterVerified = false;

  if (db) {
    // SQLite: check cleared table for gater with PASS or CONVERGED
    try {
      const row = db.prepare(
        "SELECT 1 FROM cleared WHERE agent = 'gater' AND verdict IN ('PASS','CONVERGED') LIMIT 1"
      ).get();
      gaterVerified = !!row;
    } catch {}
    db.close();
  } else {
    // JSON fallback: scan session_scopes.json
    try {
      const scopesFile = path.join(sessionDir, "session_scopes.json");
      const scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8"));
      for (const [scope, info] of Object.entries(scopes)) {
        if (scope === "_pending" || !info || !info.cleared) continue;
        const gaterEntry = info.cleared.gater;
        if (gaterEntry && typeof gaterEntry === "object" &&
            (gaterEntry.verdict === "PASS" || gaterEntry.verdict === "CONVERGED")) {
          gaterVerified = true;
          break;
        }
      }
    } catch {}
  }

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
  if (db2) {
    incrEditStat(db2, "plan_gate_attempts", 1);
    const attempts = getEditStat(db2, "plan_gate_attempts") || 0;
    if (attempts >= MAX_ATTEMPTS) {
      setEditStat(db2, "plan_gate_attempts", 0);
      db2.close();
      process.stderr.write(`[ClaudeGates] Plan gate auto-allowed after ${MAX_ATTEMPTS} verification attempts.\n`);
      process.exit(0);
    }
    db2.close();
  } else {
    const attemptsFile = path.join(sessionDir, "plan_gate_attempts");
    let attempts = 0;
    try { attempts = parseInt(fs.readFileSync(attemptsFile, "utf-8").trim(), 10) || 0; } catch {}
    attempts++;
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(attemptsFile, String(attempts), "utf-8");
    if (attempts >= MAX_ATTEMPTS) {
      fs.writeFileSync(attemptsFile, "0", "utf-8");
      process.stderr.write(`[ClaudeGates] Plan gate auto-allowed after ${MAX_ATTEMPTS} verification attempts.\n`);
      process.exit(0);
    }
  }

  // ── Block ──
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: `[ClaudeGates] Plan "${planFiles[0].name}" has ${lines} lines and hasn't been verified.` +
      ` Run /verify ${planPath.replace(/\\/g, "/")} before exiting plan mode. (auto-allows after ${MAX_ATTEMPTS} attempts)`
  }));
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
