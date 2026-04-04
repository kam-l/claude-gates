# Architecture

claude-gates is a **MCP sidecar** for Claude Code, wired via hooks and tool calls, that enforces declared verification pipelines.

## Two Pipelines

### Plan Pipeline (implicit)

Every `ExitPlanMode` requires `gater` agent approval.

**Bypasses:**
- **Trivial plan**: plans <=20 lines skip gater (not worth the cost)
- **Safety valve**: after 3 blocked attempts, auto-allows (prevents deadlock if gater fails)

**Flow:** `PreToolUse:ExitPlanMode` -> check SQLite for gater PASS -> block or allow.

### Agent Pipeline (explicit)

If an agent has `verification:` frontmatter, spawning it creates a pipeline that enforces the source agent, orchestrator, and subsequent pipeline agents into a rigid workflow.

## Agent Types

```
source ──> checker ──> verifier ──> checker
               |           |           |
               |           |       (decides if verdict legit)
               |       (reviews artifact)
           (validates source output)

transformer ──> (auto-pass, no checker)
fixer ──> checker
```

### source

The agent that spawned the pipeline. Produces the primary artifact.

- Always has a checker (implicit lightweight validation: file exists, non-trivial content, has structure)
- Checker PASS -> pipeline progresses to next step
- Checker FAIL -> source must be resumed by orchestrator to fix its output

### checker

Quality gate on another agent's output. Runs as `gater` agent via `claude -p`.

- For **source**: validates the artifact is substantive and well-formed
- For **verifier**: validates the review verdict is legitimate and evidence-based
- For **fixer**: validates the fix addressed revision instructions
- Calls `gate_verdict` MCP tool to record verdict AND drive pipeline transitions
- Not a pipeline step itself — it's a hook-layer operation triggered by `SubagentStop`

> **Implementation note (current):** Source checker is a lightweight built-in heuristic, not a full gater call. Verifier and fixer checkers use `claude -p` gater.

### verifier

Declared with `[agent?, rounds]` in `verification:`. Reviews the source artifact.

- Has own checker (gater validates the review quality)
- Produces a verdict: PASS, REVISE, or FAIL
- Checker validates the verdict:
  - Verdict legit AND PASS -> `gate_verdict(verdict=PASS, check=PASS)` -> pipeline advances
  - Verdict legit AND REVISE -> `gate_verdict(verdict=REVISE, check=PASS)` -> pipes back to source or fixer
  - Verdict NOT legit -> `gate_verdict(verdict=*, check=FAIL)` -> verifier is retried

### transformer

Declared with `[agent!, rounds]` in `verification:`. Runs a transformation step.

- No checker — auto-passes on completion
- Pipeline progresses immediately after transformer finishes

### fixer

Declared via `[verifier?, rounds, fixer!]` in `verification:`. Addresses reviewer findings.

- Has own checker (gater validates fix quality)
- Activated when verifier returns REVISE on a `VERIFY_W_FIXER` step
- After fixer completes, pipeline reactivates the verifier step for re-review

## Frontmatter Format

```yaml
---
name: agent-name
verification:                         # Ordered pipeline steps
  - ["Semantic check prompt"]         # CHECK (explicit source checker prompt)
  - [/command, Tool1, Tool2]          # TRANSFORM (orchestrator runs command)
  - [cleaner!, 1]                     # TRANSFORM (auto-pass, no checker)
  - [reviewer?, 3]                    # VERIFY (3 rounds max)
  - [reviewer?, 3, fixer!]           # VERIFY_W_FIXER
conditions: |                         # Pre-spawn check (blocks on FAIL)
  Check if X is ready...
---
```

## Parallelism

Source agents run in parallel. Pipelines are **deferred** — created at SubagentStop (when source completes), not at SubagentStart (when source spawns). This means:

- Multiple source agents can run concurrently without blocking each other
- Pipeline enforcement (blocking, verification) only activates after a source finishes
- The orchestrator processes verification steps sequentially (single-threaded), but source work is never held up

```
  source-A spawns ──────────────── source-A stops ──> pipeline-A created ──> verify-A
  source-B spawns ──────────── source-B stops ──> pipeline-B created ──> verify-B
  source-C spawns ────── source-C stops ──> pipeline-C created ──> verify-C
                    (parallel)              (sequential verification)
```

**Key invariant:** No pipeline exists in DB while its source agent is running. `pipeline-block.ts` and `pipeline-conditions.ts` see nothing to enforce during source execution.

