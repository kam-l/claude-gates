"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Tracing = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const PipelineRepository_1 = require("./PipelineRepository");
const NOOP = new Proxy(Object.create(null), {
    get(_target, prop) {
        if (typeof prop === "symbol") {
            return undefined;
        }
        return (...args) => (args.length === 0 ? null : NOOP);
    },
});
class Tracing {
    static init() {
        if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
            return { langfuse: NOOP, enabled: false, };
        }
        try {
            const { Langfuse, } = require("langfuse");
            const langfuse = new Langfuse({
                publicKey: process.env.LANGFUSE_PUBLIC_KEY,
                secretKey: process.env.LANGFUSE_SECRET_KEY,
                baseUrl: process.env.LANGFUSE_BASE_URL || undefined,
                flushAt: 1,
                flushInterval: 0,
            });
            return { langfuse, enabled: true, };
        }
        catch {
            return { langfuse: NOOP, enabled: false, };
        }
    }
    /**
     * Session-level trace. Deterministic ID from sessionId — all scopes in one session share the same trace.
     * Still writes trace_id to pipeline_state for PipelineBlock.ts compatibility.
     */
    static getOrCreateTrace(langfuse, enabled, db, scope, sessionId) {
        if (!enabled) {
            return NOOP;
        }
        try {
            const traceId = Tracing.sessionTraceId(sessionId);
            // Write to pipeline_state so PipelineBlock.ts can read it (backward compat)
            const repo = new PipelineRepository_1.PipelineRepository(db);
            if (repo.getPipelineState(scope)) {
                repo.setTraceId(scope, traceId);
            }
            else {
                return NOOP;
            }
            return langfuse.trace({
                id: traceId,
                name: `session`,
                sessionId: sessionId,
            });
        }
        catch {
            return NOOP;
        }
    }
    /**
     * Deterministic trace ID from sessionId — no DB lookup needed.
     */
    static sessionTraceId(sessionId) {
        return crypto_1.default.createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    }
    /**
     * Scope-level span under the session trace. All handler spans nest under this.
     */
    static scopeSpan(trace, scope) {
        return trace.span({ name: `scope:${scope}`, });
    }
    /**
     * Categorical score for a verdict event.
     */
    static score(trace, enabled, name, value, comment) {
        if (!enabled) {
            return;
        }
        try {
            trace.score({
                name,
                value,
                dataType: "CATEGORICAL",
                comment: comment || undefined,
            });
        }
        catch {
        }
    }
    static async flush(langfuse, enabled) {
        if (!enabled) {
            return;
        }
        try {
            await langfuse.shutdownAsync();
        }
        catch {
        }
    }
    static trace(sessionDir, op, scope, detail) {
        try {
            const entry = JSON.stringify({ ts: new Date().toISOString(), op, scope, ...detail, });
            fs_1.default.appendFileSync(path_1.default.join(sessionDir, "audit.jsonl"), entry + "\n", "utf-8");
        }
        catch {
        }
    }
    static NOOP = NOOP;
}
exports.Tracing = Tracing;
//# sourceMappingURL=Tracing.js.map