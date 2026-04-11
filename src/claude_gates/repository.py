from __future__ import annotations

import sqlite3
import time
from typing import Any, Callable, Dict, List, Optional, TypeVar

from claude_gates.types import StepStatus

T = TypeVar("T")

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS pipeline_steps (
  scope         TEXT NOT NULL,
  step_index    INTEGER NOT NULL,
  step_type     TEXT NOT NULL,
  prompt        TEXT,
  command       TEXT,
  allowed_tools TEXT,
  agent         TEXT,
  max_rounds    INTEGER DEFAULT 3,
  fixer         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  round         INTEGER NOT NULL DEFAULT 0,
  source_agent  TEXT NOT NULL,
  PRIMARY KEY (scope, step_index)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_steps_status ON pipeline_steps(status);

CREATE TABLE IF NOT EXISTS pipeline_state (
  scope          TEXT PRIMARY KEY,
  source_agent   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'normal',
  current_step   INTEGER NOT NULL DEFAULT 0,
  revision_step  INTEGER,
  total_steps    INTEGER NOT NULL,
  trace_id       TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  scope          TEXT NOT NULL,
  agent          TEXT NOT NULL,
  outputFilepath TEXT,
  verdict        TEXT,
  "check"        TEXT,
  round          INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, agent)
);

