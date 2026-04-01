#!/usr/bin/env node
/**
 * Performance benchmarks for claude-gates pipeline engine.
 *
 * Measures: pipeline creation, state transitions, concurrent scope isolation,
 * and raw DB read/write latency.
 *
 * Run: node scripts/benchmark.js
 */

const { performance } = require("perf_hooks");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crud = require("./pipeline-db.js");
const engine = require("./pipeline.js");

// ── Setup ────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-bench-"));
const db = crud.getDb(tmpDir);

const ITERATIONS = 1000;
const PARALLEL_COUNT = 10;

function bench(name, fn) {
  // Warmup
  for (let i = 0; i < 10; i++) fn(i);

  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) fn(i);
  const elapsed = performance.now() - start;

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
results.push(
  bench("Pipeline creation (3 steps)", (i) => {
    const scope = `bench-create-${i}`;
    engine.createPipeline(db, scope, "worker", [
      { type: "SEMANTIC", prompt: "Check quality" },
      { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
      { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 3, fixer: "fixer" },
    ]);
  })
);

// 2. State transitions (step() calls — PASS through 3-step pipeline)
// Pre-create pipelines for stepping
for (let i = 0; i < ITERATIONS; i++) {
  const scope = `bench-step-${i}`;
  engine.createPipeline(db, scope, "worker", [
    { type: "SEMANTIC", prompt: "Check" },
    { type: "REVIEW", agent: "reviewer", maxRounds: 3 },
    { type: "REVIEW_WITH_FIXER", agent: "reviewer", maxRounds: 2, fixer: "fixer" },
  ]);
  // Activate first step
  crud.updateStepStatus(db, scope, 0, "active");
}

results.push(
  bench("State transition (step → PASS)", (i) => {
    engine.step(db, `bench-step-${i}`, "PASS");
  })
);

// 3. DB read latency (getPipelineState)
results.push(
  bench("DB read (getPipelineState)", (i) => {
    crud.getPipelineState(db, `bench-create-${i}`);
  })
);

// 4. DB write latency (setVerdict on agents table)
for (let i = 0; i < ITERATIONS; i++) {
  crud.registerAgent(db, `bench-create-${i}`, `agent-${i}`, `/tmp/out-${i}.md`);
}

results.push(
  bench("DB write (setVerdict)", (i) => {
    crud.setVerdict(db, `bench-create-${i}`, `agent-${i}`, "PASS");
  })
);

// 5. Concurrent scope isolation (create + step N independent pipelines)
const concurrentStart = performance.now();
for (let run = 0; run < ITERATIONS; run++) {
  for (let p = 0; p < PARALLEL_COUNT; p++) {
    const scope = `bench-parallel-${run}-${p}`;
    engine.createPipeline(db, scope, "worker", [
      { type: "SEMANTIC", prompt: "Check" },
    ]);
    crud.updateStepStatus(db, scope, 0, "active");
    engine.step(db, scope, "PASS");
  }
}
const concurrentElapsed = performance.now() - concurrentStart;

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

const header =
  "Benchmark".padEnd(nameWidth) +
  "Total (ms)".padStart(colWidth) +
  "Per op (ms)".padStart(colWidth) +
  "Ops/sec".padStart(colWidth);

console.log(header);
console.log("─".repeat(header.length));

for (const r of results) {
  console.log(
    r.name.padEnd(nameWidth) +
    r.total.padStart(colWidth) +
    r.perOp.padStart(colWidth) +
    String(r.opsPerSec).padStart(colWidth)
  );
}

console.log();

// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
