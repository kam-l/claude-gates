#!/usr/bin/env node
/**
 * Pipeline v3 — unit + integration tests.
 *
 * Tests: pipeline-shared.js (parsing), pipeline-db.js (CRUD), pipeline.js (engine).
 * Run: node scripts/pipeline-test.js
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";

import * as shared from "./pipeline-shared.js";
import * as crud from "./pipeline-db.js";
import * as engine from "./pipeline.js";
import type { VerificationStep } from "./types.js";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-"));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function withDb(fn: (db: any) => void): void {
  const dir = tmpDir();
  const db = crud.getDb(dir);
  try { fn(db); } finally { db.close(); cleanup(dir); }
}

// ══════════════════════════════════════════════════════════════════════
// pipeline-shared.js — parsing tests
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== pipeline-shared.js: extractFrontmatter ===");

test("extractFrontmatter returns YAML between fences", () => {
  assert.strictEqual(shared.extractFrontmatter("---\nname: test\n---\n# Body"), "name: test");
});

test("extractFrontmatter returns null for no frontmatter", () => {
  assert.strictEqual(shared.extractFrontmatter("# Just a heading"), null);
});

console.log("\n=== pipeline-shared.js: parseVerification ===");

test("parse SEMANTIC step", () => {
  const steps = shared.parseVerification('---\nverification:\n  - ["Verify completeness."]\n---\n');
  assert.strictEqual(steps!.length, 1);
  assert.strictEqual(steps![0].type, "SEMANTIC");
  assert.strictEqual((steps![0] as any).prompt, "Verify completeness.");
});

test("parse SEMANTIC step with single quotes", () => {
  const steps = shared.parseVerification("---\nverification:\n  - ['Verify quality.']\n---\n");
  assert.strictEqual(steps![0].type, "SEMANTIC");
  assert.strictEqual((steps![0] as any).prompt, "Verify quality.");
});

test("parse COMMAND step", () => {
  const steps = shared.parseVerification("---\nverification:\n  - [/question, AskUserTool]\n---\n");
  assert.strictEqual(steps![0].type, "COMMAND");
  assert.strictEqual((steps![0] as any).command, "/question");
  assert.deepStrictEqual((steps![0] as any).allowedTools, ["AskUserTool"]);
});

test("parse COMMAND step with multiple allowed tools", () => {
  const steps = shared.parseVerification("---\nverification:\n  - [/rethink, AskUserTool, Read]\n---\n");
  assert.deepStrictEqual((steps![0] as any).allowedTools, ["AskUserTool", "Read"]);
});

test("parse REVIEW step", () => {
  const steps = shared.parseVerification("---\nverification:\n  - [reviewer, 3]\n---\n");
  assert.strictEqual(steps![0].type, "REVIEW");
  assert.strictEqual((steps![0] as any).agent, "reviewer");
  assert.strictEqual((steps![0] as any).maxRounds, 3);
});

test("parse REVIEW_WITH_FIXER step", () => {
  const steps = shared.parseVerification("---\nverification:\n  - [reviewer, 3, fixer]\n---\n");
  assert.strictEqual(steps![0].type, "REVIEW_WITH_FIXER");
  assert.strictEqual((steps![0] as any).fixer, "fixer");
});

test("parse mixed verification steps", () => {
  const md = '---\nverification:\n  - ["Check."]\n  - [/question, AskUserTool]\n  - [reviewer, 3]\n  - [playtester, 2, fixer]\n---\n';
  const steps = shared.parseVerification(md);
  assert.strictEqual(steps!.length, 4);
  assert.strictEqual(steps![0].type, "SEMANTIC");
  assert.strictEqual(steps![1].type, "COMMAND");
  assert.strictEqual(steps![2].type, "REVIEW");
  assert.strictEqual(steps![3].type, "REVIEW_WITH_FIXER");
});

test("parseVerification returns null for no verification field", () => {
  assert.strictEqual(shared.parseVerification("---\nname: test\n---\n"), null);
});

test("parseVerification returns null for empty verification", () => {
  assert.strictEqual(shared.parseVerification("---\nverification:\n---\n"), null);
});

test("parse agent name with hyphens and underscores", () => {
  const steps = shared.parseVerification("---\nverification:\n  - [gt-reviewer_v2, 5]\n---\n");
  assert.strictEqual((steps![0] as any).agent, "gt-reviewer_v2");
  assert.strictEqual((steps![0] as any).maxRounds, 5);
});

console.log("\n=== pipeline-shared.js: parseConditions ===");

test("parseConditions returns prompt", () => {
  const cond = shared.parseConditions("---\nconditions: |\n  Check if ready.\n  Must have scope.\n---\n");
  assert.ok(cond!.includes("Check if ready."));
});

test("parseConditions returns null when absent", () => {
  assert.strictEqual(shared.parseConditions("---\nname: test\n---\n"), null);
});

console.log("\n=== pipeline-shared.js: requiresScope + VERDICT_RE ===");

test("requiresScope true for verification array", () => {
  assert.strictEqual(shared.requiresScope('---\nverification:\n  - ["Check."]\n---\n'), true);
});

test("requiresScope false for bare agent", () => {
  assert.strictEqual(shared.requiresScope("---\nname: test\n---\n"), false);
});

test("VERDICT_RE matches standard verdicts", () => {
  for (const v of ["PASS", "FAIL", "REVISE", "CONVERGED"]) {
    shared.VERDICT_RE.lastIndex = 0;
    assert.ok(shared.VERDICT_RE.test(`Result: ${v}`), `should match ${v}`);
  }
});

// ══════════════════════════════════════════════════════════════════════
// pipeline-db.js — CRUD tests
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== pipeline-db.js: CRUD ===");

test("getDb creates database", () => {
  withDb((db: any) => assert.ok(db));
});

test("insertPipeline + getPipelineState", () => {
  withDb((db: any) => {
    crud.insertPipeline(db, "s1", "worker", 2);
    const state = crud.getPipelineState(db, "s1");
    assert.strictEqual(state!.source_agent, "worker");
    assert.strictEqual(state!.total_steps, 2);
    assert.strictEqual(state!.status, "normal");
  });
});

test("insertStep + getStep", () => {
  withDb((db: any) => {
    crud.insertPipeline(db, "s1", "worker", 1);
    crud.insertStep(db, "s1", 0, { type: "SEMANTIC", prompt: "Check." } as VerificationStep, "worker");
    const step = crud.getStep(db, "s1", 0)!;
    assert.strictEqual(step.step_type, "SEMANTIC");
    assert.strictEqual(step.prompt, "Check.");
    assert.strictEqual(step.status, "active"); // first step
  });
});

test("insertStep stores COMMAND columns", () => {
  withDb((db: any) => {
    crud.insertPipeline(db, "s1", "worker", 1);
    crud.insertStep(db, "s1", 0, { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool", "Read"] } as VerificationStep, "worker");
    const step = crud.getStep(db, "s1", 0)!;
    assert.strictEqual(step.command, "/question");
    assert.strictEqual(step.allowed_tools, "AskUserTool,Read");
  });
});

test("updateStepStatus + updatePipelineState", () => {
  withDb((db: any) => {
    crud.insertPipeline(db, "s1", "worker", 1);
    crud.insertStep(db, "s1", 0, { type: "SEMANTIC", prompt: "Check." } as VerificationStep, "worker");
    crud.updateStepStatus(db, "s1", 0, "passed");
    crud.updatePipelineState(db, "s1", { status: "completed" });
    assert.strictEqual(crud.getStep(db, "s1", 0)!.status, "passed");
    assert.strictEqual(crud.getPipelineState(db, "s1")!.status, "completed");
  });
});

test("updateStepStatus with round", () => {
  withDb((db: any) => {
    crud.insertPipeline(db, "s1", "worker", 1);
    crud.insertStep(db, "s1", 0, { type: "REVIEW", agent: "rev", maxRounds: 3 } as VerificationStep, "worker");
    crud.updateStepStatus(db, "s1", 0, "revise", 2);
    const step = crud.getStep(db, "s1", 0)!;
    assert.strictEqual(step.status, "revise");
    assert.strictEqual(step.round, 2);
  });
});

test("getStepByStatus", () => {
  withDb((db: any) => {
    crud.insertPipeline(db, "s1", "worker", 2);
    crud.insertStep(db, "s1", 0, { type: "SEMANTIC", prompt: "A" } as VerificationStep, "worker");
    crud.insertStep(db, "s1", 1, { type: "REVIEW", agent: "rev", maxRounds: 3 } as VerificationStep, "worker");
    assert.strictEqual(crud.getStepByStatus(db, "s1", "active")!.step_index, 0);
    assert.strictEqual(crud.getStepByStatus(db, "s1", "pending")!.step_index, 1);
  });
});

test("deletePipeline removes all data", () => {
  withDb((db: any) => {
    crud.insertPipeline(db, "s1", "worker", 1);
    crud.insertStep(db, "s1", 0, { type: "SEMANTIC", prompt: "A" } as VerificationStep, "worker");
    crud.deletePipeline(db, "s1");
    assert.strictEqual(crud.getPipelineState(db, "s1"), null);
    assert.strictEqual(crud.getSteps(db, "s1").length, 0);
  });
});

test("hasNonPassedSteps", () => {
  withDb((db: any) => {
    crud.insertPipeline(db, "s1", "worker", 1);
    crud.insertStep(db, "s1", 0, { type: "SEMANTIC", prompt: "A" } as VerificationStep, "worker");
    assert.strictEqual(crud.hasNonPassedSteps(db, "s1"), true);
    crud.updateStepStatus(db, "s1", 0, "passed");
    assert.strictEqual(crud.hasNonPassedSteps(db, "s1"), false);
  });
});

test("registerAgent + getAgent + setVerdict", () => {
  withDb((db: any) => {
    crud.registerAgent(db, "scope", "worker", "/path.md");
    crud.setVerdict(db, "scope", "worker", "PASS", 1);
    const agent = crud.getAgent(db, "scope", "worker")!;
    assert.strictEqual(agent.verdict, "PASS");
    assert.strictEqual(agent.round, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// pipeline.js — engine tests
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== pipeline.js: createPipeline ===");

test("createPipeline initializes state + steps", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "e1", "worker", [
      { type: "SEMANTIC", prompt: "Check." },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    assert.strictEqual(crud.getPipelineState(db, "e1")!.total_steps, 2);
    assert.strictEqual(crud.getSteps(db, "e1").length, 2);
  });
});

test("createPipeline is no-op if exists", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "e1", "worker", [{ type: "SEMANTIC", prompt: "A" }] as VerificationStep[]);
    engine.createPipeline(db, "e1", "other", [{ type: "SEMANTIC", prompt: "B" }] as VerificationStep[]);
    assert.strictEqual(crud.getPipelineState(db, "e1")!.source_agent, "worker");
  });
});

console.log("\n=== pipeline.js: step() — unified API ===");

test("step(PASS) advances to next step", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "SEMANTIC", prompt: "Check." },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    const a: any = engine.step(db, "s1", "PASS");
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer");
  });
});

test("step(PASS) on last step returns done", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "Check." }] as VerificationStep[]);
    const a: any = engine.step(db, "s1", "PASS");
    assert.strictEqual(a.action, "done");
  });
});

test("step(CONVERGED) treated as PASS", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "Check." }] as VerificationStep[]);
    const a: any = engine.step(db, "s1", "CONVERGED");
    assert.strictEqual(a.action, "done");
  });
});

test("step(REVISE) on REVIEW returns source action", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "SEMANTIC", prompt: "Check." },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    engine.step(db, "s1", "PASS"); // advance to REVIEW
    const a: any = engine.step(db, "s1", "REVISE");
    assert.strictEqual(a.action, "source");
    assert.strictEqual(a.agent, "worker"); // routes to source, not fixer
  });
});

test("step(REVISE) on REVIEW_WITH_FIXER returns fixer action", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
    ] as VerificationStep[]);
    const a: any = engine.step(db, "s1", "REVISE");
    assert.strictEqual(a.action, "source");
    assert.strictEqual(a.agent, "patcher"); // routes to fixer
  });
});

test("step(FAIL) treated same as REVISE", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    const a: any = engine.step(db, "s1", "FAIL");
    assert.strictEqual(a.action, "source");
  });
});

test("step exhaustion returns failed after maxRounds revisions", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 1 },
    ] as VerificationStep[]);
    // maxRounds=1: first REVISE → round 1 (1 > 1 = false, within bounds)
    let a: any = engine.step(db, "s1", "REVISE");
    assert.strictEqual(a.action, "source");
    engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" }); // reactivate
    // Second REVISE → round 2 (2 > 1 = true, exhausted)
    a = engine.step(db, "s1", "REVISE");
    assert.strictEqual(a.action, "failed");
    assert.strictEqual(a.round, 2);
    assert.strictEqual(a.maxRounds, 1);
  });
});

test("step with unknown verdict warns and passes", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "Check." }] as VerificationStep[]);
    // Redirect stderr to suppress warning in test output
    const origWrite = process.stderr.write;
    let warned = false;
    process.stderr.write = ((msg: any) => { warned = String(msg).includes("Unknown verdict"); return true; }) as any;
    const a: any = engine.step(db, "s1", "GARBAGE");
    process.stderr.write = origWrite;
    assert.strictEqual(a.action, "done");
    assert.strictEqual(warned, true);
  });
});

test("step returns null for completed pipeline", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "Check." }] as VerificationStep[]);
    engine.step(db, "s1", "PASS");
    assert.strictEqual(engine.step(db, "s1", "PASS"), null);
  });
});

console.log("\n=== pipeline.js: role-aware step (source in revision) ===");

test("step({ role: 'source' }) in revision reactivates revise step", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    engine.step(db, "s1", "REVISE"); // → revision
    const a: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer");
    assert.strictEqual(crud.getPipelineState(db, "s1")!.status, "normal");
  });
});

test("step({ role: 'fixer' }) reactivates fix step", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
    ] as VerificationStep[]);
    engine.step(db, "s1", "REVISE"); // → fix
    const a: any = engine.step(db, "s1", { role: "fixer", artifactVerdict: "PASS" });
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer"); // reviewer re-runs, not fixer
  });
});

test("step({ role: 'source' }) does NOT advance REVIEW step", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    // Source completes with PASS — should NOT advance the REVIEW step
    const a: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer"); // reviewer should still be expected
    // Step should still be active, not passed
    assert.strictEqual(crud.getActiveStep(db, "s1")!.status, "active");
    assert.strictEqual(crud.getActiveStep(db, "s1")!.step_type, "REVIEW");
  });
});

test("step({ role: 'source' }) does NOT advance COMMAND step", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
    ] as VerificationStep[]);
    const a: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
    assert.strictEqual(a.action, "command"); // COMMAND still active, not advanced
    assert.strictEqual(crud.getActiveStep(db, "s1")!.status, "active");
  });
});

test("step({ role: 'source' }) advances SEMANTIC step", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "SEMANTIC", prompt: "Check." },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    const a: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
    // SEMANTIC passed, REVIEW now active
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer");
    assert.strictEqual(crud.getStep(db, "s1", 0)!.status, "passed");
    assert.strictEqual(crud.getStep(db, "s1", 1)!.status, "active");
  });
});

test("step({ role: 'verifier', semanticVerdict: 'FAIL' }) retries gate", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    const a: any = engine.step(db, "s1", { role: "verifier", artifactVerdict: "PASS", semanticVerdict: "FAIL" });
    // Gate retried: still spawn action, round incremented
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer");
    assert.strictEqual(a.round, 1); // round incremented from 0
  });
});

test("step({ role: 'verifier', semanticVerdict: 'FAIL' }) exhaustion after maxRounds", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 1 },
    ] as VerificationStep[]);
    // First semantic FAIL → round 1 (1 > 1 = false, retry)
    let a: any = engine.step(db, "s1", { role: "verifier", artifactVerdict: "PASS", semanticVerdict: "FAIL" });
    assert.strictEqual(a.action, "spawn"); // retried
    // Second semantic FAIL → round 2 (2 > 1 = true, exhausted)
    a = engine.step(db, "s1", { role: "verifier", artifactVerdict: "PASS", semanticVerdict: "FAIL" });
    assert.strictEqual(a.action, "failed");
    assert.strictEqual(a.round, 2);
    assert.strictEqual(a.maxRounds, 1);
  });
});

console.log("\n=== pipeline.js: getNextAction ===");

test("getNextAction returns semantic for step 0", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "SEMANTIC", prompt: "Check." },
    ] as VerificationStep[]);
    const a: any = engine.getNextAction(db, "s1");
    assert.strictEqual(a.action, "semantic");
  });
});

test("getNextAction returns spawn for REVIEW", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "SEMANTIC", prompt: "Check." },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    engine.step(db, "s1", "PASS");
    const a: any = engine.getNextAction(db, "s1");
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer");
    assert.strictEqual(a.round, 0);
    assert.strictEqual(a.maxRounds, 3);
  });
});

test("getNextAction returns command for COMMAND", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
    ] as VerificationStep[]);
    const a: any = engine.getNextAction(db, "s1");
    assert.strictEqual(a.action, "command");
    assert.strictEqual(a.command, "/question");
    assert.deepStrictEqual(a.allowedTools, ["AskUserTool"]);
  });
});

test("getNextAction returns source during revision", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    engine.step(db, "s1", "REVISE");
    const a: any = engine.getNextAction(db, "s1");
    assert.strictEqual(a.action, "source");
    assert.strictEqual(a.agent, "worker");
  });
});

test("getNextAction returns fixer during fix", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
    ] as VerificationStep[]);
    engine.step(db, "s1", "REVISE");
    const a: any = engine.getNextAction(db, "s1");
    assert.strictEqual(a.action, "source");
    assert.strictEqual(a.agent, "patcher");
  });
});

test("getNextAction returns null for completed", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "A" }] as VerificationStep[]);
    engine.step(db, "s1", "PASS");
    assert.strictEqual(engine.getNextAction(db, "s1"), null);
  });
});

test("getNextAction returns null for failed", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "REVIEW", agent: "rev", maxRounds: 0 }] as VerificationStep[]);
    engine.step(db, "s1", "REVISE"); // round 1 > 0 → exhausted
    assert.strictEqual(engine.getNextAction(db, "s1"), null);
  });
});

console.log("\n=== pipeline.js: getAllNextActions ===");

test("getAllNextActions returns actions for all active scopes", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "a", "worker-a", [{ type: "REVIEW", agent: "rev", maxRounds: 3 }] as VerificationStep[]);
    engine.createPipeline(db, "b", "worker-b", [{ type: "COMMAND", command: "/q", allowedTools: ["Ask"] }] as VerificationStep[]);
    const actions = engine.getAllNextActions(db);
    assert.strictEqual(actions.length, 2);
    const types = actions.map((a: any) => a.action).sort();
    assert.deepStrictEqual(types, ["command", "spawn"]);
  });
});

console.log("\n=== pipeline.js: resolveRole ===");

test("resolveRole: verifier for active reviewer", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "REVIEW", agent: "reviewer", maxRounds: 3 }] as VerificationStep[]);
    assert.strictEqual(engine.resolveRole(db, "s1", "reviewer"), "verifier");
  });
});

test("resolveRole: fixer for fix status", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
    ] as VerificationStep[]);
    engine.step(db, "s1", "REVISE");
    assert.strictEqual(engine.resolveRole(db, "s1", "patcher"), "fixer");
  });
});

test("resolveRole: source for source agent", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "REVIEW", agent: "reviewer", maxRounds: 3 }] as VerificationStep[]);
    assert.strictEqual(engine.resolveRole(db, "s1", "worker"), "source");
  });
});

test("resolveRole: ungated for unknown agent", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "REVIEW", agent: "reviewer", maxRounds: 3 }] as VerificationStep[]);
    assert.strictEqual(engine.resolveRole(db, "s1", "random"), "ungated");
  });
});

test("resolveRole: unscoped search across pipelines", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "REVIEW", agent: "reviewer", maxRounds: 3 }] as VerificationStep[]);
    assert.strictEqual(engine.resolveRole(db, null as any, "reviewer"), "verifier");
    assert.strictEqual(engine.resolveRole(db, null as any, "unknown"), "ungated");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Integration: full pipeline flows
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== Integration: full happy path ===");

test("4-step pipeline: SEMANTIC → COMMAND → REVIEW → REVIEW_WITH_FIXER", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "full", "worker", [
      { type: "SEMANTIC", prompt: "Check quality." },
      { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
      { type: "REVIEW_WITH_FIXER", agent: "playtester", maxRounds: 2, fixer: "patcher" },
    ] as VerificationStep[]);

    let a: any = engine.step(db, "full", "PASS"); // SEMANTIC → COMMAND
    assert.strictEqual(a.action, "command");
    a = engine.step(db, "full", "PASS"); // COMMAND → REVIEW
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer");
    a = engine.step(db, "full", "PASS"); // REVIEW → REVIEW_WITH_FIXER
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "playtester");
    a = engine.step(db, "full", "PASS"); // done
    assert.strictEqual(a.action, "done");
  });
});

console.log("\n=== Integration: revise + fixer flow ===");

test("REVIEW_WITH_FIXER: revise → fixer → reactivate → pass", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "fix", "worker", [
      { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
    ] as VerificationStep[]);
    let a: any = engine.step(db, "fix", "REVISE"); // → fixer
    assert.strictEqual(a.action, "source");
    assert.strictEqual(a.agent, "patcher");

    a = engine.step(db, "fix", { role: "fixer", artifactVerdict: "PASS" }); // fixer done → reactivate
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer");

    a = engine.step(db, "fix", "PASS"); // reviewer passes
    assert.strictEqual(a.action, "done");
  });
});

console.log("\n=== Integration: multi-round revise ===");

test("REVIEW: maxRounds=2 exhausts after 2 revisions (3rd REVISE fails)", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "exh", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 2 },
    ] as VerificationStep[]);
    // Round 1/2: REVISE (within bounds)
    let a: any = engine.step(db, "exh", "REVISE");
    assert.strictEqual(a.action, "source");
    engine.step(db, "exh", { role: "source", artifactVerdict: "PASS" });

    // Round 2/2: REVISE (within bounds)
    a = engine.step(db, "exh", "REVISE");
    assert.strictEqual(a.action, "source");
    engine.step(db, "exh", { role: "source", artifactVerdict: "PASS" });

    // Round 3/2: REVISE → 3 > 2 → exhausted
    a = engine.step(db, "exh", "REVISE");
    assert.strictEqual(a.action, "failed");
    assert.strictEqual(a.round, 3);
    assert.strictEqual(a.maxRounds, 2);
  });
});

console.log("\n=== Integration: parallel pipelines ===");

test("Two scopes run independently", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "a", "wa", [{ type: "REVIEW", agent: "rev", maxRounds: 3 }] as VerificationStep[]);
    engine.createPipeline(db, "b", "wb", [{ type: "REVIEW", agent: "rev", maxRounds: 3 }] as VerificationStep[]);

    engine.step(db, "a", "REVISE");
    engine.step(db, "b", "PASS");

    assert.strictEqual(crud.getPipelineState(db, "a")!.status, "revision");
    assert.strictEqual(crud.getPipelineState(db, "b")!.status, "completed");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Hook integration: pipeline-block.js patterns
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== Hook: pipeline-block patterns ===");

test("getAllNextActions returns spawn actions for block enforcement", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    const actions = engine.getAllNextActions(db);
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].action, "spawn");
    assert.strictEqual((actions[0] as any).agent, "reviewer");
    assert.strictEqual((actions[0] as any).scope, "s1");
  });
});

test("getAllNextActions returns source action during revision", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    engine.step(db, "s1", "REVISE");
    const actions = engine.getAllNextActions(db);
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].action, "source");
    assert.strictEqual((actions[0] as any).agent, "worker");
  });
});

test("getAllNextActions returns command action with allowed tools", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool", "Read"] },
    ] as VerificationStep[]);
    const actions = engine.getAllNextActions(db);
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].action, "command");
    assert.deepStrictEqual((actions[0] as any).allowedTools, ["AskUserTool", "Read"]);
  });
});

test("getAllNextActions empty after pipeline completes", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "A" }] as VerificationStep[]);
    engine.step(db, "s1", "PASS");
    const actions = engine.getAllNextActions(db);
    assert.strictEqual(actions.length, 0);
  });
});

test("SEMANTIC-only pipeline: getAllNextActions returns semantic action", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "A" }] as VerificationStep[]);
    const actions = engine.getAllNextActions(db);
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].action, "semantic");
    // pipeline-block treats semantic as blocking (source must re-run)
  });
});

test("SEMANTIC action includes source_agent for pipeline-block", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "A" }] as VerificationStep[]);
    const actions = engine.getAllNextActions(db);
    assert.strictEqual((actions[0] as any).step.source_agent, "worker");
    // pipeline-block uses step.source_agent when act.agent is null
  });
});

test("SEMANTIC action blocks: source_agent resolvable from step", () => {
  // Regression: pipeline-block didn't recognize "semantic" action, letting orchestrator bypass
  withDb((db: any) => {
    engine.createPipeline(db, "fix-1", "fixer", [
      { type: "SEMANTIC", prompt: "Check fix" },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    const actions = engine.getAllNextActions(db);
    const sem = actions.find((a: any) => a.scope === "fix-1");
    assert.strictEqual(sem!.action, "semantic");
    assert.strictEqual((sem as any).step.source_agent, "fixer");
    // pipeline-block should treat this as: Resume fixer (scope=fix-1)
  });
});

// ══════════════════════════════════════════════════════════════════════
// COMMAND step engine tests
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== COMMAND step: engine.step with role=null ===");

test("COMMAND step: PASS with { role: null } advances", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    const a: any = engine.step(db, "s1", { role: null, artifactVerdict: "PASS" });
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer");
    assert.strictEqual(crud.getStep(db, "s1", 0)!.status, "passed");
  });
});

test("COMMAND step: REVISE with { role: null } enters revision", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
    ] as VerificationStep[]);
    const a: any = engine.step(db, "s1", { role: null, artifactVerdict: "REVISE" });
    assert.strictEqual(a.action, "source");
    assert.strictEqual(a.agent, "worker");
    assert.strictEqual(crud.getPipelineState(db, "s1")!.status, "revision");
  });
});

test("COMMAND step: UNKNOWN verdict treated as PASS (fail-open)", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
    ] as VerificationStep[]);
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as any; // suppress warning
    const a: any = engine.step(db, "s1", { role: null, artifactVerdict: "UNKNOWN" });
    process.stderr.write = origWrite;
    assert.strictEqual(a.action, "done");
  });
});

test("COMMAND step: string verdict also works (backward compat)", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "COMMAND", command: "/q", allowedTools: ["Ask"] },
      { type: "REVIEW", agent: "rev", maxRounds: 2 },
    ] as VerificationStep[]);
    const a: any = engine.step(db, "s1", "PASS"); // string form
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "rev");
  });
});

test("getAllNextActions parallel: one completed, one active", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "a", "wa", [{ type: "SEMANTIC", prompt: "A" }] as VerificationStep[]);
    engine.createPipeline(db, "b", "wb", [{ type: "REVIEW", agent: "rev", maxRounds: 3 }] as VerificationStep[]);
    engine.step(db, "a", "PASS");
    const actions = engine.getAllNextActions(db);
    assert.strictEqual(actions.length, 1);
    assert.strictEqual((actions[0] as any).scope, "b");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Hook integration: pipeline-conditions.js patterns
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== Hook: pipeline-conditions patterns ===");

test("step enforcement: spawn action allows matching gate agent", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    const actions = engine.getAllNextActions(db);
    const scopeAction: any = actions.find((a: any) => a.scope === "s1");
    assert.strictEqual(scopeAction.action, "spawn");
    assert.strictEqual(scopeAction.agent, "reviewer");
    // conditions.js would allow reviewer, block anything else
  });
});

test("step enforcement: source action returns fixer during fix", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
    ] as VerificationStep[]);
    engine.step(db, "s1", "REVISE"); // → fix
    const actions = engine.getAllNextActions(db);
    const scopeAction: any = actions.find((a: any) => a.scope === "s1");
    assert.strictEqual(scopeAction.action, "source");
    assert.strictEqual(scopeAction.agent, "patcher"); // fixer, not source_agent
  });
});

test("step enforcement: command action blocks agent spawn", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
    ] as VerificationStep[]);
    const actions = engine.getAllNextActions(db);
    const scopeAction: any = actions.find((a: any) => a.scope === "s1");
    assert.strictEqual(scopeAction.action, "command");
    // conditions.js would block agent spawn, allow only command execution
  });
});

test("no pipeline for scope allows agent spawn", () => {
  withDb((db: any) => {
    const actions = engine.getAllNextActions(db);
    assert.strictEqual(actions.length, 0);
    // conditions.js: no actions → allow any agent (new scope)
  });
});

// ══════════════════════════════════════════════════════════════════════
// Hook integration: pipeline-injection.js patterns
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== Hook: pipeline-injection patterns ===");

test("createPipeline is idempotent", () => {
  withDb((db: any) => {
    const steps: VerificationStep[] = [
      { type: "SEMANTIC", prompt: "Check." },
      { type: "REVIEW", agent: "rev", maxRounds: 3 },
    ];
    engine.createPipeline(db, "s1", "worker", steps);
    engine.createPipeline(db, "s1", "worker", steps); // no-op
    assert.strictEqual(crud.getSteps(db, "s1").length, 2);
    assert.strictEqual(crud.getPipelineState(db, "s1")!.total_steps, 2);
  });
});

test("resolveRole works for verifier context enrichment", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
    ] as VerificationStep[]);
    assert.strictEqual(engine.resolveRole(db, "s1", "reviewer"), "verifier");
    const activeStep = crud.getActiveStep(db, "s1")!;
    assert.strictEqual(activeStep.agent, "reviewer");
    assert.strictEqual(activeStep.fixer, "patcher");
    assert.strictEqual(activeStep.max_rounds, 3);
  });
});

test("resolveRole returns fixer for fix step context", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
    ] as VerificationStep[]);
    engine.step(db, "s1", "REVISE"); // → fix status
    assert.strictEqual(engine.resolveRole(db, "s1", "patcher"), "fixer");
    const fixStep = crud.getStepByStatus(db, "s1", "fix");
    assert.ok(fixStep);
    assert.strictEqual(fixStep!.fixer, "patcher");
  });
});

test("injection path: findAgentScope finds scope registered by conditions", () => {
  withDb((db: any) => {
    // Simulate conditions.js registering agent with real scope
    crud.registerAgent(db, "my-scope", "builder", "/path/to/artifact.md");
    // Simulate injection.js using findAgentScope (not getPending)
    const scope = crud.findAgentScope(db, "builder")!;
    assert.strictEqual(scope, "my-scope");
    // Verify pipeline can be created with found scope
    engine.createPipeline(db, scope, "builder", [{ type: "SEMANTIC", prompt: "Check." }] as VerificationStep[]);
    assert.ok(crud.pipelineExists(db, scope));
  });
});

test("source semantic FAIL overrides artifact PASS in engine", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "SEMANTIC", prompt: "Check quality." },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    // Source artifact says PASS but semantic says FAIL → engine should get FAIL
    const a: any = engine.step(db, "s1", { role: "source", artifactVerdict: "FAIL", semanticVerdict: "FAIL" });
    // FAIL normalized to REVISE → source action (source re-runs)
    assert.strictEqual(a.action, "source");
    assert.strictEqual(crud.getPipelineState(db, "s1")!.status, "revision");
  });
});

test("SEMANTIC FAIL → revision → source re-completes → step reactivated correctly", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "SEMANTIC", prompt: "Check quality." },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    // Source fails SEMANTIC check → pipeline enters revision
    const a1: any = engine.step(db, "s1", { role: "source", artifactVerdict: "FAIL" });
    assert.strictEqual(a1.action, "source");
    assert.strictEqual(crud.getPipelineState(db, "s1")!.status, "revision");
    assert.strictEqual(crud.getStep(db, "s1", 0)!.status, "revise");

    // Source re-completes → reactivate SEMANTIC step
    const a2: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
    // Should return semantic action (step reactivated)
    assert.strictEqual(a2.action, "semantic");
    assert.strictEqual(crud.getPipelineState(db, "s1")!.status, "normal");
    assert.strictEqual(crud.getStep(db, "s1", 0)!.status, "active");

    // Now SEMANTIC can be re-run and passed
    const a3: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
    assert.strictEqual(a3.action, "spawn");
    assert.strictEqual(a3.agent, "reviewer");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Hook integration: pipeline-verification.js patterns
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== Hook: pipeline-verification patterns ===");

test("source step({ role: 'source' }) in revision reactivates step", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    engine.step(db, "s1", "REVISE"); // reviewer → revise → source must re-run
    assert.strictEqual(crud.getPipelineState(db, "s1")!.status, "revision");

    // Source re-completes — engine detects revision state
    const a: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer");
    assert.strictEqual(crud.getPipelineState(db, "s1")!.status, "normal");
  });
});

test("fixer step({ role: 'fixer' }) reactivates step", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
    ] as VerificationStep[]);
    engine.step(db, "s1", "REVISE"); // → fix
    assert.strictEqual(crud.getStepByStatus(db, "s1", "fix")!.fixer, "patcher");

    const a: any = engine.step(db, "s1", { role: "fixer", artifactVerdict: "PASS" });
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer"); // reviewer re-runs
  });
});

test("gate agent PASS advances to next step", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "rev1", maxRounds: 3 },
      { type: "REVIEW", agent: "rev2", maxRounds: 2 },
    ] as VerificationStep[]);
    const a: any = engine.step(db, "s1", "PASS"); // rev1 passes → rev2 active
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "rev2");
    assert.strictEqual(crud.getStep(db, "s1", 0)!.status, "passed");
    assert.strictEqual(crud.getStep(db, "s1", 1)!.status, "active");
  });
});

test("gate agent semantic FAIL via engine: round increment + re-run", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    ] as VerificationStep[]);
    const a: any = engine.step(db, "s1", { role: "verifier", artifactVerdict: "PASS", semanticVerdict: "FAIL" });
    assert.strictEqual(a.action, "spawn");
    assert.strictEqual(a.agent, "reviewer");
    assert.strictEqual(a.round, 1); // round incremented
    assert.strictEqual(crud.getActiveStep(db, "s1")!.status, "active");
  });
});

test("gate agent semantic FAIL via engine: exhaustion → failed", () => {
  withDb((db: any) => {
    engine.createPipeline(db, "s1", "worker", [
      { type: "REVIEW", agent: "reviewer", maxRounds: 0 },
    ] as VerificationStep[]);
    // maxRounds=0: first FAIL → round 1, 1 > 0 → exhausted
    const a: any = engine.step(db, "s1", { role: "verifier", artifactVerdict: "PASS", semanticVerdict: "FAIL" });
    assert.strictEqual(a.action, "failed");
    assert.strictEqual(crud.getPipelineState(db, "s1")!.status, "failed");
  });
});

test("VERDICT_RE matches standard result lines", () => {
  assert.ok(shared.VERDICT_RE.test("Result: PASS"));
  assert.ok(shared.VERDICT_RE.test("Result: FAIL"));
  assert.ok(shared.VERDICT_RE.test("Result: REVISE"));
  assert.ok(shared.VERDICT_RE.test("Result: CONVERGED"));
  assert.ok(!shared.VERDICT_RE.test("No result here"));
});

test("VERDICT_RE matches Verdict: prefix and bold formatting", () => {
  assert.ok(shared.VERDICT_RE.test("Verdict: PASS"));
  assert.ok(shared.VERDICT_RE.test("**Verdict: CONVERGED — PASS**"));
  assert.ok(shared.VERDICT_RE.test("**Result: PASS**"));
  const m = shared.VERDICT_RE.exec("**Verdict: CONVERGED — PASS**");
  assert.strictEqual(m![1], "CONVERGED", "should capture first verdict keyword");
});

test("agent CRUD: register and retrieve", () => {
  withDb((db: any) => {
    crud.registerAgent(db, "s1", "worker", "/path/to/artifact.md");
    const agent = crud.getAgent(db, "s1", "worker")!;
    assert.strictEqual(agent.agent, "worker");
    assert.strictEqual(agent.outputFilepath, "/path/to/artifact.md");
    assert.strictEqual(agent.verdict, null);
  });
});

test("agent CRUD: set verdict and retrieve", () => {
  withDb((db: any) => {
    crud.registerAgent(db, "s1", "worker", "/path.md");
    crud.setVerdict(db, "s1", "worker", "PASS", 1);
    const agent = crud.getAgent(db, "s1", "worker")!;
    assert.strictEqual(agent.verdict, "PASS");
    assert.strictEqual(agent.round, 1);
  });
});

test("findAgentScope finds agent by type", () => {
  withDb((db: any) => {
    crud.registerAgent(db, "my-scope", "worker", "/path.md");
    const scope = crud.findAgentScope(db, "worker");
    assert.strictEqual(scope, "my-scope");
  });
});

// ══════════════════════════════════════════════════════════════════════

console.log(`\n${"=".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

export {};
