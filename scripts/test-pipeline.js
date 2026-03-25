#!/usr/bin/env node
/**
 * Integration test: full gate pipeline with test agents.
 * Tests happy path (builder→reviewer→playtester) and revise path.
 * Run: node scripts/test-pipeline.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");

const PLUGIN = path.resolve(__dirname, "..");
const CONDITIONS = path.join(PLUGIN, "scripts/claude-gates-conditions.js");
const VERIFY = path.join(PLUGIN, "scripts/claude-gates-verification.js");
const INJECT = path.join(PLUGIN, "scripts/claude-gates-injection.js");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-pipe-"));
const agentsDir = path.join(HOME, ".claude", "agents");
fs.mkdirSync(agentsDir, { recursive: true });

fs.writeFileSync(path.join(agentsDir, "builder.md"),
  "---\nname: builder\ngates:\n  - [reviewer, 3]\n  - [playtester, 2]\n---\n# Builder\n");
fs.writeFileSync(path.join(agentsDir, "reviewer.md"),
  '---\nname: reviewer\nverification: |\n  Review check.\n  Reply PASS or FAIL.\n---\n# Reviewer\n');
fs.writeFileSync(path.join(agentsDir, "playtester.md"),
  '---\nname: playtester\nverification: |\n  Play check.\n  Reply PASS or FAIL.\n---\n# Playtester\n');

const { spawnSync } = require("child_process");
const env = { ...process.env, HOME, USERPROFILE: HOME };
let pass = 0, fail = 0;

function run(script, payload) {
  const result = spawnSync("node", [script], {
    input: JSON.stringify(payload), encoding: "utf-8", timeout: 10000, cwd: HOME, env
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS: ${msg}`); }
  else { fail++; console.error(`  FAIL: ${msg}`); }
}

function isBlocked(r) { return r.stdout.includes('"block"'); }

const sessionDir = path.join(HOME, ".sessions", "s1");
const scopeDir = path.join(sessionDir, "t1");
fs.mkdirSync(scopeDir, { recursive: true });
const norm = sessionDir.replace(/\\/g, "/");

console.log("=== Scope Enforcement ===");
assert(isBlocked(run(CONDITIONS, { session_id: "s1", tool_input: { subagent_type: "builder", prompt: "Build" }})),
  "builder without scope → BLOCK");

console.log("\n=== Happy Path ===");

assert(!isBlocked(run(CONDITIONS, { session_id: "s1", tool_input: { subagent_type: "builder", prompt: "scope=t1 Build" }})),
  "builder with scope → ALLOW");

fs.writeFileSync(path.join(scopeDir, "builder.md"), "# Done\nResult: PASS\n");
const r3 = run(VERIFY, { session_id: "s1", agent_type: "builder", agent_id: "b1",
  last_assistant_message: `Wrote to ${norm}/t1/builder.md` });
assert(r3.stderr.includes("Initialized 2 gate"), "builder PASS → gates initialized");

assert(isBlocked(run(CONDITIONS, { session_id: "s1", tool_input: { subagent_type: "playtester", prompt: "scope=t1 Play" }})),
  "playtester blocked (reviewer is active)");
assert(isBlocked(run(CONDITIONS, { session_id: "s1", tool_input: { subagent_type: "builder", prompt: "scope=t1 More" }})),
  "builder blocked (reviewer is active)");
assert(!isBlocked(run(CONDITIONS, { session_id: "s1", tool_input: { subagent_type: "reviewer", prompt: "scope=t1 Review" }})),
  "reviewer allowed (active gate)");

const rInj = run(INJECT, { session_id: "s1", agent_type: "reviewer", agent_id: "r1" });
assert(rInj.stdout.includes("role=gate"), "injection has role=gate");
assert(rInj.stdout.includes("source_agent=builder"), "injection has source_agent");

fs.writeFileSync(path.join(scopeDir, "reviewer.md"), "# OK\nResult: PASS\n");
const r7 = run(VERIFY, { session_id: "s1", agent_type: "reviewer", agent_id: "r1",
  last_assistant_message: `Wrote to ${norm}/t1/reviewer.md` });
assert(r7.stderr.includes("passed") || r7.stderr.includes("Next gate: playtester") || r7.stderr.includes("Verdict"), "reviewer PASS → advance");

assert(!isBlocked(run(CONDITIONS, { session_id: "s1", tool_input: { subagent_type: "playtester", prompt: "scope=t1 Play" }})),
  "playtester now allowed");

fs.writeFileSync(path.join(scopeDir, "playtester.md"), "# Works\nResult: PASS\n");
const r9 = run(VERIFY, { session_id: "s1", agent_type: "playtester", agent_id: "p1",
  last_assistant_message: `Wrote to ${norm}/t1/playtester.md` });
assert(r9.stderr.includes("All gates passed"), "all gates passed");

assert(!isBlocked(run(CONDITIONS, { session_id: "s1", tool_input: { subagent_type: "builder", prompt: "scope=t1 More" }})),
  "builder unblocked after all gates");

console.log("\n=== Revise Path ===");
const s2Dir = path.join(HOME, ".sessions", "s2", "t2");
fs.mkdirSync(s2Dir, { recursive: true });
const s2Norm = path.join(HOME, ".sessions", "s2").replace(/\\/g, "/");

run(CONDITIONS, { session_id: "s2", tool_input: { subagent_type: "builder", prompt: "scope=t2 Build" }});
fs.writeFileSync(path.join(s2Dir, "builder.md"), "# Done\nResult: PASS\n");
run(VERIFY, { session_id: "s2", agent_type: "builder", agent_id: "b2",
  last_assistant_message: `Wrote to ${s2Norm}/t2/builder.md` });

run(CONDITIONS, { session_id: "s2", tool_input: { subagent_type: "reviewer", prompt: "scope=t2 Review" }});
fs.writeFileSync(path.join(s2Dir, "reviewer.md"), "# Needs work\nResult: REVISE\n");
const rRev = run(VERIFY, { session_id: "s2", agent_type: "reviewer", agent_id: "r2",
  last_assistant_message: `Wrote to ${s2Norm}/t2/reviewer.md` });
assert(rRev.stderr.includes("REVISE"), "reviewer REVISE recorded");

assert(isBlocked(run(CONDITIONS, { session_id: "s2", tool_input: { subagent_type: "reviewer", prompt: "scope=t2 Review" }})),
  "reviewer blocked after REVISE");
assert(!isBlocked(run(CONDITIONS, { session_id: "s2", tool_input: { subagent_type: "builder", prompt: "scope=t2 Fix" }})),
  "builder allowed (source re-run)");

fs.writeFileSync(path.join(s2Dir, "builder.md"), "# Fixed\nResult: PASS\n");
const rReact = run(VERIFY, { session_id: "s2", agent_type: "builder", agent_id: "b2b",
  last_assistant_message: `Wrote to ${s2Norm}/t2/builder.md` });
assert(rReact.stderr.includes("reactivated"), "gate reactivated");

assert(!isBlocked(run(CONDITIONS, { session_id: "s2", tool_input: { subagent_type: "reviewer", prompt: "scope=t2 v2" }})),
  "reviewer allowed after reactivation");

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${"=".repeat(40)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
