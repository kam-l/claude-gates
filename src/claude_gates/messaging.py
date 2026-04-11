"""messaging.py — port of Messaging.ts

Key design change from TS: block() and info() return dicts instead of
writing to stdout. The hook_runner handles all I/O. notify() and log()
remain side-effectful (file I/O and stderr).
"""
import os
import sys

PREFIX = "[ClaudeGates]"
NOTIFICATION_FILE = ".pipeline-notifications"


def fmt(emoji: str, text: str) -> str:
    """Format a message with the ClaudeGates prefix."""
    return f"{PREFIX} {emoji} {text}"


def block(emoji: str, text: str) -> dict:
    """Return a hook protocol block dict. Never writes to stdout."""
    return {"decision": "block", "reason": fmt(emoji, text)}


def info(emoji: str, text: str) -> dict:
    """Return a hook protocol info dict. Never writes to stdout."""
    return {"systemMessage": fmt(emoji, text)}


def notify(session_dir: str, emoji: str, text: str) -> None:
    """Append a formatted message to the side-channel notification file."""
    msg = fmt(emoji, text)
    file_path = os.path.join(session_dir, NOTIFICATION_FILE)
    try:
        with open(file_path, "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except OSError:
        pass


def drain_notifications(session_dir: str) -> "str | None":
    """Read the notification file and delete it atomically. Returns None if no file."""
    file_path = os.path.join(session_dir, NOTIFICATION_FILE)
    if not os.path.exists(file_path):
        return None
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        os.unlink(file_path)
        return content
    except OSError:
        return None


def log(emoji: str, text: str) -> None:
    """Write a formatted message to stderr. No timestamp."""
    sys.stderr.write(fmt(emoji, text) + "\n")
