#!/usr/bin/env node
/**
 * Pipeline v3 — SessionStart cleanup.
 *
 * Prunes old session directories from {CWD}/.sessions/ (and legacy ~/.claude/sessions/).
 * Deletes dirs where session.db is older than MAX_AGE_DAYS.
 * Skips the current session. Fail-open.
 */

const fs = require("fs");
const path = require("path");

const MAX_AGE_DAYS = 7;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));
  const currentSession = data.session_id || "";
  const currentShort = currentSession.replace(/-/g, "").slice(0, 8);

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionsDirs = [
    path.join(process.cwd(), ".sessions"),
    path.join(HOME, ".claude", "sessions")  // legacy location
  ];

  const now = Date.now();
  let pruned = 0;

  for (const sessionsDir of sessionsDirs) {
    if (!fs.existsSync(sessionsDir)) continue;

    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === currentSession || entry.name === currentShort) continue;

      const dirPath = path.join(sessionsDir, entry.name);
      const dbPath = path.join(dirPath, "session.db");

      // Only prune dirs that have a session.db (ours)
      if (!fs.existsSync(dbPath)) continue;

      try {
        const stat = fs.statSync(dbPath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          pruned++;
        }
      } catch {} // skip on permission/lock errors
    }
  }

  if (pruned > 0) {
    process.stderr.write(`[ClaudeGates] 🧹 Pruned ${pruned} session(s) older than ${MAX_AGE_DAYS} days.\n`);
  }
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
