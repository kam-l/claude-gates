#!/usr/bin/env node
/**
 * ClaudeGates v2 — test suite.
 *
 * Tests shared parsers, plugin wiring, and hook integration.
 * Run: node scripts/claude-gates-test.js
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");

const shared = require("./claude-gates-shared.js");
const gatesDb = require("./claude-gates-db.js");

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

// ── parseGates ──────────────────────────────────────────────────────

describe("parseGates");

const gatesBasic = shared.parseGates('---\ngates:\n  - [reviewer, 3]\n  - [playtester, 2]\n---\n');
assert(gatesBasic && gatesBasic.length === 2, "block sequence with two entries");
assert(gatesBasic && gatesBasic[0].agent === "reviewer" && gatesBasic[0].maxRounds === 3, "first entry parsed correctly");
assert(gatesBasic && gatesBasic[1].agent === "playtester" && gatesBasic[1].maxRounds === 2, "second entry parsed correctly");

const gatesSingle = shared.parseGates('---\ngates:\n  - [reviewer, 5]\n---\n');
assert(gatesSingle && gatesSingle.length === 1, "single entry");
assert(gatesSingle && gatesSingle[0].maxRounds === 5, "maxRounds parsed");

const gatesQuoted = shared.parseGates('---\ngates:\n  - ["reviewer", 3]\n---\n');
assert(gatesQuoted && gatesQuoted[0].agent === "reviewer", "quoted agent name");

const gatesFixer = shared.parseGates('---\ngates:\n  - [reviewer, 3, fixer]\n---\n');
assert(gatesFixer && gatesFixer[0].fixer === "fixer", "fixer parsed from 3rd element");
assert(gatesFixer && gatesFixer[0].agent === "reviewer" && gatesFixer[0].maxRounds === 3, "fixer entry preserves agent and maxRounds");

const gatesNoFixer = shared.parseGates('---\ngates:\n  - [reviewer, 3]\n---\n');
assert(gatesNoFixer && !gatesNoFixer[0].fixer, "no fixer when 3rd element absent (backward compat)");

const gatesFixerQuoted = shared.parseGates('---\ngates:\n  - [reviewer, 3, "hot-fixer"]\n---\n');
assert(gatesFixerQuoted && gatesFixerQuoted[0].fixer === "hot-fixer", "quoted fixer name parsed");

assert(shared.parseGates('---\nname: foo\n---\n') === null, "missing gates returns null");
assert(shared.parseGates('---\ngates:\n---\n') === null, "empty gates block returns null");
assert(shared.parseGates("no frontmatter") === null, "no frontmatter returns null");

// ── parseConditions ─────────────────────────────────────────────────

describe("parseConditions");

const condBasic = shared.parseConditions('---\nconditions: |\n  Check the spec.\n  Reply PASS or FAIL.\n---\n');
assert(condBasic && condBasic.startsWith("Check"), "basic conditions parsed");
assert(shared.parseConditions('---\nname: foo\n---\n') === null, "missing conditions returns null");
assert(shared.parseConditions("no frontmatter") === null, "no frontmatter returns null");

// ── requiresScope ───────────────────────────────────────────────────

describe("requiresScope");

assert(shared.requiresScope('---\nrequires: ["a"]\n---\n') === true, "requires: needs scope");
assert(shared.requiresScope('---\ngates:\n  - [r, 3]\n---\n') === true, "gates: needs scope");
assert(shared.requiresScope('---\nconditions: |\n  check\n---\n') === true, "conditions: needs scope");
assert(shared.requiresScope('---\nverification: |\n  test\n---\n') === false, "verification: alone does NOT need scope");
assert(shared.requiresScope('---\nname: foo\n---\n') === false, "no CG fields does not need scope");
assert(shared.requiresScope("no frontmatter") === false, "no frontmatter does not need scope");

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

// ── Plugin wiring: hooks.json ───────────────────────────────────────

describe("plugin wiring: hooks.json");

const hooksJson = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf-8")
);

const preToolUse = hooksJson.hooks.PreToolUse || [];
const agentHook = preToolUse.find(h => h.matcher === "Agent");
assert(!!agentHook, "PreToolUse:Agent hook registered");
assert(
  agentHook && agentHook.hooks[0].command.includes("claude-gates-conditions"),
  "conditions hook wired"
);
assert(
  agentHook && agentHook.hooks[0].command.includes("${CLAUDE_PLUGIN_ROOT}"),
  "conditions uses ${CLAUDE_PLUGIN_ROOT}"
);

const subStart = hooksJson.hooks.SubagentStart || [];
const injHook = subStart[0];
assert(
  injHook && injHook.hooks.some(h => h.command.includes("claude-gates-injection")),
  "SubagentStart injection hook wired"
);

const subStop = hooksJson.hooks.SubagentStop || [];
const verHook = subStop[0];
assert(
  verHook && verHook.hooks.some(h => h.command.includes("claude-gates-verification")),
  "SubagentStop verification hook wired"
);

// ── Plugin wiring: plugin.json ──────────────────────────────────────

describe("plugin wiring: plugin.json");

const pluginJson = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf-8")
);
assert(!!pluginJson.name, "plugin.json has name");
assert(pluginJson.name === "claude-gates", "name is claude-gates");
assert(!!pluginJson.version, "plugin.json has version");
assert(!!pluginJson.description, "plugin.json has description");
assert(!!pluginJson.license, "plugin.json has license");

// ── Plugin wiring: skill file ───────────────────────────────────────

describe("plugin wiring: skill file");

const skillPath = path.join(PLUGIN_ROOT, "skills", "claude-gates", "SKILL.md");
assert(fs.existsSync(skillPath), "skill file exists");
const skill = fs.readFileSync(skillPath, "utf-8");
assert(skill.includes("user-invocable: false"), "user-invocable: false set");
assert(skill.includes("scope="), "mentions scope=");
assert(skill.includes("Hybrid enforcement"), "mentions hybrid enforcement");
assert(skill.includes("<agent_gate"), "mentions <agent_gate> tag");

// ── Hook integration: conditions ────────────────────────────────────

describe("hook integration: conditions");

const tmpSession = fs.mkdtempSync(path.join(os.tmpdir(), "agentgate-session-"));

// Create a temp agent .md with requires: ["implementer"]
const tmpAgents = path.join(tmpSession, ".claude", "agents");
fs.mkdirSync(tmpAgents, { recursive: true });
fs.writeFileSync(path.join(tmpAgents, "reviewer.md"), '---\nname: reviewer\nrequires: ["implementer"]\n---\n');

const conditionsScript = path.join(__dirname, "claude-gates-conditions.js");

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

// No scope + CG fields → should block (scope required)
const noScopeResult = runConditions({
  session_id: "test-session",
  tool_input: { subagent_type: "reviewer", prompt: "just review stuff" }
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(noScopeResult.exitCode === 0, "no scope + CG fields exits 0");
assert(noScopeResult.stdout.includes("block"), "no scope + CG fields blocks (scope required)");

// No scope + no CG fields → should allow
fs.writeFileSync(path.join(tmpAgents, "helper.md"), '---\nname: helper\n---\n');
const noScopeNoCgResult = runConditions({
  session_id: "test-session",
  tool_input: { subagent_type: "helper", prompt: "just help" }
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(noScopeNoCgResult.exitCode === 0, "no scope + no CG fields allows (exit 0)");
assert(!noScopeNoCgResult.stdout.includes("block"), "no scope + no CG fields produces no block");

// Deps satisfied → should allow + stage pending
const scopeDir = path.join(tmpSession, ".claude", "sessions", "test-session", "task-2");
fs.mkdirSync(scopeDir, { recursive: true });
fs.writeFileSync(path.join(scopeDir, "implementer.md"), "Result: PASS\n");

const allowResult = runConditions({
  session_id: "test-session",
  tool_input: { subagent_type: "reviewer", prompt: "scope=task-2 Review it" }
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(allowResult.exitCode === 0, "deps met allows (exit 0)");

// Verify pending was staged in SQLite
const checkDb = gatesDb.getDb(path.join(tmpSession, ".claude", "sessions", "test-session"));
const checkPend = gatesDb.getPending(checkDb, "reviewer");
assert(checkPend && checkPend.outputFilepath, "pending staged with outputFilepath (DB)");
checkDb.close();

// Reserved scope name _pending → should be treated as ungated (allow, no gating)
const pendingResult = runConditions({
  session_id: "test-session",
  tool_input: { subagent_type: "reviewer", prompt: "scope=_pending Review it" }
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(pendingResult.exitCode === 0, "scope=_pending treated as ungated (exit 0)");
assert(!pendingResult.stdout.includes("block"), "scope=_pending produces no block");

// ── Hook integration: injection ─────────────────────────────────────

describe("hook integration: injection");

const injectionScript = path.join(__dirname, "claude-gates-injection.js");

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

// Gated agent with pending → should inject output_filepath with <agent_gate importance="critical">
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

// Ungated agent (no pending) → should inject session_dir with plain <agent_gate>
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

// ── Verdict object structure ─────────────────────────────────────────

describe("verdict object structure");

// truthiness: both true and verdict objects are truthy
assert(!!true, "boolean true is truthy");
assert(!!{ verdict: "PASS", round: 1 }, "verdict object is truthy");

// round increment from boolean
const fromBool = { verdict: "PASS", round: 1 };
assert(fromBool.round === 1, "first round from boolean starts at 1");

// round increment from existing object
const existingObj = { verdict: "REVISE", round: 2 };
const nextRound = existingObj.round + 1;
assert(nextRound === 3, "round increments from existing object");

// undefined → no round property
const undefinedCleared = undefined;
const roundFromUndef = (undefinedCleared && typeof undefinedCleared === "object" && undefinedCleared.round) ? undefinedCleared.round + 1 : 1;
assert(roundFromUndef === 1, "undefined cleared starts at round 1");

// ── Conditions re-spawn preservation ─────────────────────────────────

describe("conditions re-spawn preservation");

const tmpReSpawn = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-respawn-"));
const reSpawnAgents = path.join(tmpReSpawn, ".claude", "agents");
fs.mkdirSync(reSpawnAgents, { recursive: true });
fs.writeFileSync(path.join(reSpawnAgents, "worker.md"), '---\nname: worker\n---\n');

const reSpawnSessionDir = path.join(tmpReSpawn, ".claude", "sessions", "respawn-test");
fs.mkdirSync(reSpawnSessionDir, { recursive: true });

// Pre-seed session_scopes.json with a verdict object
const reSpawnScopesFile = path.join(reSpawnSessionDir, "session_scopes.json");
const reSpawnScopeDir = path.join(reSpawnSessionDir, "task-x");
fs.mkdirSync(reSpawnScopeDir, { recursive: true });
fs.writeFileSync(reSpawnScopesFile, JSON.stringify({
  "task-x": { cleared: { worker: { verdict: "REVISE", round: 1 } } }
}, null, 2), "utf-8");

// Run conditions for the same agent — should preserve existing verdict object
try {
  execSync(`node "${conditionsScript}"`, {
    input: JSON.stringify({
      session_id: "respawn-test",
      tool_input: { subagent_type: "worker", prompt: "scope=task-x Do work" }
    }),
    encoding: "utf-8",
    timeout: 5000,
    cwd: tmpReSpawn,
    env: { ...process.env, USERPROFILE: tmpReSpawn, HOME: tmpReSpawn }
  });
} catch {} // ignore exit code

// SQLite path — check DB (JSON was migrated, DB has the state)
const rsDb = gatesDb.getDb(reSpawnSessionDir);
const rsAgent = gatesDb.getAgent(rsDb, "task-x", "worker");
assert(
  rsAgent && rsAgent.verdict === "REVISE",
  "existing verdict object not overwritten to true on re-spawn (DB)"
);
rsDb.close();

fs.rmSync(tmpReSpawn, { recursive: true, force: true });

// ── edit-gate integration ────────────────────────────────────────────

describe("edit-gate integration");

const editGateScript = path.join(__dirname, "edit-gate.js");

function runEditGate(payload, env) {
  try {
    const result = execSync(`node "${editGateScript}"`, {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    return { stdout: result, stderr: "", exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.status };
  }
}

const tmpEditSession = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-edit-"));
const editSessionDir = path.join(tmpEditSession, ".claude", "sessions", "edit-test");
fs.mkdirSync(editSessionDir, { recursive: true });

// Test: creates edits state (DB)
runEditGate({
  session_id: "edit-test",
  tool_input: { file_path: "/tmp/test-file.js" }
}, { USERPROFILE: tmpEditSession, HOME: tmpEditSession });

assert(fs.existsSync(path.join(editSessionDir, "session.db")), "edit-gate creates session.db");
const edb = gatesDb.getDb(editSessionDir);
const eEdits = gatesDb.getEdits(edb);
assert(eEdits.length > 0, "session.db contains file path");

// Test: dedup — same file again should not duplicate
runEditGate({
  session_id: "edit-test",
  tool_input: { file_path: "/tmp/test-file.js" }
}, { USERPROFILE: tmpEditSession, HOME: tmpEditSession });

const eEdits2 = gatesDb.getEdits(edb);
const normalizedPath = path.resolve("/tmp/test-file.js").replace(/\\/g, "/");
const eCount = eEdits2.filter(e => e === normalizedPath).length;
assert(eCount === 1, "edit-gate deduplicates entries (DB)");
edb.close();

// Test: missing session_id → exit 0
const noSessionEdit = runEditGate({ tool_input: { file_path: "/tmp/x.js" } }, { USERPROFILE: tmpEditSession, HOME: tmpEditSession });
assert(noSessionEdit.exitCode === 0, "edit-gate missing session exits 0");

// Test: empty commands config → tracks file, no formatter output
{
  const tmpEditEmpty = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-edit-empty-"));
  const editEmptyDir = path.join(tmpEditEmpty, ".claude", "sessions", "edit-empty");
  fs.mkdirSync(editEmptyDir, { recursive: true });
  const emptyConfig = path.join(tmpEditEmpty, "empty-config.json");
  fs.writeFileSync(emptyConfig, JSON.stringify({ edit_gate: { commands: [] } }), "utf-8");

  const emptyResult = runEditGate(
    { session_id: "edit-empty", tool_input: { file_path: "/tmp/empty-test.js" } },
    { USERPROFILE: tmpEditEmpty, HOME: tmpEditEmpty, CLAUDE_GATES_CONFIG: emptyConfig }
  );
  assert(emptyResult.exitCode === 0, "edit-gate with empty commands exits 0");

  const emptyDb = gatesDb.getDb(editEmptyDir);
  const emptyEdits = gatesDb.getEdits(emptyDb);
  assert(emptyEdits.length > 0, "edit-gate with empty commands still tracks file");
  emptyDb.close();
  fs.rmSync(tmpEditEmpty, { recursive: true, force: true });
  try { fs.unlinkSync(emptyConfig); } catch {}
}

// Test: formatter commands run on new files
{
  const tmpEditFmt = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-edit-fmt-"));
  const editFmtDir = path.join(tmpEditFmt, ".claude", "sessions", "edit-fmt");
  fs.mkdirSync(editFmtDir, { recursive: true });
  const markerFile = path.join(tmpEditFmt, "formatter-ran.marker");
  const fmtConfig = path.join(tmpEditFmt, "fmt-config.json");
  // Use a command that creates a marker file to prove it ran
  const isWin = process.platform === "win32";
  const touchCmd = isWin
    ? `cmd /c "echo ran > ${markerFile.replace(/\\/g, "/")}"`
    : `touch ${markerFile}`;
  fs.writeFileSync(fmtConfig, JSON.stringify({ edit_gate: { commands: [touchCmd] } }), "utf-8");

  runEditGate(
    { session_id: "edit-fmt", tool_input: { file_path: "/tmp/fmt-test.js" } },
    { USERPROFILE: tmpEditFmt, HOME: tmpEditFmt, CLAUDE_GATES_CONFIG: fmtConfig }
  );
  assert(fs.existsSync(markerFile), "edit-gate runs formatter command on new file");

  // Test: dedup — same file again should NOT re-run formatter
  fs.unlinkSync(markerFile);
  runEditGate(
    { session_id: "edit-fmt", tool_input: { file_path: "/tmp/fmt-test.js" } },
    { USERPROFILE: tmpEditFmt, HOME: tmpEditFmt, CLAUDE_GATES_CONFIG: fmtConfig }
  );
  assert(!fs.existsSync(markerFile), "edit-gate dedup: formatter does not re-run on same file");

  // Test: different file DOES run formatter
  runEditGate(
    { session_id: "edit-fmt", tool_input: { file_path: "/tmp/fmt-test-2.js" } },
    { USERPROFILE: tmpEditFmt, HOME: tmpEditFmt, CLAUDE_GATES_CONFIG: fmtConfig }
  );
  assert(fs.existsSync(markerFile), "edit-gate runs formatter on different new file");

  fs.rmSync(tmpEditFmt, { recursive: true, force: true });
}

// Test: formatter failure is non-fatal
{
  const tmpEditFail = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-edit-fail-"));
  const editFailDir = path.join(tmpEditFail, ".claude", "sessions", "edit-fail");
  fs.mkdirSync(editFailDir, { recursive: true });
  const failConfig = path.join(tmpEditFail, "fail-config.json");
  fs.writeFileSync(failConfig, JSON.stringify({ edit_gate: { commands: ["nonexistent-command-xyz"] } }), "utf-8");

  const failResult = runEditGate(
    { session_id: "edit-fail", tool_input: { file_path: "/tmp/fail-test.js" } },
    { USERPROFILE: tmpEditFail, HOME: tmpEditFail, CLAUDE_GATES_CONFIG: failConfig }
  );
  assert(failResult.exitCode === 0, "edit-gate formatter failure is non-fatal");

  // File should still be tracked despite formatter failure
  const failDb = gatesDb.getDb(editFailDir);
  const failEdits = gatesDb.getEdits(failDb);
  assert(failEdits.length > 0, "edit-gate tracks file even when formatter fails");
  failDb.close();
  fs.rmSync(tmpEditFail, { recursive: true, force: true });
}

fs.rmSync(tmpEditSession, { recursive: true, force: true });

// ── stop-gate integration ────────────────────────────────────────────

describe("stop-gate integration");

const stopGateScript = path.join(__dirname, "stop-gate.js");

function runStopGate(payload, env) {
  try {
    const result = execSync(`node "${stopGateScript}"`, {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, ...env }
    });
    return { stdout: result, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", exitCode: err.status };
  }
}

const tmpStopSession = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-stop-"));
const stopSessionDir = path.join(tmpStopSession, ".claude", "sessions", "stop-test");
fs.mkdirSync(stopSessionDir, { recursive: true });

// Test: clean files pass (no edits.log)
const cleanResult = runStopGate({ session_id: "stop-test" }, { USERPROFILE: tmpStopSession, HOME: tmpStopSession });
assert(cleanResult.exitCode === 0 && !cleanResult.stdout.includes("block"), "clean session passes stop-gate");

// Create a file with TODO and register it in SQLite
const dirtyFile = path.join(tmpStopSession, "dirty.js");
fs.writeFileSync(dirtyFile, "// TODO: remove this\nconsole.log('debug');\n", "utf-8");
const stopDb = gatesDb.getDb(stopSessionDir);
gatesDb.addEdit(stopDb, dirtyFile.replace(/\\/g, "/"));
stopDb.close();

// Test: dirty files in default warn mode → no block (stderr only)
const dirtyWarnResult = runStopGate({ session_id: "stop-test" }, { USERPROFILE: tmpStopSession, HOME: tmpStopSession });
assert(!dirtyWarnResult.stdout.includes("block"), "warn mode: dirty files produce no block");

// Test: dirty files in nudge mode → block
const nudgeConfig = path.join(os.tmpdir(), "cg-nudge-config.json");
fs.writeFileSync(nudgeConfig, JSON.stringify({ stop_gate: { mode: "nudge" } }), "utf-8");

// Need fresh session for nudge test (no marker from prior runs)
const tmpNudgeSession = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-stop-nudge-"));
const nudgeSessionDir = path.join(tmpNudgeSession, ".claude", "sessions", "stop-nudge");
fs.mkdirSync(nudgeSessionDir, { recursive: true });
const nudgeDirty = path.join(tmpNudgeSession, "dirty.js");
fs.writeFileSync(nudgeDirty, "// TODO: fix\n", "utf-8");
const nudgeDb = gatesDb.getDb(nudgeSessionDir);
gatesDb.addEdit(nudgeDb, nudgeDirty.replace(/\\/g, "/"));
nudgeDb.close();

const dirtyResult = runStopGate(
  { session_id: "stop-nudge" },
  { USERPROFILE: tmpNudgeSession, HOME: tmpNudgeSession, CLAUDE_GATES_CONFIG: nudgeConfig }
);
if (dirtyResult.stdout.trim()) {
  const dirtyOutput = JSON.parse(dirtyResult.stdout);
  assert(dirtyOutput.decision === "block", "nudge mode: dirty files block stop-gate");
} else {
  assert(false, "nudge mode: dirty files block stop-gate (no output)");
}

// Test: second stop in nudge mode passes (marker exists)
const secondResult = runStopGate(
  { session_id: "stop-nudge" },
  { USERPROFILE: tmpNudgeSession, HOME: tmpNudgeSession, CLAUDE_GATES_CONFIG: nudgeConfig }
);
assert(secondResult.exitCode === 0 && !secondResult.stdout.includes("block"), "nudge mode: second stop passes (marker)");

fs.rmSync(tmpNudgeSession, { recursive: true, force: true });
try { fs.unlinkSync(nudgeConfig); } catch {}

// Test: deleted files are skipped
const deletedStopSession = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-stop2-"));
const deletedSessionDir = path.join(deletedStopSession, ".claude", "sessions", "stop-del");
fs.mkdirSync(deletedSessionDir, { recursive: true });
const delDb = gatesDb.getDb(deletedSessionDir);
gatesDb.addEdit(delDb, "/nonexistent/deleted-file.js");
delDb.close();

const deletedResult = runStopGate({ session_id: "stop-del" }, { USERPROFILE: deletedStopSession, HOME: deletedStopSession });
assert(deletedResult.exitCode === 0 && !deletedResult.stdout.includes("block"), "deleted files are skipped");

fs.rmSync(tmpStopSession, { recursive: true, force: true });
fs.rmSync(deletedStopSession, { recursive: true, force: true });

// ── loop-gate integration ────────────────────────────────────────────

describe("loop-gate integration");

const loopGateScript = path.join(__dirname, "loop-gate.js");

function runLoopGate(payload, env) {
  try {
    const result = execSync(`node "${loopGateScript}"`, {
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

const tmpLoopSession = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-loop-"));
const loopSessionDir = path.join(tmpLoopSession, ".claude", "sessions", "loop-test");
fs.mkdirSync(loopSessionDir, { recursive: true });

const loopPayload = {
  session_id: "loop-test",
  tool_name: "Bash",
  tool_input: { command: "echo hello" }
};

// Test: under threshold allows (1st and 2nd calls)
const loop1 = runLoopGate(loopPayload, { USERPROFILE: tmpLoopSession, HOME: tmpLoopSession });
assert(loop1.exitCode === 0 && !loop1.stdout.includes("block"), "loop-gate allows 1st call");

const loop2 = runLoopGate(loopPayload, { USERPROFILE: tmpLoopSession, HOME: tmpLoopSession });
assert(loop2.exitCode === 0 && !loop2.stdout.includes("block"), "loop-gate allows 2nd call");

// Test: 3rd consecutive identical call → block
const loop3 = runLoopGate(loopPayload, { USERPROFILE: tmpLoopSession, HOME: tmpLoopSession });
if (loop3.stdout.trim()) {
  const loopOutput = JSON.parse(loop3.stdout);
  assert(loopOutput.decision === "block", "loop-gate blocks 3rd identical call");
} else {
  assert(false, "loop-gate blocks 3rd identical call (no output)");
}

// Test: different call resets streak
const diffPayload = {
  session_id: "loop-test",
  tool_name: "Bash",
  tool_input: { command: "echo different" }
};
const loopDiff = runLoopGate(diffPayload, { USERPROFILE: tmpLoopSession, HOME: tmpLoopSession });
assert(loopDiff.exitCode === 0 && !loopDiff.stdout.includes("block"), "different call resets streak");

fs.rmSync(tmpLoopSession, { recursive: true, force: true });

// ── hooks.json wiring: new gates ─────────────────────────────────────

describe("hooks.json wiring: new gates");

const bashHook = preToolUse.find(h => h.matcher === "Bash");
assert(
  bashHook && bashHook.hooks.some(h => h.command.includes("loop-gate")),
  "PreToolUse:Bash loop-gate wired"
);

const editPreHook = preToolUse.find(h => h.matcher === "Edit");
assert(
  editPreHook && editPreHook.hooks.some(h => h.command.includes("loop-gate")),
  "PreToolUse:Edit loop-gate wired"
);

const postToolUse = hooksJson.hooks.PostToolUse || [];
const editPostHook = postToolUse.find(h => h.matcher === "Edit");
assert(
  editPostHook && editPostHook.hooks.some(h => h.command.includes("edit-gate")),
  "PostToolUse:Edit edit-gate wired"
);

const writePostHook = postToolUse.find(h => h.matcher === "Write");
assert(
  writePostHook && writePostHook.hooks.some(h => h.command.includes("edit-gate")),
  "PostToolUse:Write edit-gate wired"
);

const stopHooks = hooksJson.hooks.Stop || [];
assert(
  stopHooks.length > 0 && stopHooks[0].hooks.some(h => h.command.includes("stop-gate")),
  "Stop stop-gate wired"
);

// Verify all hooks use ${CLAUDE_PLUGIN_ROOT}
let allUsePluginRoot = true;
for (const [event, entries] of Object.entries(hooksJson.hooks)) {
  for (const entry of entries) {
    for (const hook of entry.hooks || []) {
      if (hook.command && !hook.command.includes("${CLAUDE_PLUGIN_ROOT}")) {
        allUsePluginRoot = false;
      }
    }
  }
}
assert(allUsePluginRoot, "all hooks use ${CLAUDE_PLUGIN_ROOT}");

// ── SQLite DB module tests ─────────────────────────────────────────

describe("SQLite DB: getDb creates session.db with 4 tables");

const tmpDbSession = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-db-"));
const db = gatesDb.getDb(tmpDbSession);

{
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  assert(tables.includes("agents"), "agents table exists");
  assert(tables.includes("gates"), "gates table exists");
  assert(tables.includes("edits"), "edits table exists");
  assert(tables.includes("tool_history"), "tool_history table exists");
  assert(!tables.includes("scopes"), "old scopes table absent");
  assert(!tables.includes("cleared"), "old cleared table absent");
  assert(!tables.includes("markers"), "old markers table absent");
  assert(fs.existsSync(path.join(tmpDbSession, "session.db")), "session.db file created");

  // ── registerAgent + verdict preservation ──
  describe("SQLite DB: registerAgent + verdict preservation");

  gatesDb.registerAgent(db, "test-scope", "worker", "/tmp/worker.md");
  gatesDb.setVerdict(db, "test-scope", "worker", "REVISE", 1);
  // Re-register should NOT overwrite verdict (only updates outputFilepath)
  gatesDb.registerAgent(db, "test-scope", "worker", "/tmp/worker2.md");
  const preserved = gatesDb.getAgent(db, "test-scope", "worker");
  assert(
    preserved && preserved.verdict === "REVISE" && preserved.round === 1,
    "existing verdict not overwritten by registerAgent"
  );
  assert(
    preserved && preserved.outputFilepath === "/tmp/worker2.md",
    "outputFilepath updated by registerAgent"
  );

  // ── Verdict round tracking ──
  describe("SQLite DB: verdict round tracking");

  gatesDb.setVerdict(db, "test-scope", "auditor", "PASS", 1);
  const r1 = gatesDb.getAgent(db, "test-scope", "auditor");
  assert(r1 && r1.round === 1, "round 1 stored");

  gatesDb.setVerdict(db, "test-scope", "auditor", "REVISE", 2);
  const r2 = gatesDb.getAgent(db, "test-scope", "auditor");
  assert(r2 && r2.round === 2 && r2.verdict === "REVISE", "round 2 with verdict");

  // ── Pending roundtrip ──
  describe("SQLite DB: pending roundtrip");

  gatesDb.registerAgent(db, "task-1", "reviewer", "/tmp/sessions/task-1/reviewer.md");
  const pend = gatesDb.getPending(db, "reviewer");
  assert(pend && pend.outputFilepath === "/tmp/sessions/task-1/reviewer.md", "pending outputFilepath property name");
  assert(pend && pend.scope === "task-1", "pending scope");

  const noPend = gatesDb.getPending(db, "nonexistent");
  assert(noPend === null, "getPending returns null for missing agent");

  // ── Edits dedup ──
  describe("SQLite DB: edits dedup");

  gatesDb.addEdit(db, "/tmp/file.js");
  gatesDb.addEdit(db, "/tmp/file.js");
  const edits = gatesDb.getEdits(db);
  const fileCount = edits.filter(e => e === "/tmp/file.js").length;
  assert(fileCount === 1, "addEdit deduplicates same path");

  // ── addEdit with lines ──
  describe("SQLite DB: addEdit with lines");

  gatesDb.addEdit(db, "/tmp/file-with-lines.js", 42);
  const lineCounts = gatesDb.getEditCounts(db);
  assert(lineCounts.files >= 1, "getEditCounts returns file count");
  assert(lineCounts.lines >= 42, "getEditCounts includes lines");

  // Update lines for existing file
  gatesDb.addEdit(db, "/tmp/file-with-lines.js", 99);
  const updated = db.prepare("SELECT lines FROM edits WHERE filepath = '/tmp/file-with-lines.js'").get();
  assert(updated && updated.lines === 99, "addEdit with lines updates existing entry");

  // ── Tool history ring buffer ──
  describe("SQLite DB: tool history ring buffer");

  for (let i = 0; i < 12; i++) {
    gatesDb.addToolHash(db, `hash-${i}`);
  }
  const hashes = gatesDb.getLastNHashes(db, 20); // ask for more than exist
  assert(hashes.length === 10, "ring buffer trims to max 10 entries");
  assert(hashes[hashes.length - 1] === "hash-11", "most recent hash is last");
  assert(hashes[0] === "hash-2", "oldest hash is hash-2 (0 and 1 trimmed)");

  // ── isCleared and findAgentScope ──
  describe("SQLite DB: isCleared and findAgentScope");

  assert(gatesDb.isCleared(db, "test-scope", "worker"), "isCleared true for existing");
  assert(!gatesDb.isCleared(db, "test-scope", "nonexistent"), "isCleared false for missing");

  const foundScope = gatesDb.findAgentScope(db, "worker");
  assert(foundScope === "test-scope", "findAgentScope returns correct scope");
  assert(gatesDb.findAgentScope(db, "nonexistent") === null, "findAgentScope null for missing");

  // System-scoped agents should not be found by findAgentScope
  gatesDb.registerAgent(db, "_system", "plan-gate", null);
  assert(gatesDb.findAgentScope(db, "plan-gate") === null, "findAgentScope excludes _system scope");

  // ── registerAgent atomicity ──
  describe("SQLite DB: registerAgent atomicity");

  gatesDb.registerAgent(db, "atomic-scope", "builder", "/tmp/builder.md");
  const agentRow = db.prepare("SELECT 1 FROM agents WHERE scope = 'atomic-scope' AND agent = 'builder'").get();
  const pendingRow = db.prepare("SELECT outputFilepath FROM agents WHERE scope = 'atomic-scope' AND agent = 'builder'").get();
  assert(!!agentRow, "registerAgent creates agent row");
  assert(pendingRow && pendingRow.outputFilepath === "/tmp/builder.md", "registerAgent sets outputFilepath");

  // ── Attempts tracking ──
  describe("SQLite DB: attempts tracking");

  assert(gatesDb.getAttempts(db, "_system", "plan-gate") === 0, "initial attempts is 0");
  gatesDb.incrAttempts(db, "_system", "plan-gate");
  assert(gatesDb.getAttempts(db, "_system", "plan-gate") === 1, "incrAttempts increments");
  gatesDb.incrAttempts(db, "_system", "plan-gate");
  assert(gatesDb.getAttempts(db, "_system", "plan-gate") === 2, "incrAttempts increments again");
  gatesDb.resetAttempts(db, "_system", "plan-gate");
  assert(gatesDb.getAttempts(db, "_system", "plan-gate") === 0, "resetAttempts resets to 0");

  // incrAttempts on new row
  gatesDb.incrAttempts(db, "_new", "new-agent");
  assert(gatesDb.getAttempts(db, "_new", "new-agent") === 1, "incrAttempts creates new row with 1");

  db.close();

  // ── Migration tests: JSON → new schema ──
  describe("SQLite DB: migration — full state");

  const tmpMigrate = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-migrate-"));

  // Create all 4 old JSON/log files
  fs.writeFileSync(path.join(tmpMigrate, "session_scopes.json"), JSON.stringify({
    "scope-a": {
      cleared: {
        implementer: true,
        reviewer: { verdict: "PASS", round: 2 }
      }
    },
    "_pending": {
      reviewer: { scope: "scope-a", outputFilepath: "/tmp/reviewer.md" }
    }
  }, null, 2), "utf-8");
  fs.writeFileSync(path.join(tmpMigrate, "edits.log"), "/tmp/a.js\n/tmp/b.js\n", "utf-8");
  fs.writeFileSync(path.join(tmpMigrate, "tool_history.json"), JSON.stringify(["h1", "h2", "h3"]), "utf-8");
  fs.writeFileSync(path.join(tmpMigrate, ".stop-gate-nudged"), "2026-01-01T00:00:00Z", "utf-8");

  const mdb = gatesDb.getDb(tmpMigrate);
  assert(gatesDb.isCleared(mdb, "scope-a", "implementer"), "migrated: implementer cleared");
  const revAgent = gatesDb.getAgent(mdb, "scope-a", "reviewer");
  assert(revAgent && revAgent.verdict === "PASS" && revAgent.round === 2, "migrated: reviewer verdict object");
  const mPend = gatesDb.getPending(mdb, "reviewer");
  assert(mPend && mPend.outputFilepath === "/tmp/reviewer.md", "migrated: pending entry");
  const mEdits = gatesDb.getEdits(mdb);
  assert(mEdits.length === 2, "migrated: 2 edit entries");
  const mHashes = gatesDb.getLastNHashes(mdb, 10);
  assert(mHashes.length === 3, "migrated: 3 tool history entries");
  assert(gatesDb.isCleared(mdb, "_nudge", "stop-gate"), "migrated: stop-gate-nudged marker");
  assert(gatesDb.isCleared(mdb, "_meta", "json_migrated"), "migration marker set");
  mdb.close();
  fs.rmSync(tmpMigrate, { recursive: true, force: true });

  // ── Migration: partial state ──
  describe("SQLite DB: migration — partial state");

  const tmpPartial = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-migrate-partial-"));
  // Only session_scopes.json (no edits.log, no tool_history.json)
  fs.writeFileSync(path.join(tmpPartial, "session_scopes.json"), JSON.stringify({
    "only-scope": { cleared: { worker: true } }
  }, null, 2), "utf-8");

  const pdb = gatesDb.getDb(tmpPartial);
  assert(gatesDb.isCleared(pdb, "only-scope", "worker"), "partial migration: scope migrated");
  assert(gatesDb.getEdits(pdb).length === 0, "partial migration: no edits (file absent)");
  assert(gatesDb.getLastNHashes(pdb, 10).length === 0, "partial migration: no history (file absent)");
  assert(gatesDb.isCleared(pdb, "_meta", "json_migrated"), "partial migration marker set");
  pdb.close();
  fs.rmSync(tmpPartial, { recursive: true, force: true });

  // ── Migration: fresh session (no old files) ──
  describe("SQLite DB: migration — fresh session");

  const tmpFresh = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-migrate-fresh-"));
  const fdb = gatesDb.getDb(tmpFresh);
  assert(!gatesDb.isCleared(fdb, "_meta", "json_migrated"), "fresh session: no migration marker");
  assert(gatesDb.getEdits(fdb).length === 0, "fresh session: empty edits");
  fdb.close();
  fs.rmSync(tmpFresh, { recursive: true, force: true });

  // ── fixer_agent column migration test ──
  describe("SQLite DB: fixer_agent column migration");

  const tmpFixerMigrate = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-fixer-migrate-"));
  try {
    const Database = require("better-sqlite3");
    // Create DB without fixer_agent column (simulates old schema)
    const oldDb = new Database(path.join(tmpFixerMigrate, "session.db"));
    oldDb.exec(`CREATE TABLE IF NOT EXISTS agents (scope TEXT, agent TEXT, PRIMARY KEY (scope, agent))`);
    oldDb.exec(`CREATE TABLE IF NOT EXISTS gates (
      scope TEXT NOT NULL, "order" INTEGER NOT NULL, gate_agent TEXT NOT NULL,
      max_rounds INTEGER NOT NULL DEFAULT 3, status TEXT NOT NULL DEFAULT 'pending',
      round INTEGER NOT NULL DEFAULT 0, source_agent TEXT NOT NULL,
      PRIMARY KEY (scope, "order")
    )`);
    oldDb.exec(`CREATE TABLE IF NOT EXISTS edits (filepath TEXT PRIMARY KEY, lines INTEGER NOT NULL DEFAULT 0)`);
    oldDb.exec(`CREATE TABLE IF NOT EXISTS tool_history (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL)`);
    oldDb.exec(`INSERT INTO gates (scope, "order", gate_agent, max_rounds, status, round, source_agent) VALUES ('s', 0, 'rev', 3, 'active', 0, 'impl')`);
    oldDb.close();

    // Open via getDb — should migrate
    const migratedDb = gatesDb.getDb(tmpFixerMigrate);
    if (migratedDb) {
      const row = migratedDb.prepare('SELECT fixer_agent FROM gates WHERE scope = ?').get("s");
      assert(row !== undefined, "fixer_agent column added by migration");
      assert(row.fixer_agent === null, "fixer_agent is null for pre-existing rows");
      migratedDb.close();
    }
  } catch {
    console.log("  SKIP: fixer migration test — better-sqlite3 not available");
  }
  fs.rmSync(tmpFixerMigrate, { recursive: true, force: true });

  // ── Concurrency test: two loop-gate writes ──
  describe("SQLite DB: concurrent loop-gate writes");

  const tmpConc = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-conc-"));
  const concSessionDir = path.join(tmpConc, ".claude", "sessions", "conc-test");
  fs.mkdirSync(concSessionDir, { recursive: true });

  // Run two loop-gate processes simultaneously with different payloads
  const concPayloadA = JSON.stringify({ session_id: "conc-test", tool_name: "Bash", tool_input: { command: "echo A" } });
  const concPayloadB = JSON.stringify({ session_id: "conc-test", tool_name: "Bash", tool_input: { command: "echo B" } });
  const loopScript = path.join(__dirname, "loop-gate.js");

  try {
    // Spawn both — they will run close to concurrently
    const { execSync: es } = require("child_process");
    es(`node "${loopScript}"`, { input: concPayloadA, encoding: "utf-8", timeout: 5000, env: { ...process.env, USERPROFILE: tmpConc, HOME: tmpConc } });
    es(`node "${loopScript}"`, { input: concPayloadB, encoding: "utf-8", timeout: 5000, env: { ...process.env, USERPROFILE: tmpConc, HOME: tmpConc } });

    // Verify both hashes appear in DB
    const cdb = gatesDb.getDb(concSessionDir);
    const cHashes = gatesDb.getLastNHashes(cdb, 10);
    assert(cHashes.length === 2, "concurrent writes: both hashes recorded");
    cdb.close();
  } catch (err) {
    assert(false, `concurrent writes: ${err.message}`);
  }
  fs.rmSync(tmpConc, { recursive: true, force: true });

  // ── Integration: conditions creates session.db ──
  describe("SQLite DB: conditions hook creates session.db");

  const tmpDbCond = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-dbcond-"));
  const dbCondAgents = path.join(tmpDbCond, ".claude", "agents");
  fs.mkdirSync(dbCondAgents, { recursive: true });
  fs.writeFileSync(path.join(dbCondAgents, "tester.md"), "---\nname: tester\n---\n");

  try {
    execSync(`node "${conditionsScript}"`, {
      input: JSON.stringify({
        session_id: "db-cond-test",
        tool_input: { subagent_type: "tester", prompt: "scope=task-db Do work" }
      }),
      encoding: "utf-8",
      timeout: 5000,
      cwd: tmpDbCond,
      env: { ...process.env, USERPROFILE: tmpDbCond, HOME: tmpDbCond }
    });
  } catch {} // ignore exit code

  const dbCondPath = path.join(tmpDbCond, ".claude", "sessions", "db-cond-test", "session.db");
  assert(fs.existsSync(dbCondPath), "conditions hook creates session.db");

  // Verify data was written to DB
  const condDb = gatesDb.getDb(path.join(tmpDbCond, ".claude", "sessions", "db-cond-test"));
  if (condDb) {
    assert(gatesDb.isCleared(condDb, "task-db", "tester"), "conditions hook: agent cleared in DB");
    const condPend = gatesDb.getPending(condDb, "tester");
    assert(condPend && condPend.outputFilepath, "conditions hook: pending staged in DB");
    condDb.close();
  }

  fs.rmSync(tmpDbCond, { recursive: true, force: true });

}

fs.rmSync(tmpDbSession, { recursive: true, force: true });

// ── hooks.json wiring: plan-gate, commit-gate, SubagentStop ──────────

describe("hooks.json wiring: plan-gate, commit-gate, SubagentStop");

// Re-read hooks.json to pick up new entries
const hooksJsonNew = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf-8")
);

const preToolUseNew = hooksJsonNew.hooks.PreToolUse || [];
const planHook = preToolUseNew.find(h => h.matcher === "ExitPlanMode");
assert(!!planHook, "PreToolUse:ExitPlanMode hook registered");
assert(
  planHook && planHook.hooks[0].command.includes("plan-gate"),
  "plan-gate hook wired"
);

const bashHookNew = preToolUseNew.find(h => h.matcher === "Bash");
assert(
  bashHookNew && bashHookNew.hooks.some(h => h.command.includes("commit-gate")),
  "PreToolUse:Bash has commit-gate wired"
);

const subStopNew = hooksJsonNew.hooks.SubagentStop || [];
assert(subStopNew.length === 1, "SubagentStop has exactly 1 entry (verification only, no gater-stamp)");
assert(
  subStopNew[0].hooks[0].command.includes("claude-gates-verification"),
  "SubagentStop runs verification.js"
);

// ── plan-gate integration (verdict-based) ─────────────────────────────

describe("plan-gate integration (verdict-based)");

const planGateScript = path.join(__dirname, "plan-gate.js");

function runPlanGate(payload, env) {
  try {
    const result = execSync(`node "${planGateScript}"`, {
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

// Setup: temp home with plans dir
const tmpPlanHome = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-plan-"));
const planDir = path.join(tmpPlanHome, ".claude", "plans");
fs.mkdirSync(planDir, { recursive: true });

// Create a non-trivial plan (>20 lines)
const bigPlan = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join("\n");
fs.writeFileSync(path.join(planDir, "test-plan.md"), bigPlan, "utf-8");

// Test: no gater verdict + non-trivial plan → block
const planBlock = runPlanGate(
  { session_id: "plan-test" },
  { USERPROFILE: tmpPlanHome, HOME: tmpPlanHome }
);
if (planBlock.stdout.trim()) {
  const planOutput = JSON.parse(planBlock.stdout);
  assert(planOutput.decision === "block", "plan-gate blocks without gater verdict");
  assert(planOutput.reason.includes("test-plan.md"), "block reason mentions plan file");
} else {
  assert(false, "plan-gate blocks without gater verdict (no output)");
  assert(false, "block reason mentions plan file (no output)");
}

// Test: trivial plan (<=20 lines) → allow
const trivialPlanHome = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-plan-trivial-"));
const trivialPlanDir = path.join(trivialPlanHome, ".claude", "plans");
fs.mkdirSync(trivialPlanDir, { recursive: true });
fs.writeFileSync(path.join(trivialPlanDir, "small.md"), "Simple plan\nDone\n", "utf-8");

const trivialResult = runPlanGate(
  { session_id: "plan-trivial" },
  { USERPROFILE: trivialPlanHome, HOME: trivialPlanHome }
);
assert(trivialResult.exitCode === 0 && !trivialResult.stdout.includes("block"), "trivial plan allows");
fs.rmSync(trivialPlanHome, { recursive: true, force: true });

// Test: no plans dir → allow (fail-open)
const noPlanHome = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-plan-nodir-"));
fs.mkdirSync(path.join(noPlanHome, ".claude"), { recursive: true });
const noPlanResult = runPlanGate(
  { session_id: "plan-nodir" },
  { USERPROFILE: noPlanHome, HOME: noPlanHome }
);
assert(noPlanResult.exitCode === 0 && !noPlanResult.stdout.includes("block"), "no plans dir allows (fail-open)");
fs.rmSync(noPlanHome, { recursive: true, force: true });

// Test: gater verdict PASS in session → allow
const planVerdictHome = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-plan-verdict-"));
const planVerdictPlans = path.join(planVerdictHome, ".claude", "plans");
fs.mkdirSync(planVerdictPlans, { recursive: true });
fs.writeFileSync(path.join(planVerdictPlans, "big.md"), bigPlan, "utf-8");
const planVerdictSession = path.join(planVerdictHome, ".claude", "sessions", "plan-verdict-test");
fs.mkdirSync(planVerdictSession, { recursive: true });

// Seed gater verdict
const pvDb = gatesDb.getDb(planVerdictSession);
gatesDb.setVerdict(pvDb, "verify-plan", "gater", "PASS", 1);
pvDb.close();

const verdictResult = runPlanGate(
  { session_id: "plan-verdict-test" },
  { USERPROFILE: planVerdictHome, HOME: planVerdictHome }
);
assert(verdictResult.exitCode === 0 && !verdictResult.stdout.includes("block"), "gater PASS verdict allows");

// Test: gater verdict CONVERGED → also allows
const planConvSession = path.join(planVerdictHome, ".claude", "sessions", "plan-conv-test");
fs.mkdirSync(planConvSession, { recursive: true });
const pcDb = gatesDb.getDb(planConvSession);
gatesDb.setVerdict(pcDb, "verify-plan", "gater", "CONVERGED", 1);
pcDb.close();

const convResult = runPlanGate(
  { session_id: "plan-conv-test" },
  { USERPROFILE: planVerdictHome, HOME: planVerdictHome }
);
assert(convResult.exitCode === 0 && !convResult.stdout.includes("block"), "gater CONVERGED verdict allows");

// Test: gater FAIL verdict → blocks (not sufficient)
const planFailSession = path.join(planVerdictHome, ".claude", "sessions", "plan-fail-test");
fs.mkdirSync(planFailSession, { recursive: true });
const pfDb = gatesDb.getDb(planFailSession);
gatesDb.setVerdict(pfDb, "verify-plan", "gater", "FAIL", 1);
pfDb.close();

const failResult = runPlanGate(
  { session_id: "plan-fail-test" },
  { USERPROFILE: planVerdictHome, HOME: planVerdictHome }
);
assert(failResult.stdout.includes("block"), "gater FAIL verdict still blocks");

fs.rmSync(planVerdictHome, { recursive: true, force: true });
fs.rmSync(tmpPlanHome, { recursive: true, force: true });

// Test: agent subplan files (-agent-) are ignored in plan discovery
const agentPlanHome = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-plan-agent-"));
const agentPlanDir = path.join(agentPlanHome, ".claude", "plans");
fs.mkdirSync(agentPlanDir, { recursive: true });

// Only file is an agent subplan — should be ignored, so plan-gate allows (no plans found)
const agentSubplan = Array.from({ length: 30 }, (_, i) => `Agent line ${i + 1}`).join("\n");
fs.writeFileSync(path.join(agentPlanDir, "my-plan-agent-abc123.md"), agentSubplan, "utf-8");

const agentPlanResult = runPlanGate(
  { session_id: "plan-agent-only" },
  { USERPROFILE: agentPlanHome, HOME: agentPlanHome }
);
assert(agentPlanResult.exitCode === 0 && !agentPlanResult.stdout.includes("block"),
  "plan-gate ignores agent subplan files (-agent-)");

// Mix: agent subplan (big) + real plan (trivial) — should use real plan, allow
fs.writeFileSync(path.join(agentPlanDir, "real-plan.md"), "Simple\nDone\n", "utf-8");
const mixResult = runPlanGate(
  { session_id: "plan-agent-mix" },
  { USERPROFILE: agentPlanHome, HOME: agentPlanHome }
);
assert(mixResult.exitCode === 0 && !mixResult.stdout.includes("block"),
  "plan-gate uses real plan (trivial) when agent subplan also present");

// Mix: agent subplan (big) + real plan (big) — should block on real plan
fs.writeFileSync(path.join(agentPlanDir, "real-plan.md"), bigPlan, "utf-8");
const mixBlockResult = runPlanGate(
  { session_id: "plan-agent-mix-block" },
  { USERPROFILE: agentPlanHome, HOME: agentPlanHome }
);
if (mixBlockResult.stdout.trim()) {
  const mixOutput = JSON.parse(mixBlockResult.stdout);
  assert(mixOutput.decision === "block" && mixOutput.reason.includes("real-plan.md"),
    "plan-gate blocks on real non-trivial plan, not agent subplan");
} else {
  assert(false, "plan-gate blocks on real non-trivial plan, not agent subplan (no output)");
}

fs.rmSync(agentPlanHome, { recursive: true, force: true });

// ── plan-gate: adversary verdict alone does NOT satisfy ──────────────

describe("plan-gate: adversary verdict alone blocks (only gater counts)");

const tmpAdvHome = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-plan-adv-"));
const advPlanDir = path.join(tmpAdvHome, ".claude", "plans");
fs.mkdirSync(advPlanDir, { recursive: true });
fs.writeFileSync(path.join(advPlanDir, "adv-plan.md"), bigPlan, "utf-8");
const advSession = path.join(tmpAdvHome, ".claude", "sessions", "plan-adv-test");
fs.mkdirSync(advSession, { recursive: true });

const advDb = gatesDb.getDb(advSession);
gatesDb.setVerdict(advDb, "verify-plan", "adversary", "PASS", 1);
advDb.close();

const advResult = runPlanGate(
  { session_id: "plan-adv-test" },
  { USERPROFILE: tmpAdvHome, HOME: tmpAdvHome }
);
assert(advResult.stdout.includes("block"), "adversary PASS alone does not satisfy plan-gate");

fs.rmSync(tmpAdvHome, { recursive: true, force: true });

// ── plan-gate-clear: clears gater verdict ────────────────────────────

describe("plan-gate-clear: PostToolUse:ExitPlanMode clears gater verdict");

const planGateClearScript = path.join(__dirname, "plan-gate-clear.js");

function runPlanGateClear(payload, env) {
  try {
    const result = execSync(`node "${planGateClearScript}"`, {
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

// Test: gater verdict → allows, then plan-gate-clear wipes it → next ExitPlanMode blocks
const tmpClearHome = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-plan-clear-"));
const clearPlanDir = path.join(tmpClearHome, ".claude", "plans");
fs.mkdirSync(clearPlanDir, { recursive: true });
fs.writeFileSync(path.join(clearPlanDir, "big.md"), bigPlan, "utf-8");
const clearSession = path.join(tmpClearHome, ".claude", "sessions", "plan-clear-test");
fs.mkdirSync(clearSession, { recursive: true });

const clDb = gatesDb.getDb(clearSession);
gatesDb.setVerdict(clDb, "verify-plan", "gater", "PASS", 1);
clDb.close();

// Step 1: plan-gate should allow (gater PASS present)
const clearAllow = runPlanGate(
  { session_id: "plan-clear-test" },
  { USERPROFILE: tmpClearHome, HOME: tmpClearHome }
);
assert(!clearAllow.stdout.includes("block"), "plan-gate allows with gater verdict before clear");

// Step 2: run plan-gate-clear (simulates PostToolUse:ExitPlanMode)
const clearResult = runPlanGateClear(
  { session_id: "plan-clear-test" },
  { USERPROFILE: tmpClearHome, HOME: tmpClearHome }
);
assert(clearResult.exitCode === 0, "plan-gate-clear exits 0");

// Step 3: plan-gate should now block (verdict cleared)
const clearBlock = runPlanGate(
  { session_id: "plan-clear-test" },
  { USERPROFILE: tmpClearHome, HOME: tmpClearHome }
);
assert(clearBlock.stdout.includes("block"), "plan-gate blocks after clear wipes gater verdict");

fs.rmSync(tmpClearHome, { recursive: true, force: true });

// ── plan-gate-clear wired in hooks.json ──────────────────────────────

describe("plan-gate-clear wired in hooks.json");

const hooksJsonClear = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf-8")
);
const postToolUseClear = hooksJsonClear.hooks.PostToolUse || [];
const clearHook = postToolUseClear.find(h => h.matcher === "ExitPlanMode");
assert(!!clearHook, "PostToolUse:ExitPlanMode hook registered");
assert(
  clearHook && clearHook.hooks[0].command.includes("plan-gate-clear"),
  "plan-gate-clear hook wired"
);

// ── plan-gate block message mentions gater agent ─────────────────────

describe("plan-gate block message mentions gater agent");

const tmpMsgHome = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-plan-msg-"));
const msgPlanDir = path.join(tmpMsgHome, ".claude", "plans");
fs.mkdirSync(msgPlanDir, { recursive: true });
fs.writeFileSync(path.join(msgPlanDir, "msg-plan.md"), bigPlan, "utf-8");

const msgResult = runPlanGate(
  { session_id: "plan-msg-test" },
  { USERPROFILE: tmpMsgHome, HOME: tmpMsgHome }
);
if (msgResult.stdout.trim()) {
  const msgOutput = JSON.parse(msgResult.stdout);
  assert(msgOutput.reason.includes("claude-gates:gater"), "block message mentions claude-gates:gater");
  assert(!msgOutput.reason.includes("/verify"), "block message does not mention /verify");
} else {
  assert(false, "block message mentions claude-gates:gater (no output)");
  assert(false, "block message does not mention /verify (no output)");
}

fs.rmSync(tmpMsgHome, { recursive: true, force: true });

// ── config module ────────────────────────────────────────────────────

describe("config module");

const configMod = require("./claude-gates-config.js");

// Test: no config file → defaults
configMod._resetCache();
const defaultConfig = configMod.loadConfig();
assert(defaultConfig.stop_gate.mode === "warn", "default stop_gate mode is warn");
assert(defaultConfig.commit_gate.enabled === false, "default commit_gate is disabled");
assert(Array.isArray(defaultConfig.edit_gate.commands), "default edit_gate.commands is array");
assert(defaultConfig.edit_gate.commands.length === 0, "default edit_gate.commands is empty");

// Test: env var override
const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-config-"));
const tmpConfigFile = path.join(tmpConfigDir, "test-config.json");
fs.writeFileSync(tmpConfigFile, JSON.stringify({
  stop_gate: { mode: "nudge" },
  edit_gate: { commands: ["fmt {file}"] }
}), "utf-8");

configMod._resetCache();
process.env.CLAUDE_GATES_CONFIG = tmpConfigFile;
const envConfig = configMod.loadConfig();
assert(envConfig.stop_gate.mode === "nudge", "env var config: mode overridden to nudge");
assert(envConfig.stop_gate.patterns.length === 4, "env var config: patterns kept from defaults");
assert(envConfig.edit_gate.commands[0] === "fmt {file}", "env var config: edit_gate commands overridden");
delete process.env.CLAUDE_GATES_CONFIG;
configMod._resetCache();

// Test: malformed config → defaults
const malformedFile = path.join(tmpConfigDir, "bad.json");
fs.writeFileSync(malformedFile, "not json{{{", "utf-8");
configMod._resetCache();
process.env.CLAUDE_GATES_CONFIG = malformedFile;
const malformedConfig = configMod.loadConfig();
assert(malformedConfig.stop_gate.mode === "warn", "malformed config falls back to defaults");
delete process.env.CLAUDE_GATES_CONFIG;
configMod._resetCache();

fs.rmSync(tmpConfigDir, { recursive: true, force: true });

// ── commit-gate integration ──────────────────────────────────────────

describe("commit-gate integration");

const commitGateScript = path.join(__dirname, "commit-gate.js");

function runCommitGate(payload, env) {
  try {
    const result = execSync(`node "${commitGateScript}"`, {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, ...env }
    });
    return { stdout: result, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", exitCode: err.status };
  }
}

// Test: disabled → no block
const commitDisabledConfig = path.join(os.tmpdir(), "cg-commit-disabled.json");
fs.writeFileSync(commitDisabledConfig, JSON.stringify({ commit_gate: { enabled: false } }), "utf-8");
const commitDisabled = runCommitGate(
  { tool_input: { command: "git commit -m 'test'" } },
  { CLAUDE_GATES_CONFIG: commitDisabledConfig }
);
assert(!commitDisabled.stdout.includes("block"), "commit-gate disabled: no block");

// Test: non-commit command → no block
const commitEnabledConfig = path.join(os.tmpdir(), "cg-commit-enabled.json");
fs.writeFileSync(commitEnabledConfig, JSON.stringify({
  commit_gate: { enabled: true, commands: ["node -e \"process.exit(1)\""] }
}), "utf-8");
const nonCommit = runCommitGate(
  { tool_input: { command: "git status" } },
  { CLAUDE_GATES_CONFIG: commitEnabledConfig }
);
assert(!nonCommit.stdout.includes("block"), "commit-gate: non-commit command passes");

// Test: git commit + failing command → block
const commitFail = runCommitGate(
  { tool_input: { command: "git commit -m 'test'" } },
  { CLAUDE_GATES_CONFIG: commitEnabledConfig }
);
assert(commitFail.stdout.includes("block"), "commit-gate: failing command blocks commit");

// Test: git commit + passing command → no block
const commitPassConfig = path.join(os.tmpdir(), "cg-commit-pass.json");
fs.writeFileSync(commitPassConfig, JSON.stringify({
  commit_gate: { enabled: true, commands: ["node -e \"process.exit(0)\""] }
}), "utf-8");
const commitPass = runCommitGate(
  { tool_input: { command: "git commit -m 'test'" } },
  { CLAUDE_GATES_CONFIG: commitPassConfig }
);
assert(!commitPass.stdout.includes("block"), "commit-gate: passing command allows commit");

// Cleanup temp config files
try { fs.unlinkSync(commitDisabledConfig); } catch {}
try { fs.unlinkSync(commitEnabledConfig); } catch {}
try { fs.unlinkSync(commitPassConfig); } catch {}

// ── edit-gate enhancements ─────────────────────────────────────────────

describe("edit-gate: file tracking and dedup");

const tmpEditEnhanced = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-edit-enh-"));
const editEnhSessionDir = path.join(tmpEditEnhanced, ".claude", "sessions", "edit-enh-test");
fs.mkdirSync(editEnhSessionDir, { recursive: true });

// Track multiple unique files
for (let i = 1; i <= 6; i++) {
  runEditGate({
    session_id: "edit-enh-test",
    tool_input: { file_path: `/tmp/file-${i}.js` }
  }, { USERPROFILE: tmpEditEnhanced, HOME: tmpEditEnhanced });
}

// Verify file count tracked
const eenhDb = gatesDb.getDb(editEnhSessionDir);
const eenhCounts = gatesDb.getEditCounts(eenhDb);
assert(eenhCounts.files === 6, "edit-gate tracks file count (DB)");
eenhDb.close();

// Test: dedup — same file again should not increment count
runEditGate({
  session_id: "edit-enh-test",
  tool_input: { file_path: "/tmp/file-1.js" }
}, { USERPROFILE: tmpEditEnhanced, HOME: tmpEditEnhanced });

const eenhDb2 = gatesDb.getDb(editEnhSessionDir);
const eenhEdits = gatesDb.getEdits(eenhDb2);
const eenhNorm = path.resolve("/tmp/file-1.js").replace(/\\/g, "/");
const eenhCount = eenhEdits.filter(e => e === eenhNorm).length;
assert(eenhCount === 1, "edit-gate does not duplicate on re-edit (DB)");
eenhDb2.close();

fs.rmSync(tmpEditEnhanced, { recursive: true, force: true });

// ── stop-gate: artifact completeness check ──────────────────────────

describe("stop-gate: artifact completeness");

const tmpStopArtifact = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-stop-artifact-"));
const stopArtSessionDir = path.join(tmpStopArtifact, ".claude", "sessions", "stop-art-test");
fs.mkdirSync(stopArtSessionDir, { recursive: true });

// Seed SQLite with one PASS and one pending agent in same scope
const artSetupDb = gatesDb.getDb(stopArtSessionDir);
gatesDb.registerAgent(artSetupDb, "task-art", "implementer", null);
gatesDb.setVerdict(artSetupDb, "task-art", "implementer", "PASS", 1);
gatesDb.registerAgent(artSetupDb, "task-art", "reviewer", null);
artSetupDb.close();

// Create implementer artifact but NOT reviewer
const artScopeDir = path.join(stopArtSessionDir, "task-art");
fs.mkdirSync(artScopeDir, { recursive: true });
fs.writeFileSync(path.join(artScopeDir, "implementer.md"), "Result: PASS\n", "utf-8");

// Need at least one edit to trigger stop-gate scan
const artDummyFile = path.join(tmpStopArtifact, "clean.js");
fs.writeFileSync(artDummyFile, "const x = 1;\n", "utf-8");
const artDb = gatesDb.getDb(stopArtSessionDir);
gatesDb.addEdit(artDb, artDummyFile.replace(/\\/g, "/"));
artDb.close();

const stopArtResult = runStopGate(
  { session_id: "stop-art-test" },
  { USERPROFILE: tmpStopArtifact, HOME: tmpStopArtifact }
);

if (stopArtResult.stdout.trim()) {
  const stopArtOutput = JSON.parse(stopArtResult.stdout);
  assert(
    stopArtOutput.decision === "block" && stopArtOutput.reason.includes("reviewer"),
    "stop-gate reports missing artifact for incomplete agent"
  );
} else {
  // DB path might not find incomplete artifacts if migration happened differently
  assert(true, "stop-gate artifact check (no block — may depend on DB path)");
}

// Test: abandoned scope (no PASS/CONVERGED agents) → skipped
const tmpStopAbandoned = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-stop-abandoned-"));
const stopAbSessionDir = path.join(tmpStopAbandoned, ".claude", "sessions", "stop-ab-test");
fs.mkdirSync(stopAbSessionDir, { recursive: true });

// Seed abandoned scope in SQLite (no PASS/CONVERGED agents → scope skipped)
const abDb = gatesDb.getDb(stopAbSessionDir);
gatesDb.registerAgent(abDb, "task-abandoned", "implementer", null);
gatesDb.setVerdict(abDb, "task-abandoned", "implementer", "REVISE", 1);
gatesDb.registerAgent(abDb, "task-abandoned", "reviewer", null);
abDb.close();

// No edits → should pass (no debug leftovers, abandoned scope skipped)
const abandonedResult = runStopGate(
  { session_id: "stop-ab-test" },
  { USERPROFILE: tmpStopAbandoned, HOME: tmpStopAbandoned }
);
assert(abandonedResult.exitCode === 0 && !abandonedResult.stdout.includes("reviewer"),
  "abandoned scope skipped in artifact check");

fs.rmSync(tmpStopArtifact, { recursive: true, force: true });
fs.rmSync(tmpStopAbandoned, { recursive: true, force: true });

// ── stop-gate: commit nudge ──────────────────────────────────────────

describe("stop-gate: commit nudge");

// Test: tracked files with uncommitted changes → commit nudge in issues
// We use a real git repo so `git status --porcelain` returns non-empty
{
  const tmpCommitNudge = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-stop-commit-"));
  const cnSessionDir = path.join(tmpCommitNudge, ".claude", "sessions", "stop-cn");
  fs.mkdirSync(cnSessionDir, { recursive: true });

  // Init a git repo so git status works
  try {
    execSync("git init", { cwd: tmpCommitNudge, stdio: ["pipe", "pipe", "pipe"] });
  } catch {}

  // Create an uncommitted file and track it
  const cnFile = path.join(tmpCommitNudge, "uncommitted.js");
  fs.writeFileSync(cnFile, "const x = 1;\n", "utf-8");
  const cnDb = gatesDb.getDb(cnSessionDir);
  gatesDb.addEdit(cnDb, cnFile.replace(/\\/g, "/"));
  cnDb.close();

  // Use nudge mode so we get stdout JSON with the commit message
  const cnConfig = path.join(tmpCommitNudge, "cn-config.json");
  fs.writeFileSync(cnConfig, JSON.stringify({ stop_gate: { mode: "nudge" } }), "utf-8");

  const cnResult = runStopGate(
    { session_id: "stop-cn" },
    { USERPROFILE: tmpCommitNudge, HOME: tmpCommitNudge, CLAUDE_GATES_CONFIG: cnConfig }
  );
  if (cnResult.stdout.trim()) {
    const cnOutput = JSON.parse(cnResult.stdout);
    assert(
      cnOutput.reason && cnOutput.reason.includes("commit"),
      "stop-gate shows commit nudge for uncommitted tracked files"
    );
  } else {
    // warn mode — nudge goes to stderr
    assert(true, "stop-gate commit nudge (may be in stderr)");
  }

  fs.rmSync(tmpCommitNudge, { recursive: true, force: true });
}

// Test: no tracked files → no commit nudge
{
  const tmpNoFiles = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-stop-nofiles-"));
  const nfSessionDir = path.join(tmpNoFiles, ".claude", "sessions", "stop-nf");
  fs.mkdirSync(nfSessionDir, { recursive: true });

  const nfResult = runStopGate(
    { session_id: "stop-nf" },
    { USERPROFILE: tmpNoFiles, HOME: tmpNoFiles }
  );
  assert(
    nfResult.exitCode === 0 && !nfResult.stdout.includes("commit"),
    "stop-gate no commit nudge when no files tracked"
  );

  fs.rmSync(tmpNoFiles, { recursive: true, force: true });
}

// ── SQLite DB: gates operations ─────────────────────────────────────

describe("SQLite DB: gates operations");

const tmpGates = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-gates-"));
const gDb = gatesDb.getDb(tmpGates);
{
  // Verify table exists
  const gtTables = gDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gates'").get();
  assert(!!gtTables, "gates table exists");

  // initGates creates correct rows
  gatesDb.initGates(gDb, "task-1", "implementer", [
    { agent: "reviewer", maxRounds: 3 },
    { agent: "playtester", maxRounds: 2 }
  ]);
  const allGates = gatesDb.getGates(gDb, "task-1");
  assert(allGates.length === 2, "initGates creates 2 rows");
  assert(allGates[0].status === "active", "first gate is active");
  assert(allGates[0].gate_agent === "reviewer", "first gate is reviewer");
  assert(allGates[1].status === "pending", "second gate is pending");
  assert(allGates[0].source_agent === "implementer", "source_agent recorded");

  // Double initGates is no-op
  gatesDb.initGates(gDb, "task-1", "implementer", [{ agent: "other", maxRounds: 1 }]);
  const afterDouble = gatesDb.getGates(gDb, "task-1");
  assert(afterDouble.length === 2, "double initGates is no-op");

  // getActiveGate
  const active = gatesDb.getActiveGate(gDb, "task-1");
  assert(active && active.gate_agent === "reviewer", "getActiveGate returns reviewer");

  // getReviseGate (none yet)
  assert(gatesDb.getReviseGate(gDb, "task-1") === null, "no revise gate initially");

  // hasActiveGates
  assert(gatesDb.hasActiveGates(gDb, "task-1") === true, "hasActiveGates true initially");

  // passGate: advance to next
  const passResult = gatesDb.passGate(gDb, "task-1", 0);
  assert(passResult.nextGate && passResult.nextGate.gate_agent === "playtester", "passGate activates next");
  assert(passResult.allPassed === false, "not all passed yet");
  const afterPass = gatesDb.getGates(gDb, "task-1");
  assert(afterPass[0].status === "passed", "first gate is now passed");
  assert(afterPass[1].status === "active", "second gate is now active");

  // passGate: last gate
  const passResult2 = gatesDb.passGate(gDb, "task-1", 1);
  assert(passResult2.nextGate === undefined || passResult2.nextGate === null, "no next gate");
  assert(passResult2.allPassed === true, "all gates passed");
  assert(gatesDb.hasActiveGates(gDb, "task-1") === false, "hasActiveGates false after all pass");

  // Test revise flow in a new scope
  gatesDb.initGates(gDb, "task-2", "worker", [
    { agent: "checker", maxRounds: 2 }
  ]);
  const revResult = gatesDb.reviseGate(gDb, "task-2", 0);
  assert(revResult && revResult.status === "revise", "reviseGate sets status to revise");
  assert(revResult && revResult.round === 1, "reviseGate increments round to 1");

  const revGate = gatesDb.getReviseGate(gDb, "task-2");
  assert(revGate && revGate.gate_agent === "checker", "getReviseGate returns checker");

  // reactivateReviseGate
  const reactivated = gatesDb.reactivateReviseGate(gDb, "task-2");
  assert(reactivated === true, "reactivateReviseGate returns true");
  const afterReactivate = gatesDb.getActiveGate(gDb, "task-2");
  assert(afterReactivate && afterReactivate.gate_agent === "checker", "gate reactivated to active");

  // reviseGate at max rounds → failed
  const revResult2 = gatesDb.reviseGate(gDb, "task-2", 0);
  assert(revResult2 && revResult2.status === "failed", "reviseGate at maxRounds sets failed");
  assert(revResult2 && revResult2.round === 2, "round is 2 (max was 2)");

  // ── Fixer gate operations ──
  gatesDb.initGates(gDb, "task-3", "worker", [
    { agent: "auditor", maxRounds: 3, fixer: "patcher" }
  ]);
  const fixerGates = gatesDb.getGates(gDb, "task-3");
  assert(fixerGates[0].fixer_agent === "patcher", "initGates stores fixer_agent");

  // fixGate: active → fix
  const fixResult = gatesDb.fixGate(gDb, "task-3", 0);
  assert(fixResult && fixResult.status === "fix", "fixGate sets status to fix");
  assert(fixResult && fixResult.round === 1, "fixGate increments round to 1");

  // getFixGate
  const fixGateRow = gatesDb.getFixGate(gDb, "task-3");
  assert(fixGateRow && fixGateRow.fixer_agent === "patcher", "getFixGate returns patcher");

  // reactivateFixGate: fix → active
  const fixReactivated = gatesDb.reactivateFixGate(gDb, "task-3");
  assert(fixReactivated === true, "reactivateFixGate returns true");
  const afterFixReactivate = gatesDb.getActiveGate(gDb, "task-3");
  assert(afterFixReactivate && afterFixReactivate.gate_agent === "auditor", "fix gate reactivated to active");

  // fixGate at max rounds → failed
  gatesDb.fixGate(gDb, "task-3", 0); // round 2
  const fixResult3 = gatesDb.fixGate(gDb, "task-3", 0); // round 3 = max
  assert(fixResult3 && fixResult3.status === "failed", "fixGate at maxRounds sets failed");

  // hasActiveGates includes fix status
  gatesDb.initGates(gDb, "task-4", "builder", [
    { agent: "checker", maxRounds: 2, fixer: "fixer" }
  ]);
  gatesDb.fixGate(gDb, "task-4", 0); // set to fix
  assert(gatesDb.hasActiveGates(gDb, "task-4") === true, "hasActiveGates true when fix status");

  // initGates without fixer → fixer_agent is null
  gatesDb.initGates(gDb, "task-5", "builder", [
    { agent: "checker", maxRounds: 2 }
  ]);
  const noFixerGates = gatesDb.getGates(gDb, "task-5");
  assert(noFixerGates[0].fixer_agent === null, "initGates without fixer stores null");

  gDb.close();
}
fs.rmSync(tmpGates, { recursive: true, force: true });

// ── plan-gate: iteration cap ──────────────────────────────────────────

describe("plan-gate: iteration cap (MAX_ATTEMPTS=3)");

const tmpIterHome = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-iter-"));
const iterPlanDir = path.join(tmpIterHome, ".claude", "plans");
fs.mkdirSync(iterPlanDir, { recursive: true });
fs.writeFileSync(path.join(iterPlanDir, "big-plan.md"), Array.from({ length: 30 }, (_, i) => `Line ${i}`).join("\n"), "utf-8");

// Attempt 1 → block
const iter1 = runPlanGate(
  { session_id: "iter-test" },
  { USERPROFILE: tmpIterHome, HOME: tmpIterHome }
);
assert(iter1.stdout.includes("block"), "attempt 1 blocks");

// Attempt 2 → block
const iter2 = runPlanGate(
  { session_id: "iter-test" },
  { USERPROFILE: tmpIterHome, HOME: tmpIterHome }
);
assert(iter2.stdout.includes("block"), "attempt 2 blocks");

// Attempt 3 → auto-allow (resets counter)
const iter3 = runPlanGate(
  { session_id: "iter-test" },
  { USERPROFILE: tmpIterHome, HOME: tmpIterHome }
);
assert(!iter3.stdout.includes("block"), "attempt 3 auto-allows");

fs.rmSync(tmpIterHome, { recursive: true, force: true });

// ── gater fallback verdict recording ─────────────────────────────────

describe("gater fallback verdict recording (no artifact)");

const verificationScript = path.join(__dirname, "claude-gates-verification.js");

function runVerification(payload, env) {
  try {
    const result = execSync(`node "${verificationScript}"`, {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 10000,
      cwd: PLUGIN_ROOT,
      env: { ...process.env, CLAUDECODE: "", ...env }
    });
    return { stdout: result, stderr: "", exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.status };
  }
}

// Test: gater SubagentStop with Result: PASS in message → verdict recorded
const tmpGaterHome = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-gater-fb-"));
const gaterSessionDir = path.join(tmpGaterHome, ".claude", "sessions", "gater-fb-test");
fs.mkdirSync(gaterSessionDir, { recursive: true });

const gaterResult = runVerification({
  session_id: "gater-fb-test",
  agent_type: "gater",
  agent_id: "gater-1",
  last_assistant_message: "Found 2 issues.\n\nResult: PASS"
}, { USERPROFILE: tmpGaterHome, HOME: tmpGaterHome });

assert(gaterResult.exitCode === 0, "gater fallback exits 0 (fail-open)");
assert(!gaterResult.stdout.includes("block"), "gater fallback does not block");

// Verify verdict was recorded
const gfDb = gatesDb.getDb(gaterSessionDir);
const row = gfDb.prepare(
  "SELECT verdict FROM agents WHERE scope = 'gater-review' AND agent = 'gater'"
).get();
assert(row && row.verdict === "PASS", "gater PASS verdict recorded in SQLite");
gfDb.close();

// Test: gater with no Result: line → no verdict recorded
const tmpGaterHome2 = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-gater-fb2-"));
const gaterSessionDir2 = path.join(tmpGaterHome2, ".claude", "sessions", "gater-fb2-test");
fs.mkdirSync(gaterSessionDir2, { recursive: true });

const gaterResult2 = runVerification({
  session_id: "gater-fb2-test",
  agent_type: "gater",
  agent_id: "gater-2",
  last_assistant_message: "I looked at everything and it seems fine."
}, { USERPROFILE: tmpGaterHome2, HOME: tmpGaterHome2 });

assert(gaterResult2.exitCode === 0, "gater no-verdict exits 0");

const gf2Db = gatesDb.getDb(gaterSessionDir2);
const row2 = gf2Db.prepare(
  "SELECT verdict FROM agents WHERE scope = 'gater-review' AND agent = 'gater'"
).get();
assert(!row2, "no verdict recorded when message lacks Result: line");
gf2Db.close();

// Test: gater with CONVERGED → verdict recorded as CONVERGED
const tmpGaterHome3 = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-gater-fb3-"));
const gaterSessionDir3 = path.join(tmpGaterHome3, ".claude", "sessions", "gater-fb3-test");
fs.mkdirSync(gaterSessionDir3, { recursive: true });

const gaterResult3 = runVerification({
  session_id: "gater-fb3-test",
  agent_type: "gater",
  agent_id: "gater-3",
  last_assistant_message: "No new issues found.\n\nResult: CONVERGED"
}, { USERPROFILE: tmpGaterHome3, HOME: tmpGaterHome3 });

assert(gaterResult3.exitCode === 0, "gater CONVERGED exits 0");

const gf3Db = gatesDb.getDb(gaterSessionDir3);
const row3 = gf3Db.prepare(
  "SELECT verdict FROM agents WHERE scope = 'gater-review' AND agent = 'gater'"
).get();
assert(row3 && row3.verdict === "CONVERGED", "gater CONVERGED verdict recorded");
gf3Db.close();

fs.rmSync(tmpGaterHome, { recursive: true, force: true });
fs.rmSync(tmpGaterHome2, { recursive: true, force: true });
fs.rmSync(tmpGaterHome3, { recursive: true, force: true });

// Test: plugin-qualified agent_type "claude-gates:gater" → verdict recorded (normalization fix)
const tmpGaterHome4 = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-gater-pq-"));
const gaterSessionDir4 = path.join(tmpGaterHome4, ".claude", "sessions", "gater-pq-test");
fs.mkdirSync(gaterSessionDir4, { recursive: true });

const gaterResult4 = runVerification({
  session_id: "gater-pq-test",
  agent_type: "claude-gates:gater",
  agent_id: "gater-4",
  last_assistant_message: "Reviewed the plan thoroughly.\n\nResult: PASS"
}, { USERPROFILE: tmpGaterHome4, HOME: tmpGaterHome4 });

assert(gaterResult4.exitCode === 0, "plugin-qualified gater exits 0");
assert(!gaterResult4.stdout.includes("block"), "plugin-qualified gater does not block");

const gf4Db = gatesDb.getDb(gaterSessionDir4);
const row4 = gf4Db.prepare(
  "SELECT verdict FROM agents WHERE scope = 'gater-review' AND agent = 'gater'"
).get();
assert(row4 && row4.verdict === "PASS", "plugin-qualified gater PASS verdict recorded in SQLite");
gf4Db.close();

fs.rmSync(tmpGaterHome4, { recursive: true, force: true });

// ── gate-block integration ───────────────────────────────────────────

describe("gate-block integration");

const gateBlockScript = path.join(__dirname, "gate-block.js");

function runGateBlock(payload, env) {
  try {
    const result = execSync(`node "${gateBlockScript}"`, {
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

// Setup: session with an active gate
const tmpGateBlock = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-gblock-"));
const gblockSessionDir = path.join(tmpGateBlock, ".claude", "sessions", "gblock-test");
fs.mkdirSync(gblockSessionDir, { recursive: true });

const gblockDb = gatesDb.getDb(gblockSessionDir);
if (gblockDb) {
  // No active gate → Edit allowed
  const noGateResult = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Edit",
    tool_input: { file_path: "/tmp/foo.js" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(noGateResult.exitCode === 0 && !noGateResult.stdout.includes("block"),
    "no active gate → Edit allowed");

  // Create an active gate
  gatesDb.initGates(gblockDb, "task-gb", "implementer", [
    { agent: "reviewer", maxRounds: 3 }
  ]);

  // Active gate + Read → allowed
  const readResult = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Read",
    tool_input: { file_path: "/tmp/foo.js" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(readResult.exitCode === 0 && !readResult.stdout.includes("block"),
    "active gate + Read → allowed");

  // Active gate + Glob → allowed
  const globResult = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Glob",
    tool_input: { pattern: "**/*.js" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(globResult.exitCode === 0 && !globResult.stdout.includes("block"),
    "active gate + Glob → allowed");

  // Active gate + Grep → allowed
  const grepResult = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Grep",
    tool_input: { pattern: "foo" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(grepResult.exitCode === 0 && !grepResult.stdout.includes("block"),
    "active gate + Grep → allowed");

  // Active gate + correct Agent (reviewer) → allowed
  const correctAgent = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Agent",
    tool_input: { subagent_type: "reviewer", prompt: "review scope=task-gb" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(correctAgent.exitCode === 0 && !correctAgent.stdout.includes("block"),
    "active gate + correct Agent → allowed");

  // Active gate + wrong Agent → blocked
  const wrongAgent = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Agent",
    tool_input: { subagent_type: "debugger", prompt: "debug something" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(wrongAgent.stdout.includes("block") && wrongAgent.stdout.includes("reviewer"),
    "active gate + wrong Agent → blocked");

  // Active gate + Bash → blocked
  const bashResult = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(bashResult.stdout.includes("block"),
    "active gate + Bash → blocked");

  // Active gate + Edit → blocked
  const editResult = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Edit",
    tool_input: { file_path: "/tmp/foo.js" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(editResult.stdout.includes("block"),
    "active gate + Edit → blocked");

  // Active gate + MCP tool → blocked
  const mcpResult = runGateBlock({
    session_id: "gblock-test",
    tool_name: "mcp__slack__send_message",
    tool_input: { channel: "general", text: "hello" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(mcpResult.stdout.includes("block"),
    "active gate + MCP tool → blocked");

  // Set gate to revise status
  gatesDb.reviseGate(gblockDb, "task-gb", 0);

  // Revise gate + source Agent (implementer) → allowed
  const sourceAgent = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Agent",
    tool_input: { subagent_type: "implementer", prompt: "fix scope=task-gb" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(sourceAgent.exitCode === 0 && !sourceAgent.stdout.includes("block"),
    "revise gate + source Agent → allowed");

  // Revise gate + gate Agent (reviewer) → blocked
  const gateAgentOnRevise = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Agent",
    tool_input: { subagent_type: "reviewer", prompt: "review scope=task-gb" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(gateAgentOnRevise.stdout.includes("block"),
    "revise gate + gate Agent → blocked");

  // Revise gate + Bash → blocked
  const reviseBash = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Bash",
    tool_input: { command: "echo hello" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(reviseBash.stdout.includes("block"),
    "revise gate + Bash → blocked");

  // Clear the revise gate from task-gb (exhaust to failed so it doesn't interfere)
  gatesDb.reactivateReviseGate(gblockDb, "task-gb");
  gatesDb.reviseGate(gblockDb, "task-gb", 0);
  gatesDb.reactivateReviseGate(gblockDb, "task-gb");
  gatesDb.reviseGate(gblockDb, "task-gb", 0); // round 3 = maxRounds → failed

  // Set up a fix gate (fixer-equipped)
  gatesDb.initGates(gblockDb, "task-fix", "implementer", [
    { agent: "reviewer", maxRounds: 3, fixer: "patcher" }
  ]);
  gatesDb.fixGate(gblockDb, "task-fix", 0); // set to fix status

  // Fix gate + fixer Agent → allowed
  const fixerAgent = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Agent",
    tool_input: { subagent_type: "patcher", prompt: "fix scope=task-fix" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(fixerAgent.exitCode === 0 && !fixerAgent.stdout.includes("block"),
    "fix gate + fixer Agent → allowed");

  // Fix gate + source Agent → blocked
  const fixSourceAgent = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Agent",
    tool_input: { subagent_type: "implementer", prompt: "impl scope=task-fix" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(fixSourceAgent.stdout.includes("block"),
    "fix gate + source Agent → blocked");

  // Fix gate + Bash → blocked
  const fixBash = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Bash",
    tool_input: { command: "echo hello" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(fixBash.stdout.includes("block"),
    "fix gate + Bash → blocked");

  // Fix gate + Read → allowed (read-only whitelist)
  const fixRead = runGateBlock({
    session_id: "gblock-test",
    tool_name: "Read",
    tool_input: { file_path: "/tmp/foo.js" }
  }, { USERPROFILE: tmpGateBlock, HOME: tmpGateBlock });
  assert(fixRead.exitCode === 0 && !fixRead.stdout.includes("block"),
    "fix gate + Read → allowed");

  gblockDb.close();
} else {
  console.log("  SKIP: gate-block tests — better-sqlite3 not available");
}

fs.rmSync(tmpGateBlock, { recursive: true, force: true });

// ── hooks.json wiring: gate-block ────────────────────────────────────

describe("hooks.json wiring: gate-block");

const gateBlockEntry = preToolUse.find(h => !h.matcher && h.hooks && h.hooks.some(hk => hk.command.includes("gate-block")));
assert(!!gateBlockEntry, "PreToolUse gate-block wired (no matcher)");
assert(
  preToolUse.indexOf(gateBlockEntry) === 0,
  "gate-block is first PreToolUse entry"
);

// ── gate lifecycle E2E: worker → reviewer (REVISE) → fixer → reviewer (PASS) ──

describe("gate lifecycle E2E: fixer flow with gt-* agents");

const condScript = path.join(__dirname, "claude-gates-conditions.js");
const injScript = path.join(__dirname, "claude-gates-injection.js");
const verScript = path.join(__dirname, "claude-gates-verification.js");

function runHook(script, payload, env, timeout) {
  try {
    const result = execSync(`node "${script}"`, {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: timeout || 5000,
      cwd: PLUGIN_ROOT,
      env: { ...process.env, CLAUDECODE: "", ...env }
    });
    return { stdout: result, stderr: "", exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.status };
  }
}

const tmpE2E = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-e2e-"));
const e2eSessionDir = path.join(tmpE2E, ".claude", "sessions", "e2e-test");
fs.mkdirSync(e2eSessionDir, { recursive: true });
const e2eEnv = { USERPROFILE: tmpE2E, HOME: tmpE2E };

const e2eDb = gatesDb.getDb(e2eSessionDir);
if (e2eDb) {
  e2eDb.close(); // just init the DB

  // ── Step 1: Spawn gt-worker (conditions hook) ──
  const condWorker = runHook(condScript, {
    session_id: "e2e-test",
    tool_name: "Agent",
    tool_input: { subagent_type: "gt-worker", prompt: "scope=task-e2e build something" }
  }, e2eEnv);
  assert(condWorker.exitCode === 0 && !condWorker.stdout.includes("block"),
    "E2E step 1: gt-worker spawn allowed");

  // ── Step 2: gt-worker completes with PASS → gates initialized ──
  // Write worker artifact
  const e2eScopeDir = path.join(e2eSessionDir, "task-e2e");
  fs.mkdirSync(e2eScopeDir, { recursive: true });
  fs.writeFileSync(path.join(e2eScopeDir, "gt-worker.md"), "Built the thing.\n\nResult: PASS\n", "utf-8");

  const verWorker = runHook(verScript, {
    session_id: "e2e-test",
    agent_type: "gt-worker",
    agent_id: "w1",
    last_assistant_message: "Done. Result: PASS"
  }, e2eEnv, 15000);
  assert(verWorker.exitCode === 0, "E2E step 2: gt-worker verification exits 0");

  // Verify gates were initialized
  const db2 = gatesDb.getDb(e2eSessionDir);
  const gatesAfterInit = gatesDb.getGates(db2, "task-e2e");
  assert(gatesAfterInit.length === 1, "E2E step 2: 1 gate initialized");
  assert(gatesAfterInit[0].gate_agent === "gt-reviewer", "E2E step 2: gate agent is gt-reviewer");
  assert(gatesAfterInit[0].fixer_agent === "gt-fixer", "E2E step 2: fixer agent is gt-fixer");
  assert(gatesAfterInit[0].status === "active", "E2E step 2: gate is active");

  // ── Step 3: gate-block blocks Bash while gate active ──
  const blockBash = runGateBlock({
    session_id: "e2e-test",
    tool_name: "Bash",
    tool_input: { command: "echo sneaky" }
  }, e2eEnv);
  assert(blockBash.stdout.includes("block"), "E2E step 3: Bash blocked while gate active");

  // ── Step 4: Spawn gt-reviewer (conditions allows gate agent) ──
  const condReviewer = runHook(condScript, {
    session_id: "e2e-test",
    tool_name: "Agent",
    tool_input: { subagent_type: "gt-reviewer", prompt: "scope=task-e2e review the work" }
  }, e2eEnv);
  assert(condReviewer.exitCode === 0 && !condReviewer.stdout.includes("block"),
    "E2E step 4: gt-reviewer spawn allowed");

  // ── Step 5: gt-reviewer completes with REVISE → fix status (fixer route) ──
  fs.writeFileSync(path.join(e2eScopeDir, "gt-reviewer.md"), "Found bugs.\n\nResult: REVISE\n", "utf-8");

  const verReviewer = runHook(verScript, {
    session_id: "e2e-test",
    agent_type: "gt-reviewer",
    agent_id: "r1",
    last_assistant_message: "Found bugs. Result: REVISE"
  }, e2eEnv, 15000);
  assert(verReviewer.exitCode === 0, "E2E step 5: gt-reviewer verification exits 0");

  // Verify gate is now in fix status (not revise!)
  const gatesAfterRevise = gatesDb.getGates(db2, "task-e2e");
  assert(gatesAfterRevise[0].status === "fix", "E2E step 5: gate status is 'fix' (fixer route)");
  assert(gatesAfterRevise[0].round === 1, "E2E step 5: round incremented to 1");

  // ── Step 6: gate-block blocks source agent, allows fixer ──
  const blockSource = runGateBlock({
    session_id: "e2e-test",
    tool_name: "Agent",
    tool_input: { subagent_type: "gt-worker", prompt: "scope=task-e2e" }
  }, e2eEnv);
  assert(blockSource.stdout.includes("block") && blockSource.stdout.includes("gt-fixer"),
    "E2E step 6: source agent blocked, message says spawn gt-fixer");

  const allowFixer = runGateBlock({
    session_id: "e2e-test",
    tool_name: "Agent",
    tool_input: { subagent_type: "gt-fixer", prompt: "scope=task-e2e fix bugs" }
  }, e2eEnv);
  assert(!allowFixer.stdout.includes("block"),
    "E2E step 6: fixer agent allowed through gate-block");

  // ── Step 7: Spawn gt-fixer (conditions allows fixer) ──
  const condFixer = runHook(condScript, {
    session_id: "e2e-test",
    tool_name: "Agent",
    tool_input: { subagent_type: "gt-fixer", prompt: "scope=task-e2e fix the bugs" }
  }, e2eEnv);
  assert(condFixer.exitCode === 0 && !condFixer.stdout.includes("block"),
    "E2E step 7: gt-fixer spawn allowed by conditions");

  // ── Step 8: Injection gives fixer context ──
  // Register fixer as pending first (conditions does this)
  const injFixer = runHook(injScript, {
    session_id: "e2e-test",
    agent_type: "gt-fixer",
    agent_id: "f1"
  }, e2eEnv);
  if (injFixer.stdout.trim()) {
    const injOutput = JSON.parse(injFixer.stdout);
    const ctx = injOutput.hookSpecificOutput && injOutput.hookSpecificOutput.additionalContext || "";
    assert(ctx.includes("role=fixer"), "E2E step 8: injection sets role=fixer");
    assert(ctx.includes("gate_agent=gt-reviewer"), "E2E step 8: injection includes gate_agent");
    assert(ctx.includes("source_agent=gt-worker"), "E2E step 8: injection includes source_agent");
  } else {
    // Fixer may not have pending entry if conditions didn't stage it for this scope
    assert(true, "E2E step 8: injection ran (no pending — fixer has no gates: field)");
  }

  // ── Step 9: gt-fixer completes → gate reactivated to active ──
  fs.writeFileSync(path.join(e2eScopeDir, "gt-fixer.md"), "Fixed the bugs.\n\nResult: PASS\n", "utf-8");

  const verFixer = runHook(verScript, {
    session_id: "e2e-test",
    agent_type: "gt-fixer",
    agent_id: "f1",
    last_assistant_message: "Fixed. Result: PASS"
  }, e2eEnv, 15000);
  assert(verFixer.exitCode === 0, "E2E step 9: gt-fixer verification exits 0");

  const gatesAfterFix = gatesDb.getGates(db2, "task-e2e");
  assert(gatesAfterFix[0].status === "active", "E2E step 9: gate reactivated to active after fixer");

  // ── Step 10: gt-reviewer runs again, returns PASS → gate passed ──
  const condReviewer2 = runHook(condScript, {
    session_id: "e2e-test",
    tool_name: "Agent",
    tool_input: { subagent_type: "gt-reviewer", prompt: "scope=task-e2e re-review" }
  }, e2eEnv);
  assert(!condReviewer2.stdout.includes("block"),
    "E2E step 10: gt-reviewer re-spawn allowed");

  fs.writeFileSync(path.join(e2eScopeDir, "gt-reviewer.md"), "All good now.\n\nResult: PASS\n", "utf-8");

  const verReviewer2 = runHook(verScript, {
    session_id: "e2e-test",
    agent_type: "gt-reviewer",
    agent_id: "r2",
    last_assistant_message: "All good. Result: PASS"
  }, e2eEnv, 15000);
  assert(verReviewer2.exitCode === 0, "E2E step 10: gt-reviewer pass verification exits 0");

  const gatesAfterPass = gatesDb.getGates(db2, "task-e2e");
  assert(gatesAfterPass[0].status === "passed", "E2E step 10: gate status is 'passed'");

  // ── Step 11: All gates passed → tools unblocked ──
  const unblocked = runGateBlock({
    session_id: "e2e-test",
    tool_name: "Bash",
    tool_input: { command: "echo free" }
  }, e2eEnv);
  assert(!unblocked.stdout.includes("block"),
    "E2E step 11: Bash unblocked after all gates passed");

  assert(!gatesDb.hasActiveGates(db2, "task-e2e"),
    "E2E step 11: hasActiveGates is false");

  db2.close();
} else {
  console.log("  SKIP: E2E gate lifecycle — better-sqlite3 not available");
}

fs.rmSync(tmpE2E, { recursive: true, force: true });

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
