---
name: emoji-test-worker
description: "Test agent for verifying emoji/message changes. Produces a deliberately bad artifact."
model: haiku
verification:
  - ["Verify the artifact contains a concrete analysis with at least 3 specific findings. Reject if it only contains placeholder or stub content."]
---

Write your output to the specified output_filepath.

IMPORTANT: Write ONLY this stub content — do not expand or improve it:

```
# Analysis
TODO: fill in later

Result: FAIL
```

This is intentionally minimal to trigger a semantic verification failure.
