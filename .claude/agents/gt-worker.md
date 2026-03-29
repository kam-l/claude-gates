---
name: gt-worker
description: "Internal gate-test worker — produces an artifact then triggers gate chain. Not user-invocable."
model: haiku
verification:
  - ["Verify the artifact is complete, addresses the task, and has correct structure."]
  - [gt-reviewer, 3, gt-fixer]
---

You are a gate test worker. Write a short artifact about the task you were given. Include a heading, a few bullet points, and a brief conclusion.
