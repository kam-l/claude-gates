#!/usr/bin/env node
/**
 * Pipeline Web UI — SessionStart launcher.
 *
 * Idempotent: probes /health before spawning. Writes PID file.
 * Always exits 0 (fail-open).
 */

import { spawn, } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";

const SESSIONS_DIR = path.join(process.cwd(), ".sessions",);
const PID_FILE = path.join(SESSIONS_DIR, ".webui.pid",);
const PORT = parseInt(process.env.CLAUDE_GATES_PORT || "64735", 10,);
const SCRIPT = path.join(__dirname, "WebServer.js",);

function healthCheck(): Promise<boolean>
{
  return new Promise((resolve,) =>
  {
    const req = http.get(`http://127.0.0.1:${PORT}/health`, (res,) =>
    {
      let body = "";
      res.on("data", (chunk: Buffer,) =>
      {
        body += chunk;
      },);
      res.on("end", () =>
      {
        try
        {
          const data = JSON.parse(body,);
          resolve(data.app === "claude-gates",);
        }
        catch
        {
          resolve(false,);
        }
      },);
    },);
    req.on("error", () => resolve(false,),);
    req.setTimeout(1000, () =>
    {
      req.destroy();
      resolve(false,);
    },);
  },);
}

function cleanStalePid(): void
{
  try
  {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8",).trim(), 10,);
    if (pid)
    {
      try
      {
        process.kill(pid, 0,); // test if alive
        return; // process is alive, leave it
      }
      catch
      {
        // process is dead, remove stale PID file
      }
    }
    fs.unlinkSync(PID_FILE,);
  }
  catch
  {
    // no PID file
  }
}

async function main(): Promise<void>
{
  // Already running?
  const alive = await healthCheck();
  if (alive)
  {
    process.exit(0,);
  }

  // Clean stale PID
  cleanStalePid();

  // Ensure sessions dir exists
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, },);

  // Spawn detached server
  const child = spawn(process.execPath, [SCRIPT,], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CLAUDE_GATES_PORT: String(PORT,), },
  },);

  child.unref();

  if (child.pid)
  {
    fs.writeFileSync(PID_FILE, String(child.pid,), "utf-8",);
  }

  process.exit(0,);
}

main().catch(() => process.exit(0,));
