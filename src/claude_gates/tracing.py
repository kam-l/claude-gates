import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional


class _Noop:
    def __getattr__(self, name: str) -> "_Noop":
        return self

    def __call__(self, *args: Any, **kwargs: Any) -> "_Noop":
        return self

    def __bool__(self) -> bool:
        return False

    def __repr__(self) -> str:
        return "<NOOP>"

    def __enter__(self) -> "_Noop":
        return self

    def __exit__(self, *a: Any) -> None:
        pass

    def __iter__(self):
        return iter(())

    def __len__(self) -> int:
        return 0


NOOP: _Noop = _Noop()



def _make_context(langfuse: Any, enabled: bool) -> Dict[str, Any]:
    return {"langfuse": langfuse, "enabled": enabled}


def init() -> Dict[str, Any]:
    """
    Initialise Langfuse tracing. Returns ``{langfuse, enabled}``.

    Falls back to NOOP when env keys are missing, langfuse is not installed,
    or any exception occurs during client construction.
    """
    if not os.environ.get("LANGFUSE_PUBLIC_KEY") or not os.environ.get("LANGFUSE_SECRET_KEY"):
        return _make_context(NOOP, False)

    try:
        from langfuse import Langfuse  # type: ignore[import]
        langfuse = Langfuse(
            public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
            secret_key=os.environ["LANGFUSE_SECRET_KEY"],
            host=os.environ.get("LANGFUSE_BASE_URL") or None,
            flush_at=1,
            flush_interval=0,
        )
        return _make_context(langfuse, True)
    except Exception:
        return _make_context(NOOP, False)


def session_trace_id(session_id: str) -> str:
    """Return a deterministic 32-char hex trace ID derived from session_id."""
    return hashlib.sha256(session_id.encode()).hexdigest()[:32]


def _get_pipeline_state(db: Any, scope: str) -> Any:
    """Return the pipeline_state row for ``scope``, or None on any error."""
    try:
        cursor = db.execute(
            "SELECT scope FROM pipeline_state WHERE scope = ?", (scope,)
        )
        return cursor.fetchone()
    except Exception:
        return None


def _set_trace_id(db: Any, scope: str, trace_id: str) -> None:
    try:
        db.execute(
            "UPDATE pipeline_state SET trace_id = ? WHERE scope = ?",
            (trace_id, scope),
        )
    except Exception:
        pass


def get_or_create_trace(
    langfuse: Any,
    enabled: bool,
    db: Any,
    scope: str,
    session_id: str,
) -> Any:
    """
    Return a Langfuse trace for the session, or NOOP when disabled or on error.

    All scopes share the same deterministic trace ID. Writes trace_id to
    pipeline_state for PipelineBlock compatibility.
    """
    if not enabled:
        return NOOP

    try:
        trace_id = session_trace_id(session_id)

        state = _get_pipeline_state(db, scope)
        if state is None:
            return NOOP

        _set_trace_id(db, scope, trace_id)

        return langfuse.trace(
            id=trace_id,
            name="session",
            session_id=session_id,
        )
    except Exception:
        return NOOP


def scope_span(trace: Any, scope: str) -> Any:
    """Return a span named ``scope:<scope>`` under ``trace``."""
    return trace.span(name=f"scope:{scope}")


def score(
    trace: Any,
    enabled: bool,
    name: str,
    value: str,
    comment: Optional[str] = None,
) -> None:
    """Emit a categorical score. No-op when tracing is disabled."""
    if not enabled:
        return
    try:
        trace.score(
            name=name,
            value=value,
            data_type="CATEGORICAL",
            comment=comment or None,
        )
    except Exception:
        pass


def flush(langfuse: Any, enabled: bool) -> None:
    """Sync shutdown of the Langfuse client. No-op when tracing is disabled."""
    if not enabled:
        return
    try:
        langfuse.shutdown()
    except Exception:
        pass


def trace(
    session_dir: str,
    op: str,
    scope: Optional[str],
    detail: Optional[Dict[str, Any]] = None,
) -> None:
    """Append a JSON line to ``{session_dir}/audit.jsonl``. I/O errors are silently swallowed."""
    try:
        entry: Dict[str, Any] = {
            "ts": datetime.now(tz=timezone.utc).isoformat(),
            "op": op,
            "scope": scope,
        }
        if detail:
            entry.update(detail)
        line = json.dumps(entry) + "\n"
        audit_path = os.path.join(session_dir, "audit.jsonl")
        with open(audit_path, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
