from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import claude_gates.tracing as tracing
from claude_gates.engine import PipelineEngine
from claude_gates.messaging import block, log, notify
from claude_gates.parser import find_agent_md, parse_verification
from claude_gates.repository import PipelineRepository
from claude_gates.session import (
    agent_running_marker,
    get_session_dir,
    is_gate_disabled,
    open_database,
)
from claude_gates.types import AgentRole, PipelineStatus, StepType

PROJECT_ROOT = os.getcwd()
HOME = os.environ.get("USERPROFILE") or os.environ.get("HOME") or ""


# ── Scope resolution helpers ───────────────────────────────────────────


def _extract_scope_from_transcript(transcript_path: Optional[str]) -> Optional[str]:
    if not transcript_path:
        return None
    try:
        with open(transcript_path, "rb") as f:
            chunk = f.read(2048).decode("utf-8", errors="replace")
        m = re.search(r"scope=([A-Za-z0-9_-]+)", chunk)
        return m.group(1) if m else None
    except Exception:
        return None


def _extract_artifact_path(
    message: str, session_dir: str, agent_type: str
) -> Optional[Dict[str, str]]:
    normalized_dir = session_dir.replace("\\", "/")
    escaped_dir = re.escape(normalized_dir)
    bare_type = agent_type.split(":")[-1] if ":" in agent_type else agent_type
    escaped_agent = re.escape(bare_type)
    pattern = re.compile(
        escaped_dir + r"/([A-Za-z0-9_-]+)/" + escaped_agent + r"\.md",
        re.IGNORECASE,
    )
    normalized_msg = message.replace("\\", "/")
    m = pattern.search(normalized_msg)
    if m and m.group(1) != "_pending":
        scope = m.group(1)
        artifact_path = os.path.join(session_dir, scope, f"{bare_type}.md")
        return {"scope": scope, "artifactPath": artifact_path}
    return None


def _resolve_scope(
    data: dict, repo: PipelineRepository, session_dir: str, bare_agent_type: str
) -> Dict[str, Any]:
    agent_id = data.get("agent_id") or "unknown"
    last_message = data.get("last_assistant_message") or ""

    scope = _extract_scope_from_transcript(data.get("agent_transcript_path"))
    if not scope:
        alt_transcript = None
        transcript_path = data.get("transcript_path")
        if transcript_path and agent_id != "unknown":
            alt_transcript = transcript_path.replace(".jsonl", "") + "/subagents/agent-" + agent_id + ".jsonl"
        scope = _extract_scope_from_transcript(alt_transcript)

    artifact_path = None

    if not scope and last_message:
        info = _extract_artifact_path(last_message, session_dir, bare_agent_type)
        if info:
            scope = info["scope"]
            artifact_path = info["artifactPath"]

    if not scope:
        found = repo.find_agent_scope(bare_agent_type)
        if found:
            scope = found
            candidate = os.path.join(session_dir, scope, f"{bare_agent_type}.md")
            if os.path.exists(candidate):
                artifact_path = candidate
            else:
                sys.stderr.write(
                    f"[ClaudeGates] Scope resolution via DB: artifact not found at {candidate}\n"
                )

    if not scope:
        sys.stderr.write(
            f"[ClaudeGates] Scope resolution failed for {bare_agent_type} — treating as ungated.\n"
        )

    return {"scope": scope, "artifactPath": artifact_path}


# ── MCP config ────────────────────────────────────────────────────────


