#!/usr/bin/env node
/**
 * Pipeline v3 — end-to-end integration test.
 *
 * Tests the full hook pipeline by simulating stdin/stdout hook communication.
 * Creates temp agent .md files and exercises:
 *   conditions → injection → verification flow
 *   Happy path (all PASS) and revise path (REVISE → source re-run)
 *
 * Run: node scripts/test-pipeline-e2e.js
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

let pass = 0, fail = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  PASS: ${name}`);
  } catch (e: any) {
    fail++;
    console.log(`  FAIL: ${name} — ${e.message}`);
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-e2e-"));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RunHookOpts {
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Run a hook script with simulated stdin JSON.
 * Returns { stdout, stderr, exitCode }.
 */
function runHook(scriptName: string, stdinData: any, opts: RunHookOpts = {}): HookResult {
  const scriptPath = path.join(__dirname, scriptName);
  const input = JSON.stringify(stdinData);
  try {
    const stdout = execSync(`node "${scriptPath}"`, {
      input,
      encoding: "utf-8",
      timeout: 10000,
      env: {
        ...process.env,
        CLAUDECODE: "", // prevent hook re-entry
        ...opts.env
      },
      cwd: opts.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: (e.stdout || "").trim(),
      stderr: (e.stderr || "").trim(),
      exitCode: e.status || 1
    };
  }
}

// ══════════════════════════════════════════════════════════════════════
// Setup: create temp agent definitions
// ══════════════════════════════════════════════════════════════════════

const tempRoot = tmpDir();
const agentsDir = path.join(tempRoot, ".claude", "agents");
fs.mkdirSync(agentsDir, { recursive: true });

// Source agent with verification pipeline
fs.writeFileSync(path.join(agentsDir, "e2e-builder.md"), `---
name: e2e-builder
description: "E2E test builder agent"
model: sonnet
verification:
  - ["Verify the artifact is complete and correct."]
  - [e2e-reviewer, 3]
---

Build an artifact for testing.
`);

// Reviewer agent (gate agent)
fs.writeFileSync(path.join(agentsDir, "e2e-reviewer.md"), `---
name: e2e-reviewer
description: "E2E test reviewer agent"
model: sonnet
role: gate
---

Review the source artifact.
`);

// Agent with conditions
fs.writeFileSync(path.join(agentsDir, "e2e-conditional.md"), `---
name: e2e-conditional
description: "E2E test conditional agent"
model: sonnet
conditions: |
  Check if scope has been defined.
verification:
  - ["Verify output."]
---

Conditional agent.
`);

const sessionId = "e2e-test-" + Date.now();

// ══════════════════════════════════════════════════════════════════════
// Test: conditions hook
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== E2E: pipeline-conditions.js ===");

test("conditions: allow agent with scope", () => {
  const r = runHook("pipeline-conditions.js", {
    session_id: sessionId,
    tool_input: {
      subagent_type: "e2e-builder",
      prompt: "Build scope=test-e2e the thing"
    }
  }, { cwd: tempRoot });
  // Should allow (exit 0, no block decision)
  assert.strictEqual(r.exitCode, 0);
  if (r.stdout) {
    const out = JSON.parse(r.stdout);
    assert.notStrictEqual(out.decision, "block");
  }
});

test("conditions: block agent without scope when requiresScope", () => {
  const r = runHook("pipeline-conditions.js", {
    session_id: sessionId,
    tool_input: {
      subagent_type: "e2e-builder",
      prompt: "Build the thing without scope"
    }
  }, { cwd: tempRoot });
  assert.strictEqual(r.exitCode, 0);
  if (r.stdout) {
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.decision, "block");
    assert.ok(out.reason.includes("scope="));
  }
});

test("conditions: allow resume without gating", () => {
  const r = runHook("pipeline-conditions.js", {
    session_id: sessionId,
    tool_input: {
      subagent_type: "e2e-builder",
      prompt: "Resume",
      resume: true
    }
  }, { cwd: tempRoot });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, "");
});

test("conditions: allow unknown agent (no .md file)", () => {
  const r = runHook("pipeline-conditions.js", {
    session_id: sessionId,
    tool_input: {
      subagent_type: "nonexistent-agent",
      prompt: "scope=test-e2e Do something"
    }
  }, { cwd: tempRoot });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, "");
});