> **Implementation gap:** Pipeline creation currently happens at SubagentStart (`pipeline-injection.ts`), and `pipeline-conditions.ts` enforces sequential execution across scopes. Target: move `createPipeline` to SubagentStop, remove sequential scope guard from conditions.

## Hook Chain

Pipeline enforcement happens across four hooks that must stay in sync:

```
SessionStart
  -> session-context.ts: injects [ClaudeGates] awareness to orchestrator

PreToolUse (every tool call)
  -> pipeline-block.ts: blocks all tools except next required pipeline action + allowlist
  -> pipeline-conditions.ts (Agent only): conditions check + scope registration
  -> plan-gate.ts (ExitPlanMode only): blocks until gater approves plan

SubagentStart
  -> pipeline-injection.ts: injects role context for verifiers/fixers (pipeline already exists)

SubagentStop
  -> pipeline-verification.ts: creates pipeline (for sources), artifact capture, role dispatch, checker invocation

PostToolUse
  -> plan-gate-clear.ts (ExitPlanMode only): clears gater verdict after plan exits
```

### SubagentStop Detail (main logic)

1. **Pipeline creation** (source only): create pipeline from `verification:` frontmatter if not exists
2. **Artifact capture**: first call pivots agent to write artifact to correct filepath; second+ call proceeds with verification
3. **Role resolution**: engine determines agent's role from pipeline state
4. **Checker invocation** (for source/verifier/fixer): runs gater via `claude -p`
5. **Pipeline transition**: checker calls `gate_verdict` MCP which drives `engine.step()`

## MCP Tools

### gate_verdict

Records verdict and drives pipeline state transitions. Single point of truth for all pipeline logic.

**Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session UUID |
| `scope` | string | Pipeline scope or `verify-plan` for plan-gate |
| `verdict` | PASS/REVISE/FAIL | What the reviewed agent concluded |
| `check` | PASS/FAIL | Checker's quality assessment of the review |
| `reason` | string | Human-readable explanation |

**Behavior by context:**
- **Plan-gate** (`scope=verify-plan`): records gater verdict for `plan-gate.ts` to read
- **Source checker**: `check=PASS` -> advance; `check=FAIL` -> source must revise
- **Verifier checker**: `check=PASS` + `verdict=PASS` -> advance; `check=PASS` + `verdict=REVISE` -> revision; `check=FAIL` -> retry verifier
- **Fixer checker**: `check=PASS` -> reactivate verifier step; `check=FAIL` -> retry fixer

> **Implementation gap:** Current `gate_verdict` only records verdicts. Hook layer still drives `engine.step()`. Target: all transition logic moves into MCP handler.

### gate_status

Read-only pipeline state query. Available to all agents.

## MCP Access Control

**Invariant: only gater/checker can call `gate_verdict` to affect pipeline state. Everyone can query `gate_status`.**

Enforcement: MCP server is NOT registered at SessionStart for the orchestrator session. Instead, MCP config is injected only for `claude -p` gater calls (checker invocations).

> **Implementation gap:** Current code runs `claude mcp add claude-gates` at SessionStart, giving all agents MCP access. Target: remove this, inject MCP config per-gater-call only.

## State Machine (PipelineEngine)

```
                    +---------------------------------------------+
                    |              Pipeline States                 |
                    |                                              |
   createPipeline() |  +--------+    PASS     +-----------+       |
   -----------------+->| normal |------------>| completed |       |
                    |  +----+---+             +-----------+       |
                    |       |                                      |
                    |       | REVISE                               |
                    |       v                                      |
                    |  +----------+   source/fixer    +--------+  |
                    |  | revision |---completes------->| normal |  |
                    |  +----+-----+   (reactivate)    +--------+  |
                    |       |                                      |
                    |       | rounds > maxRounds                   |
                    |       v                                      |
                    |  +--------+                                  |
                    |  | failed |                                  |
                    |  +--------+                                  |
                    +---------------------------------------------+

Step statuses: pending -> active -> passed
                              \-> revise (source must redo)
                              \-> fix    (fixer must fix)
                              \-> failed (exhausted rounds)
```

## Enums

```typescript
AgentRole:  Source | Checker | Verifier | Fixer | Transformer | Ungated
StepType:   CHECK | VERIFY | VERIFY_W_FIXER | TRANSFORM
Verdict:    PASS | REVISE | FAIL | CONVERGED | UNKNOWN
```

