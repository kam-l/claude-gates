#!/usr/bin/env node
/**
 * Pipeline v3 — state machine engine.
 *
 * Owns ALL state transitions. DB module is pure CRUD.
 *
 * Primary entry point:
 *   step(db, scope, input) — agent completed, process verdict, return next action
 *
 * Input can be:
 *   string — backward compat, treated as artifactVerdict
 *   { role: 'source'|'verifier'|'fixer'|'ungated',
 *     artifactVerdict: string,
 *     semanticVerdict?: 'PASS'|'FAIL'|null }
 *
 * Role-aware dispatch:
 *   source     — if pipeline in revision → reactivate revise step; else → normal step
 *   verifier — if semanticVerdict FAIL → retry gate; else → normal step on artifactVerdict
 *   fixer      — always reactivate the step that ordered revision
 *   ungated    — null (no pipeline interaction)
 *
 * Returns the same Action type:
 *   { action: 'spawn',   agent, scope, step, round, maxRounds }
 *   { action: 'command', command, allowedTools, scope, step }
 *   { action: 'source',  agent, scope, step }
 *   { action: 'semantic', scope, step }
 *   { action: 'done',    scope }
 *   { action: 'failed',  scope, step, round, maxRounds }
 *   null — no active pipeline
 *
 * C# analogy: this module is a state machine engine, like a custom
 * IStateMachine<PipelineState> with step() as the transition function.
 * Think of it as: each call to step() is like dispatching a Command
 * to a state machine that returns the next Action to take.
 */

import * as crud from "./pipeline-db";
import type { Action, PipelineState, PipelineStep, VerificationStep } from "./types";
import type BetterSqlite3 from "better-sqlite3";

interface StepInput {
  role: string | null;
  artifactVerdict: string;
  semanticVerdict?: string | null;
}

type NormalizedInput = {
  role: string | null;
  artifactVerdict: string;
  semanticVerdict: string | null;
};

type Verdict = "PASS" | "REVISE" | "UNKNOWN";

// ── Pipeline creation ────────────────────────────────────────────────

/**
 * Create a pipeline from parsed verification steps.
 * No-op if pipeline already exists for scope.
 */
function createPipeline(db: BetterSqlite3.Database, scope: string, sourceAgent: string, steps: VerificationStep[]): void {
  const create = db.transaction(() => {
    if (crud.pipelineExists(db, scope)) return;
    crud.insertPipeline(db, scope, sourceAgent, steps.length);
    for (let i = 0; i < steps.length; i++) {
      crud.insertStep(db, scope, i, steps[i], sourceAgent);
    }
  });
  create();
}

// ── Step processing ──────────────────────────────────────────────────

/**
 * Process a verdict for the active step. Drives the state machine.
 */
function step(db: BetterSqlite3.Database, scope: string, input: string | StepInput): Action {
  const { role, artifactVerdict, semanticVerdict } = normalizeInput(input);

  const state = crud.getPipelineState(db, scope);
  if (!state || state.status === "completed" || state.status === "failed") return null;

  // ── Role-aware dispatch ──

  if (role === "fixer") {
    // Fixer completed → always reactivate the step that ordered revision
    return reactivateRevisionStep(db, scope);
  }

  if (role === "source" && state.status === "revision") {
    // Source re-completed during revision → reactivate the revise step
    return reactivateRevisionStep(db, scope);
  }

  if (role === "verifier" && semanticVerdict === "FAIL") {
    // Bad review → retry same gate agent (don't route to source/fixer)
    return retryGateAgent(db, scope);
  }

  // Normal path: process artifact verdict on active step
  const activeStep = crud.getActiveStep(db, scope);
  if (!activeStep) return null;

  // Source completing in normal state: only advance SEMANTIC steps.
  // COMMAND steps are advanced by /pass_or_revise verdict file (role=null).
  // REVIEW/REVIEW_WITH_FIXER steps are advanced by the gate agent (role=verifier).
  // Source completing just means "artifact ready" — return current action.
  if (role === "source" && activeStep.step_type !== "SEMANTIC") {
    return buildAction(db, scope);
  }

  const v = normalizeVerdict(artifactVerdict);

  if (v === "PASS") {
    return advance(db, scope, activeStep);
  }

  if (v === "REVISE") {
    return revise(db, scope, state, activeStep);
  }

  // UNKNOWN — log warning, treat as PASS (fail-open)
  process.stderr.write(`[ClaudeGates] ⚠️ Unknown verdict "${artifactVerdict}" for scope="${scope}" step ${activeStep.step_index}. Treating as PASS.\n`);
  return advance(db, scope, activeStep);
}

