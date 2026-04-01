# claude-gates

Quality gates for Claude Code agents. Your agents shall not pass without earning it.

[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-blueviolet)](https://code.claude.com/docs/en/plugins)
[![Gates: 7](https://img.shields.io/badge/gates-7-orange)]()
[![Tests](https://github.com/kam-l/claude-gates/actions/workflows/test.yml/badge.svg)](https://github.com/kam-l/claude-gates/actions/workflows/test.yml)
[![Version](https://img.shields.io/github/v/tag/kam-l/claude-gates?label=version)](https://github.com/kam-l/claude-gates/releases)
[![Coverage](https://codecov.io/gh/kam-l/claude-gates/branch/master/graph/badge.svg)](https://codecov.io/gh/kam-l/claude-gates)

```
● Updated plan
  ⎿  /plan to preview
  ⎿  PreToolUse:ExitPlanMode hook returned blocking  ⎿  [ClaudeGates] 🔐 "rippling-wandering-crane.md"
      error                                              (205 lines) unverified. Spawn
                                                        claude-gates:gater with scope=verify-plan.
  ⎿  Error: [ClaudeGates] 🔐 "rippling-wandering-crane.md" (205 lines) unverified. Spawn
     claude-gates:gater with scope=verify-plan.

● claude-gates:gater(Verify plan via gater review)
  ⎿  Done (28 tool uses · 30.3k tokens · 3m 49s)
  (ctrl+o to expand)

  Read 1 file (ctrl+o to expand)

● Good catches from the gater. Let me address all findings in the plan.
```

<details>
<summary>Flame of Udûn</summary>
<img src="gandalf.png" alt="You shall not pass!" width="400">
</details>

## Install

```bash
claude plugin marketplace add kam-l/claude-gates
claude plugin install claude-gates
```

Then run `/claude-gates:setup` — it checks dependencies, detects your stack, and walks you through every gate interactively.

Or just tell Claude: `Read https://github.com/kam-l/claude-gates and install it.`

## Why This Exists

I tried the popular Claude Code harnesses. They're pure ceremony — elaborate prompts, rigid workflows, bloated skills — and zero enforcement. Your agent can ignore every "rule" because nothing actually stops it.

Then I tried prompt engineering my own subagents. Wrote short, precise instructions. Minimized context usage. Bolded the requirements. But agents still skipped creating their output files, because of course they did - LLMs are probabilistic, not deterministic.

**Prompts are suggestions. Hooks are enforcement.**

ClaudeGates moves quality control from "please do this" to "you literally cannot proceed without doing this" and Claude is not bothered with it, until it must be bothered. Every gate is a hook that fires at a deterministic moment in the agent lifecycle. No amount of prompt-following variance can bypass a `PreToolUse` block, that allows only what must be done.

## The Gates

All gates are **fail-open** — if something breaks, your work continues unblocked.
All have **max retries** - default 2. 
All are customizable by `/claude-gates:setup`. 

| Gate | Hook | What it does |
|------|------|-------------|
| **Conditions** | `PreToolUse:Agent` | Gater evaluates spawn prompt against `conditions:` field. FAIL blocks the spawn - orchestrator must correct it and try spawning again. |
| **Verification** | `SubagentStop` | Subagent is forced to summarize it's work in a file. Separate Sonnet agent then verifies this file. |
| **Pipeline** | `SubagentStop` → `PreToolUse:Agent` | Sequential reviewers from `verification:` field. Each must PASS before the next runs. Orchestrator MUST spawn them in order. |
| **Plan** | `PreToolUse:ExitPlanMode` | Blocks unreviewed plans (>20 lines) until gater returns PASS. Auto-allows after 3 attempts. |
| **Commit** | `PreToolUse:Bash` | Runs configured commands before `git commit` to eg. block commiting until tests pass. Disabled by default. |
| **Edit** | `PostToolUse:Edit\|Write` | Tracks edited files, runs opt-in formatters (deduped per file) with some default ones suggested per language. Non-blocking |
| **Stop** | `Stop` + `StopFailure` | Scans edited files for debug patterns (`TODO`, `console.log`). Nudges uncommitted changes. On API errors, clears orphaned gates so the pipeline can retry cleanly |

- **Hook-level enforcement** — gates are Claude Code hooks (`PreToolUse`, `SubagentStop`, `Stop`), not prompt instructions. They block tool calls via exit codes, not suggestions.
- **SQLite-backed state** — all pipeline state (verdicts, rounds, scopes, edits) lives in a per-session `session.db` via `better-sqlite3`. Atomic transactions, no file-locking races.
- **Scope-based isolation** — each pipeline gets a `scope=<name>`. Parallel pipelines in the same session run independently with no cross-talk.
- **Semantics first, structure later** — agents think freely with no output format constraints until  SubagentStop refocuses them to summarize their run in an output artifact.
- **Fail-open** — every hook catches errors and exits 0. If SQLite fails, if a script throws, if `claude -p` is unavailable — your work continues unblocked.
- **Declarative** — define what needs to happen in YAML frontmatter. The engine handles state transitions, retries, and routing.

## Agent Frontmatter

```yaml
# .claude/agents/implementer.md
---
name: implementer
verification:                                # ordered pipeline steps
  - ["Does this show real implementation?"]  # Gater judges agent's output file
  - [reviewer, 3]                            # Separate agent verifies - 3 rounds max
  - [reviewer, 3, fixer]                     # Other agent verifies and yet another fixes
  - [/lint, Bash]                            # Orchestrator must run a slash command
conditions: |                                # Pre-spawn check
  Only spawn for authentication or data handling changes.
---
```

Step types are inferred from the array shape:

| Pattern | Behavior |
|---------|----------|
| `["prompt text"]` | Gater (Sonnet via `claude -p`) evaluates agent output against the prompt |
| `[agent, N]` | Spawn reviewer agent, up to N rounds |
| `[agent, N, fixer]`| REVISE routes to fixer agent instead of source |
| `[/command, Tool1, Tool2]` | Orchestrator runs a slash command with allowed tools |

### Example scenario

You tell Claude: *"Spawn implementer scope=auth-fix to refactor the auth middleware."*

Here's what the gate system does, step by step:

**1. Pre-spawn check** (`PreToolUse:Agent`)
The `conditions:` field says "Only spawn for authentication or data handling changes." A gater agent evaluates the prompt against this condition. Auth middleware qualifies — spawn allowed. If you'd asked for a CSS tweak, the spawn would be blocked and the orchestrator forced to adjust.

**2. Agent works freely** (`SubagentStart` → agent runs)
The implementer gets no output format instructions. It just does the refactoring — reads code, edits files, thinks in whatever structure comes naturally.

**3. Artifact pivot** (`SubagentStop`, first fire)
The implementer finishes and tries to stop. SubagentStop intercepts: *"Your work is done. Write a thorough summary of your findings to `.sessions/{session_id}/auth-fix/implementer.md`."* The agent is forced to continue and write its summary. Structure is requested only after free thinking is complete.

**4. Semantic check** (`SubagentStop`, second fire)
The implementer stops again, now with an artifact on disk. A separate Sonnet gater reads the artifact and judges: *"Does this show real implementation?"* (the first `verification:` step). If the gater says REVISE — the implementer is told to re-run and update its artifact. If PASS — the pipeline advances.

**5. Reviewer gate** (`PreToolUse` blocks everything)
**All tools except spawning `reviewer` are now blocked.\*** The orchestrator must spawn it. The reviewer reads the implementer's artifact, cross-references the codebase, and writes its own verdict with `Result: PASS` or `Result: REVISE`.

\* With few exceptions: Read, Grep, Glob, TodoCreate, TodoUpdate, `/claude-gates:heal`.

**6. Revision loop** (if REVISE)
REVISE routes to the `fixer` agent (if the step is `[reviewer, 3, fixer]`). The fixer reads both the implementer's artifact and the reviewer's findings, produces corrections. The reviewer runs again on the updated work. This loops up to 3 rounds. If the reviewer's own review is sloppy, a meta-review catches it and forces the reviewer to retry.

**7. Pipeline complete**
All steps pass. The block lifts. The orchestrator can continue with other work. The full audit trail (artifacts, review findings, semantic check results) is in `.sessions/{session_id}/`.

Throughout all of this, Claude (the orchestrator) never sees the gate machinery. It just sees tool calls being blocked with clear instructions on what to do next. The enforcement is invisible until you try to skip a step.

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
  ├─ PreToolUse ────→ pipeline-block.js  (block ALL tools except those required when pipeline is active)
  │                   pipeline-conditions.js (`conditions: `pre-spawn check before Agent tool)
  │                   commit-gate.js     (pre-commit hooks before Bash(git commit) tool)
  │                   plan-gate.js       (plan review before ExitPlanMode tool)
  │
  ├─ PostToolUse ───→ edit-gate.js       (track edits, run formatters after Write/Edit tools)
  │                   plan-gate-clear.js (clear plan gate after exit after ExitPlanMode tool)
  │
  ├─ SubagentStart ─→ pipeline-injection.js (role context for verifiers/fixers)
  │
  ├─ SubagentStop ──→ pipeline-verification.js (verdict → state machine)
  │
  └─ Stop ──────────→ stop-gate.js (debug pattern scan, cleanup)

Engine: pipeline.js ─── state machine, owns ALL transitions via step()
State:  pipeline-db.js ─ SQLite tables: pipeline_state, pipeline_steps,
                         agents, edits, tool_history
Config: claude-gates-config.js ─ reads claude-gates.json
```

~4,900 LOC across 19 scripts. 93 unit tests + 30 end-to-end tests. See [CHANGELOG.md](CHANGELOG.md) for version history.

## Performance

Benchmarks on the pipeline engine (1,000 iterations, SQLite WAL mode):

| Benchmark | Per op | Ops/sec |
|-----------|--------|---------|
| Pipeline creation (3 steps) | 0.24 ms | 4,117 |
| State transition (step → PASS) | 0.98 ms | 1,024 |
| DB read (getPipelineState) | 0.03 ms | 31,178 |
| DB write (setVerdict) | 0.04 ms | 24,148 |
| Concurrent isolation (10 pipelines) | 9.76 ms | 102 |

Run `node scripts/benchmark.js` to reproduce.

## Configuration

Run `/claude-gates:setup` to configure all interactively.

## Testing

```bash
node scripts/pipeline-test.js         # 93 unit/integration tests
node scripts/test-pipeline-e2e.js     # 30 end-to-end tests
```

## License

MIT
