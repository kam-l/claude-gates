"""Port of SessionContext.ts — SessionStart hook.

Scans for gated agents, builds a startup banner showing active gates,
verification pipelines, and toggle hints. Also injects behavioral guidance
so the orchestrator knows pipeline gates block other work.

Fail-open.
"""

from __future__ import annotations

import os
import sys
from typing import List, Optional

# Guard 3.11+-only imports: StrEnum (used in types.py and parser.py) is unavailable
# on Python 3.10. This module must be importable on 3.10 so that the version check
# in on_session_start() can fire and return a friendly error instead of crashing with
# an unhandled ImportError. All functions below that reference these names are only
# called after the version check passes.
if sys.version_info >= (3, 11):
    from claude_gates import parser
    from claude_gates.session import is_gate_disabled
    from claude_gates.types import IAgentSummary, StepType, VerificationStep

HOME: str = os.environ.get("USERPROFILE") or os.environ.get("HOME") or ""
PROJECT_ROOT: str = os.getcwd()


# ── Exported helpers ───────────────────────────────────────────────────────────


def format_step(step: VerificationStep) -> str:
    """Return human-readable description of a single verification step."""
    step_type = step["type"]

    if step_type == StepType.Check:
        prompt = step["prompt"]  # type: ignore[index]
        truncated = prompt[:40] + "..." if len(prompt) > 40 else prompt
        return f'CHECK("{truncated}")'

    if step_type == StepType.VerifyWithFixer:
        return f'VERIFY({step["agent"]}, {step["maxRounds"]}, {step["fixer"]})'  # type: ignore[index]

    if step_type == StepType.Verify:
        return f'VERIFY({step["agent"]}, {step["maxRounds"]})'  # type: ignore[index]

    if step_type == StepType.Transform:
        return f'TRANSFORM({step["agent"]})'  # type: ignore[index]

    return str(step_type)


def format_pipeline(steps: List[VerificationStep]) -> str:
    """Join verification steps with Unicode arrow separator."""
    return " \u2192 ".join(format_step(s) for s in steps)


def discover_gated_agents(
    project_dir: Optional[str],
    global_dir: Optional[str],
) -> List[IAgentSummary]:
    """Scan .claude/agents/ dirs for agents with verification: frontmatter.

    Project agents are scanned first and shadow global agents with the same name.
    Unreadable files and missing directories are silently skipped.
    """
    seen: set[str] = set()
    results: List[IAgentSummary] = []

    def scan_dir(base_dir: str, source: str) -> None:
        agents_path = os.path.join(base_dir, ".claude", "agents")
        try:
            entries = os.listdir(agents_path)
        except OSError:
            return

        for filename in entries:
            if not filename.endswith(".md"):
                continue
            name = filename[:-3]  # strip .md
            if name in seen:
                continue

            filepath = os.path.join(agents_path, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    content = f.read()
            except OSError:
                # Unreadable file — spec-required skip
                continue
            try:
                steps = parser.parse_verification(content)
                if steps is not None:
                    seen.add(name)
                    results.append({"name": name, "source": source, "steps": steps})  # type: ignore[arg-type,typeddict-item]
            except Exception:
                # Skip files whose frontmatter cannot be parsed
                pass

    if project_dir:
        scan_dir(project_dir, "project")
    if global_dir:
        scan_dir(global_dir, "global")

    return results


def build_banner(gate_disabled: bool) -> str:
    """Build the multi-line session startup banner."""
    lines: List[str] = []

    if gate_disabled:
        lines.append("[ClaudeGates] Session gates: PAUSED")
    else:
        lines.append("[ClaudeGates] Session gates:")

    lines.append("  Plan Gate: OFF" if gate_disabled else "  Plan Gate: ON")

    agents = discover_gated_agents(PROJECT_ROOT, HOME)
    if not agents:
        lines.append("  (no gated agents)")
    else:
        for agent in agents:
            suffix = " (global)" if agent["source"] == "global" else ""
            pipeline = format_pipeline(agent["steps"])
            lines.append(f"  {agent['name']}: {pipeline}{suffix}")

    if gate_disabled:
        lines.append('Toggle: "gate on" to resume.')
    else:
        lines.append('Toggle: "gate off" to pause, "gate on" to resume.')

    port = os.environ.get("CLAUDE_GATES_PORT") or "64735"
    lines.append(f"Monitor: http://localhost:{port}")

    return "\n".join(lines)


def on_session_start(data: dict) -> dict:
    """SessionStart hook handler.

    Builds the banner, writes it to stderr, and returns additionalContext
    with the banner plus behavioral guidance for the orchestrator.
    """
    if sys.version_info < (3, 11):
        version_str = f"{sys.version_info.major}.{sys.version_info.minor}"
        message = f"[ClaudeGates] Python 3.11+ required (found {version_str}). Gates disabled."
        sys.stderr.write(message + "\n")
        return {"systemMessage": message}

    try:
        gate_disabled = is_gate_disabled()
        banner = build_banner(gate_disabled)

        sys.stderr.write(banner + "\n")

        model_context = (
            banner
            + "\n\n"
            + "Agents with `verification:` in their frontmatter have pipeline gates. "
            + "After each gated agent completes, its verification steps (reviewers, semantic checks) "
            + "will block other tools until processed. Plan accordingly: process gated agent results "
            + "before starting unrelated work. Run gated agents in foreground, not background."
        )

        return {"additionalContext": model_context}
    except Exception:
        return {}
