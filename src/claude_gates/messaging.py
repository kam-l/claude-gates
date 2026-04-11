import os
import sys

PREFIX = "[ClaudeGates]"
NOTIFICATION_FILE = ".pipeline-notifications"


def fmt(emoji: str, text: str) -> str:
    return f"{PREFIX} {emoji} {text}"


def block(emoji: str, text: str) -> dict:
    return {"decision": "block", "reason": fmt(emoji, text)}


def info(emoji: str, text: str) -> dict:
    return {"systemMessage": fmt(emoji, text)}


def notify(session_dir: str, emoji: str, text: str) -> None:
    msg = fmt(emoji, text)
    file_path = os.path.join(session_dir, NOTIFICATION_FILE)
    try:
        with open(file_path, "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except OSError as e:
        log("⚠️", f"notify failed: {e}")


# Note: exists+open+unlink is not truly atomic (TOCTOU). Acceptable since hooks run sequentially.
def drain_notifications(session_dir: str) -> "str | None":
    file_path = os.path.join(session_dir, NOTIFICATION_FILE)
    if not os.path.exists(file_path):
        return None
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        os.unlink(file_path)
        return content or None  # Match TS: content || null — empty string is falsy, returns None
    except OSError:
        return None


def log(emoji: str, text: str) -> None:
    sys.stderr.write(fmt(emoji, text) + "\n")
