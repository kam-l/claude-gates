---
description: "Interactive project setup for claude-gates. Creates sample gated agents and explains each gate. Use when: first time setup, 'configure gates', 'setup claude-gates', 'add gates to project', 'customize gates', 'explain gates', 'what does X gate do', 'how does verification work', 'create sample gated agent', 'install plugin dependencies', 'gate not firing'."
argument-hint: "[install | configure | explain]"
---

AskUserQuestion-driven. Every step teaches a gate concept, then asks how to adapt it. Never silently decide configuration.

## Plugin context

- **State**: per-session `session.db` (SQLite via `better-sqlite3`). Tables: `pipeline_state`, `pipeline_steps`, `agents`, `edits`, `tool_history`.
- **Frontmatter fields**: `verification:` (unified step array — `["prompt"]`, `[agent, N]`, `[agent, N, fixer]`, `[/cmd, Tool1]`), `conditions:` (block scalar — spawn check).
- **Scopes**: agents spawned with `scope=<name>` in prompt. Parallel scopes are isolated.
- **Gater**: `claude-gates:gater` — read-only evaluator. Verdicts: `Result: PASS`, `REVISE`, `CONVERGED`, `FAIL`.
- **Hooks**: `pipeline-conditions.js` (PreToolUse:Agent), `pipeline-injection.js` (SubagentStart), `pipeline-verification.js` (SubagentStop), `pipeline-block.js` (PreToolUse:*), `plan-gate.js` (PreToolUse:ExitPlanMode), `plan-gate-clear.js` (PostToolUse:ExitPlanMode).
- **Dependency**: `better-sqlite3` native module — auto-installed via SessionStart hook.

## Routing

| Intent | Workflow |
|--------|----------|
| First time, or `$ARGUMENTS` = `install` | `references/install.md` |
| `$ARGUMENTS` = `configure` / `explain` | `references/configure.md` |

## Before routing

1. Check `better-sqlite3`: `node -e "require('better-sqlite3')"` from plugin dir. If missing, `npm install` there first.
2. Detect project stack (`package.json`, `Cargo.toml`, `go.mod`, `*.csproj`, `pyproject.toml`). Note: language, test cmd, lint cmd, formatters.
3. Route.
