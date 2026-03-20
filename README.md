# claude-gates

Declarative pipeline gates for Claude Code agents. Two YAML fields enforce ordering and quality — automatically.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-blueviolet)](https://code.claude.com/docs/en/plugins)
[![Tests: 213 passing](https://img.shields.io/badge/tests-213_passing-green)]()
[![Version: 2.3.0](https://img.shields.io/badge/version-2.3.0-blue)]()

```yaml
---
name: implementer
verification: |
  Does this show real implementation? Reply: PASS or FAIL + reason.
gates:
  - [reviewer, 3]
  - [playtester, 3]
---
```

<p align="center">
  <img src="assets/demo.gif" alt="Demo: reviewer blocked until implementer completes, then allowed" width="800">
</p>

## Why

Multi-agent pipelines break in two ways: agents run out of order, or they produce garbage that looks like output. Guard logic scattered across prompts doesn't scale. claude-gates fixes both with two YAML fields.

## Features

- **`requires:`** — block agents until dependencies complete
- **`verification:`** — LLM-as-judge semantic quality check
- **`conditions:`** — semantic pre-check before agent spawns
- **`gates:`** — ordered post-completion gate chain with automatic enforcement
- **Deterministic layer** — file exists, `Result:` line present
- **Semantic layer** — `claude -p` catches placeholder content
- **Plan gate** — blocks ExitPlanMode until gater verdict found (auto-allows after 3 attempts)
- **Commit gate** — pre-commit validation via configurable commands (opt-in)
- **Commit nudge** — stderr warning at configurable file/line thresholds
- **Loop detection** — blocks 3rd consecutive identical tool call
- **Debug cleanup** — configurable patterns + custom commands at session end (default: warn)
- **Artifact completeness** — warns about incomplete agents in active scopes
- **Atomic state** — SQLite WAL mode eliminates race conditions (optional)
- **Fail-open** — bugs degrade to no gating, never to data loss

## Install

```bash
claude plugin marketplace add kam-l/claude-gates
claude plugin install claude-gates
```

Optional: run `npm install` in the plugin directory to enable SQLite session state (atomic operations, no race conditions between concurrent hooks). Without it, JSON file-based state is used automatically.

## Quick Start

**1. Add gates to your agent definitions:**

```yaml
# .claude/agents/implementer.md
---
name: implementer
verification: |
  Does this show real implementation? Reply: PASS or FAIL + reason.
---
```

```yaml
# .claude/agents/reviewer.md
---
name: reviewer
requires: ["implementer"]
verification: |
  Does this show genuine critical analysis? Reply: PASS or FAIL + reason.
---
```

**2. Spawn agents with a scope:**

```
Agent({ subagent_type: "implementer", prompt: "scope=task-1 Implement ..." })
```

**3. Gates enforce automatically:**

```
implementer completes -> writes task-1/implementer.md with Result: PASS
reviewer spawns       -> conditions hook checks requires:
                      -> implementer.md exists? -> ALLOW
reviewer finishes     -> verification hook runs claude -p
                      -> content is substantive? -> PASS -> done
```

If a `requires:` dependency is missing:

```
[ClaudeGates] Cannot spawn reviewer: missing implementer.md in task-1/.
Spawn implementer first.
```

## How It Works

Two enforcement layers, by design:

| Layer | Checks | Deterministic? |
|-------|--------|:-:|
| **Structural** | File exists, `Result:` line, `requires:` deps | Yes |
| **Semantic** | `claude -p` judges content quality | No |

Structural gates catch forgotten artifacts. Semantic gates catch lazy content that passes structural checks.

### Hook Pipeline

| Hook | Event | Purpose |
|------|-------|---------|
| `claude-gates-conditions.js` | PreToolUse:Agent | Check `requires:` before spawn, register scope |
| `claude-gates-injection.js` | SubagentStart | Inject `output_filepath` via `<agent_gate>` tag |
| `claude-gates-verification.js` | SubagentStop | Structural + semantic validation, verdict recording |
| `plan-gate.js` | PreToolUse:ExitPlanMode | Verdict-based: checks for gater PASS in session_scopes |
| `commit-gate.js` | PreToolUse:Bash | Pre-commit validation (opt-in via config) |
| `edit-gate.js` | PostToolUse:Edit\|Write | Track edited files, nudge at configurable thresholds |
| `loop-gate.js` | PreToolUse:Bash\|Edit\|Write | Break infinite loops of identical calls |
| `stop-gate.js` | Stop | Configurable debug scan + custom commands (default: warn) |

### Artifact Convention

```
~/.claude/sessions/{session_id}/{scope}/{agent_type}.md
```

Agents sharing a `scope` write to the same directory and can read each other's output. Last line must be `Result: PASS`, `Result: FAIL`, `Result: REVISE`, or `Result: CONVERGED`.

## Architecture

```
.claude-plugin/plugin.json           <- Plugin manifest (v2.3.0)
hooks/hooks.json                     <- Hook registration (${CLAUDE_PLUGIN_ROOT})
scripts/
  claude-gates-shared.js             <- Core parsers (zero deps)
  claude-gates-db.js                 <- SQLite session state (optional)
  claude-gates-config.js             <- Project-level config loader
  claude-gates-conditions.js         <- PreToolUse:Agent — dependency check
  claude-gates-injection.js          <- SubagentStart — filepath injection
  claude-gates-verification.js       <- SubagentStop — two-layer verification
  plan-gate.js                       <- PreToolUse:ExitPlanMode — verdict-based plan gate
  commit-gate.js                     <- PreToolUse:Bash — pre-commit validation (opt-in)
  edit-gate.js                       <- PostToolUse:Edit|Write — file tracking + commit nudge
  loop-gate.js                       <- PreToolUse:Bash|Edit|Write — loop detection
  stop-gate.js                       <- Stop — configurable debug scan + commands
  claude-gates-test.js               <- Test suite (213 tests)
skills/claude-gates/SKILL.md         <- System-triggered skill
commands/verify.md                   <- /verify command
agents/gater.md                      <- Gater agent (stress-tester)
```

### Session State (Dual-Path)

| With `npm install` | Without |
|---|---|
| SQLite DB (`session.db`, WAL mode) | JSON files (`session_scopes.json`, `edits.log`, etc.) |
| Atomic transactions, no race conditions | Read-modify-write (race possible under concurrent hooks) |
| Auto-migrates existing JSON state | Default behavior, zero dependencies |

`better-sqlite3` is in `optionalDependencies` — native compilation failure doesn't break install.

### Project Configuration

Optional `claude-gates.json` at repo root:

```json
{
  "stop_gate": {
    "patterns": ["TODO", "HACK", "FIXME", "console.log"],
    "commands": ["dotnet build"],
    "mode": "warn"
  },
  "commit_gate": {
    "commands": ["npm test"],
    "enabled": true
  },
  "edit_gate": {
    "file_threshold": 10,
    "line_threshold": 200
  }
}
```

All fields optional — missing fields use defaults. No config file = built-in defaults.

## Testing

```bash
node scripts/claude-gates-test.js
# With better-sqlite3:    213 passed, 0 failed
# Without better-sqlite3: ~140 passed, 0 failed (SQLite tests skipped)
```

## License

MIT
