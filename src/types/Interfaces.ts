export interface ICheckStep
{
  type: "CHECK";
  prompt: string;
}
export interface IVerifyStep
{
  type: "VERIFY";
  agent: string;
  maxRounds: number;
}
export interface IVerifyWithFixerStep
{
  type: "VERIFY_W_FIXER";
  agent: string;
  maxRounds: number;
  fixer: string;
}
export interface ITransformStep
{
  type: "TRANSFORM";
  agent: string;
  maxRounds: number;
}
export type VerificationStep = ICheckStep | IVerifyStep | IVerifyWithFixerStep | ITransformStep;

export interface IPipelineState
{
  scope: string;
  source_agent: string;
  status: string;
  current_step: number;
  revision_step: number | null;
  total_steps: number;
  trace_id: string | null;
  created_at: string;
}

export interface IPipelineStep
{
  scope: string;
  step_index: number;
  step_type: string;
  prompt: string | null;
  command: string | null;
  allowed_tools: string | null;
  agent: string | null;
  max_rounds: number;
  fixer: string | null;
  status: string;
  round: number;
  source_agent: string;
}

export type Action =
  | { action: "spawn"; agent: string; scope: string; step: IPipelineStep; round: number; maxRounds: number; }
  | { action: "source"; agent: string; scope: string; step: IPipelineStep; }
  | { action: "semantic"; scope: string; step: IPipelineStep; }
  | { action: "done"; scope: string; }
  | { action: "failed"; scope: string; step: IPipelineStep; round: number; maxRounds: number; }
  | null;

export interface IStepInput
{
  role: string | null;
  artifactVerdict: string;
}

export interface IAgentRow
{
  scope: string;
  agent: string;
  outputFilepath: string | null;
  verdict: string | null;
  round: number | null;
  attempts: number;
}

export interface IHookInput
{
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: string;
  agent_type?: string;
  agent_id?: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
  error?: string;
}
