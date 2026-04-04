#!/usr/bin/env node
"use strict";
/**
 * Performance benchmarks for claude-gates pipeline engine.
 *
 * Measures: pipeline creation, state transitions, concurrent scope isolation,
 * and raw DB read/write latency.
 *
 * Run: node scripts/benchmark.js
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
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const perf_hooks_1 = require("perf_hooks");
const crud = __importStar(require("./Database.js"));
const engine = __importStar(require("./StateMachine.js"));
// ── Setup ────────────────────────────────────────────────────────────
const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "cg-bench-"));
const db = crud.getDb(tmpDir);
const ITERATIONS = 1000;
const PARALLEL_COUNT = 10;
function bench(name, fn) {
    // Warmup
    for (let i = 0; i < 10; i++) {
        fn(i);
    }
    const start = perf_hooks_1.performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        fn(i);
    }
    const elapsed = perf_hooks_1.performance.now() - start;
    return {
        name,
        total: elapsed.toFixed(2),
        perOp: (elapsed / ITERATIONS).toFixed(3),
        opsPerSec: Math.round(ITERATIONS / (elapsed / 1000)),
    };
}
// ── Benchmarks ───────────────────────────────────────────────────────
const results = [];
// 1. Pipeline creation (DB init + insert pipeline + steps)
results.push(bench("Pipeline creation (3 steps)", (i) => {
    const scope = `bench-create-${i}`;
    engine.createPipeline(db, scope, "worker", [
        { type: "CHECK", prompt: "Check quality", },
        { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 3, fixer: "fixer", },
    ]);
}));
// 2. State transitions (step() calls — PASS through 3-step pipeline)
// Pre-create pipelines for stepping
for (let i = 0; i < ITERATIONS; i++) {
    const scope = `bench-step-${i}`;
    engine.createPipeline(db, scope, "worker", [
        { type: "CHECK", prompt: "Check", },
        { type: "VERIFY", agent: "reviewer", maxRounds: 3, },
        { type: "VERIFY_W_FIXER", agent: "reviewer", maxRounds: 2, fixer: "fixer", },
    ]);
    // Activate first step
    crud.updateStepStatus(db, scope, 0, "active");
}
results.push(bench("State transition (step → PASS)", (i) => {
    engine.step(db, `bench-step-${i}`, "PASS");
}));
// 3. DB read latency (getPipelineState)
results.push(bench("DB read (getPipelineState)", (i) => {
    crud.getPipelineState(db, `bench-create-${i}`);
}));
// 4. DB write latency (setVerdict on agents table)
for (let i = 0; i < ITERATIONS; i++) {
    crud.registerAgent(db, `bench-create-${i}`, `agent-${i}`, `/tmp/out-${i}.md`);
}
results.push(bench("DB write (setVerdict)", (i) => {
    crud.setVerdict(db, `bench-create-${i}`, `agent-${i}`, "PASS", 0);
}));
// 5. Concurrent scope isolation (create + step N independent pipelines)
const concurrentStart = perf_hooks_1.performance.now();
for (let run = 0; run < ITERATIONS; run++) {
    for (let p = 0; p < PARALLEL_COUNT; p++) {
        const scope = `bench-parallel-${run}-${p}`;
        engine.createPipeline(db, scope, "worker", [
            { type: "CHECK", prompt: "Check", },
        ]);
        crud.updateStepStatus(db, scope, 0, "active");
        engine.step(db, scope, "PASS");
    }
}
const concurrentElapsed = perf_hooks_1.performance.now() - concurrentStart;
results.push({
    name: `Concurrent isolation (${PARALLEL_COUNT} pipelines)`,
    total: concurrentElapsed.toFixed(2),
    perOp: (concurrentElapsed / ITERATIONS).toFixed(3),
    opsPerSec: Math.round(ITERATIONS / (concurrentElapsed / 1000)),
});
// ── Output ───────────────────────────────────────────────────────────
console.log(`\nclaude-gates benchmark — ${ITERATIONS} iterations each\n`);
const nameWidth = 42;
const colWidth = 14;
const header = "Benchmark".padEnd(nameWidth)
    + "Total (ms)".padStart(colWidth)
    + "Per op (ms)".padStart(colWidth)
    + "Ops/sec".padStart(colWidth);
console.log(header);
console.log("─".repeat(header.length));
for (const r of results) {
    console.log(r.name.padEnd(nameWidth)
        + r.total.padStart(colWidth)
        + r.perOp.padStart(colWidth)
        + String(r.opsPerSec).padStart(colWidth));
}
console.log();
// Cleanup
db.close();
fs_1.default.rmSync(tmpDir, { recursive: true, force: true, });
//# sourceMappingURL=Benchmark.js.map