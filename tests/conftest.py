"""pytest fixtures replacing TS Database.ts and StateMachine.ts test helpers.

Fixtures:
  - tmp_session_dir  temporary directory for session filesystem operations
  - db               SQLite connection matching production open_database() settings
  - repo             initialized PipelineRepository (schema applied, ready to use)
  - engine           PipelineEngine wrapping the repo fixture

Note: WAL journal mode requires a file-backed database (not :memory:), so `db`
uses tmp_path / "session.db" rather than an in-memory connection.
"""
from __future__ import annotations

import os
import sqlite3
import sys

import pytest

# Ensure the project root is on sys.path so imports work when pytest is run
# from any directory.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates.repository import PipelineRepository
from src.claude_gates.engine import PipelineEngine


@pytest.fixture
def tmp_session_dir(tmp_path) -> str:
    """Provide an isolated temporary directory for session filesystem operations.

    Uses pytest's built-in tmp_path fixture so cleanup is automatic.
    Returns the directory as a string path (matching production path APIs).
    """
    return str(tmp_path)


@pytest.fixture
def db(tmp_path) -> sqlite3.Connection:
    """Provide a file-backed SQLite connection matching production open_database().

    Settings applied:
      - row_factory = sqlite3.Row  (column access by name)
      - isolation_level = None     (autocommit — matches open_database)
      - PRAGMA journal_mode=WAL    (requires file-backed DB)
      - PRAGMA busy_timeout=5000   (5 s wait on lock)

    Connection is closed on teardown.
    """
    db_path = tmp_path / "session.db"
    conn = sqlite3.connect(str(db_path), isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture
def repo(db) -> PipelineRepository:
    """Provide an initialized PipelineRepository ready for immediate use.

    Calls PipelineRepository.init_schema(conn) to create all tables, then
    returns PipelineRepository(conn).  No wrapper shim — tests call the
    production class directly (replaces Database.ts).
    """
    PipelineRepository.init_schema(db)
    return PipelineRepository(db)


@pytest.fixture
def engine(repo) -> PipelineEngine:
    """Provide a PipelineEngine wrapping the repo fixture.

    Returns PipelineEngine(repo) — tests call production class directly
    (replaces StateMachine.ts).
    """
    return PipelineEngine(repo)
