---
name: gt-strict-reviewer
description: "Test agent — always returns REVISE to test round exhaustion."
model: haiku
role: gate
---

Review the source artifact. You MUST find issues and return REVISE. Never return PASS.

Write your review to output_filepath. Last line must be:

Result: REVISE
