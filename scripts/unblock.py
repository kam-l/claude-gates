#!/usr/bin/env python3
"""
Nuclear pipeline unblock — force-completes all stuck pipelines and clears markers.

Usage (from within a Claude Code session):
  ! python3 ${CLAUDE_PLUGIN_ROOT}/scripts/unblock.py [session-id] [scope]

  No args     -> auto-detect session from .sessions/, nuke all active pipelines
  session-id  -> specific session, nuke all
  scope       -> nuke only that scope
"""

import os
import sys

# Allow importing from src/ when running directly from scripts/
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_SCRIPT_DIR)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)
if os.path.join(_PROJECT_ROOT, "src") not in sys.path:
    sys.path.insert(0, os.path.join(_PROJECT_ROOT, "src"))

from claude_gates import session, messaging, tracing
from claude_gates.repository import PipelineRepository


def find_session_dir():
    """
    Resolve the session directory to operate on.

    If sys.argv[1] is provided, tries session.get_session_dir(arg) first,
    then falls back to raw {sessions_root}/{arg}. Returns None if not found.

    Without args, scans .sessions/ for the directory with the most recently
    modified session.db. Returns None if no sessions exist.
    """
    sessions_root = os.path.join(os.getcwd(), ".sessions")
    if not os.path.isdir(sessions_root):
        return None

    args = sys.argv[1:]

    if args and args[0]:
        arg = args[0]
        # Construct short-id path without calling get_session_dir (avoids makedirs side-effect)
        short_id = arg.replace("-", "")[:8]
        candidate = os.path.join(sessions_root, short_id)
        if os.path.exists(os.path.join(candidate, "session.db")):
            return candidate
        # Fall back to raw argument as directory name
        raw = os.path.join(sessions_root, arg)
        if os.path.exists(os.path.join(raw, "session.db")):
            return raw
        sys.stderr.write(f'No session.db found for "{arg}"\n')
        return None

    # Auto-detect: find most recent session.db
    best_dir = None
    best_mtime = None
    try:
        entries = os.listdir(sessions_root)
    except OSError:
        return None

    for entry in entries:
        db_path = os.path.join(sessions_root, entry, "session.db")
        try:
            mtime = os.stat(db_path).st_mtime
            if best_mtime is None or mtime > best_mtime:
                best_mtime = mtime
                best_dir = os.path.join(sessions_root, entry)
        except OSError:
            pass

    return best_dir


