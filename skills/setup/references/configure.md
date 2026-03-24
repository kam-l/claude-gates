# Configure Workflow

Existing setup. Explain gates, modify config, answer questions.

## Intake

Read existing `claude-gates.json`. AskUserQuestion: "What do you want to do?" Options:
- **Explain a gate** — ask which gate, then explain how it works with current config values
- **Change gate settings** — ask which gate, show current value, ask for new value
- **Add agents** — create gated agent definitions with commented frontmatter
- **Show current config** — print `claude-gates.json` with annotations explaining each field

## Explain flow

When user picks a gate to explain, use these descriptions:

| Gate | One-liner | Key detail |
|------|-----------|-----------|
| Verification | Judges agent output quality after completion | Two layers: structural (file + Result line) then semantic (gater LLM) |
| Gate Chain | Sequential reviewers on an artifact | `verification:` array steps: `[agent, max_rounds, fixer?]` |
| Conditions | Blocks spawn if context doesn't match | Gater evaluates spawn prompt against `conditions:` field |
| Plan | Blocks ExitPlanMode until plan reviewed | Auto-allows after 3 attempts (safety valve) |
| Commit | Runs commands before git commit | `commit_gate.commands` array, disabled by default |
| Edit | Auto-format on file edit | `edit_gate.commands` with `{file}` placeholder, deduped, non-blocking |
| Stop | Scans for debug leftovers at session end | `stop_gate.patterns` + `.mode` (warn/nudge) |

After explaining, ask: "Want to change this gate's settings, or ask about another?"

## Change flow

1. Show current value from `claude-gates.json`
2. AskUserQuestion with current value as default + alternatives
3. Preview the change
4. AskUserQuestion: "Apply?" — **Yes** / **Adjust** / **Cancel**
5. Write updated `claude-gates.json`

## Add agents flow

Same as install Q2: detect stack, propose agents with commented frontmatter, confirm before writing.
