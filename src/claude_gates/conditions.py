from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from typing import Optional

from claude_gates.engine import PipelineEngine
from claude_gates.messaging import block, log
from claude_gates.parser import find_agent_md, parse_conditions, requires_scope
from claude_gates.repository import PipelineRepository
from claude_gates.session import (
    agent_running_marker,
    get_session_dir,
    is_gate_disabled,
    open_database,
)
from claude_gates.tracing import trace

HOME: str = os.environ.get("USERPROFILE") or os.environ.get("HOME") or ""
PROJECT_ROOT: str = os.getcwd()


def on_conditions_check(data: dict) -> dict:
    if is_gate_disabled():
        return {}

    tool_input: dict = data.get("tool_input") or {}
    agent_type: str = tool_input.get("subagent_type") or ""
    prompt: str = tool_input.get("prompt") or ""

    if tool_input.get("resume"):
        return {}

    if not agent_type:
        return {}

    bare_agent_type = agent_type.split(":")[-1] if ":" in agent_type else agent_type

    agent_md_path = find_agent_md(bare_agent_type, PROJECT_ROOT, HOME)
    md_content: Optional[str] = None
    if agent_md_path:
        try:
            with open(agent_md_path, "r", encoding="utf-8") as f:
                md_content = f.read()
        except OSError:
            pass

    scope_match = re.search(r"scope=([A-Za-z0-9_-]+)", prompt)
    scope: Optional[str] = scope_match.group(1) if scope_match else None

    if not scope:
        if md_content and requires_scope(md_content):
            return block(
                "\U0001f510",
                f'Agent "{bare_agent_type}" needs scope=<name>. Add it to the spawn prompt.',
            )
        return {}

    if scope == "_pending" or scope == "_meta":
        return block(
            "\U0001f510",
            f'Scope "{scope}" is reserved for internal use. Use a different scope name.',
        )

    if not agent_md_path or not md_content:
        return {}

    session_id: str = data.get("session_id") or ""
    if not session_id:
        return {}
    session_dir = get_session_dir(session_id)

    conditions_text = parse_conditions(md_content)
    if conditions_text:
        cond_result = _run_conditions_check(conditions_text, prompt, bare_agent_type)
        if cond_result is not None:
            return cond_result

    db = None
    try:
        db = open_database(session_dir)
        PipelineRepository.init_schema(db)
        repo = PipelineRepository(db)
        pipeline_engine = PipelineEngine(repo)
        actions = pipeline_engine.get_all_next_actions()

        if actions:
            scope_action = next((a for a in actions if a.get("scope") == scope), None)
            if scope_action:
                action_type = scope_action.get("action")
                expected_agent = scope_action.get("agent")
                if action_type in ("spawn", "source") and expected_agent != bare_agent_type:
                    db.close()
                    db = None
                    return block(
                        "\U0001f510",
                        f'Scope "{scope}" expects "{expected_agent}", not "{bare_agent_type}".'
                        f" Spawn {expected_agent}.",
                    )

        scope_dir = os.path.join(session_dir, scope)
        os.makedirs(scope_dir, exist_ok=True)

        output_filepath = os.path.join(scope_dir, f"{bare_agent_type}.md").replace("\\", "/")
        repo.register_agent(scope, bare_agent_type, output_filepath)
        trace(session_dir, "spawn.allow", scope, {"agent": bare_agent_type})

        try:
            marker = agent_running_marker(session_dir, scope)
            with open(marker, "w", encoding="utf-8") as f:
                f.write("")
        except OSError:
            pass

        try:
            pending_marker = os.path.join(session_dir, f".pending-scope-{bare_agent_type}")
            with open(pending_marker, "w", encoding="utf-8") as f:
                f.write(scope)
        except OSError:
            pass

        if requires_scope(md_content):
            log(
                "\U0001f510",
                f"{bare_agent_type} (scope={scope}) has verification gates"
                " — process its results before starting unrelated work.",
            )

    finally:
        if db is not None:
            try:
                db.close()
            except Exception:
                pass

    return {}


def _run_conditions_check(
    conditions_text: str,
    prompt: str,
    bare_agent_type: str,
) -> Optional[dict]:
    try:
        claude_cmd = shutil.which("claude") or "claude"
        cond_prompt = conditions_text + "\n\nAgent spawn prompt:\n" + prompt
        result = subprocess.run(
            [
                claude_cmd,
                "-p",
                "--model",
                "sonnet",
                "--agent",
                "claude-gates:gater",
                "--max-turns",
                "1",
                "--tools",
                "",
                "--no-chrome",
                "--strict-mcp-config",
                "--disable-slash-commands",
                "--no-session-persistence",
            ],
            input=cond_prompt,
            capture_output=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=PROJECT_ROOT,
            timeout=30,
            env={**os.environ, "CLAUDECODE": ""},
        )
        cond_output = (result.stdout or "").strip()
        cond_match = re.search(
            r"^Result:\s*(PASS|FAIL|REVISE|CONVERGED)\b(.*)?$",
            cond_output,
            re.MULTILINE | re.IGNORECASE,
        )
        cond_raw = cond_match.group(1).upper() if cond_match else "UNKNOWN"
        cond_verdict = "FAIL" if cond_raw in ("FAIL", "REVISE") else "PASS"

        if cond_verdict == "FAIL":
            reason_suffix = (
                cond_match.group(2).strip() if cond_match and cond_match.group(2) else ""
            )
            reason = reason_suffix or "Pre-spawn conditions check failed"
            return block("\U0001f510", f"Failed for {bare_agent_type}: {reason}")

        log("\u2705", f"{cond_verdict} for {bare_agent_type}")
        return None

    except subprocess.TimeoutExpired:
        sys.stderr.write(
            f"[ClaudeGates] \u26a0\ufe0f Conditions check timed out for {bare_agent_type}"
            " (claude -p timeout). Allowing (fail-open).\n"
        )
        return None
    except Exception:
        log("\u26a0\ufe0f", f"Skipped for {bare_agent_type} (claude -p unavailable)")
        return None
