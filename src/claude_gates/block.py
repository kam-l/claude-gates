"""
Pipeline v3 — PreToolUse gate blocker (no matcher = fires for ALL tools).

When pipeline steps are active, blocks ALL tools except:
  - Tool calls from subagents (agent_type is set) — gated by SubagentStop
  - Read-only tools (Read, Glob, Grep) and progress tracking (TaskCreate, TaskUpdate, SendMessage, etc.)
  - Spawning an agent that matches ANY active pipeline's expected agent

Also surfaces queued notifications from SubagentStop via systemMessage.

Fail-open: no session / no DB / no active pipeline → allow.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from claude_gates import messaging, tracing
from claude_gates.engine import PipelineEngine
from claude_gates.repository import PipelineRepository
from claude_gates.session import (
    agent_running_marker,
    get_session_dir,
    is_gate_disabled,
    open_database,
)
from claude_gates.types import StepStatus

ALLOWED_TOOLS = [
    "Read",
    "Glob",
    "Grep",
    "TaskCreate",
    "TaskUpdate",
    "TaskGet",
    "TaskList",
    "SendMessage",
    "ToolSearch",
]


def _source_reason(act: dict) -> str:
    step = act.get("step")
    if not step:
        return "."
    if step.get("status") == StepStatus.Fix:
        return ": reviewer found issues — fixer must address them before next review round."
    if step.get("status") == StepStatus.Revise:
        return ": reviewer found issues — source must revise the artifact."
    if step.get("round", 0) > 0:
        return f": revision round {step['round']} — address reviewer feedback."
    return "."


def on_pre_tool_use(data: dict) -> dict:
    if is_gate_disabled():
        return {}

    session_id: str = data.get("session_id") or ""
    if not session_id:
        return {}

    tool_name: str = data.get("tool_name") or ""
    tool_input_raw = data.get("tool_input")
    tool_input: dict = tool_input_raw if isinstance(tool_input_raw, dict) else {}
    caller_agent: str = data.get("agent_type") or ""

    session_dir = get_session_dir(session_id)

    # Drain notifications BEFORE DB open so we hold the text, but surface them
    # even if DB fails — notifications must not be silently lost on DB error.
    pending: Optional[str] = messaging.drain_notifications(session_dir)

    actions: Optional[List[Dict[str, Any]]] = None
    db = None
    try:
        db = open_database(session_dir)
        PipelineRepository.init_schema(db)
        repo = PipelineRepository(db)
        engine = PipelineEngine(repo)
        actions = engine.get_all_next_actions()
    except Exception:
        # DB unavailable — fail-open, but surface any drained notifications first
        if pending:
            cleaned = pending.replace("[ClaudeGates] ", "")
            return messaging.info("", cleaned)
        return {}
    finally:
        if db is not None:
            db.close()

    # Treat None (DB error) as empty
    if not actions:
        if pending:
            cleaned = pending.replace("[ClaudeGates] ", "")
            return messaging.info("", cleaned)
        return {}

    # Subagent calls gated by SubagentStop, not here
    if caller_agent:
        return {}

    # Read-only + progress tracking tools always allowed
    if tool_name in ALLOWED_TOOLS:
        return {}

    # Build expected agent names — Set avoids collisions when multiple scopes share name
    expected_agent_names: set = set()
    has_blocking_actions = False

    for act in actions:
        if act.get("action") in ("spawn", "source", "semantic"):
            # Skip blocking if the expected agent is still running
            try:
                if os.path.exists(agent_running_marker(session_dir, act["scope"])):
                    continue
            except Exception:
                pass
            agent = act.get("agent") or (act.get("step") or {}).get("source_agent")
            if agent:
                expected_agent_names.add(agent)
            has_blocking_actions = True

    if not has_blocking_actions:
        return {}

    # Write/Edit scoped to session artifacts — allow writes to non-session paths
    if tool_name in ("Write", "Edit"):
        target_path = (tool_input.get("file_path") or "").replace("\\", "/")
        if not target_path or not target_path.startswith(session_dir.replace("\\", "/") + "/"):
            return {}

    # Agent tool: allow expected agents (any scope expecting this agent name)
    # Note: tool_input.subagent_type is the agent being spawned (Agent tool input field).
    #       data.agent_type (caller_agent above) is the hook caller identity — distinct fields.
    if tool_name == "Agent":
        subagent_type = tool_input.get("subagent_type") or ""
        if subagent_type in expected_agent_names:
            return {}

    # Build block message — actions as clear instructions, notifications separate
    parts: List[str] = []
    for act in actions:
        agent = act.get("agent") or (act.get("step") or {}).get("source_agent")
        action = act.get("action")
        scope = act.get("scope", "")
        if action == "spawn":
            step = act.get("step") or {}
            is_transform = step.get("step_type") == "TRANSFORM"
            attempt = act.get("round", 0) + 1
            max_attempts = act.get("maxRounds", 0) + 1
            if is_transform:
                reason = "transform step — auto-passes on completion"
            elif attempt == 1:
                reason = "reviewer needs to evaluate the artifact"
            else:
                reason = "re-review after revision"
            parts.append(f"Spawn {agent} (scope={scope}, round {attempt}/{max_attempts}): {reason}.")
        elif action in ("source", "semantic"):
            step = act.get("step") or {}
            round_num = step.get("round", 0)
            verb = "Resume" if round_num > 0 else "Spawn"
            reason = _source_reason(act)
            parts.append(f"{verb} {agent} (scope={scope}){reason}")

    # Guard: if no parts were built (e.g. all actions have unrecognized types in second loop),
    # avoid sending "Do these first:" with no content — fail-open instead.
    if not parts:
        return {}

    # Langfuse: trace block decisions — session-level trace with scope spans
    try:
        ctx = tracing.init()
        if ctx.get("enabled"):
            langfuse = ctx["langfuse"]
            trace_id = tracing.session_trace_id(session_id)
            trace = langfuse.trace(id=trace_id, name="session", session_id=session_id)
            for act in actions:
                scope_span = tracing.scope_span(trace, act.get("scope", ""))
                scope_span.span(
                    name="tool-blocked",
                    input={
                        "toolName": tool_name,
                        "scope": act.get("scope"),
                        "expectedAgent": act.get("agent"),
                    },
                ).end()
                scope_span.end()
            tracing.flush(langfuse, True)
    except Exception:
        pass  # fail-open

    # Frame as instructions, not errors
    message = (
        "Pipeline actions pending (this is normal flow, not an error). Do these first:\n"
        + "\n".join(parts)
    )

    # Append deduplicated notifications separately
    if pending:
        unique_notes = list(dict.fromkeys(
            line.strip() for line in pending.split("\n") if line.strip()
        ))
        message += "\nContext: " + " | ".join(unique_notes)

    return messaging.block("🔒", message)
