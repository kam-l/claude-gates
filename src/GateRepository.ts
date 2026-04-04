/**
 * Gate-specific DB operations — plan-gate attempts and MCP verdict storage.
 *
 * Shares the `agents` table with PipelineRepository (single DDL source in
 * PipelineRepository.initSchema). This class adds plan-gate-specific operations
 * (attempts tracking) and the upsert variant of setVerdict for MCP verdicts.
 */

import type BetterSqlite3 from "better-sqlite3";
import { PipelineRepository, } from "./PipelineRepository";
import { SessionManager, } from "./SessionManager";

export class GateRepository
{
  private readonly _db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database,)
  {
    this._db = db;
  }

  public static createDb(sessionDir: string,): BetterSqlite3.Database
  {
    const db = SessionManager.openDatabase(sessionDir,);
    PipelineRepository.initSchema(db,);
    return db;
  }

  public getAttempts(scope: string, agent: string,): number
  {
    const row = this._db.prepare("SELECT attempts FROM agents WHERE scope = ? AND agent = ?",).get(scope, agent,) as
      | { attempts: number; }
      | undefined;
    return row ? row.attempts : 0;
  }

  public incrAttempts(scope: string, agent: string,): void
  {
    this._db.prepare(
      "INSERT INTO agents (scope, agent, attempts) VALUES (?, ?, 1) "
        + "ON CONFLICT(scope, agent) DO UPDATE SET attempts = attempts + 1",
    ).run(scope, agent,);
  }

  public resetAttempts(scope: string, agent: string,): void
  {
    this._db.prepare(
      "INSERT INTO agents (scope, agent, attempts) VALUES (?, ?, 0) "
        + "ON CONFLICT(scope, agent) DO UPDATE SET attempts = 0",
    ).run(scope, agent,);
  }

  public setVerdict(scope: string, agent: string, verdict: string, round: number,): void
  {
    this._db.prepare(
      "INSERT INTO agents (scope, agent, verdict, round) VALUES (?, ?, ?, ?) "
        + "ON CONFLICT(scope, agent) DO UPDATE SET verdict = excluded.verdict, round = excluded.round",
    ).run(scope, agent, verdict, round,);
  }
}
