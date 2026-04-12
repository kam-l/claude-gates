import os
import sys
import unittest
from unittest.mock import patch, MagicMock

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


# ─────────────────────────────────────────────────────────────────────────────
# AC1: Regex matches "gate" and "gates" (case-insensitive)
# ─────────────────────────────────────────────────────────────────────────────

class TestParseToggleCommand(unittest.TestCase):
    def _parse(self, prompt: str):
        from src.claude_gates.gate_toggle import parse_toggle_command
        return parse_toggle_command(prompt)

    def test_gate_off_uppercase(self):
        """'Gate OFF' should match and return 'off'."""
        self.assertEqual(self._parse("Gate OFF"), "off")

    def test_gates_on_lowercase(self):
        """'gates on' should match and return 'on'."""
        self.assertEqual(self._parse("gates on"), "on")

    def test_gates_status_uppercase(self):
        """'GATES STATUS' should match and return 'status'."""
        self.assertEqual(self._parse("GATES STATUS"), "status")

    def test_double_space_returns_none(self):
        """'gate  on' (double space) should NOT match — returns None."""
        self.assertIsNone(self._parse("gate  on"))

    def test_non_matching_text_returns_none(self):
        """Arbitrary text should return None."""
        self.assertIsNone(self._parse("hello world"))

    def test_leading_whitespace_stripped(self):
        """Leading/trailing whitespace around prompt is stripped before matching."""
        self.assertEqual(self._parse("  gate on  "), "on")

    def test_gate_on_lowercase(self):
        """'gate on' should return 'on'."""
        self.assertEqual(self._parse("gate on"), "on")

    def test_gate_status_lowercase(self):
        """'gate status' should return 'status'."""
        self.assertEqual(self._parse("gate status"), "status")

    def test_empty_string_returns_none(self):
        """Empty string should return None."""
        self.assertIsNone(self._parse(""))

    def test_gate_alone_returns_none(self):
        """'gate' with no subcommand should return None."""
        self.assertIsNone(self._parse("gate"))


# ─────────────────────────────────────────────────────────────────────────────
# AC2: "gate status" returns current state as block
# ─────────────────────────────────────────────────────────────────────────────

class TestGateStatus(unittest.TestCase):
    def _run(self, data: dict, gate_disabled: bool) -> dict:
        from src.claude_gates import gate_toggle
        with patch("src.claude_gates.gate_toggle.is_gate_disabled", return_value=gate_disabled):
            return gate_toggle.on_user_prompt(data)

    def test_status_when_gate_on_returns_block(self):
        """'gate status' when gate enabled → block with 'Gates are currently ON.'"""
        result = self._run({"prompt": "gate status"}, gate_disabled=False)
        self.assertEqual(result.get("decision"), "block")

    def test_status_when_gate_on_mentions_on(self):
        result = self._run({"prompt": "gate status"}, gate_disabled=False)
        self.assertIn("ON", result.get("reason", ""))

    def test_status_when_gate_off_returns_block(self):
        """'gate status' when gate disabled → block with 'Gates are currently OFF.'"""
        result = self._run({"prompt": "gate status"}, gate_disabled=True)
        self.assertEqual(result.get("decision"), "block")

    def test_status_when_gate_off_mentions_off(self):
        result = self._run({"prompt": "gate status"}, gate_disabled=True)
        self.assertIn("OFF", result.get("reason", ""))


# ─────────────────────────────────────────────────────────────────────────────
# AC3: "gate off" sets disabled marker + returns block
# ─────────────────────────────────────────────────────────────────────────────

