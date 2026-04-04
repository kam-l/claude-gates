#!/usr/bin/env node
/**
 * Nuclear pipeline unblock — force-completes all stuck pipelines and clears markers.
 *
 * Usage (from within a Claude Code session):
 *   ! node ${CLAUDE_PLUGIN_ROOT}/scripts/unblock.js [session-id] [scope]
 *
 *   No args     → auto-detect session from .sessions/, nuke all active pipelines
 *   session-id  → specific session, nuke all
 *   scope       → nuke only that scope
 */

import fs from "fs";
import path from "path";
import { Messaging, } from "./Messaging";
import { PipelineRepository, } from "./PipelineRepository";
import { SessionManager, } from "./SessionManager";
import { Tracing, } from "./Tracing";

const args = process.argv.slice(2,);

// ── Resolve session dir ─────────────────────────────────────────────

function findSessionDir(): string | null
{
  const sessionsRoot = path.join(process.cwd(), ".sessions",);
  if (!fs.existsSync(sessionsRoot,))
  {
    return null;
  }

  // If session ID provided, use it
  if (args[0])
  {
    const dir = SessionManager.getSessionDir(args[0],);
    if (fs.existsSync(path.join(dir, "session.db",),))
    {
      return dir;
    }
    // Try raw arg as directory name
    const raw = path.join(sessionsRoot, args[0],);
    if (fs.existsSync(path.join(raw, "session.db",),))
    {
      return raw;
    }
    console.error(`No session.db found for "${args[0]}"`,);
    return null;
  }

  // Auto-detect: find most recent session.db
  let best: { dir: string; mtime: number; } | null = null;
  for (const entry of fs.readdirSync(sessionsRoot,))
  {
    const dbPath = path.join(sessionsRoot, entry, "session.db",);
    try
    {
      const stat = fs.statSync(dbPath,);
      if (!best || stat.mtimeMs > best.mtime)
      {
        best = { dir: path.join(sessionsRoot, entry,), mtime: stat.mtimeMs, };
      }
    }
    catch
    {
    }
  }
  return best ? best.dir : null;
}

const sessionDir = findSessionDir();
if (!sessionDir)
{
  console.error("No session found. Usage: node unblock.js [session-id] [scope]",);
  process.exit(1,);
}

const scope = args[1] || null;
console.log(`Session: ${sessionDir}`,);
if (scope)
{
  console.log(`Scope:   ${scope}`,);
}

// ── Nuke ────────────────────────────────────────────────────────────

const db = SessionManager.openDatabase(sessionDir,);
if (!db)
{
  console.error("Failed to open DB",);
  process.exit(1,);
}
PipelineRepository.initSchema(db,);

try
{
  // Snapshot before nuke
  let stuckPipelines: any[] = [];
  let stuckSteps: any[] = [];
  try
  {
    stuckPipelines = scope
      ? db.prepare("SELECT scope, status, current_step FROM pipeline_state WHERE scope = ?",).all(scope,)
      : db.prepare("SELECT scope, status, current_step FROM pipeline_state WHERE status IN ('normal', 'revision')",).all();
    stuckSteps = scope
      ? db.prepare(
        "SELECT scope, step_index, step_type, status, agent, round FROM pipeline_steps WHERE status IN ('active','revise','fix') AND scope = ?",
      ).all(scope,)
      : db.prepare(
        "SELECT scope, step_index, step_type, status, agent, round FROM pipeline_steps WHERE status IN ('active','revise','fix')",
      ).all();
  }
  catch
  {
  }

  if (stuckPipelines.length === 0 && stuckSteps.length === 0)
  {
    console.log("Nothing stuck.",);
    db.close();
    process.exit(0,);
  }

  // Print what we're nuking
  console.log(`\nNuking ${stuckPipelines.length} pipeline(s):`,);
  for (const p of stuckPipelines)
  {
    console.log(`  ${p.scope}: status=${p.status} step=${p.current_step}`,);
  }
  for (const s of stuckSteps)
  {
    console.log(`  ${s.scope}/step${s.step_index} (${s.step_type}): ${s.status} agent=${s.agent || "-"} round=${s.round}`,);
  }

  // Nuclear delete
  const txn = db.transaction(() =>
  {
    const scopes = stuckPipelines.map((p: any,) => p.scope);
    for (const s of scopes)
    {
      db.prepare("DELETE FROM pipeline_steps WHERE scope = ?",).run(s,);
      db.prepare("DELETE FROM pipeline_state WHERE scope = ?",).run(s,);
      db.prepare("DELETE FROM agents WHERE scope = ?",).run(s,);
    }
    try
    {
      db.prepare("DELETE FROM gates WHERE status IN ('active','revise','fix')",).run();
    }
    catch
    {
    }
  },);
  txn();

  console.log("Pipelines deleted.",);

  // Clean markers
  const cleaned: string[] = [];
  try
  {
    for (const f of fs.readdirSync(sessionDir,))
    {
      if (f.startsWith(".running-",) || f.startsWith(".pending-scope-",))
      {
        fs.unlinkSync(path.join(sessionDir, f,),);
        cleaned.push(f,);
      }
    }
  }
  catch
  {
  }
  try
  {
    const notifPath = path.join(sessionDir, Messaging.NOTIFICATION_FILE,);
    if (fs.existsSync(notifPath,))
    {
      fs.unlinkSync(notifPath,);
      cleaned.push(".notifications",);
    }
  }
  catch
  {
  }

  if (cleaned.length > 0)
  {
    console.log(`Cleaned ${cleaned.length} marker/notification file(s).`,);
  }

  // Audit via shared trace
  for (const p of stuckPipelines)
  {
    Tracing.trace(sessionDir, "unblock", p.scope, { status: p.status, step: p.current_step, markers: cleaned, },);
  }

  console.log("\nUnblocked. Retry your action.",);
}
finally
{
  db.close();
}
