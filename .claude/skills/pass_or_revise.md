---
description: "Record PASS or REVISE verdict for a pipeline COMMAND step. Use after completing the command action (e.g., /question) shown in a pipeline block message."
user-invocable: true
---

# /pass_or_revise

Record your verdict for the active COMMAND step in the pipeline.

## When to use

After you see a pipeline block message like:
```
[Pipeline] COMMAND `/question` (scope=my-scope) — Run /question, then /pass_or_revise. Write verdict to: /path/to/.command-verdict.md
```

Run the command (e.g., `/question`), interact with the user, then invoke `/pass_or_revise` to record your decision.

## What to do

1. **Find the verdict path** from the most recent pipeline block message. It's the path after "Write verdict to:".

2. **Decide** based on the interaction result:
   - **PASS** — The step succeeded, continue to the next pipeline step
   - **REVISE** — The source agent must re-do its work

3. **Write the verdict file** using the Write tool:
   - Path: the exact path from the block message
   - Content: exactly `Result: PASS` or `Result: REVISE` (nothing else)

4. The pipeline will automatically advance on your next action (the block hook reads the verdict file).

## Example

If the block message said `Write verdict to: /home/user/.claude/sessions/abc123/my-scope/.command-verdict.md`:
```
Write to: /home/user/.claude/sessions/abc123/my-scope/.command-verdict.md
Content: Result: PASS
```
