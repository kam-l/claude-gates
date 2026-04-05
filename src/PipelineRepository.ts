import type BetterSqlite3 from "better-sqlite3";
import { StepStatus, } from "./types/Enums";
import type { IAgentRow, IPipelineState, IPipelineStep, VerificationStep, } from "./types/Interfaces";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pipeline_steps (
  scope         TEXT NOT NULL,
  step_index    INTEGER NOT NULL,
  step_type     TEXT NOT NULL,
  prompt        TEXT,
  command       TEXT,
  allowed_tools TEXT,
  agent         TEXT,
  max_rounds    INTEGER DEFAULT 3,
  fixer         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  round         INTEGER NOT NULL DEFAULT 0,
  source_agent  TEXT NOT NULL,
  PRIMARY KEY (scope, step_index)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_steps_status ON pipeline_steps(status);

CREATE TABLE IF NOT EXISTS pipeline_state (
  scope          TEXT PRIMARY KEY,
  source_agent   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'normal',
  current_step   INTEGER NOT NULL DEFAULT 0,
  revision_step  INTEGER,
  total_steps    INTEGER NOT NULL,
  trace_id       TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  scope          TEXT NOT NULL,
  agent          TEXT NOT NULL,
  outputFilepath TEXT,
  verdict        TEXT,
  "check"        TEXT,
  round          INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, agent)
);

