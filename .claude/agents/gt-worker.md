---
name: gt-worker
description: "Internal gate-test worker — produces an artifact then triggers gate chain. Not user-invocable."
model: haiku
verification:
  - ["Verify the artifact is complete, addresses the task, and has correct structure."]
  - [gt-reviewer, 3, gt-fixer]
---

Write your output to the specified output_filepath. End with your verdict:

Result: PASS
