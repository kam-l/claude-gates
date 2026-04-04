/**
 * Test helper — thin wrapper providing the (db, scope, ...) calling convention
 * used by pipeline-test.ts, test-pipeline-e2e.ts, and benchmark.ts.
 *
 * Production hooks import PipelineEngine directly.
 */

import type BetterSqlite3 from "better-sqlite3";
import { PipelineEngine, } from "./PipelineEngine";
import { PipelineRepository, } from "./PipelineRepository";
import type { Action, IStepInput, VerificationStep, } from "./types/Interfaces";

function createPipeline(db: BetterSqlite3.Database, scope: string, sourceAgent: string, steps: VerificationStep[],): void
{
  new PipelineEngine(new PipelineRepository(db,),).createPipeline(scope, sourceAgent, steps,);
}

function step(db: BetterSqlite3.Database, scope: string, input: string | IStepInput,): Action
{
  return new PipelineEngine(new PipelineRepository(db,),).step(scope, input,);
}

function retryGateAgent(db: BetterSqlite3.Database, scope: string,): Action
{
  return new PipelineEngine(new PipelineRepository(db,),).retryGateAgent(scope,);
}

function getNextAction(db: BetterSqlite3.Database, scope: string,): Action
{
  return new PipelineEngine(new PipelineRepository(db,),).getNextAction(scope,);
}

function getAllNextActions(db: BetterSqlite3.Database,): NonNullable<Action>[]
{
  return new PipelineEngine(new PipelineRepository(db,),).getAllNextActions();
}

function resolveRole(db: BetterSqlite3.Database, scope: string, agentType: string,): string
{
  return new PipelineEngine(new PipelineRepository(db,),).resolveRole(scope, agentType,);
}

export { createPipeline, getAllNextActions, getNextAction, resolveRole, retryGateAgent, step, };
