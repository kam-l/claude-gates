"""MCP server for claude-gates — gate_verdict and gate_status tools.

Transport: stdio. Entry point: main()

FastMCP is a lazy-imported optional dependency. If not installed the module
still imports cleanly; the missing dep is surfaced by session_context.py
during SessionStart.
"""

from __future__ import annotations

import importlib.metadata
import json
import sys
from typing import Any, Dict, Optional

# ── Version ──────────────────────────────────────────────────────────

try:
    VERSION = importlib.metadata.version("claude-gates")
except importlib.metadata.PackageNotFoundError:
    VERSION = "0.0.0"

# ── Optional FastMCP import ───────────────────────────────────────────

try:
    from fastmcp import FastMCP
    from pydantic import Field
    mcp = FastMCP("claude-gates", version=VERSION)
    _fastmcp_available = True
except ImportError:
    mcp = None  # type: ignore[assignment]
    _fastmcp_available = False

    def Field(*args: Any, **kwargs: Any) -> Any:  # type: ignore[misc]
        return None

# ── Dependencies ──────────────────────────────────────────────────────

from claude_gates.session import get_session_dir, open_database
from claude_gates.repository import PipelineRepository


# ── Tool implementations (bare async functions, registered below) ────

async def gate_verdict_fn(
    session_id: str,
    scope: str,
    verdict: str,
    check: Optional[str],
    reason: str,
) -> Dict[str, Any]:
    """Submit a PASS/REVISE/FAIL verdict for a pipeline or plan-gate scope.

    AC1: Unified upsert_verdict() for all scopes — no branching.
    """
    try:
        session_dir = get_session_dir(session_id)
        db = open_database(session_dir)
        try:
            PipelineRepository.init_schema(db)
            repo = PipelineRepository(db)

            if scope == "verify-plan":
                # Plan-gate path — upsert directly, no active step required
                repo.upsert_verdict(scope, "gater", verdict, 0)
                return {
                    "content": [
                        {
                            "type": "text",
                            "text": f"Plan-gate verdict recorded: {verdict}. Reason: {reason}",
                        }
                    ]
                }

            # Pipeline path — find active step to identify agent
            active_step = repo.get_active_step(scope)
            if not active_step:
                return {
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                f"Error: no active step found for scope=\"{scope}\". "
                                "Is the pipeline running?"
                            ),
                        }
                    ],
                    "isError": True,
                }

            agent = active_step.get("agent") or active_step.get("source_agent")
            round_num = active_step.get("round", 0)
            repo.upsert_verdict(scope, agent, verdict, round_num)

            return {
                "content": [
                    {
                        "type": "text",
                        "text": (
                            f"Verdict {verdict} recorded for scope=\"{scope}\" "
                            f"step {active_step['step_index']} ({active_step['step_type']}). "
                            f"Reason: {reason}"
                        ),
                    }
                ]
            }
        finally:
            db.close()

    except Exception as err:
        err_msg = str(err)
        sys.stderr.write(f"[ClaudeGates MCP] gate_verdict error: {err_msg}\n")
        return {
            "content": [{"type": "text", "text": f"Error: {err_msg}"}],
            "isError": True,
        }


async def gate_status_fn(
    session_id: str,
    scope: Optional[str] = None,
) -> Dict[str, Any]:
    """Read pipeline state.

    With scope: returns pipeline state + steps.
    Without scope: returns summary of all active pipelines.
    """
    try:
        session_dir = get_session_dir(session_id)
        db = open_database(session_dir)
        try:
            PipelineRepository.init_schema(db)
            repo = PipelineRepository(db)

            if scope:
                state = repo.get_pipeline_state(scope)
                if not state:
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": f"No pipeline found for scope=\"{scope}\".",
                            }
                        ],
                        "isError": True,
                    }
                steps = repo.get_steps(scope)
                return {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps({"state": state, "steps": steps}, indent=2),
                        }
                    ]
                }

            # All active pipelines
            pipelines = repo.get_active_pipelines()
            result = [
                {
                    "scope": p["scope"],
                    "status": p["status"],
                    "current_step": p["current_step"],
                    "total_steps": p["total_steps"],
                }
                for p in pipelines
            ]
            return {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(result, indent=2),
                    }
                ]
            }
        finally:
            db.close()

    except Exception as err:
        err_msg = str(err)
        sys.stderr.write(f"[ClaudeGates MCP] gate_status error: {err_msg}\n")
        return {
            "content": [{"type": "text", "text": f"Error: {err_msg}"}],
            "isError": True,
        }


# ── Register tools with FastMCP (if available) ───────────────────────

if _fastmcp_available and mcp is not None:
    from typing import Literal

    @mcp.tool()
    async def gate_verdict(
        session_id: str = Field(..., description="Session UUID"),
        scope: str = Field(..., description="Pipeline scope or 'verify-plan' for plan-gate"),
        verdict: Literal["PASS", "REVISE", "FAIL"] = Field(
            ..., description="Verdict: what the reviewed agent decided (PASS, REVISE, or FAIL)"
        ),
        check: Optional[Literal["PASS", "FAIL"]] = Field(
            None,
            description="Quality check: your assessment of the agent's work (PASS = thorough, FAIL = sloppy/wrong)",
        ),
        reason: str = Field(..., description="Human-readable reason for the verdict"),
    ) -> Dict[str, Any]:
        """Submit a PASS/REVISE/FAIL verdict for a pipeline or plan-gate scope."""
        return await gate_verdict_fn(session_id, scope, verdict, check, reason)

    @mcp.tool()
    async def gate_status(
        session_id: str = Field(..., description="Session UUID"),
        scope: Optional[str] = Field(
            None, description="Pipeline scope (omit for all active pipelines)"
        ),
    ) -> Dict[str, Any]:
        """Read pipeline state. With scope: returns state + steps. Without: returns all active."""
        return await gate_status_fn(session_id, scope)


# ── Entry point ───────────────────────────────────────────────────────

def main() -> None:
    """Start the MCP server with explicit stdio transport."""
    if not _fastmcp_available or mcp is None:
        sys.stderr.write(
            "[ClaudeGates MCP] FastMCP not installed. "
            "Run: pip install fastmcp\n"
        )
        sys.exit(1)
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