// ── Action query ─────────────────────────────────────────────────────

/**
 * What should the orchestrator do right now?
 * Returns an Action or null if no active pipeline.
 */
function getNextAction(db: BetterSqlite3.Database, scope: string): Action {
  return buildAction(db, scope);
}

/**
 * Get next actions across ALL active pipelines (used by block hook).
 * Returns Action[] — one per active scope.
 */
function getAllNextActions(db: BetterSqlite3.Database): NonNullable<Action>[] {
  const pipelines = crud.getActivePipelines(db);
  const actions: NonNullable<Action>[] = [];
  for (const p of pipelines) {
    const action = buildAction(db, p.scope);
    if (action) actions.push(action);
  }
  return actions;
}

// ── Role resolution ──────────────────────────────────────────────────

/**
 * Determine an agent's role in a pipeline.
 * Returns: 'verifier' | 'fixer' | 'source' | 'ungated'
 */
function resolveRole(db: BetterSqlite3.Database, scope: string, agentType: string): "verifier" | "fixer" | "source" | "ungated" {
  if (!scope) {
    const pipelines = crud.getActivePipelines(db);
    for (const p of pipelines) {
      const role = resolveRoleInScope(db, p.scope, agentType, p.source_agent);
      if (role !== "ungated") return role;
    }
    return "ungated";
  }
  const state = crud.getPipelineState(db, scope);
  if (!state) return "ungated";
  return resolveRoleInScope(db, scope, agentType, state.source_agent);
}

// ── Internal: input normalization ────────────────────────────────────

function normalizeInput(input: string | StepInput): NormalizedInput {
  if (typeof input === "string") {
    return { role: null, artifactVerdict: input, semanticVerdict: null };
  }
  return {
    role: input.role || null,
    artifactVerdict: input.artifactVerdict || "UNKNOWN",
    semanticVerdict: input.semanticVerdict || null,
  };
}

function normalizeVerdict(verdict: string): Verdict {
  const v = (verdict || "").toUpperCase().trim();
  if (v === "PASS" || v === "CONVERGED") return "PASS";
  if (v === "REVISE" || v === "FAIL") return "REVISE";
  return "UNKNOWN";
}

// ── Internal: state transitions ──────────────────────────────────────

function advance(db: BetterSqlite3.Database, scope: string, activeStep: PipelineStep): Action {
  const txn = db.transaction(() => {
    crud.updateStepStatus(db, scope, activeStep.step_index, "passed");

    const nextIndex = activeStep.step_index + 1;
    const nextStep = crud.getStep(db, scope, nextIndex);

    if (nextStep && nextStep.status === "pending") {
      crud.updateStepStatus(db, scope, nextIndex, "active");
      crud.updatePipelineState(db, scope, { current_step: nextIndex });
    } else if (!crud.hasNonPassedSteps(db, scope)) {
      crud.updatePipelineState(db, scope, { status: "completed" });
    }
  });
  txn();

  const state = crud.getPipelineState(db, scope);
  if (state && state.status === "completed") {
    return { action: "done", scope };
  }
  return buildAction(db, scope);
}

function revise(db: BetterSqlite3.Database, scope: string, state: PipelineState, activeStep: PipelineStep): Action {
  const newRound = activeStep.round + 1;

  // Exhaustion check: maxRounds = allowed revision cycles.
  // Round 1/N, 2/N ... N/N are within bounds. N+1 > N → exhausted.
  if (newRound > activeStep.max_rounds) {
    const txn = db.transaction(() => {
      crud.updateStepStatus(db, scope, activeStep.step_index, "failed", newRound);
      crud.updatePipelineState(db, scope, { status: "failed" });
    });
    txn();
    return { action: "failed", scope, step: activeStep, round: newRound, maxRounds: activeStep.max_rounds };
  }

  // Route to fixer or source
  const hasFixer = activeStep.step_type === "REVIEW_WITH_FIXER" && activeStep.fixer;
  const newStatus = hasFixer ? "fix" : "revise";

  const txn = db.transaction(() => {
    crud.updateStepStatus(db, scope, activeStep.step_index, newStatus, newRound);
    crud.updatePipelineState(db, scope, { status: "revision", revision_step: activeStep.step_index });
  });
  txn();

  const agent = hasFixer ? activeStep.fixer! : state.source_agent;
  return { action: "source", agent, scope, step: activeStep };
}

