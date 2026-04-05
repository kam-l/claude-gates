#!/usr/bin/env node
/**
 * Pipeline v3 — unit + integration tests.
 *
 * Tests: frontmatter.js (parsing), database.js (CRUD), state-machine.js (engine).
 * Run: node scripts/pipeline-test.js
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

import * as crud from "./Database.js";
import { FrontmatterParser as shared, } from "./FrontmatterParser.js";
import { parseToggleCommand, } from "./GateToggle.js";
import { SessionManager, } from "./SessionManager.js";
import * as engine from "./StateMachine.js";
import { Tracing, } from "./Tracing.js";
import type { VerificationStep, } from "./types/Interfaces.js";

const auditTrace = Tracing.trace;

let pass = 0, fail = 0;

function test(name: string, fn: () => void,): void
{
  try
  {
    fn();
    pass++;
    console.log(`  PASS: ${name}`,);
  }
  catch (e: any)
  {
    fail++;
    console.log(`  FAIL: ${name} — ${e.message}`,);
  }
}

function tmpDir(): string
{
  return fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-",),);
}

function cleanup(dir: string,): void
{
  try
  {
    fs.rmSync(dir, { recursive: true, force: true, },);
  }
  catch
  {
  }
}

function withDb(fn: (db: any,) => void,): void
{
  const dir = tmpDir();
  const db = crud.getDb(dir,);
  try
  {
    fn(db,);
  }
  finally
  {
    db.close();
    cleanup(dir,);
  }
}

// ══════════════════════════════════════════════════════════════════════
// FrontmatterParser — parsing tests
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== FrontmatterParser: extractFrontmatter ===",);

test("extractFrontmatter returns YAML between fences", () =>
{
  assert.strictEqual(shared.extractFrontmatter("---\nname: test\n---\n# Body",), "name: test",);
});

test("extractFrontmatter returns null for no frontmatter", () =>
{
  assert.strictEqual(shared.extractFrontmatter("# Just a heading",), null,);
});

console.log("\n=== FrontmatterParser: parseVerification ===",);

test("parse CHECK step", () =>
{
  const steps = shared.parseVerification("---\nverification:\n  - [\"Verify completeness.\"]\n---\n",);
  assert.strictEqual(steps!.length, 1,);
  assert.strictEqual(steps![0].type, "CHECK",);
  assert.strictEqual((steps![0] as any).prompt, "Verify completeness.",);
});

test("parse CHECK step with single quotes", () =>
{
  const steps = shared.parseVerification("---\nverification:\n  - ['Verify quality.']\n---\n",);
  assert.strictEqual(steps![0].type, "CHECK",);
  assert.strictEqual((steps![0] as any).prompt, "Verify quality.",);
});

test("parse slash command as TRANSFORM step", () =>
{
  const steps = shared.parseVerification("---\nverification:\n  - [/question, AskUserTool]\n---\n",);
  assert.strictEqual(steps![0].type, "TRANSFORM",);
  assert.strictEqual((steps![0] as any).agent, "question",);
  assert.strictEqual((steps![0] as any).maxRounds, 1,);
});

test("parse slash command with multiple args still produces TRANSFORM", () =>
{
  const steps = shared.parseVerification("---\nverification:\n  - [/rethink, AskUserTool, Read]\n---\n",);
  assert.strictEqual(steps![0].type, "TRANSFORM",);
  assert.strictEqual((steps![0] as any).agent, "rethink",);
  assert.strictEqual((steps![0] as any).maxRounds, 1,);
});

test("parse VERIFY step", () =>
{
  const steps = shared.parseVerification("---\nverification:\n  - [reviewer, 3]\n---\n",);
  assert.strictEqual(steps![0].type, "VERIFY",);
  assert.strictEqual((steps![0] as any).agent, "reviewer",);
  assert.strictEqual((steps![0] as any).maxRounds, 3,);
});

test("parse VERIFY_W_FIXER step", () =>
{
  const steps = shared.parseVerification("---\nverification:\n  - [reviewer, 3, fixer]\n---\n",);
  assert.strictEqual(steps![0].type, "VERIFY_W_FIXER",);
  assert.strictEqual((steps![0] as any).fixer, "fixer",);
});

test("parse mixed verification steps", () =>
{
  const md = "---\nverification:\n  - [\"Check.\"]\n  - [/question, AskUserTool]\n  - [reviewer, 3]\n  - [playtester, 2, fixer]\n---\n";
  const steps = shared.parseVerification(md,);
  assert.strictEqual(steps!.length, 4,);
  assert.strictEqual(steps![0].type, "CHECK",);
  assert.strictEqual(steps![1].type, "TRANSFORM",);
  assert.strictEqual(steps![2].type, "VERIFY",);
  assert.strictEqual(steps![3].type, "VERIFY_W_FIXER",);
});

test("parseVerification returns null for no verification field", () =>
{
  assert.strictEqual(shared.parseVerification("---\nname: test\n---\n",), null,);
});

test("parseVerification returns null for empty verification", () =>
{
  assert.strictEqual(shared.parseVerification("---\nverification:\n---\n",), null,);
});

test("parse agent name with hyphens and underscores", () =>
{
  const steps = shared.parseVerification("---\nverification:\n  - [gt-reviewer_v2, 5]\n---\n",);
  assert.strictEqual((steps![0] as any).agent, "gt-reviewer_v2",);
  assert.strictEqual((steps![0] as any).maxRounds, 5,);
});

console.log("\n=== FrontmatterParser: parseConditions ===",);

test("parseConditions returns prompt", () =>
{
  const cond = shared.parseConditions("---\nconditions: |\n  Check if ready.\n  Must have scope.\n---\n",);
  assert.ok(cond!.includes("Check if ready.",),);
});

test("parseConditions returns null when absent", () =>
{
  assert.strictEqual(shared.parseConditions("---\nname: test\n---\n",), null,);
});

console.log("\n=== FrontmatterParser: requiresScope ===",);

test("requiresScope true for verification array", () =>
{
  assert.strictEqual(shared.requiresScope("---\nverification:\n  - [\"Check.\"]\n---\n",), true,);
});

test("requiresScope false for bare agent", () =>
{
  assert.strictEqual(shared.requiresScope("---\nname: test\n---\n",), false,);
});

test("parseVerification: TRANSFORM step (agent!)", () =>
{
  const md = `---\nverification:\n  - [cleaner!, 1]\n---\n`;
  const steps = shared.parseVerification(md,);
  assert.ok(steps,);
  assert.strictEqual(steps!.length, 1,);
  assert.strictEqual(steps![0].type, "TRANSFORM",);
  assert.strictEqual((steps![0] as any).agent, "cleaner",);
  assert.strictEqual((steps![0] as any).maxRounds, 1,);
});

test("parseVerification: ? and ! suffixes stripped from agent names", () =>
{
  const md = `---\nverification:\n  - [reviewer?, 3, fixer!]\n---\n`;
  const steps = shared.parseVerification(md,);
  assert.ok(steps,);
  assert.strictEqual(steps![0].type, "VERIFY_W_FIXER",);
  assert.strictEqual((steps![0] as any).agent, "reviewer",);
  assert.strictEqual((steps![0] as any).fixer, "fixer",);
});

test("TRANSFORM step: auto-advances on completion", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "tx", "worker", [
      { type: "TRANSFORM", agent: "cleaner", maxRounds: 1, },
      { type: "CHECK", prompt: "Check.", },
    ] as VerificationStep[],);
    // Transformer completes → auto-advance to next step
    const a: any = engine.step(db, "tx", { role: "transformer", artifactVerdict: "PASS", },);
    assert.strictEqual(a.action, "semantic", "should advance past TRANSFORM to CHECK",);
  },);
});

test("TRANSFORM step: getNextAction returns spawn", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "ta", "worker", [
      { type: "TRANSFORM", agent: "cleaner", maxRounds: 1, },
    ] as VerificationStep[],);
    const a: any = engine.getNextAction(db, "ta",);
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "cleaner",);
    assert.strictEqual(a.step.step_type, "TRANSFORM",);
  },);
});

test("TRANSFORM step: source completing auto-advances (not just transformer role)", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "ts", "worker", [
      { type: "TRANSFORM", agent: "cleaner", maxRounds: 1, },
    ] as VerificationStep[],);
    // Source agent completing a TRANSFORM step also auto-advances
    const a: any = engine.step(db, "ts", { role: "source", artifactVerdict: "PASS", },);
    assert.strictEqual(a.action, "done",);
  },);
});

test("TRANSFORM step: resolveRole returns transformer", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "tr", "worker", [
      { type: "TRANSFORM", agent: "cleaner", maxRounds: 1, },
    ] as VerificationStep[],);
    const role = engine.resolveRole(db, "tr", "cleaner",);
    assert.strictEqual(role, "transformer",);
  },);
});

// ══════════════════════════════════════════════════════════════════════
// pipeline-db.js — CRUD tests
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== pipeline-db.js: CRUD ===",);

test("getDb creates database", () =>
{
  withDb((db: any,) => assert.ok(db,));
});

test("insertPipeline + getPipelineState", () =>
{
  withDb((db: any,) =>
  {
    crud.insertPipeline(db, "s1", "worker", 2,);
    const state = crud.getPipelineState(db, "s1",);
    assert.strictEqual(state!.source_agent, "worker",);
    assert.strictEqual(state!.total_steps, 2,);
    assert.strictEqual(state!.status, "normal",);
  },);
});

test("insertStep + getStep", () =>
{
  withDb((db: any,) =>
  {
    crud.insertPipeline(db, "s1", "worker", 1,);
    crud.insertStep(db, "s1", 0, { type: "CHECK", prompt: "Check.", } as VerificationStep, "worker",);
    const step = crud.getStep(db, "s1", 0,)!;
    assert.strictEqual(step.step_type, "CHECK",);
    assert.strictEqual(step.prompt, "Check.",);
    assert.strictEqual(step.status, "active",); // first step
  },);
});

test("insertStep stores TRANSFORM columns for slash command", () =>
{
  withDb((db: any,) =>
  {
    crud.insertPipeline(db, "s1", "worker", 1,);
    crud.insertStep(db, "s1", 0, { type: "TRANSFORM", agent: "question", maxRounds: 1, } as VerificationStep, "worker",);
    const step = crud.getStep(db, "s1", 0,)!;
    assert.strictEqual(step.step_type, "TRANSFORM",);
    assert.strictEqual(step.agent, "question",);
    assert.strictEqual(step.max_rounds, 1,);
  },);
});

test("updateStepStatus + updatePipelineState", () =>
{
  withDb((db: any,) =>
  {
    crud.insertPipeline(db, "s1", "worker", 1,);
    crud.insertStep(db, "s1", 0, { type: "CHECK", prompt: "Check.", } as VerificationStep, "worker",);
    crud.updateStepStatus(db, "s1", 0, "passed",);
    crud.updatePipelineState(db, "s1", { status: "completed", },);
    assert.strictEqual(crud.getStep(db, "s1", 0,)!.status, "passed",);
    assert.strictEqual(crud.getPipelineState(db, "s1",)!.status, "completed",);
  },);
});

test("updateStepStatus with round", () =>
{
  withDb((db: any,) =>
  {
    crud.insertPipeline(db, "s1", "worker", 1,);
    crud.insertStep(db, "s1", 0, { type: "VERIFY", agent: "rev", maxRounds: 3, } as VerificationStep, "worker",);
    crud.updateStepStatus(db, "s1", 0, "revise", 2,);
    const step = crud.getStep(db, "s1", 0,)!;
    assert.strictEqual(step.status, "revise",);
    assert.strictEqual(step.round, 2,);
  },);
});

test("getStepByStatus", () =>
{
  withDb((db: any,) =>
  {
    crud.insertPipeline(db, "s1", "worker", 2,);
    crud.insertStep(db, "s1", 0, { type: "CHECK", prompt: "A", } as VerificationStep, "worker",);
    crud.insertStep(db, "s1", 1, { type: "VERIFY", agent: "rev", maxRounds: 3, } as VerificationStep, "worker",);
    assert.strictEqual(crud.getStepByStatus(db, "s1", "active",)!.step_index, 0,);
    assert.strictEqual(crud.getStepByStatus(db, "s1", "pending",)!.step_index, 1,);
  },);
});

test("deletePipeline removes all data", () =>
{
  withDb((db: any,) =>
  {
    crud.insertPipeline(db, "s1", "worker", 1,);
    crud.insertStep(db, "s1", 0, { type: "CHECK", prompt: "A", } as VerificationStep, "worker",);
    crud.deletePipeline(db, "s1",);
    assert.strictEqual(crud.getPipelineState(db, "s1",), null,);
    assert.strictEqual(crud.getSteps(db, "s1",).length, 0,);
  },);
});

test("hasNonPassedSteps", () =>
{
  withDb((db: any,) =>
  {
    crud.insertPipeline(db, "s1", "worker", 1,);
    crud.insertStep(db, "s1", 0, { type: "CHECK", prompt: "A", } as VerificationStep, "worker",);
    assert.strictEqual(crud.hasNonPassedSteps(db, "s1",), true,);
    crud.updateStepStatus(db, "s1", 0, "passed",);
    assert.strictEqual(crud.hasNonPassedSteps(db, "s1",), false,);
  },);
});

test("registerAgent + getAgent + setVerdict", () =>
{
  withDb((db: any,) =>
  {
    crud.registerAgent(db, "scope", "worker", "/path.md",);
    crud.setVerdict(db, "scope", "worker", "PASS", 1,);
    const agent = crud.getAgent(db, "scope", "worker",)!;
    assert.strictEqual(agent.verdict, "PASS",);
    assert.strictEqual(agent.round, 1,);
  },);
});

test("setVerdict with check param records both verdict and check", () =>
{
  withDb((db: any,) =>
  {
    crud.registerAgent(db, "chk-scope", "reviewer", "/path.md",);
    crud.setVerdict(db, "chk-scope", "reviewer", "PASS", 1, "FAIL",);
    const agent = crud.getAgent(db, "chk-scope", "reviewer",)!;
    assert.strictEqual(agent.verdict, "PASS", "verdict should be PASS",);
    assert.strictEqual(agent.check, "FAIL", "check should be FAIL",);
    assert.strictEqual(agent.round, 1,);
  },);
});

test("setVerdict without check param leaves check null", () =>
{
  withDb((db: any,) =>
  {
    crud.registerAgent(db, "nochk", "worker", "/path.md",);
    crud.setVerdict(db, "nochk", "worker", "REVISE", 2,);
    const agent = crud.getAgent(db, "nochk", "worker",)!;
    assert.strictEqual(agent.verdict, "REVISE",);
    assert.strictEqual(agent.check, null, "check should be null when not provided",);
  },);
});

// ══════════════════════════════════════════════════════════════════════
// pipeline.js — engine tests
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== pipeline.js: createPipeline ===",);

test("createPipeline initializes state + steps", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "e1", "worker", [
      { type: "CHECK", prompt: "Check.", },
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    assert.strictEqual(crud.getPipelineState(db, "e1",)!.total_steps, 2,);
    assert.strictEqual(crud.getSteps(db, "e1",).length, 2,);
  },);
});

test("createPipeline is no-op if exists", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "e1", "worker", [{ type: "CHECK", prompt: "A", },] as VerificationStep[],);
    engine.createPipeline(db, "e1", "other", [{ type: "CHECK", prompt: "B", },] as VerificationStep[],);
    assert.strictEqual(crud.getPipelineState(db, "e1",)!.source_agent, "worker",);
  },);
});

console.log("\n=== pipeline.js: step() — unified API ===",);

test("step(PASS) advances to next step", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "CHECK", prompt: "Check.", },
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    const a: any = engine.step(db, "s1", "PASS",);
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "reviewer",);
  },);
});

test("step(PASS) on last step returns done", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "Check.", },] as VerificationStep[],);
    const a: any = engine.step(db, "s1", "PASS",);
    assert.strictEqual(a.action, "done",);
  },);
});

test("step(CONVERGED) treated as PASS", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "Check.", },] as VerificationStep[],);
    const a: any = engine.step(db, "s1", "CONVERGED",);
    assert.strictEqual(a.action, "done",);
  },);
});

test("step(REVISE) on VERIFY returns source action", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "CHECK", prompt: "Check.", },
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    engine.step(db, "s1", "PASS",); // advance to VERIFY
    const a: any = engine.step(db, "s1", "REVISE",);
    assert.strictEqual(a.action, "source",);
    assert.strictEqual(a.agent, "worker",); // routes to source, not fixer
  },);
});

test("step(REVISE) on VERIFY_W_FIXER returns fixer action", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
    ] as VerificationStep[],);
    const a: any = engine.step(db, "s1", "REVISE",);
    assert.strictEqual(a.action, "source",);
    assert.strictEqual(a.agent, "patcher",); // routes to fixer
  },);
});

test("step(FAIL) treated same as REVISE", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    const a: any = engine.step(db, "s1", "FAIL",);
    assert.strictEqual(a.action, "source",);
  },);
});

test("step exhaustion returns failed after maxRounds revisions", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 1, },
    ] as VerificationStep[],);
    // maxRounds=1: first REVISE → round 1 (1 > 1 = false, within bounds)
    let a: any = engine.step(db, "s1", "REVISE",);
    assert.strictEqual(a.action, "source",);
    engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", },); // reactivate
    // Second REVISE → round 2 (2 > 1 = true, exhausted)
    a = engine.step(db, "s1", "REVISE",);
    assert.strictEqual(a.action, "failed",);
    assert.strictEqual(a.round, 2,);
    assert.strictEqual(a.maxRounds, 1,);
  },);
});

test("step with unknown verdict warns and passes", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "Check.", },] as VerificationStep[],);
    // Redirect stderr to suppress warning in test output
    const origWrite = process.stderr.write;
    let warned = false;
    process.stderr.write = ((msg: any,) =>
    {
      warned = String(msg,).includes("Unknown verdict",);
      return true;
    }) as any;
    const a: any = engine.step(db, "s1", "GARBAGE",);
    process.stderr.write = origWrite;
    assert.strictEqual(a.action, "done",);
    assert.strictEqual(warned, true,);
  },);
});

test("step returns null for completed pipeline", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "Check.", },] as VerificationStep[],);
    engine.step(db, "s1", "PASS",);
    assert.strictEqual(engine.step(db, "s1", "PASS",), null,);
  },);
});

console.log("\n=== pipeline.js: role-aware step (source in revision) ===",);

test("step({ role: 'source' }) in revision reactivates revise step", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    engine.step(db, "s1", "REVISE",); // → revision
    const a: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", },);
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "reviewer",);
    assert.strictEqual(crud.getPipelineState(db, "s1",)!.status, "normal",);
  },);
});

test("step({ role: 'fixer' }) reactivates fix step", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
    ] as VerificationStep[],);
    engine.step(db, "s1", "REVISE",); // → fix
    const a: any = engine.step(db, "s1", { role: "fixer", artifactVerdict: "PASS", },);
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "reviewer",); // reviewer re-runs, not fixer
  },);
});

test("step({ role: 'source' }) does NOT advance VERIFY step", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    // Source completes with PASS — should NOT advance the VERIFY step
    const a: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", },);
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "reviewer",); // reviewer should still be expected
    // Step should still be active, not passed
    assert.strictEqual(crud.getActiveStep(db, "s1",)!.status, "active",);
    assert.strictEqual(crud.getActiveStep(db, "s1",)!.step_type, "VERIFY",);
  },);
});

test("step({ role: 'source' }) advances CHECK step", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "CHECK", prompt: "Check.", },
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    const a: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", },);
    // CHECK passed, VERIFY now active
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "reviewer",);
    assert.strictEqual(crud.getStep(db, "s1", 0,)!.status, "passed",);
    assert.strictEqual(crud.getStep(db, "s1", 1,)!.status, "active",);
  },);
});

test("retryGateAgent increments round and re-runs", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    // Hook layer calls retryGateAgent when gater semantic check fails
    const a: any = engine.retryGateAgent(db, "s1",);
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "reviewer",);
    assert.strictEqual(a.round, 1,); // round incremented from 0
  },);
});

test("retryGateAgent exhaustion after maxRounds", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 1, },
    ] as VerificationStep[],);
    // First retry → round 1 (1 > 1 = false, retry)
    let a: any = engine.retryGateAgent(db, "s1",);
    assert.strictEqual(a.action, "spawn",); // retried
    // Second retry → round 2 (2 > 1 = true, exhausted)
    a = engine.retryGateAgent(db, "s1",);
    assert.strictEqual(a.action, "failed",);
    assert.strictEqual(a.round, 2,);
    assert.strictEqual(a.maxRounds, 1,);
  },);
});

console.log("\n=== pipeline.js: getNextAction ===",);

test("getNextAction returns semantic for step 0", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "CHECK", prompt: "Check.", },
    ] as VerificationStep[],);
    const a: any = engine.getNextAction(db, "s1",);
    assert.strictEqual(a.action, "semantic",);
  },);
});

test("getNextAction returns spawn for VERIFY", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "CHECK", prompt: "Check.", },
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    engine.step(db, "s1", "PASS",);
    const a: any = engine.getNextAction(db, "s1",);
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "reviewer",);
    assert.strictEqual(a.round, 0,);
    assert.strictEqual(a.maxRounds, 3,);
  },);
});

test("getNextAction returns source during revision", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    engine.step(db, "s1", "REVISE",);
    const a: any = engine.getNextAction(db, "s1",);
    assert.strictEqual(a.action, "source",);
    assert.strictEqual(a.agent, "worker",);
  },);
});

test("getNextAction returns fixer during fix", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
    ] as VerificationStep[],);
    engine.step(db, "s1", "REVISE",);
    const a: any = engine.getNextAction(db, "s1",);
    assert.strictEqual(a.action, "source",);
    assert.strictEqual(a.agent, "patcher",);
  },);
});

test("getNextAction returns null for completed", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "A", },] as VerificationStep[],);
    engine.step(db, "s1", "PASS",);
    assert.strictEqual(engine.getNextAction(db, "s1",), null,);
  },);
});

test("getNextAction returns null for failed", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "VERIFY", agent: "rev", maxRounds: 0, },] as VerificationStep[],);
    engine.step(db, "s1", "REVISE",); // round 1 > 0 → exhausted
    assert.strictEqual(engine.getNextAction(db, "s1",), null,);
  },);
});

console.log("\n=== pipeline.js: getAllNextActions ===",);

test("getAllNextActions returns actions for all active scopes", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "a", "worker-a", [{ type: "VERIFY", agent: "rev", maxRounds: 3, },] as VerificationStep[],);
    engine.createPipeline(db, "b", "worker-b", [{ type: "TRANSFORM", agent: "question", maxRounds: 1, },] as VerificationStep[],);
    const actions = engine.getAllNextActions(db,);
    assert.strictEqual(actions.length, 2,);
    const types = actions.map((a: any,) => a.action).sort();
    assert.deepStrictEqual(types, ["spawn", "spawn",],);
  },);
});

console.log("\n=== pipeline.js: resolveRole ===",);

test("resolveRole: verifier for active reviewer", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "VERIFY", agent: "reviewer", maxRounds: 3, },] as VerificationStep[],);
    assert.strictEqual(engine.resolveRole(db, "s1", "reviewer",), "verifier",);
  },);
});

test("resolveRole: fixer for fix status", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
    ] as VerificationStep[],);
    engine.step(db, "s1", "REVISE",);
    assert.strictEqual(engine.resolveRole(db, "s1", "patcher",), "fixer",);
  },);
});

test("resolveRole: source for source agent", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "VERIFY", agent: "reviewer", maxRounds: 3, },] as VerificationStep[],);
    assert.strictEqual(engine.resolveRole(db, "s1", "worker",), "source",);
  },);
});

test("resolveRole: ungated for unknown agent", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "VERIFY", agent: "reviewer", maxRounds: 3, },] as VerificationStep[],);
    assert.strictEqual(engine.resolveRole(db, "s1", "random",), "ungated",);
  },);
});

test("resolveRole: unscoped search across pipelines", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "VERIFY", agent: "reviewer", maxRounds: 3, },] as VerificationStep[],);
    assert.strictEqual(engine.resolveRole(db, null as any, "reviewer",), "verifier",);
    assert.strictEqual(engine.resolveRole(db, null as any, "unknown",), "ungated",);
  },);
});

// ══════════════════════════════════════════════════════════════════════
// Integration: full pipeline flows
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== Integration: full happy path ===",);

test("4-step pipeline: CHECK → TRANSFORM → VERIFY → VERIFY_W_FIXER", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "full", "worker", [
      { type: "CHECK", prompt: "Check quality.", },
      { type: "TRANSFORM", agent: "question", maxRounds: 1, },
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
      { type: "VERIFY_W_FIXER", agent: "playtester", maxRounds: 2, fixer: "patcher", },
    ] as VerificationStep[],);

    let a: any = engine.step(db, "full", "PASS",); // CHECK → TRANSFORM
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "question",);
    a = engine.step(db, "full", { role: "transformer", artifactVerdict: "", },); // TRANSFORM → VERIFY
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "reviewer",);
    a = engine.step(db, "full", "PASS",); // VERIFY → VERIFY_W_FIXER
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "playtester",);
    a = engine.step(db, "full", "PASS",); // done
    assert.strictEqual(a.action, "done",);
  },);
});

console.log("\n=== Integration: revise + fixer flow ===",);

test("VERIFY_W_FIXER: revise → fixer → reactivate → pass", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "fix", "worker", [
      { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
    ] as VerificationStep[],);
    let a: any = engine.step(db, "fix", "REVISE",); // → fixer
    assert.strictEqual(a.action, "source",);
    assert.strictEqual(a.agent, "patcher",);

    a = engine.step(db, "fix", { role: "fixer", artifactVerdict: "PASS", },); // fixer done → reactivate
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "reviewer",);

    a = engine.step(db, "fix", "PASS",); // reviewer passes
    assert.strictEqual(a.action, "done",);
  },);
});

console.log("\n=== Integration: multi-round revise ===",);

test("VERIFY: maxRounds=2 exhausts after 2 revisions (3rd REVISE fails)", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "exh", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 2, },
    ] as VerificationStep[],);
    // Round 1/2: REVISE (within bounds)
    let a: any = engine.step(db, "exh", "REVISE",);
    assert.strictEqual(a.action, "source",);
    engine.step(db, "exh", { role: "source", artifactVerdict: "PASS", },);

    // Round 2/2: REVISE (within bounds)
    a = engine.step(db, "exh", "REVISE",);
    assert.strictEqual(a.action, "source",);
    engine.step(db, "exh", { role: "source", artifactVerdict: "PASS", },);

    // Round 3/2: REVISE → 3 > 2 → exhausted
    a = engine.step(db, "exh", "REVISE",);
    assert.strictEqual(a.action, "failed",);
    assert.strictEqual(a.round, 3,);
    assert.strictEqual(a.maxRounds, 2,);
  },);
});

console.log("\n=== Integration: parallel pipelines ===",);

test("Two scopes run independently", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "a", "wa", [{ type: "VERIFY", agent: "rev", maxRounds: 3, },] as VerificationStep[],);
    engine.createPipeline(db, "b", "wb", [{ type: "VERIFY", agent: "rev", maxRounds: 3, },] as VerificationStep[],);

    engine.step(db, "a", "REVISE",);
    engine.step(db, "b", "PASS",);

    assert.strictEqual(crud.getPipelineState(db, "a",)!.status, "revision",);
    assert.strictEqual(crud.getPipelineState(db, "b",)!.status, "completed",);
  },);
});

test("Parallel scopes with same agent name: independent actions", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "auth", "impl", [{ type: "VERIFY", agent: "reviewer", maxRounds: 3, },] as VerificationStep[],);
    engine.createPipeline(db, "ui", "impl", [{ type: "VERIFY", agent: "reviewer", maxRounds: 3, },] as VerificationStep[],);

    const actions = engine.getAllNextActions(db,);
    assert.strictEqual(actions.length, 2, "Both scopes should have actions",);
    const scopes = actions.map(a => a.scope).sort();
    assert.deepStrictEqual(scopes, ["auth", "ui",], "Both scopes present",);

    // REVISE one, PASS the other
    engine.step(db, "auth", "REVISE",);
    engine.step(db, "ui", "PASS",);

    assert.strictEqual(crud.getPipelineState(db, "auth",)!.status, "revision",);
    assert.strictEqual(crud.getPipelineState(db, "ui",)!.status, "completed",);

    // After REVISE, step is in "revise" status — reviewer is no longer active (it's source's turn)
    const roleAuth = engine.resolveRole(db, "auth", "reviewer",);
    assert.strictEqual(roleAuth, "ungated", "reviewer ungated during revision (source's turn)",);

    // Source agent resolves correctly during revision
    const roleSource = engine.resolveRole(db, "auth", "impl",);
    assert.strictEqual(roleSource, "source", "source agent resolves as source during revision",);

    // resolveRole without scope prefers revision pipeline for source resolution
    const roleNoScope = engine.resolveRole(db, "", "impl",);
    assert.strictEqual(roleNoScope, "source", "no-scope fallback finds source in revision pipeline",);
  },);
});

test("findAgentScope prefers active pipeline", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "old", "impl", [{ type: "VERIFY", agent: "reviewer", maxRounds: 3, },] as VerificationStep[],);
    engine.step(db, "old", "PASS",); // complete
    engine.createPipeline(db, "new", "impl", [{ type: "VERIFY", agent: "reviewer", maxRounds: 3, },] as VerificationStep[],);

    // Register reviewer in both scopes
    crud.registerAgent(db, "old", "reviewer", "old/reviewer.md",);
    crud.registerAgent(db, "new", "reviewer", "new/reviewer.md",);

    const found = crud.findAgentScope(db, "reviewer",);
    assert.strictEqual(found, "new", "Should prefer scope with active pipeline",);
  },);
});

// ══════════════════════════════════════════════════════════════════════
// Hook integration: pipeline-block.js patterns
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== Hook: pipeline-block patterns ===",);

test("getAllNextActions returns spawn actions for block enforcement", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    const actions = engine.getAllNextActions(db,);
    assert.strictEqual(actions.length, 1,);
    assert.strictEqual(actions[0].action, "spawn",);
    assert.strictEqual((actions[0] as any).agent, "reviewer",);
    assert.strictEqual((actions[0] as any).scope, "s1",);
  },);
});

test("getAllNextActions returns source action during revision", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    engine.step(db, "s1", "REVISE",);
    const actions = engine.getAllNextActions(db,);
    assert.strictEqual(actions.length, 1,);
    assert.strictEqual(actions[0].action, "source",);
    assert.strictEqual((actions[0] as any).agent, "worker",);
  },);
});

test("getAllNextActions empty after pipeline completes", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "A", },] as VerificationStep[],);
    engine.step(db, "s1", "PASS",);
    const actions = engine.getAllNextActions(db,);
    assert.strictEqual(actions.length, 0,);
  },);
});

test("CHECK-only pipeline: getAllNextActions returns semantic action", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "A", },] as VerificationStep[],);
    const actions = engine.getAllNextActions(db,);
    assert.strictEqual(actions.length, 1,);
    assert.strictEqual(actions[0].action, "semantic",);
    // pipeline-block treats semantic as blocking (source must re-run)
  },);
});

test("CHECK action includes source_agent for pipeline-block", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "A", },] as VerificationStep[],);
    const actions = engine.getAllNextActions(db,);
    assert.strictEqual((actions[0] as any).step.source_agent, "worker",);
    // pipeline-block uses step.source_agent when act.agent is null
  },);
});

test("CHECK action blocks: source_agent resolvable from step", () =>
{
  // Regression: pipeline-block didn't recognize "semantic" action, letting orchestrator bypass
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "fix-1", "fixer", [
      { type: "CHECK", prompt: "Check fix", },
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    const actions = engine.getAllNextActions(db,);
    const sem = actions.find((a: any,) => a.scope === "fix-1");
    assert.strictEqual(sem!.action, "semantic",);
    assert.strictEqual((sem as any).step.source_agent, "fixer",);
    // pipeline-block should treat this as: Resume fixer (scope=fix-1)
  },);
});

test("getAllNextActions parallel: one completed, one active", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "a", "wa", [{ type: "CHECK", prompt: "A", },] as VerificationStep[],);
    engine.createPipeline(db, "b", "wb", [{ type: "VERIFY", agent: "rev", maxRounds: 3, },] as VerificationStep[],);
    engine.step(db, "a", "PASS",);
    const actions = engine.getAllNextActions(db,);
    assert.strictEqual(actions.length, 1,);
    assert.strictEqual((actions[0] as any).scope, "b",);
  },);
});

// ══════════════════════════════════════════════════════════════════════
// Hook integration: pipeline-conditions.js patterns
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== Hook: pipeline-conditions patterns ===",);

test("step enforcement: spawn action allows matching gate agent", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    const actions = engine.getAllNextActions(db,);
    const scopeAction: any = actions.find((a: any,) => a.scope === "s1");
    assert.strictEqual(scopeAction.action, "spawn",);
    assert.strictEqual(scopeAction.agent, "reviewer",);
    // conditions.js would allow reviewer, block anything else
  },);
});

test("step enforcement: source action returns fixer during fix", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
    ] as VerificationStep[],);
    engine.step(db, "s1", "REVISE",); // → fix
    const actions = engine.getAllNextActions(db,);
    const scopeAction: any = actions.find((a: any,) => a.scope === "s1");
    assert.strictEqual(scopeAction.action, "source",);
    assert.strictEqual(scopeAction.agent, "patcher",); // fixer, not source_agent
  },);
});

test("no pipeline for scope allows agent spawn", () =>
{
  withDb((db: any,) =>
  {
    const actions = engine.getAllNextActions(db,);
    assert.strictEqual(actions.length, 0,);
    // conditions.js: no actions → allow any agent (new scope)
  },);
});

// ══════════════════════════════════════════════════════════════════════
// Hook integration: pipeline-injection.js patterns
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== Hook: pipeline-injection patterns ===",);

test("createPipeline is idempotent", () =>
{
  withDb((db: any,) =>
  {
    const steps: VerificationStep[] = [
      { type: "CHECK", prompt: "Check.", },
      { type: "VERIFY", agent: "rev", maxRounds: 3, },
    ];
    engine.createPipeline(db, "s1", "worker", steps,);
    engine.createPipeline(db, "s1", "worker", steps,); // no-op
    assert.strictEqual(crud.getSteps(db, "s1",).length, 2,);
    assert.strictEqual(crud.getPipelineState(db, "s1",)!.total_steps, 2,);
  },);
});

test("resolveRole works for verifier context enrichment", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
    ] as VerificationStep[],);
    assert.strictEqual(engine.resolveRole(db, "s1", "reviewer",), "verifier",);
    const activeStep = crud.getActiveStep(db, "s1",)!;
    assert.strictEqual(activeStep.agent, "reviewer",);
    assert.strictEqual(activeStep.fixer, "patcher",);
    assert.strictEqual(activeStep.max_rounds, 3,);
  },);
});

test("resolveRole returns fixer for fix step context", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
    ] as VerificationStep[],);
    engine.step(db, "s1", "REVISE",); // → fix status
    assert.strictEqual(engine.resolveRole(db, "s1", "patcher",), "fixer",);
    const fixStep = crud.getStepByStatus(db, "s1", "fix",);
    assert.ok(fixStep,);
    assert.strictEqual(fixStep!.fixer, "patcher",);
  },);
});

test("injection path: findAgentScope finds scope registered by conditions", () =>
{
  withDb((db: any,) =>
  {
    // Simulate conditions.js registering agent with real scope
    crud.registerAgent(db, "my-scope", "builder", "/path/to/artifact.md",);
    // Simulate injection.js using findAgentScope (not getPending)
    const scope = crud.findAgentScope(db, "builder",)!;
    assert.strictEqual(scope, "my-scope",);
    // Verify pipeline can be created with found scope
    engine.createPipeline(db, scope, "builder", [{ type: "CHECK", prompt: "Check.", },] as VerificationStep[],);
    assert.ok(crud.pipelineExists(db, scope,),);
  },);
});

test("source semantic FAIL overrides artifact PASS in engine", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "CHECK", prompt: "Check quality.", },
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    // Source artifact says PASS but semantic says FAIL → engine should get FAIL
    const a: any = engine.step(db, "s1", { role: "source", artifactVerdict: "FAIL", },);
    // FAIL normalized to REVISE → source action (source re-runs)
    assert.strictEqual(a.action, "source",);
    assert.strictEqual(crud.getPipelineState(db, "s1",)!.status, "revision",);
  },);
});

test("CHECK FAIL → revision → source re-completes → step reactivated correctly", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "CHECK", prompt: "Check quality.", },
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    // Source fails CHECK check → pipeline enters revision
    const a1: any = engine.step(db, "s1", { role: "source", artifactVerdict: "FAIL", },);
    assert.strictEqual(a1.action, "source",);
    assert.strictEqual(crud.getPipelineState(db, "s1",)!.status, "revision",);
    assert.strictEqual(crud.getStep(db, "s1", 0,)!.status, "revise",);

    // Source re-completes → reactivate CHECK step
    const a2: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", },);
    // Should return semantic action (step reactivated)
    assert.strictEqual(a2.action, "semantic",);
    assert.strictEqual(crud.getPipelineState(db, "s1",)!.status, "normal",);
    assert.strictEqual(crud.getStep(db, "s1", 0,)!.status, "active",);

    // Now CHECK can be re-run and passed
    const a3: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", },);
    assert.strictEqual(a3.action, "spawn",);
    assert.strictEqual(a3.agent, "reviewer",);
  },);
});

// ══════════════════════════════════════════════════════════════════════
// Hook integration: pipeline-verification.js patterns
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== Hook: pipeline-verification patterns ===",);

test("source step({ role: 'source' }) in revision reactivates step", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    engine.step(db, "s1", "REVISE",); // reviewer → revise → source must re-run
    assert.strictEqual(crud.getPipelineState(db, "s1",)!.status, "revision",);

    // Source re-completes — engine detects revision state
    const a: any = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", },);
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "reviewer",);
    assert.strictEqual(crud.getPipelineState(db, "s1",)!.status, "normal",);
  },);
});

test("fixer step({ role: 'fixer' }) reactivates step", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
    ] as VerificationStep[],);
    engine.step(db, "s1", "REVISE",); // → fix
    assert.strictEqual(crud.getStepByStatus(db, "s1", "fix",)!.fixer, "patcher",);

    const a: any = engine.step(db, "s1", { role: "fixer", artifactVerdict: "PASS", },);
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "reviewer",); // reviewer re-runs
  },);
});

test("gate agent PASS advances to next step", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "rev1", maxRounds: 3, },
      { type: "VERIFY", agent: "rev2", maxRounds: 2, },
    ] as VerificationStep[],);
    const a: any = engine.step(db, "s1", "PASS",); // rev1 passes → rev2 active
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "rev2",);
    assert.strictEqual(crud.getStep(db, "s1", 0,)!.status, "passed",);
    assert.strictEqual(crud.getStep(db, "s1", 1,)!.status, "active",);
  },);
});

test("retryGateAgent round increment + step stays active", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ] as VerificationStep[],);
    const a: any = engine.retryGateAgent(db, "s1",);
    assert.strictEqual(a.action, "spawn",);
    assert.strictEqual(a.agent, "reviewer",);
    assert.strictEqual(a.round, 1,); // round incremented
    assert.strictEqual(crud.getActiveStep(db, "s1",)!.status, "active",);
  },);
});

test("retryGateAgent exhaustion with maxRounds=0", () =>
{
  withDb((db: any,) =>
  {
    engine.createPipeline(db, "s1", "worker", [
      { type: "VERIFY", agent: "reviewer", maxRounds: 0, },
    ] as VerificationStep[],);
    // maxRounds=0: first retry → round 1, 1 > 0 → exhausted
    const a: any = engine.retryGateAgent(db, "s1",);
    assert.strictEqual(a.action, "failed",);
    assert.strictEqual(crud.getPipelineState(db, "s1",)!.status, "failed",);
  },);
});

test("agent CRUD: register and retrieve", () =>
{
  withDb((db: any,) =>
  {
    crud.registerAgent(db, "s1", "worker", "/path/to/artifact.md",);
    const agent = crud.getAgent(db, "s1", "worker",)!;
    assert.strictEqual(agent.agent, "worker",);
    assert.strictEqual(agent.outputFilepath, "/path/to/artifact.md",);
    assert.strictEqual(agent.verdict, null,);
  },);
});

test("agent CRUD: set verdict and retrieve", () =>
{
  withDb((db: any,) =>
  {
    crud.registerAgent(db, "s1", "worker", "/path.md",);
    crud.setVerdict(db, "s1", "worker", "PASS", 1,);
    const agent = crud.getAgent(db, "s1", "worker",)!;
    assert.strictEqual(agent.verdict, "PASS",);
    assert.strictEqual(agent.round, 1,);
  },);
});

test("findAgentScope finds agent by type", () =>
{
  withDb((db: any,) =>
  {
    crud.registerAgent(db, "my-scope", "worker", "/path.md",);
    const scope = crud.findAgentScope(db, "worker",);
    assert.strictEqual(scope, "my-scope",);
  },);
});

test("edit tracking: record and retrieve", () =>
{
  withDb((db: any,) =>
  {
    crud.addEdit(db, "/foo.ts", 10,);
    crud.addEdit(db, "/bar.ts", 5,);
    crud.addEdit(db, "/foo.ts", 3,); // accumulate
    const edits = crud.getEdits(db,);
    assert.ok(edits.includes("/foo.ts",),);
    assert.ok(edits.includes("/bar.ts",),);
    const counts = crud.getEditCounts(db,);
    assert.strictEqual(counts.files, 2,);
    assert.strictEqual(counts.lines, 18,); // 10+3+5
  },);
});

test("tool history: add and retrieve hashes", () =>
{
  withDb((db: any,) =>
  {
    crud.addToolHash(db, "aaa",);
    crud.addToolHash(db, "bbb",);
    crud.addToolHash(db, "ccc",);
    const last2 = crud.getLastNHashes(db, 2,);
    assert.strictEqual(last2.length, 2,);
    assert.strictEqual(last2[0], "ccc",);
    assert.strictEqual(last2[1], "bbb",);
  },);
});

test("isCleared: true after registerAgent, false for unknown", () =>
{
  withDb((db: any,) =>
  {
    assert.strictEqual(crud.isCleared(db, "s1", "ghost",), false,);
    crud.registerAgent(db, "s1", "ghost", "/ghost.md",);
    assert.strictEqual(crud.isCleared(db, "s1", "ghost",), true,);
  },);
});

test("getPending: returns _pending agents, null otherwise", () =>
{
  withDb((db: any,) =>
  {
    assert.strictEqual(crud.getPending(db, "worker",), null,);
    crud.registerAgent(db, "_pending", "worker", "/tmp/worker.md",);
    const p = crud.getPending(db, "worker",);
    assert.ok(p,);
    assert.strictEqual(p!.scope, "_pending",);
    assert.strictEqual(p!.outputFilepath, "/tmp/worker.md",);
  },);
});

test("getDb creates session dir if missing", () =>
{
  const tmpDir = path.join(os.tmpdir(), `cg-test-mkdir-${Date.now()}`,);
  const sessDir = path.join(tmpDir, "new-session",);
  try
  {
    const db = crud.getDb(sessDir,);
    assert.ok(fs.existsSync(path.join(sessDir, "session.db",),),);
    db.close();
  }
  finally
  {
    try
    {
      fs.rmSync(tmpDir, { recursive: true, },);
    }
    catch
    {
    }
  }
});

// ── FrontmatterParser utility coverage ──────────────────────────────

test("getSessionDir truncates UUID to 8 hex chars", () =>
{
  const dir = crud.getSessionDir("689b2e01-abcd-1234-5678-abcdef012345",);
  assert.ok(dir.endsWith("/689b2e01",) || dir.endsWith("\\689b2e01",),);
  assert.ok(dir.includes(".sessions",),);
});

test("agentRunningMarker returns .running-{scope} path", () =>
{
  const marker = crud.agentRunningMarker("/tmp/sessions/abc", "task-1",);
  assert.ok(marker.includes(".running-task-1",),);
  assert.ok(marker.startsWith("/tmp/sessions/abc",),);
});

test("findAgentMd returns null for nonexistent agent", () =>
{
  const result = shared.findAgentMd("nonexistent-agent-xyz", process.cwd(), os.homedir(),);
  assert.strictEqual(result, null,);
});

test("trace writes audit.jsonl entry", () =>
{
  const tmpDir = path.join(os.tmpdir(), `cg-test-trace-${Date.now()}`,);
  fs.mkdirSync(tmpDir, { recursive: true, },);
  try
  {
    auditTrace(tmpDir, "test.op", "test-scope", { key: "val", },);
    const content = fs.readFileSync(path.join(tmpDir, "audit.jsonl",), "utf-8",).trim();
    const entry = JSON.parse(content,);
    assert.strictEqual(entry.op, "test.op",);
    assert.strictEqual(entry.scope, "test-scope",);
    assert.strictEqual(entry.key, "val",);
    assert.ok(entry.ts,);
  }
  finally
  {
    try
    {
      fs.rmSync(tmpDir, { recursive: true, },);
    }
    catch
    {
    }
  }
});

test("trace silently fails on bad path", () =>
{
  // Should not throw
  auditTrace("/nonexistent/path/that/cant/exist", "test", null,);
});

// ══════════════════════════════════════════════════════════════════════
// Regression: MCP verdict flow bugs found during stress-testing (2026-04-03)
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== Regression: MCP verdict flow ===",);

test("MCP gate_verdict records verdict WITHOUT driving engine.step (no double-advance)", () =>
{
  // Bug: gate_verdict called engine.step AND hook called engine.step → double advance.
  // Fix: MCP server only records verdict (setVerdict), hook drives engine.step.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-mcp-regr-",),);
  const db = crud.getDb(tmpDir,);

  // Setup: 2-step pipeline (CHECK → VERIFY)
  const steps: VerificationStep[] = [
    { type: "CHECK", prompt: "Check it.", },
    { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
  ];
  engine.createPipeline(db, "mcp-regr", "worker", steps,);

  // Simulate what MCP gate_verdict does: record verdict only
  crud.setVerdict(db, "mcp-regr", "worker", "PASS", 0,);

  // Pipeline should NOT have advanced — still on step 0
  const state = crud.getPipelineState(db, "mcp-regr",);
  assert.ok(state,);
  assert.strictEqual(state!.current_step, 0, "MCP setVerdict should not advance pipeline",);
  assert.strictEqual(state!.status, "normal",);

  // Hook drives engine.step — THIS advances the pipeline
  const action = engine.step(db, "mcp-regr", { role: "source", artifactVerdict: "PASS", },);
  assert.ok(action,);

  const stateAfter = crud.getPipelineState(db, "mcp-regr",);
  assert.strictEqual(stateAfter!.current_step, 1, "engine.step should advance to step 1",);

  db.close();
  try
  {
    fs.rmSync(tmpDir, { recursive: true, },);
  }
  catch
  {
  }
});

test("verifier verdict recorded in DB is readable after setVerdict", () =>
{
  // Bug: runSemanticCheck returned null when gater used MCP (no Result: line).
  // Fix: after runSemanticCheck, check DB for MCP verdict.
  // This test verifies the DB path works correctly.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-dbverdict-",),);
  const db = crud.getDb(tmpDir,);

  const steps: VerificationStep[] = [
    { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
  ];
  engine.createPipeline(db, "dbv-scope", "worker", steps,);

  // Register agent first (conditions hook does this), then simulate MCP gate_verdict
  crud.registerAgent(db, "dbv-scope", "reviewer", `${tmpDir}/dbv-scope/reviewer.md`,);
  crud.setVerdict(db, "dbv-scope", "reviewer", "PASS", 1,);

  // Verify the verdict is readable
  const agentRow = crud.getAgent(db, "dbv-scope", "reviewer",);
  assert.ok(agentRow, "agent row should exist",);
  assert.strictEqual(agentRow!.verdict, "PASS",);
  assert.strictEqual(agentRow!.round, 1,);

  db.close();
  try
  {
    fs.rmSync(tmpDir, { recursive: true, },);
  }
  catch
  {
  }
});

test("engine.step with verifier PASS advances VERIFY step (hook-driven path)", () =>
{
  // Regression: ensures the hook-driven engine.step path works for verifiers
  // after MCP records the verdict (no double-advance).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-hookdrv-",),);
  const db = crud.getDb(tmpDir,);

  const steps: VerificationStep[] = [
    { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
  ];
  engine.createPipeline(db, "hookdrv", "worker", steps,);

  // MCP records verdict
  crud.setVerdict(db, "hookdrv", "reviewer", "PASS", 0,);

  // Hook drives engine.step with the verdict
  const action = engine.step(db, "hookdrv", { role: "verifier", artifactVerdict: "PASS", },);
  assert.ok(action,);
  assert.strictEqual(action!.action, "done", "single VERIFY step PASS should complete pipeline",);

  const state = crud.getPipelineState(db, "hookdrv",);
  assert.strictEqual(state!.status, "completed",);

  db.close();
  try
  {
    fs.rmSync(tmpDir, { recursive: true, },);
  }
  catch
  {
  }
});

test("engine.step with verifier REVISE routes to fixer (hook-driven path)", () =>
{
  // Regression: REVISE via hook-driven path should route to fixer, not double-advance.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-revfixer-",),);
  const db = crud.getDb(tmpDir,);

  const steps: VerificationStep[] = [
    { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "fixer", },
  ];
  engine.createPipeline(db, "revfix", "worker", steps,);

  // MCP records REVISE verdict
  crud.setVerdict(db, "revfix", "reviewer", "REVISE", 0,);

  // Hook drives engine.step
  const action = engine.step(db, "revfix", { role: "verifier", artifactVerdict: "REVISE", },);
  assert.ok(action,);
  assert.strictEqual(action!.action, "source", "REVISE on VERIFY_W_FIXER should route to fixer",);
  assert.strictEqual((action as any).agent, "fixer",);

  const state = crud.getPipelineState(db, "revfix",);
  assert.strictEqual(state!.status, "revision",);

  db.close();
  try
  {
    fs.rmSync(tmpDir, { recursive: true, },);
  }
  catch
  {
  }
});

test("retryGateAgent multi-round exhaustion (regression: null semanticVerdict loop)", () =>
{
  // Bug: null semanticVerdict bypassed retryGateAgent check → revise() → fixer → infinite loop.
  // Fix: hook layer calls retryGateAgent directly. Engine is a pure state machine.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-nullsem-",),);
  const db = crud.getDb(tmpDir,);

  const steps: VerificationStep[] = [
    { type: "VERIFY", agent: "reviewer", maxRounds: 2, },
  ];
  engine.createPipeline(db, "nullsem", "worker", steps,);

  // Round 1: hook calls retryGateAgent (round 0→1)
  const a1 = engine.retryGateAgent(db, "nullsem",);
  assert.ok(a1,);
  assert.strictEqual(a1!.action, "spawn", "retryGateAgent should re-spawn reviewer",);
  const step1 = crud.getActiveStep(db, "nullsem",);
  assert.strictEqual(step1!.round, 1,);

  // Round 2: retry (round 1→2)
  const a2 = engine.retryGateAgent(db, "nullsem",);
  assert.ok(a2,);
  assert.strictEqual(a2!.action, "spawn",);
  const step2 = crud.getActiveStep(db, "nullsem",);
  assert.strictEqual(step2!.round, 2,);

  // Round 3: exhaustion (round 2→3, 3 > maxRounds=2)
  const a3 = engine.retryGateAgent(db, "nullsem",);
  assert.ok(a3,);
  assert.strictEqual(a3!.action, "failed", "should exhaust after maxRounds retries",);

  const state = crud.getPipelineState(db, "nullsem",);
  assert.strictEqual(state!.status, "failed",);

  db.close();
  try
  {
    fs.rmSync(tmpDir, { recursive: true, },);
  }
  catch
  {
  }
});

test("REVISE artifact + FAIL semantic routes to fixer, not retryGateAgent", () =>
{
  // Bug: when reviewer says REVISE but gater semantic check returns FAIL (or null→FAIL),
  // engine.retryGateAgent fired instead of revise() — fixer never ran.
  // Fix: engine.step skips retryGateAgent when artifactVerdict is REVISE.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-revfail-",),);
  const db = crud.getDb(tmpDir,);

  const steps: VerificationStep[] = [
    { type: "VERIFY_W_FIXER", agent: "reviewer", fixer: "fixer-agent", maxRounds: 3, },
  ];
  engine.createPipeline(db, "revfail", "worker", steps,);

  // Reviewer says REVISE, gater semantic check fails → should still route to fixer
  const a1 = engine.step(db, "revfail", { role: "verifier", artifactVerdict: "REVISE", },);
  assert.ok(a1,);
  assert.strictEqual(a1!.action, "source", "REVISE + FAIL semantic should route to fixer, not retry",);
  assert.strictEqual(a1!.agent, "fixer-agent", "should spawn fixer, not retry reviewer",);

  const step1 = crud.getStepByStatus(db, "revfail", "fix",);
  assert.ok(step1, "step should be in 'fix' status",);

  db.close();
  try
  {
    fs.rmSync(tmpDir, { recursive: true, },);
  }
  catch
  {
  }
});

test("PASS artifact + semantic FAIL: hook retries via retryGateAgent (regression)", () =>
{
  // Bug: handleVerifier overrode artifactVerdict PASS→FAIL before engine.step,
  // so engine saw FAIL → normalizeVerdict("FAIL")="REVISE" → revise() → fixer.
  // Fix: hook layer intercepts semantic FAIL and calls retryGateAgent instead of step.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-passfail-",),);
  const db = crud.getDb(tmpDir,);

  const steps: VerificationStep[] = [
    { type: "VERIFY_W_FIXER", agent: "reviewer", fixer: "fixer-agent", maxRounds: 3, },
  ];
  engine.createPipeline(db, "passfail", "worker", steps,);

  // Hook layer detects semantic FAIL → calls retryGateAgent (not step)
  const a1 = engine.retryGateAgent(db, "passfail",);
  assert.ok(a1,);
  assert.strictEqual(a1!.action, "spawn", "retryGateAgent should re-spawn reviewer, not route to fixer",);
  const fixRow = crud.getStepByStatus(db, "passfail", "fix",);
  assert.strictEqual(fixRow, null, "step should NOT be in fix status",);

  db.close();
  try
  {
    fs.rmSync(tmpDir, { recursive: true, },);
  }
  catch
  {
  }
});

test("FAIL artifact + semantic FAIL: hook retries via retryGateAgent (regression)", () =>
{
  // FAIL means "unfixable" — hook detects semantic FAIL → retryGateAgent (bad review quality).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-failfail-",),);
  const db = crud.getDb(tmpDir,);

  const steps: VerificationStep[] = [
    { type: "VERIFY_W_FIXER", agent: "reviewer", fixer: "fixer-agent", maxRounds: 3, },
  ];
  engine.createPipeline(db, "failfail", "worker", steps,);

  const a1 = engine.retryGateAgent(db, "failfail",);
  assert.ok(a1,);
  assert.strictEqual(a1!.action, "spawn", "retryGateAgent should retry reviewer",);
  const fixRow = crud.getStepByStatus(db, "failfail", "fix",);
  assert.strictEqual(fixRow, null, "step should NOT be in fix status",);

  db.close();
  try
  {
    fs.rmSync(tmpDir, { recursive: true, },);
  }
  catch
  {
  }
});

test("UNKNOWN artifact + semantic FAIL: hook retries via retryGateAgent (regression)", () =>
{
  // Most common real-world case: no Result: line found. Hook calls retryGateAgent.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-unkfail-",),);
  const db = crud.getDb(tmpDir,);

  const steps: VerificationStep[] = [
    { type: "VERIFY", agent: "reviewer", maxRounds: 2, },
  ];
  engine.createPipeline(db, "unkfail", "worker", steps,);

  const a1 = engine.retryGateAgent(db, "unkfail",);
  assert.ok(a1,);
  assert.strictEqual(a1!.action, "spawn", "retryGateAgent should retry reviewer",);

  db.close();
  try
  {
    fs.rmSync(tmpDir, { recursive: true, },);
  }
  catch
  {
  }
});

// ══════════════════════════════════════════════════════════════════════
// GateToggle — toggle command parsing + SessionManager marker
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== GateToggle: parseToggleCommand ===",);

test("parseToggleCommand matches 'gate off'", () =>
{
  assert.strictEqual(parseToggleCommand("gate off",), "off",);
});

test("parseToggleCommand matches 'gate on'", () =>
{
  assert.strictEqual(parseToggleCommand("gate on",), "on",);
});

test("parseToggleCommand matches 'gates off' (plural)", () =>
{
  assert.strictEqual(parseToggleCommand("gates off",), "off",);
});

test("parseToggleCommand matches 'gates on' (plural)", () =>
{
  assert.strictEqual(parseToggleCommand("gates on",), "on",);
});

test("parseToggleCommand matches 'gate status'", () =>
{
  assert.strictEqual(parseToggleCommand("gate status",), "status",);
});

test("parseToggleCommand matches 'gates status' (plural)", () =>
{
  assert.strictEqual(parseToggleCommand("gates status",), "status",);
});

test("parseToggleCommand is case-insensitive", () =>
{
  assert.strictEqual(parseToggleCommand("GATE OFF",), "off",);
  assert.strictEqual(parseToggleCommand("Gate On",), "on",);
  assert.strictEqual(parseToggleCommand("GATES STATUS",), "status",);
});

test("parseToggleCommand trims whitespace", () =>
{
  assert.strictEqual(parseToggleCommand("  gate off  ",), "off",);
});

test("parseToggleCommand rejects partial matches", () =>
{
  assert.strictEqual(parseToggleCommand("gate offering",), null,);
  assert.strictEqual(parseToggleCommand("the gate off",), null,);
  assert.strictEqual(parseToggleCommand("gateoff",), null,);
});

test("parseToggleCommand rejects unrelated prompts", () =>
{
  assert.strictEqual(parseToggleCommand("fix the bug",), null,);
  assert.strictEqual(parseToggleCommand("",), null,);
  assert.strictEqual(parseToggleCommand("gate",), null,);
});

console.log("\n=== SessionManager: gate toggle marker ===",);

test("isGateDisabled returns false when no marker", () =>
{
  const origCwd = process.cwd();
  const dir = tmpDir();
  process.chdir(dir,);
  try
  {
    assert.strictEqual(SessionManager.isGateDisabled(), false,);
  }
  finally
  {
    process.chdir(origCwd,);
    cleanup(dir,);
  }
});

test("setGateDisabled(true) creates marker, isGateDisabled returns true", () =>
{
  const origCwd = process.cwd();
  const dir = tmpDir();
  process.chdir(dir,);
  try
  {
    SessionManager.setGateDisabled(true,);
    assert.strictEqual(SessionManager.isGateDisabled(), true,);
    assert.ok(fs.existsSync(SessionManager.gateDisabledMarker(),),);
  }
  finally
  {
    process.chdir(origCwd,);
    cleanup(dir,);
  }
});

test("setGateDisabled(false) removes marker, isGateDisabled returns false", () =>
{
  const origCwd = process.cwd();
  const dir = tmpDir();
  process.chdir(dir,);
  try
  {
    SessionManager.setGateDisabled(true,);
    assert.strictEqual(SessionManager.isGateDisabled(), true,);
    SessionManager.setGateDisabled(false,);
    assert.strictEqual(SessionManager.isGateDisabled(), false,);
  }
  finally
  {
    process.chdir(origCwd,);
    cleanup(dir,);
  }
});

test("setGateDisabled(false) is no-op when marker absent", () =>
{
  const origCwd = process.cwd();
  const dir = tmpDir();
  process.chdir(dir,);
  try
  {
    SessionManager.setGateDisabled(false,);
    assert.strictEqual(SessionManager.isGateDisabled(), false,);
  }
  finally
  {
    process.chdir(origCwd,);
    cleanup(dir,);
  }
});

// ══════════════════════════════════════════════════════════════════════

console.log(`\n${"=".repeat(50,)}`,);
console.log(`${pass} passed, ${fail} failed`,);
process.exit(fail > 0 ? 1 : 0,);

export {};