CREATE TABLE IF NOT EXISTS edits (
  filepath TEXT PRIMARY KEY,
  lines    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tool_history (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL
);
`;

const TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS trim_history AFTER INSERT ON tool_history
BEGIN
  DELETE FROM tool_history WHERE id <= (
    SELECT id FROM tool_history ORDER BY id DESC LIMIT 1 OFFSET 10
  );
END;
`;

export class PipelineRepository
{
  private readonly _db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database,)
  {
    this._db = db;
  }

  public static initSchema(db: BetterSqlite3.Database,): void
  {
    db.exec(SCHEMA_SQL,);
    db.exec(TRIGGER_SQL,);
    try
    {
      db.exec("ALTER TABLE pipeline_state ADD COLUMN trace_id TEXT",);
    }
    catch
    {
    }
    try
    {
      db.exec("ALTER TABLE agents ADD COLUMN \"check\" TEXT",);
    }
    catch
    {
    }
  }

  // ── Pipeline CRUD ──────────────────────────────────────────────────

  public insertPipeline(scope: string, sourceAgent: string, totalSteps: number,): void
  {
    this._db.prepare(
      "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) VALUES (?, ?, 'normal', 0, ?)",
    ).run(scope, sourceAgent, totalSteps,);
  }

  public insertStep(scope: string, stepIndex: number, step: VerificationStep, sourceAgent: string,): void
  {
    this._db.prepare(
      "INSERT INTO pipeline_steps (scope, step_index, step_type, prompt, command, allowed_tools, agent, max_rounds, fixer, status, round, source_agent) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
    ).run(
      scope,
      stepIndex,
      step.type,
      "prompt" in step ? step.prompt : null,
      null,
      null,
      "agent" in step ? step.agent : null,
      "maxRounds" in step ? step.maxRounds : 3,
      "fixer" in step ? step.fixer : null,
      stepIndex === 0 ? StepStatus.Active : StepStatus.Pending,
      sourceAgent,
    );
  }

  public pipelineExists(scope: string,): boolean
  {
    return !!this._db.prepare("SELECT 1 FROM pipeline_state WHERE scope = ? LIMIT 1",).get(scope,);
  }

  public getStep(scope: string, stepIndex: number,): IPipelineStep | null
  {
    return this._db.prepare(
      "SELECT * FROM pipeline_steps WHERE scope = ? AND step_index = ?",
    ).get(scope, stepIndex,) as IPipelineStep | undefined || null;
  }

  public getActiveStep(scope: string,): IPipelineStep | null
  {
    return this._db.prepare(
      "SELECT * FROM pipeline_steps WHERE scope = ? AND status = 'active' LIMIT 1",
    ).get(scope,) as IPipelineStep | undefined || null;
  }

  public getStepByStatus(scope: string, status: string,): IPipelineStep | null
  {
    return this._db.prepare(
      "SELECT * FROM pipeline_steps WHERE scope = ? AND status = ? ORDER BY step_index LIMIT 1",
    ).get(scope, status,) as IPipelineStep | undefined || null;
  }

  public getSteps(scope: string,): IPipelineStep[]
  {
    return this._db.prepare(
      "SELECT * FROM pipeline_steps WHERE scope = ? ORDER BY step_index",
    ).all(scope,) as IPipelineStep[];
  }

  public getPipelineState(scope: string,): IPipelineState | null
  {
    return this._db.prepare("SELECT * FROM pipeline_state WHERE scope = ?",).get(scope,) as IPipelineState | undefined || null;
  }

  public updateStepStatus(scope: string, stepIndex: number, status: string, round?: number,): void
  {
    if (round !== undefined)
    {
      this._db.prepare(
        "UPDATE pipeline_steps SET status = ?, round = ? WHERE scope = ? AND step_index = ?",
      ).run(status, round, scope, stepIndex,);
    }
    else
    {
      this._db.prepare(
        "UPDATE pipeline_steps SET status = ? WHERE scope = ? AND step_index = ?",
      ).run(status, scope, stepIndex,);
    }
  }

  public updatePipelineState(scope: string, updates: Partial<IPipelineState>,): void
  {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, val,] of Object.entries(updates,))
    {
      sets.push(`${key} = ?`,);
      vals.push(val,);
    }
    if (sets.length === 0)
    {
      return;
    }
    vals.push(scope,);
    this._db.prepare(`UPDATE pipeline_state SET ${sets.join(", ",)} WHERE scope = ?`,).run(...vals,);
  }

  public deletePipeline(scope: string,): void
  {
    const del = this._db.transaction(() =>
    {
      this._db.prepare("DELETE FROM pipeline_steps WHERE scope = ?",).run(scope,);
      this._db.prepare("DELETE FROM pipeline_state WHERE scope = ?",).run(scope,);
    },);
    del();
  }

  public getActivePipelines(): IPipelineState[]
  {
    return this._db.prepare(
      "SELECT * FROM pipeline_state WHERE status IN ('normal', 'revision')",
    ).all() as IPipelineState[];
  }

  public hasNonPassedSteps(scope: string,): boolean
  {
    return !!this._db.prepare(
      "SELECT 1 FROM pipeline_steps WHERE scope = ? AND status != 'passed' LIMIT 1",
    ).get(scope,);
  }

  // ── Agent CRUD ─────────────────────────────────────────────────────

  public registerAgent(scope: string, agent: string, outputFilepath: string,): void
  {
    this._db.prepare(
      "INSERT INTO agents (scope, agent, outputFilepath) VALUES (?, ?, ?) "
        + "ON CONFLICT(scope, agent) DO UPDATE SET outputFilepath = excluded.outputFilepath",
    ).run(scope, agent, outputFilepath,);
  }

  public setVerdict(scope: string, agent: string, verdict: string, round: number, check?: string,): void
  {
    if (check)
    {
      this._db.prepare(
        "UPDATE agents SET verdict = ?, \"check\" = ?, round = ? WHERE scope = ? AND agent = ?",
      ).run(verdict, check, round, scope, agent,);
    }
    else
    {
      this._db.prepare(
        "UPDATE agents SET verdict = ?, round = ? WHERE scope = ? AND agent = ?",
      ).run(verdict, round, scope, agent,);
    }
  }

  public getAgent(scope: string, agent: string,): IAgentRow | null
  {
    return this._db.prepare("SELECT * FROM agents WHERE scope = ? AND agent = ?",).get(scope, agent,) as IAgentRow | undefined || null;
  }

  public isCleared(scope: string, agent: string,): boolean
  {
    return !!this._db.prepare("SELECT 1 FROM agents WHERE scope = ? AND agent = ?",).get(scope, agent,);
  }

  public findAgentScope(agent: string,): string | null
  {
    // Prefer scope with an active pipeline (handles same-agent-name in multiple scopes)
    const row = this._db.prepare(
      `SELECT a.scope FROM agents a
       LEFT JOIN pipeline_state p ON a.scope = p.scope
       WHERE a.agent = ? AND a.scope != '_meta' AND a.scope != '_pending'
       ORDER BY
         (CASE WHEN p.status IN ('normal','revision') THEN 0 ELSE 1 END),
         a.verdict IS NULL DESC,
         a.rowid DESC
       LIMIT 1`,
    ).get(agent,) as { scope: string; } | undefined;
    return row ? row.scope : null;
  }

  public getPending(agent: string,): { scope: string; outputFilepath: string; } | null
  {
    return this._db.prepare(
      "SELECT scope, outputFilepath FROM agents WHERE agent = ? AND scope = '_pending' LIMIT 1",
    ).get(agent,) as { scope: string; outputFilepath: string; } | undefined || null;
  }

  // ── Edit tracking ──────────────────────────────────────────────────

  public addEdit(filepath: string, lines?: number,): void
  {
    this._db.prepare(
      "INSERT INTO edits (filepath, lines) VALUES (?, ?) ON CONFLICT(filepath) DO UPDATE SET lines = lines + excluded.lines",
    ).run(filepath, lines || 0,);
  }

  public getEdits(): string[]
  {
    return this._db.prepare("SELECT filepath FROM edits",).all().map((r: any,) => r.filepath);
  }

  public getEditCounts(): { files: number; lines: number; }
  {
    const row = this._db.prepare("SELECT COUNT(*) as files, COALESCE(SUM(lines), 0) as lines FROM edits",).get() as {
      files: number;
      lines: number;
    };
    return { files: row.files, lines: row.lines, };
  }

  // ── Tool history ───────────────────────────────────────────────────

  public addToolHash(hash: string,): void
  {
    this._db.prepare("INSERT INTO tool_history (hash) VALUES (?)",).run(hash,);
  }

  public getLastNHashes(n: number,): string[]
  {
    return this._db.prepare("SELECT hash FROM tool_history ORDER BY id DESC LIMIT ?",).all(n,).map((r: any,) => r.hash);
  }

  // ── Trace support ──────────────────────────────────────────────────

  public getTraceId(scope: string,): string | null
  {
    const row = this._db.prepare("SELECT trace_id FROM pipeline_state WHERE scope = ?",).get(scope,) as
      | { trace_id: string | null; }
      | undefined;
    return row ? row.trace_id : null;
  }

  public setTraceId(scope: string, traceId: string,): void
  {
    this._db.prepare("UPDATE pipeline_state SET trace_id = ? WHERE scope = ?",).run(traceId, scope,);
  }

  // ── Transaction helper ─────────────────────────────────────────────

  public transaction<T,>(fn: () => T,): T
  {
    return this._db.transaction(fn,)();
  }
}
