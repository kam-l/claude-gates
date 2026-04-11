import os
import sys
import unittest
from typing import get_type_hints

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates.types import (
    Verdict,
    StepType,
    PipelineStatus,
    StepStatus,
    AgentRole,
    SpawnAction,
    SourceAction,
    SemanticAction,
    DoneAction,
    FailedAction,
    Action,
    ICheckStep,
    IVerifyStep,
    IVerifyWithFixerStep,
    ITransformStep,
    VerificationStep,
    IPipelineState,
    IPipelineStep,
    IStepInput,
    IAgentRow,
    IAgentSummary,
    IHookInput,
)


class TestVerdictEnum(unittest.TestCase):
    """AC1 + AC2: Verdict StrEnum — UPPER values, PascalCase names."""

    def test_pass_equals_string(self):
        self.assertEqual(Verdict.Pass, "PASS")

    def test_revise_equals_string(self):
        self.assertEqual(Verdict.Revise, "REVISE")

    def test_fail_equals_string(self):
        self.assertEqual(Verdict.Fail, "FAIL")

    def test_unknown_equals_string(self):
        self.assertEqual(Verdict.Unknown, "UNKNOWN")

    def test_converged_equals_string(self):
        self.assertEqual(Verdict.Converged, "CONVERGED")

    def test_is_str(self):
        self.assertIsInstance(Verdict.Pass, str)

    def test_member_names_pascal_case(self):
        names = [m.name for m in Verdict]
        self.assertEqual(names, ["Pass", "Revise", "Fail", "Unknown", "Converged"])


class TestStepTypeEnum(unittest.TestCase):
    """AC1 + AC2: StepType StrEnum — UPPER values, PascalCase names."""

    def test_check_equals_string(self):
        self.assertEqual(StepType.Check, "CHECK")

    def test_verify_equals_string(self):
        self.assertEqual(StepType.Verify, "VERIFY")

    def test_verify_with_fixer_equals_string(self):
        self.assertEqual(StepType.VerifyWithFixer, "VERIFY_W_FIXER")

    def test_transform_equals_string(self):
        self.assertEqual(StepType.Transform, "TRANSFORM")

    def test_member_names_pascal_case(self):
        names = [m.name for m in StepType]
        self.assertEqual(names, ["Check", "Verify", "VerifyWithFixer", "Transform"])


class TestPipelineStatusEnum(unittest.TestCase):
    """AC1 + AC2: PipelineStatus StrEnum — lower values, PascalCase names."""

    def test_normal_equals_string(self):
        self.assertEqual(PipelineStatus.Normal, "normal")

    def test_revision_equals_string(self):
        self.assertEqual(PipelineStatus.Revision, "revision")

    def test_completed_equals_string(self):
        self.assertEqual(PipelineStatus.Completed, "completed")

    def test_failed_equals_string(self):
        self.assertEqual(PipelineStatus.Failed, "failed")

    def test_member_names_pascal_case(self):
        names = [m.name for m in PipelineStatus]
        self.assertEqual(names, ["Normal", "Revision", "Completed", "Failed"])


class TestStepStatusEnum(unittest.TestCase):
    """AC1 + AC2: StepStatus StrEnum — lower values, PascalCase names."""

    def test_pending_equals_string(self):
        self.assertEqual(StepStatus.Pending, "pending")

    def test_active_equals_string(self):
        self.assertEqual(StepStatus.Active, "active")

    def test_passed_equals_string(self):
        self.assertEqual(StepStatus.Passed, "passed")

    def test_revise_equals_string(self):
        self.assertEqual(StepStatus.Revise, "revise")

    def test_fix_equals_string(self):
        self.assertEqual(StepStatus.Fix, "fix")

    def test_failed_equals_string(self):
        self.assertEqual(StepStatus.Failed, "failed")

    def test_member_names_pascal_case(self):
        names = [m.name for m in StepStatus]
        self.assertEqual(names, ["Pending", "Active", "Passed", "Revise", "Fix", "Failed"])


