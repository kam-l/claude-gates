"""Pipeline state machine engine. Port of PipelineEngine.ts."""
from __future__ import annotations

import sys
from typing import Any, Dict, List, Optional, Union

from claude_gates.repository import PipelineRepository
from claude_gates.types import (
    Action,
    AgentRole,
    IPipelineState,
    IPipelineStep,
    IStepInput,
    PipelineStatus,
    StepStatus,
    StepType,
    VerificationStep,
    Verdict,
)


class PipelineEngine:
    def __init__(self, repo: PipelineRepository) -> None:
        self._repo = repo

    def create_pipeline(
        self,
        scope: str,
        source_agent: str,
        steps: List[VerificationStep],
    ) -> None:
        def _create() -> None:
            if self._repo.pipeline_exists(scope):
                return
            self._repo.insert_pipeline(scope, source_agent, len(steps))
            for i, step in enumerate(steps):
                self._repo.insert_step(scope, i, step, source_agent)

        PipelineRepository.transact(self._repo._conn, _create)

    def step(self, scope: str, input: Union[str, Dict[str, Any]]) -> Action:
        def _step() -> Action:
            role, artifact_verdict = self._normalize_input(input)

            state = self._repo.get_pipeline_state(scope)
            if (
                not state
                or state["status"] == PipelineStatus.Completed
                or state["status"] == PipelineStatus.Failed
            ):
                return None

            if role == AgentRole.Fixer:
                return self._reactivate_revision_step(scope)

            if role == AgentRole.Source and state["status"] == PipelineStatus.Revision:
                return self._reactivate_revision_step(scope)

            active_step = self._repo.get_active_step(scope)
            if not active_step:
                return None

            if active_step["step_type"] == StepType.Transform and role in (
                AgentRole.Transformer,
                AgentRole.Source,
                AgentRole.Fixer,
            ):
                return self._advance(scope, active_step)

            if role == AgentRole.Source and active_step["step_type"] != StepType.Check:
                return self._build_action(scope)

            v = self._normalize_verdict(artifact_verdict)

            if v == Verdict.Pass:
                return self._advance(scope, active_step)

            if v == Verdict.Revise:
                return self._revise(scope, state, active_step)

            return self._advance(scope, active_step)

        return PipelineRepository.transact(self._repo._conn, _step)

    def get_next_action(self, scope: str) -> Action:
        return self._build_action(scope)

    def get_all_next_actions(self) -> List[Dict[str, Any]]:
        pipelines = self._repo.get_active_pipelines()
        actions: List[Dict[str, Any]] = []
        for p in pipelines:
            action = self._build_action(p["scope"])
            if action is not None:
                actions.append(action)
        return actions

    def resolve_role(self, scope: str, agent_type: str) -> AgentRole:
        if not scope:
            pipelines = self._repo.get_active_pipelines()
            sorted_pipelines = sorted(
                pipelines,
                key=lambda p: 0 if p["status"] == PipelineStatus.Revision else 1,
            )
            for p in sorted_pipelines:
                role = self._resolve_role_in_scope(p["scope"], agent_type, p["source_agent"])
                if role != AgentRole.Ungated:
                    return role
            return AgentRole.Ungated

        state = self._repo.get_pipeline_state(scope)
        if not state:
            return AgentRole.Ungated
        return self._resolve_role_in_scope(scope, agent_type, state["source_agent"])

    def retry_gate_agent(self, scope: str) -> Action:
        def _retry() -> Action:
            active_step = self._repo.get_active_step(scope)
            if not active_step:
                return None

            new_round = active_step["round"] + 1

            if new_round > active_step["max_rounds"]:
                self._repo.update_step_status(scope, active_step["step_index"], StepStatus.Failed, new_round)
                self._repo.update_pipeline_state(scope, {"status": PipelineStatus.Failed})
                return {
                    "action": "failed",
                    "scope": scope,
                    "step": active_step,
                    "round": new_round,
                    "maxRounds": active_step["max_rounds"],
                }

            self._repo.update_step_status(scope, active_step["step_index"], StepStatus.Active, new_round)
            return self._build_action(scope)

        return PipelineRepository.transact(self._repo._conn, _retry)

    def _normalize_input(
        self, input: Union[str, Dict[str, Any]]
    ) -> tuple:
        if isinstance(input, str):
            return None, input
        role = input.get("role") or None
        artifact_verdict = input.get("artifactVerdict") or "UNKNOWN"
        return role, artifact_verdict

    def _normalize_verdict(self, verdict: str) -> Verdict:
        v = (verdict or "").upper().strip()
        if v in (Verdict.Pass, Verdict.Converged):
            return Verdict.Pass
        if v in (Verdict.Revise, Verdict.Fail):
            return Verdict.Revise
        sys.stderr.write(
            f"[ClaudeGates] WARNING: Unknown verdict \"{verdict}\". Treating as PASS.\n"
        )
        return Verdict.Pass

    def _advance(self, scope: str, active_step: Dict[str, Any]) -> Action:
        # No transact() here — caller (step()) already holds the transaction
        self._repo.update_step_status(scope, active_step["step_index"], StepStatus.Passed)
        next_index = active_step["step_index"] + 1
        next_step = self._repo.get_step(scope, next_index)
        if next_step and next_step["status"] == StepStatus.Pending:
            self._repo.update_step_status(scope, next_index, StepStatus.Active)
            self._repo.update_pipeline_state(scope, {"current_step": next_index})
        elif not self._repo.has_non_passed_steps(scope):
            self._repo.update_pipeline_state(scope, {"status": PipelineStatus.Completed})

        state = self._repo.get_pipeline_state(scope)
        if state and state["status"] == PipelineStatus.Completed:
            return {"action": "done", "scope": scope}
        return self._build_action(scope)

    def _revise(
        self,
        scope: str,
        state: Dict[str, Any],
        active_step: Dict[str, Any],
    ) -> Action:
        new_round = active_step["round"] + 1

        if new_round > active_step["max_rounds"]:
            self._repo.update_step_status(scope, active_step["step_index"], StepStatus.Failed, new_round)
            self._repo.update_pipeline_state(scope, {"status": PipelineStatus.Failed})
            return {
                "action": "failed",
                "scope": scope,
                "step": active_step,
                "round": new_round,
                "maxRounds": active_step["max_rounds"],
            }

        has_fixer = (
            active_step["step_type"] == StepType.VerifyWithFixer
            and active_step.get("fixer")
        )
        new_status = StepStatus.Fix if has_fixer else StepStatus.Revise
        self._repo.update_step_status(scope, active_step["step_index"], new_status, new_round)
        self._repo.update_pipeline_state(
            scope,
            {"status": PipelineStatus.Revision, "revision_step": active_step["step_index"]},
        )

        agent = active_step["fixer"] if has_fixer else state["source_agent"]
        fresh_step = self._repo.get_step(scope, active_step["step_index"]) or active_step
        return {"action": "source", "agent": agent, "scope": scope, "step": fresh_step}

    def _reactivate_revision_step(self, scope: str) -> Action:
        revise_row = self._repo.get_step_by_status(scope, StepStatus.Revise)
        fix_row = self._repo.get_step_by_status(scope, StepStatus.Fix)
        target = revise_row or fix_row
        if not target:
            return None

        self._repo.update_step_status(scope, target["step_index"], StepStatus.Active)
        self._repo.update_pipeline_state(
            scope,
            {
                "status": PipelineStatus.Normal,
                "current_step": target["step_index"],
                "revision_step": None,
            },
        )
        return self._build_action(scope)

    def _build_action(self, scope: str) -> Action:
        state = self._repo.get_pipeline_state(scope)
        if (
            not state
            or state["status"] == PipelineStatus.Completed
            or state["status"] == PipelineStatus.Failed
        ):
            return None

        if state["status"] == PipelineStatus.Revision and state["revision_step"] is not None:
            rev_step = self._repo.get_step(scope, state["revision_step"])
            if not rev_step:
                return None
            if rev_step["status"] == StepStatus.Fix and rev_step.get("fixer"):
                return {"action": "source", "agent": rev_step["fixer"], "scope": scope, "step": rev_step}
            return {"action": "source", "agent": state["source_agent"], "scope": scope, "step": rev_step}

        active_step = self._repo.get_active_step(scope)
        if not active_step:
            return None

        step_type = active_step["step_type"]

        if step_type == StepType.Check:
            return {"action": "semantic", "scope": scope, "step": active_step}

        if step_type in (StepType.Verify, StepType.VerifyWithFixer, StepType.Transform):
            return {
                "action": "spawn",
                "agent": active_step["agent"],
                "scope": scope,
                "step": active_step,
                "round": active_step["round"],
                "maxRounds": active_step["max_rounds"],
            }

        return None

    def _resolve_role_in_scope(
        self, scope: str, agent_type: str, source_agent: str
    ) -> AgentRole:
        active_step = self._repo.get_active_step(scope)
        if (
            active_step
            and active_step["agent"] == agent_type
            and active_step["step_type"] == StepType.Transform
            and active_step["status"] == StepStatus.Active
        ):
            return AgentRole.Transformer

        if (
            active_step
            and active_step["agent"] == agent_type
            and active_step["status"] == StepStatus.Active
        ):
            return AgentRole.Verifier

        fix_row = self._repo.get_step_by_status(scope, StepStatus.Fix)
        if fix_row and fix_row.get("fixer") == agent_type:
            return AgentRole.Fixer

        if agent_type == source_agent:
            return AgentRole.Source

        return AgentRole.Ungated
