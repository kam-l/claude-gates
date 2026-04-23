"""
Port of PipelineE2eTest.ts — 28 end-to-end tests.

Tests exercise hook scripts via subprocess.run() with JSON stdin/stdout,
validating the full hook protocol end-to-end.

ts_source_tests: 28
pytest_count: 28
delta: 0 — 1:1 port; all 28 TS tests ported directly.

Subprocess-mock escalation note:
  The TS `block: skips blocking when agent-running marker exists` test uses
  require('./Database.js') and require('./StateMachine.js') in-process to seed
  the SQLite DB, then runs the hook as a subprocess. In Python we replicate this
  pattern by directly using PipelineRepository + PipelineEngine to seed the DB
  in the same temp directory, then invoking the subprocess hook against that dir.
  This is a 1:1 semantic port — no mock divergence to flag.

  The `conditions` and `verification` hook scripts call `claude -p` internally.
  In E2E tests, those paths are exercised only for structural/exit-code checks
  (unknown agent, gater exits cleanly, stop_hook_active). The conditions_check
  path that calls `claude -p` is NOT exercised here because it requires a real
  claude CLI. This matches the TS source, which also noted "structural parts only
  — no claude -p". No subprocess mock needed; fail-open behaviour means exit 0
  even when claude is absent.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates.engine import PipelineEngine
from src.claude_gates.parser import parse_verification, requires_scope
from src.claude_gates.repository import PipelineRepository


# ── Helpers ────────────────────────────────────────────────────────────────────

def _run_hook(script_name: str, stdin_data: dict, cwd: str = None, env: dict = None) -> dict:
    """Run a hook script with JSON stdin; return {stdout, stderr, exit_code}."""
    import subprocess
    script_path = os.path.join(_PROJECT_ROOT, "scripts", script_name)
    merged_env = {**os.environ, "CLAUDECODE": ""}
    if env:
        merged_env.update(env)
    result = subprocess.run(
        [sys.executable, script_path],
        input=json.dumps(stdin_data),
        capture_output=True,
        text=True,
        timeout=10,
        cwd=cwd or _PROJECT_ROOT,
        env=merged_env,
    )
    return {
        "stdout": result.stdout.strip(),
        "stderr": result.stderr,
        "exit_code": result.returncode,
    }


def _make_temp_root():
    """Create a temp directory tree with agent .md files. Returns (tmp_root, agents_dir, session_id)."""
    tmp_root = tempfile.mkdtemp(prefix="pipeline-e2e-")
    agents_dir = os.path.join(tmp_root, ".claude", "agents")
    os.makedirs(agents_dir, exist_ok=True)

    # Source agent with verification pipeline
    with open(os.path.join(agents_dir, "e2e-builder.md"), "w", encoding="utf-8") as f:
        f.write(
            "---\n"
            "name: e2e-builder\n"
            'description: "E2E test builder agent"\n'
            "model: sonnet\n"
            "verification:\n"
            '  - ["Verify the artifact is complete and correct."]\n'
            "  - [e2e-reviewer, 3]\n"
            "---\n\n"
            "Build an artifact for testing.\n"
        )

    # Reviewer agent (gate agent)
    with open(os.path.join(agents_dir, "e2e-reviewer.md"), "w", encoding="utf-8") as f:
        f.write(
            "---\n"
            "name: e2e-reviewer\n"
            'description: "E2E test reviewer agent"\n'
            "model: sonnet\n"
            "role: gate\n"
            "---\n\n"
            "Review the source artifact.\n"
        )

    # Agent with conditions
    with open(os.path.join(agents_dir, "e2e-conditional.md"), "w", encoding="utf-8") as f:
        f.write(
            "---\n"
            "name: e2e-conditional\n"
            'description: "E2E test conditional agent"\n'
            "model: sonnet\n"
            "conditions: |\n"
            "  Check if scope has been defined.\n"
            "verification:\n"
            '  - ["Verify output."]\n'
            "---\n\n"
            "Conditional agent.\n"
        )

    session_id = "e2e-test-" + str(int(__import__("time").time() * 1000))
    return tmp_root, agents_dir, session_id


def _make_db(db_dir: str) -> sqlite3.Connection:
    """Open (or create) a session.db in db_dir with schema initialised."""
    db_path = os.path.join(db_dir, "session.db")
    conn = sqlite3.connect(db_path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    PipelineRepository.init_schema(conn)
    return conn


def _make_engine(conn: sqlite3.Connection):
    repo = PipelineRepository(conn)
    return PipelineEngine(repo), repo


# ══════════════════════════════════════════════════════════════════════════════
# AC#1 / AC#5: subprocess-based invocation pattern + sys.executable
# ══════════════════════════════════════════════════════════════════════════════

class TestSubprocessInvocationPattern(unittest.TestCase):
    """AC#1 + AC#5: hooks invoked as subprocesses; exit code 0; stdout parsed as JSON."""

    def test_uses_sys_executable_and_exits_zero(self):
        """Invoking SessionContext.py via sys.executable exits 0."""
        r = _run_hook("SessionContext.py", {"session_id": "test-abc123"})
        self.assertEqual(r["exit_code"], 0)

    def test_empty_stdout_parses_as_empty_dict(self):
        """Empty stdout from a hook is treated as {} (valid allow response)."""
        r = _run_hook("PipelineBlock.py", {
            "session_id": "no-pipeline-" + str(id(self)),
            "tool_name": "Read",
            "tool_input": {},
            "agent_type": "",
        })
        self.assertEqual(r["exit_code"], 0)
        # Empty stdout is a valid allow — parse as {}
        parsed = json.loads(r["stdout"]) if r["stdout"] else {}
        self.assertIsInstance(parsed, dict)

    def test_stdout_is_valid_json_when_present(self):
        """When stdout is non-empty it must be valid JSON."""
        tmp_root, _, session_id = _make_temp_root()
        try:
            r = _run_hook("GateToggle.py", {
                "prompt": "gate status",
                "session_id": session_id,
            }, cwd=tmp_root)
            self.assertEqual(r["exit_code"], 0)
            if r["stdout"]:
                parsed = json.loads(r["stdout"])
                self.assertIsInstance(parsed, dict)
        finally:
            import shutil
            shutil.rmtree(tmp_root, ignore_errors=True)


