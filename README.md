# claude-gates

Quality gates for Claude Code agents. Your agents shall not pass without earning it.

[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-blueviolet)](https://code.claude.com/docs/en/plugins)
[![Gates: 8](https://img.shields.io/badge/gates-8-orange)]()
[![Tests](https://github.com/kam-l/claude-gates/actions/workflows/test.yml/badge.svg)](https://github.com/kam-l/claude-gates/actions/workflows/test.yml)
[![Version](https://img.shields.io/github/v/tag/kam-l/claude-gates?label=version)](https://github.com/kam-l/claude-gates/releases)


<p align="center">
  <img src="gandalf.png" alt="You shall not pass!" width="400">
</p>

## Install

```bash
claude plugin marketplace add kam-l/claude-gates
claude plugin install claude-gates
cd ~/.claude/plugins/cache/claude-gates && npm install
```

Then run `/claude-gates:setup` to configure gates for your project.

## The Gates

Every gate is a hook that fires at a specific moment. All gates are **fail-open** — if something breaks, your work continues unblocked.

---

### Dependency Gate

**When:** Before an agent spawns (PreToolUse:Agent)

**Why:** Multi-agent pipelines break when agents run out of order. A reviewer that spawns before the implementer has nothing to review.

**How it works:** Add `requires:` to your agent definition. The gate checks that each required agent's artifact exists before allowing the spawn.

```yaml
# .claude/agents/reviewer.md
---
name: reviewer
requires: ["implementer"]
---
```

```
[ClaudeGates] Cannot spawn reviewer: missing implementer.md in task-1/.
Spawn implementer first.
```

Agents must be spawned with `scope=<name>` in the prompt so gates know which pipeline they belong to.

---

### Verification Gate

**When:** After an agent completes (SubagentStop)

**Why:** Agents produce garbage that looks like output. A file exists, it has content, but it's placeholder text that passed no real scrutiny.

**How it works:** Two layers. The **structural layer** checks that the artifact file exists and contains a `Result:` line. The **semantic layer** runs `claude -p --agent claude-gates:gater` to judge whether the content demonstrates real work.

```yaml
# .claude/agents/implementer.md
---
name: implementer
verification: |
  Does this show real implementation with working code?
  Reply PASS or FAIL + reason.
---
```

The verification prompt is what the gater agent evaluates. If it says FAIL, the agent is blocked from completing until it rewrites.

---

### Gate Chain

**When:** After a source agent completes with PASS (SubagentStop + PreToolUse:Agent)

**Why:** Some artifacts need multiple reviewers in sequence — a code reviewer, then a security auditor, then a playtester. Each gate agent must pass before the next one runs.

**How it works:** Add `gates:` to the source agent. After it completes, gates activate in order. Each gate agent can PASS (advance), REVISE (send back to source or fixer), or exhaust its max rounds (fail the chain).

```yaml
# .claude/agents/implementer.md
---
name: implementer
gates:
  - [reviewer, 3]
  - [security-auditor, 2]
  - [reviewer, 3, fixer]    # optional: route REVISE to a fixer agent
---
```

The number is max rounds. If the gate agent returns REVISE 3 times, the chain fails. The optional third element names a fixer agent that handles revisions instead of the source agent.

---

### Conditions Gate

**When:** Before an agent spawns (PreToolUse:Agent)

**Why:** Some agents should only spawn when the prompt meets certain criteria — the right context is present, the right question is being asked.

**How it works:** Add `conditions:` to your agent definition. The gater agent evaluates the spawn prompt against these conditions and returns PASS or FAIL.

```yaml
---
name: security-auditor
conditions: |
  Only spawn if the prompt mentions authentication, authorization,
  or data handling. Not for UI-only changes.
---
```

---

### Plan Gate

**When:** Before exiting plan mode (PreToolUse:ExitPlanMode)

**Why:** Non-trivial plans (>20 lines) should be reviewed before execution. Without this, Claude exits plan mode and starts implementing a plan that may have gaps.

**How it works:** Blocks ExitPlanMode until the gater agent has reviewed the plan and returned PASS. Auto-allows after 3 attempts (safety valve). After each ExitPlanMode, the verdict is cleared so the next plan needs fresh verification.

No configuration needed — works automatically. To verify a plan, spawn `claude-gates:gater` with `scope=verify-plan`.

---

### Commit Gate

**When:** Before `git commit` (PreToolUse:Bash)

**Why:** Catch issues before they're committed — run tests, linting, type checks, whatever your project needs.

**How it works:** Detects `git commit` in Bash commands and runs your configured validation commands first. If any command fails, the commit is blocked.

**Default: disabled.** Enable in `claude-gates.json`:

```json
{
  "commit_gate": {
    "commands": ["npm test", "npm run lint"],
    "enabled": true
  }
}
```

---

### Edit Gate

**When:** After every file edit (PostToolUse:Edit|Write)

**Why:** Formatting should happen automatically when files change, not as a manual step. The edit gate tracks every edited file and runs opt-in formatter commands on each new file (deduped — same file edited twice runs formatters once).

**How it works:** Tracks edited files in SQLite (stop-gate reads this for commit nudging). If `edit_gate.commands` is configured, runs each command with `{file}` replaced by the edited file's absolute path. Failures are non-fatal (stderr warning, never blocks).

**Default: no formatters (opt-in).** Configure in `claude-gates.json`:

```json
{
  "edit_gate": {
    "commands": ["dotnet format --include {file}"]
  }
}
```

Run `/claude-gates:setup` to auto-detect formatters for your stack.

---

### Loop Gate

**When:** Before Bash, Edit, or Write (PreToolUse:Bash|Edit|Write)

**Why:** Agents get stuck in loops — running the same command, making the same edit, writing the same file. Three identical consecutive calls means something is wrong.

**How it works:** Hashes `tool_name + tool_input`. If the same hash appears 3 times in a row, blocks with a message to change approach. A different call resets the counter.

No configuration — always active.

---

### Stop Gate

**When:** At session end (Stop)

**Why:** Debug leftovers ship to production. `console.log`, `TODO`, `HACK` — patterns that belong in development, not in committed code.

**How it works:** Scans all files edited during the session for configurable patterns. Also nudges if tracked files have uncommitted changes. Two modes: **warn** (stderr, default) or **nudge** (blocks once, second stop passes).

**Default patterns:** `TODO`, `HACK`, `FIXME`, `console.log`. Configure in `claude-gates.json`:

```json
{
  "stop_gate": {
    "patterns": ["TODO", "HACK", "FIXME", "console.log", "debugger"],
    "commands": ["dotnet build"],
    "mode": "nudge"
  }
}
```

`commands` run at session end — useful for build verification. `mode: "nudge"` blocks the first stop so you can clean up; stopping again proceeds.

---

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
