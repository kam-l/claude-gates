# claude-gates

Declarative pipeline gates — `verification:` unified array format in agent frontmatter.

## Plugin Packaging

- Manifest: `.claude-plugin/plugin.json` — version must match `package.json`
- Repository: `https://github.com/kam-l/claude-gates`
- **Version bump required for every script change.** Plugin cache keyed by version.

## Build / Test

```bash
node scripts/pipeline-test.js         # 90+ unit/integration tests
node scripts/test-pipeline-e2e.js     # 20+ end-to-end tests
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

## Session State

- SQLite via `better-sqlite3` in `CLAUDE_PLUGIN_DATA`.
- Engine: `scripts/pipeline.js` — owns ALL state transitions via `step()`.
- v3 DB: `scripts/pipeline-db.js` — tables: `pipeline_state`, `pipeline_steps`, `agents`, `edits`, `tool_history`.
- Supporting: `claude-gates-db.js` (plan-gate, edit-gate), `claude-gates-config.js` (stop-gate, commit-gate).

## Configuration

- `claude-gates.json` at repo root (optional). Module: `scripts/claude-gates-config.js`.
