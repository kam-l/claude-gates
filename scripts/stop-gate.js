#!/usr/bin/env node
/**
 * ClaudeGates v3 — Stop gate.
 *
 * 1. Artifact completeness: warns about agents with no verdict or REVISE verdict
 *    in scopes where other agents have completed (PASS/CONVERGED).
 *    Also checks pipeline_state for non-completed pipelines.
 * 2. Debug leftovers: scans edit-gate's file list for configurable debug markers.
 * 3. Custom commands: runs configured validation commands.
 *
 * Mode (via claude-gates.json):
 *   "warn"  (default) — stderr only, no block
 *   "nudge" — blocks first time, passes on second stop
 *
 * StopFailure: cleans up orphaned pipeline_steps so createPipeline can recreate.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { loadConfig } = require("./claude-gates-config.js");

// Import from both v2 and v3 DB modules (fail-open if either missing)
let v2Db, v3Db;
try { v2Db = require("./claude-gates-db.js"); } catch {}
try { v3Db = require("./pipeline-db.js"); } catch {}

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);

  // Open DB (v3 schema is a superset — getDb initializes both sets of tables)
  const db = v3Db ? v3Db.getDb(sessionDir) : (v2Db ? v2Db.getDb(sessionDir) : null);
  if (!db) process.exit(0);

  // ── StopFailure: clean up orphaned state for retry ──
  if (data.error) {
    try {
      // v2: delete orphaned gates
      try {
        const scopes = db.prepare(
          "SELECT DISTINCT scope FROM gates WHERE status IN ('active','revise','fix')"
        ).all().map(r => r.scope);
        if (scopes.length > 0) {
          const del = db.prepare("DELETE FROM gates WHERE scope = ?");
          const tx = db.transaction(() => { for (const s of scopes) del.run(s); });
          tx();
          process.stderr.write(`[ClaudeGates] 🧹 API error — cleared v2 gates for ${scopes.length} scope(s).\n`);
        }
      } catch {} // v2 table may not exist

      // v3: delete orphaned pipeline_steps + pipeline_state for retry
      try {
        const pipelines = db.prepare(
          "SELECT scope FROM pipeline_state WHERE status IN ('normal','revision')"
        ).all().map(r => r.scope);
        if (pipelines.length > 0) {
          const delSteps = db.prepare("DELETE FROM pipeline_steps WHERE scope = ?");
          const delState = db.prepare("DELETE FROM pipeline_state WHERE scope = ?");
          const tx = db.transaction(() => {
            for (const s of pipelines) {
              delSteps.run(s);
              delState.run(s);
            }
          });
          tx();
          process.stderr.write(`[ClaudeGates] 🧹 API error — cleared ${pipelines.length} pipeline(s). Will reinitialize on retry.\n`);
        }
      } catch {} // v3 table may not exist
    } catch {}
    db.close();
    process.exit(0);
  }

  let files;
  const issues = [];

  // Nudge check (v2 pattern — reused)
  try {
    const nudged = db.prepare("SELECT 1 FROM agents WHERE scope = '_nudge' AND agent = 'stop-gate'").get();
    if (nudged) { db.close(); process.exit(0); }
  } catch {}

  // ── v2 artifact completeness check ──
  try {
    const incomplete = db.prepare(
      "SELECT scope, agent FROM agents WHERE (verdict IS NULL OR verdict = 'REVISE') AND SUBSTR(scope, 1, 1) != '_'"
    ).all();

    for (const row of incomplete) {
      const active = db.prepare(
        "SELECT 1 FROM agents WHERE scope = ? AND verdict IN ('PASS','CONVERGED') LIMIT 1"
      ).get(row.scope);
      if (!active) continue;

      const artifactPath = path.join(sessionDir, row.scope, row.agent + ".md");
      if (!fs.existsSync(artifactPath)) {
        issues.push(`  ${row.scope}/${row.agent}: missing artifact (verdict: ${row.verdict || "none"})`);
      }
    }
  } catch {} // non-fatal

  // ── v3 pipeline completeness check ──
  try {
    const activePipelines = db.prepare(
      "SELECT scope, source_agent, status FROM pipeline_state WHERE status IN ('normal','revision')"
    ).all();

    for (const p of activePipelines) {
      if (p.status === "revision") {
        issues.push(`  ${p.scope}: pipeline in revision — source "${p.source_agent}" must re-run`);
      } else {
        // Normal state — check for non-passed steps
        const nonPassed = db.prepare(
          "SELECT step_index, step_type, status, agent FROM pipeline_steps WHERE scope = ? AND status != 'passed'"
        ).all(p.scope);
        if (nonPassed.length > 0) {
          const step = nonPassed[0];
          const desc = step.agent
            ? `step ${step.step_index} (${step.step_type}: ${step.agent}) — ${step.status}`
            : `step ${step.step_index} (${step.step_type}) — ${step.status}`;
          issues.push(`  ${p.scope}: pipeline incomplete — ${desc}`);
        }
      }
    }
  } catch {} // v3 tables may not exist

  // ── Edit tracking ──
  try {
    files = v3Db ? v3Db.getEdits(db) : (v2Db ? v2Db.getEdits(db) : []);
  } catch {
    files = [];
  }
  if (files.length === 0 && issues.length === 0) { db.close(); process.exit(0); }

  // ── Debug leftover scan (configurable patterns) ──
  const config = loadConfig();
  const PATTERNS = (config.stop_gate.patterns || []).map(p => ({
    name: p,
    re: new RegExp(p.includes(".") ? p.replace(/\./g, "\\.") : `\\b${p}\\b`)
  }));

  const MAX_LINES = 5000;
  const matches = [];

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;
    if (/[-.]test\b|\.spec\b|\btest[s]?\//i.test(filePath)) continue;

    let linesToCheck;
    try {
      const diff = execSync(
        `git diff HEAD -- "${filePath}"`,
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
      );
      linesToCheck = diff
        .split("\n")
        .filter(l => l.startsWith("+") && !l.startsWith("+++"))
        .map(l => l.substring(1))
        .slice(0, MAX_LINES);
    } catch {
      try {
        linesToCheck = fs.readFileSync(filePath, "utf-8")
          .split("\n")
          .slice(0, MAX_LINES);
      } catch {
        continue;
      }
    }

    for (let i = 0; i < linesToCheck.length; i++) {
      const line = linesToCheck[i];
      for (const pat of PATTERNS) {
        if (pat.re.test(line)) {
          matches.push({
            file: path.basename(filePath),
            pattern: pat.name,
            line: line.trim().substring(0, 120)
          });
        }
      }
    }
  }

  // ── Run configured commands ──
  for (const cmd of config.stop_gate.commands || []) {
    try {
      execSync(cmd, { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      const output = (err.stderr || err.stdout || "").trim().split("\n").slice(0, 3).join("; ");
      issues.push(`  Command failed: ${cmd}${output ? " — " + output : ""}`);
    }
  }

  // ── Commit nudge: uncommitted tracked files ──
  try {
    const counts = v3Db ? v3Db.getEditCounts(db) : (v2Db ? v2Db.getEditCounts(db) : { files: 0 });
    if (counts.files > 0) {
      const status = execSync("git status --porcelain", {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"]
      }).trim();
      if (status) {
        issues.push(`  ${counts.files} files changed without commit. Consider committing.`);
      }
    }
  } catch {}

  if (matches.length === 0 && issues.length === 0) {
    db.close();
    process.exit(0);
  }

  // Build summary (cap at 10 entries each)
  const parts = [];

  if (issues.length > 0) {
    parts.push(`Incomplete artifacts:\n${issues.slice(0, 10).join("\n")}`);
  }

  if (matches.length > 0) {
    const debugSummary = matches.slice(0, 10)
      .map(m => `  ${m.file}: ${m.pattern} — ${m.line}`)
      .join("\n");
    parts.push(`Debug leftovers found:\n${debugSummary}`);
  }

  const summary = parts.join("\n");

  if (config.stop_gate.mode === "nudge") {
    try {
      if (v3Db) v3Db.registerAgent(db, "_nudge", "stop-gate", null);
      else if (v2Db) v2Db.registerAgent(db, "_nudge", "stop-gate", null);
    } catch {}
    db.close();
    const reason = `[ClaudeGates] ⚠️ ${summary}\nClean up or stop again to proceed.`;
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
  } else {
    db.close();
    process.stderr.write(`[ClaudeGates] ⚠️ ${summary}\n`);
  }
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
