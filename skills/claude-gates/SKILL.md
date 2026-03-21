---
description: "ClaudeGates v2 — declarative pipeline gates. Use when spawning gated agents, debugging gate failures, writing agent definitions with verification:/conditions:/gates: fields, or understanding pipeline ordering. Triggers on: 'gate failed', 'agent blocked', 'missing artifact', 'verification failed', 'scope=', 'session_scopes', 'claude-gates', 'pipeline ordering', 'writing an agent', 'verification: field', 'conditions: field', 'gates: field', 'how do I gate', 'agent frontmatter', 'Result: PASS', 'Result: FAIL', 'Result: REVISE', 'Result: CONVERGED', 'SubagentStop', 'SubagentStart', 'edit-gate', 'stop-gate', 'verdict object', 'gate chain', 'post-completion gates'."
user-invocable: false
---

# ClaudeGates v2

Hybrid enforcement for pipelines. Two layers:
- **Deterministic**: file exists, `Result:` line present, `requires:` deps met
- **Semantic**: `claude -p` judges whether content demonstrates real work

## Agent Definition Schema

```yaml
---
name: reviewer
requires: ["implementer", "cleaner"]
verification: |
  Evaluate whether this demonstrates genuine critical analysis.
  Reply EXACTLY on the last line: PASS or FAIL followed by your reason.
---
```

**Fields:**
- `conditions:` — semantic PRE-check before agent spawns (claude -p, requires scope). Blocks if FAIL.
- `requires:` — list of agent types that must complete first (requires scope)
- `verification:` — semantic POST-check after agent completes (claude -p)
- `gates:` — ordered post-completion gate chain (requires scope). Format: `- [agent_type, max_rounds]`

**Artifact path**: `~/.claude/sessions/{session_id}/{scope}/{agent_type}.md`

## Orchestrator Contract

Include `scope=<name>` in spawn prompt. **Required** for agents with `gates:` or `requires:` fields (blocked otherwise). No scope = ungated for agents with only `verification:`.

### Gate Chain (`gates:` field)

```yaml
---
name: implementer
gates:
  - [reviewer, 3]
  - [playtester, 3]
---
```

After source agent completes (PASS/CONVERGED), gates are enforced in order:
1. Conditions hook blocks all spawns in scope except the active gate agent
2. Gate agent PASS → advance to next gate. All gates passed → scope unblocked
3. Gate agent REVISE → source agent must re-run, then gate re-runs (max N rounds)
4. Gate agent FAIL → semantic layer blocks rewrite (no state change)

```
Agent({ subagent_type: "reviewer", prompt: "scope=task-1 Review the spec..." })
```

## Agent Contract

At SubagentStart, agents receive an injected `<agent_gate>` context block:

```xml
<agent_gate importance="critical">
output_filepath=~/.claude/sessions/{session_id}/{scope}/{agent_type}.md
Write your artifact to this exact path. Last line must be: Result: PASS or Result: FAIL
</agent_gate>
```

Agents MUST write their artifact to `output_filepath` and include a `Result:` line.
Upstream artifacts (from required agents) are siblings in the same scope directory.

## Verdict Objects

After verification, `session_scopes.json` stores structured verdict objects:

```json
{
  "scope-name": {
    "cleared": {
      "reviewer": {
        "verdict": "PASS",
        "round": 1
      }
    }
  }
}
```

`if (cleared[agentType])` works for both `true` (initial clear) and verdict objects (after verification).

## Hooks

| Hook | Event | Does |
|------|-------|------|
| `claude-gates-conditions.js` | PreToolUse:Agent | Checks `requires:` deps, stages `output_filepath` in `_pending` |
| `claude-gates-injection.js` | SubagentStart | Injects `output_filepath` via `<agent_gate>` tag |
| `claude-gates-verification.js` | SubagentStop | Structural + semantic validation on stop |
| `plan-gate.js` | PreToolUse:ExitPlanMode | Verdict-based: checks for gater PASS in session_scopes |
| `commit-gate.js` | PreToolUse:Bash | Pre-commit validation (opt-in via `claude-gates.json`) |
| `edit-gate.js` | PostToolUse:Edit\|Write | Tracks edited files, runs opt-in formatters |
| `stop-gate.js` | Stop | Configurable debug scan + custom commands + commit nudge |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Missing X.md — spawn X first" | Spawn required agent before this one |
| "Write your artifact to ..." | Agent must write to `output_filepath` from `<agent_gate>` block |
| "Missing Result: line" | Add `Result: PASS` or `Result: FAIL` as standalone line |
| "Failed semantic validation" | Rewrite with substantive analysis |
| Agent runs ungated | Add `scope=<name>` to spawn prompt |
| "has gates/requires fields but no scope" | Add `scope=<name>` — required for agents with `gates:` or `requires:` |
| "has active gate: X" | Spawn the named gate agent with the same scope |
| "gate returned REVISE" | Resume/re-spawn the source agent to fix, then gate re-runs |
| "Debug leftovers found" | Remove flagged patterns or stop again (nudge mode) / ignore (warn mode) |
| "Pre-commit check failed" | Fix validation command failures before committing |
| "Blocked: identical tool call" | Change your approach — same call was made 3 times |
