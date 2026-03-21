# claude-gates

Declarative pipeline gates — `requires:`, `verification:`, `conditions:`, and `gates:` fields in agent frontmatter.

## Key Invariants

- Hooks in `hooks/hooks.json` use `${CLAUDE_PLUGIN_ROOT}/scripts/...` paths
- Gate logic: conditions check → injection → verification. All three scripts must stay in sync.
- Keep `<agent_gate>` XML tag unchanged — backward compat with existing agent definitions.
- `gates:` field requires SQLite (`better-sqlite3`). Without it, gate enforcement is fail-open.
- **Version bump required for every script change.** Plugin cache is keyed by version string — same version = no re-download = stale hooks with no warning.

## Session State

- Dual-path in every hook: SQLite when `better-sqlite3` available, JSON fallback otherwise.
- DB module: `scripts/claude-gates-db.js`. Column names match JS property names (`max`, `outputFilepath`).
- `better-sqlite3` is in `optionalDependencies` — `npm install` succeeds even if native compilation fails.
- Migration: first `getDb()` call auto-imports existing JSON files into SQLite inside a transaction. Old files left in place (marker prevents re-migration).
- Tables: `scopes`, `cleared`, `pending`, `edits`, `tool_history`, `markers`, `edit_stats`, `scope_gates`.

## Configuration

- Project-level config via `claude-gates.json` at repo root (optional).
- Config module: `scripts/claude-gates-config.js`. Resolution: `CLAUDE_GATES_CONFIG` env var → git root → cwd → defaults.
- Arrays are replaced, objects are merged. No config file = built-in defaults.

## Module Map

- `claude-gates-shared.js` — frontmatter parsing (`extractFrontmatter`, `parseRequires`, `parseVerification`, `parseConditions`, `parseGates`, `requiresScope`, `findAgentMd`, `VERDICT_RE`). Zero deps.
- `claude-gates-db.js` — SQLite session state (32 exports). Graceful fallback when `better-sqlite3` absent. Gate operations: `initGates`, `getActiveGate`, `getReviseGate`, `getFixGate`, `passGate`, `reviseGate`, `fixGate`, `reactivateReviseGate`, `reactivateFixGate`.
- `claude-gates-config.js` — Project-level config loader. Reads `claude-gates.json`, merges with defaults, caches per process.
- `claude-gates-conditions.js` — PreToolUse:Agent. Checks `requires:`, `conditions:` (semantic pre-check), enforces `gates:` chain ordering, blocks missing scope for CG agents. Registers scope+cleared+pending atomically.
- `claude-gates-injection.js` — SubagentStart. Reads pending, injects `output_filepath`. Enhances context for gate agents (`role=gate`) and fixer agents (`role=fixer`) with source artifact info.
- `claude-gates-verification.js` — SubagentStop. Two-layer verification (or gates-only structural check), verdict recording, gate state machine transitions. Hardcoded gater fallback: records verdict from `last_assistant_message` when no artifact file found (feeds plan-gate).
- `plan-gate.js` — PreToolUse:ExitPlanMode. Verdict-based: checks session_scopes for gater PASS/CONVERGED. Auto-allows after 3 attempts.
- `commit-gate.js` — PreToolUse:Bash. Detects `git commit`, runs configured validation commands. Opt-in via `claude-gates.json`.
- `edit-gate.js` — PostToolUse:Edit|Write. Tracks edited files + git line stats. Configurable thresholds (default: 10 files / 200 lines).
- `loop-gate.js` — PreToolUse:Bash|Edit|Write. Blocks 3rd consecutive identical call.
- `gate-block.js` — PreToolUse (no matcher = all tools). Blocks non-read tools when gate is active/revise/fix. Allows Read/Glob/Grep and spawning correct agent.
- `stop-gate.js` — Stop. Artifact completeness + configurable debug scan + custom commands. Default mode: warn (stderr only).

## Testing

```bash
node scripts/claude-gates-test.js    # 280 tests (SQLite) / fewer with JSON fallback
```

Tests are subprocess-based with temp dirs. Each test creates its own session directory and cleans up with `rmSync`.