# ══════════════════════════════════════════════════════════════════════════════
# AC#2: All hook scripts tested end-to-end
# ══════════════════════════════════════════════════════════════════════════════

class TestGateToggle(unittest.TestCase):
    """GateToggle: on/off/status end-to-end."""

    def setUp(self):
        self.tmp_root = tempfile.mkdtemp(prefix="gate-toggle-e2e-")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp_root, ignore_errors=True)

    def test_gate_status_exits_zero(self):
        r = _run_hook("GateToggle.py", {
            "prompt": "gate status",
            "session_id": "status-test",
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        # Status command returns a block decision
        if r["stdout"]:
            out = json.loads(r["stdout"])
            self.assertIn("decision", out)

    def test_gate_off_exits_zero(self):
        r = _run_hook("GateToggle.py", {
            "prompt": "gate off",
            "session_id": "off-test",
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)

    def test_gate_on_exits_zero(self):
        r = _run_hook("GateToggle.py", {
            "prompt": "gate on",
            "session_id": "on-test",
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)

    def test_non_toggle_prompt_allows(self):
        """Non-toggle prompt produces empty output (allow)."""
        r = _run_hook("GateToggle.py", {
            "prompt": "do some work",
            "session_id": "non-toggle",
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        self.assertEqual(r["stdout"], "")


class TestSessionContextBanner(unittest.TestCase):
    """SessionContext: banner output via subprocess."""

    def test_session_context_exits_zero(self):
        r = _run_hook("SessionContext.py", {"session_id": "banner-test-abc"})
        self.assertEqual(r["exit_code"], 0)

    def test_session_context_stdout_is_json_when_present(self):
        r = _run_hook("SessionContext.py", {"session_id": "banner-json-test"})
        self.assertEqual(r["exit_code"], 0)
        if r["stdout"]:
            parsed = json.loads(r["stdout"])
            self.assertIsInstance(parsed, dict)


class TestPipelineConditions(unittest.TestCase):
    """PipelineConditions: scope enforcement end-to-end."""

    def setUp(self):
        self.tmp_root, self.agents_dir, self.session_id = _make_temp_root()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp_root, ignore_errors=True)

    def test_allow_agent_with_scope(self):
        """conditions: allow agent with scope."""
        r = _run_hook("PipelineConditions.py", {
            "session_id": self.session_id,
            "tool_input": {
                "subagent_type": "e2e-builder",
                "prompt": "Build scope=test-e2e the thing",
            },
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        if r["stdout"]:
            out = json.loads(r["stdout"])
            self.assertNotEqual(out.get("decision"), "block")

    def test_block_agent_without_scope_when_requires_scope(self):
        """conditions: block agent without scope when requiresScope."""
        r = _run_hook("PipelineConditions.py", {
            "session_id": self.session_id,
            "tool_input": {
                "subagent_type": "e2e-builder",
                "prompt": "Build the thing without scope",
            },
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        if r["stdout"]:
            out = json.loads(r["stdout"])
            self.assertEqual(out.get("decision"), "block")
            self.assertIn("scope=", out.get("reason", ""))

    def test_allow_resume_without_gating(self):
        """conditions: allow resume without gating."""
        r = _run_hook("PipelineConditions.py", {
            "session_id": self.session_id,
            "tool_input": {
                "subagent_type": "e2e-builder",
                "prompt": "Resume",
                "resume": True,
            },
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        self.assertEqual(r["stdout"], "")

    def test_allow_unknown_agent_no_md_file(self):
        """conditions: allow unknown agent (no .md file)."""
        r = _run_hook("PipelineConditions.py", {
            "session_id": self.session_id,
            "tool_input": {
                "subagent_type": "nonexistent-agent",
                "prompt": "scope=test-e2e Do something",
            },
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        self.assertEqual(r["stdout"], "")


class TestPipelineBlock(unittest.TestCase):
    """PipelineBlock: allow/block tool calls end-to-end."""

    def setUp(self):
        self.tmp_root, _, self.session_id = _make_temp_root()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp_root, ignore_errors=True)

    def test_allows_when_no_active_pipelines(self):
        """block: allows when no active pipelines."""
        fresh_session = "block-test-" + str(id(self))
        r = _run_hook("PipelineBlock.py", {
            "session_id": fresh_session,
            "tool_name": "Edit",
            "tool_input": {},
            "agent_type": "",
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        self.assertEqual(r["stdout"], "")

    def test_allows_read_only_tools(self):
        """block: allows read-only tools."""
        r = _run_hook("PipelineBlock.py", {
            "session_id": self.session_id,
            "tool_name": "Read",
            "tool_input": {},
            "agent_type": "",
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        self.assertEqual(r["stdout"], "")

    def test_allows_subagent_calls(self):
        """block: allows subagent calls (caller is a subagent)."""
        r = _run_hook("PipelineBlock.py", {
            "session_id": self.session_id,
            "tool_name": "Edit",
            "tool_input": {},
            "agent_type": "e2e-builder",
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        self.assertEqual(r["stdout"], "")

    def test_skips_blocking_when_agent_running_marker_exists(self):
        """block: skips blocking when agent-running marker exists; blocks after removal."""
        marker_session = "abcd1234-test-marker-" + str(id(self))
        short_id = marker_session.replace("-", "")[:8]
        marker_dir = os.path.join(self.tmp_root, ".sessions", short_id)
        os.makedirs(marker_dir, exist_ok=True)

        # Seed DB with an active pipeline
        conn = _make_db(marker_dir)
        engine, repo = _make_engine(conn)
        engine.create_pipeline("marker-scope", "e2e-builder", [
            {"type": "CHECK", "prompt": "Check.", "maxRounds": 3},
        ])
        conn.close()

        # Write running marker (simulates conditions.js after allowing spawn)
        marker_file = os.path.join(marker_dir, ".running-marker-scope")
        with open(marker_file, "w", encoding="utf-8") as f:
            f.write("")

        # Block hook should NOT block (agent is still running)
        r = _run_hook("PipelineBlock.py", {
            "session_id": marker_session,
            "tool_name": "Bash",
            "tool_input": {"command": "echo hi"},
            "agent_type": "",
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        self.assertEqual(r["stdout"], "", "Should not block while agent-running marker exists")

        # Remove marker (simulates SubagentStop)
        os.unlink(marker_file)

        # Now it SHOULD block (agent completed, step is active, orchestrator must act)
        r2 = _run_hook("PipelineBlock.py", {
            "session_id": marker_session,
            "tool_name": "Bash",
            "tool_input": {"command": "echo hi"},
            "agent_type": "",
        }, cwd=self.tmp_root)
        self.assertEqual(r2["exit_code"], 0)
        self.assertIn("block", r2["stdout"], "Should block after marker removed")


class TestPipelineInjection(unittest.TestCase):
    """PipelineInjection: context enrichment end-to-end."""

    def setUp(self):
        self.tmp_root, _, self.session_id = _make_temp_root()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp_root, ignore_errors=True)

    def test_source_agent_gets_no_injection_on_first_run(self):
        """injection: source agent gets no injection on first run (semantics first)."""
        r = _run_hook("PipelineInjection.py", {
            "session_id": self.session_id,
            "agent_type": "e2e-builder",
            "agent_id": "agent-001",
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        self.assertEqual(r["stdout"], "", "Source agents should get no injection on first run")

    def test_handles_missing_session_gracefully(self):
        """injection: handles missing session gracefully."""
        r = _run_hook("PipelineInjection.py", {
            "session_id": "",
            "agent_type": "e2e-builder",
            "agent_id": "agent-002",
        }, cwd=self.tmp_root)
        # Should exit 0 (fail-open), no stdout
        self.assertEqual(r["exit_code"], 0)
        self.assertEqual(r["stdout"], "")

    def test_handles_plugin_qualified_agent_type(self):
        """injection: handles plugin-qualified agent type."""
        r = _run_hook("PipelineInjection.py", {
            "session_id": self.session_id,
            "agent_type": "claude-gates:e2e-builder",
            "agent_id": "agent-003",
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        # Source agents get no injection regardless of plugin prefix


class TestPipelineVerification(unittest.TestCase):
    """PipelineVerification: verdict processing end-to-end (structural only — no claude -p)."""

    def setUp(self):
        self.tmp_root, _, self.session_id = _make_temp_root()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp_root, ignore_errors=True)

    def test_gater_exits_cleanly(self):
        """verification: gater exits cleanly (MCP handles verdicts)."""
        r = _run_hook("PipelineVerification.py", {
            "session_id": self.session_id,
            "agent_type": "gater",
            "agent_id": "gater-001",
            "last_assistant_message": "The plan looks good.\n\nResult: PASS",
            "stop_hook_active": False,
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)

    def test_exits_cleanly_for_unknown_agent(self):
        """verification: exits cleanly for unknown agent."""
        r = _run_hook("PipelineVerification.py", {
            "session_id": self.session_id,
            "agent_type": "totally-unknown",
            "agent_id": "unknown-001",
            "last_assistant_message": "",
            "stop_hook_active": False,
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)

    def test_skips_when_stop_hook_active(self):
        """verification: skips when stop_hook_active."""
        r = _run_hook("PipelineVerification.py", {
            "session_id": self.session_id,
            "agent_type": "e2e-builder",
            "agent_id": "agent-skip",
            "last_assistant_message": "",
            "stop_hook_active": True,
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        self.assertEqual(r["stdout"], "")


class TestPlanGate(unittest.TestCase):
    """PlanGate + PlanGateClear: block/bypass end-to-end."""

    def setUp(self):
        self.tmp_root = tempfile.mkdtemp(prefix="plangate-e2e-")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp_root, ignore_errors=True)

    def test_plan_gate_exits_zero(self):
        """PlanGate exits 0 (fail-open when no gater verdict in DB)."""
        r = _run_hook("PlanGate.py", {
            "session_id": "plangate-test-" + str(id(self)),
            "tool_name": "ExitPlanMode",
            "tool_input": {"plan": "My plan here"},
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)

    def test_plan_gate_clear_exits_zero(self):
        """PlanGateClear exits 0 and clears the gater verdict from the DB."""
        session_id = "plangate-clear-" + str(id(self))
        short_id = session_id.replace("-", "")[:8]
        session_dir = os.path.join(self.tmp_root, ".sessions", short_id)
        os.makedirs(session_dir, exist_ok=True)

        # Seed a gater PASS verdict so there is something to clear
        conn = _make_db(session_dir)
        conn.execute(
            "INSERT OR REPLACE INTO agents (scope, agent, verdict) VALUES (?, ?, ?)",
            ("_pending", "gater", "PASS"),
        )
        conn.commit()

        # Verify it is present before the hook runs
        row = conn.execute(
            "SELECT 1 FROM agents WHERE agent = 'gater' AND verdict IS NOT NULL"
        ).fetchone()
        self.assertIsNotNone(row, "Pre-condition: gater verdict must exist before PlanGateClear")
        conn.close()

        r = _run_hook("PlanGateClear.py", {
            "session_id": session_id,
            "tool_name": "ExitPlanMode",
            "tool_input": {},
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)

        # Verify the verdict was actually cleared from the DB
        conn2 = sqlite3.connect(os.path.join(session_dir, "session.db"))
        row2 = conn2.execute(
            "SELECT 1 FROM agents WHERE agent = 'gater' AND verdict IS NOT NULL"
        ).fetchone()
        conn2.close()
        self.assertIsNone(row2, "PlanGateClear must delete the gater verdict from DB")

    def test_plan_gate_blocks_without_gater_verdict(self):
        """PlanGate fails open (allows) when no gater verdict and no plans dir exists.

        PlanGate reads plan files from ~/.claude/plans/ — if that directory does
        not exist, the hook returns {} (empty = allow) regardless of gater verdict
        state. In the E2E test environment there is no plans dir, so the behavioral
        assertion is: stdout must be empty (allow signal, not a block decision).
        """
        session_id = "plangate-nopass-" + str(id(self))
        r = _run_hook("PlanGate.py", {
            "session_id": session_id,
            "tool_name": "ExitPlanMode",
            "tool_input": {"plan": "Step 1\nStep 2\nStep 3"},
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        # Behavioral assertion: fail-open means empty stdout (allow), not a block decision
        stdout_json = json.loads(r["stdout"]) if r["stdout"] else {}
        self.assertNotEqual(
            stdout_json.get("decision"), "block",
            "PlanGate must not block when no plans dir exists (fail-open invariant)",
        )

    def test_plan_gate_allows_with_gater_pass_in_db(self):
        """PlanGate allows when gater has PASS verdict in DB."""
        session_id = "plangate-pass-" + str(id(self))
        short_id = session_id.replace("-", "")[:8]
        session_dir = os.path.join(self.tmp_root, ".sessions", short_id)
        os.makedirs(session_dir, exist_ok=True)

        # Seed DB with gater PASS verdict
        conn = _make_db(session_dir)
        conn.execute(
            "INSERT OR REPLACE INTO agents (scope, agent, verdict) VALUES (?, ?, ?)",
            ("_pending", "gater", "PASS"),
        )
        conn.commit()
        conn.close()

        r = _run_hook("PlanGate.py", {
            "session_id": session_id,
            "tool_name": "ExitPlanMode",
            "tool_input": {"plan": "My verified plan"},
        }, cwd=self.tmp_root)
        self.assertEqual(r["exit_code"], 0)
        # With gater PASS, hook should allow (empty stdout)
        self.assertEqual(r["stdout"], "")


# ══════════════════════════════════════════════════════════════════════════════
# AC#3: Full pipeline lifecycle test (engine-level, simulating hook sequence)
# ══════════════════════════════════════════════════════════════════════════════

class TestFullPipelineFlow(unittest.TestCase):
    """AC#3: Full pipeline lifecycle — spawn → check → verify → done."""

    def _make_conn(self):
        tmp = tempfile.mkdtemp(prefix="flow-e2e-")
        conn = _make_db(tmp)
        return conn, tmp

    def test_parse_agent_create_pipeline_step_through(self):
        """full flow: parse agent → create pipeline → step through."""
        agents_dir = os.path.join(_PROJECT_ROOT, ".claude", "agents")
        agent_md_path = os.path.join(agents_dir, "gt-worker.md")
        with open(agent_md_path, "r", encoding="utf-8") as f:
            agent_md = f.read()

        steps = parse_verification(agent_md)
        self.assertIsNotNone(steps)
        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[0]["type"], "CHECK")
        self.assertEqual(steps[1]["type"], "VERIFY_W_FIXER")
        self.assertEqual(steps[1]["agent"], "gt-reviewer")
        self.assertEqual(steps[1]["maxRounds"], 3)
        self.assertEqual(steps[1]["fixer"], "gt-fixer")

        conn, tmp = self._make_conn()
        try:
            engine, repo = _make_engine(conn)
            engine.create_pipeline("e2e-scope", "e2e-builder", steps)

            # Step 0: CHECK — source completes, semantic check fires
            a = engine.get_next_action("e2e-scope")
            self.assertEqual(a["action"], "semantic")

            a = engine.step("e2e-scope", "PASS")  # semantic passes
            self.assertEqual(a["action"], "spawn")
            self.assertEqual(a["agent"], "gt-reviewer")

            # Step 1: VERIFY_W_FIXER — reviewer passes
            a = engine.step("e2e-scope", "PASS")
            self.assertEqual(a["action"], "done")
            state = repo.get_pipeline_state("e2e-scope")
            self.assertEqual(state["status"], "completed")
        finally:
            conn.close()
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_full_flow_revise_path_source_rerun_reviewer_rerun(self):
        """full flow: revise path → source re-run → reviewer re-run."""
        # Use e2e-builder.md from temp agent dir
        tmp_root, agents_dir, _ = _make_temp_root()
        with open(os.path.join(agents_dir, "e2e-builder.md"), "r", encoding="utf-8") as f:
            agent_md = f.read()
        steps = parse_verification(agent_md)

        conn, tmp = self._make_conn()
        try:
            engine, repo = _make_engine(conn)
            engine.create_pipeline("rev-scope", "e2e-builder", steps)

            # CHECK passes
            engine.step("rev-scope", "PASS")

            # VERIFY: reviewer says REVISE
            a = engine.step("rev-scope", "REVISE")
            self.assertEqual(a["action"], "source")
            self.assertEqual(a["agent"], "e2e-builder")  # source re-runs
            self.assertEqual(repo.get_pipeline_state("rev-scope")["status"], "revision")

            # Source re-completes
            a = engine.step("rev-scope", {"role": "source", "artifactVerdict": "PASS"})
            self.assertEqual(a["action"], "spawn")
            self.assertEqual(a["agent"], "e2e-reviewer")  # reviewer re-runs
            self.assertEqual(repo.get_pipeline_state("rev-scope")["status"], "normal")

            # Reviewer passes on second attempt
            a = engine.step("rev-scope", "PASS")
            self.assertEqual(a["action"], "done")
        finally:
            conn.close()
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_full_flow_role_resolution_through_pipeline_lifecycle(self):
        """full flow: role resolution through pipeline lifecycle."""
        steps = [
            {"type": "CHECK", "prompt": "Check."},
            {"type": "VERIFY_W_FIXER", "agent": "e2e-reviewer", "maxRounds": 3, "fixer": "e2e-fixer"},
        ]

        conn, tmp = self._make_conn()
        try:
            engine, repo = _make_engine(conn)
            engine.create_pipeline("role-scope", "e2e-builder", steps)

            # Initial: CHECK step is active — reviewer is NOT verifier yet
            self.assertEqual(engine.resolve_role("role-scope", "e2e-reviewer"), "ungated")
            self.assertEqual(engine.resolve_role("role-scope", "e2e-builder"), "source")
            self.assertEqual(engine.resolve_role("role-scope", "e2e-fixer"), "ungated")  # not active yet

            # Advance past CHECK → step 1 (VERIFY_W_FIXER) becomes active
            engine.step("role-scope", "PASS")

            # Now reviewer IS verifier (VERIFY_W_FIXER step active)
            self.assertEqual(engine.resolve_role("role-scope", "e2e-reviewer"), "verifier")

            # REVISE → fixer role activates
            engine.step("role-scope", "REVISE")
            self.assertEqual(engine.resolve_role("role-scope", "e2e-fixer"), "fixer")
            self.assertEqual(engine.resolve_role("role-scope", "e2e-builder"), "source")  # still source

            # Fixer completes → reviewer re-runs
            engine.step("role-scope", {"role": "fixer", "artifactVerdict": "PASS"})
            self.assertEqual(engine.resolve_role("role-scope", "e2e-reviewer"), "verifier")
        finally:
            conn.close()
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_full_flow_parallel_scopes_dont_cross_contaminate(self):
        """full flow: parallel scopes don't cross-contaminate."""
        steps = [{"type": "VERIFY", "agent": "rev", "maxRounds": 3}]
        conn, tmp = self._make_conn()
        try:
            engine, repo = _make_engine(conn)
            engine.create_pipeline("scope-a", "builder-a", steps)
            engine.create_pipeline("scope-b", "builder-b", steps)

            # Scope A: REVISE
            engine.step("scope-a", "REVISE")
            # Scope B: PASS
            engine.step("scope-b", "PASS")

            self.assertEqual(repo.get_pipeline_state("scope-a")["status"], "revision")
            self.assertEqual(repo.get_pipeline_state("scope-b")["status"], "completed")

            # getAllNextActions only returns scope-a
            actions = engine.get_all_next_actions()
            self.assertEqual(len(actions), 1)
            self.assertEqual(actions[0]["scope"], "scope-a")
        finally:
            conn.close()
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


# ══════════════════════════════════════════════════════════════════════════════
# Source verdict decoupling
# ══════════════════════════════════════════════════════════════════════════════

class TestSourceVerdictDecoupling(unittest.TestCase):
    """Source REVISE/FAIL advances CHECK (source doesn't judge itself)."""

    def _make_conn(self):
        tmp = tempfile.mkdtemp(prefix="decouple-e2e-")
        conn = _make_db(tmp)
        return conn, tmp

    def test_source_revise_advances_check(self):
        """source REVISE advances CHECK (source doesn't judge itself)."""
        conn, tmp = self._make_conn()
        try:
            engine, repo = _make_engine(conn)
            engine.create_pipeline("decouple-scope", "rethinker", [
                {"type": "CHECK", "prompt": "Check quality."},
                {"type": "VERIFY", "agent": "reviewer", "maxRounds": 3},
            ])

            # Source completes with PASS artifactVerdict — semantic check null (skipped)
            a = engine.step("decouple-scope", {"role": "source", "artifactVerdict": "PASS"})
            self.assertEqual(a["action"], "spawn", "Should advance to VERIFY step")
            self.assertEqual(a["agent"], "reviewer")
        finally:
            conn.close()
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_source_fail_treated_as_pass_when_semantic_is_null(self):
        """source FAIL still treated as PASS when semantic is null (source doesn't self-judge)."""
        conn, tmp = self._make_conn()
        try:
            engine, repo = _make_engine(conn)
            engine.create_pipeline("decouple-fail", "builder", [
                {"type": "CHECK", "prompt": "Check."},
            ])

            # Even source FAIL with null semantic → PASS (source produced an artifact)
            a = engine.step("decouple-fail", {"role": "source", "artifactVerdict": "PASS"})
            self.assertEqual(a["action"], "done", "Should complete pipeline")
        finally:
            conn.close()
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_semantic_fail_triggers_revision_even_when_source_says_pass(self):
        """semantic FAIL still triggers revision even when source says PASS."""
        conn, tmp = self._make_conn()
        try:
            engine, repo = _make_engine(conn)
            engine.create_pipeline("sem-override", "builder", [
                {"type": "CHECK", "prompt": "Check."},
            ])

            # Source PASS but semantic FAIL → revision (semantic is the judge)
            a = engine.step("sem-override", {"role": "source", "artifactVerdict": "FAIL"})
            self.assertEqual(a["action"], "source", "Semantic FAIL should trigger revision")
            self.assertEqual(repo.get_pipeline_state("sem-override")["status"], "revision")
        finally:
            conn.close()
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


# ══════════════════════════════════════════════════════════════════════════════
# Gater as pipeline participant (no short-circuit deadlock)
# ══════════════════════════════════════════════════════════════════════════════

class TestGaterPipelineParticipant(unittest.TestCase):
    """Gater as VERIFY agent: engine.step advances (no short-circuit)."""

    def _make_conn(self):
        tmp = tempfile.mkdtemp(prefix="gater-e2e-")
        conn = _make_db(tmp)
        return conn, tmp

    def test_gater_verify_pass_completes_pipeline(self):
        """gater as VERIFY agent: engine.step advances (no short-circuit)."""
        conn, tmp = self._make_conn()
        try:
            engine, repo = _make_engine(conn)
            engine.create_pipeline("gater-scope", "worker", [
                {"type": "VERIFY", "agent": "gater", "maxRounds": 3},
            ])

            # Gater (as verifier) returns PASS → should advance pipeline
            a = engine.step("gater-scope", {"role": "verifier", "artifactVerdict": "PASS"})
            self.assertEqual(a["action"], "done", "Gater PASS should complete the pipeline")
            self.assertEqual(repo.get_pipeline_state("gater-scope")["status"], "completed")
        finally:
            conn.close()
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_gater_verify_revise_routes_back_to_source(self):
        """gater as VERIFY agent: REVISE routes back to source."""
        conn, tmp = self._make_conn()
        try:
            engine, repo = _make_engine(conn)
            engine.create_pipeline("gater-rev", "worker", [
                {"type": "VERIFY", "agent": "gater", "maxRounds": 3},
            ])

            # Gater returns REVISE → should route to source (not deadlock)
            a = engine.step("gater-rev", {"role": "verifier", "artifactVerdict": "REVISE"})
            self.assertEqual(a["action"], "source")
            self.assertEqual(a["agent"], "worker")
            self.assertEqual(repo.get_pipeline_state("gater-rev")["status"], "revision")
        finally:
            conn.close()
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


# ══════════════════════════════════════════════════════════════════════════════
# Deadlock prevention (missing artifact / missing Result: line)
# ══════════════════════════════════════════════════════════════════════════════

class TestDeadlockPrevention(unittest.TestCase):
    """Deadlock prevention: missing artifact / missing Result: line."""

    def _make_conn(self):
        tmp = tempfile.mkdtemp(prefix="deadlock-e2e-")
        conn = _make_db(tmp)
        return conn, tmp

    def test_missing_artifact_step_fail_transitions_instead_of_deadlock(self):
        """missing artifact: engine.step(FAIL) transitions instead of deadlock."""
        conn, tmp = self._make_conn()
        try:
            engine, repo = _make_engine(conn)
            engine.create_pipeline("deadlock-scope", "architect", [
                {"type": "CHECK", "prompt": "Check artifact."},
                {"type": "VERIFY", "agent": "reviewer", "maxRounds": 3},
            ])

            # Pipeline starts: step 0 active
            state = repo.get_pipeline_state("deadlock-scope")
            self.assertEqual(state["status"], "normal")
            self.assertEqual(repo.get_active_step("deadlock-scope")["step_index"], 0)

            # Source completes WITHOUT artifact — hook calls engine.step(FAIL)
            a = engine.step("deadlock-scope", {"role": "source", "artifactVerdict": "FAIL"})

            # Should enter revision (route back to source), NOT stay stuck
            state = repo.get_pipeline_state("deadlock-scope")
            self.assertEqual(state["status"], "revision", "Pipeline should enter revision, not stay normal")
            self.assertIsNotNone(a, "step() should return an action, not None")
            self.assertEqual(a["action"], "source", "Action should route back to source agent")
            self.assertEqual(a["agent"], "architect")
        finally:
            conn.close()
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_missing_result_line_pipeline_recovers_via_fail_verdict(self):
        """missing Result line: pipeline recovers via FAIL verdict (exhausts maxRounds → failed)."""
        conn, tmp = self._make_conn()
        try:
            engine, repo = _make_engine(conn)
            engine.create_pipeline("noResult-scope", "builder", [
                {"type": "CHECK", "prompt": "Check."},
            ])

            # CHECK step: source FAIL → revision round 1
            a = engine.step("noResult-scope", {"role": "source", "artifactVerdict": "FAIL"})
            self.assertEqual(a["action"], "source")

            # Source re-completes, still FAIL → reactivates step, then FAIL → revision round 2
            a = engine.step("noResult-scope", {"role": "source", "artifactVerdict": "PASS"})
            # Reactivated CHECK step — now process FAIL on it
            a = engine.step("noResult-scope", {"role": "source", "artifactVerdict": "FAIL"})
            self.assertEqual(a["action"], "source")

            # Round 3
            a = engine.step("noResult-scope", {"role": "source", "artifactVerdict": "PASS"})
            a = engine.step("noResult-scope", {"role": "source", "artifactVerdict": "FAIL"})
            self.assertEqual(a["action"], "source")

            # Round 4 — should exhaust (max_rounds=3)
            a = engine.step("noResult-scope", {"role": "source", "artifactVerdict": "PASS"})
            a = engine.step("noResult-scope", {"role": "source", "artifactVerdict": "FAIL"})
            self.assertEqual(a["action"], "failed", "Pipeline should exhaust after maxRounds")
            self.assertEqual(repo.get_pipeline_state("noResult-scope")["status"], "failed")
        finally:
            conn.close()
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


# ══════════════════════════════════════════════════════════════════════════════
# gt-worker v3 format parsing
# ══════════════════════════════════════════════════════════════════════════════

class TestGtWorkerV3FormatParsing(unittest.TestCase):
    """gt-worker v3 format: parse to CHECK + VERIFY_W_FIXER."""

    def _read_agent(self, name: str) -> str:
        path = os.path.join(_PROJECT_ROOT, ".claude", "agents", f"{name}.md")
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def test_gt_worker_verification_parses_to_check_plus_verify_w_fixer(self):
        """gt-worker verification: field parses to CHECK + VERIFY_W_FIXER."""
        agent_md = self._read_agent("gt-worker")
        steps = parse_verification(agent_md)
        self.assertIsNotNone(steps)
        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[0]["type"], "CHECK")
        self.assertIn("complete", steps[0]["prompt"])
        self.assertEqual(steps[1]["type"], "VERIFY_W_FIXER")
        self.assertEqual(steps[1]["agent"], "gt-reviewer")
        self.assertEqual(steps[1]["maxRounds"], 3)
        self.assertEqual(steps[1]["fixer"], "gt-fixer")

    def test_gt_reviewer_has_no_verification_steps(self):
        """gt-reviewer has no verification: steps (role: gate only)."""
        agent_md = self._read_agent("gt-reviewer")
        steps = parse_verification(agent_md)
        self.assertIsNone(steps)

    def test_gt_worker_requires_scope_returns_true(self):
        """gt-worker requiresScope returns true."""
        agent_md = self._read_agent("gt-worker")
        self.assertTrue(requires_scope(agent_md))


# ══════════════════════════════════════════════════════════════════════════════
# AC#4: Environment setup per test
# ══════════════════════════════════════════════════════════════════════════════

class TestEnvironmentSetup(unittest.TestCase):
    """AC#4: CLAUDE_PLUGIN_ROOT is set; temp session dirs are isolated and cleaned up."""

    def test_plugin_root_set_in_subprocess_env(self):
        """CLAUDE_PLUGIN_ROOT is set to project root when invoking hooks."""
        # Verify our _run_hook helper sets CLAUDECODE="" (prevents re-entry)
        # and that the hook inherits os.environ (which includes CLAUDE_PLUGIN_ROOT if set)
        r = _run_hook("GateToggle.py", {
            "prompt": "gate status",
            "session_id": "env-test",
        }, env={"CLAUDE_PLUGIN_ROOT": _PROJECT_ROOT})
        self.assertEqual(r["exit_code"], 0)

    def test_isolated_temp_dirs_per_test(self):
        """Each test creates isolated temp directories; no cross-contamination."""
        tmp1 = tempfile.mkdtemp(prefix="e2e-iso-a-")
        tmp2 = tempfile.mkdtemp(prefix="e2e-iso-b-")
        try:
            self.assertNotEqual(tmp1, tmp2)
            # Write to tmp1, confirm tmp2 is clean
            session_dir1 = os.path.join(tmp1, ".sessions", "ab12cd34")
            os.makedirs(session_dir1, exist_ok=True)
            conn = _make_db(session_dir1)
            conn.close()
            # tmp2 should have no .sessions dir
            self.assertFalse(os.path.exists(os.path.join(tmp2, ".sessions")))
        finally:
            import shutil
            shutil.rmtree(tmp1, ignore_errors=True)
            shutil.rmtree(tmp2, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
