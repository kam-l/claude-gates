#!/usr/bin/env node
"use strict";
/**
 * Pipeline v3 — SubagentStart injection hook.
 *
 * Semantics first, structure later: no output format or filepath constraints
 * are injected. Agents think freely. SubagentStop captures their output.
 *
 * Only injects role context for verifiers (source artifact path, round info)
 * and fixers (source artifact, gate agent info). Source agents get nothing.
 *
 * Creates pipeline from verification: steps (idempotent).
 *
 * Fail-open.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const pipeline_db_1 = require("./pipeline-db");
const pipeline_shared_1 = require("./pipeline-shared");
const engine = __importStar(require("./pipeline"));
const msg = __importStar(require("./messages"));
const tracing = __importStar(require("./tracing"));
const HOME = process.env.USERPROFILE || process.env.HOME || "";
try {
    const data = JSON.parse(fs_1.default.readFileSync(0, "utf-8"));
    const sessionId = data.session_id || "";
    const agentType = data.agent_type || "";
    const agentId = data.agent_id || "";
    if (!sessionId || !agentType)
        process.exit(0);
    const bareAgentType = agentType.includes(":") ? agentType.split(":").pop() : agentType;
    const sessionDir = (0, pipeline_shared_1.getSessionDir)(sessionId);
    // Best-effort pipeline creation + context enrichment via DB
    let pipelineContext = "";
    const db = (0, pipeline_db_1.getDb)(sessionDir);
    try {
        // Find scope: prefer pending marker (accurate for parallel agents), fall back to DB
        let scope = null;
        const pendingMarker = path_1.default.join(sessionDir, `.pending-scope-${bareAgentType}`);
        try {
            if (fs_1.default.existsSync(pendingMarker)) {
                scope = fs_1.default.readFileSync(pendingMarker, "utf-8").trim();
                fs_1.default.unlinkSync(pendingMarker);
            }
        }
        catch { }
        if (!scope)
            scope = (0, pipeline_db_1.findAgentScope)(db, bareAgentType);
        if (scope) {
            // Create pipeline from verification: steps (idempotent — no-op if already exists)
            const agentMdPath = (0, pipeline_shared_1.findAgentMd)(bareAgentType, process.cwd(), HOME);
            if (agentMdPath) {
                const mdContent = fs_1.default.readFileSync(agentMdPath, "utf-8");
                const steps = (0, pipeline_shared_1.parseVerification)(mdContent);
                if (steps) {
                    engine.createPipeline(db, scope, bareAgentType, steps);
                    msg.notify(sessionDir, "⚡", `pipeline: Initialized ${steps.length} step(s) for scope="${scope}": ${steps.map(s => s.type).join(" → ")}.`);
                    // Langfuse: record pipeline creation as a trace span
                    const { langfuse, enabled } = tracing.init();
                    const trace = tracing.getOrCreateTrace(langfuse, enabled, db, scope, sessionId);
                    trace.span({ name: "pipeline-created", input: { scope, sourceAgent: bareAgentType, stepTypes: steps.map(s => s.type) } }).end();
                    tracing.flush(langfuse, enabled);
                }
            }
            // Role-based context enrichment
            const role = engine.resolveRole(db, scope, bareAgentType);
            if (role === "verifier") {
                // Gate agent: inject source artifact path + round info
                const activeStep = (0, pipeline_db_1.getActiveStep)(db, scope);
                if (activeStep) {
                    const state = (0, pipeline_db_1.getPipelineState)(db, scope);
                    const sourceAgent = state ? state.source_agent : "unknown";
                    // After fixer runs, reviewer reads fixer's output (latest version)
                    let sourceArtifact = `${sessionDir}/${scope}/${sourceAgent}.md`;
                    if (activeStep.fixer && activeStep.round > 0) {
                        const fixerArtifact = `${sessionDir}/${scope}/${activeStep.fixer}.md`;
                        if (fs_1.default.existsSync(fixerArtifact)) {
                            sourceArtifact = fixerArtifact;
                        }
                    }
                    pipelineContext =
                        `role=gate\n` +
                            `source_agent=${sourceAgent}\n` +
                            `source_artifact=${sourceArtifact}\n` +
                            `gate_round=${activeStep.round + 1}/${activeStep.max_rounds}\n`;
                }
            }
            else if (role === "fixer") {
                // Fixer: inject source artifact + gate agent info
                const fixStep = (0, pipeline_db_1.getStepByStatus)(db, scope, "fix");
                if (fixStep) {
                    const state = (0, pipeline_db_1.getPipelineState)(db, scope);
                    const sourceAgent = state ? state.source_agent : "unknown";
                    const sourceArtifact = `${sessionDir}/${scope}/${sourceAgent}.md`;
                    pipelineContext =
                        `role=fixer\n` +
                            `source_agent=${sourceAgent}\n` +
                            `source_artifact=${sourceArtifact}\n` +
                            `gate_agent=${fixStep.agent}\n` +
                            `gate_round=${fixStep.round + 1}/${fixStep.max_rounds}\n`;
                }
            }
            // Verification file exists → inject it (file existence IS the signal)
            try {
                const verificationFile = path_1.default.join(sessionDir, scope, `${bareAgentType}-verification.md`);
                if (fs_1.default.existsSync(verificationFile)) {
                    const findings = fs_1.default.readFileSync(verificationFile, "utf-8");
                    pipelineContext +=
                        `artifact=${sessionDir}/${scope}/${bareAgentType}.md\n` +
                            `\nReviewer findings (address ALL issues before resubmitting):\n${findings}\n`;
                }
            }
            catch { }
            // source (first run) / ungated → no context injection (semantics first)
        }
    }
    finally {
        db.close();
    }
    // Only inject if there's role context to provide (verifier/fixer)
    if (!pipelineContext)
        process.exit(0);
    const context = `<agent_gate importance="critical">\n` +
        pipelineContext +
        `</agent_gate>`;
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "SubagentStart",
            additionalContext: context
        }
    }));
    process.exit(0);
}
catch {
    process.exit(0);
}
//# sourceMappingURL=pipeline-injection.js.map