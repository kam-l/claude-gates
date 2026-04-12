"""pytest fixtures: db, repo, engine, tmp_session_dir."""
from __future__ import annotations

import os
import sqlite3
import sys

import pytest

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates.repository import PipelineRepository
from src.claude_gates.engine import PipelineEngine


@pytest.fixture
def tmp_session_dir(tmp_path) -> str:
    return str(tmp_path)


@pytest.fixture
def db(tmp_path) -> sqlite3.Connection:
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
    PipelineRepository.init_schema(db)
    return PipelineRepository(db)


@pytest.fixture
def engine(repo) -> PipelineEngine:
    return PipelineEngine(repo)
