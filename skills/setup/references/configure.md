# Configure Workflow

Existing setup. Explain gates, modify agents, answer questions.

## Intake

AskUserQuestion: "What do you want to do?" Options:
- **Explain a gate** — ask which gate, then explain how it works
- **Add/edit agents** — create or modify gated agent definitions with commented frontmatter
- **Troubleshoot** — diagnose stuck pipelines, missing artifacts, unexpected blocks

## Explain flow

When user picks a gate to explain, use these descriptions:

| Gate | One-liner | Key detail |
|------|-----------|-----------|
| Verification | Judges agent output quality after completion | Two layers: structural (file + Result line) then semantic (gater LLM) |
| Pipeline | Sequential reviewers on an artifact | `verification:` array steps: `[agent, max_rounds, fixer?]` |
| Conditions | Blocks spawn if context doesn't match | Gater evaluates spawn prompt against `conditions:` field |
| Plan | Blocks ExitPlanMode until plan reviewed | Auto-allows after 3 attempts (safety valve) |

After explaining, ask: "Want to learn about another gate, or do something else?"

## Add/edit agents flow

Same as install Q2: detect stack, propose agents with commented frontmatter, confirm before writing.

## Troubleshoot flow

1. Ask: "What's happening?" — common symptoms:
   - Pipeline stuck -> suggest `/claude-gates:unblock`
   - Agent blocked unexpectedly -> check scope, step enforcement
   - Verification not firing -> check `verification:` frontmatter
2. Investigate based on symptom, suggest fix.
