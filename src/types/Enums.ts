export enum Verdict
{
  Pass = "PASS",
  Revise = "REVISE",
  Fail = "FAIL",
  Unknown = "UNKNOWN",
  Converged = "CONVERGED",
}

export enum StepType
{
  Check = "CHECK",
  Verify = "VERIFY",
  VerifyWithFixer = "VERIFY_W_FIXER",
  Transform = "TRANSFORM",
}

export enum PipelineStatus
{
  Normal = "normal",
  Revision = "revision",
  Completed = "completed",
  Failed = "failed",
}

export enum StepStatus
{
  Pending = "pending",
  Active = "active",
  Passed = "passed",
  Revise = "revise",
  Fix = "fix",
  Failed = "failed",
}

export enum AgentRole
{
  Source = "source",
  Checker = "checker",
  Verifier = "verifier",
  Fixer = "fixer",
  Transformer = "transformer",
  Ungated = "ungated",
}
