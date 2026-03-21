---
name: gt-worker
description: Gate-test worker. Produces an artifact then triggers gate chain.
gates:
  - [gt-reviewer, 3, gt-fixer]
---

Write your output to the specified output_filepath. End with:

Result: PASS
