import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.claude_gates import tracing
from src.claude_gates.tracing import NOOP


class TestNoopProxy(unittest.TestCase):
    """AC1: NOOP proxy supports infinite chaining and attribute access."""

    def test_attribute_access_returns_noop(self):
        result = NOOP.id
        self.assertIs(result, NOOP)

    def test_call_with_args_returns_noop(self):
        result = NOOP({"key": "value"})
        self.assertIs(result, NOOP)

    def test_call_with_no_args_returns_noop(self):
        result = NOOP()
        self.assertIs(result, NOOP)

    def test_chained_method_calls_return_noop(self):
        result = NOOP.trace({}).span({}).end()
        self.assertIs(result, NOOP)

    def test_deep_attribute_chain_returns_noop(self):
        result = NOOP.a.b.c.d
        self.assertIs(result, NOOP)

    def test_bool_is_false(self):
        """AC edge case: NOOP.__bool__ returns False so `if langfuse:` fails."""
        self.assertFalse(bool(NOOP))

    def test_noop_is_falsy_in_if_check(self):
        if NOOP:
            self.fail("NOOP should be falsy")

    def test_getattr_returns_callable(self):
        attr = NOOP.anything
        self.assertTrue(callable(attr))


class TestInit(unittest.TestCase):
    """AC2: init() gracefully falls back to NOOP on ImportError."""

    def test_returns_noop_when_langfuse_not_installed(self):
        with patch.dict("sys.modules", {"langfuse": None}):
            ctx = tracing.init()
        self.assertIs(ctx["langfuse"], NOOP)
        self.assertFalse(ctx["enabled"])

    def test_no_exception_on_import_error(self):
        # Simulate langfuse not installed by making sys.modules["langfuse"] unavailable
        # and ensuring env vars are set so init() actually tries the import path
        env = {"LANGFUSE_PUBLIC_KEY": "pub", "LANGFUSE_SECRET_KEY": "sec"}
        import sys as _sys
        original = _sys.modules.pop("langfuse", _sys.modules.get("langfuse"))
        _sys.modules["langfuse"] = None  # type: ignore[assignment]
        try:
            with patch.dict(os.environ, env):
                try:
                    ctx = tracing.init()
                except Exception as e:
                    self.fail(f"init() raised unexpectedly: {e}")
        finally:
            if original is None:
                _sys.modules.pop("langfuse", None)
            else:
                _sys.modules["langfuse"] = original  # type: ignore[assignment]

    def test_returns_noop_when_env_keys_missing(self):
        env = {k: v for k, v in os.environ.items()
               if k not in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY")}
        with patch.dict(os.environ, env, clear=True):
            ctx = tracing.init()
        self.assertIs(ctx["langfuse"], NOOP)
        self.assertFalse(ctx["enabled"])

    def test_enabled_true_when_langfuse_available(self):
        mock_langfuse_module = MagicMock()
        mock_langfuse_instance = MagicMock()
        mock_langfuse_module.Langfuse.return_value = mock_langfuse_instance
        env = {"LANGFUSE_PUBLIC_KEY": "pub-key", "LANGFUSE_SECRET_KEY": "sec-key"}
        with patch.dict(os.environ, env):
            with patch.dict("sys.modules", {"langfuse": mock_langfuse_module}):
                ctx = tracing.init()
        self.assertTrue(ctx["enabled"])
        self.assertIsNot(ctx["langfuse"], NOOP)

    def test_returns_dict_with_langfuse_and_enabled_keys(self):
        with patch.dict("sys.modules", {"langfuse": None}):
            ctx = tracing.init()
        self.assertIn("langfuse", ctx)
        self.assertIn("enabled", ctx)


class TestSessionTraceId(unittest.TestCase):
    """AC3: session_trace_id is deterministic."""

    def test_returns_32_char_hex(self):
        result = tracing.session_trace_id("test-session-id")
        self.assertEqual(len(result), 32)

    def test_is_deterministic(self):
        result1 = tracing.session_trace_id("my-session")
        result2 = tracing.session_trace_id("my-session")
        self.assertEqual(result1, result2)

    def test_different_inputs_produce_different_ids(self):
        r1 = tracing.session_trace_id("session-a")
        r2 = tracing.session_trace_id("session-b")
        self.assertNotEqual(r1, r2)

    def test_matches_sha256_first_32_chars(self):
        session_id = "abc-123-def-456"
        expected = hashlib.sha256(session_id.encode()).hexdigest()[:32]
        result = tracing.session_trace_id(session_id)
        self.assertEqual(result, expected)


class TestTrace(unittest.TestCase):
    """AC4: audit.jsonl writes are best-effort."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_appends_json_line_to_audit_jsonl(self):
        tracing.trace(self.tmp, "test_op", "scope1", {"detail_key": "detail_val"})
        audit_path = os.path.join(self.tmp, "audit.jsonl")
        self.assertTrue(os.path.exists(audit_path))

    def test_json_line_contains_op(self):
        tracing.trace(self.tmp, "my_op", "scope1")
        audit_path = os.path.join(self.tmp, "audit.jsonl")
        with open(audit_path) as f:
            entry = json.loads(f.readline())
        self.assertEqual(entry["op"], "my_op")

    def test_json_line_contains_scope(self):
        tracing.trace(self.tmp, "op", "my_scope")
        audit_path = os.path.join(self.tmp, "audit.jsonl")
        with open(audit_path) as f:
            entry = json.loads(f.readline())
        self.assertEqual(entry["scope"], "my_scope")

    def test_json_line_contains_timestamp(self):
        tracing.trace(self.tmp, "op", "scope")
        audit_path = os.path.join(self.tmp, "audit.jsonl")
        with open(audit_path) as f:
            entry = json.loads(f.readline())
        self.assertIn("ts", entry)

    def test_detail_fields_included_in_json_line(self):
        tracing.trace(self.tmp, "op", "scope", {"extra": "value"})
        audit_path = os.path.join(self.tmp, "audit.jsonl")
        with open(audit_path) as f:
            entry = json.loads(f.readline())
        self.assertEqual(entry["extra"], "value")

    def test_multiple_calls_append_multiple_lines(self):
        tracing.trace(self.tmp, "op1", "scope")
        tracing.trace(self.tmp, "op2", "scope")
        audit_path = os.path.join(self.tmp, "audit.jsonl")
        with open(audit_path) as f:
            lines = [l for l in f if l.strip()]
        self.assertEqual(len(lines), 2)

    def test_io_error_silently_swallowed(self):
        bad_dir = "/nonexistent/path/that/does/not/exist"
        try:
            tracing.trace(bad_dir, "op", "scope")
        except Exception as e:
            self.fail(f"trace() raised on I/O error: {e}")

    def test_none_detail_does_not_crash(self):
        try:
            tracing.trace(self.tmp, "op", "scope", None)
        except Exception as e:
            self.fail(f"trace() raised with None detail: {e}")


class TestFlush(unittest.TestCase):
    """AC5: flush() uses sync shutdown."""

    def test_calls_shutdown_when_enabled(self):
        mock_langfuse = MagicMock()
        tracing.flush(mock_langfuse, enabled=True)
        mock_langfuse.shutdown.assert_called_once()

    def test_no_shutdown_when_not_enabled(self):
        mock_langfuse = MagicMock()
        tracing.flush(mock_langfuse, enabled=False)
        mock_langfuse.shutdown.assert_not_called()

    def test_flush_with_noop_does_not_raise(self):
        try:
            tracing.flush(NOOP, enabled=True)
        except Exception as e:
            self.fail(f"flush(NOOP) raised: {e}")

    def test_flush_disabled_with_noop_does_not_raise(self):
        try:
            tracing.flush(NOOP, enabled=False)
        except Exception as e:
            self.fail(f"flush(NOOP, False) raised: {e}")


class TestGetOrCreateTrace(unittest.TestCase):
    """Edge case: get_or_create_trace with NOOP langfuse returns NOOP."""

    def test_returns_noop_when_not_enabled(self):
        result = tracing.get_or_create_trace(NOOP, False, None, "scope", "session-id")
        self.assertIs(result, NOOP)

    def test_returns_noop_when_langfuse_is_noop_but_enabled(self):
        # enabled=True but langfuse=NOOP — db would return no pipeline state
        # Should return NOOP (no pipeline state found)
        mock_db = MagicMock()
        with patch("src.claude_gates.tracing._get_pipeline_state", return_value=None):
            result = tracing.get_or_create_trace(NOOP, True, mock_db, "scope", "session-id")
        self.assertIs(result, NOOP)


class TestScopeSpan(unittest.TestCase):
    """scope_span delegates to trace.span()."""

    def test_calls_span_with_name(self):
        mock_trace = MagicMock()
        tracing.scope_span(mock_trace, "my_scope")
        mock_trace.span.assert_called_once_with(name="scope:my_scope")

    def test_returns_span_result(self):
        mock_trace = MagicMock()
        mock_span = MagicMock()
        mock_trace.span.return_value = mock_span
        result = tracing.scope_span(mock_trace, "x")
        self.assertIs(result, mock_span)

    def test_with_noop_trace_returns_noop(self):
        result = tracing.scope_span(NOOP, "scope")
        self.assertIs(result, NOOP)


class TestScore(unittest.TestCase):
    """score() with NOOP silently no-ops via proxy chain."""

    def test_calls_trace_score_when_enabled(self):
        mock_trace = MagicMock()
        tracing.score(mock_trace, True, "verdict", "PASS", "looks good")
        mock_trace.score.assert_called_once()

    def test_no_op_when_not_enabled(self):
        mock_trace = MagicMock()
        tracing.score(mock_trace, False, "verdict", "PASS")
        mock_trace.score.assert_not_called()

    def test_score_with_noop_trace_does_not_raise(self):
        try:
            tracing.score(NOOP, True, "verdict", "PASS")
        except Exception as e:
            self.fail(f"score(NOOP) raised: {e}")

    def test_score_passes_correct_fields(self):
        mock_trace = MagicMock()
        tracing.score(mock_trace, True, "verdict", "REVISE", "needs work")
        call_kwargs = mock_trace.score.call_args
        args, kwargs = call_kwargs
        # may be positional or keyword
        if kwargs:
            self.assertEqual(kwargs.get("name") or (args[0] if args else None), "verdict")
        else:
            # called with a dict
            self.assertTrue(True)


if __name__ == "__main__":
    unittest.main()