/**
 * Reactivate the step that ordered the revision.
 * Used when source/fixer re-completes during revision state.
 */
function reactivateRevisionStep(db: BetterSqlite3.Database, scope: string): Action {
  const reviseRow = crud.getStepByStatus(db, scope, "revise");
  const fixRow = crud.getStepByStatus(db, scope, "fix");
  const target = reviseRow || fixRow;
  if (!target) return null;

  const txn = db.transaction(() => {
    crud.updateStepStatus(db, scope, target.step_index, "active");
    crud.updatePipelineState(db, scope, { status: "normal", current_step: target.step_index, revision_step: null });
  });
  txn();

  return buildAction(db, scope);
}

/**
 * Retry the same gate agent due to semantic FAIL (bad review).
 * Increments round, checks exhaustion. Gate stays active.
 */
function retryGateAgent(db: BetterSqlite3.Database, scope: string): Action {
  const activeStep = crud.getActiveStep(db, scope);
  if (!activeStep) return null;

  const newRound = activeStep.round + 1;

  if (newRound > activeStep.max_rounds) {
    const txn = db.transaction(() => {
      crud.updateStepStatus(db, scope, activeStep.step_index, "failed", newRound);
      crud.updatePipelineState(db, scope, { status: "failed" });
    });
    txn();
    return { action: "failed", scope, step: activeStep, round: newRound, maxRounds: activeStep.max_rounds };
  }

  // Stay active but increment round — gate agent must re-run
  crud.updateStepStatus(db, scope, activeStep.step_index, "active", newRound);
  return buildAction(db, scope);
}

// ── Internal: action building ────────────────────────────────────────

function buildAction(db: BetterSqlite3.Database, scope: string): Action {
  const state = crud.getPipelineState(db, scope);
  if (!state || state.status === "completed" || state.status === "failed") return null;

  // Revision: source or fixer must re-run
  if (state.status === "revision" && state.revision_step !== null) {
    const revStep = crud.getStep(db, scope, state.revision_step);
    if (!revStep) return null;

    if (revStep.status === "fix" && revStep.fixer) {
      return { action: "source", agent: revStep.fixer, scope, step: revStep };
    }
    return { action: "source", agent: state.source_agent, scope, step: revStep };
  }

  // Normal: check active step
  const activeStep = crud.getActiveStep(db, scope);
  if (!activeStep) return null;

  switch (activeStep.step_type) {
    case "SEMANTIC":
      return { action: "semantic", scope, step: activeStep };

    case "COMMAND":
      return {
        action: "command",
        command: activeStep.command!,
        allowedTools: activeStep.allowed_tools ? activeStep.allowed_tools.split(",") : [],
        scope,
        step: activeStep,
      };

    case "REVIEW":
    case "REVIEW_WITH_FIXER":
      return {
        action: "spawn",
        agent: activeStep.agent!,
        scope,
        step: activeStep,
        round: activeStep.round,
        maxRounds: activeStep.max_rounds,
      };

    default:
      return null;
  }
}

function resolveRoleInScope(db: BetterSqlite3.Database, scope: string, agentType: string, sourceAgent: string): "verifier" | "fixer" | "source" | "ungated" {
  // Gate agent: active step has this agent as reviewer
  const activeStep = crud.getActiveStep(db, scope);
  if (activeStep && activeStep.agent === agentType && activeStep.status === "active") {
    return "verifier";
  }

  // Fixer: step in 'fix' status has this agent as fixer
  const fixRow = crud.getStepByStatus(db, scope, "fix");
  if (fixRow && fixRow.fixer === agentType) {
    return "fixer";
  }

  // Source
  if (agentType === sourceAgent) return "source";

  return "ungated";
}

export {
  createPipeline,
  step,
  getNextAction,
  getAllNextActions,
  resolveRole,
};
