---
description: "AgentGate v1 — declarative agent pipeline gates. Use when spawning gated agents, debugging gate failures, writing agent definitions with requires:/verification: fields, or understanding pipeline ordering. Triggers on: 'gate failed', 'agent blocked', 'missing artifact', 'requires not met', 'verification failed', 'scope=', 'session_scopes', 'agent-gate', 'pipeline ordering', 'writing an agent', 'requires: field', 'verification: field', 'how do I gate', 'agent frontmatter', 'Result: PASS', 'Result: FAIL', 'SubagentStop', 'SubagentStart'."
user-invocable: false
---

# AgentGate v1

Hybrid enforcement for agent pipelines. Two layers:
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

**Artifact path**: `~/.claude/sessions/{session_id}/{scope}/{agent_type}.md`

## Orchestrator Contract

Include `scope=<name>` in spawn prompt. No scope = ungated (backward compatible).

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

## Three Hooks

| Hook | Event | Does |
|------|-------|------|
| `agent-gate-conditions.js` | PreToolUse:Agent | Checks `requires:` deps, stages `output_filepath` in `_pending` |
| `agent-gate-injection.js` | SubagentStart | Injects `output_filepath` via `<agent_gate>` tag |
| `agent-gate-verification.js` | SubagentStop | Structural + semantic validation on stop |

## Legacy Compatibility

Old `gate:` schema (artifact/required/verdict/prompt/context) still works via `agent-gate-compat.js`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Missing X.md — spawn X first" | Spawn required agent before this one |
| "Write your artifact to ..." | Agent must write to `output_filepath` from `<agent_gate>` block |
| "Missing Result: line" | Add `Result: PASS` or `Result: FAIL` as standalone line |
| "Failed semantic validation" | Rewrite with substantive analysis |
| Agent runs ungated | Add `scope=<name>` to spawn prompt |
