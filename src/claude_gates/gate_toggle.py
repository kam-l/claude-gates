import re
import sys

from claude_gates.messaging import block, fmt
from claude_gates.session import is_gate_disabled, set_gate_disabled

TOGGLE_PATTERN = re.compile(r"^gates? (on|off|status)$", re.IGNORECASE)


def parse_toggle_command(prompt: str) -> "str | None":
    match = TOGGLE_PATTERN.match(prompt.strip())
    if not match:
        return None
    return match.group(1).lower()


def on_user_prompt(data: dict) -> dict:
    try:
        prompt = data.get("prompt") or ""
        command = parse_toggle_command(prompt)
        if not command:
            return {}

        if command == "status":
            state = "OFF" if is_gate_disabled() else "ON"
            return block("", f"Gates are currently {state}.")

        disable = command == "off"
        set_gate_disabled(disable)

        if disable:
            return block("⏸️", 'Gates disabled. Type "gate on" to re-enable.')
        else:
            return block("▶️", "Gates re-enabled.")
    except Exception:
        return {}


if __name__ == "__main__":
    import json

    try:
        data = json.loads(sys.stdin.read())
        result = on_user_prompt(data)
        if result:
            sys.stdout.write(json.dumps(result))
    except Exception:
        pass  # fail-open
