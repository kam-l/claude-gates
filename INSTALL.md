# Install claude-gates

Instructions for Claude Code agents to install this plugin automatically.

## From Marketplace

```bash
claude plugin marketplace add kam-l/claude-gates
claude plugin install claude-gates
```

## From Source

```bash
git clone https://github.com/kam-l/claude-gates.git
claude --plugin-dir ./claude-gates
```

## Post-Install

Run `/claude-gates:setup` to:

1. Install `better-sqlite3` (required native dependency)
2. Detect your project stack
3. Walk through each gate interactively
4. Create sample agent definitions in `.claude/agents/`

## Verify

```bash
claude plugin validate claude-gates
```

## Environment Variables (optional)

| Variable | Purpose |
|----------|---------|
| `LANGFUSE_PUBLIC_KEY` | Enable Langfuse tracing |
| `LANGFUSE_SECRET_KEY` | Enable Langfuse tracing |
| `LANGFUSE_BASE_URL` | Custom Langfuse host (default: cloud) |

## Requirements

- Claude Code CLI
- Node.js (for `better-sqlite3` native compilation)
