"""Pipeline v3 — SubagentStart injection hook.

Semantics first, structure later: no output format or filepath constraints
are injected. Agents think freely. SubagentStop captures their output.

Only injects role context for verifiers (source artifact path, round info)
and fixers (source artifact, gate agent info). Source agents get nothing.

Pipeline creation is deferred to SubagentStop (parallel pipelines).

Fail-open.
"""
from __future__ import annotations

import os
from typing import Optional

from claude_gates import session
from claude_gates.engine import PipelineEngine
from claude_gates.repository import PipelineRepository
from claude_gates.types import AgentRole, StepStatus


def on_subagent_start(data: dict) -> dict:
    """SubagentStart hook handler. Returns {} or hookSpecificOutput dict."""
    # AC1: Gate disabled → allow
    if session.is_gate_disabled():
        return {}

    session_id: str = data.get("session_id") or ""
    agent_type: str = data.get("agent_type") or ""

    # AC1: Missing session or agent → allow
    if not session_id or not agent_type:
        return {}

    # AC2: Normalize plugin-qualified agent type ("claude-gates:gater" → "gater")
    bare_agent_type = agent_type.split(":")[-1] if ":" in agent_type else agent_type
    session_dir = session.get_session_dir(session_id)

    pipeline_context = ""
    conn = None
    try:
        conn = session.open_database(session_dir)
        PipelineRepository.init_schema(conn)
        repo = PipelineRepository(conn)
        engine = PipelineEngine(repo)

        # AC3: Find scope — pending marker takes priority, DB fallback
        scope: Optional[str] = None
        pending_marker = os.path.join(session_dir, f".pending-scope-{bare_agent_type}")
        try:
            if os.path.exists(pending_marker):
                with open(pending_marker, "r", encoding="utf-8") as f:
                    scope = f.read().strip()
                os.unlink(pending_marker)
        except Exception:
            pass

        if not scope:
            scope = repo.find_agent_scope(bare_agent_type)

        if scope:
            # Role-based context enrichment
            role = engine.resolve_role(scope, bare_agent_type)

            if role == AgentRole.Verifier:
                # AC4: Gate agent — inject source artifact path + round info
                active_step = repo.get_active_step(scope)
                if active_step:
                    state = repo.get_pipeline_state(scope)
                    source_agent = state["source_agent"] if state else "unknown"
                    # After fixer runs, reviewer reads fixer's output (latest version)
                    source_artifact = f"{session_dir}/{scope}/{source_agent}.md"
                    if active_step.get("fixer") and active_step.get("round", 0) > 0:
                        fixer_artifact = f"{session_dir}/{scope}/{active_step['fixer']}.md"
                        if os.path.exists(fixer_artifact):
                            source_artifact = fixer_artifact
                    pipeline_context = (
                        f"role=gate\n"
                        f"session_id={session_id}\n"
                        f"scope={scope}\n"
                        f"source_agent={source_agent}\n"
                        f"source_artifact={source_artifact}\n"
                        f"gate_round={active_step['round'] + 1}/{active_step['max_rounds']}\n"
                    )

            elif role == AgentRole.Fixer:
                # AC5: Fixer — inject source artifact + gate agent info
                fix_step = repo.get_step_by_status(scope, StepStatus.Fix)
                if fix_step:
                    state = repo.get_pipeline_state(scope)
                    source_agent = state["source_agent"] if state else "unknown"
                    source_artifact = f"{session_dir}/{scope}/{source_agent}.md"
                    pipeline_context = (
                        f"role=fixer\n"
                        f"session_id={session_id}\n"
                        f"scope={scope}\n"
                        f"source_agent={source_agent}\n"
                        f"source_artifact={source_artifact}\n"
                        f"gate_agent={fix_step['agent']}\n"
                        f"gate_round={fix_step['round'] + 1}/{fix_step['max_rounds']}\n"
                    )

            # AC6: Append reviewer findings if verification file exists
            try:
                verification_file = os.path.join(
                    session_dir, scope, f"{bare_agent_type}-verification.md"
                )
                if os.path.exists(verification_file):
                    with open(verification_file, "r", encoding="utf-8") as f:
                        findings = f.read()
                    pipeline_context += (
                        f"artifact={session_dir}/{scope}/{bare_agent_type}.md\n"
                        f"\nReviewer findings (address ALL issues before resubmitting):\n{findings}\n"
                    )
            except Exception:
                pass

            # AC7: Source / ungated / checker / transformer → no context (semantics first)

    finally:
        if conn is not None:
            conn.close()

    # AC8: Only inject if there's role context to provide (verifier/fixer)
    if not pipeline_context:
        return {}

    context = (
        '<agent_gate importance="critical">\n'
        + pipeline_context
        + "</agent_gate>"
    )

    return {
        "hookSpecificOutput": {
            "hookEventName": "SubagentStart",
            "additionalContext": context,
        }
    }