def _ensure_mcp_config(session_dir: str) -> str:
    os.makedirs(session_dir, exist_ok=True)
    mcp_config_path = os.path.join(session_dir, "mcp-config.json")
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT") or PROJECT_ROOT
    server_script = os.path.join(plugin_root, "scripts", "McpServer.py").replace("\\", "/")
    config = {
        "mcpServers": {
            "claude-gates": {
                "command": sys.executable,
                "args": [server_script],
            }
        }
    }
    with open(mcp_config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    return mcp_config_path.replace("\\", "/")


# ── Semantic check ────────────────────────────────────────────────────


def _run_semantic_check(
    prompt: str,
    artifact_content: str,
    artifact_path: str,
    context_content: str,
    is_review: bool,
    session_id: Optional[str] = None,
    scope: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    combined_prompt = prompt + "\n\n"
    if is_review:
        combined_prompt += (
            "NOTE: This artifact is a REVIEW or FIX of another artifact, not primary content. "
            "Judge whether this review/fix is well-structured, specific, and actionable. "
            "Negative findings about the SOURCE artifact are expected and correct — do not penalize "
            "the reviewer for identifying problems.\n\n"
        )
    combined_prompt += f"--- {os.path.basename(artifact_path)} ---\n{artifact_content}\n"
    if context_content:
        combined_prompt += context_content

    if session_id and scope:
        combined_prompt += f"\nsession_id={session_id}\nscope={scope}\n"

    claude_bin = shutil.which("claude")
    if not claude_bin:
        sys.stderr.write("[ClaudeGates] claude binary not found — skipping semantic check\n")
        return None

    if session_id and scope:
        session_d = get_session_dir(session_id)
        mcp_config_path = _ensure_mcp_config(session_d)
        cmd = (
            f'"{claude_bin}" -p --model sonnet --agent claude-gates:gater --max-turns 5 '
            f'--tools "mcp__claude-gates__*" --mcp-config "{mcp_config_path}" '
            f"--no-chrome --strict-mcp-config --disable-slash-commands --no-session-persistence"
        )
        timeout = 180
    else:
        cmd = (
            f'"{claude_bin}" -p --model sonnet --agent claude-gates:gater --max-turns 1 '
            f'--tools "" --no-chrome --strict-mcp-config --disable-slash-commands --no-session-persistence'
        )
        timeout = 90

    try:
        env = dict(os.environ)
        env["CLAUDECODE"] = ""
        result = subprocess.run(
            cmd,
            input=combined_prompt,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=True,
            cwd=PROJECT_ROOT,
            env=env,
        )
        output = result.stdout.strip()

        m = re.search(r"^Result:\s*(PASS|FAIL|REVISE|CONVERGED)\b(.*)$", output, re.MULTILINE | re.IGNORECASE)
        if m:
            raw = m.group(1).upper()
            verdict = "PASS" if raw in ("PASS", "CONVERGED") else "FAIL"
            return {
                "verdict": verdict,
                "check": None,
                "reason": m.group(2).strip() if m.group(2) else "",
                "fullResponse": output,
            }

        if session_id and scope:
            try:
                session_d = get_session_dir(session_id)
                check_conn = open_database(session_d)
                try:
                    PipelineRepository.init_schema(check_conn)
                    check_repo = PipelineRepository(check_conn)
                    active_step = check_repo.get_active_step(scope)
                    agent = None
                    if active_step:
                        agent = active_step.get("agent") or active_step.get("source_agent")
                    if agent:
                        agent_row = check_repo.get_agent(scope, agent)
                        if agent_row and agent_row.get("verdict"):
                            raw = agent_row["verdict"].upper()
                            verdict = "PASS" if raw in ("PASS", "CONVERGED") else "FAIL"
                            check_val = agent_row.get("check")
                            check_upper = check_val.upper() if check_val else None
                            sys.stderr.write(
                                f"[ClaudeGates] MCP verdict from DB: {verdict}, check={check_upper or 'N/A'} (agent={agent})\n"
                            )
                            return {
                                "verdict": verdict,
                                "check": check_upper,
                                "reason": "via gate_verdict MCP",
                                "fullResponse": output,
                            }
                finally:
                    check_conn.close()
            except Exception:
                pass

        sys.stderr.write(
            f"[ClaudeGates] Semantic check: no verdict for {os.path.basename(artifact_path)} ({len(output)} chars)\n"
        )
        return None

    except subprocess.TimeoutExpired:
        sys.stderr.write(
            f"[ClaudeGates] Semantic check failed (timeout {timeout}s) for {os.path.basename(artifact_path)}\n"
        )
        return None
    except Exception as err:
        sys.stderr.write(
            f"[ClaudeGates] Semantic check failed ({err}) for {os.path.basename(artifact_path)}\n"
        )
        return None


# ── Audit trail ───────────────────────────────────────────────────────


def _write_audit(
    session_dir: str,
    scope: Optional[str],
    agent_type: str,
    artifact_path: str,
    semantic_result: Optional[Dict[str, Any]],
) -> None:
    try:
        audit_dir = os.path.join(session_dir, scope) if scope else session_dir
        os.makedirs(audit_dir, exist_ok=True)
        audit_file = os.path.join(audit_dir, f"{agent_type}-verification.md")
        verdict = semantic_result["verdict"] if semantic_result else "UNKNOWN"
        reason = (semantic_result.get("reason") or "N/A") if semantic_result else "N/A"
        full_response = semantic_result.get("fullResponse", "(skipped)") if semantic_result else "(skipped)"
        content = (
            f"# Pipeline: {agent_type}\n"
            f"- **Timestamp:** {_utcnow()}\n"
            f"- **Artifact:** {artifact_path.replace(chr(92), '/')}\n"
            + (f"- **Scope:** {scope}\n" if scope else "")
            + f"- **Verdict:** {verdict}\n"
            + f"- **Reason:** {reason}\n"
            + f"- **Full response:**\n```\n{full_response}\n```\n"
        )
        with open(audit_file, "w", encoding="utf-8") as f:
            f.write(content)
    except Exception:
        pass


def _utcnow() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


# ── Scope context ─────────────────────────────────────────────────────


def _gather_scope_context(session_dir: str, scope: Optional[str], agent_type: str) -> str:
    if not scope:
        return ""
    bare = agent_type.split(":")[-1] if ":" in agent_type else agent_type
    context = ""
    try:
        scope_dir = os.path.join(session_dir, scope)
        for filename in os.listdir(scope_dir):
            if not filename.endswith(".md"):
                continue
            if filename in (f"{bare}.md", f"{bare}-verification.md"):
                continue
            try:
                file_path = os.path.join(scope_dir, filename)
                with open(file_path, "r", encoding="utf-8") as f:
                    file_content = f.read()
                context += f"\n--- {scope}/{filename} ---\n{file_content}\n"
            except Exception:
                pass
    except Exception:
        pass
    return context


# ── Implicit source check ─────────────────────────────────────────────


def _implicit_source_check(content: str, artifact_path: str) -> Optional[str]:
    if not content or not content.strip():
        return f"Artifact is empty: {os.path.basename(artifact_path)}"
    stripped = content.strip()
    if len(stripped) < 50:
        return f"Artifact is trivially short ({len(stripped)} chars): {os.path.basename(artifact_path)}"
    if not re.search(r"^[#\-*+\d]", content, re.MULTILINE):
        return f"Artifact lacks structure (no headings, bullets, or lists): {os.path.basename(artifact_path)}"
    return None


# ── Verdict recording ─────────────────────────────────────────────────


def _record_verdict(
    repo: PipelineRepository, scope: str, agent_type: str, verdict: str
) -> Optional[Dict[str, Any]]:
    if not scope:
        return None
    try:
        bare = agent_type.split(":")[-1] if ":" in agent_type else agent_type
        existing = repo.get_agent(scope, bare)
        round_num = (existing["round"] + 1) if existing and existing.get("round") else 1
        repo.upsert_verdict(scope, bare, verdict, round_num)
        return {"verdict": verdict, "round": round_num}
    except Exception:
        return None


# ── Log action ────────────────────────────────────────────────────────


def _log_action(session_dir: str, action: Optional[Dict[str, Any]], scope: str) -> None:
    if not action:
        return
    a = action.get("action")
    if a == "done":
        log("✅", f"Pipeline complete (scope={scope}).")
    elif a == "failed":
        log("❌", f"Pipeline exhausted (scope={scope}).")
    elif a == "spawn":
        round_num = (action.get("round") or 0) + 1
        max_rounds = action.get("maxRounds")
        log("🔄", f"Next: {action.get('agent')} (scope={scope}, round {round_num}/{max_rounds}).")
    elif a == "source":
        log("🔄", f"Next: {action.get('agent')} (scope={scope}).")
    else:
        log("⚡", f"Next: {a} (scope={scope}).")


# ── Role handlers ─────────────────────────────────────────────────────


def _handle_source(
    repo: PipelineRepository,
    engine: PipelineEngine,
    scope: str,
    agent_type: str,
    artifact_path: str,
    artifact_content: str,
    artifact_verdict: str,
    scope_context: str,
    session_dir: str,
    session_id: str,
    span: Any,
    enabled: bool,
) -> None:
    state = repo.get_pipeline_state(scope)
    if state and state.get("status") == PipelineStatus.Revision:
        next_action = engine.step(scope, {"role": "source", "artifactVerdict": artifact_verdict})
        if not next_action or next_action.get("action") != "semantic":
            _record_verdict(repo, scope, agent_type, artifact_verdict)
            _log_action(session_dir, next_action, scope)
            span.span(
                name="engine-step",
                input={"role": "source", "agent": agent_type, "artifactVerdict": artifact_verdict},
                output={
                    "action": next_action.get("action") if next_action else None,
                    "nextAgent": next_action.get("agent") if next_action else None,
                },
            ).end()
            return

    implicit_fail = _implicit_source_check(artifact_content, artifact_path)
    if implicit_fail:
        notify(session_dir, "", f"{agent_type}: {implicit_fail}")
        tracing.trace(session_dir, "implicit-check.fail", scope, {"agent": agent_type, "reason": implicit_fail})
        _record_verdict(repo, scope, agent_type, "FAIL")
        fail_action = engine.step(scope, {"role": "source", "artifactVerdict": "FAIL"})
        _log_action(session_dir, fail_action, scope)
        span.span(
            name="implicit-check",
            input={"agent": agent_type, "artifactPath": os.path.basename(artifact_path), "artifactSize": len(artifact_content)},
            output={"verdict": "FAIL", "reason": implicit_fail},
        ).end()
        tracing.score(span, enabled, "verdict", "FAIL", implicit_fail)
        return

    active_step = repo.get_active_step(scope)
    quality_check = None
    semantic_result = None

    if active_step and active_step.get("step_type") == StepType.Check and active_step.get("prompt"):
        semantic_result = _run_semantic_check(
            active_step["prompt"], artifact_content, artifact_path, scope_context,
            False, session_id, scope
        )
        _write_audit(session_dir, scope, agent_type, artifact_path, semantic_result)
        quality_check = (
            semantic_result.get("check") or semantic_result.get("verdict")
            if semantic_result else None
        )
        span.span(
            name="semantic-check",
            input={"prompt": active_step["prompt"], "agent": agent_type,
                   "artifactPath": os.path.basename(artifact_path), "artifactSize": len(artifact_content)},
            output={"verdict": quality_check, "reason": semantic_result.get("reason") if semantic_result else None},
        ).end()
        tracing.score(span, enabled, "verdict", quality_check or "UNKNOWN",
                      semantic_result.get("reason") if semantic_result else None)

    final_verdict = "FAIL" if quality_check == "FAIL" else "PASS"
    _record_verdict(repo, scope, agent_type, final_verdict)

    next_action = engine.step(scope, {"role": "source", "artifactVerdict": final_verdict})
    tracing.trace(session_dir, "engine.step", scope, {
        "agent": agent_type, "role": "source", "verdict": final_verdict,
        "qualityCheck": quality_check, "action": next_action.get("action") if next_action else None,
    })
    _log_action(session_dir, next_action, scope)
    span.span(
        name="engine-step",
        input={"role": "source", "agent": agent_type, "artifactVerdict": final_verdict, "qualityCheck": quality_check},
        output={
            "action": next_action.get("action") if next_action else None,
            "nextAgent": next_action.get("agent") if next_action else None,
        },
    ).end()

    if final_verdict == "FAIL":
        reason = (semantic_result.get("reason") if semantic_result else None) or "Semantic validation failed"
        notify(session_dir, "", reason)


def _handle_verifier(
    repo: PipelineRepository,
    engine: PipelineEngine,
    scope: str,
    agent_type: str,
    artifact_path: str,
    artifact_content: str,
    artifact_verdict: str,
    scope_context: str,
    session_dir: str,
    session_id: str,
    span: Any,
    enabled: bool,
) -> None:
    semantic_result = _run_semantic_check(
        "Is this review thorough? Does it identify real issues or correctly approve? "
        "Is the verdict justified given the scope artifacts?",
        artifact_content, artifact_path, scope_context,
        True, session_id, scope,
    )
    _write_audit(session_dir, scope, agent_type, artifact_path, semantic_result)

    quality_check = (
        semantic_result.get("check") or semantic_result.get("verdict")
        if semantic_result else None
    )
    span.span(
        name="semantic-check",
        input={"prompt": "implicit-verifier-check", "agent": agent_type,
               "artifactPath": os.path.basename(artifact_path), "artifactSize": len(artifact_content)},
        output={"verdict": quality_check, "reason": semantic_result.get("reason") if semantic_result else None},
    ).end()
    tracing.score(span, enabled, "verdict", quality_check or "UNKNOWN",
                  semantic_result.get("reason") if semantic_result else None)

    _record_verdict(repo, scope, agent_type, artifact_verdict)

    # Semantic FAIL + verifier didn't say REVISE → retry
    if quality_check == "FAIL" and artifact_verdict.upper().strip() != "REVISE":
        retry_action = engine.retry_gate_agent(scope)
        tracing.trace(session_dir, "engine.retryGateAgent", scope, {
            "agent": agent_type, "role": "verifier", "verdict": artifact_verdict,
            "qualityCheck": quality_check, "action": retry_action.get("action") if retry_action else None,
        })
        _log_action(session_dir, retry_action, scope)
        span.span(
            name="engine-step",
            input={"role": "verifier", "agent": agent_type, "artifactVerdict": artifact_verdict, "qualityCheck": quality_check},
            output={
                "action": retry_action.get("action") if retry_action else None,
                "nextAgent": retry_action.get("agent") if retry_action else None,
            },
        ).end()
        tracing.score(span, enabled, "verdict", "FAIL", "quality check failed, retrying reviewer")
        return

    next_action = engine.step(scope, {"role": "verifier", "artifactVerdict": artifact_verdict})
    tracing.trace(session_dir, "engine.step", scope, {
        "agent": agent_type, "role": "verifier", "verdict": artifact_verdict,
        "qualityCheck": quality_check, "action": next_action.get("action") if next_action else None,
    })
    _log_action(session_dir, next_action, scope)
    span.span(
        name="engine-step",
        input={"role": "verifier", "agent": agent_type, "artifactVerdict": artifact_verdict, "qualityCheck": quality_check},
        output={
            "action": next_action.get("action") if next_action else None,
            "nextAgent": next_action.get("agent") if next_action else None,
        },
    ).end()


def _handle_fixer(
    repo: PipelineRepository,
    engine: PipelineEngine,
    scope: str,
    agent_type: str,
    artifact_path: str,
    artifact_content: str,
    artifact_verdict: str,
    scope_context: str,
    session_dir: str,
    session_id: str,
    span: Any,
    enabled: bool,
) -> None:
    semantic_result = _run_semantic_check(
        "Did this fix address the revision instructions?",
        artifact_content, artifact_path, scope_context,
        True, session_id, scope,
    )
    _write_audit(session_dir, scope, agent_type, artifact_path, semantic_result)

    quality_check = (
        semantic_result.get("check") or semantic_result.get("verdict")
        if semantic_result else None
    )
    _record_verdict(repo, scope, agent_type, artifact_verdict)
    span.span(
        name="semantic-check",
        input={"prompt": "implicit-fixer-check", "agent": agent_type,
               "artifactPath": os.path.basename(artifact_path), "artifactSize": len(artifact_content)},
        output={"verdict": quality_check, "reason": semantic_result.get("reason") if semantic_result else None},
    ).end()
    tracing.score(span, enabled, "verdict", quality_check or "UNKNOWN",
                  semantic_result.get("reason") if semantic_result else None)

    next_action = engine.step(scope, {"role": "fixer", "artifactVerdict": artifact_verdict})
    tracing.trace(session_dir, "engine.step", scope, {
        "agent": agent_type, "role": "fixer", "verdict": artifact_verdict,
        "qualityCheck": quality_check, "action": next_action.get("action") if next_action else None,
    })
    _log_action(session_dir, next_action, scope)
    span.span(
        name="engine-step",
        input={"role": "fixer", "agent": agent_type, "artifactVerdict": artifact_verdict, "qualityCheck": quality_check},
        output={
            "action": next_action.get("action") if next_action else None,
            "nextAgent": next_action.get("agent") if next_action else None,
        },
    ).end()


def _handle_transformer(
    repo: PipelineRepository,
    engine: PipelineEngine,
    scope: str,
    agent_type: str,
    artifact_path: str,
    session_dir: str,
    span: Any,
    enabled: bool,
) -> None:
    _record_verdict(repo, scope, agent_type, "PASS")
    next_action = engine.step(scope, {"role": "transformer", "artifactVerdict": "PASS"})
    tracing.trace(session_dir, "engine.step", scope, {
        "agent": agent_type, "role": "transformer", "verdict": "PASS",
        "action": next_action.get("action") if next_action else None,
    })
    _log_action(session_dir, next_action, scope)
    span.span(
        name="engine-step",
        input={"role": "transformer", "agent": agent_type},
        output={
            "action": next_action.get("action") if next_action else None,
            "nextAgent": next_action.get("agent") if next_action else None,
        },
    ).end()
    tracing.score(span, enabled, "verdict", "PASS")


# ── Dispatch ──────────────────────────────────────────────────────────


def _dispatch(
    role: AgentRole,
    repo: PipelineRepository,
    engine: PipelineEngine,
    scope: str,
    agent_type: str,
    artifact_path: str,
    artifact_content: str,
    artifact_verdict: str,
    scope_context: str,
    session_dir: str,
    session_id: str,
    span: Any,
    enabled: bool,
) -> None:
    if role == AgentRole.Transformer:
        _handle_transformer(repo, engine, scope, agent_type, artifact_path, session_dir, span, enabled)
    elif role == AgentRole.Source:
        _handle_source(repo, engine, scope, agent_type, artifact_path, artifact_content,
                       artifact_verdict, scope_context, session_dir, session_id, span, enabled)
    elif role == AgentRole.Verifier:
        _handle_verifier(repo, engine, scope, agent_type, artifact_path, artifact_content,
                         artifact_verdict, scope_context, session_dir, session_id, span, enabled)
    elif role == AgentRole.Fixer:
        _handle_fixer(repo, engine, scope, agent_type, artifact_path, artifact_content,
                      artifact_verdict, scope_context, session_dir, session_id, span, enabled)


# ── Main handler ──────────────────────────────────────────────────────


def on_subagent_stop(data: dict) -> dict:
    if is_gate_disabled():
        return {}

    is_continuation = bool(data.get("stop_hook_active"))
    agent_type = data.get("agent_type") or ""
    if not agent_type:
        return {}

    bare_agent_type = agent_type.split(":")[-1] if ":" in agent_type else agent_type
    agent_id = data.get("agent_id") or "unknown"
    session_id = data.get("session_id") or "unknown"
    session_dir = get_session_dir(session_id)
    last_message = data.get("last_assistant_message") or ""

    agent_md_path = find_agent_md(bare_agent_type, PROJECT_ROOT, HOME)
    md_content = None
    if agent_md_path:
        try:
            with open(agent_md_path, "r", encoding="utf-8") as f:
                md_content = f.read()
        except Exception:
            pass

    db = None
    try:
        db = open_database(session_dir)
        PipelineRepository.init_schema(db)
        repo = PipelineRepository(db)
        pipeline_engine = PipelineEngine(repo)

        resolved = _resolve_scope(data, repo, session_dir, bare_agent_type)
        scope = resolved["scope"]
        artifact_path = resolved.get("artifactPath")

        agent_spawn_time = 0
        if scope:
            marker_path = agent_running_marker(session_dir, scope)
            try:
                agent_spawn_time = os.stat(marker_path).st_mtime_ns // 1_000_000  # ms
            except Exception:
                pass
            try:
                os.unlink(marker_path)
            except Exception:
                pass

        if scope:
            correct_path = os.path.join(session_dir, scope, f"{bare_agent_type}.md")
            temp_path = os.path.join(session_dir, f"{agent_id}.md")
            scope_dir = os.path.dirname(correct_path)

            if os.path.exists(temp_path):
                os.makedirs(scope_dir, exist_ok=True)
                try:
                    shutil.copy2(temp_path, correct_path)
                    os.unlink(temp_path)
                except Exception:
                    pass
            elif last_message:
                os.makedirs(scope_dir, exist_ok=True)
                if not os.path.exists(correct_path) and not is_continuation:
                    write_path = correct_path.replace("\\", "/")
                    pivot_msg = f"Your work is done. Write your complete findings to: {write_path}"
                    pivot_msg += (
                        "\nThis artifact will be verified. Include evidence from tool output "
                        "(file reads, diffs, test results) — assertions without evidence will be rejected."
                    )
                    try:
                        role_check = pipeline_engine.resolve_role(scope, bare_agent_type)
                        active_step = repo.get_active_step(scope)
                        if role_check == AgentRole.Verifier:
                            pivot_msg += "\nYou are a verifier. End with exactly one: Result: PASS, Result: REVISE, Result: FAIL, or Result: CONVERGED."
                        elif active_step and active_step.get("step_type") == StepType.Check and active_step.get("prompt"):
                            pivot_msg += f"\nVerification criteria: {active_step['prompt']}"
                        elif active_step and active_step.get("step_type") in (StepType.Verify, StepType.VerifyWithFixer):
                            pivot_msg += f"\nA reviewer ({active_step.get('agent')}) will evaluate this artifact next."
                    except Exception:
                        pass
                    return block("\U0001f6d1", pivot_msg)
                elif not os.path.exists(correct_path) and is_continuation:
                    try:
                        with open(correct_path, "w", encoding="utf-8") as f:
                            f.write(last_message)
                    except Exception:
                        pass
                elif os.path.exists(correct_path) and agent_spawn_time > 0:
                    try:
                        file_mtime_ms = os.stat(correct_path).st_mtime_ns // 1_000_000
                        if file_mtime_ms < agent_spawn_time:
                            with open(correct_path, "w", encoding="utf-8") as f:
                                f.write(last_message)
                    except Exception:
                        pass

            if os.path.exists(correct_path):
                artifact_path = correct_path

        if not scope and last_message:
            info = _extract_artifact_path(last_message, session_dir, agent_type)
            if info:
                scope = info["scope"]
                artifact_path = info["artifactPath"]

        if not scope:
            found = repo.find_agent_scope(bare_agent_type)
            if found:
                scope = found
                candidate = os.path.join(session_dir, scope, f"{bare_agent_type}.md")
                if os.path.exists(candidate):
                    artifact_path = candidate

        # Clean up running marker if scope was resolved via fallback
        if scope and agent_spawn_time == 0:
            marker_path = agent_running_marker(session_dir, scope)
            try:
                os.unlink(marker_path)
            except Exception:
                pass

        if scope and md_content:
            steps = parse_verification(md_content)
            if steps and not repo.pipeline_exists(scope):
                pipeline_engine.create_pipeline(scope, bare_agent_type, steps)
                tracing.trace(session_dir, "pipeline.create", scope, {
                    "source": bare_agent_type,
                    "steps": [s.get("type") for s in steps],
                })
                notify(
                    session_dir, "⚡",
                    f"pipeline: Initialized {len(steps)} step(s) for scope=\"{scope}\": "
                    + " → ".join(s.get("type", "") for s in steps) + ".",
                )

        role = pipeline_engine.resolve_role(scope, bare_agent_type) if scope else AgentRole.Ungated

        if role == AgentRole.Ungated:
            if md_content:
                steps = parse_verification(md_content)
                if steps and not scope:
                    notify(
                        session_dir, "",
                        f'Agent "{bare_agent_type}" has verification: but no scope. '
                        "Add scope=<name> to the spawn prompt.",
                    )
            return {}

        if not artifact_path or not os.path.exists(artifact_path):
            if scope:
                expected = f"{session_dir.replace(chr(92), '/')}/{scope}/{bare_agent_type}.md"
                notify(
                    session_dir, "",
                    f"{bare_agent_type} completed without artifact. Treating as FAIL. Expected: {expected}",
                )
                tracing.trace(session_dir, "verdict.no-artifact", scope, {"agent": bare_agent_type, "role": role})
                pipeline_engine.step(scope, {"role": role, "artifactVerdict": "FAIL"})
            return {}

        artifact_content = ""
        try:
            with open(artifact_path, "r", encoding="utf-8") as f:
                artifact_content = f.read()
        except Exception:
            pass

        verdict_match = re.search(
            r"^(?:\*{0,2})(?:Result|Verdict):?\s*(PASS|FAIL|REVISE|CONVERGED)",
            artifact_content, re.MULTILINE | re.IGNORECASE
        )
        artifact_verdict = verdict_match.group(1).upper() if verdict_match else "UNKNOWN"

        scope_context = _gather_scope_context(session_dir, scope, agent_type)

        lf_ctx = tracing.init()
        langfuse = lf_ctx["langfuse"]
        enabled = lf_ctx["enabled"]
        trace_obj = tracing.get_or_create_trace(langfuse, enabled, db, scope, session_id)
        scope_span = tracing.scope_span(trace_obj, scope)

        _dispatch(
            role=role,
            repo=repo,
            engine=pipeline_engine,
            scope=scope,
            agent_type=bare_agent_type,
            artifact_path=artifact_path,
            artifact_content=artifact_content,
            artifact_verdict=artifact_verdict,
            scope_context=scope_context,
            session_dir=session_dir,
            session_id=session_id,
            span=scope_span,
            enabled=enabled,
        )

        scope_span.end()
        tracing.flush(langfuse, enabled)

        return {}

    except Exception as err:
        log("⚠️", f"Error: {err}")
        return {}
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:
                pass


# ── Entry point ───────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        raw = sys.stdin.read()
        result = on_subagent_stop(json.loads(raw))
        if result:
            sys.stdout.write(json.dumps(result))
    except Exception as err:
        log("⚠️", f"Error: {err}")
