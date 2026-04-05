/**
 * Pipeline v3 — state machine engine.
 *
 * Owns ALL state transitions. PipelineRepository is pure CRUD.
 *
 * Primary entry point:
 *   step(scope, input) — agent completed, process verdict, return next action
 *
 * Input can be:
 *   string — backward compat, treated as artifactVerdict
 *   IStepInput — { role, artifactVerdict }
 *
 * Role-aware dispatch:
 *   source     — if pipeline in revision → reactivate revise step; else → normal step
 *   verifier   — normal step on artifact verdict (semantic dispatch handled by hook layer)
 *   fixer      — always reactivate the step that ordered revision
 *   ungated    — null (no pipeline interaction)
 */

import { PipelineRepository, } from "./PipelineRepository";
import { AgentRole, PipelineStatus, StepStatus, StepType, Verdict, } from "./types/Enums";
import type { Action, IPipelineState, IPipelineStep, IStepInput, VerificationStep, } from "./types/Interfaces";

export class PipelineEngine
{
  private readonly _repo: PipelineRepository;

  constructor(repo: PipelineRepository,)
  {
    this._repo = repo;
  }

  // ── Pipeline creation ──────────────────────────────────────────────

  public createPipeline(scope: string, sourceAgent: string, steps: VerificationStep[],): void
  {
    this._repo.transaction(() =>
    {
      if (this._repo.pipelineExists(scope,))
      {
        return;
      }
      this._repo.insertPipeline(scope, sourceAgent, steps.length,);
      for (let i = 0; i < steps.length; i++)
      {
        this._repo.insertStep(scope, i, steps[i], sourceAgent,);
      }
    },);
  }

  // ── Step processing ────────────────────────────────────────────────

  public step(scope: string, input: string | IStepInput,): Action
  {
    return this._repo.transaction(() =>
    {
      const { role, artifactVerdict, } = this.normalizeInput(input,);

      const state = this._repo.getPipelineState(scope,);
      if (!state || state.status === PipelineStatus.Completed || state.status === PipelineStatus.Failed)
      {
        return null;
      }

      if (role === AgentRole.Fixer)
      {
        return this.reactivateRevisionStep(scope,);
      }

      if (role === AgentRole.Source && state.status === PipelineStatus.Revision)
      {
        return this.reactivateRevisionStep(scope,);
      }

      const activeStep = this._repo.getActiveStep(scope,);
      if (!activeStep)
      {
        return null;
      }

      if (
        activeStep.step_type === StepType.Transform
        && (role === AgentRole.Transformer || role === AgentRole.Source || role === AgentRole.Fixer)
      )
      {
        return this.advance(scope, activeStep,);
      }

      if (role === AgentRole.Source && activeStep.step_type !== StepType.Check)
      {
        return this.buildAction(scope,);
      }

      const v = this.normalizeVerdict(artifactVerdict,);

      if (v === Verdict.Pass)
      {
        return this.advance(scope, activeStep,);
      }

      if (v === Verdict.Revise)
      {
        return this.revise(scope, state, activeStep,);
      }

      process.stderr.write(
        `[ClaudeGates] ⚠️ Unknown verdict "${artifactVerdict}" for scope="${scope}" step ${activeStep.step_index}. Treating as PASS.\n`,
      );
      return this.advance(scope, activeStep,);
    },);
  }

  // ── Action query ───────────────────────────────────────────────────

  public getNextAction(scope: string,): Action
  {
    return this.buildAction(scope,);
  }

  public getAllNextActions(): NonNullable<Action>[]
  {
    const pipelines = this._repo.getActivePipelines();
    const actions: NonNullable<Action>[] = [];
    for (const p of pipelines)
    {
      const action = this.buildAction(p.scope,);
      if (action)
      {
        actions.push(action,);
      }
    }
    return actions;
  }

  // ── Role resolution ────────────────────────────────────────────────

  public resolveRole(scope: string, agentType: string,): AgentRole
  {
    if (!scope)
    {
      const pipelines = this._repo.getActivePipelines();
      // Prefer pipelines in revision state (fixer/verifier most likely expected there)
      const sorted = [...pipelines,].sort((a, b,) =>
        (a.status === PipelineStatus.Revision ? 0 : 1) - (b.status === PipelineStatus.Revision ? 0 : 1)
      );
      for (const p of sorted)
      {
        const role = this.resolveRoleInScope(p.scope, agentType, p.source_agent,);
        if (role !== AgentRole.Ungated)
        {
          return role;
        }
      }
      return AgentRole.Ungated;
    }
    const state = this._repo.getPipelineState(scope,);
    if (!state)
    {
      return AgentRole.Ungated;
    }
    return this.resolveRoleInScope(scope, agentType, state.source_agent,);
  }

  /**
   * Retry the same gate agent due to semantic FAIL (bad review).
   * Increments round, checks exhaustion. Gate stays active.
   */
  public retryGateAgent(scope: string,): Action
  {
    return this._repo.transaction(() =>
    {
      const activeStep = this._repo.getActiveStep(scope,);
      if (!activeStep)
      {
        return null;
      }

      const newRound = activeStep.round + 1;

      if (newRound > activeStep.max_rounds)
      {
        this._repo.updateStepStatus(scope, activeStep.step_index, StepStatus.Failed, newRound,);
        this._repo.updatePipelineState(scope, { status: PipelineStatus.Failed, },);
        return { action: "failed", scope, step: activeStep, round: newRound, maxRounds: activeStep.max_rounds, };
      }

      this._repo.updateStepStatus(scope, activeStep.step_index, StepStatus.Active, newRound,);
      return this.buildAction(scope,);
    },);
  }

  // ── Internal: input normalization ──────────────────────────────────

