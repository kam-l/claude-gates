"""
web_launcher.py — SessionStart hook: idempotent launch of web dashboard server.

Probes /health before spawning. Writes PID file. Platform-aware detach.
Always fail-open (returns {}).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from urllib.request import urlopen
from urllib.error import URLError

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_PLUGIN_ROOT: str = os.environ.get(
    "CLAUDE_PLUGIN_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
)

PORT: int = int(os.environ.get("CLAUDE_GATES_PORT", "64735"))

PID_FILE: str = os.path.join(os.getcwd(), ".sessions", ".webui.pid")

SCRIPT: str = os.path.join(_PLUGIN_ROOT, "scripts", "WebServer.py")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def launch(data: dict) -> dict:
    """SessionStart handler — idempotently launch the web dashboard server."""
    try:
        if _health_check(PORT):
            return {}

        _clean_stale_pid()

        sessions_dir = os.path.dirname(PID_FILE)
        os.makedirs(sessions_dir, exist_ok=True)

        child = _spawn_server()

        if child.pid:
            with open(PID_FILE, "w") as f:
                f.write(str(child.pid))
    except Exception:
        pass  # fail-open

    return {}


def _health_check(port: int) -> bool:
    """HTTP GET http://127.0.0.1:{port}/health with 1-second timeout.

    Returns True only if response JSON has app == "claude-gates".
    """
    url = f"http://127.0.0.1:{port}/health"
    try:
        with urlopen(url, timeout=1) as resp:
            body = resp.read()
        data = json.loads(body)
        return data.get("app") == "claude-gates"
    except Exception:
        return False


def _clean_stale_pid() -> None:
    """Remove PID file if the recorded process is dead.

    Uses os.kill(pid, 0) to probe liveness.
    - OSError with errno == ESRCH (no such process) => dead, delete file.
    - PermissionError => process alive (Windows behavior), leave file.
    - No PID file => no-op.
    """
    try:
        with open(PID_FILE) as f:
            pid = int(f.read().strip())
    except (FileNotFoundError, ValueError):
        return

    try:
        os.kill(pid, 0)
        # Process is alive — health check should have caught this; leave the file.
    except PermissionError:
        # Windows raises PermissionError when process is alive but not owned.
        # Treat as alive.
        pass
    except OSError:
        # Process is dead — remove stale PID file.
        try:
            os.unlink(PID_FILE)
        except FileNotFoundError:
            pass


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _spawn_server() -> subprocess.Popen:
    """Spawn WebServer.py as a detached background process."""
    cmd = [sys.executable, SCRIPT]
    env = {**os.environ, "CLAUDE_GATES_PORT": str(PORT)}

    if sys.platform == "win32":
        return subprocess.Popen(
            cmd,
            cwd=os.getcwd(),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=(
                subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
            ),
        )
    else:
        return subprocess.Popen(
            cmd,
            cwd=os.getcwd(),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
