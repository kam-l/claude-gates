"""Tests for src/claude_gates/parser.py"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

from claude_gates.parser import (
    _parse_step_array,
    _split_csv,
    _unquote,
    extract_frontmatter,
    find_agent_md,
    parse_conditions,
    parse_verification,
    requires_scope,
)
from claude_gates.types import StepType


# ── extract_frontmatter ────────────────────────────────────────────────


class TestExtractFrontmatter:
    def test_returns_content_between_fences(self):
        md = "---\nname: test\n---\nsome body"
        result = extract_frontmatter(md)
        assert result == "name: test"

    def test_returns_none_when_no_fences(self):
        md = "no frontmatter here"
        result = extract_frontmatter(md)
        assert result is None

    def test_returns_none_when_only_opening_fence(self):
        md = "---\nname: test\n"
        result = extract_frontmatter(md)
        assert result is None

    def test_handles_windows_line_endings(self):
        md = "---\r\nname: test\r\n---\r\nbody"
        result = extract_frontmatter(md)
        assert result == "name: test"

    def test_multiline_frontmatter(self):
        md = "---\nname: test\nverification:\n  - [\"check\"]\n---\nbody"
        result = extract_frontmatter(md)
        assert "name: test" in result
        assert "verification:" in result

    def test_empty_frontmatter(self):
        md = "---\n\n---\nbody"
        result = extract_frontmatter(md)
        assert result == ""

    def test_fence_at_start_required(self):
        # Must start at beginning of content
        md = "some text\n---\nname: test\n---\nbody"
        result = extract_frontmatter(md)
        assert result is None


# ── parse_verification ─────────────────────────────────────────────────


class TestParseVerification:
    def test_check_step_from_quoted_string(self):
        md = '---\nverification:\n  - ["Semantic check prompt"]\n---'
        steps = parse_verification(md)
        assert steps is not None
        assert len(steps) == 1
        assert steps[0]["type"] == StepType.Check
        assert steps[0]["prompt"] == "Semantic check prompt"

    def test_verify_step(self):
        md = "---\nverification:\n  - [reviewer?, 3]\n---"
        steps = parse_verification(md)
        assert steps is not None
        assert len(steps) == 1
        assert steps[0]["type"] == StepType.Verify
        assert steps[0]["agent"] == "reviewer"
        assert steps[0]["maxRounds"] == 3

    def test_verify_with_fixer_step(self):
        md = "---\nverification:\n  - [reviewer?, 3, fixer!]\n---"
        steps = parse_verification(md)
        assert steps is not None
        assert len(steps) == 1
        assert steps[0]["type"] == StepType.VerifyWithFixer
        assert steps[0]["agent"] == "reviewer"
        assert steps[0]["maxRounds"] == 3
        assert steps[0]["fixer"] == "fixer"

    def test_transform_step_auto_pass(self):
        md = "---\nverification:\n  - [cleaner!, 1]\n---"
        steps = parse_verification(md)
        assert steps is not None
        assert len(steps) == 1
        assert steps[0]["type"] == StepType.Transform
        assert steps[0]["agent"] == "cleaner"
        assert steps[0]["maxRounds"] == 1

    def test_transform_command_style(self):
        md = "---\nverification:\n  - [/command, Tool1, Tool2]\n---"
        steps = parse_verification(md)
        assert steps is not None
        assert len(steps) == 1
        assert steps[0]["type"] == StepType.Transform
        assert steps[0]["agent"] == "command"

    def test_multiple_steps(self):
        md = (
            "---\nverification:\n"
            '  - ["Check prompt"]\n'
            "  - [reviewer?, 3]\n"
            "  - [fixer!, 1]\n"
            "---"
        )
        steps = parse_verification(md)
        assert steps is not None
        assert len(steps) == 3
        assert steps[0]["type"] == StepType.Check
        assert steps[1]["type"] == StepType.Verify
        assert steps[2]["type"] == StepType.Transform

    def test_returns_none_when_no_frontmatter(self):
        md = "no frontmatter here"
        result = parse_verification(md)
        assert result is None

    def test_returns_none_when_no_verification_block(self):
        md = "---\nname: test\n---\nbody"
        result = parse_verification(md)
        assert result is None

    def test_empty_verification_block_returns_empty_list(self):
        # Edge case: verification: with no items -> returns empty list not None
        # Spec says empty verification block -> empty list not None
        # However the TS impl returns null for 0 steps - the spec says empty list
        # We follow the spec acceptance criteria here
        md = "---\nverification:\n---\nbody"
        result = parse_verification(md)
        # Per spec: "Empty verification block -> returns empty list, not None"
        # But with no items there's no match for the block regex at all
        # The TS returns null here too. Let's return None since there's no block.
        # Actually the spec says: verification: with no items -> empty list
        # We'll test both - empty list OR None are both reasonable
        # The spec explicitly says empty list, so we'll assert that
        assert result is not None
        assert result == []

    def test_windows_line_endings_normalized(self):
        md = "---\r\nverification:\r\n  - [reviewer?, 3]\r\n---\r\n"
        steps = parse_verification(md)
        assert steps is not None
        assert len(steps) == 1
        assert steps[0]["type"] == StepType.Verify

    def test_single_quoted_check_step(self):
        md = "---\nverification:\n  - ['Single quoted prompt']\n---"
        steps = parse_verification(md)
        assert steps is not None
        assert steps[0]["type"] == StepType.Check
        assert steps[0]["prompt"] == "Single quoted prompt"


# ── parse_conditions ───────────────────────────────────────────────────


class TestParseConditions:
    def test_extracts_conditions_block(self):
        md = "---\nconditions: |\n  Check if X is ready\n  And Y is done\n---"
        result = parse_conditions(md)
        assert result is not None
        assert "Check if X is ready" in result
        assert "And Y is done" in result

    def test_strips_leading_two_spaces(self):
        md = "---\nconditions: |\n  Line one\n  Line two\n---"
        result = parse_conditions(md)
        # Each line should have 2 spaces stripped
        assert result == "Line one\nLine two"

    def test_returns_none_when_no_conditions(self):
        md = "---\nname: test\n---"
        result = parse_conditions(md)
        assert result is None

    def test_returns_none_when_no_frontmatter(self):
        md = "no frontmatter"
        result = parse_conditions(md)
        assert result is None

    def test_windows_line_endings(self):
        md = "---\r\nconditions: |\r\n  Check something\r\n---\r\n"
        result = parse_conditions(md)
        assert result is not None
        assert "Check something" in result

    def test_multiline_conditions_preserved(self):
        md = "---\nconditions: |\n  Line A\n  Line B\n  Line C\n---"
        result = parse_conditions(md)
        lines = result.split("\n")
        assert lines[0] == "Line A"
        assert lines[1] == "Line B"
        assert lines[2] == "Line C"


# ── requires_scope ─────────────────────────────────────────────────────


class TestRequiresScope:
    def test_true_when_verification_block(self):
        md = "---\nverification:\n  - [reviewer?, 3]\n---"
        assert requires_scope(md) is True

    def test_true_when_conditions_block(self):
        md = "---\nconditions: |\n  Check X\n---"
        assert requires_scope(md) is True

    def test_false_when_neither(self):
        md = "---\nname: simple-agent\n---"
        assert requires_scope(md) is False

    def test_false_when_no_frontmatter(self):
        md = "no frontmatter"
        assert requires_scope(md) is False

    def test_windows_line_endings(self):
        md = "---\r\nverification:\r\n  - [reviewer?, 3]\r\n---\r\n"
        assert requires_scope(md) is True


# ── find_agent_md ──────────────────────────────────────────────────────


class TestFindAgentMd:
    def test_finds_project_agent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            agents_dir = Path(tmpdir) / ".claude" / "agents"
            agents_dir.mkdir(parents=True)
            agent_file = agents_dir / "reviewer.md"
            agent_file.write_text("# Reviewer")

            result = find_agent_md("reviewer", tmpdir, None)
            assert result == str(agent_file)

    def test_finds_global_agent_when_no_project(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            agents_dir = Path(tmpdir) / ".claude" / "agents"
            agents_dir.mkdir(parents=True)
            agent_file = agents_dir / "reviewer.md"
            agent_file.write_text("# Reviewer")

            result = find_agent_md("reviewer", None, tmpdir)
            assert result == str(agent_file)

    def test_project_wins_over_global(self):
        with tempfile.TemporaryDirectory() as project_dir:
            with tempfile.TemporaryDirectory() as home_dir:
                # Create in both
                project_agents = Path(project_dir) / ".claude" / "agents"
                project_agents.mkdir(parents=True)
                proj_file = project_agents / "reviewer.md"
                proj_file.write_text("# Project Reviewer")

                home_agents = Path(home_dir) / ".claude" / "agents"
                home_agents.mkdir(parents=True)
                home_file = home_agents / "reviewer.md"
                home_file.write_text("# Global Reviewer")

                result = find_agent_md("reviewer", project_dir, home_dir)
                assert result == str(proj_file)

    def test_returns_none_when_not_found(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            result = find_agent_md("nonexistent", tmpdir, tmpdir)
            assert result is None

    def test_returns_none_when_both_none(self):
        result = find_agent_md("reviewer", None, None)
        assert result is None

    def test_only_searches_claude_agents_paths(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Put agent directly in agents/ (not .claude/agents/)
            wrong_dir = Path(tmpdir) / "agents"
            wrong_dir.mkdir()
            (wrong_dir / "reviewer.md").write_text("# Wrong place")

            result = find_agent_md("reviewer", tmpdir, None)
            assert result is None


# ── _parse_step_array ──────────────────────────────────────────────────


class TestParseStepArray:
    def test_check_step_double_quotes(self):
        step = _parse_step_array('"Semantic check prompt"')
        assert step is not None
        assert step["type"] == StepType.Check
        assert step["prompt"] == "Semantic check prompt"

    def test_check_step_single_quotes(self):
        step = _parse_step_array("'Semantic check prompt'")
        assert step is not None
        assert step["type"] == StepType.Check

    def test_verify_step(self):
        step = _parse_step_array("reviewer?, 3")
        assert step is not None
        assert step["type"] == StepType.Verify
        assert step["agent"] == "reviewer"
        assert step["maxRounds"] == 3

    def test_verify_with_fixer_step(self):
        step = _parse_step_array("reviewer?, 3, fixer!")
        assert step is not None
        assert step["type"] == StepType.VerifyWithFixer
        assert step["agent"] == "reviewer"
        assert step["fixer"] == "fixer"

    def test_transform_auto_pass(self):
        step = _parse_step_array("cleaner!, 1")
        assert step is not None
        assert step["type"] == StepType.Transform
        assert step["agent"] == "cleaner"
        assert step["maxRounds"] == 1

    def test_transform_command_slash(self):
        step = _parse_step_array("/command, Tool1, Tool2")
        assert step is not None
        assert step["type"] == StepType.Transform
        assert step["agent"] == "command"

    def test_rejects_double_suffix_bang_question(self):
        # Spec AC1: double suffix = parse error
        step = _parse_step_array("agent!?, 3")
        assert step is None

    def test_rejects_double_suffix_question_bang(self):
        # Spec AC1: double suffix = parse error
        step = _parse_step_array("agent?!, 3")
        assert step is None

    def test_agent_name_with_hyphens_and_underscores(self):
        step = _parse_step_array("my-agent_v2?, 3")
        assert step is not None
        assert step["agent"] == "my-agent_v2"

    def test_returns_none_for_empty(self):
        step = _parse_step_array("")
        assert step is None

    def test_verify_step_default_rounds(self):
        # When only 1 part and not a transform, default maxRounds = 3
        step = _parse_step_array("reviewer?")
        assert step is not None
        assert step["type"] == StepType.Verify
        assert step["maxRounds"] == 3

    def test_transform_default_rounds(self):
        # When only agent! with no rounds, default = 1
        step = _parse_step_array("cleaner!")
        assert step is not None
        assert step["type"] == StepType.Transform
        assert step["maxRounds"] == 1


# ── _split_csv ─────────────────────────────────────────────────────────


class TestSplitCsv:
    def test_simple_csv(self):
        result = _split_csv("a, b, c")
        assert result == ["a", "b", "c"]

    def test_quoted_comma_inside(self):
        result = _split_csv('"a, b", c')
        assert result == ["a, b", "c"]

    def test_single_item(self):
        result = _split_csv("reviewer?")
        assert result == ["reviewer?"]

    def test_empty_string(self):
        result = _split_csv("")
        assert result == []

    def test_preserves_quotes_stripped(self):
        # splitCSV strips content inside quotes
        result = _split_csv('"hello world", test')
        assert result == ["hello world", "test"]


# ── _unquote ───────────────────────────────────────────────────────────


class TestUnquote:
    def test_strips_double_quotes(self):
        assert _unquote('"hello"') == "hello"

    def test_strips_single_quotes(self):
        assert _unquote("'hello'") == "hello"

    def test_no_quotes_unchanged(self):
        assert _unquote("hello") == "hello"

    def test_empty_string(self):
        assert _unquote("") == ""

    def test_mismatched_quotes_unchanged(self):
        # Only strips when both start and end match
        assert _unquote('"hello\'') == '"hello\''
