import type BetterSqlite3 from "better-sqlite3";
import fs from "fs";
import path from "path";

let Database: typeof BetterSqlite3 | null = null;
let _loadError: string | null = null;
try
{
  Database = require("better-sqlite3",);
}
catch
{
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  let loadErr: Error | undefined;
  if (dataDir)
  {
    try
    {
      Database = require(path.join(dataDir, "node_modules", "better-sqlite3",),);
    }
    catch (e)
    {
      loadErr = e as Error;
    }
  }
  if (!Database)
  {
    const pluginDir = __dirname.replace(/[\\/]scripts$/, "",);
    const isAbiMismatch = loadErr && /NODE_MODULE_VERSION|was compiled against/.test(loadErr.message,);
    const hint = isAbiMismatch
      ? "ABI mismatch — rebuild with: cd \"" + dataDir + "\" && npm rebuild better-sqlite3"
      : "Run \"npm install\" in the plugin data directory.";
    _loadError = `[ClaudeGates] ❌ better-sqlite3 failed to load. ${hint}\n`
      + `  Plugin path: ${pluginDir}\n`
      + `  Data dir: ${dataDir || "(CLAUDE_PLUGIN_DATA not set)"}\n`
      + (loadErr ? `  Error: ${loadErr.message}\n` : "");
  }
}

export class SessionManager
{
  public static getSessionDir(sessionId: string,): string
  {
    const shortId = sessionId.replace(/-/g, "",).slice(0, 8,);
    return path.join(process.cwd(), ".sessions", shortId,).replace(/\\/g, "/",);
  }

  public static agentRunningMarker(sessionDir: string, scope: string,): string
  {
    return path.join(sessionDir, `.running-${scope}`,).replace(/\\/g, "/",);
  }

  public static gateDisabledMarker(): string
  {
    return path.join(process.cwd(), ".sessions", ".gate-disabled",).replace(/\\/g, "/",);
  }

  public static isGateDisabled(): boolean
  {
    try
    {
      return fs.existsSync(SessionManager.gateDisabledMarker(),);
    }
    catch
    {
      return false;
    }
  }

  public static setGateDisabled(disabled: boolean,): void
  {
    const marker = SessionManager.gateDisabledMarker();
    if (disabled)
    {
      fs.mkdirSync(path.dirname(marker,), { recursive: true, },);
      fs.writeFileSync(marker, "", "utf-8",);
    }
    else
    {
      try
      {
        fs.unlinkSync(marker,);
      }
      catch
      {
      }
    }
  }

  public static openDatabase(sessionDir: string,): BetterSqlite3.Database
  {
    if (!Database)
    {
      if (_loadError)
      {
        process.stderr.write(_loadError,);
      }
      throw new Error("better-sqlite3 not available",);
    }
    if (!fs.existsSync(sessionDir,))
    {
      fs.mkdirSync(sessionDir, { recursive: true, },);
    }
    const dbPath = path.join(sessionDir, "session.db",);
    const db = new Database(dbPath,);
    db.pragma("journal_mode = WAL",);
    db.pragma("busy_timeout = 5000",);
    return db;
  }
}
