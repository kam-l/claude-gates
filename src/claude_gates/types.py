"""
Port of src/types/Enums.ts and src/types/Interfaces.ts.

Enums: 5 StrEnum classes (Python 3.11+).
TypedDicts: ~12 definitions including discriminated unions for Action and VerificationStep.
"""
from __future__ import annotations

from enum import StrEnum
from typing import List, Literal, Optional, TypedDict, Union


# ---------------------------------------------------------------------------
# Enums — StrEnum (Python 3.11+); member == string value
# ---------------------------------------------------------------------------

class Verdict(StrEnum):
    Pass = "PASS"
    Revise = "REVISE"
    Fail = "FAIL"
    Unknown = "UNKNOWN"
    Converged = "CONVERGED"


class StepType(StrEnum):
    Check = "CHECK"
    Verify = "VERIFY"
    VerifyWithFixer = "VERIFY_W_FIXER"
    Transform = "TRANSFORM"


class PipelineStatus(StrEnum):
    Normal = "normal"
    Revision = "revision"
    Completed = "completed"
    Failed = "failed"


class StepStatus(StrEnum):
    Pending = "pending"
    Active = "active"
    Passed = "passed"
    Revise = "revise"
    Fix = "fix"
    Failed = "failed"


class AgentRole(StrEnum):
    Source = "source"
    Checker = "checker"
    Verifier = "verifier"
    Fixer = "fixer"
    Transformer = "transformer"
    Ungated = "ungated"


# ---------------------------------------------------------------------------
# VerificationStep — discriminated union of 4 step variants
# ---------------------------------------------------------------------------

class ICheckStep(TypedDict):
    type: Literal["CHECK"]
    prompt: str


class IVerifyStep(TypedDict):
    type: Literal["VERIFY"]
    agent: str
    maxRounds: int


class IVerifyWithFixerStep(TypedDict):
    type: Literal["VERIFY_W_FIXER"]
    agent: str
    maxRounds: int
    fixer: str


class ITransformStep(TypedDict):
    type: Literal["TRANSFORM"]
    agent: str
    maxRounds: int


VerificationStep = Union[ICheckStep, IVerifyStep, IVerifyWithFixerStep, ITransformStep]


# ---------------------------------------------------------------------------
# IPipelineState / IPipelineStep
# ---------------------------------------------------------------------------

class IPipelineState(TypedDict):
    scope: str
    source_agent: str
    status: str
    current_step: int
    revision_step: Optional[int]
    total_steps: int
    trace_id: Optional[str]
    created_at: str


class IPipelineStep(TypedDict):
    scope: str
    step_index: int
    step_type: str
    prompt: Optional[str]
    command: Optional[str]
    allowed_tools: Optional[str]
    agent: Optional[str]
    max_rounds: int
    fixer: Optional[str]
    status: str
    round: int
    source_agent: str


# ---------------------------------------------------------------------------
# Action — discriminated union of 5 action TypedDicts + None
# ---------------------------------------------------------------------------

class SpawnAction(TypedDict):
    action: Literal["spawn"]
    agent: str
    scope: str
    step: IPipelineStep
    round: int
    maxRounds: int


class SourceAction(TypedDict):
    action: Literal["source"]
    agent: str
    scope: str
    step: IPipelineStep


class SemanticAction(TypedDict):
    action: Literal["semantic"]
    scope: str
    step: IPipelineStep


class DoneAction(TypedDict):
    action: Literal["done"]
    scope: str


class FailedAction(TypedDict):
    action: Literal["failed"]
    scope: str
    step: IPipelineStep
    round: int
    maxRounds: int


Action = Union[SpawnAction, SourceAction, SemanticAction, DoneAction, FailedAction, None]


# ---------------------------------------------------------------------------
# Remaining interfaces
# ---------------------------------------------------------------------------

class IStepInput(TypedDict):
    role: Optional[str]
    artifactVerdict: str


class IAgentRow(TypedDict):
    scope: str
    agent: str
    outputFilepath: Optional[str]
    verdict: Optional[str]
    check: Optional[str]
    round: Optional[int]
    attempts: int


class IAgentSummary(TypedDict):
    name: str
    source: Literal["project", "global"]
    steps: List[VerificationStep]


class IHookInput(TypedDict, total=False):
    session_id: str
    tool_name: str
    tool_input: dict
    tool_result: str
    agent_type: str
    agent_id: str
    agent_transcript_path: str
    last_assistant_message: str
    error: Optional[str]
    prompt: str
