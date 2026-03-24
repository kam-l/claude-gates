# claude-gates

Declarative pipeline gates — `verification:` unified array format in agent frontmatter.

## Plugin Packaging

- Plugin manifest: `.claude-plugin/plugin.json` (name, version, description, author)
- Version in `package.json` and `plugin.json` must stay in sync
- Repository: `https://github.com/kam-l/claude-gates`

## Pipeline v3 Lifecycle

The full lifecycle for a gated agent (e.g., `gt-worker` with unified `verification:` array):

```
1. Parent spawns gt-worker with scope=X
   ├─ PreToolUse:Agent  → pipeline-conditions.js: conditions check + step enforcement + scope registration
   ├─ SubagentStart     → pipeline-injection.js:  creates pipeline from verification: steps, injects output_filepath
   ├─ gt-worker runs, writes artifact to output_filepath
   └─ SubagentStop      → pipeline-verification.js: scope → role → semantic check → engine.step()

2. Pipeline steps execute in order:
   ├─ SEMANTIC step: verification.js runs claude -p semantic check, feeds verdict to engine
   ├─ REVIEW step: pipeline-block.js blocks → forces reviewer spawn → engine.step(verdict)
   ├─ COMMAND step: pipeline-block.js blocks → orchestrator runs command → /pass_or_revise → verdict file
   └─ Each step: PASS → advance | REVISE → source/fixer re-run | FAIL → round++ or exhaust

3. Revision flow (REVISE on any step):
   ├─ With fixer: fixer spawned → fixes artifact → engine reactivates gate → reviewer re-runs
   └─ Without fixer: source re-runs → engine reactivates gate → reviewer re-runs

4. All steps pass → pipeline-block.js lifts → parent resumes
```

## Agent Roles

Roles determined by `engine.resolveRole()` — checks `pipeline_steps` table, not agent definition:

| Role | How identified | Verdict handling |
|------|---------------|-----------------|
| **gater** | Hardcoded `bareType === "gater"` | `lastMessage` VERDICT_RE → recordVerdict (feeds plan-gate) |
| **source** | `pipeline_state.source_agent` match | Semantic check (SEMANTIC step) → `engine.step({ role: "source" })` |
| **gate-agent** | Active step's `agent` field match | Implicit semantic + `engine.step({ role: "gate-agent" })` |
| **fixer** | Fix step's `fixer` field match | Implicit semantic + `engine.step({ role: "fixer" })` |
| **ungated** | No pipeline match | exit(0) |

## Frontmatter Reference

Agent `.md` files support these frontmatter fields (parsed by `pipeline-shared.js`):

```yaml
---
name: agent-name              # Required. Agent identifier.
description: "..."            # Agent description for Claude Code.
model: sonnet                 # Optional. Model override (haiku/sonnet/opus).
role: gate                    # Optional. "gate" or "fixer" — tells injection.js to enhance context.
conditions: |                 # Optional. Semantic pre-check prompt. Evaluated before spawn.
  Check if X is ready...
verification:                 # Optional. Unified step array. Ordered pipeline.
  - ["Semantic check prompt"]           # SEMANTIC step
  - [/command, Tool1, Tool2]            # COMMAND step
  - [reviewer, 3]                       # REVIEW step (3 rounds)
  - [reviewer, 3, fixer]               # REVIEW_WITH_FIXER step
---
```

## Pipeline Step Types

| Type | Format | Execution |
|------|--------|-----------|
| SEMANTIC | `["prompt text"]` | verification.js runs claude -p at SubagentStop |
| COMMAND | `[/cmd, Tool1, Tool2]` | Block hook allows listed tools, /pass_or_revise records verdict |
| REVIEW | `[agent, maxRounds]` | Block hook forces agent spawn, agent writes verdict |
| REVIEW_WITH_FIXER | `[agent, maxRounds, fixer]` | Same as REVIEW; REVISE routes to fixer instead of source |

## Pipeline State Machine

```
Pipeline: normal → revision → normal (cycle) → completed | failed
Step:     pending → active → passed
                           → revise (source re-runs) → active
                           → fix (fixer runs) → active
                           → failed (rounds exhausted)
```

Engine owns ALL transitions via `step(db, scope, { role, artifactVerdict, semanticVerdict })`.