def nuke(conn, scope):
    """
    Force-delete all stuck pipelines (status in normal/revision) from the DB.

    When scope is given, only nukes that specific scope regardless of status.
    Returns list of nuked pipeline row dicts (for audit).
    Wraps all deletes in a single transaction.
    """
    # Snapshot before nuke
    try:
        if scope:
            cursor = conn.execute(
                "SELECT scope, status, current_step FROM pipeline_state WHERE scope = ?",
                (scope,),
            )
        else:
            cursor = conn.execute(
                "SELECT scope, status, current_step FROM pipeline_state "
                "WHERE status IN ('normal', 'revision')"
            )
        stuck_pipelines = [dict(row) for row in cursor.fetchall()]
    except Exception:
        stuck_pipelines = []

    try:
        if scope:
            cursor = conn.execute(
                "SELECT scope, step_index, step_type, status, agent, round "
                "FROM pipeline_steps "
                "WHERE status IN ('active','revise','fix') AND scope = ?",
                (scope,),
            )
        else:
            cursor = conn.execute(
                "SELECT scope, step_index, step_type, status, agent, round "
                "FROM pipeline_steps "
                "WHERE status IN ('active','revise','fix')"
            )
        stuck_steps = [dict(row) for row in cursor.fetchall()]
    except Exception:
        stuck_steps = []

    if not stuck_pipelines and not stuck_steps:
        return []

    # Print what we are nuking
    print(f"\nNuking {len(stuck_pipelines)} pipeline(s):")
    for p in stuck_pipelines:
        print(f"  {p['scope']}: status={p['status']} step={p['current_step']}")
    for s in stuck_steps:
        print(
            f"  {s['scope']}/step{s['step_index']} ({s['step_type']}): "
            f"{s['status']} agent={s.get('agent') or '-'} round={s['round']}"
        )

    # Nuclear delete in a single transaction
    # Collect scopes from both pipeline_state rows AND orphaned steps
    def _do_delete():
        pipeline_scopes = {p["scope"] for p in stuck_pipelines}
        step_scopes = {s["scope"] for s in stuck_steps}
        scopes = pipeline_scopes | step_scopes
        for s in scopes:
            conn.execute("DELETE FROM pipeline_steps WHERE scope = ?", (s,))
            conn.execute("DELETE FROM pipeline_state WHERE scope = ?", (s,))
            conn.execute("DELETE FROM agents WHERE scope = ?", (s,))
        try:
            conn.execute(
                "DELETE FROM gates WHERE status IN ('active','revise','fix')"
            )
        except Exception:
            pass

    PipelineRepository.transact(conn, _do_delete)
    print("Pipelines deleted.")

    # Synthesize audit entries for orphaned-step-only scopes (no pipeline_state row)
    pipeline_scopes = {p["scope"] for p in stuck_pipelines}
    step_scopes = {s["scope"] for s in stuck_steps}
    orphan_entries = [
        {"scope": s, "status": "orphaned", "current_step": None}
        for s in step_scopes - pipeline_scopes
    ]
    return stuck_pipelines + orphan_entries


def clear_markers(session_dir, scope):
    """
    Remove .running-* and .pending-scope-* marker files from session_dir.
    Also removes .pipeline-notifications if present.

    When scope is given, removes only markers matching that specific scope.
    Returns list of cleaned filenames (callers may use len() for the count).
    """
    cleaned = []
    try:
        for f in os.listdir(session_dir):
            if scope:
                # Scope-specific removal
                if f == f".running-{scope}" or f == f".pending-scope-{scope}":
                    try:
                        os.unlink(os.path.join(session_dir, f))
                        cleaned.append(f)
                    except OSError:
                        pass
            else:
                if f.startswith(".running-") or f.startswith(".pending-scope-"):
                    try:
                        os.unlink(os.path.join(session_dir, f))
                        cleaned.append(f)
                    except OSError:
                        pass
    except OSError:
        pass

    # Always remove notification file regardless of scope filter
    try:
        notif_path = os.path.join(session_dir, messaging.NOTIFICATION_FILE)
        if os.path.exists(notif_path):
            os.unlink(notif_path)
            cleaned.append(messaging.NOTIFICATION_FILE)
    except OSError:
        pass

    if cleaned:
        print(f"Cleaned {len(cleaned)} marker/notification file(s).")

    return cleaned


def audit(session_dir, pipeline, markers):
    """Write an audit entry for one nuked pipeline via tracing.trace()."""
    tracing.trace(
        session_dir,
        "unblock",
        pipeline["scope"],
        {
            "status": pipeline["status"],
            "step": pipeline["current_step"],
            "markers": markers,
        },
    )


def main():
    session_dir = find_session_dir()
    if not session_dir:
        sys.stderr.write(
            "No session found. Usage: python3 unblock.py [session-id] [scope]\n"
        )
        sys.exit(1)

    args = sys.argv[1:]
    scope = args[1] if len(args) >= 2 else None

    print(f"Session: {session_dir}")
    if scope:
        print(f"Scope:   {scope}")

    conn = session.open_database(session_dir)
    PipelineRepository.init_schema(conn)

    try:
        nuked = nuke(conn, scope)

        if not nuked:
            print("Nothing stuck.")
            sys.exit(0)

        cleaned = clear_markers(session_dir, scope)

        # Audit via tracing — pass actual cleaned filenames
        for p in nuked:
            audit(session_dir, p, cleaned)

        print("\nUnblocked. Retry your action.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
