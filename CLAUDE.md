# agent-gate

Declarative pipeline gates — `requires:` and `verification:` fields in agent frontmatter.

## Key Invariants

- Hooks in `hooks/hooks.json` use `${CLAUDE_PLUGIN_ROOT}/scripts/...` paths
- Shared state in `agent-gate-shared.js` (session scopes, artifact tracking)
- Gate logic: conditions check → injection → verification. All three scripts must stay in sync.
