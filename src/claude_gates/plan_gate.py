"""
ClaudeGates — plan_gate.py

Ports PlanGate.ts (PreToolUse:ExitPlanMode) and PlanGateClear.ts
(PostToolUse:ExitPlanMode) into two functions.

Fail-open: any unexpected exception returns {}.
"""

import os
import re
import sys

from claude_gates.session import is_gate_disabled, get_session_dir, open_database
from claude_gates.messaging import block, info, log
from claude_gates.repository import PipelineRepository

TRIVIAL_LINE_LIMIT = 20
MAX_ATTEMPTS = 3


def on_exit_plan_mode(data: dict) -> dict:
    """PreToolUse:ExitPlanMode handler.

    Returns {} to allow, or block dict to block.
    Fail-open on any error.
    """
    try:
        # 1. Gate disabled → allow
        if is_gate_disabled():
            return {}

        # 2. No session_id → allow
        session_id = data.get("session_id") or ""
        if not session_id:
            return {}

        session_dir = get_session_dir(session_id)

        # 3. Check SQLite for gater PASS/CONVERGED verdict → allow
        gater_verified = False
        conn = None
        try:
            conn = open_database(session_dir)
            PipelineRepository.init_schema(conn)
            cursor = conn.execute(
                "SELECT 1 FROM agents WHERE agent = 'gater' "
                "AND verdict IN ('PASS','CONVERGED') LIMIT 1"
            )
            gater_verified = cursor.fetchone() is not None
        except Exception:
            pass
        finally:
            if conn is not None:
                conn.close()
                conn = None

        if gater_verified:
            return {}

        # 4. Resolve plans dir — USERPROFILE takes priority (Windows), then HOME
        home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or ""
        plans_dir = os.path.join(home, ".claude", "plans")

        # 5. No plans dir → fail-open
        if not os.path.isdir(plans_dir):
            return {}

        # Collect .md files that are NOT agent plans (filter out -agent- in name)
        try:
            entries = os.listdir(plans_dir)
        except OSError:
            return {}

        plan_files = []
        for fname in entries:
            if not fname.endswith(".md"):
                continue
            if re.search(r"-agent-", fname):
                continue
            fpath = os.path.join(plans_dir, fname)
            try:
                mtime = os.stat(fpath).st_mtime
                plan_files.append((fname, mtime))
            except OSError:
                pass

        # 6. No plans → allow
        if not plan_files:
            return {}

        # Sort by mtime descending — most recent first
        plan_files.sort(key=lambda x: x[1], reverse=True)
        most_recent_name, _ = plan_files[0]
        plan_path = os.path.join(plans_dir, most_recent_name)

        # 7. Trivial plan (<=TRIVIAL_LINE_LIMIT lines) → allow
        try:
            with open(plan_path, "r", encoding="utf-8", errors="replace") as f:
                lines = len(f.read().split("\n"))
        except OSError:
            return {}

        if lines <= TRIVIAL_LINE_LIMIT:
            return {}

        # 8. Attempt tracking — safety valve after MAX_ATTEMPTS
        safety_valve = False
        conn = None
        try:
            conn = open_database(session_dir)
            PipelineRepository.init_schema(conn)
            repo = PipelineRepository(conn)
            repo.incr_attempts("_system", "plan-gate")
            attempts = repo.get_attempts("_system", "plan-gate")
            if attempts >= MAX_ATTEMPTS:
                repo.reset_attempts("_system", "plan-gate")
                safety_valve = True
        except Exception:
            pass
        finally:
            if conn is not None:
                conn.close()

        if safety_valve:
            sys.stderr.write("[ClaudeGates] Safety valve activated.\n")
            return info(
                "\u26a0\ufe0f",
                f'"{most_recent_name}" bypassed plan-gate safety valve after '
                f"{MAX_ATTEMPTS} attempts. Verification skipped.",
            )

        # 9. Block
        reason = (
            f'"{most_recent_name}" ({lines} lines) unverified. '
            f"Spawn claude-gates:gater with scope=verify-plan."
        )
        return block("\U0001f510", reason)

    except Exception:
        return {}  # fail-open


def on_clear(data: dict) -> dict:
    """PostToolUse:ExitPlanMode handler.

    Clears all gater verdicts so the next plan requires fresh verification.
    Fail-open.
    """
    try:
        # 1. Gate disabled → allow
        if is_gate_disabled():
            return {}

        # 2. No session_id → allow
        session_id = data.get("session_id") or ""
        if not session_id:
            return {}

        session_dir = get_session_dir(session_id)

        # 3. DELETE gater verdicts (non-null) from agents table
        conn = None
        try:
            conn = open_database(session_dir)
            PipelineRepository.init_schema(conn)
            conn.execute(
                "DELETE FROM agents WHERE agent = 'gater' AND verdict IS NOT NULL"
            )
        except Exception:
            pass
        finally:
            if conn is not None:
                conn.close()

        return {}

    except Exception:
        return {}  # fail-open
