# agent-gate

Declarative pipeline gates for Claude Code. Define dependencies and quality checks in YAML — enforce them automatically.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-blueviolet)](https://code.claude.com/docs/en/plugins)
[![Tests: 68 passing](https://img.shields.io/badge/tests-68_passing-green)]()

```yaml
---
name: reviewer
requires: ["implementer", "cleaner"]
verification: |
  Evaluate whether this demonstrates genuine critical analysis.
  Reply EXACTLY on the last line: PASS or FAIL followed by your reason.
---
```

<p align="center">
  <img src="assets/demo.gif" alt="Demo: reviewer blocked until implementer completes, then allowed" width="800">
</p>

## Why

Multi-agent pipelines break in two ways: agents run out of order, or they produce garbage that looks like output. Guard logic scattered across prompts doesn't scale. agent-gate fixes both with two YAML fields.

## Features

- **`requires:`** — block agents until dependencies complete
- **`verification:`** — LLM-as-judge semantic quality check
- **Deterministic layer** — file exists, `Result:` line present
- **Semantic layer** — `claude -p` catches placeholder content
- **Fail-open** — bugs degrade to no gating, never to data loss
- **Zero dependencies** — Node.js stdlib only

## Install

```bash
claude plugin marketplace add kam-l/agent-gate
claude plugin install agent-gate
```

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
✓ implementer completes → writes task-1/implementer.md with Result: PASS
✗ reviewer spawns → conditions hook checks requires:
  → implementer.md exists? ✓ → ALLOW
  → reviewer finishes → verification hook runs claude -p
  → content is substantive? → PASS → done
```

If a `requires:` dependency is missing:

```
[AgentGate] Cannot spawn reviewer: missing implementer.md in task-1/.
Spawn implementer first.
```

## How It Works

Two enforcement layers, by design:

| Layer | Checks | Deterministic? |
|-------|--------|:---:|
| **Structural** | File exists, `Result:` line, `requires:` deps | Yes |
| **Semantic** | `claude -p` judges content quality | No |

Structural gates catch forgotten artifacts. Semantic gates catch lazy content that passes structural checks — like code review, but automated.

### The Three Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| `agent-gate-conditions.js` | PreToolUse:Agent | Check `requires:` before spawn |
| `agent-gate-injection.js` | SubagentStart | Inject `output_filepath` via `<agent_gate>` tag |
| `agent-gate-verification.js` | SubagentStop | Structural checks + semantic validation |

### Artifact Convention

```
~/.claude/sessions/{session_id}/{scope}/{agent_type}.md
```

Agents sharing a `scope` write to the same directory and can read each other's output. The scope directory is the pipeline ledger.

## Architecture

```
.claude-plugin/plugin.json        ← Plugin manifest
hooks/hooks.json                   ← Hook registration (${CLAUDE_PLUGIN_ROOT})
scripts/
├── agent-gate-shared.js           ← Core parsers (zero deps, framework-agnostic)
├── agent-gate-conditions.js       ← PreToolUse:Agent adapter
├── agent-gate-injection.js        ← SubagentStart adapter
├── agent-gate-verification.js     ← SubagentStop adapter
└── agent-gate-compat.js           ← Legacy gate: schema support
```

The shared module (`extractFrontmatter`, `parseRequires`, `parseVerification`, `findAgentMd`) imports only `fs` and `path`. Porting to another agent framework means writing new adapters against the same core.

## Testing

```bash
node scripts/agent-gate-test.js
# 43 passed, 0 failed
```

## License

MIT