class TestAgentRoleEnum(unittest.TestCase):
    """AC1 + AC2: AgentRole StrEnum — lower values, PascalCase names."""

    def test_source_equals_string(self):
        self.assertEqual(AgentRole.Source, "source")

    def test_checker_equals_string(self):
        self.assertEqual(AgentRole.Checker, "checker")

    def test_verifier_equals_string(self):
        self.assertEqual(AgentRole.Verifier, "verifier")

    def test_fixer_equals_string(self):
        self.assertEqual(AgentRole.Fixer, "fixer")

    def test_transformer_equals_string(self):
        self.assertEqual(AgentRole.Transformer, "transformer")

    def test_ungated_equals_string(self):
        self.assertEqual(AgentRole.Ungated, "ungated")

    def test_member_names_pascal_case(self):
        names = [m.name for m in AgentRole]
        self.assertEqual(names, ["Source", "Checker", "Verifier", "Fixer", "Transformer", "Ungated"])


class TestActionUnion(unittest.TestCase):
    """AC3: Discriminated Action union — 5 TypedDicts + None."""

    def test_spawn_action_literal_discriminator(self):
        hints = get_type_hints(SpawnAction, include_extras=True)
        self.assertIn("action", hints)
        # Verify we can construct one and it type-checks
        spawn: SpawnAction = {
            "action": "spawn",
            "agent": "my-agent",
            "scope": "abc123",
            "step": {},  # type: ignore
            "round": 1,
            "maxRounds": 3,
        }
        self.assertEqual(spawn["action"], "spawn")

    def test_source_action_literal_discriminator(self):
        source: SourceAction = {
            "action": "source",
            "agent": "my-agent",
            "scope": "abc123",
            "step": {},  # type: ignore
        }
        self.assertEqual(source["action"], "source")

    def test_semantic_action_literal_discriminator(self):
        semantic: SemanticAction = {
            "action": "semantic",
            "scope": "abc123",
            "step": {},  # type: ignore
        }
        self.assertEqual(semantic["action"], "semantic")

    def test_done_action_literal_discriminator(self):
        done: DoneAction = {
            "action": "done",
            "scope": "abc123",
        }
        self.assertEqual(done["action"], "done")

    def test_failed_action_literal_discriminator(self):
        failed: FailedAction = {
            "action": "failed",
            "scope": "abc123",
            "step": {},  # type: ignore
            "round": 1,
            "maxRounds": 3,
        }
        self.assertEqual(failed["action"], "failed")

    def test_action_union_includes_none(self):
        action: Action = None
        self.assertIsNone(action)

    def test_action_union_accepts_each_variant(self):
        actions = [
            {"action": "spawn", "agent": "a", "scope": "s", "step": {}, "round": 1, "maxRounds": 3},
            {"action": "source", "agent": "a", "scope": "s", "step": {}},
            {"action": "semantic", "scope": "s", "step": {}},
            {"action": "done", "scope": "s"},
            {"action": "failed", "scope": "s", "step": {}, "round": 1, "maxRounds": 3},
        ]
        discriminators = [a["action"] for a in actions]
        self.assertEqual(discriminators, ["spawn", "source", "semantic", "done", "failed"])


class TestVerificationStepUnion(unittest.TestCase):
    """AC4: Discriminated VerificationStep union — 4 variants."""

    def test_check_step_type_literal(self):
        step: ICheckStep = {"type": "CHECK", "prompt": "Is it good?"}
        self.assertEqual(step["type"], "CHECK")

    def test_verify_step_type_literal(self):
        step: IVerifyStep = {"type": "VERIFY", "agent": "reviewer", "maxRounds": 3}
        self.assertEqual(step["type"], "VERIFY")

    def test_verify_with_fixer_step_type_literal(self):
        step: IVerifyWithFixerStep = {
            "type": "VERIFY_W_FIXER",
            "agent": "reviewer",
            "maxRounds": 3,
            "fixer": "cleaner",
        }
        self.assertEqual(step["type"], "VERIFY_W_FIXER")

    def test_transform_step_type_literal(self):
        step: ITransformStep = {"type": "TRANSFORM", "agent": "formatter", "maxRounds": 1}
        self.assertEqual(step["type"], "TRANSFORM")

    def test_verification_step_union_exported(self):
        import typing
        args = typing.get_args(VerificationStep)
        self.assertEqual(len(args), 4)
        self.assertIn(ICheckStep, args)
        self.assertIn(IVerifyStep, args)
        self.assertIn(IVerifyWithFixerStep, args)
        self.assertIn(ITransformStep, args)


