---
description: "Pipeline gates documentation and troubleshooting. Auto-triggers on: 'gate failed', 'agent blocked', 'missing artifact', 'verification failed', 'scope=', 'claude-gates', 'pipeline ordering', 'writing an agent', 'verification: field', 'conditions: field', 'Result: PASS', 'Result: FAIL', 'Result: REVISE', 'Result: CONVERGED', 'SubagentStop', 'SubagentStart', 'edit-gate', 'stop-gate', 'gate chain', 'post-completion gates'."
user-invocable: false
---

# claude-gates v3

Hook-level enforcement for agent pipelines. Semantics first, structure later — agents think freely, SubagentStop captures output and pivots verifiers for structured verdicts. Two verification layers:
- **Deterministic**: artifact exists, `Result:` line present (verifiers only)
- **Semantic**: `claude -p` judges content quality via gater agent

## Agent Definition

```yaml
---
name: implementer
verification:                                # Ordered pipeline steps
  - ["Does this show real implementation?"]  # SEMANTIC
  - [reviewer, 3]                            # REVIEW (3 rounds max)
  - [reviewer, 3, fixer]                     # REVIEW_WITH_FIXER
conditions: |                                # Pre-spawn check (blocks on FAIL)
  Only spawn for auth or data changes.
---
```

Spawn with `scope=<name>`: `Agent({ subagent_type: "implementer", prompt: "scope=task-1 ..." })`

## Pipeline Lifecycle

1. **PreToolUse:Agent** (`pipeline-conditions.js`) — conditions check + step enforcement + scope registration
2. **SubagentStart** (`pipeline-injection.js`) — creates pipeline, injects role context for verifiers/fixers (no output structure)
3. **Agent runs** — thinks freely, no format constraints. Source agents on revision get artifact path to update.
4. **SubagentStop** (`pipeline-verification.js`) — pivots agent to write artifact → scope → role → semantic check → `engine.step()`
5. **PreToolUse** (`pipeline-block.js`) — blocks tools while steps pending, forces expected agent spawns

## Step Types

| Type | Format | Execution |
|------|--------|-----------|
| SEMANTIC | `["prompt"]` | claude -p at SubagentStop |
| COMMAND | `[/cmd, Tool1, Tool2]` | block allows listed tools, /pass_or_revise records verdict |
| REVIEW | `[agent, maxRounds]` | block forces agent spawn, agent writes verdict |
| REVIEW_WITH_FIXER | `[agent, N, fixer]` | same as REVIEW; REVISE routes to fixer instead of source |

## Roles (engine.resolveRole)

| Role | Identified by | Behavior |
|------|--------------|----------|
| source | `pipeline_state.source_agent` | SEMANTIC check → engine.step |
| verifier | active step's `agent` field | implicit semantic → engine.step |
| fixer | fix step's `fixer` field | implicit semantic → reactivate gate step |
| gater | hardcoded `bareType === "gater"` | record verdict (feeds plan-gate) |

## State Machine

Pipeline: `normal` ⟷ `revision` → `completed` | `failed`
Step: `pending` → `active` → `passed` / `revise` → `active` / `fix` → `active` / `failed`

Engine owns ALL transitions: `step(db, scope, { role, artifactVerdict, semanticVerdict })`
Failed pipeline recovery: delete rows via `deletePipeline(db, scope)`, re-spawn source.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Write your findings to ..." | SubagentStop pivot — write your summary to the specified path |
| "Missing Result: line" | Verifiers must add `Result: PASS`, `REVISE`, `CONVERGED`, or `FAIL` |
| "has verification but no scope" | Add `scope=<name>` to spawn prompt |
| "expects agent X, not Y" | Pipeline step requires specific agent — spawn the named one |
| "COMMAND step active" | Run the command, then `/pass_or_revise` |
| Pipeline stuck | Run `/claude-gates:unblock` with the session ID |
| Debug leftovers at stop | Remove flagged patterns or stop again (nudge mode) |
