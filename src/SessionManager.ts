import type BetterSqlite3 from "better-sqlite3";
import fs from "fs";
import path from "path";

let Database!: typeof BetterSqlite3;
try
{
  Database = require("better-sqlite3",);
}
catch
{
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  let loadError: Error | undefined;
  if (dataDir)
  {
    try
    {
      Database = require(path.join(dataDir, "node_modules", "better-sqlite3",),);
    }
    catch (e)
    {
      loadError = e as Error;
    }
  }
  if (!Database)
  {
    const pluginDir = __dirname.replace(/[\\/]scripts$/, "",);
    const isAbiMismatch = loadError && /NODE_MODULE_VERSION|was compiled against/.test(loadError.message,);
    const hint = isAbiMismatch
      ? "ABI mismatch — rebuild with: cd \"" + dataDir + "\" && npm rebuild better-sqlite3"
      : "Run \"npm install\" in the plugin data directory.";
    process.stderr.write(
      `[ClaudeGates] ❌ better-sqlite3 failed to load. ${hint}\n`
        + `  Plugin path: ${pluginDir}\n`
        + `  Data dir: ${dataDir || "(CLAUDE_PLUGIN_DATA not set)"}\n`
        + (loadError ? `  Error: ${loadError.message}\n` : ""),
    );
    throw new Error("better-sqlite3 not found",);
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

  public static openDatabase(sessionDir: string,): BetterSqlite3.Database
  {
    if (!fs.existsSync(sessionDir,))
    {
      fs.mkdirSync(sessionDir, { recursive: true, },);
    }
    const dbPath = path.join(sessionDir, "session.db",);
    const db = new Database(dbPath,);
    db.pragma("journal_mode = WAL",);
    return db;
  }
}
