# claude-gates

Quality gates for Claude Code agents. Your agents shall not pass without earning it.

[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-blueviolet)](https://code.claude.com/docs/en/plugins)
[![Gates: 7](https://img.shields.io/badge/gates-7-orange)]()
[![Tests](https://github.com/kam-l/claude-gates/actions/workflows/test.yml/badge.svg)](https://github.com/kam-l/claude-gates/actions/workflows/test.yml)
[![Version](https://img.shields.io/github/v/tag/kam-l/claude-gates?label=version)](https://github.com/kam-l/claude-gates/releases)

<p align="center">
  <img src="gandalf.png" alt="You shall not pass!" width="400">
</p>

## Why This Exists

I tried the popular Claude Code harnesses. They're ceremony — elaborate prompts, naming conventions, folder structures — and zero enforcement. Your agent can ignore every "rule" because nothing actually stops it.

Then I tried prompt engineering my own subagents. Wrote aggressive instructions. Added context. Bolded the requirements. Agents still skipped creating their output files. Not sometimes — regularly.

**Prompts are suggestions. Hooks are enforcement.**

claude-gates moves quality control from "please do this" to "you literally cannot proceed without doing this." Every gate is a hook that fires at a deterministic moment in the agent lifecycle. No amount of prompt-following variance can bypass a `PreToolUse` block.

## How It Works

```
Agent spawns ──→ conditions ──→ Agent runs ──→ verification pipeline ──→ ✅ Done
                     │                              │
                    FAIL                        FAIL / REVISE
                     ▼                              ▼
                ⛔ Blocked                    🔄 Fixer or source
                orchestrator                  agent retries
                forced to adjust
```

The `verification:` array in agent frontmatter defines an ordered pipeline. Each step is a different gate type — semantic checks, reviewer agents, fixer loops — executed sequentially. A step must PASS before the next one runs.

### Design decisions

- **Hook-level enforcement** — gates are Claude Code hooks (`PreToolUse`, `SubagentStop`, `Stop`), not prompt instructions. They block tool calls via exit codes, not suggestions.
- **SQLite-backed state** — all pipeline state (verdicts, rounds, scopes, edits) lives in a per-session `session.db` via `better-sqlite3`. Atomic transactions, no file-locking races.
- **Scope-based isolation** — each pipeline gets a `scope=<name>`. Parallel pipelines in the same session run independently with no cross-talk.
- **Artifact-based verification** — each agent gets an `output_filepath` injected at spawn. Gates verify the artifact file, not conversation state. Artifacts persist on disk, survive context compaction, and are readable by downstream agents.
- **Fail-open** — every hook catches errors and exits 0. If SQLite fails, if a script throws, if `claude -p` is unavailable — your work continues unblocked.
- **Declarative** — define what needs to happen in YAML frontmatter. The engine handles state transitions, retries, and routing.

## Install

```bash
claude plugin marketplace add kam-l/claude-gates
claude plugin install claude-gates
```

Then run `/claude-gates:setup` — it checks dependencies, detects your stack, and walks you through every gate interactively.

Or just tell Claude: `Read https://github.com/kam-l/claude-gates and install it.`

## The Gates

All gates are **fail-open** — if something breaks, your work continues unblocked.

| Gate | Hook | What it does |
|------|------|-------------|
| **Conditions** | `PreToolUse:Agent` | Gater evaluates spawn prompt against `conditions:` field. FAIL blocks the spawn |
| **Verification** | `SubagentStop` | Structural check (artifact exists, `Result:` line) + semantic check (gater judges content quality) |
| **Gate Chain** | `SubagentStop` → `PreToolUse:Agent` | Sequential reviewers from `verification:` field. Each must PASS before the next runs |
| **Plan** | `PreToolUse:ExitPlanMode` | Blocks unreviewed plans (>20 lines) until gater returns PASS. Auto-allows after 3 attempts |
| **Commit** | `PreToolUse:Bash` | Runs configured commands before `git commit`. Disabled by default |
| **Edit** | `PostToolUse:Edit\|Write` | Tracks edited files, runs opt-in formatters (deduped per file). Non-blocking |
| **Stop** | `Stop` + `StopFailure` | Scans edited files for debug patterns (`TODO`, `console.log`). Nudges uncommitted changes. On API errors, clears orphaned gates so the pipeline can retry cleanly |

## Agent Frontmatter

```yaml
# .claude/agents/implementer.md
---
name: implementer
verification:                                # ordered pipeline steps
  - ["Does this show real implementation?"]  # SEMANTIC — gater judges output
  - [reviewer, 3]                            # REVIEW — 3 rounds max
  - [security-auditor, 2]                    # REVIEW — 2 rounds max
  - [reviewer, 3, fixer]                     # REVIEW_WITH_FIXER — REVISE routes to fixer
  - [/lint, Bash]                            # COMMAND — run a slash command
conditions: |                                # pre-spawn check (blocks on FAIL)
  Only spawn for authentication or
  data handling changes.
---
```

Step types are inferred from the array shape:

| Pattern | Type | Behavior |
|---------|------|----------|
| `["prompt text"]` | Semantic | Gater evaluates agent output against the prompt |
| `[agent, N]` | Review | Spawn reviewer agent, up to N rounds |
| `[agent, N, fixer]` | Review + Fixer | REVISE routes to fixer agent instead of source |
| `[/command, Tool1, Tool2]` | Command | Run a slash command with allowed tools |

## Skills

| Skill | What it does |
|-------|-------------|
| `/claude-gates:setup` | Interactive setup — installs deps, explains each gate, writes `claude-gates.json` |
| `/claude-gates:claude-gates` | Documentation and troubleshooting reference |
| `/claude-gates:heal` | Diagnoses and repairs stuck pipeline state |

## Architecture

```
hooks.json
  │
  ├─ SessionStart ──→ session-cleanup.js (sweep old sessions)
  │                   npm install (better-sqlite3 into CLAUDE_PLUGIN_DATA)
  │
  ├─ PreToolUse ────→ pipeline-block.js  (block tools while gate is active)
  │                   pipeline-conditions.js (conditions: pre-spawn check)
  │                   commit-gate.js     (pre-commit hooks)
  │                   plan-gate.js       (plan review)
  │
  ├─ PostToolUse ───→ edit-gate.js       (track edits, run formatters)
  │                   plan-gate-clear.js (clear plan gate after exit)
  │
  ├─ SubagentStart ─→ pipeline-injection.js (inject output_filepath)
  │
  ├─ SubagentStop ──→ pipeline-verification.js (verdict → state machine)
  │
  └─ Stop ──────────→ stop-gate.js (debug pattern scan, cleanup)

Engine: pipeline.js ─── state machine, owns ALL transitions via step()
State:  pipeline-db.js ─ SQLite tables: pipeline_state, pipeline_steps,
                         agents, edits, tool_history
Config: claude-gates-config.js ─ reads claude-gates.json
```

~4,900 LOC across 19 scripts. 93 unit tests + 22 end-to-end tests.

## Configuration

Create `claude-gates.json` at your repo root, or run `/claude-gates:setup` to generate it interactively.

## Testing

```bash
node scripts/pipeline-test.js         # 93 unit/integration tests
node scripts/test-pipeline-e2e.js     # 22 end-to-end tests
```

## License

MIT
