# claude-gates

Declarative pipeline gates — `verification:` unified array format in agent frontmatter.

## Plugin Packaging

- Manifest: `.claude-plugin/plugin.json` — version must match `package.json`
- Repository: `https://github.com/kam-l/claude-gates`
- **Version bump required for every script change.** Plugin cache keyed by version.

## Build / Test

```bash
node scripts/PipelineTest.js           # 108 unit/integration tests
node scripts/PipelineE2eTest.js       # 28 end-to-end tests
```

- TypeScript source in `src/`, compiled to `scripts/` — compiled JS tracked in git (consumers need no build step)
- `tsconfig.json`: `strict: true`, CJS (`module: commonjs`), `outDir: scripts`, `rootDir: src`
- Build: `npm run build` (tsc). Verify interop: no `exports.default` in compiled output.

## Frontmatter Quick Reference

```yaml
---
name: agent-name
verification:                         # Ordered pipeline steps
  - ["Semantic check prompt"]         # CHECK
  - [/command, Tool1, Tool2]          # TRANSFORM (orchestrator runs command)
  - [cleaner!, 1]                      # TRANSFORM (auto-pass, no verdict)
  - [reviewer?, 3]                    # VERIFY (3 rounds, ? is cosmetic)
  - [reviewer?, 3, fixer!]            # VERIFY_W_FIXER
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
- **All hooks MUST exit 0.** Exit 2 causes Claude Code to ignore stdout JSON (including `systemMessage`). Use `Messaging.notify()` file side-channel for SubagentStop messages, not exit codes.

## Design Principles

- **Semantics first, structure later.** Agents do free-form reasoning. Output structure (`Result:` lines, sections) is a post-work concern — never inject structural requirements before an agent thinks. Only verifiers produce pipeline verdicts; source agents and fixers just write content.
- **Gate agents vs gater:** Pipeline-spawned gate agents (gt-reviewer etc.) write free-form `Result: PASS/REVISE` output. SubagentStop spawns `claude-gates:gater` via `claude -p`, which reads that output and calls `gate_verdict` MCP. Gate agents never call MCP directly.

## Architecture

```
src/
  types/Enums.ts              # Verdict, StepType, PipelineStatus, StepStatus, AgentRole
  types/Interfaces.ts         # IPipelineState, IPipelineStep, Action, VerificationStep, etc.
  PipelineEngine.ts           # Class — state machine transitions (step, retryGateAgent)
  PipelineRepository.ts       # Class — pipeline CRUD (schema + all DB operations)
  GateRepository.ts           # Class — plan-gate attempts + MCP verdict storage
  SessionManager.ts           # Static — openDatabase, getSessionDir, agentRunningMarker
  FrontmatterParser.ts        # Static — extractFrontmatter, parseVerification, parseConditions
  Messaging.ts                # Static — block, info, notify, log
  Tracing.ts                  # Static — Langfuse + audit.jsonl
  session-context.ts           # Hook: SessionStart — injects session context
  pipeline-verification.ts    # Hook: SubagentStop — role dispatch + semantic checks
  pipeline-block.ts           # Hook: PreToolUse — blocks tools while pipeline active
  pipeline-conditions.ts      # Hook: PreToolUse:Agent — conditions + step enforcement
  pipeline-injection.ts       # Hook: SubagentStart — pipeline creation + context enrichment
  plan-gate.ts                # Hook: PreToolUse:ExitPlanMode — blocks unverified plans
  plan-gate-clear.ts          # Hook: PostToolUse:ExitPlanMode — clears gater verdict
  mcp-server.ts               # MCP: gate_verdict + gate_status tools
  database.ts                 # Test helper — flat (db, scope, ...) API over PipelineRepository
  state-machine.ts            # Test helper — flat (db, scope, ...) API over PipelineEngine
```

## Session State

- Session data (DB + artifacts) at `{CWD}/.sessions/{shortId}/` (first 8 hex chars of UUID). `SessionManager.getSessionDir()`.
- SQLite via `better-sqlite3`. `session-cleanup.js` sweeps both `.sessions/` and legacy `~/.claude/sessions/`.
- Engine: `PipelineEngine` — owns ALL state transitions via `step()`. Semantic dispatch in hook layer.
- Pipeline DB: `PipelineRepository` — tables: `pipeline_state`, `pipeline_steps`, `agents`, `edits`, `tool_history`.
- Gate DB: `GateRepository` — plan-gate attempts + MCP verdict. Separate schema, same `.db` file.
