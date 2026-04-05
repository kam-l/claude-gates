"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PipelineEngine = void 0;
const Enums_1 = require("./types/Enums");
class PipelineEngine {
    _repo;
    constructor(repo) {
        this._repo = repo;
    }
    // ── Pipeline creation ──────────────────────────────────────────────
    createPipeline(scope, sourceAgent, steps) {
        this._repo.transaction(() => {
            if (this._repo.pipelineExists(scope)) {
                return;
            }
            this._repo.insertPipeline(scope, sourceAgent, steps.length);
            for (let i = 0; i < steps.length; i++) {
                this._repo.insertStep(scope, i, steps[i], sourceAgent);
            }
        });
    }
    // ── Step processing ────────────────────────────────────────────────
    step(scope, input) {
        return this._repo.transaction(() => {
            const { role, artifactVerdict, } = this.normalizeInput(input);
            const state = this._repo.getPipelineState(scope);
            if (!state || state.status === Enums_1.PipelineStatus.Completed || state.status === Enums_1.PipelineStatus.Failed) {
                return null;
            }
            if (role === Enums_1.AgentRole.Fixer) {
                return this.reactivateRevisionStep(scope);
            }
            if (role === Enums_1.AgentRole.Source && state.status === Enums_1.PipelineStatus.Revision) {
                return this.reactivateRevisionStep(scope);
            }
            const activeStep = this._repo.getActiveStep(scope);
            if (!activeStep) {
                return null;
            }
            if (activeStep.step_type === Enums_1.StepType.Transform
                && (role === Enums_1.AgentRole.Transformer || role === Enums_1.AgentRole.Source || role === Enums_1.AgentRole.Fixer)) {
                return this.advance(scope, activeStep);
            }
            if (role === Enums_1.AgentRole.Source && activeStep.step_type !== Enums_1.StepType.Check) {
                return this.buildAction(scope);
            }
            const v = this.normalizeVerdict(artifactVerdict);
            if (v === Enums_1.Verdict.Pass) {
                return this.advance(scope, activeStep);
            }
            if (v === Enums_1.Verdict.Revise) {
                return this.revise(scope, state, activeStep);
            }
            process.stderr.write(`[ClaudeGates] ⚠️ Unknown verdict "${artifactVerdict}" for scope="${scope}" step ${activeStep.step_index}. Treating as PASS.\n`);
            return this.advance(scope, activeStep);
        });
    }
    // ── Action query ───────────────────────────────────────────────────
    getNextAction(scope) {
        return this.buildAction(scope);
    }
    getAllNextActions() {
        const pipelines = this._repo.getActivePipelines();
        const actions = [];
        for (const p of pipelines) {
            const action = this.buildAction(p.scope);
            if (action) {
                actions.push(action);
            }
        }
        return actions;
    }
    // ── Role resolution ────────────────────────────────────────────────
    resolveRole(scope, agentType) {
        if (!scope) {
            const pipelines = this._repo.getActivePipelines();
            // Prefer pipelines in revision state (fixer/verifier most likely expected there)
            const sorted = [...pipelines,].sort((a, b) => (a.status === Enums_1.PipelineStatus.Revision ? 0 : 1) - (b.status === Enums_1.PipelineStatus.Revision ? 0 : 1));
            for (const p of sorted) {
                const role = this.resolveRoleInScope(p.scope, agentType, p.source_agent);
                if (role !== Enums_1.AgentRole.Ungated) {
                    return role;
                }
            }
            return Enums_1.AgentRole.Ungated;
        }
        const state = this._repo.getPipelineState(scope);
        if (!state) {
            return Enums_1.AgentRole.Ungated;
        }
        return this.resolveRoleInScope(scope, agentType, state.source_agent);
    }
    /**
     * Retry the same gate agent due to semantic FAIL (bad review).
     * Increments round, checks exhaustion. Gate stays active.
     */
    retryGateAgent(scope) {
        return this._repo.transaction(() => {
            const activeStep = this._repo.getActiveStep(scope);
            if (!activeStep) {
                return null;
            }
            const newRound = activeStep.round + 1;
            if (newRound > activeStep.max_rounds) {
                this._repo.updateStepStatus(scope, activeStep.step_index, Enums_1.StepStatus.Failed, newRound);
                this._repo.updatePipelineState(scope, { status: Enums_1.PipelineStatus.Failed, });
                return { action: "failed", scope, step: activeStep, round: newRound, maxRounds: activeStep.max_rounds, };
            }
            this._repo.updateStepStatus(scope, activeStep.step_index, Enums_1.StepStatus.Active, newRound);
            return this.buildAction(scope);
        });
    }
    // ── Internal: input normalization ──────────────────────────────────
    normalizeInput(input) {
        if (typeof input === "string") {
            return { role: null, artifactVerdict: input, };
        }
        return {
            role: input.role || null,
            artifactVerdict: input.artifactVerdict || "UNKNOWN",
        };
    }
    normalizeVerdict(verdict) {
        const v = (verdict || "").toUpperCase().trim();
        if (v === Enums_1.Verdict.Pass || v === Enums_1.Verdict.Converged) {
            return Enums_1.Verdict.Pass;
        }
        if (v === Enums_1.Verdict.Revise || v === Enums_1.Verdict.Fail) {
            return Enums_1.Verdict.Revise;
        }
        return Enums_1.Verdict.Unknown;
    }
    // ── Internal: state transitions ────────────────────────────────────
    advance(scope, activeStep) {
        this._repo.transaction(() => {
            this._repo.updateStepStatus(scope, activeStep.step_index, Enums_1.StepStatus.Passed);
            const nextIndex = activeStep.step_index + 1;
            const nextStep = this._repo.getStep(scope, nextIndex);
            if (nextStep && nextStep.status === Enums_1.StepStatus.Pending) {
                this._repo.updateStepStatus(scope, nextIndex, Enums_1.StepStatus.Active);
                this._repo.updatePipelineState(scope, { current_step: nextIndex, });
            }
            else if (!this._repo.hasNonPassedSteps(scope)) {
                this._repo.updatePipelineState(scope, { status: Enums_1.PipelineStatus.Completed, });
            }
        });
        const state = this._repo.getPipelineState(scope);
        if (state && state.status === Enums_1.PipelineStatus.Completed) {
            return { action: "done", scope, };
        }
        return this.buildAction(scope);
    }
    revise(scope, state, activeStep) {
        const newRound = activeStep.round + 1;
        if (newRound > activeStep.max_rounds) {
            this._repo.transaction(() => {
                this._repo.updateStepStatus(scope, activeStep.step_index, Enums_1.StepStatus.Failed, newRound);
                this._repo.updatePipelineState(scope, { status: Enums_1.PipelineStatus.Failed, });
            });
            return { action: "failed", scope, step: activeStep, round: newRound, maxRounds: activeStep.max_rounds, };
        }
        const hasFixer = activeStep.step_type === Enums_1.StepType.VerifyWithFixer && activeStep.fixer;
        const newStatus = hasFixer ? Enums_1.StepStatus.Fix : Enums_1.StepStatus.Revise;
        this._repo.transaction(() => {
            this._repo.updateStepStatus(scope, activeStep.step_index, newStatus, newRound);
            this._repo.updatePipelineState(scope, { status: Enums_1.PipelineStatus.Revision, revision_step: activeStep.step_index, });
        });
        const agent = hasFixer ? activeStep.fixer : state.source_agent;
        const freshStep = this._repo.getStep(scope, activeStep.step_index) || activeStep;
        return { action: "source", agent, scope, step: freshStep, };
    }
    reactivateRevisionStep(scope) {
        const reviseRow = this._repo.getStepByStatus(scope, Enums_1.StepStatus.Revise);
        const fixRow = this._repo.getStepByStatus(scope, Enums_1.StepStatus.Fix);
        const target = reviseRow || fixRow;
        if (!target) {
            return null;
        }
        this._repo.transaction(() => {
            this._repo.updateStepStatus(scope, target.step_index, Enums_1.StepStatus.Active);
            this._repo.updatePipelineState(scope, { status: Enums_1.PipelineStatus.Normal, current_step: target.step_index, revision_step: null, });
        });
        return this.buildAction(scope);
    }
    buildAction(scope) {
        const state = this._repo.getPipelineState(scope);
        if (!state || state.status === Enums_1.PipelineStatus.Completed || state.status === Enums_1.PipelineStatus.Failed) {
            return null;
        }
        if (state.status === Enums_1.PipelineStatus.Revision && state.revision_step !== null) {
            const revStep = this._repo.getStep(scope, state.revision_step);
            if (!revStep) {
                return null;
            }
            if (revStep.status === Enums_1.StepStatus.Fix && revStep.fixer) {
                return { action: "source", agent: revStep.fixer, scope, step: revStep, };
            }
            return { action: "source", agent: state.source_agent, scope, step: revStep, };
        }
        const activeStep = this._repo.getActiveStep(scope);
        if (!activeStep) {
            return null;
        }
        switch (activeStep.step_type) {
            case Enums_1.StepType.Check:
                return { action: "semantic", scope, step: activeStep, };
            case Enums_1.StepType.Verify:
            case Enums_1.StepType.VerifyWithFixer:
                return {
                    action: "spawn",
                    agent: activeStep.agent,
                    scope,
                    step: activeStep,
                    round: activeStep.round,
                    maxRounds: activeStep.max_rounds,
                };
            case Enums_1.StepType.Transform:
                return {
                    action: "spawn",
                    agent: activeStep.agent,
                    scope,
                    step: activeStep,
                    round: activeStep.round,
                    maxRounds: activeStep.max_rounds,
                };
            default:
                return null;
        }
    }
    resolveRoleInScope(scope, agentType, sourceAgent) {
        const activeStep = this._repo.getActiveStep(scope);
        if (activeStep && activeStep.agent === agentType && activeStep.step_type === Enums_1.StepType.Transform && activeStep.status === Enums_1.StepStatus.Active) {
            return Enums_1.AgentRole.Transformer;
        }
        if (activeStep && activeStep.agent === agentType && activeStep.status === Enums_1.StepStatus.Active) {
            return Enums_1.AgentRole.Verifier;
        }
        const fixRow = this._repo.getStepByStatus(scope, Enums_1.StepStatus.Fix);
        if (fixRow && fixRow.fixer === agentType) {
            return Enums_1.AgentRole.Fixer;
        }
        if (agentType === sourceAgent) {
            return Enums_1.AgentRole.Source;
        }
        return Enums_1.AgentRole.Ungated;
    }
}
exports.PipelineEngine = PipelineEngine;
//# sourceMappingURL=PipelineEngine.js.map