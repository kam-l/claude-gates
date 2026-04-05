# implicitSourceCheck Function Analysis

## Overview
The `implicitSourceCheck` function (lines 348–364 in `PipelineVerification.ts`) is a lightweight heuristic validator that runs before semantic checks. It performs basic structural validation on source agent artifacts without invoking the gater MCP tool.

## What It Validates

The function checks three structural requirements on the artifact content:

1. **Non-empty content** — Artifact must exist and not be blank
2. **Non-trivial length** — Content must exceed 50 characters
3. **Structural presence** — Content must contain markdown structure: headings (`#`), bullets (`-/**/+`), or numbered lists (`\d`)

Returns `null` if all checks pass; otherwise returns a descriptive failure reason string.

---

## Three Failure Modes

### 1. Empty Artifact (Line 350–352)
```typescript
if (!content || content.trim().length === 0)
{
  return `Artifact is empty: ${path.basename(artifactPath,)}`;
}
```
**Triggers when:** Content is null, undefined, or whitespace-only.
**Example reason:** `"Artifact is empty: gt-reviewer.md"`

### 2. Trivially Short Artifact (Line 354–356)
```typescript
if (content.trim().length < 50)
{
  return `Artifact is trivially short (${content.trim().length} chars): ${path.basename(artifactPath,)}`;
}
```
**Triggers when:** Content length is less than 50 characters after trimming.
**Example reason:** `"Artifact is trivially short (23 chars): gt-reviewer.md"`

### 3. Missing Structure (Line 358–362)
```typescript
// Must have some structure: heading (#), bullet (-/*/+), or numbered list
if (!/^[#\-*+\d]/m.test(content,))
{
  return `Artifact lacks structure (no headings, bullets, or lists): ${path.basename(artifactPath,)}`;
}
```
**Triggers when:** Content has no line starting with markdown structure tokens.
**Example reason:** `"Artifact lacks structure (no headings, bullets, or lists): gt-reviewer.md"`

---

## Pipeline State Machine Integration on Failure

### Failure Path (Lines 730–739)

When `implicitSourceCheck` returns a non-null failure reason:

1. **Notification** (Line 732): User is notified via `Messaging.notify()` with the failure reason
2. **Tracing** (Line 733): Event is logged as `"implicit-check.fail"` with agent and reason
3. **Verdict Recording** (Line 734): The verdict `"FAIL"` is recorded in the database via `recordVerdict()`
4. **Engine Step Transition** (Line 735):
   ```typescript
   const failAction = pipelineEngine.step(scope, { role: "source", artifactVerdict: "FAIL", },);
   ```
   - Calls `PipelineEngine.step()` with role `"source"` and verdict `"FAIL"`
   - The engine's `normalizeVerdict()` (line 206–208 of `PipelineEngine.ts`) treats `FAIL` as `Verdict.Revise`
   - Transitions pipeline to **Revision** state, blocking further progress until fixer addresses the issue
5. **Action Logging** (Line 736): The resulting action is logged for audit

### State Machine Transition
- **Input:** `artifactVerdict: "FAIL"` (from implicit check)
- **Normalized to:** `Verdict.Revise` (line 206 of `PipelineEngine.ts`)
- **Result:** Pipeline enters **Revision** state; step becomes inactive
- **Next role:** Requires a fixer agent to reactivate and repair the artifact

---

## Design Notes

- **Not a gater call:** The function is a structural heuristic, not a semantic check (line 344–346 comment)
- **Pre-semantic:** Runs before the `runSemanticCheck()` call, preventing expensive semantic analysis on malformed artifacts
- **Fail-secure:** Empty/trivial artifacts block the pipeline immediately rather than proceeding to expensive verification steps