> **Implementation gap:** `AgentRole.Checker` does not exist in code yet.

## Directory Structure

```
src/
  types/Enums.ts              # Verdict, StepType, PipelineStatus, StepStatus, AgentRole
  types/Interfaces.ts         # IPipelineState, IPipelineStep, Action, VerificationStep, etc.
  PipelineEngine.ts           # State machine transitions (step, retryGateAgent)
  PipelineRepository.ts       # Pipeline CRUD (schema + DB operations)
  GateRepository.ts           # Plan-gate attempts + MCP verdict storage
  SessionManager.ts           # openDatabase, getSessionDir, agentRunningMarker
  FrontmatterParser.ts        # extractFrontmatter, parseVerification, parseConditions
  Messaging.ts                # block, info, notify, log
  Tracing.ts                  # Langfuse + audit.jsonl

  session-context.ts          # Hook: SessionStart
  pipeline-verification.ts    # Hook: SubagentStop — artifact capture + checker dispatch
  pipeline-block.ts           # Hook: PreToolUse — blocks tools during active pipeline
  pipeline-conditions.ts      # Hook: PreToolUse:Agent — conditions + step enforcement
  pipeline-injection.ts       # Hook: SubagentStart — pipeline creation + context enrichment
  plan-gate.ts                # Hook: PreToolUse:ExitPlanMode
  plan-gate-clear.ts          # Hook: PostToolUse:ExitPlanMode
  mcp-server.ts               # MCP: gate_verdict + gate_status
  database.ts                 # Test helper over PipelineRepository
  state-machine.ts            # Test helper over PipelineEngine
```

## Session State

- Session data at `{CWD}/.sessions/{shortId}/` (first 8 hex of UUID)
- SQLite via `better-sqlite3`. Tables: `pipeline_state`, `pipeline_steps`, `agents`, `edits`, `tool_history`
- Gate DB: plan-gate attempts + MCP verdict. Separate schema, same `.db` file.

## Key Invariants

- `${CLAUDE_PLUGIN_ROOT}/scripts/...` for all hook paths
- Pipeline: conditions -> injection -> verification -> block. All four + engine must stay in sync.
- `<agent_gate>` XML tag preserved for backward compat.
- `better-sqlite3` is a hard dependency (installed via SessionStart hook).
- **Fail-open**: every hook catches errors and exits 0.
- **All hooks MUST exit 0.** Exit 2 causes Claude Code to ignore stdout JSON.
- `Messaging.notify()` file side-channel for SubagentStop messages.

## Design Principles

- **Semantics first, structure later.** Agents do free-form reasoning. Output structure is a post-work concern. Only checkers/verifiers produce pipeline verdicts; source agents and fixers just write content.
- **Gate agents vs gater:** Pipeline-spawned gate agents write free-form output. SubagentStop spawns gater via `claude -p`, which reads that output and calls `gate_verdict` MCP. Gate agents never call MCP directly — gater (as checker) does.

## .NET Mental Model

```
Claude Code (the IDE)          claude-gates (this plugin)
=======================        ===========================
VS Extension / Middleware  ->  Hook scripts in scripts/
IServiceCollection         ->  import/require at top of file
DbContext + Repository     ->  PipelineRepository / GateRepository (classes)
State machine / MediatR    ->  PipelineEngine (class with step() method)
Middleware pipeline        ->  Hook chain: conditions -> injection -> verification -> block
```

Each hook script = one middleware component. Reads JSON from stdin (`HttpContext`), does work, optionally writes JSON to stdout (`Response`), exits 0 (`next()`).

## Implementation Gaps (vs this architecture)

1. **Parallel pipelines** — pipeline creation currently happens at SubagentStart; `pipeline-conditions.ts` enforces sequential execution across scopes. Target: move `createPipeline` to SubagentStop, remove sequential scope guard.
2. **`AgentRole.Checker`** — not in Enums.ts yet.
3. **`gate_verdict` drives transitions** — MCP handler currently only records verdicts; hook layer still calls `engine.step()`. Target: move all transition logic into MCP handler with `(verdict, check)` params.
4. **MCP access control** — `claude mcp add` in SessionStart gives all agents access. Target: remove, inject MCP config only for gater `claude -p` calls.
5. **Implicit source checker** — source always gets a lightweight built-in check (file exists, non-trivial). Not implemented yet; currently only declared CHECK steps trigger a check.
