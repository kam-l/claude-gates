"use strict";
/**
 * MCP server for claude-gates — structured tool calls for gate verdicts.
 *
 * Tools:
 *   gate_verdict — submit PASS/REVISE/FAIL verdict for a pipeline or plan-gate scope
 *   gate_status  — read-only pipeline state query
 *
 * Transport: stdio. Entry point: node scripts/mcp-server.js
 */
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const fs_1 = require("fs");
const path_1 = require("path");
const zod_1 = require("zod");
const GateRepository_1 = require("./GateRepository");
const PipelineRepository_1 = require("./PipelineRepository");
const SessionManager_1 = require("./SessionManager");
const pkg = JSON.parse((0, fs_1.readFileSync)((0, path_1.join)(__dirname, "..", "package.json"), "utf8"));
const server = new mcp_js_1.McpServer({
    name: "claude-gates",
    version: pkg.version,
});
// ── gate_verdict ────────────────────────────────────────────────────
server.tool("gate_verdict", {
    session_id: zod_1.z.string().describe("Session UUID"),
    scope: zod_1.z.string().describe("Pipeline scope or 'verify-plan' for plan-gate"),
    verdict: zod_1.z.enum(["PASS", "REVISE", "FAIL",]).describe("Verdict: PASS, REVISE, or FAIL"),
    reason: zod_1.z.string().describe("Human-readable reason for the verdict"),
}, async ({ session_id, scope, verdict, reason, }) => {
    try {
        const sessionDir = SessionManager_1.SessionManager.getSessionDir(session_id);
        // Plan-gate scope — writes to agents table where plan-gate.ts reads gater verdicts
        if (scope === "verify-plan") {
            const db = GateRepository_1.GateRepository.createDb(sessionDir);
            try {
                const gateRepo = new GateRepository_1.GateRepository(db);
                gateRepo.setVerdict("gater-review", "gater", verdict, 0);
                return {
                    content: [{ type: "text", text: `Plan-gate verdict recorded: ${verdict}. Reason: ${reason}`, },],
                };
            }
            finally {
                db.close();
            }
        }
        // Pipeline scope — record verdict only (hook process drives engine.step)
        const db = SessionManager_1.SessionManager.openDatabase(sessionDir);
        PipelineRepository_1.PipelineRepository.initSchema(db);
        try {
            const repo = new PipelineRepository_1.PipelineRepository(db);
            const activeStep = repo.getActiveStep(scope);
            if (!activeStep) {
                return {
                    content: [{ type: "text", text: `Error: no active step found for scope="${scope}". Is the pipeline running?`, },],
                    isError: true,
                };
            }
            const agent = activeStep.agent || activeStep.source_agent;
            repo.setVerdict(scope, agent, verdict, activeStep.round);
            return {
                content: [{
                        type: "text",
                        text: `Verdict ${verdict} recorded for scope="${scope}" step ${activeStep.step_index} (${activeStep.step_type}). Reason: ${reason}`,
                    },],
            };
        }
        finally {
            db.close();
        }
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[ClaudeGates MCP] gate_verdict error: ${errMsg}\n`);
        return {
            content: [{ type: "text", text: `Error: ${errMsg}`, },],
            isError: true,
        };
    }
});
// ── gate_status ─────────────────────────────────────────────────────
server.tool("gate_status", {
    session_id: zod_1.z.string().describe("Session UUID"),
    scope: zod_1.z.string().optional().describe("Pipeline scope (omit for all active pipelines)"),
}, async ({ session_id, scope, }) => {
    try {
        const sessionDir = SessionManager_1.SessionManager.getSessionDir(session_id);
        const db = SessionManager_1.SessionManager.openDatabase(sessionDir);
        PipelineRepository_1.PipelineRepository.initSchema(db);
        try {
            const repo = new PipelineRepository_1.PipelineRepository(db);
            if (scope) {
                const state = repo.getPipelineState(scope);
                if (!state) {
                    return {
                        content: [{ type: "text", text: `No pipeline found for scope="${scope}".`, },],
                        isError: true,
                    };
                }
                const steps = repo.getSteps(scope);
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({ state, steps, }, null, 2),
                        },],
                };
            }
            // All active pipelines
            const pipelines = repo.getActivePipelines();
            if (pipelines.length === 0) {
                return {
                    content: [{ type: "text", text: "No active pipelines.", },],
                };
            }
            const result = pipelines.map((p) => ({
                scope: p.scope,
                status: p.status,
                current_step: p.current_step,
                total_steps: p.total_steps,
            }));
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify(result, null, 2),
                    },],
            };
        }
        finally {
            db.close();
        }
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[ClaudeGates MCP] gate_status error: ${errMsg}\n`);
        return {
            content: [{ type: "text", text: `Error: ${errMsg}`, },],
            isError: true,
        };
    }
});
// ── Start server ────────────────────────────────────────────────────
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    process.stderr.write(`[ClaudeGates MCP] Fatal: ${err}\n`);
    process.exit(1);
});
//# sourceMappingURL=McpServer.js.map