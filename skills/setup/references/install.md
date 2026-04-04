# Install Workflow

First-time setup. Walk through each gate, teach what it does, ask how to configure.

## Questions (sequential AskUserQuestion)

### Q1: Verification

> After an agent completes, the verification gate checks its output. Layer 1 (structural): artifact file exists with a `Result:` line. Layer 2 (semantic): a gater agent judges content quality against your `verification:` prompt. This catches agents that produce plausible-looking garbage.

Ask: "Do you use multi-agent pipelines?" Options:
- **Yes / planning to** — "Verification gates fire automatically on every subagent. No config needed."
- **Single-agent only** — "Verification only fires on subagents. Plan gate still works."

### Q2: Gate chains

> Gate chains run sequential reviewers on an agent's output after verification passes. Example: implementer -> reviewer -> security-auditor. Each gate agent can PASS (advance), REVISE (send back for rewrite), or exhaust max rounds (fail chain).

Ask: "Create a sample two-agent pipeline in `.claude/agents/`?" Options:
- **Yes, create sample agents** — Create with commented frontmatter:
  ```yaml
  ---
  name: implementer
  verification:                              # ordered pipeline steps
    - ["Does this contain working code?"]    # CHECK step
    - [reviewer, 3]                          # VERIFY step (3 rounds)
  ---
  ```
  Use language-appropriate verification prompts from detected stack.
- **Show YAML first** — Print frontmatter, then confirm.
- **Skip** — User writes their own.

### Q3: Conditions

> Runs BEFORE an agent spawns. Gater evaluates the spawn prompt against your `conditions:` field. Prevents agents from spawning in wrong context.

Ask: "Add conditions to any agents?" Options:
- **Show me how** — Print conditions example, explain pattern
- **Not now**

### Q4: Plan gate

> Blocks ExitPlanMode until a gater reviews the plan. Auto-allows after 3 attempts (safety valve). No configuration needed — works automatically for plans over 20 lines.

Ask: "Plan gate is active by default. Any questions about how it works?" Options:
- **Explain more** — Walk through the plan-gate flow
- **Got it**

## Finalize

1. Show any agent files created.
2. AskUserQuestion: "Write these files?" — **Yes** / **Adjust** / **Cancel**
3. Write files, print summary:
   ```
   To test: spawn an agent with scope=test-1
   To reconfigure: /claude-gates:setup configure
   ```
