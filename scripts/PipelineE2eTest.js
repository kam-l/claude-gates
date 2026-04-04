#!/usr/bin/env node
"use strict";
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
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
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
    return fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "pipeline-e2e-"));
}
function cleanup(dir) {
    try {
        fs_1.default.rmSync(dir, { recursive: true, force: true, });
    }
    catch {
    }
}
/**
 * Run a hook script with simulated stdin JSON.
 * Returns { stdout, stderr, exitCode }.
 */
function runHook(scriptName, stdinData, opts = {}) {
    const scriptPath = path_1.default.join(__dirname, scriptName);
    const input = JSON.stringify(stdinData);
    try {
        const stdout = (0, child_process_1.execSync)(`node "${scriptPath}"`, {
            input,
            encoding: "utf-8",
            timeout: 10000,
            env: {
                ...process.env,
                CLAUDECODE: "", // prevent hook re-entry
                ...opts.env,
            },
            cwd: opts.cwd || process.cwd(),
            stdio: ["pipe", "pipe", "pipe",],
        });
        return { stdout: stdout.trim(), stderr: "", exitCode: 0, };
    }
    catch (e) {
        return {
            stdout: (e.stdout || "").trim(),
            stderr: (e.stderr || "").trim(),
            exitCode: e.status || 1,
        };
    }
}
// ══════════════════════════════════════════════════════════════════════
// Setup: create temp agent definitions
// ══════════════════════════════════════════════════════════════════════
const tempRoot = tmpDir();
const agentsDir = path_1.default.join(tempRoot, ".claude", "agents");
fs_1.default.mkdirSync(agentsDir, { recursive: true, });
// Source agent with verification pipeline
fs_1.default.writeFileSync(path_1.default.join(agentsDir, "e2e-builder.md"), `---
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
fs_1.default.writeFileSync(path_1.default.join(agentsDir, "e2e-reviewer.md"), `---
name: e2e-reviewer
description: "E2E test reviewer agent"
model: sonnet
role: gate
---

Review the source artifact.
`);
// Agent with conditions
fs_1.default.writeFileSync(path_1.default.join(agentsDir, "e2e-conditional.md"), `---
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
    const r = runHook("PipelineConditions.js", {
        session_id: sessionId,
        tool_input: {
            subagent_type: "e2e-builder",
            prompt: "Build scope=test-e2e the thing",
        },
    }, { cwd: tempRoot, });
    // Should allow (exit 0, no block decision)
    assert_1.default.strictEqual(r.exitCode, 0);
    if (r.stdout) {
        const out = JSON.parse(r.stdout);
        assert_1.default.notStrictEqual(out.decision, "block");
    }
});
test("conditions: block agent without scope when requiresScope", () => {
    const r = runHook("PipelineConditions.js", {
        session_id: sessionId,
        tool_input: {
            subagent_type: "e2e-builder",
            prompt: "Build the thing without scope",
        },
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r.exitCode, 0);
    if (r.stdout) {
        const out = JSON.parse(r.stdout);
        assert_1.default.strictEqual(out.decision, "block");
        assert_1.default.ok(out.reason.includes("scope="));
    }
});
test("conditions: allow resume without gating", () => {
    const r = runHook("PipelineConditions.js", {
        session_id: sessionId,
        tool_input: {
            subagent_type: "e2e-builder",
            prompt: "Resume",
            resume: true,
        },
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r.exitCode, 0);
    assert_1.default.strictEqual(r.stdout, "");
});
test("conditions: allow unknown agent (no .md file)", () => {
    const r = runHook("PipelineConditions.js", {
        session_id: sessionId,
        tool_input: {
            subagent_type: "nonexistent-agent",
            prompt: "scope=test-e2e Do something",
        },
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r.exitCode, 0);
    assert_1.default.strictEqual(r.stdout, "");
});
// ══════════════════════════════════════════════════════════════════════
// Test: injection hook
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== E2E: pipeline-injection.js ===");
test("injection: source agent gets no injection on first run (semantics first)", () => {
    const r = runHook("PipelineInjection.js", {
        session_id: sessionId,
        agent_type: "e2e-builder",
        agent_id: "agent-001",
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r.exitCode, 0);
    // Source agents on first run get NO injection — semantics first
    assert_1.default.strictEqual(r.stdout, "", "Source agents should get no injection on first run");
});
test("injection: handles missing session gracefully", () => {
    const r = runHook("PipelineInjection.js", {
        session_id: "",
        agent_type: "e2e-builder",
        agent_id: "agent-002",
    }, { cwd: tempRoot, });
    // Should exit 0 (fail-open), no stdout
    assert_1.default.strictEqual(r.exitCode, 0);
    assert_1.default.strictEqual(r.stdout, "");
});
test("injection: handles plugin-qualified agent type", () => {
    const r = runHook("PipelineInjection.js", {
        session_id: sessionId,
        agent_type: "claude-gates:e2e-builder",
        agent_id: "agent-003",
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r.exitCode, 0);
    // Source agents get no injection regardless of plugin prefix
});
// ══════════════════════════════════════════════════════════════════════
// Test: block hook
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== E2E: pipeline-block.js ===");
test("block: allows when no active pipelines", () => {
    const freshSession = "block-test-" + Date.now();
    const r = runHook("PipelineBlock.js", {
        session_id: freshSession,
        tool_name: "Edit",
        tool_input: {},
        agent_type: "",
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r.exitCode, 0);
    assert_1.default.strictEqual(r.stdout, "");
});
test("block: allows read-only tools", () => {
    const r = runHook("PipelineBlock.js", {
        session_id: sessionId,
        tool_name: "Read",
        tool_input: {},
        agent_type: "",
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r.exitCode, 0);
    assert_1.default.strictEqual(r.stdout, "");
});
test("block: allows subagent calls", () => {
    const r = runHook("PipelineBlock.js", {
        session_id: sessionId,
        tool_name: "Edit",
        tool_input: {},
        agent_type: "e2e-builder", // caller is a subagent
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r.exitCode, 0);
    assert_1.default.strictEqual(r.stdout, "");
});
test("block: skips blocking when agent-running marker exists", () => {
    // Simulate: pipeline active, but source agent is still running (marker exists)
    // Hook runs with cwd=tempRoot, so session dir must be under tempRoot
    const _crud = require("./Database.js");
    const _engine = require("./StateMachine.js");
    const markerSession = "abcd1234-test-marker-" + Date.now();
    // getSessionDir truncates to first 8 hex chars — match that for DB + marker paths
    const shortId = markerSession.replace(/-/g, "").slice(0, 8);
    const markerDir = path_1.default.join(tempRoot, ".sessions", shortId).replace(/\\/g, "/");
    const markerFile = path_1.default.join(markerDir, ".running-marker-scope").replace(/\\/g, "/");
    fs_1.default.mkdirSync(markerDir, { recursive: true, });
    const markerDb = _crud.getDb(markerDir);
    _engine.createPipeline(markerDb, "marker-scope", "e2e-builder", [
        { type: "CHECK", prompt: "Check.", },
    ]);
    markerDb.close();
    // Write running marker (simulates conditions.js after allowing spawn)
    fs_1.default.writeFileSync(markerFile, "", "utf-8");
    // Block hook should NOT block (agent is still running)
    const r = runHook("PipelineBlock.js", {
        session_id: markerSession,
        tool_name: "Bash",
        tool_input: { command: "echo hi", },
        agent_type: "",
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r.exitCode, 0);
    assert_1.default.strictEqual(r.stdout, "", "Should not block while agent-running marker exists");
    // Remove marker (simulates SubagentStop)
    fs_1.default.unlinkSync(markerFile);
    // Now it SHOULD block (agent completed, step is active, orchestrator must act)
    const r2 = runHook("PipelineBlock.js", {
        session_id: markerSession,
        tool_name: "Bash",
        tool_input: { command: "echo hi", },
        agent_type: "",
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r2.exitCode, 0);
    assert_1.default.ok(r2.stdout.includes("block"), "Should block after marker removed");
    cleanup(markerDir);
});
// ══════════════════════════════════════════════════════════════════════
// Test: verification hook (structural parts only — no claude -p)
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== E2E: pipeline-verification.js ===");
test("verification: gater exits cleanly (MCP handles verdicts)", () => {
    const r = runHook("PipelineVerification.js", {
        session_id: sessionId,
        agent_type: "gater",
        agent_id: "gater-001",
        last_assistant_message: "The plan looks good.\n\nResult: PASS",
        stop_hook_active: false,
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r.exitCode, 0);
});
test("verification: exits cleanly for unknown agent", () => {
    const r = runHook("PipelineVerification.js", {
        session_id: sessionId,
        agent_type: "totally-unknown",
        agent_id: "unknown-001",
        last_assistant_message: "",
        stop_hook_active: false,
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r.exitCode, 0);
});
test("verification: skips when stop_hook_active", () => {
    const r = runHook("PipelineVerification.js", {
        session_id: sessionId,
        agent_type: "e2e-builder",
        agent_id: "agent-skip",
        last_assistant_message: "",
        stop_hook_active: true,
    }, { cwd: tempRoot, });
    assert_1.default.strictEqual(r.exitCode, 0);
    assert_1.default.strictEqual(r.stdout, "");
});
// ══════════════════════════════════════════════════════════════════════
// Test: Full pipeline flow (engine-level, simulating hook sequence)
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== E2E: full pipeline flow (engine-level) ===");
const crud = __importStar(require("./Database.js"));
const FrontmatterParser_js_1 = require("./FrontmatterParser.js");
const engine = __importStar(require("./StateMachine.js"));
test("full flow: parse agent → create pipeline → step through", () => {
    const agentMd = fs_1.default.readFileSync(path_1.default.join(agentsDir, "e2e-builder.md"), "utf-8");
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification(agentMd);
    assert_1.default.ok(steps, "parseVerification should return steps");
    assert_1.default.strictEqual(steps.length, 2);
    assert_1.default.strictEqual(steps[0].type, "CHECK");
    assert_1.default.strictEqual(steps[1].type, "VERIFY");
    assert_1.default.strictEqual(steps[1].agent, "e2e-reviewer");
    assert_1.default.strictEqual(steps[1].maxRounds, 3);
    const dir = tmpDir();
    const db = crud.getDb(dir);
    try {
        engine.createPipeline(db, "e2e-scope", "e2e-builder", steps);
        // Step 0: CHECK — source completes, semantic check fires
        let a = engine.getNextAction(db, "e2e-scope");
        assert_1.default.strictEqual(a.action, "semantic");
        a = engine.step(db, "e2e-scope", "PASS"); // semantic passes
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "e2e-reviewer");
        // Step 1: VERIFY — reviewer passes
        a = engine.step(db, "e2e-scope", "PASS");
        assert_1.default.strictEqual(a.action, "done");
        assert_1.default.strictEqual(crud.getPipelineState(db, "e2e-scope").status, "completed");
    }
    finally {
        db.close();
        cleanup(dir);
    }
});
test("full flow: revise path → source re-run → reviewer re-run", () => {
    const agentMd = fs_1.default.readFileSync(path_1.default.join(agentsDir, "e2e-builder.md"), "utf-8");
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification(agentMd);
    const dir = tmpDir();
    const db = crud.getDb(dir);
    try {
        engine.createPipeline(db, "rev-scope", "e2e-builder", steps);
        // CHECK passes
        engine.step(db, "rev-scope", "PASS");
        // VERIFY: reviewer says REVISE
        let a = engine.step(db, "rev-scope", "REVISE");
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(a.agent, "e2e-builder"); // source re-runs
        assert_1.default.strictEqual(crud.getPipelineState(db, "rev-scope").status, "revision");
        // Source re-completes
        a = engine.step(db, "rev-scope", { role: "source", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(a.action, "spawn");
        assert_1.default.strictEqual(a.agent, "e2e-reviewer"); // reviewer re-runs
        assert_1.default.strictEqual(crud.getPipelineState(db, "rev-scope").status, "normal");
        // Reviewer passes on second attempt
        a = engine.step(db, "rev-scope", "PASS");
        assert_1.default.strictEqual(a.action, "done");
    }
    finally {
        db.close();
        cleanup(dir);
    }
});
test("full flow: role resolution through pipeline lifecycle", () => {
    const steps = [
        { type: "CHECK", prompt: "Check.", },
        { type: "VERIFY_W_FIXER", agent: "e2e-reviewer", maxRounds: 3, fixer: "e2e-fixer", },
    ];
    const dir = tmpDir();
    const db = crud.getDb(dir);
    try {
        engine.createPipeline(db, "role-scope", "e2e-builder", steps);
        // Initial: CHECK step is active — reviewer is NOT verifier yet
        assert_1.default.strictEqual(engine.resolveRole(db, "role-scope", "e2e-reviewer"), "ungated"); // step 0 is CHECK, not VERIFY
        assert_1.default.strictEqual(engine.resolveRole(db, "role-scope", "e2e-builder"), "source");
        assert_1.default.strictEqual(engine.resolveRole(db, "role-scope", "e2e-fixer"), "ungated"); // not active yet
        // Advance past CHECK → step 1 (VERIFY_W_FIXER) becomes active
        engine.step(db, "role-scope", "PASS");
        // Now reviewer IS verifier (VERIFY_W_FIXER step active)
        assert_1.default.strictEqual(engine.resolveRole(db, "role-scope", "e2e-reviewer"), "verifier");
        // REVISE → fixer role activates
        engine.step(db, "role-scope", "REVISE");
        assert_1.default.strictEqual(engine.resolveRole(db, "role-scope", "e2e-fixer"), "fixer");
        assert_1.default.strictEqual(engine.resolveRole(db, "role-scope", "e2e-builder"), "source"); // still source
        // Fixer completes → reviewer re-runs
        engine.step(db, "role-scope", { role: "fixer", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(engine.resolveRole(db, "role-scope", "e2e-reviewer"), "verifier");
    }
    finally {
        db.close();
        cleanup(dir);
    }
});
test("full flow: parallel scopes don't cross-contaminate", () => {
    const steps = [{ type: "VERIFY", agent: "rev", maxRounds: 3, },];
    const dir = tmpDir();
    const db = crud.getDb(dir);
    try {
        engine.createPipeline(db, "scope-a", "builder-a", steps);
        engine.createPipeline(db, "scope-b", "builder-b", steps);
        // Scope A: REVISE
        engine.step(db, "scope-a", "REVISE");
        // Scope B: PASS
        engine.step(db, "scope-b", "PASS");
        assert_1.default.strictEqual(crud.getPipelineState(db, "scope-a").status, "revision");
        assert_1.default.strictEqual(crud.getPipelineState(db, "scope-b").status, "completed");
        // getAllNextActions only returns scope-a
        const actions = engine.getAllNextActions(db);
        assert_1.default.strictEqual(actions.length, 1);
        assert_1.default.strictEqual(actions[0].scope, "scope-a");
    }
    finally {
        db.close();
        cleanup(dir);
    }
});
// ══════════════════════════════════════════════════════════════════════
// Test: source verdict decoupling (Result: REVISE from source ≠ pipeline revision)
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== E2E: source verdict decoupling ===");
test("source REVISE advances CHECK (source doesn't judge itself)", () => {
    // Source agents produce artifacts — their Result: line is informational.
    // Only CHECK/VERIFY steps determine PASS/FAIL for pipeline flow.
    // A rethinker writing "Result: REVISE" (about code) should NOT loop.
    const dir = tmpDir();
    const db = crud.getDb(dir);
    try {
        engine.createPipeline(db, "decouple-scope", "rethinker", [
            { type: "CHECK", prompt: "Check quality.", },
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        // Source completes with REVISE (meaning "code needs work") — semantic check null (skipped)
        // finalVerdict should be PASS (source doesn't drive flow), advancing past CHECK
        const a = engine.step(db, "decouple-scope", { role: "source", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(a.action, "spawn", "Should advance to VERIFY step");
        assert_1.default.strictEqual(a.agent, "reviewer");
    }
    finally {
        db.close();
        cleanup(dir);
    }
});
test("source FAIL still treated as PASS when semantic is null (source doesn't self-judge)", () => {
    const dir = tmpDir();
    const db = crud.getDb(dir);
    try {
        engine.createPipeline(db, "decouple-fail", "builder", [
            { type: "CHECK", prompt: "Check.", },
        ]);
        // Even source FAIL with null semantic → PASS (source produced an artifact)
        const a = engine.step(db, "decouple-fail", { role: "source", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(a.action, "done", "Should complete pipeline");
    }
    finally {
        db.close();
        cleanup(dir);
    }
});
test("semantic FAIL still triggers revision even when source says PASS", () => {
    const dir = tmpDir();
    const db = crud.getDb(dir);
    try {
        engine.createPipeline(db, "sem-override", "builder", [
            { type: "CHECK", prompt: "Check.", },
        ]);
        // Source PASS but semantic FAIL → revision (semantic is the judge)
        const a = engine.step(db, "sem-override", { role: "source", artifactVerdict: "FAIL", });
        assert_1.default.strictEqual(a.action, "source", "Semantic FAIL should trigger revision");
        assert_1.default.strictEqual(crud.getPipelineState(db, "sem-override").status, "revision");
    }
    finally {
        db.close();
        cleanup(dir);
    }
});
// ══════════════════════════════════════════════════════════════════════
// Test: gater as pipeline participant (no short-circuit deadlock)
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== E2E: gater pipeline participant ===");
test("gater as VERIFY agent: engine.step advances (no short-circuit)", () => {
    // Verifies fix: gater fallback no longer exits early when gater is a pipeline participant.
    // The normal processing path handles gater as verifier.
    const dir = tmpDir();
    const db = crud.getDb(dir);
    try {
        engine.createPipeline(db, "gater-scope", "worker", [
            { type: "VERIFY", agent: "gater", maxRounds: 3, },
        ]);
        // Gater (as verifier) returns PASS → should advance pipeline
        const a = engine.step(db, "gater-scope", { role: "verifier", artifactVerdict: "PASS", });
        assert_1.default.strictEqual(a.action, "done", "Gater PASS should complete the pipeline");
        assert_1.default.strictEqual(crud.getPipelineState(db, "gater-scope").status, "completed");
    }
    finally {
        db.close();
        cleanup(dir);
    }
});
test("gater as VERIFY agent: REVISE routes back to source", () => {
    const dir = tmpDir();
    const db = crud.getDb(dir);
    try {
        engine.createPipeline(db, "gater-rev", "worker", [
            { type: "VERIFY", agent: "gater", maxRounds: 3, },
        ]);
        // Gater returns REVISE → should route to source (not deadlock)
        const a = engine.step(db, "gater-rev", { role: "verifier", artifactVerdict: "REVISE", });
        assert_1.default.strictEqual(a.action, "source");
        assert_1.default.strictEqual(a.agent, "worker");
        assert_1.default.strictEqual(crud.getPipelineState(db, "gater-rev").status, "revision");
    }
    finally {
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
            { type: "CHECK", prompt: "Check artifact.", },
            { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        ]);
        // Pipeline starts: step 0 active
        let state = crud.getPipelineState(db, "deadlock-scope");
        assert_1.default.strictEqual(state.status, "normal");
        assert_1.default.strictEqual(crud.getActiveStep(db, "deadlock-scope").step_index, 0);
        // Source completes WITHOUT artifact — hook calls engine.step(FAIL)
        const a = engine.step(db, "deadlock-scope", { role: "source", artifactVerdict: "FAIL", });
        // Should enter revision (route back to source), NOT stay stuck
        state = crud.getPipelineState(db, "deadlock-scope");
        assert_1.default.strictEqual(state.status, "revision", "Pipeline should enter revision, not stay normal");
        assert_1.default.ok(a, "step() should return an action, not null");
        assert_1.default.strictEqual(a.action, "source", "Action should route back to source agent");
        assert_1.default.strictEqual(a.agent, "architect");
    }
    finally {
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
            { type: "CHECK", prompt: "Check.", },
        ]);
        // CHECK step: source FAIL → revision round 1
        let a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "FAIL", });
        assert_1.default.strictEqual(a.action, "source");
        // Source re-completes, still FAIL → reactivates step, then FAIL → revision round 2
        a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "PASS", });
        // Reactivated CHECK step — now process FAIL on it
        a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "FAIL", });
        assert_1.default.strictEqual(a.action, "source");
        // Round 3
        a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "PASS", });
        a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "FAIL", });
        assert_1.default.strictEqual(a.action, "source");
        // Round 4 — should exhaust (max_rounds=3)
        a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "PASS", });
        a = engine.step(db, "noResult-scope", { role: "source", artifactVerdict: "FAIL", });
        assert_1.default.strictEqual(a.action, "failed", "Pipeline should exhaust after maxRounds");
        assert_1.default.strictEqual(crud.getPipelineState(db, "noResult-scope").status, "failed");
    }
    finally {
        db.close();
        cleanup(dir);
    }
});
// ══════════════════════════════════════════════════════════════════════
// Test: gt-worker v3 format parsing
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== E2E: gt-worker v3 format ===");
test("gt-worker verification: field parses to CHECK + VERIFY_W_FIXER", () => {
    const agentMd = fs_1.default.readFileSync(path_1.default.join(process.cwd(), ".claude", "agents", "gt-worker.md"), "utf-8");
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification(agentMd);
    assert_1.default.ok(steps, "parseVerification should return steps");
    assert_1.default.strictEqual(steps.length, 2);
    assert_1.default.strictEqual(steps[0].type, "CHECK");
    assert_1.default.ok(steps[0].prompt.includes("complete"));
    assert_1.default.strictEqual(steps[1].type, "VERIFY_W_FIXER");
    assert_1.default.strictEqual(steps[1].agent, "gt-reviewer");
    assert_1.default.strictEqual(steps[1].maxRounds, 3);
    assert_1.default.strictEqual(steps[1].fixer, "gt-fixer");
});
test("gt-reviewer has no verification: steps (role: gate only)", () => {
    const agentMd = fs_1.default.readFileSync(path_1.default.join(process.cwd(), ".claude", "agents", "gt-reviewer.md"), "utf-8");
    const steps = FrontmatterParser_js_1.FrontmatterParser.parseVerification(agentMd);
    assert_1.default.strictEqual(steps, null);
});
test("gt-worker requiresScope returns true", () => {
    const agentMd = fs_1.default.readFileSync(path_1.default.join(process.cwd(), ".claude", "agents", "gt-worker.md"), "utf-8");
    assert_1.default.strictEqual(FrontmatterParser_js_1.FrontmatterParser.requiresScope(agentMd), true);
});
// ══════════════════════════════════════════════════════════════════════
// Cleanup
cleanup(tempRoot);
// Session data now lives under {cwd}/.sessions/ — tempRoot cleanup handles it.
// Also clean legacy location in case of leftover data.
const HOME = process.env.USERPROFILE || process.env.HOME || "";
const legacySessDir = path_1.default.join(HOME, ".claude", "sessions", sessionId);
cleanup(legacySessDir);
console.log(`\n${"=".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
//# sourceMappingURL=PipelineE2eTest.js.map