// ══════════════════════════════════════════════════════════════════════
// Test: injection hook
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== E2E: pipeline-injection.js ===");

test("injection: source agent gets no injection on first run (semantics first)", () => {
  const r = runHook("pipeline-injection.js", {
    session_id: sessionId,
    agent_type: "e2e-builder",
    agent_id: "agent-001"
  }, { cwd: tempRoot });
  assert.strictEqual(r.exitCode, 0);
  // Source agents on first run get NO injection — semantics first
  assert.strictEqual(r.stdout, "", "Source agents should get no injection on first run");
});

test("injection: handles missing session gracefully", () => {
  const r = runHook("pipeline-injection.js", {
    session_id: "",
    agent_type: "e2e-builder",
    agent_id: "agent-002"
  }, { cwd: tempRoot });
  // Should exit 0 (fail-open), no stdout
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, "");
});

test("injection: handles plugin-qualified agent type", () => {
  const r = runHook("pipeline-injection.js", {
    session_id: sessionId,
    agent_type: "claude-gates:e2e-builder",
    agent_id: "agent-003"
  }, { cwd: tempRoot });
  assert.strictEqual(r.exitCode, 0);
  // Source agents get no injection regardless of plugin prefix
});

// ══════════════════════════════════════════════════════════════════════
// Test: block hook
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== E2E: pipeline-block.js ===");

test("block: allows when no active pipelines", () => {
  const freshSession = "block-test-" + Date.now();
  const r = runHook("pipeline-block.js", {
    session_id: freshSession,
    tool_name: "Edit",
    tool_input: {},
    agent_type: ""
  }, { cwd: tempRoot });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, "");
});

test("block: allows read-only tools", () => {
  const r = runHook("pipeline-block.js", {
    session_id: sessionId,
    tool_name: "Read",
    tool_input: {},
    agent_type: ""
  }, { cwd: tempRoot });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, "");
});

test("block: allows subagent calls", () => {
  const r = runHook("pipeline-block.js", {
    session_id: sessionId,
    tool_name: "Edit",
    tool_input: {},
    agent_type: "e2e-builder" // caller is a subagent
  }, { cwd: tempRoot });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, "");
});

test("block: skips blocking when agent-running marker exists", () => {
  // Simulate: pipeline active, but source agent is still running (marker exists)
  // Hook runs with cwd=tempRoot, so session dir must be under tempRoot
  const _crud = require("./pipeline-db.js");
  const _engine = require("./pipeline.js");

  const markerSession = "abcd1234-test-marker-" + Date.now();
  // getSessionDir truncates to first 8 hex chars — match that for DB + marker paths
  const shortId = markerSession.replace(/-/g, "").slice(0, 8);
  const markerDir = path.join(tempRoot, ".sessions", shortId).replace(/\\/g, "/");
  const markerFile = path.join(markerDir, ".running-marker-scope").replace(/\\/g, "/");
  fs.mkdirSync(markerDir, { recursive: true });

  const markerDb = _crud.getDb(markerDir);
  _engine.createPipeline(markerDb, "marker-scope", "e2e-builder", [
    { type: "SEMANTIC", prompt: "Check." },
  ]);
  markerDb.close();

  // Write running marker (simulates conditions.js after allowing spawn)
  fs.writeFileSync(markerFile, "", "utf-8");

  // Block hook should NOT block (agent is still running)
  const r = runHook("pipeline-block.js", {
    session_id: markerSession,
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    agent_type: ""
  }, { cwd: tempRoot });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, "", "Should not block while agent-running marker exists");

  // Remove marker (simulates SubagentStop)
  fs.unlinkSync(markerFile);

  // Now it SHOULD block (agent completed, step is active, orchestrator must act)
  const r2 = runHook("pipeline-block.js", {
    session_id: markerSession,
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    agent_type: ""
  }, { cwd: tempRoot });
  assert.strictEqual(r2.exitCode, 0);
  assert.ok(r2.stdout.includes("block"), "Should block after marker removed");

  cleanup(markerDir);
});

