"""
Shared hook entry point for claude-gates Python hooks.

Usage in each hook script (2-liner):
    from claude_gates.hook_runner import run
    run(lambda data: my_hook(data))

Contract:
- Reads stdin as binary, decodes UTF-8 (no text-mode translation on Windows).
- Parses JSON input, calls handler(data) -> result dict or None.
- Writes exactly one JSON dict to stdout and flushes.
- Always exits 0 (fail-open invariant) — catches BaseException.
- Logs exceptions to stderr via traceback.print_exc() before writing {}.
"""
import json
import os
import sys
import traceback


def run(handler):
    """
    Shared hook entry point.

    Parameters
    ----------
    handler : Callable[[dict], dict | None]
        Hook implementation. Receives parsed JSON dict, returns result dict or None.
        Non-dict returns are coerced to {}.
    """
    _setup_sys_path()

    result = {}
    try:
        raw = sys.stdin.buffer.read().decode("utf-8")
        data = json.loads(raw) if raw.strip() else {}
        if not isinstance(data, dict):
            data = {}

        output = handler(data)

        if isinstance(output, dict):
            result = output
        # None or non-dict → result stays {}

    except BaseException:
        traceback.print_exc()
        result = {}

    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()
    sys.exit(0)


def _setup_sys_path():
    """Insert plugin paths into sys.path for the hook ecosystem."""
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if not plugin_root:
        # Fall back to two levels above this file (project root)
        plugin_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    src_path = os.path.join(plugin_root, "src")
    if src_path not in sys.path:
        sys.path.insert(0, src_path)

    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA")
    if plugin_data:
        pylib_path = os.path.join(plugin_data, "pylib")
        if pylib_path not in sys.path:
            sys.path.insert(0, pylib_path)