  private normalizeInput(input: string | IStepInput,): { role: string | null; artifactVerdict: string; }
  {
    if (typeof input === "string")
    {
      return { role: null, artifactVerdict: input, };
    }
    return {
      role: input.role || null,
      artifactVerdict: input.artifactVerdict || "UNKNOWN",
    };
  }

  private normalizeVerdict(verdict: string,): Verdict
  {
    const v = (verdict || "").toUpperCase().trim();
    if (v === Verdict.Pass || v === Verdict.Converged)
    {
      return Verdict.Pass;
    }
    if (v === Verdict.Revise || v === Verdict.Fail)
    {
      return Verdict.Revise;
    }
    return Verdict.Unknown;
  }

  // ── Internal: state transitions ────────────────────────────────────

  private advance(scope: string, activeStep: IPipelineStep,): Action
  {
    this._repo.transaction(() =>
    {
      this._repo.updateStepStatus(scope, activeStep.step_index, StepStatus.Passed,);
      const nextIndex = activeStep.step_index + 1;
      const nextStep = this._repo.getStep(scope, nextIndex,);
      if (nextStep && nextStep.status === StepStatus.Pending)
      {
        this._repo.updateStepStatus(scope, nextIndex, StepStatus.Active,);
        this._repo.updatePipelineState(scope, { current_step: nextIndex, } as Partial<IPipelineState>,);
      }
      else if (!this._repo.hasNonPassedSteps(scope,))
      {
        this._repo.updatePipelineState(scope, { status: PipelineStatus.Completed, } as Partial<IPipelineState>,);
      }
    },);

    const state = this._repo.getPipelineState(scope,);
    if (state && state.status === PipelineStatus.Completed)
    {
      return { action: "done", scope, };
    }
    return this.buildAction(scope,);
  }

  private revise(scope: string, state: IPipelineState, activeStep: IPipelineStep,): Action
  {
    const newRound = activeStep.round + 1;

    if (newRound > activeStep.max_rounds)
    {
      this._repo.transaction(() =>
      {
        this._repo.updateStepStatus(scope, activeStep.step_index, StepStatus.Failed, newRound,);
        this._repo.updatePipelineState(scope, { status: PipelineStatus.Failed, } as Partial<IPipelineState>,);
      },);
      return { action: "failed", scope, step: activeStep, round: newRound, maxRounds: activeStep.max_rounds, };
    }

    const hasFixer = activeStep.step_type === StepType.VerifyWithFixer && activeStep.fixer;
    const newStatus = hasFixer ? StepStatus.Fix : StepStatus.Revise;

    this._repo.transaction(() =>
    {
      this._repo.updateStepStatus(scope, activeStep.step_index, newStatus, newRound,);
      this._repo.updatePipelineState(
        scope,
        { status: PipelineStatus.Revision, revision_step: activeStep.step_index, } as Partial<IPipelineState>,
      );
    },);

    const agent = hasFixer ? activeStep.fixer! : state.source_agent;
    const freshStep = this._repo.getStep(scope, activeStep.step_index,) || activeStep;
    return { action: "source", agent, scope, step: freshStep, };
  }

  private reactivateRevisionStep(scope: string,): Action
  {
    const reviseRow = this._repo.getStepByStatus(scope, StepStatus.Revise,);
    const fixRow = this._repo.getStepByStatus(scope, StepStatus.Fix,);
    const target = reviseRow || fixRow;
    if (!target)
    {
      return null;
    }

    this._repo.transaction(() =>
    {
      this._repo.updateStepStatus(scope, target.step_index, StepStatus.Active,);
      this._repo.updatePipelineState(
        scope,
        { status: PipelineStatus.Normal, current_step: target.step_index, revision_step: null, } as Partial<IPipelineState>,
      );
    },);

    return this.buildAction(scope,);
  }

  private buildAction(scope: string,): Action
  {
    const state = this._repo.getPipelineState(scope,);
    if (!state || state.status === PipelineStatus.Completed || state.status === PipelineStatus.Failed)
    {
      return null;
    }

    if (state.status === PipelineStatus.Revision && state.revision_step !== null)
    {
      const revStep = this._repo.getStep(scope, state.revision_step,);
      if (!revStep)
      {
        return null;
      }

      if (revStep.status === StepStatus.Fix && revStep.fixer)
      {
        return { action: "source", agent: revStep.fixer, scope, step: revStep, };
      }
      return { action: "source", agent: state.source_agent, scope, step: revStep, };
    }

    const activeStep = this._repo.getActiveStep(scope,);
    if (!activeStep)
    {
      return null;
    }

    switch (activeStep.step_type)
    {
      case StepType.Check:
        return { action: "semantic", scope, step: activeStep, };

      case StepType.Verify:
      case StepType.VerifyWithFixer:
        return {
          action: "spawn",
          agent: activeStep.agent!,
          scope,
          step: activeStep,
          round: activeStep.round,
          maxRounds: activeStep.max_rounds,
        };

      case StepType.Transform:
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

  private resolveRoleInScope(scope: string, agentType: string, sourceAgent: string,): AgentRole
  {
    const activeStep = this._repo.getActiveStep(scope,);
    if (
      activeStep && activeStep.agent === agentType && activeStep.step_type === StepType.Transform && activeStep.status === StepStatus.Active
    )
    {
      return AgentRole.Transformer;
    }

    if (activeStep && activeStep.agent === agentType && activeStep.status === StepStatus.Active)
    {
      return AgentRole.Verifier;
    }

    const fixRow = this._repo.getStepByStatus(scope, StepStatus.Fix,);
    if (fixRow && fixRow.fixer === agentType)
    {
      return AgentRole.Fixer;
    }

    if (agentType === sourceAgent)
    {
      return AgentRole.Source;
    }

    return AgentRole.Ungated;
  }
}