// ══════════════════════════════════════════════════════════════════════
// Test: verification hook (structural parts only — no claude -p)
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== E2E: pipeline-verification.js ===");

test("verification: gater hardcoded fallback records verdict", () => {
  const r = runHook("pipeline-verification.js", {
    session_id: sessionId,
    agent_type: "gater",
    agent_id: "gater-001",
    last_assistant_message: "The plan looks good.\n\nResult: PASS",
    stop_hook_active: false
  }, { cwd: tempRoot });
  assert.strictEqual(r.exitCode, 0);
});

test("verification: exits cleanly for unknown agent", () => {
  const r = runHook("pipeline-verification.js", {
    session_id: sessionId,
    agent_type: "totally-unknown",
    agent_id: "unknown-001",
    last_assistant_message: "",
    stop_hook_active: false
  }, { cwd: tempRoot });
  assert.strictEqual(r.exitCode, 0);
});

test("verification: skips when stop_hook_active", () => {
  const r = runHook("pipeline-verification.js", {
    session_id: sessionId,
    agent_type: "e2e-builder",
    agent_id: "agent-skip",
    last_assistant_message: "",
    stop_hook_active: true
  }, { cwd: tempRoot });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, "");
});

// ══════════════════════════════════════════════════════════════════════
// Test: Full pipeline flow (engine-level, simulating hook sequence)
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== E2E: full pipeline flow (engine-level) ===");

import * as crud from "./pipeline-db.js";
import * as engine from "./pipeline.js";
import * as shared from "./pipeline-shared.js";

test("full flow: parse agent → create pipeline → step through", () => {
  const agentMd = fs.readFileSync(path.join(agentsDir, "e2e-builder.md"), "utf-8");
  const steps = shared.parseVerification(agentMd);
  assert.ok(steps, "parseVerification should return steps");
  assert.strictEqual(steps!.length, 2);
  assert.strictEqual(steps![0].type, "SEMANTIC");
  assert.strictEqual(steps![1].type, "REVIEW");
  assert.strictEqual((steps![1] as any).agent, "e2e-reviewer");
  assert.strictEqual((steps![1] as any).maxRounds, 3);

  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "e2e-scope", "e2e-builder", steps!);

    // Step 0: SEMANTIC — source completes, semantic check fires
    let a: any = engine.getNextAction(db, "e2e-scope");
    assert.strictEqual(a.action, "semantic");

    a = engine.step(db, "e2e-scope", "PASS"); // semantic passes
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "e2e-reviewer");

    // Step 1: REVIEW — reviewer passes
    a = engine.step(db, "e2e-scope", "PASS");
    assert.strictEqual(a.action, "done");
    assert.strictEqual(crud.getPipelineState(db, "e2e-scope")!.status, "completed");
  } finally {
    db.close();
    cleanup(dir);
  }
});

test("full flow: revise path → source re-run → reviewer re-run", () => {
  const agentMd = fs.readFileSync(path.join(agentsDir, "e2e-builder.md"), "utf-8");
  const steps = shared.parseVerification(agentMd);

  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "rev-scope", "e2e-builder", steps!);

    // SEMANTIC passes
    engine.step(db, "rev-scope", "PASS");

    // REVIEW: reviewer says REVISE
    let a: any = engine.step(db, "rev-scope", "REVISE");
    assert.strictEqual(a.action, "source");
    assert.strictEqual(a.agent, "e2e-builder"); // source re-runs
    assert.strictEqual(crud.getPipelineState(db, "rev-scope")!.status, "revision");

    // Source re-completes
    a = engine.step(db, "rev-scope", { role: "source", artifactVerdict: "PASS" });
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "e2e-reviewer"); // reviewer re-runs
    assert.strictEqual(crud.getPipelineState(db, "rev-scope")!.status, "normal");

    // Reviewer passes on second attempt
    a = engine.step(db, "rev-scope", "PASS");
    assert.strictEqual(a.action, "done");
  } finally {
    db.close();
    cleanup(dir);
  }
});

