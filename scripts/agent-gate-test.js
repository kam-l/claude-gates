#!/usr/bin/env node
/**
 * AgentGate v1 — test suite.
 *
 * Tests shared parsers, compat module, plugin wiring, and hook integration.
 * Run: node scripts/agent-gate-test.js
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");

const shared = require("./agent-gate-shared.js");
const compat = require("./agent-gate-compat.js");

const PLUGIN_ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function describe(name) { console.log(`\n=== ${name} ===`); }
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS: ${msg}`); }
  else { fail++; console.error(`  FAIL: ${msg}`); }
}

// ── extractFrontmatter ──────────────────────────────────────────────

describe("extractFrontmatter");

assert(
  shared.extractFrontmatter("---\nname: foo\n---\nbody") === "name: foo",
  "basic frontmatter"
);

assert(
  shared.extractFrontmatter("---\r\nname: foo\r\n---\r\nbody") === "name: foo",
  "Windows line endings"
);

assert(
  shared.extractFrontmatter("no frontmatter here") === null,
  "no frontmatter returns null"
);

assert(
  shared.extractFrontmatter("---\n---\nbody") === null,
  "empty frontmatter returns null (nothing between fences)"
);

// Indented --- inside block scalar should NOT close frontmatter
const blockScalarFm = "---\nname: foo\ndescription: |\n  Some text\n  ---\n  More text\n---\nbody";
const extracted = shared.extractFrontmatter(blockScalarFm);
assert(
  extracted && extracted.includes("More text"),
  "indented --- inside block scalar does not close frontmatter"
);

// --- at column 0 inside frontmatter DOES close it (YAML document separator)
const yamlDocSep = "---\nname: foo\n---\nsecond doc\n---\nbody";
const extracted2 = shared.extractFrontmatter(yamlDocSep);
assert(
  extracted2 === "name: foo",
  "--- at column 0 closes frontmatter (YAML document separator)"
);

// ── parseRequires ───────────────────────────────────────────────────

describe("parseRequires");

assert(
  JSON.stringify(shared.parseRequires('---\nrequires: ["implementer", "cleaner"]\n---\n')) === '["implementer","cleaner"]',
  "inline array with double quotes"
);

assert(
  JSON.stringify(shared.parseRequires("---\nrequires: ['a', 'b']\n---\n")) === '["a","b"]',
  "inline array with single quotes"
);

assert(
  JSON.stringify(shared.parseRequires('---\nrequires:\n  - implementer\n  - cleaner\n---\n')) === '["implementer","cleaner"]',
  "block sequence unquoted"
);

assert(
  JSON.stringify(shared.parseRequires('---\nrequires:\n  - "implementer"\n  - "cleaner"\n---\n')) === '["implementer","cleaner"]',
  "block sequence double-quoted"
);

assert(
  JSON.stringify(shared.parseRequires("---\nrequires:\n  - 'implementer'\n---\n")) === '["implementer"]',
  "block sequence single-quoted"
);

assert(
  shared.parseRequires('---\nname: foo\n---\n') === null,
  "no requires returns null"
);

assert(
  shared.parseRequires('---\nrequires: []\n---\n') === null,
  "empty array returns null"
);

assert(
  shared.parseRequires("no frontmatter") === null,
  "no frontmatter returns null"
);

// ── parseVerification (new schema) ──────────────────────────────────

describe("parseVerification — new schema");

const newSchemaV = shared.parseVerification(
  '---\nverification: |\n  Evaluate quality.\n  Reply PASS or FAIL.\n---\n'
);
assert(newSchemaV && newSchemaV.startsWith("Evaluate"), "new schema basic");

assert(
  shared.parseVerification('---\nname: foo\n---\n') === null,
  "no verification returns null"
);

const crlfVerification = shared.parseVerification(
  '---\r\nverification: |\r\n  CRLF prompt.\r\n  Second line.\r\n---\r\n'
);
assert(crlfVerification && crlfVerification.startsWith("CRLF"), "CRLF in verification block scalar");

// ── parseVerification (old gate: fallback) ──────────────────────────

describe("parseVerification — old gate: fallback");

const oldSchemaV = shared.parseVerification(
  '---\ngate:\n  artifact: "x"\n  prompt: |\n    Old prompt here.\n    Second line.\n---\n'
);
assert(oldSchemaV && oldSchemaV.startsWith("Old prompt"), "old gate.prompt fallback");

// New schema takes precedence over old
const bothSchemas = shared.parseVerification(
  '---\nverification: |\n  New prompt.\ngate:\n  prompt: |\n    Old prompt.\n---\n'
);
assert(bothSchemas && bothSchemas.startsWith("New"), "new schema takes precedence");

// ── findAgentMd ─────────────────────────────────────────────────────

describe("findAgentMd");

const HOME = process.env.USERPROFILE || process.env.HOME || "";

// Create a temp project with an agent to test project-level lookup
const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "agentgate-project-"));
const tmpAgentsDir = path.join(tmpProject, ".claude", "agents");
fs.mkdirSync(tmpAgentsDir, { recursive: true });
fs.writeFileSync(path.join(tmpAgentsDir, "tester.md"), "---\nname: tester\n---\n");

assert(
  shared.findAgentMd("tester", tmpProject, HOME) !== null &&
  shared.findAgentMd("tester", tmpProject, HOME).endsWith("tester.md"),
  "finds project-level agent"
);

assert(shared.findAgentMd("nonexistent_xyz", tmpProject, HOME) === null, "nonexistent returns null");

fs.rmSync(tmpProject, { recursive: true, force: true });

// ── VERDICT_RE ──────────────────────────────────────────────────────

describe("VERDICT_RE");

assert(shared.VERDICT_RE.test("Result: PASS"), "matches PASS");
assert(shared.VERDICT_RE.test("Result: FAIL reason here"), "matches FAIL with reason");
assert(shared.VERDICT_RE.test("Result: REVISE"), "matches REVISE");
assert(shared.VERDICT_RE.test("Result: CONVERGED"), "matches CONVERGED");
assert(!shared.VERDICT_RE.test("no result here"), "rejects non-match");
assert(shared.VERDICT_RE.test("line1\nResult: PASS\nline3"), "matches in multiline");

// ── compat: parseLegacyGate ─────────────────────────────────────────

describe("compat: parseLegacyGate");

const legacyMd = `---
name: reviewer
gate:
  artifact: "{task_dir}/review.md"
  required: true
  verdict: true
  prompt: |
    Below is a review.md.
    Reply PASS or FAIL.
  context:
    - "{task_dir}/spec.md"
---
body`;

const gate = compat.parseLegacyGate(legacyMd);
assert(gate !== null, "parses legacy gate");
assert(gate.artifact === "{task_dir}/review.md", "artifact field");
assert(gate.required === true, "required field");
assert(gate.verdict === true, "verdict field");
assert(gate.context && gate.context[0] === "{task_dir}/spec.md", "context field");

assert(compat.parseLegacyGate("---\nname: foo\n---\n") === null, "no gate returns null");

// ── compat: resolveTaskDir ──────────────────────────────────────────

describe("compat: resolveTaskDir");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgate-test-"));
const tasksDir = path.join(tmpDir, ".context", "tasks");
fs.mkdirSync(path.join(tasksDir, "1"), { recursive: true });
fs.mkdirSync(path.join(tasksDir, "2"), { recursive: true });
fs.mkdirSync(path.join(tasksDir, "10"), { recursive: true });

const resolved = compat.resolveTaskDir(tmpDir);
assert(resolved === ".context/tasks/10", "resolves highest-numbered task dir");

assert(compat.resolveTaskDir("/nonexistent/path") === null, "nonexistent returns null");

fs.rmSync(tmpDir, { recursive: true, force: true });

// ── Plugin wiring: hooks.json ───────────────────────────────────────

describe("plugin wiring: hooks.json");

const hooksJson = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf-8")
);

const preToolUse = hooksJson.hooks.PreToolUse || [];
const agentHook = preToolUse.find(h => h.matcher === "Agent");
assert(!!agentHook, "PreToolUse:Agent hook registered");
assert(
  agentHook && agentHook.hooks[0].command.includes("agent-gate-conditions"),
  "conditions hook wired"
);
assert(
  agentHook && agentHook.hooks[0].command.includes("${CLAUDE_PLUGIN_ROOT}"),
  "conditions uses ${CLAUDE_PLUGIN_ROOT}"
);

const subStart = hooksJson.hooks.SubagentStart || [];
const injHook = subStart[0];
assert(
  injHook && injHook.hooks.some(h => h.command.includes("agent-gate-injection")),
  "SubagentStart injection hook wired"
);

const subStop = hooksJson.hooks.SubagentStop || [];
const verHook = subStop[0];
assert(
  verHook && verHook.hooks.some(h => h.command.includes("agent-gate-verification")),
  "SubagentStop verification hook wired"
);

// ── Plugin wiring: plugin.json ──────────────────────────────────────

describe("plugin wiring: plugin.json");

const pluginJson = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf-8")
);
assert(!!pluginJson.name, "plugin.json has name");
assert(pluginJson.name === "agent-gate", "name is agent-gate");
assert(!!pluginJson.version, "plugin.json has version");
assert(!!pluginJson.description, "plugin.json has description");
assert(!!pluginJson.license, "plugin.json has license");

// ── Plugin wiring: skill file ───────────────────────────────────────

describe("plugin wiring: skill file");

const skillPath = path.join(PLUGIN_ROOT, "skills", "agent-gates", "SKILL.md");
assert(fs.existsSync(skillPath), "skill file exists");
const skill = fs.readFileSync(skillPath, "utf-8");
assert(skill.includes("user-invocable: false"), "user-invocable: false set");
assert(skill.includes("scope="), "mentions scope=");
assert(skill.includes("Hybrid enforcement"), "mentions hybrid enforcement");
assert(skill.includes("agent-gate-compat"), "mentions compat module");
assert(skill.includes("<agent_gate"), "mentions <agent_gate> tag");

// ── Hook integration: conditions ────────────────────────────────────

describe("hook integration: conditions");

const tmpSession = fs.mkdtempSync(path.join(os.tmpdir(), "agentgate-session-"));

// Create a temp agent .md with requires: ["implementer"]
const tmpAgents = path.join(tmpSession, ".claude", "agents");
fs.mkdirSync(tmpAgents, { recursive: true });
fs.writeFileSync(path.join(tmpAgents, "reviewer.md"), '---\nname: reviewer\nrequires: ["implementer"]\n---\n');

const conditionsScript = path.join(__dirname, "agent-gate-conditions.js");

// Test: missing dependency → block
function runConditions(payload, env) {
  try {
    const result = execSync(`node "${conditionsScript}"`, {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 5000,
      cwd: tmpSession,
      env: { ...process.env, ...env }
    });
    return { stdout: result, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", exitCode: err.status };
  }
}

// Missing dependency → should block
const blockResult = runConditions({
  session_id: "test-session",
  tool_input: {
    subagent_type: "reviewer",
    prompt: "scope=task-1 Review the code"
  }
}, { USERPROFILE: tmpSession, HOME: tmpSession });

if (blockResult.stdout.trim()) {
  const blockOutput = JSON.parse(blockResult.stdout);
  assert(blockOutput.decision === "block", "blocks when requires dep missing");
  assert(blockOutput.reason.includes("implementer"), "block reason mentions missing dep");
} else {
  assert(false, "blocks when requires dep missing (no output)");
  assert(false, "block reason mentions missing dep (no output)");
}

// Resume → should allow (exit 0, no block output)
const resumeResult = runConditions({
  session_id: "test-session",
  tool_input: { resume: true, subagent_type: "reviewer", prompt: "scope=task-1" }
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(resumeResult.exitCode === 0, "resume allows (exit 0)");
assert(!resumeResult.stdout.includes("block"), "resume produces no block");

// No scope → should allow
const noScopeResult = runConditions({
  session_id: "test-session",
  tool_input: { subagent_type: "reviewer", prompt: "just review stuff" }
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(noScopeResult.exitCode === 0, "no scope allows (exit 0)");
assert(!noScopeResult.stdout.includes("block"), "no scope produces no block");

// Deps satisfied → should allow + stage _pending
const scopeDir = path.join(tmpSession, ".claude", "sessions", "test-session", "task-2");
fs.mkdirSync(scopeDir, { recursive: true });
fs.writeFileSync(path.join(scopeDir, "implementer.md"), "Result: PASS\n");

const allowResult = runConditions({
  session_id: "test-session",
  tool_input: { subagent_type: "reviewer", prompt: "scope=task-2 Review it" }
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(allowResult.exitCode === 0, "deps met allows (exit 0)");

// Verify _pending was staged
const scopesFile = path.join(tmpSession, ".claude", "sessions", "test-session", "session_scopes.json");
if (fs.existsSync(scopesFile)) {
  const scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8"));
  assert(
    scopes._pending && scopes._pending.reviewer && scopes._pending.reviewer.outputFilepath,
    "_pending staged with outputFilepath"
  );
} else {
  assert(false, "_pending staged with outputFilepath (scopes file missing)");
}

// Reserved scope name _pending → should be treated as ungated (allow, no gating)
const pendingResult = runConditions({
  session_id: "test-session",
  tool_input: { subagent_type: "reviewer", prompt: "scope=_pending Review it" }
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(pendingResult.exitCode === 0, "scope=_pending treated as ungated (exit 0)");
assert(!pendingResult.stdout.includes("block"), "scope=_pending produces no block");

// ── Hook integration: injection ─────────────────────────────────────

describe("hook integration: injection");

const injectionScript = path.join(__dirname, "agent-gate-injection.js");

function runInjection(payload, env) {
  try {
    const result = execSync(`node "${injectionScript}"`, {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, ...env }
    });
    return { stdout: result, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", exitCode: err.status };
  }
}

// Gated agent with _pending → should inject output_filepath with <agent_gate importance="critical">
const injResult = runInjection({
  session_id: "test-session",
  agent_type: "reviewer"
}, { USERPROFILE: tmpSession, HOME: tmpSession });

if (injResult.stdout.trim()) {
  const injOutput = JSON.parse(injResult.stdout);
  const ctx = injOutput.hookSpecificOutput && injOutput.hookSpecificOutput.additionalContext;
  assert(ctx && ctx.includes("output_filepath="), "injects output_filepath");
  assert(ctx && ctx.includes('<agent_gate importance="critical">'), "wraps in <agent_gate importance=\"critical\">");
  assert(ctx && ctx.includes("Result: PASS or Result: FAIL"), "includes Result: format instruction");
} else {
  assert(false, "injects output_filepath (no output)");
  assert(false, 'wraps in <agent_gate importance="critical"> (no output)');
  assert(false, "includes Result: format instruction (no output)");
}

// Missing session_id → should exit 0 silently (fail-open)
const noSessionResult = runInjection({
  agent_type: "reviewer"
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(noSessionResult.exitCode === 0, "missing session_id exits 0 (fail-open)");
assert(!noSessionResult.stdout.trim(), "missing session_id produces no output");

// Ungated agent (no _pending) → should inject session_dir with plain <agent_gate>
const ungatedResult = runInjection({
  session_id: "test-session",
  agent_type: "unknown_agent_xyz"
}, { USERPROFILE: tmpSession, HOME: tmpSession });

if (ungatedResult.stdout.trim()) {
  const ungatedOutput = JSON.parse(ungatedResult.stdout);
  const ungatedCtx = ungatedOutput.hookSpecificOutput && ungatedOutput.hookSpecificOutput.additionalContext;
  assert(ungatedCtx && ungatedCtx.includes("session_dir="), "ungated agent gets session_dir");
  assert(ungatedCtx && !ungatedCtx.includes('importance="critical"'), "ungated agent gets plain <agent_gate>");
} else {
  assert(false, "ungated agent gets session_dir (no output)");
  assert(false, "ungated agent gets plain <agent_gate> (no output)");
}

// Cleanup
fs.rmSync(tmpSession, { recursive: true, force: true });

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
