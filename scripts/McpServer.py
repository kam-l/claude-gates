"""
Direct entry script for the claude-gates MCP server.

NOT a hook — no stdin/stdout JSON protocol, no exit 0 guarantee.
Long-running process. Exit 1 on fatal error.
"""
import os
import sys


def _setup_sys_path():
    """Insert plugin paths into sys.path (mirrors hook_runner._setup_sys_path)."""
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if not plugin_root:
        # Fall back to two levels above this script (scripts/ -> project root)
        plugin_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    src_path = os.path.join(plugin_root, "src")
    if src_path not in sys.path:
        sys.path.insert(0, src_path)

    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA")
    if plugin_data:
        pylib_path = os.path.join(plugin_data, "pylib")
        if pylib_path not in sys.path:
            sys.path.insert(0, pylib_path)


_setup_sys_path()

try:
    from claude_gates.mcp_server import main
    main()
except ImportError:
    print("[ClaudeGates] MCP server requires 'mcp' package. Run pip install.", file=sys.stderr)
    sys.exit(1)
