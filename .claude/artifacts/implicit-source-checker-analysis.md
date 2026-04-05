# Implicit Source Checker Analysis

## Overview

The `implicitSourceCheck` function is a lightweight, non-gating structural validator that runs on all source agent artifacts in the pipeline verification flow. It performs basic heuristic checks **before** semantic validation, operating independently from the gate agent system.

## What It Validates

The function performs three sequential checks on artifact content (lines 348–364):

1. **Non-empty content** (line 350)
   - Rejects if content is empty or whitespace-only
   - Returns: "Artifact is empty: {filename}"

2. **Minimum substantive length** (line 354)
   - Requires at least 50 characters of trimmed content
   - Returns: "Artifact is trivially short ({length} chars): {filename}"

3. **Structural presence** (line 359)
   - Validates regex `/^[#\-*+\d]/m` — at least one line starting with:
     - `#` (heading)
     - `-`, `*`, `+` (bullet points)
     - `\d` (numbered list)
   - Returns: "Artifact lacks structure (no headings, bullets, or lists): {filename}"

## When It Runs

The implicit check executes at line 729, **immediately after artifact resolution**, before any semantic CHECK step validation. It triggers unconditionally for all source agents in `onSubagentStop()` (the SubagentStop hook handler).

## What Happens on Failure

On failure, the flow (lines 730–738):

1. **Notify**: Sends a user-facing message via `Messaging.notify()` (line 732)
2. **Audit trace**: Records failure in audit.jsonl (line 733)
3. **Verdict record**: Marks verdict as "FAIL" in the database (line 734)
4. **Engine step**: Calls `pipelineEngine.step()` with `artifactVerdict: "FAIL"` to drive state transition to fixer or retry (line 735)
5. **Langfuse span**: Logs the failure event with reason (line 737)
6. **Early exit**: Returns immediately, skipping semantic CHECK and downstream verification (line 738)

## Key Design Notes

- **Not a gater**: Runs entirely without spawning a gate agent or calling MCP `gate_verdict` (comment at line 346)
- **Pre-semantic**: Fails fast before expensive semantic validation, preventing wasted token budget
- **Deterministic**: Pure structural checks with no model dependency
- **Fail-forward**: FAIL verdict routes to fixer or source retry, same as semantic check failures (line 735)

## Code References

- Function definition: `/c/Projects/agent-gate/src/PipelineVerification.ts` lines 348–364
- Invocation site: lines 729–738
- Handler context: `onSubagentStop()` at line 368
