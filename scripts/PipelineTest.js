#!/usr/bin/env node
"use strict";
/**
 * Pipeline v3 — unit + integration tests.
 *
 * Tests: frontmatter.js (parsing), database.js (CRUD), state-machine.js (engine).
 * Run: node scripts/pipeline-test.js
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const crud = __importStar(require("./Database.js"));
const FrontmatterParser_js_1 = require("./FrontmatterParser.js");
const engine = __importStar(require("./StateMachine.js"));
const Tracing_js_1 = require("./Tracing.js");
const auditTrace = Tracing_js_1.Tracing.trace;
let pass = 0, fail = 0;
function test(name, fn) {
    try {
        fn();
        pass++;
        console.log(`  PASS: ${name}`);
    }
    catch (e) {
        fail++;
        console.log(`  FAIL: ${name} — ${e.message}`);
    }
}
function tmpDir() {
    return fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "pipeline-test-"));
}
function cleanup(dir) {
    try {
        fs_1.default.rmSync(dir, { recursive: true, force: true, });
    }
    catch {
    }
}
function withDb(fn) {
    const dir = tmpDir();
    const db = crud.getDb(dir);
    try {
        fn(db);
    }
    finally {
        db.close();
        cleanup(dir);
    }
}
// ══════════════════════════════════════════════════════════════════════
// FrontmatterParser — parsing tests
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== FrontmatterParser: extractFrontmatter ===");
test("extractFrontmatter returns YAML between fences", () => {
    assert_1.default.strictEqual(FrontmatterParser_js_1.FrontmatterParser.extractFrontmatter("---\nname: test\n---\n# Body"), "name: test");
});
test("extractFrontmatter returns null for no frontmatter", () => {
    assert_1.default.strictEqual(FrontmatterParser_js_1.FrontmatterParser.extractFrontmatter("# Just a heading"), null);
});
console.log("\n=== FrontmatterParser: parseVerification ===");
test("parse CHECK step", () => {
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification("---\nverification:\n  - [\"Verify completeness.\"]\n---\n");
    assert_1.default.strictEqual(steps.length, 1);
    assert_1.default.strictEqual(steps[0].type, "CHECK");
    assert_1.default.strictEqual(steps[0].prompt, "Verify completeness.");
});
test("parse CHECK step with single quotes", () => {
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification("---\nverification:\n  - ['Verify quality.']\n---\n");
    assert_1.default.strictEqual(steps[0].type, "CHECK");
    assert_1.default.strictEqual(steps[0].prompt, "Verify quality.");
});
test("parse slash command as TRANSFORM step", () => {
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification("---\nverification:\n  - [/question, AskUserTool]\n---\n");
    assert_1.default.strictEqual(steps[0].type, "TRANSFORM");
    assert_1.default.strictEqual(steps[0].agent, "question");
    assert_1.default.strictEqual(steps[0].maxRounds, 1);
});
test("parse slash command with multiple args still produces TRANSFORM", () => {
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification("---\nverification:\n  - [/rethink, AskUserTool, Read]\n---\n");
    assert_1.default.strictEqual(steps[0].type, "TRANSFORM");
    assert_1.default.strictEqual(steps[0].agent, "rethink");
    assert_1.default.strictEqual(steps[0].maxRounds, 1);
});
test("parse VERIFY step", () => {
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification("---\nverification:\n  - [reviewer, 3]\n---\n");
    assert_1.default.strictEqual(steps[0].type, "VERIFY");
    assert_1.default.strictEqual(steps[0].agent, "reviewer");
    assert_1.default.strictEqual(steps[0].maxRounds, 3);
});
test("parse VERIFY_W_FIXER step", () => {
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification("---\nverification:\n  - [reviewer, 3, fixer]\n---\n");
    assert_1.default.strictEqual(steps[0].type, "VERIFY_W_FIXER");
    assert_1.default.strictEqual(steps[0].fixer, "fixer");
});
test("parse mixed verification steps", () => {
    const md = "---\nverification:\n  - [\"Check.\"]\n  - [/question, AskUserTool]\n  - [reviewer, 3]\n  - [playtester, 2, fixer]\n---\n";
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification(md);
    assert_1.default.strictEqual(steps.length, 4);
    assert_1.default.strictEqual(steps[0].type, "CHECK");
    assert_1.default.strictEqual(steps[1].type, "TRANSFORM");
    assert_1.default.strictEqual(steps[2].type, "VERIFY");
    assert_1.default.strictEqual(steps[3].type, "VERIFY_W_FIXER");
});
test("parseVerification returns null for no verification field", () => {
    assert_1.default.strictEqual(FrontmatterParser_js_1.FrontmatterParser.parseVerification("---\nname: test\n---\n"), null);
});
test("parseVerification returns null for empty verification", () => {
    assert_1.default.strictEqual(FrontmatterParser_js_1.FrontmatterParser.parseVerification("---\nverification:\n---\n"), null);
});
test("parse agent name with hyphens and underscores", () => {
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification("---\nverification:\n  - [gt-reviewer_v2, 5]\n---\n");
    assert_1.default.strictEqual(steps[0].agent, "gt-reviewer_v2");
    assert_1.default.strictEqual(steps[0].maxRounds, 5);
});
console.log("\n=== FrontmatterParser: parseConditions ===");
test("parseConditions returns prompt", () => {
    const cond = FrontmatterParser_js_1.FrontmatterParser.parseConditions("---\nconditions: |\n  Check if ready.\n  Must have scope.\n---\n");
    assert_1.default.ok(cond.includes("Check if ready."));
});
test("parseConditions returns null when absent", () => {
    assert_1.default.strictEqual(FrontmatterParser_js_1.FrontmatterParser.parseConditions("---\nname: test\n---\n"), null);
});
console.log("\n=== FrontmatterParser: requiresScope ===");
test("requiresScope true for verification array", () => {
    assert_1.default.strictEqual(FrontmatterParser_js_1.FrontmatterParser.requiresScope("---\nverification:\n  - [\"Check.\"]\n---\n"), true);
});
test("requiresScope false for bare agent", () => {
    assert_1.default.strictEqual(FrontmatterParser_js_1.FrontmatterParser.requiresScope("---\nname: test\n---\n"), false);
});
test("parseVerification: TRANSFORM step (agent!)", () => {
    const md = `---\nverification:\n  - [cleaner!, 1]\n---\n`;
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification(md);
    assert_1.default.ok(steps);
    assert_1.default.strictEqual(steps.length, 1);
    assert_1.default.strictEqual(steps[0].type, "TRANSFORM");
    assert_1.default.strictEqual(steps[0].agent, "cleaner");
    assert_1.default.strictEqual(steps[0].maxRounds, 1);
});
test("parseVerification: ? and ! suffixes stripped from agent names", () => {
    const md = `---\nverification:\n  - [reviewer?, 3, fixer!]\n---\n`;
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification(md);
    assert_1.default.ok(steps);
    assert_1.default.strictEqual(steps[0].type, "VERIFY_W_FIXER");
    assert_1.default.strictEqual(steps[0].agent, "reviewer");
    assert_1.default.strictEqual(steps[0].fixer, "fixer");
});
test("TRANSFORM step: auto-advances on completion", () => {
    withDb((db) => {
        engine.createPipeline(db, "tx", "worker", [
            { type: "TRANSFORM", agent: "cleaner", maxRounds: 1, },
            { type: "CHECK", prompt: "Check.", },
        ]);
        // Transformer completes → auto-advance to next step
        const a = engine.step(db, "tx", { role: "transformer", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(a.action, "semantic", "should advance past TRANSFORM to CHECK");
    });
});
test("TRANSFORM step: getNextAction returns spawn", () => {
    withDb((db) => {
        engine.createPipeline(db, "ta", "worker", [
            { type: "TRANSFORM", agent: "cleaner", maxRounds: 1, },
        ]);
        const a = engine.getNextAction(db, "ta");
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "cleaner");
        assert_1.default.strictEqual(a.step.step_type, "TRANSFORM");
    });
});
test("TRANSFORM step: source completing auto-advances (not just transformer role)", () => {
    withDb((db) => {
        engine.createPipeline(db, "ts", "worker", [
            { type: "TRANSFORM", agent: "cleaner", maxRounds: 1, },
        ]);
        // Source agent completing a TRANSFORM step also auto-advances
        const a = engine.step(db, "ts", { role: "source", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(a.action, "done");
    });
});
test("TRANSFORM step: resolveRole returns transformer", () => {
    withDb((db) => {
        engine.createPipeline(db, "tr", "worker", [
            { type: "TRANSFORM", agent: "cleaner", maxRounds: 1, },
        ]);
        const role = engine.resolveRole(db, "tr", "cleaner");
        assert_1.default.strictEqual(role, "transformer");
    });
});
// ══════════════════════════════════════════════════════════════════════
// pipeline-db.js — CRUD tests
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== pipeline-db.js: CRUD ===");
test("getDb creates database", () => {
    withDb((db) => assert_1.default.ok(db));
});
test("insertPipeline + getPipelineState", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 2);
        const state = crud.getPipelineState(db, "s1");
        assert_1.default.strictEqual(state.source_agent, "worker");
        assert_1.default.strictEqual(state.total_steps, 2);
        assert_1.default.strictEqual(state.status, "normal");
    });
});
test("insertStep + getStep", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 1);
        crud.insertStep(db, "s1", 0, { type: "CHECK", prompt: "Check.", }, "worker");
        const step = crud.getStep(db, "s1", 0);
        assert_1.default.strictEqual(step.step_type, "CHECK");
        assert_1.default.strictEqual(step.prompt, "Check.");
        assert_1.default.strictEqual(step.status, "active"); // first step
    });
});
test("insertStep stores TRANSFORM columns for slash command", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 1);
        crud.insertStep(db, "s1", 0, { type: "TRANSFORM", agent: "question", maxRounds: 1, }, "worker");
        const step = crud.getStep(db, "s1", 0);
        assert_1.default.strictEqual(step.step_type, "TRANSFORM");
        assert_1.default.strictEqual(step.agent, "question");
        assert_1.default.strictEqual(step.max_rounds, 1);
    });
});
test("updateStepStatus + updatePipelineState", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 1);
        crud.insertStep(db, "s1", 0, { type: "CHECK", prompt: "Check.", }, "worker");
        crud.updateStepStatus(db, "s1", 0, "passed");
        crud.updatePipelineState(db, "s1", { status: "completed", });
        assert_1.default.strictEqual(crud.getStep(db, "s1", 0).status, "passed");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "completed");
    });
});
test("updateStepStatus with round", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 1);
        crud.insertStep(db, "s1", 0, { type: "VERIFY", agent: "rev", maxRounds: 3, }, "worker");
        crud.updateStepStatus(db, "s1", 0, "revise", 2);
        const step = crud.getStep(db, "s1", 0);
        assert_1.default.strictEqual(step.status, "revise");
        assert_1.default.strictEqual(step.round, 2);
    });
});
test("getStepByStatus", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 2);
        crud.insertStep(db, "s1", 0, { type: "CHECK", prompt: "A", }, "worker");
        crud.insertStep(db, "s1", 1, { type: "VERIFY", agent: "rev", maxRounds: 3, }, "worker");
        assert_1.default.strictEqual(crud.getStepByStatus(db, "s1", "active").step_index, 0);
        assert_1.default.strictEqual(crud.getStepByStatus(db, "s1", "pending").step_index, 1);
    });
});
test("deletePipeline removes all data", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 1);
        crud.insertStep(db, "s1", 0, { type: "CHECK", prompt: "A", }, "worker");
        crud.deletePipeline(db, "s1");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1"), null);
        assert_1.default.strictEqual(crud.getSteps(db, "s1").length, 0);
    });
});
test("hasNonPassedSteps", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 1);
        crud.insertStep(db, "s1", 0, { type: "CHECK", prompt: "A", }, "worker");
        assert_1.default.strictEqual(crud.hasNonPassedSteps(db, "s1"), true);
        crud.updateStepStatus(db, "s1", 0, "passed");
        assert_1.default.strictEqual(crud.hasNonPassedSteps(db, "s1"), false);
    });
});
test("registerAgent + getAgent + setVerdict", () => {
    withDb((db) => {
        crud.registerAgent(db, "scope", "worker", "/path.md");
        crud.setVerdict(db, "scope", "worker", "PASS", 1);
        const agent = crud.getAgent(db, "scope", "worker");
        assert_1.default.strictEqual(agent.verdict, "PASS");
        assert_1.default.strictEqual(agent.round, 1);
    });
});
// ══════════════════════════════════════════════════════════════════════
// pipeline.js — engine tests
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== pipeline.js: createPipeline ===");
test("createPipeline initializes state + steps", () => {
    withDb((db) => {
        engine.createPipeline(db, "e1", "worker", [
            { type: "CHECK", prompt: "Check.", },
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        assert_1.default.strictEqual(crud.getPipelineState(db, "e1").total_steps, 2);
        assert_1.default.strictEqual(crud.getSteps(db, "e1").length, 2);
    });
});
test("createPipeline is no-op if exists", () => {
    withDb((db) => {
        engine.createPipeline(db, "e1", "worker", [{ type: "CHECK", prompt: "A", },]);
        engine.createPipeline(db, "e1", "other", [{ type: "CHECK", prompt: "B", },]);
        assert_1.default.strictEqual(crud.getPipelineState(db, "e1").source_agent, "worker");
    });
});
console.log("\n=== pipeline.js: step() — unified API ===");
test("step(PASS) advances to next step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "CHECK", prompt: "Check.", },
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        const a = engine.step(db, "s1", "PASS");
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
    });
});
test("step(PASS) on last step returns done", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "Check.", },]);
        const a = engine.step(db, "s1", "PASS");
        assert_1.default.strictEqual(a.action, "done");
    });
});
test("step(CONVERGED) treated as PASS", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "Check.", },]);
        const a = engine.step(db, "s1", "CONVERGED");
        assert_1.default.strictEqual(a.action, "done");
    });
});
test("step(REVISE) on VERIFY returns source action", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "CHECK", prompt: "Check.", },
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        engine.step(db, "s1", "PASS"); // advance to VERIFY
        const a = engine.step(db, "s1", "REVISE");
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(a.agent, "worker"); // routes to source, not fixer
    });
});
test("step(REVISE) on VERIFY_W_FIXER returns fixer action", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
        ]);
        const a = engine.step(db, "s1", "REVISE");
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(a.agent, "patcher"); // routes to fixer
    });
});
test("step(FAIL) treated same as REVISE", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        const a = engine.step(db, "s1", "FAIL");
        assert_1.default.strictEqual(a.action, "source");
    });
});
test("step exhaustion returns failed after maxRounds revisions", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 1, },
        ]);
        // maxRounds=1: first REVISE → round 1 (1 > 1 = false, within bounds)
        let a = engine.step(db, "s1", "REVISE");
        assert_1.default.strictEqual(a.action, "source");
        engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", }); // reactivate
        // Second REVISE → round 2 (2 > 1 = true, exhausted)
        a = engine.step(db, "s1", "REVISE");
        assert_1.default.strictEqual(a.action, "failed");
        assert_1.default.strictEqual(a.round, 2);
        assert_1.default.strictEqual(a.maxRounds, 1);
    });
});
test("step with unknown verdict warns and passes", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "Check.", },]);
        // Redirect stderr to suppress warning in test output
        const origWrite = process.stderr.write;
        let warned = false;
        process.stderr.write = ((msg) => {
            warned = String(msg).includes("Unknown verdict");
            return true;
        });
        const a = engine.step(db, "s1", "GARBAGE");
        process.stderr.write = origWrite;
        assert_1.default.strictEqual(a.action, "done");
        assert_1.default.strictEqual(warned, true);
    });
});
test("step returns null for completed pipeline", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "Check.", },]);
        engine.step(db, "s1", "PASS");
        assert_1.default.strictEqual(engine.step(db, "s1", "PASS"), null);
    });
});
console.log("\n=== pipeline.js: role-aware step (source in revision) ===");
test("step({ role: 'source' }) in revision reactivates revise step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        engine.step(db, "s1", "REVISE"); // → revision
        const a = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "normal");
    });
});
test("step({ role: 'fixer' }) reactivates fix step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
        ]);
        engine.step(db, "s1", "REVISE"); // → fix
        const a = engine.step(db, "s1", { role: "fixer", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer"); // reviewer re-runs, not fixer
    });
});
test("step({ role: 'source' }) does NOT advance VERIFY step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        // Source completes with PASS — should NOT advance the VERIFY step
        const a = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer"); // reviewer should still be expected
        // Step should still be active, not passed
        assert_1.default.strictEqual(crud.getActiveStep(db, "s1").status, "active");
        assert_1.default.strictEqual(crud.getActiveStep(db, "s1").step_type, "VERIFY");
    });
});
test("step({ role: 'source' }) advances CHECK step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "CHECK", prompt: "Check.", },
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        const a = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", });
        // CHECK passed, VERIFY now active
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 0).status, "passed");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 1).status, "active");
    });
});
test("retryGateAgent increments round and re-runs", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        // Hook layer calls retryGateAgent when gater semantic check fails
        const a = engine.retryGateAgent(db, "s1");
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(a.round, 1); // round incremented from 0
    });
});
test("retryGateAgent exhaustion after maxRounds", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 1, },
        ]);
        // First retry → round 1 (1 > 1 = false, retry)
        let a = engine.retryGateAgent(db, "s1");
        assert_1.default.strictEqual(a.action, "spawn"); // retried
        // Second retry → round 2 (2 > 1 = true, exhausted)
        a = engine.retryGateAgent(db, "s1");
        assert_1.default.strictEqual(a.action, "failed");
        assert_1.default.strictEqual(a.round, 2);
        assert_1.default.strictEqual(a.maxRounds, 1);
    });
});
console.log("\n=== pipeline.js: getNextAction ===");
test("getNextAction returns semantic for step 0", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "CHECK", prompt: "Check.", },
        ]);
        const a = engine.getNextAction(db, "s1");
        assert_1.default.strictEqual(a.action, "semantic");
    });
});
test("getNextAction returns spawn for VERIFY", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "CHECK", prompt: "Check.", },
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        engine.step(db, "s1", "PASS");
        const a = engine.getNextAction(db, "s1");
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(a.round, 0);
        assert_1.default.strictEqual(a.maxRounds, 3);
    });
});
test("getNextAction returns source during revision", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        engine.step(db, "s1", "REVISE");
        const a = engine.getNextAction(db, "s1");
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(a.agent, "worker");
    });
});
test("getNextAction returns fixer during fix", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
        ]);
        engine.step(db, "s1", "REVISE");
        const a = engine.getNextAction(db, "s1");
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(a.agent, "patcher");
    });
});
test("getNextAction returns null for completed", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "A", },]);
        engine.step(db, "s1", "PASS");
        assert_1.default.strictEqual(engine.getNextAction(db, "s1"), null);
    });
});
test("getNextAction returns null for failed", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "VERIFY", agent: "rev", maxRounds: 0, },]);
        engine.step(db, "s1", "REVISE"); // round 1 > 0 → exhausted
        assert_1.default.strictEqual(engine.getNextAction(db, "s1"), null);
    });
});
console.log("\n=== pipeline.js: getAllNextActions ===");
test("getAllNextActions returns actions for all active scopes", () => {
    withDb((db) => {
        engine.createPipeline(db, "a", "worker-a", [{ type: "VERIFY", agent: "rev", maxRounds: 3, },]);
        engine.createPipeline(db, "b", "worker-b", [{ type: "TRANSFORM", agent: "question", maxRounds: 1, },]);
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 2);
        const types = actions.map((a) => a.action).sort();
        assert_1.default.deepStrictEqual(types, ["spawn", "spawn",]);
    });
});
console.log("\n=== pipeline.js: resolveRole ===");
test("resolveRole: verifier for active reviewer", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "VERIFY", agent: "reviewer", maxRounds: 3, },]);
        assert_1.default.strictEqual(engine.resolveRole(db, "s1", "reviewer"), "verifier");
    });
});
test("resolveRole: fixer for fix status", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
        ]);
        engine.step(db, "s1", "REVISE");
        assert_1.default.strictEqual(engine.resolveRole(db, "s1", "patcher"), "fixer");
    });
});
test("resolveRole: source for source agent", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "VERIFY", agent: "reviewer", maxRounds: 3, },]);
        assert_1.default.strictEqual(engine.resolveRole(db, "s1", "worker"), "source");
    });
});
test("resolveRole: ungated for unknown agent", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "VERIFY", agent: "reviewer", maxRounds: 3, },]);
        assert_1.default.strictEqual(engine.resolveRole(db, "s1", "random"), "ungated");
    });
});
test("resolveRole: unscoped search across pipelines", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "VERIFY", agent: "reviewer", maxRounds: 3, },]);
        assert_1.default.strictEqual(engine.resolveRole(db, null, "reviewer"), "verifier");
        assert_1.default.strictEqual(engine.resolveRole(db, null, "unknown"), "ungated");
    });
});
// ══════════════════════════════════════════════════════════════════════
// Integration: full pipeline flows
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== Integration: full happy path ===");
test("4-step pipeline: CHECK → TRANSFORM → VERIFY → VERIFY_W_FIXER", () => {
    withDb((db) => {
        engine.createPipeline(db, "full", "worker", [
            { type: "CHECK", prompt: "Check quality.", },
            { type: "TRANSFORM", agent: "question", maxRounds: 1, },
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
            { type: "VERIFY_W_FIXER", agent: "playtester", maxRounds: 2, fixer: "patcher", },
        ]);
        let a = engine.step(db, "full", "PASS"); // CHECK → TRANSFORM
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "question");
        a = engine.step(db, "full", { role: "transformer", artifactVerdict: "", }); // TRANSFORM → VERIFY
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        a = engine.step(db, "full", "PASS"); // VERIFY → VERIFY_W_FIXER
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "playtester");
        a = engine.step(db, "full", "PASS"); // done
        assert_1.default.strictEqual(a.action, "done");
    });
});
console.log("\n=== Integration: revise + fixer flow ===");
test("VERIFY_W_FIXER: revise → fixer → reactivate → pass", () => {
    withDb((db) => {
        engine.createPipeline(db, "fix", "worker", [
            { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
        ]);
        let a = engine.step(db, "fix", "REVISE"); // → fixer
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(a.agent, "patcher");
        a = engine.step(db, "fix", { role: "fixer", artifactVerdict: "PASS", }); // fixer done → reactivate
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        a = engine.step(db, "fix", "PASS"); // reviewer passes
        assert_1.default.strictEqual(a.action, "done");
    });
});
console.log("\n=== Integration: multi-round revise ===");
test("VERIFY: maxRounds=2 exhausts after 2 revisions (3rd REVISE fails)", () => {
    withDb((db) => {
        engine.createPipeline(db, "exh", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 2, },
        ]);
        // Round 1/2: REVISE (within bounds)
        let a = engine.step(db, "exh", "REVISE");
        assert_1.default.strictEqual(a.action, "source");
        engine.step(db, "exh", { role: "source", artifactVerdict: "PASS", });
        // Round 2/2: REVISE (within bounds)
        a = engine.step(db, "exh", "REVISE");
        assert_1.default.strictEqual(a.action, "source");
        engine.step(db, "exh", { role: "source", artifactVerdict: "PASS", });
        // Round 3/2: REVISE → 3 > 2 → exhausted
        a = engine.step(db, "exh", "REVISE");
        assert_1.default.strictEqual(a.action, "failed");
        assert_1.default.strictEqual(a.round, 3);
        assert_1.default.strictEqual(a.maxRounds, 2);
    });
});
console.log("\n=== Integration: parallel pipelines ===");
test("Two scopes run independently", () => {
    withDb((db) => {
        engine.createPipeline(db, "a", "wa", [{ type: "VERIFY", agent: "rev", maxRounds: 3, },]);
        engine.createPipeline(db, "b", "wb", [{ type: "VERIFY", agent: "rev", maxRounds: 3, },]);
        engine.step(db, "a", "REVISE");
        engine.step(db, "b", "PASS");
        assert_1.default.strictEqual(crud.getPipelineState(db, "a").status, "revision");
        assert_1.default.strictEqual(crud.getPipelineState(db, "b").status, "completed");
    });
});
// ══════════════════════════════════════════════════════════════════════
// Hook integration: pipeline-block.js patterns
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== Hook: pipeline-block patterns ===");
test("getAllNextActions returns spawn actions for block enforcement", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 1);
        assert_1.default.strictEqual(actions[0].action, "spawn");
        assert_1.default.strictEqual(actions[0].agent, "reviewer");
        assert_1.default.strictEqual(actions[0].scope, "s1");
    });
});
test("getAllNextActions returns source action during revision", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        engine.step(db, "s1", "REVISE");
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 1);
        assert_1.default.strictEqual(actions[0].action, "source");
        assert_1.default.strictEqual(actions[0].agent, "worker");
    });
});
test("getAllNextActions empty after pipeline completes", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "A", },]);
        engine.step(db, "s1", "PASS");
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 0);
    });
});
test("CHECK-only pipeline: getAllNextActions returns semantic action", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "A", },]);
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 1);
        assert_1.default.strictEqual(actions[0].action, "semantic");
        // pipeline-block treats semantic as blocking (source must re-run)
    });
});
test("CHECK action includes source_agent for pipeline-block", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "CHECK", prompt: "A", },]);
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions[0].step.source_agent, "worker");
        // pipeline-block uses step.source_agent when act.agent is null
    });
});
test("CHECK action blocks: source_agent resolvable from step", () => {
    // Regression: pipeline-block didn't recognize "semantic" action, letting orchestrator bypass
    withDb((db) => {
        engine.createPipeline(db, "fix-1", "fixer", [
            { type: "CHECK", prompt: "Check fix", },
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        const actions = engine.getAllNextActions(db);
        const sem = actions.find((a) => a.scope === "fix-1");
        assert_1.default.strictEqual(sem.action, "semantic");
        assert_1.default.strictEqual(sem.step.source_agent, "fixer");
        // pipeline-block should treat this as: Resume fixer (scope=fix-1)
    });
});
test("getAllNextActions parallel: one completed, one active", () => {
    withDb((db) => {
        engine.createPipeline(db, "a", "wa", [{ type: "CHECK", prompt: "A", },]);
        engine.createPipeline(db, "b", "wb", [{ type: "VERIFY", agent: "rev", maxRounds: 3, },]);
        engine.step(db, "a", "PASS");
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 1);
        assert_1.default.strictEqual(actions[0].scope, "b");
    });
});
// ══════════════════════════════════════════════════════════════════════
// Hook integration: pipeline-conditions.js patterns
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== Hook: pipeline-conditions patterns ===");
test("step enforcement: spawn action allows matching gate agent", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        const actions = engine.getAllNextActions(db);
        const scopeAction = actions.find((a) => a.scope === "s1");
        assert_1.default.strictEqual(scopeAction.action, "spawn");
        assert_1.default.strictEqual(scopeAction.agent, "reviewer");
        // conditions.js would allow reviewer, block anything else
    });
});
test("step enforcement: source action returns fixer during fix", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
        ]);
        engine.step(db, "s1", "REVISE"); // → fix
        const actions = engine.getAllNextActions(db);
        const scopeAction = actions.find((a) => a.scope === "s1");
        assert_1.default.strictEqual(scopeAction.action, "source");
        assert_1.default.strictEqual(scopeAction.agent, "patcher"); // fixer, not source_agent
    });
});
test("no pipeline for scope allows agent spawn", () => {
    withDb((db) => {
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 0);
        // conditions.js: no actions → allow any agent (new scope)
    });
});
// ══════════════════════════════════════════════════════════════════════
// Hook integration: pipeline-injection.js patterns
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== Hook: pipeline-injection patterns ===");
test("createPipeline is idempotent", () => {
    withDb((db) => {
        const steps = [
            { type: "CHECK", prompt: "Check.", },
            { type: "VERIFY", agent: "rev", maxRounds: 3, },
        ];
        engine.createPipeline(db, "s1", "worker", steps);
        engine.createPipeline(db, "s1", "worker", steps); // no-op
        assert_1.default.strictEqual(crud.getSteps(db, "s1").length, 2);
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").total_steps, 2);
    });
});
test("resolveRole works for verifier context enrichment", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
        ]);
        assert_1.default.strictEqual(engine.resolveRole(db, "s1", "reviewer"), "verifier");
        const activeStep = crud.getActiveStep(db, "s1");
        assert_1.default.strictEqual(activeStep.agent, "reviewer");
        assert_1.default.strictEqual(activeStep.fixer, "patcher");
        assert_1.default.strictEqual(activeStep.max_rounds, 3);
    });
});
test("resolveRole returns fixer for fix step context", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
        ]);
        engine.step(db, "s1", "REVISE"); // → fix status
        assert_1.default.strictEqual(engine.resolveRole(db, "s1", "patcher"), "fixer");
        const fixStep = crud.getStepByStatus(db, "s1", "fix");
        assert_1.default.ok(fixStep);
        assert_1.default.strictEqual(fixStep.fixer, "patcher");
    });
});
test("injection path: findAgentScope finds scope registered by conditions", () => {
    withDb((db) => {
        // Simulate conditions.js registering agent with real scope
        crud.registerAgent(db, "my-scope", "builder", "/path/to/artifact.md");
        // Simulate injection.js using findAgentScope (not getPending)
        const scope = crud.findAgentScope(db, "builder");
        assert_1.default.strictEqual(scope, "my-scope");
        // Verify pipeline can be created with found scope
        engine.createPipeline(db, scope, "builder", [{ type: "CHECK", prompt: "Check.", },]);
        assert_1.default.ok(crud.pipelineExists(db, scope));
    });
});
test("source semantic FAIL overrides artifact PASS in engine", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "CHECK", prompt: "Check quality.", },
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        // Source artifact says PASS but semantic says FAIL → engine should get FAIL
        const a = engine.step(db, "s1", { role: "source", artifactVerdict: "FAIL", });
        // FAIL normalized to REVISE → source action (source re-runs)
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "revision");
    });
});
test("CHECK FAIL → revision → source re-completes → step reactivated correctly", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "CHECK", prompt: "Check quality.", },
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        // Source fails CHECK check → pipeline enters revision
        const a1 = engine.step(db, "s1", { role: "source", artifactVerdict: "FAIL", });
        assert_1.default.strictEqual(a1.action, "source");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "revision");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 0).status, "revise");
        // Source re-completes → reactivate CHECK step
        const a2 = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", });
        // Should return semantic action (step reactivated)
        assert_1.default.strictEqual(a2.action, "semantic");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "normal");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 0).status, "active");
        // Now CHECK can be re-run and passed
        const a3 = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(a3.action, "spawn");
        assert_1.default.strictEqual(a3.agent, "reviewer");
    });
});
// ══════════════════════════════════════════════════════════════════════
// Hook integration: pipeline-verification.js patterns
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== Hook: pipeline-verification patterns ===");
test("source step({ role: 'source' }) in revision reactivates step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        engine.step(db, "s1", "REVISE"); // reviewer → revise → source must re-run
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "revision");
        // Source re-completes — engine detects revision state
        const a = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "normal");
    });
});
test("fixer step({ role: 'fixer' }) reactivates step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher", },
        ]);
        engine.step(db, "s1", "REVISE"); // → fix
        assert_1.default.strictEqual(crud.getStepByStatus(db, "s1", "fix").fixer, "patcher");
        const a = engine.step(db, "s1", { role: "fixer", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer"); // reviewer re-runs
    });
});
test("gate agent PASS advances to next step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "rev1", maxRounds: 3, },
            { type: "VERIFY", agent: "rev2", maxRounds: 2, },
        ]);
        const a = engine.step(db, "s1", "PASS"); // rev1 passes → rev2 active
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "rev2");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 0).status, "passed");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 1).status, "active");
    });
});
test("retryGateAgent round increment + step stays active", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        const a = engine.retryGateAgent(db, "s1");
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(a.round, 1); // round incremented
        assert_1.default.strictEqual(crud.getActiveStep(db, "s1").status, "active");
    });
});
test("retryGateAgent exhaustion with maxRounds=0", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "VERIFY", agent: "reviewer", maxRounds: 0, },
        ]);
        // maxRounds=0: first retry → round 1, 1 > 0 → exhausted
        const a = engine.retryGateAgent(db, "s1");
        assert_1.default.strictEqual(a.action, "failed");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "failed");
    });
});
test("agent CRUD: register and retrieve", () => {
    withDb((db) => {
        crud.registerAgent(db, "s1", "worker", "/path/to/artifact.md");
        const agent = crud.getAgent(db, "s1", "worker");
        assert_1.default.strictEqual(agent.agent, "worker");
        assert_1.default.strictEqual(agent.outputFilepath, "/path/to/artifact.md");
        assert_1.default.strictEqual(agent.verdict, null);
    });
});
test("agent CRUD: set verdict and retrieve", () => {
    withDb((db) => {
        crud.registerAgent(db, "s1", "worker", "/path.md");
        crud.setVerdict(db, "s1", "worker", "PASS", 1);
        const agent = crud.getAgent(db, "s1", "worker");
        assert_1.default.strictEqual(agent.verdict, "PASS");
        assert_1.default.strictEqual(agent.round, 1);
    });
});
test("findAgentScope finds agent by type", () => {
    withDb((db) => {
        crud.registerAgent(db, "my-scope", "worker", "/path.md");
        const scope = crud.findAgentScope(db, "worker");
        assert_1.default.strictEqual(scope, "my-scope");
    });
});
test("edit tracking: record and retrieve", () => {
    withDb((db) => {
        crud.addEdit(db, "/foo.ts", 10);
        crud.addEdit(db, "/bar.ts", 5);
        crud.addEdit(db, "/foo.ts", 3); // accumulate
        const edits = crud.getEdits(db);
        assert_1.default.ok(edits.includes("/foo.ts"));
        assert_1.default.ok(edits.includes("/bar.ts"));
        const counts = crud.getEditCounts(db);
        assert_1.default.strictEqual(counts.files, 2);
        assert_1.default.strictEqual(counts.lines, 18); // 10+3+5
    });
});
test("tool history: add and retrieve hashes", () => {
    withDb((db) => {
        crud.addToolHash(db, "aaa");
        crud.addToolHash(db, "bbb");
        crud.addToolHash(db, "ccc");
        const last2 = crud.getLastNHashes(db, 2);
        assert_1.default.strictEqual(last2.length, 2);
        assert_1.default.strictEqual(last2[0], "ccc");
        assert_1.default.strictEqual(last2[1], "bbb");
    });
});
test("isCleared: true after registerAgent, false for unknown", () => {
    withDb((db) => {
        assert_1.default.strictEqual(crud.isCleared(db, "s1", "ghost"), false);
        crud.registerAgent(db, "s1", "ghost", "/ghost.md");
        assert_1.default.strictEqual(crud.isCleared(db, "s1", "ghost"), true);
    });
});
test("getPending: returns _pending agents, null otherwise", () => {
    withDb((db) => {
        assert_1.default.strictEqual(crud.getPending(db, "worker"), null);
        crud.registerAgent(db, "_pending", "worker", "/tmp/worker.md");
        const p = crud.getPending(db, "worker");
        assert_1.default.ok(p);
        assert_1.default.strictEqual(p.scope, "_pending");
        assert_1.default.strictEqual(p.outputFilepath, "/tmp/worker.md");
    });
});
test("getDb creates session dir if missing", () => {
    const tmpDir = path_1.default.join(os_1.default.tmpdir(), `cg-test-mkdir-${Date.now()}`);
    const sessDir = path_1.default.join(tmpDir, "new-session");
    try {
        const db = crud.getDb(sessDir);
        assert_1.default.ok(fs_1.default.existsSync(path_1.default.join(sessDir, "session.db")));
        db.close();
    }
    finally {
        try {
            fs_1.default.rmSync(tmpDir, { recursive: true, });
        }
        catch {
        }
    }
});
// ── FrontmatterParser utility coverage ──────────────────────────────
test("getSessionDir truncates UUID to 8 hex chars", () => {
    const dir = crud.getSessionDir("689b2e01-abcd-1234-5678-abcdef012345");
    assert_1.default.ok(dir.endsWith("/689b2e01") || dir.endsWith("\\689b2e01"));
    assert_1.default.ok(dir.includes(".sessions"));
});
test("agentRunningMarker returns .running-{scope} path", () => {
    const marker = crud.agentRunningMarker("/tmp/sessions/abc", "task-1");
    assert_1.default.ok(marker.includes(".running-task-1"));
    assert_1.default.ok(marker.startsWith("/tmp/sessions/abc"));
});
test("findAgentMd returns null for nonexistent agent", () => {
    const result = FrontmatterParser_js_1.FrontmatterParser.findAgentMd("nonexistent-agent-xyz", process.cwd(), os_1.default.homedir());
    assert_1.default.strictEqual(result, null);
});
test("trace writes audit.jsonl entry", () => {
    const tmpDir = path_1.default.join(os_1.default.tmpdir(), `cg-test-trace-${Date.now()}`);
    fs_1.default.mkdirSync(tmpDir, { recursive: true, });
    try {
        auditTrace(tmpDir, "test.op", "test-scope", { key: "val", });
        const content = fs_1.default.readFileSync(path_1.default.join(tmpDir, "audit.jsonl"), "utf-8").trim();
        const entry = JSON.parse(content);
        assert_1.default.strictEqual(entry.op, "test.op");
        assert_1.default.strictEqual(entry.scope, "test-scope");
        assert_1.default.strictEqual(entry.key, "val");
        assert_1.default.ok(entry.ts);
    }
    finally {
        try {
            fs_1.default.rmSync(tmpDir, { recursive: true, });
        }
        catch {
        }
    }
});
test("trace silently fails on bad path", () => {
    // Should not throw
    auditTrace("/nonexistent/path/that/cant/exist", "test", null);
});
// ══════════════════════════════════════════════════════════════════════
// Regression: MCP verdict flow bugs found during stress-testing (2026-04-03)
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== Regression: MCP verdict flow ===");
test("MCP gate_verdict records verdict WITHOUT driving engine.step (no double-advance)", () => {
    // Bug: gate_verdict called engine.step AND hook called engine.step → double advance.
    // Fix: MCP server only records verdict (setVerdict), hook drives engine.step.
    const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "cg-mcp-regr-"));
    const db = crud.getDb(tmpDir);
    // Setup: 2-step pipeline (CHECK → VERIFY)
    const steps = [
        { type: "CHECK", prompt: "Check it.", },
        { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ];
    engine.createPipeline(db, "mcp-regr", "worker", steps);
    // Simulate what MCP gate_verdict does: record verdict only
    crud.setVerdict(db, "mcp-regr", "worker", "PASS", 0);
    // Pipeline should NOT have advanced — still on step 0
    const state = crud.getPipelineState(db, "mcp-regr");
    assert_1.default.ok(state);
    assert_1.default.strictEqual(state.current_step, 0, "MCP setVerdict should not advance pipeline");
    assert_1.default.strictEqual(state.status, "normal");
    // Hook drives engine.step — THIS advances the pipeline
    const action = engine.step(db, "mcp-regr", { role: "source", artifactVerdict: "PASS", });
    assert_1.default.ok(action);
    const stateAfter = crud.getPipelineState(db, "mcp-regr");
    assert_1.default.strictEqual(stateAfter.current_step, 1, "engine.step should advance to step 1");
    db.close();
    try {
        fs_1.default.rmSync(tmpDir, { recursive: true, });
    }
    catch {
    }
});
test("verifier verdict recorded in DB is readable after setVerdict", () => {
    // Bug: runSemanticCheck returned null when gater used MCP (no Result: line).
    // Fix: after runSemanticCheck, check DB for MCP verdict.
    // This test verifies the DB path works correctly.
    const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "cg-dbverdict-"));
    const db = crud.getDb(tmpDir);
    const steps = [
        { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ];
    engine.createPipeline(db, "dbv-scope", "worker", steps);
    // Register agent first (conditions hook does this), then simulate MCP gate_verdict
    crud.registerAgent(db, "dbv-scope", "reviewer", `${tmpDir}/dbv-scope/reviewer.md`);
    crud.setVerdict(db, "dbv-scope", "reviewer", "PASS", 1);
    // Verify the verdict is readable
    const agentRow = crud.getAgent(db, "dbv-scope", "reviewer");
    assert_1.default.ok(agentRow, "agent row should exist");
    assert_1.default.strictEqual(agentRow.verdict, "PASS");
    assert_1.default.strictEqual(agentRow.round, 1);
    db.close();
    try {
        fs_1.default.rmSync(tmpDir, { recursive: true, });
    }
    catch {
    }
});
test("engine.step with verifier PASS advances VERIFY step (hook-driven path)", () => {
    // Regression: ensures the hook-driven engine.step path works for verifiers
    // after MCP records the verdict (no double-advance).
    const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "cg-hookdrv-"));
    const db = crud.getDb(tmpDir);
    const steps = [
        { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
    ];
    engine.createPipeline(db, "hookdrv", "worker", steps);
    // MCP records verdict
    crud.setVerdict(db, "hookdrv", "reviewer", "PASS", 0);
    // Hook drives engine.step with the verdict
    const action = engine.step(db, "hookdrv", { role: "verifier", artifactVerdict: "PASS", });
    assert_1.default.ok(action);
    assert_1.default.strictEqual(action.action, "done", "single VERIFY step PASS should complete pipeline");
    const state = crud.getPipelineState(db, "hookdrv");
    assert_1.default.strictEqual(state.status, "completed");
    db.close();
    try {
        fs_1.default.rmSync(tmpDir, { recursive: true, });
    }
    catch {
    }
});
test("engine.step with verifier REVISE routes to fixer (hook-driven path)", () => {
    // Regression: REVISE via hook-driven path should route to fixer, not double-advance.
    const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "cg-revfixer-"));
    const db = crud.getDb(tmpDir);
    const steps = [
        { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "fixer", },
    ];
    engine.createPipeline(db, "revfix", "worker", steps);
    // MCP records REVISE verdict
    crud.setVerdict(db, "revfix", "reviewer", "REVISE", 0);
    // Hook drives engine.step
    const action = engine.step(db, "revfix", { role: "verifier", artifactVerdict: "REVISE", });
    assert_1.default.ok(action);
    assert_1.default.strictEqual(action.action, "source", "REVISE on VERIFY_W_FIXER should route to fixer");
    assert_1.default.strictEqual(action.agent, "fixer");
    const state = crud.getPipelineState(db, "revfix");
    assert_1.default.strictEqual(state.status, "revision");
    db.close();
    try {
        fs_1.default.rmSync(tmpDir, { recursive: true, });
    }
    catch {
    }
});
test("retryGateAgent multi-round exhaustion (regression: null semanticVerdict loop)", () => {
    // Bug: null semanticVerdict bypassed retryGateAgent check → revise() → fixer → infinite loop.
    // Fix: hook layer calls retryGateAgent directly. Engine is a pure state machine.
    const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "cg-nullsem-"));
    const db = crud.getDb(tmpDir);
    const steps = [
        { type: "VERIFY", agent: "reviewer", maxRounds: 2, },
    ];
    engine.createPipeline(db, "nullsem", "worker", steps);
    // Round 1: hook calls retryGateAgent (round 0→1)
    const a1 = engine.retryGateAgent(db, "nullsem");
    assert_1.default.ok(a1);
    assert_1.default.strictEqual(a1.action, "spawn", "retryGateAgent should re-spawn reviewer");
    const step1 = crud.getActiveStep(db, "nullsem");
    assert_1.default.strictEqual(step1.round, 1);
    // Round 2: retry (round 1→2)
    const a2 = engine.retryGateAgent(db, "nullsem");
    assert_1.default.ok(a2);
    assert_1.default.strictEqual(a2.action, "spawn");
    const step2 = crud.getActiveStep(db, "nullsem");
    assert_1.default.strictEqual(step2.round, 2);
    // Round 3: exhaustion (round 2→3, 3 > maxRounds=2)
    const a3 = engine.retryGateAgent(db, "nullsem");
    assert_1.default.ok(a3);
    assert_1.default.strictEqual(a3.action, "failed", "should exhaust after maxRounds retries");
    const state = crud.getPipelineState(db, "nullsem");
    assert_1.default.strictEqual(state.status, "failed");
    db.close();
    try {
        fs_1.default.rmSync(tmpDir, { recursive: true, });
    }
    catch {
    }
});
test("REVISE artifact + FAIL semantic routes to fixer, not retryGateAgent", () => {
    // Bug: when reviewer says REVISE but gater semantic check returns FAIL (or null→FAIL),
    // engine.retryGateAgent fired instead of revise() — fixer never ran.
    // Fix: engine.step skips retryGateAgent when artifactVerdict is REVISE.
    const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "cg-revfail-"));
    const db = crud.getDb(tmpDir);
    const steps = [
        { type: "VERIFY_W_FIXER", agent: "reviewer", fixer: "fixer-agent", maxRounds: 3, },
    ];
    engine.createPipeline(db, "revfail", "worker", steps);
    // Reviewer says REVISE, gater semantic check fails → should still route to fixer
    const a1 = engine.step(db, "revfail", { role: "verifier", artifactVerdict: "REVISE", });
    assert_1.default.ok(a1);
    assert_1.default.strictEqual(a1.action, "source", "REVISE + FAIL semantic should route to fixer, not retry");
    assert_1.default.strictEqual(a1.agent, "fixer-agent", "should spawn fixer, not retry reviewer");
    const step1 = crud.getStepByStatus(db, "revfail", "fix");
    assert_1.default.ok(step1, "step should be in 'fix' status");
    db.close();
    try {
        fs_1.default.rmSync(tmpDir, { recursive: true, });
    }
    catch {
    }
});
test("PASS artifact + semantic FAIL: hook retries via retryGateAgent (regression)", () => {
    // Bug: handleVerifier overrode artifactVerdict PASS→FAIL before engine.step,
    // so engine saw FAIL → normalizeVerdict("FAIL")="REVISE" → revise() → fixer.
    // Fix: hook layer intercepts semantic FAIL and calls retryGateAgent instead of step.
    const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "cg-passfail-"));
    const db = crud.getDb(tmpDir);
    const steps = [
        { type: "VERIFY_W_FIXER", agent: "reviewer", fixer: "fixer-agent", maxRounds: 3, },
    ];
    engine.createPipeline(db, "passfail", "worker", steps);
    // Hook layer detects semantic FAIL → calls retryGateAgent (not step)
    const a1 = engine.retryGateAgent(db, "passfail");
    assert_1.default.ok(a1);
    assert_1.default.strictEqual(a1.action, "spawn", "retryGateAgent should re-spawn reviewer, not route to fixer");
    const fixRow = crud.getStepByStatus(db, "passfail", "fix");
    assert_1.default.strictEqual(fixRow, null, "step should NOT be in fix status");
    db.close();
    try {
        fs_1.default.rmSync(tmpDir, { recursive: true, });
    }
    catch {
    }
});
test("FAIL artifact + semantic FAIL: hook retries via retryGateAgent (regression)", () => {
    // FAIL means "unfixable" — hook detects semantic FAIL → retryGateAgent (bad review quality).
    const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "cg-failfail-"));
    const db = crud.getDb(tmpDir);
    const steps = [
        { type: "VERIFY_W_FIXER", agent: "reviewer", fixer: "fixer-agent", maxRounds: 3, },
    ];
    engine.createPipeline(db, "failfail", "worker", steps);
    const a1 = engine.retryGateAgent(db, "failfail");
    assert_1.default.ok(a1);
    assert_1.default.strictEqual(a1.action, "spawn", "retryGateAgent should retry reviewer");
    const fixRow = crud.getStepByStatus(db, "failfail", "fix");
    assert_1.default.strictEqual(fixRow, null, "step should NOT be in fix status");
    db.close();
    try {
        fs_1.default.rmSync(tmpDir, { recursive: true, });
    }
    catch {
    }
});
test("UNKNOWN artifact + semantic FAIL: hook retries via retryGateAgent (regression)", () => {
    // Most common real-world case: no Result: line found. Hook calls retryGateAgent.
    const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "cg-unkfail-"));
    const db = crud.getDb(tmpDir);
    const steps = [
        { type: "VERIFY", agent: "reviewer", maxRounds: 2, },
    ];
    engine.createPipeline(db, "unkfail", "worker", steps);
    const a1 = engine.retryGateAgent(db, "unkfail");
    assert_1.default.ok(a1);
    assert_1.default.strictEqual(a1.action, "spawn", "retryGateAgent should retry reviewer");
    db.close();
    try {
        fs_1.default.rmSync(tmpDir, { recursive: true, });
    }
    catch {
    }
});
// ══════════════════════════════════════════════════════════════════════
console.log(`\n${"=".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
//# sourceMappingURL=PipelineTest.js.map