CREATE TABLE IF NOT EXISTS edits (
  filepath TEXT PRIMARY KEY,
  lines    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tool_history (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL
);
"""

_MAX_TOOL_HISTORY = 10
_TRANSACT_MAX_RETRIES = 3
_TRANSACT_RETRY_DELAY = 0.05  # seconds between retries


class PipelineRepository:
    """Python port of PipelineRepository.ts + GateRepository.ts.

    Single class owning all pipeline, agent, gate, edit, and tool-history
    CRUD operations against a shared SQLite session database.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # ── Schema ─────────────────────────────────────────────────────────

    @staticmethod
    def init_schema(conn: sqlite3.Connection) -> None:
        """Create all 5 tables using CREATE TABLE IF NOT EXISTS.

        Uses executescript() for multi-statement DDL (AC5).
        No trim_history trigger — trimming is handled in Python (AC4).
        """
        conn.executescript(_SCHEMA_SQL)

    # ── Pipeline CRUD ──────────────────────────────────────────────────

    def insert_pipeline(self, scope: str, source_agent: str, total_steps: int) -> None:
        self._conn.execute(
            "INSERT INTO pipeline_state (scope, source_agent, status, current_step, total_steps) "
            "VALUES (?, ?, 'normal', 0, ?)",
            (scope, source_agent, total_steps),
        )

    def insert_step(
        self,
        scope: str,
        step_index: int,
        step: dict,
        source_agent: str,
    ) -> None:
        """Insert a verification step.

        `step` is a VerificationStep dict with keys: type, prompt, agent,
        maxRounds, fixer (depending on step type). Mirrors TS insertStep signature.
        """
        initial_status = StepStatus.Active if step_index == 0 else StepStatus.Pending
        self._conn.execute(
            "INSERT INTO pipeline_steps "
            "(scope, step_index, step_type, prompt, command, allowed_tools, agent, "
            "max_rounds, fixer, status, round, source_agent) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
            (
                scope,
                step_index,
                step.get("type"),
                step.get("prompt"),
                step.get("command"),
                step.get("allowed_tools"),
                step.get("agent"),
                step.get("maxRounds", 3),
                step.get("fixer"),
                initial_status,
                source_agent,
            ),
        )

    def pipeline_exists(self, scope: str) -> bool:
        cursor = self._conn.execute(
            "SELECT 1 FROM pipeline_state WHERE scope = ? LIMIT 1", (scope,)
        )
        return cursor.fetchone() is not None

    def get_step(self, scope: str, step_index: int) -> Optional[Dict[str, Any]]:
        cursor = self._conn.execute(
            "SELECT * FROM pipeline_steps WHERE scope = ? AND step_index = ?",
            (scope, step_index),
        )
        row = cursor.fetchone()
        return dict(row) if row is not None else None

    def get_active_step(self, scope: str) -> Optional[Dict[str, Any]]:
        cursor = self._conn.execute(
            "SELECT * FROM pipeline_steps WHERE scope = ? AND status = 'active' LIMIT 1",
            (scope,),
        )
        row = cursor.fetchone()
        return dict(row) if row is not None else None

    def get_step_by_status(self, scope: str, status: str) -> Optional[Dict[str, Any]]:
        cursor = self._conn.execute(
            "SELECT * FROM pipeline_steps WHERE scope = ? AND status = ? "
            "ORDER BY step_index LIMIT 1",
            (scope, status),
        )
        row = cursor.fetchone()
        return dict(row) if row is not None else None

    def get_steps(self, scope: str) -> List[Dict[str, Any]]:
        cursor = self._conn.execute(
            "SELECT * FROM pipeline_steps WHERE scope = ? ORDER BY step_index", (scope,)
        )
        return [dict(row) for row in cursor.fetchall()]

    def get_pipeline_state(self, scope: str) -> Optional[Dict[str, Any]]:
        cursor = self._conn.execute(
            "SELECT * FROM pipeline_state WHERE scope = ?", (scope,)
        )
        row = cursor.fetchone()
        return dict(row) if row is not None else None

    def update_step_status(
        self, scope: str, step_index: int, status: str, round: Optional[int] = None
    ) -> None:
        if round is not None:
            self._conn.execute(
                "UPDATE pipeline_steps SET status = ?, round = ? "
                "WHERE scope = ? AND step_index = ?",
                (status, round, scope, step_index),
            )
        else:
            self._conn.execute(
                "UPDATE pipeline_steps SET status = ? WHERE scope = ? AND step_index = ?",
                (status, scope, step_index),
            )

    _ALLOWED_STATE_KEYS = frozenset({
        "status", "current_step", "revision_step", "total_steps", "trace_id",
        "source_agent",
    })

    def update_pipeline_state(self, scope: str, updates: Dict[str, Any]) -> None:
        if not updates:
            return
        bad_keys = set(updates) - self._ALLOWED_STATE_KEYS
        if bad_keys:
            raise ValueError(f"Invalid pipeline_state keys: {bad_keys}")
        sets = ", ".join(f"{key} = ?" for key in updates)
        vals = list(updates.values()) + [scope]
        self._conn.execute(
            f"UPDATE pipeline_state SET {sets} WHERE scope = ?", vals
        )

    def delete_pipeline(self, scope: str) -> None:
        self._conn.execute("DELETE FROM pipeline_steps WHERE scope = ?", (scope,))
        self._conn.execute("DELETE FROM pipeline_state WHERE scope = ?", (scope,))

    def get_active_pipelines(self) -> List[Dict[str, Any]]:
        cursor = self._conn.execute(
            "SELECT * FROM pipeline_state WHERE status IN ('normal', 'revision')"
        )
        return [dict(row) for row in cursor.fetchall()]

    def has_non_passed_steps(self, scope: str) -> bool:
        cursor = self._conn.execute(
            "SELECT 1 FROM pipeline_steps WHERE scope = ? AND status != 'passed' LIMIT 1",
            (scope,),
        )
        return cursor.fetchone() is not None

    # ── Agent CRUD ─────────────────────────────────────────────────────

    def register_agent(self, scope: str, agent: str, output_filepath: str) -> None:
        self._conn.execute(
            "INSERT INTO agents (scope, agent, outputFilepath) VALUES (?, ?, ?) "
            "ON CONFLICT(scope, agent) DO UPDATE SET outputFilepath = excluded.outputFilepath",
            (scope, agent, output_filepath),
        )

    def set_verdict(
        self,
        scope: str,
        agent: str,
        verdict: Optional[str],
        round: int,
        check: Optional[str] = None,
    ) -> None:
        """UPDATE verdict for an existing agent row (must be pre-registered via register_agent).

        This is a bare UPDATE — row must already exist. For the gate/MCP path
        where no prior register_agent is called, use upsert_verdict() instead.
        """
        if check is not None:
            self._conn.execute(
                "UPDATE agents SET verdict = ?, \"check\" = ?, round = ? "
                "WHERE scope = ? AND agent = ?",
                (verdict, check, round, scope, agent),
            )
        else:
            self._conn.execute(
                "UPDATE agents SET verdict = ?, round = ? "
                "WHERE scope = ? AND agent = ?",
                (verdict, round, scope, agent),
            )

    def get_agent(self, scope: str, agent: str) -> Optional[Dict[str, Any]]:
        cursor = self._conn.execute(
            "SELECT * FROM agents WHERE scope = ? AND agent = ?", (scope, agent)
        )
        row = cursor.fetchone()
        return dict(row) if row is not None else None

    def is_cleared(self, scope: str, agent: str) -> bool:
        cursor = self._conn.execute(
            "SELECT 1 FROM agents WHERE scope = ? AND agent = ?", (scope, agent)
        )
        return cursor.fetchone() is not None

    def find_agent_scope(self, agent: str) -> Optional[str]:
        cursor = self._conn.execute(
            """SELECT a.scope FROM agents a
               LEFT JOIN pipeline_state p ON a.scope = p.scope
               WHERE a.agent = ? AND a.scope != '_meta' AND a.scope != '_pending'
               ORDER BY
                 (CASE WHEN p.status IN ('normal','revision') THEN 0 ELSE 1 END),
                 (CASE WHEN a.verdict IS NULL THEN 1 ELSE 0 END) DESC,
                 a.rowid DESC
               LIMIT 1""",
            (agent,),
        )
        row = cursor.fetchone()
        return row["scope"] if row is not None else None

    def get_pending(self, agent: str) -> Optional[Dict[str, str]]:
        cursor = self._conn.execute(
            "SELECT scope, outputFilepath FROM agents WHERE agent = ? AND scope = '_pending' LIMIT 1",
            (agent,),
        )
        row = cursor.fetchone()
        return dict(row) if row is not None else None

    # ── Gate methods (from GateRepository) ────────────────────────────

    def get_attempts(self, scope: str, agent: str) -> int:
        cursor = self._conn.execute(
            "SELECT attempts FROM agents WHERE scope = ? AND agent = ?", (scope, agent)
        )
        row = cursor.fetchone()
        return row["attempts"] if row is not None else 0

    def incr_attempts(self, scope: str, agent: str) -> None:
        self._conn.execute(
            "INSERT INTO agents (scope, agent, attempts) VALUES (?, ?, 1) "
            "ON CONFLICT(scope, agent) DO UPDATE SET attempts = attempts + 1",
            (scope, agent),
        )

    def reset_attempts(self, scope: str, agent: str) -> None:
        self._conn.execute(
            "INSERT INTO agents (scope, agent, attempts) VALUES (?, ?, 0) "
            "ON CONFLICT(scope, agent) DO UPDATE SET attempts = 0",
            (scope, agent),
        )

    def upsert_verdict(self, scope: str, agent: str, verdict: str, round: int) -> None:
        """Gate-pattern upsert from GateRepository.setVerdict.

        INSERT ON CONFLICT — no prior register_agent required.
        Distinct from set_verdict: this is the MCP/gate path; both are preserved.
        """
        self._conn.execute(
            "INSERT INTO agents (scope, agent, verdict, round) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(scope, agent) DO UPDATE SET "
            "verdict = excluded.verdict, round = excluded.round",
            (scope, agent, verdict, round),
        )

    # ── Edit tracking ──────────────────────────────────────────────────

    def add_edit(self, filepath: str, lines: int = 0) -> None:
        self._conn.execute(
            "INSERT INTO edits (filepath, lines) VALUES (?, ?) "
            "ON CONFLICT(filepath) DO UPDATE SET lines = lines + excluded.lines",
            (filepath, lines),
        )

    def get_edits(self) -> List[str]:
        cursor = self._conn.execute("SELECT filepath FROM edits")
        return [row["filepath"] for row in cursor.fetchall()]

    def get_edit_counts(self) -> Dict[str, int]:
        cursor = self._conn.execute(
            "SELECT COUNT(*) as files, COALESCE(SUM(lines), 0) as lines FROM edits"
        )
        row = cursor.fetchone()
        return {"files": row["files"], "lines": row["lines"]}

    # ── Tool history ───────────────────────────────────────────────────

    def add_tool_hash(self, hash: str) -> None:  # noqa: A002
        """Insert hash and trim to last 10 rows in Python (AC4 — no trigger)."""
        self._conn.execute("INSERT INTO tool_history (hash) VALUES (?)", (hash,))
        # Keep only last 10 rows — delete anything older than the 10th most recent
        self._conn.execute(
            "DELETE FROM tool_history WHERE id <= ("
            "  SELECT id FROM tool_history ORDER BY id DESC LIMIT 1 OFFSET ?"
            ")",
            (_MAX_TOOL_HISTORY,),
        )

    def get_last_n_hashes(self, n: int) -> List[str]:
        cursor = self._conn.execute(
            "SELECT hash FROM tool_history ORDER BY id DESC LIMIT ?", (n,)
        )
        return [row["hash"] for row in cursor.fetchall()]

    # ── Trace support ──────────────────────────────────────────────────

    def get_trace_id(self, scope: str) -> Optional[str]:
        cursor = self._conn.execute(
            "SELECT trace_id FROM pipeline_state WHERE scope = ?", (scope,)
        )
        row = cursor.fetchone()
        return row["trace_id"] if row is not None else None

    def set_trace_id(self, scope: str, trace_id: str) -> None:
        self._conn.execute(
            "UPDATE pipeline_state SET trace_id = ? WHERE scope = ?", (trace_id, scope)
        )

    # ── Transaction helper ─────────────────────────────────────────────

    @staticmethod
    def transact(conn: sqlite3.Connection, fn: Callable[[], T]) -> T:
        """Execute fn inside a BEGIN IMMEDIATE transaction.

        AC2: Retries up to _TRANSACT_MAX_RETRIES times on SQLITE_BUSY before
        raising. busy_timeout=5000ms is the first line of defence; this retry
        loop is a safety net.
        """
        last_err: Optional[sqlite3.OperationalError] = None
        for attempt in range(_TRANSACT_MAX_RETRIES):
            # Only retry on lock failure from BEGIN IMMEDIATE itself
            try:
                conn.execute("BEGIN IMMEDIATE")
            except sqlite3.OperationalError as exc:
                last_err = exc
                if "locked" in str(exc).lower() or "busy" in str(exc).lower():
                    if attempt < _TRANSACT_MAX_RETRIES - 1:
                        time.sleep(_TRANSACT_RETRY_DELAY)
                    continue
                raise

            # BEGIN succeeded — run fn, commit or rollback
            try:
                result = fn()
                conn.execute("COMMIT")
                return result
            except Exception:
                try:
                    conn.execute("ROLLBACK")
                except Exception:
                    pass  # best-effort rollback
                raise

        # All retries exhausted
        assert last_err is not None
        raise last_err