class TestGateOff(unittest.TestCase):
    def test_gate_off_calls_set_gate_disabled_true(self):
        """'gate off' must call session.set_gate_disabled(True)."""
        from src.claude_gates import gate_toggle
        with patch("src.claude_gates.gate_toggle.set_gate_disabled") as mock_set, \
             patch("src.claude_gates.gate_toggle.is_gate_disabled", return_value=False):
            gate_toggle.on_user_prompt({"prompt": "gate off"})
        mock_set.assert_called_once_with(True)

    def test_gate_off_returns_block(self):
        """'gate off' returns a block dict."""
        from src.claude_gates import gate_toggle
        with patch("src.claude_gates.gate_toggle.set_gate_disabled"), \
             patch("src.claude_gates.gate_toggle.is_gate_disabled", return_value=False):
            result = gate_toggle.on_user_prompt({"prompt": "gate off"})
        self.assertEqual(result.get("decision"), "block")

    def test_gate_off_message_contains_disabled(self):
        """Block reason for 'gate off' should mention 'disabled'."""
        from src.claude_gates import gate_toggle
        with patch("src.claude_gates.gate_toggle.set_gate_disabled"), \
             patch("src.claude_gates.gate_toggle.is_gate_disabled", return_value=False):
            result = gate_toggle.on_user_prompt({"prompt": "gate off"})
        self.assertIn("disabled", result.get("reason", ""))

    def test_gate_off_message_contains_reenable_hint(self):
        """Block reason for 'gate off' should include 'gate on' re-enable hint."""
        from src.claude_gates import gate_toggle
        with patch("src.claude_gates.gate_toggle.set_gate_disabled"), \
             patch("src.claude_gates.gate_toggle.is_gate_disabled", return_value=False):
            result = gate_toggle.on_user_prompt({"prompt": "gate off"})
        self.assertIn("gate on", result.get("reason", ""))


# ─────────────────────────────────────────────────────────────────────────────
# AC4: "gate on" clears disabled marker + returns block
# ─────────────────────────────────────────────────────────────────────────────

class TestGateOn(unittest.TestCase):
    def test_gate_on_calls_set_gate_disabled_false(self):
        """'gate on' must call session.set_gate_disabled(False)."""
        from src.claude_gates import gate_toggle
        with patch("src.claude_gates.gate_toggle.set_gate_disabled") as mock_set, \
             patch("src.claude_gates.gate_toggle.is_gate_disabled", return_value=True):
            gate_toggle.on_user_prompt({"prompt": "gate on"})
        mock_set.assert_called_once_with(False)

    def test_gate_on_returns_block(self):
        """'gate on' returns a block dict."""
        from src.claude_gates import gate_toggle
        with patch("src.claude_gates.gate_toggle.set_gate_disabled"), \
             patch("src.claude_gates.gate_toggle.is_gate_disabled", return_value=True):
            result = gate_toggle.on_user_prompt({"prompt": "gate on"})
        self.assertEqual(result.get("decision"), "block")

    def test_gate_on_message_contains_reenabled(self):
        """Block reason for 'gate on' should mention 're-enabled'."""
        from src.claude_gates import gate_toggle
        with patch("src.claude_gates.gate_toggle.set_gate_disabled"), \
             patch("src.claude_gates.gate_toggle.is_gate_disabled", return_value=True):
            result = gate_toggle.on_user_prompt({"prompt": "gate on"})
        self.assertIn("re-enabled", result.get("reason", ""))


# ─────────────────────────────────────────────────────────────────────────────
# AC5: Non-matching prompt returns {} (allow)
# ─────────────────────────────────────────────────────────────────────────────

class TestNonMatchingPrompt(unittest.TestCase):
    def _run(self, prompt: str) -> dict:
        from src.claude_gates import gate_toggle
        return gate_toggle.on_user_prompt({"prompt": prompt})

    def test_hello_world_returns_empty(self):
        """'hello world' does not match — returns {}."""
        self.assertEqual(self._run("hello world"), {})

    def test_normal_prompt_returns_empty(self):
        """A normal user message returns {}."""
        self.assertEqual(self._run("please review my code"), {})

    def test_no_decision_key_in_allow_result(self):
        """Allow result must not have a 'decision' key."""
        result = self._run("just a regular prompt")
        self.assertNotIn("decision", result)


# ─────────────────────────────────────────────────────────────────────────────
# Edge cases: missing/None prompt key
# ─────────────────────────────────────────────────────────────────────────────

class TestEdgeCases(unittest.TestCase):
    def test_missing_prompt_key_returns_empty(self):
        """data with no 'prompt' key — treat as empty string, return {}."""
        from src.claude_gates import gate_toggle
        result = gate_toggle.on_user_prompt({})
        self.assertEqual(result, {})

    def test_none_prompt_returns_empty(self):
        """data with prompt=None — coerce to empty string, return {}."""
        from src.claude_gates import gate_toggle
        result = gate_toggle.on_user_prompt({"prompt": None})
        self.assertEqual(result, {})

    def test_whitespace_only_prompt_returns_empty(self):
        """Whitespace-only prompt does not match any command."""
        from src.claude_gates import gate_toggle
        result = gate_toggle.on_user_prompt({"prompt": "   "})
        self.assertEqual(result, {})


if __name__ == "__main__":
    unittest.main()