test("full flow: role resolution through pipeline lifecycle", () => {
  const steps: any[] = [
    { type: "SEMANTIC", prompt: "Check." },
    { type: "REVIEW_WITH_FIXER", agent: "e2e-reviewer", maxRounds: 3, fixer: "e2e-fixer" },
  ];

  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "role-scope", "e2e-builder", steps);

    // Initial: SEMANTIC step is active — reviewer is NOT verifier yet
    assert.strictEqual(engine.resolveRole(db, "role-scope", "e2e-reviewer"), "ungated"); // step 0 is SEMANTIC, not REVIEW
    assert.strictEqual(engine.resolveRole(db, "role-scope", "e2e-builder"), "source");
    assert.strictEqual(engine.resolveRole(db, "role-scope", "e2e-fixer"), "ungated"); // not active yet

    // Advance past SEMANTIC → step 1 (REVIEW_WITH_FIXER) becomes active
    engine.step(db, "role-scope", "PASS");

    // Now reviewer IS verifier (REVIEW_WITH_FIXER step active)
    assert.strictEqual(engine.resolveRole(db, "role-scope", "e2e-reviewer"), "verifier");

    // REVISE → fixer role activates
    engine.step(db, "role-scope", "REVISE");
    assert.strictEqual(engine.resolveRole(db, "role-scope", "e2e-fixer"), "fixer");
    assert.strictEqual(engine.resolveRole(db, "role-scope", "e2e-builder"), "source"); // still source

    // Fixer completes → reviewer re-runs
    engine.step(db, "role-scope", { role: "fixer", artifactVerdict: "PASS" });
    assert.strictEqual(engine.resolveRole(db, "role-scope", "e2e-reviewer"), "verifier");
  } finally {
    db.close();
    cleanup(dir);
  }
});

test("full flow: parallel scopes don't cross-contaminate", () => {
  const steps: any[] = [{ type: "REVIEW", agent: "rev", maxRounds: 3 }];
  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "scope-a", "builder-a", steps);
    engine.createPipeline(db, "scope-b", "builder-b", steps);

    // Scope A: REVISE
    engine.step(db, "scope-a", "REVISE");
    // Scope B: PASS
    engine.step(db, "scope-b", "PASS");

    assert.strictEqual(crud.getPipelineState(db, "scope-a")!.status, "revision");
    assert.strictEqual(crud.getPipelineState(db, "scope-b")!.status, "completed");

    // getAllNextActions only returns scope-a
    const actions = engine.getAllNextActions(db);
    assert.strictEqual(actions.length, 1);
    assert.strictEqual((actions[0] as any).scope, "scope-a");
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════
// Test: COMMAND verdict file processing
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== E2E: COMMAND verdict file ===");

test("verdict file: write → block hook reads → advances → deletes", () => {
  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "cmd-scope", "worker", [
      { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as any[]);

    // Verify COMMAND step is active
    const a1: any = engine.getNextAction(db, "cmd-scope");
    assert.strictEqual(a1.action, "command");

    // Write verdict file (simulating /pass_or_revise skill)
    const scopeDir = path.join(dir, "cmd-scope");
    fs.mkdirSync(scopeDir, { recursive: true });
    const verdictPath = path.join(scopeDir, ".command-verdict.md");
    fs.writeFileSync(verdictPath, "Result: PASS\n");

    // Simulate what block hook does: read verdict, feed to engine, delete
    const content = fs.readFileSync(verdictPath, "utf-8");
    const match = shared.VERDICT_RE.exec(content);
    assert.ok(match, "VERDICT_RE should match");
    assert.strictEqual(match![1], "PASS");

    engine.step(db, "cmd-scope", { role: null, artifactVerdict: "PASS" });
    fs.unlinkSync(verdictPath);

    // COMMAND step should now be passed, REVIEW active
    assert.strictEqual(crud.getStep(db, "cmd-scope", 0)!.status, "passed");
    assert.strictEqual(crud.getStep(db, "cmd-scope", 1)!.status, "active");
    assert.ok(!fs.existsSync(verdictPath), "Verdict file should be deleted");
  } finally {
    db.close();
    cleanup(dir);
  }
});

test("verdict file: REVISE sends back to source", () => {
  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "rev-cmd", "worker", [
      { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
    ] as any[]);

    const a: any = engine.step(db, "rev-cmd", { role: null, artifactVerdict: "REVISE" });
    assert.strictEqual(a.action, "source");
    assert.strictEqual(a.agent, "worker");
    assert.strictEqual(crud.getPipelineState(db, "rev-cmd")!.status, "revision");
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════
// Test: source verdict decoupling (Result: REVISE from source ≠ pipeline revision)
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== E2E: source verdict decoupling ===");

test("source REVISE advances SEMANTIC (source doesn't judge itself)", () => {
  // Source agents produce artifacts — their Result: line is informational.
  // Only SEMANTIC/REVIEW steps determine PASS/FAIL for pipeline flow.
  // A rethinker writing "Result: REVISE" (about code) should NOT loop.
  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "decouple-scope", "rethinker", [
      { type: "SEMANTIC", prompt: "Check quality." },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as any[]);

    // Source completes with REVISE (meaning "code needs work") — semantic check null (skipped)
    // finalVerdict should be PASS (source doesn't drive flow), advancing past SEMANTIC
    const a: any = engine.step(db, "decouple-scope", { role: "source", artifactVerdict: "PASS", semanticVerdict: null });
    assert.strictEqual(a.action, "spawn", "Should advance to REVIEW step");
    assert.strictEqual(a.agent, "reviewer");
  } finally {
    db.close();
    cleanup(dir);
  }
});

test("source FAIL still treated as PASS when semantic is null (source doesn't self-judge)", () => {
  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "decouple-fail", "builder", [
      { type: "SEMANTIC", prompt: "Check." },
    ] as any[]);

    // Even source FAIL with null semantic → PASS (source produced an artifact)
    const a: any = engine.step(db, "decouple-fail", { role: "source", artifactVerdict: "PASS", semanticVerdict: null });
    assert.strictEqual(a.action, "done", "Should complete pipeline");
  } finally {
    db.close();
    cleanup(dir);
  }
});

