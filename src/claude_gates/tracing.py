"""
tracing.py — port of Tracing.ts

Provides Langfuse SDK integration with a NOOP proxy fallback, session-level
trace management via deterministic IDs, scope spans, categorical scoring,
sync shutdown, and local audit.jsonl append (best-effort).

Langfuse is optional — system works fully without it.
"""

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional


# ---------------------------------------------------------------------------
# NOOP proxy — transparent proxy for Langfuse objects when tracing is disabled.
# Any attribute access returns a callable that returns NOOP (infinite chaining).
# __bool__ returns False so `if langfuse:` checks fail when tracing is disabled.
# ---------------------------------------------------------------------------

class _Noop:
    """
    Transparent proxy that absorbs any attribute access or call and returns
    itself, supporting infinite chaining: NOOP.trace({}).span({}).end().
    """

    def __getattr__(self, name: str) -> "_Noop":
        return self

    def __call__(self, *args: Any, **kwargs: Any) -> "_Noop":
        return self

    def __bool__(self) -> bool:
        return False

    def __repr__(self) -> str:
        return "<NOOP>"


NOOP: _Noop = _Noop()


# ---------------------------------------------------------------------------
# TracingContext
# ---------------------------------------------------------------------------

class TracingContext(dict):
    """
    Dict-based context so callers can use ctx['langfuse'] / ctx['enabled']
    as well as attribute-style access if needed.
    """


def _make_context(langfuse: Any, enabled: bool) -> Dict[str, Any]:
    return {"langfuse": langfuse, "enabled": enabled}


# ---------------------------------------------------------------------------
# init() — lazy import of langfuse; falls back gracefully
# ---------------------------------------------------------------------------

def init() -> Dict[str, Any]:
    """
    Initialise Langfuse tracing.  Returns ``{langfuse, enabled}``.

    Falls back to NOOP when:
    - LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY env vars are missing
    - langfuse package is not installed (ImportError)
    - any other exception during client construction
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


# ---------------------------------------------------------------------------
# session_trace_id — deterministic, no DB lookup
# ---------------------------------------------------------------------------

def session_trace_id(session_id: str) -> str:
    """
    Return a deterministic 32-char hex trace ID derived from session_id.
    SHA-256 of the session_id string, first 32 hex characters.
    """
    return hashlib.sha256(session_id.encode()).hexdigest()[:32]


# ---------------------------------------------------------------------------
# _get_pipeline_state — thin wrapper so tests can patch it
# ---------------------------------------------------------------------------

def _get_pipeline_state(db: Any, scope: str) -> Any:
    """
    Retrieve pipeline state row for ``scope`` from the DB.
    Thin wrapper so callers/tests can patch this without touching DB classes.
    Returns None when DB is unavailable or row does not exist.
    """
    try:
        # PipelineRepository may not be available in the Python port yet;
        # attempt direct SQL as a best-effort fallback.
        cursor = db.execute(
            "SELECT scope FROM pipeline_state WHERE scope = ?", (scope,)
        )
        return cursor.fetchone()
    except Exception:
        return None


def _set_trace_id(db: Any, scope: str, trace_id: str) -> None:
    """Set trace_id on pipeline_state. Best-effort."""
    try:
        db.execute(
            "UPDATE pipeline_state SET trace_id = ? WHERE scope = ?",
            (trace_id, scope),
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# get_or_create_trace — session-level trace with deterministic ID
# ---------------------------------------------------------------------------

def get_or_create_trace(
    langfuse: Any,
    enabled: bool,
    db: Any,
    scope: str,
    session_id: str,
) -> Any:
    """
    Return a Langfuse trace object for the current session.

    All scopes in one session share the same deterministic trace ID.
    Writes trace_id to pipeline_state for PipelineBlock compatibility.
    Returns NOOP when tracing is disabled or on any error.
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


# ---------------------------------------------------------------------------
# scope_span — named span under the session trace
# ---------------------------------------------------------------------------

def scope_span(trace: Any, scope: str) -> Any:
    """Return a span named ``scope:<scope>`` under ``trace``."""
    return trace.span(name=f"scope:{scope}")


# ---------------------------------------------------------------------------
# score — categorical score for a verdict event
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# flush — sync shutdown (blocks until all events delivered)
# ---------------------------------------------------------------------------

def flush(langfuse: Any, enabled: bool) -> None:
    """
    Sync shutdown of the Langfuse client.

    Uses ``langfuse.shutdown()`` (blocking) to guarantee all events are
    delivered at session end.  No-op when tracing is disabled.
    """
    if not enabled:
        return
    try:
        langfuse.shutdown()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# trace — append to audit.jsonl (best-effort local log)
# ---------------------------------------------------------------------------

def trace(
    session_dir: str,
    op: str,
    scope: Optional[str],
    detail: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Append a JSON line to ``{session_dir}/audit.jsonl``.

    Entry contains: ts (ISO), op, scope, and any additional fields from
    ``detail``.  Wrapped in try/except — I/O errors are silently swallowed.
    """
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
