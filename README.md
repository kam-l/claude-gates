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

- **Hook-level enforcement** — gates are Claude Code hooks (`PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`), not prompt instructions. They block tool calls via exit codes, not suggestions.
- **SQLite-backed state** — all gate state (verdicts, rounds, scopes, edits) lives in a per-session `session.db` via `better-sqlite3`. Atomic transactions, no file-locking races.
- **Scope-based isolation** — each pipeline gets a `scope=<name>`. Parallel pipelines (same session, different scopes) run independently with no cross-talk.
- **Artifact-based** — each agent gets an `output_filepath` injected at spawn. Gates verify the artifact file, not conversation state. Artifacts persist on disk, survive compaction, and are readable by downstream agents.
- **Fail-open** — every gate catches errors and exits 0. If SQLite fails, if a script throws, if `claude -p` is unavailable — your work continues unblocked.
- **Dependency: `better-sqlite3`** — native Node module, auto-installed on first session via `SessionStart` hook into `CLAUDE_PLUGIN_DATA` (persists across plugin updates).

## Install

```bash
claude plugin marketplace add kam-l/claude-gates
claude plugin install claude-gates
```

Then run `/claude-gates:setup` — it checks dependencies, detects your stack, and walks you through every gate interactively.

Or just tell Claude to: `Read https://github.com/kam-l/claude-gates and install it.`

## Gate Lifecycle

Gates fire at hook boundaries — not prompt-level, hook-level.

```
Agent spawns ──→ conditions: ──→ Agent runs ──→ verification: ──→ gates: ──→ ✅ Done
                      │                              │               │
                     FAIL                           FAIL           REVISE
                      ▼                              ▼               ▼
                 ⛔ Blocked                    🔄 Rewrites     🔄 Rewrites
                 orchestrator                  retries          retries gate
                 forced to adjust
```

## The Gates

All gates are **fail-open** — if something breaks, your work continues unblocked.

| Gate | Hook | What it does |
|------|------|-------------|
| **Conditions** | `PreToolUse:Agent` | Gater evaluates spawn prompt against `conditions:` field. FAIL blocks the spawn |
| **Verification** | `SubagentStop` | Structural check (artifact exists, `Result:` line) + semantic check (gater judges content quality) |
| **Gate Chain** | `SubagentStop` + `PreToolUse:Agent` | Sequential reviewers from `gates:` field. Each must PASS before the next runs |
| **Plan** | `PreToolUse:ExitPlanMode` | Blocks unreviewed plans (>20 lines) until gater returns PASS. Auto-allows after 3 attempts |
| **Commit** | `PreToolUse:Bash` | Runs configured commands before `git commit`. Disabled by default |
| **Edit** | `PostToolUse:Edit\|Write` | Tracks edited files, runs opt-in formatters (deduped per file). Non-blocking |
| **Stop** | `Stop` + `StopFailure` | Scans edited files for debug patterns (`TODO`, `console.log`). Nudges uncommitted changes. On API errors, clears orphaned gates so pipeline can retry cleanly |

### Agent frontmatter fields

```yaml
# .claude/agents/implementer.md
---
name: implementer
verification:                                # ordered pipeline steps
  - ["Does this show real implementation?"]  # SEMANTIC — gater judges output
  - [reviewer, 3]                            # REVIEW — 3 rounds max
  - [security-auditor, 2]                    # REVIEW — 2 rounds max
  - [reviewer, 3, fixer]                     # REVIEW_WITH_FIXER — REVISE routes to fixer
conditions: |                                # PreToolUse:Agent: gater checks spawn prompt
  Only spawn for authentication or
  data handling changes.
---
```

Spawn agents with `scope=<name>` so gates know which pipeline they belong to.

## Configuration

`/claude-gates:setup` is the one-stop for installation, explanation, and customization. It teaches each gate interactively and writes `claude-gates.json` for you. Run it again anytime to learn about a gate, change settings, or add agents.

## Testing

```bash
node scripts/pipeline-test.js
```

## License

MIT
