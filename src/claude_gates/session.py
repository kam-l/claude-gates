import os
import shutil
import sqlite3
import sys
import time

MAX_AGE_DAYS = 7
MAX_AGE_SECONDS = MAX_AGE_DAYS * 24 * 60 * 60


def open_database(session_dir: str) -> sqlite3.Connection:
    db_path = os.path.join(session_dir, "session.db")
    conn = sqlite3.connect(db_path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def get_session_dir(session_id: str) -> str:
    short_id = session_id.replace("-", "")[:8]
    session_dir = os.path.join(os.getcwd(), ".sessions", short_id)
    os.makedirs(session_dir, exist_ok=True)
    return session_dir.replace("\\", "/")


def agent_running_marker(session_dir: str, scope: str) -> str:
    marker = os.path.join(session_dir, f".running-{scope}")
    return marker.replace("\\", "/")


def gate_disabled_marker() -> str:
    marker = os.path.join(os.getcwd(), ".sessions", ".gate-disabled")
    return marker.replace("\\", "/")


def is_gate_disabled() -> bool:
    try:
        return os.path.exists(gate_disabled_marker())
    except Exception:
        return False


def set_gate_disabled(disabled: bool) -> None:
    marker = gate_disabled_marker()
    if disabled:
        os.makedirs(os.path.dirname(marker), exist_ok=True)
        with open(marker, "w") as f:
            f.write("")
    else:
        try:
            os.unlink(marker)
        except FileNotFoundError:
            pass


def cleanup() -> None:
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or ""
    sessions_dirs = [
        os.path.join(os.getcwd(), ".sessions"),
        os.path.join(home, ".claude", "sessions"),
    ]

    now = time.time()
    pruned = 0

    for sessions_dir in sessions_dirs:
        if not os.path.isdir(sessions_dir):
            continue

        try:
            entries = os.listdir(sessions_dir)
        except OSError:
            continue

        for entry in entries:
            dir_path = os.path.join(sessions_dir, entry)
            if not os.path.isdir(dir_path):
                continue

            db_path = os.path.join(dir_path, "session.db")
            if not os.path.exists(db_path):
                continue

            try:
                mtime = os.stat(db_path).st_mtime
                if now - mtime > MAX_AGE_SECONDS:
                    shutil.rmtree(dir_path)
                    pruned += 1
            except Exception:
                pass  # best-effort: skip on permission/lock errors

    if pruned > 0:
        sys.stderr.write(
            f"[ClaudeGates] Pruned {pruned} session(s) older than {MAX_AGE_DAYS} days.\n"
        )
