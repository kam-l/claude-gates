---
description: "Interactive project setup for claude-gates. Creates claude-gates.json, sample gated agents, and explains each gate. Use when: first time setup, 'configure gates', 'setup claude-gates', 'add gates to project', 'create claude-gates.json', 'customize gates', 'explain gates', 'what does X gate do', 'how does verification work', 'change stop gate patterns', 'enable commit gate', 'enable edit gate', 'create sample gated agent', 'install plugin dependencies', 'gate not firing'."
argument-hint: "[install | configure | explain]"
---

AskUserQuestion-driven. Every step teaches a gate concept, then asks how to adapt it. Never silently decide configuration.

## Plugin context

- **Config**: `claude-gates.json` at repo root. Keys: `stop_gate` (patterns, commands, mode), `commit_gate` (commands, enabled), `edit_gate` (commands). Missing keys = built-in defaults.
- **State**: per-session `session.db` (SQLite via `better-sqlite3`). Tables: `pipeline_state`, `pipeline_steps`, `agents`, `edits`, `tool_history`.
- **Frontmatter fields**: `verification:` (unified step array — `["prompt"]`, `[agent, N]`, `[agent, N, fixer]`, `[/cmd, Tool1]`), `conditions:` (block scalar — spawn check).
- **Scopes**: agents spawned with `scope=<name>` in prompt. Parallel scopes are isolated.
- **Gater**: `claude-gates:gater` — read-only evaluator. Verdicts: `Result: PASS`, `REVISE`, `CONVERGED`, `FAIL`.
- **Hooks**: `pipeline-conditions.js` (PreToolUse:Agent), `pipeline-injection.js` (SubagentStart), `pipeline-verification.js` (SubagentStop), `pipeline-block.js` (PreToolUse:*), `plan-gate.js`, `commit-gate.js`, `edit-gate.js`, `stop-gate.js`.
- **Dependency**: `better-sqlite3` native module — auto-installed via SessionStart hook.

## Routing

| Intent | Workflow |
|--------|----------|
| No `claude-gates.json`, or `$ARGUMENTS` = `install` | `references/install.md` |
| Existing config, or `$ARGUMENTS` = `configure` / `explain` | `references/configure.md` |

## Before routing

1. Check `better-sqlite3`: `node -e "require('better-sqlite3')"` from plugin dir. If missing, `npm install` there first.
2. Check if `claude-gates.json` exists at repo root.
3. Detect project stack (`package.json`, `Cargo.toml`, `go.mod`, `*.csproj`, `pyproject.toml`). Note: language, test cmd, lint cmd, formatters.
4. Route.
