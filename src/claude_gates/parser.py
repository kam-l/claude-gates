"""Port of FrontmatterParser.ts — pure regex/parsing, no YAML library."""

from __future__ import annotations

import re
from pathlib import Path
from typing import List, Optional

from claude_gates.types import (
    ICheckStep,
    ITransformStep,
    IVerifyStep,
    IVerifyWithFixerStep,
    StepType,
    VerificationStep,
)


def extract_frontmatter(md_content: str) -> Optional[str]:
    """Extract raw YAML-like content between --- fences.

    Returns the inner content (without fences) or None if not found.
    Always normalizes \\r\\n to \\n before processing.
    """
    content = md_content.replace("\r\n", "\n")
    match = re.match(r"^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)", content)
    return match.group(1) if match else None


def parse_verification(md_content: str) -> Optional[List[VerificationStep]]:
    """Parse the ``verification:`` block from frontmatter.

    Returns a list of VerificationStep (may be empty), or None if no
    frontmatter or no verification block exists.
    """
    content = md_content.replace("\r\n", "\n")
    fm = extract_frontmatter(content)
    if fm is None:
        return None

    # Match the verification: block — list items follow
    block_match = re.search(r"^verification:\s*\n((?:\s+-\s*.*\n?)+)", fm, re.MULTILINE)
    if not block_match:
        # Check if verification: key exists at all but is empty
        if re.search(r"^verification:\s*$", fm, re.MULTILINE):
            return []
        return None

    steps: List[VerificationStep] = []
    for line in block_match.group(1).split("\n"):
        trimmed = line.strip()
        if not trimmed or not trimmed.startswith("-"):
            continue

        arr_match = re.match(r"^-\s*\[(.+)\]\s*$", trimmed)
        if not arr_match:
            continue

        inner = arr_match.group(1).strip()
        step = _parse_step_array(inner)
        if step:
            steps.append(step)

    return steps


def parse_conditions(md_content: str) -> Optional[str]:
    """Parse the ``conditions: |`` block from frontmatter.

    Returns trimmed conditions text or None.
    """
    content = md_content.replace("\r\n", "\n")
    fm = extract_frontmatter(content)
    if fm is None:
        return None

    c_match = re.search(r"^conditions:\s*\|\s*\n((?:[ ]{2,}.*\n?)+)", fm, re.MULTILINE)
    if c_match:
        lines = c_match.group(1).split("\n")
        stripped = [re.sub(r"^ {2}", "", line) for line in lines]
        return "\n".join(stripped).strip()
    return None


def requires_scope(md_content: str) -> bool:
    """Return True if the agent frontmatter indicates a pipeline scope is needed."""
    content = md_content.replace("\r\n", "\n")
    fm = extract_frontmatter(content)
    if fm is None:
        return False
    if re.search(r"^verification:\s*\n\s+-", fm, re.MULTILINE):
        return True
    if re.search(r"^conditions\s*:", fm, re.MULTILINE):
        return True
    return False


def find_agent_md(
    agent_type: str,
    project_root: Optional[str],
    home: Optional[str],
) -> Optional[str]:
    """Search for an agent .md file in project then global .claude/agents/.

    Returns the absolute path string if found, else None.
    Only searches exactly:
      {project_root}/.claude/agents/{agent_type}.md
      {home}/.claude/agents/{agent_type}.md
    """
    if project_root:
        project_path = Path(project_root) / ".claude" / "agents" / f"{agent_type}.md"
        if project_path.exists():
            return str(project_path)
    if home:
        global_path = Path(home) / ".claude" / "agents" / f"{agent_type}.md"
        if global_path.exists():
            return str(global_path)
    return None


# ── Private helpers ────────────────────────────────────────────────────


def _parse_step_array(inner: str) -> Optional[VerificationStep]:
    """Parse the contents of a ``[...]`` step array string.

    Returns the appropriate VerificationStep TypedDict or None on parse error.
    """
    if not inner:
        return None

    # CHECK step: single quoted/double-quoted string
    semantic_match = re.match(r'^(["\'])(.+)\1$', inner)
    if semantic_match:
        step: ICheckStep = {"type": StepType.Check, "prompt": semantic_match.group(2)}
        return step

    parts = _split_csv(inner)
    if not parts:
        return None

    first = parts[0]

    # TRANSFORM (command style): starts with /
    if first.startswith("/"):
        t_step: ITransformStep = {
            "type": StepType.Transform,
            "agent": first[1:],
            "maxRounds": 1,
        }
        return t_step

    raw_agent = _unquote(first)
    if not raw_agent:
        return None

    # Validate suffix — reject double suffixes (AC1)
    has_bang = raw_agent.endswith("!")
    has_question = raw_agent.endswith("?")

    # Check for double suffix: both ! and ? present
    if "!" in raw_agent and "?" in raw_agent:
        return None

    is_transform = has_bang
    # Strip trailing ! or ? to get base name
    agent_name = re.sub(r"[!?]$", "", raw_agent)
    if not agent_name or not re.match(r"^[A-Za-z0-9_-]+$", agent_name):
        return None

    if is_transform:
        max_rounds_raw = int(parts[1]) if len(parts) >= 2 else 1
        tr_step: ITransformStep = {
            "type": StepType.Transform,
            "agent": agent_name,
            "maxRounds": max_rounds_raw,
        }
        return tr_step

    # VERIFY or VERIFY_W_FIXER
    max_rounds = int(parts[1]) if len(parts) >= 2 else 3
    if not isinstance(max_rounds, int):
        return None

    if len(parts) >= 3:
        raw_fixer = _unquote(parts[2])
        fixer_name = re.sub(r"[!?]$", "", raw_fixer) if raw_fixer else None
        if fixer_name and re.match(r"^[A-Za-z0-9_-]+$", fixer_name):
            vwf_step: IVerifyWithFixerStep = {
                "type": StepType.VerifyWithFixer,
                "agent": agent_name,
                "maxRounds": max_rounds,
                "fixer": fixer_name,
            }
            return vwf_step

    v_step: IVerifyStep = {
        "type": StepType.Verify,
        "agent": agent_name,
        "maxRounds": max_rounds,
    }
    return v_step


def _split_csv(s: str) -> List[str]:
    """Quote-aware CSV split — commas inside quotes are not split points."""
    parts: List[str] = []
    current = ""
    in_quote = False
    quote_char = ""

    for ch in s:
        if in_quote:
            if ch == quote_char:
                in_quote = False
            else:
                current += ch
        elif ch in ('"', "'"):
            in_quote = True
            quote_char = ch
        elif ch == ",":
            if current.strip():
                parts.append(current.strip())
            current = ""
        else:
            current += ch

    if current.strip():
        parts.append(current.strip())
    return parts


def _unquote(s: str) -> str:
    """Strip surrounding matching quotes from a string."""
    if not s:
        return s
    t = s.strip()
    if len(t) >= 2 and (
        (t.startswith('"') and t.endswith('"'))
        or (t.startswith("'") and t.endswith("'"))
    ):
        return t[1:-1]
    return t
