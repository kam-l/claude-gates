// Step types (from pipeline-shared.js)
export interface SemanticStep { type: "SEMANTIC"; prompt: string }
export interface CommandStep { type: "COMMAND"; command: string; allowedTools: string[] }
export interface ReviewStep { type: "REVIEW"; agent: string; maxRounds: number }
export interface ReviewWithFixerStep { type: "REVIEW_WITH_FIXER"; agent: string; maxRounds: number; fixer: string }
export type VerificationStep = SemanticStep | CommandStep | ReviewStep | ReviewWithFixerStep;

// Pipeline state (from pipeline-db.js)
export interface PipelineState {
  scope: string;
  source_agent: string;
  status: "normal" | "revision" | "completed" | "failed";
  current_step: number;
  revision_step: number | null;
  total_steps: number;
  trace_id: string | null;
  created_at: string;
}

export interface PipelineStep {
  scope: string;
  step_index: number;
  step_type: "SEMANTIC" | "COMMAND" | "REVIEW" | "REVIEW_WITH_FIXER";
  prompt: string | null;
  command: string | null;
  allowed_tools: string | null;
  agent: string | null;
  max_rounds: number;
  fixer: string | null;
  status: "pending" | "active" | "passed" | "revise" | "fix" | "failed";
  round: number;
  source_agent: string;
}

// Action discriminated union (from pipeline.js)
// step() returns Action | null — null means no active pipeline
export type Action =
  | { action: "spawn"; agent: string; scope: string; step: PipelineStep; round: number; maxRounds: number }
  | { action: "command"; command: string; allowedTools: string[]; scope: string; step: PipelineStep }
  | { action: "source"; agent: string; scope: string; step: PipelineStep }
  | { action: "semantic"; scope: string; step: PipelineStep }
  | { action: "done"; scope: string }
  | { action: "failed"; scope: string; step: PipelineStep; round: number; maxRounds: number }
  | null;

// Hook stdin data (shared by all hooks)
export interface HookInput {
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

// Config types (from claude-gates-config.js)
export interface StopGateConfig {
  patterns: string[];
  commands: string[];
  mode: "warn" | "nudge";
}
export interface CommitGateConfig {
  commands: string[];
  enabled: boolean;
}
export interface EditGateConfig {
  commands: string[];
}
export interface ClaudeGatesConfig {
  stop_gate: StopGateConfig;
  commit_gate: CommitGateConfig;
  edit_gate: EditGateConfig;
}