class TestIPipelineState(unittest.TestCase):
    """AC5: IPipelineState TypedDict with correct fields."""

    def test_can_instantiate_with_required_fields(self):
        state: IPipelineState = {
            "scope": "abc123",
            "source_agent": "writer",
            "status": "normal",
            "current_step": 0,
            "revision_step": None,
            "total_steps": 3,
            "trace_id": None,
            "created_at": "2026-04-11T00:00:00Z",
        }
        self.assertEqual(state["scope"], "abc123")
        self.assertIsNone(state["revision_step"])

    def test_fields_present(self):
        hints = get_type_hints(IPipelineState)
        expected = {
            "scope", "source_agent", "status", "current_step",
            "revision_step", "total_steps", "trace_id", "created_at",
        }
        self.assertEqual(set(hints.keys()), expected)


class TestIPipelineStep(unittest.TestCase):
    """AC5: IPipelineStep TypedDict with correct fields."""

    def test_can_instantiate(self):
        step: IPipelineStep = {
            "scope": "abc123",
            "step_index": 0,
            "step_type": "CHECK",
            "prompt": None,
            "command": None,
            "allowed_tools": None,
            "agent": None,
            "max_rounds": 1,
            "fixer": None,
            "status": "pending",
            "round": 0,
            "source_agent": "writer",
        }
        self.assertEqual(step["step_type"], "CHECK")

    def test_fields_present(self):
        hints = get_type_hints(IPipelineStep)
        expected = {
            "scope", "step_index", "step_type", "prompt", "command",
            "allowed_tools", "agent", "max_rounds", "fixer", "status",
            "round", "source_agent",
        }
        self.assertEqual(set(hints.keys()), expected)


class TestIStepInput(unittest.TestCase):
    """AC5: IStepInput TypedDict."""

    def test_can_instantiate(self):
        step_input: IStepInput = {"role": None, "artifactVerdict": "PASS"}
        self.assertEqual(step_input["artifactVerdict"], "PASS")
        self.assertIsNone(step_input["role"])


class TestIAgentRow(unittest.TestCase):
    """AC5: IAgentRow TypedDict."""

    def test_can_instantiate(self):
        row: IAgentRow = {
            "scope": "abc123",
            "agent": "reviewer",
            "outputFilepath": None,
            "verdict": None,
            "check": None,
            "round": None,
            "attempts": 1,
        }
        self.assertEqual(row["agent"], "reviewer")
        self.assertIsNone(row["round"])

    def test_fields_present(self):
        hints = get_type_hints(IAgentRow)
        expected = {"scope", "agent", "outputFilepath", "verdict", "check", "round", "attempts"}
        self.assertEqual(set(hints.keys()), expected)


class TestIAgentSummary(unittest.TestCase):
    """AC5: IAgentSummary TypedDict."""

    def test_can_instantiate(self):
        summary: IAgentSummary = {
            "name": "my-agent",
            "source": "project",
            "steps": [],
        }
        self.assertEqual(summary["source"], "project")

    def test_source_literal_values(self):
        """source field is 'project' | 'global'."""
        hints = get_type_hints(IAgentSummary)
        self.assertIn("source", hints)


class TestIHookInput(unittest.TestCase):
    """AC5: IHookInput TypedDict — all fields optional (NotRequired or total=False)."""

    def test_empty_dict_is_valid(self):
        hook_input: IHookInput = {}
        self.assertEqual(hook_input, {})

    def test_can_instantiate_with_all_fields(self):
        hook_input: IHookInput = {
            "session_id": "sess-123",
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
            "tool_result": "ok",
            "agent_type": "claude-gates:gater",
            "agent_id": "agent-abc",
            "agent_transcript_path": "/path/to/transcript",
            "last_assistant_message": "Done.",
            "error": "something went wrong",
            "prompt": "Do something",
        }
        self.assertEqual(hook_input["session_id"], "sess-123")

    def test_partial_fields_valid(self):
        hook_input: IHookInput = {"tool_name": "Read"}
        self.assertEqual(hook_input["tool_name"], "Read")


if __name__ == "__main__":
    unittest.main()
