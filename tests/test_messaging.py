import os
import sys

import pytest

from claude_gates.messaging import (
    PREFIX,
    NOTIFICATION_FILE,
    fmt,
    block,
    info,
    notify,
    drain_notifications,
    log,
)


class TestFmt:
    def test_fmt_combines_prefix_emoji_text(self):
        result = fmt("🚫", "something went wrong")
        assert result == "[ClaudeGates] 🚫 something went wrong"

    def test_fmt_empty_emoji_produces_double_space(self):
        result = fmt("", "text")
        assert result == "[ClaudeGates]  text"


class TestBlock:
    def test_block_returns_dict_with_decision_and_reason(self):
        result = block("🚫", "pipeline blocked")
        assert result == {"decision": "block", "reason": "[ClaudeGates] 🚫 pipeline blocked"}

    def test_block_never_writes_to_stdout(self, capsys):
        block("🚫", "test")
        captured = capsys.readouterr()
        assert captured.out == ""

    def test_block_reason_contains_prefix(self):
        result = block("X", "msg")
        assert result["reason"].startswith("[ClaudeGates]")


class TestInfo:
    def test_info_returns_dict_with_system_message(self):
        result = info("ℹ️", "some info")
        assert result == {"systemMessage": "[ClaudeGates] ℹ️ some info"}

    def test_info_never_writes_to_stdout(self, capsys):
        info("ℹ️", "test")
        captured = capsys.readouterr()
        assert captured.out == ""

    def test_info_system_message_contains_prefix(self):
        result = info("X", "msg")
        assert result["systemMessage"].startswith("[ClaudeGates]")


class TestNotify:
    def test_notify_creates_file_if_not_exists(self, tmp_path):
        notify(str(tmp_path), "📢", "hello")
        notification_file = tmp_path / NOTIFICATION_FILE
        assert notification_file.exists()

    def test_notify_appends_formatted_line(self, tmp_path):
        notify(str(tmp_path), "📢", "hello")
        content = (tmp_path / NOTIFICATION_FILE).read_text(encoding="utf-8")
        assert content == "[ClaudeGates] 📢 hello\n"

    def test_notify_appends_multiple_lines(self, tmp_path):
        notify(str(tmp_path), "📢", "first")
        notify(str(tmp_path), "📢", "second")
        content = (tmp_path / NOTIFICATION_FILE).read_text(encoding="utf-8")
        assert content == "[ClaudeGates] 📢 first\n[ClaudeGates] 📢 second\n"


class TestDrainNotifications:
    def test_drain_returns_none_when_file_not_exists(self, tmp_path):
        result = drain_notifications(str(tmp_path))
        assert result is None

    def test_drain_returns_file_contents(self, tmp_path):
        notification_file = tmp_path / NOTIFICATION_FILE
        notification_file.write_text("[ClaudeGates] 📢 hello\n", encoding="utf-8")
        result = drain_notifications(str(tmp_path))
        assert result == "[ClaudeGates] 📢 hello\n"

    def test_drain_deletes_file_after_read(self, tmp_path):
        notification_file = tmp_path / NOTIFICATION_FILE
        notification_file.write_text("[ClaudeGates] 📢 hello\n", encoding="utf-8")
        drain_notifications(str(tmp_path))
        assert not notification_file.exists()

    def test_drain_returns_none_when_file_empty(self, tmp_path):
        notification_file = tmp_path / NOTIFICATION_FILE
        notification_file.write_text("", encoding="utf-8")
        result = drain_notifications(str(tmp_path))
        assert result is None

    def test_drain_second_call_returns_none(self, tmp_path):
        notification_file = tmp_path / NOTIFICATION_FILE
        notification_file.write_text("[ClaudeGates] 📢 hello\n", encoding="utf-8")
        drain_notifications(str(tmp_path))
        result = drain_notifications(str(tmp_path))
        assert result is None


class TestLog:
    def test_log_writes_to_stderr(self, capsys):
        log("⚡", "test message")
        captured = capsys.readouterr()
        assert "[ClaudeGates] ⚡ test message\n" in captured.err

    def test_log_does_not_write_to_stdout(self, capsys):
        log("⚡", "test message")
        captured = capsys.readouterr()
        assert captured.out == ""

    def test_log_has_no_timestamp(self, capsys):
        log("⚡", "msg")
        captured = capsys.readouterr()
        assert captured.err == "[ClaudeGates] ⚡ msg\n"


class TestConstants:
    def test_prefix_constant(self):
        assert PREFIX == "[ClaudeGates]"

    def test_notification_file_constant(self):
        assert NOTIFICATION_FILE == ".pipeline-notifications"


class TestSourceComments:
    """Verify required comments are present in messaging.py source."""

    def _read_source(self) -> str:
        import pathlib
        src = pathlib.Path(__file__).parent.parent / "src" / "claude_gates" / "messaging.py"
        return src.read_text(encoding="utf-8")

    def test_toctou_comment_present_above_drain_notifications(self):
        source = self._read_source()
        toctou_comment = "# Note: exists+open+unlink is not truly atomic (TOCTOU). Acceptable since hooks run sequentially."
        assert toctou_comment in source

    def test_toctou_comment_immediately_above_drain_function(self):
        source = self._read_source()
        expected = "# Note: exists+open+unlink is not truly atomic (TOCTOU). Acceptable since hooks run sequentially.\ndef drain_notifications"
        assert expected in source

    def test_ts_match_comment_on_return_line(self):
        source = self._read_source()
        ts_comment = "return content or None  # Match TS: content || null — empty string is falsy"
        assert ts_comment in source
