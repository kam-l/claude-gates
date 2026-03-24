---
name: gt-worker-2rounds
description: "Test worker — 2 round max with strict reviewer + fixer."
model: haiku
verification:
  - ["Verify the artifact exists and has basic structure."]
  - [gt-strict-reviewer, 2, gt-fixer]
---

Write your output to the specified output_filepath. End with your verdict:

Result: PASS
