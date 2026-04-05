# gate_verdict Two-Parameter Model (verdict, check)

## Overview

The `gate_verdict` MCP tool accepts two verdict parameters that decompose decision-making into agent quality and outcome quality. This design allows verifiers to express "the agent made the right call, but their reasoning was sloppy" or vice versa.

## Parameter Definitions

### McpServer.ts (lines 29–78)

The tool schema defines:

```
verdict: z.enum(["PASS", "REVISE", "FAIL"])
  .describe("Verdict: what the reviewed agent decided")

check: z.enum(["PASS", "FAIL"])
  .optional()
  .describe("Quality check: your assessment of the agent's work (PASS = thorough, FAIL = sloppy/wrong)")
```

**verdict** — The outcome judgment: does the work pass, need revision, or fail entirely?  
**check** — The quality judgment: was the agent's reasoning process sound (PASS) or flawed/incomplete (FAIL)?

Both are stored in the `agents` table, keyed by `(scope, agent)`.

---

## Flow: `check` Through the System

### 1. MCP Tool → Database (McpServer.ts, line 78)

For pipeline scopes (not plan-gate), the tool calls:

```typescript
repo.setVerdict(scope, agent, verdict, activeStep.round, check);
```

The `check` parameter flows as the fifth argument.

### 2. PipelineRepository.setVerdict (lines 229–243)

The repository method conditionally updates the agents table:

```typescript
public setVerdict(scope: string, agent: string, verdict: string, round: number, check?: string): void
{
  if (check)
  {
    this._db.prepare(
      'UPDATE agents SET verdict = ?, "check" = ?, round = ? WHERE scope = ? AND agent = ?',
    ).run(verdict, check, round, scope, agent);
  }
  else
  {
    this._db.prepare(
      "UPDATE agents SET verdict = ?, round = ? WHERE scope = ? AND agent = ?",
    ).run(verdict, round, scope, agent);
  }
}
```

**Key detail:** The `check` column is double-quoted (`"check"`) because it's a SQL keyword. This persists to the `agents` table.

### 3. DB Schema (lines 35–44)

The agents table includes both verdict columns:

```sql
CREATE TABLE IF NOT EXISTS agents (
  scope          TEXT NOT NULL,
  agent          TEXT NOT NULL,
  outputFilepath TEXT,
  verdict        TEXT,
  "check"        TEXT,
  round          INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, agent)
);
```

And a schema-migration hook (lines 86–92) adds the column to existing databases:

```typescript
try
{
  db.exec('ALTER TABLE agents ADD COLUMN "check" TEXT');
}
catch
{
}
```

---

## Reading Back: qualityCheck in PipelineVerification.ts

### Semantic Check Parse (lines 220–251)

When the hook reads the MCP verdict from the database:

```typescript
const agentRow = checkRepo.getAgent(scope, agent);
if (agentRow && agentRow.verdict)
{
  const raw = agentRow.verdict.toUpperCase();
  const verdict = (raw === "PASS" || raw === "CONVERGED") ? "PASS" : "FAIL";
  const check = agentRow.check ? agentRow.check.toUpperCase() : null;
  process.stderr.write(`[ClaudeGates] MCP verdict from DB: ${verdict}, check=${check || "N/A"} (agent=${agent})\n`);
  return { verdict, check, reason: "via gate_verdict MCP", fullResponse: result };
}
```

The `check` column is extracted and normalized to uppercase; null if not provided.

### Usage: Source Agent Flow (lines 742–751)

After running a semantic check (implicit or explicit):

```typescript
let qualityCheck: string | null = null;
let semanticResult: { verdict: string; check: string | null; reason: string; fullResponse: string } | null = null;

if (activeStep && activeStep.step_type === StepType.Check && activeStep.prompt)
{
  semanticResult = runSemanticCheck(...);
  writeAudit(sessionDir, scope, agentType, artifactPath, semanticResult);
  qualityCheck = semanticResult?.check ?? semanticResult?.verdict ?? null;
  trace.span({ name: "semantic-check", input: { prompt: activeStep.prompt }, output: { verdict: qualityCheck } }).end();
}
```

**Precedence:** `check` (MCP param) preferred; falls back to legacy `verdict` (Result: line).

### Usage: Verifier Flow (lines 813–823)

For gate agents (verifiers), the quality check drives retry logic:

```typescript
const qualityCheck = semanticResult?.check ?? semanticResult?.verdict ?? null;
trace.span({ name: "semantic-check", input: { prompt: "implicit-verifier-check" }, output: { verdict: qualityCheck } }).end();

// If gater quality check says FAIL and reviewer didn't say REVISE → retry reviewer
if (qualityCheck === "FAIL" && artifactVerdict.toUpperCase().trim() !== "REVISE")
{
  const retryAction = pipelineEngine.retryGateAgent(scope);
  // ... log and return early
  return;
}
```

If `check === "FAIL"` (agent's reasoning was flawed) but `verdict === "PASS"` (the content is correct), the engine retries the gate agent rather than accepting the verdict.

---

## Summary

| Concept | Location | Detail |
|---------|----------|--------|
| **Parameter schema** | McpServer.ts:35 | `check?: "PASS" \| "FAIL"`, optional |
| **MCP call** | McpServer.ts:78 | `repo.setVerdict(scope, agent, verdict, round, check)` |
| **Database write** | PipelineRepository.ts:234 | `"UPDATE agents SET ... "check" = ?"` |
| **Table definition** | PipelineRepository.ts:40 | `"check" TEXT` (quoted, SQL keyword) |
| **Read + parse** | PipelineVerification.ts:237 | `agentRow.check?.toUpperCase() ?? null` |
| **Semantic precedence** | PipelineVerification.ts:750, 814 | `check ?? verdict ?? null` |
| **Verifier retry logic** | PipelineVerification.ts:823 | `qualityCheck === "FAIL"` triggers `retryGateAgent` |