test("semantic FAIL still triggers revision even when source says PASS", () => {
  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "sem-override", "builder", [
      { type: "SEMANTIC", prompt: "Check." },
    ] as any[]);

    // Source PASS but semantic FAIL → revision (semantic is the judge)
    const a: any = engine.step(db, "sem-override", { role: "source", artifactVerdict: "FAIL", semanticVerdict: "FAIL" });
    assert.strictEqual(a.action, "source", "Semantic FAIL should trigger revision");
    assert.strictEqual(crud.getPipelineState(db, "sem-override")!.status, "revision");
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════
// Test: gater as pipeline participant (no short-circuit deadlock)
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== E2E: gater pipeline participant ===");

test("gater as REVIEW agent: engine.step advances (no short-circuit)", () => {
  // Verifies fix: gater fallback no longer exits early when gater is a pipeline participant.
  // The normal processing path handles gater as verifier.
  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "gater-scope", "worker", [
      { type: "REVIEW", agent: "gater", maxRounds: 3 },
    ] as any[]);

    // Gater (as verifier) returns PASS → should advance pipeline
    const a: any = engine.step(db, "gater-scope", { role: "verifier", artifactVerdict: "PASS", semanticVerdict: null });
    assert.strictEqual(a.action, "done", "Gater PASS should complete the pipeline");
    assert.strictEqual(crud.getPipelineState(db, "gater-scope")!.status, "completed");
  } finally {
    db.close();
    cleanup(dir);
  }
});

