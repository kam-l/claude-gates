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

## Install

```bash
claude plugin marketplace add kam-l/claude-gates
claude plugin install claude-gates
cd ~/.claude/plugins/cache/claude-gates && npm install
```

Then run `/claude-gates:setup` to configure gates for your project.

## Quick Start

Add `verification:` to any agent definition:

```yaml
# .claude/agents/implementer.md
---
name: implementer
verification: |
  Does this show real implementation with working code?
  Reply PASS or FAIL + reason.
---
```

That's it. The agent's output will be judged by the gater before the pipeline continues. Spawn with `scope=<name>` so gates know which pipeline it belongs to.

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
| **Stop** | `Stop` | Scans edited files for debug patterns (`TODO`, `console.log`). Nudges uncommitted changes |

### Agent frontmatter fields

```yaml
---
name: implementer
verification: |                        # gater judges output quality after completion
  Does this show real implementation?
  Reply PASS or FAIL + reason.
conditions: |                          # gater checks spawn prompt before agent runs
  Only spawn for authentication or
  data handling changes.
gates:                                 # sequential reviewers after PASS
  - [reviewer, 3]                      # [agent, max_rounds]
  - [security-auditor, 2]
  - [reviewer, 3, fixer]              # optional 3rd element: fixer agent for REVISE
---
```

Spawn agents with `scope=<name>` so gates know which pipeline they belong to.

## Configuration

All gates are configured via optional `claude-gates.json` at your repo root. Run `/claude-gates:setup` to generate one interactively.

Missing fields use defaults. No config file = built-in defaults. All gates work without any configuration.

```json
{
  "stop_gate": {
    "patterns": ["TODO", "HACK", "FIXME", "console.log"],
    "commands": [],
    "mode": "warn"
  },
  "commit_gate": {
    "commands": [],
    "enabled": false
  },
  "edit_gate": {
    "commands": []
  }
}
```

## Agents

**Gater** (`claude-gates:gater`) — the universal quality gate agent. Handles artifact review, conditions pre-checks, and plan verification. Read-only evaluator with tools restricted to Read, Grep, Glob, and read-only Bash. Returns `Result: PASS`, `REVISE`, `CONVERGED`, or `FAIL`.

## Testing

```bash
node scripts/claude-gates-test.js
```

## License

MIT
