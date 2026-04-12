"""
pip install SessionStart hook — installs optional dependencies to CLAUDE_PLUGIN_DATA/pylib.

Replaces the npm install hook. Uses hash-based cache invalidation (keyed on
plugin.json version) to skip reinstall when nothing has changed.

Usage (SessionStart hook command):
    python3 "${CLAUDE_PLUGIN_ROOT}/src/claude_gates/install_deps.py"

Design:
- Cache key: plugin.json version string. Version bump → cache miss → reinstall.
- Install target: ${CLAUDE_PLUGIN_DATA}/pylib (PEP 668 safe, no system pollution).
- hook_runner prepends pylib to sys.path so imports resolve at runtime.
- Fail-open: any failure exits 0. Removes .deps-hash so next session retries.
- pip fallback: if pip not on PATH, tries python3 -m pip.
- CLAUDE_PLUGIN_DATA not set → skips install entirely (no target dir).
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import traceback

DEPS_HASH_FILENAME = ".deps-hash"
PACKAGES = ["mcp", "langfuse"]


def compute_hash(version: str) -> str:
    """Return a stable hash of the version string (cache key)."""
    return hashlib.sha256(version.encode("utf-8")).hexdigest()


def is_cache_hit(plugin_data: str, version: str) -> bool:
    """Return True if .deps-hash matches the current version hash."""
    hash_file = os.path.join(plugin_data, DEPS_HASH_FILENAME)
    if not os.path.exists(hash_file):
        return False
    try:
        with open(hash_file) as f:
            stored = f.read().strip()
        return stored == compute_hash(version)
    except OSError:
        return False


def write_cache(plugin_data: str, version: str) -> None:
    """Write current version hash to .deps-hash."""
    hash_file = os.path.join(plugin_data, DEPS_HASH_FILENAME)
    with open(hash_file, "w") as f:
        f.write(compute_hash(version))


def remove_cache(plugin_data: str) -> None:
    """Remove .deps-hash so next session retries the install."""
    hash_file = os.path.join(plugin_data, DEPS_HASH_FILENAME)
    try:
        os.remove(hash_file)
    except FileNotFoundError:
        pass


def _build_pip_command(plugin_data: str) -> list:
    """
    Build the pip install command list.

    Prefers `pip` on PATH; falls back to `python3 -m pip` if pip is not found.
    """
    pylib_dir = os.path.join(plugin_data, "pylib")
    install_args = ["install", "--target", pylib_dir] + PACKAGES

    if shutil.which("pip") is not None:
        return ["pip"] + install_args
    else:
        return ["python3", "-m", "pip"] + install_args


def run_pip_install(plugin_data: str) -> bool:
    """
    Run pip install --target <plugin_data>/pylib mcp langfuse.

    Returns True on success (exit code 0), False otherwise.
    """
    cmd = _build_pip_command(plugin_data)
    result = subprocess.run(cmd)
    return result.returncode == 0


def run_install(plugin_data: str | None, version: str) -> None:
    """
    Orchestrate hash check + install.

    - If plugin_data is None: skip entirely (CLAUDE_PLUGIN_DATA not set).
    - If cache hit: no-op.
    - If cache miss: run pip install. On success, write cache. On failure, remove cache.
    - Fail-open: all exceptions caught; .deps-hash removed for retry.
    """
    if plugin_data is None:
        return

    if is_cache_hit(plugin_data, version):
        return

    try:
        success = run_pip_install(plugin_data)
        if success:
            write_cache(plugin_data, version)
        else:
            remove_cache(plugin_data)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        remove_cache(plugin_data)


def read_version(plugin_root: str | None = None) -> str:
    """
    Read version from plugin.json.

    Falls back to plugin root derived from this file's location if not provided.
    Returns "0.0.0" if plugin.json is unreadable.
    """
    if plugin_root is None:
        # Two levels up from src/claude_gates/ → project root
        plugin_root = os.path.dirname(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        )
    plugin_json = os.path.join(plugin_root, ".claude-plugin", "plugin.json")
    try:
        with open(plugin_json) as f:
            data = json.load(f)
        return data.get("version", "0.0.0")
    except (OSError, json.JSONDecodeError, KeyError):
        return "0.0.0"


def main() -> None:
    """
    Entry point for SessionStart hook.

    Reads CLAUDE_PLUGIN_DATA and CLAUDE_PLUGIN_ROOT from environment,
    resolves plugin version, then runs hash-gated pip install.
    Fail-open: exceptions do not propagate.
    """
    try:
        plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA") or None
        plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT") or None
        version = read_version(plugin_root)
        run_install(plugin_data, version)
    except Exception:
        traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
