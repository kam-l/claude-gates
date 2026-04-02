#!/usr/bin/env node
"use strict";
/**
 * Pipeline v3 — unit + integration tests.
 *
 * Tests: pipeline-shared.js (parsing), pipeline-db.js (CRUD), pipeline.js (engine).
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
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const shared = __importStar(require("./pipeline-shared.js"));
const crud = __importStar(require("./pipeline-db.js"));
const engine = __importStar(require("./pipeline.js"));
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
        fs_1.default.rmSync(dir, { recursive: true, force: true });
    }
    catch { }
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
// pipeline-shared.js — parsing tests
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== pipeline-shared.js: extractFrontmatter ===");
test("extractFrontmatter returns YAML between fences", () => {
    assert_1.default.strictEqual(shared.extractFrontmatter("---\nname: test\n---\n# Body"), "name: test");
});
test("extractFrontmatter returns null for no frontmatter", () => {
    assert_1.default.strictEqual(shared.extractFrontmatter("# Just a heading"), null);
});
console.log("\n=== pipeline-shared.js: parseVerification ===");
test("parse SEMANTIC step", () => {
    const steps = shared.parseVerification('---\nverification:\n  - ["Verify completeness."]\n---\n');
    assert_1.default.strictEqual(steps.length, 1);
    assert_1.default.strictEqual(steps[0].type, "SEMANTIC");
    assert_1.default.strictEqual(steps[0].prompt, "Verify completeness.");
});
test("parse SEMANTIC step with single quotes", () => {
    const steps = shared.parseVerification("---\nverification:\n  - ['Verify quality.']\n---\n");
    assert_1.default.strictEqual(steps[0].type, "SEMANTIC");
    assert_1.default.strictEqual(steps[0].prompt, "Verify quality.");
});
test("parse COMMAND step", () => {
    const steps = shared.parseVerification("---\nverification:\n  - [/question, AskUserTool]\n---\n");
    assert_1.default.strictEqual(steps[0].type, "COMMAND");
    assert_1.default.strictEqual(steps[0].command, "/question");
    assert_1.default.deepStrictEqual(steps[0].allowedTools, ["AskUserTool"]);
});
test("parse COMMAND step with multiple allowed tools", () => {
    const steps = shared.parseVerification("---\nverification:\n  - [/rethink, AskUserTool, Read]\n---\n");
    assert_1.default.deepStrictEqual(steps[0].allowedTools, ["AskUserTool", "Read"]);
});
test("parse REVIEW step", () => {
    const steps = shared.parseVerification("---\nverification:\n  - [reviewer, 3]\n---\n");
    assert_1.default.strictEqual(steps[0].type, "REVIEW");
    assert_1.default.strictEqual(steps[0].agent, "reviewer");
    assert_1.default.strictEqual(steps[0].maxRounds, 3);
});
test("parse REVIEW_WITH_FIXER step", () => {
    const steps = shared.parseVerification("---\nverification:\n  - [reviewer, 3, fixer]\n---\n");
    assert_1.default.strictEqual(steps[0].type, "REVIEW_WITH_FIXER");
    assert_1.default.strictEqual(steps[0].fixer, "fixer");
});
test("parse mixed verification steps", () => {
    const md = '---\nverification:\n  - ["Check."]\n  - [/question, AskUserTool]\n  - [reviewer, 3]\n  - [playtester, 2, fixer]\n---\n';
    const steps = shared.parseVerification(md);
    assert_1.default.strictEqual(steps.length, 4);
    assert_1.default.strictEqual(steps[0].type, "SEMANTIC");
    assert_1.default.strictEqual(steps[1].type, "COMMAND");
    assert_1.default.strictEqual(steps[2].type, "REVIEW");
    assert_1.default.strictEqual(steps[3].type, "REVIEW_WITH_FIXER");
});
test("parseVerification returns null for no verification field", () => {
    assert_1.default.strictEqual(shared.parseVerification("---\nname: test\n---\n"), null);
});
test("parseVerification returns null for empty verification", () => {
    assert_1.default.strictEqual(shared.parseVerification("---\nverification:\n---\n"), null);
});
test("parse agent name with hyphens and underscores", () => {
    const steps = shared.parseVerification("---\nverification:\n  - [gt-reviewer_v2, 5]\n---\n");
    assert_1.default.strictEqual(steps[0].agent, "gt-reviewer_v2");
    assert_1.default.strictEqual(steps[0].maxRounds, 5);
});
console.log("\n=== pipeline-shared.js: parseConditions ===");
test("parseConditions returns prompt", () => {
    const cond = shared.parseConditions("---\nconditions: |\n  Check if ready.\n  Must have scope.\n---\n");
    assert_1.default.ok(cond.includes("Check if ready."));
});
test("parseConditions returns null when absent", () => {
    assert_1.default.strictEqual(shared.parseConditions("---\nname: test\n---\n"), null);
});
console.log("\n=== pipeline-shared.js: requiresScope + VERDICT_RE ===");
test("requiresScope true for verification array", () => {
    assert_1.default.strictEqual(shared.requiresScope('---\nverification:\n  - ["Check."]\n---\n'), true);
});
test("requiresScope false for bare agent", () => {
    assert_1.default.strictEqual(shared.requiresScope("---\nname: test\n---\n"), false);
});
test("VERDICT_RE matches standard verdicts", () => {
    for (const v of ["PASS", "FAIL", "REVISE", "CONVERGED"]) {
        shared.VERDICT_RE.lastIndex = 0;
        assert_1.default.ok(shared.VERDICT_RE.test(`Result: ${v}`), `should match ${v}`);
    }
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
        crud.insertStep(db, "s1", 0, { type: "SEMANTIC", prompt: "Check." }, "worker");
        const step = crud.getStep(db, "s1", 0);
        assert_1.default.strictEqual(step.step_type, "SEMANTIC");
        assert_1.default.strictEqual(step.prompt, "Check.");
        assert_1.default.strictEqual(step.status, "active"); // first step
    });
});
test("insertStep stores COMMAND columns", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 1);
        crud.insertStep(db, "s1", 0, { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool", "Read"] }, "worker");
        const step = crud.getStep(db, "s1", 0);
        assert_1.default.strictEqual(step.command, "/question");
        assert_1.default.strictEqual(step.allowed_tools, "AskUserTool,Read");
    });
});
test("updateStepStatus + updatePipelineState", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 1);
        crud.insertStep(db, "s1", 0, { type: "SEMANTIC", prompt: "Check." }, "worker");
        crud.updateStepStatus(db, "s1", 0, "passed");
        crud.updatePipelineState(db, "s1", { status: "completed" });
        assert_1.default.strictEqual(crud.getStep(db, "s1", 0).status, "passed");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "completed");
    });
});
test("updateStepStatus with round", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 1);
        crud.insertStep(db, "s1", 0, { type: "REVIEW", agent: "rev", maxRounds: 3 }, "worker");
        crud.updateStepStatus(db, "s1", 0, "revise", 2);
        const step = crud.getStep(db, "s1", 0);
        assert_1.default.strictEqual(step.status, "revise");
        assert_1.default.strictEqual(step.round, 2);
    });
});
test("getStepByStatus", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 2);
        crud.insertStep(db, "s1", 0, { type: "SEMANTIC", prompt: "A" }, "worker");
        crud.insertStep(db, "s1", 1, { type: "REVIEW", agent: "rev", maxRounds: 3 }, "worker");
        assert_1.default.strictEqual(crud.getStepByStatus(db, "s1", "active").step_index, 0);
        assert_1.default.strictEqual(crud.getStepByStatus(db, "s1", "pending").step_index, 1);
    });
});
test("deletePipeline removes all data", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 1);
        crud.insertStep(db, "s1", 0, { type: "SEMANTIC", prompt: "A" }, "worker");
        crud.deletePipeline(db, "s1");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1"), null);
        assert_1.default.strictEqual(crud.getSteps(db, "s1").length, 0);
    });
});
test("hasNonPassedSteps", () => {
    withDb((db) => {
        crud.insertPipeline(db, "s1", "worker", 1);
        crud.insertStep(db, "s1", 0, { type: "SEMANTIC", prompt: "A" }, "worker");
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
            { type: "SEMANTIC", prompt: "Check." },
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        assert_1.default.strictEqual(crud.getPipelineState(db, "e1").total_steps, 2);
        assert_1.default.strictEqual(crud.getSteps(db, "e1").length, 2);
    });
});
test("createPipeline is no-op if exists", () => {
    withDb((db) => {
        engine.createPipeline(db, "e1", "worker", [{ type: "SEMANTIC", prompt: "A" }]);
        engine.createPipeline(db, "e1", "other", [{ type: "SEMANTIC", prompt: "B" }]);
        assert_1.default.strictEqual(crud.getPipelineState(db, "e1").source_agent, "worker");
    });
});
console.log("\n=== pipeline.js: step() — unified API ===");
test("step(PASS) advances to next step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "SEMANTIC", prompt: "Check." },
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        const a = engine.step(db, "s1", "PASS");
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
    });
});
test("step(PASS) on last step returns done", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "Check." }]);
        const a = engine.step(db, "s1", "PASS");
        assert_1.default.strictEqual(a.action, "done");
    });
});
test("step(CONVERGED) treated as PASS", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "Check." }]);
        const a = engine.step(db, "s1", "CONVERGED");
        assert_1.default.strictEqual(a.action, "done");
    });
});
test("step(REVISE) on REVIEW returns source action", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "SEMANTIC", prompt: "Check." },
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        engine.step(db, "s1", "PASS"); // advance to REVIEW
        const a = engine.step(db, "s1", "REVISE");
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(a.agent, "worker"); // routes to source, not fixer
    });
});
test("step(REVISE) on REVIEW_WITH_FIXER returns fixer action", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
        ]);
        const a = engine.step(db, "s1", "REVISE");
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(a.agent, "patcher"); // routes to fixer
    });
});
test("step(FAIL) treated same as REVISE", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        const a = engine.step(db, "s1", "FAIL");
        assert_1.default.strictEqual(a.action, "source");
    });
});
test("step exhaustion returns failed after maxRounds revisions", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW", agent: "reviewer", maxRounds: 1 },
        ]);
        // maxRounds=1: first REVISE → round 1 (1 > 1 = false, within bounds)
        let a = engine.step(db, "s1", "REVISE");
        assert_1.default.strictEqual(a.action, "source");
        engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" }); // reactivate
        // Second REVISE → round 2 (2 > 1 = true, exhausted)
        a = engine.step(db, "s1", "REVISE");
        assert_1.default.strictEqual(a.action, "failed");
        assert_1.default.strictEqual(a.round, 2);
        assert_1.default.strictEqual(a.maxRounds, 1);
    });
});
test("step with unknown verdict warns and passes", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "Check." }]);
        // Redirect stderr to suppress warning in test output
        const origWrite = process.stderr.write;
        let warned = false;
        process.stderr.write = ((msg) => { warned = String(msg).includes("Unknown verdict"); return true; });
        const a = engine.step(db, "s1", "GARBAGE");
        process.stderr.write = origWrite;
        assert_1.default.strictEqual(a.action, "done");
        assert_1.default.strictEqual(warned, true);
    });
});
test("step returns null for completed pipeline", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "Check." }]);
        engine.step(db, "s1", "PASS");
        assert_1.default.strictEqual(engine.step(db, "s1", "PASS"), null);
    });
});
console.log("\n=== pipeline.js: role-aware step (source in revision) ===");
test("step({ role: 'source' }) in revision reactivates revise step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        engine.step(db, "s1", "REVISE"); // → revision
        const a = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "normal");
    });
});
test("step({ role: 'fixer' }) reactivates fix step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
        ]);
        engine.step(db, "s1", "REVISE"); // → fix
        const a = engine.step(db, "s1", { role: "fixer", artifactVerdict: "PASS" });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer"); // reviewer re-runs, not fixer
    });
});
test("step({ role: 'source' }) does NOT advance REVIEW step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        // Source completes with PASS — should NOT advance the REVIEW step
        const a = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer"); // reviewer should still be expected
        // Step should still be active, not passed
        assert_1.default.strictEqual(crud.getActiveStep(db, "s1").status, "active");
        assert_1.default.strictEqual(crud.getActiveStep(db, "s1").step_type, "REVIEW");
    });
});
test("step({ role: 'source' }) does NOT advance COMMAND step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
        ]);
        const a = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
        assert_1.default.strictEqual(a.action, "command"); // COMMAND still active, not advanced
        assert_1.default.strictEqual(crud.getActiveStep(db, "s1").status, "active");
    });
});
test("step({ role: 'source' }) advances SEMANTIC step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "SEMANTIC", prompt: "Check." },
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        const a = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
        // SEMANTIC passed, REVIEW now active
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 0).status, "passed");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 1).status, "active");
    });
});
test("step({ role: 'verifier', semanticVerdict: 'FAIL' }) retries gate", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        const a = engine.step(db, "s1", { role: "verifier", artifactVerdict: "PASS", semanticVerdict: "FAIL" });
        // Gate retried: still spawn action, round incremented
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(a.round, 1); // round incremented from 0
    });
});
test("step({ role: 'verifier', semanticVerdict: 'FAIL' }) exhaustion after maxRounds", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW", agent: "reviewer", maxRounds: 1 },
        ]);
        // First semantic FAIL → round 1 (1 > 1 = false, retry)
        let a = engine.step(db, "s1", { role: "verifier", artifactVerdict: "PASS", semanticVerdict: "FAIL" });
        assert_1.default.strictEqual(a.action, "spawn"); // retried
        // Second semantic FAIL → round 2 (2 > 1 = true, exhausted)
        a = engine.step(db, "s1", { role: "verifier", artifactVerdict: "PASS", semanticVerdict: "FAIL" });
        assert_1.default.strictEqual(a.action, "failed");
        assert_1.default.strictEqual(a.round, 2);
        assert_1.default.strictEqual(a.maxRounds, 1);
    });
});
console.log("\n=== pipeline.js: getNextAction ===");
test("getNextAction returns semantic for step 0", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "SEMANTIC", prompt: "Check." },
        ]);
        const a = engine.getNextAction(db, "s1");
        assert_1.default.strictEqual(a.action, "semantic");
    });
});
test("getNextAction returns spawn for REVIEW", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "SEMANTIC", prompt: "Check." },
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        engine.step(db, "s1", "PASS");
        const a = engine.getNextAction(db, "s1");
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(a.round, 0);
        assert_1.default.strictEqual(a.maxRounds, 3);
    });
});
test("getNextAction returns command for COMMAND", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
        ]);
        const a = engine.getNextAction(db, "s1");
        assert_1.default.strictEqual(a.action, "command");
        assert_1.default.strictEqual(a.command, "/question");
        assert_1.default.deepStrictEqual(a.allowedTools, ["AskUserTool"]);
    });
});
test("getNextAction returns source during revision", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
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
            { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
        ]);
        engine.step(db, "s1", "REVISE");
        const a = engine.getNextAction(db, "s1");
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(a.agent, "patcher");
    });
});
test("getNextAction returns null for completed", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "A" }]);
        engine.step(db, "s1", "PASS");
        assert_1.default.strictEqual(engine.getNextAction(db, "s1"), null);
    });
});
test("getNextAction returns null for failed", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "REVIEW", agent: "rev", maxRounds: 0 }]);
        engine.step(db, "s1", "REVISE"); // round 1 > 0 → exhausted
        assert_1.default.strictEqual(engine.getNextAction(db, "s1"), null);
    });
});
console.log("\n=== pipeline.js: getAllNextActions ===");
test("getAllNextActions returns actions for all active scopes", () => {
    withDb((db) => {
        engine.createPipeline(db, "a", "worker-a", [{ type: "REVIEW", agent: "rev", maxRounds: 3 }]);
        engine.createPipeline(db, "b", "worker-b", [{ type: "COMMAND", command: "/q", allowedTools: ["Ask"] }]);
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 2);
        const types = actions.map((a) => a.action).sort();
        assert_1.default.deepStrictEqual(types, ["command", "spawn"]);
    });
});
console.log("\n=== pipeline.js: resolveRole ===");
test("resolveRole: verifier for active reviewer", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "REVIEW", agent: "reviewer", maxRounds: 3 }]);
        assert_1.default.strictEqual(engine.resolveRole(db, "s1", "reviewer"), "verifier");
    });
});
test("resolveRole: fixer for fix status", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
        ]);
        engine.step(db, "s1", "REVISE");
        assert_1.default.strictEqual(engine.resolveRole(db, "s1", "patcher"), "fixer");
    });
});
test("resolveRole: source for source agent", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "REVIEW", agent: "reviewer", maxRounds: 3 }]);
        assert_1.default.strictEqual(engine.resolveRole(db, "s1", "worker"), "source");
    });
});
test("resolveRole: ungated for unknown agent", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "REVIEW", agent: "reviewer", maxRounds: 3 }]);
        assert_1.default.strictEqual(engine.resolveRole(db, "s1", "random"), "ungated");
    });
});
test("resolveRole: unscoped search across pipelines", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "REVIEW", agent: "reviewer", maxRounds: 3 }]);
        assert_1.default.strictEqual(engine.resolveRole(db, null, "reviewer"), "verifier");
        assert_1.default.strictEqual(engine.resolveRole(db, null, "unknown"), "ungated");
    });
});
// ══════════════════════════════════════════════════════════════════════
// Integration: full pipeline flows
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== Integration: full happy path ===");
test("4-step pipeline: SEMANTIC → COMMAND → REVIEW → REVIEW_WITH_FIXER", () => {
    withDb((db) => {
        engine.createPipeline(db, "full", "worker", [
            { type: "SEMANTIC", prompt: "Check quality." },
            { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
            { type: "REVIEW_WITH_FIXER", agent: "playtester", maxRounds: 2, fixer: "patcher" },
        ]);
        let a = engine.step(db, "full", "PASS"); // SEMANTIC → COMMAND
        assert_1.default.strictEqual(a.action, "command");
        a = engine.step(db, "full", "PASS"); // COMMAND → REVIEW
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        a = engine.step(db, "full", "PASS"); // REVIEW → REVIEW_WITH_FIXER
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "playtester");
        a = engine.step(db, "full", "PASS"); // done
        assert_1.default.strictEqual(a.action, "done");
    });
});
console.log("\n=== Integration: revise + fixer flow ===");
test("REVIEW_WITH_FIXER: revise → fixer → reactivate → pass", () => {
    withDb((db) => {
        engine.createPipeline(db, "fix", "worker", [
            { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
        ]);
        let a = engine.step(db, "fix", "REVISE"); // → fixer
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(a.agent, "patcher");
        a = engine.step(db, "fix", { role: "fixer", artifactVerdict: "PASS" }); // fixer done → reactivate
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        a = engine.step(db, "fix", "PASS"); // reviewer passes
        assert_1.default.strictEqual(a.action, "done");
    });
});
console.log("\n=== Integration: multi-round revise ===");
test("REVIEW: maxRounds=2 exhausts after 2 revisions (3rd REVISE fails)", () => {
    withDb((db) => {
        engine.createPipeline(db, "exh", "worker", [
            { type: "REVIEW", agent: "reviewer", maxRounds: 2 },
        ]);
        // Round 1/2: REVISE (within bounds)
        let a = engine.step(db, "exh", "REVISE");
        assert_1.default.strictEqual(a.action, "source");
        engine.step(db, "exh", { role: "source", artifactVerdict: "PASS" });
        // Round 2/2: REVISE (within bounds)
        a = engine.step(db, "exh", "REVISE");
        assert_1.default.strictEqual(a.action, "source");
        engine.step(db, "exh", { role: "source", artifactVerdict: "PASS" });
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
        engine.createPipeline(db, "a", "wa", [{ type: "REVIEW", agent: "rev", maxRounds: 3 }]);
        engine.createPipeline(db, "b", "wb", [{ type: "REVIEW", agent: "rev", maxRounds: 3 }]);
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
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
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
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        engine.step(db, "s1", "REVISE");
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 1);
        assert_1.default.strictEqual(actions[0].action, "source");
        assert_1.default.strictEqual(actions[0].agent, "worker");
    });
});
test("getAllNextActions returns command action with allowed tools", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool", "Read"] },
        ]);
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 1);
        assert_1.default.strictEqual(actions[0].action, "command");
        assert_1.default.deepStrictEqual(actions[0].allowedTools, ["AskUserTool", "Read"]);
    });
});
test("getAllNextActions empty after pipeline completes", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "A" }]);
        engine.step(db, "s1", "PASS");
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 0);
    });
});
test("SEMANTIC-only pipeline: getAllNextActions returns semantic action", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "A" }]);
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 1);
        assert_1.default.strictEqual(actions[0].action, "semantic");
        // pipeline-block treats semantic as blocking (source must re-run)
    });
});
test("SEMANTIC action includes source_agent for pipeline-block", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [{ type: "SEMANTIC", prompt: "A" }]);
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions[0].step.source_agent, "worker");
        // pipeline-block uses step.source_agent when act.agent is null
    });
});
test("SEMANTIC action blocks: source_agent resolvable from step", () => {
    // Regression: pipeline-block didn't recognize "semantic" action, letting orchestrator bypass
    withDb((db) => {
        engine.createPipeline(db, "fix-1", "fixer", [
            { type: "SEMANTIC", prompt: "Check fix" },
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        const actions = engine.getAllNextActions(db);
        const sem = actions.find((a) => a.scope === "fix-1");
        assert_1.default.strictEqual(sem.action, "semantic");
        assert_1.default.strictEqual(sem.step.source_agent, "fixer");
        // pipeline-block should treat this as: Resume fixer (scope=fix-1)
    });
});
// ══════════════════════════════════════════════════════════════════════
// COMMAND step engine tests
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== COMMAND step: engine.step with role=null ===");
test("COMMAND step: PASS with { role: null } advances", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        const a = engine.step(db, "s1", { role: null, artifactVerdict: "PASS" });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 0).status, "passed");
    });
});
test("COMMAND step: REVISE with { role: null } enters revision", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
        ]);
        const a = engine.step(db, "s1", { role: null, artifactVerdict: "REVISE" });
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(a.agent, "worker");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "revision");
    });
});
test("COMMAND step: UNKNOWN verdict treated as PASS (fail-open)", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
        ]);
        const origWrite = process.stderr.write;
        process.stderr.write = (() => true); // suppress warning
        const a = engine.step(db, "s1", { role: null, artifactVerdict: "UNKNOWN" });
        process.stderr.write = origWrite;
        assert_1.default.strictEqual(a.action, "done");
    });
});
test("COMMAND step: string verdict also works (backward compat)", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "COMMAND", command: "/q", allowedTools: ["Ask"] },
            { type: "REVIEW", agent: "rev", maxRounds: 2 },
        ]);
        const a = engine.step(db, "s1", "PASS"); // string form
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "rev");
    });
});
test("getAllNextActions parallel: one completed, one active", () => {
    withDb((db) => {
        engine.createPipeline(db, "a", "wa", [{ type: "SEMANTIC", prompt: "A" }]);
        engine.createPipeline(db, "b", "wb", [{ type: "REVIEW", agent: "rev", maxRounds: 3 }]);
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
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
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
            { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
        ]);
        engine.step(db, "s1", "REVISE"); // → fix
        const actions = engine.getAllNextActions(db);
        const scopeAction = actions.find((a) => a.scope === "s1");
        assert_1.default.strictEqual(scopeAction.action, "source");
        assert_1.default.strictEqual(scopeAction.agent, "patcher"); // fixer, not source_agent
    });
});
test("step enforcement: command action blocks agent spawn", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "COMMAND", command: "/question", allowedTools: ["AskUserTool"] },
        ]);
        const actions = engine.getAllNextActions(db);
        const scopeAction = actions.find((a) => a.scope === "s1");
        assert_1.default.strictEqual(scopeAction.action, "command");
        // conditions.js would block agent spawn, allow only command execution
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
            { type: "SEMANTIC", prompt: "Check." },
            { type: "REVIEW", agent: "rev", maxRounds: 3 },
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
            { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
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
            { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
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
        engine.createPipeline(db, scope, "builder", [{ type: "SEMANTIC", prompt: "Check." }]);
        assert_1.default.ok(crud.pipelineExists(db, scope));
    });
});
test("source semantic FAIL overrides artifact PASS in engine", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "SEMANTIC", prompt: "Check quality." },
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        // Source artifact says PASS but semantic says FAIL → engine should get FAIL
        const a = engine.step(db, "s1", { role: "source", artifactVerdict: "FAIL", semanticVerdict: "FAIL" });
        // FAIL normalized to REVISE → source action (source re-runs)
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "revision");
    });
});
test("SEMANTIC FAIL → revision → source re-completes → step reactivated correctly", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "SEMANTIC", prompt: "Check quality." },
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        // Source fails SEMANTIC check → pipeline enters revision
        const a1 = engine.step(db, "s1", { role: "source", artifactVerdict: "FAIL" });
        assert_1.default.strictEqual(a1.action, "source");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "revision");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 0).status, "revise");
        // Source re-completes → reactivate SEMANTIC step
        const a2 = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
        // Should return semantic action (step reactivated)
        assert_1.default.strictEqual(a2.action, "semantic");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "normal");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 0).status, "active");
        // Now SEMANTIC can be re-run and passed
        const a3 = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
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
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        engine.step(db, "s1", "REVISE"); // reviewer → revise → source must re-run
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "revision");
        // Source re-completes — engine detects revision state
        const a = engine.step(db, "s1", { role: "source", artifactVerdict: "PASS" });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "normal");
    });
});
test("fixer step({ role: 'fixer' }) reactivates step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "patcher" },
        ]);
        engine.step(db, "s1", "REVISE"); // → fix
        assert_1.default.strictEqual(crud.getStepByStatus(db, "s1", "fix").fixer, "patcher");
        const a = engine.step(db, "s1", { role: "fixer", artifactVerdict: "PASS" });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer"); // reviewer re-runs
    });
});
test("gate agent PASS advances to next step", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW", agent: "rev1", maxRounds: 3 },
            { type: "REVIEW", agent: "rev2", maxRounds: 2 },
        ]);
        const a = engine.step(db, "s1", "PASS"); // rev1 passes → rev2 active
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "rev2");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 0).status, "passed");
        assert_1.default.strictEqual(crud.getStep(db, "s1", 1).status, "active");
    });
});
test("gate agent semantic FAIL via engine: round increment + re-run", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
        ]);
        const a = engine.step(db, "s1", { role: "verifier", artifactVerdict: "PASS", semanticVerdict: "FAIL" });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "reviewer");
        assert_1.default.strictEqual(a.round, 1); // round incremented
        assert_1.default.strictEqual(crud.getActiveStep(db, "s1").status, "active");
    });
});
test("gate agent semantic FAIL via engine: exhaustion → failed", () => {
    withDb((db) => {
        engine.createPipeline(db, "s1", "worker", [
            { type: "REVIEW", agent: "reviewer", maxRounds: 0 },
        ]);
        // maxRounds=0: first FAIL → round 1, 1 > 0 → exhausted
        const a = engine.step(db, "s1", { role: "verifier", artifactVerdict: "PASS", semanticVerdict: "FAIL" });
        assert_1.default.strictEqual(a.action, "failed");
        assert_1.default.strictEqual(crud.getPipelineState(db, "s1").status, "failed");
    });
});
test("VERDICT_RE matches standard result lines", () => {
    assert_1.default.ok(shared.VERDICT_RE.test("Result: PASS"));
    assert_1.default.ok(shared.VERDICT_RE.test("Result: FAIL"));
    assert_1.default.ok(shared.VERDICT_RE.test("Result: REVISE"));
    assert_1.default.ok(shared.VERDICT_RE.test("Result: CONVERGED"));
    assert_1.default.ok(!shared.VERDICT_RE.test("No result here"));
});
test("VERDICT_RE matches Verdict: prefix and bold formatting", () => {
    assert_1.default.ok(shared.VERDICT_RE.test("Verdict: PASS"));
    assert_1.default.ok(shared.VERDICT_RE.test("**Verdict: CONVERGED — PASS**"));
    assert_1.default.ok(shared.VERDICT_RE.test("**Result: PASS**"));
    const m = shared.VERDICT_RE.exec("**Verdict: CONVERGED — PASS**");
    assert_1.default.strictEqual(m[1], "CONVERGED", "should capture first verdict keyword");
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
// ══════════════════════════════════════════════════════════════════════
console.log(`\n${"=".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
//# sourceMappingURL=pipeline-test.js.map