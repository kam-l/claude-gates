# Install Workflow

First-time setup. Walk through each gate, teach what it does, ask how to configure.

## Questions (sequential AskUserQuestion)

### Q1: Verification

> After an agent completes, the verification gate checks its output. Layer 1 (structural): artifact file exists with a `Result:` line. Layer 2 (semantic): a gater agent judges content quality against your `verification:` prompt. This catches agents that produce plausible-looking garbage.

Ask: "Do you use multi-agent pipelines?" Options:
- **Yes / planning to** — "Verification gates fire automatically on every subagent. No config needed."
- **Single-agent only** — "Verification only fires on subagents. Session gates (commit, edit, stop) still work."

### Q2: Gate chains

> Gate chains run sequential reviewers on an agent's output after verification passes. Example: implementer → reviewer → security-auditor. Each gate agent can PASS (advance), REVISE (send back for rewrite), or exhaust max rounds (fail chain).

Ask: "Create a sample two-agent pipeline in `.claude/agents/`?" Options:
- **Yes, create sample agents** — Create with commented frontmatter:
  ```yaml
  ---
  name: implementer
  verification:                              # ordered pipeline steps
    - ["Does this contain working code?"]    # SEMANTIC step
    - [reviewer, 3]                          # REVIEW step (3 rounds)
  ---
  ```
  Use language-appropriate verification prompts from detected stack.
- **Show YAML first** — Print frontmatter, then confirm.
- **Skip** — User writes their own.

### Q3: Commit gate

> Intercepts `git commit` and runs your commands first. Any failure blocks the commit. Disabled by default.

Detect test/lint commands from stack. Ask: "Commands to run before every commit?" Options:
- **{detected test command}** (if found)
- **{detected lint command}** (if found)
- **Both**
- **Skip** — leave disabled

### Q4: Edit gate

> Runs after every file edit. Tracks changed files (stop gate reads this for commit nudging) and optionally runs formatters — deduped per file, non-blocking.

Detect formatters:

| Stack | Command |
|-------|---------|
| Node/TS + prettier | `npx prettier --write {file}` |
| Python + ruff | `ruff format {file}` |
| Python + black | `black {file}` |
| Go | `gofmt -w {file}` |
| Rust | `rustfmt {file}` |
| .NET | `dotnet format --include {file}` |

Ask: "Auto-format on edit?" Options:
- **{detected formatter}**
- **Custom command**
- **No formatter** — file tracking still active

### Q5: Stop gate

> Scans edited files at session end for debug leftovers (`TODO`, `console.log`). Two modes: **warn** (stderr, never blocks) or **nudge** (blocks once to let you clean up).

Suggest language-appropriate patterns. Ask two questions:
1. "Which patterns?" — multiSelect with defaults for detected language
2. "Mode?" — **Warn** (default) / **Nudge**

### Q6: Conditions

> Runs BEFORE an agent spawns. Gater evaluates the spawn prompt against your `conditions:` field. Prevents agents from spawning in wrong context.

Ask: "Add conditions to any agents?" Options:
- **Show me how** — Print conditions example, explain pattern
- **Not now**

## Finalize

1. Show final `claude-gates.json` + any agent files.
2. AskUserQuestion: "Write these files?" — **Yes** / **Adjust** / **Cancel**
3. Write files, print summary:
   ```
   Created: claude-gates.json
   To test: spawn an agent with scope=test-1
   To reconfigure: /claude-gates:setup configure
   ```
