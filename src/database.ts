/**
 * Test helper — thin wrapper providing the (db, scope, ...) calling convention
 * used by pipeline-test.ts, test-pipeline-e2e.ts, and benchmark.ts.
 *
 * Production hooks import PipelineRepository/SessionManager directly.
 */

import type BetterSqlite3 from "better-sqlite3";
import { PipelineRepository, } from "./PipelineRepository";
import { SessionManager, } from "./SessionManager";
import type { IAgentRow, IPipelineState, IPipelineStep, VerificationStep, } from "./types/Interfaces";

// Re-export types for backward compat
export type { IAgentRow as AgentRow, IPipelineState as PipelineState, IPipelineStep as PipelineStep, VerificationStep, };

function getDb(sessionDir: string,): BetterSqlite3.Database
{
  const db = SessionManager.openDatabase(sessionDir,);
  PipelineRepository.initSchema(db,);
  return db;
}

// Wrapper functions that create a temporary repo instance
function insertPipeline(db: BetterSqlite3.Database, scope: string, sourceAgent: string, totalSteps: number,): void
{
  new PipelineRepository(db,).insertPipeline(scope, sourceAgent, totalSteps,);
}
function insertStep(db: BetterSqlite3.Database, scope: string, stepIndex: number, step: VerificationStep, sourceAgent: string,): void
{
  new PipelineRepository(db,).insertStep(scope, stepIndex, step, sourceAgent,);
}
function pipelineExists(db: BetterSqlite3.Database, scope: string,): boolean
{
  return new PipelineRepository(db,).pipelineExists(scope,);
}
function getStep(db: BetterSqlite3.Database, scope: string, stepIndex: number,): IPipelineStep | null
{
  return new PipelineRepository(db,).getStep(scope, stepIndex,);
}
function getActiveStep(db: BetterSqlite3.Database, scope: string,): IPipelineStep | null
{
  return new PipelineRepository(db,).getActiveStep(scope,);
}
function getStepByStatus(db: BetterSqlite3.Database, scope: string, status: string,): IPipelineStep | null
{
  return new PipelineRepository(db,).getStepByStatus(scope, status,);
}
function getSteps(db: BetterSqlite3.Database, scope: string,): IPipelineStep[]
{
  return new PipelineRepository(db,).getSteps(scope,);
}
function getPipelineState(db: BetterSqlite3.Database, scope: string,): IPipelineState | null
{
  return new PipelineRepository(db,).getPipelineState(scope,);
}
function updateStepStatus(db: BetterSqlite3.Database, scope: string, stepIndex: number, status: string, round?: number,): void
{
  new PipelineRepository(db,).updateStepStatus(scope, stepIndex, status, round,);
}
function updatePipelineState(db: BetterSqlite3.Database, scope: string, updates: Partial<IPipelineState>,): void
{
  new PipelineRepository(db,).updatePipelineState(scope, updates,);
}
function deletePipeline(db: BetterSqlite3.Database, scope: string,): void
{
  new PipelineRepository(db,).deletePipeline(scope,);
}
function getActivePipelines(db: BetterSqlite3.Database,): IPipelineState[]
{
  return new PipelineRepository(db,).getActivePipelines();
}
function hasNonPassedSteps(db: BetterSqlite3.Database, scope: string,): boolean
{
  return new PipelineRepository(db,).hasNonPassedSteps(scope,);
}
function registerAgent(db: BetterSqlite3.Database, scope: string, agent: string, outputFilepath: string,): void
{
  new PipelineRepository(db,).registerAgent(scope, agent, outputFilepath,);
}
function setVerdict(db: BetterSqlite3.Database, scope: string, agent: string, verdict: string, round: number,): void
{
  new PipelineRepository(db,).setVerdict(scope, agent, verdict, round,);
}
function getAgent(db: BetterSqlite3.Database, scope: string, agent: string,): IAgentRow | null
{
  return new PipelineRepository(db,).getAgent(scope, agent,);
}
function isCleared(db: BetterSqlite3.Database, scope: string, agent: string,): boolean
{
  return new PipelineRepository(db,).isCleared(scope, agent,);
}
function findAgentScope(db: BetterSqlite3.Database, agent: string,): string | null
{
  return new PipelineRepository(db,).findAgentScope(agent,);
}
function getPending(db: BetterSqlite3.Database, agent: string,): { scope: string; outputFilepath: string; } | null
{
  return new PipelineRepository(db,).getPending(agent,);
}
function addEdit(db: BetterSqlite3.Database, filepath: string, lines?: number,): void
{
  new PipelineRepository(db,).addEdit(filepath, lines,);
}
function getEdits(db: BetterSqlite3.Database,): string[]
{
  return new PipelineRepository(db,).getEdits();
}
function getEditCounts(db: BetterSqlite3.Database,): { files: number; lines: number; }
{
  return new PipelineRepository(db,).getEditCounts();
}
function addToolHash(db: BetterSqlite3.Database, hash: string,): void
{
  new PipelineRepository(db,).addToolHash(hash,);
}
function getLastNHashes(db: BetterSqlite3.Database, n: number,): string[]
{
  return new PipelineRepository(db,).getLastNHashes(n,);
}

const getSessionDir = SessionManager.getSessionDir;
const agentRunningMarker = SessionManager.agentRunningMarker;

export {
  addEdit,
  addToolHash,
  agentRunningMarker,
  deletePipeline,
  findAgentScope,
  getActivePipelines,
  getActiveStep,
  getAgent,
  getDb,
  getEditCounts,
  getEdits,
  getLastNHashes,
  getPending,
  getPipelineState,
  getSessionDir,
  getStep,
  getStepByStatus,
  getSteps,
  hasNonPassedSteps,
  insertPipeline,
  insertStep,
  isCleared,
  pipelineExists,
  registerAgent,
  setVerdict,
  updatePipelineState,
  updateStepStatus,
};