## Hook Execution Order

```
SessionStart          → install better-sqlite3 (once per session)
PreToolUse (all)      → pipeline-block.js: block if pipeline active + verdict file processing
PreToolUse:Agent      → pipeline-conditions.js: conditions check + step enforcement + scope registration
SubagentStart         → pipeline-injection.js: create pipeline + inject output_filepath + role context
  [agent runs]
SubagentStop          → pipeline-verification.js: scope → role → semantic checks → engine.step()
PostToolUse:Edit|Write→ edit-gate.js: track edits + run formatters
PreToolUse:ExitPlanMode → plan-gate.js: require gater PASS before plan exit
PostToolUse:ExitPlanMode → plan-gate-clear.js: clear gater verdicts
PreToolUse:Bash       → commit-gate.js: validate before git commit
Stop|StopFailure      → stop-gate.js: pipeline completeness + debug scan + cleanup
```

## Key Invariants

- Hooks use `${CLAUDE_PLUGIN_ROOT}/scripts/...` paths (except SessionStart → `${CLAUDE_PLUGIN_DATA}`)
- Pipeline logic: conditions → injection → verification. All three scripts + engine must stay in sync.
- `<agent_gate>` XML tag preserved for backward compat with agent definitions.
- `better-sqlite3` is a hard dependency — install must succeed.
- **Version bump required for every script change.** Plugin cache keyed by version string.

## Session State

- SQLite via `better-sqlite3`. Installed into `CLAUDE_PLUGIN_DATA` via SessionStart.
- v3 DB module: `scripts/pipeline-db.js`. Tables: `pipeline_state`, `pipeline_steps`, `agents`, `edits`, `tool_history`.
- v2 DB module: `scripts/claude-gates-db.js` (legacy, still used by plan-gate, edit-gate).
- Engine module: `scripts/pipeline.js`. Exports: `createPipeline`, `step`, `getNextAction`, `getAllNextActions`, `resolveRole`.

## Configuration

- Project-level config via `claude-gates.json` at repo root (optional).
- Config module: `scripts/claude-gates-config.js`. Resolution: `CLAUDE_GATES_CONFIG` env var → git root → cwd → defaults.

## Module Map

### v3 Pipeline (active hooks)
- `pipeline-shared.js` — Unified `verification:` array parser + `findAgentMd` + `VERDICT_RE`. Zero deps.
- `pipeline-db.js` — SQLite CRUD for `pipeline_state`, `pipeline_steps`, `agents`, `edits`, `tool_history`.
- `pipeline.js` — State machine engine. `step()` accepts `{ role, artifactVerdict, semanticVerdict }`. Owns ALL transitions.
- `pipeline-conditions.js` — PreToolUse:Agent. Conditions check + step enforcement + scope registration.
- `pipeline-injection.js` — SubagentStart. Creates pipeline from `verification:` steps, injects `output_filepath` + role context.
- `pipeline-verification.js` — SubagentStop. Scope resolution → role dispatch → semantic checks → `engine.step()`.
- `pipeline-block.js` — PreToolUse (all). Blocks tools, reads COMMAND verdict files, allows expected agents.
- `stop-gate.js` — Stop/StopFailure. Checks both v2 and v3 state. Cleans up orphaned pipelines on API error.

### v2 Legacy (still used by plan-gate, edit-gate)
- `claude-gates-shared.js` — v2 frontmatter parser (supports `gates:` format).
- `claude-gates-db.js` — v2 SQLite module (gates table, agent table).
- `claude-gates-config.js` — Config loader (shared with v3).

### Unchanged hooks
- `plan-gate.js` — PreToolUse:ExitPlanMode. Requires gater PASS/CONVERGED.
- `plan-gate-clear.js` — PostToolUse:ExitPlanMode. Clears gater verdicts.
- `commit-gate.js` — PreToolUse:Bash. Validates before `git commit`.
- `edit-gate.js` — PostToolUse:Edit|Write. Tracks edits + formatters.

## Testing

```bash
node scripts/pipeline-test.js         # 90+ v3 unit/integration tests
node scripts/test-pipeline-e2e.js     # 20+ v3 end-to-end tests
node scripts/claude-gates-test.js     # 300+ v2 tests (7 expected failures: hooks.json wiring + agent format)
```
