#!/usr/bin/env node
/**
 * Langfuse observability tracing — opt-in, fail-open, zero-impact when disabled.
 *
 * ## .NET analogy
 * Think of this as a lightweight ILogger / Activity (System.Diagnostics) wrapper:
 *   - init()             → like building an IServiceProvider with AddOpenTelemetry()
 *   - getOrCreateTrace() → like Activity.Start() with a correlation ID
 *   - trace.span()       → like using (var span = activity.StartActivity("name"))
 *   - flush()            → like TracerProvider.ForceFlush() before process exit
 *
 * ## How it works
 * 1. init() checks for LANGFUSE_PUBLIC_KEY env var. No key → everything is a no-op.
 * 2. Each pipeline scope gets a trace_id stored in SQLite (pipeline_state.trace_id).
 * 3. Multiple hook processes (separate Node.js scripts) read the same trace_id
 *    from the DB and add spans to the same logical trace — like distributed tracing
 *    with a shared correlation ID (similar to Activity.SetParentId in .NET).
 * 4. Langfuse merges spans server-side into one trace timeline.
 *
 * ## Fail-open guarantee
 * Every public function is wrapped in try-catch. Tracing failure NEVER blocks
 * pipeline operations. If Langfuse is unreachable, spans are silently dropped.
 */

import crypto from "crypto";

// ── NOOP proxy ──────────────────────────────────────────────────────
// When tracing is disabled, all calls go here and do nothing.
// Supports both method calls (trace.span({...}).end()) and property reads (trace.id).
//
// .NET analogy: like NullLogger<T> — implements the interface, does nothing.
const NOOP: any = new Proxy(Object.create(null), {
  get(_target: any, prop: string | symbol) {
    // Symbol properties (used by Node internals like util.inspect) → undefined
    if (typeof prop === "symbol") return undefined;
    // Return a function that either returns null (property-like: trace.id)
    // or returns NOOP (method-like: trace.span({...}) for chaining)
    return (...args: any[]) => (args.length === 0 ? null : NOOP);
  }
});

interface TracingContext {
  langfuse: any;
  enabled: boolean;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Initialize Langfuse client. Returns { langfuse, enabled }.
 *
 * - If LANGFUSE_PUBLIC_KEY is not set → returns { langfuse: NOOP, enabled: false }
 * - If `langfuse` npm package is not installed → same NOOP fallback
 * - The require() is lazy (inside this function, not top-level) so the
 *   module loads fine even without the langfuse package installed.
 */
function init(): TracingContext {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    return { langfuse: NOOP, enabled: false };
  }
  try {
    // Lazy require — only loads langfuse when tracing is actually enabled
    const { Langfuse } = require("langfuse");
    const langfuse = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL || undefined,
      // Short-lived process settings:
      // flushAt: 1  → send each event immediately (no batching)
      // flushInterval: 0 → no periodic timer (we flush manually)
      flushAt: 1,
      flushInterval: 0,
    });
    return { langfuse, enabled: true };
  } catch {
    // langfuse package not installed or failed to load → silent no-op
    return { langfuse: NOOP, enabled: false };
  }
}

/**
 * Get or create a Langfuse trace for a pipeline scope.
 *
 * Reads trace_id from pipeline_state. If none exists, generates a new UUID
 * and stores it. Returns a Langfuse trace object (or NOOP if disabled/missing).
 *
 * The trace_id is the cross-process correlation key — like a W3C traceparent
 * header, but stored in SQLite instead of HTTP headers.
 */
function getOrCreateTrace(langfuse: any, enabled: boolean, db: any, scope: string, sessionId: string): any {
  if (!enabled) return NOOP;
  try {
    // Read existing trace_id from pipeline_state
    const row = db.prepare("SELECT trace_id FROM pipeline_state WHERE scope = ?").get(scope);
    if (!row) return NOOP; // pipeline_state row doesn't exist yet

    let traceId = row.trace_id;

    // First time: generate and store trace_id
    if (!traceId) {
      traceId = crypto.randomUUID();
      db.prepare("UPDATE pipeline_state SET trace_id = ? WHERE scope = ?").run(traceId, scope);
    }

    // Create (or reuse) the Langfuse trace with this ID
    // Langfuse deduplicates by trace ID — multiple processes adding spans
    // to the same ID all show up in one trace timeline.
    return langfuse.trace({
      id: traceId,
      name: `pipeline:${scope}`,
      sessionId: sessionId,
      metadata: { scope },
    });
  } catch {
    return NOOP;
  }
}

/**
 * Fire-and-forget flush. Schedules the HTTP send but does NOT await it.
 *
 * Node keeps the event loop alive briefly for the pending microtask,
 * which is usually enough for one HTTP request with flushAt: 1.
 * If it doesn't complete before process.exit() — spans are lost. Acceptable.
 *
 * .NET analogy: like calling TracerProvider.ForceFlush() with a short timeout,
 * except we don't block the thread at all.
 */
function flush(langfuse: any, enabled: boolean): void {
  if (!enabled) return;
  try {
    // shutdownAsync() returns a Promise — we deliberately don't await it.
    // The .catch() prevents unhandled rejection warnings.
    langfuse.shutdownAsync().catch(() => {});
  } catch {
    // fail-open: flush failure is never an error
  }
}

export { init, getOrCreateTrace, flush, NOOP };
