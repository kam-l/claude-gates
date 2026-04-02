#!/usr/bin/env node
/**
 * ClaudeGates v2 — PostToolUse:ExitPlanMode hook.
 *
 * Clears the gater verdict after every ExitPlanMode so the next plan
 * requires fresh verification. Fires regardless of accept/reject.
 *
 * Fail-open.
 */

import fs from "fs";
import { getDb } from "./claude-gates-db";
import { getSessionDir } from "./pipeline-shared";

try {
  const data: any = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const sessionDir = getSessionDir(sessionId);

  const db = getDb(sessionDir);
  try {
    // Clears ALL gater verdicts across all scopes — intentional.
    // Any new plan requires fresh verification regardless of scope.
    db.prepare(
      "DELETE FROM agents WHERE agent = 'gater' AND verdict IS NOT NULL"
    ).run();
  } finally {
    db.close();
  }

  process.exit(0);
} catch {
  process.exit(0); // fail-open
}

export {};
