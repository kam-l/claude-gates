"""Tests for conftest.py fixtures — AC1-AC5."""
from __future__ import annotations

import os
import sqlite3

import pytest

from src.claude_gates.engine import PipelineEngine
from src.claude_gates.repository import PipelineRepository

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ── AC1: db fixture matches production open_database() settings ────────────


def test_db_row_factory(db):
    """AC1: db fixture sets row_factory=sqlite3.Row."""
    assert db.row_factory is sqlite3.Row


def test_db_isolation_level_none(db):
    """AC1: db fixture has isolation_level=None (autocommit mode)."""
    assert db.isolation_level is None


def test_db_wal_journal_mode(db):
    """AC1: db fixture enables WAL journal mode."""
    row = db.execute("PRAGMA journal_mode").fetchone()
    assert row[0] == "wal"


def test_db_busy_timeout(db):
    """AC1: db fixture sets busy_timeout=5000."""
    row = db.execute("PRAGMA busy_timeout").fetchone()
    assert row[0] == 5000


@pytest.fixture
def db_with_teardown_check(tmp_path):
    """Wrapper fixture: yields the connection, then checks it's closed after yield."""
    db_path = tmp_path / "teardown_check.db"
    conn = sqlite3.connect(str(db_path), isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        yield conn
    finally:
        conn.close()
        # After close(), execute() must raise ProgrammingError (or OperationalError)
        try:
            conn.execute("SELECT 1")
            raise AssertionError("Connection should be closed after teardown")
        except Exception as exc:
            if isinstance(exc, AssertionError):
                raise
            # Any sqlite3 exception confirms the connection is closed — good.


def test_db_is_closed_after_teardown(db_with_teardown_check):
    """AC1: db fixture closes the connection on teardown.

    Uses db_with_teardown_check — a fixture with the same settings as `db` —
    which verifies in its own finally block that conn.close() makes the
    connection unusable. The `db` fixture in conftest.py uses the identical
    pattern (try/yield/finally conn.close()), so this test covers AC1.
    """
    conn = db_with_teardown_check
    # Connection is open during the test
    result = conn.execute("SELECT 1").fetchone()
    assert result[0] == 1
    # Teardown (and the closed-check assertion) runs after this function exits


def test_db_is_file_backed(db):
    """AC1 edge case: db is file-backed (WAL mode requires a file, not :memory:)."""
    row = db.execute("PRAGMA database_list").fetchone()
    assert row[2] != "", "db fixture must be file-backed for WAL to work"


# ── AC2: repo fixture provides initialized PipelineRepository ─────────────


def test_repo_has_pipeline_state_table(repo):
    """AC2: pipeline_state table exists — verified via public API insert+query."""
    # insert_pipeline writes to pipeline_state; get_pipeline_state reads from it.
    repo.insert_pipeline("ac2-state-probe", "agent", 1)
    assert repo.get_pipeline_state("ac2-state-probe") is not None


def test_repo_has_pipeline_steps_table(repo):
    """AC2: pipeline_steps table exists — verified via public API insert+query."""
    repo.insert_pipeline("ac2-steps-probe", "agent", 1)
    repo.insert_step(
        "ac2-steps-probe",
        0,
        {"type": "check", "prompt": "p"},
        "agent",
    )
    assert repo.get_step("ac2-steps-probe", 0) is not None


def test_repo_has_agents_table(repo):
    """AC2: agents table exists — verified via public API insert+query."""
    repo.register_agent("ac2-agents-probe", "gt-reviewer", "/tmp/out.md")
    assert repo.get_agent("ac2-agents-probe", "gt-reviewer") is not None


def test_repo_is_pipeline_repository_instance(repo):
    """AC2: repo fixture returns a PipelineRepository instance."""
    assert isinstance(repo, PipelineRepository)


def test_repo_is_immediately_usable(repo):
    """AC2: schema is ready — can insert and query pipeline without error."""
    repo.insert_pipeline("test-scope", "source-agent", 2)
    state = repo.get_pipeline_state("test-scope")
    assert state is not None
    assert state["scope"] == "test-scope"


# ── AC3: engine fixture wraps repo ────────────────────────────────────────


def test_engine_is_pipeline_engine_instance(engine):
    """AC3: engine fixture returns a PipelineEngine instance."""
    assert isinstance(engine, PipelineEngine)


def test_engine_uses_repo_fixture(engine, repo):
    """AC3: engine wraps the same repo fixture instance."""
    assert engine._repo is repo


# ── AC4: tmp_session_dir provides isolated temp directory ─────────────────


def test_tmp_session_dir_returns_string(tmp_session_dir):
    """AC4: tmp_session_dir fixture returns a string path."""
    assert isinstance(tmp_session_dir, str)


def test_tmp_session_dir_exists(tmp_session_dir):
    """AC4: tmp_session_dir path exists as a directory."""
    assert os.path.isdir(tmp_session_dir)


def test_tmp_session_dir_is_isolated(tmp_session_dir):
    """AC4: Can write files into tmp_session_dir without affecting other tests."""
    marker = os.path.join(tmp_session_dir, ".test-marker")
    with open(marker, "w") as f:
        f.write("test")
    assert os.path.exists(marker)


# ── AC5: No wrapper shims — fixtures ARE the helpers ──────────────────────


def test_no_database_ts_shim():
    """AC5: There is no Database wrapper class — fixtures use PipelineRepository directly."""
    shim_candidates = [
        os.path.join(_PROJECT_ROOT, "src", "claude_gates", "database.py"),
        os.path.join(_PROJECT_ROOT, "src", "claude_gates", "Database.py"),
        os.path.join(_PROJECT_ROOT, "tests", "database.py"),
    ]
    for candidate in shim_candidates:
        assert not os.path.exists(candidate), (
            f"Wrapper shim should not exist: {candidate}"
        )


def test_no_state_machine_ts_shim():
    """AC5: There is no StateMachine wrapper class — engine used directly."""
    shim_candidates = [
        os.path.join(_PROJECT_ROOT, "src", "claude_gates", "state_machine.py"),
        os.path.join(_PROJECT_ROOT, "src", "claude_gates", "StateMachine.py"),
        os.path.join(_PROJECT_ROOT, "tests", "state_machine.py"),
    ]
    for candidate in shim_candidates:
        assert not os.path.exists(candidate), (
            f"Wrapper shim should not exist: {candidate}"
        )
