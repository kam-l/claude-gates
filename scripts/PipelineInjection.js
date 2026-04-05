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
 * Pipeline creation is deferred to SubagentStop (parallel pipelines).
 *
 * Fail-open.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onSubagentStart = onSubagentStart;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const PipelineEngine_1 = require("./PipelineEngine");
const PipelineRepository_1 = require("./PipelineRepository");
const SessionManager_1 = require("./SessionManager");
const Enums_1 = require("./types/Enums");
const HOME = process.env.USERPROFILE || process.env.HOME || "";
function onSubagentStart(data) {
    if (SessionManager_1.SessionManager.isGateDisabled()) {
        process.exit(0);
    }
    const sessionId = data.session_id || "";
    const agentType = data.agent_type || "";
    if (!sessionId || !agentType) {
        process.exit(0);
    }
    const bareAgentType = agentType.includes(":") ? agentType.split(":").pop() : agentType;
    const sessionDir = SessionManager_1.SessionManager.getSessionDir(sessionId);
    // Context enrichment via DB (pipeline creation deferred to SubagentStop)
    let pipelineContext = "";
    let db = null;
    try {
        db = SessionManager_1.SessionManager.openDatabase(sessionDir);
        PipelineRepository_1.PipelineRepository.initSchema(db);
        const repo = new PipelineRepository_1.PipelineRepository(db);
        const pipelineEngine = new PipelineEngine_1.PipelineEngine(repo);
        // Find scope: prefer pending marker (accurate for parallel agents), fall back to DB
        let scope = null;
        const pendingMarker = path_1.default.join(sessionDir, `.pending-scope-${bareAgentType}`);
        try {
            if (fs_1.default.existsSync(pendingMarker)) {
                scope = fs_1.default.readFileSync(pendingMarker, "utf-8").trim();
                fs_1.default.unlinkSync(pendingMarker);
            }
        }
        catch {
        }
        if (!scope) {
            scope = repo.findAgentScope(bareAgentType);
        }
        if (scope) {
            // Pipeline creation is deferred to SubagentStop (enables parallel source agents).
            // SubagentStart only enriches context for verifiers/fixers whose pipelines already exist.
            // Role-based context enrichment
            const role = pipelineEngine.resolveRole(scope, bareAgentType);
            if (role === Enums_1.AgentRole.Verifier) {
                // Gate agent: inject source artifact path + round info
                const activeStep = repo.getActiveStep(scope);
                if (activeStep) {
                    const state = repo.getPipelineState(scope);
                    const sourceAgent = state ? state.source_agent : "unknown";
                    // After fixer runs, reviewer reads fixer's output (latest version)
                    let sourceArtifact = `${sessionDir}/${scope}/${sourceAgent}.md`;
                    if (activeStep.fixer && activeStep.round > 0) {
                        const fixerArtifact = `${sessionDir}/${scope}/${activeStep.fixer}.md`;
                        if (fs_1.default.existsSync(fixerArtifact)) {
                            sourceArtifact = fixerArtifact;
                        }
                    }
                    pipelineContext = `role=gate\n`
                        + `session_id=${sessionId}\n`
                        + `scope=${scope}\n`
                        + `source_agent=${sourceAgent}\n`
                        + `source_artifact=${sourceArtifact}\n`
                        + `gate_round=${activeStep.round + 1}/${activeStep.max_rounds}\n`;
                }
            }
            else if (role === Enums_1.AgentRole.Fixer) {
                // Fixer: inject source artifact + gate agent info
                const fixStep = repo.getStepByStatus(scope, Enums_1.StepStatus.Fix);
                if (fixStep) {
                    const state = repo.getPipelineState(scope);
                    const sourceAgent = state ? state.source_agent : "unknown";
                    const sourceArtifact = `${sessionDir}/${scope}/${sourceAgent}.md`;
                    pipelineContext = `role=fixer\n`
                        + `session_id=${sessionId}\n`
                        + `scope=${scope}\n`
                        + `source_agent=${sourceAgent}\n`
                        + `source_artifact=${sourceArtifact}\n`
                        + `gate_agent=${fixStep.agent}\n`
                        + `gate_round=${fixStep.round + 1}/${fixStep.max_rounds}\n`;
                }
            }
            // Verification file exists → inject it (file existence IS the signal)
            try {
                const verificationFile = path_1.default.join(sessionDir, scope, `${bareAgentType}-verification.md`);
                if (fs_1.default.existsSync(verificationFile)) {
                    const findings = fs_1.default.readFileSync(verificationFile, "utf-8");
                    pipelineContext += `artifact=${sessionDir}/${scope}/${bareAgentType}.md\n`
                        + `\nReviewer findings (address ALL issues before resubmitting):\n${findings}\n`;
                }
            }
            catch {
            }
            // source (first run) / ungated → no context injection (semantics first)
        }
    }
    finally {
        db?.close();
    }
    // Only inject if there's role context to provide (verifier/fixer)
    if (!pipelineContext) {
        process.exit(0);
    }
    const context = `<agent_gate importance="critical">\n`
        + pipelineContext
        + `</agent_gate>`;
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "SubagentStart",
            additionalContext: context,
        },
    }));
    process.exit(0);
}
// ── Entry point (thin wrapper) ──────────────────────────────────────
try {
    onSubagentStart(JSON.parse(fs_1.default.readFileSync(0, "utf-8")));
}
catch {
    process.exit(0);
}
//# sourceMappingURL=PipelineInjection.js.map