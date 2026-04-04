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
    static getOrCreateTrace(langfuse, enabled, db, scope, sessionId) {
        if (!enabled) {
            return NOOP;
        }
        try {
            const repo = new PipelineRepository_1.PipelineRepository(db);
            let traceId = repo.getTraceId(scope);
            if (traceId === null && !repo.getPipelineState(scope)) {
                return NOOP;
            }
            if (!traceId) {
                traceId = crypto_1.default.randomUUID();
                repo.setTraceId(scope, traceId);
            }
            return langfuse.trace({
                id: traceId,
                name: `pipeline:${scope}`,
                sessionId: sessionId,
                metadata: { scope, },
            });
        }
        catch {
            return NOOP;
        }
    }
    static flush(langfuse, enabled) {
        if (!enabled) {
            return;
        }
        try {
            langfuse.shutdownAsync().catch(() => { });
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