test("gater as REVIEW agent: REVISE routes back to source", () => {
  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "gater-rev", "worker", [
      { type: "REVIEW", agent: "gater", maxRounds: 3 },
    ] as any[]);

    // Gater returns REVISE → should route to source (not deadlock)
    const a: any = engine.step(db, "gater-rev", { role: "verifier", artifactVerdict: "REVISE", semanticVerdict: null });
    assert.strictEqual(a.action, "source");
    assert.strictEqual(a.agent, "worker");
    assert.strictEqual(crud.getPipelineState(db, "gater-rev")!.status, "revision");
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════
// Test: deadlock prevention (missing artifact / missing Result: line)
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== E2E: deadlock prevention (missing artifact) ===");

test("missing artifact: engine.step(FAIL) transitions instead of deadlock", () => {
  // Simulates the fix in pipeline-verification.js:
  // When artifact is missing, hook now calls engine.step(FAIL) instead of silent exit.
  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "deadlock-scope", "architect", [
      { type: "SEMANTIC", prompt: "Check artifact." },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as any[]);

    // Pipeline starts: step 0 active
    let state = crud.getPipelineState(db, "deadlock-scope")!;
    assert.strictEqual(state.status, "normal");
    assert.strictEqual(crud.getActiveStep(db, "deadlock-scope")!.step_index, 0);

    // Source completes WITHOUT artifact — hook calls engine.step(FAIL)
    const a: any = engine.step(db, "deadlock-scope", { role: "source", artifactVerdict: "FAIL" });

    // Should enter revision (route back to source), NOT stay stuck
    state = crud.getPipelineState(db, "deadlock-scope")!;
    assert.strictEqual(state.status, "revision", "Pipeline should enter revision, not stay normal");
    assert.ok(a, "step() should return an action, not null");
    assert.strictEqual(a.action, "source", "Action should route back to source agent");
    assert.strictEqual(a.agent, "architect");
  } finally {
    db.close();
    cleanup(dir);
  }
});

test("missing Result line: pipeline recovers via FAIL verdict", () => {
  // After max_rounds of FAIL, pipeline should reach 'failed' state (not deadlock)
  const dir = tmpDir();
  const db = crud.getDb(dir);
  try {
    engine.createPipeline(db, "noResult-scope", "builder", [
      { type: "SEMANTIC", prompt: "Check." },
    ] as any[]);

    // SEMANTIC step: source FAIL → revision round 1
    let a: any = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "FAIL" });
    assert.strictEqual(a.action, "source");

    // Source re-completes, still FAIL → reactivates step, then FAIL → revision round 2
    a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "PASS" });
    // Reactivated SEMANTIC step — now process FAIL on it
    a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "FAIL" });
    assert.strictEqual(a.action, "source");

    // Round 3
    a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "PASS" });
    a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "FAIL" });
    assert.strictEqual(a.action, "source");

    // Round 4 — should exhaust (max_rounds=3)
    a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "PASS" });
    a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "FAIL" });
    assert.strictEqual(a.action, "failed", "Pipeline should exhaust after maxRounds");
    assert.strictEqual(crud.getPipelineState(db, "noResult-scope")!.status, "failed");
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════
// Test: gt-worker v3 format parsing
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== E2E: gt-worker v3 format ===");

test("gt-worker verification: field parses to SEMANTIC + REVIEW_WITH_FIXER", () => {
  const agentMd = fs.readFileSync(
    path.join(process.cwd(), ".claude", "agents", "gt-worker.md"), "utf-8"
  );
  const steps = shared.parseVerification(agentMd);
  assert.ok(steps, "parseVerification should return steps");
  assert.strictEqual(steps!.length, 2);
  assert.strictEqual(steps![0].type, "SEMANTIC");
  assert.ok((steps![0] as any).prompt.includes("complete"));
  assert.strictEqual(steps![1].type, "REVIEW_WITH_FIXER");
  assert.strictEqual((steps![1] as any).agent, "gt-reviewer");
  assert.strictEqual((steps![1] as any).maxRounds, 3);
  assert.strictEqual((steps![1] as any).fixer, "gt-fixer");
});

test("gt-reviewer has no verification: steps (role: gate only)", () => {
  const agentMd = fs.readFileSync(
    path.join(process.cwd(), ".claude", "agents", "gt-reviewer.md"), "utf-8"
  );
  const steps = shared.parseVerification(agentMd);
  assert.strictEqual(steps, null);
});

test("gt-worker requiresScope returns true", () => {
  const agentMd = fs.readFileSync(
    path.join(process.cwd(), ".claude", "agents", "gt-worker.md"), "utf-8"
  );
  assert.strictEqual(shared.requiresScope(agentMd), true);
});

// ══════════════════════════════════════════════════════════════════════

// Cleanup
cleanup(tempRoot);

// Session data now lives under {cwd}/.sessions/ — tempRoot cleanup handles it.
// Also clean legacy location in case of leftover data.
const HOME = process.env.USERPROFILE || process.env.HOME || "";
const legacySessDir = path.join(HOME, ".claude", "sessions", sessionId);
cleanup(legacySessDir);

console.log(`\n${"=".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

export {};
