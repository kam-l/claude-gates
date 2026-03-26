# claude-gates

Declarative pipeline gates — `verification:` unified array format in agent frontmatter.

## Plugin Packaging

- Manifest: `.claude-plugin/plugin.json` — version must match `package.json`
- Repository: `https://github.com/kam-l/claude-gates`
- **Version bump required for every script change.** Plugin cache keyed by version.

## Build / Test

```bash
node scripts/pipeline-test.js         # 93 unit/integration tests
node scripts/test-pipeline-e2e.js     # 30 end-to-end tests
```

## Frontmatter Quick Reference

```yaml
---
name: agent-name
verification:                         # Ordered pipeline steps
  - ["Semantic check prompt"]         # SEMANTIC
  - [/command, Tool1, Tool2]          # COMMAND
  - [reviewer, 3]                     # REVIEW (3 rounds)
  - [reviewer, 3, fixer]             # REVIEW_WITH_FIXER
conditions: |                         # Pre-spawn check (blocks on FAIL)
  Check if X is ready...
---
```

## Key Invariants

- Hooks: `${CLAUDE_PLUGIN_ROOT}/scripts/...` (SessionStart uses `${CLAUDE_PLUGIN_DATA}`)
- Pipeline: conditions → injection → verification → block. All four + engine must stay in sync.
- `<agent_gate>` XML tag preserved for backward compat.
- `better-sqlite3` is a hard dependency — installed via SessionStart hook.
- Fail-open: every hook catches errors and exits 0.
- **All hooks MUST exit 0.** Exit 2 causes Claude Code to ignore stdout JSON (including `systemMessage`). Use `msg.notify()` file side-channel for SubagentStop messages, not exit codes.

## Session State

- Session data (DB + artifacts) at `{CWD}/.sessions/{shortId}/` (first 8 hex chars of UUID). Shared helper: `getSessionDir()` in `pipeline-shared.js`.
- SQLite via `better-sqlite3`. `session-cleanup.js` sweeps both `.sessions/` and legacy `~/.claude/sessions/`.
- Engine: `scripts/pipeline.js` — owns ALL state transitions via `step()`.
- v3 DB: `scripts/pipeline-db.js` — tables: `pipeline_state`, `pipeline_steps`, `agents`, `edits`, `tool_history`.
- Supporting: `claude-gates-db.js` (plan-gate, stop-gate), `edit-gate.js` (edit tracking), `claude-gates-config.js` (config + commit-gate).

## Configuration

- Create `claude-gates.json` at repo root to configure (optional). Module: `scripts/claude-gates-config.js`.
